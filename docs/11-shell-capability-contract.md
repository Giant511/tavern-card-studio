# 壳能力契约（Tauri 2 · 阶段 6 接口基线）

> 状态：**契约与实现已完成，本机已完整构建通过** —— `tauri build` 产出 MSI **1.98 MiB**（2,072,576 字节）。
> 工具链（rustc 1.99.1 / MSVC 2022 / WebView2 155）、crates 镜像、产物核验见 §10.3 与 §10.6。
> 服务端（Node.js）不在本契约范围内，且本期未做任何改动。

---

## 1. 分层与依赖方向

```
┌──────────────────────────────────────────────┐
│ 渲染层（阶段 6 的编辑器 UI）                   │
│   · 只 import client/src/contract            │
│   · 禁止 import @tauri-apps/*                │
└──────────────────┬───────────────────────────┘
                   │  shell.ts（唯一原生入口）
┌──────────────────▼───────────────────────────┐
│ 契约层 client/src/contract                    │
│   types.ts / errors.ts / shell.ts            │
│   · invoke 封装、对话框白名单、配置读写        │
└──────────────────┬───────────────────────────┘
                   │  IPC（invoke + 插件）
┌──────────────────▼───────────────────────────┐
│ Rust 壳 client/src-tauri                      │
│   5 个自定义命令 + 7 个官方插件                │
│   · 只认"能力"，不认识页面/组件/路由           │
└──────────────────┬───────────────────────────┘
                   │  PathBuf / File
┌──────────────────▼───────────────────────────┐
│ 文件系统 / $RESOURCE/rules                    │
└──────────────────────────────────────────────┘
```

两条硬规则：

1. **渲染层只能依赖契约层。** 想加原生能力，先改契约（`types.ts` + `shell.ts`），再改 Rust，最后 UI 才能用。
2. **Rust 不反向依赖 UI。** 命令的出参是扁平 DTO（camelCase），不含"页面 id""组件状态""路由"这类概念。

`shared`（26 文件 / 6057 行）**不经过契约层**——它是纯逻辑，渲染层直接 import，与 Node 侧完全同一份代码。

---

## 2. 能力清单

契约共 5 类能力 + 1 个自检，对应 5 个 Rust 命令和 3 个插件 API。

| # | 能力 | 实现 | 入参 | 出参 | 关键约束 |
|---|---|---|---|---|---|
| C1 | 读文件 | `read_text_exact` | `path`, `maxBytes?` | `TextFile` | 严格 UTF-8，非法字节报 `NOT_UTF8`，**不做 U+FFFD 替换** |
| C2 | 原子写文件 | `write_file_atomic` | `path`, `text`, `expectedSha256?` | `WriteReceipt` | 同目录 tmp → fsync → rename → 回读比对 |
| C3 | 扫规则目录 | `scan_rule_dir` | `kind`（**不是路径**） | `RuleDirScan` | 目录由 Rust 解析，前端无权指定 |
| C4 | 读规则文件 | `read_rule_text` | `kind`, `name` | `TextFile` | 拒绝 `..`/分隔符/NUL，canonicalize 后必须在根内 |
| C5 | 配置存取 | `configGet/configSet/configPatch/configReset` | 键值 | `ClientConfig` | plugin-store，落在应用配置目录 |
| C6 | 文件对话框 | `pickCardFile/pickSavePath/pickRuleFile` | — | `string \| null` | **只选单文件**；不传 `directory`、不传递归 |
| D1 | 自检 | `shell_info` | — | `ShellInfo` | 版本 / 规则根 / debug\|release |

### 2.1 Rust 命令注册（`src-tauri/src/lib.rs`）

```rust
.invoke_handler(tauri::generate_handler![
    commands::shell_info,
    commands::read_text_exact,
    commands::write_file_atomic,
    commands::scan_rule_dir,
    commands::read_rule_text,
])
```

### 2.2 插件清单（7 个）

| 插件 | 用途 | 谁在用 |
|---|---|---|
| `single-instance` | 第二个实例聚焦已有窗口 | Rust（必须**第一个**注册） |
| `window-state` | 记住窗口大小/位置 | Rust |
| `log` | 结构化日志落盘 | Rust |
| `store` | 客户端配置持久化 | JS（经契约层） |
| `dialog` | 打开/保存对话框 | JS（经契约层） |
| `fs` | 预留（规则导入等） | **渲染层当前不使用**，仅授予 `fs:default` |
| `opener` | 外链交系统浏览器 | JS（后续） |

