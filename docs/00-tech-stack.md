# 00 · 技术栈与工程结构（T0.1 / T0.2）

> 决策已于阶段 0 与需求方确认：**客户端 Electron · 服务端 Node+TS · 数据 SQLite · 版本控制 Git 裸仓库**。

## 1. 选型结论

| 层 | 选型 | 版本基线 | 理由 |
|---|---|---|---|
| 客户端外壳 | Electron | ≥ 32 | 本机已有 Node 22，无需 Rust 工具链；`electron-builder` 可直接产出 MSI |
| 客户端 UI | React + Vite + TypeScript | React 18 / Vite 5 | 分块编辑器需要频繁局部更新，组件化收益明显 |
| 文本编辑器内核 | CodeMirror 6 | 6.x | 支持 Decoration 实现「规则 JSON → 着色 / 波浪线」，性能优于 contenteditable 方案 |
| 服务端 | Node.js + TypeScript + Fastify | Node ≥ 20 / Fastify 4 | 与 shared 同语言，规则引擎/审计代码 100% 复用，不维护两套实现 |
| 数据库 | SQLite（better-sqlite3） | 3.x | 单文件、免安装、便于 MSI 打包与备份 |
| 版本控制 | Git 裸仓库（isomorphic-git） | 1.x | 每个角色卡一个 bare repo；天然获得历史/diff/回滚；不依赖用户机器上的 Git |
| 规则校验 | JSON Schema draft-07 + Ajv | Ajv 8 | 规则文件在加载时即 Schema 校验，错误信息可读 |
| 测试 | Vitest | 2.x | 与 Vite 同生态，round-trip 测试跑得快 |
| 打包 | electron-builder（client）+ WiX（server MSI） | 24.x | Windows MSI 由 electron-builder 内置 WiX 支持 |

**为什么不让客户端直连 Git / 数据库**：客户端只通过 HTTP 访问服务端，服务端是唯一写入方，避免双写冲突；客户端在未连接服务端时仍可完整离线编辑与导出（需求隐含要求）。

## 2. 关键架构约束

1. **单一规则实现**：平台规则引擎、TXT 分块解析、审计，全部落在 `shared/`，客户端与服务端引用同一份代码。服务端审计接口（T5.3）与客户端实时提醒（T6.4）产出结构完全相同，只是触发时机不同。
2. **序列化无损优先**：任何写回 SillyTavern JSON 的操作都采用「原文偏移量补丁」策略，未编辑的片段逐字保留（见 `01-unified-card-model.md`）。
3. **规则与代码分离**：平台规则、语法高亮规则都是可替换的 JSON 文件，代码里不出现任何平台特有判断（出现即视为缺陷）。
4. **离线可用**：客户端把平台规则 / 高亮规则 / 预设格式复制到用户配置目录，随安装包附带内置版本；服务端不可达时不影响编辑、审计、导出。

## 3. 目录结构

```
tavern-card-studio/
├─ package.json              # npm workspaces 根
├─ tsconfig.base.json        # 共享 TS 配置（ES2022 / NodeNext / strict）
├─ shared/                   # @tcs/shared —— 客户端与服务端共用核心库
│  └─ src/
│     ├─ model/              # 统一模型、ST 原生类型、板块定义、JSON 工具
│     ├─ rules/              # 平台规则 / 高亮规则 的类型与引擎（阶段 1、3）
│     ├─ format/             # TXT 分块解析与拼装、预设格式（阶段 2）
│     └─ audit/              # 字数、完整性、格式、平台规则审计（阶段 4）
├─ server/                   # 服务端：CRUD / 版本控制 / 审计 API / 管理面板
│  └─ src/
├─ client/                   # Electron 客户端：分块编辑器 / 审计面板 / 同步
│  └─ src/
├─ rules/                    # 全部规则资产（随安装包分发，也可单独替换）
│  ├─ schema/                # platform-rule.schema.json / highlight-rule.schema.json
│  ├─ platforms/             # sillytavern / character-card-v2 / character-card-v3 / janitorai / chub
│  ├─ highlight/             # 默认高亮方案
│  └─ presets/               # TXT 预设格式（阶段 2 填充）
├─ docs/                     # 规范文档（本目录）
├─ scripts/                  # validate-rules.mjs 等工程脚本
└─ test/                     # 单元测试与 fixtures
```

## 4. 常用命令

```bash
npm install            # 安装全部 workspace 依赖
npm run validate:rules # 校验所有规则 JSON（Schema + 语义 + 正则可编译）
npm run typecheck      # TS 全量类型检查
npm test               # 单元测试（阶段 1 起有实际用例）
```

## 5. 已知风险与对策

| 风险 | 对策 |
|---|---|
| Electron 安装包体积（~90MB） | 接受；MSI 可做差分更新（阶段 9 可选） |
| better-sqlite3 原生模块与 Electron ABI 不匹配 | 服务端独立进程运行在系统 Node/内置 Node，不注入 Electron 渲染层；客户端不直接依赖 sqlite |
| Git 裸仓库并发提交冲突 | 服务端串行化写入（单进程 + 队列），每个卡片一把写锁 |
| 平台规则随站点政策变化而过期 | 规则是纯 JSON，用户可自行编辑；预留规则版本号与 `updatedAt` |
| CodeMirror 大文本高亮性能 | 只对可视区域做 Decoration（CM6 原生 range 渲染），规则匹配加 50ms 节流 |
