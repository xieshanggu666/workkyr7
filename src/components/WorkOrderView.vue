<template>
  <div class="wo">
    <div class="wo-toolbar">
      <button v-if="canOps" class="add" @click="openForm()">＋ 拆分工单</button>
      <div class="chips">
        <button class="chip" :class="{on:!filter}" @click="setFilter('')">全部 {{ totalCount }}</button>
        <button v-for="(txt,k) in dict.status" :key="k" class="chip" :class="[k,{on:filter===k}]" @click="setFilter(k)">
          {{ txt }} {{ summary.counts?.[k]||0 }}
        </button>
        <span v-if="summary.overdue" class="chip overdue">⏰ 超时 {{ summary.overdue }}</span>
        <span v-if="summary.escalated" class="chip esc">⬆ 已升级 {{ summary.escalated }}</span>
      </div>
      <span class="me">👤 {{ store.user.name }} · {{ roleText(store.user.role) }}</span>
    </div>
    <p class="hint">🔗 从危机拆分跨角色协同工单：分派/认领 → 处理（可阻塞挂起 SLA）→ 完成回写危机时间线（可联动解除预警）；SLA 超时两级升级并联动通知调度；结案须先完结全部工单。</p>

    <!-- 拆分工单表单 -->
    <form v-if="showForm" class="wo-form" @submit.prevent="create">
      <div v-if="!openCrises.length" class="no-crisis">⚠️ 暂无未结案危机事件，无法拆分工单（已结案事件需先回滚结案）</div>
      <template v-else>
      <div class="row">
        <select v-model.number="form.crisis_id" required>
          <option :value="null" disabled>选择所属危机事件（未结案）</option>
          <option v-for="c in openCrises" :key="c.id" :value="c.id">#{{ c.id }} {{ c.title }}（{{ stText(c.status) }}）</option>
        </select>
        <select v-model="form.category">
          <option v-for="(t,k) in dict.category" :key="k" :value="k">{{ t }}</option>
        </select>
        <select v-model="form.priority">
          <option v-for="(t,k) in dict.priority" :key="k" :value="k">{{ t }}</option>
        </select>
      </div>
      <input v-model="form.title" placeholder="工单标题，如 统一对外回应口径" required />
      <textarea v-model="form.detail" placeholder="任务说明：目标、要求、上下文…"></textarea>
      <div class="row">
        <input v-model="form.assignee" placeholder="处理人（留空=待分派，可认领）" />
        <select v-model="form.assignee_role">
          <option value="">职能团队</option>
          <option v-for="(t,k) in dict.role" :key="k" :value="k">{{ t }}</option>
        </select>
        <input v-model.number="form.sla_min" type="number" min="0" max="10080" placeholder="SLA(分钟,0=无时限)" />
      </div>
      <div class="row">
        <button class="save" type="submit">拆分并{{ form.assignee ? '分派' : '挂起待分派' }}</button>
        <button type="button" class="ghost" @click="showForm=false">取消</button>
      </div>
      </template>
    </form>

    <div v-if="!items.length" class="none">暂无协同工单（在危机处置页或此处从危机拆分）</div>

    <!-- 工单看板 -->
    <div class="board">
      <div v-for="w in items" :key="w.id" class="wo-card" :class="[w.status, {overdue:w.overdue, esc1:w.escalated===1, esc2:w.escalated===2}]">
        <div class="w-head">
          <span class="st" :class="w.status">{{ w.statusText }}</span>
          <span class="pri" :class="w.priority">{{ w.priorityText }}</span>
          <b class="w-title">{{ w.title }}</b>
          <span v-if="w.escalated" class="esc-tag" :class="'e'+w.escalated">{{ w.escalated===2 ? '⬆⬆ 二级督办' : '⬆ 已升级' }}</span>
          <span class="cat">{{ w.categoryText }}</span>
        </div>
        <div v-if="w.detail" class="w-detail">{{ w.detail }}</div>
        <div class="w-meta">
          <span>危机 <i>#{{ w.crisis_id }} {{ w.crisis_title || '' }}</i></span>
          <span v-if="w.prop_path_id" class="prop-src">🕸 源自传播路径 #{{ w.prop_path_id }}</span>
          <span v-if="w.stmt" class="stmt-src" @click="gotoStmt(w)">📢 声明：{{ stmtStatusText(w.stmt.status) }}</span>
          <span>处理人 <i>{{ w.assignee ? `${w.assignee}${w.roleText ? '·'+w.roleText : ''}` : '待分派' }}</i></span>
          <span v-if="w.due_at && !['done','cancelled'].includes(w.status)" class="sla" :class="{over:w.overdue}">
            ⏱ {{ slaText(w) }}
          </span>
          <span v-else-if="w.due_at">⏱ 已截止</span>
          <span v-else>⏱ 无时限</span>
          <span>更新 <i>{{ w.updated }}</i></span>
        </div>
        <div v-if="w.status==='blocked' && w.blocked_reason" class="w-blocked">🚧 阻塞：{{ w.blocked_reason }}（SLA 已挂起）</div>
        <div v-if="w.result" class="w-result">✅ 处理结果：{{ w.result }}<em v-if="w.resolve_alerts">（已联动解除该事件全部未解除预警）</em></div>
        <div class="w-actions" v-if="canOps">
          <button v-if="w.status==='todo'" class="op claim" @click="claim(w)">✋ 认领</button>
          <button v-if="w.status==='todo'" class="op" @click="assign(w)">➡ 指派</button>
          <button v-if="w.status==='doing'" class="op block" @click="block(w)">🚧 阻塞</button>
          <button v-if="w.status==='blocked'" class="op resume" @click="op(w,'start')">▶ 恢复</button>
          <button v-if="['doing','blocked'].includes(w.status)" class="op done" @click="complete(w)">✔ 完成</button>
          <button v-if="['todo','doing','blocked'].includes(w.status)" class="op" @click="assign(w)">⇄ 改派</button>
          <button v-if="['done','blocked','todo'].includes(w.status)" class="op rework" @click="rework(w)">↩ 回退</button>
          <button v-if="['todo','doing','blocked'].includes(w.status)" class="op cancel" @click="cancel(w)">✕ 取消</button>
          <button class="op stmt-op" @click="gotoStmt(w)">{{ w.stmt ? '📢 查看声明' : '📢 起草声明' }}</button>
        </div>
        <button class="logbtn" @click="toggleLogs(w)">{{ logId===w.id ? '收起日志' : '📜 日志' }}</button>
        <div v-if="logId===w.id" class="w-logs">
          <div v-for="l in logs" :key="l.id" class="wlog">
            <span class="lg-act" :class="l.action">{{ logText(l.action) }}</span>
            <span class="lg-detail">{{ l.detail }}</span>
            <em>{{ l.operator }}{{ l.operator_role ? '·'+roleName(l.operator_role) : '' }} · {{ l.time }}</em>
          </div>
          <div v-if="!logs.length" class="none">暂无日志</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { usePubStore } from '@/store/pub'

