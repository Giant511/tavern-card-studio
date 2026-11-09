# Spike ①：自编译 Node 20+ for Android arm64 并跑起 ST 1.19

> **状态（2026-10-29 15:55 最终）：✅ 全部通过 —— spike ① 达成**
>
> | 阶段 | 状态 | 判据与实测值 |
> |---|---|---|
> | 构建宿主接入 | ✅ 通过 | Ubuntu 22.04 VM（192.168.1.201）SSH 通，NDK r26d 就绪 |
> | 交叉编译**配置** | ✅ 通过 | `config.gypi`: `target_arch=arm64  host_arch=x64  OS=android` |
> | 交叉编译**产物** | ✅ 通过 | 73.7 MB；`e_machine=0x00b7` + `interpreter=/system/bin/linker64` + 链 `liblog.so` |
> | 真机**跑 node** | ✅ 通过 | `v20.18.0 arm64 android`（三项同时成立） |
> | **ST 1.19 跑起 + 8000 应答** | ✅ **通过** | 四判据全过，见 §7 |
>
> **判定标准（需求文档）**：在 Android 环境（真机 adb）实测通过 —— 已满足。
> 设备：vivo V2507A / Android 16（SDK 36）/ arm64-v8a / `Enforcing`。
> 路径 A（`/data/local/tmp` 直跑）成立，**APK 链（T15.3）可以开工**。

本文记录五件事：① 判定过的技术事实（可复用）；② **VM 接入实测与六个构建脚本缺陷**；
③ 并行度这类参数为什么不能拍脑袋（§0.4）；④ 阻塞在哪、需要什么；⑤ 执行剧本与进度。

---

## 0. VM 接入实测（2026-10-28）

用户提供了 VMware 上的 Ubuntu 22.04，比"放行 WSL2"更好：不用改安全策略，
且 Ubuntu 是官方 `BUILDING.md` 假设的环境。

### 0.1 实测环境

| 项 | 值 | 对构建的含义 |
|---|---|---|
| 系统 | Ubuntu 22.04.5 LTS，kernel 5.15，**VMware** | 官方支持路径 |
| 架构 | x86_64 | 正确的交叉编译宿主 |
| CPU | 2 vCPU（i5-1235U） | 并行度只能 -j2；总时长估 90–150 分钟 |
| 内存 | 3875 MB（可用 2834 MB） | **偏紧**，靠 swap 兜底 |
| swap | **12066 MB**（3.8 G + 8 G 两个文件） | OOM 风险基本消除 |
| 磁盘 | 63 GB 可用 | 足够（Node 源码+中间产物约 10–15 GB） |
| 工具链 | make 4.3 / gcc 11 / python 3.10 / git / curl / xz / perl | 齐备；**clang 缺失**（不需要，用 NDK 的） |
| NDK | r26d（`26.3.11579264`），2.1 GB | `aarch64-linux-android{21,24,28}-clang` 全在 |
| 网络 | nodejs.org / github / dl.google.com 全 200 | 无代理 |
| 权限 | uid=1000，**无 passwordless sudo** | 装 SDK/JDK 需要用户输密码 |
| Docker | **有**（`/usr/bin/docker`）+ lxc | T15.4 契约测试可直接起 ST 容器 |
| adb | 缺失 | 用 platform-tools 补 |

编译速度实测基准（用 NDK clang 现编）：

```text
2405 行 / 71 KB 的模板密集 C++，-O2：4.29 秒，峰值 137 MB
产物：ELF 64-bit LSB relocatable, ARM aarch64   ← 架构正确
```

### 0.2 抓到四个构建脚本缺陷（全部实测暴露，不是审出来的）

这四个都写在我上一轮提交的 `vendor/node-android/build-node-android.sh` 里，
**如果直接跑完整编译，每一个都会以不同的方式浪费一次 1 小时**。

#### 缺陷 1：参数顺序反了，而且官方文档也是错的

`android_configure.py` 的实际签名是 `<NDK> <sdk_version> <arch>`：

```python
android_ndk_path = sys.argv[1]     # :33
android_sdk_version = sys.argv[2]  # :34 —— 会走 int()，:29
arch = sys.argv[3]                 # :35
```

而 Node 的 `BUILDING.md` 写的是：

```console
$ source ./android-configure /path/to/your/android-ndk target_arch android_sdk_version
```

**文档与代码矛盾**。按文档传 `arm64` 进 `argv[2]`，`int('arm64')` 直接 ValueError。

#### 缺陷 2：重复调 configure 会把配置覆盖回宿主

`android_configure.py:76-77` 内部自己执行了：

```python
os.system("./configure --dest-cpu=" + DEST_CPU + " --dest-os=android --openssl-no-asm --cross-compiling")
```

我原来的脚本紧接着又跑了一次 `./configure --fully-static --openssl-no-asm --without-npm ...`
—— **第二次没有 `--dest-os=android`，于是目标被覆盖回宿主平台**。
`make` 照样成功、产物照样几十 MB，只有 `file` 一看是 x86_64。

这是"整条链每行都 success、只有产物不对"的典型。**判据只能是最终 ELF 架构。**

#### 缺陷 3：`source` 会让 `$0` 指向调用者，Python 去解析 bash

`android-configure` 是 sh/Python 混写引导脚本，靠 `$0` 找自己再 `exec python3 "$0"`。
`source` 时 `$0` 仍是调用者 → Python 拿到的是我的 `build-node-android.sh`，报：

```text
File ".../build-node-android.sh", line 93
  arm64|arm) ;;
           ^
SyntaxError: unmatched ')'
```

迷惑点：**错误指向我自己脚本的行号**，看起来像 bash 语法写错了，实际是 Python 在读它。
改成直接执行 `./android-configure ...` 即解决。

#### 缺陷 4：`CC_host` 未设 → `host_arch` 被探成 arm64

`android_configure.py:66-67` 把 `CC` 改成 NDK 的 aarch64 clang。
而 `configure.py:1215` 的 `host_arch_cc()` 用 `cc_macros(CC_host)` 探测宿主，
`cc_macros` 实现是 `shlex.split(cc or CC)`（`:1168`）—— **`CC_host` 为空就退回用 `CC`**。
于是拿 aarch64 clang 探测宿主，得到 `host_arch: arm64`。

后果不是立刻报错，而是 make 十几分钟后：Node 要先编一批**在宿主上运行**的工具
（torque、mksnapshot、v8_gen），它们被用 aarch64 clang 编译，然后在 x86_64 上执行 →
`cannot execute binary file: Exec format error`。

修：显式 `export CC_host=$(command -v gcc)` 等四个变量。

#### 缺陷 5+6：`LINK_host` 用了 gcc，且错值被 Makefile 固化（2026-10-28 实跑时踩到）

这两个是同一个问题的两半，都是**我自己修坑④ 时引入的**，而且都表现为"看起来像源码问题"。

**前半：链接器必须用 g++**

