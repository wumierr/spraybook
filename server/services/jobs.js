/* ============================================================
   services/jobs.js — 作业执行层服务（计算器只写，记账只读）
   POST：幂等（client_job_id）+ job_no 冲突重生成 + 事务写主表与 4 张子表
   PATCH：仅金额/备注白名单（编辑权界），物理量只读
   建表依据：docs/export-json-sample.json
   ============================================================ */
'use strict';

const { ApiError } = require('./apiError');
const { yuanToCents } = require('./numbers');
const { generateJobNo, logEdit } = require('./audit');
const { upsertCustomersFromCalculator } = require('./parties');

const PHYSICAL_FIELDS = new Set([
  'total_area_mu', 'actual_sets', 'used_sets', 'pesticide_rounded_sets', 'need_to_buy_sets',
  'total_water_l', 'total_add_water_l', 'total_trips', 'mix_batches', 'total_flight_min',
  'total_minutes', 'charge_count', 'weight_jin', 'drone_tank_l', 'spare_water_l', 'draw_reserve_l'
]);

function assertSafeDate(v, field) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) {
    throw new ApiError('VALIDATION', `${field} 必须是 ISO8601 日期（YYYY-MM-DD）`);
  }
}

function farmerNameOf(snapshot, farmerId) {
  const f = (snapshot.farmers || []).find(x => x.id === farmerId);
  return f ? f.name : '未知农户';
}

/** 聚合作业电池循环：按 timing.batteryCycles[].battery 计数 */
function batteryCyclesOf(result) {
  const counts = new Map();
  for (const c of (result.timing && result.timing.batteryCycles) || []) {
    const key = c.battery != null ? String(c.battery) : '默认';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([battery_name, count]) => ({ battery_name, count }));
}

/** 作业人工成本：spray 用 labor；haul 拆成 droneLabor+pickupLabor 两键 */
function laborOf(cb) {
  if (cb.labor != null) return cb.labor;
  return Number(cb.droneLabor || 0) + Number(cb.pickupLabor || 0);
}

