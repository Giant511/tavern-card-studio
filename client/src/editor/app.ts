/**
 * 六板块编辑器（T6.1）+ 审计面板（T6.5）。
 *
 * 结构：
 *   顶栏（卡片名 / 统计 / 文件操作 / 连接状态 / 设置）
 *   同步条（可用性由服务端连接决定，与本地编辑解耦）
 *   ├ 左：六个板块（折叠面板，折叠时销毁编辑器 → 隐藏块不进 DOM）
 *   └ 右：审计面板（过滤 / 分组 / 字数分布；点击问题定位到板块内偏移）
 *
 * 依赖方向：本文件只 import `../contract`（原生能力）与 `@tcs/shared`（纯逻辑），
 * 不直接碰 `@tauri-apps/*`，也不自己拼卡片字符串。
 */

import {
  applyPresetPlan,
  buildAuditReport,
  compileHighlightRule,
  createEmptyCard,
  DEFAULT_WORLDBOOK_PRESET,
  importWorldbook,
  parseStCard,
  renderWorldbookTextWith,
  resolveHighlightRule,
  resolvePlatformRule,
  type AuditIssue,
  type PresetApplyPlan,
  type TxtPreset,
  type AuditReport,
  type BlockId,
  type UnifiedCard,
  type WorldbookPreset,
} from '@tcs/shared';

import {
  appendClientErrorLog,
  configGet,
  configPatch,
  isShellAvailable,
  pickCardFile,
  pickSavePath,
  readTextExact,
  shellInfo,
  writeFileAtomic,
  type ShellError,
} from '../contract';

import {
  collectBlocks,
  importCardText,
  serializeCard,
  setBlockText,
  totalLength,
  type EditorBlockSnapshot,
} from './block-doc';
import { BlockEditor, type EditorIssue } from './block-editor';
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
import { isSyncReady, probeServer, type ProbeResult } from '../net/server-probe';
import { ExportDialog } from '../export/export-dialog';
import { buildExportAsync } from '../export/export-card';
import { SyncDialog } from '../sync/sync-dialog';
import { CardsDialog } from '../sync/cards-dialog';
import { RepoDialog } from '../sync/repo-dialog';
import { listRepos } from '../sync/repo-client';
import type { SyncConfig } from '../sync/server-sync';
import { AuthSession } from '../auth/session';
import { LoginDialog } from '../auth/login-dialog';
import { phaseLabel, phaseTitle } from '../auth/policy';
import {
  connectionLabel,
  hasServerUrl,
  resolveSyncGate,
  syncHintText,
  type SyncGateState,
} from '../auth/entry-policy';
import { SettingsDialog } from '../settings/settings-dialog';
import { NewCardDialog } from '../session/new-card-dialog';
import { decideShortcut } from './shortcuts';
import { ImportDialog } from './import-dialog';
import { applyWorldbookImport, exportWorldbookText, suggestWorldbookFileName } from './import-flow';
import {
  importTxtPreset,
  importWorldbookPreset,
  serializePreset,
  type PresetImportOutcome,
} from '../rules/preset-library';
import { deriveCardNameFromFile } from './open-name';
import { browserHintStore, dismissNameHint, resetNameHint, shouldShowNameHint } from './name-hint';
import {
  buildDiagnosticsText,
  createCrashLogger,
  installGlobalErrorHandlers,
  suggestDiagnosticsFileName,
  type CrashLogger,
} from '../diagnostics/crash-log';
// 版本号从 package.json 内联（Vite 构建期处理），不硬编码 —— 见 appVersion()
import clientPackage from '../../package.json';
import { CardSession } from '../session/card-session';
import { effectiveCardsDir, suggestCardFileName } from '../session/cards-dir';
import { TabBar, type TabItem } from '../session/tab-bar';
import { generateCardId, readCardIdFromCard, withCardId } from '../session/card-id';
import { collectDirtyNames, installUnloadGuard } from '../session/unload-guard';

import sampleCardJson from '../../../test/fixtures/sample-card.json';

// ── DOM 助手（typed + 无 innerHTML）────────────────────────────
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少 DOM 节点 #${id}`);
  return node as T;
}

interface BlockRuntime {
  snapshot: EditorBlockSnapshot;
  section: HTMLElement;
  body: HTMLElement;
  host: HTMLElement;
  preview: HTMLElement;
  badge: HTMLElement;
  editor: BlockEditor | null;
  expanded: boolean;
  previewOn: boolean;
}

class EditorApp {
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
   * 账户登录态（T10.7）。
   *
   * 与 `settingsToken` 并存：**账户令牌优先**，为空时回落到 legacy 全局令牌。
   * 两者都不在时同步入口按未就绪处理。
   */
  private authSession: AuthSession | null = null;
  private loginDialog: LoginDialog | null = null;
  private cardsDialog: CardsDialog | null = null;
  /** TXT 角色卡 / 世界书导入对话框（T10.9） */
  private importDialog: ImportDialog | null = null;
  private repoDialog: RepoDialog | null = null;
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
  /** 世界书格式预设（T10.31）：内置 default + 用户导入项，只存在运行期 */
  private worldbookPresets: WorldbookPreset[] = [DEFAULT_WORLDBOOK_PRESET];
  private worldbookPreset: WorldbookPreset = DEFAULT_WORLDBOOK_PRESET;
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
  private connection: ProbeResult | null = null;
  /** 最近一次审计的等级计数（切规则后要给用户一句话结论） */
  private lastSummary = { error: 0, warning: 0, info: 0 };

