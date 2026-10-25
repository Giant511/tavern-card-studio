#!/usr/bin/env bash
# 传输安全 UI 化（v0.1.3 / F4）的截图验收。
#
# 四张图对应需求第 5 条要求的四种状态：
#   ① off 模式的红色明文武警告（"仅限可信网络"）
#   ② selfsigned 的指纹 / 剩余天数
#   ③ custom 匹配通过（✔ + 有效期）
#   ④ custom 不匹配拦截（✘ + 保存按钮禁用）
#
# 与 F3/F5 的截图脚本同一套做法：真服务端 + 真数据 + headless Chrome。
# 差别在于这一批**必须真的能连上 HTTPS** 才有意义 —— 所以 ②③ 之前会
# 真的用 PUT /control/config 切一次模式，让服务端热更出监听器，
# 截图里显示的指纹就是当时真正在用的那张证书的指纹。
#
# 用法：bash scripts/capture-f4-tls.sh
#   前置：npm run build:server

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHOTS="$REPO/assets"
PROFILES="$REPO/.verify/chrome-profiles"
WORK="$REPO/.verify/f4-shots"
API_PORT=20571
CONTROL_PORT=20572
HTTPS_PORT=20573

CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
if [ ! -f "$CHROME" ]; then
  CHROME="/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
fi
[ -f "$CHROME" ] || { echo "找不到 Chrome" >&2; exit 2; }
[ -f "$REPO/server/dist/index.js" ] || { echo "server/dist 不存在，请先 npm run build:server" >&2; exit 2; }

mkdir -p "$SHOTS" "$PROFILES" "$WORK"

NODE="C:/Users/PC/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
[ -f "$NODE" ] || NODE="$(command -v node)"

# 每轮新目录（不 rm -rf：数据目录文件多，会撞 safe-delete 的批量阈值）
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
DATA_DIR="$WORK/data-$RUN_ID"
CONFIG="$WORK/config-$RUN_ID.json"
mkdir -p "$DATA_DIR"

TOKEN="f4-shot-token-ddddddddddddddddddddddd"

# 配置文件用 node 生成（不要把带反斜杠的 Windows 路径塞进 heredoc）
"$NODE" -e '
const fs = require("node:fs");
const [out, dataDir, port, controlPort, httpsPort, token] = process.argv.slice(1);
const now = new Date().toISOString();
fs.writeFileSync(out, JSON.stringify({
  schemaVersion: 1, port: Number(port), controlPort: Number(controlPort),
  host: "127.0.0.1", controlHost: "127.0.0.1",
  dataDir: dataDir.replace(/\\/g, "/"),
  rulesDir: "rules", defaultPlatformRule: "sillytavern", defaultPreset: "default",
  maxUploadBytes: 33554432, logLevel: "error",
  auth: { token: token, require: true, publicPaths: ["/api/health"],
          registerMode: "open", jwtSecret: "f4-shot-secret-dddddddddddddddddddd" },
  tls: { mode: "off", httpsPort: Number(httpsPort), certPath: "", keyPath: "" },
  service: { mode: "process", name: "F4SHOT", displayName: "F4SHOT", autoStart: false },
  trash: { retentionDays: 30 },
  createdAt: now, updatedAt: now,
}, null, 2) + "\n", "utf8");
' "$(cygpath -w "$CONFIG" 2>/dev/null || echo "$CONFIG")" \
  "$(cygpath -w "$DATA_DIR" 2>/dev/null || echo "$DATA_DIR")" \
  "$API_PORT" "$CONTROL_PORT" "$HTTPS_PORT" "$TOKEN"

