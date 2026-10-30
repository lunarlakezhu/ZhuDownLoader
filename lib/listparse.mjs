// 清单解析 — 从 batch_download.mjs 抽出，供 CLI 与 webui/server.mjs 共用。

/**
 * 宽松解析清单文本：每行任意位置提取 DOI，容忍「编号+DOI」「DOI+标题」「含 DOI 的 URL」混合行。
 * '#' 开头为注释，空行跳过，DOI 按小写去重；行尾悬挂的标点（逗号/句号/右括号等）剥掉。
 * @param {string} text 清单全文
 * @returns {{dois: string[], skipped: number}} 识别出的 DOI（保持原大小写）与无法识别的行数
 */
export function parseList(text) {
  const dois = [];
  const seen = new Set();
  let skipped = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/10\.\d{4,9}\/[^\s"']+/);
    if (!m) { skipped++; continue; }
    const doi = m[0].replace(/[.,;:)\]]+$/, '');
    const key = doi.toLowerCase();
    if (!seen.has(key)) { seen.add(key); dois.push(doi); }
  }
  return { dois, skipped };
}