我写的是 `LINK_host=$(command -v gcc)`。编到一半链接宿主工具 `node_js2c` 时炸：

```text
/usr/bin/gcc -rdynamic -m64 -pthread -fPIC -o .../node_js2c ... libsimdutf.a
simdutf.cpp:(.text+0x38bd6): undefined reference to `operator delete(void*, unsigned long)'
simdutf.cpp:(.text+0x4422f): undefined reference to `std::__cxx11::basic_string<...>::_M_create(...)'
collect2: error: ld returned 1 exit status
```

原因：`simdutf` 是 C++，**编译**用了 g++（对），但**链接**用了 gcc。
gcc 作为链接驱动**不会自动带 `-lstdc++`**，于是所有 C++ 运行时符号 undefined。

迷惑点：报错全是「undefined reference to operator new / std::basic_string」，
看着像"少包含头文件"或"库没编进去"，实际只是链接器语言驱动选错。

**通用规则**：只要构建里有一行 C++，链接驱动就用 g++（g++ 链 C 目标文件无害）。

**后半：只改环境变量不够，Makefile 已把旧值写死**

改成 `LINK_host=g++` 后重跑，**报一模一样的错**。查下去：

```text
out/Makefile:57  CC.host   ?= /usr/bin/gcc
out/Makefile:59  CXX.host  ?= /usr/bin/g++
out/Makefile:61  LINK.host ?= /usr/bin/gcc     ← 罪魁
```

这些行是**第一次 configure 时按当时的环境变量生成的字面路径**，不是 `$(LINK_host)` 引用。
所以后来改环境变量对它们无效。

这是"配置固化"的典型：**错误发生在生成阶段，暴露在执行阶段，症状指向源码**。
两次都先怀疑源码/依赖，而不是"上一轮的错值还在 makefile 里"。

修法（双保险）：

```bash
# ① 删掉旧 makefile 让 configure 重新生成
rm -f out/Makefile out/*.mk config.gypi
# ② make 时再显式覆盖（命令行赋值优先级最高，压过 Makefile）
make -j"$PARALLEL" "CC.host=$CC_host" "CXX.host=$CXX_host" \
     "LINK.host=$LINK_host" "AR.host=$AR_host"
```

**验证判据**（修复后实测）：

```text
out/Release/node_js2c   size=1482056   file → x86-64     ← 宿主工具，架构对
日志中 error / undefined reference / collect2 计数 → 0
```

> **一条教训**：坑④ 的修法是"显式覆盖工具链的每一项"。这类覆盖必须**每一项都正确**，
> 而且要考虑"覆盖值会不会被写进生成物、之后改不回来"。
> 我修 host_arch 时只想着"让它探出 x64"，没想"LINK 该用哪个语言驱动"，
> 于是引入了一个新的、更难查的错误。

#### 缺陷 7：`make` 默认目标是 `all`，会把 Node 的单元测试也编进去

跑完编译后 `make` 报：

```text
../test/cctest/test_crypto_clienthello.cc:57:40: error: use of undeclared identifier 'aligned_alloc'
make[1]: *** [cctest.target.mk:243: .../test_crypto_clienthello.o] Error 1
make: *** [Makefile:137: node] Error 2
```

看起来是"编译失败"，实际**错的是 Node 自己的单元测试**，不是 node 本体。

根因两层：

1. 根 `Makefile:137` 的 `node` 目标执行的是 `$(MAKE) -C out`（**不带具体目标**）⇒
   `out/Makefile` 的默认目标 `all` ⇒ 连 `cctest` 一起编。
2. `aligned_alloc` 在 bionic 里是 **API 28** 才有的，而我们按 API 24 编
   （`android-configure <NDK> 24 arm64`）。测试用了它，必然报未声明。

**修法**：只构建 node 二进制，走 `out/node.target.mk:358` 的 `node:` 目标：

```bash
make -C out BUILDTYPE=Release node -j4
```

判据：`make -C out BUILDTYPE=Release node -n | grep -c cctest` 必须是 **0**。

> 注意 `BUILDTYPE` 不能省：`$(builddir)` 展开自它，省了就变成 `make Release/node`
> 找不到规则（`No rule to make target 'Release/node'`）。

#### 缺陷 8（最贵的一个）：手动重跑 gyp 会**静默**把目标工具链换成宿主 gcc

为了加一个链接参数，我直接跑了 `python3 tools/gyp_node.py -f make`。结果：

- 编译**全部成功**、日志一片绿；
- 但新编出来的对象是 **x86-64**，而之前的是 **ARM aarch64** ——
  `file` 一看才发现，5255 个对象里有 **2332 个是错的**。

根因在 gyp 生成的 `out/Makefile`：

```make
CC.target ?= $(CC)
CXX.target ?= $(CXX)
LINK.target ?= $(LINK)
```

`CC`/`CXX` 这些环境变量是 `android_configure` 在调 configure **时**设置的。
我重跑 gyp 时只导出了 `CC_host/CXX_host/LINK_host/AR_host`（为了修坑④），
**没导出目标侧的 `CC/CXX`** ⇒ `CC.target` 退回默认 `gcc` ⇒ 编出宿主架构。

**这条和坑⑥ 是同一类**：错误发生在**生成阶段**，暴露在**执行阶段**，
而症状（x86-64 对象）只有用 `file` 才看得见，日志里全是 success。

**纪律**：

1. **重新生成 makefile 只能走 `./android-configure <NDK> <api> <arch>`**
   （它会先设 `CC/CXX/...` 再调 configure → gyp）。单独跑 `tools/gyp_node.py` 必错。
2. 如果只是想加链接参数，**不要重跑 gyp**：直接在 `out/Makefile` 末尾追加覆盖，
   或改 `common.gypi` 后走完整 configure。
3. 每次改动后**必须验 `file` 的架构**，不能只看 make 是否成功。

**恢复办法**（本次实际用的）：

```bash
# ① 在 out/Makefile 末尾钉住目标工具链（不改 gyp 源，避免再次全量重生成）
cat >> out/Makefile <<EOT
CC.target := $NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang
CXX.target := ...-clang++
LINK.target := ...-clang++
AR.target := .../llvm-ar
EOT
# ② 删掉错的对象（按时间戳圈定这次误编的批次）
find out/Release -name '*.o' -newermt '10:19' -delete
# ③ 重编，然后**再验一次** file
make -C out BUILDTYPE=Release node -j4
```

删除时用**时间戳圈定批次**，而不是"全删"：全删会把之前 3 小时编好的 2977 个
aarch64 对象也扔掉。删完立刻抽样 `file` 确认剩下的确实是 aarch64。

#### 缺陷 8 的第二个症状：`--openssl-no-asm` 也会一起丢

修完工具链后重编，又炸在另一处：

```text
../deps/openssl/openssl/crypto/bn/asm/x86_64-gcc.c:119:9: error: invalid output constraint '=a' in asm
```

