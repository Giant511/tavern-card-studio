# Node for Android arm64 —— 已编译产物

> 由 `vendor/node-android/build-node-android.sh` 产出。
> **本目录的 `*.so` 不进 git**（见下方「为什么不入库」），只有本清单受版本控制。

## 现有产物

| 文件 | Node | 体积 | sha256 |
|---|---|---|---|
| `libnode-arm64-22.23.4.so` | **22.23.4**（当前基线） | 99,498,384 B / 94.9 MiB | `2e28403b8c84b14a637d811fcf706c04fd3437d3b0b09c3cdd778ec2cdea80ae` |
| `libnode-arm64-20.18.0.so` | 20.18.0（**回退基线**） | 77,238,720 B / 73.7 MiB | `f94b57fecdf90709068616269647624ca67be1df3114dd00364651b6f581b3a2` |

两份都是 `ELF 64-bit LSB executable, ARM aarch64`（`e_machine=0xb7`, `type=3` 可执行）。

## 22.23.4 的验证结论（2026-10-30 实测）

在 vivo V2507A / Android 16 / `arm64-v8a` 上按 spike ① 流程完整跑过 ST 1.19.0，
**四判据全过**：

| # | 判据 | 实测 |
|---|---|---|
| ① | `/version` 返回 1.19.0 | `{"pkgVersion":"1.19.0","agent":"SillyTavern:1.19.0:Cohee#1207"}` |
| ② | 首页字节数 | **734,837 B**（与 spike ① 记录值一字不差） |
| ③ | 只听回环 | `127.0.0.1:8000`，无 `0.0.0.0` |
| ④ | 日志零 error | 无 `error/SEVERE/uncaught/fatal` |

另跑八项能力检查（V8 `12.4.254.21-node.57`、七个内置模块、sha256、
`execSync` 真跑子进程、`net.listen(0,'127.0.0.1')`、空载 RSS 82.2 MB）全过。
跑 ST 时 RSS **186.5 MB**（20.18 是 152.4 MB）。

⚠ **一个必须传的参数**：`--browserLaunchEnabled=false`。不传的话 ST 监听成功后
会调 `open()` 拉浏览器，Android 没有 `xdg-open` ⇒ `spawn ENOENT` **未捕获**，
直接把 Node 进程杀掉。详见 `docs/t15.3-apk-design.md` §5.5。

## 为什么不入库（重要，别改成 commit）

两份加起来 168 MB。往 git 里提交一次，**git 历史就永久变大**，
日后想移除也只是"在新提交里删掉"，`.git` 里的对象还在 —— 等于做了个不可逆的决定。

而这两份产物的性质是**可重建的构建中间物**（17.6 小时 + 脚本已固化），
不是源码。所以：

- `vendor/node-android/bin/*.so` 已被 `.gitignore` 排除；
- 本清单（含 sha256）受版本控制，用来核对"手上的文件是不是那一份"；
- 需要产物时：有备份直接拷回，没有就跑 `build-node-android.sh`。

如果日后确认要入库（比如需要别人也能直接打 APK），再决定是否上 Git LFS ——
那时是一次明确的、有意识的迁移，而不是顺手 `git add` 一个 95 MB 的文件。

## 校验手上的文件

```bash
sha256sum vendor/node-android/bin/*.so
```

对照上表。也可用脚本内置的自检（`build-node-android.sh` 产物段会验 `e_machine`）。

## 为什么保留 20.18

回退基线。22 的四判据虽然过了，但**Android 端到端（APK 里真跑）还没验** ——
一旦最小验证 APK 在 22 上不通，要能立刻换回 20.18 而不必等 17.6 小时重编。
