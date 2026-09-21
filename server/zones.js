const crypto = require('crypto');
const { load, save, MIN_OFFSET, MAX_OFFSET, MIN_YEAR, MAX_YEAR, MAX_NAME_LENGTH, MAX_DISPLAY_NAME_LENGTH, MAX_NOTE_LENGTH } = require('./store');
const { ApiError, pickText } = require('./errors');
const { offsetText } = require('./timefmt');
const { buildRow, DAY_MS } = require('./convert');

// 时区名固定成地区加城市的写法，UTC 单独允许
const NAME_PATTERN = /^([A-Za-z_]+(\/[A-Za-z_]+)+|UTC)$/;
const WEEK_TOKENS = ['1', '2', '3', '4', 'last'];

function validateName(value, data, selfId) {
  const name = pickText(value);
  if (!name) throw new ApiError(400, 'NAME_REQUIRED', '请填写时区名称', 'name');
  if (name.length > MAX_NAME_LENGTH) {
    throw new ApiError(400, 'NAME_TOO_LONG', `时区名称不能超过 ${MAX_NAME_LENGTH} 个字符`, 'name');
  }
  if (!NAME_PATTERN.test(name)) {
    throw new ApiError(400, 'NAME_INVALID', '时区名称要写成地区加城市，例如 Asia/Shanghai，基准时可以写 UTC', 'name');
  }
  const hit = data.zones.find((item) => item.id !== selfId && item.name.toLowerCase() === name.toLowerCase());
  if (hit) throw new ApiError(409, 'NAME_DUPLICATED', `${hit.name} 已经登记过了`, 'name');
  return name;
}

function validateDisplayName(value) {
  const displayName = pickText(value);
  if (!displayName) throw new ApiError(400, 'DISPLAY_NAME_REQUIRED', '请填写显示名称', 'displayName');
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ApiError(400, 'DISPLAY_NAME_TOO_LONG', `显示名称不能超过 ${MAX_DISPLAY_NAME_LENGTH} 个字符`, 'displayName');
  }
  return displayName;
}

// 偏移一律按分钟存，允许半小时与三刻这样的写法
function validateOffset(value, field) {
  const raw = typeof value === 'number' ? value : Number(pickText(String(value === undefined || value === null ? '' : value)));
  if (!Number.isInteger(raw)) {
    throw new ApiError(400, 'OFFSET_INVALID', '偏移要写成整数分钟，例如东八区写 480', field);
  }
  if (raw < MIN_OFFSET || raw > MAX_OFFSET) {
    throw new ApiError(400, 'OFFSET_OUT_OF_RANGE', `偏移要在 ${MIN_OFFSET} 到 ${MAX_OFFSET} 分钟之间`, field);
  }
  return raw;
}

// 夏令时规则里的一段：第几个星期几的几点几分
function validateRulePart(value, field) {
  const source = value && typeof value === 'object' ? value : {};
  const month = Number(source.month);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new ApiError(400, 'DST_MONTH_INVALID', '切换月份要填一到十二', field);
  }
  const week = String(source.week);
  if (!WEEK_TOKENS.includes(week)) {
    throw new ApiError(400, 'DST_WEEK_INVALID', '第几个星期只能填一到四，或者填最后一个', field);
  }
  const weekday = Number(source.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new ApiError(400, 'DST_WEEKDAY_INVALID', '星期要填零到六，零表示周日', field);
  }
  const hour = Number(source.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new ApiError(400, 'DST_HOUR_INVALID', '切换时刻的小时要填零到二十三', field);
  }
  const minute = Number(source.minute);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new ApiError(400, 'DST_MINUTE_INVALID', '切换时刻的分钟要填零到五十九', field);
  }
  return { month, week, weekday, hour, minute };
}

function sameRulePart(a, b) {
  if (!a || !b) return false;
  return a.month === b.month && a.week === b.week && a.weekday === b.weekday
    && a.hour === b.hour && a.minute === b.minute;
}

