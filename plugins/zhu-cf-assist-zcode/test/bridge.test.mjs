// zhu-cf-assist-zcode 桥 + 工具的本地单测：从 dsh-cf-assist/test.mjs 逐字移植，仅改
// 导入路径（../mcp/bridge.mjs + 仓库 lib）与 runId 前缀断言（zcode-）。覆盖 有效点击 /
// 越界 / 跳过 / 超时 / 页面变化 / 空白框 / 两个并发待处理请求 / 位置改变补偿 / 框消失 /
// 框尺寸漂移 / 跨运行请求不可见 / run_ended 停止信号 / 重复提交拒绝 / test 发起→run_ended 全链。
// 运行: node plugins/zhu-cf-assist-zcode/test/bridge.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhu-cf-assist-zcode-test-'));
process.env.ZHU_CF_ASSIST_DIR = dir;
process.env.ZHU_CF_ASSIST_MAX_WAIT_MS = '3000';
process.env.ZHU_CF_ASSIST_BLANK_MIN_BYTES = '1024';

const REAL_PNG = Buffer.alloc(2048, 7);   // 非空白尺寸（>阈值）
const BLANK_PNG = Buffer.alloc(64, 7);    // 空白帧（<阈值）

// state 是可变测试状态；makePage 绑定它生成桥需要的 page 方法，url/box/blank 的变动实时生效
function makePage(state) {
  return {
    locator: selector => ({
      count: async () => (selector.includes('hcaptcha.com') ? (state.hcaptcha ? 1 : 0) : 1),
      first: () => ({ boundingBox: async () => state.box ?? null }),
    }),
    viewportSize: () => ({ width: 1200, height: 800 }),
    url: () => state.url,
    isClosed: () => Boolean(state.closed),
    screenshot: async ({ path: dest }) => { await fs.writeFile(dest, state.blank ? BLANK_PNG : REAL_PNG); },
    mouse: { click: async (x, y) => { state.clicks.push([x, y]); } },
  };
}

function fakePageState(url = 'https://example.org/doi/10.1002/adma.74847') {
  return { url, box: { x: 50, y: 100, width: 300, height: 65 }, clicks: [] };
}

