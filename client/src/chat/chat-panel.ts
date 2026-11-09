/**
 * 聊天页面板（v0.1.7 / T15.5）。
 *
 * ## 职责边界
 *
 * 本文件只做「把纯逻辑接到真实 DOM 与事件上」：
 *   · 手势 → `shared/src/chat/gesture.ts` 的判定
 *   · 流式 → `st-bridge.ts` + `shared/src/chat/stream.ts` 的状态机
 *   · 渲染 → `chat-view.ts` 的纯函数
 *   · 数据 → `shared` 的 `assembleContext` / `buildContinueInput` / `parseChatResponse`
 *
 * 因此这里**不含任何业务判断**。看到 `if (xxx === 'ok')` 这种就该警觉：
 * 那类判据属于 `shared`，放这里就没法单测了。
 *
 * ## 手势怎么接（契约 §8.2）
 *
 * 判定本身是纯函数，这里只负责三件事：
 *   1. `touchstart` 记起手点，并判断是否落在气泡上；
 *   2. `touchmove` 收集轨迹点（**不判定**，避免一次滑动切过好几个候选）；
 *   3. `touchend` 调 `resolveTrace` 一次性结算。
 *
 * 第 2 条是重点：边滑边判会让"左滑一次"连续切过 3 个候选，
 * 用户看到的是文字"嗖"地跳到最后一个。
 */

import {
  applyStreamEvent,
  assembleContext,
  assembleWithPrompts,
  applyTokenBudget,
  computeBudget,
  estimateTokens,
  type ParsedPromptConfig,
  appendSwipe,
  buildContinueInput,
  buildOpeningMessages,
  buildGenerateRequest,
  canSaveOverEmpty,
  classifyGesture,
  createStreamState,
  currentSwipeIndex,
  describeBridgeError,
  explainGenerateError,
  finalizeOutput,
  isBusy,
  parseChatResponse,
  popLastAssistant,
  renderMessageHtml,
  requestStop,
  resolveTrace,
  setVoiceFlag,
  shouldFollowStream,
  shouldStick,
  showsCaret,
  startStreaming,
  swipeNext,
  swipePrev,
  swipeCount,
  type GesturePoint,
  type StChatMessage,
  type StChatSource,
  type StreamState,
  type VoiceMode,
  isVoiceMsg,
  type AuthorNoteConfig,
  type ParamFamily,
  type SamplingParams,
} from '@tcs/shared';

import { openBubbleMenu, type BubbleMenuHandle } from './bubble-menu.ts';
import { StChatBridge, type GenerateHandle } from './st-bridge.ts';
import { VoicePanel, type VoiceTransport } from './voice-panel.ts';
/*
 * 思考模式的值 → 采样参数的合并（2026-11-07）。
 *
 * 那个函数住在 `reasoning-section.ts`（UI 组件文件）。放那里是因为
 * 它就是个**纯数据搬运**，不依赖任何 UI 类型 —— 而 `chat-panel` 与它
 * 已经在同一个目录，引入不会形成环（section → chat-view / select-popover，
 * 都不反向依赖 chat-panel）。
 */
import { mergeReasoningSampling } from './reasoning-section.ts';
import {
  el,
  renderEmptyState,
  renderMessageList,
  renderVoiceMounts,
  VOICE_MOUNTS,
  type DocLike,
  type ElLike,
} from './chat-view.ts';

/**
 * 语音配置（T15.6）。
 *
 * 与 `ChatPanelContext` 分开是因为它们**作用域不同**：
 * 聊天后端（provider/model）与语音识别（ASR 厂商/key）必须隔离，
 * 混在一个对象里迟早会出现"改 ASR key 顺手覆盖了聊天配置"。
 * 这条隔离有 `config-scopes` 的抛错机制守着，本层只是照着分。
 */
export interface VoicePanelConfig {
  /** ASR 是否可用。false → 麦克风置灰、点击跳配置页 */
  asrConfigured: boolean;
  /** 「发送前需确认」开关（默认 false，见决策 C5） */
  confirmBeforeSend: boolean;
  /** 上次用的模式（冷启动用默认 speak） */
  lastMode?: VoiceMode;
}

/** 面板启动时注入的语音能力 */
export interface VoicePanelBootstrap {
  asrConfigured?: boolean;
  confirmBeforeSend?: boolean;
  lastMode?: VoiceMode;
  transport?: VoiceTransport;
}

export interface ChatPanelCallbacks {
  /** 需要打开「API 连接」页时调用（未配置后端时引导） */
  onNeedApiConfig?: () => void;
  /** 需要打开「语音输入」配置页时调用（未配置 ASR 时引导） */
  onNeedAsrConfig?: () => void;
  /** 需要选角色时调用（返回 null = 取消） */
  onPickCharacter?: () => Promise<{ avatar: string; name: string } | null>;
  /** 需要选聊天时调用（返回 null = 取消） */
  onPickChat?: (avatar: string) => Promise<{ fileName: string } | null>;
  /**
   * 需要打开「聊天设置」时调用（2026-10-31 第三批：顶栏设置按钮）。
   *
   * 不传就**不渲染设置按钮** —— 而不是渲染一个点了没反应的按钮。
   * 那种按钮比没有更糟：用户会以为是坏了。
   */
  onOpenChatSettings?: () => void;
  /**
   * 消息内容发生**需要落库**的变化时调用（第八批问题二）。
   *
   * ## 为什么由面板通知，而不是外壳轮询
   *
   * "什么时候该存"只有面板知道：它知道流式还在跑、知道刚才那帧只是中间态、
   * 知道生成失败退了回去。外壳只能看到最终 `messages`，
   * 轮询要么存太勤（流式每帧一次），要么存太晚（切 Tab 才存，那时已经丢了）。
   *
   * ## 只在两个点触发
   *
   * 1. 用户消息插入之后（用户期望"发出去了就不丢"）
   * 2. 一次生成真正结束之后（成功或失败，只要有新增/删除）
   *
   * **流式中间帧不触发** —— 一秒钟十几次整份覆盖写盘，既慢又危险。
   */
  onChatChanged?: (messages: StChatMessage[]) => void;
  /** 状态栏提示 */
  onNotify?: (message: string, kind?: 'info' | 'ok' | 'warn' | 'danger') => void;
  /**
   * 请求切换「当前聊天的用户人设」（2026-11-06）。
   *
   * ## 用户的原话
   *
   * > 找个地方加一个可以方便切换当前聊天的人设的东西
   *
   * 关键在"方便"：原来只有「卡片 → 用户设定管理」一条路，进那里是**管理**，
   * 而聊天时想换"我是谁"需要的是**一句话切换**，不该离开聊天页。
   *
   * 所以入口放在顶栏（常驻、一眼可见），点一下弹下拉，选完即生效。
   *
   * ## 为什么参数是 `anchor`
   *
   * 下拉面板要贴着触发按钮展开（`openSelectPopover` 需要锚点元素）。
   * 面板本身由外壳画 —— 人设列表、持久化、上下文推送都是外壳的知识，
   * 面板（`ChatPanel`）不该知道这些。它只负责"报告用户点了这里"。
   *
   * 不传就不渲染这个入口（与 `onOpenChatSettings` 同一条纪律）。
   */
  onSwitchPersona?: (anchor: unknown) => void;
}

/** 面板需要的外部数据（由外壳传入，面板自己不读配置） */
export interface ChatPanelContext {
  /** 卡片（用于上下文拼装的世界书与字段） */
  card: Record<string, unknown>;
  /** 用户人设 */
  userName: string;
  /**
   * 当前人设的**显示标签**（顶栏那个可点的小胶囊用）。
   *
   * 与 `userName` 分开：`userName` 是拼进 prompt 的值（`{{user}}` 替换），
   * 而这里是给人看的一段文字。没选人设时外壳会传空串，此时胶囊显示
   * `userName` 的值（那是默认名），用户仍看得到自己是谁。
   */
  personaLabel?: string;
  /**
   * 人设那一栏能不能点开切换。
   *
   * 只有外壳提供 `callbacks.onSwitchPersona` 时才为 true —— 不做"点了
   * 没反应的胶囊"（同 `onOpenChatSettings` 的纪律）。
   */
  personaSwitchable?: boolean;
  /** 后端源（六选一），来自 API 连接页 */
  source: StChatSource;
  model: string;
  /**
   * 采样参数（随请求体带 —— 服务端不读设置）。
   *
   * ★ 2026-11-03 放宽：加了 `string`。
   *
   * 原来只允许 `number | number[] | string[]`，因为采样参数"全是数字"。
   * 补上「推理强度」「长度」两项之后它们是**字符串枚举**
   * （`medium` / `low` …），旧的签名会让正确代码编译不过 ——
   * 而最容易的"修法"是把它们丢掉，那就变成静默失效了。
   */
  sampling: Record<string, number | string | number[] | string[]>;
  /**
   * 思考模式（2026-11-07，P0 第三步）。
   *
   * 与 `sampling` 分开：`sampling` 是"从 ST 设置读来的采样参数"，
   * 而思考意图是**本 App 自己的偏好**（ST 里没有这个概念）。
   * 混进去会让 `seedSampling()` 的同步逻辑把它当成 ST 字段来回覆盖。
   */
  thinking?: { intent: 'auto' | 'off' | 'on'; budget?: number | string; family?: ParamFamily };
  /**
   * 自定义服务地址（只对 `source === 'custom'` 有意义）。
   *
   * 随请求体作为 `custom_url` 发出去（契约 §3.2）。服务端不读设置，
   * 所以地址也必须每次带 —— 与采样参数同一个道理。
   */
  baseUrl?: string;
  /**
   * ST 的「提示词管理器」配置（2026-11-03）。
   *
   * 由外壳从**当前预设**里解析出来（`parsePromptConfig`），面板只消费不解析。
   *
   * ## 为什么不在这里自己读
   *
   * 解析要拿"当前是哪个预设、预设体是什么"，那是外壳的活；
   * 面板只管"给我配置，我按它拼"。这样面板可以被单测直接喂配置，
   * 不用起一整套设置读取。
   *
   * ## `undefined` / `null` 的语义
   *
   * 都没有 = "没有提示词配置"。此时**自动回退**到旧的固定拼装 ——
   * 没有配置时聊天必须照常能用，不能因为读不到就发空上下文。
   */
  promptConfig?: ParsedPromptConfig | null;
  /**
   * 作者注释配置（2026-11-03，第二十七批）。
   *
   * 来源是 ST 的 `extension_settings.note`（`default` / `defaultDepth` /
   * `defaultInterval` / `defaultRole`）。外壳读出来后整份传进来，
   * "这一轮要不要插"由 `assembleWithPrompts` 按 ST 的规则判。
   *
   * 不传 = 不用作者注释。
   */
  authorNote?: AuthorNoteConfig;
  /**
   * 当前生效的用户设定（2026-11-04 第三十批）。
   *
   * 与 `userName` 分开：`userName` 只负责 `{{user}}` 替换，
   * 这里还带描述、插入位置、身份。两者一起推（见 `syncPersonaToChat`）。
   */
  persona?: {
    name?: string;
    description?: string;
    position?: 'in_prompt' | 'top_an' | 'bottom_an' | 'at_depth' | 'none';
    depth?: number;
    role?: 'system' | 'user' | 'assistant';
  };
  /**
   * 提示词配置里那些"包装格式"与分隔提示（都来自用户的预设，不是我们写死的）。
   *
   * `scenarioFormat` / `personalityFormat` / `wiFormat` 是 ST 的格式串
   * （`{}` 为占位）；`newExampleChatPrompt` 是示例分隔提示。
   */
  promptFormats?: {
    scenarioFormat?: string;
    personalityFormat?: string;
    wiFormat?: string;
    newExampleChatPrompt?: string;
  };
  /**
   * 上下文窗口上限（ST 的 `openai_max_context`）。
   *
   * 与 `responseLimit` 一起决定 token 预算：
   * `预算 = contextLimit - responseLimit`（与 ST 的 `setTokenBudget` 一致）。
   *
   * 缺省（`undefined` / 0）时**不裁** —— 宁可超一点，也不要把上下文裁空
   * （裁空了模型完全不知道在演谁，比报错更难查）。
   */
  contextLimit?: number;
  /** 留给回复的额度（ST 的 `openai_max_tokens`） */
  responseLimit?: number;
}

export class ChatPanel {
  private readonly doc: DocLike;
  private readonly bridge = new StChatBridge();

  /**
   * 上一次算出的 token 总数（给界面显示"本次 N token"）。
   *
   * 存在面板上而不是临时变量：界面要在生成结束、消息重绘之后
   * 仍然显示这个数字（截图里那个「总 Token 数量」就是这个意思）。
   */
  private lastTokenUsage: { used: number; budget: number; trimmed: number } | null = null;

  /**
   * token 计数缓存。
   *
   * 同一段文本在一次会话里会被数很多遍（用户反复重新生成、切换卡片再切回来）。
   * 真实分词要走一次 HTTP 往返 —— 不缓存的话每条消息都要等，
   * 而"发消息前先卡 300ms"是很明显的体验下降。
   *
   * 键用「模型 + 文本长度 + 前 64 字 + 后 64 字」而不是整段文本：
   * 整段文本当键会让缓存键极长（几百条 × 几千字），内存不划算；
   * 而首尾各 64 字 + 长度已经足够区分（碰撞的概率远低于"数错"的影响）。
   */
  private readonly tokenCache = new Map<string, number>();

  /** 缓存上限 —— 超过就整份清掉（比做 LRU 简单，且这里不需要精细） */
  private static readonly TOKEN_CACHE_LIMIT = 512;
  private readonly callbacks: ChatPanelCallbacks;

  private root: ElLike | null = null;
  private listEl: ElLike | null = null;
  private inputEl: ElLike | null = null;
  private sendEl: ElLike | null = null;

  private messages: StChatMessage[] = [];
  private avatar: string | null = null;
  private fileName: string | null = null;
  /**
   * 当前选中的**角色显示名**（2026-11-01 第七批问题一）。
   *
   * ## 为什么必须有这个字段
   *
   * 副标题原来只有 `fileName` 一个数据源。而"刚选完角色、还没开始聊"时
   * `fileName` 必然是 `null`（聊天文件要等第一次发送才落盘）——
   * 于是顶栏只能显示「未选择聊天」，尽管用户明明已经选了角色。
   *
   * 真机上的表现是：选完角色，消息区都在（说明 avatar 生效了），
   * 顶栏却还说没选 —— **状态对、显示不对**，和 2026-10-31 那次同一个形状。
   *
   * ## 为什么不把角色名写进 `fileName`
   *
   * 因为两者语义不同：`fileName` 是"这份聊天记录叫什么"（`西奥 · 雨夜留宿`），
   * 角色名是"在跟谁聊"（`西奥`）。写进同一个字段的后果是：
   * 第一次发送落盘后要拿真实文件名覆盖它，而那时已经分不清哪个是哪个了。
   */
  private characterName: string | null = null;
  private stream: StreamState = createStreamState();
  private handle: GenerateHandle | null = null;
  /**
   * 是否显示完整思考链（2026-11-05 用户要求）。
   *
   * 由外壳注入、可在运行中改（`setShowReasoning`）。
   */
  private showReasoning = false;
  /** 重新生成按钮（`syncSendButton` 里跟着生成状态置灰） */
  private regenEl: ElLike | null = null;
  private ctx: ChatPanelContext;
  /** T15.6 语音面板。null = 还没 mount（或已 dispose） */
  private voicePanel: VoicePanel | null = null;
  /** 语音配置（由外壳注入，面板不自己读配置） */
  private voiceConfig: VoicePanelConfig;
  /** 待确认草稿卡片（挂在消息列表末尾） */
  private draftCardEl: ElLike | null = null;
  /** 录音+转写能力。undefined = 未配置/不可用（麦克风置灰） */
  private voiceTransport: VoiceTransport | undefined;

