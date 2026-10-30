// DSH 图像辅助桥（下载器侧）：截取当前 Turnstile 框 → 写请求 → 等 DSH 模型回应 → 至多一次框内点击。
// 边界（施工计划步骤4）：请求绑定运行编号/DOI提示/页面URL/框矩形；回应时重验页面未跳转、
// 框仍在（尺寸漂移>1px 拒绝、位移按新框原点补偿）；坐标越界、重复提交、过期、空白帧一律不点击。
// hCaptcha 不走本桥（保留 tryClickRobotCheckbox 的 DOM 路径）。
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIR = fileURLToPath(new URL('../.cf-assist/', import.meta.url));
const ASSIST_DIR = process.env.ZHU_CF_ASSIST_DIR || DEFAULT_DIR;
const MAX_WAIT_MS = clampWaitMs(Number(process.env.ZHU_CF_ASSIST_MAX_WAIT_MS));
const BLANK_PNG_MIN_BYTES = clampBytes(Number(process.env.ZHU_CF_ASSIST_BLANK_MIN_BYTES)); // 均色空白截图（整帧同色 PNG）约几百字节；真实勾选框带文案图形 >1KB
const CHALLENGE_FRAME = 'iframe[src*="challenges.cloudflare.com"]';
const CF_FRAME_URL = /challenges\.cloudflare\.com/;
const DOI_HINT = /10\.\d{4,9}\/[^\s"'?#<>]+/i;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 饱和渲染器上单次 CDP 探测（count/boundingBox/evaluate）可阻塞数十秒（0927 实测 10 次
// boundingBox 循环 ≈ 6min，ACS/SD 停滞主因）：探测一律有界化——超时取哨兵值（视为
// 不存在/拿不到），把机会让给后续轮询/人工路径，绝不在探测里干等。
const bounded = (promise, ms, fallback) => Promise.race([promise, sleep(ms).then(() => fallback)]);

function clampWaitMs(v) {
  if (!Number.isFinite(v)) return 90000;
  return Math.min(180000, Math.max(5000, v));
}

function clampBytes(v) {
  if (!Number.isFinite(v)) return 1024;
  return Math.min(64 * 1024, Math.max(0, v));
}

// ---------- 运行生命周期（batch_download / pw_download 在进程首尾写入） ----------
// run.json 是插件「监看到运行结束」的契约：status=running 期间 wait 正常轮询；
// ended/interrupted 且无待处理请求时 wait 返回 run_ended，模型据此停止循环。

let activeRunId = process.env.ZHU_CF_ASSIST_RUN_ID || '';

/** 绑定当前运行编号；此后每个视觉请求都带该 runId（跨运行请求对插件不可见）。 */
export function setCfAssistRun(runId) {
  if (typeof runId === 'string' && runId) activeRunId = runId;
}

function runStatePath() { return path.join(ASSIST_DIR, 'run.json'); }

function writeRunStateSync(state) {
  try {
    fss.mkdirSync(ASSIST_DIR, { recursive: true });
    const temp = `${runStatePath()}.${process.pid}.tmp`;
    fss.writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
    fss.renameSync(temp, runStatePath());
  } catch { /* 事件记录不可用时不阻断下载 */ }
}

/** 运行开始（修复方案步骤5）：run.json 记 pid 与进度文件路径。
 *  pid 供插件侧探测孤儿运行（下载器进程已死则 run.json 可自动清理）；
 *  progressFile 供 cf_assist_wait 做陈旧检测（进度 mtime >120s → progressStale）。 */
export function cfAssistRunBegin({ runId, label = '', total = 0, progressFile = '' } = {}) {
  if (runId) activeRunId = runId;
  disarmedSeen.clear(); // 新运行重置 disarmed 去重（同 origin 每 run 只记首条）
  writeRunStateSync({ status: 'running', runId: activeRunId, label, total,
    progressFile: progressFile || undefined, pid: process.pid, startedAt: Date.now() });
  return activeRunId;
}

/** 运行收尾（同步写：允许在 process exit 回调里调用）。 */
export function cfAssistRunEndSync({ interrupted = false, summary = null } = {}) {
  writeRunStateSync({
    status: interrupted ? 'interrupted' : 'ended',
    runId: activeRunId,
    endedAt: Date.now(),
    ...(summary ? { summary } : {}),
  });
}

// ---------- 事件记录（events.jsonl，一行一事件；含 DOI 提示与运行编号可回溯） ----------

let eventChain = Promise.resolve();

// vision-gate-disarmed 去重（修复方案步骤1）：非 armed 是日常运行常态，requestCfVisionClick
// 每篇每质询点都会走到门槛1，事件按「运行编号+页面 origin」只记首条，避免 events.jsonl 被同质行刷屏。
const disarmedSeen = new Set();

function doiHintOf(url) {
  const m = DOI_HINT.exec(url || '');
  return m ? m[0].replace(/[.,;]+$/, '') : '';
}

/** 日志只留域名与路径：查询串可能含 CF 令牌（__cf_chl_rt_tk 等），一律去掉（施工计划脱敏要求）。
 *  下载器写 manual-evidence 等自定义字段时也必须经本函数脱敏后再入 events。 */
export function redactUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url).split('?')[0];
  }
}

