/**
 * 语音输入面板（v0.1.7 / T15.6）—— 三个挂载点的真实实现。
 *
 * ## 这个文件只做一件事：把纯逻辑接到 DOM 上
 *
 * 状态机在 `shared/src/voice/confirm.ts`（四阶段、12 条测试全绿），
 * 波形映射在 `waveform.ts`，包裹在 `wrap.ts`，命中测试在 `gesture.ts`。
 * 这里**一个业务判断都不重写** —— 重写就等于把已经测过的东西变成两份。
 *
 * ## 三个挂载点的 id 从 `VOICE_MOUNTS` 取，不自造
 *
 * `chat-view.ts` 的 `VOICE_MOUNTS` 是单一真相（T15.5 就定下了）。
 * 本期把那里的「占位实现」换成真实功能，但 **id 与类名一个都不改** ——
 * 改了就破坏了 T15.5 交付时承诺给 T15.6 的接口。
 *
 * ## 三个挂载点的分工（按需求 1）
 *
 * | 挂载点 | 本期做什么 |
 * |---|---|
 * | `nb-voice-mic` | `.nb-mic-slot` 从 div 换成可按住的 button，48×48 不动 |
 * | `nb-voice-chips` | `hidden` → `flex`；三个 `.nb-chip`；按住时浮起、平时显示当前模式 |
 * | `nb-voice-confirm` | `hidden` → `false`；内部 `[波形缩略][可编辑文本][发送][取消]` |
 *
 * ## 交互链路（需求 2）
 *
 * ```text
 * pointerdown → 起录音 + 浮起 chips + 开始波形
 * pointermove → 命中测试 → 改模式高亮（滑动切"内心/消息"）
 * pointerup   → 停波形 + 停录音 → 转写 → wrap → 直发 或 停留待确认
 * ```
 *
 * 录音与转写通过 `VoiceTransport` 注入，**不在这个文件里碰真实麦克风** ——
 * 那样才能在没有麦克风的 CI / Node 里测完整交互。
 */

import {
  applyTranscript,
  beginRecording,
  beginTranscribing,
  cancelDraft,
  commitDraft,
  coerceVoiceMode,
  createVoiceFlow,
  createWaveform,
  DEFAULT_VOICE_MODE,
  DEFAULT_BAR_COUNT,
  editDraft,
  freezeWaveform,
  hasVoiceActivity,
  barHeights,
  cancelRecording,
  formatRecordClock,
  hitTestVoiceChip,
  highlightByHorizontalSlide,
  isCancelSlide,
  modeByHorizontalSlide,
  pushAmplitude,
  setFlowMode,
  VOICE_MODE_LABEL,
  renderMessageHtml,
  voiceBarWidth,
  voiceDurationLabel,
  WAVEFORM_REFRESH_MS,
  type VoiceFlow,
  type VoiceMode,
  type WaveformState,
} from '@tcs/shared';

/**
 * 录音看门狗上限（毫秒）。
 *
 * 正常说话不会超过 60 秒；超过说明触摸序列卡住了（手指卡屏、来电浮层
 * 盖住、系统手势抢走事件、WebView 丢帧）。那种情况下"继续占着麦克风"
 * 会让**其他应用录不到音**，比"强制停掉这次录音"严重得多。
 */
const MIC_WATCHDOG_MS = 60_000;

/**
 * 录音期间检查"页面是否还在前台"的间隔（毫秒）。
 *
 * ## 为什么需要它：`visibilitychange` 已被实测漏发过一次
 *
 * 2026-11-02 00:32 的真机取证（新装 APK 冷启动后首次录音）：
 *
 * ```
 * 按住大圆 → HOME → 2 秒后采样整机：
 *   RecordActivityMonitor → riid 1967; active? true           ← 还在录
 * 读 JS 侧挂钩时间线：
 *   document.hidden === true                                  ← 页面确实在后台
 *   心跳 __tcsHb 仍在更新                                      ← JS 没被冻结
 *   trace = [gum-called, gum-resolved]                        ← 没有 visibilitychange
 * ```
 *
 * 三个条件同时成立 ⇒ **事件没来，但 JS 活着**。既然它至少会漏一次，
 * 就不能把它当唯一通知源。
 *
 * ## 为什么是轮询而不是"再加一个事件"
 *
 * 已试过的三条通知源（`visibilitychange` / `pagehide` / `pointercancel`）
 * 都是"同一类"机制：由系统在特定时机派发。其中一个漏发，就说明这一类
 * **不能假设必到**。轮询是另一种机制：不依赖任何派发，自己去看状态。
 *
 * ## 代价
 *
 * 只在**录音期间**才挂着（`armWatchdog` 里启动、`clearWatchdog` 里清掉），
 * 空闲时零开销。1 秒一次对手机没有可感知影响。
 *
 * ## 已知边界（不夸大这个兜底）
 *
 * 后台页面的定时器会被节流：Chrome/WebView 对隐藏页面最小间隔 1 秒，
 * 长时间后台可能放宽到 60 秒。所以它**不是"1 秒内必释放"的保证**，
 * 而是"即使事件全漏了，也不会一直占着直到用户杀进程"。
 * 真正的即时保证要靠原生生命周期（本轮未做，见 memory §71.11）。
 */
const MIC_FOREGROUND_POLL_MS = 1_000;

import { el, VOICE_MOUNTS, type DocLike, type ElLike } from './chat-view.ts';
import { playSendSound, warmupSendSound } from './send-sound.ts';

/* ═══════════════════════════════════════════════════════════
   注入点：录音与转写
   ═══════════════════════════════════════════════════════════ */

/**
 * 一次录音的句柄。
 *
 * `amplitude()` 返回**原始振幅**（0..32767 量级）而不是归一化值 ——
 * 归一化在 `waveform.amplitudeToLevel` 里做，是纯函数、有测试。
 * 两边都归一化就会出现"到底谁负责"的问题，缩放两次。
 */
export interface ActiveRecording {
  /** 读当前振幅。返回 0 表示静音 */
  amplitude: () => number;
  /** 停止并拿到音频数据 */
  stop: () => Promise<Blob>;
  /** 放弃（用户划走/出错），不产生音频 */
  discard: () => void;
}

/**
 * 录音 + 转写的能力。
 *
 * 真实现见 `recorder.ts`；测试里注入假的，就能在 Node 里跑完整交互链路。
 */
export interface VoiceTransport {
  /** 请求麦克风并开始录音。失败要抛错（调用方会提示用户） */
  start: () => Promise<ActiveRecording>;
  /** 把音频转成文字。失败要抛错（调用方按 `classifyAsrFailure` 分流文案） */
  transcribe: (audio: Blob, mode: VoiceMode) => Promise<string>;
}

export interface VoicePanelOptions {
  doc: DocLike;
  /** ASR 是否已配置。false 时麦克风保持置灰，点击跳配置页 */
  asrConfigured: boolean;
  /** 「发送前需确认」。来自配置 `voiceConfirmBeforeSend`，默认 false */
  confirmBeforeSend: boolean;
  /** 初始模式（本次会话上次用的；冷启动用默认） */
  initialMode?: VoiceMode;
  /**
   * 发送一条语音消息。
   *
   * 调用方负责把 `extra.tcs.voice = true` 落到消息上 ——
   * 那是消息层的职责（`setVoiceFlag`），不是这个面板的。
   *
   * @param durationMs 本次录音时长（毫秒）。消息里那条音频条要显示它。
   *   为什么由面板传而不是让消息层自己算：只有面板知道"按下到松手"的真实
   *   时长（`recordStartedAt`），消息层拿到的是一个 Blob，看不出录了多久。
   */
  onSend: (text: string, durationMs: number) => void | Promise<void>;
  /** 未配置 ASR 时点麦克风：跳配置页 */
  onNeedAsrConfig?: () => void;
  onNotify?: (message: string, kind?: 'info' | 'ok' | 'warn' | 'danger') => void;
  /**
   * 麦克风被释放时通知外层（2026-11-01 发布阻断级）。
   *
   * ## 为什么要这个回调
   *
   * 退后台 / 看门狗 / dispose 都会释放录音，但那几个时刻用户可能看不到界面。
   * 留给验收脚本与 QA 一个可观测点：`onReleaseMic('visibility')` 就证明
   * "这条路真的走到了释放"，而不是"看起来没占着"。
   *
   * 生产环境**不弹提示**（用户切走了，弹了也看不到）。
   */
  onReleaseMic?: (reason: string) => void;
  /**
   * 输入区形态变了（keyboard ⇄ voice）。
   *
   * 由外壳据此切 `composer[data-voice]` —— 输入框与发送按钮的显隐由 CSS 管，
   * 这里只广播状态，不直接去改别人的 DOM（那是外壳的地盘）。
   */
  onStageChange?: (stage: VoiceStage) => void;
  /**
   * 草稿卡刚出现（从非 confirming 进入 confirming）。
   *
   * 为什么必须有这个回调：草稿卡挂在**消息流末尾**，而它出现的那一刻
   * 消息流已经滚到上面去了 —— 用户松手后看到的是"什么都没有变"，
   * 他说的那句话其实在视口外一条消息的位置。2026-10-30 录屏就是这样：
   * 草稿卡的 DOM 完全正常（尺寸、文字、宽度全对），但截图里一个像素都看不到。
   *
   * 这类"元素存在但不在视口内"的缺陷，**所有 DOM 断言都不会红** ——
   * 只有看图才发现。所以外壳必须有机会把它滚进来。
   */
  onDraftShown?: () => void;
  /** 录音/转写能力。不给 = 麦克风恒置灰（demo 与测试用） */
  transport?: VoiceTransport;
  /** 定时器注入（测试用，免得真等 120ms） */
  setInterval?: (fn: () => void, ms: number) => number;
  clearInterval?: (id: number) => void;
}

export interface VoiceMounts {
  /** 工具栏小图标：点击进入语音态 */
  mic: ElLike;
  /** 语音舞台：语音态才显示（含大圆按钮 + 提示 + 切回键盘） */
  stage: ElLike;
  chips: ElLike;
  confirm: ElLike;
}

/**
 * 输入区的两种形态。
 *
 * 这是**与录音状态正交**的一层：`keyboard` 是可以打字的常态，
 * `voice` 是"输入框和发送按钮消失、只留大圆按钮"的语音态。
 *
 * 为什么要分两层：录音（`flow.stage = recording`）只发生在语音态里，
 * 而进入语音态**不需要**开始录音。混成一层会出现"点一下麦克风就开始录音"
 * 这种用户完全没预期的行为。
 */
export type VoiceStage = 'keyboard' | 'voice';

/* ═══════════════════════════════════════════════════════════
   面板
   ═══════════════════════════════════════════════════════════ */

export class VoicePanel {
  private readonly options: VoicePanelOptions;
  private readonly doc: DocLike;

  private flow: VoiceFlow;
  private wave: WaveformState = createWaveform(DEFAULT_BAR_COUNT);

  private micEl: ElLike | null = null;
  /** 语音态的大圆按钮（长按录音） */
  private bigmicEl: ElLike | null = null;
  /** 语音舞台根元素（自己造的那个，用它承载 data-voice） */
  private stageRoot: ElLike | null = null;
  private chipsEl: ElLike | null = null;
  /** 舞台顶部那行提示（录音中会变成「松手取消」） */
  private hintEl: ElLike | null = null;
  /** 顶部「波形 + 计时」那一行（2026-11-02 用户给的布局） */
  private waveRowEl: ElLike | null = null;
  /** 录音计时 `0:01`（图片里正中那个） */
  private clockEl: ElLike | null = null;
  /** 当前输入区形态。默认 keyboard */
  private voiceStage: VoiceStage = 'keyboard';
  /** 待确认文字是否处于编辑态（决定 blur 要不要落值） */
  private editingDraft = false;
  /** 上一轮 syncAll 时是不是 confirming（用于识别"刚出现"这个跃迁） */
  private wasConfirming = false;
  /** 最近一次录音时长（毫秒），给音频条算宽度用 */
  private lastDurationMs = 0;
  /** 本次录音开始时刻（`Date.now()`），松手时算时长 */
  private recordStartedAt = 0;
  /** 按下时的屏幕坐标。上滑取消要拿它当基准（相对位移，不是相邻方向） */
  private pressStart: { x: number; y: number } | null = null;
  /**
   * 当前是不是"松手就会取消"的状态。
   *
   * 为什么要有这个标志、而不是在松手时现算：录音中要**实时**告诉用户
   * "现在松手就取消"，否则他不知道自己滑够了没有 —— 全靠松手后才发现
   * 白说了，那和没有这个功能一样。
   */
  private cancelling = false;
  private confirmEl: ElLike | null = null;
  private draftEl: ElLike | null = null;
  /**
   * 只读文字气泡。
   *
   * 为什么要单独留引用、而不是从 `draftEl.parentElement` 往上找：那依赖
   * "两个元素同父"这个隐含前提，父容器一改（这次就从输入区挪到了消息流）
   * 就整条链断掉 —— 而断掉的表现是**文字气泡空白**，DOM 里没报错。
   * 直接存引用，挪到哪儿都不断。
   */
  private textViewEl: ElLike | null = null;
  private waveThumbEl: ElLike | null = null;
  private chipEls = new Map<VoiceMode, ElLike>();

