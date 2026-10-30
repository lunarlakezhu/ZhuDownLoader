// 批次运行器 — batch_download.mjs 编排语义的类封装，供 webui/server.mjs 驱动。
// 与 CLI 编排器保持同一套语义：已存在跳过（%PDF- 校验）、失败重试（「需人工」不重试）、
// 固定 N 个 worker 从队列取任务、单篇失败不中断批次、结束时写 failed.txt。
// 不做任何 console 输出：状态变化经 onEvent 回调上报，供 SSE 广播与测试断言。
import fs from 'fs';
import path from 'path';
import { downloadOne, existingPdf, appendLog, closeElsevierSession, closeIopSession, closeBrowserSession } from '../lib/downloader.mjs';
import { parseList } from '../lib/listparse.mjs';
import { writeDownloadProgress } from '../lib/progress.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @callback DownloadFn
 * @param {string} doi
 * @param {string} outDir
 * @param {{onPhase?: (phase: string, info?: object) => void, openManual?: boolean}} [opts]
 * @returns {Promise<{doi: string, publisher: string, status: 'ok'|'failed'|'manual-required', path?: string, bytes?: number, durationMs?: number, reason?: string, resolveUrl?: string}>}
 */

/**
 * @callback EventFn
 * @param {{type: 'start', meta: object, items: object[]} | {type: 'item', item: object} | {type: 'done', summary: object}} event
 */

export class BatchRunner {
  /** @type {EventFn} */
  #onEvent;
  /** @type {DownloadFn} */
  #downloadFn;
  #existingFn;
  #running = false;
  #aborted = false;
  /** @type {{state: 'idle'|'running'|'finished', meta?: object, items: object[], summary?: object}} */
  #state = { state: 'idle', items: [] };

  constructor({ onEvent = () => {}, downloadFn = downloadOne, existingFn = existingPdf } = {}) {
    this.#onEvent = onEvent;
    this.#downloadFn = downloadFn;
    this.#existingFn = existingFn;
  }

