/* ============================================================
   services/ollamaClient.js — P8-c 本机 Ollama 客户端（全 localhost，无外网依赖）
   - 模型/地址可经 settings 配置：llm.ollama_url（默认 http://127.0.0.1:11434）、
     llm.model（默认 qwen2.5:7b-instruct-q4_K_M）
   - temperature 0 + format json + 非流式；超时按文本行数自适应（≤12 行 120s，
     之后每行 +30s、封顶 900s——P9-R3 分块后单块 30 行 7B CPU 实测 ~8 分钟）；
     传输走 node:http（undici fetch 的 300s headersTimeout 杀不掉长生成）
   - check(): /api/tags 连接与模型存在性探测 → OLLAMA_UNREACHABLE / MODEL_MISSING
   - 失败语义：调用方（llmImport/routes）转 502 + 可读提示，前端按钮置灰
   ============================================================ */
'use strict';

const http = require('node:http');
const { URL } = require('node:url');

// P9-R3：分块编排 + default_date 注入，提示词协议变更 → 版本号随动（测试基线同步）
const PROMPT_VERSION = 'p9-1';

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

/** node:http 直连（P9-R3 替代 fetch）：undici 有 300s headersTimeout 硬顶，
 *  30 行块生成 5 分钟+ 必被杀（UND_ERR_HEADERS_TIMEOUT）；本客户端只打本机
 *  Ollama，超时自管最稳。timeoutMs 是整体墙钟上限（非流式生成期间无字节流动，
 *  兼作空闲守门）。返回 {status, json, text}；连接失败/超时 reject。 */
function ollamaRequest(url, { method = 'GET', body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {}
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        clearTimeout(timer);
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* 非 JSON：原样带 text */ }
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    const timer = setTimeout(() => {
      req.destroy(new Error(`Ollama 响应超时（${timeoutMs}ms）`));
    }, timeoutMs);
    req.on('error', e => { clearTimeout(timer); reject(e); });
    if (payload) req.write(payload);
    req.end();
  });
}

