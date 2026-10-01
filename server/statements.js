import { db } from './db.js'
import { now, addTimeline } from './pipeline.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// ===== 常量与口径 =====
export const STMT_STATUS = {
  draft: '起草中', review: '待法务审核', approved: '审核通过',
  publishing: '发布中', published: '已发布', cancelled: '已取消'
}
export const STMT_PRIORITY = { urgent: '紧急', high: '高', normal: '普通' }
// 拟发布渠道（分渠道执行登记）：与舆情渠道语义对应
export const STMT_CHANNELS = {
  weibo: '官方微博', wechat: '微信公众号', website: '官网新闻中心',
  news: '新闻通稿（媒体邮箱组）', video: '官方短视频账号', press: '新闻发布会'
}
export const CH_STATUS = { pending: '待执行', publishing: '执行中', success: '已发布', failed: '失败', cancelled: '已取消' }

function addLog(stmtId, action, detail, operator = '系统') {
  run('INSERT INTO crisis_statement_logs (statement_id,action,detail,operator,time) VALUES (?,?,?,?,?)',
    stmtId, action, detail || '', operator || '系统', now())
}

function safeParse(s, dft) { try { return JSON.parse(s || '') ?? dft } catch { return dft } }

// ===== 查询 =====
function decorate(s) {
  const channels = safeParse(s.channels, [])
  const rows = q('SELECT * FROM crisis_statement_channels WHERE statement_id=? ORDER BY id ASC', s.id)
  const counts = { pending: 0, publishing: 0, success: 0, failed: 0, cancelled: 0, total: rows.length }
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1
  const open = counts.pending + counts.publishing
  // 完成度口径：成功 / 已执行（成功+失败+取消，不含待执行/执行中）
  const finished = counts.success + counts.failed + counts.cancelled
  return {
    ...s,
    channels,
    statusText: STMT_STATUS[s.status] || s.status,
    priorityText: STMT_PRIORITY[s.priority] || s.priority,
    channelRows: rows.map((r) => ({ ...r, channelText: STMT_CHANNELS[r.channel] || r.channel_name || r.channel, statusText: CH_STATUS[r.status] || r.status })),
    channelCounts: counts,
    channelOpen: open,
    progress: { done: finished, ok: counts.success, fail: counts.failed, pct: rows.length ? Math.round((finished / rows.length) * 100) : 0 }
  }
}

export function listStatements({ status = '', crisisId = null, limit = 200 } = {}) {
  let sql = `SELECT s.*, c.title crisis_title, c.status crisis_status, c.level crisis_level,
      wo.title wo_title
    FROM crisis_statements s LEFT JOIN crisis c ON c.id=s.crisis_id
    LEFT JOIN work_orders wo ON wo.id=s.work_order_id WHERE 1=1`
  const args = []
  if (status) { sql += ' AND s.status=?'; args.push(status) }
  if (crisisId) { sql += ' AND s.crisis_id=?'; args.push(crisisId) }
  sql += ' ORDER BY s.id DESC LIMIT ?'
  args.push(limit)
  return q(sql, ...args).map(decorate)
}

export function getStatement(id) {
  const s = q1(`SELECT s.*, c.title crisis_title, c.status crisis_status, c.level crisis_level,
      wo.title wo_title, wo.status wo_status
    FROM crisis_statements s LEFT JOIN crisis c ON c.id=s.crisis_id
    LEFT JOIN work_orders wo ON wo.id=s.work_order_id WHERE s.id=?`, id)
  if (!s) return null
  const d = decorate(s)
  d.logs = q('SELECT * FROM crisis_statement_logs WHERE statement_id=? ORDER BY id ASC', id)
  return d
}

// 看板汇总
export function statementSummary() {
  const rows = q('SELECT status, COUNT(*) c FROM crisis_statements GROUP BY status')
  const counts = { draft: 0, review: 0, approved: 0, publishing: 0, published: 0, cancelled: 0 }
  for (const r of rows) counts[r.status] = r.c
  const ch = q1(`SELECT
      (SELECT COUNT(*) FROM crisis_statement_channels WHERE status IN ('pending','publishing')) openCh,
      (SELECT COUNT(*) FROM crisis_statement_channels WHERE status='failed') failedCh`)
  return {
    counts,
    total: counts.draft + counts.review + counts.approved + counts.publishing + counts.published + counts.cancelled,
    review: counts.review, publishing: counts.publishing,
    channelOpen: ch.openCh, channelFailed: ch.failedCh
  }
}