  get isRunning() { return this.#running; }

  /** 断线重连/页面刷新时恢复现场用的完整快照；item 字段直接进 SSE JSON，勿加大对象。 */
  get snapshot() {
    return {
      state: this.#state.state,
      meta: this.#state.meta ?? null,
      items: this.#state.items.map(it => ({ ...it })),
      summary: this.#state.summary ?? null,
    };
  }

  /** 优雅停止：不再领取新任务，进行中的单篇下载跑完（Playwright 会话无法安全中断）。 */
  stop() {
    if (this.#running) this.#aborted = true;
  }

  /**
   * 运行一批下载。并发调用抛错（同一时间只允许一批）。
   * @param {string} text 清单全文
   * @param {{outDir: string, concurrency: number, retries: number}} opts outDir 须为绝对路径
   */
  async run(text, { outDir, concurrency, retries }) {
    if (this.#running) throw new Error('已有批次在运行');
    const { dois, skipped } = parseList(text);
    if (dois.length === 0) throw new Error('清单中未识别到任何 DOI');
    // mkdir 放在置位 running 之前：目录建不了直接抛错，运行器保持 idle，可再次发起
    fs.mkdirSync(outDir, { recursive: true });
    this.#running = true;
    this.#aborted = false;

    const items = dois.map((doi, i) => ({
      idx: i + 1, doi, publisher: '', state: 'pending', phase: '',
      attempt: 0, startedAt: 0, endedAt: 0, durationMs: 0, status: '', reason: '', note: '', path: '', bytes: 0, resolveUrl: '',
    }));

    // 跳过已下载（文件头 %PDF- 才算），失败重跑零成本
    for (const it of items) {
      const p = this.#existingFn(it.doi, outDir);
      if (p) {
        it.state = 'done';
        it.status = 'exists';
        it.path = p;
        it.bytes = fs.statSync(p).size;
        appendLog(outDir, it.doi, '-', '已存在', path.basename(p));
      }
    }

    const meta = { outDir, concurrency, retries, total: items.length, skipped, startedAt: Date.now() };
    this.#state = { state: 'running', meta, items };
    this.#onEvent({ type: 'start', meta, items: items.map(it => ({ ...it })) });

    const pending = items.filter(it => it.state === 'pending');
    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length && !this.#aborted) {
        await this.#runItem(pending[cursor++], meta);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));

    // 批次收尾：重置 Elsevier/IOP 会话引用，收掉持久浏览器窗口（server 常驻，不关会一直挂着；
    // 登录态已在 .browser-profile，下次批次免登）
    await closeElsevierSession().catch(() => {});
    await closeIopSession().catch(() => {});
    await closeBrowserSession().catch(() => {});

    const summary = this.#buildSummary(items, meta);
    if (summary.redoDois.length > 0) {
      fs.writeFileSync(path.join(outDir, 'failed.txt'), summary.redoDois.join('\n') + '\n');
    } else fs.rmSync(path.join(outDir, 'failed.txt'), { force: true });
    this.#state.state = 'finished';
    this.#state.summary = summary;
    this.#running = false;
    this.#onEvent({ type: 'done', summary });
    return summary;
  }

  #emitItem(it) {
    this.#onEvent({ type: 'item', item: { ...it } });
    // SSE 与落盘共用一份快照：SmartAnswer 面板的 SaActivity 只读 _download_progress.json
    if (this.#state.meta?.outDir) {
      try {
        writeDownloadProgress(this.#state.meta.outDir, this.#state.items, this.#state.meta);
      } catch { /* 落盘失败不阻断下载；SSE 仍在推进 */ }
    }
  }

  async #runItem(it, meta) {
    const maxAttempts = meta.retries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      it.attempt = attempt;
      it.state = 'running';
      it.note = '';
      it.startedAt = Date.now();
      this.#emitItem(it);
      let failedReason = '';
      try {
        const r = await this.#downloadFn(it.doi, meta.outDir, {
          openManual: false,
          onPhase: (phase, info = {}) => {
            it.phase = phase;
            if (info.publisher) it.publisher = info.publisher;
            if (info.note) it.note = info.note;
            this.#emitItem(it);
          },
        });
        it.publisher = r.publisher;
        it.resolveUrl = r.resolveUrl;
        it.path = r.path;
        it.bytes = r.bytes;
        if (r.status === 'manual-required') {
          // 需人工是确定性结果（Cloudflare），不重试
          it.status = 'manual';
          it.reason = r.reason;
          it.durationMs = r.durationMs ?? Date.now() - it.startedAt;
          this.#finish(it);
          return;
        }
        if (r.status === 'ok') {
          it.status = 'ok';
          it.reason = '';
          it.durationMs = r.durationMs ?? Date.now() - it.startedAt;
          this.#finish(it);
          return;
        }
        if (r.permanent) {
          // 确定性失败（unknown出版商/无权限/无法解析），重试无意义
          it.status = 'failed';
          it.reason = r.reason;
          it.durationMs = r.durationMs ?? Date.now() - it.startedAt;
          this.#finish(it);
          return;
        }
        failedReason = it.reason = r.reason;
      } catch (e) {
        // downloadOne 约定不抛错；此处兜底防止单篇异常中断 worker
        failedReason = it.reason = (e?.message || String(e)).substring(0, 120);
      }
      if (attempt < maxAttempts) {
        it.note = `将重试 ${attempt}/${meta.retries}：${failedReason}`;
        this.#emitItem(it);
        await sleep(2000);
      }
    }
    it.status = 'failed';
    this.#finish(it);
  }

  #finish(it) {
    it.state = 'done';
    // 终态耗时锚定（视觉链窗口重探 2026-09-27 步骤4）：retry 耗尽路径未写 durationMs 时，
    // 由 endedAt-startedAt 兜底，progress 每拍重写不再放大终态耗时
    it.endedAt = Date.now();
    if (!(it.durationMs > 0) && it.startedAt > 0) it.durationMs = Math.max(0, it.endedAt - it.startedAt);
    this.#emitItem(it);
  }

  #buildSummary(items, meta) {
    const count = status => items.filter(it => it.status === status).length;
    const failedItems = items.filter(it => it.status === 'failed');
    const manualItems = items.filter(it => it.status === 'manual');
    return {
      ok: count('ok'),
      failed: failedItems.length,
      manual: manualItems.length,
      exists: count('exists'),
      total: items.length,
      skipped: meta.skipped,
      durationMs: Date.now() - meta.startedAt,
      outDir: meta.outDir,
      failedPath: path.join(meta.outDir, 'failed.txt'),
      redoDois: [...failedItems, ...manualItems].map(it => it.doi),
      failedList: failedItems.map(it => ({ doi: it.doi, publisher: it.publisher, reason: it.reason })),
      manualList: manualItems.map(it => ({ doi: it.doi, resolveUrl: it.resolveUrl || `https://doi.org/${it.doi}` })),
      aborted: this.#aborted,
    };
  }
}
