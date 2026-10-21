# 03 · 语法高亮规则 JSON 字段说明与编写指南（T0.5 规范 / T3.4 文档交付）

配套文件：

| 文件 | 作用 |
|---|---|
| `rules/schema/highlight-rule.schema.json` | JSON Schema（draft-07），命令行 `npm run validate:rules` 用 Ajv 做完整结构校验 |
| `rules/highlight/default.json` | **内置默认范例**（纸墨风，11 个样式 / 14 条规则），首次启动自动载入 |
| `rules/highlight/minimal.json` | **最小可用范例**（2 个样式 / 2 条规则），改写自定义方案的起点 |
| `rules/highlight/dark.json` | **继承范例**（`extends: "default"`，只覆盖配色 + 追加 1 条规则） |
| `shared/src/rules/highlight-rule-parser.ts` | T3.1 加载与校验（运行时轻量校验，不依赖 Ajv） |
| `shared/src/highlight/highlight-engine.ts` | T3.2 渲染引擎 |
| `shared/src/highlight/highlight-io.ts` | T3.3 导入 / 导出 |

高亮规则回答一个问题：**编辑器里哪段文字用什么样式显示**。它是纯展示层配置，不影响角色卡数据，也不做内容校验（校验是平台规则的事）。正因为两件事分开，同一份内容可以在「JanitorAI 规则」下被校验、在「深色高亮」下被渲染。

---

## 1. 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schemaVersion` | integer | 是 | 固定 `1` |
| `id` | string | 是 | 唯一标识，`^[a-z0-9][a-z0-9._-]{1,63}$` |
| `name` | string | 是 | 显示名，如「默认（纸墨风）」 |
| `version` | string | 是 | 语义化版本 `x.y.z` |
| `description` | string | 否 | 说明与适用场景（≤2000 字符） |
| `extends` | string \| null | 否 | 父规则集 id；子集在其基础上追加规则、覆盖同名规则/样式。缺省视为不继承 |
| `editor` | object | 否 | 排版参数：`fontFamily`、`fontSize`(8-48)、`lineHeight`(1-3)、`tabSize`(1-8 整数) |
| `theme` | object | 是 | `foreground`、`background`（必填）、`caret`、`selectionBackground`（可选） |
| `scopes` | array | 是 | 样式定义，至少 1 条 |
| `rules` | array | 是 | 匹配规则，可为 `[]` |
| `metadata` | object | 否 | `author` / `homepage` / `license` / `updatedAt` |

### 1.1 颜色写法

支持 `#RGB`、`#RRGGBB`、`#RRGGBBAA`、`rgb()`、`rgba()` 与常见颜色名（正则 `^(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|[a-zA-Z]{3,20})$`）。

建议：主题使用浅底深字；需要深色方案时**另存一份规则集**（或用 `extends` 只改 theme），不要在同一份里混用。

### 1.2 排版参数（editor）

| 字段 | 范围 | 说明 |
|---|---|---|
| `fontFamily` | 字符串 | CSS `font-family`，例如 `"Sarasa Mono SC, Consolas, Menlo, monospace"` |
| `fontSize` | 8–48 | 字号（px） |
| `lineHeight` | 1–3 | 行高倍数 |
| `tabSize` | 1–8（整数） | Tab 宽度（空格数） |

`editor` 随规则集切换一起生效——换高亮方案会换排版，这是有意的（等宽 + 大行高更适合长文本校对）。

---

## 2. `scopes[]` —— 样式定义

```json
{ "id": "placeholder", "label": "占位符", "color": "#b0341b", "backgroundColor": "#fdece7", "bold": true }
```

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `id` | 是 | — | 样式 id（`^[a-z0-9][a-z0-9._-]{0,47}$`），规则用它引用；文件内唯一 |
| `label` | 是 | — | 中文说明，出现在「高亮规则预览」与规则管理列表 |
| `color` | 是 | — | 文字颜色 |
| `backgroundColor` | 否 | 不设背景 | 背景色；显式写 `null` 与不写等价 |
| `bold` | 否 | `false` | 加粗 |
| `italic` | 否 | `false` | 斜体 |
| `underline` | 否 | `false` | 下划线 |
| `strikethrough` | 否 | `false` | 删除线 |

校验器会对「文字色与背景色相同」给出 warning（实际不可读），但不会阻断加载。

---

## 3. `rules[]` —— 匹配规则

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `id` | 是 | — | 文件内唯一；`extends` 时**同名 id 覆盖父规则** |
| `scope` | 是 | — | 必须是 `scopes` 中已存在的 id（继承时可以是父级定义的 id） |
| `match` | 是 | — | 匹配方式，见 §3.1 |
| `priority` | 否 | `0` | `-1000..1000`，越大越优先 |
| `appliesTo` | 否 | 全部 | 选择器（与平台规则同一套语法）：`"*"` / `"block:<id>"` / `"field:<字段名>"`，可为数组（任一命中即生效） |
| `enabled` | 否 | `true` | `false` 时临时禁用，编译期直接剔除 |

