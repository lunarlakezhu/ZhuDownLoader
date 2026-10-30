// ScienceDirect(FlareSolverr) 独立适配器 —— 行动方案阶段一产物，不触碰现有下载流程。
// 输入 DOI，返回四态结果：ok / no-access / challenge / temporary-error
// （wiki/ScienceDirect-自动下载行动方案-2026-09-25.md）。配方来自 FlareSolverr 三轮试验
// （wiki/FlareSolverr-试验结果-2026-09-25.md）：
//   FlareSolverr 会话直连文章页 → CDP 接管「该会话自己的」Chrome 标签页 → 同标签页打开带签名
//   pdfft View 链接 → 落地 pdf.sciencedirectassets.com 签名地址 → 回文章页在页内
//   fetch(assetUrl, {credentials:'omit'}) → 分块搬出字节 → %PDF- 头 / %%EOF 尾校验后落盘。
// 纪律：
//   - 不写 download.log（阶段二由 downloadOne 统一记日志）；
//   - 对外 reason/note 不含 cookie、签名参数与机构会话：URL 一律剥查询串后再入日志；
//   - 只接管标签页 URL 含本文 PII 的 FlareSolverr Chrome，匹配不唯一立即安全退出，不接管其他会话；
//   - 无论成败都断开 CDP 连接并销毁本次创建的 FlareSolverr 会话，不碰其他下载任务的浏览器。
import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec } from 'child_process';
import { chromium } from 'playwright';
import { sanitize } from './downloader.mjs';

// FLARESOLVERR_API 环境变量仅用于测试「服务未启动」场景（换一个不存在的端口），默认本机 8191
const FLARESOLVERR_API = process.env.FLARESOLVERR_API || 'http://127.0.0.1:8191';
const CROSSREF_UA = 'ZhuDownLoader/1.0 (mailto:probe@example.org)';

// 无权限提示标记：SD 未订阅文章页可见区域的购买/租购/登录提示。只匹配渲染可见 HTML
// （剥掉 <script>/<style>），避免命中 JS 打包文件里的同名常量而误判有权限的文章。
const NO_ACCESS_RES = [
  ['purchase-pdf', /purchase\s*pdf/i],
  ['purchase-link', /purchasepdf/i],
  ['rent-or-buy', /\brent\s+or\s+buy\b/i],
  ['signin-to-access', /sign\s*in\s*to\s*access/i],
  ['purchase-shop-url', /\/shop\/purchase/i],
];

/** 剥掉 URL 查询串（签名参数不外泄）并截断。 */
const stripQuery = (s, n = 120) => String(s || '').split('?')[0].slice(0, n);

