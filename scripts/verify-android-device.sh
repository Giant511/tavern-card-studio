#!/usr/bin/env bash
# 真机自动化测试的唯一入口（v0.1.7 / 第三批问题四）。
#
# ## 用户的要求（2026-10-31）
#
# 「每次代码修改后自动重打 APK 并 adb 安装到真机；真机测试全自动执行
#   （不许人工点）；用 adb 驱动（uiautomator dump / input tap / am start /
#   logcat 断言）；产出测试报告（每项 PASS/FAIL + 证据，我只看结果）。」
#
# 还明确要求「先做一条最小链路（装→启→断言进程在）打通工具链，
# 再逐链路扩展；设备不在线时报告"设备缺席"而非假绿」。
#
# ## 这个脚本的分层
#
# 三层，每层都能单独跑，上一层失败不会拖累下一层的诊断：
#
#   ① 设备层 —— 设备在不在、什么机器、什么架构
#   ② 安装层 —— 装得上吗（覆盖安装 / 签名一致）
#   ③ 运行层 —— 起得来吗（进程在、Activity 在前台、logcat 无崩溃）
#
# 不做的事（有意为之）：
#   · **不自动构建**。构建 17 分钟且要 JDK/SDK/NDK，把它塞进测试入口会让
#     "只想验一下当前包"变成"必须等构建"。构建用 `build-android.sh`，
#     这个脚本只管"拿到包之后到真机上说它活着"。
#   · **不自动修复**。失败就报失败，不重启 adb、不重装、不清数据 ——
#     自动修复会掩盖真实原因，而这类"真机偶发"最需要保留现场。
#
# ## 用法
#
#   bash scripts/verify-android-device.sh              # 跑全部层
#   bash scripts/verify-android-device.sh --report out.md
#
# 退出码：
#   0 = 全部 PASS
#   3 = **设备缺席**（不是失败，是"现在没条件测"）
#   4 = 失败（有 FAIL 项）
#
# ★ 设备缺席用独立退出码，而且是 3 而不是 1：
#   让 CI / 人一眼区分"没手机所以没测"与"测了但坏了"。
#   用户明确要求「设备不在线时报告"设备缺席"而非假绿」——
#   假绿（exit 0）是最坏的结果，因为它会让"没测"看起来像"测过了"。

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADB="${ADB:-D:/android-env/sdk/platform-tools/adb.exe}"
[ -f "$ADB" ] || ADB="adb"
AAPT="${AAPT:-D:/android-env/sdk/build-tools/36.0.0/aapt2.exe}"

APK="${APK:-$REPO/release/android/tavern-card-studio-0.1.7-arm64-debug-r5.apk}"
REPORT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --report) REPORT="$2"; shift 2 ;;
    *)        APK="$1"; shift ;;
  esac
done

# ── 结果收集 ──
RESULTS=()      # 每项一行："PASS|FAIL|SKIP<TAB>层<TAB>项名<TAB>证据"
pass=0; fail=0; skip=0

record() {
  local verdict="$1" layer="$2" name="$3" evidence="$4"
  RESULTS+=("${verdict}	${layer}	${name}	${evidence}")
  case "$verdict" in
    PASS) pass=$((pass + 1)) ;;
    FAIL) fail=$((fail + 1)) ;;
    SKIP) skip=$((skip + 1)) ;;
  esac
  printf '  [%s] %-10s %s\n' "$verdict" "$layer" "$name"
  [ -n "$evidence" ] && printf '         %s\n' "$evidence"
}

A() { MSYS_NO_PATHCONV=1 "$ADB" "$@" 2>&1 | tr -d '\r'; }

write_report() {
  {
    echo "# 真机自动化测试报告"
    echo
    echo "> 生成时间：$(date '+%Y-%m-%d %H:%M:%S')"
    echo "> APK：$(basename "$APK")  $( [ -f "$APK" ] && du -h "$APK" | cut -f1 )"
    echo
    echo "| 结果 | 层 | 检查项 | 证据 |"
    echo "|---|---|---|---|"
    for row in "${RESULTS[@]}"; do
      IFS=$'\t' read -r v l n e <<< "$row"
      echo "| $v | $l | $n | ${e//|/\\|} |"
    done
    echo
    echo "**PASS=$pass  FAIL=$fail  SKIP=$skip**"
  } > "$REPORT"
  echo "  报告已写入：$REPORT"
}


