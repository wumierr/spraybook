/* ============================================================
   jobs.api.test.js — M2 API 验证（app.listen(0) + 原生 fetch）
   请求体直接用 docs/export-json-sample.json 的真实样本。
   ============================================================ */
'use strict';

const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { buildApp } = require('../../server/index');
const { freshDb } = require('./helpers/db');

const SAMPLE = require(path.join(__dirname, '..', '..', 'docs', 'export-json-sample.json'));

let db, app, server, base;
let seq = 0;

beforeEach(async () => {
  db = freshDb();
  app = buildApp(db);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});
afterEach(async () => {
  if (server) { await new Promise(r => server.close(r)); server = null; }
});
after(() => { if (server) server.close(); });

function sprayPayload(overrides = {}) {
  seq += 1;
  return {
    client_job_id: `test-job-${seq}-${Math.random().toString(36).slice(2, 8)}`,
    job_no: `20260929-T${String(seq).padStart(3, '0')}`,
    job_type: 'spray',
    job_date: '2026-09-29',
    operator_names: ['测试飞手'],
    snapshot: SAMPLE.spray.export,
    result: SAMPLE.spray.result,
    ...overrides
  };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}

test('health：db ok', async () => {
  const res = await fetch(`${base}/health`);
  const j = await res.json();
  assert.strictEqual(j.ok, true);
  assert.strictEqual(j.data.db, 'ok');
});

test('POST /api/jobs：样本写入完整，金额转分，行数正确', async () => {
  const p = sprayPayload();
  const { status, json } = await postJson(`${base}/jobs`, p);
  assert.strictEqual(status, 200, JSON.stringify(json));
  assert.strictEqual(json.ok, true);
  assert.strictEqual(json.data.duplicated, false);
  // 客户端自带 job_no 原样入库；服务端生成/重生成的格式在冲突用例验证
  assert.match(json.data.job_no, /^20260929-\w{4}$/);

  const res = await fetch(`${base}/jobs/${json.data.id}`);
  const job = (await res.json()).data;
  assert.strictEqual(job.job_type, 'spray');
  assert.strictEqual(job.plots.length, 4, '4 地块');
  assert.strictEqual(job.groups.length, 3, '3 作业组');
  assert.strictEqual(job.settlement_lines.length, 3, '3 农户');
  // 李秀英 14亩×8元=112元 → 11200 分；补充 6.84×80元=547.2元 → 54720 分
  const li = job.settlement_lines.find(l => l.farmer_name === '李秀英');
  assert.strictEqual(li.spray_fee_cents, 11200);
  assert.strictEqual(li.pesticide_fee_cents, 54720);
  assert.strictEqual(job.income_cents, Math.round(SAMPLE.spray.result.income * 100), 'income 快照元→分');
  assert.deepStrictEqual(job.operator_names, ['测试飞手']);
  assert.ok(job.raw && job.raw.snapshot, 'raw_json 保留快照');
});

test('幂等：同 client_job_id 重推返回原单，不重复写', async () => {
  const p = sprayPayload();
  const r1 = await postJson(`${base}/jobs`, p);
  const r2 = await postJson(`${base}/jobs`, { ...p, job_no: '20260929-ZZ99' }); // job_no 不同也不行
  assert.strictEqual(r2.json.data.duplicated, true);
  assert.strictEqual(r2.json.data.id, r1.json.data.id);
  assert.strictEqual(r2.json.data.job_no, r1.json.data.job_no, '返回原 job_no');
  const cnt = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
  assert.strictEqual(cnt, 1, '库里只有一单');
});

test('job_no 冲突：服务端重生成并回传最终号', async () => {
  const p1 = sprayPayload();
  await postJson(`${base}/jobs`, p1);
  const p2 = sprayPayload({ job_no: p1.job_no }); // 同号不同 client_job_id
  const { json } = await postJson(`${base}/jobs`, p2);
  assert.strictEqual(json.ok, true);
  assert.notStrictEqual(json.data.job_no, p1.job_no, '重生成');
  assert.match(json.data.job_no, /^20260929-[A-Z2-9]{4}$/);
});

test('PATCH 物理量字段 → PHYSICAL_FIELD_READONLY', async () => {
  const created = (await postJson(`${base}/jobs`, sprayPayload())).json;
  const res = await fetch(`${base}/jobs/${created.data.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ total_area_mu: 99 })
  });
  const j = await res.json();
  assert.strictEqual(res.status, 400);
  assert.strictEqual(j.error.code, 'PHYSICAL_FIELD_READONLY');
});

test('PATCH 金额更正：重算 income/profit，edit_logs 留痕', async () => {
  const created = (await postJson(`${base}/jobs`, sprayPayload())).json;
  const detail = (await (await fetch(`${base}/jobs/${created.data.id}`)).json()).data;
  const line = detail.settlement_lines[0];
  const res = await fetch(`${base}/jobs/${created.data.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      note: '改备注',
      lines: [{ id: line.id, spray_fee_cents: 10000 }]
    })
  });
  const j = await res.json();
  assert.strictEqual(j.ok, true, JSON.stringify(j));
  const patched = j.data;
  const sumSpray = patched.settlement_lines.reduce((a, l) => a + l.spray_fee_cents, 0);
  const sumPest = patched.settlement_lines.reduce((a, l) => a + l.pesticide_fee_cents, 0);
  assert.strictEqual(patched.income_cents, sumSpray + sumPest, 'income=Σ(spray+pesticide)');
  assert.strictEqual(patched.note, '改备注');
  const logs = db.prepare("SELECT * FROM edit_logs WHERE table_name='jobs' AND record_id=?").all(created.data.id);
  assert.ok(logs.some(l => l.action === 'create') && logs.some(l => l.action === 'update'));
});

