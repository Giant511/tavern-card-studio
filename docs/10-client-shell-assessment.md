# 客户端壳评估：现状、shared 的 Node 依赖、Tauri 迁移成本

> 评估时点：2026-10-21（阶段 5 完成后、阶段 6 开工前）
> 范围：仅客户端壳与 shared 库。**服务端（Node.js）不在评估范围**，且迁移后保持不变。
> 所有行数均为 `wc -l` 实测；Rust 行数为**估算**，估算口径见 §5.4。

---

## 1. 结论摘要

**① 当前 Electron 壳代码是 0 行。** `client/` 下只有一份 14 行的 `package.json` 和一个空的 `.gitkeep`，
既没有 `main.ts`、也没有 `preload.ts`，`package.json` 里连 `electron` 依赖都没声明。阶段 6 尚未开工。

**② shared 对 Node API 的依赖是 0 个模块。** 26 个 TS 文件、6057 行，全部只做相对路径 import；
`node:` / `fs` / `path` / `Buffer` / `process` / `require(` 命中数全为 0。它在 Node 与浏览器里都能跑，
**Tauri 的 webview 可以直接复用，一行不用改**。

**③ 因此这不是一次"迁移"，而是"开工前的选型"。** 换壳的代价不是重写已有代码，而是：
多一套 Rust 工具链 + 约 200–350 行 Rust + 约 150–250 行 JSON 配置。
而壳只占客户端总工作量的约 10%——真正的大头（编辑器 UI）两种壳一样写。

---

## 2. 现状盘点：Electron 壳代码行数

### 2.1 实测结果

| 项 | 值 |
|---|---|
| `client/` 下的源文件 | **0 个** |
| `client/package.json` | 14 行（只有 `@tcs/shared` 一个依赖，**未声明 electron**） |
| `client/src/` | 仅 `.gitkeep`（0 字节） |
| Electron 主进程 / 预加载 / 渲染层代码 | **0 行** |
| 全仓库 `electron` 关键字命中（排除文档） | **0 处** |

```
$ find client -type f -not -path "*/node_modules/*"
client/package.json
client/src/.gitkeep

$ cat client/package.json
{
  "name": "@tcs/client",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "角色卡分块编辑器桌面客户端（Electron）",
  "main": "./dist/main.js",
  "scripts": { "build": "tsc -b" },
  "dependencies": { "@tcs/shared": "*" }
}
```

也就是说：**现在换壳的成本是零**（没有代码要改），唯一的判断依据是后续开发成本和交付形态。

### 2.2 壳层职责清单（按需求 T6.1–T6.9 推导）

需求文档 §三 与阶段 6 的九个任务，落到"壳必须提供什么"上只有下面这些。
关键区分：**业务逻辑全部在 shared，壳只负责"原生能力"**。

| # | 职责 | 对应需求 | 需要原生能力 | 能否只在渲染层做 |
|---|---|---|---|---|
| 1 | 窗口创建、菜单、快捷键、窗口状态记忆 | T6.1 | 是 | 否 |
| 2 | 打开角色卡 JSON（文件对话框 + 读原始字节） | T6.1 / §6 | 是 | 否（浏览器拿不到任意路径） |
| 3 | 导出 TXT / JSON（保存对话框 + 写字节） | T6.6 | 是 | 否 |
| 4 | 扫描规则目录（`rules/platforms`、`presets`、`highlight`） | T6.3 | 是 | 否（除非经服务端转手） |
| 5 | 导入 / 导出规则 JSON（用户自选文件） | T6.2 / T6.3 | 是 | 否 |
| 6 | 客户端配置持久化（服务端地址、token、当前规则/预设/高亮方案） | T6.8 | 是（可退化为 localStorage） | 部分是 |
| 7 | 连接服务端：上传、历史版本、回滚 | T6.7 | 否（HTTP） | **可以**（`fetch`） |
| 8 | 单实例、外部链接交系统浏览器、崩溃日志 | 工程需要 | 是 | 否 |
| 9 | 安全边界（渲染层不碰 Node；IPC 白名单） | 工程需要 | 是 | 否 |
| 10 | 打 MSI 安装包 | T6.9 | 工具链 | — |

