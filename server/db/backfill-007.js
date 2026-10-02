/* ============================================================
   db/backfill-007.js — 一次性数据订正（P3，用户已裁决"允许订正"）
   订正三件事，金额分文不动：
   1) jobs 成本构成列：从 raw_json.result.costBreakdown /
      snapshot.income.subsidy 回填（calculator 来源）；构成与总额
      差超 ±2 分的打 warning（总额列是权威，构成仅分析用，照写）。
   2) 结算行伪行清理：farmer_name "张三（另按 25 元/亩）" →
      kind='extra' + unit_price_cents + 干净姓名（两表）。
   3) job_plots.plot_id 按名匹配主数据 plots。
   运行：cd server && node db/backfill-007.js   （自动先备份 .db）
   幂等：只处理 NULL/未匹配行，重跑无副作用。
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { initDb, openDb } = require('./client');

const EXTRA_RE = /^(.+?)[（(]\s*另按\s*([\d.]+)\s*元\s*\/\s*亩\s*[)）]$/;

function laborOf(cb) {
  if (cb.labor != null) return cb.labor;
  return Number(cb.droneLabor || 0) + Number(cb.pickupLabor || 0);
}

/** 回填主函数（事务内），返回报告 {jobs, lines_fixed, items_fixed, plots_linked, warnings[], sums_unchanged} */
function backfill007(db) {
  const report = { jobs: 0, lines_fixed: 0, items_fixed: 0, plots_linked: 0, warnings: [] };

  // 回填前的金额基线（分文不动硬门槛）
  const sumsBefore = snapshotSums(db);

  const tx = db.transaction(() => {
    /* ---- 1) jobs 成本构成 ---- */
    const jobs = db.prepare(
      "SELECT id, job_type, raw_json FROM jobs WHERE deleted_at IS NULL AND labor_cost_cents IS NULL AND raw_json IS NOT NULL").all();
    const updJob = db.prepare(
      `UPDATE jobs SET labor_cost_cents=?, pesticide_cost_cents=?, equipment_cost_cents=?,
         misc_cost_cents=?, subsidy_cents=? WHERE id=?`);
    for (const j of jobs) {
      let raw = null;
      try { raw = JSON.parse(j.raw_json); } catch (e) { continue; }
      const result = raw && (raw.result || raw.raw && raw.raw.result);
      const snapshot = raw && (raw.snapshot || raw.raw && raw.raw.snapshot);
      const cb = result && result.costBreakdown;
      if (!cb) continue; // 导入单无构成快照（total_cost=0），保持 NULL
      const labor = laborOf(cb);
      const sumParts = Number(cb.cycle || 0) + Number(cb.fuel || 0) + Number(labor || 0)
        + Number(cb.pesticide || 0) + Number(cb.equipment || 0) + Number(cb.other || 0);
      const total = Number(result.totalCost || 0);
      if (Math.abs(sumParts - total) > 0.02) {
        report.warnings.push(`job#${j.id} 构成合计 ${sumParts} 与总额 ${total} 差超容差（总额列未动）`);
      }
      const income = snapshot && snapshot.income;
      updJob.run(
        yuanToInt(labor), yuanToInt(cb.pesticide), yuanToInt(cb.equipment), yuanToInt(cb.other),
        income && income.subsidy != null ? yuanToInt(income.subsidy) : null,
        j.id);
      report.jobs++;
    }

    /* ---- 2) 伪行订正（job_settlement_lines + settlement_items）---- */
    report.lines_fixed += fixExtraRows(db, 'job_settlement_lines');
    report.items_fixed += fixExtraRows(db, 'settlement_items');

    /* ---- 3) job_plots.plot_id 按名匹配 ---- */
    const r = db.prepare(
      `UPDATE job_plots SET plot_id =
         (SELECT p.id FROM plots p WHERE p.name = job_plots.plot_name AND p.deleted_at IS NULL
          ORDER BY p.id LIMIT 1)
       WHERE plot_id IS NULL`).run();
    report.plots_linked = r.changes;
  });
  tx();

  const sumsAfter = snapshotSums(db);
  report.sums_unchanged = JSON.stringify(sumsBefore) === JSON.stringify(sumsAfter);
  if (!report.sums_unchanged) {
    report.warnings.push('金额基线变化！before=' + JSON.stringify(sumsBefore) + ' after=' + JSON.stringify(sumsAfter));
  }
  return report;
}

function fixExtraRows(db, table) {
  const rows = db.prepare(
    `SELECT id, farmer_name FROM ${table} WHERE kind = 'spray' AND farmer_name LIKE '%另按%'`).all();
  const upd = db.prepare(
    `UPDATE ${table} SET kind='extra', unit_price_cents=?, farmer_name=? WHERE id=?`);
  let n = 0;
  for (const row of rows) {
    const m = EXTRA_RE.exec(row.farmer_name);
    if (!m) continue; // 格式外留原样，warning 由调用方排查
    upd.run(Math.round(Number(m[2]) * 100), m[1].trim(), row.id);
    n++;
  }
  return n;
}

function yuanToInt(v) {
  if (v === null || v === undefined) return null;
  return Math.round(Number(v) * 100);
}

/** 金额基线：本轮订正涉及的金额列全表合计（回填前后必须一致） */
function snapshotSums(db) {
  const one = (sql) => db.prepare(sql).get().s;
  return {
    jobs_income: one('SELECT COALESCE(SUM(income_cents),0) s FROM jobs'),
    jobs_cost: one('SELECT COALESCE(SUM(total_cost_cents),0) s FROM jobs'),
    jobs_profit: one('SELECT COALESCE(SUM(profit_cents),0) s FROM jobs'),
    bill_amount: one('SELECT COALESCE(SUM(amount_cents),0) s FROM bills'),
    bill_paid: one('SELECT COALESCE(SUM(paid_cents),0) s FROM bills'),
    receipt_amount: one('SELECT COALESCE(SUM(amount_cents),0) s FROM receipts'),
    payment_amount: one('SELECT COALESCE(SUM(amount_cents),0) s FROM payments'),
    line_spray: one('SELECT COALESCE(SUM(spray_fee_cents),0) s FROM job_settlement_lines'),
    journal_debit: one("SELECT COALESCE(SUM(amount_cents),0) s FROM journal_lines WHERE direction='debit'")
  };
}

module.exports = { backfill007, snapshotSums };

if (require.main === module) {
  const dbPath = path.join(__dirname, '..', '..', 'data', 'app.db');
  const bak = dbPath + '.bak-007';
  if (fs.existsSync(dbPath) && !fs.existsSync(bak)) {
    fs.copyFileSync(dbPath, bak);
    console.log('[backfill-007] 已备份 ' + bak);
  }
  // 用 openDb（不 migrate）——schema 由服务端启动时迁移；脚本单独跑时需自迁
  const db = initDb(dbPath);
  const report = backfill007(db);
  console.log('[backfill-007] 报告:', JSON.stringify(report, null, 2));
  if (!report.sums_unchanged) {
    console.error('[backfill-007] 金额基线变化，请检查备份 ' + bak);
    process.exitCode = 1;
  }
  db.close();
}
