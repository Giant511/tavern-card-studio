# 第三方组件声明（Third-Party Notices）

本文件列出 Tavern Card Studio 在构建与分发中使用的第三方组件、各自的许可协议，
以及随分发物一并提供的许可全文。

对应许可全文位于 [`LICENSES/`](LICENSES/)；完整的依赖清单见
[`THIRD-PARTY-NOTICES-APPENDIX.md`](THIRD-PARTY-NOTICES-APPENDIX.md)。

---

## 0. 先读这一节：本项目有两种分发物，义务不同

这很重要，因为**两者的许可义务完全不同**，混在一起谈会得出错误结论。

| 分发物 | 包含什么 | 第三方许可的实际义务 |
|---|---|---|
| **源码仓库**（GitHub） | 只有本项目自己的代码 | 仅需保留依赖的许可声明（本文件即为此而设） |
| **安卓 APK** | 本项目代码 + **SillyTavern 1.19.0 完整源码**（`assets/st.zip`，21,034 个文件） | **含 AGPL-3.0 组件，服从 AGPL 的相应义务**（见 §1） |
| **桌面端 MSI** | 本项目代码 + Node.js 运行时 + 依赖树 | 仅需保留 MIT / Apache-2.0 等的版权与许可声明 |
| **服务端 MSI** | 同上 | 同上 |

也就是说：**仓库是 MIT；但安卓 APK 内含 AGPL-3.0 组件。**

### 关于 APK 的合规立场

我们对 AGPL 的处理是按"提供对应源码 + 明确声明"来做的：

```text
① 未修改 SillyTavern **源码** —— 原样分发（AGPL-3.0 §4 允许 verbatim distribution）
   · 无补丁、无裁剪、无二次修改（`scripts/pack-st-assets.mjs` 只做打包与排除用户数据）
   · `st.zip` 内每个文件都能与上游 1.19.0 逐字节对上
② 对应源码：上游 tag v1.19.0 公开可取，另外每个 Release 都附源码 zip
   https://github.com/SillyTavern/SillyTavern/tree/1.19.0
③ AGPL-3.0 全文随本仓库与安装包分发：LICENSES/AGPL-3.0.txt
④ 运行方式为**独立进程**：ST 在自己的 Node VM 里跑 `server.js`，
   本应用通过其自身的 HTTP API（`/api/chats/get` 等）通信，
   不静态链接、不共享内部数据结构
⑤ **有一处运行时注入，已主动披露**（§1.1「运行时日志钩子」）：
   `NODE_OPTIONS=--require tcs-log-hook.cjs` 在我们写的日志钩子，
   不修改 ST 源码、不改变其业务行为
```

**⑤ 是本项目最需要留意的一条**：它不改变"源码未修改"这个事实，但确实是
"我们的代码在 ST 进程内运行"。我们按聚合（`§5` 末段）处理，并把事实写在
明面上 —— 不披露才是实质风险，披露之后是可以逐条核对的。

如果有人（包括我们自己）将来**修改**了 SillyTavern 的源码，必须把修改后的源码一并公开，
这是 AGPL-3.0 §5/§6 的要求，不能只留一个上游链接。
**这条纪律写成了判据**：`test/third-party-notices.test.mjs` 会检查
`assets/st.zip`（若存在）内每个关键文件的版本与声明一致。

---

## 1. 直接嵌入分发物的组件

这些不是"引用了一个库"，而是**内容原样进了分发物**，必须逐条声明。

### 1.1 SillyTavern 1.19.0 —— AGPL-3.0

