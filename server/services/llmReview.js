/* services/llmReview.js — P10-R5 LLM 数据审查（D3 裁决：只挑错、人采纳，绝不改数据） */
'use strict';

const crypto = require('crypto');
const { ApiError } = require('./apiError');
const { logEdit } = require('./audit');
const ollama = require('./ollamaClient');
const { chunkText } = require('./llmChunk');
const llmSchema = require('./llmSchema');

/* 审查 prompt 版本（与导入 prompt 的 PROMPT_VERSION 相互独立） */
const REVIEW_PROMPT_VERSION = 'p10-r1';
const SEVERITIES = ['high', 'medium', 'low'];
const DISMISS_KEY = 'llmreview.dismissed';

const yuan = cents => (Number(cents || 0) / 100).toFixed(2) + '元';

/* ---------- prompt ---------- */
function buildBatchPrompt(block) {
  return `你是植保记账数据审查员。下面是已导入待复核的记账行，每行格式：
#行id [sheet/行号] 类型 ｜ 原文：… ｜ 解析：字段=值 …
请只挑可疑问题，绝不改数据。输出严格 JSON：{"findings":[...]}，每条：
- row: 有问题的 #行id（整数，不带#）
- what: 问题一句话（金额与单价×亩数不符 / 日期可疑 / 姓名疑似错字 / 同名异写 / 村名可疑 / 其他）
- evidence: 支撑判断的片段（从该行原文或解析里逐字复制，一字不改）
- severity: "high"|"medium"|"low"
铁律：
1. 只依据给出的内容判断，不编造；没有确凿依据就不要输出该条。
2. evidence 抄不出来的问题不要报（会被程序校验丢弃/降级）。
3. 没问题的行不要硬找；整块没问题就输出 {"findings":[]}。
4. 只输出 JSON，不要任何解释文字，输出要短。

【待审查数据】
${block}`;
}

function buildHealthPrompt(block) {
  return `你是植保记账数据审查员。下面是全库主数据/作业/账单摘要，每行格式：
实体#id 类型 字段值…
请只挑可疑问题，绝不改数据。输出严格 JSON：{"findings":[...]}，每条：
- where: 有问题的实体标识（逐字复制行首，如 "parties#12"）
- what: 问题一句话（疑似同名可合并 / 疑似错字 / 金额离群 / 数据缺漏可疑）
- evidence: 支撑判断的片段（从该实体摘要行逐字复制，一字不改）
- severity: "high"|"medium"|"low"
铁律：
1. 同名不同档案只是「疑似重复」不是错误；村名互为前缀可能是层级（如 大发/大发梁子）不一定是异写。
2. 金额离群指与同类相比明显异常的账单/作业金额。
3. evidence 抄不出来不要报（会被程序校验丢弃/降级）。
4. 没有硬找；输出 {"findings":[]} 也合法。只输出 JSON，不要解释，输出要短。

【全库摘要】
${block}`;
}

/* ---------- findings 关笼（幻觉行/实体丢弃；evidence 回源校验） ---------- */
function normBatchFinding(f, byId) {
  if (!f || typeof f !== 'object') return null;
  const rid = Number(f.row);
  const meta = byId.get(rid);
  if (!meta) return null; // 幻觉行 id 丢弃
  const what = String(f.what || '').trim().slice(0, 160);
  if (!what) return null;
  const evidence = String(f.evidence || '').trim().slice(0, 160);
  const severity = SEVERITIES.includes(f.severity) ? f.severity : 'low';
  const verified = !!evidence && meta.rawText.includes(evidence);
  return { row_id: rid, what, evidence, severity, verified };
}