  private recording: ActiveRecording | null = null;
  private timer: number | null = null;
  /** 滑动时最后命中的模式 —— 松手前一直更新 */
  private pendingMode: VoiceMode;
  /** 已经 dispose 过（避免重复清理 / 清理后又被回调用到） */
  private disposed = false;

  /**
   * window 上那三个监听的绑定现场（2026-11-02 修泄漏）。
   *
   * ## 为什么必须存引用
   *
   * `removeEventListener` 要求**同一个函数引用**。原来这里是匿名箭头函数
   * 直接传进去，等于放弃了"能解绑"的能力 —— 于是：
   *
   * 1. `render()` 每次调用都跑一遍 `bindWindowPointers()`（注释写着"只绑一次"，
   *    但**代码里没有任何"已绑过就跳过"的判断**）；
   * 2. `dispose()` 只 `releaseRecording()`，**没解绑**；
   * 3. ⇒ 每切一次 Tab 就多留一套监听。旧面板早已从 DOM 摘掉，
   *    但它仍然在听 `pointerdown` 并自己调 `transport.start()`。
   *
   * ## 真机证据（2026-11-02 09:04）
   *
   * 松手 218ms 后页面已回 idle（`onPointerUp` 跑完了），但设备侧仍有
   * **两个** active 录音：
   * ```text
   * riid 2615; active? true  ... pack:com.taverncardstudio.client
   * riid 2623; active? true  ... pack:com.taverncardstudio.client
   * ```
   * 一个属于当前面板（已被释放），另一个是**旧面板开的、没人释放**。
   * 这正是用户报的"麦克风被占着"的更根本原因 —— 比"某个出口忘写 stop"更隐蔽，
   * 因为每个面板自己的出口都写对了。
   */
  private pointerBindTarget: {
    removeEventListener?: (type: string, handler: (event: unknown) => void) => void;
  } | null = null;
  private onPointerUpBound: ((event: unknown) => void) | null = null;
  private onPointerCancelBound: ((event: unknown) => void) | null = null;
  private onPointerMoveBound: ((event: unknown) => void) | null = null;

  /**
   * 发起这次按压的手指（`PointerEvent.pointerId`）；`null` = 当前没有按压。
   *
   * ## ★★★ 为什么必须记它（2026-11-02 用户报"要两个手指才能完成"）
   *
   * 之前三个 handler 都**不看 `pointerId`**，于是任何一根手指的移动都会
   * 被当成"正在按的那根在滑"。后果分两层：
   *
   * 1. **单指滑动被浏览器掐断**（`touch-action` 缺 `none`）⇒ 收不到 move
   *    ⇒ 用户滑不动，只能改用第二根手指
   * 2. 第二根手指轻点目标圆时，只要它有一点移动，`onMove` 就拿它的坐标
   *    去算"从大圆滑到哪" —— 于是**两根手指居然能成功**
   *
   * 这两条叠加，就出现了用户看到的现象：一个手指做不到，两个手指可以。
   *
   * 修法是两层一起：
   *   · CSS 加 `touch-action: none` 让单指滑动不被浏览器抢走
   *   · 这里按 `pointerId` 过滤，让第二根手指**完全不参与**
   */
  private activePointerId: number | null = null;
  /**
   * 录音看门狗定时器。
   *
   * ## 为什么需要它
   *
   * 麦克风只在"按住期间"该开着，但**触摸序列可能永远不结束**：
   * 手指卡在屏幕上 + 来电浮层盖住、系统手势抢走事件、WebView 丢帧……
   * 那几条路上 `pointerup` 与 `pointercancel` 都可能不来。
   *
   * 兜底上限 60 秒：正常说话不会超过它（用户自己会松手），
   * 而一旦超过就说明状态机卡住了，强制释放比继续占着麦克风好。
   */
  private watchdog: number | null = null;

  constructor(options: VoicePanelOptions) {
    this.options = options;
    this.doc = options.doc;
    this.pendingMode = coerceVoiceMode(options.initialMode ?? DEFAULT_VOICE_MODE);
    this.flow = createVoiceFlow(this.pendingMode);
    this.bindVisibilityRelease();
  }

  /**
   * 退到后台时**立刻释放麦克风**（2026-11-01 发布阻断级修复）。
   *
   * ## 为什么这条是主泄漏点
   *
   * 真机取证（`.verify/mic-leak-evidence.md`）：
   *
   * ```text
   * getUserMedia → track.readyState = "live"
   * 按 Home 切后台，等 5 秒
   * 再查 → readyState 仍是 "live"，live: 1
   * ```
   *
   * **WebView 不会因为切后台而释放麦克风。** 而我们的代码在切后台时
   * 什么都不做，于是：
   *
   * ```text
   * 用户按住大圆按钮（pointerdown → recording 建立）
   *   → 来电 / 按 Home / 系统手势打断
   *   → 触摸序列被中断，pointerup 与 pointercancel 都可能不来
   *   → recording 保持非空，track 一直 live
   *   → 麦克风被独占 ⇒ 其他应用录不到音
   *   → 杀掉本 App ⇒ 进程死、系统回收音频设备 ⇒ 立即恢复
   * ```
   *
   * 这三条症状（他方录不到 / 重授权限无效 / 杀进程即愈）正是用户报的。
   *
   * ## 为什么同时听 `pagehide`
   *
   * `visibilitychange` 在多数情况下够用，但**页面被销毁**（WebView 回收、
   * 系统内存紧张）时不一定派发它 —— 而那种情况下麦克风更该释放。
   * `pagehide` 是页面生命周期里最后能保证收到的事件。
   */
  private bindVisibilityRelease(): void {
    const docLike = this.doc as unknown as {
      addEventListener?: (type: string, fn: (e: unknown) => void) => void;
      defaultView?: { addEventListener?: (type: string, fn: (e: unknown) => void) => void };
    };

    const onHide = (): void => {
      /*
       * 只在**确实不可见**时释放。
       *
       * `visibilitychange` 在"回到前台"时也会触发（hidden 变 false），
       * 无条件释放会把用户正常录音打断 —— 那是把一个 bug 换成另一个。
       *
       * 判定走 `isDocHidden()`，与 `armWatchdog()` 的巡检用同一个方法：
       * 两处各写一遍表达式的话，一旦分叉就会出现"事件路径认为可见、
       * 轮询认为不可见"的自相矛盾。
       */
      if (this.isDocHidden()) this.releaseRecording('visibility');
    };

    docLike.addEventListener?.('visibilitychange', onHide);
    docLike.addEventListener?.('pagehide', () => this.releaseRecording('pagehide'));
    docLike.defaultView?.addEventListener?.('pagehide', () =>
      this.releaseRecording('pagehide'),
    );
  }

  /**
   * 无条件释放当前录音（幂等，可在任何出口调用）。
   *
   * ## 为什么所有出口都走这一个函数
   *
   * 原来每个出口各自写 `this.recording?.discard(); this.recording = null;`，
   * 于是**新增出口忘了写**就是泄漏 —— 这已经是本项目的头号缺陷形状。
   * 收成一个函数后，"有没有释放"只取决于"有没有调它"，
   * 而调用点可以用判据逐个钉住。
   *
   * @param reason 只在需要日志/排障时区分，行为完全一样
   */
  releaseRecording(reason: string): void {
    const current = this.recording;
    this.recording = null;
    if (current !== null) {
      /*
       * `discard()` 内部会 stop tracks + close AudioContext，
       * 且**不产出音频**（这次说话作废）。退后台时用户并没有"说完"，
       * 转写一段半句话既费钱又可能发出奇怪的消息，所以丢弃而不是 stop。
       */
      current.discard();
    }
    this.clearWatchdog();
    this.stopWaveLoop();
    /*
     * 状态机复位：退后台回来时应该是一个干净的空闲态，
     * 而不是停在上次的"录音中"上（那样用户会看到波形冻在那里）。
     */
    /*
     * ★ `activePointerId` 必须在这里也清 —— 而且要在 `if` **外面**。
     *
     * 它是"有没有一根手指正按着"的标记。漏清一次，下一次 `pointerdown`
     * 会被 `if (this.activePointerId !== null) return;` 直接拦掉，
     * 表现是「录过一次之后再也按不动」—— 而这种"第一次能用、之后不能用"
     * 的缺陷最难归因。
     *
     * 放 `if` 外面是因为：即使 flow 已经是 idle（没什么可复位的），
     * 这个标记仍可能残留（比如 `onPointerUp` 走到了 `recording === null`
     * 那条早退分支）。
     */
    this.activePointerId = null;
    /*
     * ★★ 手势与计时状态**无条件**复位（2026-11-02 修）。
     *
     * 原来这四行写在 `if (this.flow.stage !== 'idle')` 里面。后果是：
     *
     * ```text
     *   上滑取消（cancelling=true）→ onPointerUp 的取消分支
     *   → releaseRecording() 里 flow 已经是 idle ⇒ 那个 if 不成立
     *   → cancelling 永远是 true
     *   → hint 永久停在「松开 取消」，可用户早已松手
     *   → 下一次按下去也要先走一遍错误的取消判定
     * ```
     *
     * 真机取证（`diag-up-filter.mjs`）：
     * ```text
     *   切键盘再切回语音态（本该彻底复位）
     *   → {"hint":"松开 取消","state":"cancel","rec":"false","clock":"0:00"}
     *   ⇒ 界面在说谎：显示"松开取消"，但根本没在录音
     * ```
     *
     * 所以这三个状态与 `flow.stage` **无关**：它们描述的是"手指还按着吗"，
     * 而不是"流程走到哪一步"。放进 stage 的条件里是把两件事混了。
     */
    this.pressStart = null;
    this.cancelling = false;
    this.recordStartedAt = 0;
    if (this.flow.stage !== 'idle') {
      this.flow = createVoiceFlow(this.flow.mode);
      this.wave = freezeWaveform(this.wave);
    }
    /*
     * `syncAll()` 也无条件跑 —— 即使 flow 没变，`cancelling` 变了界面就变了
     * （提示从「松开 取消」回到「按住说话」）。少刷这一下，用户看到的就是
     * 一句与实际状态相反的提示。
     */
    this.syncAll();
    if (current !== null && reason !== 'repeat') {
      // 静默：用户切走了，弹提示他也看不到，回来看到干净界面即可
      this.options.onReleaseMic?.(reason);
    }
  }