/** 渲染可见 HTML：脚本与样式块剔除后，购买提示按钮文本/链接仍在，打包常量不参与匹配。 */
const visibleHtml = html => String(html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ');

const noAccessMarkers = html => NO_ACCESS_RES.filter(([, re]) => re.test(html)).map(([tag]) => tag);

/** POST FlareSolverr /v1。响应非 JSON 或网络异常时统一返回 {status:'error', message}。 */
async function postFs(body, timeoutMs = 60000) {
  try {
    const r = await fetch(`${FLARESOLVERR_API}/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await r.json();
  } catch (e) {
    return { status: 'error', message: `FlareSolverr 请求异常(${String(e.cause?.code || e.message).slice(0, 50)})` };
  }
}

/** 本机 FlareSolverr 可用性探测（快速失败，供阶段二决定是否走旧路径）。 */
export async function checkFlaresolverr() {
  try {
    const r = await fetch(`${FLARESOLVERR_API}/health`, { signal: AbortSignal.timeout(4000) });
    return r.ok ? { available: true, message: '' } : { available: false, message: `health 返回 HTTP ${r.status}` };
  } catch (e) {
    return { available: false, message: `${stripQuery(FLARESOLVERR_API, 40)} 无法连接(${String(e.cause?.code || e.message).slice(0, 40)})` };
  }
}

/** Crossref 记录取 PII（只接受 S 形态）与标题，供防错篇校验。 */
async function piiFromCrossref(doi) {
  const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
    headers: { 'User-Agent': CROSSREF_UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`Crossref 查询失败(HTTP ${r.status})`);
  const m = (await r.json()).message;
  const pii = (m['alternative-id'] || []).find(x => /^S[A-Za-z0-9]+$/.test(x)) || null;
  return { pii, title: (m.title || [])[0] || '' };
}

// ====== 本会话 Chrome 调试端口发现 ======
// FlareSolverr 的 Chrome 以 --remote-debugging-port 启动（=0 时端口写在 profile 的
// DevToolsActivePort 文件里）。全部枚举后按「标签页 URL 含本文 PII」唯一锁定本会话的
// 那一台；命中多台时优先保留带 FlareSolverr 痕迹的（自带浏览器 _internal / flaresolverr
// 目录），仍不唯一立即放弃——宁可失败也不接管别的会话。
// 实现注意：进程枚举用临时 .ps1 文件 + JSON 输出。经 cmd.exe 内联传 PowerShell 脚本的
// 引号转义链路在实测中输出格式不稳定（2026-09-25 同一命令多次跑出行形态漂移），不可依赖。

const SCAN_PS1 = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$procs = Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" |",
  "  Where-Object { $_.CommandLine -match 'remote-debugging' } |",
  "  ForEach-Object { [pscustomobject]@{ p = $_.ProcessId; cl = $_.CommandLine } }",
  "@{ procs = @($procs) } | ConvertTo-Json -Compress",
].join('\r\n');

function listChromeCmdlines() {
  const ps1 = path.join(os.tmpdir(), `zhudl-chrome-scan-${process.pid}.ps1`);
  const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`;
  return new Promise(resolve => {
    fs.writeFileSync(ps1, SCAN_PS1, 'utf8');
    exec(cmd, { timeout: 25000, windowsHide: true }, (e, so) => {
      fs.rmSync(ps1, { force: true });
      if (e) {
        resolve({ procs: [], err: `进程扫描失败(${e.killed ? '超时' : `退出码${e.code ?? '?'}`})` });
        return;
      }
      try {
        const j = JSON.parse(String(so || '{}'));
        resolve({ procs: (j.procs || []).map(p => ({ pid: String(p.p), cl: String(p.cl || '') })), err: '' });
      } catch {
        resolve({ procs: [], err: `进程扫描输出非JSON(${String(so || '').slice(0, 60)})` });
      }
    });
  });
}

/** port=0 时从 profile 目录读真实端口（首行=端口，次行=浏览器路径）。 */
function devtoolsPortFromProfile(udd) {
  try {
    const first = fs.readFileSync(path.join(udd, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
    return /^\d+$/.test(first) ? first : null;
  } catch { return null; }
}

async function listTargets(port, attempts = 2) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) return await r.json();
    } catch { /* 端口刚就绪可能抖动，重试一次 */ }
    if (i < attempts - 1) await new Promise(res => setTimeout(res, 1500));
  }
  return null;
}

/**
 * 枚举带调试端口的 chrome.exe，找标签页 URL 含 PII 的唯一 Chrome。
 * 注意：同一 Chrome 的浏览器主进程与子进程共享同一 --remote-debugging-port 标志
 * （2026-09-25 实测 6 个进程同端口），必须按端口合并去重，否则唯一性判定必然误报。
 * @returns {{chrome: {pid, port, udd, tabUrl}|null, ambiguous: boolean, scanned: number, detail: string}}
 */
async function findSessionChrome(pii) {
  const { procs, err } = await listChromeCmdlines();
  const byPort = new Map();
  for (const { cl } of procs) {
    if (!/chrome\.exe/i.test(cl)) continue;
    const um = cl.match(/--user-data-dir=(?:"([^"]+)"|([^\s"]+))/);
    const udd = um ? (um[1] || um[2]) : '';
    const pm = cl.match(/--remote-debugging-port=(\d+)/);
    let port = pm && pm[1] !== '0' ? pm[1] : null;
    if (!port && udd) port = devtoolsPortFromProfile(udd);
    if (!port) continue;
    if (!byPort.has(port)) {
      byPort.set(port, { pid: 0, port, udd, isFs: /flaresolverr|_internal/i.test(cl) });
    }
  }

  const hits = [];
  for (const c of byPort.values()) {
    const targets = await listTargets(c.port);
    if (targets === null) continue; // 端口不可达：不是本会话可用 Chrome
    const tabs = targets.filter(t => t.type === 'page' && (t.url || '').includes(pii));
    if (tabs.length === 1) hits.push({ ...c, tabUrl: stripQuery(tabs[0].url, 100) });
    else if (tabs.length > 1) {
      return { chrome: null, ambiguous: true, scanned: byPort.size, detail: `port=${c.port} 有${tabs.length}个含PII标签页` };
    }
  }

  let pool = hits;
  if (pool.length > 1) pool = pool.filter(h => h.isFs); // 用户自己 Chrome 恰好开着同文：只认 FlareSolverr 痕迹
  return { chrome: pool.length === 1 ? pool[0] : null, ambiguous: pool.length > 1, scanned: byPort.size, detail: err };
}

