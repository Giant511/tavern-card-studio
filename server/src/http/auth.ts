/**
 * API 鉴权（T5.6）：Bearer token。
 *
 * 设计取舍：
 *   · 只接受请求头（`Authorization: Bearer ...` 或 `X-API-Token`），不接受 `?token=`——
 *     query 会进访问日志、浏览器历史、Referer，本地工具也没必要开这个口子；
 *   · 比较用 sha256 + timingSafeEqual，避免长度差与逐字节比较泄露时序；
 *   · 失败次数按来源 IP 计数，5 分钟内 20 次失败即短暂封禁，防止本机其他进程暴力猜 token；
 *   · 监听非回环地址时 `assertSafeConfig` 已强制要求开鉴权（config.ts）。
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { AppError } from '../errors.js';

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

interface FailureRecord {
  count: number;
  firstAt: number;
  blockedUntil: number;
}

const WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILURES = 20;
const BLOCK_MS = 5 * 60 * 1000;

export class TokenGate {
  private readonly failures = new Map<string, FailureRecord>();

  constructor(
    private readonly token: string,
    private readonly publicPaths: readonly string[],
    /** false 时跳过鉴权（仅允许回环地址，见 assertSafeConfig） */
    private readonly required = true,
  ) {}

  isPublic(pathname: string): boolean {
    return this.publicPaths.some((pattern) => {
      if (pattern.endsWith('*')) return pathname.startsWith(pattern.slice(0, -1));
      return pathname === pattern;
    });
  }

  /** 返回 null 表示通过；否则抛 AppError（401/429） */
  check(req: IncomingMessage, pathname: string): void {
    if (!this.required) return;
    if (this.isPublic(pathname)) return;

    const ip = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const record = this.failures.get(ip);
    if (record && record.blockedUntil > now) {
      throw new AppError(429, 'TOO_MANY_REQUESTS', '鉴权失败次数过多，请稍后再试', {
        retryAfterSeconds: Math.ceil((record.blockedUntil - now) / 1000),
      });
    }

    const provided = extractToken(req);
    if (provided && constantTimeEqual(provided, this.token)) {
      this.failures.delete(ip);
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
      hint: '请求头加 Authorization: Bearer <token>，token 见 dataDir/config.json 或 `tcs-server token show`',
    });
  }

  /** 面板「验证令牌」用 */
  verify(provided: string): boolean {
    return constantTimeEqual(provided, this.token);
  }
}
