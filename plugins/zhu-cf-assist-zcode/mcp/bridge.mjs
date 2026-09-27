// zhu-cf-assist-zcode 工具桥：ZCode MCP 工具 ↔ ZhuDownLoader .cf-assist 握手目录。
// 从 dsh-cf-assist/index.js 移植，宿主无关逻辑（轮询/回应校验/发起测试）原样保留；差异：
// - 无 DSH ctx：registerTools(register) 以普通函数注册五个工具，server 负责包成 MCP 响应；
// - 路径懒解析：assistDir()/downloaderRoot() 每次调用时读 env——ZCode 拉起 MCP 的 cwd 不可
//   假设，且不做 import.meta.url 相对猜测（dsh 版 off-by-one 落盘根的教训），env 未配置就明确报错；
// - 规程与提示改用 ZCode 内置 Read 工具读截图（替代 DSH read_image）。
// 下载器侧桥（截图/单次点击/边界校验/运行生命周期）在 ZhuDownLoader lib/cf-assist.mjs，零改动复用。
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { launchBatch } from './launcher.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOI = /^10\.\d{4,9}\/\S+$/i;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const NO_DIR = 'ERROR: 未配置握手目录：需要环境变量 ZHU_CF_ASSIST_DIR 或 ZHU_DOWNLOADER_HOME（.mcp.json 已内置本机默认值）';

function assistDir() {
  if (process.env.ZHU_CF_ASSIST_DIR) return process.env.ZHU_CF_ASSIST_DIR;
  if (process.env.ZHU_DOWNLOADER_HOME) return path.join(process.env.ZHU_DOWNLOADER_HOME, '.cf-assist');
  return null;
}

// 握手目录内 JSON 读取：文件名必须命中白名单（固定状态名或 UUID 派生名），且解析后
// 必须仍落在握手目录内（双保险）。任何一项不满足一律按「文件不存在」处理。
const HANDSHAKE_JSON = /^(?:arm|run)\.json$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:request|answer|result)\.json$/i;

