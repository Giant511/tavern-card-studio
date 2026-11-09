/**
 * 邀请码（v0.1.7 新增，需求：邀请码注册）。
 *
 * ## 它解决的问题
 *
 * 现有的 `registerMode` 三态各有一个缺口：
 *
 * | 模式 | 缺口 |
 * |---|---|
 * | `closed` | 谁都不能自助注册，加一个人要找管理员跑命令 |
 * | `open` | 任何能访问到 API 的人都能进来 |
 * | `admin-only` | 同样要管理员动手 |
 *
 * 邀请码填的是中间那一档：**开放注册入口，但需要有码**。
 * 而且码有次数与时效上限 —— 一张码泄露的损失是有限的（最多 3 个账户、最多 15 天）。
 *
 * ## 两条不可让步的设计
 *
 * ### 1. 扣减必须原子
 *
 * "最多 3 次"如果写成"先读 used_count 再写回"，并发注册会超发 ——
 * 这不是理论问题：同一个码发到群里，几个人同时注册是常态。
 *
 * 所以扣减是一条 `UPDATE ... WHERE used_count < max_uses` 语句，
 * **判据是 `changes === 1`**（受影响行数），不是"读回来看看够不够"。
 *
 * ### 2. 扣码与建账户必须同事务
 *
 * 分开做有两种坏结果，都不可接受：
 *   · 先扣码后建账户：建账户失败（用户名撞车）⇒ 用户白丢一次机会；
 *   · 先建账户后扣码：中间崩溃 ⇒ 超发（码没用掉但账户建出来了）。
 *
 * 所以 `register()` 里用 `withTransaction` 把两者包在一起。见 `consumeAndCreate`。
 */

