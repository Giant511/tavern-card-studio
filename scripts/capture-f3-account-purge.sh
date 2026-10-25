#!/usr/bin/env bash
# 账户注销（v0.1.3 / F3）的截图验收。
#
# 两张图，各自证明一件不能靠单测证明的事：
#   ① 客户端「设置 → 账户 → 注销账户…」的二次确认弹窗：**必须含输入框**
#      （`window.confirm` 那种单点确定是需求明确要避免的形态）；
#   ② 治理页的注销审计表：注销之后记录仍在（审计不能跟着数据消失）。
#
# 与 capture-f5b-token-mode.sh 同一套做法：真服务端 + 真数据 + headless Chrome。
# 差别在于这一批要**真的注销一次**才能截到审计表 —— 截图本身就是端到端证据。
#
# 用法：bash scripts/capture-f3-account-purge.sh
#   前置：npm run build:ui && npm run build:server

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/client/dist"
SHOTS="$REPO/assets"
PROFILES="$REPO/.verify/chrome-profiles"
WORK="$REPO/.verify/f3"
WEB_PORT=8961
API_PORT=20561
# 治理页由 supervisor（控制端口）提供，并把 /api 代理给 worker。
# 只用 `worker` 子命令起服务的话，面板根本不存在 —— 第一版就是这么错的。
CONTROL_PORT=20562

CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
if [ ! -f "$CHROME" ]; then
  CHROME="/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
fi
[ -f "$CHROME" ] || { echo "找不到 Chrome" >&2; exit 2; }
[ -f "$DIST/index.html" ] || { echo "client/dist 不存在，请先 npm run build:ui" >&2; exit 2; }
[ -f "$REPO/server/dist/index.js" ] || { echo "server/dist 不存在，请先 npm run build:server" >&2; exit 2; }

mkdir -p "$SHOTS" "$PROFILES" "$WORK"

PY="C:/Users/PC/.workbuddy/binaries/python/versions/3.13.12/python.exe"
[ -f "$PY" ] || PY="$(command -v python || command -v python3)"
NODE="C:/Users/PC/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
[ -f "$NODE" ] || NODE="$(command -v node)"

# 每轮新目录（不 rm -rf：数据目录约 50 个文件，会撞 safe-delete 的批量阈值）
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
DATA_DIR="$WORK/data-$RUN_ID"
mkdir -p "$DATA_DIR"

"$NODE" -e '
const fs = require("node:fs");
const [out, dataDir, port, controlPort] = process.argv.slice(1);
const now = new Date().toISOString();
fs.writeFileSync(out, JSON.stringify({
  schemaVersion: 1, port: Number(port), controlPort: Number(controlPort),
  host: "127.0.0.1", controlHost: "127.0.0.1",
  dataDir: dataDir.replace(/\\/g, "/"),
  rulesDir: "rules", defaultPlatformRule: "sillytavern", defaultPreset: "default",
  maxUploadBytes: 33554432, logLevel: "error",
  auth: { token: "f3-legacy-token-aaaaaaaaaaaaaaaaaaaaaaaaa", require: true,
          publicPaths: ["/api/health"], registerMode: "open",
          jwtSecret: "f3-shot-secret-aaaaaaaaaaaaaaaaaaaaaaaaaa" },
  tls: { mode: "off", httpsPort: Number(port) + 1000, certPath: "", keyPath: "" },
  service: { mode: "process", name: "F3", displayName: "F3", autoStart: false },
  trash: { retentionDays: 30 },
  createdAt: now, updatedAt: now,
}, null, 2) + "\n", "utf8");
' "$(cygpath -w "$WORK/config-$RUN_ID.json" 2>/dev/null || echo "$WORK/config-$RUN_ID.json")" \
  "$(cygpath -w "$DATA_DIR" 2>/dev/null || echo "$DATA_DIR")" "$API_PORT" "$CONTROL_PORT"

# 必须用 `serve`：它同时拉起 supervisor（面板 + /api 代理）与 worker（数据面）。
"$NODE" "$REPO/server/dist/index.js" serve --config "$WORK/config-$RUN_ID.json" >"$WORK/server-$RUN_ID.log" 2>&1 &
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
  echo "服务端没起来：" >&2; tail -20 "$WORK/server-$RUN_ID.log" >&2; exit 3; }
echo "服务端就绪：$API"

