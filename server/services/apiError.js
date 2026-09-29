/* ============================================================
   services/apiError.js — 统一 API 错误
   ============================================================ */
'use strict';

class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

module.exports = { ApiError };
