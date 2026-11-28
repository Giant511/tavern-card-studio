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
import { openExternal } from '../contract';
import { androidAbout, type AboutInfo } from '../settings/about-info.ts';
import { appVersion } from '../settings/app-version.ts';
import { readDefaultFaceBytes } from './default-face.ts';
import { clearThumbnailCacheFor, loadThumbnail } from './thumbnail.ts';
/* 引擎/崩溃取证：见 diagnostics/mobile-diag.ts 的文件头 */
import {
  buildDiagReport,
  clearDiagLog,
  diagNote,
  exportNativeLog,
  nativeStatus,
  readDiagEntries,
} from '../diagnostics/mobile-diag.ts';
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
import { readLocalCardFile, localCardId } from './card-import-local.ts';
import { faceFromImage, faceFromName, type CanvasDoc } from './card-face.ts';
import { runBusy } from './busy-button.ts';
import {
  CLOUD_REPO_HOST,
  buildOpeningMessages,
  buildPngCard,
  isPngBytes,
  parsePngCard,
  parseStCardText,
  planCardImport,
  convertEmbeddedWorldbook,
  readEmbeddedWorldbook,
  attachWorldToCard,
  resolveRepoOrigin,
  stringifyStCard,
  type ImportPlan,
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
  /* 本地地址（可能不需要 key）与公网地址要区别对待，见 writeApiConnectionToSt */
  isLocalEndpoint,
  verifyConnectionPersisted,
  activePersona,
  syncPersonaToCharacter,
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
  /* last_mes 是 ISO 字符串还是数字取决于文件空不空 —— 解析收在 shared */
  chatFileLastAt,
  chatFileCount,
  shouldStartNewChatFile,
  /* 聊天记录导出 TXT（v0.1.9） */
  chatToText,
  chatExportFileName,
  shouldSaveChat,
  type StChatMessage,
  type StSettings,
  /* 思考模式（2026-11-07，P0 第三步） */
  previewReasoningPlan,
  isSupportedChatSource,
  type ParamFamily,
  type ThinkingIntent,
  /* 角色级提示词覆盖（v0.2.0 主功能，见 PLAN §5） */
  parseCharacterPrompts,
  combineGlobalAndCharacter,
  writeCharacterPrompts,
  emptyCharacterPrompts,
  isCharacterPromptsEmpty,
  validateCharacterPrompts,
  setCharacterPromptEnabled,
  setCharacterPromptContent,
  clearOverride,
  upsertOwnPrompt,
  removeOwnPrompt,
  nextOwnPromptId,
  effectiveEnabled,
  ownIdentifierOf,
  type CharacterPromptConfig,
  type OwnPrompt,
} from '@tcs/shared';

/*
 * 仓库卡面可能是 webp，而 `buildPngCard` 只认 PNG 容器 ⇒ 下载导入前先转码。
 * 桌面端导出早就用这个函数了，这里是把同一条路接上（2026-11-11）。
 */
import { convertToPng } from '../export/face-convert.ts';

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

/*
 * 契约面搬到了 `shell-contract.ts`（2026-11-24）。
 *
 * 这里原样转出，所以既有 import 路径不变 —— `mobile/main.ts` 那句
 * `import { AppShell, type SavedChatSession } from '../chat/shell.ts'` 不用改。
 *
 * 为什么拆：`AppShell` 有 1 万行，而它的对外契约（22 个字段的 ShellOptions）
 * 混在文件中部，任何改契约的人都要先滚过半个文件（报告 P2-1）。
 */

