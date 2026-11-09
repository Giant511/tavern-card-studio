/**
 * 输入框聚焦时把它滚进**可见区**（2026-11-04，用户报「点的时候不会跟随键盘弹出」）。
 *
 * ## 为什么只改 CSS 不够
 *
 * `.nb-page` 现在会随键盘变矮（见 `chat.css` 的那一段），页面底边停在键盘上沿。
 * 但**滚动容器不会自己动**：WebView 判断"元素是否可见"用的是布局视口
 * （键盘是 overlay，`innerHeight` 不变），它认为那个输入框一直可见，
 * 于是**不滚**。
 *
 * 结果：页面变矮了，可被聚焦的输入框仍在容器可视范围之外 ——
 * 用户只看到键盘盖住半屏，还得自己手动滑。真机上就是这么表现的。
 *
 * ## 做法
 *
 * 聚焦后，把最近的滚动容器滚到"这个输入框完整可见、再留一点余量"。
 * 用 `scrollTop` 增量而不是 `scrollIntoView()`：
 *
 * - `scrollIntoView()` 会连带滚动**所有**祖先（包括 `html`），
 *   在键盘是 overlay 的环境里会把整页顶走，反而把顶栏挤出屏幕；
 * - 自己算增量只动那一个容器，且"已经可见时不动"（增量为 0），
 *   不会在用户已经手动滑到合适位置后突然跳一下。
 *
 * ## 为什么要在多个时间点重复跑
 *
 * 键盘弹起有动画（约 200–350ms），`.nb-page` 的 padding 是 Android 侧
 * 在 `onApplyWindowInsets` 里分批写入的。只在 `focusin` 当下算一次，
 * 那时页面还没变矮，算出的增量是 0。
 *
 * 所以按 0 / 120 / 300 / 600 / 900 ms 各算一次：每次都是**幂等**的
 * （已经可见就不动），重复跑没有副作用，只是把"动画过程中的新位置"追上。
 */

/** 一次可见性计算需要的四个数（都来自 `getBoundingClientRect`） */
export interface FocusScrollInput {
  /** 输入框顶边（相对视口） */
  elementTop: number;
  /** 输入框底边 */
  elementBottom: number;
  /** 可见区顶边 */
  visibleTop: number;
  /** 可见区底边（已被键盘压缩后的边界） */
  visibleBottom: number;
  /** 容器当前 scrollTop */
  scrollTop: number;
  /** 容器可滚动总高度 */
  scrollHeight: number;
  /** 容器自身高度 */
  clientHeight: number;
}

/** 额外留白：输入框底边与可见区底边之间至少留这么多，免得贴着键盘 */
export const FOCUS_SCROLL_MARGIN = 12;

/**
 * 该把 `scrollTop` 调成多少（返回**目标值**，不是增量）。
 *
 * 返回与传入相同的 `scrollTop` 表示"不用动"。
 *
 * ## 三条规则
 *
 * 1. 底边被挡住 ⇒ 往下滚到刚好露出（含余量）
 * 2. 顶边被挡住 ⇒ 往上滚到刚好露出
 * 3. 本来完整可见 ⇒ **不动**
 *
 * 第 3 条最重要：用户可能已经手动滑到了舒服的位置，
 * 这时再动一下等于"我帮你重新排版"，很讨厌。
 */
export function focusScrollTop(input: FocusScrollInput): number {
  const {
    elementTop,
    elementBottom,
    visibleTop,
    visibleBottom,
    scrollTop,
    scrollHeight,
    clientHeight,
  } = input;

  if (!Number.isFinite(scrollTop)) return 0;

  /* 可见区高度为 0（页面还没排好）时不动，免得算出天文数字 */
  if (!(visibleBottom > visibleTop)) return scrollTop;

  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  const clamp = (value: number): number => Math.min(Math.max(0, value), maxScroll);

  /* ① 底边被挡：往下滚，让底边落在 (visibleBottom - 余量) 处 */
  const overflowBottom = elementBottom - (visibleBottom - FOCUS_SCROLL_MARGIN);
  if (overflowBottom > 0) return clamp(scrollTop + overflowBottom);

  /* ② 顶边被挡：往上滚，让顶边落在 (visibleTop + 余量) 处 */
  const overflowTop = visibleTop + FOCUS_SCROLL_MARGIN - elementTop;
  if (overflowTop > 0) return clamp(scrollTop - overflowTop);

  /* ③ 完整可见 */
  return scrollTop;
}

