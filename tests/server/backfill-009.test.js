/* ============================================================
   backfill-009.test.js — P5-M1 导入单主结算行单价回填验证
   造 NULL 单价 spray 行（raw price_yuan / 仅派生 / extra 已填行 /
   不可回填行），跑 backfill009：
   - raw 分支 元→分（与 importExcel.js 落库同基准），优先于派生；
   - 派生分支 spray_fee/area 本身是分/亩，不再 ×100（R1-B1）；
   - 金额基线（007 九键）分文不动；原有单价行不被改写；
   - 幂等重跑 0 行；区间自检失败 → throw 回滚（R1 建议 9）；
   - raw vs 派生差 >0.05 元出 warning（R1-B2）。
   ============================================================ */
'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { freshDb } = require('./helpers/db');
const { backfill009, snapshotSums } = require('../../server/db/backfill-009');

let db;
const now = new Date().toISOString();
beforeEach(() => { db = freshDb(); });

/** 造一个 import 作业：spray 行（可多条）+ settlement + items 镜像 */
function seedJob(db, { jobNo, raw, lines, extra }) {
  const jobId = db.prepare(
    `INSERT INTO jobs (job_no, client_job_id, job_type, status, job_date, source, raw_json, created_at, updated_at)
     VALUES (?, ?, 'spray', 'settled', '2026-03-01', 'import', ?, ?, ?)`)
    .run(jobNo, 'bf9-' + jobNo, JSON.stringify({ batch_id: 1, row_id: 1, raw: raw || {} }), now, now).lastInsertRowid;
  const insLine = db.prepare(
    `INSERT INTO job_settlement_lines (job_id, farmer_ref, farmer_name, area_mu, spray_fee_cents, included, kind, unit_price_cents)
     VALUES (?, '1', '张三', ?, ?, 0, 'spray', ?)`);
  const insItem = db.prepare(
    `INSERT INTO settlement_items (settlement_id, farmer_name, area_mu, spray_fee_cents, included, kind, unit_price_cents)
     VALUES (?, '张三', ?, ?, 0, 'spray', ?)`);
  let feeSum = 0;
  for (const l of lines) {
    insLine.run(jobId, l.area ?? null, l.fee, l.unit ?? null);
    feeSum += l.fee || 0;
  }
  if (extra) {
    db.prepare(
      `INSERT INTO job_settlement_lines (job_id, farmer_ref, farmer_name, area_mu, spray_fee_cents, included, kind, unit_price_cents)
       VALUES (?, '1', '张三', NULL, ?, 0, 'extra', ?)`).run(jobId, extra.fee, extra.unit);
  }
  const sid = db.prepare(
    `INSERT INTO settlements (settlement_no, job_id, status, total_spray_fee_cents,
       total_pesticide_fee_cents, total_receivable_cents, created_at, updated_at)
     VALUES (?, ?, 'confirmed', ?, 0, ?, ?, ?)`).run('S-' + jobNo, jobId, feeSum, feeSum, now, now).lastInsertRowid;
  for (const l of lines) insItem.run(sid, l.area ?? null, l.fee, l.unit ?? null);
  return jobId;
}

const lineOf = (jobId) => db.prepare(
  'SELECT area_mu, spray_fee_cents, unit_price_cents FROM job_settlement_lines WHERE job_id = ? AND kind = \'spray\' ORDER BY id').all(jobId);
const itemsOf = (jobId) => db.prepare(
  `SELECT si.unit_price_cents FROM settlement_items si JOIN settlements s ON s.id = si.settlement_id
   WHERE s.job_id = ? AND si.kind = 'spray' ORDER BY si.id`).all(jobId);

