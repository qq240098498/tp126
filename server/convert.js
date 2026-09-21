const crypto = require('crypto');
const { load, save, MAX_PLAN_TITLE_LENGTH, WEEKDAY_NAMES } = require('./store');
const { ApiError, pickText } = require('./errors');
const { offsetText } = require('./zones');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 86400000;

// 每个方案只保留最近这么多次换算结果，更早的自动挤掉
const RUN_HISTORY_LIMIT = 20;

const pad = (num) => String(num).padStart(2, '0');

// 日期要真存在，例如 2026-02-30 这种不能算数
function validateDate(value) {
  const date = pickText(value);
  if (!date) throw new ApiError(400, 'DATE_REQUIRED', '请填写日期', 'date');
  if (!DATE_PATTERN.test(date)) {
    throw new ApiError(400, 'DATE_INVALID', '日期要写成四位年加短横线加两位月日，例如 2026-09-20', 'date');
  }
  const [year, month, day] = date.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new ApiError(400, 'DATE_INVALID', '这个日期不存在，请检查月份与日', 'date');
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new ApiError(400, 'DATE_INVALID', '这个日期不存在，例如二月没有三十号', 'date');
  }
  return { text: date, year, month, day };
}

function validateTime(value) {
  const time = pickText(value);
  if (!time) throw new ApiError(400, 'TIME_REQUIRED', '请填写时刻', 'time');
  if (!TIME_PATTERN.test(time)) {
    throw new ApiError(400, 'TIME_INVALID', '时刻要写成两位小时加冒号加两位分钟，例如 09:30', 'time');
  }
  const [hour, minute] = time.split(':').map(Number);
  return { text: time, hour, minute };
}

function validateTitle(value, fallback) {
  const title = pickText(value);
  const text = title || fallback;
  return text.slice(0, MAX_PLAN_TITLE_LENGTH);
}

// 时差写法：整小时只写小时，带分钟的把分钟也写出来
function diffText(minutes) {
  if (minutes === 0) return '与源时区相同';
  const sign = minutes > 0 ? '早' : '晚';
  const abs = Math.abs(minutes);
  const hour = Math.floor(abs / 60);
  const minute = abs % 60;
  const parts = [];
  if (hour) parts.push(`${hour} 小时`);
  if (minute) parts.push(`${minute} 分`);
  return `比源时区${sign} ${parts.join(' ')}`;
}

function dayOffsetText(dayOffset) {
  if (dayOffset === 0) return '同日';
  if (dayOffset > 0) return `后 ${dayOffset} 天`;
  return `前 ${Math.abs(dayOffset)} 天`;
}

