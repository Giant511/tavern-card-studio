# 世界书 TXT 格式规范 v1.0（已冻结）

> 状态：**v1.0 · 已冻结**（2026-10-21）。冻结后格式不再单方面变更；任何改动需重新确认并升版本号。
> 归属任务：阶段 2 · T2.1 / T2.2（世界书部分）。
> 关联：[docs/05-preset-spec.md](05-preset-spec.md)（预设只决定「是否带标题、标题文案、世界书段在整卡 TXT 中的位置」，条目内部格式由本规范固定）、[docs/06-txt-import-mode.md](06-txt-import-mode.md)（整卡导入的严格/宽松模式）。
> 实现：`shared/src/format/worldbook.ts`；测试：`test/worldbook.test.mjs`。

---

## 0. 冻结时的三条补充细则

| # | 细则 | 落地 |
|---|---|---|
| S1 | **重复 id 必须报错并给出位置，禁止静默合并** | `parseWorldbookText` 产出 `code:'duplicate-id'` 的 **error**，带 1-based 行号与 `entryId`；两条目都保留在结果里（不合并、不丢弃），由调用方按 `ok === false` 中止导入 |
| S2 | **合并语义写死：导入时 TXT 是世界书的事实源** | `mergeWorldbookEntries(original, parsed)`：TXT 中不存在的条目**即删除**（`removed` 列表必须给用户看）；TXT 中的条目覆盖 11 个可见字段；`extensions` 等机器字段**按 id 匹配挂回**（`preserved` 列表） |
| S3 | **id 冲突时 extensions 不做猜测性归属** | 重复 id 时直接报错（S1），不尝试「按顺序/按内容相似度」把机器字段配对到某一条；TXT 里没有的条目也不会被凭空复活 |

---

## 1. 设计目标与取舍

世界书是唯一「结构化且字段多」的板块（`character_book.entries[]` 每项有 12+ 个字段）。TXT 要同时满足三件事：

| 目标 | 做法 |
|---|---|
| 人能读、能改 | 头部字段一行一个 `key: value`，正文是纯文本，不用 JSON、不用缩进 |
| 能无损回写 | 固定标记行 + 正文转义规则；非人读字段按 `id` 从内存 entries 合并保留 |
| 能 lint、能报错 | 标记行带条目 id，缺 `@@CONTENT`/`@@END`、id 重复都能精确定位到行 |

**不采用**的方案及原因：

- **不用 YAML block scalar（`content: |` + 缩进）**：行尾空格、空行、缩进敏感，手改一次就失真。
- **不用 `---` 做条目分隔**：正文里出现 `---` 极常见，无法区分。
- **不用纯 JSON 混在 TXT 里**：违背「TXT 纯文本直观编辑」的原始需求。

---

## 2. 整体位置

世界书在整卡 TXT 的最后一段，标题文案与位置都由预设决定：

```
【基本信息】
……（四个 description 板块按预设顺序排列）

【世界书】
@@ENTRY 0
name: 银座咖啡馆
keys: 咖啡馆, 银座
@@CONTENT
……
@@END 0
```

- 段落标题：默认 `【世界书】`（由预设 `headings.worldbook.pattern` 决定，别名表也来自预设）。
- 世界书段与前一段之间用预设的 `separator` 分隔。
- 预设 `worldbook.includeHeading: false` 时省略标题行——此时**严格模式导入会报「世界书缺失」**（见 docs/06），属预期行为，仅供特殊排版使用。

---

## 3. 条目结构

```
@@ENTRY <id>            ← 起始标记行
<头部字段行，0..n 行>    ← key: value
@@CONTENT               ← 正文起始标记
<正文，0..n 行，任意字符>
@@END <id>              ← 结束标记行（id 必须与 @@ENTRY 一致）
```

### 3.1 起始标记行

```
@@ENTRY 3
```