// 危机卡片角标：该危机最新一份未完结声明
export function crisisStatementBrief(crisisId) {
  const s = q1('SELECT id,title,status,updated FROM crisis_statements WHERE crisis_id=? ORDER BY id DESC LIMIT 1', crisisId)
  return s ? { ...s, statusText: STMT_STATUS[s.status] || s.status } : null
}

// 危机下未完结（进行中）声明数（结案守卫/看板口径）
export function crisisOpenStatementCount(crisisId) {
  return q1("SELECT COUNT(*) c FROM crisis_statements WHERE crisis_id=? AND status IN ('draft','review','approved','publishing')", crisisId).c
}

// ===== 时间线/工单双写 =====
function syncProgress(stmtId, action, note, { woRole = '' } = {}) {
  const s = q1('SELECT * FROM crisis_statements WHERE id=?', stmtId)
  if (!s) return
  const c = q1('SELECT status FROM crisis WHERE id=?', s.crisis_id)
  if (c && c.status !== 'closed') addTimeline(s.crisis_id, action, note)
  if (s.work_order_id) {
    run('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)',
      s.work_order_id, 'stmt', note, action === '声明审核通过' || action === '声明审核驳回' ? (s.reviewed_by || '法务') : '系统', woRole, now())
    run('UPDATE work_orders SET last_statement_id=? WHERE id=?', stmtId, s.work_order_id)
  }
}

// 重算分渠道完成度：全部渠道到达终态 → 声明发布完成（含部分失败）
function recomputePublishing(stmtId, operator = '系统') {
  const s = q1('SELECT * FROM crisis_statements WHERE id=?', stmtId)
  if (!s || !['publishing', 'published'].includes(s.status)) return
  const rows = q('SELECT * FROM crisis_statement_channels WHERE statement_id=?', stmtId)
  if (!rows.length) return
  const open = rows.filter((r) => ['pending', 'publishing'].includes(r.status)).length
  if (open === 0 && s.status === 'publishing') {
    const ok = rows.filter((r) => r.status === 'success').length
    const failed = rows.filter((r) => r.status === 'failed').length
    const cancelled = rows.filter((r) => r.status === 'cancelled').length
    const ts = now()
    run("UPDATE crisis_statements SET status='published', published_at=?, updated=? WHERE id=?", ts, ts, stmtId)
    addLog(stmtId, 'done', `全部 ${rows.length} 个渠道执行登记完成：成功 ${ok}${failed ? `、失败 ${failed}` : ''}${cancelled ? `、取消 ${cancelled}` : ''}`, operator)
    const note = `声明「${s.title}」分渠道发布登记全部完成：${ok}/${rows.length} 个渠道已发布` +
      (failed ? `，${failed} 个渠道失败（可在声明详情重试）` : '')
    const c = q1('SELECT status FROM crisis WHERE id=?', s.crisis_id)
    if (c && c.status !== 'closed') addTimeline(s.crisis_id, '声明发布完成', note, ts)
    if (s.work_order_id) {
      run('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)',
        s.work_order_id, 'stmt', note, operator, '', ts)
    }
  }
}

