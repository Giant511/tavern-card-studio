#!/usr/bin/env bash
# 仓库令牌模式（v0.1.3 / F5 后半）的截图验收。
#
# 与 capture-e2e-dumps.sh 同一套做法（shell 直接调 Chrome），但多一个前置：
# **真起一个服务端**，签到一把真令牌，再让界面真按这把令牌连接。
# 所以图里出现的「仓库令牌模式 · xxx」是真的连上之后的状态，
# 不是往内存里塞出来的假象。
#
# 产物（放根 assets/：对外、入库）：
#   assets/f5b-01-login-three-entries.png   登录框三入口并列
#   assets/f5b-02-repo-token-mode.png       令牌模式：顶栏 + 令牌输入
#   assets/f5b-03-single-repo-scopes.png    单仓库模式：同步面板（无仓库下拉 + 置灰）
#   assets/f5b-04-token-dialog-copy.png     仓库与令牌：每条的复制 + 使用指引
#
# 用法：bash scripts/capture-f5b-token-mode.sh
#   需要先 npm run build:ui -w @tcs/client 与 npm run build:server

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/client/dist"
SHOTS="$REPO/assets"
PROFILES="$REPO/.verify/chrome-profiles"
WORK="$REPO/.verify/f5b"
WEB_PORT=8951
API_PORT=20551

CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
if [ ! -f "$CHROME" ]; then
  CHROME="/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
fi
if [ ! -f "$CHROME" ]; then
  echo "找不到 Chrome，无法截图。" >&2
  exit 2
fi
if [ ! -f "$DIST/index.html" ]; then
  echo "client/dist 不存在，请先 npm run build:ui -w @tcs/client" >&2
  exit 2
fi
if [ ! -f "$REPO/server/dist/index.js" ]; then
  echo "server/dist 不存在，请先 npm run build:server" >&2
  exit 2
fi

mkdir -p "$SHOTS" "$PROFILES" "$WORK"

PY="C:/Users/PC/.workbuddy/binaries/python/versions/3.13.12/python.exe"
if [ ! -f "$PY" ]; then
  PY="$(command -v python || command -v python3)"
fi
NODE="C:/Users/PC/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
if [ ! -f "$NODE" ]; then
  NODE="$(command -v node)"
fi

# ── 起服务端 ────────────────────────────────────────────────
# 每轮用**新目录名**，不做 `rm -rf`。
#
# 这是本仓库的老坑（docs/41 §9.5）：safe-delete 钩子的批量阈值是 50 个文件，
# 而一个已经跑过一轮的服务端数据目录正好 ~50 个（SQLite + WAL + 日志），
# 于是 `rm -rf "$DATA_DIR"` 会让脚本在**这一行**被拦下并整体退出，
# 表现为"截图一张都没生成、日志只有一行 SAFE_DELETE"。改用带时间戳的新目录，
# 旧目录留在 .verify/ 下（已被 gitignore）。
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
DATA_DIR="$WORK/data-$RUN_ID"
mkdir -p "$DATA_DIR"

# 配置用 node 生成，**不要**用 heredoc 拼。
# 第一版用 heredoc 写 `"dataDir": "$(cygpath -w ...)"`：Windows 路径里的反斜杠
# 在 JSON 里是转义符，于是 config.json 直接非法，服务端起不来，
# 而脚本因为 `set -e` 之外的原因继续往下跑，最后表现为"截图全没生成、日志是空的"。
"$NODE" -e '
const fs = require("node:fs");
const [out, dataDir, port] = process.argv.slice(1);
const now = new Date().toISOString();
const config = {
  schemaVersion: 1,
  port: Number(port),
  controlPort: Number(port) + 1,
  host: "127.0.0.1",
  controlHost: "127.0.0.1",
  // 正斜杠：Windows 上 Node 认这个，且不需要 JSON 转义
  dataDir: dataDir.replace(/\\/g, "/"),
  rulesDir: "rules",
  defaultPlatformRule: "sillytavern",
  defaultPreset: "default",
  maxUploadBytes: 33554432,
  logLevel: "error",
  auth: {
    token: "f5b-legacy-token-aaaaaaaaaaaaaaaaaaaa",
    require: true,
    publicPaths: ["/api/health"],
    registerMode: "open",
    jwtSecret: "f5b-jwt-secret-aaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
  tls: { mode: "off", httpsPort: Number(port) + 1000, certPath: "", keyPath: "" },
  service: { mode: "process", name: "F5B", displayName: "F5B", autoStart: false },
  createdAt: now,
  updatedAt: now,
};
fs.writeFileSync(out, JSON.stringify(config, null, 2) + "\n", "utf8");
' "$(cygpath -w "$WORK/config.json" 2>/dev/null || echo "$WORK/config.json")" \
  "$(cygpath -w "$DATA_DIR" 2>/dev/null || echo "$DATA_DIR")" \
  "$API_PORT"

"$NODE" "$REPO/server/dist/index.js" worker --config "$WORK/config.json" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  kill "$WEB_PID" 2>/dev/null || true
}
trap cleanup EXIT

