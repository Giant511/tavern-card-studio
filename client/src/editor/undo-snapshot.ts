/**
 * 功能
 * 「折叠要不要吃掉撤销栈」的决策逻辑（P1-10）。
 *
 * 背景
 * 折叠板块时 `BlockEditor` 被 `destroy()`，展开时用 `EditorState.create()`
 * 重建 —— 而 CodeMirror 的撤销栈就住在 `EditorState` 里。于是：
 *
 * ```text
 *   展开 → 打字 → 折叠 → 展开 → Ctrl+Z    什么都没发生
 * ```
 *
 * 用户的预期是"撤销我上一步编辑"，与"我中间折叠过"无关。
 *
 * 修法
 * 折叠时把 `EditorState` 整个存下来（不是存文本 —— 存文本就没有栈了），
 * 展开时**复用同一个 state 对象**。`EditorView` 构造接受 `state`，
 * 且此时 `extensions` 会被忽略（用 state 里自带的那些）。
 *
 * 为什么必须校验
 * `EditorState` 不可变，但"存下来的那一份"会**落后于**后续编辑。
 * 更糟的是：折叠期间内容可能被别的路径改掉（应用预设、重新导入、远端取回），
 * 那些改动不在旧 state 里。此时复用旧 state 会把用户的改动**回退掉**，
 * 而撤销栈的偏移量全部错位 —— 比"撤销无效"危险得多。
 *
 * 所以复用的前提是两条都满足：
 * ```text
 *   ① 旧 state 的文本 === 当前板块文本
 *   ② 高亮规则还是同一份（装饰扩展闭包在 state 里，换了就不匹配）
 * ```
 * 任一不满足就丢弃快照，老老实实新建 —— 撤销不可用，但内容不会错。
 *
 * 不处理的场景（以及为什么）
 * **切换标签后撤销栈不保留**。切标签会 `reloadBlocksFromCard()` 重建所有块，
 * 快照跟着块一起消失。这是有意的：切标签是"重新载入文件内容"，
 * 撤销到载入前反而会让用户看到一份内存里才有、磁盘上没有的内容。
 * 折叠/展开是"同一份内容的展示形态变化"，所以那个必须保住撤销。
 *
 * 踩过的坑
 * 这里不涉及 DOM，所以决策逻辑能做成纯函数直接测（`test/undo-survives-collapse.test.mjs`）。
 * 真正需要浏览器的只有 `new EditorView(...)` 那一句 —— 它由
 * `scripts/verify-p110-undo.mjs` 端到端验（真键盘 Ctrl+Z）。
 */

import type { EditorState } from '@codemirror/state';
import type { CompiledHighlightRule } from '@tcs/shared';

/**
 * 功能
 * 折叠时保存下来的撤销现场。
 *
 * 注意事项
 * 存的是整个 `EditorState`，不是文本。文本可以从 state 读出来
 * （`state.doc.toString()`），但**反过来不成立** —— 只有文本就没有栈了。
 */
export interface UndoSnapshot {
  /** 折叠前那一刻的完整编辑器状态（含撤销栈） */
  readonly state: EditorState;
  /** 当时用的高亮规则。切换过就不复用（装饰扩展闭包在 state 里） */
  readonly compiled: CompiledHighlightRule | null;
}

/**
 * 功能
 * 打包一份撤销现场。
 *
 * 注意事项
 * 需要在 `editor.destroy()` **之前**调用 —— destroy 之后 view 已经不可读。
 */
export function makeUndoSnapshot(
  state: EditorState,
  compiled: CompiledHighlightRule | null,
): UndoSnapshot {
  return { state, compiled };
}

/**
 * 功能
 * 决定展开时要不要复用上次的 state。返回 null 表示"丢弃，新建"。
 *
 * 注意事项
 * 两条校验都必须过，理由见文件头。**这是保守选择**：
 * 宁可撤销不可用，也不能让内容回退到旧版本。
 *
 * 踩过的坑
 * 第一版想用 `saved.state.doc.length === text.length` 做校验 —— 长度相同但
 * 内容已改（比如改了一个字）会误判为"可复用"，于是用户那处改动被悄悄回退。
 * 必须**逐字符比较**。
 */
export function pickUndoState(
  saved: UndoSnapshot | null,
  currentText: string,
  currentCompiled: CompiledHighlightRule | null,
): EditorState | null {
  if (saved === null) return null;
  if (saved.compiled !== currentCompiled) return null;
  if (saved.state.doc.toString() !== currentText) return null;
  return saved.state;
}
