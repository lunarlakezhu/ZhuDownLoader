#!/usr/bin/env node
// 批量文献下载编排器：清单解析 + 并发池 + 看板 + 汇总。
// 用法: node batch_download.mjs <清单文件> [输出目录] [选项]
//   --concurrency, -c N   并发数（默认 2，建议 ≤4：PNAS/Science/IEEE/SAGE 每篇弹一个 Chromium 窗口）
//   --retries, -r N       单篇失败后的自动重试次数（默认 1）
//   --item-timeout N      单篇硬看门狗分钟数（默认 10；0 或负数=不启用。FlareSolverr 等慢路径可调大）
//   --plain               看板符号换 ASCII，兼容旧版 conhost
//   --open-manual         在下载器 Edge 资料中完成验证，按 Enter 后重试需人工条目
// PowerShell 入口见 zhu-dl.ps1；单篇用法见 pw_download.mjs。
import fs from 'fs';
import path from 'path';
import readline from 'readline/promises';
import { downloadOne, existingPdf, appendLog, openInDownloadBrowser, closeElsevierSession, closeIopSession, closeBrowserSession } from './lib/downloader.mjs';
import { parseList } from './lib/listparse.mjs';
import { writeDownloadProgress } from './lib/progress.mjs';
import { cfAssistRunBegin, cfAssistRunEndSync } from './lib/cf-assist.mjs';

// ---------- 参数 ----------

function usage() {
  console.log('用法: node batch_download.mjs <清单文件> [输出目录] [选项]');
  console.log('选项:');
  console.log('  --concurrency, -c N   并发数（默认 2，建议 ≤4）');
  console.log('  --retries, -r N       失败重试次数（默认 1）');
  console.log('  --item-timeout N      单篇硬看门狗分钟数（默认 10，≤0 关闭）');
  console.log('  --plain               看板用 ASCII 符号');
  console.log('  --open-manual         在下载器 Edge 中验证后重试需人工条目');
}

function parseArgs(argv) {
  const opts = { list: '', outDir: '', concurrency: 2, retries: 1, itemTimeoutMin: 10, plain: false, openManual: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--concurrency' || a === '-c') opts.concurrency = Number(argv[++i]);
    else if (a === '--retries' || a === '-r') opts.retries = Number(argv[++i]);
    else if (a === '--item-timeout') opts.itemTimeoutMin = Number(argv[++i]);
    else if (a === '--plain') opts.plain = true;
    else if (a === '--open-manual') opts.openManual = true;
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else if (!opts.list) opts.list = a;
    else if (!opts.outDir) opts.outDir = a;
    else { console.error(`未知参数: ${a}`); usage(); process.exit(2); }
  }
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) { console.error('并发数须为 ≥1 的整数'); process.exit(2); }
  if (!Number.isInteger(opts.retries) || opts.retries < 0) { console.error('重试次数须为 ≥0 的整数'); process.exit(2); }
  if (!Number.isFinite(opts.itemTimeoutMin)) { console.error('--item-timeout 须为数字（分钟）'); process.exit(2); }
  return opts;
}

// ---------- 看板渲染 ----------

/** 终端显示宽度（CJK 记 2），用于表格对齐。 */
function displayWidth(s) {
  let w = 0;
  for (const ch of s) w += /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/.test(ch) ? 2 : 1;
  return w;
}

function pad(s, w) {
  const d = w - displayWidth(s);
  return d > 0 ? s + ' '.repeat(d) : s;
}

function trunc(s, w) {
  if (displayWidth(s) <= w) return s;
  let out = '';
  let wd = 0;
  for (const ch of s) {
    const cw = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/.test(ch) ? 2 : 1;
    if (wd + cw > w - 1) break;
    out += ch;
    wd += cw;
  }
  return out + '…';
}