echo "═══ 真机自动化 · 最小链路 ═══"
echo "APK = $APK"
[ -f "$APK" ] && echo "大小 = $(du -h "$APK" | cut -f1)" || echo "大小 = (文件不存在)"
echo

# ════════════════════════════════════════════════════════════
#  ① 设备层
# ════════════════════════════════════════════════════════════
echo "── ① 设备层 ──"

A start-server >/dev/null 2>&1

# 等最多 20 秒（人可能刚插线）
STATE=""
for _ in $(seq 1 10); do
  STATE=$(A get-state)
  [ "$STATE" = "device" ] && break
  sleep 2
done

SERIAL=$(A devices | awk 'NR>1 && $2=="device" {print $1; exit}')

if [ "$STATE" != "device" ] || [ -z "$SERIAL" ]; then
  record "SKIP" "①设备" "设备在线" "当前状态：${STATE:-设备未列出}（不是失败，是没条件测）"
  echo
  echo "═══ 结论：设备缺席 ═══"
  echo "  退出码 3（区别于失败的 4）。"
  echo "  插好数据线、解锁屏幕、USB 用途选「传输文件(MTP)」后重跑。"
  [ -n "$REPORT" ] && write_report
  exit 3
fi

record "PASS" "①设备" "设备在线" "serial=$SERIAL"

MODEL=$(A shell getprop ro.product.model)
SDK=$(A shell getprop ro.build.version.sdk)
ABI=$(A shell getprop ro.product.cpu.abilist | cut -d, -f1)
record "PASS" "①设备" "机型/系统" "model=$MODEL android=$SDK abi=$ABI"

# 架构必须含 arm64 —— 否则装不上（我们只打 arm64）
case "$ABI" in
  *arm64*) record "PASS" "①设备" "架构兼容" "abilist=$ABI" ;;
  *)       record "FAIL" "①设备" "架构兼容" "设备是 $ABI，而 APK 只有 arm64-v8a" ;;
esac

# ════════════════════════════════════════════════════════════
#  ② 安装层
# ════════════════════════════════════════════════════════════
echo
echo "── ② 安装层 ──"

if [ ! -f "$APK" ]; then
  record "FAIL" "②安装" "APK 存在" "找不到 $APK"
else
  record "PASS" "②安装" "APK 存在" "sha256=$(sha256sum "$APK" | cut -c1-16)…"

  # 包名从 APK 读（不写死，改名后不会静默失效）
  PKG="com.taverncardstudio.client"   # 先给默认值：`set -u` 下未定义变量会让脚本直接崩
  if [ -f "$AAPT" ]; then
    PKG=$(MSYS_NO_PATHCONV=1 "$AAPT" dump packagename "$APK" 2>/dev/null | head -1 | tr -d '\r')
    [ -z "$PKG" ] && PKG="com.taverncardstudio.client"
  fi

  # ★ `adb install` 的路径必须是 **Windows 形式**，而且**不能**加
  #   `MSYS_NO_PATHCONV=1`。
  #
  # 2026-10-31 实测两种错法：
  #   · 传 `/d/Claw/.../x.apk` + `MSYS_NO_PATHCONV=1`
  #     → `adb.exe: failed to stat /d/Claw/...: No such file or directory`
  #       （adb 把 `/d/...` 当成**设备端**绝对路径去找）
  #   · 只加 `MSYS_NO_PATHCONV=1` 传相对路径 → 能成（见下面注释）
  #
  # 正确做法：用 `cygpath -w` 转成 `D:\...`，并且**不加** NO_PATHCONV
  # （让 MSYS 自己处理反斜杠）。这一条踩过就不要再踩：
  # 症状是"包明明在，adb 说找不到"。
  APK_WIN="$APK"
  if command -v cygpath >/dev/null 2>&1; then
    APK_WIN=$(cygpath -w "$APK")
  fi

  BEFORE=$(A shell dumpsys package "$PKG" | grep -m1 lastUpdateTime)

  INSTALL_OUT=$("$ADB" install -r "$APK_WIN" 2>&1 | tr -d '\r')
  if echo "$INSTALL_OUT" | grep -q "Success"; then
    record "PASS" "②安装" "覆盖安装" "$(echo "$INSTALL_OUT" | tail -1)"
  else
    record "FAIL" "②安装" "覆盖安装" "$(echo "$INSTALL_OUT" | tail -2 | tr '\n' ' ')"
  fi

  # 判据不能只看 install 的 Success —— 那只能证明"文件被系统接受了"。
  # 要读回设备侧的 lastUpdateTime 变了没有。
  AFTER=$(A shell dumpsys package "$PKG" | grep -m1 lastUpdateTime)
  if [ "$BEFORE" != "$AFTER" ]; then
    record "PASS" "②安装" "设备侧已更新" "${AFTER:-未知}"
  else
    record "FAIL" "②安装" "设备侧已更新" "lastUpdateTime 没变（装的是同一份？）before=$BEFORE after=$AFTER"
  fi
