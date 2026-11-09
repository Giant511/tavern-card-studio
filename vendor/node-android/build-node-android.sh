#!/usr/bin/env bash
#
# 部分验证（PARTIALLY VERIFIED）——
#
#   ✅ configure 阶段：2026-10-28 在 Ubuntu 22.04 VM 上**实测通过**，
#      `config.gypi` 输出 `target_arch=arm64  host_arch=x64  OS=android`。
#   ✅ make 阶段：2026-10-29 在真机上跑通（20.18.0 产物 73.7 MB，ST 1.19 四判据全过，
#      见 docs/spike-01 §7）。22.23.4 的产物由同一脚本产出，判据同 §4.1。
#
# 这一阶段抓到并修掉了四个会各浪费一小时的缺陷（详见 docs/spike-01-node-android.md §0.2）：
#   ① android-configure 的参数顺序是 <NDK> <sdk_version> <arch>，
#      而官方 BUILDING.md 写的是 <NDK> <arch> <sdk_version> —— 文档与代码矛盾，以代码为准
#   ② 不能自己再调一次 ./configure：android_configure.py 内部已经调过
#      （带 --dest-os=android），再调一次会把目标覆盖回宿主，编出 x86_64 的 node
#   ③ 不能 `source ./android-configure`：它靠 $0 找自己，source 时 $0 是调用者，
#      于是 Python 去解析 bash 脚本并报 SyntaxError（错误还指向你自己的行号）
#   ④ 必须显式设 CC_host：configure 用 CC_host 探测宿主架构，为空时退回 CC
#      （已被改成 aarch64 clang）→ host_arch 探成 arm64 → make 中途
#      `cannot execute binary file`
#
# 用法与产物判定见 docs/spike-01-node-android.md §4。
#
# 用途：交叉编译 Node 22 LTS for Android arm64，产出 libnode.so
#
# 版本选择（2026-10-29）：默认 22.23.4 —— Node 20 的 LTS 维护窗口已在 2026-04 结束，
# 再拿 20 做产品基线等于从第一天起就在跑没有安全补丁的运行时。
# 20.18.0 的产物保留着（见 docs/spike-01 §7），用来做 A/B 与回退。
#
# 必须的宿主条件（缺一不可）：
#   - Linux（VM 已就绪：Ubuntu 22.04 @ 192.168.1.201）
#   - Android NDK（VM 上为 r26d；路径通过 ANDROID_NDK_ROOT 传入）
#   - Python 3（gyp 需要）
#   - 至少 12 GB 空闲磁盘（实测 ST 那侧还要另算）
#   - 内存 3.8 GB 可行但紧，靠 swap 兜底；并行度会自动按核数与内存取小
#
# 用法：
#   ANDROID_NDK_ROOT=$HOME/android-ndk-r26d ./build-node-android.sh 22.23.4
#
#   只验配置不编译（约 2 分钟，改脚本后先用这个）：
#   CONFIGURE_ONLY=1 ANDROID_NDK_ROOT=$HOME/android-ndk-r26d ./build-node-android.sh 22.23.4
#
#   显式指定并行度：
#   JOBS=1 ANDROID_NDK_ROOT=$HOME/android-ndk-r26d ./build-node-android.sh 22.23.4
#
#   ⚠ 多版本并存：产物固定落在 `$WORKDIR/out/libnode.so`，所以**换版本必须换 WORKDIR**，
#     否则新产物会覆盖旧产物。惯例：`WORKDIR=~/tcs-build/work-<版本>`
#     （见 .verify/ssh/build-node-22.py）
# 产物：
#   out/libnode.so        —— 可执行 ELF，改名后放进 APK 的 jniLibs/arm64-v8a/
#
set -euo pipefail

NODE_VERSION="${1:-22.23.4}"
ANDROID_API=24                 # Node 对 Android 的最低要求（BUILDING.md）
TARGET_ARCH=arm64
WORKDIR="${WORKDIR:-$PWD/work}"

# 补丁脚本与本脚本同目录。用 BASH_SOURCE 取，不依赖调用者的 cwd ——
# 脚本后面会 `cd "$SRC"`，那时相对路径 `./apply-node22-...` 就找不到自己了。
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_SCRIPT="$SELF_DIR/apply-node22-android-patches.sh"

: "${ANDROID_NDK_ROOT:?必须设置 ANDROID_NDK_ROOT 指向已解压的 NDK}"

echo "== 环境自检 =="
for bin in make python3 git curl tar; do
  command -v "$bin" >/dev/null || { echo "缺少 $bin"; exit 1; }
done
[ -f "$ANDROID_NDK_ROOT/ndk-build" ] || { echo "ANDROID_NDK_ROOT 看起来不对：$ANDROID_NDK_ROOT"; exit 1; }
echo "NDK: $ANDROID_NDK_ROOT"
echo "Node: $NODE_VERSION / arch=$TARGET_ARCH / api=$ANDROID_API"

mkdir -p "$WORKDIR"
cd "$WORKDIR"