// ===== 创建（公关起草） =====
export function createStatement(body, actor) {
  const b = body || {}
  const crisisId = +b.crisis_id
  const c = q1('SELECT * FROM crisis WHERE id=?', crisisId)
  if (!c) return { error: '所属危机事件不存在' }
  if (c.status === 'closed') return { error: '事件已结案，不能再起草危机声明（如需发布请先回滚结案）' }
  const title = String(b.title || '').trim()
  if (!title) return { error: '声明标题必填' }
  const channels = normChannels(b.channels)
  const priority = STMT_PRIORITY[b.priority] ? b.priority : 'high'
  // 关联处置工单（可选）：须属于该危机且未取消
  let woId = null
  if (b.work_order_id) {
    const wo = q1('SELECT * FROM work_orders WHERE id=?', +b.work_order_id)
    if (!wo || wo.crisis_id !== crisisId) return { error: '关联工单不存在或不属于该危机事件' }
    if (wo.status === 'cancelled') return { error: '关联工单已取消，不能关联' }
    woId = wo.id
  }
  const ts = now()
  const r = run(`INSERT INTO crisis_statements
    (crisis_id,work_order_id,title,content,channels,priority,status,drafted_by,drafted_at,created,updated)
    VALUES (?,?,?,?,?,?,'draft',?,?,?,?)`,
    crisisId, woId, title, String(b.content || '').trim(), JSON.stringify(channels), priority, actor.user, ts, ts, ts)
  const id = Number(r.lastInsertRowid)
  if (woId) run('UPDATE work_orders SET last_statement_id=? WHERE id=?', id, woId)
  addLog(id, 'create', `公关起草危机声明（${STMT_PRIORITY[priority]}）` + (channels.length ? `，拟定发布渠道：${channels.map((k) => STMT_CHANNELS[k]).join('、')}` : '，暂未指定发布渠道'), actor.user)
  addTimeline(crisisId, '声明起草', `公关 ${actor.user} 起草危机声明「${title}」`, ts)
  if (woId) {
    run('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)',
      woId, 'stmt', `公关 ${actor.user} 起草关联危机声明「${title}」`, actor.user, actor.assigneeRole || actor.role || '', ts)
  }
  return { ok: true, id }
}

function normChannels(list) {
  if (!Array.isArray(list)) return []
  return [...new Set(list.map((x) => String(x || '').trim()).filter((x) => STMT_CHANNELS[x]))]
}

// ===== 编辑（起草中；驳回退回后可修改重新送审） =====
export function editStatement(id, body, actor) {
  const s = q1('SELECT * FROM crisis_statements WHERE id=?', id)
  if (!s) return null
  if (s.status !== 'draft') return { error: `仅起草中的声明可编辑（当前：${STMT_STATUS[s.status]}；审核驳回后会退回起草）` }
  const b = body || {}
  const title = b.title !== undefined ? String(b.title).trim() : s.title
  if (!title) return { error: '声明标题必填' }
  const content = b.content !== undefined ? String(b.content) : s.content
  const channels = b.channels !== undefined ? normChannels(b.channels) : safeParse(s.channels, [])
  const priority = b.priority !== undefined ? (STMT_PRIORITY[b.priority] ? b.priority : s.priority) : s.priority
  const ts = now()
  run('UPDATE crisis_statements SET title=?, content=?, channels=?, priority=?, updated=? WHERE id=?',
    title, content, JSON.stringify(channels), priority, ts, id)
  const parts = []
  if (title !== s.title) parts.push(`标题改为「${title}」`)
  if (content !== s.content) parts.push(content.trim() ? '更新声明正文' : '清空声明正文')
  if (JSON.stringify(channels) !== s.channels) parts.push(`发布渠道调整为：${channels.length ? channels.map((k) => STMT_CHANNELS[k]).join('、') : '（未指定）'}`)
  if (priority !== s.priority) parts.push(`优先级调整为${STMT_PRIORITY[priority]}`)
  addLog(id, 'edit', parts.length ? parts.join('；') : '保存（无内容变化）', actor.user)
  return { ok: true }
}

// ===== 提交法务审核（draft → review） =====
export function submitStatement(id, body, actor) {
  const s = q1('SELECT * FROM crisis_statements WHERE id=?', id)
  if (!s) return null
  if (s.status !== 'draft') return { error: `仅起草中的声明可提交审核（当前：${STMT_STATUS[s.status]}）` }
  if (!(s.content || '').trim() && !(body?.content || '').trim()) return { error: '声明正文为空，请先完成起草再送审' }
  const channels = s.channels ? safeParse(s.channels, []) : []
  if (!channels.length) return { error: '请至少选择一个拟发布渠道后再送审' }
  const ts = now()
  const content = body?.content !== undefined ? String(body.content) : s.content
  run("UPDATE crisis_statements SET status='review', content=COALESCE(NULLIF(?, ''), content), submitted_by=?, submitted_at=?, review_note='', updated=? WHERE id=?",
    content, actor.user, ts, ts, id)
  addLog(id, 'submit', '提交法务审核，等待法务意见', actor.user)
  syncProgress(id, '声明送审', `声明「${s.title}」提交法务审核（提交人：${actor.user}），拟定渠道：${channels.map((k) => STMT_CHANNELS[k]).join('、')}`)
  return { ok: true }
}