  /** 手势轨迹（只在一次触摸内有效） */
  private trace: GesturePoint[] = [];
  private startedInBubble = false;
  /**
   * 顶栏副标题（当前聊天名）。
   *
   * 必须是成员：`avatar` / `fileName` 会在 `loadChat` / `newChat` / `setMessages`
   * 里变，而副标题是它们唯一的显示位置。存成局部变量就只能写一次。
   */
  private subEl: ElLike | null = null;

  /**
   * 顶栏那个人设胶囊（2026-11-06）。
   *
   * 存成员是为了切换人设后能**就地改文字**：`renderChat()` 会重建整个面板，
   * 但切换人设不该顺带把聊天记录重新拉一遍（正在流的消息会断）。
   */
  private personaChipEl: ElLike | null = null;

  /**
   * 人设胶囊显示什么。
   *
   * 优先用外壳给的 `personaLabel`（选中的那套人设名）；没选人设时退回
   * `userName`（默认名）—— 那仍是"你在这段对话里叫什么"，对用户有意义。
   * 两者都空就不显示胶囊（不画一个空壳）。
   */
  private personaLabelText(): string {
    const label = this.ctx.personaLabel ?? '';
    if (label.trim() !== '') return label.trim();
    const name = this.ctx.userName ?? '';
    return name.trim();
  }

  /**
   * 切换人设后更新胶囊文字（外壳在 `selectPersona` 之后调）。
   *
   * 为什么不走 `renderPage()`：那只重建外层容器，`ChatPanel` 实例还在，
   * 里面正在流式输出的消息会丢。改一行文字是这里唯一该做的事。
   *
   * ★★★ 这里**不能再写 `chip.textContent`**（2026-11-07 修）。
   *
   * 胶囊现在是"图标 / 文字 / 箭头"三个子元素（见顶栏那段注释：
   * `▾` 混在文本里会被省略号吃掉）。用 `textContent = '…'` 赋值
   * 会把三个子元素**整个替换成一个文本节点** —— 于是刚刚修好的
   * 截断问题在"切一次人设之后"又回来了，而且更隐蔽：
   * 首次进页面正常、切一次人设就坏。
   *
   * 正确做法：只改中间那个文字节点的内容。
   */
  syncPersonaChip(label: string): void {
    const chip = this.personaChipEl;
    if (chip === null) return;
    const text = label.trim() === '' ? this.ctx.userName : label.trim();

    /*
     * 找到文字节点。找不到（老结构 / 被外部改过）就退回到整体重建 ——
     * 宁可重建也不要静默不更新（那样的表现是"切了人设名字没变"）。
     */
    const textEl = this.findPersonaTextNode(chip);
    if (textEl !== null) {
      textEl.textContent = text;
    } else {
      chip.textContent = text;
    }

    /* 文字清空时把整个胶囊隐掉，别留一个空框 */
    chip.setAttribute('data-empty', String(text === ''));
    chip.setAttribute(
      'aria-label',
      this.callbacks.onSwitchPersona === undefined
        ? `当前人设：${text}`
        : `切换当前聊天的人设（当前：${text}）`,
    );
  }

  /** 在胶囊的子元素里找那个负责显示名字的 span */
  private findPersonaTextNode(chip: ElLike): ElLike | null {
    for (const child of Array.from(chip.children)) {
      if (child.getAttribute('data-role') === 'persona-chip-text') return child;
    }
    return null;
  }

  constructor(
    doc: DocLike,
    ctx: ChatPanelContext,
    callbacks: ChatPanelCallbacks = {},
    voice: VoicePanelBootstrap = {},
  ) {
    this.doc = doc;
    this.ctx = ctx;
    this.callbacks = callbacks;
    this.voiceConfig = {
      asrConfigured: voice.asrConfigured ?? false,
      confirmBeforeSend: voice.confirmBeforeSend ?? false,
      lastMode: voice.lastMode,
    };
    this.voiceTransport = voice.transport;
  }

  /** 设置页改完后调用：立刻生效，不必重建面板 */
  /**
   * 改「显示完整思考链」（2026-11-05 用户要求）。
   *
   * 为什么要有这个入口而不是构造时传死值：用户可能**正在聊天**
   * 去设置页翻开关，回来继续生成就该按新值渲染。传死值要重建面板，
   * 那会把当前对话的滚动位置与流式状态一起丢掉。
   */
  setShowReasoning(next: boolean): void {
    this.showReasoning = next;
  }

  /**
   * 更新思考模式（2026-11-07，P0 第三步）。
   *
   * 由设置页的「思考」区块触发。**只改 ctx**，不重绘面板 ——
   * 重绘会清掉正在编辑的消息、抢走焦点。
   * 下一次 `send()` 会从 ctx 读到新值。
   */
  setThinking(intent: 'auto' | 'off' | 'on', budget?: number | string, family?: ParamFamily): void {
    this.ctx = {
      ...this.ctx,
      thinking: {
        intent,
        ...(budget === undefined ? {} : { budget }),
        ...(family === undefined ? {} : { family }),
      },
    };
  }

  updateVoiceConfig(patch: Partial<VoicePanelConfig>): void {
    this.voiceConfig = { ...this.voiceConfig, ...patch };
    this.voicePanel?.updateConfig({
      asrConfigured: this.voiceConfig.asrConfigured,
      confirmBeforeSend: this.voiceConfig.confirmBeforeSend,
    });
  }

  /** 换掉录音/转写实现（配置好 ASR 之后接真实现） */
  setVoiceTransport(transport: VoiceTransport | undefined): void {
    this.voiceTransport = transport;
    this.voicePanel?.updateConfig({ asrConfigured: transport !== undefined });
  }

  /** 更新配置（API 连接页保存后调用） */
  setContext(patch: Partial<ChatPanelContext>): void {
    this.ctx = { ...this.ctx, ...patch };
  }

  /**
   * 顶栏副标题跟随 `fileName`（唯一入口）。
   *
   * 凡是改 `this.fileName` 的地方都要调它 —— 这是"同一件事有两个表示
   * （状态字段 + DOM 文本）"时必须显式同步的典型场合：不调不报错，
   * 只是显示停在旧值，而且**只在真的看一眼顶栏时才发现**。
   *
   * 文案不加"聊天记录"之类的补充：`fileName` 本身就是用户选的那个名字
   * （ST 的聊天文件名，通常就是"角色名 · 时间"）。
   */
  private syncSubtitle(): void {
    if (this.subEl === null) return;
    this.subEl.textContent = this.subtitleText();
  }

  /**
   * 副标题的**唯一**文案来源（渲染期与更新期都调它）。
   *
   * 优先级：**聊天文件名 > 角色名 > 「未选择聊天」**。
   *
   * | 状态 | 显示 | 为什么 |
   * |---|---|---|
   * | 有聊天记录 | `西奥 · 雨夜留宿` | 比角色名更具体，能区分同一角色的不同存档 |
   * | 选了角色、还没聊 | `西奥` | 用户已经选了，说"未选择"是撒谎 |
   * | 什么都没选 | `未选择聊天` | 给一句明白话，不是空白 |
   *
   * 单独抽出这个函数而不是在两处各写一遍三元表达式：
   * 两处的优先级一旦分叉，就会出现"刚进页面显示角色名、
   * 发完一条消息变回未选择"这种只在特定顺序下才出现的问题。
   */
  private subtitleText(): string {
    if (this.fileName !== null && this.fileName.trim() !== '') return this.fileName;
    if (this.characterName !== null && this.characterName.trim() !== '') return this.characterName;
    return '未选择聊天';
  }