**x86 汇编被拿去用 aarch64 编译器编**。原因是 `--openssl-no-asm` 这个 configure 参数
（`android_configure.py` 里传的）也属于"生成阶段"的设置：手动跑 `tools/gyp_node.py`
时它以 `openssl_no_asm` 变量的形式丢了，于是 openssl 的 gyp 又把
`x86_64-gcc.c` 当成分支之一编了进去。

修法同一条：**只能走 `./android-configure`**。走完之后 `config.gypi` 里能读到

```text
'OS': 'android'
'host_arch': 'x64'
'openssl_no_asm': 1
'target_arch': 'arm64'
```

**所以缺陷 8 的完整判据是四个值一起看**，不只看 tar≡x64/android：

| 值 | 错了会怎样 |
|---|---|
| `target_arch=arm64` | 编出 x86-64，make 不报错 |
| `host_arch=x64` | host 工具跑不起来（坑④） |
| `OS=android` | 链 glibc 而非 bionic |
| **`openssl_no_asm=1`** | **x86 汇编被 aarch64 编译器编，报 invalid constraint** |

外加两个生成物复核：`out/Makefile` 的 `CC.target`/`CXX.target` 必须指向 NDK clang
（`LINK ?= $(CXX.target)` 会跟着对），`out/node.target.mk` 里必须有 `-landroid`。

#### 缺陷 9：zlib 的 ARM SIMD 优化需要 `-landroid`

链接 node 时报：

```text
ld.lld: error: undefined symbol: android_getCpuFeatures
>>> referenced by cpu_features.c
>>> out/Release/obj.target/zlib/deps/zlib/cpu_features.o:(_cpu_check_features)
```

`deps/zlib/cpu_features.c` 在 Android 上用 NDK `<cpu-features.h>` 的
`android_getCpuFeatures`，该符号在 **`libandroid.so`** 里，而 Node 的 gyp 只加了
`-llog`（`common.gypi:578` 的 `['_toolset=="target"', {'libraries': ['-llog']}]`）。

修法：在同一处补 `-landroid`：

```python
'libraries': [ '-llog', '-landroid' ],
```

NDK r26d 的 API 24 sysroot 里有 `libandroid.so`，可以直接链。

### 0.3 验证结果（这才是"通过"的判据）

修完后跑 `CONFIGURE_ONLY=1`（只到 configure 自检就停，不触发编译）：

```text
== android-configure arm64 (api 24) ==
host toolchain: CC_host=/usr/bin/gcc
INFO: configure completed successfully
Info: Configuring for arm64...
== 配置自检 ==
config.gypi: target_arch=arm64  host_arch=x64  OS=android
✔ 配置自检通过：target=arm64  host=x64  OS=android
== CONFIGURE_ONLY=1，配置验证完成，不进入编译 ==
```

三个值同时正确才说明交叉编译配置真的生效了：

| 值 | 正确值 | 错了会怎样 |
|---|---|---|
| `target_arch` | `arm64` | 编出 x86_64，`make` 不报错 |
| `host_arch` | `x64` | host 工具跑不起来，make 中途崩 |
| `OS` | `android` | 链接到 glibc 而非 bionic，装上就崩 |

### 0.4 并行度预算：又一个"拍脑袋"的判断错误（2026-10-28 实跑中途修正）

这条不是代码缺陷，是**参数估计错误**，但它让一次两小时的编译白跑了一半时间。

原公式是「每个 job 按 1800 MB 预算」：

```bash
BY_MEM=$(( (MEM_MB - 1024) / 1800 ))
```

在 4 vCPU / 5885 MB 上算出 `BY_MEM = (5885-1024)/1800 = 2` ⇒ `-j2`。
**4 核只用 2 核，白白闲着一半。**

实测数据推翻了这个预算：

```text
-j2 运行时：内存 used 1712 MB（含系统占用约 400 MB）⇒ 每 job 约 650 MB
           swap 用量 0 MB，avail 3.9 GB
```

`1800 MB/job` 高了将近 3 倍。改成按实测取 1000 MB/job（V8 大 TU 比均值重）
+ 另留 1024 MB 给系统与最终链接（链接 node 时单个 ld 进程能到 1 GB+）：

```bash
BY_MEM=$(( (MEM_MB - 1024) / 1000 ))
```

| 宿主规格 | 原公式 | 新公式 |
|---|---|---|
| 2 vCPU / 3875 MB（扩容前） | `-j2` | `-j2`（不变，向后兼容） |
| 4 vCPU / 5885 MB（扩容后） | `-j2`（**浪费一半**） | `-j4` |

改后实测：`cc1plus=4`、内存 2.4 GB / 5885 MB、swap 0、load 4.3。

**教训**：并行度这类参数不能靠"感觉内存紧张"拍一个保守值。
保守在编译这件事上**不是安全边际，是直接的时间成本** ——
`-j2` 和 `-j4` 差的是一个多小时。而判断依据（`used` 与 `swap`）随时能从机器上读到，
一个 `free -m` 就能证伪。

**中途改并行度是安全的**（`-j` 只影响调度，不影响产物），但要处理两件事：

1. **不要用 `SIGKILL`**：给 `make` 发 `SIGTERM`，让它在任务边界退出；
2. **删掉被杀时正在写的 `.o`**：`gcc` 写输出文件时被打断会留下**截断的 `.o`**，
   而 `make` 只看时间戳 —— 它会认为这个文件是新的，不再重编，最后在链接阶段炸，
   或者更糟：链出一个运行时才崩的二进制。
   本次做法：删掉最近 6 分钟内修改的 `.o`（21 个），代价约 3 分钟重编。
   `-size -1k` 查零字节文件是无效判据（本次 0 个，但确实有 21 个是刚写的）。

> 顺带一个实现坑：`pkill -f "make -j"` 会**匹配到自己**（`ssh '...'` 的远端
> `bash -c` 命令行里含这个字面串），表现是"命令执行了但什么也没停、输出还断了"。
> 必须写 `pkill -f "[m]ake -j"`（方括号让正则匹配目标但不匹配自身）。

### 0.5 时间预估错了：不是 90–150 分钟，是 5 小时以上

**这条必须记下来，因为我在上一版文档里写了"90–150 分钟"，而这个数错了两倍多。**

| 阶段 | 实际耗时 | 说明 |
|---|---|---|
| `-j2` 跑到 2983 个 `.o`（含 VM 失联期） | **1 小时 52 分** | 到 V8 target 阶段 |
| `-j4` 续跑（含 host V8 + v8_initializers + target 收尾） | **3 小时 20 分以上** | 见下表 |
| 合计 | **5 小时以上** | 原估 1.5–2.5 小时 |

**错在哪：漏算了 V8 要编两遍。**

Node 的 V8 在交叉编译时会生成**两套**目标文件：

```text
obj.host/    给宿主用（跑 mksnapshot 生成快照）
obj.target/  给 Android 用（最终产物）
```

