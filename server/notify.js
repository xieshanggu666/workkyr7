import { db } from './db.js'
import { now, addTimeline, LV_TEXT } from './pipeline.js'
import { mirrorNotifyToWorkOrder, addDispatchTimeline, recomputeWorkOrderState } from './dispatch.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// ===== 权限模型（演示）：身份经请求头 x-user / x-role 携带，服务端强制校验 =====
// admin=管理员（配置+任务操作） ops=值班员（任务操作） viewer=观察员（只读）
export const ROLE_TEXT = { admin: '管理员', ops: '值班员', viewer: '观察员' }
const ROLE_RANK = { admin: 3, ops: 2, viewer: 1 }
export function actorOf(req) {
  // x-user 经 encodeURIComponent 编码（HTTP 头不能直接携带非 Latin-1 字符）
  let user = String(req.headers['x-user'] || '').trim()
  try { user = decodeURIComponent(user) } catch { /* 未编码原文直接使用 */ }
  const role = ROLE_RANK[req.headers['x-role']] ? req.headers['x-role'] : 'viewer'
  return { user: user || '匿名用户', role }
}
export function permit(req, need) { // need: 'admin' | 'ops' | 'viewer'
  const a = actorOf(req)
  return ROLE_RANK[a.role] >= ROLE_RANK[need] ? a : null
}

// ===== 调度参数（演示用小时间窗，便于观察自动重试与超时升级） =====
export const TICK_MS = 3000          // 调度扫描间隔
export const RETRY_BASE_MS = 15000   // 失败重试退避基数（第 n 次等待 n × 基数）
const DUE_BATCH = 20                 // 每轮扫描处理上限

export const CHANNEL_TYPES = { webhook: 'Webhook', email: '邮件', sms: '短信', inapp: '站内信' }
export const TASK_STATUS = {
  pending: '待发送', sent: '已发送', failed: '发送失败',
  acked: '已回执', escalated: '已升级', paused: '已暂停', cancelled: '已取消'
}
export const CRISIS_STATUS_TEXT = { monitoring: '监测中', disposal: '处置中', closed: '已结案' }

function safeParse(s, dft) { try { const v = JSON.parse(s || ''); return v ?? dft } catch { return dft } }
const subChannels = (s) => safeParse(s.channel_ids, []) || []
const subLevels = (s) => String(s.levels || '').split(',').map((x) => x.trim()).filter(Boolean)

// 历史追踪：任务全生命周期留痕（操作人缺省为系统/调度器）
// 同时按动作镜像到关联工单日志，使分派→发送→重试→回执/升级在工单链路中可追踪
function addLog(taskId, action, detail, operator = '系统') {
  run('INSERT INTO notify_logs (task_id,action,detail,operator,time) VALUES (?,?,?,?,?)',
    taskId, action, detail || '', operator, now())
  const t = q1('SELECT id, work_order_id, title FROM notify_tasks WHERE id=?', taskId)
  if (t) {
    mirrorNotifyToWorkOrder(t, action, detail, operator)
    if (t.work_order_id) recomputeWorkOrderState(t.work_order_id)
  }
}