  constructor(card: UnifiedCard | null) {
    // 传入 null = 空白启动（F3）：启动时不打开任何卡，工作台是空的。
    if (card !== null) {
      const session = new CardSession({ card, cardId: readCardIdFromCard(card) ?? undefined });
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
    this.refreshRulesLabel();

    // T6.5：审计面板要在首次校验前就位，否则第一次报告会无处渲染
    this.auditPanel = new AuditPanel(
      {
        onLocate: (issue) => this.locateIssue(issue),
        onFocusBlock: (blockId) => {
          const runtime = this.blocks.find((block) => block.snapshot.id === blockId);
          if (runtime) this.expand(runtime, true);
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

    this.wireToolbar();
    this.wireNameEditor();
    this.wireShortcuts();
    this.wireSettings();
    this.wireRules();
    this.wireExportAndSync();
    this.wireAccount();
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
  }

  // ── 规则与预设（T6.2 / T6.3）─────────────────────────────
  //
  // 语义要点：
  //   · 切换平台规则 → **立即重检**（阶段 3 定的「切换即重检」）；
  //   · 切换高亮方案 → 立即重新着色（配色来自方案本身）；
  //   · 选择预设 → 只改导出格式（标题/顺序），**原文不动**；
  //   · 应用预设 → 唯一重排入口，走 plan → 确认 → applyPresetPlan。
  /** 设置保存后重新读取 token，并重新探测（地址可能变了） */
  private async refreshTokenAfterSave(): Promise<void> {
    try {
      const config = await configGet();
      this.settingsToken = config.token;
      this.authServerUrl = config.serverUrl;
      // 与 autoProbe 同一套优先级：账户令牌 > legacy 全局令牌
      const accountToken = this.authSession?.accessToken ?? '';
      const result = await probeServer({
        serverUrl: config.serverUrl,
        token: accountToken !== '' ? accountToken : config.token,
      });
      this.applyConnection(result);
    } catch {
      // 浏览器模式读不到配置，忽略
    }
  }

  private wireRules(): void {
    const button = byId<HTMLButtonElement>('btn-rules');
    button.addEventListener('click', () => this.rulesDialog?.open());

    this.rulesDialog = new RulesDialog({
      getState: () => this.dialogState(),
      notify: (message, kind) => this.setStatus(message, kind ?? 'info'),

      onPlatformChange: (id) => this.switchPlatform(id),
      onHighlightChange: (id) => this.switchHighlight(id),
      onPresetSelect: (id) => {
        this.selectPresetById(id);
        this.refreshRulesLabel();
      },
      onPresetApply: (presetId, plan) => {
        const preset = this.rules?.presets.find((item) => item.id === presetId);
        if (!preset) {
          this.setStatus(`预设「${presetId}」不存在`, 'bad');
          return;
        }
        this.commitPresetApply(preset, plan);
      },

      importPlatformText: (text) => this.importPlatformText(text),
      importHighlightText: (text) => this.importHighlightText(text),
      importTxtPresetText: (text) => this.importTxtPresetText(text),
      importWorldbookPresetText: (text) => this.importWorldbookPresetText(text),
      onWorldbookPresetSelect: (id) => this.selectWorldbookPreset(id),

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
      }),
      // 导出前强制重算：不能用过期报告放行
      revalidate: () => {
        this.validate();
        return this.report;
      },
      notify: (message, kind) => this.setStatus(message, kind ?? 'info'),
      onExported: () => {
        // 导出成功后不自动上传（避免误操作）；用户可在同步面板手动上传
      },
    });

    this.syncDialog = new SyncDialog({
      getConnection: () => this.connection,
      getConfig: () => this.currentSyncConfig(),
      // 上传内容与「导出 JSON」同一份，保证服务端字节与本地可复现
      getPayload: () => {
        const preset = this.rules?.preset ?? null;
        return buildExportAsync(this.card, preset, 'json').then((artifact) => artifact.text);
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
      onRemoteTextApplied: (text, version, remoteSeq) => {
        this.applyRemoteText(text, version.seq, remoteSeq);
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
        const config = this.repoClientConfig();
        if (!config) return [];
        return listRepos(config);
      },
      getSelectedRepo: () => this.selectedRepoId,
      onSelectRepo: (repoId) => {
        // 记住选择：连着上传几张卡时不用反复选（`pickRepoId` 会优先用它）
        this.selectedRepoId = repoId;
      },
      onOpenRepos: () => void this.repoDialog?.open(),
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
  private wireAccount(): void {
    const session = new AuthSession({
      load: async () => {
        const config = await configGet();
        return {
          accessToken: config.accessToken,
          refreshToken: config.refreshToken,
          accessExpiresAt: config.accessExpiresAt,
          authUser: config.authUser,
        };
      },
      save: async (patch) => {
        // 只写这四个键：`configPatch` 是按 key 合并的，不会动规则/目录等设置
        await configPatch(patch);
      },
      serverUrl: () => (this.authServerUrl.trim() === '' ? null : this.authServerUrl.trim()),
      /*
       * 登录态变化的**所有**来源都从这里经过：登录框、bootstrap 恢复、
       * 静默续期成功、401 后恢复失败回匿名、登出。
       *
       * 第一版只刷新账户按钮 —— 于是"静默续期成功"这条路径上，账户按钮已经是
       * authenticated，而顶栏胶囊与同步提示还停在"未登录"（截图验收时发现）。
       * 连接本身没变，只是凭证变了，所以用现有 connection 重新 apply 一次即可。
       */
      onPhaseChange: () => {
        this.refreshAccountButton();
        if (this.connection) this.applyConnection(this.connection);
      },
    });
    this.authSession = session;

    this.loginDialog = new LoginDialog({
      session,
      getPolicy: () => session.fetchPolicy(),
      // 登录只需要地址，不需要任何令牌（免鉴权端点：login/register/refresh/config）
      getServerUrl: () => this.connection?.url ?? this.authServerUrl,
      notify: (message, kind) => this.setStatus(message, kind ?? 'info'),
      onAuthenticated: () => {
        // 换了令牌 → 必须重探一次，否则顶栏还停在旧状态，
        // 用户会以为登录没成功
        this.refreshAccountButton();
        void this.autoProbe();
        /*
         * 立刻按现有连接信息重算一次界面文案。
         *
         * `autoProbe()` 是一次网络往返，回来之前顶栏与同步提示还是**上一轮探测**的
         * 结论（探针实测：登录成功、会话已是 authenticated，提示却仍写
         * "未登录：登录后可同步"）。连接本身没变，只是凭证变了 ——
         * 用已有的 `connection` 重新 apply 一次就能立刻纠正，不必等探测。
         */
        if (this.connection) this.applyConnection(this.connection);
        // 静默续期由 AuthSession 自己接管（refresh 单飞，见 session.ts），
        // 这里补第 4 条要求的另一半：**登录成功即拉一次「我的卡片」**，
        // 用户点开面板时不用再等一轮。
        void this.cardsDialog?.preload();
      },
    });

    this.cardsDialog = new CardsDialog({
      getConfig: () => this.currentSyncConfig(),
      isAccountLogin: () => session.accessToken !== '' || session.refreshToken !== '',
      // T10.8：服务端说"已隔离"就不再提示未隔离（避免永远为真的免责声明）
      isIsolationEnforced: () => this.connection?.isolationEnforced ?? null,
      onPick: (cardId) => {
        // 复用同步面板：点卡片 = 看它的版本历史
        this.syncDialog?.open();
        this.syncDialog?.selectCard(cardId);
      },
      notify: (message, kind) => this.setStatus(message, kind ?? 'info'),
      // 「移动…」要选目标仓库：列表由仓库客户端现取（不缓存 —— 用户可能刚在
      // 仓库面板里新建过一个，缓存会让它在这里看不到）
      getRepos: async () => {
        // 仓库管理只认账户 access 令牌（仓库令牌/legacy 都调不了 /api/repos 的管理动作），
        // 用与仓库面板同一个 helper，避免两处各自拼配置
        const config = this.repoClientConfig();
        if (!config) return [];
        return listRepos(config);
      },
      onUnauthorized: () => this.handleUnauthorized(),
      onLogout: async () => {
        await session.logout();
        this.setStatus('已登出：后续同步将使用全局令牌（若有）', 'info');
        this.refreshAccountButton();
        void this.autoProbe();
      },
    });

    byId<HTMLButtonElement>('btn-account').addEventListener('click', () => void this.openAccountEntry());

    /*
     * 仓库与令牌面板（T10.8）。
     *
     * 与登录框同一条规则：**只存在于账户身份**。仓库管理不接受 legacy 令牌
     * （没有账户可挂）、也不接受仓库令牌（能自签 = 一次泄露可无限续期）。
     * 所以 `getConfig` 在这里返回 null 而不是"退化成 legacy"。
     */
    this.repoDialog = new RepoDialog({
      getConfig: () => this.repoClientConfig(),
      notify: (message, kind) => this.setStatus(message, kind ?? 'info'),
      onUnauthorized: () => this.handleUnauthorized(),
    });

    // 启动时读回令牌并**静默**续期。
    // 不 await：续期要发网络请求，不能挡住首屏渲染；也不在失败时弹窗
    // （启动瞬间弹登录框，用户第一反应是"是不是被盗号了"）。
    void session.bootstrap().then((ok) => {
      this.refreshAccountButton();
      if (ok) void this.autoProbe();
    });
  }

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
  private repoClientConfig(): { serverUrl: string; accessToken: string } | null {
    const connection = this.connection;
    const token = this.authSession?.accessToken ?? '';
    const serverUrl = connection?.url ?? this.authServerUrl;
    if (token === '' || serverUrl === '' || serverUrl === undefined) return null;
    return { serverUrl, accessToken: token };
  }

  /** 账户按钮的文案与状态（唯一一处改它的地方） */
  private refreshAccountButton(): void {
    const button = byId<HTMLButtonElement>('btn-account');
    const session = this.authSession;
    const phase = session?.currentPhase ?? 'anonymous';
    const user = session?.user ?? null;
    button.textContent = phaseLabel(phase, user);
    button.title = phaseTitle(phase, user);
    button.dataset['phase'] = phase;
    // 设置面板里的「已登录：alice（账户令牌）」/「未登录」跟着变：
    // 登录态可能在任何地方变化（登录、登出、静默过期、401 恢复），
    // 只在一处改文案，避免两个面板各说一套。
    this.settings?.refreshIdentity();
  }

  /**
   * 点账户按钮：已登录 → 卡片列表；否则 → 登录框。
   *
   * v0.1.2 追加任务：**不再以"已连上/令牌有效"为前提**。唯一的前置条件是
   * 服务端地址 —— 没有它，登录框连 `/api/auth/config` 都问不到。
   * 那种情况直接把用户送到设置页并说明原因，而不是打开一个注定失败的登录框。
   */
  private async openAccountEntry(): Promise<void> {
    const session = this.authSession;
    if (!session) return;
    if (!hasServerUrl(this.connection?.url ?? this.authServerUrl)) {
      this.setStatus('先在设置里填写服务端地址（同机可直接点「连接本机服务端」），再登录。', 'warn');
      void this.settings?.open();
      return;
    }
    if (session.currentPhase === 'authenticated' && session.accessToken !== '') {
      await this.cardsDialog?.open();
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
      this.refreshAccountButton();
      void this.autoProbe();
      return true;
    }

    this.refreshAccountButton();
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
    });
  }

  /** 世界书板块内的两个按钮（导入 / 导出），由 createBlock 挂在 worldbook 块里 */
  private buildWorldbookActions(): HTMLElement {
    const row = el('div', 'worldbook-actions');
    const importButton = el('button', 'btn small', '导入世界书…') as HTMLButtonElement;
    importButton.type = 'button';
    importButton.dataset['role'] = 'worldbook-import';
    importButton.title = '支持 character_book JSON 与世界书 TXT（自动识别）';
    importButton.addEventListener('click', () => void this.pickAndImportWorldbook());

    const exportJson = el('button', 'btn small ghost', '导出 JSON…') as HTMLButtonElement;
    exportJson.type = 'button';
    exportJson.dataset['role'] = 'worldbook-export-json';
    exportJson.addEventListener('click', () => void this.exportWorldbookFile('json'));

    const exportTxt = el('button', 'btn small ghost', '导出 TXT…') as HTMLButtonElement;
    exportTxt.type = 'button';
    exportTxt.dataset['role'] = 'worldbook-export-txt';
    exportTxt.addEventListener('click', () => void this.exportWorldbookFile('txt'));

    row.append(importButton, exportJson, exportTxt);
    return row;
  }

  /** 选一个世界书文件并导入（扩展名决定预期格式，但真正的识别在 shared 里做） */
  private async pickAndImportWorldbook(): Promise<void> {
    try {
      const path = await pickCardFile(undefined, { allowText: true });
      if (!path) return;
      const file = await readTextExact(path);
      await this.importWorldbookFile(file.pathDisplay ?? path, file.text);
    } catch (error) {
      this.setStatus(`读取世界书文件失败：${describe(error)}`, 'bad');
    }
  }

  /**
   * 当前同步配置：连接通过时才返回（未就绪不构造请求参数） */
  private currentSyncConfig(): SyncConfig | null {
    // v0.1.2 追加任务：**不再要求探测通过**。
    //
    // 上一版这里写着 `if (!isSyncReady(connection)) return null`，而 isSyncReady
    // 要求 tokenValid === true —— 于是"没登录"被表达成"同步配置为空"，
    // 卡片列表与同步面板于是说"未连接"。凭证只决定**能做什么**，
    // 不能决定"能不能开始"：这里只要有地址 + 有凭证就交出配置，
    // 请求失败由各面板自己报（那时才有真实错误可看）。
    const accountToken = this.authSession?.accessToken ?? '';
    const legacyToken = this.settingsToken ?? '';
    const token = accountToken !== '' ? accountToken : legacyToken;
    const serverUrl = this.connection?.url ?? this.authServerUrl;
    if (!hasServerUrl(serverUrl) || token === '') return null;
    return { serverUrl, token };
  }

  /** 当前是否持有可用凭证（账户令牌或 legacy 全局令牌） */
  private hasCredentials(): boolean {
    return (this.authSession?.accessToken ?? '') !== '' || (this.settingsToken ?? '') !== '';
  }

  /**
   * 同步门槛（v0.1.2 追加任务）：地址 + 凭证，两件事都只看"有没有"。
   * 探测结果不参与判定 —— 否则"刚打开客户端、探测还没回来"会让面板说"未连接"。
   */
  private syncGate(): SyncGateState {
    return resolveSyncGate(this.connection?.url ?? this.authServerUrl, this.hasCredentials());
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
  private applyRemoteText(text: string, displaySeq: number, remoteSeq: number = displaySeq): void {
    try {
      const parsed = parseStCard(JSON.parse(text) as unknown);
      this.replaceCard(parsed.card);
      this.session.noteRemoteVersion(this.session.cardId, remoteSeq);
      this.setStatus(`已载入服务端 v${displaySeq} 的内容（原文件未自动保存，建议另存）`, 'warn');
    } catch (error) {
      this.setStatus(
        `载入服务端版本失败：${error instanceof Error ? error.message : String(error)}`,
        'bad',
      );
    }
  }

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
    };
  }

  /** 切换平台规则：立即按新规则重检并提醒 */
  private switchPlatform(id: string): void {
    if (!this.rules) return;
    let resolved;
    try {
      resolved = resolvePlatformRule(id, this.rules.platformFiles);
    } catch (error) {
      this.setStatus(
        `平台规则「${id}」无法解析：${error instanceof Error ? error.message : String(error)}`,
        'bad',
      );
      return;
    }

    this.rules = { ...this.rules, platform: resolved, platformId: id };
    // 切换即重检：不等防抖，立刻跑，让用户马上看到结论变化
    this.validate();
    const { error, warning, info } = this.lastSummary;
    this.setStatus(
      `已切换到「${resolved.name}」：错误 ${error} · 警告 ${warning} · 提示 ${info}`,
      error > 0 ? 'bad' : warning > 0 ? 'warn' : 'ok',
    );
    this.refreshRulesLabel();
  }

  /** 切换高亮方案：重新编译 + 重新着色 */
  private switchHighlight(id: string): void {
    if (!this.rules) return;
    const file = this.rules.highlightFiles.find((item) => item.id === id);
    if (!file) {
      this.setStatus(`高亮方案「${id}」不存在`, 'bad');
      return;
    }

    let compiled;
    try {
      compiled = compileHighlightRule(resolveHighlightRule(id, this.rules.highlightFiles));
    } catch (error) {
      this.setStatus(
        `高亮方案「${id}」编译失败：${error instanceof Error ? error.message : String(error)}`,
        'bad',
      );
      return;
    }

    this.rules = { ...this.rules, highlight: compiled, highlightFile: file, highlightId: id };
    // 配色来自方案本体 → 重新生成 CSS
    applySchemeStyles(file);

    // 已挂载的编辑器需要重建才能用新方案（装饰在 ViewPlugin 构造时绑定）
    for (const runtime of this.blocks) {
      if (!runtime.expanded) continue;
      const text = runtime.editor?.getText() ?? runtime.snapshot.text;
      runtime.editor?.destroy();
      runtime.editor = null;
      runtime.host.replaceChildren();
      runtime.editor = new BlockEditor({
        parent: runtime.host,
        blockId: runtime.snapshot.id,
        text,
        compiled,
        onChange: (next) => this.onBlockChange(runtime, next),
      });
      runtime.editor.setIssues(this.issuesFor(runtime.snapshot.id));
    }

    this.setStatus(`已切换高亮方案：${file.name}（${id}）`, 'ok');
    this.refreshRulesLabel();
  }

  /** 导入 TXT 预设（T10.30）：原子回退 + 同 id 覆盖 + 不自动切换 */
  private importTxtPresetText(text: string): PresetImportOutcome<TxtPreset[]> {
    if (!this.rules) {
      return { ok: false, value: [], issues: [], warnings: [], id: null, name: null, replaced: false, renameHint: '' };
    }
    const outcome = importTxtPreset(this.rules.presets, text);
    if (!outcome.ok) return outcome;

    this.rules = { ...this.rules, presets: outcome.value };
    // 导入后**不切换**当前预设：导入是"加入候选"，切换是"改变导出格式"，
    // 两件事合在一起时，用户正在看的内容会突然按另一种格式重排，很难归因。
    this.refreshRulesLabel();
    return outcome;
  }

  /** 导入世界书预设（T10.31） */
  private importWorldbookPresetText(text: string): PresetImportOutcome<WorldbookPreset[]> {
    const outcome = importWorldbookPreset(this.worldbookPresets, text);
    if (!outcome.ok) return outcome;
    this.worldbookPresets = outcome.value;
    return outcome;
  }

  private selectWorldbookPreset(id: string): void {
    const preset = this.worldbookPresets.find((item) => item.id === id);
    if (!preset) return;
    this.worldbookPreset = preset;
    // 世界书预设参与解析与格式检查，切换后必须重检 —— 否则面板停在旧口径上
    this.validate();
    this.refreshRulesLabel();
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
        ` · 按新口径重检：错误 ${error} 警告 ${warning}`,
      error > 0 ? 'bad' : warning > 0 ? 'warn' : 'ok',
    );
  }

  /** 导入平台规则：校验 + 原子回退都在 rule-library 里 */
  private importPlatformText(text: string) {
    if (!this.rules) {
      return { ok: false, value: null, issues: [], warnings: [], id: null, name: null };
    }
    const outcome = importPlatformRule(this.rules.platformFiles, text);

    if (outcome.ok) {
      // 只有成功才落到 this.rules —— 这就是原子性的落点
      const platformSourceText = { ...this.rules.platformSourceText };
      if (outcome.id) platformSourceText[outcome.id] = text;
      this.rules = {
        ...this.rules,
        platformFiles: outcome.value,
        platformSourceText,
      };
      // 若当前平台被同名覆盖，重新解析一次，避免用着旧对象
      if (outcome.id === this.rules.platformId) {
        this.rules = {
          ...this.rules,
          platform: resolvePlatformRule(outcome.id, outcome.value),
        };
        this.validate();
      }
    }
    return outcome;
  }

  /** 导入高亮方案：同样原子回退，且必须能编译 */
  private importHighlightText(text: string) {
    if (!this.rules) {
      return { ok: false, value: null, issues: [], warnings: [], id: null, name: null };
    }
    const outcome = importHighlightScheme(
      this.rules.highlightFile,
      this.rules.highlightFiles,
      text,
    );

    if (outcome.ok && outcome.value && outcome.compiled && outcome.id) {
      const highlightSourceText = { ...this.rules.highlightSourceText };
      highlightSourceText[outcome.id] = text;
      this.rules = {
        ...this.rules,
        highlightFiles: [...this.rules.highlightFiles.filter((f) => f.id !== outcome.id), outcome.value],
        highlightSourceText,
      };
      // 导入即应用：切到新方案，用户能立刻看到效果
      this.switchHighlight(outcome.id);
      this.rulesDialog?.refresh();
    }
    return outcome;
  }

  private refreshRulesLabel(): void {
    const label = byId('rules-label');
    const rules = this.rules;
    if (!rules) return;
    label.textContent = `平台 ${rules.platformId} · 高亮 ${rules.highlightId} · 预设 ${rules.preset?.id ?? '—'}`;
  }

  /** 卡片被整体替换（应用预设 / 打开文件）后重建板块视图 */
  private reloadBlocksFromCard(): void {
    for (const runtime of this.blocks) {
      this.collapse(runtime);
      runtime.section.remove();
    }
    // 清掉空工作台留下的占位块。
    // 只删 this.blocks 里的板块是不够的 —— 空工作台那个 .empty-workspace 不在
    // this.blocks 里，于是"从零标签新建一张卡"之后它会残留在编辑区中间
    // （2026-10-22 截图里同时出现空占位与六个板块，就是这个原因）。
    this.blockList.replaceChildren();
    this.blocks = collectBlocks(this.card).map((snapshot) => this.createBlock(snapshot));
    const expandAll = new URLSearchParams(location.search).get('expand') === 'all';
    for (const [index, runtime] of this.blocks.entries()) {
      if (expandAll || index < 2) this.expand(runtime, true);
    }
    this.refreshStats();
    this.renderCardName();
  }

  // ── 设置与同步可用性（T6.8）──────────────────────────────
  //
  // 关键原则：同步是"可选的增强"，网络问题不得影响本地编辑。
  // 因此这里做三件事：① 顶栏状态胶囊；② 同步条按钮启用/禁用；③ 最多一次自动探测。
  private wireSettings(): void {
    this.settings = new SettingsDialog({
      onConnectionChange: (result) => this.applyConnection(result),
      // T10.26：诊断导出由 app 实现（它知道版本、连接状态、会话摘要与日志路径）
      onExportDiagnostics: () => this.exportDiagnostics(),
      onSaved: () => {
        void this.refreshTokenAfterSave();
        this.setStatus('设置已保存', 'ok');
      },
      // 身份行：登录态从 AuthSession 现读（闭包，构造时 session 可能还不存在）
      getIdentity: () => ({
        phase: this.authSession?.currentPhase ?? 'anonymous',
        user: this.authSession?.user ?? null,
      }),
      onLogin: () => void this.openAccountEntry(),
      onLogout: async () => {
        await this.authSession?.logout();
        this.refreshAccountButton();
        void this.autoProbe();
        this.setStatus('已登出；本地编辑不受影响', 'info');
      },
    });

    byId<HTMLButtonElement>('btn-settings').addEventListener('click', () => {
      void this.settings?.open();
    });

    // 调试/截图入口：?settings=1 自动打开；配合 &serverUrl=…&token=… 会执行一次真实探测。
    // 只影响"打开面板"这一步，探测逻辑与手动点击完全一致（不伪造状态）。
    //
    // `&localConnect=1` 再往前走一步：点一次「连接本机服务端」按钮。
    // 这是 F6 的端到端断言入口 —— 必须真的点按钮，而不是直接调编排函数，
    // 否则测不到按钮绑定、busy 状态、分步说明渲染这些 UI 环节。
    const params = new URLSearchParams(location.search);
    if (params.get('settings') === '1') {
      const serverUrl = params.get('serverUrl') ?? undefined;
      const token = params.get('token') ?? undefined;
      const wantLocalConnect = params.get('localConnect') === '1';
      void (async () => {
        await this.settings?.open({ serverUrl, token });
        if (wantLocalConnect) {
          await this.settings?.clickConnectLocal();
          return;
        }
        if (params.get('probe') === '1') {
          await this.settings?.runProbe();
        }
      })();
    }

    // T6.7：三个同步入口都打开同一个面板（面板内按职责分区：上传 / 历史 / 回滚）
    for (const id of ['btn-upload', 'btn-history', 'btn-rollback']) {
      byId<HTMLButtonElement>(id).addEventListener('click', () => {
        // 入口永远可点（v0.1.2 追加任务）。面板按 地址 / 凭证 三态说明现状：
        // 「还没配置地址」或「登录后可同步」都比门口一句"同步未就绪"有用 ——
        // 后者既说不出缺什么，也让"还没登录"看起来像功能坏了。
        this.syncDialog?.open();
      });
    }

    // 调试/截图入口：?preview=<mode> 驱动「渲染预览」，把结果写进 body.dataset
    // 供端到端断言读取（scripts/verify-e2e.mjs）。
    // F8 回归：该按钮曾因 buildPreviewFragment 的无限循环让整页假死，
    // 表现为「点了没反应、必须重启客户端」，且控制台无任何报错。
    const previewMode = params.get('preview');
    if (previewMode) void this.runPreviewScenario(previewMode);

    this.applyConnection(null);
    void this.autoProbe();
  }

  /**
   * 预览场景驱动（仅测试/截图用，正常启动不触发）。
   *
   * 为什么需要它：F8 的故障形态是「同步不返回」，单元测试（Node 里跑纯函数）
   * 抓不到这类问题 —— 必须真的在浏览器里点一次、并确认点击能返回。
   * 这里只做「点按钮 + 读 DOM」，不伪造任何业务状态。
   */
  private async runPreviewScenario(mode: string): Promise<void> {
    const button = byId<HTMLButtonElement>('btn-preview');
    const visibleCount = (): number =>
      [...document.querySelectorAll<HTMLElement>('.preview')].filter((node) => !node.hidden).length;
    const nodeCount = (): number =>
      [...document.querySelectorAll<HTMLElement>('.preview')].reduce((sum, node) => sum + node.childNodes.length, 0);
    const mark = (key: string, value: string): void => {
      document.body.dataset[key] = value;
    };

    // 默认启动会展开前两个板块，预览只对已展开的块生效
    const expanded = this.blocks.filter((runtime) => runtime.expanded).length;
    mark('previewExpanded', String(expanded));

    if (mode === 'open') {
      const started = performance.now();
      button.click();
      mark('previewMs', (performance.now() - started).toFixed(1));
      mark('previewVisible', String(visibleCount()));
      mark('previewNodes', String(nodeCount()));
      return;
    }

    if (mode === 'cycle10') {
      // 需求 F8.2：重复打开关闭 10 次，不泄漏、不累积遮罩
      let worstVisibleAfterClose = 0;
      let worstNodesAfterClose = 0;
      for (let round = 0; round < 10; round += 1) {
        button.click();
        button.click();
        worstVisibleAfterClose = Math.max(worstVisibleAfterClose, visibleCount());
        worstNodesAfterClose = Math.max(worstNodesAfterClose, nodeCount());
      }
      mark('previewCycles', '10');
      mark('previewVisibleAfterClose', String(worstVisibleAfterClose));
      mark('previewNodesAfterClose', String(worstNodesAfterClose));
      // 只统计**可见**的遮罩层。页面里本来就有设置/规则对话框的 .modal-overlay，
      // 它们带 hidden 属性常驻 DOM；把它们算进来会得到一个永远非零的假告警。
      const visibleOverlays = [...document.querySelectorAll<HTMLElement>(
        '[class*=overlay],[class*=mask],[class*=backdrop]',
      )].filter((node) => !node.hidden && node.getClientRects().length > 0).length;
      mark('previewOverlays', String(visibleOverlays));
      return;
    }

    if (mode === 'typing') {
      // 需求 F8.2：预览打开期间编辑器仍可输入（预览不应独占）
      button.click();
      mark('previewVisible', String(visibleCount()));
      const content = document.querySelector<HTMLElement>('.cm-content');
      if (!content) {
        mark('typingResult', 'no-editor');
        return;
      }
      const before = content.textContent ?? '';
      content.focus();
      // execCommand 会产生真实的 beforeinput/input 事件，CM6 按正常路径接收
      document.execCommand('insertText', false, '预览期间输入');
      const after = content.textContent ?? '';
      mark('typingResult', after !== before ? 'changed' : 'unchanged');
      mark('typingContentEditable', content.getAttribute('contenteditable') ?? 'null');
      // 中心点最上层元素必须仍在编辑器内，说明没有被全屏遮罩挡住
      const rect = content.getBoundingClientRect();
      const top = document.elementFromPoint(
        Math.round(rect.left + rect.width / 2),
        Math.round(rect.top + Math.min(rect.height / 2, 20)),
      );
      mark('typingTopmost', top && content.contains(top) ? 'editor' : (top?.className || top?.tagName || 'null'));
      return;
    }

    if (mode === 'sweep') {
      // T9.18：顶栏其余按钮逐个点一遍，确认没有「点了不返回」的同类状态机问题。
      // 判据是 click 的同步耗时 —— F8 那种故障会让 click 永不返回，
      // 这里因此拿不到 dump（进程被杀），本身就是失败信号。
      const ids = [
        'btn-open',
        'btn-save',
        'btn-preview',
        'btn-export',
        'btn-rules',
        'btn-settings',
        'btn-upload',
        'btn-history',
        'btn-rollback',
      ];
      const parts: string[] = [];
      for (const id of ids) {
        const node = document.getElementById(id) as HTMLButtonElement | null;
        if (!node) {
          parts.push(`${id}:missing`);
          continue;
        }
        if (node.disabled) {
          // 「打开/另存为」在浏览器模式下不可用（依赖 Tauri 契约），保持跳过；
          // 同步三键在未配置服务端时是 disabled，但它们内部只是「置一条提示后返回」，
          // 强制启用一次才能真正覆盖到处理函数，否则这一格等于没测。
          if (id.startsWith('btn-') && !['btn-open', 'btn-save'].includes(id)) {
            node.disabled = false;
            const startedForce = performance.now();
            let forcedState = 'ok';
            try {
              node.click();
            } catch (error) {
              forcedState = `threw(${(error as Error).message.slice(0, 30)})`;
            }
            parts.push(`${id}:${(performance.now() - startedForce).toFixed(1)}ms:${forcedState}(forced)`);
            node.disabled = true;
          } else {
            parts.push(`${id}:disabled`);
          }
          continue;
        }
        const started = performance.now();
        let state = 'ok';
        try {
          node.click();
        } catch (error) {
          state = `threw(${(error as Error).message.slice(0, 30)})`;
        }
        const elapsed = performance.now() - started;
        parts.push(`${id}:${elapsed.toFixed(1)}ms:${state}`);
        // 关掉可能弹出的对话框，否则会挡住后续点击
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        for (const close of document.querySelectorAll<HTMLElement>('.modal-close,[data-close]')) {
          if (close.getClientRects().length > 0) close.click();
        }
        // 预览是开关，点成打开后要再点回来，避免状态污染后续按钮
        if (id === 'btn-preview' && visibleCount() > 0) node.click();
      }
      // 全部点完再看一次：可见遮罩应为 0，页面仍可响应
      const leftover = [...document.querySelectorAll<HTMLElement>(
        '[class*=overlay],[class*=mask],[class*=backdrop]',
      )].filter((node) => !node.hidden && node.getClientRects().length > 0).length;
      mark('sweepResults', parts.join(' | '));
      mark('sweepVisibleOverlays', String(leftover));
      mark('sweepVisiblePreview', String(visibleCount()));
      return;
    }
  }

  /** 启动时探测一次已保存的配置；失败静默（不打扰编辑） */
  private async autoProbe(): Promise<void> {
    let serverUrl = this.authServerUrl;
    let legacyToken = this.settingsToken;
    try {
      const config = await configGet();
      this.settingsToken = config.token;
      // 认证请求用的地址与探测用的地址同源：都没配置时一并留空，
      // 这样"点登录"会明确提示去设置里填地址，而不是打向一个默认端口
      this.authServerUrl = config.serverUrl;
      serverUrl = config.serverUrl;
      legacyToken = config.token;
    } catch {
      // 浏览器模式（无 C5 能力）读不到配置：回落到 ?serverUrl= 调试参数。
      // 这不是给正式用户用的入口 —— 壳里永远能读到配置，走不到这里。
    }

    if (!serverUrl.trim()) return;
    // 账户令牌优先：登录后顶栏的"已连接"依据的是**账户**身份，
    // 不能还拿 v0.1.1 的全局令牌去探（那会掩盖"登录没成功"）
    const accountToken = this.authSession?.accessToken ?? '';
    try {
      const result = await probeServer({
        serverUrl,
        token: accountToken !== '' ? accountToken : legacyToken,
      });
      this.applyConnection(result);
    } catch {
      // 探测失败：保持"未连接"，不影响本地功能
    }
  }

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

    for (const id of ['btn-upload', 'btn-history', 'btn-rollback']) {
      byId<HTMLButtonElement>(id).disabled = false;
    }

    const gate = this.syncGate();
    const summary = syncHintText(gate, result?.cardCount ?? null);
    hint.textContent = summary.text;
    hint.className = `sync-hint ${summary.tone}`;
    // 端到端断言用：不靠读文案判断门槛
    document.body.dataset['syncGate'] = gate;
  }

  // ── 构造 ────────────────────────────────────────────────
  private createBlock(snapshot: EditorBlockSnapshot): BlockRuntime {
    const section = el('section', 'block');
    section.dataset['blockId'] = snapshot.id;

    const header = el('button', 'block-head');
    header.type = 'button';

    const caret = el('span', 'caret', '▸');
    const title = el('span', 'block-title', snapshot.label);
    const meta = el('span', 'block-meta', `${snapshot.length} 字`);

    // 缺失标记：CardBlock.missing 的语义是「导入源里根本没有这个板块」，
    // shared 要求 UI 显式标出，不允许让它看起来像「用户清空了」。
    // 因此这里在标题旁常驻一个小标签，与「空块」在视觉上区分开。
    const missingTag = el('span', 'block-missing', '原文缺失');
    missingTag.hidden = !snapshot.missing;
    missingTag.title = '导入源中没有该板块，已按空处理；填写后会在导出时写入';

    const badge = el('span', 'block-badge');
    badge.hidden = true;

    header.append(caret, title, missingTag, meta, badge);
    if (snapshot.missing) section.dataset['missing'] = '1';

    const body = el('div', 'block-body');
    body.hidden = true;

    const host = el('div', 'cm-host');
    const preview = el('div', 'preview');
    preview.hidden = true;
    // 世界书块额外挂「导入 / 导出」——世界书是唯一能从外部独立导入导出的板块，
    // 入口放在它自己的块里，用户不用去别处找（T10.9）。
    if (snapshot.id === 'worldbook') body.append(this.buildWorldbookActions());
    body.append(host, preview);

    section.append(header, body);

    const runtime: BlockRuntime = {
      snapshot,
      section,
      body,
      host,
      preview,
      badge,
      editor: null,
      expanded: false,
      previewOn: false,
    };

    header.addEventListener('click', () => this.toggle(runtime));
    this.blockList.append(section);
    return runtime;
  }

  // ── 展开 / 折叠（懒渲染核心）──────────────────────────────
  private toggle(runtime: BlockRuntime): void {
    if (runtime.expanded) this.collapse(runtime);
    else this.expand(runtime);
  }

  private expand(runtime: BlockRuntime, silent = false): void {
    if (runtime.expanded) return;
    runtime.expanded = true;
    runtime.body.hidden = false;
    runtime.section.classList.add('expanded');
    runtime.section.querySelector('.caret')!.textContent = '▾';

    // 懒渲染：只有展开时才创建 CodeMirror 实例
    if (!runtime.editor) {
      runtime.editor = new BlockEditor({
        parent: runtime.host,
        blockId: runtime.snapshot.id,
        text: runtime.snapshot.text,
        compiled: this.rules?.highlight ?? null,
        onChange: (text) => this.onBlockChange(runtime, text),
      });
      runtime.editor.setIssues(this.issuesFor(runtime.snapshot.id));
    }
    if (!silent) runtime.editor.view.focus();
  }

  private collapse(runtime: BlockRuntime): void {
    if (!runtime.expanded) return;
    runtime.expanded = false;
    runtime.body.hidden = true;
    runtime.section.classList.remove('expanded');
    runtime.section.querySelector('.caret')!.textContent = '▸';

    // 折叠即销毁：保证隐藏板块不进 DOM（含 CodeMirror 的 contenteditable 结构）
    runtime.editor?.destroy();
    runtime.editor = null;
    runtime.host.replaceChildren();
  }

  // ── 编辑 → 校验 ──────────────────────────────────────────
  private onBlockChange(runtime: BlockRuntime, text: string): void {
    // 走 session：它内部会置脏并让审计缓存失效。
    // 直接 `this.card = result.card` 会绕过这两件事 —— 那正是脏标记不可靠的老原因。
    // 记下改之前是否已脏：脏标记只在「首次变脏」时才会改变标签文字，
    // 每敲一个字都重绘整个标签栏是白费（TabBar.render 会重建 DOM）。
    const wasDirty = this.session.dirty;
    const result = this.session.setBlockText(runtime.snapshot.id, text);
    if (!result.changed) return;

    runtime.snapshot = {
      ...runtime.snapshot,
      text,
      length: [...text].length,
      empty: text.trim() === '',
    };
    // 标签上的 ● 必须跟着第一次改动立刻出现。
    // 之前这里只刷了统计与校验，于是「改完内容后标签看不出有未保存修改」，
    // 要等切标签/新建才补上（2026-10-22 T9.14 端到端抓到的缺陷）。
    if (!wasDirty && this.session.dirty) this.refreshTabs();
    this.refreshStats();
    this.scheduleValidate(260);
  }

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
    this.refreshBlockBadges(report.issues);
    // 顶栏计数必须跟着报告走，否则会出现"顶栏 错误 0 / 面板 错误 1"
    this.refreshStats();
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
    this.expand(runtime, true);
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
  private refreshStats(): void {
    const total = totalLength(this.blocks.map((block) => block.snapshot));
    const totalCp = [...[...this.blocks.map((b) => b.snapshot.text)].join('')].length;
    // 等级计数一律取 lastSummary：它是「最近一次审计报告」的唯一投影。
    // 若在这里数 this.issues，会和 report.summary 形成两个数据源
    // （曾导致顶栏显示"错误 0"而审计面板显示"错误 1"）。
    const { error: errors, warning: warnings } = this.lastSummary;

    this.toolbarStats.replaceChildren(
      el('span', 'stat', `六板块 ${totalCp} 字`),
      el('span', 'stat', `块内合计 ${total} 字`),
      el('span', `stat ${errors > 0 ? 'bad' : 'ok'}`, `错误 ${errors}`),
      el('span', `stat ${warnings > 0 ? 'warn' : 'ok'}`, `警告 ${warnings}`),
    );
  }

  private refreshBlockBadges(all: readonly AuditIssue[]): void {
    for (const runtime of this.blocks) {
      const mine = all.filter((issue) => issue.location.blockId === runtime.snapshot.id);
      const errors = mine.filter((i) => i.severity === 'error').length;
      const warnings = mine.filter((i) => i.severity === 'warning').length;
      const total = mine.length;

      runtime.section.dataset['errors'] = String(errors);
      runtime.section.dataset['warnings'] = String(warnings);

      const meta = runtime.section.querySelector('.block-meta');
      if (meta) meta.textContent = `${runtime.snapshot.length} 字`;

      if (total === 0) {
        runtime.badge.hidden = true;
        runtime.badge.textContent = '';
        continue;
      }
      runtime.badge.hidden = false;
      // 只有提示级问题时不能显示「0 警告」——按最严重的一级决定文案
      if (errors > 0) {
        runtime.badge.textContent = `${errors} 错误`;
        runtime.badge.className = 'block-badge bad';
      } else if (warnings > 0) {
        runtime.badge.textContent = `${warnings} 警告`;
        runtime.badge.className = 'block-badge warn';
      } else {
        runtime.badge.textContent = `${total} 提示`;
        runtime.badge.className = 'block-badge info';
      }
    }
  }


  // ── 角色名就地编辑（F10）──────────────────────────────────
  //
  // 为什么必须改 meta.name 而不是只改显示文本：导出 JSON 的角色名取自 meta.name。
  // 之前顶栏只是个只读 div，用户永远改不到 meta.name，导出的 JSON 里角色名
  // 就一直是最初那个样例名 —— 这是 F10 要根治的问题。
  //
  // 与【基本信息】板块里的「姓名」行不双写：meta.name 是唯一数据源，
  // 正文里的姓名由用户自己维护（面板会给 info 级提示，但不强制同步，也不回写）。
  private wireNameEditor(): void {
    const display = byId<HTMLButtonElement>('card-name');
    const input = byId<HTMLInputElement>('card-name-input');
    /** 进入编辑时记住原值，Esc 要能退回去 */
    let original = '';

    const begin = (): void => {
      // 进编辑就算"用户已经知道这里能改"——不必等他真的改成功
      this.hideNameHint();
      original = this.card.meta.name;
      input.value = original;
      display.hidden = true;
      input.hidden = false;
      input.focus();
      // 全选：改名通常是想整个换掉，而不是在中间插字
      input.select();
    };

    const commit = (): void => {
      if (input.hidden) return;
      input.hidden = true;
      display.hidden = false;
      const next = input.value.trim();
      if (next === original) {
        // 没改就什么都不做 —— 免得把「点了一下又点走」记成一次内容变更
        this.renderCardName();
        return;
      }
      this.applyCardName(next);
    };

    const cancel = (): void => {
      if (input.hidden) return;
      input.hidden = true;
      display.hidden = false;
      this.renderCardName();
    };

    display.addEventListener('click', begin);

    // T10.29：点提示文字等同于点角色名 —— 提示是"可点的路标"，点它没反应比没有提示更差。
    // 两条路径都要把"用户已经知道这里能改"记下来（进入编辑就算知道了，不必等改成功）。
    const hint = byId<HTMLElement>('card-name-hint');
    hint.addEventListener('click', () => {
      this.hideNameHint();
      begin();
    });

    // 失焦即确认：这是这类就地编辑的通行行为，用户点别处就是不打算改了
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      }
    });
  }

  /**
   * 刷新「← 点这里改角色名」提示（v0.1.2 反馈项四 / T10.29）。
   *
   * 三个条件同时成立才显示：**有一张卡**（零标签时角色名显示的是"未打开角色卡"，
   * 点它没有意义）、**用户还没点过**（localStorage 记录）、**不在编辑态**。
   * 第一次判定在启动时做，切换会话/新建打开后也调一次 —— 否则从零标签进入一张卡
   * 之后提示永远不出现（零标签那次被第一条挡住了）。
   */
  private refreshNameHint(): void {
    const hint = byId<HTMLElement>('card-name-hint');
    const inputVisible = !byId<HTMLInputElement>('card-name-input').hidden;
    const show = this.hasSession && !inputVisible && shouldShowNameHint(browserHintStore());
    hint.hidden = !show;
  }

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

  /** 设置里「重置」之后让提示重新出现（不然这个功能只对新用户有效） */
  resetNameHintForDemo(): void {
    resetNameHint(browserHintStore());
    this.refreshNameHint();
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
        logError = describe(error);
      }
    } else {
      logError = '本次会话还没有写入过错误日志（没有捕获到异常，或日志落盘失败）';
    }

    const info = await shellInfo().catch(() => null);
    const text = buildDiagnosticsText({
      logText,
      ...(logError === undefined ? {} : { logError }),
      appVersion: this.appVersion(),
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
      return `导出失败：写入被拒绝（${describe(error)}）`;
    }
    return `诊断日志已导出：${target}（${String(text.length)} 字符）`;
  }

  /**
   * 应用版本。
   *
   * 从 `client/package.json` 读（Vite 在构建期把它内联进来），**不硬编码**——
   * 硬编码的版本号一定会漂，而诊断日志里版本错了等于白导。
   *
   * 为什么不用 `<html data-version>`：那需要在构建期改写 index.html，
   * 而内联脚本会被 CSP 的 `script-src 'self'` 拦掉（本项目刻意不开 unsafe-inline）。
   * 走 import 就没有这个约束，也不引入新的构建期插件。
   */
  private appVersion(): string {
    const version = (clientPackage as { version?: unknown }).version;
    return typeof version === 'string' && version !== '' ? version : '未知';
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
    this.refreshNameHint();
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
    openButton.addEventListener('click', () => void this.openCard());
    saveButton.addEventListener('click', () => void this.saveCard());
    previewButton.addEventListener('click', () => this.togglePreview());
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
      this.collapse(runtime);
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
    for (const id of ['btn-save', 'btn-preview', 'btn-export', 'btn-rules']) {
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
    openBtn.addEventListener('click', () => void this.openCard());
    actions.append(newBtn, openBtn);

    empty.append(title, hint, actions);
    this.blockList.append(empty);

    // 顶栏与统计清空，避免残留上一张卡的信息
    byId('card-name').textContent = '未打开角色卡';
    byId('stats').textContent = '';
    // 零标签没有可改的名字，"点这里改角色名"必须收起来（T10.29）
    this.refreshNameHint();
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
      const decision = await this.confirmClose(session);
      if (decision === 'cancel') return;
      if (decision === 'save') {
        const saved = await this.saveSessionToDisk(session);
        if (!saved) return; // 保存失败或用户取消保存对话框 → 中止关闭
      }
    }

    this.sessions.splice(index, 1);

    if (this.activeId === id) {
      const next = this.sessions[index] ?? this.sessions[index - 1] ?? null;
      this.activeId = next?.id ?? null;
      // 先清掉旧 UI，再按新会话（或空工作台）重建
      for (const runtime of this.blocks) {
        this.collapse(runtime);
        runtime.section.remove();
      }
      this.blocks = [];
      this.mountActiveSession();
    }

    this.refreshTabs();
  }

  /** 三选确认：保存并关闭 / 不保存关闭 / 取消 */
  private confirmClose(session: CardSession): Promise<'save' | 'discard' | 'cancel'> {
    return new Promise((resolve) => {
      const overlay = el('div', 'modal-overlay');
      const panel = el('div', 'modal confirm-close-modal');
      const head = el('div', 'modal-head');
      head.append(el('h2', 'modal-title', '有未保存的修改'));
      const body = el('div', 'modal-body');
      body.append(
        el(
          'p',
          'confirm-text',
          `「${session.displayName}」有尚未保存到磁盘的修改。关闭前要保存吗？`,
        ),
      );
      const foot = el('div', 'modal-foot');
      const cancel = el('button', 'btn', '取消');
      cancel.type = 'button';
      const discard = el('button', 'btn', '不保存关闭');
      discard.type = 'button';
      const save = el('button', 'btn primary', '保存并关闭');
      save.type = 'button';
      foot.append(cancel, discard, save);
      panel.append(head, body, foot);
      overlay.append(panel);
      document.body.append(overlay);

      const finish = (value: 'save' | 'discard' | 'cancel'): void => {
        overlay.remove();
        resolve(value);
      };
      cancel.addEventListener('click', () => finish('cancel'));
      discard.addEventListener('click', () => finish('discard'));
      save.addEventListener('click', () => finish('save'));
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) finish('cancel');
      });
      document.addEventListener(
        'keydown',
        (event) => {
          if (event.key === 'Escape' && overlay.isConnected) {
            event.preventDefault();
            finish('cancel');
          }
        },
        { once: true },
      );
      save.focus();
    });
  }

  /**
   * 保存指定会话到磁盘（另存为语义）。
   *
   * **只改会话状态**：路径与脏标记都写在 session 上，app.ts 不再有游离字段。
   * 这是 T9.2 一并要求的「另存为只改会话状态」。
   */
  private async saveSessionToDisk(session: CardSession): Promise<boolean> {
    try {
      // 默认落点 = cardsDir（F4）；文件名取角色名，重名自动追加序号
      const dir = await effectiveCardsDir();
      const suggested = await suggestCardFileName(session.card.meta.name, dir);
      const target = await pickSavePath(suggested, 'json', dir === '' ? undefined : dir);
      if (!target) return false;

      const text = serializeCard(session.card);
      const receipt = await writeFileAtomic(target, text);
      session.markSaved(target);
      this.refreshTabs();
      this.renderCardName();
      this.setStatus(
        `已保存：${receipt.pathDisplay ?? '(非 UTF-8 路径)'} · ${receipt.bytesWritten} 字节 · ` +
          `sha256 ${receipt.sha256.slice(0, 12)}… · 回读${receipt.verified ? '一致' : '不一致！'}`,
        receipt.verified ? 'ok' : 'bad',
      );
      return true;
    } catch (error) {
      this.setStatus(`保存失败：${describe(error)}`, 'bad');
      return false;
    }
  }

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
    // createEmptyCard 给出六板块骨架；预设决定导出时的标题与顺序（docs/15 §1），
    // 但空卡阶段没有正文，所以这里只需要把骨架建出来。
    const blank = createEmptyCard(request.name);
    const withId = withCardId(blank, request.cardId);

    // 新建 = 追加一个会话（而不是替换当前卡）。这是 F1 与 F2 的结合点：
    // 用户点「+」是想再开一张，不是想把手上这张扔掉。
    const session = new CardSession({
      card: withId,
      cardId: request.cardId,
      platformId: this.rules?.platformId,
      highlightId: this.rules?.highlightId,
      presetId: preset?.id ?? null,
      filePath: null,
    });
    this.sessions.push(session);
    this.activeId = session.id;

    // 切换过去：把旧 UI 拆掉、按新会话重建
    for (const runtime of this.blocks) {
      this.collapse(runtime);
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

  private async openCard(): Promise<void> {
    try {
      const dir = await effectiveCardsDir();
      // T10.9：过滤器放开 .txt —— TXT 角色卡**没有 JSON 信封**，整篇按当前预设切板块
      const path = await pickCardFile(dir === '' ? undefined : dir, { allowText: true });
      if (!path) return;
      const file = await readTextExact(path);

      // 按扩展名分流，而不是「先试 JSON、失败再退回 TXT」：后者会把一个语法错误的
      // JSON 悄悄当成纯文本再解析一次，用户看到的是一份莫名其妙的板块缺失列表，
      // 而真正的原因（JSON 少了个逗号）被完全掩盖。
      //
      // 零标签（v0.1.2 反馈项三）：**先建会话再导入**。以前这里直接
      // `importCardTextFile` / `replaceCard`，两者都要求"当前有一张卡"，
      // 于是零标签下点「打开…」选 TXT 只会得到一句"先打开或新建一张卡" ——
      // 而用户想做的就是打开这一份。名字只能从文件名推导（见 open-name.ts）。
      const created = this.hasSession ? null : this.createSessionFromFile(path);

      if (/\.txt$/i.test(path)) {
        await this.importCardTextFile(file.pathDisplay ?? path, file.text, created);
        return;
      }

      const parsed = parseStCard(file.text);
      this.replaceCard(parsed.card);
      // 打开的文件不在 cardsDir 里时说一句：用户会以为"打开过的卡都在那个目录"
      const outside = dir !== '' && !path.toLowerCase().startsWith(dir.toLowerCase());
      const opened = `已打开：${file.pathDisplay ?? '(非 UTF-8 路径)'}（${file.bytesLen} 字节）`;
      this.setStatus(
        created === null
          ? opened + (outside ? ` —— 该文件不在卡片目录内，另存时会回到 ${dir}` : '')
          : `已新建「${created}」并打开：${file.pathDisplay ?? '(非 UTF-8 路径)'}（${file.bytesLen} 字节）${
              outside ? ` —— 该文件不在卡片目录内，另存时会回到 ${dir}` : ''
            }`,
        outside ? 'warn' : created === null ? 'info' : 'ok',
      );
    } catch (error) {
      this.setStatus(`打开失败：${describe(error)}`, 'bad');
    }
  }

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
    const preset = this.rules?.preset ?? null;
    const blank = createEmptyCard(name);
    const cardId = generateCardId(name);
    const card = withCardId(blank, cardId);

    const session = new CardSession({
      card,
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
      this.collapse(runtime);
      runtime.section.remove();
    }
    this.blocks = [];
    this.mountActiveSession();
    this.refreshTabs();
    return name;
  }

  /**
   * 「另存为…」按钮。
   *
   * 与 closeSession 的「保存并关闭」**共用同一个实现**（saveSessionToDisk）：
   * 两处各写一遍的话，路径/脏标记的更新迟早会有一边漏掉。
   * 注意它改的只是**会话状态**（session.filePath / dirty），
   * app.ts 里没有任何文件路径字段。
   */
  private async saveCard(): Promise<void> {
    if (!this.hasSession) return;
    await this.saveSessionToDisk(this.session);
  }

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
  private async importCardTextFile(
    fileName: string,
    text: string,
    createdSession: string | null = null,
    autoConfirm = false,
  ): Promise<void> {
    if (!this.hasSession) {
      this.setStatus('先打开或新建一张卡，再导入 TXT（导入会替换当前卡的板块内容）', 'warn');
      return;
    }
    // 不 await：对话框要等用户点确认/取消。自动确认（截图与端到端用）时
    // 先让渲染跑一帧再点按钮 —— 否则 querySelector 拿到的还是上一轮隐藏的节点。
    const pending = this.importDialog?.openCardText(fileName, text);
    if (autoConfirm) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      document.querySelector<HTMLButtonElement>('[data-role="import-confirm"]')?.click();
    }
    const decision = await pending;
    if (!decision || !('card' in decision)) {
      // 用户取消：零标签下刚建的那张卡**留着**（它是用户点「打开…」的直接结果，
      // 而且里面还是空卡，没有需要回滚的内容）。状态栏说明这一点，避免"我点了取消
      // 怎么多了一张卡"的困惑。
      if (createdSession !== null) {
        this.setStatus(`已新建「${createdSession}」（空卡）；TXT 导入已取消，未写入任何内容`, 'info');
      }
      return;
    }

    this.session.replaceCard(decision.card);
    this.reloadBlocksFromCard();
    this.scheduleValidate(0);

    const prefix = createdSession === null ? `已导入 TXT：${fileName}` : `已新建「${createdSession}」并导入：${fileName}`;

    // 保全机制（v0.1.2 反馈项二）之后，导入结果的说明重心从"缺了几个板块"
    // 变成"多少原文被放到了哪里" —— 后者才是用户需要知道的事。
    // 措辞由 import-flow.preservedNoteOf 统一给出，对话框里显示的是同一句。
    if (decision.preservedNote !== '') {
      const tone = decision.preserved?.wholeText === true ? 'warn' : 'info';
      this.setStatus(`${prefix} —— ${decision.preservedNote}`, tone);
      return;
    }
    this.setStatus(`${prefix}（原文全部识别，无未识别内容）`, 'ok');
  }

  /**
   * 世界书导入（T10.9）。
   *
   * 破坏性操作：**替换**整个世界书板块（entries + 文本）。所以：
   *   · 对话框必须报出条目数（让用户知道覆盖了多少）；
   *   · `preview.canImport === false` 时一律不写回 —— 残缺结果会把
   *     "没解析出来的条目"当成"用户删除"，一次导入能清空整个世界书。
   */
  private async importWorldbookFile(fileName: string, text: string): Promise<void> {
    if (!this.hasSession) {
      this.setStatus('先打开或新建一张卡，再导入世界书', 'warn');
      return;
    }
    const decision = await this.importDialog?.openWorldbook(fileName, text, this.worldbookPreset.format);
    if (!decision || !('preview' in decision)) return;

    const next = applyWorldbookImport(this.card, decision.preview);
    if (next === null) {
      this.setStatus('世界书导入被拒绝：解析结果不完整，未修改当前卡片', 'bad');
      return;
    }

    // 记下原文：未改动时导出走逐字节写回（JSON 往返无损的唯一可靠实现）
    this.session.setWorldbookSource(decision.result);
    this.session.replaceCard(next);
    this.reloadBlocksFromCard();
    this.scheduleValidate(0);
    this.setStatus(
      `已导入世界书：${String(decision.result.entries.length)} 个条目（格式 ${
        decision.result.format === 'json' ? 'JSON' : 'TXT'
      }），未改动时导出将逐字节还原原文`,
      'ok',
    );
  }

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
            : ` —— ${result.reason ?? '已按规范重新序列化'}`),
        result.verbatim ? 'ok' : 'warn',
      );
    } catch (error) {
      this.setStatus(`导出世界书失败：${describe(error)}`, 'bad');
    }
  }

  private replaceCard(card: UnifiedCard): void {
    // 走 session：它会深拷贝，避免调用方后续改动这份卡数据时渗透进会话。
    // 但"打开文件/导入"应当重置脏标记 —— 刚载入的内容相对磁盘是干净的。
    this.session.replaceCard(card);
    this.session.markSaved(this.session.filePath);
    this.reloadBlocksFromCard();
    this.scheduleValidate(0);
  }

  private setStatus(text: string, kind: 'ok' | 'warn' | 'bad' | 'info' = 'info'): void {
    this.statusBar.textContent = text;
    this.statusBar.className = `status ${kind}`;
  }

  // ── 调试/截图入口（走真实逻辑，不伪造状态）──────────────────
  selectPresetForDemo(id: string): void {
    this.selectPresetById(id);
    this.refreshRulesLabel();
  }

  applyPresetForDemo(id: string): void {
    const preset = this.rules?.presets.find((item) => item.id === id);
    if (!preset) return;
    const decision = decideApplyPreset(this.card, preset);
    if (decision.kind !== 'confirm') {
      this.setStatus(decision.kind === 'noop' ? decision.message : '没有可应用的变化', 'warn');
      return;
    }
    // 与 UI 里的「应用预设」走同一条路径，只是跳过 window.confirm（自动化无法应答）
    this.commitPresetApply(preset, decision.plan);
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
    this.refreshRulesLabel();
    this.refreshStats();
    this.setStatus(
      `已应用预设「${preset.name}」：${plan.changes.join('；') || '标题样式已重排'} · 已按新格式重检`,
      'ok',
    );
  }

  switchPlatformForDemo(id: string): void {
    this.switchPlatform(id);
    this.refreshRulesLabel();
  }

  switchHighlightForDemo(id: string): void {
    this.switchHighlight(id);
    this.refreshRulesLabel();
  }

  openRulesDialogForDemo(): void {
    this.rulesDialog?.open();
  }

  /**
   * T10.34 验收演示：一份「条目4：爱好」数据走**自定义路径**（截图用）。
   *
   * 走的是真实链路，没有伪造状态：
   *   · 自定义 TXT 预设 → 经 importTxtPresetText（同一套原子回退/同 id 覆盖）；
   *   · 中文世界书预设 → preset-library；
   *   · 自定义平台规则 → 经 importPlatformText（schema 校验 + 继承解析）；
   *   · 世界书条目 → importWorldbook 按自定义格式解析出来，再回写成 TXT。
   */
  applyCustomTrackDemo(mode: 'rules' | 'audit' | 'warn'): void {
    // 零标签时先建一张卡：this.card 只在有活动会话时可用，
    // 直接写卡片状态会抛「当前没有活动会话」而整段演示静默中断。
    if (!this.hasSession) this.createSessionFromFile('自定义路径演示.txt');
    // warn 模式：删掉「关键词」行 + 触发深度写 88（越界），用来展示自定义规则的
    // 与内置默认规则集各自报什么（验收第 ③④ 条）。
    const sample =
      mode === 'warn'
        ? ['条目4：', '名称：爱好', '触发深度：88', '内容：', '主角喜欢读书和看电影。', '条目4结束', ''].join('\n')
        : [
            '条目4：',
            '名称：爱好',
            '关键词：读书、电影',
            '触发深度：5',
            '内容：',
            '主角喜欢读书和看电影。',
            '条目4结束',
            '',
          ].join('\n');

    const customWb = {
      schemaVersion: 1 as const,
      id: 'cn-kv',
      name: '中文键值世界书',
      version: '1.0.0',
      description: '条目{id}：/ 名称：/ 关键词：/ 触发深度：/ 内容：',
      format: {
        entryOpen: '条目{id}：',
        contentMark: '内容：',
        entryClose: '条目{id}结束',
        fieldOrder: ['name', 'keys', 'insertion_order'],
        labelMap: { name: '名称', keys: '关键词', insertion_order: '触发深度' },
        fieldSeparator: '：',
        listSeparator: '、',
        entrySeparator: '\n',
      },
    };

    // 1) 自定义 TXT 预设（复制内置那份并改 id，模拟"导入用户自己的格式"）
    const basePreset = this.rules?.presets.find((item) => item.id === 'default');
    if (basePreset) {
      this.importTxtPresetText(
        JSON.stringify({ ...basePreset, id: 'my-format', name: '我的格式', builtin: false }),
      );
    }

    // 2) 自定义世界书预设并选中
    const wbOutcome = this.importWorldbookPresetText(JSON.stringify(customWb));
    if (wbOutcome.ok && wbOutcome.id !== null) this.selectWorldbookPreset(wbOutcome.id);

    // 3) 解析样本 → 写入卡片的世界书（按自定义格式回写 TXT，结构检查才不会误报）
    const format = this.worldbookPreset.format;
    const parsed = importWorldbook(sample, format);
    if (parsed.entries.length > 0) {
      this.card.worldbook = {
        entries: parsed.entries,
        text: renderWorldbookTextWith(parsed.entries, format),
        dirty: false,
        raw: null,
      };
      this.reloadBlocksFromCard();
    }

    // 4) 自定义平台规则（经真实导入路径）
    this.importPlatformText(
      JSON.stringify({
        schemaVersion: 1,
        id: 'my-worldbook-policy',
        name: '我的世界书规范',
        version: '1.0.0',
        target: { spec: 'any' },
        placeholders: { char: ['{{char}}'], user: ['{{user}}'] },
        fields: [],
        rules: [
          {
            id: 'mine:entry-name-required',
            type: 'non-empty',
            message: '条目名不能为空（{entry}）',
            scope: 'worldbook:entries[].name',
            severity: 'error',
            category: 'worldbook',
          },
          {
            id: 'mine:keys-not-empty',
            type: 'list-count',
            min: 1,
            message: '{entry}没有关键词，永远不会被触发',
            scope: 'worldbook:entries[].keys',
            severity: 'warning',
            category: 'worldbook',
          },
          {
            id: 'mine:depth-range',
            type: 'number-range',
            min: 0,
            max: 10,
            message: '触发深度必须在 0..10',
            scope: 'worldbook:entries[].insertion_order',
            severity: 'warning',
            category: 'worldbook',
          },
        ],
      }),
    );
    this.switchPlatform('my-worldbook-policy');
    this.validate();

    if (mode === 'rules') this.rulesDialog?.open();
    this.setStatus('演示：已导入自定义 TXT 预设 / 世界书预设 / 平台规则（走真实导入链路）', 'ok');
  }

  /**
   * 演示/验证用：注入一个**真实会被规则引擎判为 error** 的问题。
   *
   * 做法不是伪造报告——而是把卡片改成真正违规（清空 name、并把某必填字段写空），
   * 再走正常审计链路。这样弹出的拦截框与真实使用完全一致。
   */
  injectErrorForDemo(): void {
    const broken = structuredClone(this.card);
    // name 为空：多数平台规则将其判为 error（必填）
    broken.meta.name = '';
    // 再把基本信息正文清空，触发"必填板块为空"这类 error
    const basic = broken.blocks.find((block) => block.id === 'basic');
    if (basic) {
      basic.text = '';
      basic.dirty = true;
    }
    this.replaceCard(broken);
    this.validate();
    const { error } = this.lastSummary;
    this.setStatus(`演示：已注入 ${error} 个错误级问题（name 为空 + 基本信息为空）`, 'warn');
  }

  openExportForDemo(): void {
    this.exportDialog?.open('json');
  }

  /** 调试/截图：直接打开同步面板（需连接就绪） */
  openSyncForDemo(): void {
    this.syncDialog?.open();
  }

  /** 调试/截图：预选服务端卡片并加载其版本历史 */
  preselectSyncCardForDemo(cardId: string): void {
    // 只改"看哪张卡的历史"，不改上传目标 —— 上传目标恒为活动会话
    this.syncDialog?.selectCard(cardId);
  }

  /** 调试/截图：以给定地址+令牌连接一次（走真实 probeServer） */
  async connectForDemo(serverUrl: string, token: string): Promise<void> {
    this.settingsToken = token;
    const result = await probeServer({ serverUrl, token });
    this.applyConnection(result);
  }

  /**
   * 演示/验证用：喂一段**真实存在缺陷**的规则文本走完整导入链路，
   * 让「导入失败 + 原子回退 + 字段级错误」在界面上可见。
   * 文本取自真实规则文件并定向破坏（不是手搓的假结构）。
   */
  importBadRuleForDemo(): void {
    if (!this.rules) return;
    const sample = this.rules.platformSourceText[this.rules.platformId];
    let broken: string;
    if (sample) {
      const parsed = JSON.parse(sample) as Record<string, unknown>;
      const fields = Array.isArray(parsed['fields']) ? (parsed['fields'] as unknown[]) : [];
      // 定向破坏两处：清空 label、把 required 改成字符串
      if (fields.length > 0 && typeof fields[0] === 'object' && fields[0] !== null) {
        (fields[0] as Record<string, unknown>)['label'] = '';
      }
      if (fields.length > 1 && typeof fields[1] === 'object' && fields[1] !== null) {
        (fields[1] as Record<string, unknown>)['required'] = 'yes';
      }
      parsed['id'] = 'broken-demo';
      broken = JSON.stringify(parsed, null, 2);
    } else {
      broken = '{ "id": "broken-demo", "name": '; // 截断 JSON
    }

    const outcome = this.importPlatformText(broken);
    this.rulesDialog?.open();
    this.rulesDialog?.showImportFailure(outcome);
  }

  /** 演示/验证用：走真实的宽松 TXT 导入，让「原文缺失」标记可见 */
  applyDemoLenientText(): void {
    if (!this.rules?.preset) return;
    const text = '【基本信息】\n姓名：{{char}}\n年龄：24';
    const result = importCardText(this.card, text, this.rules.preset, 'lenient');
    if (!result.card) {
      this.setStatus(`演示导入被拒绝：${result.issues.map((i) => i.message).join('；')}`, 'bad');
      return;
    }
    this.replaceCard(result.card);
    this.setStatus(
      `演示：宽松导入仅含「基本信息」的 TXT，其余板块按「原文缺失」标记（${result.issues.length} 条提示）`,
      'warn',
    );
  }

  /**
   * 演示/截图/端到端入口：用内置样本文本走**真实的导入对话框**（T10.27）。
   *
   * 为什么要这类入口：浏览器直开（截图与 headless 验证就是这么跑的）没有壳能力，
   * 点「打开…」弹不出文件选择器。这里注入的只是**输入文本**，之后的分流、预览、
   * 保全装配、状态栏文案全是生产代码 —— 与 `?demo=lenient` 同一个套路。
   *
   * @param sample 'zero'（0 命中）/ 'mixed'（混合）/ 'clean'（全部标准板块）
   */
  async importSampleForDemo(sample: string): Promise<void> {
    const texts: Record<string, string> = {
      zero: [
        '条目1：这是一段完全自由的设定文本',
        '它没有使用任何【】或 ## 标题，所以整篇都不会被切分。',
        '',
        '条目2：第二段',
        '  缩进与空行都是原文的一部分',
        '',
        '条目3：结尾',
      ].join('\n'),
      mixed: [
        '【基本信息】',
        '姓名：林晚照',
        '年龄：27',
        '',
        '【性格】',
        '冷静，话少。',
        '',
        '## 战斗系统',
        '条目1：先攻按敏捷排序',
        '条目2：暴击倍率 1.5',
        '',
        '【其他设定】',
        '这是已识别到的其他设定内容。',
        '',
        '## 招式表',
        '条目甲：斩击',
        '条目乙：突刺',
      ].join('\n'),
      clean: [
        '【基本信息】',
        '姓名：林晚照',
        '年龄：27',
        '',
        '【性格】',
        '冷静，话少。',
        '',
        '【其他设定】',
        '普通设定。',
        '',
        '【特殊设定】',
        '无。',
        '',
        '【用户相关设定】',
        '{{user}} 是常客。',
      ].join('\n'),
    };
    const text = texts[sample];
    if (text === undefined) return;
    // 零标签时先按文件名建会话 —— 与「打开…」走同一条路径（T10.28）
    if (!this.hasSession) this.createSessionFromFile(`演示-${sample}.txt`);
    await this.importCardTextFile(`演示-${sample}.txt`, text, null, true);
  }

  /** 演示/截图入口：只打开导入对话框（不确认），用于截"导入前"那两张图 */
  async previewSampleForDemo(sample: string): Promise<void> {
    if (!this.hasSession) this.createSessionFromFile(`演示-${sample}.txt`);
    const texts: Record<string, string> = {
      zero: '条目1：这是一段完全自由的设定文本\n它没有使用任何【】或 ## 标题，所以整篇都不会被切分。\n\n条目2：第二段\n  缩进与空行都是原文的一部分\n\n条目3：结尾',
      mixed: '【基本信息】\n姓名：林晚照\n年龄：27\n\n【性格】\n冷静，话少。\n\n## 战斗系统\n条目1：先攻按敏捷排序\n条目2：暴击倍率 1.5\n\n【其他设定】\n这是已识别到的其他设定内容。\n\n## 招式表\n条目甲：斩击\n条目乙：突刺',
    };
    const text = texts[sample];
    if (text === undefined) return;
    await this.importDialog?.openCardText(`演示-${sample}.txt`, text);
  }

  /**
   * 演示/截图入口：注入一个真实的渲染层异常（T10.26）。
   *
   * 用 `window.dispatchEvent(new ErrorEvent(...))` 而不是 `setTimeout(() => { throw })`：
   * 前者走的就是全局 `error` 钩子，且不会让 headless Chrome 因为未捕获异常
   * 而提前退出（那样 `--dump-dom` 拿不到任何东西）。
   * 落盘在浏览器模式下是 no-op（`isShellAvailable()` 为 false），
   * 所以"日志文件里有记录"这条必须到壳里验 —— 见 scripts/verify-t1026-crash.mjs。
   */
  injectCrashForDemo(): void {
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: '演示注入：Uncaught TypeError: demo is not a function',
        error: new TypeError('demo is not a function'),
      }),
    );
  }

  /** 演示/截图入口：改名提示（T10.29）。`state` = 'show' 显示 / 'hide' 模拟已点过 */
  setNameHintForDemo(state: 'show' | 'hide'): void {
    if (state === 'hide') {
      dismissNameHint(browserHintStore());
      const hint = byId<HTMLElement>('card-name-hint');
      hint.hidden = true;
      return;
    }
    resetNameHint(browserHintStore());
    this.refreshNameHint();
  }
}

