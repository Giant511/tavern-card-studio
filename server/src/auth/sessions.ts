/**
 * 会话与吊销（T10.4）。
 *
 * **吊销的粒度是"会话"，不是"单个令牌"**：
 *   · 一个会话 = 一次登录，包含 1 个 access token（2h）+ 1 个 refresh token；
 *   · 吊销会话 → 该会话签出的 access 与 refresh **同时**失效；
 *   · access token 校验时会查会话状态，所以吊销**立即**生效，
 *     不需要等 2h 自然过期（这是选择"查库"而不是"纯无状态 JWT"的原因）。
 *
 * **吊销状态落库，不落内存**：服务端是 Windows 服务，升级 MSI / 重启 /
 * 崩溃都会重建进程。放内存里意味着重启即"全部复活"，那等于没有吊销。
 *
 * refresh token 存**哈希**不存原文：库文件泄露时，攻击者拿到哈希也无法
 * 用它换新令牌（与密码存储同理）。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

export interface SessionRow {
  id: string;
  user_id: string;
  /** refresh token 的 sha256（十六进制）。**永不**存原文 */
  refresh_hash: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  /** 非 null 即已吊销；保留行而不是删除，便于排查"为什么被踢下线" */
  revoked_at: string | null;
  revoke_reason: string | null;
  last_seen_at: string | null;
  user_agent: string;
  ip: string;
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateRefreshToken(): string {
  // 32 字节 = 256 bit 熵，足够抵抗暴力猜测；base64url 便于放请求体/头
  return randomBytes(32).toString('base64url');
}

export interface CreateSessionInput {
  userId: string;
  refreshTokenTtlSeconds: number;
  userAgent?: string;
  ip?: string;
  now?: Date;
  /** 注入以便测试（默认新 uuid） */
  id?: string;
}

export class SessionStore {
  constructor(private readonly handle: Database.Database) {}

  create(input: CreateSessionInput): { session: SessionRow; refreshToken: string } {
    const now = input.now ?? new Date();
    const refreshToken = generateRefreshToken();
    const session: SessionRow = {
      id: input.id ?? randomUUID(),
      user_id: input.userId,
      refresh_hash: hashRefreshToken(refreshToken),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      expires_at: new Date(now.getTime() + input.refreshTokenTtlSeconds * 1000).toISOString(),
      revoked_at: null,
      revoke_reason: null,
      last_seen_at: now.toISOString(),
      user_agent: (input.userAgent ?? '').slice(0, 300),
      ip: (input.ip ?? '').slice(0, 64),
    };

    this.handle
      .prepare(
        `INSERT INTO sessions (id, user_id, refresh_hash, created_at, updated_at, expires_at,
           revoked_at, revoke_reason, last_seen_at, user_agent, ip)
         VALUES (@id, @user_id, @refresh_hash, @created_at, @updated_at, @expires_at,
           @revoked_at, @revoke_reason, @last_seen_at, @user_agent, @ip)`,
      )
      .run(session);

    return { session, refreshToken };
  }

  findById(id: string): SessionRow | null {
    return (this.handle.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined) ?? null;
  }

  /** 按 refresh token 原文找会话（内部先哈希；库泄露也换不出令牌） */
  findByRefreshToken(token: string): SessionRow | null {
    return (
      (this.handle
        .prepare('SELECT * FROM sessions WHERE refresh_hash = ?')
        .get(hashRefreshToken(token)) as SessionRow | undefined) ?? null
    );
  }

  /**
   * 会话是否仍然有效。
   *
   * 三个条件缺一不可：未吊销、未过期、用户仍然启用。
   * **用户状态也在这里查**：账户被禁用后，它已签出的令牌必须立刻失效，
   * 否则"禁用"只是个摆设（要等令牌自然过期）。
   */
  isActive(session: SessionRow, now = new Date()): boolean {
    if (session.revoked_at !== null) return false;
    if (new Date(session.expires_at).getTime() <= now.getTime()) return false;
    const user = this.handle.prepare('SELECT status FROM users WHERE id = ?').get(session.user_id) as
      | { status: string }
      | undefined;
    if (!user || user.status !== 'active') return false;
    return true;
  }

  touch(id: string, now = new Date()): void {
    this.handle.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now.toISOString(), id);
  }

  /**
   * 轮换 refresh token（每次刷新都换新的）。
   *
   * 为什么必须轮换：refresh token 有效期长（默认 30 天），一旦泄露就是长期后门。
   * 轮换让"同一个 refresh token 只能用一次"，配合吊销可以形成简单的
   * 重放检测（第二次使用会失败，因为哈希已换）。
   */
  rotateRefresh(id: string, refreshTokenTtlSeconds: number, now = new Date()): string {
    const refreshToken = generateRefreshToken();
    const result = this.handle
      .prepare('UPDATE sessions SET refresh_hash = ?, updated_at = ?, expires_at = ?, last_seen_at = ? WHERE id = ?')
      .run(
        hashRefreshToken(refreshToken),
        now.toISOString(),
        new Date(now.getTime() + refreshTokenTtlSeconds * 1000).toISOString(),
        now.toISOString(),
        id,
      );
    if (result.changes === 0) throw new Error(`会话 ${id} 不存在`);
    return refreshToken;
  }

  /** 吊销单个会话（登出）。返回是否真的改了状态 */
  revoke(id: string, reason = 'logout', now = new Date()): boolean {
    const result = this.handle
      .prepare(
        'UPDATE sessions SET revoked_at = ?, revoke_reason = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL',
      )
      .run(now.toISOString(), reason, now.toISOString(), id);
    return result.changes > 0;
  }

  /** 吊销某用户的全部会话（改密码 / 禁用账户 / 管理员强制下线时用） */
  revokeAllForUser(userId: string, reason: string, now = new Date()): number {
    const result = this.handle
      .prepare(
        'UPDATE sessions SET revoked_at = ?, revoke_reason = ?, updated_at = ? WHERE user_id = ? AND revoked_at IS NULL',
      )
      .run(now.toISOString(), reason, now.toISOString(), userId);
    return result.changes;
  }

  /** 列出某用户的活跃会话（面板/客户端"登录设备"列表用） */
  listActive(userId: string, now = new Date()): SessionRow[] {
    return this.handle
      .prepare(
        `SELECT * FROM sessions
         WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC`,
      )
      .all(userId, now.toISOString()) as SessionRow[];
  }

  /**
   * 清理过期/已吊销的历史会话。
   *
   * 为什么要清：sessions 只增不改，长期运行会堆积。
   * 保留 7 天宽限期是为了让"最近被踢下线的设备"仍能在列表里显示原因。
   */
  prune(now = new Date(), graceDays = 7): number {
    const cutoff = new Date(now.getTime() - graceDays * 24 * 3600 * 1000).toISOString();
    const result = this.handle
      .prepare('DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ?')
      .run(cutoff, cutoff);
    return result.changes;
  }
}
