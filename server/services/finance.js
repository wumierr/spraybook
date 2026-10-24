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
const { postEntry, reverseEntry, findActiveEntry } = require('./journal');

function nowISO() { return new Date().toISOString(); }

function getActive(db, table, id) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw new ApiError('NOT_FOUND', `${table} #${id} 不存在`, 404);
  return row;
}

/* ---------------- 收款 ---------------- */

/**
 * 收款（M6 双模式；C3 起核销明细落 receipt_allocations 结构化表）：
 *  - 挂单笔：bill_id 给定 → 核销该账单（兼容 P0），可带 from_advance_id 预收抵扣
 *  - 按客户：bill_id 空、party_id 给定 → 对该客户全部未清账单按最早顺序 FIFO
 *    自动核销（明细写 receipt_allocations；C3 混合核销：allocations 参数=显式
 *    预分配数组 [{bill_id, amount_cents}]（如前端弹层可改的 FIFO 预案），校验
 *    Σ=amount、账单属该客户、单张不超未收），剩余金额自动生成客户预收 advance
 */
function createReceipt(db, { bill_id, party_id, amount_cents, method, occurred_at, note, from_advance_id, collector_name, allocations: manualAllocs }) {
  if (!party_id) throw new ApiError('VALIDATION', 'party_id 必填');
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
    throw new ApiError('VALIDATION', 'amount_cents 必须是正整数分');
  }
  const bill = bill_id ? getActive(db, 'bills', bill_id) : null;
  if (bill) {
    if (bill.status === 'void') throw new ApiError('INVALID_STATE', '账单已作废，不可收款');
    if (bill.party_id && party_id !== bill.party_id) {
      throw new ApiError('VALIDATION', 'party_id 与账单客户不一致');
    }
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
    if (!bill) throw new ApiError('VALIDATION', '预收抵扣必须指定 bill_id（按客户收款走现金模式）');
  }

  const now = nowISO();
  const tx = db.transaction(() => {
    const receipt_no = nextBizNo(db, 'receipts', 'receipt_no', 'R');
    const cashCode = method === 'wechat' ? '1002' : method === 'alipay' ? '1003' : method === 'bank' ? '1004' : '1001';
    const journalLines = [];
    let allocations = null;
    let remainderAdvanceId = null;

    if (bill) {
      // ---- 模式1：挂单笔 ----
      const paid = bill.paid_cents + amount_cents;
      const payable = bill.amount_cents + bill.adjust_cents;
      db.prepare('UPDATE bills SET paid_cents = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(paid, paid >= payable ? 'paid' : 'partial', now, bill.id);
      if (advance) {
        const balance = advance.balance_cents - amount_cents;
        db.prepare('UPDATE advances SET balance_cents = ?, status = ?, updated_at = ? WHERE id = ?')
          .run(balance, balance <= 0 ? 'closed' : 'partial', now, advance.id);
        db.prepare(
          `INSERT INTO advance_usages (advance_id, amount_cents, ref_type, ref_id, occurred_at, note, status, created_at)
           VALUES (?, ?, 'receipt', ?, ?, ?, 'active', ?)`)
          .run(advance.id, amount_cents, receipt_no, occurred_at || now, '预收抵扣 ' + receipt_no, now);
        journalLines.push({ account_code: '1123', direction: 'debit', amount_cents, party_id, memo: '预收抵扣 ' + receipt_no });
      } else {
        journalLines.push({ account_code: cashCode, direction: 'debit', amount_cents, party_id, memo: '收款 ' + receipt_no });
      }
      journalLines.push({ account_code: '1122', direction: 'credit', amount_cents, party_id, memo: '核销应收 ' + bill.bill_no });
    } else {
      // ---- 模式2：按客户核销未清账单（C3 混合核销：显式 allocations 可改 FIFO 预案），余额转预收 ----
      const openBills = db.prepare(
        `SELECT * FROM bills WHERE party_id = ? AND status IN ('unpaid','partial') ORDER BY id`).all(party_id);
      const unpaidOf = b => (b.amount_cents + b.adjust_cents) - b.paid_cents;
      // 分配方案：显式 allocations（校验）缺省 FIFO 贪心
      let plan;
      if (Array.isArray(manualAllocs) && manualAllocs.length) {
        plan = [];
        let sum = 0;
        const byId = new Map(openBills.map(b => [b.id, b]));
        for (const a of manualAllocs) {
          const bid = Number(a && a.bill_id);
          const amt = Number(a && a.amount_cents);
          const b = byId.get(bid);
          if (!b) throw new ApiError('VALIDATION', `混合核销账单 #${bid} 不存在或不属于该客户/已非未清`);
          if (!Number.isInteger(amt) || amt <= 0) throw new ApiError('VALIDATION', '混合核销金额必须是正整数分');
          const dup = plan.find(p => p.bill_id === bid);
          if (dup) throw new ApiError('VALIDATION', `账单 #${bid} 重复分配`);
          if (amt > unpaidOf(b)) throw new ApiError('VALIDATION', `账单 #${bid} 分配 ${amt} 分超过未收 ${unpaidOf(b)} 分`);
          plan.push({ bill_id: bid, amount_cents: amt });
          sum += amt;
        }
        if (sum > amount_cents) {
          throw new ApiError('VALIDATION', `混合核销合计 ${sum} 分超过收款 ${amount_cents} 分`);
        }
      } else {
        plan = [];
        let remaining = amount_cents;
        for (const b of openBills) {
          if (remaining <= 0) break;
          const unpaid = unpaidOf(b);
          if (unpaid <= 0) continue;
          const use = Math.min(unpaid, remaining);
          remaining -= use;
          plan.push({ bill_id: b.id, amount_cents: use });
        }
      }
      allocations = plan;
      let remaining = amount_cents - plan.reduce((a, p) => a + p.amount_cents, 0);
      for (const p of plan) {
        const b = openBills.find(x => x.id === p.bill_id);
        const paid = b.paid_cents + p.amount_cents;
        db.prepare('UPDATE bills SET paid_cents = ?, status = ?, updated_at = ? WHERE id = ?')
          .run(paid, paid >= b.amount_cents + b.adjust_cents ? 'paid' : 'partial', now, b.id);
        journalLines.push({ account_code: '1122', direction: 'credit', amount_cents: p.amount_cents, party_id, memo: '核销应收 ' + b.bill_no });
      }
      journalLines.push({ account_code: cashCode, direction: 'debit', amount_cents, party_id, memo: '收款 ' + receipt_no });
      if (remaining > 0) {
        const advance_no = nextBizNo(db, 'advances', 'advance_no', 'A');
        const info = db.prepare(
          `INSERT INTO advances (advance_no, party_id, direction, amount_cents, balance_cents, occurred_at, note, status, opening, created_at, updated_at)
           VALUES (?, ?, 'prepaid_by_customer', ?, ?, ?, ?, 'open', 0, ?, ?)`)
          .run(advance_no, party_id, remaining, remaining, occurred_at || now, '收款余额转预收 ' + receipt_no, now, now);
        remainderAdvanceId = info.lastInsertRowid;
        journalLines.push({ account_code: '1123', direction: 'credit', amount_cents: remaining, party_id, memo: '余额转预收 ' + advance_no });
      }
    }

    // C3：核销明细落结构化表（receipts.allocations JSON 退役，历史行保留不写）
    const info = db.prepare(
      `INSERT INTO receipts (receipt_no, bill_id, party_id, from_advance_id, amount_cents, method, occurred_at, note, status, allocations, remainder_advance_id, collector_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?)`)
      .run(receipt_no, bill ? bill.id : null, party_id, from_advance_id || null, amount_cents,
        method || 'cash', occurred_at || now, note || null,
        remainderAdvanceId || null, collector_name || null, now, now);
    const rid = info.lastInsertRowid;
    // 结构化核销明细（挂单笔=单行，按客户=分配方案逐行）
    if (bill) {
      db.prepare(
        `INSERT INTO receipt_allocations (receipt_id, bill_id, amount_cents, created_at) VALUES (?, ?, ?, ?)`)
        .run(rid, bill.id, amount_cents, now);
    } else {
      const insAlloc = db.prepare(
        `INSERT INTO receipt_allocations (receipt_id, bill_id, amount_cents, created_at) VALUES (?, ?, ?, ?)`);
      for (const p of allocations || []) insAlloc.run(rid, p.bill_id, p.amount_cents, now);
    }

    postEntry(db, {
      event_type: 'receipt', ref_type: 'receipt', ref_id: rid,
      occurred_at: occurred_at || now, memo: '收款 ' + receipt_no, lines: journalLines
    });
    logEdit(db, { table: 'receipts', recordId: rid, action: 'create',
      after: { receipt_no, bill_id: bill ? bill.id : null, amount_cents, from_advance_id, allocations, remainderAdvanceId } });
    return rid;
  });
  return getActive(db, 'receipts', tx());
}

