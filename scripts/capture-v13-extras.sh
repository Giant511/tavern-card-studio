#!/usr/bin/env bash
# v0.1.3 追加项一/二 的交付截图（两新区 + 三板块高亮）。
#
# 为什么单独一个脚本：这几张图对应两个独立需求（预设体系 / 高亮覆盖），
# 混进 capture-t10x 等既有脚本会让"哪张图证明哪条要求"变得不可追溯。
#
# 产物：assets/preset-*.png（两新区）、assets/highlight-*.png（三板块）
#
# 用法：bash scripts/capture-v13-extras.sh
#
# 两个细节是踩过坑记住的：
#   ① 参数**不能**带 `?tlsDemo=` 之类不存在的键 —— 无害但会让人以为有入口；
#   ② 每张图用独立 chrome profile 且**不删**（批量删会撞 safe-delete 的 50 文件阈值）。

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/client/dist"
SHOTS="$REPO/assets"
PROFILES="$REPO/.verify/chrome-profiles"
PORT=8963

CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
if [ ! -f "$CHROME" ]; then
  CHROME="/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
fi
if [ ! -f "$CHROME" ]; then
  echo "找不到 Chrome，无法抓取截图。" >&2
  exit 2
fi
if [ ! -f "$DIST/index.html" ]; then
  echo "client/dist 不存在，请先 npm run build:ui" >&2
  exit 2
fi

mkdir -p "$SHOTS" "$PROFILES"

PY="C:/Users/PC/.workbuddy/binaries/python/versions/3.13.12/python.exe"
if [ ! -f "$PY" ]; then
  PY="$(command -v python || command -v python3)"
fi
"$PY" -m http.server "$PORT" --bind 127.0.0.1 --directory "$DIST" >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 25); do
  if curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/index.html" 2>/dev/null | grep -q 200; then
    break
  fi
  sleep 0.4
done

BASE="http://127.0.0.1:$PORT/index.html"

shot() {
  local name="$1" query="$2" size="${3:-1420,1000}"
  local profile="$PROFILES/extra-$name-$$"
  mkdir -p "$profile"
  "$CHROME" \
    --headless=new --disable-gpu --no-sandbox --no-first-run --hide-scrollbars \
    --force-device-scale-factor=2 \
    --user-data-dir="$profile" \
    --virtual-time-budget=14000 \
    --window-size="$size" \
    --screenshot="$SHOTS/$name" \
    "$BASE$query" >/dev/null 2>&1 || true
  if [ -f "$SHOTS/$name" ]; then
    echo "  $name  $(wc -c < "$SHOTS/$name") 字节"
  else
    echo "  $name  ✘ 没生成" >&2
  fi
}

echo "两新区截图（追加项一）:"
# 规则面板里的「初始场景预设」区块：下拉 + 摘要 + 导入/导出 + 来源说明。
#
# 视口刻意**比内容矮**（560）：面板会真的滚动，"滚到哪个区块"才有意义。
# 第一版用 1060 高，两个区块一屏装得下 → 两张图滚到同一个位置、
# 字节完全相同（212971）——那等于只拍了一张。
shot "preset-01-greeting.png" "?sample=1&rules=1&rulesSection=greeting" "1420,560"
# 「对话示例预设」区块（含"当前文本 N 轮"）
shot "preset-02-chat-examples.png" "?sample=1&rules=1&rulesSection=example" "1420,560"

echo "三板块高亮截图（追加项二）:"
# 每个场景只展开目标板块 —— 折叠会销毁编辑器，页面因此很短，不需要滚动
shot "highlight-01-worldbook.png" "?highlightDemo=worldbook" "1420,900"
shot "highlight-02-initial-scene.png" "?highlightDemo=initial-scene" "1420,900"
shot "highlight-03-chat-examples.png" "?highlightDemo=chat-examples" "1420,900"

echo "完成。产物在 assets/"
