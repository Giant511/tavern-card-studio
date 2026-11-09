/**
 * 聊天页的**纯渲染函数**（v0.1.7 / T15.5）。
 *
 * ## 为什么把渲染从面板里拆出来
 *
 * 面板（`chat-panel.ts`）要管手势、流式、网络 —— 那些东西在 Node 里跑不起来。
 * 但如果渲染和它们混在一起，**渲染结果就没法测**了，只能靠截图看。
 *
 * 所以这里只做一件事：**给定数据，产出元素结构**。不碰全局 `document`，
 * 而是接收一个极简的 `DocLike` 接口 —— 真实浏览器里传 `document`，
 * 测试里传一个 30 行的 stub。这样：
 *   · 不新增 jsdom/happy-dom 依赖（项目至今零 DOM 测试依赖）；
 *   · 断言的是**真实渲染出来的树**，不是源码字符串；
 *   · 能覆盖 T15.6 三个挂载点、气泡结构、markdown 输出。
 *
 * ## ★ 这一层也承担 XSS 的最后一道关
 *
 * 正文走 `innerHTML`（因为 markdown 要变成标签），而 `renderMessageHtml`
 * 已经全量转义过。**除它之外，本文件任何地方都不许把外部字符串塞进 innerHTML**
 * —— 名字、时间、候选指示全部走 `textContent`。
 */

import {
  currentSwipeIndex,
  isVoiceMsg,
  renderMessageHtml,
  renderMessageText,
  swipeCount,
  voiceDurationMs,
  VOICE_BADGE_LABEL,
  type StChatMessage,
} from '@tcs/shared';

/* ═══════════════════════════════════════════════════════════
   极简 DOM 接口
   ═══════════════════════════════════════════════════════════ */

/**
 * 只包含本项目用得到的 DOM 能力。
 *
 * 刻意不写 `Document` / `HTMLElement`：那样测试里就得造一个几乎完整的 DOM stub
 * （几十个成员），而实际用到的只有下面这些。接口小 → stub 小 → 测试读得懂。
 */
/**
 * `children` 的真实形状（2026-11-01 加）。
 *
 * ## 为什么不直接用 `ElLike[]`
 *
 * 真实 DOM 给的是 `HTMLCollection`：**可索引、有 length、可迭代**，
 * 但**没有** `find` / `some` / `map`。声明成数组会让 TS 放行那些方法，
 * 运行时才炸 —— 而且只在真机（真实 DOM）上炸，单测的 stub 是真数组，全绿。
 *
 * ## 为什么也不用 `ArrayLike<ElLike>`
 *
 * 我先试过 `ArrayLike`，它让 `[...children]` 编译失败 ——
 * 而 `HTMLCollection` **确实可迭代**，扩展运算符在运行时是合法的。
 * `ArrayLike` 比真实形状更窄，那是另一种不准确。
 *
 * 所以这里只声明真实存在的那三样。要数组方法就 `Array.from(...)`，
 * 代价一次显式转换，换来"不会在运行时才炸"。
 */
export interface ChildList {
  readonly length: number;
  readonly [index: number]: ElLike;
  [Symbol.iterator](): Iterator<ElLike>;
  item(index: number): ElLike | null;
}

