// 页面交互：时区档案与换算台两块都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  zones: [],
  counts: { total: 0, dstCount: 0, noDstCount: 0 },
  editingId: '',
  lastConvert: null,
  schemes: [],
  results: [],
  pendingDeleteId: '',
};

const MONTHS = [
  ['1', '一月'], ['2', '二月'], ['3', '三月'], ['4', '四月'], ['5', '五月'], ['6', '六月'],
  ['7', '七月'], ['8', '八月'], ['9', '九月'], ['10', '十月'], ['11', '十一月'], ['12', '十二月'],
];
const WEEKS = [['1', '第一个'], ['2', '第二个'], ['3', '第三个'], ['4', '第四个'], ['last', '最后一个']];
const WEEKDAYS = [['0', '周日'], ['1', '周一'], ['2', '周二'], ['3', '周三'], ['4', '周四'], ['5', '周五'], ['6', '周六']];

const el = (id) => document.getElementById(id);

// 统一的请求入口：出错时把服务端给的错误码、说明与出错位置一起抛出去
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
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(value) {
  if (!value) return '';
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
  renderConvertZoneOptions();
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
      <td class="actions">
        <button type="button" class="link" data-zone-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link" data-zone-refs="${escapeHtml(item.id)}">引用<span class="ref-count">${item.referenceCount || 0}</span></button>
        <button type="button" class="link danger" data-zone-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`).join('');
  el('zone-empty').classList.toggle('hidden', state.zones.length > 0);
}

function renderConvertZoneOptions() {
  const select = el('convert-zone');
  const current = select.value;
  select.innerHTML = state.zones
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}　${escapeHtml(item.displayName)}</option>`)
    .join('');
  if (state.zones.some((item) => item.id === current)) select.value = current;
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

// ---------- 换算方案 ----------

async function loadSchemes() {
  const payload = await request('/api/schemes');
  state.schemes = payload.schemes || [];
  renderSchemes();
}

function renderSchemes() {
  el('scheme-counts').textContent = `共保存 ${state.schemes.length} 条换算方案`;
  const body = el('scheme-body');
  body.innerHTML = state.schemes.map((item) => `<tr>
      <td>${escapeHtml(item.name)}</td>
      <td class="mono">${escapeHtml(item.date)}</td>
      <td class="mono">${escapeHtml(item.time)}</td>
      <td>${escapeHtml(item.zoneName || '（来源档案已不存在）')}　<span class="ink-soft">${escapeHtml(item.zoneDisplayName || '')}</span></td>
      <td>${item.resultCount}</td>
      <td class="actions">
        <button type="button" class="link" data-scheme-run="${escapeHtml(item.id)}">执行并存结果</button>
        <button type="button" class="link danger" data-scheme-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`).join('');
  el('scheme-empty').classList.toggle('hidden', state.schemes.length > 0);
}

