/**
 * 登录态（T10.7）—— 令牌持久化 + 静默续期 + 401 恢复。
 *
 * 三条硬规则：
 *
 *  1. **续期必须单飞（single-flight）**。refresh 令牌每次使用都会轮换，
 *     两个并发 refresh 必然有一个用的是已作废的值 —— 服务端会判定为重放，
 *     整个会话直接吊销。所以所有续期入口都汇到同一个 `inflight` Promise，
 *     后到的调用者只等结果，不另发请求。
 *
 *  2. **401 之后先试一次续期，再决定要不要回登录界面**。access 过期是很常见的
 *     正常状态（2 小时），直接弹登录框等于每两小时打断用户一次。
 *
 *  3. **登录态过期不动本地卡片会话**。编辑到一半的卡、未保存的标签页，
 *     属于「本地工作」，与「云端身份」是两件事。这里刻意**没有任何**
 *     关闭标签 / 清空编辑器 / 丢弃未保存内容的能力 —— 结构上就做不到，
 *     而不是靠调用方记得不要调。
 */

import type { AuthPolicy, AuthUser, AccountSummary, DeleteAccountReceipt, RegisterOutcome, TokenBundle } from './auth-client.ts';
import * as defaultApi from './auth-client.ts';
import { capabilitiesFor, type RepoTokenCapabilities } from './repo-token.ts';
import type { RepoTokenGrant } from './repo-token-client.ts';

export type AuthPhase = 'anonymous' | 'authenticated' | 'expired';

/**
 * 当前生效的凭证路径（v0.1.3 / F5 后半）。
 *
 *   · `none`        —— 没有可用凭证
 *   · `account`     —— 账户登录（身份：我是谁）
 *   · `repo-token`  —— 仓库令牌（受限授权：我能对这个仓库做什么）
 *
 * 两条路径**互斥**，理由见 `enterRepoTokenMode` 的注释。
 */
export type CredentialMode = 'none' | 'account' | 'repo-token';

/** 落进应用配置（契约 C5）的那部分 */
export interface PersistedAuth {
  accessToken: string;
  refreshToken: string;
  /** access 到期时刻（epoch ms）；0 = 未知 */
  accessExpiresAt: number;
  authUser: AuthUser | null;
  /** 仓库令牌原文；空串 = 不在该模式 */
  repoToken: string;
  repoTokenRepoId: string;
  repoTokenRepoName: string;
  repoTokenScopes: string[];
  repoTokenExpiresAt: string | null;
}

export const EMPTY_AUTH: PersistedAuth = {
  accessToken: '',
  refreshToken: '',
  accessExpiresAt: 0,
  authUser: null,
  repoToken: '',
  repoTokenRepoId: '',
  repoTokenRepoName: '',
  repoTokenScopes: [],
  repoTokenExpiresAt: null,
};

export interface AuthApi {
  login: typeof defaultApi.login;
  register: typeof defaultApi.register;
  refresh: typeof defaultApi.refresh;
  logout: typeof defaultApi.logout;
  fetchPolicy: typeof defaultApi.fetchPolicy;
  /** 自助注销（v0.1.3 / F3）。测试里注入假实现即可覆盖失败分支 */
  deleteAccount: typeof defaultApi.deleteAccount;
  /** 注销前的数据统计（v0.1.3 / F3） */
  fetchAccountSummary: typeof defaultApi.fetchAccountSummary;
}

export interface AuthSessionDeps {
  /** 从配置读回（浏览器模式下可以返回 EMPTY_AUTH） */
  load: () => Promise<PersistedAuth>;
  /** 写回配置；只写这几个键 */
  save: (patch: Partial<PersistedAuth>) => Promise<void>;
  /** 当前服务端地址；未配置时 null */
  serverUrl: () => string | null;
  now?: () => number;
  /** 提前多久续期（默认 5 分钟：比一次慢请求长，但远小于 2 小时） */
  refreshSkewMs?: number;
  /** 登录态变化（界面据此更新顶栏与入口） */
  onPhaseChange?: (phase: AuthPhase, user: AuthUser | null) => void;
  /** 只给测试注入；生产用默认实现 */
  api?: AuthApi;
}