  /** 挂载到容器。返回根元素便于测试。 */
  mount(container: ElLike): ElLike {
    const root = el(this.doc, 'div', 'nb-chat');
    root.setAttribute('data-role', 'chat-panel');

    // 顶部栏（玻璃 1/3）
    const topbar = el(this.doc, 'div', 'nb-topbar');
    const title = el(this.doc, 'h1', 'nb-topbar-title');
    title.textContent = this.avatar === null ? '聊天' : '聊天';
    /*
     * 副标题行：**文件名 + 人设胶囊**（2026-11-06 加胶囊）。
     *
     * 为什么塞进副标题行而不是再加一个图标按钮：
     * 顶栏已经有 ☰ 和齿轮两个 40px 按钮，再加一个会把标题挤成一条缝。
     * 副标题这一行本来就只放一行小字，横向还有余量，而且是"当前上下文"
     * 那类信息 —— 人设正是其中之一（谁在跟谁聊）。
     */
    const subRow = el(this.doc, 'div', 'nb-topbar-subrow');
    const sub = el(this.doc, 'span', 'nb-topbar-sub');
    sub.setAttribute('data-role', 'chat-subtitle');
    sub.textContent = this.subtitleText();
    subRow.append(sub);

    /*
     * 人设胶囊。
     *
     * 只有外壳给了 `onSwitchPersona` 才做**按钮**，否则做纯文字 ——
     * 点了没反应的胶囊比不显示更糟（用户会以为功能坏了）。
     */
    const personaText = this.personaLabelText();
    if (personaText !== '') {
      /*
       * ★★★ 图标 / 文字 / 箭头必须是**三个独立元素**（2026-11-07 修）。
       *
       * 原来是一整段文本：`chip.textContent = \`👤 ${personaText} ▾\``。
       * 问题是胶囊有 `max-width: 42%` + `overflow: hidden` +
       * `text-overflow: ellipsis` —— 文字一长就整体截断，
       * **`▾` 跟着被吃掉或只露一半**。
       *
       * 用户截图里看到的就是这个：胶囊内文字后面叠着半个图形，
       * 他描述为"文字显示不清楚"。
       *
       * 拆开之后：图标与箭头 `flex-shrink: 0`（永远完整），
       * 只有中间的文字可以省略 —— 这才是"能读、有箭头"。
       */
      const makeChipContent = (host: ElLike, withCaret: boolean): void => {
        const icon = el(this.doc, 'span', 'nb-persona-chip-icon');
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = '👤';

        const nameEl = el(this.doc, 'span', 'nb-persona-chip-text');
        nameEl.setAttribute('data-role', 'persona-chip-text');
        nameEl.textContent = personaText;

        host.append(icon, nameEl);
        if (withCaret) {
          const caret = el(this.doc, 'span', 'nb-persona-chip-caret');
          caret.setAttribute('aria-hidden', 'true');
          caret.textContent = '▾';
          host.append(caret);
        }
      };

      if (this.callbacks.onSwitchPersona === undefined) {
        const plain = el(this.doc, 'span', 'nb-persona-chip');
        plain.setAttribute('data-role', 'persona-chip');
        plain.setAttribute('data-static', 'true');
        /*
         * 无障碍：拆成三个 span 之后，读屏会把"👤""名字""▾"念成三段。
         * 显式给一个完整标签，让它念一句通顺的话。
         */
        plain.setAttribute('aria-label', `当前人设：${personaText}`);
        makeChipContent(plain, false);
        subRow.append(plain);
      } else {
        const chip = el(this.doc, 'button', 'nb-persona-chip');
        chip.setAttribute('type', 'button');
        chip.setAttribute('data-role', 'persona-switch');
        chip.setAttribute('aria-haspopup', 'listbox');
        chip.setAttribute('aria-label', `切换当前聊天的人设（当前：${personaText}）`);
        makeChipContent(chip, true);
        chip.addEventListener('click', (event) => {
          /*
           * `stopPropagation`：顶栏下面就是消息区，点这里不该连带触发
           * 收起键盘之类的全局行为（那条逻辑挂在 `pointerdown` 上）。
           */
          (event as unknown as { stopPropagation?: () => void }).stopPropagation?.();
          this.callbacks.onSwitchPersona?.(chip);
        });
        this.personaChipEl = chip;
        subRow.append(chip);
      }
    }
    title.append(subRow);
    /*
     * 存成员供 `syncSubtitle()` 用。
     *
     * `sub` 原来是纯局部变量：创建时写一次就再没人能改它。
     * 于是 `loadChat()` / `setMessages()` 把 `this.fileName` 改对了，
     * 顶栏却一直显示"未选择聊天" —— 2026-10-31 截图里就是这样，
     * 而消息明明已经渲染出来了（**状态对、显示不对**，只看消息区发现不了）。
     */
    this.subEl = sub;
    const menuBtn = el(this.doc, 'button', 'nb-icon-btn');
    menuBtn.setAttribute('type', 'button');
    /*
     * ★ 补 `data-role`（2026-11-04 第二十九批）。
     *
     * 这个按钮原来只有 `aria-label`，没有 `data-role` —— 于是真机探针
     * 无法定位它（"长按删除角色"那条验收必须先进这一页）。
     * 本项目所有可交互入口都带 `data-role`，这里是唯一的例外。
     */
    menuBtn.setAttribute('data-role', 'pick-character');
    menuBtn.setAttribute('aria-label', '选择角色与聊天');
    menuBtn.textContent = '☰';
    menuBtn.addEventListener('click', () => void this.openPicker());
    topbar.append(title, menuBtn);

    /*
     * 设置按钮（2026-10-31 第三批问题二）。
     *
     * 「聊天页没有任何聊天参数的配置入口」是用户报的第三条 ——
     * AI 响应配置、回复格式化、世界书、用户设置这四项此前在移动端
     * **一个都进不去**。
     *
     * 只有外壳给了 `onOpenChatSettings` 才渲染：没有路由能力时挂一个
     * 点了没反应的按钮，比不挂更糟（用户会以为功能坏了）。
     *
     * ## 齿轮图形为什么画在 CSS 里，不在这里写 SVG
     *
     * 第一版用 `settingsBtn.innerHTML = '<svg …>'` 内联了 SVG，被
     * `test/nebula-walkthrough.test.mjs` 的「所有 innerHTML 必须走
     * renderMessageHtml」当场拦住 —— 那条硬门的理由是"innerHTML 是 XSS 入口"。
     * 虽然这里的内容是静态常量、没有注入面，但**给一条硬门开例外，
     * 下次就有人拿"我这也是静态的"当理由去写动态内容**。
     *
     * 所以图形挪到 `chat.css` 的 `.nb-icon-btn[data-role='chat-settings-open']`
     * （用 mask + 内联 SVG 作蒙版，`background-color: currentColor` 跟着主题走）。
     * 这里只留几何无关的语义。
     */
    if (this.callbacks.onOpenChatSettings !== undefined) {
      const settingsBtn = el(this.doc, 'button', 'nb-icon-btn');
      settingsBtn.setAttribute('type', 'button');
      settingsBtn.setAttribute('data-role', 'chat-settings-open');
      settingsBtn.setAttribute('aria-label', '聊天设置');
      settingsBtn.addEventListener('click', () => {
        this.callbacks.onOpenChatSettings?.();
      });
      topbar.append(settingsBtn);
    }

    // 消息区
    const body = el(this.doc, 'div', 'nb-msglist');
    body.setAttribute('data-role', 'msglist');
    this.listEl = body;

    /*
     * ★★★ 用户主动滚动就停止跟随（2026-11-03 第二十五批）。
     *
     * 用户要求「用户发出或角色回复气泡或唤出取消键盘或打开语音面板时跟随滚动」——
     * 这些时刻**必须**跟。但如果他正在往上翻历史、而 AI 还在流式输出，
     * 一路强制贴底会让他根本读不了上面。
     *
     * 所以加一个"用户想自己控制"的信号：
     *   · 手指碰列表（`touchstart`）= 要自己滚 → 关掉强制跟随
     *   · 桌面滚轮（`wheel`）= 同上
     * 下次发送消息时再打开（见 `sendText` / `generate`）。
     *
     * 用触摸/滚轮而不是 `scroll` 事件：程序自己设 `scrollTop` **也会**
     * 触发 `scroll`，用它区分不了"用户滚"和"我滚"，会把跟随逻辑弄成竞态。
     */
    body.addEventListener('touchstart', () => {
      this.forceFollow = false;
    });
    body.addEventListener('wheel', () => {
      this.forceFollow = false;
    });

    // 输入区（玻璃 2/3）
    const composer = el(this.doc, 'div', 'nb-composer');
    // 初始是键盘态；语音态时 input/send/mic 隐藏、stage 显示（见 chat.css §八）
    composer.setAttribute('data-voice', 'false');

    /*
     * ★ T15.6 三个挂载点 —— 从 T15.5 的「占位」换成真实功能。
     *
     * id 与类名**一个都不改**：`VOICE_MOUNTS` 是单一真相，
     * T15.5 交付时承诺给 T15.6 的接口就是它。
     * 这里换的只是内部实现（div → button、hidden → flex）。
     */
    this.voicePanel = new VoicePanel({
      doc: this.doc,
      asrConfigured: this.voiceConfig.asrConfigured,
      confirmBeforeSend: this.voiceConfig.confirmBeforeSend,
      initialMode: this.voiceConfig.lastMode,
      transport: this.voiceTransport,
      onNeedAsrConfig: () => this.callbacks.onNeedAsrConfig?.(),
      onNotify: this.callbacks.onNotify,
      /*
       * 麦克风释放的可观测点（2026-11-01 发布阻断级）。
       *
       * 只在 `document.body` 上打一个属性，**不弹提示** ——
       * 这几个时刻（退后台/看门狗/dispose）用户多半看不到界面，
       * 弹了也是噪声。留属性是给验收脚本与 QA 用的：
       *
       * ```js
       * document.body.dataset.micReleased   // "visibility" / "dispose" / …
       * ```
       *
       * 有它才谈得上"断言释放真的发生了"，而不是只看
       * "`this.recording` 现在是 null"（那只能证明我们自己清干净了，
       * 不能证明设备真的松手了）。
       */
      onReleaseMic: (reason) => {
        const body = (this.doc as unknown as { body?: { dataset?: Record<string, string> } }).body;
        if (body?.dataset !== undefined) body.dataset['micReleased'] = reason;
      },
      /*
       * 语音态 ⇄ 键盘态：改 composer 的属性，由 CSS 切显隐。
       *
       * 为什么由面板广播、外壳来改：composer 是外壳造的，
       * 面板不该直接去改别人的 DOM（那样两处都能改，谁最后生效说不清）。
       */
      onStageChange: (stage) => {
        composer.setAttribute('data-voice', stage === 'voice' ? 'true' : 'false');
      },
      /*
       * ★ 草稿卡刚出现时把它滚进视口。
       *
       * 它挂在消息列表末尾，而松手那一刻列表还停在上面 ——
       * 用户会以为"什么都没发生"，实际他说的那句就在视口下面一条。
       * 2026-10-30 录屏抓到的就是这个：DOM 全对、截图里一个像素都看不到。
       *
       * 这里**不用** `markStick` 那套"是否在底部"的判断：草稿是用户刚
       * 主动产生的、必须看见的内容，哪怕他正在翻历史也应当被带过来。
       * 与"新消息要不要跟随"是两种不同的意图，不能共用一个开关。
       */
      onDraftShown: () => {
        const list = this.listEl as unknown as HTMLElement | null;
        if (list === null) return;
        // 用瞬时滚动而不是 smooth：草稿出现是"切屏"级的变化，动画反而拖慢
        list.scrollTop = list.scrollHeight;
      },
      /*
       * 语音发出去的消息要带 `extra.tcs.voice = true`。
       *
       * 打标是**消息层**的职责（`setVoiceFlag`），但落消息在这里 ——
       * 所以这里是唯一能打标的地方。不带这个标记的话，
       * 消息在界面上与打字发的完全一样，用户回看时不知道哪条是语音。
       */
      onSend: async (text, durationMs) => {
        await this.sendText(text, { voice: true, durationMs });
      },
    });
    const mounts = this.voicePanel.render();
    /*
     * 语音舞台放最前 —— 语音态时它独占输入区，
     * 而 input/send/mic 由 CSS 按 `composer[data-voice]` 隐藏。
     */
    composer.append(mounts.stage);
    composer.append(mounts.chips);
    /*
     * 待确认草稿**不放在 composer 里** —— 它要挂在消息列表末尾，
     * 像一条待发的消息（用户 2026-10-30 给的形态）。
     * 由 `render()` 在每次重建列表后重新挂上。
     */
    this.draftCardEl = mounts.confirm;

    const input = el(this.doc, 'textarea', 'nb-input') as unknown as HTMLTextAreaElement;
    input.setAttribute('rows', '1');
    input.setAttribute('placeholder', '说点什么…');
    input.setAttribute('aria-label', '消息输入框');
    (input as unknown as HTMLTextAreaElement).addEventListener?.('input', () => {
      this.syncSendButton();
    });

    /*
     * ★★★ 焦点进来（= 键盘要弹）时，把消息列表滚到底（2026-11-02）。
     *
     * ## 用户报的现象
     *
     * > 点击文本输入框后键盘和文本框出来了，但是聊天记录会被遮住，
     * > 应该和文本框一样整体往上移才对
     *
     * 录屏里最后一条消息**只露出半截**：消息区的底部边界正好压在它身上。
     *
     * ## 为什么滚一下就好
     *
     * 键盘弹起 → 可用高度变小 → 消息列表跟着变矮，但**滚动位置没变**。
     * 于是原先可见的最后一条消息被新边界裁掉下半截。
     * 列表底部本来留了 56px 空白（给语音浮层），滚到底后最后一条必然完整可见。
     *
     * ## 为什么延迟 320ms
     *
     * `--nb-kb-inset-native` 由 Android 侧在键盘动画过程中写入，
     * 立即滚会按"键盘还没弹"的旧高度算一次，随后列表又被压缩、又裁掉半截。
     * 320ms 覆盖住常见的键盘动画时长（250–300ms）。
     *
     * ## 为什么用 `smooth: false` 的即时滚动
     *
     * `scrollToBottom()` 用的是 `behavior: 'smooth'`。键盘同时在做高度动画，
     * 两个动画叠加会让列表"追着"目标滚，视觉上抖。这里直接跳到底更稳。
     */
    const scrollAfterKeyboard = (): void => {
      globalThis.setTimeout(() => {
        const list = this.listEl as unknown as { scrollTop?: number; scrollHeight?: number } | null;
        if (list === null || typeof list.scrollTop !== 'number') return;
        if (typeof list.scrollHeight === 'number') list.scrollTop = list.scrollHeight;
      }, 320);
    };
    (input as unknown as HTMLTextAreaElement).addEventListener?.('focus', scrollAfterKeyboard);
    this.inputEl = input as unknown as ElLike;

    /*
     * ★ 这一行不能少。
     *
     * 2026-10-31 真机截图里输入区只剩「🎤」和「↑」两个按钮，中间一片空白。
     * 根因就是**建了 input 却忘了 append**：`this.inputEl` 有值、`syncSendButton()`
     * 也能读到它，所以 `npm test` 全绿；DOM 里却压根没有这个节点。
     *
     * 为什么测试抓不到：`chat-panel` 的测试用 30 行 stub 当 `doc`，
     * `el()` 造出的节点只被引用、不被遍历，`inputEl !== null` 就够了。
     * 只有"量真实 DOM"的探针能发现 —— 所以 `scripts/probe-shots.mjs`
     * 现在会额外量 `.nb-input` 是否存在（判据写在里面）。
     *
     * 位置在 mic 之前：视觉顺序是 [输入框][🎤][↑]，麦克风贴着发送键。
     */
    /*
     * ★★★ 快捷输入条（2026-11-02 用户要求）。
     *
     * > 在聊天界面添加三个快捷输入按键 "、（）、「」，这个要小一点，不遮挡文字；
     * > 再在快捷键那一排加一个重新生成按钮
     *
     * ## 三个符号为什么是这三对
     *
     * 角色扮演写作里最常用、手机上最难打的：
     *   · `""` —— 对话
     *   · `（）` —— 动作/旁白
     *   · `「」` —— 引用语气
     * 手机上要切到标点键盘翻三页才找得到，点一下就能插。
     *
     * ## 为什么用 `flex-wrap` + `order` 而不是改结构
     *
     * composer 现在是 `[输入框][🎤][发送]` 一行。加快捷键要变成两行，
     * 但把 input/mic/send 包进新 wrapper 会牵动 `syncSendButton()`、
     * `data-voice` 的显隐规则、以及一堆既有判据。
     *
     * `flex-wrap: wrap` + 快捷键 `flex: 0 0 100%; order: -1` 只加两条 CSS
     * 就让它独占一整行且在**最上面**，其余元素位置不变。
     */
    const quickbar = el(this.doc, 'div', 'nb-quickbar');
    quickbar.setAttribute('data-role', 'chat-quickbar');

    /**
     * 成对插入：`""` / `（）` / `「」`，光标落在**中间**。
     *
     * 选中了文字就把它包起来（`甲` → `「甲」`），没选中就插一对空壳。
     * 这两种都是用户会做的事，只做前者会让人每次都要先选中。
     */
    const insertPair = (open: string, close: string): void => {
      const ta = this.inputEl as unknown as HTMLTextAreaElement | null;
      if (ta === null) return;
      const value = ta.value ?? '';
      const start = typeof ta.selectionStart === 'number' ? ta.selectionStart : value.length;
      const end = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : start;
      const selected = value.slice(start, end);
      ta.value = `${value.slice(0, start)}${open}${selected}${close}${value.slice(end)}`;
      const caret = start + open.length + selected.length;
      /* 选中了就把光标放末尾（继续打字更顺），没选中就落中间 */
      const caretPos = selected === '' ? start + open.length : caret;
      ta.setSelectionRange?.(caretPos, caretPos);
      ta.focus?.();
      this.syncSendButton();
    };

    const QUICK_PAIRS: readonly { label: string; open: string; close: string; title: string }[] = [
      { label: '"', open: '"', close: '"', title: '插入对话引号' },
      { label: '（）', open: '（', close: '）', title: '插入动作括号' },
      { label: '「」', open: '「', close: '」', title: '插入引用括号' },
    ];
    for (const pair of QUICK_PAIRS) {
      const btn = el(this.doc, 'button', 'nb-quickkey');
      btn.setAttribute('type', 'button');
      btn.setAttribute('data-quick', pair.title);
      btn.setAttribute('aria-label', pair.title);
      btn.textContent = pair.label;
      btn.addEventListener('click', () => insertPair(pair.open, pair.close));
      quickbar.append(btn);
    }

    /*
     * 重新生成。
     *
     * 放在同一排是因为它就是"重写上一条" —— 与那几个符号同属
     * "打字时的辅助动作"，挪到别处用户要记两个位置。
     */
    const regenBtn = el(this.doc, 'button', 'nb-quickkey');
    regenBtn.setAttribute('type', 'button');
    regenBtn.setAttribute('data-role', 'chat-regenerate');
    regenBtn.setAttribute('aria-label', '重新生成上一条回复');
    regenBtn.textContent = '↻';
    regenBtn.addEventListener('click', () => void this.regenerate());
    this.regenEl = regenBtn;
    quickbar.append(regenBtn);

    composer.append(quickbar);
    composer.append(input as unknown as ElLike);

    // ★ T15.6 挂载点①：麦克风按钮位（发送按钮左侧）
    composer.append(mounts.mic);

    const send = el(this.doc, 'button', 'nb-send');
    send.setAttribute('type', 'button');
    send.setAttribute('aria-label', '发送');
    send.setAttribute('data-role', 'send');
    send.textContent = '↑';
    send.addEventListener('click', () => void this.onSendClick());
    this.sendEl = send;
    composer.append(send);

    root.append(topbar, body, composer);
    container.append(root);
    this.root = root;

    this.attachGestures(body);
    this.render();
    this.syncSendButton();
    return root;
  }

  /** 载入一个聊天 */
  async loadChat(avatar: string, fileName: string): Promise<void> {    const raw = await this.bridge.loadChatRaw(avatar, fileName);
    /*
     * ★ 三态判定（陷阱 #4）交给 `shared`：
     * `{}` = 目录不存在、`[]` = 文件读不到、数组 = 有内容。
     * 把 `{}` 或 `[]` 当"空聊天可安全写入"会导致**一次保存整份覆盖、真实历史丢失**。
     */
    const parsed = parseChatResponse(JSON.parse(raw === '' ? '{}' : raw) as unknown);

    if (parsed.kind === 'chat') {
      this.pendingScroll = true; // 打开聊天先看最新的
      this.messages = parsed.messages;
      this.avatar = avatar;
      this.fileName = fileName;
      this.syncSubtitle();
      this.render();
      return;
    }

    /*
     * 其余三种都**不自动建聊天**：让用户明确"新建"。
     *
     * 尤其是 `malformed`（响应既不是数组也不是 `{}`）—— 那种情况多半是
     * ST 没连上或返回了错误页，此时把消息清空再让用户发送，等于
     * **用一份空历史去覆盖真实文件**（陷阱 #1：save 是全量覆盖）。
     */
    this.messages = [];
    this.avatar = avatar;
    this.fileName = null;
    this.syncSubtitle();

    const notice =
      parsed.kind === 'missing'
        ? '这个角色还没有聊天记录'
        : parsed.kind === 'empty'
          ? '这条聊天读不到内容'
          : `聊天数据格式不认识（${parsed.reason}），已按"无记录"处理`;
    this.callbacks.onNotify?.(notice, parsed.kind === 'malformed' ? 'danger' : 'warn');
    this.render();
  }

  /**
   * 新建聊天（清空当前对话，第一次发送时才落盘）。
   *
   * @param avatar 角色文件标识
   * @param characterName 角色显示名。**不传也不报错**，但不是可选装饰：
   *   不传时副标题只能退回「未选择聊天」（因为聊天文件还没生成，
   *   `fileName` 也还是 null）—— 真机上"选完角色顶栏说没选"就是这么来的。
   *   所有**知道角色名**的调用点都必须传。
   */
  /**
   * 开一个新的空聊天（可能有开场白）。
   *
   * ## ★★★ 2026-11-05：插入开场白（用户决定 2）
   *
   * 原来是 `this.messages = []`。于是导入一张卡、开始聊天，界面**一片空白** ——
   * 而那张卡的 `first_mes` 有 367 字，是它最值钱的部分。
   *
   * 现在把 `first_mes` 作为第一条 assistant 消息放进去，`alternate_greetings`
   * 变成候选（左滑切换）—— 与 ST 建新聊天的行为一致。
   * 纯逻辑在 `shared/chat/opening.ts`（有独立判据）。
   *
   * 为什么放在**面板**而不是外壳：`ctx.card` 已经在面板里，
   * 而"消息列表归谁管"是面板的职责。外壳插手就会有两个地方改 `messages`。
   */
  newChat(avatar: string, characterName?: string): void {
    this.pendingScroll = true; // 清空后一定贴底（没有历史可翻）
    this.avatar = avatar;
    this.fileName = null;
    if (characterName !== undefined && characterName.trim() !== '') {
      this.characterName = characterName;
    }
    this.syncSubtitle();

    this.messages = buildOpeningMessages(this.ctx.card);
    this.render();

    /*
     * 开场白也算"聊天的内容"，要落盘。
     *
     * 不存的话：用户看到开场白、直接退出，下次进来又是空白 ——
     * 而界面上刚才明明有一条。存了之后 `loadChat` 能读回来。
     */
    if (this.messages.length > 0) {
      this.callbacks.onChatChanged?.(this.messages);
    }
  }

