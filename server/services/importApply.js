/* ============================================================
   services/importApply.js — P8：apply 事务从路由抽出（HTTP 与 CLI 共用）
   语义与原 routes/import.js 完全一致：仅 confirmed 行、整体单事务、
   毒行中断全部回滚、income_pair 落 6099（B6）、未知 kind 显式计数。
   ============================================================ */
'use strict';

const { ApiError } = require('./apiError');
const { logEdit } = require('./audit');
const { applyJobRow, applyExpenseRow } = require('./importExcel');
const { postOtherIncome } = require('./finance');

function applyBatch(db, batchId, { operator = 'local' } = {}) {
  const b = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId);
  if (!b) throw new ApiError('NOT_FOUND', `导入批次不存在: ${batchId}`, 404);
  if (b.status === 'applied') throw new ApiError('INVALID_STATE', '批次已落库');
  const rows = db.prepare(
    "SELECT * FROM raw_import_rows WHERE batch_id = ? AND status = 'confirmed' ORDER BY id").all(batchId);
  if (!rows.length) throw new ApiError('VALIDATION', '没有 confirmed 行可落库（先复核确认）');

  const result = { jobs: 0, expenses: 0, income_pairs: 0, skipped_zero: 0, skipped_unsupported: 0 };
  // 整体单事务：毒行中断 → 全部回滚零残留（批次保持 reviewing，修复后可重试）；
  // 不包事务时前面行已提交、批次卡死，重试还撞 client_job_id UNIQUE
  const tx = db.transaction(() => {
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
      } else if (kind === 'income_pair') {
        // B6（P7-R1，用户裁决"记其他收入"）：无作业归属的收入对落 6099 其他收入。
        // 此前被静默丢弃（540 元账外）。booked 标记防重复落库（backfill-010 同款）。
        if (parsed.booked) { result.skipped_zero++; continue; }
        if (!parsed.income_cents) { result.skipped_zero++; continue; }
        postOtherIncome(db, {
          amount_cents: parsed.income_cents,
          occurred_at: parsed.date || null,
          note: `导入收入对落账（批次#${b.id} 行#${row.id}，${parsed.income_cents / 100} 元）`,
          ref_type: 'import_row', ref_id: row.id
        });
        const meta = JSON.parse(row.parsed_json || '{}');
        meta.booked = { at: new Date().toISOString(), batch_id: b.id };
        db.prepare('UPDATE raw_import_rows SET parsed_json = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(meta), new Date().toISOString(), row.id);
        result.income_pairs++;
      } else if (kind) {
        // 未知类型不再静默丢弃：显式计数并随 apply 结果返回（前端提示"N 行未入账"）
        result.skipped_unsupported++;
      }
    }
    db.prepare("UPDATE import_batches SET status = 'applied' WHERE id = ?").run(b.id);
    // 行状态保持 'confirmed'（001 CHECK 枚举无 applied；批次 status='applied' 表达已落库）
    logEdit(db, { table: 'import_batches', recordId: b.id, action: 'update',
      before: { status: b.status }, after: { status: 'applied', result }, operator });
  });
  tx();
  return result;
}

module.exports = { applyBatch };
