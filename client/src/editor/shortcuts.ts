/**
 * 全局快捷键的**纯决策**（T9.9）—— 无 DOM、无副作用，可直接单测。
 *
 * ## 为什么先把"按了键该干什么"抽出来
 *
 * 快捷键的 bug 几乎都不是"没绑定"，而是**抢了不该抢的键**或**在错误的状态下生效**：
 * 空工作台按 Ctrl+W、弹窗开着按 Ctrl+N、正在编辑器里打字按 Ctrl+W。
 * 这些分支只有在纯函数里才测得动；塞在 `keydown` 监听器里就只能靠手点。
 *
 * ## 与 CodeMirror 6 的键位冲突（已核实，非推测）
 *
 * `npm` 装到的 `@codemirror/commands` 里 `defaultKeymap` 的 `Mod-*` 绑定是：
 *
 * ```
 * Mod-a  Mod-i  Mod-u  Mod-y  Mod-z  Mod-/  Mod-[  Mod-]
 * Mod-ArrowLeft  Mod-ArrowRight  Mod-Backspace  Mod-Delete  Mod-End  Mod-Home
 * Mod-Enter  Mod-Alt-ArrowUp  Mod-Alt-ArrowDown  Mod-Alt-\
 * ```
 *
 * **没有 `Mod-w`、没有 `Mod-n`、没有 `Mod-Tab`。** 所以 Ctrl+N / Ctrl+W /
 * Ctrl+Tab 不会和编辑器抢；唯一被 CM6 占用的是**不带修饰键的 `Tab`**（插入缩进），
 * 而 Ctrl+Tab 是另一个键，不冲突。
 *
 * ## 与 WebView2 的关系（这条决定了 Ctrl+W 必须 preventDefault）
 *
 * wry 0.57 的 `WebViewAttributes` 里 `browser_accelerator_keys` **默认是 `true`**
 * （`wry/src/lib.rs:1768`，注释写着 "This is WebView2's default behavior"），
 * 而 Tauri 没有覆盖它（`grep browser_accelerator_keys` 在 tauri-* 里零命中）。
 * 也就是说 WebView2 自己的加速键（Ctrl+F / Ctrl+P / F5 / F12 …）是**开着**的。
 *
 * 我们不能假设 Ctrl+W 在 WebView2 里一定无害 —— 一旦它被映射成"关闭窗口"，
 * 而我们在编辑器聚焦时又"不抢按键"（不 preventDefault），用户敲一下就会丢数据。
 * 所以这里的态度是：**编辑器聚焦时不让它关标签（用户要求的语义），但仍然
 * preventDefault 掉默认行为**，并给一句提示说明为什么没反应。
 * 这样"我们的动作"确实被让给了编辑器，同时也没把窗口交给浏览器的默认行为。
 */

export interface ShortcutInput {
  /** `KeyboardEvent.key` 原值（`'n'` / `'W'` / `'Tab'` …） */
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /**
   * 正在输入：编辑器（`.cm-editor`）或就地改名输入框聚焦。
   *
   * 不只判编辑器，是因为"就地改名"也是打字场景 —— 那里按 Ctrl+W
   * 一样会误触，而且用户同样不想在打字时被切走。
   */
  editing: boolean;
  /** 有未关闭的模态框（设置 / 新建卡 / 同步 / 导出…） */
  modalOpen: boolean;
  /** 已打开的标签数（0 = 空工作台） */
  tabCount: number;
}

export type ShortcutIntent =
  | { type: 'new-card'; preventDefault: true }
  | { type: 'close-tab'; preventDefault: true }
  | { type: 'switch-tab'; delta: 1 | -1; preventDefault: true }
  /** 编辑器聚焦时的 Ctrl+W：不关标签，只解释一句（见文件头的 wry 说明） */
  | { type: 'editor-took-key'; hint: string; preventDefault: true }
  | null;

/** Ctrl+W 落在编辑器里时的提示语（状态栏用，一句话） */
export const EDITOR_TOOK_CTRL_W =
  '编辑中未关闭标签（防误触）；点一下标签栏或按 Esc 退出编辑后再按 Ctrl+W';

/**
 * 决定这次按键要不要做点什么。
 *
 * 返回 `null` 表示"与我们无关"——调用方**不要** `preventDefault()`，
 * 让按键继续走原本的路径（比如在输入框里按 Ctrl+A 全选）。
 */
export function decideShortcut(input: ShortcutInput): ShortcutIntent {
  const primaryModifier = input.ctrlKey || input.metaKey;
  if (!primaryModifier) return null;
  // Alt 组合一律不碰：Alt+Tab / Alt+F4 是系统键，抢了会很难受
  if (input.altKey) return null;
  // 弹窗打开时，按键归弹窗（它自己的键盘交互优先）
  if (input.modalOpen) return null;

  const key = input.key;

  // Ctrl+N：新建（与 F11 对话框衔接）。空工作台也生效 —— 那正是最主要的入口。
  if (key === 'n' || key === 'N') {
    if (input.shiftKey) return null; // Ctrl+Shift+N 不是我们定义的
    return { type: 'new-card', preventDefault: true };
  }

  // Ctrl+W：关闭当前标签。
  if (key === 'w' || key === 'W') {
    if (input.shiftKey) return null;
    if (input.editing) {
      return { type: 'editor-took-key', hint: EDITOR_TOOK_CTRL_W, preventDefault: true };
    }
    // 空工作台没有标签可关 —— 明确无行为，也不弹任何提示
    if (input.tabCount === 0) return null;
    return { type: 'close-tab', preventDefault: true };
  }

  // Ctrl+Tab / Ctrl+Shift+Tab：切标签。
  if (key === 'Tab') {
    // 只有一张卡时"切换"没有意义；返回 null 也就不会无谓地吞掉按键
    if (input.tabCount < 2) return null;
    return { type: 'switch-tab', delta: input.shiftKey ? -1 : 1, preventDefault: true };
  }

  return null;
}
