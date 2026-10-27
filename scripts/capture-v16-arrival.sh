#!/usr/bin/env bash
# v0.1.6 缺陷一的取证截图（到达规范化）。
#
# 两张图对**同一张卡、同一个自定义世界书预设**，只差"有没有做到达规范化"：
#   v016-01-arrival-before.png  复现旧行为：解析不传当前格式 + 跳过去达规范化
#                               ⇒ 世界书显示 @@ENTRY，审计按当前预设解析 ⇒ 1 错误
#   v016-02-arrival-after.png   现行路径：解析带当前格式 + arriveCard 规范化
#                               ⇒ 文本已按当前预设重排，0 错误、可导出
#
# ## 三个必须知道的点（与 capture-v15-g7.sh 同源）
#
# ① **必须走 http://**：`file://` 下模块脚本受 CORS 限制，`start()` 跑不完，
#    截出来是"加载中…"初始页。
# ② 样本卡取自 `examples/cards/`（仓库自带的公开样本，**不是用户内容**），
#    复制进 `client/dist/arrival/` 供演示入口 fetch；`build:client` 第 0 步会清掉。
# ③ 走 `?arrivalDemo=` 的**真实路径**（导入预设 → 切预设 → 解析 → 审计），
#    截图上的"1 错误 / 0 错误"是算出来的，不是摆出来的。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/client/dist"
SHOTS="$REPO/assets"
PROFILES="$REPO/.verify/chrome-profiles"
PORT=8978

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

mkdir -p "$SHOTS" "$PROFILES" "$DIST/arrival"
cp "$REPO/examples/cards/lin-wanzhao-v3.json" "$DIST/arrival/standard-card.json"
echo "样本卡：examples/cards/lin-wanzhao-v3.json → client/dist/arrival/standard-card.json"

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
  local profile="$PROFILES/arrival-$name-$$"
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
echo "到达规范化取证:"
shot "v016-01-arrival-before.png" "?sample=1&arrivalDemo=before"
shot "v016-02-arrival-after.png"  "?sample=1&arrivalDemo=after"

echo
echo "字节唯一性（两图必须不同，相同 = 只拍了一张）:"
first=""
for f in v016-01-arrival-before v016-02-arrival-after; do
  [ -f "$SHOTS/$f.png" ] || continue
  hash=$(sha256sum "$SHOTS/$f.png" | cut -c1-16)
  echo "  $hash  $f.png"
  if [ -z "$first" ]; then first="$hash"; elif [ "$hash" = "$first" ]; then
    echo "  ✘ 两张图字节相同 —— 演示入口没生效" >&2
    exit 1
  fi
done
echo
echo "完成。"