而 V8 里最大的一块是 `v8_initializers` —— **torque 生成的 455 个 `.cc`**
（`out/Release/obj/gen/torque-generated/`），host 和 target **各编一遍**：

| 目标 | host 完成量 | target 完成量 |
|---|---|---|
| `v8_base_without_compiler` | 854 | 2199 里已含 |
| `v8_initializers` | 455（慢慢编） | **455（后编）** |
| `v8_compiler` | 130 | — |

合计约 **4700+ 个目标文件**，而不是我原来按"源码文件数"估的 2000 多个。

**为什么这个错误值得记**：我原来的估算方法是"71 KB 文件编译 4.29 秒 → 外推"。
那个基准是**单个小文件**，而 V8 的目标文件里大量是模板密集的巨文件
（`builtins-*-tq-csa.cc`、`v8_base` 的各个 `.cc`），单文件最慢能到几分钟。
**用最小的样本外推最大的工作，误差必然大** —— 这正是 memory §1 里
"样本要与声称形态一致"那条判据。

**更靠谱的估法**（下次用这个）：不按文件数估，按**目标文件总数 × 实测单文件均速**，
并且**先数清 host/target 两套**：

```bash
# 目标文件总数（编之前就能数，.mk 里写着）
grep -oE '[^ ]+\.o' out/*.host.mk out/*.target.mk | sort -u | wc -l
```

**结论：给这类活估时，先数目标文件总量，再乘实测均速；不要用单个小文件外推。**
如果一开始就知道是 5 小时，我就不该在 1 小时半的时候还以为"快完了"。

### 0.6 顺带修掉的两个工具缺陷（在 `.verify/ssh/`，不入库）

- **SFTP 不展开 `~`**：`sftp.put(local, "~/a/b.sh")` 会在远端建一个**字面名为 `~` 的目录**，
  文件落在 `<cwd>/~/a/b.sh`；而 `ls ~/a` 去看 `<HOME>/a` 是空的。
  表现是"上传无错、执行报 No such file or directory"。已加 `expand()`。
- **`vm.home` 返回假值**：第一版 `return self._home or "/root"`，没探过就报 `/root`
  （实际 `/home/ebyte`）。同一个值两个来源、一个是猜的一个是真的 —— 比直接报错更坏，
  因为报告里会写上错误的 HOME。改成第一次访问就探测。

---


## 1. 已判定的技术事实（这些是查证过的，不是推测）

### 1.1 Node 官方对 Android 的立场：不支持，但有构建路径

`nodejs/node` 的 `BUILDING.md`（v22.x 分支与 HEAD 均同）原文：

> Android is not a supported platform. Patches to improve the Android build are welcome.
> There is no testing on Android in the current continuous integration environment.

同文档给出的路径：

```console
$ source ./android-configure /path/to/android-ndk target_arch android_sdk_version
$ make -j4
```

约束条件（同文档）：
- NDK 必须预先下载解压；
- `android_sdk_version` 至少 24（Android 7.0）；
- 目标架构支持 `[arm, arm64/aarch64, x86, x86_64]`。

**含义**：这不是"能不能编"的问题，是"没有官方背书、升级可能随时坏"的问题。
所以 §5 把它登记成一个决策（自编译 Node），并接受"每次升 Node 都要重新趟一遍"。

### 1.2 真正的技术生死题不是编译，是 W^X

Android 10（API 29）起，`targetSdk >= 29` 的应用**不能对应用主目录（可写区）里的
文件调用 `execve()`**。官方文档原文（Android 10 行为变更 / 移除了应用主目录的执行权限）：

> 从可写的应用主目录执行文件的行为违反了 W^X 安全机制。
> 应用应仅加载嵌入在应用 APK 文件中的二进制代码。

官方 issue 的处置建议（issuetracker 128554619）：

> While exec() no longer works on files within the application home directory,
> it continues to be supported for files within the read-only /data/app directory.
> In particular, it should be possible to package the binaries into your
> application's native libs directory and enable android:extractNativeLibs=true,
> and then call exec() on the /data/app artifacts.

**由此得出两条硬约束（写进 T15.3 设计，不可协商）**：

| 约束 | 具体做法 |
|---|---|
| node 二进制不能放 `filesDir`/`assets` 里解压后执行 | 打成 `libnode.so` 放进 `jniLibs/arm64-v8a/`；manifest 设 `android:extractNativeLibs="true"`；从 `/data/app/.../lib/arm64/libnode.so` exec |
| ST 的 JS 代码可以放私有目录 | W^X 限制的是**执行**，不是**读取**。node 从私有目录读 JS 是允许的 —— 数据目录与二进制目录必须分开 |

同一个官方回复还有一句必须记录的风险提示：

> Additionally, please be aware that executables executed via exec() are not managed
> according to the Android process lifecycle, and generally speaking, exec() is
> discouraged from Android applications. ... Relying on exec() may be problematic
> in future Android versions.

**含义**：ST 子进程**不会**跟随 App 被系统回收。这直接决定了 F2「随 App 生命周期启停」
必须靠我们自己实现（前台服务 + 退出时显式 kill + 启动时检查孤儿进程），
不能指望系统帮我们收拾。这是一条 v1 必须实现、且必须写进验收清单的项。

### 1.3 好消息：ST 1.19 是纯 JavaScript，没有原生模块

判据（在 ST 源码树里实际执行）：

```console
$ find node_modules -name "*.node" | wc -l
0
```

`package.json` 里两个名字可疑的依赖，实际实现形态：

| 依赖 | 形态 | 判据 |
|---|---|---|
| `tiktoken` | 纯 JS + WASM（`init.js`/`load.cjs`/`lite/`/`encoders/`） | 目录内无 `.node` |
| `@agnai/web-tokenizers` | 纯 JS（`lib/`） | 目录内无 `.node` |

**为什么这条最重要**：如果 ST 依赖 `sharp`/`sqlite3`/`bcrypt` 这类 node-gyp 模块，
交叉编译 Node 只是第一步，还得为 arm64-android 重编每一个原生模块 ——
那才是真正的工程深渊（Termux 走了很多年）。现在这条风险**不存在**。

WASM 在 Android 上的可行性：WASM 走 `mmap(PROT_EXEC)`，属 JIT 类操作，
Android 对 app 进程是允许的（ART 自己就要 JIT）；被禁止的是对**文件** `execve()`。
两者不是一回事，不要混为一谈。

### 1.4 ST 的启动参数（"只绑 127.0.0.1 + 私有数据目录"怎么落）

| 需求 | 实现 | 出处 |
|---|---|---|
| 只绑 127.0.0.1 | **不传** `--listen`（默认 `false` ⇒ 绑 `127.0.0.1`） | `src/command-line.js:331` |
| 私有数据目录 | `--dataRoot=<app 私有目录>` | `src/command-line.js:212`、`:290` |
| 端口 | `--port=8000` | `:132`、`:303` |
| 不开浏览器 | `--browserLaunchEnabled=false` | `:142` |

