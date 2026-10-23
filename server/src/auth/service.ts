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
import type { ErrorCode } from '../errors.js';
import { LoginLimiter, DEFAULT_RATE_LIMIT, type LockState } from './login-limit.js';
import { hashPassword, needsRehash, verifyPassword, verifyPasswordDummy, CREDENTIALS_REJECTED } from './password.js';
import { SessionStore } from './sessions.js';
import { signJwt } from './jwt.js';
import { UserStore, assertUsernameShape, normalizeUsername, type UserRow } from '../storage/users.js';

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
  /** 注入时钟，便于测试过期/锁定 */
  now?: () => Date;
}

export class AuthService {
  private readonly users: UserStore;
  private readonly sessions: SessionStore;
  private readonly limiter: LoginLimiter;
  private readonly config: ServerConfigFile;
  private readonly now: () => Date;

  constructor(options: AuthServiceOptions) {
    this.users = options.users;
    this.sessions = options.sessions;
    this.limiter = options.limiter;
    this.config = options.config;
    this.now = options.now ?? (() => new Date());
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
      // 锁定期间：即便密码正确也拒绝，且**响应与密码错一致**（不返回 retryAfter）
      this.limiter.recordFailure('ip', keys.ip, this.now());
      if (keys.account) this.limiter.recordFailure('account', keys.account, this.now());
      throw new AuthError('INVALID_CREDENTIALS', CREDENTIALS_REJECTED, 401);
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
  }): Promise<{ user: UserRow; tokens: IssuedTokens }> {
    const mode = this.config.auth.registerMode;

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
      const user = this.users.create({
        username: input.username,
        // 第一个账户自动管理员（与 CLI 行为一致：否则建完没人能管理）
        passwordHash,
        role: this.users.count() === 0 ? 'admin' : 'user',
      });
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
  revokeAll(userId: string, reason: string): number {
    return this.sessions.revokeAllForUser(userId, reason, this.now());
  }

  me(userId: string): UserRow | null {
    return this.users.findById(userId);
  }
}


export { DEFAULT_RATE_LIMIT };
