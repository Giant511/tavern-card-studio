/**
 * 单用户 → 首账户迁移（T10.3，需求 F1.4）。
 *
 * 场景：v0.1.1 及之前是**单用户**模型（一个全局 token，卡片没有归属）。
 * 升级到 v0.1.2 后账户体系上线，老数据必须"看起来没变过"——
 * 用户升级完打开客户端，卡片还在、还能上传回滚，只是背后多了一个账户。
 *
 * 三条原则：
 *
 *   1. **先备份，再动库** —— 用 SQLite 的 `VACUUM INTO` 导一份完整副本
 *      （比直接拷 `.db` 安全：WAL 模式下裸拷可能拿到不含最新事务的半成品）。
 *      备份失败就不迁移，宁可让用户手动处理，也不能拿唯一的数据赌。
 *   2. **幂等** —— 已经建过账户就什么都不做（服务是 Windows 服务，每次启动都会跑一次）。
 *   3. **可回滚** —— 迁移前记录备份路径；失败时唯一安全动作是停下并提示，
 *      不做"尽力修复"，因为半迁移状态比未迁移更难收拾。
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type Database from 'better-sqlite3';

import { hashPassword } from '../auth/password.js';
import { RepoStore } from '../storage/repos.js';
import {
  adoptOrphanCards,
  countOrphanCards,
  UserStore,
  type UserRow,
} from '../storage/users.js';

export interface MigrationPlan {
  /** 是否需要迁移（= 还没有任何账户） */
  needed: boolean;
  /** 需要接管的老卡片数 */
  orphanCards: number;
  /** 是否已经有账户（幂等判定） */
  hasUsers: boolean;
}

export interface MigrationResult {
  migrated: boolean;
  /** 迁移创建/复用的首账户 */
  user: UserRow | null;
  adoptedCards: number;
  /** 备份文件绝对路径；未迁移时为 null */
  backupPath: string | null;
  /** 仓库迁移结果（T10.6）：建了几个默认仓库、多少卡片被划进仓库 */
  repos: { created: number; cardsAssigned: number };
  message: string;
}

/**
 * 仓库迁移（T10.6）：给每个账户补默认仓库，并把无仓库归属的卡片划进去。
 *
 * 幂等且**可以单独跑**（不依赖账户迁移是否刚发生）：
 *   · v0.1.2 升级上来的库既有账户、又有 repo_id 为空的卡片；
 *   · 迁移只需要"每个账户有个默认仓库 + 卡片都落进去"这两件事成立。
 *
 * **必须在账户迁移之后调用**：没有账户就没有"给谁建仓库"。
 */
export function migrateRepos(handle: Database.Database, now = new Date().toISOString()): {
  created: number;
  cardsAssigned: number;
} {
  const users = new UserStore(handle);
  const repos = new RepoStore(handle);
  let created = 0;
  let cardsAssigned = 0;

  for (const user of users.list()) {
    // 已经有默认仓库就不重复建（幂等）；没有则建一个
    if (!repos.findDefault(user.id)) {
      repos.ensureDefault(user.id, now);
      created += 1;
    }
    const repo = repos.findDefault(user.id);
    if (!repo) continue;

    // 把该账户下"没有仓库归属"的卡片划进默认仓库。
    // 不动 updated_at：归属变更不是内容变更（会让卡片列表按"最近更新"乱跳）。
    const result = handle
      .prepare("UPDATE cards SET repo_id = ? WHERE owner_id = ? AND (repo_id IS NULL OR repo_id = '')")
      .run(repo.id, user.id);
    cardsAssigned += result.changes;
  }

  return { created, cardsAssigned };
}

/** 统计还没有仓库归属的卡片（自检信号：正常应恒为 0） */
export function countCardsWithoutRepo(handle: Database.Database): number {
  const row = handle.prepare("SELECT COUNT(*) AS n FROM cards WHERE repo_id IS NULL OR repo_id = ''").get() as {
    n: number;
  };
  return row.n;
}
export function planMigration(handle: Database.Database): MigrationPlan {
  const users = new UserStore(handle);
  const hasUsers = users.count() > 0;
  return {
    needed: !hasUsers,
    orphanCards: countOrphanCards(handle),
    hasUsers,
  };
}

/**
 * 生成备份文件名：`state.db.pre-accounts-<时间戳>.bak`。
 *
 * 放在**同目录**：用户找得到，且与库同盘 → `VACUUM INTO` 不需要跨卷写大文件。
 * 时间戳用 ISO 但把 `:` 换成 `-`（Windows 文件名不允许冒号）。
 */