# 续跑开关：中断（OOM / 断线 / 手动停）之后用 RESUME=1 接着编。
#
# 为什么需要它：全量编译 90–150 分钟，中途断一次如果要从头 configure，
# 至少再花几分钟且会丢掉 make 的增量进度。而 `make` 本身是增量的 ——
# 只要 config.gypi 与 out/ 还在，重跑 make 只会编剩下的部分。
#
# 判据不是"有 RESUME 就跳过"，而是**确认已有配置真的有效**（下面会再验一次
# config.gypi 三元组）。否则 RESUME=1 就成了"跳过所有检查"，比不续跑更危险。
RESUME="${RESUME:-}"
SRC="node-v${NODE_VERSION}"

if [ -n "$RESUME" ]; then
  echo "== RESUME=1：检查可续跑状态 =="
  if [ ! -d "$SRC/out" ] || [ ! -f "$SRC/config.gypi" ]; then
    echo "✘ 没有可续跑的构建状态（缺 $SRC/out 或 config.gypi），去掉 RESUME 重跑"
    exit 1
  fi
  echo "✔ 找到已有构建状态，跳过源码准备与 configure"
  cd "$SRC"
else
  # 1) 取源码。用官方 tar.gz 而不是 git clone —— 少了 .git，省一半体积和时间
  TARBALL="node-v${NODE_VERSION}.tar.gz"
  if [ ! -f "$TARBALL" ]; then
    echo "== 下载 $TARBALL =="
    curl -fL --retry 3 -o "$TARBALL" "https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}"
  fi

  if [ ! -d "$SRC" ]; then
    echo "== 解包 =="
    tar xf "$TARBALL"
  fi

  cd "$SRC"
fi


# 2) 配置。
#
# ⚠️ 两个坑（2026-10-28 实读 `android_configure.py` 后修掉，原先都写错了）：
#
# ① **参数顺序是 `<NDK> <Android SDK 版本> <架构>`**，不是 `<NDK> <架构> <版本>`。
#    官方签名见 `android_configure.py:22` 的 usage；`sys.argv[2]` 会走 `int()`
#    （`:29`），传 `arm64` 进去直接 ValueError 崩掉。
#
# ② **不要再自己调 `./configure`**。`android_configure.py:76-77` 内部已经执行：
#       ./configure --dest-cpu=arm64 --dest-os=android --openssl-no-asm --cross-compiling
#    紧接着再跑一次 configure 会把配置**覆盖回宿主平台**（因为第二次没有
#    `--dest-os=android`），编出来是 x86_64 的 Linux node，而 `make` 照样成功、
#    产物照样几十 MB —— 整条链看起来全绿，只有产物架构不对。
#    这正是"我断言的是内容还是它的表示"那类问题的极端形式：
#    日志里每一行都是 success，判据只能看最终的 ELF 架构。
#
# 因此额外选项（如 `--without-npm`）**不要**自己追加。npm 是独立产物，
# 我们只取 `out/Release/node`，不带它不影响 node 二进制本身。
echo "== android-configure $TARGET_ARCH (api $ANDROID_API) =="
#
# ⚠️ 坑③（2026-10-28 实测踩到）：**必须直接执行，不能 `source`**。
#
# `android-configure` 本身是个 sh/Python 混写的引导脚本，第一段是：
#     _=[ 'exec' '/bin/sh' '-c' ''' command -v python3 ... exec python3 "$0" "$@" ''' "$0" "$@" ]
# 它靠 `$0` 找到自己再用 Python 重跑。而 `source`（= `.`）是在**当前 shell**里执行，
# `$0` 仍然是调用者的路径 —— 于是 Python 拿到的是 `build-node-android.sh`（我这份 bash 脚本），
# 去当 Python 解析，报：
#     File ".../build-node-android.sh", line 93
#       arm64|arm) ;;
#                ^
#     SyntaxError: unmatched ')'
# 这个错误的迷惑性在于：它指向**我自己的脚本行号**，看起来像我把 bash 语法写错了，
# 而实际上 bash 语法没问题 —— 是 Python 在读它。
#
# 另外，Node 的 BUILDING.md 写的是 `source ./android-configure <NDK> target_arch sdk_version`，
# 但 `android_configure.py` 的实际签名是 `<NDK> <sdk_version> <arch>`（`:29` 对 argv[2] 做 int()）。
# **官方文档的参数顺序和代码是矛盾的**，以代码为准。
#
# 直接执行的好处：`$0` 正确，且它内部自己调 `./configure`，config.gypi 会正确生成。
if [ ! -x ./android-configure ]; then
  echo "✘ ./android-configure 不存在或不可执行"
  exit 1
fi

