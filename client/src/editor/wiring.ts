/**
 * 功能
 * 三块面板的事件接线：账号（登录/登出/删号/仓库令牌）、设置、卡名输入。
 * 从 EditorApp 搬出，3 个函数 362 行。
 *
 * 注意事项
 * 这三个都是"把回调挂到已渲染的 DOM 上"，本身不含业务逻辑 ——
 * 业务动作都通过 host 转给别的模块（`refreshHost` / `blockHost`）。
 *
 * 搬它们的判据是收益比：362 行 / 25 个依赖 = 13.9，比几个小簇都高。
 * wire* 系列一共 9 个 648 行，但全搬要 69 个依赖，那就不划算了 ——
 * 只挑这一组，因为它三个的依赖高度重合。
 *
 * `wireAccount` 里有两条独立分支：仓库令牌模式与账号登录模式。
 * 两者的可用动作不同（令牌模式没有"删号"），混着写会让按钮状态错乱。
 *
 * 踩过的坑
 * 这些函数里的 `void xxx()` 是有意的：事件处理器不能是 async
 * （返回 Promise 会被当成取消），必须显式丢弃。
 */

import { AuthSession } from '../auth/session';
import type { ProbeResult } from '../net/server-probe';

import { AccountDeleteDialog } from '../auth/account-delete-dialog';
import { LoginDialog } from '../auth/login-dialog';
import { SettingsDialog } from '../settings/settings-dialog';
import { AccountDialog } from '../sync/account-dialog';
import { CardsDialog } from '../sync/cards-dialog';
import { RepoDialog } from '../sync/repo-dialog';
import { SyncDialog } from '../sync/sync-dialog';

import { configGet, configPatch } from '../contract';
import { fetchAccountIdentity, listRepos, RepoClientError } from '../sync/repo-client';
import { applyScopeGating } from './block-actions';
import { refreshAccountButton, refreshTokenAfterSave } from './ui-refresh';
import { byId } from './dom-id';

/**
 * 功能
 * 本模块能碰的编辑器状态与动作。
 *
 * 注意事项
 * 25 个成员看着多，但 7 个是对话框实例（懒建后复用）、4 个是账号相关状态、
 * 其余是转发。它们服务的三个函数加起来 362 行，比值还行。
 *
 * `blockHost` / `refreshHost` 是**转手**：这两个 wire 里要调板块与刷新，
 * 它们各自已经有自己的 host，这里只把入口透传出去，不再包一层。
 *
 * 踩过的坑
 * 对话框既要用它的类型又要 `new` 它 —— 必须普通 import，
 * 写成 `import type` 会报 "cannot be used as a value"。
 */
export interface WireHost {
  /** 账号认证会话。登录/登出后会整体替换 */
  authSession: AuthSession | null;
  /** 认证服务器地址 */
  authServerUrl: string;
  /** 当前卡片（卡名编辑器要读它的 meta.name） */
  readonly card: import('@tcs/shared').UnifiedCard;
  /** 连接探测结果 */
  readonly connection: ProbeResult | null;

  /** 删号确认框 */
  accountDeleteDialog: AccountDeleteDialog | null;
  /** 登录框 */
  loginDialog: LoginDialog | null;
  /** 仓库登录框 */
  repoDialog: RepoDialog | null;
  /** 账户面板（只读身份 / 登录设备 / 改名改密码 / 退出；v0.2.3） */
  accountDialog: AccountDialog | null;
  /** 卡片列表框 */
  cardsDialog: CardsDialog | null;
  /** 设置面板 */
  settings: SettingsDialog | null;
  /** 同步面板 */
  syncDialog: SyncDialog | null;