const DEFAULT_SKEW_MS = 5 * 60 * 1000;

export class AuthSession {
  private state: PersistedAuth = { ...EMPTY_AUTH };
  private phase: AuthPhase = 'anonymous';
  private inflight: Promise<boolean> | null = null;
  /**
   * 显式字段而不是构造函数参数属性（`constructor(private readonly deps)`）：
   * Node 的类型剥离不支持参数属性，写了会让测试无法导入本文件。
   */
  private readonly deps: AuthSessionDeps;
  private readonly now: () => number;
  private readonly skew: number;
  private readonly api: AuthApi;

  constructor(deps: AuthSessionDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    // 负值会被当成"永远该续期"，每次请求都刷一次 —— refresh 轮换 + 高频刷新
    // 等于给自己造重放。夹到 [0, 1h]。
    const raw = deps.refreshSkewMs ?? DEFAULT_SKEW_MS;
    this.skew = Math.min(Math.max(raw, 0), 60 * 60 * 1000);
    this.api = deps.api ?? defaultApi;
  }

  get currentPhase(): AuthPhase {
    return this.phase;
  }

  get user(): AuthUser | null {
    return this.state.authUser;
  }

  // ── 凭证路径（v0.1.3 / F5 后半）────────────────────────────

  /**
   * 当前生效的凭证路径。
   *
   * 仓库令牌优先：它是用户刚刚主动粘贴进来的显式选择，不该被一个更早的、
   * 还没过期的账户会话悄悄顶掉。（正常流程下两者不会并存 —— 见 enterRepoTokenMode。）
   */
  get mode(): CredentialMode {
    if (this.state.repoToken !== '') return 'repo-token';
    if (this.state.accessToken !== '' || this.state.refreshToken !== '') return 'account';
    return 'none';
  }

  get isRepoTokenMode(): boolean {
    return this.state.repoToken !== '';
  }

  /** 令牌绑定的仓库名（非该模式时为空串） */
  get repoTokenRepoName(): string {
    return this.state.repoTokenRepoName;
  }

  get repoTokenRepoId(): string {
    return this.state.repoTokenRepoId;
  }

  get repoTokenScopes(): readonly string[] {
    return this.state.repoTokenScopes;
  }

  get repoTokenExpiresAt(): string | null {
    return this.state.repoTokenExpiresAt;
  }

  /**
   * 当前凭证能做什么。
   *
   * 账户模式下按"全权"表达（账户能管自己的全部仓库与卡片）；
   * 仓库令牌模式按 scope 算 —— 这就是两条路径的能力边界在代码里的落点。
   */
  get capabilities(): RepoTokenCapabilities {
    if (this.mode === 'repo-token') return capabilitiesFor(this.state.repoTokenScopes);
    // 账户 / legacy：不是"没有权限"，而是"权限不由 scope 表达"
    return capabilitiesFor(['read', 'write', 'rollback']);
  }

  /**
   * 进入仓库令牌模式。
   *
   * **必须同时清掉账户令牌**，这不是顺手之劳而是这个模式成立的前提：
   * 仓库令牌的用途是"把令牌交给其他设备/工具/他人使用此仓库，不暴露账户密码"。
   * 若进入这个模式后设备上仍留着完整的账户 access/refresh，那个"受限"就是字面上的
   * 谎言 —— 任何能读配置的人都能直接拿账户令牌去管全部仓库。
   *
   * 清掉之后 `mode` 变成 repo-token，`accessToken` getter 返回令牌原文，
   * 于是**既有的同步链路一行都不用改**就能按这把令牌寻址。
   */
  async enterRepoTokenMode(grant: RepoTokenGrant, rawToken: string): Promise<void> {
    await this.persist({
      // 先清账户身份：两条路径互斥
      accessToken: '',
      refreshToken: '',
      accessExpiresAt: 0,
      authUser: null,
      repoToken: rawToken,
      repoTokenRepoId: grant.repoId,
      repoTokenRepoName: grant.repoName,
      repoTokenScopes: [...grant.scopes],
      repoTokenExpiresAt: grant.expiresAt,
    });
    this.setPhase('authenticated');
  }

