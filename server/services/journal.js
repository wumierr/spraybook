/* ============================================================
   services/journal.js — 复式记账引擎
   - postEntry：借贷平衡断言（破平衡 = bug → UNBALANCED 500）
   - reverseEntry：红冲 = 等额反向新分录，原分录永不动（审计红线）
   - 单号 V+YYYYMMDD-NNN；行金额必须 >0（schema CHECK），零金额行不生成
   ============================================================ */
'use strict';

const { ApiError } = require('./apiError');
const { nextBizNo, logEdit } = require('./audit');

/** 记账科目 code → id 缓存表 */
function accountIdByCode(db, code) {
  const row = db.prepare('SELECT id FROM accounts WHERE code = ? AND deleted_at IS NULL').get(code);
  if (!row) throw new ApiError('VALIDATION', `未知科目: ${code}`);
  return row.id;
}

/**
 * 过账。lines: [{account_code, direction('debit'|'credit'), amount_cents, party_id?, job_id?, memo?}]
 * 零金额行自动忽略；全部为零则不生成凭证（返回 null）。
 */
function postEntry(db, { event_type, ref_type, ref_id, occurred_at, memo, lines, reversal_of }) {
  const clean = (lines || []).filter(l => l.amount_cents != null && l.amount_cents > 0);
  if (!clean.length) return null;
  const debit = clean.filter(l => l.direction === 'debit').reduce((a, l) => a + l.amount_cents, 0);
  const credit = clean.filter(l => l.direction === 'credit').reduce((a, l) => a + l.amount_cents, 0);
  if (debit !== credit) {
    throw new ApiError('UNBALANCED', `借贷不平: 借 ${debit} ≠ 贷 ${credit}（${event_type}）`, 500);
  }
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const entry_no = nextBizNo(db, 'journal_entries', 'entry_no', 'V');
    const info = db.prepare(
      `INSERT INTO journal_entries (entry_no, event_type, ref_type, ref_id, occurred_at, memo, status, reversal_of, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    ).run(entry_no, event_type, ref_type || null, ref_id || null, occurred_at || now, memo || null,
      reversal_of || null, now);
    const entryId = info.lastInsertRowid;
    const ins = db.prepare(
      `INSERT INTO journal_lines (entry_id, account_id, direction, amount_cents, party_id, job_id, memo)
       VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const l of clean) {
      ins.run(entryId, accountIdByCode(db, l.account_code), l.direction, l.amount_cents,
        l.party_id || null, l.job_id || null, l.memo || null);
    }
    logEdit(db, { table: 'journal_entries', recordId: entryId, action: 'create',
      after: { entry_no, event_type, ref_type, ref_id, debit, credit } });
    return entryId;
  });
  return tx();
}

/** 红冲：等额反向新分录，reversal_of 指向原分录；原分录保持 active 不动 */
function reverseEntry(db, entryId, { occurred_at, memo } = {}) {
  const entry = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(entryId);
  if (!entry) throw new ApiError('NOT_FOUND', `凭证不存在: ${entryId}`, 404);
  const lines = db.prepare(
    `SELECT l.*, a.code AS account_code FROM journal_lines l
     JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ?`).all(entryId);
  const flipped = lines.map(l => ({
    account_code: l.account_code,
    direction: l.direction === 'debit' ? 'credit' : 'debit',
    amount_cents: l.amount_cents,
    party_id: l.party_id, job_id: l.job_id,
    memo: '红冲 ' + (l.memo || '')
  }));
  return postEntry(db, {
    event_type: 'reversal', ref_type: entry.ref_type, ref_id: entry.ref_id,
    occurred_at: occurred_at || new Date().toISOString(),
    memo: memo || ('红冲凭证 ' + entry.entry_no + '：' + (entry.memo || '')),
    lines: flipped,
    reversal_of: entry.id
  });
}

/** 查询：entries + lines（含科目名），可按日期/来源过滤 */
function getJournal(db, { from, to, ref_type, ref_id } = {}) {
  const where = ['1=1'];
  const args = [];
  if (from) { where.push('occurred_at >= ?'); args.push(from); }
  if (to) { where.push('occurred_at <= ?'); args.push(to); }
  if (ref_type) { where.push('ref_type = ?'); args.push(ref_type); }
  if (ref_id) { where.push('ref_id = ?'); args.push(ref_id); }
  const entries = db.prepare(
    `SELECT * FROM journal_entries WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 500`
  ).all(...args);
  const lineStmt = db.prepare(
    `SELECT l.*, a.code AS account_code, a.name AS account_name
     FROM journal_lines l JOIN accounts a ON a.id = l.account_id
     WHERE l.entry_id = ? ORDER BY l.id`);
  return entries.map(e => ({ ...e, lines: lineStmt.all(e.id) }));
}

module.exports = { postEntry, reverseEntry, getJournal, accountIdByCode };
