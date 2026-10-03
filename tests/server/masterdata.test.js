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

test('P5-M1 bootstrap last_job 单价：kind=spray 过滤 extra 行、COALESCE 优先回填价、÷100 恢复元/亩', async () => {
  const now = new Date().toISOString();
  // 客户A：extra 行（带面积，模拟未来污染，旧查询会选中它）在前，
  // 后接两条 spray 行——首条带回填价 2500 分（派生应为 23000 分，证 COALESCE 优先）
  const ca = (await post(`${base}/parties`, { type: 'customer', name: '单价测试户' })).data;
  const jobA = db.prepare(
    `INSERT INTO jobs (job_no, client_job_id, job_type, status, job_date, plant_type_name, created_at, updated_at)
     VALUES ('J20260901-99', 'md-price-a', 'spray', 'settled', '2026-09-01', '水稻', ?, ?)`)
    .run(now, now).lastInsertRowid;
  const insLine = db.prepare(
    `INSERT INTO job_settlement_lines (job_id, farmer_ref, farmer_name, area_mu, spray_fee_cents, included, kind, unit_price_cents)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`);
  insLine.run(jobA, String(ca.id), '单价测试户', 1, 990000, 'extra', 990000);
  insLine.run(jobA, String(ca.id), '单价测试户', 5, 115000, 'spray', 2500);
  insLine.run(jobA, String(ca.id), '单价测试户', 4, 80000, 'spray', null);

  // 客户B：计算器来源单（raw_json 无 price_yuan、行无回填价）→ 派生 115000/50=2300 分=23 元/亩
  const cb = (await post(`${base}/parties`, { type: 'customer', name: '派生测试户' })).data;
  const jobB = db.prepare(
    `INSERT INTO jobs (job_no, client_job_id, job_type, status, job_date, plant_type_name, raw_json, created_at, updated_at)
     VALUES ('J20260902-99', 'md-price-b', 'spray', 'settled', '2026-09-02', '水稻', ?, ?, ?)`)
    .run(JSON.stringify({ snapshot: {}, result: {} }), now, now).lastInsertRowid;
  insLine.run(jobB, String(cb.id), '派生测试户', 50, 115000, 'spray', null);

  const bs = await getJson(`${base}/bootstrap`);
  const pa = bs.parties.find(p => p.name === '单价测试户');
  const pb = bs.parties.find(p => p.name === '派生测试户');
  assert.ok(pa && pa.last_job, '客户A 最近作业存在');
  assert.strictEqual(pa.last_job.price_yuan, 25, 'COALESCE 优先回填价 2500 分 → 25 元/亩（旧查询取 extra 行得 990000）');
  assert.ok(pa.last_job.price_yuan > 0 && pa.last_job.price_yuan <= 100, '合理区间，无分/亩冒充元/亩');
  assert.ok(pb && pb.last_job, '客户B 最近作业存在');
  assert.strictEqual(pb.last_job.price_yuan, 23, '无回填价派生 2300 分 → 23 元/亩（旧式 115000/50=2300 冒充元/亩）');
});

test('bootstrap 下发 operator（计算器同步 operator_names 的数据源）', async () => {
  await fetch(`${base}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operator: '老沈' }) });
  const bs = await getJson(`${base}/bootstrap`);
  assert.strictEqual(bs.operator, '老沈', 'settings.operator 随 bootstrap 下发');
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
