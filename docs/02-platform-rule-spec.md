# 02 · 平台规则 JSON 字段说明与编写指南（T0.4）

配套文件：`rules/schema/platform-rule.schema.json`（结构校验）、`rules/platforms/*.json`（五份范例）。

平台规则**只约束内容层写法**，不改变角色卡的文件格式。文件格式永远是 SillyTavern 原生 JSON；规则回答的是「这段文字该不该出现 `{{char}}`」「字段能不能空」「有没有用平台不认的伪标签」这类问题。

## 1. 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schemaVersion` | integer | 是 | 固定 `1`。用于未来格式升级时的兼容判断 |
| `id` | string | 是 | 唯一标识，`^[a-z0-9][a-z0-9._-]{1,63}$`。内置 id：`sillytavern`、`ccv2`、`ccv3`、`janitorai`、`chub` |
| `name` | string | 是 | 界面显示名，≤64 字符 |
| `version` | string | 是 | 语义化版本 `x.y.z`；改规则就递增，服务端比对版本可提示更新 |
| `description` | string | 否 | 规则说明，≤2000 字符。建议写清「该平台限制来自哪里」 |
| `extends` | string \| null | 否 | 父规则 id。先应用父规则，再用本文件**同名 id** 的规则覆盖，`fields`/`autoFix` 按 id/类型追加 |
| `target` | object | 是 | 导出目标规范，见下 |
| `placeholders` | object | 是 | 占位符词表，见下 |
| `fields` | array | 是 | 字段完整性要求，可为 `[]` |
| `rules` | array | 是 | 内容规则，可为 `[]` |
| `autoFix` | array | 否 | 切换平台时的自动适配操作 |
| `metadata` | object | 否 | `author` / `homepage` / `license` / `updatedAt`，仅展示用 |

### 1.1 `target`

| 字段 | 说明 |
|---|---|
| `spec` | `v1` / `v2` / `v3` / `any`。决定保存与导出时写哪种结构：`v1` 平铺字段；`v2` → `spec: "chara_card_v2"`；`v3` → `spec: "chara_card_v3"`；`any` 表示沿用卡片原有版本（不做升降级） |
| `specVersion` | 写入 `spec_version` 的字符串，如 `"2.0"`、`"3.0"`。`spec: any` 时忽略 |

> 规则切换只改「内容 + 目标结构」，不会自动删字段。降级（v3 → v2）会丢弃 `assets` 等 V3 专有字段，此时审计面板给出 warning。

### 1.2 `placeholders`

| 字段 | 类型 | 说明 |
|---|---|---|
| `char` | string[] | 角色占位符的**全部合法写法**，按优先级排序，第一个是主写法。如 `["{{char}}", "<BOT>"]` |
| `user` | string[] | 用户占位符的全部合法写法，第一个是主写法 |
| `custom` | object | 其他占位符：键为自定义名（`^[a-zA-Z][a-zA-Z0-9_]{0,31}$`），值为写法数组。规则中以 `custom:键名` 引用 |

两个用途：
1. **校验**：`placeholder-min-count` 统计时把这些写法都算作命中；
2. **平台切换适配**（T1.4）：从 A 规则切到 B 规则时，把「A 的写法 − B 的写法」全部替换为「B 的主写法」。例如 `chub` → `janitorai`：`<BOT>` 不在 janitorai 的 char 列表里，于是被替换为 `{{char}}`。

## 2. 选择器（scope / appliesTo）

| 写法 | 含义 |
|---|---|
| `"*"` | 全部文本板块（basic / personality / settings / special / user / worldbook） |
| `"block:basic"` | 指定板块。可用 id：`basic`、`personality`、`settings`、`special`、`user`、`worldbook` |
| `"field:first_mes"` | 指定 SillyTavern 原生字段。可用名：`name`、`description`、`personality`、`scenario`、`first_mes`、`mes_example`、`creator_notes`、`system_prompt`、`post_history_instructions`、`alternate_greetings`、`character_book` |
| 数组 | 任一命中即生效，如 `["block:basic", "block:settings"]` |