实际命令行形如：

```text
libnode.so <stRoot>/server.js --port=8000 --dataRoot=<filesDir>/st-data \
    --browserLaunchEnabled=false --configPath=<filesDir>/st-data/config.yaml
```

验收判据（spike 必须实测这一条）：
`adb shell netstat -tlnp | grep 8000` 只出现 `127.0.0.1:8000`，
**不能出现 `0.0.0.0:8000` 或 `[::]:8000`**。

---

## 2. 现在还剩什么阻塞（VM 接入后）

宿主问题已解决（见 §0）。剩下三条，按"是否卡死判定"排序：

### 2.1 设备可用（2026-10-28 用户确认），但要先定用哪条验证路径

用户确认真机可解决：可以连**无线 adb** 或**有线 adb**。阻塞解除了，但"怎么用这台设备"
有两条路径，门槛差一个数量级 —— 这是本节的主要内容。

#### 路径 A：`adb shell` 直接跑 —— **✅ 已实测成立（2026-10-28）**

只需要 platform-tools（8 MB），不需要 JDK / Android SDK / Rust target：

```bash
adb push libnode.so /data/local/tmp/
adb push st/ /data/local/tmp/st/
adb shell chmod 755 /data/local/tmp/libnode.so
adb shell /data/local/tmp/libnode.so --version
```

**为什么这条路成立**：W^X 限制的对象是「**targetSdk≥29 的应用**执行自己**可写目录**里的文件」。
`adb shell` 是 uid 2000 的 shell 用户，`/data/local/tmp` 是它的目录，不在那条限制之下。

**这台设备的实测数据（vivo V2507A / Android 16 / SDK 36）**：

| 项 | 实测值 | 含义 |
|---|---|---|
| `ro.product.cpu.abilist` | `arm64-v8a` | 决策 #265（arm64 单架构）成立 |
| `ro.build.version.release` | `16`（SDK 36） | 无线调试可用；W^X 早已生效 |
| `df -h /data` | 459 G 总 / **204 G 可用** | 远超 1 GB 需求 |
| `/data/local/tmp` 上下文 | `u:object_r:shell_data_file:s0` | 与预期一致 |
| `adb shell id` | `uid=2000(shell) context=u:r:shell:s0` | — |
| `getenforce` | `Enforcing` | SELinux 是开着的 |

**关键实验（这一步不需要编译产物就能做，见下方"方法论"）**：

```console
$ adb shell 'cp /system/bin/toybox /data/local/tmp/toybox; chmod 755 /data/local/tmp/toybox'
$ adb shell '/data/local/tmp/toybox echo EXEC_OK_from_tmp'
EXEC_OK_from_tmp
rc=0

$ adb shell 'cp /system/bin/sh /data/local/tmp/tcs_sh; chmod 755 /data/local/tmp/tcs_sh'
$ adb shell '/data/local/tmp/tcs_sh -c "echo SH_OK uid=$(id -u)"'
SH_OK uid=2000
```

⇒ **Android 16 的 shell 域可以 exec `shell_data_file`**，两种公开说法（"Permission denied
要 chcon"）在这台机器上都不成立。分支判定落到第一条：**spike ① 达标路径 = 路径 A**，
APK 那条链（JDK+SDK+Rust，3–4 GB）可以整体推到 T15.3。

> **方法论：不要等产物才去验有没有权限。**
> 一个自然但错误的顺序是"先编一小时，push 上去看能不能跑"。而 exec 权限是**平台属性**，
> 与要执行的程序是什么无关 —— 把系统自带的 `toybox` 拷进同一个目录执行，就能在**编译开始前**
> 回答这个问题。同理，`getenforce`、`ls -Z`、`id` 都是零成本的先行判据。
> 这类"能提前验的不要留到最后"的判断，比多写一条测试更省时间。

**如果换一台设备，这个实验要重做**：`/data/local/tmp` 的 execute 权限因 Android 版本与
厂商 ROM 而异，公开资料的三种说法互相矛盾（见下表），不能按文档假设。

| 说法 | 来源 | 实际含义 |
|---|---|---|
| `adb push` + `chmod 755` 就能跑 | 多个 StackOverflow 答案 | Android 7–9 时代普遍成立 |
| Android 10+ enforcement 后直接 `Permission denied`，要 `chcon u:object_r:shell_exec:s0` | 一篇 2024 年的 Frida 排查文 | `chcon` **需要 root** |
| Android 11+ 应用不能列这个目录，但**给全路径仍可执行** | StackExchange 高票答案 | 区分"shell 执行"与"app 执行" |

三种结果对应三种后续（本机落在第一条）：

- 能跑 → **spike ① 的判定标准（"8000 端口应答、首页可取"）当场达成**，
  APK 那条链可以延后到 T15.3（真正要交付 APK 时再建）；
- `Permission denied` 且非 root → 走路径 B（APK 的 jniLibs 反而绕开这个 SELinux 问题）；
- 报别的错（比如 `Exec format error`）→ 那是产物本身的问题，回看 §4.1 的判据。

#### 路径 B：打一个最小 APK（最终形态必须，但可以晚做）

把 `libnode.so` 放进 `jniLibs/arm64-v8a/` + `extractNativeLibs=true`，
安装后从 `/data/app/.../lib/arm64/libnode.so` 执行。

这才验证**真实部署路径**（W^X 下的正确形态），也是 T15.3 的必经之路。
成本见 §2.2。

> 两条路径不是替代关系：A 是"快速验证核心不确定性（node 到底能不能在 Android 上工作）"，
> B 是"验证产品形态"。A 失败了不代表 B 会失败 —— 恰恰相反，如果 A 被 SELinux 拦住，
> B 因为走只读的 native lib 目录，很可能反而成功。所以**先 A 后 B**，不要一上来就建 4 GB 的 SDK。

#### 无线 vs 有线：建议**先有线**

| 通道 | 要求 | 优点 | 缺点 |
|---|---|---|---|
| 有线 USB | 数据线 + Windows 驱动（大厂一般免驱） | 快、稳；push 几百 MB 几分钟 | 要插线 |
| 无线 `adb pair` | **Android 11+** 的「无线调试」+ 同 Wi-Fi；首次要 6 位配对码 | 不用线 | 慢；push 412 MB 的 ST 可能十几分钟；Wi-Fi 抖会断 |

选择有线的实际理由不是"方便"，是**第一次要传约 480 MB**（node 60 MB + ST 412 MB）。
无线在这体量下会慢到让人以为卡住，而断线重传更费时间。等内容跑通、只做小改动时再用无线。

#### 实施前需要从设备上读到的三件事（决定方案能否成立）

```bash
adb shell getprop ro.product.cpu.abilist        # 必须含 arm64-v8a
adb shell getprop ro.build.version.release      # 决定能否无线调试（≥11）、W^X 行为
adb shell df -h /data                            # 要有 ≥1 GB 余量（ST 解开要 412 MB）
```

