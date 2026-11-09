#!/usr/bin/env bash
# 移动端入口验收（v0.1.7 / T15.3 接线）。
#
# ## 验什么
#
# 2026-10-31 用户装完 APK 发现"打开是桌面编辑器"，根因是 T15.5 的移动 UI
# （`chat/`）从来没接进入口。这个脚本把"入口真的接上了"钉成可复跑的判据：
#
#   · `dist/mobile.html` 存在且能渲染出四 Tab；
#   · 里面**没有**桌面编辑器的东西（顶栏/审计面板/角色名控件）；
#   · Android UA 打开 `index.html` 会被重定向到 `mobile.html`；
#   · 桌面 UA 打开 `index.html` 不跳，仍是编辑器。
#
# ## 为什么服务和 Chrome 都在本脚本里起
#
# 用 `(... &)` 起后台进程再开一个 Bash 调用去连，进程会被回收 ——
# 实测两次都是 `curl` 返回 000。所以起服务 → 起 Chrome → 跑断言 → 收尾，
# 必须在**同一次调用**里完成，用 trap 兜住退出。
#
# 用法：bash scripts/verify-mobile-entry.sh [--keep]
#   前置：已 `npm run build:ui`（脚本会检查 dist/mobile.html）

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/client/dist"
NODE="C:/Users/PC/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
PYTHON="C:/Users/PC/.workbuddy/binaries/python/versions/3.13.12/python.exe"

# 回环绕开代理：本机 HTTP_PROXY 会把 127.0.0.1 也代理走
export NO_PROXY="127.0.0.1,localhost,::1"
export no_proxy="$NO_PROXY"

if [ ! -f "$DIST/mobile.html" ]; then
  echo "[FATAL] 没有 $DIST/mobile.html —— 先跑 npm run build:ui" >&2
  exit 2
fi

CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
[ -f "$CHROME" ] || CHROME="/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
[ -f "$CHROME" ] || { echo "[FATAL] 找不到 Chrome" >&2; exit 2; }

HTTP_PORT=20901
CDP_PORT=20902

# 每次都换新 profile 目录：复用会带上旧缓存，而且安全删除机制会拦 rm -rf
PROFILE="$REPO/.verify/chrome-mobile-$(date +%s)"
mkdir -p "$PROFILE"

cleanup() {
  [ -n "${CHROME_PID:-}" ] && kill "$CHROME_PID" 2>/dev/null || true
  [ -n "${HTTP_PID:-}" ] && kill "$HTTP_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "== 起静态服务（$HTTP_PORT）=="
"$PYTHON" -m http.server "$HTTP_PORT" --directory "$DIST" >"$PROFILE/http.log" 2>&1 &
HTTP_PID=$!
for _ in $(seq 1 40); do
  curl -s -o /dev/null "http://127.0.0.1:$HTTP_PORT/mobile.html" && break
  sleep 0.25
done
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$HTTP_PORT/mobile.html")
if [ "$code" != "200" ]; then
  echo "[FATAL] 静态服务没起来（HTTP $code）" >&2
  exit 3
fi
echo "  mobile.html HTTP $code"

echo "== 起 headless Chrome（CDP $CDP_PORT）=="
"$CHROME" \
  --headless=new \
  --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$PROFILE" \
  --window-size=360,800 \
  --hide-scrollbars \
  --force-device-scale-factor=2 \
  --disable-gpu \
  --no-first-run \
  about:blank \
  >"$PROFILE/chrome.log" 2>&1 &
CHROME_PID=$!

for _ in $(seq 1 60); do
  curl -s -o /dev/null "http://127.0.0.1:$CDP_PORT/json/version" && break
  sleep 0.25
done
if ! curl -s -o /dev/null "http://127.0.0.1:$CDP_PORT/json/version"; then
  echo "[FATAL] CDP 没起来" >&2
  exit 4
fi

echo "== 跑断言 =="
"$NODE" "$REPO/scripts/verify-mobile-entry.mjs" --port "$CDP_PORT" --http-port "$HTTP_PORT"
RC=$?

if [ "${1:-}" != "--keep" ]; then
  : # trap 收尾
fi

exit $RC
