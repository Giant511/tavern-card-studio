/**
 * 四 Tab 外壳（v0.1.7 / T15.5）。
 *
 * ## 这一层为什么存在
 *
 * 需求要「四 Tab 新壳」（聊天 / 卡片 / 仓库 / 我的），而 T15.5 只做**聊天**这一页。
 * 其余三页属于 T15.2（TCS 功能移植）。所以本文件：
 *
 *   · 把四 Tab 的**骨架**搭起来（Tab 栏、选中态、页面切换）；
 *   · 聊天 Tab 接真页面；
 *   · 其余三个 Tab 给**明确的"是什么、去哪做"**，不是空白 ——
 *     空白会让人以为功能坏了，而实际上只是还没搬过来。
 *
 * 这也是设计册 §7.3 的纪律：空状态要给"一句人话 + 明确的下一步"。
 *
 * ## 主题切换的落点
 *
 * 需求「设置里可切换整体主题」。夜航 token 全部挂在 `.nb-app` 作用域下的
 * `:root` 变量上，所以**换主题 = 换那层变量**，组件代码一行不动。
 * 本文件留了 `setTheme()` 作为唯一入口（本期只支持 'nebula'）。
 */

import { el, renderEmptyState, type DocLike, type ElLike } from './chat-view.ts';
import { ChatPanel, type ChatPanelCallbacks, type ChatPanelContext } from './chat-panel.ts';
import { DEFAULT_API_STATE, renderApiPage, type ApiPageState } from './api-page.ts';
import type { StChatSource } from '@tcs/shared';
import {
  DEFAULT_VOICE_SETTINGS,
  renderVoiceSettingsPage,
  type VoiceSettings,
} from './voice-settings.ts';
import { StChatBridge } from './st-bridge.ts';
import { createTranscriber } from './asr-client.ts';
import { createRecorder } from './recorder.ts';
import type { VoiceTransport } from './voice-panel.ts';
import {
  parseChatFileRows,
  renderChatActionsPage,
  renderChatFilesPage,
  type ChatActionOutcome,
  type ChatActionsCallbacks,
  type ChatFilesCallbacks,
} from './chat-actions-page.ts';
import { renderChatSettingsMenu, renderFieldSection, type ChatSettingsCallbacks } from './chat-settings.ts';
import { renderChatPromptsPage } from './chat-prompts-page.ts';
import { renderChatPromptEditPage, type PromptEditTarget } from './chat-prompt-edit-page.ts';
import { renderCharacterPicker } from './character-picker.ts';
import { renderPersonaPage } from './persona-page.ts';
import { openSelectPopover, closeActiveSelectPopover } from './select-popover.ts';
import {
  emptyGreetingDraft,
  emptyGreetingPageState,
  greetingFingerprint,
  hasGreetingChanges,
  renderGreetingPage,
  type GreetingDraft,
  type GreetingPageState,
} from './greeting-page.ts';
import { pickFetch, setInsecureOrigins } from './native-fetch.ts';
import { askCertTrust, isCertificateError } from './cert-trust.ts';
import { readDefaultFaceBytes } from './default-face.ts';
import { loadThumbnail } from './thumbnail.ts';
import { shareCardPng, type ShareOutcome } from './share-card.ts';
import { pickAvatarDataUrl } from './avatar-upload.ts';
import { renderWorldbookPage, type WorldbookSummary } from './worldbook-page.ts';
import {
  renderRepoPage,
  type RepoLinkState,
  type RepoRow,
  type RepoStatus,
} from './repo-page.ts';
import { renderRepoCardsPage, type RepoCardRow } from './repo-cards-page.ts';
import { renderRepoCardPage, type RepoVersionRow } from './repo-card-page.ts';
import {
  clearRepoAuth,
  EMPTY_REPO_AUTH,
  readRepoAuthFor,
  readRepoConfig,
  writeRepoAuth,
  writeRepoConfig,
  type MobileRepoAuth,
} from './repo-store.ts';
import {
  CLOUD_REPO_HOST,
  buildOpeningMessages,
  buildPngCard,
  parsePngCard,
  parseStCardText,
  planCardImport,
  convertEmbeddedWorldbook,
  attachWorldToCard,
  resolveRepoOrigin,
  stringifyStCard,
  type RepoConfigState,
} from '@tcs/shared';
import {
  login as apiLogin,
  register as apiRegister,
  logout as apiLogout,
  refresh as apiRefresh,
} from '../auth/auth-client.ts';
import {
  deleteCard as repoDeleteCard,
  fetchFace as repoFetchFace,
  fetchVersionText as repoFetchVersionText,
  listCards as repoListCards,
  listVersions as repoListVersions,
  rollbackCard as repoRollbackCard,
  uploadCard as repoUploadCard,
  type CardSummary as SyncCardSummary,
} from '../sync/server-sync.ts';
import { listRepos as repoListRepos } from '../sync/repo-client.ts';
import {
  CHAT_SOURCE_LABELS,
  DEFAULT_SAMPLING,
  findAsrPreset,
  mutateSettings,
  parseSettingsEnvelope,
  coerceVoiceMode,
  describeBridgeError,
  describeSettingsFailure,
  parseCharacterList,
  parseEngineStatus,
  type CharacterSummary,
  samplingFromSettings,
  SAMPLING_SECTION,
  writeField,
  type DerivedSampling,
  /* 预设（2026-11-03 / 任务 #259） */
  currentPresetName,
  mergePresetIntoOai,
  parsePresetList,
  planApplyPreset,
  presetBodiesByName,
  parsePromptConfig,
  computeBudget,
  setPromptEnabled,
  createPrompt,
  updatePrompt,
  deletePrompt,
  draftOf,
  validateDraft,
  newPromptIdentifier,
  readInjectionTrigger,
  NEW_PROMPT_DRAFT,
  type PromptDraft,
  parentRouteOf,
  turnDirection,
  resolveAuthorNoteConfig,
  buildStConnectionPatch,
  secretKeyOf,
  verifyConnectionPersisted,
  activePersona,
  activeUserName,
  emptyPersonaState,
  relabelUserMessages,
  personasForCharacter,
  selectPersona,
  type PersonaState,
  updatePersona,
  serializeWorldbook,
  DEFAULT_GLOBAL_SETTINGS,
  readWorldSettings,
  writeWorldSettings,
  type WorldGlobalSettings,
  type AuthorNoteConfig,
  type ParsedPromptConfig,
  presetNameFromFile,
  validatePresetBody,
  type PresetSummary,
  chatFingerprint,
  type EngineStatus,
  parseChatResponse,
  makeChatFileName,
  shouldSaveChat,
  type StChatMessage,
  type StSettings,
  /* 思考模式（2026-11-07，P0 第三步） */
  previewReasoningPlan,
  isSupportedChatSource,
  type ParamFamily,
  type ThinkingIntent,
} from '@tcs/shared';

export type TabId = 'chat' | 'cards' | 'repo' | 'me';

/**
 * 「我的」页一级收纳项的规格（2026-10-31 第三批）。
 *
 * 抽出来是为了让 API 连接与语音输入**用同一个构造函数**。
 * 各写一份的后果是慢慢分叉：padding 不同、chevron 一个转一个不转、
 * aria 一边写一边漏 —— 而这些只在截图里看得出来。
 */
interface AccordionSpec {
  /** 标题行的 `data-role`（验收脚本按它找入口） */
  entryRole: string;
  /** 面板的 `data-role` */
  panelRole: string;
  title: string;
  /** 副标题：说清"现在是什么状态"，不展开也能判断 */
  subtitle: string;
  expanded: boolean;
  /**
   * 用户点了标题行。实现方负责翻转自己那个 `*Expanded` 字段。
   *
   * 返回值决定"要不要真的展开"：
   *   · `true`  —— 可折叠条目（API / 语音）：翻转并渲染
   *   · `false` —— **纯说明条目**（卡片 Tab 那两个）：点了不展开。
   *     它们本来就是一段话，做成可折叠会让用户以为里面还有配置。
   */
  onToggle: () => boolean;
  /** 展开时构建内容（收起时会被 `replaceChildren` 清掉） */
  buildBody: () => ElLike;
}

/**
 * API 连接的副标题。
 *
 * 只说用户关心的两件事：**连哪个后端、用哪个模型**。
 * 不显示 key（有也不显示 —— 屏幕上出现密钥片段是事故），
 * 不显示采样参数（那是展开后的事）。
 */
function apiSummary(state: ApiPageState): string {
  const label = CHAT_SOURCE_LABELS[state.source]?.label ?? '自定义';
  const model = state.model.trim();
  return model === '' ? `当前：${label}（还没填模型名）` : `当前：${label} · ${model}`;
}

/**
 * 沿 `cause` 链判断这个错误是不是"证书不受信任"。
 *
 * 链最多走 5 层 —— 防止环形 cause（人为构造或某天某个库搞出来）
 * 导致死循环。5 层足够穿过"协议层 → fetch 适配层 → 原生错误"这三层。
 */
