/* ============================================================
   services/overview.js — 总表（P4-M1，HANDOFF-P4-PLAN §2.1）
   作业单粒度的聚合只读视图：一次 JOIN 成型（jobs→settlements→
   bills→parties），账单字段按作业聚合，行=原 Excel 一行。
   只读：全程 SELECT，不写任何表、不产生分录/留痕。
   口径（均为 _cents 整数分）：
     - amount/paid = SUM(bills)（非 void）
     - discount    = SUM(|adjust|)（导入正数抹零与手工负数抹零统一按优惠计）
     - due         = SUM(仅 unpaid/partial: amount − |adjust| − paid)，paid/void 记 0
     - extra       = kind='extra' 结算行 spray_fee 合计（另收标签）
   ============================================================ */
'use strict';

/** 分组聚合骨架；WHERE 追加条件与 LIMIT 由 listOverview 拼（全部走参数绑定） */
const GROUP_SQL = `
  SELECT j.id, j.job_no, j.job_date, j.status AS job_status, j.source, j.job_type,
    j.total_area_mu, j.income_cents, j.note, j.referral_name, j.operator_names,
    COALESCE(j.purpose, j.plant_type_name) AS plant_label,
    GROUP_CONCAT(DISTINCT COALESCE(p.name, b.farmer_name)) AS customer_names,
    MAX(p.region) AS region, MAX(p.village) AS village, MAX(p.team) AS team,
    (SELECT l.unit_price_cents FROM job_settlement_lines l
      WHERE l.job_id = j.id AND l.kind = 'spray' AND l.unit_price_cents IS NOT NULL
      LIMIT 1) AS unit_price_cents,
    COALESCE(SUM(b.amount_cents), 0) AS amount_cents,
    COALESCE(SUM(b.paid_cents), 0) AS paid_cents,
    COALESCE(SUM(CASE WHEN b.status = 'void' THEN 0 ELSE ABS(b.adjust_cents) END), 0) AS discount_cents,
    COALESCE(SUM(CASE WHEN b.status IN ('unpaid', 'partial')
      THEN b.amount_cents - ABS(b.adjust_cents) - b.paid_cents ELSE 0 END), 0) AS due_cents,
    GROUP_CONCAT(DISTINCT b.status) AS bill_statuses,
    COUNT(b.id) AS bill_count,
    (SELECT COALESCE(SUM(l2.spray_fee_cents), 0) FROM job_settlement_lines l2
      WHERE l2.job_id = j.id AND l2.kind = 'extra') AS extra_cents,
    (SELECT r.collector_name FROM receipts r WHERE r.status = 'active' AND r.bill_id IN
      (SELECT b2.id FROM bills b2 WHERE b2.settlement_id = s.id AND b2.status != 'void')
      LIMIT 1) AS collector_name,
    MAX(b.id) AS bill_id, MAX(b.party_id) AS bill_party_id,
    MIN(b.adjust_cents) AS bill_adjust, MIN(b.note) AS bill_note
  FROM jobs j
  LEFT JOIN settlements s ON s.job_id = j.id AND s.status != 'void'
  LEFT JOIN bills b ON b.settlement_id = s.id AND b.status != 'void'
  LEFT JOIN parties p ON p.id = b.party_id
  WHERE j.deleted_at IS NULL AND j.status != 'void'`;

const LIMIT_MAX = 2000;

function buildWhere({ from, to, status } = {}) {
  const cond = [];
  const args = [];
  if (from) { cond.push('j.job_date >= ?'); args.push(String(from)); }
  if (to) { cond.push('j.job_date <= ?'); args.push(String(to)); }
  if (status) { cond.push('j.status = ?'); args.push(String(status)); }
  return { sql: cond.length ? ' AND ' + cond.join(' AND ') : '', args };
}

/** 作业粒度总表行；operator_names 服务端解成数组（同 getJob 做法） */
function parseOperators(r) {
  try { return { ...r, operator_names: JSON.parse(r.operator_names || '[]') }; }
  catch (e) { return { ...r, operator_names: [] }; }
}

/**
 * GET /api/overview?from=&to=&status=&limit=
 * 返回 { rows, totals }；totals 与 rows 同一 SQL 骨架（外层 SUM），供前端 tfoot 对账。
 */
function listOverview(db, { from, to, status, limit } = {}) {
  const { sql: whereSql, args } = buildWhere({ from, to, status });
  const lim = Math.min(Math.max(Number(limit) || LIMIT_MAX, 1), LIMIT_MAX);
  const rows = db.prepare(
    `${GROUP_SQL}${whereSql} GROUP BY j.id ORDER BY j.job_date DESC, j.id DESC LIMIT ${lim}`
  ).all(...args).map(parseOperators);
  const totals = db.prepare(
    `SELECT COUNT(*) AS row_count,
       COALESCE(SUM(amount_cents), 0) AS amount_cents,
       COALESCE(SUM(paid_cents), 0) AS paid_cents,
       COALESCE(SUM(due_cents), 0) AS due_cents,
       COALESCE(SUM(discount_cents), 0) AS discount_cents,
       COALESCE(SUM(extra_cents), 0) AS extra_cents
     FROM (${GROUP_SQL}${whereSql} GROUP BY j.id)`
  ).get(...args);
  return { rows, totals };
}

module.exports = { listOverview, LIMIT_MAX };