| 项 | 内容 |
|---|---|
| 组件 | SillyTavern（安卓端内置聊天引擎） |
| 版本 | 1.19.0 |
| 许可 | **GNU Affero General Public License v3.0**（[全文](LICENSES/AGPL-3.0.txt)） |
| 版权 | Copyright (C) SillyTavern contributors |
| 上游 | https://github.com/SillyTavern/SillyTavern |
| 对应源码 | https://github.com/SillyTavern/SillyTavern/tree/1.19.0 |
| 出现位置 | 安卓 APK：`assets/st.zip`（解包至应用私有目录后运行） |
| 是否修改源码 | **否**（`st.zip` 内每一个文件都与上游 1.19.0 逐字节相同；仅排除了 `data/`、`.git/`、`tests/`、`backups/`、`doc/`） |
| 运行时是否有外部代码注入 | **有，一处**：见下方「运行时日志钩子」 |

> `data/` 被排除是有意的：那里面是**用户自己的**聊天记录与角色，既不应进别人的
> 安装包，也让"首启是干净环境"这个前提成立。

#### 运行时日志钩子（主动披露）

安卓端启动引擎时，通过 Node 官方的 `--require` 扩展点加载一个**我们写的**
日志钩子（`assets/tcs-log-hook.cjs`，168 行，以 MIT 公开在本仓库）：

```text
启动命令：libnode.so server.js --dataRoot=… --port=… --browserLaunchEnabled=false
环境变量：NODE_OPTIONS="--no-warnings --require <filesDir>/st/tcs-log-hook.cjs"
```

| 项 | 内容 |
|---|---|
| 文件名 | `tcs-log-hook.cjs`（**新增文件，不替换任何 ST 文件**） |
| 位置 | 运行时复制到引擎目录，与 `server.js` 同级 |
| 它做什么 | 重写 `console.error` / `console.warn` 写入我们自己的日志文件；挂 `uncaughtException` / `unhandledRejection` / `exit` 钩子记录崩溃原因 |
| 它不做什么 | **不读改写任何 ST 源文件；不改变 ST 的业务逻辑、网络行为或输出内容** |
| 为什么需要 | 安卓版 Node 把 stdout/stderr 直接写 logcat，`ProcessBuilder` 的管道拿不到内容（实测文件被创建但 0 字节）；`--require` 是唯一能接住启动期异常的入口 |

**为什么要把这条写出来**：这是本项目唯一一处"我们的代码在 ST 进程内运行"的地方。
不披露会让"未修改、原样分发"这句话显得含糊；披露之后性质是清楚的——
ST 的**源码**一字未改，注入的是一份独立的、可单独审查的日志工具。
该钩子的源码本身也以 MIT 随本仓库公开，任何人都可以核对它做了什么。

