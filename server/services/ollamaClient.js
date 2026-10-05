/* ============================================================
   services/ollamaClient.js — P8-c 本机 Ollama 客户端（全 localhost，无外网依赖）
   - 模型/地址可经 settings 配置：llm.ollama_url（默认 http://127.0.0.1:11434）、
     llm.model（默认 qwen2.5:7b-instruct-q4_K_M）
   - temperature 0 + format json + 非流式；超时放宽到 120s（7B CPU 推理慢）
   - check(): /api/tags 连接与模型存在性探测 → OLLAMA_UNREACHABLE / MODEL_MISSING
   - 失败语义：调用方（llmImport/routes）转 502 + 可读提示，前端按钮置灰
   ============================================================ */
'use strict';

const PROMPT_VERSION = 'p8-1';

function getSetting(db, key, fallback) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    const v = row && String(row.value || '').trim();
    return v || fallback;
  } catch (e) { return fallback; }
}

function ollamaBase(db) {
  const url = getSetting(db, 'llm.ollama_url', 'http://127.0.0.1:11434');
  return url.replace(/\/+$/, '');
}

function ollamaModel(db) {
  return getSetting(db, 'llm.model', 'qwen2.5:7b-instruct-q4_K_M');
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 连接与模型探测：{ok:true, models} | {ok:false, error, hint} */
async function check(db) {
  const base = ollamaBase(db);
  const model = ollamaModel(db);
  let tags;
  try {
    const res = await fetchWithTimeout(`${base}/api/tags`, { method: 'GET' }, 4000);
    if (!res.ok) return { ok: false, error: 'OLLAMA_UNREACHABLE', hint: `Ollama 返回 ${res.status}` };
    tags = await res.json();
  } catch (e) {
    return { ok: false, error: 'OLLAMA_UNREACHABLE', hint: `本机 Ollama(${base}) 未响应，请先启动 Ollama` };
  }
  const models = (tags.models || []).map(m => m.name);
  if (!models.some(n => n === model || n.split(':')[0] === model.split(':')[0])) {
    return { ok: false, error: 'MODEL_MISSING', hint: `未找到模型 ${model}，请执行：ollama pull ${model}`, models };
  }
  return { ok: true, model, models };
}

/* ---------- Prompt（PROMPT_VERSION 变更时同步改这里与测试基线） ---------- */

const FEW_SHOT = `【示例 1】
输入：
3月12日 李洪富 金桂村 打药 12亩 25元/亩 应收300 收300
输出：
{"rows":[{"kind":"job","line":1,"date":"2026-03-12","name":"李洪富","village":"金桂村","team":"","area_mu":12,"price_yuan":25,"receivable_yuan":300,"paid_yuan":300,"discount_yuan":0,"purpose":"","referral":"","workers":[],"collector":"","note":"","evidence":{"receivable_yuan":"应收300","paid_yuan":"收300"},"confidence":0.95}]}

【示例 2】
输入：
3.12 油钱200 加油站
输出：
{"rows":[{"kind":"expense","line":1,"date":"2026-03-12","category":"fuel","amount_yuan":200,"payee":"","note":"加油站","evidence":{"amount_yuan":"油钱200"},"confidence":0.9}]}

【示例 3】（拿不准必须 uncertain，不编造）
输入：
4月 收入540 不知道谁的
输出：
{"rows":[{"kind":"income_pair","line":1,"date":"","amount_yuan":540,"note":"不知道谁的","evidence":{"amount_yuan":"收入540"},"uncertain":true,"confidence":0.4}]}`;

function buildPrompt(text) {
  return `你是植保记账文本整理器。把用户给的杂乱记账记录整理为严格 JSON，不要输出任何解释文字。
输出形状：{"rows":[...]}。每个条目字段：
- kind: "job"(打药作业) | "expense"(支出) | "income_pair"(无主收入) | "note"(无法归类的纯备注)
- line: 该条目主要依据的原文行号（从 1 开始）
- date: YYYY-MM-DD；只有"3月5日"且上下文能确定年份时才补 2026，确定不了就留空
- job 行: name(必填)/village/team/area_mu/price_yuan/receivable_yuan/paid_yuan/discount_yuan/purpose/referral/workers(数组)/collector/note
- expense 行: category ∈ fuel(油费)|chemical(药)|repair(维修)|meal(餐费)|equipment(设备)|labor(人工)|other，amount_yuan/payee/note
- income_pair 行: amount_yuan/note
- evidence: 对象，键=金额字段名（如 receivable_yuan/paid_yuan/amount_yuan/discount_yuan），值=原文片段（逐字复制，一字不改）
铁律：
1. 每个金额字段的数值必须能在其 evidence 原文片段中找到；找不到就把该字段留空并给行加 "uncertain": true。
2. 合计、单价×亩数之类的派生金额一律不要自己计算——只抄原文里出现的数字。
3. 拿不准的字段一律留空，绝不编造；整行拿不准加 "uncertain": true。
4. 一条原文记录拆一行；无关的闲聊/表头跳过（或归为 note）。

${FEW_SHOT}

【记账记录】
${text}`;
}

/**
 * 生成：非流式 + json 约束 + temperature 0。
 * 返回 {ok:true, rows} 或 {ok:false, error, hint}
 */
async function generateRows(db, text) {
  const base = ollamaBase(db);
  const model = ollamaModel(db);
  const call = async (prompt) => {
    const res = await fetchWithTimeout(`${base}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, prompt, stream: false, format: 'json',
        options: { temperature: 0, num_predict: 4096 }
      })
    }, 120000);
    if (!res.ok) return { ok: false, error: 'OLLAMA_UNREACHABLE', hint: `Ollama 返回 ${res.status}` };
    const j = await res.json();
    return { ok: true, text: j.response || '' };
  };

  let r = await call(buildPrompt(text));
  if (!r.ok) return r;
  let rows = tryParse(r.text);
  if (!rows) {
    // 重试 1 次：把坏输出喂回去要求修正
    r = await call(buildPrompt(text) +
      `\n\n【注意】你上一次的输出不是合法 JSON（开头为：${r.text.slice(0, 80)}）。请只输出合法 JSON，不要任何解释。`);
    if (!r.ok) return r;
    rows = tryParse(r.text);
    if (!rows) return { ok: false, error: 'LLM_BAD_OUTPUT', hint: '模型两次输出均无法解析为 JSON，请换更小文本分批导入' };
  }
  if (!Array.isArray(rows.rows)) return { ok: false, error: 'LLM_BAD_OUTPUT', hint: '输出缺少 rows 数组' };
  return { ok: true, rows: rows.rows, model };
}

function tryParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

module.exports = { check, generateRows, buildPrompt, ollamaBase, ollamaModel, PROMPT_VERSION };