function mentionsCertificate(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (cursor === null || cursor === undefined) return false;
    const message =
      cursor instanceof Error ? cursor.message : typeof cursor === 'string' ? cursor : '';
    if (isCertificateError(message)) return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * 用户设定那一行的副标题（2026-11-04）。
 *
 * 说清"现在用哪套、一共几套" —— 用户最想知道的是"我用的是哪个身份"，
 * 而不是"有没有配置过"。
 */
function personaSummary(state: PersonaState): string {
  const active = activePersona(state);
  const count = state.personas.length;
  if (active === null) {
    return count === 0 ? '你在故事里的名字与设定（还没建）' : `共 ${String(count)} 套，还没选中`;
  }
  return count === 1 ? `当前：${active.name}` : `当前：${active.name} · 共 ${String(count)} 套`;
}

/**
 * 语音输入的副标题。
 *
 * ★ 显示**厂商名**不显示 `presetId`（`aliyun-paraformer` 这种是内部标识）。
 * `findAsrPreset()` 是 `shared` 里现成的查找函数，找不到返回 null，
 * 正好覆盖"配置里存着旧版本 id"的情况。
 */
function voiceSummary(settings: VoiceSettings): string {
  if (settings.presetId === '') return '还没选语音厂商';
  const preset = findAsrPreset(settings.presetId);
  const name = preset?.name ?? '已选的厂商';
  return `当前：${name}${settings.confirmBeforeSend ? ' · 发送前需确认' : ''}`;
}

interface TabDef {
  id: TabId;
  label: string;
  icon: string;
}

/** Tab 顺序即从左到右（聊天是第一页 —— 它是这个 App 的主用途） */
const TABS: readonly TabDef[] = [
  { id: 'chat', label: '聊天', icon: '💬' },
  { id: 'cards', label: '卡片', icon: '🗂' },
  { id: 'repo', label: '仓库', icon: '☁️' },
  { id: 'me', label: '我的', icon: '⚙️' },
];

export interface ShellOptions {
  doc: DocLike;
  /**
   * ST 的地址。**外壳会用它在首次需要时调 `connect()`**。
   *
   * 2026-10-31 第五批修：这个字段此前**只被赋值、从未被读**
   * （`grep stBaseUrl shell.ts` 只有声明那一行）。
   * 而 `StChatBridge.connect()` 全库零调用 ⇒ Rust 侧 `StChatState.api`
   * 恒为 None ⇒ 所有 ST 命令都返回 `StUnavailable`。
   * 用户看到的「保存失败: [object Object]」和「读不到当前的聊天设置」
   * 都是这一个断点的两种表现。
   */
  stBaseUrl: string;
  /**
   * 读引擎真实状态（Android 侧注入的 JS 桥）。
   *
   * 不传 = 这个平台没有这项能力（桌面端 / 浏览器）。
   * **不许在拿不到时假装 `{ready:false}`** —— 那会让 UI 说
   * "引擎没起来"，而我们其实只是没有信息源。
   */
  readEngineStatus?: () => EngineStatus | null;
  userName: string;
  /** 卡片数据（聊天上下文用） */
  card: Record<string, unknown>;
  /** 本机已保存的 API 偏好 */
  apiState?: ApiPageState;
  /**
   * 本机已保存的用户设定（2026-11-04 第三十批）。
   *
   * 存在 App 自己这里而不是引擎里 —— 详见 `shared/chat/persona.ts`。
   */
  personaState?: PersonaState;
  /** 保存用户设定（外壳负责落盘） */
  onPersistPersona?: (state: PersonaState) => Promise<void>;
  /** 保存 API 偏好（外壳负责落盘） */
  onPersistApi?: (state: ApiPageState) => Promise<void>;
  /**
   * 哪些源**已经配置过 key**（2026-11-02 用户要求）。
   *
   * ## 为什么需要它
   *
   * 用户原话：「秘钥也改一下，改成可见的一串星号（给一个变量专门指示是否
   * 填写了秘钥…），这样用户才知道自己有没有配置」。
   *
   * 聊天 API 的 key 写进 SillyTavern 后**读不回来**（契约 §3.5 掩码），
   * 所以"配过没有"只能由**知道写入这件事的那一方**记一份标记。
   * 写入发生在本壳里（`renderApiPage` 的保存流程），所以标记也放这里。
   *
   * ## 为什么是「按源」而不是一个全局布尔
   *
   * 用户可能给 OpenAI 配了、没给 DeepSeek 配。全局布尔会让切到 DeepSeek
   * 也显示"已配置" —— 比不显示更糟：他以为能用，然后发消息失败。
   */
  apiKeySources?: readonly StChatSource[];
  /**
   * 某个源刚写入了新 key（外壳落盘标记）。
   *
   * 与 `onPersistApi` 分开：那是"页面状态"（源/模型/地址），这是
   * "秘钥是否存在"的标记，两者的存储介质与失败影响都不同。
   */
  onApiKeyWritten?: (source: StChatSource) => void;
  /** 本机已保存的语音设置 */
  voiceSettings?: VoiceSettings;
  /** 保存语音设置（外壳负责落盘 + 写 key） */
  onPersistVoice?: (settings: VoiceSettings, apiKey: string | null) => Promise<void>;
  /**
   * 读「显示完整思考链」开关（2026-11-05）。
   *
   * 与 `onPersistVoice` 同一个模式：外壳不知道存储介质，
   * 只负责把它传给设置页与聊天面板。
   *
   * 不传 = 关（默认不显示完整思考链，见 `mobile/main.ts` 里那段理由）。
   */
  readShowReasoning?: () => boolean;
  /** 写这个开关。不传则开关只在本次进程内有效 */
  onPersistShowReasoning?: (next: boolean) => void;
  /**
   * 读/写思考模式的本机偏好（2026-11-07，P0 第三步）。
   *
   * 落盘方式与平台相关（移动端是 localStorage），所以由入口负责，
   * 外壳只持有内存值 —— 与 `readShowReasoning` 同一条纪律。
   */
  readThinking?: () => { intent: ThinkingIntent; budget?: number | string; family?: ParamFamily };
  onPersistThinking?: (next: { intent: ThinkingIntent; budget?: number | string; family?: ParamFamily }) => void;
  /**
   * 读本机已存的 ASR key（为空串表示没存过）。
   *
   * 为什么要一个"读 key"的回调，而不是让外壳自己也存一份：
   * key 的落盘方式与平台相关（Android 走 localStorage / 桌面以后可能走
   * 系统凭据库），外壳不该知道这些。它只要能**在需要转写的那一刻拿到**。
   *
   * 注意：这**不是**"把 key 放进聊天请求"。ASR 请求直连用户配的服务，
   * TCS 服务端零接触（需求 §五 第 6 条）。
   */
  readVoiceKey?: () => string;
  onNotify?: (message: string, kind?: 'info' | 'ok' | 'warn' | 'danger') => void;

  /**
   * 冷启动的**会话恢复**已经落定（无论成功 / 没历史 / 失败）（2026-11-06）。
   *
   * ## 为什么需要这个回调
   *
   * 用户：
   *
   * > 在已经存在聊天记录的时候，再次打开 APP，开屏动画之后会短暂显示
   * > 还没有聊天的那个界面，干脆再把开屏动画弄长一点，聊天记录页面
   * > 加载完成后再显示。
   *
   * 真因：`mount()` 里的恢复是 `void` 异步（**故意不 await**，否则首屏
   * 迟迟不出现），于是：
   *
   * ```text
   *   splash 消失 → shell 挂上 → 渲染"还没有对话"（快照还是 null）
   *   → 后台读完历史 → 再渲染 → 消息出现
   * ```
   *
   * 中间那一帧就是用户看到的"短暂显示空界面"。
   *
   * 有了这个回调，`main.ts` 可以：
   *
   * ```text
   *   splash 保持显示 → shell.mount() → 等这个回调（或 3 秒上限）→ 淡出
   * ```
   *
   * 于是用户看到的是"开屏久一点，然后直接有聊天记录"。
   *
   * ★ 调用时机是 `finally`（成功失败都调）—— 失败时也必须放行，
   *   否则引擎起不来会把用户永久关在开屏里。
   */
  onSessionSettled?: () => void;

  /**
   * 上次退出时正在聊的会话（2026-11-01 第八批问题二第二轮）。
   *
   * ## 为什么必须有
   *
   * 真机实测：内部 Tab 往返没问题（`chatSnapshot` 在内存里），但
   * **切到别的 App / 按 Home 再回来**（Android 会回收 WebView）之后，
   * 整个 JS 堆没了 —— `selectedCharacter` 与 `chatSnapshot` 双双归零，
   * 界面回到「未选择聊天」。用户说"切走再回来消息全没了"就是这个。
   *
   * 实测证据（`.verify/verify-switch-scenarios.mjs`）：
   * ```text
   * A. 内部 Tab 往返   3 → -1 → 3        PASS
   * B. 页面重载(等价回收) 3 → count=1     FAIL
   * ```
   *
   * 所以会话身份（哪个角色、哪个聊天文件）必须**落盘**。
   * 消息本身不用存 —— 它们在 ST 的 jsonl 里，按文件名能读回来。
   */
  savedSession?: SavedChatSession | null;
  /**
   * 会话身份变化时落盘。
   *
   * 与 `onPersistVoice` 同一个模式：外壳不知道存储介质
   * （Android 是 localStorage / 桌面以后可能是别的），只负责"什么时候该存"。
   */
  onPersistSession?: (session: SavedChatSession) => void;
}

/**
 * 需要跨进程存活的会话身份。
 *
 * **不存 messages**：消息在 ST 的 jsonl 里，是唯一事实来源。
 * 在这里存一份会导致"两份历史不一致"，而合并策略是新的复杂度来源。
 */
export interface SavedChatSession {
  /** 角色头像文件名（ST 用它定位目录） */
  avatar: string;
  /** 角色显示名 */
  name: string;
  /** 聊天文件名（**不带扩展名**，`get`/`save` 要的那个） */
  fileName: string | null;
}

export class AppShell {
  private readonly doc: DocLike;
  private readonly bridge = new StChatBridge();
  private readonly options: ShellOptions;

  /**
   * 是否已经成功 connect 过 ST。
   *
   * ## 为什么是"一次性 + 失效重试"而不是每次都连
   *
   * `st_chat_connect` 每次都会**换一只新的 reqwest client**（丢掉 cookie jar）、
   * 重新取 CSRF token（`st_api.rs:153` 的注释写得很清楚）。每次请求都连一次
   * 等于每次丢掉会话再重建 —— 慢，而且流式生成期间重连会把会话弄断。
   *
   * 所以：第一次用到时连一次；之后只有**观察到 `ST_UNAVAILABLE`** 才清标记重连
   * （那种情况下旧连接已经确定不可用了，重连是合理的）。
   */
  private connected = false;

  /** 正在进行的 connect 尝试（并发调用共享同一次，避免连出四次） */
  private connecting: Promise<{ ok: boolean; error?: unknown }> | null = null;

  /**
   * 最近一次读设置失败的原因（null = 没失败过）。
   *
   * 设置页只拿到 `null` 时无法归因，所以要把它带出去 ——
   * 见 `ChatSettingsCallbacks.describeReadFailure`。
   */
  private lastSettingsFailure: string | null = null;

  /**
   * 选卡器是否打开（2026-10-31 第五批问题二）。
   *
   * `onPickCharacter` 原来硬编码 `async () => null` —— 点「选择角色」
   * 什么都不会发生。现在它打开这个页面，并用 `pickResolve` 把选择结果
   * 交回给 `ChatPanel`（那边是 `await callbacks.onPickCharacter?.()`）。
   */
  private pickerOpen = false;

  /** 选卡结果的回调。null = 没有待决的选择 */
  private pickResolve: ((value: { avatar: string; name: string } | null) => void) | null = null;

  /**
   * 用户选中的角色（2026-11-01 第五批补）。
   *
   * ## 为什么必须由外壳持有
   *
   * `ChatPanel.avatar` 是**面板的私有字段**，而面板每次 `renderPage()` 都会
   * 重建（`renderChat()` 里 dispose 旧的、new 新的）。
   *
   * 第一版的 `onPick` 是"先 `renderPage()` 再 `resolve()`" —— 真机实测
   * 后果：选卡器关掉了，但聊天页仍显示「还没有对话 / 先选一个角色」。
   * 因为 resolve 交给的是**已被移除的旧面板**，它设的 `this.avatar` 落在了
   * 一个不在 DOM 上的对象里；新面板的 avatar 是 null。
   *
   * 所以选择结果只能存在外壳：面板重建时由外壳注入。
   * 这与本项目一贯的纪律一致（`voiceExpanded` / `apiExpanded` /
   * `chatSettingsRoute` 都记在外壳，理由都是"面板会被重建"）。
   */
  private selectedCharacter: { avatar: string; name: string } | null = null;

  /**
   * 连接页保存成功后要显示的一行提示（2026-11-01 加）。
   *
   * 保存成功会触发整页重绘（副标题要变），重绘后旧的 `status` 元素被替换，
   * 所以那句"已保存"必须由外壳记下来、下次渲染时传进去。见
   * `ApiPageCallbacks.notice` 的注释。
   *
   * 只在**一次**渲染中有效：显示完就清空，否则切 Tab 回来又出现。
   */
  private pendingApiNotice: string | null = null;
  /**
   * 语音页重绘后要显示的提示（2026-11-01 发布阻断级同批）。
   *
   * 与 `pendingApiNotice` 同构：保存成功后整页重绘会换掉 status 元素，
   * 所以要在重绘前记一句、重绘时传进去。
   *
   * 语音页**原本没有这个机制**（API 页有），所以它连"写进去了但看不见"
   * 都算不上 —— 是彻底没有反馈。
   */
  private pendingVoiceNotice: string | null = null;

  private root: ElLike | null = null;
  /*
   * `pageHost` / `pageRoot` 的声明在下面「层叠页面容器」那一段 ——
   * 那里同时写了"为什么是两个而不是一个"，放一起才读得懂。
   */
  private tabButtons = new Map<TabId, ElLike>();

  private active: TabId = 'chat';
  private chatPanel: ChatPanel | null = null;
  private apiState: ApiPageState;
  private apiPageEl: ElLike | null = null;
  /**
   * 哪些源已经配置过 key（2026-11-02）。
   *
   * 用来回答配置页的"这个源的秘钥配过没有" —— 页面据此决定
   * 秘钥框显示一串星号还是空着。key 本身读不回来，只能记这份标记。
   */
  private apiKeyPresent: Set<StChatSource>;
  private voiceSettings: VoiceSettings;
  /**
   * 语音区块是否展开。
   *
   * 与接口源手风琴同一模式（用户明确要求"交互与问题二同一模式"）：
   * 点标题行展开/收起，展开态本身即选中反馈。
   * 状态存在外壳而不是页面里，因为"我的"页会随 Tab 切换重绘，
   * 存在页面里一切 Tab 就丢。
   */
  private voiceExpanded = false;
  /**
   * API 连接收纳项是否展开。
   *
   * 与 `voiceExpanded` 同一理由：存外壳不存页面，「我的」页随 Tab 切换重绘。
   * 默认 `false` —— 用户现在打开「我的」看到的是两个标题行，
   * 而不是一整页摊开的表单（这正是本批问题一要解决的）。
   */
  private apiExpanded = false;
  /**
   * 聊天 Tab 的二级路由（2026-10-31 第三批问题二）。
   *
   * `null` = 聊天本身；`'menu'` = 四项设置菜单；其他值 = 某一组的分组页 id。
   *
   * 记在外壳而不是面板里，理由同 `voiceExpanded`：面板随 Tab 切换重建。
   * 另外它必须能在**切走再切回**时被清掉 —— 否则用户切到「卡片」再回「聊天」，
   * 会直接看到上次停留的设置分组页，以为聊天记录没了。见 `switchTab()`。
   */
  private chatSettingsRoute: string | null = null;

  /**
   * 采样参数的运行时副本（2026-10-31 第四批）。
   *
   * ## 它从哪来、为什么要有一份
   *
   * 存储的单一真相是 **ST 设置**的 `oai_settings.*`（用户要求"仍走 ST 设置接口"），
   * 但契约规定"采样参数全在请求体，服务端不读 settings.json" ——
   * 所以每次生成都得把值带过去，不能在需要时临时读（那会多一次 HTTP 往返，
   * 且 ST 没起来时聊天直接不可用）。
   *
   * 于是：进聊天页时从 ST 设置**播种**一次（`seedSampling()`），
   * 「AI 响应配置」页保存成功后再**立即**更新一次。
   *
   * ## 初始值是 `DEFAULT_SAMPLING`
   *
   * 与 `SAMPLING_SECTION.fields[].fallback` 同源（由
   * `samplingFromSettings({})` 从同一份规格算出来），不另写一套数字 ——
   * 两处各写一份默认值，升级时必然只有一处被改。
   */
  private sampling: DerivedSampling = { ...DEFAULT_SAMPLING };

  /**
   * 当前预设里的「提示词管理器」配置（2026-11-03）。
   *
   * `null` = 还没读 / 读不到 ⇒ 面板回退到旧的固定拼装。
   *
   * 与 `sampling` 同一个取舍：**进聊天页播种一次 + 切换预设后立即更新**，
   * 而不是每条消息都去读 ST 设置（那会让每条消息多一次 HTTP 往返，
   * 且 ST 没起来时聊天直接不可用）。
   */
  private promptConfig: ParsedPromptConfig | null = null;

  /**
   * 正在编辑的提示词 identifier（2026-11-07）。`null` = 新建。
   *
   * 只在 `chatSettingsRoute === 'promptEdit'` 时有意义。
   */
  private promptEditId: string | null = null;

  /**
   * 每条提示词的**触发器**（只读展示用，2026-11-07）。
   *
   * `parsePromptConfig` 不保留 `injection_trigger`（它不是发送逻辑要用的字段），
   * 而编辑页要显示"这条只在什么生成类型发"。所以单独从原始预设体抽一份。
   *
   * ★ 抽不到时**不填**（编辑页显示"所有类型"）—— 那是最常见的状态，
   *   也绝不会因为读失败而谎报"这条一直不发"。
   */
  private promptTriggers = new Map<string, readonly string[]>();

  /** 预设里的格式串与示例分隔提示（都来自用户，不内置措辞） */
  private promptFormats: ChatPanelContext['promptFormats'] = {};

  /**
   * 作者注释配置（2026-11-03，第二十七批）。
   *
   * 与 `promptConfig` 一起在 `seedPromptConfig()` 里读出来 ——
   * 两者都来自"当前预设那一次设置读取"，分成两次读会出现
   * "预设换了但注释还是旧的"这种错配。
   */
  private authorNote: AuthorNoteConfig | null = null;

  /**
   * 用户设定（persona）状态（2026-11-04 第三十批）。
   *
   * 存在 App 自己这里，**不写引擎** —— persona 在拼装时只需要名字与描述
   * 两段纯文本，写进引擎会变成两处各一份（详见 `shared/chat/persona.ts`）。
   */
  private personaState: PersonaState = emptyPersonaState();

  /** 用户设定管理页是否打开（`卡片` Tab 的二级页） */
  private personaOpen = false;

  /* ═══ 开场与示例（2026-11-05，用户决定 1）═══ */

  /**
   * 「开场与示例」页是否打开（`卡片` Tab 的二级页）。
   *
   * 与 `personaOpen` 同一个模式：状态记在外壳，页面每次 `renderPage()` 重建。
   * 记在页面里的话，切一次 Tab 就回到"还没选角色"。
   */
  private greetingOpen = false;

  /**
   * 这一页的数据。
   *
   * 四段字段的值**直接对应卡片里的 `residual`**，不经过板块文本 ——
   * 板块文本是"给编辑器看的合并视图"（`first_mes` 与 `alternate_greetings`
   * 会被拼成一段、用分隔行隔开），而这里要逐段改，合并视图反而绕远。
   */
  private greetingState: GreetingPageState = emptyGreetingPageState();

  /**
   * 正在编辑的那张卡的**原始 PNG 字节**。
   *
   * 写回时要用它当容器：`buildPngCard` 只替换卡数据块，其余块（头像图、
   * 其它 tEXt）逐字节保留。重新生成一张图会让卡面变掉。
   */
  private greetingPng: Uint8Array | null = null;

  /** 正在编辑的那张卡的原始 JSON 文本（保存时在它上面改） */
  private greetingJson: string | null = null;

  /**
   * 当前选中角色的卡片数据（`data` 段）。
   *
   * ## ★★★ 为什么需要它（2026-11-05 发现）
   *
   * 移动端入口一直给外壳传 `card: {}`（`mobile/main.ts`），于是：
   *
   * ```text
   *   面板的 ctx.card 是空对象
   *   ⇒ 世界书一条都激活不了（readWorldbookEntries 读到空）
   *   ⇒ first_mes 读不到（新聊天永远是空白）
   * ```
   *
   * 而这两件事在界面上都**看不出来是"卡没加载"** —— 用户只会觉得
   * "AI 不记得设定"「开场白没了」。
   *
   * 现在选角色时真的去读它（`loadCharacterCard`），角色卡的内容才进得来。
   * 桌面端是启动时就把卡读好的，所以那边没这个问题。
   */
  private loadedCard: Record<string, unknown> = {};

  /* ═══ 仓库（2026-11-04，T15.2 阶段 A）═══ */

  /**
   * 服务端地址策略（内置云仓库 / 自定义）。
   *
   * 启动时从 localStorage 读回 —— 用户要求"杀 App 重进后仓库配置保持"。
   */
  private repoConfig: RepoConfigState = readRepoConfig();

  /** 登录态（令牌 + 用户名）。与配置分两个键存，切地址时能独立清掉 */
  /**
   * 登录态。**按 origin 各一份**（2026-11-05）。
   *
   * 初始化时要先有 `repoConfig` 才能算 origin —— 所以放在构造函数里
   * （`repoConfig` 是字段初始化器，先于这个字段？不一定，显式赋值更稳）。
   */
  private repoAuth: MobileRepoAuth = { ...EMPTY_REPO_AUTH };

  /**
   * 与服务端的连通状态（2026-11-06）。
   *
   * ## 为什么必须挂在外壳上，不能放页面闭包里
   *
   * 页面每次切 Tab 都会重建（转场架构如此）。状态放页面里 ⇒
   * 切回来就变回 `unknown` ⇒ 又要探测一次 ⇒ 用户看到的就是
   * "每次切回来都在重连"。
   *
   * 用户明确要求：
   *
   * > 切到其他地方不丢失连接，切回来不需要重新连接服务器。
   *
   * 外壳在整个 App 生命周期内只有一个，所以放这里才叫"不丢失"。
   */
  private repoLink: RepoLinkState = 'unknown';
  private repoLinkDetail = '';
  private repoLinkCheckedAt = 0;

  /**
   * 上次拉到的卡片列表（2026-11-06）。
   *
   * ## 为什么要缓存
   *
   * 同上：页面重建时如果只能"先转圈再拉"，切回来那一下就是一次重新连接。
   * 有缓存就能**立刻有内容**，再后台静默刷新。
   *
   * ## 为什么要带 origin
   *
   * 切了服务端，旧服务端的列表必须作废 —— 否则会在新服务端下面
   * 显示另一台机器的卡片，点进去 404。用 origin 当缓存键最直接。
   */
  private repoCardsCache: RepoCardRow[] = [];
  private repoCardsCacheOrigin = '';

  /*
   * ═══════════════════════════════════════════════════════════
     仓库的三级导航状态（2026-11-06）
     ═══════════════════════════════════════════════════════════

     用户要求：

     > 登录后按照仓库列表做展示（多仓库的情况下），点击对应仓库可进入
     > 卡查看界面 … 点击对应卡片进入卡片历史界面

     所以仓库 Tab 变成三级：

     ```text
       null / null                 → 一级：服务端配置 + 登录 + 仓库列表
       repoId 有值 / cardId 为 null → 二级：该仓库的卡片列表
       repoId 有值 / cardId 有值    → 三级：某张卡的历史
     ```

     ★ 这两个字段同时决定 `pageKey()` 的段数（1 → 2 → 3），
       于是转场方向由 `turnDirection()` 自动推导 —— 不需要为每一级
       单独写动画。这是第 4 点"复用转场"的实现方式。
     */
  private repoRepoId: string | null = null;
  private repoRepoName = '';
  private repoCardId: string | null = null;
  private repoCardTitle = '';

  /*
   * 二级、三级的加载状态。
   *
   * `null` = 还没拉到（渲染"正在读取…"）；空数组 = 拉到了但是空的。
   * 两者必须区分：都当空数组的话，页面会先显示"没有卡片"再变成列表，
   * 那一下闪烁比多一次渲染更刺眼。
   */
  private repoCardsState: RepoCardRow[] | null = null;
  private repoCardsError = '';
  private repoVersionsState: RepoVersionRow[] | null = null;
  private repoVersionsError = '';

  /** 一级的仓库列表缓存（切回一级时先有内容可看） */
  private repoReposCache: RepoRow[] = [];

  /**
   * 正在进行的续期请求（单飞去重，2026-11-07）。
   *
   * 服务端的 refresh 是**轮换**语义：刷一次就把 refresh token 换掉。
   * 仓库页进入时会并发发好几个请求，若每个 401 都各自去刷，
   * 后到的那次必然用已被作废的旧 token 而失败 ⇒ 误判"登录过期"。
   * 详见 `refreshRepoAuth()` 的注释。
   */
  private repoRefreshInFlight: Promise<boolean> | null = null;

  /**
   * 令牌彻底续不上了（refresh token 也过期/被吊销）。
   *
   * 与 `repoStatus().expired` 的区别：那个是"按本地时钟判断 access 过期"，
   * 只是**推测**；这个是我**真的试过续期并失败**，是事实。
   * 页面上要显示的是后者 —— 推测过期时自动续期就能解决，不该吓用户。
   */
  private repoAuthExpired = false;

  /**
   * 「显示完整思考链」的**当前值**（2026-11-05）。
   *
   * 为什么在外壳存一份而不是每次问 `options.readShowReasoning()`：
   * 聊天面板的流式回调是**每帧**跑的，每帧读一次 localStorage 是浪费；
   * 而且用户翻开关时面板已经存在，得有个地方能让它"看到新值"。
   */
  private showReasoning = false;
  /**
   * 思考模式的本机偏好（2026-11-07，P0 第三步）。
   *
   * ## 为什么不存进 ST 的 settings
   *
   * `thinking_intent` 是**本 App 独有**的概念 —— ST 的 `oai_settings` 里
   * 没有这个键。硬塞进去等于往另一个产品的配置文件里写私有数据，
   * 而且 ST 前端可能把它当未知键清掉（本项目 §99 记过"只存 ST 的参数不生效"）。
   *
   * 所以存本机 localStorage（与「显示完整思考链」开关同一处）。
   *
   * ★ 代价要说清：换设备后要重设。这是"私有偏好"的合理边界 ——
   *   它跟"这台机器用不用思考模式"绑定，比跟账号绑定更合理。
   */
  private thinkingIntent: ThinkingIntent = 'auto';
  private thinkingBudget: number | string | undefined = undefined;
  /**
   * 用户手选的参数族（2026-11-07，兜底）。
   *
   * `undefined` = 让系统自动识别。只在自动识别失败时由用户设置，
   * 与 intent/budget 一起存本机偏好。
   */
  private thinkingFamily: ParamFamily | undefined = undefined;

  /**
   * 分享用的 PNG 字节缓存（`avatar → 字节`）。
   *
   * 为什么要缓存：`onShare` 是同步回调（Kotlin 的 `sharePng` 要同步拿参数），
   * 而读 PNG 必须走异步 `invoke`。没缓存的话每次点分享都只能返回
   * "正在准备"，用户点第二次才有反应。预取在面板出现时做。
   *
   * 键用 avatar 而不是名字：同名卡是可能的（§100 踩过）。
   */
  private shareCache = new Map<string, Uint8Array>();


  /**
   * 本次会话里"用户已确认信任其证书"的 origin。
   *
   * 与磁盘上的 `ackedPlainOrigin` 分开：那个记的是**明文**确认（会持久化），
   * 这个只是"这次会话里证书问题用户点了继续"。重启后重新问 ——
   * 证书信任不该悄悄跨会话继承。
   */
  private insecureOrigins: string[] = [];

  /** `seedPromptConfig()` 的序号，用于丢弃乱序返回的旧结果（同 `samplingGeneration`） */
  private promptConfigGeneration = 0;

  /**
   * 上下文窗口上限（ST 的 `openai_max_context`）。
   *
   * 只用于算 token 预算，**不会**出现在请求体里 ——
   * 与之相对的 `sampling.maxTokens`（= `openai_max_tokens`）才是发出去的那个。
   * 两者混在一起最容易让人以为"上下文长度也发了"。
   */
  private contextLimit: number | undefined;

  /** 留给回复的额度（ST 的 `openai_max_tokens`），算预算用 */
  private responseLimit: number | undefined;

  /** `seedSampling()` 的序号，用于丢弃乱序返回的旧结果 */
  private samplingGeneration = 0;
  /**
   * 对话快照（`?sample=1` 用）。
   *
   * 存在外壳而不是面板里：面板随 Tab 切换重建，快照要跨重建存活。
   */
  private chatSnapshot: { fileName: string; messages: StChatMessage[]; scrollTop?: number } | null = null;

  /**
   * 当前聊天在 ST 里的文件名（**不带扩展名**）。
   *
   * ## 为什么由外壳持有
   *
   * `ChatPanel` 每次切 Tab 都重建，`fileName` 会跟着丢。而这个名字是
   * "往哪个文件里覆盖写"的**唯一依据** —— 丢了就会用新名字再存一份，
   * 一次对话在 ST 里留下十几个文件。
   *
   * `null` 表示这次会话还没落过盘（新建聊天）。
   */
  private chatFileName: string | null = null;

  /**
   * 上一次成功保存时的内容指纹（`chatFingerprint()`）。
   *
   * 用来跳过"内容没变"的重复保存。**存指纹而不是存 messages**：
   * 外壳不需要第二份历史，只需要知道"和上次存的一样不一样"。
   */
  private lastSavedFingerprint: string | null = null;

  /** 正在保存的标记：避免两条路径同时发（保存是整份覆盖，并发会互相踩） */
  private savingChat = false;

  /**
   * 保存进行中时又被要求保存的**最新内容**（2026-11-05）。
   *
   * ★ 原来这里是"直接丢掉"：`if (this.savingChat) return;`，
   * 注释给的理由是"它要存的内容会被后一次带上"。
   *
   * 那个假设**只在"后一次一定会来"时成立**。反例很具体：
   *
   * ```text
   *   ① 保存 A(47 条) 开始 → savingChat = true
   *   ② 立刻又要求保存 B(48 条) → 被 return 丢掉
   *   ③ A 写盘成功，B 的内容**从未落盘**
   *   ⇒ 磁盘停在 47，内存是 48
   * ```
   *
   * 重新生成恰好会连着触发两次保存（失败/成功各一次），所以这条路是走得到的。
   *
   * ## 一个被我自己搞错的"证据"（记下来免得再犯）
   *
   * 我一开始以为已经在真机上复现了它：`wc -l` 报 47 行、界面 48 条。
   * 但那个 47 是**测量错误** —— `wc -l` 数的是换行符，而这个 jsonl
   * 最后一行没有结尾换行。按 `\n` 切分丢空行，正好 48，一条都没丢。
   * 换句话说：这条修复是**加固**，不是"修掉一个已复现的缺陷"。
   *
   * 记"最新"而不是"全部"是对的 —— 保存是整份覆盖，最后一份就是最终状态。
   */
  private pendingChatSave: { messages: StChatMessage[]; avatar: string | null } | null = null;

  constructor(options: ShellOptions) {
    this.doc = options.doc;
    this.options = options;
    this.apiState = options.apiState ?? DEFAULT_API_STATE;
    /*
     * 用户设定从外面带进来（2026-11-04 第三十批）。
     *
     * 不带就空 —— 空状态下用默认名字，与旧行为（硬编码"旅人"）一致。
     */
    this.personaState = options.personaState ?? emptyPersonaState();

    /*
     * 用户确认过风险的服务端地址 ⇒ 允许不校验证书。
     *
     * `ackedPlainOrigin` 记录的是"用户明确点过我了解风险"的那个 origin。
     * 它同时覆盖两种情况：
     *
     * · **http 地址** —— 明文传输，用户已确认
     * · **https + 自签证书** —— 加密但证书不可信，用户同样已确认
     *
     * 只在启动与配置变更时更新，不做成"每次请求都问一次"。
     */
    /*
     * 已确认过的地址 ⇒ 允许不校验证书。
     *
     * 两类来源合并：
     * · `ackedPlainOrigin`  —— 明文闸门确认过的那一个
     * · `trustedCertOrigins` —— 用户确认过证书的自签服务器（可多个，持久化）
     */
    setInsecureOrigins([
      ...(this.repoConfig.ackedPlainOrigin === '' ? [] : [this.repoConfig.ackedPlainOrigin]),
      ...this.repoConfig.trustedCertOrigins,
    ]);
    this.insecureOrigins = [
      ...(this.repoConfig.ackedPlainOrigin === '' ? [] : [this.repoConfig.ackedPlainOrigin]),
      ...this.repoConfig.trustedCertOrigins,
    ];
    /*
     * 初始"已配 key"集合由调用方给（它从持久化标记里读）。
     *
     * 为什么不在这里猜：`apiState` 里没有 key 字段（key 只写不读），
     * 从 state 推断"配过没有"是不可能的。只能由落盘方告诉外壳。
     */
    this.apiKeyPresent = new Set(options.apiKeySources ?? []);
    this.voiceSettings = options.voiceSettings ?? DEFAULT_VOICE_SETTINGS;

    /*
     * 恢复上次的会话身份（内存里，不发请求）。
     *
     * 真正的历史读回在 `mount()` 之后 —— 那时 ST 引擎可能还没起好，
     * 现在发请求只会失败。分成两步：先把"我是谁"恢复好（同步、无依赖），
     * 再异步读内容。
     */
    /*
     * 登录态按 origin 恢复（2026-11-05）。
     *
     * 必须在这里（而不是字段初始化器）读：`repoOrigin()` 依赖
     * `this.repoConfig`，而字段初始化顺序不保证它已经就位。
     */
    this.repoAuth = readRepoAuthFor(this.repoOrigin() ?? '');
    /* 思考链开关：默认关，用户存过就按存的 */
    this.showReasoning = options.readShowReasoning?.() ?? false;
    /* 思考模式：默认「自动」（不干预厂商默认），用户存过就按存的 */
    {
      const saved = options.readThinking?.();
      this.thinkingIntent = saved?.intent ?? 'auto';
      this.thinkingBudget = saved?.budget;
      this.thinkingFamily = saved?.family;
    }

    const saved = options.savedSession ?? null;
    if (saved !== null) {
      this.selectedCharacter = { avatar: saved.avatar, name: saved.name };
      this.chatFileName = saved.fileName;
    }
  }

  mount(container: ElLike): ElLike {
    const root = el(this.doc, 'div', 'nb-app');
    root.setAttribute('data-role', 'app-shell');

    /*
     * 页面容器（2026-11-05 改层叠结构）。
     *
     * ```text
     *   pageRoot  .nb-page[data-role=page-host]   固定外壳：安全区 + 裁切
     *     └ .nb-page-layer                        当前页（每次重绘换新的）
     * ```
     *
     * 外壳单独存在的理由：转场时两层要同时 `transform`，而安全区
     * （`padding-top: max(--nb-safe-top, 24px)`）必须**不跟着动** ——
     * 参考的 QQ 那套里状态栏区域全程静止，只有内容在滑。
     * 所以 padding 留在外壳上，层是 `position: absolute; inset: 0`
     * （相对 padding box 定位，天然落在安全区下方）。
     *
     * 第一层现在就建好，`switchTab()` 里会立刻 `renderPage()` 往里填。
     */
    const pageHost = el(this.doc, 'div', 'nb-page');
    pageHost.setAttribute('data-role', 'page-host');
    this.pageRoot = pageHost;

    const firstLayer = el(this.doc, 'div', 'nb-page-layer');
    pageHost.append(firstLayer);
    this.pageHost = firstLayer;

    const tabbar = el(this.doc, 'nav', 'nb-tabbar');
    tabbar.setAttribute('role', 'tablist');
    tabbar.setAttribute('data-role', 'tabbar');

    for (const tab of TABS) {
      const button = el(this.doc, 'button', 'nb-tab');
      button.setAttribute('type', 'button');
      button.setAttribute('role', 'tab');
      button.setAttribute('data-tab', tab.id);
      button.setAttribute('aria-selected', String(tab.id === this.active));

      const icon = el(this.doc, 'span', 'nb-tab-icon');
      icon.textContent = tab.icon;
      const label = el(this.doc, 'span');
      label.textContent = tab.label;
      button.append(icon, label);

      button.addEventListener('click', () => this.switchTab(tab.id));
      tabbar.append(button);
      this.tabButtons.set(tab.id, button);
    }

    root.append(pageHost, tabbar);
    container.append(root);
    this.root = root;

    this.switchTab(this.active);

    /*
     * 恢复上次的聊天内容（2026-11-01 第八批第二轮）。
     *
     * 放在 `switchTab()` 之后：那时页面骨架已经就位，`renderPage()`
     * 能正常工作。**不 await** —— 读历史要一次 ST 往返，阻塞会让
     * 首屏迟迟不出现；读到再重绘一次补上。
     */
    /*
     * 只看 `selectedCharacter`，不要求 `chatFileName` 非空。
     *
     * 要求非空会有漏洞：老版本存下的会话（或上面那个竞态）里
     * `fileName` 是 null，但角色是确定的 —— 那种情况应该"按这个角色找最近一份"，
     * 而不是当作"什么都没选"直接跳过。
     * `restoreLatestChat` 的 `preferred` 传 null 时会自己退回去找最新的。
     */
    if (this.selectedCharacter !== null) {
      const avatar = this.selectedCharacter.avatar;
      /*
       * ★ 先读卡再读历史（2026-11-05）。
       *
       * 冷启动时 `loadedCard` 是空的，而 `restoreLatestChat` 之后会
       * `renderPage()` → 面板用空卡构造 ⇒ 世界书不激活、开场白读不到。
       * 上一次是"杀进程重进就变笨"，成因就在这里。
       *
       * ★ `finally` 里通知"会话已落定"（2026-11-06）：开屏动画靠它
       *   决定什么时候淡出，否则会在读完历史之前就消失、闪一下空界面。
       */
      void (async () => {
        try {
          await this.loadCharacterCard(avatar);
          await this.restoreLatestChat(avatar, this.chatFileName);
        } finally {
          this.options.onSessionSettled?.();
        }
      })();
    } else {
      /*
       * 没有上次的角色 ⇒ 这一屏本来就没有内容要恢复。
       * 立刻放行，否则开屏会白等满 3 秒上限。
       */
      this.options.onSessionSettled?.();
    }

    return root;
  }

  /** 切 Tab（唯一入口 —— 直接改 DOM 会让 `aria-selected` 与实际页面不一致） */
  switchTab(id: TabId): void {
    this.active = id;
    for (const [tabId, button] of this.tabButtons) {
      button.setAttribute('aria-selected', String(tabId === id));
    }
    /*
     * 切 Tab 时把聊天设置的二级路由清掉。
     *
     * 不清的后果：用户在「聊天 → 设置 → AI 响应配置」停留，切到「卡片」
     * 再切回「聊天」，会**直接落在那张表单上**，而聊天记录看不见 ——
     * 用户的第一反应是"我的对话没了"。二级页不该跨 Tab 存活。
     */
    this.chatSettingsRoute = null;
    // 离开聊天页要 dispose：否则流式监听器会跨页面累积
    if (id !== 'chat' && this.chatPanel !== null) {
      /*
       * ★ 离开前记下滚动位置（2026-11-03 第二十四批）。
       *
       * `renderChat()` 每次切回都会重建面板，滚动位置必然丢。
       * 在这里（dispose 前，面板还活着）读一次，存进快照，
       * 回来时 `restoreScroll` 还原 —— 用户翻到哪，回来还在哪。
       *
       * 只在有快照时记：没有快照 = 还没在聊，位置无从谈起。
       */
      if (this.chatSnapshot !== null) {
        this.chatSnapshot.scrollTop = this.chatPanel.getScrollTop();
      }
      this.chatPanel.dispose();
    }
    /*
     * ★ Tab 之间也播转场（2026-11-05 用户要求）。
     *
     * 用户原话：
     *
     * > 底部 tab 切换的时候也要做相同的动画
     *
     * 第一版是**不播**的（当时怕"从我的切到聊天"被判成返回、方向反了）。
     * 现在方向由 `pageKey()` 的段数 + Tab 顺序一起算，乱不了：
     *
     * ```text
     *   聊天(0) → 卡片(1)   段数相同 ⇒ 同级 ⇒ 目标索引更大 ⇒ 新页从右入
     *   我的(3) → 聊天(0)   段数相同 ⇒ 同级 ⇒ 目标索引更小 ⇒ 新页从左入
     *   聊天/设置(x) → 我的  段数变小 ⇒ 退出一层
     * ```
     *
     * 所以这里**不需要**再抑制什么。
     */
    this.renderPage();
  }

  /**
   * 重绘当前页，并在"换了一层"时播层叠滑动转场。
   *
   * ## 三层容器
   *
   * ```text
   *   pageRoot   .nb-page[data-role=page-host]   固定外壳（安全区 + 裁切）
   *     └ layer  .nb-page-layer                  当前页
   *     └ layer  .nb-page-layer[data-leaving]    上一页，滑出中，结束后删
   * ```
   *
   * ## 为什么每次换新层，而不是就地改内容
   *
   * 用户要的层叠转场要求**两层同时在屏上**（新页滑入、旧页退到侧边压暗）。
   * 就地改内容只有一层，做不到。
   *
   * ## 方向是**推导**出来的，不是各处打标记
   *
   * `pageKey()` 前后一比：段数变多 ⇒ 进，变少 ⇒ 退，段数不变但 key 变了
   * ⇒ 同级切换（Tab），按 Tab 顺序定方向。key 完全没变 ⇒ 同一页重绘（不播）。
   */
  private renderPage(): void {
    if (this.pageRoot === null) return;

    /*
     * ★★★ 换页前必须关掉挂着的那层面板（2026-11-07 真机抓到的）。
     *
     * 下拉面板（人设切换、各种枚举选择）是 `position: fixed` 挂在
     * **`body`** 上的 —— 不在页面子树里。所以 `pageHost.replaceChildren()`
     * 换掉整页时，它**不会跟着消失**。
     *
     * 它原本靠两个信号关闭：
     *   · 点面板外（`pointerdown`）
     *   · 页面滚动（`scroll`）
     *
     * 而"切底部 Tab"这两个都不触发：Tab 的点击落在 tabbar 上（属于外壳，
     * 不在面板内，但若那次 click 是程序触发或事件被吞就收不到），
     * 页面又是**整层替换**而不是滚动。
     *
     * 真机现象：从聊天页点开人设下拉，直接点底部「仓库」——
     * 人设面板还浮在仓库页上面，看起来像界面坏了。
     *
     * 放在 `renderPage()` 里而不是每个换页调用点：换页入口只有这一个，
     * 而调用点有二十几个，逐个加必然漏。
     */
    closeActiveSelectPopover();

    const previous = this.pageHost;
    const keyBefore = this.lastPageKey;

    const next = el(this.doc, 'div', 'nb-page-layer');
    /* 所有 render 方法都 append 到 `this.pageHost` —— 换成新层即可 */
    this.pageHost = next;
    this.pageRoot.append(next);

    this.renderActivePage();

    this.finishPageTurn(previous, next, keyBefore);
  }

  /**
   * 一次重绘的收尾：算出方向、播转场、把旧层摘掉。
   *
   * ## 三道保险
   *
   * 1. **新层是空的就别播**：某个渲染分支若什么都没 append，
   *    播完动画用户会看到一片空白。这种情况保留旧层、并留一条 warn
   *    痕迹（`__TCS_PAGE_EMPTY__`），比白屏好排查得多。
   * 2. **旧层立刻不可交互**：动画期间它还在 DOM 里，
   *    但必须 `pointer-events: none` + `aria-hidden`，
   *    否则用户能在"正在消失的页面"上点到东西。
   * 3. **定时移除而不是只靠 `animationend`**：
   *    `prefers-reduced-motion` 下时长塌成 1ms，某些 WebView 不补发
   *    `animationend`；两者都挂上，谁先来算谁。
   */
  private finishPageTurn(previous: ElLike | null, next: ElLike, keyBefore: string): void {
    const key = this.pageKey();
    this.lastPageKey = key;

    if (next.children.length === 0) {
      /*
       * 渲染分支漏了 append。**不删旧层** —— 宁可留在旧页上（用户看得懂），
       * 也不要给一片空白。留痕迹给探针查。
       */
      (globalThis as { __TCS_PAGE_EMPTY__?: boolean }).__TCS_PAGE_EMPTY__ = true;
      next.remove();
      this.pageHost = previous;
      return;
    }

    /*
     * key 没变 = 同一页重绘（打字、加载完成、数据刷新）。
     * 这一类**绝不能**播转场，否则每敲一个字页面就滑一下。
     */
    if (previous === null || key === keyBefore) {
      previous?.remove();
      return;
    }

    const direction = turnDirection(
      keyBefore,
      key,
      TABS.map((tab) => tab.id),
    );
    this.navAnimSeq += 1;
    const seq = this.navAnimSeq;

    /* 正在消失的那层不许被点到、也不该被读屏念出来 */
    previous.setAttribute('aria-hidden', 'true');
    previous.style.setProperty('pointer-events', 'none');

    /*
     * ★★★ 先把新层**静态放到起点**，等它画完一帧再启动动画。
     * （2026-11-05，为"卡顿/残影"加）
     *
     * ## 不加这一步会怎样
     *
     * 真机逐帧量出来的帧间隔：
     *
     * ```text
     *   push   0 33 50 17 17 17 17 17 17 17 17 17
     *   back  133 33 67 17 33 16 17 17 17 17
     *               ↑ 掉帧全在开头的 2～3 帧，之后稳定 60fps
     * ```
     *
     * 那不是持续掉帧，是**首帧开销**：新层刚 append，要先布局、
     * 把整页（聊天页可能几十条消息）栅格化成纹理、再上传给合成器。
     * 而动画**同时**就开始了 —— 这几帧被拉长，屏幕上停在动画起点，
     * 用户看到的就是"先顿一下"/"有残影"，然后才滑。
     *
     * ## 做法
     *
     * ```text
     *   ① 打上 data-nav-pending，CSS 把层**静态**放到起点（无动画）
     *   ② 下一帧（rAF）再换成 data-nav —— 那一帧浏览器已经把起点
     *      布局并栅格化过，动画只做位移合成
     * ```
     *
     * 代价是动画延后一帧（16.7ms），肉眼几乎无感；
     * 换来的是每一帧都干净 —— 用户说的"流畅"就是这个。
     *
     * ★ 这一步对低端机更值：那些机器首帧栅格化要 50～100ms，
     * 不预热的话开头就是明显的"顿"。
     *
     * ★ 不用在中间再插一次强制布局（读 `getBoundingClientRect`）：
     * `requestAnimationFrame` 的回调在**下一次绘制之前**执行，
     * 所以"设 pending"到"切动画"之间必然隔了一次完整绘制 ——
     * 那次绘制就是预热。多插一次强制布局只是白花时间，
     * 还要给 `ElLike` 接口加成员（所有 DOM stub 都得跟着实现）。
     */
    next.dataset['navPending'] = direction;

    /*
     * 收尾（挂 animationend + 兜底定时器）。
     *
     * ★★★ 必须在 `data-nav` **已经打上之后**才算预算。
     *
     * `animationBudgetMs()` 读的是 `getComputedStyle(next).animationDuration`。
     * 在预热阶段（还没 `data-nav`）读，拿到的是 `0s` ⇒ 退回常数 600ms ——
     * 而真实的"时长 + 200"是 460ms。虽然 600 也够用，但那就等于
     * 把"从实际动画算"这条设计又废了（第三个真值来源）。
     */
    const arm = (): void => {
      const budget = animationBudgetMs(next);

      /*
       * ★★★ 动画一结束就把 `data-nav` 摘掉，**不是可选的收尾**。
       *
       * `animation: ... both` 会把终态的 `transform: translateX(0)` 一直保留着，
       * 而"元素上有 transform"会让它成为 `position: fixed` 后代的
       * containing block。`.nb-select-popover` / `.nb-pop`（下拉面板）
       * 正是 fixed 定位 —— 留着那个 transform，它们就会改成相对本层定位，
       * 位置全错。症状是"下拉框跑到奇怪的地方"，跟转场八竿子打不着，
       * 极难归因。
       *
       * 摘掉之后动画撤除、transform 消失，fixed 恢复相对视口。
       */
      const settle = (): void => {
        next.removeAttribute('data-nav');
      };
      next.addEventListener('animationend', settle);
      globalThis.setTimeout(settle, budget);

      let removed = false;
      const drop = (): void => {
        if (removed) return;
        removed = true;
        previous.remove();
      };
      previous.addEventListener('animationend', drop);
      globalThis.setTimeout(drop, budget);
    };

    const start = (): void => {
      delete next.dataset['navPending'];
      next.dataset['nav'] = `${direction}-${String(seq)}`;
      previous.dataset['leaving'] = direction;
      arm();
    };
    /*
     * `requestAnimationFrame` 在**下一次绘制前**执行，所以这一帧
     * 浏览器有机会把"起点位置"真正画出来（纹理就绪），
     * 下一帧动画开始时不需要再等。
     *
     * ★ 必须做存在性判断：Node 里的 DOM stub（`npm test` 跑的那套）
     * 没有 `requestAnimationFrame`，直接调会 ReferenceError。
     * 没有就**同步启动** —— 测试环境本来也不量流畅度，
     * 而动画属性照常被打上，判据能正常读到。
     */
    const raf = (
      globalThis as { requestAnimationFrame?: (callback: () => void) => number }
    ).requestAnimationFrame;
    if (typeof raf === 'function') raf(start);
    else start();
  }



  /**
   * 「卡片」Tab：两个入口（2026-10-31 第三批）。
   *
   * 用与「我的」页相同的收纳项形态（`renderAccordion`）——
   * 同一个 App 里两处"可点开的设置块"长成两个样子，是最典型的
   * "各写一份必然分叉"。这里复用，不是为了省代码，是为了一致。
   */
  private renderCardsTab(): void {
    if (this.pageHost === null) return;

    const topbar = el(this.doc, 'div', 'nb-topbar');
    const title = el(this.doc, 'h1', 'nb-topbar-title');
    title.textContent = '卡片';
    topbar.append(title);
    this.pageHost.append(topbar);

    const scroller = el(this.doc, 'div', 'nb-scroll');
    this.pageHost.append(scroller);

    scroller.append(
      /*
       * 开场与示例（2026-11-05，用户决定 1）。
       *
       * ★ 放在**第一个**：它是这一页里唯一"进去就能改、改完就有用"的入口。
       * 「编辑角色卡」还是说明页（用户明令编辑器先不做），排在前面
       * 等于让用户先撞一次"还没做"。
       */
      this.renderAccordion({
        entryRole: 'greeting-entry',
        panelRole: 'greeting-panel',
        title: '开场与示例',
        subtitle: '场景、开场白、备用开场、对话示例',
        expanded: false,
        onToggle: (): boolean => {
          this.greetingOpen = true;
          this.greetingState = emptyGreetingPageState();
          this.renderPage();
          /* 打开页面后异步读角色列表（`onToggle` 是同步的，不能 await） */
          void this.loadGreetingCharacters();
          return true;
        },
        buildBody: () => el(this.doc, 'p', 'nb-note'),
      }),
      this.renderAccordion({
        entryRole: 'card-edit-entry',
        panelRole: 'card-edit-panel',
        title: '编辑角色卡',
        subtitle: '八板块编辑与审计，这一版还在桌面客户端',
        expanded: false,
        onToggle: () => false,
        buildBody: () => {
          const note = el(this.doc, 'p', 'nb-note');
          note.textContent =
            '手机上的角色卡编辑器还没做。现在可以：在桌面客户端改好，通过仓库同步过来。';
          return note;
        },
      }),
      /*
       * 用户设定管理（2026-11-04 第三十批，已实现）。
       *
       * 原来自这里点开是一句"还没做"的说明。现在打开真的管理页 ——
       * 内容存在 **App 自己这里**，不写引擎：persona 在拼装时只需要
       * 名字与描述两段纯文本，写进引擎反而会变成"两处各一份、迟早不一致"
       * （详见 `shared/chat/persona.ts` 顶部注释）。
       */
      this.renderAccordion({
        entryRole: 'persona-entry',
        panelRole: 'persona-panel',
        title: '用户设定管理',
        subtitle: personaSummary(this.personaState),
        expanded: false,
        onToggle: (): boolean => {
          this.personaOpen = true;
          this.renderPage();
          return true;
        },
        buildBody: () => el(this.doc, 'p', 'nb-note'),
      }),
    );
  }

  /**
   * 用户设定管理页（2026-11-04 第三十批）。
   *
   * ## 为什么状态放在外壳、不放在页面里
   *
   * 页面每次 `renderPage()` 都会被重建。状态放在页面里，切一次 Tab
   * 就回到默认值 —— 用户会看到"刚改完名字，切出去回来又变回去了"。
   *
   * ## 为什么改完要立刻推给聊天面板
   *
   * 人设的名字决定 `{{user}}` 替换、描述决定上下文里的那段"你是谁"。
   * 不推的话用户改完人设、回聊天发消息，用的还是旧名字 ——
   * 而界面上一切正常，只有模型的表现不对。
   */
  /* ═══════════════════════════════════════════════════════════
     仓库（2026-11-04，T15.2 阶段 A / 决策②④）
     ═══════════════════════════════════════════════════════════ */

  /**
   * 跑一个网络动作；如果因为**证书不受信任**失败，问一次再重试。
   *
   * ## 为什么需要这一层
   *
   * 用户的要求是「https:// 不提示」—— 那是基于"https 就安全"的前提。
   * 但**自签证书**的 https 不安全：系统会拒绝，而拒绝的表现是
   * "连不上服务端"，用户完全不知道可以继续。
   *
   * 真机测试正好撞上（测试服务端 `10.9.0.2:8443` 是自签证书）。
   *
   * ## 只问一次
   *
   * 确认后把 origin 加进 `insecureOrigins`，同一次会话里后续请求不会再弹。
   * 换地址（不同 origin）会重新问 —— 与明文闸门同一条纪律。
   */
  private async withCertTrust<T>(origin: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      /*
       * ★ 必须沿 `cause` 链找，不能只看最外层 message。
       *
       * 协议层（auth-client / repo-client / server-sync）会把底层失败
       * 统一包装成「无法连接服务端」—— 那是给用户看的合适文案，
       * 但也**盖掉了"证书不受信任"这个可操作信息**。
       *
       * 所以那三个模块现在都保留 `cause`，这里逐层往下找。
       */
      if (!mentionsCertificate(error)) throw error;

      const confirmed = await askCertTrust(this.doc, origin);
      if (!confirmed) throw error;

      /*
       * 记下"这台机器的证书用户认了"，**并持久化**，然后原样重试一次。
       *
       * 持久化的理由见 `RepoConfigState.trustedCertOrigins` 的注释：
       * 每次重进都问会训练用户无脑点确认，比不问更糟。
       */
      if (!this.insecureOrigins.includes(origin)) {
        this.insecureOrigins = [...this.insecureOrigins, origin];
        setInsecureOrigins(this.insecureOrigins);

        const nextConfig: RepoConfigState = {
          ...this.repoConfig,
          trustedCertOrigins: [...this.repoConfig.trustedCertOrigins, origin],
        };
        try {
          await writeRepoConfig(nextConfig);
          this.repoConfig = nextConfig;
        } catch {
          /*
           * 存不住也继续 —— 这一次会话内仍然信任（用户已经点过确认）。
           * 只是下次重进会再问一遍，不影响功能。
           */
        }
      } else {
        setInsecureOrigins(this.insecureOrigins);
      }
      return await action();
    }
  }
  /** 当前仓库 origin；未配置/地址非法时 null */
  private repoOrigin(): string | null {
    const resolved = resolveRepoOrigin(this.repoConfig);
    return resolved.ok ? resolved.address.origin : null;
  }

  /** 前端仓库请求：遇到 401 自动用 refresh token 续期并重试一次 */
  private async repoFetchWithRefresh<T>(origin: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!this.isUnauthorized(error)) throw error;
      const renewed = await this.refreshRepoAuth();
      if (!renewed) throw this.repoExpiredError();
      return await work();
    }
  }

  /** 这个错误是不是"令牌不被接受"（401） */
  private isUnauthorized(error: unknown): boolean {
    return (
      error !== null &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === 'UNAUTHORIZED'
    );
  }

  /**
   * 令牌真的续不了（refresh token 也过期 / 被吊销）时给用户看的错误。
   *
   * ★ 不能把服务端原话「缺少或无效的访问令牌」直接丢给用户：
   *   那句话只描述现象，且暗示"我明明是登录状态"（用户截图里就是这样，
   *   界面上「已登录：Gez」和这句话同时出现，等于自相矛盾）。
   *
   *   用户读到的必须是**下一步能做什么**。
   */
  private repoExpiredError(): Error {
    this.repoAuthExpired = true;
    this.options.onNotify?.('登录已过期，请重新登录', 'warn');
    /* 让页面刷一次：这会把它从「已登录」切到「需要重新登录」的形态 */
    this.renderPage();
    return new Error('登录已过期，请点「重新登录」');
  }

  /**
   * 用 refresh token 换一对新令牌（2026-11-07）。
   *
   * ## 用户报的现象
   *
   * > 如果已经登录服务端，重启 App 再进去，就会出现已连接却提示
   * > Token 无效的情况
   *
   * ## 真因
   *
   * 服务端的 access token 只有 **2 小时**（`ACCESS_TOKEN_TTL_SECONDS`），
   * refresh token 有 **30 天**（`REFRESH_TOKEN_TTL_SECONDS`）。
   * 而客户端虽然一直把 `refreshToken` 存进 localStorage，
   * **从来没有调用过 `refresh()`** —— 那个函数 100 多天前就写好了，
   * 零调用点（与 §59「做完了≠交付了」同一类）。
   *
   * 所以只要隔天再打开，存的 access token 必然过期，仓库页就只剩
   * 「缺少或无效的访问令牌」，除了登出重登没有出路。
   *
   * ## ★★★ 必须单飞（并发只刷一次）
   *
   * 服务端的 `/api/auth/refresh` 是 **轮换** 语义：每刷一次就把 refresh
   * token 换掉，旧的立即作废。仓库页进入时会**并发**发好几个请求
   * （探测 + 仓库列表 + 卡片列表），如果每个 401 都各自去刷：
   *
   * ```text
   *   t0  请求A 401 → refresh(旧token) → 拿到 token2（token1 作废）
   *   t0  请求B 401 → refresh(旧token) → 401！因为 token1 已被 A 用掉
   *   ⇒ B 判定"登录过期"，把用户踢成未登录 —— 而其实刚刚续期成功
   * ```
   *
   * 所以用一个 in-flight Promise 去重：已经在刷就等同一个结果。
   *
   * @returns 是否续期成功（false = refresh token 也不行了，需要重新登录）
   */
  private async refreshRepoAuth(): Promise<boolean> {
    /* 已经在刷 ⇒ 等同一个结果，不要各刷各的 */
    if (this.repoRefreshInFlight !== null) return await this.repoRefreshInFlight;

    const origin = this.repoOrigin();
    if (origin === null || this.repoAuth.refreshToken === '') return false;

    const task = (async (): Promise<boolean> => {
      try {
        const bundle = await this.withCertTrust(origin, () =>
          apiRefresh(origin, this.repoAuth.refreshToken, { fetchImpl: pickFetch() }),
        );
        /*
         * ★ refresh token 也换了（轮换），必须**立刻**把新的存下来。
         *
         * 不存的话：这次续期能成功，但下次（2 小时后）拿的还是旧 refresh
         * token，而它早已被服务端作废 ⇒ 那时就真的只能重新登录了。
         */
        this.repoAuth = {
          accessToken: bundle.accessToken,
          refreshToken: bundle.refreshToken,
          accessExpiresAt: bundle.accessExpiresAt,
          userId: bundle.user.userId,
          username: bundle.user.username,
        };
        await writeRepoAuth(origin, this.repoAuth);
        this.repoAuthExpired = false;
        return true;
      } catch {
        /*
         * 静默返回 false，由调用方统一提示。
         *
         * 这里不 `onNotify`：续期失败时可能有多个请求同时走到，
         * 弹三条"登录已过期"比一条更糟（用户会以为出了三个错）。
         */
        return false;
      }
    })();

    this.repoRefreshInFlight = task;
    try {
      return await task;
    } finally {
      this.repoRefreshInFlight = null;
    }
  }

  /** 给页面用的状态摘要 */
  private repoStatus(): RepoStatus {
    return {
      config: this.repoConfig,
      username: this.repoAuth.accessToken === '' ? null : this.repoAuth.username,
      /*
       * ★★★ 只认「真的续期失败」这一个事实（2026-11-07 修正）。
       *
       * 第一版这里按**本地时钟**判断 `accessExpiresAt < now`，于是问题变成：
       *
       * ```text
       *   隔天打开 App
       *     ⇒ access 一定过期（只有 2 小时）
       *     ⇒ 页面直接写"登录已过期，请重新登录"
       *     ⇒ 而其实 refresh token 还有 30 天，完全能自动续上
       * ```
       *
       * 那等于把"用户无感的自动续期"变成了"每次重启都吓用户一跳"，
       * 还逼他重新输密码 —— 比原来的 bug 更糟。
       *
       * 所以本地时钟**不再参与**这个判断。流程改成：
       *
       * ```text
       *   进仓库页（显示「已登录」）
       *     → 发请求 → 401 → 自动 refresh → 成功 ⇒ 用户完全无感 ✓
       *                                    → 失败 ⇒ 置 repoAuthExpired
       *                                             UI 才知道要重新登录
       * ```
       *
       * `repoAuthExpired` 是**我试过并失败**的事实，不是推测。
       */
      expired: this.repoAuthExpired,
      repoTokenMode: false,
      link: this.repoLink,
      linkDetail: this.repoLinkDetail,
      linkCheckedAt: this.repoLinkCheckedAt,
    };
  }

  /**
   * 探测一次与服务端的连通性（2026-11-06，常驻指示灯）。
   *
   * ## ★★★ 判据的核心：401 算「在线」
   *
   * ```text
   *   2xx          ⇒ online   服务器活着且认这个请求
   *   401 / 403    ⇒ online   服务器活着，只是不认这个身份
   *   404 等 4xx   ⇒ online   服务器活着，是路径/权限问题
   *   5xx          ⇒ online   服务器活着，但它自己出错了
   *   连不上/超时   ⇒ offline
   * ```
   *
   * 用户问的是"连上服务器没有"，**不是"能不能用"**。把 401 判成离线是
   * 最容易犯的错：用户只是没登录，却看到红灯说连不上，去查网络查地址，
   * 全都白费 —— 而这恰恰是"仓库"页最常出现的状态（未登录）。
   *
   * ## 为什么打 `/version` 而不是卡片列表
   *
   * ```text
   *   /version      不需要登录、响应最小、所有版本都有
   *   卡片列表      要登录、要解析几十条、服务端慢时会拖到十几秒
   * ```
   *
   * 探测必须轻。重请求会让"亮个灯"变成一次真实加载。
   */
  private async probeRepoLink(): Promise<{ state: RepoLinkState; detail: string }> {
    const settle = (state: RepoLinkState, detail: string): { state: RepoLinkState; detail: string } => {
      this.repoLink = state;
      this.repoLinkDetail = detail;
      this.repoLinkCheckedAt = Date.now();
      return { state, detail };
    };

    const origin = this.repoOrigin();
    if (origin === null) {
      /*
       * 地址还没填好（切到自定义仓库但没写地址）。
       *
       * 这**不是离线** —— 是"还没配"。给 offline 会让用户去查网络，
       * 而实际要做的是把地址填上。所以保留 unknown 并说明原因。
       */
      return settle('unknown', '还没填服务端地址');
    }

    try {
      /*
       * 直接打 `/version`，**不带 Authorization**。
       *
       * 带了反而不好：令牌过期会被服务端回 401，而我们本来就把 401 算在线，
       * 所以不影响结论 —— 但不带能让这次请求更纯粹地"只测连通"，
       * 也不会在服务端留下一次带凭据的访问记录。
       */
      const response = await this.withCertTrust(origin, () =>
        pickFetch()(`${origin}/version`, { method: 'GET' }),
      );

      /*
       * 任何 HTTP 响应都说明连上了。`response.status > 0` 是判据 ——
       * 0 表示"没拿到状态码"（原生通道的失败路径会给 0）。
       */
      if (response.status > 0) {
        const at = new Date();
        const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
        return settle('online', `服务端有响应（HTTP ${String(response.status)}），${hhmm} 确认`);
      }
      return settle('offline', '服务端没有返回状态码');
    } catch (error) {
      /*
       * 连不上。把**原始原因**带上（`cause` 里可能是证书问题），
       * 否则用户只看到"连不上"，不知道该改地址还是换个网络。
       */
      return settle('offline', describeBridgeError(error).message);
    }
  }

  /** 同步层要的配置。未登录时 token 为空串（服务端会 401，由调用方转成人话） */
  private repoSyncConfig(): { serverUrl: string; token: string } | null {
    const origin = this.repoOrigin();
    if (origin === null) return null;
    return { serverUrl: origin, token: this.repoAuth.accessToken };
  }

  /**
   * 跑一次仓库请求，**401 时自动续期并重试一次**（2026-11-07）。
   *
   * ## 为什么抽成一个包装，而不是在每个调用点各写一遍
   *
   * 仓库相关的请求有 6 个（列表 / 卡片 / 版本 / 上传 / 回滚 / 删除），
   * 每个都要"401 → 续期 → 重试"。写 6 遍必然漏一处，而漏掉的那条
   * 只会在"隔天第一次点它"时才暴露 —— 正是用户报的那个现象。
   *
   * ## 为什么重试时**重新取** config
   *
   * `token` 是值拷贝。续期后 `this.repoAuth` 换了新 token，但闭包里
   * 那份旧值不会变 —— 直接重试还是 401，等于没续。
   */
  private async runRepoRequest<T>(
    work: (config: { serverUrl: string; token: string }) => Promise<T>,
  ): Promise<T> {
    const first = this.repoSyncConfig();
    if (first === null) throw new Error('还没配置服务端地址');

    return await this.repoFetchWithRefresh(first.serverUrl, async () => {
      /* ★ 每次执行都重新取：续期后这里拿到的才是新 token */
      const config = this.repoSyncConfig();
      if (config === null) throw new Error('还没配置服务端地址');
      return await this.withCertTrust(config.serverUrl, () => work(config));
    });
  }

  /**
   * 保存一份服务端配置（2026-11-04：与服务端配置页合并后由页面直接触发）。
   *
   * ## 三件必须一起做的事
   *
   * 1. **持久化** —— 否则重启后回到内置云仓库
   * 2. **origin 变了就清登录态** —— 令牌是那台机器签发的，带过去必然 401，
   *    而用户会以为是密码错
   * 3. **重设自签白名单** —— 改了地址还信任旧地址的证书，等于放行了一台
   *    用户没确认过的机器
   *
   * ## 为什么证书信任列表要"合并"而不是"覆盖"
   *
   * 证书信任是由**登录时弹窗确认**产生的，不在配置页编辑。
   * 页面手里的 `draft` 是它进页面时那份，不含刚确认的 origin ——
   * 直接覆盖会把它清掉，用户会莫名其妙地又被问一次证书。
   *
   * @returns 是否**真有登录态**被清掉。
   *   调用方只在 true 时重画整页 —— 只有"从已登录翻回登录表单"需要重画，
   *   其余情况重画只会抹掉用户刚填的账号（见 `onConfigChange` 处）。
   */
  private async saveRepoConfig(next: RepoConfigState): Promise<boolean> {
    const beforeOrigin = this.repoOrigin();
    const beforeKind = this.repoConfig.kind;

    /* 合并证书信任：页面传上来的可能是旧副本 */
    const merged: RepoConfigState = {
      ...next,
      trustedCertOrigins:
        next.trustedCertOrigins.length >= this.repoConfig.trustedCertOrigins.length
          ? next.trustedCertOrigins
          : this.repoConfig.trustedCertOrigins,
    };

    await writeRepoConfig(merged);
    this.repoConfig = merged;

    this.insecureOrigins = [
      ...(merged.ackedPlainOrigin === '' ? [] : [merged.ackedPlainOrigin]),
      ...merged.trustedCertOrigins,
    ];
    setInsecureOrigins(this.insecureOrigins);

    const afterOrigin = this.repoOrigin();
    if (beforeOrigin !== afterOrigin || beforeKind !== merged.kind) {
      const hadAuth = this.repoAuth.accessToken !== '';

      /*
       * ★★★ 切换服务端 = **登出旧服务端**，不再"换槽保留"（2026-11-05）。
       *
       * 上一版是"把当前登录态存进旧 origin 那一格，再从新 origin 那一格读"，
       * 目的是让用户切回来不用重登。**那个设计被用户判为危险**：
       *
       * > 还有一个很危险的问题就是自定义和云仓库可以同时登录
       *
       * 真机录屏证实：内置云仓库「已登录：Gez」、自定义仓库「已登录：testuser」，
       * 两套凭据并存，切过去还会拿错令牌（报「缺少或无效的访问令牌」）。
       *
       * 现在：**同一时间只允许一处登录**。切换即登出，
       * 新服务端从"未登录"开始 —— 想用它就重新登录。
       *
       * `writeRepoAuth` 里也加了同样的互斥（登录任一处就清掉其它 origin），
       * 两处是**同一条纪律的两个入口**：一个是切换离开，一个是登录进来。
       *
       * ★ 登出要**说一声**：莫名"掉登录"会让用户以为是 bug
       * （上一版改动的起因正是这个），所以给一条明确的提示。
       */
      if (hadAuth) {
        await clearRepoAuth(beforeOrigin ?? '');
        this.options.onNotify?.(
          beforeKind === merged.kind
            ? '换了服务端地址，已退出原来的登录'
            : '切换了仓库类型，已退出原来的登录',
          'warn',
        );
      }

      /*
       * 新服务端**不再从槽里恢复** —— 那里现在是空的。
       * 留这一句而不是直接置空，是为了让"同一 origin 只改了写法"的情况
       * 仍然走读盘（`beforeOrigin === afterOrigin` 时根本不会进这个分支，
       * 所以这里必定是空）。
       */
      this.repoAuth = readRepoAuthFor(afterOrigin ?? '');

      /*
       * ★★★ 换了服务端，**旧的连通结论必须作废**（2026-11-06）。
       *
       * 连通状态有 60 秒的"新鲜期"（见 `repo-link` 那段：短时间内切走再
       * 切回来不重新探测）。但"切了服务端"是完全不同的事 —— 前一秒
       * 还在 A 上测出 `online`，切到 B 之后如果沿用这个结论：
       *
       * ```text
       *   A 通、B 不通  ⇒ 界面显示绿灯「已连接」，点上传却失败
       *   A 不通、B 通  ⇒ 界面显示红灯「连不上」，其实 B 好好儿的
       * ```
       *
       * 两种都会让用户去查错方向。所以这里把状态清回 `unknown`，
       * 新页面进来会立刻重新探测（进页面时 `unknown` ⇒ 探测并显示「检测中」）。
       *
       * ★ 不用"只重置时间戳、保留状态"—— 保留旧状态仍然是错的结论。
       */
      this.repoLink = 'unknown';
      this.repoLinkDetail = '';
      this.repoLinkCheckedAt = 0;
      /* 卡片缓存同理（`onCachedCards` 已有 origin 校验，这里显式清更明确） */
      this.repoCardsCache = [];
      this.repoCardsCacheOrigin = '';

      return hadAuth || this.repoAuth.accessToken !== '';
    }
    return false;
  }

  /**
   * 用一份**页面刚给出的**配置连接并登录。
   *
   * 为什么要带 config：用户可能是"刚改完地址就点登录"，
   * 那时外壳手里还是上一次保存的地址。不带就会打到旧地址上。
   */
  private async repoLoginWith(
    config: RepoConfigState,
    username: string,
    password: string,
  ): Promise<void> {
    await this.saveRepoConfig(config);

    const resolved = resolveRepoOrigin(this.repoConfig);
    if (!resolved.ok) throw new Error(resolved.reason);
    const origin = resolved.address.origin;

    /*
     * ★ 注入 `pickFetch()` 而不是默认的全局 fetch。
     *
     * 真机实测：这个 WebView 里 fetch 完全不可用（连 127.0.0.1 都
     * `Failed to fetch`），而聊天走的是 invoke 到 Rust，从没经过它。
     * 所以这里换成走 Android 原生 HTTP 通道。
     */
    const bundle = await this.withCertTrust(origin, () =>
      apiLogin(origin, { username, password }, { fetchImpl: pickFetch() }),
    );

    this.repoAuth = {
      accessToken: bundle.accessToken,
      refreshToken: bundle.refreshToken,
      accessExpiresAt: bundle.accessExpiresAt,
      userId: bundle.user.userId,
      username: bundle.user.username,
    };
    await writeRepoAuth(this.repoOrigin() ?? '', this.repoAuth);
    this.options.onNotify?.(`已登录：${this.repoAuth.username}`, 'ok');
    this.renderPage();
  }

  /** 注册。成功后**自动登录**（用户要求） */
  private async repoRegisterWith(
    config: RepoConfigState,
    username: string,
    password: string,
    inviteCode: string,
  ): Promise<void> {
    await this.saveRepoConfig(config);

    const resolved = resolveRepoOrigin(this.repoConfig);
    if (!resolved.ok) throw new Error(resolved.reason);
    const origin = resolved.address.origin;

    /*
     * 邀请码**只在内置云仓库才传**。
     *
     * `auth-client.register` 的注释写明"无条件透传没影响"，但这里还是
     * 按"内置才传"来做：让请求体与用户看到的东西一致（自定义模式下
     * 界面上没有邀请码框，请求里也不该出现一个用户没填过的字段）。
     */
    const invite =
      this.repoConfig.kind === 'cloud' && inviteCode !== '' ? inviteCode : undefined;

    const outcome = await this.withCertTrust(origin, () =>
      apiRegister(
        origin,
        { username, password, inviteCode: invite },
        { fetchImpl: pickFetch() },
      ),
    );

    /*
     * `tokens === null` 表示服务端只建了号、没给会话
     * （`admin-only` 模式下管理员替人建号的场景）。那种情况不能假装登录成功。
     */
    if (outcome.tokens === null) {
      this.options.onNotify?.('账户已创建，请用新账号登录', 'ok');
      this.renderPage();
      return;
    }

    /* ★ 注册后自动登录（用户明确要求） */
    this.repoAuth = {
      accessToken: outcome.tokens.accessToken,
      refreshToken: outcome.tokens.refreshToken,
      accessExpiresAt: outcome.tokens.accessExpiresAt,
      userId: outcome.user.userId,
      username: outcome.user.username,
    };
    await writeRepoAuth(this.repoOrigin() ?? '', this.repoAuth);
    this.options.onNotify?.(`已注册并登录：${this.repoAuth.username}`, 'ok');
    this.renderPage();
  }

  /** 仓库主页面（服务端配置 + 账户 + 卡片，一页到底） */
  private renderRepoPage(): void {
    if (this.pageHost === null) return;

    const page = renderRepoPage(this.doc, this.repoStatus(), {
      onConfigChange: async (next) => {
        const authCleared = await this.saveRepoConfig(next);

        /*
         * ★★★ 只在「登录态被清掉」时重画整页。
         *
         * 2026-11-04 真机验收抓到的缺陷（③⑪⑫⑮ 一起红）：
         *
         * ```text
         *   用户填了用户名 / 密码
         *   → 点地址框（失焦触发 change）→ 地址存盘 → renderPage()
         *   → 页面重建，用户名密码回到空（它们在 render 的闭包里）
         *   → 再点「登录」→ 守卫报「用户名和密码都要填」
         * ```
         *
         * 而且更糟：`change` 是在**点登录按钮导致失焦**时触发的，
         * 于是用户点的正是那颗即将被移除的按钮 —— 表现为"点了没反应"。
         *
         * 地址变了但 origin 没变（同一个服务端换个写法）时，账户区
         * 压根不需要变；`kind` 切换由页面自己的 `paint()` 收尾。
         * 只有"换了服务端 ⇒ 令牌作废"这一件事必须整页重画，
         * 因为要从「已登录」翻回登录表单。
         */
        if (authCleared) this.renderPage();
      },

      onLogin: async (config, username, password) => {
        await this.repoLoginWith(config, username, password);
      },

      onRegister: async (config, username, password, inviteCode) => {
        await this.repoRegisterWith(config, username, password, inviteCode);
      },

      onLogout: async () => {
        const origin = this.repoOrigin();
        if (origin !== null && this.repoAuth.accessToken !== '') {
          /*
           * 服务端吊销失败也照常清本地。
           *
           * 用户的诉求是"从这台机器上退出"，不该因为网络问题被困住。
           */
          try {
            await apiLogout(origin, this.repoAuth.accessToken, { fetchImpl: pickFetch() });
          } catch {
            /* 忽略：本地照样清 */
          }
        }
        await clearRepoAuth();
        this.repoAuth = { accessToken: '', refreshToken: '', accessExpiresAt: 0, userId: '', username: '' };
        this.options.onNotify?.('已登出', 'ok');
        this.renderPage();
      },

      onProbeLink: () => this.probeRepoLink(),

      /* ── 仓库列表（一级，2026-11-06）── */

      /*
       * 拉仓库列表。
       *
       * ★ 这是把"一页到底"改成三级的核心：服务端支持多仓库
       *   （`/api/repos`，带 `cardCount`），所以列表直接用它。
       */
      onListRepos: async () => {
        const items = await this.runRepoRequest((config) =>
          /* 仓库列表接口只认账户令牌，所以要显式给 `accessToken` 字段名 */
          repoListRepos(
            { serverUrl: config.serverUrl, accessToken: config.token },
            { fetchImpl: pickFetch() },
          ),
        );
        const rows: RepoRow[] = items.map((one) => ({
          id: one.id,
          name: one.name,
          description: one.description,
          cardCount: one.cardCount,
          isDefault: one.isDefault,
        }));
        this.repoReposCache = rows;
        return rows;
      },

      onCachedRepos: () => this.repoReposCache,

      /**
       * 「刷新」按钮（2026-11-07，用户建议）。
       *
       * ## 它做三件事，顺序不能反
       *
       * ```text
       *   ① 清掉"已过期"标记 —— 用户主动重试了，先给它一次干净机会
       *   ② 重新拉仓库列表   —— 失败会抛出，由页面显示原因
       *   ③ 重探连通性       —— 顶部指示灯要跟着更新
       * ```
       *
       * ★ 先清标记再拉：如果先拉再清，那么"令牌已失效"的状态下
       *   拉取会立刻因为标记而走失败分支，用户点了刷新还是看到过期提示 ——
       *   等于这个按钮没用。
       */
      onRefresh: async () => {
        this.repoAuthExpired = false;
        /*
         * 主动刷新时把缓存的"过期结论"也丢掉：这次要走真正的网络。
         * 不清的话，`runRepoRequest` 里续期成功的路径是对的，但
         * 假如下面 `onListRepos` 因为别的原因失败，缓存会让人以为
         * 刷新没发生。
         */
        this.repoReposCache = [];

        /* 这一步失败就抛给页面，别吞 —— 用户点了按钮就是要一个结果 */
        const rows = await this.runRepoRequest((config) =>
          repoListRepos(
            { serverUrl: config.serverUrl, accessToken: config.token },
            { fetchImpl: pickFetch() },
          ),
        );
        this.repoReposCache = rows.map((one) => ({
          id: one.id,
          name: one.name,
          description: one.description,
          cardCount: one.cardCount,
          isDefault: one.isDefault,
        }));

        /*
         * 点亮顶部指示灯。单独的 catch：探测失败不该让"刷新列表"这个动作
         * 显示成失败（列表可能已经成功了）。
         *
         * ★ 不用 `this.repoLink = result.state` —— `probeRepoLink()` 内部
         *   已经在 `settle()` 里写过这些字段了，外面再赋一次是重复。
         *   重复写同一件事，将来改了其中一处就会分叉。
         */
        void this.probeRepoLink().catch(() => {
          /* 探测是附加信息，失败就保持原样 */
        });

        this.options.onNotify?.('已刷新', 'ok');
        this.renderPage();
      },

      onOpenRepo: (repoId, repoName) => {
        this.repoRepoId = repoId;
        this.repoRepoName = repoName;
        this.repoCardId = null;
        this.repoCardTitle = '';
        /* 进二级：清掉上次的列表状态，避免先显示别的仓库的卡 */
        this.repoCardsState = null;
        this.repoCardsError = '';
        this.renderPage();
        void this.loadRepoCards(repoId);
      },

      /* 上传列表里的圆形头像（与角色选择器同一个取图实现） */
      onThumbnail: (avatar: string) => loadThumbnail(avatar),

      onPickLocalCard: async () => {
        const raw = await this.withConnection(() => this.bridge.listCharactersRaw());
        const parsed = parseCharacterList(raw);
        if (!parsed.ok) throw new Error(parsed.reason);
        return parsed.items.map((one) => ({ avatar: one.avatar, name: one.name }));
      },

      onUpload: async (avatar) => {
        /*
         * 从 ST 引擎读出这张卡，解出卡 JSON 原文。
         *
         * 走 PNG 而不是 `/api/characters/get`：后者返回的是 ST 加工过的视图，
         * 拿它上传会把加工痕迹一起传进仓库（`chat_size` / `date_last_chat` 之类）。
         * PNG 里那份才是用户创作的内容。
         */
        const pngBytes = await this.withConnection(() => this.bridge.characterPng(avatar));
        const parsed = parsePngCard(new Uint8Array(pngBytes));
        /*
         * `kind === 'bare'` = 这张 PNG 里没有卡数据块。
         * 那不是"没卡可传"，而是这张卡的数据只在 .json 里（或文件损坏）——
         * 两种情况都不该悄悄传一张空卡上去，所以直接报错让用户看到。
         */
        if (parsed.kind !== 'card') {
          throw new Error(`这张卡没有内嵌设定数据（${parsed.note}）`);
        }

        /*
         * 不加 cardId：让服务端按内容/标题判定新建还是追加版本。
         *
         * ★ 这里**没有**做"本地查映射再决定 cardId"—— 桌面端有一整套
         * `st-push-name` 处理这件事，那套依赖"卡文件里存了 cardId"。
         * 手机端读的卡来自 ST 目录，里面通常没有 `extensions.tcs.cardId`，
         * 所以退化成"按标题 upsert"是当前唯一正确的行为。
         */
        const result = await this.runRepoRequest((config) =>
          repoUploadCard(config, { text: parsed.jsonText }, { fetchImpl: pickFetch() }),
        );
        return { created: result.created, seq: result.seq };
      },

      onLoadVersions: async (cardId) => {
        const items = await this.runRepoRequest((config) =>
          repoListVersions(config, cardId, { fetchImpl: pickFetch() }),
        );
        return items.map((one) => ({
          seq: one.seq,
          commit: one.commit,
          createdAt: one.commit,
          sha256: one.sha256,
          message: one.message ?? '',
        }));
      },

      onRollback: async (cardId, seq) => {
        await this.runRepoRequest((config) =>
          repoRollbackCard(config, cardId, seq, { fetchImpl: pickFetch() }),
        );
      },

      onDeleteCard: async (cardId) => {
        await this.runRepoRequest((config) =>
          repoDeleteCard(config, cardId, { fetchImpl: pickFetch() }),
        );
      },

      /**
       * 把仓库里某一版**下载成一张本地角色卡**（2026-11-04，用户要求）。
       *
       * ## 没有「ST」字样
       *
       * 用户明令：这里是对用户可见的流程，必须说"角色库 / 卡片"，
       * 不能说内部引擎的名字。所有文案都在 `repo-page.ts` 与这里，
       * `test/no-internal-terms.test.mjs` 会扫。
       *
       * ## 四步，每步都可能单独失败
       *
       * ```text
       *   ① 拉那一版的 JSON 原文        → 网络/权限失败
       *   ② 算出文件名与块类型           → 纯函数（planCardImport）
       *   ③ 拿一张 PNG 当容器            → 内置兜底卡面（桌面端同一张）
       *   ④ buildPngCard + 原子写文件     → 写盘失败
       * ```
       */
      onImportVersion: (cardId, seq) => this.importRepoVersion(cardId, seq),

      onNotify: (message, kind) => this.options.onNotify?.(message, kind),
    });

    /*
     * 把"下载某一版"暴露给三级页面（2026-11-06）。
     *
     * 那段逻辑就跑在上面的 `onImportVersion` 闭包里，三级页面是另一个
     * 函数拿不到它。这里留一个引用，等于"页面一渲染就绪就可用"。
     * 没就绪时（理论上进不到三级）三级页面会给一句人话。
     */
    this.repoImportVersion = (cardId, seq) =>
      this.importRepoVersion(cardId, seq);

    this.pageHost.append(page);
  }

  /* ═══════════════════════════════════════════════════════════
     仓库：二级（某仓库的卡片列表）与三级（某张卡的历史）
     ═══════════════════════════════════════════════════════════ */

  /**
   * 二级：某个仓库里的卡片。
   *
   * 用户：
   *
   * > 点击对应仓库可进入卡查看界面，也是相同的按照卡列表的方式进行展示，
   * > 并且可以展示缩略图头像
   */
  private renderRepoCardsPage(): void {
    if (this.pageHost === null) return;

    const page = renderRepoCardsPage(
      this.doc,
      {
        repoName: this.repoRepoName,
        cards: this.repoCardsState,
        error: this.repoCardsError,
      },
      {
        onLoadCards: async () => this.fetchRepoCards(),
        onFace: async (cardId) => this.loadCardFace(cardId),
        onOpenCard: (cardId, title) => {
          this.repoCardId = cardId;
          this.repoCardTitle = title;
          this.repoVersionsState = null;
          this.repoVersionsError = '';
          this.renderPage();
          void this.loadRepoVersions(cardId);
        },
        onBack: () => this.goBackOneLevel(),
        onNotify: (message, kind) => this.options.onNotify?.(message, kind),
      },
    );

    this.pageHost.append(page);
  }

  /**
   * 三级：某张卡的历史与操作。
   *
   * 用户：
   *
   * > 点击对应卡片进入卡片历史界面，可以看到卡片的详情，下载、设为最新、
   * > 编辑（做按键入口但是文字变灰不生效，这是下个版本的内容）、删除、设为最新
   */
  private renderRepoCardPage(): void {
    if (this.pageHost === null) return;
    const cardId = this.repoCardId;
    if (cardId === null) return;

    const page = renderRepoCardPage(
      this.doc,
      {
        cardTitle: this.repoCardTitle,
        repoName: this.repoRepoName,
        versions: this.repoVersionsState,
        error: this.repoVersionsError,
      },
      {
        onLoadVersions: async () => this.fetchRepoVersions(cardId),
        /*
         * 下载：把这一版导入成手机上的一张新卡。
         *
         * ★ 复用原来 `onImportVersion` 的整条逻辑（取文本 → 规划文件名 →
         *   拼 PNG → 写盘）。它已经被真机验证过，不要在这里重写一份。
         */
        onDownload: async (seq) => {
          const action = this.repoImportVersion;
          if (action === null) throw new Error('下载入口没有就绪，切一下页面再试');
          await action(cardId, seq);
        },
        /* 设为最新 = 服务端的 rollback（以旧版新建一个提交） */
        onSetLatest: async (seq) => {
          await this.runRepoRequest((config) =>
            repoRollbackCard(config, cardId, seq, { fetchImpl: pickFetch() }),
          );
          /* 回滚会产生新版本 ⇒ 重新拉一遍，否则列表还是旧的 */
          this.repoVersionsState = null;
          this.renderPage();
          void this.loadRepoVersions(cardId);
        },
        onDeleteCard: async () => {
          await this.runRepoRequest((config) =>
            repoDeleteCard(config, cardId, { fetchImpl: pickFetch() }),
          );
          /*
           * 删完要让二级重新拉 —— 否则返回后那张卡还在列表里，
           * 点进去必然 404。
           */
          this.repoCardsState = null;
          this.repoReposCache = [];
        },
        onBack: () => this.goBackOneLevel(),
        onNotify: (message, kind) => this.options.onNotify?.(message, kind),
      },
    );

    this.pageHost.append(page);
  }

  /** 拉二级的卡片（按 repoId 过滤） */
  private async fetchRepoCards(): Promise<RepoCardRow[]> {
    const repoId = this.repoRepoId;

    const items = await this.runRepoRequest((config) =>
      repoListCards(config, { fetchImpl: pickFetch(), limit: 200 }),
    );

    /*
     * ★ 按 repoId 过滤在**客户端**做，因为 `/api/cards` 不支持按仓库过滤
     *   （它返回全部，每条带 `repoId`）。服务端加了过滤参数时这里可以简化，
     *   但现在不能假装它有。
     */
    return items
      .filter((one: SyncCardSummary) => repoId === null || one.repoId === repoId)
      .map((one: SyncCardSummary) => ({
        id: one.cardId,
        title: one.name === '' ? one.cardId : one.name,
        seq: one.latestSeq,
        versionCount: one.versionCount,
        updatedAt: one.updatedAt,
        hasFace: one.face !== null,
      }));
  }

  /** 拉三级的版本列表 */
  private async fetchRepoVersions(cardId: string): Promise<RepoVersionRow[]> {
    const items = await this.runRepoRequest((config) =>
      repoListVersions(config, cardId, { fetchImpl: pickFetch() }),
    );
    return items.map((one) => ({
      seq: one.seq,
      commit: one.commit,
      createdAt: one.createdAt,
      sha256: one.sha256,
      message: one.message ?? '',
    }));
  }

  /**
   * 取一张卡的缩略图，返回 data URL。
   *
   * ## 为什么要转 data URL
   *
   * 这个 WebView 里 `<img src="https://…">` 直连走不通（网络栈在壳里没通，
   * 所有请求都过原生通道）。所以：原生通道拿字节 → base64 → data URL，
   * `<img>` 才画得出来。
   *
   * ## 返回 null 的语义
   *
   * 服务端没有卡面（404）**不是错误** —— 调用方退回兜底首字头像。
   * 抛异常只发生在真的取不到（网络/证书），而那时上层也只是保留兜底。
   */
  private async loadCardFace(cardId: string): Promise<string | null> {
    let fetched: Awaited<ReturnType<typeof repoFetchFace>>;
    try {
      fetched = await this.runRepoRequest((config) =>
        repoFetchFace(config, cardId, { fetchImpl: pickFetch() }),
      );
    } catch {
      /* 缩略图是装饰：任何失败都退回兜底头像，不弹通知 */
      return null;
    }
    if (fetched === null) return null;

    /* 字节 → base64：分块转，避免 `String.fromCharCode(...bytes)` 爆栈 */
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < fetched.bytes.length; i += chunk) {
      binary += String.fromCharCode(...fetched.bytes.subarray(i, i + chunk));
    }
    const base64 = globalThis.btoa(binary);
    /*
     * ★ `mime` 用服务端给的 Content-Type，不要写死 `image/png` ——
     *   卡面可能是 webp，写错标签部分 WebView 会拒绝渲染。
     */
    const mime = fetched.mime === '' ? 'image/png' : fetched.mime;
    return `data:${mime};base64,${base64}`;
  }

  /** 二级：进页面时拉卡片 */
  private async loadRepoCards(repoId: string): Promise<void> {
    try {
      const rows = await this.fetchRepoCards();
      /* 用户可能已经退回去了：别把结果写进别的页面 */
      if (this.repoRepoId !== repoId) return;
      this.repoCardsState = rows;
      this.repoCardsError = '';
    } catch (error) {
      if (this.repoRepoId !== repoId) return;
      this.repoCardsState = [];
      this.repoCardsError = describeBridgeError(error).message;
    }
    this.renderPage();
  }

  /**
   * 静默刷新二级（退回到列表时用）。
   *
   * 与 `loadRepoCards` 的区别：**失败不清空已显示的内容** ——
   * 用户退回来是想看那张列表，后台刷新失败不该把它变成一条错误。
   */
  private async refreshCardsQuietly(repoId: string): Promise<void> {
    try {
      const rows = await this.fetchRepoCards();
      if (this.repoRepoId !== repoId || this.repoCardId !== null) return;
      this.repoCardsState = rows;
      this.renderPage();
    } catch {
      /* 静默：保留当前列表 */
    }
  }

  /** 静默刷新一级的仓库列表（卡数会变） */
  private async loadRepoListQuietly(): Promise<void> {
    if (this.repoSyncConfig() === null) return;
    try {
      const items = await this.runRepoRequest((config) =>
        repoListRepos(
          { serverUrl: config.serverUrl, accessToken: config.token },
          { fetchImpl: pickFetch() },
        ),
      );
      if (this.repoRepoId !== null) return;
      this.repoReposCache = items.map((one) => ({
        id: one.id,
        name: one.name,
        description: one.description,
        cardCount: one.cardCount,
        isDefault: one.isDefault,
      }));
      this.renderPage();
    } catch {
      /* 静默：保留当前列表 */
    }
  }

  /** 三级：进页面时拉版本 */
  private async loadRepoVersions(cardId: string): Promise<void> {
    try {
      const rows = await this.fetchRepoVersions(cardId);
      if (this.repoCardId !== cardId) return;
      this.repoVersionsState = rows;
      this.repoVersionsError = '';
    } catch (error) {
      if (this.repoCardId !== cardId) return;
      this.repoVersionsState = [];
      this.repoVersionsError = describeBridgeError(error).message;
    }
    this.renderPage();
  }

  /**
   * 把卡里内嵌的 `character_book` 落成 ST 的世界书文件（2026-11-06）。
   *
   * ## 用户报的
   *
   * > 从仓库导入的角色明明是包含角色世界书的，但是世界书编辑里面却没有。
   *
   * ## 真因
   *
   * 我们导入是"直接写 PNG 到 characters/" —— 绕过了 ST 自己的导入流程。
   * 而 ST 的世界书扫的是 `worlds/` 目录，卡里那份 `character_book` 不会
   * 自动出现在那里。**数据没丢，只是不在 ST 会去读的地方。**
   *
   * ## 名字冲突怎么办
   *
   * ST 的 import 是**同名覆盖**。所以：
   *
   * ```text
   *   列表里没有这个名字     ⇒ 直接导入
   *   有（可能是上次导入的）  ⇒ 名字带 ` (n)` 后缀才覆盖，否则加后缀
   * ```
   *
   * 保守加后缀的理由：无法区分"上次为这个角色建的"与"别人手建的"，
   * 而**覆盖掉别人的书会让用户丢一整套设定**，还没有任何提示。
   *
   * @returns 落地后的世界书名；没有世界书 / 落地失败时 `null`
   */
  private async persistEmbeddedWorldbook(
    jsonText: string,
    cardName: string,
  ): Promise<string | null> {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(jsonText) as unknown;
    } catch {
      /* 卡 JSON 不合法：那不是这里要处理的（`planCardImport` 已校验过） */
      return null;
    }

    let plan: ReturnType<typeof convertEmbeddedWorldbook> = null;
    try {
      plan = convertEmbeddedWorldbook(parsed, { cardName });
    } catch {
      return null;
    }
    if (plan === null) return null;

    try {
      /*
       * 先查重：ST 的 import 同名覆盖，不能撞掉别人的书。
       *
       * 上限 50 与 `uniqueAvatar` 同一套思路：极端情况下不死循环。
       *
       * ★ `null` ≠ `[]`（2026-11-06 修）：读失败与"确实一本都没有"是两件事。
       *   读失败时若当成空表，同名就会**静默覆盖用户已有的书** —— 那比不落地
       *   世界书严重得多（丢的是别人一整套设定，且不可逆）。所以读失败就
       *   整个跳过：卡已经写好了，少一本书是可重试的，覆盖是不可逆的。
       */
      const existing = await this.listWorldbookNames();
      if (existing === null) return null;
      let name = plan.name;
      if (existing.includes(name)) {
        /*
         * 已有同名。名字本身带 ` (n)` 说明它当初就是被加过序号的，
         * 那几乎肯定是我们为同一张卡建的 ⇒ 覆盖是对的。
         * 否则保守加序号。
         */
        if (!/ \(\d+\)$/.test(name)) {
          for (let index = 2; index <= 50; index += 1) {
            const candidate = `${plan.name} (${String(index)})`;
            if (!existing.includes(candidate)) {
              name = candidate;
              break;
            }
          }
        }
      }

      await this.withConnection(() =>
        this.bridge.importWorldbook(name, JSON.stringify(plan.entries)),
      );
      return name;
    } catch {
      /*
       * 失败静默：卡已经写好了，世界书是加分项。
       * 弹通知会让用户以为"导入失败"，而实际上角色是可用的。
       */
      return null;
    }
  }

  /**
   * 现有世界书的名字列表。
   *
   * ★ 三态：`string[]` = 读到了（可能是空表）；`null` = **读失败**。
   *   调用方必须区分 —— 把失败当空表会静默覆盖别人的书（见调用处注释）。
   */
  private async listWorldbookNames(): Promise<string[] | null> {
    try {
      const raw = await this.withConnection(() => this.bridge.listWorldbooksRaw());
      const parsed: unknown = JSON.parse(raw === '' ? '[]' : raw);
      if (!Array.isArray(parsed)) return null;
      const out: string[] = [];
      for (const one of parsed) {
        if (one === null || typeof one !== 'object') continue;
        const obj = one as Record<string, unknown>;
        /* ST 列表里 `file_id` 才是文件名主干；`name` 可能是显示名 */
        const fileId = typeof obj['file_id'] === 'string' ? obj['file_id'] : '';
        const name = typeof obj['name'] === 'string' ? obj['name'] : '';
        const value = fileId !== '' ? fileId : name;
        if (value !== '') out.push(value);
      }
      return out;
    } catch {
      return null;
    }
  }

  /**
   * 下载某一版（把"导入成新卡"那条既有逻辑暴露给三级页面）。
   *
   * 为什么用字段而不是直接把逻辑搬进 `renderRepoCardPage` 的回调：
   * 那段逻辑在 `renderRepoPage` 的回调闭包里，而三级页面是另一个函数。
   * 用字段引用等于"它跟着页面渲染就绪" —— 没就绪时给一句人话。
   */
  private repoImportVersion: ((cardId: string, seq: number) => Promise<void>) | null = null;

  /**
   * 把仓库里的某一版下载成手机上的一张新卡（2026-11-06 从回调提成方法）。
   *
   * 提出来只为一件事：**三级页面（卡片历史）也要调它**。
   * 它原来写在 `renderRepoPage` 的回调闭包里，三级页面是另一个渲染函数，
   * 拿不到那个闭包。把逻辑复制一份更糟 —— 两处会分叉。
   */
  private async importRepoVersion(cardId: string, seq: number): Promise<void> {
    const jsonText = await this.runRepoRequest((config) =>
      repoFetchVersionText(config, cardId, seq, { fetchImpl: pickFetch() }),
    );

    /*
     * 现有文件名要**现取**，不能用页面进页面时那份：
     * 用户可能刚导入过一张，再导同名的那张就该变 ` (2)`。
     */
    const rawList = await this.withConnection(() => this.bridge.listCharactersRaw());
    const listed = parseCharacterList(rawList);
    if (!listed.ok) throw new Error(listed.reason);

    const planned = planCardImport({
      jsonText,
      cardId,
      existingAvatars: listed.items.map((one) => one.avatar),
      /*
       * ★ 名字也要传（2026-11-06，用户报「同一个角色出现多个」）。
       *
       * 只给文件名判断不出"同一个角色"：`西奥.png` 与 `西奥 (2).png`
       * 是两个不同的字符串，但它们是同一个角色。必须按**卡名**比。
       */
      existingNames: listed.items.map((one) => one.name),
    });
    if (!planned.ok) throw new Error(planned.reason);

    const { avatar, spec, displayName, overwrite } = planned.plan;

    /*
     * ★★★ 内嵌世界书要**先**落地，再写卡（2026-11-06）。
     *
     * 顺序理由：卡里要写 `extensions.world = <书名>`，书名得先定下来。
     * 反过来（先写卡再写世界书）的话，卡里那个字段指向一本还不存在的书，
     * 中途失败就留下"卡指向空世界书"的坏状态。
     *
     * 失败**不阻断导入**：卡本身能用，世界书是加分项。
     * 阻断会让用户连卡都拿不到 —— 那比"世界书没进来"更糟。
     */
    const worldName = await this.persistEmbeddedWorldbook(jsonText, displayName);
    const cardText = worldName === null ? jsonText : JSON.stringify(
      attachWorldToCard(JSON.parse(jsonText) as unknown, worldName),
    );

    /*
     * 底图用**内置兜底卡面**（桌面端那张，用户指定）。
     *
     * 为什么不去取仓库里的卡面资产：那张图是 webp，而 `buildPngCard`
     * 只认 PNG 容器；转码要 canvas（`face-encode` 的整条管线），
     * 而这条路径的目标是"内容能进来"。封面可以在编辑器里再换。
     */
    const base = await readDefaultFaceBytes();
    const png = buildPngCard(base, cardText, spec);

    const status = this.readEngineStatus();
    const charactersDir = status?.charactersDir ?? '';
    if (charactersDir === '') throw new Error('拿不到角色库目录，无法保存');

    /*
     * `allowCreate` 跟着 `overwrite` 走 —— 两个语义**必须成对**：
     *
     * ```text
     *   新卡（overwrite=false） ⇒ allowCreate=true   要求同名不存在
     *   覆盖（overwrite=true）  ⇒ allowCreate=false  要求文件已存在
     * ```
     *
     * 反着传会直接报错（Rust 侧两个方向都校验），这正是我们要的：
     * "该新建却去覆盖" / "该覆盖却去新建" 立刻暴露，而不是静默走错。
     */
    await this.withConnection(() =>
      this.bridge.writeCharacterPng(avatar, charactersDir, png, !overwrite),
    );

    /*
     * 文案只能说**现在真能做的事**。
     *
     * 不能写"可以在「卡片」里打开"—— 卡片页目前只有「编辑角色卡」
     * 与「用户设定管理」两个入口，没有卡片列表（编辑器按用户要求先不做）。
     * 承诺一个点了会落空的入口，比不说更糟：用户会以为导入失败。
     *
     * 现在真能看到的两个地方：聊天页右上角选角色时的列表、以及仓库页
     * 选本地卡上传时的列表。
     */
  }

  private renderPersonaPage(): void {
    if (this.pageHost === null) return;

    const page = renderPersonaPage(this.doc, this.personaState, {
      /*
       * 返回**统一走 `goBackOneLevel()`**（2026-11-04）。
       *
       * 那里已经有 `personaOpen` 分支。自己写一份 `personaOpen = false;
       * renderPage()` 看起来一样，但那是"层级有两个定义"的开始 ——
       * 判据 `back-navigation.test.mjs` 就是为了防这件事。
       */
      onBack: () => {
        this.goBackOneLevel();
      },
      onChange: (next) => {
        this.personaState = next;
        void this.options.onPersistPersona?.(next);
        this.syncPersonaToChat();
      },
      onNotify: (message, kind) => {
        this.options.onNotify?.(message, kind);
      },
      /*
       * 人设头像上传（2026-11-04）。
       *
       * 选图与缩放都在 `avatar-upload.ts`（用 `<input type="file">` +
       * canvas，这个壳的 WebChromeClient 已实现 `onShowFileChooser`）。
       * 这里只负责把结果写回状态并落盘。
       */
      onPickAvatar: (personaId: string) => {
        void (async () => {
          let dataUrl: string | null = null;
          try {
            dataUrl = await pickAvatarDataUrl();
          } catch (error) {
            this.options.onNotify?.(
              error instanceof Error ? error.message : '这张图读不了，换一张试试',
              'danger',
            );
            return;
          }
          /* 用户取消：什么都不做，不要弹提示（他什么都没做错） */
          if (dataUrl === null) return;

          this.personaState = updatePersona(this.personaState, personaId, { avatar: dataUrl });
          void this.options.onPersistPersona?.(this.personaState);
          /* 头像只影响这一页的显示，不推给聊天面板（它不显示人设图） */
          this.renderPage();
        })();
      },
      onRelabelMessages: async (name) => {
        const panel = this.chatPanel;
        if (panel === null) return 0;

        const messages = panel.getMessages();
        const userCount = messages.filter((one) => one.is_user).length;
        if (userCount === 0) return 0;

        /*
         * 记下滚动位置再改：`setMessages` 会重绘列表把它归零。
         * 批量改名后把位置还回去，用户不会"被弹回顶部"。
         */
        const keepScroll = panel.getScrollTop();
        const next = relabelUserMessages(messages, name);
        panel.setMessages(next, this.chatFileName ?? undefined, this.selectedCharacter?.avatar);
        panel.restoreScroll(keepScroll);

        if (this.chatSnapshot !== null) {
          this.chatSnapshot = { ...this.chatSnapshot, messages: next.slice() };
        }
        await this.persistChat(next, this.selectedCharacter?.avatar ?? null);
        return userCount;
      },
      listWorldbooks: async () => {
        try {
          const raw = await this.withConnection(() => this.bridge.listWorldbooksRaw());
          const parsed: unknown = JSON.parse(raw === '' ? '[]' : raw);
          if (!Array.isArray(parsed)) return [];
          return parsed
            .map((one) => {
              const item = one as Record<string, unknown>;
              const name = item['name'];
              return typeof name === 'string' ? name : '';
            })
            .filter((name) => name !== '');
        } catch {
          /* 读不到就给空列表：下拉里只剩「不关联」，不阻塞页面 */
          return [];
        }
      },
      listCharacters: async () => {
        try {
          const raw = await this.withConnection(() => this.bridge.listCharactersRaw());
          const parsed = parseCharacterList(raw);
          if (!parsed.ok) return [];
          return parsed.items.map((one) => ({ avatar: one.avatar, name: one.name }));
        } catch {
          return [];
        }
      },
    });

    this.pageHost.append(page);
  }

  /* ═══════════════════════════════════════════════════════════
     开场与示例（2026-11-05，用户决定 1 + 2 + 5）
     ═══════════════════════════════════════════════════════════ */

  /** 渲染这一页（数据全在 `this.greetingState`，页面是纯视图） */
  private renderGreeting(): void {
    if (this.pageHost === null) return;

    /*
     * ★★★ 必须先清空（2026-11-05 真机抓到的）。
     *
     * 交互式重绘（打字、加一条备用开场）调的是 `renderGreeting()`，
     * **不经过 `renderPage()`** —— 而 `renderPage()` 里那句
     * `pageHost.replaceChildren()` 是唯一的清空点。
     *
     * 不清的后果：每打一个字就**再叠一页**。真机上的表现是
     * "改了内容，保存按钮还是「没有改动」" —— 因为 `querySelector`
     * 拿到的是**第一页那个旧按钮**，新那一页在后面。
     *
     * 这类缺陷在单测里抓不到（单测直接调渲染函数、没有 pageHost）。
     */
    this.pageHost.replaceChildren();

    const page = renderGreetingPage(this.doc, this.greetingState, {
      /*
       * 返回**统一走 `goBackOneLevel()`**（与 persona 页同一条纪律）：
       * 层级只在一个地方定义，否则"返回去哪"迟早两处不一致。
       */
      onBack: () => {
        this.goBackOneLevel();
      },
      onSelect: (avatar) => {
        void this.openGreetingCard(avatar);
      },
      onChange: (patch) => {
        /*
         * 合并而不是替换：`onChange` 每次只带改的那一段，
         * 替换会把其它三段清空（用户打一个字，另外三段全没了）。
         */
        this.greetingState = {
          ...this.greetingState,
          draft: { ...this.greetingState.draft, ...patch },
        };
        /*
         * 就地重绘整页 —— 因为保存按钮的文案与禁用态依赖"有没有改动"。
         *
         * 代价是每敲一个字都重建 DOM，输入框会失焦。所以只在
         * **改动状态翻转时**才重绘（下面这一行判断），平时不重绘。
         */
        if (this.greetingChangeFlag !== hasGreetingChanges(this.greetingState)) {
          this.greetingChangeFlag = hasGreetingChanges(this.greetingState);
          this.renderGreeting();
        }
      },
      onAddAlternate: () => {
        this.greetingState = {
          ...this.greetingState,
          draft: {
            ...this.greetingState.draft,
            alternateGreetings: [...this.greetingState.draft.alternateGreetings, ''],
          },
        };
        this.renderGreeting();
      },
      onRemoveAlternate: (index) => {
        const next = this.greetingState.draft.alternateGreetings.filter(
          (_, i) => i !== index,
        );
        this.greetingState = {
          ...this.greetingState,
          draft: { ...this.greetingState.draft, alternateGreetings: next },
        };
        this.renderGreeting();
      },
      onSave: () => {
        void this.saveGreeting();
      },
    });

    this.pageHost.append(page);
  }

  /**
   * 「改动状态」的上一帧快照。
   *
   * 只在它翻转时重绘页面：每敲一个字都整页重建会让输入框失焦，
   * 而完全不重绘又会让保存按钮的文案/禁用态停在旧值。
   */
  private greetingChangeFlag = false;

  /**
   * 「已保存 ✓」自动回落的定时器（2026-11-06）。
   *
   * 必须存成字段：连续保存两次时，第一次的定时器会在第二次之后触发，
   * 把刚点亮的"已保存"提前掐掉。存下来就能在每次保存前先清掉上一个。
   */
  private savedFlashTimer: number | null = null;

  /** 清掉上一个回落定时器，返回 null（便于一行赋值） */
  private clearSavedFlashTimer(): null {
    if (this.savedFlashTimer !== null) {
      globalThis.clearTimeout(this.savedFlashTimer);
      this.savedFlashTimer = null;
    }
    return null;
  }

  /**
   * 把「已保存 ✓」就地撤回成「没有改动」——**不重绘整页**（2026-11-06）。
   *
   * `ElLike` 没有 `querySelector`（接口刻意只有少数成员），而这里必须
   * 拿到那个具体按钮。与 `keyboard-inset.ts` 接收 `doc` 的做法一致：
   * 用一次断言读真实 DOM 的可选方法，拿不到就直接返回。
   *
   * ★ 必须校验 `data-state === 'done'`：这 2 秒内用户可能又改了内容，
   *   那次改动会把按钮刷成「保存到卡片」。此时把它改成「没有改动」
   *   就是撒谎 —— 用户会以为改动丢了。
   */
  private paintSavedFlashOff(): void {
    const probe = this.doc as unknown as {
      querySelector?: (selector: string) => ElLike | null;
    };
    const btn = probe.querySelector?.('[data-role="greeting-save"]') ?? null;
    if (btn === null) return;
    if (btn.getAttribute('data-state') !== 'done') return;
    btn.textContent = '没有改动';
    btn.removeAttribute('data-state');
  }

  /** 载入角色列表（这一页的第一步） */
  private async loadGreetingCharacters(): Promise<void> {
    this.greetingState = { ...this.greetingState, loading: true, error: '' };
    this.renderGreeting();

    try {
      const raw = await this.withConnection(() => this.bridge.listCharactersRaw());
      const parsed = parseCharacterList(raw);
      if (!parsed.ok) {
        this.greetingState = {
          ...this.greetingState,
          loading: false,
          error: `读不到角色列表：${parsed.reason}`,
        };
      } else {
        this.greetingState = {
          ...this.greetingState,
          loading: false,
          characters: parsed.items.map((one) => ({ avatar: one.avatar, name: one.name })),
        };
      }
    } catch (error) {
      this.greetingState = {
        ...this.greetingState,
        loading: false,
        error: describeBridgeError(error).message,
      };
    }
    this.renderGreeting();
  }

  /**
   * 打开一个角色的开场与示例。
   *
   * ## ★★★ 读的时候**不解释、不归一**（用户决定 5）
   *
   * 旧版导出的卡、别的工具导出的卡，`residual` 里是什么就显示什么 ——
   * 不剥标签、不改冒号、不猜分隔符。这样"打开看一眼"绝不会改到数据。
   *
   * 归一/升级发生在**保存**那一步（整份按当前规则重新序列化）。
   *
   * ## 为什么走 PNG 而不是 `.json`
   *
   * 引擎的 `readCharacterData()` 读的是 PNG 里的 `chara` tEXt 块，
   * 目录里的 `.json` 只是副产物，很多卡根本没有（真机查过）。
   * 读 `.json` 会拿到过期副本，或者读不到。
   */
  private async openGreetingCard(avatar: string): Promise<void> {
    this.greetingState = { ...this.greetingState, loading: true, error: '', selected: avatar };
    /*
     * ★★★ 这里必须是 `renderPage()`，不是 `renderGreeting()`（2026-11-05 修）。
     *
     * 用户：
     *
     * > 你遗漏了卡片中的开场与示例中的角色界面，点击进入退出对应角色界面
     * > 的时候没有动画（注意如果后续角色多起来后应该如何实现，即不能写死
     * > 现有的角色，后续陆续加进来的也要有动画才行）
     *
     * 真因：`renderGreeting()` 是在**当前层里**清空重绘
     * （`this.pageHost.replaceChildren()`），不新建层 ⇒ `finishPageTurn()`
     * 根本没被调用 ⇒ 一层都没换 ⇒ 没有转场。
     *
     * 而"列表 → 编辑"本来就是换页：`pageKey()` 从 `cards/greeting`
     * 变成 `cards/greeting/edit`，段数 2 → 3 ⇒ 自动 push。
     * 退出（`goBackOneLevel()` 里 `selected = null`）走的是 `renderPage()`，
     * 段数 3 → 2 ⇒ 自动 back。
     *
     * ## 为什么这样对"角色变多"也成立
     *
     * `pageKey()` 只区分**列表**与**编辑**两种形态，**不枚举角色** ——
     * 它不看 avatar 是谁、也不看列表里有几个。所以两个角色和两百个角色
     * 走的是同一条路径、同一套动画，新增角色**不需要改任何动画代码**。
     *
     * 要改的只是"这条入口用哪个渲染函数"，而入口只有这一个
     * （`onSelect` → `openGreetingCard`）。
     */
    this.renderPage();

    try {
      const pngBytes = await this.withConnection(() => this.bridge.characterPng(avatar));
      const png = new Uint8Array(pngBytes);
      const parsed = parsePngCard(png);
      if (parsed.kind !== 'card') {
        this.greetingState = {
          ...this.greetingState,
          loading: false,
          selected: null,
          error: `这张卡没有内嵌设定数据（${parsed.note}）`,
        };
        /*
         * 退回列表也是换页（`cards/greeting/edit` → `cards/greeting`），
         * 同样要走 `renderPage()` —— 否则"打开失败"时页面会硬切回去，
         * 而成功时是滑回去的，同一件事两种观感。
         */
        this.renderPage();
        return;
      }

      const card = parseStCardText(parsed.jsonText);
      const draft: GreetingDraft = {
        scenario: card.card.residual.scenario,
        firstMes: card.card.residual.firstMes,
        alternateGreetings: [...card.card.residual.alternateGreetings],
        mesExample: card.card.residual.mesExample,
      };

      /* 原文留着：保存时在它上面改，其余字段一个字节都不碰 */
      this.greetingJson = parsed.jsonText;
      this.greetingPng = png;
      this.greetingChangeFlag = false;

      this.greetingState = {
        ...this.greetingState,
        loading: false,
        error: '',
        draft,
        baseline: greetingFingerprint(draft),
      };

      /*
       * 解析有问题要**说出来**，但不能拦着不让改。
       *
       * 最常见的是"旧格式卡"（没有这两个板块）。用户能打开、能补内容，
       * 只是要知到这里为什么是空的。
       */
      if (card.issues.length > 0) {
        const first = card.issues[0];
        this.options.onNotify?.(first?.message ?? '这张卡有几处格式问题，已按原样载入', 'warn');
      }
    } catch (error) {
      this.greetingState = {
        ...this.greetingState,
        loading: false,
        selected: null,
        error: describeBridgeError(error).message,
      };
    }

    /*
     * 尾部这次要按 `pageKey()` 分两种情况，所以必须走 `renderPage()`：
     *
     * ```text
     *   加载成功   selected 还是那个角色 ⇒ key 不变 ⇒ 同一页重绘，不播
     *   加载失败   selected 被清成 null   ⇒ key 退回列表 ⇒ 播 back
     * ```
     *
     * 用 `renderGreeting()` 的话第二种情况会硬切回去 ——
     * 同一件事（从编辑页回列表）两种观感。
     */
    this.renderPage();
  }

  /**
   * 保存：改 `residual` → 按**当前**规则序列化 → 嵌回原 PNG → 原子写回。
   *
   * ## ★★★ 这一步就是"无缝升级到现有导出规则"（用户决定 5）
   *
   * `stringifyStCard` 走的是当前这份代码的序列化规则（世界书标题落 `comment`、
   * 顶层 V1 副本同步、v2/v3 结构…）。用户只要点一次保存，卡就自动带上
   * 现在的规则 —— 不需要"迁移工具"，也不需要用户理解版本差异。
   *
   * 反过来，"没点保存的卡一个字节都不变"，所以这条升级是**用户主动触发**的，
   * 不会在导入时静默改写历史数据。
   *
   * ## 为什么只改这四段
   *
   * 只把 draft 里的四个字段写进 `residual`，其余（`systemPrompt` /
   * `postHistoryInstructions` / `passthrough` / 世界书…）原样带着走 ——
   * 它们不在这一页的职责里，动了就是越权。
   */
  private async saveGreeting(): Promise<void> {
    const avatar = this.greetingState.selected;
    if (avatar === null || this.greetingJson === null || this.greetingPng === null) return;

    this.greetingState = { ...this.greetingState, loading: true, error: '' };
    this.renderGreeting();

    try {
      const parsed = parseStCardText(this.greetingJson);
      const draft = this.greetingState.draft;

      /*
       * 空行清掉：用户在备用开场白里点"加一条"之后没写就走，
       * 留下一个空字符串会变成一条**空白开场白** —— 用户换到它时
       * 聊天是空的，而界面上"有一条备用开场"，对不上。
       */
      const alternates = draft.alternateGreetings
        .map((one) => one.trim())
        .filter((one) => one !== '');

      const next = {
        ...parsed.card,
        residual: {
          ...parsed.card.residual,
          scenario: draft.scenario,
          firstMes: draft.firstMes,
          alternateGreetings: alternates,
          mesExample: draft.mesExample,
        },
      };

      /*
       * `entryTitleToComment: true` —— 与桌面端「导出 JSON」同一个选项。
       *
       * 不传的话世界书条目标题只写 `name`，ST 的面板读 `comment` ⇒ 导进 ST
       * 每条标题都是空白。这个选项的存在意义就是"这份文件是给 ST 用的"，
       * 而写到 ST 角色目录里的文件当然属于这一类。
       */
      const jsonText = stringifyStCard(next, { indent: 2, entryTitleToComment: true });

      /*
       * 用**原 PNG** 当容器：`buildPngCard` 只替换卡数据块，
       * 头像图与其它块逐字节保留 —— 重新生成一张会让卡面变掉。
       */
      /*
       * PNG 的 `spec` 是 `'v2' | 'v3'`（不是 keyword 本身）——
       * 由 `PNG_KEYWORD_FOR_SPEC` 映射到 `chara` / `ccv3`。
       * 传错会在 `undefined` 关键字上写出一块 ST 读不到的 tEXt。
       */
      const spec = parsed.card.meta.spec === 'v3' ? 'v3' : 'v2';
      const png = buildPngCard(this.greetingPng, jsonText, spec);

      const status = this.readEngineStatus();
      const charactersDir = status?.charactersDir ?? '';
      if (charactersDir === '') throw new Error('拿不到角色库目录，无法保存');

      await this.withConnection(() =>
        this.bridge.writeCharacterPng(avatar, charactersDir, png, false),
      );

      /* 写成功后把内存里的旧副本换掉：否则再点一次保存会基于旧 JSON 重算 */
      this.greetingJson = jsonText;
      this.greetingPng = png;

      const fresh: GreetingDraft = {
        scenario: draft.scenario,
        firstMes: draft.firstMes,
        alternateGreetings: [...alternates],
        mesExample: draft.mesExample,
      };
      this.greetingChangeFlag = false;
      this.greetingState = {
        ...this.greetingState,
        loading: false,
        /*
         * 清掉上一轮的错误：保存成功后页面不该还挂着上次的失败提示
         * （否则下面那句"成功才发通知"永远不成立，用户又看不到反馈）。
         */
        error: '',
        draft: fresh,
        baseline: greetingFingerprint(fresh),
        /*
         * ★ 点亮按钮上的"已保存 ✓"（2026-11-06，用户问题①）。
         *
         * 不靠顶栏通知的原因见 `GreetingPageState.savedFlash` 的注释：
         * 这一页保存后会整页重绘，topbar 连同里面的通知一起被删。
         */
        savedFlash: true,
      };
      this.savedFlashTimer = this.clearSavedFlashTimer();
      /*
       * 2 秒后回落成「没有改动」。这个时长选在"用户一定能看见、
       * 又不至于一直占着主按钮位置"之间；与下载按钮的三态同规格。
       *
       * ★★★ 回落**不许重绘整页**（2026-11-06 真机抓到的）。
       *
       * 第一版这里调的是 `renderGreeting()`，探针看到的是：
       *
       * ```text
       *   .nb-scroll scrollTop: 648 → 0     ← 滚动位置被清零
       *   activeElement: BODY               ← 焦点丢了
       *   --nb-kb-inset-native: 0           ← 键盘被收起
       * ```
       *
       * 对用户意味着：保存成功 2 秒后，如果他正在改下一个字段，
       * 输入框会被换掉、键盘收起、页面跳回顶部。**为了撤掉一句
       * "已保存 ✓" 而打断用户**，代价远大于收益。
       *
       * 所以这里只改那一个按钮的文字与状态。
       */
      this.savedFlashTimer = globalThis.setTimeout(() => {
        this.savedFlashTimer = null;
        this.greetingState = { ...this.greetingState, savedFlash: false };
        this.paintSavedFlashOff();
      }, 2000) as unknown as number;

      /*
       * 如果改的正是**当前正在聊的那个角色**，让它重读开场白 ——
       * 否则用户改完开场白去聊天，看到的还是旧的那条（因为面板里
       * 已经建好了一条聊天空记录）。
       *
       * 只在"没有历史消息"时重载：有历史说明已经聊过了，
       * 这时换开场白会把用户已有的对话顶掉。
       */
      if (this.chatAvatar() === avatar) {
        void this.refreshOpeningAfterEdit();
      }
    } catch (error) {
      this.greetingState = {
        ...this.greetingState,
        loading: false,
        error: describeBridgeError(error).message,
        savedFlash: false,
      };
    }

    /*
     * ★★★ 重绘必须在**发通知之前**（2026-11-06 真机取证）。
     *
     * 原来这两句是反的：
     *
     * ```text
     *   onNotify('已保存到卡片')   ← 通知挂进 .nb-topbar
     *   renderGreeting()          ← pageHost.replaceChildren()
     *                                 把 .nb-greeting 整个删掉
     *                                 ⇒ topbar 没了 ⇒ 通知也没了
     * ```
     *
     * 用户看到的就是"点保存，什么反应都没有"。而代码里明明有提示 ——
     * 这类"写了但看不见"的缺陷比没写更难查。
     */
    this.renderGreeting();

    /*
     * 通知放最后，挂在新渲染出来的 topbar 里。
     * 成功的文案说"已保存"，不再补一句"到哪里" —— 按钮上已经写了。
     */
    if (this.greetingState.error === '') {
      this.options.onNotify?.('已保存到卡片', 'ok');
    }
  }

  /** 当前正在聊的角色（avatar）；没有就是 null */
  private chatAvatar(): string | null {
    return this.selectedCharacter?.avatar ?? null;
  }

  /**
   * 读一张卡的 `data` 段，存进 `this.loadedCard`。
   *
   * ## 为什么取 `.data` 而不是整份 JSON
   *
   * 面板的 `ctx.card` 一直是**ST 的卡片数据段**（`name` / `description` /
   * `first_mes` / `character_book` …）—— `assembleContext` 与
   * `readWorldbookEntries` 都按这个形状读。
   *
   * V1 卡没有 `data` 段（字段平铺在顶层），所以取不到就整份当 data 用。
   *
   * ## 失败就给空对象
   *
   * 读不到卡不能让聊天用不了 —— 用户还能打字、还能拿到回复，
   * 只是模型不知道在扮演谁。报错中断整页比"降级"更糟。
   */
  private async loadCharacterCard(avatar: string): Promise<void> {
    try {
      const pngBytes = await this.withConnection(() => this.bridge.characterPng(avatar));
      const parsed = parsePngCard(new Uint8Array(pngBytes));
      if (parsed.kind !== 'card') {
        this.loadedCard = {};
        return;
      }
      const json = JSON.parse(parsed.jsonText) as unknown;
      if (json === null || typeof json !== 'object') {
        this.loadedCard = {};
        return;
      }
      const root = json as Record<string, unknown>;
      const data = root['data'];
      this.loadedCard =
        data !== null && typeof data === 'object'
          ? (data as Record<string, unknown>)
          : root;
    } catch {
      this.loadedCard = {};
    }
  }

  /**
   * 改完开场白之后，让**当前这条还没开聊的对话**跟上。
   *
   * ## 只在"没有用户消息"时才换
   *
   * 有用户消息 = 已经聊起来了。这时把开场白换掉会**顶掉用户已有的对话**，
   * 而用户的意图只是改产品化的开场 —— 那两件事必须分开。
   *
   * 判据是"没有一条 `is_user`"，不是"只有一条消息"：用户可能连点两次
   * 重新生成了开场白，条数会变，但"没说过话"这条性质不变。
   */
  private async refreshOpeningAfterEdit(): Promise<void> {
    const panel = this.chatPanel;
    const avatar = this.chatAvatar();
    if (panel === null || avatar === null) return;

    /*
     * 先把新卡读进 `loadedCard`：`refreshOpeningAfterEdit` 是在**保存之后**
     * 调的，此时磁盘上已经是新卡，重读一次就拿得到新的 `first_mes`。
     */
    await this.loadCharacterCard(avatar);

    const messages = panel.getMessages();
    if (messages.some((one) => one.is_user === true)) return;

    const opening = buildOpeningMessages(this.loadedCard);
    if (opening.length === 0) return;

    /*
     * `setMessages` 而不是 `newChat`：`newChat` 会把 `fileName` 置空、
     * 换一个聊天文件 —— 用户只是改了开场白，不该多出一条聊天记录。
     */
    panel.setMessages(opening, this.chatFileName ?? undefined, avatar);
    /*
     * 快照的形状是 `{ fileName, messages }`，**不是** `messages` 本身。
     * 写成 `= opening` 会让下一次 `renderChat()` 读到 `snapshot.messages`
     * 得 `undefined` ⇒ 面板一片空白（而磁盘上有内容）。
     */
    if (this.chatFileName !== null) {
      this.chatSnapshot = { fileName: this.chatFileName, messages: opening.slice() };
    }
    this.handleChatChanged(opening);
  }

  /**
   * 把人设的当前状态推给聊天面板。
   *
   * 三样东西要一起推，缺一样就会出现"改了没生效"：
   * - `userName` → `{{user}}` 替换
   * - `persona.description` → 上下文里"你是谁"那段
   * - `persona.position` → 那段插到哪
   */
  /** 当前该用的用户名：选中的人设优先，否则用外部传入的默认名 */
  private currentUserName(): string {
    return activePersona(this.personaState)?.name ?? this.options.userName;
  }

  /**
   * 人设对应的 ctx 片段。
   *
   * 抽出来是为了让"首次创建面板"和"改完人设推更新"用**同一份**逻辑 ——
   * 各写一遍必然分叉，而分叉的表现是"重启后生效、改完不生效"这类
   * 只在特定路径出现的怪现象。
   */
  private personaContext():
    | undefined
    | {
        name: string;
        description: string;
        position: 'in_prompt' | 'top_an' | 'bottom_an' | 'at_depth' | 'none';
        depth: number;
        role: 'system' | 'user' | 'assistant';
      } {
    const active = activePersona(this.personaState);
    if (active === null) return undefined;
    return {
      name: active.name,
      description: active.description,
      position: active.position,
      depth: active.depth,
      role: active.role,
    };
  }

  private syncPersonaToChat(): void {
    /*
     * 标签一起更新（2026-11-06）：顶栏胶囊也跟着换名字。
     * 只推 `userName` 的话，胶囊会停在旧人设名上 —— 而用户刚点的就是它。
     */
    const label = activePersona(this.personaState)?.name ?? '';
    this.chatPanel?.setContext({
      userName: this.currentUserName(),
      persona: this.personaContext(),
      personaLabel: label,
    });
    this.chatPanel?.syncPersonaChip(label);
  }

  /**
   * 聊天页顶栏的人设胶囊被点：弹出可切换的列表（2026-11-06）。
   *
   * ## 用户的原话
   *
   * > 找个地方加一个可以方便切换当前聊天的人设的东西
   *
   * ## 为什么列表来自 `personasForCharacter()` 而不是 `state.personas`
   *
   * 那是"这个角色能用哪几套"的唯一判定（绑定关系 + 全局多绑定开关）。
   * 这里自己再过滤一遍必然与它分叉 —— 分叉的表现是"管理页能看到、
   * 聊天页切不到"，而两边都觉得自己对。
   *
   * ## 为什么末位多一项「不设人设」
   *
   * 用户可能只想临时用默认名（`userName`）聊。没有这一项时，
   * 一旦选了某套人设就再也回不到"没有" —— 只能去管理页删掉，
   * 那是很重的动作。`selectPersona(state, null)` 本来就支持，
   * 只是一直没有入口。
   */
  private openPersonaSwitcher(anchor: unknown): void {
    const avatar = this.chatAvatar();
    const available = avatar === null ? this.personaState.personas : personasForCharacter(this.personaState, avatar);

    if (available.length === 0) {
      this.options.onNotify?.('还没有用户设定，去「卡片 → 用户设定管理」加一套', 'info');
      return;
    }

    const currentId = this.personaState.selectedId ?? '';
    /*
     * 末位「默认人设」= 不绑定任何一套，用默认名。
     *
     * ★ 文案从「不设人设（用默认名）」缩到这里（2026-11-07，用户要求）：
     *
     * > 默认人设这个列表里面你就写默认或者默认人设就行
     *
     * 原来那 10 个字是全列表最长的一条，逼着面板按它算宽度、
     * 在窄屏上还要换行。短文案让面板能小一点、也更像"一个选项"
     * 而不是"一句解释"。
     */
    const options = [
      ...available.map((one) => ({ value: one.id, label: one.name })),
      ...(currentId === '' ? [] : [{ value: '', label: '默认人设' }]),
    ];

    openSelectPopover(this.doc, {
      options,
      current: currentId,
      anchorEl: anchor,
      onPick: (value) => {
        const next = selectPersona(this.personaState, value === '' ? null : value);
        this.personaState = next;

        /* 先推送再落盘：界面上立刻生效，落盘失败也不会让操作看起来没反应 */
        this.syncPersonaToChat();
        void this.options.onPersistPersona?.(next).catch(() => {
          this.options.onNotify?.('人设切换已生效，但没能存下来（重启后会复原）', 'warn');
        });

        /*
         * 提示只在用户开了那个全局开关时给（ST 的「切换用户设定时显示提示」）。
         * 默认值是开的，但用户可能关掉 —— 关掉就安静切换。
         */
        if (next.notifyOnSwitch) {
          const name = activePersona(next)?.name ?? this.currentUserName();
          this.options.onNotify?.(`已切换到：${name}`, 'ok');
        }
      },
    });
  }

  /* ═══════════════════════════════════════════════════════════
     聊天设置（聊天 Tab 的二级页，2026-10-31 第三批问题二）
     ═══════════════════════════════════════════════════════════ */

  /**
   * 选卡器（2026-10-31 第五批问题二）。
   *
   * ## 关闭的两种方式都要 resolve
   *
   * 用户返回（点 ‹）与选中卡，都必须把 promise 结掉 ——
   * 不结的话 `ChatPanel` 那边 `await` 永远挂着，界面上是"按钮没反应"，
   * 而且再也点不动第二次（第一次的 promise 还在等）。
   */
  private renderCharacterPicker(): void {
    if (this.pageHost === null) return;

    const page = renderCharacterPicker(this.doc, {
      load: async () => {
        try {
          const raw = await this.withConnection(() => this.bridge.listCharactersRaw());
          const parsed = parseCharacterList(raw);
          if (!parsed.ok) {
            this.lastSettingsFailure = parsed.reason;
            return null;
          }
          return parsed.items;
        } catch (error) {
          this.lastSettingsFailure = describeBridgeError(error).message;
          return null;
        }
      },
      describeFailure: () =>
        describeSettingsFailure(this.options.readEngineStatus?.() ?? null, this.lastSettingsFailure ?? undefined),
      /*
       * 圆形头像（2026-11-04 用户要求）。
       *
       * 图不是从 `<img src="http://127.0.0.1...">` 来的 —— 这个壳里
       * 那条路不通（与 fetch 同一个根因），必须走桥读字节转 base64。
       * 细节在 `thumbnail.ts`。
       *
       * 取不到就返回 null，头像组件退回首字占位圆：
       * 一张没有封面的卡不该让整行看起来像坏了。
       */
      loadThumbnail: (avatar: string) => loadThumbnail(avatar),
      onPick: (character: CharacterSummary) => {
        const resolve = this.pickResolve;
        this.pickResolve = null;
        this.pickerOpen = false;

        /*
         * ★ 结果记在外壳，**不交给旧面板**。
         *
         * 见 `selectedCharacter` 的注释：重绘会重建面板，交给旧面板等于丢掉。
         * 这里 resolve(null) 只是让旧面板的 `await` 退出（它拿 null 就 return，
         * 不会有副作用），真正的状态恢复在 `renderChat()` 里做。
         */
        /*
         * 先判断"点的就是当前角色"——必须在**覆盖** `selectedCharacter`
         * 之前判，否则永远相等。
         */
        const sameAsCurrent =
          this.selectedCharacter !== null &&
          this.selectedCharacter.avatar === character.avatar;

        this.selectedCharacter = { avatar: character.avatar, name: character.name };

        /*
         * ★★★ 跳转必须**立刻**发生，不能等读完历史（2026-11-06）。
         *
         * ## 原来的问题
         *
         * 用户：
         *
         * > 选择聊天时同一个角色不跳转到聊天
         *
         * 真机录屏：点角色后画面一直停在「选择角色」，7 秒都没动。
         *
         * 真因不是"跳错页"，是**跳不过去**：
         *
         * ```text
         *   void (async () => {
         *     await loadCharacterCard(...)      // 有 try/catch，不抛
         *     await restoreLatestChat(...)      // ★ 重试循环最长 60 秒
         *     this.renderPage()                 // ← 排在它们后面
         *   })();
         * ```
         *
         * `restoreLatestChat` 在"引擎没连上 / 读不到历史"时会每 2 秒重试、
         * 直到 60 秒超时。而 `renderPage()`（真正负责关闭选择器、回到聊天页）
         * 排在它后面 ⇒ **这 60 秒里点任何角色都没反应**。
         *
         * ## 现在：先跳，再补内容
         *
         * ```text
         *   ① 同步 renderPage()      ⇒ 立刻关掉选择器、回到聊天页
         *   ② 后台读卡 + 读历史      ⇒ 读到再 renderPage() 补上
         * ```
         *
         * 而且 `try/catch` 兜住 —— 任何一步失败都不会让用户卡在选择页。
         *
         * ## "点的就是当前角色"时直接跳
         *
         * 用户建议：
         *
         * > 建议检测一下用户当前点击的是不是聊天中的角色，不是就直接加载
         * > 点击的角色并跳转，如果是就直接跳转
         *
         * 对。同一个角色重读一遍卡和 60 秒的重试毫无意义 ——
         * 内存里的快照就是最新的。直接跳，一个字都不重新拉。
         */
        if (sameAsCurrent) {
          /*
           * 同一个角色：**什么都不重读**，直接关掉选择器回去。
           * 这是最理想的一条 —— 零网络、零闪烁。
           */
          this.renderPage();
          resolve?.(null);
          return;
        }

        /*
         * 不同角色：先把旧聊天状态清掉（否则新角色会带着上一个的文件名，
         * 保存时写进别人的目录），再**立即跳过去**。
         */
        this.chatFileName = null;
        this.chatSnapshot = null;
        this.lastSavedFingerprint = null;

        /* ① 立即跳（不 await） */
        this.renderPage();
        resolve?.(null);

        /* ② 后台补内容 */
        void (async () => {
          try {
            await this.loadCharacterCard(character.avatar);
            await this.restoreLatestChat(character.avatar);
            /*
             * 读完再刷一次把消息填进去。
             *
             * ★ 仍要判一次"用户还在这个角色上"：这期间他可能又切到别的角色，
             *   那时这次刷新会把别人的界面覆盖掉。
             */
            if (this.selectedCharacter?.avatar === character.avatar) {
              this.renderPage();
            }
            this.persistSession();
          } catch {
            /*
             * 读失败**不影响跳转**（已经跳了）。面板会显示"还没有对话"，
             * 用户可以直接开始聊 —— 那比停在选择页可操作得多。
             */
          }
        })();
      },
      onBack: () => {
        const resolve = this.pickResolve;
        this.pickResolve = null;
        this.pickerOpen = false;
        this.renderPage();
        resolve?.(null);
      },
      onRetry: () => {
        this.renderPage();
      },
      /*
       * 原话：
       *
       * > 选择角色时长按删除设备（是彻底删除并且 ST 内无该角色及其相关数据和聊天记录）
       *
       * 引擎侧一次调用做完（`/api/characters/delete` + `delete_chats: true`
       * 会 `fs.rm` 整个聊天目录），所以这里不需要"先删卡片再删聊天"。
       */
      onDelete: async (character: CharacterSummary) => {
        try {
          await this.withConnection(() =>
            this.bridge.deleteCharacter(character.avatar, true),
          );
        } catch (error) {
          return { ok: false, detail: describeBridgeError(error).message };
        }

        /*
         * ★ 删掉的正好是"当前选中的角色"时要把它清掉。
         *
         * 不清的后果：顶栏还显示着那个角色的名字，用户点发送才报错 ——
         * 而那个角色在引擎里已经不存在了。这种"界面残留"比删除失败更难理解。
         */
        if (this.selectedCharacter?.avatar === character.avatar) {
          this.selectedCharacter = null;
          this.chatFileName = null;
          this.chatSnapshot = null;
          this.lastSavedFingerprint = null;
          this.persistSession();
        }

        return { ok: true, detail: `已删除「${character.name}」和它的聊天记录` };
      },

      /*
       * 导出为 PNG 并分享（2026-11-04 用户要求）。
       *
       * 复用 `st_chat_character_png`：它走引擎的 `/api/characters/export`，
       * 会 `unsetPrivateFields` —— 分享出去的卡不带本地运行时字段
       * （`chat_size` / `date_last_chat`），对方拿到的是干净的卡。
       *
       * 同步返回：原生分享面板由 Kotlin 拉起，这里拿不到"用户选了哪个应用"
       * （那是系统 UI），所以只报到"字节已交给分享面板"为止。
       */
      onShare: (character: CharacterSummary): ShareOutcome => {
        /*
         * `st_chat_character_png` 是 Tauri 命令（走异步 `invoke`），
         * 而 `onShare` 是同步签名。所以这里只能读**已预取**的字节。
         *
         * 没取到就如实说"正在准备"，**不要**拿一张别的卡的字节顶上 ——
         * 那会让用户分享出错误的卡，且完全无声。
         */
        const cached = this.shareCache.get(character.avatar);
        if (cached === undefined) {
          /* 还没预取：先发一次异步预取，并提示用户再点一下 */
          void this.prefetchForShare(character.avatar);
          return { ok: false, reason: '正在准备，稍等一下再点一次' };
        }
        return shareCardPng(character.name, cached);
      },
    });

    this.pageHost.append(page);

    /*
     * 面板出现后**预取**当前列表每张卡的字节。
     *
     * 为什么要预取：`onShare` 是同步的（Kotlin 的分享要同步拿参数），
     * 而读 PNG 必须走异步的 `invoke`。等到用户点"导出并分享"才去读，
     * 那次点击就只能拿到"正在准备"。
     *
     * 逐张串行预取而不是并发：一张卡几百 KB，20 张并发会把
     * WebView 的内存顶起来（实测过 788 KB × N）。列表通常不超过 20 张，
     * 串行只多几百毫秒。
     */
    void (async () => {
      try {
        const raw = await this.withConnection(() => this.bridge.listCharactersRaw());
        const parsed = parseCharacterList(raw);
        if (!parsed.ok) return;
        for (const item of parsed.items) {
          if (this.shareCache.has(item.avatar)) continue;
          await this.prefetchForShare(item.avatar);
        }
      } catch {
        /* 预取失败不影响列表；用户点分享时会再试一次并给出原因 */
      }
    })();
  }

  /** 预取一张卡的 PNG 字节到分享缓存（失败就清掉，下次重试） */
  private async prefetchForShare(avatar: string): Promise<void> {
    if (this.shareCache.has(avatar)) return;
    try {
      const bytes = await this.withConnection(() => this.bridge.characterPng(avatar));
      this.shareCache.set(avatar, new Uint8Array(bytes));
    } catch {
      this.shareCache.delete(avatar);
    }
  }

  /** 四项菜单 */
  private renderChatSettingsMenu(): void {
    if (this.pageHost === null) return;

    const page = renderChatSettingsMenu(this.doc, this.makeSettingsCallbacks());
    this.pageHost.append(page);
  }

  /** 某一组的字段表单 */
  private renderChatSettingsSection(groupId: string): void {
    if (this.pageHost === null) return;

    /*
     * 世界书与「用户 UI 设置」都还没有内容页，给空状态说明。
     *
     * ★ 文案纪律（用户 2026-11-04 明令）：
     *
     * > 加一个提示为暂不支持就行（不要再加为什么不支持了，
     * > 这个是开发阶段的文字，我要的是用户该看到的东西）
     *
     * 所以只说"暂不支持"，**不写原因**。"因为 CFG 要发两次请求、
     * 成本翻倍"这类是给自己看的判断依据，用户不需要。
     */
    /*
     * 世界书已经是真页面了（2026-11-04）；「用户 UI 设置」仍是空状态。
     */
    if (groupId === 'worldbook') {
      this.renderWorldbookPage();
      return;
    }

    if (groupId === 'ui') {
      this.pageHost.append(
        renderEmptyState(this.doc, {
          halo: '🎨',
          title: '用户 UI 设置',
          text: '暂不支持',
          actions: [{ label: '返回设置', primary: true, onClick: () => this.backToSettingsMenu() }],
        }),
      );
      return;
    }

    const page = renderFieldSection(this.doc, groupId, this.makeSettingsCallbacks());
    this.pageHost.append(page);
  }

  /**
   * 世界书管理页（2026-11-04）。
   *
   * ## 所有网络调用都走桥，页面一行 fetch 都不写
   *
   * 与世界书相关的 5 个命令都在 `st-bridge.ts`（list / get / edit /
   * import / delete），它们走 Rust 侧的 CSRF token 管理 ——
   * 直接用桥的 `httpRequest` 会 403（ST 的 /api/* 要 token）。
   */
  private renderWorldbookPage(): void {
    if (this.pageHost === null) return;

    const page = renderWorldbookPage(this.doc, {
      onList: async (): Promise<WorldbookSummary[]> => {
        const raw = await this.withConnection(() => this.bridge.listWorldbooksRaw());
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw === '' ? '[]' : raw);
        } catch {
          parsed = null;
        }
        if (!Array.isArray(parsed)) return [];
        return parsed
          .map((one): WorldbookSummary | null => {
            if (one === null || typeof one !== 'object') return null;
            const rec = one as Record<string, unknown>;
            const fileId = typeof rec['file_id'] === 'string' ? rec['file_id'] : '';
            if (fileId === '') return null;
            const name = typeof rec['name'] === 'string' && rec['name'] !== '' ? rec['name'] : fileId;
            return { fileId, name };
          })
          .filter((one): one is WorldbookSummary => one !== null);
      },

      onRead: (fileId) => this.withConnection(() => this.bridge.getWorldbookRaw(fileId)),

      onSave: async (fileId, entries) => {
        /*
         * 整份写回。`serializeWorldbook` 会把不认识的字段原样带回去 ——
         * 只传改动的那几条等于删掉其余条目。
         */
        const payload = JSON.stringify(serializeWorldbook(entries));
        await this.withConnection(() => this.bridge.editWorldbook(fileId, payload));
      },

      onImport: async (name, jsonText) => {
        /*
         * ST 的 import 收 `{ name, data:<entries> }`。
         *
         * 页面上来的可能是整份 `{entries:{...}}`（我们新建时给的），
         * 也可能是从世界书文件里读出来的同形状 —— 这里统一剥成 entries。
         */
        let entriesOnly: unknown = jsonText;
        try {
          const parsed: unknown = JSON.parse(jsonText);
          entriesOnly =
            parsed !== null &&
            typeof parsed === 'object' &&
            !Array.isArray(parsed) &&
            (parsed as Record<string, unknown>)['entries'] !== undefined
              ? (parsed as Record<string, unknown>)['entries']
              : parsed;
        } catch {
          throw new Error('内容不是合法 JSON');
        }
        await this.withConnection(() =>
          this.bridge.importWorldbook(name, JSON.stringify(entriesOnly)),
        );
      },

      onDelete: async (fileId) => {
        await this.withConnection(() => this.bridge.deleteWorldbook(fileId));
      },

      onRename: async (fileId, nextName) => {
        /*
         * 重命名没有独立接口：读出来 → 用新名字 import → 删掉旧的。
         *
         * 顺序不能反（先删后写）：中途失败会两边都没有。
         * 先写新名字，即使最后删不掉旧名字，用户的数据也还在。
         */
        const raw = await this.withConnection(() => this.bridge.getWorldbookRaw(fileId));
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw === '' ? '{}' : raw);
        } catch {
          throw new Error('这本书读不出来，没法改名');
        }
        const entriesOnly =
          parsed !== null &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          (parsed as Record<string, unknown>)['entries'] !== undefined
            ? (parsed as Record<string, unknown>)['entries']
            : parsed;

        await this.withConnection(() =>
          this.bridge.importWorldbook(nextName, JSON.stringify(entriesOnly)),
        );
        await this.withConnection(() => this.bridge.deleteWorldbook(fileId));
      },

      onPickFile: async () => {
        /*
         * 移动端没有通用文件选择契约，用 `<input type="file">`。
         *
         * 与头像上传同一套思路（`onShowFileChooser` 在 WebView 里是通的）。
         */
        const input = this.doc.createElement('input');
        input.setAttribute('type', 'file');
        input.setAttribute('accept', 'application/json,.json');
        input.setAttribute('style', 'position:fixed;left:-9999px;top:0;opacity:0;');
        const body = (this.doc as unknown as { body?: ElLike }).body;
        if (body === undefined) return null;
        body.append(input);

        try {
          const file = await new Promise<{ name: string; text: string } | null>((resolve) => {
            let settled = false;
            const finish = (value: { name: string; text: string } | null): void => {
              if (settled) return;
              settled = true;
              resolve(value);
            };
            input.addEventListener('change', () => {
              const picked = (input as unknown as HTMLInputElement).files?.[0];
              if (picked === undefined) {
                finish(null);
                return;
              }
              const reader = new FileReader();
              reader.onload = () => {
                finish({
                  name: picked.name,
                  text: typeof reader.result === 'string' ? reader.result : '',
                });
              };
              reader.onerror = () => finish(null);
              reader.readAsText(picked);
            });
            input.addEventListener('cancel', () => finish(null));
            globalThis.setTimeout(() => finish(null), 60_000);
            (input as unknown as HTMLInputElement).click();
          });
          return file;
        } finally {
          input.remove();
        }
      },

      /*
       * 全局激活设置：存在**引擎的全局设置**里（`world_info` 那一组），
       * 不是每本世界书各自一份。所以读要用 `settingsGetRaw`、
       * 写要用 `mutateSettings`（它已经有"整份读→改→写"的三道防线）。
       */
      onReadSettings: async (): Promise<WorldGlobalSettings> => {
        const raw = await this.withConnection(() => this.bridge.settingsGetRaw());
        const envelope: unknown = JSON.parse(raw === '' ? '{}' : raw);
        const parsed = parseSettingsEnvelope(envelope);
        if (!parsed.ok) return { ...DEFAULT_GLOBAL_SETTINGS };
        const group = parsed.settings['world_info'];
        if (group === null || group === undefined || typeof group !== 'object') {
          return { ...DEFAULT_GLOBAL_SETTINGS };
        }
        return readWorldSettings(group as Record<string, unknown>);
      },

      onSaveSettings: async (next) => {
        /*
         * 逐项写回。`mutateSettings` 会先读整份、只改这几项、再整份写 ——
         * 避免"只发这几项"把其余设置清掉。
         */
        const result = await mutateSettings(
          {
            getRaw: () => this.withConnection(() => this.bridge.settingsGetRaw()),
            save: (settings) => this.withConnection(() => this.bridge.settingsSave(settings)),
          },
          (current: Record<string, unknown>) => {
            const group =
              current['world_info'] !== null &&
              typeof current['world_info'] === 'object' &&
              !Array.isArray(current['world_info'])
                ? (current['world_info'] as Record<string, unknown>)
                : {};
            /*
             * `writeWorldSettings` 只给出**我们负责的那几项**。
             *
             * 这里做两层展开而不是直接赋值：`world_info` 里还有
             * `globalSelect` 之类我们不碰的字段，`budget` 里也有。
             * 直接赋值会把它们清掉（整组覆盖的坑，§93）。
             */
            const patch = writeWorldSettings(next);
            const budgetPatch = patch['budget'] as Record<string, unknown>;
            const budgetBase =
              typeof group['budget'] === 'object' && group['budget'] !== null
                ? (group['budget'] as Record<string, unknown>)
                : {};
            return {
              ...current,
              world_info: {
                ...group,
                ...patch,
                budget: { ...budgetBase, ...budgetPatch },
              },
            };
          },
        );
        if (!result.ok) throw new Error(result.reason);
      },

      onBack: () => this.backToSettingsMenu(),
      onNotify: (message, kind) => this.options.onNotify?.(message, kind),
    });

    this.pageHost.append(page);
  }

  private backToSettingsMenu(): void {
    this.chatSettingsRoute = 'menu';
    this.renderPage();
  }

  /**
   * 设置页需要的四个能力。
   *
   * ## 为什么 `loadSettings` 失败要返回 null 而不是空对象
   *
   * `renderFieldSection` 拿到 null 会显示"读不到"并**不渲染表单**。
   * 返回 `{}` 的话页面会拿 fallback 值渲染出一张"看起来正常"的表单，
   * 用户在它上面改，一保存就用 fallback 覆盖了真实设置 ——
   * 这是"整份覆盖"最阴的一处（同 `mutateSettings` 那三道防线守的东西）。
   */
  /**
   * 确保已经连上 ST（2026-10-31 第五批**补上的缺口**）。
   *
   * ## 这个方法是本次三个问题里的两个的修复点
   *
   * 修之前：`StChatBridge.connect()` **全库零调用**。Rust 侧
   * `StChatState.api` 因此恒为 `None`，`api()` 直接返回
   * `ShellError::StUnavailable`。于是：
   *
   * · 保存 API 配置 → `writeSecret` 抛错 → 界面显示 `[object Object]`
   * · 打开设置页 → `settingsGetRaw` 抛错 → 显示"读不到当前的聊天设置"
   *
   * ## 三个设计取舍
   *
   * 1. **并发共享同一次尝试**。设置页会同时读三组配置，若每次都连
   *    就会连三次 —— 而 `connect` 每次丢 cookie jar，连三次等于互相打断。
   *    用 `connecting` 把并发的合并成一次。
   * 2. **失败不缓存**。引擎可能要几十秒才起来（首次启动 57 秒），
   *    失败后下次调用必须能重试。缓存失败会让"等一会儿再点重试"永远失效。
   * 3. **`baseUrl` 为空直接判失败**而不是硬连 `127.0.0.1:8000` ——
   *    地址是配置的一部分，猜一个会让报错指向错误的对象。
   */
  private async ensureConnected(): Promise<{ ok: boolean; error?: unknown }> {
    if (this.connected) return { ok: true };
    if (this.connecting !== null) return this.connecting;

    const baseUrl = this.options.stBaseUrl.trim();
    if (baseUrl === '') {
      return { ok: false, error: { code: 'NO_BASE_URL', message: '还没填写服务地址' } };
    }

    this.connecting = (async () => {
      try {
        await this.bridge.connect(baseUrl);
        this.connected = true;
        return { ok: true };
      } catch (error) {
        // 见取舍 2：失败不置标记，下次还能重试
        this.connected = false;
        return { ok: false, error };
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  /**
   * 包一层：先确保连接，再执行。失败时把原错误交回去（调用方自己决定怎么显示）。
   *
   * 观察到 `ST_UNAVAILABLE` 时清掉 `connected` —— 那个码的含义就是
   * "Rust 侧的 api 没了"，不清的话后续每次都会立刻失败、永远不重连。
   */
  /**
   * 从 ST 设置派生采样参数，并**钉上用户在 API 页填的「最大回复长度」**。
   *
   * ## 为什么必须有这一个统一入口
   *
   * `this.sampling` 有**三处**会从 ST 重新派生（播种、设置页保存、API 页保存）。
   * 任何一处漏了覆盖，用户的 maxTokens 就被 ST 里的旧值（300）冲掉 ——
   * 而症状是"界面显示 1200、请求里发 300"，没有任何报错。
   *
   * 真机实测过：保存 1200 后 logcat 里仍是 `max_tokens=300`，
   * 就是因为另一处的 `samplingFromSettings()` 在后来的渲染里把我覆盖冲掉了。
   *
   * ## 为什么以 API 页为准而不是以 ST 为准
   *
   * ST 的 `openai_max_tokens` 是**引擎全局**设置，用户可能在别处改过；
   * 而 API 页这一格是他**当着这个模型**填的，意图更明确。
   * 两处冲突时以意图明确的那一处为准。
   */
  private deriveSampling(settings: Record<string, unknown>): DerivedSampling {
    const derived = samplingFromSettings(settings);
    const want = this.apiState?.maxTokens;
    return typeof want === 'number' && want > 0
      ? { ...derived, maxTokens: want }
      : derived;
  }

  /**
   * 把「最大回复长度」写进 ST 设置（`oai_settings.openai_max_tokens`）。
   *
   * ## 为什么必须落到 ST
   *
   * 请求体里的 `max_tokens` 由 `samplingFromSettings()` 从 ST 设置派生。
   * 只在 App 侧存一个数字**不会生效** —— 界面显示 800、请求里还是 300，
   * 而用户看到的只有"模型又不回话了"。这是最典型的"改了但没变"。
   *
   * ## 为什么走 `mutateSettings`
   *
   * GET → 改一个字段 → 整份 POST。直接 POST 是整份覆盖，
   * 少一个字段就把用户其它设置清空了（契约陷阱 #6）。
   *
   * @returns `null` 表示成功；否则返回失败原因（由调用方决定怎么提示）
   */
  /**
   * 把 API 连接配置**真正写进 SillyTavern**（2026-11-04，第二十八批）。
   *
   * ## 这个方法是本次取证后的修复核心
   *
   * 取证结论（用户批准排查的那条链路）：
   *
   * ```text
   *   点保存 → 只写 localStorage（tcs.mobile.apiState）
   *          → ST 的 secrets 从来没写过（SecretWriter 定义了但零调用）
   *          → ST 的 settings 只写过 max_tokens，source/model/url 一项没写
   * ```
   *
   * 于是 ST 里永远是出厂值 `openai / gpt-4-turbo`，而 App 里是
   * `custom / deepseek-v4-pro`。App 内能聊（请求体用本地那份），
   * 但 ST 逃生门看到的配置与 App 不一致。
   *
   * ## 三步：写 secrets → 写 settings → **回读校验**
   *
   * 用户明确要求：
   *
   * > 保存必须真实落到 ST（chat_completion_source / model / key 走 ST 的
   * > secrets+settings 接口），回读验证后 UI 反馈才允许显示成功
   *
   * 所以第三步不可省：POST 200 只证明服务端收下了，不证明它按我们的意思存了。
   *
   * @returns 成功返回 `null`；失败返回给用户看的原因（可能多条）
   */
  private async writeApiConnectionToSt(
    state: ApiPageState,
    apiKey: string | null,
  ): Promise<string[] | null> {
    const problems: string[] = [];

    /* ── ① 秘钥：写 ST 的 secrets（`api_key_<源>`）── */
    let keyWritten = false;
    if (apiKey !== null && apiKey.trim() !== '') {
      try {
        await this.withConnection(() =>
          this.bridge.writeSecret(secretKeyOf(state.source), apiKey.trim()),
        );
        keyWritten = true;
      } catch (error) {
        /*
         * 写不进去**必须报**：只改源和模型而不写 key，等于把用户
         * 从"能聊"改成"必然 401"，而且表面上一切正常。
         */
        problems.push(
          `秘钥没写进引擎：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    /* ── ② settings：source / model / custom_url ── */
    const patch = buildStConnectionPatch(state);
    let saved: Record<string, unknown> | null = null;
    try {
      const result = await mutateSettings(
        {
          getRaw: () => this.withConnection(() => this.bridge.settingsGetRaw()),
          save: (settings) => this.withConnection(() => this.bridge.settingsSave(settings)),
        },
        (current) => {
          const oai = current['oai_settings'];
          const base = oai !== null && typeof oai === 'object' ? (oai as Record<string, unknown>) : {};
          return { ...current, oai_settings: { ...base, ...patch } };
        },
      );
      if (!result.ok) {
        problems.push(`连接配置没写进引擎：${result.reason}`);
      } else {
        saved = result.settings;
      }
    } catch (error) {
      problems.push(
        `连接配置没写进引擎：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    /* ── ③ 回读校验：不信"写成功"，只信"读回来一致" ── */
    if (saved !== null) {
      try {
        const raw = await this.withConnection(() => this.bridge.settingsGetRaw());
        const envelope: unknown = JSON.parse(raw === '' ? '{}' : raw);
        const parsed = parseSettingsEnvelope(envelope);
        if (!parsed.ok) {
          problems.push(`保存后核对不一致：${parsed.reason}`);
        } else {
          const verdict = verifyConnectionPersisted(parsed.settings, {
            source: state.source,
            model: state.model,
            baseUrl: state.baseUrl,
            keyWritten,
          });
          if (!verdict.ok) problems.push(...verdict.problems);
        }
      } catch (error) {
        problems.push(
          `保存后核对不一致：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return problems.length === 0 ? null : problems;
  }

  private async writeMaxTokens(value: number): Promise<string | null> {
    try {
      /*
       * 从 **schema 里取那个字段定义**，不要自己拼一个对象。
       *
       * `writeField` 要的是 `SettingField`（含 `path`/`kind`/`min`/`max`），
       * 而 schema 已经有一份权威定义（`SAMPLING_SECTION` 里的「单条回复上限」）。
       * 自己拼一份的后果是：将来 schema 改了（比如上限从 32000 调整），
       * 这里还是旧的，而**不会报错** —— 只是夹值夹错了。
       */
      const field = SAMPLING_SECTION.fields.find(
        (f) => f.path.join('.') === 'oai_settings.openai_max_tokens',
      );
      if (field === undefined) return '找不到「单条回复上限」这个设置项（schema 变了）';

      const result = await mutateSettings(
        {
          getRaw: () => this.withConnection(() => this.bridge.settingsGetRaw()),
          save: (settings) => this.withConnection(() => this.bridge.settingsSave(settings)),
        },
        (current) => writeField(current, field, value),
      );
      if (!result.ok) return result.reason;
      /*
       * 写成功后把新采样值推给聊天面板 —— 否则下一次生成仍用旧值，
       * 用户必须重启 App 才能生效。
       */
      this.sampling = this.deriveSampling(result.settings);
      /*
       * ★★★ 再**强制覆盖一次** maxTokens（2026-11-02）。
       *
       * `samplingFromSettings()` 是从 ST 设置派生出来的。如果 ST 那边
       * 把我们写的值夹掉/丢了（比如它把上限当 "无效值" 忽略），
       * 派生结果里就不是用户填的数 —— 而**界面显示 800、请求里还是 300**，
       * 用户看到的现象就是"改了没用"。
       *
       * 真机实测过这一点：保存 1200 之后请求仍被 300 截断（frames=302 不变）。
       * 所以这里不信派生结果，直接把用户的值钉进去。
       */
      this.sampling = { ...this.sampling, maxTokens: value };
      this.chatPanel?.setContext({ sampling: { ...this.sampling } });
      return null;
    } catch (error) {
      /*
       * 写 ST 失败**不能**让这一次的修改白费 —— 用户填了就该在当前会话生效。
       * 持久化失败只影响"重启后还在不在"，那是次要的。
       */
      this.sampling = { ...this.sampling, maxTokens: value };
      this.chatPanel?.setContext({ sampling: { ...this.sampling } });
      return describeBridgeError(error).message;
    }
  }

  /**
   * 问 ST「哪些 source **真的配了** key」，并据此更新标记（2026-11-07）。
   *
   * ## 为什么不能只用本地标记
   *
   * 「这个源配没配 key」原来完全由 localStorage 记着。那标记有三种丢法：
   *
   * ```text
   *   ① 换版本 / 清缓存 / 重装
   *   ② 用户直接在 ST 的原始界面配过（我们不知道）
   *   ③ 保存时 `stOk` 为假但 key 其实写进去了
   * ```
   *
   * 用户真机报的就是这个：**配了 key，界面说"未配 key"**。
   *
   * ## 「不知道」时保持现状，不清空
   *
   * 连不上 / ST 解析失败 ⇒ 直接 return，**不动** `apiKeyPresent`。
   *
   * ★ 这一点很重要：如果把失败当成"都没有"，一个临时故障就会让
   *   6 个源全变成红标记，用户以为自己的 key 被删了。
   *   所以 Rust 侧解析失败返回 `Err`（不是空列表），这里 catch 住跳过。
   *
   * ## 为什么可以"整体替换"
   *
   * ST 是真相。它说有的未必在本地标记里（这就要补上），
   * 它说没有的一定没有（本地标记多出来的就是过期数据）。
   */
  private async refreshKeyPresence(): Promise<void> {
    let names: string[];
    try {
      names = await this.withConnection(() => this.bridge.secretPresent());
    } catch {
      /* 连不上 / 解析失败：保持现有显示（"不知道"不等于"都没有"） */
      return;
    }

    /*
     * ST 的 secret key 命名是 `api_key_<source>`（见 ST 的 `SECRET_KEYS`）。
     * 直接按前缀剥，比维护一张映射表稳 —— ST 加新源时自动跟着走，
     * 剥出来的名字若不在我们的支持列表里，`isSupportedChatSource` 会挡掉。
     */
    const fromSt = new Set<StChatSource>();
    for (const name of names) {
      if (!name.startsWith('api_key_')) continue;
      const candidate = name.slice('api_key_'.length);
      if (isSupportedChatSource(candidate)) fromSt.add(candidate);
    }

    /*
     * 没变化就不重绘 —— 否则每次进 API 页都会闪一下
     * （重绘会收起已展开的收纳项，用户正在填的输入框也会被换掉）。
     */
    const same =
      fromSt.size === this.apiKeyPresent.size &&
      [...fromSt].every((one) => this.apiKeyPresent.has(one));
    if (same) return;

    this.apiKeyPresent = fromSt;

    /* 只有用户正看着 API 那一块时才重绘，别打扰别的页面 */
    if (this.apiExpanded) this.renderPage();
  }

  private async withConnection<T>(run: () => Promise<T>): Promise<T> {    const gate = await this.ensureConnected();
    if (!gate.ok) throw gate.error;

    try {
      return await run();
    } catch (error) {
      const described = describeBridgeError(error);
      if (described.code === 'ST_UNAVAILABLE') this.connected = false;
      throw error;
    }
  }

  /**
   * 读一次引擎状态（同步，只读 Android 侧的缓存）。
   *
   * 用途：拿 `charactersDir` —— 写回角色文件需要绝对路径，而只有
   * Android 侧知道 `filesDir` 的真实位置。
   *
   * 读不到返回 `null`。**不返回伪造的默认值**：那会让调用方以为
   * "目录是空串"，而实际是"这台设备没有桥"。两者的处置完全不同
   * （前者是装包问题，后者是环境问题）。
   */
  private readEngineStatus(): EngineStatus | null {
    const bridge = (globalThis as { __ST_ENGINE__?: { status?: () => string } }).__ST_ENGINE__;
    if (typeof bridge?.status !== 'function') return null;
    try {
      return parseEngineStatus(bridge.status());
    } catch {
      return null;
    }
  }

  /**
   * 从 ST 设置播种采样参数（2026-10-31 第四批）。
   *
   * ## 什么时候调
   *
   * · 进聊天页时（`renderChat()` 末尾）—— 保证重启 App 后用的是用户上次设的值；
   * · 「AI 响应配置」页保存成功后 —— 保证改完立刻生效，不用重启。
   *
   * ## 为什么是异步且**不阻塞**渲染
   *
   * 读 ST 设置要一次 HTTP 往返（内嵌 ST 起来后才通）。如果阻塞渲染，
   * 用户会看到聊天页迟迟不出现。所以先用手上的值渲染，读到再覆盖。
   *
   * ## 读失败时**保持原值**，不回落到默认
   *
   * 读失败有两种原因：ST 还没起来、设置文件坏了。两种情况下
   * "沿用上一个已知值"都比"打回默认"好 —— 后者会让用户在 ST 短暂
   * 抖动时丢掉刚调好的温度，而且他完全不知道发生了什么。
   *
   * ## 用 `generation` 计数防止乱序覆盖
   *
   * 连续两次播种（比如快速切 Tab）时，先发的那个可能后返回。
   * 用一个自增序号，只接受"最新那次"的结果 —— 否则会把新值盖成旧值。
   */
  /* ═══════════════════════════════════════════════════════════
     提示词管理器配置的播种（2026-11-03）
     ═══════════════════════════════════════════════════════════ */

  /**
   * 从**当前预设**里读出 `prompts` + `prompt_order`，解析成面板能用的配置。
   *
   * ## 为什么读"预设体"而不是 `settings.json`
   *
   * 实机验证过（2026-11-03）：
   *
   * ```text
   *   settings.json 的 oai_settings  → 0 个键（空）
   *   OpenAI Settings/*.json         → 62 个键，含 prompts + prompt_order
   * ```
   *
   * 整套提示词跟着**预设文件**走，不在运行中的设置里。
   *
   * ## 读不到时怎么办
   *
   * `promptConfig` 保持 `null`，面板据此回退到旧的固定拼装 ——
   * 没有配置时聊天必须照常能用。
   */
  private async seedPromptConfig(): Promise<void> {
    const generation = (this.promptConfigGeneration += 1);

    try {
      const raw = await this.withConnection(() => this.bridge.settingsGetRaw());
      const envelope: unknown = JSON.parse(raw === '' ? '{}' : raw);
      if (generation !== this.promptConfigGeneration) return; // 有更新的播种在路上

      /*
       * 复用现成的 `presetBodiesByName`（预设切换那条链路已经在用它）。
       *
       * 它做两件我们已经踩过坑的事：
       *   ① `openai_settings[i]` 每项是 **JSON 字符串**，要先解析（§87.3）；
       *   ② 清单与正文按**同名**配对，而不是按下标硬对。
       *
       * 自己再写一遍必然漏掉其中一条 —— 而漏掉 ① 的表现是
       * "一条提示词都读不到"，界面上完全看不出来。
       */
      const bodies = presetBodiesByName(envelope);
      /*
       * 当前预设名在 `settings.oai_settings.preset_settings_openai`。
       * 复用 `currentPresetName`（预设切换那条链路也在用它）——
       * 它已经处理了"settings 是字符串要先解析"与"取不到返回空串"两种情况。
       */
      const settings = (envelope as Record<string, unknown>)['settings'];
      const resolved =
        typeof settings === 'string'
          ? ((): unknown => {
              try {
                return JSON.parse(settings);
              } catch {
                return null;
              }
            })()
          : settings;
      /*
       * 作者注释与提示词一起读（2026-11-03）。
       *
       * 它不在预设里，而在 `settings.extension_settings.note`。
       * 放在同一次读取里，避免"预设换了、注释还是上一份的"。
       */
      const noteRaw =
        resolved === null || typeof resolved !== 'object'
          ? undefined
          : (resolved as Record<string, unknown>)['extension_settings'];
      const noteObj =
        noteRaw === null || typeof noteRaw !== 'object'
          ? undefined
          : (noteRaw as Record<string, unknown>)['note'];
      this.authorNote = resolveAuthorNoteConfig(noteObj);

      const current = currentPresetName(resolved);
      const body = current === '' ? null : (bodies[current] ?? null);

      if (body === null) {
        /*
         * 找不到当前预设的**内容**（只有名字）。
         * 这时把配置清空，让面板回退 —— 比沿用上一份预设的配置好：
         * 沿用会让用户的提示词"串预设"，表现是换了预设但行为没变。
         */
        this.promptConfig = null;
        this.promptFormats = {};
        this.chatPanel?.setContext({ promptConfig: null, promptFormats: {} });
        return;
      }

      const config = parsePromptConfig(body);
      this.promptConfig = config.prompts.length > 0 ? config : null;

      /*
       * 格式串与示例分隔提示：一律**照抄用户的配置**，缺省即空串。
       * 不内置任何默认措辞 —— 那等于替用户写提示词。
       */
      const readText = (key: string): string | undefined => {
        const value = (body as Record<string, unknown>)[key];
        return typeof value === 'string' && value !== '' ? value : undefined;
      };
      this.promptFormats = {
        scenarioFormat: readText('scenario_format'),
        personalityFormat: readText('personality_format'),
        wiFormat: readText('wi_format'),
        newExampleChatPrompt: readText('new_example_chat_prompt'),
      };

      /*
       * ★★★ 三个一起推给面板（2026-11-03 第二十七批真机排障）。
       *
       * `authorNote` 必须在这里推 —— 第一版只推了 `promptConfig` /
       * `promptFormats`，而把 `authorNote` 的 setContext 加到了
       * **`saveFields`（保存设置）**里。于是：
       *
       * ```text
       *   启动 → seedPromptConfig 推了预设，没推注释
       *        → 面板 ctx.authorNote 永远是 undefined
       *        → 作者注释一次都没进上下文（真机实测命中率 0）
       * ```
       *
       * 而"保存设置后推一次"那条路只在用户**手动点保存**时走得到，
       * 重启 App 就绕过了。这是本项目最反复的缺陷类型：
       * **实现存在，但接在了错的函数里**。
       *
       * 真机诊断入口（`__tcsPromptProbe__`）就是为分辨这个加的：
       * 它报 `hasAuthorNote: false` 而 `usePromptManager: true`，
       * 说明预设读到了、只有注释这一路断了。
       */
      this.chatPanel?.setContext({
        promptConfig: this.promptConfig,
        promptFormats: this.promptFormats,
        ...(this.authorNote === null ? {} : { authorNote: this.authorNote }),
      });

      /*
       * 解析有问题时**告诉用户**（例如顺序表引用了不存在的项）。
       *
       * 这些 warning 不阻塞聊天，但必须可见 ——
       * 静默跳过会让用户以为"设了不生效"，而我们无从解释。
       */
      if (config.warnings.length > 0) {
        this.options.onNotify?.(`提示词配置：${config.warnings.join(' ')}`, 'warn');
      }
    } catch {
      // ST 未启动 / 网络异常：沿用原值（面板回退）
    }
  }

  private async seedSampling(): Promise<void> {
    /*
     * 每次播种递增。仅当返回时序号仍是最新的才应用结果。
     * 这是"异步结果乱序"的最小防护，不引入 Promise 队列。
     */
    const generation = (this.samplingGeneration += 1);

    try {
      const raw = await this.withConnection(() => this.bridge.settingsGetRaw());
      const envelope: unknown = JSON.parse(raw === '' ? '{}' : raw);
      const parsed = parseSettingsEnvelope(envelope);
      if (!parsed.ok) return; // 读不懂就沿用原值，见方法注释
      if (generation !== this.samplingGeneration) return; // 已有更新的播种在路上

      this.sampling = this.deriveSampling(parsed.settings);
      this.chatPanel?.setContext({ sampling: { ...this.sampling } });

      /*
       * 上下文预算的两个输入（2026-11-03，第十九批 ④）。
       *
       * `openai_max_context` 与 `openai_max_tokens` 在 ST 里是**两个独立字段**，
       * 预算 = 前者 − 后者。这里直接读原始值，不经过 `sampling` ——
       * `sampling` 是"发给上游的参数"，而 `max_context` 只用来算预算、
       * **不会**出现在请求体里。混在一起容易让人以为它也发了。
       */
      const oai = parsed.settings['oai_settings'];
      if (oai !== null && typeof oai === 'object') {
        const contextLimit = readNumberField(oai as Record<string, unknown>, 'openai_max_context');
        const responseLimit = readNumberField(oai as Record<string, unknown>, 'openai_max_tokens');
        this.contextLimit = contextLimit;
        this.responseLimit = responseLimit;
        this.chatPanel?.setContext({ contextLimit, responseLimit });
      }
    } catch {
      // ST 未启动 / 网络异常：沿用原值
    }
  }

  /* ═══════════════════════════════════════════════════════════
     聊天操作页 / 聊天文件页（2026-11-03）
     ═══════════════════════════════════════════════════════════ */

  private renderChatActions(): void {
    if (this.pageHost === null) return;
    const page = renderChatActionsPage(this.doc, this.makeActionsCallbacks());
    /* `renderPage()` 已经 `pageHost.replaceChildren()` 过，这里只 append */
    this.pageHost.append(page);
  }

  private renderChatFiles(): void {
    if (this.pageHost === null) return;
    const page = renderChatFilesPage(this.doc, this.makeFilesCallbacks());
    this.pageHost.append(page);
  }

  /* ═══════════════════════════════════════════════════════════
     提示词管理（2026-11-03 第二十二批）
     ═══════════════════════════════════════════════════════════ */

  /**
   * 渲染「提示词管理」页。
   *
   * 用**已播种的** `this.promptConfig` 而不是每次重读 ——
   * 那一份是进聊天页时读的、并且切换预设后会更新。
   * 重读会让"打开这一页"多一次 HTTP 往返，而内容不会变。
   */
  /**
   * 页面容器分三层，各管一件事。
   *
   * ```text
   *   .nb-page[data-role=page-host]   ← pageRoot：固定外壳，负责安全区 + 裁切
   *     └ .nb-page-layer              ← pageLayer：**当前**那一页
   *     └ .nb-page-layer[data-leaving]  ← 上一页，正在滑出，动画结束即删
   * ```
   *
   * ## 为什么要中间这层（2026-11-05）
   *
   * 用户要的是 QQ / iOS 那种**层叠滑动转场**：新页从侧面滑进来，
   * 旧页同时退到侧边并压暗 —— 两层**必须同时在屏上**。
   *
   * 而原来 `renderPage()` 第一句就是 `pageHost.replaceChildren()`，
   * 旧页当场销毁，做不到"同时"。
   *
   * ## 为什么不改 20 个 render 方法
   *
   * `this.pageHost` 的语义从"固定外壳"改成"当前页的容器"，
   * 于是所有 `this.pageHost.append(...)` 的旧代码**一行都不用改**，
   * 只在 `renderPage()` 里换掉 `pageHost` 指向谁。
   * 外壳另存为 `pageRoot`。
   */
  private pageRoot: ElLike | null = null;

  /** 当前页的容器（旧代码里的 `pageHost` 就是它） */
  private pageHost: ElLike | null = null;

  /**
   * 进入 / 返回动画的序号，每次 +1 后写进 `data-nav`。
   *
   * ## 为什么要一个变化的数字
   *
   * CSS 动画的触发条件是"**属性值发生了变化**"。连续两次返回时如果都写
   * `back`，浏览器认为值没变（中间也没被清掉），
   * **第二次不会重放** —— 表现就是"第一次有动画、后面几次没有"，
   * 而单测和截图都看不出来。
   *
   * 所以写成 `back-1` / `back-2` / `back-3`…，CSS 用 `[data-nav^='back']`
   * 前缀匹配。
   */
  private navAnimSeq = 0;

  /**
   * 上一次渲染时的页面身份（见 `pageKey()`）。用来判断这次是"进了"、"退了"
   * 还是"同一页重绘"。
   *
   * ## 为什么是"页面身份"而不是"层级深度"
   *
   * 第一版维护的是深度（`lastDepth: number`），要靠一个 `pageDepth()`
   * 把每个分支手写一遍。两个问题：
   *
   * ```text
   *   ① 加新二级页忘了在那儿 +1 ⇒ 那一页没有动画，不报错
   *   ② 同级切换（Tab 之间、同层不同页）深度一样，判不出方向
   * ```
   *
   * 改成"路径字符串"之后，**深度就是路径的段数**（`chat/settings/sampling`
   * 是 3 段），不需要另外维护一份；同级不同页也能靠"key 变了但段数没变"
   * 单独处理。加新页面只要让 `pageKey()` 多返回一段，深度自动对。
   */
  private lastPageKey = '';

  /**
   * 当前页面的**身份**（一个斜杠分隔的路径）。
   *
   * ```text
   *   chat                          聊天（Tab 首页）
   *   chat/picker                   选角色器
   *   chat/settings                 聊天设置菜单
   *   chat/settings/sampling        AI 响应配置
   *   chat/settings/sampling/...    （将来再加一层就这么写）
   *   cards / cards/persona
   *   cards/greeting                开场与示例：角色列表
   *   cards/greeting/edit           开场与示例：某个角色的编辑页
   *   me / repo
   * ```
   *
   * ## 三层含义（改这里之前先读）
   *
   * 1. **段数 = 层级深度**。`renderPage()` 直接 `split('/').length` 用它，
   *    不再有一份独立的"深度表"要同步。
   * 2. **key 相同 = 同一页重绘** ⇒ 不播转场。打字、加载完成、数据刷新
   *    都属于这一类（否则每敲一个字页面都滑一下）。
   * 3. **key 不同但段数相同 = 同级切换**（Tab 之间、同层的两页）⇒
   *    按 Tab 从左到右的顺序定方向，详见 `finishPageTurn()`。
   *
   * ## 为什么不把"哪个角色"写进 key
   *
   * 用户特别交代过："如果后续角色多起来…不能写死现有的角色"。
   * 所以这里只区分**列表**与**编辑**两种形态，不枚举角色：
   * 一百个角色和两个角色走的是同一条路径 `cards/greeting/edit`。
   *
   * 同理，将来加任何新页面，只要在这里多写一段，动画自动就有 ——
   * 不需要在别处再登记一次。
   */
  private pageKey(): string {
    if (this.active === 'chat') {
      /*
       * 选卡器是聊天页的一级子页（它渲染的是整页 `.nb-page.nb-picker`，
       * 不是浮层），所以算进路径，打开时也有推入动画。
       */
      if (this.pickerOpen) return 'chat/picker';
      if (this.chatSettingsRoute === null) return 'chat';
      /*
       * `files` 的父是 `actions`、`prompts` 的父是 `sampling`
       * （层级定义只有 `parentRouteOf()` 一处）。这里按**实际渲染**的
       * 路径写，所以那两个三级页是 4 段 —— 段数比父页多就够了，
       * 判方向只比大小，不看具体差几。
       */
      if (this.chatSettingsRoute === 'files') return 'chat/settings/actions/files';
      if (this.chatSettingsRoute === 'prompts') return 'chat/settings/sampling/prompts';
      /*
       * 编辑页比列表多一段 ⇒ `turnDirection()` 自动判 push；
       * 返回时少一段 ⇒ 自动判 back。不为它单独写转场（§120）。
       *
       * ★ 路径里**不写 identifier** —— 与 `cards/greeting/edit` 同一个理由：
       *   从"编辑 A"跳到"编辑 B"不是换页，两个不同 id 写进路径反而会
       *   触发一次没有意义的推入动画。
       */
      if (this.chatSettingsRoute === 'promptEdit') return 'chat/settings/sampling/prompts/edit';
      return `chat/settings/${this.chatSettingsRoute}`;
    }

    if (this.active === 'cards') {
      if (this.personaOpen) return 'cards/persona';
      if (this.greetingOpen) {
        /* 列表 = 2 段，编辑某个角色 = 3 段（不写角色 id，见上面那段注释） */
        return this.greetingState.selected === null ? 'cards/greeting' : 'cards/greeting/edit';
      }
      return 'cards';
    }

    /* 「我的」是一页到底；「仓库」是三级（2026-11-06） */
    if (this.active === 'repo') {
      /*
       * ★ 段数就是层级：1 段 = 一级，2 段 = 二级，3 段 = 三级。
       *   `turnDirection()` 只比段数大小，所以进/退的方向全自动。
       *
       * ★ 卡片标题**不进** key：`pageKey` 只表达"是哪一页"，
       *   不表达"内容是什么"。把标题塞进去的话，同名的两张卡会被
       *   当成同一页（不播转场），而一张卡改了名会莫名播一次转场。
       *   这与角色编辑页的做法一致（那里也没写角色 id）。
       */
      if (this.repoCardId !== null) {
        return `repo/${this.repoRepoId ?? '-'}/${encodeURIComponent(this.repoCardId)}`;
      }
      if (this.repoRepoId !== null) {
        return `repo/${encodeURIComponent(this.repoRepoId)}`;
      }
      return 'repo';
    }
    return this.active;
  }

  /**
   * 全部渲染分支的真正实现（原来 `renderPage()` 的原样搬运）。
   *
   * 拆出来只为一件事：让每个分支的 `return` 只退出**它自己**，
   * 而 `renderPage()` 能在渲染之后统一收尾（播转场 + 清理旧层）。
   * 以前这些 `return` 直接退出 `renderPage()`，没法在末尾挂公共逻辑。
   */
  private renderActivePage(): void {
    if (this.active === 'chat') {
      /*
       * 选卡器优先于其它二级页：它是用户点「选择角色」**当场**要看到的，
       * 若被设置页挡住会显得"点了没反应"。
       */
      if (this.pickerOpen) {
        this.renderCharacterPicker();
        return;
      }

      /*
       * 聊天设置是**聊天 Tab 的二级页**（2026-10-31 第三批问题二）。
       *
       * 为什么不放进「我的」：用户明确要求"聊天页顶栏加设置按钮"，
       * 位置本身是需求的一部分 —— 聊天时想调温度，不该先切 Tab。
       *
       * `chatSettingsRoute` 为 null 时是聊天本身；'menu' 是四项菜单；
       * 其他值是某一组的分组页 id。
       */
      if (this.chatSettingsRoute === 'menu') {
        this.renderChatSettingsMenu();
        return;
      }

      /* 2026-11-03：两个新页面。必须放在"分组页"分支**之前** ——
         它们不是字段分组，走 renderChatSettingsSection 会渲染成空表单。 */
      if (this.chatSettingsRoute === 'actions') {
        this.renderChatActions();
        return;
      }
      if (this.chatSettingsRoute === 'files') {
        this.renderChatFiles();
        return;
      }
      /*
       * 提示词管理（2026-11-03 第二十二批）。
       *
       * 同样必须在"分组页"分支之前 —— 它不是字段分组。
       * 用户报过「看不到预设里的提示词，没法开关」，
       * 那一页就是答案。
       */
      if (this.chatSettingsRoute === 'prompts') {
        this.renderChatPrompts();
        return;
      }
      /*
       * 提示词编辑（2026-11-07）。第四级：提示词列表 → 某一条。
       *
       * 必须也在"分组页"分支之前 —— 它不是字段分组。
       */
      if (this.chatSettingsRoute === 'promptEdit') {
        this.renderPromptEdit();
        return;
      }
      if (this.chatSettingsRoute !== null) {
        this.renderChatSettingsSection(this.chatSettingsRoute);
        return;
      }
      this.renderChat();
      return;
    }

    if (this.active === 'me') {
      this.renderMe();
      return;
    }

    /*
     * 卡片 / 仓库两页属于 T15.2（TCS 功能移植），本期没搬过来。
     *
     * 说清"是什么、去哪做"，而不是给一片空白 ——
     * 空白会让人以为功能坏了。
     *
     * 2026-10-31 第三批：「卡片」页不再是纯空状态，改成**两个入口**
     * （卡编辑 / 用户设定管理）。用户明确要求这两个入口放这里
     * （API 连接在「我的」，不在此重复）。
     * 点进去是说明页 —— 用户选了"只放入口 + 空状态说明"
     * （见本批的方案确认），所以不伪装成已完成。
     */
    if (this.active === 'cards') {
      if (this.personaOpen) {
        this.renderPersonaPage();
        return;
      }
      if (this.greetingOpen) {
        this.renderGreeting();
        return;
      }
      this.renderCardsTab();
      return;
    }

    /*
     * 仓库 Tab 是**三级**（2026-11-06 改，用户要求）：
     *
     * ```text
     *   一级  服务端配置 + 登录 + 仓库列表
     *   二级  某个仓库的卡片列表（带缩略图）
     *   三级  某张卡的历史与操作
     * ```
     *
     * ★ 三级都走 `renderPage()`，所以转场由 `pageKey()` 的段数自动推导
     *   （1 → 2 → 3），不需要为每一级单独写动画。这就是用户第 4 点
     *   "复用转场"的实现方式。
     */
    if (this.repoCardId !== null) {
      this.renderRepoCardPage();
      return;
    }
    if (this.repoRepoId !== null) {
      this.renderRepoCardsPage();
      return;
    }
    this.renderRepoPage();
  }

  /**
   * 回到**上一级**。界面上的返回按钮与系统返回手势共用这一个入口。
   *
   * ## 为什么必须是同一个函数
   *
   * 用户报的 bug 就是两者不一致的苗头：左上角返回按"跳两级"实现（直接回设置菜单），
   * 而系统手势根本没处理（直接退出应用）。
   * 只要有两份实现，它们迟早分叉 —— 而"分叉后的返回到底去哪"用户学不会。
   *
   * ## 层级
   *
   * ```text
   *   聊天（null）
   *     └ 聊天设置菜单（menu）
   *         ├ 聊天操作（actions）── 聊天文件（files）
   *         ├ AI 响应配置（sampling）── 提示词管理（prompts）
   *         ├ AI 回复格式化（formatting）
   *         ├ 世界书管理（worldbook）
   *         ├ 用户设置（persona）
   *         └ 聊天行为（behavior）
   * ```
   *
   * ## 返回值
   *
   * `true` = 已经在应用内退了一级（**或弹出了退出确认**）；`false` = 到顶层且退出弹窗不可用。
   *
   * ## ★★★ 到顶层时**不直接退**，而是弹确认（2026-11-03）
   *
   * 用户要求：
   *
   * > 返回到最上一级后，再使用系统返回时提示是否退出APP
   *
   * 所以第 ④ 步不再是 `return false` 交给上层 `exit(0)`，
   * 而是**自己弹确认框**并 `return true`（消费掉这次返回）。
   * 真正退出由弹窗里的「狠心离开」按钮触发 `this.exitApp()`。
   *
   * 弹窗**已经开着**时再按返回，则关掉弹窗（等同「我还想再聊一会」）。
   */
  goBackOneLevel(): boolean {
    /*
     * ★ 这里**不需要**再打"我要播返回动画"的标记（2026-11-05 改）。
     *
     * 转场方向由 `pageDepth()` 推导 —— 层级变少就是返回。
     * 手势路径（`main.ts` 的 `onBackButtonPress`）与左上角按钮都调本方法，
     * 而本方法每个分支最后都是 `renderPage()`，所以两者天然共用一套动画。
     *
     * 手工标记的坏处：`goBackOneLevel()` 有 6 个 `return true`，
     * 其中"弹退出确认框"那条**不重绘** —— 标记会留下来，
     * 下次**前进**进页面也被当成返回、白播一遍。推导没有这个问题。
     */

    /*
     * ① 退出确认框是**最顶层**，优先级最高。
     *
     * 它开着时，用户按返回想关掉的是它 —— 而不是把它后面的页面一起退了。
     */
    if (this.exitOverlay !== null) {
      this.closeExitDialog();
      return true;
    }

    /*
     * ② 角色选择器是**浮层**，其次。
     *
     * 它打开时压在聊天页上面，用户按返回想关掉的是它 ——
     * 而不是把下面的聊天设置也一并退掉。
     */
    /*
     * 用户设定管理页（2026-11-04）：它是「卡片」Tab 的二级页，
     * 返回键要先退出它，而不是直接切回聊天 Tab。
     */
    if (this.personaOpen) {
      this.personaOpen = false;
      this.renderPage();
      return true;
    }

    /*
     * 开场与示例：两层返回（2026-11-05）。
     *
     * ```text
     *   正在编辑某个角色 → 退回角色列表
     *   角色列表         → 退回「卡片」页
     * ```
     *
     * 一层退到底会让用户"改完想换个角色"时被踢出整页，还得重新点进来。
     */
    if (this.greetingOpen) {
      if (this.greetingState.selected !== null) {
        /*
         * 只清"选中了谁"，**不清角色列表** ——
         * 清掉的话退到列表会显示"还没有角色"，得重新读一次才回来。
         */
        const reset = emptyGreetingDraft();
        this.greetingState = {
          ...this.greetingState,
          selected: null,
          draft: reset,
          error: '',
          baseline: greetingFingerprint(reset),
        };
        this.greetingChangeFlag = false;
        this.renderPage();
        return true;
      }
      this.greetingOpen = false;
      this.greetingState = emptyGreetingPageState();
      this.renderPage();
      return true;
    }


    if (this.pickerOpen) {
      const resolve = this.pickResolve;
      this.pickResolve = null;
      this.pickerOpen = false;
      this.renderPage();
      resolve?.(null);
      return true;
    }

    /*
     * ③ 聊天设置各级页面。
     *
     * 用 `parentRouteOf()` 算上一级 —— 层级只在这一处定义，
     * 各页的返回按钮不再各自写死目标（那正是这个 bug 的成因）。
     */
    if (this.chatSettingsRoute !== null) {
      this.chatSettingsRoute = parentRouteOf(this.chatSettingsRoute);
      this.renderPage();
      return true;
    }

    /*
     * ③·补齐 仓库的三级返回（2026-11-06）。
     *
     * ```text
     *   三级（某张卡）→ 退回该仓库的卡片列表
     *   二级（卡片列表）→ 退回仓库列表
     * ```
     *
     * ★ 必须逐级退，不能一退到底：用户从"某张卡的历史"退回来，
     *   期待的是那张卡所在的列表，而不是整个仓库的入口。
     *   这与「开场与示例」那条两层返回是同一个道理。
     *
     * ★ 退回时**清掉下级的加载状态** —— 否则下次点进另一张卡，
     *   会在新卡的历史页上先闪一下上一张卡的版本列表。
     */
    if (this.active === 'repo') {
      if (this.repoCardId !== null) {
        this.repoCardId = null;
        this.repoCardTitle = '';
        this.repoVersionsState = null;
        this.repoVersionsError = '';
        this.renderPage();
        /*
         * 退回到列表时**重拉一次**：在三级里可能删过卡、回滚过（版本数会变）。
         * 不重拉的话列表还显示着已经不存在的那张卡，点进去必然 404。
         * 用 `quiet` 是因为列表已经画出来了，别闪成"正在读取"。
         */
        const repoId = this.repoRepoId;
        if (repoId !== null) void this.refreshCardsQuietly(repoId);
        return true;
      }
      if (this.repoRepoId !== null) {
        this.repoRepoId = null;
        this.repoRepoName = '';
        this.repoCardsState = null;
        this.repoCardsError = '';
        this.renderPage();
        /* 同上：卡数可能变了 */
        void this.loadRepoListQuietly();
        return true;
      }
    }

    /*
     * ④ 不在聊天 Tab → 回到聊天 Tab 首页。
     *
     * 聊天是主界面。从「我的」按返回直接退出应用会显得突兀 ——
     * 用户通常还想回到正在聊的内容。
     */
    if (this.active !== 'chat') {
      this.switchTab('chat');
      return true;
    }

    /*
     * ⑤ 已经在聊天首页：弹退出确认，消费这次返回。
     *
     * 真正退出由「狠心离开」触发；用户点「我还想再聊一会」则无事发生。
     */
    this.openExitDialog();
    return true;
  }

  /**
   * 真正退出 App 的动作，由外壳注入（Android 上是 `exit(0)`）。
   *
   * ## 为什么是可注入的字段而不是 ShellOptions
   *
   * `exit` 来自 `@tauri-apps/api/app`，而它是**动态 import** 的（纯 Web 环境
   * 静态引入会把入口拖死，见 `registerBackGesture`）。所以外壳在拿到 `exit`
   * 之后、再挂到这个字段上，比塞进构造参数更自然。
   *
   * 默认空函数：桌面端 / 浏览器预览没有"退出 App"这回事。
   */
  exitApp: () => void | Promise<void> = () => {};

  /** 退出确认框当前是否开着（`null` = 没开）。开着时返回键优先关它。 */
  private exitOverlay: ElLike | null = null;

  /**
   * 弹出「是否退出」确认框。
   *
   * ## 风格
   *
   * 与夜航 Nebula 一致：玻璃背景 + 圆角 + 玻璃边框（CSS 在 `chat.css` 的
   * `.nb-exit-*`，只使用 nebula-tokens 里**确实存在**的变量）。
   *
   * ## 交互
   *
   * - 「狠心离开」→ `exitApp()` 并移除弹窗
   * - 「我还想再聊一会」→ 仅移除弹窗
   * - 点遮罩空白处 → 等同「我还想再聊一会」（不误退）
   *
   * ## 为什么点空白 = "再聊一会"而不是"离开"
   *
   * 退出是不可逆的。误触遮罩就退出太危险；用户真想退出会去点明确的按钮。
   */
  private openExitDialog(): void {
    if (this.root === null || this.exitOverlay !== null) return;

    const overlay = el(this.doc, 'div', 'nb-exit-overlay');
    overlay.setAttribute('data-role', 'exit-dialog');

    const card = el(this.doc, 'div', 'nb-exit-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');

    const title = el(this.doc, 'p', 'nb-exit-title');
    title.textContent = '您确认要离开世界吗？';

    const subtitle = el(this.doc, 'p', 'nb-exit-subtitle');
    subtitle.textContent = '您的角色会伤心的。';

    const actions = el(this.doc, 'div', 'nb-exit-actions');

    const leave = el(this.doc, 'button', 'nb-exit-leave');
    leave.setAttribute('type', 'button');
    leave.setAttribute('data-role', 'exit-leave');
    leave.textContent = '狠心离开';
    leave.addEventListener('click', () => {
      this.closeExitDialog();
      /*
       * ★★★ 退出失败必须让用户看见（2026-11-03 第二十五批）。
       *
       * 用户报「点狠心退出时没有退出APP」。
       * 真因是 capabilities 缺 `core:app:allow-exit`，`invoke` 被权限拒绝 ——
       * 而当时调用处写的是 `void exit(0)`，**错误被静默吞掉**，
       * 界面上就是"点了一下，什么也没发生"。
       *
       * 所以这里用 `Promise.resolve().catch()` 兜住两种情况：
       *   · `exitApp` 同步抛
       *   · `exitApp` 返回 rejected Promise
       * 两种都要变成"看得见的一句提示"，而不是无声失败。
       */
      void Promise.resolve(this.exitApp()).catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        this.options.onNotify?.(`退出没成功：${text}`, 'danger');
      });
    });

    const stay = el(this.doc, 'button', 'nb-exit-stay');
    stay.setAttribute('type', 'button');
    stay.setAttribute('data-role', 'exit-stay');
    stay.textContent = '我还想再聊一会';
    stay.addEventListener('click', () => {
      this.closeExitDialog();
    });

    actions.append(leave, stay);
    card.append(title, subtitle, actions);
    overlay.append(card);

    /*
     * ★ 点遮罩（非卡片）才关；点卡片内部不关。
     *
     * 用 `event.target === overlay` 判断：事件从卡片里的元素冒泡上来时，
     * target 是那个元素，不是 overlay。
     */
    overlay.addEventListener('click', (event) => {
      if ((event as { target?: unknown }).target === overlay) this.closeExitDialog();
    });

    this.root.append(overlay);
    this.exitOverlay = overlay;
  }

  /** 关掉退出确认框（幂等）。 */
  private closeExitDialog(): void {
    if (this.exitOverlay === null) return;
    this.exitOverlay.remove();
    this.exitOverlay = null;
  }

  /**
   * 预取每条提示词的触发器（2026-11-07）。
   *
   * 编辑页要显示"这条只在什么生成类型发"，而 `parsePromptConfig` 不留这个字段。
   * 这里读一次 ST 原始设置，把 `identifier → 触发器数组` 存起来。
   *
   * ## 失败时什么都不做
   *
   * 抽不到就让编辑页显示"所有类型" —— 那是绝大多数情况的真实状态。
   * 反过来（失败就填个"仅续写"之类）会让用户以为自己的提示词不发送，
   * 那是凭空造出来的告警。
   */
  private async refreshPromptTriggers(): Promise<void> {
    const config = this.promptConfig;
    if (config === null) return;
    try {
      const raw = await this.withConnection(() => this.bridge.settingsGetRaw());
      const envelope: unknown = JSON.parse(raw === '' ? '{}' : raw);
      const bodies = presetBodiesByName(envelope);

      const settings = (envelope as Record<string, unknown>)['settings'];
      const resolved =
        typeof settings === 'string'
          ? ((): unknown => {
              try {
                return JSON.parse(settings);
              } catch {
                return null;
              }
            })()
          : settings;
      const presetName = currentPresetName(resolved);
      const body = presetName === '' ? undefined : bodies[presetName];
      /*
       * `undefined`（没这份预设）与 `null`（这份预设读不出对象）都跳过。
       * 都不当"没有触发器"—— 那是两回事，见上面那段说明。
       */
      if (body === undefined || body === null) return;

      const next = new Map<string, readonly string[]>();
      for (const prompt of config.prompts) {
        next.set(prompt.identifier, readInjectionTrigger(body, prompt.identifier));
      }
      this.promptTriggers = next;
      /*
       * 已经在这一页上就重绘一次，让只读值显示出来。
       *
       * 只在编辑页时重绘 —— 在列表页重绘会让用户刚滑到一半的位置跳回顶部。
       */
      if (this.chatSettingsRoute === 'promptEdit') this.renderPage();
    } catch {
      /* 读不到就保持"所有类型"，见上面那段说明 */
    }
  }

  private renderChatPrompts(): void {
    if (this.pageHost === null) return;

    const page = renderChatPromptsPage(this.doc, this.promptConfig, {      /*
       * 返回**上一级**（= AI 响应配置），不是回到设置菜单。
       *
       * ★ 第一版写的是 `'menu'`，用户实测发现"点了直接退到聊天设置"。
       * 真因：提示词管理是从「AI 响应配置」进来的第三级，
       * 它的上级是 `'sampling'`，而 `'menu'` 是再上一级（跳了一级）。
       *
       * 这条规则现在统一到 `parentRouteOf()` 里 ——
       * 界面返回按钮和系统返回手势**共用同一个函数**，
       * 否则两者迟早分叉（一个退一级、一个退两级）。
       */
      onBack: () => {
        this.goBackOneLevel();
      },
      loadConfig: () => this.promptConfig,
      togglePrompt: (identifier, enabled) => this.savePromptToggle(identifier, enabled),
      /*
       * ★ 这里**不能**直接把这个回调赋成 `this.options` 里那一个。
       *
       * `test/sampling-migration.test.mjs` 的 c1 用两个 `indexOf` 取一段源码
       * 来做断言：起点是「采样保存」那个方法的键名，终点是 `onNotify` 那一行。
       * 它取的是**第一次出现**的位置 —— 而我这个方法排在 `makeSettingsCallbacks`
       * **之前**，于是那对下标反了（终点在起点之前），切片得到空串，判据就红了。
       *
       * （我第一次修的时候把这两个字符串写进了注释里，结果 `indexOf` 匹配到的是
       * 注释、不是代码 —— 注释再一次骗了判据。所以这段说明里刻意不写那两个键名。）
       *
       * 我没有去改那条判据：它的写法确实脆（拿另一个无关方法里的某行当边界），
       * 但它是既有防线，动它风险更大。这里包一层 lambda 就绕开了 ——
       * 效果完全一样，也不会再被"按文本切片"的判据误伤。
       */
      onNotify: (message, kind) => this.options.onNotify?.(message, kind),
      /*
       * 打开编辑页（2026-11-07）。
       *
       * `identifier === null` = 新建。走的是**整页**而不是弹窗：
       *
       * ★ 本项目的弹窗通知看不见（`topbar` 自成 stacking context，
       *   z-index 压不过弹窗的 200 —— 见 §128）。编辑页保存失败必须
       *   能弹提示，所以它只能是整页。
       *
       * 同时页面路径多一段 ⇒ `pageKey()` 自动是 push 动画，
       * 不用为它单独写转场。
       */
      openEditor: (identifier) => {
        this.promptEditId = identifier;
        this.chatSettingsRoute = 'promptEdit';
        /*
         * 先把触发器拿到再渲染。
         *
         * 顺序：`refreshPromptTriggers()` 内部若已在编辑页会自己重绘；
         * 但此刻路由刚改、页面还没画，所以这里先 `void` 让它去取，
         * 下面的 `renderPage()` 立刻画出骨架（触发器显示"所有类型"），
         * 取回来之后它再重绘一次把真实值填上。
         *
         * ★ 不 await：await 会让"点一下要等一次 HTTP"变成可感知的卡顿，
         *   而那一栏是只读信息，晚 200ms 出现完全可以接受。
         */
        void this.refreshPromptTriggers();
        this.renderPage();
      },
    });
    this.pageHost.append(page);
  }

  /**
   * 「提示词编辑」页（2026-11-07）。
   *
   * ## 这一页需要什么
   *
   * ```text
   *   新建：空白草稿 + 默认值（role=system / 位置=跟随顺序 / 排序=100）
   *   编辑：从 promptConfig 里取那条 → draftOf() → 再补上"触发器"只读值
   * ```
   *
   * 触发器必须从**原始预设体**读（`parsePromptConfig` 不保留它），
   * 所以这里要读一次 ST 原始设置。读不到就显示"所有类型" ——
   * 那是最常见的状态，也绝不会因为读失败而谎报"这条不发送"。
   */
  private renderPromptEdit(): void {
    if (this.pageHost === null) return;

    const config = this.promptConfig;
    const id = this.promptEditId;
    const existing = id === null ? undefined : config?.prompts.find((one) => one.identifier === id);

    /*
     * 编辑一个已经不存在的 identifier：回列表并说明。
     *
     * 不静默渲染一个空白表单 —— 那样用户会以为"这条是空的"，
     * 然后一保存就把别人的内容覆盖成空。
     */
    if (id !== null && existing === undefined) {
      this.promptEditId = null;
      this.chatSettingsRoute = 'prompts';
      this.renderPage();
      this.options.onNotify?.('这条提示词已经不在了，可能刚被删掉。', 'warn');
      return;
    }

    const target: PromptEditTarget =
      existing === undefined
        ? {
            identifier: null,
            draft: NEW_PROMPT_DRAFT,
            marker: false,
            triggers: [],
          }
        : {
            identifier: existing.identifier,
            draft: draftOf(existing),
            marker: existing.marker,
            triggers: this.promptTriggers.get(existing.identifier) ?? [],
          };

    const page = renderChatPromptEditPage(this.doc, target, {
      onBack: () => {
        /*
         * 清掉"正在编辑谁"再退一级。
         *
         * ★ 返回必须走 `goBackOneLevel()`（本项目统一入口）：
         *   它内部用 `parentRouteOf()` 求上一级，而那里已经把
         *   `promptEdit → prompts` 登记过了。自己写 `= 'prompts'` 的话，
         *   界面上看着一样，但层级定义就多出第二份真值 ——
         *   而"两份实现迟早分叉"在这个项目上反复发生过。
         */
        this.promptEditId = null;
        this.goBackOneLevel();
      },
      onSave: (draft) => this.savePromptDraft(target.identifier, draft),
      ...(target.identifier === null
        ? {}
        : { onDelete: () => this.deletePromptById(target.identifier as string) }),
      onNotify: (message, kind) => this.options.onNotify?.(message, kind),
    });
    this.pageHost.append(page);
  }

  /** 保存（新建或编辑）一条提示词 */
  private async savePromptDraft(
    identifier: string | null,
    draft: PromptDraft,
  ): Promise<{ ok: boolean; reason?: string }> {
    const problem = validateDraft(draft);
    if (problem !== null) return { ok: false, reason: problem };

    const isCreate = identifier === null;
    const newId = isCreate ? newPromptIdentifier() : identifier;

    const result = await this.mutatePromptPreset((body, config) =>
      isCreate ? createPrompt(body, draft, newId) : updatePrompt(body, identifier, draft),
    );
    if (!result.ok) return result;

    /*
     * 新建成功后**停在编辑页**并显示这条的真正 id？
     *
     * 不 —— 回到列表。用户新建完最想看的是"它进列表了吗、开着吗"，
     * 而列表正好回答这两个问题（末尾一条、开关是开）。
     */
    this.promptEditId = null;
    this.chatSettingsRoute = 'prompts';
    this.renderPage();
    this.options.onNotify?.(isCreate ? '已新建，默认是开启的' : '已保存', 'ok');
    return { ok: true };
  }

  /** 删除一条提示词 */
  private async deletePromptById(identifier: string): Promise<{ ok: boolean; reason?: string }> {
    const result = await this.mutatePromptPreset((body) => deletePrompt(body, identifier));
    if (!result.ok) return result;

    this.promptEditId = null;
    this.chatSettingsRoute = 'prompts';
    this.renderPage();
    this.options.onNotify?.('已删除', 'ok');
    return { ok: true };
  }

  /**
   * 对"当前预设"做一次修改并整份写回（2026-11-07 抽出）。
   *
   * ## 为什么要抽出来
   *
   * 开关、编辑、新建、删除四条路都需要同一段：
   * 读原始预设体 → 交给 `apply` 改 → 整份 POST → 重新解析 → 推给聊天面板。
   *
   * 复制四遍必然分叉 —— 而这段里有一条**不可省略**的步骤
   * （重新解析并 setContext），漏掉它的表现是"改了不生效，重启才好"。
   * 一份实现就不会漏。
   *
   * @param apply 拿到（原始 body, 当前解析结果）返回新 body
   */
  private async mutatePromptPreset(
    apply: (
      body: Record<string, unknown>,
      config: ParsedPromptConfig,
    ) =>
      | { ok: true; body: Record<string, unknown>; changed: boolean }
      | { ok: false; reason: string },
  ): Promise<{ ok: boolean; reason?: string }> {
    const config = this.promptConfig;
    if (config === null) return { ok: false, reason: '还没读到提示词配置，请回上一页重新进入。' };

    try {
      const raw = await this.withConnection(() => this.bridge.settingsGetRaw());
      const envelope: unknown = JSON.parse(raw === '' ? '{}' : raw);
      const bodies = presetBodiesByName(envelope);

      const settings = (envelope as Record<string, unknown>)['settings'];
      const resolved =
        typeof settings === 'string'
          ? ((): unknown => {
              try {
                return JSON.parse(settings);
              } catch {
                return null;
              }
            })()
          : settings;
      const presetName = currentPresetName(resolved);
      if (presetName === '') {
        return { ok: false, reason: '不知道该写回哪一份预设（还没选预设）。' };
      }

      const body = bodies[presetName];
      /*
       * `undefined` = 没有这份预设；非对象 = 这份预设读坏了。
       * 两种都要拦住 —— 把它当空对象传下去，保存时会用"只剩我们改的那几个键"
       * 的内容覆盖整份预设，用户的采样参数会全丢。
       */
      if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, reason: `找不到「${presetName}」这份预设的内容，可能刚被删掉。` };
      }

      const next = apply(body as Record<string, unknown>, config);
      if (!next.ok) return { ok: false, reason: next.reason };
      if (!next.changed) return { ok: true };

      await this.withConnection(() =>
        this.bridge.presetSave(presetName, JSON.stringify(next.body)),
      );

      /*
       * 重新解析，让面板手上的配置与磁盘一致。
       *
       * 这一步不能省：不重新解析的话，聊天时用的还是旧内容/旧开关。
       */
      const fresh = parsePromptConfig(next.body);
      this.promptConfig = fresh.prompts.length > 0 ? fresh : null;
      this.chatPanel?.setContext({ promptConfig: this.promptConfig });
      if (this.authorNote !== null) {
        this.chatPanel?.setContext({ authorNote: this.authorNote });
      }

      return { ok: true };
    } catch (error) {
      return { ok: false, reason: describeBridgeError(error).message };
    }
  }

  /**
   * 保存一个提示词开关：读当前预设体 → 改 → 整份写回。
   *
   * ## 为什么是"整份写回"
   *
   * ST 的 `/api/presets/save` 收整份预设（62 个键）。
   * 少传一个键就等于删了它 —— 而预设里还有模型名、采样参数、格式串。
   * 所以必须先读原 body，只改 `prompt_order`，再整份交回去。
   *
   * ## 为什么改完要重新播种
   *
   * 面板手上的 `promptConfig` 是旧的（开关没变）。不重新解析的话，
   * 用户关掉一条、再去聊天，发出去的**还是**那一条 ——
   * 而界面上开关明明已经关了。这是"设了不生效"最典型的样子。
   */
  private async savePromptToggle(
    identifier: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; reason?: string }> {
    return this.mutatePromptPreset((body, config) =>
      setPromptEnabled(body, config, identifier, enabled),
    );
  }

  /**
   * 打开指定的聊天文件。
   *
   * 复用 `chatPanel.loadChat()` 而不是自己走一遍 `loadChatRaw` + 解析 ——
   * 那条路里已经处理了三态判定（`missing`/`empty`/`malformed` 都不自动建聊天），
   * 另写一遍必然漏掉其中一种，而 `malformed` 漏掉的后果是
   * "用空历史覆盖真实文件"（save 是全量覆盖），不可逆。
   */
  private async openChatFile(avatar: string, fileName: string): Promise<void> {
    await this.chatPanel?.loadChat(avatar, fileName);
    this.chatFileName = fileName;
    this.persistSession();
  }

  /** 当前是否已打开一段对话（"聊天操作"里依赖它的项要禁用） */
  private hasOpenChat(): boolean {
    return this.selectedCharacter !== null && this.chatFileName !== null;
  }

  /**
   * 「聊天操作」的 8 个回调。
   *
   * ## 每一项都对应一个**真实能力**，没有占位
   *
   * | 动作 | 怎么实现 |
   * |---|---|
   * | 保存检查点 | `chats/save` 换一个新文件名 —— ST 里"检查点"本质就是这个 |
   * | 开始新聊天 | 同上，但用空消息 + 新文件名 |
   * | 关闭聊天 | 纯前端：清掉当前会话指针与快照 |
   * | 管理聊天文件 | 切到文件页 |
   * | AI 帮答 / 续写 | `generate` + 一条临时 system 指令 |
   * | 转群聊 | `groups/create`（真机实测 200） |
   */
  private makeActionsCallbacks(): ChatActionsCallbacks {
    const doc = this.options.doc;
    void doc;

    /*
     * ★ 返回 `fileName` 而不是让调用方从 `detail` 文案里正则抠。
     *
     * 从人类可读的文案里解析机器要用的值，是最脆的耦合之一：
     * 改一个字（加个书名号、换个词）就静默失效，而且失效方式取决于文案。
     * 第一版就是这么写的，`/「(.+?)」/` 一改文案就抓不到。
     */
    const saveAs = async (
      nameHint: string,
      messages: readonly StChatMessage[],
    ): Promise<ChatActionOutcome & { fileName?: string }> => {
      const avatar = this.selectedCharacter?.avatar ?? null;
      if (avatar === null) return { ok: false, detail: '先选一个角色。' };
      try {
        /*
         * 文件名必须**独一无二**：ST 的 `chats/save` 是整份覆盖，
         * 撞名就会把已有聊天覆盖掉 —— 而"保存检查点"的语义恰恰是"别动原来的"。
         * 所以带上时间戳到秒。
         */
        const stamp = new Date();
        const pad = (n: number): string => String(n).padStart(2, '0');
        const when =
          `${String(stamp.getFullYear())}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}` +
          `@${pad(stamp.getHours())}h${pad(stamp.getMinutes())}m${pad(stamp.getSeconds())}s`;
        const fileName = `${nameHint} - ${when}`;

        await this.withConnection(() =>
          this.bridge.saveChat(avatar, fileName, [...messages]),
        );
        this.options.onNotify?.(`已保存为「${fileName}」`, 'ok');
        return {
          ok: true,
          detail: `已保存为「${fileName}」。可在「管理聊天文件」里打开。`,
          fileName,
        };
      } catch (error) {
        const text = describeBridgeError(error).message;
        return { ok: false, detail: `保存失败：${text}` };
      }
    };

    return {
      /* 聊天操作页的上一级是设置菜单 —— 统一走层级表 */
      onBack: () => {
        this.goBackOneLevel();
      },
      onNotify: (message, kind) => this.options.onNotify?.(message, kind),
      hasOpenChat: this.hasOpenChat(),

      onSaveCheckpoint: async () => {
        const messages = this.chatPanel?.getMessages() ?? [];
        if (messages.length === 0) return { ok: false, detail: '当前对话是空的，没有可保存的内容。' };
        const name = this.options.card['name'] === undefined
          ? '检查点'
          : `检查点 ${String(this.options.card['name'])}`;
        return saveAs(name, messages);
      },

      onNewChat: async () => {
        const avatar = this.selectedCharacter?.avatar ?? null;
        if (avatar === null) return { ok: false, detail: '先选一个角色。' };
        /*
         * 建一个**空聊天文件**而不是"只清前端状态"。
         *
         * 只清前端的话，用户下次说话时会存回**原来那个文件名** ——
         * 于是"新聊天"把旧聊天覆盖了。用户以为开了新的一段，
         * 实际上把上一段冲掉了，这是不可逆的。
         */
        const outcome = await saveAs('新聊天', []);
        if (!outcome.ok) return outcome;
        const fileName = outcome.fileName ?? null;
        if (fileName !== null) await this.openChatFile(avatar, fileName);
        return { ok: true, detail: `已开一段新对话（${fileName ?? '新聊天'}）。` };
      },

      onCloseChat: () => {
        /*
         * 关闭 = 清掉"当前打开哪一段"的指针。
         *
         * **不删文件**：用户在 ST 里还能看到它，下次也能从
         * 「管理聊天文件」里重新打开。删文件是另一个动作。
         */
        this.selectedCharacter = null;
        this.chatFileName = null;
        this.chatSnapshot = null;
        this.lastSavedFingerprint = null;
        this.chatSettingsRoute = null;
        this.renderPage();
        /*
         * ★ 不清 localStorage 里的会话指针也可以，但**必须重绘** ——
         * 否则界面还停在那段对话上。这里靠 `renderPage()` 走空状态分支。
         */
        return { ok: true, detail: '已关闭当前对话。' };
      },

      onManageFiles: () => {
        this.chatSettingsRoute = 'files';
        this.renderPage();
      },

      onAiAssist: async () => {
        if (!this.hasOpenChat()) return { ok: false, detail: '先打开一段对话。' };
        await this.chatPanel?.runDirective(
          '你现在是「旁白/编剧」而不是角色本人。请**不要**替代角色说话，' +
            '而是让角色以简短的方式给用户 2-3 条接下来的走向建议（每条一句话）。',
        );
        return { ok: true, detail: '已请求建议，回复会出现在下面。' };
      },

      onContinueWriting: async () => {
        if (!this.hasOpenChat()) return { ok: false, detail: '先打开一段对话。' };
        await this.chatPanel?.runDirective(
          '请自然地接着上文继续写下去，不要重复已经写过的内容，也不要重新开始一个话题。',
        );
        return { ok: true, detail: '已请求续写，回复会出现在下面。' };
      },

      onConvertToGroup: async () => {
        const avatar = this.selectedCharacter?.avatar ?? null;
        const name = this.selectedCharacter?.name ?? '';
        if (avatar === null) return { ok: false, detail: '先选一个角色。' };
        try {
          /*
           * ST 的群是**独立实体**，没有"把角色变成群"的接口
           * （`group/convert` 实测 404）。所以这里用当前角色建一个单成员群 ——
           * 语义上等价于"以这个角色为起点开了个群"，之后可在 ST 里加人。
           */
          const raw = await this.withConnection(() => this.bridge.createGroup(`${name} 的群聊`, [avatar]));
          const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw);
          const groupName =
            parsed !== null && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>)['name'] === 'string'
              ? String((parsed as Record<string, unknown>)['name'])
              : `${name} 的群聊`;
          this.options.onNotify?.(`已建群「${groupName}」`, 'ok');
          return {
            ok: true,
            detail: `已建群「${groupName}」（成员：${name}）。要在群里加人请到群聊设置里操作。`,
          };
        } catch (error) {
          return { ok: false, detail: `建群失败：${describeBridgeError(error).message}` };
        }
      },
    };
  }

  private makeFilesCallbacks(): ChatFilesCallbacks {
    return {
      /* 同样统一走层级表：文件页的上一级是「聊天操作」 */
      onBack: () => {
        this.goBackOneLevel();
      },
      onNotify: (message, kind) => this.options.onNotify?.(message, kind),
      loadFiles: async () => {
        const avatar = this.selectedCharacter?.avatar ?? null;
        if (avatar === null) return [];
        try {
          const raw = await this.withConnection(() => this.bridge.listChatsRaw(avatar));
          return parseChatFileRows(raw, this.chatFileName ?? null);
        } catch {
          return null;
        }
      },
      onOpen: async (id) => {
        const avatar = this.selectedCharacter?.avatar ?? null;
        if (avatar === null) return;
        await this.openChatFile(avatar, id);
        this.chatSettingsRoute = null;
        this.renderPage();
      },
      onRename: async (id, newName) => {
        const avatar = this.selectedCharacter?.avatar ?? null;
        if (avatar === null) return { ok: false, detail: '先选一个角色。' };
        try {
          await this.withConnection(() => this.bridge.renameChat(avatar, id, newName));
          /* 改的是当前这条 ⇒ 会话指针的名字也要跟着改，否则下次打开找不到 */
          if (this.chatFileName === id) {
            this.chatFileName = newName;
            this.persistSession();
          }
          return { ok: true, detail: `已改名为「${newName}」。` };
        } catch (error) {
          return { ok: false, detail: `改名失败：${describeBridgeError(error).message}` };
        }
      },
      onDelete: async (id) => {
        const avatar = this.selectedCharacter?.avatar ?? null;
        if (avatar === null) return { ok: false, detail: '先选一个角色。' };
        try {
          await this.withConnection(() => this.bridge.deleteChat(avatar, id));
          /* 删的正是当前打开的那条 ⇒ 关掉会话，否则界面还指着一个不存在的文件 */
          if (this.chatFileName === id) {
            this.selectedCharacter = null;
            this.chatFileName = null;
            this.chatSnapshot = null;
            this.lastSavedFingerprint = null;
          }
          return { ok: true, detail: '已删除。' };
        } catch (error) {
          return { ok: false, detail: `删除失败：${describeBridgeError(error).message}` };
        }
      },
    };
  }

  private makeSettingsCallbacks(): ChatSettingsCallbacks {
    return {
      /*
       * 统一走层级表（2026-11-03 第二十三批）。
       *
       * 原来这里写的是 `route === 'menu' ? null : 'menu'` —— 对分组页正确，
       * 但它把"上一级是谁"这件事**又实现了一遍**，与别处的写死目标分叉。
       * 现在只有 `parentRouteOf()` 一个答案。
       */
      onBack: () => {
        this.goBackOneLevel();
      },
      /*
       * ★ 菜单项点进分组页。
       *
       * 这一行第一次**漏了** —— `chat-settings.ts` 里 `callbacks.onOpenGroup?.()`
       * 是可选调用，没接线时它安静地什么也不做：菜单渲染得好好的、四项都在、
       * 点下去毫无反应。截图里就是"点了还停在菜单"。
       *
       * 又是"实现存在但没接线"（本项目最反复的缺陷类型）。
       * 所以 `test/chat-settings-ui.test.mjs` 里有一条断言专门守它：
       * `makeSettingsCallbacks` 必须给 `onOpenGroup` 赋值。
       */
      onOpenGroup: (groupId) => {
        this.chatSettingsRoute = groupId;
        this.renderPage();
      },
      reasoning: {
        get: () => this.showReasoning,
        set: (next) => {
          this.showReasoning = next;
          this.options.onPersistShowReasoning?.(next);
          /*
           * 面板如果已经建好，要**立刻**把新值推过去 ——
           * 否则用户翻完开关回到聊天，下一次生成还是旧行为。
           */
          this.chatPanel?.setShowReasoning(next);
        },
      },
      /*
       * 「思考」区块（2026-11-07，P0 第三步）。
       *
       * ## 这里的 `computePreview` 是**唯一**的判定入口
       *
       * 用户要求前端不许猜厂商。所以设置页每点一次三态，都回到这里
       * 调一次 `previewReasoningPlan` —— 它和发送路径共用同一个实现
       * （`buildGenerateRequest` 内部也调它），所以"界面显示"与"实际发出"
       * 必然一致，不会分叉。
       */
      thinking: {
        initialIntent: this.thinkingIntent,
        initialBudget: this.thinkingBudget,
        initialEffort: this.sampling['reasoningEffort'] as string | undefined,
        ...(this.thinkingFamily === undefined ? {} : { initialFamily: this.thinkingFamily }),
        computePreview: (intent, budget, family) =>
          previewReasoningPlan({
            source: this.apiState.source,
            model: this.apiState.model,
            customUrl: this.apiState.baseUrl,
            intent,
            budget,
            ...(family === undefined ? {} : { manualFamily: family }),
          }),
        onChange: (state) => {
          this.thinkingIntent = state.intent;
          this.thinkingBudget = state.budget;
          this.thinkingFamily = state.family;
          this.options.onPersistThinking?.(state);
          /*
           * 推给聊天面板：下一次生成立刻用新值。
           *
           * 不走 `renderPage()` —— 那会把用户刚展开的折叠区收回去、
           * 还会抢焦点（本页真机踩过 `activeElement: BODY`）。
           */
          this.chatPanel?.setThinking(state.intent, state.budget, state.family);
        },
      },
      onOpenActions: () => {
        this.chatSettingsRoute = 'actions';
        this.renderPage();
      },
      /*
       * 上下文预算（2026-11-03，第十九批 ④）。
       *
       * 用**回调**而不是传死值：用户在这一页改完「上下文长度」并保存后，
       * 外壳手上的 `promptFormats` / 面板上的用量都变了 ——
       * 传死值会让提示停留在旧数字上，而用户会以为自己没改成功。
       *
       * 预算为 0（ST 里没填上下文长度）时如实返回 0，
       * 页面据此显示"不会裁剪"而不是"预算 0 token"。
       */
      /*
       * 打开「提示词管理」（2026-11-03 第二十二批）。
       *
       * ★ 这一行漏了就是"入口不存在"——`callbacks.onOpenPrompts` 是可选调用，
       * 不传时整块不渲染，界面上看不到、点了也没反应，而测试全绿。
       * 本项目最反复的缺陷类型（memory §90.6 记过 6 次）。
       */
      onOpenPrompts: () => {
        this.chatSettingsRoute = 'prompts';
        this.renderPage();
      },
      budget: () => {
        const contextLimit = this.contextLimit;
        const responseLimit = this.responseLimit;
        const usage = this.chatPanel?.tokenUsage() ?? null;
        return {
          budget: computeBudget(contextLimit, responseLimit),
          contextLimit,
          responseLimit,
          lastUsed: usage === null ? null : usage.used,
          lastTrimmed: usage === null ? 0 : usage.trimmed,
          overBudget: usage !== null && usage.budget > 0 && usage.used > usage.budget,
        };
      },
      loadSettings: async () => {
        try {
          const raw = await this.withConnection(() => this.bridge.settingsGetRaw());
          const envelope: unknown = JSON.parse(raw === '' ? '{}' : raw);
          const parsed = parseSettingsEnvelope(envelope);
          if (!parsed.ok) {
            // 读到了但解析不了 —— 要把原因带出去（见 loadFailure）
            this.lastSettingsFailure = parsed.reason;
            return null;
          }
          this.lastSettingsFailure = null;
          return parsed.settings;
        } catch (error) {
          /*
           * ★ 不能只 `return null` 就完事。
           *
           * 设置页要区分"引擎没起"与"引擎在跑但读失败" —— 那是两种不同的
           * 下一步动作，而用户这次报的正是"引擎在跑、UI 却说没起来"。
           * 所以把原始原因记下来，交给 `readSettingsFailure()` 归因。
           */
          this.lastSettingsFailure = describeBridgeError(error).message;
          return null;
        }
      },
      /*
       * 设置读失败时给页面一份**如实**的归因。
       *
       * 页面自己没有能力判断引擎死活（它只拿到一个 null），
       * 所以由外壳把"读失败原因 + 引擎真实状态"组合好再交出去。
       */
      describeReadFailure: () =>
        describeSettingsFailure(this.options.readEngineStatus?.() ?? null, this.lastSettingsFailure ?? undefined),
      saveFields: async (fields) => {
        /*
         * 走 `mutateSettings`：GET → 改 → 整份 POST，三道防线在那边。
         * 这里**不许**直接调 `bridge.settingsSave` —— 那是整份覆盖，
         * 少一个字段就把用户设置清空了。
         */
        const result = await mutateSettings(
          {
            // ★ 两个传输动作都过连接门 —— mutateSettings 内部就是 GET→改→POST
            getRaw: () => this.withConnection(() => this.bridge.settingsGetRaw()),
            save: (settings) => this.withConnection(() => this.bridge.settingsSave(settings)),
          },
          (current) => {
            let next: StSettings = current;
            for (const { field, value } of fields) {
              next = writeField(next, field, value) as StSettings;
            }
            return next;
          },
        );

        if (!result.ok) return { ok: false, reason: result.reason };

        /*
         * ★ 保存成功后**立刻**把新采样值推给聊天面板。
         *
         * 不推的后果：用户改完温度、回到聊天页，发现回复风格没变 ——
         * 因为请求体里还是旧值。而这个问题**不会报错**，只能靠"再发一条
         * 试试"才发现，很容易被当成"模型不听话"。
         *
         * 用保存后的 `result.settings` 重新派生（而不是从 `fields` 里挑），
         * 保证运行时值与存储值来自同一份数据、同一个函数 ——
         * 挑字段就等于在第二个地方实现一遍映射。
         */
        this.sampling = this.deriveSampling(result.settings);
        this.chatPanel?.setContext({ sampling: { ...this.sampling } });

        return { ok: true };
      },
      /*
       * 预设（2026-11-03 / 任务 #259）。
       *
       * 只对「AI 响应配置」给 —— 那一组就是 ST 的 `OpenAI Settings` 预设。
       * 其它组没有预设概念，渲染一个下拉只会让人困惑。
       */
      presets: this.makePresetCallbacks(),
      onNotify: this.options.onNotify,
    };
  }

  /**
   * 预设：列出 / 切换 / 导入。
   *
   * ## 三条都是"真做事"，不是摆设
   *
   * | 动作 | 落到 ST 的哪里 |
   * |---|---|
   * | 列出 | `POST /api/settings/get` 的 `openai_setting_names` + `openai_settings` |
   * | 切换 | 把预设体**按短名→长名映射**后写进 `oai_settings`，并更新 `preset_settings_openai` |
   * | 导入 | `POST /api/presets/save`（`apiId: 'openai'`），名字取文件名 |
   *
   * ## 切换为什么不能只改 `preset_settings_openai`
   *
   * 那只改了"当前选的是哪个"这个名字。ST 的生成端点**从请求体读参数、不读设置**，
   * 而我们的请求体又是从 `oai_settings` 派生的（`samplingFromSettings`）。
   * 所以必须把预设里的参数真的写进 `oai_settings`，否则就是
   * "下拉显示新预设、温度还是旧值"。
   */
  private makePresetCallbacks(): {
    list: () => Promise<{ presets: PresetSummary[]; current: string } | null>;
    apply: (name: string) => Promise<{ ok: boolean; reason?: string; skipped?: number }>;
    importFile: () => Promise<{ ok: boolean; name?: string; reason?: string }>;
  } {
    return {
      list: async () => {
        try {
          const raw = await this.withConnection(() => this.bridge.settingsGetRaw());
          const envelope: unknown = JSON.parse(raw === '' ? '{}' : raw);
          if (envelope === null || typeof envelope !== 'object') return null;
          const presets = parsePresetList(envelope);
          const parsed = parseSettingsEnvelope(envelope);
          const current = parsed.ok ? currentPresetName(parsed.settings) : '';
          return { presets, current };
        } catch {
          /*
           * 读不到列表**不等于**出错要报警：用户可能就是想调单个参数。
           * 返回 null 让界面把提示换成"可以先用下面的单项设置"，
           * 而不是弹一个红色错误挡住整个页面。
           */
          return null;
        }
      },

      apply: async (name) => {
        try {
          /* 先拿到要切的那份预设体 */
          const raw = await this.withConnection(() => this.bridge.settingsGetRaw());
          const envelope: unknown = JSON.parse(raw === '' ? '{}' : raw);
          if (envelope === null || typeof envelope !== 'object') {
            return { ok: false, reason: '读不到预设列表' };
          }
          const bodies = presetBodiesByName(envelope);
          const body = bodies[name];
          if (body === undefined) {
            return { ok: false, reason: `找不到名为「${name}」的预设（可能刚被删掉）` };
          }

          const plan = planApplyPreset(body, name);
          if (Object.keys(plan.updates).length === 0) {
            return { ok: false, reason: `「${name}」里没有可用的参数（文件是空的？）` };
          }

          /*
           * 走 `mutateSettings`（GET → 改 → 整份 POST），
           * 不是直接 `settingsSave` —— 那是整份覆盖，少一个字段就清空用户设置。
           */
          const result = await mutateSettings(
            {
              getRaw: () => this.withConnection(() => this.bridge.settingsGetRaw()),
              save: (settings) => this.withConnection(() => this.bridge.settingsSave(settings)),
            },
            (current) => {
              const oai = (current['oai_settings'] ?? {}) as Record<string, unknown>;
              const merged = mergePresetIntoOai(oai, plan);
              return { ...current, oai_settings: merged } as StSettings;
            },
          );

          if (!result.ok) return { ok: false, reason: result.reason };

          /* 立刻把新采样值推给聊天面板 —— 否则下一次生成还用旧值 */
          this.sampling = this.deriveSampling(result.settings);
          this.chatPanel?.setContext({ sampling: { ...this.sampling } });

          /*
           * 提示词配置也要跟着换（2026-11-03）。
           *
           * ★ 不重新播的话会出现**最难归因的一种**：用户切换了预设，
           * 采样值变了（温度/长度立刻新值），但提示词还是上一份预设的 ——
           * 表现是"换了预设，风格只变了一半"，而这看起来像模型不稳定。
           *
           * 这里直接传预设体（手上就有），不用再发一次请求。
           */
          const nextConfig = parsePromptConfig(body);
          this.promptConfig = nextConfig.prompts.length > 0 ? nextConfig : null;
          {
            const readText = (key: string): string | undefined => {
              const value = (body as Record<string, unknown>)[key];
              return typeof value === 'string' && value !== '' ? value : undefined;
            };
            this.promptFormats = {
              scenarioFormat: readText('scenario_format'),
              personalityFormat: readText('personality_format'),
              wiFormat: readText('wi_format'),
              newExampleChatPrompt: readText('new_example_chat_prompt'),
            };
          }
          this.chatPanel?.setContext({
            promptConfig: this.promptConfig,
            promptFormats: this.promptFormats,
          });

          return { ok: true, skipped: plan.skipped.length };
        } catch (error) {
          return { ok: false, reason: describeBridgeError(error).message };
        }
      },

      importFile: async () => {
        try {
          /* 1. 选文件（原生对话框在 Rust 侧，见 `pick_json_file`） */
          const picked = await this.bridge.pickJsonFile();
          /*
           * 用户取消 ≠ 失败。取消时静默返回"没做成、也没出错"，
           * 界面据此什么都不弹 —— 弹一条红色"导入失败"会让用户以为程序坏了。
           */
          if (!picked.ok) {
            return picked.cancelled === true ? { ok: false, reason: '' } : { ok: false, reason: picked.reason };
          }

          /* 2. 解析 + 校验（导错文件在这里拦住，别等到"导入了却没用"） */
          let body: unknown;
          try {
            body = JSON.parse(picked.text);
          } catch {
            return { ok: false, reason: `「${picked.fileName}」不是合法的 JSON 文件。` };
          }

          const verdict = validatePresetBody(body);
          if (!verdict.ok) return { ok: false, reason: verdict.reason };

          const name = presetNameFromFile(picked.fileName);
          if (name === '') return { ok: false, reason: '文件名是空的，没法给预设起名。' };

          /* 3. 写进 ST */
          const saved = await this.withConnection(() =>
            this.bridge.presetSave(name, JSON.stringify(body)),
          );
          const savedName = saved === '' ? name : saved;

          /*
           * 4. 导入完**直接切过去**。
           *
           * 用户导一份配置就是为了用它。导完还得再手动选一次，
           * 中间那句"导入成功"会让人以为已经生效了。
           */
          const applied = await this.makePresetCallbacks().apply(savedName);
          if (!applied.ok) {
            return { ok: true, name: savedName, reason: `已导入，但切换失败：${applied.reason ?? ''}` };
          }
          return { ok: true, name: savedName };
        } catch (error) {
          return { ok: false, reason: describeBridgeError(error).message };
        }
      },
    };
  }

  private renderChat(): void {
    if (this.pageHost === null) return;

    /*
     * ★ 重绘前先放掉旧面板。
     *
     * `switchTab()` 里只对"离开聊天页"做了 dispose，而**回到**聊天页时
     * `renderChat()` 会 `new ChatPanel` 直接覆盖 `this.chatPanel`，
     * 旧面板既没 dispose 也再没人引用它 —— 它持有的流式监听器（绑在
     * `window` 上的 message 事件）和手势监听会一直活着。
     *
     * 症状就是 `switchTab` 那句注释预言的：往返几次之后，一次发送会发多条请求。
     * 2026-10-31 加 `setChatSnapshot()` 时被撞出来：它要求"重绘当前页"，
     * 而重绘的语义里必须包含"旧的走掉"。
     */
    this.chatPanel?.dispose();
    this.chatPanel = null;

    const callbacks: ChatPanelCallbacks = {
      onNeedApiConfig: () => this.switchTab('me'),
      onNotify: this.options.onNotify,
      /*
       * 消息变化 → 更新快照 + 落库。
       *
       * 绑定在**每个新面板**上（`renderChat()` 每次重建面板），
       * 因为回调是构造参数。这不会导致重复保存：`persistChat` 靠指纹去重。
       */
      onChatChanged: (messages) => this.handleChatChanged(messages),
      // 角色与聊天选择器本期用最简形态：由外壳提供候选（后续接真实列表）
      /*
       * ★ 2026-10-31 第五批：这两行原来是 `async () => null`。
       *
       * `ChatPanel.openPicker()` 里是
       *   `const picked = await this.callbacks.onPickCharacter?.();`
       *   `if (picked == null) return;`
       * 所以返回 null 就是"用户取消了"—— 点「选择角色」**毫无反应**。
       * 用户报的"没有任何角色可选"，一半原因在这里（另一半是卡没落库）。
       */
      onPickCharacter: () =>
        new Promise<{ avatar: string; name: string } | null>((resolve) => {
          this.pickResolve = resolve;
          this.pickerOpen = true;
          this.renderPage();
        }),
      /*
       * 选聊天：当前返回 null（= 用该角色的默认聊天）。
       *
       * 为什么先不实现：`ChatPanel` 在 `picked.lastChat` 为空时自己会走
       * "新建聊天"那条路；而"从多个历史聊天里挑一个"是另一个页面，
       * 与本次要修的"选不到角色"不是同一件事。摆一个半成品选择器
       * 会让用户以为历史对话丢了。
       */
      /*
       * ★ 选角色后要**读回最近一份聊天**（2026-11-01 第八批问题二）。
       *
       * 原来这里是 `async () => null`，导致 `ChatPanel.openPicker()` 走
       * `newChat()` 分支 —— 永远新开一个空聊天，**从不调用 `loadChat()`**。
       *
       * 后果：消息存进了磁盘（`st_chat_save` 确实发生了），但重进 App
       * 选同一个角色时看到的还是「还没有对话」—— 用户的心智是"我的记录没了"。
       * 数据在、但看不见，比数据丢了更让人困惑。
       *
       * 现在的行为：选角色后取该角色**最近一次**聊天的 `file_id`（无扩展名，
       * 这是 `get`/`save` 要的那个），交给 `loadChat()` 读回来。
       * 没有历史就返回 null，走 `newChat()` 建新聊天。
       */
      onPickChat: async (avatar) => {
        const latest = await this.findLatestChat(avatar);
        return latest === null ? null : { fileName: latest };
      },
      // 顶栏齿轮 → 二级页「聊天设置」（2026-10-31 第三批问题二）
      onOpenChatSettings: () => {
        this.chatSettingsRoute = 'menu';
        this.renderPage();
      },
      /*
       * 顶栏人设胶囊 → 就地切换（2026-11-06）。
       *
       * 不跳页：切换人设是聊天过程中的一个轻动作，跳走会把
       * 正在看的对话打断。弹下拉、选完就回到对话。
       */
      onSwitchPersona: (anchor) => {
        this.openPersonaSwitcher(anchor);
      },
    };

    const ctx: ChatPanelContext = {
      /*
       * ★ 用**真的读到的卡**，不是外部传进来的空对象（2026-11-05）。
       *
       * 移动端入口一直传 `card: {}`，于是世界书一条不激活、
       * `first_mes` 永远读不到。`loadedCard` 在选角色时被填上；
       * 没选角色时退回到外部那份（桌面端会传真卡）。
       */
      card: Object.keys(this.loadedCard).length > 0 ? this.loadedCard : this.options.card,
      /* 有选中的人设就用它的名字，否则退回外部传入的默认名（2026-11-04） */
      userName: this.currentUserName(),
      /*
       * 顶栏胶囊显示的名字（2026-11-06）。
       *
       * 与 `userName` 的差别：没选人设时 `userName` 是默认名，而这里是空串 ——
       * 面板会把空串退回 `userName`，所以"没选人设"时胶囊显示默认名而不是空白。
       */
      personaLabel: activePersona(this.personaState)?.name ?? '',
      /* 描述与插入位置也一起带上 —— 只带名字的话人设描述永远进不了上下文 */
      persona: this.personaContext(),
      source: this.apiState.source,
      model: this.apiState.model,
      /*
       * 采样来自 ST 设置（`oai_settings.*`），由 `this.sampling` 持有一份。
       *
       * 为什么不是每次请求都去读 ST 设置：那会让每条消息多一次 HTTP
       * 往返，且 ST 没起来时聊天直接不可用。这里用"进聊天页播种一次 +
       * 本页保存后立即更新"两条路径保证一致性（见 `seedSampling()`）。
       */
      sampling: { ...this.sampling },
      /*
       * 思考模式（2026-11-07，P0 第三步）。
       *
       * ★ 单独一项，不并进 `sampling`：`sampling` 会被 `seedSampling()`
       *   整批覆盖（它是从 ST 设置读来的），而思考意图是本机偏好。
       *   混在一起会在进聊天页时被抹成 ST 的默认。
       */
      thinking: {
        intent: this.thinkingIntent,
        ...(this.thinkingBudget === undefined ? {} : { budget: this.thinkingBudget }),
        ...(this.thinkingFamily === undefined ? {} : { family: this.thinkingFamily }),
      },
      // 自定义地址随请求体带（服务端不读设置）
      baseUrl: this.apiState.baseUrl,
      // 提示词配置与预算输入（2026-11-03）
      promptConfig: this.promptConfig,
      promptFormats: this.promptFormats,
      /*
       * 作者注释（2026-11-03 第二十七批）。
       *
       * 原来这一项**只存 ST、从不进请求**（真机 10 次实测标记 0 次出现）。
       * 现在由 `assembleWithPrompts` 按 ST 的 interval 规则插进历史。
       */
      ...(this.authorNote === null ? {} : { authorNote: this.authorNote }),
      contextLimit: this.contextLimit,
      responseLimit: this.responseLimit,
    };

    /*
     * ★ 语音传输（2026-11-01 第六批接线）。
     *
     * 此前 `setVoiceTransport()` 全库**零调用**，`onPersistVoice` 也从没被
     * main.ts 提供 —— 于是语音设置页能填、能"保存"，但
     *   ① 保存不落盘（下次进来还是默认值）；
     *   ② 麦克风永远置灰（`asrConfigured` 恒 false）。
     * 这是第 5 批"两个断点"同一类缺陷：**页面做完了，链路没接**。
     *
     * 判据放在壳里而不是 main.ts：main.ts 只管平台能力
     * （localStorage / JS 桥），"什么算配好了"是产品判据。
     */
    const voiceTransport = this.buildVoiceTransport();
    const panel = new ChatPanel(this.doc, ctx, callbacks, {
      asrConfigured: voiceTransport !== undefined,
      confirmBeforeSend: this.voiceSettings.confirmBeforeSend,
      /*
       * `lastMode` 在配置里是 `string`（可能是旧版本写进去的未知值），
       * 而 `VoicePanel` 只认三个字面量。用 `coerceVoiceMode` 收敛，
       * 不认识的落回默认模式 —— 直接强转会让面板拿着一个不存在的模式渲染。
       */
      lastMode: coerceVoiceMode(this.voiceSettings.lastMode),
      ...(voiceTransport !== undefined ? { transport: voiceTransport } : {}),
    });
    this.chatPanel = panel;
    /*
     * 注入「显示完整思考链」的当前值（2026-11-05）。
     *
     * 面板每次 `renderChat()` 都是新的，而开关值存在**外壳**上 ——
     * 不注入的话，用户翻完开关切一次 Tab，行为又回到默认（关）。
     */
    panel.setShowReasoning(this.showReasoning);
    this.pageHost.append(panel.mount(this.pageHost));

    /*
     * 快照重放。
     *
     * `renderChat()` 每次切 Tab 都会 **new 一个 ChatPanel**（旧面板 dispose），
     * 所以快照不能只在注入时 append 一次 —— 那样切到「我的」再切回来就没了。
     * 存在外壳上、每次建面板时重放，才与"这份对话属于这个 App 实例"的语义一致。
     */
    if (this.chatSnapshot !== null) {
      /*
       * ★ 必须把 avatar 一起传（2026-11-01 发布阻断级回归修复）。
       *
       * 不传的后果：读回历史之后面板的 `avatar` 仍是 null ⇒
       * 用户发消息被判成"没选角色"，提示 + 跳转「我的」。
       *
       * 这条分支绕过了 `newChat()`，而 `newChat()` 是唯一设 avatar 的地方 ——
       * 所以"有历史"和"有身份"这两件事必须在这里一起做。
       */
      panel.setMessages(
        this.chatSnapshot.messages,
        this.chatSnapshot.fileName,
        this.selectedCharacter?.avatar,
      );
      /*
       * 滚动位置：**两种情况分开**（2026-11-04 用户报「加载了聊天记录后
       * 应该直接显示到底部，而不是停在中间」）。
       *
       * ```text
       *   scrollTop 是数字   → 切 Tab / 切 App 回来，用户在翻历史
       *                       ⇒ 还原到他离开时的位置（§95 的要求，不能动）
       *   scrollTop 是 undefined → 冷启动首次恢复，没有"离开时的位置"
       *                       ⇒ 直接贴到最新那条
       * ```
       *
       * 原来两种情况都走 `restoreScroll(scrollTop ?? 0)` —— 冷启动被
       * `?? 0` 送到**顶部**，于是打开 App 看到的是这段对话最早的消息，
       * 最新几条在屏幕外面。用户要的正好相反。
       *
       * ★ 用 `undefined` 区分而不是加一个布尔标志：`chatSnapshot` 在冷启动
       * 由 `tryLoadInto()` 新建（不带 scrollTop），在 `switchTab` 离开时才
       * 写入 —— 这个字段**本身就是**"有没有离开过"的记录，不必再造一个。
       */
      if (this.chatSnapshot.scrollTop === undefined) {
        panel.scrollToBottomNow();
      } else {
        panel.restoreScroll(this.chatSnapshot.scrollTop);
      }
    } else if (this.selectedCharacter !== null) {
      /*
       * 恢复用户刚选的角色（2026-11-01）。
       *
       * 只在**没有聊天快照**时做：有快照意味着"已经在聊某个角色"，
       * 那时用快照恢复比用 selectedCharacter 更准（快照里有真实消息与文件名）。
       */
      /*
       * ★ 必须连**角色名**一起传（2026-11-01 第七批问题一）。
       *
       * 原来只传 avatar。而 `newChat()` 会把 `fileName` 置空，
       * 副标题当时唯一的数据源就是 fileName —— 于是恢复出来的面板
       * 顶栏写着「未选择聊天」，尽管角色明明已经选好了。
       *
       * 这是真机上实际走的那条路：`onPickCharacter` 回调里外壳先
       * `resolve(null)` 再 `renderPage()`，面板被**重建**，
       * 所以状态只能靠这里恢复。改 `openPicker()` 修不到它。
       */
      panel.newChat(this.selectedCharacter.avatar, this.selectedCharacter.name);
    }

    /*
     * 从 ST 设置播种采样参数（2026-10-31 第四批）。
     *
     * 放在最后、且**不 await**：读设置要一次 HTTP 往返，阻塞会让
     * 聊天页迟迟不出现。先用手上的值渲染，读到再通过 `setContext` 覆盖。
     *
     * 每次进聊天页都播一次的成本是"切 Tab 时多一个请求"——
     * 换来的是"用户在 ST 自己的设置页里改了温度，切回来就生效"。
     * 这个交换是划算的：用户改设置后最常做的事就是回聊天页试一下。
     */
    void this.seedSampling();

    /*
     * 提示词配置同样在进聊天页时播种一次（2026-11-03）。
     *
     * 与 `seedSampling()` 并列、同样不 `await`：两者各发一个请求，
     * 都要"先用手上的值渲染，读到再覆盖"。
     *
     * ★ 这一行是**接线**，不是可有可无的补充。
     * 本项目已经出现过 6 次"函数写好了但没人调"（§70.3 / §71.2 / §88…），
     * 每次现象都是"功能看起来存在、实际一点没生效"。
     * 判据：`test/prompt-manager-wiring.test.mjs` 断言这里真的调了。
     */
    void this.seedPromptConfig();
  }

  /**
   * 载入一份对话快照到聊天页（不请求 ST、不写文件）。
   *
   * 转给 `ChatPanel.setMessages()`，除此之外的工作只有两件：
   * 记在外壳上（切 Tab 后要重放）、以及"现在就在聊天页则立刻重绘"。
   *
   * 重绘走 `renderPage()` 而**不是** `renderChat()`：后者只 append 不清空，
   * 直接调会让页面里叠两个聊天面板（第一版就是这么写的，量到 `.nb-chat`
   * 高度 372 = 743/2 —— 两个面板各占一半）。
   * `renderPage()` 才是"重绘当前页"的唯一入口。
   */
  setChatSnapshot(fileName: string, messages: StChatMessage[]): void {
    this.chatSnapshot = { fileName, messages };
    if (this.active === 'chat') this.renderPage();
  }

  /**
   * 聊天内容变了：更新内存快照 + 落库（第八批问题二）。
   *
   * ## 两个断点都在这里合上
   *
   * 修之前实测：
   *
   * | 现象 | 断点 |
   * |---|---|
   * | 切 Tab 回来消息全没了 | `setChatSnapshot()` 只在 `?sample=1` 时被调用（注入样本）。真实聊天路径**从没更新过快照** ⇒ `renderChat()` 重建面板时 `chatSnapshot` 是 null ⇒ 走 `newChat()` ⇒ 消息清空 |
   * | 杀进程重进也没了 | `bridge.saveChat()` **全库零调用**（只有定义）⇒ 从来没往 ST 写过 |
   *
   * 所以这里做两件事，缺一不可：
   *   1. 更新快照（解决切 Tab）
   *   2. 写 ST 文件（解决杀进程）
   *
   * ## 为什么文件名要现算并记住
   *
   * `/api/chats/save` 的响应只有 `{ok:true}`，**不告诉我们存成了什么名字**。
   * 新建聊天时手里又没有名字。所以第一次保存前生成一个、存进 `chatFileName`，
   * 之后一直复用它 —— 否则每次保存一个新名字，一次对话留十几个文件。
   */
  /**
   * 选角色后把最近一份聊天读回来，填进快照。
   *
   * ## 为什么不 await
   *
   * 读历史要走一次 ST 往返（`/api/chats/get` 读整个 jsonl）。
   * 阻塞它会让"点角色 → 界面出现"之间卡一下。所以：
   * 先让界面出来（此时是空聊天），读到再 `renderPage()` 补上。
   *
   * 代价是"空 → 有内容"会闪一次。这个交换是划算的：
   * 用户点角色后立刻有反应，比盯着卡住的界面好。
   *
   * ## 失败静默
   *
   * 读不到（引擎没起、文件被删）就当没有历史 —— 用户看到空聊天。
   * 这种情况他马上会在别处看到引擎状态，不需要这里再喊一句。
   */
  private async restoreLatestChat(avatar: string, preferred?: string | null): Promise<void> {
    /*
     * ★ 必须重试（2026-11-01 第二轮，MuMu 上实测出来的）。
     *
     * 冷启动时序：`mount()` 时就发起恢复，而**内置 ST 引擎此时通常还没起完**
     * （真机实测 7–57 秒）。第一版只试一次、失败就 `return`，
     * 于是"杀进程重进 → 界面空白"—— 标题能显示角色名（那是 localStorage 里的），
     * 消息却一条没有。用户看到的就是"记录没了"。
     *
     * 为什么不是"等引擎就绪再读"：外壳拿不到引擎的 ready 事件
     * （那是 Rust 侧状态，`StService` 只写日志）。轮询是这里唯一能用的手段。
     *
     * 退避与上限：每 2 秒一次、最多 30 次（约 60 秒）。
     * 60 秒覆盖真机首启最慢的一次（57 秒）；再多就成了无意义的后台流量。
     *
     * 一成功就停；**"确实没有历史"也停**（那不是网络问题，重试没意义）。
     */
    const deadline = Date.now() + 60_000;
    for (let attempt = 0; ; attempt += 1) {
      /*
       * 用户可能在这期间换了角色 —— 立刻放弃，不要让旧角色的历史
       * 覆盖到他新选的角色上（表现为"选 B 结果出来 A 的对话"）。
       */
      if (this.selectedCharacter?.avatar !== avatar) return;

      /*
       * ★★★ 每次重试前先确保连上 ST（2026-11-01 第二轮，真机实测补的）。
       *
       * 真机冷启动实测：localStorage 里会话三样齐全、引擎在听 8000，
       * 但 `st_chat_list` / `st_chat_load` 都返回：
       *
       * ```json
       * {"code":"ST_UNAVAILABLE","message":"连不上 SillyTavern：还没连上 SillyTavern。先点一次「连接」"}
       * ```
       *
       * 根因：`StChatBridge.connect()` 全库**零调用** —— Rust 侧
       * `StChatState.api` 恒为 `None`。上一轮用户手动点选角色能成功，
       * 是因为那条路上别的动作先触发过 `ensureConnected()`。
       *
       * 这是本项目**第五次**「函数写了没人调」（前四次：`.nb-chat` 零 CSS、
       * 输入框忘 append、`setVoiceTransport` 零调用、`saveChat` 零调用）。
       * 所以判据必须钉"读历史之前先连"，而不是"connect 函数存在"。
       *
       * 放在循环内而不是循环外：引擎没起时 `connect` 也会失败，
       * 下一轮必须能重试到它起（`ensureConnected` 不缓存失败，正是为此）。
       */
      await this.ensureConnected();

      const latest = preferred ?? (await this.findLatestChat(avatar));
      if (latest !== null && (await this.tryLoadInto(avatar, latest))) return;

      /*
       * `findLatestChat` 返回 null 有两种含义：**真的没有历史**，
       * 或**请求失败**（引擎没起）。前者重试也没用，后者必须重试。
       * 这里无法区分，所以统一按"可能是引擎没起"重试到超时 ——
       * 代价只是没有历史的用户多轮询几次（每次一个 HTTP 请求，无副作用）。
       */
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  /**
   * 试着把某个聊天文件读进快照。
   *
   * 返回 `true` 表示**已经应用**（读到内容）；`false` 表示这次没成（可重试）。
   */
  private async tryLoadInto(avatar: string, fileName: string): Promise<boolean> {
    const latest = fileName;

    /*
     * 只在这个角色**还是当前选中的**时候才应用结果。
     *
     * 用户可能连点了两个角色：A 的读取慢、B 的快。不判一下的话，
     * A 的历史会覆盖到 B 的界面上 —— 表现为"选 B 结果出来 A 的对话"。
     */
    if (this.selectedCharacter?.avatar !== avatar) return false;

    try {
      const raw = await this.bridge.loadChatRaw(avatar, latest);
      const parsed = parseChatResponse(JSON.parse(raw === '' ? '{}' : raw) as unknown);
      if (parsed.kind !== 'chat') {
        /*
         * `missing` / `empty` / `malformed` 都不自动建聊天（陷阱 #4）。
         * 尤其是 `malformed`：把消息清空再让用户发送，等于**用空历史
         * 覆盖真实文件**（save 是全量覆盖）。
         */
        return false;
      }
      this.chatFileName = latest;
      this.chatSnapshot = { fileName: latest, messages: parsed.messages.slice() };
      // 已经存过的内容，指纹要对上，否则首次发消息会重复存一遍
      this.lastSavedFingerprint = chatFingerprint(parsed.messages);
      /*
       * ★ 这里必须再落一次盘（2026-11-01 第二轮真机/模拟器实测）。
       *
       * `onPick` 的顺序是：`void restoreLatestChat(...)`（异步）→ `persistSession()`。
       * 落盘那一刻本函数还没跑完，`chatFileName` 仍是 null，
       * 于是 localStorage 里存成 `"fileName": null`。
       *
       * 后果：页面重载（切到别的 App 再回来）时，构造函数恢复了 avatar
       * 但 fileName 是 null ⇒ `mount()` 里那句
       * `if (chatFileName !== null)` 不成立 ⇒ **不读历史** ⇒ 界面空白。
       * 而标题能显示角色名（说明 avatar 恢复成功）—— 正是用户看到的样子。
       *
       * 实测证据：MuMu 上 `localStorage tcs.mobile.chatSession`
       * = `{"avatar":"测试用-夜航小助手.png","name":"夜航小助手（测试）","fileName":null}`
       */
      this.persistSession();
      if (this.active === 'chat') this.renderPage();
      return true;
    } catch {
      // 读失败（多半是引擎还没起）⇒ 交给调用方重试
      return false;
    }
  }

  /**
   * 把会话身份落盘。
   *
   * ## 为什么这里不 await、也不管失败
   *
   * 落盘（localStorage）是同步且几乎不会失败的。为了它去 await 会让
   * `onPick` 的调用方多一次微任务 —— 而这个信息"晚一帧存"没有任何后果。
   *
   * 真正需要保证的是**内容**（消息）落进 ST 的 jsonl，那条路径在
   * `persistChat()` 里，有重试与提示。
   */
  private persistSession(): void {
    if (this.selectedCharacter === null) return;
    this.options.onPersistSession?.({
      avatar: this.selectedCharacter.avatar,
      name: this.selectedCharacter.name,
      fileName: this.chatFileName,
    });
  }

  /**
   * 找一个角色**最近一次**聊天的 `file_id`（无扩展名）。
   *
   * ## 为什么取"最近"
   *
   * 用户重进 App 时的期待是"接着上次聊"，不是"从最早的开始"。
   * ST 的 `/api/characters/chats` 返回的数组**不保证顺序**，
   * 所以这里按 `last_mes`（毫秒时间戳）自己排 —— 依赖服务端顺序是脆的。
   *
   * ## 为什么返回 `file_id` 而不是 `file_name`
   *
   * 契约陷阱 #3：`file_id` 无扩展名、`file_name` 带 `.jsonl`。
   * `get` / `save` 要的是**无扩展名**的那个；用错会 400 或建出怪文件。
   *
   * ## 失败就是"没有历史"
   *
   * 读列表失败（引擎没起、网络断）时返回 null，让用户看到空聊天而不是一个
   * 卡住的界面。这里**不弹错误**：他点「选择角色」时如果引擎没起，
   * 会马上在别处看到引擎状态，不需要这里再喊一句。
   */
  private async findLatestChat(avatar: string): Promise<string | null> {
    try {
      const raw = await this.bridge.listChatsRaw(avatar);
      const parsed = JSON.parse(raw === '' ? '[]' : raw) as unknown;
      if (!Array.isArray(parsed)) return null;

      let best: { id: string; at: number } | null = null;
      for (const one of parsed) {
        if (one === null || typeof one !== 'object') continue;
        const info = one as Record<string, unknown>;
        const id = info['file_id'];
        if (typeof id !== 'string' || id === '') continue;
        const at = typeof info['last_mes'] === 'number' ? info['last_mes'] : 0;
        if (best === null || at > best.at) best = { id, at };
      }
      return best === null ? null : best.id;
    } catch {
      // 读不到列表 = 当作"没有历史"，让用户从空聊天开始
      return null;
    }
  }

  private handleChatChanged(messages: StChatMessage[]): void {
    /*
     * ★ 先把快照更新掉，**不管后面存不存得成功**。
     *
     * 这两件事的失败模式不同：快照失败 = 切 Tab 丢消息（当场可见）；
     * 保存失败 = 杀进程丢消息（要等下次启动才发现）。
     * 让"更确定能成功"的那一步先做，并且不要因为保存失败而回滚它。
     */
    const avatar = this.selectedCharacter?.avatar ?? null;
    const name = this.selectedCharacter?.name ?? '';

    // 文件名：已有就复用；没有就现造一个（新建聊天首次保存）
    if (this.chatFileName === null && avatar !== null) {
      this.chatFileName = makeChatFileName(name);
    }

    if (this.chatFileName !== null) {
      /*
       * ★ 更新快照时**保留** scrollTop（2026-11-03 第二十四批）。
       *
       * 这里是"消息变化"（发消息/收回复），不是"换了一份对话"。
       * scrollTop 的最终值由 `switchTab` 离开时实时读取；这里若不保留，
       * 一次发消息就会把之前存的位置清成 undefined，切 Tab 回来时
       * 就没有位置可还原了。
       */
      this.chatSnapshot = {
        fileName: this.chatFileName,
        messages: messages.slice(),
        scrollTop: this.chatSnapshot?.scrollTop,
      };
      // 文件名可能刚刚才生成（新建聊天的第一次保存），要落盘
      this.persistSession();
    }

    void this.persistChat(messages, avatar);
  }

  /**
   * 真正写 ST。
   *
   * 三个"不做"的理由都是硬性的：
   *   · 没角色 ⇒ 不知道写哪个目录
   *   · 空历史 ⇒ `/api/chats/save` 是**整份覆盖**，用 `[]` 覆盖等于清空用户历史（陷阱 #1）
   *   · 指纹没变 ⇒ 和上次存的一样
   */
  private async persistChat(messages: StChatMessage[], avatar: string | null): Promise<void> {
    if (this.chatFileName === null) return;
    if (
      !shouldSaveChat({
        messages,
        avatar,
        lastSavedFingerprint: this.lastSavedFingerprint,
      })
    ) {
      return;
    }

    /*
     * 保存是**整份覆盖**：两条并发保存会让后到的覆盖先到的。
     * 所以必须串行 —— 但**不能丢掉后来那一次**（理由见 `pendingChatSave` 的注释）。
     */
    if (this.savingChat) {
      this.pendingChatSave = { messages: [...messages], avatar };
      return;
    }
    this.savingChat = true;

    let current: { messages: StChatMessage[]; avatar: string | null } = { messages, avatar };
    try {
      /*
       * 循环到"没有更新的内容在等"为止。
       *
       * 用 `for(;;)` 而不是递归：递归在这里会一层层压栈，而且中途抛异常时
       * 很难保证 `savingChat` 复位。这里只有一个出口（finally）。
       */
      for (;;) {
        const fingerprint = chatFingerprint(current.messages);
        try {
          await this.bridge.saveChat(
            current.avatar ?? '',
            this.chatFileName,
            current.messages,
          );
          this.lastSavedFingerprint = fingerprint;
        } catch (error) {
          /*
           * 保存失败**不打断聊天**：用户正在对话，弹一个红条阻断体验更糟。
           * 但要留痕迹 —— 否则"消息没存上"这件事要等他重启 App 才发现。
           */
          this.options.onNotify?.(
            `聊天记录没能保存（${error instanceof Error ? error.message : String(error)}）。` +
              '当前对话还在，但重启应用后会丢失。',
            'warn',
          );
        }

        const next = this.pendingChatSave;
        this.pendingChatSave = null;
        if (next === null) break;
        current = next;
      }
    } finally {
      this.savingChat = false;
    }
  }

  private renderMe(): void {
    if (this.pageHost === null) return;
    this.pageHost.replaceChildren();

    const topbar = el(this.doc, 'div', 'nb-topbar');
    const title = el(this.doc, 'h1', 'nb-topbar-title');
    title.textContent = '我的';
    topbar.append(title);
    this.pageHost.append(topbar);

    /*
     * ★ 内容要装在一个**自己能滚**的容器里。
     *
     * `.nb-page` 是 `flex:1; min-height:0; flex-direction:column`，
     * 但**没有 `overflow-y`** —— 它按设计只装"一屏放得下"的页面
     * （聊天页就是：`.nb-msglist` 自己在内部滚）。
     *
     * 「我的」页不一样：接口来源六项、每个展开后带地址/模型名/key 三段
     * 输入加说明，再加语音区块，内容高度远超一屏。缺这个容器时实测
     * `page.scrollHeight === page.clientHeight === 743`（溢出**不产生滚动**），
     * 于是展开的「API key」说明被下方保存按钮压住并截断
     * （截图里"填错的话生成会直接"后面就没了），语音区块整个看不到。
     *
     * 为什么不给 `.nb-page` 加 `overflow:auto`：那是四个 Tab 共用的容器，
     * 加上之后聊天页会多出第二个滚动容器，与 `.nb-msglist` 抢滚动、
     * 让"滚到底"判断失效 —— 那个坑 2026-10-31 刚修完。
     */
    const scroller = el(this.doc, 'div', 'nb-scroll');
    this.pageHost.append(scroller);

    /*
     * ★ 一级选项 = 两个**同级收纳项**（2026-10-31 第三批，用户要求）。
     *
     * 改之前的结构是不一致的：API 连接页**直接平铺**在「我的」里（一整页表单
     * 铺开，要先滚过它才能看到语音），而语音输入已经是个收纳项。
     * 用户要的是"两个都是收纳项、层级一致、点哪个展开哪个"。
     *
     * 所以这里抽了 `renderAccordion()`：**两个条目用同一个构造函数**，
     * 不各写一份 —— 各写一份必然在 padding / chevron / aria 上慢慢分叉，
     * 而这类分叉只在截图里看得出来（`chat.css` 那边已有过同类教训）。
     */
    scroller.append(this.renderApiSection(), this.renderVoiceSection());
  }

  /* ═══════════════════════════════════════════════════════════
     收纳项（「我的」页一级选项的通用形态）
     ═══════════════════════════════════════════════════════════ */

  /**
   * 造一个可折叠区块：标题行常驻 + 点一下就地展开面板。
   *
   * ## 为什么不直接复用 `<details>`
   *
   * 原生 `<details>` 的展开/收起**没有过渡**（`open` 属性是布尔切换），
   * 而且它的 `summary` 在不同 WebView 里的默认箭头样式不一致
   * —— 我们已经在 `.nb-tabbar` 上踩过"浏览器默认样式跟着系统变"的坑
   * （麦克风按钮变成灰方块，见 chat.css 的 `.nb-mic-slot` 注释）。
   * 自己写 40 行能完全控制，代价远小于跟 UA 样式打架。
   *
   * ## 为什么收起时清空 DOM（而不是留着用高度动画）
   *
   * 两个展开面板里都有同名输入框（`model-input` / `key-input` / `asr-key`）。
   * 留着 DOM 的话 `byRole('model-input')[0]` 会取到**收起那个**，
   * 保存时读到另一份的值 —— 这类缺陷不报错，只是"填了 A 存成了 B"。
   *
   * 代价是收起没法做高度过渡（内容没了高度就是 0）。
   * 折中：**展开有过渡（opacity + translateY + chevron 旋转），收起瞬时**。
   * 这不是遗漏，是"字段唯一"优先于"收起动画"的取舍。
   */
  private renderAccordion(spec: AccordionSpec): ElLike {
    const section = el(this.doc, 'div', 'nb-section');
    section.setAttribute('data-role', `${spec.entryRole}-section`);

    const header = el(this.doc, 'button', 'nb-listitem nb-src-item');
    header.setAttribute('type', 'button');
    header.setAttribute('data-role', spec.entryRole);
    header.setAttribute('aria-pressed', String(spec.expanded));
    header.setAttribute('aria-expanded', String(spec.expanded));

    const main = el(this.doc, 'span', 'nb-listitem-main');
    const name = el(this.doc, 'span', 'nb-listitem-title');
    name.textContent = spec.title;
    const hint = el(this.doc, 'span', 'nb-listitem-sub');
    hint.setAttribute('data-role', `${spec.entryRole}-hint`);
    hint.textContent = spec.subtitle;
    main.append(name, hint);

    const chevron = el(this.doc, 'span', 'nb-src-chevron');
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';

    header.append(main, chevron);

    const body = el(this.doc, 'div', 'nb-acc-panel');
    body.setAttribute('data-role', spec.panelRole);

    const fill = (): void => {
      body.replaceChildren();
      /*
       * `data-enter="1"` 是展开入场动画的触发器（见 chat.css 的
       * `.nb-acc-panel[data-enter='1']`）。用属性而不是 class：
       * 属性不会被后续 `classList` 操作顺手删掉，动画放完也不清 ——
       * 重复展开时浏览器会因为"属性没变"而不重播，这正是我们要的
       * （`replaceChildren` 会重建子节点，动画自然跟着重放）。
       */
      body.setAttribute('data-enter', '1');
      body.append(spec.buildBody());
    };

    if (spec.expanded) {
      fill();
      body.hidden = false;
    } else {
      body.replaceChildren();
      body.hidden = true;
    }

    /** 展开状态（本地持有，与 DOM 属性同为一份真相的两个表示） */
    let expanded = spec.expanded;

    header.addEventListener('click', () => {
      /*
       * ★ 展开状态由**我们自己的变量**持有，不靠读 DOM 属性翻转。
       *
       * 第一版是 `const now = header.getAttribute('aria-expanded') === 'false'`，
       * 也就是"读 DOM 再翻转"。那个写法有个真实后果：
       * 「卡片」Tab 里那两个**纯说明型条目**（`onToggle` 是空函数），
       * 点一下仍会把 `aria-expanded` 从 false 翻成 true 并渲染说明文字，
       * 再点一下又收起 —— 看起来像"可折叠设置块"，实际它只是段说明。
       * 用户会以为"这里能配置什么"，点开才发现只有一句话。
       *
       * 现在 `expanded` 是本地状态、由 `spec.onToggle()` 的**返回值**决定
       * 要不要翻：说明型条目返回 `false`，点了没反应是对的（它本来就是一段文字）。
       */
      const shouldFlip = spec.onToggle();
      if (!shouldFlip) return;
      expanded = !expanded;
      header.setAttribute('aria-pressed', String(expanded));
      header.setAttribute('aria-expanded', String(expanded));
      if (expanded) {
        fill();
        body.hidden = false;
      } else {
        body.replaceChildren();
        body.hidden = true;
      }
    });

    section.append(header, body);
    return section;
  }

  /**
   * 「我的 → API 连接」收纳项。
   *
   * 内容就是原来的 `renderApiPage()`，一行没改 —— 用户明确要求
   * "现有 API 与语音输入两个页面内部的抽屉式交互保持不变"。
   * 这一步只改**外层怎么摆**，不动里面怎么用。
   */
  private renderApiSection(): ElLike {
    /*
     * 进这一块就先问一次 ST「哪些源真的配了 key」（2026-11-07）。
     *
     * ★ 为什么必须问 ST 而不是只用本地标记：
     *
     * 用户真机报「配了 API key，界面说没配」。本地标记会因换版本、
     * 清缓存、在 ST 原始界面配过而丢失 —— 而 ST 的 `secrets.json`
     * 才是真相。`/api/secrets/read` 返回的每一项要么是数组、要么是 `null`。
     *
     * 这里是"fire and forget"：同步渲染用当前已知状态，
     * 拿到真相后如果需要再重绘一次（`refreshKeyPresence` 内部判断）。
     */
    void this.refreshKeyPresence();

    return this.renderAccordion({
      entryRole: 'api-entry',
      panelRole: 'api-panel',
      title: 'API 连接',
      subtitle: apiSummary(this.apiState),
      expanded: this.apiExpanded,
      onToggle: () => {
        this.apiExpanded = !this.apiExpanded;
        return true;
      },
      buildBody: () => {
        /*
         * 传一个**包过连接门**的 writeSecret。
         *
         * 直接传 `this.bridge` 的话，第一次保存会撞上 "还没连上 SillyTavern"
         * —— 而那一刻外壳其实有能力连上，只是没被要求连。
         */
        const writer = {
          writeSecret: (key: string, value: string) =>
            this.withConnection(() => this.bridge.writeSecret(key, value)),
        };

        const page = renderApiPage(this.doc, writer, this.apiState, {
          /*
           * 收纳项的标题行已经写着「API 连接」，这一页自带顶栏会重复一次
           * （2026-10-31 第三批截图里能直接看到两个「API 连接」）。
           */
          hideTopbar: true,
          // 重绘前记下的提示（"已保存"）—— 显示一次就清
          notice: this.pendingApiNotice ?? undefined,
          /*
           * 秘钥框的三态要问"这个源配过没有"（2026-11-02 用户要求）。
           *
           * 传函数而不是布尔：页面在**切换源**时会重建输入框，
           * 那一刻要按新源重新判断。传快照的话切到另一个源仍显示旧状态。
           */
          hasKeyFor: (source) => this.apiKeyPresent.has(source),
          onSave: async (state, apiKey) => {
            /*
             * ★★★ 第一步就是**真的写进 SillyTavern**（2026-11-04 第二十八批）。
             *
             * 取证结论：改之前这一页**只写 localStorage** ——
             * ST 的 secrets 从未被调用（`SecretWriter` 定义了但零引用），
             * ST 的 settings 只写过 `max_tokens`。
             * 所以 ST 里一直是 `openai / gpt-4-turbo`，App 里是
             * `custom / deepseek-v4-pro`，两边长期不一致。
             *
             * 放到最前面而不是最后：这一步是"保存"的**实质**，
             * 它的成败决定后面能不能说"已保存"。
             */
            const stProblems = await this.writeApiConnectionToSt(state, apiKey);
            const stOk = stProblems === null;

            this.apiState = state;

            /*
             * 本地状态照写。
             *
             * 为什么 ST 失败也写本地：请求体用的是本地这份，写了才聊得动；
             * 不写会让用户"连本机都存不了"。但**必须告诉他没同步进引擎** ——
             * 只写本机而不说，就是改之前那种"看起来成功了、其实是假的"。
             */
            let localError: string | null = null;
            try {
              await this.options.onPersistApi?.(state);
            } catch (error) {
              localError = error instanceof Error ? error.message : String(error);
            }

            /*
             * 这次写了新 key ⇒ 记下"这个源已配置"。
             *
             * ★ 只在**真的写进 ST** 时才认这个标记。改之前是无条件记的，
             * 于是 UI 会显示"已配置秘钥"，而引擎里一个字节都没有 ——
             * 用户发消息才发现 401。
             */
            if (apiKey !== null && stOk && localError === null) {
              this.apiKeyPresent.add(state.source);
              this.options.onApiKeyWritten?.(state.source);
            }
            /*
             * 只同步连接类字段。
             *
             * 2026-10-31 第四批：采样参数已迁走，这里**不许**再碰
             * `sampling` —— 一旦这里还写一遍，保存连接配置就会把
             * 聊天页正在用的采样值覆盖成默认值（用户会看到"我只是改了
             * 模型名，温度怎么回默认了"）。
             */
            this.chatPanel?.setContext({
              source: state.source,
              model: state.model,
              // 地址也要同步 —— 否则填完地址要重启才生效
              baseUrl: state.baseUrl,
            });

            /*
             * ★★★ 把「最大回复长度」写进 ST 设置（2026-11-02）。
             *
             * ## 为什么必须落进 ST，而不是只存在 App 侧
             *
             * 请求体里的 `max_tokens` 来自 `samplingFromSettings()`，而它读的是
             * ST 的 `oai_settings.openai_max_tokens`（出厂 300）。
             * 只在 App 侧存一个 `maxTokens` 是**不会生效**的 —— 那正是
             * "改了但没变"的经典形态：界面显示 800、请求里还是 300。
             *
             * ## 为什么走 `saveFields` 而不是直接 POST 设置
             *
             * 它内部是 `mutateSettings`：GET → 改一个字段 → 整份 POST。
             * 直接 POST 是整份覆盖，少一个字段就把用户设置清空了（陷阱 #6）。
             *
             * ## 失败不阻断保存
             *
             * 连接配置本身已经存成功了；写 ST 失败只影响"长度上限"这一项。
             * 所以这里只提示、不抛 —— 否则用户会看到"保存失败"但其实源和模型都存好了。
             */
            if (typeof state.maxTokens === 'number') {
              const here = state.maxTokens;
              const reason = await this.writeMaxTokens(here);
              if (reason !== null) {
                this.options.onNotify?.(
                  `连接配置已保存，但「最大回复长度」没写进引擎：${reason}`,
                  'warn',
                );
              }
            }

            /*
             * 记下"已保存"给重绘后的页面显示。
             *
             * 不记的话用户看不到任何成功反馈（真机实测：保存其实成功了，
             * 但界面上一片空白）—— 见 `pendingApiNotice` 与
             * `ApiPageCallbacks.notice` 的注释。
             */
            /*
             * ★★★ 反馈只由**实际结果**决定（用户要求"回读验证后 UI 反馈才允许显示成功"）。
             *
             * 改之前无论 ST 写没写都显示"已保存" —— 那正是这个 bug 能潜伏
             * 这么久的原因：界面一直在说成功。
             */
            if (stOk && localError === null) {
              this.pendingApiNotice = '已保存（已同步到服务）';
            } else if (stOk) {
              this.pendingApiNotice = '引擎已同步，但本机没存住';
            } else {
              this.pendingApiNotice = '只保存到本机，没同步到服务';
              this.options.onNotify?.(
                `「${state.model}」没能同步到服务：${(stProblems ?? []).join('；')}`,
                'danger',
              );
            }
            if (localError !== null) {
              this.options.onNotify?.(`本机配置没存住：${localError}`, 'danger');
            }
            /*
             * 重绘后立刻清掉，保证"只显示一次"。
             *
             * 用微任务而不是同步清：`renderPage()` 是同步的，它在下面这行
             * 之前执行，所以这次渲染能读到值；清空留到下一轮事件循环，
             * 这样切 Tab 回来时不会又冒出"已保存"。
             */
            queueMicrotask(() => {
              this.pendingApiNotice = null;
            });
            /*
             * 副标题要跟着变（"当前：xxx 模型 yyy"）。
             * 重绘整页是唯一可靠的办法：`renderAccordion` 每次重建标题行，
             * 手工去改那个 span 会漏掉"另一个条目也被重建了"这件事。
             */
            this.renderPage();
          },
          onNotify: this.options.onNotify,
        });
        this.apiPageEl = page;
        return page;
      },
    });
  }

  /**
   * 「我的 → 语音输入配置」收纳项。
   *
   * ## 为什么需要它（2026-10-31 第二轮）
   *
   * `voice-settings.ts` 在 T15.6 就写完了（448 行，导出
   * `renderVoiceSettingsPage` / `makeTestAudio` / `presetOf` 等），
   * 但 `grep -rn "voice-settings" client/src` **除自身外零引用** ——
   * 桌面端和移动端都没有入口。
   *
   * 也就是说：功能实现了、单元测试全绿、但用户在任何地方都看不到它。
   * **"实现存在但没接线"是本项目最反复的缺陷类型之一。**
   *
   * ## 2026-10-31 第三批：改成用 `renderAccordion()`
   *
   * 原来这里有一份**手写**的收纳项实现（标题行 + chevron + 面板 + 事件），
   * 而 API 连接是平铺的。用户要求两级收纳后，两个条目必须同级 ——
   * 于是把这份手写实现抽成通用组件，两个条目共用。
   *
   * 保留这个函数名而不是直接内联：`test/mobile-ui-fixes.test.mjs` 有一条
   * 断言是"必须真的 `append(this.renderVoiceSection())`"（防"写了函数没挂"），
   * 那是这个项目最该守住的一类断言，不能因为重构就把它删掉。
   *
   * 展开状态记在外壳（`this.voiceExpanded`），不记在页面里 ——
   * 切一次 Tab 页面会 `replaceChildren` 重绘，记在页面里就丢了。
   */
  /**
   * 当前语音配置是否**能用**（决定麦克风是否置灰）。
   *
   * 三件事缺一不可：选了预设、填了地址与模型、需要 key 的话 key 也存过。
   *
   * 为什么不用 `baseUrl !== ''` 一条判据：用户选了 Groq 但没填 key 时，
   * 麦克风若是亮的，他会录一整段、等转写、然后拿到"密钥无效" ——
   * 而这件事在**打开设置页的那一刻**就该被拦住。
   */
  private voiceConfigured(): boolean {
    const settings = this.voiceSettings;
    const preset = findAsrPreset(settings.presetId);
    if (preset === null) return false;
    if (settings.baseUrl.trim() === '' || settings.model.trim() === '') return false;
    if (preset.requiresKey && (this.options.readVoiceKey?.() ?? '').trim() === '') return false;
    return true;
  }

  /**
   * 造语音传输（真实录音器 + 转写器）。配好之前返回 `undefined`。
   *
   * `getConfig` 是一个**每次转写都重新读**的闭包，不是快照：
   * 用户在设置页改完立刻生效，不必重启面板（缓存配置会让"改完没反应"
   * 变成一个新的困惑源，见 `createTranscriber` 的注释）。
   */
  private buildVoiceTransport(): VoiceTransport | undefined {
    if (!this.voiceConfigured()) return undefined;

    const transcriber = createTranscriber(() => {
      const current = this.voiceSettings;
      const preset = findAsrPreset(current.presetId);
      if (preset === null) return null;
      return {
        preset,
        baseUrl: current.baseUrl,
        apiKey: this.options.readVoiceKey?.() ?? '',
        model: current.model,
        ...(current.modelPath !== undefined ? { modelPath: current.modelPath } : {}),
      };
    });

    return { ...createRecorder(), transcribe: transcriber };
  }

  private renderVoiceSection(): ElLike {
    return this.renderAccordion({
      entryRole: 'voice-entry',
      panelRole: 'voice-panel',
      title: '语音输入配置',
      subtitle: voiceSummary(this.voiceSettings),
      expanded: this.voiceExpanded,
      onToggle: () => {
        this.voiceExpanded = !this.voiceExpanded;
        return true;
      },
      buildBody: () => {
        const page = renderVoiceSettingsPage(this.doc, this.voiceSettings, {
          // 收纳项标题行已写「语音输入配置」，这一页自带顶栏会重复
          hideTopbar: true,
          notice: this.pendingVoiceNotice ?? undefined,
          /*
           * 秘钥框三态要问"配过没有"（2026-11-02 用户要求）。
           *
           * 语音 key 存在本机、能读回来，所以直接问 `readVoiceKey` 就够 ——
           * 不需要像聊天 key 那样由外壳单独记标记。
           */
          hasKey: () => (this.options.readVoiceKey?.() ?? '') !== '',
          readKey: () => this.options.readVoiceKey?.() ?? '',
          onSave: async (settings, apiKey) => {
            this.voiceSettings = settings;
            await this.options.onPersistVoice?.(settings, apiKey);
            /*
             * 记下"已保存 + 当前生效摘要"给重绘后的页面显示（2026-11-01）。
             *
             * 只写"已保存"三个字信息量太低：用户还要自己回想"我存的是哪个
             * 厂商、哪个模型"。把摘要一起给出来，他扫一眼就知道生效的是什么。
             */
            this.pendingVoiceNotice = `已保存 · ${voiceSummary(settings)}`;
            queueMicrotask(() => {
              this.pendingVoiceNotice = null;
            });
            // 副标题要跟着变（"当前：xxx"），所以重绘整页
            this.renderPage();
          },
          onNotify: this.options.onNotify,
        });
        return page.root;
      },
    });
  }

  /** 主题切换的唯一入口（本期只有夜航；换主题 = 换 token 层） */
  setTheme(theme: 'nebula'): void {
    if (this.root === null) return;
    this.root.setAttribute('data-theme', theme);
  }

  /** 给测试与外部用：当前激活的 Tab */
  activeTab(): TabId {
    return this.active;
  }

  dispose(): void {
    this.chatPanel?.dispose();
    this.bridge.dispose();
    this.chatPanel = null;
    this.apiPageEl = null;
    this.root = null;
    this.pageHost = null;
    /* 外壳也要放掉 —— 它是 `renderPage()` 的入口判据（null 就整页不动） */
    this.pageRoot = null;
    this.tabButtons.clear();
  }
}

/**
 * 从一份设置对象里读一个数字字段。
 *
 * 为什么单独一个函数：`oai_settings` 里的值可能来自用户手改的 JSON，
 * 类型不保证。`typeof === 'number'` 是唯一可靠的判断 ——
 * 用 `Number(value)` 会把 `""` 变成 0、把 `"abc"` 变成 NaN，
 * 而 0 与 NaN 在预算计算里分别意味着"不裁"和"另算"，行为不同。
 */
function readNumberField(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}


/**
 * 一次转场动画最多该等多久（毫秒）—— 兜底定时器用它。
 *
 * ## 为什么不能写死一个常数
 *
 * 兜底的作用是"万一 `animationend` 没来（`prefers-reduced-motion` 下
 * 时长塌成 1ms 时某些 WebView 不补发），也要把场面收拾干净"。
 *
 * 但常数就成了**第二个真值来源**：
 *
 * ```text
 *   CSS 里 --nb-dur-nv 调到 800ms
 *   ⇒ 兜底还在 600ms 触发
 *   ⇒ 旧层在动画中途被删、data-nav 被摘
 *   ⇒ 用户看到旧层"啪"地消失，而样式表里查不出任何问题
 * ```
 *
 * 2026-11-05 取证时被这条绊住（把变量放到 5000ms 想抓中间帧，
 * 结果每张截图都是终态）—— 那次是探针环境，但机制在生产里一样会咬人。
 *
 * ## 为什么读 `getComputedStyle` 而不是读 CSS 变量
 *
 * 变量可能被继承/覆盖（`prefers-reduced-motion` 就是一个覆盖点），
 * 而**计算样式里的 `animationDuration` 才是浏览器真正在用的值**。
 * 读前者等于自己再推一遍继承链，多一处会分叉的逻辑。
 *
 * 读不到时退回 `FALLBACK_MS`：Node 里的 DOM stub 没有 `getComputedStyle`
 * （`test/*` 跑的就是那些 stub），不能让它们抛。
 */
const NAV_FALLBACK_MS = 600;
const NAV_EXTRA_MS = 200;

function animationBudgetMs(node: ElLike): number {
  const host = globalThis as {
    getComputedStyle?: (target: unknown) => { animationDuration?: string } | null;
  };
  if (typeof host.getComputedStyle !== 'function') return NAV_FALLBACK_MS;

  let raw = '';
  try {
    raw = host.getComputedStyle(node)?.animationDuration ?? '';
  } catch {
    return NAV_FALLBACK_MS;
  }

  /*
   * 可能是 `"0.26s"` / `"260ms"`，也可能是逗号分隔的多个值
   * （一个元素上挂两条动画时）。取第一个 —— 我们只挂了一条。
   */
  const first = raw.split(',')[0]?.trim() ?? '';
  let value = Number.NaN;
  if (first.endsWith('ms')) value = Number.parseFloat(first);
  else if (first.endsWith('s')) value = Number.parseFloat(first) * 1000;

  if (!Number.isFinite(value) || value <= 0) return NAV_FALLBACK_MS;
  /*
   * 加 200ms 余量：`animationend` 与 `setTimeout` 谁先到都行，
   * 但兜底不该**比动画还早**。`prefers-reduced-motion` 下 value 是 1ms，
   * 于是兜底 201ms —— 那也比 600ms 快，符合"减弱动画就该秒完"。
   */
  return value + NAV_EXTRA_MS;
}

