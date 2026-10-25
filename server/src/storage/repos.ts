/**
 * 仓库与仓库令牌（T10.6，需求 F2）。
 *
 * 层级：**账户 → 仓库（多个）→ 角色卡（不限）**。
 *
 * 三层设计要点：
 *
 *   1. **仓库名在账户内唯一，不是全局唯一** —— 两个人都想有个叫 `default` 的仓库
 *      是最自然的事，全局唯一会逼用户起 `zhangsan-default` 这种名字。
 *      唯一索引建在 `(owner_id, name_key)` 上。
 *
 *   2. **卡片必须属于仓库**（`cards.repo_id`）。老库里没有这一列，
 *      迁移时全部归到该账户的默认仓库 —— 这样"升级后卡片还在原处"成立，
 *      用户不需要理解仓库就能继续用。
 *
 *   3. **令牌哈希不存原文**（sha256）。令牌只在创建时完整返回一次，
 *      之后连服务端也无法还原 —— 与密码同理：能反解的凭证等于没有保护。
 *
 * 与"权限校验在服务端逐请求执行"的关系：令牌里存的是权限**范围**，
 * 每次请求都从库里读当前范围再判，而不是信任签发时的快照。
 * 原因：范围可以被管理员改小或令牌被吊销，若只看令牌内嵌的声明，
 * 改权限要等到令牌过期才生效 —— 那等于不能改。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { validateRepoName } from '@tcs/shared';
import type Database from 'better-sqlite3';

/** 令牌权限范围（需求 F2.3） */
export type TokenScope = 'read' | 'write' | 'rollback';

export const ALL_SCOPES: readonly TokenScope[] = ['read', 'write', 'rollback'];

export interface RepoRow {
  id: string;
  owner_id: string;
  /** 显示名（保留用户输入的大小写） */
  name: string;
  /** 唯一性边界：小写规范化后的名字 */
  name_key: string;
  description: string;
  created_at: string;
  updated_at: string;
  /** 是否默认仓库：新卡未指定仓库时落到这里 */
  is_default: number;
  deleted_at: string | null;
}

export interface RepoTokenRow {
  id: string;
  owner_id: string;
  repo_id: string;
  /** 给人看的标签，如「CI 上传用」 */
  name: string;
  /** token 的 sha256（十六进制）。**永不**存原文 */
  token_hash: string;
  /** 展示用前缀（如 `tcr_ab12`），便于用户在列表里认出是哪一把 */
  token_prefix: string;
  /** 逗号分隔的权限范围 */
  scopes: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}

export interface PublicRepo {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  cardCount: number;
}

