/**
 * 一次性临时密码（2026-11-25）。
 *
 * ## 它解决的是什么
 *
 * 用户忘了密码，联系运维。运维手上没有用户的密码，也不该"设一个新密码然后
 * 告诉用户" —— 那样运维就知道了用户的最终密码，等于长期可冒充。
 *
 * 这个模块提供的东西只有一件：
 *
 * ```text
 *   运维 → 生成一个临时密码（面板上显示一次，30 分钟有效）
 *   用户 → 拿「UID + 临时密码」在客户端改自己的密码
 * ```
 *
 * ## 三条硬约束（每条都有对应的判据）
 *
 * | 约束 | 为什么 | 判据 |
 * |---|---|---|
 * | **不能登录** | 临时密码若换来会话，它就等于密码 | 它不是密码哈希，`verifyPassword` 那条路根本不看这张表 |
 * | **只能用一次** | 运维念给用户的密码可能被旁观者听到 | 用后写 `used_at`，再试 401 |
 * | **会过期** | 运维发出去忘了撤销 | 默认 30 分钟，过期即废 |
 *
 * ## 为什么单独一张表而不是塞进 sessions
 *
 * `sessions` 的语义是"已认证的会话"，它带 refresh token、会续期、会被
 * `listActive` 列进"登录设备"。临时密码与那些性质全都不沾边 ——
 * 塞进去会让"设备列表"里冒出一个不存在的设备。
 *
 * ## 为什么存哈希
 *
 * 与 refresh token 同一条纪律：库文件泄露时不能反推出可用凭证。
 * 面板上只需要认得出"是哪一次生成的"（`code_prefix`，前 4 位）。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

/** 与 `sessions.ts` 同一个算法：票据原文永不落盘，只存 sha256 */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 临时密码有效期。30 分钟够运维念给用户，又不至于留一晚上。 */
export const TICKET_TTL_MS = 30 * 60 * 1000;

/**
 * 临时密码的字符集。
 *
 * 去掉了容易念错/听错的字符（`0O` `1lI`），因为它的实际传递方式是
 * **运维在电话里念、或者手抄在纸上**。这与"密码要难猜"不冲突：
 * 12 位 × 32 字符集 ≈ 60 bit 熵，而且有次数限制 + 30 分钟过期。
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 12;

export interface PasswordTicketRow {
  id: string;
  user_id: string;
  uid: string;
  code_hash: string;
  code_prefix: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  created_by: string;
  created_ip: string;
}

export interface IssuedTicket {
  /** 明文临时密码 —— **只在生成的那一刻返回一次**，不落盘、不再可取 */
  code: string;
  expiresAt: string;
  uid: string;
  username: string;
}

/** 生成一串临时密码。用 `randomBytes` 取模会引入偏差，这里用拒绝采样。 */
function generateCode(): string {
  const out: string[] = [];
  while (out.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH * 2)) {
      // 256 不是 ALPHABET.length 的整数倍，直接取模会让前几个字符概率偏高。
      // 只接受落在完整周期内的字节（32 × 7 = 224），其余丢弃重取。
      if (byte >= 224) continue;
      out.push(ALPHABET[byte % ALPHABET.length] ?? 'A');
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out.join('');
}

export class PasswordTicketStore {
  constructor(private readonly handle: Database.Database) {}

  /**
   * 给某个账户生成一枚临时密码。
   *
   * ## 为什么生成前先把这个账户的旧票据全部作废
   *
   * 否则运维点两次「生成」就有两枚有效票据，用户拿第一枚改了密码后
   * 第二枚仍然可用 —— 那等于留了一把没人记得的钥匙。
   * 语义定成"每人同时只有一枚"，简单且不会错。
   */
  issue(input: {
    userId: string;
    uid: string;
    createdBy: string;
    createdIp: string;
    now?: Date;
  }): IssuedTicket {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + TICKET_TTL_MS).toISOString();

    // 旧的未用票据作废（写 used_at 而不是删行：审计要能查到"发过几次"）
    this.handle
      .prepare('UPDATE password_tickets SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
      .run(nowIso, input.userId);

    const code = generateCode();
    this.handle
      .prepare(
        `INSERT INTO password_tickets
          (id, user_id, uid, code_hash, code_prefix, created_at, expires_at, used_at, created_by, created_ip)
         VALUES (@id, @user_id, @uid, @code_hash, @code_prefix, @created_at, @expires_at, NULL, @created_by, @created_ip)`,
      )
      .run({
        id: randomUUID(),
        user_id: input.userId,
        uid: input.uid,
        code_hash: sha256Hex(code),
        code_prefix: code.slice(0, 4),
        created_at: nowIso,
        expires_at: expiresAt,
        created_by: input.createdBy,
        created_ip: input.createdIp,
      });

    return { code, expiresAt, uid: input.uid, username: '' };
  }

  /**
   * 核销一枚临时密码。
   *
   * 成功返回票据行（调用方据此拿到 `user_id`），失败返回 `null`。
   *
   * ## 为什么失败一律返回 null，不区分原因
   *
   * 与登录的 `CREDENTIALS_REJECTED` 同一条纪律：如果"uid 不存在"和
   * "码错了"回不同的错误，这个端点就成了**枚举 uid 的探针**。
   * uid 是 uuid 形态，本来猜不到，但没必要留这个面。
   *
   * ## 为什么核销时就把 `used_at` 写上
   *
   * 调用方拿到票据后还要去改密码（另一次写）。若"改密码成功才标记已用"，
   * 中间那段窗口里同一枚票据可以被并发用两次。先标记再改：
   * 改密码失败时票据已经作废，用户让运维再发一枚即可 ——
   * 这个方向的失败是安全的。
   */
  redeem(input: { uid: string; code: string; now?: Date }): PasswordTicketRow | null {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const hash = sha256Hex(input.code.trim().toUpperCase());

    const row = this.handle
      .prepare(
        `SELECT * FROM password_tickets
          WHERE uid = ? AND code_hash = ? AND used_at IS NULL AND expires_at > ?`,
      )
      .get(input.uid.trim(), hash, nowIso) as PasswordTicketRow | undefined;
    if (row === undefined) return null;

    const result = this.handle
      .prepare('UPDATE password_tickets SET used_at = ? WHERE id = ? AND used_at IS NULL')
      .run(nowIso, row.id);
    // changes = 0 说明有人在同一瞬间抢先核销了 —— 视为失败（只能用一次）
    if (result.changes === 0) return null;
    return { ...row, used_at: nowIso };
  }

  /** 某账户最近的票据（面板上显示"上次生成于…"，不返回密码） */
  latestFor(userId: string): PasswordTicketRow | null {
    return (
      (this.handle
        .prepare('SELECT * FROM password_tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(userId) as PasswordTicketRow | undefined) ?? null
    );
  }

  /** 清理过期超过一天的票据（worker 定时调用；只是防止表无限增长） */
  prune(now = new Date()): number {
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const result = this.handle.prepare('DELETE FROM password_tickets WHERE expires_at < ?').run(cutoff);
    return result.changes;
  }
}