export interface ElLike {
  className: string;
  textContent: string;
  innerHTML: string;
  hidden: boolean;
  readonly dataset: Record<string, string | undefined>;
  /**
   * 子元素。**类型是 `ChildList`，不是 `ElLike[]`**（2026-11-01 修）。
   *
   * ## 为什么这个差别会咬人
   *
   * 真实 DOM 的 `children` 是 **`HTMLCollection`** —— 它**没有**
   * `.find()` / `.some()` / `.map()`（那些是 Array 的方法）。
   *
   * 而这里原来声明成 `ElLike[]`，于是 TypeScript **放行**了
   * `this.listEl.children.find(...)`，运行时每帧抛：
   *
   * ```
   * TypeError: this.listEl.children.find is not a function
   *     at patchStreamingMessage
   * ```
   *
   * 现象：真机上消息发出去了、ST 回了 7 帧、`done` 也发了，
   * 但气泡里**一个字都没有**，呼吸点一直转。
   *
   * 为什么单测抓不到：测试用 30 行 stub 当 `doc`，stub 的 `children`
   * 是**真数组** —— `.find()` 有，全绿。这是"stub 比真实 DOM 更宽容"
   * 造成的假绿（与 §60 那条"2200 个测试全绿但没 mount 过 ChatPanel"同源）。
   *
   * 改成 `ChildList` 之后，任何对 `children` 用数组方法的代码
   * **编译期就报错**，必须显式 `Array.from(...)`。
   */
  readonly children: ChildList;
  append(...nodes: Array<ElLike | string>): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  /**
   * 移除属性（2026-11-04 加）。
   *
   * 只为**布尔属性**而加 —— 最典型的是 `disabled`：
   *
   * ```ts
   * button.setAttribute('disabled', '');   // 想"清掉"，实际仍然是禁用
   * button.removeAttribute('disabled');    // 这才是解除
   * ```
   *
   * `disabled` / `hidden` / `checked` 都是"存在即生效"，值是什么无关。
   * 用空串复位是错的，而它不报错、不红单测，只会在某条路径上让按钮
   * 静默失效（真机上抓到过一次：点登录→取消风险框→按钮永久变灰）。
   *
   * 之前这个接口没有它，所以真机能用（真实 DOM 有这个方法）而
   * `tsc -p client` 报错 —— 类型声明比真实 DOM 窄，写出来的代码
   * 运行正常但过不了类型检查。
   */
  removeAttribute(name: string): void;
  addEventListener(type: string, handler: (event: unknown) => void): void;
  replaceChildren(...nodes: Array<ElLike | string>): void;
  /**
   * 内联样式。**只声明用得到的那一个方法**。
   *
   * `setProperty` 而不是 `el.style.width = '40%'`：后者要求这里把
   * `CSSStyleDeclaration` 的整个类型搬进来（上百个属性），
   * 而我们只用来设一两个自定义属性/宽度 —— 声明面越小，
   * Node 里的 stub 越好写（这是这套 `DocLike` 存在的意义）。
   */
  style: { setProperty: (name: string, value: string) => void; width: string };
  /** 从 DOM 摘掉自己 */
  remove(): void;
}

export interface DocLike {
  createElement(tag: string): ElLike;
  /**
   * 造一个**带命名空间**的元素（2026-11-02 加，可选）。
   *
   * 只为一件事：给大圆按钮画那个白色线稿麦克风（`<svg>`）。
   * `createElement('svg')` 在真 DOM 里造出来的是 `HTMLUnknownElement`，
   * 浏览器不会渲染其中的 `<rect>` —— 必须走 `createElementNS` 才是真 SVG。
   *
   * ## 为什么声明成可选
   *
   * 单测与 demo 的 DOM stub 只实现 `createElement`。若声明成必选，
   * 那一堆 stub 都要跟着补一个用不到的方法 —— 而 stub 的价值就在于小。
   * 可选之后：真 DOM 走 SVG，stub 走 `makeMicIcon()` 里的降级分支
   * （一个字形），两边都能渲染，判据也不必依赖 SVG 存在。
   */
  createElementNS?(namespace: string, tag: string): ElLike;
}
/*
 * 刻意**没有** `createTextNode`。
 *
 * 第一版加了它，后果是 `document` 无法直接传给本模块（真实 `Text` 节点
 * 没有 `className`/`innerHTML` 这些成员），demo 与面板都得写类型断言绕过去 ——
 * 而那个方法**从来没有被用到过**。多声明一个用不到的方法，
 * 换来的是"真实对象不能用、必须假装"。
 */

/** 造一个元素。`className` 用第二参传，省掉每次 setAttribute */
export function el(doc: DocLike, tag: string, className?: string): ElLike {
  const node = doc.createElement(tag);
  if (className !== undefined && className !== '') node.className = className;
  return node;
}

/* ═══════════════════════════════════════════════════════════
   ★ T15.6 三个语音挂载点（本期只渲染占位）
   ═══════════════════════════════════════════════════════════ */

