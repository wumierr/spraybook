/* ============================================================
   services/merge.js — P9-R2 客户合并（D4 全套）
   mergeParties(db, fromId, intoId, keep) 单事务：
     - 校验 from≠into、两档均存在且未软删
     - 重挂全部 9 处引用：plots / price_rules / settlement_items / bills /
       receipts / advances / manual_splits / journal_lines 的 party_id
       与 payments 的 payee_party_id
     - from 软删（deleted_at）+ notes 追加「已并入 #intoId（原名保留）」
     - keep（village/region/phone/notes 等可选字段，白名单）覆盖存续档
     - 事务内前后断言：Σ借=Σ贷 与 1122 口径 Σ(amount−paid) 不变，
       破坏即 throw → 整体回滚（合并只动 party_id 外键，金额分文永不动）
     - edit_logs 双记录（action=update，record_id 各自，备注 merge from→into）
   历史快照列（farmer_name 等）一律不改——历史单据保持当时的样子。
   ============================================================ */
'use strict';

const { ApiError } = require('./apiError');
const { logEdit } = require('./audit');

/** 9 处 party 引用（表, 列）。新增引用表时必须同步补进这里并加测试。 */
const PARTY_REFERENCES = [
  ['plots', 'party_id'],
  ['price_rules', 'party_id'],
  ['settlement_items', 'party_id'],
  ['bills', 'party_id'],
  ['receipts', 'party_id'],
  ['advances', 'party_id'],
  ['manual_splits', 'party_id'],
  ['journal_lines', 'party_id'],
  ['payments', 'payee_party_id']
];

/** keep 可覆盖存续档的字段白名单（parties 列名，防注入；不含 name/type/id） */
const KEEP_FIELDS = ['region', 'village', 'team', 'phone', 'address',
  'default_price_cents', 'default_area_mu', 'notes'];

/** 不变量快照：Σ借/Σ贷 + 1122 口径账单 Σ(amount−paid)（reconcile C1/C2 同式） */
function snapshotInvariants(db) {
  const bal = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount_cents END),0) AS debit,
            COALESCE(SUM(CASE WHEN direction='credit' THEN amount_cents END),0) AS credit
       FROM journal_lines`).get();
  const ar = db.prepare(
    `SELECT COALESCE(SUM(amount_cents - paid_cents),0) AS bills
       FROM bills WHERE status != 'void'`).get();
  return { debit: bal.debit, credit: bal.credit, ar1122: ar.bills };
}

/**
 * 合并客户档案：from 并入 into。返回 { from, into, moved:{表:行数}, note }。
 * 任何一步失败抛 ApiError，事务整体回滚。
 */
function mergeParties(db, fromId, intoId, keep) {
  const from = Number(fromId);
  const into = Number(intoId);
  if (!Number.isInteger(from) || !Number.isInteger(into) || from <= 0 || into <= 0) {
    throw new ApiError('VALIDATION', 'from_id / into_id 必须是正整数');
  }
  if (from === into) {
    throw new ApiError('VALIDATION', 'from_id 与 into_id 相同：不能把档案并入自己');
  }
  const fromRow = db.prepare('SELECT * FROM parties WHERE id = ?').get(from);
  const intoRow = db.prepare('SELECT * FROM parties WHERE id = ?').get(into);
  if (!fromRow) throw new ApiError('NOT_FOUND', `要合并的档案 #${from} 不存在`, 404);
  if (!intoRow) throw new ApiError('NOT_FOUND', `存续档案 #${into} 不存在`, 404);
  if (fromRow.deleted_at) throw new ApiError('INVALID_STATE', `档案 #${from} 已停用（${fromRow.deleted_at}），不能作为合并源`);
  if (intoRow.deleted_at) throw new ApiError('INVALID_STATE', `存续档案 #${into} 已停用，请先恢复或另选存续档`);

  // keep 清洗：仅白名单字段、显式传入才覆盖
  const keepSets = KEEP_FIELDS.filter(f => keep && typeof keep === 'object' && keep[f] !== undefined);

  const now = new Date().toISOString();
  const mergeNote = `merge from #${from} → into #${into}`;
  const beforeKeep = Object.fromEntries(keepSets.map(f => [f, intoRow[f]]));
  const moved = {};

  const tx = db.transaction(() => {
    // 不变量基线（事务内取，回滚保证不留脏数）
    const before = snapshotInvariants(db);

    // 1) 重挂 9 处引用（只动 party_id 外键，金额/快照列分文不碰）
    for (const [table, col] of PARTY_REFERENCES) {
      moved[table] = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`).run(into, from).changes;
    }

    // 2) keep 覆盖存续档
    if (keepSets.length) {
      db.prepare(`UPDATE parties SET ${keepSets.map(f => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...keepSets.map(f => keep[f]), now, into);
    }

    // 3) from 软删 + notes 追加（历史名与快照列一律保留）
    const newNotes = [fromRow.notes, `已并入 #${into}（原名保留）`].filter(Boolean).join('；');
    db.prepare('UPDATE parties SET deleted_at = ?, notes = ?, updated_at = ? WHERE id = ?')
      .run(now, newNotes, now, from);

    // 4) 事务内前后断言：合并只重挂引用，金额口径必须分文不变；破坏即 throw 回滚
    const after = snapshotInvariants(db);
    if (after.debit !== before.debit || after.credit !== before.credit) {
      throw new ApiError('INVARIANT_BROKEN',
        `合并后 Σ借(${after.debit})≠前(${before.debit}) 或 Σ贷(${after.credit})≠前(${before.credit})，已回滚`, 500);
    }
    if (after.ar1122 !== before.ar1122) {
      throw new ApiError('INVARIANT_BROKEN',
        `合并后 1122 口径 Σ(amount−paid) ${before.ar1122} → ${after.ar1122}，已回滚`, 500);
    }

    // 5) edit_logs 双记录（action=update，record_id 各自，备注 merge from→into）
    logEdit(db, { table: 'parties', recordId: from, action: 'update',
      before: { deleted_at: null, notes: fromRow.notes },
      after: { deleted_at: now, notes: newNotes, merged_into: into, note: mergeNote } });
    logEdit(db, { table: 'parties', recordId: into, action: 'update',
      before: beforeKeep,
      after: { ...Object.fromEntries(keepSets.map(f => [f, keep[f]])), merged_from: from, note: mergeNote } });
  });

  try {
    tx();
  } catch (e) {
    if (e instanceof ApiError) throw e;
    // parties(name, phone) 部分唯一索引：keep 改电话后与现存档案撞业务键
    if (/UNIQUE/.test(String(e.message))) {
      throw new ApiError('CONFLICT',
        `合并失败：存续档案业务键与现存档案冲突（${intoRow.name}${keep && keep.phone ? ' / 电话 ' + keep.phone : ''}），请调整 keep 字段或先处理冲突档案`, 409);
    }
    throw e;
  }

  return {
    from: { id: from, name: fromRow.name },
    into: { id: into, name: intoRow.name },
    moved,
    note: mergeNote
  };
}

module.exports = { mergeParties, PARTY_REFERENCES, KEEP_FIELDS, snapshotInvariants };
