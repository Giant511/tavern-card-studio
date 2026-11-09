#!/usr/bin/env bash
# Spike ① 四判据复验（v0.1.7）—— 换机型/换 ROM 时重跑同一套判据。
#
# ## 为什么要有这个脚本（而不是每次手敲命令）
#
# 决策 #279 已经钉过一条：**换设备必须重做 tmp exec 实验，权限因版本与 ROM 而异**。
# 而四判据本身也有同样的问题 —— 手敲命令时每次用的 grep 模式不一样，
# 结论就不可比。2026-10-30 在 Redmi Note 8 Pro 上就撞到两个判据陷阱：
#
#   ① `netstat | grep 8000 | grep -c '0.0.0.0'` 返回 1，看着像"监听了 0.0.0.0"。
#      实际那是 **Foreign Address 列**（`0.0.0.0:*` = 任意远端，正常形态）。
#      要判的是 **Local Address 列**（第 4 列）。
#   ② `grep -icE 'error|severe|uncaught|fatal'` 返回 4，看着像 4 个错误。
#      实际是 ST 启动时复制静态错误页的日志：`Content file errors/xxx.html copied to ...`
#      —— 路径里含 `errors/` 而已。
#
# 两个陷阱的共同形态：**判据太宽，把正常现象判成了失败**。
# 这种误报比漏报更麻烦 —— 它会让人去修本来没坏的东西。
#
# ## 用法
#
#   bash scripts/verify-spike.sh                  # 自动选第一台设备
#   bash scripts/verify-spike.sh <serial>         # 指定设备
#   SKIP_INSTALL=1 bash scripts/verify-spike.sh   # 已有 libnode.so 与 st/ 时跳过推送
#
# 前置：
#   vendor/node-android/bin/libnode-arm64-22.23.4.so
#   vendor/node-android/bin/libc++_shared-arm64.so
#   .verify/st-1.19.tar.gz
#
# 产出：.verify/spike-<机型>-<时间>/ 下的逐项证据 + verdict.txt

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADB="$REPO/.verify/platform-tools/platform-tools/adb.exe"
NODE_SO="$REPO/vendor/node-android/bin/libnode-arm64-22.23.4.so"
LIBCXX_SO="$REPO/vendor/node-android/bin/libc++_shared-arm64.so"
ST_TGZ="$REPO/.verify/st-1.19.tar.gz"

# Git Bash 会把 /data/local/tmp/... 改写成 Windows 路径。
# 2026-10-30 实测：不加这个变量，push 会报
#   "remote secure_mkdirs failed: No such file or directory"
# 而报错里的目标路径已经变成了 C:/Users/.../PortableGit/.../data/local/tmp
export MSYS_NO_PATHCONV=1

[ -x "$ADB" ] || { echo "[FATAL] 找不到 adb：$ADB" >&2; exit 2; }
for f in "$NODE_SO" "$LIBCXX_SO"; do
  [ -f "$f" ] || { echo "[FATAL] 缺产物：$f" >&2; exit 2; }
done

SERIAL="${1:-}"
if [ -z "$SERIAL" ]; then
  SERIAL="$("$ADB" devices | awk 'NR>1 && $2=="device" {print $1; exit}')"
fi
[ -n "$SERIAL" ] || { echo "[FATAL] 没有已授权的设备（adb devices 为空）" >&2; exit 2; }

say() { printf '%s\n' "$*"; }
rule() { printf '%s\n' "────────────────────────────────────────"; }

# 设备信息 → 决定证据目录名
MODEL="$("$ADB" -s "$SERIAL" shell getprop ro.product.model 2>/dev/null | tr -d '\r')"
ANDROID="$("$ADB" -s "$SERIAL" shell getprop ro.build.version.release 2>/dev/null | tr -d '\r')"
SDK="$("$ADB" -s "$SERIAL" shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')"
ABILIST="$("$ADB" -s "$SERIAL" shell getprop ro.product.cpu.abilist 2>/dev/null | tr -d '\r')"

STAMP="$(date +%Y%m%d-%H%M%S)"
SAFE_MODEL="$(printf '%s' "$MODEL" | tr -c 'A-Za-z0-9._-' '_')"
OUT="$REPO/.verify/spike-${SAFE_MODEL}-${STAMP}"
mkdir -p "$OUT"