# ⚠️ 坑④（2026-10-28 实测踩到）：**必须显式设置 CC_host / CXX_host**。
#
# `android_configure.py:66-67` 会把 `CC` / `CXX` 改成 NDK 的 aarch64 clang。
# 而 `configure.py:1215` 的 `host_arch_cc()` 靠 `cc_macros(CC_host)` 探测**宿主**架构，
# `cc_macros` 的实现是 `shlex.split(cc or CC)`（`:1168`）—— 也就是 `CC_host` 为空时
# **退回用 CC**。于是拿 aarch64 clang 探测宿主，得到 `host_arch: arm64`。
#
# 后果不是立刻报错，而是 make 阶段才炸：Node 构建要先编一批**在宿主上运行**的工具
# （torque、mksnapshot、v8_gen 等），它们会被用 aarch64 clang 编译，然后在 x86_64
# 宿主上执行 —— 报 `cannot execute binary file: Exec format error`。
# 那时已经编了十几分钟，而且错误信息完全指向别处。
#
# 正确做法：把 host 工具链显式指到宿主 gcc / g++，让 host_arch 探出 x64。
#
# ⚠️ 坑⑤（2026-10-28 实跑全量编译时踩到）：**LINK_host 必须是 g++，不是 gcc**。
#
# 第一版写成 `LINK_host=$(command -v gcc)`，结果编到一半链接 host 工具时炸：
#
#   /usr/bin/gcc -rdynamic -m64 -pthread -fPIC -o .../node_js2c ... libsimdutf.a
#   simdutf.cpp:(.text+0x38bd6): undefined reference to `operator delete(void*, unsigned long)'
#   simdutf.cpp:(.text+0x4422f): undefined reference to `std::__cxx11::basic_string<...>::_M_create(...)'
#   collect2: error: ld returned 1 exit status
#
# 原因：`simdutf` 是 C++ 写的，**编译**用的是 g++（正确），但**链接**用了 gcc。
# gcc 作为链接驱动**不会自动带 -lstdc++**，于是所有 C++ 运行时符号都成了 undefined。
#
# 这类错误的迷惑性在于：报错全是「undefined reference to operator new / std::basic_string」，
# 看起来像"源码少包含头文件"或"库没编进去"，而实际只是**链接器选错了语言驱动**。
# 通用规则：**只要构建里有一行 C++，链接驱动就必须用 g++**（g++ 链 C 目标文件无害）。
#
# 注意这是我"过度修正"造成的 —— 若完全不动 CC_host/LINK_host，gyp 会用默认的
# gcc/g++ 组合，本来就对。为了修 host_arch 探测而显式覆盖，就必须**每一项都覆盖正确**。
export CC_host="${CC_host:-$(command -v gcc)}"
export CXX_host="${CXX_host:-$(command -v g++)}"
export LINK_host="${LINK_host:-$(command -v g++)}"
export AR_host="${AR_host:-$(command -v ar)}"
echo "host toolchain: CC_host=$CC_host  CXX_host=$CXX_host  LINK_host=$LINK_host"

if [ -n "$RESUME" ]; then
  echo "== RESUME=1：跳过 configure，只复核已有 config.gypi =="
else
  # 2.4) 打 Node 源码补丁 —— **必须在 configure 之前**，因为 configure 会跑 gyp，
  #      而 gyp 会把这里的 libraries 写进生成的 makefile。
  #
  # -landroid：deps/zlib/cpu_features.c 在 Android 上用 NDK 的
  #   `android_getCpuFeatures`（<cpu-features.h>），该符号在 libandroid.so 里。
  #   Node 的 common.gypi 只加了 -llog，链接 node 时会报
  #   `ld.lld: error: undefined symbol: android_getCpuFeatures`。
  #
  # 用 python 做精确替换而不是 sed：要断言"恰好命中 1 处"，否则改错了也不知道。
  echo "== 打补丁：common.gypi 加 -landroid =="
  python3 - <<'PYEOF'
import io, sys
p = "common.gypi"
raw = io.open(p, encoding="utf-8").read()
if "-landroid" in raw:
    print("  已有 -landroid，跳过")
    sys.exit(0)
old = "      'libraries': [ '-llog' ],"
new = "      'libraries': [ '-llog', '-landroid' ],"
n = raw.count(old)
if n != 1:
    print("  ✘ 期望唯一匹配，实际 %d 处 —— 源码版本可能变了，停下" % n)
    sys.exit(1)
