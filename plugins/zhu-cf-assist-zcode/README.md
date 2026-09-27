# zhu-cf-assist-zcode（ZhuDownLoader 验证框辅助 · ZCode 版）

在 ZCode 里用 AI 读图识别期刊网页 Cloudflare Turnstile 勾选框坐标，桥接 ZhuDownLoader 下载论文 PDF。从 `dsh-cf-assist` v0.2 移植：握手契约与下载器侧桥（`lib/cf-assist.mjs`）零改动，插件外壳换成 ZCode 的 stdio MCP server。设计与接口细节见仓库根目录《ZCode验证框辅助插件-设计说明.md》。

## 组件

```
.zcode-plugin/plugin.json   清单（name 必须与目录名一致）
.mcp.json                   MCP server 配置（${ZCODE_PLUGIN_ROOT} 由加载器解析）
mcp/cf-assist-server.mjs    stdio MCP server（零依赖，换行分隔 JSON-RPC）
mcp/bridge.mjs              工具桥（移植自 dsh-cf-assist/index.js，路径懒解析自 env）
mcp/launcher.js             最小启动器（fork batch_download.mjs；ipc + execArgv:[] 两教训已内置）
skills/zhu-cf-assist/SKILL.md  操作规程技能（等待→Read 读图→回应→循环→run_ended 汇报）
test/bridge.test.mjs        桥单测（移植自 dsh-cf-assist/test.mjs）
```

## 五个工具

| 工具 | 作用 |
|---|---|
| `cf_assist_guide` | 返回完整操作规程（SKILL.md 的兜底载体） |
| `cf_assist_arm` | 手动启用图像辅助（默认 30 分钟；test 会自动启用） |
| `cf_assist_test` | 一次发起：写 DOI 清单 + 启用辅助 + 后台启动下载（并发 1、重试 1） |
| `cf_assist_wait` | 监看循环一步：`pending`（带截图绝对路径）/ `none` / `run_ended` |
| `cf_assist_respond` | 对截图提交一次决策：`click`（框内坐标）或 `skip` |

ZCode 会话内只需一句：「用 zhu-cf-assist 对 DOI … 跑一次期刊官网下载测试，结束后汇报结果。」会话自动完成 发起→等待→Read 读图→回应→循环→run_ended 汇报。

## 边界保证（下载器侧强制，模型无法越过）

每请求至多一次真实点击；坐标越界/过期/页面跳转/框漂移/空白帧一律拒绝或跳过（框平移按新原点补偿）；hCaptcha 走 DOM 路径不进图像辅助；图选、滑块、OTP 绝不自动操作；是否放行以网站结果为准。详见 SKILL.md 与设计说明 §7。

## 环境变量（.mcp.json 已内置本机默认）

| 变量 | 默认 | 说明 |
|---|---|---|
| `ZHU_CF_ASSIST_DIR` | `D:\ZhuDownLoader\.cf-assist` | 握手目录（下载器与插件必须一致） |
| `ZHU_DOWNLOADER_HOME` | `D:\ZhuDownLoader` | ZhuDownLoader 根目录（找不到 batch_download.mjs 时必配） |

## 测试

```bash
node plugins/zhu-cf-assist-zcode/test/bridge.test.mjs   # 桥单测（临时目录隔离，不碰真实握手目录）
node test_cf_assist_e2e.mjs                              # 下载器侧端到端（本地模拟页，6 场景）
```

安装与验收流程（添加市场 → 安装 → 试用提示词）见设计说明 §8–§9。

## v0.2.0（2026-09-27，cf-assist 修复方案配套）

- `cf_assist_test` 守卫升级：running 的 run.json 还要求**持有进程存活**（run.json 新增 pid）且启动未满 2h 才拦截；孤儿运行（下载器已死/旧格式无 pid）自动放行并在返回加 `note:"检测到孤儿运行(已清理)"`。
- `cf_assist_wait` 陈旧检测：runStatus=running 且进度文件 mtime >120s → 返回 `progressStale:true` 与挂起提示（status 仍为 none，等待循环行为不变）。
- stdio server 优雅退出：stdin EOF 不再立即 exit(0) 杀在途调用——新调用回明确「正在关闭」错误，在途调用给 5s grace（0926「零应答静默被杀」已消除）。
- 配套下载器侧（D:\ZhuDownLoader）：页内 fetch 硬超时、每篇 10 分钟看门狗、manual-evidence 证据落盘、clearChallenge 统一质询流程接入 PDF 端点、封锁/验证/机构登录三态分类。
