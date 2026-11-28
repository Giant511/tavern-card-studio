/**
 * 认证相关 HTTP 路由（T10.4）。
 *
 * 端点：
 *   POST /api/auth/register   注册（受 auth.registerMode 控制）
 *   POST /api/auth/login      登录 → access + refresh
 *   POST /api/auth/refresh    用 refresh 换新的 access（并轮换 refresh）
 *   POST /api/auth/logout     吊销当前会话
 *   GET  /api/auth/me         当前身份
 *   POST /api/auth/repo-token 校验仓库令牌（tcr_…），用于「使用仓库令牌连接」
 *
 * login / register / refresh / repo-token 是**免鉴权**的（调用方此时必然还没有
 * 令牌），与 `/api/token` 一样写死在 app.ts 的豁免列表里，而不是加进用户可改的
 * `auth.publicPaths` —— 那条豁免是安全模型的一部分，不该被误删或误加宽。
 *
 * 状态码约定：
 *   · 登录失败 / 锁定 / refresh 失效 一律 **401 + 同一句话**
 *   · 注册关闭 **403**（需求强调"明确拒绝、不伪装成功"）
 *   · 注册参数不合法或被占用 **400 + 同一句话**
 *   · 账户被禁用 **403**（只有密码正确才会走到这里，不构成枚举面）
 */

import { AppError } from '../errors.js';
import { AuthError, ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS } from '../auth/service.js';
import type { RouteContext } from './router.js';
import type { AuthService } from '../auth/service.js';
import type { AuthContext } from './auth.js';
import { toPublicUser, type PublicUser } from '../storage/users.js';
import { sendJson } from './responses.js';
import { verifyRepoTokenEntry } from '../auth/repo-token-entry.js';
import type { RepoStore, TokenStore } from '../storage/repos.js';

export interface AuthRouteDeps {
  auth: AuthService;
  /** 解析当前请求身份（用于 admin-only 注册判定与 /me） */
  identify: (ctx: RouteContext) => AuthContext | null;
  /**
   * 仓库令牌存储与仓库存储（v0.1.3 / F5 后半）。
   *
   * 不给就不注册 `/api/auth/repo-token`（老装配不崩，只是没有这个入口）。
   * 之所以放在认证路由里而不是仓库路由里：它判的是**身份**，
   * 与仓库路由那套「已经登录之后管理仓库」是两件事。
   */
  repoTokens?: TokenStore;
  repos?: RepoStore;
  users?: { findById(id: string): { id: string; username: string; status: string } | null };
  now?: () => Date;
  /**
   * 取客户端 IP。
   *
   * **不读 `X-Forwarded-For`**：那是一个可以随意伪造的请求头，用它做限速等于
   * 给攻击者一个"每次换一个 IP"的开关，限速会彻底失效。
   * 部署在反向代理后面时，正确做法是让代理与 worker 走回环/内网；
   * 显式 `trustProxy` 白名单列 v0.1.3。
   */
  clientIp: (ctx: RouteContext) => string;
  /**
   * 审计事件写入（2026-11-24 新增，可选）。
   *
   * 只为一件事：**首个账户自动成为管理员**时留一条可追溯的记录。
   *
   * 背景（报告 P1-9）：`auth.registerMode=open` 且首次部署时，第一个注册的人
   * 拿到管理员权限 —— 这个设计本身合理（否则建完没人能管理），但它是"按顺序"
   * 决定的：部署者晚几分钟注册，控制权就在别人手里。
   *
   * 原来的唯一提示是启动时的一条 warning，而且同一配置只打一次
   * （去重后重启不再提示）。所以事故发生后翻日志也看不出"谁在什么时候
   * 拿到了管理员"。
   *
   * 不给这个依赖时不影响注册（老装配不崩），只是没有那条审计。
   */
  appendEvent?: (event: {
    at: string;
    level: 'info' | 'warn' | 'error';
    action: string;
    cardId: string | null;
    detail: Record<string, unknown>;
  }) => void;
}

/** 把 AuthError 翻译成 HTTP 响应；非 AuthError 原样抛出交给统一错误处理 */
function rethrow(error: unknown): never {
  if (error instanceof AuthError) {
    throw new AppError(error.status, error.code, error.message, error.details);
  }
  throw error;
}