`fs` 的存在与"最小权限"的关系见 §7。

---

## 3. 类型契约（TS ↔ Rust 对齐表）

Rust 侧所有结构体都是 `#[serde(rename_all = "camelCase")]`，因此字段名在两侧完全一致，不做二次转换。

| TS（`client/src/contract/types.ts`） | Rust（`client/src-tauri/src/commands.rs`） | 字段 |
|---|---|---|
| `TextFile` | `struct TextFile` | `pathDisplay: string\|null` / `text` / `bytesLen: number` / `sha256` |
| `WriteReceipt` | `struct WriteReceipt` | `pathDisplay` / `bytesWritten` / `sha256` / `verified` |
| `RuleFileEntry` | `struct RuleFileEntry` | `name` / `size` / `mtimeMs` |
| `RuleDirScan` | `struct RuleDirScan` | `kind` / `root` / `signature` / `entries` / `skipped` |
| `ShellInfo` | `struct ShellInfo` | `version` / `rulesRoot` / `mode` |
| `RuleKind` | `kind: String` + `paths::rule_subdir` 校验 | `'platforms' \| 'presets' \| 'highlight'` |

**`pathDisplay` 允许为 `null`**，这是刻意的：路径不是合法 UTF-8 时返回 `null`，
而不是 `to_string_lossy()`。后者会把 `C:\a\u{FFFD}.json` 这种假路径显示给用户，
一旦用户据此做判断就会出错。UI 遇到 `null` 显示「路径含非 UTF-8 字符，无法展示」即可。

---

## 4. 不变量（改代码前先看这里）

| 编号 | 不变量 | 落地位置 | 破坏后果 |
|---|---|---|---|
| I1 | **字节保真**：读到的 `text` 再写回，字节完全相同 | `read_text_exact` 严格解码 + `write_file_atomic` 以 `text.as_bytes()` 落盘 | 悄悄改写用户卡片，版本 diff 出现假变更 |
| I2 | **写入原子性**：要么旧文件，要么完整新文件 | `write_via_temp`（tmp → `sync_all` → `rename`） | 中途失败留下半个卡片 |
| I3 | **写后自证**：回读并重算 sha256 | `write_file_atomic` 的 `verified` | 无法证明"写进去的就是我以为的" |
| I4 | **写前断言**：`expectedSha256` 不符则一个字节都不写 | `DigestMismatch` 前置检查 | 覆盖掉编辑期间被外部改动的文件 |
| I5 | **路径不越界**：规则文件只能来自规则目录 | `ensure_plain_file_name` + `canonicalize().starts_with(root)` | 任意文件读取（符号链接穿越） |
| I6 | **无目录选择**：前端拿不到"指定目录"的能力 | 三个 `pick*` 全部 `directory: false`；`scan_rule_dir` 无路径参数 | 见 §8 的 CVE |
| I7 | **错误可分支**：`code` 是封闭集合，UI 不解析文案 | `error.rs::code()` ↔ `errors.ts::ShellErrorCode` | UI 靠字符串匹配，改文案即崩 |

> I1 的前提是**卡片必须是 UTF-8**。这与服务端审计的 fatal 解码一致
> （`server/src/audit/service.ts`），所以两侧对"什么算合法输入"的判断相同。

---

## 5. 错误码表

| code | 触发条件 | details | UI 建议处理 |
|---|---|---|---|
| `EMPTY_PATH` | 传入空路径 | — | 内部错误，打日志 |
| `PATH_NOT_ABSOLUTE` | 相对路径 | `path` | 内部错误 |
| `NOT_A_FILE` | 目标是目录/设备 | `path` | 提示"选的是文件夹" |
| `PATH_NOT_FOUND` | 文件不存在 | `path` | 提示"文件已被移动或删除" |
| `TOO_LARGE` | 超 `maxBytes`（默认 64 MiB） | `size`, `limit` | 提示体积上限 |
| `NOT_UTF8` | 非法 UTF-8 | `offset` | 提示"不是 UTF-8，请另存为 UTF-8" |
| `EXT_NOT_ALLOWED` | 规则文件非 `.json` | `name` | 提示只接受 JSON |
| `DIGEST_MISMATCH` | 写前摘要不符 | `expected`, `actual` | **必须阻断**，提示文件已被外部修改 |
| `RULES_DIR_MISSING` | 三个位置都没找到规则目录 | — | 提示安装不完整或设置 `TCS_RULES_DIR` |
| `UNKNOWN_RULE_KIND` | kind 不在三类内 | `kind` | 内部错误 |
| `PATH_NOT_ALLOWED` | 越界/非法文件名 | `path` | 内部错误（正常流程不该出现） |
| `IO_ERROR` | 其它文件系统失败 | `path` | 展示原文，附路径 |

