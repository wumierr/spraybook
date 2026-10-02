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

/** 按客户盈利（收入科目挂 party_id）+ 欠款/预收余额
    include_all=1（P4-M2）：parties 左连收入聚合，补齐「期内无收入但有欠款/预收」的客户 */
function byCustomer(db, { from, to, include_all } = {}) {
  const { cond, args } = rangeCond(from, to, 'e.occurred_at');
  const rangeOn = cond.length ? 'AND ' + cond.join(' AND ') : '';
  const income = include_all
    ? db.prepare(
      `SELECT p.id AS party_id, p.name,
         COALESCE(SUM(CASE WHEN a.type='income' THEN (CASE l.direction WHEN 'credit' THEN l.amount_cents ELSE -l.amount_cents END) END),0) AS income_cents
       FROM parties p
       LEFT JOIN journal_lines l ON l.party_id = p.id
       LEFT JOIN journal_entries e ON e.id = l.entry_id ${rangeOn}
       LEFT JOIN accounts a ON a.id = l.account_id AND a.type='income'
       WHERE p.deleted_at IS NULL
       GROUP BY p.id ORDER BY income_cents DESC, p.id`
    ).all(...args)
    : db.prepare(
      `SELECT l.party_id, p.name,
         COALESCE(SUM(CASE l.direction WHEN 'credit' THEN l.amount_cents ELSE -l.amount_cents END),0) AS income_cents
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN accounts a ON a.id = l.account_id
       LEFT JOIN parties p ON p.id = l.party_id
       WHERE a.type='income' AND l.party_id IS NOT NULL ${rangeOn}
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

/* ============================================================
   P4-M2 报表时间分组（HANDOFF-P4-PLAN §3.4）
   分桶口径（均实测）：
     月 strftime('%Y-%m',x)   季 printf('%d-Q%d',y,(m+2)/3)（1-3 月=Q1）
     年 strftime('%Y',x)      周 printf('%d-W%02d',y,%W)——周一始自然周，
       年内首个周一前的日子=W00（如 2026-01-01 落 2026-W00，非 ISO8601 归次年周）
   期间边界 period_start/end = 桶内实际日期 MIN/MAX（周有空隙时以此说明）
   ============================================================ */

const GRANULARITIES = ['month', 'week', 'quarter', 'year'];

/** {col} 处填入分桶列；全部走参数绑定，仅桶表达式为白名单拼串 */
function bucketExpr(granularity, col) {
  switch (granularity) {
    case 'month': return `strftime('%Y-%m', ${col})`;
    case 'quarter': return `printf('%d-Q%d', CAST(strftime('%Y',${col}) AS INT), (CAST(strftime('%m',${col}) AS INT)+2)/3)`;
    case 'year': return `strftime('%Y', ${col})`;
    case 'week': return `printf('%d-W%02d', CAST(strftime('%Y',${col}) AS INT), CAST(strftime('%W',${col}) AS INT))`;
    default: throw new ApiError('VALIDATION', `granularity 必须是 ${GRANULARITIES.join('/')}`);
  }
}

/** 相邻桶环比：对上一返回行（首桶 null，上一桶为 0 记 null），保留两位小数 */
function pct(cur, prev) {
  if (prev == null || prev === 0) return null;
  return Math.round((cur - prev) / prev * 10000) / 100;
}

/**
 * GET /api/reports/by-period?granularity=month|week|quarter|year&from=&to=
 * 双轴分桶，避免账簿（确认时点 occurred_at）/作业（job_date）混轴：
 *   pl[]   = 盈亏轴（journal income/expense 科目，按凭证 occurred_at 分桶）
 *   work[] = 作业轴（jobs 快照，按 job_date 分桶；customer_count=结算分项挂 party 去重数）
 */
function byPeriod(db, { granularity, from, to } = {}) {
  if (!GRANULARITIES.includes(granularity)) {
    throw new ApiError('VALIDATION', `granularity 必须是 ${GRANULARITIES.join('/')}`);
  }
  const plRange = rangeCond(from, to, 'e.occurred_at');
  const pl = db.prepare(
    `SELECT ${bucketExpr(granularity, 'e.occurred_at')} AS period,
       MIN(SUBSTR(e.occurred_at, 1, 10)) AS period_start,
       MAX(SUBSTR(e.occurred_at, 1, 10)) AS period_end,
       COALESCE(SUM(CASE WHEN a.type='income' THEN (CASE l.direction WHEN 'credit' THEN l.amount_cents ELSE -l.amount_cents END) END),0) AS income_cents,
       COALESCE(SUM(CASE WHEN a.type='expense' THEN (CASE l.direction WHEN 'debit' THEN l.amount_cents ELSE -l.amount_cents END) END),0) AS expense_cents
     FROM journal_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     JOIN accounts a ON a.id = l.account_id
     WHERE a.type IN ('income','expense') ${plRange.cond.length ? 'AND ' + plRange.cond.join(' AND ') : ''}
     GROUP BY period ORDER BY period`
  ).all(...plRange.args)
    .map((r, i, arr) => {
      const prev = i > 0 ? arr[i - 1] : null;
      return {
        ...r, profit_cents: r.income_cents - r.expense_cents,
        income_pct: pct(r.income_cents, prev && prev.income_cents),
        expense_pct: pct(r.expense_cents, prev && prev.expense_cents),
        profit_pct: pct(r.income_cents - r.expense_cents, prev && prev.income_cents - prev.expense_cents)
      };
    });
  const workRange = rangeCond(from, to, 'j.job_date');
  const workWhere = `j.deleted_at IS NULL AND j.status != 'void' ${workRange.cond.length ? 'AND ' + workRange.cond.join(' AND ') : ''}`;
  const workArgs = workRange.args;
  // 作业数/亩数按 jobs 单表聚合（JOIN 结算分项会把面积乘以分项行数）
  const workBase = db.prepare(
    `SELECT ${bucketExpr(granularity, 'j.job_date')} AS period,
       MIN(j.job_date) AS period_start,
       MAX(j.job_date) AS period_end,
       COUNT(*) AS jobs_count,
       ROUND(COALESCE(SUM(j.total_area_mu), 0), 2) AS area_mu
     FROM jobs j
     WHERE ${workWhere}
     GROUP BY period ORDER BY period`
  ).all(...workArgs);
  // 客户数 = 结算分项挂 party 去重（创建时挂 party_id；确认分录行同样挂），单独聚合并按桶合并
  const custRows = db.prepare(
    `SELECT ${bucketExpr(granularity, 'j.job_date')} AS period,
       COUNT(DISTINCT si.party_id) AS customer_count
     FROM jobs j
     JOIN settlements s ON s.job_id = j.id AND s.status != 'void'
     JOIN settlement_items si ON si.settlement_id = s.id
     WHERE ${workWhere}
     GROUP BY period`
  ).all(...workArgs);
  const custMap = new Map(custRows.map(r => [r.period, r.customer_count]));
  const work = workBase
    .map(r => ({ ...r, customer_count: custMap.get(r.period) || 0 }))
    .map((r, i, arr) => {
      const prev = i > 0 ? arr[i - 1] : null;
      return {
        ...r,
        jobs_pct: pct(r.jobs_count, prev && prev.jobs_count),
        area_pct: pct(r.area_mu, prev && prev.area_mu)
      };
    });
  return { granularity, pl, work };
}

/**
 * GET /api/reports/adjustments?granularity=&from=&to=
 * 账单口径回款专项：按 bills.issued_at 分桶、非 void 且 issued_at 非空。
 * 抹零 = Σ|adjust|（导入正数抹零与手工负数抹零统一按优惠计，双语义归一）；
 * 超收 = ΣMAX(0, paid − (amount − |adjust|))（createReceipt 手工超收校验保持不变，此处只统计）；
 * due 仅 unpaid/partial 计（与 overview 端点同式）；回收率 = collected/billed（分母 0 记 null，超收月份可 >100%）。
 */
function adjustments(db, { granularity, from, to } = {}) {
  const gran = granularity || 'month';
  if (!GRANULARITIES.includes(gran)) {
    throw new ApiError('VALIDATION', `granularity 必须是 ${GRANULARITIES.join('/')}`);
  }
  const range = rangeCond(from, to, 'b.issued_at');
  const rows = db.prepare(
    `SELECT ${bucketExpr(gran, 'b.issued_at')} AS period,
       MIN(SUBSTR(b.issued_at, 1, 10)) AS period_start,
       MAX(SUBSTR(b.issued_at, 1, 10)) AS period_end,
       COALESCE(SUM(b.amount_cents), 0) AS billed_cents,
       COALESCE(SUM(b.paid_cents), 0) AS collected_cents,
       COALESCE(SUM(ABS(b.adjust_cents)), 0) AS discount_cents,
       COALESCE(SUM(MAX(0, b.paid_cents - (b.amount_cents - ABS(b.adjust_cents)))), 0) AS overpaid_cents,
       COALESCE(SUM(CASE WHEN b.status IN ('unpaid','partial')
         THEN b.amount_cents - ABS(b.adjust_cents) - b.paid_cents ELSE 0 END), 0) AS due_cents
     FROM bills b
     WHERE b.status != 'void' AND b.issued_at IS NOT NULL ${range.cond.length ? 'AND ' + range.cond.join(' AND ') : ''}
     GROUP BY period ORDER BY period`
  ).all(...range.args)
    .map(r => ({
      ...r,
      collection_rate: r.billed_cents > 0 ? Math.round(r.collected_cents / r.billed_cents * 10000) / 100 : null
    }));
  const t = rows.reduce((a, r) => ({
    billed_cents: a.billed_cents + r.billed_cents,
    collected_cents: a.collected_cents + r.collected_cents,
    discount_cents: a.discount_cents + r.discount_cents,
    overpaid_cents: a.overpaid_cents + r.overpaid_cents,
    due_cents: a.due_cents + r.due_cents
  }), { billed_cents: 0, collected_cents: 0, discount_cents: 0, overpaid_cents: 0, due_cents: 0 });
  t.collection_rate = t.billed_cents > 0 ? Math.round(t.collected_cents / t.billed_cents * 10000) / 100 : null;
  return {
    granularity: gran, rows, totals: t,
    note: '回收率=实收/应收（账单 billed 口径）；抹零=Σ|adjust|（正负均按优惠金额计）；存在超收时回收率可>100%；红冲/作废账单不计。'
  };
}

/**
 * GET /api/reports/cost-breakdown?source=job|journal&from=&to=
 * 两口径不可相加：job=作业归属成本快照（007 六列；导入单全 0），journal=支出付款凭证现金（5001-5007）。
 */
function costBreakdown(db, { source, from, to } = {}) {
  if (source === 'journal') {
    const { cond, args } = rangeCond(from, to, 'e.occurred_at');
    const items = db.prepare(
      `SELECT a.code, a.name, COALESCE(SUM(CASE l.direction WHEN 'debit' THEN l.amount_cents ELSE -l.amount_cents END),0) AS cents
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN accounts a ON a.id = l.account_id
       WHERE a.type='expense' AND a.code LIKE '500%' ${cond.length ? 'AND ' + cond.join(' AND ') : ''}
       GROUP BY a.code ORDER BY a.code`
    ).all(...args);
    return {
      source, items,
      total_cents: items.reduce((a, c) => a + c.cents, 0),
      note: '账簿口径=支出付款凭证（现金时点）。与 source=job 的作业归属口径统计对象不同，两口径不可相加。'
    };
  }
  if (source === 'job') {
    const { cond, args } = rangeCond(from, to, 'j.job_date');
    const SUMS = `COALESCE(SUM(j.fuel_expense_cents),0) AS fuel_cents,
       COALESCE(SUM(j.battery_depreciation_cents),0) AS battery_cents,
       COALESCE(SUM(j.labor_cost_cents),0) AS labor_cents,
       COALESCE(SUM(j.pesticide_cost_cents),0) AS pesticide_cents,
       COALESCE(SUM(j.equipment_cost_cents),0) AS equipment_cents,
       COALESCE(SUM(j.misc_cost_cents),0) AS misc_cents`;
    const r = db.prepare(
      `SELECT ${SUMS} FROM jobs j
       WHERE j.deleted_at IS NULL AND j.status != 'void' ${cond.length ? 'AND ' + cond.join(' AND ') : ''}`
    ).get(...args);
    const rc = db.prepare(
      `SELECT ${SUMS} FROM jobs j
       WHERE j.deleted_at IS NULL AND j.status != 'void' AND j.source = 'calculator'
         ${cond.length ? 'AND ' + cond.join(' AND ') : ''}`
    ).get(...args);
    const items = [
      { key: 'fuel', name: '油费', cents: r.fuel_cents },
      { key: 'battery', name: '电池折旧', cents: r.battery_cents },
      { key: 'labor', name: '人工', cents: r.labor_cents },
      { key: 'pesticide', name: '药剂', cents: r.pesticide_cents },
      { key: 'equipment', name: '设备分摊', cents: r.equipment_cents },
      { key: 'misc', name: '杂费', cents: r.misc_cents }
    ];
    const calculatorOnly = [
      rc.fuel_cents, rc.battery_cents, rc.labor_cents, rc.pesticide_cents, rc.equipment_cents, rc.misc_cents
    ];
    return {
      source, items,
      total_cents: items.reduce((a, c) => a + c.cents, 0),
      calculator_only_cents: calculatorOnly.reduce((a, c) => a + c, 0),
      import_zero_note: '导入单成本=0（导入历史无成本凭据），仅计算器单有值——合计虚低属预期。',
      note: '作业归属口径=结算时成本快照（007）。与 source=journal 的付款现金口径统计对象不同，两口径不可相加。'
    };
  }
  throw new ApiError('VALIDATION', 'source 必须是 job / journal');
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

module.exports = {
  summary, byMonth, byCustomer, byJob, partyBalance,
  byPeriod, adjustments, costBreakdown, GRANULARITIES
};
