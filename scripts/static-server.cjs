/**
 * static-server.cjs — 零依赖静态文件服务器（只用 Node 内置模块）
 *
 * 用法:
 *   node scripts/static-server.cjs [port] [rootDir]
 *
 * 默认端口 8080，默认根目录 = <仓库>/dist（构建产物，E0.1/C-2 静态收敛：
 * 绝不默认托管仓库根——否则 data/app.db、server/、tests/ 全部可被下载）。
 * 要托管其它目录必须显式传 rootDir 参数。
 * 默认只绑 127.0.0.1（fail-closed，同 C-1 哲学）；要对外监听显式设
 * BIND_HOST=0.0.0.0（deploy/install-linux.sh 的公网形态就是这么做的）。
 *
 * 开发用途：默认禁用缓存，改完文件刷新即生效。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

/* ---------- 可单测的纯函数（module.exports 见文件末尾） ---------- */

/** 目录穿越判定（M-5 修复）：裸 startsWith(ROOT) 会被同级前缀目录
 *  （如 ROOT=D:\x\spraybook 时 D:\x\spraybook-data）绕过——必须补路径分隔符。 */
function isInsideRoot(root, filePath) {
  const r = path.normalize(root);
  const f = path.normalize(filePath);
  return f === r || f.startsWith(r + path.sep);
}

/** 默认根目录 = dist/（C-2）；显式传参可覆盖（部署脚本/本地调试用）。 */
function resolveRoot(argvRoot) {
  return path.resolve(argvRoot || path.join(__dirname, '..', 'dist'));
}

/** 默认绑 127.0.0.1（fail-closed）；BIND_HOST 显式设置优先。 */
function resolveHost(envHost) {
  return envHost || '127.0.0.1';
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.cjs':  'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.txt':  'text/plain; charset=utf-8',
  '.apk':  'application/vnd.android.package-archive',
};

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}

function createHandler(ROOT) {
  return (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(url.parse(req.url).pathname);
    } catch (e) {
      return send(res, 400, 'Bad Request');
    }

    if (pathname === '/') pathname = '/index.html';

    let filePath = path.normalize(path.join(ROOT, pathname));

    // 目录穿越防护（M-5：补路径分隔符判定，防同级前缀目录绕过）
    if (!isInsideRoot(ROOT, filePath)) {
      return send(res, 403, 'Forbidden');
    }

    fs.stat(filePath, (err, st) => {
      if (err) {
        return send(res, 404, `404 Not Found: ${pathname}`, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      if (st.isDirectory()) {
        const idx = path.join(filePath, 'index.html');
        if (fs.existsSync(idx)) {
          filePath = idx;
        } else {
          return send(res, 403, 'Directory listing disabled');
        }
      }
      const ext = path.extname(filePath).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      fs.createReadStream(filePath).pipe(res);
    });
  };
}

function start() {
  const PORT = parseInt(process.argv[2], 10) || 8080;
  const ROOT = resolveRoot(process.argv[3]);
  const HOST = resolveHost(process.env.BIND_HOST);

  if (!fs.existsSync(ROOT)) {
    console.error(`[static-server] 根目录不存在: ${ROOT}`);
    console.error('[static-server] 默认只托管 dist/（构建产物）——先运行 scripts\\build-web.ps1 生成，或显式传入目录参数。');
    process.exit(1);
  }

  const server = http.createServer(createHandler(ROOT));
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[ERROR] 端口 ${PORT} 已被占用`);
      process.exit(2);
    }
    console.error('[ERROR]', err.message);
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    console.log(`[static-server] root = ${ROOT}`);
    console.log(`[static-server] http://${HOST}:${PORT}`);
    if (HOST !== '127.0.0.1') {
      console.log(`[static-server] ⚠ 绑定 ${HOST}（非仅本机）——确认该目录不含任何数据文件`);
    }
  });
  return server;
}

if (require.main === module) start();

module.exports = { isInsideRoot, resolveRoot, resolveHost, createHandler };