// ====== 主流程 ======

let chain = Promise.resolve();

/**
 * 单篇下载（模块级串行：同时只有一个 FlareSolverr 会话在跑，规避接错 Chrome）。
 * @param {string} doi DOI
 * @param {string} outDir 输出目录（须已存在）
 * @param {{onNote?: (msg: string) => void}} [opts] 过程提示回调（内容已脱敏）
 * @returns {Promise<{doi: string, pii: string, status: 'ok'|'no-access'|'challenge'|'temporary-error',
 *   reason: string, path: string, bytes: number, durationMs: number}>}
 */
export function downloadViaFlaresolverr(doi, outDir, opts = {}) {
  const next = chain.then(() => downloadOnce(doi, outDir, opts));
  chain = next.catch(() => {});
  return next;
}

async function downloadOnce(doi, outDir, { onNote } = {}) {
  const start = Date.now();
  const note = msg => { try { onNote?.(msg); } catch { /* 回调异常不阻塞主流程 */ } };
  const result = { doi, pii: '', status: 'temporary-error', reason: '', path: '', bytes: 0, durationMs: 0 };
  const finish = (status, reason) => {
    Object.assign(result, { status, reason, durationMs: Date.now() - start });
    return result;
  };

  const tmp = path.join(outDir, `.flaresolverr-${sanitize(doi)}.tmp`);
  let session = '';
  let browser = null;

  try {
    // ① Crossref → PII（只接受 S 形态）
    note('解析 PII(Crossref)...');
    let pii = '';
    let crTitle = '';
    try {
      ({ pii, title: crTitle } = await piiFromCrossref(doi));
    } catch (e) {
      return finish('temporary-error', String(e.message || e).slice(0, 100));
    }
    if (!pii) return finish('temporary-error', 'Crossref 无 S 形态 PII(可能非 ScienceDirect 文章)');
    result.pii = pii;
    const articleUrl = `https://www.sciencedirect.com/science/article/pii/${pii}`;

    // ② 服务可用性（快速失败）
    const fsHealth = await checkFlaresolverr();
    if (!fsHealth.available) return finish('temporary-error', `FlareSolverr 不可用: ${fsHealth.message}`);

    // ③ 本次任务专用会话，直连文章页（不走 doi.org/linkinghub，避免带回未解完的质询页）
    session = `zhudl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const created = await postFs({ cmd: 'sessions.create', session }, 120000);
    if (created.status !== 'ok') return finish('temporary-error', `创建 FlareSolverr 会话失败: ${stripQuery(created.message)}`);
    note('FlareSolverr 会话打开文章页(过质询约需 30s)...');

    let html = '';
    let failKind = 'temporary-error';
    let failMsg = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const a = await postFs({ cmd: 'request.get', session, url: articleUrl, maxTimeout: 150000 }, 170000);
      if (a.status === 'ok') {
        html = a.solution?.response || '';
        if (/citation_title/i.test(html)) break;
        // FlareSolverr 报 ok 但页面不是文章页 = 质询没解开（其源码把 http 状态固定 200，不可信）
        failKind = 'challenge';
        failMsg = '返回页非文章页(人机验证未放行)';
      } else {
        const msg = stripQuery(a.message, 100);
        failKind = /challenge|captcha|robot|cloudflare/i.test(msg) ? 'challenge' : 'temporary-error';
        failMsg = `打开文章页失败: ${msg}`;
      }
      if (attempt === 1) note(`首次未就绪(${failMsg})，重试一次...`);
    }
    if (!html) return finish(failKind, failMsg);

    // ④ 防错篇校验：页面 DOI（缺 meta 时退标题比对）
    const pageDoi = (/name="citation_doi"[^>]*content="([^"]+)"/i.exec(html)
      || /content="([^"]+)"[^>]*name="citation_doi"/i.exec(html) || [])[1] || '';
    const norm = s => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, '')
      .replace(/https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/[^a-z0-9]+/gi, '').toLowerCase();
    if (pageDoi) {
      if (norm(pageDoi) !== norm(doi)) return finish('temporary-error', `页面DOI与请求不符(${stripQuery(pageDoi, 60)})，防错篇校验终止`);
    } else {
      const pageTitle = /name="citation_title"[^>]*content="([^"]+)"/i.exec(html)?.[1] || '';
      const a = norm(pageTitle);
      const b = norm(crTitle);
      const similar = a && b && (a === b || (a.length >= 30 && b.length >= 30 && (a.includes(b) || b.includes(a))));
      if (!similar) return finish('temporary-error', '页面缺 citation_doi 且标题与 Crossref 不符，防错篇校验终止');
    }
    note(`文章页就绪: ${(crTitle || '').slice(0, 60)}`);

    // ④b 首次响应通常不含 md5 签名 pdfft 链接（签名在首过质询后的下一轮请求才下发，
    // 2026-09-25 实测）：同会话重取一次文章页，大概率拿到带签名链接的 HTML
    if (!new RegExp(`/science/article/pii/${pii}/pdfft\\?md5=`, 'i').test(html)) {
      note('首响无签名PDF链接，同会话重取一次...');
      const a2 = await postFs({ cmd: 'request.get', session, url: articleUrl, maxTimeout: 150000 }, 170000);
      if (a2.status === 'ok' && /citation_title/i.test(a2.solution?.response || '')) {
        html = a2.solution.response;
      }
    }

    // ⑤ 定位本会话自己的 Chrome（标签页 URL 含本文 PII 的唯一一台），CDP 接管
    note('定位本会话 Chrome 调试端口...');
    const { chrome, ambiguous, scanned, detail } = await findSessionChrome(pii);
    if (!chrome) {
      const why = detail || (ambiguous ? '含本文PII的Chrome/标签页不唯一' : `扫描到${scanned}台Chrome但无含本文PII标签页`);
      return finish('temporary-error', `未定位到本会话Chrome: ${why}`);
    }
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${chrome.port}`, { timeout: 20000 });
    } catch (e) {
      return finish('temporary-error', `CDP 连接失败(${String(e.message || e).slice(0, 50)})`);
    }
    const pages = browser.contexts().flatMap(c => c.pages()).filter(p => p.url().includes(pii));
    if (pages.length !== 1) {
      return finish('temporary-error', `CDP 标签页匹配${pages.length ? '不唯一' : '失败'}，按纪律安全退出`);
    }
    const page = pages[0];

    // ⑥ 签名 pdfft View 链接：文章页 HTML 里的 md5 签名链 → 活动页 DOM（必须按本文 PII
    // 过滤——侧栏相关文章也各有 View PDF 链接，取第一个会拿到别人的）→ 未签名兜底
    const signedRe = new RegExp(`/science/article/pii/${pii}/pdfft\\?md5=[^"'\\s<>]+`, 'i');
    const sm = signedRe.exec(html);
    let viewUrl = sm ? 'https://www.sciencedirect.com' + sm[0].replace(/&amp;/g, '&') : '';
    let viewKind = sm ? 'signed' : '';
    if (!viewUrl) {
      const dom = await page.evaluate(p => {
        const a = [...document.querySelectorAll('a[href*="pdfft"]')].find(x => (x.href || '').includes(p));
        return a ? a.href : '';
      }, pii).catch(() => '');
      if (dom) { viewUrl = dom; viewKind = /md5=/i.test(dom) ? 'dom-signed' : 'dom-plain'; }
    }
    if (!viewUrl) {
      // 无签名链接：有购买提示即证据明确，直接判无权限，省一次注定弹回的导航
      const markers = noAccessMarkers(visibleHtml(html));
      if (markers.length) return finish('no-access', `文章页无签名PDF链接且出现无权限提示(${markers.join('/')})`);
      viewUrl = `${articleUrl}/pdfft?isDTMRedir=true&download=true`;
      viewKind = 'unsigned';
    }
    note(`打开 PDF View 链接(${viewKind})...`);

    // ⑦ 同标签页导航到 View 链接：craft JS 跑完后要么落地资产域，要么弹回文章页
    await page.goto(viewUrl, { waitUntil: 'commit', timeout: 45000 }).catch(() => { });
    let assetUrl = '';
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const u = page.url();
      if (/sciencedirectassets\.com/i.test(u) && /\.pdf/i.test(u)) { assetUrl = u; break; }
      // 弹回文章页（pdfft 端点把无权限/未放行会话甩回来）
      if (/sciencedirect\.com/i.test(u) && u.includes(pii) && !/pdfft/i.test(u)) break;
      await page.waitForTimeout(1500);
    }

    if (!assetUrl) {
      const u = page.url();
      if (/sciencedirect\.com/i.test(u) && u.includes(pii)) {
        // 弹回文章页：结合页面可见区域的购买/访问提示判定——证据明确才判 no-access，
        // 可能只是质询没放行时不猜（方案原文：不要猜测为无权限）
        const backHtml = await page.evaluate(() => document.documentElement.outerHTML).catch(() => '');
        const markers = noAccessMarkers(visibleHtml(backHtml));
        if (markers.length) return finish('no-access', `PDF链接弹回文章页，出现无权限提示(${markers.join('/')})`);
        return finish('challenge', 'PDF链接弹回文章页但无明确权限提示(可能质询未放行，不误判为无权限)');
      }
      return finish('challenge', `PDF链接未完成跳转(滞留 ${stripQuery(u, 80)})`);
    }

    // 资产页可能自带一道 Cloudflare shell 质询（URL 先到、JS 后跑）：等它自动提交完
    // （壳页含 cf-chl 标记，PDF 查看器接管后即无）再回文章页，质询 cookie 才种得下。
    // 试验配方在落地后固定等 7s，等价目的；此处按标记轮询，上限 12s。
    const settleDeadline = Date.now() + 12000;
    while (Date.now() < settleDeadline) {
      const chl = await page.evaluate(() =>
        /cf-chl|challenge-platform|__cf_chl|just a moment/i.test(document.documentElement.innerHTML)
      ).catch(() => true);
      if (!chl) break;
      await page.waitForTimeout(1500);
    }
    note('抵达签名 PDF 资产地址，回文章页页内 fetch...');

    // ⑧ 回文章页，页内 fetch 签名资产地址（fetch 由这个 Chrome 发出，指纹天然正确），
    // 字节暂存页面内存分块搬出，避免一次性传输大 PDF。跨域 fetch 被 CORS 拒时走兜底 H：
    // 开一个落在资产域上的同源页（robots.txt）再 fetch，同源无 CORS（试验配方 G/H）。
    await page.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => { });
    await page.waitForTimeout(2500);
    let fr = await pullPdfViaPage(page, assetUrl, tmp, 'omit');

    if (!fr.ok && /fetch异常|evaluate失败/i.test(fr.err)) {
      note('文章页跨域fetch被拒，改走资产域同源fetch(带cookie)...');
      const page2 = await page.context().newPage();
      try {
        await page2.goto('https://pdf.sciencedirectassets.com/robots.txt', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
        // 同源 fetch 必须带 cookie：cf_clearance 在 cookie 罐里，omit 反而会被资产域质询
        fr = await pullPdfViaPage(page2, assetUrl, tmp, 'include');
      } finally {
        await page2.close().catch(() => { });
      }
    }

    if (!fr.ok) {
      // 资产地址刚签名就被拒（403/HTML/超时）：多为质询链路问题，按方案归 challenge，不猜无权限
      const status = /HTTP 403|非PDF内容/.test(fr.err) ? 'challenge' : 'temporary-error';
      return finish(status, `取PDF失败: ${fr.err}`);
    }

    // ⑨ 校验已在落盘时分步做毕（%PDF- 头、大小、%%EOF 尾），改名成品
    const out = path.join(outDir, `${sanitize(doi)}.pdf`);
    fs.renameSync(tmp, out);
    note(`PDF 校验通过(${Math.round(fr.size / 1024)}KB)`);
    result.path = out;
    result.bytes = fr.size;
    return finish('ok', '');
  } catch (e) {
    return finish('temporary-error', `适配器异常: ${String(e?.message || e).slice(0, 80)}`);
  } finally {
    // ⑩ 无论成败：断开 CDP 连接（不关浏览器），销毁本次创建的会话，清理半成品
    try { if (browser) await browser.close(); } catch { /* 连接已断开 */ }
    if (session) await postFs({ cmd: 'sessions.destroy', session }, 30000).catch(() => { });
    if (result.status !== 'ok') fs.rmSync(tmp, { force: true });
  }
}