  /**
   * 起录音期的巡检：**超时强制释放** + **页面已不可见就立即释放**。
   *
   * ## 为什么把它从"一次性 60 秒定时器"改成"每秒巡检 + 累计超时"
   *
   * 原来只挂一个 60 秒定时器，职责单一：防触摸序列永久卡住。
   * 但 2026-11-02 的真机取证发现 `visibilitychange` **会漏发**
   * （详见 `MIC_FOREGROUND_POLL_MS` 的注释）。漏发时那个 60 秒定时器
   * 就成了唯一指望 —— 而它意味着**最长 60 秒麦克风一直被占着**，
   * 期间别的应用录不了音，正是用户报的现象。
   *
   * 改成巡检后顺手管两件事，二者共用同一个定时器，不额外开销：
   *
   * | 每次 tick 的检查 | 触发后 |
   * |---|---|
   * | `document.hidden === true` | 立即 `releaseRecording('hidden-poll')` |
   * | 距开始 ≥ 60 秒 | `releaseRecording('watchdog')` + 提示"录音超时" |
   *
   * ## 为什么"隐藏"优先于"超时"判定
   *
   * 两者可能同时成立。此时真实原因是"用户切走了"，应该静默释放
   * （`hidden-poll`），而不是弹一句"录音超时"—— 那句话会让回来的用户
   * 以为是应用出错了，实际是他自己切了后台。
   */
  private armWatchdog(): void {
    this.clearWatchdog();
    const win = (this.doc as unknown as { defaultView?: { setTimeout?: typeof setTimeout } })
      .defaultView;
    const setter = win?.setTimeout ?? (globalThis as { setTimeout?: typeof setTimeout }).setTimeout;
    if (setter === undefined) return;

    const startedAt = Date.now();
    const tick = (): void => {
      /*
       * ① 页面已经不可见 ⇒ 立刻放掉。
       *
       * 这是**兜底**，不是主路径：正常情况下 `visibilitychange` 会先到
       * （实测差 3ms），走到这里说明那条路漏了。
       */
      if (this.isDocHidden()) {
        this.watchdog = null;
        this.releaseRecording('hidden-poll');
        return;
      }
      /* ② 累计超时 ⇒ 触摸序列卡住了 */
      if (Date.now() - startedAt >= MIC_WATCHDOG_MS) {
        this.watchdog = null;
        this.releaseRecording('watchdog');
        this.options.onNotify?.('录音超时，已自动停止', 'warn');
        return;
      }
      /* ③ 继续巡检 */
      this.watchdog = setter(tick, MIC_FOREGROUND_POLL_MS) as unknown as number;
    };
    this.watchdog = setter(tick, MIC_FOREGROUND_POLL_MS) as unknown as number;
  }

  /**
   * 页面当前是否不可见。
   *
   * 与 `bindVisibilityRelease()` 用**同一套判定**（`hidden` / `visibilityState`
   * 两处都看，且 `document` 与 `defaultView.document` 都兜）——
   * 两处写法一旦分叉，就会出现"事件路径认为可见、轮询认为不可见"的
   * 自相矛盾，而那种矛盾在小屏设备上难复现、难排查。
   *
   * 抽成一个方法而不是复制表达式：这是本项目反复吃过的亏
   * （同一件事写两遍，只有一遍被改）。
   */
  private isDocHidden(): boolean {
    const docLike = this.doc as unknown as {
      visibilityState?: string;
      hidden?: boolean;
      defaultView?: { document?: { hidden?: boolean; visibilityState?: string } };
    };
    return (
      docLike.hidden === true ||
      docLike.defaultView?.document?.hidden === true ||
      docLike.visibilityState === 'hidden' ||
      docLike.defaultView?.document?.visibilityState === 'hidden'
    );
  }

  private clearWatchdog(): void {
    if (this.watchdog === null) return;
    const win = (this.doc as unknown as { defaultView?: { clearTimeout?: typeof clearTimeout } })
      .defaultView;
    const clearer =
      win?.clearTimeout ?? (globalThis as { clearTimeout?: typeof clearTimeout }).clearTimeout;
    clearer?.(this.watchdog as unknown as ReturnType<typeof setTimeout>);
    this.watchdog = null;
  }

