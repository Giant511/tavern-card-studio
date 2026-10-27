/**
 * SillyTavern 面板的宽度约定（v0.1.6 / T14.3）——纯常量与纯函数，不碰 DOM。
 *
 * 单独一个文件是为了能被 Node 直接单测（`st-pane.ts` 一 import 就要 DOM），
 * 而这些数值是**布局基线**：拖宽的下限、记忆值的钳制都靠它们，
 * 写歪了不会报错，只会在某些窗口尺寸下变得没法用。
 */

/** 默认宽度。460 是「写卡区还留得住正文宽度」与「聊天区够看」的折中 */
export const ST_PANE_WIDTH_DEFAULT = 460;

/**
 * 下限 320：再窄 ST 的侧栏就折成两行，聊天内容开始横向溢出。
 * 上限 900：再宽写卡区会被挤到不可读（通常是误拖）。
 */
export const ST_PANE_WIDTH_MIN = 320;
export const ST_PANE_WIDTH_MAX = 900;

/**
 * 收起后的条宽（只留一条能点回来的竖条）。
 *
 * 44 试过：三个按钮（↻ ⟨ ×）在 44px 里左右各留 4px 内边距后互相贴住，
 * 点到的是隔壁那个。56 是"能舒服点中"的最小值。
 */
export const ST_PANE_COLLAPSED_WIDTH = 56;

/**
 * 把任意输入钳到合法宽度。
 *
 * 记忆值是用户手改配置文件也能变的普通数字，所以这里必须能吃下
 * `NaN` / `Infinity` / 负数 / 字符串 —— 钳制比校验更适合这个场景：
 * 记错了就按最近边界显示，不必让面板开不出来。
 */
export function clampPaneWidth(width: number): number {
  if (!Number.isFinite(width)) return ST_PANE_WIDTH_DEFAULT;
  return Math.min(ST_PANE_WIDTH_MAX, Math.max(ST_PANE_WIDTH_MIN, Math.round(width)));
}

/** 这个记忆值能不能用（设置面板/日志用；`null` 表示"没记过"，属正常） */
export function isPaneWidthUsable(width: number | null | undefined): boolean {
  if (width === null || width === undefined) return false;
  return Number.isFinite(width) && width >= ST_PANE_WIDTH_MIN && width <= ST_PANE_WIDTH_MAX;
}
