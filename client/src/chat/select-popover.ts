/**
 * 下拉面板（2026-11-03）—— 贴着控件下方展开，替代原生 `<select>`。
 *
 * ## 为什么不用原生 `<select>`
 *
 * 用户的原话：
 *
 * > AI 响应配置的所有下拉框里面都显示不出来，而且这个下拉框的样式有点丑，
 * > 和 APP 的 UI 风格一点也不搭，不要这种弹窗式的
 *
 * 真机取证（`.verify/probe-select-box.mjs` + 录屏抽帧）：
 *
 * ```text
 *   元素本身：361×51px，color = rgb(244,242,251)，bg = rgb(28,25,41)   ← 完全正常
 *   点开之后：白色背景的系统弹窗，选项文字是**白色**                    ← 一个字都看不见
 * ```
 *
 * `<select>` 元素本身是好的，坏的是**点击后那个系统弹窗**。它是 WebView 用
 * 系统控件画的，只认 `color-scheme`、不认我们的深色 token，而 `<option>`
 * 的背景/字号/圆角写 CSS **全部无效**。
 *
 * 所以只能自己画。
 *
 * ## 为什么是"贴着控件展开"而不是底部面板
 *
 * 第一版我做成了底部面板（复用 `nb-sheet`）。用户随后明确否掉：
 *
 * > 我偏向于这种下拉框（附 ST 原生截图：贴着控件下方展开、深色、选中项高亮）
 *
 * 底部面板在这个场景确实更差：一来这不是"危险操作确认"那种需要打断的场景，
 * 二来设置页一屏有 6 个下拉，每次都要把视线移到屏幕底部再移回来。
 *
 * ## 定位为什么用 CSS 变量而不是内联 `style`
 *
 * 本项目有一条明确的取舍：`main.ts` 的通知曾经用内联 `style` 拼 `bottom`，
 * 被走查判据拦下（`test/notify-and-sound.test.mjs`：「不许再拼 bottom 内联样式」）。
 *
 * 但位置必须由 JS 算（要读 `getBoundingClientRect`）。所以：
 *   · JS 只通过 `style.setProperty` 写 4 个 CSS **变量**
 *   · 真正的 `top` / `left` / `width` / `max-height` 由 CSS 读变量决定
 *
 * 这与键盘避让（`keyboard-inset.ts` 的 `--nb-keyboard-inset`）是同一个做法。
 *
 * ## 为什么不挂在字段行里用 `position: absolute`
 *
 * `.nb-list` 有 `overflow-y: auto` —— 绝对定位的子元素会被**滚动容器裁掉**，
 * 靠屏幕底部的下拉会被切一半。所以挂到 `body`、用 `position: fixed`。
 */

import { placePopover, popoverMinWidth } from '@tcs/shared';

import { el, type DocLike, type ElLike } from './chat-view.ts';

/**
 * 读"选项文字实际会用到多大的字号"。
 *
 * ## 为什么要单独一段、而不是 assume 16px
 *
 * 用户两次明令 UI 不能只按当前这台设备来。字号正是最容易因设备而变的量：
 * 系统字体缩放、ROM 默认字号、我们的 token 档位（14/16）都会改它。
 *
 * ## 三档回退
 *
 * ```text
 *   ① 页面上真实存在的元素（.nb-select-option）→ 最准
 *   ② :root 的 font-size                     → 还没渲染过选项时用（token 挂在根上）
 *   ③ 16                                    → 什么都没有时（老内核）
 * ```
 *
 * ★ 用 `parseFloat` 而不是直接 `Number`：`getComputedStyle().fontSize`
 *   返回 `"16px"`，`Number("16px")` 是 `NaN` —— 那会让 `popoverMinWidth()`
 *   走兜底分支，看起来"能用"，实际上**永远用不到真实字号**（静默失效）。
 */
