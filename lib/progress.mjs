// 进度落盘 — 批次条目状态 → <outDir>/_download_progress.json（原子写：临时文件 + rename）。
// 消费方：batch_download.mjs（CLI）与 webui/batch.mjs（BatchRunner，SSE 与落盘共用一份快照）。
// 文件结构：{ updatedAt, total, done, ok, failed, manual, exists, running, items: [...] }，
// 单条 item：{doi, status, phase, publisher, note, attempt, bytes, elapsedMs}。
// 读侧（SmartAnswer 面板 / sa-web op）只依赖这些键名，勿改名。
import fs from 'fs';
import path from 'path';

const PROGRESS_FILE = '_download_progress.json';

/** 单条目 → 进度 JSON 行。status 空时按 state 推导（pending/running）。
 *  终态耗时锚定真实起止（视觉链窗口重探 2026-09-27 步骤4）：进度文件随心跳每拍重写，旧实现对
 *  终态条目用 Date.now()-startedAt 重算，耗时会随批次推进不断放大（最后心跳重算）。改为
 *  durationMs 优先、其次 endedAt-startedAt 冻结值（endedAt 与 download.log 终条目同一瞬间写入，
 *  耗时一致）；仅 running 条目继续实时计算。 */
function toRow(it) {
  const terminalMs = Number(it.durationMs) > 0 ? Number(it.durationMs)
    : (it.startedAt > 0 && it.endedAt > 0 ? Math.max(0, it.endedAt - it.startedAt) : 0);
  return {
    doi: it.doi,
    status: it.status || (it.state === 'running' ? 'running' : it.state),
    phase: it.phase || '',
    publisher: it.publisher || '',
    note: it.note || it.reason || '',
    attempt: it.attempt || 0,
    bytes: it.bytes || 0,
    elapsedMs: terminalMs || (it.state === 'running' && it.startedAt > 0 ? Date.now() - it.startedAt : 0),
  };
}

/**
 * 原子写当前批次快照。items 为空数组时同样落盘（清空批次）。
 * rename 在同卷内是原子操作，读侧不会见到半截 JSON。
 */
export function writeDownloadProgress(outDir, items, meta = {}) {
  const rows = items.map(toRow);
  const count = status => rows.filter(r => r.status === status).length;
  const data = {
    updatedAt: new Date().toISOString(),
    total: rows.length,
    done: rows.filter(r => ['ok', 'failed', 'manual', 'exists'].includes(r.status)).length,
    ok: count('ok'),
    failed: count('failed'),
    manual: count('manual'),
    exists: count('exists'),
    running: count('running'),
    concurrency: meta.concurrency ?? null,
    startedAt: meta.startedAt ?? null,
    items: rows,
  };
  const final = path.join(outDir, PROGRESS_FILE);
  const tmp = path.join(outDir, `.${PROGRESS_FILE}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, final);
  return final;
}