io.open(p, "w", encoding="utf-8").write(raw.replace(old, new, 1))
print("  ✔ 已加 -landroid（common.gypi）")
PYEOF
  PATCH_RC=$?
  if [ "$PATCH_RC" -ne 0 ]; then
    echo "✘ 补丁失败，停下"
    exit 1
  fi

  # 2.3) 打**源码级**补丁（补丁 1 handles.h、补丁 4 icu-generic.gyp）。
  #
  # 必须在 configure **之前**：configure 会跑 gyp，而补丁 4 改的正是 .gyp ——
  # gyp 生成 makefile 时才会把它变成 -O1。反过来（configure 后才打）就需要
  # 再来一轮重新生成，而这轮重新生成会把补丁 2/3 改过的 *.mk 覆盖掉。
  if [ -f "$PATCH_SCRIPT" ]; then
    echo "== 打源码级补丁（PATCH_PHASE=source）=="
    PATCH_PHASE=source NODE_SRC="$PWD" NDK="$ANDROID_NDK_ROOT" bash "$PATCH_SCRIPT"
    if [ $? -ne 0 ]; then echo "✘ 源码级补丁失败，停下"; exit 1; fi
  else
    echo "⚠ 找不到 $PATCH_SCRIPT —— 跳过源码级补丁（Node 22 可能编不过，见该脚本注释）"
  fi

  ./android-configure "$ANDROID_NDK_ROOT" "$ANDROID_API" "$TARGET_ARCH"
  CFG_RC=$?
  if [ "$CFG_RC" -ne 0 ]; then
    echo "✘ android-configure 返回 $CFG_RC"
    exit 1
  fi

  # 2.4.1) 立即复核生成的 makefile 里目标工具链**不是宿主 gcc**。
  #
  # 这是最贵的一个坑（实测损失：2332 个对象白编一遍）：gyp 的 out/Makefile 是
  #   CC.target ?= $(CC)
  # 而 CC 是 android_configure 在调 configure 时临时设的环境变量。
  # 只要有一次"手动重跑 gyp 却没带 CC/CXX"，CC.target 就会退回默认 gcc，
  # 编出来的 .o 全是 x86-64 —— 而 make 全程报 success，只有 file 才看得见。
  if [ -f out/Makefile ]; then
    if grep -qE "^CC\.target \?= \$\(CC\)" out/Makefile; then
      echo "⚠ out/Makefile 用 CC.target ?= \$(CC)；若 CC 未设会退化成宿主 gcc"
      echo "  当前 CC=${CC:-<未设置>}"
      case "${CC:-}" in
        *android*clang*) echo "  ✔ CC 指向 NDK clang，正常" ;;
        *)
          echo "  ✘ CC 不是 NDK clang —— 请不要手动跑 tools/gyp_node.py，"
          echo "    只能走 ./android-configure（它会先设 CC/CXX 再调 gyp）。停下。"
          exit 1
          ;;
      esac
    fi
  fi
fi


# 2.5) 打**生成物**补丁（补丁 2/3：out/ 下 gyp 生成的 *.mk）。
#
# 必须在 configure **之后** —— 这些文件由 gyp 刚生成。
# 与补丁 4 分开阶段的原因见 apply-node22-android-patches.sh 的 PATCH_PHASE 说明：
# 一次全跑会让"4 还没生效、2/3 已被重新生成覆盖"。
#
# RESUME=1 时 configure 被跳过，这里仍然跑一遍：补丁 2/3 幂等（已打过会 SKIP），
# 而万一上一轮被 `make -B` 冲掉过，这里是最后的补救点。
if [ -f "$PATCH_SCRIPT" ]; then
  echo "== 打生成物补丁（PATCH_PHASE=generated）=="
  PATCH_PHASE=generated NODE_SRC="$PWD" NDK="$ANDROID_NDK_ROOT" bash "$PATCH_SCRIPT"
  if [ $? -ne 0 ]; then echo "✘ 生成物补丁失败，停下"; exit 1; fi
fi

# 2.5) 配置自检 —— **在编译前**确认目标架构真的被设成 android/arm64。
#
# 为什么必须有这一步：上面那个坑②的失败形态是"编译成功、产物架构不对"。
# 跑完 make 要 1 小时，而这里只要一秒。判据取自 configure 生成的 config.gypi，
# 那是构建系统真正会读的东西，不是我记忆里的参数。
echo "== 配置自检 =="
if [ ! -f config.gypi ]; then
  echo "✘ configure 没生成 config.gypi —— 上一步失败了"
  exit 1
fi
# ⚠ 必须同时吃**单引号与双引号**两种写法（2026-10-29 实测）：
#   Node 20.18.0 的 config.gypi 是 Python repr 风格 →  'target_arch': 'arm64',
#   Node 22.23.4 的 config.gypi 是 JSON 风格        →  "target_arch": "arm64",
# 只匹配单引号的版本在 22 上取到空值，而 `set -euo pipefail` 让
# `VAR=$(grep ... | head | sed)` 这行**静默失败并退出** —— 日志停在
# "== 配置自检 =="，一个错误字都不打。这是"升 Node 要重趟构建"的第一个实测代价。
gyp_var() {  # gyp_var <key>  → 从当前目录的 config.gypi 取变量的值
  # 不能锚定行首（`^[^:]*`）：Node 20 的 gyp 会把两个键挤在一行 ——
  #   'variables': { 'OS': 'android',
  # 用行首锚定会因为它前面那个冒号而永远匹配不到 OS。
  sed -n "s/.*[\"']$1[\"'][[:space:]]*:[[:space:]]*[\"']\([^\"']*\)[\"'].*/\1/p" config.gypi | head -1
}
GYP_ARCH=$(gyp_var target_arch)
GYP_OS=$(gyp_var OS)
GYP_HOST=$(gyp_var host_arch)
echo "config.gypi: target_arch=$GYP_ARCH  host_arch=$GYP_HOST  OS=$GYP_OS"
case "$GYP_ARCH" in
  arm64|arm) ;;
  *)
    echo "✘ target_arch 是 '$GYP_ARCH'，不是 arm64 —— 配置被宿主平台覆盖了"
    echo "  这会让 make 编出 x86_64 的 Linux node，且全程不报错。停下。"
    exit 1
    ;;
esac
if [ "$GYP_OS" != "android" ]; then
  echo "✘ OS 是 '$GYP_OS'，不是 android —— 同上，停下"
  exit 1