function validateYear(value, field, label) {
  if (value === undefined || value === null || value === '') return null;
  const year = Number(value);
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    throw new ApiError(400, 'YEAR_INVALID', `${label}要填 ${MIN_YEAR} 到 ${MAX_YEAR} 之间的整数`, field);
  }
  return year;
}

function validateNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ApiError(400, 'NOTE_INVALID', '备注需要是文本', 'note');
  if (value.length > MAX_NOTE_LENGTH) {
    throw new ApiError(400, 'NOTE_TOO_LONG', `备注不能超过 ${MAX_NOTE_LENGTH} 个字符`, 'note');
  }
  return value.trim();
}

// 一整条档案的校验：偏移、夏令时三段与生效年份要能对得上
function validatePayload(input, data, selfId) {
  const name = validateName(input.name, data, selfId);
  const displayName = validateDisplayName(input.displayName);
  const offsetMinutes = validateOffset(input.offsetMinutes, 'offsetMinutes');
  const usesDst = input.usesDst === true || input.usesDst === 'true';
  const fromYear = validateYear(input.fromYear, 'fromYear', '开始年份');
  const toYear = validateYear(input.toYear, 'toYear', '结束年份');

  if (fromYear !== null && toYear !== null && toYear < fromYear) {
    throw new ApiError(400, 'YEAR_RANGE_INVALID', '结束年份不能早于开始年份', 'toYear');
  }

  let dstOffsetMinutes = null;
  let dstStart = null;
  let dstEnd = null;

  if (usesDst) {
    dstOffsetMinutes = validateOffset(input.dstOffsetMinutes, 'dstOffsetMinutes');
    if (dstOffsetMinutes <= offsetMinutes) {
      throw new ApiError(400, 'DST_OFFSET_INVALID', '夏令时偏移要比标准偏移更靠前，也就是数值更大', 'dstOffsetMinutes');
    }
    if (!input.dstStart || !input.dstEnd) {
      throw new ApiError(400, 'DST_RULE_REQUIRED', '实行夏令时的时区要把开始与结束两段规则都填上', 'dstStart');
    }
    dstStart = validateRulePart(input.dstStart, 'dstStart');
    dstEnd = validateRulePart(input.dstEnd, 'dstEnd');
    if (sameRulePart(dstStart, dstEnd)) {
      throw new ApiError(400, 'DST_RULE_SAME', '开始与结束两段规则不能完全相同，否则推算不出切换区间', 'dstEnd');
    }
  }

  return {
    name,
    displayName,
    offsetMinutes,
    usesDst,
    dstOffsetMinutes,
    dstStart,
    dstEnd,
    fromYear: fromYear === null ? MIN_YEAR : fromYear,
    toYear,
    note: validateNote(input.note),
  };
}

// 偏移的展示写法见 timefmt，zones 与 convert 共用同一份
function withOffsetText(zone) {
  return {
    ...zone,
    offsetText: offsetText(zone.offsetMinutes),
    dstOffsetText: zone.usesDst && zone.dstOffsetMinutes !== null ? offsetText(zone.dstOffsetMinutes) : '',
    yearRangeText: zone.toYear === null ? `${zone.fromYear} 年起` : `${zone.fromYear} 至 ${zone.toYear}`,
  };
}

function sortZones(list) {
  return list.slice().sort((a, b) => {
    if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes;
    return a.name < b.name ? -1 : 1;
  });
}

// 档案清单：按是否实行夏令时筛选，再按名称、显示名或备注搜索
function listZones(options) {
  const input = options && typeof options === 'object' ? options : {};
  const dst = pickText(input.dst);
  const keyword = pickText(input.keyword).toLowerCase();
  const data = load();

  let list = data.zones;
  if (dst === 'yes') list = list.filter((item) => item.usesDst);
  if (dst === 'no') list = list.filter((item) => !item.usesDst);
  if (keyword) {
    list = list.filter((item) => item.name.toLowerCase().includes(keyword)
      || item.displayName.toLowerCase().includes(keyword)
      || item.note.toLowerCase().includes(keyword));
  }

  return {
    zones: sortZones(list).map((zone) => ({
      ...withOffsetText(zone),
      referenceCount: collectReferences(data, zone.id).counts.totalCount,
    })),
    total: data.zones.length,
    dstCount: data.zones.filter((item) => item.usesDst).length,
    noDstCount: data.zones.filter((item) => !item.usesDst).length,
  };
}

