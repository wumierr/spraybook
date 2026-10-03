/* ============================================================
   db/backfill-009.js — 一次性数据订正（P5-M1，HANDOFF-P5-PLAN §5.2）
   导入单主结算行单价回填：job_settlement_lines / settlement_items 的
   kind='spray' 且 unit_price_cents IS NULL 行，从 raw_json.raw.price_yuan
   回填（元 → 分，与落库侧 importExcel.js Math.round(price_yuan*100) 同基准）；
   无 raw 价时派生 ROUND(spray_fee_cents / area_mu)——该分支本身就是分/亩，
   不得再 ×100（R1-B1：旧式 ROUND(fee/area)*100 会放大 100 倍）。
   金额分文不动：007 的 9 个金额键前后相等；unit_price_cents 合计只记录
   不参与相等断言（它就是要变的值）；另断言变更仅发生在先前为 NULL 的行。
   区间自检：全部 spray 行 unit_price_cents ∈ [500,10000] 分（5–100 元/亩），
   在事务内 commit 前执行，失败 throw → 自动回滚 → exitCode=1（R1 建议 9）。
   运行：cd server && node db/backfill-009.js   （自动先备份 .db）
   幂等：只处理 NULL 行，重跑 0 行变更。
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { initDb, openDb } = require('./client');

const MIN_CENTS = 500;    // 5 元/亩
const MAX_CENTS = 10000;  // 100 元/亩
const WARN_DIFF_YUAN = 0.05; // raw 与派生单价差 >0.05 元出 warning 人工复核（R1-B2）

/** 回填主函数（事务内），返回报告
 *  {lines_fixed, items_fixed, unfilled, warnings[], sums_unchanged,
 *   unit_sums_before, unit_sums_after} */
function backfill009(db) {
  const report = {
    lines_fixed: 0, items_fixed: 0, unfilled: { lines: 0, items: 0 },
    warnings: [], sums_unchanged: false, unit_sums_before: null, unit_sums_after: null
  };

  // 回填前的金额基线（分文不动硬门槛）+ 单价合计（只记录）
  const sumsBefore = snapshotSums(db);
  report.unit_sums_before = unitSums(db);
  // 先前已填单价行快照（变更仅允许发生在 NULL 行）
  const preFilled = {
    lines: db.prepare('SELECT id, unit_price_cents FROM job_settlement_lines WHERE unit_price_cents IS NOT NULL').all(),
    items: db.prepare('SELECT id, unit_price_cents FROM settlement_items WHERE unit_price_cents IS NOT NULL').all()
  };

  const tx = db.transaction(() => {
    report.lines_fixed = fillTable(db, 'job_settlement_lines', report, 'lines');
    report.items_fixed = fillTable(db, 'settlement_items', report, 'items');
    collectWarnings(db, report);

    // 区间自检：commit 前执行，失败即 throw → 事务自动回滚 → 库保持原状
    const bad = db.prepare(
      `SELECT 'job_settlement_lines' AS t, id, unit_price_cents FROM job_settlement_lines
         WHERE kind='spray' AND unit_price_cents IS NOT NULL
           AND unit_price_cents NOT BETWEEN ${MIN_CENTS} AND ${MAX_CENTS}
       UNION ALL
       SELECT 'settlement_items', id, unit_price_cents FROM settlement_items
         WHERE kind='spray' AND unit_price_cents IS NOT NULL
           AND unit_price_cents NOT BETWEEN ${MIN_CENTS} AND ${MAX_CENTS}`).all();
    if (bad.length) {
      throw new Error(
        `单价区间自检失败：${bad.length} 行 spray 单价超出 [${MIN_CENTS},${MAX_CENTS}] 分 ` +
        `(5–100 元/亩)，样例 ` +
        bad.slice(0, 5).map(b => `${b.t}#${b.id}=${b.unit_price_cents}`).join(', ') +
        '（事务已回滚，库保持原状）');
    }
  });
  try {
    tx();
  } catch (e) {
    e.backfill009RolledBack = true;
    throw e;
  }

  // 金额基线断言（commit 后）：不一致 → 调用方 exitCode=1 并指向备份（007 同款）
  const sumsAfter = snapshotSums(db);
  report.sums_unchanged = JSON.stringify(sumsBefore) === JSON.stringify(sumsAfter);
  if (!report.sums_unchanged) {
    report.warnings.push('金额基线变化！before=' + JSON.stringify(sumsBefore) +
      ' after=' + JSON.stringify(sumsAfter));
  }
  // 变更仅发生在先前为 NULL 行的硬断言
  for (const [key, table] of [['lines', 'job_settlement_lines'], ['items', 'settlement_items']]) {
    const beforeMap = new Map(preFilled[key].map(r => [r.id, r.unit_price_cents]));
    const afterRows = db.prepare(`SELECT id, unit_price_cents FROM ${table} WHERE unit_price_cents IS NOT NULL`).all();
    for (const r of afterRows) {
      if (!beforeMap.has(r.id)) continue; // 本次回填的新值，允许
      if (beforeMap.get(r.id) !== r.unit_price_cents) {
        report.sums_unchanged = false;
        report.warnings.push(`${table}#${r.id} 原有单价 ${beforeMap.get(r.id)} 被改为 ${r.unit_price_cents}（禁止！）`);
      }
    }
  }
  report.unit_sums_after = unitSums(db);
  return report;
}

