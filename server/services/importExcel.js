/* ============================================================
   services/importExcel.js — 历史 Excel 导入（M8，纯规则解析）
   对象：植保收支明细类月度表（12 sheet，r2 表头，列漂移容忍）
   输出：staging 行（kind=job/expense + parsed + needs_review）
   规则依据：docs/PLAN.md §8（真实样本画像 2026-09-29）
   原则：只做确定性解析；一切拿不准的标 needs_review 交人工，
        绝不猜。原文/sheet/行号全保留（raw_import_rows.raw_text）。
   注意：exceljs 公式单元格 value={formula,result}，统一走 cellVal()。
   ============================================================ */
'use strict';

const { logEdit, nextBizNo } = require('./audit');
const { postEntry } = require('./journal');

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/* ---------- 单元格值解析（exceljs 公式/富文本对象） ---------- */

function cellVal(v) {
  if (v == null) return v;
  if (typeof v === 'object') {
    if (v instanceof Date) return v;
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
    if ('result' in v) return v.result;   // 公式单元格
    if ('text' in v) return v.text;       // 超链接
    if ('error' in v) return v.error;     // '#VALUE!' 等
    return v;
  }
  return v;
}

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

function cleanStr(v) { const x = cellVal(v); return x == null ? '' : String(x).trim().replace(/\u3000/g, ''); }

/* ---------- 村/队拆分 ---------- */

function splitAddress(raw) {
  const s = cleanStr(raw).replace(/\s+/g, '');
  const m = s.match(/^(.*?)(\d+|[一二三四五六七八九十]+)\s*队$/);
  if (m) {
    let team = m[2];
    if (CN_NUM[team]) team = String(CN_NUM[team]);
    return { village: m[1], team, flag: null };
  }
  if (!s) return { village: '', team: null, flag: '地址为空' };
  return { village: s, team: null, flag: null };
}

const DIRTY_ADDR = new Set(['已结算', '彰冠', '红拉', '大发', '[已移除]']); // 仅光秃镇名/残缺名可疑；红拉4队→红拉+4队是合法结构
function addressReview(village, team) {
  if (!village) return '地址为空';
  if (DIRTY_ADDR.has(village) && !team) return '地址残缺或非村名: ' + village;
  return null;
}

/* ---------- 日期 ---------- */

function fmt(y, mo, d) {
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * 日期解析。支持 Date 对象/Excel 序列号/'2026.1.14'/'5.5'/5.12(数字)。
 * 返回 { date, flag: null|'no-year'|'bad-year'|'numeric-date'|'invalid' }
 */
function parseDate(v, sheetYear) {
  if (v == null || v === '') return { date: null, flag: null };
  if (v instanceof Date && !isNaN(v)) {
    const y = v.getFullYear();
    return { date: fmt(y, v.getMonth() + 1, v.getDate()), flag: y < 2020 || y > 2030 ? 'bad-year' : null };
  }
  if (isNum(v)) {
    if (v > 30000) return parseDate(new Date(Math.round((v - 25569) * 86400000)), sheetYear);
    const month = Math.floor(v);
    if (month >= 1 && month <= 12) {
      const frac = v - month;
      let day = Math.round(frac * 100);
      if (day < 1 || day > 31) day = Math.round(frac * 10); // 2.4 → 2月4日（尾零丢失）
      if (day >= 1 && day <= 31) return { date: fmt(sheetYear, month, day), flag: 'numeric-date' };
    }
    return { date: null, flag: 'invalid' };
  }
  const s = cleanStr(v);
  if (!s) return { date: null, flag: null };
  if (/已结算|金额|支出/.test(s)) return { date: null, flag: 'invalid' };
  let m = s.match(/^(\d{4})[.\-\/年]\s*(\d{1,2})[.\-\/月]\s*(\d{1,2})日?$/);
  if (m) {
    const y = Number(m[1]);
    return { date: fmt(y, Number(m[2]), Number(m[3])), flag: y < 2020 || y > 2030 ? 'bad-year' : null };
  }
  m = s.match(/^(\d{1,2})[.\-\/](\d{1,2})$/);
  if (m) return { date: fmt(sheetYear, Number(m[1]), Number(m[2])), flag: 'no-year' };
  return { date: null, flag: 'invalid' };
}

/** 文本日期标签：'21号'/'2月12号'/'3.1号'（扩展区支出日期） */
function parseDateLabel(s, sheetYear, sheetMonth) {
  let m = s.match(/^(\d{1,2})\s*号$/);
  if (m) return { date: fmt(sheetYear, sheetMonth, Number(m[1])) };
  m = s.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*号?$/);
  if (m) return { date: fmt(sheetYear, Number(m[1]), Number(m[2])) };
  m = s.match(/^(\d{1,2})[.\-\/](\d{1,2})\s*号?$/);
  if (m) return { date: fmt(sheetYear, Number(m[1]), Number(m[2])) };
  return { date: null };
}