# 造两对证书：good（自签但配对）与 other（只拿私钥去配 good 的证书）
GOOD_CERT="$WORK/good-$RUN_ID.crt"
GOOD_KEY="$WORK/good-$RUN_ID.key"
OTHER_KEY="$WORK/other-$RUN_ID.key"
"$NODE" -e '
const fs = require("node:fs");
const { webcrypto } = require("node:crypto");
const { X509CertificateGenerator } = require("@peculiar/x509");
(async () => {
  const [certOut, keyOut, otherKeyOut] = process.argv.slice(1);
  const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const make = async (cn) => {
    const keys = await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"]);
    const cert = await X509CertificateGenerator.createSelfSigned({
      serialNumber: "0f04", name: "CN=" + cn,
      notBefore: new Date(Date.now() - 86400000),
      notAfter: new Date(Date.now() + 180 * 86400000),
      signingAlgorithm: alg, keys,
    });
    const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
    const pem = "-----BEGIN PRIVATE KEY-----\n" +
      Buffer.from(pkcs8).toString("base64").match(/.{1,64}/g).join("\n") +
      "\n-----END PRIVATE KEY-----\n";
    return { cert: cert.toString("pem"), key: pem };
  };
  const good = await make("panel.example.com");
  const other = await make("other.example.com");
  fs.writeFileSync(certOut, good.cert, "utf8");
  fs.writeFileSync(keyOut, good.key, "utf8");
  fs.writeFileSync(otherKeyOut, other.key, "utf8");
})();
' "$(cygpath -w "$GOOD_CERT" 2>/dev/null || echo "$GOOD_CERT")" \
  "$(cygpath -w "$GOOD_KEY" 2>/dev/null || echo "$GOOD_KEY")" \
  "$(cygpath -w "$OTHER_KEY" 2>/dev/null || echo "$OTHER_KEY")"

"$NODE" "$REPO/server/dist/index.js" serve --config "$CONFIG" >"$WORK/server-$RUN_ID.log" 2>&1 &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT

# 等到**数据面也起来**（控制面先起一两百毫秒，只等它会拿到 workerRunning:false）
#
# 匹配串里的空格是必须的：`sendJson` 输出的是**缩进过的** JSON
# （`"workerRunning": true`）。第一版写的是不带空格的 `"workerRunning":true`，
# 于是永远匹配不上 → 20 秒后判"服务未就绪"，而服务其实好得很。
READY=0
for _ in $(seq 1 80); do
  BODY="$(curl -s --noproxy '*' -m 2 -H "Authorization: Bearer $TOKEN" \
    "http://127.0.0.1:$CONTROL_PORT/control/tls/status" 2>/dev/null || true)"
  case "$BODY" in
    *'"workerRunning": true'*) READY=1; break ;;
  esac
  sleep 0.25
done
if [ "$READY" != "1" ]; then
  echo "服务未就绪：" >&2
  tail -20 "$WORK/server-$RUN_ID.log" >&2
  exit 3
fi
echo "服务已就绪（控制面 $CONTROL_PORT，数据面 $API_PORT）"

GOV_BASE="http://127.0.0.1:$CONTROL_PORT/"

# 截一张：`$1` 文件名，`$2` 查询串
shot() {
  local name="$1" query="$2"
  local profile="$PROFILES/f4-$name-$$"
  mkdir -p "$profile"
  "$CHROME" \
    --headless=new --disable-gpu --no-sandbox --no-first-run --hide-scrollbars \
    --force-device-scale-factor=2 --user-data-dir="$profile" \
    --virtual-time-budget=22000 --window-size="1460,1560" \
    --screenshot="$SHOTS/$name" \
    "${GOV_BASE}#$query" >/dev/null 2>&1 || true
  if [ -f "$SHOTS/$name" ]; then
    echo "  $name  $(wc -c < "$SHOTS/$name") 字节"
  else
    echo "  $name  ✘ 没生成" >&2
  fi
}

# 面板自己的访问令牌**必须走 hash**（面板只读 `location.hash`）。
# 第一版写成 `?token=...`，面板没登录 → 四张图全是登录页，而且字节完全相同
# —— 那正是"一张与别的图一样的图等于没验收"的经典形态。
TOKEN_QS="token=$TOKEN&view=config"

echo "生成截图："

# ① off 模式：红色「明文传输，仅限可信网络」
shot "f4-01-tls-off-warning.png" "$TOKEN_QS&tlsDemo=off"

