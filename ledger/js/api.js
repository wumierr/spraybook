/* ============================================================
   ledger/js/api.js — API 访问层（统一解包 {ok,data}，错误抛 Error）
   ============================================================ */
(function () {
  'use strict';

  async function request(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    let res;
    try {
      res = await fetch(path, opts);
    } catch (e) {
      throw new Error('无法连接账本服务（' + path + '）：' + e.message);
    }
    // E9（P7-R4）：服务端在列表打满上限时置 X-Has-More——记录到全局，
    // doRender 尾部统一 toast，替代过去的静默截断
    try {
      window.__lgHasMore = res.headers.get('X-Has-More') === '1';
    } catch (e) { /* 忽略 */ }
    let j = null;
    try { j = await res.json(); } catch (e) { /* 非 JSON */ }
    if (!res.ok || !j || j.ok !== true) {
      const msg = j && j.error ? (j.error.code + ': ' + j.error.message) : ('HTTP ' + res.status);
      throw new Error(msg);
    }
    return j.data;
  }

  /** 查询串拼装（P10-R2）：空/undefined/null 参数整体省略（全期=无 from/to；
      服务端 validateRange 对空串报 VALIDATION，故绝不能拼 `from=&to=`） */
  function qs(params) {
    const parts = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
    return parts.length ? '?' + parts.join('&') : '';
  }

  const Api = {
    get: (p) => request('GET', p),
    // P10-R3：charts.js 每卡独立拼端点查询串，复用同一「空参数整体省略」口径
    qs,
    post: (p, b) => request('POST', p, b || {}),
    put: (p, b) => request('PUT', p, b || {}),
    patch: (p, b) => request('PATCH', p, b),
    // 便捷封装
    jobs: (params) => Api.get('/api/jobs' + (params || '')),
    job: (id) => Api.get('/api/jobs/' + id),
    voidJob: (id) => Api.post('/api/jobs/' + id + '/void'),
    settlements: () => Api.get('/api/settlements'),
    createSettlement: (job_id, party_id) => Api.post('/api/settlements', { job_id, party_id }),
    settlement: (id) => Api.get('/api/settlements/' + id),
    updateItems: (id, items) => Api.patch('/api/settlements/' + id, { items }),
    confirm: (id) => Api.post('/api/settlements/' + id + '/confirm'),
    reopen: (id) => Api.post('/api/settlements/' + id + '/reopen'),
    voidSettlement: (id) => Api.post('/api/settlements/' + id + '/void'),
    bills: () => Api.get('/api/bills'),
    patchBill: (id, b) => Api.patch('/api/bills/' + id, b),
    receipts: () => Api.get('/api/receipts'),
    createReceipt: (b) => Api.post('/api/receipts', b),
    payments: () => Api.get('/api/payments'),
    createPayment: (b) => Api.post('/api/payments', b),
    advances: () => Api.get('/api/advances'),
    createAdvance: (b) => Api.post('/api/advances', b),
    settleAdvance: (id, b) => Api.post('/api/advances/' + id + '/settle', b),
    splits: () => Api.get('/api/splits'),
    createSplit: (b) => Api.post('/api/splits', b),
    voidFinance: (table, id) => Api.post('/api/' + table + '/' + id + '/void'),
    journal: () => Api.get('/api/journal'),
    // B1 首页双行 KPI：本月区间与全期各调一次（服务端 summary 自 P5-M2 起支持 from/to）
    summary: (params) => Api.get('/api/reports/summary' + (params || '')),
    // B2 账龄分桶（首页催收卡数据源；as_of 可选注入回看口径）
    aging: (asOf) => Api.get('/api/reports/aging' + qs({ as_of: asOf })),
    // C3 用药史（?party_id= 客户档案 / ?bill_id= 账单作业明细；零新表派生）
    usageHistory: (q) => Api.get('/api/usage-history' + qs(q)),
    // P4-M1 总表（作业粒度聚合只读视图）
    overview: (params) => Api.get('/api/overview' + (params || '')),
    parties: () => Api.get('/api/parties'),
    // P5-M2 总表数据条 / 图表页 C11/C12（区间聚合，金额 _cents）；P10-R2 起空区间=全期（参数省略）
    barRange: (from, to) => Api.get('/api/reports/by-range' + qs({ from, to })),
    byRegion: (level, from, to) => Api.get('/api/reports/by-region' + qs({ level: level || 'region', from, to })),
    byOperator: (from, to) => Api.get('/api/reports/by-operator' + qs({ from, to })),
    // M8 导入
    importParse: (filename, base64) => Api.post('/api/import/parse', { filename, base64 }),
    importBatches: () => Api.get('/api/import/batches'),
    importRows: (id, status) => Api.get('/api/import/batches/' + id + '/rows' + (status ? '?status=' + status : '')),
    importRowPatch: (id, b) => Api.patch('/api/import/rows/' + id, b),
    importApply: (id) => Api.post('/api/import/batches/' + id + '/apply', {}),
    importRecon: (id) => Api.get('/api/import/batches/' + id + '/reconciliation'),
    importOpening: (b) => Api.post('/api/import/opening', b),
    // P8 本地 LLM 文本导入；P9-R3 起 body 可含 default_date（YYYY-MM-DD，
    // 无日期条目按它记）——llmParse 整包透传，调用方在 b 里带上即可
    llmParse: (b) => Api.post('/api/llm/parse', b),
    // P10-R5：LLM 数据审查（只挑错，绝不改数据）
    llmReviewBatch: (id) => Api.post(`/api/llm/review/batches/${id}`, {}),
    llmReviewHealth: () => Api.post('/api/llm/review/health', {}),
    llmReviewDismiss: (key) => Api.post('/api/llm/review/health/dismiss', { key }),
    llmStatus: () => Api.get('/api/llm/status'),
    llmCancelBatch: (id) => Api.post('/api/llm/batches/' + id + '/cancel', {}),
    editReceipt: (id, b) => Api.patch('/api/receipts/' + id, b),
    editPayment: (id, b) => Api.patch('/api/payments/' + id, b),
    editAdvanceNote: (id, b) => Api.patch('/api/advances/' + id, b),
    // P6-M1：计算器导出 JSON 粘贴导入（同步协议，幂等）
    createJob: (b) => Api.post('/api/jobs', b),
    // M7 主数据
    masterList: (t) => Api.get('/api/master/' + t),
    masterCreate: (t, b) => Api.post('/api/' + t, b),
    masterPatch: (t, id, b) => Api.patch('/api/' + t + '/' + id, b),
    // P9-R2 数据体检 + 客户合并；P10-R1 起体检可选市县过滤（?county=，缺省=全部）
    dataHealth: (county) => Api.get('/api/data-health' + (county ? '?county=' + encodeURIComponent(county) : '')),
    dismissHealth: (key) => Api.post('/api/data-health/dismiss', { key }),
    mergeParties: (b) => Api.post('/api/master/parties/merge', b),
    settings: () => Api.get('/api/settings'),
    saveSettings: (b) => Api.put('/api/settings', b)
  };

  if (typeof window !== 'undefined') window.LedgerApi = Api;
  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
})();
