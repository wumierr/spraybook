/* ============================================================
   services/numbers.js — 金额与舍入规则（唯一实现，测试覆盖）
   ============================================================ */
'use strict';

const { ApiError } = require('./apiError');

/** 元→分：Math.round(×100)；null/undefined 透传；非法数字抛 VALIDATION */
function yuanToCents(v, field = 'amount') {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new ApiError('VALIDATION', `${field} 不是有效数字: ${JSON.stringify(v)}`);
  }
  return Math.round(n * 100);
}

/**
 * 最大余数法：把 totalCents 按比例 weights 拆成整数分项，Σ分项=totalCents。
 * 余数分给小数部分最大者（大额项优先）。weights 全 0 时平均拆。
 */
function largestRemainder(totalCents, weights) {
  const w = weights.map(Number);
  const n = w.length;
  if (n === 0) return [];
  const sumW = w.reduce((a, b) => a + b, 0);
  let base;
  if (sumW <= 0) {
    base = w.map(() => totalCents / n);
  } else {
    base = w.map(x => (x / sumW) * totalCents);
  }
  const floors = base.map(Math.floor);
  let remainder = totalCents - floors.reduce((a, b) => a + b, 0);
  const order = base
    .map((b, i) => ({ i, frac: b - Math.floor(b) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = floors.slice();
  let k = 0;
  while (remainder > 0 && order.length) {
    out[order[k % order.length].i] += 1;
    remainder -= 1;
    k += 1;
  }
  return out;
}

module.exports = { yuanToCents, largestRemainder };
