# ZhuDownLoader 批量文献下载入口（PowerShell 薄壳）
# 用法:
#   .\zhu-dl.ps1 -List 清单.txt -OutDir 输出目录 [-Concurrency 2] [-Retries 1] [-Plain] [-OpenManual]
#   .\zhu-dl.ps1                # 无参数进入交互模式（逐行提问）
# 编排/并发/看板全部在 node batch_download.mjs 内完成，本脚本只做入口。
param(
  [string]$List,
  [string]$OutDir,
  [int]$Concurrency = 2,
  [int]$Retries = 1,
  [switch]$Plain,
  [switch]$OpenManual
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DEFAULT_OUT = Join-Path $env:USERPROFILE 'Downloads\ZhuDownLoader'

# 编码：chcp 65001 + UTF-8 输出，中文与看板符号不乱码
chcp 65001 | Out-Null
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

# node 环境检查
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "❌ 未找到 node，请先安装 Node.js（https://nodejs.org）" -ForegroundColor Red
  exit 1
}
$batchScript = Join-Path $scriptDir 'batch_download.mjs'
if (-not (Test-Path -LiteralPath $batchScript)) {
  Write-Host "❌ 缺少 $batchScript" -ForegroundColor Red
  exit 1
}

# 交互模式（未传 -List 时），模仿 PDF2md 逐行提问
$interactive = -not $List
if ($interactive) {
  Write-Host "============================================"
  Write-Host "  ZhuDownLoader - 批量文献 PDF 下载"
  Write-Host "  清单格式: 每行一个 DOI（行内其余内容忽略）"
  Write-Host "============================================"
  $List = Read-Host "清单文件路径（可拖入文件）"
  if (-not $List) { Write-Host "❌ 未提供清单文件" -ForegroundColor Red; exit 1 }
}
$List = $List.Trim().Trim('"')
if ($interactive -and -not $OutDir) {
  $OutDir = Read-Host "输出目录（直接回车用默认：$DEFAULT_OUT）"
}

# 相对路径 → 绝对路径（传给 node，避免其 cwd 与 PowerShell 不一致）
if (-not [System.IO.Path]::IsPathRooted($List)) { $List = Join-Path (Get-Location).Path $List }
if (-not $OutDir) { $OutDir = $DEFAULT_OUT }
if (-not [System.IO.Path]::IsPathRooted($OutDir)) { $OutDir = Join-Path (Get-Location).Path $OutDir }

if (-not (Test-Path -LiteralPath $List)) {
  Write-Host "❌ 清单文件不存在: $List" -ForegroundColor Red
  exit 1
}

$nodeArgs = @($batchScript, $List, $OutDir, '--concurrency', "$Concurrency", '--retries', "$Retries")
if ($Plain) { $nodeArgs += '--plain' }
if ($OpenManual) { $nodeArgs += '--open-manual' }

& node @nodeArgs
exit $LASTEXITCODE
