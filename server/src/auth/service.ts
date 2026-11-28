/**
 * 账户认证服务（T10.4）：注册 / 登录 / 刷新 / 登出 / 当前用户。
 *
 * 这一层只管业务，不碰 HTTP —— 所有"返回什么状态码"的决定在 http/auth-routes.ts，
 * 而"什么时候必须花掉多少时间"的决定在这里，因为时序是安全语义的一部分。
 *
 * 四条不可退让的约束（需求 F1.2 / 本轮重申）：
 *
 *   1. **不泄露账户存在性**：登录时"用户不存在"与"密码错"返回同一句话、
 *      并且都真实跑一次 Argon2id（不存在的走假校验），耗时同量级。
 *   2. **锁定状态不泄露**：锁定期无论密码对错，响应与"密码错"完全一致
 *      —— 否则攻击者拿"被锁定"这个信号反过来确认账户存在。
 *   3. **注册失败不泄露存在性**：用户名已占用、格式不合规、密码不合规
 *      **共用一句可执行的话**（"请确认符合规则且未被占用"），状态码相同，
 *      耗时也拉平（都真的算一次哈希）。
 *   4. **参数升级自动生效**：登录成功时若 `needsRehash`，用当前基线重算并落库，
 *      老用户无需改密码。
 */

import type { ServerConfigFile } from '../config.js';
import { isRegisterMode } from '../config-live.js';
import { AppError, type ErrorCode } from '../errors.js';
import { LoginLimiter, DEFAULT_RATE_LIMIT, type LockState } from './login-limit.js';
import {
  assertPasswordPolicy,
  hashPassword,
  needsRehash,
  verifyPassword,
  verifyPasswordDummy,
  CREDENTIALS_REJECTED,
} from './password.js';
import { SessionStore } from './sessions.js';
import type { PasswordTicketStore } from './password-ticket.js';
import { signJwt } from './jwt.js';
import { UserStore, assertUsernameShape, normalizeUsername, type UserRow } from '../storage/users.js';
import type { RepoStore } from '../storage/repos.js';
import { inviteState, type InviteStore } from '../storage/invites.js';

/** access token 有效期：2 小时（需求 F1.2 硬约束） */
export const ACCESS_TOKEN_TTL_SECONDS = 2 * 60 * 60;
/** refresh token 有效期：30 天。比 access 长很多，但每次刷新都会轮换 */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * 注册失败的统一文案。
 *
 * 它必须同时满足两件事：**能指导用户下一步动作**，且**不确认用户名是否存在**。
 * 所以它把"规则"和"未被占用"并列陈述 —— 用户看到这句会去检查自己的输入，
 * 而攻击者读不出"这个名字已在库里"。
 */
export const REGISTRATION_REJECTED =
  '无法完成注册：请确认用户名符合规则（3–32 个字符，字母或数字开头，可用字母、数字、下划线、连字符、点）且未被占用';

/**
 * 临时密码被拒时**唯一**的一句话（2026-11-25）。
 *
 * 「uid 不存在」「码错了」「码过期」「码用过」「账户已注销」全用这一句 ——
 * 否则这个免鉴权端点就是**枚举 uid 的探针**：攻击者能靠不同的错误消息
 * 分辨"这个 uid 存在吗"。
 */
const TICKET_REJECTED = 'UID 或临时密码不正确，或临时密码已过期 / 已使用';

/**
 * 密码策略校验，把 `PasswordPolicyError` 翻成 `AuthError`。
 *
 * 为什么要转：那个错误是普通 Error，不转会被统一错误处理当成程序故障回 500，
 * 而"密码太短"完全是用户能自己改对的事 —— 该是 400 + 一句人话。
 */
function assertPasswordPolicyOrThrow(plain: string): void {
  try {
    assertPasswordPolicy(plain);
  } catch (error) {
    throw new AuthError('BAD_REQUEST', (error as Error).message, 400);
  }
}

