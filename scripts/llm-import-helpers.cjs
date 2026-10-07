/* ============================================================
   scripts/llm-import-helpers.cjs — P9-R3 CLI 友好提示的纯函数（无 IO）
   抽出来专为单测（llm-import.mjs 是 ESM 且 import 即执行，无法直接 require）；
   llm-import.mjs 经 createRequire 复用同一实现，保证测的就是跑的。
   ============================================================ */
'use strict';

/**
 * 已落库批次的友好提示。--apply 遇 applied 批次时打印并 exit 0（不再撞
 * applyBatch 的 INVALID_STATE）。非 applied（reviewing/rejected/缺档）→ null。
 */
function appliedBatchMessage(batch) {
  if (!batch || batch.status !== 'applied') return null;
  const at = String(batch.imported_at || '').slice(0, 19).replace('T', ' ') || '未知时间';
  return `该批已落库（批次 #${batch.id} @${at}），无需重复`;
}

/** DUPLICATE 复用既有批次的提示（含追加指引：同文本去重是契约，追加须改文本） */
function duplicateReuseMessage(batchId) {
  return `同文本已存在（复用批次 #${batchId} 继续）；同文本已存在，如需追加请修改文本`;
}

module.exports = { appliedBatchMessage, duplicateReuseMessage };
