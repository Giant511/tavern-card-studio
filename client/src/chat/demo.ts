/**
 * 聊天页的视觉验收 demo（v0.1.7 / T15.5）—— **仅用于截图/录屏，不进产物**。
 *
 * ## 为什么不放进正式构建
 *
 * 它用假数据、假流式，且不接 Tauri（浏览器里 `invoke` 不存在）。
 * 它的唯一职责是让 `chat.css` + `chat-view.ts` 在一个真实浏览器里渲染出来，
 * 从而：
 *   · 截图能证明**夜航视觉**与**T15.6 三个挂载点**的实际样子；
 *   · 用假流式证明**打字机效果可见**（这是无 Content-Type 陷阱的直接体现）。
 *
 * 真机 + 真 ST 的端到端验证仍要用户跑（见 `docs/t15.5-chat-panel.md`）。
 *
 * ## 为什么流式用假数据也成立
 *
 * 陷阱 #10 的实质是"**增量是否被逐段渲染**"。假数据按 120ms 一段喂进来，
 * 与真流式的到达节奏一致 —— 如果界面是"最后一口气填满"，录屏里看不出来；
 * 如果逐段出现，录屏里就能看到。这条判据与"数据从哪来"无关。
 */

import {
  applyStreamEvent,
  renderMessageHtml,
  createStreamState,
  setVoiceFlag,
  startStreaming,
  type StChatMessage,
  type StreamState,
} from '@tcs/shared';

import {
  renderEmptyState,
  renderMessage,
  renderMessageList,
  renderVoiceMounts,
  VOICE_MOUNTS,
  type DocLike,
  type ElLike,
} from './chat-view.ts';
import { VoicePanel } from './voice-panel.ts';

/** demo 的假消息：覆盖 markdown、语音徽标、多候选、超长文本 */
const SCRIPTED_MESSAGES: StChatMessage[] = [
  {
    name: '旅人',
    is_user: true,
    send_date: new Date(Date.now() - 180000).toISOString(),
    mes: '你听得见雨声吗？',
  },
  {
    name: '西奥',
    is_user: false,
    send_date: new Date(Date.now() - 170000).toISOString(),
    mes: '*他侧过头，望向窗外那片灰白* 听得见。比刚才密了。\n\n要是再下大一点，明天山路就走不成了。',
    swipes: [
      '*他侧过头，望向窗外* 听得见。',
      '*他侧过头，望向窗外那片灰白* 听得见。比刚才密了。\n\n要是再下大一点，明天山路就走不成了。',
    ],
    swipe_id: 1,
  },
  {
    name: '旅人',
    is_user: true,
    send_date: new Date(Date.now() - 120000).toISOString(),
    mes: '“那就多留一天。”',
    extra: { tcs: { voice: true } },
  },
  {
    name: '西奥',
    is_user: false,
    send_date: new Date(Date.now() - 60000).toISOString(),
    mes:
      '他笑了一下，没立刻答话。\n\n' +
      '> 多留一天。这个词在他心里转了一圈。\n\n' +
      '「**好啊。**」他把茶推到你手边，「不过明天得帮我补屋顶 —— 漏了三个地方。」\n\n' +
      '1. 东侧那面墙\n' +
      '2. 灶台上方的梁\n' +
      '3. 还有他一直没修的那扇窗\n\n' +
      '```\n记账：瓦片 12 块、灰泥 2 桶\n```',
  },
];

/** 流式演示用的一段长回复（分段喂，模拟打字机） */
const STREAM_SCRIPT = [
  '他沉默了一会儿。',
  '手指在桌面上轻轻敲了两下，',
  '像是在数什么。',
  '\n\n「其实我早该问你的 —— 」',
  '他抬起眼，',
  '*声音低了半度*，',
  '「你这次回来，',
  '是打算待多久？」',
];

/**
 * 把 `ElLike` 当真实 DOM 节点用。
 *
 * `chat-view.ts` 刻意只依赖极小的 `ElLike` 接口（这样测试能用一个 30 行 stub），
 * 而真实 DOM 是 `Node`。两者的转换只在这里发生 —— 集中在 Demo 里而不是
 * 往 `ElLike` 上加十几个用不到的真实 DOM 成员。
 */