/* ---------- 人名 ---------- */

const PERSON_DIRTY = /(已结算|金额|支出|转|收$|家|^\d)/;
function buildStaffDict(values) {
  const freq = new Map();
  for (const v of values) {
    const s = cleanStr(v);
    if (!s || PERSON_DIRTY.test(s) || /\d/.test(s) || s.length > 4) continue;
    freq.set(s, (freq.get(s) || 0) + 1);
  }
  return new Set([...freq.entries()].filter(([, n]) => n >= 2).map(([k]) => k));
}

function splitOperators(raw, dict) {
  const s = cleanStr(raw);
  if (!s || PERSON_DIRTY.test(s) || /\d/.test(s)) return { names: [], flag: s ? '作业人员列非人名: ' + s : null };
  if (dict.has(s)) return { names: [s], flag: null };
  const names = [];
  let rest = s, progress = true;
  while (rest && progress) {
    progress = false;
    for (const name of [...dict].sort((a, b) => b.length - a.length)) {
      if (rest.startsWith(name)) { names.push(name); rest = rest.slice(name.length); progress = true; break; }
    }
  }
  if (rest) return { names, flag: '作业人员含无法切分片段: ' + rest + '（原文 ' + s + '）' };
  return { names, flag: null };
}

function personField(raw, dict) {
  const s = cleanStr(raw);
  if (!s) return { value: null, flag: null };
  if (PERSON_DIRTY.test(s) || /\d/.test(s)) return { value: null, flag: '可疑人名/备注: ' + s };
  if (dict.has(s)) return { value: s, flag: null };
  return { value: s, flag: '非常见人名（首次出现）: ' + s };
}

/* ---------- 支出分类 ---------- */

const EXPENSE_CATEGORY = [
  [/加油|柴油|油费/, 'fuel'],
  [/吃饭|餐|粉|烟/, 'meal'],
  [/水管|灯|电磁阀|传感器|电池|充电|泵|图传|湿纸巾|手套|配件|维修|修理|扳手|快接|倒车影像|宽带|话费|卡口|捆绑带/, 'equipment'],
  [/地勤|工资|工钱|人工/, 'labor'],
  [/药|壳虫/, 'chemical']
];
function expenseCategory(text) {
  for (const [re, cat] of EXPENSE_CATEGORY) if (re.test(text)) return cat;
  return 'other';
}
function categoryAccount(cat) {
  return { fuel: '5002', chemical: '5001', repair: '5003', meal: '5004', equipment: '5005', labor: '5006', other: '5005' }[cat] || '5005';
}

/* ---------- 支出扫描（分区，防误配） ---------- */

/**
 * 标准列对：类别列文本 + 金额列数值 → 干净对；
 *   类别列数字/金额列非数值 → dirty（人工）
 * 扩展区（标准金额列+1 起，到 20 列）：日期标签→类别文本→1..3 列内数值→[经手人]
 */
