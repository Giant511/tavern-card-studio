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
        ip: deps.clientIp(ctx),
        userAgent: userAgent(ctx),
        callerIsAdmin: caller?.role === 'admin',
      });
      // admin-only 建号不返回令牌：拿到别人的会话是越权
      if (result.tokens.accessToken === '') {
        sendJson(ctx.res, 201, { user: toPublicUser(result.user) });
        return;
      }
      sendJson(ctx.res, 201, tokensPayload(toPublicUser(result.user), result.tokens));
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
