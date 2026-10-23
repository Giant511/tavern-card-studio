/**
 * 认证相关 HTTP 路由（T10.4）。
 *
 * 端点：
 *   POST /api/auth/register   注册（受 auth.registerMode 控制）
 *   POST /api/auth/login      登录 → access + refresh
 *   POST /api/auth/refresh    用 refresh 换新的 access（并轮换 refresh）
 *   POST /api/auth/logout     吊销当前会话
 *   GET  /api/auth/me         当前身份
 *
 * login / register / refresh 是**免鉴权**的（调用方此时必然还没有令牌），
 * 与 `/api/token` 一样写死在 app.ts 的豁免列表里，而不是加进用户可改的
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

export interface AuthRouteDeps {
  auth: AuthService;
  /** 解析当前请求身份（用于 admin-only 注册判定与 /me） */
  identify: (ctx: RouteContext) => AuthContext | null;
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
    sendJson(ctx.res, 200, { via: 'jwt', role: caller.role, user: toPublicUser(user) });
  });
}