  /**
   * 销毁面板：**必须释放麦克风**（2026-11-01 发布阻断级修复）。
   *
   * ## 为什么原来没有这个方法就是 bug
   *
   * `ChatPanel.dispose()` 里写的是 `this.voicePanel = null` —— 只是丢引用。
   * 而 `switchTab()` 每次离开聊天页都会调 `chatPanel.dispose()`
   * （`renderPage()` 会重建面板）。于是"录音中切 Tab"这条路径上
   * MediaStream 还活着，**没有任何人 stop 它**。
   *
   * 用户要求的"切 Tab 时必须释放"正好命中这里。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    /*
     * ★ 顺序：先解绑监听，再释放录音。
     *
     * 反过来的话，`releaseRecording()` 过程中若有事件进来（它中间有 await），
     * 会落在一个"已经 dispose、但还在听事件"的面板上 —— 而 `onPointerDown`
     * 那时会重新 `transport.start()`，把刚放掉的麦克风又占回去。
     */
    this.unbindWindowPointers();
    this.releaseRecording('dispose');
    /* 波形定时器也要停：它持有 DOM 引用，不停就是稳定的内存增长 */
    this.stopWaveLoop();
    this.clearWatchdog();
  }

  /**
   * 渲染三个挂载点。
   *
   * 返回的元素**直接替换** `chat-view.ts` 里 `renderVoiceMounts` 的占位实现 ——
   * 调用方把这三个 append 到输入区即可，id/类名与本 T15.5 承诺的一致。
   */
  render(): VoiceMounts {
    const mic = this.renderMic();
    const stage = this.renderStage();
    const chips = this.renderChips();
    const confirm = this.renderConfirm();

    this.micEl = mic;
    this.chipsEl = chips;
    this.confirmEl = confirm;

    // window 上的 pointerup/cancel 只绑一次（滑出元素后松手也要收到）
    this.bindWindowPointers();

    this.syncAll();
    return { mic, stage, chips, confirm };
  }

  /* ── ① 麦克风 ── */

  private renderMic(): ElLike {
    /*
     * 工具栏里的小图标。**点击进入语音态**（不再按住录音）。
     *
     * 为什么必须是 button 而不是"div + role=button"：
     * 无障碍上 button 天然可聚焦、可被读屏念出，div 要手写一堆
     * role/tabindex/keydown 才等价，而那些手写项经常漏。
     *
     * 48×48 由 CSS 的 `--nb-icon-btn` 保证，这里**不写内联尺寸**
     * （T15.5 的走查断言守这条：`.nb-mic-slot` 必须用 token）。
     */
    const mic = el(this.doc, 'button', 'nb-mic-slot');
    mic.setAttribute('id', VOICE_MOUNTS.mic);
    mic.setAttribute('data-tcs-voice-mount', 'mic');
    mic.setAttribute('type', 'button');
    mic.setAttribute('aria-label', '切换到语音输入');
    /*
     * ★ 2026-11-05 用户要求：换成简笔画线稿，不要 emoji。
     *
     * 与大圆按钮共用 `makeMicIcon`（只是小一号）—— 两处各画一份必然分叉，
     * 而分叉的表现是"入口是个彩色 emoji、面板里是白线稿"，像两套 UI。
     */
    mic.append(makeMicIcon(this.doc, 22));

    mic.addEventListener('click', () => {
      /*
       * 未配置 ASR：**不静默无响应**，而是提示并跳配置页。
       *
       * 设计册 §7.2 原文：「未配置 ASR 时麦克风置灰，点击弹引导去配置页
       * —— 不是静默无响应」。这条很容易实现成"disabled 就完事"，
       * 而那样用户只会觉得"按了没反应"。
       */
      if (!this.options.asrConfigured || this.options.transport === undefined) {
        this.options.onNotify?.(
          '还没配置语音识别。去「我的 → 语音输入」里选一个厂商并填 key。',
          'warn',
        );
        this.options.onNeedAsrConfig?.();
        return;
      }
      this.setVoiceStage('voice');
    });

    return mic;
  }

  /* ── ①b 语音舞台：顶部波形 + 计时（2026-11-02 用户给的布局图） ── */

  /**
   * 顶部那一行：`|||||| || 0:01 || ||||||`
   *
   * ## 为什么波形与计时放在**同一条横线**上，且分左右两段
   *
   * 用户给的图就是这样：计时在正中，两侧各一段波形。
   * 这个形态有个实用好处 —— **计时永远在正中，不会因为波形跳动而左右漂**。
   * 如果把计时放左边、波形放右边，录到 1 分钟时（`1:02` 比 `0:01` 宽）
   * 计时会把波形挤走，看起来像界面在抖。
   *
   * ## 两段波形是**同一组数据**的镜像，不是两份独立采样
   *
   * 左段按时间正序、右段反序 —— 这样视觉上是"从中心向两边扩散"，
   * 与"声音从麦克风进来"的方向一致。若两边都正序，看起来像两个不同的东西。
   */
  private renderWaveClock(): ElLike {
    const row = el(this.doc, 'div', 'nb-voice-waveclock');
    row.setAttribute('data-role', 'voice-waveclock');

    const left = el(this.doc, 'div', 'nb-voice-wave');
    left.setAttribute('data-side', 'left');
    const clock = el(this.doc, 'span', 'nb-voice-clock');
    clock.setAttribute('data-role', 'voice-clock');
    clock.textContent = '0:00';
    this.clockEl = clock;
    const right = el(this.doc, 'div', 'nb-voice-wave');
    right.setAttribute('data-side', 'right');

    /*
     * 柱数按"每段一半"分配。
     *
     * `DEFAULT_BAR_COUNT` 是旧的单段柱数（放大圆按钮上）。现在拆两段，
     * 每段取它的一半，总柱数不变 —— 这样 `paintWave()` 读到的
     * `barHeights()` 长度与柱数仍然匹配，不用改波形状态机。
     */
    const perSide = Math.max(4, Math.floor(DEFAULT_BAR_COUNT / 2));
    for (let i = 0; i < perSide; i += 1) left.append(this.makeWaveBar());
    for (let i = 0; i < perSide; i += 1) right.append(this.makeWaveBar());

    row.append(left, clock, right);
    this.waveRowEl = row;
    return row;
  }

  private makeWaveBar(): ElLike {
    const bar = el(this.doc, 'span', 'nb-voice-wave-bar');
    bar.setAttribute('style', '--nb-wave-level:0.2');
    return bar;
  }

  /* ── ①c 三个圆按钮：内心/动作 · 说话（按住） · 消息 ── */

  private renderStage(): ElLike {
    const stage = el(this.doc, 'div', 'nb-voice-stage');
    stage.setAttribute('id', VOICE_MOUNTS.stage);
    stage.setAttribute('data-tcs-voice-mount', 'stage');

    const waveClock = this.renderWaveClock();

    /*
     * 提示文字 —— **只在按住后才说"上滑取消"**。
     *
     * 用户原话：「按住中间的按钮是提示上滑取消，松开识别为对话」。
     *
     * 也就是说：没按住时不该拿"上滑取消"去打扰他（那时最需要的是
     * "按住说话"这四个字，告诉他怎么开始）；按住之后才需要告诉
     * "现在上滑能反悔"。把两句塞进一行，等于一直有一半是废话。
     */
    const hint = el(this.doc, 'span', 'nb-voice-stage-hint');
    hint.setAttribute('data-role', 'voice-stage-hint');
    hint.textContent = '按住说话';
    this.hintEl = hint;

    // 切回键盘：没有它就进得去出不来
    const exit = el(this.doc, 'button', 'nb-voice-stage-exit');
    exit.setAttribute('type', 'button');
    exit.setAttribute('data-role', 'voice-stage-exit');
    exit.setAttribute('aria-label', '切回键盘输入');
    exit.textContent = '⌨ 键盘';
    exit.addEventListener('click', () => this.setVoiceStage('keyboard'));

    stage.append(waveClock, hint, exit);
    this.stageRoot = stage;
    return stage;
  }

  /**
   * 绑定 window 上的 pointer 事件。
   *
   * ## ★ 2026-11-02：改成**幂等**，并在 `dispose()` 里解绑
   *
   * 原来这里每次 `render()` 都新增一套监听（注释说"只绑一次"，但代码没判）。
   * 而 `dispose()` 不解绑 ⇒ 每切一次 Tab 就多一个"僵尸面板"在听 `pointerdown`，
   * 它会自己 `transport.start()` 开一路麦克风，但没有任何人能释放它。
   *
   * 真机抓到设备侧同时有**两个** active 录音（riid 2615 / 2623），
   * 就是这里来的。
   *
   * 两道防线：
   *   1. `pointerBindTarget !== null` ⇒ 已经绑过，直接返回（幂等）
   *   2. `dispose()` 调 `unbindWindowPointers()` 真正 remove（含窗口级引用）
   */
  private bindWindowPointers(): void {
    if (this.pointerBindTarget !== null) return;

    /*
     * pointerup/cancel 绑在 window 而不是大圆按钮上。
     *
     * 手指按住大圆往上滑到 chips 再松手是最自然的动作 —— 此时事件目标
     * 已经不是按钮了。绑在按钮上会漏掉"滑出后松手"，表现为
     * **录音永远停不下来**，而且没有任何报错。
     */
    const docLike = this.doc as unknown as {
      addEventListener?: (type: string, fn: (e: unknown) => void) => void;
      removeEventListener?: (type: string, fn: (e: unknown) => void) => void;
      defaultView?: {
        addEventListener?: (type: string, fn: (e: unknown) => void) => void;
        removeEventListener?: (type: string, fn: (e: unknown) => void) => void;
      };
    };
    const win = docLike.defaultView ?? docLike;

    /*
     * ★★★ `onUp` / `onCancel` **故意不做** pointerId 过滤（2026-11-02）。
     *
     * ## 为什么只过滤 `onMove`
     *
     * | 事件 | 不过滤的代价 | 过滤的代价 |
     * |---|---|---|
     * | `onMove` | 第二根手指能"代劳"切档（用户就是被迫用两指的） | 无 |
     * | `onUp` | 第二根手指抬起会**提前结束**一次录音（重按即可） | 麦克风被占到 60 秒看门狗 |
     * | `onCancel` | 同上 | 同上 |
     *
     * 两边代价差一个量级。"第二根手指抬起误停"用户立刻能察觉并重按；
     * 而"UP 被拦"的表现是**录音停不下来**——用户会觉得麦克风坏了
     * （这正好是他上一轮报的那个症状）。
     *
     * 真机上 `input motionevent` 注入的 UP 就出现过与 DOWN 不同
     * `pointerId` 的情况，那一刻录音直接卡住 12 秒以上没回 idle。
     *
     * ## 那"两指代劳"会被重新打开吗
     *
     * 不会 —— 它靠的是 `onMove`，那里仍然严格过滤。第二根手指的移动
     * 进不来，档位就切不了；它抬起顶多把这次录音结束掉（然后用户
     * 用一根手指重来，正好是我们希望的行为）。
     */
    const onUp = (event: unknown): void => {
      void this.onPointerUp(event);
    };
    const onCancel = (): void => {
      void this.onPointerCancel();
    };
    const onMove = (event: unknown): void => {
      if (this.flow.stage !== 'recording') return;
      if (!this.isActivePointer(event)) return;
      const ev = event as { clientX?: number; clientY?: number };
      if (typeof ev.clientX === 'number' && typeof ev.clientY === 'number') {
        this.handlePointerMove(ev.clientX, ev.clientY);
      }
    };

    win.addEventListener?.('pointerup', onUp);
    win.addEventListener?.('pointercancel', onCancel);
    win.addEventListener?.('pointermove', onMove);

    this.pointerBindTarget = win;
    this.onPointerUpBound = onUp;
    this.onPointerCancelBound = onCancel;
    this.onPointerMoveBound = onMove;
  }

  /**
   * 当前事件是不是"发起这次按压的那根手指"发出来的。
   *
   * ## 三种情况的处理
   *
   * | `activePointerId` | 事件带 `pointerId` | 结论 |
   * |---|---|---|
   * | `null`（没有按压） | 任意 | **放行** —— 见下 |
   * | 有 | 相同 | 放行 |
   * | 有 | 不同 | **拦掉**（第二根手指） |
   *
   * 第一行为什么放行：`null` 表示"我们不认为有按压在进行"，此时拦掉
   * 反而会把**正常的第一次按压**也挡掉（比如 `pointerdown` 因异常没记成）。
   * 而 `onPointerUp` / `onPointerCancel` 自己会判 `flow.stage`，
   * 放进去也不会误伤。
   *
   * ## 为什么读不到 `pointerId` 也放行
   *
   * 单测与 demo 的 DOM stub 派发的事件没有 `pointerId`。若这时拦掉，
   * **整条手势链路在测试里都跑不起来** —— 而这些测试守的是取消/发送
   * 那几条真正的行为。宁可容忍"stub 场景下多指过滤失效"，
   * 也不能让核心行为无人守。
   */
  private isActivePointer(event: unknown): boolean {
    if (this.activePointerId === null) return true;
    const id = (event as { pointerId?: number }).pointerId;
    if (typeof id !== 'number') return true;
    return id === this.activePointerId;
  }

  /**
   * 解绑 window 监听。
   *
   * 必须与 `bindWindowPointers()` 成对：解绑漏了就是"僵尸面板继续听事件、
   * 继续开麦"，而且**任何 DOM 断言都看不到它**（它已经没有元素了）。
   */
  private unbindWindowPointers(): void {
    const target = this.pointerBindTarget;
    if (target === null) return;
    if (this.onPointerUpBound !== null) {
      target.removeEventListener?.('pointerup', this.onPointerUpBound);
    }
    if (this.onPointerCancelBound !== null) {
      target.removeEventListener?.('pointercancel', this.onPointerCancelBound);
    }
    if (this.onPointerMoveBound !== null) {
      target.removeEventListener?.('pointermove', this.onPointerMoveBound);
    }
    this.pointerBindTarget = null;
    this.onPointerUpBound = null;
    this.onPointerCancelBound = null;
    this.onPointerMoveBound = null;
  }

  /**
   * 切换输入区形态。
   *
   * 切回键盘时**必须复位录音状态**：否则用户按住时点键盘，
   * 会留下一个"录音中"的状态机挂在那里。
   */
  setVoiceStage(stage: VoiceStage): void {
    if (this.voiceStage === stage) return;

    if (stage === 'keyboard') {
      /*
       * 离开语音态：干净收尾（不发、不留条）。
       *
       * ★ 改成**无条件** `releaseRecording()`（2026-11-01）。
       * 原来是 `if (this.flow.stage === 'recording') this.recording?.discard()` ——
       * 而 `recording` 非空、`flow.stage` 却已经不是 `recording` 的窗口是存在的
       * （`onPointerUp` 里先 `this.recording = null` 再 `beginTranscribing`，
       * 但反过来"外部先改 stage 再回来"就没有保护）。
       * 条件判断在释放路径上是纯风险：多判一个条件就多一种漏放的可能。
       */
      this.releaseRecording('stage-keyboard');
    }

    this.voiceStage = stage;
    this.options.onStageChange?.(stage);
    this.syncAll();
  }

  /** 给测试与外部：当前输入区形态 */
  currentStage(): VoiceStage {
    return this.voiceStage;
  }

  /* ── ② chips ── */

  /**
   * 档位胶囊的**展示顺序**（≠ `VOICE_MODES` 的语义顺序）。
   *
   * ## ★ 为什么必须单独定义一个顺序（2026-11-02 用户明确要求）
   *
   * 用户原话：
   * > 按住按钮并且**左滑到左边的按钮**识别为内心、动作，
   * > 按住按钮**右滑到一个按钮**为消息
   *
   * 而 `VOICE_MODES` 是 `['speak', 'inner', 'message']` —— 渲染出来是
   * 「说话 | 内心/动作 | 消息」，左滑会滑到"说话"那边。
   *
   * 于是**手势方向与视觉位置对不上**：用户往左滑，手指底下是「说话」，
   * 但代码按 `dx <= -56` 判成了 `inner`。他看到的和他得到的相反，
   * 自然会认为"你没按我说的改"。
   *
   * 改成 `['inner', 'speak', 'message']` 之后三者对齐：
   *
   * ```text
   *   ┌──────────────┬────────┬──────────┐
   *   │ 💭 内心/动作  │ 🗣 说话 │ 💬 消息   │
   *   └──────────────┴────────┴──────────┘
   *        ↑ 左滑       ↑ 默认      ↑ 右滑
   * ```
   *
   * ## 为什么不直接改 `VOICE_MODES`
   *
   * 它是**语义/枚举顺序**，被默认值、round-trip 测试、存储字段引用。
   * 为了视觉顺序去动枚举，等于让"模式有哪几种"和"界面上怎么排"
   * 绑死 —— 以后想换布局就会动到语义层。两者本来就该分开。
   */
  private static readonly CHIP_DISPLAY_ORDER: readonly VoiceMode[] = [
    'inner',
    'speak',
    'message',
  ];

  /**
   * 一排三个圆：`(内心/动作)  (🎤按住说话)  (消息)`（2026-11-02 用户给的布局图）。
   *
   * ## 为什么不沿用"三个胶囊 + 一个大圆"的老结构
   *
   * 老结构是「三个胶囊一行 + 下面一个大圆按钮」，用户看图后明确要求换成
   * QQ 那种**三圆横排**：左右两个小圆是"档位"，中间那个大圆既是
   * "按住说话"的按钮、也是默认的「说话」档。
   *
   * 语义上的关键差别：老结构里"选档位"和"按住说话"是两个动作（先点胶囊
   * 选档、再按住按钮）；新结构里**只有一个动作** —— 按住中间就开始说，
   * 想换档就**滑到左右那个圆上**。用户原话：
   * > 左边那个是内心/动作，按住并滑到这个按钮上使用；中间是说话，
   * > 右边是消息，按住并滑到这个按钮上使用
   *
   * ## 为什么大圆放在这个容器里（而不是留在 stage 里）
   *
   * 三个圆必须在**同一个 flex 行**里才能保证"左右两个圆正好在中间大圆
   * 两侧对称"。分两个容器靠外边距对齐，会在不同屏宽下偏移（真机上
   * 窄屏会把右边那个挤出去）。
   *
   * `VOICE_MOUNTS.bigmic` 的 id / `data-tcs-voice-mount` 都没变，
   * 所以既有判据与外壳代码都不用跟着改。
   */
  private renderChips(): ElLike {
    const row = el(this.doc, 'div', 'nb-voice-chips-slot');
    row.setAttribute('id', VOICE_MOUNTS.chips);
    row.setAttribute('data-tcs-voice-mount', 'chips');
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', '语音模式');

    /* 左：内心/动作 */
    row.append(this.renderSideChip('inner'));

    /* 中：大圆 —— 按住说话 */
    const bigmic = el(this.doc, 'button', 'nb-voice-bigmic');
    bigmic.setAttribute('id', VOICE_MOUNTS.bigmic);
    bigmic.setAttribute('data-tcs-voice-mount', 'bigmic');
    bigmic.setAttribute('type', 'button');
    bigmic.setAttribute('aria-label', '按住说话');
    bigmic.setAttribute('data-voice-mode', 'speak');
    /*
     * 图标用 SVG 而不是 emoji `🎤`。
     *
     * 图片里的麦克风是**白色实心线稿**，而 emoji 在不同 Android 版本上
     * 是彩色贴图、大小也不一致（真机截图里那个 emoji 明显偏小且带底色）。
     * 内联 SVG 能保证"白线 + 透明底"，且 `currentColor` 跟着状态变色。
     */
    bigmic.append(makeMicIcon(this.doc));
    bigmic.addEventListener('pointerdown', (event) => {
      void this.onPointerDown(event);
    });
    this.bigmicEl = bigmic;
    row.append(bigmic);

    /* 右：消息 */
    row.append(this.renderSideChip('message'));

    return row;
  }

  /**
   * 左右两个小圆。
   *
   * 它们**不是**"点一下切档"的按钮（点它们没有用）—— 只有"按住中间大圆
   * 再滑过来"才有意义。所以：
   *   · 不加 `click` 监听（加了会让用户以为能点，点了没反应更糟）
   *   · 但保留 `role="radio"` + `aria-checked`，让读屏能念出当前档位
   */
  private renderSideChip(mode: VoiceMode): ElLike {
    const chip = el(this.doc, 'div', 'nb-chip');
    chip.setAttribute('data-voice-mode', mode);
    chip.setAttribute('role', 'radio');
    chip.setAttribute('aria-checked', String(mode === this.flow.mode));
    chip.setAttribute('data-selected', String(mode === this.flow.mode));

    /*
     * 文案分两行：`内心` / `动作`。
     *
     * 圆直径小（设计给的是 72px 量级），`内心/动作` 五个字一行放不下会
     * 被裁掉最后一个字 —— 那比不放字更糟（用户看到"内心/动"）。拆成两行后
     * 每个字都完整，且"动作"独占一行读起来就是"内心 动作"。
     */
    const lines = VOICE_MODE_LABEL[mode].split('/');
    for (const line of lines) {
      const span = el(this.doc, 'span', 'nb-chip-line');
      span.textContent = line;
      chip.append(span);
    }

    this.chipEls.set(mode, chip);
    return chip;
  }

  /* ── ③ 待确认条 ── */

  /**
   * 待确认草稿（2026-10-30 用户给的形态）。
   *
   * ## 长得像一条**待发的消息**，不是输入区里的工具条
   *
   * 用户给的示意图里，语音确认是「音频条 + 文字 + 确认/取消」竖着排，
   * 像一条还没发出去的消息。这样有个实际好处：**所见即所发** ——
   * 用户在原地就能看到"发出去会长什么样"。
   *
   * ## 三段结构
   *
   * ```text
   * ┌────────────────────────┐
   * │ ▶ ||||| 1"   ← 音频条（宽度≤半屏，按时长递增）│
   * └────────────────────────┘
   * ┌──────────────┐
   * │ 嗯。          │  ← 文字气泡，点一下就地变可编辑
   * └──────────────┘
   *      [确认] [取消]
   * ```
   *
   * ## 颜色
   *
   * 用户要求「音频条的颜色设计要与整体符合」—— 示意图里 QQ 是黄色，
   * 我们用夜航 token（星云紫→青）。全部走 CSS 变量，不写裸色值。
   */
  private renderConfirm(): ElLike {
    const draftBox = el(this.doc, 'div', 'nb-voice-draft-card');
    draftBox.setAttribute('id', VOICE_MOUNTS.confirm);
    draftBox.setAttribute('data-tcs-voice-mount', 'confirm');
    // 未进入 confirming 前不占位（CSS 用 [hidden] 兜住，这里先设上）
    draftBox.hidden = true;

    /* ── ① 音频条（纯视觉，不播放） ── */
    const barbox = el(this.doc, 'div', 'nb-voice-barbox');
    barbox.setAttribute('data-role', 'voice-barbox');
    barbox.setAttribute('aria-hidden', 'true');

    // 播放图标：纯装饰。需求明确"纯视觉不播放"，所以它是 span 不是 button ——
    // 用 button 会让用户以为能点，点了没反应更糟。
    const playIcon = el(this.doc, 'span', 'nb-voice-bar-play');
    playIcon.textContent = '▶';

    // 波形缩略：静态柱，不刷新（录音已结束，刷新只会晃）
    const wave = el(this.doc, 'span', 'nb-voice-bar-wave');
    for (let i = 0; i < 9; i += 1) {
      const one = el(this.doc, 'span', 'nb-voice-wave-bar');
      one.setAttribute('data-bar', String(i));
      wave.append(one);
    }
    this.waveThumbEl = wave;

    const duration = el(this.doc, 'span', 'nb-voice-bar-dur');
    duration.setAttribute('data-role', 'voice-duration');
    // 时长等真正录完再填；先占位避免布局跳
    duration.textContent = '1"';

    barbox.append(playIcon, wave, duration);

    /* ── ② 文字气泡（点一下就地变可编辑） ── */
    const bubbleWrap = el(this.doc, 'div', 'nb-voice-textwrap');

    /*
     * 只读态：显示文字，看起来就是一条消息气泡。
     *
     * 这里不能用 `renderMessageHtml` 的输出直接塞 innerHTML 吗？可以，
     * 但**编辑对象必须是已包裹的纯文本**（需求 §6），而 markdown 渲染会
     * 把 `(动作)` 之类原样保留、把 `*斜体*` 变成标签 —— 编辑时拿到 HTML
     * 就对不上了。所以只读态渲染 markdown，编辑态切纯文本。
     */
    const textView = el(this.doc, 'div', 'nb-voice-textview');
    textView.setAttribute('data-role', 'voice-textview');
    textView.setAttribute('role', 'button');
    textView.setAttribute('tabindex', '0');
    textView.setAttribute('aria-label', '点一下修改这段文字');
    this.textViewEl = textView;

    // 编辑态：textarea（语音转写可能多句，单行 input 会横向滚）
    const editor = el(this.doc, 'textarea', 'nb-voice-draft');
    editor.setAttribute('data-role', 'voice-draft');
    editor.setAttribute('aria-label', '待发送的语音文本');
    editor.setAttribute('rows', '2');
    editor.hidden = true;
    this.draftEl = editor;

    /** 进入编辑态 */
    const enterEdit = (): void => {
      textView.hidden = true;
      editor.hidden = false;
      /*
       * 种子值必须是**状态机里的草稿**，不是编辑框自己的值。
       *
       * 我在第一版里写的是 `editor.value = this.readEditorValue()` ——
       * 编辑框刚创建、从未写过值，读出来是空串，于是用户点一下文字气泡，
       * 转写内容当场被清空成空白；再一失焦 `editDraft(flow, '')` 把草稿
       * 覆盖掉，点确认就变成「内容为空，没有发送」。**整个转写丢失**。
       * 测试里 `editor.value` 与 `flow.draft` 对不上，就是这么抓出来的。
       */
      (editor as unknown as HTMLTextAreaElement).value = this.flow.draft ?? '';
      (editor as unknown as HTMLTextAreaElement).focus?.();
      this.editingDraft = true;
    };

    /** 退出编辑态（失焦即存，与需求「单击修改」一致） */
    const exitEdit = (): void => {
      if (!this.editingDraft) return;
      editor.hidden = true;
      textView.hidden = false;
      this.editingDraft = false;
      // 把编辑结果同步回状态机（只允许 confirming 阶段改）
      this.flow = editDraft(this.flow, this.readEditorValue());
      this.paintDraftText();
    };

    textView.addEventListener('click', enterEdit);
    // 键盘可达：tabindex + Enter/Space 等价于点击
    textView.addEventListener('keydown', (event) => {
      const key = (event as { key?: string }).key;
      if (key === 'Enter' || key === ' ') {
        (event as { preventDefault?: () => void }).preventDefault?.();
        enterEdit();
      }
    });
    editor.addEventListener('blur', exitEdit);

    bubbleWrap.append(textView, editor);

    /* ── ③ 确认 / 取消 ── */
    const actions = el(this.doc, 'div', 'nb-voice-confirm-actions');

    const ok = el(this.doc, 'button', 'nb-btn nb-btn--primary');
    ok.setAttribute('type', 'button');
    ok.setAttribute('data-role', 'voice-send');
    ok.textContent = '确认';
    ok.addEventListener('click', () => {
      // 先收掉编辑态，确保发出去的是最新文本
      exitEdit();
      void this.onConfirmSend();
    });

    const no = el(this.doc, 'button', 'nb-btn');
    no.setAttribute('type', 'button');
    no.setAttribute('data-role', 'voice-cancel');
    no.textContent = '取消';
    no.addEventListener('click', () => this.onCancel());

    actions.append(ok, no);

    draftBox.append(barbox, bubbleWrap, actions);
    return draftBox;
  }

  /* ═══════════════════════════════════════════════════════════
     交互
     ═══════════════════════════════════════════════════════════ */

  private async onPointerDown(event: unknown): Promise<void> {
    /*
     * ★ 第三道防线（2026-11-02）：已 dispose 的面板绝不许再开麦。
     *
     * 前两道是 `unbindWindowPointers()` 与 `bindWindowPointers()` 的幂等。
     * 但"解绑漏了某个事件类型"这种错将来还可能犯，而它的后果是**悄悄多占
     * 一路麦克风**（用户只看到"别的应用录不了音"，我们这边一点报错都没有）。
     *
     * 这一条不依赖任何解绑逻辑，只看"我这个实例还活着吗"。
     */
    if (this.disposed) return;

    /*
     * 未配置 ASR：**不静默无响应**，而是提示并跳配置页。
     *
     * 需求原文（设计册 §7.2）：「未配置 ASR 时麦克风置灰，点击弹引导去配置页
     * —— 不是静默无响应」。这条很容易实现成"disabled 就完事"，
     * 而那样用户只会觉得"按了没反应"。
     */
    if (!this.options.asrConfigured || this.options.transport === undefined) {
      this.options.onNotify?.('还没配置语音识别。去「我的 → 语音输入」里选一个厂商并填 key。', 'warn');
      this.options.onNeedAsrConfig?.();
      return;
    }

    // 拦住指针事件的默认行为（长按选中、系统长按菜单）
    const ev = event as { preventDefault?: () => void; pointerId?: number; clientX?: number; clientY?: number };
    ev.preventDefault?.();

    /*
     * ★ 记下"发起这次按压的那根手指"（2026-11-02）。
     *
     * 三个 window 级 handler 之后都用 `isActivePointer()` 按它过滤，
     * 让**第二根手指完全不参与**。
     *
     * ## 为什么要拦掉"已有一根手指在按时又按下第二根"
     *
     * 不加这条时，两根手指都能触发 `onPointerDown`：第二根手指会把
     * `pressStart` 覆盖成它自己的落点，还可能再 `transport.start()` 一次
     * 开第二路麦克风（真机上确实是两路 —— 见 memory §72.8 的僵尸面板）。
     * 而"多指按住同一个按钮"在用户那儿没有任何正当用途。
     */
    if (this.activePointerId !== null) return;
    if (typeof ev.pointerId === 'number') this.activePointerId = ev.pointerId;

    /*
     * ★ 借这次**用户手势**把提示音的 AudioContext 拉起来。
     *
     * WebAudio 在没有用户手势时是 `suspended`，播放不出声。
     * 而"发送成功"发生在松手后 1~2 秒（转写完），那时已经脱离手势上下文 ——
     * 等到那一刻再 resume 往往不生效，症状是"代码跑了但没声音"。
     */
    warmupSendSound();

    /*
     * 记下按下的位置 —— 上滑取消的基准点。
     *
     * 记不到（某些合成事件不带坐标）就置 null：此时取消功能整体失效，
     * 但**录音照常**。宁可少一个手势，也不能因为拿不到坐标就不让人说话。
     * `handlePointerMove` 里对 null 会直接跳过取消判定。
     */
    this.pressStart =
      typeof ev.clientX === 'number' && typeof ev.clientY === 'number'
        ? { x: ev.clientX, y: ev.clientY }
        : null;
    /*
     * 这一句是**入口归一化**，不是重复的出口清理 —— 每次开始新一次交互都把
     * 状态置成初始值，这样即使将来新增了某个提前 return 的出口忘了清理，
     * 下一次按压也能自愈。
     *
     * 实测说明（不装成它被测到了）：变异测试把这一句删掉，**全部测试仍然通过**
     * —— 因为当前每个出口（pointerup 取消路径 / pointerup 正常路径 /
     * pointercancel / setVoiceStage）都自己复位了。它守的是"将来"，
     * 现在没有可观测差异。
     */
    this.cancelling = false;

    const transport = this.options.transport;
    try {
      this.recording = await transport.start();
    } catch (error) {
      this.options.onNotify?.(
        `打不开麦克风：${error instanceof Error ? error.message : String(error)}`,
        'danger',
      );
      return;
    }

    this.flow = beginRecording(this.flow, this.flow.mode);
    this.wave = createWaveform(DEFAULT_BAR_COUNT);
    /*
     * 记开始时刻，松手时算时长。
     *
     * 为什么不用 `wave.chunkCount × 120ms`：波形的刷新靠定时器，
     * 而定时器在后台可能被节流 —— 那会算出偏短的时长。
     * 用真实时钟才与用户感受一致。
     */
    this.recordStartedAt = Date.now();
    /*
     * 起看门狗：60 秒还没松手就强制释放。
     * 见 `MIC_WATCHDOG_MS` 的注释 —— 触摸序列可能永远不结束。
     */
    this.armWatchdog();
    this.syncAll();
    this.startWaveLoop();
  }

  private async onPointerUp(event: unknown): Promise<void> {
    /*
     * ★★★ 第一件事：**放开指针占用**，不附带任何业务条件（2026-11-02 最终修）。
     *
     * 这一行原先放在 `if (this.flow.stage !== 'recording') return;` **之后**，
     * 于是"UP 到达时 stage 已经不是 recording"的情形会漏清 —— 而那种情形
     * 是真实存在的（第一次 UP 触发转写后 stage 立刻变、系统可能再补一个
     * pointerup）。漏清的后果不是"少切一次档"，而是：
     *
     * ```text
     *   activePointerId 残留
     *   → 下一次 onPointerDown 被 `if (this.activePointerId !== null) return;` 无声拦掉
     *   → 用户按住大圆**完全没有反应**（没有提示、没有波形、没有录音）
     * ```
     *
     * 真机取证：连续两次手势，第二次的 `DOWN` 之后状态是
     * `{flowStage: "idle", hintState: "idle", notices: [], lastVoiceMode: ""}`
     * —— 全静止，连错误提示都没有。这比报错更难查。
     *
     * 所以顺序改成"先清标记，再判业务"。标记属于输入层，业务判断属于流程层，
     * 输入层的事实（手指抬起了）不该被流程层的条件挡在后面。
     *
     * 下面这条注释仍然成立：dispose 之后也要允许走到停录音这一步。
     */
    this.activePointerId = null;

    if (this.flow.stage !== 'recording') return;

    /*
     * ★★ 手指已经抬起 ⇒ **立刻**放开指针占用，不管后面走哪条分支（2026-11-02）。
     *
     * 原来这条赋值分散在"取消分支"和"正常分支"里，而中间还有一个
     * **早退分支**：
     *
     * ```text
     *   const recording = this.recording;
     *   this.recording = null;
     *   if (recording === null) {
     *     this.flow = beginTranscribing(this.flow);
     *     this.syncAll();
     *     return;          ← 这里漏了清 activePointerId
     *   }
     * ```
     *
     * 一旦走到那条（录音器已被巡检/看门狗释放，但 stage 还是 recording），
     * `activePointerId` 就永远留着 ⇒ 下一次 `onPointerDown` 被
     * `if (this.activePointerId !== null) return;` 拦住 ⇒
     * **用户下一次按住完全没反应**。
     *
     * 真机表现：连续做几步手势，中间某一步就是 `not-recording`，
     * 而每次都"有时候能过有时候过不了"—— 取决于有没有走到早退分支。
     *
     * 修法与 `releaseRecording` 同源：**出口归一**。手指抬起是唯一事实，
     * 与后面走哪条分支无关，所以放在最前面。
     */
    /*
     * 松手了 ⇒ 看门狗使命结束。不等下面的分支：
     * 无论走"取消"还是"正常发送"，这一刻都不再需要兜底定时器。
     */
    this.clearWatchdog();

    /*
     * ★ 上滑取消：**必须在最前面判，早于任何"停录音 / 算时长 / 转写"**。
     *
     * 顺序理由：取消的语义是"这次白说了"，所以
     *   · 不该调 `recording.stop()`（那会产出一段音频，然后我们把它扔掉，
     *     白白跑一遍编码）；
     *   · 不该进入 `transcribing`（那会让浮层挂一下再消失，看起来像发失败了）；
     *   · 更不该调 ASR（花钱、还慢）。
     * 直接 `discard()` + 回 idle，是最短且语义最准的路径。
     *
     * 松手这一刻再判一次 `isCancelSlide`，而不是只信 `this.cancelling`：
     * `cancelling` 是 pointermove 算出来的，而**最后一次 move 之后手指可能
     * 又滑回原处再松手**（或者根本没收到 move 事件）。以松手坐标为准，
     * 才不会出现"提示写着松手取消、结果还是发出去了"。
     */
    const evUp = event as { clientX?: number; clientY?: number };
    const releasedCancelling =
      this.pressStart !== null &&
      typeof evUp.clientX === 'number' &&
      typeof evUp.clientY === 'number'
        ? isCancelSlide(this.pressStart, { x: evUp.clientX, y: evUp.clientY })
        : this.cancelling;

    if (releasedCancelling) {
      this.releaseRecording('slide-cancel');
      this.stopWaveLoop();
      // 波形定格而不是继续跑：视觉上"停住了"，与"取消"一致
      this.wave = freezeWaveform(this.wave);
      this.flow = cancelRecording(this.flow);
      this.pressStart = null;
      this.cancelling = false;
      this.lastDurationMs = 0;
      this.recordStartedAt = 0;
      this.syncAll();
      // 说一句"已取消"，否则用户不确定是取消了还是丢了
      this.options.onNotify?.('已取消这次录音', 'info');
      return;
    }

    /*
     * 松手时的模式：**以松手坐标为准重算一次**，不直接信 `pendingMode`。
     *
     * 理由与上滑取消那里同源：最后一次 `pointermove` 之后手指可能又滑回中间，
     * 或者根本没收到 move 事件。只信缓存的 `pendingMode` 会出现
     * "界面高亮着内心、结果发成了说话"（或反过来）。
     *
     * ★ 2026-11-02：判定从"横向位移"改成"落在哪个圆上"，与
     * `handlePointerMove` 用**同一个** `modeUnderPoint()` ——
     * 两处若各写一套，就会出现"拖动时高亮内心、松手发成消息"。
     * 读不到矩形（单测 stub）时回落到 `pendingMode`，那是拖动过程中
     * 由同一函数算出的值，语义一致。
     */
    const upPoint =
      typeof (event as { clientX?: number }).clientX === 'number' &&
      typeof (event as { clientY?: number }).clientY === 'number'
        ? { x: (event as { clientX: number }).clientX, y: (event as { clientY: number }).clientY }
        : null;
    const hitMode = upPoint === null ? null : this.modeUnderPoint(upPoint);
    const finalMode = hitMode ?? this.pendingMode;
    this.pendingMode = finalMode;
    this.flow = setFlowMode(this.flow, finalMode);
    this.pressStart = null;
    this.cancelling = false;
    /*
     * 把"这次用的是哪个档位"记到 body 上（2026-11-02）。
     *
     * 用途有两个，都很实际：
     *   · **真机验收**：`input motionevent` 注入的触摸是一次性完成的，
     *     抬起那一刻页面已经进入转写，读不到"抬起前的高亮"。记下来才能断言
     *     "滑到左圆那次真的用 inner 发了"。
     *   · **排障**：用户说"明明选的是内心却发成说话"时，看一眼这个就知道
     *     是判定错了还是显示错了。
     */
    const body = (this.doc as unknown as { body?: { dataset?: Record<string, string | undefined> } }).body;
    if (body?.dataset !== undefined) body.dataset['lastVoiceMode'] = finalMode;

    this.stopWaveLoop();
    this.wave = freezeWaveform(this.wave);

    // 算时长（松手这一刻定，之后不再变）
    if (this.recordStartedAt > 0) {
      this.lastDurationMs = Math.max(0, Date.now() - this.recordStartedAt);
      this.recordStartedAt = 0;
    }

    const recording = this.recording;
    this.recording = null;
    if (recording === null) {
      this.flow = beginTranscribing(this.flow);
      this.syncAll();
      return;
    }

    this.flow = beginTranscribing(this.flow);
    this.syncAll();

    try {
      const audio = await recording.stop();
      const transport = this.options.transport;
      if (transport === undefined) throw new Error('录音通道不可用');
      const transcript = await transport.transcribe(audio, this.flow.mode);

      /*
       * ★ 分岔点交给纯逻辑：`applyTranscript` 返回 `send` 决定发不发。
       *
       * 直发（确认关）→ send 有值，立刻落消息；
       * 待确认（确认开）→ stage 变 confirming，等用户点发送；
       * 空白转写 → 回 idle 整条作废（不发送、不留条）。
       */
      const result = applyTranscript(this.flow, transcript, this.options.confirmBeforeSend);
      this.flow = result.flow;

      if (result.send !== null) {
        /*
         * 直发路径：先回到 idle 再发，避免"发送过程中待确认条还挂着"。
         * `syncAll` 放在 send 之前，因为 onSend 可能是 async 的慢操作。
         */
        this.syncAll();
        await this.options.onSend(result.send, this.lastDurationMs);
        /* 发送成功 → 提示音（2026-11-02 用户要求，QQ 那种） */
        playSendSound();
      } else if (this.flow.stage === 'idle') {
        // 空白转写：给一句提示，而不是静默消失
        this.options.onNotify?.('没听清，再说一次？', 'warn');
        this.syncAll();
      } else {
        this.syncAll();
      }
    } catch (error) {
      this.flow = createVoiceFlow(this.flow.mode);
      this.syncAll();
      this.options.onNotify?.(
        error instanceof Error ? error.message : String(error),
        'danger',
      );
    }
  }

  private async onPointerCancel(): Promise<void> {
    if (this.flow.stage !== 'recording') return;
    /* 同上：系统抢走按压，指针占用也立刻放开 */
    this.activePointerId = null;
    /*
     * `pointercancel` = 系统把这次按压抢走了（来电、控制中心下拉、系统手势返回）。
     *
     * ★ 这**正是**用户报的那个场景（"使用中来电/闹钟打断后同样要释放"）。
     * 走统一的 `releaseRecording()`，与退后台那条路同一个函数。
     */
    this.releaseRecording('pointer-cancel');
    this.stopWaveLoop();
    this.flow = createVoiceFlow(this.flow.mode);
    this.wave = freezeWaveform(this.wave);
    /*
     * ★ 复位手势基准点，**与 `cancelling` 一起**。
     *
     * `pointercancel` 是"系统把这次按压抢走了"（来电、控制中心下拉、
     * 系统手势返回…）。如果不复位：
     *   · `pressStart` 会留着上一次的坐标，下一次 `pointermove` 会拿
     *     新手指位置与**旧起点**比，算出来的位移毫无意义 ——
     *     可能一按就开始"取消"；
     *   · `cancelling` 会留着上一个值，界面停在「松开 取消」。
     *
     * 这条不是理论上该有：我做完取消功能后跑变异测试，
     * 把"按下时复位 `cancelling`"删掉，**测试全绿** —— 说明所有
     * 出口都复位了。但检查发现 `pointercancel` 这条出口漏了，
     * 那时按下时的复位是唯一兜底。两处都补上。
     */
    this.pressStart = null;
    this.cancelling = false;
    this.syncAll();
  }

  /** 待确认条的「发送」—— 发的是**编辑后的值**（需求 2） */
  private async onConfirmSend(): Promise<void> {
    // 先把当前草稿同步进状态机，再 commit（编辑中取编辑框，否则取草稿）
    this.flow = editDraft(this.flow, this.currentDraftText());

    const result = commitDraft(this.flow);
    this.flow = result.flow;
    this.syncAll();

    if (result.send === null) {
      this.options.onNotify?.('内容为空，没有发送', 'warn');
      return;
    }
    await this.options.onSend(result.send, this.lastDurationMs);
    /* 确认态发送成功 → 同样给提示音 */
    playSendSound();
  }

  /** 「取消」= 本次语音直接作废（用户拍板，需求原文） */
  private onCancel(): void {
    this.flow = cancelDraft(this.flow);
    this.syncAll();
  }

  /* ═══════════════════════════════════════════════════════════
     波形循环（120ms）
     ═══════════════════════════════════════════════════════════ */

  private startWaveLoop(): void {
    const setInt =
      this.options.setInterval ??
      ((fn: () => void, ms: number) => globalThis.setInterval(fn, ms) as unknown as number);

    this.timer = setInt(() => {
      const amplitude = this.recording?.amplitude() ?? 0;
      this.wave = pushAmplitude(this.wave, amplitude);
      this.paintWave();
      /*
       * 计时顺带在这里刷（120ms 一次）。
       *
       * 为什么不另起一个 1 秒定时器：多一个定时器就多一个"dispose 忘了清"
       * 的泄漏点，而本项目已经因为"定时器没清"出过事（`stopWaveLoop` 存在
       * 的唯一理由就是它）。120ms 刷一次文本，肉眼看起来一样，代价可忽略。
       */
      if (this.clockEl !== null && this.recordStartedAt > 0) {
        this.clockEl.textContent = formatRecordClock(Date.now() - this.recordStartedAt);
      }
      // 录音中有声音时给一点触感反馈（有振动 API 才调，没有就跳过）
      if (hasVoiceActivity(this.wave, 0.35)) {
        const nav = (globalThis as { navigator?: { vibrate?: (ms: number) => boolean } }).navigator;
        nav?.vibrate?.(8);
      }
    }, WAVEFORM_REFRESH_MS);
  }

  private stopWaveLoop(): void {
    if (this.timer === null) return;
    const clear =
      this.options.clearInterval ??
      ((id: number) => globalThis.clearInterval(id));
    clear(this.timer);
    this.timer = null;
  }

  /**
   * 把 `barHeights` 画到 DOM 上（2026-11-02：改画**顶部两段波形**）。
   *
   * ## 为什么不画在大圆里了
   *
   * 用户给的图：波形在**顶部一条横线**上（计时两侧各一段），大圆里始终是
   * 麦克风图标。80px 直径里塞一排柱子，真机上看起来是一团糊。
   *
   * ## 两段的取法
   *
   * 左段按时间正序、右段**反序** —— 视觉上是"从中心向两侧扩散"，
   * 与声音进来的方向一致。若两段都正序，看起来像两个不同的东西。
   */
  private paintWave(): void {
    const heights = barHeights(this.wave);

    if (this.flow.stage !== 'recording') {
      /* 冻结态：画待确认条的缩略图（录音已结束，那边才是它的归宿） */
      this.paintThumb();
      return;
    }

    if (this.waveRowEl === null) return;
    const leftBars = findBarsInSide(this.waveRowEl, 'left');
    const rightBars = findBarsInSide(this.waveRowEl, 'right');

    /*
     * 每段取最近 N 个采样：左段正序、右段反序。
     * `heights` 长度 = 32，两段各 16（`renderWaveClock` 里按一半分配）。
     */
    const perSide = Math.max(leftBars.length, rightBars.length);
    const tail = heights.slice(Math.max(0, heights.length - perSide));

    for (let i = 0; i < leftBars.length; i += 1) {
      const level = tail[i] ?? 0;
      leftBars[i]?.setAttribute('data-level', level.toFixed(3));
      leftBars[i]?.setAttribute('style', `--nb-wave-level:${level.toFixed(3)}`);
    }
    for (let i = 0; i < rightBars.length; i += 1) {
      const level = tail[tail.length - 1 - i] ?? 0;
      rightBars[i]?.setAttribute('data-level', level.toFixed(3));
      rightBars[i]?.setAttribute('style', `--nb-wave-level:${level.toFixed(3)}`);
    }
  }

  /** 编辑框里的原始值（只在编辑态有意义） */
  private readEditorValue(): string {
    const node = this.draftEl as unknown as { value?: string } | null;
    return node?.value ?? '';
  }

  /**
   * 语义上的「当前草稿」—— 发送/确认必须用它。
   *
   * 直接读编辑框是错的：编辑框在只读态是隐藏的空壳，其 `value` 恒为空串。
   * 用户「录完 → 不点文字 → 直接点确认」时读编辑框会拿到空，于是报
   * 「内容为空，没有发送」，而屏幕上明明显示着转写文字 —— 最让人恼火的那种。
   */
  private currentDraftText(): string {
    if (this.editingDraft) return this.readEditorValue();
    return this.flow.draft ?? '';
  }

  /* ═══════════════════════════════════════════════════════════
     同步 DOM（唯一的状态 → 视图入口）
     ═══════════════════════════════════════════════════════════ */

  /**
   * 把所有元素同步到当前 flow 状态。
   *
   * 为什么集中在一个函数：分散写会出现"改了 stage 忘了改 chips 的 aria-checked"
   * 这种漏同步，而漏同步的表现是"状态对了但界面看着不对"，最难查。
   */
  private syncAll(): void {
    const recording = this.flow.stage === 'recording';

    /*
     * ★★★ 不变量：`cancelling` 只在**录音中**有意义（2026-11-02）。
     *
     * 「松手就取消」描述的是"现在松手会发生什么" —— 没在录音时这句话
     * 本身没有对象。可它是个普通布尔字段，任何一条异常路径漏复位，
     * 界面就会永久停在「松开 取消」：
     *
     * ```text
     *   {hint: "松开 取消", state: "cancel", rec: "false", canc: "true"}
     *   ⇒ 没在录音，却让用户以为"松手会取消"
     * ```
     *
     * 这种"某个标志该跟主状态一起走"的关系，靠**逐个分支复位**是守不住的
     * （本轮已经为它改了三次：取消分支、releaseRecording、onPointerUp 早退）。
     * 所以把它写成**不变量**，钉在唯一的"状态 → 视图"入口上：只要不在录音，
     * 就归零。任何路径漏了都会被下一次 `syncAll` 自愈。
     *
     * 放在最前面，是因为下面的提示三态、chips 变暗、波形变色都读它 ——
     * 归一必须在读取之前。
     */
    if (!recording) this.cancelling = false;

    // ── chips：按住时浮起；平时也显示（需求 1②「平时显示当前模式」） ──
    if (this.chipsEl !== null) {
      /*
       * ★ 待确认态必须收起 chips。
       *
       * 两者都定位在输入区正上方（`bottom: 100%`），同时显示会**完全重叠** ——
       * 2026-10-30 录屏实测：确认条的波形与 chip 文字压在一起，两边都看不清。
       *
       * 而且从语义上确认态也不该有 chips：那时录音已结束，切模式没有意义
       * （要改模式得先取消这次再重录）。
       */
      const confirming = this.flow.stage === 'confirming';
      this.chipsEl.hidden = confirming;
      this.chipsEl.setAttribute('data-active', String(recording));
      /*
       * 取消态要让**两个档位圆一起变暗**（CSS `.nb-voice-chips-slot
       * [data-cancelling='true']`）。不传的话，上滑取消时只有大圆在缩，
       * 左右两个圆还亮着 —— 看起来像"还能选"，而实际上已经决定不发了。
       */
      this.chipsEl.setAttribute('data-cancelling', String(this.cancelling));
      for (const [mode, chip] of this.chipEls) {
        chip.setAttribute('aria-checked', String(mode === this.flow.mode));
        chip.setAttribute('data-selected', String(mode === this.flow.mode));
      }
    }

    /*
     * ── 输入区形态：keyboard / voice ──
     *
     * 用 `data-voice` 属性让 CSS 管显隐（input / send / mic 与 stage 互斥）。
     * 为什么不在 JS 里逐个设 `hidden`：那要记住"哪些元素属于哪一态"，
     * 加一个元素就要改一次 JS；而属性 + CSS 是声明式的，不会漏。
     */
    if (this.stageRoot !== null) {
      this.stageRoot.setAttribute('data-voice', this.voiceStage);
      /*
       * ★ 把**真实流程阶段**也暴露到 DOM（2026-11-02）。
       *
       * `data-voice` 是"输入区形态"（keyboard/voice），`data-flow-stage` 是
       * "语音流程走到哪一步"（idle/recording/transcribing/confirming）。
       * 两者正交，而提示三态只看 `cancelling` + `recording`：
       *
       * ```text
       *   transcribing / confirming 时 hint 同样显示「按住说话」
       *   ⇒ 外部（含验收脚本、排障的人）会误以为"已经空闲了"
       *   ⇒ 此时按下去不会开始录音（`beginRecording` 要求 idle）
       * ```
       *
       * 我自己的真机脚本就被这一点骗了好几次（`waitIdle` 在转写中返回 true，
       * 下一步 `DOWN` 得到 `not-recording`）。
       *
       * 暴露它的成本是一个属性；收益是"状态可观测"——
       * 用户报"按了没反应"时，看一眼 `data-flow-stage` 就知道卡在哪。
       */
      this.stageRoot.setAttribute('data-flow-stage', this.flow.stage);
    }
    /*
     * chips 自己也要带形态属性（CSS 靠它决定是否显示）。
     *
     * 不能靠 `.nb-composer[data-voice]`：外壳在那个属性上写的是
     * `'true'/'false'`，与这里的 `'voice'/'keyboard'` 值域不同 ——
     * 混用会让 `:not([data-voice='voice'])` 恒真，三个圆被永久隐藏
     * （真机表现：三圆 `getBoundingClientRect` 全零，而 DOM 上属性看着都对）。
     */
    if (this.chipsEl !== null) {
      this.chipsEl.setAttribute('data-voice', this.voiceStage);
    }

    // ── 工具栏小图标：只负责"是否可用"（置灰） ──
    if (this.micEl !== null) {
      const enabled = this.options.asrConfigured && this.options.transport !== undefined;
      this.micEl.setAttribute('data-enabled', String(enabled));
      // 置灰时不许读成"切换到语音输入"—— 要说明为什么不能按
      this.micEl.setAttribute(
        'aria-label',
        enabled ? '切换到语音输入' : '语音识别未配置，点击去配置',
      );
    }

    // ── 大圆按钮：录音态 ──
    if (this.bigmicEl !== null) {
      this.bigmicEl.setAttribute('data-recording', String(recording));
      this.bigmicEl.setAttribute('aria-pressed', String(recording));
      /*
       * `data-cancelling` 让 CSS 把按钮变成"松手就放弃"的样式
       * （变暗、缩一圈）。**不只靠顶部那行字**：手指按住时视线在按钮上，
       * 提示文字在按钮上方 60px 处，很容易完全没注意到。
       */
      this.bigmicEl.setAttribute('data-cancelling', String(this.cancelling));
      /*
       * 录音中**不再**把大圆换成波形柱（2026-11-02 布局改造）。
       *
       * 用户给的图里，波形在**顶部那一条横线**上，大圆里始终是麦克风图标。
       * 原来把波形画进大圆，直径 80px 里塞 32 根柱子，真机上看是"一团糊"，
       * 而且和顶部要新增的那行波形重复。
       */
    }

    /*
     * ── 顶部提示：三态文字 ──
     *
     * ★ 2026-11-02 按用户原话重写：
     * > 按住中间的按钮是提示上滑取消，松开识别为对话
     *
     * 所以：
     *   · 没按住 → 「按住说话」（告诉他怎么开始，不提取消 —— 那时它是废话）
     *   · 按住   → 「上滑取消」（唯一需要教的时机就是"想反悔"的时候）
     *   · 已上滑够 → 「松开 取消」（此刻松手的结果变了，必须立刻说）
     *
     * 三态都在"松手会怎样"这一个问题上作答，不变的是**同一条轴**。
     */
    if (this.hintEl !== null) {
      if (this.cancelling) {
        this.hintEl.textContent = '松开 取消';
        this.hintEl.setAttribute('data-state', 'cancel');
      } else if (recording) {
        this.hintEl.textContent = '上滑取消';
        this.hintEl.setAttribute('data-state', 'recording');
      } else {
        this.hintEl.textContent = '按住说话';
        this.hintEl.setAttribute('data-state', 'idle');
      }
    }

    // ── 录音计时：`0:01`（图片正中那个） ──
    if (this.clockEl !== null) {
      /*
       * 时长来源是 `recordStartedAt` 而不是 `lastDurationMs`
       * （后者只在松手时写一次，录音过程中恒为 0）。
       * 不录音时显示 `0:00` —— 图片里未开始也是 `0:00`。
       */
      const elapsed =
        recording && this.recordStartedAt > 0 ? Date.now() - this.recordStartedAt : 0;
      this.clockEl.textContent = formatRecordClock(elapsed);
      this.clockEl.setAttribute('data-recording', String(recording));
    }

    // ── 顶部波形：只在录音时跳动，空闲时压平 ──
    if (this.waveRowEl !== null) {
      this.waveRowEl.setAttribute('data-recording', String(recording));
      this.waveRowEl.setAttribute('data-cancelling', String(this.cancelling));
    }

    // ── 待确认草稿：只有 confirming 才显示 ──
    if (this.confirmEl !== null) {
      const confirming = this.flow.stage === 'confirming';
      /*
       * 「刚变成 confirming」这一瞬间要通知外壳（滚进视口）。
       *
       * 判据用**状态跃迁**而不是"当前是 confirming"：`syncAll` 每次状态变化
       * 都会跑，用后者的话，录音中每 120ms 一次的波形刷新都会触发一次滚动，
       * 用户想往上翻历史会被一直拽回底部。
       */
      const justShown = confirming && !this.wasConfirming;
      this.wasConfirming = confirming;

      this.confirmEl.hidden = !confirming;
      this.confirmEl.setAttribute('data-stage', this.flow.stage);
      if (confirming) {
        /*
         * 只读视图每次状态变化都重画（它可能被用户编辑过）。
         * 但**编辑中不重画** —— 否则用户正在打字，一改状态就被覆盖。
         */
        if (!this.editingDraft) this.paintDraftText();
        this.paintThumb();
        this.applyBarMetrics();
        if (justShown) this.options.onDraftShown?.();
      } else {
        this.editingDraft = false;
      }
    }
  }

  /**
   * 把状态里的 draft 文本画到只读视图上。
   *
   * 只读态走 markdown 渲染（看起来像消息气泡），编辑态用纯文本 ——
   * 因为编辑对象必须是**已包裹的纯文本**（需求 §6）。
   */
  private paintDraftText(): void {
    if (this.textViewEl === null) return;
    this.textViewEl.innerHTML = renderMessageHtml(this.flow.draft ?? '');
  }

  /**
   * 按录音时长设置音频条宽度与时长文案。
   *
   * 宽度上限 = **可用宽度的一半**（需求原文"最长不要超过屏幕宽度的一半"）。
   * 可用宽度取 composer 的内容宽度，测不到时按 360 兜底（常见手机逻辑宽）。
   */
  private applyBarMetrics(): void {
    if (this.confirmEl === null) return;

    const barbox = findChildByRole(this.confirmEl, 'voice-barbox');
    if (barbox === null) return;

    const host = (this.doc as unknown as { defaultView?: { innerWidth?: number } }).defaultView;
    const available = host?.innerWidth ?? 360;

    const width = voiceBarWidth(this.lastDurationMs, available);
    // 宽度用 CSS 变量传，具体 px 只在这一处算（纯逻辑有测试）
    barbox.setAttribute('style', `--nb-voice-bar-width:${Math.round(width)}px`);

    const dur = findChildByRole(this.confirmEl, 'voice-duration');
    if (dur !== null) dur.textContent = voiceDurationLabel(this.lastDurationMs);
  }

  private paintThumb(): void {
    if (this.waveThumbEl === null) return;
    const heights = barHeights(this.wave);
    // 缩略图只有 12 根，从 32 根里均匀取样
    const step = Math.max(1, Math.floor(heights.length / 12));
    const bars = findBars(this.waveThumbEl);
    for (let i = 0; i < bars.length; i += 1) {
      const level = heights[Math.min(heights.length - 1, i * step)] ?? 0;
      bars[i]?.setAttribute('style', `--nb-wave-level:${level.toFixed(3)}`);
    }
  }

  /* ── 滑动：滑到左右圆上切档、上滑取消（pointermove 时由外部调用） ── */

  /**
   * 处理录音中的滑动（2026-11-02 改为**命中圆按钮**判定）。
   *
   * ```text
   *   (内心/动作)      ( 🎤 )      (消息)
   *        ↑             ↑            ↑
   *     左滑落到这里   按住起点    右滑落到这里
   *
   *                上滑 64px ⇒ 取消
   * ```
   *
   * ## ★ 为什么从"横向位移阈值"改成"落在哪个圆上"
   *
   * 之前判的是 `dx <= -56` ⇒ 内心、`dx >= 56` ⇒ 消息。位移判定看不见按钮
   * 在哪：用户明明滑到了左边那个圆上，但只要位移差几像素就不生效；
   * 反过来，他滑到空白处却因为"位移够 56"而切了档。
   *
   * 用户这次的描述非常明确 —— **"按住并滑到这个按钮上使用"**。
   * 所以判据必须是"手指落点是否在这个圆的矩形里"，与视觉完全一致：
   * 圆在哪，判定区就在哪（再向外扩一圈 `DEFAULT_HIT_SLOP`，因为拇指
   * 落点分布有 8–12mm 误差）。
   *
   * ## 三条判定的顺序（有语义，不是随手排的）
   *
   * 1. **上滑取消优先**：取消是"这次别发了"，比"发成什么类型"更重要。
   *    一旦成立就不再理会落在哪个圆上（否则手指掠过圆时档位会跳）。
   * 2. **落在左/右圆上** ⇒ 切到对应档位。
   * 3. **没落在任何一个圆上** ⇒ 保持「说话」。
   *
   * 第 3 条为什么回落到说话而不是保持上一次：用户按住中间开始说、手抖了一下
   * 划出圆外，此时他仍是在"对着中间那个按钮说话"。保持「说话」是唯一的
   * 安全默认（发成说话还能撤回，发成内心独白他会以为没发出去）。
   */
  handlePointerMove(clientX: number, clientY: number): void {
    if (this.flow.stage !== 'recording') return;

    const point = { x: clientX, y: clientY };

    // ── ① 上滑取消 ──
    if (this.pressStart !== null) {
      const cancelling = isCancelSlide(this.pressStart, point);
      if (cancelling !== this.cancelling) {
        this.cancelling = cancelling;
        // 状态变了才同步：pointermove 每秒几十次，每次都 syncAll 会白刷 DOM
        this.syncAll();
      }
      if (cancelling) return; // 已确定取消，不再关心落在哪个圆上
    }

    // ── ② 落在左/右圆上 ⇒ 切档 ──
    const mode = this.modeUnderPoint(point) ?? DEFAULT_VOICE_MODE;
    if (mode === this.pendingMode) return; // 没变就不刷 DOM
    this.pendingMode = mode;
    this.flow = setFlowMode(this.flow, mode);
    this.syncAll();
  }

  /**
   * 读三个圆的当前矩形，判这个点落在哪个档位上；**没命中返回 null**。
   *
   * ## 为什么每次都重新 `getBoundingClientRect()`
   *
   * 不能缓存：录音开始时布局可能刚变（提示文字从"按住说话"变成"上滑取消"、
   * 波形从静态变成跳动），圆的位置会跟着动几像素。缓存的矩形会让
   * "看起来滑到了、判定说没到"。
   *
   * `getBoundingClientRect` 每次调用都要强制 layout —— 但 pointermove
   * 每秒几十次、只有三个元素，代价可以忽略；而**判错**的代价是发错类型。
   *
   * ## 为什么读不到矩形时返回 null（而不是抛）
   *
   * 单测与 demo 的 DOM stub 没有 `getBoundingClientRect`。返回 null 后
   * 上层回落到「说话」—— 那条路径是安全的，且测试可以用
   * `handlePointerMove` 之外的入口验手势判定（纯函数 `hitTestVoiceChip`
   * 有独立判据）。
   */
  private modeUnderPoint(point: { x: number; y: number }): VoiceMode | null {
    const rects: { mode: VoiceMode; x: number; y: number; width: number; height: number }[] = [];
    for (const [mode, chip] of this.chipEls) {
      const box = readRect(chip);
      if (box !== null) rects.push({ mode, ...box });
    }
    if (rects.length === 0) return null;
    return hitTestVoiceChip(point, rects);
  }

  /** 给测试与外部：当前状态快照 */
  snapshot(): { flow: VoiceFlow; wave: WaveformState } {
    return { flow: this.flow, wave: this.wave };
  }

  /** 更新配置（设置页改完后调用，不必重建面板） */
  updateConfig(patch: { asrConfigured?: boolean; confirmBeforeSend?: boolean }): void {
    if (patch.asrConfigured !== undefined) this.options.asrConfigured = patch.asrConfigured;
    if (patch.confirmBeforeSend !== undefined) {
      this.options.confirmBeforeSend = patch.confirmBeforeSend;
    }
    this.syncAll();
  }
}

