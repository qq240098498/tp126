const crypto = require('crypto');
const { load, save, MIN_OFFSET, MAX_OFFSET, MIN_YEAR, MAX_YEAR, MAX_NAME_LENGTH, MAX_DISPLAY_NAME_LENGTH, MAX_NOTE_LENGTH } = require('./store');
const { ApiError, pickText } = require('./errors');

// 时区名固定成地区加城市的写法，UTC 单独允许
const NAME_PATTERN = /^([A-Za-z_]+(\/[A-Za-z_]+)+|UTC)$/;
const WEEK_TOKENS = ['1', '2', '3', '4', 'last'];
const DAY_MS = 86400000;

// 把当地日期折成公历日序号，改派来源后用来重算各行与新来源相差几天
function dayNumber(localDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate || '');
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

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

// 偏移的展示写法，半小时与三刻都要看得清
function offsetText(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hour = String(Math.floor(abs / 60)).padStart(2, '0');
  const minute = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hour}:${minute}`;
}

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
  const counts = zoneReferenceCounts(data);

  let list = data.zones;
  if (dst === 'yes') list = list.filter((item) => item.usesDst);
  if (dst === 'no') list = list.filter((item) => !item.usesDst);
  if (keyword) {
    list = list.filter((item) => item.name.toLowerCase().includes(keyword)
      || item.displayName.toLowerCase().includes(keyword)
      || item.note.toLowerCase().includes(keyword));
  }

  return {
    zones: sortZones(list).map((zone) => ({ ...withOffsetText(zone), referenceCount: counts.get(zone.id) || 0 })),
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

// 汇总一条档案被哪些地方用到：换算方案的来源时区、换算结果的来源时区、结果明细行
// 三类各返回列表与条数，引用总数与三份列表的条数之和严格对得上
function collectReferences(data, zone) {
  const plans = data.plans
    .filter((plan) => plan.sourceZoneId === zone.id)
    .map((plan) => ({
      id: plan.id,
      title: plan.title,
      date: plan.date,
      time: plan.time,
      sourceZoneId: plan.sourceZoneId,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      lastRunAt: plan.lastRunAt,
    }));

  const planTitleById = new Map(data.plans.map((plan) => [plan.id, plan.title]));
  const runs = [];
  const resultRows = [];
  data.runs.forEach((run) => {
    if (run.sourceZoneId === zone.id) {
      runs.push({
        id: run.id,
        planId: run.planId,
        planTitle: planTitleById.get(run.planId) || '',
        sourceZoneId: run.sourceZoneId,
        sourceName: run.sourceName,
        ranAt: run.ranAt,
      });
    }
    run.rows.forEach((row) => {
      if (row.zoneId === zone.id) {
        resultRows.push({
          runId: run.id,
          planId: run.planId,
          planTitle: planTitleById.get(run.planId) || '',
          ranAt: run.ranAt,
          role: run.sourceZoneId === zone.id ? 'source' : 'target',
          localDate: row.localDate,
          localTime: row.localTime,
        });
      }
    });
  });

  return {
    zone: { id: zone.id, name: zone.name, displayName: zone.displayName },
    plans,
    planCount: plans.length,
    runs,
    runCount: runs.length,
    resultRows,
    resultRowCount: resultRows.length,
    total: plans.length + runs.length + resultRows.length,
  };
}

function zoneReferenceCounts(data) {
  const counts = new Map(data.zones.map((zone) => [zone.id, 0]));
  data.plans.forEach((plan) => {
    if (counts.has(plan.sourceZoneId)) counts.set(plan.sourceZoneId, counts.get(plan.sourceZoneId) + 1);
  });
  data.runs.forEach((run) => {
    if (counts.has(run.sourceZoneId)) counts.set(run.sourceZoneId, counts.get(run.sourceZoneId) + 1);
    run.rows.forEach((row) => {
      if (counts.has(row.zoneId)) counts.set(row.zoneId, counts.get(row.zoneId) + 1);
    });
  });
  return counts;
}

// 单独查看一条档案的引用情况
function listZoneReferences(id) {
  const data = load();
  const found = data.zones.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'ZONE_NOT_FOUND', '这条时区档案不存在或已被删除', '');
  return collectReferences(data, found);
}

// 删除档案：没有确认一律不动；有引用时必须选 reassign（改派到别的档案）或 purge（连同引用清掉）
// 所有检查通过后只在内存里改，再一次性落盘，任何一步失败磁盘上的数据都不变
function deleteZone(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const found = data.zones.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'ZONE_NOT_FOUND', '这条时区档案不存在或已被删除', '');

  const refs = collectReferences(data, found);
  if (input.confirm !== true) {
    const err = new ApiError(409, 'DELETE_CONFIRM_REQUIRED', '请先看清这条档案被哪些地方引用，并确认处理方式后再删除', '');
    err.details = { references: refs };
    throw err;
  }

  let mode = pickText(input.mode);
  if (refs.total > 0) {
    if (mode !== 'reassign' && mode !== 'purge') {
      const err = new ApiError(409, 'ZONE_HAS_REFERENCES', `这条档案还被 ${refs.total} 处引用，要先改派到别的档案，或者确认连同引用一起清掉`, '');
      err.details = { references: refs };
      throw err;
    }
  } else {
    mode = mode || 'purge';
  }

  let target = null;
  if (mode === 'reassign') {
    const targetId = pickText(input.targetZoneId);
    if (!targetId) throw new ApiError(400, 'TARGET_ZONE_REQUIRED', '改派需要选择一条接收引用的档案', 'targetZoneId');
    if (targetId === id) throw new ApiError(400, 'TARGET_ZONE_SAME', '接收引用的档案不能就是正在删除的这条', 'targetZoneId');
    target = data.zones.find((item) => item.id === targetId);
    if (!target) throw new ApiError(404, 'TARGET_ZONE_NOT_FOUND', '接收引用的档案不存在或已被删除', 'targetZoneId');
  }

  const summary = {
    removed: { id: found.id, name: found.name, displayName: found.displayName },
    mode,
    targetZoneId: target ? target.id : null,
    reassignedPlans: 0,
    reassignedRuns: 0,
    removedPlans: 0,
    removedRuns: 0,
    removedResultRows: 0,
  };

  if (mode === 'reassign') {
    // 方案与结果里的来源时区引用改派到目标档案
    data.plans.forEach((plan) => {
      if (plan.sourceZoneId === id) {
        plan.sourceZoneId = target.id;
        plan.updatedAt = new Date().toISOString();
        summary.reassignedPlans += 1;
      }
    });
    data.runs.forEach((run) => {
      const sourceMoved = run.sourceZoneId === id;
      if (sourceMoved) {
        run.sourceZoneId = target.id;
        run.sourceName = target.name;
        run.sourceDisplayName = target.displayName;
        summary.reassignedRuns += 1;
      }
      // 结果明细行是按当时各档案偏移算出的：被删档案的行移除；来源改派的结果把目标档案的行标成来源行，
      // 时差与跨天按新来源的偏移与日期重算，避免留下自相矛盾的记录
      const kept = [];
      run.rows.forEach((row) => {
        if (row.zoneId === id) {
          summary.removedResultRows += 1;
          return;
        }
        if (sourceMoved) {
          row.isSource = row.zoneId === target.id;
          row.diffMinutes = row.offsetMinutes - target.offsetMinutes;
        }
        kept.push(row);
      });
      if (sourceMoved) {
        const sourceRow = kept.find((row) => row.zoneId === target.id);
        const sourceDay = sourceRow ? dayNumber(sourceRow.localDate) : null;
        if (sourceDay !== null) {
          kept.forEach((row) => {
            const day = dayNumber(row.localDate);
            row.dayOffset = day === null ? 0 : Math.round((day - sourceDay) / DAY_MS);
          });
        }
      }
      run.rows = kept;
    });
  } else {
    // 连同引用一起清掉：以该档案为来源的方案与结果整个删除，其余结果里关于它的明细行移除
    const dropPlanIds = new Set(data.plans.filter((plan) => plan.sourceZoneId === id).map((plan) => plan.id));
    summary.removedPlans = dropPlanIds.size;
    data.runs = data.runs.filter((run) => {
      if (run.sourceZoneId === id || dropPlanIds.has(run.planId)) {
        summary.removedRuns += 1;
        return false;
      }
      const before = run.rows.length;
      run.rows = run.rows.filter((row) => row.zoneId !== id);
      summary.removedResultRows += before - run.rows.length;
      return true;
    });
  }

  const index = data.zones.findIndex((item) => item.id === id);
  data.zones.splice(index, 1);
  save(data);
  return summary;
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

module.exports = {
  listZones,
  getZone,
  createZone,
  updateZone,
  deleteZone,
  listZoneReferences,
  collectReferences,
  offsetText,
  withOffsetText,
};
