#!/bin/bash
# ZhuDownLoader 批量文献下载入口（macOS/Linux 薄壳，对应 Windows 的 zhu-dl.ps1）
# 用法:
#   ./zhu-dl.sh -l 清单.txt -o 输出目录 [-c 2] [-r 1] [--plain] [--open-manual]
#   ./zhu-dl.sh              # 无参数进入交互模式（逐行提问）
# 编排/并发/看板全部在 node batch_download.mjs 内完成，本脚本只做入口。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_OUT="$HOME/Downloads/ZhuDownLoader"

LIST=""
OUTDIR=""
CONCURRENCY=2
RETRIES=1
EXTRA=""

usage() {
  echo "用法: ./zhu-dl.sh -l 清单.txt [-o 输出目录] [-c 并发] [-r 重试] [--plain] [--open-manual]"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -l) LIST="${2:-}"; shift 2 ;;
    -o) OUTDIR="${2:-}"; shift 2 ;;
    -c) CONCURRENCY="${2:-2}"; shift 2 ;;
    -r) RETRIES="${2:-1}"; shift 2 ;;
    --plain|--open-manual) EXTRA="$EXTRA $1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1"; usage; exit 2 ;;
  esac
done

# node 环境检查
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未找到 node，请先安装 Node.js（https://nodejs.org 下载 LTS 版）"
  exit 1
fi
if [ ! -f "$SCRIPT_DIR/batch_download.mjs" ]; then
  echo "❌ 缺少 $SCRIPT_DIR/batch_download.mjs"
  exit 1
fi

# 交互模式（未传 -l 时）
if [ -z "$LIST" ]; then
  echo "============================================"
  echo "  ZhuDownLoader - 批量文献 PDF 下载"
  echo "  清单格式: 每行一个 DOI（行内其余内容忽略）"
  echo "============================================"
  printf "清单文件路径（可把文件拖进本窗口再回车）: "
  read -r LIST
  if [ -z "$LIST" ]; then
    echo "❌ 未提供清单文件"
    exit 1
  fi
fi
LIST="$(echo "$LIST" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//')"
# 拖进终端的路径若含空格会被转义成「\ 空格」，还原成普通空格
LIST="${LIST//\\ / }"
if [ -z "$OUTDIR" ]; then
  printf "输出目录（直接回车用默认：%s）: " "$DEFAULT_OUT"
  read -r OUTDIR
fi

# 相对路径 → 绝对路径（node 以脚本目录为 cwd）
case "$LIST" in /*) ;; *) LIST="$(pwd)/$LIST" ;; esac
if [ -z "$OUTDIR" ]; then OUTDIR="$DEFAULT_OUT"; fi
case "$OUTDIR" in /*) ;; *) OUTDIR="$(pwd)/$OUTDIR" ;; esac

if [ ! -f "$LIST" ]; then
  echo "❌ 清单文件不存在: $LIST"
  exit 1
fi

cd "$SCRIPT_DIR"
# shellcheck disable=SC2086
node batch_download.mjs "$LIST" "$OUTDIR" --concurrency "$CONCURRENCY" --retries "$RETRIES" $EXTRA
exit $?