/* ── 小工具：按 side 找某一段的波形柱 ── */

/**
 * 取顶部波形某一段（`data-side=left|right`）里的柱子。
 *
 * 两段是**两个独立容器**，所以要先按 side 找到容器再在容器内找柱 ——
 * 直接在整行里找会把两边混在一起，长度对不上就会有一半柱子不动。
 */
function findBarsInSide(root: ElLike, side: 'left' | 'right'): ElLike[] {
  const findSide = (node: ElLike): ElLike | null => {
    if (node.getAttribute?.('data-side') === side) return node;
    for (const child of node.children) {
      const found = findSide(child);
      if (found !== null) return found;
    }
    return null;
  };
  const container = findSide(root);
  return container === null ? [] : findBars(container);
}

/* ── 小工具：读元素矩形 ── */

/**
 * 读元素当前的屏幕矩形；读不到返回 `null`。
 *
 * 单测 / demo 的 DOM stub 没有 `getBoundingClientRect`，所以这里必须容忍
 * 它缺失 —— 不能因为"测不了"就抛，那样整条手势路径在测试里都跑不起来。
 */
function readRect(
  node: ElLike,
): { x: number; y: number; width: number; height: number } | null {
  const like = node as unknown as {
    getBoundingClientRect?: () => { left: number; top: number; width: number; height: number };
  };
  if (typeof like.getBoundingClientRect !== 'function') return null;
  const box = like.getBoundingClientRect();
  if (
    typeof box.left !== 'number' ||
    typeof box.top !== 'number' ||
    typeof box.width !== 'number' ||
    typeof box.height !== 'number'
  ) {
    return null;
  }
  return { x: box.left, y: box.top, width: box.width, height: box.height };
}

