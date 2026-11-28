/**
 * 八板块编辑器（T6.1；v0.1.3 起六→八）+ 审计面板（T6.5）。
 *
 * 结构：
 *   顶栏（卡片名 / 统计 / 文件操作 / 连接状态 / 设置）
 *   同步条（可用性由服务端连接决定，与本地编辑解耦）
 *   ├ 左：八个板块（折叠面板，折叠时销毁编辑器 → 隐藏块不进 DOM；
 *   │        首屏只展开前两个，常驻 CM6 实例数 = 2，见 block-doc.ts DEFAULT_EXPANDED_COUNT）
 *   └ 右：审计面板（过滤 / 分组 / 字数分布；点击问题定位到板块内偏移）
 *
 * 依赖方向：本文件只 import `../contract`（原生能力）与 `@tcs/shared`（纯逻辑），
 * 不直接碰 `@tauri-apps/*`，也不自己拼卡片字符串。
 */

import {
  applyPresetPlan,
  buildAuditReport,
  compileHighlightRule,
  countExampleTurns,
  createEmptyCard,
  DEFAULT_CHAT_EXAMPLES_PRESET,
  DEFAULT_GREETING_PRESET,
  DEFAULT_WORLDBOOK_PRESET,
  describeFieldPreset,
  effectiveGreetingFormat,
  importWorldbook,
  normalizeOnArrival,
  refreshFieldBlockViews,
  parseStCard,
  renderWorldbookTextWith,
  resolveHighlightRule,
  resolvePlatformRule,
  type AuditIssue,
  type PresetApplyPlan,
  type TxtPreset,
  type AuditReport,
  type BlockId,
  type FieldPreset,
  type FieldPresetBlock,
  type GreetingFormatParams,
  type UnifiedCard,
  type WorldbookPreset,
} from '@tcs/shared';

import {
  appendClientErrorLog,
  configGet,
  askConfirm,
  configPatch,
  findStCandidates,
  isShellAvailable,
  pickCardFile,
  pickSavePath,
  probeCardsDir,
  probePaths,
  probeTcp,
  readBinaryFile,
  readPresetLibrary,
  readTextExact,
  scanCardsDir,
  shellInfo,
  // v0.1.7 增补三：取回撞名的 mtime 判据
  statFile,
  stProxyStart,
  stProxyStatus,
  stProxyStop,
  writeBinaryFileAtomic,
  writeFileAtomic,
  writePresetLibrary,
  type ClientConfig,
  type ShellError,
  type WriteReceipt,
} from '../contract';

import {
  collectBlocks,
  defaultExpandedBlockIds,
  importCardText,
  setBlockText,
  totalLength,
  type EditorBlockSnapshot,
} from './block-doc';
import { byId } from './dom-id';
import { hasDebugParams } from './debug-keys';
import type { DemoHost } from './demo-actions';
import { BlockEditor, type EditorIssue } from './block-editor';
import { createPromptsPanel, type PromptsPanel } from './prompts-panel';
import { promptsWithinLimits } from '../session/card-prompts';
import { planRemoteApply } from '../sync/remote-apply';
import { applySchemeStyles, buildPreviewFragment } from './highlight';
import {
  buildRuleset,
  DEFAULT_HIGHLIGHT_ID,
  DEFAULT_PLATFORM_ID,
  type Ruleset,
} from './rules';
import { AuditPanel } from '../audit/audit-panel';
import {
  RulesDialog,
  type DialogState,
} from '../rules/rules-dialog';
import { importHighlightScheme, importPlatformRule } from '../rules/rule-library';
import {
  decideApplyPreset,
  describePresets,
  previewPresetSelection,
} from '../rules/preset-switch';
/*
 * ★ 这一行是**副作用注册**，不能删（2026-11-17）。
 *
 * 它把 `server_http_request` 注册成 HTTP 传输层，从而让同步请求在
 * 桌面端走原生命令 —— 那是**唯一**能处理自签证书的通道（webview 的
 * 证书校验无法配置）。删了不会白屏，而是在第一次探测/同步时抛错：
 * "桌面端没有注册原生 HTTP 通道"。
 *
 * 为什么不做成"自动发现"：纯层不能 import 契约层（Node 单测会挂，
 * 见 `net/http-transport.ts` 文件头），只能由入口显式带进来。
 */
import '../net/http-native';
import { isOriginCertAcked, withCertAckedOrigin } from '../net/http-transport';
import { isSyncReady, probeServer, type ProbeResult } from '../net/server-probe';
import { ExportDialog } from '../export/export-dialog';
import { buildExportAsync, checkWorldbookExportSafety } from '../export/export-card';
import { SyncDialog } from '../sync/sync-dialog';
import { CardsDialog } from '../sync/cards-dialog';
import { AccountDialog } from '../sync/account-dialog';
import { RepoDialog } from '../sync/repo-dialog';
import { listRepos } from '../sync/repo-client';
import type { RepoTokenContext } from '../sync/repo-select';
import type { SyncConfig } from '../sync/server-sync';
// 卡面拉取（v0.1.7 修订二）：值导入，取回/回滚时用它把封面也收下来
import { fetchFace } from '../sync/server-sync';
import { AuthSession } from '../auth/session';
import { LoginDialog } from '../auth/login-dialog';
import { AccountDeleteDialog } from '../auth/account-delete-dialog';
import { phaseLabel, phaseTitle, repoTokenLabel, repoTokenTitle } from '../auth/policy';
import { describeCapabilities, disabledReason, repoTokenModeLabel } from '../auth/repo-token';
import {
  connectionLabel,
  hasServerUrl,
  resolveSyncGate,
  syncHintText,
  type SyncGateState,
} from '../auth/entry-policy';
import { SettingsDialog } from '../settings/settings-dialog';
import { appVersion } from '../settings/app-version';
import { CardInfoDialog } from '../settings/card-info-dialog';
import {
  applyDefaults,
  EMPTY_CARD_INFO_DEFAULTS,
  readCardInfo,
  sanitizeDefaults,
  toDefaults,
  type CardInfo,
  type CardInfoDefaults,
} from '../session/card-info';
import { NewCardDialog } from '../session/new-card-dialog';
import { decideShortcut } from './shortcuts';
import { ImportDialog } from './import-dialog';
import { applyWorldbookImport, exportWorldbookText, suggestWorldbookFileName } from './import-flow';
import {
  importFieldPreset,
  importTxtPreset,
  importWorldbookPreset,
  serializePreset,
  type PresetImportOutcome,
} from '../rules/preset-library';
import { PresetPersistence } from '../rules/preset-persist';
import type { PresetKind, PresetLibraryItem } from '../rules/preset-store';
import { SaveFormatDialog, type SaveFormatDialogResult } from '../session/save-format-dialog';
import { StDialog } from '../session/st-dialog';
import { isPaneWidthUsable } from '../session/st-pane-layout';
import { pushCardToSt } from '../session/st-push';
import { configNameDeps } from '../session/st-push-registry';
import { StPane } from '../session/st-pane';
import { locateSt, stStatusText } from '../session/st-install';
import {
  saveFormatNote,
  saveFormatOption,
  withSaveExtension,
  type SaveFormat,
} from '../session/save-format';
import { defaultSaveFaceDeps, resolveSaveFace, type ResolvedSaveFace } from '../session/save-face';
import { deriveCardNameFromFile } from './open-name';
import { browserHintStore, dismissNameHint, resetNameHint, shouldShowNameHint } from './name-hint';
import {
  buildDiagnosticsText,
  createCrashLogger,
  installGlobalErrorHandlers,
  suggestDiagnosticsFileName,
  type CrashLogger,
} from '../diagnostics/crash-log';
// 版本号不在这里读：唯一实现在 settings/app-version.ts（诊断导出与设置页共用一份）
import { CardSession } from '../session/card-session';
import { decodeBinaryFile, inspectPng, toPngSource } from '../session/png-source';
import { effectiveCardsDir, suggestCardFileName } from '../session/cards-dir';
import { joinPath } from '../session/cards-path';
// 增补三：导出落 PNG 前的同名撞名守卫（决策纯函数在 face-drop.ts）
import { saveTargetWithGuard } from '../sync/save-target-guard';
import { askDirtyChoice, askUnknownChoice } from '../sync/save-guard-dialog';
import { getBaseline, isNewerThanBaseline, recordBaseline } from '../sync/file-baseline';
import { isPngBytes, parsePngCard } from '../../../shared/src/png-card.ts';
// 取回的仓库卡面是 WebP（v0.1.7 增补二），而 pngSource 下游全要求 PNG 容器
import { convertToPng } from '../export/face-convert.ts';
import { TabBar, type TabItem } from '../session/tab-bar';
import { generateCardId, readCardIdFromCard, withCardId } from '../session/card-id';
import { decideOpenTarget } from '../session/open-target';
import { collectDirtyNames, installUnloadGuard } from '../session/unload-guard';
import {
  askSaveFormat,
  previewSaveFormatDialog,
  saveCard,
  savePngWithGuard,
  resolveSaveFace as resolveFaceForSave,
  saveSessionToDisk,
  type SaveHost,
} from './save-actions';
import { describeError, firstIssue, readCardIdFromCardJson } from './error-text';
import { bytesToBase64 } from '../chat/share-card';
import { el } from './dom';
import type { BlockRuntime } from './block-runtime';
import {
  applyScopeGating,
  buildWorldbookActions,
  collapse,
  createBlock,
  expand,
  onBlockChange,
  type BlockHost,
} from './block-actions';
import {
  refreshAccountButton,
  refreshBlockBadges,
  refreshNameHint,
  refreshRulesLabel,
  refreshStats,
  refreshTokenAfterSave,
  switchHighlight,
  switchPlatform,
  type RefreshHost,
} from './ui-refresh';
import {
  applyDemoWorldbook,
  runCollapseRoundTrip,
  runPreviewScenario,
  type PreviewHost,
} from './preview-scenarios';
import { restorePresetSelection, type PresetRestoreHost } from './preset-restore';
import {
  wireAccount,
  wireNameEditor,
  wireSettings,
  type WireHost,
} from './wiring';
import {
  importCardTextFile,
  openArrivedCard,
  openCard,
  openCardInfo,
  openPngCard,
  type OpenHost,
} from './open-actions';
import {
  buildStPushArtifact,
  ensureStPane,
  runArrivalDemo,
  runAuditDemo,
  type StPushHost,
} from './st-push';
import {
  applyRemoteText,
  arriveCard,
  pullFaceFromServer,
  type LandingHost,
} from './landing';
import {
  autoProbe,
  currentSyncConfig,
  offerCertTrust,
  repoClientConfig,
  repoTokenContext,
  type ConnHost,
} from './connection';
import {
  applyLibraryItem,
  loadPresetLibrary,
  type LibraryHost,
} from './library-actions';
import { confirmClose, confirmOverwrite, locateStCharactersDir } from './dialogs';
import {
  fieldPresetsOf,
  importFieldPresetText,
  importHighlightText,
  importPlatformText,
  importTxtPresetText,
  importWorldbookFile,
  importWorldbookPresetText,
  pickAndImportWorldbook,
  rememberPreset,
  type ImportHost,
} from './import-actions';





/**
 * 编辑器主类。
 *
 * ★ 为什么要导出（2026-11-24）：`debug-params.ts` 需要它的类型来调那些
 * `*ForDemo` 方法。导出只是把类型放出来，**不改变任何封装边界** ——
 * 那些方法本来就声明成 public（它们要被调试入口按名字调用）。
 *
 * 调用方向是单向的：`app.ts` 动态 import `debug-params.ts`，
 * `debug-params.ts` 只 `import type` 本文件（编译后擦除，运行时不构成环）。
 */
export class EditorApp {
  /**
   * 当前编辑会话。**所有卡片状态（卡数据、文件路径、脏标记、规则选择）都从这里读**，
   * 不再散落在 EditorApp 的字段上。
   *
   * 为什么必须收拢（2026-10-22 重构）：之前 `card` 与 `currentFilePath` 是 app.ts 的
   * 两个游离字段，一旦多标签并行编辑，它们就会变成"只有当前卡是对的"的隐患 ——
   * 切走再切回来，路径和脏标记要么丢、要么串到另一张卡上。
   * 现在 `CardSession` 是唯一真相源，切换标签只需换 session 引用。
   */
  /**
   * 所有已打开的编辑会话（T9.2）。
   *
   * 顺序即标签栏顺序，**不排序** —— 用户记住的是"第几个标签"，
   * 自动排序会让位置跳来跳去。
   */
  private sessions: CardSession[] = [];
  /** 活动会话 id；null 表示零标签（空工作台） */
  private activeId: string | null = null;
  private tabs: TabBar | null = null;
  private rules: Ruleset | null = null;
  private blocks: BlockRuntime[] = [];
  private issues: readonly AuditIssue[] = [];
  private report: AuditReport | null = null;
  private auditPanel: AuditPanel | null = null;
  private rulesDialog: RulesDialog | null = null;
  private exportDialog: ExportDialog | null = null;
  private syncDialog: SyncDialog | null = null;
  // 注意：这里**没有** syncCardId 字段了（T9.7）。
  // 远端关联属于卡片状态，已归 CardSession.syncCardId / lastUploadedSeq ——
  // 多标签下"当前是哪张卡"由 activeId 决定，app.ts 再留一份必然串卡。
  /** 设置里保存的 token（同步请求要用；probeServer 的 url 不含 token） */
  private settingsToken = '';
  /**
   * 用户已确认「证书不受信任但继续」的 origin（2026-11-17）。
   *
   * 从配置读一次、确认后写回。**按 origin 存**而不是按地址存 ——
   * 证书是按主机签发的，同一台机器的 /api/health 与 /api/stats 是
   * 两个 URL 但同一个 origin（见 `ClientConfig.certAckedOrigins`）。
   */
  private certAckedOrigins: string[] = [];
  /**
   * 上次导出 PNG 用的卡面（v0.1.4 / T12.5）。
   *
   * 在 App 上缓存一份而不是每次 `configGet`：导出面板换格式时会连续读两次，
   * 每次都打一次 IPC 会让"选 PNG → 换 TXT → 再选 PNG"出现明显的卡顿。
   * 真值仍是配置（启动时加载，见 `loadConfig`）。
   */
  private lastFaceChoice: string | null = null;
  /**
   * 截图用的演示卡面（v0.1.4 / T12.5）。
   *
   * 只有 `?faceDemo=` 调试参数会赋值，正常流程恒为 `null`。
   * 存在的理由：浏览器里（无壳）读不了本地文件，图库与"原图"必然为空，
   * 那样截图只能证明空态，证明不了网格与预览。UI 上给这些候选打「演示」角标，
   * 所以不会与真实数据混淆。真正的读盘能力由 live 脚本与契约测试证明。
   */
  private demoFaces: Array<{ name: string; bytes: Uint8Array }> | null = null;
  private demoSourceBytes: Uint8Array | null = null;
  /** 截图用：浏览器里读不到内置默认卡面（无壳），拿它当替身 */
  private demoDefaultBytes: Uint8Array | null = null;
  /**
   * 账户登录态（T10.7）。
   *
   * 与 `settingsToken` 并存：**账户令牌优先**，为空时回落到 legacy 全局令牌。
   * 两者都不在时同步入口按未就绪处理。
   */
  private authSession: AuthSession | null = null;
  private loginDialog: LoginDialog | null = null;
  /** 注销账户的二次确认弹窗（v0.1.3 / F3） */
  private accountDeleteDialog: AccountDeleteDialog | null = null;
  private cardsDialog: CardsDialog | null = null;
  /** TXT 角色卡 / 世界书导入对话框（T10.9） */
  private importDialog: ImportDialog | null = null;
  private repoDialog: RepoDialog | null = null;
  /** 账户面板：身份、登录设备、我的卡片、改名改密码、退出（v0.2.3） */
  private accountDialog: AccountDialog | null = null;
  /**
   * 上次选过的上传仓库（T10.8）。
   *
   * 只活在内存里：不进配置。理由是这个选择跟"我正在做哪件事"绑定，
   * 跨会话记住它反而会让下次上传悄悄落到上次那个仓库里。
   */
  private selectedRepoId: string | null = null;
  /**
   * 认证请求用的服务端地址。
   *
   * 不能复用 `this.connection?.url`：探测失败时 connection 是 null 或没有 url，
   * 而"探测失败"与"不能登录"不是一回事 —— 用户可能只是令牌还没填。
   */
  private authServerUrl = '';
  /** 世界书格式预设（T10.31）：内置 default + 用户导入项 */
  private worldbookPresets: WorldbookPreset[] = [DEFAULT_WORLDBOOK_PRESET];
  private worldbookPreset: WorldbookPreset = DEFAULT_WORLDBOOK_PRESET;
  /**
   * 字段板块格式预设（v0.1.3 追加项一）。
   *
   * 两个板块各一条独立列表：`block` 字段不同，混在一个下拉里用户会选错，
   * 而选错的后果是"分隔符改了但内容没变"，很难归因。
   */
  private greetingPresets: FieldPreset[] = [DEFAULT_GREETING_PRESET];
  private greetingPreset: FieldPreset = DEFAULT_GREETING_PRESET;
  private chatExamplePresets: FieldPreset[] = [DEFAULT_CHAT_EXAMPLES_PRESET];
  private chatExamplePreset: FieldPreset = DEFAULT_CHAT_EXAMPLES_PRESET;
  /**
   * 用户预设库（v0.1.5 / G5）：导入即落盘，启动即加载。
   *
   * 只存**用户导入的那些**（不含内置）。内置永远来自 `rules/` 目录或打包副本，
   * 存一份副本进库的话，将来内置更新了会被旧副本盖回去。
   *
   * IO 在这里注入而不是在 `preset-persist` 里直接 import contract：
   * 那个类因此不依赖 Tauri，能在 Node 里直接单测时序。
   */
  private readonly presetStore = new PresetPersistence({
    read: async () => {
      const file = await readPresetLibrary();
      return file === null ? null : { text: file.text };
    },
    write: async (text) => writePresetLibrary(text),
  });
  /** 库加载完之前不写盘：否则「导入一个」会把还没读进来的旧预设一起清掉 */
  private presetStoreReady = false;
  /**
   * 取证/截图演示期间为 true：{@link rememberPreset} 直接跳过落盘。
   *
   * 演示夹具是用户真实内容（含他的自定义规则），不该因为跑一次截图
   * 就写进本机预设库；浏览器里写盘也必然失败，会多一条与本取证无关的警告。
   */
  private demoQuiet = false;
  private validateTimer: number | null = null;
  private activeIssueId: string | null = null;

  /**
   * 异常日志（T10.26）。
   *
   * `lastErrorLogPath` 是**契约返回的**路径 —— 渲染层不自己拼"应用配置目录在哪"
   * （那属于壳的知识）。第一次落盘成功后才有值；导出诊断日志时用它去读文件。
   */
  private crashLogger: CrashLogger | null = null;
  private crashUninstall: (() => void) | null = null;
  private lastErrorLogPath: string | null = null;

  private readonly toolbarStats = byId('stats');
  private readonly blockList = byId('block-list');
  private readonly issueSummary = byId('issue-summary');
  private readonly statusBar = byId('status');
  private settings: SettingsDialog | null = null;
  private newCardDialog: NewCardDialog | null = null;
  /** 卡片级信息对话框（v0.1.6）：作者 / 版本 / 创作说明 / 标签 / 系统提示 / 世界书说明 */
  private cardInfoDialog: CardInfoDialog | null = null;
  /**
   * 「角色提示词」板块（2026-11-17）。
   *
   * 惰性创建、之后复用：滚动位置与展开态是 DOM 状态，
   * 每次重建会让用户刚滚到的那条跳回顶部。
   */
  private promptsPanel: PromptsPanel | null = null;
  /** 读一次缓存；新建卡时套用。「设为新卡默认值」写完会刷新它 */
  private cardDefaults: CardInfoDefaults = { ...EMPTY_CARD_INFO_DEFAULTS };
  /** 另存为的格式选择对话框（v0.1.5 / G6） */
  private saveFormatDialog: SaveFormatDialog | null = null;
  /**
   * 「在 SillyTavern 中测试」面板（v0.1.5 / F15）。
   *
   * 延迟构造（第一次点按钮时）：它一构造就会去扫主目录 + 探进程状态，
   * 而绝大多数会话根本不碰 ST —— 启动时白跑一趟只会拖慢首屏。
   */
  private stDialog: StDialog | null = null;
  /**
   * 右侧常驻的 ST 面板（v0.1.6 / T14.3）。
   *
   * 与上面那个对话框分工不同：对话框管"ST 装在哪 / 要不要装 / 要不要启动"这类
   * 一次性配置，面板管"边写卡边看效果"。两者共用同一套判据与同一条推送链路。
   *
   * 懒构造：构造它不花什么，但 `open()` 会起代理（占一个回环端口），
   * 而绝大多数会话根本不碰 ST。
   */
  private stPane: StPane | null = null;
  private connection: ProbeResult | null = null;
  /** 最近一次审计的等级计数（切规则后要给用户一句话结论） */
  private lastSummary = { error: 0, warning: 0, info: 0 };