export function backupPathFor(dbFile: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `${dbFile}.pre-accounts-${stamp}.bak`;
}

/**
 * 备份数据库。
 *
 * 用 `VACUUM INTO` 而不是 `copyFile`：WAL 模式下 `.db` 文件本身可能不含最新事务
 * （数据还在 `-wal` 里），裸拷会得到一个"少了几张卡"的副本——而这种副本
 * 恰恰在最需要它的时候才被发现有问题。
 *
 * `VACUUM INTO` 要求目标**不存在**，所以同秒重复调用时要换一个名字，
 * 而不是覆盖上一次的备份（覆盖等于把唯一的安全网换成可能更差的一份）。
 */
export function backupDatabase(handle: Database.Database, dbFile: string, now = new Date()): string {
  mkdirSync(dirname(dbFile), { recursive: true });

  let target = backupPathFor(dbFile, now);
  let suffix = 1;
  while (existsSync(target)) {
    target = `${backupPathFor(dbFile, now)}-${String(suffix)}`;
    suffix += 1;
  }

  // 路径里带单引号会截断 SQL 字符串字面量 —— 转义成两个单引号
  handle.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return target;
}

export interface MigrateOptions {
  /** 首账户用户名 */
  username: string;
  /** 首账户明文密码（只在内存里用一次，算完哈希即丢弃，绝不落盘/落日志） */
  password: string;
  /** 数据库文件路径（备份用） */
  dbFile: string;
  /** 注入时间，便于测试 */
  now?: Date;
}

/**
 * 执行迁移：备份 → 建首账户（admin）→ 把所有无归属卡片划给它。
 *
 * 已存在账户时直接返回 `migrated: false`（幂等）。
 * 密码策略不满足时**在建账户之前**就抛错，此时除了备份文件外没有副作用。
 */
export async function migrateToFirstAccount(
  handle: Database.Database,
  options: MigrateOptions,
): Promise<MigrationResult> {
  const now = options.now ?? new Date();
  const users = new UserStore(handle);

  const plan = planMigration(handle);
  if (!plan.needed) {
    const first = users.list()[0] ?? null;
    // 已有账户时仍然要跑仓库迁移：v0.1.2 升级上来的库既有账户、
    // 又有 repo_id 为空的卡片（T10.3 建了 owner_id 但那时还没有仓库概念）
    const repoResult = migrateRepos(handle, now.toISOString());
    return {
      migrated: false,
      user: first,
      adoptedCards: 0,
      backupPath: null,
      repos: repoResult,
      message:
        repoResult.created === 0 && repoResult.cardsAssigned === 0
          ? `已有 ${users.count()} 个账户，无需迁移`
          : `已有 ${users.count()} 个账户；仓库迁移：新建 ${repoResult.created} 个默认仓库、${repoResult.cardsAssigned} 张卡片划入仓库`,
    };
  }

  // 先算哈希：密码不合规时在这里就失败，此时还没写任何东西
  const passwordHash = await hashPassword(options.password);

  // 备份失败 -> 直接抛错，不继续。宁可迁移不做，也不能在没有备份的情况下动唯一数据
  const backupPath = backupDatabase(handle, options.dbFile, now);

  // 建账户 + 接管卡片 + 建默认仓库 + 卡片入库，全在同一个事务里：
  // 中途失败要整体回滚，否则会留下"账户建好了、卡片还没归属/没进仓库"的半迁移状态
  const runMigration = handle.transaction((): { user: UserRow; adopted: number; repos: { created: number; cardsAssigned: number } } => {
    const user = users.create({
      username: options.username,
      passwordHash,
      role: 'admin',
      status: 'active',
      now: now.toISOString(),
    });
    const adopted = adoptOrphanCards(handle, user.id);
    const repoResult = migrateRepos(handle, now.toISOString());
    return { user, adopted, repos: repoResult };
  });

  const { user, adopted, repos: repoResult } = runMigration();

  return {
    migrated: true,
    user,
    adoptedCards: adopted,
    backupPath,
    repos: repoResult,
    message:
      `已创建首账户「${user.username}」（管理员），接管 ${String(adopted)} 张历史卡片；` +
      `仓库：新建 ${String(repoResult.created)} 个默认仓库、${String(repoResult.cardsAssigned)} 张卡片入库；` +
      `原库已备份到 ${backupPath}`,
  };
}