  /**
   * 退出仓库令牌模式（= 需求里的"退出登录"）。
   *
   * 只清令牌，不发请求：这把令牌属于**别人的账户**，本机退出这个模式
   * 不该把它吊销掉 —— 那会让另一台正在用同一把令牌的设备突然断开。
   * 要吊销请去签发它的客户端（账户登录后）。
   */
  async exitRepoTokenMode(): Promise<void> {
    await this.persist({
      repoToken: '',
      repoTokenRepoId: '',
      repoTokenRepoName: '',
      repoTokenScopes: [],
      repoTokenExpiresAt: null,
    });
    this.setPhase('anonymous');
  }

  /**
   * 自助注销账户（v0.1.3 / F3）。
   *
   * 与「登出」的区别：登出只是丢掉本机令牌，账户与服务端数据都还在；
   * 注销是**物理删除**，账户连同全部仓库、卡片、版本、令牌、会话一起消失。
   *
   * 成功后就地清空本地登录态：账户已经不存在，留着一个指向空气的令牌
   * 会让后续每个请求都 401，而用户会以为"注销失败了"。
   *
   * **不触碰本地卡片会话**：标签页与未保存内容属于本地工作，
   * 与"云端账户被删"是两件事。用户可能还有没保存的卡要另存（哪怕账户没了）。
   */
  /** 取"将要删除什么"（注销确认弹窗用）。失败时抛，由调用方决定显示什么。 */
  async accountSummary(): Promise<AccountSummary> {
    const serverUrl = this.requireServerUrl();
    if (this.state.accessToken === '') throw new Error('需要账户登录');
    return this.api.fetchAccountSummary(serverUrl, this.state.accessToken);
  }

  async deleteAccount(
    confirmUsername: string,
    password?: string,
  ): Promise<DeleteAccountReceipt> {
    const serverUrl = this.requireServerUrl();
    if (this.state.accessToken === '') {
      throw new Error('需要账户登录才能注销账户');
    }
    const receipt = await this.api.deleteAccount(serverUrl, this.state.accessToken, {
      confirmUsername,
      ...(password === undefined ? {} : { password }),
    });
    await this.persist({
      accessToken: '',
      refreshToken: '',
      accessExpiresAt: 0,
      authUser: null,
      repoToken: '',
      repoTokenRepoId: '',
      repoTokenRepoName: '',
      repoTokenScopes: [],
      repoTokenExpiresAt: null,
    });
    this.setPhase('anonymous');
    return receipt;
  }

  /**
   * 可直接放进 Authorization 的令牌；没有则空串。
   *
   * 仓库令牌模式下返回**令牌原文** —— 这是"既有同步链路零改动就能用令牌寻址"
   * 的关键：所有调用方本来就在读这个 getter，服务端认 `tcr_` 前缀并按令牌绑定的
   * 仓库寻址，于是上传/历史/回滚自动落到那一个仓库上。
   */
  get accessToken(): string {
    if (this.state.repoToken !== '') return this.state.repoToken;
    return this.state.accessToken;
  }

  get refreshToken(): string {
    return this.state.refreshToken;
  }

  get accessExpiresAt(): number {
    return this.state.accessExpiresAt;
  }

  /** 有多少令牌（含 refresh 或仓库令牌）—— 界面用它决定显示"登录"还是"登出" */
  get hasCredentials(): boolean {
    return this.state.repoToken !== '' || this.state.accessToken !== '' || this.state.refreshToken !== '';
  }

  /** 是否已到该续期的时候（不实际发请求，纯判断，便于测） */
  needsRefresh(at: number = this.now()): boolean {
    // 仓库令牌没有续期概念（服务端只认它自己的到期时间）——
    // 这里必须早退，否则会拿一把 tcr_ 去调 /api/auth/refresh，必然 401，
    // 然后被 refreshNow 的失败分支判成"登录过期"，把人赶回登录框。
    if (this.state.repoToken !== '') return false;
    if (this.state.refreshToken === '') return false;
    if (this.state.accessExpiresAt === 0) return false; // 未知，交给 401 路径兜底
    return this.state.accessExpiresAt - at <= this.skew;
  }

