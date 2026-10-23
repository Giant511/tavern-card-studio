/**
 * API 鉴权（T5.6 起，T10.4 扩展为双模式）。
 *
 * 接受两种凭证：
 *
 *   1. **legacy 全局 token**（v0.1.0 起的兼容层）—— 无身份、等同"本机管理员"。
 *      保留它是为了不弄断已装客户端的同步链路（需求 F2.3 明确要求兼容）。
 *      面板与 CLI 也继续用它。
 *   2. **JWT access token**（T10.4 起）—— 带 `sub`/`sid`，吊销按会话生效。
 *      校验时**必须查库**确认会话未吊销，否则"吊销"要等 2h 自然过期才生效。
 *
 * 设计取舍：
 *   · 只接受请求头（`Authorization: Bearer ...` 或 `X-API-Token`），不接受 `?token=`
 *     —— query 会进访问日志、浏览器历史、Referer；
 *   · 全局 token 比较用 sha256 + timingSafeEqual，避免长度差与逐字节比较泄露时序；
 *   · JWT 失败**不回显具体原因**（签名错 ≠ 过期，细到这一步就够攻击者用了）。
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { AppError } from '../errors.js';
import { verifyJwt, type JwtPayload } from '../auth/jwt.js';
import type { SessionStore } from '../auth/sessions.js';
import type { UserStore } from '../storage/users.js';
import { parseScopes, type RepoStore, type TokenScope, type TokenStore } from '../storage/repos.js';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export function extractToken(req: IncomingMessage): string | null {
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1]) return match[1].trim();
  }
  const header = req.headers['x-api-token'];
  if (typeof header === 'string' && header.trim() !== '') return header.trim();
  return null;
}

/** 一次请求的身份。`via: 'legacy'` 表示用的是全局 token（无账户身份） */
export interface AuthContext {
  via: 'legacy' | 'jwt' | 'repo-token';
  /** legacy 时为 null */
  userId: string | null;
  sessionId: string | null;
  role: 'admin' | 'user';
  username: string | null;
  /**
   * 仓库令牌绑定到的仓库与权限范围（T10.6）。
   *
   * 只有 `via === 'repo-token'` 时非 null；jwt 与 legacy 都作用于"该账户的全部仓库"
   * （jwt 的账户范围由调用方按 userId 过滤；legacy 是运维凭证，视为全部）。
   */
  repoToken: {
    tokenId: string;
    repoId: string;
    scopes: TokenScope[];
  } | null;
}

/** legacy token 视为管理员：它能做的事与 v0.1.1 完全一样，不能因为引入账户就缩权 */
export const LEGACY_AUTH: AuthContext = {
  via: 'legacy',
  userId: null,
  sessionId: null,
  role: 'admin',
  username: null,
  repoToken: null,
};

interface FailureRecord {
  count: number;
  firstAt: number;
  blockedUntil: number;
}

const WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILURES = 20;
const BLOCK_MS = 5 * 60 * 1000;

export interface TokenGateDeps {
  /** JWT 签名密钥；为空则只接受 legacy token（老配置兼容） */
  jwtSecret?: string;
  sessions?: SessionStore;
  users?: UserStore;
  /** 仓库令牌（T10.6）。不给就只认 legacy + JWT */
  repoTokens?: TokenStore;
  repos?: RepoStore;
  now?: () => Date;
  /**
   * 有效客户端地址（v0.1.2 追加任务）。
   *
   * 失败计数按它分桶。默认取 `req.socket.remoteAddress` —— 但**反代部署下那是代理 IP**，
   * 于是全世界共用一格，5 次失败就把所有人锁在门外。调用方传入基于 `trustProxy`
   * 解析出的有效地址即可恢复"按真实 IP 限速"。
   */
  clientIp?: (req: IncomingMessage) => string;
}

export class TokenGate {
  private readonly failures = new Map<string, FailureRecord>();

  constructor(
    private readonly token: string,
    private readonly publicPaths: readonly string[],
    /** false 时跳过鉴权（仅允许回环地址，见 assertSafeConfig） */
    private readonly required = true,
    private readonly deps: TokenGateDeps = {},
  ) {}

  isPublic(pathname: string): boolean {
    return this.publicPaths.some((pattern) => {
      if (pattern.endsWith('*')) return pathname.startsWith(pattern.slice(0, -1));
      return pathname === pattern;
    });
  }

