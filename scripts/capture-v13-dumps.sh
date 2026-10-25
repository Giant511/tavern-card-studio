#!/usr/bin/env bash
# 三板块高亮的**浏览器侧**快照（v0.1.3 追加项二）。
#
# 为什么截图之外还要 DOM 快照：缩略图上"浅蓝 vs 深蓝"根本分不清，
# 而高亮失效的方式恰恰是**静默**的（appliesTo 拼错 → 规则永不命中 → 不报错）。
# 快照里能直接读到 `<span class="tcs-hl tcs-hl-heading" data-rule="worldbook-entry-open">`，
# 那是"这条规则真的作用到了这个板块"的确凿证据。
#
# 产物：.verify/v13-dumps/<场景>.html → 由 scripts/verify-v13-extras.mjs 断言
#
# 用法：bash scripts/capture-v13-dumps.sh

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/client/dist"
DUMPS="$REPO/.verify/v13-dumps"
PROFILES="$REPO/.verify/chrome-profiles"
PORT=8964

CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
if [ ! -f "$CHROME" ]; then
  CHROME="/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
fi
if [ ! -f "$CHROME" ]; then
  echo "找不到 Chrome，无法抓取快照。" >&2
  exit 2
fi
if [ ! -f "$DIST/index.html" ]; then
  echo "client/dist 不存在，请先 npm run build:ui" >&2
  exit 2
fi

mkdir -p "$DUMPS" "$PROFILES"

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

capture() {
  local name="$1" query="$2"
  local profile="$PROFILES/v13-$name-$$"
  mkdir -p "$profile"
  "$CHROME" \
    --headless=new --disable-gpu --no-sandbox --no-first-run --hide-scrollbars \
    --user-data-dir="$profile" \
    --virtual-time-budget=12000 \
    --dump-dom \
    "$BASE$query" > "$DUMPS/$name.html" 2>/dev/null || true
  echo "  $name.html  $(wc -c < "$DUMPS/$name.html") 字节"
}

echo "抓取三板块高亮的 DOM 快照:"
capture hl-worldbook      "?highlightDemo=worldbook"
capture hl-initial-scene  "?highlightDemo=initial-scene"
capture hl-chat-examples  "?highlightDemo=chat-examples"

echo "完成。产物在 .verify/v13-dumps/"