function readOptionFontSize(doc: DocLike): number {
  const probe = doc as unknown as {
    defaultView?: { getComputedStyle?: (n: unknown) => { fontSize?: string } };
    querySelector?: (s: string) => unknown;
    documentElement?: unknown;
  };
  const style = probe.defaultView?.getComputedStyle;
  if (style === undefined) return 16;

  const candidates = [
    probe.querySelector?.('.nb-select-option'),
    probe.documentElement,
  ];
  for (const node of candidates) {
    if (node === null || node === undefined) continue;
    try {
      const raw = style(node).fontSize ?? '';
      const value = Number.parseFloat(raw);
      if (Number.isFinite(value) && value > 0) return value;
    } catch {
      /* 某些 stub 的 getComputedStyle 会抛，继续试下一个 */
    }
  }
  return 16;
}

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * 当前打开着的下拉面板（同一时刻只允许一个）。
 *
 * 为什么要模块级变量：面板挂在 `body` 上，不在字段行的子树里。
 * 若不做单实例，点另一个下拉时前一个会**留在屏幕上** —— 两个面板同时开着，
 * 而它们各自的位置都不对（前一个还锚在旧触发器上）。
 */
let activeSelectPopover: { close: () => void } | null = null;

/** 关掉当前打开的下拉（给"外部点击/换一个下拉"用） */
export function closeActiveSelectPopover(): void {
  activeSelectPopover?.close();
  activeSelectPopover = null;
}

export interface SelectPopoverOptions {
  options: ReadonlyArray<SelectOption>;
  current: string;
  /** 触发器的 DOM 元素，用来读位置、判断"点的是不是它自己" */
  anchorEl: unknown;
  onPick: (value: string) => void;
  /** 关闭回调（用于让触发器恢复未展开的视觉） */
  onClose?: () => void;
}

/**
 * 打开下拉面板。
 *
 * 交互与原生下拉一致：
 *   · 点某一项 → 选中并关闭
 *   · **点触发器 → 收起**（由 `makeSelectTrigger` 的 toggle 负责）
 *   · 点面板与触发器以外任意处 → 关闭（不改变选择）
 *   · 滚动页面 → 关闭（面板是 fixed 定位，滚动后就错位了）
 *   · Esc → 关闭
 *
 * ## ★★★ 为什么不再用"全屏遮罩"接外部点击
 *
 * 第一版挂了一个 `position: fixed; inset: 0` 的透明遮罩来接"点外面关闭"。
 * 用户报的现象：
 *
 * > 点下拉框只会重新展开而不是点一下打开再点一下收回
 *
 * 真因就是那个遮罩：它盖在触发器上面。第二次点触发器时，
 * `pointerdown` 先落到遮罩上 → 遮罩关闭并移除；紧接着这次点击的
 * `click` 派发到遮罩下方的**触发器**上 → 又打开一次。
 *
 * 于是用户看到的不是"收起来"，而是"闪一下又开了"。
 *
 * 现在改成：不铺遮罩，在 `document` 上挂 `pointerdown`，
 * 判断点击目标既不在面板里、也不在触发器上时才关闭。
 * 触发器本身没有任何东西挡着，它的 `click` 就能老老实实做 toggle。
 */