/** 单表回填：kind='spray' 且单价为 NULL 的行，raw 优先、派生兜底；返回更新行数 */
function fillTable(db, table, report, key) {
  // lines 直挂 job_id；items 经 settlement_id → settlements.job_id 关联
  const jobJoin = table === 'job_settlement_lines'
    ? 'LEFT JOIN jobs j ON j.id = t.job_id'
    : 'JOIN settlements s ON s.id = t.settlement_id LEFT JOIN jobs j ON j.id = s.job_id';
  const jobCol = table === 'job_settlement_lines' ? 't.job_id' : 's.job_id';
  const rows = db.prepare(
    `SELECT t.id, t.spray_fee_cents, t.area_mu, ${jobCol} AS job_id,
            json_extract(j.raw_json, '$.raw.price_yuan') AS price_yuan
     FROM ${table} t ${jobJoin}
     WHERE t.kind = 'spray' AND t.unit_price_cents IS NULL`).all();
  const upd = db.prepare(`UPDATE ${table} SET unit_price_cents = ? WHERE id = ? AND unit_price_cents IS NULL`);
  const jobIds = new Set();
  let n = 0;
  for (const r of rows) {
    // raw 分支：元 → 分（Math.round，与 importExcel.js 落库同基准）
    const raw = r.price_yuan != null ? Math.round(Number(r.price_yuan) * 100) : null;
    // 派生分支：spray_fee_cents/area_mu 本身就是分/亩，不得 ×100（R1-B1）
    const derived = (r.area_mu != null && r.area_mu > 0 && r.spray_fee_cents != null)
      ? Math.round(r.spray_fee_cents / r.area_mu)
      : null;
    const value = raw != null ? raw : derived;
    if (value == null) {
      report.unfilled[key] += 1;
      report.warnings.push(`${table}#${r.id}(job#${r.job_id}) 无 raw 单价且无面积/费用可派生，保持 NULL`);
      continue;
    }
    const info = upd.run(value, r.id);
    if (info.changes > 0) { n += 1; jobIds.add(r.job_id); }
  }
  report._touchedJobIds = report._touchedJobIds || new Set();
  for (const id of jobIds) report._touchedJobIds.add(id);
  return n;
}