/** 计算器上报 payload → jobs 行字段（金额元→分） */
function jobRowFromPayload(body) {
  const s = body.snapshot || {};
  const r = body.result || {};
  const cb = r.costBreakdown || null;
  const now = new Date().toISOString();
  const haulIncomePricePerJin = s.haulIncome && s.haulIncome.pricePerJin != null
    ? Math.round(Number(s.haulIncome.pricePerJin) * 10) // 毛/斤 → 分/斤
    : null;
  return {
    job_no: body.job_no || null,
    client_job_id: body.client_job_id,
    job_type: body.job_type,
    status: 'completed',
    job_date: body.job_date,
    address: body.address || null,
    note: body.note || null,
    operator_names: JSON.stringify(body.operator_names || []),
    source: 'calculator',
    // 打药快照
    plant_type_key: s.plant ? s.plant.key : null,
    plant_type_name: s.plant ? s.plant.name : null,
    total_area_mu: r.area != null ? r.area : null,
    drone_tank_l: r.droneTank != null ? r.droneTank : (s.field ? s.field.droneTank : null),
    spare_water_l: r.spareWater != null ? r.spareWater : (s.field ? s.field.spareWater : null),
    draw_reserve_l: s.field ? s.field.drawReserve : null,
    manual_dose_per_mu: s.field ? s.field.manualDosePerMu : null,
    existing_sets: r.existingSets != null ? r.existingSets : null,
    actual_sets: s.workOrder ? s.workOrder.actualSets : null,
    used_sets: r.usedSets != null ? r.usedSets : null,
    pesticide_rounded_sets: r.pesticideRounded != null ? r.pesticideRounded : null,
    need_to_buy_sets: r.needToBuy != null ? r.needToBuy : null,
    pesticide_price_cents: s.costs ? yuanToCents(s.costs.pesticidePrice, 'costs.pesticidePrice') : null,
    pesticide_included: r.pesticideIncluded === true ? 1 : 0,
    total_water_l: r.water != null ? r.water : null,
    total_add_water_l: r.totalAddWater != null ? r.totalAddWater : null,
    total_trips: r.totalTrips != null ? r.totalTrips : null,
    mix_batches: r.timing && r.timing.mixRounds != null ? r.timing.mixRounds : null,
    total_flight_min: r.totalFlightMin != null ? r.totalFlightMin : null,
    total_minutes: r.timing && r.timing.totalTime != null ? r.timing.totalTime : null,
    charge_count: r.cycles != null ? r.cycles : null,
    charge_source: r.chargeSource || null,
    fuel_expense_cents: s.costs ? yuanToCents(s.costs.fuelExpense, 'costs.fuelExpense') : null,
    battery_depreciation_cents: s.costs ? yuanToCents(s.costs.batteryDepreciation, 'costs.batteryDepreciation') : null,
    // 成本构成快照（007）：total_cost 的拆分，仅分析用，总额列不动。
    // spray 构成 = {labor,pesticide,equipment,other}；haul = {droneLabor,pickupLabor,equipment,other}
    labor_cost_cents: cb ? yuanToCents(laborOf(cb), 'costBreakdown.labor') : null,
    pesticide_cost_cents: cb && cb.pesticide != null ? yuanToCents(cb.pesticide, 'costBreakdown.pesticide') : null,
    equipment_cost_cents: cb && cb.equipment != null ? yuanToCents(cb.equipment, 'costBreakdown.equipment') : null,
    misc_cost_cents: cb && cb.other != null ? yuanToCents(cb.other, 'costBreakdown.other') : null,
    subsidy_cents: s.income && s.income.subsidy != null ? yuanToCents(s.income.subsidy, 'income.subsidy') : null,
    total_cost_cents: yuanToCents(r.totalCost, 'result.totalCost'),
    income_cents: yuanToCents(r.income, 'result.income'),
    profit_cents: yuanToCents(r.profit, 'result.profit'),
    // 吊运快照
    weight_jin: r.totalWeight != null ? r.totalWeight : null,
    haul_price_cents_per_jin: body.job_type === 'haul' ? haulIncomePricePerJin : null,
    pickup_included: r.pickupIncluded === true ? 1 : 0,
    raw_json: JSON.stringify({ snapshot: s, result: r }),
    created_at: now,
    updated_at: now
  };
}

const JOB_COLS = Object.keys({
  job_no: 1, client_job_id: 1, job_type: 1, status: 1, job_date: 1, address: 1, note: 1,
  operator_names: 1, source: 1, plant_type_key: 1, plant_type_name: 1, total_area_mu: 1,
  drone_tank_l: 1, spare_water_l: 1, draw_reserve_l: 1, manual_dose_per_mu: 1, existing_sets: 1,
  actual_sets: 1, used_sets: 1, pesticide_rounded_sets: 1, need_to_buy_sets: 1,
  pesticide_price_cents: 1, pesticide_included: 1, total_water_l: 1, total_add_water_l: 1,
  total_trips: 1, mix_batches: 1, total_flight_min: 1, total_minutes: 1, charge_count: 1,
  charge_source: 1, fuel_expense_cents: 1, battery_depreciation_cents: 1, total_cost_cents: 1,
  labor_cost_cents: 1, pesticide_cost_cents: 1, equipment_cost_cents: 1, misc_cost_cents: 1,
  subsidy_cents: 1,
  income_cents: 1, profit_cents: 1, weight_jin: 1, haul_price_cents_per_jin: 1,
  pickup_included: 1, raw_json: 1, created_at: 1, updated_at: 1
});

function insertJob(db, row) {
  const cols = JOB_COLS.join(',');
  const marks = JOB_COLS.map(() => '?').join(',');
  const info = db.prepare(`INSERT INTO jobs (${cols}) VALUES (${marks})`)
    .run(...JOB_COLS.map(c => row[c]));
  return info.lastInsertRowid;
}