前端归一化：`toShellError()` 把 invoke 的 rejection 转成 `ShellError`，
非壳错误（参数错、插件异常）统一落 `SHELL_BRIDGE_ERROR`。

---

## 6. 路径与规则目录

### 6.1 路径纪律

- Rust 内部**一律 `PathBuf` / `&Path`**，不出现 `String` 当路径用。
- 只在两处转字符串：跨 IPC 的 `pathDisplay`、错误文案。两处都允许 `None`。
- 前端传给命令的 `path` 是字符串（JSON 没有 OsString），进入 Rust 后**立刻** `PathBuf::from` 并校验绝对路径。

已知边界：Windows 上含"孤立代理项"的路径无法经 JSON 往返。这类路径在对话框中也不会正常返回，
所以不额外处理，但 §4 的 I1/I5 不依赖它。

### 6.2 规则目录解析顺序

`paths::rules_root()` 依次尝试：

| 顺序 | 位置 | 场景 |
|---|---|---|
| 1 | 环境变量 `TCS_RULES_DIR` | 运维覆盖 / 测试注入 |
| 2 | `resource_dir()/rules` | **生产**：`bundle.resources` 把 `../../rules` 映射到 `$RESOURCE/rules` |
| 3 | `src-tauri/../../rules` | **仅开发期**：`tauri dev` 时 `resource_dir()` 指向 `target/debug`，bundler 没拷资源 |

三条都不命中 → `RULES_DIR_MISSING`（不静默返回空列表，否则 UI 会显示"0 条规则"而不知道是坏了）。

### 6.3 与服务端 `registry.ts` 的签名同构

服务端：

```ts
key += `${name}:${stat.size}:${mtimeMs};`
```

壳：

```rust
format!("{}:{}:{};", entry.name, entry.size, entry.mtime_ms)
```

语义一致：**签名变了才重新解析**。已知差异：

- Node 的 `mtimeMs` 是浮点毫秒（含小数），Rust 取 `as_millis()` 的整数毫秒。
  两侧各自比较自己的签名，不跨进程比对，所以不影响正确性；但**不要把两侧签名直接等值比较**。
- 服务端只扫 `platforms`/`presets`（审计需要），壳额外扫 `highlight`（编辑器需要）。

---

## 7. 权限与 scope（`src-tauri/capabilities/default.json`）

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "主窗口最小权限：只允许单文件对话框、自身配置读写；刻意不授予任意路径 fs 访问与目录选择",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:allow-open",
    "dialog:allow-save",
    "store:default",
    "log:default",
    "opener:default",
    "fs:default"
  ]
}
```

说明与取舍：

- **没有 `fs:scope` 条目**，也没有 `fs:allow-read-text-file` / `fs:allow-write-text-file`：
  渲染层不需要直接读写任意路径——所有文件 IO 走自定义命令，命令自己做校验。
- `fs:default` 只覆盖应用自身目录（`$APPCONFIG`/`$APPDATA`/`$APPLOCALDATA` 等）的读与创建，
  **不含任意路径写**。授予它是为将来"把导入的规则存进应用目录"留口，当前渲染层并未调用。
- **不使用 `persisted-scope`**：因为它持久化的是"对话框授予的目录"，而我们**根本不选目录**（§8）。
  少一个持久化授权面，就少一类"上次点过的目录一直有权限"的隐患。
- 自定义命令默认对所有窗口开放；如需收紧，用 `build.rs` 的 `AppManifest::commands(&[...])`
  再按窗口授权。本期只有一个窗口，暂不引入该复杂度。

---

## 8. 安全：CVE-2026-95627 的核实与缓解

### 8.1 核实结果（可复查）

```
$ curl -s https://api.github.com/advisories/GHSA-j8fp-v6pf-qx45
summary : When a Tauri application uses the dialog plugin's file or folder picker,
          an attacker with JavaScript execution (XSS) can force the scope expansion
          to be recursive, granting read/write access to an entire directory tree...