如果 `abilist` 里没有 `arm64-v8a`（老设备或极低端机），整个 arm64 单架构决策（#265）就不成立。

#### 本机侧必须先做的一件事

本机 adb 是 **1.0.31（2013 年）**，与任何 Android 10+ 设备的 adbd 都可能握手失败。
必须换 platform-tools（实测下载 8 MB，最新 `r37.0.1`，`dl.google.com` 可达 200）。

注意不要覆盖 `PhoenixSuit` 目录里那个 —— 它是刷机工具的依赖。应放到独立目录并前置到 PATH。

### 2.2 路径 B 的成本清单（打 APK 要什么）

Tauri 2 Android 的官方前置（已核实原文）：JDK（`JAVA_HOME`）· Android SDK Platform /
Platform-Tools / Build-Tools / Command-line Tools / NDK；`ANDROID_HOME` + `NDK_HOME`；
Rust target `aarch64-linux-android`。

| 项 | 状态 | 工作量 |
|---|---|---|
| NDK | ✅ 已有 r26d（VM 上） | — |
| platform-tools（adb） | ❌ 本机 1.0.31 太旧 | **8 MB 下载**，与路径 A 共用 |
| JDK 17 | ❌ 缺 | `sudo apt install`，约 300 MB |
| Android SDK cmdline-tools + platform-34 + build-tools | ❌ 缺 | 约 2–3 GB 下载 |
| Rust + `aarch64-linux-android` target | ❌ 缺 | rustup 约 500 MB |
| sudo | ❌ **无 passwordless sudo** | **需要你输一次密码** |

**总下载约 3–4 GB，且必须你配合 sudo。** 这正是"先走路径 A"的理由 ——
如果 A 能跑通，这 3–4 GB 可以推迟到 T15.3 真正要出 APK 时再花。

### 2.3 【体积偏差】APK 到不了需求文档写的「~100MB 级」

实测（`tar | gzip -6`，与 APK 的 deflate 同级别）：

```text
SillyTavern 目录  412 MB  →  压缩后 148.4 MB
其中 node_modules  319 MB
```

再加上 node 二进制（40–60 MB，压缩后约 20–25 MB），**APK 预计 170–200 MB**，
而不是需求文档 §三写的「~100MB 级」。

尝试过裁剪，但**最大两个包裁不掉**：

| 包 | 体积 | 能否裁 |
|---|---|---|
| `onnxruntime-web` | 66 MB | ❌ |
| `sillytavern-transformers` | 53 MB | ❌ |

原因：`src/transformers.js` 是**顶层 import**，被 `endpoints/caption.js`、`classify.js`、
`speech.js` **顶层**引用，而这些 router 在 `server-startup.js` 里启动即挂载。
删包会让 ST 起不来。要裁只能改 ST 源码 —— 但版本是钉死的（决策 #260），改了就不是原版。

> 顺带一个正面信号：`src/transformers.js:15` 有一行注释
> `Limit the number of threads to 1 to avoid issues on Android` ——
> ST 官方自己考虑过 Android，WASM 路径不是我们硬凑的。

**这条需要用户重新定盘子**：接受 ~180 MB，还是接受"裁功能"（去掉 caption/classify/speech
相关能力，需要改 ST 源码 + 自己维护补丁），还是分架构/分资源下载。

---

## 3. 已入库的产物

| 文件 | 作用 | 状态 |
|---|---|---|
| `vendor/node-android/build-node-android.sh` | 在 Linux（VM）里跑：下源码 → `android-configure` → 配置自检 → `make -j` → 产出 `libnode.so` | **configure 阶段已实测通过**（VM，arm64/x64/android 三值正确）；make 未执行 |
| `vendor/node-android/README.md` | 环境准备、命令、产物校验判据、APK 打包要点 | 同上 |
| `docs/spike-01-node-android.md` | 本文 | — |

> **诚实标注**：脚本的 configure 阶段已在 VM 上实测通过（`config.gypi` 三个值全对），
> 但 **`make` 从未跑过**，产物 `libnode.so` 尚不存在。文件头的 `UNVERIFIED` 标记
> 保留，直到产物出来并在设备上跑通。

---

## 4. 执行进度与剧本（每一步都有判据）

### 4.0 状态：**产物已出，卡在手机不在线**（2026-10-29 15:30 更正）

> 本节原本写"正在编译"，已过时。实际：编译在 **2026-10-29 01:29 完成**，
> 产出 `out/Release/node` 73.7 MB，三条静态判据全过（见文件头状态表）。
> 下面这段编译过程的账保留 —— 它记的是**期间踩到的坑**，仍有价值。
> 当前唯一阻塞：`adb devices` 为空（vivo V2507A 不在线），
> 而 spike ① 的最终判据（ST 跑起 + 8000 应答）必须在真机上做。

用户 2026-10-28 放行 spike ①，接受上轮全部评估结论，并拍板三件事
（决策 #275 体积基线、#277 达标判据、#278 路径 A 先试）：

```text
体积     全量打包，接受 170–200 MB（#275）；裁剪补丁记 v1.x 候选，本版不动手
判据     真机 adb + 8000 应答 + 首页可取，不要求 App 沙箱（#277）
路线     先 /data/local/tmp 直跑（8 MB），被 SELinux 拦再转 APK（#278）
```

编译过程与两次中断的完整账：

| 时间 | 事件 | 状态 |
|---|---|---|
| 14:38 前 | `-j2` 跑到 2983 个 `.o` | 坑⑤⑥ 已修，V8 target 阶段 |
| — | **VM 整机失联**（ssh 超时 ×3，ping 中途报"无法访问目标主机"） | 用户关掉其他定时任务后恢复 |
| 恢复后 | 发现进程仍在（`setsid nohup` 起了作用），零错误 | 3000 个 `.o` 没白跑 |
| 14:38 | 判定 `-j2` 在 4 核上浪费一半（§0.4），`SIGTERM` 停 + 删 21 个可能截断的 `.o` | — |
| 14:38 | `RESUME=1` 以 **`-j4`** 续跑（新公式生效，跳过 configure） | ✅ 配置自检通过 |

### 4.1 第一步：编出产物（只需 VM）

```text
A) 当前正在跑：
   RESUME=1 ANDROID_NDK_ROOT=$HOME/android-ndk-r26d \
     setsid nohup bash ~/tcs-build/build-node-android.sh 20.18.0 > build.log 2>&1 &
   （用 setsid + 远端 launcher 脚本，否则后台进程继承 SSH channel 的 fd，
     表现为 exec_command 挂到超时）
   ✅ 判据：out/Release/node 存在
   ✅ 判据：file 输出含 "ARM aarch64"     ← 唯一可信的架构判据
   ✅ 判据：体积 40–60 MB（< 30 MB = 链接失败或被 strip 过头）
   ⚠️ OOM 时降到 JOBS=1（12 GB swap 兜底，慢但能过）
   📋 监控：.verify/ssh/vmstat.sh（VM 侧一键状态）、
           .verify/ssh/monitor.sh（本地每 5 分钟采样，出错或出产物即停）
```