  setStatus(message: string, kind: 'info' | 'ok' | 'warn' | 'bad'): void;
  /** 改卡名（写进会话） */
  applyCardName(name: string): void;
  /** 重画标题栏的卡名 */
  renderCardName(): void;
  /** 隐藏"名字太长"提示 */
  hideNameHint(): void;
  /** 把连接配置写进 ST */
  applyConnection(result: unknown): void;
  /** 自动探测服务器 */
  autoProbe(): Promise<void>;
  /** 当前同步配置 */
  currentSyncConfig(): import('../sync/server-sync').SyncConfig | null;
  /** 导出诊断信息，返回导出的文本 */
  exportDiagnostics(): Promise<string>;
  /** 401 之后统一处置。返回 true = 已恢复（重试即可） */
  handleUnauthorized(): Promise<boolean>;
  /** 问用户要不要信任证书 */
  offerCertTrust(serverUrl: string): Promise<void>;
  /** 打开账号入口（登录框 / 账号页） */
  openAccountEntry(): void;
  /** 仓库客户端的配置 */
  repoClientConfig(): import('../sync/repo-client').RepoClientConfig | null;
  /** 仓库令牌上下文 */
  repoTokenContext(): import('../sync/repo-select').RepoTokenContext | null;
  /** 板块模块的接入点（卡名改动要通知） */
  blockHost(): import('./block-actions').BlockHost;
  /** 刷新模块的接入点（登录态变了要重画账号按钮） */
  refreshHost(): import('./ui-refresh').RefreshHost;
}

