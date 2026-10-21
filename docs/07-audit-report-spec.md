# 07 · 审计报告规范（T4.1–T4.4）

阶段 4 的完整交付说明：字数统计、字段完整性、格式规范检查，以及最终产出的结构化审计报告。
报告是**纯 JSON**（无函数、无 `Map`），可直接落盘、可跨进程传输——服务端 T5.3 与客户端编辑器复用同一份实现与同一份数据。

- 实现：`shared/src/audit/{word-count,st-defaults,format,report,issue,types}.ts`
- 范例报告：[`docs/assets/audit-report-sample.json`](assets/audit-report-sample.json)（`npm run gen:audit-sample` 重新生成）
- 测试：`test/audit.test.mjs`（19 例）

---

## 1. 三类消费方，一份数据

| 消费方 | 怎么用 |
|---|---|
| 编辑器实时提醒 | 按 `location.blockId` 取自己那几条，用 `start/end` 在编辑区打标记 |
| 审计面板 | 按 `severity` / `category` 分组，`describeIssueLocation()` 出「板块 · 第 N 行第 M 列」 |
| 导出前拦截 | 只看 `summary.exportable`（无 error 即为 true），弹出「仍要导出 / 取消」 |

三者看到的是**同一个 `issues` 数组**，不存在「面板显示 3 条、编辑区显示 5 条」的可能。

---

## 2. 报告结构（逐字段）

```
AuditReport
├── schemaVersion  1
├── generatedAt    ISO 8601（可注入，见 AuditOptions.now，便于报告可复现）
├── card           { name, spec, specVersion, source }
├── platformRule   { id, name?, version?, lineage? }
├── presetId       当前 TXT 预设 id（未给预设时为 null）
├── wordCount      见 §3
├── issues[]       见 §4 / §5
├── summary        { error, warning, info, exportable }
└── byCategory     { completeness, format, platform-rule, structure }
```

`AuditReport` 与 `AuditIssue` 的 TypeScript 定义在 `shared/src/audit/types.ts`。

---

## 3. 字数统计（T4.1）

### 3.1 计数口径

全部按**码点**计（emoji 不会算成 2 个字），与 `text/count.ts` 完全一致：

| 字段 | 含义 |
|---|---|
| `chars` | 含空白的字符数 |
| `charsNoSpace` | 不含空白的字符数（**长度规则用的就是这个口径**） |
| `cjk` | 中日韩字符数 |
| `words` | 拉丁/数字词数 |
| `totalWords` | 「字数」= `cjk + words`（中文一字一词，英文一词一计） |

**世界书特殊处理**：按 `entries` 的 `keys + content` 统计，而不是按 TXT 文本——
`@@ENTRY` / `keys:` 这类标记不属于角色卡内容，计入会虚高。
只有当 `entries` 为空、但 TXT 非空（用户刚编辑尚未解析）时才退化为按 TXT 统计。

### 3.2 分布样例一：示例卡（`test/fixtures/sample-card.json`，干净卡）

| 板块 | chars | 不含空白 | CJK | 拉丁词 | 字数 |
|---|---:|---:|---:|---:|---:|
| 基本信息 | 96 | 90 | 57 | 6 | 63 |
| 性格 | 40 | 40 | 35 | 0 | 35 |
| 其他设定 | 84 | 80 | 61 | 4 | 65 |
| 特殊设定 | 52 | 52 | 30 | 2 | 32 |
| 用户相关设定 | 43 | 43 | 15 | 3 | 18 |
| 世界书 | 79 | 73 | 53 | 2 | 55 |
| **合计** | **394** | **378** | **251** | **17** | **268** |

按落盘字段口径：`description` 275 / `personality` 40 / `character_book` 79。

### 3.3 分布样例二：范例报告里的问题卡

| 板块 | chars | 不含空白 | CJK | 拉丁词 | 字数 |
|---|---:|---:|---:|---:|---:|
| 基本信息 | 23 | 21 | 11 | 2 | 13 |
| 性格 | 14 | 14 | 12 | 0 | 12 |
| 其他设定 | 16 | 15 | 8 | 1 | 9 |
| 特殊设定 | 7 | 7 | 6 | 0 | 6 |
| 用户相关设定 | 25 | 24 | 14 | 1 | 15 |
| 世界书 | 38 | 36 | 33 | 0 | 33 |
| **合计** | **123** | **117** | **84** | **4** | **88** |

每个板块还带 `empty`（正文为空）与 `missing`（**导入源里根本没有该板块标题**）两个布尔，
UI 必须把 `missing: true` 显示成「缺失、已按空处理」，不能和「存在但为空」混为一谈（阶段 2 定的原则）。

### 3.4 API

```ts
countCardWords(card) → WordCountReport   // 六板块 + 合计 + byField
countBlockWords(card, 'basic') → WordCountTotal
countWorldbook(card) → { total, from: 'entries' | 'text' }
```

---

