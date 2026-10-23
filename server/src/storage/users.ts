/**
 * 用户与卡片归属（T10.3）。
 *
 * 这是「账户 → 仓库 → 角色卡」三级模型（需求 F2.1）的**地基**：先有账户，
 * 卡片才能有归属。仓库模型在 T10.6，这里只做账户 + 卡片归属两件事。
 *
 * 设计要点：
 *
 *   1. **用户名唯一但不区分大小写** —— 库里存 `username`（原样，用于显示）
 *      与 `username_key`（小写规范化，唯一索引）。只把 `username` 设成唯一
 *      会让 `Alice` 和 `alice` 变成两个账户，注册时间隔一天谁也发现不了，
 *      直到两边都以为自己有某张卡。规范化键才是唯一边界。
 *
 *   2. **`cards.owner_id` 用 ALTER 补列，默认指向首账户** —— 迁移前的卡片
 *      天然归第一个账户（单用户时代的唯一主人），不需要逐行回填脚本。
 *      但**不能**把默认值写成空串：那样"没有归属"和"归错了"无法区分。
 *
 *   3. **软禁用而不是删除** —— 账户删了，卡片的 `owner_id` 就悬空。禁用保留
 *      审计线索（谁曾经传过这张卡），符合"历史只增不改"的整体取向。
 */

import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

export type UserRole = 'admin' | 'user';
export type UserStatus = 'active' | 'disabled';

export interface UserRow {
  id: string;
  /** 显示用原名（保留用户输入的大小写） */
  username: string;
  /** 唯一性边界：小写规范化后的用户名 */
  username_key: string;
  /** Argon2id 哈希串（`$argon2id$v=19$m=…$salt$hash`）；**永不**存明文 */
  password_hash: string;
  role: UserRole;
  status: UserStatus;
  created_at: string;
  updated_at: string;
  /** 最后一次成功登录的时间（T10.4 写入；迁移出来的账户为迁移时间） */
  last_login_at: string | null;
}

/** 对外暴露的用户信息（去掉哈希，防止顺手把整行丢进响应体） */
export interface PublicUser {
  id: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

/** 用户名规范化：唯一性与查询都用它，避免大小写/首尾空格造成"同名不同人" */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export class UserExistsError extends Error {
  constructor(username: string) {
    super(`用户名「${username}」已被占用`);
    this.name = 'UserExistsError';
  }
}

export class UserNotFoundError extends Error {
  constructor(needle: string) {
    super(`用户「${needle}」不存在`);
    this.name = 'UserNotFoundError';
  }
}

/** 用户名规则：长度 3–32，字母数字下划线连字符点，必须以字母或数字开头 */
const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$/;

export function assertUsernameShape(username: string): void {
  if (!USERNAME_PATTERN.test(username.trim())) {
    throw new Error('用户名需 3–32 个字符，字母或数字开头，可用字母、数字、下划线、连字符、点');
  }
}

export class UserStore {
  constructor(private readonly handle: Database.Database) {}

  /** 账户总数（迁移判定用：0 表示还没建过账户） */
  count(): number {
    const row = this.handle.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    return row.n;
  }

  /** 是否存在管理员（防止把所有管理员都禁用后无法恢复） */
  countAdmins(): number {
    const row = this.handle
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'")
      .get() as { n: number };
    return row.n;
  }

  create(input: {
    username: string;
    passwordHash: string;
    role?: UserRole;
    status?: UserStatus;
    id?: string;
    now?: string;
  }): UserRow {
    const username = input.username.trim();
    assertUsernameShape(username);
    const key = normalizeUsername(username);
    const now = input.now ?? new Date().toISOString();

    if (this.findByUsernameKey(key)) throw new UserExistsError(username);

    const row: UserRow = {
      id: input.id ?? randomUUID(),
      username,
      username_key: key,
      password_hash: input.passwordHash,
      role: input.role ?? 'user',
      status: input.status ?? 'active',
      created_at: now,
      updated_at: now,
      last_login_at: null,
    };

    this.handle
      .prepare(
        `INSERT INTO users (id, username, username_key, password_hash, role, status, created_at, updated_at, last_login_at)
         VALUES (@id, @username, @username_key, @password_hash, @role, @status, @created_at, @updated_at, @last_login_at)`,
      )
      .run(row);

    return row;
  }