export type { CardWriteResult, ShellOptions, SavedChatSession, TabId } from './shell-contract.ts';
import { makeFilesCallbacks } from './files-callbacks';
import { makeActionsCallbacks } from './actions-callbacks';
import { createRepoState, type RepoState } from './repo-state';
import {
  applyPersonaForCharacter,
  currentUserName,
  openPersonaSwitcher,
  personaContext,
  renderPersonaPage as renderPersonaPageAction,
  syncPersonaToChat,
  type PersonaHost,
} from './persona-actions';
import {
  deletePromptById,
  mutatePromptPreset,
  rebuildPromptConfig,
  refreshPromptTriggers,
  restoreCharacterPrompts,
  saveCharacterPromptDraft,
  saveCharacterPrompts,
  savePromptDraft,
  savePromptToggle,
  type PromptHost,
} from './prompt-actions';
import {
  apiSummary,
  deriveSampling,
  makePresetCallbacks,
  makeSettingsCallbacks,
  refreshKeyPresence,
  renderApiSection,
  renderDiagSection,
  writeApiConnectionToSt,
  type SettingsHost,
} from './settings-sections';
import {
  loadGreetingCharacters,
  renderGreeting,
  type GreetingHost,
} from './greeting-actions';
import {
  adoptLoadedCard,
  chatAvatar,
  importLocalCard,
  loadCharacterCard,
  loadCharacterCardWithRetry,
  resolveCardPlacement,
  writeCardPng,
  writeCardToLibrary,
  type CardHost,
} from './card-actions';
import {
  fetchRepoCards,
  loadRepoListQuietly,
  renderRepoCardPage as renderRepoCardPageAction,
  renderRepoCardsPage as renderRepoCardsPageAction,
  renderRepoPage as renderRepoPageAction,
  repoOrigin,
  type RepoHost,
} from './repo-actions';
import type { FilesHost } from './files-callbacks';
import type { ActionsHost } from './actions-callbacks';
import type { ChatSessionState } from './chat-session-state';
import { TABS } from './shell-contract.ts';
import type { CardWriteResult, ShellOptions, SavedChatSession, TabId } from './shell-contract.ts';

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
  /**
   * 上一次引擎连接状态（`null` = 还没试过）。
   *
   * 只用来决定"要不要往诊断日志里写一条" —— 每 2 秒一次的重试如果每次都记，
   * 环形日志（100 条）会被它一个人占满，真正有用的崩溃记录反而被挤掉。
   */
  private lastEngineState: 'ok' | 'fail' | null = null;

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
  /** 「诊断日志」展开状态（与 voice 同理：记在外壳，页面每次切 Tab 会重建） */
  private diagExpanded = false;
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
   *
   * ★★★ v0.2.0 起这是**合成结果**（全局预设 ⊕ 当前角色覆盖），不是磁盘上
   * 那份预设的裸解析结果。裸结果在 `globalPromptConfig`。
   * 谁想改全局那份，必须改 `globalPromptConfig` 再调 `rebuildPromptConfig()`
   * —— 直接写 `this.promptConfig` 会被下一次 `rebuildPromptConfig()` 冲掉。
   */
  private promptConfig: ParsedPromptConfig | null = null;

  /**
   * 全局预设解析出的配置（**不含**角色覆盖）。v0.2.0。
   *
   * 为什么必须与 `promptConfig` 分开存：
   *
   * ```text
   *   只有一个字段时，切角色要把"角色覆盖"叠上去 ⇒ 叠之前得先知道
   *   "哪部分是全局的"。而 `promptConfig` 已经被叠过一次了 ——
   *   从它反推全局值等于在猜。切回 A 角色就会带着 B 角色的改动。
   * ```
   *
   * 两个字段的写入方是**互斥**的：`globalPromptConfig` 只由"读预设"写，
   * `characterPrompts` 只由"读卡"写，`promptConfig` 只由
   * `rebuildPromptConfig()` 写。这样"切角色带上一个角色的改动"在结构上
   * 就不可能发生。
   */
  private globalPromptConfig: ParsedPromptConfig | null = null;

  /**
   * 当前角色的提示词覆盖（`data.extensions.tcs.prompts`）。v0.2.0。
   *
   * `null` = 这个角色没配过（绝大多数角色）⇒ 行为与 v0.1.10 完全一致。
   */
  private characterPrompts: CharacterPromptConfig | null = null;

  /**
   * 正在编辑的提示词 identifier（2026-11-07）。`null` = 新建。
   *
   * 只在 `chatSettingsRoute === 'promptEdit'` 时有意义。
   */
  private promptEditId: string | null = null;

  /**
   * 提示词页当前在改"谁的那一份"（v0.2.0）。
   *
   * 挂在**外壳**而不是页面里：页面每次切 Tab 都会重建，
   * 挂在闭包里等于"每次回来都跳回全局"—— 用户正在给某个角色调提示词，
   * 切出去看一眼聊天再回来就得重新点一次，而且**不知道跳回去了**。
   *
   * 与 §126 的仓库状态、§129 的缓存同一条纪律。
   */
  private promptScope: 'global' | 'character' = 'global';

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
   * 功能
   * 仓库页的全部可变状态（配置 / 登录态 / 连通性 / 三层列表缓存）。
   *
   * 注意事项
   * 19 个字段收进一个对象，不要再拆回散字段。
   * 把它整体传给 repo-actions.ts 的函数，那里会直接改 `cards` / `versions`
   * 这类数组字段 —— 所以在外部缓存子字段的引用会读到过期值。
   *
   * 踩过的坑
   * 这些字段原来散在本类 600–790 行之间，中间夹着卡片页与聊天页的字段。
   * 读一段仓库代码要上下翻几百行才知道共有几个状态，漏看一个就会把
   * 「这个标志位谁在写」判断错，进而改错刷新时机。
   * 详细逐字段说明见 repo-state.ts。
   */
  private repo: RepoState = createRepoState({
    config: readRepoConfig(),
    auth: { ...EMPTY_REPO_AUTH },
  });

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
  /**
   * 会话快照。
   *
   * ## `fileName` 为什么是 `string | null`（2026-11-15）
   *
   * 昨天为了避免类型报错，把"还没有文件名"写成了 **空串 `''`**。
   * 而空串在比较里等于"谁都不是"：
   *
   * ```ts
   *   if (snapshot.fileName === someId)   // 空串永远 false
   * ```
   *
   * 于是改名时"这段是不是当前打开的"判不出来 —— 而这个判断正是
   * 决定"要不要把指针改成新名字"的唯一依据。
   *
   * 用 `null` 表达"没有"，比较语义就干净了：`null === id` 也是 false，
   * 但读代码的人不会以为它是一个真实存在的名字。
   */
  private chatSnapshot: {
    fileName: string | null;
    messages: StChatMessage[];
    scrollTop?: number;
  } | null = null;

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
   * 正在为哪个角色恢复历史（`null` = 没在恢复）。
   *
   * `restoreLatestChat()` 是异步的，最长重试 60 秒。这段时间里
   * `chatFileName` 是 null，如果有人碰 `handleChatChanged`，就会
   * **新建一个空文件**并把历史挤掉（2026-11-14 用户报的那个）。
   *
   * 用一个字段而不是 await 等待：`handleChatChanged` 是面板的同步回调，
   * 改成异步会把整条消息路径搅乱。
   */
  private restoringAvatar: string | null = null;

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
    /*
     * ★★★ 把版本号写进全局，供诊断导出读取（2026-11-22）。
     *
     * ## 为什么必须在这里写
     *
     * `diagnostics/mobile-diag.ts` 的 `readVersionTag()` 读
     * `globalThis.__TCS_VERSION__`，而在此之前**全仓库没有地方给它赋值** ——
     * 于是用户导出的诊断日志头部永远是 `版本：unknown`。
     *
     * 那行恰恰是我判断"装的是哪个构建"的唯一依据。这轮排查里它就是
     * unknown，我只能去数日志里有哪些诊断行反推，还差点反推错
     * （把"装的是上一版"误判成"修复没生效"）。
     *
     * ## 为什么不直接在 mobile-diag 里 import 版本模块
     *
     * `settings/app-version.ts` 会 `import package.json`，那靠 Vite 内联；
     * 而 Node ESM 要求 JSON import 带 `with { type: 'json' }`，
     * 一 import 就让引入它的 DOM 判据整体崩（`ERR_IMPORT_ATTRIBUTE_MISSING`）。
     * 在入口写全局，两边的约束都满足。
     */
    (globalThis as { __TCS_VERSION__?: string }).__TCS_VERSION__ = appVersion();

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
      ...(this.repo.config.ackedPlainOrigin === '' ? [] : [this.repo.config.ackedPlainOrigin]),
      ...this.repo.config.trustedCertOrigins,
    ]);
    this.insecureOrigins = [
      ...(this.repo.config.ackedPlainOrigin === '' ? [] : [this.repo.config.ackedPlainOrigin]),
      ...this.repo.config.trustedCertOrigins,
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
     * `this.repo.config`，而字段初始化顺序不保证它已经就位。
     */
    this.repo.auth = readRepoAuthFor(repoOrigin(this.repoHost()) ?? '');
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
      /*
       * 冷启动也要对齐（2026-11-11）：上次退出时的人设可能是另一个角色绑的，
       * 而当前恢复出来的角色有自己的人设。不对齐的话，用户重进 App
       * 看到的就是"上一个人设"。
       */
      applyPersonaForCharacter(this.personaHost(), saved.avatar);
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
          /*
           * ★ 用带重试版（2026-11-11）：冷启动这一刻引擎几乎肯定还没起。
           * 原来读一次失败就置空 ⇒ 开场白永久缺失，只有"进去保存一下"
           * 才会被 `refreshOpeningAfterEdit` 救回来。
           */
          const gotCard = await loadCharacterCardWithRetry(this.cardHost(), avatar);
          /*
           * 卡一到就重绘 —— **不等历史**。
           *
           * `restoreLatestChat` 找不到历史时会重试到 60 秒超时；把重绘
           * 排在它后面，用户要对着没有开场白的空屏等一分钟。
           * 而这个词条的开场白只需要卡，不需要历史。
           *
           * 判一次"用户还在这个角色上"：这期间他可能切走了。
           */
          if (gotCard && this.selectedCharacter?.avatar === avatar) this.renderPage();
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
      this.renderImportAction(),
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
          void loadGreetingCharacters(this.greetingHost());
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
   * 「从手机导入卡片」这一行（v0.1.8）。
   *
   * ## 为什么放在卡片 Tab、且排在最前
   *
   * 三个理由：
   *
   * ```text
   *   ① 卡片 Tab 是"卡资产"的归属地，导入属于这一类
   *   ② 空角色库时它会是最需要的动作 —— 没有卡，下面三条都无从下手
   *   ③ 它不依赖登录（仓库页的上传要登录，语义还相反）
   * ```
   *
   * ## 为什么不做成 accordion
   *
   * 它是个**动作**，不是可展开的分组。accordion 还得配一个空面板，
   * 点开之后什么都不显示，反而让人以为坏了。
   *
   * ## 为什么文字由 `runBusy` 直接接管
   *
   * 按钮里没有子元素：`runBusy` 用 `textContent` 换文案，
   * 有子元素的话会被整块覆盖掉。所以标题与说明分成两行 ——
   * 按钮自己一行（三态文案），说明另起一行 `nb-note`。
   */
  private renderImportAction(): ElLike {
    const wrap = el(this.doc, 'div', 'nb-section');

    const button = el(this.doc, 'button', 'nb-listitem');
    button.setAttribute('type', 'button');
    button.setAttribute('data-role', 'card-import-entry');
    button.setAttribute('data-state', 'idle');
    button.textContent = '从手机导入卡片';
    button.addEventListener('click', () => {
      void importLocalCard(this.cardHost(), button);
    });

    const note = el(this.doc, 'p', 'nb-note');
    note.textContent = 'PNG 卡或 JSON 卡。TXT 请在桌面端导入。';

    wrap.append(button, note);
    return wrap;
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
          ...this.repo.config,
          trustedCertOrigins: [...this.repo.config.trustedCertOrigins, origin],
        };
        try {
          await writeRepoConfig(nextConfig);
          this.repo.config = nextConfig;
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


  /** 前端仓库请求：遇到 401 自动用 refresh token 续期并重试一次 */


  /** 这个错误是不是"令牌不被接受"（401） */


  /**
   * 令牌真的续不了（refresh token 也过期 / 被吊销）时给用户看的错误。
   *
   * ★ 不能把服务端原话「缺少或无效的访问令牌」直接丢给用户：
   *   那句话只描述现象，且暗示"我明明是登录状态"（用户截图里就是这样，
   *   界面上「已登录：Gez」和这句话同时出现，等于自相矛盾）。
   *
   *   用户读到的必须是**下一步能做什么**。
   */


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


  /** 给页面用的状态摘要 */


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


  /** 同步层要的配置。未登录时 token 为空串（服务端会 401，由调用方转成人话） */


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
   * `token` 是值拷贝。续期后 `this.repo.auth` 换了新 token，但闭包里
   * 那份旧值不会变 —— 直接重试还是 401，等于没续。
   */


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


  /**
   * 用一份**页面刚给出的**配置连接并登录。
   *
   * 为什么要带 config：用户可能是"刚改完地址就点登录"，
   * 那时外壳手里还是上一次保存的地址。不带就会打到旧地址上。
   */


  /** 注册。成功后**自动登录**（用户要求） */


  /** 仓库主页面（服务端配置 + 账户 + 卡片，一页到底） */


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


  /**
   * 三级：某张卡的历史与操作。
   *
   * 用户：
   *
   * > 点击对应卡片进入卡片历史界面，可以看到卡片的详情，下载、设为最新、
   * > 编辑（做按键入口但是文字变灰不生效，这是下个版本的内容）、删除、设为最新
   */


  /** 拉二级的卡片（按 repoId 过滤） */


  /** 拉三级的版本列表 */


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


  /** 二级：进页面时拉卡片 */


  /**
   * 静默刷新二级（退回到列表时用）。
   *
   * 与 `loadRepoCards` 的区别：**失败不清空已显示的内容** ——
   * 用户退回来是想看那张列表，后台刷新失败不该把它变成一条错误。
   */
  private async refreshCardsQuietly(repoId: string): Promise<void> {
    try {
      const rows = await fetchRepoCards(this.repoHost());
      if (this.repo.repoId !== repoId || this.repo.cardId !== null) return;
      this.repo.cardsState = rows;
      this.renderPage();
    } catch {
      /* 静默：保留当前列表 */
    }
  }

  /** 静默刷新一级的仓库列表（卡数会变） */


  /** 三级：进页面时拉版本 */


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


  /**
   * 上一次世界书落地失败的原因（空串 = 没失败 / 没尝试）。
   *
   * 只有一条用途：导入完成后如实告诉用户"书没进来，因为……"。
   * 不用返回值是因为 `persistEmbeddedWorldbook` 的返回类型已经被
   * "世界书名"占用了（`null` 同时表示"没有书"和"失败"，分不开）。
   */
  private lastWorldbookFailure = '';

  /**
   * 现有世界书的名字列表。
   *
   * ★ 三态：`string[]` = 读到了（可能是空表）；`null` = **读失败**。
   *   调用方必须区分 —— 把失败当空表会静默覆盖别人的书（见调用处注释）。
   */


  /**
   * 下载某一版（把"导入成新卡"那条既有逻辑暴露给三级页面）。
   *
   * 为什么用字段而不是直接把逻辑搬进 `renderRepoCardPage` 的回调：
   * 那段逻辑在 `renderRepoPage` 的回调闭包里，而三级页面是另一个函数。
   * 用字段引用等于"它跟着页面渲染就绪" —— 没就绪时给一句人话。
   */

  /**
   * 把仓库里的某一版下载成手机上的一张新卡（2026-11-06 从回调提成方法）。
   *
   * 提出来只为一件事：**三级页面（卡片历史）也要调它**。
   * 它原来写在 `renderRepoPage` 的回调闭包里，三级页面是另一个渲染函数，
   * 拿不到那个闭包。把逻辑复制一份更糟 —— 两处会分叉。
   *
   * v0.1.8 起落盘那段抽成 `resolveCardPlacement` + `writeCardToLibrary`，
   * 给本地卡导入共用；这里只剩"取原文 + 给底图"。
   */
  /**
   * 拉仓库里某张卡的**卡面字节**（下载导入时当 PNG 底图用）。
   *
   * 与 `loadCardFace` 的区别：
   *
   * ```text
   *   loadCardFace         → data URL，给 <img> 画缩略图（列表装饰）
   *   fetchRepoFaceForImport → 原始字节，给 buildPngCard 当容器
   * ```
   *
   * 两者都要原始响应，但消费方式不同，所以分开放 —— 让一个函数同时
   * 服务"画图"和"嵌卡"会导致其中一方拿到多余的格式转换。
   *
   * 失败/没有卡面一律返回 `null`：**没有背景是正常状态**（不是所有卡都配了图），
   * 不该抛错让下载整体失败。
   */




  /**
   * 决定这张卡落到哪个文件名、要不要覆盖（v0.1.8 从 `importRepoVersion` 抽出）。
   *
   * 两条路共用：仓库下载与本地导入。差别只有一个 ——
   * 本地导入要在"会覆盖"时**先问一句**（`confirmOverwrite`）。
   *
   * 为什么不把整个导入做成一个函数：本地导入的按钮要显示三态，
   * 而"用户在对话框上点取消"不该被当成"导入成功"（按钮会撒谎说已导入）。
   * 所以把「落名 + 确认」放在按钮进入忙碌之前，写入才包进 `runBusy`。
   *
   * @returns `null` = 用户在覆盖确认里取消
   */


  /**
   * 把规划好的卡真正写进角色库（世界书 → 建 PNG → 原子落盘）。
   *
   * 顺序不能换：卡里要写 `extensions.world = <书名>`，书名得先定下来。
   * 反过来（先写卡再写世界书）中途失败会留下"卡指向不存在的书"的坏状态。
   */


  /**
   * 从手机里选一个文件导入成卡片（v0.1.8）。
   *
   * 支持 PNG 卡与 JSON 卡。TXT 明确不做：桌面端的 TXT 是**带板块标记的自有格式**，
   * 手机上没有那套解析，任意 TXT 导进来只会得到空卡 —— 比不给入口更糟。
   *
   * 按钮状态刻意分两段：选文件与覆盖确认期间按钮**保持空闲**
   * （用户在答对话框，不是在等按钮）；只有真正写盘那段才进忙碌态。
   */


  /**
   * 弹一个选文件框，读成字节（v0.1.8）。
   *
   * ## 为什么用 `<input type="file">` 而不是新加 Rust 命令
   *
   * WebView 的 `onShowFileChooser` 在本项目已经在用（世界书导入、头像上传），
   * 而 `<input>` 拿到的 `File` 直接能 `arrayBuffer()`，不需要 `content://` 解码。
   *
   * ★ `input.click()` 必须发生在**用户手势的同步链路里**，否则 WebView 会拒绝弹框。
   * 所以本函数从调用到 `click()` 之间不能有 `await`。
   *
   * ## 为什么 accept 是参数
   *
   * 导入卡片要 png/json，换封面要 image/*。两处只差这一个字符串，
   * 其余（隐藏 input、change/cancel 双保险、60 秒超时、remove）完全一样。
   * 复制一份的话，将来修超时或修 remove 就会漏一处。
   *
   * @returns `null` = 用户取消（含 60 秒无操作）
   */


  /**
   * 问一句「要不要给这张卡配封面」（v0.1.8）。
   *
   * 只在**导入 JSON 卡**时问 —— PNG 卡自带图，没什么可问的。
   *
   * 三个出口，语义分清楚：
   *
   * ```text
   *   pick     从相册选一张
   *   default  按卡名生成（不打扰用户，但也不是"没有封面"）
   *   cancel   这次不导了
   * ```
   *
   * 「取消」必须显式给一个按钮，不能只靠点遮罩：
   * 用户在思考"要不要配图"时误触遮罩，会以为导入已经开始了。
   */


  /**
   * 选一张图当封面，缩到 512×512（v0.1.8）。
   *
   * 缩图的理由与桌面端 `renderSquare` 同源：卡片封面比例五花八门
   * （768×1024 最常见），直接塞进 PNG 容器会在圆形头像里被切成椭圆。
   *
   * @returns `null` = 用户取消选图，或这张图读不出来（已提示）
   */


  /**
   * 覆盖前确认（v0.1.8）。
   *
   * 挂到 `this.root` 而不是 `pageHost`：`.nb-exit-overlay` 是 `position: fixed`，
   * 挂在页面层里会被层的 `transform` 变成"相对层定位"（§121 同一个坑），
   * 而且换页时会被连带删掉 —— 那样这个 Promise 永远不 resolve，导入就卡死。
   */




  /* ═══════════════════════════════════════════════════════════
     开场与示例（2026-11-05，用户决定 1 + 2 + 5）
     ═══════════════════════════════════════════════════════════ */

  /** 渲染这一页（数据全在 `this.greetingState`，页面是纯视图） */


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


  /** 当前正在聊的角色（avatar）；没有就是 null */


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


  /**
   * 收下一张卡的 `data` 段 —— **并且连带解析它带的角色级提示词**。
   *
   * ## 为什么收卡必须走这一个入口
   *
   * v0.2.0 之前 `this.loadedCard = ...` 在本文件里出现了 4 次（读卡成功、
   * PNG 不是卡、JSON 不是对象、catch）。角色提示词也要跟着卡一起换，
   * 如果另外在"成功"那一支单独写一行，**失败的三支就会把上一个角色的
   * 提示词留在原地** ——
   *
   * ```text
   *   切到角色 B（读卡失败）→ characterPrompts 还是 A 的
   *                        → B 的对话按 A 的提示词发出去
   * ```
   *
   * 而这个错误**在界面上完全看不出来**：B 的卡是空的（引擎没起），
   * 用户只会觉得"模型怎么怪怪的"。所以把"收卡"与"清提示词"绑成一件事，
   * 让漏掉其中一半在结构上不可能。
   */


  /**
   * 重算"最终生效"的提示词配置，并推给面板。**唯一写 `promptConfig` 的地方**。
   *
   * ## 为什么要一个单独的方法
   *
   * 生效配置有两个来源（全局预设、当前角色），任何一个变了都要重算。
   * 让每个变化点各自拼一遍的后果本项目已经踩过四次（同一个事实两处表示）：
   * 某处忘了叠角色覆盖 ⇒ "改了角色提示词没生效"；某处忘了用全局
   * ⇒ "切回别的角色还带着上一个角色的改动"。集中在这里，两处只管
   * 各写自己的字段。
   *
   * ## 为什么顺带 `setContext`
   *
   * 面板手上的配置是**推**过去的，不推就一直是旧的。而"重算完忘了推"
   * 正是本项目最反复的缺陷类型（实现存在、接在错的函数里）。
   * `setContext` 是浅合并语义，只推 `promptConfig` 不会清掉其它字段。
   */


  /* ═══════════════════════════════════════════════════════════
     角色级提示词：写回卡片（v0.2.0 第 2 步）
     ═══════════════════════════════════════════════════════════ */

  /**
   * 改当前角色的提示词配置，并**写回卡片 PNG**。
   *
   * ## 为什么"读-改-写"每次都重读 PNG
   *
   * 不用内存副本（`loadedCard` / 缓存字节）的理由：
   *
   * ```text
   *   用户可能在 ST 网页里刚改过这张卡（改人设、加世界书条目）
   *   此时内存副本是旧的 ⇒ 用旧副本当基底写回 = 把用户刚做的改动抹掉
   *   —— 而那是**不可逆**的（PNG 里的旧版本已经没了）
   * ```
   *
   * 读一次本地 PNG 是毫秒级，而这个操作是低频的（点一次开关）。
   * 用"多一次 IO"换"绝不覆盖别人刚写的"，这个交换划算。
   *
   * ## 与「保存开场白」用同一套序列化规则
   *
   * `stringifyStCard` + `buildPngCard` + `writeCharacterPng`，三处完全一致。
   * 自己另写一条的话，两条写卡路径会产出形态不同的卡（一条补世界书
   * `comment`、一条不补），而用户看不出差别，只会在导进 ST 时发现某条
   * 标题是空的。
   *
   * ## 超限拒绝，不截断
   *
   * 截断的 JSON 之后会在更莫名的地方炸（PLAN §5.6）。而且用户根本不知道
   * 自己被截了什么 —— 所以在这里挡住，把具体数字报给他。
   *
   * @param mutate 拿到当前配置返回新配置。传空配置 = 从零开始
   */


  /**
   * 「恢复卡片默认」：把这个角色的提示词配置整个清空。
   *
   * ## 为什么这个操作必须能撤回思考成本
   *
   * 恢复 = 删掉 `extensions.tcs.prompts`。用户的改动和卡作者写的那份
   * **存在同一个位置**，所以删掉之后连卡作者原版的也读不回来。
   * 因此 UI 侧要做两步确认（与「删除聊天文件」同一套手势，不用
   * 阻塞式 `confirm()` —— 它在 Android WebView 里会冻住主线程）。
   *
   * 这里不再问第二遍：确认属于 UI 的职责，重复问只会让人烦。
   */


  /**
   * 读角色卡，**读不到就重试**。
   *
   * ## ★★★ 为什么必须重试（2026-11-11，用户报的）
   *
   * > 安装后的第一次切换聊天角色不会自动加载开场白，需要进去保存一下才行
   *
   * "安装后的第一次"是关键字 —— 那是**引擎最慢**的时候（真机首启实测 7–57 秒）。
   *
   * 原来的时序：
   *
   * ```text
   *   切角色 → renderPage()（空卡，面板没有开场白）
   *          → loadCharacterCard()   ← 引擎没起，catch 里静默置空，**不重试**
   *          → restoreLatestChat()   ← 有重试，但救不了已经空掉的卡
   *          → renderPage()          ← 空卡再渲染一次，还是没开场白
   * ```
   *
   * 而 `restoreLatestChat` 每轮重试前都会 `ensureConnected()` —— 也就是说
   * **等引擎就绪的那套机制是有的，只是没用在读卡上**。
   *
   * 结果：开场白永久为空，直到用户进「开场与示例」点保存
   * （`refreshOpeningAfterEdit` 会重读一次卡，那时引擎早就起来了）。
   * 这完全对得上"需要进去保存一下才行"。
   *
   * ## 为什么返回 boolean 而不是抛错
   *
   * 调用方要区分"读到了（可以重绘了）"和"放弃了（别再等）"。
   * 抛错会让每个调用点都写 try/catch，而这里失败**不是异常情况** ——
   * 引擎还没起是正常时序。
   */


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


  /** 当前该用的用户名：选中的人设优先，否则用外部传入的默认名 */


  /**
   * 把当前人设对齐到"这个角色该用的那套"并落盘。
   *
   * 抽成一个方法而不是在两处各写一遍：切角色与冷启动恢复必须走同一套规则，
   * 各写一遍必然分叉（而分叉的表现就是"切角色生效、重进 App 不生效"这种）。
   */


  /**
   * 把人设的当前状态推给聊天面板。
   *
   * 三样东西要一起推，缺一样就会出现"改了没生效"：
   * - `userName` → `{{user}}` 替换
   * - `persona.description` → 上下文里"你是谁"那段
   * - `persona.position` → 那段插到哪
   */

  /**
   * 人设对应的 ctx 片段。
   *
   * 抽出来是为了让"首次创建面板"和"改完人设推更新"用**同一份**逻辑 ——
   * 各写一遍必然分叉，而分叉的表现是"重启后生效、改完不生效"这类
   * 只在特定路径出现的怪现象。
   */




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
         * ★★★ 换角色 ⇒ 人设跟着换（2026-11-11）。
         *
         * 用户报的三条其实是一件事：
         *
         * ```text
         *   · 角色绑定了人设，聊天里不自动用它
         *   · 切角色后显示的还是上一个角色绑的人设
         *   · 想手动选又提示"还没有人设"（因为当前那套明确绑了别人）
         *   · 只能去人设页点「使用」，而那一按全局生效、影响所有角色
         * ```
         *
         * 根因：`personaState.selectedId` 是**全局唯一**的，切角色时没人动它，
         * 于是新角色继续用旧人设；而 `personasForCharacter` 又因为
         * "当前这套绑的是别人"把它筛掉了 ⇒ 界面显示"还没有人设"。
         *
         * `syncPersonaToCharacter` 按"绑定优先、默认兜底"重新对齐 ——
         * 用户不用再每次手动点「使用」。
         */
        applyPersonaForCharacter(this.personaHost(), character.avatar);

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
        /*
         * ★★★ 旧角色的卡也必须丢掉（2026-11-11，用户报"两个角色开场白一样"）。
         *
         * ## 不清会怎样
         *
         * 紧接着的 `renderPage()` 是**同步**的，此刻 `loadedCard` 里还是
         * 上一个角色的卡。而面板在没有快照时走 `newChat()`：
         *
         * ```ts
         *   this.messages = buildOpeningMessages(this.ctx.card);   // ← 旧卡！
         *   if (this.messages.length > 0) onChatChanged(messages);
         * ```
         *
         * 于是**旧角色的开场白被建了出来**，并通过 `onChatChanged` →
         * `handleChatChanged` 把 `chatSnapshot` 又填上了。
         *
         * 等新卡加载完、第二次 `renderPage()` 时：
         *
         * ```text
         *   chatSnapshot !== null  ⇒ 走快照分支
         *   ⇒ 显示的是**上一个角色的开场白**
         * ```
         *
         * 用户看到的正是这个：切两个不同角色，聊天页的开场白一模一样。
         *
         * ## 为什么清空是安全的
         *
         * ```text
         *   ① 移动端 options.card 是 {}，退回空卡 ⇒ 开场白为空 ⇒ 不触发
         *      onChatChanged ⇒ chatSnapshot 保持 null ⇒ 第二次渲染会重建
         *   ② 清空后到新卡到位之间的窗口，若用户发消息会用空卡 ——
         *      但那比"用上一个角色的设定发消息"安全得多（现状就是后者）
         * ```
         *
         * ★ v0.2.0：走 `adoptLoadedCard({})` 而不是直接赋 `{}` ——
         *   上一个角色留在 `characterPrompts` 里的覆盖必须一起清掉。
         *   否则"点角色 B → 卡还没到 → 发一条消息"会按 A 的提示词发。
         */
        adoptLoadedCard(this.cardHost(), {});

        /* ① 立即跳（不 await） */
        this.renderPage();
        resolve?.(null);

        /* ② 后台补内容 */
        void (async () => {
          try {
            /*
             * ★ 带重试 + 读到就重绘（2026-11-11）。
             *
             * 用户报的正是这条路：**安装后第一次切角色没开场白**。
             * 首启时引擎要 7–57 秒才就绪，而原来读卡只试一次、失败即空，
             * 再也没人重读 —— 直到用户进「开场与示例」保存了一次。
             */
            const gotCard = await loadCharacterCardWithRetry(this.cardHost(), character.avatar);
            if (gotCard && this.selectedCharacter?.avatar === character.avatar) {
              this.renderPage();
            }
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
     * ## ★★★ 这里必须 force（2026-11-16 用户报的真缺陷）
     *
     * 原来这里有一句 `if (this.shareCache.has(item.avatar)) continue` ——
     * 配合 `prefetchForShare` 内部同样的早退，效果是**缓存永不刷新**。
     *
     * ```text
     *   进卡片列表（缓存旧卡）→ 回聊天加提示词（写卡成功）→ 回卡片列表
     *   ⇒ 两个 has 判断都跳过 ⇒ 导出的是**加提示词之前**的字节
     *   ⇒ 用户导出的卡里没有提示词，导入回来也就没有
     * ```
     *
     * 改成 force 之后，每次进这一页都重读一遍。代价是每张卡一次本地读，
     * 而原来第一次进也要读同样的次数 —— 没有额外开销，只多几百毫秒。
     *
     * 逐张串行而不是并发：一张卡几百 KB，20 张并发会把 WebView 的内存
     * 顶起来（实测过 788 KB × N）。
     */
    void (async () => {
      try {
        const raw = await this.withConnection(() => this.bridge.listCharactersRaw());
        const parsed = parseCharacterList(raw);
        if (!parsed.ok) return;
        for (const item of parsed.items) {
          await this.prefetchForShare(item.avatar, true);
        }
      } catch {
        /* 预取失败不影响列表；用户点分享时会再试一次并给出原因 */
      }
    })();
  }

  /**
   * 把 PNG **写到角色库**，并让分享缓存失效。**所有写卡都必须走这里**。
   *
   * ## ★★★ 为什么必须收口（2026-11-16 用户报的真缺陷）
   *
   * > 新增角色特有的提示词，重新导入后没有了
   *
   * 真因不是"导出丢字段"，而是**导出用的是旧字节**：
   *
   * ```text
   *   进「卡片」Tab → prefetchForShare 把每张卡的 PNG 缓存起来
   *   回聊天加提示词 → 写卡成功（磁盘已是新卡）
   *   再回「卡片」Tab → 预取里 `if (shareCache.has(avatar)) continue` 直接跳过
   *   点「导出并分享」→ 用的是**加提示词之前**那份字节
   *   ⇒ 导出的卡里没有 tcs.prompts，导入回来当然也没有
   * ```
   *
   * 而 `shareCache` 原来**没有任何一处清空** —— 一次 App 生命周期内，
   * 只要进过一次卡片列表，之后所有导出都是那一刻的旧卡。
   *
   * 本项目已有的三处写卡（导入 / 存开场白 / 存提示词）此前各自直接调
   * `bridge.writeCharacterPng`，谁也没想到要清缓存。收口之后，
   * **新增第四处写卡也不可能漏** —— 这比"记得在每个地方补一行"可靠。
   */


  /**
   * 预取一张卡的 PNG 字节到分享缓存（失败就清掉，下次重试）。
   *
   * @param force `true` = 缓存里有也重读。
   *   进入「卡片」列表时**必须**用 force：用户可能刚在别的页面改过这张卡，
   *   而缓存里的字节是改之前的（见 `writeCardPng` 的注释）。
   */
  private async prefetchForShare(avatar: string, force = false): Promise<void> {
    if (!force && this.shareCache.has(avatar)) return;
    try {
      const bytes = await this.withConnection(() => this.bridge.characterPng(avatar));
      this.shareCache.set(avatar, new Uint8Array(bytes));
      /*
       * 记一条"这张卡里到底有没有角色级提示词"。
       *
       * 这条日志是为了下一次再出"提示词没了"时能**一眼分开两种原因**：
       *
       * ```text
       *   有提示词=no  ⇒ 卡本身就没写进去（写回失败）
       *   有提示词=yes ⇒ 卡里有，丢在导入/别的环节
       * ```
       *
       * 上一轮排查全靠推演，就是因为没有任何一条这样的日志。
       */
      const parsed = parsePngCard(new Uint8Array(bytes));
      if (parsed.kind === 'card') {
        const card = parseStCardText(parsed.jsonText);
        const ext = card.card.passthrough.data['extensions'];
        const prompts = parseCharacterPrompts(ext);
        const own = prompts?.own.length ?? 0;
        const over = prompts === null ? 0 : Object.keys(prompts.overrideOrder).length;
        diagNote(
          'note',
          `[分享] 取卡 avatar=${avatar} 有提示词=${prompts === null ? 'no' : 'yes'} own=${String(own)} override=${String(over)}`,
        );
      }
    } catch {
      this.shareCache.delete(avatar);
    }
  }

  /** 四项菜单 */
  private renderChatSettingsMenu(): void {
    if (this.pageHost === null) return;

    const page = renderChatSettingsMenu(this.doc, makeSettingsCallbacks(this.settingsHost()));
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

    const page = renderFieldSection(this.doc, groupId, makeSettingsCallbacks(this.settingsHost()));
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
        /* 状态**变了**才记 —— 每 2 秒调一次，每次都记会把日志刷爆 */
        if (this.lastEngineState !== 'ok') {
          this.lastEngineState = 'ok';
          diagNote('engine', `引擎已连上：${baseUrl}`);
        }
        return { ok: true };
      } catch (error) {
        // 见取舍 2：失败不置标记，下次还能重试
        this.connected = false;
        /*
         * ★ 引擎连不上要留痕（2026-11-12）。
         *
         * 用户报「过一段时间自动闪退」时，我完全不知道引擎当时是死是活 ——
         * 而这恰恰是最可能的变量。只在**状态变化**时记一条：
         *
         * ```text
         *   ok → fail     记（引擎掉了）
         *   fail → fail   不记（每 2 秒一次会刷爆环形日志）
         * ```
         */
        if (this.lastEngineState !== 'fail') {
          this.lastEngineState = 'fail';
          const detail = describeBridgeError(error).message;
          diagNote('engine', `引擎连不上（${baseUrl}）：${detail}`);
        }
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
   * 从 ST 设置派生采样参数。
   *
   * ## 为什么要有这一个统一入口
   *
   * `this.sampling` 有**多处**会从 ST 重新派生（播种、设置页保存、API 页保存）。
   * 各处各自调 `samplingFromSettings()` 会慢慢分叉 —— 统一走这里，
   * 以后要加新的派生规则只改一处。
   *
   * ## 为什么只认 ST，不再钉 App 侧的「最大回复长度」（2026-11-21）
   *
   * 原来这里会拿 `apiState.maxTokens` 覆盖派生值，因为它曾经是「API 连接」页
   * 那一格的来源。而那一格和「AI 响应配置」写的是同一个
   * `oai_settings.openai_max_tokens`，两处入口值不同时**前者赢**，
   * 用户没法判断哪个生效。
   *
   * 现在该键只由「AI 响应配置」读写，派生值就是唯一真相。
   */


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
         *
         * ★ v0.2.0：清的是 `globalPromptConfig`，角色覆盖**不动**
         *   （它跟着卡走，与预设无关）。`rebuildPromptConfig()` 会算出
         *   `null`（全局为空时角色配置整体不生效，见
         *   `combineGlobalAndCharacter` 的注释）。
         */
        this.globalPromptConfig = null;
        this.promptFormats = {};
        rebuildPromptConfig(this.promptHost());
        this.chatPanel?.setContext({ promptFormats: {} });
        return;
      }

      const config = parsePromptConfig(body);
      this.globalPromptConfig = config.prompts.length > 0 ? config : null;
      rebuildPromptConfig(this.promptHost());

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
       *
       * ★ v0.2.0：`promptConfig` 已由上面那句 `rebuildPromptConfig()`
       *   推过（它才是"全局 ⊕ 角色"的唯一出口），这里不再重复推 ——
       *   留两处写同一个字段，下次改其中一处就会被另一处悄悄回滚。
       */
      this.chatPanel?.setContext({
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

      this.sampling = deriveSampling(this.settingsHost(), parsed.settings);
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
    const page = renderChatActionsPage(this.doc, makeActionsCallbacks(this.actionsHost()));
    /* `renderPage()` 已经 `pageHost.replaceChildren()` 过，这里只 append */
    this.pageHost.append(page);
  }

  private renderChatFiles(): void {
    if (this.pageHost === null) return;
    const page = renderChatFilesPage(this.doc, makeFilesCallbacks(this.filesHost()));
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
      if (this.repo.cardId !== null) {
        return `repo/${this.repo.repoId ?? '-'}/${encodeURIComponent(this.repo.cardId)}`;
      }
      if (this.repo.repoId !== null) {
        return `repo/${encodeURIComponent(this.repo.repoId)}`;
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
        renderPersonaPageAction(this.personaHost());
        return;
      }
      if (this.greetingOpen) {
        renderGreeting(this.greetingHost());
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
    if (this.repo.cardId !== null) {
      renderRepoCardPageAction(this.repoHost());
      return;
    }
    if (this.repo.repoId !== null) {
      renderRepoCardsPageAction(this.repoHost());
      return;
    }
    renderRepoPageAction(this.repoHost());
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
      if (this.repo.cardId !== null) {
        this.repo.cardId = null;
        this.repo.cardTitle = '';
        this.repo.versionsState = null;
        this.repo.versionsError = '';
        this.renderPage();
        /*
         * 退回到列表时**重拉一次**：在三级里可能删过卡、回滚过（版本数会变）。
         * 不重拉的话列表还显示着已经不存在的那张卡，点进去必然 404。
         * 用 `quiet` 是因为列表已经画出来了，别闪成"正在读取"。
         */
        const repoId = this.repo.repoId;
        if (repoId !== null) void this.refreshCardsQuietly(repoId);
        return true;
      }
      if (this.repo.repoId !== null) {
        this.repo.repoId = null;
        this.repo.repoName = '';
        this.repo.cardsState = null;
        this.repo.cardsError = '';
        this.renderPage();
        /* 同上：卡数可能变了 */
        void loadRepoListQuietly(this.repoHost());
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


  /**
   * 提示词页（v0.2.0 起有两种作用域）。
   *
   * ## 为什么按作用域传不同的 config
   *
   * ```text
   *   全局     传 globalPromptConfig —— "这份预设本身长什么样"
   *   本角色   传 promptConfig（合成后）—— "这个角色实际发出去什么"
   * ```
   *
   * 不能两个作用域都传合成结果：那样「全局」里会显示角色 own 的条目，
   * 而用户在全局下改不到它们（它们只存在于卡里），点了等于没反应。
   *
   * 也不能两个都传全局：那样「本角色」里看不到角色特有的条目 ——
   * 而"这个角色到底发什么"正是用户切到这一档要回答的问题。
   */
  private renderChatPrompts(): void {
    if (this.pageHost === null) return;

    const characterName = this.selectedCharacter?.name ?? '';
    /*
     * 没选角色（或角色名拿不到）就不给角色作用域。
     * 同时把 scope 落回全局 —— 否则下次进来还挂着 `'character'`
     * 却画不出切换条，界面状态与字段值对不上。
     */
    const canUseCharacter = chatAvatar(this.cardHost()) !== null && characterName !== '';
    const scope = canUseCharacter ? this.promptScope : 'global';
    const config = scope === 'character' ? this.promptConfig : this.globalPromptConfig;

    const page = renderChatPromptsPage(this.doc, config, {      /*
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
      scope,
      ...(canUseCharacter
        ? {
            character: {
              characterName,
              config: this.characterPrompts ?? emptyCharacterPrompts(),
              onScopeChange: (next: 'global' | 'character') => {
                if (this.promptScope === next) return;
                this.promptScope = next;
                this.renderPage();
              },
              onRestoreOne: (identifier: string) =>
                saveCharacterPrompts(this.promptHost(), (current) => clearOverride(current, identifier)).then(
                  (result) => {
                    if (result.ok) this.renderPage();
                    return result;
                  },
                ),
              onRestoreAll: () => restoreCharacterPrompts(this.promptHost()),
            },
          }
        : {}),
      /*
       * 开关按作用域分流（v0.2.0）。
       *
       * 同一行、同一个勾选框，在「全局」下改预设、在「本角色」下改这张卡。
       * 界面上必须能看出区别 —— 靠上面的切换条与每行的「本角色已改」标记。
       */
      togglePrompt: (identifier, enabled) =>
        scope === 'character'
          ? saveCharacterPrompts(this.promptHost(), (current) => {
              /*
               * 需要"全局这一条现在是什么状态"才能判断"要不要留下覆盖"：
               * 与全局相同就删掉覆盖项（否则 `overrideOrder` 里会攒一堆
               * "恰好等于全局值"的条目，「已改」标记会全线误报）。
               */
              const globalEntry = this.globalPromptConfig?.order?.find(
                (one) => one.identifier === identifier,
              );
              const globalEnabled = globalEntry?.enabled ?? true;
              /*
               * 全局预设里根本没这一条（角色特有项）⇒ 改它自己的 `enabled`，
               * 不能走 `setCharacterPromptEnabled` —— 那个写的是 overrideOrder。
               */
              const ownIndex = current.own.findIndex(
                (one) => ownIdentifierOf(one) === identifier,
              );
              if (ownIndex >= 0) {
                const own = [...current.own];
                own[ownIndex] = { ...own[ownIndex], enabled } as OwnPrompt;
                return { ...current, own };
              }
              return setCharacterPromptEnabled(current, identifier, enabled, globalEnabled);
            })
          : savePromptToggle(this.promptHost(), identifier, enabled),
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
        void refreshPromptTriggers(this.promptHost());
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

    /*
     * 与列表页同一条规则（v0.2.0）：编辑页要显示**当前作用域那份**内容。
     *
     * ```text
     *   全局     显示预设原文（哪怕这个角色覆盖过正文）
     *   本角色   显示实际生效的正文（覆盖后的）
     * ```
     *
     * 用同一个 `promptConfig` 的话，在全局作用域下会显示角色覆盖过的正文，
     * 用户以为预设里就是那样 —— 然后在全局改一遍，反而把预设改掉了。
     */
    const config = this.promptScope === 'character' ? this.promptConfig : this.globalPromptConfig;
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

    /*
     * 角色作用域下编辑"全局预设里的那条" ⇒ 只能改正文（v0.2.0）。
     *
     * 判据是"当前作用域 + 这条不在角色的 own 里"。新建（`id === null`）
     * 不受影响 —— 那时建的是角色特有项，所有字段都有效。
     */
    const inCharacterScope = this.promptScope === 'character' && chatAvatar(this.cardHost()) !== null;
    const editingOwnPrompt =
      id !== null &&
      (this.characterPrompts?.own.some((one) => ownIdentifierOf(one) === id) ?? false);
    const contentOnly = inCharacterScope && id !== null && !editingOwnPrompt;

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
            ...(contentOnly ? { contentOnly: true } : {}),
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
      onSave: (draft) => savePromptDraft(this.promptHost(), target.identifier, draft),
      ...(target.identifier === null
        ? {}
        : { onDelete: () => deletePromptById(this.promptHost(), target.identifier as string) }),
      onNotify: (message, kind) => this.options.onNotify?.(message, kind),
    });
    this.pageHost.append(page);
  }

  /**
   * 保存（新建或编辑）一条提示词。
   *
   * ## 两个作用域，两条完全不同的写回路径（v0.2.0）
   *
   * ```text
   *   全局     改预设文件（POST /api/presets/save，整份写回）
   *   本角色   改这张卡（写 extensions.tcs.prompts，再写 PNG）
   * ```
   *
   * 分流放在这里而不是页面里：页面只负责"收集 draft"，它不需要知道
   * 存到哪。而"存到哪"如果由页面判断，将来加第三种作用域就要改页面，
   * 且两处判断必然分叉。
   */


  /**
   * 「本角色」作用域下保存一条提示词（v0.2.0）。
   *
   * ## 三种情况，三种写法
   *
   * ```text
   *   新建                → upsertOwnPrompt（角色特有，id 由 App 生成）
   *   编辑角色特有项       → upsertOwnPrompt（按 id 覆盖）
   *   编辑全局预设里的那条 → setCharacterPromptContent（正文覆盖）
   * ```
   *
   * ## 为什么编辑全局条目时**只写正文**
   *
   * 名称 / 身份 / 注入位置这些字段是"这条提示词怎么发"的描述，
   * 属于预设；角色级的差异只该是"这个角色想让它说什么"。
   * 让角色覆盖也改 name/role 会带来一个没人能解释的状态：
   * 同一个 identifier 在全局叫 A、在这个角色叫 B —— ST 网页里看到的是 A。
   *
   * 所以正文之外的字段在角色作用域下**按全局走**，编辑页里那几栏
   * 也应当只读（`kind: 'content-only'`）。这里若拿到不同的值，
   * 只取 content，其余静默忽略 —— 但要在返回的提示里说清楚。
   */


  /** 删除一条提示词 */


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


  /**
   * 打开指定的聊天文件。
   *
   * 复用 `chatPanel.loadChat()` 而不是自己走一遍 `loadChatRaw` + 解析 ——
   * 那条路里已经处理了三态判定（`missing`/`empty`/`malformed` 都不自动建聊天），
   * 另写一遍必然漏掉其中一种，而 `malformed` 漏掉的后果是
   * "用空历史覆盖真实文件"（save 是全量覆盖），不可逆。
   *
   * ## ★★★ 只在**真的读到了**才记文件名（2026-11-14）
   *
   * 原来这里无条件 `this.chatFileName = fileName`。而 `loadChat` 失败时
   * 面板内部已经把 `fileName` 置 null —— 于是**面板说没文件、外壳说有文件**。
   *
   * 真机上抓到的样子（vivo，`engine-8000.log`）：
   *
   * ```text
   *   File not found: …/威廉/新聊天 - 2026-11-14@19h57m46s.jsonl.
   *     The chat does not exist or is empty.
   * ```
   *
   * 那是「开始新聊天」先 write 一个空文件、再 load 它自己写的东西 ——
   * ST 把"空"和"不存在"报成同一句，于是刷一条看起来很吓人的 W。
   *
   * 现在失败就不记名字（保持 null），让用户的下一条消息按"新对话"处理，
   * 由 `shouldStartNewChatFile` 那道闸决定什么时候真的建档。
   */
  /**
   * 「聊天文件」页回调的接入点（实现在 `files-callbacks.ts`）。
   *
   * 13 个成员，就是那个模块能碰的全部状态与动作 —— 读这一个方法就知道
   * 「聊天文件」页依赖什么，不必翻 1 万行。
   *
   * 5 个字段用 get/set 成对转发（它们在回调里会被写：改名同步 fileName、
   * 删档清空 snapshot、返回上级清路由）。其余是只读依赖与方法。
   */
  /**
   * 功能
   * 「开场与示例」页的接入点。实现在 `greeting-actions.ts`。
   *
   * 注意事项
   * 四个 `greeting*` 字段双向转发：渲染改 state、保存后清 png/json、
   * changeFlag 每次渲染前重算。少一个 setter 就成「改完看着没改」。
   *
   * 踩过的坑
   * 无。
   */
  private greetingHost(): GreetingHost {
    const self = this;
    return {
      get doc() { return self.doc; },
      get pageHost() { return self.pageHost; },
      get bridge() { return self.bridge; },
      get options() { return self.options; },
      get chatPanel() { return self.chatPanel; },
      get chatFileName() { return self.chatFileName; },
      get chatSnapshot() { return self.chatSnapshot; },
      set chatSnapshot(next) { self.chatSnapshot = next as typeof self.chatSnapshot; },
      get loadedCard() { return self.loadedCard; },
      get readEngineStatus() { return self.options.readEngineStatus; },
      get greetingState() { return self.greetingState; },
      set greetingState(next) { self.greetingState = next; },
      get greetingPng() { return self.greetingPng; },
      set greetingPng(next) { self.greetingPng = next; },
      get greetingJson() { return self.greetingJson; },
      set greetingJson(next) { self.greetingJson = next; },
      get greetingChangeFlag() { return self.greetingChangeFlag; },
      set greetingChangeFlag(next) { self.greetingChangeFlag = next; },
      get savedFlashTimer() { return self.savedFlashTimer; },
      set savedFlashTimer(next) { self.savedFlashTimer = next; },
      renderPage: () => self.renderPage(),
      goBackOneLevel: () => self.goBackOneLevel(),
      withConnection: (run) => self.withConnection(run),
      clearSavedFlashTimer: () => self.clearSavedFlashTimer(),
      paintSavedFlashOff: () => self.paintSavedFlashOff(),
      cardHost: () => self.cardHost(),
      handleChatChanged: (messages) => self.handleChatChanged(messages),
    };
  }

  /**
   * 功能
   * 设置页的接入点。实现在 `settings-sections.ts`。
   *
   * 注意事项
   * 14 个字段 + 8 个动作。字段几乎都双向：`apiKeyPresent` 探测后整体替换、
   * `pendingApiNotice` 显示完置 null、`lastSettingsFailure` 保存失败时写。
   *
   * 踩过的坑
   * `pendingApiNotice` 与 `lastSettingsFailure` 的类型是 `string | null` 而不是
   * `string`：空串会渲染出一个空提示框，用户看到一条没有内容的"错误"。
   */
  private settingsHost(): SettingsHost {
    const self = this;
    return {
      ...this.chatSessionState(),
      get doc() { return self.doc; },
      get bridge() { return self.bridge; },
      get options() { return self.options; },
      get chatPanel() { return self.chatPanel; },
      get apiExpanded() { return self.apiExpanded; },
      set apiExpanded(next) { self.apiExpanded = next; },
      get diagExpanded() { return self.diagExpanded; },
      set diagExpanded(next) { self.diagExpanded = next; },
      get apiState() { return self.apiState; },
      set apiState(next) { self.apiState = next; },
      get apiKeyPresent() { return self.apiKeyPresent; },
      set apiKeyPresent(next) { self.apiKeyPresent = next; },
      get pendingApiNotice() { return self.pendingApiNotice; },
      set pendingApiNotice(next) { self.pendingApiNotice = next; },
      get lastSettingsFailure() { return self.lastSettingsFailure; },
      set lastSettingsFailure(next) { self.lastSettingsFailure = next; },
      get sampling() { return self.sampling; },
      set sampling(next) { self.sampling = next; },
      get contextLimit() { return self.contextLimit; },
      set contextLimit(next) { self.contextLimit = next; },
      get responseLimit() { return self.responseLimit; },
      set responseLimit(next) { self.responseLimit = next; },
      get showReasoning() { return self.showReasoning; },
      set showReasoning(next) { self.showReasoning = next; },
      get thinkingBudget() { return self.thinkingBudget; },
      set thinkingBudget(next) { self.thinkingBudget = next; },
      get thinkingFamily() { return self.thinkingFamily; },
      set thinkingFamily(next) { self.thinkingFamily = next; },
      get thinkingIntent() { return self.thinkingIntent; },
      set thinkingIntent(next) { self.thinkingIntent = next; },
      get apiPageEl() { return self.apiPageEl; },
      set apiPageEl(next) { self.apiPageEl = next; },
      get globalPromptConfig() { return self.globalPromptConfig; },
      set globalPromptConfig(next) { self.globalPromptConfig = next; },
      get promptFormats() { return self.promptFormats; },
      set promptFormats(next) { self.promptFormats = next; },
      withConnection: (run) => self.withConnection(run),
      renderPage: () => self.renderPage(),
      goBackOneLevel: () => self.goBackOneLevel(),
      renderAccordion: (spec) => self.renderAccordion(spec),
      diagBoot: () => self.diagBoot(),
      rebuildPromptConfig: () => rebuildPromptConfig(self.promptHost()),
    };
  }

  /**
   * 功能
   * 「用户设定」的接入点。实现在 `persona-actions.ts`。
   *
   * 注意事项
   * `personaState` 双向（切角色与保存后都改），其余只读。
   *
   * 踩过的坑
   * 无。
   */
  private personaHost(): PersonaHost {
    const self = this;
    return {
      ...this.chatSessionState(),
      get doc() { return self.doc; },
      get pageHost() { return self.pageHost; },
      get bridge() { return self.bridge; },
      get options() { return self.options; },
      get chatPanel() { return self.chatPanel; },
      get personaState() { return self.personaState; },
      set personaState(next) { self.personaState = next; },
      withConnection: (run) => self.withConnection(run),
      renderPage: () => self.renderPage(),
      goBackOneLevel: () => self.goBackOneLevel(),
      persistChat: (messages, avatar) => self.persistChat(messages, avatar),
      cardHost: () => self.cardHost(),
    };
  }

  /**
   * 功能
   * 提示词编辑的接入点。实现在 `prompt-actions.ts`。
   *
   * 注意事项
   * 五个字段都是双向：改完要立刻生效（`promptConfig` 直接进请求体）。
   * `promptScope` / `promptEditId` 是编辑器状态，切作用域时要重置。
   *
   * 踩过的坑
   * `promptTriggers` 是 `Map` 不是数组 —— 按 identifier 查该条目的触发词。
   */
  private promptHost(): PromptHost {
    const self = this;
    return {
      ...this.chatSessionState(),
      get bridge() { return self.bridge; },
      get options() { return self.options; },
      get chatPanel() { return self.chatPanel; },
      get globalPromptConfig() { return self.globalPromptConfig; },
      set globalPromptConfig(next) { self.globalPromptConfig = next; },
      get characterPrompts() { return self.characterPrompts; },
      set characterPrompts(next) { self.characterPrompts = next; },
      get promptConfig() { return self.promptConfig; },
      set promptConfig(next) { self.promptConfig = next; },
      get promptTriggers() { return self.promptTriggers; },
      set promptTriggers(next) { self.promptTriggers = next; },
      get promptScope() { return self.promptScope; },
      set promptScope(next) { self.promptScope = next; },
      get promptEditId() { return self.promptEditId; },
      set promptEditId(next) { self.promptEditId = next; },
      get authorNote() { return self.authorNote; },
      set authorNote(next) { self.authorNote = next; },
      get readEngineStatus() { return self.options.readEngineStatus; },
      withConnection: (run) => self.withConnection(run),
      renderPage: () => self.renderPage(),
      cardHost: () => self.cardHost(),
    };
  }

  /**
   * 功能
   * 卡片页接入点。实现在 `card-actions.ts`。
   *
   * 注意事项
   * `lastWorldbookFailure` 与 `loadedCard` 用 get/set 双向转发 ——
   * 它们在壳外（聊天页、提示词页）也有读写点，不能只读。
   *
   * 踩过的坑
   * 无。
   */
  private cardHost(): CardHost {
    const self = this;
    return {
      get doc() {
        return self.doc;
      },
      get root() {
        return self.root;
      },
      get options() {
        return self.options;
      },
      get bridge() {
        return self.bridge;
      },
      get shareCache() {
        return self.shareCache;
      },
      get characterPrompts() {
        return self.characterPrompts;
      },
      set characterPrompts(next) {
        self.characterPrompts = next as typeof self.characterPrompts;
      },
      get selectedCharacter() {
        return self.selectedCharacter;
      },
      get readEngineStatus() {
        return self.options.readEngineStatus;
      },
      get lastWorldbookFailure() {
        return self.lastWorldbookFailure;
      },
      set lastWorldbookFailure(next) {
        self.lastWorldbookFailure = next;
      },
      get loadedCard() {
        return self.loadedCard;
      },
      set loadedCard(next) {
        self.loadedCard = next;
      },
      ensureConnected: async () => {
        await self.ensureConnected();
      },
      withConnection: (run) => self.withConnection(run),
      rebuildPromptConfig: () => rebuildPromptConfig(self.promptHost()),
    };
  }

  /**
   * 功能
   * 仓库页接入点。实现在 `repo-actions.ts`。
   *
   * 注意事项
   * `state` 是同一个对象而非副本，模块直接改它。不要在外部缓存
   * `state.cards` 这类子字段的引用 —— 模块会整体替换数组。
   *
   * 踩过的坑
   * 无。
   */
  private repoHost(): RepoHost {
    const self = this;
    return {
      get state() {
        return self.repo;
      },
      get doc() {
        return self.doc;
      },
      get pageHost() {
        return self.pageHost;
      },
      get bridge() {
        return self.bridge;
      },
      get options() {
        return self.options;
      },
      get insecureOrigins() {
        return self.insecureOrigins;
      },
      set insecureOrigins(next) {
        self.insecureOrigins = next;
      },
      withConnection: (run) => self.withConnection(run),
      withCertTrust: (origin, action) => self.withCertTrust(origin, action),
      renderPage: () => self.renderPage(),
      goBackOneLevel: () => self.goBackOneLevel(),
      resolveCardPlacement: (input) => resolveCardPlacement(self.cardHost(), input),
      writeCardToLibrary: (input) => writeCardToLibrary(self.cardHost(), input),
    };
  }

  /**
   * 功能
   * 把五个会话状态字段以 get/set 形式暴露出去，供各 `*Host` 展开复用。
   *
   * 注意事项
   * 返回的对象要用 `...` 展开进各个 host，不要逐字段抄写。
   * 字段本身仍由本类持有，这里只是转发，不要在外部缓存这个对象。
   *
   * 踩过的坑
   * files-callbacks 与 actions-callbacks 需要同样这五个字段。第一版在两处各写了
   * 一遍 get/set，共十组。漏一个 setter 不会报错：写入静默丢弃，症状是
   * 「改名成功但下次保存写回旧名」，要隔着几层才看得出来。
   */
  private chatSessionState(): ChatSessionState {
    const self = this;
    return {
      get selectedCharacter() {
        return self.selectedCharacter;
      },
      set selectedCharacter(next) {
        self.selectedCharacter = next;
      },
      get chatFileName() {
        return self.chatFileName;
      },
      set chatFileName(next) {
        self.chatFileName = next;
      },
      get chatSnapshot() {
        return self.chatSnapshot;
      },
      set chatSnapshot(next) {
        self.chatSnapshot = next;
      },
      get lastSavedFingerprint() {
        return self.lastSavedFingerprint;
      },
      set lastSavedFingerprint(next) {
        self.lastSavedFingerprint = next;
      },
      get chatSettingsRoute() {
        return self.chatSettingsRoute;
      },
      set chatSettingsRoute(next) {
        self.chatSettingsRoute = next;
      },
    };
  }

  /**
   * 功能
   * 「聊天操作」页回调的接入点。实现在 actions-callbacks.ts。
   *
   * 注意事项
   * 不要在这里放同名薄包装方法转发。包装要静态 import 那个模块，
   * 主 chunk 会把 206 行重新装回去。调用方直接拿这个 host 对象。
   *
   * 踩过的坑
   * 无。
   */
  private actionsHost(): ActionsHost {
    const self = this;
    return {
      ...this.chatSessionState(),
      get bridge() {
        return self.bridge;
      },
      get options() {
        return self.options;
      },
      get chatPanel() {
        return self.chatPanel;
      },
      hasOpenChat: () => self.hasOpenChat(),
      withConnection: (run) => self.withConnection(run),
      renderPage: () => self.renderPage(),
      persistSession: () => self.persistSession(),
      goBackOneLevel: () => self.goBackOneLevel(),
    };
  }

  private filesHost(): FilesHost {
    const self = this;
    return {
      ...this.chatSessionState(),
      get bridge() {
        return self.bridge;
      },
      get options() {
        return self.options;
      },
      withConnection: (run) => self.withConnection(run),
      openChatFile: (avatar, fileName) => self.openChatFile(avatar, fileName),
      persistSession: () => self.persistSession(),
      renderPage: () => self.renderPage(),
      goBackOneLevel: () => self.goBackOneLevel(),
      currentUserName: () => currentUserName(self.personaHost()),
    };
  }

  private async openChatFile(avatar: string, fileName: string): Promise<boolean> {
    const loaded = (await this.chatPanel?.loadChat(avatar, fileName)) ?? false;
    if (loaded) {
      this.chatFileName = fileName;
      this.persistSession();
    } else {
      /*
       * 读不到 ⇒ 指针保持"没有文件"。**不要**在这里把 selectedCharacter 清掉：
       * 用户还在这个角色的上下文里，只是这一段读不出来。
       */
      this.chatFileName = null;
      this.persistSession();
    }
    return loaded;
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
      /*
       * 面板的装配诊断接到 App 日志（2026-11-16）。
       *
       * 排查"提示词没生效"时，这一行是**唯一**能区分"没发出去"和
       * "发出去了但模型没听"的证据 —— 上一轮就是因为没有它，
       * 只能靠读代码推演，还推错了方向。
       */
      onDiag: (message) => diagNote('note', message),
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
        openPersonaSwitcher(this.personaHost(), anchor);
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
      userName: currentUserName(this.personaHost()),
      /*
       * 顶栏胶囊显示的名字（2026-11-06）。
       *
       * 与 `userName` 的差别：没选人设时 `userName` 是默认名，而这里是空串 ——
       * 面板会把空串退回 `userName`，所以"没选人设"时胶囊显示默认名而不是空白。
       */
      personaLabel: activePersona(this.personaState)?.name ?? '',
      /* 描述与插入位置也一起带上 —— 只带名字的话人设描述永远进不了上下文 */
      persona: personaContext(this.personaHost()),
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
        this.chatSnapshot.fileName ?? undefined,
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
    /*
     * ★★★★★ 标记"这个角色的历史还在读"（2026-11-14）。
     *
     * ## 不标记会怎样
     *
     * ```
     * 点角色 → chatFileName = null
     *        → 本函数开始异步读历史（可能重试到 60 秒）
     *        → 期间 applyOpening() 注入开场白 ⇒ handleChatChanged
     *        → 见 chatFileName 是 null ⇒ **新建一个空文件并落盘**
     *        → 新文件 mtime 最新 ⇒ 下次 findLatestChat 挑中它
     *        → 真正的历史从此打不开
     * ```
     *
     * 用户看到的正是"上午的记录没了"，而磁盘上那份 jsonl 还在。
     *
     * 标记期间 `handleChatChanged` 只更新快照、不建档不落盘。
     * 恢复成功后 `tryLoadInto` 会设好 `chatFileName`，之后再聊就正常写。
     *
     * `finally` 清标记：中途 return（换了角色、超时）也必须清，
     * 否则这个角色从此永远"恢复中"，新聊天再也存不下来。
     */
    this.restoringAvatar = avatar;
    const deadline = Date.now() + 60_000;
    try {
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

      /*
       * ★★★ 两轮：先用首选名，失败再自己找（2026-11-15）。
       *
       * ## 原来只有一轮，而且首选名失败会**一直重试那个坏名字**
       *
       * ```ts
       *   const latest = preferred ?? (await this.findLatestChat(avatar));
       *   if (latest !== null && (await this.tryLoadInto(avatar, latest))) return;
       *   // ↑ 失败就等 2 秒再来，`preferred` 还是那个不存在的名字
       * ```
       *
       * 后果：只要 localStorage 里的首选名失效（文件被改名/删除），
       * 就会**空转 60 秒**，然后放弃 ⇒ 界面空白 ⇒ 用户发一句话 ⇒
       * 建档成新文件 ⇒ 看起来"记录全没了"。
       *
       * 改名场景下这个坑必然触发：改名把旧名字的文件删了，而
       * localStorage 里还留着旧名字。
       *
       * ## 现在
       *
       * ```text
       *   首选名读成功      → 用它
       *   首选名读不到      → 立刻改成"从列表里找最新的"（不再空转）
       * ```
       *
       * 只在 `preferred` 与 `findLatestChat` 结果不同时才多一次尝试，
       * 所以正常情况下开销没变。
       */
      const tried: string[] = [];
      const first = preferred ?? (await this.findLatestChat(avatar));
      if (first !== null) {
        tried.push(first);
        const ok = await this.tryLoadInto(avatar, first);
        diagNote(
          'note',
          `[会话] 恢复首选 fileName=${first} 结果=${ok ? 'ok' : 'miss'} ` +
            `来源=${preferred === null ? 'findLatest' : 'preferred'}`,
        );
        if (ok) return;
      } else {
        diagNote('note', '[会话] 恢复：列表里没有可用的聊天文件');
      }

      /*
       * 首选名失效 ⇒ 换"列表里最新的那条"再试一次。
       *
       * 不重试同一个名字（那样只会空转到超时），但也不放弃 ——
       * 磁盘上很可能有一段完好的历史，只是名字对不上。
       */
      if (preferred !== null && preferred !== undefined) {
        const fallback = await this.findLatestChat(avatar);
        if (fallback !== null && !tried.includes(fallback)) {
          const ok = await this.tryLoadInto(avatar, fallback);
          diagNote(
            'note',
            `[会话] 恢复回退 fileName=${fallback} 结果=${ok ? 'ok' : 'miss'}`,
          );
          if (ok) return;
        }
      }

      /*
       * `findLatestChat` 返回 null 有两种含义：**真的没有历史**，
       * 或**请求失败**（引擎没起）。前者重试也没用，后者必须重试。
       * 这里无法区分，所以统一按"可能是引擎没起"重试到超时 ——
       * 代价只是没有历史的用户多轮询几次（每次一个 HTTP 请求，无副作用）。
       */
      if (Date.now() >= deadline) {
        diagNote('note', `[会话] 恢复放弃（超时）已试=${tried.join('|')}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } finally {
      /*
       * 只清自己设的标记：用户中途换了角色时，另一个
       * `restoreLatestChat` 可能已经把标记改成了新角色 ——
       * 无条件清空会放行旧角色的保存。
       */
      if (this.restoringAvatar === avatar) this.restoringAvatar = null;
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
      diagNote(
        'note',
        `[会话] 读回 ${latest} 条数=${String(parsed.messages.length)}` +
          ` 有user=${String(parsed.messages.some((one) => one.is_user === true))}`,
      );
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
    if (this.selectedCharacter === null) {
      /*
       * ★ 记一条（2026-11-15）。
       *
       * "没存上"和"存上了但没被用"在用户眼里一样，在我们眼里必须分开。
       * 用户报过两次"记录没了"，两次都因为**没有任何指针日志**而无法定案。
       */
      diagNote('note', '[会话] 未写入会话：还没选角色');
      return;
    }
    /*
     * ★★★ 每次落盘都记一行（2026-11-15）。
     *
     * ## 为什么要记
     *
     * 用户报「改名后记录没了」，我们能拿到的证据只有：
     *
     * ```text
     *   engine-8000.log  → 改名成功、之后没有任何报错
     *   app-001-.log     → 只有启动/退出，**没有一行提到指针指向谁**
     * ```
     *
     * 于是"重进时首选了哪个文件"这个**唯一关键事实**无从得知 ——
     * 只能靠推理（而推理已经错过一次）。
     *
     * 现在一行说清三件事：
     *
     * ```text
     *   avatar   哪个角色
     *   fileName 指针现在指向谁（null = 没有）
     *   hasSnap  快照在不在（区分"有指针没内容"与"两者都没有"）
     * ```
     */
    diagNote(
      'note',
      `[会话] 写入会话 avatar=${this.selectedCharacter.avatar} ` +
        `fileName=${this.chatFileName ?? 'null'} ` +
        `hasSnap=${this.chatSnapshot === null ? 'no' : 'yes'}`,
    );
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

      /*
       * ★★★★ 空壳文件不该被当成"最近的历史"（2026-11-14）。
       *
       * 修好时间解析之后还剩一个问题：**空壳文件的 mtime 确实更新**。
       *
       * ```text
       *   上午：真历史   last_mes = 08:00（ISO），chat_items = 88
       *   下午：空壳文件 mtimeMs   = 18:47（数字，刚被创建）
       *   ⇒ 按时间排，空壳仍然赢
       * ```
       *
       * 而"打开最近一次聊天"的用户期待是**接着上次聊**，不是打开一个空壳。
       * 所以分两轮：
       *
       * ```text
       *   第一轮  只在"有内容"的文件里选最新的
       *   第二轮  一个都没有（这个角色确实没聊过）才回退到全部
       * ```
       *
       * ## 为什么用 `hasCount` 而不是直接判 count === 0
       *
       * `chat_items` 是 ST 才给的字段。如果某个版本没给，`chatFileCount`
       * 返回 0 —— 直接跳过会导致**所有文件都被跳过**，用户看到空白。
       * 所以只有"确实读到了条数字段"的条目才参与"是否为空"的判断。
       */
      const rows: { id: string; at: number; count: number; hasCount: boolean }[] = [];
      for (const one of parsed) {
        if (one === null || typeof one !== 'object') continue;
        const info = one as Record<string, unknown>;
        const id = info['file_id'];
        if (typeof id !== 'string' || id === '') continue;
        /*
         * ★★★★★ 取时间必须用 shared 的 `chatFileLastAt()`（2026-11-14 修）。
         *
         * ## 原来这行是"记录打不开"的直接原因
         *
         * ```ts
         *   const at = typeof info['last_mes'] === 'number' ? info['last_mes'] : 0;
         * ```
         *
         * 而 ST 给 `last_mes` 的**类型取决于文件是否为空**：
         *
         * ```text
         *   非空文件  = "2026-11-11T19:30:00.000Z"   ISO 字符串 → at = 0
         *   空文件    = 1763107200000                number    → at = 1.7e12
         * ```
         *
         * 于是：
         *
         * ```text
         *   只要存在一个空文件  ⇒ 空文件恒赢 ⇒ 用户打开的是空的
         *   一个空文件都没有    ⇒ 全部 at=0 ⇒ `at > best.at` 永远假
         *                        ⇒ **恒返回列表第一个**，不管它多旧
         * ```
         *
         * 用户说的"打开都是同一个聊天记录"就是这个：不是每次都新建，
         * 而是**每次都挑中同一个**。而它多半是那个空壳文件 ——
         * 所以看着像"上午的记录没了"。
         */
        const at = chatFileLastAt(info);
        const count = chatFileCount(info);
        const hasCount = info['chat_items'] !== undefined || info['message_count'] !== undefined;
        rows.push({ id, at, count, hasCount });
      }

      const pick = (pool: typeof rows): string | null => {
        let best: { id: string; at: number } | null = null;
        for (const row of pool) {
          if (best === null || row.at > best.at) best = { id: row.id, at: row.at };
        }
        return best === null ? null : best.id;
      };

      /* 第一轮：只挑有内容的（`hasCount && count === 0` 明确是空文件） */
      const withContent = rows.filter((row) => !(row.hasCount && row.count === 0));
      const fromContent = pick(withContent);
      if (fromContent !== null) return fromContent;

      /* 第二轮：这个角色的文件全是空的（或都没有条数字段）—— 回退到全部 */
      return pick(rows);
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

    /*
     * ★★★★★ 恢复期间**一律不许写盘**（2026-11-15 第三修，这条才是真根因）。
     *
     * ## 冷启动的真实时序（每一句都有日志为证）
     *
     * ```text
     *   ① mount()：从 localStorage 恢复 selectedCharacter **和 chatFileName**
     *      ⇒ 此刻 chatFileName 已经有值（上次那个名字）
     *
     *   ② restoreLatestChat(avatar, preferred) 开始 —— 异步，设 restoringAvatar
     *
     *   ③ renderChat() 立刻执行：chatSnapshot 是 null（新进程）⇒ 走 newChat()
     *      ⇒ messages = 只有开场白 ⇒ onChatChanged
     *
     *   ④ handleChatChanged：
     *      chatFileName **不是 null** ⇒ 跳过全部闸门
     *      ⇒ persistChat(只有开场白) ⇒ ST 的 save 是**整份覆盖**
     *      ⇒ **真实历史被"开场白"冲掉**
     *
     *   ⑤ restoreLatestChat 读到文件 ⇒ 里面就剩开场白 ⇒ 报 "结果=ok"
     *      ⇒ 日志看起来一切正常，而记录已经没了
     * ```
     *
     * **每启动一次覆盖一次。** 这就是"记录没了"却"恢复 ok"的原因。
     *
     * ## 为什么原来那道闸挡不住
     *
     * 昨天的闸写在"还没有文件名"的分支里：
     *
     * ```ts
     *   if (this.chatFileName === null && avatar !== null) {
     *     const restoring = this.restoringAvatar === avatar;   // ← 只在这个分支判
     *     ...
     *   }
     *   if (this.chatFileName !== null) { …保存… }              // ← 有名字就直通
     * ```
     *
     * 它防的是"恢复期间建新文件"，**没防"恢复期间覆盖旧文件"** ——
     * 而后者才是丢数据的动作。判据当时也只盯了建档那一句。
     *
     * ## 现在：闸提到函数级
     *
     * ```text
     *   恢复中 ⇒ 只更新快照，**不建文件、不写盘、不改指针**
     * ```
     *
     * 快照仍要更新：否则这期间切 Tab 回来，开场白就没了（当场可见的退步）。
     * 但"屏幕上先显示开场白"和"磁盘上把历史覆盖成开场白"是两件完全不同的事。
     */
    const restoring = this.restoringAvatar === avatar;
    if (restoring && avatar !== null) {
      /*
       * ★ 恢复期间用户开口了 ⇒ 记一条（2026-11-15）。
       *
       * 这种情况下他刚打的那句话会被这次 `return` 丢掉（恢复成功后
       * 快照会被真实内容覆盖）。窗口通常只有 1–3 秒，概率很低，
       * 但**丢了就是丢了** —— 至少要留下痕迹，别让它无声无息。
       *
       * 不改成"打断恢复去保存"是因为：`chatFileName` 此刻可能指向
       * 一个还没读到的真实文件，贸然保存就是整份覆盖 —— 正是要防的事。
       */
      if (messages.some((one) => one.is_user === true)) {
        diagNote(
          'note',
          `[会话] 恢复期间收到用户消息，暂不写入：条数=${String(messages.length)}` +
            ` fileName=${this.chatFileName ?? 'null'}`,
        );
      }
      /*
       * ★ 指针只在它本来就为空时保持为空。
       *
       * 有值时**不许动** —— 它指向的那段历史正等着被读回来。
       * 这里不清空，是因为清空后 `persistSession` 会把 null 写进
       * localStorage，等于把"上次聊到哪"这件事也一起丢了。
       */
      this.chatSnapshot = {
        fileName: this.chatFileName,
        messages: messages.slice(),
        scrollTop: this.chatSnapshot?.scrollTop,
      };
      return;
    }

    /*
     * ★★★★★ 冷启动保护：**还没从磁盘读过这段，就别拿内容去覆盖它**（2026-11-15）。
     *
     * ## 为什么光有时序标记不够
     *
     * `mount()` 里的顺序是：
     *
     * ```text
     *   loadCharacterCardWithRetry() → 卡一到就 renderPage()   ← 先发生
     *   await restoreLatestChat()                               ← 后发生
     * ```
     *
     * 重绘**故意排在恢复前面**（否则用户要对着没有开场白的空屏等一分钟）。
     * 而 `renderPage()` → `renderChat()` → 快照为 null → `panel.newChat()`
     * → 注入开场白 → 本函数 —— **这一整串都发生在 `restoringAvatar` 被设上之前**。
     *
     * 所以那道时序闸对"启动窗口内"的这一次调用是无效的。
     *
     * ## 用"读没读过"来判断，不依赖时序
     *
     * ```text
     *   lastSavedFingerprint === null  ⇒ 本次进程还没成功读过/写过这段
     *   messages 里没有 user 消息      ⇒ 手里只有开场白
     *   chatFileName 非 null           ⇒ 它指向一个**可能有历史**的真实文件
     * ```
     *
     * 三条同时成立 ⇒ 这是"临时显示用的开场白"，写下去就是**用开场白
     * 覆盖掉整段历史**（ST 的 save 是整份覆盖）。必须跳过。
     *
     * ## 为什么不误伤正常保存
     *
     * ```text
     *   用户发第一句   hasUser = true          ⇒ 不跳过
     *   恢复成功之后   lastSavedFingerprint 有值 ⇒ 不跳过
     *   新建对话        chatFileName 由本函数生成
     *                  且 messages 必有 user    ⇒ 不跳过
     * ```
     *
     * 唯一被跳过的是"手里只有开场白、又没读过文件"这一种 —— 那本来就
     * 不该写盘。
     */
    const hasUserMessage = messages.some((one) => one.is_user === true);
    if (
      this.lastSavedFingerprint === null &&
      !hasUserMessage &&
      this.chatFileName !== null
    ) {
      diagNote(
        'note',
        `[会话] 跳过保存（开场白未覆盖）：fileName=${this.chatFileName} 条数=${String(messages.length)}`,
      );
      this.chatSnapshot = {
        fileName: this.chatFileName,
        messages: messages.slice(),
        scrollTop: this.chatSnapshot?.scrollTop,
      };
      return;
    }

    /*
     * 文件名：已有就复用；没有**看情况**才造（2026-11-14 修）。
     *
     * ## 原来"没有就造"的后果
     *
     * 切角色必须把 `chatFileName` 清空（否则会写进上一个角色的目录），
     * 于是每次切角色都走这条分支 —— 而 `applyOpening()` 注入开场白后
     * 也会调本函数，于是**每切一次角色就多一个只有开场白的文件**。
     * 用户截图里同一角色 8 个文件全是空壳，就是这个。
     *
     * ## 现在的闸
     *
     * ```text
     *   内容里没有用户消息 ⇒ 不造
     *   只有开场白不算"开始了一段对话"，那只是"他还没开口"
     * ```
     *
     * 过了才建档 —— 也就是用户**真的发了第一句话**时。
     * （"恢复期间不建"那道闸已经提到函数开头，不再在这里判。）
     */
    if (this.chatFileName === null && avatar !== null) {
      if (!shouldStartNewChatFile(messages)) {
        /*
         * 不建档，但**快照仍要更新** —— 否则切 Tab 回来开场白就没了
         * （那是"当场可见"的问题，比"没落盘"更难受）。
         *
         * `fileName` 用 `null`：这个字段在本类里**只写不读**
         * （渲染用的是 `this.chatFileName`），而 `null` 明确表示"没有"。
         */
        this.chatSnapshot = {
          fileName: null,
          messages: messages.slice(),
          scrollTop: this.chatSnapshot?.scrollTop,
        };
        return;
      }
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
          /*
           * ★★ 记下"真的写了多少条"（2026-11-15）。
           *
           * 这条日志是被两次"定不了案"逼出来的：用户报"气泡出来了但
           * 记录没进去"，而日志只能证明"persistSession 被调过" ——
           * **调过不等于写过**（指纹相同会跳过、并发会排队）。
           *
           * 现在每成功写一次就有一行条数，和恢复时的读回条数对得上，
           * "写没写进去"当场可判。
           */
          diagNote(
            'note',
            `[会话] 保存成功 ${this.chatFileName} 条数=${String(current.messages.length)}`,
          );
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
    scroller.append(
      renderApiSection(this.settingsHost()),
      this.renderVoiceSection(),
      /*
       * 诊断日志（2026-11-12）。
       *
       * 加这一项的直接原因：用户报「过一段时间自动闪退」，而我们
       * **拿不到任何日志** —— logcat 要数据线，用户做不到。
       * 有了这个入口，他闪退后重进 App 点一下就能把原因发回来。
       */
      renderDiagSection(this.settingsHost()),
      /*
       * 「关于」（2026-11-18，合规要求）。
       *
       * ★ 用户明确要求：**不要收纳结构**，直接像桌面端一样用蓝色文字，
       *   放在页面最底部、靠左。
       *
       * 内容必须与桌面端不同：安卓端内置了 SillyTavern（AGPL-3.0），
       * 所以这里要给出它的对应源码地址；桌面端没有内置，那边不提 ST。
       */
      this.renderAboutEntry(),
    );
  }

  /**
   * 「我的」页最底部的一行「关于」蓝色文字（2026-11-18，合规要求）。
   *
   * ## 为什么不做成收纳项
   *
   * 用户明确要求：「不要用收纳结构，直接像桌面端一样使用蓝色文字：关于，
   * 放在底部左边」。收纳项（`.nb-section`）会带一个整宽点击行 + 折叠箭头，
   * 视觉上像"又一个设置分组"；而「关于」是**只读的版权信息**，
   * 一行文字更像"页脚"，也更符合桌面端的形态。
   *
   * ## 为什么用 `<button>` 而不是 `<span>`
   *
   * 它要能 Tab 聚焦、回车触发、有 `cursor: pointer`。样式上把按钮外观
   * 全部抹掉（`appearance:none; background:none; border:0`），
   * 只留蓝色文字 —— 见 `chat.css` 的 `.nb-about-link`。
   *
   * ## 为什么内容与桌面端不同
   *
   * 安卓端**内置** SillyTavern（AGPL-3.0），必须给对应源码地址（§6 义务）；
   * 桌面端没有内置，若照搬这段文案就是对桌面用户说假话。
   */
  private renderAboutEntry(): ElLike {
    const info = androidAbout(appVersion());
    const wrap = el(this.doc, 'div', 'nb-about');
    const link = el(this.doc, 'button', 'nb-about-link');
    link.setAttribute('type', 'button');
    link.textContent = '关于';
    link.setAttribute('data-role', 'about-open');
    link.addEventListener('click', () => this.openAboutSheet(info));
    wrap.append(link);
    return wrap;
  }

  /**
   * 弹出「关于」内容（安卓端）。
   *
   * ★ 用**真实存在**的类名（`.nb-sheet-mask` / `.nb-sheet` / `.nb-sheet-title` /
   *   `.nb-sheet-actions` / `.nb-sheet-action`）—— 与 `bubble-menu.ts` 同一套。
   *
   *   第一版我凭印象写了 `.nb-modal-overlay` / `.nb-modal-*`，那套类在 CSS 里
   *   **根本不存在**。CSS 对未知类不报错，结果是弹窗没有任何定位/遮罩/
   *   圆角样式 —— 内容会以裸流的形式挤在页面底部，看起来像"点了没反应"。
   */
  private openAboutSheet(info: AboutInfo): void {
    const mask = el(this.doc, 'div', 'nb-sheet-mask');
    mask.setAttribute('data-role', 'about-dialog');
    const sheet = el(this.doc, 'div', 'nb-sheet');
    const title = el(this.doc, 'div', 'nb-sheet-title');
    title.textContent = '关于';
    const body = el(this.doc, 'div', 'nb-about-body');

    const line = el(this.doc, 'p', 'nb-about-version');
    line.textContent = `Tavern Card Studio · 版本 v${info.version}`;
    const summary = el(this.doc, 'p', 'nb-about-note');
    summary.textContent = info.summary;
    body.append(line, summary);

    for (const item of info.links) {
      const row = el(this.doc, 'div', 'nb-about-row');
      const label = el(this.doc, 'span', 'nb-about-label');
      label.textContent = item.label;
      const link = el(this.doc, 'button', 'nb-about-link nb-about-url');
      link.setAttribute('type', 'button');
      link.textContent = item.text;
      link.setAttribute('title', item.url);
      link.setAttribute('data-role', 'about-external');
      link.setAttribute('data-url', item.url);
      link.addEventListener('click', () => {
        void openExternal(item.url).catch(() => {
          /* 打不开就把地址留在界面上，用户能自己复制 */
        });
      });
      row.append(label, link);
      body.append(row);
    }
    for (const note of info.notes) {
      const p = el(this.doc, 'p', 'nb-about-note');
      p.textContent = note;
      body.append(p);
    }

    const actions = el(this.doc, 'div', 'nb-sheet-actions');
    const closeButton = el(this.doc, 'button', 'nb-sheet-action nb-sheet-action--primary');
    closeButton.setAttribute('type', 'button');
    closeButton.textContent = '关闭';
    closeButton.addEventListener('click', () => mask.remove());
    actions.append(closeButton);

    sheet.append(title, body, actions);
    mask.append(sheet);
    /*
     * `DocLike` 没有声明 `body`（渲染层只暴露 createElement）。这里是移动壳
     * 自己的调用点，`doc` 一定是真 `document` —— 用一次断言比给 `DocLike`
     * 加一个只有这里用的成员更干净（加成员会让所有单测 stub 都要跟着补）。
     * 与 `bubble-menu.ts` 同一写法。
     */
    const host = (this.doc as unknown as { body?: { append?: (n: unknown) => void } }).body;
    if (host?.append !== undefined) {
      host.append(mask);
    } else {
      (this.doc as unknown as { documentElement?: { append?: (n: unknown) => void } })
        .documentElement?.append?.(mask);
    }
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

  /**
   * 「诊断日志」收纳项 —— 让用户自己把崩溃现场取出来（2026-11-12）。
   *
   * ## 为什么值得单独做一个界面
   *
   * 用户报「进入 APP 后过一段时间自动闪退」，而我为了查它连续猜了三次：
   *
   * ```text
   *   猜内存泄漏  → 实测 263MB 稳定不动，错
   *   猜 ANR      → 主线程无阻塞迹象，错
   *   猜前台服务  → 声明完整，无从判断
   * ```
   *
   * 根子在于**没有任何一条现场记录**。修这个比继续猜有用：
   * 用户闪退后重进 App，点开这一项、复制、发给我，就有真因了。
   *
   * ## 副标题就是结论
   *
   * 不展开也能看到"上次是正常退出还是异常结束" —— 那是最关键的一条信息，
   * 藏进面板里等于没有（用户不会为了看结论先展开）。
   */


  /** 读"上次怎么退的" —— 读不到就当正常，别让诊断功能自己成为错误源 */
  private diagBoot(): { lastExitClean: boolean } {
    const holder = globalThis as {
      __TCS_DIAG__?: { boot?: { lastExitClean?: boolean } };
    };
    return { lastExitClean: holder.__TCS_DIAG__?.boot?.lastExitClean !== false };
  }

  /**
   * 选中预格式化文本（复制失败时的兜底路径，用户长按即可复制）。
   *
   * ★ 用 `globalThis.document` 而不是 `this.doc`：`this.doc` 的类型是
   *   `DocLike`（测试桩的最小接口），上面没有 `createRange`。
   *   而这条路径只在真 WebView 里走 —— 桩环境里 `document` 不存在，
   *   直接跳过即可，不需要为它扩展 `DocLike`（那会让所有桩都变重）。
   */


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

/**
 * 读角色卡的重试预算（2026-11-11）。
 *
 * 为什么是 70 秒：真机首启实测引擎就绪要 **7–57 秒**（见
 * `restoreLatestChat` 里那段实测记录）。取 57 秒之上留一点余量。
 *
 * 为什么读卡要跟读历史一样能等：这两件事开头是同一个阻塞点 ——
 * 引擎没起。只给历史重试、不给卡重试，就会出现"历史等到了、卡却是空的"
 * ⇒ 有对话没开场白，而且再也不会自动纠正。
 */
const CARD_LOAD_TIMEOUT_MS = 70_000;

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

