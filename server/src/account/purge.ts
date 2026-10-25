/**
 * 账户注销：**物理清除**（v0.1.3 / F3）。
 *
 * ## 为什么这是一个独立模块而不是塞进某个 Store
 *
 * 注销要跨 7 张表 + 两个文件系统区域（git 仓库目录、内容块目录），
 * 而现有 Store 各自只懂自己那张表。散在路由里写一遍 `DELETE FROM ...` 的问题是：
 * **漏一张表不会有任何报错**，只会在某天审计里发现"账户删了但卡片还在"。
 * 所以这里把清单集中成一处，并用测试逐表断言（`test/account-purge.test.mjs`）。
 *
 * ## 顺序是有讲究的，不能随便调
 *
 *   1. 保护规则（最后管理员 / 管理员不能删自己）—— **先判，再动**
 *   2. 收集要删的东西（卡片 id、每张卡的 blob sha）
 *   3. 吊销该用户全部会话（需求 5）—— 必须在删数据**之前**，
 *      否则中间那一刻并发请求仍能用旧 refresh 换出新 access
 *   4. 删 git 仓库目录（文件系统，失败只记账不阻断）
 *   5. **一个事务**删掉 7 张表里的行
 *   6. 事务提交后清无引用的内容块（引用计数必须在 versions 删完之后才算）
 *   7. 写审计事件（此时 users 行已不在，但事件表没有外键，owner_id 仍写原值）
 *
 * 第 5 步用事务、第 4/6 步在事务外的理由：文件系统不会因为 SQL 回滚而恢复，
 * 反过来 SQL 也不会因为文件删失败而回滚。硬凑成一个"全有全无"是做不到的，
 * 所以分工明确：SQL 部分原子，文件部分尽力而为且留痕。
 *
 * ## 保护规则的两条边界（需求 4）
 *
 *   · **最后一名管理员不可注销** —— 不管走哪条路径。否则服务端再也没人能管。
 *   · **管理员不能注销自己** —— 只限**管理员路径**（治理页）。
 *     用户自助注销本来就是自己删自己，而且要求输入用户名 + 密码二次确认，
 *     那是明确意图而非手滑；不能因为这人恰好是管理员就剥夺他注销自己账户的权利。
 *     这个区分写进决策表 #138。
 */

import type Database from 'better-sqlite3';

import type { BlobStore } from '../storage/blobs.js';
import type { Db } from '../storage/db.js';
import type { GitStore } from '../storage/git-store.js';
import type { LoginLimiter } from '../auth/login-limit.js';
import type { SessionStore } from '../auth/sessions.js';
import type { UserStore } from '../storage/users.js';
import { normalizeUsername } from '../storage/users.js';

/** 注销路径：自助 / 管理员 */
export type PurgePath = 'self' | 'admin';

export interface PurgeAccountInput {
  /** 目标账户的内部 id（不是 uid） */
  targetUserId: string;
  /** 操作者内部 id。自助路径 = 目标自己 */
  actorUserId: string;
  /** 写入审计事件的操作者标识，如 `alice (usr_xxxx)` 或 `admin (usr_yyyy)` */
  actorLabel: string;
  path: PurgePath;
  ip?: string | null;
  now?: () => Date;
}

export interface PurgeCounts {
  cards: number;
  versions: number;
  repos: number;
  repoTokens: number;
  sessions: number;
  loginAttempts: number;
  blobs: number;
  gitRepos: number;
}

export interface PurgeAccountResult {
  /** 被注销账户的内部 id（已不存在，仅用于回执与审计对照） */
  userId: string;
  /** 对外不变标识 —— 注销后同名重注册会拿到**新的** uid */
  uid: string;
  username: string;
  path: PurgePath;
  counts: PurgeCounts;
  /** 文件系统里删不掉的目录（尽力而为，返回给调用方记日志） */
  warnings: string[];
}

export class PurgeError extends Error {
  readonly code: 'NOT_FOUND' | 'LAST_ADMIN' | 'SELF_AS_ADMIN';
  readonly status: number;

  constructor(code: PurgeError['code'], message: string, status = 400) {
    super(message);
    this.name = 'PurgeError';
    this.code = code;
    this.status = status;
  }
}

export interface PurgeAccountDeps {
  db: Db;
  users: UserStore;
  sessions: SessionStore;
  limiter: LoginLimiter;
  git: GitStore;
  blobs: BlobStore;
  logger?: { warn: (action: string, detail?: Record<string, unknown>) => void };
}

/**
 * 注销一个账户（物理清除）。
 *
 * 调用方必须已经完成**身份确认**（自助 = 密码或用户名二次确认；管理员 = 管理员 JWT）。
 * 这里只做业务规则与数据清除，不碰 HTTP。
 */