fi
# host_arch 必须是宿主真架构。它错了会去编一批"能在宿主跑"的工具却得到
# aarch64 产物，make 十几分钟后才报 `cannot execute binary file`。
HOST_REAL=$(uname -m)
case "$HOST_REAL" in
  x86_64) HOST_EXPECT=x64 ;;
  aarch64) HOST_EXPECT=arm64 ;;
  *) HOST_EXPECT="" ;;
esac
if [ -n "$HOST_EXPECT" ] && [ "$GYP_HOST" != "$HOST_EXPECT" ]; then
  echo "✘ host_arch 是 '$GYP_HOST'，但宿主是 $HOST_REAL（应为 $HOST_EXPECT）"
  echo "  原因通常是 CC_host 没设，configure 拿 CC（NDK 的 aarch64 clang）去探测宿主。"
  echo "  这样编出的 host 工具在宿主上跑不起来，make 会中途失败。停下。"
  exit 1
fi
echo "✔ 配置自检通过：target=$GYP_ARCH  host=$GYP_HOST  OS=$GYP_OS"

# 只验配置就停：给"确认脚本正确性"用，不触发 1 小时的编译。
#
# 为什么要有这个开关：修脚本时最想知道的是"参数顺序对不对、配置有没有被
# 覆盖回宿主"，而这两件事在 configure 阶段就定了。为了看一眼而跑完整 make，
# 代价是几十分钟；没有这个开关，人就会选择"不验证、直接信代码" —— 而那正是
# 我上一版把参数顺序写反却毫无察觉的原因。
if [ -n "${CONFIGURE_ONLY:-}" ]; then
  echo "== CONFIGURE_ONLY=1，配置验证完成，不进入编译 =="
  exit 0
fi

# 3) 编译。
#
# 并行度按**物理核数与内存取小**，不硬编码：
#   · 超过物理核数不会更快（这里就 2 个 vCPU，-j4 只是把队列排长）；
#   · 交叉编译单个 TU 内存占用很高，-j 开大了会被 OOM killer 干掉，
#     而它报的是 "internal compiler error"，极容易误判成代码问题
#     （这也是我把它从 -j4 改成按核数取的原因 —— 目标是能在 2 核 / 3.8 GB
#      的机器上跑完，而不是在一台大机器上快几秒）。
# 可用 JOBS=2 显式覆盖。
if [ -n "${JOBS:-}" ]; then
  PARALLEL="$JOBS"
else
  CORES=$(nproc 2>/dev/null || echo 2)
  # 每个 job 的内存预算按**实测值**定，不靠猜：
  #   2026-10-28 在 4 vCPU / 5885 MB 上跑 -j2，V8 host 阶段整机 used 1712 MB，
  #   扣掉系统占用约 400 MB ⇒ 每 job 约 650 MB。
  # 原先写 1800 MB/job 太保守，在同一台机器上算出 -j2，白白浪费两个核
  # （实测 -j2 时 3.9 GB 空闲、swap 用量 0，明显没吃满）。
  # 取 1000 MB 预算（V8 大 TU 比均值重），另留 1024 MB 给系统与最终链接
  # （链接 node 时单个 ld 进程能到 1 GB+）。
  MEM_MB=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 2048)
  BY_MEM=$(( (MEM_MB - 1024) / 1000 ))
  [ "$BY_MEM" -lt 1 ] && BY_MEM=1
  PARALLEL=$CORES
  [ "$BY_MEM" -lt "$PARALLEL" ] && PARALLEL=$BY_MEM
  [ "$PARALLEL" -lt 1 ] && PARALLEL=1
fi

