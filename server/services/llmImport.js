/* ============================================================
   services/llmImport.js — P8-a 编排：文本 → LLM → 校验 → staging（零迁移）
   唯一入口 parseTextToBatch(db, {text, filename})，HTTP 路由与 CLI 共用：
   1. 探测 Ollama（OLLAMA_UNREACHABLE/MODEL_MISSING 原样上抛，前端置灰）
   2. generateRows（temperature 0 + json 约束 + 失败重试 1 次）
   3. llmValidate 逐行关笼（金额回原文硬门）
   4. 建批次 import_batches(source_type='llm', status='reviewing'＝UI「待入库」)
      + 逐行写 raw_import_rows（raw_text=原文对应行，parsed_json={kind,parsed,
        needs_review,llm:{confidence,prompt_version}}，status 全部 'pending'
        ——由预览确认/复核视图人工 confirm 后 apply，宁多勿少）
   5. 幂等：同文本 sha256 命中已导入批次 → DUPLICATE 拒绝（复用 Excel 路径惯例）
   ============================================================ */
'use strict';

const crypto = require('crypto');
const { ApiError } = require('./apiError');
const { logEdit } = require('./audit');
const ollama = require('./ollamaClient');
const { validateRows } = require('./llmValidate');

async function parseTextToBatch(db, { text, filename }) {
  const raw = String(text || '');
  if (raw.trim().length < 5) throw new ApiError('VALIDATION', '文本太短（≥5 字符）');

  const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32);
  const dup = db.prepare('SELECT id FROM import_batches WHERE note LIKE ?').get(`%"hash":"${hash}"%`);
  if (dup) throw new ApiError('DUPLICATE', `同一段文本已导入过（批次 #${dup.id}）`, 400);

  const ready = await ollama.check(db);
  if (!ready.ok) throw new ApiError(ready.error, ready.hint || '本机 LLM 未就绪', 502);

  const gen = await ollama.generateRows(db, raw);
  if (!gen.ok) throw new ApiError(gen.error, gen.hint || 'LLM 解析失败', 502);

  const textLines = raw.split(/\r?\n/);
  const validated = validateRows(gen.rows, raw);
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO import_batches (filename, source_type, status, note, imported_at, created_at)
       VALUES (?, 'llm', 'reviewing', ?, ?, ?)`)
      .run(filename || '粘贴文本.txt',
        JSON.stringify({ hash, model: gen.model, prompt_version: ollama.PROMPT_VERSION,
          text_chars: raw.length, lines: textLines.length }),
        now, now);
    const batchId = info.lastInsertRowid;
    const ins = db.prepare(
      `INSERT INTO raw_import_rows (batch_id, sheet_name, row_no, raw_text, parsed_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`);
    const stats = { rows: 0, ok: 0, review: 0 };
    const reviewList = [];
    validated.forEach((v, i) => {
      stats.rows++;
      if (v.ok) stats.ok++; else stats.review++;
      const lineNo = (gen.rows[i] && Number(gen.rows[i].line)) || i + 1;
      const srcLine = textLines[lineNo - 1] != null
        ? textLines[lineNo - 1].slice(0, 300)
        : raw.slice(0, 300);
      const container = {
        kind: v.kind, parsed: v.parsed,
        needs_review: v.needs_review,
        llm: { confidence: v.confidence, prompt_version: ollama.PROMPT_VERSION, src_line: lineNo }
      };
      ins.run(batchId, `文本行${lineNo}`, i + 1, srcLine, JSON.stringify(container), now, now);
      if (!v.ok) reviewList.push({ id: null, sheet: `文本行${lineNo}`, row_no: i + 1,
        raw: srcLine, needs_review: v.needs_review });
    });
    logEdit(db, { table: 'import_batches', recordId: batchId, action: 'create',
      after: { filename: filename || '粘贴文本.txt', hash, stats, model: gen.model } });
    return { batchId, stats, reviewList };
  });

  const { batchId, stats, reviewList } = tx();
  return {
    batch_id: batchId, stats,
    review_count: reviewList.length,
    review_list: reviewList,
    model: gen.model, prompt_version: ollama.PROMPT_VERSION
  };
}

module.exports = { parseTextToBatch };
