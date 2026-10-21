# T6.4 实时提醒 + T6.5 审计面板 · 交付说明

> 范围：审计报告的可视化（面板）与实时联动（编辑即校验、点击定位、修正即消失）。
> 不含：规则/预设管理（T6.2/T6.3）、导出拦截（T6.6）、服务端同步（T6.7）。
> 状态：**已完成**；`191/191` 测试通过（含新增 16 例），`tsc` 0 error，`validate:client` 12/12。

---

## 1. T6.4 实时提醒：原实现已具备，本轮补齐三处

T6.1 交付时已有"编辑 → 校验 → 装饰"的链路。逐条核对 T6.4 要求后，发现缺的是**位置消费的完整性**：

| 要求 | 原状态 | 本轮动作 |
|---|---|---|
| 消费报告的位置契约（blockId/line/column） | 编辑器用 `blockId + start/end` 建装饰 ✔ | 保留；`line/column` 之前只显示行号，现在**行 + 列都显示** |
| 可点击定位 | 点击列表项 → `focusRange(start, end)` ✔ | 定位逻辑统一收进 `locateIssue()`，面板与字数条共用 |
| 修正后提醒即时消失 | `setIssues([])` 清空装饰 ✔ | 补**端到端实证**（§4） |
| 全文级问题不误定位 | 只提示"不属于任何板块" ✔ | 保留，且面板把这类问题单独分组为「全文」 |

关键点：**位置信息全部来自报告**，渲染层不做任何"从文本反推偏移"的计算。这也意味着
`shared` 的位置算法一旦有偏差，界面上会立刻暴露（而不是被二次校正掩盖）。

---

## 2. T6.5 审计面板

![审计面板](assets/t65-audit-panel.png)

### 2.1 分层

| 文件 | 职责 |
|---|---|
| `client/src/audit/audit-model.ts` | **纯逻辑**：过滤 / 排序 / 分组 / 计数 / 字数换算。无 DOM，可在 Node 单测 |
| `client/src/audit/audit-panel.ts` | 渲染：把 model 的输出画成节点，把点击转成回调 |
| `client/src/editor/app.ts` | 编排：一次 `buildAuditReport`，结果**同时**喂给面板与编辑器装饰 |

分层原因：过滤/分组是"输入报告 → 输出结构"，与界面无关；把它抽出来才能用真实报告单测（16 例）。

### 2.2 面板组成

1. **摘要**：错误 / 警告 / 提示 + 「可导出 / 不可导出」徽标（`summary.exportable`）+ 六板块合计字数。
2. **筛选**：等级、类别、板块（含「仅全文级」）、关键字搜索、重置。等级与类别是**多选**（可只看"错误+警告"）。
3. **字数分布**：六板块条形图 + 落盘字段口径（`description` / `personality` / `character_book`）。
   - 条形长度按**最大值**归一（相对最大值，小板块才不会看不见）；
   - 括号里是**占合计的真实百分比**，两者分开，避免把相对长度误读成占比；
   - 点击任一行可定位到该板块。
4. **问题列表**：可按板块 / 类别分组或不分组；每条显示等级、行号列号、规则 id、消息、建议、命中行文本。

### 2.3 两个口径容易被混淆，面板里分开写

「六板块合计」和「落盘字段合计」不是一回事（平台长度规则用的是后者）：

- 六板块合计 = `basic + personality + settings + special + user + worldbook`
- 落盘字段：`description` = 除性格外五板块之和、`personality` = 性格、`character_book` = 世界书条目

样本卡：六板块 268 字，而 `description` 178 / `personality` 35 / `character_book` 55（178+35+55=268）。
若只显示一个数字，用户会以为平台的字数规则算错了。

---

## 3. 与报告字段的对应关系

面板**不自己造结论**，每个显示项都能指回报告字段：

