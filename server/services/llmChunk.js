/* ============================================================
   services/llmChunk.js — P9-R3 长文本切分器（纯函数，无 IO，逐例可单测）
   chunkText(raw) → [{ startLine, text }]：
   1) 全文满足限制（≤30 行 且 ≤2500 字符）→ 单块直通（短记录零开销，D2 裁决，
      空行也不切开——避免短文本多付几次 LLM 调用）；
   2) 超限文本：先按空行分段（段落=连续非空行），段内超 30 行或 2500 字符
      再按行边界贪心切（绝不切在行中间——保证行号重映射唯一）；
   3) startLine = 该块首行在原文中的 1-based 行号（含空行计数，供编排层把
      LLM 输出的块内行号重映射回原文全局行号）；
   4) 单行本身超 2500 字符时独立成块（宁超限也不破坏行对齐）。
   坏输入兜底：null/undefined/空白文本 → []；非字符串安全 String 化。
   countLines(raw)：按"行"的常规口径计数（末尾换行不算多出一行），
   供编排层 500 行护栏使用，与 chunker 同源避免口径漂移。
   ============================================================ */
'use strict';

const MAX_LINES = 30;
const MAX_CHARS = 2500;

/** 段内贪心切分（行对齐）：按顺序累积，装不下（行数或字符超限）先落一块 */
function pushSegmentChunks(seg, chunks) {
  if (seg.lines.length <= MAX_LINES && seg.lines.join('\n').length <= MAX_CHARS) {
    chunks.push({ startLine: seg.startLine, text: seg.lines.join('\n') });
    return;
  }
  let buf = [];
  let bufStart = seg.startLine;
  const flush = () => {
    if (buf.length) chunks.push({ startLine: bufStart, text: buf.join('\n') });
    buf = [];
  };
  seg.lines.forEach((line, j) => {
    if (buf.length) {
      const over = buf.length + 1 > MAX_LINES ||
        buf.join('\n').length + 1 + line.length > MAX_CHARS;
      if (over) flush();
    }
    if (!buf.length) bufStart = seg.startLine + j;
    buf.push(line);
  });
  flush();
}

function chunkText(raw) {
  const s = raw == null ? '' : String(raw);
  if (!s.trim()) return [];
  const lines = s.split(/\r?\n/);
  // 单块直通：全文满足限制时原样返回（含空行与换行风格，零开销）
  if (lines.length <= MAX_LINES && s.length <= MAX_CHARS) {
    return [{ startLine: 1, text: s }];
  }
  const chunks = [];
  let seg = null;
  const flushSeg = () => {
    if (seg && seg.lines.length) pushSegmentChunks(seg, chunks);
    seg = null;
  };
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) { flushSeg(); continue; } // 空行=段落边界（不计入任何块）
    if (!seg) seg = { startLine: i + 1, lines: [] };
    seg.lines.push(lines[i]);
  }
  flushSeg();
  return chunks;
}

/** 行数口径：末尾换行不虚增一行（'a\n' = 1 行；'' = 0 行） */
function countLines(raw) {
  const s = raw == null ? '' : String(raw);
  if (!s) return 0;
  const n = s.split(/\r?\n/).length;
  return s.endsWith('\n') ? n - 1 : n;
}

module.exports = { chunkText, countLines, MAX_LINES, MAX_CHARS };