**不在壳里的东西**（这些是全平台通用的纯逻辑，已经在 shared 里做完并有 121 个单元测试）：

- 卡片解析/序列化（`parseStCard` / `serializeStCard`）
- 分块拆分与拼装（`parseDescription` / `assembleDescription` / `applyCardText`）
- 预设格式（`loadPresets` / `planPresetApply` / `applyPresetPlan`）
- 规则引擎与平台切换（`loadPlatformRules` / `validateCard` / `planPlatformSwitch`）
- 语法高亮（`compileHighlightRule` / `computeHighlightSpans` / `renderInlineHtml`）
- 审计（`countCardWords` / `checkFormat` / `buildAuditReport`）

---

## 3. shared 库中依赖 Node API 的模块清单

### 3.1 结论：**0 个模块**

对 `shared/src` 全量扫描（26 个 `.ts`）：

| 符号 | 命中数 | 说明 |
|---|---|---|
| `node:` 前缀导入 | **0** | 没有任何内置模块导入 |
| `Buffer` | **0** | 不用 Node 的 Buffer |
| `process.` | **0** | 不读环境变量、不读 argv |
| `__dirname` / `__filename` | **0** | 不做路径推导 |
| `require(` | **0** | 纯 ESM |
| `document.` / `window.` / `localStorage` | **0** | 也不依赖 DOM（因此能被服务端复用） |
| `fetch(` / `crypto.` | **0** | 不发请求、不做哈希 |
| `TextEncoder` | 1 | Web 标准 API（Node 与浏览器都有） |
| `structuredClone` | 3 | Web 标准 API（Node ≥17 与浏览器都有） |

唯一的 1 处 `TextDecoder`/`TextEncoder` 与 3 处 `structuredClone` 都是**双端通用**的 Web 标准，
不存在"Node 专有 → 浏览器没有"的落差。

### 3.2 逐模块清单

| 目录 | 文件 | 行数 | Node 依赖 | 职责 |
|---|---|---:|---|---|
| `model/` | `json.ts` | 37 | 无 | 宽松 JSON 解析（保序、报行列） |
| | `blocks.ts` | 86 | 无 | 六板块定义与标题匹配 |
| | `sillytavern.ts` | 113 | 无 | ST 字段常量、V2/V3 判定 |
| | `unified-card.ts` | 188 | 无 | 统一模型 ⟷ ST 映射 |
| `format/` | `description.ts` | 403 | 无 | description 分块解析/拼装 |
| | `preset.ts` | 328 | 无 | 预设格式加载与应用 |
| | `sillytavern-io.ts` | 391 | 无 | ST JSON 解析/序列化（逐字节可控） |
| | `worldbook.ts` | 559 | 无 | 世界书 TXT v1.0 双向 |
| | `card-txt.ts` | 400 | 无 | 整卡 TXT 导入/导出 |
| `rules/` | `platform-rule.ts` | 180 | 无 | 规则类型与继承合并 |
| | `platform-rule-parser.ts` | 313 | 无 | 平台规则校验（吃已解析对象） |
| | `platform-rule-engine.ts` | 375 | 无 | 校验引擎 → 结构化问题 |
| | `platform-switch.ts` | 262 | 无 | 平台切换适配 |
| | `scopes.ts` | 184 | 无 | 字段作用域 |
| | `highlight-rule.ts` | 95 | 无 | 高亮规则类型/合并 |
| | `highlight-rule-parser.ts` | 378 | 无 | 高亮规则校验 |
| `highlight/` | `highlight-engine.ts` | 442 | 无 | 编译 + 着色区间 + HTML 渲染 |
| | `highlight-io.ts` | 132 | 无 | 高亮规则导入导出 |
| `audit/` | `types.ts` | 141 | 无 | 审计类型与位置契约 |
| | `issue.ts` | 157 | 无 | 问题构造/分组/定位文案 |
| | `word-count.ts` | 123 | 无 | 字数统计 |
| | `st-defaults.ts` | 116 | 无 | ST 缺省字段表 |
| | `format.ts` | 350 | 无 | 格式规范检查 |
| | `report.ts` | 112 | 无 | 审计报告组装 |
| `text/` | `count.ts` | 157 | 无 | 偏移 ⟷ 行列换算 |
| 根 | `index.ts` | 35 | 无 | 公共出口（26 行 export *） |
| **合计** | **26 文件** | **6057** | **0** | |