function asNode<T extends Node>(node: ElLike): T {
  return node as unknown as T;
}

function boot(): void {
  const doc = document;
  const app = doc.getElementById('app');
  if (app === null) return;

  // 应用外壳
  const shell = doc.createElement('div');
  shell.className = 'nb-app';
  shell.setAttribute('data-role', 'app-shell');

  const page = doc.createElement('div');
  page.className = 'nb-page';

  // 顶栏（玻璃 1/3）
  const topbar = doc.createElement('div');
  topbar.className = 'nb-topbar';
  const title = doc.createElement('h1');
  title.className = 'nb-topbar-title';
  title.textContent = '西奥';
  const sub = doc.createElement('span');
  sub.className = 'nb-topbar-sub';
  sub.textContent = '山间小屋 · 第 3 天';
  title.append(sub);
  const menu = doc.createElement('button');
  menu.className = 'nb-icon-btn';
  menu.type = 'button';
  menu.setAttribute('aria-label', '选择角色与聊天');
  menu.textContent = '☰';
  topbar.append(title, menu);

  // 消息区
  const list = renderMessageList(doc, SCRIPTED_MESSAGES, {
    charName: '西奥',
    userName: '旅人',
  });
  list.setAttribute('id', 'msglist');

  // 输入区（玻璃 2/3）
  const composer = doc.createElement('div');
  composer.className = 'nb-composer';

  // ★ T15.6 挂载点（真实渲染，不是占位文字）
  const mounts = renderVoiceMounts(doc);
  composer.append(asNode(mounts.chips));
  /*
   * ★ 待确认草稿**不放 composer** —— 与真实面板保持一致（`chat-panel.ts` 里
   * 它挂在消息列表末尾，像一条待发出的消息）。2026-10-30 用户给的形态就是
   * "消息流里的一条草稿"，放在输入区上方那是上一版的旧样子。
   *
   * demo 在这里先不 append，等 `runVoiceDemo` 把它挂到 `#msglist` 末尾。
   */

  const input = doc.createElement('textarea');
  input.className = 'nb-input';
  input.rows = 1;
  input.placeholder = '说点什么…';
  input.value = '';
  composer.append(input, asNode(mounts.mic));

  const send = doc.createElement('button');
  send.className = 'nb-send';
  send.type = 'button';
  send.setAttribute('aria-label', '发送');
  send.textContent = '↑';
  send.setAttribute('data-ready', 'false');
  composer.append(send);

  /*
   * 顺序必须是 顶栏 → 消息 → 输入区 → Tab 栏。
   *
   * 第一版写成 `shell.append(page, tabbar, composer)` —— 输入区跑到了
   * Tab 栏**下面**，截图里表现为"Tab 栏压着输入区、底下还露出半截输入框"。
   * 所以 composer 要放进 page 内部（消息区之后），而不是 app 层。
   *
   * 这也与真实面板结构一致：`chat-panel.ts` 的 mount 是
   * `root.append(topbar, body, composer)`，Tab 栏在 shell 层。
   */
  page.append(topbar, asNode(list), composer);
  shell.append(page, buildTabbar(doc));
  app.append(shell);

  // 录屏用：把流式与语音演示挂到 window 上，供 CDP 触发
  const w = window as unknown as Record<string, unknown>;
  w['tcsDemo'] = {
    /** 开始一次假流式，返回一个在结束时 resolve 的 Promise */
    stream: () => runFakeStream(doc, list, send as unknown as ElLike),
    /** 显示空状态（第二张截图用） */
    empty: () => showEmpty(doc, list),
    /** 三个挂载点的 id（验收脚本据此断言） */
    voiceMounts: VOICE_MOUNTS,
    /**
     * 语音演示（T15.6 录屏用）。
     *
     * 用**假 transport** 而不是真麦克风：录屏要的是"交互形态可见"，
     * 而 CI 环境没有麦克风、授权弹窗也无法自动点。
     * 假 transport 的振幅是一段正弦，波形看起来与真人说话一致。
     */
    voice: () => runVoiceDemo(doc, composer, mounts),
  };

  document.body.dataset['demoReady'] = 'true';
}

