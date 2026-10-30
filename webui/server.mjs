// ZhuDownLoader 网页版服务 — 本机 HTTP 服务 + SSE 实时推送，复用 lib/downloader.mjs 下载核心。
// 只监听 127.0.0.1，不对局域网开放。启动方式：node webui/server.mjs [--port 7788] [--no-open]
// 或双击项目根目录的「网页版下载.bat」。
import http from 'http';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { BatchRunner } from './batch.mjs';
import { parseList } from '../lib/listparse.mjs';
import { openInDownloadBrowser, closeBrowserSession } from '../lib/downloader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'webui', 'public');
// 默认输出目录：各平台统一落到「下载/ZhuDownLoader」（不依赖个人盘符，换电脑也能跑）
const DEFAULT_OUT = path.join(process.env.HOME || process.env.USERPROFILE || process.cwd(), 'Downloads', 'ZhuDownLoader');
const MAX_BODY = 5 * 1024 * 1024; // 清单体量上限 5MB，防误粘超大内容

/** 按平台打开文件管理器/浏览器；打开失败不阻塞 HTTP 响应。 */
function openWithOs(target) {
  const cmd = process.platform === 'darwin' ? `open "${target}"`
    : process.platform === 'win32' ? `start "" "${target}"`
      : `xdg-open "${target}"`;
  exec(cmd, { windowsHide: true }, () => {});
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

// ---------- SSE 广播 ----------

const clients = new Set();

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const res of clients) sseWrite(res, event, data);
}

// ---------- HTTP ----------

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体超过 5MB 上限')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  try { return JSON.parse(raw || '{}'); } catch { throw new Error('请求不是合法 JSON'); }
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/** Windows 绝对路径校验：网页输入是用户手敲的，必须挡掉相对路径与非法字符。 */
function normalizeOutDir(input) {
  const p = String(input ?? '').trim().replace(/^["']|["']$/g, '');
  if (!/^[a-zA-Z]:[\\/]/.test(p)) throw new Error('请填写完整的 Windows 路径，例如 E:\\Papers');
  return path.resolve(p);
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

/**
 * 启动网页版服务。
 * @param {{port?: number, downloadFn?: Function, openManualFn?: Function}} [opts] port 传 0 由系统分配（测试用）
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export function startServer({ port = 7788, downloadFn, openManualFn = openInDownloadBrowser } = {}) {
  const runner = new BatchRunner({
    onEvent: e => broadcast(e.type, e),
    ...(downloadFn ? { downloadFn } : {}),
  });
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      try {
        if (req.method === 'GET' && u.pathname === '/api/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
            'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
          });
          res.write(': connected\n\n');
          clients.add(res);
          sseWrite(res, 'snapshot', runner.snapshot);
          req.on('close', () => clients.delete(res));
          return;
        }
        if (req.method === 'GET' && u.pathname === '/api/defaults') {
          return sendJson(res, 200, { outDir: DEFAULT_OUT });
        }
        if (req.method === 'GET' && u.pathname === '/api/sample') {
          try { return sendJson(res, 200, { text: fs.readFileSync(path.join(ROOT, 'sample.txt'), 'utf8') }); }
          catch { return sendJson(res, 404, { error: 'sample.txt 不存在' }); }
        }
        if (req.method === 'GET' && u.pathname === '/api/status') {
          return sendJson(res, 200, runner.snapshot);
        }
        if (req.method === 'POST' && u.pathname === '/api/preview') {
          const { text } = await readJson(req);
          return sendJson(res, 200, { ...parseList(String(text ?? '')) });
        }
        if (req.method === 'POST' && u.pathname === '/api/start') {
          if (runner.isRunning) return sendJson(res, 409, { error: '已有批次在运行，请等它结束或先点「停止」' });
          const body = await readJson(req);
          const outDir = normalizeOutDir(body.outDir);
          // 未传时回落与 CLI 相同的默认值；传了但不合法才报错
          const concurrency = body.concurrency === undefined ? 2 : Number(body.concurrency);
          const retries = body.retries === undefined ? 1 : Number(body.retries);
          if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) throw new Error('并发数须为 1~6 的整数');
          if (!Number.isInteger(retries) || retries < 0 || retries > 5) throw new Error('重试次数须为 0~5 的整数');
          const { dois, skipped } = parseList(String(body.text ?? ''));
          if (dois.length === 0) throw new Error('清单里没有识别到任何 DOI，请检查内容');
          // 不 await：批次跑几分钟，HTTP 响应只确认受理；启动后的意外错误经 SSE 告知页面
          runner.run(String(body.text ?? ''), { outDir, concurrency, retries })
            .catch(e => broadcast('batch-error', { message: e?.message || String(e) }));
          return sendJson(res, 200, { ok: true, total: dois.length, skipped, outDir });
        }
        if (req.method === 'POST' && u.pathname === '/api/stop') {
          runner.stop();
          return sendJson(res, 200, { ok: true, running: runner.isRunning });
        }
        if (req.method === 'POST' && u.pathname === '/api/manual/open') {
          if (runner.isRunning) return sendJson(res, 409, { error: '请等当前批次结束后再打开验证页面' });
          const manualList = runner.snapshot.summary?.manualList || [];
          if (manualList.length === 0) return sendJson(res, 409, { error: '当前没有需要人工验证的文章' });
          const opened = await openManualFn(manualList.map(it => it.resolveUrl || `https://doi.org/${it.doi}`));
          return sendJson(res, 200, { ok: true, count: Array.isArray(opened) ? opened.length : manualList.length });
        }
        if (req.method === 'POST' && u.pathname === '/api/open-folder') {
          const body = await readJson(req);
          const dir = normalizeOutDir(body.outDir);
          if (!fs.existsSync(dir)) throw new Error(`文件夹不存在: ${dir}`);
          openWithOs(dir); // Windows 下 explorer 打开成功也返回退出码 1，不据此判失败
          return sendJson(res, 200, { ok: true });
        }
        if (req.method === 'GET') return serveStatic(req, res, u.pathname);
        res.writeHead(405); res.end();
      } catch (e) {
        sendJson(res, 400, { error: e?.message || String(e) });
      }
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: async () => {
        await new Promise(r => {
        // keep-alive 连接不主动断掉会让 close 悬挂，Windows 下还会触发 libuv 退出断言
        server.close(() => r());
        server.closeAllConnections();
        });
        await closeBrowserSession();
      },
    }));
  });
}

// ---------- 直跑入口 ----------

function parseFlags(argv) {
  const flags = { port: 7788, open: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') flags.port = Number(argv[++i]);
    else if (argv[i] === '--no-open') flags.open = false;
  }
  return flags;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const flags = parseFlags(process.argv.slice(2));
  try {
    const { port } = await startServer({ port: flags.port });
    const url = `http://127.0.0.1:${port}`;
    console.log(`✅ ZhuDownLoader 网页版已启动: ${url}`);
    console.log('   请保持本窗口开着；下载完成后可关掉窗口（Ctrl+C）退出。');
    if (flags.open) openWithOs(url);
  } catch (e) {
    if (e?.code === 'EADDRINUSE') {
      console.error(`❌ 端口 ${flags.port} 被占用。可能网页版已经在运行——直接打开 http://127.0.0.1:${flags.port} 即可；或换端口：node webui/server.mjs --port 7789`);
    } else {
      console.error(`❌ 启动失败: ${e?.message || e}`);
    }
    process.exit(1);
  }
}