/** 追加一条事件；page 可为空（此时无 DOI 提示）。失败静默（记录不是主流程）。 */
export function cfAssistEvent(page, kind, extra = {}) {
  const rawUrl = typeof page === 'string' ? page : (() => { try { return page?.url?.() || ''; } catch { return ''; } })();
  const url = redactUrl(rawUrl);
  const line = JSON.stringify({ at: Date.now(), kind, runId: activeRunId || undefined,
    doi: doiHintOf(rawUrl) || undefined, url: url || undefined, ...extra });
  eventChain = eventChain.then(() =>
    fs.appendFile(path.join(ASSIST_DIR, 'events.jsonl'), line + '\n', 'utf8')
  ).catch(() => {});
  return eventChain;
}

// ---------- 请求/回应握手 ----------

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return null; }
}

async function saveJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temp, file);
}

async function isArmed() {
  const arm = await readJson(path.join(ASSIST_DIR, 'arm.json'));
  return Number.isFinite(arm?.expiresAt) && arm.expiresAt > Date.now();
}

/**
 * 取当前 Turnstile 质询框矩形（challengeBoxReady / revalidateFrame 共用的单次探测内核）。
 * 路径B（帧枚举）先行：page.frames() 按 frame 目标枚举 + frameElement() 原生反查宿主元素。
 * 实战 0927 实证：ScienceDirect 的 Turnstile 控件挂在 shadow root 里，iframe 元素对顶层
 * locator/querySelectorAll 完全不可见（顶层 querySelectorAll('iframe') 返回空），但 frame
 * 目标可见、frameElement() 可穿透 shadow DOM——t+2s 即取到 300×65 矩形。帧不存在时本路
 * 几乎零耗时。路径A（顶层 locator 直查）兜底常规嵌入（元素缺失时自动等待，有 4s 竞速封顶）。
 * 两路都拿不到返回 null。调用方负责 ≥35×20 的就绪判定与重试间隔。
 */
async function cfChallengeBox(page) {
  const frames = typeof page.frames === 'function' ? page.frames() : [];
  for (const f of frames) {
    let url = '';
    try { url = f.url(); } catch { continue; }
    if (!CF_FRAME_URL.test(url)) continue;
    const el = await bounded(f.frameElement().catch(() => null), 4000, null);
    if (!el) continue;
    const box = await bounded(el.boundingBox().catch(() => null), 4000, null);
    if (box) return box;
  }
  return await bounded(page.locator(CHALLENGE_FRAME).first().boundingBox().catch(() => null), 4000, null);
}

