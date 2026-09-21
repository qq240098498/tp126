// 页面交互：时区档案、换算台与换算方案都从服务端拉取
// 删除档案前必须先看清引用：可以改派到别的档案，或者确认连同引用一起清掉，没确认不允许删

const state = {
  zones: [],
  allZones: [],
  counts: { total: 0, dstCount: 0, noDstCount: 0 },
  plans: [],
  editingId: '',
  lastConvert: null,
  deleteCtx: null,
};

const MONTHS = [
  ['1', '一月'], ['2', '二月'], ['3', '三月'], ['4', '四月'], ['5', '五月'], ['6', '六月'],
  ['7', '七月'], ['8', '八月'], ['9', '九月'], ['10', '十月'], ['11', '十一月'], ['12', '十二月'],
];
const WEEKS = [['1', '第一个'], ['2', '第二个'], ['3', '第三个'], ['4', '第四个'], ['last', '最后一个']];
const WEEKDAYS = [['0', '周日'], ['1', '周一'], ['2', '周二'], ['3', '周三'], ['4', '周四'], ['5', '周五'], ['6', '周六']];

const el = (id) => document.getElementById(id);

// 统一的请求入口：出错时把服务端给的错误码、说明、出错位置与引用明细一起抛出去
async function request(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }
  if (!res.ok) {
    const error = (payload && payload.error) || {};
    const failure = new Error(error.message || `请求失败（状态码 ${res.status}）`);
    failure.code = error.code || '';
    failure.field = error.field || '';
    failure.details = error.details || null;
    throw failure;
  }
  return payload;
}

function notify(message, kind) {
  const box = el('notice');
  box.textContent = message;
  box.className = `notice ${kind === 'ok' ? 'ok' : 'error'}`;
}

function clearNotice() {
  const box = el('notice');
  box.className = 'notice hidden';
  box.textContent = '';
}

function clearFieldMarks() {
  document.querySelectorAll('.invalid').forEach((node) => node.classList.remove('invalid'));
}

function markField(field) {
  if (!field) return;
  const target = document.querySelector(`[data-field="${field}"]`);
  if (!target) return;
  target.classList.add('invalid');
  const input = target.matches('input, select, textarea') ? target : target.querySelector('input, select, textarea');
  if (input) input.focus();
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const MONTH_LABEL = Object.fromEntries(MONTHS);
const WEEK_LABEL = Object.fromEntries(WEEKS);
const WEEKDAY_LABEL = Object.fromEntries(WEEKDAYS);

function ruleText(part) {
  if (!part) return '—';
  const hour = String(part.hour).padStart(2, '0');
  const minute = String(part.minute).padStart(2, '0');
  return `${MONTH_LABEL[String(part.month)] || part.month}${WEEK_LABEL[part.week] || part.week}${WEEKDAY_LABEL[String(part.weekday)] || part.weekday} ${hour}:${minute}`;
}

const OPERATOR_KEY = 'zone-clock-operator';

function currentOperator() {
  return el('operator').value.trim();
}

function restoreOperator() {
  el('operator').value = window.localStorage.getItem(OPERATOR_KEY) || '';
}

async function loadHealth() {
  try {
    await request('/api/health');
    el('health').textContent = '服务正常';
    el('health').className = 'health ok';
  } catch (err) {
    el('health').textContent = '服务连不上';
    el('health').className = 'health bad';
  }
}

function fillOptions() {
  const monthOptions = MONTHS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  const weekOptions = WEEKS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  const weekdayOptions = WEEKDAYS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  ['zone-start-month', 'zone-end-month'].forEach((id) => { el(id).innerHTML = monthOptions; });
  ['zone-start-week', 'zone-end-week'].forEach((id) => { el(id).innerHTML = weekOptions; });
  ['zone-start-weekday', 'zone-end-weekday'].forEach((id) => { el(id).innerHTML = weekdayOptions; });
}

// 不带筛选地拉一遍全部档案，给换算台来源下拉与删除改派下拉用
async function loadAllZones() {
  const payload = await request('/api/zones');
  state.allZones = payload.zones || [];
  renderConvertZoneOptions();
}

async function loadZones() {
  const params = new URLSearchParams();
  const dst = el('zone-filter-dst').value;
  const keyword = el('zone-filter-keyword').value.trim();
  if (dst) params.set('dst', dst);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/zones${query ? `?${query}` : ''}`);
  state.zones = payload.zones || [];
  state.counts = { total: payload.total || 0, dstCount: payload.dstCount || 0, noDstCount: payload.noDstCount || 0 };
  renderZones();
  await loadAllZones();
}

function renderZones() {
  el('zone-counts').textContent = `共登记 ${state.counts.total} 条档案，其中实行夏令时 ${state.counts.dstCount} 条，不实行 ${state.counts.noDstCount} 条；当前筛选出 ${state.zones.length} 条`;
  const body = el('zone-body');
  body.innerHTML = state.zones.map((item) => `<tr>
      <td class="mono">${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.displayName)}</td>
      <td class="mono">${escapeHtml(item.offsetText)}</td>
      <td>${item.usesDst ? '<span class="tag on">实行</span>' : '<span class="tag off">不实行</span>'}</td>
      <td class="mono">${item.dstOffsetText ? escapeHtml(item.dstOffsetText) : '—'}</td>
      <td class="rule-cell">${item.usesDst ? `${escapeHtml(ruleText(item.dstStart))} 起，${escapeHtml(ruleText(item.dstEnd))} 止` : '—'}</td>
      <td class="mono">${escapeHtml(item.yearRangeText)}</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td>
        <span class="ref-count ${item.referenceCount === 0 ? 'zero' : ''}">${item.referenceCount}</span>
        <button type="button" class="link" data-zone-refs="${escapeHtml(item.id)}">查看引用</button>
      </td>
      <td class="actions">
        <button type="button" class="link" data-zone-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-zone-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`).join('');
  el('zone-empty').classList.toggle('hidden', state.zones.length > 0);
}

function renderConvertZoneOptions() {
  const select = el('convert-zone');
  const current = select.value;
  select.innerHTML = state.allZones
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}　${escapeHtml(item.displayName)}</option>`)
    .join('');
  if (state.allZones.some((item) => item.id === current)) select.value = current;
}

