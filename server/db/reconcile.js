/* ============================================================
   db/reconcile.js — 对账三平固化脚本（P7-R1/D4）
   把历次审查探针里的守恒检查固化为一条常驻命令：
     npm run reconcile        （默认读 SPRAYBOOK_DATA_DIR 或 data/app.db）
   作为每次数据订正/批量导入后的验收命令：任何一项 hard 检查失败 exitCode=1。

   检查项：
     C1 借贷平衡        Σ借 = Σ贷（含红冲，红冲=等额反向必平）
     C2 1122 恒等       1122 净额 = Σ非void账单(amount − paid)
                        （全系统约定：确认借 1122=amount、收款贷 1122=实收，
                         adjust 永不进分录——抹零残差因此挂在 1122，见 I1）
     C3 已收清无欠      status='paid' ⇒ paid ≥ amount+adjust（应付=amount+adjust，
                        adjust 为负=抹零；违反即"已收清却应收>已收"的显示矛盾）
     C4 作业收入守恒    jobs.income_cents = Σ该作业结算行金额（NULL 安全）
     C5 结算分录守恒    非void结算 total_receivable_cents = 该结算名下全部分录
                        （confirm−红冲净额）的 1122 净借方
     I1 抹零残差(信息)  已收清账单里 amount−paid 的合计 = 被抹掉但仍挂 1122 的钱
     I2 收款合计(信息)  active 且挂账单的收款合计 vs 非void账单 paid_cents 合计
                        （预收核销等路径可能合法地不相等，仅报告）
     I3 staging(信息)   reviewing 批次与 pending/confirmed 行数（待办提示）

   运行：node server/db/reconcile.js [--db <路径>]
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { openDb } = require('./client');

function dataDirOf() {
  return process.env.SPRAYBOOK_DATA_DIR || path.join(__dirname, '..', '..', 'data');
}

/** 对账主函数（只读打开即可，全部为 SELECT） */
function runReconcile(db) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const checks = [];
  const add = (id, name, ok, detail) => checks.push({ id, name, ok: !!ok, detail });

  /* C1 借贷平衡 */
  const bal = one(
    `SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount_cents END),0) AS debit,
            COALESCE(SUM(CASE WHEN direction='credit' THEN amount_cents END),0) AS credit
       FROM journal_lines`);
  add('C1', '借贷平衡', bal.debit === bal.credit, `借 ${bal.debit} 分 / 贷 ${bal.credit} 分`);

  /* C2 1122 恒等 */
  const ar = one(
    `SELECT (SELECT COALESCE(SUM(CASE l.direction WHEN 'debit' THEN l.amount_cents ELSE -l.amount_cents END),0)
               FROM journal_lines l JOIN accounts a ON a.id = l.account_id
              WHERE a.code = '1122') AS journal,
            (SELECT COALESCE(SUM(amount_cents - paid_cents),0) FROM bills WHERE status != 'void') AS bills`);
  add('C2', '1122 恒等（账簿=账单 amount−paid）', ar.journal === ar.bills,
    `1122 净额 ${ar.journal} 分 vs 账单 ${ar.bills} 分（差 ${ar.journal - ar.bills}）`);

  /* C3 已收清无欠 */
  const owing = db.prepare(
    `SELECT bill_no, amount_cents + adjust_cents AS payable, paid_cents
       FROM bills WHERE status = 'paid' AND paid_cents < amount_cents + adjust_cents`).all();
  add('C3', '已收清无欠（paid ≥ 应付）', owing.length === 0,
    owing.length ? owing.slice(0, 5).map(b => `${b.bill_no} 应收${(b.payable / 100).toFixed(2)}>已收${(b.paid_cents / 100).toFixed(2)}`).join('；') + (owing.length > 5 ? ` 等 ${owing.length} 张` : '') : '全部一致');

  /* C4 作业收入守恒（行金额=作业钱+药钱；NULL 安全：无结算行的作业按 0 对账） */
  const badJobs = db.prepare(
    `SELECT j.id, j.job_no, j.income_cents
       FROM jobs j WHERE j.status != 'void'
         AND j.income_cents != COALESCE((SELECT SUM(COALESCE(l.spray_fee_cents,0) + COALESCE(l.pesticide_fee_cents,0))
                                           FROM job_settlement_lines l WHERE l.job_id = j.id), 0)`).all();
  add('C4', '作业收入 = Σ结算行(作业钱+药钱)', badJobs.length === 0,
    badJobs.length ? badJobs.slice(0, 5).map(j => `${j.job_no} 金额${j.income_cents}≠行`).join('；') + (badJobs.length > 5 ? ` 等 ${badJobs.length} 单` : '') : '全部一致');

  /* C5 结算分录守恒（confirm − 红冲净额；红冲沿用原 ref_type/ref_id） */
  const badSt = db.prepare(
    `SELECT s.id, s.settlement_no, s.total_receivable_cents,
            COALESCE((SELECT SUM(CASE l.direction WHEN 'debit' THEN l.amount_cents ELSE -l.amount_cents END)
                        FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
                       JOIN accounts a ON a.id = l.account_id
                       WHERE e.ref_type = 'settlement' AND e.ref_id = s.id AND a.code = '1122'), 0) AS entry_net
       FROM settlements s WHERE s.status != 'void'
         AND s.total_receivable_cents != COALESCE(
               (SELECT SUM(CASE l.direction WHEN 'debit' THEN l.amount_cents ELSE -l.amount_cents END)
                  FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
                  JOIN accounts a ON a.id = l.account_id
                 WHERE e.ref_type = 'settlement' AND e.ref_id = s.id AND a.code = '1122'), 0)`).all();
  add('C5', '结算应收 = 分录 1122 净借方', badSt.length === 0,
    badSt.length ? badSt.slice(0, 5).map(s => `${s.settlement_no} ${s.total_receivable_cents}≠${s.entry_net}`).join('；') + (badSt.length > 5 ? ` 等 ${badSt.length} 笔` : '') : '全部一致');

  /* 信息项 */
  const info = {};
  info.discount_residual = one(
    `SELECT COALESCE(SUM(amount_cents - paid_cents),0) s FROM bills
       WHERE status = 'paid' AND status != 'void' AND amount_cents > paid_cents`).s;
  info.receipts_on_bills = one(
    `SELECT (SELECT COALESCE(SUM(amount_cents),0) FROM receipts WHERE status='active' AND bill_id IS NOT NULL) AS r,
            (SELECT COALESCE(SUM(paid_cents),0) FROM bills WHERE status != 'void') AS b`).r;
  info.bills_paid_sum = one(
    `SELECT (SELECT COALESCE(SUM(amount_cents),0) FROM receipts WHERE status='active' AND bill_id IS NOT NULL) AS r,
            (SELECT COALESCE(SUM(paid_cents),0) FROM bills WHERE status != 'void') AS b`).b;
  info.staging = one(
    `SELECT (SELECT COUNT(*) FROM import_batches WHERE status='reviewing') AS batches,
            (SELECT COUNT(*) FROM raw_import_rows r JOIN import_batches b ON b.id = r.batch_id
              WHERE b.status='reviewing' AND r.status='pending') AS pending,
            (SELECT COUNT(*) FROM raw_import_rows r JOIN import_batches b ON b.id = r.batch_id
              WHERE b.status='reviewing' AND r.status='confirmed') AS confirmed`);

  return { ok: checks.every(c => c.ok), checks, info };
}