export function openSelectPopover(
  doc: DocLike,
  options: SelectPopoverOptions,
): { close: () => void } {
  let open = true;

  /* 单实例：开新的之前先关掉旧的 */
  closeActiveSelectPopover();

  const panel = el(doc, 'div', 'nb-popover nb-select-popover');
  panel.setAttribute('data-role', 'select-popover');
  panel.setAttribute('role', 'listbox');

  const docEvents = doc as unknown as {
    addEventListener?: (t: string, h: (e: unknown) => void, c?: boolean) => void;
    removeEventListener?: (t: string, h: (e: unknown) => void, c?: boolean) => void;
  };

  /**
   * 某个节点是不是在 `root` 里面。
   *
   * `ElLike` 没有 `contains`（接口刻意只有 11 个成员），
   * 而这里一定是真 DOM —— 用一次断言比给接口加成员更干净
   * （与取 `doc.body` 同一处取舍）。
   */
  const contains = (root: unknown, node: unknown): boolean => {
    const host = root as { contains?: (n: unknown) => boolean } | null;
    if (host?.contains === undefined) return false;
    if (node === null || node === undefined) return false;
    return host.contains(node);
  };

  /*
   * `handle` 在 `close` 里被引用（要把自己从 `activeSelectPopover` 摘掉），
   * 而 `close` 又要在 `handle` 定义之前给事件监听用 —— 所以先声明、
   * 在下面统一赋值。这是唯一需要"先声明后赋值"的地方。
   */
  const handle: { close: () => void } = { close: () => undefined };

  const close = (): void => {
    if (!open) return;
    open = false;
    docEvents.removeEventListener?.('pointerdown', onPointerDown, true);
    docEvents.removeEventListener?.('scroll', onScroll, true);
    docEvents.removeEventListener?.('keydown', onKey, true);
    /* `ElLike` 没有 remove()，但面板一定是真 DOM 节点 */
    (panel as unknown as { remove?: () => void }).remove?.();
    if (activeSelectPopover === handle) activeSelectPopover = null;
    options.onClose?.();
  };

  /*
   * 外部点击关闭。
   *
   * 两个"不许关"的例外，都是必须的：
   *   ① 点在面板里 —— 那是选项，交给选项自己的 click 处理
   *   ② 点在触发器上 —— 交给触发器的 click 做 toggle
   *
   * 少了 ② 就会出现"点了没反应"：这里关掉、触发器那边又打开。
   */
  const onPointerDown = (event: unknown): void => {
    const target = (event as { target?: unknown }).target;
    if (contains(panel, target)) return;
    if (contains(options.anchorEl, target)) return;
    close();
  };

  /*
   * 页面滚动关闭。
   *
   * ★ 面板内部的滚动**不算** —— 6 个选项在小屏上可能要内部滚一下才能看全，
   * 滚一下面板就消失，用户会以为"点错了"。
   */
  const onScroll = (event: unknown): void => {
    const target = (event as { target?: unknown }).target;
    if (contains(panel, target)) return;
    close();
  };

  const onKey = (event: unknown): void => {
    if ((event as { key?: string }).key === 'Escape') close();
  };


  for (const option of options.options) {
    const row = el(doc, 'button', 'nb-select-option');
    row.setAttribute('type', 'button');
    row.setAttribute('data-role', 'select-option');
    row.setAttribute('data-value', option.value);
    row.setAttribute('role', 'option');
    if (option.value === options.current) {
      row.setAttribute('data-selected', 'true');
      row.setAttribute('aria-selected', 'true');
    }

    const label = el(doc, 'span', 'nb-select-option-label');
    label.textContent = option.label;
    row.append(label);

    if (option.value === options.current) {
      /*
       * 选中标记用文字「✓」而不是图标：渲染层没有图标体系，
       * 而 `innerHTML` 在本项目是明令禁止的（XSS 面）。
       */
      const tick = el(doc, 'span', 'nb-select-option-tick');
      tick.textContent = '✓';
      tick.setAttribute('aria-hidden', 'true');
      row.append(tick);
    }

    row.addEventListener?.('click', () => {
      /*
       * 先关闭再回调：回调会改触发器的文字，可能还会重绘页面。
       * 若先回调再关闭，面板要等回调跑完才消失 —— 用户会看到"点了没反应"那一瞬。
       */
      close();
      options.onPick(option.value);
    });

    panel.append(row);
  }

  /* 空列表：给一句话，别给一个空面板（那看起来像坏了） */
  if (options.options.length === 0) {
    const empty = el(doc, 'div', 'nb-select-empty');
    /*
     * 文案判据（用户两次明令）：**用户读了知道能做什么**，不是"这句话有没有错"。
     *
     * 原来写「没有可选项」—— 只说了现象。用户的下一个问题必然是
     * "那我怎么办"，而界面上没有答案。所以补上"下一步去哪"。
     */
    empty.textContent = '这一项没有可选值。先点下面的「保存」重试；还不行就稍后再试。';
    panel.append(empty);
  }

  /*
   * 读触发器位置。
   *
   * `ElLike` 刻意没有 `getBoundingClientRect`（接口只留 11 个成员，
   * 加了会让所有单测 stub 都要跟着补）。这里一定是真 DOM，用一次断言更干净
   * —— 与 `bubble-menu.ts` 取 `doc.body` 同一处取舍。
   */
  const anchor = options.anchorEl as {
    getBoundingClientRect?: () => { top: number; bottom: number; left: number; width: number };
  };
  const rect = anchor.getBoundingClientRect?.() ?? { top: 0, bottom: 0, left: 0, width: 240 };

  const view = doc as unknown as { defaultView?: { innerHeight: number; innerWidth: number } };
  const viewportHeight = view.defaultView?.innerHeight ?? 800;
  const viewportWidth = view.defaultView?.innerWidth ?? 400;

  /*
   * ★★★ 最小宽度**按真实字号算**，不写死像素（2026-11-07）。
   *
   * 用户两次强调：
   *
   * > 所有的 UI 设计不能只依据我当前连到电脑上的这台手机，要保证不同手机可以兼容
   *
   * 所以这里读的是**浏览器算出来的字号**，而不是 token 里那个 16px：
   *
   * ```text
   *   系统字体放大 1.3×  ⇒ fontSize 20.8px ⇒ 最小宽度跟着变大 ✓
   *   小字号档（--nb-fs-14）⇒ 最小宽度自动缩，不浪费横向空间 ✓
   *   换平台默认字号（某些 ROM 是 17px）⇒ 同样自适应 ✓
   * ```
   *
   * 读不到样式（老内核 / 无 defaultView）时退回 16px —— `popoverMinWidth()`
   * 内部兜底，不会返回 0（返回 0 等于没有下限，又回到"跟着 89px 触发器竖排"）。
   */
  const fontSize = readOptionFontSize(doc);
  const minWidth = popoverMinWidth(fontSize, viewportWidth);

  const placement = placePopover({
    anchor: rect,
    optionCount: Math.max(1, options.options.length),
    viewportHeight,
    viewportWidth,
    minWidth,
  });

  /*
   * ★ 只写 CSS **变量**，不写 `top`/`left` 本身。
   *
   * 直接拼内联样式在本项目被走查判据拦过（`test/notify-and-sound.test.mjs`）。
   * 用变量 + CSS 读取，既保留"位置由 JS 算"的能力，又不破坏那条规矩。
   */
  panel.setAttribute('data-side', placement.side);
  panel.style.setProperty('--pop-top', `${String(Math.round(placement.top))}px`);
  panel.style.setProperty('--pop-left', `${String(Math.round(placement.left))}px`);
  panel.style.setProperty('--pop-width', `${String(Math.round(placement.width))}px`);
  panel.style.setProperty('--pop-max-h', `${String(Math.round(placement.maxHeight))}px`);

  const host = (doc as unknown as { body?: { append?: (n: unknown) => void } }).body;
  if (host?.append !== undefined) {
    host.append(panel);
  } else {
    (doc as unknown as { documentElement?: { append?: (n: unknown) => void } })
      .documentElement?.append?.(panel);
  }

  /*
   * 三个全局监听都用 **capture**：
   * 页面里可能有别的元素 `stopPropagation`（聊天区的滚动容器就干过），
   * 用捕获阶段能保证我们先收到。
   */
  docEvents.addEventListener?.('pointerdown', onPointerDown, true);
  docEvents.addEventListener?.('scroll', onScroll, true);
  docEvents.addEventListener?.('keydown', onKey, true);

  handle.close = close;
  activeSelectPopover = handle;

  return handle;
}