function insertSubtables(db, jobId, body) {
  const s = body.snapshot || {};
  const r = body.result || {};

  if (body.job_type === 'spray') {
    const completedByPlot = (s.workOrder && s.workOrder.completedByPlot) || {};
    // 地块档案关联（007）：按名匹配主数据 plots，匹配不到留空不强建
    const plotIdByName = new Map();
    for (const p of db.prepare('SELECT id, name FROM plots WHERE deleted_at IS NULL ORDER BY id').all()) {
      if (!plotIdByName.has(p.name)) plotIdByName.set(p.name, p.id);
    }
    const insPlot = db.prepare(
      `INSERT INTO job_plots (job_id, seq, plot_name, plot_id, area_mu, farmer_ref, farmer_name, group_no,
         water_l, flight_min, pesticide_sets, pesticide_rounded, completed_l, trips_override)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    (r.plots || []).forEach((p, i) => {
      insPlot.run(jobId, i, p.name || `地块${i + 1}`, plotIdByName.get(p.name) ?? null,
        p.area ?? null, p.farmerId || null,
        farmerNameOf(s, p.farmerId), p.groupId ?? null, p.water ?? null, p.flightMin ?? null,
        p.pesticideRaw ?? null, p.pesticideRounded ?? null,
        completedByPlot[p.id] ?? null, p.tripsOverride ?? null);
    });

    const insGroup = db.prepare(
      `INSERT INTO flight_groups (job_id, group_no, water_l, min_trips, trips, trips_override, per_trip_water_l, per_trip_time_min)
       VALUES (?,?,?,?,?,?,?,?)`);
    (r.groups || []).forEach(g => {
      insGroup.run(jobId, g.id ?? null, g.water ?? null, g.minTrips ?? null, g.trips ?? null,
        g.tripsOverride ?? null, g.perTripWater ?? null, g.perTripTime ?? null);
    });

    // P6-M2(F7)：计算器路径把每亩单价落到主结算行（此前只有导入路径有单价，总表单价列对计算器单恒空）
    const unitPriceCents = (s.income && s.income.pricePerMu != null)
      ? yuanToCents(s.income.pricePerMu, 'income.pricePerMu') : null;
    // B7（P7-R1）：分户金额守恒对齐。计算器前端的最大余数法在"元·3位小数"粒度守恒，
    // 逐行元→分四舍五入后 Σ明细可能比 income 差 1 分（实测 27.775/66.66/83.325 例）。
    // 差额吸收到金额最大的行（ spray 优先，不足再 pesticide），保证 Σ明细 = income_cents。
    const lineCents = (r.settlement || []).map(st => ({
      st,
      spray: yuanToCents(st.sprayFee, 'settlement.sprayFee') ?? 0,
      pesticide: yuanToCents(st.pesticideFee, 'settlement.pesticideFee') ?? 0
    }));
    const incomeCents = r.income != null ? Math.round(Number(r.income) * 100) : null;
    if (incomeCents != null && lineCents.length) {
      let diff = incomeCents - lineCents.reduce((a, x) => a + x.spray + x.pesticide, 0);
      if (diff !== 0) {
        const biggest = [...lineCents].sort((x, y) => (y.spray + y.pesticide) - (x.spray + x.pesticide))[0];
        if (diff > 0 || biggest.spray + biggest.pesticide + diff >= 0) {
          if (biggest.spray + diff >= 0) biggest.spray += diff;
          else biggest.pesticide += diff;
        }
      }
    }
    const insLine = db.prepare(
      `INSERT INTO job_settlement_lines (job_id, farmer_ref, farmer_name, area_mu, spray_fee_cents,
         used_sets, self_sets, supplement_sets, pesticide_fee_cents, included, unit_price_cents)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const x of lineCents) {
      const st = x.st;
      insLine.run(jobId, st.farmerId || null, st.farmerName || '未知农户', st.area ?? null,
        x.spray, st.usedSets ?? null,
        st.selfSets ?? null, st.supplementSets ?? null,
        x.pesticide,
        st.included === true ? 1 : 0,
        unitPriceCents);
    }
  }

  const insBattery = db.prepare(
    `INSERT INTO job_battery_cycles (job_id, battery_name, count) VALUES (?,?,?)`);
  for (const b of batteryCyclesOf(r)) insBattery.run(jobId, b.battery_name, b.count);
}