// ===== 法务审核通过（review → approved，法务/管理员） =====
export function approveStatement(id, body, actor) {
  const s = q1('SELECT * FROM crisis_statements WHERE id=?', id)
  if (!s) return null
  if (s.status !== 'review') return { error: `仅待审核的声明可审核（当前：${STMT_STATUS[s.status]}）` }
  const note = String(body?.note || '').trim() || '口径与证据材料一致，同意按审核稿发布。'
  const ts = now()
  run("UPDATE crisis_statements SET status='approved', reviewed_by=?, reviewed_at=?, review_note=?, updated=? WHERE id=?",
    actor.user, ts, note, ts, id)
  addLog(id, 'approve', `法务审核通过：${note}`, actor.user)
  syncProgress(id, '声明审核通过', `法务 ${actor.user} 审核通过声明「${s.title}」：${note}`, { woRole: 'legal' })
  return { ok: true }
}

// ===== 法务审核驳回（review → draft，法务/管理员） =====
export function rejectStatement(id, body, actor) {
  const s = q1('SELECT * FROM crisis_statements WHERE id=?', id)
  if (!s) return null
  if (s.status !== 'review') return { error: `仅待审核的声明可驳回（当前：${STMT_STATUS[s.status]}）` }
  const note = String(body?.note || '').trim() || '审核未通过，请按法务意见修改后重新提交'
  const ts = now()
  run("UPDATE crisis_statements SET status='draft', reviewed_by=?, reviewed_at=?, review_note=?, updated=? WHERE id=?",
    actor.user, ts, note, ts, id)
  addLog(id, 'reject', `法务审核驳回，退回起草：${note}`, actor.user)
  syncProgress(id, '声明审核驳回', `法务 ${actor.user} 驳回声明「${s.title}」：${note}（退回公关修改）`, { woRole: 'legal' })
  return { ok: true }
}