export function wireAccount(host: WireHost): void {
  const session = new AuthSession({
    load: async () => {
      const config = await configGet();
      return {
        accessToken: config.accessToken,
        refreshToken: config.refreshToken,
        accessExpiresAt: config.accessExpiresAt,
        authUser: config.authUser,
        // 仓库令牌模式（v0.1.3 / F5 后半）：重启后要能恢复 ——
        // 否则"把令牌交给另一台设备"这件事在每次开机后都要重做一遍
        repoToken: config.repoToken,
        repoTokenRepoId: config.repoTokenRepoId,
        repoTokenRepoName: config.repoTokenRepoName,
        repoTokenScopes: config.repoTokenScopes,
        repoTokenExpiresAt: config.repoTokenExpiresAt,
      };
    },
    save: async (patch) => {
      // 只写这四个键：`configPatch` 是按 key 合并的，不会动规则/目录等设置
      await configPatch(patch);
    },
    serverUrl: () => (host.authServerUrl.trim() === '' ? null : host.authServerUrl.trim()),
    /*
     * 登录态变化的**所有**来源都从这里经过：登录框、bootstrap 恢复、
     * 静默续期成功、401 后恢复失败回匿名、登出。
     *
     * 第一版只刷新账户按钮 —— 于是"静默续期成功"这条路径上，账户按钮已经是
     * authenticated，而顶栏胶囊与同步提示还停在"未登录"（截图验收时发现）。
     * 连接本身没变，只是凭证变了，所以用现有 connection 重新 apply 一次即可。
     */
    onPhaseChange: () => {
      refreshAccountButton(host.refreshHost());
      if (host.connection) host.applyConnection(host.connection);
    },
  });
  host.authSession = session;

  host.loginDialog = new LoginDialog({
    session,
    getPolicy: () => session.fetchPolicy(),
    // 登录只需要地址，不需要任何令牌（免鉴权端点：login/register/refresh/config）
    getServerUrl: () => host.connection?.url ?? host.authServerUrl,
    notify: (message, kind) => host.setStatus(message, kind ?? 'info'),
    onAuthenticated: () => {
      // 换了令牌 → 必须重探一次，否则顶栏还停在旧状态，
      // 用户会以为登录没成功
      refreshAccountButton(host.refreshHost());
      void host.autoProbe();
      /*
       * 立刻按现有连接信息重算一次界面文案。
       *
       * `autoProbe()` 是一次网络往返，回来之前顶栏与同步提示还是**上一轮探测**的
       * 结论（探针实测：登录成功、会话已是 authenticated，提示却仍写
       * "未登录：登录后可同步"）。连接本身没变，只是凭证变了 ——
       * 用已有的 `connection` 重新 apply 一次就能立刻纠正，不必等探测。
       */
      if (host.connection) host.applyConnection(host.connection);
      // 静默续期由 AuthSession 自己接管（refresh 单飞，见 session.ts），
      // 这里补第 4 条要求的另一半：**登录成功即拉一次「我的卡片」**，
      // 用户点开面板时不用再等一轮。
      void host.cardsDialog?.preload();
    },
    /*
     * 仓库令牌连接成功（v0.1.3 / F5 后半）。
     *
     * 与 onAuthenticated 同一套动作：重画顶栏 → 重探 → 立刻按现有连接重算文案。
     * 多出来一步 `applyScopeGating()`：这个模式下按钮要按 scope 置灰，
     * 而 applyConnection 只负责把按钮**全部置为可用**（那是账户路径的语义）。
     */
    onRepoTokenConnected: () => {
      refreshAccountButton(host.refreshHost());
      applyScopeGating(host.blockHost());
      if (host.connection) host.applyConnection(host.connection);
      void host.autoProbe();
    },
  });

  /*
   * 退出账户，或者退出仓库令牌模式：清会话、刷顶栏、重跑探测。
   *
   * 退出令牌模式不吊销令牌，它可能还在别的设备上用。这段逻辑必须放在卡片面板
   * 和账户面板共用的位置；各写一遍，迟早出现一个入口退了、另一个没退。
   */
  const logoutSession = async (): Promise<void> => {
    const wasRepoToken = session.isRepoTokenMode;
    await session.logout();
    if (wasRepoToken) {
      host.setStatus('已退出仓库令牌模式：上传/同步不再可用（本地编辑不受影响）', 'info');
    } else {
      host.setStatus('已登出：后续同步将使用全局令牌（若有）', 'info');
    }
    refreshAccountButton(host.refreshHost());
    applyScopeGating(host.blockHost());
    void host.autoProbe();
  };

  host.cardsDialog = new CardsDialog({
    getConfig: () => host.currentSyncConfig(),
    /*
     * 必须是 `mode === 'account'`，不能只看 `accessToken !== ''`（v0.1.3 / F5 后半）。
     *
     * 仓库令牌模式下 `session.accessToken` 返回的是**令牌原文**（那是让既有同步链路
     * 零改动的关键），所以旧的判据会把令牌模式误判成"账户已登录"，
     * 于是卡片列表里会显示「登出」按钮、还会打出"账户隔离"的说明 ——
     * 而这两件事在令牌模式下都不成立。
     */
    isAccountLogin: () => session.mode === 'account',
    // T10.8：服务端说"已隔离"就不再提示未隔离（避免永远为真的免责声明）
    isIsolationEnforced: () => host.connection?.isolationEnforced ?? null,
    onPick: (cardId) => {
      // 复用同步面板：点卡片 = 看它的版本历史
      host.syncDialog?.open();
      host.syncDialog?.selectCard(cardId);
    },
    notify: (message, kind) => host.setStatus(message, kind ?? 'info'),
    // 「移动…」要选目标仓库：列表由仓库客户端现取（不缓存 —— 用户可能刚在
    // 仓库面板里新建过一个，缓存会让它在这里看不到）
    getRepos: async () => {
      /*
       * 仓库管理只认**账户** access 令牌（仓库令牌与 legacy 都调不了 /api/repos
       * 的管理动作，服务端会 403）。
       *
       * 这里必须显式挡掉令牌模式：`repoClientConfig()` 读的是
       * `authSession.accessToken`，而那个 getter 在令牌模式下返回的是令牌原文
       * （这样既有同步链路才能零改动地按令牌寻址）。不挡的话，
       * 「我的卡片」里点「移动…」会拿 tcr_ 去调 /api/repos，得到 403。
       */
      if (host.authSession?.isRepoTokenMode === true) return [];
      const config = host.repoClientConfig();
      if (!config) return [];
      return listRepos(config);
    },
    getRepoTokenContext: () => host.repoTokenContext(),
    onUnauthorized: () => host.handleUnauthorized(),
    onLogout: logoutSession,
  });

  byId<HTMLButtonElement>('btn-account').addEventListener('click', () => void host.openAccountEntry());

  /*
   * 仓库与令牌快捷入口（v0.2.3）。
   *
   * 已登录就直接开面板，未登录走原来的账户入口，少点一层「账户 → 卡片列表 → 仓库」。
   * 右上角账户按钮和设置页入口都还在，这里只是多一条路。
   * 仓库令牌模式没有账户身份，服务端不给管理仓库，先说明原因，别开一个空面板。
   */
  byId<HTMLButtonElement>('btn-repos').addEventListener('click', () => {
    const session = host.authSession;
    if (session?.isRepoTokenMode === true) {
      host.setStatus('仓库令牌模式下不能管理仓库与令牌：先在账户入口退出令牌模式，再登录账户。', 'warn');
      return;
    }
    if (session?.currentPhase === 'authenticated' && session.accessToken !== '') {
      void host.repoDialog?.open();
      return;
    }
    void host.openAccountEntry();
  });

  /*
   * 注销账户（v0.1.3 / F3）。
   *
   * 三个回调各自的分工：
   *   · `getStats` 走 `/api/account/summary` —— 服务端算，与真正删除同一口径；
   *     失败时返回 null，弹窗会**明说"读不到统计"**而不是显示 0。
   *   · `onConfirm` 交给 AuthSession（它负责调接口并在成功后清本地登录态）。
   *   · `onDeleted` 负责把界面恢复到"未登录"：顶栏、按钮置灰、探测重跑。
   *
   * 刻意**不关任何本地标签**：账户没了不等于本地未保存的编辑要丢。
   * 用户可能正想把自己写的卡另存出来 —— 这条边界与登出完全一致。
   */
  host.accountDeleteDialog = new AccountDeleteDialog({
    getUsername: () => session.user?.username ?? '',
    getStats: async () => {
      try {
        return await session.accountSummary();
      } catch {
        return null;
      }
    },
    onConfirm: (input) => session.deleteAccount(input.confirmUsername, input.password),
    onDeleted: (receipt) => {
      refreshAccountButton(host.refreshHost());
      applyScopeGating(host.blockHost());
      // 账户已不存在 → 卡片列表/同步面板里的东西都过期了，重探一次
      void host.autoProbe();
      host.setStatus(
        `账户「${receipt.username}」已注销：本地未保存的编辑不受影响，建议先另存需要保留的内容`,
        'warn',
      );
      // 「我的卡片」如果开着，里面的列表已经全部失效（账户没了）
      host.cardsDialog?.close();
      host.syncDialog?.close();
      host.repoDialog?.close();
    },
    notify: (message, kind) => host.setStatus(message, kind ?? 'info'),
  });

  /*
   * 仓库与令牌面板（T10.8）。
   *
   * 与登录框同一条规则：**只存在于账户身份**。仓库管理不接受 legacy 令牌
   * （没有账户可挂）、也不接受仓库令牌（能自签 = 一次泄露可无限续期）。
   * 所以 `getConfig` 在这里返回 null 而不是"退化成 legacy"。
   */
  host.repoDialog = new RepoDialog({
    getConfig: () => host.repoClientConfig(),
    notify: (message, kind) => host.setStatus(message, kind ?? 'info'),
    onUnauthorized: () => host.handleUnauthorized(),
    /*
     * 改名后要同步三处：顶栏按钮、设置页身份行、仓库面板里的名字。
     * 只刷顶栏的话，用户打开设置还看到旧名字，会以为改名没生效。
     */
    onAccountChanged: () => {
      refreshAccountButton(host.refreshHost());
      host.settings?.refreshIdentity();
    },
  });

  /*
   * 账户面板（v0.2.3 拆分）。
   *
   * 只回答「我是谁、在哪登录、怎么改自己」；仓库与令牌归另一个面板。
   * 右上角用户名进这里，第 4 个工具栏按钮进仓库面板，两个入口的语义各自唯一。
   */
  host.accountDialog = new AccountDialog({
    getConfig: () => host.repoClientConfig(),
    notify: (message, kind) => host.setStatus(message, kind ?? 'info'),
    onUnauthorized: () => host.handleUnauthorized(),
    onAccountChanged: () => {
      refreshAccountButton(host.refreshHost());
      host.settings?.refreshIdentity();
    },
    onOpenCards: async () => {
      await host.cardsDialog?.open();
    },
    getSyncConfig: () => host.currentSyncConfig(),
    onLogout: logoutSession,
    isRepoTokenMode: () => session.isRepoTokenMode,
  });

  /*
   * 强制下线的客户端感知（2026-11-27）。
   *
   * 每 20 秒，以及窗口重新获得焦点时，用 access token 问一次 `/api/auth/me`。
   * 401 说明管理员踢了这个会话，外壳切回登录态。只在账户模式且已登录时轮询；
   * 令牌模式没有账户身份，跳过。
   *
   * 踩过的坑：只在打开面板时检查，用户叉掉登录框还能继续看着一份失效的账户界面。
   * 所以失败后要主动关掉账户、仓库、卡片三个面板。
   */
  const checkAccountKicked = async (): Promise<void> => {
    if (document.visibilityState === 'hidden') return;
    if (session.mode !== 'account' || session.currentPhase !== 'authenticated') return;
    const config = host.repoClientConfig();
    if (!config) return;
    try {
      await fetchAccountIdentity(config);
    } catch (error) {
      if (!(error instanceof RepoClientError) || error.code !== 'UNAUTHORIZED') return;
      const recovered = await host.handleUnauthorized();
      if (recovered) return;
      host.accountDialog?.close();
      host.repoDialog?.close();
      host.cardsDialog?.close();
    }
  };
  window.setInterval(() => void checkAccountKicked(), 20_000);
  window.addEventListener('focus', () => void checkAccountKicked());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkAccountKicked();
  });

  // 启动时读回令牌并**静默**续期。
  // 不 await：续期要发网络请求，不能挡住首屏渲染；也不在失败时弹窗
  // （启动瞬间弹登录框，用户第一反应是"是不是被盗号了"）。
  void session.bootstrap().then((ok) => {
    refreshAccountButton(host.refreshHost());
    if (ok) void host.autoProbe();
  });
}

