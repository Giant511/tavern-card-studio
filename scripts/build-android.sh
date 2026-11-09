#!/usr/bin/env bash
# 构建 Android APK（v0.1.7 / T15.3）。
#
# ## 为什么是 `tauri android build` 而不是 `gradlew`
#
# 上一轮我直接跑 `gradlew assembleArm64Debug`，失败在：
#
#   failed to read .../gen/android/.tauri/cli-options-server.json;
#   the `tauri android dev` or `tauri android build` command must be running
#
# 那个文件是 **tauri CLI 自己写**的（它要在这个会话里提供 cli-options 服务），
# 手工造不出来。所以入口只能是 `tauri android build`，gradle 是它调的其中一环。
#
# ## 五个必须设对环境变量（少一个就静默走歪）
#
# | 变量 | 不设会怎样 |
# |---|---|
# | `JAVA_HOME` | `ERROR: JAVA_HOME is not set`，Gradle 直接不起 |
# | `ANDROID_HOME` | Gradle 找不到 SDK / platform |
# | `NDK_HOME` | Flutter/Gradle 找不到 NDK（tauri 能自己探到，但显式给更稳） |
# | `CARGO_TARGET_DIR` | **中文路径的 GBK 问题**：rustc 把路径按 GBK 传给 ld.lld，
# |                    | 链接时报 `ld.lld: cannot open D:\Claw\<GBK 的「代码开发」>\...` |
# | `NODE_OPTIONS` 清空 | 本机 NODE_OPTIONS 带一个 shim 路径，会让别处的 `node.bat` 挂掉
#
# ## 用法
#
#   bash scripts/build-android.sh           # debug APK（够真机验证）
#   bash scripts/build-android.sh --release # release APK（要签名）
#
# 产出：client/src-tauri/gen/android/app/build/outputs/apk/<variant>/

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT="$REPO/client"

: "${JAVA_HOME:=D:/android-env/jdk-17}"
: "${ANDROID_HOME:=D:/android-env/sdk}"
export JAVA_HOME ANDROID_HOME
export ANDROID_SDK_ROOT="$ANDROID_HOME"
# NDK 版本写死不用通配：换了版本号要显式改，而不是悄悄用上另一个
export NDK_HOME="$ANDROID_HOME/ndk/26.1.10909125"

# ① .o / 中间产物放 ASCII 路径 —— 这是防 GBK 链接失败的关键
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-D:/tcs-target}"

# ② 清空 NODE_OPTIONS（见上面表格最后一行）
unset NODE_OPTIONS

# ③ ★ 禁用增量编译。
#
# 不是性能偏好，是**必需**：多次中断的构建会把 `$CARGO_TARGET_DIR/.../incremental`
# 写坏（Windows 上还会伴生 `error copying object file ... 拒绝访问 (os error 5)`），
# 之后编译报 rustc 内部 panic：
#
#   thread 'rustc' panicked at compiler/rustc_metadata/src/rmeta/encoder.rs:2486:
#   no entry found for key
#
# 那是 ICE（编译器自己的 bug），不是我们代码的问题，换个 crate 也一样炸。
# 关掉增量就绕过了整条复用路径。这个项目的 debug 构建增量收益本来也有限 ——
# 一次干净编译比"省两分钟但随机炸"划算。
export CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}"

# ④ 回环绕开代理（本机设了 HTTP_PROXY，会把 127.0.0.1 也代理走）
export NO_PROXY="127.0.0.1,localhost,::1"
export no_proxy="$NO_PROXY"

# ⑤ node.exe 放最前（不用 node.bat，那个在某些环境下起不来）
if [ -x "D:/tcs-bin/node.exe" ]; then
  export PATH="/d/tcs-bin:$PATH"
fi

# 版本号从生成的 tauri.properties 读 —— 不在脚本里手写，避免升版后文件名漂移
TAURI_PROPS="$CLIENT/src-tauri/gen/android/app/tauri.properties"
VERSION_NAME=$(sed -n 's/^tauri\.android\.versionName=//p' "$TAURI_PROPS" 2>/dev/null | tr -d '\r')
VERSION_NAME="${VERSION_NAME:-0.0.0}"

VARIANT="debug"
TAURI_ARGS=(--apk --target aarch64 --debug)

