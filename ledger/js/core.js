/* ============================================================
   ledger/js/core.js — 纯函数层（数据变换与格式化，node:test 可测）
   渲染层 app.js 只做 DOM；本文件不碰 DOM / fetch。
   ============================================================ */
(function () {
  'use strict';

  /** 分 → 元字符串（两位小数；负数用于抹零） */
  function fmtYuan(cents) {
    if (cents == null || isNaN(cents)) return '—';
    const yuan = cents / 100;
    return yuan.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** 元输入框值 → 分（Math.round(×100)）；空返回 null；非法返回 NaN */
  function yuanInputToCents(v) {
    if (v === '' || v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return NaN;
    return Math.round(n * 100);
  }

  const JOB_STATUS = {
    draft: '草稿', completed: '待结算', settled: '已结算', reopened: '已重开', void: '已作废'
  };
  const SETTLEMENT_STATUS = { draft: '待确认', confirmed: '已确认', void: '已作废' };
  const BILL_STATUS = { unpaid: '未收', partial: '部分收款', paid: '已收清', void: '已作废' };
  const PAYMENT_CATEGORY = {
    fuel: '油费', chemical: '药费', repair: '维修', meal: '吃饭',
    equipment: '设备', labor: '人工', other: '其他'
  };
  const ADVANCE_DIRECTION = { prepaid_by_customer: '客户预收', advance_to_worker: '员工预支' };
  const METHOD = { cash: '现金', wechat: '微信', alipay: '支付宝', bank: '银行', other: '其他' };
  const PARTY_TYPE = { customer: '客户', employee: '员工', partner: '合作方', supplier: '供应商' };

  function statusLabel(map, status) { return map[status] || status || '—'; }

  /** 账单应收 = 金额 + 调整（adjust 负数=抹零/优惠） */
  function billPayable(bill) { return (bill.amount_cents || 0) + (bill.adjust_cents || 0); }
  /** 账单未收余额 */
  function billUnpaid(bill) { return billPayable(bill) - (bill.paid_cents || 0); }

  /** 作业行摘要（列表用） */
  function jobRow(job) {
    return {
      id: job.id, job_no: job.job_no, job_date: (job.job_date || '').slice(0, 10),
      type: job.job_type === 'haul' ? '吊运' : '打药', status: job.status,
      statusText: statusLabel(JOB_STATUS, job.status),
      primary: job.job_type === 'haul'
        ? (job.weight_jin != null ? job.weight_jin + ' 斤' : '—')
        : (job.total_area_mu != null ? job.total_area_mu + ' 亩' : '—'),
      incomeYuan: fmtYuan(job.income_cents),
      canSettle: job.status === 'completed' || job.status === 'reopened',
      canVoid: job.status === 'completed' || job.status === 'draft',
      canEditLines: job.status === 'completed' || job.status === 'reopened'
    };
  }

  /** 结算行摘要 */
  function settlementRow(s) {
    return {
      id: s.id, settlement_no: s.settlement_no, job_no: s.job_no, job_date: (s.job_date || '').slice(0, 10),
      status: s.status, statusText: statusLabel(SETTLEMENT_STATUS, s.status),
      sprayYuan: fmtYuan(s.total_spray_fee_cents), pesticideYuan: fmtYuan(s.total_pesticide_fee_cents),
      totalYuan: fmtYuan(s.total_receivable_cents), paidYuan: fmtYuan(s.paid_cents),
      canEdit: s.status === 'draft', canConfirm: s.status === 'draft',
      canReopen: s.status === 'confirmed', canVoid: s.status !== 'void'
    };
  }

  /** 账单行摘要 */
  function billRow(b) {
    return {
      id: b.id, bill_no: b.bill_no, party_id: b.party_id, party: b.party_name || b.farmer_name,
      status: b.status, statusText: statusLabel(BILL_STATUS, b.status),
      amountYuan: fmtYuan(b.amount_cents), adjustYuan: fmtYuan(b.adjust_cents),
      payableYuan: fmtYuan(billPayable(b)), paidYuan: fmtYuan(b.paid_cents),
      unpaidCents: billUnpaid(b), unpaidYuan: fmtYuan(billUnpaid(b)),
      canReceive: b.status === 'unpaid' || b.status === 'partial',
      canEdit: (b.status === 'unpaid') && (b.paid_cents || 0) === 0
    };
  }

  /** 总表行（P4-M1）：/api/overview 聚合行 → 列表显示行（纯函数，node:test 可测）
      金额列保留分值由渲染层求和；此处只做展示派生（日期/地址/状态/编辑权界） */
  function overviewRow(r) {
    let ops = [];
    try { ops = typeof r.operator_names === 'string' ? JSON.parse(r.operator_names || '[]') : (r.operator_names || []); }
    catch (e) { ops = []; }
    const addr = [r.village || '', r.team ? r.team + '队' : ''].filter(Boolean).join('·') || '—';
    const billStatuses = String(r.bill_statuses || '').split(',').filter(Boolean);
    const billCount = r.bill_count || 0;
    const billStatus = billStatuses[0] || null;
    return {
      id: r.id, job_no: r.job_no, job_date: (r.job_date || '').slice(0, 10),
      status: r.job_status, statusText: statusLabel(JOB_STATUS, r.job_status),
      source: r.source || '',
      customer_names: r.customer_names || '',
      region: r.region || '', addr,
      areaMu: r.total_area_mu != null ? r.total_area_mu : null,
      unitPriceYuan: fmtYuan(r.unit_price_cents),
      jobIncomeCents: r.income_cents != null ? r.income_cents : 0,
      plantLabel: r.plant_label || '',
      extraCents: r.extra_cents || 0,
      referral: r.referral_name || '',
      operators: ops,
      collector: r.collector_name || '',
      note: r.note || '',
      billCount, billStatuses,
      billId: r.bill_id || null, billPartyId: r.bill_party_id || null,
      billAdjust: r.bill_adjust != null ? r.bill_adjust : 0,
      billNote: r.bill_note || '',
      // 编辑权界与账单页 billRow.canEdit 同口径：单账单 + 未收 + 零收款
      canEditBill: billCount === 1 && billStatus === 'unpaid' && (r.paid_cents || 0) === 0,
      canReceive: billCount === 1 && (billStatus === 'unpaid' || billStatus === 'partial')
    };
  }

  /** 流水行：借贷分列与平衡标记 */
  function journalRow(e) {
    const debit = e.lines.filter(l => l.direction === 'debit');
    const credit = e.lines.filter(l => l.direction === 'credit');
    const d = debit.reduce((a, l) => a + l.amount_cents, 0);
    const c = credit.reduce((a, l) => a + l.amount_cents, 0);
    return {
      id: e.id, entry_no: e.entry_no, event: e.event_type, memo: e.memo || '',
      occurred: (e.occurred_at || '').slice(0, 10),
      debit: debit.map(l => ({ text: l.account_code + ' ' + l.account_name, yuan: fmtYuan(l.amount_cents) })),
      credit: credit.map(l => ({ text: l.account_code + ' ' + l.account_name, yuan: fmtYuan(l.amount_cents) })),
      balanced: d === c, totalYuan: fmtYuan(d)
    };
  }

  /** 从行集合派生月份集合（'YYYY-MM'，倒序） */
  function monthKeys(rows, field) {
    const set = new Set();
    for (const r of rows || []) {
      const d = String((r[field] || '')).slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(d)) set.add(d);
    }
    return [...set].sort().reverse();
  }

  /** CSV 单元转义：引号包裹 + 内部引号翻倍（Excel 直接打开需前置 BOM，由调用方处理） */
  function csvCell(v) {
    return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  }
  /** 行数组 → CSV 文本（\r\n 行尾） */
  function csvRow(cells) {
    return cells.map(csvCell).join(',');
  }

  /* ---------- SVG 图表纯函数已随 P5-M2 echarts 化移除（charts.js 改 option 构建器） ---------- */

  /* ---------- 列宽存取（P5-M3 表格 Excel 化；DOM 无关，node:test 可测） ---------- */
  const COLW_MIN = 48, COLW_MAX = 800;
  /** 列宽规范化到 48–800px；非数回退下限（拖拽边界与存档读取共用一条口径） */
  function clampColw(px) {
    const n = Math.round(Number(px));
    if (!Number.isFinite(n)) return COLW_MIN;
    return Math.min(COLW_MAX, Math.max(COLW_MIN, n));
  }
  /** localStorage 存取键：按 页签+表 组合，不同页签同表名互不串档 */
  function colwKey(tab, tableKey) {
    return 'lg-colw:' + String(tab == null ? '' : tab) + ':' + String(tableKey == null ? '' : tableKey);
  }
  /** 解析列宽存档：坏 JSON / 非数组 / 列数超出现表（结构变更）/ 坏值 → 整包 null 丢弃防错位；
      短数组允许（仅前列有存档）；每项经 clampColw 规范化 */
  function parseColw(json, thCount) {
    let arr;
    try { arr = JSON.parse(json); } catch (e) { return null; }
    if (!Array.isArray(arr)) return null;
    if (arr.length > thCount) return null;
    const out = [];
    for (const v of arr) {
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      out.push(clampColw(n));
    }
    return out;
  }

  /**
   * 计算器导出 JSON → /api/jobs 同步协议载荷（P6-M1 离线数据通路）。
   * 返回 { ok:true, payload } 或 { ok:false, error }。
   * 规则：
   *  - 必须 type='drone-spray-config'；schemaVersion='2.1' 才带 result（可导入），
   *    2.0/缺失 → 友好报错（老版本导出没有计算结果快照）；
   *  - client_job_id：优先用导出自带，否则本地生成（幂等键，含随机后缀防撞）；
   *  - job_date 取 exportedAt 的日期前缀，缺省 todayStr；
   *  - snapshot = 原导出对象剥离 result/schemaVersion/client_job_id（服务端原样存 raw_json）。
   */
  function calculatorJobPayload(text, todayStr) {
    let obj;
    try { obj = JSON.parse(typeof text === 'string' ? text.trim() : ''); }
    catch (e) { return { ok: false, error: '不是合法的 JSON' }; }
    if (!obj || obj.type !== 'drone-spray-config') {
      return { ok: false, error: '不是计算器导出的作业 JSON（缺少 type 标识）' };
    }
    if (obj.schemaVersion !== '2.1' || !obj.result) {
      return { ok: false, error: '旧版导出（无计算结果快照）。请在计算器重新计算后用「⬇ 下载作业包」导出' };
    }
    const mode = obj.mode === 'haul' ? 'haul' : 'spray';
    const exported = String(obj.exportedAt || '');
    // E1（P7-R4）：日期口径与同步通路（sync.js localDateStr）对齐——
    // 新作业包 exportedAt 是本地墙钟串，直接取前 10 位；旧包（ISO/UTC，含 T）
    // 按北京时间 +8 换算取日期，避免凌晨导出的作业记到前一天。
    let jobDate;
    if (/^\d{4}-\d{2}-\d{2}/.test(exported)) {
      if (exported.includes('T')) {
        const d = new Date(exported);
        if (!isNaN(d)) {
          const p = (n) => (n < 10 ? '0' + n : '' + n);
          const loc = new Date(d.getTime() + 8 * 3600 * 1000);
          jobDate = `${loc.getUTCFullYear()}-${p(loc.getUTCMonth() + 1)}-${p(loc.getUTCDate())}`;
        } else jobDate = todayStr || exported.slice(0, 10);
      } else {
        jobDate = exported.slice(0, 10);
      }
    } else {
      jobDate = todayStr || exported;
    }
    const snapshot = { ...obj };
    delete snapshot.result;
    delete snapshot.schemaVersion;
    delete snapshot.client_job_id;
    return {
      ok: true,
      payload: {
        client_job_id: obj.client_job_id || 'paste-' + (todayStr || '') + '-' + Math.random().toString(36).slice(2, 8),
        job_type: mode,
        job_date: jobDate,
        note: (obj.workOrder && obj.workOrder.note) || undefined,
        snapshot,
        result: obj.result
      }
    };
  }

  /* ---------- 导入收件箱分派（P9-R4；纯函数，node:test 可测） ---------- */
  /**
   * 按扩展名选导入管线（大小写不敏感）。只认最后一个扩展名，不做内容嗅探魔法——
   * 识别不了返回 null，调用方给可读提示，绝不猜（本轮裁决 D1）。
   *   'excel'    .xlsx 月度记账表 → /api/import/parse 复核管线
   *   'calcjson' .json 计算器作业包 → /api/jobs 幂等导入
   *   'llm'      .txt/.md 杂乱记账文本 → /api/llm/parse 本机 LLM
   */
  function pickPipeline(filename) {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(filename == null ? '' : filename).trim());
    if (!m) return null;
    switch (m[1].toLowerCase()) {
      case 'xlsx': return 'excel';
      case 'json': return 'calcjson';
      case 'txt': case 'md': return 'llm';
      default: return null;
    }
  }

  /**
   * 粘贴文本分派（收件箱 Ctrl+V 无文件名时）：`{` 开头一律按计算器作业包走
   * calcjson——calculatorJobPayload 会给「不是计算器导出的作业 JSON」可读报错，
   * 比喂给 LLM 产出垃圾行更友好；其余非空文本走 LLM；空白返回 null（没粘内容）。
   */
  function pickPipelineForText(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return null;
    return s.startsWith('{') ? 'calcjson' : 'llm';
  }

  /**
   * LLM 分批预估（收件箱/面板「解析中…约 N 批」文案用）：与服务端 llmChunk
   * （≤30 行且 ≤2500 字符单块直通）同口径的近似——按 行数/30 与 字符数/2500
   * 上取整取大。段落边界会让真实块数略多，文案措辞用「约」；精确块数以服务端
   * 返回 d.chunks 为准（成功提示展示）。
   */
  function estimateLlmChunks(text) {
    const s = String(text == null ? '' : text);
    if (!s.trim()) return 0;
    const parts = s.split(/\r?\n/);
    const lines = s.endsWith('\n') ? parts.length - 1 : parts.length;
    if (lines <= 30 && s.length <= 2500) return 1;
    return Math.max(Math.ceil(lines / 30), Math.ceil(s.length / 2500));
  }

  /* ---------- 日期范围与总表数据条状态（P10-R2；纯函数，node:test 可测） ---------- */

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const BAR_QUICKS = ['total', 'day', 'week', 'month', 'quarter', 'year'];

  /** 严格 YYYY-MM-DD 且为真实日历日（2026-2-3 / 2026-02-30 / 乱串 → null；调用方视同「未填」） */
  function normDate(s) {
    const v = String(s == null ? '' : s).trim();
    if (!DATE_RE.test(v)) return null;
    const [y, m, d] = v.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return v;
  }

  function pad2n(n) { return (n < 10 ? '0' : '') + n; }
  /** Date(UTC) → 'YYYY-MM-DD'（weekRangeOf 内部换算专用，仅接受本文件 Date.UTC 产物） */
  function dstrOf(d) { return `${d.getUTCFullYear()}-${pad2n(d.getUTCMonth() + 1)}-${pad2n(d.getUTCDate())}`; }

  /**
   * 周快捷区间（周一起始，与后端 %W 归桶口径对齐——reports.js bucketExpr week：
   * printf('%d-W%02d', 年, strftime('%W'))，周一始自然周、年内首个周一前的日子记 W00）。
   * 锚点落 W00 窗口时区间=当年 01-01..首个周一前一日（简单"取本周一"会落进上一年 12 月，
   * 与图表周桶错位——app.js 旧 weekRange 同款口径，此处固化进纯函数层）。
   */
  function weekRangeOf(today) {
    const d = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10))));
    const dow = (d.getUTCDay() + 6) % 7; // 0=周一
    const monday = new Date(d); monday.setUTCDate(monday.getUTCDate() - dow);
    const y = d.getUTCFullYear();
    const jan1 = new Date(Date.UTC(y, 0, 1));
    const firstMonday = new Date(jan1);
    firstMonday.setUTCDate(firstMonday.getUTCDate() + (7 - (jan1.getUTCDay() + 6) % 7) % 7);
    if (monday < firstMonday) {
      const w00end = new Date(firstMonday); w00end.setUTCDate(w00end.getUTCDate() - 1);
      return { from: `${y}-01-01`, to: dstrOf(w00end) };
    }
    const sunday = new Date(monday); sunday.setUTCDate(sunday.getUTCDate() + 6);
    return { from: dstrOf(monday), to: dstrOf(sunday) };
  }

  /** 快捷档原始区间（未交集）：total=全期→null；today 非法视同 total（退化为无快捷界） */
  function quickRangeOf(quick, today) {
    const t = normDate(today);
    if (quick === 'total' || !t) return null;
    const y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7));
    if (quick === 'day') return { from: t, to: t };
    if (quick === 'week') return weekRangeOf(t);
    if (quick === 'month') {
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return { from: `${y}-${pad2n(m)}-01`, to: `${y}-${pad2n(m)}-${pad2n(last)}` };
    }
    if (quick === 'quarter') {
      const qs = Math.floor((m - 1) / 3) * 3 + 1, qe = qs + 2;
      const last = new Date(Date.UTC(y, qe, 0)).getUTCDate();
      return { from: `${y}-${pad2n(qs)}-01`, to: `${y}-${pad2n(qe)}-${pad2n(last)}` };
    }
    if (quick === 'year') return { from: `${y}-01-01`, to: `${y}-12-31` };
    return null; // 未知档位按全期处理（调用方只会传六档，防御性兜底）
  }

  /**
   * 数据条/图表卡生效区间（P10-R2 核心口径）：
   *   dateRangeOf(quick, from, to, today) → null（全期）或 {from,to}（边可为 null=不设限）。
   * from/to：用户手填边界（YYYY-MM-DD），非空时与快捷区间取交集（空边不设限）；
   * 非法日期字符串视同空；交集为空（两界倒挂）时如实返回倒挂区间——服务端按零行统计，
   * 不猜用户意图。两日期都填时快捷按钮的置灰由调用方负责（barUiOf.locked），
   * 本函数不做特殊分支，任何 quick 都仍按交集返回。
   */
  function dateRangeOf(quick, from, to, today) {
    const q = quickRangeOf(quick, today);
    const f = normDate(from), t = normDate(to);
    const lo = [q && q.from, f].filter(Boolean).sort().pop() || null; // 交集左界=取晚
    const hi = [q && q.to, t].filter(Boolean).sort()[0] || null;     // 交集右界=取早
    if (!lo && !hi) return null;
    return { from: lo, to: hi };
  }

  /**
   * 数据条 UI 派生（renderKpiBar 与单测共用一条口径）：
   *   locked = 两日期都填（合法）→ 快捷按钮全部置灰，生效区间纯按 [from,to]；
   *   quick  = locked 时强制 'total'（全期 ∩ [from,to] = [from,to]），否则沿用所选档
   *            （存档越界/未知档回退 'total'）；range = dateRangeOf 最终生效区间。
   */
  function barUiOf(bar, today) {
    const b = bar || {};
    const from = normDate(b.from) || '', to = normDate(b.to) || '';
    const locked = !!(from && to);
    const quick = locked ? 'total' : (BAR_QUICKS.includes(b.quick) ? b.quick : 'total');
    return { from, to, locked, quick, range: dateRangeOf(quick, from, to, today) };
  }

  /**
   * 数据条状态存档解析（localStorage 'lg-bar-v1'）：坏 JSON / 非对象 / quick 越界 /
   * 日期非法 → 整包 null（调用方回退默认档，parseColw 同款「坏档整包丢弃」口径）；
   * from/to 用 '' 表示未填（与 date input 的 value 语义一致）。
   */
  function parseBarState(json) {
    let o;
    try { o = JSON.parse(json); } catch (e) { return null; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    if (!BAR_QUICKS.includes(o.quick)) return null;
    for (const k of ['from', 'to']) {
      const v = o[k];
      if (v == null || v === '') continue; // 未填（''/缺键）合法
      if (!normDate(v)) return null;       // 其余值必须是合法日期，坏值整包丢弃
    }
    return { quick: o.quick, from: normDate(o.from) || '', to: normDate(o.to) || '' };
  }

  /* ---------- 图表 dashboard 卡模型与布局存档（P10-R3；纯函数，node:test 可测） ---------- */

  /** 卡内 by-period 桶粒度（时间轴卡用；与数据条快捷档是两回事，BAR_QUICKS 另有 total/day） */
  const CARD_GRANS = ['week', 'month', 'quarter', 'year'];
  /** GridStack 列宽边界（列数固定 3；w 以格计，h 行高由前端 cellHeight 决定） */
  const GRID_COLUMNS = 3, GRID_H_MIN = 1, GRID_H_MAX = 60;

  /**
   * 单卡状态规范化（charts.js 渲染与存档读取共用）：gran/quick 越界回默认档、
   * 日期非法视同未填——单卡坏值降级为默认状态照常渲染，不整包丢弃（与
   * parseBarState 的差异：数据条只有一份全局状态，卡有多张，单张坏不拖累整页）。
   */
  function parseCardState(raw) {
    const s = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    return {
      gran: CARD_GRANS.includes(s.gran) ? s.gran : 'month',
      quick: BAR_QUICKS.includes(s.quick) ? s.quick : 'total',
      from: normDate(s.from) || '',
      to: normDate(s.to) || ''
    };
  }

  /**
   * 布局条目清洗：{id,x,y,w,h} 只收整数；id 必须命中现存卡，w 夹 1..GRID_COLUMNS、
   * h 夹 GRID_H_MIN..GRID_H_MAX；x/y 缺失或负数=自动布局（置 null，GridStack 自填充）。
   * 非数组 → null（调用方按整档无布局处理=全部自动）。
   */
  function gridLayoutOf(rawLayout, cardIds) {
    if (!Array.isArray(rawLayout)) return null;
    const ids = new Set(cardIds);
    const out = [];
    const intOr = (v, def) => (Number.isInteger(v) ? v : def);
    for (const it of rawLayout) {
      if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
      const id = Number(it.id);
      if (!Number.isInteger(id) || !ids.has(id)) continue;
      const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
      const w = clamp(intOr(Number(it.w), 1), 1, GRID_COLUMNS);
      const h = clamp(intOr(Number(it.h), 1), GRID_H_MIN, GRID_H_MAX);
      const x = intOr(Number(it.x), -1) >= 0 ? Number(it.x) : null;
      const y = intOr(Number(it.y), -1) >= 0 ? Number(it.y) : null;
      out.push({ id, x, y, w, h });
    }
    return out;
  }

  /**
   * dashboard 存档解析（localStorage 'lg-grid-v1'，charts.js 落盘格式
   * { v:1, cards:[{id,type,title,state}], layout:[{id,x,y,w,h}] }）：
   *   - JSON 坏 / 非对象 / cards 非数组 → null（调用方回退默认布局）；
   *   - 逐卡清洗：id 唯一正整数、type 在 validTypes 白名单、state 走 parseCardState，
   *     坏卡丢弃；有卡但全部被丢 → null（坏档回退默认，防"神秘清空"）；
   *     cards 为空数组 = 用户主动删空，合法保留（添加图表按钮仍可重建）；
   *   - layout 走 gridLayoutOf（非数组→null=全部自动布局；条目坏的单条丢弃）。
   */
  function parseGridSave(json, validTypes) {
    let o;
    try { o = JSON.parse(json); } catch (e) { return null; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    if (!Array.isArray(o.cards)) return null;
    const types = new Set(validTypes || []);
    const seen = new Set();
    const cards = [];
    for (const c of o.cards) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
      const id = Number(c.id);
      const type = String(c.type || '');
      if (!Number.isInteger(id) || id < 1 || seen.has(id) || !types.has(type)) continue;
      seen.add(id);
      cards.push({ id, type, title: String(c.title == null ? '' : c.title), state: parseCardState(c.state) });
    }
    if (o.cards.length > 0 && cards.length === 0) return null;
    return { cards, layout: gridLayoutOf(o.layout, cards.map(c => c.id)) };
  }

  /** 下一张卡 id（=现存最大 id+1；空表从 1 起，纯函数便于单测） */
  function nextCardId(cards) {
    return (cards || []).reduce((a, c) => Math.max(a, Number(c && c.id) || 0), 0) + 1;
  }

  /* ---------- B7 美观层：主题三态与字号双档（纯函数，node:test 可测） ---------- */
  const THEME_KEY = 'lg-theme';       // 'auto'（跟随系统）| 'light' | 'dark'；缺档=auto
  const FONTSIZE_KEY = 'lg-fontsize'; // 'normal' | 'compact'；缺档=normal
  /** 主题三态解析：显式 light/dark 优先覆盖 prefers-color-scheme，其余（auto/未知/缺存档）跟随系统 */
  function resolveTheme(saved, systemDark) {
    if (saved === 'dark') return 'dark';
    if (saved === 'light') return 'light';
    return systemDark ? 'dark' : 'light';
  }
  /** 字号档解析：只认 'compact'（紧凑小字档），其余一律标准档（坏存档安全回退） */
  function normalizeFontsize(saved) { return saved === 'compact' ? 'compact' : 'normal'; }

  /** B3 空状态即教程：图标 + 一句话 + 直达动作（按钮走既有 data-act 委托，
   *  跳页动作统一 data-act="goto-tab" data-tab="…"）。
   *  opts.cell=true 返回表格空态内容（放在 <td colspan=N> 内）；
   *  缺省返回独立面板 HTML。纯函数（core.js，可单测）。 */
  function emptyState(icon, text, actions, opts) {
    const acts = (actions || []).map(a =>
      `<button class="lg-btn primary" data-act="${a.act}"${a.tab ? ` data-tab="${a.tab}"` : ''} title="${a.title || ''}">${a.icon || ''} ${a.label}</button>`).join(' ');
    const inner = `<div class="lg-empty"><span class="lg-empty-icon">${icon || '📭'}</span>` +
      `<span class="lg-empty-text">${text}</span>` +
      (acts ? `<span class="lg-empty-actions">${acts}</span>` : '') + '</div>';
    return (opts && opts.cell) ? inner : `<div class="lg-panel lg-empty-panel">${inner}</div>`;
  }

  /** B6 首页钱况 dashboard 存档解析（lg-home-grid-v1）：坏 JSON/形状不对/cards 空或全未知
   *  → null 整包回退默认（charts 页 parseGridSave 同款纪律）；knownIds 由调用方给
   *  （home.js 的卡定义），core 保持无首页细节依赖。 */
  function parseHomeGridSave(raw, knownIds) {
    if (!raw) return null;
    let o = null;
    try { o = JSON.parse(raw); } catch (e) { return null; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    if (!Array.isArray(o.cards) || !o.cards.length) return null;
    const known = new Set(knownIds || []);
    const cards = [...new Set(o.cards.map(String))].filter(c => known.has(c));
    if (!cards.length) return null;
    const titles = (o.titles && typeof o.titles === 'object' && !Array.isArray(o.titles)) ? o.titles : {};
    return { v: 1, cards, titles, layout: Array.isArray(o.layout) ? o.layout : null };
  }

  const Core = {
    monthKeys, csvCell, csvRow, calculatorJobPayload,
    pickPipeline, pickPipelineForText, estimateLlmChunks,
    fmtYuan, yuanInputToCents, statusLabel,
    billPayable, billUnpaid, jobRow, settlementRow, billRow, journalRow, overviewRow,
    colwKey, clampColw, parseColw,
    THEME_KEY, FONTSIZE_KEY, resolveTheme, normalizeFontsize,
    normDate, dateRangeOf, quickRangeOf, weekRangeOf, barUiOf, parseBarState,
    parseCardState, parseGridSave, gridLayoutOf, nextCardId, emptyState, parseHomeGridSave,
    BAR_QUICKS, CARD_GRANS, GRID_COLUMNS,
    MAPS: { JOB_STATUS, SETTLEMENT_STATUS, BILL_STATUS, PAYMENT_CATEGORY, ADVANCE_DIRECTION, METHOD, PARTY_TYPE }
  };

  if (typeof window !== 'undefined') window.LedgerCore = Core;
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})();