const SYMBOLS_UNICODE = {
  ok: '✓ 成功', failed: '✗ 失败', manual: '⚠ 需人工', exists: '✓ 已存在',
  resolving: '… 解析中', downloading: '⬇ 下载中', verifying: '⏳ 校验中', pending: '· 待处理',
  header: { ok: '✓', failed: '✗', manual: '⚠', exists: '✓', running: '…', pending: '·' },
};
const SYMBOLS_PLAIN = {
  ok: 'OK', failed: 'FAIL', manual: 'MANUAL', exists: 'EXIST',
  resolving: 'RESOLVING', downloading: 'DOWNLOADING', verifying: 'VERIFYING', pending: 'WAIT',
  header: { ok: 'OK', failed: 'FAIL', manual: 'MANUAL', exists: 'EXIST', running: 'RUN', pending: 'WAIT' },
};

const COL = { idx: 3, doi: 32, pub: 8, status: 11, dur: 7, note: 28 };
const COMPACT_LIMIT = 50;

// ---------- 主流程 ----------

const opts = parseArgs(process.argv.slice(2));
if (!opts.list) { usage(); process.exit(2); }
if (!fs.existsSync(opts.list)) { console.error(`❌ 清单文件不存在: ${opts.list}`); process.exit(2); }

const outDir = path.resolve(opts.outDir || 'downloads');
fs.mkdirSync(outDir, { recursive: true });
if (opts.concurrency > 4) console.log(`⚠️ 并发 ${opts.concurrency} 偏高：浏览器任务每篇弹一个 Chromium 窗口，建议 ≤4\n`);

const { dois, skipped } = parseList(fs.readFileSync(opts.list, 'utf8'));
if (dois.length === 0) { console.log('清单中未识别到任何 DOI，结束。'); process.exit(0); }

// 运行生命周期（DSH 图像辅助监看的契约）：run.json 记 running → ended/interrupted。
// cf_assist_test 经 ZHU_CF_ASSIST_RUN_ID 注入运行编号，独立运行时自生成。
const runId = process.env.ZHU_CF_ASSIST_RUN_ID || `batch-${Date.now().toString(36)}-${process.pid}`;
cfAssistRunBegin({ runId, label: 'batch_download', total: dois.length,
  progressFile: path.join(outDir, '_download_progress.json') });
process.on('exit', () => {
  const summary = { ok: 0, failed: 0, manual: 0, exists: 0 };
  let allDone = true;
  for (const it of items) {
    if (it.state !== 'done') { allDone = false; continue; }
    if (summary[it.status] !== undefined) summary[it.status]++;
  }
  cfAssistRunEndSync({ interrupted: !allDone, summary });
});

// 待下载清单确认表
console.log(`待下载清单（共 ${dois.length} 篇，跳过 ${skipped} 个无法识别的行）:`);
for (const [i, doi] of dois.entries()) console.log(`${String(i + 1).padStart(COL.idx)}  ${doi}`);
console.log(`输出目录: ${outDir}`);
console.log(`并发: ${opts.concurrency}   重试: ${opts.retries}${opts.plain ? '   (ASCII 看板)' : ''}\n`);

// 任务状态：state = pending|running|done；done 后 status = ok|failed|manual|exists
const items = dois.map((doi, i) => ({
  idx: i + 1, doi, publisher: '', state: 'pending', phase: '',
  attempt: 0, startedAt: 0, endedAt: 0, durationMs: 0, status: '', reason: '', note: '', path: '', bytes: 0, resolveUrl: '',
}));

// 跳过已下载（文件头 %PDF- 才算），失败重跑零成本
for (const it of items) {
  const p = existingPdf(it.doi, outDir);
  if (p) {
    it.state = 'done';
    it.status = 'exists';
    it.path = p;
    it.bytes = fs.statSync(p).size;
    appendLog(outDir, it.doi, '-', '已存在', path.basename(p));
  }
}

