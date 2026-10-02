/* ============================================================
   migration.test.js — M1 库层验证
   运行：cd server && npm test   （或 node --test ../tests/server/）
   ============================================================ */
'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { freshDb } = require('./helpers/db');

let db;
beforeEach(() => { db = freshDb(); });

const EXPECTED_TABLES = [
  // 主数据
  'parties', 'plots', 'chemicals', 'equipment', 'price_rules',
  // 作业执行
  'jobs', 'job_plots', 'flight_groups', 'job_settlement_lines', 'job_battery_cycles',
  // 结算财务
  'settlements', 'settlement_items', 'bills', 'receipts', 'payments',
  'advances', 'advance_usages', 'manual_splits',
  // 复式记账
  'accounts', 'journal_entries', 'journal_lines',
  // 审计/导入
  'edit_logs', 'import_batches', 'raw_import_rows', 'settings'
];

test('001+seed 建齐五层 24 表（另 schema_migrations）', () => {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all().map(r => r.name);
  for (const t of EXPECTED_TABLES) {
    assert.ok(rows.includes(t), `缺表: ${t}`);
  }
  assert.strictEqual(rows.length, EXPECTED_TABLES.length + 1, '应恰好 25 业务表 + schema_migrations');
});

test('foreign_key_check 无孤儿（外键显式且开启）', () => {
  const fk = db.pragma('foreign_key_check');
  assert.strictEqual(fk.length, 0);
});

test('外键实际生效：违反外键必须报错', () => {
  assert.throws(() => {
    db.prepare(`INSERT INTO job_plots (job_id, plot_name, seq)
      VALUES (999, '不存在作业', 0)`).run();
  }, /FOREIGN KEY/);
});

test('科目种子 ≥15 且可重复执行（幂等）', () => {
  const n1 = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  assert.ok(n1 >= 15, `科目数 ${n1} < 15`);
  // 再跑一遍 seed 不应报错、不应重复
  const { seed } = require('../../server/db/client');
  seed(db);
  const n2 = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  assert.strictEqual(n1, n2, 'seed 必须幂等');
});

test('金额枚举与 CHECK 生效：jobs 非法状态被拒', () => {
  const now = new Date().toISOString();
  assert.throws(() => {
    db.prepare(`INSERT INTO jobs (job_no, client_job_id, job_type, status, job_date, created_at, updated_at)
      VALUES ('20260929-TEST', 'cjid-test-1', 'spray', 'bogus', ?, ?, ?)`)
      .run(now, now, now);
  }, /CHECK/);
});

test('client_job_id 幂等键 UNIQUE 生效', () => {
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO jobs
    (job_no, client_job_id, job_type, status, job_date, created_at, updated_at)
    VALUES (?, ?, 'spray', 'completed', ?, ?, ?)`);
  ins.run('20260929-AAAA', 'dup-1', now, now, now);
  assert.throws(() => {
    ins.run('20260929-BBBB', 'dup-1', now, now, now);
  }, /UNIQUE/);
});

test('迁移可重复执行（migrate 幂等）', () => {
  const { migrate } = require('../../server/db/client');
  migrate(db); // 第二次应全部跳过
  const n = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;
  assert.ok(n >= 1);
});

test('007 补列：成本构成/kind+unit_price/plot_id', () => {
  const jobsCols = db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
  for (const c of ['labor_cost_cents', 'pesticide_cost_cents', 'equipment_cost_cents',
    'misc_cost_cents', 'subsidy_cents']) {
    assert.ok(jobsCols.includes(c), `jobs 缺列 ${c}`);
  }
  // kind 默认 'spray'，非法值撞 CHECK
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO jobs (job_no, client_job_id, job_type, status, job_date, created_at, updated_at)
    VALUES ('20261002-K1', 'kj-1', 'spray', 'completed', ?, ?, ?)`).run(now, now, now);
  const job = db.prepare('SELECT id FROM jobs WHERE client_job_id = ?').get('kj-1');
  const line = db.prepare(
    `INSERT INTO job_settlement_lines (job_id, farmer_name, spray_fee_cents)
     VALUES (?, '张三', 1000)`).run(job.id);
  const k = db.prepare('SELECT kind, unit_price_cents FROM job_settlement_lines WHERE id = ?')
    .get(line.lastInsertRowid);
  assert.strictEqual(k.kind, 'spray', 'kind 默认 spray');
  assert.strictEqual(k.unit_price_cents, null);
  assert.throws(() => {
    db.prepare(`INSERT INTO job_settlement_lines (job_id, farmer_name, kind)
      VALUES (?, '张三', 'bogus')`).run(job.id);
  }, /CHECK/, 'kind 非法值被拒');
  const itemCols = db.prepare('PRAGMA table_info(settlement_items)').all().map(c => c.name);
  for (const c of ['kind', 'unit_price_cents']) assert.ok(itemCols.includes(c), `settlement_items 缺列 ${c}`);
  // plot_id 外键生效：不存在的地块 id 被拒
  assert.throws(() => {
    db.prepare(`INSERT INTO job_plots (job_id, plot_name, plot_id)
      VALUES (?, '测试地块', 999)`).run(job.id);
  }, /FOREIGN KEY/);
});
