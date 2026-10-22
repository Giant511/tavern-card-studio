# T9.9 全局快捷键 · 交付说明

> 状态：已完成。`test/shortcuts.test.mjs` 19 例 + 浏览器端到端实测（`docs/assets/t99-ctrl-w-editor-hint.png`）。
> 决策表 #37。

---

## 1. 需求与实现

| 键 | 行为 | 空工作台 | 编辑器/输入框聚焦 | 弹窗打开 |
|---|---|---|---|---|
| `Ctrl+N` | 打开 F11 新建卡对话框 | ✅ 生效（主要入口） | ✅ 生效 | ⛔ 忽略 |
| `Ctrl+W` | 关闭当前标签（脏则三选确认） | ⛔ 无行为 | ⛔ **不关标签**，只提示一句 | ⛔ 忽略 |
| `Ctrl+Tab` | 切到下一个标签（回绕） | ⛔ 无行为（不足 2 张） | ✅ 生效 | ⛔ 忽略 |
| `Ctrl+Shift+Tab` | 切到上一个标签（回绕） | ⛔ 无行为 | ✅ 生效 | ⛔ 忽略 |
| `Cmd+*` | 与 `Ctrl+*` 等价（macOS） | 同上 | 同上 | 同上 |

`Ctrl+W` 在编辑器里**不关标签**是按需求刻意为之（"编辑中不抢按键"）：
打字时误触 `Ctrl+W` 直接关掉正在改的卡，代价远大于快捷键的便利。
不关的同时给一句状态栏提示，否则用户会以为快捷键坏了：

```
编辑中未关闭标签（防误触）；点一下标签栏或按 Esc 退出编辑后再按 Ctrl+W
```

---

## 2. 键位冲突核查（不是推测，是查过的）

### 2.1 CodeMirror 6 占用了什么

```
$ grep -ohE 'key: "Mod-[^"]*"' node_modules/@codemirror/commands/dist/index.cjs | sort -u
key: "Mod-/"
key: "Mod-Alt-ArrowDown"
key: "Mod-Alt-ArrowUp"
key: "Mod-Alt-\\"
key: "Mod-ArrowLeft"
key: "Mod-ArrowRight"
key: "Mod-Backspace"
key: "Mod-Delete"
key: "Mod-End"
key: "Mod-Enter"
key: "Mod-Home"
key: "Mod-["
key: "Mod-]"
key: "Mod-a"
key: "Mod-i"
key: "Mod-u"
key: "Mod-y"
key: "Mod-z"
```

**没有 `Mod-w`、没有 `Mod-n`、没有 `Mod-Tab`。** 所以三个快捷键都不与编辑器冲突。

真正被 CM6 占用的是**不带修饰键的 `Tab`**（`key: "Tab"` → `insertTab` 插入缩进），
`Ctrl+Tab` 是另一个键组合，不冲突。

### 2.2 WebView2 会不会自己处理 Ctrl+W

这条必须查清楚：如果 WebView2 把 `Ctrl+W` 当成"关闭窗口"，而我们在编辑器聚焦时
"不抢按键"（不 `preventDefault`），用户敲一下就会丢数据。

```
$ grep -rn "AreBrowserAcceleratorKeysEnabled" <cargo-registry>/wry-0.57.0/src/
src/webview2/mod.rs:651:  settings3.SetAreBrowserAcceleratorKeysEnabled(false)?;

$ sed -n '649,652p' src/webview2/mod.rs
  if !pl_attrs.browser_accelerator_keys {
    if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
      settings3.SetAreBrowserAcceleratorKeysEnabled(false)?;

$ grep -rn "browser_accelerator_keys" <cargo-registry>/wry-0.57.0/src/lib.rs
lib.rs:1752:  browser_accelerator_keys: bool,
lib.rs:1768:      browser_accelerator_keys: true, // This is WebView2's default behavior

$ grep -rn "browser_accelerator_keys" <cargo-registry>/tauri-*/src/
（零命中 —— Tauri 没有覆盖这个默认值）
```

**结论：WebView2 的浏览器加速键是开着的**（`wry` 默认 `true`，Tauri 未改）。

所以 `Ctrl+W` 一律 `preventDefault`，包括"编辑器聚焦、我们不关标签"的那种情况：
**我们的动作让给编辑器，但窗口的默认行为不让。** 这是唯一既满足需求、
又不把数据安全交给未知默认行为的选择。

---

## 3. 实现结构

```
client/src/editor/shortcuts.ts     ← 纯决策：decideShortcut(input) → intent | null
client/src/editor/app.ts           ← 采集现场状态（是否在输入 / 有没有弹窗 / 几个标签）并执行
```