# 造数据：rootadmin（管理员，永不注销）+ victim（要注销的那个，带卡/仓库/令牌）
"$NODE" -e '
const base = process.argv[1];
const fs = require("node:fs");
const out = process.argv[2];
const card = JSON.stringify({
  spec: "chara_card_v2",
  data: { name: "待注销的卡", description: "截图用", first_mes: "你好", mes_example: "" },
});
(async () => {
  const post = async (path, body, token) => {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const reg = async (username, password) => {
    const r = await post("/api/auth/register", { username, password });
    if (!r.json || !r.json.accessToken) throw new Error("注册 " + username + " 失败：" + JSON.stringify(r));
    return r.json;
  };
  const root = await reg("rootadmin", "rootadmin-password-1");
  const victim = await reg("victim", "victim-password-1");

  // 给 victim 造两张卡（一张进回收站）、一个额外仓库、两把令牌
  const upload = async (cardId) => {
    const res = await fetch(base + "/api/cards?cardId=" + encodeURIComponent(cardId), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + victim.accessToken },
      body: card,
    });
    if (!res.ok) throw new Error("上传失败：" + (await res.text()));
  };
  await upload("f3-shot-card-a");
  await upload("f3-shot-card-b");
  await fetch(base + "/api/cards/f3-shot-card-b", {
    method: "DELETE",
    headers: { Authorization: "Bearer " + victim.accessToken },
  });
  const repo = await post("/api/repos", { name: "截图仓库" }, victim.accessToken);
  await post("/api/repos/" + repo.json.id + "/tokens", { name: "另一台设备", scopes: ["read", "write"] }, victim.accessToken);
  const repos = await fetch(base + "/api/repos", { headers: { Authorization: "Bearer " + victim.accessToken } })
    .then((r) => r.json());
  await post("/api/repos/" + repos.items[0].id + "/tokens", { name: "CI", scopes: ["read"] }, victim.accessToken);

  // 最后：注销 victim（管理员路径），这样审计表里有一条真实记录
  const purge = await fetch(base + "/api/accounts/" + victim.user.id, {
    method: "DELETE",
    headers: { Authorization: "Bearer " + root.accessToken },
  });
  const purgeBody = await purge.json();
  if (!purge.ok) throw new Error("注销失败：" + JSON.stringify(purgeBody));
  fs.writeFileSync(out, JSON.stringify({
    rootToken: root.accessToken,
    rootUsername: "rootadmin",
    purgeCounts: purgeBody.counts,
  }, null, 2), "utf8");
  console.log("已造数据并注销 victim：" + JSON.stringify(purgeBody.counts));
})();
' "$API" "$WORK/state-$RUN_ID.json"

# 再注册一个"只差一步"的账户：客户端弹窗要截的是**还活着**的账户
"$NODE" -e '
const base = process.argv[1];
(async () => {
  const post = async (path, body) => {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const u = await post("/api/auth/register", { username: "leaving", password: "leaving-password-1" });
  if (!u.json || !u.json.accessToken) throw new Error("注册 leaving 失败：" + JSON.stringify(u));
  for (const id of ["f3-shot-leaving-a", "f3-shot-leaving-b"]) {
    await fetch(base + "/api/cards?cardId=" + encodeURIComponent(id), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + u.json.accessToken },
      body: JSON.stringify({ spec: "chara_card_v2", data: { name: "准备注销的卡", description: "x", first_mes: "hi", mes_example: "" } }),
    });
  }
  console.log("leaving 账户就绪（2 张卡）");
})();
' "$API"

BASE="http://127.0.0.1:$WEB_PORT/index.html"
ENC_SERVER=$(printf '%s' "$API" | sed 's|:|%3A|g; s|/|%2F|g')

shot() {
  local name="$1" query="$2" size="${3:-1420,940}"
  local profile="$PROFILES/f3-$name-$$"
  mkdir -p "$profile"
  "$CHROME" \
    --headless=new --disable-gpu --no-sandbox --no-first-run --hide-scrollbars \
    --force-device-scale-factor=2 --user-data-dir="$profile" \
    --virtual-time-budget=22000 --window-size="$size" \
    --screenshot="$SHOTS/$name" "$BASE$query" >/dev/null 2>&1 || true
  if [ -f "$SHOTS/$name" ]; then
    echo "  $name  $(wc -c < "$SHOTS/$name") 字节"
  else
    echo "  $name  ✘ 没生成" >&2
  fi
}

echo "生成截图："
# ① 客户端注销确认弹窗（含输入框、统计、实心危险按钮）
shot "f3-01-client-delete-confirm.png" \
  "?settings=1&serverUrl=$ENC_SERVER&openDelete=1&loginUser=leaving&loginPassword=leaving-password-1" "1420,1000"

# ② 治理页注销审计（注销之后记录仍在）。
#
#    两件必须同时做对的事：
#      a) 面板在**控制端口**（supervisor 提供），/api 由它代理给 worker ——
#         不能用静态服务，必须直接访问控制端口；
#      b) 面板本身还有一道「访问令牌」门（data/config.json 里的 auth.token），
#         令牌通过 **URL hash** 传入（`#token=…&view=governance`），
#         不带它就停在登录页 —— 第一版就是这么截到的（一张纯登录页的图）。
#
#    这里刻意用 hash 而不是再写一个调试开关：hash 是面板**原有**的入口，
#    不新增测试专用路径。
GOV_BASE="http://127.0.0.1:$CONTROL_PORT/"
GOV_PROFILE="$PROFILES/f3-gov-$$"
mkdir -p "$GOV_PROFILE"
"$CHROME" \
  --headless=new --disable-gpu --no-sandbox --no-first-run --hide-scrollbars \
  --force-device-scale-factor=2 --user-data-dir="$GOV_PROFILE" \
  --virtual-time-budget=25000 --window-size="1500,1300" \
  --screenshot="$SHOTS/f3-02-governance-audit.png" \
  "${GOV_BASE}#token=f3-legacy-token-aaaaaaaaaaaaaaaaaaaaaaaaa&view=governance&gov=1&govUser=rootadmin&govPassword=rootadmin-password-1" >/dev/null 2>&1 || true
if [ -f "$SHOTS/f3-02-governance-audit.png" ]; then
  echo "  f3-02-governance-audit.png  $(wc -c < "$SHOTS/f3-02-governance-audit.png") 字节"
else
  echo "  f3-02-governance-audit.png  ✘ 没生成" >&2
fi

echo "完成。产物在 assets/"