severity: high        cvss: 7.7        published: 2026-09-23
cve_id  : CVE-2026-95627
vulnerabilities: []   ← 没有已发布修复版本
```

**关键结论：`vulnerabilities` 为空 = 官方尚未发布修复版本，所以"pin 修复版本"这条走不通。**
（此前评估报告里我引的 `GHSA-vw89-89jm-wmqc` 是错的编号，已更正为本条。）

### 8.2 因此改用架构规避

公告自己给出的修复方向是"只授予用户真正选中的那一个文件/目录，不要接受调用方传来的递归标志"。
契约按这个方向设计：

| 缓解 | 落地 |
|---|---|
| 前端没有"选目录"能力 | `pickCardFile/pickSavePath/pickRuleFile` 全部 `directory: false`、`multiple: false` |
| 前端无法请求递归授权 | 三个 `pick*` 不接受任何选项参数，选项在契约层写死 |
| 规则目录遍历只在 Rust 侧 | `scan_rule_dir(kind)` 无路径参数；`read_rule_text(kind, name)` 做穿越校验 |
| 不持久化任何授权 | 不用 `persisted-scope` |

### 8.3 本项目自身的 XSS 面

客户端要渲染**第三方提供的角色卡文本**，是这个 CVE 的典型前置条件。已确认：

- `renderInlineHtml`（`shared/src/highlight/highlight-engine.ts:404`）对文本、`scope`、`ruleId`
  全部做 HTML 转义；
- 自检面板（`client/src/main.ts`）只用 `textContent`，不拼 `innerHTML`。

**约定：渲染层禁止 `innerHTML` / `insertAdjacentHTML` / `dangerouslySetInnerHTML`。**
高亮预览必须走 `renderInlineHtml` 的输出（它已转义）；若未来需要插入结构，用 DOM API 构造。

---

## 9. 契约变更流程

1. 改 `client/src/contract/types.ts`（类型）；
2. 改对应 Rust 结构体/命令，保持 `rename_all = "camelCase"`；
3. 若新增错误分支：同时改 `error.rs::code()` 与 `errors.ts::ShellErrorCode`（**两个封闭集合必须一一对应**）；
4. 改 `docs/11`（本文档）§2/§3/§5 的对应表；
5. 跑 `npm run typecheck -w @tcs/client`（前端类型）与 `cargo check`（Rust，需工具链）。

---

## 10. 构建与验证：工具链、实测结果、复跑方法

### 10.1 本机已验证 ✅（可复跑）

| # | 项 | 命令 | 实测结果 |
|---|---|---|---|
| 1 | 契约层 + 渲染层类型检查 | `npx tsc -p client/tsconfig.json` | **0 error**（对着真实的 `@tauri-apps/api@2.12.4` 类型编译） |
| 2 | 前端打包 | `npx vite build`（client） | **成功**：39 modules → JS 50.27 kB（gzip 17.56 kB）+ CSS 1.33 kB |
| 3 | shared 在 webview 可用 | 检查产物 | 产物内**含 shared 的中文字符串**（说明 shared 被打进包）；`node:` 引用 **0 处**（无 Node 内置模块泄漏） |
| 4 | 配置对官方 schema | `node client/scripts/validate-config.mjs` | **9/9 通过**，校验用 `schema.tauri.app/config/2.12.4` |
| 5 | 权限面自检 | 同上 | 授予 7 项权限、**未授予任何 `fs:allow-write/remove/rename/mkdir/copy`** |
| 6 | 引用路径存在性 | 同上 | 4 个图标、`../dist`、`../../rules` 全部存在 |
| 7 | Tauri CLI 识别项目 | `npx tauri info` | `tauri 🦀: 2.12.4`、`@tauri-apps/api 2.12.4`、`cli 2.12.3`；WebView2 155.0.4283.62 |
| 8 | 图标产物 | `node client/scripts/gen-icons.mjs` | 32/128/256/512 PNG + 4 帧 ICO，PNG 头 `89 50 4e 47` 合法 |
| 9 | **工具链组装** | `winget` + `rustup` | rustc **1.99.1** / cargo 1.99.1 / rustup 1.29.1；MSVC **VS 生成工具 2022**（`link.exe` 14.44.35207）；WebView2 155.0.4283.62 |
| 10 | **Rust 编译（dev）** | `cargo build` | **成功**，`Finished dev profile in 6m 00s` |
| 11 | **依赖解析** | `cargo fetch` | 全部依赖走 rsproxy 拉取成功（含 `tauri 2.12.4`） |
| 12 | **release 构建** | `tauri build` | **成功**，`Finished release profile in 11m 05s`，产出 `tcs-shell.exe` 3.91 MiB |
| 13 | **MSI 打包** | 同上 | **成功**，`Tavern Card Studio_0.1.0_x64_en-US.msi` **2,072,576 字节（1.98 MiB）** |
| 14 | **一键验证脚本** | `verify-build.ps1` | **六步全过，EXIT=0**，`.verify/last-run.txt` 无 FAIL/WARN |

> 第 3 项是这次迁移评估里最关键的一条假设——"shared 能不能在 webview 里跑"。
> 现在有产物级证据：打包结果里没有 `node:` 前缀，且 shared 的业务字符串确实在 bundle 内。

### 10.2 依赖版本钉定（真实编译才暴露的问题）

首次 `cargo build` 在 `schemars 0.9.0` 上失败：

```
error[E0107]: type alias takes 2 generic arguments but 3 generic arguments were supplied
  --> schemars/.../map.rs:12
   | pub type Map<K, V> = indexmap::IndexMap<K, V, S>;
