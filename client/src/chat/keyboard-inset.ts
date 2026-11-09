/**
 * 软键盘避让（v0.1.7 / 第七批问题三）。
 *
 * ## 现象
 *
 * 聊天页点输入框，软键盘弹起后**直接盖住输入区**，打字时看不见自己输了什么。
 *
 * ## 为什么不能靠 `resize` 事件
 *
 * 教训来自本项目已经踩过的坑：Android WebView 里"键盘弹起"没有一个可靠通告。
 * 三个候选信号各自残缺：
 *
 * | 信号 | 它成立的前提 | 本项目的现状 |
 * |---|---|---|
 * | `window.innerHeight` 变小 | 窗口 `adjustResize` 生效 | `MainActivity` 调了 `enableEdgeToEdge()`，窗口不再随 IME 缩放 |
 * | 清单 `windowSoftInputMode` | 有人显式写 | 清单里**没有**这一项 |
 * | `resize` 事件 | 上面两者之一变了 | 上两者都不变时**根本不发** |
 *
 * 所以只有 `visualViewport` 是可靠的：它在键盘弹起时一定会变小
 * （那是"视觉视口"，与窗口布局无关）。
 *
 * ## 公式
 *
 * ```text
 * 键盘高度 = (window.innerHeight - visualViewport.offsetTop) - visualViewport.height
 * ```
 *
 * 用 `layoutBottom - vvBottom` 而不是 `innerHeight - vv.height`：
 * 页面被**滚动**时 `offsetTop` 会非零（iOS 上尤其明显），
 * 不减它就多算一截，输入区会被推得比键盘还高，露出一条空白。
 *
 * ## 为什么"不重复扣"是自动成立的
 *
 * 如果哪天环境改成 `adjustResize` 生效、`innerHeight` 自己就缩了，
 * 那么 `innerHeight ≈ vv.height + vv.offsetTop`，公式结果自然 ≈ 0。
 * **同一段代码在两种环境下都对**，这比"判断环境再决定扣不扣"稳 ——
 * 后者要枚举环境，枚举漏一个就是重复扣或没扣。
 *
 * ## 这一层为什么是纯逻辑
 *
 * 键盘没法在 Node 里弹。但"给定一组视口尺寸，该扣多少"完全可以测，
 * 而**算错这件事的后果全是静默的**（多扣一条空白 / 少扣一点被盖住），
 * 真机上要盯着看才可能发现。所以把算术抽出来钉住。
 */

/** 一次视口测量的最小输入（只取算键盘高度需要的那几个字段） */
export interface ViewportMetrics {
  /** `window.innerHeight` —— **布局**视口高度 */
  innerHeight: number;
  /** `visualViewport.height` —— **视觉**视口高度（键盘弹起时变小） */
  visualHeight: number;
  /** `visualViewport.offsetTop` —— 页面被顶起/滚动后的偏移 */
  visualOffsetTop: number;
}

/**
 * 需要给输入区让出的高度（CSS px）。
 *
 * 返回 0 表示"不用让位"（键盘没弹 / 环境已经自己缩好了）。
 *
 * ## 为什么要夹到 `[0, innerHeight]`
 *
 * · 下界 0：某些 WebView 在旋转、分屏切换的瞬间会给出
 *   `visualHeight > innerHeight` 的短暂不一致值。不夹的话会得到**负 padding**
 *   （CSS 里负 padding 非法，整条规则被丢弃，表现为"偶尔不生效"）。
 * · 上界 `innerHeight`：宁可把内容压扁，也不要把输入区推到屏幕外
 *   —— 前者还能看见，后者等于输入框消失了。
 */
export function keyboardInset(metrics: ViewportMetrics): number {
  const { innerHeight, visualHeight, visualOffsetTop } = metrics;

  if (!Number.isFinite(innerHeight) || !Number.isFinite(visualHeight)) return 0;
  if (innerHeight <= 0 || visualHeight <= 0) return 0;

  const offsetTop = Number.isFinite(visualOffsetTop) ? visualOffsetTop : 0;
  const layoutBottom = innerHeight - offsetTop;
  const raw = layoutBottom - visualHeight;

  if (!Number.isFinite(raw)) return 0;
  return Math.min(Math.max(0, Math.round(raw)), Math.round(innerHeight));
}

