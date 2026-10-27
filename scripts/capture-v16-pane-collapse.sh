#!/usr/bin/env bash
# v0.1.6 真机缺陷四的取证截图（收起后无法展开）。
#
# 两张图走的是**同一个按钮**的两次状态：
#   v016-03-pane-collapsed.png   折叠态：约 56px 竖条，按钮显示「⟨」
#   v016-04-pane-expanded-again.png  **点了「⟨」之后**：面板重新展开、宽度回到记忆值
#
# ## 为什么第二张能证明"展开按钮能用"
#
# `?collapseRoundTrip=1` 走的是**真实 click**（`[data-role="st-pane-toggle"]`），
# 不是直接调 `setCollapsed` —— 缺陷四是"按钮绑定写死成 setCollapsed(true)"，
# 绕过按钮就等于绕过缺陷，那样截出来的图永远是对的。
# 状态栏会打出「折叠宽 56（符号「⟨」）→ 点击后 已展开，宽 460（记忆值 460）」，
# 这句话本身就是断言结果。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/client/dist"
SHOTS="$REPO/assets"
PROFILES="$REPO/.verify/chrome-profiles"
PORT=8979

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
  if curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/index.html" 2>/dev/null | grep -q 200; then
    break
  fi
  sleep 0.4
done

BASE="http://127.0.0.1:$PORT/index.html"

shot() {
  local name="$1" query="$2" size="${3:-1440,900}"
  local profile="$PROFILES/collapse-$name-$$"
  mkdir -p "$profile"
  rm -f "$SHOTS/$name"
  "$CHROME" \
    --headless=new --disable-gpu --no-sandbox --no-first-run --hide-scrollbars \
    --force-device-scale-factor=2 \
    --user-data-dir="$profile" \
    --virtual-time-budget=16000 \
    --window-size="$size" \
    --screenshot="$SHOTS/$name" \
    "$BASE$query" >/dev/null 2>&1 || true
  if [ -f "$SHOTS/$name" ]; then
    echo "  $name  $(wc -c < "$SHOTS/$name") 字节"
  else
    echo "  $name  x 没生成" >&2
  fi
}

echo
echo "收起/展开取证:"
shot "v016-03-pane-collapsed.png" "?sample=1&stPane=1&collapsed=1"
shot "v016-04-pane-expanded-again.png" "?sample=1&stPane=1&collapseRoundTrip=1"

echo
echo "字节唯一性（两图必须不同，相同 = 只拍了一张）:"
first=""
for f in v016-03-pane-collapsed v016-04-pane-expanded-again; do
  [ -f "$SHOTS/$f.png" ] || continue
  hash=$(sha256sum "$SHOTS/$f.png" | cut -c1-16)
  echo "  $hash  $f.png"
  if [ -z "$first" ]; then first="$hash"; elif [ "$hash" = "$first" ]; then
    echo "  ✘ 两张图字节相同 —— 状态没变化" >&2
    exit 1
  fi
done

echo
echo "展开按钮是否真的起作用（状态栏原文）:"
"$CHROME" --headless=new --disable-gpu --no-sandbox --no-first-run \
  --user-data-dir="$PROFILES/probe-$$" --virtual-time-budget=16000 --dump-dom \
  "$BASE?sample=1&stPane=1&collapseRoundTrip=1" 2>/dev/null \
  | grep -o 'id="status"[^>]*>[^<]*' | head -1 || true
