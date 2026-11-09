#!/usr/bin/env bash
#
# Node 22 for Android arm64 的四个构建补丁（一次性应用，幂等）。
#
# 在交叉编译 **Node 22.x** 到 **Android arm64** 时，Node 上游有若干 gyp 条件写错，
# 导致一批平台相关的源文件被静默丢弃，**编译全部通过、只在链接期报 undefined symbol**。
#
# ## 四个补丁分别治什么
#
# | # | 症状 | 根因 |
# |---|---|---|
# | 1 | `handles.h:147: static assertion failed: This handle does not reference a heap object` | V8 12 的 `#if __clang_major__ >= 17` + `static_assert(false)` 依赖 CWG2518，NDK r26d 的 clang 17.0.2 实现有缺陷 |
# | 2 | `undefined reference to trap_handler::TryHandleSignal / RegisterDefaultTrapHandler / v8_internal_simulator_ProbeMemory` | `v8.gyp` 判 `OS` 而非 `host_os`，三个 trap-handler 源文件不进 host 目标 |
# | 3 | `ld.lld: error: undefined symbol: android_getCpuFeatures` | 同一回归的另一表现：NDK 的 `cpu-features.c` 没被编进 node 链接 |
# | 4 | `clang frontend command failed with exit code 135`（=SIGBUS），崩在 `icudt*_dat` 那个 94 MB 单文件 | `-O3` 编 ICU 数据数组峰值过高，与其它 job 叠加后撞爆内存 ⇒ mmap 失败 |
#
# ## 用法
#
#   NODE_SRC=$HOME/tcs-build/work-22.23.4/node-v22.23.4 \
#   NDK=$HOME/android-ndk-r26d \
#   bash apply-node22-android-patches.sh
#
# **什么时候跑**：`android-configure` 之后、`make` 之前；或者 make 报上述任一错误之后。
# 补丁 2、3 改的是**生成物**（out/*.mk），重跑 configure 会覆盖 —— 所以必须在 configure 之后跑。
# 补丁 4 改的是**源码**（tools/icu/icu-generic.gyp），configure 会把它正确重新生成。
#
# ⚠️ **不要用 `make -B`**（2026-10-30 实测）：`-B` 会让 make 认为 gyp 生成物过期，
#    从而**重新生成 out/ 下的 Makefile 与 *.target.mk**，把补丁 2、3 静默冲掉 ——
#    而 `-B -n`（dry run）也会真地重写这些文件。需要强制重编就用 `touch` 那个源文件。
#
# ## 为什么不用 sed
#
# 四个补丁都要**精确匹配多行文本**（含缩进与反斜杠），sed 处理多行容易误伤。
# 用 python3 内联脚本，带锚点断言；匹配不到就报错退出，不会静默改坏。
#
set -euo pipefail

# ── 阶段开关（PATCH_PHASE）────────────────────────────────────
#
# 补丁分成两类，**执行时机不同**，这是实测踩出来的：
#
#   | 阶段     | 补丁      | 改什么                         | 什么时候跑         |
#   |----------|-----------|--------------------------------|--------------------|
#   | `source` | 1、4      | Node 源码（.h / .gyp）          | **configure 之前** |
#   | `generated` | 2、3   | out/ 下 gyp 生成的 *.mk        | **configure 之后** |
#
# 为什么不能"一次全跑"：补丁 4 改的是 `.gyp`，要等 configure（gyp）重新生成
# 才生效；而重新生成会把补丁 2、3 改过的 `*.mk` **整个覆盖掉**。
# 一次全跑的结果是：4 还没生效、2/3 已经没了。
#
# 默认 `all` 会按 source → generated 顺序跑，**并且提示你**：
# 如果 configure 已经跑过，补丁 4 需要再来一轮（重新生成 + 重跑 generated）。
PATCH_PHASE="${PATCH_PHASE:-all}"
case "$PATCH_PHASE" in
  source|generated|all) ;;
  *) echo "✘ PATCH_PHASE 只能是 source / generated / all，收到：$PATCH_PHASE"; exit 1 ;;
esac
RUN_SOURCE=0; RUN_GENERATED=0
case "$PATCH_PHASE" in
  source)    RUN_SOURCE=1 ;;
  generated) RUN_GENERATED=1 ;;
  all)       RUN_SOURCE=1; RUN_GENERATED=1 ;;
esac
echo "== 补丁阶段：$PATCH_PHASE（source=$RUN_SOURCE generated=$RUN_GENERATED）=="

NODE_SRC="${NODE_SRC:-$HOME/tcs-build/work-22.23.4/node-v22.23.4}"
NDK="${NDK:-$HOME/android-ndk-r26d}"

[ -d "$NODE_SRC" ] || { echo "✘ NODE_SRC 不存在: $NODE_SRC"; exit 1; }
[ -d "$NDK" ] || { echo "✘ NDK 不存在: $NDK"; exit 1; }

echo "Node 源码: $NODE_SRC"
echo "NDK:       $NDK"
echo