- `<id>`：非负整数，对应 ST 的 `entries[i].id`。
- 导出时若条目缺 `id`，按「当前已用编号 +1」补一个未占用编号（`ensureEntryIds`），并在写回时写入 `entry.id`。
- **id 在整个世界书内必须唯一。重复时报错（error）并给出第二次出现的行号，禁止静默合并**——两条目都保留在解析结果里，由调用方（导入流程）中止。
- 非整数 id 报 `invalid-id`。

### 3.2 头部字段

**写出一律按下面的顺序、只写有意义的字段**（解析不要求顺序）：

| 顺序 | 字段 | 类型 | 缺省 / 说明 |
|---|---|---|---|
| 1 | `name` | 字符串 | 条目显示名 |
| 2 | `keys` | 列表 | 主关键词。允许为空（配合 `constant: true` 常驻） |
| 3 | `secondary_keys` | 列表 | 次关键词；为空时省略 |
| 4 | `constant` | 布尔 | 常驻不靠关键词触发 |
| 5 | `enabled` | 布尔 | `false` 表示条目停用（ST 私有字段） |
| 6 | `insertion_order` | 数字 | 越小越先插入 |
| 7 | `position` | 枚举 | `before_char` / `after_char`，也接受 `0` / `1`；写出一律用枚举名，其他数字原样保留 |
| 8 | `priority` | 数字 | 可选，缺省不写 |
| 9 | `case_sensitive` | 布尔 | |
| 10 | `selective` | 布尔 | 是否需要 `secondary_keys` 同时命中 |
| 11 | `comment` | 字符串 | 作者备注，可空 |

> **解析端不注入缺省值**：TXT 里没出现的字段，解析结果里就不存在该键（不补 `constant:false`、`insertion_order:100` 之类）。
> 这样既保证 `parse(render(x))` 与 `x` 在可见字段上严格相等，也避免「编辑一次 TXT 就凭空给 JSON 增加字段」。
> 缺省语义由 SillyTavern 运行时按其默认值决定。

### 3.3 值的写法

| 类型 | 写法 | 示例 |
|---|---|---|
| 字符串 | `key: 值`，**首尾空白会被裁掉**；值里可以有冒号 | `name: 银座咖啡馆：本店` |
| 空字符串 | `key:`（冒号后什么都不写，不留尾随空格） | `comment:` |
| 布尔 | `true` / `false`（也接受 `1/0`、`yes/no`、`on/off`） | `constant: true` |
| 数字 | 直接写，允许负数与小数 | `insertion_order: 120` |
| 列表 | 半角逗号 `,` 分隔，各项首尾空白裁掉 | `keys: 咖啡馆, 银座, 店长` |
| 含逗号的项 | 双引号包裹，内部双引号写 `\"` | `keys: "咖啡馆, 二号店", 银座` |
| 空列表 | `key:` | `secondary_keys:` |

### 3.4 正文与转义（方案 A · 冻结版）

- 正文 = `@@CONTENT` 行的**下一行**开始，到 `@@END <id>` 行**之前**结束；同时去掉紧邻 `@@END` 前的**一个**换行。
- 正文内**不再解析任何头部字段**——`keys: 银座` 这样的行原样属于正文。
- 正文内保留：空行、行首空格、行尾空格、`---`、`#`、`CRLF` 等一切字节。

**转义规则（唯一一条，方案 A）**

