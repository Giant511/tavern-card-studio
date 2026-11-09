# Node for Android（自编译，arm64）

给「口袋酒馆」用的 Node 20.x 运行时。**不是** npm 包，是本项目自己交叉编译的产物。

> ⚠️ 目录里的脚本标了 `UNVERIFIED`：按官方 `BUILDING.md` 写成，尚未在真实宿主跑通。
> 环境要求与阻塞原因见 `docs/spike-01-node-android.md`。

## 为什么不用现成的

| 方案 | 为什么不用 |
|---|---|
| 官方 Node 二进制 | 官方不发 Android 目标（`BUILDING.md`：*Android is not a supported platform*） |
| Termux 的 node 包 | 依赖 Termux 的 PATH 与 prefix 约定，且其二进制为 Termux targetSdk 28 服务；与本项目 targetSdk 34 的 W^X 约束不兼容 |
| `nodejs-mobile` | 是**静态库**形态（嵌进 app 进程），不是可执行文件；本项目需要子进程 + 重启能力 |

## 用法

```bash
ANDROID_NDK_ROOT=/opt/android-ndk-r27c ./build-node-android.sh 20.18.0
# 产物：work/out/libnode.so（ELF aarch64）
```

## 产物怎么进 APK（关键，别搞错）

Android 10+ 禁止对**可写目录**里的文件 `execve()`（W^X）。所以：

```
❌ filesDir/node            → exec 报 error=13 Permission denied
❌ assets 里解压到 filesDir  → 同上
✅ jniLibs/arm64-v8a/libnode.so + android:extractNativeLibs="true"
   → 安装时解到 /data/app/.../lib/arm64/libnode.so（只读），可以 exec
```

文件名必须符合 `lib*.so` 格式，否则打包工具会当成普通 .so 处理或直接丢弃。

## 校验判据（每次升级 Node 都跑一遍）

```bash
file libnode.so | grep -qi aarch64        # 架构对
stat -c %s libnode.so                     # 40–60 MB，太小说明链接失败
adb shell "libnode.so -e 'console.log(process.version)'"   # 能打印版本
```

最后一条必须在**设备上**跑，不能在宿主机上跑 —— 宿主机能跑说明编的是宿主架构，不是 Android。
