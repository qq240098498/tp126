// 引用与删除策略的测试。TP126_DATA_DIR 必须在 require 任何服务端模块之前设置，
// store 在加载时按这个目录定数据文件，整套测试都在临时目录里跑，不碰正式的 data/db.json
process.env.TP126_DATA_DIR = require('path').join(__dirname, '..', 'tmp-test-data');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const store = require('../server/store');
const api = require('../server/api');

const DATA_DIR = process.env.TP126_DATA_DIR;

function resetDb() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

// 从落盘的文件重新载入，用来验证磁盘上的真实状态而不是内存里的对象
function rawDb() {
  return JSON.parse(fs.readFileSync(store.DATA_FILE, 'utf8'));
}

function makeZone(name, offsetMinutes, extra = {}) {
  return api.createZone({
    name,
    displayName: name,
    offsetMinutes,
    usesDst: false,
    dstOffsetMinutes: null,
    dstStart: null,
    dstEnd: null,
    fromYear: 1900,
    toYear: null,
    note: '',
    ...extra,
  });
}

function assertNoDanglingRefs(message) {
  const db = rawDb();
  const zoneIds = new Set(db.zones.map((z) => z.id));
  for (const scheme of db.schemes) {
    assert.ok(zoneIds.has(scheme.zoneId), `${message}：方案 ${scheme.id} 的来源档案悬空`);
  }
  for (const result of db.results) {
    assert.ok(zoneIds.has(result.sourceZoneId), `${message}：结果 ${result.id} 的来源档案悬空`);
    for (const row of result.rows) {
      assert.ok(zoneIds.has(row.zoneId), `${message}：结果 ${result.id} 的明细行档案悬空`);
    }
  }
}

test.beforeEach(() => resetDb());

test('种子数据读回来结构齐全', () => {
  const data = store.load();
  assert.ok(data.zones.length >= 10);
  assert.deepStrictEqual(data.schemes, []);
  assert.deepStrictEqual(data.results, []);
});

test('引用计数与三类清单条数严格对得上', () => {
  const del = makeZone('Test/Del', 480);
  const other = makeZone('Test/Other', 0);

  // 没有任何引用时三类都为零
  let refs = api.getZoneReferences(del.id);
  assert.strictEqual(refs.counts.totalCount, 0);
  assert.strictEqual(refs.schemeRefs.length, 0);
  assert.strictEqual(refs.resultSourceRefs.length, 0);
  assert.strictEqual(refs.resultRowRefs.length, 0);

  // del 作为方案来源并执行：方案 + 来源结果各计一次
  const schemeDel = api.createScheme({ name: '以del为来源', date: '2026-09-20', time: '09:30', zoneId: del.id });
  api.runScheme(schemeDel.id);

  // other 作为方案来源执行：del 只出现在该结果的明细行里
  const schemeOther = api.createScheme({ name: '以other为来源', date: '2026-09-20', time: '09:30', zoneId: other.id });
  api.runScheme(schemeOther.id);

  refs = api.getZoneReferences(del.id);
  assert.strictEqual(refs.schemeRefs.length, refs.counts.schemeCount);
  assert.strictEqual(refs.resultSourceRefs.length, refs.counts.resultSourceCount);
  assert.strictEqual(refs.resultRowRefs.length, refs.counts.resultRowCount);
  assert.strictEqual(refs.counts.schemeCount, 1);
  assert.strictEqual(refs.counts.resultSourceCount, 1);
  assert.strictEqual(refs.counts.resultRowCount, 1);
  assert.strictEqual(
    refs.counts.totalCount,
    refs.schemeRefs.length + refs.resultSourceRefs.length + refs.resultRowRefs.length,
  );
});

test('有引用时裸 DELETE 返回 409，档案与引用都保持原样', () => {
  const del = makeZone('Test/Del', 480);
  const scheme = api.createScheme({ name: '方案', date: '2026-09-20', time: '09:30', zoneId: del.id });

  assert.throws(
    () => api.deleteZone(del.id),
    (err) => err.status === 409 && err.code === 'ZONE_IN_USE',
  );

  // 档案还在、方案还在、引用关系没被改坏
  assert.ok(api.getZone(del.id));
  assert.strictEqual(api.getScheme(scheme.id).zoneId, del.id);
  assert.strictEqual(api.getZoneReferences(del.id).counts.totalCount, 1);
  assertNoDanglingRefs('409 之后');
});

test('没有引用的档案裸删成功', () => {
  const lonely = makeZone('Test/Lonely', 60);
  const out = api.deleteZone(lonely.id);
  assert.strictEqual(out.id, lonely.id);
  assert.throws(() => api.getZone(lonely.id), (err) => err.status === 404);
});

