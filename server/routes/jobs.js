/* ============================================================
   routes/jobs.js — /api/jobs 路由（M2）+ 结算财务挂载点（M4/M5 扩展）
   ============================================================ */
'use strict';

const express = require('express');
const jobsService = require('../services/jobs');

function createJobsRouter(db) {
  const router = express.Router();

  router.post('/jobs', (req, res) => {
    const data = jobsService.createJob(db, req.body);
    res.json({ ok: true, data });
  });

  router.get('/jobs', (req, res) => {
    const data = jobsService.listJobs(db, req.query);
    res.json({ ok: true, data });
  });

  router.get('/jobs/:id', (req, res) => {
    const data = jobsService.getJob(db, Number(req.params.id));
    res.json({ ok: true, data });
  });

  router.patch('/jobs/:id', (req, res) => {
    const data = jobsService.patchJob(db, Number(req.params.id), req.body);
    res.json({ ok: true, data });
  });

  router.post('/jobs/:id/void', (req, res) => {
    const data = jobsService.voidJob(db, Number(req.params.id));
    res.json({ ok: true, data });
  });

  return router;
}

module.exports = { createJobsRouter };