// 进度落盘：SmartAnswer 面板/SaActivity 的数据源（与 CLI 看板解耦，agent 只读这个 JSON）
const batchStartedAt = Date.now();
writeDownloadProgress(outDir, items, { concurrency: opts.concurrency, startedAt: batchStartedAt });

const pending = items.filter(it => it.state === 'pending');
const isTty = Boolean(process.stdout.isTTY);
const S = opts.plain ? SYMBOLS_PLAIN : SYMBOLS_UNICODE;
let doneCount = items.length - pending.length;
let lastLineCount = 0;
let renderTimer = null;
let ticker = null;

function statusKey(it) {
  if (it.state === 'pending') return 'pending';
  if (it.state === 'running') return it.phase || 'resolving';
  return it.status;
}

function noteOf(it) {
  if (it.state === 'done') {
    if (it.status === 'ok') return `${Math.round(it.bytes / 1024)}KB`;
    if (it.status === 'exists') return `已有 ${Math.round(it.bytes / 1024)}KB`;
    if (it.status === 'manual') return it.reason || 'Cloudflare 需人工';
    return it.reason;
  }
  if (it.attempt > 1) return `重试${it.attempt - 1}/${opts.retries} ${it.note}`.trim();
  return it.note;
}

function visibleItems() {
  if (items.length <= COMPACT_LIMIT) return items;
  // 超长清单折叠：成功/已存在并入表头计数，只列进行中与有问题的条目
  return items.filter(it => it.state !== 'done' || (it.status !== 'ok' && it.status !== 'exists'));
}

function buildDashboardLines() {
  const c = { ok: 0, failed: 0, manual: 0, exists: 0 };
  let running = 0;
  let wait = 0;
  for (const it of items) {
    if (it.state === 'done') c[it.status]++;
    else if (it.state === 'running') running++;
    else wait++;
  }
  const lines = [];
  const H = S.header;
  lines.push(`文献下载看板  共 ${items.length} 篇 | ${H.ok} 成功 ${c.ok}  ${H.failed} 失败 ${c.failed}  ${H.manual} 需人工 ${c.manual}  ${H.exists} 已存在 ${c.exists}  ${H.running} 进行中 ${running}  ${H.pending} 待处理 ${wait}`);
  lines.push(`${''.padEnd(COL.idx)}  ${pad('DOI', COL.doi)}  ${pad('出版商', COL.pub)}  ${pad('状态', COL.status)}  ${pad('耗时', COL.dur)}  说明`);
  for (const it of visibleItems()) {
    const dur = it.state === 'running'
      ? `${Math.round((Date.now() - it.startedAt) / 1000)}s`
      : (it.durationMs ? `${(it.durationMs / 1000).toFixed(1)}s` : '');
    const pub = it.publisher ? it.publisher.toUpperCase() : (it.status === 'exists' ? '—' : '');
    lines.push(
      `${pad(String(it.idx), COL.idx)}  ${pad(trunc(it.doi, COL.doi), COL.doi)}  ${pad(pub, COL.pub)}  ${pad(S[statusKey(it)] ?? '', COL.status)}  ${pad(dur, COL.dur)}  ${trunc(noteOf(it), COL.note)}`
    );
  }
  if (items.length > COMPACT_LIMIT) lines.push(`…… 成功/已存在条目已折叠，完整结果见结束汇总与 download.log`);
  return lines;
}

function render() {
  if (!isTty) return;
  const lines = buildDashboardLines();
  let out = '';
  if (lastLineCount > 0) out += `\x1b[${lastLineCount}F`;
  for (const l of lines) out += `\x1b[2K${l}\n`;
  process.stdout.write(out);
  lastLineCount = lines.length;
}

/** 节流重绘（约 250ms）；immediate 时立即刷新（终态变化）。 */
function scheduleRender(immediate = false) {
  if (!isTty) return;
  if (immediate) {
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    render();
    return;
  }
  if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; render(); }, 250);
}

