/* ============================================================
   sync.js — spraybook 同步适配层（M3）
   职责：把"一次完成的作业"快照上报到 spraybook 服务器（/api/jobs）。
   边界：不改任何计算逻辑；只加同步队列与少量 UI 入口。
   设计：docs/sync-design.md（状态机 pending/syncing/failed/dead、
        幂等 client_job_id、job_no 回写、混合内容约束）。

   配置：localStorage drone_spray_server_v1 = { base_url, enabled }
   队列：localStorage drone_spray_sync_v1（刷新/关机不丢）
   约束：公网 HTTPS 页面无法请求局域网 http API（混合内容拦截），
        同步仅在 file:// 或局域网 http 访问时可用——不可用时按钮给出提示。
   ============================================================ */
(function () {
  'use strict';
  if (window.SpraySync) return;

  var QUEUE_KEY = 'drone_spray_sync_v1';
  var CLOUD_KEY = 'drone_spray_cloud_v1';
  var SETTINGS_KEY = 'drone_spray_server_v1';
  var RETRY_DELAYS_MIN = [1, 5, 30];   // 第 n 次失败后的退避
  var MAX_ATTEMPTS = 10;               // 超过转 dead（人工重推）
  var QUEUE_WARN = 100;                // 积压告警阈值
  var PROBE_TIMEOUT_MS = 4000;
  var CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混 I O 0 1

  /* ---------- 纯函数（tests/sync.test.js 覆盖） ---------- */

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /** 本地日期 YYYY-MM-DD（不用 toISOString，避免时区把晚上作业划到明天） */
  function localDateStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function genJobNo(dateStr, rand) {
    rand = rand || Math.random;
    var ymd = String(dateStr || '').replace(/-/g, '').slice(0, 8) || '00000000';
    var s = '';
    for (var i = 0; i < 4; i++) s += CHARS[Math.floor(rand() * CHARS.length)];
    return ymd + '-' + s;
  }

  function uuid() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) { /* fallthrough */ }
    return 'cj-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /** 第 attempts 次失败后的退避毫秒数（1/5/30 分钟封顶） */
  function nextRetryDelayMs(attempts) {
    var idx = Math.max(0, Math.min(attempts, RETRY_DELAYS_MIN.length) - 1);
    return RETRY_DELAYS_MIN[idx] * 60000;
  }

  function isDead(attempts) { return attempts >= MAX_ATTEMPTS; }

  /**
   * 组装一次作业的上报 payload（纯函数）。
   * state=UI.state（权威状态），result=UI._lastResult，mode='spray'|'haul'
   */
  function buildJobPayload(state, result, mode, now) {
    if (!state || !result) return null;
    var jobDate = localDateStr(now);
    var wo = state.workOrder || {};
    return {
      client_job_id: uuid(),
      job_no: genJobNo(jobDate),
      job_type: mode === 'haul' ? 'haul' : 'spray',
      job_date: jobDate,
      address: null,
      note: wo.note || null,
      operator_names: (getCloud() && getCloud().operator) ? [getCloud().operator] : [],
      snapshot: JSON.parse(window.Storage.exportJSON(state, mode)),
      result: result
    };
  }

  /* ---------- 队列（localStorage 持久） ---------- */

  function loadQueue() {
    try {
      var raw = window.localStorage.getItem(QUEUE_KEY);
      if (raw) {
        var q = JSON.parse(raw);
        if (q && Array.isArray(q.queue)) return q;
      }
    } catch (e) { /* 损坏即重建 */ }
    return { v: 1, queue: [] };
  }

  function saveQueue(q) {
    try { window.localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
    catch (e) { console.warn('[sync] 队列保存失败（容量?）', e); }
  }

  /* ---------- 配置 ---------- */

  function getSettings() {
    try {
      var raw = window.localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        var s = JSON.parse(raw);
        return { base_url: String(s.base_url || '').replace(/\/+$/, ''), enabled: !!s.enabled };
      }
    } catch (e) { /* fallthrough */ }
    return { base_url: '', enabled: false };
  }

  function setSettings(base_url, enabled) {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      base_url: String(base_url || '').replace(/\/+$/, ''), enabled: !!enabled
    }));
  }

  function apiUrl(path) { return getSettings().base_url + path; }

  /* ---------- 网络 ---------- */

  function _probe() {
    var st = getSettings();
    if (!st.enabled || !st.base_url) return Promise.resolve(false);
    return new Promise(function (resolve) {
      try {
        var done = false;
        var ctrl = null;
        try { ctrl = new AbortController(); } catch (e) { ctrl = null; }
        var timer = setTimeout(function () {
          if (!done) { done = true; resolve(false); }
          if (ctrl) try { ctrl.abort(); } catch (e2) {}
        }, PROBE_TIMEOUT_MS);
        fetch(apiUrl('/api/health'), ctrl ? { signal: ctrl.signal } : {})
          .then(function (res) { if (!done) { done = true; clearTimeout(timer); resolve(!!res.ok); } })
          .catch(function () { if (!done) { done = true; clearTimeout(timer); resolve(false); } });
      } catch (e) {
        resolve(false); // 无 fetch 等环境一律视为离线
      }
    });
  }

  var _flushing = false;
  var _retryTimer = null;
  var _pollMs = 60000; // 轮询间隔（离线时指数退避到 5 分钟）

  /** E3：同步失败时解除工单上的防重标记（允许直接重试，不再弹确认） */
  function _clearSyncMarker(entry) {
    try {
      var wo = window.UI && window.UI.state && window.UI.state.workOrder;
      if (wo && wo._synced_client_job_id === entry.client_job_id) {
        delete wo._synced_client_job_id;
        delete wo._synced_job_no;
      }
    } catch (e) { /* 只读环境忽略 */ }
  }

  function _scheduleRetry(attempts) {
    if (_retryTimer) return;
    _retryTimer = setTimeout(function () {
      _retryTimer = null;
      flushNow();
    }, nextRetryDelayMs(attempts));
  }

  /**
   * 立即尝试同步队列（单飞）。返回 {sent, offline} 摘要。
   * 先探测 /api/health：不在线则整批不动（attempts 不累加，离线可排队任意天数）；
   * 在线后逐条 POST。状态机：
   *   done(200 ok) → 移出队列；4xx → failed（不重试）；
   *   5xx/网络 → attempts+1，≥10 转 dead，否则 pending 等退避重试。
   * failed/dead 不阻塞后续条目。
   */
  function flushNow() {
    if (_flushing) return Promise.resolve({ sent: 0, busy: true });
    var st = getSettings();
    if (!st.enabled || !st.base_url) {
      _updateUI();
      return Promise.resolve({ sent: 0, disabled: true });
    }
    var q = loadQueue();
    var targets = q.queue.filter(function (e) {
      return e.status === 'pending' || e.status === 'syncing';
    });
    _updateUI();
    if (!targets.length) return Promise.resolve({ sent: 0 });

    _flushing = true;
    var acc = { sent: 0, offline: false };

    return _probe().then(function (online) {
      if (!online) { acc.offline = true; return null; }
      var chain = Promise.resolve();
      targets.forEach(function (entry) {
        chain = chain.then(function () {
            entry.status = 'syncing';
            _updateUI();
            return fetch(apiUrl('/api/jobs'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(entry.payload)
            }).then(function (res) {
              return res.json().catch(function () { return null; }).then(function (j) {
                if (res.ok && j && j.ok) {
                  entry.server_job_no = (j.data && j.data.job_no) || entry.job_no;
                  entry.status = 'done';            // synced：移出队列
                  acc.sent += 1;
                  // E3：同步成功——把账本单号回写到工单状态行
                  if (window.UI && window.UI.state && window.UI.state.workOrder &&
                      window.UI.state.workOrder._synced_client_job_id === entry.client_job_id) {
                    window.UI.state.workOrder._synced_job_no = entry.server_job_no;
                  }
                } else if (res.status >= 500) {
                  entry.attempts += 1;
                  entry.last_error = 'HTTP ' + res.status;
                  entry.status = isDead(entry.attempts) ? 'dead' : 'pending';
                  _clearSyncMarker(entry);          // E3：失败解除防重标记，允许直接重试
                } else {
                  entry.status = 'failed';          // 4xx 校验错，不会自愈
                  entry.last_error = (j && j.error && j.error.message) || ('HTTP ' + res.status);
                  _clearSyncMarker(entry);          // E3：失败解除防重标记
                }
              });
            }).catch(function (err) {
              entry.attempts += 1;
              entry.last_error = String((err && err.message) || err) || 'network';
              entry.status = isDead(entry.attempts) ? 'dead' : 'pending';
              acc.offline = true;
              _clearSyncMarker(entry);              // E3：网络失败解除防重标记
            });
        });
      });
      return chain;
    }).then(function () {
      // done 条目移出；failed/dead 保留（上限 50，防队列膨胀）
      q.queue = q.queue.filter(function (e) { return e.status !== 'done'; });
      var problems = q.queue.filter(function (e) { return e.status === 'failed' || e.status === 'dead'; });
      if (problems.length > 50) {
        var keep = problems.slice(problems.length - 50);
        q.queue = q.queue.filter(function (e) {
          return (e.status !== 'failed' && e.status !== 'dead') || keep.indexOf(e) >= 0;
        });
      }
      saveQueue(q);
      var retrying = q.queue.find(function (e) { return e.status === 'pending' && e.attempts > 0; });
      if (retrying) _scheduleRetry(retrying.attempts);
      _flushing = false;
      _updateUI(acc.offline ? 'offline' : undefined);
      if (acc.sent > 0 && window.UI && window.UI.toast) {
        window.UI.toast('已同步 ' + acc.sent + ' 单作业到账本 ☁️', 'success');
      }
      return acc;
    }).catch(function (e) {
      _flushing = false;
      _updateUI();
      return { sent: 0, error: String(e) };
    });
  }

  /* ---------- 入口：把当前作业入队 ---------- */

  /** 复制工单 / 点同步按钮时调用。返回 payload 或 null（附原因码）。 */
  function enqueueCurrent() {
    var st = getSettings();
    if (!st.enabled || !st.base_url) return { ok: false, reason: 'disabled' };
    if (typeof location !== 'undefined' && location.protocol === 'https:' && st.base_url.indexOf('http://') === 0) {
      return { ok: false, reason: 'mixed-content' };
    }
    var UI = window.UI;
    if (!UI || !UI._lastResult) return { ok: false, reason: 'no-result' };
    // E3（P7-R4）同步防重：本工单已入队/已同步过（_synced_client_job_id 标记）
    // 再点同步 = 账本会多出一张相同作业单（幂等键每次新生成拦不住）——
    // 弹确认让用户明确"我要再建一单"，默认拦住手滑重复点击。
    var wo = UI.state && UI.state.workOrder;
    if (wo && wo._synced_client_job_id) {
      var allowed = false;
      try {
        allowed = window.confirm('该工单此前已同步（队列单号 ' + (wo._synced_job_no || wo._synced_client_job_id.slice(0, 8)) + '）。\n再次同步将在账本新建一单，继续吗？');
      } catch (e) { allowed = true; } // 无 confirm 的环境（测试 vm）不拦
      if (!allowed) return { ok: false, reason: 'already-synced' };
    }
    var payload = buildJobPayload(UI.state, UI._lastResult, UI.state.mode || 'spray');
    if (!payload) return { ok: false, reason: 'no-result' };
    var q = loadQueue();
    // 同一 client_job_id 防重复入队（理论上 uuid 不会撞，防御性保留）
    for (var i = 0; i < q.queue.length; i++) {
      if (q.queue[i].client_job_id === payload.client_job_id) return { ok: false, reason: 'dup' };
    }
    // E3：入队即在本工单上记同步标记（成功/排队中都会拦重复点击；失败自动清除）
    try {
      if (wo) { wo._synced_client_job_id = payload.client_job_id; wo._synced_job_no = payload.job_no; }
    } catch (e) { /* 只读环境忽略 */ }
    q.queue.push({
      client_job_id: payload.client_job_id,
      job_no: payload.job_no,
      payload: payload,
      created_at: new Date().toISOString(),
      attempts: 0,
      last_error: null,
      status: 'pending',
      server_job_no: null
    });
    saveQueue(q);
    _updateUI();
    flushNow();
    return { ok: true, job_no: payload.job_no, client_job_id: payload.client_job_id };
  }

  function getStatus() {
    var q = loadQueue();
    var pending = 0, failed = 0, dead = 0, last = null;
    q.queue.forEach(function (e) {
      if (e.status === 'pending' || e.status === 'syncing') pending++;
      else if (e.status === 'failed') failed++;
      else if (e.status === 'dead') dead++;
      if (e.server_job_no) last = e.server_job_no;
    });
    return { pending: pending, failed: failed, dead: dead, lastServerJobNo: last,
             warn: q.queue.length > QUEUE_WARN };
  }

  /** 人工重推：dead/failed → pending，然后立即 flush */
  function requeueFailed() {
    var q = loadQueue();
    q.queue.forEach(function (e) {
      if (e.status === 'failed' || e.status === 'dead') {
        e.status = 'pending';
        e.attempts = 0;
        e.last_error = null;
      }
    });
    saveQueue(q);
    _updateUI();
    return flushNow();
  }

  /* ---------- 读反哺（M7）：拉取主数据+财务状态，只缓存展示，不参与计算 ---------- */

  function fetchBootstrap() {
    var st = getSettings();
    if (!st.enabled || !st.base_url) return Promise.resolve(false);
    return fetch(apiUrl('/api/bootstrap'))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) {
          try { window.localStorage.setItem(CLOUD_KEY, JSON.stringify(j.data)); } catch (e2) {}
          return true;
        }
        return false;
      })
      .catch(function () { return false; });
  }

  function getCloud() {
    try { var s = window.localStorage.getItem(CLOUD_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }

  /** 按姓名查客户财务状态（农户卡/工单面板展示用） */
  function cloudParty(name) {
    var c = getCloud();
    if (!c || !c.parties || !name) return null;
    return c.parties.find(function (p) { return p.name === name; }) || null;
  }

  /* ---------- UI（注入徽标 + 工单面板状态行；窄屏用小徽标不撑行） ---------- */

  function _updateUI(kind) {
    if (typeof document === 'undefined') return;
    var st = getStatus();
    var badge = document.getElementById('syncBadge');
    if (!badge) {
      var header = document.querySelector('.header-left');
      if (!header) return;
      badge = document.createElement('span');
      badge.id = 'syncBadge';
      badge.className = 'sync-badge';
      badge.title = '点击立即同步到账本';
      badge.addEventListener('click', function () {
        var s = getSettings();
        if (!s.enabled) {
          if (window.UI && window.UI.toast) window.UI.toast('未配置账本服务器：localStorage 键 drone_spray_server_v1', 'warn');
          return;
        }
        flushNow();
      });
      header.appendChild(badge);
    }
    var n = st.pending + st.failed + st.dead;
    if (!getSettings().enabled || n === 0) {
      badge.textContent = '';
      badge.classList.remove('sync-warn', 'sync-err');
      badge.classList.add('sync-off');
      badge.title = '账本同步：无待同步作业';
    } else {
      badge.textContent = '☁' + n;
      badge.classList.remove('sync-off');
      badge.classList.toggle('sync-err', (st.failed + st.dead) > 0);
      badge.classList.toggle('sync-warn', !!st.warn || kind === 'offline');
      badge.title = '待同步 ' + st.pending + (st.failed ? '，失败 ' + st.failed : '') +
        (st.dead ? '，已停 ' + st.dead : '') + '（点击重试）';
    }
    // 工单面板状态行
    var row = document.getElementById('syncStatusRow');
    if (row) {
      var text = '';
      if (st.lastServerJobNo && st.pending === 0) {
        text = '☁ 已同步到账本，单号 ' + st.lastServerJobNo;
      } else if (st.pending > 0) {
        text = '☁ 待同步 ' + st.pending + ' 单（联网后自动重试）';
      } else if (st.failed + st.dead > 0) {
        var bad = loadQueue().queue.slice().reverse().find(function (e) { return e.last_error; });
        text = '⚠ 同步失败 ' + (st.failed + st.dead) + ' 单' + (bad ? '：' + bad.last_error : '');
      }
      row.textContent = text;
      row.hidden = !text;
    }
    // E3：工单面板同步按钮态——已入队/已同步的工单显示提示文案
    var syncBtn = document.getElementById('syncWorkOrder');
    if (syncBtn) {
      var wo = window.UI && window.UI.state && window.UI.state.workOrder;
      var done = wo && wo._synced_client_job_id;
      var base = '☁ 同步到账本';
      syncBtn.textContent = done ? '☁ 已同步（再点将新建一单）' : base;
      if (done) syncBtn.title = '该工单已同步过' + (wo._synced_job_no ? '（单号 ' + wo._synced_job_no + '）' : '') + '；再次同步将新建一单';
      else syncBtn.removeAttribute('title');
    }
  }

  /* ---------- 初始化 ---------- */

  function _init() {
    if (typeof document === 'undefined') return;
    _updateUI();
    window.addEventListener('online', function () { flushNow(); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) flushNow();
    });
    // 轮询循环：离线退避 60s→300s，在线恢复 60s
    (function pollLoop() {
      flushNow().then(function (acc) {
        _pollMs = (acc && acc.offline) ? Math.min(_pollMs * 2, 300000) : 60000;
        setTimeout(pollLoop, _pollMs);
      });
    })();
    fetchBootstrap(); // 启动即拉一次读反哺
    setInterval(function () { fetchBootstrap(); }, 300000); // 每 5 分钟刷新主数据/财务状态
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _init);
    } else {
      _init();
    }
  }

  window.SpraySync = {
    buildJobPayload: buildJobPayload,
    genJobNo: genJobNo,
    uuid: uuid,
    localDateStr: localDateStr,
    nextRetryDelayMs: nextRetryDelayMs,
    isDead: isDead,
    enqueueCurrent: enqueueCurrent,
    fetchBootstrap: fetchBootstrap,
    getCloud: getCloud,
    cloudParty: cloudParty,
    flushNow: flushNow,
    requeueFailed: requeueFailed,
    getStatus: getStatus,
    getSettings: getSettings,
    setSettings: setSettings,
    _queue: { load: loadQueue, save: saveQueue } // 测试专用
  };
})();
