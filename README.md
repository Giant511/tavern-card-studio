# Tavern Card Studio · 酒馆角色卡审计编辑工具链

面向 SillyTavern 生态的角色卡**审计 + 版本控制 + 分块编辑**工具链：

- **服务端**：角色卡存储、审计、版本控制（提交历史 / diff / 回滚），本地部署，带 Web 管理面板与 Windows MSI。
- **客户端**：Tauri文本编辑器，六板块 TXT 纯文本编辑、语法高亮、平台规则实时校验、审计面板、导出 TXT/JSON、与服务端同步。

## 当前进度

| 阶段   | 内容                                       | 状态                                                                       |
| ---- | ---------------------------------------- | ------------------------------------------------------------------------ |
| 阶段 0 | 技术选型、Monorepo、统一模型、两套规则规范                | ✅ 已完成                                                                    |
| 阶段 1 | 格式与规则层（ST JSON ⟷ UnifiedCard、平台规则引擎）     | ✅ 已完成                                                                    |
| 阶段 2 | TXT 分块编辑与预设格式层                           | ✅ 已完成（预设格式、世界书 v1.0 双向解析、整卡 TXT 导入导出）                                    |
| 阶段 3 | 语法高亮层                                    | ✅ 已完成（加载校验 / 渲染引擎 / 导入导出 / 三套范例与字段文档）                                    |
| 阶段 4 | 审计模块                                     | ✅ 已完成（字数统计 / 字段完整性两级语义 / 格式规范检查 / 结构化审计报告）                               |
| 阶段 5 | 服务端（CRUD / 版本控制 / 管理面板 / MSI）            | ✅ 已完成（字节保真存储 / Git 版本与三层 diff / 回滚 / 审计快照 / 管理面板 / MSI 与服务注册 / token 鉴权） |
| 阶段 6 | 客户端编辑器（分块编辑 / 高亮 / 实时提醒 / 导出 / 同步 / MSI） | ✅ 已完成（T6.1–T6.9 全部；双 MSI 已产出，端到端 36/36 通过）                               |
| 阶段 7 | 范例文件与文档交付                                | ⬜                                                                        |
| 阶段 8 | 联调与打包发布                                  | ⬜                                                                        |


## 已确认决策

以下决策已与需求方逐条确认，后续实现不得偏离（改动需先确认）：