/**
 * 三个挂载点的 **DOM 契约**。
 *
 * 为什么要有这份常量、而不是散在各处写字符串：
 * T15.6 接入时要 `document.getElementById(...)` 找它们。任何一处拼错，
 * 表现是"语音功能不显示"，而排查的人不知道正确的 id 应该是什么。
 *
 * 这份常量同时被 `chat-panel.ts`（创建）与测试（断言存在）使用 ——
 * **两处同源**，改一处两边一起变。
 *
 * 尺寸/位置按 T15.6 终版规格预留，目的是"语音接入时不改布局"：
 *
 * | 挂载点 | 位置 | 规格 |
 * |---|---|---|
 * | 麦克风 | 输入区，发送按钮左侧 | 48×48（设计册 §3.4） |
 * | chips 浮层 | 输入区**上方**，浮起 | 三 chips 横排居中，默认不显示 |
 * | 待确认条 | 输入区**正上方**一整条 | 默认不显示，开启确认时才出现 |
 */
export const VOICE_MOUNTS = {
  /**
   * ① 工具栏里的麦克风小图标。
   *
   * 职责（2026-10-30 用户改的形态）：**点击进入语音态**，不再是按住录音。
   * 按住录音交给 `bigmic`。
   */
  mic: 'nb-voice-mic',
  /**
   * ② 语音舞台（语音态才显示）。
   *
   * 进入语音态后，输入框与发送按钮**隐藏**，这块接管输入区：
   * 居中一个大圆按钮 + 一行提示 + 切回键盘。
   *
   * 为什么不整屏替换（像 QQ 那样铺满）：用户 2026-10-30 明确要求
   * 「整个范围不要像 QQ 那样不要整个界面只有语音按钮，这样就会很空」——
   * 消息列表要一直看得见，只换输入区那一块。
   */
  stage: 'nb-voice-stage',
  /**
   * ③ 语音态的**大圆按钮**，长按录音。
   *
   * 和 `mic` 分开是刻意的：`mic` 是"进入语音态的开关"（点一下），
   * `bigmic` 是"按住说话"（长按）。写成一个元素要它两副面孔，
   * 会让"点一下"和"按住"的判定互相污染。
   */
  bigmic: 'nb-voice-bigmic',
  /** ④ chips 浮层。三个模式 chip（说话/内心动作/消息），按住录音时浮起 */
  chips: 'nb-voice-chips',
  /** ⑤ 待确认条。「波形缩略 + 可编辑文本 + 发送/取消」 */
  confirm: 'nb-voice-confirm',
} as const;

/**
 * 造三个挂载点占位元素。
 *
 * 本期它们：
 *   · 麦克风位显示一个置灰的图标（未配置 ASR 的形态，T15.6 会切成可用）；
 *   · 两个浮层容器 `hidden`，没有任何子节点。
 *
 * `aria-hidden="true"` + `data-tcs-voice-mount` 让测试和后续接入都能稳定定位。
 */
export function renderVoiceMounts(doc: DocLike): {
  mic: ElLike;
  chips: ElLike;
  confirm: ElLike;
} {
  const mic = el(doc, 'div', 'nb-mic-slot');
  mic.setAttribute('id', VOICE_MOUNTS.mic);
  mic.setAttribute('data-tcs-voice-mount', 'mic');
  // 未配置 ASR 时置灰。T15.6 会替换成可按住的真按钮
  mic.setAttribute('aria-hidden', 'true');
  mic.textContent = '🎤';

  const chips = el(doc, 'div', 'nb-voice-chips-slot');
  chips.setAttribute('id', VOICE_MOUNTS.chips);
  chips.setAttribute('data-tcs-voice-mount', 'chips');
  chips.setAttribute('aria-hidden', 'true');
  chips.hidden = true;

  const confirm = el(doc, 'div', 'nb-voice-confirm-slot');
  confirm.setAttribute('id', VOICE_MOUNTS.confirm);
  confirm.setAttribute('data-tcs-voice-mount', 'confirm');
  confirm.setAttribute('aria-hidden', 'true');
  confirm.hidden = true;

  return { mic, chips, confirm };
}

/* ═══════════════════════════════════════════════════════════
   消息渲染
   ═══════════════════════════════════════════════════════════ */

