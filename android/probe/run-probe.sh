#!/usr/bin/env bash
#
# T15.3 生死项：在真机上验证「libnode.so 能不能被 exec」。
#
# ## 这个脚本替你做完整条链路
#
#   build APK → 装 → 启动 → 点按钮 → 读屏 → 判定
#
# ## 为什么值得写成脚本
#
# 这条验证有 **5 个必须同时成立的条件**，任何一个漏掉都会失败，
# 而失败信息各不相同、且都不指向真正缺的那一条（详见 README 的排查表）。
# 手工验一次要十几分钟，而 T15.3 主体开发期间会反复验 ——
# 把它固化成一条命令，比每次重记那 5 条靠得住。
#
# 用法：
#   bash run-probe.sh                 # 全流程
#   bash run-probe.sh --no-build      # 只装+验（APK 已存在时）
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
APK="$HERE/app/build/outputs/apk/release/app-release.apk"
PKG="studio.taverncard.probe"
ACT="$PKG/.MainActivity"

: "${JAVA_HOME:=D:/android-env/jdk-17}"
: "${ANDROID_HOME:=D:/android-env/sdk}"
export JAVA_HOME ANDROID_HOME
export ANDROID_SDK_ROOT="$ANDROID_HOME"
ADB="$ANDROID_HOME/platform-tools/adb.exe"

# 签名参数（keystore 在仓库外，见 vendor/android-env/gen-release-keystore.sh）
export TCS_KEYSTORE="${TCS_KEYSTORE:-D:/tcs-release-keys/tcs-release.jks}"
export TCS_KEY_ALIAS="${TCS_KEY_ALIAS:-tcs-release}"
if [ -z "${TCS_KEYSTORE_PASSWORD:-}" ] && [ -f D:/tcs-release-keys/keystore.properties ]; then
  TCS_KEYSTORE_PASSWORD=$(sed -n 's/^storePassword=//p' D:/tcs-release-keys/keystore.properties)
  export TCS_KEYSTORE_PASSWORD
fi

# Windows 的 adb 参数里 /data/... 会被 MSYS 改写成 C:/...
# 必须禁用路径转换，否则 push / pm install 都会静默指向本地磁盘
export MSYS_NO_PATHCONV=1

die() { printf '✘ %s\n' "$1" >&2; exit 1; }
say() { printf '   %s\n' "$1"; }
step() { printf '\n== %s ==\n' "$1"; }

step "0. 前置检查"
[ -x "$ADB" ] || die "找不到 adb：$ADB（先跑 vendor/android-env/install-android-env-win.sh）"
"$ADB" start-server >/dev/null 2>&1 || true
DEV=$("$ADB" devices | awk 'NR>1 && $2=="device"{print $1; exit}')
[ -n "$DEV" ] || die "没有已授权的设备（adb devices 里要有 device）"
say "设备：$DEV"

# 锁屏时安装会失败，且错误是 `INSTALL_FAILED_ABORTED: User rejected permissions`
# —— 看起来像用户点了拒绝，其实根本没有弹窗出来（屏幕黑着）。
# 所以先唤醒并解锁。
step "1. 唤醒并解锁屏幕"
"$ADB" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
"$ADB" shell input swipe 540 1800 540 600 200 >/dev/null 2>&1 || true
sleep 1
LOCKED=$("$ADB" shell "dumpsys window | grep mDreamingLockscreen" 2>/dev/null | tail -1 || true)
case "$LOCKED" in
  *"=true"*) die "屏幕仍锁着 —— 手工解锁后重跑（锁屏时装包会报 User rejected permissions，与权限无关）" ;;
  *) say "已解锁" ;;
esac

if [ "${1:-}" != "--no-build" ]; then
  step "2. 打包（release 签名）"
  [ -n "${TCS_KEYSTORE_PASSWORD:-}" ] || die "缺 TCS_KEYSTORE_PASSWORD"
  ( cd "$HERE" && ./gradlew assembleRelease --no-daemon -q ) || die "打包失败"
fi
[ -f "$APK" ] || die "APK 不存在：$APK"
say "APK $(stat -c %s "$APK") 字节"

step "3. 验 APK 结构（装机前就能查的三条）"
python - "$APK" <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
libs = {i.filename: i for i in z.infolist() if i.filename.startswith("lib/")}
bad = []
for name in ("libnode.so", "libc++_shared.so"):
    key = f"lib/arm64-v8a/{name}"
    if key not in libs:
        bad.append(f"缺 {key}")
if bad:
    print("   ✘ " + "；".join(bad)); sys.exit(1)
for key, info in sorted(libs.items()):
    # compress_type 8 = DEFLATE。extractNativeLibs=false 时会是 STORED(0)。
    print(f"   OK {key}  压缩后={info.compress_size:,} 方式={info.compress_type}")
PY

step "4. 装包"
# 先推到 /data/local/tmp 再 pm install：直连 `adb install` 在部分机型上
# 会因为流式安装与安全校验的交互报 User rejected permissions，而 pm install 不会。
"$ADB" push "$APK" /data/local/tmp/probe.apk >/dev/null || die "push 失败"
INST=$("$ADB" shell pm install -r -t /data/local/tmp/probe.apk 2>&1 | tr -d '\r')
case "$INST" in
  *Success*) say "已安装" ;;
  *) die "安装失败：$INST" ;;
esac

step "5. 启动并执行 --version"
"$ADB" shell am force-stop "$PKG" >/dev/null 2>&1 || true
"$ADB" logcat -c >/dev/null 2>&1 || true
"$ADB" shell am start -n "$ACT" >/dev/null 2>&1 || die "启动失败"
sleep 4
# 按钮在页面顶部（详见 MainActivity 的布局：按钮是第一个子 view）
"$ADB" shell input tap 540 355 >/dev/null 2>&1 || true
sleep 8

step "6. 判定"
SHOT="$HERE/.last-probe.png"
"$ADB" exec-out screencap -p > "$SHOT" 2>/dev/null || true
if [ -f "$SHOT" ]; then
  say "截图：$SHOT"
fi

# 决定性判据：logcat 里没有崩溃，且屏幕上出现过 v22/v20 版本号。
# 用截图 OCR 不稳（各机型字体不同），所以这里用**进程是否存活 + 无 CANNOT LINK/EACCES**判定，
# 版本号请人工看截图确认（README 的判据表里写明"从 stdout 读，不是猜"）。
ERRORS=$("$ADB" logcat -d 2>&1 | grep -E "CANNOT LINK EXECUTABLE|Permission denied|EACCES" | grep -i taverncard | head -2 || true)
if [ -n "$ERRORS" ]; then
  echo "$ERRORS" | sed 's/^/   ✘ /'
  die "执行失败（看上面）：CANNOT LINK → 缺依赖或 LD_LIBRARY_PATH；EACCES → W^X 没过"
fi

# 我方的 avc denied（shell 上下文的不算：那是 adb 命令自己触发的）
AVC=$("$ADB" logcat -d 2>&1 | grep "avc: *denied" | grep -i taverncard | head -2 || true)
if [ -n "$AVC" ]; then
  echo "$AVC" | sed 's/^/   ⚠ /'
  die "有 SELinux 拦截（不是 W^X 问题，是策略问题）"
fi
say "无 CANNOT LINK / 无 EACCES / 无 SELinux 拦截"

printf '\n✔ 链路通过。请人工看截图确认屏上打印了 v22.x.x（这一步不能靠脚本猜）。\n'
