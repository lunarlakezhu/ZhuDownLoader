# ZhuDownLoader 批量文献下载器

输入一份 DOI 清单，自动并行下载 PDF：实时看板显示每篇进度，结束时汇总失败清单，失败的还能一键导出重跑。支持 Nature、Springer、剑桥哲学会（cambridge.org）、PNAS、Science、IEEE、Wiley、Company of Biologists、Royal Society、Oxford 牛津大学出版社、ACS 美国化学会（含 JACS）、APS 美国物理学会（含 PRL）、美国生理学会、MDPI、SAGE、Elsevier（ScienceDirect）、IOP Publishing 等出版商官网。

> 本仓库为**分发仓库**：只包含使用文档与 ZCode 验证框辅助插件。下载器可运行包（Windows / Mac 通用同一个包）在 [Releases](../../releases) 页面；源码与内部实现不在本仓库。

> 前提提醒：下载 PDF 依赖校园网的机构订阅权限，请在学校网络环境内使用。合规边界见文末。

## 快速开始（Windows）

1. 从 [Releases](../../releases) 下载 `ZhuDownLoader-win-v0.2.1.zip`，解压到任意目录
2. 双击 `一键安装环境.bat`（一次性：装 Node.js 依赖与浏览器内核）
3. 双击 `网页版下载.bat`，浏览器自动打开 `http://127.0.0.1:7788`

在网页上粘贴 DOI 清单（或把清单 .txt 拖到 `拖拽下载.bat` 图标上），点「开始下载」，进度实时可见，结束后可一键打开 PDF 文件夹、复制/重跑失败清单。

## 快速开始（Mac）

1. 从 [Releases](../../releases) 下载**同一个** zip（文件名带 win 但 Mac 同样能用，内含全套 .command 脚本），解压到任意目录
2. 按包内《Mac上手指南.txt》放行脚本（终端 `chmod +x` 一次）
3. 双击 `一键安装环境.command`（一次性：装浏览器内核），再双击 `网页版下载.command`，浏览器自动打开 `http://127.0.0.1:7788`

命令行用法、清单格式与全部参数见 [wiki](wiki/Home.md)。

## ZCode 验证框辅助插件（zhu-cf-assist）

配合 [ZCode](https://github.com/) 使用的 MCP 插件：下载器遇到 Cloudflare / Turnstile 类验证勾选框时，把截图发给 AI 读图并返回勾选坐标，自动完成点击——仅限勾选框；图选谜题、滑块、OTP 等仍由人在窗口完成。

- 插件源码与安装说明：[plugins/zhu-cf-assist-zcode/](plugins/zhu-cf-assist-zcode/README.md)
- 可安装包：[plugins/releases/](plugins/releases/)（可搭配 ZCode 本地市场 [plugins/marketplace.json](plugins/marketplace.json) 使用）

## 文档

- [快速上手](wiki/快速上手.md) — 从零安装到第一次下载成功的完整步骤（保姆级）
- [网页版使用指南](wiki/网页版使用指南.md) — 网页版每个按钮、每种状态怎么看
- [清单格式与命令行参数](wiki/清单格式与命令行参数.md) — DOI 清单怎么写、每个参数什么含义
- [出版商支持矩阵](wiki/出版商支持矩阵.md) — 支持哪些出版商、要不要校园网、会不会弹窗
- [常见问题 FAQ](wiki/常见问题-FAQ.md) — 乱码、失败、人机验证、权限问题都在这
- [迁移到新电脑](wiki/迁移到新电脑.md) — 三步把整套工具搬到另一台 Windows

## 合规边界

- 对验证控件只做**有界自动操作**：勾选框（Turnstile / hCaptcha "I'm not a robot"）自动点一次；图选谜题、滑块、验证码图片、press & hold、OTP 等**绝不自动操作**——出现时程序停下来等人完成，绝不尝试破解。
- 付费文章依赖你所在机构的合法订阅权限（校园网 IP）；工具不破解任何权限、不绕过 DRM、不绕过付费墙。
