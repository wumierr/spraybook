/* ============================================================
   routes/ledger.js — 记账后台 API（M4 结算/账单 + M5 收支预支/分录）
   ============================================================ */
'use strict';

const express = require('express');
const settlements = require('../services/settlements');
const finance = require('../services/finance');
const journal = require('../services/journal');
const reports = require('../services/reports');
const overview = require('../services/overview');
const exportExcel = require('../services/exportExcel');
const { ApiError } = require('../services/apiError');

function createLedgerRouter(db) {
  const router = express.Router();

  /* ---------- 结算（M4） ---------- */
  router.post('/settlements', (req, res) => {
    const data = settlements.createSettlement(db, Number(req.body.job_id), { party_id: req.body.party_id });
    res.json({ ok: true, data });
  });
  router.get('/settlements', (req, res) => {
    const data = settlements.listSettlements(db, {
      status: req.query.status, job_id: req.query.job_id ? Number(req.query.job_id) : undefined
    });
    if ((data || []).length >= 500) res.set('X-Has-More', '1'); // B0.3/N-10：截断可感知
    res.json({ ok: true, data });
  });
  router.get('/settlements/:id', (req, res) => {
    res.json({ ok: true, data: settlements.settlementWithDetails(db, Number(req.params.id)) });
  });
  router.patch('/settlements/:id', (req, res) => {
    const data = settlements.updateItems(db, Number(req.params.id), req.body.items);
    res.json({ ok: true, data });
  });
  router.post('/settlements/:id/confirm', (req, res) => {
    res.json({ ok: true, data: settlements.confirmSettlement(db, Number(req.params.id)) });
  });
  router.post('/settlements/:id/reopen', (req, res) => {
    res.json({ ok: true, data: settlements.reopenSettlement(db, Number(req.params.id)) });
  });
  router.post('/settlements/:id/void', (req, res) => {
    res.json({ ok: true, data: settlements.voidSettlement(db, Number(req.params.id)) });
  });

  /* ---------- 账单（M4） ---------- */
  router.get('/bills', (req, res) => {
    const rows = settlements.listBills(db, {
      status: req.query.status, party_id: req.query.party_id ? Number(req.query.party_id) : undefined
    });
    if (rows.length >= 500) res.set('X-Has-More', '1'); // B0.3/N-10：截断可感知
    res.json({ ok: true, data: rows });
  });
  router.patch('/bills/:id', (req, res) => {
    res.json({ ok: true, data: settlements.patchBill(db, Number(req.params.id), req.body) });
  });

  /* ---------- 收款/支出/预收预支/分成（M5） ---------- */
  router.post('/receipts', (req, res) => {
    res.json({ ok: true, data: finance.createReceipt(db, req.body) });
  });
  router.get('/receipts', (req, res) => { // B0.3/N-10：500 条截断上限可感知
    const rows = finance.listReceipts(db);
    if (rows.length >= 500) res.set('X-Has-More', '1');
    res.json({ ok: true, data: rows });
  });
  router.patch('/receipts/:id', (req, res) => {
    res.json({ ok: true, data: finance.updateReceipt(db, Number(req.params.id), req.body) });
  });
  router.post('/payments', (req, res) => {
    res.json({ ok: true, data: finance.createPayment(db, req.body) });
  });
  router.get('/payments', (req, res) => {
    const rows = finance.listPayments(db);
    if (rows.length >= 500) res.set('X-Has-More', '1');
    res.json({ ok: true, data: rows });
  });
  router.patch('/payments/:id', (req, res) => {
    res.json({ ok: true, data: finance.updatePayment(db, Number(req.params.id), req.body) });
  });
  router.patch('/advances/:id', (req, res) => {
    res.json({ ok: true, data: finance.updateAdvanceNote(db, Number(req.params.id), req.body) });
  });
  router.post('/advances', (req, res) => {
    res.json({ ok: true, data: finance.createAdvance(db, req.body) });
  });
  router.get('/advances', (req, res) => {
    const rows = finance.listAdvances(db);
    if (rows.length >= 500) res.set('X-Has-More', '1');
    res.json({ ok: true, data: rows });
  });
  router.post('/advances/:id/settle', (req, res) => {
    res.json({ ok: true, data: finance.settleAdvance(db, Number(req.params.id), req.body) });
  });
  router.post('/splits', (req, res) => {
    res.json({ ok: true, data: finance.createSplit(db, req.body) });
  });
  router.get('/splits', (req, res) => {
    const rows = finance.listSplits(db);
    if (rows.length >= 500) res.set('X-Has-More', '1');
    res.json({ ok: true, data: rows });
  });

  router.post('/:table/:id/void', (req, res) => {
    const data = finance.voidFinanceRecord(db, req.params.table, Number(req.params.id));
    res.json({ ok: true, data });
  });

  // C3 用药史（零新表派生）：?party_id= 客户档案用药史 / ?bill_id= 账单所属作业用药明细。
  // 行=job_settlement_lines JOIN jobs（药型=plant_type_name；单价=spray_fee/area 派生）。
  router.get('/usage-history', (req, res) => {
    const partyId = Number(req.query.party_id) || 0;
    const billId = Number(req.query.bill_id) || 0;
    if (!partyId && !billId) throw new ApiError('VALIDATION', 'party_id 或 bill_id 必填');
    const cond = partyId
      ? 'l.farmer_name = (SELECT name FROM parties WHERE id = ?)'
      : 'j.id = (SELECT s.job_id FROM settlements s JOIN bills b ON b.settlement_id = s.id WHERE b.id = ?)';
    const rows = db.prepare(
      `SELECT j.job_no, j.job_date, j.plant_type_name AS drug, l.farmer_name,
              l.area_mu, l.used_sets, l.self_sets, l.supplement_sets,
              l.pesticide_fee_cents, l.included,
              CASE WHEN l.area_mu > 0 THEN ROUND(l.spray_fee_cents * 1.0 / l.area_mu / 100.0, 2) END AS unit_price_yuan
       FROM job_settlement_lines l JOIN jobs j ON j.id = l.job_id
       WHERE j.deleted_at IS NULL AND j.status != 'void' AND ${cond}
       ORDER BY j.job_date DESC, j.id DESC LIMIT 100`).all(partyId || billId);
    res.json({ ok: true, data: rows });
  });

  /* ---------- 主数据只读（下拉用） ---------- */
  router.get('/parties', (req, res) => {
    const data = db.prepare(
      `SELECT id, type, name, phone, county, region, village, team, default_price_cents FROM parties
       WHERE deleted_at IS NULL AND enabled = 1 ORDER BY type, name`).all();
    res.json({ ok: true, data });
  });

  /* ---------- 总表（P4-M1）：作业粒度聚合只读视图 ---------- */
  router.get('/overview', (req, res) => {
    const data = overview.listOverview(db, {
      from: req.query.from, to: req.query.to, status: req.query.status,
      county: req.query.county,
      limit: req.query.limit ? Number(req.query.limit) : undefined
    });
    // E9（P7-R4）：静默截断改为可感知——行数打到上限时置响应头，前端 toast 提示
    if ((data.rows || []).length >= 2000) res.set('X-Has-More', '1');
    res.json({ ok: true, data });
  });

  /* ---------- 报表（M6） ---------- */
  router.get('/reports/summary', (req, res) => {
    res.json({ ok: true, data: reports.summary(db, { from: req.query.from, to: req.query.to }) });
  });
  // B2：账龄分桶（未清账单按 issued_at 0-30/31-60/61-90/90+；as_of 可注入回看口径）
  router.get('/reports/aging', (req, res) => {
    res.json({ ok: true, data: reports.aging(db, { as_of: req.query.as_of || undefined }) });
  });
  // C2：月度表 U5 版式 1:1 导出（xlsx 真值单元格，无 CSV 公式注入面；可再被 parseWorkbook 读回）
  router.get('/export/monthly', async (req, res, next) => {
    try {
      const from = req.query.from || undefined, to = req.query.to || undefined;
      const jobs = overview.listOverview(db, { from, to }).rows;
      const pays = finance.listPayments(db);
      const wb = await exportExcel.buildMonthlyWorkbook(jobs, pays);
      const buf = await wb.xlsx.writeBuffer();
      // 文件名走 ASCII（HTTP 头禁非 ASCII）
      const stamp = new Date().toISOString().slice(0, 10);
      const name = `spraybook-${from || 'all'}_${to || 'now'}_${stamp}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      res.end(buf);
    } catch (err) { next(err); }
  });
  router.get('/reports/by-month', (req, res) => {
    res.json({ ok: true, data: reports.byMonth(db, { from: req.query.from, to: req.query.to }) });
  });
  router.get('/reports/by-customer', (req, res) => {
    res.json({ ok: true, data: reports.byCustomer(db, {
      from: req.query.from, to: req.query.to, include_all: req.query.include_all,
      county: req.query.county
    }) });
  });
  router.get('/reports/by-job', (req, res) => {
    res.json({ ok: true, data: reports.byJob(db, { from: req.query.from, to: req.query.to }) });
  });

  /* ---------- 报表时间分组（P4-M2：月/周/季/年四粒度） ---------- */
  router.get('/reports/by-period', (req, res) => {
    res.json({ ok: true, data: reports.byPeriod(db, {
      granularity: req.query.granularity, from: req.query.from, to: req.query.to,
      county: req.query.county
    }) });
  });
  router.get('/reports/adjustments', (req, res) => {
    res.json({ ok: true, data: reports.adjustments(db, {
      granularity: req.query.granularity, from: req.query.from, to: req.query.to,
      county: req.query.county
    }) });
  });
  router.get('/reports/cost-breakdown', (req, res) => {
    res.json({ ok: true, data: reports.costBreakdown(db, {
      source: req.query.source, from: req.query.from, to: req.query.to,
      county: req.query.county
    }) });
  });

  /* ---------- 报表区间聚合（P5-M2：总表数据条 + C11/C12） ---------- */
  router.get('/reports/by-range', (req, res) => {
    res.json({ ok: true, data: reports.byRange(db, { from: req.query.from, to: req.query.to, county: req.query.county }) });
  });
  router.get('/reports/by-region', (req, res) => {
    res.json({ ok: true, data: reports.byRegion(db, {
      level: req.query.level, from: req.query.from, to: req.query.to,
      county: req.query.county
    }) });
  });
  router.get('/reports/by-operator', (req, res) => {
    res.json({ ok: true, data: reports.byOperator(db, { from: req.query.from, to: req.query.to, county: req.query.county }) });
  });
  router.get('/parties/:id/balance', (req, res) => {
    res.json({ ok: true, data: reports.partyBalance(db, Number(req.params.id)) });
  });

  /* ---------- 复式记账查询 ---------- */
  router.get('/journal', (req, res) => {
    const rows = journal.getJournal(db, {
      from: req.query.from, to: req.query.to,
      ref_type: req.query.ref_type, ref_id: req.query.ref_id ? Number(req.query.ref_id) : undefined
    });
    if (rows.length >= 500) res.set('X-Has-More', '1'); // E9：500 条截断上限可感知
    res.json({ ok: true, data: rows });
  });

  return router;
}

module.exports = { createLedgerRouter };