**选择器与板块的对应关系**（同一个内容可能被两条路径命中，引擎按「首次命中即报」去重）：

| 选择器 | 实际取到的文本 |
|---|---|
| `block:basic` / `block:settings` / `block:special` / `block:user` | 该板块 `text` |
| `block:personality` | 同 `field:personality` |
| `block:worldbook` | 世界书板块的 TXT 表示（非 JSON） |
| `field:description` | 四个 description 板块按序拼接后的全文 |
| `field:character_book` | 世界书 TXT 表示（`length` 规则的 `max: 0` 可用于表达「平台不支持世界书」） |

## 3. `fields[]` 字段完整性

```json
{
  "path": "meta.name",
  "label": "角色名",
  "required": true,
  "minLength": 1,
  "maxLength": 64,
  "severity": "error",
  "message": "角色名（name）不能为空"
}
```

| 字段 | 说明 |
|---|---|
| `path` | ST 原生字段名（`name`/`description`/`first_mes`/…）或模型路径（`meta.name`/`meta.creator`/`meta.characterVersion`/`meta.creatorNotes`/`meta.tags`/`alternate_greetings`/`group_only_greetings`） |
| `label` | 展示名，出现在问题列表 |
| `required` | 必填。为 `true` 且内容为空 → 报 `severity` 级问题 |
| `minLength` / `maxLength` | 按**非空白字符**计数。`meta.tags` 这类数组字段按元素个数计 |
| `pattern` + `flags` | 内容必须整体或局部命中该正则；`flags` 只支持 `gimsuy`，校验时忽略 `g`/`y` |
| `severity` | `error`（阻断导出，需用户确认）/ `warning` / `info`。缺省 `error` |
| `message` | 自定义文案，缺省用内置模板「{label} 不符合 {path} 的要求」 |
| `stDefault` | 该字段在目标规范里**有缺省值**。为 `true` 时，字段「未写出」不算缺陷，最多 `info` 级提示（见 §3.1）。缺省 `false` |

### 3.1 字段完整性检查的两级语义（T4.2）

「必填字段缺失」有两种完全不同的性质，审计报告必须区分，否则用户会被一堆无法操作的 error 淹没：

| 情形 | 判定 | 严重级 | 例子 |
|---|---|---|---|
| **平台规范必填、且无缺省值**的字段缺失 | `required: true` 且 `stDefault` 不为 `true` | `error`（阻断导出） | `name`（角色名）、`first_mes`（开场白） |
| **有 ST 缺省值**的字段未写出 | `required: true` 且 `stDefault: true` | `info`（仅提示，不拦截） | `constant`、`insertion_order`、`extensions` 类机器字段 |

三条约束：

1. **两级只作用于「缺失」这一类问题**。字段写了但长度/正则不合要求，仍按 `severity` 正常报（缺省 `error`）——那是用户主动写错的，不是缺省值问题。
2. **`stDefault: true` 时忽略 `severity` 的 error/warning 设置**，固定降级为 `info`。规则作者若想让缺省字段参与拦截，就把 `stDefault` 去掉。
3. **与解析端「不注入缺省值」联动**：世界书 TXT 解析器（docs/04 §3.2）刻意不给 JSON 补 `constant: false` 这类缺省键。理由是避免服务端版本 diff 噪声、保证可见字段 round-trip 严格相等、缺省语义本就由 SillyTavern 运行时负责。既然解析端不补，审计端就不能把「没写」算成 error，否则同一份卡片会被自己的工具链判为不合格。

写法示例（世界书条目字段，缺失只提示）：

```json
{ "path": "character_book", "label": "世界书条目开关", "required": true, "stDefault": true,
  "message": "条目未写出 constant / insertion_order，导入 SillyTavern 后按缺省值处理" }
```

## 4. `rules[]` 内容规则

所有规则共享的字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 文件内唯一；`extends` 时**同名 id 覆盖父规则** |
| `type` | 是 | 见下表 |
| `message` | 是 | 问题描述，≤300 字符 |
| `scope` | 是 | 选择器（第 2 节） |
| `severity` | 是 | `error` / `warning` / `info` |
| `hint` | 否 | 修复建议，显示在问题条目下方 |
| `enabled` | 否 | 默认 `true`；`false` 时跳过（用户可在 UI 临时关闭单条规则） |

