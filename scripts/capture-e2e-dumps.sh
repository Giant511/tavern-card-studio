#!/usr/bin/env bash
# 生成端到端测试所需的 DOM 快照与截图。
#
# 为什么用 shell 直接调 Chrome，而不是让 Node 脚本 spawn：
#   本机 Node 无法 spawn 任何子进程（`spawnSync('cmd.exe', ...)` 都返回 EBUSY，
#   git / chrome 同理）。shell 直接调用是唯一可靠路径。
#
# 产物：
#   .verify/e2e-dumps/<场景>.html    给 scripts/verify-e2e.mjs 做断言
#   docs/assets/e2e-*.png            给交付文档引用
#
# 用法：bash scripts/capture-e2e-dumps.sh

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/client/dist"
DUMPS="$REPO/.verify/e2e-dumps"
SHOTS="$REPO/docs/assets"
PORT=8942

CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
if [ ! -f "$CHROME" ]; then
  CHROME="/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
fi
if [ ! -f "$CHROME" ]; then
  echo "找不到 Chrome，无法抓取快照。" >&2
  exit 2
fi
if [ ! -f "$DIST/index.html" ]; then
  echo "client/dist 不存在，请先 npm run build:ui -w @tcs/client" >&2
  exit 2
fi

mkdir -p "$DUMPS" "$SHOTS"

# 静态服务（Python 起，避免额外依赖）
PY="C:/Users/PC/.workbuddy/binaries/python/versions/3.13.12/python.exe"
if [ ! -f "$PY" ]; then
  PY="$(command -v python || command -v python3)"
fi
"$PY" -m http.server "$PORT" --bind 127.0.0.1 --directory "$DIST" >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

# 等端口就绪
for _ in $(seq 1 20); do
  if curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/index.html" 2>/dev/null | grep -q 200; then
    break
  fi
  sleep 0.5
done

BASE="http://127.0.0.1:$PORT/index.html"

# capture <名字> <query> [额外 chrome 参数…]
capture() {
  local name="$1" query="$2"
  shift 2
  local profile="$REPO/.verify/chrome-$name-$$"
  rm -rf "$profile"
  "$CHROME" \
    --headless=new \
    --disable-gpu \
    --no-sandbox \
    --no-first-run \
    --hide-scrollbars \
    --user-data-dir="$profile" \
    --virtual-time-budget=13000 \
    "$@" \
    --dump-dom \
    "$BASE$query" > "$DUMPS/$name.html" 2>/dev/null || true
  rm -rf "$profile"
  local bytes
  bytes=$(wc -c < "$DUMPS/$name.html")
  echo "  $name.html  $bytes 字节"
}

shot() {
  local name="$1" query="$2" size="${3:-1420,940}"
  local profile="$REPO/.verify/chrome-shot-$name-$$"
  rm -rf "$profile"
  "$CHROME" \
    --headless=new \
    --disable-gpu \
    --no-sandbox \
    --no-first-run \
    --hide-scrollbars \
    --force-device-scale-factor=2 \
    --user-data-dir="$profile" \
    --virtual-time-budget=13000 \
    --window-size="$size" \
    --screenshot="$SHOTS/$name" \
    "$BASE$query" >/dev/null 2>&1 || true
  rm -rf "$profile"
  echo "  $name  已生成"
}

echo "抓取 DOM 快照："
capture default          ""
capture export-blocked   "?export=1&forceError=1"
capture rules-dialog     "?rules=1"
capture platform-janitorai "?platform=janitorai"
capture apply-divider    "?applyPreset=divider&expand=all"
# F8：渲染预览（覆盖「打开 / 重复 10 次 / 打开期间可输入 / 顶栏按钮全扫」）
capture preview-open     "?preview=open"
# F6.1/F6.3：一键连接本机服务端（成功态需要 127.0.0.1:8730 上有本版本服务端在跑）
capture settings-local   "?settings=1&localConnect=1"
capture preview-cycle10  "?preview=cycle10"
capture preview-typing   "?preview=typing"
capture preview-sweep    "?preview=sweep"

echo "生成截图："
shot e2e-editor.png      ""
shot e2e-all-blocks.png  "?expand=all"
shot e2e-export-gate.png "?export=1&forceError=1"
shot e2e-rules.png       "?rules=1"
shot e2e-preview-open.png "?preview=open"

echo "完成。快照在 .verify/e2e-dumps/，截图在 docs/assets/。"