/** warnings：本轮触达的作业里，raw 单价与派生单价差 >0.05 元的（每作业一条） */
function collectWarnings(db, report) {
  const probe = db.prepare(
    `SELECT j.job_no,
            json_extract(j.raw_json, '$.raw.price_yuan') AS price_yuan,
            (SELECT l.spray_fee_cents FROM job_settlement_lines l
              WHERE l.job_id = j.id AND l.kind = 'spray' AND l.area_mu > 0
              ORDER BY l.id LIMIT 1) AS fee_cents,
            (SELECT l.area_mu FROM job_settlement_lines l
              WHERE l.job_id = j.id AND l.kind = 'spray' AND l.area_mu > 0
              ORDER BY l.id LIMIT 1) AS area_mu
     FROM jobs j WHERE j.id = ?`);
  for (const jobId of report._touchedJobIds || []) {
    const p = probe.get(jobId);
    if (!p || p.price_yuan == null || p.fee_cents == null || !(p.area_mu > 0)) continue;
    const rawYuan = Number(p.price_yuan);
    const derivedYuan = p.fee_cents / p.area_mu / 100;
    const diff = Math.abs(rawYuan - derivedYuan);
    if (diff > WARN_DIFF_YUAN) {
      report.warnings.push(
        `job#${jobId}(${p.job_no}) raw 单价 ${rawYuan} 元/亩 vs 派生 ${derivedYuan.toFixed(2)} 元/亩，差 ${diff.toFixed(2)} 元 > ${WARN_DIFF_YUAN}（金额按未取整面积计算，以 raw 为权威）`);
    }
  }
  delete report._touchedJobIds;
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

/** 单价合计（只记录不参与相等断言——它就是要变的值） */
function unitSums(db) {
  const one = (sql) => db.prepare(sql).get().s;
  return {
    line_unit: one('SELECT COALESCE(SUM(unit_price_cents),0) s FROM job_settlement_lines'),
    item_unit: one('SELECT COALESCE(SUM(unit_price_cents),0) s FROM settlement_items')
  };
}

module.exports = { backfill009, snapshotSums, MIN_CENTS, MAX_CENTS, WARN_DIFF_YUAN };

if (require.main === module) {
  (async () => {
    const dbPath = path.join(__dirname, '..', '..', 'data', 'app.db');
    const bak = dbPath + '.bak-009';
    const wal = dbPath + '-wal';
    const walBusy = fs.existsSync(wal) && fs.statSync(wal).size > 0;
    if (fs.existsSync(dbPath) && !fs.existsSync(bak)) {
      if (walBusy) {
        // WAL 非空时 copyFileSync 主库文件会得到不完整备份（R1 建议 9）——改用在线一致备份
        const probe = openDb(dbPath);
        await probe.backup(bak);
        probe.close();
        console.log('[backfill-009] WAL 非空，已用在线备份（better-sqlite3 db.backup）: ' + bak);
      } else {
        fs.copyFileSync(dbPath, bak);
        console.log('[backfill-009] 已备份 ' + bak);
      }
    } else if (fs.existsSync(bak)) {
      console.log('[backfill-009] 备份已存在，不覆盖: ' + bak);
    } else {
      console.error('[backfill-009] 找不到数据库 ' + dbPath);
      process.exitCode = 1;
      return;
    }
    const db = initDb(dbPath); // 自动迁移（schema 由服务端启动时迁移，脚本单独跑时自迁）
    try {
      const report = backfill009(db);
      console.log('[backfill-009] 报告:', JSON.stringify(report, null, 2));
      if (!report.sums_unchanged) {
        console.error('[backfill-009] 金额基线变化，请检查备份 ' + bak);
        process.exitCode = 1;
      }
    } catch (e) {
      console.error('[backfill-009] 失败（' +
        (e.backfill009RolledBack ? '事务已回滚，库保持原状' : '请检查备份 ' + bak) + '）:', e.message);
      process.exitCode = 1;
    } finally {
      db.close();
    }
  })().catch(e => {
    console.error('[backfill-009] 失败:', e.message);
    process.exitCode = 1;
  });
}