test('backfill009：raw 元→分优先、派生分/亩不再×100、extra 已填行不动、金额分文不动、幂等', () => {
  // J1：raw 价 25 元/亩；fee 12500 分 / 5 亩 = 2500 分/亩 与 raw 一致 → 无 warning
  const j1 = seedJob(db, { jobNo: 'J20260301-01', raw: { name: '张三', price_yuan: 25 }, lines: [{ area: 5, fee: 12500 }] });
  // J2：无 raw 价 → 派生 80000/20 = 4000 分（40 元/亩）
  const j2 = seedJob(db, { jobNo: 'J20260302-01', raw: { name: '张三' }, lines: [{ area: 20, fee: 80000 }] });
  // J3：extra 行已填 2500（回填不得触碰）；spray 行 raw 30 元×5 亩=15000 分，与派生一致
  const j3 = seedJob(db, { jobNo: 'J20260303-01', raw: { name: '张三', price_yuan: 30 }, lines: [{ area: 5, fee: 15000 }], extra: { fee: 10000, unit: 2500 } });

  const before = snapshotSums(db);
  const report = backfill009(db);

  assert.strictEqual(report.lines_fixed, 3, '3 条 spray 行回填（extra 行不在 WHERE 内）');
  assert.strictEqual(report.items_fixed, 3);
  assert.strictEqual(report.unfilled.lines + report.unfilled.items, 0);
  assert.strictEqual(report.sums_unchanged, true, '金额基线分文不动');
  assert.strictEqual(report.warnings.length, 0, `raw=派生无 warning: ${JSON.stringify(report.warnings)}`);

  assert.deepStrictEqual(lineOf(j1).map(l => l.unit_price_cents), [2500], 'raw 25 元 → 2500 分');
  assert.deepStrictEqual(lineOf(j2).map(l => l.unit_price_cents), [4000], '派生 80000/20=4000 分（不 ×100）');
  const extraRow = db.prepare("SELECT unit_price_cents FROM job_settlement_lines WHERE job_id = ? AND kind = 'extra'").get(j3);
  assert.deepStrictEqual(lineOf(j3).map(l => l.unit_price_cents), [3000], 'spray 行回填 3000');
  assert.strictEqual(extraRow.unit_price_cents, 2500, 'extra 已填 2500 不动');
  assert.deepStrictEqual(itemsOf(j1).map(i => i.unit_price_cents), [2500], 'items 镜像同规则');
  assert.deepStrictEqual(itemsOf(j3).map(i => i.unit_price_cents), [3000], 'items 不含 extra 行');

  const after = snapshotSums(db);
  assert.deepStrictEqual(after, before, '九个金额键前后一致');

  // 幂等：重跑 0 行变更
  const again = backfill009(db);
  assert.strictEqual(again.lines_fixed, 0);
  assert.strictEqual(again.items_fixed, 0);
  assert.strictEqual(again.sums_unchanged, true);
  assert.deepStrictEqual(lineOf(j1).map(l => l.unit_price_cents), [2500], '重跑值不变');
});

test('backfill009：COALESCE 优先 raw（派生不同值时取 raw）+ 差 >0.05 元出 warning', () => {
  // raw 25 元 → 2500 分；派生 115000/50 = 2300 分（23 元/亩）→ 取 raw，diff 2 元 → warning
  const j = seedJob(db, { jobNo: 'J20260301-02', raw: { name: '张三', price_yuan: 25 }, lines: [{ area: 50, fee: 115000 }] });
  const report = backfill009(db);

  assert.deepStrictEqual(lineOf(j).map(l => l.unit_price_cents), [2500], '优先 raw 2500 分（非派生 2300）');
  assert.deepStrictEqual(itemsOf(j).map(i => i.unit_price_cents), [2500]);
  assert.strictEqual(report.sums_unchanged, true);
  assert.strictEqual(report.warnings.length, 1, JSON.stringify(report.warnings));
  assert.ok(report.warnings[0].includes('J20260301-02'), 'warning 指到作业');
  assert.ok(report.warnings[0].includes('2.00'), `差值 2.00 元: ${report.warnings[0]}`);
});

test('backfill009：不可回填行（无 raw 无面积）保持 NULL 并报告', () => {
  const j = seedJob(db, { jobNo: 'J20260304-01', raw: { name: '张三' }, lines: [{ area: null, fee: 12345 }] });
  const report = backfill009(db);
  assert.deepStrictEqual(lineOf(j).map(l => l.unit_price_cents), [null], '无 raw 且 area NULL → 保持 NULL');
  assert.strictEqual(report.unfilled.lines, 1);
  assert.ok(report.warnings.some(w => w.includes('保持 NULL')), JSON.stringify(report.warnings));
});

test('backfill009：区间自检失败 → throw + 回滚（行保持 NULL、金额不变）', () => {
  // raw 300 元/亩 → 30000 分 > 10000 上限
  const j = seedJob(db, { jobNo: 'J20260305-01', raw: { name: '张三', price_yuan: 300 }, lines: [{ area: 5, fee: 12500 }] });
  const before = snapshotSums(db);
  assert.throws(() => backfill009(db), /区间自检失败/, '事务内自检失败即 throw');
  assert.deepStrictEqual(lineOf(j).map(l => l.unit_price_cents), [null], '回滚后单价仍为 NULL');
  assert.deepStrictEqual(snapshotSums(db), before, '金额分文未动');
});
