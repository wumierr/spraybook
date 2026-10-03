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
    res.json({ ok: true, data: settlements.listBills(db, {
      status: req.query.status, party_id: req.query.party_id ? Number(req.query.party_id) : undefined
    }) });
  });
  router.patch('/bills/:id', (req, res) => {
    res.json({ ok: true, data: settlements.patchBill(db, Number(req.params.id), req.body) });
  });

  /* ---------- 收款/支出/预收预支/分成（M5） ---------- */
  router.post('/receipts', (req, res) => {
    res.json({ ok: true, data: finance.createReceipt(db, req.body) });
  });
  router.get('/receipts', (req, res) => res.json({ ok: true, data: finance.listReceipts(db) }));
  router.patch('/receipts/:id', (req, res) => {
    res.json({ ok: true, data: finance.updateReceipt(db, Number(req.params.id), req.body) });
  });
  router.post('/payments', (req, res) => {
    res.json({ ok: true, data: finance.createPayment(db, req.body) });
  });
  router.get('/payments', (req, res) => res.json({ ok: true, data: finance.listPayments(db) }));
  router.patch('/payments/:id', (req, res) => {
    res.json({ ok: true, data: finance.updatePayment(db, Number(req.params.id), req.body) });
  });
  router.patch('/advances/:id', (req, res) => {
    res.json({ ok: true, data: finance.updateAdvanceNote(db, Number(req.params.id), req.body) });
  });
  router.post('/advances', (req, res) => {
    res.json({ ok: true, data: finance.createAdvance(db, req.body) });
  });
  router.get('/advances', (req, res) => res.json({ ok: true, data: finance.listAdvances(db) }));
  router.post('/advances/:id/settle', (req, res) => {
    res.json({ ok: true, data: finance.settleAdvance(db, Number(req.params.id), req.body) });
  });
  router.post('/splits', (req, res) => {
    res.json({ ok: true, data: finance.createSplit(db, req.body) });
  });
  router.get('/splits', (req, res) => res.json({ ok: true, data: finance.listSplits(db) }));

  router.post('/:table/:id/void', (req, res) => {
    const data = finance.voidFinanceRecord(db, req.params.table, Number(req.params.id));
    res.json({ ok: true, data });
  });

  /* ---------- 主数据只读（下拉用） ---------- */
  router.get('/parties', (req, res) => {
    const data = db.prepare(
      `SELECT id, type, name, phone, region, village, team, default_price_cents FROM parties
       WHERE deleted_at IS NULL AND enabled = 1 ORDER BY type, name`).all();
    res.json({ ok: true, data });
  });

  /* ---------- 总表（P4-M1）：作业粒度聚合只读视图 ---------- */
  router.get('/overview', (req, res) => {
    res.json({ ok: true, data: overview.listOverview(db, {
      from: req.query.from, to: req.query.to, status: req.query.status,
      limit: req.query.limit ? Number(req.query.limit) : undefined
    }) });
  });

  /* ---------- 报表（M6） ---------- */
  router.get('/reports/summary', (req, res) => {
    res.json({ ok: true, data: reports.summary(db, { from: req.query.from, to: req.query.to }) });
  });
  router.get('/reports/by-month', (req, res) => {
    res.json({ ok: true, data: reports.byMonth(db, { from: req.query.from, to: req.query.to }) });
  });
  router.get('/reports/by-customer', (req, res) => {
    res.json({ ok: true, data: reports.byCustomer(db, {
      from: req.query.from, to: req.query.to, include_all: req.query.include_all
    }) });
  });
  router.get('/reports/by-job', (req, res) => {
    res.json({ ok: true, data: reports.byJob(db, { from: req.query.from, to: req.query.to }) });
  });

  /* ---------- 报表时间分组（P4-M2：月/周/季/年四粒度） ---------- */
  router.get('/reports/by-period', (req, res) => {
    res.json({ ok: true, data: reports.byPeriod(db, {
      granularity: req.query.granularity, from: req.query.from, to: req.query.to
    }) });
  });
  router.get('/reports/adjustments', (req, res) => {
    res.json({ ok: true, data: reports.adjustments(db, {
      granularity: req.query.granularity, from: req.query.from, to: req.query.to
    }) });
  });
  router.get('/reports/cost-breakdown', (req, res) => {
    res.json({ ok: true, data: reports.costBreakdown(db, {
      source: req.query.source, from: req.query.from, to: req.query.to
    }) });
  });

  /* ---------- 报表区间聚合（P5-M2：总表数据条 + C11/C12） ---------- */
  router.get('/reports/by-range', (req, res) => {
    res.json({ ok: true, data: reports.byRange(db, { from: req.query.from, to: req.query.to }) });
  });
  router.get('/reports/by-region', (req, res) => {
    res.json({ ok: true, data: reports.byRegion(db, {
      level: req.query.level, from: req.query.from, to: req.query.to
    }) });
  });
  router.get('/reports/by-operator', (req, res) => {
    res.json({ ok: true, data: reports.byOperator(db, { from: req.query.from, to: req.query.to }) });
  });
  router.get('/parties/:id/balance', (req, res) => {
    res.json({ ok: true, data: reports.partyBalance(db, Number(req.params.id)) });
  });

  /* ---------- 复式记账查询 ---------- */
  router.get('/journal', (req, res) => {
    res.json({ ok: true, data: journal.getJournal(db, {
      from: req.query.from, to: req.query.to,
      ref_type: req.query.ref_type, ref_id: req.query.ref_id ? Number(req.query.ref_id) : undefined
    }) });
  });

  return router;
}

module.exports = { createLedgerRouter };
