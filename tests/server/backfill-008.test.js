/* ============================================================
   backfill-008.test.js — P4-M1 plant_type_name 双语义收尾订正验证
   造 import/计算器混合存量作业，跑 backfill008：
   - 导入行（source='import'）的非作物 plant_type_name → purpose，
     plant_type_name 置回 NULL（作物语义归还计算器）；
   - 计算器作业（真作物）与已有 purpose / 空值行不动；
   - 与 raw_json.raw.purpose 不一致仅 warning，按列值搬移；
   - 金额九键分文不动；幂等重跑 0 行。
   ============================================================ */
'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { freshDb } = require('./helpers/db');
const { backfill008 } = require('../../server/db/backfill-008');
const { snapshotSums } = require('../../server/db/backfill-009');

let db;
const now = new Date().toISOString();
beforeEach(() => { db = freshDb(); });

/** 造一个作业行（source / plant_type_name / purpose / raw purpose 可指定） */
function seedJob(db, { jobNo, source, plant, purpose, rawPurpose }) {
  const raw = rawPurpose === undefined ? {} : { purpose: rawPurpose };
  return db.prepare(
    `INSERT INTO jobs (job_no, client_job_id, job_type, status, job_date, source,
       plant_type_name, purpose, raw_json, created_at, updated_at)
     VALUES (?, ?, 'spray', 'settled', '2026-03-01', ?, ?, ?, ?, ?, ?)`)
    .run(jobNo, 'bf8-' + jobNo, source, plant ?? null, purpose ?? null,
      JSON.stringify({ batch_id: 1, row_id: 1, raw }), now, now).lastInsertRowid;
}
const rowOf = (id) => db.prepare('SELECT plant_type_name, purpose FROM jobs WHERE id = ?').get(id);

test('backfill008：导入行目的搬到 purpose、plant_type_name 清空；计算器真作物不动', () => {
  const j1 = seedJob(db, { jobNo: 'J20260301-01', source: 'import', plant: '清园' });       // 导入污染行
  const j2 = seedJob(db, { jobNo: 'J20260302-01', source: 'calculator', plant: '柑橘' });   // 计算器真作物
  const j3 = seedJob(db, { jobNo: 'J20260303-01', source: 'import', plant: '控高', purpose: '已手填' }); // 已有 purpose
  const j4 = seedJob(db, { jobNo: 'J20260304-01', source: 'import' });                      // 无 plant 列值

  const before = snapshotSums(db);
  const report = backfill008(db);

  assert.strictEqual(report.moved, 1, `只搬 1 行（${JSON.stringify({ moved: report.moved })}）`);
  assert.strictEqual(report.skipped_has_purpose, 1, '已有 purpose 的行跳过');
  assert.deepStrictEqual(rowOf(j1), { plant_type_name: null, purpose: '清园' }, '污染值进 purpose');
  assert.deepStrictEqual(rowOf(j2), { plant_type_name: '柑橘', purpose: null }, '计算器作物不动');
  assert.deepStrictEqual(rowOf(j3), { plant_type_name: '控高', purpose: '已手填' }, '已有 purpose 行原样');
  assert.strictEqual(rowOf(j4).purpose, null, '无值行不动');
  assert.strictEqual(report.money_unchanged, true, '金额九键分文不动');
  assert.deepStrictEqual(snapshotSums(db), before, '金额前后一致');

  // 幂等：重跑 0 行
  const again = backfill008(db);
  assert.strictEqual(again.moved, 0);
  assert.strictEqual(again.scanned, 0, '污染行已清空，重扫 0 行');
  assert.deepStrictEqual(rowOf(j1), { plant_type_name: null, purpose: '清园' }, '重跑值不变');
});

test('backfill008：raw purpose 与列值不一致 → 按列值搬移并出 warning', () => {
  const j = seedJob(db, {
    jobNo: 'J20260305-01', source: 'import', plant: '打药',
    rawPurpose: '人工作业目的'
  });
  const report = backfill008(db);
  assert.strictEqual(report.moved, 1);
  assert.deepStrictEqual(rowOf(j), { plant_type_name: null, purpose: '打药' }, '按列值搬移');
  assert.strictEqual(report.warnings.length, 1, JSON.stringify(report.warnings));
  assert.ok(report.warnings[0].includes('J20260305-01'), 'warning 指到作业');
});

test('backfill008：纯空白 plant_type_name 行跳过不计搬移', () => {
  const j = seedJob(db, { jobNo: 'J20260306-01', source: 'import', plant: '   ' });
  const report = backfill008(db);
  assert.strictEqual(report.moved, 0);
  assert.strictEqual(rowOf(j).plant_type_name, '   ', '空白值不搬运也不清（保守）');
});
