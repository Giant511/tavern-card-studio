# 预设格式规范（preset.json）

> 归属任务：阶段 2 · T2.1（顺序与分隔符规则）/ T2.3（预设格式系统）。
> 机器可读定义：`rules/schema/preset.schema.json`；内置范例：`rules/presets/*.json`。
> 校验命令：`npm run validate:rules`（Schema + 语义 + 别名冲突）。

---

## 1. 三条硬规则

预设决定「TXT 长什么样」，但**不改变解析的事实来源**：

| 规则 | 含义 |
|---|---|
| **解析按标题出现的位置** | 卡片里板块是什么顺序，就按什么顺序解析；`blockOrder` 不参与解析 |
| **导出不主动重排** | 非标准顺序的卡片原样导出（`serializeStCard` 只做区间替换，不动顺序） |
| **只有「应用预设」才重排** | `planPresetApply` → 用户确认 → `applyPresetPlan`，这是唯一会改变顺序的入口 |

这三条保证了「导入一张顺序很怪的卡 → 不改内容 → 导出」不会被动过手脚，而想统一排版时又有明确的按钮。

---

## 2. 文件结构

```json
{
  "$schema": "../schema/preset.schema.json",
  "schemaVersion": 1,
  "id": "default",
  "name": "默认 · 方括号标题",
  "version": "1.0.0",
  "description": "……",
  "builtin": true,
  "blockOrder": ["basic", "personality", "settings", "special", "user", "worldbook"],
  "headings": {
    "basic": { "pattern": "【{title}】", "aliases": ["基本信息", "基本资料", "……"] },
    "personality": { "pattern": "【{title}】", "aliases": ["性格", "……"] },
    "settings": { "pattern": "【{title}】", "aliases": ["其他设定", "……"] },
    "special": { "pattern": "【{title}】", "aliases": ["特殊设定", "……"] },
    "user": { "pattern": "【{title}】", "aliases": ["用户相关设定", "……"] },
    "worldbook": { "pattern": "【{title}】", "aliases": ["世界书", "……"] }
  },
  "separator": "\n\n",
  "worldbook": { "includeHeading": true }
}
```

存放位置：`rules/presets/<id>.json`。用户自定义预设写同一个目录，`builtin` 置 `false`，`id` 不得与内置冲突。

---

## 3. 字段说明

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schemaVersion` | `1` | ✔ | 固定 1，格式升级时递增 |
| `id` | string | ✔ | `^[a-z0-9][a-z0-9._-]{1,63}$`，全局唯一 |
| `name` | string | ✔ | 界面显示名 |
| `version` | string | ✔ | `x.y.z` |
| `description` | string | | 一句话说明排版风格 |
| `builtin` | boolean | | `true`=内置只读；用户预设为 `false` |
| `blockOrder` | BlockId[6] | ✔ | 六个板块的**完整排列**，见 §4 |
| `headings` | object | ✔ | 六个板块各一项，见 §5 |
| `separator` | string | ✔ | 板块分隔符，**必须含换行**，见 §6 |
| `worldbook.includeHeading` | boolean | | 世界书段是否输出标题（默认 `true`） |
| `meta.author` / `meta.updatedAt` | string | | 作者与更新时间 |

---

## 4. `blockOrder`：顺序语义

- 必须是 `basic / personality / settings / special / user / worldbook` 的一个排列，缺一个、多一个、重复都报错。
- **`personality` 与 `worldbook` 不参与 `description` 拼装**：性格落在 `data.personality`，世界书落在 `data.character_book`。它们出现在 `blockOrder` 里，是为了让「整卡 TXT 的段落顺序」在同一处定义完整，TXT 导出时按它排段落。
- 因此 `description` 侧只取排列中的 `basic / settings / special / user` 四项，顺序沿用排列中的相对位置。
- 默认预设的顺序固定为：**基本信息 → 性格 → 其他设定 → 特殊设定 → 用户相关设定 → 世界书**。

`description` 顺序的两种用法：

```ts
resolveDescriptionOrder(preset.blockOrder)   // → 过滤出 description 板块，缺失项按默认顺序补齐
assembleDescription(blocks, doc, { order })  // 新建卡片拼装 / 新增板块的插入位置
```

---

## 5. `headings`：标题样式与别名

```json
"basic": { "pattern": "【{title}】", "aliases": ["基本信息", "基本资料", "基础信息"] }
```

- `pattern`：标题行模板，**必须含 `{title}`**。可用 `【{title}】`、`## {title}`、`[{title}]`、`**{title}**`。
- `aliases`：该板块能被识别的标题文案，第一项为默认文案。
- **别名表必须覆盖全部六个板块**（Schema 强制六个键都存在，且每个 `aliases` 非空）。
- **不同板块不得共用同一条别名**（如 `special` 里再写 `基本信息`）——否则解析二义，`validate:rules` 直接报错。
- 比对时统一归一化：去掉所有空白（含全角空格）、去掉结尾冒号、转小写。所以 `【基本信息】`、`## 基本 信息`、`[基本信息:]` 都指向同一板块。

