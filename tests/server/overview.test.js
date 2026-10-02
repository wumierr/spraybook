/* ============================================================
   overview.test.js — P4-M1 总表端点测试
   覆盖：行数=作业单粒度 / 字段齐全 / 金额口径（amount/paid/discount/due）
   / 只读性（端点往返不写任何表）/ from·to·status·limit 过滤 / PATCH 联动
   ============================================================ */
'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { buildApp } = require('../../server/index');
const { freshDb } = require('./helpers/db');

const SAMPLE = require(path.join(__dirname, '..', '..', 'docs', 'export-json-sample.json'));

let db, server, base;
let seq = 0;

beforeEach(async () => {
  db = freshDb();
  const app = buildApp(db);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});
afterEach(async () => {
  if (server) { await new Promise(r => server.close(r)); server = null; }
});

async function json(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json() };
}
async function patch(url, body) {
  const res = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

async function createJob(jobDate) {
  seq += 1;
  const p = {
    client_job_id: `ov-${seq}-${Date.now()}`, job_type: 'spray', job_date: jobDate || '2026-09-29',
    snapshot: SAMPLE.spray.export, result: SAMPLE.spray.result
  };
  const r = await post(`${base}/jobs`, p);
  assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
  return r.body.data;
}
/** 生成结算并确认 → 每农户一张 unpaid 账单（返回 confirm 响应，bills 已生成） */
async function settleAndConfirm(jobId) {
  const st = (await post(`${base}/settlements`, { job_id: jobId })).body.data;
  const cf = await post(`${base}/settlements/${st.id}/confirm`);
  assert.strictEqual(cf.body.ok, true, JSON.stringify(cf.body));
  return cf.body.data;
}
async function getOverview(qs) {
  const r = await json(`${base}/overview${qs || ''}`);
  assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
  return r.body.data;
}

const EXPECT_FIELDS = [
  'id', 'job_no', 'job_date', 'job_status', 'source', 'job_type', 'total_area_mu',
  'income_cents', 'note', 'referral_name', 'operator_names', 'plant_label',
  'customer_names', 'region', 'village', 'team', 'unit_price_cents',
  'amount_cents', 'paid_cents', 'discount_cents', 'due_cents',
  'bill_statuses', 'bill_count', 'extra_cents', 'collector_name',
  'bill_id', 'bill_party_id', 'bill_adjust', 'bill_note'
];

test('总表：行=作业单（多账单聚成一行），字段齐全，totals 与行合计一致', async () => {
  const job = await createJob();
  const st = await settleAndConfirm(job.id);
  assert.strictEqual(st.bills.length, 3, '3 张账单（测试前置）');

  const data = await getOverview();
  assert.strictEqual(data.rows.length, 1, '3 张账单聚成 1 行（行=作业单）');
  const row = data.rows[0];
  for (const f of EXPECT_FIELDS) assert.ok(f in row, `缺字段 ${f}`);
  assert.strictEqual(row.job_no, job.job_no);
  assert.strictEqual(row.job_status, 'settled');
  assert.strictEqual(row.bill_count, 3);
  assert.strictEqual(row.bill_statuses, 'unpaid', 'bill_statuses=去重状态集合（3 张同 unpaid）');
  const sumBills = st.bills.reduce((a, b) => a + b.amount_cents, 0);
  assert.strictEqual(row.amount_cents, sumBills, '应收=Σbills.amount');
  assert.strictEqual(row.paid_cents, 0);
  assert.strictEqual(row.due_cents, sumBills, '未收=应收（零收款零抹零）');
  assert.strictEqual(row.discount_cents, 0);
  assert.ok(Array.isArray(row.operator_names), 'operator_names 服务端解析成数组');
  for (const n of ['李秀英', '王强', '张大国']) {
    assert.ok(row.customer_names.includes(n), `customer_names 含 ${n}`);
  }
  assert.strictEqual(row.plant_label, '杀菌', 'plant_label 回退 plant_type_name');
  // totals 三平：totals 与行合计同源
  assert.strictEqual(data.totals.row_count, 1);
  assert.strictEqual(data.totals.amount_cents, sumBills);
  assert.strictEqual(data.totals.paid_cents, 0);
  assert.strictEqual(data.totals.due_cents, sumBills);
  assert.strictEqual(data.totals.discount_cents, 0);
});

test('总表只读：端点往返（含过滤参数）不写任何业务表/分录/留痕', async () => {
  const job = await createJob();
  await settleAndConfirm(job.id);
  await post(`${base}/payments`, { category: 'fuel', amount_cents: 12000, note: '加油站' });

  const TABLES = ['jobs', 'settlements', 'settlement_items', 'bills', 'receipts', 'payments',
    'advances', 'advance_usages', 'manual_splits', 'journal_entries', 'journal_lines', 'edit_logs'];
  const snapshot = () => Object.fromEntries(TABLES.map(t =>
    [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
  const before = snapshot();
  await getOverview();
  await getOverview('?from=2026-01-01&to=2026-12-31&status=settled&limit=1');
  await getOverview('?limit=1');
  assert.deepStrictEqual(snapshot(), before, '总表端点不得写库（行数逐一相等）');
});

test('总表金额口径：抹零=|adjust| 恒正；due 仅 unpaid/partial 计 (amount−|adjust|−paid)；PATCH/收款/作废联动', async () => {
  const job = await createJob();
  const st = await settleAndConfirm(job.id);
  const bills = (await json(`${base}/bills`)).body.data.sort((a, b) => a.id - b.id);
  assert.strictEqual(bills.length, 3);

  // 1) 抹零（负=优惠）落在 unpaid 账单上：discount=100、due=总额−100
  const total0 = bills.reduce((a, b) => a + b.amount_cents, 0);
  await patch(`${base}/bills/${bills[0].id}`, { adjust_cents: -100 });
  let row = (await getOverview()).rows[0];
  assert.strictEqual(row.discount_cents, 100, '抹零列=|adjust|');
  assert.strictEqual(row.amount_cents, total0);
  assert.strictEqual(row.due_cents, total0 - 100, 'due=amount−|adjust|−paid');

  // 2) PATCH 金额联动：bills[1] +500
  await patch(`${base}/bills/${bills[1].id}`, { amount_cents: bills[1].amount_cents + 500 });
  row = (await getOverview()).rows[0];
  assert.strictEqual(row.amount_cents, total0 + 500, '应收=改后 Σbills.amount');
  assert.strictEqual(row.due_cents, total0 + 400);

  // 3) 收款至 payable（amount+adjust，负 adjust 两口径一致）→ 账单 paid、due 扣减
  const rc = await post(`${base}/receipts`, {
    bill_id: bills[0].id, party_id: bills[0].party_id,
    amount_cents: bills[0].amount_cents - 100
  });
  assert.strictEqual(rc.body.ok, true, JSON.stringify(rc.body));
  row = (await getOverview()).rows[0];
  assert.strictEqual(row.paid_cents, bills[0].amount_cents - 100, '实收=Σbills.paid');
  assert.strictEqual(row.due_cents, total0 + 400 - (bills[0].amount_cents - 100), '已清账单不再计 due');
  assert.ok(row.bill_statuses.split(',').includes('paid'));

  // 4) 作废收款 → 账单回退 unpaid，总表同步回退
  await post(`${base}/receipts/${rc.body.data.id}/void`);
  row = (await getOverview()).rows[0];
  assert.strictEqual(row.paid_cents, 0);
  assert.strictEqual(row.due_cents, total0 + 400);
});

test('总表：purpose 列（008）优先于 plant_type_name（COALESCE）', async () => {
  const job = await createJob();
  await settleAndConfirm(job.id);
  db.prepare('UPDATE jobs SET purpose = ? WHERE id = ?').run('清园', job.id);
  const row = (await getOverview()).rows[0];
  assert.strictEqual(row.plant_label, '清园', 'purpose 非空时优先');
  db.prepare('UPDATE jobs SET purpose = NULL WHERE id = ?').run(job.id);
  const row2 = (await getOverview()).rows[0];
  assert.strictEqual(row2.plant_label, '杀菌', 'purpose 空时回退 plant_type_name');
});

test('总表过滤：from/to/status/limit；void 作业排除；未结算作业 bill_count=0', async () => {
  const jobA = await createJob('2026-09-01');
  const jobB = await createJob('2026-09-29');
  await settleAndConfirm(jobA.id); // A settled；B 保持 completed（未结算）

  let data = await getOverview();
  assert.strictEqual(data.rows.length, 2);
  const rowB = data.rows.find(r => r.job_no === jobB.job_no);
  assert.strictEqual(rowB.bill_count, 0, '未结算作业无账单');
  assert.strictEqual(rowB.amount_cents, 0);
  assert.strictEqual(rowB.due_cents, 0);

  data = await getOverview('?from=2026-09-15&to=2026-09-30');
  assert.strictEqual(data.rows.length, 1);
  assert.strictEqual(data.rows[0].job_no, jobB.job_no, 'from/to 落在 job_date');

  data = await getOverview('?status=settled');
  assert.deepStrictEqual(data.rows.map(r => r.job_no), [jobA.job_no], 'status 过滤作业状态');

  data = await getOverview('?limit=1');
  assert.strictEqual(data.rows.length, 1, 'limit 生效');

  // void 作业排除
  await post(`${base}/jobs/${jobB.id}/void`);
  data = await getOverview();
  assert.strictEqual(data.rows.length, 1, 'void 作业不进总表');
  assert.strictEqual(data.totals.row_count, 1);
});