## 4. 问题来源与严重级（T4.2 / T4.3 / 平台规则）

| category | 来源 | 典型 ruleId |
|---|---|---|
| `completeness` | 字段完整性（T4.2） | `builtin:field-required:meta.name` |
| `format` | JSON 合法性、预设符合性、世界书格式、缺省字段（T4.3） | `builtin:json-invalid`、`builtin:preset-heading-alias`、`builtin:worldbook-duplicate-id`、`builtin:st-defaults-omitted` |
| `platform-rule` | 平台规则内容检查（阶段 1 引擎） | 规则文件里作者自定义的 id，如 `forbid-angle-tags` |
| `structure` | 结构性缺失 | `builtin:description-unstructured`、`builtin:block-missing` |

| severity | 语义 |
|---|---|
| `error` | 阻断导出（`summary.exportable = false`），弹窗需用户确认 |
| `warning` | 只提醒，不拦截 |
| `info` | 建议级，折叠展示 |

### 4.1 两级字段语义（T4.2，沿用阶段 3 已落地的决定）

| 情形 | 严重级 | 例子 |
|---|---|---|
| 平台必填、**无 ST 缺省值**的字段缺失 | `error` | `name` 为空 → 「JanitorAI 角色名不能为空」 |
| **有 ST 缺省值**的字段未写出 | `info`（忽略作者写的 severity） | `constant`、`insertion_order` 未写 → 「导出时由目标平台按缺省值处理」 |

两级语义**只作用于「缺失」**：字段写了但不合长度/正则，仍按规则作者指定的 `severity` 正常报。

### 4.2 T4.3 对缺省字段的处理（明确定义）

1. 缺省字段清单集中在 `shared/src/audit/st-defaults.ts`（`ST_DEFAULT_FIELDS`），
   分 `card` / `book` / `entry` 三级，共 15 项（`talkativeness`、`fav`、`constant`、`selective`、
   `insertion_order`、`enabled`、`position`、`case_sensitive`、`priority`、
   `scan_depth`、`token_budget`、`recursive_scanning`、`extensions`）。
2. `collectOmittedDefaults(card)` 找出未写出的项；条目级字段**只要任一条目缺失就列出**，
   并给出 `entryIds` 与 `count`（不逐条刷屏）。
3. `checkStDefaults(card)` 把结果**汇总成一条 info**，
   `category: 'format'`、`ruleId: 'builtin:st-defaults-omitted'`、位置为 `field: 'file'`。
4. **绝不报 error、绝不计入 `exportable=false`、绝不回写 JSON**——
   写回会制造版本 diff 噪声，违背阶段 2「解析端不注入缺省值」的决定。
5. 可通过 `AuditOptions.includeStDefaults: false` 整体关闭（服务端批量审计时用）。

**验证证明**（`test/audit.test.mjs` 第 6 例，卡片故意不写 `constant` / `selective` / `insertion_order` / …）：

```
collectOmittedDefaults → 含 talkativeness / fav / constant(count=2, entryIds=[0,1]) / selective / insertion_order …
checkStDefaults        → 1 条，severity = 'info'
buildAuditReport       → summary.error = 0，exportable = true
序列化后的 entries     → 仍然不含 "constant" / "insertion_order"（没有回写）
```

### 4.3 T4.3 其余检查

| 检查 | 严重级 | 说明 |
|---|---|---|
| 原始 JSON 不可解析 | `error` | 给了 `rawJsonText` 就先验证它；失败直接返回，不跑后续检查 |
| 序列化产物不是合法 JSON | `error` | 通常是 passthrough 里混入了 `undefined` / `BigInt` / 循环引用 |
| 未编辑时 description 重新拼装 ≠ 原文 | `warning` | `builtin:description-drift`，说明保存会改动未编辑的字节 |
| description 未分块 | `warning` | 六个板块无法分别定位 |
| 板块在导入源中没有标题 | `warning` | `block.missing === true`，**不是**内容为空 |
| 标题别名不在当前预设中 | `warning` | 换预设导入会识别不到该板块；hint 给出可用别名 |
| 标题装饰符与预设不一致 | `info` | 解析不受影响；hint 提醒「换预设记得同步改高亮方案的标题正则」 |
| 板块顺序与预设不一致 | `info` | **导出不主动重排**，只有点「应用预设」才重排（阶段 2 决定） |
| 分隔符与预设不一致 | `info` | 同上 |
| 世界书 TXT 语法错误（重复 id / 缺 `@@END` / …） | 按解析器严重级 | 重复 id 为 `error`，带行号与偏移，禁止静默合并 |
| 结构化条目 id 重复 | `error` | TXT 尚未重新渲染时也能查出来 |

---

## 5. 位置契约（T4.4，客户端「点击定位」）

**每条问题的 `location` 都完整给出下列键，无法定位的维度写 `null`，绝不省略键——
客户端不需要处理 `undefined`。**