  /**
   * 用一批消息替换当前对话（**不请求 ST、不写文件**）。
   *
   * 为什么需要这个入口：
   *
   * 1. **验收**：移动端还没接 ST（T15.3 主体未做），没有历史可 `loadChat`。
   *    但「输入区是不是贴底」这种布局问题**只有在有对话时才看得出来**
   *    （空状态里列表区是空状态卡，撑不出真实高度）。桌面端早就用
   *    `?sample=1` 解决同一个需求（`editor/app.ts:5344`），这里是同口径。
   * 2. **将来**：从 ST 拿到历史后由外壳批量替换 —— 那时 `loadChat` 内部
   *    也可以改调它，但**今天不改**（`loadChat` 里有陷阱 #4 的三态判定，
   *    在没被要求改它的时候动它是无谓风险）。
   *
   * 三条纪律：
   *
   * · **不改 `avatar`**：它决定"发送时写到哪个角色目录"。样本没有对应目录，
   *   改了会让截图期间的误触直接往真实角色里写（陷阱 #1：保存全量覆盖）。
   * · **浅拷贝入参**：调用方可能复用同一个数组（样本常量），面板后续
   *   会原地 push/splice 做流式与重生成，不拷贝就会把常量改坏。
   * · **贴底**：和 `loadChat` 一样，进去先看最新。
   */
  /**
   * 载入一份历史消息。
   *
   * ## `avatar` 为什么必须能一起传（2026-11-01 发布阻断级回归）
   *
   * 原来这个函数**只设 `fileName`，不设 `avatar`**。
   * 而外壳 `renderChat()` 的逻辑是：
   *
   * ```js
   * if (this.chatSnapshot !== null) {
   *   panel.setMessages(...)          // ← 有历史走这条
   * } else if (this.selectedCharacter !== null) {
   *   panel.newChat(avatar, name)     // ← 只有没历史时才设 avatar
   * }
   * ```
   *
   * 于是**读回历史之后 `avatar` 恒为 null** ⇒ 用户发消息时
   * `sendText()` 判 `this.avatar === null` ⇒ 提示「先选一个角色」
   * 并跳转「我的」Tab。
   *
   * 这是上一轮"冷启动读回历史"修复引入的回归：
   * 那条修复让 `chatSnapshot` 变成非空，从而**绕过了 `newChat()`**，
   * 而 `newChat()` 正是唯一设置 `avatar` 的地方。
   *
   * 症状看起来像"角色没选上"，实际是"历史有了、身份没设" ——
   * 只看 `sendText` 那段代码是找不到的，必须看两条分支的关系。
   *
   * @param avatar 角色标识。**外壳必须传**（判据会钉住）。
   */
  setMessages(messages: StChatMessage[], fileName?: string, avatar?: string): void {
    /*
     * ★★★ 这里**不再**设 `pendingScroll = true`（2026-11-03 第二十四批）。
     *
     * 用户报：「切到聊天页面的时候会自己从头开始滚动」。
     *
     * 真因：`renderChat()` 每次切 Tab 回来都重建面板 → 用快照调 `setMessages`
     * 恢复历史，而这里无条件 `pendingScroll = true` ⇒ 渲染完滚到底。
     * 用户正在翻历史时切走再切回，被硬拽到最底部 —— 突兀且丢位置。
     *
     * `setMessages` 的语义是「**恢复**一段历史」，不是「来了一条新消息」。
     * 恢复不该滚动；滚动位置由外壳保存/恢复（见 `getScrollTop` /
     * `restoreScroll`）。真正该跟随滚动的只有：用户发消息、角色回复、
     * 收起键盘、打开语音面板 —— 那些走的是 `markStick()` + `stickToBottom`。
     *
     * 冷启动读回历史也走这条（`restoreLatestChat` → 快照 → `setMessages`），
     * 同样不再主动滚到底：用户上次停在哪，打开就在哪。
     */
    /*
     * ★ 恢复历史时清掉强制跟随（2026-11-03 第二十五批）。
     *
     * 不清的话，用户上一次发消息把 `forceFollow` 置成了 true，
     * 这个状态会残留到"切 Tab 回来重建面板"之后 —— 那时任何一次
     * `markStick()` 都会无条件贴底，等于又变回"切页就滚到底"的老 bug。
     */
    this.forceFollow = false;
    this.messages = messages.slice();
    if (fileName !== undefined) this.fileName = fileName;
    if (avatar !== undefined && avatar !== '') this.avatar = avatar;
    this.syncSubtitle();
    this.render();
  }

  /**
   * 读当前滚动位置（外壳切 Tab 前存进快照用）。
   *
   * 为什么是独立方法而不是让外壳直接摸 `listEl`：`listEl` 是私有字段，
   * 外壳不该知道消息列表是哪个元素 —— 结构一变（例如将来套一层容器），
   * 外壳那套"直接设 scrollTop"的代码就静默失效。
   */
  getScrollTop(): number {
    const list = this.listEl as unknown as { scrollTop?: number } | null;
    return list === null || typeof list.scrollTop !== 'number' ? 0 : list.scrollTop;
  }

  /**
   * 还原滚动位置（外壳切 Tab 回来时用）。
   *
   * ★ 必须在 `setMessages` **之后**调用：`setMessages` 里 `render()` 会
   * `replaceChildren()`，把列表重建、`scrollTop` 归零，之后设才有效。
   *
   * 用 `requestAnimationFrame` 兜底：`scrollHeight` 是布局后才有，
   * 立即设一个超大的 `scrollTop` 可能被浏览器夹到旧高度。等一帧布局稳了
   * 再设，避免"设了但被夹回去"。
   */
  restoreScroll(top: number): void {
    const list = this.listEl as unknown as { scrollTop?: number } | null;
    if (list === null || typeof list.scrollTop !== 'number') return;
    list.scrollTop = top;
    /* 第二帧再设一次，覆盖"首帧布局还没算完导致被夹"的情况 */
    requestAnimationFrame(() => {
      if (list !== null && typeof list.scrollTop === 'number') list.scrollTop = top;
    });
  }

  private render(): void {
    if (this.listEl === null) return;
    this.listEl.replaceChildren();

    if (this.messages.length === 0) {
      this.listEl.append(
        renderEmptyState(this.doc, {
          halo: '💬',
          title: '还没有对话',
          text:
            this.avatar === null
              ? '先选一个角色，然后就可以开始聊了。'
              : '说第一句话吧 —— 角色会接着回答。',
          actions:
            this.avatar === null
              ? [{ label: '选择角色', primary: true, onClick: () => void this.openPicker() }]
              : [{ label: '选择角色', onClick: () => void this.openPicker() }],
        }),
      );
      return;
    }

    // 生成中的那条要显示呼吸点：它是列表最后一条
    const streamingIndex =
      showsCaret(this.stream) && this.messages.length > 0 ? this.messages.length - 1 : -1;

    /*
     * ★ 渲染**进** `listEl`，不要再套一层容器。
     *
     * `renderMessageList()` 默认会新建一个 `div.nb-msglist`，而 `listEl` 本身就是
     * `.nb-msglist`（`mount()` 里建的滚动容器）—— 两层同名同类、都带
     * `flex:1 + overflow-y:auto`，滚动就被内层抢走，而 `pendingScroll` 滚的是外层，
     * 于是**永远不贴底**：实测最后一条气泡 top=882、视口 800、被输入区盖住 297px。
     */
    renderMessageList(this.doc, this.messages, {
      charName: String(this.ctx.card['name'] ?? ''),
      userName: this.ctx.userName,
      streamingIndex,
      into: this.listEl,
    });

    /*
     * ★ 待确认草稿要挂回列表末尾。
     *
     * `render()` 每次 `replaceChildren()` 都会把列表清空 —— 草稿卡片
     * 如果只 append 一次，第一次重绘就没了。而录音结束进确认态**恰好**
     * 会触发一次 render（占位消息那条），所以不重挂的话它永远看不到。
     *
     * 这是"元素持在面板手里、位置由列表决定"的必然代价；
     * 显式重挂比"把草稿做成一条真消息"简单得多，也不会污染消息模型。
     */
    if (this.draftCardEl !== null) {
      this.listEl.append(this.draftCardEl);
    }

    // 渲染完把视口带到底部（由 `render()` 的调用方决定是否要跟随）
    if (this.pendingScroll) {
      this.pendingScroll = false;
      this.scrollToBottom();
    }
  }

  /*
   * 滚动跟随（判据在 `shared/src/chat/scroll.ts`，这里只负责调 DOM）。
   *
   * ## 顺序很重要：**重渲染之前**先记下"用户是否在底部**
   *
   * 新消息一插进来，`scrollHeight` 立刻变大 —— 此时算"距底距离"必然判成
   * "不在底部"，于是自动滚永远不生效（现象：发完消息看不到回复）。
   * 所以 `markStick()` 必须在 `render()` 之前调。
   */
  private pendingScroll = false;
  /**
   * 强制跟随到底（2026-11-03 第二十五批）。
   *
   * ## 为什么要它：`shouldStick` 的判据与用户要求不是一回事
   *
   * `shouldStick` 问的是"用户**本来**在不在底部"——不在底部就不跟随。
   * 那是为了防"翻历史被拽回来"设计的。
   *
   * 但用户明确要求：
   *
   * > 我只要用户发出或角色回复气泡或唤出取消键盘或打开语音面板时跟随滚动
   *
   * 这四件事是**用户主动要往下看**的信号。此时哪怕他刚才在翻历史，
   * 也应该跟到底 —— 因为他要看的正是刚发生的这条。
   *
   * 所以：
   *   · 发送消息 / 开始回复时 → `forceFollow = true`（无条件跟）
   *   · 用户手指碰列表 → `false`（他要自己控制，别抢）
   */
  private forceFollow = false;
  /** 当前打开的气泡菜单（同一时刻只允许一个） */
  private bubbleMenu: BubbleMenuHandle | null = null;

  /** 在会改变内容高度的操作**之前**调用 */
  private markStick(): void {
    const list = this.listEl as unknown as HTMLElement | null;
    if (list === null) {
      this.pendingScroll = true;
      return;
    }
    /*
     * ★ `forceFollow` 优先（2026-11-03 第二十五批）。
     *
     * 发消息 / 开始回复时它是 true ⇒ 无条件跟随；
     * 其余情况退回"本来在底部才跟"的判据。
     */
    this.pendingScroll =
      this.forceFollow ||
      shouldStick({
        scrollHeight: list.scrollHeight ?? 0,
        clientHeight: list.clientHeight ?? 0,
        scrollTop: list.scrollTop ?? 0,
      });
  }

  private scrollToBottom(): void {
    const list = this.listEl as unknown as HTMLElement | null;
    if (list === null || typeof list.scrollTo !== 'function') return;
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  }

  /**
   * **立即**贴到底部，不做动画（2026-11-04）。
   *
   * ## 为什么需要单独一个方法
   *
   * `scrollToBottom()` 用的是 `behavior: 'smooth'` —— 对"来了一条新消息"
   * 是对的（用户看着它滑下去）。但**冷启动打开一段历史**时不合适：
   * 用户应该**一打开就在最新那条**，而不是看着屏幕从几十屏之前
   * 一路滚下来（那要滑好几秒）。
   *
   * ## 为什么要连续设三次
   *
   * 打开历史的那一刻，列表高度还没定型：
   *
   * ```text
   *   第 0 帧   气泡已 append，但字体的 line-height 还没应用 ⇒ 高度偏小
   *   第 1 帧   布局稳定 ⇒ scrollHeight 变大，之前的 scrollTop 就不再是底部
   *   之后      头像/缩略图陆续 decode 完，高度再涨一点
   * ```
   *
   * 只设一次的话，实测会停在"离底部还差几百像素"的位置 —— 正是用户
   * 看到的"停在聊天记录中间"。所以按 0 / 一帧 / 120ms 各设一次，
   * 每次都取**当时**的 `scrollHeight`。
   */
  scrollToBottomNow(): void {
    const list = this.listEl as unknown as { scrollTop?: number; scrollHeight?: number } | null;
    if (list === null || typeof list.scrollTop !== 'number') return;

    const jump = (): void => {
      if (list === null || typeof list.scrollTop !== 'number') return;
      list.scrollTop = list.scrollHeight ?? 0;
    };

    jump();
    requestAnimationFrame(() => {
      jump();
      /* 第三帧之后再补一次：图片 decode 完高度会再涨 */
      globalThis.setTimeout(jump, 120);
    });
  }

  private syncSendButton(): void {
    if (this.sendEl === null || this.inputEl === null) return;
    const text = (this.inputEl as unknown as HTMLTextAreaElement).value ?? '';
    const busy = isBusy(this.stream);
    const ready = text.trim().length > 0 && !busy;
    this.sendEl.setAttribute('data-ready', String(ready));
    (this.sendEl as unknown as HTMLButtonElement).disabled = !ready;
    /*
     * 重新生成按钮也跟生成状态走（2026-11-05）。
     *
     * 函数里加了并发守卫，但**只靠守卫不够**：按钮看着可点、点下去只弹一句
     * "正在回复中"，用户会以为按钮坏了，反复点。禁用它才是"现在不能点"的
     * 明确表达。两个状态一起同步，避免"能点但没用"这种自相矛盾的界面。
     *
     * 用 `disabled` 属性而不是只加 `data-ready`：前者能真正阻止点击事件，
     * 后者只是样式钩子，键盘回车/读屏仍会触发。
     */
    if (this.regenEl !== null) {
      (this.regenEl as unknown as HTMLButtonElement).disabled = busy;
      /*
       * 复位必须用 `removeAttribute`，不能 `setAttribute('disabled','')` ——
       * `disabled` 是布尔属性，存在即生效，空串照样禁用（§2026-11-04 那次
       * "点登录→取消风险框→按钮永久变灰"就是这么来的）。
       */
      if (!busy) this.regenEl.removeAttribute('disabled');
      this.regenEl.setAttribute('data-busy', String(busy));
    }
  }