// ===== 任务生成（订阅匹配 → 多渠道并行任务；幂等键去重，重复触发不产生重复任务） =====
// opts.kind: alert（预警）/ crisis（危机状态）/ workorder（协同工单事件）/ prop（传播路径事件）
function createTasks(sub, { kind, alertEventId = null, crisisId = null, statusKey = '', woId = null, woEvent = '', propPathId = null, idemTag = '', corrId = '', corrSeq = 0, title, content }) {
  const created = []
  const ts = now()
  for (const chId of subChannels(sub)) {
    const ch = q1('SELECT * FROM notify_channels WHERE id=?', chId)
    if (!ch || !ch.enabled) continue // 停用/已删除渠道跳过
    const src = kind === 'alert' ? `alert:${alertEventId}`
      : kind === 'workorder' ? `wo:${woId}:${idemTag || woEvent}`
      : kind === 'prop' ? `prop:${propPathId}:${idemTag}`
      : `crisis:${crisisId}:${statusKey}`
    const r = run(`INSERT OR IGNORE INTO notify_tasks
      (idem_key,sub_id,channel_id,alert_event_id,crisis_id,kind,title,content,status,attempts,max_attempts,require_ack,work_order_id,wo_event,prop_path_id,corr_id,seq,created,updated)
      VALUES (?,?,?,?,?,?,?,?,'pending',0,?,?,?,?,?,?,?,?,?)`,
      `${src}:sub${sub.id}:ch${chId}`, sub.id, chId, alertEventId, crisisId,
      kind === 'workorder' ? 'workorder' : kind, title, content,
      Math.max(1, sub.max_retry || 3), sub.require_ack ? 1 : 0, woId,
      woEvent === '' || woEvent == null ? '' : String(woEvent), propPathId,
      corrId || '', corrSeq, ts, ts)
    if (Number(r.changes)) {
      const id = Number(r.lastInsertRowid)
      addLog(id, 'created', `订阅「${sub.name}」匹配，生成通知任务（渠道：${ch.name}）`)
      created.push(id)
    }
  }
  return created
}

// 预警触发 → 通知任务（按规则/话题/级别过滤；危机订阅不响应预警触发）
export function generateForAlertEvent(eventId) {
  const ev = q1(`SELECT ae.*, al.title alert_title, al.level, p.title ptitle, p.topic ptopic
    FROM alert_events ae LEFT JOIN alerts al ON al.id=ae.alert_id LEFT JOIN posts p ON p.id=ae.post_id
    WHERE ae.id=?`, eventId)
  if (!ev) return []
  const title = `【预警通知】${ev.alert_title || '已删除规则'}`
  const content = `${ev.detail} · 关联舆情《${ev.ptitle || '—'}》`
  const all = []
  for (const s of q('SELECT * FROM notify_subs WHERE active=1')) {
    if (s.crisis_status) continue
    if (s.alert_id && s.alert_id !== ev.alert_id) continue
    if (s.topic && s.topic !== (ev.ptopic || '')) continue
    const lv = subLevels(s)
    if (lv.length && !lv.includes(ev.level)) continue
    all.push(...createTasks(s, { kind: 'alert', alertEventId: ev.id, crisisId: ev.crisis_id, title, content }))
  }
  return all
}

// 危机状态流转 → 通知任务（订阅 crisis_status 匹配新状态，话题可再限定；同一状态只通知一次）
export function generateForCrisisStatus(crisisId, status) {
  const c = q1('SELECT * FROM crisis WHERE id=?', crisisId)
  if (!c) return []
  const title = `【危机${CRISIS_STATUS_TEXT[status] || status}】${c.title}`
  const content = `事件 #${c.id} 进入「${CRISIS_STATUS_TEXT[status] || status}」状态 · 话题「${c.topic || '—'}」 · 级别 ${LV_TEXT[c.level] || c.level}`
  const all = []
  for (const s of q('SELECT * FROM notify_subs WHERE active=1 AND crisis_status=?', status)) {
    if (s.topic && s.topic !== c.topic) continue
    all.push(...createTasks(s, { kind: 'crisis', crisisId, statusKey: status, title, content }))
  }
  return all
}

// 启动时为存量未解除预警触发补生成通知任务（幂等：重复启动/重复调用不产生重复任务）
export function seedNotifyTasks() {
  let n = 0
  for (const ev of q("SELECT id FROM alert_events WHERE status='open'")) n += generateForAlertEvent(ev.id).length
  return n
}

