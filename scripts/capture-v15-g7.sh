#!/usr/bin/env bash
# G7 世界书"常驻"误报的取证截图（v0.1.5）
#
# 两张图对同一份用户数据（19 条：持续 7 + 关键词 12），只差规则：
#   g7-01-before.png  修复前：持续型条目被两条规则误报（7 用户 + 7 内置 = 14）
#   g7-02-after.png   修复后：`when` 用 priority 的"不存在"排除持续型，条目文本未改
#
# ## 三个必须知道的点
#
# ① **夹具是用户真实内容，只在 `client/dist/g7/` 里**（`gen-g7-fixtures.mjs` 生成）。
#    `build:client` 的第 0 步会清掉整个 dist，所以它不会被装进 MSI；也不进仓库。
# ② **必须走 http://**：`file://` 下模块脚本受 CORS 限制，`start()` 跑不完，
#    截出来是"加载中…"初始页（这个坑已经踩过两次）。
# ③ 走 `?auditDemo=` 的**真实路径**（导入预设 → 切规则 → 写世界书 → 审计），
#    截图上的数字是算出来的。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/client/dist"
SHOTS="$REPO/assets"
PROFILES="$REPO/.verify/chrome-profiles"
PORT=8968

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

echo "生成 G7 夹具："
node "$REPO/scripts/gen-g7-fixtures.mjs"

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
  local profile="$PROFILES/g7-$name-$$"
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
echo "G7 误报取证:"
shot "g7-01-before.png" "?sample=1&auditDemo=before"
shot "g7-02-after.png"  "?sample=1&auditDemo=after"

echo
echo "字节唯一性（两图必须不同）:"
first=""
for f in g7-01-before g7-02-after; do
  [ -f "$SHOTS/$f.png" ] || continue
  hash=$(sha256sum "$SHOTS/$f.png" | cut -c1-16)
  echo "  $hash  $f.png"
  if [ -z "$first" ]; then
    first="$hash"
  elif [ "$hash" = "$first" ]; then
    echo "  x 两图字节相同 —— 参数没生效，只拍到了同一种状态"
  fi
done
