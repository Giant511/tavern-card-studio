# 01 · 统一内部模型与 SillyTavern JSON 映射（T0.3）

本文件是 `shared/src/model/unified-card.ts` 的文字版说明。代码是权威实现，本文解释「为什么这样设计」以及边界情况怎么处理。

## 1. 六板块 → SillyTavern 字段映射

| 板块 id | 显示名 | 承载内容 | 落盘字段 | 允许为空 |
|---|---|---|---|---|
| `basic` | 基本信息 | 身高、体重、外貌穿搭、年龄、生日、身份 | `data.description`（首段） | 否 |
| `personality` | 性格 | 性格特质、情绪倾向、说话风格 | `data.personality` | 否 |
| `settings` | 其他设定 | 聊天输出格式、日常行为准则、语气要求 | `data.description`（第二段） | 是 |
| `special` | 特殊设定 | 剧情钩子、能力/限制、禁忌、彩蛋 | `data.description`（第三段） | 是 |
| `user` | 用户相关设定 | `{{user}}` 的身份、关系、称呼 | `data.description`（末段） | 是 |
| `worldbook` | 世界书 | 关键词触发的世界观条目 | `data.character_book` | 是 |

**为什么性格单独走 `personality` 而其余四块挤在 `description` 里**：
`personality` 是 SillyTavern 有独立输入框、且在「角色管理」里单独展示的字段；把它并入 description 会导致用户在 ST 里看到空的 personality 字段，属于质量退步。反过来，`basic/settings/special/user` 在 ST 侧没有任何对应字段，只能进 `description`，用标题分段。

**拼装顺序**固定为 `basic → settings → special → user`，`personality` 不参与 description 拼装。顺序由 `DESCRIPTION_BLOCK_IDS` 常量决定，预设格式只能改「标题写法与分隔符」，不能改顺序（避免不同预设产出结构漂移）。

## 2. 字段映射总表

| UnifiedCard | SillyTavern JSON | 说明 |
|---|---|---|
| `meta.name` | `data.name` + 顶层 `name` | V2 卡片顶层同时保留一份 V1 字段 |
| `meta.creator` | `data.creator` | |
| `meta.characterVersion` | `data.character_version` | |
| `meta.creatorNotes` | `data.creator_notes` | |
| `meta.tags` | `data.tags` | |
| `meta.spec` / `meta.specVersion` | `spec` / `spec_version` | `v1` 时两者都不写 |
| `blocks[basic/settings/special/user].text` | `data.description` 的分段 | 见第 3 节 |
| `blocks[personality].text` | `data.personality` | 一对一直传 |
| `worldbook.entries` | `data.character_book.entries[]` | 结构原样保留 |
| `worldbook.raw` | `data.character_book` 其余字段 | `name`/`scan_depth`/`token_budget`/`extensions` 等 |
| `residual.scenario` | `data.scenario` | |
| `residual.firstMes` | `data.first_mes` | |
| `residual.mesExample` | `data.mes_example` | |
| `residual.systemPrompt` | `data.system_prompt` | |
| `residual.postHistoryInstructions` | `data.post_history_instructions` | |
| `residual.alternateGreetings` | `data.alternate_greetings[]` | |
| `residual.groupOnlyGreetings` | `data.group_only_greetings[]` | V3 |
| `residual.nickname` | `data.nickname` | V3 |
| `residual.source` | `data.source` | V3 |
| `residual.creationDate` / `modificationDate` | `data.creation_date` / `data.modification_date` | V3 |
| `passthrough.data` | `data` 段中未建模的键 | 原样写回 |
| `passthrough.top` | 顶层未建模的键 | 原样写回（如 `avatar`、`chat`、`talkativeness`、未知扩展键） |

`residual` 里这些字段为什么不进板块：它们有独立语义（开场白、示例对话），TXT 分块里塞进去会让「按预设格式导出完整 TXT」语义混乱。它们由客户端右侧「其他字段」表单编辑，并参与审计。

## 3. 无损策略：偏移量补丁（核心）

朴素做法（解析成对象 → 再拼回字符串）会丢三类信息：原文的标题写法、非标准空白、板块外的自由文本。因此采用**保留原文 + 记录偏移量**：

```
description.raw = 原始字符串（导入时逐字保存）
blocks[i].raw   = 导入时该板块的正文（personality 用 raw 直接回写）
blocks[i].anchor = { field, headingText, headingSpan, bodySpan }
```

序列化时按块逐条判断：

| 情况 | 处理 |
|---|---|
| `dirty === false` 且有 anchor | 使用 `raw.slice(bodySpan.start, bodySpan.end)`，**逐字还原** |
| `dirty === true` 且有 anchor | 用新 `text` 替换 `bodySpan` 区间；标题行、前后空白不受影响 |
| 无 anchor（新建卡 / 新增板块） | 按 `DESCRIPTION_BLOCK_IDS` 顺序与 `description.separator` 拼接插入 |

三条规则保证：只改用户真正改过的字节；没动过的卡片导出后与原文件 `JSON.stringify` 语义一致（键序可能变化，值与文本不变）。

### 解析规则（阶段 2 实现，模型已预留）

