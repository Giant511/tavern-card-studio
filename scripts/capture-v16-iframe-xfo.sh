#!/usr/bin/env bash
# v0.1.6 缺陷二真因取证：iframe 被 X-Frame-Options 拦 vs 剥掉后正常
#
# 为什么必须有这两张图：真因是靠"同一台机器、同一份 ST、只差一个响应头"钉死的，
# 而不是靠推断。判据来自 CDP 的 `Network.loadingFailed`：
#   保留头 → net::ERR_BLOCKED_BY_RESPONSE
#   剥掉头 → 正常渲染（截图里能看到 ST 1.19.0 的顶栏与角色列表）
#
# 前提：本机 ST 在 127.0.0.1:8000；python 可用（起静态服务）
# 产出：assets/v016-05-iframe-xfo-blocked.png、v016-06-iframe-xfo-stripped.png
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PY="${PY:-python}"
CHROME="${CHROME:-C:/Program Files/Google/Chrome/Application/chrome.exe}"
STATIC_PORT="${STATIC_PORT:-8977}"
PLAIN_PORT="${PLAIN_PORT:-8899}"   # 保留 XFO 的反代
STRIP_PORT="${STRIP_PORT:-8898}"   # 剥掉 XFO 的反代

fail() { echo "✘ $*" >&2; exit 1; }
say() { echo "· $*"; }

[[ -x "$CHROME" || -f "$CHROME" ]] || fail "找不到 Chrome：$CHROME"

say "起静态服务 :$STATIC_PORT（父页面源）"
"$PY" -m http.server "$STATIC_PORT" --bind 127.0.0.1 --directory client/dist >/dev/null 2>&1 &
STATIC_PID=$!
trap 'kill $STATIC_PID 2>/dev/null || true' EXIT
sleep 2
curl -s --noproxy '*' -o /dev/null "http://127.0.0.1:$STATIC_PORT/index.html" || fail "静态服务没起来"

say "起两个对照反代（$PLAIN_PORT 保留 XFO / $STRIP_PORT 剥掉）"
PROBE_PORT="$PLAIN_PORT" node .verify/xfo/mini-proxy.mjs >/dev/null 2>&1 &
PLAIN_PID=$!
PROBE_PORT="$STRIP_PORT" node .verify/xfo/mini-proxy.mjs --strip >/dev/null 2>&1 &
STRIP_PID=$!
trap 'kill $STATIC_PID $PLAIN_PID $STRIP_PID 2>/dev/null || true' EXIT
sleep 2

# 头差异必须先确认 —— 两张图若无头差异，证明的就是别的东西了
plain_xfo=$(curl -s --noproxy '*' -D - -o /dev/null "http://127.0.0.1:$PLAIN_PORT/" | grep -ci 'x-frame-options' || true)
strip_xfo=$(curl -s --noproxy '*' -D - -o /dev/null "http://127.0.0.1:$STRIP_PORT/" | grep -ci 'x-frame-options' || true)
[[ "$plain_xfo" == "1" ]] || fail "对照组的 x-frame-options 应当是 1，实际 $plain_xfo"
[[ "$strip_xfo" == "0" ]] || fail "实验组的 x-frame-options 应当是 0，实际 $strip_xfo"
say "头差异确认：plain=$plain_xfo strip=$strip_xfo"

for pair in "blocked:$PLAIN_PORT" "stripped:$STRIP_PORT"; do
  tag="${pair%%:*}"
  port="${pair##*:}"
  cat > "client/dist/xfo-$tag.html" <<HTML
<!DOCTYPE html><html><head><meta charset="utf-8"><title>xfo-$tag</title>
<style>body{margin:0;font:13px/1.4 sans-serif}iframe{width:100%;height:560px;border:0}</style>
</head><body><div style="padding:6px 8px;background:#eee">直连代理端口 127.0.0.1:$port · $tag</div>
<iframe src="http://127.0.0.1:$port/"></iframe></body></html>
HTML
done

