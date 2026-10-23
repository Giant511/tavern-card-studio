/**
 * v0.1.2 / T10.3：用户模型 + 密码哈希 + 单用户数据迁移。
 *
 * 这一层的测试重点是**安全硬约束**与**迁移不可逆损坏**两件事：
 *
 *   1. 密码只存 Argon2id 哈希，库里拿不到明文，也无法用错密码通过；
 *   2. 账户不存在与密码错误**耗时相当**（时序攻击防护）—— 这条只能靠实测时间差，
 *      代码里写成什么样都不算证据；
 *   3. 迁移**先备份再动库**，备份是完整的（含最新事务），且迁移幂等；
 *   4. 用户名唯一性按规范化键判定（`Alice` 与 `alice` 是同一个账户）。
 *
 * 运行：node --test test/users.test.mjs（需先 npm run build:server）
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Db } from '../server/dist/storage/db.js';
import {
  UserStore,
  UserExistsError,
  countOrphanCards,
  normalizeUsername,
  toPublicUser,
} from '../server/dist/storage/users.js';
import {
  ARGON2_PARAMS,
  PASSWORD_MIN_LENGTH,
  PasswordPolicyError,
  hashPassword,
  needsRehash,
  verifyPassword,
  verifyPasswordDummy,
} from '../server/dist/auth/password.js';
import { backupDatabase, migrateToFirstAccount, planMigration } from '../server/dist/auth/migrate.js';

let workDir;
let dbFile;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-users-'));
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** 每个用例一个独立库，避免互相污染 */
let seq = 0;
function freshDb() {
  seq += 1;
  dbFile = join(workDir, `state-${String(seq)}.db`);
  return new Db(dbFile);
}

// ── 密码哈希 ────────────────────────────────────────────────

test('T10.3 哈希是 Argon2id（不是明文、不是可逆编码）', async () => {
  const plain = 'correct horse battery staple';
  const hash = await hashPassword(plain);

  assert.match(hash, /^\$argon2id\$v=19\$/, '必须是 Argon2id：算法标识写在 PHC 串里');
  assert.equal(hash.includes(plain), false, '哈希串里不能出现明文');
  assert.equal(hash.startsWith('$argon2id$'), true);
  // 参数要写进串里，否则以后无法判断"这串是不是按当前基线算的"
  assert.match(hash, new RegExp(`m=${String(ARGON2_PARAMS.memoryCost)},t=${String(ARGON2_PARAMS.timeCost)},p=${String(ARGON2_PARAMS.parallelism)}`));
});

test('T10.3 同一密码两次哈希不同（加盐），但都能校验通过', async () => {
  const plain = 'same-password-twice';
  const a = await hashPassword(plain);
  const b = await hashPassword(plain);

  assert.notEqual(a, b, '相同明文必须得到不同哈希 —— 否则就是没加盐');
  assert.equal(await verifyPassword(a, plain), true);
  assert.equal(await verifyPassword(b, plain), true);
});

test('T10.3 错误密码一律 false；哈希串损坏也不抛异常', async () => {
  const hash = await hashPassword('right-password');
  assert.equal(await verifyPassword(hash, 'wrong-password'), false);
  assert.equal(await verifyPassword(hash, 'RIGHT-PASSWORD'), false, '密码校验必须大小写敏感');

  // 库被手改过 / 跨版本脏数据：不能把异常抛给调用方，必须当作"校验失败"
  assert.equal(await verifyPassword('not-a-hash', 'right-password'), false);
  assert.equal(await verifyPassword('', 'right-password'), false);
});

test('T10.3 密码策略：短于下限拒绝，且抛的是可识别的类型', async () => {
  await assert.rejects(() => hashPassword('short'), (error) => {
    assert.ok(error instanceof PasswordPolicyError);
    assert.match(error.message, new RegExp(String(PASSWORD_MIN_LENGTH)));
    return true;
  });
  await assert.rejects(() => hashPassword(''), /不能为空/);
  // 恰好等于下限应当通过
  const ok = await hashPassword('a'.repeat(PASSWORD_MIN_LENGTH));
  assert.equal(await verifyPassword(ok, 'a'.repeat(PASSWORD_MIN_LENGTH)), true);
});