export interface RenderMessageOptions {
  /** 角色名（宏替换用） */
  charName?: string;
  /** 用户名 */
  userName?: string;
  /** 这条消息是否是「正在生成中的最后一条」（显示呼吸点） */
  streaming?: boolean;
  /**
   * 这条消息在 `messages` 里的下标（2026-11-02 加点按操作后需要）。
   *
   * ★ 必须由**渲染层**写进 DOM 属性，不能让点击处理去 `indexOf` 找。
   * `messages` 里可能有内容完全相同的两条（重复说一句话很常见），
   * `indexOf` 会永远返回第一条 ⇒ 用户点了第二条、改的却是第一条。
   */
  index?: number;
}

/** 消息里那条语音气泡的静态波形柱数 */
const VOICE_BUBBLE_BARS = 7;

/**
 * 语音消息里的音频条（历史消息，不是草稿卡）。
 *
 * ```text
 * ┌────────────────────────┐
 * │ ▶  ▁▄▇▅▃▆▂   3"        │
 * └────────────────────────┘
 * ```
 *
 * ## 为什么不播放
 *
 * 消息模型里只有转写出来的文字，**没有音频数据**（ST 的聊天记录不存语音文件，
 * 我们也没有自己的音频存储）。所以这条音频条是**视觉标识**，不是播放器。
 *
 * 那为什么不干脆不做：用户要的就是"看得出这是语音消息"。
 * 纯文字 + 小徽标在快速滚动时等于没有标记（徽标只有 12px 高，在脚注行末尾）。
 *
 * 因此这里做了两件防误导的事：
 *   1. ▶ 是 `span` 不是 `button`，且整条不响应指针（不进 tab 序、没有 hover 态）——
 *      做成一按就"感觉能点"的样子，点了没反应比没有更糟；
 *   2. `aria-label` 明说"语音转写"，不暗示可播放。
 *
 * ## 为什么宽度固定、不按时长变化
 *
 * 草稿卡里那条是**随时长变宽**的（`shared/src/voice/bar-width.ts`）——
 * 因为它是"刚录完、马上要发"的东西，宽度变化是对用户动作的即时回应。
 *
 * 历史消息不一样：宽度随时长变会让消息列表右侧参差不齐，滚动时很乱，
 * 而时长本来就已经用文字（`3"`）写出来了，宽度再重复一遍没有新信息。
 *
 * @param durationMs 录音时长；`null` 表示这条消息没记录时长（历史数据），
 *   此时**不显示时长文案**而不是显示 `0"`。
 */
export function renderVoiceBubble(doc: DocLike, durationMs: number | null): ElLike {
  const bar = el(doc, 'div', 'nb-voice-bubble');
  bar.setAttribute('data-role', 'voice-bubble');
  /*
   * `role="img"` + `aria-label`：对读屏用户，这条音频条是一个整体符号
   * （"语音转写，3 秒"），不该被逐个子元素念出来（▶、7 根柱子、数字）。
   */
  bar.setAttribute('role', 'img');
  const seconds = durationMs === null ? null : Math.max(1, Math.round(durationMs / 1000));
  bar.setAttribute(
    'aria-label',
    seconds === null ? '语音转写' : `语音转写，${seconds} 秒`,
  );

  // 播放图标：纯装饰。用 span 不是 button（见函数注释第 1 条）
  const play = el(doc, 'span', 'nb-voice-bubble-play');
  play.setAttribute('aria-hidden', 'true');
  play.textContent = '▶';

  /*
   * 静态波形：**固定高度、不随机**。
   *
   * 历史消息里没有真实振幅数据。随机生成会让人以为那是这条语音的真实波形，
   * 而每次重绘还都不一样 —— 一条"会变的波形"比"固定图形"更误导。
   * 这组值刻意做得高低错落，像一个声波符号。
   */
  const wave = el(doc, 'span', 'nb-voice-bubble-wave');
  wave.setAttribute('aria-hidden', 'true');
  const shape = [0.35, 0.7, 1, 0.55, 0.85, 0.45, 0.65];
  for (let i = 0; i < VOICE_BUBBLE_BARS; i += 1) {
    const one = el(doc, 'span', 'nb-voice-bubble-bar');
    one.setAttribute('data-bar', String(i));
    one.setAttribute('style', `--nb-wave-level:${(shape[i] ?? 0.5).toFixed(2)}`);
    wave.append(one);
  }

  bar.append(play, wave);

  if (seconds !== null) {
    const dur = el(doc, 'span', 'nb-voice-bubble-dur');
    dur.setAttribute('aria-hidden', 'true');
    dur.textContent = `${seconds}"`;
    bar.append(dur);
  }

  return bar;
}