PASS=0
FAIL=0
record() {
  # record <判据名> <是否通过 0/1> <详情>
  local name="$1" ok="$2" detail="$3"
  if [ "$ok" = "1" ]; then
    PASS=$((PASS + 1))
    say "[PASS] $name :: $detail"
    printf 'PASS\t%s\t%s\n' "$name" "$detail" >>"$OUT/verdict.txt"
  else
    FAIL=$((FAIL + 1))
    say "[FAIL] $name :: $detail"
    printf 'FAIL\t%s\t%s\n' "$name" "$detail" >>"$OUT/verdict.txt"
  fi
}

say "设备：$MODEL / Android $ANDROID (SDK $SDK) / $ABILIST"
say "序列号：$SERIAL"
say "证据目录：$OUT"
{
  echo "model=$MODEL"
  echo "android=$ANDROID"
  echo "sdk=$SDK"
  echo "abilist=$ABILIST"
  echo "serial=$SERIAL"
  echo "stamp=$STAMP"
} >"$OUT/00-device.txt"

rule
say "== 0. 前置：架构与 tmp exec =="
rule

# 架构必须是 arm64（产物是 arm64）
case "$ABILIST" in
  arm64-v8a*) record "前置 arm64" 1 "$ABILIST" ;;
  *) record "前置 arm64" 0 "abilist=$ABILIST，而产物是 arm64" ;;
esac

# ★ 决定性实验：tmp 内 exec（决策 #279 —— 换设备必须重做）
# 用 sh 而不是 toybox：toybox 是 multicall 二进制，直接把路径当子命令会报
# "Unknown command /data/local/tmp/xxx"，那个报错**容易被误读成 exec 失败**。
"$ADB" -s "$SERIAL" shell "cp /system/bin/sh /data/local/tmp/sh-probe >/dev/null 2>&1 && chmod 755 /data/local/tmp/sh-probe && /data/local/tmp/sh-probe -c 'echo SH_OK uid=\$(id -u)'" >"$OUT/01-exec-probe.txt" 2>&1
if grep -q "SH_OK" "$OUT/01-exec-probe.txt"; then
  record "前置 tmp exec" 1 "$(tr -d '\r' <"$OUT/01-exec-probe.txt" | grep SH_OK)"
else
  record "前置 tmp exec" 0 "见 01-exec-probe.txt"
fi

rule
say "== 1. 推送产物与 ST =="
rule

if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  "$ADB" -s "$SERIAL" push "$NODE_SO" /data/local/tmp/libnode.so >"$OUT/02-push.txt" 2>&1
  "$ADB" -s "$SERIAL" push "$LIBCXX_SO" /data/local/tmp/libc++_shared.so >>"$OUT/02-push.txt" 2>&1
  "$ADB" -s "$SERIAL" push "$ST_TGZ" /data/local/tmp/st-1.19.tar.gz >>"$OUT/02-push.txt" 2>&1
  say "  推送完成（$(grep -c 'file pushed' "$OUT/02-push.txt") 个文件）"

  "$ADB" -s "$SERIAL" shell "chmod 755 /data/local/tmp/libnode.so; cd /data/local/tmp && rm -rf st && mkdir -p st && tar -xzf st-1.19.tar.gz -C st && echo EXTRACT_OK" >"$OUT/03-extract.txt" 2>&1
  if grep -q EXTRACT_OK "$OUT/03-extract.txt"; then
    say "  解压完成"
  else
    say "  [FATAL] 解压失败，见 03-extract.txt" >&2
    exit 2
  fi
fi

rule
say "== 2. 判据 0：node 自报身份 =="
rule

# 三项同时成立才算"确实为 Android/arm64 编的"
"$ADB" -s "$SERIAL" shell "cd /data/local/tmp && LD_LIBRARY_PATH=/data/local/tmp ./libnode.so -e 'console.log(process.version + \" \" + process.arch + \" \" + process.platform)'" >"$OUT/04-node-version.txt" 2>&1
NODE_ID="$(tr -d '\r' <"$OUT/04-node-version.txt" | grep -E '^v[0-9]' | head -1)"
case "$NODE_ID" in
  "v22.23.4 arm64 android") record "node 身份" 1 "$NODE_ID" ;;
  *) record "node 身份" 0 "期望 'v22.23.4 arm64 android'，实际 '$NODE_ID'" ;;