  /**
   * 解析凭证并返回身份。返回 null 表示"不需要鉴权"。
   *
   * 与 {@link check} 的区别：这个方法**不抛 429**，只做身份解析，
   * 供"可选鉴权"的接口（如注册的 admin-only 判定）使用。
   */
  identify(req: IncomingMessage): AuthContext | null {
    const provided = extractToken(req);
    if (!provided) return null;

    // 先比 legacy token：它最便宜（一次 sha256），也是面板/CLI 的常用路径
    if (this.token && constantTimeEqual(provided, this.token)) return LEGACY_AUTH;

    // 仓库令牌（T10.6）：同样是一次 sha256 查表，比 JWT 验签便宜，
    // 且前缀能快速排除（非 tcr_ 开头直接跳过）
    if (provided.startsWith('tcr_')) {
      return this.verifyRepoToken(provided);
    }

    const jwt = this.verifyAccessToken(provided);
    return jwt;
  }

  /**
   * 校验仓库令牌。
   *
   * **每次请求都从库里读当前状态**（吊销/过期/权限范围），
   * 不缓存 —— 否则"改小权限"要等缓存过期才生效，而需求要求逐请求执行。
   */
  private verifyRepoToken(raw: string): AuthContext | null {
    const tokens = this.deps.repoTokens;
    const repos = this.deps.repos;
    const users = this.deps.users;
    if (!tokens || !repos || !users) return null;

    const now = this.deps.now?.() ?? new Date();
    const row = tokens.findByRaw(raw);
    if (!row) return null;
    // 吊销 / 过期都在这里判：库里的状态是唯一真相
    if (!tokens.isUsable(row, now)) return null;

    const repo = repos.findById(row.repo_id);
    if (!repo) return null;
    if (repo.owner_id !== row.owner_id) return null;

    const user = users.findById(row.owner_id);
    if (!user || user.status !== 'active') return null;

    return {
      via: 'repo-token',
      userId: user.id,
      sessionId: null,
      // 角色仍按账户算：仓库令牌不提升也不降低账户角色，
      // 它能做什么是 scopes 决定的（见 checkPermission）
      role: user.role,
      username: user.username,
      repoToken: {
        tokenId: row.id,
        repoId: row.repo_id,
        // scopes 从库里实时解析：管理员 setScopes 收窄后，下一个请求就按新范围判
        scopes: parseScopes(row.scopes),
      },
    };
  }

  /** 校验 JWT 并确认会话仍然有效（未吊销、未过期、用户未禁用） */
  private verifyAccessToken(token: string): AuthContext | null {
    const secret = this.deps.jwtSecret;
    if (!secret) return null;

    const now = this.deps.now?.() ?? new Date();
    const result = verifyJwt(token, secret, Math.floor(now.getTime() / 1000));
    if (!result.ok || !result.payload) return null;

    const payload: JwtPayload = result.payload;
    const sessions = this.deps.sessions;
    const users = this.deps.users;
    if (!sessions || !users) return null;

    const session = sessions.findById(payload.sid);
    if (!session) return null;
    // **这一步就是"吊销立即生效"的实现**：查库，不看令牌自身是否过期
    if (!sessions.isActive(session, now)) return null;
    if (session.user_id !== payload.sub) return null;

    const user = users.findById(payload.sub);
    if (!user) return null;

    return {
      via: 'jwt',
      userId: user.id,
      sessionId: session.id,
      // 角色以**库**为准，不信令牌里的快照（降级后旧令牌不能继续当管理员）
      role: user.role,
      username: user.username,
      repoToken: null,
    };
  }

  /** 返回 null 表示通过；否则抛 AppError（401/429） */
  check(req: IncomingMessage, pathname: string): void {
    if (!this.required) return;
    if (this.isPublic(pathname)) return;

    const ip = this.deps.clientIp ? this.deps.clientIp(req) : (req.socket.remoteAddress ?? 'unknown');
    const now = Date.now();
    const record = this.failures.get(ip);
    if (record && record.blockedUntil > now) {
      throw new AppError(429, 'TOO_MANY_REQUESTS', '鉴权失败次数过多，请稍后再试', {
        retryAfterSeconds: Math.ceil((record.blockedUntil - now) / 1000),
      });
    }

    const identity = this.identify(req);
    if (identity) {
      this.failures.delete(ip);
      if (identity.sessionId && this.deps.sessions) {
        // 记录"这个会话还活着"，面板的登录设备列表要用
        this.deps.sessions.touch(identity.sessionId, this.deps.now?.() ?? new Date());
      }
      return;
    }

    const next: FailureRecord =
      record && now - record.firstAt < WINDOW_MS
        ? { ...record, count: record.count + 1 }
        : { count: 1, firstAt: now, blockedUntil: 0 };
    if (next.count >= MAX_FAILURES) {
      next.blockedUntil = now + BLOCK_MS;
    }
    this.failures.set(ip, next);

    throw new AppError(401, 'UNAUTHORIZED', '缺少或无效的访问令牌', {
      hint: '请求头加 Authorization: Bearer <token>（全局 token 或登录得到的 access token）',
    });
  }

  /** 面板「验证令牌」用 */
  verify(provided: string): boolean {
    return constantTimeEqual(provided, this.token);
  }
}