/** 时间戳 → `HH:MM`。坏值返回空串而不是 `Invalid Date` */function formatTime(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * 渲染一条消息。
 *
 * 结构（与 `chat.css` 的 `.nb-msg` 对齐）：
 *
 * ```text
 * .nb-msg.nb-msg--char|user
 *   └── div
 *         ├── .nb-voice-bubble  ← 仅语音消息：音频条（▶ 波形 时长）
 *         ├── .nb-bubble        ← innerHTML（已转义的 markdown）
 *         └── .nb-msg-meta      ← 时间 / 候选指示
 * ```
 */
export function renderMessage(
  doc: DocLike,
  message: StChatMessage,
  options: RenderMessageOptions = {},
): ElLike {
  const isUser = message.is_user === true;
  const wrap = el(doc, 'div', `nb-msg nb-msg--${isUser ? 'user' : 'char'}`);
  wrap.setAttribute('data-role', isUser ? 'user' : 'char');
  /*
   * 下标写进 DOM —— 点按操作（编辑/复制/删除）靠它定位是哪一条。
   *
   * 不用点击时 `messages.indexOf(…)`：内容相同的两条会永远命中第一条。
   */
  if (typeof options.index === 'number') {
    wrap.setAttribute('data-msg-index', String(options.index));
  }

  const column = el(doc, 'div');

  /*
   * ★ 语音消息：先画一条"语音气泡"，文字在它下面。
   *
   * 2026-10-31 用户明确：「语音气泡下是识别出来的文字」。
   * 所以语音消息不能只是"普通文字气泡 + 一个 🎤 小徽标"——
   * 那看起来和打字发的没区别，回看时得逐条找徽标才知道哪些是说的。
   */
  if (isVoiceMsg(message)) {
    column.append(renderVoiceBubble(doc, voiceDurationMs(message)));
  }

  // 气泡：唯一的 innerHTML 使用点（内容已由 renderMessageHtml 全量转义）
  const bubble = el(doc, 'div', 'nb-bubble');
  bubble.innerHTML = renderMessageHtml(message.mes ?? '', {
    charName: options.charName,
    userName: options.userName,
  });
  // 纯文本同时放进 title：长按/悬浮能看到原文，也方便测试断言
  bubble.setAttribute('data-plain', renderMessageText(message.mes ?? '', options).slice(0, 200));

  column.append(bubble);

  /*
   * 「正在生成」的呼吸点：追加在气泡**内部末尾**（设计册 §7.1「生成中：末尾一个 8px 圆点」）。
   *
   * 用 append 而不是改 innerHTML —— 改 innerHTML 会把渲染好的内容重新解析一遍，
   * 流式时每来一个字都重解析整段，长消息会明显卡。
   */
  if (options.streaming === true) {
    const dot = el(doc, 'span', 'nb-breathing');
    dot.setAttribute('aria-label', '正在生成');
    bubble.append(dot);
  }

  // ── 脚注 ──
  const meta = el(doc, 'div', 'nb-msg-meta');

  const time = formatTime(message.send_date);
  if (time !== '') {
    const timeEl = el(doc, 'span');
    timeEl.textContent = time;
    meta.append(timeEl);
  }

  // 语音条已经承载了"这条是语音"的全部信息，不再挂重复的 🎤 徽标 ——
  // 同一件事写两遍是缺陷温床（文案一改就分叉），而且视觉上冗余。
  // 语义放进了语音条的 `aria-label`，读屏用户不会丢信息。

  // 候选指示：只在有多个候选时显示（1/1 是噪音）
  const count = swipeCount(message);
  if (count > 1) {
    const indicator = el(doc, 'span', 'nb-swipe-indicator');
    indicator.setAttribute('data-role', 'swipe-indicator');
    indicator.textContent = `${currentSwipeIndex(message) + 1} / ${count}`;
    meta.append(indicator);
  }

  if (meta.children.length > 0) column.append(meta);
  wrap.append(column);
  return wrap;
}

/**
 * 渲染整条消息列表。
 *
 * `streamingIndex` 是"正在生成的那一条"的下标 —— 传它是为了让呼吸点只出现在
 * 那条消息上。用下标而不是布尔，是因为流式时那条消息在列表**末尾且长度在变**，
 * 光靠"最后一条"判断会在"用户刚发出新消息"时错位。
 */
/**
 * 把一批消息渲染成一个列表容器。
 *
 * ## `into` 参数的由来（2026-10-31，真机之前量出来的缺陷）
 *
 * 第一版这个函数**总是新建**一个 `div.nb-msglist`，而 `ChatPanel` 自己的滚动
 * 容器也叫 `.nb-msglist`，于是 DOM 里出现父子两层同名同 `data-role` 的容器，
 * 两层都吃 `.nb-msglist { flex:1; overflow-y:auto }`：
 *
 *   · 滚动被**内层**接管（内层 scrollHeight 978 > 自身 537）；
 *   · 而面板的 `pendingScroll` 滚的是**外层**（scrollHeight 625 == 自身 625，滚不动）；
 *   · 结果：滚到底部这件事从来没生效，最后一条气泡停在 top=882，
 *     视口只有 800 —— 新消息被输入区盖住 297px，用户看不到。
 *
 * 判据就在这两组数字上。如果只量外层（scrollHeight == height）会得出
 * "没有溢出、不用滚"的错觉 —— 这就是为什么修复前必须**两层都量**。
 *
 * 所以给出 `into`：调用方已经有滚动容器时把消息**渲染进它**，不要另造一层。
 * 不传 `into` 时行为与以前完全一致（`demo.html` 与单测依赖这一点）。
 */
export function renderMessageList(
  doc: DocLike,
  messages: readonly StChatMessage[],
  options: RenderMessageOptions & { streamingIndex?: number; into?: ElLike } = {},
): ElLike {
  const list = options.into ?? el(doc, 'div', 'nb-msglist');
  /*
   * 只在**自己新建**时打标记。用调用方的容器时既不能抢它的 `data-role`
   * （那会让"按 data-role 找列表"找到两个），也不能假设它叫 `.nb-msglist`。
   */
  if (options.into === undefined) {
    list.setAttribute('data-role', 'msglist');
  }

  messages.forEach((message, index) => {
    const isStreaming = options.streamingIndex === index;
    list.append(
      renderMessage(doc, message, { ...options, streaming: isStreaming, index }),
    );
  });

  return list;
}

/* ═══════════════════════════════════════════════════════════
   空状态（设计册 §7.3：一句人话 + 明确的下一步）
   ═══════════════════════════════════════════════════════════ */

export interface EmptyStateInput {
  halo: string;
  title: string;
  text: string;
  actions: Array<{ label: string; primary?: boolean; onClick?: () => void }>;
}

/**
 * 空状态。
 *
 * 设计册明确**不许**出现"暂无数据"—— 那是一个信息量为零的句子。
 * 每处空状态都要说清"这里本来该有什么"以及"下一步能做什么"。
 */
export function renderEmptyState(doc: DocLike, input: EmptyStateInput): ElLike {
  const box = el(doc, 'div', 'nb-empty');
  box.setAttribute('data-role', 'empty');

  const halo = el(doc, 'div', 'nb-empty-halo');
  halo.textContent = input.halo;
  // 装饰元素不该被读屏念出来
  halo.setAttribute('aria-hidden', 'true');

  const title = el(doc, 'h2', 'nb-empty-title');
  title.textContent = input.title;

  const text = el(doc, 'p', 'nb-empty-text');
  text.textContent = input.text;

  const actions = el(doc, 'div', 'nb-empty-actions');
  for (const action of input.actions) {
    const button = el(doc, 'button', `nb-btn${action.primary === true ? ' nb-btn--primary' : ''}`);
    button.setAttribute('type', 'button');
    button.textContent = action.label;
    if (action.onClick !== undefined) button.addEventListener('click', action.onClick);
    actions.append(button);
  }

  box.append(halo, title, text);
  if (input.actions.length > 0) box.append(actions);
  return box;
}