// ===== 协同工单事件 → 通知任务（wo_event='created'：拆分分派/认领/改派；'escalated'：超时升级） =====
// 复用通知渠道、失败退避重试、回执与升级调度；幂等键按 工单×事件×订阅×渠道 去重。
export function generateForWorkOrder(woId, woEvent, opts = {}) {
  const w = q1(`SELECT w.*, c.title crisis_title FROM work_orders w LEFT JOIN crisis c ON c.id=w.crisis_id WHERE w.id=?`, woId)
  if (!w) return []
  const all = []
  // 订阅按事件名匹配（created/escalated），升级级别仅体现在文案与幂等标签
  const subEvent = woEvent === 'created' ? 'created' : 'escalated'
  const subs = q(`SELECT * FROM notify_subs WHERE active=1 AND wo_event=?`, subEvent)
  if (!subs.length) return []
  let title, content, idemTag, corrId, corrSeq = 0
  const ev = opts.event || ''
  if (subEvent === 'created') {
    const isReassign = ev === 'reassign'
    const isAssign = ev === 'assign'
    const isClaim = ev === 'claim'
    const kindText = isReassign ? '工单改派' : isClaim ? '工单认领' : isAssign ? '工单分派' : '协同工单'
    title = `【${kindText}】${w.title}`
    const verb = isReassign ? '工单改派' : isClaim ? '工单已认领' : isAssign ? '工单分派' : '拆分工单'
    content = `危机「${w.crisis_title || '#' + w.crisis_id}」${verb} #${w.id} · ${w.assignee ? '处理人：' + w.assignee : '待分派，可认领'} · SLA ${w.due_at ? new Date(w.due_at).toLocaleString('zh-CN') : '无时限'}`
    // 分派/改派/认领按「调度轮次 + 处理人」幂等：同一轮重复触发不重发，新一轮流转可再次触达
    corrSeq = Math.max(0, +opts.seq || 0)
    idemTag = isReassign ? `reassign:${corrSeq}:${opts.to || w.assignee || ''}`
      : isClaim ? `claim:${corrSeq}:${opts.to || w.assignee || ''}`
      : isAssign ? `assign:${corrSeq}:${opts.to || w.assignee || ''}`
      : 'created'
    // 分派/改派/认领共享同一关联根 + 轮次序号，通知看板可按链路聚合多次分派
    corrId = `wo${woId}:dispatch`
  } else {
    // escalated（woEvent=1/2 为升级级别）
    const level = Number(woEvent) || 1
    title = `【工单${level === 2 ? '二级升级督办' : '超时升级'}】${w.title}`
    content = `协同工单 #${w.id} SLA 已到期${level === 2 ? '（一级升级后仍未完成，升级督办至管理员）' : ''} · 处理人：${w.assignee || '待分派'} · 危机「${w.crisis_title || '#' + w.crisis_id}」`
    idemTag = `escalate:${level}`
    corrId = `wo${woId}:escalate`
    corrSeq = level
  }
  for (const s of subs) {
    all.push(...createTasks(s, { kind: 'workorder', woId, woEvent, idemTag, corrId, corrSeq, crisisId: w.crisis_id, title, content }))
  }
  return all
}

// 工单超时升级通知：升级类任务写危机时间线（与回执超时升级一致），由工单调度器驱动
export function notifyWorkOrderEscalation(woId, level) {
  return generateForWorkOrder(woId, level)
}

// ===== 传播路径事件 → 通知任务（prop_event：outbreak 爆发升级 / surge 热度激增 / kol KOL 加入） =====
// 复用通知渠道、失败退避重试、回执与升级调度；幂等键按 路径×事件×订阅×渠道 去重。
const PROP_EVENT_TEXT = { outbreak: '进入爆发期', surge: '热度激增', kol: 'KOL 加入转发' }
export function generateForPropEvent(pathId, propEvent, extra = {}) {
  const p = q1('SELECT * FROM prop_paths WHERE id=?', pathId)
  if (!p || p.status !== 'active') return []
  const all = []
  const subs = q(`SELECT * FROM notify_subs WHERE active=1 AND prop_event=?`, propEvent)
  if (!subs.length) return []
  const titlePrefix = propEvent === 'outbreak' ? '【传播爆发升级】' : '【传播异动】'
  const title = `${titlePrefix}${p.title}`
  const bits = [`话题「${p.topic || '—'}」`, `事件：${PROP_EVENT_TEXT[propEvent] || propEvent}`]
  if (extra.heat) bits.push(`当前热度 ${extra.heat}`)
  if (extra.reach) bits.push(`本跳触达 ${extra.reach}`)
  if (extra.node && extra.node.name) bits.push(`节点「${extra.node.name}」`)
  const content = bits.join(' · ')
  for (const s of subs) {
    if (s.topic && s.topic !== p.topic) continue
    all.push(...createTasks(s, { kind: 'prop', propPathId: pathId, crisisId: p.crisis_id, idemTag: propEvent, title, content }))
  }
  return all
}