API="http://127.0.0.1:$API_PORT"
for _ in $(seq 1 120); do
  if curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$API/api/health" 2>/dev/null | grep -q 200; then
    break
  fi
  sleep 0.25
done
if ! curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$API/api/health" 2>/dev/null | grep -q 200; then
  echo "服务端没起来，日志：" >&2
  tail -20 "$WORK/server.log" >&2
  exit 3
fi
echo "服务端就绪：$API"

# ── 注册账户、建仓库、签令牌 ────────────────────────────────
# 用 node 而不是 curl 拼 JSON：中文仓库名在 shell 里转义很容易出错。
# 令牌**不落盘到日志**，只写进 $WORK/token 供本脚本读取（该目录已被 gitignore）。
"$NODE" -e '
const base = process.argv[1];
const fs = require("node:fs");
const out = process.argv[2];
(async () => {
  const post = async (path, body, token) => {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const reg = await post("/api/auth/register", { username: "alice", password: "Passw0rd!-alice-1234" });
  if (reg.status !== 201 && reg.status !== 200) throw new Error("注册失败：" + JSON.stringify(reg));
  const access = reg.json.accessToken;
  const repos = await fetch(base + "/api/repos", { headers: { Authorization: "Bearer " + access } }).then((r) => r.json());
  const repo = repos.items[0];
  const issued = await post("/api/repos/" + repo.id + "/tokens", { name: "另一台设备", scopes: ["read"] }, access);
  if (typeof issued.json.token !== "string") throw new Error("签发失败：" + JSON.stringify(issued));
  fs.writeFileSync(out, issued.json.token, "utf8");
  console.log("仓库：" + repo.name + "　令牌前缀：" + issued.json.token.slice(0, 12));
})();
' "$API" "$WORK/token"

TOKEN="$(cat "$WORK/token")"
echo "已签发令牌（长度 ${#TOKEN}）"

# ── 起静态服务 ──────────────────────────────────────────────
"$PY" -m http.server "$WEB_PORT" --bind 127.0.0.1 --directory "$DIST" >/dev/null 2>&1 &
WEB_PID=$!
for _ in $(seq 1 20); do
  if curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/index.html" 2>/dev/null | grep -q 200; then
    break
  fi
  sleep 0.5
done
BASE="http://127.0.0.1:$WEB_PORT/index.html"

# 截图：不要 rm -rf profile（safe-delete 钩子在 50 个文件处会中断脚本）
shot() {
  local name="$1" query="$2" size="${3:-1420,940}"
  local profile="$PROFILES/f5b-$name-$$"
  mkdir -p "$profile"
  "$CHROME" \
    --headless=new \
    --disable-gpu \
    --no-sandbox \
    --no-first-run \
    --hide-scrollbars \
    --force-device-scale-factor=2 \
    --user-data-dir="$profile" \
    --virtual-time-budget=20000 \
    --window-size="$size" \
    --screenshot="$SHOTS/$name" \
    "$BASE$query" >/dev/null 2>&1 || true
  if [ -f "$SHOTS/$name" ]; then
    echo "  $name  $(wc -c < "$SHOTS/$name") 字节"
  else
    echo "  $name  ✘ 没生成" >&2
  fi
}

ENCODED_SERVER=$(printf '%s' "$API" | sed 's|:|%3A|g; s|/|%2F|g')
TOKEN_ENC=$(printf '%s' "$TOKEN")

echo "生成截图："
# ① 登录框三入口并列：登录（主按钮）+ 注册新账户 + 使用仓库令牌连接。
#    这里**不能**带 repoToken=1 —— 切进令牌模式后注册入口按设计隐藏
#    （用户名/密码与令牌互斥显示），那样拍出来只有两个入口。
shot "f5b-01-login-three-entries.png" "?login=1&serverUrl=$ENCODED_SERVER"

# ② 令牌输入态：标题变成「使用仓库令牌连接」，身份说明换成"两条凭证路径"
shot "f5b-02-repo-token-mode.png" "?login=1&repoToken=1&serverUrl=$ENCODED_SERVER&token=$TOKEN_ENC"

# ③ 真连一次，然后打开同步面板：单仓库模式（无下拉、按 scope 置灰）
shot "f5b-03-single-repo-scopes.png" "?login=1&repoToken=1&serverUrl=$ENCODED_SERVER&token=$TOKEN_ENC&connectToken=1&sync=1" "1420,1100"

# ④ 设置页：两条凭证路径的适用场景
shot "f5b-04-settings-paths.png" "?settings=1&serverUrl=$ENCODED_SERVER" "1420,1100"

# ⑤ 仓库与令牌对话框：每条令牌的复制按钮 + 使用指引（需求第 4 条）。
#    这个面板要**账户身份**（仓库令牌不能管理令牌），所以用真实登录：
#    `?openRepos=1&loginUser=…&loginPassword=…` 走的是 AuthSession.login 那条路，
#    与用户手动登录完全一致（浏览器模式下 configPatch 不可用，注入令牌不成立）。
shot "f5b-05-token-dialog-copy.png" "?openRepos=1&serverUrl=$ENCODED_SERVER&loginUser=alice&loginPassword=Passw0rd%21-alice-1234" "1420,1100"

echo "完成。产物在 assets/" 