| #                                                                                                                                                                                                                                                                                                                                                                                                                     | 决策                                                                                                               | 落地方式                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1                                                                                                                                                                                                                                                                                                                                                                                                                     | **「性格」独占 `data.personality`**                                                                                    | 性格板块不进 `description`；`description` 里出现的同名段落不参与模型（见 docs/01）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2                                                                                                                                                                                                                                                                                                                                                                                                                     | **板块标题允许用户改文案**                                                                                                  | 解析走别名表归一化比对；应用预设只换装饰符、保留标题文字；导出沿用用户改后的标题                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 3                                                                                                                                                                                                                                                                                                                                                                                                                     | **`aggregate` 两种口径**                                                                                             | `aggregate:false`（默认）逐块报、`location.blockId` 指向具体板块；`aggregate:true` 全文合计只报一条、`location` 全为 `null`、`issue.aggregate = true`。测试见 `test/aggregate.test.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 4                                                                                                                                                                                                                                                                                                                                                                                                                     | **`legacyTopLevel: 'preserve'` 仅供内部校验使用**                                                                        | `preserve` 只用于 round-trip 断言（`serializeStCard(parseStCard(x), {legacyTopLevel:'preserve'})` 与 `x` 深度相等）。**用户导出永远走 `sync`**（默认值），即按当前模型重新生成顶层 V1 兼容副本，避免顶层与 `data` 新旧不一致                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 5                                                                                                                                                                                                                                                                                                                                                                                                                     | **世界书 TXT 格式 v1.0 已冻结**                                                                                          | 规范见 [docs/04](docs/04-worldbook-txt-spec.md)。锚点用 `entry.id`；**重复 id 报错并给出行号、禁止静默合并**；转义采用方案 A（字面 `\@@` 再转义一层为 `\\@@`，round-trip 严格无损）；`extensions` 不进 TXT、**按 id 挂回**，冲突时不猜测归属；**导入时 TXT 为世界书事实源**，TXT 中不存在的条目即删除（必须可见）                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 6                                                                                                                                                                                                                                                                                                                                                                                                                     | **预设格式允许调整板块顺序**                                                                                                 | `blockOrder` 为六板块完整排列；解析仍按标题位置、导出不重排、只有「应用预设」才重排；默认顺序为 基本信息→性格→其他设定→特殊设定→用户相关设定→世界书；别名表覆盖六板块；非标准顺序 round-trip 无损（测试见 `test/preset.test.mjs`）。规范见 [docs/05-preset-spec.md](docs/05-preset-spec.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 7                                                                                                                                                                                                                                                                                                                                                                                                                     | **导入端缺失板块标题：严格 / 宽松双模式**                                                                                         | 默认 **strict**：缺任一板块 → 报错中止，报错含板块名、预期行号、可用别名，并对无法识别的标题给出「最接近板块」猜测（繁简如 `世界書`→`世界书`）；**lenient**（显式勾选）按空块填充并明确警告，空块带 `missing: true` 供 UI 标记。原则：**静默丢数据不可接受**——任何 error 下 `applyCardText` 原样返回原卡片。规范见 [docs/06-txt-import-mode.md](docs/06-txt-import-mode.md)                                                                                                                                                                                                                                                                                                                                                                                                |
| 8                                                                                                                                                                                                                                                                                                                                                                                                                     | **解析端不注入缺省值 + 审计端两级语义**                                                                                          | 世界书 TXT 解析不补 `constant` / `insertion_order` 等 ST 缺省键（理由：避免服务端版本 diff 噪声、保证可见字段 round-trip 严格相等、缺省语义由 ST 运行时负责）。联动：审计的字段完整性检查分两级——**平台必填且无缺省值**（如 `name`）缺失报 `error`；**有 ST 缺省值的字段未写出**用 `fields[].stDefault: true` 标记，**只报 `info`**。实现见 `checkFields`，规范见 [docs/02 §3.1](docs/02-platform-rule-spec.md)                                                                                                                                                                                                                                                                                                                                                    |
| 9                                                                                                                                                                                                                                                                                                                                                                                                                     | **T4.3 缺省字段只提示、不回写**                                                                                             | 有 ST 缺省值但未写出的字段（`constant` / `insertion_order` / `talkativeness` …共 15 项，清单在 `shared/src/audit/st-defaults.ts`）汇总成**一条 `info`**，**不报 error、不阻断导出、绝不回写 JSON**。可用 `AuditOptions.includeStDefaults: false` 关闭。规范见 [docs/07 §4.2](docs/07-audit-report-spec.md)                                                                                                                                                                                                                                                                                                                                                                                                |
| 10                                                                                                                                                                                                                                                                                                                                                                                                                    | **审计报告的问题条目必须携带位置信息**                                                                                            | 每条 `location` 一律显式给出 `blockId / field / start / end / line / column`（无法定位写 `null`，不省略键），另附 `lineText` / `excerpt` / `entryId`；客户端拿到即可「点击定位」，无需二次计算。`aggregate: true` 的全文问题位置全 `null` 且分组落在「全文」。规范见 [docs/07 §5](docs/07-audit-report-spec.md)                                                                                                                                                                                                                                                                                                                                                                                                              |
| 11                                                                                                                                                                                                                                                                                                                                                                                                                    | **高亮冲突消解的决胜规则写死**                                                                                                | 同优先级、同命中长度时**先声明者胜**（`rules[]` 数组靠前者），第 4 键起始偏移仅作兜底；保证「同一份规则 + 同一段文本 → 同一组区间」逐字节可复现。规范见 [docs/03 §4](docs/03-highlight-rule-spec.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 12                                                                                                                                                                                                                                                                                                                                                                                                                    | **高亮方案的标题正则与 TXT 预设装饰符耦合**                                                                                       | 范例的 `block-heading` 写死了 `【…】`（来自默认预设 `headings.*.pattern`）；换预设装饰符后标题规则会**静默失效**（不报错，只是不着色），需同步调整正则。`npm run validate:rules` 不检查这项耦合。见 [docs/03 §8](docs/03-highlight-rule-spec.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 13                                                                                                                                                                                                                                                                                                                                                                                                                    | **服务端按不透明 blob 存原始字节，禁止重新序列化**                                                                                   | 上传的卡片字节直接 `sha256` 内容寻址落盘（`blobs/<前2位>/<sha256>`），Git 提交里的 `card.json` 也是同一份字节；解析只用于索引与审计，**服务端任何路径都不出现 `JSON.stringify(card)` 入库**。原因：键序重排/缩进变化会污染版本 diff，破坏前四阶段保证的「逐字节可复现」。测试用 4 空格缩进 + CRLF + 非标准键序的卡片，断言上传前后 `sha256` 一致。见 [docs/08 §2](docs/08-server-api.md)                                                                                                                                                                                                                                                                                                                                                                                         |
| 14                                                                                                                                                                                                                                                                                                                                                                                                                    | **审计报告随版本快照一并存储**                                                                                                | 每次提交同时写入 `card.json` 与 `audit.json`（`buildAuditReport` 输出，`JSON.stringify(report,null,2)+"\n"`），所以看历史版本时看到的是**当时的**审计结论，而不是用今天的规则重算的结果。`?refresh=true` 只做只读重算并在响应头标 `X-TCS-Audit-Source: recomputed`，**不覆盖**快照。见 [docs/08 §6](docs/08-server-api.md)                                                                                                                                                                                                                                                                                                                                                                                                       |
| 15                                                                                                                                                                                                                                                                                                                                                                                                                    | **客户端壳选型从 Electron 改为 Tauri 2**（**体积已实测：MSI 1.98 MiB / 2,072,576 字节**，主程序 exe 3.91 MiB；对照 Electron 方案 90–120 MB） | 理由三条：① 换壳发生在**客户端 0 行代码**时，返工成本为零；② 体量目标（小安装包、低内存）是本项目既定诉求，Tauri 依赖系统 WebView2 而非自带 Chromium；③ 再晚就变成逐调用点重构 IPC。`webviewInstallMode` 定为 `downloadBootstrapper`：目标用户以 Win11 为主（Win10 已停止支持），WebView2 为系统组件；**Win10 首次启动需联网补装 WebView2**，离线分发变体留到最终发布时评估。落地方式：先冻结「壳能力契约」（[docs/11](docs/11-shell-capability-contract.md)），渲染层只依赖 `client/src/contract`，Rust 命令不认识 UI 结构；`shared` 零改动复用（26 文件 / 6057 行 / 0 个 Node API 依赖，打包产物内 `node:` 引用为 0）。安全上不提供目录选择能力，以规避 `tauri-plugin-dialog` 的 scope 递归问题（CVE-2026-95627，**官方尚未发布修复版本**，只能架构规避）。评估见 [docs/10](docs/10-client-shell-assessment.md)，构建与体积实测见 [docs/11 §10.3/§10.6](docs/11-shell-capability-contract.md) |
| 16                                                                                                                                                                                                                                                                                                                                                                                                                    | **编辑器内核用 CodeMirror 6，不用 Monaco**                                                                                | 体积考量已定：CM6 三个核心包 + 装饰能力足够（虚拟滚动、`Decoration.mark`、`RangeSetBuilder`），打包后主 chunk 38.85 kB（gzip 13.86 kB）；Monaco 单独就有数 MB。高亮不使用 CM 的 `syntaxHighlighting`（那面向语言语法树），而是把 `computeHighlightSpans` 的区间转成 `Decoration.mark` —— 这样「编辑器内着色」与「只读预览」共用同一套规则与同一份区间计算，不会出现两处配色不一致。见 [docs/12](docs/12-t61-block-editor.md)                                                                                                                                                                                                                                                                                                                                              |
| 17                                                                                                                                                                                                                                                                                                                                                                                                                    | **`Cargo.lock` 必须入库，禁止删除重建**                                                                                     | 传递依赖有两处钉定只存在于 lock 文件里：`plist 1.10.0`（1.10.2 会强制 `indexmap ^2.14`）与 `indexmap 2.13.0`（2.14 移除 `IndexMap<K,V,S>` 中 `S` 的默认参数，导致 `schemars` 报 `E0107`）。删掉 lock 重新解析必然重新撞上。另：`indexmap 1.9.x` 上游缺 `default = ["std"]`，需在 `[dependencies]` 与 `[build-dependencies]` **各开一次** `features = ["std"]`（两份依赖图独立解析）。见 [docs/11 §10.2](docs/11-shell-capability-contract.md)                                                                                                                                                                                                                                                                                           |
| 18                                                                                                                                                                                                                                                                                                                                                                                                                    | **折叠板块必须销毁编辑器，隐藏块不进 DOM**                                                                                        | `collapse()` 里 `editor.destroy()` + `host.replaceChildren()`，不是 `display:none` 挂载。理由：六个 CM 实例各带 contenteditable 与装饰树，全部常驻会拖慢输入与内存；实测默认视图只挂 2 个编辑器、4 个空容器，`?expand=all` 时才 6 个。字数等元信息走快照（`collectBlocks`），不依赖编辑器存活。见 [docs/12 §5](docs/12-t61-block-editor.md)                                                                                                                                                                                                                                                                                                                                                                                              |
| 19                                                                                                                                                                                                                                                                                                                                                                                                                    | **渲染层纪律做成可执行检查，不靠人记**                                                                                            | `client/scripts/validate-config.mjs` 第 10/11 项：① 除 `src/contract/**` 外禁止 `from '@tauri-apps/...'`；② 全渲染层禁止 `innerHTML`/`insertAdjacentHTML`/`outerHTML`（先剥注释再匹配，避免误报）。已验证**故意违规会让它失败并退出码 1**，不是装饰性检查                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 20                                                                                                                                                                                                                                                                                                                                                                                                                    | **「测试连接」必须两步：`/api/health` → `/api/stats`**                                                                      | 只打 `/api/health` 是**假阳性**——它是公开路径（`auth.publicPaths` 默认只含它），token 错了照样返回 200。用户会看到"已连接"，第一次上传却 401。判定链：health 判可达与 `authRequired` → 需要鉴权时再用 `/api/stats` 验 token（轻量、必鉴权、还能顺带返回卡片数，让用户确认连对了机器）。结果带 `stage: url\|health\|auth\|ok`，UI 据此把提示落到正确位置；"连不上"与"token 不对"分开报，因为处置动作不同。见 [docs/13 §1.1](docs/13-t68-client-settings.md)                                                                                                                                                                                                                                                                                                                              |
| 21                                                                                                                                                                                                                                                                                                                                                                                                                    | **CSP 的 `connect-src` 放宽到 `http: https: ws: wss:`**                                                              | 服务端地址是**用户可配置**的（本机 / 局域网 IP / 域名），构建期无法枚举 origin；若写死成 `http://127.0.0.1:* http://localhost:*`，打包版连局域网 IP 会被 CSP 直接拦，"支持非本机地址"就成了空话。仅放宽 `connect-src` 这一个指令，其余保持收紧（`script-src 'self'`、`img-src 'self' data:`、`font-src 'self' data:`）。若日后要更严，可在保存配置时按用户确认过的 origin 动态生成 CSP。见 [docs/13 §3.3](docs/13-t68-client-settings.md)                                                                                                                                                                                                                                                                                                                              |
| 22                                                                                                                                                                                                                                                                                                                                                                                                                    | **产物验证只能看时间链与体积增量，不能 grep 字符串；且不要断言 `exe ≤ MSI`**                                                                | Tauri 把前端产物 **brotli 压缩后内嵌**进 exe 资源段，在 `tcs-shell.exe` 里搜任何界面文案都是 0 命中——命中与否都不能证明"包里有最新前端"。2026-10-21 因此误判过一次：MSI 构建于 16:40、前端产物是 17:26，交付包不含新代码，但文件名/体积/退出码全正常。可靠判据是**时间链**：`shared/src ≤ shared/dist ≤ client/dist ≤ exe` 且 `client/dist ≤ MSI`，已固化为 `verify-build.ps1` 第 7 步。**另需注意**：`exe ≤ MSI` 这条**不成立**——实测 exe mtime `17:58:42.899`、MSI mtime `17:58:38.126`（light.exe 生成时刻）、MSI 创建时间 `17:58:42.888`（移入 bundle 目录时刻），因为 Tauri 打完包后仍会 patch exe 写入 bundle 类型信息，MSI 则是先临时生成再整体挪位（mtime 被保留）。所以只能断言"dist ≤ 各自交付物"，不能比较两个产物之间的先后。见 [README 发布检查清单](#发布检查清单)                                                                                           |
| 23                                                                                                                                                                                                                                                                                                                                                                                                                    | **`node.exe` 不能直接注册成 Windows 服务，必须用 WinSW 宿主**                                                                   | node.exe 从不调用 `StartServiceCtrlDispatcher`，SCM 永远等不到 `SERVICE_RUNNING`，服务卡在 `Start Pending`；而 MSI 的 `<ServiceControl Start="install" Wait="yes" />` 又在等 SCM，两边互等 → 安装界面永久停在 "Please wait while Windows configures ..."（2026-10-21 实际发生）。**最迷惑的点**：进程活着、8730/8731 都在 LISTENING，看起来完全正常。现在由 \`vendor/     第三方二进制（winsw 服务宿主，含来源与哈希说明）                                                                                                                                                                                                                                                                                                                        |
| 24 | **API 监听地址与管理面板监听地址必须分开（`host` / `controlHost`）** | 早先两者共用 `host`，于是「把 API 开给局域网」会连带把**管理面板**也暴露出去 —— 面板静态资源（`/`、`/app.js`、`/styles.css`）在 `PANEL_PUBLIC_PATHS` 里免鉴权，实测 `host=0.0.0.0` 时从局域网 IP `GET http://<lan-ip>:8731/` 返回 **200**；只有 `/control/*` 要 token。虽然操作仍受令牌保护，但「管理界面出现在局域网」本身不该发生。现在 `host` 只绑 worker（API），`controlHost` 只绑 supervisor（面板），后者默认 `127.0.0.1` 且**缺省值不跟随 `host`** —— 老配置（`host` 已是 `0.0.0.0`、没有这个键）升级时面板自动收回回环，无需用户改配置。面板开到非回环时 `auth.require` 必须为 true，否则拒绝启动。实测：`host=0.0.0.0` + 默认 `controlHost` → `0.0.0.0:8730` 可访问 API、`127.0.0.1:8731` 局域网连不上面板。回归测试见 `test/server-host-separation.test.mjs`，说明见 [docs/08 §9.3](docs/08-server-api.md) |
| winsw/WinSW.NET4.exe`（832 KiB，改名 `tcs-service-host.exe`）面向 SCM，node 作为其子进程。**第二个坑**：WinSW v2 不接受命令行传配置路径，只按文件名在同目录找 `<exe名>.xml`—— 所以`ServiceInstall`不能有`Arguments`，且 `tcs-service-host.exe`与`.xml\` 必须同名配对，改一个不改另一个会静默失效。**第三个坑**：配置是标准 XML，**注释里不能出现连续连字符**（不许用破折号画分隔线），否则 WinSW 加载即失败、日志目录都不建，表面上只剩事件 7009 + MSI 回滚 1920 —— 2026-10-21 因此连挂两次。现已加构建期 XML 良构校验与单测。修复与排障手册见 [docs/18](docs/18-server-service-fix.md) |                                                                                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## 快速开始

```bash
npm install                 # 安装依赖（workspaces: shared / server / client）
npm run validate:rules      # 校验 rules/ 下全部规则 JSON
npm run typecheck           # TS 类型检查
npm test                    # 编译 shared 并跑单元测试（round-trip / 规则引擎 / 世界书 / 整卡 TXT / 高亮 / 审计 / 服务端）
```

服务端（阶段 5）：

```bash
npm run build               # 编译 shared + server
npm run server              # 启动：管理面板 http://127.0.0.1:8731/  API http://127.0.0.1:8730/api
npm run demo:server         # 跑一遍完整的 CRUD/版本/diff/回滚/审计演示，产出 docs/assets/server-demo.md
npm run pack:server         # 打绿色包 release/server（自带 node.exe 与服务宿主，解压即用）
npm run gen:wix             # 生成 MSI 文件清单 installer/generated/AppFiles.wxs
# 构建 MSI（需 WiX v4/v5，脚本会说明如何离线获取）：
#   powershell -ExecutionPolicy Bypass -File installer\build-msi.ps1
```

首次启动会自动生成 `config.json` 与访问令牌并打印一次；之后用
  
`node server/dist/index.js token show --config <路径>` 取回。

**注册为 Windows 服务**（开机自启、无需登录）：用 MSI，或在绿色包目录执行
  
`installer\tcs-service.ps1 -Action install -InstallDir release\server`。

> `node.exe` **不能**直接当服务二进制：它不实现服务控制协议，SCM 会永远停在
>   
> `Start Pending`，安装程序随之卡死。必须经由 `tcs-service-host.exe`（WinSW）托管，
>   
> 它与同名 `.xml` 由 `pack:server` 一并产出。踩坑记录见 [docs/18](docs/18-server-service-fix.md)。

> ⚠️ **安全说明**：该令牌是**全权凭证**——持有即可调用全部 API（上传、覆盖、回滚、删除）。
>   
> 客户端会把它**明文**保存在应用配置目录（`%APPDATA%\com.taverncardstudio.client\client-config.json`），
>   
> 因此**请勿在不信任的机器上保存**；多人共用机器时，用完请在设置面板清空令牌。
>   
> 令牌泄露后的处置：用管理面板或 `token rotate` 轮换，旧令牌立即失效。

客户端（阶段 6 · Tauri 2 壳 + 六板块编辑器 + 设置面板已完成）：

```bash
npm run typecheck -w @tcs/client    # 契约层 + 渲染层类型检查
npm run build:ui   -w @tcs/client    # 只打前端资源 → client/dist
node client/scripts/validate-config.mjs   # 校验配置/权限/资源路径 + 渲染层纪律 + 决策表序号（12 项）
node client/scripts/gen-icons.mjs         # 重新生成图标（已入库，一般不用跑）
npm run dev        -w @tcs/client    # 起桌面窗口（需 Rust + MSVC + WebView2）
npm run build      -w @tcs/client    # 打 MSI（需 Rust + MSVC）

# 目标机一键验证 7 步（工具链 → 依赖 → 类型 → 构建 → 体积 → 时间链）
powershell -ExecutionPolicy Bypass -File client\scripts\verify-build.ps1

# 启用 git 钩子（每个克隆一次；改 README 时自动校验决策表序号）
powershell -ExecutionPolicy Bypass -File scripts\enable-hooks.ps1
```

### 发布检查清单

每次发布逐条勾选。前四项自动化能替你把关，第五项必须人工过一眼。

- [ ] **1. 单元测试全绿**：`npm test`（当前 260 例）
- [ ] **2. 配置与纪律校验**：`node client/scripts/validate-config.mjs`（12 项：schema / 权限 / 资源路径 / 渲染层禁 `@tauri-apps` 与 `innerHTML` / 决策表序号）
- [ ] **3. 决策表连续性**：`npm run check:decisions`（序号必须 #1..N 严格递增；改过 README 必跑，已挂 pre-commit）
- [ ] **4. 构建与时间链**：`client/scripts/verify-build.ps1`（7 步，含 `dist ≤ exe ≤ MSI` 断言）
- [ ] **4b. 服务端服务宿主**：`vendor/winsw/WinSW.NET4.exe` 存在且 sha256 为 `923111c7…`；`installer/ServiceHost.xml` 是良构 XML（构建脚本会强制校验，注释里不得有连续连字符）；MSI 内含 `tcs-service-host.exe` 与同名 `.xml`；装完后 `Get-Service` 必须是 `Running` 而不是 `StartPending`，且 `C://ProgramData//TavernCardStudio//logs` 已生成
- [ ] **5. 截图验收**：按「UI 任务收尾模板」三件事走一遍，人眼看图（见下）

**`Cargo.lock` 必须入库**（决策 #17）。传递依赖有两处钉定只在 lock 文件里：
  
`plist 1.10.0` 与 `indexmap 2.13.0`；删掉重建必然重新撞上 `E0107`。

**产物验证的铁律**：只能看**时间链**与**体积增量**，不能 grep 字符串。
  
Tauri 把前端产物 **brotli 压缩后内嵌**进 exe 资源段，在 `tcs-shell.exe` 里搜任何界面文案都是 **0 命中**
  
——命中与否都不说明问题。曾因此误判：MSI 构建于 16:40、前端产物是 17:26，
  
交付包不含新代码，但文件名、体积、退出码全都正常。

```bash
# 时间链：源 ≤ dist ≤ 交付物（第 4 步会自动断言，这里仅供手工复核）
# 注意：不要断言 exe ≤ MSI —— Tauri 打完包还会 patch exe，两者 mtime 无固定先后
ls -l --time-style=+%H:%M:%S client/dist/assets/main-*.js \
      client/src-tauri/target/release/tcs-shell.exe \
      "client/src-tauri/target/release/bundle/msi/"*.msi
```

体积增量可作旁证：T6.1 编辑器使 exe 3.91 → 4.38 MB，T6.2–T6.7 后 4.38 → 4.44 MB。

**MSI 安装需要管理员权限**：WiX 的 MSI 是 perMachine，且 Tauri 2.12 的 `wix` 段**没有** `installMode`
  
选项（那是 NSIS 的）。静默安装 `msiexec /i <msi> /qn` 在非管理员下会报 **Error 1925**。

### UI 任务收尾模板（每个 UI 任务必做）

**截图验收是固定步骤，不是可选项。** 原因很直接：DOM 断言能验"结构对不对"，
  
但验不出"看起来像坏了"——T6.5 就靠截图抓到「摘要重复显示」和「全文条目只剩一个圆点」，
  
两者 DOM 结构都完全正确。

每个 UI 任务收尾时按顺序做三件事：

| # | 动作         | 判据                                                                                                       |
| - | ---------- | -------------------------------------------------------------------------------------------------------- |
| 1 | **DOM 断言** | 用无头浏览器 `--dump-dom` 抓渲染结果，数出关键节点（编辑器实例数、装饰数、条目数、徽标文案）。验证的是**结构**与**数量关系**                                |
| 2 | **截图**     | `--screenshot` + `--force-device-scale-factor=2`（1× 看不清细线）。**必须亲自看一眼**，检查重复、空白、错位、只剩一个圆点这类"结构正确但观感不对"的问题 |
| 3 | **归档**     | 截图放 `docs/assets/<任务号>-<主题>.png`，在交付文档里引用，并在 README 文档索引登记                                               |

截图命令模板（本项目已验证可用）：

```bash
python -m http.server 8899 --bind 127.0.0.1 --directory client/dist &
chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --force-device-scale-factor=2 --user-data-dir=/tmp/shot \
  --virtual-time-budget=14000 --window-size=1420,900 \
  --screenshot=docs/assets/<name>.png "http://127.0.0.1:8899/index.html?<调试参数>"
```

> 调试参数用 URL query 驱动（如 `?expand=all`、`?demo=lenient`），
>   
> 但**必须走真实逻辑**，不得伪造状态——否则截图证明的是假象。

### 测试数据原则（面板类测试必守）

**用 shared 的真实产物驱动，不手造数据结构。**

反面做法：手写一堆 `AuditIssue` 对象喂给过滤函数。问题是——
  
你测的是"我以为的格式"，而不是 `shared` 实际产出的格式；
  
一旦 `shared` 改了字段名，测试照样绿，界面却坏了。

正面做法（`test/audit-panel-model.test.mjs` 就是这么写的）：

```js
// 用真实卡片 + 真实规则跑一遍 buildAuditReport，拿它的输出做断言
const report = buildAuditReport(card, { platformRule, preset });
const shown = filterIssues(report.issues, { ...EMPTY_FILTER, severities: new Set(['error']) });
```

适用面：审计面板、规则列表、预设切换预览——任何"展示 shared 计算结果"的 UI。
  
例外：纯几何/排版计算（如条形百分比归一）可以单独构造输入，因为输入本来就是数字。

能力边界与接口清单见 [docs/11-shell-capability-contract.md](docs/11-shell-capability-contract.md)：

渲染层只允许 `import` `client/src/contract`，禁止直接引用 `@tauri-apps/*`。

## shared 核心库（阶段 1 已可用）

```ts
import {
  parseStCard, serializeStCard, stringifyStCard,   // ST JSON ⟷ 统一模型
  parseDescription, assembleDescription,           // description 分块解析/拼装
  parsePreset, loadPresets, findPreset,            // 预设格式（标题 / 顺序 / 分隔符）
  planPresetApply, applyPresetPlan,                // 应用预设：唯一的重排入口
  renderWorldbookText, parseWorldbookText,         // 世界书 TXT ⟷ entries（v1.0）
  mergeWorldbookEntries, ensureEntryIds,           // TXT 事实源合并 / 补 id
  renderCardText, parseCardText, applyCardText,    // 整卡 TXT 导出 / 导入（严格 / 宽松）
  suggestBlockForHeading,                          // 未识别标题的「最接近板块」猜测
  loadPlatformRules, resolvePlatformRule,          // 规则加载与继承合并
  validateCard, summarizeIssues,                   // 规则校验 → 结构化问题
  planPlatformSwitch, applySwitchPlan,             // 平台切换适配
  loadHighlightRules, resolveHighlightRule,        // 高亮规则加载与 extends 合并
  compileHighlightRule, computeHighlightSpans,     // 编译 + 着色区间（冲突消解）
  tokenizeHighlight, renderInlineHtml, scopeCss,   // 分词 / HTML 预览 / 样式→CSS
  importHighlightRuleText, exportHighlightRuleText,// 高亮规则导入导出（失败保留原方案）
  applyHighlightRuleImport,
  countCardWords, countBlockWords,                 // 字数统计（T4.1）
  checkFormat, checkJsonValidity, checkStDefaults,  // 格式规范检查（T4.3）
  collectOmittedDefaults,                           // 有 ST 缺省值但未写出的字段
  buildAuditReport, stringifyAuditReport,           // 结构化审计报告（T4.4）
  describeIssueLocation, groupIssues,               // 「点击定位」文案与分组
} from '@tcs/shared';
```

生成高亮渲染预览页（自包含 HTML，佐证渲染效果）：`npm run preview:highlight` → `docs/assets/highlight-preview.html`。

生成审计报告范例：`npm run gen:audit-sample` → `docs/assets/audit-report-sample.json`。

121 个 shared 单元测试覆盖（+ 服务端 15 + 客户端编辑器 14 + 客户端设置 13 + 审计面板 16 + 工具链 12 + 预设与规则 25 + 导出与同步 24 + 服务宿主 9 + 地址隔离 11 = **合计 260，全部通过**）：V1/V2 卡片无损 round-trip、未知字段保留、单板块改动隔离、无标题卡片、新建卡片拼装、规则继承与逐块/合计校验、问题定位偏移、平台切换与校验联动、预设加载与校验、非标准顺序 round-trip、应用预设重排与增量编辑、**世界书 v1.0（字面 `\@@` 往返、重复 id 报错、删除/重排/extensions 挂回）**、**整卡 TXT 导入（严格中止 / 宽松可见空块 / 别名猜测 / error 时不写回）**、**高亮层（三套范例加载、extends 合并、四种匹配方式、priority 冲突消解、区间不重叠与碎片保留、导入导出 round-trip、导入失败保留原方案、wholeLine 跨行回归、声明顺序决胜的确定性）**、字段完整性两级语义（必填 `error` / 有缺省值 `info`）、**审计层（字数分布与合计口径、世界书按 entries 计、空块 vs 缺失块、缺省字段只报 info 且不回写、JSON 非法中止、预设装饰符/顺序偏差、世界书重复 id 定位到行号偏移、报告纯 JSON 与可复现、每条问题位置键齐全）**。

服务端 15 个用例覆盖：Bearer 鉴权与公开路径、**上传字节原样入库（4 空格缩进 / CRLF / 非标准键序，读回 `Buffer.equals`）**、列表与详情、新版本与三层 diff（字节 / 行 / JSON）、同字节重复提交不产生噪声、回滚（新建提交、历史只增不改）、**审计快照随版本存储且 `refresh` 不覆盖**、任意字节审计不入库、非法输入 400/415/422、软删与硬删、**worker 停止后面板仍在线且 `/api/*` 返回 503**、配置写入校验（端口冲突被拒）、令牌轮换、面板静态资源、**新建配置的 `dataDir` 由配置文件位置推导而非 cwd**。

客户端 11 个用例覆盖（`test/editor-block-model.test.mjs`，直接 import `client/src/editor/block-doc.ts`）：六板块投影顺序、**六块全改 → 序列化 → 再解析逐字一致**、**在解析结果上继续编辑不丢前一轮改动**、未编辑块不被改写、世界书合法/非法编辑（非法拒绝回写 entries）、清空板块、序列化稳定性、**修正后问题消失**、问题位置可定位（blockId + line + start/end）、平台切换结论随规则变化。

客户端设置 13 个用例覆盖（`test/client-settings.test.mjs`）：URL 归一化 8 种写法、危险协议拒绝、局域网 IP/域名保留、**不可达 / 非本服务 / health 异常 / 空 token / token 错误 / token 正确**、不要求鉴权时不请求受保护接口、超时兜底、非法 URL 零请求、`isSyncReady` 边界。
  
服务宿主 9 个用例覆盖（`test/service-host.test.mjs`）：**两份配置都是良构 XML**（注释合法性 + 标签配对，且检查器自测能抓到用连字符画分隔线的真实事故）、**MSI 与绿色包两份 WinSW 配置的运行语义字段逐项一致**（启动类型/可执行文件/入口/规则目录/工作目录/日志滚动/两级重启/失败计数窗口/停止超时/先停父进程）、数据目录**有意不同**（ProgramData vs `%BASE%\data`，写死任一方都会让两种部署互相覆盖）、不出现 WinSW v2 不支持的 `<delayedAutoStart>`（剥注释后判断，避免注释误报）、绿色包配置不含开发机绝对路径。
地址隔离 11 个用例覆盖（`test/server-host-separation.test.mjs`）：**默认两个地址都是回环**、老配置（无 `controlHost`、`host` 已是 `0.0.0.0`）升级后面板自动收回、显式 `controlHost` 不被 `host` 覆盖、`--control-host` 覆盖生效、**面板只改 API 地址时不会重置 panel 地址**、两个地址互不串改、`reachableHost` 把 `0.0.0.0`→`127.0.0.1`（否则打印出打不开的链接）、`isLoopbackHost` 判定、面板非回环且关鉴权时拒绝启动。

## 目录

```
shared/      客户端与服务端共用的核心库（模型 / 规则引擎 / 格式转换 / 审计）
server/      服务端：dist / public（管理面板）/ src（HTTP、存储、审计、supervisor）
client/      Tauri 2 客户端：src（渲染层）/ src/contract（能力契约）/ src-tauri（Rust 壳）
rules/       规则资产：schema、五份平台规则、三套高亮范例、三套预设格式
docs/        规范文档（00–19）、交付主文档与 assets（演示产物、报告范例、面板截图）
installer/   MSI 源（Product.wxs / ServiceHost.xml）与服务注册、修复脚本
vendor/      第三方二进制：winsw（Windows 服务宿主，node.exe 自己当不了服务）
scripts/     打包 / WiX 清单生成 / 演示脚本 / 验收脚本（e2e、round-trip、同步联调、范例校验）
test/        测试与 fixture（sample-card.json 用于 round-trip 验证）
```

## 文档

| 文档                                                                       | 内容                                                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| [docs/00-tech-stack.md](docs/00-tech-stack.md)                           | 技术选型、架构约束、目录结构、风险                                                              |
| [docs/01-unified-card-model.md](docs/01-unified-card-model.md)           | 六板块与 SillyTavern 字段映射、无损回写策略、边界情况                                              |
| [docs/02-platform-rule-spec.md](docs/02-platform-rule-spec.md)           | 平台规则 JSON 逐字段说明、规则类型语义、编写示例                                                    |
| [docs/03-highlight-rule-spec.md](docs/03-highlight-rule-spec.md)         | **语法高亮规则 JSON 字段说明文档（T3.4）**：逐字段说明、四种匹配方式、冲突消解、加载校验与错误分级、引擎与导入导出 API、三套范例、检查清单 |
| [docs/assets/highlight-preview.html](docs/assets/highlight-preview.html) | 高亮渲染预览（同一段文本 × default/minimal/dark 三套方案，由 `npm run preview:highlight` 生成）     |
| [docs/04-worldbook-txt-spec.md](docs/04-worldbook-txt-spec.md)           | **世界书 TXT 格式规范 v1.0（已冻结）**：条目分隔符、字段顺序、转义方案 A、合并语义、错误处理                         |
| [docs/05-preset-spec.md](docs/05-preset-spec.md)                         | 预设格式规范：标题样式、板块顺序、分隔符、应用流程                                                      |

| [docs/06-txt-import-mode.md](docs/06-txt-import-mode.md) | 整卡 TXT 导入：严格 / 宽松模式、缺失板块报错口径、别名猜测 |

| [docs/07-audit-report-spec.md](docs/07-audit-report-spec.md) | **审计报告规范（T4.1–T4.4）**：字数统计口径与分布样例、问题来源与严重级、缺省字段处理定义、位置契约（点击定位）、API、完整范例 |

| [docs/assets/audit-report-sample.json](docs/assets/audit-report-sample.json) | 审计报告 JSON 范例（`npm run gen:audit-sample` 生成，10 条问题覆盖四类来源） |

| [docs/08-server-api.md](docs/08-server-api.md) | **服务端 API 规范（T5.1–T5.6）**：两条硬约束落地、鉴权与限速、27 个接口清单、CRUD / 版本 / 三层 diff / 回滚 / 审计 / 控制面的请求响应范例、错误码、存储布局 |

| [docs/09-server-deploy.md](docs/09-server-deploy.md) | **部署与运维（T5.4 / T5.5）**：三种运行形态、配置项、管理面板、三条服务注册路径、MSI 构建与产物核验、备份升级迁移、安全清单、故障排查 |

| [docs/10-client-shell-assessment.md](docs/10-client-shell-assessment.md) | **客户端壳评估（阶段 6 开工前）**：Electron 壳现状（0 行）、壳层职责清单、shared 的 Node 依赖盘点（0 个模块）、Tauri 迁移的 Rust/配置代码量估算与风险清单 |

| [docs/11-shell-capability-contract.md](docs/11-shell-capability-contract.md) | **壳能力契约（Tauri 2 接口基线）**：5 类能力清单、TS↔Rust 类型对齐表、7 条不变量、错误码表、capabilities 权限取舍、CVE-2026-95627 核实与架构规避、构建实测与体积 |
  
| [docs/12-t61-block-editor.md](docs/12-t61-block-editor.md) | **T6.1 六板块编辑器**：分层与文件职责、截图与 DOM 实测、六板块 round-trip 测试证明、万字段落性能粗测、硬约束的可执行校验 |
  
| [docs/13-t68-client-settings.md](docs/13-t68-client-settings.md) | **T6.8 客户端设置**：服务端 URL / token 走契约 C5、两步连通性探测（可达 → 鉴权）、局域网 IP 与域名实测、同步降级边界、CSP 调整 |
  
| [docs/14-t64-t65-audit-panel.md](docs/14-t64-t65-audit-panel.md) | **T6.4 实时提醒 + T6.5 审计面板**：分层（纯逻辑视图模型 + 渲染层）、筛选/分组/字数分布、位置契约的消费方式、「修正即消失」端到端实证 |
  
| [docs/15-t62-t63-preset-rules.md](docs/15-t62-t63-preset-rules.md) | **T6.2 预设切换 + T6.3 规则管理**：选择 vs 应用的语义差异（实测）、导入原子回退证明、切换即重检、字段级错误分级 |
  
| [docs/16-t66-t67-export-sync.md](docs/16-t66-t67-export-sync.md) | **T6.6 导出 + T6.7 服务端同步**：审计闸门与拦截弹窗、TXT/JSON 双产物与 round-trip、上传/历史/回滚（含真实服务端证据与回滚确认语义） |
  
| [docs/17-release-delivery.md](docs/17-release-delivery.md) | **交付主文档**：双 MSI 体积与哈希、安装（含管理员要求）、配置、使用、规则编写指南、范例文件清单、端到端 36/36 结果、发布检查清单逐项勾选 |
  
| [docs/18-server-service-fix.md](docs/18-server-service-fix.md) | **服务端 MSI 安装卡住的根因与修复**：node.exe 不守服务协议 → SCM 永久 StartPending；WinSW 宿主改造、文件名配对约束、5 步排障清单 |
| [docs/19-host-separation.md](docs/19-host-separation.md) | **监听地址分离（安全修复）**：API 与面板曾共用 `host` 导致面板随 API 暴露到局域网；`controlHost` 新增、缺省不跟随 `host` 的升级逻辑、`reachableHost` 补漏、实测证据 |
  
| [docs/assets/t61-editor.png](docs/assets/t61-editor.png) | 编辑器默认视图（前两块展开，其余折叠未进 DOM） |
  
| [docs/assets/t61-issues.png](docs/assets/t61-issues.png) | 全部展开 + 问题面板 |
  
| [docs/assets/t61-issue-mark.png](docs/assets/t61-issue-mark.png) | 审计问题在编辑器内的点状下划线（3× 放大） |
  
| [docs/assets/t61-missing-blocks.png](docs/assets/t61-missing-blocks.png) | 「原文缺失」标记：宽松导入只有基本信息的 TXT，其余四块显式标注 |
  
| [docs/assets/t65-audit-panel.png](docs/assets/t65-audit-panel.png) | 审计面板：摘要 / 筛选 / 字数分布 / 按板块分组的问题列表 |
  
| [docs/assets/t62-rules-dialog.png](docs/assets/t62-rules-dialog.png) | 规则与预设面板：平台规则 / 高亮 / 预设三个分区 |
  
| [docs/assets/t62-before.png](docs/assets/t62-before.png) | 只选择预设：原文未改动（提示见右下角） |
  
| [docs/assets/t62-after-apply.png](docs/assets/t62-after-apply.png) | 应用预设：原文重排、下拉同步、按新格式重检 |
  
| [docs/assets/t63-import-failure.png](docs/assets/t63-import-failure.png) | 导入坏规则：字段级错误 + 原规则未被污染 |
  
| [docs/assets/t66-export-blocked.png](docs/assets/t66-export-blocked.png) | 导出拦截：审计未通过时逐条列出错误 |
  
| [docs/assets/t67-sync-panel.png](docs/assets/t67-sync-panel.png) | 同步面板：连接真实服务端（已就绪） |
  
| [docs/assets/t67-sync-versions.png](docs/assets/t67-sync-versions.png) | 版本历史：v1/v2/v3 含审计徽标与回滚入口 |
| [docs/assets/panel-host-separation.png](docs/assets/panel-host-separation.png) | 参数配置：API 监听地址与管理面板监听地址分开 |
  
| [docs/assets/t68-settings-connected.png](docs/assets/t68-settings-connected.png) | 设置面板：局域网 IP 连接成功（绿色） |
  
| [docs/assets/t68-settings-badtoken.png](docs/assets/t68-settings-badtoken.png) | 设置面板：token 无效（黄色，明确 401） |
  
| [docs/assets/t68-sync-disabled.png](docs/assets/t68-sync-disabled.png) | 未配置时同步入口置灰，本地编辑不受影响 |

| [docs/assets/server-demo.md](docs/assets/server-demo.md) | 阶段 5 演示实证（`npm run demo:server` 生成）：上传→新版本→三层 diff→回滚→审计快照全过程，含 sha256 与 Git 对象层核验 |

| [docs/assets/api-examples.json](docs/assets/api-examples.json) | 上述演示的真实请求/响应样例（可直接对照 docs/08 查看字段） |

| [docs/assets/admin-panel.png](docs/assets/admin-panel.png) | 管理面板截图 |

## 规则文件

| 文件                                        | 说明                                                            |
| ----------------------------------------- | ------------------------------------------------------------- |
| `rules/schema/platform-rule.schema.json`  | 平台规则 JSON Schema（draft-07）                                    |
| `rules/schema/highlight-rule.schema.json` | 高亮规则 JSON Schema（draft-07）                                    |
| `rules/schema/preset.schema.json`         | 预设格式 JSON Schema（draft-07）                                    |
| `rules/platforms/sillytavern.json`        | SillyTavern 原生（最宽松，其他规则的基类）                                   |
| `rules/platforms/character-card-v2.json`  | Character Card V2                                             |
| `rules/platforms/character-card-v3.json`  | Character Card V3                                             |
| `rules/platforms/janitorai.json`          | JanitorAI（不支持内嵌世界书、强制 `{{char}}`）                             |
| `rules/platforms/chub.json`               | Chub（支持世界书、作者/标签必填）                                           |
| `rules/presets/default.json`              | 预设：`【标题】` + 空行分隔，标准板块顺序                                       |
| `rules/presets/markdown.json`             | 预设：`## 标题` + 空行分隔                                             |
| `rules/presets/divider.json`              | 预设：`【标题】` + `---` 分隔线                                         |
| `rules/highlight/default.json`            | **默认高亮范例**（纸墨风，11 scope / 14 规则），首次启动自动载入                     |
| `rules/highlight/minimal.json`            | **最小可用范例**（2 scope / 2 规则），自定义方案的改写起点                         |
| `rules/highlight/dark.json`               | **继承范例**（`extends: "default"`，只覆盖 theme 与 3 个 scope，追加 1 条规则） |

所有规则文件均通过 `npm run validate:rules`（JSON Schema + 语义 + 正则可编译）校验。

## 许可证

MIT