# ★ 脚本自己的开关**不能透传**给 tauri CLI。
#
# 2026-10-31 实测：`bash build-android.sh --release` 直接报
#
#     Usage: tauri android build <--debug|--target ...|--apk|--aab|...>
#
# 因为 `--release` 被 `"$@"` 原样透传给了 `tauri android build`，
# 而它不认这个标志（它要的是 `-r`，且 release 是**默认行为**、
# 只有 `--debug` 才是显式开关）。`--release` 是**我们脚本自己的**参数。
#
# 所以：先挑出脚本开关，剩下的才作为 EXTRA_ARGS 透传。
EXTRA_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --release) ;;            # 脚本开关，已处理
    *)         EXTRA_ARGS+=("$arg") ;;
  esac
done

if [ "${1:-}" = "--release" ]; then
  VARIANT="release"
  TAURI_ARGS=(--apk --target aarch64)
fi

TAURI_CLI="$REPO/node_modules/@tauri-apps/cli/tauri.js"
[ -f "$TAURI_CLI" ] || { echo "[FATAL] 找不到 tauri CLI：$TAURI_CLI" >&2; exit 2; }

# ⑤ gen/android 必须在（首次要先 init）
if [ ! -d "$CLIENT/src-tauri/gen/android" ]; then
  echo "[FATAL] 没有 gen/android，先跑 tauri android init" >&2
  exit 2
fi

# ⑥ 修补 gen/android 里的三处「不修就跑不动」（详见 fix-android-gen.py）
#
# 为什么单独一个脚本而不是写在这里：这三处都是 `tauri android init` 生成的，
# 而 gen/ 在 .gitignore 里 —— 每台机器、每次重新 init 都会重新出现。
# 集中在一个幂等脚本里，既保证可重跑，也能单独 `--check` 出报告。
PYTHON="C:/Users/PC/.workbuddy/binaries/python/versions/3.13.12/python.exe"
[ -x "$PYTHON" ] || PYTHON=python3
"$PYTHON" "$REPO/scripts/fix-android-gen.py" || exit 2

APP_GRADLE="$CLIENT/src-tauri/gen/android/app/build.gradle.kts"

# ════════════════════════════════════════════════════════════
#  ⑦ 构建前：前端产物必须先于源码（2026-10-31 加）
# ════════════════════════════════════════════════════════════
#
# ## 为什么必须在**构建前**做这件事
#
# Tauri 2 在 Android 把 `client/dist` 嵌进 `.so`。脚本第 ⑧b 步会检查
# 「`.so` 里内嵌的前端是不是最新的」，但它跑在 `tauri android build` **之后** ——
# 一旦判出过期，代价是**再跑一遍完整构建**（release 17 分钟）。
#
# 而真正的原因往往很简单：改完源码忘了 `npm run build:ui`。
# 2026-10-31 实测过一次：`dist` 是 12:14、`chat.css`/`shell.ts` 是 12:18，
# 差 4 分钟 —— 不检查的话就会打出一个**界面是上一版**的 APK，
# 而且构建全绿、装上能跑、只是"改了没生效"（最费时间的一类问题）。
#
# ## 判据
#
# 界面是**两段编译**出来的，两级缓存各有各的过期可能，所以必须分两段各查一次：
#
# ```text
#   shared/src  --tsc-->  shared/dist  --vite(+client/src)-->  client/dist  --> .so
# ```
#
# | 段 | 基准 | 看谁比它新 | 过期动作 |
# |---|---|---|---|
# | A | `shared/dist` 里最新产物 | `shared/src` | `npm run build:shared` |
# | B | `client/dist` 里最新产物 | `client/src`、两个入口 html、**`shared/dist`** | `npm run build:ui` |
#
# ★★★ 为什么必须分两段（2026-11-03 血的教训）
#
# 第一版只加了「B 段也扫 `shared/src`」。看起来够了，其实**瞎得很快**：
# 一旦 `client/dist` 被重建过一次（哪怕内容还是错的），它的 mtime 就比
# `shared/src` 新 ⇒ B 段判"没问题" ⇒ 而 `shared/dist` 依然是旧的 ⇒
# 打出来的包里还是旧界面。实测就撞上了：连打两个 223M 的包，
# **sha256 一模一样**（`196e3480…`），因为两次都从同一份陈旧的 shared/dist 编。
#
# 正确做法是让每一段只跟自己那一级的输入比：
#   A 段拿 `shared/src` 比 `shared/dist`，B 段拿 `shared/dist` 比 `client/dist`。
# 这样 A 段重编会刷新 `shared/dist` 的 mtime，B 段紧接着必然被触发 —— 链条自己接上。
#
# 用 `find -newer` 而不是比较两个具体文件：源码是一整棵树，改的可能是任意一个 .ts。
if [ ! -d "$CLIENT/dist" ]; then
  echo "[修] 没有 client/dist，先构建前端"
  ( cd "$CLIENT" && npm run build:ui )