export class AuthError extends Error {
  constructor(
    // 用统一的 ErrorCode 类型而不是 string：认证层的每个失败码都会成为
    // HTTP 响应里的 `code` 字段，让编译器帮忙保证它们都在已知集合里
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  /** access token 过期时间（ISO），客户端据此决定何时刷新 */
  accessExpiresAt: string;
  refreshExpiresAt: string;
  sessionId: string;
}

export interface AuthServiceOptions {
  config: ServerConfigFile;
  users: UserStore;
  sessions: SessionStore;
  limiter: LoginLimiter;
  /**
   * 仓库（T10.6）。给了就在注册成功后自动建默认仓库。
   *
   * 为什么在注册时建而不是"上传时才懒建"：用户登录后第一件事往往是看仓库列表，
   * 一个空列表会让人以为"这个功能没做好"。懒建还会让"默认仓库"的存在取决于
   * 是否上传过卡片，语义上很奇怪 —— 默认仓库应当与账户同时诞生。
   */
  repos?: RepoStore;
  /**
   * 邀请码仓库（v0.1.7）。
   *
   * 只在 `registerMode === 'invite'` 时用得到。为 null 时该模式直接报
   * `SERVICE_UNAVAILABLE` —— 而**不是**退化成"不需要邀请码"。
   * 那种"配置了却没接上依赖就放行"的降级是最坏的：它把门开着而不说。
   */
  invites?: InviteStore;
  /**
   * 注册策略的**实时**取值（F12）。
   *
   * 面板与 worker 是两个进程，`config` 只是启动时的快照；不给这个回调时
   * 就退回快照（单进程测试、或不需要热更的场景）。给了就每次现读配置文件，
   * 于是"面板上点开放"立刻生效，不需要重启。
   */
  liveRegisterMode?: () => ServerConfigFile['auth']['registerMode'];
  /**
   * 一次性临时密码（2026-11-25）。
   *
   * 给了就注册「UID + 临时密码 → 改密码」那条路径。不给时该端点报
   * `SERVICE_UNAVAILABLE` —— 而不是退化成"跳过校验"。
   */
  tickets?: PasswordTicketStore;
  /** 注入时钟，便于测试过期/锁定 */
  now?: () => Date;
}

export class AuthService {
  private readonly users: UserStore;
  private readonly sessions: SessionStore;
  private readonly limiter: LoginLimiter;
  private readonly config: ServerConfigFile;
  private readonly now: () => Date;
  private readonly repos: RepoStore | null;
  private readonly invites: InviteStore | null;
  private readonly tickets: PasswordTicketStore | null;
  private readonly liveRegisterMode: (() => ServerConfigFile['auth']['registerMode']) | null;

  constructor(options: AuthServiceOptions) {
    this.users = options.users;
    this.sessions = options.sessions;
    this.limiter = options.limiter;
    this.config = options.config;
    this.now = options.now ?? (() => new Date());
    this.repos = options.repos ?? null;
    this.invites = options.invites ?? null;
    this.tickets = options.tickets ?? null;
    this.liveRegisterMode = options.liveRegisterMode ?? null;
  }

  /**
   * 注册策略（只读）。`GET /api/auth/config` 用它告诉客户端该不该显示注册入口。
   *
   * 做成 getter 而不是让路由直接读 config：路由不该知道配置结构，
   * 而且以后若把策略改成"数据库可配"，这里只有一处需要改。
   */
  get registerMode(): ServerConfigFile['auth']['registerMode'] {
    if (this.liveRegisterMode === null) return this.config.auth.registerMode;
    try {
      const mode = this.liveRegisterMode();
      // 回调理论上只返回合法值；万一实现有 bug，宁可沿用快照也不要放行成 open
      return isRegisterMode(mode) ? mode : this.config.auth.registerMode;
    } catch {
      return this.config.auth.registerMode;
    }
  }

  /** 是否强制鉴权。false 时客户端连登录框都不该弹（仅回环开发的宽松模式） */
  get requiresAuth(): boolean {
    return this.config.auth.require;
  }