/** 在给定页面里 fetch 资产地址 → %PDF- 头校验 → 分块 b64 搬出写临时文件 → %%EOF 尾校验。
 *  credentials：跨域页用 'omit'（试验配方 G，配合资产域 ACAO:*）；同源页用 'include'
 *  （试验配方 H，cf_clearance 随 cookie 走，omit 会被资产域质询）。
 *  返回 {ok:true,size} 或 {err}。 */
async function pullPdfViaPage(page, assetUrl, tmp, credentials) {
  const fr = await page.evaluate(async ([u, cred]) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 150000);
    try {
      const resp = await fetch(u, { credentials: cred, signal: ctl.signal });
      if (resp.status !== 200) return { err: `HTTP ${resp.status}` };
      const buf = await resp.arrayBuffer();
      const head = new Uint8Array(buf.slice(0, 5));
      let hs = ''; for (const c of head) hs += String.fromCharCode(c);
      if (!hs.startsWith('%PDF-')) return { err: `非PDF内容(HTTP ${resp.status} 前缀${JSON.stringify(hs)} ${buf.byteLength}B)` };
      window.__zhudlPdf = buf; // 暂存页面内存，分块搬出，避免一次性传输大 PDF
      return { ok: true, size: buf.byteLength };
    } catch (e) {
      return { err: `页内fetch异常(${String(e && e.message || e).slice(0, 50)})` };
    } finally { clearTimeout(timer); }
  }, [assetUrl, credentials]).catch(e => ({ err: `evaluate失败(${String(e.message || e).slice(0, 50)})` }));

  if (!fr.ok) return fr;

  fs.writeFileSync(tmp, Buffer.alloc(0));
  try {
    for (let off = 0; off < fr.size; off += 1 << 20) {
      const b64 = await page.evaluate(o => {
        const buf = window.__zhudlPdf;
        const u8 = new Uint8Array(buf.slice(o, Math.min(buf.byteLength, o + 1048576)));
        let bin = '';
        for (let k = 0; k < u8.length; k += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(k, k + 0x8000));
        return btoa(bin);
      }, off);
      fs.appendFileSync(tmp, Buffer.from(b64, 'base64'));
    }
    await page.evaluate(() => { delete window.__zhudlPdf; }).catch(() => { });
  } catch (e) {
    return { err: `分块读取失败(${String(e?.message || e).slice(0, 50)})` };
  }

  const v = verifyTmpFile(tmp);
  return v.ok ? { ok: true, size: v.size } : { err: `校验未过: ${v.why}` };
}

/** 临时文件校验：文件头 %PDF-、大小 ≥10KB、结尾 1024B 内含 %%EOF。 */
function verifyTmpFile(file) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return { ok: false, why: '临时文件不存在' }; }
  if (size < 10240) return { ok: false, why: `文件过小(${size}B)` };
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(5);
    fs.readSync(fd, head, 0, 5, 0);
    if (head.toString('latin1') !== '%PDF-') return { ok: false, why: '文件头非 %PDF-' };
    const tail = Buffer.alloc(Math.min(1024, size));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    if (!tail.includes('%%EOF')) return { ok: false, why: '结尾缺 %%EOF 标记(可能传输不完整)' };
    return { ok: true, size };
  } finally { fs.closeSync(fd); }
}