/**
 * 能在里面滚的容器（只认这几类，别的一律不碰）。
 *
 * ★★★ `.nb-list` 是 2026-11-05 补的（用户第二次提"AI 响应配置里面还是没有
 * 键盘避让"）。
 *
 * 原来只有 `.nb-scroll` / `.nb-msglist`，而**「聊天设置」各级页面用的
 * 根本不是这两个**：
 *
 * ```text
 *   chat-settings.ts   root = nb-page nb-chat-settings
 *                      body = nb-list          ← 滚动发生在它身上
 * ```
 *
 * `.nb-list` 确实是滚动容器（`flex: 1; min-height: 0; overflow-y: auto`），
 * 它只是**没被列进白名单**。于是 `revealFocusedInput` 往上找不到容器，
 * 直接 `return false` —— 页面随键盘变矮了（CSS 那条链是好的），
 * 但输入框还在键盘底下，用户看到的就是"这一页没有键盘避让"。
 *
 * `.nb-sheet`（气泡菜单里编辑消息的弹层）是同一类：`max-height: 78vh` +
 * `overflow-y: auto`，里面有 `textarea`。一起列上，免得下次再报一遍。
 *
 * ## 加新页面时的判据
 *
 * 只要一个容器同时满足"`overflow-y: auto`"和"里面有 `input`/`textarea`"，
 * 就必须进这张表 —— 漏了不会报错，只会**静默不滚**。
 *
 * ★★★ 但"进了表"不等于"它就在滚"（2026-11-06 补，见下）。
 */
const SCROLLER_SELECTORS = ['.nb-scroll', '.nb-msglist', '.nb-list', '.nb-sheet'] as const;

interface ElementLike {
  tagName?: string;
  getBoundingClientRect: () => { top: number; bottom: number };
  scrollIntoView?: () => void;
}

interface ScrollParentLike {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  getBoundingClientRect: () => { top: number; bottom: number };
}