  /**
   * 打开「选择角色」并应用结果。
   *
   * ## 为什么要公开
   *
   * 它本来就是"让用户选角色"这个动作的唯一入口（顶栏 ☰ 就绑在它上面）。
   * 保持 `private` 只有两个后果：测试只能去点按钮再猜异步什么时候完成，
   * 而外壳要做同样的事也得再走一遍按钮 —— 没有理由拦着。
   *
   * ## `picked.name` 必须带下去（2026-11-01 问题一的断点之一）
   *
   * 回调的返回类型一直是 `{ avatar, name }`，但第一版只取了 `avatar`，
   * 把 `name` 丢在地上。当时没被发现，因为外壳那条路会先 `resolve(null)`
   * 再重建面板（真正的状态由 `renderChat()` 恢复）—— 于是这个分支
   * **平时走不到**，缺陷就藏住了。现在两处都传，两条路才一致。
   */
  async openPicker(): Promise<void> {
    const picked = await this.callbacks.onPickCharacter?.();
    if (picked == null) return;
    this.avatar = picked.avatar;
    this.characterName = picked.name;
    const chat = await this.callbacks.onPickChat?.(picked.avatar);
    if (chat != null) {
      await this.loadChat(picked.avatar, chat.fileName);
    } else {
      // 传名字：新建聊天时 fileName 是 null，副标题只能靠角色名
      this.newChat(picked.avatar, picked.name);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     发送与生成
     ═══════════════════════════════════════════════════════════ */

  private async onSendClick(): Promise<void> {
    if (isBusy(this.stream)) {
      // 生成中，这个按钮是"停止"
      await this.handle?.abort();
      this.stream = requestStop(this.stream);
      this.render();
      this.syncSendButton();
      return;
    }
    await this.send();
  }

  /** 发一条用户消息，然后触发生成 */
  /** 打字发送（输入框里的内容） */
  async send(): Promise<void> {
    if (this.inputEl === null) return;
    const text = ((this.inputEl as unknown as HTMLTextAreaElement).value ?? '').trim();
    if (text === '') return;
    (this.inputEl as unknown as HTMLTextAreaElement).value = '';
    // 不传第二个参数 = 打字发的（不打语音标记、消息里没有音频条）
    await this.sendText(text);
  }

  /**
   * 落一条用户消息并触发生成。
   *
   * ## 为什么语音与打字共用这一个入口
   *
   * 两者的差别**只有一个字段**（`extra.tcs.voice`）。分成两条路径的话，
   * 以后改"发送前要不要裁剪空白""要不要带 send_date"这类规则就要改两处，
   * 而漏一处会出现"语音发的少个字段"这种极难发现的问题。
   *
   * ## `voice` 为什么从布尔改成对象
   *
   * 2026-10-31 用户要求「语音气泡下是识别出来的文字」—— 消息里要画一条
   * 带时长的音频条。时长只有语音路径有，而布尔参数表达不了"语音 + 3.2 秒"。
   * 用一个 `{ voice, durationMs }` 对象而不是再加一个平级参数：
   * 后者会让调用点容易出现 `sendText(t, true, false)` 这种读不懂的组合。
   *
   * @param voice 不传 = 打字发的；传 `{ voice: true }` = 语音发的
   */
  async sendText(text: string, voice?: { voice: boolean; durationMs?: number }): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === '') return;
    /*
     * ★★★ 并发守卫（2026-11-05，用户报的"语音 + 慢转写"就是这个）。
     *
     * 语音这条路**不经过发送按钮**：`voice-panel` 转写完成后直接调
     * `onSend → sendText`，所以 `syncSendButton()` 那道 `disabled`
     * 拦不住它。
     *
     * 于是出现这个序列：
     *   ① 按住说话 → 松手 → ASR 很慢（十几秒）
     *   ② 用户以为卡住，点了 ↻ 重新生成 → 第一路生成开始
     *   ③ ASR 终于返回 → `sendText` 又发起第二路生成
     * → 两路流同时写 `this.messages`，`this.handle` 被覆盖，
     *   前一路的 `done` 回调按旧下标写正文 ⇒ 文字长进别的气泡，
     *   或两边都超时报"连不上"。
     *
     * 所以拦在**这里**，而不是只拦按钮。用户视角的提示要给出
     * "现在该等"，而不是"发失败了"。
     */
    if (isBusy(this.stream)) {
      this.callbacks.onNotify?.('上一条还在回复，等它写完再发。', 'warn');
      return;
    }
    if (this.avatar === null) {
      /*
       * ★ 只**就地提示**，不许跳 Tab（2026-11-01 用户明确要求）。
       *
       * 原来这里是：
       * ```js
       * this.callbacks.onNeedApiConfig?.();     // ← 把用户甩到「我的」页
       * this.callbacks.onNotify?.('先选一个角色', 'warn');
       * ```
       *
       * 用户的原话：「跳转行为只应发生在"用户点配置入口"时，
       * 发送消息失败绝不应跳 Tab」。
       *
       * 理由不只是"体验差"：
       *   · 他刚打了一段字，跳走之后**草稿没了**（面板被重建）
       *   · 跳去「我的」页也解决不了"没选角色"—— 那里没有选角色的入口
       *     （选角色在聊天页顶栏的 ☰ 里）
       *
       * 所以真正的可操作提示是"去点 ☰ 选角色"，而不是"去看 API 配置"。
       */
      this.callbacks.onNotify?.('先选一个角色：点右上角 ☰ 里挑一个。', 'warn');
      return;
    }

    const base: StChatMessage = {
      name: this.ctx.userName,
      is_user: true,
      send_date: new Date().toISOString(),
      mes: trimmed,
    };
    /*
     * 语音标记走 `setVoiceFlag`（纯逻辑，有 round-trip 契约测试）——
     * 不在这里手写 `extra.tcs.voice = true`。手写的话，
     * "命名空间用 tcs 还是 tcs.voice"这种决定就散成了两处。
     */
    const message =
      voice?.voice === true ? setVoiceFlag(base, true, voice.durationMs) : base;

    /*
     * ★ 必须在插入之前记 —— 插入之后 scrollHeight 就变了，判据会失效。
     *
     * ★★ 同时打开 `forceFollow`（2026-11-03 第二十五批）：
     * 用户发消息是"我要往下看"的明确信号 —— 哪怕他刚才在翻历史，
     * 也该跟随到底。这正是用户报的「发了消息后没有自动滚动」。
     */
    this.forceFollow = true;
    this.markStick();
    this.messages = [...this.messages, message];
    this.render();
    /*
     * 用户消息落定就通知一次：用户的心智是"我发出去了，它就该在"。
     * 等 assistant 回复完再存的话，如果回复过程中被杀进程，这条用户消息就没了。
     */
    this.callbacks.onChatChanged?.(this.messages);
    await this.generate(false);
  }

  /** 重新生成：弹出最后一条 assistant，作为候选重新生成 */
  /**
   * 取当前消息的**副本**（2026-11-03，给「保存检查点」等外壳动作）。
   *
   * 返回副本而不是引用：外壳拿去存盘/建群，不该顺手改到面板的内部状态。
   */
  getMessages(): StChatMessage[] {
    return this.messages.slice();
  }

  /**
   * 用一条临时 system 指令跑一次生成（AI 帮答 / 续写）。
   *
   * ## 为什么复用 `generate()` 而不是另写一条流式链路
   *
   * 那条链路里已经处理了：上下文拼装、世界书激活、占位消息、流式 patch、
   * 收尾持久化、失败清理。另写一份的话这六件事都要再实现一遍，
   * 而**任何一处不同都会让"帮答"和"正常回复"的行为分叉**。
   *
   * 所以只加一个"临时指令"参数，其余完全同一条路。
   */
  async runDirective(instruction: string): Promise<void> {
    if (this.avatar === null) {
      this.callbacks.onNotify?.('先选一个角色。', 'warn');
      return;
    }
    await this.generate(false, -1, instruction);
  }

  /**
   * 重新生成：把最后一条回复作为一个**新候选**重写。
   *
   * ## ★★★ 2026-11-05 修：三个会丢内容的缺陷
   *
   * ### ① 旧回复被覆盖，不是"新增候选"
   *
   * 原来这里把消息弹出来、生成完**直接换掉 `mes`**（走 `generate` 的普通分支），
   * 于是旧的 `swipes` 数组连同旧正文一起丢掉。用户点一下 ↻ 就再也滑不回去，
   * 而界面上有候选指示器（`1 / 2`）—— 说明"多候选"是设计好的形态，
   * `appendSwipe` 也一直在 `shared` 里，只是**从来没被调用过**。
   *
   * 现在把被弹出的那条当 `restoreTarget` 传下去，成功后走 `appendSwipe`：
   * 旧正文落成 `swipes[0]`，新正文追加在后面。
   *
   * ### ② 失败就把回复删了
   *
   * `generate` 里有两条失败路径（拼请求失败、空输出），原来都只处理占位消息：
   * 前者直接 return，后者删掉占位 —— 但**被弹出的原消息早就从 `this.messages`
   * 里消失了**，两条路径都不会把它放回去。表现是"点重新生成，报个错，上一条回复没了"。
   * 空输出那条更狠：它还会 `onChatChanged`，把这个删除**落盘**。
   *
   * 现在失败一律还原 `restoreTarget`。
   *
   * ### ③ 没有并发守卫（用户报的那个"语音 + 重新生成"就是这个）
   *
   * 原来点 ↻ 不判断"是否正在生成"。语音转写慢的时候，用户会以为卡住了去点 ↻，
   * 于是**两路生成同时在跑**：`this.handle` 被后一次覆盖，前一次的 `done` 回调
   * 继续往 `targetIndex` 写正文 —— 而那时消息数组已经被后一次改过长度，
   * 正文会写到错的气泡里，或者两边同时失败报"连不上"。
   *
   * 语音那条路径（`sendText`）同样没有守卫，两条入口一起堵。
   */
  async regenerate(): Promise<void> {
    /*
     * 守卫放在**最前面**：一旦已经开始弹消息，再判断就晚了 ——
     * 数组已经被改动，拦下来也要还原。
     */
    if (isBusy(this.stream)) {
      this.callbacks.onNotify?.('正在回复中，等这一条写完再重新生成。', 'warn');
      return;
    }
    const popped = popLastAssistant(this.messages);
    if (popped.target === null) {
      this.callbacks.onNotify?.('还没有可以重新生成的内容', 'warn');
      return;
    }
    this.messages = popped.history;
    this.render();
    /*
     * 把被弹出的那条**带下去**，而不是只带下标 ——
     * 生成失败时它要被原样放回来（见 ②）。只带下标的话，
     * 失败路径根本拿不回原文。
     */
    await this.generate(true, popped.index, undefined, popped.target);
  }

  /** 继续：把最后一条 assistant 当 prefill 接着写 */
  async continue(): Promise<void> {
    await this.generate(true);
  }

  /**
   * 读上一次生成实际用了多少 token（给「AI 响应配置」页显示）。
   *
   * `null` = 还没生成过。**不用 0 表示"还没生成"** ——
   * 界面会把它显示成"上次用了 0 token"，那是假信息。
   */
  tokenUsage(): { used: number; budget: number; trimmed: number } | null {
    return this.lastTokenUsage;
  }

  /**
   * 按预算裁剪消息，并用**真实**分词器数 token（失败回退估算）。
   *
   * ## 为什么单独一个方法
   *
   * `generate()` 主线已经很长（拼装、生成、流式、落盘），再塞进
   * "数 token + 缓存 + 回退"会让人读不出主线。而且这段逻辑本身
   * 有独立的三条分支（预算无效 / 必留超限 / 正常裁剪），值得单独测。
   *
   * ## 计数为什么走"一次性批量"
   *
   * ST 的 `/api/tokenizers/openai/count` 接受**消息数组**，一次请求就把
   * 所有消息数完。逐条请求会把"发一条消息"变成"等 N 次往返" ——
   * 10 条历史就是 10 个 RTT，明显卡。
   *
   * 但 `applyTokenBudget` 需要**逐条**的价格才能判断"哪条放不下"。
   * 所以：批量请求拿总数（给界面显示），逐条价格走缓存 + 估算兜底。
   * 这样精度和延迟兼顾 —— 裁剪决策对精度的要求低于"总数准不准"。
   */
  private async applyBudget(
    messages: ReadonlyArray<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    trimmable: readonly boolean[],
    /*
     * 「预算紧张时优先整块丢掉」的标记（与 messages 等长，可选）。
     * 目前只有对话示例为 true —— 语义见 `token-budget.ts` 的 `dropFirst`。
     */
    dropFirst?: readonly boolean[],
  ): Promise<{
    dropped: { messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>; trimmedCount: number; used: number };
    used: number;
    budget: number;
    overBudget: boolean;
    requiredTokens: number;
  }> {
    const budget = computeBudget(this.ctx.contextLimit, this.ctx.responseLimit);

    /*
     * 逐条价格：先用缓存/估算。
     *
     * 估算在这里**够用**：裁剪只是决定"保留最近几轮"，
     * 差 10% 通常是多留或少留一条，影响远小于"完全不裁"。
     * 而精确计数的往返成本是实打实的。
     */
    const priceOf = (text: string): number => {
      const key = this.tokenCacheKey(text);
      const hit = this.tokenCache.get(key);
      if (hit !== undefined) return hit;
      const guess = estimateTokens(text);
      this.putTokenCache(key, guess);
      return guess;
    };

    const result = applyTokenBudget({
      messages,
      trimmable,
      budget,
      countTokens: priceOf,
      ...(dropFirst === undefined ? {} : { dropFirst }),
    });

    /*
     * 异步补一次**精确**总数（给界面显示与排查）。
     *
     * 失败就沿用估算值 —— 绝不能因为"数不准"而中断发送。
     */
    let used = result.usedTokens;
    try {
      const batch = result.messages.map((one) => ({ role: one.role, content: one.content }));
      const exact = await this.bridge.countTokens(this.ctx.model, JSON.stringify(batch));
      if (typeof exact === 'number' && Number.isFinite(exact) && exact >= 0) {
        used = exact;
      }
    } catch {
      /* ST 没起来 / 分词器加载失败 ⇒ 用估算值 */
    }

    this.lastTokenUsage = { used, budget: result.budget, trimmed: result.droppedCount };

    return {
      dropped: {
        messages: result.messages.map((one) => ({ role: one.role, content: one.content })),
        trimmedCount: result.droppedCount,
        used,
      },
      used,
      budget: result.budget,
      overBudget: result.overBudget,
      requiredTokens: result.requiredTokens,
    };
  }

  /** 计数缓存的键（理由见 `tokenCache` 的注释） */
  private tokenCacheKey(text: string): string {
    if (text.length <= 128) return `${this.ctx.model}\u0000${text}`;
    return `${this.ctx.model}\u0000${String(text.length)}\u0000${text.slice(0, 64)}\u0000${text.slice(-64)}`;
  }

  private putTokenCache(key: string, value: number): void {
    if (this.tokenCache.size >= ChatPanel.TOKEN_CACHE_LIMIT) this.tokenCache.clear();
    this.tokenCache.set(key, value);
  }