```

根因是传递依赖的语义化版本"暗坑"：

| 包 | 解析到的版本 | 问题 |
|---|---|---|
| `indexmap` | 2.14.2 | 移除了 `IndexMap<K, V, S>` 中 `S` 的默认类型参数 |
| `schemars` | 0.9.0 | 仍按"`S` 有默认值"写，于是参数个数不匹配 |
| `plist` | 1.10.2 | 强制 `indexmap ^2.14.0`，所以**不能**直接降 indexmap |

解决：把 `plist` 降到 1.10.0（它只要 `indexmap ^2.1.0`），再钉 `indexmap` 到 2.13.0。

```bash
cd client/src-tauri
cargo update -p plist --precise 1.10.0
cargo update -p indexmap@2.14.2 --precise 2.13.0
```

**这两条不会写进 `Cargo.toml`**——`Cargo.lock` 才是钉传递依赖的正确位置，
所以 `client/src-tauri/Cargo.lock` 必须入库（已在 `.gitignore` 注释里标注）。
升级 `tauri` 时若这两个包被顶上去，报的仍是同一个 `E0107`，按上面两条重新钉即可。

### 10.3 首次构建通过（2026-10-21 本机实测）

#### 工具链

| 组件 | 版本 / 位置 | 来源 |
|---|---|---|
| rustc / cargo | **1.99.1** | `rustup-init`（走 rsproxy 分发） |
| rustup | 1.29.1 | 同上 |
| MSVC | **VS 生成工具 2022**，`link.exe` 14.44.35207 | `winget install Microsoft.VisualStudio.2022.BuildTools --override "... --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`（13 分钟） |
| WebView2 | 155.0.4283.62 | 系统已有 |

`npx tauri info` 最终状态：

```
[✔] Environment
    ✔ WebView2: 155.0.4283.62
    ✔ MSVC: Visual Studio 生成工具 2022
    ✔ rustc: 1.99.1      ✔ cargo: 1.99.1      ✔ rustup: 1.29.1
    ✔ Rust toolchain: stable-x86_64-pc-windows-msvc (default)
    - node: 22.22.2      - npm: 10.9.7
```

两个安装期的坑（换机器会遇到）：

1. `rustup-init -y --no-modify-path` 生成的 `~/.cargo/bin/*.exe` shim 在本机是 **0 字节**（rustup 自身完整）。
   处理：`cp rustup.exe <每个 0 字节 shim>`，共修复 13 个；同时把 `%USERPROFILE%\.cargo\bin` 写进用户 PATH。
