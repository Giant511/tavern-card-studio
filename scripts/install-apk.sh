#!/usr/bin/env bash
# 把这一版 APK 装到真机上（Windows / Git Bash）。
#
# ## 为什么要有这个脚本
#
# APK 2026-10-31 13:06 就构建好了，但 `adb devices` 一直是 `offline`
# 然后直接**从列表里消失** —— Windows 侧 `Get-PnpDevice` 也查不到任何
# Android/MTP 设备。那是 **USB 物理层断开**（线松了 / 只充电模式 /
# 数据线本身只有电源线），不是息屏挂起。
#
# 两条区分方式（记忆 §57 记过）：
#   · `offline`          → 设备还在，息屏挂起，解锁屏幕就好
#   · 整条从列表消失      → USB 物理层断，重插 / 换线 / 改传输模式
#
# 所以这个脚本把"检查 → 安装 → 启动 → 取版本"串成一次动作，
# 你插好线跑一次就行，不用记 adb 参数。
#
# ## 用法
#
#   bash scripts/install-apk.sh
#
# 可选环境变量：
#   APK=path/to.apk   指定别的包（默认用 release/android 下最新的 ui-fix 包）

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADB="${ADB:-D:/android-env/sdk/platform-tools/adb.exe}"
[ -f "$ADB" ] || ADB="adb"
AAPT="${AAPT:-D:/android-env/sdk/build-tools/36.0.0/aapt2.exe}"

APK="${APK:-$REPO/release/android/tavern-card-studio-0.1.7-arm64-debug-ui-fix.apk}"
if [ ! -f "$APK" ]; then
  echo "[FATAL] 找不到 APK：$APK" >&2
  exit 2
fi

# ── 包名与入口 Activity **从 APK 里读**，不写死 ──
#
# 写死的问题：包名/Activity 一改，`install` 仍然成功（它只认文件），
# 但 `am start` 会报 "Activity class does not exist" —— 而那时
# 用户看到的只是"装好了但没起来"，很容易归因成"APK 坏了"。
# `aapt2 dump` 是确定性的，装之前就知道要启动谁。
if [ -f "$AAPT" ]; then
  PKG=$(MSYS_NO_PATHCONV=1 "$AAPT" dump packagename "$APK" 2>/dev/null | head -1 | tr -d '\r')
  ACT=$(MSYS_NO_PATHCONV=1 "$AAPT" dump badging "$APK" 2>/dev/null \
    | sed -n "s/^launchable-activity: name='\([^']*\)'.*/\1/p" | head -1 | tr -d '\r')
fi
PKG="${PKG:-com.taverncardstudio.client}"
ACT="${ACT:-com.taverncardstudio.client.MainActivity}"

echo "APK  = $APK"
echo "大小 = $(du -h "$APK" | cut -f1)"
echo "sha256(前16) = $(sha256sum "$APK" | cut -c1-16)"
echo "包名 = $PKG"
echo "入口 = $ACT"
echo

# ── ① 等设备就绪（最多 60 秒，让你有时间插线） ──
echo "== 等待设备 =="
STATE=""
for i in $(seq 1 30); do
  STATE=$(MSYS_NO_PATHCONV=1 "$ADB" get-state 2>/dev/null | tr -d '\r')
  case "$STATE" in
    device)
      echo "  [OK] 已连接（第 $i 次探测）"
      break
      ;;
    offline)
      # 设备在、但没就绪 —— 多半是息屏。提示解锁而不是傻等。
      if [ "$i" -eq 1 ]; then
        echo "  [..] 设备 offline：请解锁手机屏幕（息屏会挂起 adb）"
      fi
      ;;
    *)
      if [ "$i" -eq 1 ]; then
        echo "  [..] 未检测到设备：请插好数据线，并在手机上选「传输文件(MTP)」"
      fi
      ;;
  esac
  # 每 6 次重连一下（`reconnect` 会重新握手，能救回 offline）
  [ $((i % 6)) -eq 0 ] && MSYS_NO_PATHCONV=1 "$ADB" reconnect >/dev/null 2>&1
  sleep 2
done

if [ "$STATE" != "device" ]; then
  echo
  echo "[FAIL] 60 秒内没等到设备。最后一次状态：${STATE:-空}" >&2
  echo
  echo "按这个顺序排查（从最常见开始）：" >&2
  echo "  1. 换一根**能传数据**的线（很多线只有电源线，只能充电）" >&2
  echo "  2. 手机下拉通知栏 → USB 用途选「传输文件 (MTP)」，不要选「仅充电」" >&2
  echo "  3. 手机 设置 → 开发者选项 → 撤销 USB 调试授权，然后重新插线并点「允许」" >&2
  echo "  4. 换个 USB 口（优先主板后面的口，别用前面板或 USB Hub）" >&2
  exit 3
fi

# ── ② 认机型（装错机器时能看出来） ──
echo
echo "== 设备信息 =="
echo "  型号   = $(MSYS_NO_PATHCONV=1 "$ADB" shell getprop ro.product.model 2>/dev/null | tr -d '\r')"
echo "  Android= $(MSYS_NO_PATHCONV=1 "$ADB" shell getprop ro.build.version.release 2>/dev/null | tr -d '\r')"
echo "  ABI    = $(MSYS_NO_PATHCONV=1 "$ADB" shell getprop ro.product.cpu.abi 2>/dev/null | tr -d '\r')"
echo "  已装版本 = $(MSYS_NO_PATHCONV=1 "$ADB" shell dumpsys package "$PKG" 2>/dev/null | grep -m1 versionName | tr -d '\r' | sed 's/.*versionName=//')"

# ── ③ 装 ──
#
# `-r` 覆盖安装且**保留数据**（设置、API key 都还在）。
# 因为这一版与已装的 debug 包是**同一张证书**（CN=Android Debug），
# 不会出现"签名冲突 → 装不上"（记忆 §58 那次 release 装不上的真因）。
echo
echo "== 安装（-r 覆盖，保留数据） =="
MSYS_NO_PATHCONV=1 "$ADB" install -r "$APK" 2>&1 | tail -3
INSTALL_RC=${PIPESTATUS[0]}

if [ "$INSTALL_RC" -ne 0 ]; then
  echo
  echo "[FAIL] 安装失败（rc=$INSTALL_RC）" >&2
  echo "  若是 INSTALL_FAILED_UPDATE_INCOMPATIBLE：证书不一致，需要先卸载旧包：" >&2
  echo "    \"$ADB\" uninstall $PKG" >&2
  exit 4
fi

# ── ④ 启动 ──
echo
echo "== 启动 =="
MSYS_NO_PATHCONV=1 "$ADB" shell am start -n "$PKG/$ACT" 2>&1 | tail -2

# ── ⑤ 核对装上的版本 ──
#
# 判据不能只看 `install` 输出 Success —— 那只能证明这个文件被系统接受了。
# 装完之后从**设备侧**读回 versionCode/versionName 与 lastUpdateTime，
# 才能确认"现在手机里跑的就是这一个包"。
echo
echo "== 设备侧核对 =="
MSYS_NO_PATHCONV=1 "$ADB" shell dumpsys package "$PKG" 2>/dev/null \
  | grep -E "versionCode|versionName|firstInstallTime|lastUpdateTime" \
  | head -4 | tr -d '\r' | sed 's/^/  /'

echo
echo "完成。现在可以："
echo "  · 在手机上打开 App，确认底部输入区是贴着 Tab 栏的"
echo "  · 我的 → API 连接，点任一项看是否就地展开配置"
echo "  · 我的 → 语音输入，看有没有入口且能展开"
