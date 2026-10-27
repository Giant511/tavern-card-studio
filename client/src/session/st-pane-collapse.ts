/**
 * ST 面板的收起 / 展开状态机（纯逻辑，无 DOM）。
 *
 * ## 它修的是什么
 *
 * 真机反馈：**收起之后点「⟨」没反应，面板再也展不开**（截图红框）。
 * 看一眼按钮绑定就明白了 —— `iconButton('收起', …, () => this.setCollapsed(true))`：
 * 按钮自己写了「setCollapsed(true)」，于是**不管当前是什么状态，点它都是收起**。
 * 收起态下点「⟨」（同一个按钮，只是文案换了）依然执行 setCollapsed(true)，
 * 屏幕上看就是"点了没反应"。
 *
 * 根因不是"漏接事件"，而是**按钮自带了一份状态判断**。这份判断在
 * 「收起/展开共用一个按钮」的设计里必然错：同一个按钮在两种状态下要做相反的事。
 *
 * ## 修法：状态转换只有一处
 *
 * 所有入口（按钮、调试入口、open/close 的联动）都只调这个模块：
 *   · `nextCollapsed(current)` —— 唯一的状态转换函数（取反）；
 *   · `paneWidthFor(collapsed, remembered)` —— 宽度由状态派生，**不是**各处各设一次。
 *
 * 这样"按钮点了没反应"在结构上不可能再出现：不存在第二个地方能决定"这次该收起还是展开"。
 *
 * ## 为什么不把宽度记在状态机里
 *
 * 宽度是**用户记忆值**（拖拽／上次会话），折叠只是"临时借用条宽显示"。
 * 状态机只管"折叠与否"，宽度换算成纯函数，展开时必然回到 `remembered` ——
 * 这正是"展开后宽度恢复记忆值"这条验收要求的实现方式：
 * 不需要在展开时"记得把宽度还回去"，因为它从来没被覆盖过（只是没被使用）。
 */

/** 折叠条宽度（与 CSS 变量同源，见 `st-pane-layout.ts`） */
export const COLLAPSED_WIDTH = 56;

/**
 * 唯一的状态转换：点一下就是"反过来"。
 *
 * 写成显式函数而不是 `!this.collapsed` 散在各处，是为了让静态断言能守住
 * "只有这里做转换"（`test/st-pane-collapse.test.mjs` 扫源码）。
 */
export function nextCollapsed(current: boolean): boolean {
  return !current;
}

/**
 * 某个状态下面板应有的宽度（像素）。
 *
 * 展开时**必然**是记忆值 —— 这是"展开后宽度恢复"的保证：折叠期间
 * `remembered` 一直没被改写，展开只是重新用它。
 */
export function paneWidthFor(collapsed: boolean, remembered: number): number {
  return collapsed ? COLLAPSED_WIDTH : remembered;
}

/** 折叠态下按钮该显示什么符号（视觉压缩，title/aria 保留完整说法） */
export function toggleGlyph(collapsed: boolean): string {
  return collapsed ? '⟨' : '收起';
}

/** 折叠态下按钮的可读名称（`title` 与 `aria-label` 共用，避免两处各写一份） */
export function toggleLabel(collapsed: boolean): string {
  return collapsed ? '展开 SillyTavern 面板' : '收起 SillyTavern 面板';
}
