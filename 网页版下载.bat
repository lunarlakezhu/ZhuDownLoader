@echo off
chcp 65001 >nul
title ZhuDownLoader 网页版
echo ============================================
echo   ZhuDownLoader - 网页版批量文献下载
echo   正在启动，浏览器会自动打开下载页面...
echo   保持本窗口开着；全部下载完后关闭本窗口即退出
echo ============================================
echo.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 node，请先安装 Node.js: https://nodejs.org/
  pause
  exit /b 1
)
node webui\server.mjs
echo.
echo 网页服务已退出，按任意键关闭窗口...
pause >nul