/**
 * 小于这个值就当作"没有键盘"。
 *
 * ## 为什么需要阈值
 *
 * 浏览器的地址栏收缩、手势提示条、`visualViewport` 的亚像素抖动，
 * 都会让公式给出 1~20px 的"假键盘"。而 1px 的 padding 变化会让
 * 消息列表重排一次 —— 滚动位置会跳，用户正在看的那条消息会跑掉。
 *
 * 48px 的依据：最小的软键盘（横屏下的紧凑键盘）也超过 100px，
 * 而所有"假键盘"都远小于 48px。中间留足了间隔。
 */
export const KEYBOARD_MIN_INSET = 48;

/**
 * 给界面用的最终值：小于阈值的一律归零。
 *
 * 与 `keyboardInset()` 分开是**故意的**：
 * `keyboardInset()` 是纯算术（可被独立验证），阈值是产品判据。
 * 混在一起的话，将来有人调整阈值就得连算术一起复查。
 */
export function effectiveKeyboardInset(metrics: ViewportMetrics): number {
  const inset = keyboardInset(metrics);
  return inset < KEYBOARD_MIN_INSET ? 0 : inset;
}

/** 写 CSS 变量用的名字（JS 与 CSS 各写一遍字符串必然分叉，所以集中在这里） */
export const KEYBOARD_INSET_VAR = '--nb-kb-inset';

/**
 * 绑上"键盘弹起就更新 CSS 变量"的监听。
 *
 * ## 为什么两个事件都要听
 *
 * · `resize`：键盘弹起/收起（`visualViewport.height` 变）
 * · `scroll`：键盘弹起时页面被**顶起**（`offsetTop` 变），
 *   而这时 `height` 可能没变 —— 只监听 resize 会漏掉这一半。
 *   真机上的表现是"键盘弹起来了、输入框却还在下面"。
 *
 * ## 为什么 `passive: true`
 *
 * 这两个事件在滚动/缩放时高频触发。不加 passive 会让浏览器
 * 等我们的处理函数跑完再滚，手感发涩。而我们**不阻止默认行为**，
 * 声明 passive 没有代价。
 *
 * ## 返回值是清理函数
 *
 * 面板会被反复重建（切 Tab）。不清理的话监听器会累积，
 * 每个都往同一个 CSS 变量里写 —— 数值正确但越来越多，
 * 直到某次 `dispose` 之后仍在跑（写向已移除的 root）。
 */
export interface KeyboardHost {
  innerHeight: number;
  visualViewport?: {
    height: number;
    offsetTop: number;
    addEventListener: (type: string, listener: () => void, options?: { passive?: boolean }) => void;
    removeEventListener: (type: string, listener: () => void) => void;
  } | null;
  documentElement?: { style: { setProperty: (name: string, value: string) => void } } | null;
}

export function attachKeyboardInset(host: KeyboardHost): () => void {
  const viewport = host.visualViewport;
  const root = host.documentElement;

  // 没有 visualViewport 就没法算（老 WebView）。**什么都不做**，
  // 而不是装作已处理 —— 那样只会让人以为修好了。
  if (viewport === undefined || viewport === null || root === undefined || root === null) {
    return () => {};
  }

  const update = (): void => {
    const inset = effectiveKeyboardInset({
      innerHeight: host.innerHeight,
      visualHeight: viewport.height,
      visualOffsetTop: viewport.offsetTop,
    });
    root.style.setProperty(KEYBOARD_INSET_VAR, `${String(inset)}px`);
  };

  viewport.addEventListener('resize', update, { passive: true });
  viewport.addEventListener('scroll', update, { passive: true });

  // 挂上就先算一次：从"键盘已经弹着"的状态切回聊天页时，
  // 不会再有 resize 事件，初值只能自己算。
  update();

  return () => {
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
    root.style.setProperty(KEYBOARD_INSET_VAR, '0px');
  };
}