  constructor(card: UnifiedCard | null) {
    // 传入 null = 空白启动（F3）：启动时不打开任何卡，工作台是空的。
    if (card !== null) {
      const session = new CardSession({
        card,
        cardId: readCardIdFromCard(card) ?? undefined,
        // 此时预设还没从磁盘加载（`start()` 里才有），先给冻结默认；
        // `start()` 载入预设后会统一 `setWorldbookFormat` 覆盖一次。
        worldbookFormat: this.worldbookPreset.format,
      });
      this.sessions.push(session);
      this.activeId = session.id;
    }
  }

  /**
   * 当前卡数据（只读视图）。
   *
   * 保留 `this.card` 这个读法是为了让一百多处读取点不用改；
   * 但**没有 setter** —— 写操作一律走 session（见 onBlockChange / replaceCard / applyCardName），
   * 这样"改内容"只有一个入口，脏标记与审计缓存不会被漏掉。
   */
  private get card(): UnifiedCard {
    return this.session.card;
  }

  /**
   * 活动会话。
   *
   * 零标签时没有活动会话 —— 这种情况**必然**发生在启动（F3 空白启动）与
   * 关闭最后一个标签之后。所有因为"需要一张卡"而取 card 的地方都得先确认有会话，
   * 否则会在空工作台上炸。这里用抛错把问题暴露在开发期，而不是返回一个假卡。
   */
  private get session(): CardSession {
    const active = this.sessions.find((item) => item.id === this.activeId);
    if (!active) {
      throw new Error('当前没有活动会话：请先在零标签判断之后调用（见 hasSession）');
    }
    return active;
  }

  /** 是否有活动会话（零标签时 false） */
  private get hasSession(): boolean {
    return this.sessions.some((item) => item.id === this.activeId);
  }