# ─────────────────────────────────────────────────────────────────────────────
# ICU 超大单文件的三条处置（2026-10-30 编码，替代此前的手工绕过）
#
# ## 它治的是什么
#
# Node 22.23.4 的 ICU 数据是一个 **94 MB 的单文件 C 数组**（`icudt78_dat.c`，
# 由 `genccode` 从 `icudt78l.dat` 生成）。用 `-O3` 编它、同时还有 3 个别的 job
# 在跑，峰值内存叠加后超过 5.9 GB 内存 + 12 GB swap ⇒ mmap 失败 ⇒ **SIGBUS**：
#
#   clang-17: error: clang frontend command failed with exit code 135
#   make: *** [.../icudt78_dat.o] Error 1        # 135 = 128 + 7 = SIGBUS
#
# Node 20.18 没炸是**运气**：它那轮恰好是在 `-j2` 阶段编到这个文件的。
# 所以这是概率性失败 —— 崩了重跑一次可能就好了，然后你以为解决了，
# 下次换版本又崩。**"重跑就好了"是这里最坏的结论。**
#
# ## 实测数据（2026-10-29，4 vCPU / 5885 MB + 12 GB swap）
#
#   | 项                        | 值                              |
#   |---------------------------|---------------------------------|
#   | icudt78l.dat.bz2（源）     | 11,344,770 B  / 10.8 MB         |
#   | icudt78l.dat（解压后）     | 33,107,952 B  / 31.6 MB         |
#   | icudt78_dat.c（生成）      | 98,692,328 B  / **94.1 MB**     |
#   | 对应 .o                    | 33,108,880 B  / 31.6 MB         |
#   | `-O1` 峰值 RSS             | 2,469,328 KB  / **2.35 GB**     |
#   | `-O1` 耗时                 | **4 分 24 秒**                  |
#
# 所以 .c ≈ 2.98 × .dat ≈ 8.7 × .bz2 —— 下面的估算就用这两个比例。
#
# ## 三条处置
#
#   ① **单源文件 >50 MB 自动 `-O1`**。它只是 ICU 的数据数组，
#      `-O3` 对纯数据段几乎不产生收益，峰值内存却差一倍以上（2.35 GB vs 崩）。
#   ② **并行度按"单文件峰值"再卡一道**。原公式只看核数与总内存，
#      不知道有个 2.35 GB 的单文件；超大文件参与时直接压到 `-j2`。
#   ③ **续跑前无条件重编这个 .o**。崩溃时 `.o` **已经存在且大小正确**
#      （33,108,880 B，边写边崩的完整产物）——
#      **`.o` 存在且大小对 ≠ 编译成功**。若不删，make 会因时间戳比源新而跳过它，
#      那份没验过的 .o 就直接进链接，产物坏在最后一步且不报错。
#
# ## 实现要点：为什么是改 makefile 而不是手工编
#
# gyp 生成的 `out/tools/icu/icudata.target.mk` 里有：
#
#   $(OBJS): GYP_CFLAGS := $(DEFS_$(BUILDTYPE)) $(INCS_$(BUILDTYPE)) $(CFLAGS_$(BUILDTYPE)) ...
#
# 这是 **target-local** 变量（`$(OBJS)` 就是那一个 .o），所以追加一行
# `$(OBJS): GYP_CFLAGS += -O1` 只影响这个 TU，且 `-O1` 出现在 `-O3` 之后、
# 后写的胜出。**不要手工 clang 编**：gyp 的 `do_cmd` 会把命令行存进
# `.d.raw` 做比对，手编出来的 .o 会被下一次 make 用 `-O3` 覆盖掉。
# ─────────────────────────────────────────────────────────────────────────────

# 单文件超过这个大小就按"超大 TU"处理。50 MB 是需求给的口径，
# 对应 .dat ≈ 16.8 MB / .bz2 ≈ 5.7 MB。
BIG_TU_MB="${BIG_TU_MB:-50}"
ICU_MKF="out/tools/icu/icudata.target.mk"
BIG_TU=0

