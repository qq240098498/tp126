const fs = require('fs');
const path = require('path');

// 数据目录允许用环境变量另指一份，测试时把数据隔到临时目录里，不碰正式的 data/db.json
const DATA_DIR = process.env.TP126_DATA_DIR
  ? path.resolve(process.env.TP126_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const TEMP_FILE = path.join(DATA_DIR, 'db.json.tmp');

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const MONTH_NAMES = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
const MIN_OFFSET = -720;
const MAX_OFFSET = 840;
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
const MAX_NAME_LENGTH = 40;
const MAX_DISPLAY_NAME_LENGTH = 40;
const MAX_NOTE_LENGTH = 200;

// 时区档案的初始数据。十条档案里有带半小时与三刻偏移的、有南半球跨年实行夏令时的、
// 有已经停止实行夏令时但保留生效年份区间的，也有完全不实行夏令时的
function seedZones() {
  const at = '2026-09-05T02:00:00.000Z';
  return [
    {
      id: 'zone-1001', name: 'Asia/Shanghai', displayName: '中国标准时间', offsetMinutes: 480,
      usesDst: false, dstOffsetMinutes: null, dstStart: null, dstEnd: null,
      fromYear: 1949, toYear: null, note: '全国统一使用，不实行夏令时', createdAt: at, updatedAt: at,
    },
    {
      id: 'zone-1002', name: 'Asia/Kolkata', displayName: '印度标准时间', offsetMinutes: 330,
      usesDst: false, dstOffsetMinutes: null, dstStart: null, dstEnd: null,
      fromYear: 1947, toYear: null, note: '偏移带半小时', createdAt: at, updatedAt: at,
    },
    {
      id: 'zone-1003', name: 'Asia/Kathmandu', displayName: '尼泊尔时间', offsetMinutes: 345,
      usesDst: false, dstOffsetMinutes: null, dstStart: null, dstEnd: null,
      fromYear: 1986, toYear: null, note: '偏移带三刻', createdAt: at, updatedAt: at,
    },
    {
      id: 'zone-1004', name: 'UTC', displayName: '协调世界时', offsetMinutes: 0,
      usesDst: false, dstOffsetMinutes: null, dstStart: null, dstEnd: null,
      fromYear: 1972, toYear: null, note: '换算的基准', createdAt: at, updatedAt: at,
    },
    {
      id: 'zone-1005', name: 'America/New_York', displayName: '美国东部时间', offsetMinutes: -300,
      usesDst: true, dstOffsetMinutes: -240,
      dstStart: { month: 3, week: '2', weekday: 0, hour: 2, minute: 0 },
      dstEnd: { month: 11, week: '1', weekday: 0, hour: 2, minute: 0 },
      fromYear: 1967, toYear: null, note: '三月第二个周日凌晨开始，十一月第一个周日凌晨结束', createdAt: at, updatedAt: at,
    },
    {
      id: 'zone-1006', name: 'Europe/London', displayName: '英国时间', offsetMinutes: 0,
      usesDst: true, dstOffsetMinutes: 60,
      dstStart: { month: 3, week: 'last', weekday: 0, hour: 1, minute: 0 },
      dstEnd: { month: 10, week: 'last', weekday: 0, hour: 2, minute: 0 },
      fromYear: 1972, toYear: null, note: '切换时刻落在当地凌晨一点与两点', createdAt: at, updatedAt: at,
    },
    {
      id: 'zone-1007', name: 'Australia/Sydney', displayName: '澳大利亚东部时间', offsetMinutes: 600,
      usesDst: true, dstOffsetMinutes: 660,
      dstStart: { month: 10, week: '1', weekday: 0, hour: 2, minute: 0 },
      dstEnd: { month: 4, week: '1', weekday: 0, hour: 3, minute: 0 },
      fromYear: 1971, toYear: null, note: '南半球，夏令时跨年，开始月份晚于结束月份', createdAt: at, updatedAt: at,
    },
    {
      id: 'zone-1008', name: 'Pacific/Chatham', displayName: '查塔姆群岛时间', offsetMinutes: 765,
      usesDst: true, dstOffsetMinutes: 825,
      dstStart: { month: 9, week: 'last', weekday: 0, hour: 2, minute: 45 },
      dstEnd: { month: 4, week: '1', weekday: 0, hour: 3, minute: 45 },
      fromYear: 1974, toYear: null, note: '偏移与切换时刻都带三刻', createdAt: at, updatedAt: at,
    },
    {
      id: 'zone-1009', name: 'America/Sao_Paulo', displayName: '巴西利亚时间', offsetMinutes: -180,
      usesDst: true, dstOffsetMinutes: -120,
      dstStart: { month: 11, week: '1', weekday: 0, hour: 0, minute: 0 },
      dstEnd: { month: 2, week: '3', weekday: 0, hour: 0, minute: 0 },
      fromYear: 1985, toYear: 2019, note: '二〇一九年起不再实行夏令时', createdAt: at, updatedAt: at,
    },
    {
      id: 'zone-1010', name: 'Asia/Taipei', displayName: '台北时间', offsetMinutes: 480,
      usesDst: true, dstOffsetMinutes: 540,
      dstStart: { month: 4, week: '1', weekday: 0, hour: 0, minute: 0 },
      dstEnd: { month: 9, week: 'last', weekday: 0, hour: 0, minute: 0 },
      fromYear: 1945, toYear: 1979, note: '早期实行过夏令时，现已停止', createdAt: at, updatedAt: at,
    },
  ];
}

// 把夏令时规则里的一段整理成固定结构，字段不认识时置空表示这一段没有
function normalizeRulePart(item) {
  if (!item || typeof item !== 'object') return null;
  const month = Number(item.month);
  const week = item.week === 'last' ? 'last' : String(Number(item.week));
  const weekday = Number(item.weekday);
  const hour = Number(item.hour);
  const minute = Number(item.minute);
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (week !== 'last' && (!Number.isInteger(Number(week)) || Number(week) < 1 || Number(week) > 4)) return null;
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { month, week, weekday, hour, minute };
}

// 把单条时区档案整理成固定结构，偏移与年份越界的一律回到默认值
function normalizeZone(item, fallbackIndex) {
  const source = item && typeof item === 'object' ? item : {};
  const createdAt = typeof source.createdAt === 'string' && source.createdAt ? source.createdAt : new Date().toISOString();
  const offset = Number(source.offsetMinutes);
  const offsetMinutes = Number.isInteger(offset) && offset >= MIN_OFFSET && offset <= MAX_OFFSET ? offset : 0;
  const usesDst = source.usesDst === true;
  const dstOffsetRaw = Number(source.dstOffsetMinutes);
  const dstOffsetMinutes = usesDst && Number.isInteger(dstOffsetRaw) && dstOffsetRaw >= MIN_OFFSET && dstOffsetRaw <= MAX_OFFSET
    ? dstOffsetRaw
    : null;
  const fromYearRaw = Number(source.fromYear);
  const fromYear = Number.isInteger(fromYearRaw) && fromYearRaw >= MIN_YEAR && fromYearRaw <= MAX_YEAR ? fromYearRaw : MIN_YEAR;
  const toYearRaw = source.toYear === null || source.toYear === undefined || source.toYear === '' ? null : Number(source.toYear);
  const toYear = Number.isInteger(toYearRaw) && toYearRaw >= MIN_YEAR && toYearRaw <= MAX_YEAR ? toYearRaw : null;

  return {
    id: typeof source.id === 'string' && source.id ? source.id : `zone-restored-${fallbackIndex + 1}`,
    name: typeof source.name === 'string' ? source.name.trim() : '',
    displayName: typeof source.displayName === 'string' ? source.displayName.trim() : '',
    offsetMinutes,
    usesDst,
    dstOffsetMinutes,
    dstStart: usesDst ? normalizeRulePart(source.dstStart) : null,
    dstEnd: usesDst ? normalizeRulePart(source.dstEnd) : null,
    fromYear,
    toYear,
    note: typeof source.note === 'string' ? source.note : '',
    createdAt,
    updatedAt: typeof source.updatedAt === 'string' && source.updatedAt ? source.updatedAt : createdAt,
  };
}

// 换算方案：一个待换算的时刻加上来源时区。结构不合或缺来源档案的一律丢掉，不让悬空引用落库
function normalizeScheme(item, zoneIds) {
  const source = item && typeof item === 'object' ? item : {};
  const id = typeof source.id === 'string' ? source.id.trim() : '';
  const name = typeof source.name === 'string' ? source.name.trim() : '';
  const date = typeof source.date === 'string' ? source.date.trim() : '';
  const time = typeof source.time === 'string' ? source.time.trim() : '';
  const zoneId = typeof source.zoneId === 'string' ? source.zoneId.trim() : '';
  if (!id || !name || !date || !time || !zoneId || !zoneIds.has(zoneId)) return null;
  const createdAt = typeof source.createdAt === 'string' && source.createdAt ? source.createdAt : null;
  const updatedAt = typeof source.updatedAt === 'string' && source.updatedAt ? source.updatedAt : null;
  return {
    id, name, date, time, zoneId,
    createdAt: createdAt || new Date().toISOString(),
    updatedAt: updatedAt || createdAt || new Date().toISOString(),
  };
}

// 换算结果：执行方案时按当时各档案算出的明细行。来源档案缺失或一条明细都对不上的结果丢掉，
// 明细里引用的档案已经不在的只剔那一行，保证留下来的每一条引用都指得到档案
function normalizeResult(item, zoneIds) {
  const source = item && typeof item === 'object' ? item : {};
  const id = typeof source.id === 'string' ? source.id.trim() : '';
  const sourceZoneId = typeof source.sourceZoneId === 'string' ? source.sourceZoneId.trim() : '';
  const baseUtcTime = typeof source.baseUtcTime === 'string' ? source.baseUtcTime.trim() : '';
  if (!id || !sourceZoneId || !zoneIds.has(sourceZoneId) || !baseUtcTime) return null;

  const seenRows = new Set();
  const rows = [];
  const rawRows = Array.isArray(source.rows) ? source.rows : [];
  rawRows.forEach((row) => {
    if (!row || typeof row !== 'object') return;
    const zoneId = typeof row.zoneId === 'string' ? row.zoneId.trim() : '';
    if (!zoneId || !zoneIds.has(zoneId) || seenRows.has(zoneId)) return;
    seenRows.add(zoneId);
    rows.push(row);
  });
  if (!rows.some((row) => row.zoneId === sourceZoneId) || rows.length === 0) return null;

  const createdAt = typeof source.createdAt === 'string' && source.createdAt ? source.createdAt : null;
  return {
    id,
    schemeId: typeof source.schemeId === 'string' ? source.schemeId.trim() : '',
    schemeName: typeof source.schemeName === 'string' ? source.schemeName.trim() : '',
    date: typeof source.date === 'string' ? source.date.trim() : '',
    time: typeof source.time === 'string' ? source.time.trim() : '',
    sourceZoneId,
    sourceName: typeof source.sourceName === 'string' ? source.sourceName : '',
    sourceDisplayName: typeof source.sourceDisplayName === 'string' ? source.sourceDisplayName : '',
    baseUtcTime,
    rows,
    createdAt: createdAt || new Date().toISOString(),
  };
}

// 整份数据保证结构一致，缺名称、缺显示名的档案一律丢掉，名称重复的只留第一条
function normalize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const rawZones = Array.isArray(source.zones) ? source.zones : seedZones();

  const seenIds = new Set();
  const seenNames = new Set();
  const zones = [];
  rawZones.forEach((item, index) => {
    const zone = normalizeZone(item, index);
    if (!zone.id || !zone.name || !zone.displayName) return;
    const lower = zone.name.toLowerCase();
    if (seenIds.has(zone.id) || seenNames.has(lower)) return;
    seenIds.add(zone.id);
    seenNames.add(lower);
    zones.push(zone);
  });

  // 档案定稿后再整理方案与结果：引用关系一律以这批还在的档案为准
  const seenSchemeIds = new Set();
  const schemes = [];
  (Array.isArray(source.schemes) ? source.schemes : []).forEach((item) => {
    const scheme = normalizeScheme(item, seenIds);
    if (!scheme || seenSchemeIds.has(scheme.id)) return;
    seenSchemeIds.add(scheme.id);
    schemes.push(scheme);
  });

  const seenResultIds = new Set();
  const results = [];
  (Array.isArray(source.results) ? source.results : []).forEach((item) => {
    const result = normalizeResult(item, seenIds);
    if (!result || seenResultIds.has(result.id)) return;
    seenResultIds.add(result.id);
    results.push(result);
  });

  return { zones, schemes, results };
}

// 读取数据文件：文件缺失或内容损坏时回落到初始数据并立刻补写
function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return normalize(JSON.parse(raw));
  } catch (err) {
    const data = normalize({ zones: seedZones() });
    save(data);
    return data;
  }
}

// 先写临时文件再改名，写入中途被打断也不会把正式数据文件写坏
function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const text = `${JSON.stringify(normalize(data), null, 2)}\n`;
  fs.writeFileSync(TEMP_FILE, text, 'utf8');
  fs.renameSync(TEMP_FILE, DATA_FILE);
}

module.exports = {
  load,
  save,
  seedZones,
  normalize,
  normalizeZone,
  normalizeRulePart,
  WEEKDAY_NAMES,
  MONTH_NAMES,
  MIN_OFFSET,
  MAX_OFFSET,
  MIN_YEAR,
  MAX_YEAR,
  MAX_NAME_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_NOTE_LENGTH,
  DATA_FILE,
};