### 4.1 规则类型语义

| type | 专属字段 | 判定逻辑 | 典型用途 |
|---|---|---|---|
| `placeholder-min-count` | `token`、`min`、`max?`、`aggregate?` | 统计 scope 文本中该占位符**所有合法写法**的出现次数；`< min` 或 `> max` 报问题 | JanitorAI 强制 `{{char}}` |
| `placeholder-forbid` | `token` | 出现任意合法写法即报 | 某平台禁用某占位符 |
| `pattern-forbid` | `pattern`、`flags?` | 正则命中即报，`message` 会与命中片段一起展示 | 禁止 `<BOT>` 伪标签、禁止 HTML |
| `pattern-required` | `pattern`、`flags?`、`min?`、`aggregate?` | 命中次数 `< min`（默认 1）报问题 | 示例对话必须有 `<START>` |
| `length` | `min?`、`max?`、`unit?` | 计数后越界即报。`unit: "char"`（默认，不含空白）/ `"word"`（拉丁词 + CJK 字） | 描述过短、开场白超长 |
| `non-empty` | — | scope 文本去空白后为空即报 | 板块必填 |
| `forbidden-words` | `words`、`caseSensitive?` | 命中词表任一词即报（字面量，非正则） | 平台禁用词、违禁题材提示 |

### 4.2 严重级语义（参与导出拦截）

- `error`：导出前审计若存在，弹窗「仍要导出 / 取消」（对应 T6.6）；
- `warning`：只提醒，不拦截；
- `info`：建议级，折叠展示。

### 4.3 scope 是「逐个检查」还是「合计检查」

默认**逐个检查**：`scope: ["block:basic", "block:settings"]` 表示「每个板块都要满足」。这适合「每个板块都该用 `{{char}}`」这类要求，问题定位也最精确（能精确到某个板块的第几行）。

需要「全文合计」时给规则加 `"aggregate": true`：把所有 scope 文本拼起来统计一次，不满足时问题报在第一个 scope 上（带当前次数）。内置的 JanitorAI 规则就是合计口径——它只要求全卡出现 `{{char}}`，不要求每个板块都有。

```json
{ "id": "char-at-least-2", "type": "placeholder-min-count", "token": "char",
  "min": 2, "aggregate": true, "scope": ["block:basic", "block:special"],
  "severity": "error", "message": "全文至少出现 2 次 {{char}}" }
```

### 4.4 校验实现的两种口径

| 场景 | 实现 | 说明 |
|---|---|---|
| 命令行 / CI | `scripts/validate-rules.mjs`（Ajv + JSON Schema） | 权威校验，覆盖 `allOf/if-then` 等全套约束 |
| 运行时（客户端 / 服务端加载规则） | `parsePlatformRule()`（`shared/src/rules/platform-rule-parser.ts`） | 轻量镜像校验：必填、枚举、正则可编译、选择器语法、占位符引用。不引入 Ajv，安装包更小、启动更快 |

两者对同一份文件应给出一致结论；如果出现分歧，以 Schema 为准并修正运行时校验。

## 5. `autoFix[]` 平台切换适配

```json
{ "type": "replace-regex", "pattern": "<(?:BOT|CHAR)>", "flags": "gi", "replacement": "{{char}}" }
```

| type | 字段 | 说明 |
|---|---|---|
| `replace-text` | `from`、`to`、`caseSensitive?` | 字面量替换（自动转义正则元字符） |
| `replace-regex` | `pattern`、`flags?`、`replacement` | 正则替换，支持 `$1` 捕获组 |
| `trim` | — | 去掉首尾空白与多余空行 |

通用字段：`scope`（默认全部板块）、`ruleId`（仅当该规则当前报错时才执行此修复）。

**执行时机**：切换平台规则时，先跑一次新规则校验 → 若存在 `autoFix` 能消除的问题，列出「将要执行的替换」清单和影响条数 → 用户确认后执行 → 重新校验。**绝不静默改写用户文本**。

