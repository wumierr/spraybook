/* ============================================================
   services/importExcel.js — 历史 Excel 导入 v2（P2，按用户裁决 A–G）
   裁决来源：docs/HANDOFF-P2.md §3。要点：
   - B 应收/实收独立：实收>应收照记（paid 可超应收），小额抹零保留
   - C/G 右侧区横读流水：日期→[经手/事由]→金额 = 支出；作业人员列里的
     日期属于流水，不属于作业人员
   - D 标准类别列数字+金额列数值 = (单价,收入) 对，按已收落库
   - E 实收列人名/手写数字串：实收=应收 / 忽略留 raw
   - F 地址三段 region+village+team；人名当地址弃用
   - 坏年份(2016/2056)自动改 sheet 年份；数字日期按解析值接受
   原则：只做确定性解析；真疑难标 needs_review；原文/sheet/行号全保留。
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

/* ---------- 村/队/大区域 三段拆分（裁决 F） ---------- */

const REGION_TOWNS = ['通安', '彰冠', '鹿厂', '铜矿']; // 会理已知乡镇前缀，可后台维护
// 仅整格等于这些值时视为脏（人名当地址=乱填、合计行标记）
const DIRTY_ADDR = new Set(['已结算', '[已移除]']);

function splitAddress(raw) {
  let s = cleanStr(raw).replace(/\s+/g, '');
  if (!s) return { region: null, village: '', team: null, flag: '地址为空' };
  if (DIRTY_ADDR.has(s)) return { region: null, village: '', team: null, flag: '地址乱填/无效: ' + s + '（弃用）' };
  let team = null;
  const mT = s.match(/^(.*?)(\d+|[一二三四五六七八九十]+)\s*队$/);
  if (mT) {
    team = CN_NUM[mT[2]] ? String(CN_NUM[mT[2]]) : mT[2];
    s = mT[1];
  }
  let region = null;
  for (const t of REGION_TOWNS) {
    if (s.startsWith(t) && s.length > t.length) { region = t; s = s.slice(t.length); break; }
  }
  return { region, village: s || null, team, flag: s ? null : '地址只有大区域无村名: ' + region };
}

/* ---------- 日期 ---------- */

