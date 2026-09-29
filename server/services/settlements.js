/* ============================================================
   services/settlements.js — 结算/账单（记账只写；消费作业执行层快照）
   状态机（docs/PLAN.md）：
     settlement: draft --confirm--> confirmed --reopen--> draft（红冲+账单作废）
                 draft/confirmed --void--> void（confirmed 红冲；作业转 void）
     job:        completed/reopened → settled（confirm）；settled → reopened（reopen）/void（void）
   规则：
     - 打药结算 = job_settlement_lines 快照逐户；吊运 = job 金额单行（party 可指定）
     - confirm 生成每户 bill + 自动分录（借 1122 应收 / 贷 6001 作业收入 + 6002 药收入）
     - 红冲 = 等额反向新分录，原分录永不动
     - 零金额分项不生成 bill（无意义账单）
   ============================================================ */
'use strict';

const { ApiError } = require('./apiError');
const { nextBizNo, logEdit } = require('./audit');
const { postEntry, reverseEntry } = require('./journal');
const { findPartyByNamePhone } = require('./parties');

function nowISO() { return new Date().toISOString(); }

function settlementWithDetails(db, id) {
  const s = db.prepare('SELECT * FROM settlements WHERE id = ?').get(id);
  if (!s) throw new ApiError('NOT_FOUND', `结算单不存在: ${id}`, 404);
  s.items = db.prepare('SELECT * FROM settlement_items WHERE settlement_id = ? ORDER BY id').all(id);
  s.bills = db.prepare('SELECT * FROM bills WHERE settlement_id = ? ORDER BY id').all(id);
  return s;
}

