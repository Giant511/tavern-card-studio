/**
 * 登录失败限速（T10.4，需求 F1.2）。
 *
 * 规则：**同 IP / 同账户 5 次失败 → 锁 10 分钟**。
 *
 * 三条设计要点：
 *
 *   1. **落库而不是内存**：放内存里，服务重启（升级 MSI、崩溃自愈）就把锁清了，
 *      而重启恰恰是攻击者最想要的效果。DB 表另外让锁状态可观测、可手工解除。
 *
 *   2. **两个维度都锁**：只锁 IP 挡不住"换 IP 打同一个账户"（撞库）；只锁账户
 *      挡不住"一个 IP 撞很多账户"（撒网）。两个都记，命中任一即拒绝。
 *
 *   3. **锁定期间仍然做一次完整的密码哈希**（在调用方做，见 auth/service.ts）：
 *      否则"锁定即快速返回"会变成一个新的时间侧信道 —— 攻击者据此知道
 *      自己成功触发了锁定，进而推断账户存在。
 */

import type Database from 'better-sqlite3';

export interface RateLimitPolicy {
  /** 触发锁定所需的连续失败次数 */
  maxFailures: number;
  /** 锁定时长（毫秒） */
  lockMs: number;
  /** 失败计数的滑动窗口（毫秒）：超出窗口的失败重新从 1 计 */
  windowMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitPolicy = {
  maxFailures: 5,
  lockMs: 10 * 60 * 1000,
  windowMs: 15 * 60 * 1000,
};

export type LimitKind = 'ip' | 'account';

export interface LockState {
  locked: boolean;
  /** 距离解锁还剩多少毫秒（未锁定时为 0） */
  retryAfterMs: number;
  /** 已累计的失败次数（便于日志/面板展示） */
  failures: number;
}

interface AttemptRow {
  kind: string;
  key: string;
  failures: number;
  first_at: string;
  locked_until: string | null;
}

export class LoginLimiter {
  constructor(
    private readonly handle: Database.Database,
    private readonly policy: RateLimitPolicy = DEFAULT_RATE_LIMIT,
  ) {}

  private read(kind: LimitKind, key: string): AttemptRow | null {
    return (
      (this.handle
        .prepare('SELECT * FROM login_attempts WHERE kind = ? AND key = ?')
        .get(kind, key) as AttemptRow | undefined) ?? null
    );
  }

  /** 查某个键当前是否处于锁定中 */
  state(kind: LimitKind, key: string, now = new Date()): LockState {
    const row = this.read(kind, key);
    if (!row) return { locked: false, retryAfterMs: 0, failures: 0 };
    const lockedUntil = row.locked_until ? new Date(row.locked_until).getTime() : 0;
    if (lockedUntil > now.getTime()) {
      return { locked: true, retryAfterMs: lockedUntil - now.getTime(), failures: row.failures };
    }
    return { locked: false, retryAfterMs: 0, failures: row.failures };
  }

  /**
   * 综合判定：IP 与账户任一被锁即返回锁定状态。
   *
   * 返回 `retryAfterMs` 取两者较大值：两个锁都生效时，等短的那个解锁也没用。
   */
  check(keys: { ip: string; account: string }, now = new Date()): LockState {
    const byIp = this.state('ip', keys.ip, now);
    const byAccount = keys.account ? this.state('account', keys.account, now) : { locked: false, retryAfterMs: 0, failures: 0 };
    if (!byIp.locked && !byAccount.locked) {
      return { locked: false, retryAfterMs: 0, failures: Math.max(byIp.failures, byAccount.failures) };
    }
    return {
      locked: true,
      retryAfterMs: Math.max(byIp.retryAfterMs, byAccount.retryAfterMs),
      failures: Math.max(byIp.failures, byAccount.failures),
    };
  }

  /**
   * 记一次失败。返回记账后的锁定状态。
   *
   * 窗口语义：若上次失败距今超过 `windowMs`，视为新的一轮，计数从 1 开始。
   * 这样"每天错一次"的正常用户永远不会被锁。
   */
  recordFailure(kind: LimitKind, key: string, now = new Date()): LockState {
    if (!key) return { locked: false, retryAfterMs: 0, failures: 0 };
    const row = this.read(kind, key);
    const nowMs = now.getTime();

    let failures = 1;
    if (row) {
      const firstAt = new Date(row.first_at).getTime();
      const stillLocked = row.locked_until !== null && new Date(row.locked_until).getTime() > nowMs;
      if (stillLocked) {
        // 已锁定期间的失败不重复累加，也不延长锁定（否则攻击者可以
        // 用"持续尝试"把合法用户的锁无限续期，变成拒绝服务）
        return {
          locked: true,
          retryAfterMs: new Date(row.locked_until as string).getTime() - nowMs,
          failures: row.failures,
        };
      }
      failures = nowMs - firstAt <= this.policy.windowMs ? row.failures + 1 : 1;
    }

    const lockedUntil = failures >= this.policy.maxFailures ? nowMs + this.policy.lockMs : null;
    this.handle
      .prepare(
        `INSERT INTO login_attempts (kind, key, failures, first_at, locked_until)
         VALUES (@kind, @key, @failures, @first_at, @locked_until)
         ON CONFLICT(kind, key) DO UPDATE SET
           failures = excluded.failures,
           first_at = CASE
             WHEN excluded.failures = 1 THEN excluded.first_at
             ELSE login_attempts.first_at
           END,
           locked_until = excluded.locked_until`,
      )
      .run({
        kind,
        key,
        failures,
        // failures 回到 1 说明是新一轮，窗口起点要重置
        first_at: failures === 1 ? now.toISOString() : (row?.first_at ?? now.toISOString()),
        locked_until: lockedUntil === null ? null : new Date(lockedUntil).toISOString(),
      });

    return {
      locked: lockedUntil !== null,
      retryAfterMs: lockedUntil === null ? 0 : lockedUntil - nowMs,
      failures,
    };
  }

  /** 登录成功：清掉两个维度的失败记录 */
  clear(keys: { ip: string; account: string }): void {
    const statement = this.handle.prepare('DELETE FROM login_attempts WHERE kind = ? AND key = ?');
    statement.run('ip', keys.ip);
    if (keys.account) statement.run('account', keys.account);
  }

  /** 手工解锁（运维用：用户被锁但等不及） */
  unlock(kind: LimitKind | 'all', key: string): number {
    if (kind === 'all') {
      return this.handle.prepare('DELETE FROM login_attempts WHERE key = ?').run(key).changes;
    }
    return this.handle.prepare('DELETE FROM login_attempts WHERE kind = ? AND key = ?').run(kind, key).changes;
  }
}
