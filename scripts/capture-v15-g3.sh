#!/usr/bin/env bash
# v0.1.5 / G3 三项缺陷的取证截图。
#
# 产物（assets/）：
#   g3-01-legacy-clean.png    审计面板：标准 ST 卡**没有**「旧格式卡片」提示
#   g3-02-blocked.png         导出面板：世界书格式不对 → 导出被硬阻断、按钮变灰
#   g3-03-worldbook-ok.png    同一个面板在世界书正常时**不**阻断
#
# 用法：npm run build:ui && bash scripts/capture-v15-g3.sh
#
# 两张世界书图都走**真实链路**：`?wbDemo=` 把文本喂进 `session.setBlockText`，
# 解析器、脏标记、校验、闸门全都真的跑一遍 —— 只是"输入"由脚本代劳。
# 这跟"为截图伪造一个界面状态"是两件事，后者会让截图证明不了任何东西。

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/client/dist"
SHOTS="$REPO/assets"
PROFILES="$REPO/.verify/chrome-profiles"
PORT=8965

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
  local name="$1" query="$2" size="${3:-1420,900}"
  local profile="$PROFILES/g3-$name-$$"
  mkdir -p "$profile"
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
    echo "  $name  ✘ 没生成" >&2
  fi
}

echo "G3 取证截图："
# ① 标准 ST 卡（sample 卡 first_mes / mes_example 都有内容）→ 审计面板不应出现旧格式提示
shot "g3-01-legacy-clean.png" "?sample=1" "1420,980"

# ② 世界书是外来格式 → 导出被硬阻断（按钮变灰，没有"仍要导出"）
shot "g3-02-blocked.png" "?sample=1&wbDemo=foreign&exportFace=1" "1420,980"

# ③ 同一张卡、同一个位置，世界书格式正确 → 不阻断（对照，证明不是"一律拦"）
shot "g3-03-worldbook-ok.png" "?sample=1&wbDemo=good&exportFace=1" "1420,980"

echo "完成。产物在 assets/"