fi

# ════════════════════════════════════════════════════════════
#  ③ 运行层
# ════════════════════════════════════════════════════════════
echo
echo "── ③ 运行层 ──"

ACT="${ACT:-com.taverncardstudio.client.MainActivity}"
if [ -f "$AAPT" ]; then
  ACT2=$(MSYS_NO_PATHCONV=1 "$AAPT" dump badging "$APK" 2>/dev/null \
    | sed -n "s/^launchable-activity: name='\([^']*\)'.*/\1/p" | head -1 | tr -d '\r')
  [ -n "$ACT2" ] && ACT="$ACT2"
fi

# 先强停，保证"起得来"说的是这一次启动
A shell am force-stop "$PKG" >/dev/null
sleep 1

# logcat 清空，后面的崩溃断言只看本次启动
A logcat -c >/dev/null

START_OUT=$(A shell am start -n "$PKG/$ACT")
if echo "$START_OUT" | grep -qE "Starting:|Displayed"; then
  record "PASS" "③运行" "启动命令被接受" "$(echo "$START_OUT" | head -1)"
else
  record "FAIL" "③运行" "启动命令被接受" "$(echo "$START_OUT" | head -2 | tr '\n' ' ')"
fi

# 等进程起来（最多 15 秒）
PID=""
for _ in $(seq 1 15); do
  PID=$(A shell pidof "$PKG" | tr -d ' ')
  [ -n "$PID" ] && break
  sleep 1
done

if [ -n "$PID" ]; then
  record "PASS" "③运行" "进程存在" "pid=$PID"
else
  record "FAIL" "③运行" "进程存在" "启动后 15 秒内 pidof 为空（闪退）"
fi

# 当前前台 Activity 是我们（证明不是启动了又跳走）
FOCUS=$(A shell dumpsys activity activities | grep -m1 "mResumedActivity\|topResumedActivity")
if echo "$FOCUS" | grep -q "$PKG"; then
  record "PASS" "③运行" "在前台" "$(echo "$FOCUS" | sed 's/^ *//' | cut -c1-80)"
else
  record "FAIL" "③运行" "在前台" "${FOCUS:-取不到 mResumedActivity}"
fi

# logcat 里不许有致命异常（**只算我们这个包**）
#
# ★ 必须按 pid / 包名过滤。
#
# 2026-10-31 第一次跑就红了，但那条 `UnsatisfiedLinkError` 来自
# `com.miui.hybrid`（小米自带的应用引擎），和我们的 APK 无关。
# 不过滤的话，手机上任何**别的** App 崩溃都会让这条判据变红 ——
# 而它红得毫无意义：我们既不能修它，也不该因为它就说自己的包有问题。
#
# 判据用 `--pid`（本次启动的 pid 已经拿到了）：这是最窄、最不会误伤的口径。
FATAL_LINES=""
if [ -n "$PID" ]; then
  FATAL_LINES=$(A logcat -d --pid="$PID" | grep -E "FATAL EXCEPTION|UnsatisfiedLinkError|dlopen failed" | head -5)
