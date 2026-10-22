# 渲染预览卡死：根因报告与修复（F8）

> 报告时间：2026-10-22
> 影响功能：顶栏「渲染预览」
> 严重程度：阻断（点一次即整页假死，必须重启客户端）
> 修复文件：`client/src/editor/highlight.ts`
> 防回归：`scripts/verify-e2e.mjs` 第 8 节（19 项断言）+ `capture-e2e-dumps.sh` 4 个场景

## 1. 症状

真机点一次顶栏「渲染预览」，整个界面失去响应：板块、按钮、右侧审计面板全部点不动，
只能强杀进程重启客户端。

**最容易误导人的三点**：

1. 控制台**没有任何报错** —— 没有异常、没有 `console.error`；
2. 页面看起来还是正常的（渲染出来的界面还在），只是点什么都不响应；
3. 只有点过预览才出问题，其它按钮都正常。

## 2. 复现

```
打开客户端 → 任意卡（默认展开前两个板块）→ 点「渲染预览」
→ 界面卡死，DevTools 也失去响应
```

在 headless Chrome 里表现为渲染进程被杀：

```
ERROR:headless_command_handler.cc:395] Abnormal renderer termination.
```

且崩溃**之前**没有任何 JS 错误 —— 因为进程是被内存吃死的，不是抛异常，
`try/catch` 和 `window.onerror` 都接不住。这也解释了为什么单测和常规报错监控都漏了它。

## 3. 根因

`client/src/editor/highlight.ts` 的 `buildPreviewFragment`：

```ts
const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
const fragment = document.createDocumentFragment();
const body = parsed.body;
while (body.firstChild) {
  fragment.append(document.importNode(body.firstChild, true));   // ← 问题在这
}
```

**`document.importNode(node, true)` 是深拷贝：它把节点复制到当前文档，但不会从源文档移除。**

所以 `body.firstChild` 永远非空 → 循环永不结束 → 每一轮都往 fragment 里再追加一份副本
→ 内存指数级增长 → 渲染进程 OOM 被杀。

这是纯粹的「死循环 + 内存爆炸」，不是性能问题，也不是状态机问题。

### 3.1 定位过程（为什么绕了远路）

记录下来，因为其中有几个坑值得复用。

**第一步：排除计算量。** 直接在 Node 里跑 `renderInlineHtml`：

```
sample(311 字符)      0.4 ms
2KB-纯文本            0.1 ms
5KB-混合高亮          0.1 ms
```

全部亚毫秒级，样例卡最大板块才 311 字符 —— **彻底排除「预览做了大计算」这个方向**。
（需求 F8.4 预设的「预览用了全量渲染而编辑器用增量」也不成立：两者共用同一套
`computeHighlightSpans`，本来就没有两套渲染。）

**第二步：浏览器里做隔离。** 逐项对比：

| 用例 | 内容 | 结果 |
|---|---|---|
| v1 | 纯 `console.log` | ✅ |
| v2 | 单独 `DOMParser` | ✅ |
| v3 | module 脚本 | ✅ |
| v4 | 展开 + 点预览 | ❌ 崩 |
| v5 | 不展开直接点预览 | ❌ 崩 |

**第三步：加临时埋点逐段计时。** 这是找到真凶的关键一步。

```
PROBE render ok ms=0.2 htmlLen=1120    ← 渲染正常
PROBE parse  ok ms=0.1 nodes=1         ← DOMParser 正常
PROBE import begin len=96              ← 卡死，永不返回
```

`import` 就是那个 `while (body.firstChild)` 循环所在的位置。

**踩过的坑（供下次参考）：**

- **`--dump-dom` + `--virtual-time-budget` 在渲染进程崩溃时一行都不输出**。
  我一开始用它做诊断，得到的是「空结果」，误以为是「没有日志」而不是「进程已死」。
  改用 `--enable-logging=stderr` 实时流后，才看到崩溃**前**的日志。
- **诊断用的覆盖层本身会误导**。我早期插了一个全屏黑底 `<div>` 显示日志，
  结果它的存在改变了布局，`elementFromPoint` 的结论全不可信。
  后来改成只写 `document.title` / `body.dataset`，不插任何可见元素。