// 启动时为存量爆发期路径补生成通知任务（幂等：重复启动不产生重复任务）
export function seedPropNotifyTasks() {
  let n = 0
  for (const p of q("SELECT id FROM prop_paths WHERE status='active' AND stage='outbreak'")) {
    n += generateForPropEvent(p.id, 'outbreak').length
  }
  return n
}

// ===== 模拟发送（演示）：渠道地址含 always-fail 持续失败、含 flaky 首次失败（验证自动重试） =====
function mockSend(ch, attempts) {
  const target = ch.target || ''
  if (target.includes('always-fail')) throw new Error(`渠道「${ch.name}」持续不可用（模拟故障）`)
  if (target.includes('flaky') && attempts === 0) throw new Error(`渠道「${ch.name}」瞬时故障（模拟，重试可恢复）`)
}

// 发送一次：成功置 sent（需回执的启动超时升级倒计时）；失败按退避重试，达上限置 failed
function attemptSend(t) {
  const ch = q1('SELECT * FROM notify_channels WHERE id=?', t.channel_id)
  const ts = now()
  const attempt = t.attempts + 1
  try {
    if (!ch) throw new Error('通知渠道不存在（可能已删除）')
    if (!ch.enabled) throw new Error(`渠道「${ch.name}」已停用`)
    mockSend(ch, t.attempts)
    const sub = t.sub_id ? q1('SELECT ack_timeout_min FROM notify_subs WHERE id=?', t.sub_id) : null
    const timeoutMin = Math.max(1, (sub && sub.ack_timeout_min) || 30)
    const escAt = t.require_ack ? Date.now() + timeoutMin * 60000 : null
    // 状态守卫：仅 pending 可发送（暂停/取消竞态下不发出）
    const r = run(`UPDATE notify_tasks SET status='sent', attempts=attempts+1, sent_at=?, last_error='',
      next_retry_at=NULL, escalate_at=?, updated=? WHERE id=? AND status='pending'`, ts, escAt, ts, t.id)
    if (Number(r.changes)) {
      addLog(t.id, 'sent', `经渠道「${ch.name}」发送成功（第 ${attempt} 次尝试）` +
        (t.require_ack ? `，等待回执（${timeoutMin} 分钟未确认将自动升级）` : ''))
    }
  } catch (e) {
    const msg = String(e.message || e)
    const giveUp = attempt >= t.max_attempts
    const r = run(`UPDATE notify_tasks SET status=?, attempts=attempts+1, last_error=?, next_retry_at=?, updated=?
      WHERE id=? AND status='pending'`,
      giveUp ? 'failed' : 'pending', msg, giveUp ? null : Date.now() + RETRY_BASE_MS * attempt, ts, t.id)
    if (Number(r.changes)) {
      addLog(t.id, giveUp ? 'failed' : 'retry', giveUp
        ? `第 ${attempt} 次发送失败，已达重试上限（${t.max_attempts} 次）：${msg}，可手动重试`
        : `第 ${attempt} 次发送失败：${msg}，${(RETRY_BASE_MS * attempt) / 1000} 秒后自动重试`)
    }
  }
}