  async start(): Promise<void> {
    this.setStatus('加载规则…');
    // 必须先于 wireToolbar（那里会启动 autoProbe）：浏览器直开时读不到配置，
    // `?serverUrl=` 是唯一能告诉应用"服务端在哪"的途径。壳里配置优先，
    // autoProbe 拿到配置后会覆盖它。
    this.applyDebugServerUrl();
    this.rules = await buildRuleset();
    /*
     * 用户预设库（v0.1.5 / G5）：必须紧跟 buildRuleset ——
     * 用户导入的预设是"并进候选列表"，内置那份得先到位，同 id 才能正确覆盖。
     * 这里会顺带恢复上次选中的六类预设（config 里的 id）。
     */
    await loadPresetLibrary(this.libraryHost());
    // 配色来自高亮方案本体（规则资产），不写死在样式表里
    applySchemeStyles(this.rules.highlightFile);
    if (this.rules.warnings.length > 0) {
      this.setStatus(this.rules.warnings.join('；'), 'warn');
    } else {
      this.setStatus(
        `规则：平台 ${this.rules.platformId} · 高亮 ${this.rules.highlightId} · 预设 ${this.rules.preset?.id ?? '—'}` +
          `（来源：${Object.values(this.rules.sources).every((s) => s === 'shell') ? '壳资源目录' : '打包副本'}）`,
      );
    }

    // 右上角「规则」标签要在这里刷一次。
    // 之前只在"切换规则/预设"时刷，于是启动后它一直停在 HTML 里的初始文案
    // 「规则加载中…」—— 明明已经加载完了（2026-10-22 截图核对时发现）。
    refreshRulesLabel(this.refreshHost());

    // T6.5：审计面板要在首次校验前就位，否则第一次报告会无处渲染
    this.auditPanel = new AuditPanel(
      {
        onLocate: (issue) => this.locateIssue(issue),
        onFocusBlock: (blockId) => {
          const runtime = this.blocks.find((block) => block.snapshot.id === blockId);
          if (runtime) expand(this.blockHost(), runtime, true);
        },
      },
      byId('audit-panel'),
    );

    // 标签栏要在挂载会话之前建好，否则首屏的 refreshTabs() 无处可去
    this.tabs = new TabBar(byId('tabbar-host'), {
      onActivate: (id) => this.activateSession(id),
      onClose: (id) => void this.closeSession(id),
      onNew: () => void this.newCard(),
    });

    /*
     * 「卡片右键」入口（v0.1.5 / F15 · T13.6）：需求要求顶栏按钮与卡片右键是同一个入口。
     *
     * 这个仓库此前没有任何右键菜单，为一个入口造一套菜单框架不划算，
     * 而"卡片"在本应用里最直接的化身就是标签（一张卡一个标签）。
     * 所以这里把右键解释成"对这张卡做 ST 测试"：先切到那个标签，
     * 再开面板 —— 面板里所有动作都作用于活动会话，切过去才能保证
     * 用户看到的卡与推过去的卡是同一张。
     *
     * `contextmenu` 挂在容器上而不是每个标签上：标签是 `render()` 重建的，
     * 逐个绑定会在每次重绘后留下一堆指向已销毁节点的监听。
     */
    byId('tabbar-host').addEventListener('contextmenu', (event) => {
      const target = event.target as HTMLElement | null;
      const hit = target?.closest<HTMLElement>('[data-session-id]') ?? null;
      if (hit === null) return;
      const id = hit.dataset['sessionId'];
      if (id === undefined) return;
      event.preventDefault();
      if (id !== this.activeId) this.activateSession(id);
      void this.openStDialog();
    });

    this.wireToolbar();
    wireNameEditor(this.wireHost());
    this.wireShortcuts();
    wireSettings(this.wireHost());
    this.wireRules();
    this.wireCardInfo();
    void this.loadCardDefaults();
    this.wireExportAndSync();
    wireAccount(this.wireHost());
    this.wireImport();

    // 未落盘会话的离开拦截（T9.14）。
    // WebView2 认 F5 / Ctrl+R，误按一次就把整个 webview 重载、所有标签的
    // 未保存内容一起消失——比逐个关标签严重得多。这里只在有脏会话时拦，
    // 全部保存过就放行（详见 unload-guard.ts 里与「三选」的语义对应）。
    // 每次事件现取会话状态，不维护镜像：镜像状态最容易在保存后忘记清。
    installUnloadGuard(window, () => collectDirtyNames(this.sessions));

    // 首屏：有会话就挂载，没有就走空工作台（F3 空白启动）。
    // **这两条路径共用 mountActiveSession**，所以"启动界面"与"零标签界面"
    // 不可能长得不一样。
    this.mountActiveSession();
    this.refreshTabs();

    // 调试/截图入口：`?preview=<mode>` 驱动「渲染预览」，把结果写进 body.dataset
    // 供端到端断言读取（scripts/verify-e2e.mjs）。
    // F8 回归：该按钮曾因 buildPreviewFragment 的无限循环让整页假死，
    // 表现为「点了没反应、必须重启客户端」，且控制台无任何报错。
    //
    // **必须放在 mountActiveSession() 之后**：它统计的是 `this.blocks` 里
    // 已经展开的板块数，而板块是在 mount 时才建出来的。之前这段在 wireSettings()
    // 里（那时 blocks 还是空的），于是 `data-preview-expanded` 恒为 0、
    // 「预览打开期间仍可输入」拿不到 `.cm-content` —— 三条断言一起失败。
    // 当时快照抓的是空工作台，这个错位一直没暴露出来（2026-10-25 修）。
    const previewMode = new URLSearchParams(location.search).get('preview');
    if (previewMode !== null) await runPreviewScenario(this.previewHost(), previewMode);

    /*
     * 截图/验收入口（v0.1.4 / T12.5）：`?exportFace=1&faceDemo=library|source`
     *
     * **位置就是判据**（这是第四次踩同一个坑）：依赖两样东西 ——
     *   ① `exportDialog` 已构造（在 `wireExportAndSync()` 里，而它排在
     *      `wireSettings()` **之后**）；
     *   ② 会话已挂载（`mountActiveSession()` 在上面）。
     *
     * 第一版写在 `wireSettings()` 里，那时 `exportDialog` 还是 null，
     * `this.exportDialog?.open()` 的可选链**静默跳过** —— 症状是截出来一张
     * 普通编辑器页面，看起来像"入口没实现"，而不是"位置错了"。
     * 判断方法：把入口往上挪一行，行为不变就说明它没依赖那个对象。
     */
    const exportFaceParams = new URLSearchParams(location.search);

    /*
     * 世界书拦截取证（v0.1.5 / G3-2）：`?wbDemo=foreign&exportFace=1`
     *
     * 先真实地把世界书文本喂进编辑器（走 setBlockText），再打开导出面板 ——
     * 此时闸门会看到"text 非空 + entries 空"并硬阻断。
     * 位置同样必须在 `start()` 尾部：依赖 `exportDialog` 已构造。
     */
    const wbDemo = exportFaceParams.get('wbDemo');
    if (wbDemo === 'foreign' || wbDemo === 'good') {
      applyDemoWorldbook(this.previewHost(), wbDemo);
    }

    if (exportFaceParams.get('exportFace') === '1') {
      const demoKind = exportFaceParams.get('faceDemo') ?? '';
      /*
       * **无条件**准备默认卡面的替身：浏览器里 `readDefaultFace()` 走 IPC，
       * 没有壳必然失败。只给"带 faceDemo 的场景"准备的话，`?exportFace=1`
       * 这一张（恰恰是最该证明"默认卡面能显示"的那张）会满屏"预览失败"。
       */
      const demoBytes = await this.loadDemoFaceBytes();
      if (demoBytes !== null) {
        this.demoDefaultBytes = demoBytes;
        if (demoKind === 'library') {
          this.demoFaces = [
            { name: '示例封面-a.png', bytes: demoBytes },
            { name: '示例封面-b.png', bytes: demoBytes },
            { name: '示例封面-c.png', bytes: demoBytes },
          ];
        } else if (demoKind === 'source') {
          this.demoSourceBytes = demoBytes;
        }
      }
      this.exportDialog?.open('png');
      this.exportDialog?.refreshFaceChoices();
    }

    /*
     * 另存为格式对话框截图（v0.1.5 / G6）：`?saveFormatDemo=1`
     *
     * 同样必须在 `start()` 尾部：`askSaveFormat` 依赖 `saveFormatDialog`，
     * 而它是在这之后才按需构造的。写早了 `?.open()` 会静默跳过，
     * 症状是"截出来是普通编辑器页面"（踩过四次的坑）。
     *
     * 注意这里**不调 `saveSessionToDisk`** —— 那会真的弹系统保存对话框。
     * 只打开格式选择框，让截图能证明三种选项与禁用态渲染正确。
     */
    if (exportFaceParams.get('saveFormatDemo') === '1') {
      void previewSaveFormatDialog(this.saveHost(), exportFaceParams.get('saveFormatPng') === 'off');
    }

    /*
     * ST 面板调试入口（v0.1.5 / F15）：`?st=1`
     *
     * 位置仍在 `start()` 尾部：`openStDialog()` 要求会话已挂载（`mountActiveSession()`
     * 在上面），否则面板打开时"当前卡"是空的。
     * 浏览器里它会显示"请在桌面客户端里使用"（`isShellAvailable()` 为假），
     * 壳里走真实检测 —— 同一行代码，两种环境各自诚实。
     */
    if (exportFaceParams.get('st') === '1') {
      void this.openStDialog();
    }

    /*
     * 常驻 ST 面板调试入口（v0.1.6 / T14.3）：`?stPane=1`（收起态用 `&collapsed=1`）。
     *
     * 浏览器里它**必然**走到"代理启动失败"那一支（`stProxyStart` 是壳能力）——
     * 这不是伪造的失败，是真实的失败，正好用来核对失败态的版面与文案。
     * "运行中"那一态需要真机（代理 + ST 都在），列在 T14.7 验收清单里。
     *
     * 位置仍在 `start()` 尾部：面板要读"当前卡的角色名"，会话必须先挂上。
     */
    if (exportFaceParams.get('stPane') === '1') {
      void this.toggleStPane().then(() => {
        if (exportFaceParams.get('collapsed') === '1') this.stPane?.collapse();
        /*
         * 收起/展开往返（v0.1.6 真机缺陷四）：`&collapseRoundTrip=1`
         *
         * **真点按钮**（不是调 setCollapsed）：缺陷四恰恰是"按钮绑定写死方向"，
         * 直接调状态函数会绕过那条错误的绑定，就抓不到它了。
         * 点完把结论写进状态栏，截图可读、--dump-dom 也能断言。
         */
        if (exportFaceParams.get('collapseRoundTrip') === '1') {
          void runCollapseRoundTrip(this.previewHost());
        }
      });
    }

    /*
     * 世界书"常驻"误报取证（v0.1.5 / G7）：`?auditDemo=before` / `?auditDemo=after`
     *
     * 夹具由 `scripts/gen-g7-fixtures.mjs` 只写进 `client/dist/g7/`（用户真实内容，
     * 按设计**不进仓库、不进安装包**；`build:client` 第 0 步会连带清掉）。
     * 这里 fetch 回来，再走**真实路径**（导入预设 → 切规则 → 写世界书 → 审计），
     * 不是伪造界面状态。
     *
     * 位置仍在 `start()` 尾部：依赖会话已挂载（`mountActiveSession()` 在上面）。
     */
    const auditDemo = exportFaceParams.get('auditDemo');
    if (auditDemo === 'before' || auditDemo === 'after') {
      void runAuditDemo(this.stPushHost(), auditDemo);
    }

    /*
     * 到达规范化取证（v0.1.6 / 缺陷一）：`?arrivalDemo=before` / `?arrivalDemo=after`
     *
     * before 精确复现旧代码的两条路（解析不传格式 + 跳过规范化），after 走现行路径。
     * 两者都真解析、真审计，所以截图上的"1 错误 / 0 错误"是算出来的。
     */
    const arrivalDemo = exportFaceParams.get('arrivalDemo');
    if (arrivalDemo === 'before' || arrivalDemo === 'after') {
      void runArrivalDemo(this.stPushHost(), arrivalDemo);
    }

    /*
     * 卡片信息取证（v0.1.6）：`?sample=1&cardInfo=1`
     *
     * 用示例卡打开对话框，正好能截到"这几个值是从示例卡带过来的"那条提示 ——
     * 也就是用户现场遇到的那张卡的状态。
     *
     * 走的是**真实入口** `openCardInfo()`，不是直接摆 DOM：
     * 缺陷本身就是"这个入口不存在"，造一份假的界面截图证明不了它有。
     */
    if (exportFaceParams.get('cardInfo') === '1') {
      // 等一帧：示例卡是异步载入的，立刻开会读到空卡
      requestAnimationFrame(() => {
        openCardInfo(this.openHost());
      });
    }

    /*
     * 登录 / 仓库令牌入口的截图调试入口（v0.1.3 / F5 后半）。
     *
     *   ?login=1                    打开登录框（三个入口并列的状态）
     *   ?login=1&repoToken=1        打开并直接切到「使用仓库令牌连接」
     *   &token=<tcr_…>              预填令牌（不提交）
     *   &connectToken=1             **真的点一次「连接」**（走真实 HTTP）
     *   &sync=1                     连接成功后打开同步面板
     *
     * 为什么要有 `connectToken` 这种"真点"开关：截图要证明的是
     * 「这把令牌真能连上、顶栏真会变成仓库令牌模式」。直接往内存里塞状态
     * 截出来的是假象 —— 按钮绑定、请求参数、scope 解析全都没经过。
     * 与 `?settings=1&localConnect=1` 同一条原则。
     *
     * **位置是判据的一部分**：必须放在 `wireAccount()` 之后（这里是 `start()` 尾部）。
     * 第一版写在 `wireSettings()` 里，而那个方法在 `wireAccount()` **之前**执行 ——
     * `this.loginDialog` 还是 null，可选链静默跳过，两张截图拍出来都是空工作台、
     * 字节完全相同（65281），看起来像"登录框没有第三入口"。
     * 同类错在本仓库已出现过一次（`?preview=` 也曾写在 wireSettings 里，见上一段注释）。
     */
    const debugParams = new URLSearchParams(location.search);
    if (debugParams.get('login') === '1') {
      const wantToken = debugParams.get('repoToken') === '1';
      const prefill = debugParams.get('token') ?? undefined;
      if (wantToken) await this.loginDialog?.openRepoTokenMode(prefill);
      else await this.loginDialog?.open();

      if (debugParams.get('connectToken') === '1') {
        // 真点按钮：成功与失败都走同一条代码，错误上屏也才有得看
        document.querySelector<HTMLButtonElement>('[data-role="auth-submit"]')?.click();
        // 等连接结束：成功时对话框自己关掉、body 上已打上 credentialMode
        for (let i = 0; i < 100; i += 1) {
          if (document.body.dataset['credentialMode'] === 'repo-token') break;
          if (this.loginDialog?.isOpen === false) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (debugParams.get('sync') === '1') this.syncDialog?.open();
      }
    }

    /*
     * `?openRepos=1&loginUser=…&loginPassword=…` —— 登录后打开「仓库与令牌」面板（截图用）。
     *
     * 为什么走**真实登录**而不是往配置里塞令牌：`getStore()` 是
     * `@tauri-apps/plugin-store`，在浏览器里根本不可用（第一版用 `configPatch`
     * 注入 accessToken，写入静默失败，截图里那个面板显示"需要先登录账户"）。
     * 而 `AuthSession.login()` 只依赖 fetch —— 浏览器里完全可用。
     *
     * 所以这里点的是真登录：拿到的令牌由 `AuthSession` 正常持有，
     * 面板看到的身份与用户手动登录时完全一致，没有任何伪造状态。
     */
    if (debugParams.get('openRepos') === '1') {
      const username = debugParams.get('loginUser') ?? '';
      const password = debugParams.get('loginPassword') ?? '';
      if (username !== '' && password !== '' && this.authSession !== null) {
        try {
          await this.authSession.login(username, password);
          refreshAccountButton(this.refreshHost());
          applyScopeGating(this.blockHost());
        } catch {
          /* 登录失败时面板会如实显示"需要先登录"，截图即可暴露问题 */
        }
      }
      this.repoDialog?.open();
    }

    /*
     * `?openDelete=1&loginUser=…&loginPassword=…` —— 登录后打开注销确认弹窗（截图用）。
     *
     * 同样走**真实登录**：弹窗要显示"将删除 N 张卡"，那个 N 来自
     * `/api/account/summary`，只有真登录才拿得到。塞假状态截出来的
     * 是一张"统计读取失败"的图，证明不了任何事。
     */
    if (debugParams.get('openDelete') === '1') {
      const username = debugParams.get('loginUser') ?? '';
      const password = debugParams.get('loginPassword') ?? '';
      if (username !== '' && password !== '' && this.authSession !== null) {
        try {
          await this.authSession.login(username, password);
          refreshAccountButton(this.refreshHost());
          applyScopeGating(this.blockHost());
          this.settings?.refreshIdentity();
        } catch {
          /* 登录失败时弹窗会显示"读不到统计"，截图即可暴露问题 */
        }
      }
      await this.accountDeleteDialog?.open();
    }
  }

  /**
   * 证书不受信任时的确认流程（2026-11-17，修 memory §105 的核心）。
   *
   * ## 为什么要问、而且只问一次
   *
   * 自签证书意味着"无法确认对面是谁"—— 中间人可以冒充它看到账号与令牌。
   * 所以不能静默跳过校验，必须让用户知道风险。
   *
   * 但**每次都问**的结果是三秒后开始无脑点确认（memory §106 的结论），
   * 那等于没有提示。所以按 origin 记住，下次不再问。
   *
   * ## 为什么确认后要立刻重新探测
   *
   * 不重探的话界面还停在"连不上"，用户会以为确认没生效 —— 而它其实
   * 已经生效了，只是没人再去试一次。
   *
   * ## 为什么用 `certAsking` 挡一下
   *
   * `autoProbe` 会在启动、设置保存、登录后各跑一次。用户还没点确认时
   * 又跑一次探测就会**再弹一个框**，两个框叠在一起（点掉一个还有一个，
   * 而两个都在问同一件事）。用状态位挡住，等这一次有结论再说。
   */
  private certAsking = false;



  // ── 规则与预设（T6.2 / T6.3）─────────────────────────────
  //
  // 语义要点：
  //   · 切换平台规则 → **立即重检**（阶段 3 定的「切换即重检」）；
  //   · 切换高亮方案 → 立即重新着色（配色来自方案本身）；
  //   · 选择预设 → 只改导出格式（标题/顺序），**原文不动**；
  //   · 应用预设 → 唯一重排入口，走 plan → 确认 → applyPresetPlan。
  /** 设置保存后重新读取 token，并重新探测（地址可能变了） */


  // ── 卡片信息（v0.1.6）──────────────────────────────────────
  //
  // 为什么必须单开一个入口：八个板块覆盖的是正文，而 作者 / 版本 / 创作说明 /
  // 标签 / 系统提示 / 历史后指令 / 世界书名称与说明 这一层**从来没有编辑入口**。
  // 用户从示例卡起手时，这些值会一路被导出成别人的文案
  // （现场：creator_notes 导出了「示例卡片，用于 round-trip 与规则联动测试。」）。
  //
  // 这与 F10 修角色名是同一类问题，区别只是这次一次漏了八个字段。
  private wireCardInfo(): void {
    const button = byId<HTMLButtonElement>('btn-card-info');
    /*
     * 选项只在**这里**写一份，构造时注入。
     * 曾经在"接线"和"打开"两个方法里各写一遍，两份 options 迟早分叉 ——
     * 改了一处忘另一处，症状是"从按钮进去和从调试入口进去行为不一样"。
     */
    this.cardInfoDialog = new CardInfoDialog({
      getCard: () => this.card,
      onSave: (info) => this.applyCardInfo(info),
      onSaveAsDefaults: (info) => this.storeCardDefaults(info),
      logError: (line) => this.crashLogger?.record('error', new Error(line), this.sessionSummary()),
    });
    button.addEventListener('click', () => openCardInfo(this.openHost()));
  }

  /**
   * 取当前卡的导出 JSON 文本（**给验收脚本用**，不参与业务逻辑）。
   *
   * 为什么要有它：卡片信息的验收判据是「导出的 JSON 里那几个字段对不对」，
   * 而导出产物在正常路径上直接写盘/写剪贴板。验收脚本若自己拼 JSON，
   * 验的就是脚本而不是产品 —— 所以这里复用**同一条** `buildExportAsync`。
   *
   * 命名带 ForTest 是刻意的：它只应被调试入口与截图脚本调用。
   */
  async buildExportForTest(format: 'json' = 'json'): Promise<string> {
    const preset = this.rules?.preset ?? null;
    const artifact = await buildExportAsync(
      this.card,
      preset,
      format,
      this.greetingFormat().format,
      undefined,
      this.chatExamplesFormat(),
    );
    if (artifact.format === 'png') throw new Error('内部错误：这里只要文本产物');
    return artifact.text;
  }

  /** 打开卡片信息对话框（按钮与调试入口共用同一条路） */


  /**
   * 把卡片信息写回当前会话。
   *
   * 反馈必须说出来：这一层不在任何板块里，用户看不见正文变化 ——
   * 不给提示他会以为没生效，然后重复点。
   */
  private applyCardInfo(info: CardInfo): void {
    const changed = this.session.updateCardInfo(info);
    if (!changed) {
      this.setStatus('卡片信息没有改动', 'info');
      return;
    }
    this.setStatus('已更新卡片信息（记得保存或导出）', 'ok');
    refreshStats(this.refreshHost());
    this.scheduleValidate(0);
  }

  /** 存成"新建卡的默认值"（不动当前卡） */
  private async storeCardDefaults(info: CardInfo): Promise<void> {
    const defaults = toDefaults(info);
    await configPatch({ cardDefaults: defaults });
    this.cardDefaults = defaults;
    this.setStatus('已存为新建卡的默认值', 'ok');
  }

  /**
   * 读一次新卡默认值（启动时调一次）。
   *
   * 读失败不影响任何功能：默认值只是"省得每次重填"，读不到就当没有。
   * 但**不许静默** —— 落一条日志，否则用户报"我设的默认值没生效"时无从查起。
   *
   * 每个字段都做类型校验而不用 `as`：这份值来自磁盘，可能被旧版本或人手工改过，
   * 一个 `tags: "日常"`（字符串而不是数组）就能让新建卡直接抛异常。
   */
  private async loadCardDefaults(): Promise<void> {
    if (!isShellAvailable()) return;
    try {
      const config = await configGet();
      const stored = config.cardDefaults as Partial<CardInfoDefaults> | undefined;
      this.cardDefaults = sanitizeDefaults(stored);
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.crashLogger?.record(
        'error',
        new Error(`[card-info] 读新卡默认值失败：${message}`),
        this.sessionSummary(),
      );
    }
  }

  private wireRules(): void {
    const button = byId<HTMLButtonElement>('btn-rules');
    button.addEventListener('click', () => this.rulesDialog?.open());

    this.rulesDialog = new RulesDialog({
      getState: () => this.dialogState(),
      notify: (message, kind) => this.setStatus(message, kind ?? 'info'),

      onPlatformChange: (id) => switchPlatform(this.refreshHost(), id),
      onHighlightChange: (id) => switchHighlight(this.refreshHost(), id),
      onPresetSelect: (id) => {
        this.selectPresetById(id);
        refreshRulesLabel(this.refreshHost());
      },
      onPresetApply: (presetId, plan) => {
        const preset = this.rules?.presets.find((item) => item.id === presetId);
        if (!preset) {
          this.setStatus(`预设「${presetId}」不存在`, 'bad');
          return;
        }
        this.commitPresetApply(preset, plan);
      },

      importPlatformText: (text) => importPlatformText(this.importHost(), text),
      importHighlightText: (text) => importHighlightText(this.importHost(), text),
      importTxtPresetText: (text) => importTxtPresetText(this.importHost(), text),
      importWorldbookPresetText: (text) => importWorldbookPresetText(this.importHost(), text),
      onWorldbookPresetSelect: (id) => this.selectWorldbookPreset(id),
      importGreetingPresetText: (text) => importFieldPresetText(this.importHost(), 'initial-scene', text),
      onGreetingPresetSelect: (id) => this.selectFieldPreset('initial-scene', id),
      exportGreetingPreset: (id) => this.exportFieldPresetById('initial-scene', id),
      importChatExamplePresetText: (text) => importFieldPresetText(this.importHost(), 'chat-examples', text),
      onChatExamplePresetSelect: (id) => this.selectFieldPreset('chat-examples', id),
      exportChatExamplePreset: (id) => this.exportFieldPresetById('chat-examples', id),

      exportPlatformRule: (id) => this.rules?.platformSourceText[id] ?? null,
      exportHighlightScheme: (id) => this.rules?.highlightSourceText[id] ?? null,
      exportTxtPreset: (id) => this.exportTxtPresetById(id),
      exportWorldbookPreset: (id) => this.exportWorldbookPresetById(id),
    });
  }

  // ── 导出与同步（T6.6 / T6.7）──────────────────────────────
  private wireExportAndSync(): void {
    this.exportDialog = new ExportDialog({
      getState: () => ({
        card: this.card,
        report: this.report,
        preset: this.rules?.preset ?? null,
        // 初始场景预设决定"多条开场白用哪个分隔行回写"（v0.1.3 追加项一）
        greetingFormat: this.greetingFormat().format,
        // 对话示例预设决定 `mes_example` 的说话人写法与轮次称呼（2026-11-24 补）。
        // 与上传 payload 用同一个函数取，避免"仓库里的和导出的不一样"。
        chatExamplesFormat: this.chatExamplesFormat(),
        // 世界书格式（v0.1.5 / G4）：导出闸门要按**同一份**预设重解析，
        // 否则会把用户那份自定义格式误判成"解析失败"并阻止导出
        worldbookFormat: this.worldbookPreset.format,
      }),
      // 导出前强制重算：不能用过期报告放行
      revalidate: () => {
        this.validate();
        return this.report;
      },
      notify: (message, kind) => this.setStatus(message, kind ?? 'info'),
      /*
       * PNG 导出的卡面上下文（v0.1.4 / T12.5）。
       *
       * 全部走闭包现读：卡面依赖"当前会话的原图"与"当前配置的卡片目录"，
       * 两者都会在对话框存在期间变化（切标签、改设置）。
       */
      face: {
        getCardsDir: () => effectiveCardsDir(),
        getSourceBytes: () => this.demoSourceBytes ?? this.session?.pngSource?.bytes ?? null,
        getRemembered: () => this.lastFaceChoice,
        setRemembered: (value) => {
          /*
           * 记忆只影响"下次预选"，写失败不该打断导出 —— 所以不 await、不抛。
           * 但要更新本地字段：否则同一个面板里换两次格式，第二次会读到旧值。
           */
          this.lastFaceChoice = value;
          void configPatch({ lastFaceChoice: value }).catch(() => {
            /* 配置写不进去只影响下次预选，不影响这次导出 */
          });
        },
        /*
         * 演示候选走 **getter**：它们要到 `start()` 尾部才准备好，
         * 而这个回调对象在面板构造时就固定了。传值会永远拿到 null
         * —— 症状就是"图库那张截图和默认那张字节完全相同"。
         */
        getDemoFaces: () => this.demoFaces,
        getDemoDefaultBytes: () => this.demoDefaultBytes,
      },
      onExported: () => {
        // 导出成功后不自动上传（避免误操作）；用户可在同步面板手动上传
      },
    });

    this.syncDialog = new SyncDialog({
      getConnection: () => this.connection,
      /*
       * 每次打开同步面板都重探一次（v0.1.7 生产反馈：版本号与服务端不一致）。
       *
       * 复用 `autoProbe()` 而不是新写一条探测：它已经是"读配置 → probeServer →
       * applyConnection"的唯一实现，多写一份必然与它分叉（比如漏掉账户令牌优先）。
       */
      onReprobe: () => autoProbe(this.connHost()),
      getConfig: () => currentSyncConfig(this.connHost()),
      // 上传内容与「导出 JSON」同一份，保证服务端字节与本地可复现
      getPayload: () => {
        const preset = this.rules?.preset ?? null;
        return buildExportAsync(
          this.card,
          preset,
          'json',
          this.greetingFormat().format,
          undefined,
          this.chatExamplesFormat(),
        ).then(
          (artifact) => {
            // 'json' 一定是文本产物；判别联合在这里收窄，避免 `artifact.text` 在 PNG 上读到 undefined
            if (artifact.format === 'png') throw new Error('内部错误：JSON 上传拿到了 PNG 产物');
            return artifact.text;
          },
        );
      },
      // 上传目标 = 活动会话（F11）：cardId 创建时定死，baseSeq 是上次对齐的版本
      getUploadTarget: () => {
        if (!this.hasSession) return null;
        const session = this.session;
        return { cardId: session.cardId, name: session.card.meta.name, baseSeq: session.lastUploadedSeq };
      },
      // cardId 与 seq 必须一起记回会话：分叉判定要的正是"上次上传到哪一版"
      onUploaded: (cardId, seq) => {
        if (!this.hasSession) return;
        this.session.noteRemoteVersion(cardId, seq);
      },
      /*
       * 卡面（v0.1.7 修订二）。三个回调都基于当前会话 ——
       * 没有会话时 getFaceBytes 返回 null，上传流程会跳过卡面而不是报错。
       */
      getFaceBytes: () => (this.hasSession ? (this.session.pngSource?.bytes ?? null) : null),
      getLastUploadedFaceSha: () => (this.hasSession ? this.session.lastUploadedFaceSha : null),
      onFaceUploaded: (sha256) => {
        if (!this.hasSession) return;
        this.session.noteFaceUploaded(sha256);
      },
      onRemoteTextApplied: (text, version, remoteSeq, context) => {
        applyRemoteText(this.landingHost(), text, version.seq, remoteSeq, context);
      },
      // 同步面板里一键连接成功后，把结论交回 App：
      // 顶栏指示与三个同步入口的启用状态都读 this.connection，必须同步更新，
      // 否则面板里显示"已连接"、顶栏还写着"未就绪"。
      onConnectionReady: (result) => this.applyConnection(result),
      // 门槛由 App 统一算（地址 + 凭证），面板只负责按状态说话
      getGate: () => this.syncGate(),
      onLogin: () => void this.openAccountEntry(),
      // 401 → 先静默续期，续不上才回登录界面（本地编辑一律不动）
      onUnauthorized: () => this.handleUnauthorized(),
      onOpenCards: () => void this.cardsDialog?.open(),
      // ── 仓库联动（T10.8）────────────────────────────────
      // 只对**账户登录**提供仓库列表：legacy 与仓库令牌都没有"选仓库"的自由，
      // 返回 null 让面板把这一行整行隐藏（而不是显示一个改了也不生效的下拉）
      getRepos: async () => {
        // 仓库令牌模式（v0.1.3 / F5 后半）：令牌绑死一个仓库，没有可选项。
        // 返回空数组 → 面板隐藏整行选择器（需求「仓库选择器隐藏」）。
        // 这里不能"返回那一个仓库让它显示出来"：一个只有一个选项的下拉
        // 会让人以为还能选别的。
        if (this.authSession?.isRepoTokenMode === true) return [];
        const config = repoClientConfig(this.connHost());
        if (!config) return [];
        return listRepos(config);
      },
      getSelectedRepo: () => this.selectedRepoId,
      onSelectRepo: (repoId) => {
        // 记住选择：连着上传几张卡时不用反复选（`pickRepoId` 会优先用它）
        this.selectedRepoId = repoId;
      },
      onOpenRepos: () => void this.repoDialog?.open(),
      // 令牌模式下的仓库名与能力（面板用来显示"仓库令牌模式 · X"与置灰按钮）
      getRepoTokenContext: () => repoTokenContext(this.connHost()),
      notify: (message, kind) => this.setStatus(message, kind ?? 'info'),
    });

    byId<HTMLButtonElement>('btn-export').addEventListener('click', () => {
      this.exportDialog?.open('json');
    });
  }

  // ── 账户（T10.7）──────────────────────────────────────────
  //
  // 分工：
  //   · `AuthSession` 管令牌（持久化 / 静默续期 / 401 恢复），不认识 DOM；
  //   · 这里只管"把状态画到顶栏"和"什么时候弹登录框"；
  //   · 登录/注册界面是 `LoginDialog`，卡片列表是 `CardsDialog`。
  //
  // 硬边界：**登录态的任何变化都不触碰本地会话**。标签、未保存内容、当前编辑位置
  // 属于本地工作，与云端身份无关；这条不是靠调用方记得，而是这几处代码里
  // 根本没有 `sessions` / `closeSession` / `markSaved` 之类的调用。


  /** 浏览器直开（无壳）时的服务端地址兜底，与 `?settings=1&serverUrl=…` 调试参数同源 */
  private applyDebugServerUrl(): void {
    const debugServer = new URLSearchParams(location.search).get('serverUrl');
    if (debugServer !== null && debugServer.trim() !== '') {
      this.authServerUrl = debugServer.trim().replace(/\/+$/, '');
    }
  }

  /**
   * 仓库管理/令牌用的客户端配置。
   *
   * 只有**账户 access 令牌**才返回配置：
   *   · legacy 全局令牌没有账户身份，仓库归谁无从谈起；
   *   · 仓库令牌能读写卡片，但**不能管理仓库或令牌**（服务端会 403，
   *     这里直接返回 null，避免让用户看到一个注定失败的按钮）。
   * 未登录时返回 null → 面板显示"需要先登录账户"。
   */


  /**
   * 仓库令牌模式下要交给同步面板的上下文（v0.1.3 / F5 后半）。
   *
   * 非该模式时返回 null —— 面板据此保持原样（显示选择器与"全部仓库"的语义）。
   * 结构里带 `canXxx` 而不是让面板自己去 `includes('write')`：
   * scope→能力的映射只在 `auth/repo-token.ts` 里定义一份，服务端那边的
   * `requiredScope()` 是它的镜像（测试里交叉断言两者一致）。
   */


  /**
   * 三个同步按钮的可用性（v0.1.3 / F5 后半）。
   *
   * 两条路径的语义不同，所以必须在**同一处**判：
   *   · 账户 / legacy：能连上就全可用（权限由账户角色决定，不由 scope 表达）；
   *   · 仓库令牌：逐个按 scope 置灰 —— 读 → 无上传/回滚；无写 → 无删除/移动。
   *
   * 必须点名"缺哪一档"写在 title 里：这把令牌通常是别人签的，
   * 用户需要知道去要哪一档，而不是自己去猜为什么按钮是灰的。
   */


  /** 账户按钮的文案与状态（唯一一处改它的地方） */


  /**
   * 点账户按钮：已登录进账户面板，否则进登录框。
   *
   * 「我的卡片」也在账户面板里（v0.2.3 拆分）。右上角按钮回答「我是谁」，
   * 第 4 个工具栏按钮回答「我的仓库与令牌」，两个入口不再互相串。
   *
   * v0.1.2 起不再要求「已连上 / 令牌有效」，只要求服务端地址。没有地址时
   * 登录框连 `/api/auth/config` 都问不到，所以直接把用户送到设置页说明原因，
   * 别开一个注定失败的框。
   */
  private async openAccountEntry(): Promise<void> {
    const session = this.authSession;
    if (!session) return;

    /*
     * 仓库令牌模式（v0.1.3 / F5 后半）：点账户按钮仍进卡片列表，和账户模式一致。
     * 「退出令牌模式」放在列表面板里；顶栏按钮一下把连接断掉太容易误触。
     *
     * 地址是进来时用过的，理论上不会丢。但用户可能刚在设置里清过，仍要检查。
     */
    if (session.isRepoTokenMode) {
      if (!hasServerUrl(this.connection?.url ?? this.authServerUrl)) {
        this.setStatus('服务端地址为空：先在设置里填写，再使用仓库令牌。', 'warn');
        void this.settings?.open();
        return;
      }
      await this.cardsDialog?.open();
      return;
    }

    if (!hasServerUrl(this.connection?.url ?? this.authServerUrl)) {
      this.setStatus('先在设置里填写服务端地址（同机可直接点「连接本机服务端」），再登录。', 'warn');
      void this.settings?.open();
      return;
    }
    if (session.currentPhase === 'authenticated' && session.accessToken !== '') {
      await this.accountDialog?.open();
      return;
    }
    await this.loginDialog?.open();
  }

  /**
   * 收到 401 后的统一处置：先试续期，续不上才回登录界面。
   *
   * 返回 true = 已续期成功，调用方可以重试原请求。
   */
  private async handleUnauthorized(): Promise<boolean> {
    const session = this.authSession;
    if (!session) return false;

    const recovered = await session.recoverAfterUnauthorized();
    if (recovered) {
      refreshAccountButton(this.refreshHost());
      void autoProbe(this.connHost());
      return true;
    }

    refreshAccountButton(this.refreshHost());
    // 「回登录界面」= 只打开对话框。刻意不关闭标签、不清除未保存内容：
    // 用户可能正在写一半的角色卡，重新登录这一下不该让他丢工作。
    void this.loginDialog?.open('登录已过期或令牌无效，请重新登录。本地未保存的编辑不会丢失。');
    return false;
  }

  /**
   * 导入装配（T10.9）。
   *
   * 对话框只建一次（它的模式切换要保留状态）；真正的"读文件"由调用方做 ——
   * 对话框不该知道原生能力，这样它能在 Node 里被纯逻辑测试绕过。
   */
  private wireImport(): void {
    this.importDialog = new ImportDialog({
      // 严格/宽松判定需要"导入前的卡"做基线，所以给深拷贝而不是引用
      getCard: () => structuredClone(this.card),
      getPreset: () => this.rules?.preset ?? null,
      // TXT 导入必须按**用户当前选的**初始场景分隔符切分：
      // 他手上的卡可能是别的工具用 === 分段的，按冻结默认切会并成一条。
      getGreetingFormat: () => this.greetingFormat().format,
      // 世界书格式（v0.1.5 / G4）：TXT 卡里的世界书段按当前预设解析
      getWorldbookFormat: () => this.worldbookPreset.format,
    });
  }

  /** 世界书板块内的两个按钮（导入 / 导出），由 createBlock 挂在 worldbook 块里 */


  /** 选一个世界书文件并导入（扩展名决定预期格式，但真正的识别在 shared 里做） */


  /**
   * 当前同步配置：连接通过时才返回（未就绪不构造请求参数） */


  /** 当前是否持有可用凭证（账户令牌或 legacy 全局令牌） */
  private hasCredentials(): boolean {
    return (this.authSession?.accessToken ?? '') !== '' || (this.settingsToken ?? '') !== '';
  }

  /**
   * 同步门槛（v0.1.2 追加任务）：地址 + 凭证，两件事都只看"有没有"。
   * 探测结果不参与判定 —— 否则"刚打开客户端、探测还没回来"会让面板说"未连接"。
   */
  private syncGate(): SyncGateState {
    /*
     * 第三个参数是探测结果（2026-11-17）。
     *
     * memory §105 缺陷 ②：原来这里只传"地址 + 凭证"，于是探测红字
     * ✗ 无法连接 与顶栏绿字 ✓ 同步已就绪 同时出现 —— 两句互斥的话同屏。
     * 探测**明确失败**时必须说那件事。
     */
    return resolveSyncGate(
      this.connection?.url ?? this.authServerUrl,
      this.hasCredentials(),
      this.connection,
    );
  }

  /**
   * 把服务端版本内容载入编辑器。
   *
   * 走 `parseStCard` 而不是直接替换文本：必须经过同一套解析，
   * 否则 anchor / worldbook 结构会与本地不一致，后续编辑就会写错位置。
   */
  /**
   * 把远端版本内容载入编辑器，并把**远端最新 seq** 记成会话基线。
   *
   * `displaySeq` 是给用户看的"这是第几版"，`remoteSeq` 是"现在远端最新是第几版"。
   * 回滚时两者不同（回滚新建了一个版本）：基线必须记后者，否则下一次上传
   * 服务端会拿"我上次传的是 v2"去比"远端最新是 v4"，凭空报一个分叉。
   */
  /**
   * 从服务端拉卡面并替换会话的图源（v0.1.7 修订二）。
   *
   * ## 为什么"服务端没有卡面"时**不清空**本地图
   *
   * 两种解释都说得通：① 服务端是事实源，它没有就该没有；② 用户刚在本地选了
   * 一张图还没上传，清掉等于让他白选一次。
   *
   * 选 ② 的理由是**损失不对称**：保留本地图的代价是"下次上传时会把这张图传上去"
   * （用户看得见、也能改），清空的代价是他得重新找一次图（而且不会被告知为什么没了）。
   * 导出的兜底链本来就能处理"卡面缺失"，所以保留在功能上也安全。
   */




  private dialogState(): DialogState {
    const rules = this.rules;
    return {
      platformId: rules?.platformId ?? DEFAULT_PLATFORM_ID,
      platforms: (rules?.platformFiles ?? []).map((file) => ({ id: file.id, name: file.name })),
      highlightId: rules?.highlightId ?? DEFAULT_HIGHLIGHT_ID,
      highlights: (rules?.highlightFiles ?? []).map((file) => ({ id: file.id, name: file.name })),
      presetId: rules?.preset?.id ?? null,
      presets: describePresets(rules?.presets ?? []),
      previewFor: (presetId) => {
        const preset = rules?.presets.find((item) => item.id === presetId);
        return preset ? previewPresetSelection(this.card, preset) : null;
      },
      decideFor: (presetId) => {
        const preset = rules?.presets.find((item) => item.id === presetId);
        return preset ? decideApplyPreset(this.card, preset) : null;
      },
      worldbookPresetId: this.worldbookPreset.id,
      worldbookPresets: this.worldbookPresets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        builtin: preset.builtin === true,
        summary: `${preset.format.entryOpen.replace('{id}', 'N')} / ${preset.format.contentMark} / ${preset.format.entryClose.replace('{id}', 'N')}`,
      })),
      greetingPresetId: this.greetingPreset.id,
      greetingPresets: this.greetingPresets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        builtin: preset.builtin === true,
        summary: describeFieldPreset(preset),
      })),
      greetingFormatSource: this.greetingFormat().source,
      chatExamplePresetId: this.chatExamplePreset.id,
      chatExamplePresets: this.chatExamplePresets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        builtin: preset.builtin === true,
        summary: `${describeFieldPreset(preset)}${this.exampleTurnsNote(preset)}`,
      })),
    };
  }

  /** 切换平台规则：立即按新规则重检并提醒 */


  /** 切换高亮方案：重新编译 + 重新着色 */


  /**
   * 加载用户预设库，并恢复上次选中的预设（v0.1.5 / G5）。
   *
   * 必须在 `buildRuleset()` **之后**调用 —— 用户预设是"并入候选列表"，
   * 内置那份要先在，同 id 的用户份才能正确覆盖它。
   *
   * 三个设计取舍：
   *   · **逐条失败不打断**：一条坏数据只丢它自己，其余照常加载（库格式层的
   *     容错在 `preset-store`，这里负责"坏了要说出是哪一条"）；
   *   · **不自动切换**：加载只是把候选补齐，用哪个由 config 里的 id 决定 ——
   *     否则用户上次选的高亮会被最后一个导入的盖掉；
   *   · **提示合并成一条**：启动时把 8 条警告逐条 setStatus，用户只会看到最后一条，
   *     等于没提示。
   */


  /**
   * 把库里的一条并进内存列表。**不切换、不提示**（那由调用方决定）。
   *
   * 返回 `null` = 成功；返回字符串 = 失败原因（直接展示给用户）。
   *
   * 为什么不复用 `importXxxText` 那几个方法：它们有的会顺手切换
   * （`importHighlightText` 会 `switchHighlight`），启动时切换就会覆盖
   * config 里记着的选择 —— 那正是这一版要修的问题。
   */


  /**
   * 按 config 里记的 id 恢复六类选择。
   *
   * 返回需要告诉用户的问题（找不到那个预设时）。**找不到就回退内置默认**，
   * 不能因为一个 id 失效就停在半初始化状态 —— 那样用户连"为什么我的规则不对"
   * 都无从查起。
   */


  /**
   * 记下刚导入成功的预设（v0.1.5 / G5）。
   *
   * 三条约束：
   *   · 导入已经生效，**保存失败不回滚**（回滚等于把用户刚导入的东西又删了）；
   *   · 失败必须告知 —— 否则用户以为存好了，重启发现没了；
   *   · 库还没加载完时不写（`presetStoreReady`）：那会把磁盘上已有的预设
   *     连同这次导入一起覆盖成"只有这一条"。
   */


  /** 记录当前选择（切换时调；失败只警告，不影响编辑） */
  private persistSelection(patch: Partial<ClientConfig>): void {
    // 浏览器直开无配置可写 —— 那是预期内的，不该每切一次弹一条警告
    if (!isShellAvailable()) return;
    void configPatch(patch).catch((error: unknown) => {
      this.setStatus(`设置未能保存（下次启动会回到默认）：${describeError(error)}`, 'warn');
    });
  }

  /** 导入 TXT 预设（T10.30）：原子回退 + 同 id 覆盖 + 不自动切换 */


  /** 导入世界书预设（T10.31） */


  private selectWorldbookPreset(id: string): void {
    const preset = this.worldbookPresets.find((item) => item.id === id);
    if (!preset) return;
    this.worldbookPreset = preset;
    /*
     * 所有打开的会话都要换成新格式，并**重解析现有文本**（v0.1.5 / G4）。
     *
     * 只换 `this.worldbookPreset` 是不够的：会话里存着格式，编辑世界书时用它。
     * 更关键的是"文本没变、解析器变了"——不重解析，entries 会停在旧值，
     * 而审计已经按新预设说"没问题"，于是又变成"面板正常、导出丢内容"。
     */
    for (const session of this.sessions) {
      session.setWorldbookFormat(preset.format);
      session.reparseWorldbook();
    }
    // 世界书预设参与解析与格式检查，切换后必须重检 —— 否则面板停在旧口径上
    this.validate();
    refreshRulesLabel(this.refreshHost());
    // 记下选择（v0.1.5 / G5）：否则下次启动又回到默认格式，
    // 而用户的文本是按这套格式写的 —— 表现为"世界书又解析不出来了"
    this.persistSelection({ worldbookPresetId: preset.id });
  }

  private exportTxtPresetById(id: string): string | null {
    const preset = this.rules?.presets.find((item) => item.id === id);
    if (!preset) return null;
    // 导出的是**当前生效的参数**（不是当初导入的原文）：用户可能只想知道
    // "我现在用的到底是什么格式"，而原始文本里可能有不生效的未知键。
    return serializePreset(preset);
  }

  private exportWorldbookPresetById(id: string): string | null {
    const preset = this.worldbookPresets.find((item) => item.id === id);
    return preset ? serializePreset(preset) : null;
  }

  // ── 字段板块预设（v0.1.3 追加项一）────────────────────────────

  /**
   * 「初始场景」当前生效的分隔格式。
   *
   * 唯一入口：导入、导出、TXT 解析、审计、切换预设全部从这里取，
   * 不各自去翻 `greetingPreset`/`rules.preset.greeting` —— 翻两处就会有两套优先级。
   */
  private greetingFormat(): { format: GreetingFormatParams; source: 'greeting-preset' | 'txt-preset' | 'frozen' } {
    return effectiveGreetingFormat(this.greetingPreset, this.rules?.preset?.greeting);
  }

  /**
   * 「对话示例」板块的格式参数（2026-11-11）。
   *
   * ## 与 `greetingFormat()` 是两个东西
   *
   * ```text
   *   greetingFormat()      初始场景：段标题、多条开场白分隔、标签行
   *   chatExamplesFormat()  对话示例：说话人写法（用户：/角色：）、轮次称呼
   * ```
   *
   * ## 为什么必须传下去
   *
   * `mes_example` 存的是 ST 标准写法（`{{user}}:`）。用户在预设里声明了
   * "我的平台用 `用户：`" 之后，**导入时要按它渲染进板块**，否则：
   *
   * ```text
   *   板块里看到   {{user}}:    （ST 写法）
   *   他的规则判   「缺说话人行」（按平台规范判）
   *   ⇒ 卡永远红着，而他找不到原因
   * ```
   *
   * 导出时还要按它反解回 `{{user}}:` —— 否则 `mes_example` 里留下 `用户：`，
   * 而 ST 不认那种写法，整段示例在 ST 里读不到（不报错、只是没有）。
   *
   * 成对使用这条铁律见 `chat-examples-format.ts` 开头。
   */
  private chatExamplesFormat(): GreetingFormatParams {
    return this.chatExamplePreset.format;
  }

  /**
   * 对话示例预设的「当前文本可切成几轮」。
   *
   * 这份预设**不改写正文**（mes_example 原样落盘），所以它的效果只能体现在
   * "怎么读"上 —— 不把这个数字显示出来，用户在面板里就只能看到一句参数描述，
   * 完全不知道选了它有什么用。
   */
  private exampleTurnsNote(preset: FieldPreset): string {
    if (preset.format.separator === '') return ' · 当前不切分';
    if (!this.hasSession) return '';
    const block = this.card.blocks.find((item) => item.id === 'chat-examples');
    const turns = countExampleTurns(block?.text ?? '', preset.format);
    return turns === null ? '' : ` · 当前文本 ${String(turns)} 轮`;
  }



  private fieldPresetOf(block: FieldPresetBlock): FieldPreset {
    return block === 'initial-scene' ? this.greetingPreset : this.chatExamplePreset;
  }

  /**
   * 导入字段板块预设：原子回退 / 同 id 覆盖 在 preset-library 里；
   * **「导入即启用」在这一层补**（2026-11-17，用户报「导入还是不对」）。
   *
   * ## 为什么必须显式启用（这不是体验问题，是 bug）
   *
   * 激活项是**对象引用**（`this.greetingPreset` / `this.chatExamplePreset`），
   * 而 `importFieldPreset` 返回的是**新数组、新对象**：
   *
   * ```text
   *   导入前  greetingPresets = [old]      greetingPreset → old
   *   导入后  greetingPresets = [new]      greetingPreset → old   ← 还指着旧对象！
   *   `effectiveGreetingFormat` 读 greetingPreset ⇒ 格式一个字都没变
   * ```
   *
   * 所以"改了预设文件、重新导入"这个最常见的动作，**效果是零**，
   * 而界面只说「导入成功」—— 用户完全不知道还要去下拉里点一下。
   * 真机取证（2026-11-17）：段标题仍是 `@@开场白`、说话人仍是 `{{user}}:`，
   * 与本轮修好的预设内容完全不符，就是这个原因。
   *
   * ## 为什么新 id 也一起启用
   *
   * 导入一份预设的唯一合理意图就是"用它"；想留作备选的情况极罕见，
   * 而那种情况下下拉里还留着、切回成本很低。反过来，"导入成功却不生效"
   * 会让用户去怀疑代码坏了 —— 这次的排查就这么发生了一次。
   */


  /**
   * 切换字段板块预设。
   *
   * 切换后要做两件事，缺一件用户就会觉得"选了但没反应"：
   *   1. 按新格式重算**未编辑**板块的视图（`refreshFieldBlockViews` 只刷新非 dirty 的）；
   *   2. 重检 —— 分隔行二义、旧格式提示这些都会随格式变化。
   */
  private selectFieldPreset(block: FieldPresetBlock, id: string): void {
    const preset = fieldPresetsOf(this.importHost(), block).find((item) => item.id === id);
    if (!preset) return;
    if (block === 'initial-scene') this.greetingPreset = preset;
    else this.chatExamplePreset = preset;

    if (this.hasSession) {
      const before = this.card;
      /*
       * 两个格式都要给（2026-11-17）。只给 greeting 时，切换「对话示例预设」
       * 对板块文本毫无影响 —— 而这条路径正是"选了下拉但没反应"的来源。
       */
      const refreshed = refreshFieldBlockViews(
        this.card,
        this.greetingFormat().format,
        this.chatExamplesFormat(),
      );
      if (refreshed !== before) {
        // 视图变了就整体重挂一次——板块文本是会话状态的一部分，
        // 只改 DOM 不同步会话，下一次校验读到的还是旧文本。
        this.session.replaceCard(refreshed);
        this.reloadBlocksFromCard();
      }
    }

    this.validate();
    refreshRulesLabel(this.refreshHost());
    this.rulesDialog?.refresh();
    this.setStatus(
      block === 'initial-scene'
        ? `已切换初始场景预设：${preset.name}（${describeFieldPreset(preset)}）`
        : `已切换对话示例预设：${preset.name}（${describeFieldPreset(preset)}）`,
      'ok',
    );
    // 记下选择（v0.1.5 / G5）：两个板块各记各的，否则重启后分隔行变了、
    // 多条开场白会被重新切分
    this.persistSelection(
      block === 'initial-scene'
        ? { greetingPresetId: preset.id }
        : { chatExamplePresetId: preset.id },
    );
  }

  private exportFieldPresetById(block: FieldPresetBlock, id: string): string | null {
    const preset = fieldPresetsOf(this.importHost(), block).find((item) => item.id === id);
    return preset ? serializePreset(preset) : null;
  }

  /** 选择预设（不重排）：只影响导出装配参数 + 格式检查口径 */
  private selectPresetById(id: string): void {    const preset = this.rules?.presets.find((item) => item.id === id);
    if (!preset || !this.rules) return;
    this.rules = { ...this.rules, preset };

    // 预设参与**格式检查**（如「板块间分隔符是否与预设一致」），
    // 所以切预设也必须立即重检——否则面板会停留在旧口径上，
    // 用户看到的结论与实际导出格式不符。
    this.validate();

    const { error, warning } = this.lastSummary;
    this.setStatus(
      `导出格式已切换为「${preset.name}」：原文未改动（要重排请点「应用预设」）` +
        ` · 按当前规则重新检查：错误 ${error} 警告 ${warning}`,
      error > 0 ? 'bad' : warning > 0 ? 'warn' : 'ok',
    );
    // 记下选择（v0.1.5 / G5）
    this.persistSelection({ presetId: preset.id });
  }

  /**
   * 真正落地「应用预设」：**同时**把该预设设为当前预设，再按 plan 重排。
   *
   * 为什么必须一起做：重排是按这个预设的标题/分隔符写的，
   * 若 `rules.preset` 还停在旧预设，导出会按旧格式拼装，
   * 于是"刚重排成 divider，导出的却是 default"——两者不一致。
   */
  private commitPresetApply(preset: TxtPreset, plan: PresetApplyPlan): void {
    if (this.rules) {
      this.rules = { ...this.rules, preset };
    }
    // 换预设要置脏：预设决定导出时的标题与顺序，属于产出的一部分（见 CardSession 注释）
    this.session.replaceCard(applyPresetPlan(this.card, plan));
    this.session.markDirty();
    this.reloadBlocksFromCard();
    this.rulesDialog?.refresh();
    // 重排后按新预设口径立即重检（分隔符/顺序类问题应当消失）
    this.validate();
    refreshRulesLabel(this.refreshHost());
    refreshStats(this.refreshHost());
    this.setStatus(
      `已应用预设「${preset.name}」：${plan.changes.join('；') || '标题样式已重排'} · 已按新格式重检`,
      'ok',
    );
  }

  /** 导入平台规则：校验 + 原子回退都在 rule-library 里 */


  /** 导入高亮方案：同样原子回退，且必须能编译 */




  /** 卡片被整体替换（应用预设 / 打开文件）后重建板块视图 */
  private reloadBlocksFromCard(): void {
    for (const runtime of this.blocks) {
      collapse(this.blockHost(), runtime);
      runtime.section.remove();
    }
    // 清掉空工作台留下的占位块。
    // 只删 this.blocks 里的板块是不够的 —— 空工作台那个 .empty-workspace 不在
    // this.blocks 里，于是"从零标签新建一张卡"之后它会残留在编辑区中间
    // （2026-10-22 截图里同时出现空占位与八个板块，就是这个原因）。
    this.blockList.replaceChildren();
    this.blocks = collectBlocks(this.card).map((snapshot) => createBlock(this.blockHost(), snapshot));
    /*
     * 「角色提示词」板块（2026-11-17，用户要求"桌面端开一个板块专门编辑角色提示词"）。
     *
     * ## 为什么排在最后、且不是 `BlockId`
     *
     * 它存的是 `data.extensions.tcs.prompts` —— **我们自己的扩展键**，
     * 不是 ST 卡字段。硬塞进 `BLOCK_IDS` 会让它进 `TEXT_BLOCK_IDS`，
     * 而那条链会把内容拼进 `description`（角色描述里凭空多出提示词）。
     * 详见 `prompts-panel.ts` 顶部。
     *
     * 放在最后一位：前八块是"卡里写了什么"，这一块是"这个角色额外怎么说话"，
     * 读的顺序也是先内容后调优。
     */
    const panel = this.ensurePromptsPanel();
    if (panel !== null) this.blockList.append(panel.el);
    // `?expand=all` 全展开；`?expand=chat-examples,initial-scene` 只展开指定板块。
    //
    // 后者是为 v0.1.3 的截图验收加的：要拍「新板块展开编辑」就必须只展开
    // 那两块 —— 用 all 会连带展开其余六块，截图里分不清是哪个板块在编辑。
    // 逗号分隔的 id 会被静默过滤掉不认识的项（调试入口，不值得为拼错报错）。
    const expandParam = new URLSearchParams(location.search).get('expand');
    const expandAll = expandParam === 'all';
    const explicitExpand = new Set(
      (expandParam === null || expandAll ? '' : expandParam)
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== ''),
    );
    // 首屏只展开前两个板块（懒渲染红线：常驻 CM6 实例数 = DEFAULT_EXPANDED_COUNT）。
    // 新增的两个板块在第 6、7 位，天然折叠 —— 见 block-doc.ts 的注释与单测。
    const defaultExpanded = new Set(defaultExpandedBlockIds(this.blocks.map((runtime) => runtime.snapshot)));
    for (const runtime of this.blocks) {
      const shouldExpand =
        expandAll || explicitExpand.has(runtime.snapshot.id) || (explicitExpand.size === 0 && defaultExpanded.has(runtime.snapshot.id));
      if (shouldExpand) expand(this.blockHost(), runtime, true);
    }
    refreshStats(this.refreshHost());
    this.renderCardName();
  }

  /**
   * 惰性创建「角色提示词」板块（只创建一次，之后每次重绘只重新挂载 + 刷新）。
   *
   * 为什么不在构造里建：构造时 `this.session` 还不一定有卡（空工作台）。
   * 为什么只创建一次：滚动位置与展开态是 DOM 状态，每次都新建会让
   * 用户刚滚到的那条提示词跳回顶部 —— 而这块正好是"要滚着改很多条"的界面。
   */
  private ensurePromptsPanel(): PromptsPanel | null {
    if (!this.hasSession) return null;
    if (this.promptsPanel === null) {
      this.promptsPanel = createPromptsPanel({
        getConfig: () => this.session.readCharacterPrompts(),
        /*
         * 写回走 session：它内部再判一次上限并置脏。
         *
         * 返回 false 时**组件会保留原样**（不刷新）—— 用户看到的是
         * "输入框里还是我刚写的内容"，同时下面那条违规提示说的是为什么。
         * 刷新掉会让他以为自己的输入被吞了。
         */
        onChange: (next) => {
          const accepted = this.session.updateCharacterPrompts(next);
          if (accepted) {
            this.setStatus('已更新角色提示词（记得保存或导出）', 'ok');
            refreshStats(this.refreshHost());
            this.scheduleValidate(0);
          } else if (!this.session.hasCharacterPrompts() || !this.sessionPromptsWithinLimits()) {
            /*
             * 走到这里有两种可能，必须分开说：
             *   · 超上限被拒 → 明确告诉他"没保存"
             *   · 没改动     → 不吭声（点一下复选框又点回来不该弹提示）
             */
            this.setStatus('角色提示词超出上限，这次改动没有保存', 'warn');
          }
          return accepted;
        },
        logError: (line) => this.crashLogger?.record('error', new Error(line), this.sessionSummary()),
      });
    } else {
      this.promptsPanel.refresh();
    }
    return this.promptsPanel;
  }

  /** 当前卡的角色提示词是否在上限内（给状态提示用） */
  private sessionPromptsWithinLimits(): boolean {
    try {
      return promptsWithinLimits(this.session.readCharacterPrompts());
    } catch {
      return true;
    }
  }

  // ── 设置与同步可用性（T6.8）──────────────────────────────
  //
  // 关键原则：同步是"可选的增强"，网络问题不得影响本地编辑。
  // 因此这里做三件事：① 顶栏状态胶囊；② 同步条按钮启用/禁用；③ 最多一次自动探测。


  /**
   * 预览场景驱动（仅测试/截图用，正常启动不触发）。
   *
   * 为什么需要它：F8 的故障形态是「同步不返回」，单元测试（Node 里跑纯函数）
   * 抓不到这类问题 —— 必须真的在浏览器里点一次、并确认点击能返回。
   * 这里只做「点按钮 + 读 DOM」，不伪造任何业务状态。
   */


  /** 启动时探测一次已保存的配置；失败静默（不打扰编辑） */


  /**
   * 把连接结果映射到界面：胶囊 + 同步提示。
   *
   * v0.1.2 追加任务：**三个同步入口不再置灰**，也不再出现「鉴权未通过」。
   * 旧逻辑用 `isSyncReady(result)`（= 探测到 token 有效）当门禁，于是"还没登录"
   * 被显示成「鉴权未通过」、"没配地址"被显示成「未连接」—— 两种状态都说错了对象。
   * 现在胶囊只描述**连接**（未配置 / 未连接 / 已连接·未登录 / 已连接），
   * 同步能力由 `syncGate()` 交给面板自己说明。
   */
  private applyConnection(result: ProbeResult | null): void {
    this.connection = result;

    const chip = byId('conn-chip');
    const text = byId('conn-text');
    const hint = byId('sync-hint');
    const phase = this.authSession?.currentPhase ?? 'anonymous';
    const label = connectionLabel(result?.url ?? this.authServerUrl, result, phase);

    chip.className = `conn-chip ${label.tone}`;
    text.textContent = label.text;
    chip.title = `服务端连接状态：${label.text}（账号仅决定能做什么，不是连接的前提）`;

    // 按钮可用性不在这里定：账户/legacy 路径是"全部可用"，仓库令牌路径要按
    // scope 置灰。两个语义都在 applyScopeGating 里，只在一处写。
    applyScopeGating(this.blockHost());

    const gate = this.syncGate();
    const summary = syncHintText(gate, result?.cardCount ?? null);
    hint.textContent = summary.text;
    hint.className = `sync-hint ${summary.tone}`;
    // 端到端断言用：不靠读文案判断门槛
    document.body.dataset['syncGate'] = gate;
  }

  // ── 构造 ────────────────────────────────────────────────


  // ── 展开 / 折叠（懒渲染核心）──────────────────────────────
  private toggle(runtime: BlockRuntime): void {
    if (runtime.expanded) collapse(this.blockHost(), runtime);
    else expand(this.blockHost(), runtime);
  }





  // ── 编辑 → 校验 ──────────────────────────────────────────


  /**
   * 验收入口（v0.1.5 / G3-2）：把一段世界书文本**真实地**喂进编辑器。
   *
   * 用途：截图证明"外来格式的世界书会被拦"与"正常世界书不拦"。
   *
   * 走的是真实的 `session.setBlockText`（解析器、脏标记、校验调度全都真的跑），
   * 不是伪造界面状态 —— 输入由脚本代劳，行为完全真实。
   * 文案上标明"验收样本"，避免看截图的人以为这是他的真实卡。
   *
   * @param kind `foreign` = 用户报障那种 `【条目N：…】` 格式；`good` = 标准 @@ENTRY
   */


  /**
   * 世界书"常驻"误报取证（v0.1.5 / G7）。
   *
   * 走**真实路径**：导入用户的世界书预设 → 切到它 → 导入他的平台规则 → 切过去
   * → 把 19 条世界书文本写进面板（`onBlockChange`，与手动粘贴同一条链路）
   * → 审计。所以截图上的"错误 0"是算出来的，不是摆出来的。
   *
   * 三段与演示相关的取舍：
   *   · 夹具 fetch 自 `g7/*.json`（用户内容不进仓库、不进包）；
   *   · `demoQuiet` 期间不写预设库 —— 浏览器里写盘必然失败，会刷一条与
   *     本取证无关的警告，掩盖真正要看的那几个数字；
   *   · 世界书面板展开，否则截图只能看到折叠标题。
   */
  /**
   * 「格式不匹配被误报成解析不出」取证（v0.1.6 / 缺陷一，决策 #235–#237）。
   *
   * 两张图对同一张卡、同一个自定义世界书预设，只差"有没有做到达规范化"：
   *
   *   `?arrivalDemo=before`  复现旧行为：解析时**不传**当前世界书格式（
   *                          文本按内置默认写法渲染），且**跳过** arriveCard ——
   *                          于是世界书块显示 `@@ENTRY …`、审计按自定义预设解析
   *                          ⇒ `worldbook-no-entry-marker`（1 错误）
   *   `?arrivalDemo=after`   走现行路径：`parseStCard(…, { worldbookFormat })`
   *                          + `arriveCard` 规范化 ⇒ 文本已按当前预设重排，0 错误
   *
   * 为什么 before 要绕过 `replaceCard`：那不是"伪造界面"，而是**精确复现旧代码
   * 的那两条路**（旧 `parseStCard` 调用不传格式、旧 `replaceCard` 没有规范化）。
   * 用假数据摆一张"报错截图"才叫伪造；这里每一步都是真的在跑解析与审计。
   *
   * 卡本身取自 `examples/`（标准 ST 卡，仓库里的公开样本），不涉及用户内容。
   */




  private scheduleValidate(delay: number): void {
    if (this.validateTimer !== null) window.clearTimeout(this.validateTimer);
    this.validateTimer = window.setTimeout(() => {
      this.validateTimer = null;
      this.validate();
    }, delay);
  }

  private validate(): void {
    if (!this.rules) return;
    // T6.5：一次审计产出完整报告，面板与编辑器标记共用同一份数据，
    // 避免"面板显示 3 条、编辑器画 5 条"这类两处各算一次导致的不一致。
    const report = buildAuditReport(this.card, {
      // 世界书格式按当前预设解析：自定义预设下的文件不该被报"标记不闭合"
      worldbookFormat: this.worldbookPreset.format,
      platformRule: this.rules.platform,
      preset: this.rules.preset,
    });
    this.report = report;
    this.issues = report.issues;
    this.lastSummary = {
      error: report.summary.error,
      warning: report.summary.warning,
      info: report.summary.info,
    };

    if (this.auditPanel) {
      this.auditPanel.setReport(report);
      // 标题栏只放一个短状态，详细摘要由面板自己渲染（避免同一句话出现两次）
      this.issueSummary.textContent =
        report.issues.length === 0 ? '无问题' : `${report.issues.length} 条`;
      this.issueSummary.className = `issue-summary ${
        report.summary.error > 0 ? 'bad' : report.issues.length > 0 ? 'warn' : 'ok'
      }`;
    }
    refreshBlockBadges(this.refreshHost(), report.issues);
    // 顶栏计数必须跟着报告走，否则会出现"顶栏 错误 0 / 面板 错误 1"
    refreshStats(this.refreshHost());
    // 已挂载的编辑器同步标记：修正后这里会收到空数组，高亮即时消失
    for (const runtime of this.blocks) {
      runtime.editor?.setIssues(this.issuesFor(runtime.snapshot.id));
    }
  }

  /**
   * 定位到某条问题（面板点击 / 字数条点击都走这里）。
   * 位置信息**完全取自报告**：编辑器只负责把 start/end 变成选区。
   */
  private locateIssue(issue: AuditIssue): void {
    const { blockId, start, end } = issue.location;
    if (!blockId) {
      this.setStatus('该问题不属于任何板块（全文级统计），无法定位到具体位置', 'warn');
      return;
    }
    const runtime = this.blocks.find((b) => b.snapshot.id === blockId);
    if (!runtime) return;

    this.activeIssueId = issue.id;
    expand(this.blockHost(), runtime, true);
    runtime.editor?.focusRange(start, end);
    this.auditPanel?.setActiveIssue(issue.id);
  }

  private issuesFor(blockId: BlockId): EditorIssue[] {
    return this.issues
      .filter((issue) => issue.location.blockId === blockId)
      .map((issue) => ({
        id: issue.id,
        severity: issue.severity,
        message: issue.message,
        start: issue.location.start,
        end: issue.location.end,
      }));
  }

  // ── 渲染：统计 / 徽标 / 问题列表 ──────────────────────────





  // ── 角色名就地编辑（F10）──────────────────────────────────
  //
  // 为什么必须改 meta.name 而不是只改显示文本：导出 JSON 的角色名取自 meta.name。
  // 之前顶栏只是个只读 div，用户永远改不到 meta.name，导出的 JSON 里角色名
  // 就一直是最初那个样例名 —— 这是 F10 要根治的问题。
  //
  // 与【基本信息】板块里的「姓名」行不双写：meta.name 是唯一数据源，
  // 正文里的姓名由用户自己维护（面板会给 info 级提示，但不强制同步，也不回写）。


  /**
   * 刷新「← 点这里改角色名」提示（v0.1.2 反馈项四 / T10.29）。
   *
   * 三个条件同时成立才显示：**有一张卡**（零标签时角色名显示的是"未打开角色卡"，
   * 点它没有意义）、**用户还没点过**（localStorage 记录）、**不在编辑态**。
   * 第一次判定在启动时做，切换会话/新建打开后也调一次 —— 否则从零标签进入一张卡
   * 之后提示永远不出现（零标签那次被第一条挡住了）。
   */


  /** 用户点了角色名（或提示本身）→ 永久隐藏。写失败也先隐藏本次会话。 */
  private hideNameHint(): void {
    const hint = byId<HTMLElement>('card-name-hint');
    if (hint.hidden) {
      // 已经隐藏时也要落一次存储：用户可能在启动瞬间就点了，而那时 refresh 还没跑
      dismissNameHint(browserHintStore());
      return;
    }
    hint.hidden = true;
    dismissNameHint(browserHintStore());
  }

  // ── 异常日志（T10.26）──────────────────────────────────────

  /**
   * 装全局 `error` / `unhandledrejection` 捕获。
   *
   * 会话摘要现取现拼（而不是缓存在某个字段里）：异常可能发生在会话重建的中间态，
   * 缓存值那时一定是过期的，而"过期值"会让人按错的卡去排查。
   */
  installCrashLogging(): void {
    this.crashLogger = createCrashLogger({
      write: (entry) => {
        // 契约调用；壳里同步落盘（open + write + sync_all）。
        // 浏览器直开时 isShellAvailable() 为 false，这里什么都不做 ——
        // 硬调 invoke 会抛，而它抛出来的错误会再进一次日志，形成回声。
        if (!isShellAvailable()) return;
        return appendClientErrorLog(entry).then(
          (path) => {
            this.lastErrorLogPath = path;
          },
          () => {
            // 落盘失败不能反过来变成新异常（见 crash-log.ts 文件头第 2 条）
          },
        );
      },
      userAgent: navigator.userAgent,
    });

    this.crashUninstall = installGlobalErrorHandlers(this.crashLogger, () => this.sessionSummary());
  }

  /** 会话摘要。**只给数量与 ID，绝不含卡片正文**（日志会被导出并发给别人）。 */
  sessionSummary(): { openCards: number; activeCardId: string | null } {
    return {
      openCards: this.sessions.length,
      activeCardId: this.hasSession ? this.session.cardId : null,
    };
  }

  /**
   * 导出诊断日志（T10.26）：client-error.log + 版本号 + 连接状态 → 单个 txt。
   *
   * 三个契约能力串起来：读日志（C1）→ 选保存路径（C6）→ 原子写（C2）。
   * 失败要在返回的那句话里说清是哪一步，否则用户只知道"没导出成功"。
   */
  async exportDiagnostics(): Promise<string> {
    const now = new Date();
    let logText: string | null = null;
    let logError: string | undefined;
    const logPath = this.lastErrorLogPath;

    if (logPath !== null) {
      try {
        // 用户可能在两次运行之间删过日志文件 —— 读不到不算失败，导出文件里写明
        logText = (await readTextExact(logPath)).text;
      } catch (error) {
        logError = describeError(error);
      }
    } else {
      logError = '本次使用期间还没有记录到错误（没有出现异常，或日志文件写入失败）';
    }

    const info = await shellInfo().catch(() => null);
    const text = buildDiagnosticsText({
      logText,
      ...(logError === undefined ? {} : { logError }),
      appVersion: appVersion(),
      shellVersion: info?.version ?? '(不可用)',
      shellMode: info?.mode ?? '(不可用)',
      connection: this.connectionChipText(),
      authPhase: this.authSession?.currentPhase ?? 'anonymous',
      session: this.sessionSummary(),
      now,
      userAgent: navigator.userAgent,
    });

    const target = await pickSavePath(suggestDiagnosticsFileName(now), 'txt');
    if (!target) return '已取消导出诊断日志';

    try {
      await writeFileAtomic(target, text);
    } catch (error) {
      return `导出失败：写入被拒绝（${describeError(error)}）`;
    }
    return `诊断日志已导出：${target}（${String(text.length)} 字符）`;
  }

  /** 顶栏状态胶囊当前那句话（诊断日志里要的是用户看到的那句，不是另造一套） */
  private connectionChipText(): string {
    const text = byId('conn-text').textContent ?? '';
    return text === '' ? '未知' : text;
  }

  /**
   * 全局快捷键（T9.9）：Ctrl+N 新建 / Ctrl+W 关标签 / Ctrl+Tab 切换。
   *
   * **决策在 `editor/shortcuts.ts` 的纯函数里**（`decideShortcut`），这里只负责
   * 采集三样现场状态（是否在输入、有没有弹窗、有几个标签）并执行结果。
   * 这样"空工作台按 Ctrl+W 会不会有反应""编辑器里按 Ctrl+W 关不关标签"
   * 都能被单测钉住，而不是靠手点。
   *
   * 为什么挂在 `window` 的**捕获阶段**：CodeMirror 6 会自己处理大量按键，
   * 冒泡到 document 时可能已经被它消费。捕获阶段能抢在它之前判断，
   * 而我们只对三个组合生效，其余键一律放行 —— 不拦用户正常输入。
   *
   * 键位冲突（已核实，见 `shortcuts.ts` 文件头）：
   *   · CM6 `defaultKeymap` 里没有 `Mod-w` / `Mod-n` / `Mod-Tab`，三者都不冲突；
   *   · 被 CM6 占用的是**不带修饰键**的 `Tab`（插入缩进），与 Ctrl+Tab 是两回事；
   *   · wry 的 `browser_accelerator_keys` 默认 `true`（Tauri 未覆盖），
   *     所以 WebView2 的加速键是开着的 —— Ctrl+W 一律 `preventDefault`，
   *     不让它有机会走浏览器的默认行为。
   */
  private wireShortcuts(): void {
    window.addEventListener(
      'keydown',
      (event) => {
        const intent = decideShortcut({
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          editing: this.isEditingText(),
          modalOpen: this.isModalOpen(),
          tabCount: this.sessions.length,
        });

        // null = 与我们无关，绝不 preventDefault（否则会吞掉 Ctrl+A 这类通用键）
        if (intent === null) return;
        if (intent.preventDefault) event.preventDefault();

        switch (intent.type) {
          case 'new-card':
            void this.newCard();
            return;
          case 'close-tab':
            if (this.activeId) void this.closeSession(this.activeId);
            return;
          case 'switch-tab':
            this.cycleSession(intent.delta);
            return;
          case 'editor-took-key':
            // 不关标签，只解释为什么没反应 —— 静默无响应会让人以为快捷键坏了
            this.setStatus(intent.hint, 'info');
            return;
        }
      },
      // capture：抢在 CodeMirror 的处理器之前
      true,
    );
  }

  /**
   * 当前焦点是否在"打字的地方"：编辑器、就地改名输入框、或任何输入控件。
   *
   * 判 `closest('.cm-editor')` 而不是 `editor.hasFocus()`：后者只认 CM6 自己的
   * 焦点，判不到"就地改名"那个 input，而那里同样是打字场景。
   */
  private isEditingText(): boolean {
    const active = document.activeElement;
    if (!active || !(active instanceof HTMLElement)) return false;
    if (active.closest('.cm-editor')) return true;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return true;
    return active.isContentEditable;
  }

  /**
   * 是否有打开着的模态框。
   *
   * 判 `.modal-overlay:not([hidden])` 而不是记一个布尔量：弹窗的开关散落在
   * 五六个组件里（设置 / 新建 / 同步 / 导出 / 规则 / 关闭确认），
   * 各自维护标志位迟早漏一个，而从 DOM 读是唯一不会失真的来源。
   */
  private isModalOpen(): boolean {
    return document.querySelector('.modal-overlay:not([hidden])') !== null;
  }

  /** 按 delta 切换标签，到边界回绕（Ctrl+Tab 从最后一个跳到第一个） */
  private cycleSession(delta: 1 | -1): void {
    if (this.sessions.length < 2) return;
    const index = this.sessions.findIndex((item) => item.id === this.activeId);
    if (index === -1) return;
    const next = (index + delta + this.sessions.length) % this.sessions.length;
    this.activateSession(this.sessions[next]!.id);
  }

  /** 把当前 meta.name 渲染到顶栏（空值显示「未命名」） */
  private renderCardName(): void {
    // 用 textContent 而不是 innerHTML：角色名来自用户/导入文件，是纯文本
    byId('card-name').textContent = this.card.meta.name || '(未命名)';
    // 提示跟着"当前有没有卡"走：零标签时角色名显示"未打开角色卡"，
    // 那时提示"点这里改角色名"是假的（点了也没有可改的名字）。
    refreshNameHint(this.refreshHost());
  }

  /**
   * 写入角色名并联动。
   *
   * 允许空值（F10.1）：清空后审计会按既有语义报「角色名不能为空」，
   * 显示层回退「未命名」。这里不做"必须非空"的拦截 —— 那会让
   * "先清空再重打" 这种很自然的改名方式走不通。
   */
  private applyCardName(name: string): void {
    if (this.card.meta.name === name) {
      this.renderCardName();
      return;
    }
    this.session.setName(name);
    this.renderCardName();
    // 标签栏文字联动（F10 + T9.2）：改名后活动标签即时刷新。
    // 注意走 refreshTabs 而不是 tabs.refresh —— 后者需要传入重读的数据，
    // 写错会变成「调了刷新但文字没变」。
    this.refreshTabs();
    // 审计要立刻重算：name 是多数平台的必填项，改完必须马上反映到面板上。
    // 用 0 延迟而不是走防抖，因为这是"一次确定的操作"，不是连续输入。
    this.scheduleValidate(0);
  }

  // ── 工具条：打开 / 另存 / 预览 ────────────────────────────
  private wireToolbar(): void {
    const openButton = byId<HTMLButtonElement>('btn-open');
    const saveButton = byId<HTMLButtonElement>('btn-save');
    const previewButton = byId<HTMLButtonElement>('btn-preview');
    const shell = isShellAvailable();

    if (!shell) {
      openButton.disabled = true;
      saveButton.disabled = true;
      openButton.title = '浏览器模式：请在桌面客户端内使用';
      saveButton.title = '浏览器模式：请在桌面客户端内使用';
    }

    const newButton = byId<HTMLButtonElement>('btn-new');
    newButton.addEventListener('click', () => void this.newCard());
    openButton.addEventListener('click', () => void openCard(this.openHost()));
    saveButton.addEventListener('click', () => void saveCard(this.saveHost()));
    previewButton.addEventListener('click', () => this.togglePreview());

    /*
     * 「在 SillyTavern 中测试」（v0.1.5 / F15）。
     *
     * 浏览器模式禁用：它要扫主目录、拉进程、写 ST 的 characters 目录，
     * 这里**没有一条能力**在浏览器里存在。不禁用的话，用户点下去会看到
     * "检测失败：SHELL_BRIDGE_ERROR"，而真正的原因是"你在浏览器里"。
     */
    const stButton = byId<HTMLButtonElement>('btn-st');
    if (!shell) {
      stButton.disabled = true;
      stButton.dataset['browserDisabled'] = '1';
      stButton.title = '浏览器模式：请把本地 SillyTavern 推送到桌面客户端里用';
    }
    /*
     * 顶栏按钮 → 右侧常驻面板（v0.1.6 / T14.3）。
     *
     * v0.1.5 时它打开的是四状态对话框（"装没装 / 起没起"）。现在主入口换成面板：
     * 用户点这个按钮的意图十有八九是"我要边写边看"，而不是"我要配置"。
     * 配置那条路没丢 —— 面板底部的「安装 / 启动向导」还是那个对话框。
     */
    stButton.addEventListener('click', () => void this.toggleStPane());
  }

  /**
   * 右侧 ST 面板（懒构造）。
   *
   * 回调都很薄：地址只从壳拿、推送走 `st-push.ts` 那唯一一条链路、
   * 宽度记忆进配置（C5）。这里不放 ST 相关判断 —— 那些在可单测的纯逻辑里。
   */


  /** 顶栏按钮：开着就收起，收起/关着就打开 */
  private async toggleStPane(): Promise<void> {
    if (!this.hasSession) {
      this.setStatus('先打开一张角色卡，再在 SillyTavern 里看效果', 'warn');
      return;
    }
    const pane = ensureStPane(this.stPushHost());
    await pane.toggle();
    // 代理状态在壳里是单例，这里同步一次是为了"面板被外部关掉后按钮仍准确"
    if (!pane.isOpen) return;
    try {
      const status = await stProxyStatus();
      if (!status.running) this.setStatus('本地代理没在跑：点「重新加载」再试一次', 'warn');
    } catch {
      // 状态查询失败不该拦住"面板已经开了"这个事实
    }
  }

  /**
   * 收起 / 展开往返取证（v0.1.6 真机缺陷四）。
   *
   * 走**真实按钮**（`[data-role="st-pane-toggle"]` 的 click 事件），
   * 而不是直接调 `setCollapsed` —— 缺陷就是按钮绑定写死方向，
   * 绕过按钮等于绕过缺陷，那样截出来的图永远是对的。
   *
   * 断言三件事：折叠后是条宽、点一下能展开、展开宽度回到记忆值。
   */


  /**
   * ST 的 characters 目录（推送落点）。
   *
   * 与四状态对话框共用 `locateSt`：检测规则写两份的下场是"对话框说装了、
   * 面板说没装"，而两边各自的单测都绿（F15 期间踩过同类）。
   */


  /**
   * 打开 ST 面板（延迟构造）。
   *
   * 三个回调刻意都很薄：角色名决定文件名、JSON 走既有导出管线、
   * 路径记忆写进配置（C5）。这里不放任何 ST 相关的判断 ——
   * 那些都在 `session/st-install.ts`（可单测）。
   */
  private async openStDialog(): Promise<void> {
    if (!this.hasSession) return;
    this.stDialog ??= new StDialog({
      notify: (message, kind) => this.setStatus(message, kind ?? 'info'),
      getCardName: () => this.session.card.meta.name,
      getCardId: () => this.session.cardId,
      buildStPush: () => buildStPushArtifact(this.stPushHost()),
      rememberPath: (path) => this.rememberStPath(path),
    });
    await this.stDialog.open();
  }

  /**
   * 生成要推送给 ST 的**PNG 角色卡**（v0.1.5 / G8，需求 T13.5 的"复用导出管线"）。
   *
   * ## 为什么从 JSON 改成 PNG（决策 #212）
   *
   * G8 现场：`西奥.json` 落盘正确、ST 的「导入角色卡」也能成功，但**角色目录扫描器
   * 始终不显示它**（刷新、重启都无效）—— ST 1.18 的文件夹扫描只认 PNG 卡；
   * UI 导入是另一条代码路径，它认 JSON，于是很容易被误判成"JSON 可用"。
   * 用户现有的角色全部是 PNG，这也印证了那条规则。
   *
   * ## 卡面从哪来（与 v0.1.4 导出的优先级一致，不在推送面板里再弹选择）
   *
   * `resolveSaveFace()` 就是「另存为 PNG」用的那条链：
   * 会话原图（零重编码）→ 上次记住的图库封面 → 内置默认卡面。
   * 复用它的好处不只是省一段代码：**同一个用户动作（保存 / 推送）产出的封面不会不一样**。
   *
   * 唯一的额外判定是「世界书会不会丢内容」（G3-2 的硬阻断）：那种情况下
   * 推过去的卡在世界书里是空的，而用户会以为"推成功了"。
   *
   * 审计 error 不拦：这是"拿去 ST 里看看效果"的入口，草稿阶段本来就有问题 ——
   * 拦下来等于把 ST 变成又一个导出闸门。
   */


  /** 记住用户选过的 ST 目录（C5） */
  private async rememberStPath(path: string): Promise<void> {
    try {
      await configPatch({ stPath: path });
    } catch (error) {
      // 记不住不拦住推送：路径只是"下次不用再选"，不是功能前提
      this.setStatus(`ST 目录未能记住（下次仍可重新选）：${describeError(error)}`, 'warn');
    }
  }

  /**
   * 新建角色卡（F1 + F11）。
   *
   * 流程：F11 对话框拿「角色名 + 角色卡 ID」→ 按当前预设装配空卡 →
   * 把 ID 写进卡数据 → 载入编辑器。
   *
   * 空卡也要写入 ID：否则这张卡在保存/上传时会被当成"没有 ID 的外部卡"
   * 又生成一个新的，用户在对话框里看到的 ID 就白显示了。
   */
  // ── 多标签：切换 / 关闭 / 空工作台（T9.2–T9.4）──────────────

  /** 把会话集合投影成标签数据。标签栏不持有状态，每次重绘都重读一遍。 */
  private tabItems(): TabItem[] {
    return this.sessions.map((session) => ({
      id: session.id,
      label: session.label,
      displayName: session.displayName,
      cardId: session.cardId,
      persisted: session.persisted,
    }));
  }

  /**
   * 重读会话集合并刷新标签栏。
   *
   * 走 `render` 而不是 `refresh`：这里的调用点**既可能是集合变化**（新建/关闭）
   * **也可能只是内容变化**（改名/置脏）。`render` 会按 id 比对，多余的删、缺的补、
   * 现有的就地更新 —— 两种场景都覆盖，而 `refresh` 只处理后者。
   * 统一走一条路径，避免"某个调用点用错了刷新方法"这类只在特定操作后复现的 bug。
   */
  private refreshTabs(): void {
    if (!this.tabs) return;
    this.tabs.render(this.tabItems(), this.activeId);
  }

  /**
   * 切换活动会话。
   *
   * 关键：**内容在 CardSession 里，UI 只是它的投影**。所以切换时不需要
   * "把编辑器内容存回会话再载入另一张" —— 会话里本来就是最新的。
   * 只需把当前 UI 拆掉、按新会话重建，这也正是 T6.1 的懒渲染原则。
   */
  private activateSession(id: string): void {
    if (id === this.activeId) return;
    if (!this.sessions.some((item) => item.id === id)) return;

    // 先把当前 UI 的编辑器全部销毁（折叠即销毁），再换会话重建
    for (const runtime of this.blocks) {
      collapse(this.blockHost(), runtime);
      runtime.section.remove();
    }
    this.blocks = [];
    this.activeIssueId = null;

    this.activeId = id;
    this.mountActiveSession();
    this.refreshTabs();
  }

  /**
   * 按活动会话重建编辑器与面板。
   *
   * 零标签走 `renderEmptyWorkspace()` —— F3 要求「空工作台」与「零标签」
   * 是同一套渲染，所以这里只有一条分支，不存在两套界面。
   */
  private mountActiveSession(): void {
    const has = this.hasSession;
    // 零标签时把所有"需要一张卡"的入口禁用。
    // 不做这件事的话，点「导出」会在 this.session 上抛错（它明确要求有活动会话）。
    // 「打开」「新建」永远可用 —— 它们正是从零标签里出来的路。
    this.setCardActionEnabled(has);

    if (!has) {
      this.renderEmptyWorkspace();
      return;
    }
    document.body.dataset['workspace'] = 'card';
    this.reloadBlocksFromCard();
    this.renderCardName();
    // 每个会话有自己的规则选择，切换后要把规则/预设下拉同步过来
    this.syncRulesUiToSession();
    this.scheduleValidate(0);
  }

  /**
   * 启用/禁用「需要一张卡」的顶栏与同步按钮。
   *
   * 同步三个按钮本来由连接状态控制，这里只处理"零标签"这一维：
   * 有卡时把控制权交回 applyConnection，无卡时统一禁用。
   */
  private setCardActionEnabled(enabled: boolean): void {
    // btn-st 是 v0.1.5 / F15 的 ST 入口：零标签时同样没有"当前卡"可推
    for (const id of ['btn-save', 'btn-preview', 'btn-export', 'btn-rules', 'btn-st', 'btn-card-info']) {
      const node = document.getElementById(id) as HTMLButtonElement | null;
      if (node && !node.dataset['browserDisabled']) node.disabled = !enabled;
    }
    if (!enabled) {
      for (const id of ['btn-upload', 'btn-history', 'btn-rollback']) {
        const node = document.getElementById(id) as HTMLButtonElement | null;
        if (node) node.disabled = true;
      }
    } else {
      // 有卡了，让连接状态重新决定同步三键的可用性
      this.applyConnection(this.connection);
    }
  }

  /**
   * 空工作台（F3）。
   *
   * 与「零标签」是**同一个渲染路径**：启动时不打开任何卡、关闭最后一个标签后，
   * 都走到这里。这样就不存在"启动界面"和"零标签界面"两套东西各自演化、
   * 最后长得不一样的问题。
   */
  private renderEmptyWorkspace(): void {
    document.body.dataset['workspace'] = 'empty';
    this.blockList.replaceChildren();

    const empty = el('div', 'empty-workspace');
    const title = el('p', 'empty-title', '还没有打开任何角色卡');
    const hint = el('p', 'empty-hint', '新建一张空白卡，或从磁盘打开已有卡片。');

    const actions = el('div', 'empty-actions');
    const newBtn = el('button', 'btn primary', '新建角色卡');
    newBtn.type = 'button';
    newBtn.addEventListener('click', () => void this.newCard());
    const openBtn = el('button', 'btn', '打开角色卡…');
    openBtn.type = 'button';
    openBtn.addEventListener('click', () => void openCard(this.openHost()));
    actions.append(newBtn, openBtn);

    empty.append(title, hint, actions);
    this.blockList.append(empty);

    // 顶栏与统计清空，避免残留上一张卡的信息
    byId('card-name').textContent = '未打开角色卡';
    byId('stats').textContent = '';
    // 零标签没有可改的名字，"点这里改角色名"必须收起来（T10.29）
    refreshNameHint(this.refreshHost());
    this.issueSummary.replaceChildren();
    this.auditPanel?.clear();
    this.setStatus('空白工作台：新建或打开一张角色卡开始', 'info');
  }

  /**
   * 关闭标签（T9.4 的三选确认在 T9.4 里补，这里先处理无脏标记的主路径）。
   *
   * 关闭后的活动标签选择规则：优先右侧相邻，没有则左侧 ——
   * 这是浏览器标签的通行行为，用户不需要重新找位置。
   */
  private async closeSession(id: string): Promise<void> {
    const index = this.sessions.findIndex((item) => item.id === id);
    if (index === -1) return;
    const session = this.sessions[index]!;

    // 有未落盘修改时先问用户（三选：保存并关闭 / 不保存关闭 / 取消）
    if (session.dirty) {
      const decision = await confirmClose(session);
      if (decision === 'cancel') return;
      if (decision === 'save') {
        const saved = await saveSessionToDisk(this.saveHost(), session);
        if (!saved) return; // 保存失败或用户取消保存对话框 → 中止关闭
      }
    }

    this.sessions.splice(index, 1);

    if (this.activeId === id) {
      const next = this.sessions[index] ?? this.sessions[index - 1] ?? null;
      this.activeId = next?.id ?? null;
      // 先清掉旧 UI，再按新会话（或空工作台）重建
      for (const runtime of this.blocks) {
        collapse(this.blockHost(), runtime);
        runtime.section.remove();
      }
      this.blocks = [];
      this.mountActiveSession();
    }

    this.refreshTabs();
  }

  /** 三选确认：保存并关闭 / 不保存关闭 / 取消 */


  /**
   * 只打开格式选择框（截图/验收用，不写盘）。
   *
   * `forcePngDisabled` 用来演示"浏览器里 PNG 不可用"那种态 —— 真实环境下
   * 它由 `askSaveFormat` 探测卡面能否取得来判定。
   */


  /**
   * 保存指定会话到磁盘（另存为语义）。
   *
   * **只改会话状态**：路径、格式与脏标记都写在 session 上，app.ts 不再有游离字段。
   * 这是 T9.2 一并要求的「另存为只改会话状态」。
   *
   * v0.1.5 / G6：支持三种格式（ST JSON / TXT / PNG 卡），产物与「导出」**完全一致**
   * —— 两条链路共用 `buildExportAsync`，不各拼一份。格式记到会话上，此后 Ctrl+S
   * 沿用它（否则另存为 PNG 之后保存会往 `.png` 写 JSON）。
   */


  /**
   * 问格式（v0.1.5 / G6）。
   *
   * 为什么每次都问（而不是"直接按会话格式存"）：另存为本身就是"我要存成另一种"
   * 的动作。想跳过就勾「以后都用这个格式」，那时不再问。
   */


  /** 解析"这张卡自己的封面"（原图 > 图库记住的那张 > 内置默认） */
  /**
   * 导出 PNG 前的同名撞名守卫（v0.1.7 增补三）。
   *
   * 决策与执行都在 `save-target-guard.ts`（依赖注入、12 项测试），这里只把
   * 壳能力拼进去。**判据是 PNG 里嵌的 `extensions.tcs.cardId`，不是文件名** ——
   * 这条在本项目已经用到第六次（推送、审计、取回…），每次的诱惑都是
   * "同名就当同一张"，而那个假设在"两张卡都叫西奥"时立刻出事。
   *
   * ## `isNewer` 的判据链（2026-10-29 补齐 stat 后）
   *
   * "本地这份是不是被外部改过" = `当前 mtime > 上次与本客户端同步时的 mtime`。
   *
   * 基线存在 `ClientConfig.fileBaselines`（键是归一化路径），
   * 在**每次成功读写**之后更新 —— 所以它记的是"我们最后一次碰它的时候它多大年纪"。
   * 三个不判脏的情况（没有基线 / 取不到 mtime / 文件反而变旧）见 `file-baseline.ts` 文件头。
   *
   * 失败一律当"不脏"：这条判据的作用是**多问一句**，不是拦路。
   * 它自己出错时让人正常导出，比让人导不出去好。
   */




  /** 把会话的规则选择同步到界面（切换标签后调用） */
  private syncRulesUiToSession(): void {
    // 规则面板从 session 读当前选择，这里只需让它重绘
    this.rulesDialog?.refresh();
  }

  private async newCard(): Promise<void> {
    if (!this.newCardDialog) this.newCardDialog = new NewCardDialog();

    // 已占用的 ID 全都要传进去，不只是当前这张 —— 重复 ID 提示是对整个标签栏而言的
    const openIds = this.sessions.map((item) => item.cardId);
    const request = await this.newCardDialog.open({ openIds });
    if (!request) return;

    const preset = this.rules?.preset ?? null;
    // createEmptyCard 给出八板块骨架（从 BLOCK_IDS 派生）；预设决定导出时的标题与顺序（docs/15 §1），
    // 但空卡阶段没有正文，所以这里只需要把骨架建出来。
    const blank = createEmptyCard(request.name);
    /*
     * 套用「新卡默认值」（v0.1.6）。
     *
     * 位置在 `createEmptyCard` 之后、`withCardId` 之前：默认值只补元数据
     * （作者 / 版本 / 创作说明 / 标签 / 系统提示），不碰 name 与世界书字段，
     * 所以先有一张完整的卡，再给它身份，顺序上更直观。
     */
    const withDefaults = applyDefaults(blank, this.cardDefaults);
    const withId = withCardId(withDefaults, request.cardId);

    // 新建 = 追加一个会话（而不是替换当前卡）。这是 F1 与 F2 的结合点：
    // 用户点「+」是想再开一张，不是想把手上这张扔掉。
    const session = new CardSession({
      card: withId,
      cardId: request.cardId,
      platformId: this.rules?.platformId,
      highlightId: this.rules?.highlightId,
      presetId: preset?.id ?? null,
      filePath: null,
      // 世界书格式（v0.1.5 / G4）：编辑世界书时按用户选中的预设解析
      worldbookFormat: this.worldbookPreset.format,
    });
    this.sessions.push(session);
    this.activeId = session.id;

    // 切换过去：把旧 UI 拆掉、按新会话重建
    for (const runtime of this.blocks) {
      collapse(this.blockHost(), runtime);
      runtime.section.remove();
    }
    this.blocks = [];
    this.mountActiveSession();
    this.refreshTabs();
    this.setStatus(
      `已新建「${request.name || '未命名'}」· ID ${request.cardId}（尚未保存到磁盘）`,
      'ok',
    );
  }

  /** 当前卡的角色卡 ID：优先读卡数据里已存的，没有就按角色名生成 */
  private currentCardId(): string {
    return readCardIdFromCard(this.card) ?? generateCardId(this.card.meta.name);
  }

  /**
   * 截图用的演示卡面字节：取内置默认卡面（它就在仓库里，浏览器里走 fetch）。
   *
   * 不用 `readDefaultFace()`：那是 IPC，浏览器里没有壳。
   * 取不到就返回 null —— 调用方按"没有演示数据"处理，不会因此崩。
   */
  private async loadDemoFaceBytes(): Promise<Uint8Array | null> {
    try {
      const response = await fetch('resources/card-face-default.png');
      if (!response.ok) return null;
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      return null;
    }
  }



  /**
   * 打开 PNG 卡（v0.1.4 / T12.4，决策 #165）。
   *
   * 三条分支，都**不是错误**：
   *   1. 有 `ccv3` → 按 V3 读；
   *   2. 只有 `chara` → 按 V2 读；
   *   3. 两个都没有 → "这是一张图片，不是卡"。此时**不报错**，而是把它作为
   *      这张卡的封面候选（F3 的原话），零标签则以文件名建一张空卡承载它 ——
   *      否则"按图片导入为卡面"没有落点。
   *
   * 第 3 条很关键：ST 生态里"拿一张立绘当头像"是常见动作，
   * 如果它被当成"导入失败"，用户会以为自己选错了文件。
   */


  /**
   * 零标签时按文件名建一个空会话（v0.1.2 反馈项三）。
   *
   * 为什么名字要从文件名推：零标签下没有"当前卡"可参照，而 `meta.name` 会写进
   * 导出的 JSON，也是标签栏唯一能显示的东西。用文件名至少让人认得出这是哪个文件。
   *
   * 返回新卡的名字（调用方要放进状态栏 —— "我建了一张卡"这件事必须说出来，
   * 否则用户会以为只是打开了文件，不知道标签栏为什么多了一个）。
   */
  private createSessionFromFile(path: string): string {
    const name = deriveCardNameFromFile(path, this.sessions.map((item) => item.card.meta.name));
    // 同一个规则：从「打开文件」进来的新卡也该带作者名等元数据
    return this.createSessionWithCard(
      applyDefaults(createEmptyCard(name), this.cardDefaults),
      generateCardId(name),
    );
  }

  /**
   * 覆盖前的确认（只有在目标标签**有未保存修改**时才问）。
   *
   * ## 为什么要问
   *
   * 同名覆盖会整卡替换，`replaceCard` 会 markSaved 把脏标记清掉 ——
   * 用户刚编辑的内容就此消失，而且**没有任何提示**。旧版"打开即替换"
   * 本来就有这个洞，只是一直没人踩到（因为打开任何卡都会替换，用户学会了
   * 先保存）。现在覆盖变成"同名才发生"，反倒是**意外触发**更可能 ——
   * 用户以为在开新标签，结果撞上同名。
   *
   * ## 为什么不做"保存了再覆盖"
   *
   * 那不是用户此刻的意图（他想打开这个文件）。给两选：覆盖 / 取消。
   * 想保留旧内容就取消、先另存，再打开。
   */


  /**
   * 「打开」路径的**唯一落点**：同名覆盖，异名新建（2026-11-17）。
   *
   * ## 为什么需要
   *
   * 旧行为是"打开即 `replaceCard`"——把当前标签的内容整个换掉。用户原话：
   *
   * > 点打开选择一张新的卡的时候会自动替换当前的卡的内容，打开应该检查是否与
   * > 已打开的卡名字相同，如果不同就创建新卡并导入，如果有相同的才覆盖替换
   *
   * 多标签编辑器的常识预期是"打开＝新开一个"，覆盖只是同名时的特例。
   * 判定逻辑在 `session/open-target.ts`（纯函数，有判据）；这里只负责执行。
   *
   * ## 覆盖时的两个动作
   *
   * ```text
   * ① 同名的那张不在当前标签 → 先 activateSession 切过去
   *    不切的话表现为"我点了打开，界面完全没变"（改的是看不见的另一个标签）
   * ② replaceCard —— 它内含到达规范化 + markSaved + 重挂界面 + 重检
   * ```
   *
   * ## 新建时不沿用旧会话的 cardId
   *
   * 卡里带 `cardId`（同一个角色卡的多个副本）就沿用它 —— 那是卡的身份，
   * 换掉会让服务端历史分叉；卡里没有才按名字生成。
   *
   * @param fallbackName 卡里没有名字时用它兜底（通常是文件路径）
   */


  /**
   * 打开 TXT 角色卡（2026-11-17）：**先判同名，再决定导入到哪张卡**。
   *
   * ## 为什么 TXT 要单独一条路
   *
   * TXT 里没有 `meta.name` 字段 —— 卡名只能从**文件名**推导（与零标签建卡
   * 同一规则，见 `open-name.ts`）。所以判定必须在"读完文本、还没建会话"时做：
   *
   * ```text
   * 同名已打开  → 切到那张，导入进它（覆盖语义）
   * 没有同名    → 先建空会话再导入（新建语义）
   * ```
   *
   * ## 为什么导入对话框仍然以"当前卡"为 base
   *
   * `previewCardText(base, ...)` 用 base 补齐 TXT 里没识别到的板块。
   * 所以"覆盖"时 base 必须是**那张同名卡**（否则会把另一张卡的内容
   * 混进来）；"新建"时 base 是刚建的空卡 —— 两者都通过先切/先建来满足。
   */
  private async openTextCard(fileName: string, text: string, dir: string): Promise<void> {
    // 不去重地推一次名字，用于"是否有同名卡"的判断
    const incomingName = deriveCardNameFromFile(fileName);
    const target = decideOpenTarget({
      incomingName,
      openSessions: this.sessions.map((item) => ({ id: item.id, name: item.card.meta.name })),
      activeId: this.hasSession ? this.activeId : null,
    });

    let createdSession: string | null = null;
    if (target.kind === 'replace') {
      if (target.sessionId !== this.activeId) this.activateSession(target.sessionId);
    } else {
      createdSession = this.createSessionFromFile(fileName);
    }

    /*
     * 后缀交给 `importCardTextFile` 拼在它自己的结论后面（而不是在这里
     * 再 setStatus 一次盖掉它）—— 那句结论带着"多少原文被放到了哪里"，
     * 是用户真正需要读的内容。
     */
    const outside = dir !== '' && !fileName.toLowerCase().startsWith(dir.toLowerCase());
    const note =
      (target.kind === 'replace' ? `（已覆盖同名卡「${target.name}」）` : '') +
      (outside ? ` —— 该文件不在卡片目录内，另存时会回到 ${dir}` : '');
    await importCardTextFile(this.openHost(), fileName, text, createdSession, false, note);
  }

  /**
   * **新建标签的唯一入口**（v0.1.3 追加项三；2026-11-17 用途扩展）。
   *
   * 三条路共用它，不各写一份：
   *   · 「打开…」选了 TXT（`createSessionFromFile`）—— 名字从文件名推；
   *   · 「打开…」的卡名与所有已开标签都不同（`openArrivedCard`）——
   *     名字用卡里的 `meta.name`；
   *   · 同步面板零标签「取回 / 回滚」—— 名字与 cardId 都来自服务端那张卡。
   *
   * 后两条**必须沿用卡里已有的 cardId**（本函数的 `cardId` 参数由调用方决定）：
   * 若按名字重新生成，下一次「上传当前内容」会在服务端新建一张卡，而原卡
   * 历史还留着 —— 两份历史从此分叉，且没有任何提示
   * （`planRemoteApply` 的注释里写了这条）。
   *
   * 返回新卡的名字（调用方要放进状态栏 —— "我建了一张卡"这件事必须说出来）。
   */
  private createSessionWithCard(card: UnifiedCard, cardId: string): string {
    const preset = this.rules?.preset ?? null;
    // 零标签取回/打开也走同一条到达规范化（缺陷一）
    const stamped = withCardId(arriveCard(this.landingHost(), card), cardId);

    const session = new CardSession({
      card: stamped,
      cardId,
      platformId: this.rules?.platformId,
      highlightId: this.rules?.highlightId,
      presetId: preset?.id ?? null,
      filePath: null,
    });
    this.sessions.push(session);
    this.activeId = session.id;

    // 与 newCard() 一样：旧 UI 拆掉，按新会话重建
    for (const runtime of this.blocks) {
      collapse(this.blockHost(), runtime);
      runtime.section.remove();
    }
    this.blocks = [];
    this.mountActiveSession();
    this.refreshTabs();
    return stamped.meta.name;
  }

  /**
   * 「另存为…」按钮。
   *
   * 与 closeSession 的「保存并关闭」**共用同一个实现**（saveSessionToDisk）：
   * 两处各写一遍的话，路径/脏标记的更新迟早会有一边漏掉。
   * 注意它改的只是**会话状态**（session.filePath / dirty），
   * app.ts 里没有任何文件路径字段。
   */


  private togglePreview(): void {
    for (const runtime of this.blocks) {
      if (!runtime.expanded) continue;
      runtime.previewOn = !runtime.previewOn;
      runtime.preview.hidden = !runtime.previewOn;
      if (runtime.previewOn) this.renderPreview(runtime);
      else runtime.preview.replaceChildren();
    }
  }

  private renderPreview(runtime: BlockRuntime): void {
    if (!this.rules) return;
    const fragment = buildPreviewFragment(
      runtime.snapshot.text,
      this.rules.highlight,
      { blockId: runtime.snapshot.id },
    );
    runtime.preview.replaceChildren(fragment);
  }

  /**
   * TXT 角色卡导入（T10.9）。
   *
   * 与「打开 JSON」分开的原因：TXT 导入有三种结果（成功 / 宽松补空 / 严格中止），
   * 必须让用户在对话框里看到问题并选择模式，不能悄悄替换掉当前卡。
   *
   * 严格模式下用户还可以就地切到宽松 —— docs/06 的两模式语义靠这个切换实现，
   * 而不是"严格失败就报个错结束"。
   *
   * `createdSession`（v0.1.2 反馈项三）：零标签打开时由调用方先建好会话，
   * 传进来是为了在状态栏那句里带上"新建了哪张卡"——否则用户只看到"已导入"，
   * 不知道标签栏那个新标签是哪来的。
   */


  /**
   * 世界书导入（T10.9）。
   *
   * 破坏性操作：**替换**整个世界书板块（entries + 文本）。所以：
   *   · 对话框必须报出条目数（让用户知道覆盖了多少）；
   *   · `preview.canImport === false` 时一律不写回 —— 残缺结果会把
   *     "没解析出来的条目"当成"用户删除"，一次导入能清空整个世界书。
   */


  /** 导出世界书（双向的另一半）。`format` 由用户选，走同一个保存对话框 */
  private async exportWorldbookFile(format: 'json' | 'txt'): Promise<void> {
    if (!this.hasSession) return;
    try {
      const result = exportWorldbookText(this.card, format, this.session.worldbookSource, this.worldbookPreset.format);
      const suggested = suggestWorldbookFileName(this.card, format);
      const dir = await effectiveCardsDir();
      const path = await pickSavePath(suggested, format, dir === '' ? undefined : dir);
      if (!path) return;
      const receipt = await writeFileAtomic(path, result.text);
      this.setStatus(
        `已导出世界书：${path}（${String(receipt.bytesWritten)} 字节）` +
          (result.verbatim
            ? ' —— 内容未改动，逐字节写回原文'
            : ` —— ${result.reason ?? '已按当前设置重新生成'}`),
        result.verbatim ? 'ok' : 'warn',
      );
    } catch (error) {
      this.setStatus(`导出世界书失败：${describeError(error)}`, 'bad');
    }
  }

















  /**
   * 功能
   * 预设导入的接入点。实现在 `import-actions.ts`。
   *
   * 注意事项
   * 四个预设集合都可写（导入就是往里塞）。`demoQuiet` 只读 ——
   * 它控制"取证期间不落盘"，那个开关属于启动参数，不属于导入。
   *
   * 踩过的坑
   * `worldbookPresets`（全部）与 `worldbookPreset`（当前选中）是两个字段，
   * 名字差一个 s。只声明一个编译能过，但语义是错的。
   */
  private importHost(): ImportHost {
    const self = this;
    return {
      get greetingPresets() { return self.greetingPresets; },
      set greetingPresets(next) { self.greetingPresets = next; },
      get chatExamplePresets() { return self.chatExamplePresets; },
      set chatExamplePresets(next) { self.chatExamplePresets = next; },
      get worldbookPresets() { return self.worldbookPresets; },
      set worldbookPresets(next) { self.worldbookPresets = next; },
      get worldbookPreset() { return self.worldbookPreset; },
      set worldbookPreset(next) { self.worldbookPreset = next; },
      get rules() { return self.rules; },
      set rules(next) { self.rules = next; },
      get rulesDialog() { return self.rulesDialog; },
      get importDialog() { return self.importDialog; },
      get presetStore() { return self.presetStore; },
      get presetStoreReady() { return self.presetStoreReady; },
      get demoQuiet() { return self.demoQuiet; },
      get card() { return self.card; },
      get session() { return self.session; },
      get hasSession() { return self.hasSession; },
      setStatus: (message, kind) => self.setStatus(message, kind),
      refreshRulesLabel: () => refreshRulesLabel(self.refreshHost()),
      reloadBlocksFromCard: () => self.reloadBlocksFromCard(),
      scheduleValidate: (delay) => self.scheduleValidate(delay ?? 0),
      selectFieldPreset: (block, id) => self.selectFieldPreset(block, id),
      switchHighlight: (id) => switchHighlight(self.refreshHost(), id),
      validate: () => self.validate(),
    };
  }

  /**
   * 功能
   * 板块操作的接入点。实现在 `block-actions.ts`。
   *
   * 注意事项
   * `blocks` 与 `blockList` 是两个东西：前者是运行时数组（遍历用），
   * 后者是容器节点（挂载用）。别只给一个。
   *
   * 踩过的坑
   * 无。
   */
  private blockHost(): BlockHost {
    const self = this;
    return {
      get blocks() { return self.blocks; },
      get blockList() { return self.blockList; },
      get card() { return self.card; },
      get rules() { return self.rules; },
      get session() { return self.session; },
      get authSession() { return self.authSession; },
      refreshStats: () => refreshStats(self.refreshHost()),
      refreshTabs: () => self.refreshTabs(),
      scheduleValidate: (delay) => self.scheduleValidate(delay ?? 0),
      issuesFor: (blockId) => self.issuesFor(blockId),
      exportWorldbookFile: (format) => self.exportWorldbookFile(format),
      toggle: (runtime) => self.toggle(runtime),
      importHost: () => self.importHost(),
    };
  }

  /**
   * 功能
   * 界面刷新的接入点。实现在 `ui-refresh.ts`。
   *
   * 注意事项
   * `rules` 与 `settingsToken` 可写（两个 switch* 会改）；其余只读。
   * `toolbarStats` 声明成非空 —— 它是索引页的常驻节点。
   *
   * 踩过的坑
   * 第一版把 `blocks` 写成 `unknown[]`、`toolbarStats` 写成 `unknown`，
   * `refreshBlockBadges` 里遍历时连锁报 30 多个错。**类型要去抄字段声明。**
   */
  private refreshHost(): RefreshHost {
    const self = this;
    return {
      get blocks() { return self.blocks; },
      get issues() { return self.issues; },
      get lastSummary() { return self.lastSummary; },
      get rules() { return self.rules; },
      set rules(next) { self.rules = next; },
      get settings() { return self.settings; },
      get settingsToken() { return self.settingsToken; },
      set settingsToken(next) { self.settingsToken = next; },
      get authServerUrl() { return self.authServerUrl; },
      set authServerUrl(next) { self.authServerUrl = next; },
      get authSession() { return self.authSession; },
      get hasSession() { return self.hasSession; },
      get toolbarStats() { return self.toolbarStats!; },
      setStatus: (message, kind) => self.setStatus(message, kind),
      validate: () => self.validate(),
      issuesFor: (blockId) => self.issuesFor(blockId),
      persistSelection: (patch) => self.persistSelection(patch),
      applyConnection: (result) => self.applyConnection(result as never),
      blockHost: () => self.blockHost(),
    };
  }

  /**
   * 功能
   * 取证/预览场景的接入点。实现在 `preview-scenarios.ts`。
   *
   * 注意事项
   * 只有两个字段：`blocks`（判展开数）与 `stPane`（世界书演示）。
   * 这个 host 越窄越好 —— 它服务的代码只在带 URL 参数启动时跑。
   *
   * 踩过的坑
   * 无。
   */
  private previewHost(): PreviewHost {
    const self = this;
    return {
      get blocks() { return self.blocks; },
      get stPane() { return self.stPane; },
      setStatus: (message, kind) => self.setStatus(message, kind),
      validate: () => self.validate(),
      blockHost: () => self.blockHost(),
    };
  }

  /**
   * 功能
   * 预设恢复的接入点。实现在 `preset-restore.ts`。
   *
   * 注意事项
   * 八个字段**全部可写** —— 恢复就是往它们上面赋值。名字只差一个 s 的两对
   * （greetingPreset/greetingPresets、worldbookPreset/worldbookPresets）都要，
   * 少一个不会报错，但恢复会失效。
   *
   * 踩过的坑
   * 无。
   */
  private presetRestoreHost(): PresetRestoreHost {
    const self = this;
    return {
      get rules() { return self.rules; },
      set rules(next) { self.rules = next; },
      get greetingPreset() { return self.greetingPreset; },
      set greetingPreset(next) { self.greetingPreset = next; },
      get greetingPresets() { return self.greetingPresets; },
      set greetingPresets(next) { self.greetingPresets = next; },
      get chatExamplePreset() { return self.chatExamplePreset; },
      set chatExamplePreset(next) { self.chatExamplePreset = next; },
      get chatExamplePresets() { return self.chatExamplePresets; },
      set chatExamplePresets(next) { self.chatExamplePresets = next; },
      get worldbookPreset() { return self.worldbookPreset; },
      set worldbookPreset(next) { self.worldbookPreset = next; },
      get worldbookPresets() { return self.worldbookPresets; },
      set worldbookPresets(next) { self.worldbookPresets = next; },
      get sessions() { return self.sessions; },
    };
  }

  /**
   * 功能
   * 三块面板接线的接入点。实现在 `wiring.ts`。
   *
   * 注意事项
   * 25 个成员：7 个对话框实例（懒建后复用，所以要可写）、4 个账号状态、
   * 14 个转发动作。`blockHost` / `refreshHost` 是转手 ——
   * 那两个模块各自已有 host，这里只透传入口。
   *
   * 踩过的坑
   * 三个动作的真实形状与我第一版猜的不同：
   * `handleUnauthorized` 返回 `Promise<boolean>`（true = 已恢复可重试）、
   * `exportDiagnostics` 返回 `Promise<string>`（导出的文本）、
   * `offerCertTrust` 收一个 `serverUrl` 参数。
   * **写 host 接口前必须 grep 方法签名。**
   */
  private wireHost(): WireHost {
    const self = this;
    return {
      get authSession() { return self.authSession; },
      set authSession(next) { self.authSession = next; },
      get authServerUrl() { return self.authServerUrl; },
      set authServerUrl(next) { self.authServerUrl = next; },
      get card() { return self.card; },
      get connection() { return self.connection; },
      get accountDeleteDialog() { return self.accountDeleteDialog; },
      set accountDeleteDialog(next) { self.accountDeleteDialog = next; },
      get loginDialog() { return self.loginDialog; },
      set loginDialog(next) { self.loginDialog = next; },
      get repoDialog() { return self.repoDialog; },
      set repoDialog(next) { self.repoDialog = next; },
      get accountDialog() { return self.accountDialog; },
      set accountDialog(next) { self.accountDialog = next; },
      get cardsDialog() { return self.cardsDialog; },
      set cardsDialog(next) { self.cardsDialog = next; },
      get settings() { return self.settings; },
      set settings(next) { self.settings = next; },
      get syncDialog() { return self.syncDialog; },
      set syncDialog(next) { self.syncDialog = next; },
      setStatus: (message, kind) => self.setStatus(message, kind),
      applyCardName: (name) => self.applyCardName(name),
      renderCardName: () => self.renderCardName(),
      hideNameHint: () => self.hideNameHint(),
      applyConnection: (result) => self.applyConnection(result as never),
      autoProbe: () => autoProbe(self.connHost()),
      currentSyncConfig: () => currentSyncConfig(self.connHost()),
      exportDiagnostics: () => self.exportDiagnostics(),
      handleUnauthorized: () => self.handleUnauthorized(),
      offerCertTrust: (serverUrl) => offerCertTrust(self.connHost(), serverUrl),
      openAccountEntry: () => self.openAccountEntry(),
      repoClientConfig: () => repoClientConfig(self.connHost()),
      repoTokenContext: () => repoTokenContext(self.connHost()),
      blockHost: () => self.blockHost(),
      refreshHost: () => self.refreshHost(),
    };
  }

  /**
   * 功能
   * 打开卡片的接入点。实现在 `open-actions.ts`。
   *
   * 注意事项
   * 3 个对话框实例可写（懒建后复用），其余只读。
   * `worldbookPreset.format` 的**真实类型是结构化的 `WorldbookFormatParams`**，
   * 不是字符串 —— 写成 string 会让 parseStCard 的入参报错。
   *
   * 踩过的坑
   * `createSessionWithCard` 返回的是新会话的 id（string），我第一版写成 void，
   * 于是 `readCardIdFromCard(...) ?? generateCardId(name)` 的结果没法传下去。
   */
  private openHost(): OpenHost {
    const self = this;
    return {
      get card() { return self.card; },
      get session() { return self.session; },
      get hasSession() { return self.hasSession; },
      get sessions() { return self.sessions; },
      get activeId() { return self.activeId; },
      get worldbookPreset() { return self.worldbookPreset; },
      get cardInfoDialog() { return self.cardInfoDialog; },
      set cardInfoDialog(next) { self.cardInfoDialog = next; },
      get exportDialog() { return self.exportDialog; },
      set exportDialog(next) { self.exportDialog = next; },
      get importDialog() { return self.importDialog; },
      set importDialog(next) { self.importDialog = next; },
      setStatus: (message, kind) => self.setStatus(message, kind),
      openTextCard: (fileName, text, dir) => self.openTextCard(fileName, text, dir),
      arriveCard: (card) => arriveCard(self.landingHost(), card),
      activateSession: (id) => self.activateSession(id),
      replaceCard: (card) => self.replaceCard(card),
      reloadBlocksFromCard: () => self.reloadBlocksFromCard(),
      scheduleValidate: (delay) => self.scheduleValidate(delay ?? 0),
      createSessionFromFile: (path) => self.createSessionFromFile(path),
      createSessionWithCard: (card, cardId) => self.createSessionWithCard(card as never, cardId),
      greetingFormat: () => self.greetingFormat(),
      chatExamplesFormat: () => self.chatExamplesFormat(),
    };
  }

  /**
   * 功能
   * ST 推送与演示场景的接入点。实现在 `st-push.ts`。
   *
   * 注意事项
   * `stPane` 与 `demoQuiet` 可写：前者懒建，后者是演示期间临时置位的开关。
   * 其余只读。
   *
   * 踩过的坑
   * `worldbookPreset` 要声明成真的 `WorldbookPreset`，不能用 unknown ——
   * 演示里要读 `.format`。
   */
  private stPushHost(): StPushHost {
    const self = this;
    return {
      get card() { return self.card; },
      get blocks() { return self.blocks; },
      get session() { return self.session; },
      get hasSession() { return self.hasSession; },
      get rules() { return self.rules; },
      get worldbookPreset() { return self.worldbookPreset; },
      get crashLogger() { return self.crashLogger; },
      get report() { return self.report; },
      get demoQuiet() { return self.demoQuiet; },
      set demoQuiet(next) { self.demoQuiet = next; },
      get stPane() { return self.stPane; },
      set stPane(next) { self.stPane = next; },
      setStatus: (message, kind) => self.setStatus(message, kind),
      openStDialog: () => self.openStDialog(),
      sessionSummary: () => self.sessionSummary(),
      greetingFormat: () => self.greetingFormat(),
      chatExamplesFormat: () => self.chatExamplesFormat(),
      selectWorldbookPreset: (id) => self.selectWorldbookPreset(id),
      saveHost: () => self.saveHost(),
      blockHost: () => self.blockHost(),
      importHost: () => self.importHost(),
      refreshHost: () => self.refreshHost(),
      reloadBlocksFromCard: () => self.reloadBlocksFromCard(),
      replaceCard: (card) => self.replaceCard(card),
      validate: () => self.validate(),
    };
  }

  /**
   * 功能
   * 落地路径的接入点。实现在 `landing.ts`。
   *
   * 注意事项
   * `arriveCard` 是到达规范化的唯一入口：打开卡、导入 TXT、取回服务端版本、
   * 回滚四条路都过它。`landingHost` 里 `sessions` 必须给全 ——
   * `applyRemoteText` 要靠它找"这张卡在哪个标签"。
   *
   * 踩过的坑
   * `worldbookPreset.format` 是结构化的 `WorldbookFormatParams`，不是字符串。
   */
  private landingHost(): LandingHost {
    const self = this;
    return {
      get session() { return self.session; },
      get hasSession() { return self.hasSession; },
      get sessions() { return self.sessions; },
      get worldbookPreset() { return self.worldbookPreset; },
      setStatus: (message, kind) => self.setStatus(message, kind),
      replaceCard: (card) => self.replaceCard(card),
      createSessionWithCard: (card, cardId) => self.createSessionWithCard(card, cardId),
      currentSyncConfig: () => currentSyncConfig(self.connHost()),
      greetingFormat: () => self.greetingFormat(),
      chatExamplesFormat: () => self.chatExamplesFormat(),
    };
  }

  /**
   * 功能
   * 连接配置的接入点。实现在 `connection.ts`。
   *
   * 注意事项
   * `connection` / `certAckedOrigins` / `certAsking` / `authServerUrl` /
   * `lastFaceChoice` / `settingsToken` 都可写 —— 探测与证书询问会改它们。
   *
   * 踩过的坑
   * 无。
   */
  private connHost(): ConnHost {
    const self = this;
    return {
      get authSession() { return self.authSession; },
      get authServerUrl() { return self.authServerUrl; },
      set authServerUrl(next) { self.authServerUrl = next; },
      get connection() { return self.connection; },
      set connection(next) { self.connection = next; },
      get certAckedOrigins() { return self.certAckedOrigins; },
      set certAckedOrigins(next) { self.certAckedOrigins = next; },
      get certAsking() { return self.certAsking; },
      set certAsking(next) { self.certAsking = next; },
      get lastFaceChoice() { return self.lastFaceChoice; },
      set lastFaceChoice(next) { self.lastFaceChoice = next; },
      get settingsToken() { return self.settingsToken; },
      set settingsToken(next) { self.settingsToken = next; },
      setStatus: (message, kind) => self.setStatus(message, kind),
      applyConnection: (result) => self.applyConnection(result as never),
    };
  }

  /**
   * 功能
   * 预设库的接入点。实现在 `library-actions.ts`。
   *
   * 注意事项
   * `presetStoreReady` 可写 —— `loadPresetLibrary` 读完库要把它置真，
   * 那是"允许写盘"的闸门。
   *
   * 踩过的坑
   * 无。
   */
  private libraryHost(): LibraryHost {
    const self = this;
    return {
      get greetingPresets() { return self.greetingPresets; },
      set greetingPresets(next) { self.greetingPresets = next; },
      get chatExamplePresets() { return self.chatExamplePresets; },
      set chatExamplePresets(next) { self.chatExamplePresets = next; },
      get worldbookPresets() { return self.worldbookPresets; },
      set worldbookPresets(next) { self.worldbookPresets = next; },
      get rules() { return self.rules; },
      set rules(next) { self.rules = next; },
      get presetStore() { return self.presetStore; },
      get presetStoreReady() { return self.presetStoreReady; },
      set presetStoreReady(next) { self.presetStoreReady = next; },
      setStatus: (message, kind) => self.setStatus(message, kind),
      importHost: () => self.importHost(),
      presetRestoreHost: () => self.presetRestoreHost(),
    };
  }

  /**
   * 功能
   * 保存管线的接入点。实现在 `save-actions.ts`。
   *
   * 注意事项
   * `session` / `sessions` / `rules` / `lastFaceChoice` / `saveFormatDialog`
   * 都是编辑器持有的核心状态，模块只读；`saveFormatDialog` 可写 ——
   * 懒建一次后复用，不要每次都 new。
   *
   * 踩过的坑
   * 无。
   */
  private saveHost(): SaveHost {
    const self = this;
    return {
      get session() { return self.session; },
      get sessions() { return self.sessions; },
      get hasSession() { return self.hasSession; },
      get rules() { return self.rules; },
      get lastFaceChoice() { return self.lastFaceChoice; },
      get saveFormatDialog() { return self.saveFormatDialog; },
      set saveFormatDialog(next) { self.saveFormatDialog = next; },
      setStatus: (message, kind) => self.setStatus(message, kind),
      refreshTabs: () => self.refreshTabs(),
      renderCardName: () => self.renderCardName(),
      greetingFormat: () => self.greetingFormat(),
      chatExamplesFormat: () => self.chatExamplesFormat(),
    };
  }

  /**
   * 卡片到达的唯一规范化入口（v0.1.6 生产缺陷一 / 决策 #236）。
   *
   * ## 它修的是什么
   *
   * 服务器取回一张标准格式的卡（世界书是 `@@ENTRY … @@CONTENT`），而当前激活的
   * 世界书预设是用户自定义那份（`【条目N：…】`）时，界面报
   * `worldbook-no-entry-marker`（"这段文字未被解析成条目，写回会清空原有条目"）。
   * 文本里明明有条目标记 —— **视图用了默认格式、判据用了当前预设**。
   *
   * ## 三步（与拍板的方案一一对应）
   *
   * 1. 结构化条目优先：`character_book.entries` 是结构化的，直接以条目为中间态，
   *    按**当前预设**重新渲染文本 —— 不经过"文本 → 文本"，也就没有格式可言；
   * 2. 只有文本时（TXT 卡）：先用当前预设解析，认不出再用**标准预设兜底**，
   *    兜底能成 = "格式不匹配"，按当前预设重排并给 info；
   * 3. 两套都认不出 = "解析不出"，报 error（导出闸门照旧硬挡）。
   *
   * ## 为什么放在这里
   *
   * 三条到达路径（服务器取回/回滚、打开本地文件、导入）最后都落到
   * `replaceCard` / `createSessionWithCard`。放在这两个入口上，就不存在
   * "某条路忘了调"（用户明确要求不接受只修一个入口）。
   */


  private replaceCard(card: UnifiedCard): void {
    // 到达规范化（v0.1.6 缺陷一）：所有"整张卡进来"的路都经过这里，
    // 所以放在这里而不是在每个调用点各写一次 —— 少写一处就是少一个洞口。
    const arrived = arriveCard(this.landingHost(), card);
    // 走 session：它会深拷贝，避免调用方后续改动这份卡数据时渗透进会话。
    // 但"打开文件/导入"应当重置脏标记 —— 刚载入的内容相对磁盘是干净的。
    this.session.replaceCard(arrived);
    this.session.markSaved(this.session.filePath);
    this.reloadBlocksFromCard();
    this.scheduleValidate(0);
  }

  private setStatus(text: string, kind: 'ok' | 'warn' | 'bad' | 'info' = 'info'): void {
    this.statusBar.textContent = text;
    this.statusBar.className = `status ${kind}`;
  }

  /*
   * 这个区块的边界就是判据（见下方那行 `──` 注释）。
   *
   * ## 里面只能有 demo 方法
   *
   * `test/godclass-split-guard.test.mjs` 盯着：区块内的每个方法名必须是
   * `*ForDemo` 后缀或 `demo*` 前缀，例外清单为空。
   *
   * 为什么较真：这些方法依赖 26 个 private 成员（`this.rules` / `this.card` /
   * `this.rulesDialog` / `this.setStatus` …），所以**整体外移的代价远大于收益**
   * （报告 P2-2 建议的"移到单独文件"做不到）。但区块边界将来会被用到 ——
   * 构建期隔离、或者真去重构时，都是按这个边界切。
   *
   * ★ 2026-11-24 现场发现的一个真坑：`commitPresetApply`（"应用预设"的真实
   *   落地逻辑，被 `onPresetApply` 生产路径调用）原本夹在两个 demo 方法之间。
   *   照着区块边界做整体处理会**把产品功能一起带走**。已挪回生产区。
   *
   * ## 纪律：走真实逻辑，不伪造状态
   *
   * `?rules=1&applyPreset=divider` 真的执行「应用预设」（会重排），
   * 而不是把界面摆成"应用过了"的样子。`?crashInject=1` 走真实的全局
   * error 钩子 —— 这样截图与端到端才有验证价值。
   */
    // ── 调试/截图入口的接入点（实现在 demo-actions.ts）────────────
  /*
   * ## 这里为什么只剩一个方法
   *
   * 20 个 `*ForDemo` 方法共约 500 行，2026-11-24 搬到了 `demo-actions.ts`。
   * 它们此前卡在类里动不了，因为依赖 26 个 `private` 成员。
   *
   * 现在只剩这一处接口：`demoHost()` 把 demo 代码需要的 31 个能力包成一个
   * 窄接口对象。**这是全部耦合面** —— 读 `DemoHost` 就够，不必翻 500 行。
   *
   * ## 为什么不把 26 个成员改成 public
   *
   * 那会让封装永久变松：以后任何人从任何地方都能 `app.setStatus(...)`／
   * 直接改 `app.rules`。用一个显式接口限定"demo 能碰什么"，边界看得见。
   *
   * ## 为什么不在这里放薄包装方法
   *
   * 试过：包装方法要同步调到 demo 函数 ⇒ 必须静态 `import demo-actions`
   * ⇒ 那 500 行又回到主 chunk，白拆。所以调用方改为直接持有 host：
   *
   * ```text
   *   debug-params.ts   const demo = await import('./demo-actions')
   *                     demo.importSampleForDemo(app.demoHost(), sample)
   * ```
   *
   * `import type { DemoHost }` 是**纯类型**，编译后擦除，不产生运行时依赖 ——
   * 所以主 chunk 里只有下面这 30 行转发。
   */
  demoHost(): DemoHost {
    const self = this;
    return {
      get card() {
        return self.card;
      },
      get hasSession() {
        return self.hasSession;
      },
      get rules() {
        return self.rules;
      },
      get blocks() {
        return self.blocks;
      },
      get issues() {
        return self.issues;
      },
      get lastSummary() {
        return self.lastSummary;
      },
      get worldbookPreset() {
        return self.worldbookPreset;
      },
      get exportDialog() {
        return self.exportDialog;
      },
      get importDialog() {
        return self.importDialog;
      },
      get rulesDialog() {
        return self.rulesDialog;
      },
      get syncDialog() {
        return self.syncDialog;
      },
      // 唯一可写字段：`?settings=1&token=` 会把它写进来
      get settingsToken() {
        return self.settingsToken;
      },
      set settingsToken(next: string) {
        self.settingsToken = next;
      },
      setStatus: (text, kind) => self.setStatus(text, kind),
      validate: () => self.validate(),
      refreshRulesLabel: () => refreshRulesLabel(self.refreshHost()),
      refreshStats: () => refreshStats(self.refreshHost()),
      refreshNameHint: () => refreshNameHint(self.refreshHost()),
      reloadBlocksFromCard: () => self.reloadBlocksFromCard(),
      replaceCard: (card) => self.replaceCard(card),
      selectPresetById: (id) => self.selectPresetById(id),
      selectWorldbookPreset: (id) => self.selectWorldbookPreset(id),
      switchPlatform: (id) => switchPlatform(self.refreshHost(), id),
      switchHighlight: (id) => switchHighlight(self.refreshHost(), id),
      commitPresetApply: (preset, plan) => self.commitPresetApply(preset, plan),
      createSessionFromFile: (path) => self.createSessionFromFile(path),
      applyConnection: (result) => self.applyConnection(result),
      expand: (runtime, silent) => expand(self.blockHost(), runtime, silent),
      collapse: (runtime) => collapse(self.blockHost(), runtime),
      importPlatformText: (text) => importPlatformText(self.importHost(), text),
      importTxtPresetText: (text) => importTxtPresetText(self.importHost(), text),
      importWorldbookPresetText: (text) => importWorldbookPresetText(self.importHost(), text),
      importCardTextFile: (fileName, text, createdSession, autoConfirm, note) =>
        importCardTextFile(self.openHost(), fileName, text, createdSession, autoConfirm, note),
    };
  }
}