| 面板元素 | 数据来源 |
|---|---|
| 摘要三个计数 | `report.summary.{error,warning,info}` |
| 可导出徽标 | `report.summary.exportable` |
| 类别 chip 的数字 | `report.byCategory[category]` |
| 行号 / 列号 | `issue.location.{line,column}`（1-based，列按码点） |
| 命中行文本 | `issue.location.lineText` |
| 建议 | `issue.hint` |
| 规则 id | `issue.ruleId`（如 `builtin:st-defaults-emitted`、`char-placeholder-suggested`） |
| 「全文」分组 | `issue.location.blockId === null` |
| 字数条形 | `report.wordCount.blocks[]`（顺序同 `BLOCK_IDS`） |

---

## 4. 「修正即消失」的实证

不是靠肉眼，而是跑一遍真实链路：

```
改前：总 2 条 | settings 块 1 条 | info
       ↓ 在「其他设定」末尾补上 "请用 {{char}} 称呼角色。"
改后：总 1 条 | settings 块 0 条 | (无)
PASS
```

对应 UI 链路：`setBlockText` → 防抖 260ms → `buildAuditReport` → `auditPanel.setReport()` + `editor.setIssues()`。
面板条目与编辑器波浪线**同源同批**更新，不会出现"面板没了但编辑器还画着"。

---

## 5. 单测覆盖（16 例，`test/audit-panel-model.test.mjs`）

测试**用真实报告驱动**——`buildAuditReport` 跑 sample-card + 五份平台规则，
不手搓 `AuditIssue` 结构。否则测的是我想象的格式，不是 `shared` 实际产出的格式。

| 组 | 用例 |
|---|---|
| 过滤 | 默认不筛、按严重度、按类别、按板块（含「仅全文级」）、关键字（命中 message/hint/行文本）、多条件是与关系 |
| 排序 | 严重度单调不减；全文级集中在末尾 |
| 分组 | 按板块（顺序同 `BLOCK_IDS`、「全文」在最后、不漏条目）、按类别（`worstSeverity` 正确）、不分组 |
| 计数 | 严重度与 `summary` 一致；类别计数之和 = 问题总数 |
| 摘要 | 含可导出标记；筛选描述区分「共 N 条」与「筛出 M / N 条」 |
| 字数 | 六板块齐、百分比在 0–100、最大块 = 100%、share 之和 ≈ 100、与 `total.chars` 一致 |

---

## 6. 本轮修掉的两个显示缺陷

截图验收时发现的，都已修：

1. **摘要重复显示**：标题栏显示 `错误 0 · 警告 0 · 提示 2`，面板摘要又显示一遍。
   改为标题栏只放条数（`2 条`），详细摘要留给面板。
2. **「全文」条目头部只剩一个圆点**：这类问题 `line`/`column` 都是 `null`，位置文字为空。
   现在无位置时显式写「全文统计」（`aggregate: true`）或「全文」。

这类问题只有真跑起来看截图才会发现——DOM 断言能验结构，验不出"看起来像坏了"。

---

## 7. 已知边界

| 项 | 现状 | 后续 |
|---|---|---|
| 面板宽度固定 340px | 筛选 chip 多了会换行，目前可用 | 若需要可按需拖拽，属体验优化 |
| 校验防抖 260ms | 打字时不会逐键重算 | 若长文档觉得卡，可改 `requestIdleCallback` |
| 关键字搜索范围 | message / hint / 命中文本 / 整行 | 不含规则 id（避免搜 `builtin` 命中一片） |
| 类别筛选依赖报告 `byCategory` | 报告缺该字段时按 0 显示 | `shared` 恒返回，实际不会缺 |
| 面板不提供"自动修复" | 只定位不代改 | 自动修复属编辑行为，需单独设计（T6.6 之后） |

---

## 8. 复现

```bash
npm run typecheck:client
node --test test/audit-panel-model.test.mjs     # 16 例
npm test                                        # 191 例

python -m http.server 8899 --bind 127.0.0.1 --directory client/dist
# http://127.0.0.1:8899/index.html          默认视图
# http://127.0.0.1:8899/index.html?demo=lenient   宽松导入（看缺失标记 + 更多问题）
```