module.exports = { runReconcile, dataDirOf };

if (require.main === module) {
  const argDb = (() => {
    const i = process.argv.indexOf('--db');
    return i > -1 ? process.argv[i + 1] : null;
  })();
  const dbPath = argDb || path.join(dataDirOf(), 'app.db');
  if (!fs.existsSync(dbPath)) {
    console.error('[reconcile] 找不到数据库 ' + dbPath);
    process.exitCode = 1;
  } else {
    const db = openDb(dbPath, { readonly: true });
    try {
      const r = runReconcile(db);
      console.log('[reconcile] ' + dbPath);
      for (const c of r.checks) {
        console.log(`  ${c.ok ? '✓' : '✗'} ${c.id} ${c.name} — ${c.detail}`);
      }
      console.log(`  ℹ 抹零残差(挂1122): ${(r.info.discount_residual / 100).toFixed(2)} 元 | ` +
        `收款合计 ${r.info.receipts_on_bills} 分 vs 账单已收 ${r.info.bills_paid_sum} 分 | ` +
        `staging: ${r.info.staging.batches} 批 reviewing / ${r.info.staging.pending} pending / ${r.info.staging.confirmed} confirmed`);
      console.log(r.ok ? '[reconcile] 全部硬检查通过 ✓' : '[reconcile] 存在失败项 ✗');
      if (!r.ok) process.exitCode = 1;
    } finally {
      db.close();
    }
  }
}
