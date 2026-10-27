#!/usr/bin/env bash
# v0.1.4 / T12.5 卡面选择器的三态截图（默认 / 图库 / 原图）。
#
# 为什么单独一个脚本：这三张图对应决策 D4/D5 的两条语义（优先级、图库位置），
# 混进 v13 的脚本会让"哪张图证明哪条要求"不可追溯。
#
# 产物：assets/face-01-default.png / face-02-library.png / face-03-source.png
#
# 用法：bash scripts/capture-v14-faces.sh
#
# ## 一个必须说清的边界
#
# 浏览器里（无壳）**读不了本地文件**，所以图库与"原图"必然是空的。
# 为了让截图能证明网格布局与预览，脚本通过 `?faceDemo=` 注入演示候选；
# UI 上这些候选带「演示」角标，不会与真实数据混淆。
# **真实读盘能力不靠截图证明**：那是 `verify:*` 的 live 脚本与
# `test/contract-binary.test.mjs` / `test/png-roundtrip.test.mjs` 的事。
#
# ## 两个踩过的坑
#
# ① 视口必须**比内容矮**：否则"滚到卡面区段"两次落到同一个位置，两张图字节相同；
# ② 每张图用独立 chrome profile 且**不删**（批量删会撞 safe-delete 的阈值）。

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/client/dist"
SHOTS="$REPO/assets"
PROFILES="$REPO/.verify/chrome-profiles"
PORT=8964

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

# 演示用的默认卡面：复制进 dist 供页面 fetch。
# 它**不会进 MSI** —— build:client 的第 0 步会把整个 dist 归档重建，
# 这一步只服务于"截图时页面能取到一张真图"。
mkdir -p "$DIST/resources"
cp "$REPO/client/src-tauri/resources/card-face-default.png" "$DIST/resources/card-face-default.png"

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
  local name="$1" query="$2" size="${3:-1420,820}"
  local profile="$PROFILES/face-$name-$$"
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

echo "卡面选择器三态:"
# 默认态：内置默认卡面被预选（没有记忆、没有原图时的回落）
shot "face-01-default.png" "?sample=1&exportFace=1"
# 图库态：缩略图网格 + 演示角标 + 选中预览
shot "face-02-library.png" "?sample=1&exportFace=1&faceDemo=library"
# 原图态：有"当前卡的原图"这一项，且在记忆缺失时优先于默认卡面（决策 D4）
shot "face-03-source.png" "?sample=1&exportFace=1&faceDemo=source"

echo "完成。产物在 assets/"
echo "注意：图库/原图两张带「演示」角标 —— 浏览器读不了本地文件，数据是注入的。"
