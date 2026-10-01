import { db, parseTimeMs } from './db.js'
import { now } from './pipeline.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// ===== 协同调度事件流（统一追踪层） =====
// 工单链路（分派/改派/认领/超时升级）与通知链路（生成/重试/回执/回执超时升级）共享同一条
// 可追踪状态流 dispatch_events：危机看板角标、处置时间线、复盘统计三处口径同源——
// 实时指标（升级中/待回执/重试中）SQL 直查业务表，与工单看板、通知中心同口径；
// 流转计数（分派次数/重试次数/回执率等）取自本事件流。
export const DISPATCH_ACTION = {
  assign: '分派', reassign: '改派', claim: '认领',
  wo_escalate1: '一级超时升级', wo_escalate2: '二级升级督办',
  notify_created: '通知生成', retry: '自动重试', manual_retry: '手动重试', send_failed: '发送失败',
  ack: '回执确认', ack_escalate: '回执超时升级'
}
const EVENT_LIMIT = 60 // 复盘快照/回溯面板的事件流明细上限（计数不受明细窗口限制）

// 写一条调度链事件（kind: wo 工单流转 / notify 通知流转；woId 让通知事件可回溯到来源工单）
export function trace({ crisisId, kind, action, refId, woId = null, title = '', actor = '系统', detail = '', time = null }) {
  if (!crisisId) return // 无归属危机的对象不进调度链（如未关联危机的预警通知）
  run(`INSERT INTO dispatch_events (crisis_id,kind,action,ref_id,wo_id,title,actor,detail,time)
    VALUES (?,?,?,?,?,?,?,?,?)`,
    crisisId, kind, action, refId || 0, woId, title, actor || '系统', detail || '', time || now())
}

function decorate(e) { return { ...e, actionText: DISPATCH_ACTION[e.action] || e.action } }

// 某工单的完整调度链：分派/改派/认领/超时升级 → 通知生成/重试 → 回执/回执超时升级（工单详情展示用）
export function workOrderDispatch(woId) {
  return q('SELECT * FROM dispatch_events WHERE wo_id=? ORDER BY id ASC', woId).map(decorate)
}

// 单危机调度链路聚合：危机看板角标 / 事件回溯 / 复盘快照 三处同源
export function crisisDispatch(crisisId) {
  // 实时指标（与工单看板、通知中心同口径，SQL 直查业务表）
  const live = q1(`SELECT
    (SELECT COUNT(*) FROM work_orders WHERE crisis_id=? AND escalated>0 AND status IN ('todo','doing','blocked')) woEscalated,
    (SELECT COUNT(*) FROM notify_tasks WHERE crisis_id=? AND require_ack=1 AND status IN ('sent','escalated')) ackPending,
    (SELECT COUNT(*) FROM notify_tasks WHERE crisis_id=? AND (status='failed' OR (status='pending' AND next_retry_at IS NOT NULL))) retrying`,
    crisisId, crisisId, crisisId)
  // 流转计数（统一事件流同源统计，不受明细窗口限制）
  const counts = {}
  for (const r of q('SELECT action, COUNT(*) c FROM dispatch_events WHERE crisis_id=? GROUP BY action', crisisId)) counts[r.action] = r.c
  // 回执质量：需回执任务的确认比例与平均确认时长（分钟，ack_at-sent_at）
  const ackRows = q(`SELECT sent_at, ack_at FROM notify_tasks
    WHERE crisis_id=? AND require_ack=1 AND ack_at IS NOT NULL AND sent_at IS NOT NULL`, crisisId)
  let avgAckMin = null
  const mins = ackRows
    .map((t) => (parseTimeMs(t.ack_at) - parseTimeMs(t.sent_at)) / 60000)
    .filter((x) => Number.isFinite(x) && x >= 0)
  if (mins.length) avgAckMin = Math.round((mins.reduce((a, b) => a + b, 0) / mins.length) * 10) / 10
  const requireAck = q1('SELECT COUNT(*) c FROM notify_tasks WHERE crisis_id=? AND require_ack=1', crisisId).c
  const acked = q1("SELECT COUNT(*) c FROM notify_tasks WHERE crisis_id=? AND require_ack=1 AND status='acked'", crisisId).c
  return {
    ...live,
    wo: {
      assign: counts.assign || 0, reassign: counts.reassign || 0, claim: counts.claim || 0,
      escalate1: counts.wo_escalate1 || 0, escalate2: counts.wo_escalate2 || 0
    },
    notify: {
      created: counts.notify_created || 0, retry: counts.retry || 0, manualRetry: counts.manual_retry || 0,
      sendFailed: counts.send_failed || 0, ack: counts.ack || 0, ackEscalate: counts.ack_escalate || 0
    },
    ackQuality: {
      requireAck, acked,
      ackRate: requireAck ? Math.round((acked / requireAck) * 100) : null,
      avgAckMin
    },
    events: q('SELECT * FROM dispatch_events WHERE crisis_id=? ORDER BY id DESC LIMIT ?', crisisId, EVENT_LIMIT).map(decorate)
  }
}

// 全局调度链路看板指标（总览统计卡，与 crisisDispatch 实时口径一致）
export function dispatchBoard() {
  return q1(`SELECT
    (SELECT COUNT(*) FROM work_orders WHERE escalated>0 AND status IN ('todo','doing','blocked')) workEscalated,
    (SELECT COUNT(*) FROM notify_tasks WHERE require_ack=1 AND status IN ('sent','escalated')) notifyAckPending,
    (SELECT COUNT(*) FROM notify_tasks WHERE status='failed' OR (status='pending' AND next_retry_at IS NOT NULL)) notifyRetry`)
}