/** POST /api/jobs —— 幂等 + 事务写入 */
function createJob(db, body) {
  if (!body || typeof body !== 'object') throw new ApiError('VALIDATION', '请求体必须是 JSON 对象');
  const { client_job_id, job_type, job_date } = body;
  if (!client_job_id || typeof client_job_id !== 'string') {
    throw new ApiError('VALIDATION', 'client_job_id 必填（uuid）');
  }
  if (!['spray', 'haul'].includes(job_type)) {
    throw new ApiError('VALIDATION', 'job_type 必须是 spray 或 haul');
  }
  assertSafeDate(job_date, 'job_date');
  if (!body.snapshot || !body.result) {
    throw new ApiError('VALIDATION', 'snapshot 与 result 必填（见 docs/export-json-sample.json）');
  }

  // 幂等：同 client_job_id 返回原单，不覆盖不重建
  const existing = db.prepare('SELECT id, job_no FROM jobs WHERE client_job_id = ?').get(client_job_id);
  if (existing) {
    return { id: existing.id, job_no: existing.job_no, duplicated: true };
  }

  let jobNo = body.job_no || null;
  if (jobNo) {
    if (db.prepare('SELECT 1 FROM jobs WHERE job_no = ?').get(jobNo)) {
      jobNo = generateJobNo(job_date); // 冲突 → 服务端重生成，响应回传最终号
    }
  } else {
    jobNo = generateJobNo(job_date);
  }

  const tx = db.transaction(() => {
    const { created } = upsertCustomersFromCalculator(db, body.snapshot.farmers);
    let id;
    for (;;) {
      try {
        id = insertJob(db, { ...jobRowFromPayload(body), job_no: jobNo });
        break;
      } catch (e) {
        if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE' && /job_no/.test(String(e.message))) {
          jobNo = generateJobNo(job_date); // 事务内再撞号则重生成后整体重试
          continue;
        }
        throw e;
      }
    }
    insertSubtables(db, id, body);
    logEdit(db, {
      table: 'jobs', recordId: id, action: 'create', before: null,
      after: { job_no: jobNo, client_job_id, job_type, job_date, parties_created: created }
    });
    return id;
  });
  const id = tx();
  return { id, job_no: jobNo, duplicated: false };
}

/** GET /api/jobs?status=&date=&from=&to= */
function listJobs(db, { status, date, from, to }) {
  const where = ['deleted_at IS NULL'];
  const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (date) { where.push('job_date = ?'); args.push(date); }
  if (from) { where.push('job_date >= ?'); args.push(from); }
  if (to) { where.push('job_date <= ?'); args.push(to); }
  const rows = db.prepare(
    `SELECT id, job_no, client_job_id, job_type, status, job_date, address, note,
            total_area_mu, total_trips, total_cost_cents, income_cents, profit_cents,
            weight_jin, created_at,
            (SELECT COUNT(*) FROM job_settlement_lines l WHERE l.job_id = jobs.id) AS settlement_lines
     FROM jobs WHERE ${where.join(' AND ')} ORDER BY job_date DESC, id DESC`
  ).all(...args);
  return rows;
}

/** GET /api/jobs/:id —— 详情含子表 + raw_json */
function getJob(db, id) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!job) throw new ApiError('NOT_FOUND', `作业不存在: ${id}`, 404);
  job.operator_names = JSON.parse(job.operator_names || '[]');
  job.plots = db.prepare('SELECT * FROM job_plots WHERE job_id = ? ORDER BY seq').all(id);
  job.groups = db.prepare('SELECT * FROM flight_groups WHERE job_id = ? ORDER BY group_no').all(id);
  job.settlement_lines = db.prepare('SELECT * FROM job_settlement_lines WHERE job_id = ?').all(id);
  job.battery_cycles = db.prepare('SELECT * FROM job_battery_cycles WHERE job_id = ?').all(id);
  try { job.raw = JSON.parse(job.raw_json); } catch (e) { job.raw = null; }
  delete job.raw_json;
  return job;
}