// 取出输入时刻与来源时区，来源档案不在了要明确报错，不允许算出没有出处的结果
function resolveSource(data, zoneIdValue) {
  const zoneId = pickText(zoneIdValue);
  if (!zoneId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择来源时区', 'zoneId');
  const source = data.zones.find((item) => item.id === zoneId);
  if (!source) throw new ApiError(404, 'ZONE_NOT_FOUND', '选中的时区没有登记过或已被删除', 'zoneId');
  return source;
}

// 换算主体（不落盘）：先把输入时刻按来源时区的偏移折算成基准时刻，再逐个时区加上各自的偏移
function compute(data, options) {
  const input = options && typeof options === 'object' ? options : {};
  const date = validateDate(input.date);
  const time = validateTime(input.time);
  const source = resolveSource(data, input.zoneId);

  const baseMs = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  const utcMs = baseMs - source.offsetMinutes * 60000;
  const baseDay = Math.floor(baseMs / DAY_MS);
  const utcDate = new Date(utcMs);

  const results = data.zones.map((zone, sort) => {
    const localMs = utcMs + zone.offsetMinutes * 60000;
    const local = new Date(localMs);
    const dayOffset = Math.floor(localMs / DAY_MS) - baseDay;
    const diffMinutes = zone.offsetMinutes - source.offsetMinutes;
    return {
      zoneId: zone.id,
      name: zone.name,
      displayName: zone.displayName,
      offsetMinutes: zone.offsetMinutes,
      offsetText: offsetText(zone.offsetMinutes),
      localDate: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
      localTime: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
      weekday: WEEKDAY_NAMES[local.getUTCDay()],
      dayOffset,
      dayOffsetText: dayOffsetText(dayOffset),
      diffMinutes,
      diffText: diffText(diffMinutes),
      usesDst: zone.usesDst,
      isSource: zone.id === source.id,
      sort,
    };
  });

  results.sort((a, b) => {
    if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes;
    return a.name < b.name ? -1 : 1;
  });
  // sort 记成展示顺序的序号，落库后再取出仍按偏移顺序排列
  results.forEach((row, index) => { row.sort = index; });

  return {
    input: {
      date: date.text,
      time: time.text,
      zoneId: source.id,
      zoneName: source.name,
      zoneDisplayName: source.displayName,
      offsetText: offsetText(source.offsetMinutes),
      usesDst: source.usesDst,
    },
    standard: {
      date: `${utcDate.getUTCFullYear()}-${pad(utcDate.getUTCMonth() + 1)}-${pad(utcDate.getUTCDate())}`,
      time: `${pad(utcDate.getUTCHours())}:${pad(utcDate.getUTCMinutes())}`,
    },
    zonesInScope: data.zones.length,
    crossDayCount: results.filter((item) => item.dayOffset !== 0).length,
    maxDiffMinutes: results.reduce((acc, item) => Math.max(acc, Math.abs(item.diffMinutes)), 0),
    results,
    convertedAt: new Date().toISOString(),
  };
}

// 临时换算一遍：只返回结果，不留存方案与结果
function convert(options) {
  const data = load();
  const outcome = compute(data, options);
  // 落盘结构里不保留 sort，返回给页面时照旧
  const { results, ...rest } = outcome;
  return { ...rest, results: results.map(({ sort, ...row }) => row) };
}

// 把一次换算的完整结果收成一条留存记录，只留引用与快照字段
function buildRun(plan, source, outcome, now) {
  return {
    id: crypto.randomUUID(),
    planId: plan.id,
    sourceZoneId: source.id,
    sourceName: source.name,
    sourceDisplayName: source.displayName,
    ranAt: now,
    rows: outcome.results.map((row) => ({
      zoneId: row.zoneId,
      localDate: row.localDate,
      localTime: row.localTime,
      weekday: row.weekday,
      dayOffset: row.dayOffset,
      offsetMinutes: row.offsetMinutes,
      diffMinutes: row.diffMinutes,
      isSource: row.isSource,
      sort: row.sort,
    })),
  };
}

// 读结果行时补上档案的名称与展示文案，档案已经不在的行不返回
function presentRun(run, data) {
  const zoneById = new Map(data.zones.map((zone) => [zone.id, zone]));
  const rows = run.rows
    .filter((row) => zoneById.has(row.zoneId))
    .sort((a, b) => a.sort - b.sort)
    .map((row) => {
      const zone = zoneById.get(row.zoneId);
      return {
        ...row,
        name: zone.name,
        displayName: zone.displayName,
        offsetText: offsetText(zone.offsetMinutes),
        dayOffsetText: dayOffsetText(row.dayOffset),
        diffText: diffText(row.diffMinutes),
        usesDst: zone.usesDst,
      };
    });
  return {
    id: run.id,
    planId: run.planId,
    sourceZoneId: run.sourceZoneId,
    sourceName: run.sourceName,
    sourceDisplayName: run.sourceDisplayName,
    ranAt: run.ranAt,
    rows,
  };
}

function planSummary(plan, data) {
  const runs = data.runs.filter((run) => run.planId === plan.id);
  const source = data.zones.find((zone) => zone.id === plan.sourceZoneId);
  return {
    id: plan.id,
    title: plan.title,
    date: plan.date,
    time: plan.time,
    sourceZoneId: plan.sourceZoneId,
    sourceName: source ? source.name : '',
    sourceDisplayName: source ? source.displayName : '',
    sourceOffsetText: source ? offsetText(source.offsetMinutes) : '',
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    lastRunAt: plan.lastRunAt,
    runCount: runs.length,
  };
}

function listPlans() {
  const data = load();
  const plans = data.plans
    .slice()
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map((plan) => planSummary(plan, data));
  return { plans, total: plans.length };
}

function findPlanOrThrow(data, id) {
  const plan = data.plans.find((item) => item.id === id);
  if (!plan) throw new ApiError(404, 'PLAN_NOT_FOUND', '这条换算方案不存在或已被删除', '');
  return plan;
}

function getPlan(id) {
  const data = load();
  const plan = findPlanOrThrow(data, id);
  // runs 按落库顺序（执行先后）保存，倒序展示；同一时刻执行两次也不会乱
  const runIndex = new Map(data.runs.map((run, index) => [run.id, index]));
  const runs = data.runs
    .filter((run) => run.planId === plan.id)
    .sort((a, b) => (a.ranAt < b.ranAt ? 1 : a.ranAt > b.ranAt ? -1 : runIndex.get(b.id) - runIndex.get(a.id)))
    .map((run) => presentRun(run, data));
  return { ...planSummary(plan, data), runs };
}

// 新建方案并立刻换算一遍，方案与首条结果在同一次落盘里写进去
function createPlan(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const date = validateDate(input.date);
  const time = validateTime(input.time);
  const source = resolveSource(data, input.zoneId);
  const now = new Date().toISOString();
  const title = validateTitle(input.title, `${source.name} ${date.text} ${time.text}`);

  const plan = {
    id: crypto.randomUUID(),
    title,
    date: date.text,
    time: time.text,
    sourceZoneId: source.id,
    createdAt: now,
    updatedAt: now,
    lastRunAt: now,
  };
  const outcome = compute(data, { date: date.text, time: time.text, zoneId: source.id });
  const run = buildRun(plan, source, outcome, now);
  data.plans.push(plan);
  data.runs.push(run);
  save(data);
  return getPlan(plan.id);
}

// 用方案登记的日期、时刻与来源时区重新换算一遍，结果追加到该方案名下
function runPlan(id) {
  const data = load();
  const plan = findPlanOrThrow(data, id);
  const source = resolveSource(data, plan.sourceZoneId);
  const now = new Date().toISOString();
  const outcome = compute(data, { date: plan.date, time: plan.time, zoneId: source.id });
  const run = buildRun(plan, source, outcome, now);

  data.runs.push(run);
  // 每个方案只留最近若干次结果，按执行先后（落库顺序）从最旧的挤掉
  const ownRuns = data.runs
    .map((item, index) => ({ item, index }))
    .filter((entry) => entry.item.planId === plan.id);
  if (ownRuns.length > RUN_HISTORY_LIMIT) {
    const dropIds = new Set(ownRuns.slice(0, ownRuns.length - RUN_HISTORY_LIMIT).map((entry) => entry.item.id));
    data.runs = data.runs.filter((item) => !dropIds.has(item.id));
  }
  plan.lastRunAt = now;
  plan.updatedAt = now;
  save(data);
  return getPlan(plan.id);
}

function deletePlan(id) {
  const data = load();
  const plan = findPlanOrThrow(data, id);
  const removedRuns = data.runs.filter((item) => item.planId === plan.id).length;
  data.plans = data.plans.filter((item) => item.id !== plan.id);
  data.runs = data.runs.filter((item) => item.planId !== plan.id);
  save(data);
  return { id: plan.id, title: plan.title, removedRuns };
}

module.exports = {
  convert,
  compute,
  createPlan,
  listPlans,
  getPlan,
  runPlan,
  deletePlan,
  validateDate,
  validateTime,
  diffText,
  dayOffsetText,
  RUN_HISTORY_LIMIT,
};