/**
 * 共享探测原语（修复方案步骤2）：有界确认 challenges.cloudflare.com 质询框是否已挂载到可点尺寸
 * （≥35×20px）。每次探测 4s 竞速（饱和渲染器上单次 boundingBox 可阻塞数十秒，超时视为本次拿不到），
 * 探测间 500ms 间隔；默认 10 次（与 requestCfVisionClick 门槛3一致，最坏 ~45s）。
 * 重探场景传 {attempts:1} 做单次快探，不吃等待窗口。
 * 返回 { ready, box }：box 为就绪矩形或最后一次观测到的矩形（null=从未挂载），
 * 供门槛遥测区分「框未挂载」（vision-gate-box-missing）与「挂载但过小」（vision-gate-box-too-small）。
 */
export async function challengeBoxReady(page, { attempts = 10, intervalMs = 500 } = {}) {
  let box = null;
  for (let i = 0; i < attempts; i++) {
    box = await cfChallengeBox(page);
    if (box && box.width >= 35 && box.height >= 20) return { ready: true, box };
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return { ready: false, box };
}

/** 视觉模型回报后重验框：返回 null 表示可以点击，否则返回结果状态字符串。
 *  框矩形取自 cfChallengeBox（帧枚举路径可穿透 shadow root，与出图时同源，避免误判 box-gone）。 */
async function revalidateFrame(page, request) {
  const box = await cfChallengeBox(page);
  if (!box) return 'box-gone';
  // 尺寸漂移说明截图与当前框已不是同一布局，模型坐标不可信；位移只影响原点，可补偿。
  // 比较对象是请求时记录的原始 iframe 矩形（request.box），不是被视口裁剪后的截图尺寸。
  if (Math.abs(box.width - request.box.width) > 1 || Math.abs(box.height - request.box.height) > 1) return 'box-resized';
  const dx = box.x - request.box.x, dy = box.y - request.box.y;
  if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) cfAssistEvent(page, 'frame-moved', { id: request.id, dx, dy });
  request._origin = { x: box.x, y: box.y };
  return null;
}

/** Ask the DSH vision agent for one click inside the visible Turnstile iframe.
 *  各门槛出口带 vision-gate-* 遥测（修复方案步骤1）：实战后可直接从 events.jsonl 读出卡在哪道。 */