- **`while (parsed.body.firstChild) importNode(...)` 在小样本上也是死循环**，
  只是 1 个节点时可能「看起来跑完了」—— 因为没有对比「循环次数」。
  埋点里打印 `imported=N` 才暴露它。

## 4. 修复

```ts
const fragment = document.createDocumentFragment();
// 展开成数组再 append：childNodes 是活集合，直接遍历会被 append 影响；
// append 对已在文档中的节点执行的是"移动"，不是复制。
fragment.append(...Array.from(parsed.body.childNodes));
```

`append` 的语义是**移动**：节点从 `parsed.body` 摘走、放进 fragment。
既保留了「永不写 innerHTML」的约定（`grep innerHTML` 仍为 0），也不会重复拷贝。

## 5. 验证清单（F8.2 逐项）

| 要求 | 证据 | 结果 |
|---|---|---|
| 打开预览 → 关闭 → 全部恢复响应 | `click 返回 6.1ms`；关闭后可见预览 0 | ✅ |
| 重复打开关闭 10 次无泄漏、无累积遮罩 | `preview-visible-after-close=0`、`nodes-after-close=0`、`overlays=0` | ✅ |
| 预览打开期间编辑器仍可输入 | `typing-result=changed`、`contenteditable=true` | ✅ |
| 不得为预览单独写一套全量渲染 | 与编辑器共用 `computeHighlightSpans`，无第二套实现 | ✅ |

截图：`docs/assets/e2e-preview-open.png`（预览显示在编辑器下方，界面正常可交互）。

## 6. 防回归

单测抓不到这类问题（纯函数在 Node 里跑得飞快，且死循环在小样本上不显形），
所以在真实浏览器里做端到端断言，接进了既有的 `npm run verify:e2e`：

`scripts/capture-e2e-dumps.sh` 新增 4 个场景，`scripts/verify-e2e.mjs` 第 8 节
共 19 项断言：

| 场景 | 断言要点 |
|---|---|
| `?preview=open` | 点击同步返回 < 200ms（**这就是 F8 的核心判据**）、预览已填充 |
| `?preview=cycle10` | 10 次开关后无残留预览、无残留节点、无残留遮罩 |
| `?preview=typing` | 预览打开时输入生效、编辑区未被遮罩覆盖 |
| `?preview=sweep` | 顶栏 9 个按钮逐个点击不阻塞、不抛异常、状态不污染 |

关键设计：**判据选「click 是否能返回」而不是「预览内容对不对」**。
这次故障的本质是同步不返回，所以「能返回」本身就是需要被钉死的事实。
若回归重现，抓取阶段 Chrome 会被超时杀掉、dump 缺失，断言会因为读不到快照而失败。

## 7. T9.18：顶栏其余按钮排查

逐个点一遍的结果（`?preview=sweep`）：

```
btn-open:disabled          浏览器模式下依赖 Tauri 契约，正常禁用
btn-save:disabled          同上
btn-preview:1.6ms:ok
btn-export:0.0ms:ok
btn-rules:0.0ms:ok
btn-settings:51.7ms:ok
btn-upload:0.1ms:ok(forced)    未配置服务端时 disabled，强制启用以覆盖处理函数
btn-history:0.1ms:ok(forced)   同上
btn-rollback:0.0ms:ok(forced)  同上
```

**没有发现同类问题**：全部按钮点击均及时返回，无异常，扫完后无残留遮罩、
预览已复位。

一个测试设计上的注意点：同步三键在未配置服务端时是 `disabled`，
直接跳过等于「这一格没测」。所以扫描时**强制启用一次**再点，
才能真正执行到它们的处理函数（内部是「置一条提示后 return」，本身无状态机风险）。

## 8. 为什么之前没被发现

- **单测覆盖不到**：`buildPreviewFragment` 依赖 `DOMParser`，属于浏览器 API，
  Node 侧的测试从不调用它；
- **只在「点预览」时触发**：默认启动不渲染预览，所以启动冒烟测试、截图流程都正常；
- **无异常可捕获**：OOM 杀进程不走 `throw`，`window.onerror`、`try/catch` 全是空的；
- **界面看起来没坏**：DOM 还在，只是主线程不再回来，容易被当成「偶发卡顿」。

这也说明一件事：**「点一下没反应」这类故障，必须用「点击能否返回」来断言，
而不是断言渲染结果**。后者在进程死掉时根本跑不到，前者才是症状本身。
