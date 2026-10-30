// 单篇文献下载 CLI — 薄壳：核心逻辑在 lib/downloader.mjs，现有用法保持不变。
// 用法: node pw_download.mjs <DOI> [输出目录]
import fs from 'fs';
import path from 'path';
import readline from 'readline/promises';
import { downloadOne, openInDownloadBrowser, closeElsevierSession, closeIopSession, closeBrowserSession } from './lib/downloader.mjs';
import { cfAssistRunBegin, cfAssistRunEndSync } from './lib/cf-assist.mjs';

const DOI = process.argv[2];
// 默认输出目录：各平台统一落到「下载/ZhuDownLoader」（不依赖个人盘符，换电脑也能跑）
const OUT_DIR = process.argv[3]
  || path.join(process.env.HOME || process.env.USERPROFILE || process.cwd(), 'Downloads', 'ZhuDownLoader');

if (!DOI) {
  console.log('用法: node pw_download.mjs <DOI> [输出目录]');
  console.log('示例: node pw_download.mjs 10.1038/nature14539');
  console.log('      node pw_download.mjs 10.1109/LRA.2022.3147245 E:\\Papers');
  console.log('批量下载请用: node batch_download.mjs <清单文件> [输出目录]  或  .\\zhu-dl.ps1');
  process.exit(1);
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// 运行生命周期（DSH 图像辅助监看的契约）：run.json 记 running → ended/interrupted
const runId = process.env.ZHU_CF_ASSIST_RUN_ID || `pw-${Date.now().toString(36)}-${process.pid}`;
cfAssistRunBegin({ runId, label: 'pw_download', total: 1 });
let finalStatus = '';
process.on('exit', () => {
  const summary = { ok: finalStatus === 'ok' ? 1 : 0, failed: finalStatus === 'failed' ? 1 : 0,
    manual: finalStatus === 'manual-required' ? 1 : 0, exists: 0 };
  cfAssistRunEndSync({ interrupted: !finalStatus, summary });
});

console.log(`\n📄 ${DOI}`);
console.log(`📁 ${OUT_DIR}\n`);

const download = () => downloadOne(DOI, OUT_DIR, {
  openManual: false,
  onPhase: (phase, info = {}) => {
    if (phase === 'downloading') {
      if (info.publisher) {
        console.log(`🏷️ 出版商: ${info.publisher.toUpperCase()}`);
        console.log(`🔗 ${(info.url || '').substring(0, 80)}`);
      } else if (info.note) {
        console.log(`   ${info.note}`);
      }
    } else if (phase === 'verifying') {
      console.log('🔍 校验PDF...');
    }
  },
});

let r;
try {
  r = await download();
  if (r.status === 'manual-required' && process.stdin.isTTY) {
    try {
      await openInDownloadBrowser([r.resolveUrl || `https://doi.org/${DOI}`]);
      console.log('\n请在刚打开的下载器 Edge 窗口完成官网验证或机构登录。');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        while (r.status === 'manual-required') {
          const answer = await rl.question('完成后按 Enter 用同一登录资料重试；输入 q 结束：');
          if (answer.trim().toLowerCase() === 'q') break;
          r = await download();
          if (r.status === 'manual-required') console.log(`仍需处理：${r.reason}`);
        }
      } finally { rl.close(); }
    } catch (e) {
      console.log(`无法打开下载器 Edge 窗口：${e?.message || e}`);
    }
  }
} finally {
  await closeElsevierSession();
  await closeIopSession();
  await closeBrowserSession(); // 验证与重试共用此会话，结束后才关闭
}
finalStatus = r?.status || '';

if (r.status === 'ok') {
  console.log(`\n🎉 成功 ${path.basename(r.path)} ${Math.round(r.bytes / 1024)}KB ${(r.durationMs / 1000).toFixed(1)}s`);
  process.exit(0);
}
if (r.status === 'manual-required') {
  console.log(`\n⚠️ 需官网验证或机构访问: ${r.reason}`);
  console.log(`   ${r.resolveUrl}`);
  process.exit(1);
}
console.log(`\n❌ 下载失败: ${r.reason}`);
process.exit(1);