  /**
   * 启动时调用：读回令牌，并在"快过期/已过期"时静默续一次。
   *
   * 续期失败**不弹登录框** —— 启动瞬间弹一个登录窗，用户第一反应是"我是不是被盗号了"。
   * 这里只把状态置为 expired，顶栏显示「登录已过期」；等真正需要访问服务端时
   * 再走 `recoverAfterUnauthorized`，那一步失败才回登录界面。
   *
   * 返回是否可用（有有效令牌）。
   */
  async bootstrap(): Promise<boolean> {
    try {
      this.state = { ...EMPTY_AUTH, ...(await this.deps.load()) };
    } catch {
      // 浏览器模式读不到配置：当作未登录，不影响本地编辑
      this.state = { ...EMPTY_AUTH };
    }

    if (this.state.refreshToken === '' && this.state.accessToken === '' && this.state.repoToken === '') {
      this.setPhase('anonymous');
      return false;
    }

    // 仓库令牌模式：没有续期、也没有会话可确认，有令牌就算可用。
    // 令牌是否还有效由第一次真实请求说了算（401 → 回登录界面）。
    if (this.state.repoToken !== '') {
      this.setPhase('authenticated');
      return true;
    }

    if (!this.needsRefresh()) {
      this.setPhase('authenticated');
      return true;
    }

    const ok = await this.refreshNow();
    return ok;
  }

  /**
   * 单飞续期。
   *
   * 返回 true = 现在有可用的 access。
   */
  async refreshNow(): Promise<boolean> {
    if (this.state.refreshToken === '') return false;
    if (this.inflight) return this.inflight;

    const serverUrl = this.deps.serverUrl();
    if (serverUrl === null) return false;

    this.inflight = (async (): Promise<boolean> => {
      try {
        const bundle = await this.api.refresh(serverUrl, this.state.refreshToken);
        await this.applyBundle(bundle);
        this.setPhase('authenticated');
        return true;
      } catch {
        // refresh 被拒 = 会话已被吊销或过期。此时**保留用户名**（显示"谁过期了"），
        // 但清掉令牌：继续拿着一个已作废的 access 只会让后续请求逐个 401。
        await this.persist({ accessToken: '', refreshToken: '', accessExpiresAt: 0 });
        this.setPhase('expired');
        return false;
      } finally {
        this.inflight = null;
      }
    })();

    return this.inflight;
  }

  /** 在需要访问服务端前调用：快过期就先续，避免"刚好过期"的请求白跑一趟 */
  async ensureFresh(): Promise<boolean> {
    // 仓库令牌不需要续期，直接判"有没有"
    if (this.state.repoToken !== '') return true;
    if (this.state.refreshToken === '' && this.state.accessToken === '') return false;
    if (!this.needsRefresh()) return this.state.accessToken !== '';
    return this.refreshNow();
  }

  async login(username: string, password: string): Promise<TokenBundle> {
    const serverUrl = this.requireServerUrl();
    const bundle = await this.api.login(serverUrl, { username, password });
    await this.applyBundle(bundle);
    this.setPhase('authenticated');
    return bundle;
  }

  async register(username: string, password: string): Promise<RegisterOutcome> {
    const serverUrl = this.requireServerUrl();
    const outcome = await this.api.register(serverUrl, { username, password });
    // admin-only 建号不返回令牌：不能替被创建的人"登录"
    if (outcome.tokens) {
      await this.applyBundle(outcome.tokens);
      this.setPhase('authenticated');
    }
    return outcome;
  }

