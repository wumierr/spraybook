/* ============================================================
   import.test.js — M8/P2 历史 Excel 导入（真实文件 fixture 全链路，按裁决 A–G）
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

test('解析 v2：全量入 staging，裁决 A–G 规则生效', async () => {
  const d = await parseFixture();
  assert.ok(d.batch_id > 0);
  assert.strictEqual(d.stats.sheets, 12);
  assert.ok(d.stats.jobs >= 100 && d.stats.jobs <= 110, `作业行 ${d.stats.jobs}`);
  assert.ok(d.stats.expenses >= 46 && d.stats.expenses <= 62, `支出行 ${d.stats.expenses}`);
  assert.strictEqual(d.stats.incomes, 4, 'D 组收入对 4 笔');
  assert.ok(d.stats.review > 0 && d.stats.review <= 15, `复核行应≤15，实际 ${d.stats.review}`);
  assert.ok(d.review_count === d.stats.review);

  const rows = await getJson(`${base}/import/batches/${d.batch_id}/rows`);

  // A：坏年份自动改 2026（不留 review）
  const badYear = rows.find(r => r.parsed.kind === 'job' && (r.raw_text.includes('2056') || r.raw_text.includes('2016.')));
  assert.ok(badYear, '找到坏年份行');
  assert.match(badYear.parsed.parsed.date, /^2026-/, '坏年份已改 2026');
  assert.strictEqual(badYear.parsed.needs_review.filter(n => n.code === 'date').length, 0, '坏年份不再进复核');
  // 数字日期接受不留 review
  const numDate = rows.find(r => r.parsed.kind === 'job' && r.raw_text.includes('c1=3.19'));
  assert.ok(numDate, '找到 3.19 行');
  assert.strictEqual(numDate.parsed.needs_review.filter(n => n.code === 'date').length, 0, '数字日期不再进复核');

  // B：收超照记无 review
  const over = rows.find(r => r.parsed.kind === 'job' && r.raw_text.includes('c8=639'));
  assert.ok(over, '找到收超行（李红辉 639>630）');
  assert.strictEqual(over.parsed.parsed.paid_cents, 63900);
  assert.strictEqual(over.parsed.needs_review.filter(n => n.code === 'overpaid').length, 0);

  // C：4月右侧流水横读为支出（转王强 500）
  const crj = rows.find(r => r.parsed.kind === 'job' && r.parsed.parsed.name === '陈仁军');
  assert.ok(crj, '找到陈仁军行');
  assert.strictEqual(crj.parsed.parsed.paid_cents, 0);
  const crjExp = rows.find(r => r.parsed.kind === 'expense' && r.row_no === crj.row_no && r.sheet_name === crj.sheet_name);
  assert.ok(crjExp, '陈仁军同行支出已横读入账');
  assert.strictEqual(crjExp.parsed.parsed.amount_cents, 50000);
  assert.match(crjExp.parsed.parsed.date, /2026-04-18/);
  assert.match(crjExp.parsed.parsed.desc || '', /转王强/);

  // D：单价标准+收入 对（张志军 25/700）
  const zzh = rows.find(r => r.parsed.kind === 'job' && r.parsed.parsed.name === '张志军');
  assert.ok(zzh, '找到张志军行');
  assert.strictEqual(zzh.parsed.parsed.extra_income_cents, 70000, '收入对 700 元');

  // E：实收列人名 → 实收=应收
  const yzy = rows.find(r => r.parsed.kind === 'job' && r.raw_text.includes('c8=李凌琦'));
  assert.ok(yzy, '找到实收列人名行');
  assert.strictEqual(yzy.parsed.parsed.paid_cents, yzy.parsed.parsed.receivable_cents, '按应收=实收');
  assert.ok((yzy.parsed.parsed.note || '').includes('李凌琦'), '原文进备注');

  // F：region 三段拆分
  const hl = rows.find(r => r.parsed.kind === 'job' && r.raw_text.includes('彰冠红拉12队'));
  assert.ok(hl, '找到彰冠红拉12队行');
  assert.strictEqual(hl.parsed.parsed.region, '彰冠');
  assert.strictEqual(hl.parsed.parsed.village, '红拉');
  assert.strictEqual(hl.parsed.parsed.team, '12');
  // 红拉村（无镇前缀）合法不复核
  const hlOnly = rows.find(r => r.parsed.kind === 'job' && r.raw_text.includes('c3=红拉4队'));
  assert.strictEqual(hlOnly.parsed.needs_review.filter(n => n.code === 'address').length, 0, '红拉4队不再误报');
  // 胡昌奎地址弃用
  const hck = rows.find(r => r.parsed.kind === 'job' && r.raw_text.includes('c3=胡昌奎'));
  assert.ok(hck, '找到胡昌奎行');
  assert.strictEqual(hck.parsed.parsed.village, '', '人名地址弃用');

  // G：作业人员列日期被流水消费，不再报 operators
  assert.strictEqual(crj.parsed.needs_review.filter(n => n.code === 'operators').length, 0, '4.18 归流水不再报作业人员');

  // 合并作业人员切分仍工作
  const merged = rows.find(r => r.parsed.kind === 'job' && (r.parsed.parsed.operators || []).length > 1);
  assert.ok(merged, '存在切分出的多作业人员行');
});

test('对账：staging 全确认后与原始列合计对平（含收入对口径）', async () => {
  const d = await parseFixture();
  const rows = await getJson(`${base}/import/batches/${d.batch_id}/rows`);
  for (const r of rows) {
    const p = await patch(`${base}/import/rows/${r.id}`, { action: 'confirm' });
    assert.strictEqual(p.ok, true);
  }
  const rec = await getJson(`${base}/import/batches/${d.batch_id}/reconciliation`);
  assert.strictEqual(rec.diff.receivable_cents, 0, `应收 diff: ${JSON.stringify(rec.diff)}`);
  assert.strictEqual(rec.diff.paid_cents, 0, `实收 diff（含收入对）: ${JSON.stringify(rec.diff)}`);
  assert.strictEqual(rec.diff.expense_cents, 0, `支出 diff: ${JSON.stringify(rec.diff)}`);
  assert.strictEqual(rec.balanced, true);
  // 基线量级（Python 独立画像）
  assert.ok(Math.abs(rec.raw_totals.receivable - 97680.10) < 1, `应收基线 ${rec.raw_totals.receivable}`);
  assert.ok(Math.abs(rec.raw_totals.paid - 84216.00) < 1, `实收基线（含 E 行镜像 2320）${rec.raw_totals.paid}`);
  assert.ok(rec.raw_totals.income_extra > 3000, `D 组收入对应被探针识别: ${rec.raw_totals.income_extra}`);
});

test('落库：apply 后全量进正式表、借贷平衡、D 组按已收、幂等', async () => {
  const d = await parseFixture();
  const rows = await getJson(`${base}/import/batches/${d.batch_id}/rows`);
  for (const r of rows) await patch(`${base}/import/rows/${r.id}`, { action: 'confirm' });
  const applyRes = await post(`${base}/import/batches/${d.batch_id}/apply`, { operator: '导入测试' });
  assert.strictEqual(applyRes.ok, true, JSON.stringify(applyRes).slice(0, 400));

  const jobs = db.prepare("SELECT COUNT(*) n FROM jobs WHERE source='import'").get().n;
  assert.strictEqual(jobs, applyRes.data.jobs);
  const t = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount_cents END),0) AS d,
            COALESCE(SUM(CASE WHEN direction='credit' THEN amount_cents END),0) AS c
     FROM journal_lines`).get();
  assert.strictEqual(t.d, t.c, `总账借贷不平 ${t.d} vs ${t.c}`);

  // D 组按已收：张志军 bill paid ≥ 应收（700 已收并入）
  const zzJob = db.prepare("SELECT id, income_cents FROM jobs WHERE raw_json LIKE '%张志军%' AND source='import'").get();
  assert.ok(zzJob, '张志军作业存在');
  assert.ok(zzJob.income_cents > 66000, `张志军收入应含 700 追加: ${zzJob.income_cents}`);

  // 007 结构化：extra 行 kind/unit_price/干净姓名；主行带每亩单价
  const zzLines = db.prepare(
    'SELECT kind, farmer_name, unit_price_cents, spray_fee_cents FROM job_settlement_lines WHERE job_id = ? ORDER BY id')
    .all(zzJob.id);
  const zzExtra = zzLines.find(l => l.kind === 'extra');
  assert.ok(zzExtra, '存在 kind=extra 行');
  assert.strictEqual(zzExtra.farmer_name, '张志军', 'extra 行姓名干净（不带"另按"后缀）');
  assert.strictEqual(zzExtra.unit_price_cents, 2500, '另按 25 元/亩 → 2500 分');
  assert.strictEqual(zzExtra.spray_fee_cents, 70000, '700 元 → 70000 分');
  const zzMain = zzLines.find(l => l.kind === 'spray');
  assert.ok(zzMain, '主行 kind=spray');
  assert.ok(zzMain.unit_price_cents > 0, `主行每亩单价快照: ${zzMain.unit_price_cents}`);

  const summary = await getJson(`${base}/reports/summary`);
  assert.ok(summary.income_cents > 9000000, `收入应接近 97680+ 元（${summary.income_cents} 分）`);

  // 幂等
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
  await patch(`${base}/import/rows/${reviewRow.id}`, {
    action: 'confirm',
    parsed: { village: '修正村', team: '3' }
  });
  const expRow = rows.find(r => r.parsed.kind === 'expense');
  if (expRow) await patch(`${base}/import/rows/${expRow.id}`, { action: 'reject' });
  for (const r of rows) {
    if (r.id === reviewRow.id || (expRow && r.id === expRow.id)) continue;
    await patch(`${base}/import/rows/${r.id}`, { action: 'confirm' });
  }
  const applyRes = await post(`${base}/import/batches/${d.batch_id}/apply`, {});
  assert.strictEqual(applyRes.ok, true);
  const v = db.prepare("SELECT COUNT(*) n FROM parties WHERE village='修正村'").get().n;
  assert.strictEqual(v, 1, '复核编辑的村名生效');
  const pending = db.prepare(
    "SELECT status, COUNT(*) n FROM raw_import_rows WHERE batch_id=? GROUP BY status").all(d.batch_id);
  const rejected = pending.find(p => p.status === 'rejected');
  if (expRow) assert.ok(rejected && rejected.n === 1, 'rejected 行保持 rejected');
});
