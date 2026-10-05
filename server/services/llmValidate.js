/* ============================================================
   services/llmValidate.js — P8-b 规则校验器（纯函数，无 IO，逐行可单测）
   把 LLM 的"抽取结果"关进笼子（硬约束见 HANDOFF-P8-PLAN §0）：
   1) 金额回原文硬门：每个金额字段的 evidence.quote 必须
      a) 逐字出现在原文里（去空白比较，防编造证据）；
      b) 该金额的数字串能在 quote 中定位（去千分位/币符后子串匹配，防幻觉数值）。
      任一不满足 → 该行整体 needs_review，绝不静默采信。
   2) 派生金额代码算：LLM 只允许抄原子值；发现 price×area 与 receivable 矛盾
      只标记不采信其一（留人工）。
   3) 字段白名单 + 类型/符号/日期校验；拿不准一律 needs_review（宁多勿少）。
   输出与 importExcel 的 staging 容器同形状：{kind, parsed, needs_review}，
   apply 侧（routes/import.js）零改动即可消费。
   ============================================================ */
'use strict';

const LLM_KINDS = ['job', 'expense', 'income_pair', 'note'];
const EXPENSE_CATEGORIES = ['fuel', 'chemical', 'repair', 'meal', 'equipment', 'labor', 'other'];

/** 去掉空白/千分位/币符，便于"数值是否出现在原文片段里"的宽松定位 */
function normalizeForMatch(s) {
  return String(s == null ? '' : s)
    .replace(/[\s,，]/g, '')
    .replace(/[¥￥元]/g, '')
    .replace(/\.0+$/, ''); // 300.0 → 300
}

