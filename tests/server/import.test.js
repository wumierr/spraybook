/* ============================================================
   import.test.js — M8 历史 Excel 导入（真实文件 fixture 全链路）
   ============================================================ */
'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildApp } = require('../../server/index');
const { freshDb } = require('./helpers/db');

const FIXTURE = path.join(__dirname, '..', 'fixtures', '植保收支明细.xlsx');

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
async function getJson(url) {
  return (await (await fetch(url)).json()).data;
}
async function patch(url, body) {
  const res = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function parseFixture() {
  const b64 = fs.readFileSync(FIXTURE).toString('base64');
  const r = await post(`${base}/import/parse`, { filename: '植保收支明细.xlsx', base64: b64 });
  assert.strictEqual(r.ok, true, JSON.stringify(r).slice(0, 400));
  return r.data;
}

test('解析：真实文件全量入 staging，规模与画像吻合', async () => {
  const d = await parseFixture();
  assert.ok(d.batch_id > 0);
  assert.strictEqual(d.stats.sheets, 12);
  assert.ok(d.stats.jobs >= 100 && d.stats.jobs <= 110, `作业行 ${d.stats.jobs}`);
  assert.ok(d.stats.expenses >= 35 && d.stats.expenses <= 55, `支出行 ${d.stats.expenses}`);
  assert.ok(d.stats.review > 0, '存在需人工复核行');
  assert.ok(d.review_count === d.stats.review);
  // 抹零样例：李洪辉 640.5/640
  const rows = await getJson(`${base}/import/batches/${d.batch_id}/rows`);
  const lhh = rows.find(r => r.parsed.kind === 'job' && r.parsed.parsed.name === '李洪辉');
  assert.ok(lhh, '找到李洪辉行');
  assert.strictEqual(lhh.parsed.parsed.discount_cents, 50, '抹零 0.5 元=50 分');
  // 未收款样例：陈仁军
  const crj = rows.find(r => r.parsed.kind === 'job' && r.parsed.parsed.name === '陈仁军');
  assert.ok(crj, '找到陈仁军行');
  assert.strictEqual(crj.parsed.parsed.paid_cents, 0);
  assert.ok(crj.parsed.needs_review.some(n => n.code === 'expense-zone'), 'c13 裸数字进复核');
  // 村/队拆分
  const hl = rows.find(r => r.parsed.kind === 'job' && r.raw_text.includes('彰冠红拉12队'));
  assert.ok(hl, '找到彰冠红拉12队行');
  assert.strictEqual(hl.parsed.parsed.village, '彰冠红拉');
  assert.strictEqual(hl.parsed.parsed.team, '12');
  // 合并作业人员切分
  const merged = rows.find(r => r.parsed.kind === 'job' && (r.parsed.parsed.operators || []).length > 1);
  assert.ok(merged, '存在切分出的多作业人员行');
  // 脏年份进复核
  const badYear = rows.find(r => r.parsed.kind === 'job' && r.parsed.needs_review.some(n => n.code === 'date' && /2056|2016/.test(n.detail)));
  assert.ok(badYear, '2016/2056 脏年份进复核');
});

test('对账：staging 全确认后与原始列合计对平', async () => {
  const d = await parseFixture();
  // 全部行确认（模拟复核完成）
  const rows = await getJson(`${base}/import/batches/${d.batch_id}/rows`);
  for (const r of rows) {
    const p = await patch(`${base}/import/rows/${r.id}`, { action: 'confirm' });
    assert.strictEqual(p.ok, true);
  }
  const rec = await getJson(`${base}/import/batches/${d.batch_id}/reconciliation`);
  assert.strictEqual(rec.diff.receivable_cents, 0, `应收 diff: ${JSON.stringify(rec.diff)}`);
  assert.strictEqual(rec.diff.paid_cents, 0, `实收 diff: ${JSON.stringify(rec.diff)}`);
  assert.strictEqual(rec.diff.expense_cents, 0, `支出 diff: ${JSON.stringify(rec.diff)}`);
  assert.strictEqual(rec.balanced, true);
  // 基线量级核对（Python 独立画像：应收 97,680.10 / 实收 81,896.00 / 支出 11,452）
  assert.ok(Math.abs(rec.raw_totals.receivable - 97680.10) < 1, `应收基线 ${rec.raw_totals.receivable}`);
  assert.ok(Math.abs(rec.raw_totals.paid - 81896.00) < 1, `实收基线 ${rec.raw_totals.paid}`);
});

test('落库：apply 后全量进正式表、借贷平衡、幂等', async () => {
  const d = await parseFixture();
  const rows = await getJson(`${base}/import/batches/${d.batch_id}/rows`);
  for (const r of rows) await patch(`${base}/import/rows/${r.id}`, { action: 'confirm' });
  const applyRes = await post(`${base}/import/batches/${d.batch_id}/apply`, { operator: '导入测试' });
  assert.strictEqual(applyRes.ok, true, JSON.stringify(applyRes).slice(0, 400));
  assert.strictEqual(applyRes.data.jobs + applyRes.data.expenses + applyRes.data.skipped_zero, rows.length);

  // 正式表规模
  const jobs = db.prepare("SELECT COUNT(*) n FROM jobs WHERE source='import'").get().n;
  const bills = db.prepare('SELECT COUNT(*) n FROM bills').get().n;
  const receipts = db.prepare('SELECT COUNT(*) n FROM receipts').get().n;
  const payments = db.prepare('SELECT COUNT(*) n FROM payments').get().n;
  assert.strictEqual(jobs, applyRes.data.jobs);
  assert.strictEqual(bills, applyRes.data.jobs, '每作业一张账单');
  assert.strictEqual(payments, applyRes.data.expenses);

  // 借贷平衡
  const t = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount_cents END),0) AS d,
            COALESCE(SUM(CASE WHEN direction='credit' THEN amount_cents END),0) AS c
     FROM journal_lines`).get();
  assert.strictEqual(t.d, t.c, `总账借贷不平 ${t.d} vs ${t.c}`);

  // 报表能看到导入历史
  const summary = await getJson(`${base}/reports/summary`);
  assert.ok(summary.income_cents > 9000000, `收入应接近 97680 元（实收 ${summary.income_cents} 分）`);

  // 客户余额：全收清的为 0，未收的有欠款
  const bal = await getJson(`${base}/reports/by-customer`);
  assert.ok(bal.length >= 20, `客户数 ${bal.length}`);

  // 幂等：同文件再解析被拒
  const dup = await post(`${base}/import/parse`, {
    filename: '植保收支明细.xlsx',
    base64: fs.readFileSync(FIXTURE).toString('base64')
  });
  assert.strictEqual(dup.ok, false);
  assert.strictEqual(dup.error.code, 'DUPLICATE');
});

test('复核编辑：改村名/金额后落库生效；拒绝行不落库', async () => {
  const d = await parseFixture();
  const rows = await getJson(`${base}/import/batches/${d.batch_id}/rows`);
  const reviewRow = rows.find(r => r.parsed.needs_review && r.parsed.needs_review.length);
  assert.ok(reviewRow, '存在复核行');
  // 编辑：改村名 + 确认
  await patch(`${base}/import/rows/${reviewRow.id}`, {
    action: 'confirm',
    parsed: { village: '修正村', team: '3' }
  });
  // 拒绝一行（支出）
  const expRow = rows.find(r => r.parsed.kind === 'expense');
  if (expRow) await patch(`${base}/import/rows/${expRow.id}`, { action: 'reject' });
  // 其余全确认
  for (const r of rows) {
    if (r.id === reviewRow.id || (expRow && r.id === expRow.id)) continue;
    await patch(`${base}/import/rows/${r.id}`, { action: 'confirm' });
  }
  const applyRes = await post(`${base}/import/batches/${d.batch_id}/apply`, {});
  assert.strictEqual(applyRes.ok, true);
  const v = db.prepare("SELECT COUNT(*) n FROM parties WHERE village='修正村'").get().n;
  assert.strictEqual(v, 1, '复核编辑的村名生效');
  if (expRow) {
    const rejected = db.prepare(
      "SELECT COUNT(*) n FROM payments WHERE note LIKE '%[导入%'").get().n;
    assert.strictEqual(rejected, applyRes.data.expenses, '被拒绝的支出行未落库');
  }
  const pending = db.prepare(
    "SELECT status, COUNT(*) n FROM raw_import_rows WHERE batch_id=? GROUP BY status").all(d.batch_id);
  const rejected = pending.find(p => p.status === 'rejected');
  if (expRow) assert.ok(rejected && rejected.n === 1, 'rejected 行保持 rejected');
});