| 方向 | 规则 |
|---|---|
| 写出 | 凡匹配 `/^\\*@@/` 的行（即行首 0 个或多个反斜杠后紧跟 `@@`），在行首**再加一个** `\` |
| 解析 | 凡匹配 `/^\\+@@/` 的行（行首 1 个或多个反斜杠后紧跟 `@@`），**去掉第一个** `\` |

对照表（round-trip 严格无损）：

| 正文原文（行首） | 写出为 | 解析回 |
|---|---|---|
| `@@END 0` | `\@@END 0` | `@@END 0` |
| `\@@END 0` | `\\@@END 0` | `\@@END 0` |
| `\\@@END 0` | `\\\@@END 0` | `\\@@END 0` |
| `C:\@@x`（非行首） | `C:\@@x`（不动） | `C:\@@x` |

这条规则把「字面 `\@@` 行首」这个原来的有损边界彻底消除：字面 `\@@` 会被写成 `\\@@`，解析端按同一规则还原，不会出现「`\@@END 0` 被吃掉一个反斜杠变成 `@@END 0`」的情况。

- 正文为空：`@@CONTENT` 与 `@@END <id>` 相邻两行。
- 正文自带尾换行时，写出会多一个空行再接 `@@END`；解析端只去掉一个换行，因此逐字节可还原（含 CRLF）。

### 3.5 条目之间

- 写出时，`@@END n` 与下一个 `@@ENTRY m` 之间**固定空一行**。
- 解析时不强制空行，`@@END` 之后出现的第一个 `@@ENTRY` 即新条目。
- 条目顺序 = `entries` 数组顺序。**不按 `insertion_order` 重排**：TXT 里看到的就是数组顺序，插入顺序由字段值控制。

---

## 4. 完整示例

```
【世界书】
@@ENTRY 0
name: 银座咖啡馆
keys: 咖啡馆, 银座, 店长
secondary_keys: 夜间
constant: false
enabled: true
insertion_order: 100
position: before_char
case_sensitive: false
selective: true
comment: 主场馆
@@CONTENT
咖啡馆位于银座四丁目，二楼是仓库。

墙上挂着一枚银耳钉。
\@@END 0
\\@@END 0
@@END 0