test('删除参数不合法时一律拦下且不落盘', () => {
  const del = makeZone('Test/Del', 480);
  const target = makeZone('Test/Target', 0);
  api.createScheme({ name: '方案', date: '2026-09-20', time: '09:30', zoneId: del.id });
  const before = rawDb();

  const cases = [
    [{}, 400, 'DELETE_STRATEGY_REQUIRED'],
    [{ strategy: 'cascade' }, 400, 'CONFIRM_REQUIRED'],
    [{ strategy: 'reassign' }, 400, 'TARGET_ZONE_REQUIRED'],
    [{ strategy: 'reassign', targetId: del.id }, 400, 'TARGET_ZONE_SAME'],
    [{ strategy: 'reassign', targetId: 'missing-id' }, 404, 'TARGET_ZONE_NOT_FOUND'],
    [{ strategy: 'bogus', confirm: true }, 400, 'DELETE_STRATEGY_REQUIRED'],
  ];
  for (const [payload, status, code] of cases) {
    assert.throws(
      () => api.deleteZoneWithStrategy(del.id, payload),
      (err) => err.status === status && err.code === code,
      `参数 ${JSON.stringify(payload)} 应被 ${code} 拦下`,
    );
  }

  // 一次都没有成功落盘：磁盘内容与开始前一致
  assert.strictEqual(JSON.stringify(rawDb()), JSON.stringify(before));
  assert.ok(api.getZone(del.id));
  assert.ok(api.getZone(target.id));
});

test('改挂：方案换来源、来源结果按同一刻重算、明细行换过去', () => {
  const del = makeZone('Test/Del', 480);
  const target = makeZone('Test/Target', 0);
  const other = makeZone('Test/Other', -300);

  const schemeDel = api.createScheme({ name: 'del来源方案', date: '2026-09-20', time: '09:30', zoneId: del.id });
  const r1 = api.runScheme(schemeDel.id);
  const schemeOther = api.createScheme({ name: 'other来源方案', date: '2026-09-20', time: '12:00', zoneId: other.id });
  const r2 = api.runScheme(schemeOther.id);

  const baseUtc = r1.baseUtcTime; // 2026-09-20 09:30 东八区 = 01:30Z

  const out = api.deleteZoneWithStrategy(del.id, { strategy: 'reassign', targetId: target.id });
  assert.strictEqual(out.counts.reassignedSchemes, 1);
  assert.strictEqual(out.counts.recomputedResults, 1);
  assert.strictEqual(out.counts.trimmedResults, 1);

  assert.throws(() => api.getZone(del.id), (err) => err.status === 404);

  // 方案改挂
  assert.strictEqual(api.getScheme(schemeDel.id).zoneId, target.id);

  // 来源结果按同一基准时刻重算：基准时刻不变，新来源（UTC）当地时间应是 01:30
  const newR1 = api.getResult(r1.id);
  assert.strictEqual(newR1.baseUtcTime, baseUtc);
  assert.strictEqual(newR1.sourceZoneId, target.id);
  const sourceRow = newR1.rows.find((row) => row.zoneId === target.id);
  assert.ok(sourceRow.isSource);
  assert.strictEqual(sourceRow.localDate, '2026-09-20');
  assert.strictEqual(sourceRow.localTime, '01:30');
  assert.ok(!newR1.rows.some((row) => row.zoneId === del.id));

  // 另一条结果只是明细行引用：旧行没了，新档案补进行里
  const newR2 = api.getResult(r2.id);
  assert.strictEqual(newR2.sourceZoneId, other.id);
  assert.ok(!newR2.rows.some((row) => row.zoneId === del.id));
  assert.ok(newR2.rows.some((row) => row.zoneId === target.id));

  assertNoDanglingRefs('改挂之后');
});

test('级联：引用它的方案与来源结果整条删除，其它结果只剔明细行', () => {
  const del = makeZone('Test/Del', 480);
  const other = makeZone('Test/Other', 0);

  const schemeDel = api.createScheme({ name: 'del来源方案', date: '2026-09-20', time: '09:30', zoneId: del.id });
  api.runScheme(schemeDel.id);
  const schemeOther = api.createScheme({ name: 'other来源方案', date: '2026-09-20', time: '09:30', zoneId: other.id });
  const r2 = api.runScheme(schemeOther.id);
  const rowsBefore = r2.rows.length;

  const out = api.deleteZoneWithStrategy(del.id, { strategy: 'cascade', confirm: true });
  assert.strictEqual(out.counts.removedSchemes, 1);
  assert.strictEqual(out.counts.removedResults, 1);
  assert.strictEqual(out.counts.trimmedResults, 1);

  assert.throws(() => api.getScheme(schemeDel.id), (err) => err.status === 404);
  const schemes = api.listSchemes().schemes;
  assert.strictEqual(schemes.length, 1);
  assert.strictEqual(schemes[0].id, schemeOther.id);

  const results = api.listResults().results;
  assert.strictEqual(results.length, 1);
  const kept = api.getResult(r2.id);
  assert.strictEqual(kept.rows.length, rowsBefore - 1);
  assert.ok(!kept.rows.some((row) => row.zoneId === del.id));

  assertNoDanglingRefs('级联之后');
});