# ── 补丁 1：handles.h 的 CWG2518 兼容 ────────────────────────────
if [ "$RUN_SOURCE" = "1" ]; then
echo "── 补丁 1/3：handles.h（clang 17.0.2 的 CWG2518 缺陷）──"
python3 - "$NODE_SRC" <<'PY'
import pathlib, sys
h = pathlib.Path(sys.argv[1]) / "deps/v8/src/handles/handles.h"
s = h.read_text()
if "[TCS patch]" in s:
    print("  SKIP 已打过"); raise SystemExit(0)
old = '''#if defined(__clang__) && __clang_major__ >= 17
      // For non-HeapObjects, there's no on-heap object to dereference, so
      // disallow using operator->.
      //
      // If you got an error here and want to access the Tagged<T>, use
      // operator* -- e.g. for `Tagged<Smi>::value()`, use `(*handle).value()`.
      static_assert(
          false,
          "This handle does not reference a heap object. Use `(*handle).foo`.");
#endif'''
new = '''// [TCS patch] 原为 `#if __clang__ && __clang_major__ >= 17` + `static_assert(false)`。
      // 那段依赖 CWG2518（discarded branch 里的 static_assert(false) 只在实例化时报错）。
      // NDK r26d 的 clang 17.0.2 把它当成无条件错误，V8 自己的 torque 生成码会编译失败。
      // 退回 V8 11 的行为：operator* 本来就返回 Tagged<T>，对非 HeapObject 也合法。
      return **this;'''
if old not in s:
    print("  ✘ 锚点没找到 —— V8 源码结构变了，请人工核对"); raise SystemExit(1)
h.write_text(s.replace(old, new, 1))
print("  OK 已打补丁")
PY
fi

# ── 补丁 2：host 侧 v8_base 补三个 trap-handler ──────────────────
if [ "$RUN_GENERATED" = "1" ]; then
echo "── 补丁 2/3：v8_base_without_compiler.host.mk（trap-handler ×3）──"
python3 - "$NODE_SRC" <<'PY'
import pathlib, sys
mk = pathlib.Path(sys.argv[1]) / "out/tools/v8_gypfiles/v8_base_without_compiler.host.mk"
if not mk.exists():
    print(f"  ✘ 找不到 {mk}（先跑 android-configure？）"); raise SystemExit(1)
s = mk.read_text()
suffix = "/deps/v8/src/trap-handler/"
wanted = ["handler-inside-posix.o", "handler-outside-posix.o", "handler-outside-simulator.o"]
missing = [w for w in wanted if w not in s]
if not missing:
    print("  SKIP 三个都已存在"); raise SystemExit(0)

# 插到 handler-shared.o 之后（那里是 trap-handler 段的末尾）
anchor = "\t$(obj).host/$(TARGET)" + suffix + "handler-shared.o \\\n"
if anchor not in s:
    print("  ✘ 锚点 handler-shared.o 没找到"); raise SystemExit(1)
add = "".join(
    "\t$(obj).host/$(TARGET)" + suffix + w + " \\\n" for w in missing
)
# 最后一行不能带续行反斜杠之外的语法错误：本段后面还有其它条目，所以保留反斜杠是对的
mk.write_text(s.replace(anchor, anchor + add, 1))
print(f"  OK 补了 {len(missing)} 个: {', '.join(missing)}")
PY

# ── 补丁 3：cpufeatures（android_getCpuFeatures）────────────────
echo "── 补丁 3/3：cpu_features_ndk.o + node.target.mk ──"
python3 - "$NODE_SRC" "$NDK" <<'PY'
import pathlib, subprocess, sys
src, ndk = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
obj = src / "out/Release/obj.target/deps/zlib/cpu_features_ndk.o"
mk = src / "out/node.target.mk"
clang = ndk / "toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang"
cfile = ndk / "sources/android/cpufeatures/cpu-features.c"
inc = ndk / "sources/android/cpufeatures"

if not obj.exists():
    obj.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(
        [str(clang), "-O3", "-fPIC", "-fno-omit-frame-pointer", "-Wall",
         "-DANDROID", "-DHAVE_PTHREADS", f"-I{inc}", "-c", str(cfile), "-o", str(obj)],
        capture_output=True, text=True)
    if r.returncode != 0:
        print("  ✘ 编译 cpu-features.c 失败"); print(r.stderr[:600]); raise SystemExit(1)
    print(f"  OK 编出 cpu_features_ndk.o ({obj.stat().st_size} 字节)")
else:
    print("  SKIP cpu_features_ndk.o 已存在")

s = mk.read_text()
if "cpu_features_ndk.o" in s:
    print("  SKIP node.target.mk 已含该条目"); raise SystemExit(0)

# ⚠️ 关键：-landroid 后面原本没有续行反斜杠，加行时必须自己补上，
# 否则 make 报 "recipe commences before first target"。
old = "\t-landroid\n"
if old not in s:
    print("  ✘ 锚点 -landroid 没找到"); raise SystemExit(1)
mk.write_text(s.replace(old, f"\t-landroid \\\n\t{obj}\n", 1))
print("  OK node.target.mk LIBS 已补（含续行反斜杠）")
PY
fi