const store = usePubStore()
const items = ref([])
const summary = ref({ counts: {} })
const dict = ref({ status: {}, priority: {}, role: {}, category: {} })
const filter = ref('')
const showForm = ref(false)
const logId = ref(null)
const logs = ref([])
const nowTick = ref(Date.now()) // SLA 倒计时本地秒针

const form = ref({ crisis_id: null, title: '', detail: '', category: 'other', priority: 'normal', assignee: '', assignee_role: '', sla_min: 60 })

const canOps = computed(() => ['admin', 'ops'].includes(store.user.role))
const openCrises = computed(() => store.crises.filter((c) => c.status !== 'closed'))
const totalCount = computed(() => Object.values(summary.value.counts || {}).reduce((a, b) => a + b, 0))

function roleText(r) { return { admin: '管理员', ops: '值班员', viewer: '观察员' }[r] || r }
function roleName(r) { return dict.value.role[r] || r }
function stText(s) { return { monitoring: '监测中', disposal: '处置中', closed: '已结案' }[s] || s }
function stmtStatusText(s) { return { draft: '起草中', review: '待法务审核', approved: '审核通过', publishing: '发布中', published: '已发布', cancelled: '已取消' }[s] || s }
// 跳转危机声明页：带所属危机预填起草，并预关联本工单
function gotoStmt(w) {
  store.stmtDraftCrisis = w.crisis_id
  store.stmtWorkOrderId = w.stmt ? null : w.id
  store.stmtOpenId = w.stmt ? w.stmt.id : null
  store.tab = 'stmt'
}
function logText(a) {
  return {
    created: '拆分', assigned: '分派', claimed: '认领', started: '开始', blocked: '阻塞',
    unblocked: '恢复', done: '完成', rework: '回退', cancelled: '取消', escalated: '升级'
  }[a] || a
}
// SLA 文案：阻塞挂起用服务端冻结剩余，其余按本地秒针倒数
function slaText(w) {
  let ms
  if (w.status === 'blocked') ms = w.remainingMs
  else ms = w.due_at - nowTick.value
  if (ms == null) return '无时限'
  const abs = Math.abs(ms)
  const m = Math.floor(abs / 60000), s = Math.floor((abs % 60000) / 1000)
  const txt = m >= 60 ? `${Math.floor(m / 60)}小时${m % 60}分` : `${m}分${s}秒`
  return ms < 0 ? `已超时 ${txt}` : (w.status === 'blocked' ? `挂起中 · 剩 ${txt}` : `剩 ${txt}`)
}

