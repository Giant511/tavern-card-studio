#!/usr/bin/env bash
# 仓库令牌模式的 DOM 断言（v0.1.3 / F5 后半）。
#
# 为什么不能只看截图：截图只能看出"按钮看起来是灰的还是蓝的"，
# 而 disabled 属性的真实值、仓库下拉是否 hidden、body.dataset 上的模式标记，
# 都是截图读不出来的。本仓库踩过"一张与别的图字节相同的截图等于没验收"，
# 也踩过"颜色看起来对、属性其实没设"。
#
# 做法与 capture-e2e-dumps.sh 一致：shell 调 Chrome --dump-dom 抓快照，
# 断言交给 scripts/verify-f5b-token-mode.mjs（只读快照，不碰网络）。
#
# 用法：bash scripts/capture-f5b-dumps.sh && node scripts/verify-f5b-token-mode.mjs

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/client/dist"
DUMPS="$REPO/.verify/f5b-dumps"
PROFILES="$REPO/.verify/chrome-profiles"
WORK="$REPO/.verify/f5b"
WEB_PORT=8953
API_PORT=20553

CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
if [ ! -f "$CHROME" ]; then
  CHROME="/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
fi
[ -f "$CHROME" ] || { echo "找不到 Chrome" >&2; exit 2; }
[ -f "$DIST/index.html" ] || { echo "client/dist 不存在" >&2; exit 2; }
[ -f "$REPO/server/dist/index.js" ] || { echo "server/dist 不存在" >&2; exit 2; }

mkdir -p "$DUMPS" "$PROFILES" "$WORK"

PY="C:/Users/PC/.workbuddy/binaries/python/versions/3.13.12/python.exe"
[ -f "$PY" ] || PY="$(command -v python || command -v python3)"
NODE="C:/Users/PC/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
[ -f "$NODE" ] || NODE="$(command -v node)"

# 每轮新目录，不 rm -rf：数据目录约 50 个文件，会撞 safe-delete 的批量阈值
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
DATA_DIR="$WORK/data-dumps-$RUN_ID"
mkdir -p "$DATA_DIR"

"$NODE" -e '
const fs = require("node:fs");
const [out, dataDir, port] = process.argv.slice(1);
const now = new Date().toISOString();
fs.writeFileSync(out, JSON.stringify({
  schemaVersion: 1, port: Number(port), controlPort: Number(port) + 1,
  host: "127.0.0.1", controlHost: "127.0.0.1",
  dataDir: dataDir.replace(/\\/g, "/"),
  rulesDir: "rules", defaultPlatformRule: "sillytavern", defaultPreset: "default",
  maxUploadBytes: 33554432, logLevel: "error",
  auth: { token: "f5b-dump-legacy-aaaaaaaaaaaaaaaaaaaaaaaa", require: true,
          publicPaths: ["/api/health"], registerMode: "open",
          jwtSecret: "f5b-dump-secret-aaaaaaaaaaaaaaaaaaaaaaaa" },
  tls: { mode: "off", httpsPort: Number(port) + 1000, certPath: "", keyPath: "" },
  service: { mode: "process", name: "F5D", displayName: "F5D", autoStart: false },
  createdAt: now, updatedAt: now,
}, null, 2) + "\n", "utf8");
' "$(cygpath -w "$WORK/config-dumps.json" 2>/dev/null || echo "$WORK/config-dumps.json")" \
  "$(cygpath -w "$DATA_DIR" 2>/dev/null || echo "$DATA_DIR")" "$API_PORT"

"$NODE" "$REPO/server/dist/index.js" worker --config "$WORK/config-dumps.json" >"$WORK/server-dumps.log" 2>&1 &
SERVER_PID=$!

"$PY" -m http.server "$WEB_PORT" --bind 127.0.0.1 --directory "$DIST" >/dev/null 2>&1 &
WEB_PID=$!

cleanup() { kill "$SERVER_PID" 2>/dev/null || true; kill "$WEB_PID" 2>/dev/null || true; }
trap cleanup EXIT

API="http://127.0.0.1:$API_PORT"
for _ in $(seq 1 120); do
  curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$API/api/health" 2>/dev/null | grep -q 200 && break
  sleep 0.25
done
curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$API/api/health" 2>/dev/null | grep -q 200 || {
  echo "服务端没起来：" >&2; tail -20 "$WORK/server-dumps.log" >&2; exit 3; }

# 签三把不同 scope 的令牌：只读 / 读写 / 全权。
# 三把放在同一份配置里，断言脚本按 scope 矩阵逐项核对置灰 —— 只测一把
# 无法证明"是 scope 在起作用"（可能只是碰巧都灰了或都亮着）。
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
  const access = reg.json.accessToken;
  const repos = await fetch(base + "/api/repos", { headers: { Authorization: "Bearer " + access } }).then((r) => r.json());
  const repo = repos.items[0];
  const tokens = {};
  for (const [key, scopes] of [["read", ["read"]], ["readwrite", ["read", "write"]], ["full", ["read", "write", "rollback"]]]) {
    const issued = await post("/api/repos/" + repo.id + "/tokens", { name: key, scopes }, access);
    if (typeof issued.json.token !== "string") throw new Error("签发失败 " + key + "：" + JSON.stringify(issued));
    tokens[key] = issued.json.token;
  }
  fs.writeFileSync(out, JSON.stringify(tokens, null, 2), "utf8");
  console.log("已签发 3 把（read / readwrite / full），仓库：" + repo.name);
})();
' "$API" "$WORK/dump-tokens.json"

READ_TOKEN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).read)' "$WORK/dump-tokens.json")
FULL_TOKEN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).full)' "$WORK/dump-tokens.json")
RW_TOKEN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).readwrite)' "$WORK/dump-tokens.json")

BASE="http://127.0.0.1:$WEB_PORT/index.html"
ENC_SERVER=$(printf '%s' "$API" | sed 's|:|%3A|g; s|/|%2F|g')

dump() {
  local name="$1" query="$2"
  local profile="$PROFILES/f5b-dump-$name-$$"
  mkdir -p "$profile"
  "$CHROME" \
    --headless=new --disable-gpu --no-sandbox --no-first-run --hide-scrollbars \
    --user-data-dir="$profile" --virtual-time-budget=20000 \
    --dump-dom "$BASE$query" > "$DUMPS/$name.html" 2>/dev/null || true
  echo "  $name.html  $(wc -c < "$DUMPS/$name.html") 字节"
}

echo "抓取 DOM 快照："
# 三入口并列（登录态，不带 repoToken）
dump "login-entries" "?login=1&serverUrl=$ENC_SERVER"
# 令牌模式（未连接）
dump "token-mode-dialog" "?login=1&repoToken=1&serverUrl=$ENC_SERVER&token=$READ_TOKEN"
# 只读令牌连上后的单仓库模式
dump "scope-read" "?login=1&repoToken=1&serverUrl=$ENC_SERVER&token=$READ_TOKEN&connectToken=1&sync=1"
# 读写令牌
dump "scope-readwrite" "?login=1&repoToken=1&serverUrl=$ENC_SERVER&token=$RW_TOKEN&connectToken=1&sync=1"
# 全权令牌
dump "scope-full" "?login=1&repoToken=1&serverUrl=$ENC_SERVER&token=$FULL_TOKEN&connectToken=1&sync=1"

echo "完成。快照在 .verify/f5b-dumps/"