test('状态机：void 后 PATCH → INVALID_STATE', async () => {
  const created = (await postJson(`${base}/jobs`, sprayPayload())).json;
  await fetch(`${base}/jobs/${created.data.id}/void`, { method: 'POST' });
  const res = await fetch(`${base}/jobs/${created.data.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'x' })
  });
  assert.strictEqual((await res.json()).error.code, 'INVALID_STATE');
});

test('客户 upsert 只建不改：重复同步不新增 parties', async () => {
  await postJson(`${base}/jobs`, sprayPayload());
  const n1 = db.prepare("SELECT COUNT(*) AS n FROM parties WHERE type='customer'").get().n;
  assert.ok(n1 >= 3, `至少 3 个客户（张大国/李秀英/王强），实际 ${n1}`);
  const zhang = db.prepare("SELECT * FROM parties WHERE name='张大国'").get();
  assert.strictEqual(zhang.phone, '13900001111');
  assert.strictEqual(zhang.default_price_cents, 900, '9元/亩→900分');
  assert.strictEqual(zhang.source, 'calculator');
  await postJson(`${base}/jobs`, sprayPayload()); // 第二单同批农户
  const n2 = db.prepare("SELECT COUNT(*) AS n FROM parties WHERE type='customer'").get().n;
  assert.strictEqual(n2, n1, '已存在不覆盖不新增');
});

test('吊运样本：无结算行，斤数与分/斤单价正确', async () => {
  const p = sprayPayload({ job_type: 'haul', result: SAMPLE.haul.result, snapshot: SAMPLE.haul.export });
  const { json } = await postJson(`${base}/jobs`, p);
  const job = (await (await fetch(`${base}/jobs/${json.data.id}`)).json()).data;
  assert.strictEqual(job.weight_jin, 3500);
  assert.strictEqual(job.haul_price_cents_per_jin, 80, '8毛/斤 → 80分/斤');
  assert.strictEqual(job.settlement_lines.length, 0, '吊运无分家行');
  assert.strictEqual(job.income_cents, 280000, '2800元→分');
});

test('007 成本构成落列：spray Σ构成==total_cost；haul 人工合并 drone+pickup', async () => {
  const { json } = await postJson(`${base}/jobs`, sprayPayload());
  const job = (await (await fetch(`${base}/jobs/${json.data.id}`)).json()).data;
  // 样本 costBreakdown {cycle:3, fuel:120, labor:315, pesticide:1600, equipment:23.4, other:15}
  assert.strictEqual(job.labor_cost_cents, 31500);
  assert.strictEqual(job.pesticide_cost_cents, 160000);
  assert.strictEqual(job.equipment_cost_cents, 2340);
  assert.strictEqual(job.misc_cost_cents, 1500);
  assert.strictEqual(job.subsidy_cents, 0, '补贴 0 元 → 0 分（合法快照）');
  const sumParts = job.battery_depreciation_cents + job.fuel_expense_cents
    + job.labor_cost_cents + job.pesticide_cost_cents + job.equipment_cost_cents + job.misc_cost_cents;
  assert.strictEqual(sumParts, job.total_cost_cents, 'Σ构成快照 == total_cost（2076.4 元）');

  const r2 = await postJson(`${base}/jobs`, sprayPayload({
    job_type: 'haul', result: SAMPLE.haul.result, snapshot: SAMPLE.haul.export }));
  const hj = (await (await fetch(`${base}/jobs/${r2.json.data.id}`)).json()).data;
  assert.strictEqual(hj.labor_cost_cents, 55000, 'droneLabor 550 + pickupLabor 0');
  assert.strictEqual(hj.misc_cost_cents, 1000);
  assert.strictEqual(hj.pesticide_cost_cents, null, '吊运无药剂成本');
  assert.strictEqual(hj.subsidy_cents, null, '吊运无补贴');
});

test('GET /api/jobs?status= 过滤', async () => {
  await postJson(`${base}/jobs`, sprayPayload());
  const all = (await (await fetch(`${base}/jobs`)).json()).data;
  assert.strictEqual(all.length, 1);
  const none = (await (await fetch(`${base}/jobs?status=settled`)).json()).data;
  assert.strictEqual(none.length, 0);
  const some = (await (await fetch(`${base}/jobs?status=completed`)).json()).data;
  assert.strictEqual(some.length, 1);
});
