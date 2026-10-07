/* ============================================================
   services/llmImport.js — P8-a 编排：文本 → LLM → 校验 → staging（零迁移）
   唯一入口 parseTextToBatch(db, {text, filename, defaultDate})，HTTP 路由与 CLI 共用：
   1. 护栏：文本 ≥5 字符；>500 行拒绝（提示分天/分段导入）；default_date 必须
      合法 YYYY-MM-DD（给了才查）；同文本 sha256 命中已导入批次 → DUPLICATE 拒绝
   2. 探测 Ollama（OLLAMA_UNREACHABLE/MODEL_MISSING 原样上抛，前端置灰）
   3. P9-R3 分块（llmChunk.chunkText，短文本单块直通零开销）：逐块顺序
      generateRows（Ollama 单并发，坏输出重试沿用 client 内 1 次），每块 prompt
      头注入「此前已确认条目的最后日期=X（无则留空）」与「无日期条目按
      default_date 记」；任一块两次坏输出 → 这里直接 throw 502，事务尚未开始
      =零残留
   4. llmValidate 逐行关笼（evidence 回源仍用全文原文，validateRows 不改口径）；
      各块 rows 的 line 按块偏移重映射回原文全局行号
   5. 建批次 import_batches(source_type='llm', status='reviewing'＝UI「待入库」)
      + 逐行写 raw_import_rows（raw_text=原文对应行，parsed_json={kind,parsed,
        needs_review,llm:{confidence,prompt_version,src_line}}，status 全部 'pending'
        ——由预览确认/复核视图人工 confirm 后 apply，宁多勿少）
   ============================================================ */
'use strict';

const crypto = require('crypto');
const { ApiError } = require('./apiError');
const { logEdit } = require('./audit');
const ollama = require('./ollamaClient');
const { validateRows } = require('./llmValidate');
const { normalizeParsedPlaces } = require('./normalize');
const { chunkText, countLines } = require('./llmChunk');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LINES_GUARD = 500;

async function parseTextToBatch(db, { text, filename, defaultDate }) {
  const raw = String(text || '');
  if (raw.trim().length < 5) throw new ApiError('VALIDATION', '文本太短（≥5 字符）');

  // P9-R3：default_date 契约（可选 YYYY-MM-DD，非法即 400——不静默吞掉用户选择）
  const def = typeof defaultDate === 'string' && DATE_RE.test(defaultDate) ? defaultDate : null;
  if (defaultDate && !def) {
    throw new ApiError('VALIDATION', `default_date 格式非法: ${defaultDate}（应为 YYYY-MM-DD）`);
  }

  const textLines = raw.split(/\r?\n/);
  const lineCount = countLines(raw);
  if (lineCount > MAX_LINES_GUARD) {
    throw new ApiError('VALIDATION',
      `文本过长（${lineCount} 行 > ${MAX_LINES_GUARD}），请分天或分段导入`);
  }

  const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32);
  const dup = db.prepare('SELECT id FROM import_batches WHERE note LIKE ?').get(`%"hash":"${hash}"%`);
  if (dup) throw new ApiError('DUPLICATE', `同一段文本已导入过（批次 #${dup.id}）`, 400);

  const ready = await ollama.check(db);
  if (!ready.ok) throw new ApiError(ready.error, ready.hint || '本机 LLM 未就绪', 502);

  // P9-R3 分块编排：短文本=单块直通（一次调用，与旧版完全同价）；
  // 长文本逐块顺序调用，块间继承「最后日期」上下文。任何一块失败 → throw，
  // 事务还没开始，库中零残留（批次/行都不存在）。
  const chunks = chunkText(raw);
  const results = []; // { v: 校验行结果, line: 原文全局行号 }
  let lastDate = null;
  let model = null;
  for (const chunk of chunks) {
    const gen = await ollama.generateRows(db, chunk.text, { lastDate, defaultDate: def });
    if (!gen.ok) throw new ApiError(gen.error, gen.hint || 'LLM 解析失败', 502);
    model = model || gen.model;
    // evidence 回源仍用全文（validateRows 口径不变）；def 只影响缺日期行的兜底
    const validated = validateRows(gen.rows, raw, def);
    // P9-R2 ②：village/team 别名归一。llmValidate 是纯函数不持 db，归一放在编排层
    // parsed 生成后、写 staging 前（侵入最小）；needs_review/llm 元数据不动，
    // evidence 金额回源校验发生在归一前，金额口径不受影响。
    for (const v of validated) normalizeParsedPlaces(db, v.parsed);
    const localRows = Array.isArray(gen.rows) ? gen.rows : [];
    validated.forEach((v, i) => {
      // 行号重映射：LLM 给的行号是"块内局部行号"→ 全局 = 块首行 + 局部 - 1；
      // 局部行号缺失/非法时退回块内序位；越界钳回原文范围
      const local = (localRows[i] && Number(localRows[i].line)) || (i + 1);
      let line = chunk.startLine + local - 1;
      if (!Number.isFinite(line) || line < chunk.startLine) line = chunk.startLine;
      if (line > textLines.length) line = textLines.length;
      results.push({ v, line });
      if (v.parsed && v.parsed.date) lastDate = v.parsed.date;
    });
  }
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO import_batches (filename, source_type, status, note, imported_at, created_at)
       VALUES (?, 'llm', 'reviewing', ?, ?, ?)`)
      .run(filename || '粘贴文本.txt',
        JSON.stringify({ hash, model, prompt_version: ollama.PROMPT_VERSION,
          text_chars: raw.length, lines: lineCount, chunks: chunks.length,
          default_date: def }),
        now, now);
    const batchId = info.lastInsertRowid;
    const ins = db.prepare(
      `INSERT INTO raw_import_rows (batch_id, sheet_name, row_no, raw_text, parsed_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`);
    const stats = { rows: 0, ok: 0, review: 0 };
    const reviewList = [];
    results.forEach(({ v, line }, i) => {
      stats.rows++;
      if (v.ok) stats.ok++; else stats.review++;
      const srcLine = textLines[line - 1] != null
        ? textLines[line - 1].slice(0, 300)
        : raw.slice(0, 300);
      const container = {
        kind: v.kind, parsed: v.parsed,
        needs_review: v.needs_review,
        llm: { confidence: v.confidence, prompt_version: ollama.PROMPT_VERSION, src_line: line }
      };
      ins.run(batchId, `文本行${line}`, i + 1, srcLine, JSON.stringify(container), now, now);
      if (!v.ok) reviewList.push({ id: null, sheet: `文本行${line}`, row_no: i + 1,
        raw: srcLine, needs_review: v.needs_review });
    });
    logEdit(db, { table: 'import_batches', recordId: batchId, action: 'create',
      after: { filename: filename || '粘贴文本.txt', hash, stats, model,
        chunks: chunks.length, default_date: def } });
    return { batchId, stats, reviewList };
  });

  const { batchId, stats, reviewList } = tx();
  return {
    batch_id: batchId, stats,
    review_count: reviewList.length,
    review_list: reviewList,
    model, prompt_version: ollama.PROMPT_VERSION,
    chunks: chunks.length
  };
}

module.exports = { parseTextToBatch };