function describe(error: unknown): string {
  const shellError = error as Partial<ShellError>;
  if (typeof shellError?.code === 'string') {
    return `[${shellError.code}] ${shellError.message ?? ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}

// ── 启动 ────────────────────────────────────────────────────
async function boot(): Promise<void> {
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
      card = parseStCard(sampleCardJson as unknown).card;
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

  // 调试/截图入口：?demo=lenient 用「只有基本信息」的 TXT 走一次**真实的宽松导入**，
  // 用于验证/展示「原文缺失」标记。走的是 shared 的 applyCardText，不伪造状态。
  if (params.get('demo') === 'lenient') {
    app.applyDemoLenientText();
  }

  // T10.27：三种样本的真实导入（0 命中 / 混合 / 全部标准），用于截图与端到端。
  //   ?import=zero|mixed|clean   走真实导入流程（会确认）
  //   ?importPreview=zero|mixed  只打开导入对话框（截"导入前"）
  const importSample = params.get('import');
  if (importSample !== null) await app.importSampleForDemo(importSample);
  const importPreview = params.get('importPreview');
  if (importPreview !== null) await app.previewSampleForDemo(importPreview);

  // T10.26：注入一个真实渲染层异常（走全局 error 钩子）
  if (params.get('crashInject') === '1') app.injectCrashForDemo();

  // T10.29：改名提示的两态（show = 未点过 / hide = 已点过）
  const hintParam = params.get('nameHint');
  if (hintParam === 'show' || hintParam === 'hide') app.setNameHintForDemo(hintParam);

  // 调试/截图入口（T6.2/T6.3）：
  //   ?rules=1&preset=divider     打开规则面板并把预设选为 divider（不重排）
  //   ?rules=1&applyPreset=divider 直接执行「应用预设」（会重排，走同一套 plan→apply）
  //   ?platform=janitorai         切到指定平台规则（触发重检）
  //   ?highlight=dark             切到指定高亮方案
  const presetParam = params.get('preset');
  if (presetParam) app.selectPresetForDemo(presetParam);
  const applyParam = params.get('applyPreset');
  if (applyParam) app.applyPresetForDemo(applyParam);
  const platformParam = params.get('platform');
  if (platformParam) app.switchPlatformForDemo(platformParam);
  const highlightParam = params.get('highlight');
  if (highlightParam) app.switchHighlightForDemo(highlightParam);
  if (params.get('rules') === '1') app.openRulesDialogForDemo();
  // T10.34：自定义路径演示（截图用）——custom=rules 开面板，custom=audit 看审计
  const customParam = params.get('custom');
  if (customParam === 'rules' || customParam === 'audit' || customParam === 'warn') {
    app.applyCustomTrackDemo(customParam);
  }
  if (params.get('badImport') === '1') app.importBadRuleForDemo();
  // ?export=1           打开导出面板（正常路径）
  // ?export=1&forceError=1  先注入一个 error 级问题，用于展示拦截弹窗
  if (params.get('forceError') === '1') app.injectErrorForDemo();
  if (params.get('export') === '1') app.openExportForDemo();
  const syncUrl = params.get('syncUrl');
  const syncToken = params.get('syncToken');
  if (syncUrl && syncToken) {
    void (async () => {
      await app.connectForDemo(syncUrl, syncToken);
      if (params.get('sync') === '1') app.openSyncForDemo();
      // ?syncCard=card-xxxx 预选某张卡，便于截图展示版本历史
      const preselect = params.get('syncCard');
      if (preselect) app.preselectSyncCardForDemo(preselect);
    })();
  }

  // 便于性能脚本与调试访问（只挂载在 window 上，不参与业务逻辑）
  (window as unknown as Record<string, unknown>)['__tcs'] = { app };
}

void boot();