  private get jwtSecret(): string {
    const secret = this.config.auth.jwtSecret;
    if (!secret || secret.length < 32) {
      // 不该发生（配置加载时保证），但宁可拒绝签发也不要用弱密钥
      throw new AuthError('SERVICE_UNAVAILABLE', '服务端缺少 jwtSecret，无法签发令牌', 500);
    }
    return secret;
  }

  private issue(user: UserRow, meta: { ip: string; userAgent: string }): IssuedTokens {
    const now = this.now();
    const { session, refreshToken } = this.sessions.create({
      userId: user.id,
      refreshTokenTtlSeconds: REFRESH_TOKEN_TTL_SECONDS,
      userAgent: meta.userAgent,
      ip: meta.ip,
      now,
    });

    const accessToken = signJwt(
      { sub: user.id, sid: session.id, role: user.role },
      this.jwtSecret,
      ACCESS_TOKEN_TTL_SECONDS,
      Math.floor(now.getTime() / 1000),
    );

    return {
      accessToken,
      refreshToken,
      accessExpiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
      refreshExpiresAt: session.expires_at,
      sessionId: session.id,
    };
  }

  // ── 登录 ──────────────────────────────────────────────────

  async login(input: {
    username: string;
    password: string;
    ip: string;
    userAgent: string;
    /**
     * 功能：同一设备（IP + UA）重新登录时，先把旧会话标记 `replaced`，
     *   再签发新会话。
     *
     * 注意事项：只有管理面板传这个参数。桌面端与移动端不传：它们正常持有
     *   refresh token，重复登录是用户的显式动作，多会话符合「登录设备」的原意。
     *
     * 踩过的坑：面板未勾「记住」时每次刷新都会重新登录，不顶掉旧会话的话，
     *   登录设备每刷新一次多一行（2026-11-27 用户报的 P2）。
     */
    reuseDevice?: boolean;
  }): Promise<{ user: UserRow; tokens: IssuedTokens }> {
    const keys = { ip: input.ip, account: normalizeUsername(input.username ?? '') };
    const lock: LockState = this.limiter.check(keys, this.now());

    const user = input.username ? this.users.findByUsername(input.username) : null;

    // **无论什么分支都要真的跑一次 Argon2id。**
    // 顺序刻意是"先算再判"：若先判 locked 就直接返回，
    // 锁定态会比密码错误快 20ms，等于把锁定状态广播出去。
    let passwordOk = false;
    if (user) {
      passwordOk = await verifyPassword(user.password_hash, input.password ?? '');
    } else {
      await verifyPasswordDummy();
    }

    if (lock.locked) {
      this.limiter.recordFailure('ip', keys.ip, this.now());
      if (keys.account) this.limiter.recordFailure('account', keys.account, this.now());
      /*
       * 功能：锁定期间直接回 423 ACCOUNT_LOCKED，文案说明是锁定而不是密码错。
       *
       * 注意事项：密码正确也拒绝。哈希必须在判 lock 之前算完（见上），
       *   否则锁定态会比密码错快 20ms，等于广播锁定状态。
       *
       * 踩过的坑：旧行为复用 INVALID_CREDENTIALS，用户输对密码仍看到
       *   「用户名或密码不正确」，只能反复试到 10 分钟后自动解锁，
       *   既不知道要等多久，也不知道该找管理员。
       */
      const retryAfterSeconds = Math.max(1, Math.ceil(lock.retryAfterMs / 1000));
      const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
      const byAccount = keys.account ? this.limiter.state('account', keys.account, this.now()) : null;
      const message = byAccount && byAccount.locked
        ? `账号已锁定，请 ${String(minutes)} 分钟后再试，或联系管理员解除锁定`
        : `登录尝试过于频繁，请 ${String(minutes)} 分钟后再试`;
      throw new AuthError('ACCOUNT_LOCKED', message, 423, { retryAfterSeconds });
    }

    if (!user || !passwordOk) {
      this.limiter.recordFailure('ip', keys.ip, this.now());
      if (keys.account) this.limiter.recordFailure('account', keys.account, this.now());
      throw new AuthError('INVALID_CREDENTIALS', CREDENTIALS_REJECTED, 401);
    }

    // 到这里密码已正确 —— 再谈账户状态就不构成枚举风险了
    // （攻击者必须先知道密码才能看到这句话）
    if (user.status !== 'active') {
      throw new AuthError('ACCOUNT_DISABLED', '该账户已被禁用，请联系管理员', 403);
    }

    this.limiter.clear(keys);
    this.users.markLogin(user.id, this.now().toISOString());

    // 参数升级：老哈希用当前基线重算并落库（失败不该阻断登录）
    if (needsRehash(user.password_hash)) {
      try {
        this.users.setPassword(user.id, await hashPassword(input.password), this.now().toISOString());
      } catch {
        // 重哈希失败只影响"下次少算一点"，不能因此让用户登不进来
      }
    }

    if (input.reuseDevice === true) {
      this.sessions.revokeSameDevice(user.id, input.ip, input.userAgent, 'replaced', this.now());
    }
    const tokens = this.issue(user, { ip: input.ip, userAgent: input.userAgent });
    return { user, tokens };
  }

