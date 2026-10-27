#!/usr/bin/env bash
# 另存为格式选择对话框的截图（v0.1.5 / G6）
#
# 两张图各证明一件不同的事，字节必须互不相同：
#   g6-01  三选项齐全、JSON 预选（默认态，PNG 可用）
#   g6-02  PNG 被禁用并写明原因（浏览器无壳的降级态）
#
# 只抓两张：再加一个"选中某项"的图意义不大 —— 选中态的视觉差异在
# `is-active` 一个类上，用 --dump-dom 断言比截图更可靠。
#
# ## 三个踩过的坑（都写在这里，下次别再踩）
#
# ① **必须走 http://，不能用 file://**。用 `file://` 截出来的是"加载中…"
#    的初始页：模块脚本在 file 协议下受 CORS 限制，`start()` 根本没跑完，
#    所以对话框不会出现 —— 而这张图看起来像"功能没实现"。
# ② **前端产物在 `client/dist`**，不是仓库根 `dist`。
# ③ **视口要比内容矮**：否则"滚到某块"两次落到同一位置，两张图字节相同。
#
# 浏览器直开没有壳能力，所以走 `?saveFormatDemo=1` 这个入口 —— 它只打开
# 格式选择框，不做任何写盘（否则会弹系统对话框卡住 headless）。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/client/dist"
SHOTS="$REPO/assets"
PROFILES="$REPO/.verify/chrome-profiles"
PORT=8966

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
  local name="$1" query="$2" size="${3:-1440,900}"
  local profile="$PROFILES/savefmt-$name-$$"
  mkdir -p "$profile"
  rm -f "$SHOTS/$name"
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
    echo "  $name  x 没生成" >&2
  fi
}

echo "另存为格式对话框:"
shot "g6-01-save-format.png"         "?sample=1&saveFormatDemo=1"
shot "g6-02-save-format-blocked.png" "?sample=1&saveFormatDemo=1&saveFormatPng=off"

echo
echo "字节唯一性（两张必须互不相同）:"
first=""
for f in g6-01-save-format g6-02-save-format-blocked; do
  [ -f "$SHOTS/$f.png" ] || continue
  hash=$(sha256sum "$SHOTS/$f.png" | cut -c1-16)
  echo "  $hash  $f.png"
  if [ -z "$first" ]; then
    first="$hash"
  elif [ "$hash" = "$first" ]; then
    echo "  x 两张图字节相同 —— 参数没生效，只拍到了同一种状态"
  fi
done