// 回执超时升级：原任务标记已升级，向升级渠道生成【升级】任务（升级任务不再二次升级），并写危机时间线
function escalateTask(t) {
  const ts = now()
  db.exec('BEGIN')
  try {
    const r = run(`UPDATE notify_tasks SET escalated=1, status='escalated', updated=? WHERE id=? AND escalated=0 AND status='sent'`, ts, t.id)
    if (!Number(r.changes)) { db.exec('ROLLBACK'); return }
    const sub = t.sub_id ? q1('SELECT * FROM notify_subs WHERE id=?', t.sub_id) : null
    const chId = (sub && sub.escalate_channel_id) || t.channel_id
    const ch = q1('SELECT * FROM notify_channels WHERE id=?', chId)
    addLog(t.id, 'escalated', `回执超时未确认，通知升级至渠道「${ch ? ch.name : '已删除'}」`)
    // 升级子任务继承来源链路：corr_id 与来源任务同根（无来源关联键时按任务 id 补），
    // work_order_id 一并继承——工单通知的回执升级同样回到工单调度链路上可追踪
    const childCorr = t.corr_id
      ? (/:(escalate|ackEsc)/.test(t.corr_id) ? t.corr_id : `${t.corr_id}:ackEsc`)
      : (t.work_order_id ? `wo${t.work_order_id}:ackEsc:${t.id}` : `task${t.id}:ackEsc`)
    const cr = run(`INSERT OR IGNORE INTO notify_tasks
      (idem_key,sub_id,channel_id,alert_event_id,crisis_id,kind,title,content,status,attempts,max_attempts,next_retry_at,require_ack,escalated_from,work_order_id,wo_event,corr_id,seq,created,updated)
      VALUES (?,?,?,?,?,?,?,?,'pending',0,?,NULL,?,?,?,?,?,?,?,?)`,
      `esc:${t.id}:ch${chId}`, t.sub_id, chId, t.alert_event_id, t.crisis_id, t.kind,
      `【升级】${t.title}`, t.content, Math.max(1, t.max_attempts), t.require_ack, t.id,
      t.work_order_id, t.wo_event, childCorr, (t.seq || 0) + 1, ts, ts)
    if (Number(cr.changes)) {
      const childId = Number(cr.lastInsertRowid)
      addLog(childId, 'created', `任务 #${t.id} 回执超时升级生成`)
    }
    if (t.crisis_id) {
      const c = q1('SELECT status FROM crisis WHERE id=?', t.crisis_id)
      if (c && c.status !== 'closed') {
        addDispatchTimeline(t.crisis_id, '通知升级',
          `通知「${t.title}」回执超时未确认，已升级至渠道「${ch ? ch.name : '—'}」`,
          { woId: t.work_order_id, refType: t.work_order_id ? 'workorder' : 'notify', refId: t.work_order_id || t.id, time: ts })
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
}

// 调度一轮：到期发送/重试 + 回执超时升级（导出供测试与手动触发）
export function runNotifyTick() {
  const nowMs = Date.now()
  const due = q(`SELECT * FROM notify_tasks WHERE status='pending' AND (next_retry_at IS NULL OR next_retry_at<=?)
    ORDER BY id LIMIT ?`, nowMs, DUE_BATCH)
  for (const t of due) attemptSend(t)
  const esc = q(`SELECT * FROM notify_tasks WHERE require_ack=1 AND escalated=0 AND escalated_from IS NULL
    AND status='sent' AND escalate_at IS NOT NULL AND escalate_at<=? LIMIT ?`, nowMs, DUE_BATCH)
  for (const t of esc) escalateTask(t)
}

let timer = null
export function startScheduler() {
  if (timer) return
  timer = setInterval(() => {
    try { runNotifyTick() } catch (e) { console.error('[NOTIFY] 调度异常：', e.message) }
  }, TICK_MS)
  if (timer.unref) timer.unref()
  console.log(`[NOTIFY] 通知调度器已启动（每 ${TICK_MS / 1000} 秒扫描：发送 / 失败重试 / 回执超时升级）`)
}
export function stopScheduler() { if (timer) clearInterval(timer); timer = null }

// ===== 任务操作（可暂停/恢复/手动重试/取消/确认回执；均带状态守卫，并发幂等） =====
export function getTask(id) {
  const t = q1(`SELECT nt.*, nc.name channel_name, nc.type channel_type, ns.name sub_name
    FROM notify_tasks nt LEFT JOIN notify_channels nc ON nc.id=nt.channel_id
    LEFT JOIN notify_subs ns ON ns.id=nt.sub_id WHERE nt.id=?`, id)
  return t ? { ...t, statusText: TASK_STATUS[t.status] || t.status } : null
}

export function listTasks({ status = '', limit = 100 } = {}) {
  let sql = `SELECT nt.*, nc.name channel_name, nc.type channel_type, ns.name sub_name
    FROM notify_tasks nt LEFT JOIN notify_channels nc ON nc.id=nt.channel_id
    LEFT JOIN notify_subs ns ON ns.id=nt.sub_id`
  const args = []
  if (status) { sql += ' WHERE nt.status=?'; args.push(status) }
  sql += ' ORDER BY nt.id DESC LIMIT ?'
  args.push(limit)
  const tasks = q(sql, ...args).map((t) => ({ ...t, statusText: TASK_STATUS[t.status] || t.status }))
  const counts = {}
  for (const r of q('SELECT status, COUNT(*) c FROM notify_tasks GROUP BY status')) counts[r.status] = r.c
  return { tasks, counts }
}

export function pauseTask(id, actor) {
  const t = q1('SELECT * FROM notify_tasks WHERE id=?', id)
  if (!t) return null
  if (!['pending', 'failed'].includes(t.status)) return { error: `当前状态（${TASK_STATUS[t.status] || t.status}）不可暂停`, task: getTask(id) }
  const r = run(`UPDATE notify_tasks SET status='paused', pause_prev=?, updated=? WHERE id=? AND status IN ('pending','failed')`,
    t.status, now(), id)
  if (Number(r.changes)) addLog(id, 'paused', `任务暂停（暂停前：${TASK_STATUS[t.status]}）`, actor.user)
  return { ok: true, task: getTask(id) }
}

export function resumeTask(id, actor) {
  const t = q1('SELECT * FROM notify_tasks WHERE id=?', id)
  if (!t) return null
  if (t.status !== 'paused') return { error: '任务未处于暂停状态', task: getTask(id) }
  const r = run(`UPDATE notify_tasks SET status='pending', next_retry_at=NULL, pause_prev='', updated=? WHERE id=? AND status='paused'`, now(), id)
  if (Number(r.changes)) addLog(id, 'resumed', '任务恢复，重新进入发送队列', actor.user)
  return { ok: true, task: getTask(id) }
}

export function retryTask(id, actor) {
  const t = q1('SELECT * FROM notify_tasks WHERE id=?', id)
  if (!t) return null
  if (t.status !== 'failed') return { error: '仅发送失败的任务可手动重试', task: getTask(id) }
  const r = run(`UPDATE notify_tasks SET status='pending', attempts=0, next_retry_at=NULL, last_error='', updated=? WHERE id=? AND status='failed'`, now(), id)
  if (Number(r.changes)) addLog(id, 'retry', '手动重试：重置发送计数，重新进入发送队列', actor.user)
  return { ok: true, task: getTask(id) }
}

export function cancelTask(id, actor) {
  const t = q1('SELECT * FROM notify_tasks WHERE id=?', id)
  if (!t) return null
  if (!['pending', 'failed', 'paused'].includes(t.status)) return { error: `当前状态（${TASK_STATUS[t.status] || t.status}）不可取消`, task: getTask(id) }
  const r = run(`UPDATE notify_tasks SET status='cancelled', updated=? WHERE id=? AND status IN ('pending','failed','paused')`, now(), id)
  if (Number(r.changes)) addLog(id, 'cancelled', '任务已取消', actor.user)
  return { ok: true, task: getTask(id) }
}

// 确认回执：幂等；同步解除关联预警（resolve_kind=notify）并写入危机时间线，完成「通知→处置」闭环
export function ackTask(id, actor, note = '') {
  const t = q1('SELECT * FROM notify_tasks WHERE id=?', id)
  if (!t) return null
  if (t.status === 'acked') return { already: true, task: getTask(id) }
  if (!t.require_ack) return { error: '该任务无需确认回执', task: getTask(id) }
  if (!['sent', 'escalated'].includes(t.status)) {
    return { error: `当前状态（${TASK_STATUS[t.status] || t.status}）不能确认回执`, task: getTask(id) }
  }
  const ts = now()
  let resolved = 0
  let crisisId = t.crisis_id
  db.exec('BEGIN')
  try {
    const r = run(`UPDATE notify_tasks SET status='acked', ack_by=?, ack_at=?, ack_note=?, updated=?
      WHERE id=? AND status IN ('sent','escalated')`, actor.user, ts, note, ts, id)
    if (!Number(r.changes)) { db.exec('ROLLBACK'); return { already: true, task: getTask(id) } }
    addLog(id, 'acked', note ? `确认回执：${note}` : '确认回执', actor.user)
    // 回执同步①：关联预警触发记录解除（状态守卫，重复回执/并发不重复解除）
    if (t.alert_event_id) {
      const rr = run(`UPDATE alert_events SET status='resolved', resolved=?, resolve_kind='notify' WHERE id=? AND status='open'`, ts, t.alert_event_id)
      resolved = Number(rr.changes || 0)
      if (!crisisId) {
        const ev = q1('SELECT crisis_id FROM alert_events WHERE id=?', t.alert_event_id)
        crisisId = ev ? ev.crisis_id : null
      }
    }
    // 回执同步②：危机时间线（已结案事件不再回写，保持结案档案稳定）；带工单锚点便于看板跳转
    if (crisisId) {
      const c = q1('SELECT status FROM crisis WHERE id=?', crisisId)
      if (c && c.status !== 'closed') {
        addDispatchTimeline(crisisId, '通知回执',
          `通知「${t.title}」已由 ${actor.user} 确认回执${note ? `：${note}` : ''}${resolved ? '，同步解除关联预警' : ''}`,
          { woId: t.work_order_id, refType: t.work_order_id ? 'workorder' : 'notify', refId: t.work_order_id || t.id, time: ts })
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  return { ok: true, resolved, crisisId, task: getTask(id) }
}

// ===== 配置（渠道 + 订阅） =====
export function listConfig() {
  const channels = q('SELECT * FROM notify_channels ORDER BY id')
  const subs = q('SELECT * FROM notify_subs ORDER BY id DESC').map((s) => ({
    ...s,
    channel_list: subChannels(s).map((id) => q1('SELECT id,name,type,enabled FROM notify_channels WHERE id=?', id)).filter(Boolean),
    level_list: subLevels(s)
  }))
  return { channels, subs }
}

export function validateChannel(b) {
  if (!b || typeof b.name !== 'string' || !b.name.trim()) return '渠道名称必填'
  if (!CHANNEL_TYPES[b.type]) return '渠道类型无效'
  if (typeof b.target !== 'string' || !b.target.trim()) return '推送地址必填'
  return null
}

export function validateSub(b) {
  if (!b || typeof b.name !== 'string' || !b.name.trim()) return '订阅名称必填'
  const cs = String(b.crisis_status || '')
  if (cs && !CRISIS_STATUS_TEXT[cs]) return '危机状态无效'
  const we = String(b.wo_event || '')
  if (we && !['created', 'escalated'].includes(we)) return '工单事件无效（created/escalated）'
  const pe = String(b.prop_event || '')
  if (pe && !['outbreak', 'surge'].includes(pe)) return '传播事件无效（outbreak/surge）'
  if ((we && cs) || (we && pe) || (cs && pe)) return '预警/危机/工单/传播事件订阅互斥，请只选一种匹配方式'
  const chs = Array.isArray(b.channel_ids) ? b.channel_ids.map(Number).filter(Number.isInteger) : []
  if (!chs.length) return '至少选择一个通知渠道'
  for (const id of chs) if (!q1('SELECT 1 FROM notify_channels WHERE id=?', id)) return `渠道 #${id} 不存在`
  if (b.alert_id && !q1('SELECT 1 FROM alerts WHERE id=?', +b.alert_id)) return '指定的预警规则不存在'
  if (b.require_ack && !(+b.ack_timeout_min >= 1)) return '回执超时至少 1 分钟'
  if (b.escalate_channel_id && !q1('SELECT 1 FROM notify_channels WHERE id=?', +b.escalate_channel_id)) return '升级渠道不存在'
  return null
}

export function listLogs({ taskId = null, limit = 100 } = {}) {
  if (taskId) return q('SELECT * FROM notify_logs WHERE task_id=? ORDER BY id DESC LIMIT ?', taskId, limit)
  return q(`SELECT nl.*, nt.title task_title FROM notify_logs nl
    LEFT JOIN notify_tasks nt ON nt.id=nl.task_id ORDER BY nl.id DESC LIMIT ?`, limit)
}