function getZone(id) {
  const data = load();
  const found = data.zones.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'ZONE_NOT_FOUND', '这条时区档案不存在或已被删除', '');
  return withOffsetText(found);
}

function createZone(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const checked = validatePayload(input, data, '');
  const now = new Date().toISOString();
  const created = { id: crypto.randomUUID(), ...checked, createdAt: now, updatedAt: now };
  data.zones.push(created);
  save(data);
  return withOffsetText(created);
}

function updateZone(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const found = data.zones.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'ZONE_NOT_FOUND', '这条时区档案不存在或已被删除', '');

  const merged = {
    name: input.name === undefined ? found.name : input.name,
    displayName: input.displayName === undefined ? found.displayName : input.displayName,
    offsetMinutes: input.offsetMinutes === undefined ? found.offsetMinutes : input.offsetMinutes,
    usesDst: input.usesDst === undefined ? found.usesDst : (input.usesDst === true || input.usesDst === 'true'),
    dstOffsetMinutes: input.dstOffsetMinutes === undefined ? found.dstOffsetMinutes : input.dstOffsetMinutes,
    dstStart: input.dstStart === undefined ? found.dstStart : input.dstStart,
    dstEnd: input.dstEnd === undefined ? found.dstEnd : input.dstEnd,
    fromYear: input.fromYear === undefined ? found.fromYear : input.fromYear,
    toYear: input.toYear === undefined ? found.toYear : input.toYear,
    note: input.note === undefined ? found.note : input.note,
  };

  const checked = validatePayload(merged, data, found.id);
  Object.assign(found, checked);
  found.updatedAt = new Date().toISOString();
  save(data);
  return withOffsetText(found);
}

function deleteZone(id) {
  const data = load();
  const index = data.zones.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'ZONE_NOT_FOUND', '这条时区档案不存在或已被删除', '');
  const refs = collectReferences(data, id);
  if (refs.counts.totalCount > 0) {
    // 有引用时不允许裸删：页面先拿引用清单让操作者选改挂还是连同引用一起清掉
    throw new ApiError(409, 'ZONE_IN_USE', '这条档案还被换算方案或结果引用着，不能直接删除', '');
  }
  const [removed] = data.zones.splice(index, 1);
  save(data);
  return { id: removed.id, name: removed.name, displayName: removed.displayName };
}

// 一条方案引用的展示信息
function schemeRefView(scheme) {
  return {
    id: scheme.id,
    name: scheme.name,
    date: scheme.date,
    time: scheme.time,
    zoneId: scheme.zoneId,
  };
}

// 一条结果引用的展示信息：作为来源与作为换算目标行用的是同一份摘要
function resultRefView(result, row) {
  return {
    id: result.id,
    schemeName: result.schemeName,
    createdAt: result.createdAt,
    sourceZoneId: result.sourceZoneId,
    sourceName: result.sourceName,
    localDate: row ? row.localDate : '',
    localTime: row ? row.localTime : '',
  };
}

// 引用扫描：三类清单各自不重叠，totalCount 等于三份清单条数之和，页面上的计数与列表严格对得上
//   1) 换算方案把它选作来源时区
//   2) 换算结果的来源时区是它
//   3) 换算结果的明细行里有它（同一结果若它同时是来源，只在第 2 类计一次）
function collectReferences(data, zoneId) {
  const schemeRefs = [];
  const resultSourceRefs = [];
  const resultRowRefs = [];

  data.schemes.forEach((scheme) => {
    if (scheme.zoneId === zoneId) schemeRefs.push(schemeRefView(scheme));
  });

  data.results.forEach((result) => {
    if (result.sourceZoneId === zoneId) {
      resultSourceRefs.push(resultRefView(result, null));
      return;
    }
    const row = result.rows.find((item) => item.zoneId === zoneId);
    if (row) resultRowRefs.push(resultRefView(result, row));
  });

  return {
    zoneId,
    schemeRefs,
    resultSourceRefs,
    resultRowRefs,
    counts: {
      schemeCount: schemeRefs.length,
      resultSourceCount: resultSourceRefs.length,
      resultRowCount: resultRowRefs.length,
      totalCount: schemeRefs.length + resultSourceRefs.length + resultRowRefs.length,
    },
  };
}