> 若你据此认为这不属于"聚合"而是"形成更大程序"，请以 AGPL-3.0 对待整个 APK。
> 我们的立场是它构成聚合（`§5` 末段），理由见 [§0](#0-先读这一节本项目有两种分发物义务不同)。

### 1.2 Node.js

| 项 | 内容 |
|---|---|
| 版本 | 22.22.2（桌面/服务端） · 20.18.0（安卓 libnode） |
| 许可 | MIT（[全文](LICENSES/MIT.txt)） |
| 版权 | Copyright Node.js contributors. All rights reserved. |
| 上游 | https://github.com/nodejs/node |
| 出现位置 | 服务端 MSI：`node.exe`；安卓 APK：`libnode-arm64-20.18.0.so` |

### 1.3 libc++（LLVM）

| 项 | 内容 |
|---|---|
| 许可 | Apache-2.0 WITH LLVM-exception（[Apache-2.0](LICENSES/Apache-2.0.txt) · [例外条款](LICENSES/LLVM-exception.txt)） |
| 版权 | Copyright (C) LLVM Project |
| 上游 | https://github.com/llvm/llvm-project |
| 出现位置 | 安卓 APK：`libc++_shared-arm64.so` |

### 1.4 WinSW 2.12.0

| 项 | 内容 |
|---|---|
| 许可 | MIT（[全文](LICENSES/MIT.txt)） |
| 版权 | Copyright (C) WinSW contributors |
| 上游 | https://github.com/winsw/winsw |
| 出现位置 | 服务端 MSI：`WinSW.NET4.exe` |
| 是否修改 | 否，仅重命名为 `tcs-service-host.exe` |

---

## 2. 构建期工具（不随产品分发）

| 组件 | 许可 | 用途 | 为何不触发义务 |
|---|---|---|---|
| WiX Toolset UI 扩展 5.0.2 | MS-RL（[全文](LICENSES/MS-RL.txt)） | 编译 MSI 时被 WiX 加载，生成安装向导界面 | 只在构建机上运行，**不进入 MSI 产物** |
| Rust 工具链 / cargo | MIT OR Apache-2.0 | 编译 `src-tauri` | 编译器不产生产物内的衍生代码 |
| Vite / esbuild / TypeScript | MIT / Apache-2.0 | 打包前端 | 同上 |

---

## 3. 依赖树里的弱 copyleft（需要说明，但不需要改协议）

### 3.1 MPL-2.0 × 5（Rust）

| crate | 版本 | 来源 |
|---|---|---|
| `cssparser` | 0.37.0 | https://github.com/servo/rust-cssparser |
| `cssparser-macros` | 0.7.1 | https://github.com/servo/rust-cssparser |
| `selectors` | 0.38.0 | https://github.com/servo/stylo |
| `dtoa-short` | 0.3.5 | https://github.com/upsuper/dtoa-short |
| `option-ext` | 0.2.0 | https://github.com/soc/option-ext |

许可全文：[MPL-2.0.txt](LICENSES/MPL-2.0.txt)

由 Tauri 引入（这些是 Servo 的 CSS 解析器，用于 WebView 的样式计算）。

**为什么不需要改本项目协议**：MPL-2.0 是**文件级** copyleft —— 它的边界是
"MPL 覆盖的那些**文件**"，而不是"链接进同一个程序的全部代码"。
我们**未修改这些 crate 的源码**，只是把它们当依赖使用，因此构成 MPL-2.0 §3.3
所说的 "Larger Work"，可以整体以其他条款（这里是 MIT）发布。

义务只有两条，均已满足：
1. 保留其许可声明与源码位置 —— 本文件即为此；
2. 若修改了这些文件，修改后的文件须继续以 MPL-2.0 提供 —— 本项目未修改。

### 3.2 LGPL-2.1-or-later（双授权，可选宽松）

`r-efi` 5.3.0 / 6.0.0 的声明是 `MIT OR Apache-2.0 OR LGPL-2.1-or-later`。
**三重授权意味着可以任选一支**：本项目按 MIT 使用，因此不触发 LGPL 的任何义务。

---

## 4. 依赖清单汇总

完整清单（每个包的名字、版本、许可）见
[`THIRD-PARTY-NOTICES-APPENDIX.md`](THIRD-PARTY-NOTICES-APPENDIX.md)。

| 范围 | 组件数 | 许可分布 |
|---|---|---|
| Node 开发依赖 | 175 | MIT 为主，见附录 A |
| **Node 随 MSI 分发** | 99 | MIT 80 · ISC 6 · Apache-2.0 5 · BSD-3-Clause 2 · 0BSD 1 · 其它组合 5 |
| Rust crate | 497 | MIT/Apache-2.0 双授权为主，见附录 C |
| Android（Gradle） | 5 | Apache-2.0 |

**没有 GPL-3.0 或 AGPL-3.0 出现在任何依赖树中** —— 唯一的 AGPL 组件是 §1.1 的
SillyTavern，它是有意内置的，不是被依赖树带进来的。

### 4.1 Android 依赖

| 组件 | 版本 | 许可 |
|---|---|---|
| `androidx.webkit:webkit` | 1.14.0 | Apache-2.0 |
| `androidx.appcompat:appcompat` | 1.7.1 | Apache-2.0 |
| `androidx.activity:activity-ktx` | 1.10.1 | Apache-2.0 |
| `com.google.android.material:material` | 1.12.0 | Apache-2.0 |
| `androidx.lifecycle:lifecycle-process` | 2.10.0 | Apache-2.0 |

---

## 5. 关于本项目的许可（MIT）覆盖到哪

本项目自己的代码以 [MIT](LICENSE) 发布。**MIT 不覆盖第三方组件**：

```text
✔ MIT 覆盖：client/ server/ shared/ 目录下本项目编写的源代码
✘ MIT 不覆盖：SillyTavern（AGPL-3.0）、Node.js、以及任何第三方依赖

分发安卓 APK 时，APK 作为一个整体包含 AGPL-3.0 组件。
若你的使用场景要求"整包必须可被 AGPL 覆盖"（例如再分发 APK 时希望条款一致），
请以 AGPL-3.0 对待该 APK；只使用本仓库源码（不含 SillyTavern）时，MIT 照旧生效。
```

如果你要**再分发 APK**，请同时保留：

1. 本文件与 `LICENSES/` 目录；
2. SillyTavern 的 AGPL-3.0 声明与源码获取方式（§1.1）。

---

## 6. 许可全文索引

| 文件 | 协议 | 主要涉及 |
|---|---|---|
| [AGPL-3.0.txt](LICENSES/AGPL-3.0.txt) | GNU Affero GPL v3.0 | SillyTavern |
| [MIT.txt](LICENSES/MIT.txt) | MIT | 绝大多数依赖、Node.js、WinSW |
| [Apache-2.0.txt](LICENSES/Apache-2.0.txt) | Apache License 2.0 | 多个 crate、androidx |
| [LLVM-exception.txt](LICENSES/LLVM-exception.txt) | Apache-2.0 的 LLVM 例外 | libc++、rustix、wasi |
| [MPL-2.0.txt](LICENSES/MPL-2.0.txt) | Mozilla Public License 2.0 | cssparser / selectors 等 5 个 |
| [MS-RL.txt](LICENSES/MS-RL.txt) | Microsoft Reciprocal License | WiX UI 扩展（构建期） |
| [ISC.txt](LICENSES/ISC.txt) | ISC | 若干依赖 |
| [BSD-2-Clause.txt](LICENSES/BSD-2-Clause.txt) | BSD 2-Clause | 若干依赖 |
| [BSD-3-Clause.txt](LICENSES/BSD-3-Clause.txt) | BSD 3-Clause | brotli 等 |
| [0BSD.txt](LICENSES/0BSD.txt) | BSD Zero Clause | adler2 |
| [Zlib.txt](LICENSES/Zlib.txt) | zlib | bytemuck、objc2-* 等 25 个 |
| [Unlicense.txt](LICENSES/Unlicense.txt) | The Unlicense | aho-corasick、jiff 等 |
| [CC0-1.0.txt](LICENSES/CC0-1.0.txt) | CC0 1.0 Universal | 公共领域贡献 |
| [BSL-1.0.txt](LICENSES/BSL-1.0.txt) | Boost Software License 1.0 | 若干依赖 |
| [Unicode-3.0.txt](LICENSES/Unicode-3.0.txt) | Unicode License v3 | icu_* 、unicode-ident 等 18 个 |
| [WTFPL.txt](LICENSES/WTFPL.txt) | WTFPL | sanitize-filename |

---

## 7. 如何重新生成这份声明

依赖会变，这份文件也会过期。重新生成的步骤：

```bash
# 1. 重新采集依赖清单（Node 两棵树 + Rust crate + 直接嵌入组件）
node .verify/gen-third-party-data.mjs

# 2. 重新生成附录（完整依赖表）
node .verify/gen-third-party-appendix.mjs

# 3. 校验 LICENSES/ 里的文本是否完整、是否混进了网页残留
node .verify/check-licenses.mjs
```

Rust 侧需要先有 `.verify/cargo-licenses.json`（由 `cargo-license-audit.mjs` 生成，
逐个 crate 查 crates.io API，**不能用 sparse index** —— 它没有 license 字段）。

---

*最后更新：2026-11-18*