/** 编辑收款（P2-3）：红冲原分录 + 更新 + 新分录；按客户核销/预收抵扣不支持编辑，走作废重录 */
function updateReceipt(db, id, { amount_cents, method, occurred_at, note, collector_name }) {
  const r = getActive(db, 'receipts', id);
  if (r.status === 'void') throw new ApiError('INVALID_STATE', '已作废收款不可编辑');
  // C3：按客户核销（无 bill_id 且有结构化/JSON 核销行）不支持编辑，走作废重录
  const allocCount = db.prepare('SELECT COUNT(*) AS c FROM receipt_allocations WHERE receipt_id = ?').get(id).c;
  if (!r.bill_id && (allocCount > 0 || r.allocations)) {
    throw new ApiError('INVALID_STATE', '按客户核销的收款不支持编辑，请作废后重录');
  }
  if (r.from_advance_id) throw new ApiError('INVALID_STATE', '预收抵扣收款不支持编辑，请作废后重录');
  const bill = r.bill_id ? getActive(db, 'bills', r.bill_id) : null;
  const newAmount = amount_cents != null ? amount_cents : r.amount_cents;
  if (!Number.isInteger(newAmount) || newAmount <= 0) throw new ApiError('VALIDATION', 'amount_cents 必须是正整数分');
  // A0-B-M4：编辑路径同 createReceipt 的超收校验——改后总额不得超账单应付
  if (bill) {
    const payable = bill.amount_cents + bill.adjust_cents;
    const paidAfter = bill.paid_cents - r.amount_cents + newAmount;
    if (paidAfter > payable) {
      throw new ApiError('VALIDATION', `修改后收款合计 ${paidAfter} 分超过账单应付 ${payable} 分`);
    }
  }
  const newMethod = method || r.method;
  const newOccurred = occurred_at || r.occurred_at;
  // P6-M2(F5)：金额/方式/日期任一变化才需要红冲重过账；只改备注/经手人走短路，不产生冗余凭证
  const journalAffecting = (amount_cents != null && amount_cents !== r.amount_cents) ||
    (method != null && method !== r.method) ||
    (occurred_at != null && occurred_at !== r.occurred_at);
  const now = nowISO();
  const tx = db.transaction(() => {
    if (!journalAffecting) {
      db.prepare(
        `UPDATE receipts SET note=COALESCE(?, note), collector_name=COALESCE(?, collector_name), updated_at=? WHERE id=?`)
        .run(note ?? null, collector_name ?? null, now, id);
      logEdit(db, { table: 'receipts', recordId: id, action: 'update',
        before: { note: r.note, collector_name: r.collector_name },
        after: { note: note ?? r.note, collector_name: collector_name ?? r.collector_name } });
      return;
    }
    // 红冲目标 = 未被红冲的最新 active 分录（编辑过多次后不得再红冲最初分录）
    const entry = findActiveEntry(db, 'receipt', id, { eventType: 'receipt' });
    if (entry) reverseEntry(db, entry.id, { occurred_at: now, memo: '编辑收款 ' + r.receipt_no });
    const cashCode = newMethod === 'wechat' ? '1002' : newMethod === 'alipay' ? '1003' : newMethod === 'bank' ? '1004' : '1001';
    db.prepare(
      `UPDATE receipts SET amount_cents=?, method=?, occurred_at=?, note=COALESCE(?, note), collector_name=COALESCE(?, collector_name), updated_at=? WHERE id=?`)
      .run(newAmount, newMethod, newOccurred, note ?? null, collector_name ?? null, now, id);
    if (bill) {
      const paid = bill.paid_cents - r.amount_cents + newAmount;
      const payable = bill.amount_cents + bill.adjust_cents;
      db.prepare('UPDATE bills SET paid_cents = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(paid, paid >= payable ? 'paid' : 'partial', now, bill.id);
      // C3：挂单笔的结构化核销行随编辑金额同步（审计一致；作废回退走单笔分支不依赖它）
      if (journalAffecting && amount_cents != null && amount_cents !== r.amount_cents) {
        db.prepare('UPDATE receipt_allocations SET amount_cents = ? WHERE receipt_id = ?')
          .run(newAmount, id);
      }
      postEntry(db, {
        event_type: 'receipt', ref_type: 'receipt', ref_id: id,
        occurred_at: newOccurred, memo: '收款(改) ' + r.receipt_no,
        lines: [
          { account_code: cashCode, direction: 'debit', amount_cents: newAmount, party_id: r.party_id, memo: '收款' },
          { account_code: '1122', direction: 'credit', amount_cents: newAmount, party_id: r.party_id, memo: '核销 ' + bill.bill_no }
        ]
      });
    } else {
      postEntry(db, {
        event_type: 'receipt', ref_type: 'receipt', ref_id: id,
        occurred_at: newOccurred, memo: '收款(改) ' + r.receipt_no,
        lines: [
          { account_code: cashCode, direction: 'debit', amount_cents: newAmount, party_id: r.party_id, memo: '收款' },
          { account_code: '1123', direction: 'credit', amount_cents: newAmount, party_id: r.party_id, memo: '预收款' }
        ]
      });
    }
    logEdit(db, { table: 'receipts', recordId: id, action: 'update',
      before: { amount_cents: r.amount_cents, method: r.method }, after: { amount_cents: newAmount, method: newMethod } });
  });
  tx();
  return getActive(db, 'receipts', id);
}

/** 编辑支出（P2-3）：红冲原分录 + 更新 + 新分录 */
function updatePayment(db, id, { category, amount_cents, occurred_at, note, method, payee_party_id }) {
  const p = getActive(db, 'payments', id);
  if (p.status === 'void') throw new ApiError('INVALID_STATE', '已作废支出不可编辑');
  const newAmount = amount_cents != null ? amount_cents : p.amount_cents;
  if (!Number.isInteger(newAmount) || newAmount <= 0) throw new ApiError('VALIDATION', 'amount_cents 必须是正整数分');
  const newCategory = category || p.category;
  if (!PAYMENT_CATEGORIES.includes(newCategory)) throw new ApiError('VALIDATION', 'category 非法');
  // P6-M2(F5)：金额/类别/日期任一变化才红冲重过账；只改备注/收款方走短路
  const journalAffecting = (amount_cents != null && amount_cents !== p.amount_cents) ||
    (category != null && category !== p.category) ||
    (occurred_at != null && occurred_at !== p.occurred_at);
  const now = nowISO();
  const tx = db.transaction(() => {
    if (!journalAffecting) {
      db.prepare(
        `UPDATE payments SET note=COALESCE(?, note), payee_party_id=COALESCE(?, payee_party_id), updated_at=? WHERE id=?`)
        .run(note ?? null, payee_party_id ?? null, now, id);
      logEdit(db, { table: 'payments', recordId: id, action: 'update',
        before: { note: p.note, payee_party_id: p.payee_party_id },
        after: { note: note ?? p.note, payee_party_id: payee_party_id ?? p.payee_party_id } });
      return;
    }
    // 红冲目标 = 未被红冲的最新 active 分录（编辑过多次后不得再红冲最初分录）
    const entry = findActiveEntry(db, 'payment', id, { eventType: 'payment' });
    // payments 表无 method 列：重过账前从原 active 分录的贷方行回读付款方式科目，
    // 否则 method 未传时硬编码回退现金，微信/支付宝/预支付款付款会被改记成现金
    let prevCreditCode = null;
    if (entry) {
      const cl = db.prepare(
        `SELECT a.code AS code FROM journal_lines l JOIN accounts a ON a.id = l.account_id
         WHERE l.entry_id = ? AND l.direction = 'credit' ORDER BY l.id LIMIT 1`).get(entry.id);
      prevCreditCode = cl ? cl.code : null;
    }
    if (entry) reverseEntry(db, entry.id, { occurred_at: now, memo: '编辑支出 ' + p.payment_no });
    const METHOD_CODE = { cash: '1001', wechat: '1002', alipay: '1003', bank: '1004' };
    const methodCode = method ? (METHOD_CODE[method] || '1001') : null;
    const cashCode = methodCode || prevCreditCode || '1001';
    db.prepare(
      `UPDATE payments SET category=?, amount_cents=?, occurred_at=?, note=COALESCE(?, note), payee_party_id=COALESCE(?, payee_party_id), updated_at=? WHERE id=?`)
      .run(newCategory, newAmount, occurred_at || p.occurred_at, note ?? null, payee_party_id ?? null, now, id);
    postEntry(db, {
      event_type: 'payment', ref_type: 'payment', ref_id: id,
      occurred_at: occurred_at || p.occurred_at, memo: '支出(改) ' + p.payment_no,
      lines: [
        { account_code: CATEGORY_ACCOUNT[newCategory], direction: 'debit', amount_cents: newAmount, party_id: p.payee_party_id, job_id: p.job_id, memo: note || p.note },
        { account_code: cashCode, direction: 'credit', amount_cents: newAmount, party_id: p.payee_party_id, memo: cashCode === '1221' ? '预支付款' : '付款' }
      ]
    });
    logEdit(db, { table: 'payments', recordId: id, action: 'update',
      before: { amount_cents: p.amount_cents, category: p.category }, after: { amount_cents: newAmount, category: newCategory } });
  });
  tx();
  return getActive(db, 'payments', id);
}

/** 编辑预收/预支备注（P2-3，金额变动走冲销/作废） */
function updateAdvanceNote(db, id, { note }) {
  const a = getActive(db, 'advances', id);
  const now = nowISO();
  const tx = db.transaction(() => {
    db.prepare('UPDATE advances SET note = ?, updated_at = ? WHERE id = ?').run(note ?? null, now, id);
    logEdit(db, { table: 'advances', recordId: id, action: 'update', before: { note: a.note }, after: { note: note ?? null } });
  });
  tx();
  return getActive(db, 'advances', id);
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
    if (advance.status === 'void') throw new ApiError('INVALID_STATE', '预支已作废，不可再使用');
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
  if (adv.status === 'void') throw new ApiError('INVALID_STATE', '预支已作废，不可再冲销');
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
  // B0.3/N-3：splits（manual_splits）补作废——URL 段与表名/refType 不同，显式映射；
  // 照 advances 模式红冲（分成=红冲 5007/1001）；表无业务单号列，memo 用 #id 标识；
  // 迁移 015 已补 updated_at
  const ALLOWED = {
    receipts: { tbl: 'receipts',      noCol: 'receipt_no', refType: 'receipt' },
    payments: { tbl: 'payments',      noCol: 'payment_no', refType: 'payment' },
    advances: { tbl: 'advances',      noCol: 'advance_no', refType: 'advance' },
    splits:   { tbl: 'manual_splits', noCol: null,         refType: 'manual_split' }
  };
  const spec = ALLOWED[table];
  if (!spec) throw new ApiError('VALIDATION', `不支持作废: ${table}`);
  const row = getActive(db, spec.tbl, id);
  if (row.status === 'void') return row;
  const noText = spec.noCol ? row[spec.noCol] : `${table}#${id}`;
  const now = nowISO();
  const tx = db.transaction(() => {
    // 1) 红冲原分录（目标 = 未被红冲的最新 active 分录，编辑过的单据不得重复红冲最初分录）
    const entry = findActiveEntry(db, spec.refType, id, { notEventType: 'reversal' });
    if (entry) reverseEntry(db, entry.id, { occurred_at: now, memo: '作废 ' + noText });
    // 2) 回滚业务副作用
    if (table === 'receipts') {
      // C3：按客户核销读结构化表；挂单笔（bill_id 非空）走单笔分支——按 row.amount_cents
      // 现值回退（编辑过的挂单收款金额以行现值为准，结构化明细行由 updateReceipt 同步维护）
      let items = row.bill_id ? [] : db.prepare(
        'SELECT bill_id, amount_cents FROM receipt_allocations WHERE receipt_id = ?').all(id);
      let restId = row.remainder_advance_id != null ? row.remainder_advance_id : null;
      if (!items.length && row.allocations) {
        let legacy = null;
        try { legacy = JSON.parse(row.allocations); } catch (e) { legacy = null; }
        items = (legacy && (Array.isArray(legacy) ? legacy : legacy.items)) || [];
        if (!restId && legacy && legacy.remainder_advance_id) restId = legacy.remainder_advance_id;
      }
      if (items.length) {
        for (const a of items) {
          const bill = getActive(db, 'bills', a.bill_id);
          const paid = bill.paid_cents - a.amount_cents;
          db.prepare('UPDATE bills SET paid_cents = ?, status = ?, updated_at = ? WHERE id = ?')
            .run(paid, paid <= 0 ? 'unpaid' : 'partial', now, bill.id);
        }
        // 结构化明细行随作废标记（保留审计：行不删，status 无列——以 receipts.status=void 为准，
        // 回滚只依赖 bills.paid_cents 重算，重复作废被开头 row.status==='void' 短路）
        if (restId) {
          const rest = db.prepare('SELECT * FROM advances WHERE id = ?').get(restId);
          if (rest && rest.status !== 'void') {
            // B0-N-2：余额预收已被抵扣使用 → 作废原收款会红冲 1122 而预收余额
            // 仍在（C6 永久分叉，实证差 20 元）——顺序约束显式化：先作废抵扣收款
            const restUsed = db.prepare(
              "SELECT COUNT(*) AS c FROM advance_usages WHERE advance_id = ? AND status = 'active'").get(restId).c;
            if (restUsed > 0 || rest.balance_cents !== rest.amount_cents) {
              throw new ApiError('INVALID_STATE',
                `本收款余额转的预收 ${rest.advance_no} 已被抵扣使用，请先作废该预收的抵扣收款，再作废本收款（否则账簿与预收余额永久分叉）`);
            }
            // 未被使用 → 联动作废（收款分录红冲时 1123 同步消失，账实一致）
            db.prepare("UPDATE advances SET status = 'void', balance_cents = 0, updated_at = ? WHERE id = ?").run(now, restId);
          }
        }
      } else if (row.bill_id) {
        const bill = getActive(db, 'bills', row.bill_id);
        const paid = bill.paid_cents - row.amount_cents;
        const payable = bill.amount_cents + bill.adjust_cents;
        db.prepare('UPDATE bills SET paid_cents = ?, status = ?, updated_at = ? WHERE id = ?')
          .run(paid, paid <= 0 ? 'unpaid' : 'partial', now, bill.id);
      }
      // A0-B-C3：预收抵扣收款的作废必须回滚预收——否则账簿 1123 已被红冲恢复
      // 而 advances 余额仍被扣减，客户预收凭空蒸发（账表永久分叉）
      if (row.from_advance_id) {
        const adv = db.prepare('SELECT * FROM advances WHERE id = ?').get(row.from_advance_id);
        if (adv && adv.status !== 'void') {
          const balance = adv.balance_cents + row.amount_cents;
          db.prepare('UPDATE advances SET balance_cents = ?, status = ?, updated_at = ? WHERE id = ?')
            .run(balance, balance >= adv.amount_cents ? 'open' : 'partial', now, adv.id);
        }
        db.prepare(
          `UPDATE advance_usages SET status = 'void'
           WHERE advance_id = ? AND ref_type = 'receipt' AND ref_id = ? AND status = 'active'`)
          .run(row.from_advance_id, row.receipt_no);
        logEdit(db, { table: 'advances', recordId: row.from_advance_id, action: 'update',
          before: { note: '作废预收抵扣收款 ' + row.receipt_no }, after: { balance_restored: row.amount_cents } });
      }
    }
    if (table === 'advances') {
      const used = db.prepare(
        "SELECT COALESCE(SUM(amount_cents),0) AS n FROM advance_usages WHERE advance_id = ? AND status = 'active'").get(id).n;
      if (used > 0) throw new ApiError('INVALID_STATE', '预收/预支已有抵扣或冲销流水，请先作废对应流水');
      // B0-N-2c：收款余额转的预收（自身无独立凭证，账挂在原收款分录里）禁止单独
      // 作废——只清余额不冲账簿会令 C6 分叉；作废原收款时会联动作废本预收
      if (!entry && row.balance_cents > 0) {
        throw new ApiError('INVALID_STATE',
          `预收 ${row.advance_no} 是收款余额转入（无独立凭证），请作废对应的按客户收款（其作废时将联动作废本预收）`);
      }
      // A0-B-M1a：作废时余额清零——红冲已把账簿恢复，余额残留会让"作废的钱"继续可用
      db.prepare('UPDATE advances SET balance_cents = 0, updated_at = ? WHERE id = ?').run(now, id);
    }
    db.prepare(`UPDATE ${spec.tbl} SET status = 'void', updated_at = ? WHERE id = ?`).run(now, id);
    logEdit(db, { table: spec.tbl, recordId: id, action: 'void', before: { status: row.status }, after: { status: 'void' } });
  });
  tx();
  return getActive(db, spec.tbl, id);
}

/* ---------------- 查询 ---------------- */

function listReceipts(db) {
  // C3：核销明细从结构化表拼（前端形状不变：[{bill_id, bill_no, amount_cents}]）
  const allocStmt = db.prepare(
    `SELECT ra.bill_id, b.bill_no, ra.amount_cents FROM receipt_allocations ra
     LEFT JOIN bills b ON b.id = ra.bill_id WHERE ra.receipt_id = ? ORDER BY ra.id`);
  const legacyAllocs = (row) => {
    if (row.allocations) {
      try {
        const j = JSON.parse(row.allocations);
        return (j && (Array.isArray(j) ? j : j.items)) || [];
      } catch (e) { /* 坏 JSON 忽略 */ }
    }
    return [];
  };
  return db.prepare(
    `SELECT r.*, b.bill_no, p.name AS party_name FROM receipts r
     LEFT JOIN bills b ON b.id = r.bill_id LEFT JOIN parties p ON p.id = r.party_id
     ORDER BY r.id DESC LIMIT 500`).all().map(r => ({
      ...r,
      allocations: (() => {
        const rows = allocStmt.all(r.id);
        if (rows.length) return JSON.stringify(rows.map(x => ({ bill_id: x.bill_id, bill_no: x.bill_no, amount_cents: x.amount_cents })));
        const legacy = legacyAllocs(r);
        return legacy.length ? JSON.stringify(legacy.map(x => ({ bill_id: x.bill_id, bill_no: x.bill_no, amount_cents: x.amount_cents }))) : null;
      })()
    }));
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

/**
 * 其他收入落账（P7-B6/A3(d)：无作业归属的收入，如导入的"无姓名收入对"）。
 * 借 1001 现金 / 贷 6099 其他收入（seed 幂等补种）。ref 指向来源行以便溯源；
 * 重复调用由调用方用 booked 标记防重（本函数不查重）。
 */
function postOtherIncome(db, { amount_cents, occurred_at, note, ref_type, ref_id, party_id }) {
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
    throw new ApiError('VALIDATION', 'amount_cents 必须是正整数分');
  }
  return postEntry(db, {
    event_type: 'other_income', ref_type: ref_type || null, ref_id: ref_id || null,
    occurred_at: occurred_at || nowISO(), memo: note || '其他收入',
    lines: [
      { account_code: '1001', direction: 'debit', amount_cents, party_id: party_id || null, memo: '其他收入实收' },
      { account_code: '6099', direction: 'credit', amount_cents, party_id: party_id || null, memo: note || '其他收入' }
    ]
  });
}

module.exports = {
  createReceipt, updateReceipt, createPayment, updatePayment, updateAdvanceNote,
  createAdvance, settleAdvance, createSplit, postOtherIncome,
  voidFinanceRecord, listReceipts, listPayments, listAdvances, listSplits,
  PAYMENT_CATEGORIES
};