/** 连接与模型探测：{ok:true, models} | {ok:false, error, hint} */
async function check(db) {
  const base = ollamaBase(db);
  const model = ollamaModel(db);
  let tags;
  try {
    const res = await ollamaRequest(`${base}/api/tags`, { method: 'GET', timeoutMs: 4000 });
    if (res.status !== 200) return { ok: false, error: 'OLLAMA_UNREACHABLE', hint: `Ollama 返回 ${res.status}` };
    tags = res.json;
    if (!tags) return { ok: false, error: 'OLLAMA_UNREACHABLE', hint: 'Ollama 返回非 JSON' };
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
{"rows":[{"kind":"job","line":1,"date":"2026-03-12","name":"李洪富","village":"金桂村","area_mu":12,"price_yuan":25,"receivable_yuan":300,"paid_yuan":300,"evidence":{"receivable_yuan":"应收300","paid_yuan":"收300"},"confidence":0.95}]}

【示例 2】
输入：
3.12 油钱200 加油站
输出：
{"rows":[{"kind":"expense","line":1,"date":"2026-03-12","category":"fuel","amount_yuan":200,"note":"加油站","evidence":{"amount_yuan":"油钱200"},"confidence":0.9}]}

【示例 3】（拿不准必须 uncertain，不编造）
输入：
4月 收入540 不知道谁的
输出：
{"rows":[{"kind":"income_pair","line":1,"amount_yuan":540,"note":"不知道谁的","evidence":{"amount_yuan":"收入540"},"uncertain":true,"confidence":0.4}]}`;

/**
 * buildPrompt(text, opts?) — P9-R3 加可选上下文头（opts 由编排层按块注入）：
 * - opts.lastDate：分块时此前已确认条目的最后日期（无则不注入，留空）；
 * - opts.defaultDate：用户默认日期，无日期条目按它记（validateRow 兜底标 date_default）。
 */
function buildPrompt(text, opts) {
  const o = opts || {};
  let head = '';
  if (o.lastDate) head += `【日期上下文】此前已确认条目的最后日期=${o.lastDate}（与这些记录相邻延续，确有把握才据此推断日期）。\n`;
  if (o.defaultDate) head += `【默认日期】无日期条目一律按 ${o.defaultDate} 记（date 字段直接填它）。\n`;
  return head + `你是植保记账文本整理器。把用户给的杂乱记账记录整理为严格 JSON，不要输出任何解释文字。
输出形状：{"rows":[...]}。每个条目字段：
- kind: "job"(打药作业) | "expense"(支出) | "income_pair"(无主收入) | "note"(无法归类的纯备注)
- line: 该条目主要依据的原文行号（从 1 开始）
- date: YYYY-MM-DD；只有"3月5日"且上下文能确定年份时才补 2026，确定不了就不输出该字段
- job 行: name(必填)/village/team/area_mu/price_yuan/receivable_yuan/paid_yuan/discount_yuan/purpose/referral/workers(数组)/collector/note
- expense 行: category ∈ fuel(油费)|chemical(药)|repair(维修)|meal(餐费)|equipment(设备)|labor(人工)|other，amount_yuan/payee/note
- income_pair 行: amount_yuan/note
- evidence: 对象，键=金额字段名（如 receivable_yuan/paid_yuan/amount_yuan/discount_yuan），值=原文片段（逐字复制，一字不改）
铁律：
1. 每个金额字段的数值必须能在其 evidence 原文片段中找到；找不到就不要输出该字段并给行加 "uncertain": true。
2. 合计、单价×亩数之类的派生金额一律不要自己计算——只抄原文里出现的数字。
3. 拿不准的字段一律不要输出，绝不编造；整行拿不准加 "uncertain": true。
4. 一条原文记录拆一行；无关的闲聊/表头跳过（或归为 note）。
5. 输出要短：用不到的空字段一律省略（不要输出空字符串/空数组/null），evidence 只放出现过的金额字段；条目数多时尤其如此。

${FEW_SHOT}

【记账记录】
${text}`;
}

/** 单次生成超时：P8 的固定 120s 按 4 行短文本定标；P9-R3 分块后单块可达 30 行，
 *  7B CPU 生成 30 行结构化 JSON 实测 ~460s（4096 token @ ~9 tok/s）。按行数放宽：
 *  ≤12 行维持 120s（短文本行为不变），之后每行 +30s，封顶 900s（30 行=660s）；
 *  opts.timeoutMs 可显式覆盖（测试/特殊部署用）。 */
function callTimeoutMs(text, opts) {
  if (opts && opts.timeoutMs) return opts.timeoutMs;
  const lines = String(text || '').split(/\r?\n/).length;
  return Math.min(120000 + Math.max(0, lines - 12) * 30000, 900000);
}

/**
 * 生成：非流式 + json 约束 + temperature 0。
 * opts 透传 buildPrompt（分块上下文/默认日期），坏输出重试沿用同一 prompt。
 * 返回 {ok:true, rows} 或 {ok:false, error, hint}
 */
async function generateRows(db, text, opts) {
  const base = ollamaBase(db);
  const model = ollamaModel(db);
  const timeoutMs = callTimeoutMs(text, opts);
  const call = async (prompt) => {
    const res = await ollamaRequest(`${base}/api/generate`, {
      method: 'POST', timeoutMs,
      body: {
        model, prompt, stream: false, format: 'json',
        // P9-R3 实测：30 行块若每行都输出全字段，JSON ≈5-6k token——num_predict 4096
        // 截断（done_reason=length）且 7B CPU 生成 10 分钟+。已改提示词省略空字段
        //（行均 ≈90 token，30 行 ≈2.7k）；num_ctx 8192 容住 prompt+输出不被左截。
        options: { temperature: 0, num_predict: 4096, num_ctx: 8192 }
      }
    });
    if (res.status !== 200) return { ok: false, error: 'OLLAMA_UNREACHABLE', hint: `Ollama 返回 ${res.status}` };
    return { ok: true, text: (res.json && res.json.response) || '' };
  };

  let r = await call(buildPrompt(text, opts));
  if (!r.ok) return r;
  let rows = tryParse(r.text);
  if (!rows) {
    // 重试 1 次：把坏输出喂回去要求修正
    r = await call(buildPrompt(text, opts) +
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

/**
 * P10-R5：通用 JSON 生成（数据审查 prompt 专用；输出契约由调用方关笼）。
 * 与 generateRows 共用传输/超时（按 prompt 行数自适应）/坏输出重试一次骨架；
 * 返回 {ok:true, json, model} 或 {ok:false, error, hint}。
 */
async function generateJson(db, prompt, opts) {
  const base = ollamaBase(db);
  const model = ollamaModel(db);
  const timeoutMs = callTimeoutMs(prompt, opts);
  const call = async (p) => {
    const res = await ollamaRequest(`${base}/api/generate`, {
      method: 'POST', timeoutMs,
      body: {
        model, prompt: p, stream: false, format: 'json',
        options: { temperature: 0, num_predict: 4096, num_ctx: 8192 }
      }
    });
    if (res.status !== 200) return { ok: false, error: 'OLLAMA_UNREACHABLE', hint: `Ollama 返回 ${res.status}` };
    return { ok: true, text: (res.json && res.json.response) || '' };
  };
  let r = await call(prompt);
  if (!r.ok) return r;
  let out = tryParse(r.text);
  if (!out || typeof out !== 'object' || Array.isArray(out)) {
    r = await call(prompt +
      `\n\n【注意】你上一次的输出不是合法 JSON 对象（开头为：${r.text.slice(0, 80)}）。请只输出合法 JSON，不要任何解释。`);
    if (!r.ok) return r;
    out = tryParse(r.text);
    if (!out || typeof out !== 'object' || Array.isArray(out)) {
      return { ok: false, error: 'LLM_BAD_OUTPUT', hint: '模型两次输出均无法解析为 JSON' };
    }
  }
  return { ok: true, json: out, model };
}

module.exports = { check, generateRows, generateJson, buildPrompt, ollamaBase, ollamaModel, PROMPT_VERSION };
