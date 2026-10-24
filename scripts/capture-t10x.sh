#!/usr/bin/env bash
# v0.1.2 测试反馈四项的浏览器侧证据采集（T10.27 / T10.28 / T10.29）。
#
# 为什么单独一个脚本而不是并进 capture-e2e-dumps.sh：
#   那个脚本是"阶段 8 全流程"的证据链，改动它就得同步改 verify-e2e.mjs 的断言；
#   而这四项各自有独立的验证脚本（本文件 + verify-t10x.mjs），
#   混在一起会让"哪条证据属于哪个任务"变得不可追溯。
#
# 为什么用 shell 直接调 Chrome：本机 Node 无法 spawn 任何子进程（EBUSY）。
#
# 产物：
#   .verify/t10x-dumps/<场景>.html   给 scripts/verify-t10x.mjs 断言
#   assets/t10x-*.png                给 README / 交付说明引用
#
# 用法：bash scripts/capture-t10x.sh

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/client/dist"
DUMPS="$REPO/.verify/t10x-dumps"
SHOTS="$REPO/assets"
PORT=8951

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

PY="C:/Users/PC/.workbuddy/binaries/python/versions/3.13.12/python.exe"
if [ ! -f "$PY" ]; then
  PY="$(command -v python || command -v python3)"
fi
"$PY" -m http.server "$PORT" --bind 127.0.0.1 --directory "$DIST" >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 20); do
  if curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/index.html" 2>/dev/null | grep -q 200; then
    break
  fi
  sleep 0.5
done

BASE="http://127.0.0.1:$PORT/index.html"

# capture <名字> <query> —— 只存 DOM，不存截图
capture() {
  local name="$1" query="$2"
  local profile="$REPO/.verify/chrome-t10x-$name-$$"
  rm -rf "$profile"
  "$CHROME" \
    --headless=new --disable-gpu --no-sandbox --no-first-run --hide-scrollbars \
    --user-data-dir="$profile" \
    --virtual-time-budget=11000 \
    --dump-dom \
    "$BASE$query" > "$DUMPS/$name.html" 2>/dev/null || true
  rm -rf "$profile"
  echo "  $name.html  $(wc -c < "$DUMPS/$name.html") 字节"
}

# shot <文件名> <query> [尺寸]
shot() {
  local name="$1" query="$2" size="${3:-1420,940}"
  local profile="$REPO/.verify/chrome-t10x-shot-$name-$$"
  rm -rf "$profile"
  "$CHROME" \
    --headless=new --disable-gpu --no-sandbox --no-first-run --hide-scrollbars \
    --force-device-scale-factor=2 \
    --user-data-dir="$profile" \
    --virtual-time-budget=11000 \
    --window-size="$size" \
    --screenshot="$SHOTS/$name" \
    "$BASE$query" >/dev/null 2>&1 || true
  rm -rf "$profile"
  echo "  $name  已生成"
}

echo "抓取 DOM 快照（T10.27 三种样本）:"
# expand=all：折叠板块是**销毁编辑器**的（懒渲染红线），
# 不展开就看不出【其他设定】里到底装了什么。
capture import-zero  "?import=zero&expand=all"
capture import-mixed "?import=mixed&expand=all"
capture import-clean "?import=clean&expand=all"
# 导入对话框本身（含保全结论与模式说明）
capture import-dialog-mixed "?importPreview=mixed"

echo "抓取 DOM 快照（T10.29 改名提示两态）:"
capture name-hint-show "?sample=1&nameHint=show"
capture name-hint-hide "?sample=1&nameHint=hide"

echo "抓取 DOM 快照（T10.26 异常注入）:"
capture crash-injected "?sample=1&crashInject=1"

echo "生成截图:"
shot t1027-import-zero.png      "?import=zero&expand=all"
shot t1027-import-mixed.png     "?import=mixed&expand=all"
shot t1027-import-dialog.png    "?importPreview=mixed"
shot t1029-name-hint-show.png   "?sample=1&nameHint=show"
shot t1029-name-hint-hide.png   "?sample=1&nameHint=hide"

echo "完成。快照在 .verify/t10x-dumps/，截图在 assets/。"