  /**
   * 走一次生成。
   *
   * @param asSwipe true = 结果作为新候选追加（重新生成/继续）；false = 新消息
   * @param insertAt 追加候选时插回原位置（重新生成时那条消息被弹出了）
   * @param directive 临时 system 指令（AI 帮答 / 续写）
   * @param restoreTarget 被弹出的那条原消息（2026-11-05）。
   *   成功后用它做 `appendSwipe` 的底（旧正文落成第一个候选）；
   *   **失败时必须把它原样放回数组**，否则一次失败就永久少一条回复。
   */
  private async generate(
    asSwipe: boolean,
    insertAt = -1,
    directive?: string,
    restoreTarget?: StChatMessage,
  ): Promise<void> {
    /*
     * 上下文拼装：**复用 `shared` 的 `assembleContext`**（决策 #270）。
     * 世界书激活也在里面（`activeEntriesInOrder`），这里不许另算一遍 ——
     * 否则用户在编辑器里看到 12 条激活、聊天时只进去 9 条，而两边都"有测试"。
     */
    /*
     * 卡片类型在这里收窄一次，之后到处复用。
     *
     * `this.ctx.card` 是 `Record<string, unknown>`（面板不认识卡片模型）；
     * 断言集中在这一行，而不是在下面每个调用点各写一次 —— 那样改卡片模型时
     * 要改 N 处，且容易漏掉其中一处让类型从缝里漏过去。
     */
    const card = this.ctx.card as unknown as Parameters<typeof assembleContext>[0]['card'];
    const base = asSwipe
      ? buildContinueInput({ card, history: this.messages })
      : { card, history: this.messages };

    /*
     * `card` 在面板里是 `Record<string, unknown>`（它来自外壳，面板不认识卡片模型），
     * 而 `assembleContext` 要 `StCardData`。这里做一次显式断言 ——
     * 校验卡片形状是 `shared` 的 `sanitize` 与审计链路的职责，不是聊天面板的。
     *
     * `persona` 而不是 `userName`：`ContextInput` 的用户人设是一个对象
     * `{ name, description }`，只给名字的话 `description` 段就没有内容 ——
     * 而"用户人设"在 ST 里是独立的一段，不是名字的别名。
     *
     * `worldbook` 显式传：`assembleContext` 不会自己去 `card.character_book` 里翻，
     * 因为它允许调用方**合并卡片外置条目**。不传的话世界书一条都不会激活，
     * 而界面看起来完全正常（只是回复"好像不记得设定"）—— 这种静默失效最难查。
     */
    const worldbook = readWorldbookEntries(this.ctx.card);

    /*
     * 两条拼装路径（2026-11-03）：
     *
     *   · **有提示词配置** → `assembleWithPrompts`，按用户的
     *     `prompts` + `prompt_order` 逐条拼（12 个内置槽 + 任意自定义项），
     *     role / 顺序 / 深度注入全部照配置走；
     *   · **没有配置** → 回退到旧的 `assembleContext`（固定顺序的单条 system）。
     *
     * ## 为什么必须有回退
     *
     * 用户可能还没在 ST 里保存过任何预设（`prompts` 为空），
     * 也可能读设置失败。这两种情况下**聊天必须照常能用** ——
     * 发一个空上下文比用旧逻辑更糟（模型完全不知道在扮演谁）。
     *
     * 判据：`test/prompt-manager-wiring.test.mjs` 分别覆盖两条路径。
     */
    const promptConfig = this.ctx.promptConfig ?? null;
    const usePromptManager = promptConfig !== null && promptConfig.prompts.length > 0;

    const assembled = usePromptManager
      ? assembleWithPrompts({
          card: base.card,
          history: base.history,
          /*
           * 名字来自 `userName`，描述/位置来自 `persona`（2026-11-04）。
           *
           * 两者有一个就传 —— 只改名不写描述是常见用法，
           * 而只写描述不填名字也要能生效（名字退化成默认）。
           */
          persona:
            this.ctx.userName === '' && this.ctx.persona === undefined
              ? undefined
              : { name: this.ctx.userName, ...this.ctx.persona },
          worldbook,
          config: promptConfig,
          /*
           * 不传 `userMessage`：用户刚发的那条**已经 push 进 `this.messages`**
           * （见上面的占位逻辑），所以它在 `history` 里，
           * 会由 `chatHistory` 标记位正常展开。
           *
           * 再传一次会出现两条一样的用户消息 —— 模型会以为用户说了两遍。
           */
          ...(this.ctx.authorNote === undefined ? {} : { authorNote: this.ctx.authorNote }),
          newExampleChatPrompt: this.ctx.promptFormats?.newExampleChatPrompt,
          scenarioFormat: this.ctx.promptFormats?.scenarioFormat,
          personalityFormat: this.ctx.promptFormats?.personalityFormat,
          wiFormat: this.ctx.promptFormats?.wiFormat,
        })
      : assembleContext({
          card: base.card,
          history: base.history,
          persona: this.ctx.userName === '' ? undefined : { name: this.ctx.userName },
          worldbook,
        });

    /*
     * 额外指令（2026-11-03，给「AI 帮答」「续写」用）。
     *
     * ## 为什么作为 system 消息插在**最前**而不是塞进用户消息
     *
     * 塞进用户消息会落进 `this.messages` —— 用户回看时会看到一条自己
     * 从没打过的"（请以旁白口吻给建议）"，而且它会永久留在聊天记录里。
     *
     * 放在 system 里只影响这一次请求：请求结束就没了，
     * 历史仍然是用户真实说过的话。
     */
    const messagesForRequest =
      directive === undefined || directive === ''
        ? assembled.messages
        : [{ role: 'system' as const, content: directive }, ...assembled.messages];

    /*
     * token 预算裁剪（2026-11-03，第十九批 ④）。
     *
     * ## 为什么必须做
     *
     * 上下文窗口是硬上限。之前我们**完全不裁** —— 长对话必然超，
     * 现象是"聊久了就报错"或"后面越来越不记得"，
     * 而这两种都极难联想到"没算 token"。
     *
     * ## 计数走真实的 ST 分词器，失败回退估算
     *
     * 真实的比估算准得多（尤其换模型时）。但 ST 没起来、或分词器加载失败时
     * 不能因此卡住聊天 —— 回退到 `estimateTokens`（字节数 ÷ 3.35，与 ST 同款）。
     *
     * ## 为什么预算为 0 就不裁
     *
     * `openai_max_context` 没填时是 0。这时裁成空上下文比超一点更糟 ——
     * 模型完全不知道在演谁。`applyTokenBudget` 里对 0 已经有保护。
     */
    const budgetMessages = messagesForRequest.map((one) => ({
      role: one.role as 'system' | 'user' | 'assistant',
      content: one.content,
    }));

    /*
     * 因为多插了一条 system 指令（若有），`trimmable` 要跟着左移一位。
     * 漏掉这一步会让标记**整体错位一格** ——
     * 表现为"裁掉了不该裁的那条"，而且是静默的。
     */
    const trimmableFlags =
      directive === undefined || directive === ''
        ? [...assembled.trimmable]
        : [false, ...assembled.trimmable];

    /*
     * 与 `trimmableFlags` 同一个理由左移一位：插入 system 指令后，
     * 标记数组必须同步偏移，否则"哪条是示例"会整体错位一格 ——
     * 表现是**裁掉了开场白提示词却留下示例**，而且静默。
     */
    const dropFirstFlags =
      directive === undefined || directive === ''
        ? [...assembled.dropFirst]
        : [false, ...assembled.dropFirst];

    const budgeted = await this.applyBudget(budgetMessages, trimmableFlags, dropFirstFlags);
    if (budgeted.overBudget) {
      /*
       * 必留项自己就超了：这时裁什么都是错的（裁也放不下）。
       * 必须**告诉用户**，否则他看到的是"发出去报错"，
       * 而我们本可以提前说"你的提示词加起来就超过上下文了，去关掉几条"。
       */
      this.callbacks.onNotify?.(
        `提示词加起来 ${String(Math.round(budgeted.requiredTokens))} token，超过上下文预算 ${String(budgeted.budget)}。到「聊天设置 → AI 响应配置」里关掉几条。`,
        'warn',
      );
    }
    if (budgeted.dropped.trimmedCount > 0) {
      /*
       * 裁掉历史后**必须说一句**。
       *
       * 不说的话，用户会以为"AI 记性变差了" —— 而实际是我们主动丢了
       * 最早的几轮来保住最近的语境。一句话就能把这件事从"缺陷"变成"预期"。
       */
      this.callbacks.onNotify?.(
        `上下文超出预算，已略过最早 ${String(budgeted.dropped.trimmedCount)} 条对话（保留最近的）。`,
        'info',
      );
    }

    const finalMessages = budgeted.dropped.messages;

    const built = buildGenerateRequest({
      source: this.ctx.source,
      model: this.ctx.model,
      messages: finalMessages,
      /*
       * ★ 思考意图与长度并进采样参数（2026-11-07，P0 第三步）。
       *
       * 为什么在这里合并而不是让 ctx.sampling 也带一份：
       * `ctx.sampling` 是从 ST 设置读来的（`seedSampling` 会整批覆盖它），
       * 而思考意图存在本机偏好里、由设置页实时推送。
       * 两者生命周期不同，混在一起会被 `seedSampling` 抹掉。
       */
      sampling: mergeReasoningSampling(
        this.ctx.sampling as SamplingParams,
        {
          intent: this.ctx.thinking?.intent ?? 'auto',
          budget: this.ctx.thinking?.budget,
          ...(this.ctx.thinking?.family === undefined
            ? {}
            : { family: this.ctx.thinking.family }),
        },
      ) as Parameters<typeof buildGenerateRequest>[0]['sampling'],
      // 自定义地址随请求体带（服务端不读设置）
      customUrl: this.ctx.baseUrl,
      prefill: 'prefill' in base ? (base.prefill as string) : undefined,
    });

    if (!built.ok) {
      /*
       * ★ 先把被弹出的原消息放回去，再报错（2026-11-05）。
       *
       * 这条路径最常见的原因是"没配 API / 模型名为空 / 源不支持"。
       * 此时用户什么都没得到，而原来的回复已经不在 `this.messages` 里了 ——
       * 不还原的话，界面上那条回复**直接消失**，用户以为被删了。
       *
       * 报错在前、还原在后的顺序是错的：`onNotify` 同步弹提示，
       * 用户看到提示的同时列表里那条还没回来。
       */
      if (restoreTarget !== undefined) this.restorePoppedMessage(restoreTarget, insertAt);
      this.callbacks.onNotify?.(built.message, 'danger');
      if (built.reason === 'unsupported-source' || built.reason === 'empty-model') {
        this.callbacks.onNeedApiConfig?.();
      }
      return;
    }

    // 先放一条空的 assistant 占位，流式往里写
    const placeholder: StChatMessage = {
      name: String(this.ctx.card['name'] ?? ''),
      is_user: false,
      send_date: new Date().toISOString(),
      mes: '',
    };
    const targetIndex = asSwipe && insertAt >= 0 ? insertAt : this.messages.length;
    /*
     * 回复开始也要跟（2026-11-03 第二十五批）：占位气泡接在用户消息下面，
     * 不跟的话用户看不到"它开始回答了"。
     */
    this.forceFollow = true;
    this.markStick();
    const next = this.messages.slice();
    next.splice(targetIndex, 0, placeholder);
    this.messages = next;

    this.stream = startStreaming();
    this.render();
    this.syncSendButton();

    /*
     * ★★★ 必须接住"桥自己抛异常"（2026-11-05，真机验收抓到的）。
     *
     * `bridge.generate` 在**注册监听**那一步就可能抛（`listen` 失败、
     * invoke 被拒绝……），`handle.done` 也可能 reject。这些异常如果不在
     * 这里接住，会一路冒到 `regenerate()` 外面：
     *
     * ```text
     *   generate() 抛出
     *     ├─ 下面的 finalizeOutput / 失败分支 **整段被跳过**
     *     └─ 于是 restorePoppedMessage 永远不执行
     *   ⇒ 被弹出的那条回复永久消失（消息数 48 → 47）
     * ```
     *
     * 这不是推理，是 `.verify/probe-regenerate.mjs` 在真机上量到的：
     * 点一次 ↻，消息从 48 条变 47 条，最后一条换成了上一条，
     * 落盘文件里既没有 `swipes` 也没有新增消息 —— 与"弹出后什么都没插回"
     * 完全一致。
     *
     * 顺带把 `this.stream` 复位：抛出时它停在 `startStreaming()`，
     * `isBusy` 会一直是 true，按钮就永久置灰了。
     */
    let thrown: string | null = null;
    try {
      this.handle = await this.bridge.generate(
        built.request as unknown as Record<string, unknown>,
        this.ctx.source,
        {
          onState: (state) => {
            this.stream = state;
            // 只更新占位那条的正文，不整表重渲染 —— 否则每一帧都重建整屏 DOM
            this.patchStreamingMessage(targetIndex, state);
          },
        },
      );

      await this.handle.done;
    } catch (error) {
      /* `describeBridgeError` 返回 `{ kind, message }` —— 只取 message（要显示给用户的那句） */
      thrown = describeBridgeError(error).message;
      this.stream = createStreamState();
    }

    // 收尾
    const output = finalizeOutput(this.stream);
    if (thrown !== null || !output.ok) {
      /*
       * 空输出是真实失败。分两种情况处理（2026-11-05）：
       *
       *   · 普通发送/续写 → 删掉占位（它本来就没内容，留着是个空气泡）
       *   · 重新生成     → **把被弹出的原回复放回去**，不是删占位就完事
       *
       * 第二种原来也走"删占位"，而原回复早在 `regenerate()` 里被弹出了 ——
       * 于是"删占位"实际删掉的是用户唯一的那条回复，接着
       * `onChatChanged` 把它**落盘**。这是本轮最严重的一条：一次失败的
       * 重新生成会让上一条回复永久消失。
       */
      if (restoreTarget !== undefined) {
        this.restorePoppedMessage(restoreTarget, insertAt);
      } else {
        const cleaned = this.messages.slice();
        cleaned.splice(targetIndex, 1);
        this.messages = cleaned;
        this.render();
      }
      /*
       * 报错文案优先用抛出来的那条：走到这里时 `this.stream` 已经被复位成
       * 空状态（`createStreamState()`），`stream.error` 是 null，
       * `output.message` 只会给出"没有拿到内容"这种笼统话 ——
       * 而桥的异常信息（"连不上 SillyTavern"之类）才是可排查的那条。
       */
      this.callbacks.onNotify?.(thrown ?? this.stream.error ?? output.message, 'danger');
      this.syncSendButton();
      /*
       * 只在"没还原"时才通知外壳存盘：还原之后内容与盘上一致，
       * 再存一次会让用户以为发生了写入（也会白改一次指纹）。
       */
      if (restoreTarget === undefined) this.callbacks.onChatChanged?.(this.messages);
      return;
    }

    /*
     * ★★★ 成功后：`asSwipe` 走 `appendSwipe`，不许直接改 `mes`（2026-11-05）。
     *
     * 直接改 `mes` 会把旧的 `swipes` 丢掉 —— 用户点一次 ↻ 就再也滑不回
     * 上一版。`appendSwipe` 在 `shared` 里一直有（有 round-trip 契约测试），
     * 但**从来没被调用过**：面板这边一直是覆盖式写入。
     *
     * `appendSwipe` 首次追加时会把原 `mes` 自动落成 `swipes[0]`，
     * 所以这里只要把 `restoreTarget` 交给它，旧正文就保住了。
     */
    const settled = this.messages.slice();
    if (asSwipe && restoreTarget !== undefined) {
      settled[targetIndex] = appendSwipe(restoreTarget, output.text, {
        sendDate: new Date().toISOString(),
      });
    } else {
      settled[targetIndex] = { ...this.messages[targetIndex]!, mes: output.text };
    }
    this.messages = settled;

    if (this.stream.error !== null) {
      this.callbacks.onNotify?.(this.stream.error, 'danger');
    }
    /*
     * ★★★ 收尾**不再整表重渲染**（2026-11-02 用户报"黑屏一瞬"）。
     *
     * 原来这里调 `this.render()`，而 `render()` 第一行是
     * `listEl.replaceChildren()` —— 把整屏消息**清空**再重新插入。
     * 消息多的时候那一帧就是一片空白，用户看到的就是"黑屏一瞬（像刷新）"，
     * 而且滚动位置在重建过程中丢掉，得手动滑一下才回到最新。
     *
     * 收尾时真正需要变的只有两件事：
     *   ① 占位那条的正文（流式已经 patch 到底了，这里补最后一次）
     *   ② 去掉呼吸点
     * 两件都能在**原元素上**改完，不需要重建。
     */
    this.patchStreamingMessage(targetIndex, {
      ...this.stream,
      text: output.text,
    });
    /*
     * 新候选的指示器（`2 / 3`）要跟着出现。
     *
     * 不重渲染整表（会黑屏一瞬），所以就地补 —— 这条只在
     * `asSwipe && restoreTarget` 时才有，普通发送没有候选。
     */
    if (asSwipe && restoreTarget !== undefined) {
      const now = settled[targetIndex];
      if (now !== undefined) this.patchSwipeIndicator(targetIndex, now);
    }
    /* 收尾后强制贴底一次：哪怕流式中途用户往上翻了，回复完成也应看到结尾 */
    const listForSettle = this.listEl as unknown as {
      scrollHeight?: number;
      scrollTop?: number;
    } | null;
    if (listForSettle !== null && typeof listForSettle.scrollTop === 'number') {
      listForSettle.scrollTop = listForSettle.scrollHeight ?? 0;
    }
    this.syncSendButton();
    /*
     * assistant 回复完成 —— 用户要求"每条回复完成后即保存"。
     * 放在 `render()` 之后：此时 `this.messages` 已经是最终形态（含正文）。
     */
    this.callbacks.onChatChanged?.(this.messages);
  }

