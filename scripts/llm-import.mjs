#!/usr/bin/env node
/* ============================================================
   scripts/llm-import.mjs — P8-c CLI 兜底：脱离 Express 的 LLM 文本导入
   （补"CLI 导入入口缺失"遗留⑨；与服务端共用同一解析/校验/落库实现）

   用法：
     node scripts/llm-import.mjs <记录.txt>                 # 解析+预览（不落库）
     node scripts/llm-import.mjs <记录.txt> --apply        # 无疑自行确认并落库
     node scripts/llm-import.mjs <记录.txt> --db <app.db>  # 指定库（默认 SPRAYBOOK_DATA_DIR 或 data/app.db）
     node scripts/llm-import.mjs --status                  # 查 Ollama/模型状态

   前置：Ollama 已启动且已拉模型（ollama pull qwen2.5:7b-instruct-q4_K_M）；
   模型/地址可在记账后台设置页或 settings 表配 llm.model / llm.ollama_url。
   落库后建议：npm run reconcile 对账三平。
   ============================================================ */
'use strict';

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const { initDb, openDb } = require(path.join(ROOT, 'server', 'db', 'client.js'));
const ollama = require(path.join(ROOT, 'server', 'services', 'ollamaClient.js'));
const { parseTextToBatch } = require(path.join(ROOT, 'server', 'services', 'llmImport.js'));
const { applyBatch } = require(path.join(ROOT, 'server', 'services', 'importApply.js'));

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i > -1 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : false;
};
const dbFlag = flag('--db');
const dataDir = process.env.SPRAYBOOK_DATA_DIR || path.join(ROOT, 'data');
const dbPath = typeof dbFlag === 'string' ? dbFlag : path.join(dataDir, 'app.db');
const apply = Boolean(flag('--apply'));

function fmtYuan(c) { return (c / 100).toFixed(2); }

async function main() {
  if (args.includes('--status')) {
    const db = initDb(dbPath);
    const st = await ollama.check(db);
    console.log('[llm-import] Ollama:', st.ok ? `就绪（模型 ${st.model}）` : `${st.error} — ${st.hint || ''}`);
    db.close();
    return;
  }

  const file = args.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('用法：node scripts/llm-import.mjs <记录.txt> [--apply] [--db <路径>] | --status');
    process.exitCode = 1;
    return;
  }
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) { console.error('文件为空'); process.exitCode = 1; return; }

  const db = initDb(dbPath);
  try {
    console.log(`[llm-import] 解析 ${file}（${text.length} 字符 → ${dbPath}）…`);
    const r = await parseTextToBatch(db, { text, filename: path.basename(file) });
    console.log(`[llm-import] 批次 #${r.batch_id} 建立（模型 ${r.model}）：共 ${r.stats.rows} 行，无疑问 ${r.stats.ok}，需复核 ${r.stats.review}`);

    const rows = db.prepare('SELECT * FROM raw_import_rows WHERE batch_id = ? ORDER BY id').all(r.batch_id);
    for (const row of rows) {
      const meta = JSON.parse(row.parsed_json || '{}');
      const p = meta.parsed || {};
      const amt = p.receivable_cents != null ? `${fmtYuan(p.receivable_cents)}/${fmtYuan(p.paid_cents || 0)}`
        : p.amount_cents != null ? fmtYuan(p.amount_cents)
        : p.income_cents != null ? fmtYuan(p.income_cents) : '—';
      const who = p.name || p.category || meta.kind;
      const flags = (meta.needs_review || []).map(n => n.code).join(',') || 'ok';
      console.log(`  #${row.row_no} [${meta.kind}] ${who} ${amt} 元 原文:「${(row.raw_text || '').slice(0, 36)}」 ${flags}`);
    }

    if (!apply) {
      console.log('[llm-import] 预览模式（未落库）。到记账后台「导入」页复核后落库，或重跑加 --apply。');
      return;
    }
    // --apply：只自动确认"零疑虑"行；有 needs_review 的行留给后台复核
    const clear = rows.filter(row => {
      const meta = JSON.parse(row.parsed_json || '{}');
      return (meta.needs_review || []).length === 0 && meta.kind !== 'note';
    });
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      for (const row of clear) {
        db.prepare("UPDATE raw_import_rows SET status='confirmed', updated_at=? WHERE id=?").run(now, row.id);
      }
    });
    tx();
    if (!clear.length) {
      console.log('[llm-import] 没有零疑虑行可自动落库——请到记账后台「导入」页人工复核。');
      return;
    }
    const result = applyBatch(db, r.batch_id, { operator: 'llm-cli' });
    console.log(`[llm-import] 已落库：作业 ${result.jobs}，支出 ${result.expenses}，收入对 ${result.income_pairs}`
      + (result.skipped_unsupported ? `，未支持 ${result.skipped_unsupported}` : '')
      + `。需复核 ${r.stats.review} 行留在批次 #${r.batch_id}（后台「导入」页处理）。`);
    console.log('[llm-import] 建议：npm run reconcile 对账三平。');
  } catch (e) {
    console.error('[llm-import] 失败:', e.message || e);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
