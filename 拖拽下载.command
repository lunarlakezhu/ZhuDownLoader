#!/bin/bash
# ZhuDownLoader 批量文献下载（拖拽/双击模式，对应 Windows 的 拖拽下载.bat）
# 用法：双击本文件；清单路径可以直接把 .txt 文件拖进终端窗口再回车。
# （macOS 不支持把文件拖到图标上传参，拖进终端窗口是等效操作。）
cd "$(dirname "$0")" || exit 1
echo "============================================"
echo "  ZhuDownLoader - 批量文献 PDF 下载"
echo "  清单格式：每行一个 DOI，行内其余内容忽略"
echo "============================================"
echo
if [ -n "$1" ]; then
  ./zhu-dl.sh -l "$1"
else
  ./zhu-dl.sh
fi
echo
echo "下载结束，按回车关闭窗口..."
read -r