function normHealthFinding(f, lineByWhere) {
  if (!f || typeof f !== 'object') return null;
  const where = String(f.where || '').trim();
  if (!/^(parties|jobs|bills)#\d+$/.test(where)) return null;
  const line = lineByWhere.get(where);
  if (!line) return null; // 幻觉实体丢弃
  const what = String(f.what || '').trim().slice(0, 160);
  if (!what) return null;
  const evidence = String(f.evidence || '').trim().slice(0, 160);
  const severity = SEVERITIES.includes(f.severity) ? f.severity : 'low';
  const verified = !!evidence && line.includes(evidence);
  return { where, what, evidence, severity, verified };
}

/** needs_review 详情文案（复核 UI 直接呈现；verified=false 时明示请人工核对） */
function findingDetail(f) {
  return `[llm:${f.severity}] ${f.what}｜证据：${f.evidence || '（未给出）'}`
    + (f.verified ? '' : '（证据未在原文定位，请人工核对）');
}

/* ---------- scope ①：批次审查（findings append 进 needs_review，零迁移） ---------- */
async function reviewBatch(db, batchId) {
  const id = Number(batchId);
  const b = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(id);
  if (!b) throw new ApiError('NOT_FOUND', `批次不存在: ${id}`, 404);
  if (b.status === 'applied') throw new ApiError('INVALID_STATE', '批次已落库，无需再审查', 400);

  const rows = db.prepare(
    "SELECT id, sheet_name, row_no, status, raw_text, parsed_json FROM raw_import_rows " +
    "WHERE batch_id = ? AND status != 'rejected' ORDER BY id").all(id);
  if (!rows.length) throw new ApiError('VALIDATION', '该批次没有可审查的行（全部已拒绝？）');

  const ready = await ollama.check(db);
  if (!ready.ok) throw new ApiError(ready.error, ready.hint || '本机 LLM 未就绪', 502);

  // 行文本（#行id 打头，findings 按 id 回挂；chunkText 行对齐切块不破坏行）
  const byId = new Map();
  const lines = rows.map(r => {
    let pj = {};
    try { pj = JSON.parse(r.parsed_json || '{}'); } catch (e) { /* 坏 json 视作空 */ }
    const p = pj.parsed || {};
    const ptxt = Object.entries(p)
      .filter(([, v]) => v !== '' && v != null)
      .map(([k, v]) => `${k}=${v}`).join(' ');
    byId.set(r.id, { rawText: String(r.raw_text || ''), status: r.status });
    return `#${r.id} [${r.sheet_name}/${r.row_no}] ${pj.kind || '?'} ｜ 原文：${String(r.raw_text || '').slice(0, 160)} ｜ 解析：${ptxt}`;
  });

  const chunks = chunkText(lines.join('\n'));
  const findings = [];
  for (const ch of chunks) {
    const gen = await ollama.generateJson(db, buildBatchPrompt(ch.text));
    if (!gen.ok) throw new ApiError(gen.error, gen.hint || 'LLM 审查失败', 502);
    // B0.2/N-22：结构闸——findings 形状畸形（row_id 非正整数/severity 越界/what 空）
    // 整块按坏输出处理，不进关笼（normBatchFinding 的白名单回退只兜值域，不兜形状）
    const schema = llmSchema.validateBatchFindings(gen.json);
    if (!schema.ok) throw new ApiError('LLM_BAD_OUTPUT',
      `审查输出结构不符契约: ${schema.errors.slice(0, 3).join('；')}`, 502);
    const fs = Array.isArray(gen.json && gen.json.findings) ? gen.json.findings : [];
    for (const f of fs) {
      const n = normBatchFinding(f, byId);
      if (n) findings.push(n);
    }
  }

  // append 进 needs_review（事务 + 去重；applied 行跳过——PATCH 层同样拒绝）
  const now = new Date().toISOString();
  let appended = 0;
  const tx = db.transaction(() => {
    for (const f of findings) {
      const meta = byId.get(f.row_id);
      if (!meta || meta.status === 'applied') continue;
      const row = db.prepare('SELECT parsed_json FROM raw_import_rows WHERE id = ?').get(f.row_id);
      if (!row) continue;
      let pj;
      try { pj = JSON.parse(row.parsed_json || '{}'); } catch (e) { pj = {}; }
      pj.needs_review = Array.isArray(pj.needs_review) ? pj.needs_review : [];
      const detail = findingDetail(f);
      // 去重：同行同文案不重复 append（重复点「审查这批」幂等）。
      // B0.2/N-15：键不含 severity——同一发现两次审查严重度升降（low→medium）
      // 会绕过旧 detail 全串比较造成重复 append；剥离 [llm:x] 前缀后比较。
      const dedupKey = detail.replace(/^\[llm:\w+\]\s*/, '');
      if (pj.needs_review.some(n => n.code === 'llm_review' &&
        String(n.detail).replace(/^\[llm:\w+\]\s*/, '') === dedupKey)) continue;
      pj.needs_review.push({ code: 'llm_review', detail });
      db.prepare('UPDATE raw_import_rows SET parsed_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(pj), now, f.row_id);
      appended++;
    }
    if (appended) {
      logEdit(db, { table: 'raw_import_rows', recordId: 0, action: 'update',
        after: { by: 'llm-review', batch_id: id, findings: appended, version: REVIEW_PROMPT_VERSION } });
    }
  });
  tx();

  return {
    batch_id: id, chunks: chunks.length, findings, appended,
    model: ollama.ollamaModel(db), prompt_version: REVIEW_PROMPT_VERSION
  };
}

/* ---------- scope ②：全库体检（ephemeral，不落库；忽略走 settings 键） ---------- */
function readDismissed(db) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(DISMISS_KEY);
  if (!row) return [];
  try {
    const arr = JSON.parse(row.value);
    return Array.isArray(arr) ? arr.filter(k => typeof k === 'string') : [];
  } catch (e) { return []; }
}

/** 稳定 key：同 where|what|evidence → 同 key（temperature 0 下重复审查可命中同一忽略项） */
function healthKey(f) {
  return crypto.createHash('sha1').update(`${f.where}|${f.what}|${f.evidence}`, 'utf8').digest('hex').slice(0, 16);
}

async function reviewHealth(db) {
  const ready = await ollama.check(db);
  if (!ready.ok) throw new ApiError(ready.error, ready.hint || '本机 LLM 未就绪', 502);

  const parties = db.prepare(
    "SELECT id, name, phone, region, village, team, county FROM parties " +
    "WHERE deleted_at IS NULL AND type = 'customer' ORDER BY id").all();
  const jobs = db.prepare('SELECT id, job_no, job_date, purpose, status FROM jobs ORDER BY id').all();
  const bills = db.prepare(
    'SELECT b.id, b.bill_no, b.amount_cents, b.paid_cents, b.adjust_cents, b.status, p.name AS party ' +
    'FROM bills b LEFT JOIN parties p ON p.id = b.party_id ORDER BY b.id').all();

  const lineByWhere = new Map();
  const lines = [
    ...parties.map(p => {
      const l = `parties#${p.id} 客户 ${p.name}｜${[p.county, p.region, p.village, p.team ? p.team + '队' : ''].filter(Boolean).join(' ')}｜电话${p.phone || '未填'}`;
      lineByWhere.set(`parties#${p.id}`, l);
      return l;
    }),
    ...jobs.map(j => {
      const l = `jobs#${j.id} 作业 ${j.job_no}｜${j.job_date}｜${j.purpose || '未填'}｜${j.status}`;
      lineByWhere.set(`jobs#${j.id}`, l);
      return l;
    }),
    ...bills.map(b => {
      const l = `bills#${b.id} 账单 ${b.bill_no}｜客户${b.party || '未挂'}｜金额${yuan(b.amount_cents)}｜已收${yuan(b.paid_cents)}｜抹零${yuan(b.adjust_cents)}｜${b.status}`;
      lineByWhere.set(`bills#${b.id}`, l);
      return l;
    })
  ];

  const chunks = chunkText(lines.join('\n'));
  const findings = [];
  for (const ch of chunks) {
    const gen = await ollama.generateJson(db, buildHealthPrompt(ch.text));
    if (!gen.ok) throw new ApiError(gen.error, gen.hint || 'LLM 审查失败', 502);
    // B0.2/N-22：结构闸（同批次审查口径）
    const schema = llmSchema.validateHealthFindings(gen.json);
    if (!schema.ok) throw new ApiError('LLM_BAD_OUTPUT',
      `审查输出结构不符契约: ${schema.errors.slice(0, 3).join('；')}`, 502);
    const fs = Array.isArray(gen.json && gen.json.findings) ? gen.json.findings : [];
    for (const f of fs) {
      const n = normHealthFinding(f, lineByWhere);
      if (n) { n.key = healthKey(n); findings.push(n); }
    }
  }

  const dismissed = readDismissed(db);
  const visible = findings.filter(f => !dismissed.includes(f.key));
  return {
    findings: visible,
    total: findings.length,
    dismissed: findings.length - visible.length,
    chunks: chunks.length,
    scanned: lines.length,
    model: ollama.ollamaModel(db),
    prompt_version: REVIEW_PROMPT_VERSION,
    generated_at: new Date().toISOString()
  };
}

function dismissFinding(db, key) {
  if (!key || typeof key !== 'string') throw new ApiError('VALIDATION', 'key 必填（findings key）');
  const arr = readDismissed(db);
  if (!arr.includes(key)) arr.push(key);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(DISMISS_KEY, JSON.stringify(arr), now);
  logEdit(db, { table: 'settings', recordId: 0, action: 'update',
    after: { key: DISMISS_KEY, dismiss: key, total: arr.length } });
  return { key, dismissed: arr };
}

module.exports = { reviewBatch, reviewHealth, dismissFinding, healthKey, REVIEW_PROMPT_VERSION };