if [ -f "$ICU_MKF" ]; then
  # 估 .c 的大小：优先用已生成的 .c（续跑场景最准），否则按输入文件推算。
  ICU_C_ACTUAL=""
  for f in out/Release/obj/gen/icudt*_dat.c out/Release/obj/gen/icudt*dat.c; do
    [ -f "$f" ] && ICU_C_ACTUAL="$f" && break
  done

  EST_BYTES=0
  EST_SRC=""
  if [ -n "$ICU_C_ACTUAL" ]; then
    EST_BYTES=$(stat -c %s "$ICU_C_ACTUAL")
    EST_SRC="已生成的 .c（实测）"
  else
    # 尚未生成：按源文件推算。比例取自上方实测表。
    DAT=$(ls deps/icu-tmp/icudt*.dat 2>/dev/null | head -1)
    BZ2=$(ls deps/icu-small/source/data/in/icudt*.bz2 deps/icu/source/data/in/icudt*.bz2 2>/dev/null | head -1)
    if [ -n "$DAT" ]; then
      DAT_B=$(stat -c %s "$DAT")
      EST_BYTES=$(( DAT_B * 298 / 100 ))   # .c ≈ 2.98 × .dat
      EST_SRC=".dat $DAT_B B（×2.98 估算）"
    elif [ -n "$BZ2" ]; then
      BZ2_B=$(stat -c %s "$BZ2")
      EST_BYTES=$(( BZ2_B * 87 / 10 ))     # .c ≈ 8.7 × .bz2
      EST_SRC=".bz2 $BZ2_B B（×8.7 估算）"
    fi
  fi

  LIMIT=$(( BIG_TU_MB * 1048576 ))
  if [ "$EST_BYTES" -gt "$LIMIT" ]; then
    BIG_TU=1
    echo "== ICU 超大 TU：约 $(( EST_BYTES / 1048576 )) MB（来源：$EST_SRC），阈值 ${BIG_TU_MB} MB =="

    # ① 断言这一 TU 真的降到 -O1 了。
    #
    # 这里**不再自己打补丁**，只做断言 —— 原因是实测出来的：
    #
    #   · 第一版我在 configure 之后给 `icudata.target.mk` 追加
    #     `$(OBJS): GYP_CFLAGS += -O1`。能 grep 到、看着对。
    #   · 但它是**生成物**：一次 `make -B`（甚至 `-B -n` dry run）就会让 make
    #     重新生成 out/ 下的 *.mk，补丁**静默消失**。实测 04:36 那次
    #     `grep -c O1` 从 1 变 0。
    #   · 于是构建跑到 84 分钟又崩一次，而"我明明打过补丁"会让人往别处找原因。
    #
    # 现在补丁在**源码** `tools/icu/icu-generic.gyp`（补丁 4），由 gyp 正确生成。
    # 生成物这边只验结果：CFLAGS_Release 里必须有 -O1 且**不能有 -O3**
    # （-O3 在后面会胜出，这正是"只写 cflags 无效"的原因）。
    #
    # 断言失败就**当场退出**，不要烧 17 小时再崩在 84 分钟处。
    # 只检查 **CFLAGS_Release 这一个块**，不要全文件 grep。
    #
    # 全文件搜会假绿：这个 .mk 里别处也可能出现 -O1（别的变量块），
    # 于是"把目标那行的 -O1 删掉"照样能通过 —— 实测过，反向用例没拦住。
    # 而真正决定这个 TU 怎么编的，只有 CFLAGS_Release。
    ICU_CFLAGS_BLOCK=$(awk '/^CFLAGS_Release :=/{f=1} f{print} f&&/^$/{exit}' "$ICU_MKF" 2>/dev/null)

    if ! printf '%s' "$ICU_CFLAGS_BLOCK" | grep -qE '^[[:space:]]*-O1([[:space:]]|\\)*$'; then
      echo "   ✘ $ICU_MKF 的 CFLAGS_Release 里没有 -O1 —— 补丁 4 没生效"
      echo "     原因通常是：补丁 4 是在 configure 之后才打的，gyp 还没重新生成。"
      echo "     处置：PATCH_PHASE=source 重跑 apply-node22-android-patches.sh，"
      echo "           再重新 configure（或 touch tools/icu/icu-generic.gyp 让 make 重生成）。"
      exit 1
    fi
    if printf '%s' "$ICU_CFLAGS_BLOCK" | grep -qE '^[[:space:]]*-O3([[:space:]]|\\)*$'; then
      echo "   ✘ $ICU_MKF 的 CFLAGS_Release 里仍有 -O3 —— 会覆盖 -O1，等于补丁没打"
      echo "     常见原因：只加了 'cflags': ['-O1'] 而漏了 \"cflags!\" 删 -O3。"
      echo "     gyp 把目标 cflags 放在继承的 -O3 **之前**，clang 以最后一个为准。"
      exit 1
    fi
    echo "   [①] 已确认该 TU 用 -O1（$ICU_MKF 里无 -O3）"

    # ② 并行度按单文件峰值再卡一道。
    #
    # 原公式只算"核数 vs 总内存÷每 job 预算"，不知道有个 2.35 GB 的单文件。
    # 2.35 GB × 2 + 系统 ≈ 5.5 GB，正好压在 5885 MB 的边界上 ——
    # 所以超大文件在场时**最多 -j2**，不能再高。
    if [ "$PARALLEL" -gt 2 ]; then
      echo "   [②] 并行度 $PARALLEL → 2（超大 TU 峰值 2.35 GB × 并行数 会撞内存上限）"
      PARALLEL=2
    else
      echo "   [②] 并行度保持 $PARALLEL（已 ≤ 2）"
    fi

    # ③ 无条件删掉这个 .o 及其依赖记录。
    #
    # **不看大小、不看时间戳**：崩溃产物 33,108,880 B 与正常产物同大小，
    # 唯一的可信判据是"本次 make 编过且退出 0"。
    #
    # ⚠️ 路径必须靠 find 找，**不能写死**：第一版写的
    # `out/Release/obj/gen/icudt*_dat.o` 是错的 —— 那只是**生成的 .c/.S 所在目录**，
    # 真正的目标文件在 `out/Release/obj.target/icudata/gen/icudt78_dat.o`
    # （gyp 的 `$(obj).$(TOOLSET)/$(TARGET)` 布局）。
    # 结果那次"已清 1 个残留"其实是把我自己造的假文件删了 —— **假阳性**，
    # 真崩溃产物没删，make 会因时间戳跳过它，坏 .o 直接进链接。
    N_PURGED=0
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      rm -f "$f" && N_PURGED=$(( N_PURGED + 1 ))
    done <<EOF
$(find out -type f \( -name 'icudt*_dat.o' -o -name 'icudt*_dat.o.d' -o -name 'icudt*_dat.o.d.raw' \) 2>/dev/null)
EOF
    echo "   [③] 已清 $N_PURGED 个残留（.o 存在且大小正确 ≠ 编译成功，必须强制重编）"
    if [ "$N_PURGED" -eq 0 ]; then
      echo "       注：没有残留属正常（正常构建后该 .o 已被链接消费或本就未生成）"
    fi
  fi
elif [ -d out ]; then
  echo "== 未找到 $ICU_MKF —— 跳过 ICU 超大 TU 处置（Node 布局可能变了，请复核）=="
fi