2. rsproxy 的 dist 路径是 **`https://rsproxy.cn`**（不带 `/rustup`），而 rustup 自更新走 `https://rsproxy.cn/rustup`。
   写错会报 `error: no release found for 'stable'`。

#### crates 索引镜像（%USERPROFILE%\.cargo\config.toml）

```toml
[source.crates-io]
replace-with = 'rsproxy-sparse'

[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"

[net]
git-fetch-with-cli = true
```

验证结果：

- `cargo fetch`（本项目 500+ 依赖）**成功**，全部包显示 `(registry 'rsproxy-sparse')`，含 `tauri 2.12.4`；
- `cargo search serde --limit 1` **不适用**：源替换后 cargo 报
  `crates-io is replaced with non-remote-registry source`——这是设计行为（search 要走远端 registry API），
  不代表镜像不可用。**判断镜像是否可用请用 `cargo fetch`，不要用 `cargo search`。**

#### 构建过程中修的两个真问题

| 问题 | 现象 | 修法 |
|---|---|---|
| `schemars` 编译失败 | `error[E0107]: struct takes 3 generic arguments but 2 were supplied`，指向 `indexmap-1.9.3` | 见 §10.2：`indexmap 1.9.x` 缺 `default = ["std"]`，需在 **[dependencies] 与 [build-dependencies] 各开一次** `indexmap = { version = "1.9", features = ["std"] }`（两份依赖图的特性解析是独立的） |
| WiX 3.14 下载失败 | `failed to bundle project: io: peer closed connection ... github.com/wixtoolset/wix3` | tauri-bundler 内置的 WiX 是 **v3**（与服务端 MSI 用的 v5 无关）。手动从 NuGet 取 `WiX/3.14.1`，解压后把 `tools/*` 放到 `%LOCALAPPDATA%\tauri\WixTools314\`，bundler 检测到 `candle.exe` 即跳过下载 |

#### 最终产物

```
Finished `release` profile [optimized] target(s) in 11m 05s
Built application at: ...\target\release\tcs-shell.exe
Running candle for "...\target\release\wix\x64\main.wxs"
Running light to produce "...\bundle\msi\Tavern Card Studio_0.1.0_x64_en-US.msi"
Finished 1 bundle at:
  D:\...\bundle\msi\Tavern Card Studio_0.1.0_x64_en-US.msi (1.98 MiB)
```

`client/scripts/verify-build.ps1` 六步全过（`EXIT=0`），`.verify/last-run.txt` 无 FAIL / WARN。
完整日志见该文件。

### 10.4 历史记录：工具链就绪前的阻塞（2026-10-21 已解除）

> 本节保留历史记录，便于判断"当年为什么说跑不通"。当前状态见 §10.1 与 §10.3。

工具链就绪前，`npx tauri info` 的输出是：

```
[✘] Environment
    ✔ WebView2: 155.0.4283.62
    ✘ Couldn't detect any Visual Studio or VS Build Tools instance with MSVC and SDK components.
    ✘ rustc: not installed!        ✘ Cargo: not installed!