test('T10.3 时序防护：账户不存在时的耗时与密码错误相当', async () => {
  const hash = await hashPassword('timing-test-password');

  // 各跑若干轮取中位数，避免单次抖动干扰
  const realTimes = [];
  const dummyTimes = [];
  for (let i = 0; i < 5; i += 1) {
    let t = process.hrtime.bigint();
    await verifyPassword(hash, 'definitely-wrong');
    realTimes.push(Number(process.hrtime.bigint() - t) / 1e6);

    t = process.hrtime.bigint();
    await verifyPasswordDummy();
    dummyTimes.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  const median = (list) => list.sort((x, y) => x - y)[Math.floor(list.length / 2)];
  const real = median(realTimes);
  const dummy = median(dummyTimes);

  // 判据不用"完全相同"（哈希本身有微抖动），而是"同一量级"：
  // 若账户不存在时直接 return，dummy 会是 0.x ms 而 real ~20ms，差一个数量级。
  const ratio = Math.max(real, dummy) / Math.max(0.001, Math.min(real, dummy));
  assert.ok(
    ratio < 3,
    `假校验耗时应与真校验同量级，实测 real=${real.toFixed(2)}ms dummy=${dummy.toFixed(2)}ms（比值 ${ratio.toFixed(2)}）`,
  );
  assert.ok(dummy > 1, `假校验必须真的花时间，实测 ${dummy.toFixed(2)}ms`);
});

test('T10.3 needsRehash：老参数（更小 m/t）应标记重算，当前参数不标记', async () => {
  const current = await hashPassword('rehash-test');
  assert.equal(needsRehash(current), false);

  const weak = '$argon2id$v=19$m=4096,t=1,p=1$c2FsdHNhbHRzYWx0c2FsdA$0000000000000000000000000000000000000000000';
  assert.equal(needsRehash(weak), true, 'm/t 低于基线的哈希应标记重算');

  assert.equal(needsRehash('$2b$12$abcdefghijklmnopqrstuv', true), true, '非 argon2id 一律重算');
  assert.equal(needsRehash(''), true);
});

// ── 用户仓储 ────────────────────────────────────────────────

test('T10.3 用户名唯一性按规范化键判定（Alice 与 alice 是同一账户）', async () => {
  const db = freshDb();
  try {
    const users = new UserStore(db.handle);
    const hash = await hashPassword('password-123');

    const created = users.create({ username: 'Alice', passwordHash: hash });
    assert.equal(created.username, 'Alice', '显示名保留用户输入的原始大小写');
    assert.equal(created.username_key, 'alice', '唯一性键是小写规范化');

    assert.ok(users.findByUsername('alice'), '小写也能查到');
    assert.ok(users.findByUsername('ALICE'), '大写也能查到');
    assert.ok(users.findByUsername(' Alice '), '首尾空格会被规范化掉');

    assert.throws(() => users.create({ username: 'alice', passwordHash: hash }), UserExistsError);
    assert.throws(() => users.create({ username: ' ALICE ', passwordHash: hash }), UserExistsError);
  } finally {
    db.close();
  }
});

test('T10.3 对外结构不含 password_hash', async () => {
  const db = freshDb();
  try {
    const users = new UserStore(db.handle);
    const row = users.create({ username: 'bob', passwordHash: await hashPassword('password-123') });
    const pub = toPublicUser(row);

    assert.equal('password_hash' in pub, false, 'toPublicUser 必须剔除哈希');
    assert.equal(JSON.stringify(pub).includes(row.password_hash), false, '整串序列化后也不能漏出哈希');
    assert.equal(pub.username, 'bob');
  } finally {
    db.close();
  }
});

test('T10.3 最后一个管理员不能被禁用/降级', async () => {
  const db = freshDb();
  try {
    const users = new UserStore(db.handle);
    const admin = users.create({
      username: 'root',
      passwordHash: await hashPassword('password-123'),
      role: 'admin',
    });

    assert.throws(() => users.setStatus(admin.id, 'disabled'), /最后一个启用中的管理员/);
    assert.throws(() => users.setRole(admin.id, 'user'), /最后一个启用中的管理员/);

    // 有第二个管理员后就可以禁用了
    const second = users.create({
      username: 'root2',
      passwordHash: await hashPassword('password-123'),
      role: 'admin',
    });
    users.setStatus(second.id, 'disabled');
    assert.equal(users.findById(second.id)?.status, 'disabled');
    // 但此时 root 又是唯一的启用管理员了
    assert.throws(() => users.setStatus(admin.id, 'disabled'), /最后一个启用中的管理员/);
  } finally {
    db.close();
  }
});

test('T10.3 用户名形状校验：太短、非法字符、数字开头之外的情况都被拒', async () => {
  const db = freshDb();
  try {
    const users = new UserStore(db.handle);
    const hash = await hashPassword('password-123');
    assert.throws(() => users.create({ username: 'ab', passwordHash: hash }), /3–32/);
    assert.throws(() => users.create({ username: '.abc', passwordHash: hash }), /3–32|开头/);
    assert.throws(() => users.create({ username: 'has space', passwordHash: hash }), /3–32/);
    // 合法的
    const ok = users.create({ username: 'user_01-x.y', passwordHash: hash });
    assert.equal(ok.username, 'user_01-x.y');
  } finally {
    db.close();
  }
});

test('T10.3 normalizeUsername 是幂等的', () => {
  assert.equal(normalizeUsername('  Alice  '), 'alice');
  assert.equal(normalizeUsername(normalizeUsername('  Alice  ')), 'alice');
});

// ── 迁移 ────────────────────────────────────────────────────

test('T10.3 迁移：先备份、建首账户、接管历史卡片', async () => {
  const db = freshDb();
  try {
    // 造 3 张"单用户时代"的卡片（owner_id 为空）
    const now = new Date().toISOString();
    for (const id of ['card-a', 'card-b', 'card-c']) {
      db.insertCard({
        id,
        id_source: 'legacy',
        owner_id: '',
        repo_id: '',
        name: id,
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
    }

    assert.equal(countOrphanCards(db.handle), 3);
    const plan = planMigration(db.handle);
    assert.equal(plan.needed, true);
    assert.equal(plan.orphanCards, 3);

    const result = await migrateToFirstAccount(db.handle, {
      username: 'owner',
      password: 'migrate-password-1',
      dbFile,
    });

    assert.equal(result.migrated, true);
    assert.equal(result.user?.role, 'admin', '首账户必须是管理员');
    assert.equal(result.adoptedCards, 3, '三张历史卡都要被接管');
    assert.equal(countOrphanCards(db.handle), 0);

    // 备份文件必须存在且非空
    assert.ok(result.backupPath && existsSync(result.backupPath), '必须留下备份文件');
    assert.ok(statSync(result.backupPath).size > 0, '备份文件不能是空文件');

    // 首账户能登录（密码哈希正确落库）
    const users = new UserStore(db.handle);
    const stored = users.findByUsername('owner');
    assert.ok(stored);
    assert.equal(await verifyPassword(stored.password_hash, 'migrate-password-1'), true);
    assert.equal(await verifyPassword(stored.password_hash, 'wrong'), false);
  } finally {
    db.close();
  }
});

test('T10.3 迁移幂等：再跑一次不建第二个账户、不再备份', async () => {
  const db = freshDb();
  try {
    const first = await migrateToFirstAccount(db.handle, {
      username: 'owner',
      password: 'migrate-password-1',
      dbFile,
    });
    assert.equal(first.migrated, true);
    const backupCount = existsSync(first.backupPath) ? 1 : 0;

    const second = await migrateToFirstAccount(db.handle, {
      username: 'another',
      password: 'another-password-1',
      dbFile,
    });
    assert.equal(second.migrated, false, '已有账户时不应再次迁移');
    assert.equal(second.backupPath, null, '不迁移就不该产生新备份');
    assert.equal(new UserStore(db.handle).count(), 1, '账户数必须还是 1');
    assert.equal(existsSync(first.backupPath), backupCount === 1, '原备份仍在');
  } finally {
    db.close();
  }
});

test('T10.3 迁移：密码不合规时在建账户之前失败（不留半成品）', async () => {
  const db = freshDb();
  try {
    await assert.rejects(
      () => migrateToFirstAccount(db.handle, { username: 'owner', password: 'short', dbFile }),
      PasswordPolicyError,
    );
    assert.equal(new UserStore(db.handle).count(), 0, '密码不合规不应建出账户');
    assert.equal(planMigration(db.handle).needed, true, '状态应仍是"待迁移"');
  } finally {
    db.close();
  }
});

test('T10.3 备份是完整快照：包含迁移前的全部卡片', async () => {
  const db = freshDb();
  const now = new Date().toISOString();
  const makeCard = (id) => ({
    id,
    id_source: 'client',
    owner_id: '',
    repo_id: '',
    name: id,
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
  try {
    db.insertCard(makeCard('before-1'));
    db.insertCard(makeCard('before-2'));

    // 备份必须发生在事务里写入最新数据之后也能拿到完整内容 —— 这正是
    // 用 VACUUM INTO 而不是 copyFile 的理由（WAL 模式下裸拷可能丢最新事务）
    const backup = backupDatabase(db.handle, dbFile);
    assert.ok(existsSync(backup));

    // 打开备份库核对行数
    const backupDb = new Db(backup);
    try {
      const row = backupDb.handle.prepare('SELECT COUNT(*) AS n FROM cards').get();
      assert.equal(row.n, 2, `备份里应有 2 张卡，实际 ${String(row.n)}`);
    } finally {
      backupDb.close();
    }
  } finally {
    db.close();
  }
});

test('T10.3 老库升级：没有 owner_id 列的表会被补上，历史卡标为待归属', async () => {
  // 模拟 v0.1.1 的库：cards 表没有 owner_id、没有 users 表
  // （ESM 里没有 require，用动态 import 拿 better-sqlite3）
  const { default: Database } = await import('better-sqlite3');
  const legacyFile = join(workDir, 'legacy-v011.db');
  const raw = new Database(legacyFile);
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
    INSERT INTO cards (id, name, created_at, updated_at) VALUES ('old-card', '老卡', '2026-01-01', '2026-01-01');
  `);
  raw.close();

  const db = new Db(legacyFile);
  try {
    const columns = db.handle.prepare('PRAGMA table_info(cards)').all().map((c) => c.name);
    assert.ok(columns.includes('owner_id'), '老库必须被补上 owner_id 列');
    const users = db.handle.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
    assert.ok(users, '老库必须被建出 users 表');

    assert.equal(countOrphanCards(db.handle), 1, '老卡应处于"待归属"状态');
    const plan = planMigration(db.handle);
    assert.equal(plan.needed, true);
    assert.equal(plan.orphanCards, 1);
  } finally {
    db.close();
  }
});