/** PATCH /api/jobs/:id —— 编辑权界：仅金额/备注；物理量拒绝；状态机拒绝 */
function patchJob(db, id, body) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!job) throw new ApiError('NOT_FOUND', `作业不存在: ${id}`, 404);
  if (job.status === 'settled' || job.status === 'void') {
    throw new ApiError('INVALID_STATE', `作业状态 ${job.status} 不可编辑（先撤回确认或作废）`);
  }
  if (!body || typeof body !== 'object') throw new ApiError('VALIDATION', '请求体必须是 JSON 对象');

  // 物理量字段一律拒绝（ledger 不可改执行数据；改错=计算器重传新单）
  for (const key of Object.keys(body)) {
    if (PHYSICAL_FIELDS.has(key)) {
      throw new ApiError('PHYSICAL_FIELD_READONLY',
        `${key} 是物理量字段不可在此修改：请在计算器更正后重新同步（新单），本单作废`);
    }
  }

  const now = new Date().toISOString();
  const before = { note: job.note, income_cents: job.income_cents, profit_cents: job.profit_cents };

  const tx = db.transaction(() => {
    if (body.note !== undefined) {
      db.prepare('UPDATE jobs SET note = ?, updated_at = ? WHERE id = ?').run(body.note, now, id);
    }
    if (Array.isArray(body.lines)) {
      const upd = db.prepare(
        `UPDATE job_settlement_lines SET spray_fee_cents = COALESCE(?, spray_fee_cents),
           pesticide_fee_cents = COALESCE(?, pesticide_fee_cents)
         WHERE id = ? AND job_id = ?`);
      for (const line of body.lines) {
        if (!line || typeof line.id !== 'number') {
          throw new ApiError('VALIDATION', 'lines[].id 必须是数字');
        }
        if ((line.spray_fee_cents != null && line.spray_fee_cents < 0) ||
            (line.pesticide_fee_cents != null && line.pesticide_fee_cents < 0)) {
          throw new ApiError('VALIDATION', '金额不能为负');
        }
        const res = upd.run(
          line.spray_fee_cents !== undefined ? line.spray_fee_cents : null,
          line.pesticide_fee_cents !== undefined ? line.pesticide_fee_cents : null,
          line.id, id
        );
        if (res.changes === 0) throw new ApiError('NOT_FOUND', `结算行不存在: ${line.id}`, 404);
      }
      // 更正后重算合计（记账口径应收=作业钱+药钱；原始快照保留在 raw_json）
      const agg = db.prepare(
        `SELECT COALESCE(SUM(spray_fee_cents),0) AS spray, COALESCE(SUM(pesticide_fee_cents),0) AS pesticide
         FROM job_settlement_lines WHERE job_id = ?`).get(id);
      const incomeCents = agg.spray + agg.pesticide;
      db.prepare('UPDATE jobs SET income_cents = ?, profit_cents = ?, updated_at = ? WHERE id = ?')
        .run(incomeCents, incomeCents - (job.total_cost_cents || 0), now, id);
    }
    logEdit(db, {
      table: 'jobs', recordId: id, action: 'update',
      before, after: { note: body.note, lines: body.lines }, operator: 'local'
    });
  });
  tx();
  return getJob(db, id);
}

/** POST /api/jobs/:id/void —— 作废（未结算单直接 void；已结算走 settlements 层红冲） */
function voidJob(db, id) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!job) throw new ApiError('NOT_FOUND', `作业不存在: ${id}`, 404);
  if (job.status === 'settled') {
    throw new ApiError('INVALID_STATE', '已结算作业请先在结算层撤回确认（reopen）再作废');
  }
  if (job.status === 'void') return getJob(db, id);
  const tx = db.transaction(() => {
    db.prepare("UPDATE jobs SET status = 'void', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    logEdit(db, { table: 'jobs', recordId: id, action: 'void', before: { status: job.status }, after: { status: 'void' } });
  });
  tx();
  return getJob(db, id);
}

module.exports = { createJob, listJobs, getJob, patchJob, voidJob, PHYSICAL_FIELDS };