  /**
   * 登出。
   *
   * 服务端调用失败也照样清本地状态：把用户困在"登出失败"里既没有安全收益
   * （令牌本来就要丢），也让人以为按钮坏了。
   *
   * 仓库令牌模式下走的是 {@link exitRepoTokenMode} —— **两种"退出"不是一件事**：
   * 账户登出要吊销服务端会话，令牌退出只是本机不再使用这把令牌。
   * 在这里分开处理，而不是让 logout 去判断，是为了让"点了退出会发生什么"
   * 在调用处就能读出来。
   */
  async logout(): Promise<void> {
    if (this.state.repoToken !== '') {
      await this.exitRepoTokenMode();
      return;
    }
    const serverUrl = this.deps.serverUrl();
    const token = this.state.accessToken;
    if (serverUrl !== null && token !== '') {
      try {
        await this.api.logout(serverUrl, token);
      } catch {
        /* 忽略：本地清空是主目的 */
      }
    }
    await this.persist({ accessToken: '', refreshToken: '', accessExpiresAt: 0, authUser: null });
    this.setPhase('anonymous');
  }

  /**
   * 收到 401 后调用：先续期，续不上才算真过期。
   *
   * 返回 true = 已续期成功，调用方可以重试原请求。
   */
  async recoverAfterUnauthorized(): Promise<boolean> {
    if (this.state.refreshToken === '') {
      // 没有 refresh 可用（例如用的是 legacy 全局令牌）：交给上层判断。
      // 这里不改 phase —— legacy 令牌失效不是"登录过期"。
      return false;
    }
    // 401 不代表 access 一定"过期"（也可能被服务端吊销），所以**无条件续一次**，
    // 而不是先看 expire 时间 —— 后者会对"被吊销但未到期"的令牌白白判死。
    return this.refreshNow();
  }

  async fetchPolicy(): Promise<AuthPolicy | null> {
    const serverUrl = this.deps.serverUrl();
    if (serverUrl === null) return null;
    try {
      return await this.api.fetchPolicy(serverUrl);
    } catch {
      // 取不到策略时返回 null：界面据此**隐藏注册入口**（fail-closed），
      // 而不是乐观显示 —— 点了才发现不能用更糟。
      return null;
    }
  }

  /**
   * 带自动恢复的请求。
   *
   * `retryOn` 由调用方给（同步层用 `error.code === 'UNAUTHORIZED'`），
   * 因为这一层不认识 SyncError，也不想认识。
   */
  async authorized<T>(
    run: (token: string) => Promise<T>,
    retryOn: (error: unknown) => boolean,
  ): Promise<T> {
    await this.ensureFresh();
    try {
      return await run(this.state.accessToken);
    } catch (error) {
      if (!retryOn(error)) throw error;
      const recovered = await this.recoverAfterUnauthorized();
      if (!recovered) throw error;
      return run(this.state.accessToken);
    }
  }

  private requireServerUrl(): string {
    const serverUrl = this.deps.serverUrl();
    if (serverUrl === null) {
      throw new Error('尚未配置服务端地址：请先在「设置」里填写服务端 URL');
    }
    return serverUrl;
  }

  private async applyBundle(bundle: TokenBundle): Promise<void> {
    await this.persist({
      accessToken: bundle.accessToken,
      refreshToken: bundle.refreshToken,
      accessExpiresAt: bundle.accessExpiresAt,
      authUser: bundle.user,
      // 账户登录成功 = 明确切回账户路径，把仓库令牌清掉。
      // 两条路径互斥（理由见 enterRepoTokenMode）：若不清，accessToken getter
      // 会继续优先返回 repository 令牌，于是"刚登录成功"却仍在按旧令牌寻址 ——
      // 表现为"登录了但看不到我的卡"。
      repoToken: '',
      repoTokenRepoId: '',
      repoTokenRepoName: '',
      repoTokenScopes: [],
      repoTokenExpiresAt: null,
    });
  }

  private async persist(patch: Partial<PersistedAuth>): Promise<void> {
    this.state = { ...this.state, ...patch };
    try {
      await this.deps.save(patch);
    } catch {
      // 浏览器模式（无 C5 能力）写入会失败：内存态继续可用，
      // 但重启即丢失。这里不抛，否则一次配置写失败会让登录流程整个中断。
    }
  }

  private setPhase(phase: AuthPhase): void {
    this.phase = phase;
    this.deps.onPhaseChange?.(phase, this.state.authUser);
  }
}