function getZoneReferences(id) {
  const data = load();
  const zone = data.zones.find((item) => item.id === id);
  if (!zone) throw new ApiError(404, 'ZONE_NOT_FOUND', '这条时区档案不存在或已被删除', '');
  return { zone: withOffsetText(zone), ...collectReferences(data, id) };
}

// 结果原来以旧档案为来源，改挂后照保存的基准 UTC 时刻、用新来源把全部明细重算一遍，
// 日期、时刻、与来源的相差和同天标记都跟着新来源走
function recomputeResultForSource(data, result, newSource) {
  const utcMs = Date.parse(result.baseUtcTime);
  if (!Number.isFinite(utcMs)) {
    throw new ApiError(500, 'RESULT_TIME_BROKEN', '有结果保存的基准时刻无法识别，删除已中止，档案与引用都没有改动', '');
  }
  const sourceLocalMs = utcMs + newSource.offsetMinutes * 60000;
  const sourceLocal = new Date(sourceLocalMs);
  const baseDay = Math.floor(sourceLocalMs / DAY_MS);
  const pad = (num) => String(num).padStart(2, '0');

  const rows = data.zones.map((zone) => {
    const row = buildRow(zone, utcMs, newSource.offsetMinutes, baseDay);
    row.isSource = zone.id === newSource.id;
    return row;
  });
  rows.sort((a, b) => {
    if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes;
    return a.name < b.name ? -1 : 1;
  });

  return {
    date: `${sourceLocal.getUTCFullYear()}-${pad(sourceLocal.getUTCMonth() + 1)}-${pad(sourceLocal.getUTCDate())}`,
    time: `${pad(sourceLocal.getUTCHours())}:${pad(sourceLocal.getUTCMinutes())}`,
    sourceZoneId: newSource.id,
    sourceName: newSource.name,
    sourceDisplayName: newSource.displayName,
    rows,
  };
}

