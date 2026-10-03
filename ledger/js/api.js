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
    let j = null;
    try { j = await res.json(); } catch (e) { /* 非 JSON */ }
    if (!res.ok || !j || j.ok !== true) {
      const msg = j && j.error ? (j.error.code + ': ' + j.error.message) : ('HTTP ' + res.status);
      throw new Error(msg);
    }
    return j.data;
  }

  const Api = {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b || {}),
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
    summary: () => Api.get('/api/reports/summary'),
    // P4-M1 总表（作业粒度聚合只读视图）
    overview: (params) => Api.get('/api/overview' + (params || '')),
    parties: () => Api.get('/api/parties'),
    // P5-M2 总表数据条 / 图表页 C11/C12（区间聚合，金额 _cents）
    barRange: (from, to) => Api.get(`/api/reports/by-range?from=${from}&to=${to}`),
    byRegion: (level, from, to) =>
      Api.get(`/api/reports/by-region?level=${level || 'region'}&from=${from}&to=${to}`),
    byOperator: (from, to) => Api.get(`/api/reports/by-operator?from=${from}&to=${to}`),
    // M8 导入
    importParse: (filename, base64) => Api.post('/api/import/parse', { filename, base64 }),
    importBatches: () => Api.get('/api/import/batches'),
    importRows: (id, status) => Api.get('/api/import/batches/' + id + '/rows' + (status ? '?status=' + status : '')),
    importRowPatch: (id, b) => Api.patch('/api/import/rows/' + id, b),
    importApply: (id) => Api.post('/api/import/batches/' + id + '/apply', {}),
    importRecon: (id) => Api.get('/api/import/batches/' + id + '/reconciliation'),
    importOpening: (b) => Api.post('/api/import/opening', b),
    editReceipt: (id, b) => Api.patch('/api/receipts/' + id, b),
    editPayment: (id, b) => Api.patch('/api/payments/' + id, b),
    editAdvanceNote: (id, b) => Api.patch('/api/advances/' + id, b),
    // P6-M1：计算器导出 JSON 粘贴导入（同步协议，幂等）
    createJob: (b) => Api.post('/api/jobs', b),
    // M7 主数据
    masterList: (t) => Api.get('/api/master/' + t),
    masterCreate: (t, b) => Api.post('/api/' + t, b),
    masterPatch: (t, id, b) => Api.patch('/api/' + t + '/' + id, b),
    settings: () => Api.get('/api/settings'),
    saveSettings: (b) => Api.put('/api/settings', b)
  };

  if (typeof window !== 'undefined') window.LedgerApi = Api;
  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
})();
