#!/usr/bin/env bash
#
# 安卓端构建环境 —— **Windows 免安装、不走管理员**（T15.3）
#
# 与同目录的 `install-android-env.sh`（Ubuntu 版）的区别：
#   那个走 apt + sudo 装系统 JDK；这个**全部解压到普通目录**，
#   不写 Program Files、不改 PATH、不注册任何东西。删目录即卸载。
#
# ## 装什么
#
#   | 组件 | 版本 | 落点 |
#   |---|---|---|
#   | Temurin JDK | 17（Temurin 17.0.x） | $ROOT/jdk-17 |
#   | Android cmdline-tools | latest | $ROOT/sdk/cmdline-tools/latest |
#   | platform-tools | 最新 | $ROOT/sdk/platform-tools |
#   | build-tools | 34.0.0 | $ROOT/sdk/build-tools/34.0.0 |
#   | platforms | android-34 | $ROOT/sdk/platforms/android-34 |
#
# `$ROOT` 默认 `D:/android-env`（可用 ANDROID_ENV_ROOT 覆盖）。
#
# ## 为什么是 build-tools 34.0.0 / platform 34
#
# 与 `vendor/node-android/build-node-android.sh` 的 `ANDROID_API=24` 不矛盾：
#   · **minSdk 24** 是最低能装的系统版本（Node 的 Android 底限）；
#   · **compileSdk 34 / targetSdk 34** 是编译时用的 API 与运行时的行为目标。
#     targetSdk ≥ 29 才会触发 W^X 限制，那正是 T15.3 生死项要验的东西 ——
#     用低 targetSdk 编出来"能跑"是假绿。
#
# ## 幂等
#
# 每步都先判「已经有了吗」。重复跑不会重复下载。
#
# 用法：
#   bash install-android-env-win.sh          # 全装
#   DRY_RUN=1 bash install-android-env-win.sh  # 只看会做什么
#
set -euo pipefail

ROOT="${ANDROID_ENV_ROOT:-D:/android-env}"
DRY_RUN="${DRY_RUN:-}"

JDK_DIR="$ROOT/jdk-17"
SDK_DIR="$ROOT/sdk"
DL="$ROOT/downloads"

# Temurin 17 最新 GA（2026-10-30 查询 api.adoptium.net 得到 17.0.20.1+1）
JDK_URL="https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_x64_windows_hotspot_17.0.20.1_1.zip"
# Android commandline-tools（Windows）
CMDLINE_URL="https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip"

step() { printf '\n== %s ==\n' "$1"; }
say()  { printf '   %s\n' "$1"; }
die()  { printf '✘ %s\n' "$1" >&2; exit 1; }

run() {
  if [ -n "$DRY_RUN" ]; then say "[dry-run] $*"; else eval "$@"; fi
}

# 下载到**完整**为止。
#
# ## 为什么不是一句 curl
#
# 2026-10-30 实测：`curl -fL --retry 3` 跑到 130 MB（共 182 MB）时进程消失，
# 而脚本 `set -e` 直接退出 —— 看似"下载失败"，实际是**连接被掐断后 curl 退出**，
# `--retry` 不覆盖"传输中途断开"这种（它只重试连接阶段的错误）。
#
# 更糟的是：文件已经非空，下次跑脚本会因 `[ -s "$zip" ]` 判定"已下载"
# 而直接去解压 —— 解压一个**截断的 zip**，报一堆看不懂的 CRC 错误。
#
# 所以三件事一起做：
#   · `-C -` **续传**（GitHub release 与 dl.google.com 都支持 Range）；
#   · 循环重试直到拿到完整文件，而不是一次性；
#   · 用 zip 结构自检做**内容级**判据（不完整就删掉重下，不硬着头皮解压）。
fetch_zip() {
  local url="$1" dest="$2" label="$3"
  local attempt=0
  local max_attempts=20
  while [ "$attempt" -lt "$max_attempts" ]; do
    attempt=$((attempt + 1))
    # -C - 续传；--progress-bar 让日志每行一条，不再刷满回车
    if curl -fL -C - --retry 5 --retry-delay 2 --retry-all-errors \
            --connect-timeout 20 --progress-bar -o "$dest" "$url"; then
      if zip_ok "$dest"; then
        say "$label 下载完成（$(( $(stat -c %s "$dest") / 1048576 )) MB）"
        return 0
      fi
      say "$label 的 zip 结构不完整，删掉重下（第 $attempt 次）"
      rm -f "$dest"
    else
      say "$label 第 $attempt 次中断，续传中…"
    fi
    sleep 3
  done
  die "$label 重试 $max_attempts 次仍失败：$url"
}

# zip 完整性判据：能打开目录且每个成员可读。
# `unzip -t` 不一定有（Git Bash 可能没装），用 python 的 zipfile 最稳。
zip_ok() {
  "python" - "$1" <<'PYEOF_ZIP'
import sys, zipfile
try:
    with zipfile.ZipFile(sys.argv[1]) as zf:
        sys.exit(0 if zf.testzip() is None else 1)
except Exception:
    sys.exit(1)
PYEOF_ZIP
}

# 用 python 解压：Git Bash 不一定有 unzip，而 python 一定有
unzip_to() {
  local zip="$1" dest="$2"
  "python" - "$zip" "$dest" <<'PY'
import sys, zipfile, pathlib
z, d = sys.argv[1], pathlib.Path(sys.argv[2])
d.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(z) as zf:
    zf.extractall(d)
print(f"   解压 {z} → {d}")
PY
}