/* ── 小工具：麦克风图标 ── */

/**
 * 内联麦克风 SVG（白色线稿，`currentColor` 跟随状态）。
 *
 * ## 为什么不用 emoji `🎤`
 *
 * 真机截图里那个 emoji 明显偏小、还带彩色底色，与图片要求的
 * "白色实心线稿 + 蓝色圆"不是一回事；而且 emoji 在不同 Android 版本上
 * 外形差异很大（同一份代码在三台机器上是三个样子）。
 *
 * 内联 SVG 只受 CSS 控制，颜色/尺寸都可预期。
 *
 * ## ★★★ 2026-11-05：`mic-slot` 那个入口也换成这个（用户第二次说 emoji 不好看）
 *
 * > 我想把进入语言面板的这个图标换成附件这种简笔画的风格，emoji 的不好看
 *
 * 讽刺的是**上面那段注释就是为同一个论点写的** —— 它已经解释了为什么
 * 不该用 emoji，但当时只把大圆按钮（`bigmic`）换成了 SVG，
 * 输入框旁边这个**入口**（`mic-slot`）还是 `🎤`。
 *
 * 同一件事两处实现，改一处忘另一处 —— 这是本项目反复出现的形状
 * （`fieldRow` 两份、`.nb-drawer` 与 `.nb-acc-panel` 两套…）。
 *
 * 所以现在两处共用这一个函数，只差 `size`：
 *
 * ```text
 *   bigmic    30px   语音面板里那个大圆按钮
 *   mic-slot  22px   输入框左边的入口（48×48 的按钮里，留出内边距）
 * ```
 *
 * ★ 换成 currentColor 线稿后，**颜色必须跟着改**：emoji 不吃 `color`，
 * 而 SVG 吃。`.nb-mic-slot` 原来写的是 `--nb-text-3`（#6e6885，很暗），
 * emoji 时代看不出问题，换成线稿就会糊在底色里。见 `chat.css` 那一条。
 */
