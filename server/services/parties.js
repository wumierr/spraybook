/* ============================================================
   services/parties.js — 客户 upsert（只建不改）
   规则（DATA-CONTRACT §2a，D3 四元组裁决 2026-10-24）：
   匹配键=姓名+电话+村+队（IFNULL 空串口径，对齐 003 唯一索引）；
   电话/村/队全空退化按姓名（保持旧档合流）；已存在绝不覆盖；
   计算器新建 source='calculator'（快照自带 village/team）。
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

/** 四元组查找：姓名+电话+村+队；全空退化按姓名（D3 先决裁决） */
function findPartyByBusinessKey(db, name, phone, village, team) {
  const hit = db.prepare(
    `SELECT id FROM parties WHERE type='customer' AND name=? AND IFNULL(phone,'')=?
       AND IFNULL(village,'')=? AND IFNULL(team,'')=? AND deleted_at IS NULL`
  ).get(String(name || '').trim(), String(phone || '').trim(),
    String(village || '').trim(), String(team || '').trim());
  if (hit) return hit;
  if (!String(phone || '').trim() && !String(village || '').trim() && !String(team || '').trim()) {
    return db.prepare(
      `SELECT id FROM parties WHERE type='customer' AND name=? AND deleted_at IS NULL`
    ).get(String(name || '').trim());
  }
  return null;
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
    const village = String(f.village || '').trim();
    const team = String(f.team || '').trim();
    const existing = findPartyByBusinessKey(db, name, phone, village, team);
    if (existing) { matched++; continue; }
    db.prepare(
      `INSERT INTO parties (type, name, phone, village, team, default_price_cents, default_area_mu, notes, enabled, source, created_at, updated_at)
       VALUES ('customer', ?, ?, ?, ?, ?, ?, ?, ?, 'calculator', ?, ?)`
    ).run(
      name, phone, village || null, team || null,
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

module.exports = { findPartyByNamePhone, findPartyByBusinessKey, upsertCustomersFromCalculator };
