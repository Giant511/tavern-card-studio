# 整卡 TXT 导入：缺失板块标题的处理口径

> 状态：已拍板（2026-10-21）。实现：`shared/src/format/card-txt.ts`；测试：`test/card-text.test.mjs`。
> 关联：[docs/04-worldbook-txt-spec.md](04-worldbook-txt-spec.md)（世界书段内部格式）、[docs/05-preset-spec.md](05-preset-spec.md)（板块标题与别名表）。

## 0. 总原则

> **静默丢数据不可接受。**
> 无论严格还是宽松模式，任何「空块 / 删除 / 忽略」都必须是**用户可见、可确认**的状态：
> 结果里一定有对应的 issue，UI 必须展示并让用户确认后才落盘。

三条硬性落地：

1. 缺失板块在结果里有 `missing: BlockId[]` 与对应 issue，绝不无声填空；
2. 被填为空的板块带 `block.missing = true`，UI 可据此打「缺失」标记（正常存在的空板块此值为 `false`，二者必须可区分）；
3. 存在任何 **error** 级问题时，`applyCardText` **原样返回原卡片**（`changed: false`），不写回任何内容。

## 1. 严格模式（默认）

`parseCardText(text, preset)` 缺省即严格模式。

**触发条件**：六个板块中缺任一标题（按预设别名表判定），或世界书段存在 error，或板块标题重复导致歧义以外的结构错误。

**行为**：`card` 返回 `null`，`ok: false`，导入中止。

**报错内容**（每条缺失一条）：

| 字段 | 内容 |
|---|---|
| `blockId` | 缺失板块 id |
| `message` | `缺少板块「特殊设定」（预期位置：第 12 行附近），导入已中止` |
| `line` | **预期位置行号**：按预设顺序，该板块应插入的位置（前一个已识别板块正文结束后的下一行；之前没有板块则为第 1 行） |
| `hint` | 可用别名清单，如 `可用标题：特殊设定 / 特别设定 / 特殊 / 特殊规则` |

**增强：未识别标题的猜测提示**

文件中出现了别名表不认识的标题行时，额外产出 `code: 'unknown-heading'` 警告，并用码点级编辑距离猜测「最接近的板块」：

- 阈值：距离 ≤ 2 且 ≤ 标题长度的一半；
- 命中时 `hint` 形如：`是否想写「世界书」（世界书）？`
- 未命中时提示「该行内容将归入上一板块正文」。

例：繁体 `【世界書】` → 提示「是否想写「世界书」」，同时严格模式报「世界书缺失」——用户一眼能看出是繁简写错。

## 2. 宽松模式（导入口显式勾选）

`parseCardText(text, preset, { mode: 'lenient' })`。

**行为**：

- 缺失板块按**空块**填充（`text: ''`、`missing: true`），导入继续；
- 结果里产出 warning：`缺少板块「特殊设定」（预期位置：第 12 行附近），已按空块处理`，同样带别名提示；
- `ok` 仍为 `true`（缺失本身是警告级），但 **issues 里必须有这条 warning**，UI 在导入完成后需明确展示「以下板块缺失，已按空处理」；
- 世界书段若存在 error，宽松模式也**不会**合并写入：`applyCardText` 依旧原样返回原卡片（`changed: false`），并在 issues 中给出原因。

## 3. 其它边界

| 情况 | 处理 |
|---|---|
| 同一板块标题重复出现 | 后者不开启新板块，其标题行与内容留在上一板块正文内（内容不丢），产出 `duplicate-heading` 警告并带行号 |
| 六个板块顺序非标准 | 解析按标题在文件中的出现位置，**不重排**；`description.raw` 为各 description 段落按原始顺序拼接（段内字节逐字保留） |
| 性格段落 | 独占 `data.personality`，不进 `description`；整卡 TXT 中仍以独立段落呈现 |
| 世界书段落 | 按 v1.0 格式解析，见 docs/04；TXT 为事实源 |
| 标题行出现在世界书正文内 | 已知边界：会被误判为板块标题。靠世界书正文避免整行的 `【…】`/`## …` 规避 |

## 4. API

```ts
parseCardText(text, preset, { mode? })  // → { card | null, issues, ok, missing, unknownHeadings, worldbook }
applyCardText(card, text, preset, { mode? })  // → { card, issues, ok, changed, merge }
renderCardText(card, preset, { includeEmptyBlocks?, worldbookText? })
suggestBlockForHeading(headingText, aliases)  // → { blockId, alias, distance } | null
```

`applyCardText` 是编辑区「保存」走的路径：先解析，再按 TXT 事实源合并世界书（`extensions` 按 id 挂回）。**任一 error 都不写回**。

## 5. 测试固化

`test/card-text.test.mjs` 覆盖：严格模式中止 + 报错三要素、宽松模式空块与 warning、猜测提示（繁简）、重复标题、非标准顺序无损、世界书删除/重排/extensions、error 时原卡片不变、字面 `\@@` 往返。