async function load() {
  const d = await store.fetchWorkOrders(filter.value ? { status: filter.value } : null)
  items.value = d.items
  summary.value = d.summary
  dict.value = d.dict
}
function setFilter(k) { filter.value = k; load() }

function openForm() {
  showForm.value = true
  if (store.woDraftCrisis) { form.value.crisis_id = store.woDraftCrisis; store.woDraftCrisis = null }
}
// 危机卡片「拆分工单」跳转：预填所属危机并展开表单
watch(() => store.woDraftCrisis, (id) => {
  if (id) { form.value.crisis_id = id; showForm.value = true; store.woDraftCrisis = null }
})

async function run(fn) {
  try { await fn(); await load() }
  catch (e) { store.msg(e.message, 'warn') }
}
async function create() {
  const f = form.value
  if (!f.crisis_id) { store.msg('请先选择所属危机事件', 'warn'); return }
  await run(() => store.createWorkOrder({
    crisis_id: f.crisis_id, title: f.title, detail: f.detail, category: f.category,
    priority: f.priority, assignee: f.assignee, assignee_role: f.assignee_role, sla_min: f.sla_min || 0
  }))
  form.value = { crisis_id: null, title: '', detail: '', category: 'other', priority: 'normal', assignee: '', assignee_role: '', sla_min: 60 }
  showForm.value = false
}
async function op(w, action, body) { await run(() => store.workOrderOp(w.id, action, body)) }
async function claim(w) { await op(w, 'claim') }
async function assign(w) {
  const name = prompt(`指派工单「${w.title}」给：`, w.assignee || '李澈')
  if (name == null || !name.trim()) return
  const role = prompt('职能团队（pr 公关 / legal 法务 / ops 运营 / support 客服 / admin 协调组，可留空）：', w.assignee_role || '') ?? ''
  await op(w, 'assign', { assignee: name.trim(), assignee_role: role.trim() })
}
async function block(w) {
  const reason = prompt(`阻塞挂起工单「${w.title}」：\n阻塞期间 SLA 计时暂停，恢复后自动顺延。\n阻塞原因：`)
  if (reason == null || !reason.trim()) return
  await op(w, 'block', { reason: reason.trim() })
}
async function complete(w) {
  const result = prompt(`完成工单「${w.title}」：\n处理结果将回写危机时间线。`)
  if (result == null || !result.trim()) return
  const resolveAlerts = confirm('是否联动解除该危机事件下全部未解除预警？\n（确定=解除并标注「工单联动」，取消=仅回写结果）')
  await op(w, 'complete', { result: result.trim(), resolve_alerts: resolveAlerts })
}
async function rework(w) {
  const note = prompt(`回退工单「${w.title}」至处理中${w.status === 'done' ? '（打回重做）' : ''}：\n退回说明：`)
  if (note == null) return
  await op(w, 'rework', { note: note.trim() })
}
async function cancel(w) {
  const note = prompt(`取消工单「${w.title}」？\n取消说明（可留空）：`)
  if (note == null) return
  await op(w, 'cancel', { note: note.trim() })
}
async function toggleLogs(w) {
  if (logId.value === w.id) { logId.value = null; logs.value = []; return }
  const d = await store.fetchWorkOrder(w.id)
  logs.value = d.logs
  logId.value = w.id
}

