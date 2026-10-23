/**
 * v0.1.2 / T10.6：仓库模型与仓库令牌。
 *
 * 需求点名的四类测试：
 *   1. 令牌哈希不反解（库里存的不是原文，且拿哈希换不出令牌）；
 *   2. 过期令牌拒绝；
 *   3. 越权范围拒绝（读令牌尝试写 → 403 判定为 false）；
 *   4. 吊销即时生效（含"重开库后仍吊销"）。
 * 另外覆盖：老库迁移（cards.repo_id 补列 + 卡片落进默认仓库）。
 *
 * 运行：node --test test/repos.test.mjs（需先 npm run build:server）
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Db } from '../server/dist/storage/db.js';
import { UserStore } from '../server/dist/storage/users.js';
import { hashPassword } from '../server/dist/auth/password.js';
import { countCardsWithoutRepo, migrateRepos, migrateToFirstAccount } from '../server/dist/auth/migrate.js';
import {
  ALL_SCOPES,
  RepoExistsError,
  RepoStore,
  TokenStore,
  checkTokenScope,
  generateRepoToken,
  hashToken,
  parseScopes,
  requiredScope,
  serializeScopes,
} from '../server/dist/storage/repos.js';

let workDir;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-repos-'));
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

let seq = 0;
function freshDb() {
  seq += 1;
  return new Db(join(workDir, `repos-${String(seq)}.db`));
}

async function makeUser(users, name = 'alice') {
  return users.create({ username: name, passwordHash: await hashPassword('password-1234') });
}

const DAY = 24 * 3600 * 1000;

// ══════════════════════════════════════════════════════════
// 1. 仓库模型
// ══════════════════════════════════════════════════════════

test('T10.6 仓库：账户内多仓库，名字在账户内唯一（大小写不敏感）', async () => {
  const db = freshDb();
  try {
    const users = new UserStore(db.handle);
    const repos = new RepoStore(db.handle);
    const alice = await makeUser(users, 'alice');
    const bob = await makeUser(users, 'bob');

    const a1 = repos.create({ ownerId: alice.id, name: 'project-a' });
    const a2 = repos.create({ ownerId: alice.id, name: 'project-b' });
    assert.notEqual(a1.id, a2.id);

    // 同账户内重名（大小写不同）→ 冲突
    assert.throws(() => repos.create({ ownerId: alice.id, name: 'PROJECT-A' }), RepoExistsError);

    // **不同账户可以同名** —— 这是"账户内唯一"的关键语义
    const b1 = repos.create({ ownerId: bob.id, name: 'project-a' });
    assert.equal(b1.name, 'project-a');
    assert.notEqual(b1.id, a1.id);
  } finally {
    db.close();
  }
});

test('T10.6 仓库：默认仓库与账户同时诞生，且幂等', async () => {
  const db = freshDb();
  try {
    const users = new UserStore(db.handle);
    const repos = new RepoStore(db.handle);
    const alice = await makeUser(users, 'alice');

    assert.equal(repos.findDefault(alice.id), null, '建账户本身不建仓库（由注册流程调用 ensureDefault）');
    const first = repos.ensureDefault(alice.id);
    assert.equal(first.is_default, 1);
    assert.equal(first.name, 'default');

    const again = repos.ensureDefault(alice.id);
    assert.equal(again.id, first.id, 'ensureDefault 必须幂等');
    assert.equal(repos.list(alice.id).length, 1);
  } finally {
    db.close();
  }
});

test('T10.6 仓库：用户已占用 default 名字时，默认仓库改名避开（不覆盖）', async () => {
  const db = freshDb();
  try {
    const users = new UserStore(db.handle);
    const repos = new RepoStore(db.handle);
    const alice = await makeUser(users, 'alice');

    repos.create({ ownerId: alice.id, name: 'default' });
    const made = repos.ensureDefault(alice.id);
    assert.notEqual(made.name.toLowerCase(), 'default', '不能抢用户已建的 default');
    assert.equal(made.is_default, 1);
    assert.equal(repos.list(alice.id).length, 2);
  } finally {
    db.close();
  }
});

test('T10.6 仓库：有卡片的仓库不能删；默认仓库不能删', async () => {
  const db = freshDb();
  try {
    const users = new UserStore(db.handle);
    const repos = new RepoStore(db.handle);
    const alice = await makeUser(users, 'alice');
    const def = repos.ensureDefault(alice.id);
    const other = repos.create({ ownerId: alice.id, name: 'other' });

    assert.throws(() => repos.remove(def.id), /默认仓库不能删除/);

    // 往 other 里塞一张卡
    const now = new Date().toISOString();
    db.insertCard({
      id: 'c1',
      id_source: 'client',
      owner_id: alice.id,
      repo_id: other.id,
      name: '卡',
      spec: 'chara_card_v2',
      spec_version: '2.0',
      creator: '',
      tags_json: '[]',
      source_filename: '',
      created_at: now,
      updated_at: now,
      deleted_at: null,
      version_count: 0,
      latest_seq: null,
      latest_commit: null,
      latest_sha256: null,
      latest_size: null,
      latest_message: null,
      latest_at: null,
      parse_warnings_json: '[]',
      audit_sha256: null,
      audit_error: null,
      audit_generated_at: null,
      audit_error_count: null,
      audit_warning_count: null,
      audit_info_count: null,
      audit_exportable: null,
    });
    assert.throws(() => repos.remove(other.id), /还有 1 张卡片/);
  } finally {
    db.close();
  }
});

test('T10.6 仓库：设为默认会取消旧的默认', async () => {
  const db = freshDb();
  try {
    const users = new UserStore(db.handle);
    const repos = new RepoStore(db.handle);
    const alice = await makeUser(users, 'alice');
    const oldDefault = repos.ensureDefault(alice.id);
    const other = repos.create({ ownerId: alice.id, name: 'other' });

    repos.setDefault(other.id);
    assert.equal(repos.findDefault(alice.id)?.id, other.id);
    assert.equal(repos.findById(oldDefault.id)?.is_default, 0, '旧默认必须被取消（不能有两个默认）');
  } finally {
    db.close();
  }
});

// ══════════════════════════════════════════════════════════
// 2. 令牌：哈希存储
// ══════════════════════════════════════════════════════════

test('T10.6 令牌：库里只存 sha256，拿哈希换不出原文', async () => {
  const db = freshDb();
  try {
    const users = new UserStore(db.handle);
    const repos = new RepoStore(db.handle);
    const tokens = new TokenStore(db.handle);
    const alice = await makeUser(users, 'alice');
    const repo = repos.ensureDefault(alice.id);

    const { row, raw } = tokens.issue({ ownerId: alice.id, repoId: repo.id, name: 't', scopes: ['read'] });

    assert.ok(raw.startsWith('tcr_'), `令牌要有可识别前缀，实际 ${raw.slice(0, 8)}`);
    assert.notEqual(row.token_hash, raw, '库里不能存原文');
    assert.equal(row.token_hash, hashToken(raw), '存的是原文的 sha256');
    assert.equal(row.token_hash.length, 64);
    // 前缀能看出是哪一把，但不足以还原
    assert.ok(raw.startsWith(row.token_prefix));
    assert.ok(row.token_prefix.length < raw.length);

    // 整行序列化后不能含原文
    assert.equal(JSON.stringify(row).includes(raw), false, '整行里不能有原文');

    // 按原文能找回，按哈希不能"反解"
    assert.equal(tokens.findByRaw(raw)?.id, row.id);
    assert.equal(tokens.findByRaw(row.token_hash), null, '拿哈希当令牌用必须无效');
  } finally {
    db.close();
  }
});

test('T10.6 令牌：原文不同 → 哈希不同（随机性）', () => {
  const a = generateRepoToken();
  const b = generateRepoToken();
  assert.notEqual(a.raw, b.raw);
  assert.notEqual(a.hash, b.hash);
  assert.equal(a.hash.length, 64);
});

test('T10.6 令牌：对外结构不含哈希', async () => {
  const db = freshDb();
  try {
    const users = new UserStore(db.handle);
    const repos = new RepoStore(db.handle);
    const tokens = new TokenStore(db.handle);
    const alice = await makeUser(users, 'alice');
    const repo = repos.ensureDefault(alice.id);
    const { row } = tokens.issue({ ownerId: alice.id, repoId: repo.id, name: 't', scopes: ['read'] });

    const pub = tokens.toPublic(row, repo.name);
    const text = JSON.stringify(pub);
    assert.equal('token_hash' in pub, false);
    assert.equal(text.includes(row.token_hash), false, '对外结构不能泄露哈希');
    // 只给前缀
    assert.equal(pub.prefix, row.token_prefix);
  } finally {
    db.close();
  }
});

test('T10.6 令牌：权限范围去重且顺序固定（便于 diff）', () => {
  assert.equal(serializeScopes(['write', 'read', 'read']), 'read,write');
  assert.equal(serializeScopes(['rollback']), 'rollback');
  assert.deepEqual(parseScopes('read,write'), ['read', 'write']);
  assert.deepEqual(parseScopes(''), []);
  // 未知值被丢弃而不是报错（库里可能来自旧版本）
  assert.deepEqual(parseScopes('read,admin'), ['read']);
});

test('T10.6 令牌：空范围/未知范围拒绝签发', async () => {
  const db = freshDb();
  try {
    const users = new UserStore(db.handle);
    const repos = new RepoStore(db.handle);
    const tokens = new TokenStore(db.handle);
    const alice = await makeUser(users, 'alice');
    const repo = repos.ensureDefault(alice.id);

    assert.throws(() => tokens.issue({ ownerId: alice.id, repoId: repo.id, name: 'x', scopes: [] }), /至少要有一个权限范围/);
    assert.throws(
      () => tokens.issue({ ownerId: alice.id, repoId: repo.id, name: 'x', scopes: ['admin'] }),
      /未知权限范围/,
    );
    assert.equal(tokens.listByOwner(alice.id).length, 0, '拒绝签发不能留下行');
  } finally {
    db.close();
  }
});

// ══════════════════════════════════════════════════════════
// 3. 权限范围：越权拒绝
// ══════════════════════════════════════════════════════════

test('T10.6 越权：读令牌尝试写 → 拒绝（需求点名的用例）', () => {
  const readOnly = { scopes: 'read' };
  const write = checkTokenScope(readOnly, 'write');
  assert.equal(write.allowed, false);
  assert.equal(write.missing, 'write');
  assert.match(write.reason, /缺少 write 权限/);

  // 读操作允许
  assert.equal(checkTokenScope(readOnly, 'read').allowed, true);
});

test('T10.6 越权：读写令牌不能回滚；rollback 必须显式授予', () => {
  const rw = { scopes: 'read,write' };
  assert.equal(checkTokenScope(rw, 'read').allowed, true);
  assert.equal(checkTokenScope(rw, 'write').allowed, true);
  const rb = checkTokenScope(rw, 'rollback');
  assert.equal(rb.allowed, false);
  assert.equal(rb.missing, 'rollback');

  const full = { scopes: 'read,write,rollback' };
  assert.equal(checkTokenScope(full, 'rollback').allowed, true);
});

test('T10.6 越权：delete 归到 write（三档之外的映射有单一来源）', () => {
  assert.equal(requiredScope('delete'), 'write');
  assert.equal(requiredScope('read'), 'read');
  assert.equal(requiredScope('write'), 'write');
  assert.equal(requiredScope('rollback'), 'rollback');

  // 只读令牌不能删
  assert.equal(checkTokenScope({ scopes: 'read' }, 'delete').allowed, false);
  // 读写令牌可以删
  assert.equal(checkTokenScope({ scopes: 'read,write' }, 'delete').allowed, true);
});

test('T10.6 越权：权限判定是逐次执行的（改小范围立刻影响下一次判定）', async () => {
  const db = freshDb();
  try {
    const users = new UserStore(db.handle);
    const repos = new RepoStore(db.handle);
    const tokens = new TokenStore(db.handle);
    const alice = await makeUser(users, 'alice');
    const repo = repos.ensureDefault(alice.id);
    const { row } = tokens.issue({ ownerId: alice.id, repoId: repo.id, name: 't', scopes: ['read', 'write'] });

    assert.equal(checkTokenScope(tokens.findById(row.id), 'write').allowed, true);

    tokens.setScopes(row.id, ['read']);
    // 每次判定都从库里读当前 scopes —— 不需要等过期、也不需要重签
    assert.equal(checkTokenScope(tokens.findById(row.id), 'write').allowed, false);
  } finally {
    db.close();
  }
});

// ══════════════════════════════════════════════════════════
// 4. 过期与吊销
// ══════════════════════════════════════════════════════════

test('T10.6 过期：过期令牌被拒（isUsable / checkTokenScope 双路径）', async () => {
  const db = freshDb();
  try {
    const users = new UserStore(db.handle);
    const repos = new RepoStore(db.handle);
    const tokens = new TokenStore(db.handle);
    const alice = await makeUser(users, 'alice');
    const repo = repos.ensureDefault(alice.id);

    const now = new Date('2027-01-01T00:00:00.000Z');
    const { row } = tokens.issue({
      ownerId: alice.id,
      repoId: repo.id,
      name: 'short',
      scopes: ['read'],
      expiresAt: new Date(now.getTime() + DAY).toISOString(),
      now: now.toISOString(),
    });

    // 未过期
    assert.equal(tokens.isUsable(row, now), true);
    assert.equal(checkTokenScope(row, 'read', now).allowed, true);

    // 过期后（同一行，不重新签）
    const later = new Date(now.getTime() + 2 * DAY);
    assert.equal(tokens.isUsable(row, later), false);
    const expired = checkTokenScope(row, 'read', later);
    assert.equal(expired.allowed, false);
    assert.match(expired.reason, /已过期/);
  } finally {
    db.close();
  }
});

test('T10.6 过期：expiresAt 为 null 表示永不过期', async () => {
  const db = freshDb();
  try {
    const users = new UserStore(db.handle);
    const repos = new RepoStore(db.handle);
    const tokens = new TokenStore(db.handle);
    const alice = await makeUser(users, 'alice');
    const repo = repos.ensureDefault(alice.id);
    const { row } = tokens.issue({ ownerId: alice.id, repoId: repo.id, name: 'forever', scopes: ['read'] });

    const farFuture = new Date('2099-01-01T00:00:00.000Z');
    assert.equal(tokens.isUsable(row, farFuture), true);
  } finally {
    db.close();
  }
});

test('T10.6 吊销：吊销后立即失效，且落库（重开库仍吊销）', async () => {
  const file = join(workDir, 'revoke.db');
  const db = new Db(file);
  let tokenId;
  let raw;
  try {
    const users = new UserStore(db.handle);
    const repos = new RepoStore(db.handle);
    const tokens = new TokenStore(db.handle);
    const alice = await makeUser(users, 'alice');
    const repo = repos.ensureDefault(alice.id);
    const issued = tokens.issue({ ownerId: alice.id, repoId: repo.id, name: 't', scopes: ['read'] });
    tokenId = issued.row.id;
    raw = issued.raw;

    assert.equal(tokens.isUsable(issued.row), true);
    const changed = tokens.revoke(tokenId);
    assert.equal(changed, true);
    assert.equal(tokens.revoke(tokenId), false, '重复吊销应返回 false（幂等）');

    const revoked = tokens.findById(tokenId);
    assert.equal(tokens.isUsable(revoked), false);
    assert.equal(checkTokenScope(revoked, 'read').allowed, false);
    assert.match(checkTokenScope(revoked, 'read').reason, /已被吊销/);
  } finally {
    db.close();
  }

  // 重开库（等价于服务重启）
  const reopened = new Db(file);
  try {
    const tokens = new TokenStore(reopened.handle);
    const row = tokens.findById(tokenId);
    assert.ok(row, '吊销是标记不是删除，行必须还在');
    assert.notEqual(row.revoked_at, null, '吊销状态必须落库');
    assert.equal(tokens.isUsable(row), false, '重启后旧令牌不能复活');
    // 按原文能找回同一行（比 id 而不是整个对象：assert.equal 比的是引用，
    // 两个不同时刻查出来的行对象必然不相等）
    assert.equal(tokens.findByRaw(raw)?.id, row.id);
    assert.equal(tokens.findByRaw(raw)?.token_hash, row.token_hash);
  } finally {
    reopened.close();
  }
});

// ══════════════════════════════════════════════════════════
// 5. 老库迁移
// ══════════════════════════════════════════════════════════

test('T10.6 迁移：老库补 repo_id 列，卡片划进默认仓库', async () => {
  const file = join(workDir, 'legacy.db');
  // 造一个 v0.1.1 的库：cards 表没有 owner_id / repo_id / users / repos
  const { default: Database } = await import('better-sqlite3');
  const raw = new Database(file);
  raw.exec(`
    CREATE TABLE cards (
      id TEXT PRIMARY KEY, id_source TEXT NOT NULL DEFAULT 'legacy', name TEXT NOT NULL,
      spec TEXT NOT NULL DEFAULT '', spec_version TEXT NOT NULL DEFAULT '', creator TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]', source_filename TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
      version_count INTEGER NOT NULL DEFAULT 0, latest_seq INTEGER, latest_commit TEXT,
      latest_sha256 TEXT, latest_size INTEGER, latest_message TEXT, latest_at TEXT,
      parse_warnings_json TEXT NOT NULL DEFAULT '[]', audit_sha256 TEXT, audit_error TEXT,
      audit_generated_at TEXT, audit_error_count INTEGER, audit_warning_count INTEGER,
      audit_info_count INTEGER, audit_exportable INTEGER
    );
    INSERT INTO cards (id, name, created_at, updated_at) VALUES ('old-1', '老卡一', '2026-01-01', '2026-01-01');
    INSERT INTO cards (id, name, created_at, updated_at) VALUES ('old-2', '老卡二', '2026-01-01', '2026-01-01');
  `);
  raw.close();

  const db = new Db(file);
  try {
    const columns = db.handle.prepare('PRAGMA table_info(cards)').all().map((c) => c.name);
    assert.ok(columns.includes('repo_id'), '老库必须被补上 repo_id 列');

    const users = new UserStore(db.handle);
    const repos = new RepoStore(db.handle);

    // 迁移：建首账户 → 卡片归账户 → 建默认仓库 → 卡片入库
    const result = await migrateToFirstAccount(db.handle, {
      username: 'owner',
      password: 'migrate-password-1',
      dbFile: file,
      now: new Date('2026-10-23T00:00:00.000Z'),
    });
    assert.equal(result.migrated, true);
    assert.equal(result.adoptedCards, 2);
    assert.equal(result.repos.created, 1, '首账户应有 1 个默认仓库');
    assert.equal(result.repos.cardsAssigned, 2, '两张老卡都要落进默认仓库');
    assert.equal(countCardsWithoutRepo(db.handle), 0);

    const owner = users.findByUsername('owner');
    const def = repos.findDefault(owner.id);
    assert.ok(def, '默认仓库必须存在');
    assert.equal(repos.countCards(def.id), 2);
  } finally {
    db.close();
  }
});

test('T10.6 迁移：已有账户时单独跑仓库迁移（幂等）', async () => {
  const db = freshDb();
  try {
    const users = new UserStore(db.handle);
    const repos = new RepoStore(db.handle);
    const alice = await makeUser(users, 'alice');

    // 模拟"T10.3 已迁移、但还没有仓库"的中间状态：账户在、卡片归属在、repo_id 空
    const now = new Date().toISOString();
    for (const id of ['a-1', 'a-2']) {
      db.insertCard({
        id,
        id_source: 'client',
        owner_id: alice.id,
        repo_id: '',
        name: id,
        spec: '',
        spec_version: '',
        creator: '',
        tags_json: '[]',
        source_filename: '',
        created_at: now,
        updated_at: now,
        deleted_at: null,
        version_count: 0,
        latest_seq: null,
        latest_commit: null,
        latest_sha256: null,
        latest_size: null,
        latest_message: null,
        latest_at: null,
        parse_warnings_json: '[]',
        audit_sha256: null,
        audit_error: null,
        audit_generated_at: null,
        audit_error_count: null,
        audit_warning_count: null,
        audit_info_count: null,
        audit_exportable: null,
      });
    }
    assert.equal(countCardsWithoutRepo(db.handle), 2);

    const first = migrateRepos(db.handle, now);
    assert.equal(first.created, 1);
    assert.equal(first.cardsAssigned, 2);
    assert.equal(countCardsWithoutRepo(db.handle), 0);

    // 幂等：再跑什么都不做
    const second = migrateRepos(db.handle, now);
    assert.equal(second.created, 0);
    assert.equal(second.cardsAssigned, 0);
    assert.equal(repos.list(alice.id).length, 1, '不能重复建默认仓库');
  } finally {
    db.close();
  }
});

test('T10.6 迁移：无账户时仓库迁移不做事（不建孤儿仓库）', () => {
  const db = freshDb();
  try {
    const result = migrateRepos(db.handle);
    assert.equal(result.created, 0);
    assert.equal(result.cardsAssigned, 0);
  } finally {
    db.close();
  }
});

// ══════════════════════════════════════════════════════════
// 6. 常量与边界
// ══════════════════════════════════════════════════════════

test('T10.6 范围常量与需求一致（读/写/回滚三档）', () => {
  assert.deepEqual([...ALL_SCOPES], ['read', 'write', 'rollback']);
});

test('T10.6 令牌原始格式可被扫描器识别（tcr_ 前缀 + 足够熵）', () => {
  const { raw } = generateRepoToken();
  assert.match(raw, /^tcr_[A-Za-z0-9_-]{40,}$/, '前缀固定 + base64url 主体，便于密钥扫描');
});