/** 自己画的下拉控件 */
export interface SelectTrigger {
  /** 放进表单的那个元素 */
  el: ElLike;
  /** 换掉整个选项列表（预设是异步读回来的，要能后填） */
  setOptions: (options: ReadonlyArray<SelectOption>) => void;
  /** 只改当前值（切换失败时把它拨回去） */
  setValue: (value: string) => void;
}

/**
 * 一个"看起来像输入框、点开是下拉面板"的控件。
 *
 * 为什么做成 `button` 而不是继续用 `select`：
 * 只要元素是 `<select>`，点击就**必然**弹系统面板，没有开关能关掉它。
 *
 * 它对外暴露的契约与原来的 `<select>` 一致：
 *   · 当前值放在 `data-value` 属性上（原来读 `.value`）
 *   · `data-option-count` 给出选项数（验收脚本据此判断"选项在不在"）
 */
export function makeSelectTrigger(
  doc: DocLike,
  spec: {
    label: string;
    options: ReadonlyArray<SelectOption>;
    current: string;
    /**
     * 选中某一项后的回调（可选）。
     *
     * 两种使用方式：
     *   · **不传** —— 用户点选的只是"表单里的一个值"，等点「保存」时统一提交
     *     （枚举字段走这条：`data-value` 已经更新，保存时读它）
     *   · **传** —— 点选即刻生效（预设走这条：切预设本身就是一个动作）
     *
     * 之所以做成可选而不是强制：强制的话每个枚举字段都要写一个空函数，
     * 而空函数看起来像"漏了实现"。
     */
    onPick?: (value: string) => void;
  },
): SelectTrigger {
  const trigger = el(doc, 'button', 'nb-input nb-select-trigger');
  trigger.setAttribute('type', 'button');
  trigger.setAttribute('aria-label', spec.label);
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const valueText = el(doc, 'span', 'nb-select-trigger-value');
  const chevron = el(doc, 'span', 'nb-select-trigger-chevron');
  chevron.setAttribute('aria-hidden', 'true');
  /* 与 ST 原生下拉一致：向下的小三角 */
  chevron.textContent = '▾';
  trigger.append(valueText, chevron);

  /*
   * 选项与当前值放在**闭包**里（不是每次点击读 DOM 属性）：
   *   · 预设是异步读回来的，`setOptions` 之后面板要立刻能列出新选项；
   *   · 点开面板时不该依赖 `data-value` 字符串 —— 那是渲染细节。
   */
  let options: ReadonlyArray<SelectOption> = spec.options;
  let value = spec.current;

  const paint = (): void => {
    const hit = options.find((one) => one.value === value);
    /*
     * 找不到就显示原值而不是留空 —— 留空会让用户以为设置丢了。
     * ST 里可能出现我们没列进 options 的值（比如它自己加的新枚举）。
     */
    valueText.textContent = hit === undefined ? value : hit.label;
    trigger.setAttribute('data-value', value);
    trigger.setAttribute('data-option-count', String(options.length));
  };

  paint();

  /*
   * 这个触发器自己的面板句柄。
   *
   * `null` = 现在没开。它也是 toggle 的依据：
   * 第一次点 → 开；再点一次 → 关。用户对下拉的预期就是这个。
   */
  let handle: { close: () => void } | null = null;

  trigger.addEventListener?.('click', () => {
    /* 一个选项都没有时点开是空面板，只会让人困惑 */
    if (options.length === 0) return;

    /*
     * ★★★ 先判"已经开着" ⇒ 收起。
     *
     * 用户报的缺陷：
     *
     * > 点下拉框只会重新展开而不是点一下打开再点一下收回
     *
     * 原来这里无条件 `openSelectPopover(...)`，第二次点等于**又开一个**
     * （旧的那个被 `closeActiveSelectPopover()` 关掉，看起来就是"重新展开"）。
     * 再叠加当时那层全屏遮罩抢走了第一次点击，现象更像"怎么点都只开不收"。
     */
    if (handle !== null) {
      handle.close();
      return;
    }

    trigger.setAttribute('aria-expanded', 'true');
    handle = openSelectPopover(doc, {
      options,
      current: value,
      anchorEl: trigger,
      onClose: () => {
        handle = null;
        trigger.setAttribute('aria-expanded', 'false');
        /*
         * 主动放弃焦点。
         *
         * 手机上点完之后焦点会一直留在触发器上。虽然 CSS 已经把紫边
         * 改成只在 `aria-expanded='true'` 时出现，但保留焦点还有别的副作用：
         * 虚拟键盘可能被唤起、`:focus-visible` 会在下一次按键时闪一圈。
         * 下拉本来就是"点完就走"的控件，不需要留焦点。
         */
        (trigger as unknown as { blur?: () => void }).blur?.();
      },
      onPick: (picked) => {
        value = picked;
        paint();
        spec.onPick?.(picked);
      },
    });
  });

  return {
    el: trigger,
    setOptions: (next) => {
      options = next;
      paint();
    },
    setValue: (next) => {
      value = next;
      paint();
    },
  };
}