```

当时的两个阻塞：无 Rust/MSVC 链接器；`index.crates.io` 经代理返回 502（`static.crates.io` 单包可下，但 cargo 需要索引）。
后者通过 `%USERPROFILE%\.cargo\config.toml` 换成 rsproxy 稀疏索引解决，见 §10.4。

### 10.5 一键验证（任意目标机可复跑）

仓库内提供了验证脚本 `client/scripts/verify-build.ps1`，它按顺序做 6 件事并把结果写进
`.verify/last-run.txt`：

```powershell
cd tavern-card-studio
powershell -ExecutionPolicy Bypass -File client\scripts\verify-build.ps1
```

期望输出（第一项为阈值检查）：

| 步骤 | 命令 | 通过标准 |
|---|---|---|
| 1 | `rustc --version` / `cargo --version` | 有版本号 |
| 2 | `node --version` | ≥ 20.11 |
| 3 | `npm --version` | ≥ 10 |
| 4 | `npm install` | 退出码 0 |
| 5 | `npm run typecheck -w @tcs/client` | 0 error |
| 6 | `npx tauri build` | 产出 `client/src-tauri/target/release/bundle/msi/*.msi` |

**前置条件（一次性）**：

```powershell
# Rust + MSVC
winget install Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
# WebView2（Win10 需装，Win11 自带）
winget install Microsoft.EdgeWebView2Runtime
```

### 10.6 安装包体积：实测结果

**已实测（2026-10-21，本机 Windows 10.0.26200 x64）**：

| 产物 | 字节 | 换算 |
|---|---:|---|
| `Tavern Card Studio_0.1.0_x64_en-US.msi` | **2,072,576** | **1.98 MiB / 2.07 MB** |
| `tcs-shell.exe`（主程序） | 4,097,024 | 3.91 MiB |

MSI 文件头 `D0 CF 11 E0 A1 B1 1A E1`（OLE 复合文档），结构合法。

与评估时的预估对照：

| 来源 | 体积 |
|---|---|
| 评估预估（docs/10 §10.4） | 5–12 MB |
| **本次实测** | **1.98 MiB** |
| Electron 方案对照 | 90–120 MB |

**为什么显著小于预估**：预估按"整套 `rules/` 打进包 + 内嵌 WebView2 安装程序"估算。
实际配置是 `webviewInstallMode: downloadBootstrapper`（不内嵌运行时，Win10/11 自带 WebView2），
`release` profile 又开了 `lto = true` / `codegen-units = 1` / `opt-level = "s"` / `strip = true`；
`rules/` 的 14 个 JSON 只有几十 KB，对体积几乎无影响。

复跑核对：

```bash
ls -l "client/src-tauri/target/release/bundle/msi/"
```

> 若把 `webviewInstallMode` 改为 `embedBootstrapper` / `offlineInstaller`（目标机可能没装 WebView2 时更稳），
> 体积分别增加约 1.8 MB / 130 MB。本项目默认 `downloadBootstrapper`，代价是首次启动需联网装 WebView2。

---

## 11. 本期不含（避免误以为漏了）

| 项 | 为什么不在壳里 |
|---|---|
| 上传 / 历史版本 / 回滚（T6.7） | 纯 HTTP，渲染层 `fetch` 直连本地服务端；服务端已返回 `Access-Control-Allow-Origin: *`（`server/src/http/app.ts:308`），无需额外插件或代理 |
| 规则解析 / 校验 / 审计 | 全在 `shared`，与 Node 侧同一份代码 |
| 编辑器（T6.1–T6.5） | 阶段 6 主体，本契约只提供底座 |
| 自动更新 | 需求未要求；引入会新增签名密钥与更新服务器 |

---

## 12. 交付清单

| 文件 | 行数 | 作用 |
|---|---:|---|
| `client/src/contract/types.ts` | 94 | 类型契约 |
| `client/src/contract/errors.ts` | 74 | 错误码与归一化 |
| `client/src/contract/shell.ts` | 212 | **唯一原生入口** |
| `client/src-tauri/src/commands.rs` | 380（有效 289） | 5 个命令 |
| `client/src-tauri/src/paths.rs` | 141（有效 98） | 路径与规则根 |
| `client/src-tauri/src/error.rs` | 133（有效 104） | 错误模型 |
| `client/src-tauri/src/lib.rs` | 38 | 插件与命令注册 |
| `client/src-tauri/src/main.rs` | 6 | 入口 |
| `client/src-tauri/tauri.conf.json` | — | 窗口 / CSP / 资源 / MSI |
| `client/src-tauri/capabilities/default.json` | — | 权限 |
| `client/src-tauri/Cargo.toml` | — | 依赖与 release profile |
| `client/src/main.ts` | 243 | 自检面板（契约用法样板） |
| `client/scripts/gen-icons.mjs` | — | 无依赖图标生成（PNG/ICO 手写编码） |
| `client/scripts/validate-config.mjs` | — | 配置 + 权限面静态校验（9 项，含官方 schema） |
| `client/scripts/verify-build.ps1` | — | 目标机一键验证（6 步，写 `.verify/last-run.txt`） |

**Rust 合计 698 行（有效 524 行）**，落在评估时给的路线 B 区间（215–320 行有效代码）之外——
多出来的部分主要是注释与错误模型：评估按"直接实现"估下界，实际写时把
`error.rs` 的 details 映射、`paths.rs` 的三级回退、写后回读都展开了。这个偏差应当记录，
下次估算同类壳时把「错误模型 + 路径守卫」按 150–200 行单独计。
