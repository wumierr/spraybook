/* ============================================================
   masterdata.test.js — M7 主数据 CRUD + bootstrap + settings + 期初兜底
   ============================================================ */
'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
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

test('主数据 CRUD：parties 创建/编辑/软删 + edit_logs 留痕', async () => {
  const c = await post(`${base}/parties`, { type: 'customer', name: '测试新户', village: '红拉', team: '7', default_price_cents: 2500 });
  assert.strictEqual(c.ok, true);
  const id = c.data.id;
  const up = await patch(`${base}/parties/${id}`, { phone: '139', default_price_cents: 2600 });
  assert.strictEqual(up.ok, true);
  assert.strictEqual(up.data.phone, '139');
  const logs = db.prepare("SELECT * FROM edit_logs WHERE table_name='parties' AND record_id=?").all(id);
  assert.ok(logs.some(l => l.action === 'create') && logs.some(l => l.action === 'update'));
  await post(`${base}/master/parties/${id}/void`);
  const row = db.prepare('SELECT deleted_at FROM parties WHERE id=?').get(id);
  assert.ok(row.deleted_at, '软删生效');
});

test('bootstrap：主数据 + 每户欠款/预收/最近作业', async () => {
  // 造一单结算+部分收款
  const job = (await post(`${base}/jobs`, {
    client_job_id: 'b-' + Date.now(), job_type: 'spray', job_date: '2026-09-29',
    snapshot: SAMPLE.spray.export, result: SAMPLE.spray.result
  })).data;
  const st = (await post(`${base}/settlements`, { job_id: job.id })).data;
  await post(`${base}/settlements/${st.id}/confirm`);
  const bills = await getJson(`${base}/bills`);
  const b0 = bills.find(b => b.party_name === '李秀英');
  await post(`${base}/receipts`, { bill_id: b0.id, party_id: b0.party_id, amount_cents: 100 });

  const bs = await getJson(`${base}/bootstrap`);
  assert.ok(bs.parties.length >= 3);
  assert.ok(bs.generated_at);
  const li = bs.parties.find(p => p.name === '李秀英');
  assert.ok(li, '李秀英在 bootstrap');
  assert.ok(li.receivable_cents > 0, '有欠款');
  assert.ok(li.last_job, '有最近作业');
  const zhang = bs.parties.find(p => p.name === '张大国');
  assert.ok(zhang.receivable_cents > 0, '张大国未收款，应有欠款');
});

test('bootstrap 下发 operator（计算器同步 operator_names 的数据源）', async () => {
  await fetch(`${base}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operator: '老沈' }) });
  const bs = await getJson(`${base}/bootstrap`);
  assert.strictEqual(bs.operator, '老沈', 'settings.operator 随 bootstrap 下发');
  assert.ok(bs.parties[0].village !== undefined, 'village 字段仍在');
});

test('settings：operator 保存读取', async () => {
  const r = await fetch(`${base}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operator: '老沈' }) });
  assert.strictEqual((await r.json()).ok, true);
  const s = await getJson(`${base}/settings`);
  assert.strictEqual(s.operator, '老沈');
});

test('期初兜底：应收/预收 opening 单据 + 4103 凭证借贷平衡', async () => {
  const c = (await post(`${base}/parties`, { type: 'customer', name: '期初户' })).data;
  const r1 = await post(`${base}/import/opening`, { party_id: c.id, kind: 'receivable', amount_cents: 50000, note: '2025 旧账' });
  assert.strictEqual(r1.ok, true);
  const r2 = await post(`${base}/import/opening`, { party_id: c.id, kind: 'prepaid', amount_cents: 20000 });
  assert.strictEqual(r2.ok, true);
  const bal = await getJson(`${base}/parties/${c.id}/balance`);
  assert.strictEqual(bal.receivable_cents, 50000);
  assert.strictEqual(bal.prepaid_cents, 20000);
  const opening = db.prepare("SELECT COUNT(*) n FROM journal_entries WHERE event_type='opening'").get().n;
  assert.strictEqual(opening, 2);
  const t = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount_cents END),0) AS d,
            COALESCE(SUM(CASE WHEN direction='credit' THEN amount_cents END),0) AS c
     FROM journal_lines`).get();
  assert.strictEqual(t.d, t.c);
});