function fmt(y, mo, d) {
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * 日期解析（裁决 A：以实际填写为主）。
 * 坏年份(2016/2056 等)自动改 sheetYear（裁决：明显笔误直接改 2026）；
 * 数字日期(3.19/5.12/2.4)按解析值接受；真正解析不了返回 invalid。
 */
function parseDate(v, sheetYear) {
  if (v == null || v === '') return { date: null, flag: null };
  if (v instanceof Date && !isNaN(v)) {
    return { date: fmt(v.getFullYear(), v.getMonth() + 1, v.getDate()), flag: null };
  }
  if (isNum(v)) {
    if (v > 30000) return parseDate(new Date(Math.round((v - 25569) * 86400000)), sheetYear);
    const month = Math.floor(v);
    if (month >= 1 && month <= 12) {
      const frac = v - month;
      let day = Math.round(frac * 100);
      if (day < 1 || day > 31) day = Math.round(frac * 10); // 2.4 → 2月4日（尾零丢失）
      if (day >= 1 && day <= 31) return { date: fmt(sheetYear, month, day), flag: null };
    }
    return { date: null, flag: 'invalid' };
  }
  const s = cleanStr(v);
  if (!s) return { date: null, flag: null };
  if (/已结算|金额|支出/.test(s)) return { date: null, flag: 'invalid' };
  let m = s.match(/^(\d{4})[.\-\/年]\s*(\d{1,2})[.\-\/月]\s*(\d{1,2})日?$/);
  if (m) {
    let y = Number(m[1]);
    if (y < 2020 || y > 2030) y = sheetYear; // 坏年份自动修正（裁决）
    return { date: fmt(y, Number(m[2]), Number(m[3])), flag: null };
  }
  m = s.match(/^(\d{1,2})[.\-\/](\d{1,2})$/);
  if (m) return { date: fmt(sheetYear, Number(m[1]), Number(m[2])), flag: null };
  return { date: null, flag: 'invalid' };
}

/** 文本日期标签：'21号'/'2月12号'/'3.1号'/'4.18'（流水区日期） */
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

/** 人名样文本：能被人名字典完整切分（含合并名）——避免流水区吃掉人名列 */
function isPersonLike(s, dict) {
  if (dict.has(s)) return true;
  const so = splitOperators(s, dict);
  return so.names.length > 0 && !so.flag;
}

/* ---------- 支出分类 ---------- */

const EXPENSE_CATEGORY = [
  [/加油|柴油|油费/, 'fuel'],
  [/吃饭|餐|粉|烟/, 'meal'],
  [/水管|灯|电磁阀|传感器|电池|充电|泵|图传|湿纸巾|手套|配件|维修|修理|扳手|快接|倒车影像|宽带|话费|卡口|捆绑带/, 'equipment'],
  [/地勤|工资|工钱|人工|转/, 'labor'],
  [/药|壳虫/, 'chemical']
];
function expenseCategory(text) {
  for (const [re, cat] of EXPENSE_CATEGORY) if (re.test(text)) return cat;
  return 'other';
}
function categoryAccount(cat) {
  return { fuel: '5002', chemical: '5001', repair: '5003', meal: '5004', equipment: '5005', labor: '5006', other: '5005' }[cat] || '5005';
}

/* ---------- 右侧区横读流水（裁决 C/G，v2 核心） ---------- */

/**
 * 把 c9..cmax 的 token 横读成流水：
 *   日期标签(含作业人员列里的 4.18/5.9 等)开新记录 → 文本=经手/事由 → 数值=金额
 * 标准列对（支出类型/金额）：
 *   文本类别+数值金额 → 支出；数值单价(5..500)+数值金额 → 收入对(单价,收入)（裁决 D，按已收）
 * 返回 { expenses, income_pairs, consumed:Set<col>, dirty }
 * ⚠ 与 routes/import.js 的对账探针规则必须同步修改（双向绑定，见两处注释）。
 */
function scanZone(ws, r, inv, cmax, sheetYear, sheetMonth, dict) {
  const out = { expenses: [], income_pairs: [], consumed: new Set(), dirty: [] };
  const stdCatCol = inv['支出类型'] || inv['支出项目'] || null;
  const stdAmtCol = inv['支出金额/元'] || (stdCatCol ? stdCatCol + 1 : null);

  if (stdCatCol && stdAmtCol) {
    const catRaw = cellVal(ws.getCell(r, stdCatCol).value);
    const amtRaw = cellVal(ws.getCell(r, stdAmtCol).value);
    const catS = cleanStr(catRaw);
    if (catS && catS !== '未收款' && !isNum(catRaw) && isNum(amtRaw) && amtRaw > 0) {
      out.expenses.push({ date: null, category_raw: catS, category: expenseCategory(catS), amount_cents: Math.round(amtRaw * 100), person: null, desc: catS, cells: `c${stdCatCol}/c${stdAmtCol}` });
      out.consumed.add(stdCatCol); out.consumed.add(stdAmtCol);
    } else if (isNum(catRaw) && isNum(amtRaw) && catRaw >= 5 && catRaw <= 500 && amtRaw > 0) {
      // 裁决 D：单价标准 + 按该标准的收入
      out.income_pairs.push({ price_yuan: catRaw, income_cents: Math.round(amtRaw * 100), cells: `c${stdCatCol}/c${stdAmtCol}` });
      out.consumed.add(stdCatCol); out.consumed.add(stdAmtCol);
    } else if (isNum(catRaw) && isNum(amtRaw)) {
      out.dirty.push(`标准列数字对超出单价量级 c${stdCatCol}=${catRaw}/c${stdAmtCol}=${amtRaw}——未入账`);
    }
    // cat 文本 + amt 非数值（5月"[已移除]收/应转[已移除]"）→ 裁决 E：忽略
  }

  // 状态机横读：日期开记录 → 文本进 desc → 数值闭合为支出
  const start = Math.min(stdCatCol || 99, 9);
  let cur = null; // {date, texts:[]}
  let i = start;
  while (i <= cmax) {
    if (out.consumed.has(i)) { i++; continue; }
    const v = cellVal(ws.getCell(r, i).value);
    const s = cleanStr(v);
    if (!s) { i++; continue; }
    if (!isNum(v)) {
      const dl = parseDateLabel(s, sheetYear, sheetMonth);
      const d2 = dl.date || (parseDate(s, sheetYear).date && /^\d/.test(s) ? parseDate(s, sheetYear).date : null);
      if (d2) {
        // 日期 token：开新流水记录（旧记录无金额则丢弃，如覆盖区表头行）
        cur = { date: d2, texts: [] };
        out.consumed.add(i);
        i++;
        continue;
      }
      if (/已结算/.test(s)) { i++; continue; }
      if (s.length <= 14) {
        if (cur) cur.texts.push(s);            // 经手/事由
        else if (isPersonLike(s, dict)) { i++; continue; } // 人名（含合并名）→ 属作业人员/收款人列，不当流水
        else cur = { date: null, texts: [s] }; // 无日期锚点也开记录（日期 token 会重置）
        out.consumed.add(i);
        i++;
        continue;
      }
      i++;
      continue;
    }
    // 数值 token：先判日期形态（4.18/5.9 这类数值日期在本表大量出现）
    if (v > 0 && v < 13.32) {
      const pdNum = parseDate(v, sheetYear);
      if (pdNum.date) {
        cur = { date: pdNum.date, texts: [] };
        out.consumed.add(i);
        i++;
        continue;
      }
    }
    if (v > 0) {
      if (cur) {
        out.expenses.push({
          date: cur.date, category_raw: cur.texts.join(' ') || '(未注明)', category: expenseCategory(cur.texts.join(' ')),
          amount_cents: Math.round(v * 100), person: null, desc: cur.texts.join(' '), cells: `c${i}`
        });
        out.consumed.add(i);
        cur = null;
        i++;
        continue;
      }
      // 无锚点数字（累计栏/覆盖区）→ 忽略留 raw（裁决 E）；收入对只在标准列识别
    }
    i++;
  }
  return out;
}

/* ---------- 主解析 ---------- */

function parseWorkbook(wb) {
  const rows = [];
  const stats = { sheets: 0, jobs: 0, expenses: 0, incomes: 0, skipped: 0, review: 0 };
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

      const zone = scanZone(ws, r, inv, Math.min(ws.columnCount, 20), sheetYear, sheetMonth, dict);
      const expenses = zone.expenses;
      const incomePairs = zone.income_pairs;
      for (const d of zone.dirty) needs.push({ code: 'expense-zone', detail: d });

      if (!isJob) {
        const dRow = parseDate(rawDate, sheetYear);
        for (const e of expenses) {
          rows.push({ kind: 'expense', sheet: sheetName, row_no: r, raw_text: rawText,
            parsed: { ...e, date: e.date || (dRow.date && !dRow.flag ? dRow.date : e.date), note: null }, needs_review: [] });
          stats.expenses++;
        }
        for (const ip of incomePairs) {
          // 无作业行的收入对（罕见）：留复核确认归属
          rows.push({ kind: 'income_pair', sheet: sheetName, row_no: r, raw_text: rawText,
            parsed: { ...ip }, needs_review: [{ code: 'income-pair', detail: '无作业行的收入对，请确认归属' }] });
          stats.review++;
        }
        if (!expenses.length && !incomePairs.length) stats.skipped++;
        continue;
      }

      /* ---- 作业行 ---- */
      const pd = parseDate(rawDate, sheetYear);
      if ((pd.flag === 'invalid' || !pd.date) && cleanStr(rawDate)) needs.push({ code: 'date', detail: '日期无法解析: ' + cleanStr(rawDate) });
      let jobDate = pd.date;
      if (!jobDate) {
        jobDate = fmt(sheetYear, sheetMonth || 1, 1);
        needs.push({ code: 'date', detail: '日期缺失/不可解析，暂用当月 1 号: ' + jobDate });
      }

      const addr = splitAddress(rawAddr);
      const addrFlag = addr.flag || (addr.village ? null : '地址为空');
      if (addrFlag) needs.push({ code: 'address', detail: addrFlag + '（原文: ' + cleanStr(rawAddr) + '）' });

      const recvCents = isNum(rawRecv) ? Math.round(rawRecv * 100) : 0;
      if (!isNum(rawRecv) && cleanStr(rawRecv)) needs.push({ code: 'receivable', detail: '应收金额非数值: ' + cleanStr(rawRecv) });

      // 实收（裁决 B/E）：实收>应收照记；实收列人名 → 实收=应收，原文进备注
      let paidCents = 0, discountCents = 0, paidNote = '';
      if (rawPaid == null || cleanStr(rawPaid) === '') {
        if (cellVal(rawPaid) !== 0) needs.push({ code: 'paid', detail: '实收为空（按未收款处理）' });
      } else if (!isNum(rawPaid)) {
        const s = cleanStr(rawPaid);
        if (s === '未收款') paidCents = 0;
        else if (recvCents > 0) { paidCents = recvCents; paidNote = '实收列原文: ' + s; } // 裁决 E
        else needs.push({ code: 'paid', detail: '实收列非数值: ' + s });
      } else {
        paidCents = Math.round(rawPaid * 100);
      }
      // D 收入对按已收：并入实收
      let extraIncomeCents = 0;
      for (const ip of incomePairs) extraIncomeCents += ip.income_cents;
      const totalPaid = paidCents + extraIncomeCents;
      if (recvCents > paidCents && extraIncomeCents === 0) {
        const diff = recvCents - paidCents;
        if (diff <= 1000) discountCents = diff; // ≤10 元抹零；其余为欠款
      }

      const referral = cleanStr(rawReferral) || null;
      if (referral && (PERSON_DIRTY.test(referral) || /\d/.test(referral))) {
        needs.push({ code: 'referral', detail: '业务来源可疑: ' + referral });
      }
      // 作业人员/收款人/备注列：被流水消费的列不再当脏数据（裁决 C/G）
      const op = zone.consumed.has(inv['作业人员']) ? { names: [], flag: null } : splitOperators(rawWorkers, dict);
      if (op.flag) needs.push({ code: 'operators', detail: op.flag });
      const cashier = zone.consumed.has(inv['收款人']) ? { value: null, flag: null } : personField(rawCashier, dict);
      if (cashier.flag) needs.push({ code: 'cashier', detail: cashier.flag });
      if (inv['备注'] && !zone.consumed.has(inv['备注'] + 1)) {
        const v = cellVal(ws.getCell(r, inv['备注'] + 1).value);
        if (isNum(v) && v > 0 && !zone.consumed.has(inv['备注'] + 1)) needs.push({ code: 'note-amount', detail: `备注右侧疑似金额 c${inv['备注'] + 1}=${v}（用途不明，未入账）` });
      }

      const parsed = {
        date: jobDate,
        name,
        region: addr.region,
        village: addr.village,
        team: addr.team,
        address_raw: cleanStr(rawAddr),
        area_mu: areaOk ? rawArea : null,
        price_yuan: isNum(rawPrice) ? rawPrice : null,
        receivable_cents: recvCents,
        paid_cents: paidCents,
        extra_income: incomePairs.map(ip => ({ price_yuan: ip.price_yuan, income_cents: ip.income_cents })),
        extra_income_cents: extraIncomeCents,
        discount_cents: discountCents,
        purpose: cleanStr(rawPurpose) || null,
        referral: referral && !PERSON_DIRTY.test(referral) && !/\d/.test(referral) ? referral : null,
        operators: op.names,
        collector: cashier.value,
        note: [cleanStr(rawNote), paidNote].filter(Boolean).join('；') || null
      };
      rows.push({ kind: 'job', sheet: sheetName, row_no: r, raw_text: rawText, parsed, needs_review: needs });
      stats.jobs++;
      if (extraIncomeCents) stats.incomes++;
      if (needs.length) stats.review++;

      for (const e of expenses) {
        rows.push({ kind: 'expense', sheet: sheetName, row_no: r, raw_text: rawText,
          parsed: { ...e, date: e.date || jobDate, note: '同行作业: ' + name }, needs_review: [] });
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
      `INSERT INTO parties (type, name, region, village, team, source, created_at, updated_at)
       VALUES ('customer', ?, ?, ?, ?, 'import', ?, ?)`)
      .run(parsed.name, parsed.region || null, parsed.village || null, parsed.team || null, now, now);
    party = { id: info.lastInsertRowid };
  }
  return party.id;
}