step "0. 目标目录 $ROOT"
run "mkdir -p '$ROOT' '$DL' '$SDK_DIR'"

step "1. Temurin JDK 17"
if [ -x "$JDK_DIR/bin/java.exe" ]; then
  say "已存在，跳过：$JDK_DIR"
else
  zip="$DL/jdk17.zip"
  # 不完整也**不删**：可能只是下到一半断了（本项目实测断在 130/182 MB）。
  # 让 fetch_zip 用 `-C -` 从断点续传，只在续到完整后仍校验失败时才删掉重下。
  # 直接删会白扔已下的部分（130 MB 在这里要跑十几分钟）。
  if [ -s "$zip" ] && ! zip_ok "$zip" 2>/dev/null; then
    say "已有 $zip 但不完整（$(( $(stat -c %s "$zip") / 1048576 )) MB），将尝试续传"
  fi
  if [ ! -s "$zip" ] || ! zip_ok "$zip" 2>/dev/null; then
    say "下载 $(basename "$JDK_URL")（约 182 MB，支持续传）"
    run "fetch_zip '$JDK_URL' '$zip' 'JDK'"
  fi
  say "解压到 $JDK_DIR"
  run "unzip_to '$zip' '$ROOT/_jdk_tmp'"
  # zip 里是一个 jdk-17.0.x+y 顶层目录，摊平到 jdk-17
  if [ -z "$DRY_RUN" ]; then
    inner=$(find "$ROOT/_jdk_tmp" -maxdepth 1 -mindepth 1 -type d | head -1)
    [ -n "$inner" ] || die "解压后没找到顶层目录"
    mv "$inner" "$JDK_DIR"
    rm -rf "$ROOT/_jdk_tmp"
  fi
  if [ -z "$DRY_RUN" ]; then [ -x "$JDK_DIR/bin/java.exe" ] || die "JDK 解压后没有 bin/java.exe"; fi
  say "JAVA_HOME=$JDK_DIR"
fi

step "2. Android cmdline-tools"
TOOLS="$SDK_DIR/cmdline-tools/latest"
if [ -x "$TOOLS/bin/sdkmanager.bat" ]; then
  say "已存在，跳过：$TOOLS"
else
  zip="$DL/cmdline-tools.zip"
  # 不完整也**不删**：可能只是下到一半断了（本项目实测断在 130/182 MB）。
  # 让 fetch_zip 用 `-C -` 从断点续传，只在续到完整后仍校验失败时才删掉重下。
  # 直接删会白扔已下的部分（130 MB 在这里要跑十几分钟）。
  if [ -s "$zip" ] && ! zip_ok "$zip" 2>/dev/null; then
    say "已有 $zip 但不完整（$(( $(stat -c %s "$zip") / 1048576 )) MB），将尝试续传"
  fi
  if [ ! -s "$zip" ] || ! zip_ok "$zip" 2>/dev/null; then
    say "下载 commandlinetools-win（约 146 MB，支持续传）"
    run "fetch_zip '$CMDLINE_URL' '$zip' 'cmdline-tools'"
  fi
  # zip 顶层是 cmdline-tools/，sdkmanager 要求落在 cmdline-tools/<版本>/ 下
  run "unzip_to '$zip' '$SDK_DIR/_ct_tmp'"
  if [ -z "$DRY_RUN" ]; then
    mkdir -p "$SDK_DIR/cmdline-tools"
    rm -rf "$TOOLS"
    mv "$SDK_DIR/_ct_tmp/cmdline-tools" "$TOOLS"
    rm -rf "$SDK_DIR/_ct_tmp"
  fi
  if [ -z "$DRY_RUN" ]; then [ -x "$TOOLS/bin/sdkmanager.bat" ] || die "cmdline-tools 解压后没有 bin/sdkmanager.bat"; fi
fi

step "3. sdkmanager 装 platform-tools / build-tools;34.0.0 / platforms;android-34"
if [ -n "$DRY_RUN" ]; then
  say "[dry-run] sdkmanager --install 'platform-tools' 'build-tools;34.0.0' 'platforms;android-34'"
else
  export JAVA_HOME="$JDK_DIR"
  export ANDROID_HOME="$SDK_DIR"
  export ANDROID_SDK_ROOT="$SDK_DIR"
  export PATH="$JDK_DIR/bin:$PATH"
  # 先接受许可（`yes |` 在 Windows 的 sdkmanager.bat 上可用；它从 stdin 读 y）
  say "接受 SDK 许可"
  yes | "$TOOLS/bin/sdkmanager.bat" --sdk_root="$SDK_DIR" --licenses >/dev/null 2>&1 || true
  say "安装组件（这一步会下载 200–400 MB，慢）"
  "$TOOLS/bin/sdkmanager.bat" --sdk_root="$SDK_DIR" \
    "platform-tools" "build-tools;34.0.0" "platforms;android-34"
fi

step "4. 自检"
if [ -z "$DRY_RUN" ]; then
  JAVA_HOME="$JDK_DIR" "$JDK_DIR/bin/java.exe" -version 2>&1 | head -2 | sed 's/^/   /'
  for d in platform-tools "build-tools/34.0.0" "platforms/android-34"; do
    if [ -d "$SDK_DIR/$d" ]; then say "OK  $d"; else say "!!  缺 $d"; fi
  done
fi

printf '\n完成。后续构建需要的环境变量：\n'
printf '  JAVA_HOME=%s\n' "$JDK_DIR"
printf '  ANDROID_HOME=%s\n' "$SDK_DIR"
printf '  ANDROID_SDK_ROOT=%s\n' "$SDK_DIR"
