#!/usr/bin/env bash
# 取证用：起静态服务 + headless Chrome，跑指定的 probe 脚本。
#
# 为什么合成一个脚本：分两次 Bash 调用时后台进程会被回收（curl 返回 000），
# 这个坑已经踩过两次（见 memory.md §58.4）。
#
# 用法：bash scripts/run-probe.sh scripts/probe-composer.mjs

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/client/dist"
PROBE="${1:-}"
# 脚本名之后的参数要原样转给 probe（`--out` / `--prefix` 等）。
# 不转发的话它们被静默丢弃，图落到默认目录 —— 表现为"改了 --out 却没生效"，
# 而且不报错（2026-10-31 踩过：以为写进了 fix-20261031，其实进了 assets/android）。
shift || true
NODE="C:/Users/PC/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
PYTHON="C:/Users/PC/.workbuddy/binaries/python/versions/3.13.12/python.exe"

export NO_PROXY="127.0.0.1,localhost,::1"
export no_proxy="$NO_PROXY"

[ -n "$PROBE" ] || { echo "用法: bash scripts/run-probe.sh <probe.mjs>" >&2; exit 2; }
[ -f "$DIST/mobile.html" ] || { echo "[FATAL] 先 npm run build:ui" >&2; exit 2; }

CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
[ -f "$CHROME" ] || CHROME="/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"

HTTP_PORT=20911
CDP_PORT=20912
PROFILE="$REPO/.verify/chrome-probe-$(date +%s)"
mkdir -p "$PROFILE"

cleanup() {
  [ -n "${CHROME_PID:-}" ] && kill "$CHROME_PID" 2>/dev/null || true
  [ -n "${HTTP_PID:-}" ] && kill "$HTTP_PID" 2>/dev/null || true
}
trap cleanup EXIT

"$PYTHON" -m http.server "$HTTP_PORT" --directory "$DIST" >"$PROFILE/http.log" 2>&1 &
HTTP_PID=$!
for _ in $(seq 1 40); do
  curl -s -o /dev/null "http://127.0.0.1:$HTTP_PORT/mobile.html" && break
  sleep 0.25
done

"$CHROME" --headless=new --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$PROFILE" --window-size=360,800 --hide-scrollbars \
  --force-device-scale-factor=2 --disable-gpu --no-first-run about:blank \
  >"$PROFILE/chrome.log" 2>&1 &
CHROME_PID=$!
for _ in $(seq 1 60); do
  curl -s -o /dev/null "http://127.0.0.1:$CDP_PORT/json/version" && break
  sleep 0.25
done

"$NODE" "$REPO/$PROBE" --port "$CDP_PORT" --http-port "$HTTP_PORT" "$@"
exit $?