  /**
   * 把"被弹出准备重新生成"的那条原样放回数组（2026-11-05）。
   *
   * ## 为什么需要它
   *
   * `regenerate()` 先把最后一条 assistant 从 `this.messages` 里**弹出**
   * （`popLastAssistant`），再发起生成。生成有两条失败路径，两条都必须
   * 把它放回去 —— 否则一次失败 = 少一条回复，而且其中一条路径还会
   * 顺手落盘，变成永久丢失。
   *
   * ## 为什么按 `index` 插回而不是 push 到末尾
   *
   * 下标是弹出时记的。生成期间理论上不会有别的消息插进来（入口都加了
   * 并发守卫），但**夹到合法范围**仍然是必要的：`splice` 对越界下标的
   * 行为和直觉相反（超出长度会追加到末尾，负数从尾部算），
   * 这里显式夹一次，出错时只是位置偏一点，不会插到数组外面去。
   */
  private restorePoppedMessage(target: StChatMessage, index: number): void {
    const next = this.messages.slice();
    const at = Math.max(0, Math.min(next.length, index));
    next.splice(at, 0, target);
    this.messages = next;
    this.render();
    this.syncSendButton();
  }

  /**
   * 就地刷新某条消息的候选指示器（`2 / 3`）。
   *
   * ## 为什么不重渲染
   *
   * 收尾时整表重渲染会让消息多的时候闪一下白屏（§2026-11-02 那条）。
   * 这里只需要改一个很小的数字，走 DOM 定位即可。
   *
   * ## 结构
   *
   * ```text
   *   .nb-msg[data-msg-index] > div > [ .nb-msg-meta ]
   * ```
   *
   * `.nb-msg-meta` 在**内层 div** 里（与气泡同级），不在 `.nb-msg` 直接下面 ——
   * 所以要先取内层 div 再找。找不到就**新建一个并 append**：
   * 第一次重新生成时原本只有一条消息，指示器压根不存在。
   */
  private patchSwipeIndicator(index: number, message: StChatMessage): void {
    const list = this.resolveMsgList();
    if (list === null) return;
    const want = String(index);
    const row = Array.from(list.children).find(
      (child) => child.getAttribute('data-msg-index') === want,
    ) as ElLike | undefined;
    if (row === undefined) return;

    /*
     * `.nb-msg` 只有**一个**子节点：那个内层 `div`（见 `chat-view.ts` 的
     * 结构注释）。气泡、语音条、meta 都在它里面。所以取 `[0]` 就是它 ——
     * 不靠 className 猜（内层 div 没有类名，按类名找会命中别的元素）。
     */
    const column = Array.from(row.children)[0];
    if (column === undefined) return;

    const label = `${String(currentSwipeIndex(message) + 1)} / ${String(swipeCount(message))}`;
    const existing = Array.from(column.children).find((child) =>
      child.className.includes('nb-msg-meta'),
    );
    if (existing !== undefined) {
      /* meta 里除了指示器还有时间，只改指示器那一格 */
      const indicator = Array.from(existing.children).find((child) =>
        child.className.includes('nb-swipe-indicator'),
      );
      if (indicator !== undefined) {
        indicator.textContent = label;
        return;
      }
      const fresh = el(this.doc, 'span', 'nb-swipe-indicator');
      fresh.setAttribute('data-role', 'swipe-indicator');
      fresh.textContent = label;
      existing.append(fresh);
      return;
    }

    const meta = el(this.doc, 'div', 'nb-msg-meta');
    const indicator = el(this.doc, 'span', 'nb-swipe-indicator');
    indicator.setAttribute('data-role', 'swipe-indicator');
    indicator.textContent = label;
    meta.append(indicator);
    column.append(meta);
  }

  /** 只更新流式那一条的正文 */
  private patchStreamingMessage(index: number, state: StreamState): void {
    if (this.listEl === null) return;
    /*
     * `children` 是 `HTMLCollection`（见 `chat-view.ts` 的类型注释）——
     * 必须 `Array.from` 才能用 `.find()`。直接写 `.children.find()` 会
     * 抛 `TypeError`，而那个异常**每帧一次**，界面上一个字都不会出来。
     */
    const list = this.resolveMsgList();
    if (list === null) return;
    /*
     * ★ 同样按 `data-msg-index` 属性找（2026-11-02）。
     *
     * 与 `patchMessageText` 同一个理由：`list.children[index]` 会被
     * 草稿卡 / 空状态这类非消息节点挤错位。流式时错位的表现是
     * "文字长在别的气泡里"，比完全不更新更难查。
     */
    const want = String(index);
    const target = Array.from(list.children).find(
      (child) => child.getAttribute('data-msg-index') === want,
    );
    if (target === undefined) return;
    /* 同样用 bubbleOf —— 语音消息在 .nb-bubble 之前还有一层 .nb-voice-bubble */
    const bubble = bubbleOf(target as ElLike);
    if (bubble === null) return;
    /*
     * ★ 必须走 `renderMessageHtml`，**不许直接把 state.text 塞进 innerHTML**。
     *
     * 2026-10-30 自查发现的真实漏洞：第一版写的是
     *   `bubble.innerHTML = state.text`
     * 而 `state.text` 是 **LLM 返回的原文**，未经转义。只要模型吐出
     * `<img src=x onerror=...>`，流式过程中就会当场执行 ——
     * 而结束后的 `render()` 用的是 `renderMessageHtml`（已转义），
     * 所以只有**流式那一两秒**有漏洞。这种"只在中间态存在"的漏洞
     * 用"结束后看结果"的方式完全测不出来。
     *
     * 走同一个渲染函数还顺带解决另一个问题：流式期间标记（`*斜体*`）
     * 就会渲染，不会先显示一堆星号再突然变。
     */
    /*
     * ★★★ 正文为空但**有思维链**时，把思维链显示出来（2026-11-02）。
     *
     * ## 为什么
     *
     * 推理模型（`deepseek-v4-pro` 等）先吐 `reasoning_content`、后吐 `content`。
     * 真机实测：302 帧全是思维链、正文一个字没有 —— 而这一行原来只看
     * `state.text`，所以气泡**一直是空的**，用户看到"一个空泡 + 一个呼吸点"
     * 十几秒，完全不知道后台在干活（录屏里就是这样）。
     *
     * 显示出来至少能证明"它在动"，而不是像卡死。
     *
     * ## 为什么用 `.nb-thinking` 这个类而不是直接写文本
     *
     * 思维链是**过程**不是回复，样式要能区分（暗色、斜体、带前缀）。
     * 直接混进正文会让用户以为那就是回复内容。
     */
    if (state.text === '' && state.reasoning !== '') {
      const think = el(this.doc, 'div', 'nb-thinking');
      think.setAttribute('data-role', 'thinking-preview');
      /*
       * ★★★ 两种模式（2026-11-05 用户要求）
       *
       * > 在 AI 响应里面做一个开关，打开显示完整思考链，
       * > 关闭就只显示思考回复中
       *
       * ```text
       *   开：显示**完整**思考链（累加，不截断）
       *   关：只显示「思考中…」+ 呼吸点，一个字都不透
       * ```
       *
       * ## 为什么"关"时连尾部 240 字也不给
       *
       * 原来是"思考中… + 最后 240 字"。那是折中：既证明它在动、
       * 又不至于铺满屏幕。但用户明确要"关闭就只显示思考回复中" ——
       * 折中状态在他看来就是"没关"。
       *
       * 而且尾部的字在快速刷新时是**跳动**的（每帧都在换末尾），
       * 想读也读不清，反而是噪音。
       *
       * ## 为什么"开"时不截断
       *
       * "完整思考链"就要完整。截断会让用户以为模型只想了这么点，
       * 或者以为后面被吞了 —— 而这正是他要开这个开关的原因。
       */
      if (this.showReasoning) {
        think.textContent = `思考中…\n${state.reasoning}`;
        /* 完整内容要能滚、能选，样式在 `.nb-thinking[data-full='true']` */
        think.setAttribute('data-full', 'true');
      } else {
        think.textContent = '思考中…';
        think.setAttribute('data-full', 'false');
      }
      bubble.replaceChildren(think);
      /*
       * ★ `replaceChildren` 会**连呼吸点一起清掉**（它是 bubble 的子节点）。
       *
       * 后果有两个，都很隐蔽：
       *   · 视觉上"思考中"却没有那个跳动的点，看起来像停了
       *   · 自动化探针靠 `.nb-breathing` 判断"还在生成"，它消失了就会被
       *     判成"已结束"（我第一次验证就是这么误判的）
       *
       * 所以清完要按当前状态把点补回来。
       */
      if (showsCaret(state)) {
        const dot = el(this.doc, 'span', 'nb-breathing');
        dot.setAttribute('aria-label', '正在生成');
        bubble.append(dot);
      }
    } else {
      bubble.innerHTML = state.text === '' ? '' : renderMessageHtml(state.text, {
        charName: String(this.ctx.card['name'] ?? ''),
        userName: this.ctx.userName,
      });
    }
    // 呼吸点跟着状态走（收尾时也要**去掉**，不能只加不删）
    const hasDot = Array.from(bubble.children).some((child) =>
      child.className.includes('nb-breathing'),
    );
    if (showsCaret(state) && !hasDot) {
      const dot = el(this.doc, 'span', 'nb-breathing');
      bubble.append(dot);
    } else if (!showsCaret(state) && hasDot) {
      for (const child of Array.from(bubble.children)) {
        if (child.className.includes('nb-breathing')) child.remove();
      }
    }

    /*
     * ★★★ 跟随滚动（2026-11-02 用户报"角色回复的气泡不会自己滚动"）。
     *
     * 这个函数原来**只改文本、不滚动**。于是流式期间：
     * 气泡一个字一个字变长，而视口纹丝不动 —— 回复长出去几百像素后，
     * 用户得手动滑才能看到最新内容。
     *
     * 判据用 `shouldStick`（用户已经往上翻看历史时**不要**拽回来），
     * 而不是无条件贴底。
     */
    this.stickToBottomIfNeeded();
  }

  /**
   * 用户还贴着底就滚到底；已经翻上去看历史就别动他。
   *
   * 每次流式片段都会调一次，所以这里**不能用 `behavior: 'smooth'`** ——
   * 平滑动画彼此打断，长回复时会一直在"追"目标、像卡住一样。
   * 直接设 `scrollTop` 是跟手且无动画的。
   */
  /**
   * 拿到真正的消息列表容器。
   *
   * `this.listEl` 在 `mount()` 里就是 `.nb-msglist`（带 `data-role='msglist'`），
   * `renderMessageList` 是渲染**进**它、不在里面再套一层。
   *
   * 所以这里先看它自己，兼容"某天它变成了外层包装"的情况再往下找一层。
   * 两层都判断，是为了让"结构若变化"时**降级成能工作**而不是静默失效 ——
   * 原来的写法正是"只在 children 里找"，结构一变就整段死掉，
   * 而症状（文字不更新）与"代码没写"完全一样。
   */
  private resolveMsgList(): ElLike | null {
    if (this.listEl === null) return null;
    if (this.listEl.getAttribute('data-role') === 'msglist') return this.listEl;
    const inner = Array.from(this.listEl.children).find(
      (child) => child.getAttribute('data-role') === 'msglist',
    );
    return inner ?? this.listEl;
  }

  private stickToBottomIfNeeded(): void {
    const list = this.listEl as unknown as
      | { scrollHeight?: number; clientHeight?: number; scrollTop?: number }
      | null;
    if (list === null || typeof list.scrollTop !== 'number') return;

    /*
     * ★ 强制跟随期间**无条件**贴底（2026-11-03 第二十五批）。
     *
     * 用户要求"角色回复气泡时跟随滚动" —— 回复正在长出来时就要跟着走，
     * 而不是"只有原本贴在底部才跟"。否则他发完消息切去看了眼别处再回来，
     * 回复已经长出去了，视口还停在上面。
     *
     * 用户手指一碰列表 `forceFollow` 就变 false，这里就退回条件判断，
     * 他想翻历史时不会被抢。
     */
    if (!this.forceFollow) {
      const stick = shouldStick({
        scrollHeight: list.scrollHeight ?? 0,
        clientHeight: list.clientHeight ?? 0,
        scrollTop: list.scrollTop,
      });
      if (!stick) return;
    }
    list.scrollTop = list.scrollHeight ?? 0;
  }

  /* ═══════════════════════════════════════════════════════════
     手势（契约 §8.2）
     ═══════════════════════════════════════════════════════════ */

  /**
   * 从触摸事件的目标往上找，取最近那条消息的 `data-msg-index`。
   *
   * 从 DOM 属性读而不是从坐标算：坐标算法要处理"点在气泡之间的空隙"、
   * 滚动态、以及列表末端的草稿卡，边界情况远多于读一个属性。
   */
  private resolveBubbleIndex(event: unknown): number | null {
    return bubbleIndexAt(event);
  }

  /**
   * 打开某条消息的操作菜单（编辑 / 复制 / 删除）。
   *
   * ## 编辑后怎么进上下文
   *
   * 直接改 `this.messages[index].mes` 再 `onChatChanged` 落盘 ——
   * 下一轮 `buildPrompt` 读的就是 `this.messages`，所以**不需要额外"重发"**：
   * 用户下次说话时，被改过的内容自然作为上下文的一部分送上去。
   */
  private openBubbleActions(index: number, rowEl: ElLike | null = null): void {
    const message = this.messages[index];
    if (message === undefined) return;

    /* 同一时刻只留一个菜单 */
    this.bubbleMenu?.close();

    const isUser = message.is_user === true;
    this.bubbleMenu = openBubbleMenu(this.doc, {
      text: String(message.mes ?? ''),
      /*
       * 只要**有正文**就允许编辑 —— 包括语音转写出来的消息。
       *
       * ## 为什么原来排除了语音消息（我判断错了）
       *
       * 我当时的理由是"语音气泡下挂着音频条，改文本会与那条时长对不上"。
       * 但用户的原话是「点击**任意**气泡修改文本」—— 语音消息的文字
       * 正是识别结果，改它是最需要的能力（识别错了就得能改）。
       * 音频条记录的是"当时说了几秒"，与后来订正的文字并不冲突。
       *
       * 所以这里只看"有没有正文"，不再看是不是语音。
       */
      editable: String(message.mes ?? '').trim() !== '',
      onSaveEdit: (next) => {
        const updated = this.messages.slice();
        const target = updated[index];
        if (target === undefined) return;
        updated[index] = { ...target, mes: next };
        this.messages = updated;
        /*
         * 只重建这一条的文本，不动整屏（避免闪一下）。
         *
         * ★ 优先用**点击时拿到的那个元素**，而不是按 index 再查一遍 ——
         * 实测按 index 反查对「角色消息」能找到、对「用户消息」找不到
         * （同一份代码，差别只在 data-role）。直接持引用就没有这个不确定性。
         */
        this.patchMessageText(index, next, rowEl);
        this.callbacks.onChatChanged?.(this.messages);
        this.callbacks.onNotify?.('已修改。下一条回复会带上改后的内容。', 'info');
      },
      writeClipboard: (text) => this.writeClipboard(text),
      onCopied: () => this.callbacks.onNotify?.('已复制到剪贴板', 'info'),
      onDelete: () => {
        const updated = this.messages.slice();
        updated.splice(index, 1);
        this.messages = updated;
        this.pendingScroll = true;
        this.render();
        this.callbacks.onChatChanged?.(this.messages);
        this.callbacks.onNotify?.('已删除这条消息。', 'info');
      },
      onClose: () => {
        this.bubbleMenu = null;
      },
    });
  }