import { randomInt, randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

/**
 * 一张码最多注册几个账户。
 *
 * 需求原话是「一个邀请码只能支持注册3个账户」。写成常量而不是字段默认值，
 * 是因为它是**产品口径**，不是"每张码可调的参数"。
 */
export const INVITE_MAX_USES = 3;

/**
 * 有效期上限：15 天。
 *
 * 需求原话「任意时长，最大15天」。**服务端必须校验** ——
 * 只在界面上限制等于没限制：面板的请求可以被直接构造。
 *
 * 15 天 × 24 小时，按**毫秒**算，避免浮点误差。
 */
export const INVITE_MAX_VALIDITY_MS = 15 * 24 * 60 * 60 * 1000;

/**
 * 码的字母表：**去掉了容易看错的 0/O、1/I/L**。
 *
 * 与 `user-uid.ts` 同一个理由：这个码要被人念出来、手抄、发在群里。
 * 大写字形相近的问题比小写更严重（l 与 I、O 与 0），所以直接用大写字集。
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 码长：8 位 ⇒ 31^8 ≈ 8.5e11 种，配合唯一索引足够 */
const CODE_LENGTH = 8;

export interface InviteRow {
  id: string;
  /** 展示用的码（大写） */
  code: string;
  /**
   * 查询用的规范化键。
   *
   * 用户手打时可能带空格或连字符（`ABCD-EFGH`），也可能小写。
   * 用独立列而不是在 SQL 里 `UPPER(REPLACE(...))`：后者用不上索引，
   * 而这张表会随使用增长。
   */
  code_key: string;
  max_uses: number;
  used_count: number;
  /** ISO 时间；过了这个点就不能再用 */
  expires_at: string;
  /** 备注（发给谁 / 为什么发）。空串表示没写 */
  note: string;
  created_at: string;
  /** 创建者 uid（审计用；空串表示由 CLI 创建） */
  created_by: string;
  /** 作废时间；非 null 即人工失效 */
  revoked_at: string | null;
}

/** 一张码当前处于什么状态。界面与错误提示都用它，不各自判断 */
export type InviteState = 'active' | 'exhausted' | 'expired' | 'revoked';

export interface InviteView extends InviteRow {
  state: InviteState;
  /** 还能注册几次（已扣除已用） */
  remaining: number;
}

/** 把用户输入规范化成可比较的键 */
export function normalizeInviteCode(input: string): string {
  // 去掉所有空白与常见的分隔符，再统一大写。
  // 只保留字母数字 —— 避免用户粘贴时带上零宽字符（从网页复制很常见）。
  return input
    .replace(/[\s\-_]/g, '')
    .replace(/[^0-9A-Za-z]/g, '')
    .toUpperCase();
}

/** 是否是我们能生成的形态（长度 + 字母表）。用于快速拒绝明显不是码的输入 */
export function looksLikeInviteCode(normalized: string): boolean {
  if (normalized.length !== CODE_LENGTH) return false;
  for (const char of normalized) {
    if (!CODE_ALPHABET.includes(char)) return false;
  }
  return true;
}

/** 生成一个新码（不含分隔符，纯 8 位大写） */
export function generateInviteCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    // randomInt 是密码学安全的；Math.random 生成的码可被预测
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * 按当前时间算这张码的状态。
 *
 * 顺序很重要：`revoked` 优先于一切（人工作废是明确意图，不该被"已过期"掩盖），
 * 然后才是过期、用尽。这样界面上不会出现"已过期"掩盖"被管理员作废"的情况 ——
 * 用户看到"作废"才知道要去找管理员，而不是等一个不会到来的过期。
 */
export function inviteState(row: InviteRow, now: Date): InviteState {
  if (row.revoked_at !== null && row.revoked_at !== '') return 'revoked';
  if (new Date(row.expires_at).getTime() <= now.getTime()) return 'expired';
  if (row.used_count >= row.max_uses) return 'exhausted';
  return 'active';
}

export function toInviteView(row: InviteRow, now: Date): InviteView {
  return {
    ...row,
    state: inviteState(row, now),
    remaining: Math.max(0, row.max_uses - row.used_count),
  };
}

/** 生成参数 */
export interface CreateInviteInput {
  /** 有效时长（毫秒）。必须 > 0 且 <= INVITE_MAX_VALIDITY_MS */
  validityMs: number;
  note?: string;
  createdBy?: string;
}

export class InviteError extends Error {
  /**
   * 不用「构造函数参数属性」（`constructor(readonly code: ...)`）的写法。
   *
   * 那是 TS 需要**转译**的语法，而 Node 的 `--experimental-strip-types`
   * 只做类型剥离、不做转译 —— 测试直接 import 这个 .ts 时会报
   * `SyntaxError: Unexpected token ':'`。写成显式赋值，两边都能跑。
   */
  readonly code: 'INVALID_VALIDITY' | 'INVALID_CODE' | 'NOT_FOUND';

  constructor(code: 'INVALID_VALIDITY' | 'INVALID_CODE' | 'NOT_FOUND', message: string) {
    super(message);
    this.code = code;
    this.name = 'InviteError';
  }
}

export class InviteStore {
  /** 显式字段 + 赋值，不用构造函数参数属性（理由同 InviteError） */
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * 生成一张新码。
   *
   * 碰撞处理：8 位随机撞上的概率极低，但**唯一索引会抛错**。
   * 重试若干次而不是"相信不会撞" —— 唯一索引是零成本的确定性保证，
   * 而一旦撞上，用户看到的是一个 500。
   */
  create(input: CreateInviteInput, now: Date = new Date()): InviteView {
    if (!Number.isFinite(input.validityMs) || input.validityMs <= 0) {
      throw new InviteError('INVALID_VALIDITY', '有效期必须大于 0');
    }
    if (input.validityMs > INVITE_MAX_VALIDITY_MS) {
      throw new InviteError(
        'INVALID_VALIDITY',
        `有效期最长 ${String(INVITE_MAX_VALIDITY_MS / 86400000)} 天`,
      );
    }

    const expiresAt = new Date(now.getTime() + input.validityMs).toISOString();
    const insert = this.db.prepare(
      `INSERT INTO invite_codes
         (id, code, code_key, max_uses, used_count, expires_at, note, created_at, created_by, revoked_at)
       VALUES (@id, @code, @code_key, @max_uses, 0, @expires_at, @note, @created_at, @created_by, NULL)`,
    );

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = generateInviteCode();
      const row: InviteRow = {
        id: randomUUID(),
        code,
        code_key: normalizeInviteCode(code),
        max_uses: INVITE_MAX_USES,
        used_count: 0,
        expires_at: expiresAt,
        note: input.note?.trim() ?? '',
        created_at: now.toISOString(),
        created_by: input.createdBy ?? '',
        revoked_at: null,
      };
      try {
        insert.run(row);
        return toInviteView(row, now);
      } catch (error) {
        // 只有唯一索引冲突才重试；其它错误（表不存在等）必须原样抛出，
        // 否则会变成"重试 8 次然后报一个与真因无关的错"
        if (!String(error).includes('UNIQUE')) throw error;
      }
    }
    throw new InviteError('INVALID_CODE', '生成邀请码失败（连续碰撞），请重试');
  }

  list(now: Date = new Date()): InviteView[] {
    const rows = this.db
      .prepare('SELECT * FROM invite_codes ORDER BY created_at DESC')
      .all() as InviteRow[];
    return rows.map((row) => toInviteView(row, now));
  }

  findByCode(code: string): InviteRow | null {
    const key = normalizeInviteCode(code);
    if (key === '') return null;
    return (
      (this.db.prepare('SELECT * FROM invite_codes WHERE code_key = ?').get(key) as
        | InviteRow
        | undefined) ?? null
    );
  }

  findById(id: string): InviteRow | null {
    return (
      (this.db.prepare('SELECT * FROM invite_codes WHERE id = ?').get(id) as
        | InviteRow
        | undefined) ?? null
    );
  }

  /** 作废（幂等：已作废的再作废不报错，保留最早的作废时间） */
  revoke(id: string, now: Date = new Date()): InviteView | null {
    const row = this.findById(id);
    if (row === null) return null;
    if (row.revoked_at === null || row.revoked_at === '') {
      this.db
        .prepare('UPDATE invite_codes SET revoked_at = ? WHERE id = ?')
        .run(now.toISOString(), id);
      row.revoked_at = now.toISOString();
    }
    return toInviteView(row, now);
  }

  /**
   * 扣一次使用额度。**这是幂等与原子性的关键落点。**
   *
   * 返回 `true` 表示扣成功（可以继续建账户），`false` 表示这张码
   * 已用尽 / 已过期 / 已作废 / 不存在。
   *
   * ## 为什么把三个条件都写进 WHERE，而不是先查再更新
   *
   * "先 SELECT 判断再 UPDATE" 在并发下必然超发。这三个条件放在同一条
   * UPDATE 的 WHERE 里，SQLite 的单语句原子性直接给了我们正确性，
   * 判据是 `changes === 1`。
   *
   * `expires_at > @now` 用字符串比较：库里存的是 ISO 8601（定长、UTC、Z 结尾），
   * 这个格式的字典序与时间序一致，所以可以直接比。
   */
  consume(code: string, now: Date = new Date()): boolean {
    const key = normalizeInviteCode(code);
    if (key === '') return false;
    const result = this.db
      .prepare(
        `UPDATE invite_codes
            SET used_count = used_count + 1
          WHERE code_key = @key
            AND revoked_at IS NULL
            AND used_count < max_uses
            AND expires_at > @now`,
      )
      .run({ key, now: now.toISOString() });
    return result.changes === 1;
  }

  /**
   * 在一个事务里跑一段逻辑。
   *
   * 给 `AuthService.register` 用：**扣码与建账户必须同生共死**。
   * 分开做的两种坏结果见文件头注释。
   */
  withTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