### 3.1 四种匹配方式

| `match.type` | 专属字段 | 行为 |
|---|---|---|
| `regex` | `pattern`（必填）、`flags`（`gimsu`，默认 `g`）、`wholeLine`（默认 `false`） | JavaScript 正则。`wholeLine: true` 时把命中扩展到整行（不含行尾换行），适合标题与分隔线。引擎会自动补 `g`；不带 `g` 只给 warning |
| `word-list` | `words`（必填，非空）、`caseSensitive`（默认 `false`）、`wholeWord`（默认 `true`） | 关键字**字面量**匹配，内部自动转义正则元字符，不需要用户自己转义。`wholeWord` 只检查相邻字符是否为 `[A-Za-z0-9_]`，对中文无约束效果（中文相邻字符天然不是词字符） |
| `line-prefix` | `prefix`（必填，≤32） | 行首标记匹配，如 `"## "`；**只着色前缀本身**，不扩展到整行 |
| `delimiter-block` | `open`、`close`（必填）、`escape`（可选，单字符） | 成对分隔符内的整段，如 `{{`…`}}`。未闭合时**不报错**，只匹配到行尾；`escape` 用于跳过被转义的结束符 |

> 优先级提示：`delimiter-block` 比 `regex` 更不易写错（不用处理正则转义），凡是「成对符号包裹」的场景优先用它。

---

## 4. 冲突消解（决定同一段文字最终颜色）

多个规则命中同一段文字时，引擎按确定性规则裁决，**改 priority 或改声明顺序就能复现地改变结果**：

1. 先剔除 `enabled: false` 的规则；
2. 每条命中的候选区间按以下排序键排序（**顺序即优先级，逐个比较，前一个分出胜负就不再看后面**）：

   | 序 | 排序键 | 方向 | 含义 |
   |---|---|---|---|
   | 1 | `priority` | 降序 | 数值大者优先（作者显式指定） |
   | 2 | 命中长度 | 降序 | 同一优先级下，**更长的匹配优先**（`{{char}}` 压过只匹配 `{{` 的半截规则） |
   | 3 | **声明顺序** | **升序** | 前两键仍打平时，**先声明者优先**（数组中靠前的规则 id 赢） |
   | 4 | 起始偏移 | 升序 | 兜底，纯粹为了保证结果可复现 |

   第 3 条是**写死的决胜规则**：同优先级、同长度时，永远由 `rules[]` 里的声明顺序决定，
   引擎不依赖 `Object` 遍历序、不依赖正则执行序、也不依赖文本扫描序。
   想让某条规则赢，就把它写得更靠前，或给它更高的 `priority`——**不要依赖巧合**。

   由此得到的保证：**同一份规则文件 + 同一段文本 → 同一组着色区间**，逐字节可复现。
   客户端做增量渲染、服务端做快照对比都依赖这个确定性。
3. 按序**贪心接受**：与已占用区间重叠的部分被扣掉，**只保留未占用的片段**（区间占位模型）。
   一个候选可能被切成多段；若整段都被占用则丢弃；
4. 零长度匹配不产出（不参与着色，也不占用区间）；
5. 单次文本最多产出 4000 个区间（`MAX_SPANS`），防止病态正则把编辑器拖垮。

第 3 条的后果值得记住：**「已被高优先级规则占用」只保护那一小段，不吞掉整条低优先级匹配**。
例如 `她说「{{char}} 你来了」`：`{{char}}` 归 `placeholder`（priority 90），
`「` 与 ` 你来了」` 两段仍然归 `dialogue`（priority 50），而不是整句失去对话配色。
想要整句统一成一种颜色时，调 priority 或改用行级规则，不要指望「长匹配能压过短匹配」。

> `wholeLine: true` 的整行扩展以**命中的最后一个字符**所在行为准。
> `^\s*(?:[-=_*]\s*){3,}$` 这类正则会用 `\s*` 吃掉上一行末尾的换行，
> 若按 `match.index` 取行会得到空区间，因此引擎按 `end - 1` 定位行。

同一优先级下「更长的匹配优先」意味着 `{{char}}` 整段会压过只匹配到 `{{` 的半截规则；长度也相同才落到第 3 键（声明顺序）、第 4 键（起始偏移），两者同为兜底决胜键。

---

## 5. 加载与校验流程（T3.1 已实现）

