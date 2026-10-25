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
PROFILES="$REPO/.verify/chrome-profiles"
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

mkdir -p "$DUMPS" "$SHOTS" "$PROFILES"

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
#
# 注意：**不要**在这里 rm -rf profile 目录。单个 profile 有近 200 个文件，
# 批量删除会撞上本机的 safe-delete 钩子（阈值 50 个），脚本直接中断、
# 表现为「抓取到第一个场景就停了」。
# 代价是 .verify/chrome-profiles/ 会累积（该目录已被 .gitignore 忽略），
# 每次抓取用新的 PID 子目录，保证不同轮次之间不串会话状态。
capture() {
  local name="$1" query="$2"
  shift 2
  local profile="$PROFILES/$name-$"
  mkdir -p "$profile"
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
  local bytes
  bytes=$(wc -c < "$DUMPS/$name.html")
  echo "  $name.html  $bytes 字节"
}

shot() {
  local name="$1" query="$2" size="${3:-1420,940}"
  local profile="$PROFILES/shot-$name-$"
  mkdir -p "$profile"
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
  echo "  $name  已生成"
}

# 每个需要「一张有内容的卡」的场景都必须带 ?sample=1。
#
# 这里曾经全部不带 —— 于是所有快照与截图抓到的都是**空工作台**（F3 之后
# 启动不再自动载入样例卡），verify-e2e 的「六个板块已渲染」断言一直是 0 个却没人发现：
# 那个脚本要手工跑，不在 npm test 链上。带 sample=1 之后，快照里才真的有卡。
echo "抓取 DOM 快照："
capture default          "?sample=1"
capture export-blocked   "?sample=1&export=1&forceError=1"
capture rules-dialog     "?sample=1&rules=1"
capture platform-janitorai "?sample=1&platform=janitorai"
capture apply-divider    "?sample=1&applyPreset=divider&expand=all"
# F8：渲染预览（覆盖「打开 / 重复 10 次 / 打开期间可输入 / 顶栏按钮全扫」）
capture preview-open     "?sample=1&preview=open"
# F6.1/F6.3：一键连接本机服务端（成功态需要 127.0.0.1:8730 上有本版本服务端在跑）
capture settings-local   "?sample=1&settings=1&localConnect=1"
capture preview-cycle10  "?sample=1&preview=cycle10"
capture preview-typing   "?sample=1&preview=typing"
capture preview-sweep    "?sample=1&preview=sweep"

# ── v0.1.3 / 6c：八板块界面（四张）──────────────────────────
# 默认视图：前两块展开、其余六块折叠（常驻 CM6 = 2）
capture eight-default    "?sample=1"
# 只展开两个新板块：用于确认「字段板块走文本编辑器路径」真的能编辑
capture eight-new-blocks "?sample=1&expand=chat-examples,initial-scene"
# 全展开：一眼看全八个板块的顺序（字数分布也在同一屏）
capture eight-all        "?sample=1&expand=all"
# 审计面板：新板块的筛选下拉项与八条字数分布
capture eight-audit      "?sample=1&export=1&forceError=1"

echo "生成截图："
shot e2e-editor.png      "?sample=1"
shot e2e-all-blocks.png  "?sample=1&expand=all"
shot e2e-export-gate.png "?sample=1&export=1&forceError=1"
shot e2e-rules.png       "?sample=1&rules=1"
shot e2e-preview-open.png "?sample=1&preview=open"

# v0.1.3 / 6c 八张验收截图（要求 6）
echo "生成 6c 验收截图："
# ① 默认视图：两展开六折叠
shot c6-01-default.png        "?sample=1"
# ② 新板块展开编辑（只展开对话示例与初始场景）
shot c6-02-new-blocks.png     "?sample=1&expand=chat-examples,initial-scene"
# ③ 全展开总览（八个板块顺序 + 字数分布八条）
shot c6-03-all-blocks.png     "?sample=1&expand=all"
# ④ 审计面板：两个新板块各自产生一条真实问题（不是伪造报告）。
#    对话示例 → builtin:block-missing（原文缺失）
#    初始场景 → builtin:greeting-divider-ambiguous（分隔行二义，v0.1.3 新增）
#    这条截图要证明的是「新板块的文本真的进了规则求值」，而不仅仅是「显示在列表里」。
#    不加 export=1：导出对话框会盖住面板。
shot c6-04-audit-panel.png    "?sample=1&newBlockIssues=1"
# ④b 审计面板（有 error 时的不可导出态 + 错误分组）
shot c6-04b-audit-errors.png  "?sample=1&export=1&forceError=1"
# ⑤⑥⑦ 导入三样本的保全结果：全部标准 / 混合（有未识别片段）/ 0 命中（整篇保全）
shot c6-05-import-clean.png   "?sample=1&import=clean"
shot c6-06-import-mixed.png   "?sample=1&import=mixed"
shot c6-07-import-zero.png    "?sample=1&import=zero"
# ⑧ 零标签空工作台（八板块化后的启动界面）
shot c6-08-empty.png          ""

echo "完成。快照在 .verify/e2e-dumps/，截图在 docs/assets/。"