  // ── 注册 ──────────────────────────────────────────────────

  async register(input: {
    username: string;
    password: string;
    ip: string;
    userAgent: string;
    /** 调用者是否是已认证的管理员（admin-only 模式用） */
    callerIsAdmin: boolean;
    /**
     * 邀请码（v0.1.7，`registerMode === 'invite'` 时必填）。
     *
     * 允许带空格/连字符/小写 —— 规范化在 `InviteStore` 里做，
     * 这里不做二次加工，避免"两处各转一次"导致对不上。
     */
    inviteCode?: string;
  }): Promise<{ user: UserRow; tokens: IssuedTokens }> {
    // 走 getter：面板改完立刻生效（跨进程热更，见 config-live.ts）
    const mode = this.registerMode;

    // closed / admin-only 的拒绝是**明确的**（需求特别强调"不伪装成成功"）
    if (mode === 'closed') {
      throw new AuthError(
        'REGISTRATION_CLOSED',
        '本服务端未开放自助注册。请让管理员用 `tcs-server user add <用户名>` 创建账户，或把配置项 auth.registerMode 改为 open',
        403,
      );
    }
    if (mode === 'admin-only' && !input.callerIsAdmin) {
      throw new AuthError('FORBIDDEN', '仅管理员可以创建账户（auth.registerMode = admin-only）', 403);
    }

    /*
     * ── invite 模式的前置校验（v0.1.7）─────────────────────────
     *
     * 这里只做**读**校验，目的是给出能指导下一步的错误。
     * 真正的扣减在下面的事务里 —— 两处都判不是重复，而是分工：
     *   · 这里：告诉用户"码写错了 / 过期了 / 用完了"；
     *   · 事务里：保证并发下不超发（`consume` 的 changes===1）。
     *
     * 如果只在事务里判，用户拿到的是一句笼统的"注册失败"，
     * 而"码过期"和"码打错"对他要做的事完全不同。
     */
    let inviteCode = '';
    if (mode === 'invite') {
      if (this.invites === null) {
        throw new AuthError('SERVICE_UNAVAILABLE', '服务端未正确初始化邀请码功能', 500);
      }
      inviteCode = (input.inviteCode ?? '').trim();
      if (inviteCode === '') {
        throw new AuthError(
          'INVITE_REQUIRED',
          '本服务端需要邀请码才能注册，请向管理员索取',
          403,
        );
      }
      const row = this.invites.findByCode(inviteCode);
      if (row === null) {
        // 不存在与格式不对合并成一句：两者对用户而言都是"这个码不能用"，
        // 分开报只会帮人试探哪些码存在
        throw new AuthError('INVITE_INVALID', '邀请码无效，请检查是否输入正确', 403);
      }
      const state = inviteState(row, this.now());
      if (state === 'expired') {
        throw new AuthError('INVITE_INVALID', '邀请码已过期，请向管理员索取新的', 403);
      }
      if (state === 'exhausted') {
        throw new AuthError('INVITE_INVALID', '邀请码已用完（每张最多 3 个账户）', 403);
      }
      if (state === 'revoked') {
        throw new AuthError('INVITE_INVALID', '邀请码已被作废，请向管理员索取新的', 403);
      }
    }

    // 先真算一次哈希：这样"密码不合规"与"用户名已占用"的耗时对齐
    let passwordHash: string | null = null;
    try {
      passwordHash = await hashPassword(input.password);
    } catch {
      passwordHash = null;
    }

    const existing = input.username ? this.users.findByUsername(input.username) : null;
    let shapeOk = true;
    try {
      // 复用仓储的形状校验（只验证形状，不写库）
      assertUsernameShape(input.username);
    } catch {
      shapeOk = false;
    }

    if (!shapeOk || existing || passwordHash === null) {
      // 密码不合规时上面根本没花哈希时间 —— 补一次等价计算，抹平时序
      if (passwordHash === null) await verifyPasswordDummy();
      throw new AuthError('REGISTRATION_REJECTED', REGISTRATION_REJECTED, 400);
    }

    try {
      /*
       * ── invite 模式：扣码与建账户**必须同事务** ──────────────
       *
       * 分开做有两种坏结果，都不可接受：
       *   · 先扣码后建账户 ⇒ 建账户失败（用户名撞车）⇒ 用户白丢一次机会；
       *   · 先建账户后扣码 ⇒ 中途崩溃 ⇒ 超发（码没用掉但账户建出来了）。
       *
       * 事务里再扣一次（`consume`）不是重复校验，而是**并发正确性的唯一保证**：
       * 上面那次只读校验与这里之间隔着一次 `await hashPassword`（约 100ms），
       * 足够让另一个请求把这张码的最后一次用掉。
       */
      const createAccount = (): UserRow =>
        this.users.create({
          username: input.username,
          // 第一个账户自动管理员（与 CLI 行为一致：否则建完没人能管理）
          passwordHash: passwordHash as string,
          role: this.users.count() === 0 ? 'admin' : 'user',
        });

      const user =
        mode === 'invite'
          ? (this.invites as InviteStore).withTransaction(() => {
              if (!(this.invites as InviteStore).consume(inviteCode, this.now())) {
                // 走到这里说明就在这 100ms 内被别人用光了
                throw new AuthError(
                  'INVITE_INVALID',
                  '邀请码已用完（每张最多 3 个账户），请向管理员索取新的',
                  403,
                );
              }
              return createAccount();
            })
          : createAccount();
      // 默认仓库与账户同时诞生（T10.6）。失败不该阻断注册 ——
      // 仓库可以在第一次上传时由 `ensureDefault` 补上，而账户建不回来。
      try {
        this.repos?.ensureDefault(user.id, this.now().toISOString());
      } catch {
        /* 尽力而为，见上 */
      }
      if (mode === 'admin-only') {
        // 管理员替别人建号：不自动登录成对方（拿到别人的会话是越权）
        return {
          user,
          tokens: {
            accessToken: '',
            refreshToken: '',
            accessExpiresAt: '',
            refreshExpiresAt: '',
            sessionId: '',
          },
        };
      }
      const tokens = this.issue(user, { ip: input.ip, userAgent: input.userAgent });
      return { user, tokens };
    } catch (error) {
      // 并发注册同名用户时唯一索引会抛 —— 同样不能暴露"这个名字存在"，
      // 归到同一句注册失败文案
      if (error instanceof Error && /UNIQUE|用户名/.test(error.message)) {
        await verifyPasswordDummy();
        throw new AuthError('REGISTRATION_REJECTED', REGISTRATION_REJECTED, 400);
      }
      throw error;
    }
  }