function scanExpenses(ws, r, inv, cmax, sheetYear, sheetMonth) {
  const out = [];
  const dirty = [];
  const stdCatCol = inv['支出类型'] || inv['支出项目'] || null;
  const stdAmtCol = inv['支出金额/元'] || (stdCatCol ? stdCatCol + 1 : null);

  if (stdCatCol && stdAmtCol) {
    const catRaw = cellVal(ws.getCell(r, stdCatCol).value);
    const amtRaw = cellVal(ws.getCell(r, stdAmtCol).value);
    const catS = cleanStr(catRaw);
    if (catS && catS !== '未收款' && !isNum(catRaw) && isNum(amtRaw) && amtRaw > 0) {
      out.push({ date: null, category_raw: catS, category: expenseCategory(catS), amount_cents: Math.round(amtRaw * 100), person: null, cells: `c${stdCatCol}/c${stdAmtCol}` });
    } else if (isNum(catRaw) && catRaw > 0) {
      dirty.push(`支出类型列是数字 c${stdCatCol}=${catRaw}（金额列 ${amtRaw ?? '空'}）——未入账`);
    } else if (catS && catS !== '未收款' && !isNum(amtRaw) && cleanStr(amtRaw)) {
      dirty.push(`支出金额列非数值 c${stdAmtCol}=${cleanStr(amtRaw)}（类别 ${catS}）——未入账`);
    }
  }

  const start = (stdAmtCol || 8) + 1;
  let expDate = null;
  let i = start;
  while (i <= cmax) {
    const v = cellVal(ws.getCell(r, i).value);
    const s = cleanStr(v);
    if (!s) { i++; continue; }
    if (!isNum(v)) {
      const dl = parseDateLabel(s, sheetYear, sheetMonth);
      if (dl.date) { expDate = dl.date; i++; continue; }
      const d = parseDate(s, sheetYear);
      if (d.date && /^\d/.test(s)) { expDate = d.date; i++; continue; }
      if (/^\d+号$/.test(s)) { dirty.push(`扩展区日期标签异常: ${s}（c${i}）——未入账`); i++; continue; }
      if (s.length <= 14 && !/已结算|转账|未收款|金额|支出|每人/.test(s) && !PERSON_DIRTY.test(s)) {
        for (let j = i + 1; j <= Math.min(i + 3, cmax); j++) {
          const a = cellVal(ws.getCell(r, j).value);
          if (isNum(a) && a > 0) {
            const personCell = cleanStr(cellVal(ws.getCell(r, j + 1).value));
            out.push({
              date: expDate, category_raw: s, category: expenseCategory(s),
              amount_cents: Math.round(a * 100),
              person: personCell && !/\d/.test(personCell) && !/[号月]/.test(personCell) ? personCell : null,
              cells: `c${i}/c${j}`
            });
            expDate = null;
            i = j + (personCell && !/[号月]/.test(personCell) ? 2 : 1);
            break;
          }
        }
      }
    }
    i++;
  }
  return { expenses: out, dirty };
}

/* ---------- 主解析 ---------- */

