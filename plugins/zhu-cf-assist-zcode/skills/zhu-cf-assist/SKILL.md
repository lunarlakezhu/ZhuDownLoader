---
name: zhu-cf-assist
description: ZhuDownLoader 验证框图像辅助（ZCode 版）。当用户要求下载论文 PDF、跑期刊官网下载测试、或提到 Cloudflare/Turnstile 验证框需要 AI 读图给坐标时使用。含 发起→等待→读图→回应→循环→汇报 完整规程。
---

# ZhuDownLoader 验证框图像辅助（ZCode 版）

用 zhu-cf-assist 的五个 MCP 工具（`cf_assist_guide / arm / wait / respond / test`），对期刊官网下载过程中的 Cloudflare Turnstile 勾选框做一次 AI 读图点击。**点击动作由 ZhuDownLoader 自己的 Playwright 执行**，模型只读截图、给框内坐标。

## 规程

1. 与用户确认 DOI 清单后调用一次 `cf_assist_test`（参数 `dois` 数组；已有清单文件先用内置 Read 工具读出行内 DOI 再传入）。它自动启用图像辅助（默认 60 分钟）、后台启动下载（并发 1、重试 1，输出 `test-runs/<时间戳>`），返回 `runId` 与输出目录。
2. 监看循环：反复调用 `cf_assist_wait`（`seconds` 建议 10）：
   - `status=pending` → 立即用内置 Read 工具读取返回的 `imagePath`（PNG 绝对路径）。只有清楚看见验证勾选框（Cloudflare Turnstile 勾选框本体）才 `cf_assist_respond(action="click", x, y)`：坐标以图片左上角为原点，只提交一次。看不清、不是勾选框、是图选/滑块/拼图 → `cf_assist_respond(action="skip")`，并在最终汇报中把该 DOI 标记为需人工。**绝不提交框外坐标，绝不猜测坐标。**
   - `status=none` → 继续循环调用 `cf_assist_wait`，不需要用户推动。
   - `status=run_ended` → 监看结束：读取返回中的 `summary`，向用户汇报成功/失败/需人工计数，停止调用 wait。
3. 失败回退：连续 3 次 Read 读图失败 → 立即停止循环，明确告知用户"图像辅助不可用，请人工过验证"，不要猜坐标。

## 边界（下载器侧强制，模型无法越过）

- 每个请求至多**一次**真实点击；回应独占落盘，重复提交直接拒绝。
- 请求过期（90 秒）、页面跳转、框消失、框尺寸漂移（>1px）都会被下载器拒绝或跳过；框整体平移按新框原点补偿，点击仍落在框内。
- 只截当前可见的 Turnstile iframe；hCaptcha 走既有 DOM 路径，不进图像辅助。
- **图选、滑块、OTP 等人工验证绝不自动操作**——一律 skip 并标记需人工。
- 点击后是否放行以网站结果为准：未放行仍按「需人工」汇报，绝不把「点了一次」当「通过验证」。
- 测试 PDF 仅用于核验下载效果，不是交付成果。

## 环境变量（.mcp.json 已内置本机默认值）

| 变量 | 默认 | 说明 |
|---|---|---|
| `ZHU_CF_ASSIST_DIR` | `D:\ZhuDownLoader\.cf-assist` | 握手目录（下载器与插件必须一致） |
| `ZHU_DOWNLOADER_HOME` | `D:\ZhuDownLoader` | ZhuDownLoader 根目录 |
| `ZHU_CF_ASSIST_MAX_WAIT_MS` | 90000 | 单请求等待回应时限（5s–180s，下载器侧读取） |

测试输出固定在 `D:\ZhuDownLoader\test-runs\<时间戳>\`；逐篇进度看 `_download_progress.json`，逐篇终态看 `download.log`。
