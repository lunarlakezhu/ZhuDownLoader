# ZhuDownLoader 批量文献下载器 Wiki

输入一份 DOI 清单，自动并行下载 PDF：实时看板显示每篇进度，结束时汇总失败清单，失败的还能一键导出重跑。支持 Nature、Springer、剑桥哲学会（cambridge.org）、PNAS、Science、IEEE、Wiley、Company of Biologists、Royal Society、Oxford 牛津大学出版社、ACS 美国化学会（含 JACS）、APS 美国物理学会（含 PRL）、美国生理学会、MDPI、SAGE、Elsevier（ScienceDirect）、IOP Publishing 等出版商。

> 前提提醒：下载 PDF 依赖校园网的机构订阅权限，请在学校网络环境内使用。

## 三种用法（选一个即可）

| 方式 | 适合谁 | 怎么开始 |
|---|---|---|
| 网页版（推荐） | 新手，想看实时进度 | 双击 `网页版下载.bat`，浏览器自动打开 `http://127.0.0.1:7788` |
| 拖拽 | 已经有清单 .txt 文件 | 把 .txt 拖到 `拖拽下载.bat` 图标上 |
| 命令行 | 想调参数、写脚本 | `node batch_download.mjs 清单.txt 输出目录` |

## wiki 页面导航

- [快速上手](快速上手.md) — 从零安装到第一次下载成功的完整步骤（保姆级）
- [网页版使用指南](网页版使用指南.md) — 网页版每个按钮、每种状态怎么看
- [清单格式与命令行参数](清单格式与命令行参数.md) — DOI 清单怎么写、每个参数什么含义
- [常见问题 FAQ](常见问题-FAQ.md) — 乱码、失败、人机验证、权限问题都在这
- [迁移到新电脑](迁移到新电脑.md) — 三步把整套工具搬到另一台 Windows

## 边界与合规

工具对验证控件只做**有界自动操作**：勾选框（Turnstile / hCaptcha "I'm not a robot"）会自动点一次；图选谜题/滑块/验证码图片/OTP/扫码等绝不自动操作，交人在窗口完成。不绕过付费墙与任何访问权限。