esac

rule
say "== 3. 起 ST =="
rule

# ★ 必须先杀掉已在跑的实例。
#
# 2026-10-30 实测踩到：上一个手动起的 ST 还占着 8000，脚本又起一个，
# 新实例启动失败退出并写下
#   `Error: Startup aborted because IPv4 is the only enabled protocol and
#    its listen port is already in use.`
# —— 于是**判据 d 读的是失败那次的日志**，报出"真实 error 1 条"，
# 看着像设备有问题，实际是我自己的脚本没做前置清理。
#
# 这类"脏现场导致的假红"最耗人：断言没错、代码没错、设备也没错，
# 错的是执行顺序。
KILLED="$("$ADB" -s "$SERIAL" shell 'ps -A 2>/dev/null | grep libnode | awk "{print \$2}"' 2>/dev/null | tr -d '\r' | tr -d ' ' | head -5)"
if [ -n "$KILLED" ]; then
  for pid in $KILLED; do
    "$ADB" -s "$SERIAL" shell "kill $pid" >/dev/null 2>&1 || true
  done
  say "  已停掉旧实例（PID: $(printf '%s' "$KILLED" | tr '\n' ' ')）"
  # 等端口真正释放 —— 只等进程消失不够，socket 可能还在 TIME_WAIT
  for _ in $(seq 1 15); do
    sleep 1
    if ! "$ADB" -s "$SERIAL" shell "netstat -tln 2>/dev/null | grep -q ':8000 '" >/dev/null 2>&1; then break; fi
  done
fi

"$ADB" -s "$SERIAL" shell "cd /data/local/tmp/st && rm -f /data/local/tmp/st.log && setsid nohup env LD_LIBRARY_PATH=/data/local/tmp /data/local/tmp/libnode.so server.js --port=8000 --dataRoot=/data/local/tmp/st-data --browserLaunchEnabled=false > /data/local/tmp/st.log 2>&1 < /dev/null & echo LAUNCHED" >"$OUT/05-launch.txt" 2>&1

# 等就绪：轮询设备侧进程 + 端口（**不看宿主机 curl** —— 隧道会骗人）
READY=0
for _ in $(seq 1 40); do
  sleep 2
  if "$ADB" -s "$SERIAL" shell "netstat -tln 2>/dev/null | awk '\$1==\"tcp\" && \$6==\"LISTEN\" && \$4 ~ /:8000\$/' | grep -q 8000" >/dev/null 2>&1; then
    READY=1
    break
  fi
done
record "ST 监听 8000" "$READY" "$([ "$READY" = 1 ] && echo '轮询到 LISTEN' || echo '80 秒内未监听，见 st.log')"

rule
say "== 4. 四判据 =="
rule

# ── 判据 a/b：用设备上的 libnode 自己发 HTTP（设备侧判据，不受隧道影响） ──
"$ADB" -s "$SERIAL" push "$REPO/.verify/spike-judge.js" /data/local/tmp/judge.js >/dev/null 2>&1
"$ADB" -s "$SERIAL" shell "cd /data/local/tmp && LD_LIBRARY_PATH=/data/local/tmp ./libnode.so judge.js" >"$OUT/06-judge-ab.txt" 2>&1

if grep -q '^\[PASS\] a ' "$OUT/06-judge-ab.txt"; then
  record "判据a /version=1.19.0" 1 "$(tr -d '\r' <"$OUT/06-judge-ab.txt" | grep '^\[PASS\] a ' | sed 's/^\[PASS\] a [^:]*:: //')"
else
  record "判据a /version=1.19.0" 0 "$(tr -d '\r' <"$OUT/06-judge-ab.txt" | grep '^\[FAIL\] a ' | head -1)"
fi
if grep -q '^\[PASS\] b ' "$OUT/06-judge-ab.txt"; then
  record "判据b 首页可用" 1 "$(tr -d '\r' <"$OUT/06-judge-ab.txt" | grep '^\[PASS\] b ' | sed 's/^\[PASS\] b [^:]*:: //')"