### 3.3 为什么 shared 能保持干净

不是巧合，是分层决定的：**"读文件"这件事被特意放在壳/服务端，shared 只吃已解析的 JSON**。

```ts
// shared 的规则加载入口：入参是 unknown[]（已解析的对象），不是路径
export function loadPlatformRules(inputs: readonly unknown[]): { ... }
export function loadPresets(inputs: readonly unknown[]): { ... }
export function loadHighlightRules(inputs: readonly unknown[]): HighlightLoadResult
```

对应地，服务端把 `fs` 集中在 `server/src/rules/registry.ts`
（`readdirSync` / `readFileSync` / `statSync` + `name:size:mtime` 签名热加载）。

**迁移含义**：Tauri 客户端只要把"目录 → JSON 数组"这一步补上（读文件 + `JSON.parse`），
就能把同一批发给 `loadPlatformRules`，规则引擎、审计、高亮全部原样复用。

### 3.4 复用方式（两种壳都一样）

`shared` 已编译为 ESM（`"type": "module"`、`main: ./dist/index.js`、含 `.d.ts`）。
客户端按包引用 `@tcs/shared` 即可，和 `server` 现在的做法一致：

```json
"dependencies": { "@tcs/shared": "*" }
```

注意事项：`shared` 的相对 import 带 `.js` 后缀（NodeNext 规范），用 Vite 打包时直接消费
`shared/dist` 最省事；不要试图让打包器把 `shared/src` 的 `.js` 后缀重映射到 `.ts`。

---

## 4. 若迁移到 Tauri：代码量与形态对照

### 4.1 Electron 侧（作为对照基线，同样是估算）

按 §2.2 的职责清单，Electron 需要写：

| 部件 | 内容 | 估算行数（TS） |
|---|---|---:|
| `main.ts` | 窗口、菜单、IPC 处理器（读/写文件、对话框、规则目录、配置） | 180–260 |
| `preload.ts` | `contextBridge` 白名单 API | 60–90 |
| 配置/打包 | `electron-builder` 配置 | 约 40（JSON） |
| **合计** | | **约 280–390 行 TS** |

不需要新增工具链：本机 Node 22 已就绪，`electron-builder` 自带 WiX 打 MSI。

### 4.2 Tauri 侧：三种实现路线的 Rust 行数

**路线 A — 只用官方插件（最薄）**

`dialog`（文件对话框）+ `fs`（读写，对话框选中的路径自动进 scope）+ `store`（配置）+ `single-instance` + `window-state` + `log` + `opener`。

| 项 | 说明 | Rust 行数 |
|---|---|---:|
| 入口与插件注册 | `lib.rs` builder 链 | 40–60 |
| 错误封装 | 自定义 `AppError` → `invoke` 错误 | 20–30 |
| 命令 | 基本不需要（全部走插件 JS API） | 0–20 |
| **小计** | | **60–110** |

**路线 B — 插件 + 少量自定义命令（本项目建议）**

在本项目里，有两件事用插件做不干净，值得自己写 command：

1. **原子写**：导出卡片要"逐字节可复现"，`plugin-fs` 的 `writeFile` 不保证 tmp+rename，进程被杀可能留半截文件。
2. **规则目录签名**：与服务端 `registry.ts` 一致地按 `名称:size:mtime` 做签名，避免每次编辑全量重解析。
3. **可选**：上传前算 `sha256` 校验（也可用 WebCrypto 在 JS 里做，则为 0 行 Rust）。

| 项 | 说明 | Rust 行数 |
|---|---|---:|
| 入口与插件注册 | 同路线 A，多 3–4 个插件 | 60–80 |
| 错误封装 | 统一 `Result<T, AppError>` | 25–40 |
| `scan_rule_dir` | 读目录、过滤 `.json`、返回 `{name,path,size,mtime}`，含 mtime 失败降级 | 45–70 |
| `read_text_exact` | 按 UTF-8 严格解码（`fatal`），非法字节报错而不是替换 | 25–40 |
| `write_text_atomic` | 同目录 `.tmp` + `rename`，写完再校验字节 | 30–45 |
| `file_sha256`（可选） | 流式哈希 | 20–30 |
| 命令注册 | `invoke_handler` 列表 | 10–15 |
| **小计** | | **约 215–320** |

