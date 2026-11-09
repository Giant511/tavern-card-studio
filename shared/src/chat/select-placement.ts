/**
 * 下拉面板的**定位计算**（2026-11-03）。
 *
 * ## 为什么单独一个文件、放在 shared
 *
 * 这是纯函数：吃一组数字、吐一组数字，不碰 DOM。
 * 放 `shared` 是因为 `client` 的 tsconfig 是 `noEmit`（由 vite 打包），
 * Node 单测**导入不进来**；而"贴着屏幕底部该往哪展开"这类逻辑
 * 恰恰是最该被单测钉住的 —— 真机上它只在滚到底部时偶发，
 * 手动测很容易漏。
 *
 * 与 `sampling-bridge.ts` / `presets.ts` 同一个分层理由。
 *
 * ## 它解决的问题
 *
 * 下拉面板是 `position: fixed`（挂 body，避免被 `.nb-list` 的
 * `overflow-y: auto` 裁掉）。既然 fixed，位置就必须由 JS 算 ——
 * 而算错的后果是**面板跑到视口外**：DOM 里元素存在、文字也对，
 * 但用户什么都看不见，现象就是"点了没反应"。
 */

export interface PopoverPlacement {
  /** 面板在触发器下方（down）还是上方（up） */
  side: 'down' | 'up';
  /** 面板顶边（视口坐标，px） */
  top: number;
  left: number;
  width: number;
  /** 面板最大高度（px）—— 选项太多时内部滚动 */
  maxHeight: number;
}
/**
 * 选项行的 CSS 高度，**必须**与 `chat.css` 里 `.nb-select-option` 的
 * `min-height` 一致。
 *
 * 不一致的后果：算出来的 `maxHeight` 与实际渲染高度不符 ——
 * 表现为"面板明明算得下，却出现滚动条"或反过来（最后一行被切）。
 * 判据在 `test/select-popover.test.mjs`「一行的高度常量与 CSS 对得上」。
 */
export const ROW_HEIGHT = 44;

/**
 * 下拉里至少要放得下几个**汉字**（2026-11-07）。
 *
 * ## 为什么是"字数"而不是"像素"
 *
 * 第一版我写的是 `POPOVER_MIN_WIDTH = 160`（固定 px）—— 那是拿当前这台
 * 360dp / 16px 字号的手机凑出来的数。用户当场的提醒：
 *
 * > 所有的 UI 设计不能只依据我当前连到电脑上的这台手机，
 * > 要保证不同手机可以兼容
 *
 * 固定像素在下面这些情况下全都不成立：
 *
 * ```text
 *   1.3× 系统字体缩放（Android 设置里可调）⇒ 同样 160px 只放得下 7 个字
 *   320dp 小屏                          ⇒ 面板 160px 占掉半屏，且仍可能不够
 *   平板 / 折叠屏展开                    ⇒ 160px 缩成一小条，和触发器不匹配
 *   14px 小字号档（--nb-fs-14）          ⇒ 空间富余，但被 160 白白浪费
 * ```
 *
 * 所以判据锚在**可读性**上：一行至少要能放下 9 个汉字
 * （`不设人设（用默认名）` 这类最长选项是 10 个字符含括号），
 * 像素宽度由「字数 × 实际字号 + 控件留白」算出来。
 *
 * 字号从 `getComputedStyle` 读**真实值**，所以系统字体放大时面板跟着变大 ——
 * 这正是"不同手机兼容"要的东西。
 */
export const POPOVER_MIN_CHARS = 9;

/**
 * 选项行里除文字以外的水平占位（px）。
 *
 * ```text
 *   面板 padding  4 + 4   = 8
 *   选项行 padding 12 + 12 = 24
 *   对勾 16 + 间距 8      = 24
 *   ───────────────────────────
 *   合计                  56
 * ```
 *
 * ★ 这些值来自 CSS 的 token（`--nb-sp-1`/`--nb-sp-3`/`--nb-sp-2`），
 *   而 token 本身是固定 px（`--nb-sp-*` 不随字号缩放），所以这里写常量是安全的。
 *   若哪天 token 改成 em，这里必须跟着改成"按字号算"。
 */
export const POPOVER_CHROME_PX = 56;

/**
 * 面板宽度占视口的**最小比例**（2026-11-07）。
 *
 * ## 为什么还要这一条
 *
 * "9 个汉字"是**可读性下限**，但它会随字号变：14px 时只有 182px。
 * 在一个 360dp 的屏上，182px 只占一半 —— 看起来像一条窄窄的浮条，
 * 用户会担心"是不是又被压扁了"。
 *
 * 用户的两次反馈合起来看的正是这个：
 *
 * > 字数多而且字体太大，导致看着不舒服
 * > 面板展开的尺寸太小也是会有这种问题的出现
 *
 * 前一句说的是"要窄到换行"，后一句说的是"太窄本身也别扭"。
 * 所以除了"放得下 9 个字"，再加"至少占视口一半"。
 */
export const POPOVER_MIN_VIEWPORT_RATIO = 0.5;

/**
 * 这一条的上限（px）——防止在平板上占掉半边屏。
 *
 * 1024dp 平板上 0.5 是 512px，而人设名一般不到 10 个字，
 * 512px 的空面板会显得很怪。所以按比例算出来的值再夹一次。
 */