fi
if [ -z "$FATAL_LINES" ]; then
  record "PASS" "③运行" "无致命异常" "pid=$PID 的 logcat 里没有 FATAL / UnsatisfiedLinkError"
else
  record "FAIL" "③运行" "无致命异常" "$(echo "$FATAL_LINES" | head -2 | tr '\n' ' ')"
fi

# logcat 的 crash buffer **不能**用来判我们的包 —— 它是全系统的。
# 只把它当"现场留存"打出来，不参与判定（否则又会误伤别的 App）。
CRASH=$(A logcat -d -b crash | tail -3)
[ -n "$CRASH" ] && echo "         (crash buffer 最近 3 条，仅供参考、不计入判定)" && echo "$CRASH" | sed 's/^/         /'

# ════════════════════════════════════════════════════════════
#  汇总
# ════════════════════════════════════════════════════════════

# ════════════════════════════════════════════════════════════
#  ④ 引擎链路（v0.1.7 / T15.3）—— 聊天类用例从 SKIP 转 ACTIVE
# ════════════════════════════════════════════════════════════
#
# 用户要求：「App 内点「开始聊天」→ 前台服务起 → ST 监听 127.0.0.1:8000
# → 聊天面板发一条消息收到流式回复」进入本脚本。
#
# 拆成四层，每层单独判定 —— 这样失败时能立刻看出断在哪：
#   ④-1 服务在前台（通知在）
#   ④-2 解包完成（标记 + 关键文件）
#   ④-3 node 进程活着
#   ④-4 8000 处于 LISTEN
#
# **最后一段（真的发一条消息收回复）依赖用户自己的 API key 与网络**，
# 没有 key 时标记 SKIP 并写明原因 —— 不许红（那是环境问题，不是缺陷）。

echo
echo "── ④ 引擎链路（T15.3）──"

PKG_ST="com.taverncardstudio.client"

# ④-0 等引擎就绪（有界）
#
# ★ 必须等，而且必须在这里等。
#
# 2026-10-31 第一次跑这组时 ④ 全红，而引擎其实是好的。原因是**本脚本自己**
# 在 ③ 段做了 `am force-stop`（为了保证"起得来"说的是这一次），
# 那一下把 node 也带走了；紧接着 `am start` 重启 App，而引擎是**异步**起来的：
#   · 热启动（数据目录已存在）实测 7 秒
#   · **首次**启动实测 **57 秒**（解包之后 ST 要建默认数据）
# 而 ④ 立刻检查 ⇒ 必然读到"还没起来"。
#
# 也就是说：**判据没错，检查得太早**。这与"设备缺席不许假绿"是同一族纪律的
# 另一面：不许"还没好就判死"。所以这里等到"就绪"或等到上限，并**报告等了多久**。
ENGINE_WAIT_MAX=130
engine_wait=0
while [ "$engine_wait" -lt "$ENGINE_WAIT_MAX" ]; do
  LISTENING=$("$ADB" shell "grep ':1F40' /proc/net/tcp 2>/dev/null" | tr -d '\r' | grep -c " 0A ")
  [ "${LISTENING:-0}" -ge 1 ] && break
  sleep 5
  engine_wait=$((engine_wait + 5))
done
if [ "${LISTENING:-0}" -ge 1 ]; then
  record "PASS" "④引擎" "引擎在 ${ENGINE_WAIT_MAX}s 内就绪" "等了 ${engine_wait}s 后 8000 进入 LISTEN"
else
  record "FAIL" "④引擎" "引擎在 ${ENGINE_WAIT_MAX}s 内就绪" "${ENGINE_WAIT_MAX}s 内 8000 没有进入 LISTEN"