/** 非 TTY：逐行日志（PDF2md 式），不做重绘。 */
function logLine(it) {
  const tag = S[statusKey(it)] ?? '';
  const extra = it.status === 'ok' || it.status === 'exists' ? `${Math.round(it.bytes / 1024)}KB` : (it.reason || noteOf(it));
  const dur = it.durationMs ? `${(it.durationMs / 1000).toFixed(1)}s` : '';
  console.log(`[${doneCount}/${items.length}] ${tag} ${it.doi} ${it.publisher ? it.publisher.toUpperCase() : ''} ${extra} ${dur}`.replace(/\s+/g, ' ').trimEnd());
}

function finish(it) {
  it.state = 'done';
  // 终态耗时锚定（视觉链窗口重探 2026-09-27 步骤4）：endedAt/durationMs 在收场瞬间冻结，
  // progress 每拍重写不再用 Date.now()-startedAt 重算放大（CLI 路径原先不写 durationMs）
  it.endedAt = Date.now();
  if (!(it.durationMs > 0) && it.startedAt > 0) it.durationMs = Math.max(0, it.endedAt - it.startedAt);
  doneCount++;
  writeDownloadProgress(outDir, items, { concurrency: opts.concurrency, startedAt: batchStartedAt });
  if (isTty) scheduleRender(true);
  else logLine(it);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 单篇硬看门狗（修复方案步骤1b）：downloadOne 内部任何一层挂起（如页内 fetch/站方扣住响应）
// 都不得拖死批次。默认 10 分钟 ≥ 全网最慢正常路径（IEEE 实测 24.4s；FlareSolverr 慢路径用
// --item-timeout 调大）。超时=确定性失败，不重试（已耗满时限的挂起重试大概率再挂）。
const ITEM_TIMEOUT_MS = opts.itemTimeoutMin > 0 ? opts.itemTimeoutMin * 60000 : Infinity;

async function runItem(it) {
  const maxAttempts = opts.retries + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    it.attempt = attempt;
    it.state = 'running';
    it.note = '';
    it.startedAt = Date.now();
    scheduleRender();
    writeDownloadProgress(outDir, items, { concurrency: opts.concurrency, startedAt: batchStartedAt });
    let failedReason = '';
    try {
      const watchdog = sleep(ITEM_TIMEOUT_MS).then(() => ({ __watchdog: true }));
      const r = await Promise.race([
        downloadOne(it.doi, outDir, {
          openManual: false,
          onPhase: (phase, info = {}) => {
            if (it.state === 'done') return; // 看门狗已收场的挂起任务仍可能回调，不得污染终态
            it.phase = phase;
            if (info.publisher) it.publisher = info.publisher;
            if (info.note) it.note = info.note;
            scheduleRender();
            writeDownloadProgress(outDir, items, { concurrency: opts.concurrency, startedAt: batchStartedAt });
          },
        }),
        watchdog,
      ]);
      if (r && r.__watchdog) {
        it.status = 'failed';
        it.reason = `单篇超时(看门狗${opts.itemTimeoutMin}分钟)`;
        appendLog(outDir, it.doi, it.publisher || '-', '失败', it.reason);
        finish(it);
        return;
      }
      it.publisher = r.publisher;
      it.resolveUrl = r.resolveUrl;
      it.path = r.path;
      it.bytes = r.bytes;
      if (r.status === 'manual-required') {
        it.status = 'manual';
        it.reason = r.reason;
        finish(it); // 需人工是确定性结果（Cloudflare），不重试
        return;
      }
      if (r.status === 'ok') {
        it.status = 'ok';
        it.reason = '';
        finish(it);
        return;
      }
      if (r.permanent) {
        it.status = 'failed';
        it.reason = r.reason;
        finish(it); // 确定性失败（unknown出版商/无权限/无法解析），重试无意义
        return;
      }
      failedReason = r.reason;
      it.reason = r.reason;
    } catch (e) {
      // downloadOne 约定不抛错；此处兜底防止单篇异常中断 worker
      failedReason = it.reason = (e?.message || String(e)).substring(0, 120);
    }
    if (attempt < maxAttempts) {
      if (!isTty) console.log(`[${doneCount}/${items.length}] ${S.failed} 将重试 ${attempt}/${opts.retries} ${it.doi} 原因: ${failedReason}`.replace(/\s+/g, ' '));
      await sleep(2000);
    }
  }
  it.status = 'failed';
  finish(it);
}