**用户改名不被覆盖**：如果卡片里写的是 `【角色档案】`（`basic` 的别名之一），应用预设时只替换装饰符（`【】` → `##`），标题文字仍保留「角色档案」。想彻底统一文案，用「重命名标题」单独操作。

---

## 6. `separator`：板块分隔符

- 必须含至少一个换行，否则板块会粘在一行。
- 三种内置风格：

| `separator` | 效果 |
|---|---|
| `"\n\n"` | 空行分隔（默认 / markdown 预设） |
| `"\n\n---\n\n"` | 分隔线分隔（divider 预设） |
| `"\n~~~\n"` | 任意单行标记都可以 |

- **单行文字分隔符会被从正文末尾剔除**：解析时若板块正文最后一行正好是分隔符里的那行文字（如 `---`），该行归入「板块间隙」而不是正文。这样「解析 → 用同一预设拼装」不会重复写出 `---`；`divider` 预设的往返幂等性由 `test/preset.test.mjs` 覆盖。

---

## 7. 应用预设的流程

```ts
const plan = planPresetApply(card, preset);   // 纯函数，不动 card
// plan.changed       是否需要改动
// plan.beforeOrder   当前 description 板块的实际顺序
// plan.afterOrder    应用后的顺序（仅 description 板块）
// plan.text          重排后的 description 全文
// plan.changes       给用户看的变更摘要（顺序 / 分隔符 / 标题样式）

if (plan.changed && 用户确认) {
  const next = applyPresetPlan(card, plan);   // 返回新卡片
}
```

`applyPresetPlan` 的行为：

1. 按 `plan.text` 重写 `description.raw`；
2. 立刻用预设别名表重新解析，重建每个板块的 `anchor`，所以**后续编辑仍是增量回写**（不是整段覆盖）；
3. 只替换 description 侧板块；`personality` 与 `worldbook` 原样保留；
4. 所有板块 `dirty = false`（文本已是新的基线）。

变更摘要示例：

```
板块顺序：user → special → basic ⇒ basic → special → user
分隔符："\n\n" ⇒ "\n\n---\n\n""
```

---

## 8. 与解析/导出的关系（行为对照表）

| 场景 | 行为 |
|---|---|
| 导入 JSON（板块乱序） | 按标题位置解析，`anchor` 记录真实区间；`description.structured = true` |
| 直接导出 JSON | 区间替换，乱序保持乱序，字节不变 |
| 导出 TXT（按预设） | 按 `blockOrder` 渲染段落；不改动卡片本身 |
| 应用预设 | 按 `blockOrder` 重排 `description`，并重建 anchor |
| 编辑某个板块后导出 | 只替换该板块正文区间，其余字节不动（顺序仍按卡片当前实际顺序） |

---

## 9. 内置预设

| id | 名称 | 标题 | 分隔符 | 顺序 |
|---|---|---|---|---|
| `default` | 默认 · 方括号标题 | `【标题】` | `\n\n` | 基本→性格→其他→特殊→用户→世界书 |
| `markdown` | Markdown · 二级标题 | `## 标题` | `\n\n` | 同上 |
| `divider` | 分隔线 · 方括号标题 | `【标题】` | `\n\n---\n\n` | 同上 |

三份预设的 `headings` 都覆盖六个板块、别名互不冲突，并通过 `npm run validate:rules`。

---

## 10. 测试覆盖（`test/preset.test.mjs`）

1. 三份内置预设加载成功、`blockOrder` 是六板块排列、别名表覆盖六板块；
2. 非法预设被拒：缺板块、别名冲突、`pattern` 缺 `{title}`、`separator` 无换行；
3. **非标准顺序（用户→特殊→基本，CRLF）round-trip 无损**（`preserve` 导出逐字一致）；
4. 导出不主动重排（`sync` 导出仍是非标准顺序）；
5. 应用默认预设后按顺序重排、空板块不输出；
6. 应用预设保留用户改过的标题文案；
7. 应用后仍可增量编辑（只替换被改板块，顺序不变）；
8. 分隔线预设重复应用幂等（`---` 不叠加）；
9. 自定义顺序预设按其顺序渲染，且不会把 `worldbook` 当成 description 板块。
