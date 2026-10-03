/* ============================================================
   import-e2e.test.js — P6-M4 导入 HTTP 级端到端（含毒行原子性回归）
   覆盖 GUI 无法自动化的部分：parse(base64 上传)→confirm→apply 全链 +
   P5-M4 修复的"毒行中断整体回滚、批次可修复重试"。
   ============================================================ */
'use strict';

const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildApp } = require('../../server/index');
const { freshDb } = require('./helpers/db');

const FIXTURE = path.join(__dirname, '..', 'fixtures', '植保收支明细.xlsx');

let db, app, server, base;

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

async function parseFixture() {
  const r = await post(`${base}/import/parse`, {
    filename: '植保收支明细.xlsx',
    base64: fs.readFileSync(FIXTURE).toString('base64')
  });
  if (!r.ok) throw new Error('parse 失败: ' + JSON.stringify(r).slice(0, 200));
  return r.data;
}
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return res.json();
}
async function patch(url, body) {
  const res = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return res.json();
}
async function getJson(url) {
  const res = await fetch(url);
  return (await res.json()).data;
}

test('E2E：上传→全确认→落库→对账三平→重复上传拒绝（HTTP 全链）', async () => {
  const d = await parseFixture();
  assert.ok(d.batch_id > 0);
  const rows = await getJson(`${base}/import/batches/${d.batch_id}/rows`);
  for (const r of rows) {
    const p = await patch(`${base}/import/rows/${r.id}`, { action: 'confirm' });
    assert.strictEqual(p.ok, true);
  }
  const applyRes = await post(`${base}/import/batches/${d.batch_id}/apply`, { operator: 'e2e' });
  assert.strictEqual(applyRes.ok, true, JSON.stringify(applyRes).slice(0, 300));

  const jobs = db.prepare("SELECT COUNT(*) n FROM jobs WHERE source='import'").get().n;
  assert.strictEqual(jobs, applyRes.data.jobs);
  // 借贷平衡
  const t = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount_cents END),0) AS dv,
            COALESCE(SUM(CASE WHEN direction='credit' THEN amount_cents END),0) AS cv
     FROM journal_lines`).get();
  assert.strictEqual(t.dv, t.cv, '总账借贷平衡');
  // 三平量级（与 P2 基线一致）
  const rec = await getJson(`${base}/import/batches/${d.batch_id}/reconciliation`);
  assert.strictEqual(rec.balanced, true, 'staging 对账三平');
  // 重复上传拒绝（DUPLICATE）
  const dup = await post(`${base}/import/parse`, {
    filename: '植保收支明细.xlsx',
    base64: fs.readFileSync(FIXTURE).toString('base64')
  });
  assert.strictEqual(dup.ok, false);
  assert.strictEqual(dup.error.code, 'DUPLICATE');
});

test('E2E 原子性回归：毒行中断→整体回滚零残留→修复后可重试成功', async () => {
  const d = await parseFixture();
  const rows = await getJson(`${base}/import/batches/${d.batch_id}/rows`);
  // 确认除最后一行外全部（把最后一行留作毒行注入点）
  for (const r of rows.slice(0, -1)) await patch(`${base}/import/rows/${r.id}`, { action: 'confirm' });
  const last = rows[rows.length - 1];
  await patch(`${base}/import/rows/${last.id}`, { action: 'confirm' });

  // 注入毒行：作业行的客户姓名置 null（NOT NULL 约束将中断 apply）
  const poisoned = JSON.parse(last.parsed_json);
  if (poisoned.kind === 'expense') throw new Error('fixture 末行不是作业行,请检查');
  poisoned.parsed.name = null;
  db.prepare('UPDATE raw_import_rows SET parsed_json = ? WHERE id = ?')
    .run(JSON.stringify(poisoned), last.id);

  const before = db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
  const apply1 = await post(`${base}/import/batches/${d.batch_id}/apply`, {});
  assert.strictEqual(apply1.ok, false, '毒行必须使 apply 失败');
  const after1 = db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
  assert.strictEqual(after1, before, 'P5-M4 原子性:中断后零残留(不得部分提交)');
  const batch = db.prepare('SELECT status FROM import_batches WHERE id=?').get(d.batch_id);
  assert.strictEqual(batch.status, 'reviewing', '批次保持可修复状态');

  // 修复毒行 → 重试成功
  const fixed = JSON.parse(last.parsed_json);
  fixed.parsed.name = '修复客户';
  db.prepare('UPDATE raw_import_rows SET parsed_json = ? WHERE id = ?').run(JSON.stringify(fixed), last.id);
  const apply2 = await post(`${base}/import/batches/${d.batch_id}/apply`, {});
  assert.strictEqual(apply2.ok, true, '修复后重试成功(此前会撞 client_job_id UNIQUE 永久卡死)');
  const jobs = db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
  assert.strictEqual(jobs, apply2.data.jobs);
  const t = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount_cents END),0) AS dv,
            COALESCE(SUM(CASE WHEN direction='credit' THEN amount_cents END),0) AS cv
     FROM journal_lines`).get();
  assert.strictEqual(t.dv, t.cv);
});