async function saveCurrentAsScheme() {
  clearNotice();
  const name = window.prompt('给这条换算方案起个名字');
  if (name === null) return;
  const payload = {
    name,
    date: el('convert-date').value,
    time: el('convert-time').value,
    zoneId: el('convert-zone').value,
  };
  try {
    await request('/api/schemes', { method: 'POST', body: JSON.stringify(payload) });
    notify('换算方案已保存', 'ok');
    await loadSchemes();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

async function runSchemeById(id) {
  clearNotice();
  try {
    const result = await request(`/api/schemes/${encodeURIComponent(id)}/run`, { method: 'POST' });
    notify(`方案「${result.schemeName}」已执行，结果已留存`, 'ok');
    await loadSchemes();
    await loadResults();
    openResultModal(result.id).catch((err) => notify(err.message, 'error'));
  } catch (err) {
    notify(err.message, 'error');
  }
}

async function deleteSchemeById(id) {
  clearNotice();
  try {
    const out = await request(`/api/schemes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    notify(`方案已删除，同时清掉 ${out.removedResults} 条由它执行的结果`, 'ok');
    await loadSchemes();
    await loadResults();
  } catch (err) {
    notify(err.message, 'error');
  }
}

// ---------- 换算结果 ----------

async function loadResults() {
  const payload = await request('/api/results');
  state.results = payload.results || [];
  renderResults();
}

function renderResults() {
  el('result-counts').textContent = `共留存 ${state.results.length} 条换算结果`;
  const body = el('result-body');
  body.innerHTML = state.results.map((item) => `<tr>
      <td>${escapeHtml(item.schemeName || '（方案已删除）')}</td>
      <td class="mono">${escapeHtml(item.date)} ${escapeHtml(item.time)}</td>
      <td>${escapeHtml(item.sourceName)}　<span class="ink-soft">${escapeHtml(item.sourceDisplayName)}</span></td>
      <td>${item.rowCount}</td>
      <td>${item.crossDayCount}</td>
      <td class="mono">${escapeHtml(formatTime(item.createdAt))}</td>
      <td class="actions">
        <button type="button" class="link" data-result-view="${escapeHtml(item.id)}">查看明细</button>
        <button type="button" class="link danger" data-result-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`).join('');
  el('result-empty').classList.toggle('hidden', state.results.length > 0);
}

async function openResultModal(id) {
  const result = await request(`/api/results/${encodeURIComponent(id)}`);
  el('result-modal-title').textContent = `结果明细：${result.schemeName || '（方案已删除）'}`;
  el('result-modal-body').innerHTML = `
    <p class="counts">来源 ${escapeHtml(result.sourceName)}（${escapeHtml(result.sourceDisplayName)}）的
      ${escapeHtml(result.date)} ${escapeHtml(result.time)}，基准时刻 ${escapeHtml(result.baseUtcTime)}，
      共 ${result.rowCount} 条明细，与来源不同天 ${result.crossDayCount} 条</p>
    <div class="table-wrap">
      <table class="grid">
        <thead><tr>
          <th>时区</th><th>当地日期</th><th>当地时刻</th><th>星期</th><th>与来源同天</th><th>偏移</th><th>与来源相差</th>
        </tr></thead>
        <tbody>
          ${result.rows.map((row) => `<tr class="${row.isSource ? 'source-row' : ''}">
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
  showModal('result-modal');
}

async function deleteResultById(id) {
  clearNotice();
  try {
    await request(`/api/results/${encodeURIComponent(id)}`, { method: 'DELETE' });
    notify('换算结果已删除', 'ok');
    await loadResults();
    await loadSchemes();
  } catch (err) {
    notify(err.message, 'error');
  }
}

// ---------- 引用查看与删除确认 ----------

function showModal(id) {
  el(id).classList.remove('hidden');
}

function hideModal(id) {
  el(id).classList.add('hidden');
}

function refsSection(title, list, renderRow, emptyText) {
  const head = `<div class="refs-section">
    <h4>${escapeHtml(title)}<span class="ref-badge">${list.length}</span></h4>`;
  if (!list.length) return `${head}<p class="ink-soft refs-empty">${escapeHtml(emptyText)}</p></div>`;
  return `${head}<ul class="refs-list">${list.map(renderRow).join('')}</ul></div>`;
}

function renderRefsBody(refs) {
  const schemeRows = refsSection(
    '被换算方案引用（作为来源时区）',
    refs.schemeRefs,
    (item) => `<li><strong>${escapeHtml(item.name)}</strong><span class="ink-soft">${escapeHtml(item.date)} ${escapeHtml(item.time)}</span></li>`,
    '没有换算方案把它选作来源时区',
  );
  const sourceRows = refsSection(
    '被换算结果引用（作为来源时区）',
    refs.resultSourceRefs,
    (item) => `<li><strong>${escapeHtml(item.schemeName || '（方案已删除）')}</strong><span class="ink-soft">执行于 ${escapeHtml(formatTime(item.createdAt))}</span></li>`,
    '没有换算结果以它为来源时区',
  );
  const rowRefs = refsSection(
    '出现在换算结果的明细里',
    refs.resultRowRefs,
    (item) => `<li><strong>${escapeHtml(item.schemeName || '（方案已删除）')}</strong><span class="ink-soft">当地 ${escapeHtml(item.localDate)} ${escapeHtml(item.localTime)}，执行于 ${escapeHtml(formatTime(item.createdAt))}</span></li>`,
    '没有换算结果的明细行用到它',
  );
  return `
    <p class="counts">共 <strong>${refs.counts.totalCount}</strong> 处引用：
      换算方案 ${refs.counts.schemeCount} 处、作为结果来源 ${refs.counts.resultSourceCount} 处、结果明细 ${refs.counts.resultRowCount} 处。
      三类条数相加与总条数一致。</p>
    ${schemeRows}${sourceRows}${rowRefs}`;
}

async function openRefsModal(id) {
  const refs = await request(`/api/zones/${encodeURIComponent(id)}/references`);
  el('refs-title').textContent = `引用情况：${refs.zone.name}（${refs.zone.displayName}）`;
  el('refs-body').innerHTML = renderRefsBody(refs);
  showModal('refs-modal');
}

function zoneOptions(allZones, excludeId, selectedId) {
  return allZones
    .filter((item) => item.id !== excludeId)
    .map((item) => `<option value="${escapeHtml(item.id)}"${item.id === selectedId ? ' selected' : ''}>${escapeHtml(item.name)}　${escapeHtml(item.displayName)}</option>`)
    .join('');
}

async function openDeleteModal(id) {
  const [refs, allPayload] = await Promise.all([
    request(`/api/zones/${encodeURIComponent(id)}/references`),
    request('/api/zones'),
  ]);
  const allZones = allPayload.zones || [];
  state.pendingDeleteId = id;
  el('delete-title').textContent = `删除档案：${refs.zone.name}（${refs.zone.displayName}）`;

  if (refs.counts.totalCount === 0) {
    el('delete-body').innerHTML = `
      <p>这条档案目前没有被任何换算方案或结果引用，可以直接删除。</p>
      <div class="form-actions">
        <button type="button" class="danger-btn" id="delete-confirm-plain">确认删除</button>
      </div>`;
  } else {
    el('delete-body').innerHTML = `
      ${renderRefsBody(refs)}
      <div class="delete-options">
        <div class="delete-option">
          <label class="option-head"><input type="radio" name="delete-strategy" value="reassign" checked>
            <strong>把引用改到别的档案上</strong></label>
          <p class="ink-soft">方案改选新来源；以它为来源的历史结果按同一基准时刻用新档案重算；结果明细里它那一行换成新档案。</p>
          <label>改挂到
            <select id="delete-target">${zoneOptions(allZones, id, '')}</select>
          </label>
        </div>
        <div class="delete-option">
          <label class="option-head"><input type="radio" name="delete-strategy" value="cascade">
            <strong>连同引用一起清掉</strong></label>
          <p class="ink-soft">引用它的方案整条删除；以它为来源的结果整条删除；其它结果只移除它那一行明细。</p>
          <label class="check"><input type="checkbox" id="delete-confirm-cascade"> 我已了解上述引用会被一并清除，确认删除</label>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="danger-btn" id="delete-confirm-refs">按所选方式删除</button>
      </div>`;
  }
  showModal('delete-modal');
}

// 弹窗里的确认按钮是动态生成的，用点击委托处理
async function submitDelete() {
  const id = state.pendingDeleteId;
  if (!id) return;
  const plain = el('delete-confirm-plain');
  if (plain) {
    await doDelete(id, {});
    return;
  }
  const strategyRadio = document.querySelector('input[name="delete-strategy"]:checked');
  const strategy = strategyRadio ? strategyRadio.value : '';
  if (strategy === 'reassign') {
    const targetId = el('delete-target').value;
    if (!targetId) { notify('请选择把引用改挂到哪一条档案', 'error'); return; }
    await doDelete(id, { strategy: 'reassign', targetId });
  } else if (strategy === 'cascade') {
    if (!el('delete-confirm-cascade').checked) {
      notify('请先勾选确认，才会连同引用一起清掉', 'error');
      return;
    }
    await doDelete(id, { strategy: 'cascade', confirm: true });
  } else {
    notify('请选择一种引用处理方式', 'error');
  }
}

async function doDelete(id, body) {
  clearNotice();
  try {
    if (body.strategy) {
      const out = await request(`/api/zones/${encodeURIComponent(id)}/delete`, { method: 'POST', body: JSON.stringify(body) });
      if (body.strategy === 'reassign') {
        notify(`档案已删除：${out.counts.reassignedSchemes} 条方案已改挂，${out.counts.recomputedResults} 条结果按同一刻重算`, 'ok');
      } else {
        notify(`档案已删除：清掉 ${out.counts.removedSchemes} 条方案、${out.counts.removedResults} 条结果，并从 ${out.counts.trimmedResults} 条结果里移除明细`, 'ok');
      }
    } else {
      await request(`/api/zones/${encodeURIComponent(id)}`, { method: 'DELETE' });
      notify('时区档案已删除', 'ok');
    }
    state.pendingDeleteId = '';
    if (state.editingId === id) closeZoneForm();
    hideModal('delete-modal');
    await loadZones();
    await loadSchemes();
    await loadResults();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

// 列表上的操作用事件委托统一处理，列表重绘之后不需要重新绑定
document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (!node) return;

  if (node.dataset.zoneEdit) {
    clearNotice();
    const found = state.zones.find((item) => item.id === node.dataset.zoneEdit);
    if (found) openZoneForm(found);
    return;
  }

  if (node.dataset.zoneRefs) {
    clearNotice();
    openRefsModal(node.dataset.zoneRefs).catch((err) => notify(err.message, 'error'));
    return;
  }

  if (node.dataset.zoneDelete) {
    clearNotice();
    openDeleteModal(node.dataset.zoneDelete).catch((err) => notify(err.message, 'error'));
    return;
  }

  if (node.dataset.schemeRun) {
    runSchemeById(node.dataset.schemeRun).catch((err) => notify(err.message, 'error'));
    return;
  }

  if (node.dataset.schemeDelete) {
    const id = node.dataset.schemeDelete;
    const found = state.schemes.find((item) => item.id === id);
    if (!window.confirm(`确定删除方案「${found ? found.name : ''}」吗？由它执行出来的结果也会一并删掉。`)) return;
    deleteSchemeById(id).catch((err) => notify(err.message, 'error'));
    return;
  }

  if (node.dataset.resultView) {
    openResultModal(node.dataset.resultView).catch((err) => notify(err.message, 'error'));
    return;
  }

  if (node.dataset.resultDelete) {
    if (!window.confirm('确定删除这条换算结果吗？')) return;
    deleteResultById(node.dataset.resultDelete).catch((err) => notify(err.message, 'error'));
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
el('scheme-save').addEventListener('click', saveCurrentAsScheme);
el('scheme-refresh').addEventListener('click', () => {
  clearNotice();
  loadSchemes().catch((err) => notify(err.message, 'error'));
});
el('result-refresh').addEventListener('click', () => {
  clearNotice();
  loadResults().catch((err) => notify(err.message, 'error'));
});
el('refs-close').addEventListener('click', () => hideModal('refs-modal'));
el('delete-close').addEventListener('click', () => { state.pendingDeleteId = ''; hideModal('delete-modal'); });
el('delete-body').addEventListener('click', (event) => {
  if (event.target.closest('#delete-confirm-plain, #delete-confirm-refs')) {
    submitDelete().catch((err) => notify(err.message, 'error'));
  }
});
el('result-modal-close').addEventListener('click', () => hideModal('result-modal'));
// 点遮罩空白处也关掉弹窗
document.querySelectorAll('.modal-mask').forEach((mask) => {
  mask.addEventListener('click', (event) => {
    if (event.target === mask) mask.classList.add('hidden');
  });
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
loadZones()
  .then(() => Promise.all([
    loadSchemes().catch((err) => notify(err.message, 'error')),
    loadResults().catch((err) => notify(err.message, 'error')),
  ]))
  .catch((err) => notify(err.message, 'error'));