// ===== 发起分渠道发布（approved → publishing；落渠道执行行，可在此最终确认渠道清单） =====
export function startPublishing(id, body, actor) {
  const s = q1('SELECT * FROM crisis_statements WHERE id=?', id)
  if (!s) return null
  if (s.status !== 'approved') return { error: `仅审核通过的声明可发起发布（当前：${STMT_STATUS[s.status]}）` }
  // 发起前可最终确认渠道清单（缺省沿用起草时选择）
  const channels = body?.channels ? normChannels(body.channels) : safeParse(s.channels, [])
  if (!channels.length) return { error: '至少需要一个发布渠道' }
  const ts = now()
  db.exec('BEGIN')
  try {
    run("UPDATE crisis_statements SET status='publishing', channels=?, publish_by=?, publish_at=?, updated=? WHERE id=?",
      JSON.stringify(channels), actor.user, ts, ts, id)
    for (const key of channels) {
      const exists = q1('SELECT 1 FROM crisis_statement_channels WHERE statement_id=? AND channel=?', id, key)
      if (!exists) {
        run(`INSERT INTO crisis_statement_channels (statement_id,channel,channel_name,status,assignee,created,updated)
          VALUES (?,?,?,'pending',?,?,?)`, id, key, STMT_CHANNELS[key], String(body?.assignee || actor.user || ''), ts, ts)
      }
    }
    addLog(id, 'publish', `发起分渠道发布，${channels.length} 个渠道待执行（执行人：${body?.assignee || actor.user}）`, actor.user)
    const c = q1('SELECT status FROM crisis WHERE id=?', s.crisis_id)
    if (c && c.status !== 'closed') {
      addTimeline(s.crisis_id, '声明发布',
        `声明「${s.title}」发起分渠道发布：${channels.map((k) => STMT_CHANNELS[k]).join('、')}（发起人：${actor.user}）`, ts)
    }
    if (s.work_order_id) {
      run('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)',
        s.work_order_id, 'stmt', `关联声明「${s.title}」发起分渠道发布（${channels.length} 个渠道）`, actor.user, actor.assigneeRole || actor.role || '', ts)
      run('UPDATE work_orders SET last_statement_id=? WHERE id=?', id, s.work_order_id)
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  return { ok: true }
}

// 渠道行（调用方已校验声明存在）
function getChannel(rowId) {
  return q1(`SELECT sc.*, s.title s_title, s.crisis_id, s.work_order_id, s.status s_status
    FROM crisis_statement_channels sc JOIN crisis_statements s ON s.id=sc.statement_id WHERE sc.id=?`, rowId)
}

// ===== 登记渠道执行结果（发布人员分渠道执行并登记：执行中/成功/失败） =====
export function registerChannel(rowId, body, actor) {
  const row = getChannel(rowId)
  if (!row) return null
  if (!['publishing', 'published'].includes(row.s_status)) return { error: `声明当前为「${STMT_STATUS[row.s_status]}」，不可登记渠道结果` }
  const next = String(body?.status || '')
  if (!['publishing', 'success', 'failed'].includes(next)) return { error: '登记状态非法（执行中/已发布/失败）' }
  if (!['pending', 'publishing', 'failed'].includes(row.status)) return { error: `该渠道当前为「${CH_STATUS[row.status]}」，不能重复登记` }
  if (next === 'failed' && !String(body?.fail_reason || '').trim()) return { error: '登记失败时请填写失败原因' }
  if (next === 'success' && !String(body?.result || '').trim()) return { error: '登记发布成功时请填写发布结果/回执说明' }
  const ts = now()
  const result = String(body?.result || '').trim()
  const url = String(body?.published_url || '').trim()
  const failReason = String(body?.fail_reason || '').trim()
  const assignee = String(body?.assignee || '').trim() || row.assignee || actor.user
  db.exec('BEGIN')
  try {
    // 失败后重试成功：声明从已发布（部分失败）重新打开发布中
    if (row.s_status === 'published') run("UPDATE crisis_statements SET status='publishing', published_at=NULL, updated=? WHERE id=?", ts, row.statement_id)
    run(`UPDATE crisis_statement_channels SET status=?, result=?, published_url=?, fail_reason=?, assignee=?,
      attempts=attempts+1, registered_by=?, registered_at=?, published_at=COALESCE(published_at,CASE WHEN ?='success' THEN ? ELSE published_at END), updated=?
      WHERE id=?`,
      next, result, url, failReason, assignee, actor.user, ts, next, ts, ts, rowId)
    const chText = STMT_CHANNELS[row.channel] || row.channel_name
    const detail = next === 'success'
      ? `【${chText}】发布成功：${result}${url ? `（链接：${url}）` : ''}`
      : next === 'failed'
        ? `【${chText}】发布失败：${failReason}`
        : `【${chText}】开始执行（执行人：${assignee}）`
    addLog(row.statement_id, 'channel_result', detail, actor.user)
    const c = q1('SELECT status FROM crisis WHERE id=?', row.crisis_id)
    if (c && c.status !== 'closed') addTimeline(row.crisis_id, '声明渠道', detail, ts)
    if (row.work_order_id) {
      run('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)',
        row.work_order_id, 'stmt', `声明发布进度回写：${detail}`, actor.user, actor.assigneeRole || actor.role || '', ts)
      run('UPDATE work_orders SET last_statement_id=? WHERE id=?', row.statement_id, row.work_order_id)
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  recomputePublishing(row.statement_id, actor.user)
  return { ok: true }
}

// ===== 失败渠道重试（failed → pending，声明重回发布中） =====
export function retryChannel(rowId, body, actor) {
  const row = getChannel(rowId)
  if (!row) return null
  if (!['publishing', 'published'].includes(row.s_status)) return { error: '声明未在发布阶段，不能重试渠道' }
  if (row.status !== 'failed') return { error: `仅失败渠道可重试（当前：${CH_STATUS[row.status]}）` }
  const ts = now()
  const assignee = String(body?.assignee || '').trim() || row.assignee || actor.user
  db.exec('BEGIN')
  try {
    run("UPDATE crisis_statement_channels SET status='pending', fail_reason='', assignee=?, updated=? WHERE id=?", assignee, ts, rowId)
    run("UPDATE crisis_statements SET status='publishing', published_at=NULL, updated=? WHERE id=?", ts, row.statement_id)
    const chText = STMT_CHANNELS[row.channel] || row.channel_name
    addLog(row.statement_id, 'channel_retry', `【${chText}】重试发布（执行人：${assignee}），上次失败原因：${row.fail_reason || '—'}`, actor.user)
    const c = q1('SELECT status FROM crisis WHERE id=?', row.crisis_id)
    if (c && c.status !== 'closed') addTimeline(row.crisis_id, '声明渠道', `【${chText}】发布失败后重试（执行人：${assignee}）`, ts)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  return { ok: true }
}

// ===== 取消单个渠道（待执行/执行中 → cancelled） =====
export function cancelChannel(rowId, body, actor) {
  const row = getChannel(rowId)
  if (!row) return null
  if (row.s_status !== 'publishing') return { error: '仅发布中的声明可取消渠道' }
  if (!['pending', 'publishing'].includes(row.status)) return { error: `渠道当前为「${CH_STATUS[row.status]}」，不能取消` }
  const reason = String(body?.reason || '').trim() || '该渠道不再发布'
  const ts = now()
  run("UPDATE crisis_statement_channels SET status='cancelled', fail_reason=?, registered_by=?, registered_at=?, updated=? WHERE id=?",
    reason, actor.user, ts, ts, rowId)
  const chText = STMT_CHANNELS[row.channel] || row.channel_name
  addLog(row.statement_id, 'channel_cancel', `【${chText}】取消发布：${reason}`, actor.user)
  const c = q1('SELECT status FROM crisis WHERE id=?', row.crisis_id)
  if (c && c.status !== 'closed') addTimeline(row.crisis_id, '声明渠道', `【${chText}】取消发布：${reason}`, ts)
  if (row.work_order_id) {
    run('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)',
      row.work_order_id, 'stmt', `声明发布进度回写：【${chText}】取消发布：${reason}`, actor.user, '', ts)
  }
  recomputePublishing(row.statement_id, actor.user)
  return { ok: true }
}

// ===== 取消整份声明（draft/approved/publishing → cancelled；发布中的待执行渠道一并取消） =====
export function cancelStatement(id, body, actor) {
  const s = q1('SELECT * FROM crisis_statements WHERE id=?', id)
  if (!s) return null
  if (!['draft', 'review', 'approved', 'publishing'].includes(s.status)) {
    return { error: `当前状态（${STMT_STATUS[s.status]}）不能取消` }
  }
  const reason = String(body?.reason || '').trim()
  const ts = now()
  db.exec('BEGIN')
  try {
    run("UPDATE crisis_statements SET status='cancelled', cancel_by=?, cancel_at=?, cancel_reason=?, updated=? WHERE id=?",
      actor.user, ts, reason, ts, id)
    const cr = run("UPDATE crisis_statement_channels SET status='cancelled', updated=? WHERE statement_id=? AND status IN ('pending','publishing')", ts, id)
    addLog(id, 'cancel', (s.status === 'publishing' ? `取消声明发布，${Number(cr.changes)} 个待执行渠道一并取消` : '取消危机声明') + (reason ? `：${reason}` : ''), actor.user)
    const c = q1('SELECT status FROM crisis WHERE id=?', s.crisis_id)
    if (c && c.status !== 'closed') {
      addTimeline(s.crisis_id, '声明取消', `声明「${s.title}」已取消${reason ? `：${reason}` : ''}` +
        (s.status === 'publishing' ? `（${Number(cr.changes)} 个待执行渠道一并取消）` : ''), ts)
    }
    if (s.work_order_id) {
      run('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)',
        s.work_order_id, 'stmt', `关联危机声明「${s.title}」已取消${reason ? `：${reason}` : ''}`, actor.user, '', ts)
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  return { ok: true }
}

// 删除危机时级联清理（由 index.js 危机删除链路调用）
export function deleteStatementsOfCrisis(crisisId) {
  const ids = q('SELECT id FROM crisis_statements WHERE crisis_id=?', crisisId).map((r) => r.id)
  for (const id of ids) {
    run('DELETE FROM crisis_statement_channels WHERE statement_id=?', id)
    run('DELETE FROM crisis_statement_logs WHERE statement_id=?', id)
  }
  run('DELETE FROM crisis_statements WHERE crisis_id=?', crisisId)
  run('UPDATE work_orders SET last_statement_id=NULL WHERE crisis_id=?', crisisId)
  return ids.length
}