let timer = null, tick = null
onMounted(async () => {
  await load()
  if (store.woDraftCrisis) openForm()
  timer = setInterval(load, 4000)
  tick = setInterval(() => { nowTick.value = Date.now() }, 1000)
})
onUnmounted(() => { clearInterval(timer); clearInterval(tick) })
</script>

<style scoped>
.wo{display:flex;flex-direction:column;gap:12px;}
.wo-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.add{background:linear-gradient(135deg,#43a047,#2e7d32);border:none;color:#fff;border-radius:8px;padding:9px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;}
.chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
.chip{background:#0f1b38;border:1px solid rgba(120,160,220,0.18);color:#8ba2c8;border-radius:14px;padding:4px 12px;font-size:11px;cursor:pointer;font-family:inherit;}
.chip.on{border-color:#2962ff;color:#fff;background:#132a52;}
.chip.todo.on{border-color:#42a5f5;background:#0d2137;}
.chip.doing.on{border-color:#ffb300;background:#33270e;}
.chip.blocked.on{border-color:#ab47bc;background:#2a1530;}
.chip.done.on{border-color:#66bb6a;background:#14261a;}
.chip.overdue{border-color:rgba(239,83,80,.5);color:#ef9a9a;background:#2c1418;cursor:default;}
.chip.esc{border-color:rgba(255,152,0,.5);color:#ffcc80;background:#33230e;cursor:default;}
.me{margin-left:auto;font-size:11px;color:#8ba2c8;background:#13233f;border:1px solid rgba(120,160,220,0.2);border-radius:8px;padding:6px 12px;}
.hint{margin:0;font-size:11px;color:#5b6f94;line-height:1.5;}
.wo-form{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;}
.no-crisis{font-size:12px;color:#ffab91;background:#3e2723;border:1px solid rgba(255,138,101,.3);border-radius:8px;padding:8px 10px;}
.row{display:flex;gap:8px;flex-wrap:wrap;}
.row select,.row input{flex:1;min-width:120px;}
input,select,textarea,button{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 10px;font-size:12px;}
textarea{resize:vertical;min-height:52px;}
.save{background:#2962ff;border:none;color:#fff;font-weight:600;cursor:pointer;}
.ghost{background:#16263f;color:#8ba2c8;cursor:pointer;}
.none{color:#5b6f94;text-align:center;padding:32px;}
.board{display:flex;flex-direction:column;gap:10px;}
.wo-card{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-left:4px solid #546e7a;border-radius:10px;padding:12px 14px;position:relative;}
.wo-card.todo{border-left-color:#42a5f5;}
.wo-card.doing{border-left-color:#ffb300;}
.wo-card.blocked{border-left-color:#ab47bc;}
.wo-card.done{border-left-color:#66bb6a;}
.wo-card.cancelled{opacity:.5;}
.wo-card.overdue{border-left-color:#ef5350;}
.wo-card.esc2{border-left-color:#ef5350;box-shadow:0 0 0 1px rgba(239,83,80,.35);}
.w-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.st{font-size:10px;padding:2px 9px;border-radius:6px;flex:none;}
.st.todo{background:#0d2137;color:#90caf9;}
.st.doing{background:#33270e;color:#ffe082;}
.st.blocked{background:#2a1530;color:#ce93d8;}
.st.done{background:#1b5e20;color:#a5d6a7;}
.st.cancelled{background:#21262c;color:#78909c;}
.pri{font-size:10px;padding:2px 8px;border-radius:6px;flex:none;background:#16263f;color:#8ba2c8;}
.pri.urgent{background:#4a1518;color:#ef9a9a;}
.pri.high{background:#33230e;color:#ffcc80;}
.w-title{color:#fff;font-size:13px;flex:1;min-width:160px;}
.esc-tag{font-size:10px;padding:2px 8px;border-radius:6px;background:#3e2723;color:#ffab91;}
.esc-tag.e2{background:#4a1518;color:#ef9a9a;font-weight:700;}
.cat{font-size:10px;color:#8ba2c8;background:#0d2137;border:1px solid rgba(144,202,249,.25);border-radius:5px;padding:1px 7px;}
.w-detail{color:#8ba2c8;font-size:11px;margin:6px 0;}
.w-meta{display:flex;gap:14px;flex-wrap:wrap;font-size:10px;color:#5b6f94;}
.w-meta i{color:#90caf9;font-style:normal;}
.prop-src{color:#80cbc4;}
.prop-src i{font-style:normal;}
.stmt-src{color:#80cbc4;background:#0d2b28;border:1px solid rgba(0,150,136,.3);border-radius:5px;padding:1px 7px;cursor:pointer;}
.sla{color:#8ba2c8;}
.sla.over{color:#ef9a9a;font-weight:700;}
.w-blocked{margin-top:6px;font-size:10px;color:#ce93d8;background:#241226;border-radius:6px;padding:4px 8px;}
.w-result{margin-top:6px;font-size:10px;color:#a5d6a7;background:#12261a;border-radius:6px;padding:4px 8px;}
.w-result em{color:#80cbc4;font-style:normal;}
.w-actions{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;}
.op{background:none;border:1px solid rgba(144,202,249,.4);color:#90caf9;cursor:pointer;border-radius:7px;padding:4px 10px;font-size:11px;font-family:inherit;}
.op.claim{border-color:rgba(66,165,245,.5);color:#90caf9;}
.op.block{border-color:rgba(171,71,188,.5);color:#ce93d8;}
.op.resume{border-color:rgba(255,179,0,.5);color:#ffe082;}
.op.done{border-color:rgba(102,187,106,.5);color:#81c784;}
.op.rework{border-color:rgba(255,213,79,.45);color:#ffe082;}
.op.cancel{border-color:rgba(239,83,80,.4);color:#ef5350;}
.op.stmt-op{border-color:rgba(38,166,154,.55);color:#80cbc4;}
.logbtn{position:absolute;top:12px;right:12px;background:none;border:1px solid rgba(120,160,220,0.25);color:#8ba2c8;border-radius:7px;padding:3px 9px;font-size:10px;cursor:pointer;font-family:inherit;}
.w-logs{margin-top:10px;border-top:1px dashed rgba(120,160,220,0.15);padding-top:8px;display:flex;flex-direction:column;gap:5px;max-height:200px;overflow-y:auto;}
.wlog{display:flex;align-items:baseline;gap:8px;font-size:10px;color:#8ba2c8;}
.wlog em{margin-left:auto;color:#5b6f94;font-style:normal;white-space:nowrap;}
.lg-act{flex:none;font-size:9px;padding:1px 7px;border-radius:5px;background:#16263f;color:#90caf9;border:1px solid rgba(144,202,249,.25);}
.lg-act.escalated,.lg-act.rework{color:#ffab91;border-color:rgba(255,138,101,.35);}
.lg-act.done{color:#81c784;border-color:rgba(102,187,106,.35);}
.lg-act.blocked,.lg-act.cancelled{color:#ce93d8;border-color:rgba(171,71,188,.35);}
</style>
