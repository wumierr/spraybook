/* ============================================================
   routes/ledger.js — 记账后台 API（M4 结算/账单 + M5 收支预支/分录）
   ============================================================ */
'use strict';

const express = require('express');
const settlements = require('../services/settlements');
const finance = require('../services/finance');
const journal = require('../services/journal');
const reports = require('../services/reports');

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
  router.post('/payments', (req, res) => {
    res.json({ ok: true, data: finance.createPayment(db, req.body) });
  });
  router.get('/payments', (req, res) => res.json({ ok: true, data: finance.listPayments(db) }));
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
      `SELECT id, type, name, phone, village, team, default_price_cents FROM parties
       WHERE deleted_at IS NULL AND enabled = 1 ORDER BY type, name`).all();
    res.json({ ok: true, data });
  });

  /* ---------- 报表（M6） ---------- */
  router.get('/reports/summary', (req, res) => {
    res.json({ ok: true, data: reports.summary(db, { from: req.query.from, to: req.query.to }) });
  });
  router.get('/reports/by-month', (req, res) => {
    res.json({ ok: true, data: reports.byMonth(db, { from: req.query.from, to: req.query.to }) });
  });
  router.get('/reports/by-customer', (req, res) => {
    res.json({ ok: true, data: reports.byCustomer(db, { from: req.query.from, to: req.query.to }) });
  });
  router.get('/reports/by-job', (req, res) => {
    res.json({ ok: true, data: reports.byJob(db, { from: req.query.from, to: req.query.to }) });
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

  /* ---------- 汇总（P0 简版视图，M6 完善报表） ---------- */
  router.get('/summary', (req, res) => {
    const row = db.prepare(
      `SELECT
        (SELECT COALESCE(SUM(total_spray_fee_cents + total_pesticide_fee_cents),0) FROM settlements WHERE status = 'confirmed') AS settled_income_cents,
        (SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE status = 'active') AS expense_cents,
        (SELECT COALESCE(SUM(amount_cents),0) FROM receipts WHERE status = 'active') AS received_cents,
        (SELECT COALESCE(SUM(amount_cents + adjust_cents - paid_cents),0) FROM bills WHERE status IN ('unpaid','partial')) AS receivable_cents,
        (SELECT COALESCE(SUM(balance_cents),0) FROM advances WHERE direction='prepaid_by_customer' AND status != 'void') AS prepaid_cents
      `).get();
    res.json({ ok: true, data: row });
  });

  return router;
}

module.exports = { createLedgerRouter };