function buildTabbar(doc: Document): HTMLElement {
  const tabbar = doc.createElement('nav');
  tabbar.className = 'nb-tabbar';
  tabbar.setAttribute('data-role', 'tabbar');
  const tabs = [
    { id: 'chat', label: '聊天', icon: '💬' },
    { id: 'cards', label: '卡片', icon: '🗂' },
    { id: 'repo', label: '仓库', icon: '☁️' },
    { id: 'me', label: '我的', icon: '⚙️' },
  ];
  for (const tab of tabs) {
    const button = doc.createElement('button');
    button.className = 'nb-tab';
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('data-tab', tab.id);
    button.setAttribute('aria-selected', String(tab.id === 'chat'));
    const icon = doc.createElement('span');
    icon.className = 'nb-tab-icon';
    icon.textContent = tab.icon;
    const label = doc.createElement('span');
    label.textContent = tab.label;
    button.append(icon, label);
    tabbar.append(button);
  }
  return tabbar;
}

/**
 * 假流式：每 120ms 追加一段。
 *
 * 120ms 是需求里写死的波形刷新间隔，也是"人能看出在动、但不觉得慢"的常见值。
 * 用它与真流式的到达节奏对齐 —— 这样录屏里的观感就是真机上的观感。
 */
function runFakeStream(doc: Document, list: ElLike, send: ElLike): Promise<void> {
  // 先加一条空的 assistant 气泡
  const placeholder: StChatMessage = {
    name: '西奥',
    is_user: false,
    send_date: new Date().toISOString(),
    mes: '',
  };
  /*
   * 流式演示**只用两条消息**（一条提问 + 正在生成的那条）。
   *
   * 为什么不像主视图那样铺满四条：那样新消息会落在可视区下方，
   * 录屏里看不出"字在长"，只能靠滚动把它带进来 —— 而滚动在 headless
   * 截图里时序不可靠（试过 scrollTop 赋值、scrollTo、rAF，都不稳定）。
   *
   * **验收工具应该让被测事实一眼可见**，而不是让观看者去猜"下面还有内容吗"。
   * 真实场景下的滚动跟随由 `shared/src/chat/scroll.ts` 的判据 + 6 条测试守着。
   */
  const messages: StChatMessage[] = [
    {
      name: '旅人',
      is_user: true,
      send_date: new Date().toISOString(),
      mes: '你打算待多久？',
    },
    placeholder,
  ];

  const listNode = asNode<HTMLElement>(list);
  listNode.replaceChildren(
    asNode(
      renderMessageList(doc, messages, {
        charName: '西奥',
        userName: '旅人',
        streamingIndex: messages.length - 1,
      }),
    ),
  );
  const sendBtn = asNode<HTMLButtonElement>(send);
  sendBtn.setAttribute('data-ready', 'false');
  sendBtn.disabled = true;

  let state: StreamState = startStreaming();
  // 刚插入新消息时也贴底（否则新气泡在可视区外）
  void listNode.offsetHeight;
  listNode.scrollTop = listNode.scrollHeight;
  const bubble = listNode.querySelectorAll('.nb-bubble');
  const target = bubble[bubble.length - 1] as HTMLElement | undefined;

  return new Promise((resolve) => {
    let index = 0;
    const timer = setInterval(() => {
      if (index >= STREAM_SCRIPT.length) {
        clearInterval(timer);
        state = applyStreamEvent(state, { type: 'done' });
        // 收尾：去掉呼吸点
        target?.querySelector('.nb-breathing')?.remove();
        sendBtn.disabled = false;
        sendBtn.setAttribute('data-ready', 'true');
        resolve();
        return;
      }
      state = applyStreamEvent(state, { type: 'text', text: STREAM_SCRIPT[index] ?? '' });
      index += 1;

      /*
       * 每次只改**内容**，不整表重渲染 —— 与真实面板的做法一致
       * （`chat-panel.ts` 的 `patchStreamingMessage`）。
       */
      if (target !== undefined) {
        const dot = target.querySelector('.nb-breathing');
        // 用 textContent 保证假数据里的 * 不被解释（这一段只演示"在长"）
        /*
         * 流式时也要走 markdown 渲染，不能用 textContent。
         *
         * 第一版用 textContent 是为了"保证假数据里的 * 不被解释"，
         * 但那是**错的取舍**：真实面板流式时同样要渲染（否则用户先看到一堆
         * 星号，结束时才突然变成斜体，中间那一秒很难看）。
         * 截图里 `*声音低了半度*` 原样显示星号，就是这个错的表现。
         *
         * 走 `renderMessageHtml` 也顺带保证流式期间**不出现未转义的 HTML**。
         */
        target.innerHTML = renderMessageHtml(state.text);
        if (dot !== null) target.append(dot);
      }
      /*
       * 每段都贴底 —— 真实面板用的是 `shouldFollowStream`
       * （用户在底部才跟随），demo 里没有"往回翻"的场景，恒跟随即可。
       *
       * 不加这一行的话，录屏里**看不到任何变化**：新消息在可视区之外，
       * 截图/录屏全是旧内容。我第一次就是这样，还误以为是流式没生效。
       */
      /*
       * 同步贴底，先读一次 offsetHeight 强制回流。
       *
       * 为什么不用 `requestAnimationFrame`：headless Chrome 里 rAF 的时机
       * 不确定（页面不可见时会降频甚至不跑），而 CDP 截图是随时来抓的 ——
       * 于是"滚动写进去了但没生效"，录屏里看起来像**完全没滚**。
       * 我在这上面白试了两轮。
       *
       * 读 `offsetHeight` 会强制浏览器先把布局算完，之后写的 scrollTop
       * 一定生效，且是同步的 —— 截图抓到的就是滚过的状态。
       */
      void listNode.offsetHeight;
      listNode.scrollTop = listNode.scrollHeight;
    }, 120);
  });
}