/** 落库一个 confirmed 作业行（party→job→settlement→bill→receipt→分录），调用方事务内执行 */
function applyJobRow(db, parsed, batchId, rowId, operator) {
  const now = new Date().toISOString();
  const partyId = upsertImportParty(db, parsed);

  const extraIncome = parsed.extra_income_cents || 0;
  const totalReceivable = (parsed.receivable_cents || 0) + extraIncome;
  const totalPaid = (parsed.paid_cents || 0) + extraIncome; // 裁决 D：按已收

  const jobNo = nextBizNo(db, 'jobs', 'job_no', 'J', parsed.date); // 可读单号 J+日期-当日序号
  const jobInfo = db.prepare(
    `INSERT INTO jobs (job_no, client_job_id, job_type, status, job_date, note, operator_names, source,
       plant_type_name, total_area_mu, income_cents, total_cost_cents, profit_cents, referral_name,
       raw_json, created_at, updated_at)
     VALUES (?, ?, 'spray', 'settled', ?, ?, ?, 'import', ?, ?, ?, 0, ?, ?, ?, ?, ?)`
  ).run(
    jobNo, `import-${batchId}-${rowId}`, parsed.date, parsed.note || null,
    JSON.stringify(parsed.operators || []), parsed.purpose || null,
    parsed.area_mu, totalReceivable, totalReceivable,
    parsed.referral || null,
    JSON.stringify({ batch_id: batchId, row_id: rowId, raw: parsed }),
    now, now
  );
  const jobId = jobInfo.lastInsertRowid;
  db.prepare(
    `INSERT INTO job_settlement_lines (job_id, farmer_ref, farmer_name, area_mu, spray_fee_cents, included)
     VALUES (?, ?, ?, ?, ?, 0)`)
    .run(jobId, String(partyId), parsed.name, parsed.area_mu, parsed.receivable_cents || 0);
  for (const ip of (parsed.extra_income || [])) {
    db.prepare(
      `INSERT INTO job_settlement_lines (job_id, farmer_ref, farmer_name, area_mu, spray_fee_cents, included)
       VALUES (?, ?, ?, NULL, ?, 0)`)
      .run(jobId, String(partyId), `${parsed.name}（另按 ${ip.price_yuan} 元/亩）`, ip.income_cents);
  }

  const settlementNo = nextBizNo(db, 'settlements', 'settlement_no', 'S');
  const sInfo = db.prepare(
    `INSERT INTO settlements (settlement_no, job_id, status, total_spray_fee_cents, total_pesticide_fee_cents,
       total_receivable_cents, confirmed_at, created_at, updated_at)
     VALUES (?, ?, 'confirmed', ?, 0, ?, ?, ?, ?)`)
    .run(settlementNo, jobId, totalReceivable, totalReceivable, now, now, now);
  const sid = sInfo.lastInsertRowid;
  db.prepare(
    `INSERT INTO settlement_items (settlement_id, party_id, farmer_name, area_mu, spray_fee_cents, included)
     VALUES (?, ?, ?, ?, ?, 0)`)
    .run(sid, partyId, parsed.name, parsed.area_mu, parsed.receivable_cents || 0);
  for (const ip of (parsed.extra_income || [])) {
    db.prepare(
      `INSERT INTO settlement_items (settlement_id, party_id, farmer_name, area_mu, spray_fee_cents, included, note)
       VALUES (?, ?, ?, NULL, ?, 0, ?)`)
      .run(sid, partyId, `${parsed.name}（另按 ${ip.price_yuan} 元/亩）`, ip.income_cents, '裁决 D：单价标准+收入，按已收');
  }

  const billNo = nextBizNo(db, 'bills', 'bill_no', 'B');
  const bInfo = db.prepare(
    `INSERT INTO bills (bill_no, settlement_id, party_id, farmer_name, amount_cents, adjust_cents, paid_cents,
       status, issued_at, note, opening, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'unpaid', ?, ?, 0, ?, ?)`)
    .run(billNo, sid, partyId, parsed.name, totalReceivable, parsed.discount_cents || 0,
      parsed.date, '导入 ' + jobNo, now, now);
  const billId = bInfo.lastInsertRowid;

  if (totalReceivable > 0) {
    postEntry(db, {
      event_type: 'settlement_confirm', ref_type: 'settlement', ref_id: sid,
      occurred_at: parsed.date || now, memo: '导入结算 ' + settlementNo + '（' + parsed.name + '）',
      lines: [
        { account_code: '1122', direction: 'debit', amount_cents: totalReceivable, party_id: partyId, job_id: jobId, memo: '应收 ' + billNo },
        { account_code: '6001', direction: 'credit', amount_cents: totalReceivable, party_id: partyId, job_id: jobId, memo: '作业收入 ' + parsed.name }
      ]
    });
  }

  if (totalPaid > 0) {
    const receiptNo = nextBizNo(db, 'receipts', 'receipt_no', 'R');
    const payable = totalReceivable - (parsed.discount_cents || 0);
    const rInfo = db.prepare(
      `INSERT INTO receipts (receipt_no, bill_id, party_id, amount_cents, method, occurred_at, note, status, collector_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'other', ?, ?, 'active', ?, ?, ?)`)
      .run(receiptNo, billId, partyId, totalPaid, parsed.date || now,
        '导入实收' + (parsed.discount_cents ? '（含抹零 ' + parsed.discount_cents / 100 + ' 元）' : '') + (extraIncome ? '（含单价标准收入 ' + extraIncome / 100 + ' 元）' : ''),
        parsed.collector || null, now, now);
    const rid = rInfo.lastInsertRowid;
    db.prepare('UPDATE bills SET paid_cents = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(totalPaid, totalPaid >= payable ? 'paid' : 'partial', now, billId);
    postEntry(db, {
      event_type: 'receipt', ref_type: 'receipt', ref_id: rid,
      occurred_at: parsed.date || now, memo: '导入收款 ' + receiptNo + '（' + parsed.name + '）',
      lines: [
        { account_code: '1001', direction: 'debit', amount_cents: totalPaid, party_id: partyId, memo: '收款' },
        { account_code: '1122', direction: 'credit', amount_cents: totalPaid, party_id: partyId, memo: '核销 ' + billNo }
      ]
    });
    logEdit(db, { table: 'receipts', recordId: rid, action: 'create', after: { receipt_no: receiptNo, batch: batchId, row: rowId }, operator });
  }

  logEdit(db, { table: 'settlements', recordId: sid, action: 'create', after: { settlement_no: settlementNo, batch: batchId }, operator });
  logEdit(db, { table: 'bills', recordId: billId, action: 'create', after: { bill_no: billNo, batch: batchId }, operator });
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
      `[导入 ${batchId}-${rowId}] ${parsed.category_raw}${parsed.person ? '（' + parsed.person + '）' : ''}${parsed.desc && parsed.desc !== parsed.category_raw ? ' ' + parsed.desc : ''}${parsed.note ? ' ' + parsed.note : ''}`,
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

module.exports = { parseWorkbook, applyJobRow, applyExpenseRow, splitAddress, parseDate, splitOperators, buildStaffDict, expenseCategory, cellVal, scanZone };
