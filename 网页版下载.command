#!/bin/bash
# ZhuDownLoader 网页版启动（对应 Windows 的 网页版下载.bat）
# 双击后浏览器自动打开 http://127.0.0.1:7788；关掉终端窗口即退出。
cd "$(dirname "$0")" || exit 1
echo "============================================"
echo "  ZhuDownLoader - 网页版批量文献下载"
echo "  正在启动，浏览器会自动打开下载页面..."
echo "  保持本窗口开着；全部下载完后关闭本窗口即退出"
echo "============================================"
echo
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node，请先安装 Node.js: https://nodejs.org/"
  echo
  echo "按回车关闭窗口..."
  read -r
  exit 1
fi
node webui/server.mjs
echo
echo "网页服务已退出，按回车关闭窗口..."
read -r
