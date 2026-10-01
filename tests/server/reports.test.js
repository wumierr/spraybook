/* ============================================================
   reports.test.js — M6 报表与按客户 FIFO 核销
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

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return res.json();
}
async function getJson(url) {
  return (await (await fetch(url)).json()).data;
}
async function createSettledJob() {
  seq += 1;
  const p = {
    client_job_id: `r-${seq}-${Date.now()}`, job_type: 'spray', job_date: '2026-09-2' + (seq % 10),
    snapshot: SAMPLE.spray.export, result: SAMPLE.spray.result
  };
  const job = (await post(`${base}/jobs`, p)).data;
  const st = (await post(`${base}/settlements`, { job_id: job.id })).data;
  await post(`${base}/settlements/${st.id}/confirm`);
  return { job, st };
}

function assertBalanced() {
  const rows = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount_cents END),0) AS d,
            COALESCE(SUM(CASE WHEN direction='credit' THEN amount_cents END),0) AS c
     FROM journal_lines`).get();
  assert.strictEqual(rows.d, rows.c, `总账借贷不平: ${rows.d} vs ${rows.c}`);
}

test('按客户收款：FIFO 核销两张账单 + 余额转预收；作废全联动回退', async () => {
  // 同一客户张大国两张账单（两单作业）
  await createSettledJob();
  await createSettledJob();
  const bills = (await getJson(`${base}/bills`)).filter(b => b.party_name === '张大国');
  assert.strictEqual(bills.length, 2, '张大国两张账单');
  const older = bills.reduce((a, b) => (a.id < b.id ? a : b));
  const newer = bills.reduce((a, b) => (a.id > b.id ? a : b));
  const olderUnpaid = older.amount_cents + older.adjust_cents - older.paid_cents;
  const newerUnpaid = newer.amount_cents + newer.adjust_cents - newer.paid_cents;
  const total = olderUnpaid + newerUnpaid;

  // 一笔钱 = 两单全清 + 5000 余额
  const rc = await post(`${base}/receipts`, {
    party_id: older.party_id, amount_cents: total + 5000, method: 'cash'
  });
  assert.strictEqual(rc.ok, true, JSON.stringify(rc));
  const allocations = JSON.parse(rc.data.allocations);
  assert.deepStrictEqual(allocations.items.map(a => a.bill_id), [older.id, newer.id], 'FIFO 先老后新');
  assert.strictEqual(allocations.items[0].amount_cents, olderUnpaid);
  assert.ok(allocations.remainder_advance_id, '余额生成预收');

  const b1 = (await getJson(`${base}/bills`)).find(b => b.id === older.id);
  const b2 = (await getJson(`${base}/bills`)).find(b => b.id === newer.id);
  assert.strictEqual(b1.status, 'paid');
  assert.strictEqual(b2.status, 'paid');
  const adv = db.prepare('SELECT * FROM advances WHERE id = ?').get(allocations.remainder_advance_id);
  assert.strictEqual(adv.balance_cents, 5000);
  assert.strictEqual(adv.direction, 'prepaid_by_customer');

  assertBalanced();

  // 作废该收款：两张账单回未清、余额预收联动作废
  await post(`${base}/receipts/${rc.data.id}/void`);
  const b1v = (await getJson(`${base}/bills`)).find(b => b.id === older.id);
  const b2v = (await getJson(`${base}/bills`)).find(b => b.id === newer.id);
  assert.strictEqual(b1v.status, 'unpaid');
  assert.strictEqual(b2v.status, 'unpaid');
  const advV = db.prepare('SELECT * FROM advances WHERE id = ?').get(allocations.remainder_advance_id);
  assert.strictEqual(advV.status, 'void');
  assert.strictEqual(advV.balance_cents, 0);
  assertBalanced();
});

test('按客户收款：钱不够全清时只核销最老的账单', async () => {
  await createSettledJob();
  await createSettledJob();
  const bills = (await getJson(`${base}/bills`)).filter(b => b.party_name === '张大国');
  const older = bills.reduce((a, b) => (a.id < b.id ? a : b));
  const olderUnpaid = older.amount_cents + older.adjust_cents - older.paid_cents;

  const rc = await post(`${base}/receipts`, { party_id: older.party_id, amount_cents: olderUnpaid - 100 });
  assert.strictEqual(rc.ok, true);
  const allocations = JSON.parse(rc.data.allocations);
  assert.strictEqual(allocations.items.length, 1, '只核销一张');
  assert.strictEqual(allocations.remainder_advance_id, null, '无余额不转预收');
  const b = (await getJson(`${base}/bills`)).find(b => b.id === older.id);
  assert.strictEqual(b.status, 'partial');
  assertBalanced();
});

test('报表：summary/by-month/by-customer/by-job 数字与手账一致', async () => {
  const { st } = await createSettledJob();
  await post(`${base}/payments`, { category: 'fuel', amount_cents: 12000, note: '油费' });
  await post(`${base}/payments`, { category: 'meal', amount_cents: 3000, note: '午饭' });
  // 张大国账单收清
  const bills = (await getJson(`${base}/bills`)).filter(b => b.party_name === '张大国');
  const zUnpaid = bills.reduce((a, b) => a + b.amount_cents + b.adjust_cents - b.paid_cents, 0);
  await post(`${base}/receipts`, { party_id: bills[0].party_id, amount_cents: zUnpaid });

  const s = await getJson(`${base}/reports/summary`);
  assert.strictEqual(s.income_cents, st.total_receivable_cents, '收入=确认结算合计');
  assert.strictEqual(s.expense_cents, 15000, '支出=12000+3000');
  assert.strictEqual(s.profit_cents, st.total_receivable_cents - 15000);
  assert.ok(s.expense_by_category.some(c => c.code === '5002' && c.cents === 12000));

  const months = await getJson(`${base}/reports/by-month`);
  assert.strictEqual(months.length, 1);
  // occurred_at 用确认时刻（真实当前日期），不写死月份——利润必须与 summary 一致
  assert.strictEqual(months[0].profit_cents, s.profit_cents);

  const custs = await getJson(`${base}/reports/by-customer`);
  const zhang = custs.find(c => c.name === '张大国');
  assert.ok(zhang, '按客户收入有张大国');
  assert.ok(zhang.income_cents > 0);
  assert.strictEqual(zhang.receivable_cents, 0, '张大国已收清');

  const byJobs = await getJson(`${base}/reports/by-job`);
  assert.strictEqual(byJobs.length, 1);
  assert.strictEqual(byJobs[0].profit_cents, Math.round(SAMPLE.spray.result.profit * 100), '作业利润=income-cost（样本 -1659.4 元）');
  assertBalanced();
});

test('party balance：欠款/预收/最近作业', async () => {
  await createSettledJob();
  const parties = await getJson(`${base}/parties`);
  const li = parties.find(p => p.name === '李秀英');
  const bal = await getJson(`${base}/parties/${li.id}/balance`);
  assert.strictEqual(bal.party.name, '李秀英');
  assert.ok(bal.receivable_cents > 0, '李秀英有欠款');
  assert.ok(bal.last_job, '有最近作业');
});