### 4.2 第二步：路径 A（只需 8 MB 的 platform-tools + 你的手机）

> **状态：2026-10-28 已全部完成**（手机 vivo V2507A 已连，三个属性全绿，
> tmp 内 exec 实验通过 ⇒ 路径 A 成立，见 §2.1）。
>
> 给用户照做的逐步清单在 `docs/spike-01-手机侧动作清单.md` —— **本地文档，不入库**
> （它含设备序列号，且执行完即过期）。换设备时照它重做一遍；
> 本节的判据与 §2.1 的实验方法才是要长期保留的部分。
>
> 本机 platform-tools 已装在 `.verify/platform-tools/`（r37.0.1，8 MB），
> **没有覆盖 `D:\PhoenixSuit\PhoenixSuitdb.exe`（1.0.31）** —— 覆盖它会让刷机
> 工具在下次刷机时静默失效，而那时没人会联想到是装 adb 装的。
> 用法：`export PATH="$PWD/.verify/platform-tools/platform-tools:$PATH"`。
>
> 另一个跨平台坑：Git Bash 会把传给 adb 的 `/data` 转成 `C:/Users/...`，
> 表现为 `df: 'C:/Users/PC/.../data': No such file or directory`。
> 必须先 `export MSYS_NO_PATHCONV=1`，或写成 `adb shell "df -h /data"`（整条加引号）。

```text
B) 本机装 platform-tools r37（独立目录，不覆盖 PhoenixSuit 那个）
C) 有线连手机，读三件事：
   adb shell getprop ro.product.cpu.abilist    → 必须含 arm64-v8a
   adb shell getprop ro.build.version.release  → 决定能否无线调试、W^X 行为
   adb shell df -h /data                        → ≥1 GB 余量
D) push 并直接跑：
   adb push libnode.so /data/local/tmp/
   adb shell chmod 755 /data/local/tmp/libnode.so
   adb shell /data/local/tmp/libnode.so -e "console.log(process.version, process.arch)"
   ✅ 判据：打印 v20.x 且 arch=arm64
   ⚠️ 若 Permission denied（SELinux），先 `adb shell id -Z` 看上下文，
      再试 `chcon`（需 root）；不通就转 4.3 的路径 B，不要卡在这
E) 跑通后 push ST 1.19（412 MB，有线几分钟），按 §1.4 参数启动
   ✅ 判据：GET http://127.0.0.1:8000/version 返回 1.19.0
   ✅ 判据：首页 HTML 含 SillyTavern 标记
   ✅ 判据：`adb shell netstat -tln | grep 8000` 只有 127.0.0.1，没有 0.0.0.0
   ⚠️ 手机上调 netstat 可能没有该命令，退化用 `cat /proc/net/tcp` 查端口绑定地址
F) 截图 + adb 输出存档到 assets/（spike 证据）
```

> **D 是整条 spike 的关键分岔**：它一旦通过，`spike ①` 的判定标准
> （"Android 环境实测、8000 应答、首页可取"）就达成了，APK 那条链可以推到 T15.3。
> 它若被 SELinux 拦住，说明必须走 APK —— 但那不是"spike 失败"，
> 因为 APK 的 native lib 目录恰好绕开了这个限制。

### 4.3 第三步：路径 B（最终形态，需要 sudo + 3–4 GB）

```text
G) 你输一次 sudo：装 JDK 17 + Android SDK cmdline-tools/platform-34/build-tools
H) VM 上装 Rust + rustup target add aarch64-linux-android
I) TCS 仓库跑 tauri android init（生成 client/src-tauri/gen/android）
J) 做最小验证 APK：只含 libnode.so + 一个 index.js
   ✅ 判据：adb shell 看到 node 版本号
   ✅ 判据：该二进制位于 /data/app/.../lib/arm64/ 而非 filesDir
K) 故意放 filesDir 跑一次作为反向验证
   ⚠️ 预期失败（W^X，error=13）—— 若不失败说明 targetSdk 被降到 28，
      会埋"未来被系统拦"的雷
```

---

## 5. 需要登记进决策表的内容

| 决策 | 取值 | 理由 |
|---|---|---|
| ST 版本策略 | 钉死 1.19.0，随 TCS 发版跟进 | 适配器契约按 1.19 写；ST 自行升级会静默破契约 |
| Node 运行时 | 自编译 20.x for Android arm64（NDK r26d） | 需求文档指定；代价是每次升 Node 要重新趟构建 |
| 打包方式 | 全量打包（node + ST 进 APK），不做按需下载 | 首启二次下载是流失点 |
| node 落地形式 | `libnode.so` 进 `jniLibs/arm64-v8a/` + `extractNativeLibs=true` | W^X 唯一可行路径（§1.2） |
| 架构 | arm64 单架构 | 已拍板；体积与维护成本 |
| 进程生命周期 | 自管（前台服务 + 显式 kill + 孤儿清理） | exec 出来的进程不受 Android 生命周期管理（§1.2 引文） |
| 构建宿主 | **VM（Ubuntu 22.04 @ 192.168.1.201）**，不用 WSL2/云构建 | 用户已有；不改安全策略；官方假设环境；且 VM 上有 Docker（T15.4 契约测试可复用） |
| 并行度 | `-j2`（按核数与内存取小，不硬编码） | 2 vCPU / 3.8 GB；-j4 只会加重 swap 压力 |

---

## 6. 没做到的（直说）

1. **spike ① 仍未通过**：`make` 一次都没跑，`libnode.so` 不存在，
   没有任何 Android 环境实测。按判定标准这不算过。
   （设备阻塞已由用户解除，但实施要等用户发令 —— 这是"暂时没做"，不是"做不了"。）
2. **配置阶段是真的验过了**：`config.gypi` 的 `target_arch=arm64 / host_arch=x64 /
   OS=android` 是实测输出。上一版脚本里的四个缺陷都是这一步暴露的 ——
   如果直接跑 make，每一个都会浪费一小时。
3. **路径 A 能否成立未验证**：`adb shell` 直接跑 `/data/local/tmp` 里的二进制，
   受 SELinux 上下文影响，**不同 Android 版本与 ROM 行为不同**（§2.1 列了三种互相矛盾的
   公开说法）。这是本轮最重要的未知项，一次 `adb shell` 就能定论，但在拿到设备前只能
   标为"待实测"。
4. **编译时长只是估算**：按 71 KB / 4.29 秒基准外推 90–150 分钟，未实跑。
   V8 的大 TU 比基准文件重得多，误差可能很大。
5. **内存峰值只有单文件数据**：实测 137 MB（基准文件）。V8 大文件可能 1–2 GB，
   2 核 + 3.8 GB 下 `-j2` 有 OOM 风险，靠 12 GB swap 兜底 —— 会慢，但应该能过。未在真实 make 中验证。