else
  # ── A 段：shared/src → shared/dist ──
  if [ -d "$REPO/shared/dist" ]; then
    NEWEST_SHARED_DIST=$(find "$REPO/shared/dist" -type f -name '*.js' -printf '%T@ %p\n' 2>/dev/null \
      | sort -rn | head -1 | cut -d' ' -f2-)
    if [ -n "$NEWEST_SHARED_DIST" ]; then
      SHARED_STALE=$(find "$REPO/shared/src" -type f -newer "$NEWEST_SHARED_DIST" 2>/dev/null | head -3)
      if [ -n "$SHARED_STALE" ]; then
        echo "[修] shared/dist 比 shared/src 旧，先编 shared（否则界面文案/顺序是旧的）："
        echo "$SHARED_STALE" | sed 's/^/       /'
        ( cd "$REPO" && npm run build:shared )
      else
        echo "[OK] shared/dist 比 shared/src 新"
      fi
    fi
  else
    echo "[修] 没有 shared/dist，先编 shared"
    ( cd "$REPO" && npm run build:shared )
  fi

  # ── B 段：client/src + shared/dist → client/dist ──
  NEWEST_DIST=$(ls -t "$CLIENT"/dist/index.html "$CLIENT"/dist/mobile.html 2>/dev/null | head -1)
  if [ -n "$NEWEST_DIST" ]; then
    # 扫 `client/src` + 两个入口 html + **`shared/dist`**（注意是 dist，不是 src：
    # A 段刚可能重编过它，这里要比的就是它的产物时间）。
    #
    # ★ 这里**不需要**排除 `src-tauri`：`client/src-tauri` 与 `client/src` 是
    # **同级目录**，不在 `src` 里面（2026-10-31 我一度以为在下面、加了 -prune，
    # 后来靠 `test/build-android-freshness.test.mjs` 的反证用例发现是误判 ——
    # 那棵树上根本没有可被误报的文件）。写清楚这条，免得下一个人重复怀疑。
    NEWER=$(find "$CLIENT/src" "$REPO/shared/dist" "$CLIENT/index.html" "$CLIENT/mobile.html" \
      -type f -newer "$NEWEST_DIST" 2>/dev/null | head -5)
    if [ -n "$NEWER" ]; then
      echo "[修] 前端产物比输入旧，先重新构建（否则 APK 里是上一版界面）："
      echo "$NEWER" | sed 's/^/       /'
      ( cd "$CLIENT" && npm run build:ui )
    else
      echo "[OK] 前端产物比输入新"
    fi
  fi
fi

echo "== 环境 =="
echo "  JAVA_HOME        = $JAVA_HOME"
echo "  ANDROID_HOME     = $ANDROID_HOME"
echo "  NDK_HOME         = $NDK_HOME"
echo "  CARGO_TARGET_DIR = $CARGO_TARGET_DIR"
echo "  CARGO_INCREMENTAL= $CARGO_INCREMENTAL"
echo "  compileSdk       = $(grep -m1 'compileSdk' "$APP_GRADLE" | tr -d ' ')"
echo "  变体             = $VARIANT"
echo

cd "$CLIENT"
node "$TAURI_CLI" android build "${TAURI_ARGS[@]}" "${EXTRA_ARGS[@]}"