// ── 启动 ────────────────────────────────────────────────────

/**
 * 功能：判断键盘事件的焦点是否落在可编辑元素上，用于决定 Ctrl+A 该不该放行。
 * 注意事项：CodeMirror 的输入区是 contenteditable，靠 isContentEditable 命中；
 *   普通 input/textarea/select 按标签名判断。按钮、下拉容器、审计面板都不算。
 * 踩过的坑：无。
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * 桌面壳的浏览器行为收口（v0.2.3，2026-11-27 用户要求）。
 *
 * 功能：屏蔽 WebView 自带右键菜单（返回/刷新/另存为/打印/QR/朗读/翻译/截图/
 *   发送到设备/查看源码/检查），并拦下 Ctrl+P 与非编辑区的 Ctrl+A。
 * 注意事项：只挂在桌面入口（index.html 加载 editor/app.ts）；移动端
 *   mobile.html 走另一个入口，不受影响。这里不拦 F5/Ctrl+R：用户列的是
 *   右键菜单里的项，刷新快捷键仍可用。
 * 踩过的坑：Ctrl+A 以前没拦，焦点在按钮/面板上按下去会把整个界面文字选蓝
 *   （截图里整页高亮）；拦的时候必须放行输入框与 CodeMirror，否则编辑器里
 *   没法全选。
 */
