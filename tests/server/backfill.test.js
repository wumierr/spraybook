/* ============================================================
   backfill.test.js — P3 数据订正验证
   造一个 calculator 来源 job（带 costBreakdown 快照）+ 一个 import
   来源伪行（farmer_name "张三（另按 25 元/亩）"），跑 backfill007：
   构成落列、伪行结构化、地块关联、金额分文不动、重跑幂等。
   ============================================================ */
'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { freshDb } = require('./helpers/db');
const { backfill007, snapshotSums } = require('../../server/db/backfill-007');

let db;
const now = new Date().toISOString();
beforeEach(() => { db = freshDb(); });

function seed(db) {
  // calculator 来源：构成快照 {cycle:3, fuel:120, labor:315, pesticide:1600, equipment:23.4, other:15}
  const calcJob = db.prepare(
    `INSERT INTO jobs (job_no, client_job_id, job_type, status, job_date, total_cost_cents,
       income_cents, profit_cents, raw_json, created_at, updated_at)
     VALUES ('20261002-B1', 'bf-calc', 'spray', 'completed', '2026-10-02', 207640, 41700, -165940, ?, ?, ?)`)
    .run(JSON.stringify({
      snapshot: { income: { subsidy: 0 } },
      result: {
        costBreakdown: { cycle: 3, fuel: 120, labor: 315, pesticide: 1600, equipment: 23.4, other: 15 },
        totalCost: 2076.4
      }
    }), now, now).lastInsertRowid;

  // import 来源：伪行（全角/半角括号各一条）+ 地块
  const impJob = db.prepare(
    `INSERT INTO jobs (job_no, client_job_id, job_type, status, job_date, raw_json, created_at, updated_at)
     VALUES ('J20260114-99', 'bf-imp', 'spray', 'settled', '2026-01-14', ?, ?, ?)`)
    .run(JSON.stringify({ batch_id: 1, row_id: 2, raw: { name: '张三' } }), now, now).lastInsertRowid;
  const party = db.prepare(
    "INSERT INTO parties (type, name, created_at, updated_at) VALUES ('customer', '张三', ?, ?)")
    .run(now, now).lastInsertRowid;
  db.prepare(
    `INSERT INTO job_settlement_lines (job_id, farmer_ref, farmer_name, spray_fee_cents, included)
     VALUES (?, ?, '张三（另按 25 元/亩）', 70000, 0)`).run(impJob, String(party));
  db.prepare(
    `INSERT INTO job_settlement_lines (job_id, farmer_ref, farmer_name, spray_fee_cents, included)
     VALUES (?, ?, '李四(另按 12.5 元/亩)', 12500, 0)`).run(impJob, String(party));
  const sid = db.prepare(
    `INSERT INTO settlements (settlement_no, job_id, status, total_spray_fee_cents,
       total_pesticide_fee_cents, total_receivable_cents, created_at, updated_at)
     VALUES ('S-BF', ?, 'confirmed', 70000, 0, 70000, ?, ?)`).run(impJob, now, now).lastInsertRowid;
  db.prepare(
    `INSERT INTO settlement_items (settlement_id, party_id, farmer_name, spray_fee_cents, included)
     VALUES (?, ?, '张三（另按 25 元/亩）', 70000, 0)`).run(sid, party);
  const plotId = db.prepare(
    "INSERT INTO plots (party_id, name, area_mu, created_at, updated_at) VALUES (?, '张家果园东', 12, ?, ?)")
    .run(party, now, now).lastInsertRowid;
  db.prepare("INSERT INTO job_plots (job_id, plot_name, area_mu) VALUES (?, '张家果园东', 12)")
    .run(calcJob);
  return { calcJob, impJob, party, plotId };
}

test('backfill007：构成落列、伪行结构化、地块关联、金额分文不动', () => {
  const fx = seed(db);
  const before = snapshotSums(db);
  const report = backfill007(db);

  assert.strictEqual(report.jobs, 1, 'calculator 单回填构成');
  assert.strictEqual(report.lines_fixed, 2, '两行伪行（全角+半角）');
  assert.strictEqual(report.items_fixed, 1);
  assert.strictEqual(report.plots_linked, 1);
  assert.strictEqual(report.sums_unchanged, true);
  assert.strictEqual(report.warnings.length, 0, `无警告: ${JSON.stringify(report.warnings)}`);

  const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(fx.calcJob);
  assert.strictEqual(j.labor_cost_cents, 31500);
  assert.strictEqual(j.pesticide_cost_cents, 160000);
  assert.strictEqual(j.equipment_cost_cents, 2340);
  assert.strictEqual(j.misc_cost_cents, 1500);
  assert.strictEqual(j.subsidy_cents, 0);
  assert.strictEqual(j.total_cost_cents, 207640, '总额列不动');

  const lines = db.prepare(
    'SELECT kind, farmer_name, unit_price_cents, spray_fee_cents FROM job_settlement_lines WHERE job_id = ? ORDER BY spray_fee_cents DESC')
    .all(fx.impJob);
  assert.deepStrictEqual(lines.map(l => [l.kind, l.farmer_name, l.unit_price_cents, l.spray_fee_cents]), [
    ['extra', '张三', 2500, 70000],
    ['extra', '李四', 1250, 12500]
  ], '伪行 → kind=extra + 单价 + 干净姓名（全角/半角括号都识别）');

  const item = db.prepare('SELECT kind, farmer_name, unit_price_cents FROM settlement_items WHERE settlement_id = ?')
    .get(sidOf(db, fx.impJob));
  assert.strictEqual(item.kind, 'extra');
  assert.strictEqual(item.farmer_name, '张三');
  assert.strictEqual(item.unit_price_cents, 2500);

  const jp = db.prepare('SELECT plot_id FROM job_plots WHERE job_id = ?').get(fx.calcJob);
  assert.strictEqual(jp.plot_id, fx.plotId, '地块按名关联');

  const after = snapshotSums(db);
  assert.deepStrictEqual(after, before, '金额基线分文不动');
});

function sidOf(db, jobId) {
  return db.prepare('SELECT id FROM settlements WHERE job_id = ?').get(jobId).id;
}

test('backfill007：import 单无构成快照保持 NULL；重跑幂等', () => {
  const fx = seed(db);
  backfill007(db);
  const imp = db.prepare('SELECT labor_cost_cents, subsidy_cents FROM jobs WHERE id = ?').get(fx.impJob);
  assert.strictEqual(imp.labor_cost_cents, null, '导入单无 costBreakdown，保持 NULL');
  assert.strictEqual(imp.subsidy_cents, null);

  const again = backfill007(db);
  assert.strictEqual(again.jobs, 0, '重跑不再处理已回填行');
  assert.strictEqual(again.lines_fixed, 0);
  assert.strictEqual(again.items_fixed, 0);
  assert.strictEqual(again.plots_linked, 0);
  assert.strictEqual(again.sums_unchanged, true);
});