把"该不该做"抽成纯函数是为了能测：快捷键的 bug 几乎都不是"没绑定"，
而是**在错误的状态下生效**（空工作台按 Ctrl+W、弹窗开着按 Ctrl+N），
这些分支塞进 `keydown` 监听器就只能靠手点。

三个现场状态的取法都有讲究：

| 状态 | 取法 | 为什么不用更简单的写法 |
|---|---|---|
| 是否在输入 | `activeElement.closest('.cm-editor')` 或 `input`/`textarea`/`contenteditable` | `editor.hasFocus()` 判不到"就地改名"那个 input，而那里同样是打字 |
| 有没有弹窗 | `document.querySelector('.modal-overlay:not([hidden])')` | 弹窗开关散落在五六个组件里，各自维护布尔量迟早漏一个 |
| 几个标签 | `sessions.length` | — |

`null` 返回值的语义是"与我们无关"，此时**绝不 `preventDefault`** ——
否则编辑器里的 `Ctrl+A` / `Ctrl+Z` 会被无声吃掉，这类 bug 极难发现。
`test/shortcuts.test.mjs` 里有一条专门断言"非 null 的 intent 必须 preventDefault"，
以及"无关键返回 null"。

---

## 4. 端到端实测（真实按键事件）

在浏览器里对这些分支逐个派发 `KeyboardEvent`，读 DOM 与状态栏：

```
boot ws=empty tabs=0
empty-ctrl-w tabs=0 defaultPrevented=false status=      ← 空工作台：完全无行为，也没吞按键
ctrl-n dialog=open                                      ← Ctrl+N 弹 F11 对话框
after-a tabs=1 active=Card A
after-b tabs=2 active=Card B
ctrl-tab active=Card A prevented=true                    ← 从 B 回绕到 A
ctrl-shift-tab active=Card B prevented=true               ← 再回绕回 B
focus=cm-content cm-lineWrapping
editor-ctrl-w tabs=2 prevented=true
   status=编辑中未关闭标签（防误触）；点一下标签栏或按 Esc 退出编辑后再按 Ctrl+W
blur-ctrl-w tabs=1 prevented=true                        ← 失焦后 Ctrl+W 正常关标签
```

截图：`docs/assets/t99-ctrl-w-editor-hint.png` —— 两个标签都在、编辑器聚焦、
底部状态栏显示那句提示。

---

## 5. 顺带修复的一个布局回归（T9.2 引入）

截图核对时发现"新建卡"状态下顶部有一大片空白，而 `?sample=1` 打开样例卡却正常。
量下来 `body` 有 5 个直接子元素，但 CSS 仍是：

```css
grid-template-rows: auto auto minmax(0, 1fr) auto;   /* 四行 */
```

T9.2 往 `body` 里插了标签栏（`#tabbar-host`），子元素从 4 个变成 5 个。
多出来的元素落进**隐式行**，于是 `minmax(0, 1fr)` 被同步条占掉：
同步条撑到几百像素高、主区挤成 `auto` 高度、内容溢出到视口外。

这类问题的可怕之处：**单测、类型检查、`cargo check`、`cargo test` 全是绿的**，
只有看截图才发现。已修（五行），并加了静态断言兜底：

```
test/boot-layout.test.mjs
  · body 的直接子元素数（排除 script/style/link 这类不占网格的）== grid-template-rows 的行数
  · 顺序必须是 header → 标签栏 → 同步条 → 主区 → 状态栏
  · 可变高度的行恰好一行，且必须写成 minmax(0, 1fr)
```

故意把 CSS 改回四行验证过，断言会直接说出"5 个元素 / 4 行，多出来的会落进隐式行"。

同时修掉一个一直存在的可见缺陷：右上角「规则」标签只在切换规则时才刷新，
启动后一直停在 HTML 初始文案「规则加载中…」。现在 `start()` 里刷一次。

---

## 6. 已知残留风险（本次未处理，建议 v0.1.2）

`wry` 把 `browser_accelerator_keys` 留成 `true`，意味着 **`F5` / `Ctrl+R` 可能重载
webview**。重载会把所有未落盘的会话一起清掉 —— 这比 Ctrl+W 更危险，
但它属于"关闭浏览器加速键"的独立决策（还会连带影响 Ctrl+F、F12 调试），
不在 T9.9 范围里。建议二选一：

1. 关掉浏览器加速键（`with_browser_accelerator_keys(false)`，需确认 Tauri 是否暴露）；
2. 在 `beforeunload` 里对脏会话做拦截提示。

第 2 条与"关标签三选确认"是同一套语义，改动更小，推荐先做它。