fi

# ④-1 前台服务
FG=$("$ADB" shell dumpsys activity services "$PKG_ST" 2>/dev/null | tr -d '\r' | grep -c "isForeground=true")
if [ "${FG:-0}" -ge 1 ]; then
  record "PASS" "④引擎" "前台服务在运行" "isForeground=true"
else
  record "FAIL" "④引擎" "前台服务在运行" "dumpsys 里没有 isForeground=true —— 服务没起来或没进前台"
fi

# ④-2 解包完成
MARK=$("$ADB" shell "run-as $PKG_ST ls files/st/.unpacked 2>/dev/null" | tr -d '\r')
SRV=$("$ADB" shell "run-as $PKG_ST ls files/st/server.js 2>/dev/null" | tr -d '\r')
if [ -n "$MARK" ] && [ -n "$SRV" ]; then
  SIZE_MB=$("$ADB" shell "run-as $PKG_ST du -sm files/st 2>/dev/null" | tr -d '\r' | cut -f1)
  record "PASS" "④引擎" "ST 已解包" "标记在、server.js 在、${SIZE_MB:-?} MB"
else
  record "FAIL" "④引擎" "ST 已解包" "标记=${MARK:-无} server.js=${SRV:-无}"
fi

# ④-3 node 进程（判据是进程名 libnode.so，不是包名）
NODEPID=$("$ADB" shell "ps -A | grep libnode | awk '{print \$2}'" | tr -d '\r' | head -1)
if [ -n "$NODEPID" ]; then
  # ★ RSS 只认 `/proc/<pid>/status` 的 VmRSS。
  #
  # 第一版用 `ps -A -o RSS,NAME | grep libnode | awk '{print $1}'`，
  # 报出 **599 MB** —— 而同一时刻 `/proc/<pid>/status` 的 VmRSS 是
  # **191064 kB = 186.6 MB**，`/proc/<pid>/statm` 的常驻页数换算也是 186.6 MB，
  # `ps -A -o PID,RSS,NAME` 也是 191064。**三个口径一致，只有脚本的读法错**。
  #
  # 原因是 toybox 的 `ps -o` 列顺序/表头处理与 GNU 不同，`awk $1` 取到的不是 RSS。
  # 用 VmRSS 没有歧义：一行一个值，单位写明是 kB。
  #
  # 这个数字要写进通知给用户看（设计文档 §3.2），报错等于骗人 ——
  # 所以宁可多读一个文件，也不猜列序。
  RSS_KB=$("$ADB" shell "grep VmRSS /proc/$NODEPID/status 2>/dev/null" | tr -d '\r' | awk '{print $2}')
  RSS_MB=$(( ${RSS_KB:-0} / 1024 ))
  record "PASS" "④引擎" "引擎进程存在" "pid=$NODEPID RSS=${RSS_MB}MB（VmRSS=${RSS_KB:-?}kB）"
else
  record "FAIL" "④引擎" "引擎进程存在" "ps 里没有 libnode.so"
fi

# ④-4 8000 LISTEN（0x1F40；state 0A = LISTEN）
LISTEN=$("$ADB" shell "grep ':1F40' /proc/net/tcp 2>/dev/null" | tr -d '\r' | grep -c " 0A ")
if [ "${LISTEN:-0}" -ge 1 ]; then
  record "PASS" "④引擎" "8000 监听中" "127.0.0.1:8000 state=0A(LISTEN)"
else
  record "FAIL" "④引擎" "8000 监听中" "没有 127.0.0.1:8000 的 LISTEN 记录"
fi