6. **APK 体积超过需求文档预期**（170–200 MB vs ~100 MB），主要占用者裁不掉（§2.3）。
   这是需要重新定盘子的偏差，不是靠优化能绕过的。
7. **手机侧的一切都未测**：设备型号、Android 版本、ABI、存储余量、SELinux 状态、
   厂商 ROM 的后台策略，全都还不知道。这些直接决定 2.1 的路径选择。
8. **没有 Android 设备时我做的两个推断已作废**：之前写"必须真机、模拟器不行"，
   方向是对的；但"路径 A 可能绕开 APK"这条当时没想到 —— 因为它要求先想清楚
   W^X 限制的是"应用的私有可写目录"，而不是"shell 用户的临时目录"。
   修正后门槛低了一个数量级（8 MB vs 3–4 GB）。

---

## 7. 最终验证实录（2026-10-29 15:39–15:55，真机）

> 证据包：`.verify/spike-final/`（每条命令与原始输出）
> 设备：`10AFBX1QSK0073C` / vivo V2507A / Android 16 (SDK 36) / arm64-v8a

### 7.0 连机与预检（防换机）

| 项 | 本轮实测 | 上轮记录 | 一致 |
|---|---|---|---|
| `ro.product.cpu.abilist` | `arm64-v8a` | `arm64-v8a` | ✅ |
| `ro.build.version.release` / `sdk` | `16` / `36` | `16` / `36` | ✅ |
| `/data` 可用 | 203 G | 204 G | ✅（正常波动） |
| `/data/local/tmp` 上下文 | `u:object_r:shell_data_file:s0` | 同 | ✅ |
| `getenforce` | `Enforcing` | 同 | ✅ |

### 7.1 第 1 步：node 本体（先小后大）

```text
$ adb push .verify/node-arm64 /data/local/tmp/libnode.so
1 file pushed, 73.9 MB/s (77238720 bytes in 0.997s)      ← USB，1 秒

$ adb shell "chmod 755 /data/local/tmp/libnode.so"
-rwxr-xr-x 1 shell shell 77238720 libnode.so

$ adb shell "/data/local/tmp/libnode.so -e 'console.log(process.version, process.arch, process.platform)'"
v20.18.0 arm64 android
```

**⭐ version 实测值：`v20.18.0`**（需求写的是「Node 20+」，符合；不是 22）。

三项判据同时成立 ⇒ 这个二进制**确实是为 Android/arm64 编的**，
不是"在别处能跑所以糊过去"。

### 7.2 第 2 步：ST 1.19 全量（四判据）

```text
$ adb push .verify/st-1.19.tar.gz /data/local/tmp/      → 155,628,146 B / 5.6 s / 26.5 MB/s
$ adb shell "tar -xzf ... -C /data/local/tmp/st"         → 8 s，437 MB，449 个依赖包
$ adb shell "cd /data/local/tmp/st && setsid nohup ./libnode.so server.js \
    --port=8000 --dataRoot=/data/local/tmp/st-data --browserLaunchEnabled=false > st.log 2>&1 &"
```

| # | 判据 | 实测 | 结果 |
|---|---|---|---|
| a | `GET /version` → 1.19.0 | `{"pkgVersion":"1.19.0","agent":"SillyTavern:1.19.0:Cohee#1207",...}` | ✅ |
| b | 首页可取 + 含 SillyTavern 标记 | HTTP 200，**734,837 字节**（与 VM 侧参考值一字不差），含 `SillyTavern` | ✅ |
| c | 只听回环 | `tcp 0 0 127.0.0.1:8000 0.0.0.0:* LISTEN`，**无 0.0.0.0** | ✅ |
| d | 日志无 error 级 | 193 行，`error/SEVERE/uncaught/fatal` 计数 **0**；含 `SillyTavern is listening on IPv4: 127.0.0.1:8000` | ✅ |

**四判据全过 ⇒ spike ① 通过。**

### 7.3 第 3 步：喂给 T15.3 的两组数据

**内存**（静止，连续三次）：

```text
PID    RSS      VSZ        NAME
11756  156092   36688560   libnode.so   ×3（完全一致）
→ RSS ≈ 152.4 MB，VSZ ≈ 35.0 GB（V8 虚拟地址保留，非实际占用）

> **Node 22.23.4 续验（2026-10-30）**：同机同流程复测，四判据全过。
> `node --version` → `v22.23.4`；`process.arch/platform` → `arm64 / android`；
> `SillyTavern is listening on IPv4: 127.0.0.1:8000`；首页 **HTTP 200 / 734,837 字节**，
> `/version` → `{"pkgVersion":"1.19.0"}`。
> **RSS ≈ 186.5 MB**（比 20.18 多 34 MB，与 V8 12 增量一致）。
>
> ⚠️ **必须传 `--browserLaunchEnabled=false`**：否则 ST 监听成功后调 `open()` 打开浏览器，
> Android 无 `xdg-open` ⇒ `spawn ENOENT` ⇒ 未捕获异常杀死进程。
> 现象是"日志说 listening 成功，进程紧接着没了"，极易误判成 ST 跑不起来。
> A/B 对照已做（不带必死、带了存活），详见 `t15.3-apk-design.md` §5.5。
```

**后台存活**（灭屏 122 秒后）：

```text
ps:      11756 libnode.so                    ← 进程活着
netstat: 127.0.0.1:8000 LISTEN               ← 端口仍监听
```

> ⚠️ **踩到一个坑**：灭屏再亮屏后 `curl` 立刻失败
> （`upstream connect failed: 目标计算机积极拒绝`），看着像"ST 死了"。
> 实际是 **`adb forward` 隧道在息屏/亮屏后失效** —— 重建 forward 后立刻正常。
> 判据不能只看 curl，要看**设备侧**的 `ps` + `netstat`：那两个才是 ST 的生死。

**对 T15.3 的直接输入**：
- 进程要 ~152 MB RSS 常驻，加上 ST 的 437 MB 磁盘 —— 前台服务通知必须显示这个量级的占用预期；
- **无前台服务时靠 setsid 也能活过 2 分钟灭屏**，但 Doze 长时压制下的行为未测（这正是 T15.3 要解决的事）；
- `--dataRoot` 必须指向应用私有目录（本次用的 `/data/local/tmp/st-data` 只是测试位），
  正式形态下是 `filesDir`，否则用户数据落在 tmp 里随时可能被清。

### 7.4 清理（已执行并确认）

```text
kill 11756 → 进程已退出
rm -rf /data/local/tmp/{st,st-data,libnode.so,st-1.19.tar.gz,st.log}
→ tmp 总量 480 MB+ → 7.0 MB
→ 残留仅用户自己的 .studio / brevent / brevent.sh（未动）
```

红线遵守：全程只写 `/data/local/tmp`，未安装任何应用，未触碰用户数据。
