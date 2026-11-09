#!/usr/bin/env bash
#
# 安卓端构建环境安装（T15.3）。
#
# 在 Ubuntu 22.04 上装齐「能打 APK」的最小集合：JDK 17 + Android SDK
# （cmdline-tools / platform-34 / build-tools;34.0.0）+ Rust 的 aarch64-linux-android target。
#
# ## 用法
#
#   先看要做什么（不改机器）：
#     DRY_RUN=1 bash install-android-env.sh
#
#   真装（需要 sudo —— 只有 apt 那一步需要，其余都装到 $HOME）：
#     bash install-android-env.sh
#     然后按提示执行它打印的那一条 sudo 命令，再跑一次：
#     bash install-android-env.sh
#
# ## 为什么分成"两步 sudo"
#
# 脚本不自己调 `sudo`。理由：把 sudo 塞进脚本里面，用户就看不到它到底要装什么；
# 而这一步要装的是**系统级**包（JDK），属于不可轻易回退的操作。
# 让脚本把命令打印出来、由用户自己执行一次，代价是多点一次，收益是「知道自己授权了什么」。
#
# ## 幂等
#
# 每一步都先判「已经有了吗」。重复跑不会重复下载，也不会把已装的版本降级。
#
set -euo pipefail

DRY_RUN="${DRY_RUN:-}"
SDK_ROOT="${SDK_ROOT:-$HOME/android-sdk}"
CMDLINE_TOOLS_ZIP_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
# 编译目标（compileSdk 34 / minSdk 24 与 Node 的 Android API 底限一致，见 build-node-android.sh）
PLATFORM="android-34"
BUILD_TOOLS="34.0.0"

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s ==\n' "$*"; }

run() {
  if [ -n "$DRY_RUN" ]; then
    say "  [dry-run] $*"
  else
    eval "$@"
  fi
}

# ── 0. 前置判断 ──────────────────────────────────────────────
step "0. 环境判断"
say "  OS:      $(uname -srm)"
say "  SDK 目标: $SDK_ROOT"
say "  磁盘可用: $(df -h "$HOME" | tail -1 | awk '{print $4}')"
if [ -n "$DRY_RUN" ]; then say "  ** DRY_RUN=1，不会改动机器 **"; fi

# ── 1. JDK 17 ───────────────────────────────────────────────
step "1. JDK 17"
#
# 为什么不用 sdkmanager 装 JDK：它装的是 Android Studio 自带的那份，
# 对 headless 构建没必要；apt 的 openjdk-17-jdk-headless 更小且会正确设置 alternatives。
if command -v java >/dev/null 2>&1; then
  JAVA_MAJOR=$(java -version 2>&1 | head -1 | sed -n 's/.*version "\([0-9]*\).*/\1/p')
  say "  已有 java，主版本 ${JAVA_MAJOR:-未知}"
  if [ "${JAVA_MAJOR:-0}" -lt 17 ]; then
    say "  ⚠ 版本低于 17，AGP 8.x 需要 17+"
    say "    请执行：sudo apt-get update && sudo apt-get install -y openjdk-17-jdk-headless"
  fi
else
  say "  未安装 JDK。请**手动**执行下面这一条（本脚本不代跑 sudo）："
  say ""
  say "    sudo apt-get update && sudo apt-get install -y openjdk-17-jdk-headless"
  say ""
  say "  装完再跑一次本脚本，会继续后面的步骤。"
  # 不是失败 —— 后面的步骤（SDK、Rust target）都不依赖 JDK，可以先做
fi

# ── 2. Android cmdline-tools ────────────────────────────────
step "2. Android cmdline-tools → $SDK_ROOT"
SDKMANAGER="$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"
if [ -x "$SDKMANAGER" ]; then
  say "  已存在，跳过下载"
else
  # 装到 $HOME 而不是 /opt：不需要 sudo，且换机器时整个目录可搬走
  run "mkdir -p '$SDK_ROOT/cmdline-tools'"
  TMPZIP="$(mktemp -d)/cmdtools.zip"
  say "  下载 $CMDLINE_TOOLS_ZIP_URL"
  run "curl -fL --retry 3 -o '$TMPZIP' '$CMDLINE_TOOLS_ZIP_URL'"
  run "rm -rf '$SDK_ROOT/cmdline-tools/latest'"
  # 官方 zip 解出来是 `cmdline-tools/`，必须再嵌一层 `latest/`，
  # 否则 sdkmanager 找不到自己的根（表现为"命令不存在"或"SDK root 无效"）。
  run "unzip -q '$TMPZIP' -d '$SDK_ROOT/cmdline-tools'"
  run "mv '$SDK_ROOT/cmdline-tools/cmdline-tools' '$SDK_ROOT/cmdline-tools/latest'"
  run "rm -f '$TMPZIP'"
fi

# ── 3. platform 与 build-tools ──────────────────────────────
step "3. $PLATFORM + build-tools;$BUILD_TOOLS"
if [ -n "$DRY_RUN" ]; then
  say "  [dry-run] sdkmanager \"platforms;$PLATFORM\" \"build-tools;$BUILD_TOOLS\""
else
  export ANDROID_HOME="$SDK_ROOT"
  export ANDROID_SDK_ROOT="$SDK_ROOT"
  if [ -x "$SDKMANAGER" ]; then
    # `yes |` 用于接受 license；不接的话 sdkmanager 会卡在交互提示上（无人值守时表现为"卡住"）
    yes | "$SDKMANAGER" --sdk_root="$SDK_ROOT" --licenses >/dev/null 2>&1 || true
    "$SDKMANAGER" --sdk_root="$SDK_ROOT" "platforms;$PLATFORM" "build-tools;$BUILD_TOOLS"
  else
    say "  ⚠ 没有 sdkmanager（上一步没成功），跳过"
  fi
fi

# ── 4. Rust target ──────────────────────────────────────────
step "4. Rust target aarch64-linux-android"
if command -v rustup >/dev/null 2>&1; then
  if rustup target list --installed 2>/dev/null | grep -qx aarch64-linux-android; then
    say "  已安装"
  else
    run "rustup target add aarch64-linux-android"
  fi
else
  say "  未安装 rustup。若 APK 构建机不在这台机器上，可跳过这一步。"
fi

# ── 5. 结果自检 ────────────────────────────────────────────
step "5. 自检"
if [ -z "$DRY_RUN" ]; then
  say "  java:        $(java -version 2>&1 | head -1 || echo '缺失')"
  say "  ANDROID_HOME: ${ANDROID_HOME:-未设（需写进 shell profile）}"
  say "  sdkmanager:  $([ -x "$SDKMANAGER" ] && echo 存在 || echo 缺失)"
  say "  platforms:   $(ls "$SDK_ROOT/platforms" 2>/dev/null | tr '\n' ' ')"
  say "  build-tools: $(ls "$SDK_ROOT/build-tools" 2>/dev/null | tr '\n' ' ')"
  say "  rust target: $(rustup target list --installed 2>/dev/null | grep -c aarch64-linux-android || echo 0) 个"
  say ""
  say "  把这两行加进 ~/.bashrc（后续 gradle / cargo 都靠它们找 SDK）："
  say "    export ANDROID_HOME=$SDK_ROOT"
  say "    export PATH=\$ANDROID_HOME/cmdline-tools/latest/bin:\$PATH"
fi