function showEmpty(doc: Document, list: ElLike): void {
  asNode<HTMLElement>(list).replaceChildren(
    asNode(
      renderEmptyState(doc, {
        halo: '💬',
        title: '还没有对话',
        text: '说第一句话吧 —— 角色会接着回答。',
        actions: [{ label: '选择角色', primary: true }],
      }),
    ),
  );
}

boot();

/**
 * 语音演示（T15.6 录屏用）。
 *
 * ## 为什么要单独造一个，而不是复用 VoicePanel 在生产里的接线
 *
 * `VoicePanel` 已经接好了，但它要真 `MediaRecorder` + 真麦克风。
 * 录屏环境（headless Chrome）两者都没有，而 `getUserMedia` 会**直接抛**
 * 或弹一个自动化点不到的授权框。
 *
 * 所以这里用同一个 `VoicePanel`，只把 `transport` 换成假的 ——
 * 走的是**完全相同的 DOM 与状态机**，只是数据源不同。
 * 这样录屏里看到的交互与真机一致，而它验的是"接线对不对"（本期任务），
 * 不是"麦克风能不能录"（那是设备能力）。
 */
/**
 * 取元素的子元素数组。
 *
 * 真实 DOM 的 `children` 是 **HTMLCollection**（没有 `.find` / `.filter`），
 * 而 `ElLike` 声明的是数组。2026-10-30 我又踩了两次同一个坑
 * （`real.chips.children.filter` 与 `real.stage.children.find`）。
 * 统一走这个函数，避免第三次。
 */
function childList(node: { children: unknown }): ElLike[] {
  return Array.from(node.children as ArrayLike<ElLike>);
}