export const POPOVER_MAX_MIN_WIDTH = 280;

/**
 * 按字号 + 视口算面板最小宽度。
 *
 * 两个约束取较大者：
 *
 * ```text
 *   ① 可读性   9 × 实际字号 + 控件留白        ← 保证不竖排
 *   ② 观感     视口宽 × 0.5（上限 280px）      ← 保证不显得局促
 * ```
 *
 * ★ 两者都是**相对量**（字号 / 视口），没有一个是"拿我这台凑的数"。
 *
 * @param fontSize     选项文字的实际字号（px），从 `getComputedStyle` 读。
 * @param viewportWidth 视口宽度（px）。不传（或非法）时只用可读性下限。
 */
export function popoverMinWidth(fontSize: number, viewportWidth = 0): number {
  /*
   * 读不到字号时的兜底：按 16px（浏览器默认）算。
   *
   * 宁可给出一个正常的宽度，也不要返回 0 —— 返回 0 等于"没有下限"，
   * 面板又会退回到"跟着 89px 的触发器竖排"那个 bug。
   */
  const byChars =
    (Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 16) * POPOVER_MIN_CHARS +
    POPOVER_CHROME_PX;

  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return Math.round(byChars);

  const byViewport = Math.min(
    viewportWidth * POPOVER_MIN_VIEWPORT_RATIO,
    POPOVER_MAX_MIN_WIDTH,
  );
  return Math.round(Math.max(byChars, byViewport));
}

/** 面板内边距合计（上下各 4px） */
const PANEL_PADDING = 8;
/** 触发器与面板之间的间隙 */
const GAP = 4;
/** 与视口边缘的最小距离（留出安全边距） */
const EDGE = 12;

/**
 * 算一次"面板放哪"。
 *
 * ## 翻转规则
 *
 * | 条件 | 结果 |
 * |---|---|
 * | 下方空间够放下整个面板 | 向下展开，不滚动 |
 * | 下方不够、上方更多 | **向上翻转**，高度取上方空间 |
 * | 上下都不够、上方略多 | 也向上 —— 取较宽敞的一侧，内部滚动 |
 * | 上下都不够、下方略多 | 向下，高度夹到下方空间，内部滚动 |
 *
 * 三条都保证同一件事：**面板不会跑到视口外**。
 *
 * ★ "上下都不够"时**仍要选较宽敞的一侧**，而不是一律向下。
 * 第一版注释写的是"一律向下"，而代码其实会翻上去 —— 注释与代码
 * 各说一套时，下一个人改代码就会照着错的注释改。这里已对齐成代码的行为。
 */
export function placePopover(input: {
  anchor: { top: number; bottom: number; left: number; width: number };
  optionCount: number;
  viewportHeight: number;
  viewportWidth: number;
  /**
   * 面板最小宽度（px）。
   *
   * ★ **必须由调用方按真实字号算**（`popoverMinWidth(getComputedStyle(...).fontSize)`），
   *   不要在这里写默认常量 —— 见文件头"为什么是字数而不是像素"。
   *
   * 不传时退回"严格跟触发器同宽"（老行为）。留这条是因为单测与
   * 未来"必须完全等宽的表格列"需要它；正常界面调用方都应该传。
   */
  minWidth?: number;
}): PopoverPlacement {
  const { anchor, optionCount, viewportHeight, viewportWidth } = input;
  const minWidth = Number.isFinite(input.minWidth) ? Math.max(0, input.minWidth ?? 0) : 0;

  const desired = optionCount * ROW_HEIGHT + PANEL_PADDING;

  const spaceBelow = viewportHeight - anchor.bottom - GAP - EDGE;
  const spaceAbove = anchor.top - GAP - EDGE;

  /*
   * 宽度：先满足"不比触发器窄"（视觉上对齐），再保证"不窄于可读下限"，
   * 最后由"不超出视口安全边距"封顶。
   *
   * ★ 三者顺序不能调：先取 max 再取 min，否则小屏上 minWidth
   *   会把面板顶出屏幕右边（`left` 的夹取兜不住这种情况）。
   *   这条在 `test/popover-responsive.test.mjs` 里按 320~1024 全区间验过。
   */
  const maxWidth = Math.max(0, viewportWidth - EDGE * 2);
  const width = Math.min(Math.max(anchor.width, minWidth), maxWidth);
  const left = Math.min(Math.max(anchor.left, EDGE), Math.max(EDGE, viewportWidth - EDGE - width));

  if (desired <= spaceBelow) {
    return { side: 'down', top: anchor.bottom + GAP, left, width, maxHeight: desired };
  }

  /*
   * 下面放不下。如果上面更宽敞就翻上去 —— 这是原生下拉也有的行为，
   * 用户对"靠近底部时向上展开"是有预期的。
   */
  if (spaceAbove > spaceBelow && spaceAbove > ROW_HEIGHT) {
    const height = Math.min(desired, spaceAbove);
    return { side: 'up', top: anchor.top - GAP - height, left, width, maxHeight: height };
  }

  /*
   * 上下都不够（例如横屏 + 键盘弹起）：仍然向下，但高度夹到可用空间。
   * 至少要留一行的高度，否则面板等于没开。
   */
  const fallback = Math.max(spaceBelow, ROW_HEIGHT);
  return { side: 'down', top: anchor.bottom + GAP, left, width, maxHeight: fallback };
}