function parseWorkbook(wb) {
  const rows = [];
  const stats = { sheets: 0, jobs: 0, expenses: 0, skipped: 0, review: 0 };
  const allPersonValues = [];

  for (const ws of wb.worksheets) {
    for (let r = 1; r <= Math.min(ws.rowCount, 200); r++) {
      for (let c = 9; c <= 13; c++) allPersonValues.push(cellVal(ws.getCell(r, c).value));
    }
  }
  const dict = buildStaffDict(allPersonValues);

  for (const ws of wb.worksheets) {
    stats.sheets++;
    const sheetName = ws.name;
    const ym = sheetName.match(/(\d{1,2})\s*月份/);
    const sheetMonth = ym ? Number(ym[1]) : null;

    let hdrRow = null;
    const inv = {};
    for (let r = 1; r <= 5; r++) {
      const cells = {};
      for (let c = 1; c <= 16; c++) {
        const s = cleanStr(ws.getCell(r, c).value);
        if (s) cells[c] = s;
      }
      if (Object.values(cells).includes('日期') && Object.values(cells).includes('姓名')) {
        hdrRow = r;
        for (const [c, name] of Object.entries(cells)) inv[name] = Number(c);
        break;
      }
    }
    if (!hdrRow) { stats.skipped += ws.rowCount; continue; }

    const colDate = inv['日期'] || 1;
    let sheetYear = 2026;
    for (let r = hdrRow + 1; r <= ws.rowCount; r++) {
      const m = cleanStr(ws.getCell(r, colDate).value).match(/(20\d{2})/);
      if (m) { sheetYear = Number(m[1]); break; }
    }

    for (let r = hdrRow + 1; r <= ws.rowCount; r++) {
      const get = (name) => inv[name] ? cellVal(ws.getCell(r, inv[name]).value) : null;
      const rawDate = get('日期');
      const rawName = get('姓名');
      const rawAddr = get('客户地址');
      const rawArea = get('客户亩数');
      const rawPrice = inv['价格亩/元'] ? get('价格亩/元') : null;
      const rawRecv = get('应收金额');
      const rawPaid = get('实收金额');
      const rawPurpose = get('作业目的');
      const rawReferral = get('业务来源');
      const rawWorkers = get('作业人员');
      const rawCashier = get('收款人');
      const rawNote = get('备注');

      const texts = [];
      for (let c = 1; c <= Math.min(ws.columnCount, 20); c++) {
        const s = cleanStr(ws.getCell(r, c).value);
        if (s) texts.push(`c${c}=${s}`);
      }
      if (!texts.length) { stats.skipped++; continue; }
      const rawText = texts.join(' | ');

      if (texts.filter(t => t.includes('已结算')).length >= 3) { stats.skipped++; continue; }

      const needs = [];
      const name = cleanStr(rawName);
      const areaOk = isNum(rawArea) && rawArea > 0;
      const isJob = !!name && (areaOk || isNum(rawRecv));

      const zone = scanExpenses(ws, r, inv, Math.min(ws.columnCount, 20), sheetYear, sheetMonth);
      const expenses = zone.expenses;
      for (const d of zone.dirty) needs.push({ code: 'expense-zone', detail: d });

      if (!isJob) {
        for (const e of expenses) {
          const dRow = parseDate(rawDate, sheetYear);
          rows.push({ kind: 'expense', sheet: sheetName, row_no: r, raw_text: rawText,
            parsed: { ...e, date: e.date || (dRow.date && !dRow.flag ? dRow.date : e.date), note: null }, needs_review: [] });
          stats.expenses++;
        }
        if (!expenses.length) stats.skipped++;
        continue;
      }

      /* ---- 作业行 ---- */
      const pd = parseDate(rawDate, sheetYear);
      if (pd.flag === 'bad-year') needs.push({ code: 'date', detail: `年份可疑: ${cleanStr(rawDate)} → ${pd.date}` });
      if (pd.flag === 'numeric-date') needs.push({ code: 'date', detail: `日期为数字 ${cleanStr(rawDate)}，日份可能歧义 → ${pd.date}` });
      if ((pd.flag === 'invalid' || !pd.date) && cleanStr(rawDate)) needs.push({ code: 'date', detail: '日期无法解析: ' + cleanStr(rawDate) });
      let jobDate = pd.date;
      if (!jobDate) {
        jobDate = fmt(sheetYear, sheetMonth || 1, 1);
        needs.push({ code: 'date', detail: '日期缺失/不可解析，暂用当月 1 号: ' + jobDate });
      }

      const addr = splitAddress(rawAddr);
      const addrFlag = addressReview(addr.village, addr.team);
      if (addrFlag) needs.push({ code: 'address', detail: addrFlag + '（原文: ' + cleanStr(rawAddr) + '）' });

      const recvCents = isNum(rawRecv) ? Math.round(rawRecv * 100) : 0;
      if (!isNum(rawRecv) && cleanStr(rawRecv)) needs.push({ code: 'receivable', detail: '应收金额非数值: ' + cleanStr(rawRecv) });

      let paidCents = 0, discountCents = 0;
      if (rawPaid == null || cleanStr(rawPaid) === '') {
        if (cellVal(rawPaid) !== 0) needs.push({ code: 'paid', detail: '实收为空（按未收款处理）' });
      } else if (!isNum(rawPaid)) {
        const s = cleanStr(rawPaid);
        if (s === '未收款') paidCents = 0;
        else needs.push({ code: 'paid', detail: '实收列非数值: ' + s });
      } else {
        paidCents = Math.round(rawPaid * 100);
      }
      if (paidCents > recvCents && recvCents > 0) {
        needs.push({ code: 'overpaid', detail: `实收 ${cleanStr(rawPaid)} > 应收 ${cleanStr(rawRecv)}（收超 ${(paidCents - recvCents) / 100} 元）` });
      } else if (recvCents > paidCents) {
        const diff = recvCents - paidCents;
        if (diff <= 1000) discountCents = diff; // ≤10 元抹零；>10 元为欠款
      }

      const referral = cleanStr(rawReferral) || null;
      if (referral && (PERSON_DIRTY.test(referral) || /\d/.test(referral))) {
        needs.push({ code: 'referral', detail: '业务来源可疑: ' + referral });
      }
      const op = splitOperators(rawWorkers, dict);
      if (op.flag) needs.push({ code: 'operators', detail: op.flag });
      const cashier = personField(rawCashier, dict);
      if (cashier.flag) needs.push({ code: 'cashier', detail: cashier.flag });

      if (inv['备注']) {
        const v = cellVal(ws.getCell(r, inv['备注'] + 1).value);
        if (isNum(v) && v > 0) needs.push({ code: 'note-amount', detail: `备注右侧疑似金额 c${inv['备注'] + 1}=${v}（用途不明，未入账）` });
      }

      const parsed = {
        date: jobDate,
        name,
        village: addr.village,
        team: addr.team,
        address_raw: cleanStr(rawAddr),
        area_mu: areaOk ? rawArea : null,
        price_yuan: isNum(rawPrice) ? rawPrice : null,
        receivable_cents: recvCents,
        paid_cents: paidCents,
        discount_cents: discountCents,
        purpose: cleanStr(rawPurpose) || null,
        referral: referral && !PERSON_DIRTY.test(referral) && !/\d/.test(referral) ? referral : null,
        operators: op.names,
        collector: cashier.value,
        note: cleanStr(rawNote) || null
      };
      rows.push({ kind: 'job', sheet: sheetName, row_no: r, raw_text: rawText, parsed, needs_review: needs });
      stats.jobs++;
      if (needs.length) stats.review++;

      for (const e of expenses) {
        rows.push({ kind: 'expense', sheet: sheetName, row_no: r, raw_text: rawText,
          parsed: { ...e, note: '同行作业: ' + name }, needs_review: [] });
        stats.expenses++;
      }
    }
  }
  return { rows, stats };
}