/** 等到 wait 工具报出 pending（或次数用尽） */
async function awaitPending(tools) {
  for (let i = 0; i < 30; i++) {
    const r = JSON.parse(await tools.get('cf_assist_wait').execute({ seconds: 0 }));
    if (r.status === 'pending') return r;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  return null;
}

const results = [];
function record(name, fn) { results.push({ name, fn }); }

try {
  const { registerTools } = await import('../mcp/bridge.mjs');
  const { requestCfVisionClick, cfAssistRunBegin, cfAssistRunEndSync } = await import('../../../lib/cf-assist.mjs');
  const tools = new Map();
  registerTools(def => { tools.set(def.name, def); });

  record('工具清单（5 个）', async () => {
    assert.deepEqual([...tools.keys()],
      ['cf_assist_guide', 'cf_assist_arm', 'cf_assist_wait', 'cf_assist_respond', 'cf_assist_test']);
    const guide = await tools.get('cf_assist_guide').execute({});
    assert.ok(guide.includes('cf_assist_wait') && guide.includes('run_ended'), '规程文本应包含循环与结束信号');
  });

  record('未启用时 wait 返回 disarmed', async () => {
    const r = JSON.parse(await tools.get('cf_assist_wait').execute({ seconds: 0 }));
    assert.equal(r.status, 'disarmed');
  });

  record('有效点击：一次真实点击 + result=clicked', async () => {
    await tools.get('cf_assist_arm').execute({ minutes: 1 });
    const state = fakePageState();
    const pendingPromise = requestCfVisionClick(makePage(state));
    const pending = await awaitPending(tools);
    assert.ok(pending, '必须出现 pending');
    assert.equal(pending.width, 300); assert.equal(pending.height, 65);
    assert.equal(pending.doi, '10.1002/adma.74847', '请求应带 DOI 提示');
    const submitted = JSON.parse(await tools.get('cf_assist_respond').execute({ id: pending.id, action: 'click', x: 24, y: 32 }));
    assert.equal(submitted.status, 'submitted');
    assert.equal((await pendingPromise).clicked, true);
    assert.deepEqual(state.clicks, [[74, 132]], '点击坐标 = 框原点 + 模型坐标');
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, `${pending.id}.result.json`), 'utf8')).status, 'clicked');
  });

  record('重复提交被拒绝（每请求至多一次回应）', async () => {
    const state = fakePageState();
    const pendingPromise = requestCfVisionClick(makePage(state));
    const pending = await awaitPending(tools);
    await tools.get('cf_assist_respond').execute({ id: pending.id, action: 'skip' });
    const again = await tools.get('cf_assist_respond').execute({ id: pending.id, action: 'click', x: 1, y: 1 });
    assert.match(String(again), /已提交过一次/);
    assert.equal((await pendingPromise).clicked, false);
  });

  record('越界坐标：工具拒绝，不落 answer，不点击', async () => {
    const state = fakePageState();
    const pendingPromise = requestCfVisionClick(makePage(state));
    const pending = await awaitPending(tools);
    const r = await tools.get('cf_assist_respond').execute({ id: pending.id, action: 'click', x: 9999, y: 0 });
    assert.match(String(r), /坐标必须位于截图内/);
    await assert.rejects(fs.access(path.join(dir, `${pending.id}.answer.json`)), '越界回应不得写入 answer');
    assert.equal((await pendingPromise).clicked, false, '无有效回应的请求最终过期收场');
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, `${pending.id}.result.json`), 'utf8')).status, 'expired');
    assert.deepEqual(state.clicks, []);
  });

  record('跳过：绝不点击', async () => {
    const state = fakePageState();
    const pendingPromise = requestCfVisionClick(makePage(state));
    const pending = await awaitPending(tools);
    await tools.get('cf_assist_respond').execute({ id: pending.id, action: 'skip' });
    assert.equal((await pendingPromise).clicked, false);
    assert.deepEqual(state.clicks, []);
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, `${pending.id}.result.json`), 'utf8')).status, 'skipped');
  });

  record('超时：到期记录 expired，不点击', async () => {
    const state = fakePageState();
    const pendingPromise = requestCfVisionClick(makePage(state));
    const pending = await awaitPending(tools);
    assert.ok(pending, '请求应先可见再超时');
    const started = Date.now();
    const r = await pendingPromise;
    assert.equal(r.clicked, false);
    assert.ok(Date.now() - started >= 2500, '应等到 MAX_WAIT 才收场');
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, `${pending.id}.result.json`), 'utf8')).status, 'expired');
  });

  record('页面跳转：等待途中 URL 变化 → page-changed，不点击', async () => {
    const state = fakePageState();
    const pendingPromise = requestCfVisionClick(makePage(state));
    const pending = await awaitPending(tools);
    state.url = 'https://example.org/after-redirect';
    const r = await pendingPromise;
    assert.equal(r.clicked, false);
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, `${pending.id}.result.json`), 'utf8')).status, 'page-changed');
  });

  record('回应时页面已跳转：page-changed，不点击', async () => {
    const state = fakePageState();
    const pendingPromise = requestCfVisionClick(makePage(state));
    const pending = await awaitPending(tools);
    state.url = 'https://example.org/moved-on';
    await tools.get('cf_assist_respond').execute({ id: pending.id, action: 'click', x: 10, y: 10 });
    const r = await pendingPromise;
    assert.equal(r.clicked, false);
    assert.deepEqual(state.clicks, []);
  });

  record('空白框：不创建请求、不打扰模型', async () => {
    const before = (await fs.readdir(dir)).filter(n => n.endsWith('.request.json')).length;
    const state = fakePageState();
    state.blank = true;
    const r = await requestCfVisionClick(makePage(state));
    assert.equal(r.clicked, false);
    const after = (await fs.readdir(dir)).filter(n => n.endsWith('.request.json')).length;
    assert.equal(after, before, '空白帧不得生成请求');
    assert.deepEqual(state.clicks, []);
  });

  record('两个并发待处理请求：逐一可见、互不串扰、各自一次点击', async () => {
    const s1 = fakePageState('https://example.org/doi/10.1002/advs.77451');
    const s2 = fakePageState('https://example.org/doi/10.1073/pnas.2314359121');
    const p1 = requestCfVisionClick(makePage(s1));
    const p2 = requestCfVisionClick(makePage(s2));
    // 工具按设计一次只展示一个待处理请求；处理完第一个才可见第二个
    const coord = { '10.1002/advs.77451': [20, 30], '10.1073/pnas.2314359121': [25, 35] };
    const first = await awaitPending(tools);
    assert.ok(first, '第一个请求可见');
    const [fx, fy] = coord[first.doi];
    await tools.get('cf_assist_respond').execute({ id: first.id, action: 'click', x: fx, y: fy });
    const second = await awaitPending(tools);
    assert.ok(second && second.id !== first.id, '第二个请求随后可见且不同');
    const [sx, sy] = coord[second.doi];
    await tools.get('cf_assist_respond').execute({ id: second.id, action: 'click', x: sx, y: sy });
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.deepEqual([r1.clicked, r2.clicked], [true, true]);
    assert.deepEqual(s1.clicks, [[70, 130]]);
    assert.deepEqual(s2.clicks, [[75, 135]]);
  });

  record('位置改变：点击按新框原点补偿，仍落在框内', async () => {
    const state = fakePageState();
    const pendingPromise = requestCfVisionClick(makePage(state));
    const pending = await awaitPending(tools);
    state.box = { x: 170, y: 140, width: 300, height: 65 }; // 截图之后页面回流，框移动
    await tools.get('cf_assist_respond').execute({ id: pending.id, action: 'click', x: 24, y: 32 });
    const r = await pendingPromise;
    assert.equal(r.clicked, true);
    assert.deepEqual(state.clicks, [[194, 172]], '新原点 + 模型坐标');
  });

  record('框消失：box-gone，不点击', async () => {
    const state = fakePageState();
    const pendingPromise = requestCfVisionClick(makePage(state));
    const pending = await awaitPending(tools);
    state.box = null;
    await tools.get('cf_assist_respond').execute({ id: pending.id, action: 'click', x: 10, y: 10 });
    const r = await pendingPromise;
    assert.equal(r.clicked, false);
    assert.deepEqual(state.clicks, []);
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, `${pending.id}.result.json`), 'utf8')).status, 'box-gone');
  });

  record('框尺寸漂移：box-resized 拒绝点击', async () => {
    const state = fakePageState();
    const pendingPromise = requestCfVisionClick(makePage(state));
    const pending = await awaitPending(tools);
    state.box = { x: 50, y: 100, width: 420, height: 90 };
    await tools.get('cf_assist_respond').execute({ id: pending.id, action: 'click', x: 10, y: 10 });
    const r = await pendingPromise;
    assert.equal(r.clicked, false);
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, `${pending.id}.result.json`), 'utf8')).status, 'box-resized');
  });

  record('跨运行请求不可见 + run_ended 停止信号', async () => {
    // 模拟 cf_assist_test 的启动形态：arm.json 带 runId R2
    await fs.writeFile(path.join(dir, 'arm.json'),
      JSON.stringify({ armedAt: Date.now(), expiresAt: Date.now() + 60000, runId: 'R2' }), 'utf8');
    // 旧运行 R1 的请求：对 R2 监看不可见
    cfAssistRunBegin({ runId: 'R1' });
    const stalePromise = requestCfVisionClick(makePage(fakePageState()));
    assert.equal(await awaitPending(tools), null, 'R1 请求对 R2 监看不可见');
    cfAssistRunEndSync({ interrupted: true }); // R1 结束（runId R1 ≠ arm R2）
    assert.equal(JSON.parse(await tools.get('cf_assist_wait').execute({ seconds: 0 })).status, 'none',
      '别的运行的结束不算本监看的 run_ended');
    // 当前运行 R2 的请求：可见；R2 收尾 → run_ended + summary
    cfAssistRunBegin({ runId: 'R2' });
    const p = requestCfVisionClick(makePage(fakePageState()));
    const pending = await awaitPending(tools);
    assert.ok(pending, 'R2 请求对 R2 监看可见');
    await tools.get('cf_assist_respond').execute({ id: pending.id, action: 'skip' });
    await p;
    cfAssistRunEndSync({ summary: { ok: 1, failed: 0, manual: 0, exists: 0 } });
    const ended = JSON.parse(await tools.get('cf_assist_wait').execute({ seconds: 0 }));
    assert.equal(ended.status, 'run_ended');
    assert.equal(ended.summary?.ok, 1);
  });

  record('孤儿运行自动清理：running+死pid → test 放行并带清理 note（修复方案步骤5）', async () => {
    // 找一个确实不存在的 pid（process.kill 探测 ESRCH）
    let deadPid = 0;
    for (let p = 9999; p < 99999 && !deadPid; p += 3) {
      try { process.kill(p, 0); } catch (e) { if (e?.code === 'ESRCH') deadPid = p; }
    }
    assert.ok(deadPid, '应能找到死 pid');
    // ZCode 桥先查 ZHU_DOWNLOADER_HOME 再查运行状态；孤儿放行会真的走到启动，须给假入口
    const stubRoot = path.join(dir, 'stub-root');
    await fs.mkdir(stubRoot, { recursive: true });
    await fs.writeFile(path.join(stubRoot, 'batch_download.mjs'), 'process.exit(0);\n', 'utf8');
    process.env.ZHU_DOWNLOADER_HOME = stubRoot;
    await fs.writeFile(path.join(dir, 'arm.json'),
      JSON.stringify({ armedAt: Date.now(), expiresAt: Date.now() + 60000, runId: 'new-run' }), 'utf8');
    await fs.writeFile(path.join(dir, 'run.json'),
      JSON.stringify({ status: 'running', runId: 'orphan-old', startedAt: Date.now() - 60 * 1000, pid: deadPid }), 'utf8');
    const r = JSON.parse(await tools.get('cf_assist_test').execute({
      dois: ['10.1126/scirobotics.adr4264'], minutes: 5 }));
    assert.equal(r.status, 'started', '孤儿运行不得拒绝新一轮测试');
    assert.equal(r.note, '检测到孤儿运行(已清理)');
    delete process.env.ZHU_DOWNLOADER_HOME;
    await fs.rm(path.join(dir, 'arm.json'), { force: true });
    await fs.rm(path.join(dir, 'run.json'), { force: true });
  });

  record('运行中守卫：running+存活 pid → 仍拒绝（修复方案步骤5）', async () => {
    process.env.ZHU_DOWNLOADER_HOME = path.join(dir, 'no-entry-root');
    await fs.writeFile(path.join(dir, 'run.json'),
      JSON.stringify({ status: 'running', runId: 'live-run', startedAt: Date.now(), pid: process.pid }), 'utf8');
    const r = await tools.get('cf_assist_test').execute({ dois: ['10.1126/scirobotics.adr4264'] });
    assert.match(String(r), /已有运行中的测试/, '守卫必须先于入口检查拒绝');
    delete process.env.ZHU_DOWNLOADER_HOME;
    await fs.rm(path.join(dir, 'run.json'), { force: true });
  });

  record('wait 陈旧检测：进度 mtime >120s → progressStale（修复方案步骤5）', async () => {
    await fs.writeFile(path.join(dir, 'arm.json'),
      JSON.stringify({ armedAt: Date.now(), expiresAt: Date.now() + 60000, runId: 'stale-run' }), 'utf8');
    const progressFile = path.join(dir, 'fake-progress.json');
    await fs.writeFile(progressFile, '{"ok":true}', 'utf8');
    const old = new Date(Date.now() - 5 * 60 * 1000);
    await fs.utimes(progressFile, old, old);
    await fs.writeFile(path.join(dir, 'run.json'),
      JSON.stringify({ status: 'running', runId: 'stale-run', startedAt: Date.now(), pid: process.pid,
        progressFile }), 'utf8');
    const r = JSON.parse(await tools.get('cf_assist_wait').execute({ seconds: 0 }));
    assert.equal(r.status, 'none');
    assert.equal(r.progressStale, true, '陈旧进度必须如实上报');
    assert.match(r.instruction, /挂起/);
    // 对照：进度刚更新过 → 不报陈旧
    await fs.utimes(progressFile, new Date(), new Date());
    const fresh = JSON.parse(await tools.get('cf_assist_wait').execute({ seconds: 0 }));
    assert.equal(fresh.progressStale, undefined, '新鲜进度不得误报');
    await fs.rm(path.join(dir, 'arm.json'), { force: true });
    await fs.rm(path.join(dir, 'run.json'), { force: true });
  });

  record('cf_assist_test 校验与发起→run_ended 全链（假下载入口）', async () => {
    const fakeRoot = path.join(dir, 'fake-root');
    await fs.mkdir(fakeRoot, { recursive: true });
    await fs.writeFile(path.join(fakeRoot, 'batch_download.mjs'), `
import { cfAssistRunBegin, cfAssistRunEndSync } from ${JSON.stringify(pathToFileURL(path.join(REPO, 'lib', 'cf-assist.mjs')).href)};
if (!process.env.ZHU_CF_ASSIST_RUN_ID) { console.error('missing run id'); process.exit(2); }
cfAssistRunBegin({ runId: process.env.ZHU_CF_ASSIST_RUN_ID, label: 'fake-batch', total: 1 });
setTimeout(() => { cfAssistRunEndSync({ summary: { ok: 1, failed: 0, manual: 0, exists: 0 } }); process.exit(0); }, 800);
`, 'utf8');
    process.env.ZHU_DOWNLOADER_HOME = fakeRoot;
    // 先清理上一用例的 arm/run 状态
    await fs.rm(path.join(dir, 'arm.json'), { force: true });
    await fs.rm(path.join(dir, 'run.json'), { force: true });
    const bad = await tools.get('cf_assist_test').execute({ dois: ['not-a-doi'] });
    assert.match(String(bad), /DOI 格式不合法/);
    const empty = await tools.get('cf_assist_test').execute({ dois: [] });
    assert.match(String(empty), /需要 dois/);
    const started = JSON.parse(await tools.get('cf_assist_test').execute({
      dois: ['10.1126/scirobotics.adr4264'], minutes: 5 }));
    assert.equal(started.status, 'started');
    assert.ok(started.runId.startsWith('zcode-'), 'runId 前缀 zcode-');
    assert.ok(started.outDir.includes(path.join('fake-root', 'test-runs')), '输出目录固定在内部 test-runs 下');
    let final = null;
    for (let i = 0; i < 60; i++) {
      const r = JSON.parse(await tools.get('cf_assist_wait').execute({ seconds: 1 }));
      if (r.status === 'run_ended') { final = r; break; }
      assert.ok(['none', 'pending'].includes(r.status), '循环中只应出现 none/pending');
    }
    assert.ok(final, '必须收到 run_ended');
    assert.equal(final.runStatus, 'ended');
    assert.equal(final.summary?.ok, 1);
    delete process.env.ZHU_DOWNLOADER_HOME;
  });

  let failed = 0;
  for (const { name, fn } of results) {
    try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
    catch (e) { failed++; process.stdout.write(`FAIL  ${name}\n      ${e?.stack || e}\n`); }
  }
  process.stdout.write(`\nzhu-cf-assist-zcode 桥单测: ${results.length - failed}/${results.length} 通过\n`);
  if (failed > 0) process.exitCode = 1;
} finally {
  const resolved = path.resolve(dir);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('zhu-cf-assist-zcode-test-')) {
    fss.rmSync(resolved, { recursive: true, force: true });
  }
}