@@ENTRY 1
name: 银耳钉
keys: 银耳钉, 耳钉
constant: true
position: after_char
@@CONTENT
这是她母亲留下的唯一遗物，从不摘下。
@@END 1
```

正文里三行的含义：`\@@END 0` 解析后是 `@@END 0`（字面量），`\\@@END 0` 解析后是 `\@@END 0`（字面量），最后一行 `@@END 0` 才是条目的结束标记。

对应 `character_book.entries`：

```json
[
  { "id": 0, "name": "银座咖啡馆", "keys": ["咖啡馆", "银座", "店长"], "secondary_keys": ["夜间"],
    "content": "咖啡馆位于银座四丁目，二楼是仓库。\n\n墙上挂着一枚银耳钉。\n@@END 0\n\\@@END 0",
    "constant": false, "enabled": true, "insertion_order": 100, "position": "before_char",
    "case_sensitive": false, "selective": true, "comment": "主场馆", "extensions": {} },
  { "id": 1, "name": "银耳钉", "keys": ["银耳钉", "耳钉"], "content": "这是她母亲留下的唯一遗物，从不摘下。",
    "constant": true, "position": "after_char", "extensions": {} }
]
```

---

## 5. 未进 TXT 的字段怎么保 + 合并语义（S2）

TXT 只暴露 §3.2 的 11 个字段。`extensions`、`id` 以外的自定义键、ST 未来新增字段一律**不进 TXT**，保存时按 `id` 从原 `entries` 合并：

```ts
mergeWorldbookEntries(original, parsed, { dropMissing?: true })
// 1. 按 id 建立原条目索引（重复 id 已在解析阶段报错，此处不猜测归属）
// 2. 结果顺序 = TXT 顺序（条目重排即生效）
// 3. TXT 条目覆盖 11 个可见字段 + content；TXT 里没写的可见字段从结果中删除（用户确实删了那一行）
// 4. 其余字段（extensions / 未知键）从原条目带过来 → preserved 列表
// 5. TXT 有、原表没有的 id → 新增条目（added）
// 6. 原表有、TXT 里没有的 id → 删除（removed，必须让用户可见）
```

这是「TXT 面向人、JSON 面向机器」的分界：TXT 不承载机器字段，但不会因为编辑 TXT 而丢掉它们。

**调用前置条件**：`parseWorldbookText().ok === true` 才可调用。存在 error（如缺 `@@CONTENT`、重复 id）时残缺条目会被误判为「用户删除」——`applyCardText` 因此规定：**有 error 就原样返回原卡片**。

---

## 6. 错误与告警（编辑器 / lint 消费）

| 情况 | 级别 | code | 处理 |
|---|---|---|---|
| 同一 id 重复 | **error** | `duplicate-id` | 报第二次出现的行号 + `entryId`；**两条都保留，不合并**；导入中止 |
| id 不是非负整数 | error | `invalid-id` | 报行号 |
| 出现 `@@ENTRY` 但没有 `@@CONTENT` | error | `missing-content` | 该条目整块不参与解析（原条目保持不变），报起始行号 |
| 缺少 `@@END`（遇下一个 `@@ENTRY` 或文件结束仍未闭合） | error | `missing-end` | 正文延续到下一个 `@@ENTRY` 或文件末尾，报行号 |
| `@@END` 的 id 与 `@@ENTRY` 不一致 | error | `mismatched-end` | 以 `@@ENTRY` 配对为准，`@@END` 行原样留在正文里，报行号 |
| `@@CONTENT` / `@@END` 出现在任何 `@@ENTRY` 之前 | error | `orphan-marker` | 报行号 |
| 头部出现未知 `key:` | warning | `unknown-field` | 忽略该行，提示「该字段只能在世界书面板/JSON 中编辑」 |
| 头部值类型不对（布尔/数字/position） | warning | `bad-value` | 忽略该字段 |
| `@@CONTENT` 前出现非字段行 | warning | `unexpected-line` | 忽略该行 |
| `keys` 为空且 `constant` 不为 `true` | warning | `no-keys` | 条目永远不会被触发 |
| `@@ENTRY` 前出现非空文本 | warning | `leading-text` | 视为世界书段说明文字，忽略 |

所有 error/warning 都带 `entryId` + 行号，编辑区可跳转。

---

## 7. 验收标准（已用测试固化）

1. **round-trip**：`mergeWorldbookEntries(entries, parse(render(entries)).entries)` 与 `entries` **深度相等**，覆盖 `sample-card.json` 的 `character_book`（含 `extensions` 与未知键）。→ `test/worldbook.test.mjs`
2. **正交性**：正文含 `@@END 3`、`key: value`、`---`、连续空行、行尾空格、CRLF 时逐字节还原。
3. **幂等**：`render(parse(render(x))) === render(x)`。
4. **空世界书**：`entries: []` → 空串；只有标题的段落 → `entries: []`，不报错。
5. **缺 id**：导出补号、写回写入 `entry.id`，二次导出稳定。
6. **重复 id**：error + 行号，两条目都在结果里，不合并。
7. **字面 `\@@` / `\\@@`**：round-trip 严格无损（方案 A）。
8. **TXT 事实源**：删除 / 重排 / extensions 挂回均按 id，且结果可被 UI 逐条展示。

---

## 8. 冻结记录

原草案 §8 的三个待确认点已全部确认，并附加三条细则：

| 原问题 | 结论 |
|---|---|
| 条目锚点用 `entry.id` 还是顺序号 | **用 `entry.id`**；缺 id 自动补号写回。补充：重复 id 报错并给出位置，禁止静默合并（S1） |
| 正文转义只处理行首 `@@`（`\@@`）？ | **是，但升级为方案 A**：写出时字面 `\@@` 再转义一层为 `\\@@`，解析端对应还原，round-trip 严格无损 |
| `extensions` 等非人读字段不进 TXT？ | **是，不加 `extensions-json` 兜底行**；按 id 合并保留。补充：id 冲突时报错，不做猜测性归属（S3）；TXT 为事实源，其中不存在的条目即删除（S2） |