function makeMicIcon(doc: DocLike, size = 30): ElLike {
  /*
   * 用 `<svg>` 而不是 `innerHTML` —— 渲染层禁止写 innerHTML（XSS 面，
   * `validate:client` 的硬约束）。所以这里走 `createElementNS`。
   */
  const svg = doc.createElementNS?.('http://www.w3.org/2000/svg', 'svg');
  if (svg === undefined || svg === null) {
    /* 测试 stub 没有 createElementNS：退化成一个字形，保证不吃掉按钮 */
    const fallback = doc.createElement('span');
    fallback.textContent = '🎙';
    return fallback;
  }
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  /*
   * 描边宽度跟着尺寸走：小图标用 2 会显得糊成一团（22px 时那条线占近 1/10）。
   * 22px 用 1.9 —— 比 2 细一点，但还没细到在低 DPI 屏上断线。
   */
  svg.setAttribute('stroke-width', size >= 28 ? '2' : '1.9');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  /*
   * 类名两处共用（不再叫 `nb-bigmic-icon`）：叫 bigmic 会让人以为
   * 只有大按钮用它，下一个要加图标的地方又会自己写一份。
   */
  svg.setAttribute('class', 'nb-mic-icon');

  /* 话筒主体：圆角矩形 */
  const capsule = doc.createElementNS?.('http://www.w3.org/2000/svg', 'rect');
  capsule?.setAttribute('x', '9');
  capsule?.setAttribute('y', '2');
  capsule?.setAttribute('width', '6');
  capsule?.setAttribute('height', '11');
  capsule?.setAttribute('rx', '3');
  /* 支架：U 形 + 竖杆 */
  const stand = doc.createElementNS?.('http://www.w3.org/2000/svg', 'path');
  stand?.setAttribute('d', 'M5 10v1a7 7 0 0 0 14 0v-1M12 18v3');
  svg.append(capsule ?? doc.createElement('span'), stand ?? doc.createElement('span'));
  return svg;
}

/* ── 小工具：找波形柱 ── */

function findBars(root: ElLike): ElLike[] {
  const bars: ElLike[] = [];
  const walk = (node: ElLike): void => {
    if (
      node.className.includes('nb-bigmic-bar') ||
      node.className.includes('nb-voice-wave-bar')
    ) {
      bars.push(node);
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return bars;
}

/* ── 小工具：按角色找后代元素 ── */

function findChildByRole(root: ElLike, role: string): ElLike | null {
  for (const child of root.children) {
    if (child.getAttribute('data-role') === role) return child;
    const nested = findChildByRole(child, role);
    if (nested !== null) return nested;
  }
  return null;
}
