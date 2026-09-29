/* ============================================================
   services/reports.js — 报表（M6，以复式账簿为唯一事实来源）
   盈利 = 收入科目贷-借 vs 支出科目借-贷；余额 = 应收/预收科目净额
   ============================================================ */
'use strict';

const { ApiError } = require('./apiError');

function rangeCond(from, to, col) {
  const cond = [];
  const args = [];
  if (from) { cond.push(`${col} >= ?`); args.push(from); }
  if (to) { cond.push(`${col} <= ?`); args.push(to); }
  return { cond, args };
}

/** 总览：收入/支出/利润/应收/预收（可按日期过滤损益） */
function summary(db, { from, to } = {}) {
  const { cond, args } = rangeCond(from, to, 'e.occurred_at');
  const pl = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN a.type='income' THEN (CASE l.direction WHEN 'credit' THEN l.amount_cents ELSE -l.amount_cents END) END),0) AS income_cents,
       COALESCE(SUM(CASE WHEN a.type='expense' THEN (CASE l.direction WHEN 'debit' THEN l.amount_cents ELSE -l.amount_cents END) END),0) AS expense_cents
     FROM journal_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     JOIN accounts a ON a.id = l.account_id
     WHERE a.type IN ('income','expense') ${cond.length ? 'AND ' + cond.join(' AND ') : ''}`
  ).get(...args);
  const expenseByCat = db.prepare(
    `SELECT a.code, a.name, COALESCE(SUM(CASE l.direction WHEN 'debit' THEN l.amount_cents ELSE -l.amount_cents END),0) AS cents
     FROM journal_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     JOIN accounts a ON a.id = l.account_id
     WHERE a.type='expense' AND a.code LIKE '500%' ${cond.length ? 'AND ' + cond.join(' AND ') : ''}
     GROUP BY a.code ORDER BY a.code`
  ).all(...args);
  const receivable = db.prepare(
    `SELECT COALESCE(SUM(amount_cents + adjust_cents - paid_cents),0) AS n
     FROM bills WHERE status IN ('unpaid','partial')`).get().n;
  const prepaid = db.prepare(
    `SELECT COALESCE(SUM(balance_cents),0) AS n FROM advances
     WHERE direction='prepaid_by_customer' AND status IN ('open','partial')`).get().n;
  const advanceToWorker = db.prepare(
    `SELECT COALESCE(SUM(balance_cents),0) AS n FROM advances
     WHERE direction='advance_to_worker' AND status IN ('open','partial')`).get().n;
  return {
    from: from || null, to: to || null,
    income_cents: pl.income_cents,
    expense_cents: pl.expense_cents,
    profit_cents: pl.income_cents - pl.expense_cents,
    expense_by_category: expenseByCat,
    receivable_cents: receivable,
    prepaid_cents: prepaid,
    advance_to_worker_cents: advanceToWorker
  };
}

/** 月度盈亏（按凭证 occurred_at 归月） */
function byMonth(db, { from, to } = {}) {
  const { cond, args } = rangeCond(from, to, 'e.occurred_at');
  return db.prepare(
    `SELECT strftime('%Y-%m', e.occurred_at) AS month,
       COALESCE(SUM(CASE WHEN a.type='income' THEN (CASE l.direction WHEN 'credit' THEN l.amount_cents ELSE -l.amount_cents END) END),0) AS income_cents,
       COALESCE(SUM(CASE WHEN a.type='expense' THEN (CASE l.direction WHEN 'debit' THEN l.amount_cents ELSE -l.amount_cents END) END),0) AS expense_cents
     FROM journal_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     JOIN accounts a ON a.id = l.account_id
     WHERE a.type IN ('income','expense') ${cond.length ? 'AND ' + cond.join(' AND ') : ''}
     GROUP BY month ORDER BY month`
  ).all(...args).map(r => ({ ...r, profit_cents: r.income_cents - r.expense_cents }));
}

/** 按客户盈利（收入科目挂 party_id）+ 欠款/预收余额 */
function byCustomer(db, { from, to } = {}) {
  const { cond, args } = rangeCond(from, to, 'e.occurred_at');
  const income = db.prepare(
    `SELECT l.party_id, p.name,
       COALESCE(SUM(CASE l.direction WHEN 'credit' THEN l.amount_cents ELSE -l.amount_cents END),0) AS income_cents
     FROM journal_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     JOIN accounts a ON a.id = l.account_id
     LEFT JOIN parties p ON p.id = l.party_id
     WHERE a.type='income' AND l.party_id IS NOT NULL ${cond.length ? 'AND ' + cond.join(' AND ') : ''}
     GROUP BY l.party_id ORDER BY income_cents DESC`
  ).all(...args);
  const receivable = db.prepare(
    `SELECT party_id, COALESCE(SUM(amount_cents + adjust_cents - paid_cents),0) AS cents
     FROM bills WHERE status IN ('unpaid','partial') AND party_id IS NOT NULL GROUP BY party_id`).all();
  const prepaid = db.prepare(
    `SELECT party_id, COALESCE(SUM(balance_cents),0) AS cents FROM advances
     WHERE direction='prepaid_by_customer' AND status IN ('open','partial') GROUP BY party_id`).all();
  const recvMap = new Map(receivable.map(r => [r.party_id, r.cents]));
  const prepMap = new Map(prepaid.map(r => [r.party_id, r.cents]));
  return income.map(r => ({
    party_id: r.party_id, name: r.name,
    income_cents: r.income_cents,
    receivable_cents: recvMap.get(r.party_id) || 0,
    prepaid_cents: prepMap.get(r.party_id) || 0
  }));
}

/** 按作业盈利（jobs 快照口径；imported 作业成本=0 并标注） */
function byJob(db, { from, to, limit = 200 } = {}) {
  const cond = ['j.deleted_at IS NULL', "j.status != 'void'"];
  const args = [];
  if (from) { cond.push('j.job_date >= ?'); args.push(from); }
  if (to) { cond.push('j.job_date <= ?'); args.push(to); }
  return db.prepare(
    `SELECT j.id, j.job_no, j.job_date, j.job_type, j.source, j.total_area_mu, j.weight_jin,
            j.income_cents, j.total_cost_cents, (j.income_cents - j.total_cost_cents) AS profit_cents
     FROM jobs j WHERE ${cond.join(' AND ')}
     ORDER BY j.job_date DESC, j.id DESC LIMIT ${Number(limit) || 200}`
  ).all(...args);
}

/** 单客户余额 */
function partyBalance(db, partyId) {
  const party = db.prepare('SELECT id, name, type, village, team FROM parties WHERE id = ?').get(partyId);
  if (!party) throw new ApiError('NOT_FOUND', `客户不存在: ${partyId}`, 404);
  const receivable = db.prepare(
    `SELECT COALESCE(SUM(amount_cents + adjust_cents - paid_cents),0) AS n
     FROM bills WHERE party_id = ? AND status IN ('unpaid','partial')`).get(partyId).n;
  const prepaid = db.prepare(
    `SELECT COALESCE(SUM(balance_cents),0) AS n FROM advances
     WHERE party_id = ? AND direction='prepaid_by_customer' AND status IN ('open','partial')`).get(partyId).n;
  const lastJob = db.prepare(
    `SELECT job_no, job_date, plant_type_name, total_area_mu FROM jobs
     WHERE deleted_at IS NULL AND status != 'void'
       AND id IN (SELECT job_id FROM job_settlement_lines WHERE farmer_ref = ? OR farmer_name = ?)
     ORDER BY job_date DESC, id DESC LIMIT 1`).get(String(partyId), party.name);
  return { party, receivable_cents: receivable, prepaid_cents: prepaid, last_job: lastJob || null };
}

module.exports = { summary, byMonth, byCustomer, byJob, partyBalance };
