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

/**
 * 限速维度。
 *
 * `reset-ip` 是 2026-11-25 新增的第三类：临时密码重置（免鉴权端点）。
 *
 * ## 为什么不复用 `ip`
 *
 * 复用过一次，真机验证时立刻暴露两个问题：
 *
 *   1. **互相污染**：同事在同一出口 IP 上登录失败几次，正在重置密码的人
 *      就被一起锁了 —— 而他本来就是"忘了密码"的那个，这下彻底进不去。
 *   2. **失败计数被稀释**：登录失败与猜码失败混在一个桶里，两类攻击
 *      都会更快打满阈值，正常用户被误伤的概率高得多。
 *
 * 独立一类之后：爆破登录不影响重置，爆破重置不影响登录，各自 5 次阈值。
 * 表主键是 `(kind, key)`，`kind` 本来就是 TEXT，不需要迁移。
 */
export type LimitKind = 'ip' | 'account' | 'reset-ip';

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

  /**
   * 清掉单个维度的记录（`reset-ip` 这类自成一套的用途）。
   *
   * 与 `clear` 的差别：那个固定清 ip + account 两行（登录语义），
   * 而这个只动指定的那一行 —— 重置密码成功时**不该**顺手把登录的
   * 失败计数也清了（那会让"爆破登录 + 成功重置"变成绕过限速的组合）。
   */
  clearKind(kind: LimitKind, key: string): void {
    this.handle.prepare('DELETE FROM login_attempts WHERE kind = ? AND key = ?').run(kind, key);
  }

  /** 手工解锁（运维用：用户被锁但等不及） */
  unlock(kind: LimitKind | 'all', key: string): number {
    if (kind === 'all') {
      return this.handle.prepare('DELETE FROM login_attempts WHERE key = ?').run(key).changes;
    }
    return this.handle.prepare('DELETE FROM login_attempts WHERE kind = ? AND key = ?').run(kind, key).changes;
  }

  /**
   * 清掉某一维度的全部记录。
   *
   * 管理员点「解除锁定」时，IP 维度也走这里，和 CLI 同口径。IP 记录与账户名
   * 之间没有关联字段，只能全清；这是管理员动作，普通用户碰不到。
   *
   * 踩过的坑：面板只清 account 维度时，同一出口 IP 仍被锁着，用户重试还是登不上，
   * 表现就是「点了解除锁定没反应」。
   */
  unlockAllOfKind(kind: LimitKind): number {
    return this.handle.prepare('DELETE FROM login_attempts WHERE kind = ?').run(kind).changes;
  }
}
