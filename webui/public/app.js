/* 朱下载器网页版前端 — 状态全部来自 SSE（/api/events），刷新页面靠 /api/status 恢复现场。 */
'use strict';

const $ = s => document.querySelector(s);

const els = {
  viewForm: $('#view-form'), viewRun: $('#view-run'),
  list: $('#list'), listWrap: $('#list-wrap'), fileInput: $('#file-input'),
  outdir: $('#outdir'), concurrency: $('#concurrency'), retries: $('#retries'),
  previewCount: $('#preview-count'),
  btnSample: $('#btn-sample'), btnClear: $('#btn-clear'),
  btnStart: $('#btn-start'), btnStop: $('#btn-stop'),
  formError: $('#form-error'),
  fill: $('#progress-fill'),
  runOutdir: $('#run-outdir'), runStateLine: $('#run-state-line'),
  tbody: $('#task-body'),
  summary: $('#summary-card'), sumDetail: $('#sum-detail'),
  sumFailed: $('#sum-failed'), sumNote: $('#sum-note'),
  btnOpenFolder: $('#btn-open-folder'), btnOpenAuth: $('#btn-open-auth'),
  btnRetryManual: $('#btn-retry-manual'), btnCopyFailed: $('#btn-copy-failed'),
  btnRetryFailed: $('#btn-retry-failed'), btnNewBatch: $('#btn-new-batch'),
  toast: $('#toast'),
  counters: {
    total: $('#c-total'), ok: $('#c-ok'), failed: $('#c-failed'), manual: $('#c-manual'),
    exists: $('#c-exists'), running: $('#c-running'), wait: $('#c-wait'),
  },
};

const STATUS = {
  pending: { label: '待处理', cls: 'st-pending' },
  resolving: { label: '解析中', cls: 'st-run' },
  downloading: { label: '下载中', cls: 'st-run' },
  verifying: { label: '校验中', cls: 'st-run' },
  ok: { label: '成功', cls: 'st-ok' },
  exists: { label: '已存在', cls: 'st-exists' },
  failed: { label: '失败', cls: 'st-fail' },
  manual: { label: '需人工', cls: 'st-manual' },
};

// ---------- 批次状态 ----------

let items = new Map(); // idx -> item（服务端推送的最新值）
let meta = null;
let summary = null;
let detached = false; // 用户点了「再来一批/填回输入框」后，忽略旧批次的残余事件
let es = null;

const statusKey = it => it.state === 'pending' ? 'pending'
  : it.state === 'running' ? (it.phase || 'resolving') : it.status;

const kb = n => `${Math.round((n || 0) / 1024)}KB`;

function noteOf(it) {
  if (it.state === 'done') {
    if (it.status === 'ok') return kb(it.bytes);
    if (it.status === 'exists') return `文件夹里已有（${kb(it.bytes)}）`;
    if (it.status === 'manual') return it.reason || '需在下载器 Edge 中验证或登录';
    return it.reason || '';
  }
  return it.note || '';
}

// ---------- 渲染 ----------

function showRunView() {
  els.viewForm.hidden = true;
  els.viewRun.hidden = false;
  window.scrollTo({ top: 0 });
}

function showFormView() {
  els.viewRun.hidden = true;
  els.viewForm.hidden = false;
  window.scrollTo({ top: 0 });
}

function buildRow(it) {
  const tr = document.createElement('tr');
  tr.dataset.idx = it.idx;
  tr.innerHTML =
    `<td class="cell-idx"></td><td class="cell-doi"></td><td class="cell-pub"></td>` +
    `<td class="cell-status"></td><td class="cell-dur"></td><td class="cell-note"></td>`;
  return tr;
}

function updateRow(it) {
  let tr = els.tbody.querySelector(`tr[data-idx="${it.idx}"]`);
  if (!tr) { tr = buildRow(it); els.tbody.appendChild(tr); }
  const s = STATUS[statusKey(it)] ?? STATUS.pending;
  tr.className = it.state === 'running' ? 'running' : '';
  tr.children[0].textContent = it.idx;
  tr.children[1].textContent = it.doi;
  tr.children[2].textContent = it.publisher ? it.publisher.toUpperCase() : '—';
  tr.children[3].innerHTML = `<span class="status-chip ${s.cls}">${s.label}</span>`;
  tr.children[4].textContent = it.state === 'running'
    ? `${Math.round((Date.now() - it.startedAt) / 1000)}s`
    : (it.durationMs ? `${(it.durationMs / 1000).toFixed(1)}s` : '');
  tr.children[5].textContent = noteOf(it);
  // Elsevier 等人在弹出的浏览器窗口里点人机验证：琥珀色提醒（其他备注保持默认）
  tr.children[5].classList.toggle('note-verify',
    it.state === 'running' && /人机验证/.test(it.note || ''));
}

function renderAll() {
  els.tbody.innerHTML = '';
  for (const it of items.values()) updateRow(it);
  renderCounters();
  renderRunHead();
}

