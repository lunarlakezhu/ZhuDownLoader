@echo off
chcp 65001 >nul
title ZhuDownLoader 新电脑环境安装
echo ============================================
echo   ZhuDownLoader 新电脑环境安装（只需跑一次）
echo   作用：下载文献下载所需的 Chromium 浏览器内核
echo ============================================
echo.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 【缺少 Node.js】请先安装：
  echo     打开 https://nodejs.org/ 下载 LTS 版，一路下一步
  echo     装完后重新双击本脚本
  echo.
  pause
  exit /b 1
)
echo [1/2] 检查下载依赖...
if not exist "node_modules\playwright" (
  echo   依赖缺失，正在 npm install（需要联网）...
  call npm install
  if errorlevel 1 (
    echo 【失败】npm install 出错，请截图报错内容求助
    pause
    exit /b 1
  )
) else (
  echo   依赖已随包自带，跳过
)
echo [2/2] 下载 Chromium 浏览器内核（约 150MB，需要联网，几分钟）...
call npx playwright install chromium
if errorlevel 1 (
  echo 【失败】Chromium 下载出错：请检查网络后重新双击本脚本
  pause
  exit /b 1
)
echo.
echo 【完成】环境就绪！以后双击「网页版下载.bat」即可使用
pause