export function wireSettings(host: WireHost): void {
  host.settings = new SettingsDialog({
    /*
     * 设置面板测出"证书不受信任"时，由**外壳**统一问（2026-11-17）。
     *
     * 面板自己不弹框：它的 `test()` 会被「连接本机服务端」与端到端脚本
     * 反复调用，两处各弹一个就会叠在一起问同一件事。确认入口只能有一个。
     */
    onConnectionChange: (result) => {
      host.applyConnection(result);
      if (result?.certUntrusted === true) {
        /*
         * `result.url` 在失败时是**归一化后的那个**（见 `failure()` 里
         * 传了 `url: base`），所以能直接用来取 origin。
         * 理论上不会为空；真为空就退回当前配置的地址。
         */
        void host.offerCertTrust(result.url ?? host.authServerUrl);
      }
    },
    // T10.26：诊断导出由 app 实现（它知道版本、连接状态、会话摘要与日志路径）
    onExportDiagnostics: () => host.exportDiagnostics(),
    onSaved: () => {
      void refreshTokenAfterSave(host.refreshHost());
      host.setStatus('设置已保存', 'ok');
    },
    // 身份行：登录态从 AuthSession 现读（闭包，构造时 session 可能还不存在）
    getIdentity: () => ({
      phase: host.authSession?.currentPhase ?? 'anonymous',
      user: host.authSession?.user ?? null,
    }),
    // 令牌模式要单独告诉设置页：那个模式下没有账户身份（user 恒 null），
    // 走 getIdentity 那条路会显示成「已登录」或「未登录」，两种都是错的
    getRepoTokenMode: () =>
      host.authSession?.isRepoTokenMode === true
        ? { repoName: host.authSession.repoTokenRepoName }
        : null,
    onLogin: () => void host.openAccountEntry(),
    onLogout: async () => {
      await host.authSession?.logout();
      refreshAccountButton(host.refreshHost());
      void host.autoProbe();
      host.setStatus('已登出；本地编辑不受影响', 'info');
    },
    // 注销账户（v0.1.3 / F3）：只负责把二次确认弹窗打开
    onDeleteAccount: () => void host.accountDeleteDialog?.open(),
  });

  byId<HTMLButtonElement>('btn-settings').addEventListener('click', () => {
    void host.settings?.open();
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
      await host.settings?.open({ serverUrl, token });
      if (wantLocalConnect) {
        await host.settings?.clickConnectLocal();
        return;
      }
      if (params.get('probe') === '1') {
        await host.settings?.runProbe();
      }
    })();
  }

  /*
   * ST 地址四种显示状态的取证入口（v0.1.6 / T14.0）：`?settings=1&stAddrDemo=ok|refused|timeout|other|format|skip`
   *
   * 注入的是**传输结果**，不是"检测通过"这个结论 —— 每一句话仍由
   * `describeTcpFailure` / `parseStAddress` 生成。三态判定与真实 TCP 的对应
   * 由 `.verify/t140-three-states.mjs` 跑真 socket 证明，不靠截图。
   *
   * 位置仍在 `start()` 尾部（第六次踩这个坑的同一个判据）：依赖 `settings` 已构造，
   * 写早了 `?.` 会静默跳过，截出来是普通编辑器页面。
   */
  const stAddrDemo = params.get('stAddrDemo');
  if (
    stAddrDemo === 'ok' ||
    stAddrDemo === 'refused' ||
    stAddrDemo === 'timeout' ||
    stAddrDemo === 'other' ||
    stAddrDemo === 'format' ||
    stAddrDemo === 'skip'
  ) {
    void (async () => {
      await host.settings?.open();
      host.settings?.previewStAddressState(stAddrDemo);
    })();
  }

  // T6.7：三个同步入口都打开同一个面板（面板内按职责分区：上传 / 历史 / 回滚）
  for (const id of ['btn-upload', 'btn-history', 'btn-rollback']) {
    byId<HTMLButtonElement>(id).addEventListener('click', () => {
      // 入口永远可点（v0.1.2 追加任务）。面板按 地址 / 凭证 三态说明现状：
      // 「还没配置地址」或「登录后可同步」都比门口一句"同步未就绪"有用 ——
      // 后者既说不出缺什么，也让"还没登录"看起来像功能坏了。
      host.syncDialog?.open();
    });
  }

  host.applyConnection(null);
  void host.autoProbe();
}

export function wireNameEditor(host: WireHost): void {
  const display = byId<HTMLButtonElement>('card-name');
  const input = byId<HTMLInputElement>('card-name-input');
  /** 进入编辑时记住原值，Esc 要能退回去 */
  let original = '';

  const begin = (): void => {
    // 进编辑就算"用户已经知道这里能改"——不必等他真的改成功
    host.hideNameHint();
    original = host.card.meta.name;
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
      host.renderCardName();
      return;
    }
    host.applyCardName(next);
  };

  const cancel = (): void => {
    if (input.hidden) return;
    input.hidden = true;
    display.hidden = false;
    host.renderCardName();
  };

  display.addEventListener('click', begin);

  // T10.29：点提示文字等同于点角色名 —— 提示是"可点的路标"，点它没反应比没有提示更差。
  // 两条路径都要把"用户已经知道这里能改"记下来（进入编辑就算知道了，不必等改成功）。
  const hint = byId<HTMLElement>('card-name-hint');
  hint.addEventListener('click', () => {
    host.hideNameHint();
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