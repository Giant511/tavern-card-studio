#!/usr/bin/env bash
# 语音全链路录屏（v0.1.7 / T15.6）：按住 → 滑选 → 波形 → 松手 → 待确认。
#
# ## 为什么用 headless Chrome + CDP 而不是真机
#
# 范围第 9 条要求"四 Tab 中聊天 Tab 全流程截图 + 流式输出录屏"，
# 第 6 条要求手势"真机或模拟器，录屏证据"。
#
# 本机没有 Android 设备/模拟器（T15.3 用的是用户的真机 + adb）。
# 2026-10-30 与用户确认：截图与"打字机可见"用 headless Chrome 做，
# **手势的两条轨迹用 CDP 发真实 touch 事件**做逻辑对拍，
# 而"不被系统手势抢走"这一条只有真机能定论 —— 那部分留给用户按
# docs/t15.5-chat-panel.md §验收 跑。
#
# ## 产出
#
#   assets/t15.6-voice/01-recording-*.png  按住后的波形（多帧证明在动）
#   assets/t15.6-voice/02-mode-inner.png   滑选到「内心/动作」
#   assets/t15.6-voice/03-confirm-bar.png  待确认条
#
# 用法：bash scripts/capture-t156-voice.sh
#   前置：无（自动用 esbuild 打包 demo）

set -euo pipefail

# ★ 本地回环必须绕开代理。
#
# 本机环境里设了 `HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:64201`，于是
# node 的 `fetch('http://127.0.0.1:20772/json/list')` 被送进代理，
# 代理连不上就抛 `TypeError: fetch failed` —— 而脚本里没有 try/catch，
# 表现是**整条命令被 SIGTERM、一句话都不打印**（`tail` 拿不到已缓冲的输出），
# 排查时完全看不出是哪一步死的。curl 同理（返回 502）。
#
# 这类"环境变量把本地端口绕出去"的问题，症状总是「本地服务明明在跑却连不上」。
export NO_PROXY="127.0.0.1,localhost,::1"
export no_proxy="$NO_PROXY"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHOTS="$REPO/assets"
WORK="$REPO/.verify/chat-demo"
NODE="C:/Users/PC/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
PYTHON="C:/Users/PC/.workbuddy/binaries/python/versions/3.13.12/python.exe"

CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
[ -f "$CHROME" ] || CHROME="/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
[ -f "$CHROME" ] || { echo "找不到 Chrome" >&2; exit 2; }

mkdir -p "$SHOTS" "$WORK"

echo "== 1. 打包 demo（esbuild）=="
"$NODE" "$REPO/node_modules/esbuild/bin/esbuild" \
  "$REPO/client/src/chat/demo.ts" \
  --bundle --format=esm \
  --outfile="$WORK/demo.bundle.js" \
  --external:@tauri-apps/\* >/dev/null

# 把 CSS 与 HTML 复制到同一目录（demo.html 用相对路径引用它们）
cp "$REPO/client/src/chat/nebula-tokens.css" "$WORK/"
cp "$REPO/client/src/chat/chat.css" "$WORK/"
cp "$REPO/client/src/chat/demo.html" "$WORK/"

echo "== 2. 起本地静态服务 =="
#
# 为什么不用 `file://`：`<script type="module">` 在 file:// 下会被 CORS 拦掉
# （浏览器的同源策略把每个 file:// 视为独立源），表现是**页面白屏、
# 控制台一条 CORS 报错、而 Chrome 进程一切正常**。
# 第一版就是这么失败的：Chrome 日志里只有 libpng 警告，看不出任何问题。
PORT=20881
"$PYTHON" -m http.server "$PORT" --directory "$WORK" >"$WORK/http.log" 2>&1 &
HTTP_PID=$!
# 等端口就绪
for _ in $(seq 1 40); do
  if curl -s "http://127.0.0.1:$PORT/demo.html" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

echo "== 3. 启动 headless Chrome（CDP）=="
# 每次用**唯一**的 profile 目录，不删旧的。
# 为什么不是 rm -rf 复用同一个：本机的安全删除机制会拦截对 .verify 下目录的
# 递归删除（trash 操作失败后直接 fail-closed），脚本会在这一步停住。
# 用带时间戳的新目录既避开这个限制，也顺带保留上一次的运行现场便于对比。
PROFILE="$REPO/.verify/chrome-t156-$(date +%s)"
# 窗口尺寸必须与 demo 里 #phone 的 360×800 **完全一致**。
#
# 否则 body 的 flex 居中会在四周留黑边，截图里就分不清"黑边"与"界面边界" ——
# 我第一版用 420×860，看图时把输入区的正常位置误判成"被 Tab 栏挡住"，
# 白查了一轮。**截图工具的参数错误，会让人去改本来正确的代码。**
"$CHROME" \
  --headless=new \
  --remote-debugging-port=20772 \
  --user-data-dir="$PROFILE" \
  --window-size=360,800 \
  --hide-scrollbars \
  --force-device-scale-factor=2 \
  --disable-gpu \
  --no-first-run \
  "http://127.0.0.1:$PORT/demo.html" \
  >"$WORK/chrome.log" 2>&1 &
CHROME_PID=$!
trap 'kill $CHROME_PID $HTTP_PID 2>/dev/null || true' EXIT

# 等 CDP 就绪。**端口必须与上面 --remote-debugging-port 一致** ——
# 第一版这里写的是 20771（另一支脚本的端口），于是这个循环永远等不到，
# 白等 10 秒后继续跑。表面上"什么都正常"，只是启动慢了 10 秒，
# 这种错最难发现：没有报错、没有等待超时提示、功能全对。
CDP_PORT=20772
for _ in $(seq 1 40); do
  if curl -s "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

echo "== 4. 截图 + 录屏（CDP 脚本）=="
"$NODE" "$REPO/scripts/capture-t156-voice.mjs" \
  --port 20772 \
  --out "$SHOTS" \
  --work "$WORK"

echo "== 完成 =="
ls -1 "$SHOTS"/t15.6-voice/*.png 2>/dev/null | head -12 || true