say "截图（CDP：等真实时间，不用 virtual-time —— ST 的定时器会被快进掉）"
node .verify/xfo/cdp-shot.mjs "http://127.0.0.1:$STATIC_PORT/xfo-blocked.html"  \
  "$ROOT/assets/v016-05-iframe-xfo-blocked.png"  16000 | tr -d '\n' | sed 's/^/  blocked: /'
echo
node .verify/xfo/cdp-shot.mjs "http://127.0.0.1:$STATIC_PORT/xfo-stripped.html" \
  "$ROOT/assets/v016-06-iframe-xfo-stripped.png" 16000 | tr -d '\n' | sed 's/^/  stripped: /'
echo

# 判据：两张图必须不同（相同说明两态没区别、截图无意义）
a=$(sha256sum assets/v016-05-iframe-xfo-blocked.png   | cut -d' ' -f1)
b=$(sha256sum assets/v016-06-iframe-xfo-stripped.png  | cut -d' ' -f1)
[[ "$a" != "$b" ]] || fail "两张截图哈希相同 —— 两态没差异，证明不了任何事"
say "两张图哈希不同：${a:0:12}… / ${b:0:12}…"
say "体量：$(stat -c %s assets/v016-05-iframe-xfo-blocked.png) / $(stat -c %s assets/v016-06-iframe-xfo-stripped.png) 字节"
say "✔ 取证完成"

# ── 追加：会话 cookie 跨站（缺陷三）────────────────────────────
#
# 判据来自反代日志里的 cookie=yes/NO 与 /api/settings/get 的状态码，
# 而不是"看起来能不能用"。两组对照：
#   只剥 XFO            → 全程 cookie=NO，POST /api/settings/get 403，页面卡「正在初始化…」
#   + SameSite=None     → cookie=yes，200，渲染出 ST 欢迎页
say "缺陷三取证：会话 cookie 跨站"
PROBE_PORT="$PLAIN_PORT" node .verify/csrf/diag-proxy.mjs --strip-xfo >.verify/csrf/base.log 2>&1 &
BASE_PID=$!
PROBE_PORT="$STRIP_PORT" node .verify/csrf/diag-proxy.mjs --strip-xfo --cookie-fix >.verify/csrf/fix.log 2>&1 &
FIX_PID=$!
trap 'kill $STATIC_PID $PLAIN_PID $STRIP_PID $BASE_PID $FIX_PID 2>/dev/null || true' EXIT
sleep 2

for tag in base fix; do
  port=$([ "$tag" = "base" ] && echo "$PLAIN_PORT" || echo "$STRIP_PORT")
  cat > "client/dist/csrf-$tag.html" <<HTML
<!DOCTYPE html><html><head><meta charset="utf-8"><title>csrf-$tag</title>
<style>body{margin:0;font:12px/1.3 sans-serif}iframe{width:100%;height:640px;border:0}</style>
</head><body><div style="padding:5px 8px;background:#eee">顶层 $STATIC_PORT · iframe 127.0.0.1:$port · $tag</div>
<iframe src="http://127.0.0.1:$port/"></iframe></body></html>
HTML
done

for tag in base fix; do
  node .verify/xfo/cdp-shot.mjs "http://localhost:$STATIC_PORT/csrf-$tag.html" \
    "$ROOT/assets/v016-0$([ "$tag" = "base" ] && echo 8 || echo 7)-pane-st-$([ "$tag" = "base" ] && echo csrf-blocked || echo loaded).png" \
    20000 >/dev/null
done

# 日志侧的硬判据：base 必须出现 403，fix 必须出现 200
grep -q 'POST /api/settings/get cookie=NO -> 403' .verify/csrf/base.log \
  || fail "基线组没有复现 403（cookie 没被拦住？那这组对照无效）"
grep -q 'POST /api/settings/get cookie=yes -> 200' .verify/csrf/fix.log \
  || fail "修复组没拿到 200 —— 说明 cookie 改写没生效"
say "日志对照成立：base 403/无 cookie，fix 200/有 cookie"
say "✔ 缺陷三取证完成"