function openZoneForm(zone) {
  state.editingId = zone ? zone.id : '';
  el('zone-form-title').textContent = zone ? `编辑档案：${zone.name}` : '新建档案';
  el('zone-name').value = zone ? zone.name : '';
  el('zone-display').value = zone ? zone.displayName : '';
  el('zone-offset').value = zone ? String(zone.offsetMinutes) : '';
  el('zone-uses-dst').checked = zone ? zone.usesDst : false;
  el('zone-dst-offset').value = zone && zone.dstOffsetMinutes !== null ? String(zone.dstOffsetMinutes) : '';
  const start = zone && zone.dstStart ? zone.dstStart : { month: 3, week: '2', weekday: 0, hour: 2, minute: 0 };
  const end = zone && zone.dstEnd ? zone.dstEnd : { month: 11, week: '1', weekday: 0, hour: 2, minute: 0 };
  el('zone-start-month').value = String(start.month);
  el('zone-start-week').value = start.week;
  el('zone-start-weekday').value = String(start.weekday);
  el('zone-start-hour').value = String(start.hour);
  el('zone-start-minute').value = String(start.minute);
  el('zone-end-month').value = String(end.month);
  el('zone-end-week').value = end.week;
  el('zone-end-weekday').value = String(end.weekday);
  el('zone-end-hour').value = String(end.hour);
  el('zone-end-minute').value = String(end.minute);
  el('zone-from-year').value = zone ? String(zone.fromYear) : '';
  el('zone-to-year').value = zone && zone.toYear !== null ? String(zone.toYear) : '';
  el('zone-note').value = zone ? zone.note : '';
  el('zone-form').classList.remove('hidden');
  el('zone-name').focus();
}

function closeZoneForm() {
  state.editingId = '';
  el('zone-form').classList.add('hidden');
  clearFieldMarks();
}

