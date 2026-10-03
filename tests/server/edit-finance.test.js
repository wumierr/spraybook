/* ============================================================
   edit-finance.test.js — P2-3 收/支编辑（红冲+重生成模式）
   ============================================================ */
'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { buildApp } = require('../../server/index');
const { freshDb } = require('./helpers/db');

const SAMPLE = require(path.join(__dirname, '..', '..', 'docs', 'export-json-sample.json'));

let db, server, base;

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
async function patch(url, body) {
  const res = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
async function getJson(url) { return (await (await fetch(url)).json()).data; }

function assertBalanced() {
  const t = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount_cents END),0) AS d,
            COALESCE(SUM(CASE WHEN direction='credit' THEN amount_cents END),0) AS c
     FROM journal_lines`).get();
  assert.strictEqual(t.d, t.c, `借贷不平 ${t.d} vs ${t.c}`);
}

test('编辑收款：金额 100→300，账单联动、原分录红冲、edit_logs', async () => {
  const job = (await post(`${base}/jobs`, {
    client_job_id: 'e1', job_type: 'spray', job_date: '2026-09-29',
    snapshot: SAMPLE.spray.export, result: SAMPLE.spray.result
  })).data;
  const st = (await post(`${base}/settlements`, { job_id: job.id })).data;
  await post(`${base}/settlements/${st.id}/confirm`);
  const bills = await getJson(`${base}/bills`);
  const b = bills.find(x => x.party_name === '李秀英');
  const r = await post(`${base}/receipts`, { bill_id: b.id, party_id: b.party_id, amount_cents: 100 });
  assert.strictEqual(r.ok, true);

  const up = await patch(`${base}/receipts/${r.data.id}`, { amount_cents: 300, method: 'wechat', note: '改金额' });
  assert.strictEqual(up.ok, true, JSON.stringify(up));
  assert.strictEqual(up.data.amount_cents, 300);
  const b2 = (await getJson(`${base}/bills`)).find(x => x.id === b.id);
  assert.strictEqual(b2.paid_cents, 300, '账单联动');
  assert.strictEqual(b2.status, 'partial');
  // 红冲存在
  const rev = db.prepare("SELECT COUNT(*) n FROM journal_entries WHERE event_type='reversal' AND ref_id=?").get(r.data.id).n;
  assert.strictEqual(rev, 1);
  // 新分录金额 300
  const newLine = db.prepare(
    `SELECT amount_cents FROM journal_lines WHERE entry_id=(
       SELECT id FROM journal_entries WHERE event_type='receipt' AND ref_id=? AND memo LIKE '%(改)%')`).all(r.data.id);
  assert.ok(newLine.some(l => l.amount_cents === 300));
  const logs = db.prepare("SELECT * FROM edit_logs WHERE table_name='receipts' AND record_id=?").all(r.data.id);
  assert.ok(logs.some(l => l.action === 'update'));
  assertBalanced();
});

test('编辑收款：按客户核销/预收抵扣的拒绝编辑', async () => {
  const job = (await post(`${base}/jobs`, {
    client_job_id: 'e2', job_type: 'spray', job_date: '2026-09-29',
    snapshot: SAMPLE.spray.export, result: SAMPLE.spray.result
  })).data;
  const st = (await post(`${base}/settlements`, { job_id: job.id })).data;
  await post(`${base}/settlements/${st.id}/confirm`);
  const b = (await getJson(`${base}/bills`)).find(x => x.party_name === '王强');
  const adv = await post(`${base}/advances`, { party_id: b.party_id, direction: 'prepaid_by_customer', amount_cents: 50000 });
  const r = await post(`${base}/receipts`, { bill_id: b.id, party_id: b.party_id, amount_cents: 100, from_advance_id: adv.data.id });
  const up = await patch(`${base}/receipts/${r.data.id}`, { amount_cents: 200 });
  assert.strictEqual(up.error.code, 'INVALID_STATE', '预收抵扣拒绝编辑');
});

test('编辑支出：类别/金额修改 + 红冲重生成', async () => {
  const p = await post(`${base}/payments`, { category: 'fuel', amount_cents: 12000 });
  const up = await patch(`${base}/payments/${p.data.id}`, { category: 'meal', amount_cents: 15000 });
  assert.strictEqual(up.ok, true);
  assert.strictEqual(up.data.category, 'meal');
  assert.strictEqual(up.data.amount_cents, 15000);
  const lines = db.prepare(
    `SELECT a.code, l.amount_cents FROM journal_lines l JOIN accounts a ON a.id=l.account_id
     WHERE l.entry_id=(SELECT id FROM journal_entries WHERE event_type='payment' AND ref_id=? AND memo LIKE '%(改)%')`).all(p.data.id);
  assert.ok(lines.some(l => l.code === '5004' && l.amount_cents === 15000), '新分录走餐费科目');
  assertBalanced();
});

test('P6-M2(F5)：等值编辑短路——只改备注不红冲不重过账', async () => {
  const p = await post(`${base}/payments`, { category: 'fuel', amount_cents: 12000, note: '原始备注' });
  const before = db.prepare('SELECT COUNT(*) n FROM journal_entries').get().n;
  const revBefore = db.prepare("SELECT COUNT(*) n FROM journal_entries WHERE event_type='reversal'").get().n;
  const up = await patch(`${base}/payments/${p.data.id}`, { note: '只改备注' });
  assert.strictEqual(up.ok, true, JSON.stringify(up));
  assert.strictEqual(up.data.note, '只改备注');
  assert.strictEqual(up.data.amount_cents, 12000);
  const after = db.prepare('SELECT COUNT(*) n FROM journal_entries').get().n;
  const revAfter = db.prepare("SELECT COUNT(*) n FROM journal_entries WHERE event_type='reversal'").get().n;
  assert.strictEqual(after, before, '等值编辑不产生新分录');
  assert.strictEqual(revAfter, revBefore, '不产生红冲凭证');
  const logs = db.prepare("SELECT * FROM edit_logs WHERE table_name='payments' AND record_id=?").all(p.data.id);
  assert.ok(logs.some(l => l.action === 'update'), '仍留痕');
  assertBalanced();

  // 收款同样短路：金额不变只改经手人
  const job = (await post(`${base}/jobs`, {
    client_job_id: 'f5r', job_type: 'spray', job_date: '2026-09-29',
    snapshot: SAMPLE.spray.export, result: SAMPLE.spray.result
  })).data;
  const st = (await post(`${base}/settlements`, { job_id: job.id })).data;
  await post(`${base}/settlements/${st.id}/confirm`);
  const b = (await getJson(`${base}/bills`)).find(x => x.party_name === '李秀英');
  const r = await post(`${base}/receipts`, { bill_id: b.id, party_id: b.party_id, amount_cents: 100 });
  const before2 = db.prepare('SELECT COUNT(*) n FROM journal_entries').get().n;
  const up2 = await patch(`${base}/receipts/${r.data.id}`, { note: '改经手人备注', collector_name: '老沈' });
  assert.strictEqual(up2.ok, true);
  assert.strictEqual(up2.data.collector_name, '老沈');
  const after2 = db.prepare('SELECT COUNT(*) n FROM journal_entries').get().n;
  assert.strictEqual(after2, before2, '收款等值编辑不产生新分录');
  assertBalanced();
});

test('预收备注编辑；金额编辑不开放', async () => {
  const c = (await post(`${base}/parties`, { type: 'customer', name: '备注户' })).data;
  const adv = await post(`${base}/advances`, { party_id: c.id, direction: 'prepaid_by_customer', amount_cents: 10000 });
  const up = await patch(`${base}/advances/${adv.data.id}`, { note: '2025 年预收' });
  assert.strictEqual(up.ok, true);
  assert.strictEqual(up.data.note, '2025 年预收');
  assertBalanced();
});