function renderCounters() {
  const c = { ok: 0, failed: 0, manual: 0, exists: 0, running: 0, wait: 0 };
  for (const it of items.values()) {
    if (it.state === 'done') c[it.status === 'manual' ? 'manual' : it.status]++;
    else if (it.state === 'running') c.running++;
    else c.wait++;
  }
  els.counters.total.textContent = meta ? meta.total : items.size;
  for (const k of ['ok', 'failed', 'manual', 'exists', 'running', 'wait']) {
    els.counters[k].textContent = c[k];
  }
  const done = c.ok + c.failed + c.manual + c.exists;
  els.fill.style.width = meta && meta.total ? `${(done / meta.total) * 100}%` : '0';
}

function renderRunHead() {
  els.runOutdir.textContent = meta ? meta.outDir : '';
  const running = meta && !summary;
  els.fill.classList.toggle('working', Boolean(running));
  els.btnStop.hidden = !running;
  if (summary) {
    els.runStateLine.textContent = summary.aborted ? '已按「停止」提前结束' : '已完成';
  } else if (running) {
    els.runStateLine.textContent = '批次进行中，别关黑窗口…';
  }
}

function renderSummary() {
  if (!summary) return;
  const secs = Math.round(summary.durationMs / 1000);
  els.sumDetail.textContent =
    `成功 ${summary.ok} · 失败 ${summary.failed} · 需人工 ${summary.manual} · 已存在 ${summary.exists}` +
    `（共 ${summary.total} 篇，用时 ${secs < 60 ? `${secs} 秒` : `${Math.floor(secs / 60)} 分 ${secs % 60} 秒`}）` +
    (summary.skipped ? `；清单里另有 ${summary.skipped} 行没认出 DOI。` : '。');

  els.sumFailed.innerHTML = '';
  for (const f of summary.failedList) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="doi"></span><span class="why"></span>`;
    li.children[0].textContent = f.doi;
    li.children[1].textContent = `失败 — ${f.reason || '原因未知'}`;
    els.sumFailed.appendChild(li);
  }
  for (const m of summary.manualList) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="doi"></span><span class="why">需在下载器 Edge 中验证或登录</span>`;
    li.children[0].textContent = m.doi;
    els.sumFailed.appendChild(li);
  }
  els.sumFailed.hidden = summary.failedList.length + summary.manualList.length === 0;

  const hasRedo = summary.redoDois.length > 0;
  const hasManual = summary.manualList.length > 0;
  els.btnOpenAuth.hidden = !hasManual;
  els.btnRetryManual.hidden = !hasManual;
  els.btnCopyFailed.hidden = !hasRedo;
  els.btnRetryFailed.hidden = !hasRedo;
  els.sumNote.hidden = !summary.aborted;
  if (summary.aborted) {
    els.sumNote.textContent = '这批是提前停止的：还没开始的条目没有下载，需要的话重新点一次「开始下载」（已成功的会自动跳过）。';
  }
  els.summary.hidden = false;
  renderRunHead();
}

// ---------- 计时：进行中条目的耗时每秒跳动 ----------

setInterval(() => {
  if (els.viewRun.hidden || summary) return;
  for (const it of items.values()) {
    if (it.state !== 'running') continue;
    const tr = els.tbody.querySelector(`tr[data-idx="${it.idx}"]`);
    if (tr) tr.children[4].textContent = `${Math.round((Date.now() - it.startedAt) / 1000)}s`;
  }
}, 1000);

// ---------- SSE ----------

function connectEvents() {
  if (es) es.close();
  es = new EventSource('/api/events');
  es.addEventListener('snapshot', e => {
    const snap = JSON.parse(e.data);
    if (snap.state === 'idle') return;
    if (detached && snap.state !== 'running') return;
    adoptSnapshot(snap);
  });
  es.addEventListener('start', e => {
    const { meta: m, items: list } = JSON.parse(e.data);
    detached = false;
    meta = m; summary = null;
    items = new Map(list.map(it => [it.idx, it]));
    els.summary.hidden = true;
    showRunView();
    renderAll();
  });
  es.addEventListener('item', e => {
    if (detached || !meta) return;
    const { item: it } = JSON.parse(e.data); // 服务端 data 为 {type:'item', item}
    items.set(it.idx, it);
    updateRow(it);
    renderCounters();
  });
  es.addEventListener('done', e => {
    if (detached) return;
    summary = JSON.parse(e.data).summary; // data 为 {type:'done', summary}
    renderSummary();
  });
  es.addEventListener('batch-error', e => {
    if (detached) return;
    const { message } = JSON.parse(e.data);
    els.fill.classList.remove('working');
    els.runStateLine.textContent = `批次出错：${message}`;
    toast(`批次出错：${message}`);
  });
  // 内建 error 事件 = 与服务器断连（readyState CLOSED 表示不再自动重连）
  es.addEventListener('error', () => {
    if (es.readyState === EventSource.CLOSED && !detached) {
      toast('与服务器的连接已断开：请确认服务黑窗口还开着，然后刷新本页');
    }
  });
}

function adoptSnapshot(snap) {
  detached = false;
  meta = snap.meta;
  summary = snap.summary;
  items = new Map(snap.items.map(it => [it.idx, it]));
  showRunView();
  renderAll();
  if (summary) renderSummary();
}