async function readJsonInDir(dir, fileName) {
  if (!HANDSHAKE_JSON.test(fileName)) return null;
  const base = path.resolve(dir);
  const resolved = path.resolve(base, fileName);
  const rel = path.relative(base, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try { return JSON.parse(await fs.readFile(resolved, 'utf8')); }
  catch { return null; }
}

async function armState() {
  const dir = assistDir();
  return dir ? readJsonInDir(dir, 'arm.json') : null;
}
async function runState() {
  const dir = assistDir();
  return dir ? readJsonInDir(dir, 'run.json') : null;
}
function runStatusOf(run) {
  return run?.status === 'ended' || run?.status === 'interrupted' ? run.status : (run?.status || 'unknown');
}

/** 进程存活探测（修复方案步骤5）：process.kill(pid,0) —— ESRCH=不存在，EPERM=存在但无权发信号。 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e?.code === 'EPERM'; }
}

/** 运行是否可拦截：status=running 且 持有进程仍存活 且 启动未满 2h。
 *  pid 已死（或旧格式 run.json 无 pid）→ 视为孤儿，返回 false 由 cf_assist_test 自动清理。 */
function activeRunBlocking(run) {
  if (run?.status !== 'running') return false;
  if (!isPidAlive(run.pid)) return false;
  return Date.now() - (run.startedAt || 0) < 2 * 3600 * 1000;
}

/** 陈旧检测（修复方案步骤5）：running 且进度文件 mtime 距今 >120s → 可能挂起。 */
async function progressStale(run) {
  if (run?.status !== 'running' || !run?.progressFile) return false;
  try {
    const st = await fs.stat(run.progressFile);
    return Date.now() - st.mtimeMs > 120 * 1000;
  } catch { return false; }
}

/** 请求对当前监看会话可见吗？test 发起时 arm.json 记 runId，跨运行请求一律不展示。 */
function visibleToArmed(request, arm) {
  if (arm?.runId && request?.runId && request.runId !== arm.runId) return false;
  return true;
}

async function nextPending(dir, arm) {
  let names;
  try { names = await fs.readdir(dir); }
  catch { return null; }
  for (const name of names.filter(x => x.endsWith('.request.json')).sort()) {
    const id = name.slice(0, -'.request.json'.length);
    if (!UUID.test(id)) continue;
    const request = await readJsonInDir(dir, name);
    if (request?.id !== id || request.expiresAt <= Date.now()) continue;
    if (!visibleToArmed(request, arm)) continue;
    const [finished, submitted] = await Promise.all([
      readJsonInDir(dir, `${id}.result.json`),
      readJsonInDir(dir, `${id}.answer.json`),
    ]);
    if (finished || submitted) continue;
    const image = path.join(dir, `${id}.png`);
    try { await fs.access(image); } catch { continue; }
    let source = 'unknown';
    try { source = new URL(request.url).origin; } catch { /* local request remains usable */ }
    return { id, imagePath: image, width: request.width, height: request.height,
      doi: request.doi, runId: request.runId, expiresAt: request.expiresAt, source };
  }
  return null;
}

const GUIDE_TEXT = `期刊官网下载测试规程（ZCode 会话内一次发起、持续监看）：

1. 与用户确认 DOI 清单后，调用一次 cf_assist_test（参数 dois 数组；已有清单文件先用内置 Read 工具读出行内 DOI 再传入。自动启用图像辅助，默认 60 分钟，并发固定 1，输出到 test-runs/时间戳）。它后台启动 ZhuDownLoader 官网下载并返回 runId 与输出目录。
2. 进入监看循环：反复调用 cf_assist_wait（seconds 建议 10）：
   - status=pending → 立即用内置 Read 工具读取 imagePath（PNG 绝对路径）。只有清楚看见验证勾选框（Cloudflare Turnstile 勾选框本体）才调 cf_assist_respond(action=click, x, y)：坐标以图片左上角为原点、只提交一次。看不清、不是勾选框、是图选/滑块/拼图 → cf_assist_respond(action=skip)，并在最终汇报中把该 DOI 标记为需人工。绝不提交框外坐标，绝不猜测坐标。
   - status=none → 继续循环调用 cf_assist_wait，不需要用户推动。
   - status=run_ended → 监看结束：读取返回中的 summary，向用户汇报成功/失败/需人工计数，停止调用 wait。
3. 失败回退：连续 3 次 Read 读图失败 → 立即停止循环，明确告知用户"图像辅助不可用，请人工过验证"，不要猜坐标。
4. 边界（下载器侧强制）：每个请求至多一次真实点击；只点勾选框本体；请求过期（90 秒）、页面跳转、坐标越界、空白框都会被拒绝或跳过，回应后是否放行以网站结果为准。图选、滑块、OTP 等人工验证绝不自动操作。`;

export function registerTools(register) {
  register({
    name: 'cf_assist_guide',
    description: '返回「期刊官网下载测试」的完整操作规程（发起→等待→读图→提交→循环→结束汇报）。开始测试前调用一次即可。',
    inputSchema: { type: 'object', properties: {} },
    async execute() { return GUIDE_TEXT; },
  });

  register({
    name: 'cf_assist_arm',
    description: '手动启用 Cloudflare 图像辅助（cf_assist_test 会自动启用，通常无需先调用本工具）。仅对当前下载器页面的 Turnstile 框生成截图；有效期到期自动关闭。',
    inputSchema: {
      type: 'object',
      properties: { minutes: { type: 'integer', description: '有效分钟数，1 到 120；默认 30' } },
    },
    async execute(args) {
      const dir = assistDir();
      if (!dir) return NO_DIR;
      const minutes = args.minutes ?? 30;
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) return 'ERROR: minutes 必须为 1 到 120 的整数';
      await fs.mkdir(dir, { recursive: true });
      const expiresAt = Date.now() + minutes * 60000;
      await fs.writeFile(path.join(dir, 'arm.json'), JSON.stringify({ armedAt: Date.now(), expiresAt }, null, 2), 'utf8');
      return JSON.stringify({ status: 'armed', expiresAt, next: '启动下载后调用 cf_assist_wait；收到截图路径后用内置 Read 工具看图，再调用 cf_assist_respond。' });
    },
  });

  register({
    name: 'cf_assist_wait',
    description: '监看循环的一步：等待 ZhuDownLoader 的下一个验证框截图，或等待测试运行结束。status=pending 时必须用内置 Read 工具读取 imagePath，只有看见可点的勾选框才 cf_assist_respond(click)；看不见则 skip。status=run_ended 表示本轮测试已结束，应汇报结果并停止循环。',
    inputSchema: {
      type: 'object',
      properties: { seconds: { type: 'integer', description: '最多等待 0 到 30 秒，默认 15' } },
    },
    async execute(args) {
      const seconds = args.seconds ?? 15;
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 30) return 'ERROR: seconds 必须为 0 到 30 的整数';
      const dir = assistDir();
      if (!dir) return JSON.stringify({ status: 'disarmed', instruction: NO_DIR });
      const arm = await armState();
      if (!arm || arm.expiresAt <= Date.now()) {
        return JSON.stringify({ status: 'disarmed',
          instruction: '图像辅助未启用：调用 cf_assist_arm(minutes) 或改用 cf_assist_test 发起测试。' });
      }
      const run = await runState();
      // 陈旧检测（修复方案步骤5）：进度长时间未更新时立即如实上报，等待循环行为不变
      if (await progressStale(run)) {
        return JSON.stringify({ status: 'none', runStatus: runStatusOf(run), progressStale: true,
          instruction: '进度长时间未更新（>120 秒），可能挂起；建议检查输出目录或停止该运行后重新发起。' });
      }
      const until = Date.now() + seconds * 1000;
      do {
        const pending = await nextPending(dir, arm);
        if (pending) return JSON.stringify({ status: 'pending', runStatus: runStatusOf(run), ...pending,
          instruction: '图片是验证 iframe 的局部截图，坐标以图片左上角为 (0,0)。先用内置 Read 工具读取 imagePath；确认勾选框可见后只提交一次框内坐标。不是勾选框就 skip。' });
        // 监看结束信号：由 cf_assist_test 发起的运行已收尾且无待处理请求 → 模型可停止循环
        if (arm.runId && run && (run.status === 'ended' || run.status === 'interrupted') && run.runId === arm.runId) {
          return JSON.stringify({ status: 'run_ended', runStatus: run.status, runId: run.runId,
            summary: run.summary ?? null, instruction: '本轮测试已结束：汇报 summary（成功/失败/需人工），不再调用 cf_assist_wait。' });
        }
        if (Date.now() >= until) break;
        await wait(500);
      } while (true);
      return JSON.stringify({ status: 'none', runStatus: runStatusOf(run) });
    },
  });

  register({
    name: 'cf_assist_respond',
    description: '对 cf_assist_wait 返回的那张截图提交一次决策。仅当 Read 中清楚看到验证勾选框时 action=click，并提交图片内的 x/y；否则 action=skip（图选/滑块/看不清一律 skip）。每个请求只能提交一次，下载器还会核对时效与框内坐标后才点击。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'cf_assist_wait 返回的请求 ID' },
        action: { type: 'string', enum: ['click', 'skip'] },
        x: { type: 'number', description: 'click 时必填，截图内横坐标' },
        y: { type: 'number', description: 'click 时必填，截图内纵坐标' },
      },
      required: ['id', 'action'],
    },
    async execute(args) {
      const dir = assistDir();
      if (!dir) return NO_DIR;
      const { id, action } = args;
      if (!UUID.test(id || '') || !['click', 'skip'].includes(action)) return 'ERROR: 无效请求';
      const request = await readJsonInDir(dir, `${id}.request.json`);
      if (request?.id !== id || request.expiresAt <= Date.now()) return 'ERROR: 请求不存在或已过期';
      if (await readJsonInDir(dir, `${id}.result.json`)) return 'ERROR: 请求已经完成';
      if (action === 'click' && (!Number.isFinite(args.x) || !Number.isFinite(args.y)
          || args.x < 0 || args.x >= request.width || args.y < 0 || args.y >= request.height)) {
        return 'ERROR: 坐标必须位于截图内';
      }
      try {
        await fs.writeFile(path.join(dir, `${id}.answer.json`),
          JSON.stringify({ action, x: args.x, y: args.y, at: Date.now() }), { flag: 'wx' });
      } catch (error) {
        if (error?.code === 'EEXIST') return 'ERROR: 已提交过一次，不能重复点击';
        throw error;
      }
      return JSON.stringify({ status: 'submitted', id, action, note: '已交给下载器处理；是否通过仍取决于网站验证结果。继续调用 cf_assist_wait。' });
    },
  });

  register({
    name: 'cf_assist_test',
    description: '一次发起「期刊官网下载测试」：写入 DOI 清单、自动启用图像辅助、后台启动 ZhuDownLoader（并发 1，重试 1，输出 test-runs/<时间戳>），立即返回 runId 与输出目录。随后按 cf_assist_guide 的规程循环 cf_assist_wait，直到 status=run_ended。测试 PDF 仅用于核验，不是交付成果。',
    inputSchema: {
      type: 'object',
      properties: {
        dois: { type: 'array', items: { type: 'string' }, description: 'DOI 列表；已有清单文件请先用内置 Read 工具读出行内 DOI 再传入' },
        minutes: { type: 'integer', description: '图像辅助有效分钟数，1 到 120；默认 60' },
      },
    },
    async execute(args) {
      const dir = assistDir();
      if (!dir) return NO_DIR;
      const root = process.env.ZHU_DOWNLOADER_HOME;
      if (!root) return 'ERROR: 未配置 ZhuDownLoader 根目录（环境变量 ZHU_DOWNLOADER_HOME）';
      const entry = path.join(root, 'batch_download.mjs');
      const dois = (args.dois || []).map(s => String(s).trim()).filter(Boolean);
      let bad = '';
      for (const d of dois) { if (!DOI.test(d)) { bad = d; break; } }
      if (bad) return 'ERROR: DOI 格式不合法: ' + bad;
      if (dois.length === 0) return 'ERROR: 需要 dois 数组（每项如 10.1126/scirobotics.adr4264）';
      // 子进程命令行与文件读写只使用程序自己生成的路径：用户数据（DOI）先进数据文件再传。
      await fs.mkdir(dir, { recursive: true });
      const listFile = path.join(dir, `list-${Date.now().toString(36)}.txt`);
      await fs.writeFile(listFile, '', 'utf8');
      for (const d of dois) await fs.appendFile(listFile, `${d}\n`, 'utf8');
      // 上一轮还没收尾就不开新一轮，避免两批请求混在同一监看会话里；
      // pid 已死的「孤儿运行」不再拦截——自动覆盖启动并在返回里说明（修复方案步骤5）
      const prevRun = await runState();
      let orphanNote;
      if (activeRunBlocking(prevRun)) {
        return 'ERROR: 已有运行中的测试（runId ' + (prevRun.runId || '?') + '）。等它结束或删除 run.json 后重试。';
      }
      if (prevRun?.status === 'running') orphanNote = '检测到孤儿运行(已清理)';
      const minutes = args.minutes ?? 60;
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) return 'ERROR: minutes 必须为 1 到 120 的整数';
      const runId = `zcode-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      if (!/^[\d-]+$/.test(stamp)) return 'ERROR: 内部时间戳异常，拒绝生成输出目录';
      const outDir = path.join(root, 'test-runs', stamp);
      try { await fs.access(entry); } catch {
        return 'ERROR: 未找到下载入口 ' + entry + '（可用环境变量 ZHU_DOWNLOADER_HOME 指定 ZhuDownLoader 根目录）';
      }
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(path.join(dir, 'arm.json'),
        JSON.stringify({ armedAt: Date.now(), expiresAt: Date.now() + minutes * 60000, runId }, null, 2), 'utf8');
      const childEnv = { ...process.env, ZHU_CF_ASSIST_RUN_ID: runId, ZHU_CF_ASSIST_DIR: dir };
      // 启动器见 ./launcher.js：参数全部为内部生成路径 + 固定旗标
      await launchBatch(entry, listFile, outDir, childEnv);
      const started = { status: 'started', runId, listFile, outDir,
        progressFile: path.join(outDir, '_download_progress.json'),
        next: '循环调用 cf_assist_wait（seconds 10）：pending → 内置 Read 看 imagePath → respond；run_ended → 汇报 summary 并停止。' };
      if (orphanNote) started.note = orphanNote;
      return JSON.stringify(started);
    },
  });
}