  // ── 刷新 / 登出 ────────────────────────────────────────────

  refresh(input: { refreshToken: string; ip: string; userAgent: string }): {
    user: UserRow;
    tokens: IssuedTokens;
  } {
    // 无效 refresh 也返回同一句话：不要让攻击者区分"不存在"与"已吊销"
    const invalid = new AuthError('INVALID_REFRESH_TOKEN', '登录状态已失效，请重新登录', 401);

    if (!input.refreshToken) throw invalid;
    const session = this.sessions.findByRefreshToken(input.refreshToken);
    if (!session) throw invalid;
    if (!this.sessions.isActive(session, this.now())) throw invalid;

    const user = this.users.findById(session.user_id);
    if (!user) throw invalid;

    const now = this.now();
    const refreshToken = this.sessions.rotateRefresh(session.id, REFRESH_TOKEN_TTL_SECONDS, now);
    const accessToken = signJwt(
      { sub: user.id, sid: session.id, role: user.role },
      this.jwtSecret,
      ACCESS_TOKEN_TTL_SECONDS,
      Math.floor(now.getTime() / 1000),
    );

    return {
      user,
      tokens: {
        accessToken,
        refreshToken,
        accessExpiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
        refreshExpiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
        sessionId: session.id,
      },
    };
  }

