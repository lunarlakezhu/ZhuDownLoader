@echo off
chcp 65001 >nul
title ZhuDownLoader 批量文献下载（拖拽模式）
echo ============================================
echo   ZhuDownLoader - 批量文献 PDF 下载
echo   用法：把 DOI 清单文件（.txt）拖到这个图标上
echo   清单格式：每行一个 DOI，行内其余内容忽略
echo ============================================
echo.
if "%~1"=="" (
  echo 未拖入清单文件，进入交互模式...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0zhu-dl.ps1" -OpenManual
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0zhu-dl.ps1" -List "%~1" -OpenManual
)
echo.
echo 下载结束，按任意键关闭窗口...
pause >nul
