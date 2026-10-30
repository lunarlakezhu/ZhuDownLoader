#!/bin/bash
# ZhuDownLoader 新电脑环境安装（macOS 版，对应 Windows 的 一键安装环境.bat；只需跑一次）
# 作用：下载文献下载所需的 Chromium 浏览器内核。
cd "$(dirname "$0")" || exit 1
echo "============================================"
echo "  ZhuDownLoader 新电脑环境安装（只需跑一次）"
echo "  作用：下载文献下载所需的 Chromium 浏览器内核"
echo "============================================"
echo
if ! command -v node >/dev/null 2>&1; then
  echo "【缺少 Node.js】请先安装："
  echo "    打开 https://nodejs.org/ 下载 LTS 版，一路下一步"
  echo "    装完后重新双击本脚本"
  echo
  echo "按回车关闭窗口..."
  read -r
  exit 1
fi
echo "[1/2] 检查下载依赖..."
if [ ! -d "node_modules/playwright" ]; then
  echo "  依赖缺失，正在 npm install（需要联网）..."
  npm install
  if [ $? -ne 0 ]; then
    echo "【失败】npm install 出错，请截图报错内容求助"
    echo
    echo "按回车关闭窗口..."
    read -r
    exit 1
  fi
else
  echo "  依赖已随包自带，跳过"
fi
echo "[2/2] 下载 Chromium 浏览器内核（约 150MB，需要联网，几分钟）..."
# 用 node 直调 cli.js 而非 npx：zip 里的 .bin 垫片在 macOS 解压后无执行权限，npx 会 EACCES
node node_modules/playwright/cli.js install chromium
if [ $? -ne 0 ]; then
  echo "【失败】Chromium 下载出错：请检查网络后重新双击本脚本"
  echo
  echo "按回车关闭窗口..."
  read -r
  exit 1
fi
echo
echo "【完成】环境就绪！以后双击「网页版下载.command」即可使用"
echo
echo "按回车关闭窗口..."
read -r
