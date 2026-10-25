/**
 * v0.1.3 / F2：用户 uid 补列 + 治理页归属双维度。
 *
 * 断言集中在四件事：
 *   1. **新库**：注册即分到 uid，形态合法，重复注册各不相同；
 *   2. **老库迁移**：没有 uid 列的库启动后，既有用户全部补号，且**各不相同**
 *      （这条最容易写错：默认值给个固定串，所有老账户会共用一个 uid）；
 *   3. **uid 不可变**：改名 / 改密码 / 改状态 / 改角色都不动 uid；
 *   4. **API 含 uid**：`/api/auth/me`、`/control/accounts`、`/api/repos?all=true`
 *      都要带 uid；仓库的归属还要带 ownerUsername，供治理页显示「用户名（uid）」。
 *
 * 迁移用例怎么造"没有 uid 列的老库"：用 raw `better-sqlite3` 建一张 v0.1.2 形状的
 * users 表并塞两行，再用 `new Db(path)` 打开 —— `Db` 构造函数里的 ensureColumn +
 * backfillUserUids 就是被测对象。不能拿 `Db` 建库再删列（SQLite 删列限制多）。
 *
 * 运行：node --test test/user-uid.test.mjs（需先 npm run build:server）
 */

import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { after, before, describe, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Db } from '../server/dist/storage/db.js';
import { UserStore, toPublicUser } from '../server/dist/storage/users.js';
import { USER_UID_PATTERN, backfillUserUids, generateUserUid } from '../server/dist/storage/user-uid.js';

const workDirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'tcs-uid-'));
  workDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

// ── 1. uid 生成 ──────────────────────────────────────────

describe('generateUserUid', () => {
  test('形态是 usr_ + 8 位（无易混字符 0/1/o/l）', () => {
    for (let index = 0; index < 200; index += 1) {
      const uid = generateUserUid();
      assert.match(uid, USER_UID_PATTERN, `异常形态：${uid}`);
      assert.ok(!/[01ol]/.test(uid.slice(4)), `含易混字符：${uid}`);
      assert.equal([...uid].length, 12, 'usr_ + 8 应是 12 个码点');
    }
  });

  test('批量生成不重复（碰撞靠唯一索引兜底，但随机段不该肉眼可见地撞）', () => {
    const seen = new Set();
    for (let index = 0; index < 2000; index += 1) seen.add(generateUserUid());
    assert.equal(seen.size, 2000, '2000 次生成出现重复，随机段强度不足');
  });
});

// ── 2. 新库：注册即分号 ───────────────────────────────────

describe('新库：注册生成 uid', () => {
  let dir = '';
  let db = null;
  let users = null;

  before(() => {
    dir = tempDir();
    db = new Db(join(dir, 'state.db'));
    users = new UserStore(db.handle);
  });

  after(() => {
    try {
      db?.close?.();
    } catch {
      /* 忽略 */
    }
  });

  test('create 写入 uid，且 toPublicUser 带出去', () => {
    const row = users.create({ username: 'alice', passwordHash: 'x' });
    assert.match(row.uid, USER_UID_PATTERN);
    const pub = toPublicUser(row);
    assert.equal(pub.uid, row.uid);
  });

  test('uid 与内部 id 不是同一个东西（不互相可推）', () => {
    const row = users.create({ username: 'bob', passwordHash: 'x' });
    assert.notEqual(row.uid, row.id);
    assert.ok(!row.uid.includes(row.id));
  });

  test('多个账户 uid 各不相同', () => {
    // 用户名规则是最少 3 个字符（assertUsernameShape），所以这里不能写 u1/u2
    const a = users.create({ username: 'user-one', passwordHash: 'x' });
    const b = users.create({ username: 'user-two', passwordHash: 'x' });
    assert.notEqual(a.uid, b.uid);
  });

  test('findByUid 能反查', () => {
    const row = users.create({ username: 'carol', passwordHash: 'x' });
    const found = users.findByUid(row.uid);
    assert.equal(found?.id, row.id);
  });

  test('uid 不可变：改密码 / 改状态 / 改角色都不动它', () => {
    const row = users.create({ username: 'dave', passwordHash: 'x' });
    const uid = row.uid;
    users.setPassword(row.id, 'y');
    users.setStatus(row.id, 'disabled');
    users.setRole(row.id, 'admin');
    assert.equal(users.findById(row.id)?.uid, uid, 'uid 被改动了');
  });
});

// ── 3. 老库迁移 ──────────────────────────────────────────