function bodyJson(ctx: RouteContext): Record<string, unknown> {
  if (ctx.body.length === 0) return {};
  try {
    const parsed = JSON.parse(ctx.body.toString('utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new AppError(400, 'BAD_REQUEST', '请求体不是合法 JSON');
  }
}

function str(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

function userAgent(ctx: RouteContext): string {
  const value = ctx.req.headers['user-agent'];
  return typeof value === 'string' ? value : '';
}

/** 令牌响应的统一形状。绝不包含 password_hash（toPublicUser 已剔除） */
function tokensPayload(
  user: PublicUser,
  tokens: {
    accessToken: string;
    refreshToken: string;
    accessExpiresAt: string;
    refreshExpiresAt: string;
    sessionId: string;
  },
) {
  return {
    user,
    tokenType: 'Bearer',
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessExpiresAt: tokens.accessExpiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
    sessionId: tokens.sessionId,
    // 客户端据此决定何时刷新（秒），避免两边各写一份魔数
    accessTtlSeconds: ACCESS_TOKEN_TTL_SECONDS,
    refreshTtlSeconds: REFRESH_TOKEN_TTL_SECONDS,
  };
}

type Registrar = {
  post: (path: string, handler: (ctx: RouteContext) => Promise<void> | void) => unknown;
  get: (path: string, handler: (ctx: RouteContext) => Promise<void> | void) => unknown;
};

export function registerAuthRoutes(router: Registrar, deps: AuthRouteDeps): void {
  const { auth } = deps;

  /**
   * 公开的认证策略（T10.7）。
   *
   * 客户端必须在**画出登录框之前**知道 `registerMode`：需求要求 closed 时
   * 干脆不显示注册入口，而不是等用户点了才报错。所以这个端点必须免鉴权。
   *
   * 只回策略，不回任何账户信息 —— 没有可枚举的东西。刻意**不**返回
   * 是否已有账户（那会让公网探测到"这台机器还没初始化"）。
   */
  router.get('/api/auth/config', (ctx) => {
    sendJson(ctx.res, 200, {
      registerMode: auth.registerMode,
      /** access 有效期（秒），客户端据此决定什么时候静默续期 */
      accessTtlSeconds: ACCESS_TOKEN_TTL_SECONDS,
      /** 是否需要令牌：false 时连登录界面都不必弹（仅回环 + auth.require=false） */
      authRequired: auth.requiresAuth,
    });
  });

  router.post('/api/auth/register', async (ctx) => {
    const body = bodyJson(ctx);
    const caller = deps.identify(ctx);
    try {
      const result = await auth.register({
        username: str(body, 'username'),
        password: str(body, 'password'),
        // v0.1.7：邀请码注册模式必填。非 invite 模式下传了也**不影响**任何判断
        // （服务端只在 mode==='invite' 时读它），这样客户端可以无条件带上这个字段，
        // 不必先问服务端"要不要"——少一次往返，也少一处两端可能不一致的判断。
        ...(typeof body['inviteCode'] === 'string' ? { inviteCode: body['inviteCode'] } : {}),
        ip: deps.clientIp(ctx),
        userAgent: userAgent(ctx),
        callerIsAdmin: caller?.role === 'admin',
      });
      // admin-only 建号不返回令牌：拿到别人的会话是越权
      if (result.tokens.accessToken === '') {
        sendJson(ctx.res, 201, { user: toPublicUser(result.user) });
        return;
      }
      /*
       * 首个账户自动成为管理员时留痕（2026-11-24）。
       *
       * 判据是**新账户的 role**，不是"用户总数"—— 后者在并发注册下会漂移，
       * 而 role 是这条记录本身携带的事实。
       *
       * 只在 `open` 模式下记：`invite` / `admin-only` 时管理员是别人授予的，
       * 不存在"谁抢到第一个"这件事。
       */
      if (result.user.role === 'admin' && auth.registerMode === 'open') {
        deps.appendEvent?.({
          at: (deps.now?.() ?? new Date()).toISOString(),
          level: 'warn',
          action: 'account.bootstrap-admin',
          cardId: null,
          detail: {
            userId: result.user.id,
            username: result.user.username,
            ip: deps.clientIp(ctx),
            note: '自助注册模式下首个账户自动获得管理员权限',
          },
        });
      }
      sendJson(ctx.res, 201, {
        ...tokensPayload(toPublicUser(result.user), result.tokens),
        // 让客户端能直接把这句话显示出来，而不是让用户自己从 role 字段推断
        ...(result.user.role === 'admin' ? { notice: '你是第一个账户，已获得管理员权限' } : {}),
      });
    } catch (error) {
      rethrow(error);
    }
  });

  router.post('/api/auth/login', async (ctx) => {
    const body = bodyJson(ctx);
    try {
      const result = await auth.login({
        username: str(body, 'username'),
        password: str(body, 'password'),
        ip: deps.clientIp(ctx),
        userAgent: userAgent(ctx),
        reuseDevice: body['reuseDevice'] === true,
      });
      sendJson(ctx.res, 200, tokensPayload(toPublicUser(result.user), result.tokens));
    } catch (error) {
      rethrow(error);
    }
  });

  router.post('/api/auth/refresh', (ctx) => {
    const body = bodyJson(ctx);
    try {
      const result = auth.refresh({
        refreshToken: str(body, 'refreshToken'),
        ip: deps.clientIp(ctx),
        userAgent: userAgent(ctx),
      });
      sendJson(ctx.res, 200, tokensPayload(toPublicUser(result.user), result.tokens));
    } catch (error) {
      rethrow(error);
    }
  });

  router.post('/api/auth/logout', (ctx) => {
    const caller = deps.identify(ctx);
    if (!caller) throw new AppError(401, 'UNAUTHORIZED', '需要登录后才能登出');
    if (caller.sessionId) auth.logout(caller.sessionId);
    sendJson(ctx.res, 200, { ok: true });
  });

  /**
   * 校验仓库令牌（v0.1.3 / F5 后半）—— 登录界面的第三个入口用它。
   *
   * **免鉴权**：调用方此时正拿着一把还没被认可的令牌，没有别的凭证可用。
   * 它自己就是鉴权入口，所以不能过 TokenGate。
   *
   * 四类失败原因与「不存在 ≡ 无效」的原因，见 `auth/repo-token-entry.ts` 文件头。
   * 这里只负责把结论翻成 HTTP：格式错误 400，其余 401。
   *
   * 成功时**不回令牌原文**（调用方本来就有），只回"这把令牌能干什么"：
   * 仓库 id/名字、scope、到期时间。客户端据此决定单仓库模式里的按钮可用性。
   */
  if (deps.repoTokens && deps.repos && deps.users) {
    const tokens = deps.repoTokens;
    const repos = deps.repos;
    const users = deps.users;

    router.post('/api/auth/repo-token', (ctx) => {
      const body = bodyJson(ctx);
      const raw = str(body, 'token').trim();
      const result = verifyRepoTokenEntry(raw, { tokens, repos, users, now: deps.now });

      if (!result.ok) {
        throw new AppError(result.status, result.code, result.message, result.hint === undefined ? {} : { hint: result.hint });
      }

      // 记一次使用时间：界面靠它显示「这把令牌是不是第一次被用」
      try {
        tokens.touch(result.tokenId, new Date().toISOString());
      } catch {
        // touch 失败不影响本次校验结论 —— 不要因为记一笔日志就让用户连不上
      }

      sendJson(ctx.res, 200, {
        ok: true,
        repo: { id: result.repoId, name: result.repoName },
        scopes: result.scopes,
        username: result.username,
        expiresAt: result.expiresAt,
        lastUsedAt: result.lastUsedAt,
        // 明确告诉客户端"这不是账户会话"：后续请求按 scope 判权限，
        // 不存在续期、也没有 refresh 令牌可拿
        tokenType: 'RepoToken',
      });
    });
  }

  /**
   * 从请求里取账户身份（jwt 专用）。
   *
   * 与 `account-routes.ts` 的同名局部函数同一条判据：仓库令牌与 legacy
   * 全局令牌都没有"这是哪个账户"的身份，改密码/改名对它们无意义 ——
   * 而如果放行，legacy 令牌会以空 userId 去改一个不存在的账户。
   */
  function requireAccountJwt(ctx: RouteContext): AuthContext & { userId: string } {
    const caller = deps.identify(ctx);
    if (caller === null) throw new AppError(401, 'UNAUTHORIZED', '需要账户登录');
    if (caller.via !== 'jwt' || caller.userId === null) {
      throw new AppError(403, 'FORBIDDEN', '这项操作需要账户登录（仓库令牌与全局令牌都不行）');
    }
    return caller as AuthContext & { userId: string };
  }

  /**
   * 用「UID + 临时密码」重置密码（2026-11-25，运维兜底）。
   *
   * ## 为什么免鉴权
   *
   * 调用方正是"登不上的人" —— 他没有任何凭证可用。这里的三要素
   * （uid / 临时密码 / 新密码）本身就是凭证。
   *
   * ## 为什么临时密码不能当密码用
   *
   * 它不在 `users.password_hash` 里，`/api/auth/login` 那条路根本不看它。
   * 也就是说这个端点**只换密码，不发会话** —— 用户改完必须自己登录一次。
   *
   * ## 为什么要限速
   *
   * 临时密码是 12 位、30 分钟有效、一次即废，本来很难撞。
   * 但这个端点免鉴权，不限速就等于给了一个可以无限试的入口。
   * 复用登录那套 `LoginLimiter`（kind 用 `ip`，与登录共用同一个桶）——
   * 它已经验证过"锁定期间不续期"那套取舍。
   */
  router.post('/api/auth/reset-password', async (ctx) => {
    const body = bodyJson(ctx);
    const ip = deps.clientIp(ctx);
    /*
     * 与登录共用 IP 桶：同一台机器既试密码又试临时密码，本来就该一起计数。
     * 锁上了就按 429 回，不区分"是哪种尝试"。
     */
    const locked = deps.auth.ipLockState(ip);
    if (locked.locked) {
      throw new AppError(429, 'TOO_MANY_REQUESTS', '尝试次数过多，请稍后再试', {
        retryAfterSeconds: locked.retryAfterSeconds,
      });
    }

    try {
      const result = await deps.auth.resetPasswordWithTicket({
        uid: str(body, 'uid'),
        code: str(body, 'code'),
        newPassword: str(body, 'newPassword'),
      });
      deps.auth.clearIpFailures(ip);
      sendJson(ctx.res, 200, { username: result.username, revoked: result.revoked });
    } catch (error) {
      /*
       * 失败才记账。成功时 clean 掉 —— 与登录一致：
       * 成功一次就把"这人刚才输错过"清零，避免正常用户被自己的手误拖进锁定。
       */
      deps.auth.recordIpFailure(ip);
      rethrow(error);
    }
  });

  /**
   * 自助改密码（2026-11-25）。需要登录 + 当前密码。
   *
   * 成功后会**吊销全部会话**（含调用方自己）—— 客户端据 `revoked` 提示
   * 用户"请用新密码重新登录"。
   */
  router.post('/api/account/password', async (ctx) => {
    const caller = requireAccountJwt(ctx);
    const body = bodyJson(ctx);
    try {
      const result = await deps.auth.changePassword({
        userId: caller.userId,
        currentPassword: str(body, 'currentPassword'),
        newPassword: str(body, 'newPassword'),
      });
      sendJson(ctx.res, 200, { ok: true, revoked: result.revoked });
    } catch (error) {
      /* 不包这一层，AuthError（403 密码错 / 400 太短）会被当成 500 */
      rethrow(error);
    }
  });

  /**
   * 自助改用户名（2026-11-25）。需要登录 + 当前密码。
   *
   * uid 不变（终身标识），会话不吊销（用户名只用于登录查表）。
   */
  router.post('/api/account/username', async (ctx) => {
    const caller = requireAccountJwt(ctx);
    const body = bodyJson(ctx);
    try {
      const result = await deps.auth.changeUsername({
        userId: caller.userId,
        currentPassword: str(body, 'currentPassword'),
        newUsername: str(body, 'newUsername'),
      });
      sendJson(ctx.res, 200, { ok: true, username: result.username, uid: result.uid });
    } catch (error) {
      /* 重名 / 形状不合法是 400 + 原话，不是 500 */
      rethrow(error);
    }
  });

  router.get('/api/auth/me', (ctx) => {
    const caller = deps.identify(ctx);
    if (!caller) throw new AppError(401, 'UNAUTHORIZED', '需要登录');
    if (caller.via === 'legacy') {
      // legacy 全局 token 没有账户身份 —— 如实说，不要编一个假用户
      sendJson(ctx.res, 200, { via: 'legacy', role: 'admin', user: null });
      return;
    }
    const user = caller.userId ? auth.me(caller.userId) : null;
    if (!user) throw new AppError(401, 'UNAUTHORIZED', '账户不存在或已删除');
    /*
     * 仓库令牌也要如实报 `via`（v0.1.3 / F5 后半修）。
     *
     * 上一版这里无条件写 `via: 'jwt'` —— 于是用仓库令牌连上的客户端调 /me
     * 会得到"你是 jwt 会话"，进而去找 refresh 令牌续期，而仓库令牌根本没有
     * refresh。那条路径上不会报错，只会表现为"过一会儿所有请求都 401"。
     * 这正是本次反馈里"两套凭证路径说不清"的一个具体来源。
     */
    if (caller.via === 'repo-token' && caller.repoToken !== null) {
      const repo = deps.repos?.findById(caller.repoToken.repoId) ?? null;
      sendJson(ctx.res, 200, {
        via: 'repo-token',
        role: caller.role,
        user: toPublicUser(user),
        repo: { id: caller.repoToken.repoId, name: repo?.name ?? '' },
        scopes: caller.repoToken.scopes,
      });
      return;
    }
    sendJson(ctx.res, 200, { via: 'jwt', role: caller.role, user: toPublicUser(user) });
  });
}