/** 金额数值是否能在原文片段中定位（整数与小数两种写法任一命中即可） */
function amountInQuote(amount, quote) {
  const q = normalizeForMatch(quote);
  if (!q) return false;
  const n = Number(amount);
  if (!Number.isFinite(n)) return false;
  const candidates = new Set();
  candidates.add(normalizeForMatch(String(amount)));
  if (Number.isInteger(n)) {
    candidates.add(String(n));
  } else {
    candidates.add(n.toFixed(2));
    candidates.add(n.toFixed(1));
    candidates.add(String(n));
  }
  for (const c of candidates) {
    if (c && q.includes(c)) return true;
  }
  return false;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 校验 LLM 抽取的一行。row 形状见 ollamaClient.buildPrompt 的输出协议。
 * fullText 为用户原始粘贴文本（证据回源基准）。
 * 返回 { kind, parsed, needs_review, confidence, ok } —— ok = needs_review 为空。
 */
function validateRow(row, fullText) {
  const needs = [];
  const reasons = [];
  const push = (code, detail) => needs.push({ code, detail });

  const normText = normalizeForMatch(fullText);
  const kind = row && row.kind;
  if (!LLM_KINDS.includes(kind)) {
    return { kind: 'note', parsed: { text: JSON.stringify(row).slice(0, 200) },
      needs_review: [{ code: 'kind', detail: `未知 kind: ${kind}` }], ok: false };
  }
  const conf = Number(row.confidence == null ? 1 : row.confidence);
  if (Number.isFinite(conf) && conf < 0.6) push('confidence', `置信度低 ${conf}`);
  if (row.uncertain) push('uncertain', 'LLM 自报不确定');

  /** 金额通用校验：数值有限非负 + 证据回源，通过返回分，否则标记并返回 null */
  const money = (obj, field, yuanKey) => {
    const v = obj == null ? undefined : obj[yuanKey];
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      push('amount', `${field} 非法数值: ${v}`);
      return null;
    }
    if (n === 0) return 0; // 零值=未发生，无需证据（LLM 常默认补 0）
    const quote = row.evidence && row.evidence[field];
    if (!quote) {
      push('evidence', `${field} 缺原文证据`);
      return Math.round(n * 100);
    }
    if (!normText.includes(normalizeForMatch(quote))) {
      push('evidence', `${field} 的证据"${String(quote).slice(0, 40)}"不在原文中（疑似编造）`);
      return Math.round(n * 100);
    }
    if (!amountInQuote(n, quote)) {
      push('evidence', `${field}=${n} 在其证据"${String(quote).slice(0, 40)}"中定位不到（疑似幻觉）`);
      return Math.round(n * 100);
    }
    return Math.round(n * 100);
  };

  const src = row;
  const dateOk = (d) => !d || DATE_RE.test(String(d));
  if (src.date && !dateOk(src.date)) push('date', `日期格式非法: ${src.date}（应为 YYYY-MM-DD）`);

  if (kind === 'job') {
    const name = String(src.name || '').trim();
    if (!name) push('name', '作业行缺姓名');
    const date = DATE_RE.test(String(src.date || '')) ? src.date : null;
    if (!date) push('date', src.date ? `日期非法: ${src.date}` : '缺日期');
    const receivable = money(src, 'receivable_yuan', 'receivable_yuan');
    const paid = money(src, 'paid_yuan', 'paid_yuan');
    const discount = money(src, 'discount_yuan', 'discount_yuan');
    if (receivable == null && paid == null) push('amount', '应收/实收全空，无法落账');
    if (discount != null && discount > 1000) {
      push('discount', `抹零 ${discount / 100} 元超过 10 元上限，疑似欠款误标为抹零`);
    }
    const area = src.area_mu != null && Number(src.area_mu) > 0 ? Number(src.area_mu) : null;
    const price = src.price_yuan != null && Number(src.price_yuan) > 0 ? Number(src.price_yuan) : null;
    if (price != null && area != null && receivable != null) {
      const expect = Math.round(price * area * 100);
      if (Math.abs(expect - receivable) > 100) {
        push('price-area', `单价×亩数 ${(expect / 100).toFixed(2)} 与应收 ${(receivable / 100).toFixed(2)} 差超 1 元，请人工核对`);
      }
    }
    const parsed = {
      name, date,
      area_mu: area,
      price_yuan: price,
      receivable_cents: receivable || 0,
      paid_cents: paid || 0,
      discount_cents: discount || 0,
      village: String(src.village || '').trim() || null,
      team: String(src.team || '').trim() || null,
      purpose: String(src.purpose || '').trim() || null,
      referral: String(src.referral || '').trim() || null,
      operators: Array.isArray(src.workers) ? src.workers.map(String).filter(Boolean) : [],
      collector: String(src.collector || '').trim() || null,
      note: String(src.note || '').trim() || null,
      extra_income: [],
      extra_income_cents: 0
    };
    return { kind, parsed, needs_review: needs, confidence: conf, ok: needs.length === 0 };
  }

  if (kind === 'expense') {
    const date = DATE_RE.test(String(src.date || '')) ? src.date : null;
    if (!date) push('date', src.date ? `日期非法: ${src.date}` : '缺日期');
    const amount = money(src, 'amount_yuan', 'amount_yuan');
    if (amount == null) push('amount', '支出金额缺证据或非法');
    let category = String(src.category || '').trim();
    if (!EXPENSE_CATEGORIES.includes(category)) {
      push('category', `支出类别"${category || '空'}"不在枚举，暂记 other`);
      category = 'other';
    }
    const parsed = {
      category, amount_cents: amount || 0, date,
      category_raw: String(src.category_raw || src.note || 'LLM 整理支出').slice(0, 40),
      person: String(src.payee || '').trim() || null,
      desc: '', note: String(src.note || '').trim() || null
    };
    return { kind, parsed, needs_review: needs, confidence: conf, ok: needs.length === 0 };
  }

  if (kind === 'income_pair') {
    const date = DATE_RE.test(String(src.date || '')) ? src.date : null;
    if (!date) push('date', '无姓名收入对缺日期（落账将按当天记，建议补）');
    const amount = money(src, 'amount_yuan', 'amount_yuan');
    if (amount == null) push('amount', '收入对金额缺证据或非法');
    const parsed = {
      price_yuan: src.price_yuan != null ? Number(src.price_yuan) : null,
      income_cents: amount || 0,
      date, cells: String(src.note || '').trim() || null
    };
    return { kind, parsed, needs_review: needs, confidence: conf, ok: needs.length === 0 };
  }

  // note：仅备忘，不落账（apply 不消费 note kind → 会计入 skipped_unsupported；
  // 因此这里直接转成提示性 needs_review 行，让用户决定删或留）
  return { kind: 'note', parsed: { text: String(src.text || '').slice(0, 500) },
    needs_review: [{ code: 'note', detail: '纯备注行不落账，确认后请驳回该行' }],
    confidence: conf, ok: false };
}

/** 批量校验：rows = LLM 输出的 rows 数组，fullText = 原文。返回逐行结果数组。 */
function validateRows(rows, fullText) {
  return (Array.isArray(rows) ? rows : []).map(r => validateRow(r, fullText));
}

module.exports = { validateRow, validateRows, amountInQuote, normalizeForMatch, LLM_KINDS, EXPENSE_CATEGORIES };
