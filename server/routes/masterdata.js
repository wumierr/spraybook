/* ============================================================
   routes/masterdata.js — M7 主数据 CRUD（一切编辑走 edit_logs）
   parties / plots / chemicals / equipment / price_rules
   + GET /api/bootstrap（计算器读反哺）
   ============================================================ */
'use strict';

const express = require('express');
const { ApiError } = require('../services/apiError');
const { logEdit } = require('../services/audit');
const { mergeParties } = require('../services/merge');

const TABLES = {
  parties: ['name', 'phone', 'address', 'region', 'village', 'team', 'county', 'default_price_cents', 'default_area_mu', 'notes', 'enabled', 'type'],
  plots: ['party_id', 'name', 'area_mu', 'notes'],
  chemicals: ['key', 'name', 'icon', 'water_per_mu', 'pesticide_water_per_set', 'drone_saving_coeff', 'price_cents_per_set', 'description', 'notes', 'flight_height', 'line_spacing', 'flight_speed',
    // C1 药品价格表经营三列（迁移 013）：进价/售价=INTEGER 分，库存=REAL 套数（NULL=不启用）
    'cost_cents', 'price_cents', 'stock_qty'],
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

    /* E8（P7-R4）：恢复软删记录（与停用确认文案"可恢复"对齐）。
       parties 有 name+phone 唯一索引：与现存档案撞业务键时给可读冲突，不炸 500。 */
    router.post(`/master/${table}/:id/restore`, (req, res) => {
      const id = Number(req.params.id);
      const before = getRow(table, id);
      if (!before.deleted_at) throw new ApiError('INVALID_STATE', '该记录未停用，无需恢复');
      const now = new Date().toISOString();
      try {
        const tx = db.transaction(() => {
          db.prepare(`UPDATE ${table} SET deleted_at = NULL, updated_at = ? WHERE id = ?`).run(now, id);
          logEdit(db, { table, recordId: id, action: 'update',
            before: { deleted_at: before.deleted_at }, after: { deleted_at: null, restored: true } });
        });
        tx();
      } catch (e) {
        if (/UNIQUE/.test(String(e.message))) {
          throw new ApiError('CONFLICT', `恢复失败：已有同业务键的现存档案（${before.name}），请先合并或改名`, 409);
        }
        throw e;
      }
      res.json({ ok: true, data: getRow(table, id) });
    });
  }

  /* ---- P9-R2：客户合并（重挂引用+软删留痕，金额分文不动） ---- */
  router.post('/master/parties/merge', (req, res) => {
    const body = req.body || {};
    if (body.from_id == null || body.into_id == null) {
      throw new ApiError('VALIDATION', 'from_id 与 into_id 必填');
    }
    const result = mergeParties(db, body.from_id, body.into_id, body.keep || {});
    res.json({ ok: true, data: result });
  });

  /* ---- P9-R2：数据体检（问题分组；同名/村异写/region 未填/空电话/金额离群） ---- */
  // 金额离群阈值：支出单笔 > 5000 元（P9 探针口径，P20261001-052 17,065 元即由此钓出）
  const OUTLIER_CENTS = 5000 * 100;

  /** settings 键 datahealth.dismissed（JSON 数组）——用户点「忽略」的问题项，GET 时过滤 */
  function readDismissed() {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'datahealth.dismissed'").get();
    if (!row) return [];
    try {
      const arr = JSON.parse(row.value);
      return Array.isArray(arr) ? arr.filter(k => typeof k === 'string') : [];
    } catch (e) { return []; }
  }
  const filterDismissed = (items, dismissed) => items.filter(it => !dismissed.includes(it.key));

  router.get('/data-health', (req, res) => {
    // P10-R1：可选市县过滤（?county=，空/缺省=全部不过滤）。四个主数据桶
    // （同名/村异写/region 未填/空电话）按 parties.county 过滤；金额离群是
    // payments 口径（油费/餐费等支出不归属市县，payee 多为空），保持全库不动。
    const county = req.query.county ? String(req.query.county) : null;
    const live = `type='customer' AND deleted_at IS NULL${county ? ' AND county = ?' : ''}`;
    const liveArgs = county ? [county] : [];

    /* 疑似重复：同名组（成员带 id/村/电话/单数/金额/最近作业，供合并预览并排对照） */
    const dupeNames = db.prepare(
      `SELECT name, COUNT(*) AS n FROM parties WHERE ${live} GROUP BY name HAVING n > 1 ORDER BY n DESC, name`).all(...liveArgs);
    // 最近作业只按 farmer_ref=party.id 精确关联（导入路径写入的 String(id)）。
    // 不做 farmer_name 近似：同名组成员恰好按 name 成组，name 匹配会把另一成员的
    // 作业日期算到自己头上，合并预览的决策信号会误导（评审 #3）。
    // 计算器来源单 farmer_ref='farmer_xxx' 无法精确归属 → 该列显示 —，宁缺勿错。
    const memberStmt = db.prepare(
      `SELECT p.id, p.name, p.region, p.village, p.team, p.phone,
              (SELECT COUNT(*) FROM bills b WHERE b.party_id = p.id AND b.status != 'void') AS bill_count,
              (SELECT COALESCE(SUM(b.amount_cents),0) FROM bills b WHERE b.party_id = p.id AND b.status != 'void') AS bill_amount_cents,
              (SELECT COALESCE(SUM(b.amount_cents + b.adjust_cents - b.paid_cents),0)
                 FROM bills b WHERE b.party_id = p.id AND b.status IN ('unpaid','partial')) AS due_cents,
              (SELECT MAX(j.job_date) FROM job_settlement_lines l JOIN jobs j ON j.id = l.job_id
                WHERE j.deleted_at IS NULL AND j.status != 'void'
                  AND l.farmer_ref = CAST(p.id AS TEXT)) AS last_job_date
         FROM parties p WHERE p.id = ?`);
    const suspect_dupes = dupeNames.map(g => ({
      key: `dupe:${g.name}`,
      name: g.name,
      members: db.prepare(`SELECT id FROM parties WHERE ${live} AND name = ? ORDER BY id`).all(...liveArgs, g.name)
        .map(r => memberStmt.get(r.id))
    }));

    /* 村名多写：互为前缀的两个在用村名（金桂/金桂村、大发/大发梁子形态） */
    const villages = db.prepare(
      `SELECT village, COUNT(*) AS n FROM parties WHERE ${live} AND village IS NOT NULL AND village != ''
       GROUP BY village ORDER BY n DESC, village`).all(...liveArgs);
    const village_variants = [];
    for (let i = 0; i < villages.length; i++) {
      for (let j = i + 1; j < villages.length; j++) {
        const a = villages[i].village, b = villages[j].village;
        // 用户裁决（2026-10-07）："梁子"结尾是组级小村名——X 与 X梁子 是大小层级
        // 关系不是异写（如 彰冠镇大发村 下辖的 梁子），不得当异写对提示。
        const big = a.length >= b.length ? a : b;
        const small = a.length >= b.length ? b : a;
        if (big.endsWith('梁子') && small && big.slice(0, -2) === small) continue;
        if (a.startsWith(b) || b.startsWith(a)) {
          village_variants.push({
            key: `village:${[a, b].sort().join('|')}`,
            values: [a, b],
            party_count: villages[i].n + villages[j].n
          });
        }
      }
    }

    const region_missing = db.prepare(
      `SELECT id, name, village, team FROM parties WHERE ${live} AND (region IS NULL OR region = '')
       ORDER BY village, id`).all(...liveArgs).map(r => ({ ...r, key: `region_missing:${r.id}` }));
    const no_phone = db.prepare(
      `SELECT id, name, village, team FROM parties WHERE ${live} AND (phone IS NULL OR phone = '')
       ORDER BY village, id`).all(...liveArgs).map(r => ({ ...r, key: `no_phone:${r.id}` }));
    const amount_outliers = db.prepare(
      `SELECT id, payment_no, category, amount_cents, occurred_at, note
         FROM payments WHERE status = 'active' AND amount_cents > ?
         ORDER BY amount_cents DESC`).all(OUTLIER_CENTS)
      .map(r => ({ ...r, key: `payment_outlier:${r.id}` }));

    const dismissed = readDismissed();
    res.json({
      ok: true,
      data: {
        generated_at: new Date().toISOString(),
        county, // P10-R1：本次体检的市县过滤口径（null=全部）
        dismissed_count: dismissed.length,
        suspect_dupes: filterDismissed(suspect_dupes, dismissed),
        village_variants: filterDismissed(village_variants, dismissed),
        region_missing: filterDismissed(region_missing, dismissed),
        no_phone: filterDismissed(no_phone, dismissed),
        amount_outliers: filterDismissed(amount_outliers, dismissed)
      }
    });
  });

  router.post('/data-health/dismiss', (req, res) => {
    const key = req.body && req.body.key;
    if (!key || typeof key !== 'string') throw new ApiError('VALIDATION', 'key 必填（问题项 key）');
    const dismissed = readDismissed();
    if (!dismissed.includes(key)) dismissed.push(key);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run('datahealth.dismissed', JSON.stringify(dismissed), now);
    logEdit(db, { table: 'settings', recordId: 0, action: 'update',
      after: { key: 'datahealth.dismissed', dismiss: key, total: dismissed.length } });
    res.json({ ok: true, data: { key, dismissed } });
  });

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
      `SELECT id, type, name, phone, county, village, team, default_price_cents, default_area_mu, notes
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
    /* P5-M1 单价口径修复(HANDOFF-P5-PLAN §5.1):
       ÷100.0 恢复元/亩(旧式 分/亩 冒充 元/亩,出现"几千元一亩");
       kind='spray' 排除 extra 行(其 area 恒 NULL,防未来污染);
       COALESCE 优先回填后的精确单价,无则 spray_fee/area 派生;
       ORDER BY l2.id 使 LIMIT 1 确定性(防御)。 */
    const lastJobs = db.prepare(
      `SELECT l.farmer_ref, l.farmer_name, j.job_date, j.plant_type_name,
              (SELECT COALESCE(l2.unit_price_cents, l2.spray_fee_cents / l2.area_mu) / 100.0
                 FROM job_settlement_lines l2
                WHERE l2.job_id = j.id AND l2.kind = 'spray' AND l2.area_mu > 0
                ORDER BY l2.id LIMIT 1) AS price_yuan
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