# ════════════════════════════════════════════════════════════
#  ⑧ 修补 jniLibs 里的 .so，然后**重新打包**
# ════════════════════════════════════════════════════════════
#
# ## 问题
#
# `tauri android build` 会打印：
#
#     Info symlinking lib "D:/tcs-target/.../libtcs_shell_lib.so" in jniLibs dir ...
#
# 看上去链接成功了，**实际落地的文件是 0 字节**：
#
#     -rw-r--r-- 1 PC 197121         0  libtcs_shell_lib.so      ← jniLibs
#     -rw-r--r-- 2 PC 197121 157079600  libtcs_shell_lib.so      ← cargo 产物
#
# 而 CLI **不报错**、gradle 也照样打包成功（"Finished 1 APK"）。
# 于是产出的是一个「能构建成功、装上去必崩」的 APK——
# `UnsatisfiedLinkError: dlopen failed: ... is empty`。
#
# ## 为什么这条值得单独写一大段
#
# 判据只能落在**解包后的字节**上：构建日志全绿、APK 文件存在、体积看着也正常
# （46 MB，因为 `libnode.so` 有 99 MB 撑着，空掉那 157 MB 看不出异常）。
# 是本项目「产物验证只认内容级判据」那条纪律的又一次实例。
#
# ## 修法
#
# 不管 CLI 为什么没链接成（同卷硬链接不需要特权，推测是它先建了空占位文件
# 而后链接因"目标已存在"静默失败），这里都**用真实字节覆盖并重新打包**：
# 跳过 `rustBuild*` task（Rust 已经编好了），只重跑打包。
#
# 跳过那个 task 也顺带绕开了它的前置文件 `cli-options-server.json` ——
# 那个文件的生命周期只在外层 `tauri android build` 期间。
ABI_DIR="$CLIENT/src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a"
REAL_SO="$CARGO_TARGET_DIR/aarch64-linux-android/${VARIANT}/libtcs_shell_lib.so"
WANT_SO="$ABI_DIR/libtcs_shell_lib.so"

if [ ! -f "$REAL_SO" ]; then
  echo "[FATAL] 找不到 cargo 产物：$REAL_SO" >&2
  exit 3
fi

need_repack=0
if [ ! -f "$WANT_SO" ]; then
  echo "[修] jniLibs 里没有 libtcs_shell_lib.so，补上"
  need_repack=1
elif [ "$(wc -c < "$WANT_SO")" -ne "$(wc -c < "$REAL_SO")" ]; then
  echo "[修] jniLibs 里的 .so 大小不对（$(wc -c < "$WANT_SO") vs $(wc -c < "$REAL_SO")），用真实字节覆盖"
  need_repack=1
fi

# ★ 先补上真实字节，**再做下面的前端检测**。
#
# 2026-10-31 自我修正：第一版把前端检测放在补字节之前 ——
# 而那时 `$WANT_SO` 还是刚被 CLI 写成的 **0 字节文件**，
# `grep` 一个空文件当然找不到任何前端文件名，于是**每轮都判"过期"**，
# 每轮都白跑一次 `tauri android build`（release 要 17 分钟）。
#
# 现象是"每次都重编 Rust"，而原因跟 Rust 无关 —— 是判据读了一个空文件。
# 这类错和之前那条 `$?` 被 echo 吃掉是同一族：**判据在跑，但它看的不是那个东西**。
if [ "$need_repack" -eq 1 ]; then
  cp "$REAL_SO" "$WANT_SO"
fi

