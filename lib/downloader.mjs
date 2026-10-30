// 文献下载核心 — 从 pw_download.mjs 抽取：DOI 解析、出版商识别、24 条出版商策略、校验。
// 本模块不做任何 console 输出：进度经 onPhase(phase, info) 回调上报，终态经返回值传递。
// download.log 由本模块追加写入（单行格式：reason 内换行替换为空格）。
// 策略逻辑与 pw_download.mjs 已验证版本保持一致（PNAS DOM click、IEEE domcontentloaded、
// try/finally 关浏览器等）；Nature/Springer 的 cookie 二段重试已改为纯 Node fetch 实现
//（原 PowerShell+curl 子进程版因本机系统层拦截 curl.exe 外联而弃用，见 CookieSession 注释）。
import { chromium } from 'playwright';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { requestCfVisionClick, challengeBoxReady, cfAssistEvent, redactUrl } from './cf-assist.mjs';
// FlareSolverr 同浏览器会话适配器（行动方案阶段二）：Elsevier 分支按四态分流。
// 适配器反向 import 本模块的 sanitize（仅函数体内使用，ESM 循环引用安全）。
import { downloadViaFlaresolverr, checkFlaresolverr } from './elsevier-flaresolverr.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/**
 * 异步执行 shell 命令，超时或非零退出时抛错。
 * 批量并发下不能使用 execSync：它会阻塞事件循环，冻结同一进程内其他 worker 的 Playwright 会话。
 * @param {string} cmd 命令行（经 cmd.exe 解释，支持 start 等 内建命令）
 * @param {number} timeoutMs 超时毫秒数
 * @returns {Promise<string>} stdout
 */
function run(cmd, timeoutMs) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        // curl -s 等会吞掉 stderr，此时退回命令摘要；err.message 只是回显整条命令，无诊断价值
        const errText = stderr && stderr.toString().trim();
        const detail = errText ? errText.split('\n')[0].substring(0, 100) : cmd.substring(0, 80);
        const cause = err.killed ? '超时' : `退出码${err.code ?? '?'}`;
        reject(new Error(`外部命令失败(${cause}): ${detail}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

/** DOI → 安全文件名（与原 pw_download.mjs 一致）。 */
export function sanitize(doi) {
  return doi.replace(/[^a-zA-Z0-9.-]/g, '_').substring(0, 80);
}

/** 文件头是否为 %PDF-。 */
export function isPdfFile(file) {
  if (!fs.existsSync(file)) return false;
  const h = Buffer.alloc(4);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, h, 0, 4, 0); } finally { fs.closeSync(fd); }
  return h[0] === 0x25 && h[1] === 0x50;
}

/**
 * 输出目录中是否已有该 DOI 的有效 PDF（用于「已存在」跳过）。
 * @returns {string|null} 已存在文件路径，否则 null
 */
export function existingPdf(doi, outDir) {
  const file = path.join(outDir, `${sanitize(doi)}.pdf`);
  return isPdfFile(file) ? file : null;
}

/** 追加一条单行日志到 <outDir>/download.log；detail 内换行压成空格（HANDOVER §6 修复）。 */
export function appendLog(outDir, doi, pub, status, detail = '') {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const oneLine = String(detail).replace(/[\r\n]+/g, ' ').trim();
  fs.appendFileSync(path.join(outDir, 'download.log'), `[${ts}] ${doi} → ${String(pub).toUpperCase()} → ${status} ${oneLine}\n`);
}

/** 用系统浏览器打开 URL（需人工条目）。按平台选打开方式：Windows 走 Edge，macOS 优先 Edge、
 *  没装则退回默认浏览器，Linux 走 xdg-open。全部失败只意味着窗口没弹出，条目仍按需人工处理。 */
export async function openInEdge(url) {
  const candidates = process.platform === 'darwin'
    ? [`open -a "Microsoft Edge" "${url}"`, `open "${url}"`]
    : process.platform === 'win32'
      ? [`start msedge "${url}"`, `start "" "${url}"`]
      : [`xdg-open "${url}"`];
  for (const cmd of candidates) {
    try { await run(cmd, 15000); return; } catch { /* 换下一种打开方式再试 */ }
  }
}

/** doi.org 解析 + 出版商识别。无重定向（DOI 无效）时 publisher 为 unknown。 */
export async function resolvePublisher(doi) {
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(`https://doi.org/${doi}`, {
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120' },
        signal: AbortSignal.timeout(30000),
      });
      if (res.status < 500 || attempt === 1) break;
    } catch (e) {
      if (attempt === 1 || e?.cause?.code === 'EACCES') throw e;
    }
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  const resolveUrl = res.headers.get('location') || '';
  const url = resolveUrl.toLowerCase();
  let publisher = 'unknown';
  if (url.includes('nature.com')) publisher = 'nature';
  else if (url.includes('link.springer.com')) publisher = 'springer';
  else if (url.includes('pnas.org')) publisher = 'pnas';
  else if (url.includes('science.org')) publisher = 'science';
  else if (url.includes('ieeexplore.ieee.org')) publisher = 'ieee';
  else if (url.includes('sciencedirect.com') || url.includes('elsevier.com')) publisher = 'elsevier';
  else if (url.includes('sagepub.com') || url.includes('cnpereading.com')) publisher = 'sage';
  else if (url.includes('onlinelibrary.wiley.com')) publisher = 'wiley';
  else if (url.includes('journals.biologists.com')) publisher = 'biologists';
  else if (url.includes('royalsocietypublishing.org')) publisher = 'royalsociety';
  else if (url.includes('academic.oup.com')) publisher = 'oxford';
  else if (url.includes('pubs.acs.org')) publisher = 'acs';
  // 美国物理学会（PRL/PRX 等全家族）：doi.org 首跳 link.aps.org，部分老记录直跳 journals.aps.org
  else if (url.includes('aps.org')) publisher = 'aps';
  else if (url.includes('journals.physiology.org')) publisher = 'physiology';
  else if (url.includes('journals.uchicago.edu')) publisher = 'uchicago';
  // 剑桥哲学会旗下 Mathematical Proceedings 等落地 cambridge.org；Biological Reviews 落地 Wiley，走 wiley 策略
  else if (url.includes('cambridge.org')) publisher = 'cambridge';
  // MDPI 全家族（Applied Sciences/Remote Sensing/Sensors 等全 OA 刊），doi.org 直跳 www.mdpi.com
  else if (url.includes('mdpi.com')) publisher = 'mdpi';
  // IOP Publishing（J. Phys. A-D/Nuclear Fusion/JINST/ERL 等，DOI 前缀 10.1088），全刊落 iopscience.iop.org
  else if (url.includes('iopscience.iop.org')) publisher = 'iop';
  // BioMed Central / Springer Nature OA 平台（JNER、BMC 系等，DOI 前缀 10.1186）。BMC 刊是子域制
  // （jneuroengrehab.biomedcentral.com 等），按子域命中；2026-09-05 EMG 实跑 3 篇 JNER 全灭于此缺口
  else if (url.includes('biomedcentral.com')) publisher = 'bmc';
  // Frontiers 全 OA 平台（DOI 前缀 10.3389 等），citation_pdf_url 直链
  else if (url.includes('frontiersin.org')) publisher = 'frontiers';
  // Taylor & Francis（DOI 前缀 10.1080 等），doi/pdf/<DOI> 直链
  else if (url.includes('tandfonline.com')) publisher = 'tandf';
  // SPIE Digital Library（10.1117），PDF 地址不可拼须读 meta
  else if (url.includes('spiedigitallibrary.org')) publisher = 'spie';
  // AIP Publishing（10.1063），Akamai 壳页
  else if (url.includes('pubs.aip.org')) publisher = 'aip';
  // Optica（原 OSA，10.1364）
  else if (url.includes('opg.optica.org')) publisher = 'optica';
  return { publisher, resolveUrl, resolveStatus: res.status };
}

/** 校验产物：返回 {ok, bytes}；文件不存在返回 null。 */
function verifyFile(file) {
  if (!fs.existsSync(file)) return null;
  const s = fs.statSync(file);
  const h = Buffer.alloc(5);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, h, 0, 5, 0); } finally { fs.closeSync(fd); }
  return { ok: h.toString('latin1') === '%PDF-', bytes: s.size };
}

// ====== Nature/Springer 共用：纯 Node fetch 两段式下载（不再 exec PowerShell/curl） ======
// curl.exe 的对外连接在本机被系统层拦截（连接拒绝退出码 7，node fetch 与 PowerShell 均不受
// 影响，与启动环境无关），故子进程路线整体弃用。cookie 检查的弹回链
// （idp.nature.com / idp.springer.com 的 authorize → ?error=cookies_not_supported → 文章页
// HTML）由 fetch redirect:'manual' 逐跳收集 Set-Cookie，第二段整罐回放即得 PDF（与 harness
// packages/literature 的 CookieSession 同实现）。

/** 平面 cookie 罐会话：GET 跟随重定向并收集每跳 Set-Cookie，后续请求整罐回放。不做域/路径记账——目标出版商的门槛 cookie 都种在自家单一域上。 */
class CookieSession {
  /** @param {string} userAgent 每个请求都带的浏览器 UA */
  constructor(userAgent) {
    this.userAgent = userAgent;
    this.jar = new Map();
  }

