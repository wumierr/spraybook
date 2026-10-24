/* ============================================================
   services/exportExcel.js — C2 Excel 原样往返导出（U5 版式 1:1，单向）
   - exceljs 产 .xlsx 真值单元格（数字/文本），天然无 CSV 公式注入面（消 M-4）
   - 版式=历史月度表（U5）：sheet「N月份」+ 表头行（日期/姓名/客户地址/客户亩数/
     价格亩/元/应收金额/实收金额/作业目的/业务来源/作业人员/收款人/备注）+
     行=作业（overview 聚合口径）；支出流水放表右侧区（日期/经手事由/金额 三列，
     形态与 importExcel.scanZone 横读一致——导出的表可再被 parseWorkbook 读回）
   - 对拍验收（1:1）：导出 → parseWorkbook 读回 → 作业/支出行数与金额合计一致
   ============================================================ */
'use strict';

const ExcelJS = require('exceljs');

/** U5 表头（与 importExcel.locateHeader 识别的列名逐字一致——往返的契约） */
const U5_HEADERS = ['日期', '姓名', '客户地址', '客户亩数', '价格亩/元', '应收金额', '实收金额',
  '作业目的', '业务来源', '作业人员', '收款人', '备注'];

/**
 * 构建月度工作簿。jobs=overview 聚合行（listOverview 输出，含 *_cents 分）；
 * pays=payments 行。按 job_date 月份分组 → 每月一 sheet。
 */
async function buildMonthlyWorkbook(jobs, pays) {
  const wb = new ExcelJS.Workbook();
  const byMonth = new Map();
  for (const j of jobs || []) {
    const m = String(j.job_date || '').slice(0, 7);
    if (!m) continue;
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(j);
  }
  const paysByMonth = new Map();
  for (const p of pays || []) {
    const m = String(p.occurred_at || '').slice(0, 7);
    if (!m) continue;
    if (!paysByMonth.has(m)) paysByMonth.set(m, []);
    paysByMonth.get(m).push(p);
  }
  const months = [...new Set([...byMonth.keys(), ...paysByMonth.keys()])].sort();
  if (!months.length) months.push('__empty__');
  for (const m of months) {
    const sheetName = m === '__empty__' ? '1月份' : `${Number(m.slice(5, 7))}月份`;
    const ws = wb.addWorksheet(sheetName);
    ws.addRow(U5_HEADERS);
    for (const j of byMonth.get(m) || []) {
      ws.addRow([
        j.job_date || '',
        j.customer_names || '',
        [j.village || '', j.team ? j.team + '队' : ''].filter(Boolean).join('') || (j.region || ''),
        j.total_area_mu != null ? Number(j.total_area_mu) : null,
        j.unit_price_cents != null ? j.unit_price_cents / 100 : null,
        j.amount_cents != null ? j.amount_cents / 100 : null,
        j.paid_cents != null ? j.paid_cents / 100 : null,
        j.plant_label || '',
        j.referral_name || '',
        Array.isArray(j.operator_names) ? j.operator_names.join('、') : '',
        j.collector_name || '',
        j.note || ''
      ]);
    }
    // 支出流水区（表右侧：日期/经手事由/金额；scanZone 横读形态——同列依次出现即被读回）
    const payRows = (paysByMonth.get(m) || []).filter(p => p.status !== 'void');
    if (payRows.length) {
      const startCol = 15; // U5 右侧流水区（列 O 起，与作业区留空两列）
      ws.getCell(1, startCol).value = '日期';
      ws.getCell(1, startCol + 1).value = '经手/事由';
      ws.getCell(1, startCol + 2).value = '金额';
      payRows.forEach((p, i) => {
        const r = i + 2;
        ws.getCell(r, startCol).value = String(p.occurred_at || '').slice(0, 10);
        ws.getCell(r, startCol + 1).value = `${p.payee_name || ''}${p.note ? ' ' + p.note : ''}`.trim() || '支出';
        ws.getCell(r, startCol + 2).value = p.amount_cents / 100;
      });
    }
    // 列宽（读回不依赖列宽，仅可读性）
    ws.getColumn(1).width = 12; ws.getColumn(2).width = 10; ws.getColumn(3).width = 16;
  }
  return wb;
}

module.exports = { buildMonthlyWorkbook, U5_HEADERS };
