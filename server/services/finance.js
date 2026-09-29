/* ============================================================
   services/finance.js — 收款/支出/预收预支/分账（M5，记账只写）
   共同规则：
     - 每笔自动分录；作废 = 反向分录 + status='void'，不删记录
     - 金额 INTEGER 分；部分收款 = 同 bill 多笔 receipts
     - 预收抵扣：receipt.from_advance_id → 扣 advance.balance + advance_usages 流水
     - 预支冲销：advance_usages.ref_type='payment'（用预支支付的支出）
   ============================================================ */
'use strict';

const { ApiError } = require('./apiError');
const { nextBizNo, logEdit } = require('./audit');
const { postEntry, reverseEntry } = require('./journal');

function nowISO() { return new Date().toISOString(); }

function getActive(db, table, id) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw new ApiError('NOT_FOUND', `${table} #${id} 不存在`, 404);
  return row;
}

/* ---------------- 收款 ---------------- */

function createReceipt(db, { bill_id, party_id, amount_cents, method, occurred_at, note, from_advance_id }) {
  if (!party_id) throw new ApiError('VALIDATION', 'party_id 必填');
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
    throw new ApiError('VALIDATION', 'amount_cents 必须是正整数分');
  }
  const bill = bill_id ? getActive(db, 'bills', bill_id) : null;
  if (bill) {
    if (bill.status === 'void') throw new ApiError('INVALID_STATE', '账单已作废，不可收款');
    const payable = bill.amount_cents + bill.adjust_cents;
    if (bill.paid_cents + amount_cents > payable) {
      throw new ApiError('VALIDATION',
        `收款 ${amount_cents} 超过未收余额 ${payable - bill.paid_cents} 分`);
    }
  }
  const advance = from_advance_id ? getActive(db, 'advances', from_advance_id) : null;
  if (advance) {
    if (advance.direction !== 'prepaid_by_customer') {
      throw new ApiError('VALIDATION', '抵扣只能用「客户预收」，员工预支走冲销');
    }
    if (advance.status === 'void') throw new ApiError('INVALID_STATE', '预收已作废');
    if (advance.balance_cents < amount_cents) {
      throw new ApiError('VALIDATION', `预收余额 ${advance.balance_cents} 分不足抵扣 ${amount_cents} 分`);
    }
  }
  const now = nowISO();
  const tx = db.transaction(() => {
    const receipt_no = nextBizNo(db, 'receipts', 'receipt_no', 'R');
    const info = db.prepare(
      `INSERT INTO receipts (receipt_no, bill_id, party_id, from_advance_id, amount_cents, method, occurred_at, note, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
      .run(receipt_no, bill_id || null, party_id, from_advance_id || null, amount_cents,
        method || 'cash', occurred_at || now, note || null, now, now);
    const rid = info.lastInsertRowid;

    // 账单回写：paid_cents / status
    if (bill) {
      const paid = bill.paid_cents + amount_cents;
      const payable = bill.amount_cents + bill.adjust_cents;
      const status = paid >= payable ? 'paid' : 'partial';
      db.prepare('UPDATE bills SET paid_cents = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(paid, status, now, bill.id);
    }
    // 预收抵扣：扣余额 + 流水
    if (advance) {
      const balance = advance.balance_cents - amount_cents;
      db.prepare('UPDATE advances SET balance_cents = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(balance, balance <= 0 ? 'closed' : 'partial', now, advance.id);
      db.prepare(
        `INSERT INTO advance_usages (advance_id, amount_cents, ref_type, ref_id, occurred_at, note, status, created_at)
         VALUES (?, ?, 'receipt', ?, ?, ?, 'active', ?)`)
        .run(advance.id, amount_cents, rid, occurred_at || now, '预收抵扣 ' + receipt_no, now);
    }
    // 分录：钱进来（现金/微信等）借，应收贷；纯预收抵扣（无现金流）→ 借 1123 预收
    const cashCode = method === 'wechat' ? '1002' : method === 'alipay' ? '1003' : method === 'bank' ? '1004' : '1001';
    const lines = [];
    if (advance) {
      lines.push({ account_code: '1123', direction: 'debit', amount_cents, party_id, memo: '预收抵扣 ' + receipt_no });
    } else {
      lines.push({ account_code: cashCode, direction: 'debit', amount_cents, party_id, memo: '收款 ' + receipt_no });
    }
    if (bill) {
      lines.push({ account_code: '1122', direction: 'credit', amount_cents, party_id, memo: '核销应收 ' + bill.bill_no });
    } else {
      // 无账单收款 = 新增客户预收（直接进预收账款贷方）
      lines.push({ account_code: '1123', direction: 'credit', amount_cents, party_id, memo: '预收款 ' + receipt_no });
    }
    postEntry(db, {
      event_type: 'receipt', ref_type: 'receipt', ref_id: rid,
      occurred_at: occurred_at || now, memo: '收款 ' + receipt_no, lines
    });
    logEdit(db, { table: 'receipts', recordId: rid, action: 'create', after: { receipt_no, bill_id, amount_cents, from_advance_id } });
    return rid;
  });
  return getActive(db, 'receipts', tx());
}

/* ---------------- 支出 ---------------- */

const PAYMENT_CATEGORIES = ['fuel', 'chemical', 'repair', 'meal', 'equipment', 'labor', 'other'];
const CATEGORY_ACCOUNT = {
  fuel: '5002', chemical: '5001', repair: '5003', meal: '5004',
  equipment: '5005', labor: '5006', other: '5005'
};

function createPayment(db, { category, payee_party_id, job_id, amount_cents, occurred_at, note, method, from_advance_id }) {
  if (!PAYMENT_CATEGORIES.includes(category)) {
    throw new ApiError('VALIDATION', `category 必须是 ${PAYMENT_CATEGORIES.join('/')}`);
  }
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
    throw new ApiError('VALIDATION', 'amount_cents 必须是正整数分');
  }
  const advance = from_advance_id ? getActive(db, 'advances', from_advance_id) : null;
  if (advance) {
    if (advance.direction !== 'advance_to_worker') {
      throw new ApiError('VALIDATION', '从预支付款只适用于「员工预支」');
    }
    if (advance.balance_cents < amount_cents) {
      throw new ApiError('VALIDATION', `预支余额 ${advance.balance_cents} 分不足`);
    }
  }
  const now = nowISO();
  const tx = db.transaction(() => {
    const payment_no = nextBizNo(db, 'payments', 'payment_no', 'P');
    const info = db.prepare(
      `INSERT INTO payments (payment_no, category, payee_party_id, job_id, amount_cents, occurred_at, note, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
      .run(payment_no, category, payee_party_id || null, job_id || null, amount_cents,
        occurred_at || now, note || null, now, now);
    const pid = info.lastInsertRowid;
    // 贷方：有预支 → 冲减其他应收 1221（不动现金）；否则现金/微信等
    let creditCode;
    if (advance) {
      creditCode = '1221';
      const balance = advance.balance_cents - amount_cents;
      db.prepare('UPDATE advances SET balance_cents = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(balance, balance <= 0 ? 'closed' : 'partial', now, advance.id);
      db.prepare(
        `INSERT INTO advance_usages (advance_id, amount_cents, ref_type, ref_id, occurred_at, note, status, created_at)
         VALUES (?, ?, 'payment', ?, ?, ?, 'active', ?)`)
        .run(advance.id, amount_cents, pid, occurred_at || now, '预支付款 ' + payment_no, now);
    } else {
      creditCode = method === 'wechat' ? '1002' : method === 'alipay' ? '1003' : method === 'bank' ? '1004' : '1001';
    }
    postEntry(db, {
      event_type: 'payment', ref_type: 'payment', ref_id: pid,
      occurred_at: occurred_at || now, memo: '支出 ' + payment_no + '（' + category + '）',
      lines: [
        { account_code: CATEGORY_ACCOUNT[category], direction: 'debit', amount_cents, party_id: payee_party_id, job_id, memo: note },
        { account_code: creditCode, direction: 'credit', amount_cents, party_id: payee_party_id, job_id, memo: advance ? '预支付款' : '付款' }
      ]
    });
    logEdit(db, { table: 'payments', recordId: pid, action: 'create', after: { payment_no, category, amount_cents, from_advance_id } });
    return pid;
  });
  return getActive(db, 'payments', tx());
}

/* ---------------- 预收/预支 ---------------- */

function createAdvance(db, { party_id, direction, amount_cents, occurred_at, note }) {
  if (!party_id) throw new ApiError('VALIDATION', 'party_id 必填');
  if (!['prepaid_by_customer', 'advance_to_worker'].includes(direction)) {
    throw new ApiError('VALIDATION', 'direction 必须是 prepaid_by_customer / advance_to_worker');
  }
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
    throw new ApiError('VALIDATION', 'amount_cents 必须是正整数分');
  }
  const now = nowISO();
  const tx = db.transaction(() => {
    const advance_no = nextBizNo(db, 'advances', 'advance_no', 'A');
    const info = db.prepare(
      `INSERT INTO advances (advance_no, party_id, direction, amount_cents, balance_cents, occurred_at, note, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
      .run(advance_no, party_id, direction, amount_cents, amount_cents, occurred_at || now, note || null, now, now);
    const aid = info.lastInsertRowid;
    const lines = direction === 'prepaid_by_customer'
      ? [
          { account_code: '1001', direction: 'debit', amount_cents, party_id, memo: '收客户预收 ' + advance_no },
          { account_code: '1123', direction: 'credit', amount_cents, party_id, memo: '预收账款' }
        ]
      : [
          { account_code: '1221', direction: 'debit', amount_cents, party_id, memo: '员工预支 ' + advance_no },
          { account_code: '1001', direction: 'credit', amount_cents, party_id, memo: '付预支款' }
        ];
    postEntry(db, {
      event_type: 'advance', ref_type: 'advance', ref_id: aid,
      occurred_at: occurred_at || now, memo: (direction === 'prepaid_by_customer' ? '预收 ' : '预支 ') + advance_no, lines
    });
    logEdit(db, { table: 'advances', recordId: aid, action: 'create', after: { advance_no, direction, amount_cents } });
    return aid;
  });
  return getActive(db, 'advances', tx());
}

/** 预支冲销：员工报销/还款 → 冲减其他应收（ref 指向 payment 或手工） */
function settleAdvance(db, advance_id, { amount_cents, ref_type, ref_id, occurred_at, note }) {
  const adv = getActive(db, 'advances', advance_id);
  if (adv.direction !== 'advance_to_worker') {
    throw new ApiError('VALIDATION', '冲销用于「员工预支」；客户预收走收款抵扣');
  }
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
    throw new ApiError('VALIDATION', 'amount_cents 必须是正整数分');
  }
  if (adv.balance_cents < amount_cents) {
    throw new ApiError('VALIDATION', `预支余额 ${adv.balance_cents} 分不足冲销 ${amount_cents} 分`);
  }
  if (!['payment', 'manual'].includes(ref_type)) {
    throw new ApiError('VALIDATION', 'ref_type 必须是 payment / manual');
  }
  const now = nowISO();
  const tx = db.transaction(() => {
    const balance = adv.balance_cents - amount_cents;
    db.prepare('UPDATE advances SET balance_cents = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(balance, balance <= 0 ? 'closed' : 'partial', now, adv.id);
    db.prepare(
      `INSERT INTO advance_usages (advance_id, amount_cents, ref_type, ref_id, occurred_at, note, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`)
      .run(adv.id, amount_cents, ref_type, ref_id || 0, occurred_at || now, note || '预支冲销', now);
    // 分录：贷 其他应收（应收减少），借 现金（还款）或 费用（报销视为已有支出分录外的处理——
    // 若 ref=payment，支出分录已记费用贷现金；此处冲销仅转移应收，借方为费用科目由调用场景决定。
    // P0 简化：还款冲销 借现金；报销冲销 借费用由 ref payment 的金额另一笔处理，这里统一借现金/费用由 note 区分）
    postEntry(db, {
      event_type: 'advance_settle', ref_type: 'advance', ref_id: adv.id,
      occurred_at: occurred_at || now, memo: '预支冲销 ' + adv.advance_no + '：' + (note || ''),
      lines: [
        { account_code: '1001', direction: 'debit', amount_cents, party_id: adv.party_id, memo: note || '冲销回款' },
        { account_code: '1221', direction: 'credit', amount_cents, party_id: adv.party_id, memo: '其他应收减少' }
      ]
    });
    logEdit(db, { table: 'advances', recordId: adv.id, action: 'update',
      before: { balance: adv.balance_cents }, after: { balance } });
  });
  tx();
  return getActive(db, 'advances', advance_id);
}

/* ---------------- 手工分成 ---------------- */

function createSplit(db, { party_id, job_id, amount_cents, occurred_at, note }) {
  if (!party_id) throw new ApiError('VALIDATION', 'party_id 必填');
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
    throw new ApiError('VALIDATION', 'amount_cents 必须是正整数分');
  }
  const now = nowISO();
  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO manual_splits (party_id, job_id, amount_cents, occurred_at, note, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`)
      .run(party_id, job_id || null, amount_cents, occurred_at || now, note || null, now);
    const sid = info.lastInsertRowid;
    postEntry(db, {
      event_type: 'manual_split', ref_type: 'manual_split', ref_id: sid,
      occurred_at: occurred_at || now, memo: '手工分成：' + (note || ''),
      lines: [
        { account_code: '5007', direction: 'debit', amount_cents, party_id, memo: note || '分成' },
        { account_code: '1001', direction: 'credit', amount_cents, party_id, memo: '分成付出' }
      ]
    });
    logEdit(db, { table: 'manual_splits', recordId: sid, action: 'create', after: { party_id, job_id, amount_cents } });
    return sid;
  });
  return getActive(db, 'manual_splits', tx());
}

/* ---------------- 作废（不删记录，反向分录） ---------------- */

function voidFinanceRecord(db, table, id) {
  const ALLOWED = { receipts: 'receipt_no', payments: 'payment_no', advances: 'advance_no' };
  const noCol = ALLOWED[table];
  if (!noCol) throw new ApiError('VALIDATION', `不支持作废: ${table}`);
  const row = getActive(db, table, id);
  if (row.status === 'void') return row;
  const now = nowISO();
  const tx = db.transaction(() => {
    // 1) 红冲原分录
    const entry = db.prepare(
      `SELECT id FROM journal_entries WHERE ref_type = ? AND ref_id = ? AND status = 'active' AND event_type != 'reversal'`)
      .get(table.replace(/s$/, ''), id);
    if (entry) reverseEntry(db, entry.id, { occurred_at: now, memo: '作废 ' + row[noCol] });
    // 2) 回滚业务副作用
    if (table === 'receipts' && row.bill_id) {
      const bill = getActive(db, 'bills', row.bill_id);
      const paid = bill.paid_cents - row.amount_cents;
      const payable = bill.amount_cents + bill.adjust_cents;
      db.prepare('UPDATE bills SET paid_cents = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(paid, paid <= 0 ? 'unpaid' : 'partial', now, bill.id);
    }
    if (table === 'advances') {
      const used = db.prepare(
        "SELECT COALESCE(SUM(amount_cents),0) AS n FROM advance_usages WHERE advance_id = ? AND status = 'active'").get(id).n;
      if (used > 0) throw new ApiError('INVALID_STATE', '预收/预支已有抵扣或冲销流水，请先作废对应流水');
    }
    db.prepare(`UPDATE ${table} SET status = 'void', updated_at = ? WHERE id = ?`).run(now, id);
    logEdit(db, { table, recordId: id, action: 'void', before: { status: row.status }, after: { status: 'void' } });
  });
  tx();
  return getActive(db, table, id);
}

/* ---------------- 查询 ---------------- */

function listReceipts(db) {
  return db.prepare(
    `SELECT r.*, b.bill_no, p.name AS party_name FROM receipts r
     LEFT JOIN bills b ON b.id = r.bill_id LEFT JOIN parties p ON p.id = r.party_id
     ORDER BY r.id DESC LIMIT 500`).all();
}
function listPayments(db) {
  return db.prepare(
    `SELECT p.*, pa.name AS payee_name, j.job_no FROM payments p
     LEFT JOIN parties pa ON pa.id = p.payee_party_id LEFT JOIN jobs j ON j.id = p.job_id
     ORDER BY p.id DESC LIMIT 500`).all();
}
function listAdvances(db) {
  return db.prepare(
    `SELECT a.*, p.name AS party_name FROM advances a
     LEFT JOIN parties p ON p.id = a.party_id ORDER BY a.id DESC LIMIT 500`).all();
}
function listSplits(db) {
  return db.prepare(
    `SELECT s.*, p.name AS party_name, j.job_no FROM manual_splits s
     LEFT JOIN parties p ON p.id = s.party_id LEFT JOIN jobs j ON j.id = s.job_id
     ORDER BY s.id DESC LIMIT 500`).all();
}

module.exports = {
  createReceipt, createPayment, createAdvance, settleAdvance, createSplit,
  voidFinanceRecord, listReceipts, listPayments, listAdvances, listSplits,
  PAYMENT_CATEGORIES
};
