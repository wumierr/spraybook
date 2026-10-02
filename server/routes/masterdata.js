/* ============================================================
   routes/masterdata.js — M7 主数据 CRUD（一切编辑走 edit_logs）
   parties / plots / chemicals / equipment / price_rules
   + GET /api/bootstrap（计算器读反哺）
   ============================================================ */
'use strict';

const express = require('express');
const { ApiError } = require('../services/apiError');
const { logEdit } = require('../services/audit');

const TABLES = {
  parties: ['name', 'phone', 'address', 'region', 'village', 'team', 'default_price_cents', 'default_area_mu', 'notes', 'enabled', 'type'],
  plots: ['party_id', 'name', 'area_mu', 'notes'],
  chemicals: ['key', 'name', 'icon', 'water_per_mu', 'pesticide_water_per_set', 'drone_saving_coeff', 'price_cents_per_set', 'description', 'notes', 'flight_height', 'line_spacing', 'flight_speed'],
  equipment: ['name', 'kind', 'cycles_count', 'notes', 'status'],
  price_rules: ['party_id', 'job_type', 'unit', 'price_cents', 'effective_from', 'note']
};

function createMasterdataRouter(db) {
  const router = express.Router();

  const getRow = (table, id) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!row) throw new ApiError('NOT_FOUND', `${table} #${id} 不存在`, 404);
    return row;
  };

  for (const table of Object.keys(TABLES)) {
    const cols = TABLES[table];

    router.post(`/${table}`, (req, res) => {
      const body = req.body || {};
      const now = new Date().toISOString();
      const tx = db.transaction(() => {
        const names = cols.filter(c => body[c] !== undefined);
        if (!names.length) throw new ApiError('VALIDATION', '无有效字段');
        const info = db.prepare(
          `INSERT INTO ${table} (${names.join(',')}, created_at, updated_at)
           VALUES (${names.map(() => '?').join(',')}, ?, ?)`)
          .run(...names.map(c => body[c]), now, now);
        logEdit(db, { table, recordId: info.lastInsertRowid, action: 'create', after: body });
        return info.lastInsertRowid;
      });
      res.json({ ok: true, data: { id: tx() } });
    });

    router.patch(`/${table}/:id`, (req, res) => {
      const id = Number(req.params.id);
      const before = getRow(table, id);
      const body = req.body || {};
      if (table === 'parties' && body.name !== undefined && !String(body.name).trim()) {
        throw new ApiError('VALIDATION', 'name 不能为空');
      }
      const now = new Date().toISOString();
      const tx = db.transaction(() => {
        const sets = cols.filter(c => body[c] !== undefined);
        if (!sets.length) throw new ApiError('VALIDATION', '无有效字段');
        db.prepare(
          `UPDATE ${table} SET ${sets.map(c => `${c} = ?`).join(',')}, updated_at = ? WHERE id = ?`)
          .run(...sets.map(c => body[c]), now, id);
        const after = getRow(table, id);
        logEdit(db, { table, recordId: id, action: 'update',
          before: Object.fromEntries(sets.map(c => [c, before[c]])),
          after: Object.fromEntries(sets.map(c => [c, after[c]])) });
      });
      tx();
      res.json({ ok: true, data: getRow(table, id) });
    });

    router.post(`/master/${table}/:id/void`, (req, res) => {
      const id = Number(req.params.id);
      const before = getRow(table, id);
      const now = new Date().toISOString();
      const tx = db.transaction(() => {
        db.prepare(`UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id);
        logEdit(db, { table, recordId: id, action: 'void', before: { deleted_at: null }, after: { deleted_at: now } });
      });
      tx();
      res.json({ ok: true, data: { voided: true } });
    });
  }

  /* ---- 设置（operator 等，键值表） ---- */
  router.get('/settings', (req, res) => {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    res.json({ ok: true, data: Object.fromEntries(rows.map(r => [r.key, r.value])) });
  });
  router.put('/settings', (req, res) => {
    const body = req.body || {};
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      for (const [k, v] of Object.entries(body)) {
        db.prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
          .run(k, String(v), now);
        logEdit(db, { table: 'settings', recordId: 0, action: 'update', after: { key: k, value: String(v) } });
      }
    });
    tx();
    res.json({ ok: true, data: body });
  });

  /* 列表（含已软删，供后台查看） */
  router.get('/master/:table', (req, res) => {
    const table = req.params.table;
    if (!TABLES[table]) throw new ApiError('NOT_FOUND', `未知主数据: ${table}`, 404);
    res.json({ ok: true, data: db.prepare(`SELECT * FROM ${table} ORDER BY id DESC LIMIT 1000`).all() });
  });

  /* ---- 计算器读反哺 ---- */
  router.get('/bootstrap', (req, res) => {
    const parties = db.prepare(
      `SELECT id, type, name, phone, village, team, default_price_cents, default_area_mu, notes
       FROM parties WHERE deleted_at IS NULL AND enabled = 1 ORDER BY type, name`).all();
    const chemicals = db.prepare(
      `SELECT * FROM chemicals WHERE deleted_at IS NULL ORDER BY id`).all();
    const priceRules = db.prepare(
      `SELECT * FROM price_rules WHERE deleted_at IS NULL ORDER BY id`).all();
    const balances = db.prepare(
      `SELECT party_id,
         COALESCE(SUM(CASE WHEN status IN ('unpaid','partial') THEN amount_cents + adjust_cents - paid_cents END),0) AS receivable_cents
       FROM bills WHERE party_id IS NOT NULL GROUP BY party_id`).all();
    const prepaids = db.prepare(
      `SELECT party_id, COALESCE(SUM(balance_cents),0) AS cents FROM advances
       WHERE direction='prepaid_by_customer' AND status IN ('open','partial') GROUP BY party_id`).all();
    const lastJobs = db.prepare(
      `SELECT l.farmer_ref, l.farmer_name, j.job_date, j.plant_type_name,
              (SELECT l2.spray_fee_cents / l2.area_mu FROM job_settlement_lines l2
                 WHERE l2.job_id = j.id AND l2.area_mu > 0 LIMIT 1) AS price_yuan
       FROM job_settlement_lines l JOIN jobs j ON j.id = l.job_id
       WHERE j.deleted_at IS NULL AND j.status != 'void'
       ORDER BY j.job_date DESC, j.id DESC LIMIT 500`).all();
    const recvMap = new Map(balances.map(b => [b.party_id, b.receivable_cents]));
    const prepMap = new Map(prepaids.map(b => [b.party_id, b.cents]));
    const lastMap = new Map();
    for (const j of lastJobs) {
      if (j.farmer_ref && !lastMap.has('ref:' + j.farmer_ref)) lastMap.set('ref:' + j.farmer_ref, j);
      if (j.farmer_name && !lastMap.has('name:' + j.farmer_name)) lastMap.set('name:' + j.farmer_name, j);
    }
    const operatorSetting = db.prepare("SELECT value FROM settings WHERE key = 'operator'").get();
    const data = {
      generated_at: new Date().toISOString(),
      operator: operatorSetting ? operatorSetting.value : '',
      parties: parties.map(p => {
        const last = lastMap.get('ref:' + p.id) || lastMap.get('name:' + p.name) || null;
        return {
          ...p,
          receivable_cents: recvMap.get(p.id) || 0,
          prepaid_cents: prepMap.get(p.id) || 0,
          last_job: last ? { date: last.job_date, plant: last.plant_type_name, price_yuan: last.price_yuan } : null
        };
      }),
      chemicals,
      price_rules: priceRules
    };
    res.json({ ok: true, data });
  });

  return router;
}

module.exports = { createMasterdataRouter };