function isTextEntry(node: ElementLike | null): boolean {
  const tag = String(node?.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

/**
 * 把当前聚焦的输入框滚进可见区。
 *
 * `visibleBottom` 由调用方给 —— 那是"键盘上沿"，
 * 只有它能算（`KeyboardHost` 里有 `visualViewport`，这里不重复一套）。
 *
 * 返回是否真的动了（给探针用）。
 */
export function revealFocusedInput(
  doc: {
    activeElement?: unknown;
    querySelectorAll?: (selector: string) => ArrayLike<Element>;
    documentElement?: { clientHeight?: number } | null;
  },
  visibleBottom: number,
): boolean {
  const active = (doc.activeElement ?? null) as ElementLike | null;
  if (active === null || !isTextEntry(active)) return false;

  /*
   * 找**真的能滚**的最近祖先。
   *
   * 不用 `closest()`：`Element` 的 `closest` 只匹配祖先元素，
   * 而那正好是我们要的 —— 但 device 上的类型定义里 `closest` 不一定存在，
   * 且这里只认两个选择器，直接用 `parentElement` 往上走更直白。
   *
   * ★★★ 2026-11-06 修正：命中"白名单"≠"它就在滚"。
   *
   * 用户报「开场与示例」页没有键盘避让。真机实测：
   *
   * ```text
   *   --nb-kb-inset-native = 370px          ← 原生侧检测到键盘
   *   .nb-app padding-bottom = 314px        ← CSS 链正常，页面确实缩矮了
   *   .nb-scroll clientHeight 698 → 384     ← 缩了 314
   *   .nb-list   maxScroll = 0              ← 白名单先命中它，但它滚不动
   *   .nb-scroll maxScroll = 754            ← 真正能滚的是上一层
   *   焦点框 bottom=660，可见底=464          ← 被盖 196px
   *   scrollTop 全程 440，一次没变           ← 没救回来
   * ```
   *
   * 结构是 `.nb-scroll > .nb-list > .nb-field > textarea`。
   * `.nb-list` 的 `overflow-y: auto` 和 `flex: 1` 都在，但它在 `.nb-scroll`
   * 里**不是 flex 子项** ⇒ 高度被内容撑开 ⇒ `scrollHeight === clientHeight`
   * ⇒ `maxScroll = 0`。旧代码就近采纳它，`clamp` 把目标值夹回 0，
   * 差值为 0 就 `return false`，**从不往上看那层真正能滚的 `.nb-scroll`**。
   *
   * 所以采纳条件是"能滚"（内容比可视区高），不是"名字在白名单里"。
   * 不可滚的继续往上找；全都不可滚才 `return false`（那是真的不需要滚）。
   *
   * 这对「聊天设置」页没有副作用：那里的 `.nb-list` 本身就是滚动者
   * （`maxScroll > 0`），照旧被采纳。
   */
  const canScroll = (n: ScrollParentLike): boolean => n.scrollHeight - n.clientHeight > 1;

  let node: (ScrollParentLike & { classList?: { contains: (name: string) => boolean } }) | null = null;
  let cursor: unknown = (active as unknown as { parentElement?: unknown }).parentElement;
  let guard = 0;
  while (cursor !== null && cursor !== undefined && guard < 40) {
    const candidate = cursor as unknown as ScrollParentLike & {
      classList?: { contains: (name: string) => boolean };
      parentElement?: unknown;
    };
    const classes = candidate.classList;
    const hit =
      classes !== undefined &&
      SCROLLER_SELECTORS.some((selector) => classes.contains(selector.slice(1)));
    if (hit && typeof candidate.scrollTop === 'number' && canScroll(candidate)) {
      node = candidate;
      break;
    }
    cursor = candidate.parentElement;
    guard += 1;
  }

  if (node === null) return false;

  const elementRect = active.getBoundingClientRect();
  const containerRect = node.getBoundingClientRect();
  const visibleTop = containerRect.top;

  const next = focusScrollTop({
    elementTop: elementRect.top,
    elementBottom: elementRect.bottom,
    visibleTop,
    /* 容器底边与键盘上沿取更靠上的那个 */
    visibleBottom: Math.min(containerRect.bottom, visibleBottom),
    scrollTop: node.scrollTop,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
  });

  if (Math.abs(next - node.scrollTop) < 1) return false;
  node.scrollTop = next;
  return true;
}

/** 键盘弹起动画期间要重算的时间点（毫秒） */
export const FOCUS_SCROLL_DELAYS = [0, 120, 300, 600, 900] as const;

/**
 * 挂上"聚焦就滚进可见区"的监听。
 *
 * 返回清理函数（面板/页面会被反复重建，不清理会累积监听）。
 *
 * `measureVisibleBottom` 由调用方提供 —— 它要读 `visualViewport` /
 * Android 注入的变量，属于环境知识，不属于这段纯逻辑。
 */
export function attachFocusScroll(
  host: {
    addEventListener: (type: string, handler: (event: unknown) => void) => void;
    removeEventListener: (type: string, handler: (event: unknown) => void) => void;
    activeElement?: unknown;
    querySelectorAll?: (selector: string) => ArrayLike<Element>;
    documentElement?: { clientHeight?: number } | null;
    /** 传 window 时用它兜底（见下方 `doc` 的注释） */
    document?: unknown;
  },
  measureVisibleBottom: () => number,
): () => void {
  const timers: number[] = [];

  /*
   * ★★★ 传 `window` 也能用（2026-11-05）。
   *
   * `installFocusScroll()` 原来传的是 `globalThis`，而 **`window.activeElement`
   * 是 `undefined`** —— `activeElement` 只存在于 `document` 上。
   * 于是 `revealFocusedInput` 每次都在第一行 return false，
   * **一次滚都没滚过**，而纯函数测试全绿（它们只测 `focusScrollTop()`）。
   *
   * 真机证据（`.verify/diag-focus-timeline.mjs`）：
   *
   * ```text
   *   可见底=464 kb=370px      ← CSS 链正常
   *   元素底边恒为 632         ← 被盖住 168px
   *   scrollTop 恒为 0         ← 从未动过
   * ```
   *
   * 调用点已改成传 `document`；这里再兜一层 —— 下次有人误传 `window`，
   * 也只会"少一次监听"，不会静默失效。
   */
  const doc =
    (host as { document?: typeof host }).document !== undefined
      ? ((host as { document: typeof host }).document)
      : host;

  const run = (): void => {
    void revealFocusedInput(doc, measureVisibleBottom());
  };

  const onFocusIn = (): void => {
    /* 清掉上一轮排队的（连点两个输入框时不要两条时间线打架） */
    while (timers.length > 0) {
      const id = timers.pop();
      if (id !== undefined) globalThis.clearTimeout(id);
    }
    for (const delay of FOCUS_SCROLL_DELAYS) {
      timers.push(globalThis.setTimeout(run, delay) as unknown as number);
    }
  };

  host.addEventListener('focusin', onFocusIn);

  return () => {
    host.removeEventListener('focusin', onFocusIn);
    while (timers.length > 0) {
      const id = timers.pop();
      if (id !== undefined) globalThis.clearTimeout(id);
    }
  };
}