/** 从作业生成结算单（打药逐户 / 吊运单行） */
function createSettlement(db, job_id, { party_id } = {}) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND deleted_at IS NULL').get(job_id);
  if (!job) throw new ApiError('NOT_FOUND', `作业不存在: ${job_id}`, 404);
  if (!['completed', 'reopened'].includes(job.status)) {
    throw new ApiError('INVALID_STATE', `作业状态 ${job.status} 不可生成结算（需 completed/reopened）`);
  }
  const existing = db.prepare(
    "SELECT id FROM settlements WHERE job_id = ? AND status IN ('draft','confirmed')").get(job_id);
  if (existing) {
    throw new ApiError('INVALID_STATE', `作业已有未作废结算单 #${existing.id}`);
  }

  const now = nowISO();
  const tx = db.transaction(() => {
    const settlement_no = nextBizNo(db, 'settlements', 'settlement_no', 'S');
    const info = db.prepare(
      `INSERT INTO settlements (settlement_no, job_id, status, created_at, updated_at)
       VALUES (?, ?, 'draft', ?, ?)`
    ).run(settlement_no, job_id, now, now);
    const sid = info.lastInsertRowid;

    const insItem = db.prepare(
      `INSERT INTO settlement_items
         (settlement_id, party_id, farmer_name, area_mu, spray_fee_cents, used_sets,
          self_sets, supplement_sets, pesticide_fee_cents, included, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    if (job.job_type === 'spray') {
      const lines = db.prepare('SELECT * FROM job_settlement_lines WHERE job_id = ?').all(job_id);
      for (const l of lines) {
        const party = findPartyByNamePhone(db, l.farmer_name, '');
        insItem.run(sid, party ? party.id : null, l.farmer_name, l.area_mu,
          l.spray_fee_cents || 0, l.used_sets, l.self_sets, l.supplement_sets,
          l.pesticide_fee_cents || 0, l.included, null);
      }
    } else { // haul：单行，party 由调用方指定（计算器吊运无客户字段）
      insItem.run(sid, party_id || null, '（吊运客户）', null,
        job.income_cents || 0, null, null, null, 0, 0, job.note || null);
    }

    recomputeTotals(db, sid);
    // 重新生成结算后作业不再是 settled/reopened 中间态；等 confirm 再置 settled
    db.prepare("UPDATE jobs SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'reopened'")
      .run(now, job_id);
    logEdit(db, { table: 'settlements', recordId: sid, action: 'create',
      after: { settlement_no, job_id, job_no: job.job_no } });
    return sid;
  });
  return settlementWithDetails(db, tx());
}

/** 重算结算单合计（items 变更后调用） */
function recomputeTotals(db, sid) {
  const agg = db.prepare(
    `SELECT COALESCE(SUM(spray_fee_cents),0) AS spray, COALESCE(SUM(pesticide_fee_cents),0) AS pesticide
     FROM settlement_items WHERE settlement_id = ?`).get(sid);
  db.prepare('UPDATE settlements SET total_spray_fee_cents = ?, total_pesticide_fee_cents = ?, total_receivable_cents = ?, updated_at = ? WHERE id = ?')
    .run(agg.spray, agg.pesticide, agg.spray + agg.pesticide, nowISO(), sid);
}

/** 未确认：编辑分项金额（Excel 式）→ 合计重算 */
function updateItems(db, id, items) {
  const s = settlementWithDetails(db, id);
  if (s.status !== 'draft') {
    throw new ApiError('INVALID_STATE', `结算单 ${s.settlement_no} 状态 ${s.status} 不可编辑（先撤回确认）`);
  }
  const before = s.items.map(i => ({ id: i.id, spray: i.spray_fee_cents, pesticide: i.pesticide_fee_cents }));
  const tx = db.transaction(() => {
    const upd = db.prepare(
      `UPDATE settlement_items SET spray_fee_cents = COALESCE(?, spray_fee_cents),
         pesticide_fee_cents = COALESCE(?, pesticide_fee_cents), note = COALESCE(?, note)
       WHERE id = ? AND settlement_id = ?`);
    for (const it of items || []) {
      if (!it || typeof it.id !== 'number') throw new ApiError('VALIDATION', 'items[].id 必须是数字');
      for (const k of ['spray_fee_cents', 'pesticide_fee_cents']) {
        if (it[k] != null && (typeof it[k] !== 'number' || it[k] < 0)) {
          throw new ApiError('VALIDATION', `${k} 必须是非负整数分`);
        }
      }
      const res = upd.run(
        it.spray_fee_cents !== undefined ? it.spray_fee_cents : null,
        it.pesticide_fee_cents !== undefined ? it.pesticide_fee_cents : null,
        it.note !== undefined ? it.note : null,
        it.id, id);
      if (res.changes === 0) throw new ApiError('NOT_FOUND', `分项不存在: ${it.id}`, 404);
    }
    recomputeTotals(db, id);
    logEdit(db, { table: 'settlements', recordId: id, action: 'update', before, after: items });
  });
  tx();
  return settlementWithDetails(db, id);
}

/** 确认结算：生成 bills + 自动分录 + 作业 settled */
function confirmSettlement(db, id) {
  const s = settlementWithDetails(db, id);
  if (s.status !== 'draft') {
    throw new ApiError('INVALID_STATE', `结算单 ${s.settlement_no} 状态 ${s.status} 不可确认`);
  }
  if (!s.items.length) throw new ApiError('VALIDATION', '结算单没有分项');
  const now = nowISO();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(s.job_id);

  const tx = db.transaction(() => {
    // 1) 账单（每农户一张；零金额分项跳过）
    db.prepare("UPDATE bills SET status = 'void', updated_at = ? WHERE settlement_id = ? AND status != 'void'").run(now, id);
    const insBill = db.prepare(
      `INSERT INTO bills (bill_no, settlement_id, party_id, farmer_name, amount_cents, adjust_cents, paid_cents, status, issued_at, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 'unpaid', ?, ?, ?, ?)`);
    for (const it of s.items) {
      const amount = (it.spray_fee_cents || 0) + (it.pesticide_fee_cents || 0);
      if (amount <= 0) continue; // 零金额分项不生成账单（无意义）
      const bill_no = nextBizNo(db, 'bills', 'bill_no', 'B');
      insBill.run(bill_no, id, it.party_id, it.farmer_name, amount, now, it.note || null, now, now);
    }
    // 2) 自动分录：借 应收 / 贷 作业收入 + 药收入（逐分项挂 party_id，供按客户报表）
    const lines = [];
    for (const it of s.items) {
      if ((it.spray_fee_cents || 0) > 0) {
        lines.push({ account_code: '6001', direction: 'credit', amount_cents: it.spray_fee_cents, party_id: it.party_id, job_id: s.job_id, memo: '作业收入 ' + it.farmer_name });
      }
      if ((it.pesticide_fee_cents || 0) > 0) {
        lines.push({ account_code: '6002', direction: 'credit', amount_cents: it.pesticide_fee_cents, party_id: it.party_id, job_id: s.job_id, memo: '药收入 ' + it.farmer_name });
      }
    }
    if (s.total_receivable_cents > 0) {
      lines.push({ account_code: '1122', direction: 'debit', amount_cents: s.total_receivable_cents, job_id: s.job_id, memo: '应收 ' + s.settlement_no });
    }
    const entryId = postEntry(db, {
      event_type: 'settlement_confirm', ref_type: 'settlement', ref_id: id,
      occurred_at: now, memo: '结算确认 ' + s.settlement_no + '（作业 ' + job.job_no + '）', lines
    });
    // 3) 状态推进
    db.prepare("UPDATE settlements SET status = 'confirmed', confirmed_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
    db.prepare("UPDATE jobs SET status = 'settled', updated_at = ? WHERE id = ?").run(now, s.job_id);
    logEdit(db, { table: 'settlements', recordId: id, action: 'update',
      before: { status: 'draft' }, after: { status: 'confirmed', entry: entryId } });
  });
  tx();
  return settlementWithDetails(db, id);
}

/** 撤回确认：红冲分录 + 账单作废 + 结算回 draft + 作业 reopened */
function reopenSettlement(db, id) {
  const s = settlementWithDetails(db, id);
  if (s.status !== 'confirmed') {
    throw new ApiError('INVALID_STATE', `结算单 ${s.settlement_no} 状态 ${s.status} 无需撤回`);
  }
  const now = nowISO();
  const tx = db.transaction(() => {
    const entry = db.prepare(
      "SELECT id FROM journal_entries WHERE ref_type='settlement' AND ref_id=? AND event_type='settlement_confirm' AND status='active'").get(id);
    if (entry) reverseEntry(db, entry.id, { occurred_at: now, memo: '撤回结算 ' + s.settlement_no });
    db.prepare("UPDATE bills SET status = 'void', updated_at = ? WHERE settlement_id = ? AND status != 'void'").run(now, id);
    db.prepare("UPDATE settlements SET status = 'draft', confirmed_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
    db.prepare("UPDATE jobs SET status = 'reopened', updated_at = ? WHERE id = ?").run(now, s.job_id);
    logEdit(db, { table: 'settlements', recordId: id, action: 'reopen', before: { status: 'confirmed' }, after: { status: 'draft' } });
  });
  tx();
  return settlementWithDetails(db, id);
}

/** 作废：draft → 仅结算作废（作业回 completed）；confirmed → 红冲 + 作业 void（终态） */
function voidSettlement(db, id) {
  const s = settlementWithDetails(db, id);
  if (s.status === 'void') return s;
  if (s.status === 'confirmed') {
    const now = nowISO();
    const tx = db.transaction(() => {
      const entry = db.prepare(
        "SELECT id FROM journal_entries WHERE ref_type='settlement' AND ref_id=? AND event_type='settlement_confirm' AND status='active'").get(id);
      if (entry) reverseEntry(db, entry.id, { occurred_at: now, memo: '作废结算 ' + s.settlement_no });
      db.prepare("UPDATE bills SET status = 'void', updated_at = ? WHERE settlement_id = ? AND status != 'void'").run(now, id);
      db.prepare("UPDATE settlements SET status = 'void', updated_at = ? WHERE id = ?").run(now, id);
      db.prepare("UPDATE jobs SET status = 'void', updated_at = ? WHERE id = ?").run(now, s.job_id);
      logEdit(db, { table: 'settlements', recordId: id, action: 'void', before: { status: 'confirmed' }, after: { status: 'void' } });
    });
    tx();
  } else { // draft
    const tx = db.transaction(() => {
      db.prepare("UPDATE settlements SET status = 'void', updated_at = ? WHERE id = ?").run(nowISO(), id);
      logEdit(db, { table: 'settlements', recordId: id, action: 'void', before: { status: 'draft' }, after: { status: 'void' } });
    });
    tx();
  }
  return settlementWithDetails(db, id);
}

function listSettlements(db, { status, job_id } = {}) {
  const where = ['1=1'];
  const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (job_id) { where.push('job_id = ?'); args.push(job_id); }
  return db.prepare(
    `SELECT s.*, j.job_no, j.job_type, j.job_date,
       (SELECT COALESCE(SUM(paid_cents),0) FROM bills b WHERE b.settlement_id = s.id AND b.status != 'void') AS paid_cents
     FROM settlements s JOIN jobs j ON j.id = s.job_id
     WHERE ${where.join(' AND ')} ORDER BY s.id DESC LIMIT 500`).all(...args);
}

function listBills(db, { status, party_id } = {}) {
  const where = ["b.status != 'void'"];
  const args = [];
  if (status) { where.push('b.status = ?'); args.push(status); }
  if (party_id) { where.push('b.party_id = ?'); args.push(party_id); }
  return db.prepare(
    `SELECT b.*, p.name AS party_name,
       (b.amount_cents + b.adjust_cents) AS payable_cents
     FROM bills b LEFT JOIN parties p ON p.id = b.party_id
     WHERE ${where.join(' AND ')} ORDER BY b.id DESC LIMIT 500`).all(...args);
}

/** 未收款账单可改金额/抹零；已收款拒绝（走撤回） */
function patchBill(db, id, { amount_cents, adjust_cents, note }) {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
  if (!bill) throw new ApiError('NOT_FOUND', `账单不存在: ${id}`, 404);
  if (bill.status === 'void') throw new ApiError('INVALID_STATE', '账单已作废');
  if (bill.paid_cents > 0 || bill.status === 'paid') {
    throw new ApiError('INVALID_STATE', '账单已有收款，请先撤回对应结算再改');
  }
  if (amount_cents != null && (typeof amount_cents !== 'number' || amount_cents < 0)) {
    throw new ApiError('VALIDATION', 'amount_cents 必须是非负整数分');
  }
  if (adjust_cents != null && typeof adjust_cents !== 'number') {
    throw new ApiError('VALIDATION', 'adjust_cents 必须是整数分（抹零/优惠为负）');
  }
  const before = { amount_cents: bill.amount_cents, adjust_cents: bill.adjust_cents };
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE bills SET amount_cents = COALESCE(?, amount_cents),
         adjust_cents = COALESCE(?, adjust_cents), note = COALESCE(?, note), updated_at = ?
       WHERE id = ?`).run(
        amount_cents != null ? amount_cents : null,
        adjust_cents != null ? adjust_cents : null,
        note != null ? note : null, nowISO(), id);
    logEdit(db, { table: 'bills', recordId: id, action: 'update', before, after: { amount_cents, adjust_cents, note } });
  });
  tx();
  return db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
}

module.exports = {
  createSettlement, updateItems, confirmSettlement, reopenSettlement, voidSettlement,
  listSettlements, listBills, patchBill, settlementWithDetails, recomputeTotals
};