export async function requestCfVisionClick(page) {
  if (!(await isArmed())) {
    // 门槛1（armed 未过）：按 run+origin 去重，只记首条
    let origin = '';
    try { origin = new URL(page.url()).origin; } catch { /* 页面已关闭等：origin 记空串 */ }
    const key = `${activeRunId}|${origin}`;
    if (!disarmedSeen.has(key)) {
      disarmedSeen.add(key);
      await cfAssistEvent(page, 'vision-gate-disarmed');
    }
    return { enabled: false, clicked: false };
  }

  // hCaptcha keeps the existing DOM/coordinate path; this bridge only handles Turnstile.
  // 超时视为 0（无法确认就继续试 Turnstile 路径）
  if (await bounded(page.locator('iframe[src*="hcaptcha.com"]').count().catch(() => 0), 4000, 0)) {
    await cfAssistEvent(page, 'vision-gate-hcaptcha');
    return { enabled: false, clicked: false };
  }
  // 门槛3（框就绪）：逻辑抽入共享原语 challengeBoxReady（修复方案步骤2），语义与原 10 轮探测一致
  const probed = await challengeBoxReady(page);
  if (!probed.ready && !probed.box) {
    await cfAssistEvent(page, 'vision-gate-box-missing', { attempts: 10 });
    return { enabled: false, clicked: false };
  }
  if (!probed.ready) {
    await cfAssistEvent(page, 'vision-gate-box-too-small', { box: probed.box });
    return { enabled: true, clicked: false };
  }
  const box = probed.box;
  // viewportSize() 是同步属性不阻塞；evaluate 兜底超时用常见默认视口，裁剪略有偏差好过干等
  const size = page.viewportSize() || await bounded(
    page.evaluate(() => ({ width: innerWidth, height: innerHeight })), 4000, { width: 1280, height: 720 });
  const clip = {
    x: Math.max(0, box.x), y: Math.max(0, box.y),
    width: Math.min(box.x + box.width, size.width) - Math.max(0, box.x),
    height: Math.min(box.y + box.height, size.height) - Math.max(0, box.y),
  };
  if (clip.width < 35 || clip.height < 20) {
    await cfAssistEvent(page, 'vision-gate-box-too-small', { which: 'clip', clip });
    return { enabled: true, clicked: false };
  }

  const id = randomUUID();
  const png = path.join(ASSIST_DIR, `${id}.png`);
  const requestFile = path.join(ASSIST_DIR, `${id}.request.json`);
  const answerFile = path.join(ASSIST_DIR, `${id}.answer.json`);
  const resultFile = path.join(ASSIST_DIR, `${id}.result.json`);
  const url = page.url();
  const expiresAt = Date.now() + MAX_WAIT_MS;
  await fs.mkdir(ASSIST_DIR, { recursive: true });
  try {
    // CSS pixels make the model's image coordinates match page.mouse.click coordinates.
    await page.screenshot({ path: png, clip, scale: 'css', timeout: 10000 });
    // 空白帧：整帧同色的 PNG 压不出体积，不值得打扰模型（步骤4：空白 iframe 明确跳过）。
    let pngBytes = 0;
    try { pngBytes = (await fs.stat(png)).size; } catch { /* 下一行兜底 */ }
    if (pngBytes < BLANK_PNG_MIN_BYTES) {
      await cfAssistEvent(page, 'vision-gate-blank', { id, bytes: pngBytes, clip });
      return { enabled: true, clicked: false };
    }
    const request = { id, image: png, url, width: clip.width, height: clip.height,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      doi: doiHintOf(url) || undefined, runId: activeRunId || undefined,
      createdAt: Date.now(), expiresAt };
    await saveJson(requestFile, request);
    await cfAssistEvent(page, 'vision-gate-request-created', { id, width: clip.width, height: clip.height, clip });

    const finish = async (status, extra = {}) => {
      await saveJson(resultFile, { id, status, at: Date.now(), ...extra }).catch(() => {});
      await cfAssistEvent(page, `result-${status}`, { id, ...extra });
    };

    while (Date.now() < expiresAt && !page.isClosed()) {
      const answer = await readJson(answerFile);
      if (answer) {
        if (answer.action === 'skip') { await finish('skipped'); return { enabled: true, clicked: false }; }
        if (page.url() !== url) { await finish('page-changed'); return { enabled: true, clicked: false }; }
        const bad = await revalidateFrame(page, request);
        if (bad) { await finish(bad); return { enabled: true, clicked: false }; }
        const x = Number(answer.x), y = Number(answer.y);
        const origin = request._origin;
        const px = origin.x + x, py = origin.y + y;
        if (answer.action !== 'click' || !Number.isFinite(x) || !Number.isFinite(y)
            || x < 0 || x >= clip.width || y < 0 || y >= clip.height
            || px < 0 || py < 0 || px >= size.width || py >= size.height) {
          await finish('rejected', { action: answer.action, x, y });
          return { enabled: true, clicked: false };
        }
        await page.mouse.click(px, py); // 每个请求至多一次真实点击（answer 以 wx 落盘，不二投）
        await finish('clicked', { x: px, y: py, modelX: x, modelY: y });
        return { enabled: true, clicked: true };
      }
      if (page.url() !== url) { await finish('page-changed'); return { enabled: true, clicked: false }; }
      await sleep(500);
    }
    await finish(page.isClosed() || page.url() !== url ? 'page-changed' : 'expired');
    return { enabled: true, clicked: false };
  } catch (error) {
    await saveJson(resultFile, { id, status: 'error', message: String(error?.message || error), at: Date.now() }).catch(() => {});
    await cfAssistEvent(page, 'result-error', { id, message: String(error?.message || error) }).catch(() => {});
    return { enabled: true, clicked: false };
  }
}