## 6. 继承（extends）语义

1. 解析顺序：`根 → … → 自身`，即父规则先应用；
2. `rules`：按 `id` 合并，子覆盖父；
3. `fields`：按 `path` 合并，子覆盖父；
4. `autoFix`：追加（父在前），按 `ruleId + type + pattern` 去重；
5. `placeholders`：**整体替换不合并**（避免出现两边都「合法」的暧昧状态）；
6. `target`：子覆盖父；
7. 形成环时加载失败并报错（`validate-rules.mjs` 已检查）。

## 7. 校验流程（引擎伪代码，阶段 1 实现）

```
resolve(ruleId) → 合并继承链，得到 ResolvedPlatformRule
for each field in resolved.fields:
    value = readByPath(card, field.path)
    if field.required && isEmpty(value)            → report(error|warning)
    if minLength/maxLength 越界                    → report
    if pattern 不命中                              → report
for each rule in resolved.rules where enabled:
    for each text in collectTexts(card, rule.scope):   // 带 blockId / offset 映射
        evaluate(rule, text) → issues（含 offset 精确定位）
issues.sort(by blockId, offset) → 同时供编辑区（Decoration）与审计面板使用
```

**定位要求**：每条问题必须能给出 `blockId` + `start/end`（相对该板块文本的偏移），否则问题列表点击无法跳转。`field:*` 选择器若跨多个板块（如 `field:description`），按其覆盖的板块拆分定位。

## 8. 编写一套自定义平台规则（示例：某平台强制「只用 `{{char}}` 且禁止硬编码角色名」）

```json
{
  "schemaVersion": 1,
  "id": "my-platform",
  "name": "我的私有平台",
  "version": "1.0.0",
  "description": "强制 {{char}}/{{user}} 占位符，禁止伪标签。",
  "extends": "sillytavern",
  "target": { "spec": "v2", "specVersion": "2.0" },
  "placeholders": {
    "char": ["{{char}}"],
    "user": ["{{user}}"]
  },
  "fields": [
    { "path": "meta.name", "label": "角色名", "required": true, "maxLength": 40, "severity": "error" },
    { "path": "first_mes", "label": "开场白", "required": true, "minLength": 30, "severity": "error" }
  ],
  "rules": [
    {
      "id": "char-required",
      "type": "placeholder-min-count",
      "token": "char",
      "min": 2,
      "scope": ["block:basic", "block:settings", "block:special"],
      "severity": "error",
      "message": "本平台要求正文至少出现 2 次 {{char}}",
      "hint": "把写死的角色名替换为 {{char}}。"
    },
    {
      "id": "no-pseudo-tag",
      "type": "pattern-forbid",
      "pattern": "<\\s*(BOT|USER|CHAR)\\s*>",
      "scope": "*",
      "severity": "error",
      "message": "不允许 <BOT>/<USER> 伪标签"
    }
  ],
  "autoFix": [
    { "type": "replace-regex", "pattern": "<\\s*(?:BOT|CHAR)\\s*>", "flags": "gi", "replacement": "{{char}}" }
  ]
}
```

保存到 `rules/platforms/my-platform.json` 后运行 `npm run validate:rules`，通过即可在客户端「平台规则」下拉里看到。

## 9. 内置五份规则的差异速查

| 规则 | target | 世界书 | `{{char}}` 要求 | 特有检查 |
|---|---|---|---|---|
| `sillytavern` | any | 支持 | info 提示 | 占位符多余空格、未知宏</br>（最宽松，作为其他规则的基类） |
| `ccv2` | v2 / 2.0 | 支持 | warning | 禁 `<BOT>` 类伪标签（error） |
| `ccv3` | v3 / 3.0 | 支持 | warning | `mes_example` 需含 `<START>` |
| `janitorai` | v2 / 2.0 | **不支持**（warning：会丢失） | **error** | 禁 `[BOT]`/HTML 标签、描述≥20 字 |
| `chub` | v2 / 2.0 | 支持 | 建议统一写法（warning） | 需作者与标签、`<START>` 检查 |
