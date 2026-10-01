/* ============================================================
   services/audit.js — edit_logs 统一留痕 + 单号生成
   ============================================================ */
'use strict';

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混的 I O 0 1

/** YYYYMMDD-XXXX（4 位随机），服务端冲突时重生成用 */
function generateJobNo(dateStr, rand = Math.random) {
  const ymd = String(dateStr || '').slice(0, 10).replace(/-/g, '') || '00000000';
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += CHARS[Math.floor(rand() * CHARS.length)];
  return `${ymd}-${suffix}`;
}

/** 业务单号：前缀+日期+当日序号（settlement/bill/receipt/payment/advance/entry/jobs）
 *  dateStr 可指定业务日期（导入历史单据按作业日期编号），缺省今天 */
function nextBizNo(db, table, column, prefix, dateStr) {
  const day = String(dateStr || new Date().toISOString().slice(0, 10)).slice(0, 10).replace(/-/g, '');
  const like = `${prefix}${day}-%`;
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} LIKE ?`
  ).get(like);
  return `${prefix}${day}-${String(row.n + 1).padStart(3, '0')}`;
}

/** 编辑留痕（operator P0 固定 local，M7 补设置页 TODO） */
function logEdit(db, { table, recordId, action, before, after, operator = 'local' }) {
  db.prepare(
    `INSERT INTO edit_logs (table_name, record_id, action, before_json, after_json, operator, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    table, recordId, action,
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
    operator, new Date().toISOString()
  );
}

module.exports = { generateJobNo, nextBizNo, logEdit };
