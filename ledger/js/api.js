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
    summary: () => Api.get('/api/summary'),
    parties: () => Api.get('/api/parties')
  };

  if (typeof window !== 'undefined') window.LedgerApi = Api;
  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
})();