function installDesktopShellGuards(): void {
  document.addEventListener('contextmenu', (event) => event.preventDefault(), true);
  window.addEventListener(
    'keydown',
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === 'p') {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (key === 'a' && !isEditableTarget(event.target)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );
}

async function boot(): Promise<void> {
  installDesktopShellGuards();
  const params = new URLSearchParams(location.search);

  /**
   * 启动时是否载入样例卡。
   *
   * **默认不载入** —— F3 要求「启动后不自动打开任何角色卡，显示空工作台」。
   * 之前无条件加载 test/fixtures 里的样例卡，那是开发期图方便，
   * 真实用户打开客户端会莫名其妙看到别人的角色卡。
   *
   * `?sample=1` 保留给端到端测试与截图：那些场景需要一张有内容的卡作为起点。
   * 这里不写"生产环境禁用"的判断 —— 它是调试入口，和 ?rules=1 等一致。
   */
  let card: UnifiedCard | null = null;
  if (params.get('sample') === '1') {
    try {
      /*
       * ★ 动态 import（2026-11-24）：样例卡来自 `test/fixtures/`，属于测试夹具。
       *
       * 以前是顶层静态 import，于是**每个用户的包里都打进了这份夹具**
       * （报告 P2-2 的"生产包含测试夹具"）。改成动态后它成为一个独立 chunk，
       * 不带 `?sample=1` 的启动永远不会下载它。
       *
       * `?sample=1` 的语义完全不变 —— 端到端测试与截图脚本照旧可用。
       */
      const { default: sampleCardJson } = await import('../../../test/fixtures/sample-card.json');
      // 样本卡同样要按当前预设渲染世界书（缺陷一那条静态断言盯着所有调用点）
      card = parseStCard(sampleCardJson as unknown, {
        worldbookFormat: DEFAULT_WORLDBOOK_PRESET.format,
      }).card;
    } catch {
      card = null; // 样例卡坏了也不该让启动失败，退化成空工作台
    }
  }

  byId('card-name-input').hidden = true;

  const app = new EditorApp(card);

  // 全局异常捕获（T10.26）。必须在 start() **之前**装上：启动过程本身
  // 就是最容易出错的一段（读配置、载规则、恢复登录态），漏掉它就等于
  // "崩溃日志里永远没有启动崩的那次"。
  app.installCrashLogging();

  await app.start();

  /*
   * 调试/截图入口（2026-11-24 搬到 `debug-params.ts`）。
   *
   * 那段约 80 行只在带调试参数时用得上，以前躺在 boot() 里 ⇒ 每个用户下载的
   * 包里都带着它（报告 P2-2）。现在按需动态加载：没带调试参数时这个模块
   * **根本不会被下载**。
   *
   * ★ 18 个截图/验收脚本拼的 URL 一个字都没改 —— 参数语义与处理顺序原样保留。
   *   判断清单在 `debug-keys.ts`（零依赖，主 chunk 只多几百字节）。
   */
  if (hasDebugParams(params)) {
    const { applyDebugParams } = await import('./debug-params');
    await applyDebugParams(app, params);
  }

  // 便于性能脚本与调试访问（只挂载在 window 上，不参与业务逻辑）
  (window as unknown as Record<string, unknown>)['__tcs'] = { app };
}

void boot();

