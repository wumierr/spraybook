/* ============================================================
   services/parties.js — 客户 upsert（只建不改）
   规则（docs/PLAN.md）：匹配 name+phone（phone 空退化按 name）；
   已存在绝不覆盖；计算器新建 source='calculator'。
   ============================================================ */
'use strict';

function findPartyByNamePhone(db, name, phone) {
  const p = String(phone || '').trim();
  if (p) {
    return db.prepare(
      `SELECT id FROM parties WHERE type='customer' AND name=? AND IFNULL(phone,'')=? AND deleted_at IS NULL`
    ).get(name, p);
  }
  return db.prepare(
    `SELECT id FROM parties WHERE type='customer' AND name=? AND deleted_at IS NULL`
  ).get(name);
}

/**
 * 从计算器农户档案 upsert 客户（只建不改）。
 * 返回 { created, matched } 计数。
 */
function upsertCustomersFromCalculator(db, farmers) {
  let created = 0, matched = 0;
  const now = new Date().toISOString();
  for (const f of Array.isArray(farmers) ? farmers : []) {
    const name = String(f.name || '').trim();
    if (!name || name === '（未建档）') continue; // 兜底档案不入库
    const phone = String(f.phone || '').trim();
    const existing = findPartyByNamePhone(db, name, phone);
    if (existing) { matched++; continue; }
    db.prepare(
      `INSERT INTO parties (type, name, phone, default_price_cents, default_area_mu, notes, enabled, source, created_at, updated_at)
       VALUES ('customer', ?, ?, ?, ?, ?, ?, 'calculator', ?, ?)`
    ).run(
      name, phone,
      f.pricePerMu > 0 ? Math.round(Number(f.pricePerMu) * 100) : null,
      f.plotTemplate && f.plotTemplate.area != null ? Number(f.plotTemplate.area) : null,
      f.notes || '',
      f.enabled === false ? 0 : 1,
      now, now
    );
    created++;
  }
  return { created, matched };
}

module.exports = { findPartyByNamePhone, upsertCustomersFromCalculator };