```jsonc
"location": {
  "blockId":  "special",            // 板块；不属于任何板块时为 null
  "field":    null,                 // ST 字段（name / first_mes / character_book…）；板块内文本为 null
  "start":    12,  "end":   17,     // 相对该板块正文的字符偏移（可直接 setSelectionRange）
  "line":     3,   "column": 1,     // 1-based 行列（列号按码点计，emoji 算 1 列）
  "lineText": "<BOT> 出现在第三行",  // 整行原文，可整行高亮
  "excerpt":  "<BOT>",              // 命中片段（最长 80 字符）
  "entryId":  null                  // 世界书问题指向的条目 id
}
```

| 问题类型 | blockId | field | start/end | line/column | 面板文案 |
|---|---|---|---|---|---|
| 板块内违规 | 有 | `description` / `personality` / `character_book` | 有 | 有 | `特殊设定 · 第 3 行第 1 列` |
| 字段级（完整性等） | `null` | 有 | `0/0` | `1/1` | `开场白` |
| 全文合计（`aggregate: true`） | `null` | `null` | `null` | `null` | `全文` |
| 世界书 TXT 语法错误 | `worldbook` | `character_book` | 整行区间 | 有 | `世界书 · 第 7 行第 1 列` |

辅助函数：

```ts
describeIssueLocation(issue)  // 「特殊设定 · 第 3 行第 1 列」/「全文」/「角色名」
groupIssues(issues)           // { byBlock: Map, byField: Map, unscoped: [] }
filterBySeverity(issues, 'warning')
sortIssues(issues)            // 板块顺序 → 严重级 → 偏移 → id，保证面板顺序稳定
```

`aggregate` 问题的 `location` 全为 `null` 且带 `aggregate: true`，**分组时落在 `unscoped`**，
不会出现「同一个全文问题被算到第一个板块头上」。

---

## 6. API

```ts
import {
  countCardWords, countBlockWords, countWorldbook,          // T4.1
  collectOmittedDefaults, isStDefaultField, stDefaultValueOf, // T4.3 缺省字段
  checkJsonValidity, checkPresetConformance,
  checkWorldbookFormat, checkStDefaults, checkFormat,        // T4.3
  buildAuditReport, stringifyAuditReport, sortIssues,
  summarizeIssues, filterBySeverity,                         // T4.4
  describeIssueLocation, groupIssues,
} from '@tcs/shared';

const report = buildAuditReport(card, {
  platformRule,        // 不给则跳过「内容是否符合平台规则」
  preset,              // 不给则跳过「TXT 分块是否符合预设」
  rawJsonText,         // 给了就额外验证原始文件可解析
  includeStDefaults,   // 默认 true
  now: () => fixed,    // 注入时间戳，让报告可复现（测试 / 快照对比用）
});
```

---

## 7. 完整范例

[`docs/assets/audit-report-sample.json`](assets/audit-report-sample.json) 是一份刻意构造的「问题卡」报告
（`npm run gen:audit-sample` 重新生成），10 条问题覆盖四类来源：

```
error    platform-rule  其他设定 · 第 1 行第 1 列   bbcode-fake-tag             <BOT>/<USER> 伪标签
error    platform-rule  其他设定 · 第 1 行第 1 列   forbid-angle-tags           JanitorAI 不识别伪标签
error    platform-rule  全文                       char-placeholder-required   全文合计 0 次，至少 1 次
error    completeness   角色名                     builtin:field-required:meta.name
error    format         世界书 · 第 7 行第 1 列     builtin:worldbook-duplicate-id
warning  platform-rule  世界书 · 第 1 行第 1 列     worldbook-not-supported
info     platform-rule  基本信息 · 第 1 行第 1 列   char-placeholder-suggested
info     platform-rule  其他设定 · 第 1 行第 1 列   char-placeholder-suggested
info     format         用户相关设定 · 第 1 行第 1 列 builtin:preset-heading-decorator
info     format         文件                       builtin:st-defaults-omitted
```

`summary = { error: 5, warning: 1, info: 4, exportable: false }`。

其中「全文合计」那条是 `aggregate: true` 的样例（`location` 全 null），
「世界书 · 第 7 行」那条同时给出偏移 `start: 57 / end: 66` 与 `entryId: 0`——客户端可直接选中整行。

---

## 8. 检查清单（新增内置检查时）

1. 位置必须填满：能给偏移就给偏移，只能给行号就用 `line`，两者都没有就明确 `null` 并让 `blockId`/`field` 至少有一个非空；
2. 严重级先问「会不会丢数据」——会丢就 `error`，只是建议就 `info`；
3. 有 ST 缺省值的字段**永远不要**报 error（见 §4.2）；
4. `ruleId` 内置检查一律 `builtin:` 前缀，平台规则用作者自定义 id，两者靠前缀区分 `category`；
5. 报告必须保持纯 JSON（不要往里塞 `Map`、函数、`undefined`）。