**路线 C — 不用插件，全部自己实现**（不推荐）

对话框（`rfd`）、配置（`serde_json` + 路径）、单实例、日志、窗口状态全手写：

| 项 | Rust 行数 |
|---|---:|
| 上述 A/B 的全部 | 215–320 |
| 文件对话框 | 25–40 |
| 配置读写 | 40–60 |
| 单实例 | 20–30 |
| 日志/崩溃钩子 | 20–30 |
| 窗口状态 | 30–45 |
| **小计** | **约 350–525** |

### 4.3 别忘了配置：Tauri 的"另一半个壳"

Tauri 的权限模型是**声明式**的，光有 Rust 不够，还要写配置文件：

| 文件 | 内容 | 行数（JSON/TOML） |
|---|---|---:|
| `tauri.conf.json` | 窗口、bundle（MSI/WiX）、CSP、插件配置 | 80–150 |
| `capabilities/*.json` | 窗口 ↔ 权限 ↔ 路径 scope 的绑定（`fs:scope` 必须显式给） | 40–80 |
| `Cargo.toml` | 依赖与 feature | 20–35 |
| `build.rs` | 默认 5 行，若要限制 command 可见性再加 | 5–20 |
| **小计** | | **约 145–285** |

`fs` 的一个坑必须写进设计：**`fs:default` 只覆盖应用自己的目录**（对 `$APPCONFIG`/`$APPDATA`/`$APPLOCALDATA` 等读，以及在其中创建目录），
**不含任意路径的写权限**；用户选的任意路径要靠对话框"临时加进 scope"（重启失效，需要 `persisted-scope` 才持久）。
规则目录如果用安装包内置（`$RESOURCE/rules`）也要单独声明。权限与 scope 是两件事：给了 `fs:allow-write-text-file`
但没给 scope，运行期照样报 `forbidden path`。

### 4.4 汇总对照

| 维度 | Electron | Tauri 2.11（路线 B） |
|---|---|---|
| 壳代码量 | 280–390 行 TS | 215–320 行 Rust + 145–285 行配置 |
| 新增工具链 | 无（Node 22 已就位） | **Rust + MSVC Build Tools**（本机均未安装）+ WebView2 运行时 |
| 安装包体积 | 约 90–120 MB（自带 Chromium） | 约 8–15 MB（依赖系统 WebView2） |
| MSI 生成 | electron-builder 内置 WiX | tauri-bundler 内置 **WiX v3**（与服务端现用的 WiX 5 是两套，互不影响） |
| 权限/安全模型 | 自己控制 `contextIsolation` + preload 白名单 | 声明式 capabilities + 路径 scope，粒度更细但**配置成本更高** |
| 业务代码复用 | shared 直接复用 | shared **直接复用（0 改动）** |
| 编辑器 UI（CM6 等） | 一样 | 一样（WebView2 = Chromium 内核） |
| 渲染层调试 | DevTools 开箱可用 | 需 `devtools` feature / debug 构建 |
| 首次构建耗时 | 秒级 | 首次 `cargo build` 分钟级（含依赖编译） |

---

## 5. 风险清单（针对本项目，不是泛泛而谈）

### 5.1 决定成本的是工具链，不是行数

本机实测：`rustc` / `cargo` **不存在**，`Microsoft Visual Studio` 目录**不存在**。
走 Tauri 需要先装 rustup + MSVC Build Tools（数 GB、需要联网、CI 也要配）。
如果目标是"尽快把阶段 6 做出来"，这是唯一的硬门槛；Rust 代码量反而不是问题。

### 5.2 文件对话框的 scope 扩张（需确认版本）

公开披露的 CVE-2026-95627（CVSS 7.7）指向 `tauri-plugin-dialog`：
一旦前端取得 JS 执行，可让"选文件"这一步把**整个目录树**的读写权限授予应用，且当前进程生命周期内无法撤销。
（该条来自漏洞库的转述，落地前请以 tauri-apps/plugins-workspace 的 GHSA 与修复版本为准。）