/* ---------- 落库 apply ---------- */

function upsertImportParty(db, parsed) {
  let party = db.prepare(
    `SELECT * FROM parties WHERE type='customer' AND name=? AND IFNULL(village,'')=? AND IFNULL(team,'')=? AND deleted_at IS NULL`)
    .get(parsed.name, parsed.village || '', parsed.team || '');
  if (!party) {
    party = db.prepare(
      `SELECT * FROM parties WHERE type='customer' AND name=? AND village IS NULL AND deleted_at IS NULL`)
      .get(parsed.name);
  }
  if (!party) {
    const now = new Date().toISOString();
    const info = db.prepare(
      `INSERT INTO parties (type, name, village, team, source, created_at, updated_at)
       VALUES ('customer', ?, ?, ?, 'import', ?, ?)`)
      .run(parsed.name, parsed.village || null, parsed.team || null, now, now);
    party = { id: info.lastInsertRowid };
  }
  return party.id;
}

/** 落库一个 confirmed 作业行（party→job→settlement→bill→receipt→分录），调用方事务内执行 */
function applyJobRow(db, parsed, batchId, rowId, operator) {
  const now = new Date().toISOString();
  const partyId = upsertImportParty(db, parsed);

  const jobNo = `IMP-${batchId}-${rowId}`;
  const jobInfo = db.prepare(
    `INSERT INTO jobs (job_no, client_job_id, job_type, status, job_date, note, operator_names, source,
       plant_type_name, total_area_mu, income_cents, total_cost_cents, profit_cents, referral_name,
       raw_json, created_at, updated_at)
     VALUES (?, ?, 'spray', 'settled', ?, ?, ?, 'import', ?, ?, ?, 0, ?, ?, ?, ?, ?)`
  ).run(
    jobNo, `import-${batchId}-${rowId}`, parsed.date, parsed.note || null,
    JSON.stringify(parsed.operators || []), parsed.purpose || null,
    parsed.area_mu, parsed.receivable_cents, parsed.receivable_cents,
    parsed.referral || null,
    JSON.stringify({ batch_id: batchId, row_id: rowId, raw: parsed }),
    now, now
  );
  const jobId = jobInfo.lastInsertRowid;
  db.prepare(
    `INSERT INTO job_settlement_lines (job_id, farmer_ref, farmer_name, area_mu, spray_fee_cents, included)
     VALUES (?, ?, ?, ?, ?, 0)`)
    .run(jobId, String(partyId), parsed.name, parsed.area_mu, parsed.receivable_cents);

  const settlementNo = nextBizNo(db, 'settlements', 'settlement_no', 'S');
  const sInfo = db.prepare(
    `INSERT INTO settlements (settlement_no, job_id, status, total_spray_fee_cents, total_pesticide_fee_cents,
       total_receivable_cents, confirmed_at, created_at, updated_at)
     VALUES (?, ?, 'confirmed', ?, 0, ?, ?, ?, ?)`)
    .run(settlementNo, jobId, parsed.receivable_cents, parsed.receivable_cents, now, now, now);
  const sid = sInfo.lastInsertRowid;
  db.prepare(
    `INSERT INTO settlement_items (settlement_id, party_id, farmer_name, area_mu, spray_fee_cents, included)
     VALUES (?, ?, ?, ?, ?, 0)`)
    .run(sid, partyId, parsed.name, parsed.area_mu, parsed.receivable_cents);

  const billNo = nextBizNo(db, 'bills', 'bill_no', 'B');
  const bInfo = db.prepare(
    `INSERT INTO bills (bill_no, settlement_id, party_id, farmer_name, amount_cents, adjust_cents, paid_cents,
       status, issued_at, note, opening, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'unpaid', ?, ?, 0, ?, ?)`)
    .run(billNo, sid, partyId, parsed.name, parsed.receivable_cents, parsed.discount_cents || 0,
      parsed.date, '导入 ' + jobNo, now, now);
  const billId = bInfo.lastInsertRowid;

  if (parsed.receivable_cents > 0) {
    postEntry(db, {
      event_type: 'settlement_confirm', ref_type: 'settlement', ref_id: sid,
      occurred_at: parsed.date || now, memo: '导入结算 ' + settlementNo + '（' + parsed.name + '）',
      lines: [
        { account_code: '1122', direction: 'debit', amount_cents: parsed.receivable_cents, party_id: partyId, job_id: jobId, memo: '应收 ' + billNo },
        { account_code: '6001', direction: 'credit', amount_cents: parsed.receivable_cents, party_id: partyId, job_id: jobId, memo: '作业收入 ' + parsed.name }
      ]
    });
  }

  if (parsed.paid_cents > 0) {
    const receiptNo = nextBizNo(db, 'receipts', 'receipt_no', 'R');
    const payable = parsed.receivable_cents - (parsed.discount_cents || 0);
    const rInfo = db.prepare(
      `INSERT INTO receipts (receipt_no, bill_id, party_id, amount_cents, method, occurred_at, note, status, collector_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'other', ?, ?, 'active', ?, ?, ?)`)
      .run(receiptNo, billId, partyId, parsed.paid_cents, parsed.date || now,
        '导入实收' + (parsed.discount_cents ? '（含抹零 ' + parsed.discount_cents / 100 + ' 元）' : ''),
        parsed.collector || null, now, now);
    const rid = rInfo.lastInsertRowid;
    db.prepare('UPDATE bills SET paid_cents = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(parsed.paid_cents, parsed.paid_cents >= payable ? 'paid' : 'partial', now, billId);
    postEntry(db, {
      event_type: 'receipt', ref_type: 'receipt', ref_id: rid,
      occurred_at: parsed.date || now, memo: '导入收款 ' + receiptNo + '（' + parsed.name + '）',
      lines: [
        { account_code: '1001', direction: 'debit', amount_cents: parsed.paid_cents, party_id: partyId, memo: '收款' },
        { account_code: '1122', direction: 'credit', amount_cents: parsed.paid_cents, party_id: partyId, memo: '核销 ' + billNo }
      ]
    });
  }

  logEdit(db, { table: 'jobs', recordId: jobId, action: 'create',
    after: { job_no: jobNo, batch: batchId, row: rowId }, operator });
  return { job_id: jobId, bill_id: billId, party_id: partyId };
}

/** 落库一个 confirmed 支出行 */
function applyExpenseRow(db, parsed, batchId, rowId, operator) {
  const now = new Date().toISOString();
  const paymentNo = nextBizNo(db, 'payments', 'payment_no', 'P');
  const info = db.prepare(
    `INSERT INTO payments (payment_no, category, amount_cents, occurred_at, note, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`)
    .run(paymentNo, parsed.category, parsed.amount_cents, parsed.date || now,
      `[导入 ${batchId}-${rowId}] ${parsed.category_raw}${parsed.person ? '（' + parsed.person + '）' : ''}${parsed.note ? ' ' + parsed.note : ''}`,
      now, now);
  const pid = info.lastInsertRowid;
  postEntry(db, {
    event_type: 'payment', ref_type: 'payment', ref_id: pid,
    occurred_at: parsed.date || now, memo: '导入支出 ' + paymentNo + '（' + parsed.category_raw + '）',
    lines: [
      { account_code: categoryAccount(parsed.category), direction: 'debit', amount_cents: parsed.amount_cents, memo: parsed.category_raw },
      { account_code: '1001', direction: 'credit', amount_cents: parsed.amount_cents, memo: '付款' }
    ]
  });
  logEdit(db, { table: 'payments', recordId: pid, action: 'create',
    after: { payment_no: paymentNo, batch: batchId, row: rowId }, operator });
  return { payment_id: pid };
}

module.exports = { parseWorkbook, applyJobRow, applyExpenseRow, splitAddress, parseDate, splitOperators, buildStaffDict, expenseCategory, cellVal };