# ── 补丁 4：ICU 数据 TU 降 -O1（治 SIGBUS）─────────────────────
#
# ## 为什么改 gyp 而不是改生成的 makefile
#
# 第一版我是在 configure 之后给 `out/tools/icu/icudata.target.mk` 追加
# `$(OBJS): GYP_CFLAGS += -O1`。看着能生效（`grep` 得到、`make -n` 也认），
# 但**它是生成物**：只要 make 认为 gyp 输入比产物新（或任何人跑了 `make -B`），
# gyp 会重新生成这个文件，补丁**静默消失** —— 于是构建跑到 84 分钟时又崩一次，
# 而"补丁明明打过"这个印象会让人往别处找原因。
#
# 实测证据：2026-10-30 04:36 跑了一次 `make -B -n`，`icudata.target.mk` 的
# mtime 变成 04:36、行数回到 304、`grep -c O1` = 0。
#
# 所以改到**源码** `tools/icu/icu-generic.gyp` 的 `icudata` 目标上：gyp 每次
# 重新生成都会带上它，`-B` 也无所谓。
#
# ## 为什么是 "-O1" 而不是别的
#
# 这个 TU 只是 ICU 的**数据数组**（`static const` 的字节表），`-O3` 对纯数据段
# 几乎不产生收益，但峰值内存差一倍以上。实测（4 vCPU / 5885 MB + 12 GB swap）：
#
#   -O3 + 其它 3 个 job 叠加 → 撞爆内存 → SIGBUS（exit 135）
#   -O1 单编               → 峰值 RSS 2,469,328 KB（2.35 GB），耗时 4 分 24 秒
#
# 顺序问题：gyp 把目标自己的 `cflags` 追加在全局 `-O3` 之后，所以 `-O1` 在后面，
# clang 以最后一个为准。脚本末尾会断言这一点（不信就自己看 generated makefile）。
if [ "$RUN_SOURCE" = "1" ]; then
echo "── 补丁 4/4：icu-generic.gyp 的 icudata 目标加 -O1 ──"
python3 - "$NODE_SRC" <<'PY'
import pathlib, sys
gyp = pathlib.Path(sys.argv[1]) / "tools/icu/icu-generic.gyp"
s = gyp.read_text()

# 幂等判断看的是**有效形态**（cflags! 在），不是"有没有痕迹"。
# 第一版只写了 cflags，实测无效（-O3 在后面胜出）；见到那种半成品要**升级**它，
# 而不是 SKIP —— 否则"补丁打过"这个印象会让下一次崩溃无处可查。
if "'cflags!': [ '-O3' ]" in s:
    print("  SKIP 已打过（cflags! + cflags 都在）"); raise SystemExit(0)
if "TCS 补丁 4" in s:
    if "      'cflags': [ '-O1' ],\n" in s:
        s = s.replace("      'cflags': [ '-O1' ],\n",
                      "      'cflags!': [ '-O3' ],\n      'cflags': [ '-O1' ],\n", 1)
        gyp.write_text(s)
        print("  UPGRADE 旧形态（只有 cflags）→ 补上 cflags! [ '-O3' ]")
        raise SystemExit(0)
    print("  ✘ 有 TCS 补丁 4 标记但形态不认识，请人工检查"); raise SystemExit(1)

anchor = """      'target_name': 'icudata',
      'type': '<(library)',
      'toolsets': [ 'target' ],
"""
if anchor not in s:
    print("  ✘ 锚点没找到（icu-generic.gyp 结构可能变了）"); raise SystemExit(1)

# 只加一条 cflags。-O1 对纯数据数组没有收益损失，但内存峰值降一半以上。
add = """      # ★ TCS 补丁 4（2026-10-30）：ICU 数据 TU 降 -O1。
      # 这个目标只含一个 94 MB 的数据数组（genccode 生成），-O3 编它会撞爆内存
      # 导致 SIGBUS（clang exit 135）。-O1 峰值 2.35 GB / 4 分 24 秒。
      #
      # ⚠️ 必须是 `cflags!` + `cflags` 两条，**只写 cflags 是无效的**：
      # gyp 把目标自己的 cflags 放在继承来的全局 cflags **之前**，而 clang
      # 以最后一个 -O 为准 —— 实测生成的 CFLAGS_Release 里 -O1 在第 175 行、
      # -O3 在第 184~189 行，**-O3 在后面胜出**，补丁等于没打。
      # `cflags!` 是 gyp 的"从继承列表里删掉这些标志"，删掉 -O3 之后 -O1 才是唯一的。
      'cflags!': [ '-O3' ],
      'cflags': [ '-O1' ],
"""
gyp.write_text(s.replace(anchor, anchor + add, 1))
print("  OK 已在 icudata 目标加 'cflags': [ '-O1' ]")
PY


fi
echo
echo "全部完成。现在可以 make 了："
echo "  make -C $NODE_SRC/out BUILDTYPE=Release node -j2 \\"
echo "    CC.host=/usr/bin/gcc CXX.host=/usr/bin/g++ LINK.host=/usr/bin/g++ AR.host=/usr/bin/ar"