test('删除过程中失败时不留半删状态：档案还在、引用没被改坏', () => {
  const del = makeZone('Test/Del', 480);
  const target = makeZone('Test/Target', 0);

  const scheme = api.createScheme({ name: '方案', date: '2026-09-20', time: '09:30', zoneId: del.id });
  const result = api.runScheme(scheme.id);

  // 人为把来源结果的基准时刻写坏：改挂重算时 Date.parse 得到 NaN，业务层在落盘前主动中止
  const dbOnDisk = rawDb();
  const broken = dbOnDisk.results.find((item) => item.id === result.id);
  broken.baseUtcTime = 'not-a-time';
  fs.writeFileSync(store.DATA_FILE, `${JSON.stringify(dbOnDisk, null, 2)}\n`);
  // 快照在写坏之后拍：中止删除时磁盘应原样停在这一刻，没有任何改动
  const before = rawDb();

  assert.throws(
    () => api.deleteZoneWithStrategy(del.id, { strategy: 'reassign', targetId: target.id }),
    (err) => err.status === 500 && err.code === 'RESULT_TIME_BROKEN',
  );

  // 磁盘仍是删除前的完整状态
  const after = rawDb();
  assert.strictEqual(JSON.stringify(after, null, 2), JSON.stringify(before, null, 2));
  assert.ok(api.getZone(del.id));
  assert.strictEqual(api.getScheme(scheme.id).zoneId, del.id);
  assert.strictEqual(api.getResult(result.id).sourceZoneId, del.id);
});

test('查看不存在档案的引用返回 404', () => {
  assert.throws(() => api.getZoneReferences('no-such-zone'), (err) => err.status === 404);
});

// ---- 真实 HTTP 路由冒烟：确认路由、状态码与 JSON 错误格式都对得上 ----
test('HTTP：引用查询、409 拦截、确认后改挂删除整条链路', async (t) => {
  const httpDir = path.join(__dirname, '..', 'tmp-test-http');
  fs.rmSync(httpDir, { recursive: true, force: true });
  const port = 15126;
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port), TP126_DATA_DIR: httpDir },
  });
  const base = `http://127.0.0.1:${port}`;

  async function waitReady() {
    for (let i = 0; i < 50; i += 1) {
      try {
        const res = await fetch(`${base}/api/health`);
        if (res.ok) return;
      } catch (_) { /* 还没起来，继续等 */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('测试服务器没起来');
  }

  t.after(() => {
    server.kill();
    fs.rmSync(httpDir, { recursive: true, force: true });
  });

  await waitReady();

  const zones = await (await fetch(`${base}/api/zones`)).json();
  const del = zones.zones.find((z) => z.name === 'Asia/Shanghai');
  const target = zones.zones.find((z) => z.name === 'UTC');

  const created = await fetch(`${base}/api/schemes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'HTTP方案', date: '2026-09-20', time: '09:30', zoneId: del.id }),
  });
  assert.strictEqual(created.status, 201);
  const scheme = await created.json();

  const run = await fetch(`${base}/api/schemes/${scheme.id}/run`, { method: 'POST' });
  assert.strictEqual(run.status, 201);

  const refsRes = await fetch(`${base}/api/zones/${del.id}/references`);
  assert.strictEqual(refsRes.status, 200);
  const refs = await refsRes.json();
  assert.ok(refs.counts.totalCount >= 2);

  const bare = await fetch(`${base}/api/zones/${del.id}`, { method: 'DELETE' });
  assert.strictEqual(bare.status, 409);
  const bareBody = await bare.json();
  assert.strictEqual(bareBody.error.code, 'ZONE_IN_USE');

  const noConfirm = await fetch(`${base}/api/zones/${del.id}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strategy: 'cascade' }),
  });
  assert.strictEqual(noConfirm.status, 400);

  const done = await fetch(`${base}/api/zones/${del.id}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strategy: 'reassign', targetId: target.id }),
  });
  assert.strictEqual(done.status, 200);

  const missing = await fetch(`${base}/api/zones/${del.id}/references`);
  assert.strictEqual(missing.status, 404);
});