# 验证钩子（与 CONFIGURE_ONLY 同一用途）：只看这三条处置做了什么，不进编译。
#
# 为什么需要它：这三条的目的就是"让 17.6 小时的构建别在某处崩"，
# 而**验证它们的正确性根本不需要跑完 17.6 小时** ——
# 判据是 `make -n` 出来的命令行里有 `-O1`、并行度是 2、残留 .o 被删了。
#
# 没有这个钩子，人就会"写完直接信代码"（这正是 memory §26 记的教训：
# `CONFIGURE_ONLY=1` 加之前，四个 configure 缺陷全都是靠读代码"确认"的，
# 结果全错）。用法：
#
#   RESUME=1 ICU_GUARD_ONLY=1 ANDROID_NDK_ROOT=... ./build-node-android.sh 22.23.4
#
# 之后自己再跑 `make -C out BUILDTYPE=Release -n <那个 .o>` 看命令行。
if [ -n "${ICU_GUARD_ONLY:-}" ]; then
  echo ""
  echo "== ICU_GUARD_ONLY=1：停在这里，不进编译 =="
  echo "   BIG_TU=$BIG_TU  PARALLEL=$PARALLEL"
  if [ "$BIG_TU" = "1" ]; then
    echo "   下一步可自行复核："
    echo "     awk '/^CFLAGS_Release :=/{f=1} f&&/^[[:space:]]+-O[0-9]/{print} f&&/^$/{exit}' $ICU_MKF"
    echo "     查 -O1 是否真的落到那个 TU 上（**不要加 -B**，它会重新生成 mk）："
    echo "       awk '/^CFLAGS_Release :=/{f=1} f&&/^[[:space:]]+-O[0-9]/{print} f&&/^\$/{exit}' $ICU_MKF"
  fi
  exit 0
fi

echo "== make -j$PARALLEL（cores=$(nproc 2>/dev/null)，mem=${MEM_MB:-?} MB）=="
#
# ⚠️ 坑⑥（2026-10-28，坑⑤ 的后半截）：**只改环境变量不够，Makefile 已经把旧值固化了**。
#
# 修了 LINK_host=g++ 之后重跑，仍然报同样的 undefined reference。查下去发现：
#
#   out/Makefile:57  CC.host   ?= /usr/bin/gcc
#   out/Makefile:59  CXX.host  ?= /usr/bin/g++
#   out/Makefile:61  LINK.host ?= /usr/bin/gcc     ← 罪魁
#
# 这些行是**第一次 configure 时按当时的环境变量生成并写死**的。
# 后来改环境变量对它们无效 —— 因为 Makefile 里的值是字面路径，不是 `$(LINK_host)`。
#
# 这是"配置固化"的典型：错误发生在生成阶段，暴露在执行阶段，而症状指向源码
# （undefined reference to std::basic_string）。两次都以为是别的问题。
#
# 双保险：
#   ① 下面 make 时显式覆盖这些变量（命令行赋值优先级最高，压过 Makefile）
#   ② 若确实需要干净重建，删掉 out/Makefile 与 *.mk 让 configure 重新生成
#
# ⚠️ 缺陷 7（2026-10-28 实测）：**不要跑裸 `make`**。
#   根 Makefile 的 node 目标执行的是 `$(MAKE) -C out`（不带目标）⇒ out 的默认目标
#   `all` ⇒ 连 Node 自己的单元测试 cctest 一起编。而 cctest 用了 aligned_alloc，
#   它在 bionic 里是 **API 28** 才有，我们按 API 24 编 ⇒ 必然失败：
#     ../test/cctest/test_crypto_clienthello.cc:57:40:
#       error: use of undeclared identifier 'aligned_alloc'
#   看起来像"编译失败"，实际错的是测试，跟 node 本体无关。
#
#   所以直接构建 out/node.target.mk 里那个 `node:` 目标：
#     make -C out BUILDTYPE=Release node
#   BUILDTYPE 不能省 —— $(builddir) 展开自它，省了就变成 `make Release/node` 找不到规则。
echo "== make -C out BUILDTYPE=Release node -j$PARALLEL（不编 cctest）=="
make -C out BUILDTYPE=Release node "-j$PARALLEL" \
  "CC.host=$CC_host" \
  "CXX.host=$CXX_host" \
  "LINK.host=$LINK_host" \
  "AR.host=$AR_host"
MAKE_RC=$?
if [ "$MAKE_RC" -ne 0 ]; then
  echo "✘ make 返回 $MAKE_RC —— 按原始错误报，不要重试掩盖"
  exit 1
fi

# 4) 产物整理与自检
OUT="$WORKDIR/out"
mkdir -p "$OUT"
cp out/Release/node "$OUT/libnode.so"

echo "== 产物自检 =="
file "$OUT/libnode.so"
SIZE=$(stat -c %s "$OUT/libnode.so")
echo "体积: $SIZE bytes（预期 40–60 MB）"
if ! file "$OUT/libnode.so" | grep -qi 'aarch64'; then
  echo "✘ 不是 aarch64 产物，检查 TARGET_ARCH 与 NDK"
  exit 1
fi
if [ "$SIZE" -lt 30000000 ]; then
  echo "✘ 体积异常偏小（< 30 MB），可能链接失败或 strip 过头"
  exit 1
fi
echo "✔ 产物看起来正确：$OUT/libnode.so"
echo
echo "下一步（见 docs/spike-01-node-android.md §4）："
echo "  · 直接推到 /data/local/tmp 下 exec 会失败（W^X）—— 那是预期，用来证明约束真实"
echo "  · 正确路径：放进 APK 的 jniLibs/arm64-v8a/libnode.so，manifest 设 extractNativeLibs=true"
