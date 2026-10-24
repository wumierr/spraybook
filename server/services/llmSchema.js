/* ============================================================
   services/llmSchema.js — B0.2/N-22：LLM 输出的两份 JSON 契约（纯函数）
   导入 rows（generateRows）与审查 findings（llmReview）各自的最小形状校验，
   在"解析成 JSON"与"业务关笼"之间再加一道结构闸——形状不对按 LLM_BAD_OUTPUT
   走重试/失败，绝不静默吞掉畸形字段进入校验层。
   策略：多余字段容忍（LLM 输出自带噪声），关键字段（kind/金额/行号/枚举）
   类型不符即报错。零依赖手写校验器（项目无 ajv，不引新依赖）。
   ============================================================ */
'use strict';

const KINDS = ['job', 'expense', 'income_pair', 'note'];
const EXPENSE_CATS = ['fuel', 'chemical', 'repair', 'meal', 'equipment', 'labor', 'other'];
const SEVERITIES = ['high', 'medium', 'low'];

const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 导入输出：{"rows":[{kind, line?, date?, ...金额_yuan, evidence{}, confidence?, uncertain?}]} */
function validateImportRows(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['顶层必须是 JSON 对象'] };
  }
  if (!Array.isArray(obj.rows)) {
    return { ok: false, errors: ['缺少 rows 数组'] };
  }
  const MONEY = ['receivable_yuan', 'paid_yuan', 'discount_yuan', 'amount_yuan', 'price_yuan'];
  obj.rows.forEach((r, i) => {
    const at = `rows[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) { errors.push(`${at} 必须是对象`); return; }
    if (!KINDS.includes(r.kind)) errors.push(`${at}.kind 非法: ${r.kind}`);
    if (r.line != null && !(isNum(r.line) && Number.isInteger(r.line) && r.line >= 1)) {
      errors.push(`${at}.line 必须是正整数`);
    }
    if (r.date != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(r.date))) errors.push(`${at}.date 非法: ${r.date}`);
    for (const k of MONEY) {
      if (r[k] != null && !isNum(r[k])) errors.push(`${at}.${k} 必须是数字`);
    }
    if (r.area_mu != null && !isNum(r.area_mu)) errors.push(`${at}.area_mu 必须是数字`);
    if (r.kind === 'expense' && r.category != null && !EXPENSE_CATS.includes(r.category)) {
      errors.push(`${at}.category 非法: ${r.category}`);
    }
    if (r.evidence != null && (typeof r.evidence !== 'object' || Array.isArray(r.evidence))) {
      errors.push(`${at}.evidence 必须是对象`);
    } else if (r.evidence) {
      for (const [k, v] of Object.entries(r.evidence)) {
        if (!isStr(v)) errors.push(`${at}.evidence.${k} 必须是字符串`);
      }
    }
    if (r.confidence != null && !isNum(r.confidence)) errors.push(`${at}.confidence 必须是数字`);
  });
  return { ok: errors.length === 0, errors };
}

/** 审查输出（批次）："{"findings":[{row, severity?, what, evidence?}]}"。
 *  只管整体形状（findings 数组/条目对象/what 字符串）——row 值域、severity 越界、
 *  空仍交 llmReview 关笼逐条丢弃（P10-R5 裁决：宁丢弃不采信，审查部分可用优于整块失败）。 */
function validateBatchFindings(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['顶层必须是 JSON 对象'] };
  }
  if (!Array.isArray(obj.findings)) {
    return { ok: false, errors: ['缺少 findings 数组'] };
  }
  obj.findings.forEach((f, i) => {
    const at = `findings[${i}]`;
    if (!f || typeof f !== 'object' || Array.isArray(f)) { errors.push(`${at} 必须是对象`); return; }
    if (!isStr(f.what)) errors.push(`${at}.what 必须是字符串`);
  });
  return { ok: errors.length === 0, errors };
}

/** 审查输出（全库体检）："{"findings":[{where, severity?, what, evidence?}]}"。
 *  同批次口径：只管整体形状，where 形态/实体存在性由关笼逐条核（非法 where=幻觉丢弃）。 */
function validateHealthFindings(obj) {
  return validateBatchFindings(obj);
}

module.exports = { validateImportRows, validateBatchFindings, validateHealthFindings, KINDS, EXPENSE_CATS, SEVERITIES };