  /**
   * GET 并跟随重定向（每跳收集 Set-Cookie、整罐回放）。
   * @param {string} url 绝对请求地址
   * @param {number} [timeoutMs=30000] 单跳超时
   * @returns {Promise<Buffer>} 最终响应体
   */
  async get(url, timeoutMs = 30000) {
    let current = url;
    for (let hop = 0; hop < 10; hop++) {
      const cookieHeader = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(current, {
        redirect: 'manual',
        headers: { 'User-Agent': this.userAgent, ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      for (const sc of res.headers.getSetCookie()) {
        // 只留 name=value；Path/Max-Age 等属性忽略
        const eq = sc.indexOf('=');
        if (eq <= 0) continue;
        const end = sc.indexOf(';', eq);
        this.jar.set(sc.slice(0, eq).trim(), (end === -1 ? sc.slice(eq + 1) : sc.slice(eq + 1, end)).trim());
      }
      const loc = res.headers.get('location');
      if (loc !== null && res.status >= 300 && res.status < 400) {
        current = new URL(loc, current).toString();
        continue;
      }
      return Buffer.from(await res.arrayBuffer());
    }
    throw new Error('重定向次数过多(>10)');
  }
}

/** 缓冲区头四字节是否为 %PDF。 */
const isPdfBuf = buf => buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === '%PDF';
const BOT_INTERSTITIAL = /just a moment|checking your browser|cf-chl|__uzdbm_|SSJSConnectorObj|validate\.perfdrive\.com/i;

/** 两段式直下：裸请求（OA 文直接给 PDF）→ 非 PDF 时带 cookie 回放；终态非 PDF 删掉残留再报错。 */
async function downloadPdfTwoPass(label, pdfUrl, doi, outDir, onPhase) {
  const out = path.join(outDir, `${sanitize(doi)}.pdf`);
  const session = new CookieSession(UA);
  const first = await session.get(pdfUrl);
  if (isPdfBuf(first)) {
    fs.writeFileSync(out, first);
    return out;
  }
  // 付费内容：第一段被弹回 HTML 文章页的同时种下门槛 cookie，第二段带上即过 cookie 检查
  onPhase?.('downloading', { note: 'cookie检查弹回，带cookie重试' });
  const second = await session.get(pdfUrl);
  if (isPdfBuf(second)) {
    fs.writeFileSync(out, second);
    return out;
  }
  fs.rmSync(out, { force: true }); // 清掉历史版本可能留下的 HTML 假 pdf，避免目录里留误导文件
  throw new Error(`${label}: 内容非PDF(可能无订阅权限)`);
}

async function downloadNature(doi, fullUrl, outDir, onPhase) {
  const articleId = (fullUrl || '').match(/articles\/([^/?]+)/)?.[1];
  if (!articleId) throw new Error('无法解析Nature文章ID');
  const pdfUrl = `https://www.nature.com/articles/${articleId}.pdf`;
  return downloadPdfTwoPass('Nature', pdfUrl, doi, outDir, onPhase);
}

// ====== Springer: content/pdf/<DOI>.pdf 直链，与 Nature 同款二段重试 ======
async function downloadSpringer(doi, outDir, onPhase) {
  // Springer 的规范 PDF 地址就是 DOI 直接进路径（斜杠保留），无需解析文章页
  const pdfUrl = `https://link.springer.com/content/pdf/${doi}.pdf`;
  return downloadPdfTwoPass('Springer', pdfUrl, doi, outDir, onPhase);
}

// ====== BioMed Central（biomedcentral.com，DOI 前缀 10.1186）：全 OA，直链两段，被拦落骨架 ======
// PDF 直链 = <落地 origin>/counter/pdf/<DOI>.pdf。BMC 刊是子域制（jneuroengrehab. 等），
// origin 必须取落地 URL 不能写死主域。直链被反爬弹回 HTML 时落 downloadPdfViaCfMeta 骨架
// 过质询读 citation meta。2026-09-05 EMG 实跑 3 篇 JNER 全灭于此前无路由。
async function downloadBMC(doi, resolveUrl, outDir, onPhase) {
  let origin = 'https://biomedcentral.com';
  try { origin = new URL(resolveUrl).origin; } catch { /* 落地 URL 异常时退主域 */ }
  try {
    return await downloadPdfTwoPass('BMC', `${origin}/counter/pdf/${doi}.pdf`, doi, outDir, onPhase);
  } catch (e) {
    if (!/内容非PDF/.test(e.message || '')) throw e; // 无权限等确定性失败直接上抛
    onPhase?.('downloading', { note: '直链被弹回，落浏览器骨架过质询...' });
  }
  return downloadPdfViaCfMeta('BMC', doi, outDir, onPhase);
}

// ====== Frontiers（frontiersin.org，DOI 前缀 10.3389）：全 OA，/articles/<DOI>/pdf 直链，同 BMC ======
async function downloadFrontiers(doi, outDir, onPhase) {
  try {
    return await downloadPdfTwoPass('Frontiers', `https://www.frontiersin.org/articles/${doi}/pdf`, doi, outDir, onPhase);
  } catch (e) {
    if (!/内容非PDF/.test(e.message || '')) throw e;
    onPhase?.('downloading', { note: '直链被弹回，落浏览器骨架过质询...' });
  }
  return downloadPdfViaCfMeta('Frontiers', doi, outDir, onPhase);
}

// ====== Taylor & Francis（tandfonline.com）：/doi/pdf/<DOI> 直链，同 BMC ======
async function downloadTandF(doi, outDir, onPhase) {
  try {
    return await downloadPdfTwoPass('T&F', `https://www.tandfonline.com/doi/pdf/${doi}`, doi, outDir, onPhase);
  } catch (e) {
    if (!/内容非PDF/.test(e.message || '')) throw e;
    onPhase?.('downloading', { note: '直链被弹回，落浏览器骨架过质询...' });
  }
  return downloadPdfViaCfMeta('T&F', doi, outDir, onPhase, { linkWaitMs: 10000 });
}

// ====== SPIE / AIP / Optica：PDF 地址不可拼，直接走骨架读 citation meta ======
async function downloadSPIE(doi, outDir, onPhase) {
  return downloadPdfViaCfMeta('SPIE', doi, outDir, onPhase);
}

async function downloadAIP(doi, outDir, onPhase) {
  return downloadPdfViaCfMeta('AIP', doi, outDir, onPhase);
}

async function downloadOptica(doi, outDir, onPhase) {
  return downloadPdfViaCfMeta('Optica', doi, outDir, onPhase);
}

// ====== PNAS: Playwright 点击 PDF 按钮 ======
async function downloadPNAS(doi, outDir, onPhase) {
  const ctx = await launchVisibleBrowser();
  let page;
  try {
    page = await ctx.newPage();
    await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

    onPhase?.('downloading', { note: '打开DOI页...' });
    await page.goto(`https://doi.org/${doi}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);

    onPhase?.('downloading', { note: '点击 Download PDF...' });
    // a#downloadPdfUrl 是页面规范元素；物理点击会被遮罩拦截，直接请求 PDF 端点返回 403，
    // 必须用 DOM click 走真实下载事件
    await page.waitForSelector('a#downloadPdfUrl', { timeout: 15000 })
      .catch(() => { throw new AccessRequiredError('PNAS: 文章页没有正文PDF按钮(需检查官网验证或机构登录)'); });

    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }).catch(() => null),
      page.locator('a#downloadPdfUrl').evaluate(el => el.click()),
    ]);

    if (!dl) throw new AccessRequiredError('PNAS: 点击官网正文按钮后未触发PDF下载(需检查官网验证或机构登录)');
    const out = path.join(outDir, `${sanitize(doi)}.pdf`);
    await dl.saveAs(out);
    return out;
  } finally {
    await page?.close().catch(() => {});
  }
}

// ====== Science: reader 可能跳文章页；只取正文 /doi/pdf/ 链接 ======
async function downloadScience(doi, outDir, onPhase) {
  const ctx = await launchVisibleBrowser();
  let page;
  try {
    page = await ctx.newPage();
    await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

    onPhase?.('downloading', { note: '打开 reader 页...' });
    // science.org 后台信标不断，networkidle 在慢网络下不能作为就绪条件。
    await page.goto(`https://www.science.org/doi/reader/${doi}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForCfClearance(page, 'Science', onPhase);

    onPhase?.('downloading', { note: '查找文章PDF链接...' });
    // reader 目前会跳到普通文章页；该页的 Download PDF 链接没有 download=true。
    // /doi/suppl/ 下的补充材料不能当正文 PDF。
    await page.waitForSelector('a[href*="/doi/pdf/"], a[href*="/doi/epdf/"], meta[name="citation_pdf_url"]', {
      state: 'attached', timeout: 15000,
    }).catch(() => {});
    const pdfHref = await page.evaluate(d => {
      const norm = s => {
        try { return decodeURIComponent(s).toLowerCase(); }
        catch { return s.toLowerCase(); }
      };
      return [...document.querySelectorAll('a[href*="/doi/pdf/"], a[href*="/doi/epdf/"]')]
        .map(a => a.href)
        .find(href => { const p = norm(new URL(href).pathname); return p.endsWith(`/doi/pdf/${norm(d)}`) || p.endsWith(`/doi/epdf/${norm(d)}`); })
        || document.querySelector('meta[name="citation_pdf_url"]')?.content || '';
    }, doi);
    // epdf 是内嵌 JS 阅读器（"reader environment loading" 的宿主：2026-09-26 卡死 + 09-27
    // 崩溃窗口两案）；/doi/pdf/ 直出原始 PDF 流（2026-09-27 探针实证 200 application/pdf）。
    // 发现 epdf 一律归一化成 pdf，绕过阅读器
    const pdfHrefNorm = (pdfHref || '').replace(/\/doi\/epdf\//, '/doi/pdf/');
    // 文章页可能因授权状态隐藏 PDF 按钮；仍试该出版社的正文端点一次。
    const bodyPdfUrl = new URL(pdfHrefNorm || `/doi/pdf/${doi}`, page.url()).toString();
    const r = await fetchPdfInPage(page, bodyPdfUrl).catch(e =>
      ({ ok: false, sig: '', status: '请求中断', size: 0, sample: e.message }));
    let pdf = r.ok && r.sig === '%PDF' ? Buffer.from(r.b64, 'base64') : null;
    let challenge = BOT_INTERSTITIAL.test(r.sample || '');
    let challengeSource = challenge ? 'sample-regex' : '';
    let nav = null;
    if (!pdf) {
      onPhase?.('downloading', { note: '页面内请求未取得正文，尝试浏览器打开同一官网PDF链接...' });
      const navPage = await ctx.newPage();
      try { nav = await fetchPdfByNavigation(navPage, bodyPdfUrl, onPhase, page.url(), 'Science'); }
      finally { await navPage.close().catch(() => {}); }
      pdf = nav.buf;
      if (!challengeSource && (nav.evidence?.challengeSource || 'none') !== 'none') challengeSource = nav.evidence.challengeSource;
      challenge ||= nav.challenge || CF_CHALLENGE_TITLE.test(nav.title);
    }
    if (!pdf && !challenge) {
      onPhase?.('downloading', { note: '点击官网正文PDF按钮...' });
      const clicked = await fetchPdfByClick(page, bodyPdfUrl);
      pdf = clicked.buf;
      challenge ||= clicked.challenge;
    }
    if (!pdf && challenge) {
      const verdict = classifyRobotCheck({
        cfMitigated: nav?.evidence?.mainCfMitigated || r.cfMitigated || '',
        status: nav?.evidence?.mainStatus ?? r.status ?? null,
        challengeIframe: nav?.evidence?.challengeIframe ?? 0,
        challengeSource: challengeSource || 'none',
      });
      await cfAssistEvent(page, 'manual-evidence', { label: 'Science',
        challengeSource: challengeSource || 'sample-regex',
        finalUrl: redactUrl(nav?.finalUrl || page.url()),
        status: nav?.evidence?.mainStatus ?? r.status ?? '',
        cfMitigated: nav?.evidence?.mainCfMitigated || r.cfMitigated || '' });
      throw new RobotCheckError(verdict === 'block' ? `Science: ${ROBOT_BLOCK_REASON}` : 'Science: PDF端点的人机验证未放行');
    }
    if (!pdf) throw new AccessRequiredError(`Science: 正文PDF端点返回非PDF(状态${r.status} ${r.size}B，需检查机构登录或订阅)${LOGIN_HINT}`);
    const out = path.join(outDir, `${sanitize(doi)}.pdf`);
    fs.writeFileSync(out, pdf);
    return out;
  } finally {
    await page?.close().catch(() => {});
  }
}

// ====== IEEE: Playwright route.fetch (timeout:0) 流式拦截 getPDF.jsp ======
async function downloadIEEEImpl(doi, outDir, onPhase) {
  const ctx = await launchVisibleBrowser();
  let page;
  let grab;
  try {
    page = await ctx.newPage();
    await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

    let pdf = null;

    // 拦截必须挂 context 级：部分老文章（如 mra.2018.2871350，2026-09-02 四次复现）点 stamp
    // 后开新标签页走 PDF，page.route 只管本页，永远等不到 getPDF.jsp
    grab = async route => {
      try {
        const r = await route.fetch({ timeout: 0 });
        if (r.headers()['content-type']?.includes('pdf')) {
          pdf = Buffer.from(await r.body());
          await route.fulfill({ status: 200, contentType: 'application/pdf', body: pdf });
          return;
        }
      } catch(e) {}
      await route.continue();
    };
    await ctx.route('**/getPDF.jsp*', grab);
    // 老文章的 stamp 页 iframe 可能直挂 ielx<N>/<issn>/<issue>/<arnumber>.pdf CDN 地址，一并拦
    await ctx.route('**/iel*/**', grab);

    onPhase?.('downloading', { note: '打开DOI页...' });
    // IEEE 页面后台请求不断，networkidle 永不满足；改用 domcontentloaded
    await page.goto(`https://doi.org/${doi}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    onPhase?.('downloading', { note: '查找官网 PDF 操作...' });
    // 新版 IEEE 页面可能只显示 JS 按钮；无授权时按钮的 title 明确写着无权访问，
    // 等 /stamp/ 链接 60 秒只会得到误导性的选择器超时。
    await page.waitForSelector('a[href*="/stamp/"], a[data-analytics_identifier="document-lh-action-downloadpdf"]', {
      state: 'attached', timeout: 30000,
    }).catch(() => { throw new AccessRequiredError('IEEE: 官网文章页没有 PDF 操作(需检查官网验证或机构登录)'); });
    const pdfAction = page.locator('a[data-analytics_identifier="document-lh-action-downloadpdf"]').first();
    const accessTitle = await pdfAction.getAttribute('title').catch(() => '') || '';
    if (/do not have access|no access|无权访问|没有权限/i.test(accessTitle))
      throw new AccessRequiredError(`IEEE: 官网提示“${accessTitle}”(需机构登录或订阅)`);
    const stamp = page.locator('a[href*="/stamp/"]').first();
    if (await stamp.count()) {
      await stamp.evaluate(el => { el.target = '_self'; });
      await stamp.click();
    } else {
      if (!await pdfAction.count()) throw new AccessRequiredError('IEEE: 官网没有可用的正文 PDF 按钮');
      await pdfAction.click({ noWaitAfter: true, timeout: 10000 });
    }

    onPhase?.('downloading', { note: '拦截PDF中(IEEE较慢)...' });
    for (let i = 0; i < 120 && !pdf; i++) await page.waitForTimeout(1000);

    // 拦截超时的最常见原因是未机构登录（stamp 点击后 getPDF.jsp 302 到登录页，2026-09-05 EMG 实测）：
    // 报机构认证指引而不是笼统超时，让用户知道该做什么
    if (!pdf || pdf[0] !== 0x25) {
      throw new AccessRequiredError(pdf
        ? `内容非PDF(${pdf.length}B)`
        : '拦截PDF超时:未检测到机构登录,请在下载器 Edge 中完成机构认证后重跑');
    }
    const out = path.join(outDir, `${sanitize(doi)}.pdf`);
    fs.writeFileSync(out, pdf);
    return out;
  } finally {
    if (grab) {
      await ctx.unroute('**/getPDF.jsp*', grab).catch(() => {});
      await ctx.unroute('**/iel*/**', grab).catch(() => {});
    }
    await page?.close().catch(() => {});
  }
}

// context 级 PDF 拦截覆盖同浏览器的全部标签页，同一时间只运行一篇 IEEE。
let ieeeChain = Promise.resolve();
function downloadIEEE(doi, outDir, onPhase) {
  const task = ieeeChain.then(() => downloadIEEEImpl(doi, outDir, onPhase));
  ieeeChain = task.catch(() => {});
  return task;
}

// ====== SAGE：华科镜像两段式（文章页 SSR 提取存储层直链 → 纯 fetch 取 PDF）======
// 旧官网路线直连 journals.sagepub.com，本网络对该域是 IP 级黑洞（TCP 全丢包，连接建不起来），不可恢复。
// 替代通道 sage.cnpereading.com（Sage 中国镜像），2026-09-28 本机实测：
//   ① 华科出口 IP 自动机构认证、零质询（无 cookie/浏览器/验证码，裸 fetch 即可）；
//   ② /doi/<DOI> 返回 200 的完整 SSR HTML（约 1.1MB，Next.js 站），内嵌存储层 PDF 直链；
//   ③ 直链路径规律 storage/sage/journal/article/<刊码>/<年>/<卷期段>/unzip/<DOI斜杠转下划线>.pdf，
//      刊码/年/卷期段无法从 DOI 推出，必须抓文章页提取；
//   ④ 直链纯 fetch 直取 PDF（订阅文 5.8MB 0.6s、OA 文 344KB 0.4s）；镜像的 /doi/pdf/<DOI>
//      返回 HTML 查看页而非 PDF，官网 fallbackPdfUrl 形态在此不适用；
//   ⑤ 无效/无权限 DOI 返回 200+HTML（Next.js 404 页），页面提取不到本篇 unzip 路径——
//      「提取不到」即无权限/不存在的判定依据，报 AccessRequiredError（确定性结果，不重试）。
export async function downloadSAGEViaMirror(doi, outDir, onPhase) {
  onPhase?.('downloading', { note: 'SAGE镜像: 打开文章页...' });
  const resp = await fetch(`https://sage.cnpereading.com/doi/${doi}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`SAGE镜像: 文章页HTTP ${resp.status}`);
  const html = await resp.text();

  // 直链前半段固定、末段是本篇 DOI（斜杠已转下划线）；DOI 里的 . 是正则元字符须转义
  const doiEsc = doi.replace(/\//g, '_');
  const doiEscRe = doiEsc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(/storage\/sage\/journal\/article\/[^"'\\\s]+\/unzip\//.source + doiEscRe + '\\.pdf', 'g');
  const found = [...new Set(html.match(re) || [])][0];
  if (!found) {
    throw new AccessRequiredError('SAGE镜像: 文章页无本篇PDF地址(可能华科未订阅或镜像未收录，可打开人工地址确认)');
  }

  onPhase?.('downloading', { note: `SAGE镜像: 取存储层PDF /${found}` });
  const pdfResp = await fetch(`https://sage.cnpereading.com/${found}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(90000),
  });
  if (!pdfResp.ok) throw new Error(`SAGE镜像: PDF端点HTTP ${pdfResp.status}`);
  const buf = Buffer.from(await pdfResp.arrayBuffer());
  if (!isPdfBuf(buf)) {
    // 与 downloadPdfTwoPass 同款清理：不留 HTML 假 pdf 误导后续「已存在」判断
    fs.rmSync(path.join(outDir, `${sanitize(doi)}.pdf`), { force: true });
    throw new AccessRequiredError(`SAGE镜像: PDF端点未返回PDF(收到${buf.length}字节非%PDF内容)`);
  }
  const out = path.join(outDir, `${sanitize(doi)}.pdf`);
  fs.writeFileSync(out, buf);
  return out;
}

// ====== SAGE：镜像优先，官网骨架兜底（旧官网直连在本网络是 IP 级黑洞，仅换网场景可达） ======
export async function downloadSAGE(doi, outDir, onPhase) {
  try {
    return await downloadSAGEViaMirror(doi, outDir, onPhase);
  } catch (e) {
    if (e instanceof AccessRequiredError) throw e; // 镜像明确无权限=华科订阅外，官网同 IP 同样无权限，不浪费时间
    // 网络类错误（镜像不可达等）→ 旧官网骨架兜底一次（换网场景官网可能可达）
    onPhase?.('downloading', { note: `SAGE镜像未成功(${(e.message || '').slice(0, 60)})，官网路径兜底...` });
    return downloadPdfViaCfMeta('SAGE', doi, outDir, onPhase, {
      landingUrl: `https://journals.sagepub.com/doi/${doi}`,
      fallbackPdfUrl: `https://journals.sagepub.com/doi/pdf/${doi}`,
    });
  }
}

// 页内 fetch 硬超时（修复方案步骤1a）：站方对可疑会话可能扣住响应（连接通但不回包），
// 无超时会永久挂起拖死整篇（0926 夜间故障形态）。默认 45s，ZHU_PDF_FETCH_TIMEOUT_MS 可调。
const PDF_FETCH_TIMEOUT_MS = (() => {
  const v = Number(process.env.ZHU_PDF_FETCH_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 45000;
})();

/** 在页面上下文里带 cookie 同源取文件（分块转 base64 回传主进程），Wiley/Elsevier 共用。
 *  超时走既有 catch（调用方映射为 sample=错误消息），分类链不中断。 */
export async function fetchPdfInPage(page, url) {
  return page.evaluate(async ({ u, timeoutMs }) => {
    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, timeoutMs);
    try {
      const resp = await fetch(u, { credentials: 'include', signal: abort.signal });
      const buf = new Uint8Array(await resp.arrayBuffer());
      let sig = '';
      for (let i = 0; i < Math.min(4, buf.length); i++) sig += String.fromCharCode(buf[i]);
      let bin = '';
      if (sig === '%PDF') for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
      return { ok: resp.ok, status: resp.status, url: resp.url, ct: resp.headers.get('content-type') || '', sig, size: buf.length,
        cfMitigated: resp.headers.get('cf-mitigated') || '', server: resp.headers.get('server') || '',
        sample: sig === '%PDF' ? '' : new TextDecoder().decode(buf.subarray(0, 2048)),
        b64: sig === '%PDF' ? btoa(bin) : '' };
    } catch (e) {
      if (timedOut) throw new Error(`页面内fetch超时(${Math.round(timeoutMs / 1000)}s无响应)`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }, { u: url, timeoutMs: PDF_FETCH_TIMEOUT_MS }).catch(e => { throw new Error(`页面内取PDF失败: ${e.message}`); });
}

/** 让真实浏览器打开 PDF；响应或下载事件只接受 PDF 文件头。验证页由用户在窗口内处理。
 *  返回值带 evidence（修复方案步骤2）：finalUrl、title、主响应 status、cf-mitigated/server 头、
 *  challengeIframe 计数与 challengeSource（判据来源：nav-title | challenge-iframe | scripted |
 *  cf-mitigated | none），供失败复盘直接读出「为什么判成质询」，不再靠时长反推。 */
// Promise.race 里给 waitForTimeout 兜底：页面/浏览器被关闭时 waitForTimeout 会 reject，
// 不吞掉就把「浏览器崩溃」伪装成任意错误文案冒泡（2026-09-27 Science Edge 崩溃实证）
const pageWaitSafe = (page, ms) => page.waitForTimeout(ms).catch(() => null);

export async function fetchPdfByNavigation(page, url, onPhase, referer, label = 'PDF') {
  let pdfFound = false; // done 谓词：字节到手即视为放行（重定向成下载时标题/iframe 判据可能永不翻转）
  let resolvePdf;
  const captured = new Promise(resolve => { resolvePdf = body => { pdfFound = true; resolve(body); }; });
  // 主文档（导航）响应快照：重定向链上取最后一跳
  let mainStatus = null;
  let mainCfMitigated = '';
  let mainServer = '';
  const onResponse = async response => {
    try {
      if (response.request()?.isNavigationRequest?.()) {
        mainStatus = response.status();
        mainCfMitigated = response.headers()['cf-mitigated'] || '';
        mainServer = response.headers()['server'] || '';
      }
    } catch { /* 请求已失效时不影响主流程 */ }
    if (response.status() !== 200 || !/application\/pdf/i.test(response.headers()['content-type'] || '')) return;
    const body = await response.body().catch(() => null);
    if (body && isPdfBuf(body)) resolvePdf(body);
  };
  const onDownload = async download => {
    const file = await download.path().catch(() => null);
    if (!file) return;
    try {
      const body = fs.readFileSync(file);
      if (isPdfBuf(body)) resolvePdf(body);
    } catch { /* 下载临时文件不可读时继续观察响应 */ }
  };
  page.on('response', onResponse);
  page.on('download', onDownload);
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 45000, ...(referer ? { referer } : {}) }).catch(() => {});
    let buf = await Promise.race([captured, pageWaitSafe(page, 12000)]);
    // PDF 查看器可能接管导航，Playwright 的 response.body()/download 事件均不可取。
    // 落点页已在签名资产域内，同源 fetch 可用浏览器会话再取一次原始 PDF。
    if (!buf && /\.pdf$/i.test(new URL(page.url()).pathname)) {
      const landing = await fetchPdfInPage(page, page.url()).catch(() => null);
      if (landing?.ok && landing.sig === '%PDF') buf = Buffer.from(landing.b64, 'base64');
    }
    // 被动观察窗（12s）后判据命中 → 统一质询流程（修复方案步骤3）：双信号判据（标题正则 或
    // challenges.cloudflare.com iframe）、事件链、有界点击/视觉链，放行后重开同一 PDF URL
    // 重新竞速捕获；最长 120s。判据未命中 → 维持现状快速返回（Radware 等脚本验证页由
    // 下方 scripted 分支处理，标题/iframe 都不命中）。
    let challengeFlowFailed = false;
    const recapture = async () => {
      await page.goto(url, { waitUntil: 'commit', timeout: 45000, ...(referer ? { referer } : {}) }).catch(() => {});
      buf = await Promise.race([captured, pageWaitSafe(page, 12000)]);
      if (!buf && /\.pdf$/i.test(new URL(page.url()).pathname)) {
        const landing = await fetchPdfInPage(page, page.url()).catch(() => null);
        if (landing?.ok && landing.sig === '%PDF') buf = Buffer.from(landing.b64, 'base64');
      }
    };
    if (!buf && await looksChallenged(page, true)) {
      onPhase?.('downloading', { note: 'PDF 官网验证页已打开，等待自动/视觉辅助过验证（最长 2 分钟）...' });
      const cleared = await clearChallenge(page, label, onPhase, {
        maxWaitMs: 120000, dualSignal: true, onCleared: recapture, done: () => pdfFound });
      if (!cleared) challengeFlowFailed = true;
    }
    // 质询等待期间字节可能已经由浏览器自动重定向到手（captured 仍在监听），补一次短竞速
    if (!buf) buf = await Promise.race([captured, pageWaitSafe(page, 1000)]);    // Radware 等脚本验证页可能沿用文章标题，不符合上面的标题规则。
    // 被动等官网脚本完成；仍未放行则明确交人工验证。
    let scriptedChallenge = !buf && await page.evaluate(() =>
      /__uzdbm_|SSJSConnectorObj|validate\.perfdrive\.com/i.test(document.documentElement?.innerHTML || '')
    ).catch(() => false);
    if (scriptedChallenge) {
      onPhase?.('downloading', { note: '官网PDF页面正在验证浏览器，等待自动放行（最长45秒）...' });
      for (let i = 0; i < 45 && !buf; i++) {
        buf = await Promise.race([captured, pageWaitSafe(page, 1000)]);
        if (buf) break;
        const still = await page.evaluate(() =>
          /__uzdbm_|SSJSConnectorObj|validate\.perfdrive\.com/i.test(document.documentElement?.innerHTML || '')
        ).catch(() => false);
        if (!still) {
          await page.goto(url, { waitUntil: 'commit', timeout: 45000, ...(referer ? { referer } : {}) }).catch(() => {});
          buf = await Promise.race([captured, pageWaitSafe(page, 12000)]);
          break;
        }
      }
      scriptedChallenge = !buf;
    }
    // 字节未到手且窗口已崩（页面被关/浏览器退出）：按 BrowserClosedError 明确定性后上抛，
    // 不带残缺证据返回——否则上游会把崩溃误读成「无权限」转人工（2026-09-27 Science 实证）
    if (!buf && (page.isClosed() || !page.context()?.browser()?.isConnected()))
      throw new BrowserClosedError(`${label}: 浏览器窗口在导航PDF时崩溃或被关闭(多因站点页面异常，可重跑)`);
    const title = (await titleBounded(page)) ?? '';
    const challengeIframe = await page.locator('iframe[src*="challenges.cloudflare.com"]').count().catch(() => 0);
    const challengeSource = CF_CHALLENGE_TITLE.test(title) ? 'nav-title'
      : challengeIframe > 0 ? 'challenge-iframe'
      : scriptedChallenge ? 'scripted'
      : mainCfMitigated ? 'cf-mitigated' : 'none';
    return { buf, finalUrl: page.url(), title, challenge: scriptedChallenge || challengeFlowFailed,
      evidence: { finalUrl: page.url(), title, mainStatus, mainCfMitigated, mainServer,
        challengeIframe, challengeSource } };
  } finally {
    page.off('response', onResponse);
    page.off('download', onDownload);
  }
}

/** 官网按钮有时在点击时才生成有效会话或签名；监听同一浏览器内的新标签页与下载事件。 */
export async function fetchPdfByClick(page, url) {
  const found = await page.evaluate(target => {
    const link = [...document.querySelectorAll('a[href]')].find(a => a.href === target);
    if (!link) return false;
    link.setAttribute('data-zhu-pdf-click', '1');
    return true;
  }, url).catch(() => false);
  if (!found) return { buf: null, challenge: false };
  const ctx = page.context();
  const clickPages = new Set([page]);
  let resolvePdf;
  const captured = new Promise(resolve => { resolvePdf = resolve; });
  const onResponse = async response => {
    if (response.status() !== 200) return;
    let sourcePage;
    try { sourcePage = response.frame().page(); } catch { return; }
    if (!clickPages.has(sourcePage)) return;
    const ct = response.headers()['content-type'] || '';
    if (!/pdf|octet-stream/i.test(ct) && !/\.pdf(?:\?|$)|article-pdf/i.test(response.url())) return;
    const body = await response.body().catch(() => null);
    if (body && isPdfBuf(body)) resolvePdf(body);
  };
  const onDownload = async download => {
    const file = await download.path().catch(() => null);
    if (!file) return;
    try {
      const body = fs.readFileSync(file);
      if (isPdfBuf(body)) resolvePdf(body);
    } catch { /* 临时下载文件不可读 */ }
  };
  const onPage = popup => { clickPages.add(popup); popup.on('download', onDownload); };
  ctx.on('response', onResponse);
  page.on('popup', onPage);
  page.on('download', onDownload);
  try {
    await page.locator('[data-zhu-pdf-click="1"]').first().click({ noWaitAfter: true, timeout: 10000 });
    const buf = await Promise.race([captured, page.waitForTimeout(12000).then(() => null)]);
    const popup = [...clickPages].find(p => p !== page);
    const challenge = !buf && (popup ? await popup.evaluate(() =>
      /__uzdbm_|SSJSConnectorObj|validate\.perfdrive\.com|cf-chl/i.test(document.documentElement?.innerHTML || '')
    ).catch(() => false) : false);
    if (popup) await popup.close().catch(() => {});
    return { buf, challenge };
  } catch { return { buf: null, challenge: false }; }
  finally {
    ctx.off('response', onResponse);
    page.off('popup', onPage);
    page.off('download', onDownload);
    await page.evaluate(() => document.querySelector('[data-zhu-pdf-click="1"]')?.removeAttribute('data-zhu-pdf-click')).catch(() => {});
  }
}

// ====== Wiley: Playwright 过 Cloudflare + 页面内带 cookie fetch pdfdirect ======
// 裸 HTTP 请求（含 curl/fetch）一律被 Cloudflare "Just a moment" 质询拦截，
// 必须真实浏览器被动通过后再在页面上下文里取 PDF。pdfdirect 对 OA 文章直接返回
// application/pdf；订阅文无权限时返回 HTML，据此区分「失败」与「无权限」。
// 质询页标题在中文环境浏览器下是「请稍候…」，只匹配英文会误判已放行。
const CF_CHALLENGE_TITLE = /just a moment|请稍候|请稍后|checking your browser|attention required/i;

// ====== 共享等待原语（骨架停滞心跳修复）======
// 根因：慢页面（质询 JS 饱和渲染主线程/重定向链挂起）上单次取标题是 CDP 往返，
// 可阻塞数十秒——名义 45s 的轮询循环被拉长到分钟级；且长等待段零 onPhase 更新，
// 进度文件 mtime 陈旧触发 progressStale 误报，操作者无法区分「慢放行」与「挂死」。
// 原则：可能阻塞的单调用 race 一个硬超时；长等待段自带 15s 心跳（远小于 progressStale 120s 阈值）。

/** 休眠。计时器 unref：被 Promise.race 弃用后不拖住进程退出。 */
export const sleep = ms => new Promise(resolve => {
  const t = setTimeout(resolve, ms);
  t.unref?.();
});

/** 有界取页面标题：超时/出错返回 null（语义="未知/慢"），由调用方决定保守重试还是跳过判定。 */
export async function titleBounded(page, ms = 5000) {
  let timer;
  const bounded = new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); });
  timer.unref?.();
  try {
    return await Promise.race([page.title().catch(() => null), bounded]);
  } finally { clearTimeout(timer); }
}

/** 段级进度心跳：每 intervalMs 发一条 `note ${elapsed}s`，让进度文件 mtime 持续刷新。
 *  返回 stop()，调用方务必在 finally 里 stop；interval unref 防计时器拖住进程退出。 */
export function startPhaseTicker(onPhase, note, intervalMs = 15000) {
  const start = Date.now();
  const timer = setInterval(() => {
    onPhase?.('downloading', { note: `${note} ${Math.round((Date.now() - start) / 1000)}s` });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// 骨架质询等待预算：默认 6min（T&F 托管质询慢放行实测 5-6min——旧实现名义 45s 的轮询正是
// 靠慢 title() 意外拉长才等得到，这里把预算显式化，慢调用不再额外吃掉预算）。
// 与条目看门狗（默认 10min）自洽：6min 质询 + 其余各段 ≤3min。
export const CF_CHALLENGE_WAIT_MS = (() => {
  const v = Number(process.env.ZHU_CF_WAIT_MS);
  return Number.isFinite(v) && v > 0 ? v : 360000;
})();

/** 骨架质询等待（标题判据）：首探测无质询立即放行；等待期探测一律 titleBounded——null（慢/未知）
 *  保守视为「仍在质询」继续等，防慢调用导致提前误判放行。心跳：进等待发一条说明，此后每 beatMs
 *  发 `${label}等待官网验证放行 ${elapsed}s/${Ns}s`；放行补「已放行(耗时Xs)」。
 *  超时 return false 不抛错——抛 RobotCheckError 的语义留给调用方。
 *  有界重探（视觉链窗口重探 2026-09-27 步骤2，可选）：reprobe={ tickMs≈12000, clickState } 时，
 *  窗口内每 tickMs 且本上下文从未真实点击过时，质询框就绪（challengeBoxReady 单次快探）则再调一次
 *  tryClickRobotCheckbox——Turnstile 框常在质询检出数秒后才挂载到可点尺寸，检出瞬间的唯一自动点击
 *  机会大概率扑空；重探不延长窗口（占用窗口内时间），一次性点击额度由调用方持有的 clickState
 *  维护（跨等待窗口与人工窗口共享，任一真实点击发生过即封死）。 */
export async function waitChallengeClear(page, onPhase, label, maxWaitMs = CF_CHALLENGE_WAIT_MS, beatMs = 15000, reprobe = null) {
  const totalS = Math.round(maxWaitMs / 1000);
  const stillChallenged = async () => {
    const t = await titleBounded(page);
    return t === null || CF_CHALLENGE_TITLE.test(t);
  };
  const start = Date.now();
  const deadline = start + maxWaitMs;
  let noted = false;
  let lastBeat = 0;
  let lastReprobe = start;
  while (Date.now() < deadline) {
    if (!await stillChallenged()) {
      if (noted) onPhase?.('downloading', { note: `${label}质询已放行(耗时${Math.round((Date.now() - start) / 1000)}s)` });
      return true;
    }
    // 有界重探：框就绪且从未点击过 → 再给一次自动点击机会（内部串 DOM→视觉链→兜底，至多一次真实点击）
    if (reprobe?.clickState && !reprobe.clickState.clicked
        && Date.now() - lastReprobe >= (reprobe.tickMs ?? 12000)) {
      lastReprobe = Date.now();
      if ((await challengeBoxReady(page, { attempts: 1 })).ready
          && await tryClickRobotCheckbox(page, onPhase)) {
        reprobe.clickState.clicked = true; // 真实点击发生过，一次性额度封死
        onPhase?.('downloading', { note: `${label}: 重探点击验证勾选框，等待放行...` });
        await cfAssistEvent(page, 'challenge-clicked', { label, reprobe: true });
      }
      continue;
    }
    if (!noted) {
      noted = true;
      lastBeat = Date.now();
      onPhase?.('downloading', { note: `${label}官网验证放行中，托管质询可能需数分钟(至多${totalS}s)...` });
    } else if (Date.now() - lastBeat >= beatMs) {
      lastBeat = Date.now();
      onPhase?.('downloading', { note: `${label}等待官网验证放行 ${Math.round((Date.now() - start) / 1000)}s/${totalS}s` });
    }
    // 单轮等待取 2000 与 beatMs 的较小者：生产节奏仍 2s/轮，beatMs 调小时心跳不被轮询周期吞掉
    await page.waitForTimeout(Math.min(2000, beatMs));
  }
  return false;
}

/** URL 过渡态等待（__cf_chl_tk 剥离/linkinghub 跳转）：page.url() 是同步属性不会阻塞，
 *  deadline 化 + 同款心跳；超时 return false（是否致命由调用方决定——剥离轮询超时维持现状不致命）。 */
export async function waitUrlPatternClear(page, re, onPhase, note, maxWaitMs = 20000) {
  const start = Date.now();
  const deadline = start + maxWaitMs;
  let lastBeat = 0;
  while (Date.now() < deadline) {
    if (!re.test(page.url())) return true;
    if (note) {
      if (lastBeat === 0) {
        lastBeat = Date.now();
        onPhase?.('downloading', { note });
      } else if (Date.now() - lastBeat >= 15000) {
        lastBeat = Date.now();
        onPhase?.('downloading', { note: `${note} ${Math.round((Date.now() - start) / 1000)}s/${Math.round(maxWaitMs / 1000)}s` });
      }
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

// ====== 三态分类与文案（修复方案步骤4）======
// 封锁与验证同为确定性「需人工」，但 reason 可区分，download.log / failed.txt 直接可读：
// - block  ：cf-mitigated: block 头，或 403+无质询框+判据未命中 → 换网络/稍后再试
// - verify ：cf-mitigated: challenge 头，或可交互质询（标题/iframe/脚本页）未放行
// - login  ：质询已放行但终态仍非 PDF → 无权限类文案追加机构登录指引（AccessRequiredError）
export const ROBOT_BLOCK_REASON = '官网已封锁本机IP(403封锁)，换网络或稍后再试';
export const LOGIN_HINT = '；可能需机构登录，可 --open-manual 在下载器 Edge 登录后重跑';

/** 判定 PDF 端点失败的形态：'block'（封锁）| 'verify'（人机验证未放行）。头信号优先。 */
export function classifyRobotCheck({ cfMitigated = '', status = null, challengeIframe = 0, challengeSource = 'none' } = {}) {
  const m = String(cfMitigated || '').toLowerCase();
  if (m === 'block') return 'block';
  if (m === 'challenge') return 'verify';
  const challengey = ['nav-title', 'challenge-iframe', 'scripted'].includes(challengeSource);
  if (Number(status) === 403 && !challengey && Number(challengeIframe || 0) === 0) return 'block';
  return 'verify';
}

/** 质询判据。dualSignal=true 时双信号（修复方案步骤3）：标题正则之外，增加
 *  「存在 challenges.cloudflare.com iframe」判据，补「标题沿用文章名/为空」盲区（:527 旧注释）。
 *  文章页调用点维持单信号（部分正常页会内嵌不可见 Turnstile 控件，双信号会误伤）。 */
async function looksChallenged(page, dualSignal = false) {
  const title = await titleBounded(page);
  if (title === null) return true; // 标题慢/未知 → 保守视为仍在质询（对齐 waitChallengeClear 判据），继续等而不提前判放行
  if (CF_CHALLENGE_TITLE.test(title)) return true;
  if (!dualSignal) return false;
  return (await page.locator('iframe[src*="challenges.cloudflare.com"]').count().catch(() => 0)) > 0;
}

/**
 * 质询处理统一入口（修复方案步骤3，从 waitForCfClearance 抽出）：
 * challenge-seen 事件 → tryClickRobotCheckbox（含 requestCfVisionClick 视觉链）→ 轮询放行 →
 * challenge-cleared 事件；onCleared 供放行后的重取动作。
 * @param {import('playwright').Page} page
 * @param {string} label 事件与提示里的站名
 * @param {Function} [onPhase] 进度回调
 * @param {{maxWaitMs?: number, onCleared?: Function, dualSignal?: boolean, done?: Function}} [opts]
 *   done：放行等价谓词（如 PDF 字节已到手）——重定向成下载时标题/iframe 判据可能永不翻转
 * @returns {Promise<boolean>} 是否放行（含「未见质询」的平凡放行）；false=观察期内未放行
 */
async function clearChallenge(page, label, onPhase, { maxWaitMs = 45000, onCleared = null, dualSignal = false, done = null } = {}) {
  if (!await looksChallenged(page, dualSignal)) return true;
  onPhase?.('downloading', { note: `${label}: 等待浏览器验证...` });
  await cfAssistEvent(page, 'challenge-seen', { label });
  if (await tryClickRobotCheckbox(page, onPhase)) {
    onPhase?.('downloading', { note: '已点击验证勾选框，等待放行...' });
    await cfAssistEvent(page, 'challenge-clicked', { label });
  }
  const deadline = Date.now() + maxWaitMs;
  const waitStart = Date.now();
  let lastBeat = waitStart;
  while (Date.now() < deadline) {
    if (done && await done()) {
      await cfAssistEvent(page, 'challenge-cleared', { label });
      return true;
    }
    if (!await looksChallenged(page, dualSignal)) {
      await cfAssistEvent(page, 'challenge-cleared', { label });
      if (onCleared) await onCleared();
      return true;
    }
    // 心跳：fetchPdfByNavigation 等共用此入口，观察窗最长 120s，静默会触发 progressStale 误报
    if (Date.now() - lastBeat >= 15000) {
      lastBeat = Date.now();
      onPhase?.('downloading', { note: `${label}: 等待浏览器验证... ${Math.round((Date.now() - waitStart) / 1000)}s` });
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

/** 文章页质询等待：行为参数与历史版本一致（45s、超时抛 RobotCheckError）。 */
async function waitForCfClearance(page, label, onPhase) {
  const cleared = await clearChallenge(page, label, onPhase, { maxWaitMs: 45000 });
  if (!cleared) {
    // 失败证据落盘（修复方案步骤2）：为什么判成质询、终点在哪，直接进 events.jsonl
    await cfAssistEvent(page, 'manual-evidence', { label, challengeSource: 'nav-title',
      finalUrl: redactUrl(page.url()), status: '' });
    throw new RobotCheckError(`${label}: Cloudflare质询未放行`);
  }
}

/**
 * 有界自动验证：对 Cloudflare Turnstile 或 hCaptcha 的「勾选框」自动点一次（一次机会，
 * 内部至多两击）。只点勾选框本体；图选谜题/滑块/验证码图片等人工验证**绝不自动操作**
 * （有界尝试对齐 nature-downloader 的 bounded-attempt 规则，失败即交人）。
 * 探测有界化：质询页渲染饱和时单次 count/isVisible 是 CDP 往返可阻塞分钟级（0927 实测
 * ACS 370s / SD 539s 都卡在这，且发生在 waitChallengeClear 计时之前，把质询预算架空），
 * 4s 竞速超时=放弃这次自动点击机会，交给外层带心跳的等待/人工/视觉链。
 * @param {Function} [onPhase] 进度回调：函数体全程 15s 心跳（探测慢=操作者看得见）
 * @returns {Promise<boolean>} 本次是否发生过真实点击（DOM 勾选框、视觉链框内点击、兜底坐标点击
 *   任一发生即为 true）。调用方以此维护「每次质询上下文至多一次自动点击」的一次性额度
 *   （视觉链窗口重探 2026-09-27 步骤2：重探给的是框就绪后的第一次点击机会，不是重复点击）。
 */
export async function tryClickRobotCheckbox(page, onPhase = null) {
  const stop = startPhaseTicker(onPhase, '探测验证勾选框(质询页可能较慢)...');
  try {
    const candidates = [
      // hCaptcha（Radware validate.perfdrive.com 等）：checkbox iframe 里是 #checkbox
      { frame: 'iframe[src*="hcaptcha.com"]', sels: ['#checkbox', '[role="checkbox"]'] },
      // Cloudflare Turnstile（Elsevier/Science 等）：.ctp-checkbox 是整块可点标签
      { frame: 'iframe[src*="challenges.cloudflare.com"]', sels: ['.ctp-checkbox', '[role="checkbox"]'] },
    ];
    for (const c of candidates) {
      const fc = page.frameLocator(c.frame);
      for (const sel of c.sels) {
        for (let n = 0; n < 2; n++) {
          try {
            const el = fc.locator(sel).first();
            // 超时(-1)视为不存在放弃该选择器；count 出错仍走外层 catch 重试一次（原语义）
            const cnt = await Promise.race([el.count(), sleep(4000).then(() => -1)]);
            if (cnt === 0 || cnt === -1) break; // 该选择器不存在，换下一个
            const visible = await Promise.race([el.isVisible().catch(() => false), sleep(4000).then(() => false)]);
            if (!visible) break; // 不可见，或探测太慢
            await el.click({ timeout: 3000, noWaitAfter: true });
            return true;
          } catch { /* 单击失败可再试一次 */ }
        }
      }
    }
    // shadow-root 内嵌验证框（视觉链窗口重探 2026-09-27 实战实证）：SD 的 Turnstile 控件挂在
    // shadow root 里，iframe 元素对 frameLocator 的元素选择器不可见；page.frames() 按 frame
    // 目标枚举可见。这里按帧 URL 找验证 frame 后直接在 frame 内点勾选框——仅补探测路径，
    // 「至多一次真实点击」额度语义不变。
    for (const c of candidates) {
      const urlRe = c.frame.includes('hcaptcha') ? /hcaptcha\.com/ : /challenges\.cloudflare\.com/;
      for (const f of page.frames()) {
        let u = '';
        try { u = f.url(); } catch { continue; }
        if (!urlRe.test(u)) continue;
        for (const sel of c.sels) {
          try {
            const el = f.locator(sel).first();
            const cnt = await Promise.race([el.count().catch(() => 0), sleep(4000).then(() => -1)]);
            if (cnt === 0 || cnt === -1) break;
            const visible = await Promise.race([el.isVisible().catch(() => false), sleep(4000).then(() => false)]);
            if (!visible) break;
            await el.click({ timeout: 3000, noWaitAfter: true });
            return true;
          } catch { /* 单击失败换下一个选择器 */ }
        }
      }
    }
    // DSH 图像辅助已启动时，由模型看当前 Turnstile 框后给出框内坐标；
    // 下载器只接受当前页面、当前框内的一次点击，不再盲点左缘。
    const vision = await requestCfVisionClick(page);
    if (vision.enabled) return vision.clicked;
    // 兜底：勾选框在控件左侧，iframe 可见时点其左缘垂直中段（无 DOM 可达时的坐标路径）。
    // boundingBox 同样有界化：超时(null)视为框不存在换下一候选，防饱和渲染器阻塞
    for (const c of candidates) {
      try {
        const box = await Promise.race([
          page.locator(c.frame).first().boundingBox().catch(() => null),
          sleep(4000).then(() => null),
        ]);
        if (box && box.width > 30 && box.height > 10) {
          await page.mouse.click(box.x + Math.min(24, box.width / 3), box.y + box.height / 2);
          return true;
        }
      } catch { /* 试下一个候选 */ }
    }
    return false;
  } finally { stop(); }
}

async function downloadWiley(doi, outDir, onPhase) {
  const ctx = await launchVisibleBrowser();
  let page;
  try {
    page = await ctx.newPage();
    await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

    onPhase?.('downloading', { note: '打开DOI页...' });
    await page.goto(`https://doi.org/${doi}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForCfClearance(page, 'Wiley', onPhase);

    // cookie 同意弹窗（中英文站点文案都试）；弹窗不关 fetch 仍可用，关掉以求稳
    for (const label of ['全部接受', 'Accept All']) {
      const btn = page.locator(`button:has-text("${label}"), a:has-text("${label}")`).first();
      if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(1500);
        break;
      }
    }

    // 期刊子域不同，先读取文章页实际给出的 ePDF/PDF 链接，最后才试 pdfdirect。
    // 不能只拼 pdfdirect：有些文章的正常下载按钮指向 /doi/epdf/。
    const origin = new URL(page.url()).origin;
    const linked = await page.evaluate(() => [
      document.querySelector('meta[name="citation_pdf_url"]')?.content,
      ...Array.from(document.querySelectorAll('a[href*="/doi/epdf/"], a[href*="/doi/pdf/"]')).map(a => a.href),
    ].filter(Boolean));
    const candidates = [...new Set([
      ...linked.map(href => new URL(href, page.url()).href),
      `${origin}/doi/pdfdirect/${doi}?download=true`,
    ])].filter(url => {
      const host = new URL(url).hostname;
      return host === 'wiley.com' || host.endsWith('.wiley.com');
    });
    let pdf = null;
    let lastResult = null;
    let challenge = false;
    let challengeSource = '';
    let nav = null;
    for (const pdfUrl of candidates) {
      onPhase?.('downloading', { note: `页面内取官网PDF: ${new URL(pdfUrl).pathname}` });
      const r = await fetchPdfInPage(page, pdfUrl).catch(e =>
        ({ ok: false, sig: '', status: '请求中断', size: 0, sample: e.message }));
      lastResult = r;
      if (r.ok && r.sig === '%PDF') { pdf = Buffer.from(r.b64, 'base64'); break; }
      if (/just a moment|checking your browser|cf-chl/i.test(r.sample || '')) {
        challenge = true;
        challengeSource = challengeSource || 'sample-regex';
      }
    }
    if (!pdf && candidates.length > 0) {
      onPhase?.('downloading', { note: '页面内未取得正文，尝试浏览器打开文章所给官网PDF链接...' });
      const navPage = await ctx.newPage();
      try { nav = await fetchPdfByNavigation(navPage, candidates[0], onPhase, page.url(), 'Wiley'); }
      finally { await navPage.close().catch(() => {}); }
      pdf = nav.buf;
      if (!challengeSource && (nav.evidence?.challengeSource || 'none') !== 'none') challengeSource = nav.evidence.challengeSource;
      challenge ||= nav.challenge || CF_CHALLENGE_TITLE.test(nav.title);
    }
    if (!pdf && !challenge) {
      for (const pdfUrl of candidates) {
        onPhase?.('downloading', { note: `点击官网PDF按钮: ${new URL(pdfUrl).pathname}` });
        const clicked = await fetchPdfByClick(page, pdfUrl);
        if (clicked.buf) { pdf = clicked.buf; break; }
        if (clicked.challenge) { challenge = true; break; }
      }
    }
    if (!pdf && challenge) {
      const verdict = classifyRobotCheck({
        cfMitigated: nav?.evidence?.mainCfMitigated || lastResult?.cfMitigated || '',
        status: nav?.evidence?.mainStatus ?? lastResult?.status ?? null,
        challengeIframe: nav?.evidence?.challengeIframe ?? 0,
        challengeSource: challengeSource || 'none',
      });
      await cfAssistEvent(page, 'manual-evidence', { label: 'Wiley',
        challengeSource: challengeSource || 'sample-regex',
        finalUrl: redactUrl(nav?.finalUrl || page.url()),
        status: nav?.evidence?.mainStatus ?? lastResult?.status ?? '',
        cfMitigated: nav?.evidence?.mainCfMitigated || lastResult?.cfMitigated || '' });
      throw new RobotCheckError(verdict === 'block' ? `Wiley: ${ROBOT_BLOCK_REASON}` : 'Wiley: PDF端点的人机验证未放行');
    }
    if (!pdf) throw new AccessRequiredError(`Wiley: 官网PDF链接未返回PDF(状态${lastResult?.status ?? '?'} ${lastResult?.size ?? 0}B，需检查机构登录或订阅)${LOGIN_HINT}`);

    const out = path.join(outDir, `${sanitize(doi)}.pdf`);
    fs.writeFileSync(out, pdf);
    return out;
  } finally {
    await page?.close().catch(() => {});
  }
}

// ====== CoB / Royal Society / Oxford / ACS / APS / Physiology / UChicago 七站共用骨架 ======
// 整域 Cloudflare 质询（生理学会的 /doi/pdf/ 端点还单独质询 context 级请求）+ PDF 地址两来源：
// citation_pdf_url meta（各刊路径风格不同，拼不出来）或 /doi/pdf/<DOI> 工具链接；meta 元素永不
// "可见"，必须按 attached 等。先用文章页内 fetch 取 PDF；跨域签名地址受 CORS 限制时
// 再试共享 cookie 的 context 请求，最后让真实浏览器直接导航 PDF 链接并监听响应/下载。
// 2026-09-25 JACS 实测：context 请求获 403 Cloudflare 壳页，页面内 fetch 获完整 PDF。
// 因此 context 的 403 不是订阅权限结论，必须依据浏览器请求的终态分类。
// 质询轮询窗口内没放行 → RobotCheckError，由调用方转「需人工」（确定性结果，不重试）。
// **context 不可覆盖 UA**：老版本 UA 串与真实 Edge 引擎不匹配本身就是机器人信号——
// 2026-09-01 实测 Oxford/ACS 带 Chrome/120 串质询 30s 不放行，去掉后数秒即过。
/** 关 cookie 同意弹窗（中英文站点文案都试）；没有弹窗时无副作用。APS 质询放行后可能先弹同意墙，挡住文章数据渲染。 */
async function dismissCookieConsent(page) {
  for (const label of ['全部接受', 'Accept All', '接受全部', 'Accept all cookies', '同意', 'Accept']) {
    const btn = page.locator(`button:has-text("${label}"), a:has-text("${label}")`).first();
    if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(1500);
      break;
    }
  }
}

export async function downloadPdfViaCfMeta(label, doi, outDir, onPhase, { viaPageFetch = false, navDoi, landingUrl, fallbackPdfUrl, onNotFound, linkWaitMs = 45000 } = {}) {
  const ctx = await launchVisibleBrowser();
  let page;
  try {
    page = await ctx.newPage();
    await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

    // 质询判负的统一出口：先留证据（为何判成质询、终点在哪，进 events.jsonl）再抛既有错误类型
    const failChallenge = async () => {
      await cfAssistEvent(page, 'manual-evidence', { label, challengeSource: 'nav-title', finalUrl: redactUrl(page.url()) });
      throw new RobotCheckError('Cloudflare质询未放行');
    };

    onPhase?.('downloading', { note: '打开DOI页(跳转链可能较慢)...' });
    const stopNav = startPhaseTicker(onPhase, '打开DOI页(跳转链可能较慢)...');
    try {
      await page.goto(landingUrl || `https://doi.org/${navDoi || doi}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      // 标题未知(null=慢/挂起)时不判质询，走原超时/抛错分支
      const t = await titleBounded(page);
      if (t !== null && CF_CHALLENGE_TITLE.test(t))
        throw new RobotCheckError(`${label}: 官网验证页未完成加载`);
      if (/Timeout/i.test(e?.name || '') || /Timeout/i.test(e?.message || ''))
        throw new AccessRequiredError(`${label}: 官网文章页加载超时(需在下载器 Edge 中检查网站或网络)`);
      throw e;
    } finally {
      stopNav();
    }
    // 质询出现先自动点一次 Turnstile/hCaptcha 勾选框（有界尝试；标题未知(null=慢)也点，无害）。
    // 放行预算显式化 CF_CHALLENGE_WAIT_MS（默认 6min）：T&F 托管质询慢放行实测 5-6min，
    // 旧实现名义 45s 的轮询正是靠慢 title() 意外拉长才等得到；等待全程带心跳，慢与挂死可区分。
    // 一次性点击额度（视觉链窗口重探 2026-09-27 步骤2）：clickState 传入等待窗口开启有界重探，
    // 检出瞬间的点击与窗口内重探共享「至多一次真实自动点击」额度。
    const clickState = { clicked: false };
    const landingTitle = await titleBounded(page);
    if (landingTitle === null || CF_CHALLENGE_TITLE.test(landingTitle)) {
      if (await tryClickRobotCheckbox(page, onPhase)) {
        clickState.clicked = true;
        onPhase?.('downloading', { note: '已自动点击验证勾选框，等待放行...' });
      }
    }
    if (!await waitChallengeClear(page, onPhase, label, CF_CHALLENGE_WAIT_MS, 15000, { tickMs: 12000, clickState })) await failChallenge();
    // 放行后还有一次自跳转剥掉 URL 上的 __cf_chl_tk；过渡态里发请求会被导航打断
    await waitUrlPatternClear(page, /__cf_chl_tk/i, onPhase, '等待验证后跳转稳定...', 20000);

    // 落地 404（如 APS link.aps.org 不认部分 2024+ 短码 DOI）：调用方给备选地址再导一次
    if (onNotFound) {
      const navTitle = await titleBounded(page);
      if (navTitle !== null && /not found/i.test(navTitle)) {
        const retry = await onNotFound(doi);
        if (!retry) throw new Error(`${label}: 落地页 Not Found(无备选地址)`);
        onPhase?.('downloading', { note: `落地404，换 ${retry} 重试` });
        const stopRetry = startPhaseTicker(onPhase, `落地404，换 ${retry} 重试`);
        try {
          await page.goto(retry, { waitUntil: 'domcontentloaded', timeout: 60000 });
        } finally { stopRetry(); }
        const retryTitle = await titleBounded(page);
        if (retryTitle === null || CF_CHALLENGE_TITLE.test(retryTitle)) {
          // 新导航 = 新质询上下文：一次性点击额度重新起算（与原「每质询 episode 各点一次」一致）
          const retryClickState = { clicked: false };
          if (await tryClickRobotCheckbox(page, onPhase)) {
            retryClickState.clicked = true;
            onPhase?.('downloading', { note: '已自动点击验证勾选框，等待放行...' });
          }
          if (!await waitChallengeClear(page, onPhase, label, CF_CHALLENGE_WAIT_MS, 15000, { tickMs: 12000, clickState: retryClickState })) await failChallenge();
        } else if (!await waitChallengeClear(page, onPhase, label)) await failChallenge();
        await waitUrlPatternClear(page, /__cf_chl_tk/i, onPhase, '等待验证后跳转稳定...', 20000);
      }
    }

    // 尽力而为段：locator 往返在慢页面也可能拖数十秒 → 20s 总超时放弃不报错（无弹窗时本就无副作用）+ 心跳
    const stopConsent = startPhaseTicker(onPhase, '关闭cookie同意弹窗...');
    try { await Promise.race([dismissCookieConsent(page), sleep(20000)]); }
    finally { stopConsent(); }

    // 等 meta 或 PDF 链接出现即文章页已就绪（physiology 没有 citation_pdf_url meta，
    // 只有文章工具里的 /doi/pdf/ 链接；meta 元素永不"可见"，必须按 attached 等）
    const pdfSelector = 'meta[name="citation_pdf_url"], a[href*="/doi/pdf/"], a[href*="/doi/epdf/"], a[href*="viewmedia.cfm"], a[href*="article-pdf"], .grant-access .redirect-uri';
    const stopReady = startPhaseTicker(onPhase, '等文章页就绪(PDF链接)...');
    try { await page.waitForSelector(pdfSelector, { state: 'attached', timeout: fallbackPdfUrl ? 10000 : linkWaitMs }); }
    catch { if (!fallbackPdfUrl) throw new AccessRequiredError(`${label}: 文章页无正文PDF链接(需检查机构登录或订阅)`); }
    finally { stopReady(); }
    // 官网可见的 PDF 按钮和 citation_pdf_url 不一定相同（Optica 的 viewmedia.cfm
    // 就有两个路径）；保留多个候选，而不是只试第一个 meta 后宣布失败。
    const stopHrefs = startPhaseTicker(onPhase, '读取文章页PDF地址...');
    let hrefs;
    try {
      hrefs = await page.evaluate(articleDoi => {
        const anchors = Array.from(document.querySelectorAll('a[href]'))
          .filter(a => {
            try { return new URL(a.href).hostname === location.hostname; }
            catch { return false; }
          })
          .filter(a => /\/doi\/(?:e?pdf)\/|article-pdf|viewmedia\.cfm/i.test(a.href)
            || /\b(?:get|download|view)?\s*pdf(?:\s*article)?\b/i.test(a.textContent || ''))
          .filter(a => !/supplement|supporting|suppl\.|suppmat/i.test((a.textContent || '') + a.href))
          .filter(a => {
            if (!/\/doi\/(?:e?pdf)\//i.test(a.href)) return true;
            try { return decodeURIComponent(a.href).toLowerCase().includes(articleDoi.toLowerCase()); }
            catch { return a.href.toLowerCase().includes(articleDoi.toLowerCase()); }
          })
          .map(a => a.href);
        return [
          ...anchors,
          document.querySelector('.grant-access .redirect-uri')?.textContent?.trim(),
          document.querySelector('meta[name="citation_pdf_url"]')?.content,
        ].filter(Boolean);
      }, doi);
    } finally { stopHrefs(); }
    if (fallbackPdfUrl) hrefs.push(fallbackPdfUrl);
    const pdfUrls = [...new Set(hrefs.map(href => {
      try { return new URL(href, page.url()).href; } catch { return ''; }
    }).filter(url => /^https?:\/\//i.test(url)))].filter(url => {
      if (label !== 'SAGE') return true;
      // 官网黑盈权益之计：SAGE 中国镜像（cnpereading.com）也是合法来源，存储层直链就在该域下
      const host = new URL(url).hostname;
      return host === 'sagepub.com' || host.endsWith('.sagepub.com')
        || host === 'cnpereading.com' || host.endsWith('.cnpereading.com');
    }).slice(0, 8);
    if (pdfUrls.length === 0) throw new AccessRequiredError(`${label}: 页面无官网正文PDF地址(需检查机构登录或订阅)`);

    let buf;
    // PDF 端点可独立检查浏览器指纹。ctx.request 虽共享 cookie，却由 Node 的 TLS 栈发出；
    // ACS 等站会给它 403 Cloudflare 壳页，而同一标签页内 fetch 能拿到真正的 PDF。
    // 跨域签名链接若无 CORS，页内 fetch 会失败，再回退到 context 请求。
    let pageResult;
    let contextStatus = '';
    let challengeSeen = false;
    let candIdx = 0;
    for (const pdfUrl of pdfUrls) {
      candIdx++;
      // i/N 让 8 候选 × 45s 超时的最坏情况对操作者可预期
      onPhase?.('downloading', { note: `页面内取官网PDF(候选${candIdx}/${pdfUrls.length}): ${new URL(pdfUrl).pathname}` });
      try { pageResult = await fetchPdfInPage(page, pdfUrl); }
      catch { pageResult = null; /* 跨域 CORS 或导航中断，继续试官网候选 */ }
      if (pageResult?.ok && pageResult.sig === '%PDF') { buf = Buffer.from(pageResult.b64, 'base64'); break; }
      challengeSeen ||= BOT_INTERSTITIAL.test(pageResult?.sample || '');
      if (!viaPageFetch) {
        // Node TLS 栈的请求可能被站方慢速流水扣住（0927 ACS 实测 8MB 流 ~6min 才走通）：
        // 不加硬超时——慢流水最终能成功，上限交给 10min 条目看门狗；ticker 让进度不陈旧
        const stopCtx = startPhaseTicker(onPhase, 'context级请求兜底(慢速流水)...');
        try {
          const r = await ctx.request.get(pdfUrl, { timeout: 30000 }).catch(() => null);
          if (r) {
            const candidate = Buffer.from(await r.body());
            if (r.status() === 200 && isPdfBuf(candidate)) { buf = candidate; break; }
            contextStatus = `${r.status()} ${Math.round(candidate.length / 1024)}KB`;
          }
        } finally { stopCtx(); }
      }
    }
    if (!buf) {
      const articleUrl = page.url();
      let nav;
      for (const pdfUrl of pdfUrls) {
        onPhase?.('downloading', { note: `浏览器打开官网PDF: ${new URL(pdfUrl).pathname}` });
        const navPage = await ctx.newPage();
        try { nav = await fetchPdfByNavigation(navPage, pdfUrl, onPhase, articleUrl, label); }
        finally { await navPage.close().catch(() => {}); }
        buf = nav.buf;
        if (buf) break;
        if (nav.challenge || CF_CHALLENGE_TITLE.test(nav.title)) break;
      }
      if (!buf && nav && !nav.challenge && !CF_CHALLENGE_TITLE.test(nav.title)) {
        for (const pdfUrl of pdfUrls) {
          onPhase?.('downloading', { note: `点击官网正文PDF按钮: ${new URL(pdfUrl).pathname}` });
          const clicked = await fetchPdfByClick(page, pdfUrl);
          if (clicked.buf) { buf = clicked.buf; break; }
          if (clicked.challenge) { challengeSeen = true; break; }
        }
      }
      if (!buf && nav) {
        onPhase?.('downloading', { note: `PDF导航终点: ${nav.finalUrl.split('?')[0].slice(0, 140)}; 标题: ${nav.title.slice(0, 60)}` });
        // 三态分类（修复方案步骤4）：头信号（cf-mitigated）优先，其次可交互质询信号；
        // 403+无质询框+判据未命中归「封锁」。context 请求被单独挡时不在此列。
        const evSource = challengeSeen ? 'sample-regex'
          : (nav.evidence?.challengeSource || 'none') !== 'none' ? nav.evidence.challengeSource : 'none';
        const verdict = classifyRobotCheck({
          cfMitigated: nav.evidence?.mainCfMitigated || pageResult?.cfMitigated || '',
          status: nav.evidence?.mainStatus ?? pageResult?.status ?? null,
          challengeIframe: nav.evidence?.challengeIframe ?? 0,
          challengeSource: evSource,
        });
        if (challengeSeen
            || nav.challenge || CF_CHALLENGE_TITLE.test(nav.title) || verdict === 'block') {
          await cfAssistEvent(page, 'manual-evidence', { label,
            challengeSource: evSource || 'none',
            finalUrl: redactUrl(nav.finalUrl),
            status: nav.evidence?.mainStatus ?? pageResult?.status ?? '',
            cfMitigated: nav.evidence?.mainCfMitigated || pageResult?.cfMitigated || '' });
          throw new RobotCheckError(verdict === 'block'
            ? `${label}: ${ROBOT_BLOCK_REASON}` : `${label}: PDF端点的人机验证未放行`);
        }
        if (/redirectedFrom=PDF/i.test(nav.finalUrl)) throw new AccessRequiredError(`${label}: PDF跳回文章页(需检查机构登录或订阅)${LOGIN_HINT}`);
        if (/page not found|404/i.test(nav.title)) throw new Error(`${label}: 官网PDF地址不可用(${nav.title.slice(0, 60)})`);
        throw new AccessRequiredError(`${label}: PDF端点未返回PDF(页面${pageResult?.status || '?'} ${pageResult?.size || 0}B; 请求${contextStatus || '未尝试'}，需检查机构登录或订阅)${LOGIN_HINT}`);
      }
    }

    const out = path.join(outDir, `${sanitize(doi)}.pdf`);
    fs.writeFileSync(out, buf);
    return out;
  } finally {
    await page?.close().catch(() => {}); // 只关标签页；持久浏览器留给后续文章/批次复用
  }
}

// ====== Company of Biologists (journals.biologists.com)：同骨架，页内 fetch 收字节 ======
// 旗下五刊(JEB/JCS/Development/DMM/BiO)2023 年起全刊开放获取(Subscribe to Open)，
// 失败多为质询未放行而非订阅权限。
async function downloadBiologists(doi, outDir, onPhase) {
  return downloadPdfViaCfMeta('CoB', doi, outDir, onPhase, { viaPageFetch: true });
}

// ====== Royal Society (royalsocietypublishing.org，DOI 前缀 10.1098)：共享骨架 ======
// 旗下 Phil. Trans. A/B、Proc. A/B、Interface、Biol. Lett.、RSOS、Open Biology 等；
// RSOS 全刊 OA 无需校园网，其余刊靠校园网 IP。
async function downloadRoyalSociety(doi, outDir, onPhase) {
  return downloadPdfViaCfMeta('RoyalSociety', doi, outDir, onPhase);
}

// ====== 牛津大学出版社 (academic.oup.com)：共享骨架 ======
// 旗下 500+ 刊（NAR、JNCI、MNRAS、GJI 等，DOI 前缀随刊不同，落地域统一 academic.oup.com）。
// 2026-09-01 实测：article-pdf 302 到跨域签名地址，页内 fetch 被 CORS 拦（Royal Society
// 同机制）；context 级请求直得 PDF；订阅文靠校园网 IP（MNRAS 2013 订阅文实测可下）。
async function downloadOxford(doi, outDir, onPhase) {
  return downloadPdfViaCfMeta('Oxford', doi, outDir, onPhase);
}

// ====== 美国化学会 (pubs.acs.org，含 JACS)：优先页面内 fetch ======
// JACS、ACS Omega、Nano Lett. 等全落在 pubs.acs.org；落地 URL 与 article-pdf 都带文章
// 内部编号（如 /jacsat/article/148/27/28075/...），只能读 meta 不能拼。ACS Omega 等全 OA
// 刊无需订阅；JACS 等订阅刊靠校园网 IP（2026-09-01 实测可下）。
async function downloadACS(doi, outDir, onPhase) {
  return downloadPdfViaCfMeta('ACS', doi, outDir, onPhase);
}

// ====== 美国物理学会 (journals.aps.org，DOI 前缀 10.1103，PRL/PRX/PR A-E 等)：同骨架，context 级请求收字节 ======
// doi.org 首跳 link.aps.org 即被 Cloudflare 质询，被动放行约 4s；落地 journals.aps.org/<刊>/abstract/...。
// meta 指回 link.aps.org/pdf/<DOI>（可预测形态），context 级请求直得 PDF（2026-09-01 实测）。
// **2024 起新文章的短码 DOI**（如 10.1103/7tsq-tyvf）link.aps.org 常直接 404 "Not Found"：
// 骨架 onNotFound 里按 Crossref 换经典形式孪生记录重导（文件名仍用用户原始 DOI）。订阅文靠
// 校园网 IP；无权限时 link.aps.org/pdf/ 回摘要页 HTML，按「无PDF权限」优雅失败。
const APS_CLASSIC_PREFIX = new Map([
  ['Physical Review Letters', 'PhysRevLett'],
  ['Physical Review X', 'PhysRevX'],
  ['Physical Review A', 'PhysRevA'],
  ['Physical Review B', 'PhysRevB'],
  ['Physical Review C', 'PhysRevC'],
  ['Physical Review D', 'PhysRevD'],
  ['Physical Review E', 'PhysRevE'],
  ['Physical Review Applied', 'PhysRevApplied'],
  ['Physical Review Accelerators and Beams', 'PhysRevAccelBeams'],
  ['Physical Review Fluids', 'PhysRevFluids'],
  ['Physical Review Materials', 'PhysRevMaterials'],
  ['Physical Review Research', 'PhysRevResearch'],
  ['Physical Review Physics Education Research', 'PhysRevPhysEducRes'],
  ['Physical Review Education', 'PhysRevEducation'],
]);

// journals.aps.org 站内路径的刊代码与 DOI 前缀的例外映射；其余按 pr+尾缀规则（physreva→pra）
const APS_SITE_CODE = new Map([
  ['physrevlett', 'prl'],
  ['physrevaccelbeams', 'prab'],
  ['physrevphyseducres', 'prper'],
]);

// 前缀小写 → 规范大小写：journals.aps.org 站内路径对 DOI 大小写敏感，全小写软 404（无 metas）
const APS_CANON_PREFIX = new Map([...new Set(APS_CLASSIC_PREFIX.values())].map(p => [p.toLowerCase(), p]));

/** 短码 DOI 的经典形式备选：记录带卷号/文章号时直接构造；极简记录（2024+ 短码常见）按标题+ISSN
 * 搜同刊经典形式孪生记录（同篇文章在 APS 有两条 Crossref 记录，短码与经典形式并存）。 */
async function apsClassicTwin(doi) {
  const req = { headers: { 'User-Agent': 'ZhuDownLoader/1.0 (mailto:probe@example.org)' }, signal: AbortSignal.timeout(20000) };
  try {
    const m = (await (await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, req)).json()).message;
    const prefix = APS_CLASSIC_PREFIX.get((m['container-title'] || [])[0] || '');
    const loc = m['article-number'] || m.firstpage;
    if (prefix && m.volume && loc) return `10.1103/${prefix}.${m.volume}.${loc}`;
    const title = (m.title || [])[0] || '';
    if (!title) return null;
    const issn = (m.ISSN || [])[0] || '';
    const q = `https://api.crossref.org/works?query.title=${encodeURIComponent(title)}${issn ? `&filter=issn:${issn},type:journal-article` : ''}&rows=5&select=DOI,title`;
    const items = (await (await fetch(q, req)).json()).message.items || [];
    const norm = s => String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, '').toLowerCase();
    const hit = items.find(it => /^10\.1103\/physrev/i.test(it.DOI) && norm((it.title || [''])[0]) === norm(title));
    if (!hit) return null;
    // 搜到的孪生常是全小写（Crossref 注册形态）；按规范大小写重建，journals 站内路径才认
    const body = hit.DOI.split('/')[1];
    const canon = APS_CANON_PREFIX.get(body.split('.')[0].toLowerCase());
    return canon ? `10.1103/${canon}.${body.split('.').slice(1).join('.')}` : hit.DOI;
  } catch { /* Crossref 不可达时无法换算，调用方按原始失败处理 */ return null; }
}

async function downloadAPS(doi, outDir, onPhase) {
  return downloadPdfViaCfMeta('APS', doi, outDir, onPhase, {
    onNotFound: async d => {
      const twin = await apsClassicTwin(d);
      if (!twin) return null;
      const pl = twin.split('/')[1].split('.')[0].toLowerCase();
      // link.aps.org 只认自家主记录（短码/孪生别名都可能 404），重导直走 journals.aps.org 摘要路径；
      // 刊代码 = pr + 前缀尾缀，个别刊缩写不同（lett→l、accelbeams→ab、physeducres→per）
      const code = APS_SITE_CODE.get(pl) || `pr${pl.slice('physrev'.length)}`;
      onPhase?.('downloading', { note: `换算 ${twin}，直走 journals 摘要页` });
      return `https://journals.aps.org/${code}/abstract/${twin}`;
    },
  });
}

// ====== 美国生理学会 (journals.physiology.org，DOI 前缀 10.1152)：同骨架，页内同源 fetch 收字节 ======
// Silverchair 平台；CF 被动放行约 4s。**页面没有 citation_pdf_url meta**，PDF 地址取文章工具的
// /doi/pdf/<DOI> 链接（可从 DOI 拼但链接兜底更稳）；该端点对 context 级请求单独弹 Cloudflare
// 质询（Node TLS 栈 403），页内同源 fetch 直回 application/pdf（2026-09-01 实测 840KB）。
async function downloadPhysiology(doi, outDir, onPhase) {
  return downloadPdfViaCfMeta('Physiology', doi, outDir, onPhase, { viaPageFetch: true });
}

// ====== 芝加哥大学出版社 (journals.uchicago.edu，DOI 前缀 10.1086)：同骨架，context 级请求收字节 ======
// **本网络（教育网直连）不可达**：该域名被 DNS 污染（校园 DNS 返回假 IP，2026-09-01 实证
// DoH 对照），浏览器与 node fetch 都连接超时，须用户自己的代理/VPN 才能下载。策略与
// Royal Society 同款（站点在 Cloudflare 后），真实行为待可达网络验证。
async function downloadUChicago(doi, outDir, onPhase) {
  return downloadPdfViaCfMeta('UChicago', doi, outDir, onPhase);
}

// ====== 剑桥哲学会 (cambridge.org，Mathematical Proceedings 等)：纯 Node fetch 二段式 ======
// 落地链 doi.org → core/product/identifier/<ID> → /core/journals/... 两跳（CookieSession 跟随），
// 整站无 Cloudflare 质询，文章页 HTML 自带 citation_pdf_url meta（带内容哈希的长地址，只能读
// 不能拼），与 Nature/Springer 同一条快路径（2026-09-01 裸 fetch 双实测）。旗下另一刊
// Biological Reviews 落地 onlinelibrary.wiley.com，走既有 Wiley 策略。
async function downloadCambridge(doi, outDir, onPhase) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const session = new CookieSession(UA);
      const landing = (await session.get(`https://doi.org/${doi}`)).toString('utf8');
      const pdfUrl = /name="citation_pdf_url"[^>]*content="([^"]+)"/i.exec(landing)?.[1]
        || /content="([^"]+)"[^>]*name="citation_pdf_url"/i.exec(landing)?.[1] || '';
      if (!pdfUrl) throw new Error('Cambridge: 落地页无 citation_pdf_url');
      return await downloadPdfTwoPass('Cambridge', pdfUrl, doi, outDir, onPhase);
    } catch (e) {
      if (attempt || !/timeout|timed out|aborted due to timeout/i.test(e.message || '')) throw e;
      onPhase?.('downloading', { note: 'Cambridge 网络超时，重试一次...' });
    }
  }
}

// ====== MDPI (www.mdpi.com，DOI 前缀 10.3390)：Akamai 质询 + 真导航收 download 事件 ======
// 反爬是 Akamai Bot Manager（非 Cloudflare）：裸 fetch、context 级请求、页内同源 fetch 一律回
// bm-verify+PoW 质询壳页（probe_mdpi2/3 实证，壳页 title 是 &nbsp; 空白）；真实 Edge 打开文章页
// 数秒内被动放行。PDF 地址 = citation_pdf_url meta（.../pdf?version=<内容哈希>，不能拼）；对该
// 地址的**真导航**直接触发 download 事件（响应带 attachment 头），此时 Playwright 的 goto 会抛
// "Download is starting"（probe_mdpi4 实证 6.6MB 完整到手）——catch 掉等 download 事件即可。
// 全刊 OA 无需校园网。质询 45s 未放行 → RobotCheckError 转「需人工」。
async function downloadMDPI(doi, outDir, onPhase) {
  const ctx = await launchVisibleBrowser();
  let page;
  try {
    page = await ctx.newPage();
    await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

    onPhase?.('downloading', { note: '打开DOI页...' });
    // Akamai 对可疑会话会扣住响应（连接通但不回包），60s 常不够（2026-09-02 实测连挂两轮），放宽到 90s
    await page.goto(`https://doi.org/${doi}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    // Akamai 壳页 title 是空白（&nbsp; 实体），真实标题出现即放行；同时兼容 Cloudflare 质询标题
    for (let i = 0; i < 45; i++) {
      const t = (await titleBounded(page)) ?? ''; // null=慢/未知 → 保守按空白标题继续等
      if (t.trim() !== '' && !CF_CHALLENGE_TITLE.test(t)) break;
      await page.waitForTimeout(1000);
    }
    const title = (await titleBounded(page)) ?? '';
    if (title.trim() === '' || CF_CHALLENGE_TITLE.test(title)) throw new RobotCheckError('Akamai质询未放行');

    await dismissCookieConsent(page);
    await page.waitForSelector('meta[name="citation_pdf_url"]', { state: 'attached', timeout: 45000 });
    const pdfUrl = await page.evaluate(() => document.querySelector('meta[name="citation_pdf_url"]')?.content || '');
    if (!pdfUrl) throw new Error('MDPI: 页面无 citation_pdf_url');

    onPhase?.('downloading', { note: '取PDF(真导航触发下载)...' });
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }).catch(() => null),
      // PDF 挂 attachment 时 goto 以 "Download is starting" 拒绝——这正是预期形态，吞掉
      page.goto(pdfUrl, { waitUntil: 'commit', timeout: 60000 }).catch(() => {}),
    ]);
    if (!dl) throw new Error('MDPI: 未触发下载(质询可能未放行)');

    const tmp = path.join(outDir, `.mdpi-${sanitize(doi)}.tmp`);
    try {
      await dl.saveAs(tmp);
    } catch (e) {
      throw new Error(`MDPI: 下载件保存失败(${e.message})`);
    }
    const buf = fs.readFileSync(tmp);
    fs.rmSync(tmp, { force: true });
    if (buf.subarray(0, 4).toString('latin1') !== '%PDF') throw new Error('MDPI: 下载件非PDF');
    const out = path.join(outDir, `${sanitize(doi)}.pdf`);
    fs.writeFileSync(out, buf);
    return out;
  } finally {
    await page?.close().catch(() => {}); // 只关标签页；持久浏览器留给后续文章/批次复用
  }
}

// ====== Elsevier (ScienceDirect): Playwright 过 Cloudflare + 页面内带 cookie fetch pdfft ======
// 与 Wiley 同思路：裸 HTTP 一律被 Cloudflare/机器人风控拦截，须真实浏览器打开文章页后再在
// 页面上下文里带 cookie 取 pdfft。ScienceDirect 对自动化指纹弹 Cloudflare Turnstile「Are you
// a robot?」勾选框：程序先自动点一次勾选框（有界尝试，图选谜题不碰），没放行才在可见窗口
// 里等用户手动完成（ROBOT_CHECK_WAIT_MS），超时抛 RobotCheckError 转人工。优先用系统真实
// Edge 降低触发率，缺 Edge 退回自带 Chromium。
class RobotCheckError extends Error {}
class AccessRequiredError extends Error {}
// 浏览器窗口崩溃/被外力关闭（2026-09-27 Science reader 环境异常致 Edge 连崩两次实证）：
// 瞬时故障而非权限/验证问题——downloadOne 顶层按可重试 failed 分类，绝不转「需人工」
class BrowserClosedError extends Error {}

const ROBOT_CHECK_WAIT_MS = 120000;

// 持久化浏览器 profile：launchVisibleBrowser 的全部消费方共享同一 msedge persistent context，
// 登录态与质询 cookie 落在 <ZhuDownLoader>\.browser-profile，一次人工机构认证管后续所有批次
// （2026-09-05 EMG 复盘：临时 context 每批都要重新认证是下载失败根因之一）。严禁指向日常
// Edge 的 User Data（运行中被系统锁住，Playwright 启动直接失败）；独立目录首次由人工完成
// 一次机构认证，此后批次免登。storageState 落 sa-storage-state.json 作为第二重备份。
const ROOT_DIR = path.join(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))), '..');
const BROWSER_PROFILE_DIR = process.env.ZHU_BROWSER_PROFILE_DIR
  ? path.resolve(process.env.ZHU_BROWSER_PROFILE_DIR)
  : path.join(ROOT_DIR, '.browser-profile');
const BROWSER_STATE_BACKUP = process.env.ZHU_BROWSER_PROFILE_DIR
  ? path.join(BROWSER_PROFILE_DIR, 'storage-state.json')
  : path.join(ROOT_DIR, 'sa-storage-state.json');

let profileCtx = null;

/** 会话 cookie 可能不随浏览器关闭而保留；从上次导出的状态补回缺失项。
 *  已存在的 cookie/localStorage 保持原值，避免旧备份覆盖本次登录。 */
async function restoreBrowserState(ctx) {
  if (!fs.existsSync(BROWSER_STATE_BACKUP)) return;
  let state;
  try { state = JSON.parse(fs.readFileSync(BROWSER_STATE_BACKUP, 'utf8')); }
  catch { return; }
  if (Array.isArray(state.cookies) && state.cookies.length > 0) {
    const current = await ctx.cookies().catch(() => []);
    const key = c => `${c.name}\t${c.domain}\t${c.path}`;
    const present = new Set(current.map(key));
    const now = Date.now() / 1000;
    const missing = state.cookies.filter(c => !present.has(key(c)) && (c.expires === -1 || c.expires > now));
    if (missing.length > 0) {
      try { await ctx.addCookies(missing); }
      catch {
        for (const cookie of missing) await ctx.addCookies([cookie]).catch(() => {});
      }
    }
  }
  if (Array.isArray(state.origins) && state.origins.length > 0) {
    const saved = Object.fromEntries(state.origins.map(o => [o.origin, o.localStorage || []]));
    await ctx.addInitScript(byOrigin => {
      try {
        for (const { name, value } of byOrigin[location.origin] || []) {
          if (localStorage.getItem(name) === null) localStorage.setItem(name, value);
        }
      } catch { /* 站点可能禁用 localStorage */ }
    }, saved).catch(() => {});
  }
}

/** 批内共享的持久浏览器 context（单例；browser 断开后自动重建）。返回值就是 context 本身，
 *  不要再对它调 newContext——persistent context 不支持，直接 newPage。 */
async function launchVisibleBrowser() {
  if (profileCtx && profileCtx.browser()?.isConnected()) return profileCtx;
  const opts = { headless: false, acceptDownloads: true, args: ['--disable-blink-features=AutomationControlled'] };
  try {
    profileCtx = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, { ...opts, channel: 'msedge' });
  } catch (e) {
    // 仅在系统没有 Edge 时退回 Chromium；资料目录被另一个下载器占用等错误必须如实报出。
    if (!/executable doesn't exist|distribution 'msedge' is not found|cannot find.*msedge/i.test(e?.message || '')) throw e;
    profileCtx = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, opts);
  }
  await restoreBrowserState(profileCtx);
  return profileCtx;
}

/** 在下载器自己的持久 Edge 资料中打开官网页面，供用户完成机构登录或网页验证。
 *  页面保持打开；随后调用 downloadOne 会复用同一 context 和 cookie。 */
export async function openInDownloadBrowser(urls) {
  const ctx = await launchVisibleBrowser();
  const opened = [];
  const origins = new Set();
  for (const input of urls) {
    const target = new URL(input);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error(`不支持的验证页面地址: ${target.protocol}`);
    if (target.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(target.hostname)) target.protocol = 'https:';
    // 同一出版商先开一篇供登录；认证 cookie 在该站其余文章间共享。
    if (origins.has(target.origin)) continue;
    origins.add(target.origin);
    const page = await ctx.newPage();
    // 部分出版商的 domcontentloaded 长时间不触发；窗口已经显示后由用户继续操作。
    try {
      await page.goto(target.href, { waitUntil: 'commit', timeout: 30000 });
    } catch (e) {
      // 导航超时但地址栏已到官网时，仍可让用户在窗口继续登录/验证。
      let current;
      try { current = new URL(page.url()); } catch { /* about:blank */ }
      if (current?.origin !== target.origin) {
        await page.close().catch(() => {});
        throw new Error(`官网验证页未能打开: ${target.href} (${e?.message || e})`);
      }
    }
    opened.push(target.href);
  }
  if (ctx.pages().length > 0) await ctx.pages().at(-1).bringToFront().catch(() => {});
  return opened;
}

/** 关闭持久浏览器（幂等）。关闭前把 storageState 导出为第二重备份；profile 里的 cookie
 *  不受关闭影响，下次启动自动预载。批次结束 / 会话被质询污染时调用。 */
export async function closeBrowserSession() {
  const ctx = profileCtx;
  profileCtx = null;
  if (!ctx) return;
  try { await ctx.storageState({ path: BROWSER_STATE_BACKUP }); } catch { /* 导出失败不阻塞关闭 */ }
  try { await ctx.close(); } catch { /* 浏览器已断开时无需处理 */ }
}

// 共享浏览器会话：批量下多篇时复用持久 context——第一篇人工过 Turnstile 后 cf_clearance
// 等 cookie 留在 context 与 profile 里，后续文章开新标签页通常不再验证（一次勾选管一批）。
// 同一时刻只有一个 Elsevier 标签页活动（串行队列），避免多窗口同时弹验证互相干扰。批次结束
// 由调用方 closeBrowserSession() 收浏览器；质询未放行时 closeElsevierSession() 只重置引用。
let elsevierCtx = null;
let elsevierChain = Promise.resolve();

async function getElsevierContext() {
  if (!elsevierCtx || !elsevierCtx.browser()?.isConnected()) {
    elsevierCtx = await launchVisibleBrowser();
  }
  return elsevierCtx;
}

/** 重置 Elsevier 会话引用（幂等）。质询超时后调用——只放弃引用，不关持久浏览器：并发批里
 *  其他 worker 的标签页还挂在这台浏览器上，关掉会砸掉它们；质询页本身已随 finally 关标签页。 */
export async function closeElsevierSession() {
  elsevierCtx = null;
}

// pdfft 与文章页是两道独立质询：文章页过 Cloudflare 后，pdfft 端点还有自己的 craft/challenge
// PDF 质询（probe_elsevier2 实证）。取法：真实点击页面自带签名链接过去——点击携带用户手势
// 与同源 Referer，是质询放行的前提（2026-08-31 实证：page.goto 直导被风控拒绝 CPE 403）；
// 点击前把链接 target=_blank 改 _self，防止 PDF 开进新标签页脱离监听。响应监听挂在 context
// 级，同时覆盖主文档 PDF（inline 查看器）与 attachment 下载事件两种形态，质询放行前的中间
// HTML 被 %PDF 头自然过滤。都没收到时用 context 级 API 请求（共享质询 cookie、对齐 UA 与
// Referer）兜底再取一次；仍失败则把观察到的响应摘要经 onPhase 上报供现场定位。这里的质询
// 控件（图选等人工谜题）不自动操作，等待交给上层的 robotVisible 循环（勾选框有界自动点）。
async function fetchElsevierPdf(page, pii, outDir, onPhase) {
  const ctx = page.context();
  const seen = []; // 诊断流水：命中的每条响应/事件摘要
  let bytes = null;
  let download = null;
  // 导航前记下文章页信息：PDF 查看器接管后 evaluate 是否可用不确定，兜底路径要对齐 UA 与 Referer
  const articleUrl = page.url();
  const pageUa = await page.evaluate(() => navigator.userAgent).catch(() => '');

  // 诊断：pdfft 相关响应体落盘（含质询HTML/假PDF），供现场翻查；生产保留无副作用
  let diagN = 0;
  const saveDiag = (name, buf) => {
    diagN++;
    try { fs.writeFileSync(path.join(outDir, `diag-${name}-${diagN}.bin`), buf); } catch { /* 诊断文件写失败不影响主流程 */ }
  };

  // PDF 查看器接管主文档导航后 body() 只给占位 HTML（<embed src='about:blank'> 注入页），
  // 但响应 URL 是 crasolve 质询刚签发的 CDN 限时地址。2026-08-31 实证：APIRequestContext
  // 重取被 CDN 质询拦（Node TLS 指纹不符，返回 63KB 质询页），须走浏览器自身网络栈
  let signedUrl = null;

  const onResponse = async (res) => {
    if (bytes) return;
    const ct = res.headers()['content-type'] || '';
    const u = res.url();
    const isCdn = /sciencedirectassets\.com\//.test(u);
    if (!isCdn && !/pdf/i.test(ct) && !/pdfft/i.test(u)) return;
    if (res.status() === 200 && isCdn && /\.pdf(?:\?|$)/.test(u)) signedUrl = u;
    const rt = res.request()?.resourceType?.() || '?';
    try {
      const b = await res.body();
      const head = b.subarray(0, 4).toString('latin1');
      saveDiag('pdfft', b);
      const sc = res.headers()['set-cookie'];
      seen.push(`响应 ${res.status()} ${ct || '?'} ${b.length}B ${head === '%PDF' ? 'PDF' : '非PDF'} [${rt}] ${u.substring(0, 150)}${sc ? ` sc=${String(sc).substring(0, 60)}` : ''}`);
      if (head === '%PDF') bytes = b;
    } catch (e) {
      const hdrs = res.headers();
      seen.push(`响应 ${res.status()} ${ct || '?'} body不可取:${(e.message || '').substring(0, 30)} [${rt}] ${u.substring(0, 150)} | 头部 ${hdrs['content-disposition'] || ''} ${hdrs['content-length'] || ''}`);
    }
  };
  ctx.on('response', onResponse);
  const onRequest = (req) => {
    const u = req.url();
    if (!/pdfft/i.test(u) && !/sciencedirectassets\.com/.test(u)) return;
    const h = req.headers();
    seen.push(`请求 ${req.method()} ${u.substring(0, 110)} ref=${(h.referer || '').substring(0, 60)} sf=${h['sec-fetch-mode'] || '-'}/${h['sec-fetch-dest'] || '-'} ck=${(h.cookie || '').substring(0, 40)} range=${h.range || '-'}`);
  };
  ctx.on('request', onRequest);
  const downloadP = ctx.waitForEvent('download', { timeout: 45000 }).then(d => { download = d; }).catch(() => {});

  // 优先页面自带 pdfft 链接（带 md5/pid 签名参数）；链接可能懒加载，先等它出现
  const fallbackUrl = new URL(articleUrl).origin + `/science/article/pii/${pii}/pdfft?isDTMRedir=true&download=true`;
  await page.waitForSelector('a[href*="pdfft"]', { timeout: 15000 }).catch(() => {});
  const domLink = page.locator('a[href*="pdfft"]').first();
  let targetUrl = fallbackUrl;
  if ((await domLink.count()) > 0) {
    targetUrl = new URL(await domLink.getAttribute('href'), articleUrl).toString();
    seen.push(`链接 ${targetUrl.substring(0, 100)}`);
    // target=_blank 改 _self 后真实点击：同源导航，响应留在本页监听范围内
    await domLink.evaluate(el => { el.target = '_self'; });
    const navP = page.waitForNavigation({ waitUntil: 'commit', timeout: 60000 })
      .catch(e => seen.push(`导航 ${(e.message || '').substring(0, 40)}`));
    await domLink.click({ timeout: 15000 })
      .catch(e => seen.push(`点击 ${(e.message || '').substring(0, 40)}`));
    await Promise.race([navP, downloadP]);
  } else {
    // 页面没有签名链接：构造标准地址直导并补 Referer（无手势场景，大概率被风控拒，仅兜底）
    seen.push('页面无pdfft链接，直导标准地址');
    const nav = page.goto(fallbackUrl, { waitUntil: 'commit', timeout: 60000, referer: articleUrl })
      .catch(e => seen.push(`导航 ${(e.message || '').substring(0, 40)}`));
    await Promise.race([nav, downloadP]);
  }

  const deadline = Date.now() + 45000; // 质询 JS 放行 + PDF 流式到齐
  // signedUrl 到手即查看器接管：body() 不会再有本体，提前收手；给 attachment 形态留短宽限
  while (!bytes && !download && !signedUrl && Date.now() < deadline) await page.waitForTimeout(1000);
  await Promise.race([downloadP, new Promise(r => setTimeout(r, signedUrl ? 5000 : 0))]);
  ctx.off('response', onResponse);
  ctx.off('request', onRequest);

  // 诊断：终态页面落在哪（PDF 查看器/质询页/错误页），判定真 PDF 是否到过浏览器
  const endTitle = (await titleBounded(page)) ?? '(取标题超时)';
  seen.push(`终态 ${(page.url() || '').substring(0, 120)} 标题=${String(endTitle).substring(0, 60)}`);

  if (bytes) return bytes;

  // 查看器接管后 body() 只给占位 HTML，真 PDF 字节只存在于插件流；CDN 对非浏览器网络栈请求
  // 一律回 Turnstile 质询（2026-08-31 实证：Node 栈/route.fetch 均 63KB 质询页，且原始导航
  // 无 cookie 也直通——闸门是浏览器网络栈本身）。依次尝试三条浏览器栈路径：
  // 占位页同源 fetch → CDP loadNetworkResource → 查看器 printToPDF
  if (signedUrl) {
    // ① 占位页同源 fetch：页面 URL 就是签名地址（同源无 CORS），浏览器 TLS 应能过检
    try {
      const r = await fetchPdfInPage(page, signedUrl);
      seen.push(`占位页取 ${r.ok ? r.status : '!' + r.status} ${r.size}B ${r.sig === '%PDF' ? 'PDF' : '非PDF'}`);
      if (r.sig === '%PDF') {
        onPhase?.('downloading', { note: `取到PDF(占位页同源fetch) ${r.size}B` });
        return Buffer.from(r.b64, 'base64');
      }
    } catch (e) {
      seen.push(`占位页取失败 ${(e.message || '').substring(0, 40)}`);
    }
    // ② CDP loadNetworkResource：浏览器网络栈 + 共享 cookie，不经渲染器、无 CORS 限制
    try {
      const cdp = await ctx.newCDPSession(page);
      const rr = await cdp.send('Network.loadNetworkResource', { url: signedUrl, options: { disableCache: false, includeCredentials: true } });
      const res = rr.resource || {};
      const content = res.content || {};
      if (content.success && content.base64Encoded) {
        const b = Buffer.from(content.body, 'base64');
        seen.push(`CDP取 ${res.statusCode || '?'} ${b.length}B ${b.subarray(0, 4).toString('latin1') === '%PDF' ? 'PDF' : '非PDF'}`);
        if (b.subarray(0, 4).toString('latin1') === '%PDF') {
          onPhase?.('downloading', { note: `取到PDF(CDP loadNetworkResource) ${b.length}B` });
          return b;
        }
      } else {
        seen.push(`CDP取失败 ${res.statusCode || '?'} ${String(content.body || '').substring(0, 40)}`);
      }
    } catch (e) {
      seen.push(`CDP取失败 ${(e.message || '').substring(0, 40)}`);
    }
    // ③ 查看器 printToPDF：把已渲染的论文重排成 PDF（保底，非原始字节）
    try {
      const b = await page.pdf({ format: 'A4' });
      seen.push(`printToPDF ${b.length}B ${b.subarray(0, 4).toString('latin1') === '%PDF' ? 'PDF' : '非PDF'}`);
      if (b.subarray(0, 4).toString('latin1') === '%PDF' && b.length > 10000) {
        onPhase?.('downloading', { note: `取到PDF(printToPDF重排) ${b.length}B` });
        return b;
      }
    } catch (e) {
      seen.push(`printToPDF失败 ${(e.message || '').substring(0, 40)}`);
    }
  }

  const tmp = path.join(outDir, '.pdfft-download.tmp');
  if (download) {
    await download.saveAs(tmp).catch(() => {});
    if (fs.existsSync(tmp)) {
      const b = fs.readFileSync(tmp);
      fs.rmSync(tmp, { force: true });
      if (b.subarray(0, 4).toString('latin1') === '%PDF') return b;
      seen.push(`下载件 ${b.length}B 非PDF`);
    }
  }

  // 最后兜底：context 级 API 重取签名地址（Node 栈大概率被 Turnstile 拦，仅留诊断价值）
  if (signedUrl) {
    const stopSigned = startPhaseTicker(onPhase, 'context级请求兜底(慢速流水)...');
    try {
      const r = await ctx.request.get(signedUrl, { timeout: 60000, headers: pageUa ? { 'User-Agent': pageUa } : {} });
      const b = Buffer.from(await r.body());
      const head = b.subarray(0, 4).toString('latin1');
      seen.push(`签名URL取 ${r.status()} ${b.length}B ${head === '%PDF' ? 'PDF' : '非PDF'}`);
      if (head === '%PDF') return b;
    } catch (e) {
      seen.push(`签名URL取失败 ${(e.message || '').substring(0, 30)}`);
    } finally { stopSigned(); }
  }

  // 质询 cookie 已种下：context 级 API 请求共享同一 cookie 罐，对齐 UA 与 Referer 再取一次
  const stopApi = startPhaseTicker(onPhase, 'context级请求兜底(慢速流水)...');
  try {
    const r = await ctx.request.get(targetUrl, {
      timeout: 30000,
      headers: { Referer: articleUrl, ...(pageUa ? { 'User-Agent': pageUa } : {}) },
    });
    const b = Buffer.from(await r.body());
    const head = b.subarray(0, 4).toString('latin1');
    seen.push(`api取 ${r.status()} ${b.length}B ${head === '%PDF' ? 'PDF' : '非PDF'}`);
    if (head === '%PDF') return b;
  } catch (e) {
    seen.push(`api取失败 ${(e.message || '').substring(0, 30)}`);
  } finally { stopApi(); }

  onPhase?.('downloading', { note: `pdfft未取到。诊断: ${seen.join(' | ')}` });
  return null;
}

async function downloadElsevier(doi, outDir, onPhase) {
  // 串行入队：同时只有一个 Elsevier 标签页活动，后续文章排队复用同一 context
  const next = elsevierChain.then(() => downloadElsevierShared(doi, outDir, onPhase));
  elsevierChain = next.catch(() => {});
  return next;
}

// ====== Cell Press（已迁 cell.com 的 Elsevier 刊，如 Heliyon/Cell/Isci）：showPdf / citation meta ======
// Cell Press 系已迁出 ScienceDirect，SD 的 pdfft 模板在 cell.com 404（2026-09-05 实测 158KB
// HTML）。取法：等 citation_pdf_url meta（/heliyon/pdf/<PII>.pdf 形态）；没有则用落地 URL 的
// PII 拼 /action/showPdf?pii= 查看器地址。cell.com 无 SD 的 craft 二段质询；收字节四连 =
// 真导航 download 事件（PDF 挂 attachment 头，goto 抛 "Download is starting" 正是预期）→
// 页内同源 fetch 等全量（渐进流式 response.body() 只给 0KB 空壳，2026-09-05 实测）→
// response 监听收 %PDF → context 级请求兜底（对自动化会话常 403，仅最后尝试）。订阅文靠校园网 IP。
async function fetchCellPdf(doi, page, outDir, onPhase) {
  const ctx = page.context();
  const seen = [];
  await page.waitForSelector('meta[name="citation_pdf_url"]', { state: 'attached', timeout: 20000 }).catch(() => {});
  let pdfUrl = await page.evaluate(() => document.querySelector('meta[name="citation_pdf_url"]')?.content || '');
  if (!pdfUrl) {
    // cell.com 落地形态 /<journal>/fulltext/<PII>（PII 含括号），showPdf 端点按原文接收
    const pii = decodeURIComponent(page.url()).match(/fulltext\/([^\s?#]+)/)?.[1]
      || decodeURIComponent(page.url()).match(/pii\/([^\s?#/]+)/)?.[1]
      || '';
    if (!pii) throw new Error('无法解析Cell Press文章PII');
    pdfUrl = new URL(page.url()).origin + '/action/showPdf?pii=' + encodeURIComponent(pii);
    seen.push(`meta缺,showPdf兜底 pii=${pii}`);
  }

  let bytes = null;
  let download = null;
  const onResponse = async res => {
    if (bytes) return;
    try {
      const b = await res.body();
      // 渐进流式的空壳（0KB）不算数：等 body 自然累积的响应或页内 fetch
      if (b.length > 1024 && b.subarray(0, 4).toString('latin1') === '%PDF') bytes = b;
    } catch { /* body 尚未就绪/不可取，等后续路径 */ }
  };
  ctx.on('response', onResponse);
  const downloadP = ctx.waitForEvent('download', { timeout: 60000 }).then(d => { download = d; }).catch(() => {});
  try {
    onPhase?.('downloading', { note: '取PDF(cell.com)...' });
    // attachment 形态：goto 以 "Download is starting" 拒绝——预期，等 download 事件（MDPI 套路）
    await page.goto(pdfUrl, { waitUntil: 'commit', timeout: 60000 })
      .catch(e => seen.push(`goto ${String(e.message || e).substring(0, 40)}`));
    await Promise.race([downloadP, new Promise(r => setTimeout(r, 8000))]);
    if (download) {
      const tmp = path.join(outDir, `.cell-${sanitize(doi)}.tmp`);
      try { await download.saveAs(tmp); } catch (e) { throw new Error(`Cell Press: 下载件保存失败(${e.message})`); }
      const buf = fs.readFileSync(tmp);
      fs.rmSync(tmp, { force: true });
      if (buf.subarray(0, 4).toString('latin1') === '%PDF') return buf;
      seen.push(`下载件非PDF ${Math.round(buf.length / 1024)}KB`);
    }
    // inline 形态：页内同源 fetch 等全量（真导航已落在 PDF 同源页）
    if (!bytes) {
      const r = await fetchPdfInPage(page, pdfUrl)
        .catch(e => { seen.push(`页内fetch ${String(e.message || e).substring(0, 40)}`); return null; });
      if (r?.ok && r.sig === '%PDF') bytes = Buffer.from(r.b64, 'base64');
    }
    // 查看器二次请求形态：response 监听继续收
    const deadline = Date.now() + 15000;
    while (!bytes && Date.now() < deadline) await page.waitForTimeout(1000);
    // 终兜底：context 级请求（对自动化会话常 403）
    if (!bytes) {
      const r = await ctx.request.get(pdfUrl, { timeout: 60000 });
      const b = Buffer.from(await r.body());
      if (r.status() === 200 && b.subarray(0, 4).toString('latin1') === '%PDF') bytes = b;
      else seen.push(`ctx请求 ${r.status()} ${Math.round(b.length / 1024)}KB非PDF`);
    }
    if (!bytes) throw new Error(`Cell Press: 未取到PDF(${seen.join(' | ') || '无%PDF响应,可能无机构权限'})`);
    return bytes;
  } finally {
    ctx.off('response', onResponse);
  }
}

async function downloadElsevierShared(doi, outDir, onPhase) {
  const page = await (await getElsevierContext()).newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  try {
    onPhase?.('downloading', { note: '打开DOI页(经linkinghub跳转)...' });
    const stopNav = startPhaseTicker(onPhase, '打开DOI页(经linkinghub跳转)...');
    try {
      await page.goto(`https://doi.org/${doi}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } finally { stopNav(); }
    // doi.org → linkinghub.elsevier.com → sciencedirect.com 或 cell.com（Cell Press 系已迁移）。
    // page.url() 同步属性不阻塞；超时不致命——后续 title/PII 判定自然失败
    await waitUrlPatternClear(page, /(sciencedirect|cell)\.com/, onPhase, '等待linkinghub跳转...', 30000);
    await page.waitForTimeout(5000);

    // Cell Press 落地（cell.com）与 SD 是两套取字：pdfft 模板在 cell.com 404，走 showPdf/citation meta
    if (/cell\.com/.test(page.url())) {
      const buf = await fetchCellPdf(doi, page, outDir, onPhase);
      const out = path.join(outDir, `${sanitize(doi)}.pdf`);
      fs.writeFileSync(out, buf);
      return out;
    }

    // 一次性点击额度（视觉链窗口重探 2026-09-27 步骤2）：同一次质询上下文里 DOM/视觉链任一
    // 真实点击发生过即封死；clickState 由本函数持有，跨 waitChallengeClear、SD 人工窗口与
    // robotVisible 循环共享。
    const clickState = { clicked: false };
    const title = await titleBounded(page);
    if (title === null || CF_CHALLENGE_TITLE.test(title)) {
      // CF 托管质询阶段：先自动点一次 Turnstile 勾选框（有界尝试），再等放行；
      // SD 质询历史上偏交互式、未观察到分钟级慢放行 → 预算维持 45s 不放大，放行慢的场景由后随人工窗口兜底
      onPhase?.('downloading', { note: '检测到 Cloudflare 质询，自动点一次勾选框...' });
      if (await tryClickRobotCheckbox(page, onPhase)) clickState.clicked = true;
      await waitChallengeClear(page, onPhase, 'SD', 45000, 15000, { tickMs: 12000, clickState });
      const afterWait = await titleBounded(page);
      if (afterWait === null || CF_CHALLENGE_TITLE.test(afterWait)) { // null=慢/未知，保守视为仍未放行
        const humanDeadline = Date.now() + ROBOT_CHECK_WAIT_MS;
        const stopHuman = startPhaseTicker(onPhase, '请在浏览器窗口完成人机验证...');
        let humanNoted = false;
        try {
          for (;;) {
            const t = await titleBounded(page); // 一次迭代只问一次（原两次），结果存局部变量复用
            if (t !== null && (!CF_CHALLENGE_TITLE.test(t) || /robot|真人/i.test(t))) break;
            if (!humanNoted) {
              onPhase?.('downloading', { note: '自动点击未放行，请在浏览器窗口完成人机验证(勾选框或图选，如"请验证您是真人")...' });
              humanNoted = true;
            }
            // 有界重探（步骤2）：Turnstile 框常在检出数秒后才挂载到可点尺寸；框就绪且本上下文
            // 从未真实点击过 → 每次迭代再给一次自动点击机会（重探占用窗口内时间，不延长窗口）
            if (!clickState.clicked
                && (await challengeBoxReady(page, { attempts: 1 })).ready
                && await tryClickRobotCheckbox(page, onPhase)) {
              clickState.clicked = true;
              onPhase?.('downloading', { note: '重探点击验证勾选框，等待放行...' });
              await cfAssistEvent(page, 'challenge-clicked', { label: 'SD', reprobe: true, window: 'human' });
            }
            if (Date.now() > humanDeadline) {
              // 判负留痕：对齐骨架 failChallenge 的对称性，转人工原因与终点直接进 events.jsonl
              await cfAssistEvent(page, 'manual-evidence', { label: 'SD', challengeSource: 'nav-title', finalUrl: redactUrl(page.url()) });
              throw new RobotCheckError('Cloudflare人机验证等待超时(2分钟未通过)');
            }
            await page.waitForTimeout(3000);
          }
        } finally { stopHuman(); }
      }
    }

    // 人机验证「Are you a robot?」：先自动点一次 Turnstile 勾选框（有界尝试，图选谜题不碰）；
    // 没放行再提示人在可见窗口手动完成，超时转人工。
    // 有界重探（视觉链窗口重探 2026-09-27 步骤2）：循环体每次迭代（保持既有节奏）先判
    // 「本上下文未点击过且框就绪」→ 再给一次 tryClickRobotCheckbox；额度与前置质询阶段共享。
    const robotVisible = async () => {
      try {
        const t = await titleBounded(page);
        if (t !== null && /robot|真人/i.test(t)) return true;
        return (await page.locator('text=/are you a robot|verif(y|ing) you are human|press & hold|press and hold|请验证您是真人|请按住/i').count()) > 0;
      } catch { return false; }
    };
    let noted = false;
    let autoTried = false;
    const deadline = Date.now() + ROBOT_CHECK_WAIT_MS;
    const stopRobot = startPhaseTicker(onPhase, '请在浏览器窗口完成人机验证...');
    try {
      while (await robotVisible()) {
        if (!autoTried) {
          autoTried = true;
          await page.waitForTimeout(2500); // 等 Turnstile 控件挂载完成再点
          if (await tryClickRobotCheckbox(page, onPhase)) {
            clickState.clicked = true; // 额度共享：此后重探与人工窗口不再点击
            onPhase?.('downloading', { note: '已自动点击真人验证勾选框，等待放行...' });
            await page.waitForTimeout(3000); // 勾选后校验需要几秒，放行则页面会重载
            continue;
          }
        }
        if (!clickState.clicked
            && (await challengeBoxReady(page, { attempts: 1 })).ready
            && await tryClickRobotCheckbox(page, onPhase)) {
          clickState.clicked = true;
          onPhase?.('downloading', { note: '重探点击真人验证勾选框，等待放行...' });
          await cfAssistEvent(page, 'challenge-clicked', { label: 'SD', reprobe: true, window: 'robot' });
          await page.waitForTimeout(3000);
          continue;
        }
        if (!noted) {
          onPhase?.('downloading', { note: '自动验证未放行，请在浏览器窗口完成人机验证(勾选框或图选，如"请验证您是真人")...' });
          noted = true;
        }
        if (Date.now() > deadline) {
          // 判负留痕：同上，转人工前先落 evidence
          await cfAssistEvent(page, 'manual-evidence', { label: 'SD', challengeSource: 'nav-title', finalUrl: redactUrl(page.url()) });
          throw new RobotCheckError('人机验证等待超时(2分钟未通过)');
        }
        await page.waitForTimeout(3000);
      }
    } finally { stopRobot(); }
    if (noted) await page.waitForTimeout(5000); // 验证通过后页面会重载，等它稳定

    // cookie 同意弹窗（OneTrust 常规按钮 + 中英文文案都试）
    for (const sel of ['#onetrust-accept-btn-handler', 'button:has-text("Accept all cookies")', 'button:has-text("全部接受")']) {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(1500);
        break;
      }
    }

    // PII 优先取自落地 URL；URL 是 doi 形态时从页面内文章链接兜底
    const pii = page.url().match(/pii\/([A-Za-z0-9]+)/)?.[1]
      || await page.evaluate(() => document.querySelector('a[href*="/pii/"]')?.getAttribute('href')?.match(/pii\/([A-Za-z0-9]+)/)?.[1] || '');
    if (!pii) throw new Error('无法解析ScienceDirect文章PII');

    onPhase?.('downloading', { note: '取PDF(pdfft端点有独立质询，等它自动放行)...' });
    const buf = await fetchElsevierPdf(page, pii, outDir, onPhase);
    if (!buf) throw new Error('Elsevier: 未取到PDF(pdfft质询未放行或无下载权限)');

    const out = path.join(outDir, `${sanitize(doi)}.pdf`);
    fs.writeFileSync(out, buf);
    return out;
  } catch (e) {
    // 没人点验证 / 质询未放行：会话 cookie 没种下，立即销毁，下一篇重开重新来
    if (e instanceof RobotCheckError || e.message === 'Cloudflare质询未放行') await closeElsevierSession();
    throw e;
  } finally {
    await page.close().catch(() => {}); // 只关标签页；浏览器留着给后续文章复用
  }
}

// ====== IOP Publishing (iopscience.iop.org，DOI 前缀 10.1088)：Radware Bot Manager + 共享会话 ======
// 反爬是 Radware Bot Manager（非 Cloudflare/Akamai）：裸 fetch/无 cookie 请求一律 302 甩到
// validate.perfdrive.com 弹 **hCaptcha 勾选框**（"please confirm you are a human"）。实测两种
// 会话形态都有：全新会话常弹框要人勾（180s 无人勾不自动放行），IP 信任积累后的会话
// ~40s 自动放行无需人工（e2e 双跑 OA 均自动过）。真人勾选或自动放行后 perfdrive 种下
// Radware cookie（__uzma 等）自动跳回文章页，此后同 context 内请求不再弹验证；放行链路
// 中会经过 "Loading ..." 过渡页且可能多次弹回，就绪判定必须看 citation meta 而非 URL。
// 架构按 Elsevier 同款：模块级共享 context + 串行队列——一批里人只需勾一次验证。
// 验证框程序会先自动点一次（有界尝试，图选谜题不碰）；没放行才等人手动完成，
// 超时抛 RobotCheckError 转「需人工」。
// PDF 地址读 citation_pdf_url meta（.../article/<DOI>/pdf）；收字节顺序 = 页内同源 fetch
// （会话信任后直回 %PDF）→ 真导航 download 事件 → 落点页同源重取 → context 级请求
// （补 Referer/UA）。订阅文无校园网权限时 PDF 端点直接回文章页 HTML（e2e 实测 172KB），按
// 「无PDF权限」优雅失败。IOP 期刊多已转 OA 或混合（JPhys 系/Nuclear Fusion/JINST 等）。
const RADWARE_CHALLENGE = /radware|bot manager|captcha/i;

let iopCtx = null;
let iopChain = Promise.resolve();

async function getIopContext() {
  if (!iopCtx || !iopCtx.browser()?.isConnected()) {
    iopCtx = await launchVisibleBrowser();
  }
  return iopCtx;
}

/** 重置 IOP 会话引用（幂等）。质询超时后调用——只放弃引用，不关持久浏览器（同 closeElsevierSession）。 */
export async function closeIopSession() {
  iopCtx = null;
}

async function downloadIOP(doi, outDir, onPhase) {
  // 串行入队：同时只有一个 IOP 标签页活动，后续文章排队复用同一 context（人只勾一次验证）
  const next = iopChain.then(() => downloadIOPShared(doi, outDir, onPhase));
  iopChain = next.catch(() => {});
  return next;
}

async function downloadIOPShared(doi, outDir, onPhase) {
  const page = await (await getIopContext()).newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  try {
    onPhase?.('downloading', { note: '打开DOI页(Radware可能拦跳验证页)...' });
    // Radware 对可疑会话扣住响应，90s 宽限（MDPI/Akamai 同款问题）
    await page.goto(`https://doi.org/${doi}`, { waitUntil: 'domcontentloaded', timeout: 90000 });

    // 等文章页真正就绪：Radware 放行后可能多次弹回验证页/Loading 过渡页，URL 含 iopscience
    // 不代表文章已到——以 citation meta 或 PDF 链接实际出现为准（每轮问 DOM，别只信 URL/标题）。
    // 先自动点一次 hCaptcha 勾选框（有界尝试，图选谜题不碰），没放行再提示人手动完成
    let noted = false;
    let autoClicked = false;
    let ready = false;
    const deadline = Date.now() + ROBOT_CHECK_WAIT_MS;
    for (;;) {
      const u = page.url();
      const title = ((await titleBounded(page)) ?? '').trim();
      const captive = u.includes('validate.perfdrive.com') || /radware|bot manager|captcha/i.test(title);
      if (!captive && u.includes('iopscience.iop.org')) {
        ready = await page.evaluate(() =>
          !!document.querySelector('meta[name="citation_pdf_url"]')
          || [...document.querySelectorAll('a[href*="/pdf"]')].some(a => a.href)
        ).catch(() => false);
        if (ready) break;
      }
      if (captive && !autoClicked) {
        autoClicked = true;
        await page.waitForTimeout(2500); // 等 hCaptcha 勾选框 iframe 挂载完成
        if (await tryClickRobotCheckbox(page, onPhase)) {
          onPhase?.('downloading', { note: '已自动点击 "I\'m not a robot" 勾选框，等待放行...' });
          continue;
        }
      }
      if (captive && !noted) {
        onPhase?.('downloading', { note: '自动验证未放行，请在浏览器窗口完成人机验证(勾选框或图选)...' });
        noted = true;
      }
      if (Date.now() > deadline) throw new RobotCheckError('Radware人机验证等待超时(2分钟未通过)');
      await page.waitForTimeout(1000);
    }

    await dismissCookieConsent(page);

    // 文章页就绪后 meta/链接一定在（上面刚验过）；取 PDF 地址
    const pdfUrl = await page.evaluate(() =>
      document.querySelector('meta[name="citation_pdf_url"]')?.content
      || [...document.querySelectorAll('a[href*="/pdf"]')].map(a => a.href).find(h => !h.includes('/pdfs/'))
      || '');
    if (!pdfUrl) throw new Error('IOP: 页面无 citation_pdf_url(可能质询未放行或文章无PDF)');
    onPhase?.('downloading', { note: '取PDF...' });

    // 收字节四连 + 诊断流水：页内同源 fetch → 真导航（download 事件 / 导航落点重取）→ context 级请求。
    // Radware 可能对 PDF 直链单独弹 JS 质询：真导航让 JS 跑完后落点若是 PDF 查看器/下载，
    // 就能在落点页同源重取（Elsevier 占位页同套路）；全程记录响应摘要供失败时定位。
    const seen = [];
    let buf = null;
    const ctx = page.context();
    const pdfResp = async res => {
      if (buf) return;
      const ct = res.headers()['content-type'] || '';
      const u = res.url();
      if (res.status() !== 200 || !/application\/pdf/i.test(ct) && !/\.pdf(?:\?|$)/i.test(u)) return;
      try {
        const b = await res.body();
        const head = b.subarray(0, 4).toString('latin1');
        seen.push(`响应 ${res.status()} ${ct || '?'} ${b.length}B ${head === '%PDF' ? 'PDF' : '非PDF'} ${u.substring(0, 140)}`);
        if (head === '%PDF') buf = b;
      } catch { /* body 不可取（PDF 查看器接管时常见），留给落点重取 */ }
    };
    ctx.on('response', pdfResp);
    try {
      // 页内同源 fetch；meta 指向跨域 CDN 时会抛 CORS 错——吞掉走导航路径
      let r = null;
      try {
        r = await fetchPdfInPage(page, pdfUrl);
        seen.push(`页内fetch ${r.ok ? 'ok' : '!ok'} ${r.ct || '?'} ${r.size}B ${r.sig === '%PDF' ? 'PDF' : '非PDF'}`);
        if (r.ok && r.sig === '%PDF') buf = Buffer.from(r.b64, 'base64');
      } catch (e) {
        seen.push(`页内fetch失败 ${(e.message || '').substring(0, 60)}`);
      }

      if (!buf) {
        onPhase?.('downloading', { note: '页内fetch未命中，真导航触发下载...' });
        const [dl] = await Promise.all([
          page.waitForEvent('download', { timeout: 45000 }).catch(() => null),
          // PDF 挂 attachment 时 goto 以 "Download is starting" 拒绝——这正是预期形态，吞掉
          page.goto(pdfUrl, { waitUntil: 'commit', timeout: 45000 }).catch(() => {}),
        ]);
        if (dl) {
          seen.push('download 事件触发');
          const tmp = path.join(outDir, `.iop-${sanitize(doi)}.tmp`);
          try { await dl.saveAs(tmp); } catch { /* 下载件保存失败走下一路 */ }
          if (fs.existsSync(tmp)) {
            const b = fs.readFileSync(tmp);
            fs.rmSync(tmp, { force: true });
            if (b.subarray(0, 4).toString('latin1') === '%PDF') buf = b;
          }
        }
      }

      // 导航落点重取：真导航把 PDF 开进查看器时没有 download 事件，但落点页与 PDF 同源，
      // 在落点页里同源 fetch 即得原始字节（质询 JS 已在导航里跑完）
      if (!buf && /\.pdf(?:\?|$)/i.test(page.url()) && !page.url().includes('iopscience.iop.org/article')) {
        onPhase?.('downloading', { note: '落点页同源重取...' });
        const r2 = await fetchPdfInPage(page, page.url()).catch(e => ({ err: e.message }));
        seen.push(r2.err ? `落点重取失败 ${r2.err}` : `落点重取 ${r2.ok ? 'ok' : '!ok'} ${r2.size}B ${r2.sig === '%PDF' ? 'PDF' : '非PDF'}`);
        if (!r2.err && r2.ok && r2.sig === '%PDF') buf = Buffer.from(r2.b64, 'base64');
      }

      if (!buf) {
        // context 级请求兜底：Radware 信任 cookie 已种下时对 PDF 直链通常不再质询
        const pageUa = await page.evaluate(() => navigator.userAgent).catch(() => '');
        const headers = { Referer: page.url() };
        if (pageUa) headers['User-Agent'] = pageUa;
        const cr = await ctx.request.get(pdfUrl, { timeout: 45000, headers }).catch(e => { seen.push(`ctx请求失败 ${(e.message || '').substring(0, 60)}`); return null; });
        if (cr) {
          const b = Buffer.from(await cr.body().catch(() => Buffer.alloc(0)));
          const head = b.subarray(0, 4).toString('latin1');
          seen.push(`ctx请求 ${cr.status()} ${b.length}B ${head === '%PDF' ? 'PDF' : '非PDF'}`);
          if (cr.status() === 200 && head === '%PDF') buf = b;
        }
      }
    } finally {
      ctx.off('response', pdfResp);
    }

    if (!buf) {
      const endTitle = (await titleBounded(page)) ?? '';
      seen.push(`终态 ${(page.url() || '').substring(0, 100)} 标题=${String(endTitle).substring(0, 50)}`);
      onPhase?.('downloading', { note: `取PDF失败。诊断: ${seen.join(' | ')}` });
      throw new Error('IOP: 未取到PDF(可能无订阅权限或Radware质询未放行)');
    }

    const out = path.join(outDir, `${sanitize(doi)}.pdf`);
    fs.writeFileSync(out, buf);
    return out;
  } catch (e) {
    // 验证超时：Radware 信任 cookie 没拿到，销毁会话，下一篇重开重新来
    if (e instanceof RobotCheckError) await closeIopSession();
    throw e;
  } finally {
    await page.close().catch(() => {}); // 只关标签页；浏览器留着给后续文章复用
  }
}

/**
 * 下载单篇文献。
 * @param {string} doi DOI
 * @param {string} outDir 输出目录（须已存在）
 * @param {object} [opts]
 * @param {(phase: 'resolving'|'downloading'|'verifying', info?: {publisher?: string, url?: string, note?: string}) => void} [opts.onPhase] 阶段回调
 * @param {boolean} [opts.openManual] true 时 Elsevier 被人机验证拦住转人工后立即打开 Edge（单篇 CLI 行为）；批量模式传 false 由编排器统一开
 * @returns {Promise<{doi: string, publisher: string, status: 'ok'|'failed'|'manual-required', path: string, bytes: number, durationMs: number, reason: string, resolveUrl: string, permanent: boolean}>}
 *   permanent=true 的 failed 是确定性结果（unknown 出版商/DOI 无法解析/无 PDF 权限/落地 404），编排器不得重试。
 */
export async function downloadOne(doi, outDir, { onPhase, openManual = false } = {}) {
  const start = Date.now();
  const res = { doi, publisher: '', status: 'failed', path: '', bytes: 0, durationMs: 0, reason: '', resolveUrl: '', permanent: false };
  const finish = (status, reason = '') => {
    res.status = status;
    res.reason = reason;
    res.durationMs = Date.now() - start;
    return res;
  };

  try {
    fs.mkdirSync(outDir, { recursive: true });
    onPhase?.('resolving');
    const { publisher, resolveUrl, resolveStatus } = await resolvePublisher(doi);
    res.publisher = publisher;
    // SAGE 官网在本网络是 IP 级黑洞（TCP 全丢包），展示/人工打开地址放官网只会无限转圈；
    // 人工兜底地址必须能打开——用 Sage 中国镜像文章页（华科 IP 自动机构认证、零质询）。
    res.resolveUrl = publisher === 'sage' ? `https://sage.cnpereading.com/doi/${doi}` : resolveUrl;

    if (publisher === 'unknown') {
      const host = resolveUrl ? resolveUrl.replace(/^https?:\/\//, '').split('/')[0] : '';
      const reason = host ? `不支持的出版商: ${host}` : resolveStatus === 404 ? 'DOI未注册或编号有误(解析状态404)' : `DOI无法解析(状态${resolveStatus}无重定向)`;
      res.permanent = true;
      appendLog(outDir, doi, publisher, '失败', reason);
      return finish('failed', reason);
    }

    onPhase?.('downloading', { publisher, url: res.resolveUrl });

    let file;
    if (publisher === 'nature') file = await downloadNature(doi, resolveUrl, outDir, onPhase);
    else if (publisher === 'springer') file = await downloadSpringer(doi, outDir, onPhase);
    else if (publisher === 'bmc') {
      try {
        file = await downloadBMC(doi, resolveUrl, outDir, onPhase);
      } catch (e) {
        if (!(e instanceof RobotCheckError)) throw e;
        // 骨架质询等满时限仍没人勾：确定性人工结果，不重试（打开 Edge 由用户自己过）
        if (openManual) await openInDownloadBrowser([res.resolveUrl]);
        appendLog(outDir, doi, publisher, '需人工', e.message);
        return finish('manual-required', e.message);
      }
    }
    else if (publisher === 'pnas') file = await downloadPNAS(doi, outDir, onPhase);
    else if (publisher === 'science') file = await downloadScience(doi, outDir, onPhase);
    else if (publisher === 'ieee') file = await downloadIEEE(doi, outDir, onPhase);
    else if (publisher === 'elsevier') {
      // 阶段二（行动方案 2026-09-25）：ScienceDirect 域名优先走 FlareSolverr 同浏览器会话适配器。
      // cell.com（Cell Press 系）仍走旧路径；FlareSolverr 未运行或适配器 temporary-error 时旧路径兜底一次。
      const onScienceDirect = /sciencedirect\.com|elsevier\.com/i.test(resolveUrl) && !/cell\.com/i.test(resolveUrl);
      let fsDone = false;
      if (onScienceDirect) {
        const fsHealth = await checkFlaresolverr();
        if (fsHealth.available) {
          onPhase?.('downloading', { note: '正在通过 FlareSolverr 下载 ScienceDirect PDF...' });
          const fr = await downloadViaFlaresolverr(doi, outDir, {
            onNote: m => onPhase?.('downloading', { note: m }),
          });
          if (fr.status === 'ok') {
            file = fr.path;
            fsDone = true;
          } else if (fr.status === 'no-access') {
            // 确定性无权限：重试也不会有权限，标永久失败不重试
            res.permanent = true;
            appendLog(outDir, doi, publisher, '失败', `无PDF权限: ${fr.reason}`);
            return finish('failed', `无PDF权限: ${fr.reason}`);
          } else if (fr.status === 'challenge') {
            // 人机验证没过/被弹回验证页：确定性人工结果，转「需人工」
            if (openManual) await openInDownloadBrowser([res.resolveUrl]);
            appendLog(outDir, doi, publisher, '需人工', fr.reason);
            return finish('manual-required', fr.reason);
          } else {
            onPhase?.('downloading', { note: `FlareSolverr 未成功(${fr.reason})，走现有路径兜底一次...` });
          }
        } else {
          onPhase?.('downloading', { note: 'FlareSolverr 未运行，走现有 ScienceDirect 路径...' });
        }
      }
      if (!fsDone) {
        try {
          file = await downloadElsevier(doi, outDir, onPhase);
        } catch (e) {
          if (!(e instanceof RobotCheckError)) throw e;
          // 窗口内等满时限仍被人机验证拦住：确定性人工结果，不重试（打开 Edge 由用户自己过）
          if (openManual) await openInDownloadBrowser([res.resolveUrl]);
          appendLog(outDir, doi, publisher, '需人工', e.message);
          return finish('manual-required', e.message);
        }
      }
    }
    else if (publisher === 'wiley') file = await downloadWiley(doi, outDir, onPhase);
    else if (publisher === 'iop') {
      try {
        file = await downloadIOP(doi, outDir, onPhase);
      } catch (e) {
        if (!(e instanceof RobotCheckError)) throw e;
        // Radware 验证等满时限仍没人勾：确定性人工结果，不重试（打开 Edge 由用户自己过）
        if (openManual) await openInDownloadBrowser([res.resolveUrl]);
        appendLog(outDir, doi, publisher, '需人工', e.message);
        return finish('manual-required', e.message);
      }
    }
    else if (['frontiers', 'tandf', 'spie', 'aip', 'optica'].includes(publisher)) {
      try {
        // 直链两段（frontiers/tandf）或骨架读 meta（spie/aip/optica）；质询未放行统一转「需人工」不重试
        file = await {
          frontiers: downloadFrontiers,
          tandf: downloadTandF,
          spie: downloadSPIE,
          aip: downloadAIP,
          optica: downloadOptica,
        }[publisher](doi, outDir, onPhase);
      } catch (e) {
        if (!(e instanceof RobotCheckError)) throw e;
        if (openManual) await openInDownloadBrowser([res.resolveUrl]);
        appendLog(outDir, doi, publisher, '需人工', e.message);
        return finish('manual-required', e.message);
      }
    }
    else if (['biologists', 'royalsociety', 'oxford', 'acs', 'aps', 'physiology', 'uchicago', 'mdpi'].includes(publisher)) {
      try {
        // 质询站共用分支（CoB/Physiology 收字节走页内 fetch，RS/Oxford/ACS/APS/UChicago context
        // 级请求，MDPI 走自家 Akamai 真导航下载）；质询未放行统一转「需人工」不重试
        file = await {
          biologists: downloadBiologists,
          royalsociety: downloadRoyalSociety,
          oxford: downloadOxford,
          acs: downloadACS,
          aps: downloadAPS,
          physiology: downloadPhysiology,
          uchicago: downloadUChicago,
          mdpi: downloadMDPI,
        }[publisher](doi, outDir, onPhase);
      } catch (e) {
        if (!(e instanceof RobotCheckError)) throw e;
        // 质询一直未放行：确定性人工结果，不重试
        if (openManual) await openInDownloadBrowser([res.resolveUrl]);
        appendLog(outDir, doi, publisher, '需人工', e.message);
        return finish('manual-required', e.message);
      }
    }
    else if (publisher === 'cambridge') file = await downloadCambridge(doi, outDir, onPhase);
    else file = await downloadSAGE(doi, outDir, onPhase);

    onPhase?.('verifying');
    const v = verifyFile(file);
    if (v?.ok) {
      res.path = file;
      res.bytes = v.bytes;
      appendLog(outDir, doi, publisher, '成功', `${Math.round(v.bytes / 1024)}KB ${((Date.now() - start) / 1000).toFixed(1)}s`);
      return finish('ok');
    }
    const reason = v ? `内容非PDF(${Math.round(v.bytes / 1024)}KB)` : '文件未生成';
    // 产出物是 HTML（无权限形态：订阅文 PDF 端点回文章/登录页）重试也不会变，标确定性
    if (v) res.permanent = true;
    appendLog(outDir, doi, publisher, '无效', reason);
    return finish('failed', reason);
  } catch (e) {
    const reason = (e?.message || String(e)).substring(0, 120);
    // 浏览器窗口崩溃/被关闭：瞬时故障（2026-09-27 Science reader 环境异常致 Edge 连崩实证），
    // 重试有意义；不是权限/验证问题——不转「需人工」、不标 permanent
    if (e instanceof BrowserClosedError || /Target page, context or browser has been closed|Target closed|browser has (?:been|was) closed/i.test(reason)) {
      const msg = e instanceof BrowserClosedError ? reason
        : `浏览器窗口崩溃或被关闭(多因站点页面异常，可重跑): ${reason}`;
      try { appendLog(outDir, doi, res.publisher || 'unknown', '失败', msg); }
      catch { /* 输出目录不可写时也必须返回明确失败结果 */ }
      return finish('failed', msg);
    }
    if (e instanceof RobotCheckError || e instanceof AccessRequiredError) {
      if (openManual) await openInDownloadBrowser([res.resolveUrl || `https://doi.org/${doi}`]);
      appendLog(outDir, doi, res.publisher || 'unknown', '需人工', reason);
      return finish('manual-required', reason);
    }
    // 无PDF权限/落地404/无法解析类失败重试同样无意义（重试只对瞬时网络/质询抖动有意义）；
    // EPERM = pwsh 沙箱内派生浏览器被 Job 对象拦截（2026-09-06 实测），重试必败
    if (/无PDF权限|内容非PDF|无法解析|未注册|不支持的出版商|无备选地址|Not Found|EPERM/i.test(reason)) res.permanent = true;
    try { appendLog(outDir, doi, res.publisher || 'unknown', '失败', reason); }
    catch { /* 输出目录不可写时也必须返回明确失败结果 */ }
    return finish('failed', reason);
  }
}