```
读取 JSON
  → JSON.parse（失败：报「JSON 解析失败 — 原因」，不替换当前方案）
  → 结构校验：schemaVersion/id/name/version/theme/scopes 必填，取值区间
  → 语义校验：scope 引用存在、正则可编译、选择器语法、id 唯一、flags 合法
  → 继承合并（extends）：按 id 合并 scopes/rules，theme/editor 浅合并
  → 合并后复核 scope 引用（父级也没定义 → 报错）
  → compileHighlightRule：剔除禁用规则、预编译正则、排序
  → 应用到编辑器（theme / editor / Decoration）
```

- 运行时校验**不依赖 Ajv**（`parseHighlightRule`），离线安装包不必带它；命令行侧仍用 Ajv 按 Schema 做完整校验。
- 导入失败时**不破坏当前高亮**：`applyHighlightRuleImport(current, text)` 在失败分支原样返回 `current`，`replaced=false`，并给出「哪条规则、哪个字段」的具体错误。
- 支持多套规则并存与切换；切换只重建 Decoration，不重新加载文档。
- 内置三套，首次启动自动载入 `default`。

### 5.1 错误分级

| 级别 | 含义 | 例子 |
|---|---|---|
| error | 文件不可用，`file=null`，不替换当前方案 | `schemaVersion` 不为 1、`theme.foreground` 非法、引用未定义的 scope、正则无法编译、id 重复 |
| warning | 可加载，但值得提示 | 正则未带 `g`、关键字仅含空白、引用父级 scope（继承时合法）、文字色与背景色相同 |

---

## 6. 引擎 API（T3.2）

```ts
import {
  parseHighlightRule, loadHighlightRules, resolveHighlightRule, compileHighlightRule,
  computeHighlightSpans, tokenizeHighlight, renderInlineHtml, scopeCss,
  importHighlightRuleText, exportHighlightRuleText, applyHighlightRuleImport,
} from '@tcs/shared';

const { rules, errors } = loadHighlightRules([defaultJson, minimalJson, darkJson]);
const resolved = resolveHighlightRule('dark', rules);          // 合并 extends，lineage: ['default','dark']
const compiled = compileHighlightRule(resolved);               // 一次编译，多次复用

const spans = computeHighlightSpans(text, compiled, { blockId: 'basic' });
// → [{ start, end, scope, ruleId }]，按 start 升序、互不重叠

const segments = tokenizeHighlight(text, compiled);            // 含未着色段，拼接 == 原文
const html = renderInlineHtml(text, compiled);                 // 规则预览 / 导出样例
```

| 函数 | 说明 |
|---|---|
| `computeHighlightSpans(text, compiled, context)` | 核心：产出互不重叠的着色区间。`context.blockId` / `context.field` 用于 `appliesTo` 过滤 |
| `tokenizeHighlight(text, compiled, context)` | 切出连续片段（含未着色部分），拼接后与原文逐字相等 |
| `renderInlineHtml(text, compiled, context, options)` | 生成带 `class="tcs-hl tcs-hl-<scope>"` 与 `data-rule` 的 HTML，便于预览与调试 |
| `scopeCss(scope)` | 样式 → CSS 声明串，编辑器与 HTML 预览共用 |
| `ruleMatchesContext(item, context)` | 判断单条规则是否作用于当前板块/字段 |

`appliesTo` 的匹配规则：`*` 恒真；`block:<id>` 要求板块一致；`field:<name>` 要求字段名一致，且板块上下文会给出等价字段名（性格板块 ≡ `personality`，世界书 ≡ `character_book`，其余 description 板块 ≡ `description`）。

---

## 7. 导入 / 导出（T3.3）

```ts
const applied = applyHighlightRuleImport(currentRule, fileText);
// applied.ok === false 时：applied.file === currentRule，applied.replaced === false
const text = exportHighlightRuleText(rule);   // 2 空格缩进、尾随换行、字段顺序固定
```

- **导出字段顺序固定**：顶层 `schemaVersion → id → name → version → description → extends → editor → theme → scopes → rules → metadata`；`rules` 内 `id → scope → priority → match → appliesTo → enabled`；`match` 内 `type` 排最前。未知键原样保留在末尾，不会丢。
- 固定顺序的意义：版本 diff 干净、人工比对容易、导入导出 round-trip 可断言。
- 导入即校验，口径与运行时加载完全一致——不存在「能导入但用不了」的文件。

---

## 8. 内置范例一览