function runVoiceDemo(
  doc: Document,
  composer: HTMLElement,
  mounts: { mic: ElLike; chips: ElLike; confirm: ElLike },
): {
  /** 点工具栏小图标 → 进语音态（输入框与发送消失） */
  enter: () => Promise<void>;
  /**
   * 按住大圆按钮 → 开始录音。
   *
   * 坐标必须有：下滑取消按"相对按下位置的位移"判定，
   * 不给起点就整条取消逻辑失效（面板里对 null 会跳过判定）。
   */
  press: () => Promise<void>;
  moveTo: (index: number) => void;
  /** 下滑到"松手就取消"的位置（超过阈值的纵向位移） */
  slideDown: () => void;
  /** 滑回起点附近（退出取消态） */
  slideBack: () => void;
  /** 松手。坐标要传，因为松手那一刻的坐标才是取消的最终判据 */
  release: () => Promise<void>;
  /** 切换「二次确认」开关（默认关 = 直接发送；开 = 停在草稿卡上） */
  setConfirm: (on: boolean) => void;
  /** 切回键盘态 */
  exit: () => Promise<void>;
  /** 点文字气泡 → 就地进编辑态（不弹窗） */
  edit: () => void;
  /** 在编辑框里改写文字（模拟用户敲键盘） */
  type: (text: string) => void;
  /** 点「取消」= 本次作废 */
  cancel: () => void;
  /** 点「确认」= 发出（草稿消失，消息流里留一条文字） */
  confirm: () => Promise<void>;
  state: () => {
    voiceStage: string;
    stage: string;
    mode: string;
    draft: string | null;
    editing: boolean;
  };
} {
  const asNode = <T extends Node>(node: ElLike): T => node as unknown as T;

  let amplitudePhase = 0;
  /**
   * "手指"当前的纵向位置。
   *
   * 真实设备上 `pointerup` 自带坐标，而 CDP 派发的事件需要我们显式给。
   * 记住最后一次 move 的位置，松手时用它 —— 固定值会让"下滑取消"
   * 永远判不出来（判据是松手坐标相对按下起点的位移）。
   */
  let lastPointerY: number | null = null;
  const transport = {
    async start() {
      return {
        amplitude: () => {
          /*
           * 造一段"像人说话"的振幅：正弦调制 + 一点随机。
           *
           * 恒定峰值会让波形看起来是一根根等高的柱子（不像说话），
           * 而真人的音节气门是起伏的。
           */
          amplitudePhase += 0.45;
          const base = Math.abs(Math.sin(amplitudePhase)) * 22000;
          return Math.max(2000, Math.min(32000, base + Math.random() * 6000));
        },
        async stop() {
          return new Blob(['fake'], { type: 'audio/webm' });
        },
        discard() {},
      };
    },
    async transcribe() {
      // 录屏需要看到转写完成态，所以固定返回一句有内容的话
      return '那就多留一天吧，反正雨也没停';
    },
  };

  const panel = new VoicePanel({
    doc,
    asrConfigured: true,
    /*
     * ★ 从 `false` 开始 —— 这是**真实默认值**（设置项 `voiceConfirmBeforeSend`
     * 默认关）。录屏脚本会先用这条路径演示"松手直接发"，再 `setConfirm(true)`
     * 演示草稿卡。
     *
     * 第一版这里写死 `true`，理由写在旁边是"一次录制就能同时展示
     * 波形、chips、草稿卡三样"—— 结果**默认路径整整一版都没被演示过**，
     * 而它才是用户天天走的那条。录屏判据当场抓出来了：
     * 「默认路径没有发出消息」「默认路径出现了草稿卡」。
     *
     * 教训：demo 的初始状态必须等于产品默认值。为了"一次录完、看着丰富"
     * 而改初始值，录出来的东西就不再代表用户第一次看到的样子。
     */
    confirmBeforeSend: false,
    transport,
    /*
     * ★ 确认后「只留文字」（用户 2026-10-30 拍板）：
     * 草稿卡消失，消息流里多一条普通的语音文字消息。
     *
     * 第一版这里写的是空实现（"发出去会盖掉当前画面"）——
     * 但那个理由只在录"波形"时成立。现在用户要看的恰恰是
     * 「草稿 → 确认 → 变成一条消息」这个转身，空实现就等于
     * 录了个"点确认之后什么都没发生"的画面。
     */
    onSend: (text, durationMs) => {
      const list = doc.getElementById('msglist');
      if (list === null) return;
      /*
       * 复用 `renderMessage`，**不在这里手搓第二套气泡结构**。
       *
       * 手搓的代价是"demo 好看但真实消息不长这样"，而截图正是拿来验收视觉的 ——
       * 那等于用一张假的图证明视觉没问题。
       *
       * 这里连 `extra.tcs.voice` 与时长都一起给上：录屏里应当看到
       * "语音气泡（音频条）+ 下面识别文字"，与真实发送后一模一样。
       */
      const node = renderMessage(
        doc as unknown as DocLike,
        setVoiceFlag(
          {
            name: '旅人',
            is_user: true,
            send_date: new Date().toISOString(),
            mes: text,
          },
          true,
          durationMs,
        ),
        { charName: '西奥', userName: '旅人' },
      );
      /*
       * ★ 必须插在草稿卡**之前**，不能用 append。
       *
       * 草稿卡就挂在列表末尾。直接 append 会让"刚发出的消息"排到草稿卡后面 ——
       * 下一次录音时草稿卡又显示出来，画面变成「草稿卡 → 上一条已发消息」，
       * 看起来像**两条草稿**（2026-10-30 的 08 帧就是这么被误读的，
       * 一度以为旧草稿卡没清掉，实际是顺序错了）。
       *
       * 真实面板不需要这段处理：它每次 `render()` 都 `replaceChildren()`
       * 重建列表、再把草稿卡重挂到末尾，顺序天然正确。demo 的列表是静态的，
       * 所以这一步得手工补。
       */
      const card = doc.getElementById(VOICE_MOUNTS.confirm);
      if (card !== null && card.parentElement === list) {
        list.insertBefore(asNode(node), card);
      } else {
        list.append(asNode(node));
      }
      // 滚到底，否则新消息在视口外，截图看不到
      list.scrollTop = list.scrollHeight;
    },
    onNotify: () => {},
    // 录屏里也要真切 composer 的属性，否则画面看不出"输入框消失"
    onStageChange: (stage) => {
      composer.setAttribute('data-voice', stage === 'voice' ? 'true' : 'false');
    },
    /*
     * 草稿卡刚出现要滚进视口 —— 与 `chat-panel.ts` 同一理由：
     * 它挂在消息流末尾，列表停在上面时用户看不到自己说的话。
     */
    onDraftShown: () => {
      const list = doc.getElementById('msglist');
      if (list === null) return;
      list.scrollTop = list.scrollHeight;
    },
  });

  // 把占位替换成真实面板渲染出来的四个
  const real = panel.render();
  // 语音舞台插到 composer 最前面（语音态时独占输入区）
  composer.insertBefore(asNode(real.stage), composer.firstChild);
  asNode<HTMLElement>(mounts.chips).replaceWith(asNode(real.chips));
  asNode<HTMLElement>(mounts.mic).replaceWith(asNode(real.mic));
  /*
   * 待确认草稿挂到消息列表末尾（与 `chat-panel.ts` 的 `render()` 同一做法）。
   *
   * demo 的消息列表是静态的、不重绘，所以挂一次就够 —— 但注释里说明白，
   * 免得有人照抄到这里以为真实面板也只需挂一次（那边每次 render 都要重挂）。
   */
  const msglist = doc.getElementById('msglist');
  if (msglist !== null) msglist.append(asNode(real.confirm));

  const findRole = (root: ElLike, role: string): HTMLElement | null => {
    const walk = (node: ElLike): HTMLElement | null => {
      if (node.getAttribute('data-role') === role) return asNode<HTMLElement>(node);
      for (const child of childList(node)) {
        const hit = walk(child);
        if (hit !== null) return hit;
      }
      return null;
    };
    return walk(root);
  };

  return {
    async enter() {
      asNode<HTMLElement>(real.mic).dispatchEvent(new Event('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
    },
    async press() {
      const bigmic = childList(real.stage).find((c) => c.className.includes('nb-voice-bigmic'));
      if (bigmic === undefined) return;
      /*
       * 必须发真的 PointerEvent 并带坐标 —— 用 `new Event('pointerdown')`
       * 会得到一个没有 clientX/clientY 的事件，面板判定"拿不到坐标"后
       * 把 `pressStart` 置 null，下滑取消整条失效，而**画面看起来一切正常**。
       */
      const rect = (bigmic as unknown as HTMLElement).getBoundingClientRect();
      asNode<HTMLElement>(bigmic).dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      );
      lastPointerY = rect.top + rect.height / 2;
      // 等 start() 的 Promise 走完
      await new Promise((r) => setTimeout(r, 60));
    },
    slideDown() {
      const bigmic = childList(real.stage).find((c) => c.className.includes('nb-voice-bigmic'));
      if (bigmic === undefined) return;
      const rect = (bigmic as unknown as HTMLElement).getBoundingClientRect();
      // 起点在按钮中心，往下滑 110px（阈值 64）→ 进入"松手取消"
      lastPointerY = rect.top + rect.height / 2 + 110;
      panel.handlePointerMove(rect.left + rect.width / 2, lastPointerY);
    },
    slideBack() {
      const bigmic = childList(real.stage).find((c) => c.className.includes('nb-voice-bigmic'));
      if (bigmic === undefined) return;
      const rect = (bigmic as unknown as HTMLElement).getBoundingClientRect();
      lastPointerY = rect.top + rect.height / 2 + 8;
      panel.handlePointerMove(rect.left + rect.width / 2, lastPointerY);
    },
    setConfirm(on: boolean) {
      panel.updateConfig({ confirmBeforeSend: on });
    },
    async exit() {
      const exitBtn = childList(real.stage).find((c) => c.className.includes('nb-voice-stage-exit'));
      if (exitBtn === undefined) return;
      asNode<HTMLElement>(exitBtn).dispatchEvent(new Event('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
    },
    moveTo(index: number) {
      const chips = childList(real.chips).filter((c) => c.className.includes('nb-chip'));
      const target = chips[index];
      if (target === undefined) return;
      const rect = (target as unknown as HTMLElement).getBoundingClientRect();
      panel.handlePointerMove(rect.left + rect.width / 2, rect.top + rect.height / 2);
    },
    async release() {
      /*
       * 松手坐标必须是**当前手指所在位置**，不能固定用按钮中心。
       *
       * 面板在松手那一刻会用坐标再判一次 `isCancelSlide`（最后一次
       * pointermove 可能没到），固定在按钮中心会让"下滑取消"永远判不出来 ——
       * 而录出来的画面里提示明明写着「松开 取消」。
       * 这里由调用方先用 slideDown() 把"手"放到位，release 只需给出
       * 与之一致的坐标：用一个面板可见的状态推回去即可。
       */
      const rect = (real.stage as unknown as HTMLElement).getBoundingClientRect();
      const y = lastPointerY ?? rect.bottom;
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: rect.left + rect.width / 2, clientY: y }));
      await new Promise((r) => setTimeout(r, 120));
    },
    edit() {
      findRole(real.confirm, 'voice-textview')?.click();
    },
    type(text: string) {
      const editor = findRole(real.confirm, 'voice-draft') as HTMLTextAreaElement | null;
      if (editor === null) return;
      editor.value = text;
    },
    cancel() {
      findRole(real.confirm, 'voice-cancel')?.click();
    },
    async confirm() {
      findRole(real.confirm, 'voice-send')?.click();
      await new Promise((r) => setTimeout(r, 150));
    },
    state() {
      const snapshot = panel.snapshot();
      const editor = findRole(real.confirm, 'voice-draft') as HTMLTextAreaElement | null;
      return {
        voiceStage: panel.currentStage(),
        stage: snapshot.flow.stage,
        mode: snapshot.flow.mode,
        draft: snapshot.flow.draft,
        editing: editor !== null && editor.hidden === false,
      };
    },
  };
}