# ── ⑧b ★ 检查 .so 里**内嵌的前端是不是最新的** ──
#
# Tauri 2 在 Android 上把前端资源**嵌进 .so**（不是放在 assets/）。
# 一旦用了 `-x rustBuild*` 跳过那个 task，嵌入这一步也不会跑 ——
# 于是 .so 里还是上一次的 `rules-<hash>.css`，而 `client/dist` 已经换成了新的。
#
# 2026-10-31 实测：改完窄屏 CSS、`npm run build:ui` 生成了 `rules-DI7_8aP1.css`，
# 而 APK 里躺着的还是 `rules-CvhQVDo9.css` —— **改了半天界面上一点变化都没有**，
# 而且构建全绿、装上去也正常跑、只是"看起来没生效"。
# 这类"改了没生效"最难查：会让人去怀疑缓存、怀疑 WebView、怀疑热更新。
#
# 判据：拿 `client/dist` 里真实存在的文件名去 .so 里找，一个找不到就是过期。
DIST_DIR="$CLIENT/dist/assets"
if [ -d "$DIST_DIR" ]; then
  stale=0
  for f in "$DIST_DIR"/*; do
    [ -f "$f" ] || continue
    base=$(basename "$f")
    if ! grep -qa "$base" "$WANT_SO" 2>/dev/null; then
      echo "[修] .so 内嵌的前端过期：找不到 $base"
      stale=1
    fi
  done
  if [ "$stale" -eq 1 ]; then
    # 重新嵌入 = 重跑 rustBuild（它会把 dist 打进 .so），之后 CLI 会再链一次
    echo "[修] 重跑 rustBuild 以重新嵌入前端"
    cd "$CLIENT"
    node "$TAURI_CLI" android build "${TAURI_ARGS[@]}" "${EXTRA_ARGS[@]}" >/dev/null 2>&1 || true
    cd "$REPO"
    # 重跑时 rustBuild 会重新链接，$REAL_SO 已刷新 —— cp 必须在这之后。
    # 而 CLI 又会把 jniLibs 写成 0 字节，所以还得再补一次。
    cp "$REAL_SO" "$WANT_SO"
    need_repack=1
    # 补完再验一次
    still=0
    for f in "$DIST_DIR"/*; do
      [ -f "$f" ] || continue
      base=$(basename "$f")
      grep -qa "$base" "$WANT_SO" 2>/dev/null || { echo "[FAIL] 重新嵌入后仍缺 $base" >&2; still=1; }
    done
    [ "$still" -eq 0 ] && echo "[OK] .so 已包含最新前端"
  else
    echo "[OK] .so 内嵌的前端是最新的"
  fi
fi

if [ "$need_repack" -eq 1 ]; then
  # 上面已经 cp 过（或刚刚重跑刷新过），这里不再重复，只重新打包
  # 变体名 → gradle task 名：debug → Debug，release → Release
  case "$VARIANT" in
    debug)   GVAR=Debug ;;
    release) GVAR=Release ;;
    *)       GVAR=Debug ;;
  esac

  echo "[修] 重新打包（跳过 rustBuildArm64$GVAR，Rust 已编好）"
  ( cd "$CLIENT/src-tauri/gen/android" && \
    ./gradlew "assembleArm64$GVAR" -x "rustBuildArm64$GVAR" --console=plain ) \
    | tail -5
else
  echo "[OK] jniLibs 里的 .so 与 cargo 产物一致"
fi

# ★ APK 自身的新鲜度也要补（2026-11-01 第八批）。
#
# 上面那段只看 `jniLibs/*.so` 是否需要改写。但 `tauri android build` 在某些
# 情况下会**复用配置缓存、只打印 "Finished 1 APK" 而并不真的重打包** ——
# 实测：.so 已重编（16:30:58），APK 还是 14:20:20 的旧货。
#
# 判据：APK 不存在、或比 `.so` 旧 ⇒ 主动跑一次 gradle 打包。
APK_EARLY="$CLIENT/src-tauri/gen/android/app/build/outputs/apk/arm64/$VARIANT/app-arm64-$VARIANT.apk"
if [ "$need_repack" -eq 0 ]; then
  if [ ! -f "$APK_EARLY" ]; then
    echo "[修] APK 不存在（上一轮可能被删）⇒ 重新打包"
    need_repack=1
  elif [ "$APK_EARLY" -ot "$REAL_SO" ]; then
    echo "[修] APK 比 .so 旧（$(date -r "$APK_EARLY" '+%H:%M:%S' 2>/dev/null || echo '?') < $(date -r "$REAL_SO" '+%H:%M:%S' 2>/dev/null || echo '?')）⇒ 重新打包"
    need_repack=1
  fi
  if [ "$need_repack" -eq 1 ]; then
    case "$VARIANT" in
      debug)   GVAR=Debug ;;
      release) GVAR=Release ;;
      *)       GVAR=Debug ;;
    esac
    # ★ 必须 `--rerun-tasks`。
    #
    # 不加的话 gradle 会因为 "up-to-date" 直接跳过 `packageArm64Debug`，
    # 20 秒"BUILD SUCCESSFUL" 但 APK 的 mtime 一动不动 —— 本轮就是这么被骗的
    # （日志显示重新打包了，文件时间还是旧的）。
    ( cd "$CLIENT/src-tauri/gen/android" && \
      ./gradlew "assembleArm64$GVAR" -x "rustBuildArm64$GVAR" --rerun-tasks --console=plain ) \
      | tail -4
  fi
fi

# ════════════════════════════════════════════════════════════
#  ⑨ 核验产物 —— **解包看字节**，不信"构建成功"
# ════════════════════════════════════════════════════════════

APK_DIR="$CLIENT/src-tauri/gen/android/app/build/outputs/apk"

# ★ release 与 debug 的**文件名不一样**：
#   debug   → app-arm64-debug.apk
#   release → app-arm64-release-unsigned.apk     ← 多一个 -unsigned
# 因为 release 在 gradle 里没有 signingConfig，AGP 会给文件名加后缀。
# 2026-10-31 实测：脚本里把路径写死成 `app-arm64-$VARIANT.apk`，
# release 直接报 [FATAL] 没找到 —— 而 APK 其实好好地躺在旁边。
# 所以这里按变体分支取，不要"猜一个统一格式"。
if [ "$VARIANT" = "release" ]; then
  # 有 signingConfig 时 AGP 出 `app-arm64-release.apk`；
  # 没有 keystore 的机器会出 `app-arm64-release-unsigned.apk`。两种都要认。
  if [ -f "$APK_DIR/arm64/release/app-arm64-release.apk" ]; then
    APK="$APK_DIR/arm64/release/app-arm64-release.apk"
    APK_PRE_SIGNED=1
  else
    APK="$APK_DIR/arm64/release/app-arm64-release-unsigned.apk"
    APK_PRE_SIGNED=0
  fi
else
  APK="$APK_DIR/arm64/debug/app-arm64-debug.apk"
  APK_PRE_SIGNED=1
fi

# universal 那个是用空 .so 打的，删掉避免误装
rm -f "$APK_DIR/universal/$VARIANT/app-universal-$VARIANT.apk" 2>/dev/null || true

echo
echo "== 产物 =="
if [ ! -f "$APK" ]; then
  echo "[FATAL] 没找到 $APK" >&2
  exit 4
fi
echo "  $APK"
echo "  $(du -h "$APK" | cut -f1)  sha256=$(sha256sum "$APK" | cut -d' ' -f1)"

echo
echo "== 解包核验（内容级判据）=="
"$PYTHON" - "$APK" <<'PYEOF'
import sys, zipfile

apk = sys.argv[1]
z = zipfile.ZipFile(apk)
ok = True

print("  lib/arm64-v8a:")
for n in sorted(x for x in z.namelist() if x.startswith("lib/arm64-v8a/")):
    data = z.read(n)
    magic = data[:4]
    good = len(data) > 0 and magic == b"\x7fELF"
    print(f"    {'[OK]' if good else '[FAIL]'} {n.split('/')[-1]:26s} {len(data):>12,} B  魔数={magic!r}")
    if not good:
        ok = False

# 前端资源必须进包，否则装上去是白屏
has_index = any(n.startswith("assets/") for n in z.namelist())
print(f"  {'[OK]' if has_index else '[FAIL]'} assets/ 已打入（前端资源）")
ok = ok and has_index

# JNI 符号：mobile_entry_point 生效的硬证据。
# 符号在 .dynsym 里按名字存，直接在字节里搜字符串即可。
so = z.read("lib/arm64-v8a/libtcs_shell_lib.so") if "lib/arm64-v8a/libtcs_shell_lib.so" in z.namelist() else b""
has_jni = b"JNI_OnLoad" in so or b"Java_" in so
print(f"  {'[OK]' if has_jni else '[FAIL]'} .so 含 JNI 入口符号（mobile_entry_point 生效）")
ok = ok and has_jni

sys.exit(0 if ok else 1)
PYEOF
# ★ 退出码必须**紧接着**抓进变量。
#
# 第一版写的是 `PYEOF` 之后隔一个 `echo` 再 `if [ "$?" -eq 0 ]` ——
# 而 `$?` 在 echo 之后已经是 echo 的退出码（恒 0），于是这条核验
# **永远显示"通过"**，哪怕 .so 是 0 字节。
# 这正是本项目反复记的那类缺陷：判据在跑，但它答的不是那个问题。
VERIFY_RC=$?

# ★ 内容合法 ≠ 产物是**这次**构建出来的（2026-11-01 第八批补的判据）。
#
# 实测事故：Rust 改了代码、`cargo` 也重编了（`.so` 时间 16:30:58），
# 但 gradle 复用了配置缓存、`tauri android build` 报 "Finished 1 APK"
# 而**没有真的重新打包** —— APK 时间还是 14:20:20。
# 上面那段解包核验全部通过（内容确实合法，只是旧的），于是脚本打印
# "核验通过"，我拿着一份**不含新代码的 APK** 装了三次、查了半天运行时。
#
# 判据：APK 的 mtime 必须晚于它依赖的 `.so`。否则就是陈旧产物。
if [ "$VERIFY_RC" -eq 0 ] && [ -f "$REAL_SO" ] && [ "$APK" -ot "$REAL_SO" ]; then
  echo >&2
  echo "[FATAL] APK 比 .so 还旧 —— 这是上一轮的产物，不含本次改动。" >&2
  echo "        APK : $(date -r "$APK" '+%H:%M:%S' 2>/dev/null || echo '?')" >&2
  echo "        .so : $(date -r "$REAL_SO" '+%H:%M:%S' 2>/dev/null || echo '?')" >&2
  echo "        处置：删掉 APK 后重跑，或手动 ./gradlew assembleArm64Debug -x rustBuildArm64Debug" >&2
  VERIFY_RC=1
fi

echo
if [ "$VERIFY_RC" -eq 0 ]; then
  echo "== 核验通过 =="
else
  echo "== 核验失败：APK 不可用 ==" >&2
  exit 5
fi

# ════════════════════════════════════════════════════════════
#  ⑩ release 包签名 + 复制到 release/android/
# ════════════════════════════════════════════════════════════
#
# `tauri android build` 的 release 产物是 **unsigned** —— 它没有 signingConfig
# 就直接出 `<name>-unsigned.apk`，而这个文件**装不上**（安装时被系统拒绝）。
#
# 所以 release 必须再走一步 apksigner。keystore 放在仓库外
# `D:/tcs-release-keys/`（与 MSI 的客户端签名同一套材料），
# 密码从 `keystore.properties` 读，**不落进任何日志或仓库**。
#
# ★ v1（JAR signing）**必须开**，不是可选项。
#
# 2026-10-31 被真机打脸：只签 v2/v3 的包在 vivo 手机上装不上，报
#
#     应用未安装：软件包似乎无效
#     安装包缺乏开发者证书，建议联系安装包的开发者
#
# 我原先的判断是"minSdk=24（Android 7.0）起 v2 就够，v1 是多余的"——
# **按 AOSP 的标准 PackageInstaller 确实如此**，但国产 ROM 的自家安装器
# （vivo「文件管理」、部分 OPPO/小米旧安装器）走的是自己的校验路径，
# 只要 v1 的 META-INF 签名块不在就直接判"缺乏开发者证书"。
#
# 代价很小（v1 只是多一个 META-INF 目录），兼容性收益很大 —— 开。
# 三条一起开是 Android 生态里最稳的组合：老安装器认 v1、新系统用 v2/v3。
if [ "$VARIANT" = "release" ]; then
  KEYSTORE_PROPS="${TCS_KEYSTORE_PROPS:-D:/tcs-release-keys/keystore.properties}"
  # ★ 用 `-f` 不用 `-x`：Windows 上 `apksigner.bat` 的权限位是 `-rw-r--r--`，
  # Git Bash 里 `[ -x ]` 对它判 **假** —— 于是脚本会打印
  # "[WARN] 找不到 apksigner" 并且**跳过签名**，产出一个 unsigned 的 release 包。
  # 2026-10-31 实测踩到（第一版就是 `-x`，签名段整段被跳过了）。
  SIGNER="$ANDROID_HOME/build-tools/36.0.0/apksigner.bat"
  [ -f "$SIGNER" ] || SIGNER="$ANDROID_HOME/build-tools/36.0.0/apksigner"

  if [ ! -f "$KEYSTORE_PROPS" ]; then
    echo "[WARN] 没有 $KEYSTORE_PROPS —— release 包保持 unsigned，不能分发" >&2
  elif [ ! -f "$SIGNER" ]; then
    echo "[WARN] 找不到 apksigner —— release 包保持 unsigned" >&2
  else
    KS=$(sed -n 's/^storeFile=//p' "$KEYSTORE_PROPS")
    SP=$(sed -n 's/^storePassword=//p' "$KEYSTORE_PROPS")
    KA=$(sed -n 's/^keyAlias=//p' "$KEYSTORE_PROPS")
    KP=$(sed -n 's/^keyPassword=//p' "$KEYSTORE_PROPS")

    OUT_DIR="$REPO/release/android"
    mkdir -p "$OUT_DIR"
    SIGNED="$OUT_DIR/tavern-card-studio-$VERSION_NAME-arm64-release.apk"

    # ★ AGP 已经签过了（gradle 里配了 signingConfig）——**不要再签第二遍**。
    #
    # 2026-10-31 的教训：事后 `apksigner sign` 会在 AGP 产出的 zip 上追加签名块，
    # 而 v1 要求签名覆盖全部条目、且之后不能再动 zip 结构。结果产出
    # 「`META-INF/*.SF` 存在但 `apksigner verify` 报 v1: false」的包 ——
    # jarsigner 会指出 `resources.arsc is signed in JarFile but is not signed
    # in JarInputStream`。这种包在 vivo 安装器上就报"缺乏开发者证书"。
    #
    # 所以：AGP 签好的包直接复制，只做核验。
    if [ "$APK_PRE_SIGNED" -eq 1 ]; then
      echo
      echo "== 签名（AGP 已签，只需核验）=="
      cp "$APK" "$SIGNED"
    else
      echo
      echo "== 签名（release，事后 apksigner）=="
      "$SIGNER" sign \
        --ks "$KS" --ks-key-alias "$KA" \
        --ks-pass "pass:$SP" --key-pass "pass:$KP" \
        --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
        --out "$SIGNED" "$APK"

      if [ $? -ne 0 ] || [ ! -f "$SIGNED" ]; then
        echo "[FAIL] 签名失败" >&2
        exit 6
      fi
    fi

    # ── 判据：**先看退出码，再看文本** ──
    #
    # 2026-10-31 自我修正（第三次同类）：
    # 第一版写的是 `verify --print-certs | grep '^Verifies'` ——
    # 而 `apksigner verify` **只在加了 `--verbose` 时才打印 `Verifies` 那一行**，
    # 不加就只有 Signer #1 的信息。于是判据永远匹配不到，
    # 明明签名成功却报 `[FAIL] 未通过`，把整轮构建判死。
    #
    # 正确做法是以**退出码**为主判据（那是程序的契约，不随输出格式变），
    # 文本只是附加信息（用来把 DN 显示出来给人核对）。
    VERIFY_OUT=$("$SIGNER" verify --verbose --print-certs "$SIGNED" 2>&1)
    VERIFY_SIGN_RC=$?
    if [ "$VERIFY_SIGN_RC" -ne 0 ]; then
      echo "[FAIL] apksigner verify 退出码 $VERIFY_SIGN_RC：" >&2
      printf '%s\n' "$VERIFY_OUT" >&2
      exit 7
    fi

    DN=$(printf '%s' "$VERIFY_OUT" | sed -n 's/^Signer #1 certificate DN: //p' | tr -d '\r')
    echo "[OK] 签名有效（apksigner verify 退出码 0）"
    [ -n "$DN" ] && echo "      证书 DN: $DN"
    echo "  已签名包：$SIGNED"
    echo "  $(du -h "$SIGNED" | cut -f1)  sha256=$(sha256sum "$SIGNED" | cut -d' ' -f1)"

    # 附加自证：至少一种签名方案被确认通过
    if printf '%s' "$VERIFY_OUT" | grep -qE "Verified using v[23] scheme.*: true"; then
      printf '%s\n' "$VERIFY_OUT" | grep -E "Verified using v[123] scheme" | sed 's/^/      /'
    else
      echo "[WARN] 没看到 v2/v3 签名通过的记录，请人工确认：" >&2
      printf '%s\n' "$VERIFY_OUT" | head -6 >&2
    fi
  fi
fi

# debug 包也复制一份到 release/android/ 便于取用（不可正式分发，文件名已标注）
if [ "$VARIANT" = "debug" ]; then
  OUT_DIR="$REPO/release/android"
  mkdir -p "$OUT_DIR"
  cp "$APK" "$OUT_DIR/tavern-card-studio-$VERSION_NAME-arm64-debug.apk"
  echo
  echo "  （debug 包副本：$OUT_DIR/tavern-card-studio-$VERSION_NAME-arm64-debug.apk）"
fi