对本项目的含义：客户端会渲染**用户/第三方提供的角色卡文本**，属于典型的 XSS 输入面。
缓解措施：

- 渲染层一律不拼 `innerHTML`（好消息：`renderInlineHtml` 已对文本、`scope`、`ruleId` 全部做 HTML 转义，见 `highlight-engine.ts:404`）；
- 若走 Tauri，pin 到含修复的插件版本，且不在前端调用带递归选项的目录选择；
- 真正的"整个目录"授权放在 Rust 侧显式做，不暴露给前端。

Electron 侧的对应风险是 `nodeIntegration: true` 或过宽的 preload 白名单——**同样必须避免**，
且 Electron 没有"声明式最小权限"可用，边界完全靠人守。

### 5.3 中文路径与非 UTF-8 文件名的处理

本项目的仓库路径本身就含中文（`D:\Claw\代码开发\...`）。Rust 侧要统一用 `OsStr`/`PathBuf`
而不是 `String` 处理路径，否则遇到非 UTF-8 文件名会 panic 或丢字符。
Electron 用 Node 的 `fs` 天然以 `Buffer`/字符串双模处理，这块更省心。

### 5.4 估算口径（便于你复核或反驳）

- Rust 行数按"含注释与空行"计，风格与现有 `shared`/`server` 一致（本仓库注释密度较高）。
- 只统计**壳必须写**的部分；编辑器 UI、CM6 集成、面板布局不含在内。
- 每条的区间下界 = 最直接实现，上界 = 加上参数校验、错误分支、日志。
- 不含 CI、签名、自动更新（需求未要求）。

### 5.5 客户端总工作量分布（判断"壳"值不值得纠结）

| 部分 | 估算 | 是否随壳变化 |
|---|---|---|
| shared 复用 | 6057 行已完成 | **不变** |
| 编辑器 UI（六板块 + CM6 + 折叠） | 1200–1800 行 TS | 不变 |
| 实时校验 + 问题列表 + 定位 | 500–800 行 TS | 不变 |
| 审计面板 + 导出前拦截弹窗 | 300–500 行 TS | 不变 |
| 规则/预设/高亮管理 UI | 400–600 行 TS | 不变 |
| 服务端同步 UI | 250–400 行 TS | 不变 |
| **壳（原生能力）** | **Tauri 215–320 Rust / Electron 280–390 TS** | **这部分才变** |

壳约占客户端总工作量的 **6%–10%**。

---

## 6. 建议

**如果优先级是"尽快交付"**：继续用 Electron。零新增工具链，本机 `npm i electron` 就能跑，
`electron-builder` 打 MSI 也已有成熟路径（和服务端 WiX 5 互不干扰）。代价是安装包 ~100 MB。

**如果优先级是"安装体积 / 权限最小化 / 长期分发体验"**：现在换 Tauri 的**时机是最优的**——
客户端 0 行代码，shared 完全可复用，没有任何返工。成本明确：约 215–320 行 Rust
+ 145–285 行配置 + 一次性工具链安装；风险集中在 §5.2 的 scope 设计与 §5.3 的路径处理。

**不建议**：先按 Electron 写完再迁。那时要改的是 IPC 契约与全部 `window.api` 调用点，
而不是 §4.2 那 200 多行——迁移成本会从"一次性配置"变成"逐个调用点重构"。

无论选哪个，都建议**先把壳的 IPC 契约冻结成一份接口清单**（读文件/写文件/扫规则目录/存取配置/开对话框），
让渲染层只依赖这份契约。这样壳可替换，编辑器 UI 的 2800+ 行不受影响。

---

## 附录：本次评估的执行命令

```bash
# 1) 客户端现状
find client -type f -not -path "*/node_modules/*" -not -path "*/dist/*"
wc -l client/package.json
grep -rn "electron" --include="*.json" --include="*.ts" . --exclude-dir=node_modules

# 2) shared 的 Node 依赖
grep -rhn "from '" shared/src --include="*.ts" | grep -o "from '[^']*'" | sort | uniq -c
for s in "Buffer" "process\." "__dirname" "require(" "node:"; do grep -rn "$s" shared/src --include="*.ts" | wc -l; done

# 3) 规模
find shared/src -name "*.ts" -exec wc -l {} + | tail -1   # 6057
```