else
  record "判据b 首页可用" 0 "$(tr -d '\r' <"$OUT/06-judge-ab.txt" | grep '^\[FAIL\] b ' | head -1)"
fi

# ── 判据 c：只听回环。★ 必须取 Local Address 列（第 4 列） ──
"$ADB" -s "$SERIAL" shell "netstat -tln 2>/dev/null | grep 8000" >"$OUT/07-listen.txt" 2>&1
LOCAL_ADDR="$("$ADB" -s "$SERIAL" shell "netstat -tln 2>/dev/null | awk '\$1==\"tcp\" && \$6==\"LISTEN\" && \$4 ~ /:8000\$/ {print \$4}'" 2>/dev/null | tr -d '\r' | head -1)"
case "$LOCAL_ADDR" in
  127.0.0.1:8000) record "判据c 只听回环" 1 "Local Address=$LOCAL_ADDR（无 0.0.0.0）" ;;
  "") record "判据c 只听回环" 0 "找不到 8000 的 LISTEN 行" ;;
  *) record "判据c 只听回环" 0 "Local Address=$LOCAL_ADDR（期望 127.0.0.1:8000）" ;;
esac

# ── 判据 d：日志无 error 级。★ 必须排除路径含 errors/ 的复制日志 ──
"$ADB" -s "$SERIAL" shell "cat /data/local/tmp/st.log" >"$OUT/08-st.log" 2>&1
LOGLINES="$(wc -l <"$OUT/08-st.log" | tr -d ' ')"
# 真正的错误标志（不是裸词）：Error: / ERROR / TypeError / uncaught / unhandled / FATAL
# 并排除两类已知正常形态：
#   · `Content file errors/xxx.html copied to ...`  ← 静态错误页复制，路径含 errors/
#   · `WARNING: linker: ... unused DT entry`        ← libc++ 的 ARM 专有 DT 标记，linker 忽略即可
REAL_ERRORS="$(grep -nE '(^|[^A-Za-z])Error:|ERROR|TypeError|RangeError|ReferenceError|Uncaught|uncaughtException|unhandledRejection|FATAL' "$OUT/08-st.log" 2>/dev/null | grep -v 'Content file errors/' | grep -v 'WARNING: linker:' | wc -l | tr -d ' ')"
if [ "$REAL_ERRORS" = "0" ]; then
  record "判据d 日志无 error" 1 "$LOGLINES 行，真实 error 0 条（已排除 errors/ 静态页复制与 linker 警告）"
else
  record "判据d 日志无 error" 0 "$LOGLINES 行，真实 error $REAL_ERRORS 条，见下"
  grep -nE '(^|[^A-Za-z])Error:|ERROR|TypeError|Uncaught|unhandledRejection|FATAL' "$OUT/08-st.log" | grep -v 'Content file errors/' | grep -v 'WARNING: linker:' | head -5
fi

# ── listening 行为佐证 ──
grep -i 'listening on' "$OUT/08-st.log" | head -1 >"$OUT/09-listening-line.txt" 2>/dev/null

rule
say "== 5. 附：内存与开销（喂给 T15.3 的数据） =="
rule
"$ADB" -s "$SERIAL" shell "ps -A 2>/dev/null | grep libnode | head -1" >"$OUT/10-rss.txt" 2>&1
say "  $(tr -d '\r' <"$OUT/10-rss.txt")"
"$ADB" -s "$SERIAL" shell "free -m | sed -n '2p'" >>"$OUT/10-rss.txt" 2>&1

rule
say "== 结论 =="
rule
TOTAL=$((PASS + FAIL))
if [ "$FAIL" = "0" ]; then
  say "[OK] 四判据全过（$PASS 项）"
  printf 'VERDICT=PASS PASSED=%s TOTAL=%s\n' "$PASS" "$TOTAL" >>"$OUT/verdict.txt"
else
  say "[FAIL] $FAIL 项未过，共 $TOTAL 项"
  printf 'VERDICT=FAIL FAILED=%s TOTAL=%s\n' "$FAIL" "$TOTAL" >>"$OUT/verdict.txt"
fi
say ""
say "证据目录：$OUT"
say "（把这一行路径发给我，我读证据给结论）"

[ "$FAIL" = "0" ] || exit 1