export interface PublicToken {
  id: string;
  name: string;
  repoId: string;
  repoName: string;
  /** 只给前缀，永远不下发完整令牌 */
  prefix: string;
  scopes: TokenScope[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** 是否已过期（按当前时间算） */
  expired: boolean;
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * 令牌原文格式：`tcr_` + 32 字节 base64url。
 *
 * 前缀 `tcr_`（tavern card repo）有两个作用：
 *   ① 让人一眼看出这是本项目的仓库令牌，不是别的服务的；
 *   ② 给密钥扫描器一个稳定的模式（熵扫描与 GitHub 的 push protection 都靠这个）。
 */
export function generateRepoToken(): { raw: string; hash: string; prefix: string } {
  const raw = `tcr_${randomBytes(32).toString('base64url')}`;
  return { raw, hash: hashToken(raw), prefix: raw.slice(0, 12) };
}

/**
 * 仓库名的规范形态与唯一性键。
 *
 * **校验逻辑已搬到 `@tcs/shared` 的 `validateRepoName`**（v0.1.3 / F1）：
 * 客户端的输入框与服务端必须用同一份规则，否则会出现"能填进去却保存不了"。
 * 这里只保留两个薄包装，避免整个代码库的调用点都改签名。
 */
export function normalizeRepoName(name: string): string {
  return name.trim().toLowerCase();
}

/** 校验失败时抛错（保持 v0.1.2 的调用契约：调用方 try/catch 后转 400） */
export function assertRepoNameShape(name: string): void {
  const check = validateRepoName(name);
  if (!check.ok) throw new Error(check.message ?? '仓库名不合法');
}

export class RepoExistsError extends Error {
  constructor(name: string) {
    super(`仓库名「${name}」在本账户下已存在`);
    this.name = 'RepoExistsError';
  }
}

export class RepoNotFoundError extends Error {
  constructor(id: string) {
    super(`仓库「${id}」不存在`);
    this.name = 'RepoNotFoundError';
  }
}

export class RepoStore {
  constructor(private readonly handle: Database.Database) {}

  create(input: {
    ownerId: string;
    name: string;
    description?: string;
    isDefault?: boolean;
    id?: string;
    now?: string;
  }): RepoRow {
    /*
     * 先校验**原始输入**，再落库。
     *
     * v0.1.2 这里写的是 `const name = input.name.trim(); assertRepoNameShape(name)` ——
     * 先 trim 就永远看不到首尾空白，于是「仓库名首尾不能有空白」这条规则
     * 在**创建**路径上等于不存在（只有 rename 才真的拒绝）。
     * 同一个缺陷还有第二个后果：库里存的名字与用户输入的不同，
     * 而仓库名是之后上传时要用来指定目标的东西 —— 差一个空格就找不到。
     */
    assertRepoNameShape(input.name);
    const name = input.name;
    const key = normalizeRepoName(name);
    const now = input.now ?? new Date().toISOString();

    if (this.findByOwnerAndName(input.ownerId, name)) throw new RepoExistsError(name);

    const row: RepoRow = {
      id: input.id ?? randomUUID(),
      owner_id: input.ownerId,
      name,
      name_key: key,
      description: input.description ?? '',
      created_at: now,
      updated_at: now,
      is_default: input.isDefault ? 1 : 0,
      deleted_at: null,
    };

    this.handle
      .prepare(
        `INSERT INTO repos (id, owner_id, name, name_key, description, created_at, updated_at, is_default, deleted_at)
         VALUES (@id, @owner_id, @name, @name_key, @description, @created_at, @updated_at, @is_default, @deleted_at)`,
      )
      .run(row);

    return row;
  }

  findById(id: string): RepoRow | null {
    const row = this.handle.prepare('SELECT * FROM repos WHERE id = ?').get(id) as RepoRow | undefined;
    return row && row.deleted_at === null ? row : null;
  }

  /** 按账户 + 名字查（大小写不敏感：走 name_key） */
  findByOwnerAndName(ownerId: string, name: string): RepoRow | null {
    const row = this.handle
      .prepare('SELECT * FROM repos WHERE owner_id = ? AND name_key = ? AND deleted_at IS NULL')
      .get(ownerId, normalizeRepoName(name)) as RepoRow | undefined;
    return row ?? null;
  }

  /** 账户的默认仓库（不存在时返回 null；`ensureDefault` 会建） */
  findDefault(ownerId: string): RepoRow | null {
    const row = this.handle
      .prepare('SELECT * FROM repos WHERE owner_id = ? AND is_default = 1 AND deleted_at IS NULL')
      .get(ownerId) as RepoRow | undefined;
    return row ?? null;
  }

  /**
   * 确保账户有默认仓库（新用户注册、老库迁移都走它）。
   *
   * 幂等：已有默认仓库就返回它。**不改名、不改 id** —— 用户可能已经在用。
   */
  ensureDefault(ownerId: string, now = new Date().toISOString()): RepoRow {
    const existing = this.findDefault(ownerId);
    if (existing) return existing;

    // 名字冲突时的退路：用户可能自己建了一个叫 default 的普通仓库
    let name = 'default';
    let suffix = 1;
    while (this.findByOwnerAndName(ownerId, name)) {
      suffix += 1;
      name = `default-${String(suffix)}`;
    }
    return this.create({ ownerId, name, description: '默认仓库（未指定仓库的卡片会落到这里）', isDefault: true, now });
  }

  list(ownerId: string): RepoRow[] {
    return this.handle
      .prepare('SELECT * FROM repos WHERE owner_id = ? AND deleted_at IS NULL ORDER BY is_default DESC, created_at ASC')
      .all(ownerId) as RepoRow[];
  }

  /**
   * 全站仓库（F13 / T10.20 治理页）。
   *
   * 只在管理员显式 `?all=true` 时用。返回带 `owner_id`，让治理页能显示归属 ——
   * 没有归属列的话，管理员看到一堆同名 `default` 根本分不清是谁的。
   */
  listAll(): RepoRow[] {
    return this.handle
      .prepare('SELECT * FROM repos WHERE deleted_at IS NULL ORDER BY owner_id ASC, is_default DESC, created_at ASC')
      .all() as RepoRow[];
  }

  countCards(repoId: string): number {
    const row = this.handle
      .prepare('SELECT COUNT(*) AS n FROM cards WHERE repo_id = ? AND deleted_at IS NULL')
      .get(repoId) as { n: number };
    return row.n;
  }

  rename(id: string, name: string, now = new Date().toISOString()): void {
    const repo = this.findById(id);
    if (!repo) throw new RepoNotFoundError(id);
    assertRepoNameShape(name);
    const key = normalizeRepoName(name);
    const clash = this.findByOwnerAndName(repo.owner_id, name);
    if (clash && clash.id !== id) throw new RepoExistsError(name);
    this.handle.prepare('UPDATE repos SET name = ?, name_key = ?, updated_at = ? WHERE id = ?').run(name.trim(), key, now, id);
  }

  /**
   * 软删仓库。**有卡片时拒绝** —— 删仓库会把卡片一起变孤儿，
   * 用户此时更需要的是"先把卡移走"，而不是一个静默的级联删除。
   */
  remove(id: string, now = new Date().toISOString()): void {
    const repo = this.findById(id);
    if (!repo) throw new RepoNotFoundError(id);
    if (repo.is_default === 1) throw new Error('默认仓库不能删除：把别的仓库设为默认后再试');
    const cards = this.countCards(id);
    if (cards > 0) throw new Error(`仓库里还有 ${String(cards)} 张卡片，请先移走或删除它们`);
    this.handle.prepare('UPDATE repos SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
  }

  /**
   * 带转移的仓库删除（F13.4 / T10.19）。
   *
   * 语义：空仓库直接删；非空仓库**必须**指定 `transferTo`，卡片批量转移后删除，
   * **整个过程一个事务** —— 中途失败时不能留下"卡片已移走、仓库还在"或反过来
   * 的半截状态（那会让用户两边都找不到自己的卡）。
   *
   * 三个必须一起处理的边角：
   *   1. 回收站里的卡片也要一起转移：它们仍指向旧 repo_id，仓库删了就变成
   *      指向一个不存在的仓库（恢复时才炸）。所以按 repo_id 全量 UPDATE，
   *      不加 `deleted_at IS NULL` 条件。
   *   2. 绑定到该仓库的令牌必须吊销：留着等于给一把"打开已不存在仓库"的钥匙，
   *      而仓库 id 万一被复用（不会，但别依赖这个）就是越权。
   *   3. 默认仓库不给删 —— 调用方应改用 `setDefault` 把它换掉。
   */
  removeWithTransfer(
    id: string,
    transferTo: string | null,
    now = new Date().toISOString(),
  ): { movedCards: number; revokedTokens: number } {
    const repo = this.findById(id);
    if (!repo) throw new RepoNotFoundError(id);
    if (repo.is_default === 1) {
      throw new Error('默认仓库不能删除：先把别的仓库设为默认（转移默认），再删这个');
    }

    const cardCount = this.countCards(id);
    if (cardCount > 0 && transferTo === null) {
      throw new Error(`仓库里还有 ${String(cardCount)} 张卡片，删除时必须指定目标仓库（transferTo）`);
    }
    if (transferTo !== null && transferTo === id) {
      throw new Error('目标仓库不能是它自己');
    }

    if (transferTo !== null) {
      const target = this.findById(transferTo);
      if (!target) throw new RepoNotFoundError(transferTo);
      if (target.owner_id !== repo.owner_id) {
        throw new Error('只能转移到同一个账户下的仓库');
      }
    }

    const tx = this.handle.transaction(() => {
      let movedCards = 0;
      if (transferTo !== null) {
        // 不加 deleted_at 条件：回收站里的卡也必须跟着走，否则恢复后指向死仓库
        const result = this.handle
          .prepare('UPDATE cards SET repo_id = ? WHERE repo_id = ?')
          .run(transferTo, id);
        movedCards = result.changes;
      }
      const revoked = this.handle
        .prepare(
          `UPDATE repo_tokens SET revoked_at = ?, revoke_reason = ?
            WHERE repo_id = ? AND revoked_at IS NULL`,
        )
        .run(now, '仓库已删除', id);
      this.handle.prepare('UPDATE repos SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
      return { movedCards, revokedTokens: revoked.changes };
    });
    return tx();
  }

  setDefault(id: string, now = new Date().toISOString()): void {
    const repo = this.findById(id);
    if (!repo) throw new RepoNotFoundError(id);
    this.handle
      .prepare('UPDATE repos SET is_default = 0, updated_at = ? WHERE owner_id = ? AND is_default = 1')
      .run(now, repo.owner_id);
    this.handle.prepare('UPDATE repos SET is_default = 1, updated_at = ? WHERE id = ?').run(now, id);
  }

  toPublic(repo: RepoRow): PublicRepo {
    return {
      id: repo.id,
      name: repo.name,
      description: repo.description,
      isDefault: repo.is_default === 1,
      createdAt: repo.created_at,
      updatedAt: repo.updated_at,
      cardCount: this.countCards(repo.id),
    };
  }
}

// ── 令牌 ────────────────────────────────────────────────────

export function parseScopes(value: string): TokenScope[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item): item is TokenScope => (ALL_SCOPES as readonly string[]).includes(item));
}

export function serializeScopes(scopes: readonly TokenScope[]): string {
  // 去重 + 按固定顺序输出：便于 diff 与"同一组权限"的字符串比较
  return ALL_SCOPES.filter((scope) => scopes.includes(scope)).join(',');
}

export class TokenStore {
  constructor(private readonly handle: Database.Database) {}

  /**
   * 签发令牌。**返回原文一次**，之后只能查到前缀与哈希。
   *
   * 调用方必须把 `raw` 直接返回给用户，不要落日志 —— 落了日志等于
   * 令牌长期存在磁盘上，而"只显示一次"的设计就失效了。
   */
  issue(input: {
    ownerId: string;
    repoId: string;
    name: string;
    scopes: readonly TokenScope[];
    expiresAt?: string | null;
    now?: string;
    id?: string;
  }): { row: RepoTokenRow; raw: string } {
    if (input.scopes.length === 0) throw new Error('令牌至少要有一个权限范围');
    for (const scope of input.scopes) {
      if (!(ALL_SCOPES as readonly string[]).includes(scope)) throw new Error(`未知权限范围：${scope}`);
    }

    const now = input.now ?? new Date().toISOString();
    const { raw, hash, prefix } = generateRepoToken();

    const row: RepoTokenRow = {
      id: input.id ?? randomUUID(),
      owner_id: input.ownerId,
      repo_id: input.repoId,
      name: input.name.trim() === '' ? '未命名令牌' : input.name.trim(),
      token_hash: hash,
      token_prefix: prefix,
      scopes: serializeScopes(input.scopes),
      created_at: now,
      expires_at: input.expiresAt ?? null,
      last_used_at: null,
      revoked_at: null,
      revoke_reason: null,
    };

    this.handle
      .prepare(
        `INSERT INTO repo_tokens (id, owner_id, repo_id, name, token_hash, token_prefix, scopes,
           created_at, expires_at, last_used_at, revoked_at, revoke_reason)
         VALUES (@id, @owner_id, @repo_id, @name, @token_hash, @token_prefix, @scopes,
           @created_at, @expires_at, @last_used_at, @revoked_at, @revoke_reason)`,
      )
      .run(row);

    return { row, raw };
  }

  /** 按原文找令牌（内部哈希后查；库泄露也换不出可用令牌） */
  findByRaw(raw: string): RepoTokenRow | null {
    if (typeof raw !== 'string' || !raw.startsWith('tcr_')) return null;
    return (
      (this.handle.prepare('SELECT * FROM repo_tokens WHERE token_hash = ?').get(hashToken(raw)) as
        | RepoTokenRow
        | undefined) ?? null
    );
  }

  findById(id: string): RepoTokenRow | null {
    return (
      (this.handle.prepare('SELECT * FROM repo_tokens WHERE id = ?').get(id) as RepoTokenRow | undefined) ?? null
    );
  }

  listByOwner(ownerId: string): RepoTokenRow[] {
    return this.handle
      .prepare('SELECT * FROM repo_tokens WHERE owner_id = ? ORDER BY created_at DESC')
      .all(ownerId) as RepoTokenRow[];
  }

  listByRepo(repoId: string): RepoTokenRow[] {
    return this.handle
      .prepare('SELECT * FROM repo_tokens WHERE repo_id = ? ORDER BY created_at DESC')
      .all(repoId) as RepoTokenRow[];
  }

  /** 是否已过期（`expiresAt` 为 null 表示永不过期） */
  isExpired(row: RepoTokenRow, now = new Date()): boolean {
    if (row.expires_at === null) return false;
    return new Date(row.expires_at).getTime() <= now.getTime();
  }

  isRevoked(row: RepoTokenRow): boolean {
    return row.revoked_at !== null;
  }

  /** 可用 = 未吊销 + 未过期 */
  isUsable(row: RepoTokenRow, now = new Date()): boolean {
    return !this.isRevoked(row) && !this.isExpired(row, now);
  }

  /**
   * 吊销令牌。返回是否真的改了状态（已吊销的再吊销返回 false）。
   *
   * **落库不落内存**：与 session 同理，服务重启不能把吊销状态清掉。
   */
  revoke(id: string, reason = 'manual', now = new Date().toISOString()): boolean {
    const result = this.handle
      .prepare(
        'UPDATE repo_tokens SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL',
      )
      .run(now, reason, id);
    return result.changes > 0;
  }

  touch(id: string, now = new Date().toISOString()): void {
    this.handle.prepare('UPDATE repo_tokens SET last_used_at = ? WHERE id = ?').run(now, id);
  }

  /**
   * 改权限范围（管理员收窄授权）。
   *
   * 这是"权限校验逐请求执行"能成立的前提：改小之后下一次请求就按新范围判，
   * 不需要等令牌过期、也不需要重新签发。
   */
  setScopes(id: string, scopes: readonly TokenScope[]): void {
    if (scopes.length === 0) throw new Error('令牌至少要有一个权限范围');
    for (const scope of scopes) {
      if (!(ALL_SCOPES as readonly string[]).includes(scope)) throw new Error(`未知权限范围：${scope}`);
    }
    const result = this.handle.prepare('UPDATE repo_tokens SET scopes = ? WHERE id = ?').run(serializeScopes(scopes), id);
    if (result.changes === 0) throw new Error(`令牌 ${id} 不存在`);
  }

  toPublic(row: RepoTokenRow, repoName: string, now = new Date()): PublicToken {
    return {
      id: row.id,
      name: row.name,
      repoId: row.repo_id,
      repoName,
      prefix: row.token_prefix,
      scopes: parseScopes(row.scopes),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
      expired: this.isExpired(row, now),
    };
  }
}

// ── 权限判定 ────────────────────────────────────────────────

/**
 * 某个操作需要什么权限范围。
 *
 * 映射刻意**单一来源**：HTTP 路由与测试都从这里取，避免"某处判 write、
 * 某处判 rollback"这种散落的口径分歧。
 */
export type Operation = 'read' | 'write' | 'rollback' | 'delete';

export function requiredScope(operation: Operation): TokenScope {
  // delete 归到 write：需求只定义了三档，而"删除卡片"属于写操作的一种。
  // 单独开一档会让现有的三档令牌在删除时全部失效，收益不抵成本。
  return operation === 'delete' ? 'write' : operation;
}

export interface PermissionResult {
  allowed: boolean;
  reason: string;
  /** 缺哪个范围（allowed=false 时有用） */
  missing: TokenScope | null;
}

/**
 * 判断令牌是否覆盖某个操作（纯函数，便于测）。
 *
 * 只要求传入令牌状态的最小集（不是整个 RepoTokenRow）：调用方在
 * 身份解析阶段已经验证过吊销/过期，这里只判范围，不必再查一次库。
 */
export interface TokenStateLike {
  revoked_at?: string | null;
  expires_at?: string | null;
  scopes: string;
}

export function checkTokenScope(row: TokenStateLike, operation: Operation, now = new Date()): PermissionResult {
  // 注意 `undefined` 与 `null` 的区别：
  //   undefined → 调用方**已经**验证过这一项（如身份解析阶段查过库），不必重复判
  //   null      → 明确表示"未吊销 / 未设过期"
  // 用 `!== null` 会把 undefined 也当成"有值"进到 new Date(undefined)，
  // 那是上一版的 bug（编译期就被抓到了）。
  if (row.revoked_at !== null && row.revoked_at !== undefined) {
    return { allowed: false, reason: '令牌已被吊销', missing: null };
  }
  if (row.expires_at !== null && row.expires_at !== undefined) {
    if (new Date(row.expires_at).getTime() <= now.getTime()) {
      return { allowed: false, reason: '令牌已过期', missing: null };
    }
  }
  const need = requiredScope(operation);
  const have = parseScopes(row.scopes);
  if (!have.includes(need)) {
    return { allowed: false, reason: `令牌缺少 ${need} 权限（当前范围：${have.join(',') || '无'}）`, missing: need };
  }
  return { allowed: true, reason: '', missing: null };
}