1. 以行为单位扫描 `description`，识别形如 `【标题】`、`## 标题`、`[标题]` 的行（具体写法由当前预设格式定义，识别时接受全部内置变体）。
2. 标题文本归一化（去空白、去装饰符）后与六板块的 `defaultHeading` / 别名表比对；
3. 命中则开启新板块，`headingSpan` 覆盖整行（含行尾换行），`bodySpan` 从下一行起、到下一个标题行前止（去掉尾部多余空行，但记录在 `separator` 中）。

### 边界情况

| 情况 | 处理 |
|---|---|
| 导入 V1 卡片（无 `spec`/`data`） | 从顶层平铺字段读数，`meta.spec = 'v1'`；导出保持 v1 结构（除非规则 target 要求升级，此时提示用户） |
| 卡片 description 无任何标题 | `structure = false`，整段文本作为 `basic` 板块（anchor 覆盖全文），其余板块 `text` 为空、`anchor = null`；用户可在阶段 2 一键「按预设格式化」拆出结构 |
| 同一板块出现两次 | 第一次作为主块，第二次起并入同一个 `text`（中间用原文分隔符连接），保证内容不丢；审计给出 info 级「标题重复」提示 |
| 板块顺序与预设不一致 | 保留原文顺序（按 `headingSpan` 出现次序存入 `blocks` 数组），导出时不强制重排；仅当用户执行「应用预设」才重排 |
| description 含 `\r\n` | 解析时记录原始换行符到 `separator`，回写沿用，不做全局 normalize |
| 板块外的自由文本（第一个标题之前 / 最后一个板块之后） | 存入 `description.preface` 与对应块的尾部空白，不参与编辑区显示，但导出保留 |
| 世界书为空 | `worldbook.entries = []`，导出时 `character_book` 省略（V2 允许缺省） |

## 4. 世界书映射

- `character_book.entries[]` **原样保留**，包括未知的 `extensions`、`position` 为数字或字符串的差异。
- 六个板块中的「世界书板块」在编辑器里以 TXT 形式展示（格式在阶段 2 定义：以 `### 条目名` 起始，`keys:` / `content:` 两个必填小字段，其余字段进 `meta:` 行）。由 TXT 反解析回 `StWorldbookEntry` 时，未在 TXT 中出现的字段从 `worldbook.raw` 的同 id 条目回填，保证不丢字段。
- 条目 id 缺失时按数组下标补齐（ST 行为一致）。

## 5. passthrough 的边界

- 只收集「模型不认识的键」，不做深合并；`passthrough.data.extensions` 与 `data.extensions` 是同一对象，序列化时写回原位。
- `meta.spec` 决定写 V1 还是 V2/V3 结构；写 V2/V3 时，顶层同时输出 V1 兼容字段（`name`/`description`/`personality`/`scenario`/`first_mes`/`mes_example`），与 SillyTavern 自身导出行为一致。

## 6. 已确认的设计口径（2026-10-21 需求方确认）

1. **「性格」独占 `data.personality`**：性格板块只写 `personality` 字段，不重复出现在 description 中。已按此实现，并有 round-trip 测试覆盖（`test/roundtrip.test.mjs`）。
2. **TXT 板块标题允许用户改文案**：解析时走别名表（`【基本信息】`/`## 基本信息`/`[基本信息]`/`**基本信息**` 及同义写法均可识别），导出时沿用用户改后的标题，不强行还原默认文案。

## 7. 已实现的 API（阶段 1）

| 函数 | 位置 | 说明 |
|---|---|---|
| `parseStCard(input)` / `parseStCardText(text)` | `format/sillytavern-io.ts` | 解析任意版本卡片为 UnifiedCard；返回 `issues` 记录降级情况（如缺 data 段、character_book 无 entries） |
| `serializeStCard(card, options)` | 同上 | 输出 ST JSON；`legacyTopLevel: 'sync' \| 'preserve'` 控制顶层 V1 副本策略，`targetSpec` 可强制导出版本 |
| `stringifyStCard(card, options)` | 同上 | 带缩进的 JSON 字符串，可直接写文件 |
| `parseDescription(raw)` | `format/description.ts` | 拆出四个 description 板块的 anchor（标题行、正文区间） |
| `assembleDescription(blocks, doc, options)` | 同上 | 区间替换 + 定点插入，未改动字节逐字还原 |
| `renderWorldbookText(entries)` | `format/worldbook.ts` | 世界书只读 TXT 渲染（双向解析在阶段 2） |

`legacyTopLevel` 的两种口径：

- `sync`（默认，保存/导出使用）：顶层 `name/description/personality/scenario/first_mes/mes_example` 按模型重新生成，避免导出后出现「data 里是新的、顶层还是旧的」；
- `preserve`（仅校验用）：沿用导入时的原文副本，`serializeStCard(parseStCard(x), {legacyTopLevel:'preserve'})` 必须与 `x` 深度相等——这是 round-trip 测试的断言方式。

补充（阶段 2）：

- `CardBlock.missing?: boolean`：仅当「导入源里根本没有这个板块的标题」时置 `true`（宽松模式填充的空块）。
  正常存在但正文为空的板块为 `false`——二者的区别必须能在 UI 上区分，不允许无声清空。
- 世界书板块：`worldbook.text` 是 v1.0 格式的可编辑 TXT（`renderWorldbookText`），
  `worldbook.entries` 是结构化数据；保存时按 `mergeWorldbookEntries` 以 **TXT 为事实源**合并，
  `extensions` 等机器字段按 `entry.id` 挂回。详见 docs/04。