if (pending.length > 0) {
  if (isTty) {
    process.stdout.write('\x1b[?25l');
    render();
    ticker = setInterval(() => scheduleRender(), 1000); // 进行中条目的耗时列每秒跳动
    process.once('SIGINT', () => {
      if (ticker) clearInterval(ticker);
      process.stdout.write('\x1b[?25h');
      process.exit(130);
    });
  }

  // 固定 N 个 worker 从队列取任务；单篇失败不中断批次
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const it = pending[cursor++];
      await runItem(it);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, pending.length) }, worker));

  if (ticker) clearInterval(ticker);
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
  if (isTty) {
    render(); // 末帧定格
    process.stdout.write('\x1b[?25h\n');
  }
}

// 首轮结束后，验证与重试必须发生在同一份持久浏览器资料里。
const firstManualItems = items.filter(it => it.status === 'manual');
if (opts.openManual && firstManualItems.length > 0) {
  if (!process.stdin.isTTY) {
    console.log('需交互终端才能等待官网验证；请在终端运行并加 --open-manual。');
  } else {
    try {
      await openInDownloadBrowser(firstManualItems.map(it => it.resolveUrl || `https://doi.org/${it.doi}`));
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
      const answer = await rl.question('\n请在下载器 Edge 中完成官网验证或机构登录；完成后按 Enter 重试，输入 q 跳过：');
      if (answer.trim().toLowerCase() !== 'q') {
        for (const it of firstManualItems) {
          it.state = 'pending';
          it.status = '';
          it.reason = '';
          doneCount--;
          await runItem(it);
        }
      }
      } finally { rl.close(); }
    } catch (e) {
      console.log(`下载器 Edge 验证窗口未能打开：${e?.message || e}`);
    }
  }
}

// ---------- 汇总 ----------

const okItems = items.filter(it => it.status === 'ok');
const existItems = items.filter(it => it.status === 'exists');
const failedItems = items.filter(it => it.status === 'failed');
const manualItems = items.filter(it => it.status === 'manual');

console.log('');
console.log(`下载完成: 成功 ${okItems.length} / 失败 ${failedItems.length} / 需人工 ${manualItems.length} / 已存在 ${existItems.length} / 共 ${items.length}`);

const failedPath = path.join(outDir, 'failed.txt');
const redoDois = [...failedItems, ...manualItems].map(it => it.doi);
if (redoDois.length > 0) {
  fs.writeFileSync(failedPath, redoDois.join('\n') + '\n');
  console.log(`失败清单（已写入 ${failedPath}，可直接重跑）:`);
  for (const it of failedItems) {
    console.log(`  ${it.doi}  ${it.publisher ? it.publisher.toUpperCase().padEnd(7) : ''} 原因: ${it.reason.replace(/[\r\n]+/g, ' ')}`);
  }
  console.log('需人工（官网验证或机构访问）:');
  for (const it of manualItems) {
    console.log(`  ${it.doi}  → ${it.resolveUrl || `https://doi.org/${it.doi}`}`);
  }
}
else fs.rmSync(failedPath, { force: true });

await closeElsevierSession(); // Elsevier 共享会话引用重置
await closeIopSession(); // IOP 同理
await closeBrowserSession(); // 收持久浏览器窗口（登录态已在 .browser-profile，下次免登）
process.exit(failedItems.length + manualItems.length > 0 ? 1 : 0);