// 带处理方式的删除：strategy 为 reassign（引用改挂到 targetId）或 cascade（确认后连同引用一起清掉）。
// 所有校验在改动前做完，内存里的改动集中完成后只落盘一次：中途任何一步抛错都不会写文件，
// 档案还在、方案与结果也保持原样，不会落到删了一半的状态
function deleteZoneWithStrategy(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const strategy = pickText(input.strategy);
  if (strategy !== 'reassign' && strategy !== 'cascade') {
    throw new ApiError(400, 'DELETE_STRATEGY_REQUIRED', '请选择引用的处理方式：改挂到别的档案，或者连同引用一起清掉', 'strategy');
  }

  const data = load();
  const index = data.zones.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'ZONE_NOT_FOUND', '这条时区档案不存在或已被删除', '');
  const refs = collectReferences(data, id);

  let target = null;
  if (strategy === 'reassign') {
    const targetId = pickText(input.targetId);
    if (!targetId) throw new ApiError(400, 'TARGET_ZONE_REQUIRED', '请选择把引用改挂到哪一条档案', 'targetId');
    if (targetId === id) throw new ApiError(400, 'TARGET_ZONE_SAME', '不能改挂到正要删除的档案自己身上', 'targetId');
    target = data.zones.find((item) => item.id === targetId);
    if (!target) throw new ApiError(404, 'TARGET_ZONE_NOT_FOUND', '要改挂到的档案不存在或已被删除', 'targetId');
  } else if (input.confirm !== true) {
    throw new ApiError(400, 'CONFIRM_REQUIRED', '连同引用一起清掉需要明确确认', 'confirm');
  }

  let removedSchemes = 0;
  let removedResults = 0;
  let reassignedSchemes = 0;
  let recomputedResults = 0;
  let trimmedResults = 0;
  let removedRows = 0;

  if (strategy === 'reassign') {
    // 改挂要照基准时刻重算或补算，先确认所有会被碰到的结果时刻都有效：有一条坏的就整体中止，
    // 此时尚未改动任何数据，落盘也还没发生
    const touchedResultIds = new Set([
      ...refs.resultSourceRefs.map((item) => item.id),
      ...refs.resultRowRefs.map((item) => item.id),
    ]);
    data.results.forEach((result) => {
      if (touchedResultIds.has(result.id) && !Number.isFinite(Date.parse(result.baseUtcTime))) {
        throw new ApiError(500, 'RESULT_TIME_BROKEN', '有结果保存的基准时刻无法识别，删除已中止，档案与引用都没有改动', '');
      }
    });
  }

  if (strategy === 'cascade') {
    // 方案不能没有来源时区，引用它的方案整条删掉；以它为来源的结果整条删掉；
    // 其余结果只把它那一行明细剔掉，结果本身仍成立
    const schemeIdsToDelete = new Set(refs.schemeRefs.map((item) => item.id));
    removedSchemes = schemeIdsToDelete.size;
    data.schemes = data.schemes.filter((scheme) => !schemeIdsToDelete.has(scheme.id));

    const resultIdsAsSource = new Set(refs.resultSourceRefs.map((item) => item.id));
    removedResults = resultIdsAsSource.size;
    const nextResults = [];
    data.results.forEach((result) => {
      if (resultIdsAsSource.has(result.id)) return;
      const before = result.rows.length;
      result.rows = result.rows.filter((row) => row.zoneId !== id);
      if (result.rows.length !== before) {
        removedRows += before - result.rows.length;
        trimmedResults += 1;
      }
      nextResults.push(result);
    });
    data.results = nextResults;
  } else {
    // 改挂：方案换到新档案；以旧档案为来源的结果照同一刻重算；其余结果把明细行换过去
    data.schemes.forEach((scheme) => {
      if (scheme.zoneId === id) {
        scheme.zoneId = target.id;
        scheme.updatedAt = new Date().toISOString();
        reassignedSchemes += 1;
      }
    });

    data.results.forEach((result) => {
      if (result.sourceZoneId === id) {
        Object.assign(result, recomputeResultForSource(data, result, target));
        // 重算时旧档案还在内存里，落盘前先把它那一行剔掉，保持引用一致
        result.rows = result.rows.filter((row) => row.zoneId !== id);
        recomputedResults += 1;
        return;
      }
      const rowIndex = result.rows.findIndex((row) => row.zoneId === id);
      if (rowIndex !== -1) {
        result.rows.splice(rowIndex, 1);
        removedRows += 1;
        if (!result.rows.some((row) => row.zoneId === target.id)) {
          const utcMs = Date.parse(result.baseUtcTime);
          const source = data.zones.find((zone) => zone.id === result.sourceZoneId);
          const sourceLocalMs = utcMs + source.offsetMinutes * 60000;
          const baseDay = Math.floor(sourceLocalMs / DAY_MS);
          result.rows.push(buildRow(target, utcMs, source.offsetMinutes, baseDay));
          result.rows.sort((a, b) => {
            if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes;
            return a.name < b.name ? -1 : 1;
          });
        }
        trimmedResults += 1;
      }
    });
  }

  const [removed] = data.zones.splice(index, 1);
  save(data);

  return {
    strategy,
    id: removed.id,
    name: removed.name,
    displayName: removed.displayName,
    hadReferences: refs.counts.totalCount > 0,
    counts: {
      removedSchemes,
      removedResults,
      reassignedSchemes,
      recomputedResults,
      trimmedResults,
      removedRows,
    },
  };
}

module.exports = {
  listZones,
  getZone,
  createZone,
  updateZone,
  deleteZone,
  deleteZoneWithStrategy,
  getZoneReferences,
  collectReferences,
  offsetText,
  withOffsetText,
};