  findById(id: string): UserRow | null {
    return (this.handle.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined) ?? null;
  }

  /** 按用户名查（大小写不敏感：走规范化键，不是 `username` 列） */
  findByUsername(username: string): UserRow | null {
    return this.findByUsernameKey(normalizeUsername(username));
  }

  findByUsernameKey(key: string): UserRow | null {
    return (
      (this.handle.prepare('SELECT * FROM users WHERE username_key = ?').get(key) as UserRow | undefined) ?? null
    );
  }

  list(): UserRow[] {
    return this.handle.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as UserRow[];
  }

  /** 改密码。`passwordHash` 必须是已经算好的 Argon2id 串 */
  setPassword(id: string, passwordHash: string, now = new Date().toISOString()): void {
    const result = this.handle
      .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(passwordHash, now, id);
    if (result.changes === 0) throw new UserNotFoundError(id);
  }

  setStatus(id: string, status: UserStatus, now = new Date().toISOString()): void {
    const user = this.findById(id);
    if (!user) throw new UserNotFoundError(id);
    // 禁用一个管理员前确认还剩别的管理员，否则面板再也进不去
    if (status === 'disabled' && user.role === 'admin' && user.status === 'active' && this.countAdmins() <= 1) {
      throw new Error('这是最后一个启用中的管理员，禁用后将无法再管理服务端');
    }
    this.handle.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
  }

  setRole(id: string, role: UserRole, now = new Date().toISOString()): void {
    const user = this.findById(id);
    if (!user) throw new UserNotFoundError(id);
    if (role === 'user' && user.role === 'admin' && this.countAdmins() <= 1) {
      throw new Error('这是最后一个启用中的管理员，降级后将无法再管理服务端');
    }
    this.handle.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(role, now, id);
  }

  markLogin(id: string, now = new Date().toISOString()): void {
    this.handle.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, id);
  }
}

// ── 卡片归属 ────────────────────────────────────────────────

/**
 * 统计「还没有归属」的卡片数。
 *
 * 迁移会把它们一次性归给首账户；运行期正常情况下应当恒为 0
 * （新建卡都会带上当前账户）。持续大于 0 说明有代码路径漏了写入 owner_id，
 * 所以这个计数也是**自检信号**，不只是一个迁移用的临时值。
 */
export function countOrphanCards(handle: Database.Database): number {
  const row = handle.prepare("SELECT COUNT(*) AS n FROM cards WHERE owner_id IS NULL OR owner_id = ''").get() as {
    n: number;
  };
  return row.n;
}

/**
 * 把无归属的卡片全部划给某个账户，返回改动行数。
 *
 * **不动 `updated_at`**：归属变更不是内容变更。若顺手刷新了它，
 * 卡片列表会按"最近更新"重排，用户看到一堆自己没动过的卡跳到最前面。
 */
/**
 * 把无归属的卡片全部划给某个账户。
 *
 * `repoId` 给了就顺手把卡片也归进该仓库。**为什么必须一起给**：T10.8 起
 * 账户的可见范围是 `owner_id`，而仓库令牌还叠加 `repo_id`。只填 owner 不填 repo
 * 会得到一种尴尬的中间态 —— 卡片在账户列表里可见（标着「未归属仓库」），
 * 但用仓库令牌一个都看不到。归属和入库位置本来就是同一件事的两面。
 */
export function adoptOrphanCards(
  handle: Database.Database,
  ownerId: string,
  options: { repoId?: string | null } = {},
): number {
  const repoId = options.repoId ?? null;
  const sql =
    repoId === null
      ? "UPDATE cards SET owner_id = ? WHERE owner_id IS NULL OR owner_id = ''"
      : "UPDATE cards SET owner_id = ?, repo_id = CASE WHEN repo_id IS NULL OR repo_id = '' THEN ? ELSE repo_id END WHERE owner_id IS NULL OR owner_id = ''";
  const result =
    repoId === null
      ? handle.prepare(sql).run(ownerId)
      : handle.prepare(sql).run(ownerId, repoId);
  return result.changes;
}

/** 某个账户名下的卡片数 */
export function countCardsOf(handle: Database.Database, ownerId: string): number {
  const row = handle.prepare('SELECT COUNT(*) AS n FROM cards WHERE owner_id = ?').get(ownerId) as { n: number };
  return row.n;
}