  /**
   * 复制到剪贴板，三条路依次降级。
   *
   * | 优先级 | 手段 | 说明 |
   * |---|---|---|
   * | 1 | `navigator.clipboard.writeText` | 现代方案，但要求安全上下文 + 用户手势 |
   * | 2 | `document.execCommand('copy')` | 老 WebView 兜底（Chrome 87 仍支持） |
   * | 3 | 返回 false | 由菜单提示"长按手动复制" |
   *
   * ★ 不用 `alert()` 报失败：它阻塞主线程，流式期间会把打字机卡住。
   */
  private async writeClipboard(text: string): Promise<boolean> {
    const nav = (globalThis as unknown as {
      navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } };
    }).navigator;
    try {
      if (nav?.clipboard?.writeText !== undefined) {
        await nav.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* 落到下一条 */
    }

    try {
      const docAny = this.doc as unknown as {
        createElement?: (t: string) => {
          value?: string;
          style?: { cssText?: string };
          setAttribute?: (k: string, v: string) => void;
          select?: () => void;
          remove?: () => void;
        };
        body?: { append?: (n: unknown) => void };
        execCommand?: (cmd: string) => boolean;
      };
      const ta = docAny.createElement?.('textarea');
      if (ta === undefined) return false;
      ta.value = text;
      /* 放到屏幕外，避免闪一下 */
      if (ta.style !== undefined) ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      ta.setAttribute?.('readonly', '');
      docAny.body?.append?.(ta);
      ta.select?.();
      const ok = docAny.execCommand?.('copy') === true;
      ta.remove?.();
      return ok;
    } catch {
      return false;
    }
  }

  /**
   * 只替换某条消息的正文，不重建整屏。
   *
   * 与 `patchStreamingMessage` 同一个理由：`render()` 会
   * `replaceChildren()` 整屏清空，改一条消息却让整屏闪一下不值。
   */
  private patchMessageText(index: number, text: string, rowEl: ElLike | null = null): void {
    /*
     * 有元素引用就直接用 —— 这是**最可靠**的路径：它就是用户点中的那一条。
     *
     * 反查（按 `data-msg-index`）在这台真机上出现过"角色消息能改、
     * 用户消息改不了"的差异，成因不明。持引用绕开整类问题。
     */
    if (rowEl !== null) {
      /*
       * ★★★ 必须用 `querySelector('.nb-bubble')`，不能数层级。
       *
       * 语音消息的 column 里**先**放一条 `.nb-voice-bubble`（那条音频波形条），
       * 然后才是 `.nb-bubble`：
       *
       * ```text
       *   .nb-msg > div > [ .nb-voice-bubble, .nb-bubble(.nb-msg-meta 在 div 外) ]
       * ```
       *
       * 所以 `children[0].children[0]` 拿到的是**语音条**，往里写文字
       * 会把消息签名（5"、波形）覆盖掉 —— 而普通消息恰好没有这一层，
       * 于是"有的能改、有的不能改"，看起来毫无规律。
       */
      const bubble = bubbleOf(rowEl);
      if (bubble !== null) {
        bubble.innerHTML = renderMessageHtml(text, {
          charName: String(this.ctx.card['name'] ?? ''),
          userName: this.ctx.userName,
        });
        bubble.setAttribute('data-plain', text.slice(0, 200));
        return;
      }
    }
    if (this.listEl === null) return;
    /*
     * ★★★ `this.listEl` **自己就是** `.nb-msglist`，不要再往下找一层。
     *
     * 原来写的是「在 `listEl.children` 里找 `data-role='msglist'`」，
     * 而 `renderMessageList(..., { into: this.listEl })` 是**渲染进** listEl、
     * 不在里面再套一层。于是 children 全是 `.nb-msg`，永远找不到那个容器 ⇒
     * 函数直接 return ⇒ **这个补丁从来没生效过**。
     *
     * 真机实测（`.verify/probe-listel.mjs`）：
     * ```text
     *   [data-role="msglist"] 数量 = 1，children = 34（全是消息），嵌套 0
     * ```
     * 症状：编辑保存后通知弹了（说明 onSaveEdit 跑了），但气泡文字没变。
     */
    const list = this.resolveMsgList();
    if (list === null) return;
    /*
     * ★★★ 必须按 `data-msg-index` **属性**找，不能用 `list.children[index]`。
     *
     * 列表里除了消息还有别的东西（草稿卡、空状态、日期分隔），
     * 用下标会整体错位 —— 实测「编辑保存后文字没变」就是这个原因：
     * 补丁打到了另一条上。
     *
     * 属性是渲染时按 `messages` 下标写的（`renderMessage` 里的 `index`），
     * 所以它才是唯一可靠的定位依据。
     */
    const want = String(index);
    const target = Array.from(list.children).find(
      (child) => child.getAttribute('data-msg-index') === want,
    );
    if (target === undefined) return;
    const bubble = bubbleOf(target as ElLike);
    if (bubble === null) return;
    bubble.innerHTML = renderMessageHtml(text, {
      charName: String(this.ctx.card['name'] ?? ''),
      userName: this.ctx.userName,
    });
    bubble.setAttribute('data-plain', text.slice(0, 200));
  }

  private attachGestures(list: ElLike): void {
    /*
     * ═══ 点按气泡 → 弹出操作菜单（编辑 / 复制 / 删除）═══
     *
     * ## 为什么用"点"而不是"长按"
     *
     * 长按已经被"选中文字复制"占用（用户要求聊天记录可选中）。两种手势
     * 叠在一个动作上，用户永远不知道自己会得到哪一个。
     *
     * ## 为什么要区分"点"和"滑"
     *
     * 这个容器同时承载左右滑切候选（下面的 touchstart/move/end）。
     * 如果直接用 `click`，一次"滑动切候选"在松手时也会触发 click
     * （浏览器在位移不大时仍会派发），于是每次滑动都弹菜单。
     *
     * 所以自己判：按下到抬起的位移 < 8px 且时长 < 400ms 才算"点"。
     * 8px 是 Android 的触摸抖动容差量级；400ms 区分"点"和"按住"。
     */
    let tapStart: { x: number; y: number; t: number } | null = null;
    let tapIndex: number | null = null;
    let tapRowEl: ElLike | null = null;

    list.addEventListener('touchstart', (event) => {
      const touch = firstTouch(event);
      tapStart = touch === null ? null : { x: touch.x, y: touch.y, t: Date.now() };
      tapIndex = bubbleIndexAt(event);
      tapRowEl = bubbleRowElAt(event);
    });

    list.addEventListener('touchend', (event) => {
      if (tapStart === null || tapIndex === null) return;
      const touch = firstTouch(event);
      const start = tapStart;
      const index = tapIndex;
      const rowEl = tapRowEl;
      tapStart = null;
      tapIndex = null;
      tapRowEl = null;
      if (touch === null) return;
      const moved = Math.abs(touch.x - start.x) + Math.abs(touch.y - start.y);
      if (moved > 8) return; // 是滑动，不是点
      if (Date.now() - start.t > 400) return; // 是按住，不是点
      /*
       * ★ 阻止后续的合成 click。
       *
       * 不阻止的话，手指抬起后浏览器还会补一个 `click`，而它落到
       * 气泡内的链接／按钮上会导致"点气泡顺便点了里面的东西"。
       */
      (event as { preventDefault?: () => void }).preventDefault?.();
      this.openBubbleActions(index, rowEl);
    });

    list.addEventListener('touchstart', (event) => {
      const touch = firstTouch(event);
      if (touch === null) return;
      this.trace = [{ x: touch.x, y: touch.y }];
      // 起手是否在气泡内 —— 由目标元素的 class 判断，不用几何计算
      this.startedInBubble = isInsideBubble(event);
    });

    list.addEventListener('touchmove', (event) => {
      const touch = firstTouch(event);
      if (touch === null) return;
      /*
       * ★ 只收集、不判定。
       *
       * 边滑边判会让"左滑一次"连续切过好几个候选（用户看到文字"嗖"地跳到末尾）。
       * 结算放到 touchend 一次做。
       */
      this.trace.push({ x: touch.x, y: touch.y });
    });

    list.addEventListener('touchend', () => {
      if (this.trace.length < 2) {
        this.trace = [];
        return;
      }
      const result = resolveTrace(this.trace, this.startedInBubble);
      this.trace = [];

      if (result.kind === 'swipe') {
        // 生成中不许切候选（切了之后正在写的那条会对不上）
        if (isBusy(this.stream)) return;
        const index = this.messages.length - 1;
        const target = this.messages[index];
        if (target === undefined) return;
        const moved = result.direction === 'next' ? swipeNext(target) : swipePrev(target);
        if (moved === target) return; // 到头了，不动
        const next = this.messages.slice();
        next[index] = moved;
        this.messages = next;
        this.render();
        return;
      }

      if (result.kind === 'back') {
        // 返回由外层（四 Tab 壳）处理；面板只上报
        this.callbacks.onNotify?.('返回', 'info');
      }
    });
  }

  /** 卸载：一定要 dispose，否则流式监听器会跨页面累积 */
  dispose(): void {
    /*
     * ★ 先关气泡菜单。
     *
     * 它是挂在 `body` 上的独立层 —— 面板 dispose 了它还在，
     * 切到别的 Tab 会看到一个浮空的菜单（memory §72 的"僵尸面板"同一类问题）。
     */
    this.bubbleMenu?.close();
    this.bubbleMenu = null;
    this.bridge.dispose();
    this.handle = null;
    /*
     * ★★★ 必须**先 dispose 面板**再丢引用（2026-11-01 发布阻断级修复）。
     *
     * 原来这里只有 `this.voicePanel = null` —— 只是丢引用，
     * 而它可能正握着一条活跃的 `MediaStream`（用户按住麦克风说话时切 Tab）。
     *
     * `switchTab()` 每次离开聊天页都会调 `chatPanel.dispose()`
     * （`renderPage()` 重建面板），所以"录音中切 Tab"这条路径上
     * MediaStream 没有任何人 stop ⇒ **麦克风被独占，其他应用录不到音**。
     *
     * 用户报告的三条症状（他方录不到 / 重授权限无效 / 杀进程即愈）
     * 全部指向这个句柄泄漏。取证见 `.verify/mic-leak-evidence.md`。
     */
    this.voicePanel?.dispose();
    this.voicePanel = null;
  }

  /** 给测试与后续接入用：当前消息快照 */
  snapshot(): { messages: StChatMessage[]; stream: StreamState } {
    return { messages: this.messages.slice(), stream: this.stream };
  }
}

/* ── 触摸事件的最小提取（测试里用假事件即可，不依赖真实 TouchEvent） ── */

interface TouchLike {
  clientX: number;
  clientY: number;
}

function firstTouch(event: unknown): { x: number; y: number } | null {
  const maybe = event as { touches?: TouchLike[]; changedTouches?: TouchLike[] };
  /*
   * ★★★ 必须按**长度**选，不能写 `touches ?? changedTouches`。
   *
   * `touchend` 时 `touches` 是**空数组**（刚抬起的那根手指已经不在里面了，
   * 剩下的是别的指头，单指点按就是空）。而空数组不是 `null`/`undefined`，
   * `??` **不会**降级 ⇒ 取到 `list[0] === undefined` ⇒ 返回 null。
   *
   * 后果：`touchend` 的处理一开头 `if (touch === null) return` 就退出了，
   * 「点气泡弹菜单」整个不生效 —— 而 `touchstart` 一切正常，
   * 所以只看"事件有没有派发"完全看不出问题（实测两个事件都在派）。
   *
   * `changedTouches` 才是"本次事件里发生变化的手指"：touchend 时它就是
   * 刚抬起的那根，touches 为空时正好用它。
   */
  const primary = maybe.touches;
  const list = primary !== undefined && primary.length > 0 ? primary : maybe.changedTouches;
  const first = list?.[0];
  if (first === undefined) return null;
  return { x: first.clientX, y: first.clientY };
}

/**
 * 从触摸事件的目标往上找最近那条消息的 `data-msg-index`。
 *
 * 返回 `null` 表示"点到的不是消息"（空白区、日期分隔、草稿卡）——
 * 此时不该弹菜单，否则用户点空白也会冒出一个"这条消息"。
 */
function bubbleIndexAt(event: unknown): number | null {
  const ev = event as {
    target?: {
      closest?: (selector: string) => { getAttribute?: (k: string) => string | null } | null;
    };
  } | null;
  const target = ev?.target;
  if (target === null || target === undefined) return null;
  if (typeof target.closest !== 'function') return null;

  const node = target.closest('[data-msg-index]');
  if (node === null || node === undefined) return null;

  const raw = node.getAttribute?.('data-msg-index') ?? null;
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * 在某条消息里找**正文气泡**（`.nb-bubble`）。
 *
 * ## 为什么不能数层级
 *
 * 语音消息的 column 里**先**放一条 `.nb-voice-bubble`（音频波形条），
 * 然后才是 `.nb-bubble`：
 *
 * ```text
 *   .nb-msg > div > [ .nb-voice-bubble, .nb-bubble ]
 * ```
 *
 * 所以 `children[0].children[0]` 对普通消息拿到 `.nb-bubble`、
 * 对**语音消息拿到 `.nb-voice-bubble`** —— 往里写文字会把那条
 * 5" 波形签名覆盖掉。表现就是"有的消息能改、有的不能改"，看起来毫无规律。
 *
 * `querySelector` 按类名找，与层级无关。
 */
function bubbleOf(row: ElLike): ElLike | null {
  const q = (row as unknown as {
    querySelector?: (sel: string) => ElLike | null;
  }).querySelector;
  if (typeof q !== 'function') return null;
  return q.call(row, '.nb-bubble');
}

/**
 * 取触摸目标所在的那条消息元素（`.nb-msg[data-msg-index]`）。
 *
 * 与 `bubbleIndexAt` 同时算：前者给"是哪一条"（索引到 `messages`），
 * 后者给"那个元素"（改 DOM 时直接用，不反查）。
 *
 * 反查（按索引搜 DOM）在这台真机上对角色消息有效、对用户消息无效，
 * 成因没查清 —— 持引用能绕开整类不确定性。
 */
function bubbleRowElAt(event: unknown): ElLike | null {
  const ev = event as { target?: { closest?: (s: string) => unknown } } | null;
  const target = ev?.target;
  if (target === null || target === undefined) return null;
  if (typeof target.closest !== 'function') return null;
  const node = target.closest('[data-msg-index]');
  if (node === null || node === undefined) return null;
  return node as ElLike;
}

function isInsideBubble(event: unknown): boolean {
  const maybe = event as { target?: { className?: string; closest?: (sel: string) => unknown } };
  const target = maybe.target;
  if (target === undefined) return false;
  if (typeof target.closest === 'function') {
    return target.closest('.nb-bubble') !== null;
  }
  return typeof target.className === 'string' && target.className.includes('nb-bubble');
}

/* 供测试直接断言：三个挂载点 id 的唯一来源 */
export { VOICE_MOUNTS };

/* ── 从卡片里取世界书条目（唯一入口，别处不许自己翻 card） ── */

/**
 * 取世界书条目。
 *
 * 为什么单独一个函数而不是内联：`assembleContext` 需要的是**扁平条目数组**，
 * 而卡片里是 `character_book.entries`（还可能是别的形状）。
 * 这个转换只有一处，将来卡片模型变了只改这里。
 */
function readWorldbookEntries(card: Record<string, unknown>): Parameters<typeof assembleContext>[0]['worldbook'] {
  const book = card['character_book'];
  if (book === null || typeof book !== 'object') return [];
  const entries = (book as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  return entries as Parameters<typeof assembleContext>[0]['worldbook'];
}