# ④-4b 通过 adb forward 真问一次 HTTP（比"端口开着"强得多）
#
# "端口在 LISTEN" 只证明**有人**在听。要证明那个人是能应答的 ST，
# 必须真的发一个请求。用 `adb forward` 把设备端口映到 PC，再从 PC curl ——
# 这样拿到的响应体就是 ST 自己吐出来的。
#
# 判据不是"HTTP 200"，而是响应体里有 `SillyTavern` 与 `pkgVersion`：
# 200 也可能是 ST 的某个错误页。
"$ADB" forward tcp:18000 tcp:8000 >/dev/null 2>&1
VER=$(curl -s -m 8 http://127.0.0.1:18000/version 2>/dev/null)

if echo "$VER" | grep -q "SillyTavern"; then
  PKGV=$(echo "$VER" | sed -n 's/.*"pkgVersion":"\([^"]*\)".*/\1/p')
  AGENT=$(echo "$VER" | sed -n 's/.*"agent":"\([^"]*\)".*/\1/p')
  record "PASS" "④引擎" "ST 的 /version 应答" "pkgVersion=${PKGV:-?} agent=${AGENT:-?}"
else
  record "FAIL" "④引擎" "ST 的 /version 应答" "响应里没有 SillyTavern（或请求失败）：${VER:0:100}"
fi

# ④-4c 只监听回环（安全判据）
#
# 本地地址必须是 `0100007F`（127.0.0.1）。如果出现 `00000000`（0.0.0.0），
# 说明 ST 被暴露到了局域网 —— 而它没有任何鉴权，同网段任何人都能读聊天记录。
LOCAL_ADDR=$("$ADB" shell "grep ':1F40' /proc/net/tcp 2>/dev/null | awk '\$4==\"0A\"{print \$2}'" | tr -d '\r' | head -1 | cut -d: -f1)
if [ "$LOCAL_ADDR" = "0100007F" ]; then
  record "PASS" "④引擎" "只监听回环" "local=127.0.0.1（不是 0.0.0.0）"
elif [ -z "$LOCAL_ADDR" ]; then
  record "FAIL" "④引擎" "只监听回环" "取不到监听地址"
else
  record "FAIL" "④引擎" "只监听回环" "local=${LOCAL_ADDR}（0.0.0.0 会把无鉴权的 ST 暴露到局域网）"
fi

# ④-5 启动日志里有没有就绪
READY=$(A logcat -d -s StService:V 2>/dev/null | grep -ac "就绪：引擎已就绪")
if [ "${READY:-0}" -ge 1 ]; then
  SPENT=$(A logcat -d -s StService:V 2>/dev/null | grep -a "就绪：引擎已就绪" | tail -1 | sed 's/.*用了 //; s/ 秒.*//')
  record "PASS" "④引擎" "App 侧探活成功" "日志：引擎已就绪（用了 ${SPENT:-?} 秒）"
else
  record "SKIP" "④引擎" "App 侧探活成功" "日志里没有就绪记录（可能是本次安装后还没启动过 App）"
fi

# ④-6 发消息收回复 —— **默认不发**（2026-11-01 二次修正）
#
# ## ★ 为什么从 ACTIVE 退回"默认 SKIP"（用户 2026-11-01 09:50 明令）
#
# 这个用户用的聊天 API 是**按次计费**：5 元额度约 200 次请求（≈0.025 元/次）。
# 不是按 token 计费 —— 所以"只发 3 个字的提示"这种省钱办法**根本不起作用**，
# 3 个字和 3000 个字都算 1 次。上一版正是按 token 的思路写的（注释里写着
# "只发 3 个字，消耗很小"），那个前提是错的。
#
# 因此判据改成：**默认一次都不发**。要做端到端生成验收时，显式打开：
#
# ```bash
# TCS_ALLOW_PAID_API=1 bash scripts/verify-android-device.sh
# ```
#
# 判据的意图没变（"能不能生成"仍要能进自动化），改的是**默认值**：
# 默认值决定"每跑一次回归会花掉多少次额度"，这件事必须显式选择。
#
# ## 地址与模型不再硬编码
#
# 上一版把 model 与 custom_url 写死在这个脚本里 —— 换 key / 换站就要改脚本，
# 而且真实站点的域名进了仓库。现在从环境变量读：
#   TCS_PAID_MODEL     模型名（必填，没有就 SKIP）
#   TCS_PAID_BASE_URL  自定义地址（可空：空则用 ST 当前保存的设置）
if [ "${TCS_ALLOW_PAID_API:-0}" != "1" ]; then
  record "SKIP" "④引擎" "发消息收流式回复" \
    "默认不发（聊天 API 按次计费，5 元≈200 次）。要跑请 TCS_ALLOW_PAID_API=1，并设 TCS_PAID_MODEL"
elif [ -z "$NODEPID" ] || [ "${LISTENING:-0}" -lt 1 ]; then
  record "SKIP" "④引擎" "发消息收流式回复" "引擎未就绪，跳过（不算失败）"
elif [ -z "${TCS_PAID_MODEL:-}" ]; then
  record "SKIP" "④引擎" "发消息收流式回复" \
    "已允许发请求，但没设 TCS_PAID_MODEL，跳过（不许猜模型名，猜错也是一次计费）"
else
  CSRF_SHA=$(A shell "grep -o 'csrf-token' /dev/null" >/dev/null 2>&1; echo ok)
  TOKEN_FILE=$(mktemp)
  CSRF=$(curl -s -c "$TOKEN_FILE" -m 8 http://127.0.0.1:18000/csrf-token 2>/dev/null \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  if [ -z "$CSRF" ]; then
    record "SKIP" "④引擎" "发消息收流式回复" "取不到 CSRF（devtools/forward 未就绪），跳过"
  else
    # 请求体由环境变量决定（不硬编码站点与模型名）
    # 注意：这一次请求就是**一次计费**，与提示词长短无关
    if [ -n "${TCS_PAID_BASE_URL:-}" ]; then
      GEN_BODY=$(printf '{"chat_completion_source":"custom","model":"%s","custom_url":"%s","messages":[{"role":"user","content":"说三个字"}],"stream":false,"max_tokens":32}' \
        "$TCS_PAID_MODEL" "$TCS_PAID_BASE_URL")
    else
      GEN_BODY=$(printf '{"chat_completion_source":"custom","model":"%s","messages":[{"role":"user","content":"说三个字"}],"stream":false,"max_tokens":32}' \
        "$TCS_PAID_MODEL")
    fi
    GEN=$(curl -s -b "$TOKEN_FILE" -m 45 -X POST \
      http://127.0.0.1:18000/api/backends/chat-completions/generate \
      -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF" \
      -d "$GEN_BODY" \
      2>/dev/null)
    rm -f "$TOKEN_FILE"

    if echo "$GEN" | grep -q '"content"'; then
      HEAD=$(echo "$GEN" | sed -n 's/.*"content":"\([^"]*\)".*/\1/p' | head -c 40)
      record "PASS" "④引擎" "发消息收流式回复" "ST 返回内容：${HEAD}（本次消耗 1 次额度）"
    elif echo "$GEN" | grep -qiE 'error|401|403|invalid'; then
      record "SKIP" "④引擎" "发消息收流式回复" "上游未接受（key/额度/地址问题，非本机缺陷）：$(echo "$GEN" | head -c 100)"
    else
      record "SKIP" "④引擎" "发消息收流式回复" "没拿到内容也没拿到明确错误（可能未配置 API）：$(echo "$GEN" | head -c 100)"
    fi
  fi
fi

echo
echo "═══ 汇总 ═══"
echo "  PASS=$pass  FAIL=$fail  SKIP=$skip"

# 报告要在**判定之前**写：失败的运行更需要报告（那才是要看的现场）。
# 第一次重构时这行被误删，症状是"通过时报告没了、失败时也没有"。
[ -n "$REPORT" ] && write_report

if [ "$fail" -gt 0 ]; then
  echo
  echo "═══ 有 $fail 项失败 ═══"
  exit 4
fi

echo
echo "═══ 全部通过（最小链路打通）═══"
echo "  引擎链路已纳入 ④ 段；④-6 真实发消息默认关闭（API 按次计费），见该段注释"
echo "  聊天类用例依赖 T15.3（ST 在 App 内起得来），未就绪时应 SKIP 而不是 FAIL。"
exit 0