> **⚠ 范例与预设格式的耦合（重要）**
> 三份范例里的标题正则都写死了**装饰符**：`block-heading` 匹配 `^【[^】\n]{1,30}】\s*$`、
> `markdown-heading` 匹配 `^#{1,6}\s+.+$`、`bracket-heading` 匹配 `^\[[^\]\n]{1,30}\]\s*$`。
> 这些装饰符来自**默认 TXT 预设**（`rules/presets/default.json` 的 `headings.*.pattern = "【{title}】"`）。
> 一旦把预设换成 `##` 风格（`rules/presets/markdown.json`，`pattern = "## {title}"`）或自定义装饰符，
> **原方案里的 `block-heading` 会全部失配**，标题不再着色（不会报错，只是静默失效）。
> 更换预设装饰符后请同步调整方案的标题正则，或改用 `line-prefix` 配合新装饰符。
> 校验脚本 `npm run validate:rules` 不检查这项耦合（它无法得知当前预设），只能靠人工确认。

### 8.1 `default.json`（默认，纸墨风）

11 个样式：

| scope id | 展示名 | 用于 |
|---|---|---|
| `heading` | 板块/小节标题 | `【基本信息】`、`## 性格`、`[特殊设定]` |
| `subheading` | 小标题 | 预留（如 `### 条目`） |
| `placeholder` | 占位符 | `{{char}}`、`{{user}}` |
| `placeholder-custom` | 其他宏 | `<BOT>`、`<USER>`（伪标签一眼可见，便于清理） |
| `dialogue` | 对话 | `"…"`、`「…」`、`『…』` |
| `action` | 动作/旁白 | `（…）`、`(…)` |
| `emphasis` | 强调 | `**…**` |
| `attribute` | 档案字段名 | 身高、体重、年龄、生日、身份… |
| `list` | 列表项 | `- `、`1. `、`· ` |
| `separator` | 分隔线 | `---`、`===`、`***` |
| `comment` | 注释 | `// …` |

14 条规则（priority 从高到低）：`block-heading`(100) / `markdown-heading`(100) / `bracket-heading`(95) / `char-placeholder`(90) / `hr-line`(80) / `bold-emphasis`(70) / `custom-macro`(60) / `dialogue-double-quote`(50) / `dialogue-cn-quote`(50) / `action-cn-paren`(40) / `action-ascii-paren`(40) / `profile-attribute`(30) / `list-item`(20) / `commented-note`(10)。

> 高亮里的 `placeholder-custom` 故意与平台校验的「禁伪标签」呼应：写 `<BOT>` 时会以琥珀色背景显示，平台规则同时报错，视觉与校验两头都能发现。

### 8.2 `minimal.json`（最小可用）

```json
{
  "schemaVersion": 1,
  "id": "minimal",
  "name": "最小可用",
  "version": "1.0.0",
  "description": "最小可加载范例：只有 2 个样式 + 2 条规则。",
  "extends": null,
  "theme": { "foreground": "#222222", "background": "#ffffff" },
  "scopes": [
    { "id": "heading", "label": "板块标题", "color": "#1f4e79", "bold": true },
    { "id": "placeholder", "label": "占位符", "color": "#b0341b", "backgroundColor": "#fdece7" }
  ],
  "rules": [
    { "id": "block-heading", "scope": "heading", "priority": 100,
      "match": { "type": "regex", "pattern": "^【[^】\\n]{1,30}】\\s*$", "flags": "gm", "wholeLine": true } },
    { "id": "char-placeholder", "scope": "placeholder", "priority": 90,
      "match": { "type": "delimiter-block", "open": "{{", "close": "}}" } }
  ],
  "metadata": { "author": "Tavern Card Studio", "license": "MIT", "updatedAt": "2026-10-21" }
}
```

### 8.3 `dark.json`（继承范例）

只覆盖 `theme` 与 3 个 scope 的颜色，`rules` 追加一条 `todo-marker`（引用父级的 `comment` 样式）。加载后 `lineage = ["default", "dark"]`，`default` 的另外 8 个 scope 与 14 条规则全部保留。

---

## 9. 编写自定义方案的检查清单

1. 想要深色/浅色变体 → 用 `extends` 只改 `theme` 与少数 scope，别整份复制；
2. 标题类规则用 `regex` + `wholeLine: true`，并把 `priority` 放在最高档（≥90），避免被正文规则切碎；
3. 成对符号一律优先 `delimiter-block`；
4. 中文关键字词表把 `wholeWord` 保持默认 `true`（对中文无副作用），但别指望它做分词；
5. 只想让规则在某个板块生效 → 用 `appliesTo: ["block:special"]`，比写复杂正则省事；
6. 改完先跑 `npm run validate:rules`（Schema + 继承链 + 正则可编译一次性检查）；
7. **换了 TXT 预设装饰符就要改标题正则**（见 §8 开头的高亮与预设耦合提示）——这是唯一不会被引擎报错、只会静默失效的坑。