// ---------- 清单预览 ----------

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const text = els.list.value;
    if (!text.trim()) { els.previewCount.hidden = true; return; }
    try {
      const r = await fetch('/api/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const { dois, skipped } = await r.json();
      els.previewCount.hidden = false;
      els.previewCount.textContent =
        `识别到 ${dois.length} 篇文献（重复已合并）` + (skipped ? `，另有 ${skipped} 行没认出 DOI` : '');
    } catch { els.previewCount.hidden = true; }
  }, 250);
}

// ---------- 交互 ----------

function toast(text) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { els.toast.hidden = true; }, 2600);
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? '{}' : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

els.list.addEventListener('input', schedulePreview);

els.fileInput.addEventListener('change', async () => {
  const f = els.fileInput.files[0];
  if (!f) return;
  els.list.value = await f.text();
  schedulePreview();
  els.fileInput.value = '';
});

els.listWrap.addEventListener('dragover', e => { e.preventDefault(); els.listWrap.classList.add('dragover'); });
els.listWrap.addEventListener('dragleave', () => els.listWrap.classList.remove('dragover'));
els.listWrap.addEventListener('drop', async e => {
  e.preventDefault();
  els.listWrap.classList.remove('dragover');
  const f = e.dataTransfer.files[0];
  if (f) { els.list.value = await f.text(); schedulePreview(); }
});

els.btnClear.addEventListener('click', () => { els.list.value = ''; els.previewCount.hidden = true; });

els.btnSample.addEventListener('click', async () => {
  try {
    const r = await fetch('/api/sample');
    const { text } = await r.json();
    els.list.value = text;
    schedulePreview();
    toast('已填入示例清单（里面故意放了一个无效 DOI，可以看到失败提示长什么样）');
  } catch { toast('示例清单读取失败'); }
});

els.btnStart.addEventListener('click', async () => {
  els.formError.hidden = true;
  try {
    await api('/api/start', {
      text: els.list.value,
      outDir: els.outdir.value,
      concurrency: Number(els.concurrency.value),
      retries: Number(els.retries.value),
    });
    // 视图切换由 SSE 的 start 事件驱动（页面其他标签页也会同步）
  } catch (e) {
    els.formError.textContent = e.message;
    els.formError.hidden = false;
  }
});

els.btnStop.addEventListener('click', async () => {
  els.btnStop.disabled = true;
  els.runStateLine.textContent = '停止中：不再领新任务，等正在下载的这篇完成…';
  try { await api('/api/stop'); } catch { /* 停止失败仅意味着批次继续跑 */ }
  els.btnStop.disabled = false;
});

els.btnOpenFolder.addEventListener('click', async () => {
  try {
    await api('/api/open-folder', { outDir: meta?.outDir });
    toast('已请求打开文件夹，如果没弹出来请手动打开');
  } catch (e) { toast(e.message); }
});

els.btnOpenAuth.addEventListener('click', async () => {
  els.btnOpenAuth.disabled = true;
  try {
    const r = await api('/api/manual/open');
    toast(`已在下载器 Edge 中打开 ${r.count} 篇；完成登录后点“验证完成后重试”`);
  } catch (e) { toast(e.message); }
  els.btnOpenAuth.disabled = false;
});

els.btnRetryManual.addEventListener('click', async () => {
  if (!summary?.manualList?.length) return;
  els.btnRetryManual.disabled = true;
  try {
    await api('/api/start', {
      text: summary.manualList.map(it => it.doi).join('\n'),
      outDir: summary.outDir,
      concurrency: 1,
      retries: 0,
    });
  } catch (e) { toast(e.message); els.btnRetryManual.disabled = false; }
});

els.btnCopyFailed.addEventListener('click', async () => {
  if (!summary?.redoDois.length) return;
  const text = summary.redoDois.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('失败清单已复制');
  } catch {
    // 非安全上下文（http://127.0.0.1 除外）或旧浏览器：退回 execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('失败清单已复制');
  }
});

els.btnRetryFailed.addEventListener('click', () => {
  if (!summary) return;
  els.list.value = summary.redoDois.join('\n');
  schedulePreview();
  detached = true;
  if (es) es.close();
  summary = null; meta = null; items = new Map();
  els.tbody.innerHTML = '';
  els.summary.hidden = true;
  showFormView();
});

els.btnNewBatch.addEventListener('click', () => {
  detached = true;
  if (es) es.close();
  summary = null; meta = null; items = new Map();
  els.tbody.innerHTML = '';
  els.summary.hidden = true;
  showFormView();
});

// ---------- 启动 ----------

(async function init() {
  try {
    const { outDir } = await (await fetch('/api/defaults')).json();
    if (!els.outdir.value) els.outdir.value = outDir;
  } catch { /* 默认目录拿不到就让用户自己填 */ }
  try {
    const snap = await (await fetch('/api/status')).json();
    if (snap.state !== 'idle') adoptSnapshot(snap);
  } catch { /* 服务端刚起还没就绪时停在表单即可 */ }
  connectEvents();
})();