  logout(sessionId: string): void {
    this.sessions.revoke(sessionId, 'logout', this.now());
  }

  /** 改密码 / 禁用时踢掉所有会话 */
  /**
   * 吊销某账户的全部会话。
   *
   * @param exceptSessionId 保留这一个（"退出其它设备"用）。管理员强制下线不传。
   */
  revokeAll(userId: string, reason: string, exceptSessionId?: string): number {
    return this.sessions.revokeAllForUser(userId, reason, this.now(), exceptSessionId);
  }

  me(userId: string): UserRow | null {
    return this.users.findById(userId);
  }

  /**
   * 免鉴权端点的限速门面（2026-11-25）。
   *
   * 路由不该直接操作 `LoginLimiter` —— 它的 `check` 要 ip + account 两个 key，
   * 而"重置密码"只有 ip 可用。包一层的另一个原因是：以后若要给这类端点
   * 换一套更严的阈值，只改这里。
   */
  ipLockState(ip: string): { locked: boolean; retryAfterSeconds: number } {
    const state = this.limiter.state('reset-ip', ip, this.now());
    return { locked: state.locked, retryAfterSeconds: Math.ceil(state.retryAfterMs / 1000) };
  }

  /** 记一次失败尝试（见 `ipLockState`） */
  recordIpFailure(ip: string): void {
    this.limiter.recordFailure('reset-ip', ip, this.now());
  }

  /** 成功时清零，避免正常用户被自己的手误拖进锁定 */
  clearIpFailures(ip: string): void {
    this.limiter.clearKind('reset-ip', ip);
  }