describe('老库迁移：ensureColumn + 补号', () => {
  test('v0.1.2 形状的 users 表（无 uid 列）启动后全部补号且互不相同', () => {
    const dir = tempDir();
    const file = join(dir, 'old.db');

    // ① 造一个没有 uid 列的老库，塞两行
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        username_key TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      );
    `);
    const now = new Date().toISOString();
    for (const [id, name] of [['u1', '甲'], ['u2', '乙']]) {
      raw.prepare(
        'INSERT INTO users (id, username, username_key, password_hash, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run(id, name, name, 'x', 'user', 'active', now, now);
    }
    raw.close();

    // ② 用 Db 打开 —— 构造函数里的 ensureColumn + backfillUserUids 是被测对象
    const db = new Db(file);
    try {
      const rows = db.handle.prepare('SELECT id, uid FROM users ORDER BY id').all();
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.match(row.uid, USER_UID_PATTERN, `用户 ${row.id} 的 uid 未补齐：${JSON.stringify(row.uid)}`);
      }
      assert.notEqual(rows[0].uid, rows[1].uid, '两个老账户拿到了同一个 uid');
    } finally {
      db.close();
    }
  });

  test('二次打开不再改动已有 uid（补号幂等）', () => {
    const dir = tempDir();
    const file = join(dir, 'idem.db');

    const db1 = new Db(file);
    const store1 = new UserStore(db1.handle);
    const created = store1.create({ username: 'eve', passwordHash: 'x' });
    const uid = created.uid;
    db1.close();

    const db2 = new Db(file);
    try {
      const row = db2.handle.prepare('SELECT uid FROM users WHERE id = ?').get(created.id);
      assert.equal(row.uid, uid, '重开库后 uid 被改写了');
    } finally {
      db2.close();
    }
  });

  test('backfillUserUids 在没有待补行时返回 0（不空转、不重复分配）', () => {
    const dir = tempDir();
    const db = new Db(join(dir, 'noop.db'));
    try {
      const users = new UserStore(db.handle);
      users.create({ username: 'frank', passwordHash: 'x' });
      assert.equal(backfillUserUids(db.handle), 0);
    } finally {
      db.close();
    }
  });

  test('唯一索引真的建起来了（把一行的 uid 改成另一行的，必须被拒）', () => {
    const dir = tempDir();
    const db = new Db(join(dir, 'uniq.db'));
    try {
      const users = new UserStore(db.handle);
      const a = users.create({ username: 'gina', passwordHash: 'x' });
      const b = users.create({ username: 'hank', passwordHash: 'x' });
      assert.throws(
        () => db.handle.prepare('UPDATE users SET uid = ? WHERE id = ?').run(a.uid, b.id),
        /UNIQUE|constraint/i,
        '第二行被改成了与第一行相同的 uid，唯一索引没生效',
      );
      // 改回自己的值（等价 UPDATE）不该报错
      assert.doesNotThrow(() => db.handle.prepare('UPDATE users SET uid = ? WHERE id = ?').run(a.uid, a.id));
    } finally {
      db.close();
    }
  });
});

// ── 4. API 契约：归属双维度 ───────────────────────────────

describe('API 形状：uid 必须出现在对外结构里', () => {
  test('toPublicUser 含 uid（/api/auth/me 与 /control/accounts 共用它）', () => {
    const dir = tempDir();
    const db = new Db(join(dir, 'api.db'));
    try {
      const users = new UserStore(db.handle);
      /*
       * 假哈希要用**有辨识度的长串**，不能用 'x' 这种单字符。
       *
       * 第一版就是 `passwordHash: 'x'`，然后断言"序列化结果里不含哈希原文" ——
       * 而 uid 的字母表里本来就有 'x'，于是这条断言随 uid 的随机结果**间歇性失败**
       * （全量跑时通过、单独跑时红）。这是个典型的假判据：sentinel 太短，
       * 在别的字段里也会命中。
       */
      const fakeHash = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo';
      const row = users.create({ username: 'helen', passwordHash: fakeHash, role: 'admin' });
      const payload = toPublicUser(row);
      assert.ok('uid' in payload, 'PublicUser 没有 uid 字段');
      assert.match(payload.uid, USER_UID_PATTERN);
      assert.ok(!('password_hash' in payload), 'PublicUser 泄露了 password_hash');
      assert.ok(!JSON.stringify(payload).includes(fakeHash), '序列化后仍含哈希原文');
      // 连哈希的片段也不该出现
      assert.ok(!JSON.stringify(payload).includes('argon2id'), '序列化后仍含哈希算法标识');
    } finally {
      db.close();
    }
  });
});