async function submitZone(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    name: el('zone-name').value,
    displayName: el('zone-display').value,
    offsetMinutes: el('zone-offset').value,
    usesDst: el('zone-uses-dst').checked,
    dstOffsetMinutes: el('zone-dst-offset').value === '' ? null : el('zone-dst-offset').value,
    dstStart: {
      month: el('zone-start-month').value,
      week: el('zone-start-week').value,
      weekday: el('zone-start-weekday').value,
      hour: el('zone-start-hour').value,
      minute: el('zone-start-minute').value,
    },
    dstEnd: {
      month: el('zone-end-month').value,
      week: el('zone-end-week').value,
      weekday: el('zone-end-weekday').value,
      hour: el('zone-end-hour').value,
      minute: el('zone-end-minute').value,
    },
    fromYear: el('zone-from-year').value,
    toYear: el('zone-to-year').value === '' ? null : el('zone-to-year').value,
    note: el('zone-note').value,
  };
  if (!payload.usesDst) {
    payload.dstOffsetMinutes = null;
    payload.dstStart = null;
    payload.dstEnd = null;
  }
  const editing = state.editingId;
  try {
    if (editing) {
      await request(`/api/zones/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('时区档案已保存', 'ok');
    } else {
      await request('/api/zones', { method: 'POST', body: JSON.stringify(payload) });
      notify('时区档案已新增', 'ok');
    }
    closeZoneForm();
    await loadZones();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

async function runConvert() {
  clearNotice();
  const payload = {
    date: el('convert-date').value,
    time: el('convert-time').value,
    zoneId: el('convert-zone').value,
  };
  try {
    const result = await request('/api/convert', { method: 'POST', body: JSON.stringify(payload) });
    state.lastConvert = result;
    renderConvert(result);
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

function renderConvert(result) {
  el('convert-meta').textContent = `来源 ${result.input.zoneName}（${result.input.zoneDisplayName}，${result.input.offsetText}）的 ${result.input.date} ${result.input.time}，换算时刻 ${formatTime(result.convertedAt)}；参与换算的档案 ${result.zonesInScope} 条，与来源不同天的有 ${result.crossDayCount} 条，最大时差 ${Math.floor(result.maxDiffMinutes / 60)} 小时 ${result.maxDiffMinutes % 60} 分`;
  const body = el('convert-body');
  body.innerHTML = result.results.map((item) => `<tr class="${item.isSource ? 'source-row' : ''}">
      <td class="mono">${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.displayName)}</td>
      <td class="mono">${escapeHtml(item.localDate)}</td>
      <td class="mono">${escapeHtml(item.localTime)}</td>
      <td>${escapeHtml(item.weekday)}</td>
      <td><span class="tag ${item.dayOffset === 0 ? 'off' : 'warn'}">${escapeHtml(item.dayOffsetText)}</span></td>
      <td class="mono">${escapeHtml(item.offsetText)}</td>
      <td>${escapeHtml(item.diffText)}</td>
      <td>${item.usesDst ? '有规则' : '—'}</td>
    </tr>`).join('');
  el('convert-empty').classList.toggle('hidden', result.results.length > 0);
}

// 把当前换算台的输入存成方案，服务端会同时跑出第一份结果
async function saveAsPlan() {
  clearNotice();
  const payload = {
    title: el('convert-plan-title').value.trim(),
    date: el('convert-date').value,
    time: el('convert-time').value,
    zoneId: el('convert-zone').value,
  };
  try {
    const plan = await request('/api/plans', { method: 'POST', body: JSON.stringify(payload) });
    el('convert-plan-title').value = '';
    notify(`换算方案“${plan.title}”已保存并执行一遍`, 'ok');
    await loadPlans();
    await runConvert();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

// ---------- 换算方案 ----------

async function loadPlans() {
  try {
    const payload = await request('/api/plans');
    state.plans = payload.plans || [];
    renderPlans();
  } catch (err) {
    notify(err.message, 'error');
  }
}

function renderPlans() {
  el('plan-counts').textContent = `共保存 ${state.plans.length} 条换算方案`;
  const body = el('plan-body');
  body.innerHTML = state.plans.map((plan) => `<tr>
      <td>${escapeHtml(plan.title)}</td>
      <td class="mono">${escapeHtml(plan.date)}</td>
      <td class="mono">${escapeHtml(plan.time)}</td>
      <td class="mono">${escapeHtml(plan.sourceName)}　<span class="ref-sub">${escapeHtml(plan.sourceDisplayName)}</span></td>
      <td>${plan.runCount} 次</td>
      <td class="mono">${escapeHtml(formatTime(plan.lastRunAt))}</td>
      <td class="actions">
        <button type="button" class="link" data-plan-view="${escapeHtml(plan.id)}">详情</button>
        <button type="button" class="link" data-plan-run="${escapeHtml(plan.id)}">再执行一次</button>
        <button type="button" class="link danger" data-plan-delete="${escapeHtml(plan.id)}">删除</button>
      </td>
    </tr>`).join('');
  el('plan-empty').classList.toggle('hidden', state.plans.length > 0);
}

function renderRunTable(rows) {
  return `<div class="table-wrap">
    <table class="grid run-grid">
      <thead><tr>
        <th>时区</th><th>当地日期</th><th>当地时刻</th><th>星期</th><th>与来源同天</th><th>偏移</th><th>与来源相差</th>
      </tr></thead>
      <tbody>
        ${rows.map((row) => `<tr class="${row.isSource ? 'source-row' : ''}">
          <td class="mono">${escapeHtml(row.name)}</td>
          <td class="mono">${escapeHtml(row.localDate)}</td>
          <td class="mono">${escapeHtml(row.localTime)}</td>
          <td>${escapeHtml(row.weekday)}</td>
          <td><span class="tag ${row.dayOffset === 0 ? 'off' : 'warn'}">${escapeHtml(row.dayOffsetText)}</span></td>
          <td class="mono">${escapeHtml(row.offsetText)}</td>
          <td>${escapeHtml(row.diffText)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

async function openPlanDetail(planId) {
  clearNotice();
  try {
    const plan = await request(`/api/plans/${encodeURIComponent(planId)}`);
    el('plan-detail-title').textContent = `方案详情：${plan.title}`;
    el('plan-detail-body').innerHTML = `
      <p class="counts">
        来源时区 <strong>${escapeHtml(plan.sourceName)}（${escapeHtml(plan.sourceDisplayName)}）</strong>，
        输入时刻 ${escapeHtml(plan.date)} ${escapeHtml(plan.time)}，
        共执行 ${plan.runs.length} 次，最近一次 ${escapeHtml(formatTime(plan.lastRunAt))}
      </p>
      <div class="plan-run-list">
        ${plan.runs.map((run, index) => `<div class="plan-run-card">
          <div class="run-head">
            <span>第 ${plan.runs.length - index} 次结果 · 来源 ${escapeHtml(run.sourceName)}（${escapeHtml(run.sourceDisplayName)}）</span>
            <span>${escapeHtml(formatTime(run.ranAt))}</span>
          </div>
          ${renderRunTable(run.rows)}
        </div>`).join('')}
      </div>`;
    openMask('plan-mask');
  } catch (err) {
    notify(err.message, 'error');
  }
}

async function rerunPlan(planId, button) {
  clearNotice();
  if (button) button.disabled = true;
  try {
    const plan = await request(`/api/plans/${encodeURIComponent(planId)}/run`, { method: 'POST' });
    notify(`方案“${plan.title}”已重新执行`, 'ok');
    await loadPlans();
    if (!el('plan-mask').classList.contains('hidden')) await openPlanDetail(planId);
  } catch (err) {
    notify(err.message, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

async function removePlan(planId) {
  clearNotice();
  const plan = state.plans.find((item) => item.id === planId);
  const name = plan ? plan.title : '';
  if (!window.confirm(`确定删除方案“${name}”吗？方案名下的换算结果会一起删除。`)) return;
  try {
    await request(`/api/plans/${encodeURIComponent(planId)}`, { method: 'DELETE' });
    notify('换算方案及其结果已删除', 'ok');
    await loadPlans();
  } catch (err) {
    notify(err.message, 'error');
  }
}

// ---------- 弹层 ----------

function openMask(id) {
  el(id).classList.remove('hidden');
}

function closeMask(id) {
  el(id).classList.add('hidden');
}

// Esc 关掉当前打开的弹层
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  document.querySelectorAll('.modal-mask:not(.hidden)').forEach((mask) => {
    closeMask(mask.id);
    if (mask.id === 'delete-mask') state.deleteCtx = null;
  });
});

// 把引用情况渲染成三块清单；各块条数与清单条数一致，合计单独标出
function refsHtml(refs) {
  const section = (title, list, empty, renderItem) => `<div class="ref-section">
    <h4>${title}<span class="count-badge">${list.length} 条</span></h4>
    ${list.length === 0 ? `<p class="ref-empty">${empty}</p>` : `<ul class="ref-list">${list.map(renderItem).join('')}</ul>`}
  </div>`;

  return [
    section('被换算方案用作来源时区', refs.plans, '没有换算方案引用它', (plan) => `
      <li><span>${escapeHtml(plan.title)}</span><span class="ref-sub">${escapeHtml(plan.date)} ${escapeHtml(plan.time)} · 建於 ${escapeHtml(formatTime(plan.createdAt))}</span></li>`),
    section('被换算结果用作来源时区', refs.runs, '没有换算结果以它为来源', (run) => `
      <li><span>${escapeHtml(run.planTitle)}</span><span class="ref-sub">执行于 ${escapeHtml(formatTime(run.ranAt))}</span></li>`),
    section('出现在换算结果明细里', refs.resultRows, '没有结果明细包含它', (row) => `
      <li><span>${escapeHtml(row.planTitle)} · ${row.role === 'source' ? '来源行' : '换算目标行'}</span>
        <span class="ref-sub">${escapeHtml(formatTime(row.ranAt))} · 当地 ${escapeHtml(row.localDate)} ${escapeHtml(row.localTime)}</span></li>`),
    `<p class="ref-total">引用合计 <strong>${refs.total}</strong> 处 = 方案 ${refs.planCount} + 结果来源 ${refs.runCount} + 结果明细 ${refs.resultRowCount}</p>`,
  ].join('');
}

async function openZoneRefs(zoneId) {
  clearNotice();
  try {
    const refs = await request(`/api/zones/${encodeURIComponent(zoneId)}/references`);
    el('refs-title').textContent = `引用情况：${refs.zone.name}（${refs.zone.displayName}）`;
    el('refs-body').innerHTML = refsHtml(refs);
    openMask('refs-mask');
  } catch (err) {
    notify(err.message, 'error');
  }
}

// ---------- 删除档案 ----------

async function openDeleteZone(zoneId) {
  clearNotice();
  const zone = state.allZones.find((item) => item.id === zoneId);
  if (!zone) return;
  let refs;
  try {
    refs = await request(`/api/zones/${encodeURIComponent(zoneId)}/references`);
  } catch (err) {
    notify(err.message, 'error');
    return;
  }
  state.deleteCtx = { zoneId, zone, refs, mode: '' };
  renderDeleteModal();
  openMask('delete-mask');
}

function renderDeleteModal() {
  const { zone, refs } = state.deleteCtx;
  const targets = state.allZones.filter((item) => item.id !== zone.id);
  const targetOptions = targets
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}　${escapeHtml(item.displayName)}（${escapeHtml(item.offsetText)}）</option>`)
    .join('');

  const refsBlock = refs.total === 0
    ? '<p class="ref-empty">没有任何换算方案或结果引用这条档案，可以直接删除。</p>'
    : refsHtml(refs);

  el('delete-body').innerHTML = `
    <p class="delete-warning">删除后不可恢复。档案 <strong>${escapeHtml(zone.name)}（${escapeHtml(zone.displayName)}）</strong>的引用必须先处理，没有确认不会删除。</p>
    ${refsBlock}
    ${refs.total === 0 ? '' : `
    <div class="delete-options">
      <div class="delete-option" data-opt="reassign">
        <span class="opt-title"><label class="opt-radio"><input type="radio" name="delete-mode" value="reassign"> 先把引用改到别的档案上</label></span>
        <span class="opt-desc">${refs.planCount} 条方案与 ${refs.runCount} 次结果的来源时区会改到所选档案；这些结果里被删档案的明细行会移除，其余结果保留。</span>
        <select id="delete-target">
          <option value="">选择接收引用的档案…</option>
          ${targetOptions}
        </select>
      </div>
      <div class="delete-option" data-opt="purge">
        <span class="opt-title"><label class="opt-radio"><input type="radio" name="delete-mode" value="purge"> 确认之后连同引用一起清掉</label></span>
        <span class="opt-desc">删除以它为来源的 ${refs.planCount} 条方案和 ${refs.runCount} 次结果，其它结果里关于它的 ${refs.resultRowCount} 条明细行也会一并移除。</span>
      </div>
    </div>`}
    <p class="confirm-line">
      <input type="checkbox" id="delete-ack">
      <span>${refs.total === 0 ? '我确认删除这条档案' : '我已看清上面的引用清单，并确认按所选方式处理'}</span>
    </p>
    <div class="modal-actions">
      <button type="button" class="ghost" data-close="delete-mask">取消</button>
      <button type="button" class="danger-solid" id="delete-confirm" disabled>${refs.total === 0 ? '确认删除' : '按所选方式删除'}</button>
    </div>`;

  const sync = () => {
    const mode = document.querySelector('input[name="delete-mode"]:checked')?.value || '';
    state.deleteCtx.mode = mode;
    document.querySelectorAll('.delete-option').forEach((node) => node.classList.toggle('selected', node.dataset.opt === mode));
    const ack = el('delete-ack').checked;
    const target = refs.total === 0 ? true : (mode === 'reassign' ? !!el('delete-target').value : mode === 'purge');
    el('delete-confirm').disabled = !(ack && target);
  };
  el('delete-body').querySelectorAll('input[name="delete-mode"]').forEach((radio) => radio.addEventListener('change', sync));
  // 点整张卡片也能选中，不用必须点中单选圆点
  el('delete-body').querySelectorAll('.delete-option').forEach((card) => {
    card.addEventListener('click', () => {
      const radio = card.querySelector('input[name="delete-mode"]');
      if (radio && !radio.checked) { radio.checked = true; sync(); }
    });
  });
  el('delete-ack').addEventListener('change', sync);
  const targetSelect = el('delete-target');
  if (targetSelect) targetSelect.addEventListener('change', sync);
  el('delete-confirm').addEventListener('click', confirmDeleteZone);
}

async function confirmDeleteZone() {
  const ctx = state.deleteCtx;
  if (!ctx) return;
  const body = { confirm: true };
  if (ctx.refs.total > 0) {
    body.mode = ctx.mode;
    if (ctx.mode === 'reassign') body.targetZoneId = el('delete-target').value;
  }
  const button = el('delete-confirm');
  button.disabled = true;
  try {
    await request(`/api/zones/${encodeURIComponent(ctx.zoneId)}`, { method: 'DELETE', body: JSON.stringify(body) });
    closeMask('delete-mask');
    state.deleteCtx = null;
    if (state.editingId === ctx.zoneId) closeZoneForm();
    notify('档案已删除，相关引用已按所选方式处理', 'ok');
    await Promise.all([loadZones(), loadPlans()]);
  } catch (err) {
    // 引用情况在打开弹层后发生变化时，用服务端返回的最新引用重新渲染，不能按旧清单删
    if ((err.code === 'ZONE_HAS_REFERENCES' || err.code === 'DELETE_CONFIRM_REQUIRED') && err.details && err.details.references) {
      ctx.refs = err.details.references;
      renderDeleteModal();
    } else {
      button.disabled = false;
    }
    notify(err.message, 'error');
  }
}

// 列表与弹层上的操作用事件委托统一处理，重绘之后不需要重新绑定
document.addEventListener('click', async (event) => {
  // 点遮罩空白处也关掉弹层
  if (event.target.classList && event.target.classList.contains('modal-mask')) {
    closeMask(event.target.id);
    if (event.target.id === 'delete-mask') state.deleteCtx = null;
    return;
  }

  const closeButton = event.target.closest('[data-close]');
  if (closeButton) {
    closeMask(closeButton.dataset.close);
    if (closeButton.dataset.close === 'delete-mask') state.deleteCtx = null;
    return;
  }

  const node = event.target.closest('button');
  if (!node) return;

  if (node.dataset.zoneEdit) {
    clearNotice();
    const found = state.allZones.find((item) => item.id === node.dataset.zoneEdit);
    if (found) openZoneForm(found);
    return;
  }

  if (node.dataset.zoneRefs) {
    await openZoneRefs(node.dataset.zoneRefs);
    return;
  }

  if (node.dataset.zoneDelete) {
    await openDeleteZone(node.dataset.zoneDelete);
    return;
  }

  if (node.dataset.planView) {
    await openPlanDetail(node.dataset.planView);
    return;
  }

  if (node.dataset.planRun) {
    await rerunPlan(node.dataset.planRun, node);
    return;
  }

  if (node.dataset.planDelete) {
    await removePlan(node.dataset.planDelete);
  }
});

el('zone-form').addEventListener('submit', submitZone);
el('zone-new').addEventListener('click', () => {
  clearNotice();
  openZoneForm(null);
});
el('zone-cancel').addEventListener('click', closeZoneForm);
el('zone-filter-apply').addEventListener('click', () => {
  clearNotice();
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('zone-filter-reset').addEventListener('click', () => {
  el('zone-filter-dst').value = '';
  el('zone-filter-keyword').value = '';
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('zone-refresh').addEventListener('click', () => {
  clearNotice();
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('zone-filter-dst').addEventListener('change', () => {
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('convert-run').addEventListener('click', runConvert);
el('convert-save-plan').addEventListener('click', saveAsPlan);
el('plan-refresh').addEventListener('click', () => {
  clearNotice();
  loadPlans();
});
el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});

// 页面打开时先把档案拉一遍，换算台的来源时区下拉按这份清单填
fillOptions();
restoreOperator();
loadHealth();
const now = new Date();
el('convert-date').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
el('convert-time').value = '09:30';
loadZones().catch((err) => notify(err.message, 'error'));
loadPlans();