  /**
   * 用户自助改密码（2026-11-25）。
   *
   * ## 为什么要旧密码
   *
   * 没有旧密码校验，任何拿到「已登录设备」的人都能把密码改掉并把主人踢下线 ——
   * 那是账号被永久夺走的路径。旧密码是"你确实是本人"的最短证明。
   *
   * ## 为什么改完要吊销全部会话（含当前）
   *
   * 用户改密码的动机通常是"怀疑泄露"。保留当前会话没有安全收益，
   * 却会出现"改了密码但别的设备还在用旧 refresh token 续期"。
   * 所以全踢，用户用新密码重新登录一次 —— 客户端界面把这件事提前说清。
   */
  async changePassword(input: {
    userId: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<{ revoked: number }> {
    const user = this.users.findById(input.userId);
    if (user === null) throw new AuthError('UNAUTHORIZED', '账户不存在', 401);

    assertPasswordPolicyOrThrow(input.newPassword);
    if (input.newPassword === input.currentPassword) {
      throw new AuthError('BAD_REQUEST', '新密码不能与当前密码相同', 400);
    }

    const ok = await verifyPassword(user.password_hash, input.currentPassword);
    if (!ok) throw new AuthError('FORBIDDEN', '当前密码不正确', 403);

    const hash = await hashPassword(input.newPassword);
    this.users.setPassword(user.id, hash);
    const revoked = this.sessions.revokeAllForUser(user.id, 'password-change', this.now());
    return { revoked };
  }

  /**
   * 用户自助改用户名（2026-11-25）。
   *
   * ## 为什么也要密码
   *
   * 改用户名会让"日志里的旧名"与"现在的名"对不上，属于身份变更。
   * 顺手拿到设备的人不该能做这件事 —— 与改密码同一条理由。
   *
   * ## uid 不变
   *
   * 这是整个设计的关键：用户名可改，uid 是终身标识（审计、工单、运维
   * 定位都以它为准）。客户端界面上要把这句话说出来。
   */
  async changeUsername(input: {
    userId: string;
    currentPassword: string;
    newUsername: string;
  }): Promise<{ username: string; uid: string }> {
    const user = this.users.findById(input.userId);
    if (user === null) throw new AuthError('UNAUTHORIZED', '账户不存在', 401);

    const ok = await verifyPassword(user.password_hash, input.currentPassword);
    if (!ok) throw new AuthError('FORBIDDEN', '密码不正确', 403);

    /*
     * `setUsername` 抛的是 `UserExistsError` / 普通 Error（形状不合法），
     * 它们不是 AuthError —— 不转就会被统一错误处理当成程序故障回 500。
     * "重名"是用户能自己改对的事，必须是 400 + 原话。
     */
    let next: UserRow;
    try {
      next = this.users.setUsername(user.id, input.newUsername);
    } catch (error) {
      throw new AuthError('BAD_REQUEST', (error as Error).message, 400);
    }
    /*
     * 不改密码，所以**不需要**踢会话：用户名只用于登录时查表，
     * 已有会话绑的是 user_id。踢掉会让用户"只改了个名字就被登出"。
     */
    return { username: next.username, uid: next.uid };
  }

  /**
   * 用「UID + 临时密码」重置密码（2026-11-25，运维兜底）。
   *
   * ## 临时密码只能做这一件事
   *
   * 它**不是密码**：`users.password_hash` 完全没被它替换，也不产生会话。
   * 用户拿它来这里换一个新密码，票据随即作废。
   *
   * ## 失败一律同一句话
   *
   * 「uid 不存在」「码错了」「码过期了」「码用过了」全回同一句 ——
   * 否则这个免鉴权端点就是**枚举 uid 的探针**。
   */
  async resetPasswordWithTicket(input: {
    uid: string;
    code: string;
    newPassword: string;
  }): Promise<{ username: string; revoked: number }> {
    const tickets = this.tickets;
    if (tickets === null) {
      throw new AuthError('SERVICE_UNAVAILABLE', '临时密码功能未启用', 503);
    }

    assertPasswordPolicyOrThrow(input.newPassword);

    const ticket = tickets.redeem({ uid: input.uid, code: input.code, now: this.now() });
    if (ticket === null) {
      throw new AuthError('UNAUTHORIZED', TICKET_REJECTED, 401);
    }

    const user = this.users.findById(ticket.user_id);
    if (user === null) {
      /* 账户在票据有效期内被注销：票据已经核销，这里只回报同一句 */
      throw new AuthError('UNAUTHORIZED', TICKET_REJECTED, 401);
    }

    const hash = await hashPassword(input.newPassword);
    this.users.setPassword(user.id, hash);
    /* 改完踢掉全部会话：与自助改密码同一个理由 */
    const revoked = this.sessions.revokeAllForUser(user.id, 'password-reset-via-ticket', this.now());
    return { username: user.username, revoked };
  }
}


export { DEFAULT_RATE_LIMIT };