# ② selfsigned：先真的把服务切过去（热更出监听器），指纹才有意义
curl -s --noproxy '*' -m 30 -X PUT \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data "{\"tls\":{\"mode\":\"selfsigned\",\"httpsPort\":$HTTPS_PORT}}" \
  "http://127.0.0.1:$CONTROL_PORT/control/config" > /dev/null
shot "f4-02-tls-selfsigned.png" "$TOKEN_QS&tlsDemo=selfsigned"

# ③ custom 匹配通过：两个路径都填，服务端真的校验一遍
CERT_ENC="$("$NODE" -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$(cygpath -w "$GOOD_CERT" 2>/dev/null || echo "$GOOD_CERT")")"
GOODKEY_ENC="$("$NODE" -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$(cygpath -w "$GOOD_KEY" 2>/dev/null || echo "$GOOD_KEY")")"
OTHERKEY_ENC="$("$NODE" -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$(cygpath -w "$OTHER_KEY" 2>/dev/null || echo "$OTHER_KEY")")"

shot "f4-03-custom-match-ok.png" "$TOKEN_QS&tlsDemo=custom-ok&certPath=$CERT_ENC&keyPath=$GOODKEY_ENC"

# ④ custom 不匹配：证书是 good 的，私钥换成 other 的 —— 服务端会拒，保存按钮变灰
shot "f4-04-custom-mismatch.png" "$TOKEN_QS&tlsDemo=custom-bad&certPath=$CERT_ENC&keyPath=$OTHERKEY_ENC"

# ── 断言：不匹配时保存按钮必须真的 disabled ────────────────────
#
# 截图看不清"灰色按钮到底禁用没有"（灰蓝两态在缩略图里几乎一样），而这一条
# 正是需求"不匹配禁止保存"的判据。所以用 `--dump-dom` 抓序列化后的 DOM，
# 直接看 `id="cfg-save"` 那个标签上有没有 `disabled`。
#
# 为什么不用截图里的滚动：试过滚到底让按钮入镜，headless 下整块布局会错位
# （上方留白），拍出来反而更像坏了。
dump_dom() {
  local name="$1" query="$2"
  local profile="$PROFILES/f4-dump-$name-$$"
  mkdir -p "$profile"
  "$CHROME" \
    --headless=new --disable-gpu --no-sandbox --no-first-run \
    --user-data-dir="$profile" --virtual-time-budget=22000 \
    --window-size="1460,1560" --dump-dom \
    "${GOV_BASE}#$query" 2>/dev/null > "$WORK/dump-$name.html" || true
}

assert_save_disabled() {
  local name="$1" want="$2"
  local file="$WORK/dump-$name.html"
  if [ ! -s "$file" ]; then
    echo "  ✘ $name：dump 没生成" >&2
    return 1
  fi
  # 取出 cfg-save 那个开始标签
  local tag
  tag="$(tr '>' '\n' < "$file" | grep -m1 'id="cfg-save"')"
  case "$tag" in
    *disabled*)
      if [ "$want" = "disabled" ]; then
        echo "  OK   $name：保存按钮已禁用（disabled）"
      else
        echo "  ✘ $name：保存按钮不该被禁用，实际带 disabled" >&2
        return 1
      fi
      ;;
    *)
      if [ "$want" = "enabled" ]; then
        echo "  OK   $name：保存按钮可用（未禁用）"
      else
        echo "  ✘ $name：保存按钮应被禁用，实际可点 —— 不匹配拦截失效" >&2
        return 1
      fi
      ;;
  esac
}

echo "断言「不匹配禁止保存」："
dump_dom "custom-bad" "$TOKEN_QS&tlsDemo=custom-bad&certPath=$CERT_ENC&keyPath=$OTHERKEY_ENC"
dump_dom "custom-ok" "$TOKEN_QS&tlsDemo=custom-ok&certPath=$CERT_ENC&keyPath=$GOODKEY_ENC"

ASSERT_FAILED=0
assert_save_disabled "custom-bad" "disabled" || ASSERT_FAILED=1
assert_save_disabled "custom-ok" "enabled" || ASSERT_FAILED=1
if [ "$ASSERT_FAILED" != "0" ]; then
  echo "断言失败" >&2
  exit 4
fi

echo "完成。产物在 assets/"
