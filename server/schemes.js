const crypto = require('crypto');
const { load, save } = require('./store');
const { ApiError, pickText } = require('./errors');
const { validateDate, validateTime, computeConversion } = require('./convert');
const { offsetText } = require('./timefmt');

const MAX_SCHEME_NAME_LENGTH = 40;

// 方案的校验：名称必填，日期时刻沿用换算台的口径，来源时区必须在档案里
function validateSchemePayload(input, data, selfId) {
  const source = input && typeof input === 'object' ? input : {};
  const name = pickText(source.name);
  if (!name) throw new ApiError(400, 'SCHEME_NAME_REQUIRED', '请填写方案名称', 'name');
  if (name.length > MAX_SCHEME_NAME_LENGTH) {
    throw new ApiError(400, 'SCHEME_NAME_TOO_LONG', `方案名称不能超过 ${MAX_SCHEME_NAME_LENGTH} 个字符`, 'name');
  }
  const date = validateDate(source.date);
  const time = validateTime(source.time);
  const zoneId = pickText(source.zoneId);
  if (!zoneId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择来源时区', 'zoneId');
  const zone = data.zones.find((item) => item.id === zoneId);
  if (!zone) throw new ApiError(404, 'ZONE_NOT_FOUND', '选中的来源时区没有登记过', 'zoneId');

  // 同名方案只在不同记录之间算重复
  const duplicated = data.schemes.find((item) => item.id !== selfId && item.name === name);
  if (duplicated) throw new ApiError(409, 'SCHEME_NAME_DUPLICATED', `已经有叫「${name}」的方案了`, 'name');

  return {
    name,
    date: date.text,
    time: time.text,
    zoneId,
  };
}

function schemeView(data, scheme) {
  const zone = data.zones.find((item) => item.id === scheme.zoneId);
  return {
    ...scheme,
    zoneName: zone ? zone.name : '',
    zoneDisplayName: zone ? zone.displayName : '',
    offsetText: zone ? offsetText(zone.offsetMinutes) : '',
    resultCount: data.results.filter((item) => item.schemeId === scheme.id).length,
  };
}

function resultView(result) {
  return {
    id: result.id,
    schemeId: result.schemeId,
    schemeName: result.schemeName,
    date: result.date,
    time: result.time,
    sourceZoneId: result.sourceZoneId,
    sourceName: result.sourceName,
    sourceDisplayName: result.sourceDisplayName,
    baseUtcTime: result.baseUtcTime,
    rows: result.rows,
    rowCount: result.rows.length,
    crossDayCount: result.rows.filter((row) => row.dayOffset !== 0).length,
    createdAt: result.createdAt,
  };
}

function resultSummary(result) {
  return {
    id: result.id,
    schemeId: result.schemeId,
    schemeName: result.schemeName,
    date: result.date,
    time: result.time,
    sourceZoneId: result.sourceZoneId,
    sourceName: result.sourceName,
    sourceDisplayName: result.sourceDisplayName,
    rowCount: result.rows.length,
    crossDayCount: result.rows.filter((row) => row.dayOffset !== 0).length,
    createdAt: result.createdAt,
  };
}

function listSchemes() {
  const data = load();
  const list = data.schemes
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((item) => schemeView(data, item));
  return { schemes: list, total: list.length };
}

function getScheme(id) {
  const data = load();
  const found = data.schemes.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'SCHEME_NOT_FOUND', '这条换算方案不存在或已被删除', '');
  return schemeView(data, found);
}

function createScheme(payload) {
  const data = load();
  const checked = validateSchemePayload(payload, data, '');
  const now = new Date().toISOString();
  const created = { id: crypto.randomUUID(), ...checked, createdAt: now, updatedAt: now };
  data.schemes.push(created);
  save(data);
  return schemeView(data, created);
}

function updateScheme(id, payload) {
  const data = load();
  const found = data.schemes.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'SCHEME_NOT_FOUND', '这条换算方案不存在或已被删除', '');
  const merged = {
    name: payload && payload.name === undefined ? found.name : payload.name,
    date: payload && payload.date === undefined ? found.date : payload.date,
    time: payload && payload.time === undefined ? found.time : payload.time,
    zoneId: payload && payload.zoneId === undefined ? found.zoneId : payload.zoneId,
  };
  const checked = validateSchemePayload(merged, data, found.id);
  Object.assign(found, checked);
  found.updatedAt = new Date().toISOString();
  save(data);
  return schemeView(data, found);
}

// 删方案会把由它执行出来的结果一并删掉；这些结果本就是方案的派生产物
function deleteScheme(id) {
  const data = load();
  const index = data.schemes.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'SCHEME_NOT_FOUND', '这条换算方案不存在或已被删除', '');
  const [removed] = data.schemes.splice(index, 1);
  let removedResults = 0;
  for (let i = data.results.length - 1; i >= 0; i -= 1) {
    if (data.results[i].schemeId === removed.id) {
      data.results.splice(i, 1);
      removedResults += 1;
    }
  }
  save(data);
  return { id: removed.id, name: removed.name, removedResults };
}

// 执行一遍方案：按当前登记的档案算出各时区时刻，连同基准 UTC 时刻一起落库。
// 基准时刻让以后来源时区改挂到别的档案时，历史结果能照同一刻重新换算
function runScheme(id) {
  const data = load();
  const scheme = data.schemes.find((item) => item.id === id);
  if (!scheme) throw new ApiError(404, 'SCHEME_NOT_FOUND', '这条换算方案不存在或已被删除', '');
  const source = data.zones.find((item) => item.id === scheme.zoneId);
  if (!source) throw new ApiError(404, 'ZONE_NOT_FOUND', '方案选用的来源时区已经不在了', 'zoneId');

  const date = validateDate(scheme.date);
  const time = validateTime(scheme.time);
  const computed = computeConversion(data, source, date, time);

  const result = {
    id: crypto.randomUUID(),
    schemeId: scheme.id,
    schemeName: scheme.name,
    date: scheme.date,
    time: scheme.time,
    sourceZoneId: source.id,
    sourceName: source.name,
    sourceDisplayName: source.displayName,
    baseUtcTime: computed.baseUtcTime,
    rows: computed.rows,
    createdAt: new Date().toISOString(),
  };
  data.results.push(result);
  save(data);
  return resultView(result);
}

function listResults(options) {
  const input = options && typeof options === 'object' ? options : {};
  const schemeId = pickText(input.schemeId);
  const data = load();
  let list = data.results;
  if (schemeId) list = list.filter((item) => item.schemeId === schemeId);
  list = list.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { results: list.map(resultSummary), total: list.length };
}

function getResult(id) {
  const data = load();
  const found = data.results.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'RESULT_NOT_FOUND', '这条换算结果不存在或已被删除', '');
  return resultView(found);
}

function deleteResult(id) {
  const data = load();
  const index = data.results.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'RESULT_NOT_FOUND', '这条换算结果不存在或已被删除', '');
  const [removed] = data.results.splice(index, 1);
  save(data);
  return { id: removed.id };
}

module.exports = {
  listSchemes,
  getScheme,
  createScheme,
  updateScheme,
  deleteScheme,
  runScheme,
  listResults,
  getResult,
  deleteResult,
};