export function purgeAccount(input: PurgeAccountInput, deps: PurgeAccountDeps): PurgeAccountResult {
  const now = input.now?.() ?? new Date();
  const at = now.toISOString();

  // ── 1. 保护规则 ─────────────────────────────────────────
  const target = deps.users.findById(input.targetUserId);
  if (target === null) {
    // 内部错误码；HTTP 层决定对外文案（管理员路径已是特权上下文，可以直接说 404）
    throw new PurgeError('NOT_FOUND', '账户不存在', 404);
  }

  if (input.path === 'admin' && input.targetUserId === input.actorUserId) {
    /*
     * 只挡管理员路径。理由见文件头：自助注销自己是有二次确认的明确意图，
     * 而治理页那一列每行都长得一样，手滑点到自己的行太容易。
     */
    throw new PurgeError(
      'SELF_AS_ADMIN',
      '管理员不能在这里注销自己：请到「设置 → 账户」用自助注销（需要二次确认）',
      403,
    );
  }

  if (target.role === 'admin' && target.status === 'active' && deps.users.countAdmins() <= 1) {
    // 403 而不是 400：这是"规则不允许"，与"请求写错了"是两回事。
    // 客户端据此显示成权限类提示，而不是"请检查你的输入"。
    throw new PurgeError('LAST_ADMIN', '这是最后一个启用中的管理员，注销后将没有人能管理服务端', 403);
  }

  // ── 2. 收集要删的东西 ───────────────────────────────────
  //
  // 直接查 SQL 而不是走 `listCards`：那个接口带分页（limit/offset），
  // 而"注销"必须一次拿全 —— 分页漏掉的那部分会变成"账户删了但卡片还在"，
  // 且不报错。这里 `includeDeleted` 的语义同样重要：回收站里的卡也是这个人的数据。
  const cardIds = (
    deps.db.handle.prepare('SELECT id FROM cards WHERE owner_id = ?').all(target.id) as Array<{ id: string }>
  ).map((row) => row.id);

  /** 每张卡的全部 blob（prune 过的版本 blob_sha256 为空串，跳过） */
  const blobShas = new Set<string>();
  let versionCount = 0;
  for (const cardId of cardIds) {
    for (const version of deps.db.listVersions(cardId, { limit: 1_000_000 })) {
      versionCount += 1;
      if (version.blob_sha256 !== '') blobShas.add(version.blob_sha256);
    }
  }

  const repoRows = deps.db.handle
    .prepare('SELECT id FROM repos WHERE owner_id = ?')
    .all(target.id) as Array<{ id: string }>;
  const tokenCount = (
    deps.db.handle.prepare('SELECT COUNT(*) AS n FROM repo_tokens WHERE owner_id = ?').get(target.id) as { n: number }
  ).n;
  const sessionCount = (
    deps.db.handle.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(target.id) as { n: number }
  ).n;

  // ── 3. 先吊销全部会话（需求 5）──────────────────────────
  //
  // 这一步在删行之前，是为了让"注销进行中"的那几十毫秒里，
  // 并发请求拿旧 refresh 也换不出新 access。删行本身也能达到同样效果，
  // 但那要等到事务提交；这一步把窗口压到最小。
  const revoked = deps.sessions.revokeAllForUser(target.id, 'account-purged', now);

  // ── 4. 删 git 仓库目录 ──────────────────────────────────
  const warnings: string[] = [];
  let gitRepos = 0;
  for (const cardId of cardIds) {
    try {
      deps.git.removeRepo(cardId);
      gitRepos += 1;
    } catch (error) {
      // 文件被占用（Windows 上很常见：用户还开着那个目录）不该让整个注销失败 ——
      // 但必须记下来，否则就成了"说是删了其实还在磁盘上"。
      warnings.push(`git 仓库 ${cardId} 删除失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── 5. 一个事务删掉 7 张表里的行 ────────────────────────
  const usernameKey = normalizeUsername(target.username);

  const counts = deps.db.handle.transaction((): PurgeCounts => {
    const removed = {
      cards: 0,
      versions: 0,
      repos: 0,
      repoTokens: 0,
      sessions: 0,
      loginAttempts: 0,
      blobs: 0,
      gitRepos,
    } as PurgeCounts;

    // 先删版本再删卡：versions 按 card_id 关联，反过来删会留下孤儿版本
    // （schema 没有外键级联，全靠这里手动配对）
    if (cardIds.length > 0) {
      const placeholders = cardIds.map(() => '?').join(',');
      removed.versions = deps.db.handle
        .prepare(`DELETE FROM versions WHERE card_id IN (${placeholders})`)
        .run(...cardIds).changes;
    }
    // 卡片按 owner_id 删，而不是按 cardIds：后者来自 listCards 的分页结果，
    // 一旦分页参数写错就会漏（分页是这里唯一可能"看起来删完其实没删完"的地方）
    removed.cards = deps.db.handle.prepare('DELETE FROM cards WHERE owner_id = ?').run(target.id).changes;

    removed.repoTokens = deps.db
      .handle.prepare('DELETE FROM repo_tokens WHERE owner_id = ?')
      .run(target.id).changes;
    removed.repos = deps.db.handle.prepare('DELETE FROM repos WHERE owner_id = ?').run(target.id).changes;
    removed.sessions = deps.db.handle.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id).changes;
    // 登录失败计数按**用户名**存（kind='account'）。不清的话会留下一个副作用：
    // 同名重注册后仍带着旧的失败计数，甚至还在锁定期里。
    removed.loginAttempts = deps.db.handle
      .prepare("DELETE FROM login_attempts WHERE kind = 'account' AND key = ?")
      .run(usernameKey).changes;

    deps.db.handle.prepare('DELETE FROM users WHERE id = ?').run(target.id);
    return removed;
  })();

  // ── 6. 清无引用的内容块 ─────────────────────────────────
  //
  // 必须在 versions 删完之后算引用：blob 按内容去重，同一份字节可能被
  // **别的账户**的卡共用。删之前查一次引用计数，0 才删。
  let blobs = 0;
  for (const sha of blobShas) {
    if (deps.db.countVersionsUsingBlob(sha) === 0 && deps.blobs.remove(sha)) blobs += 1;
  }
  counts.blobs = blobs;

  // ── 7. 审计事件 ────────────────────────────────────────
  //
  // 用户行已经删了，但 events 没有外键 —— owner_id 仍写原值，
  // 于是"这个人曾经存在过、在什么时候被谁注销"是可查的。
  // 这也是需求 3「审计日志保留 90 天」能成立的前提：审计不能跟着数据一起消失。
  //
  // card_id 刻意留空：注销不针对某一张卡，填一个卡的 id 会让治理页的
  // 「按卡查看」出现一条莫名其妙的记录。
  deps.db.appendEvent({
    at,
    level: 'warn',
    action: input.path === 'admin' ? 'account.purge.admin' : 'account.purge.self',
    cardId: null,
    detail: {
      targetUserId: target.id,
      targetUid: target.uid,
      targetUsername: target.username,
      targetRole: target.role,
      path: input.path,
      counts: {
        cards: counts.cards,
        versions: counts.versions,
        repos: counts.repos,
        repoTokens: counts.repoTokens,
        sessions: counts.sessions,
        loginAttempts: counts.loginAttempts,
        blobs: counts.blobs,
        gitRepos: counts.gitRepos,
      },
      // 吊销数与最终删除数分开记：二者不等说明期间有并发登录
      sessionsRevoked: revoked,
      sessionCountBefore: sessionCount,
      repoCountBefore: repoRows.length,
      tokenCountBefore: tokenCount,
      versionCountBefore: versionCount,
      warnings: warnings.length,
    },
    ownerId: target.id,
    actor: input.actorLabel,
    ip: input.ip ?? null,
  });

  if (warnings.length > 0) {
    deps.logger?.warn('account.purge.warnings', { userId: target.id, warnings });
  }

  return {
    userId: target.id,
    uid: target.uid,
    username: target.username,
    path: input.path,
    counts,
    warnings,
  };
}

/**
 * 审计事件的保留期（天）。
 *
 * 需求 3 说「审计日志保留 90 天」。这个常量是**唯一**的口径来源：
 * 清理函数与治理页文案都从这里取，避免"代码里 90、文档里 180"。
 */
export const AUDIT_RETENTION_DAYS = 90;

/**
 * 清理超过保留期的审计事件。
 *
 * ## 为什么"保留 90 天"需要一段代码
 *
 * events 表原本没有任何清理机制（永远增长）。注销功能把这个矛盾摊开了：
 * 一方面审计**必须**活得比账户久（否则"谁注销了它"就无从追溯），
 * 另一方面无限增长迟早把库撑大。90 天是需求给的平衡点。
 *
 * ## 判据与时区
 *
 * 按 ISO 字符串比较（`at < 边界`）。events.at 一直是 `toISOString()` 写的
 * UTC `...Z` 格式，字符串序与时序一致 —— 但**只在格式统一时成立**。
 * 所以这里额外断言边界也用同一种格式，不用本地时间拼。
 *
 * @returns 删除的条数
 */
export function pruneAuditEvents(
  handle: Database.Database,
  options: { days?: number; now?: Date } = {},
): number {
  const days = options.days ?? AUDIT_RETENTION_DAYS;
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`保留天数必须是正数，实际 ${String(days)}`);
  }
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  return handle.prepare('DELETE FROM events WHERE at < ?').run(cutoff).changes;
}
