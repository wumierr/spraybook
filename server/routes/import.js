/* ============================================================
   routes/import.js — 历史 Excel 导入（M8）
   parse（base64 上传→staging）→ 行级复核（confirm/reject/edit）→
   apply（confirmed 全量落正式表，事务）→ reconciliation（对账报告）
   ============================================================ */
'use strict';

const express = require('express');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { parseWorkbook, applyJobRow, applyExpenseRow, cellVal } = require('../services/importExcel');
const { ApiError } = require('../services/apiError');
const { logEdit, nextBizNo } = require('../services/audit');
const { postEntry } = require('../services/journal');

function createImportRouter(db) {
  const router = express.Router();

  const getBatch = (id) => {
    const b = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(id);
    if (!b) throw new ApiError('NOT_FOUND', `导入批次不存在: ${id}`, 404);
    return b;
  };

  /* ---- 解析入 staging ---- */
  router.post('/import/parse', async (req, res, next) => {
    try {
      const { filename, base64 } = req.body || {};
      if (!base64) throw new ApiError('VALIDATION', 'base64 必填');
      const buf = Buffer.from(base64, 'base64');
      const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);

      const dup = db.prepare('SELECT id FROM import_batches WHERE note LIKE ?').get(`%"hash":"${hash}"%`);
      if (dup) throw new ApiError('DUPLICATE', `该文件已导入过（批次 #${dup.id}）`, 400);

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf);
      const { rows, stats } = parseWorkbook(wb);

      // 原始列合计（独立于解析器对象代码的对账基线，口径与解析器分区一致）
      const rawTotals = { receivable: 0, paid: 0, expense: 0 };
      for (const ws of wb.worksheets) {
        // 表头定位（与解析器同规则）：按列名映射，容忍 1 月多出的"作业目的"列
        let hdrRow = null;
        const inv = {};
        for (let r = 1; r <= 5; r++) {
          const cells = {};
          for (let c = 1; c <= 16; c++) {
            const s = String(cellVal(ws.getCell(r, c).value) ?? '').trim();
            if (s) cells[c] = s;
          }
          if (Object.values(cells).includes('日期') && Object.values(cells).includes('姓名')) {
            hdrRow = r;
            for (const [c, name] of Object.entries(cells)) inv[name] = Number(c);
            break;
          }
        }
        if (!hdrRow) continue;
        const recvCol = inv['应收金额'];
        const paidCol = inv['实收金额'];
        const catCol = inv['支出类型'] || inv['支出项目'] || null;
        const amtCol = inv['支出金额/元'] || (catCol ? catCol + 1 : null);
        const nameCol = inv['姓名'] || 2;

        for (let r = hdrRow + 1; r <= ws.rowCount; r++) {
          const name = cellVal(ws.getCell(r, nameCol).value);
          const hasName = name != null && String(name).trim() !== '';
          if (hasName && recvCol) {
            const recv = cellVal(ws.getCell(r, recvCol).value);
            if (typeof recv === 'number') rawTotals.receivable += recv;
          }
          if (hasName && paidCol) {
            const paid = cellVal(ws.getCell(r, paidCol).value);
            if (typeof paid === 'number') rawTotals.paid += paid;
          }
          // 标准列对
          if (catCol && amtCol) {
            const cat = cellVal(ws.getCell(r, catCol).value);
            const amt = cellVal(ws.getCell(r, amtCol).value);
            const catS = cat == null ? '' : String(cat).trim();
            if (catS && typeof cat === 'string' && !/已结算|未收款/.test(catS) && typeof amt === 'number' && amt > 0) {
              rawTotals.expense += amt;
            }
          }
          // 扩展区（标准金额列+1 起）：文本(≤14字,非日期起头) → 右侧 1..3 列数值
          const start = (amtCol || 8) + 1;
          let i = start;
          while (i <= 20) {
            const v = cellVal(ws.getCell(r, i).value);
            const s = v == null ? '' : String(v).trim();
            if (!s) { i++; continue; }
            if (typeof v === 'string' && s.length <= 14 && !/已结算|转账|未收款/.test(s) && !/^\d/.test(s)) {
              for (let j = i + 1; j <= Math.min(i + 3, 20); j++) {
                const a = cellVal(ws.getCell(r, j).value);
                if (typeof a === 'number' && a > 0) {
                  rawTotals.expense += a;
                  const person = ws.getCell(r, j + 1).value;
                  i = j + (typeof person === 'string' && person.trim() && !/^\d/.test(person) ? 1 : 0);
                  break;
                }
              }
            }
            i++;
          }
        }
      }

      const now = new Date().toISOString();
      const tx = db.transaction(() => {
        const info = db.prepare(
          `INSERT INTO import_batches (filename, source_type, status, note, imported_at, created_at)
           VALUES (?, 'excel', 'reviewing', ?, ?, ?)`)
          .run(filename || '未命名.xlsx', JSON.stringify({ hash, raw_totals: rawTotals, stats }), now, now);
        const batchId = info.lastInsertRowid;
        const ins = db.prepare(
          `INSERT INTO raw_import_rows (batch_id, sheet_name, row_no, raw_text, parsed_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`);
        for (const row of rows) {
          ins.run(batchId, row.sheet, row.row_no, row.raw_text,
            JSON.stringify({ kind: row.kind, parsed: row.parsed, needs_review: row.needs_review }),
            now, now);
        }
        logEdit(db, { table: 'import_batches', recordId: batchId, action: 'create',
          after: { filename, hash, stats } });
        return batchId;
      });
      const batchId = tx();

      const reviewList = db.prepare(
        `SELECT id, sheet_name, row_no, raw_text, parsed_json FROM raw_import_rows
         WHERE batch_id = ? AND parsed_json LIKE '%needs_review":[%' AND parsed_json NOT LIKE '%needs_review":[]%'
         ORDER BY id`).all(batchId)
        .map(r => ({ id: r.id, sheet: r.sheet_name, row_no: r.row_no, raw: r.raw_text,
                     needs_review: JSON.parse(r.parsed_json).needs_review }));

      res.json({ ok: true, data: { batch_id: batchId, stats, raw_totals: rawTotals, review_count: reviewList.length, review_list: reviewList } });
    } catch (err) { next(err); }
  });

  /* ---- 批次列表/行列表 ---- */
  router.get('/import/batches', (req, res) => {
    res.json({ ok: true, data: db.prepare('SELECT * FROM import_batches ORDER BY id DESC').all() });
  });

  router.get('/import/batches/:id/rows', (req, res) => {
    const b = getBatch(Number(req.params.id));
    const status = req.query.status;
    const rows = db.prepare(
      `SELECT * FROM raw_import_rows WHERE batch_id = ? ${status ? 'AND status = ?' : ''} ORDER BY id`)
      .all(...(status ? [b.id, status] : [b.id]));
    res.json({ ok: true, data: rows.map(r => ({ ...r, parsed: JSON.parse(r.parsed_json || '{}') })) });
  });

  /* ---- 行级复核 ---- */
  router.patch('/import/rows/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM raw_import_rows WHERE id = ?').get(Number(req.params.id));
    if (!row) throw new ApiError('NOT_FOUND', `staging 行不存在`, 404);
    if (row.status === 'applied') throw new ApiError('INVALID_STATE', '该行已落库');
    const { action, parsed } = req.body || {};
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      if (parsed) {
        const merged = JSON.parse(row.parsed_json || '{}');
        merged.parsed = { ...merged.parsed, ...parsed };
        merged.needs_review = []; // 人工编辑过 → 视为已澄清
        db.prepare('UPDATE raw_import_rows SET parsed_json = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(merged), now, row.id);
      }
      if (['confirm', 'reject', 'pending'].includes(action)) {
        db.prepare('UPDATE raw_import_rows SET status = ?, updated_at = ? WHERE id = ?')
          .run(action === 'confirm' ? 'confirmed' : action === 'reject' ? 'rejected' : 'pending', now, row.id);
      }
      logEdit(db, { table: 'raw_import_rows', recordId: row.id, action: 'update',
        after: { action, parsed } });
    });
    tx();
    const r = db.prepare('SELECT * FROM raw_import_rows WHERE id = ?').get(row.id);
    res.json({ ok: true, data: { ...r, parsed: JSON.parse(r.parsed_json || '{}') } });
  });

  /* ---- 落库 ---- */
  router.post('/import/batches/:id/apply', (req, res, next) => {
    try {
      const b = getBatch(Number(req.params.id));
      if (b.status === 'applied') throw new ApiError('INVALID_STATE', '批次已落库');
      const operator = (req.body && req.body.operator) || 'local';
      const rows = db.prepare(
        "SELECT * FROM raw_import_rows WHERE batch_id = ? AND status = 'confirmed' ORDER BY id").all(b.id);
      if (!rows.length) throw new ApiError('VALIDATION', '没有 confirmed 行可落库（先复核确认）');

      const result = { jobs: 0, expenses: 0, skipped_zero: 0 };
      for (const row of rows) {
        const { kind, parsed } = JSON.parse(row.parsed_json || '{}');
        if (kind === 'job') {
          if (!parsed.receivable_cents && !parsed.paid_cents) { result.skipped_zero++; continue; }
          applyJobRow(db, parsed, b.id, row.id, operator);
          result.jobs++;
        } else if (kind === 'expense') {
          if (!parsed.amount_cents) { result.skipped_zero++; continue; }
          applyExpenseRow(db, parsed, b.id, row.id, operator);
          result.expenses++;
        }
      }
      db.prepare("UPDATE import_batches SET status = 'applied' WHERE id = ?")
        .run(b.id);
      // 行状态保持 'confirmed'（001 CHECK 枚举无 applied；批次 status='applied' 表达已落库）
      logEdit(db, { table: 'import_batches', recordId: b.id, action: 'update',
        before: { status: 'reviewing' }, after: { status: 'applied', result }, operator });
      res.json({ ok: true, data: result });
    } catch (err) { next(err); }
  });

  /* ---- M5.5 手工期初兜底：Excel 外旧账补录（opening 凭证走期初权益 4103） ---- */
  router.post('/import/opening', (req, res) => {
    const { party_id, kind, amount_cents, occurred_at, note } = req.body || {};
    if (!party_id || !Number.isInteger(amount_cents) || amount_cents <= 0) {
      throw new ApiError('VALIDATION', 'party_id 与正整数 amount_cents 必填');
    }
    if (!['receivable', 'prepaid', 'worker_advance'].includes(kind)) {
      throw new ApiError('VALIDATION', 'kind 必须是 receivable / prepaid / worker_advance');
    }
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      if (kind === 'receivable') {
        const billNo = nextBizNo(db, 'bills', 'bill_no', 'B');
        const info = db.prepare(
          `INSERT INTO bills (bill_no, settlement_id, party_id, farmer_name, amount_cents, adjust_cents, paid_cents, status, issued_at, note, opening, created_at, updated_at)
           VALUES (?, NULL, ?, (SELECT name FROM parties WHERE id = ?), ?, 0, 0, 'unpaid', ?, ?, 1, ?, ?)`)
          .run(billNo, party_id, party_id, amount_cents, occurred_at || now, '期初补录：' + (note || '旧账'), now, now);
        postEntry(db, {
          event_type: 'opening', ref_type: 'bill', ref_id: info.lastInsertRowid,
          occurred_at: occurred_at || now, memo: '期初应收 ' + billNo,
          lines: [
            { account_code: '1122', direction: 'debit', amount_cents, party_id, memo: note || '期初应收' },
            { account_code: '4103', direction: 'credit', amount_cents, party_id, memo: '期初权益' }
          ]
        });
        return { bill_id: info.lastInsertRowid };
      }
      const direction = kind === 'prepaid' ? 'prepaid_by_customer' : 'advance_to_worker';
      const advanceNo = nextBizNo(db, 'advances', 'advance_no', 'A');
      const info = db.prepare(
        `INSERT INTO advances (advance_no, party_id, direction, amount_cents, balance_cents, occurred_at, note, status, opening, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?)`)
        .run(advanceNo, party_id, direction, amount_cents, amount_cents, occurred_at || now, '期初补录：' + (note || '旧账'), now, now);
      const lines = kind === 'prepaid'
        ? [
            { account_code: '4103', direction: 'debit', amount_cents, party_id, memo: '期初权益' },
            { account_code: '1123', direction: 'credit', amount_cents, party_id, memo: '期初预收 ' + advanceNo }
          ]
        : [
            { account_code: '1221', direction: 'debit', amount_cents, party_id, memo: '期初员工预支 ' + advanceNo },
            { account_code: '4103', direction: 'credit', amount_cents, party_id, memo: '期初权益' }
          ];
      postEntry(db, {
        event_type: 'opening', ref_type: 'advance', ref_id: info.lastInsertRowid,
        occurred_at: occurred_at || now, memo: '期初' + (kind === 'prepaid' ? '预收 ' : '预支 ') + advanceNo, lines
      });
      return { advance_id: info.lastInsertRowid };
    });
    const data = tx();
    res.json({ ok: true, data });
  });

  /* ---- 对账报告：staging 确认/落库行 vs 解析时的原始列合计 ---- */
  router.get('/import/batches/:id/reconciliation', (req, res) => {
    const b = getBatch(Number(req.params.id));
    let raw = { hash: null, raw_totals: null };
    try { raw = JSON.parse(b.note || '{}'); } catch (e) { /* */ }
    const sums = db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN json_extract(parsed_json,'$.kind')='job' THEN 1 ELSE 0 END),0) AS jobs,
         COALESCE(SUM(CASE WHEN json_extract(parsed_json,'$.kind')='expense' THEN 1 ELSE 0 END),0) AS expenses,
         COALESCE(SUM(CASE WHEN json_extract(parsed_json,'$.kind')='job' THEN json_extract(parsed_json,'$.parsed.receivable_cents') ELSE 0 END),0) AS receivable_cents,
         COALESCE(SUM(CASE WHEN json_extract(parsed_json,'$.kind')='job' THEN json_extract(parsed_json,'$.parsed.paid_cents') ELSE 0 END),0) AS paid_cents,
         COALESCE(SUM(CASE WHEN json_extract(parsed_json,'$.kind')='expense' THEN json_extract(parsed_json,'$.parsed.amount_cents') ELSE 0 END),0) AS expense_cents
       FROM raw_import_rows WHERE batch_id = ? AND status IN ('confirmed','applied')`).get(b.id);
    const rt = raw.raw_totals || {};
    const r = (v) => Math.round(v * 100) / 100;
    const diff = {
      receivable_cents: (sums.receivable_cents || 0) - Math.round((rt.receivable || 0) * 100),
      paid_cents: (sums.paid_cents || 0) - Math.round((rt.paid || 0) * 100),
      expense_cents: (sums.expense_cents || 0) - Math.round((rt.expense || 0) * 100)
    };
    res.json({ ok: true, data: {
      batch_id: b.id, status: b.status, raw_totals: rt, staged: sums, diff,
      balanced: diff.receivable_cents === 0 && diff.paid_cents === 0 && diff.expense_cents === 0
    } });
  });

  return router;
}

module.exports = { createImportRouter };
