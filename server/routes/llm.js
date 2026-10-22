/* ============================================================
   routes/llm.js — P8 LLM 导入端点
   GET  /api/llm/status → 前端按钮置灰依据（Ollama 连通性/模型/版本）
   POST /api/llm/parse  {text, filename?, default_date?} → 校验→staging「待入库」→ 复核视图
        （P9-R3：default_date 可选 YYYY-MM-DD，无日期条目按它记且进需复核；
         长文本服务端自动分块，>500 行拒绝）
   ============================================================ */
'use strict';

const express = require('express');
const { ApiError } = require('../services/apiError');
const { logEdit } = require('../services/audit');
const ollama = require('../services/ollamaClient');
const { parseTextToBatch } = require('../services/llmImport');
const { reviewBatch, reviewHealth, dismissFinding } = require('../services/llmReview');

function createLlmRouter(db) {
  const router = express.Router();

  router.get('/llm/status', async (req, res, next) => {
    try {
      const ready = await ollama.check(db);
      res.json({ ok: true, data: {
        ollama_ok: ready.ok,
        error: ready.error || null,
        hint: ready.hint || null,
        model: ollama.ollamaModel(db),
        prompt_version: ollama.PROMPT_VERSION
      } });
    } catch (err) { next(err); }
  });

  router.post('/llm/parse', async (req, res, next) => {
    try {
      const { text, filename, default_date } = req.body || {};
      const data = await parseTextToBatch(db, { text, filename, defaultDate: default_date });
      res.json({ ok: true, data });
    } catch (err) { next(err); }
  });

  /* 取消整个批次（三按钮之"取消"；零迁移：rejected 状态已在 CHECK 枚举内） */
  router.post('/llm/batches/:id/cancel', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const b = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(id);
      if (!b) throw new ApiError('NOT_FOUND', `批次不存在: ${id}`, 404);
      if (b.status === 'applied') throw new ApiError('INVALID_STATE', '批次已落库，请走逐笔作废');
      const now = new Date().toISOString();
      const tx = db.transaction(() => {
        db.prepare("UPDATE raw_import_rows SET status='rejected', updated_at=? WHERE batch_id=? AND status IN ('pending','confirmed')").run(now, id);
        db.prepare("UPDATE import_batches SET status='rejected' WHERE id=?").run(id);
        logEdit(db, { table: 'import_batches', recordId: id, action: 'update',
          before: { status: b.status }, after: { status: 'rejected', by: 'llm-cancel' } });
      });
      tx();
      res.json({ ok: true, data: { batch_id: id, status: 'rejected' } });
    } catch (err) { next(err); }
  });

  /* ---- P10-R5：LLM 数据审查（D3 裁决：只挑错、人采纳，绝不改数据） ----
     POST /api/llm/review/batches/:id → findings append 进行级复核（needs_review）
     POST /api/llm/review/health     → 全库体检 findings（ephemeral，不落库）
     POST /api/llm/review/health/dismiss → 忽略登记（settings 键 llmreview.dismissed） */
  router.post('/llm/review/batches/:id', async (req, res, next) => {
    try {
      const data = await reviewBatch(db, Number(req.params.id));
      res.json({ ok: true, data });
    } catch (err) { next(err); }
  });

  router.post('/llm/review/health', async (req, res, next) => {
    try {
      const data = await reviewHealth(db);
      res.json({ ok: true, data });
    } catch (err) { next(err); }
  });

  router.post('/llm/review/health/dismiss', (req, res) => {
    res.json({ ok: true, data: dismissFinding(db, req.body && req.body.key) });
  });

  return router;
}

module.exports = { createLlmRouter };
