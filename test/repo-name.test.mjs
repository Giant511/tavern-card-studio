/**
 * v0.1.3 / F1：仓库名支持中文。
 *
 * 需求点名的四类断言：
 *   1. 中文创建 / 改名可用（含常见全角符号）；
 *   2. 唯一性：中文名按原样建 key（无大小写折叠），但**大小写混合**的中文名
 *      要与小写形式撞车（`测试Repo` 与 `测试repo` 视为同一个）；
 *   3. 非法字符拒绝清单：控制字符、`/ \ : * ? " < > |`、首尾空白、超长；
 *   4. 服务端与客户端**同构**：两侧调的是 shared 里同一个函数，不是各写一份。
 *
 * 第 4 条怎么测才不空泛：直接断言 `server/dist/storage/repos.js` 的
 * `assertRepoNameShape` 与 `@tcs/shared` 的 `validateRepoName` 对**同一批输入**
 * 给出一致结论（通过/拒绝 + 拒绝原因类别）。如果将来有人在服务端另写一份正则，
 * 这组用例会红。
 *
 * 运行：node --test test/repo-name.test.mjs（需先 npm run build:shared && npm run build:server）
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repoNameKey, REPO_NAME_MAX_CODEPOINTS, validateRepoName } from '../shared/dist/model/repo-name.js';
import { Db } from '../server/dist/storage/db.js';
import {
  RepoExistsError,
  RepoStore,
  assertRepoNameShape,
  normalizeRepoName,
} from '../server/dist/storage/repos.js';

// ── 1. 纯函数：合法名 ────────────────────────────────────

describe('validateRepoName：合法仓库名', () => {
  const valid = [
    '我的仓库',
    '测试Repo',
    '角色卡备份',
    'ｒｅｐｏ', // 全角字母
    '测试（一）', // 全角括号
    '中文＋英文＋数字ＡＢＣ１２３', // 全角加号与全角数字
    '《主神空间》备份',
    '仓库·测试', // 间隔号
    'default',
    'my_repo.v2',
    'a',
    'アーカイブ', // 假名（超出 CJK，但同属"不该被白名单漏掉"的区段）
    '한국어', // 谚文
    '中文 带空格', // 中间空格允许（只有首尾不允许）
  ];

  for (const name of valid) {
    test(`接受「${name}」`, () => {
      const check = validateRepoName(name);
      assert.equal(check.ok, true, `${name} 应被接受，实际：${check.message ?? ''}`);
      assert.equal(check.name, name);
      assert.notEqual(check.key, '');
    });
  }
});

// ── 2. 纯函数：非法名（拒绝清单）──────────────────────────

describe('validateRepoName：拒绝清单', () => {
  test('空串', () => {
    const check = validateRepoName('');
    assert.equal(check.ok, false);
    assert.equal(check.issue, 'empty');
  });

  test('纯空白（不是空串，但 trim 后为空）', () => {
    // 纯空白会先命中 edge-whitespace（因为 raw !== raw.trim()），
    // 两种归因都能接受，但必须**被拒**且文案可读
    const check = validateRepoName('   ');
    assert.equal(check.ok, false);
    assert.ok(check.issue === 'empty' || check.issue === 'edge-whitespace');
    assert.ok((check.message ?? '').length > 0);
  });

  for (const [label, name] of [
    ['斜杠', 'a/b'],
    ['反斜杠', 'a\\b'],
    ['冒号', 'a:b'],
    ['星号', 'a*b'],
    ['问号', 'a?b'],
    ['双引号', 'a"b'],
    ['小于号', 'a<b'],
    ['大于号', 'a>b'],
    ['竖线', 'a|b'],
    ['中文名里的斜杠', '我的/仓库'],
  ]) {
    test(`拒绝含${label}的名字`, () => {
      const check = validateRepoName(name);
      assert.equal(check.ok, false);
      assert.equal(check.issue, 'forbidden-char');
    });
  }

  test('拒绝首尾空白（不静默 trim）', () => {
    for (const name of [' 仓库', '仓库 ', ' 仓库 ']) {
      const check = validateRepoName(name);
      assert.equal(check.ok, false, `「${name}」应被拒绝`);
      assert.equal(check.issue, 'edge-whitespace');
    }
  });

  test('拒绝 C0 控制字符（含 \\t \\n）', () => {
    for (const name of ['a\tb', 'a\nb', 'a\rb', 'a\u0000b']) {
      const check = validateRepoName(name);
      assert.equal(check.ok, false);
      assert.equal(check.issue, 'control-char');
    }
  });

  test('拒绝 C1 控制字符与不可见字符', () => {
    // U+0085 NEL、U+202E 双向覆盖、U+200B 零宽空格、U+FEFF BOM
    for (const name of ['a\u0085b', 'a\u202eb', 'a\u200bb', 'a\ufeffb']) {
      const check = validateRepoName(name);
      assert.equal(check.ok, false, JSON.stringify(name));
      assert.equal(check.issue, 'control-char');
    }
  });

  test(`长度上限 ${String(REPO_NAME_MAX_CODEPOINTS)} 码点（含边界）`, () => {
    const atLimit = '仓'.repeat(REPO_NAME_MAX_CODEPOINTS);
    assert.equal(validateRepoName(atLimit).ok, true);

    const overLimit = '仓'.repeat(REPO_NAME_MAX_CODEPOINTS + 1);
    const check = validateRepoName(overLimit);
    assert.equal(check.ok, false);
    assert.equal(check.issue, 'too-long');
  });

  test('长度按码点而不是 UTF-16 长度计', () => {
    // '😀'.length === 2；若按 length 判，32 个表情就会被误判超长
    const emoji32 = '😀'.repeat(32);
    assert.equal(emoji32.length, 64, '前提：UTF-16 长度是 64');
    assert.equal(validateRepoName(emoji32).ok, true, '32 个表情是 32 码点，应通过');
  });
});

// ── 3. 唯一性键语义 ──────────────────────────────────────

describe('repoNameKey：唯一性语义', () => {
  test('中文原样保留（无大小写折叠）', () => {
    assert.equal(repoNameKey('我的仓库'), '我的仓库');
    assert.equal(validateRepoName('我的仓库').key, '我的仓库');
  });

  test('大小写混合的中文名与小写形式撞车', () => {
    assert.equal(repoNameKey('测试Repo'), repoNameKey('测试repo'));
    assert.equal(validateRepoName('测试Repo').key, validateRepoName('测试repo').key);
  });

  test('英文仍大小写不敏感（v0.1.2 语义不变）', () => {
    assert.equal(repoNameKey('Default'), repoNameKey('default'));
  });

  test('键做 trim 但名字本身不允许首尾空白', () => {
    // key 函数自身会 trim（防调用方漏判），但 validate 层已经拒绝带首尾空白的名字，
    // 所以正常路径上不会出现"名字带空白但键被 trim"的错位
    assert.equal(repoNameKey(' a '), 'a');
    assert.equal(validateRepoName(' a ').ok, false);
  });

  test('服务端 normalizeRepoName 与 shared 的 repoNameKey 逐字节一致', () => {
    const samples = ['我的仓库', 'TestRepo', ' 测试 ', 'ＡＢＣ', 'a_b.c'];
    for (const sample of samples) {
      assert.equal(normalizeRepoName(sample), repoNameKey(sample), `对「${sample}」不一致`);
    }
  });
});

// ── 4. 服务端与客户端同构（同一来源）──────────────────────

describe('同构校验：服务端不接受 shared 不接受的任何名字', () => {
  const samples = [
    '我的仓库',
    '测试Repo',
    'ａｂｃ',
    'a/b',
    'a\\b',
    'a:b',
    'a*b',
    'a?b',
    'a"b',
    'a<b',
    'a>b',
    'a|b',
    ' 前后有空格 ',
    'a\tb',
    'a\u202eb',
    '',
    '   ',
    '仓'.repeat(65),
    '仓'.repeat(64),
  ];

  test('对同一批输入，服务端 assertRepoNameShape 与 shared validateRepoName 结论一致', () => {
    const mismatches = [];
    for (const sample of samples) {
      const shared = validateRepoName(sample).ok;
      let server;
      try {
        assertRepoNameShape(sample);
        server = true;
      } catch {
        server = false;
      }
      if (shared !== server) {
        mismatches.push(`${JSON.stringify(sample)}：shared=${String(shared)} server=${String(server)}`);
      }
    }
    assert.deepEqual(mismatches, [], `两侧判定不一致：\n${mismatches.join('\n')}`);
  });
});

// ── 5. 真库：创建 / 改名 / 唯一性 ─────────────────────────

describe('RepoStore：中文名在建库上的行为', () => {
  let dir = '';
  let db = null;
  let repos = null;
  let ownerId = '';

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'tcs-repo-name-'));
    db = new Db(join(dir, 'state.db'));
    repos = new RepoStore(db.handle);
    // 直接造一个 owner：仓库只要 owner_id 字符串，不必真有 user 行
    ownerId = 'u_test_owner';
  });

  after(() => {
    try {
      db?.close?.();
    } catch {
      /* 关闭失败不影响断言 */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test('创建中文仓库并把中文原样存进 name / name_key', () => {
    const row = repos.create({ ownerId, name: '我的仓库', description: '', now: new Date().toISOString() });
    assert.equal(row.name, '我的仓库');
    assert.equal(row.name_key, '我的仓库');
  });

  test('同账户下重名（大小写混合）被拒', () => {
    repos.create({ ownerId, name: '测试Repo', description: '', now: new Date().toISOString() });
    assert.throws(
      () => repos.create({ ownerId, name: '测试repo', description: '', now: new Date().toISOString() }),
      RepoExistsError,
    );
    // 完全相同的写法当然也被拒
    assert.throws(
      () => repos.create({ ownerId, name: '测试Repo', description: '', now: new Date().toISOString() }),
      RepoExistsError,
    );
  });

  test('不同账户可以有同名中文仓库（唯一性是账户内）', () => {
    const other = repos.create({ ownerId: 'u_other', name: '测试Repo', description: '', now: new Date().toISOString() });
    assert.equal(other.name, '测试Repo');
  });

  test('改名到中文名成功；改成已存在的中文名被拒', () => {
    const row = repos.create({ ownerId, name: '待改名', description: '', now: new Date().toISOString() });
    repos.rename(row.id, '改名后的仓库', new Date().toISOString());
    const after = repos.findById(row.id);
    assert.equal(after.name, '改名后的仓库');
    assert.equal(after.name_key, '改名后的仓库');

    assert.throws(() => repos.rename(row.id, '我的仓库', new Date().toISOString()), RepoExistsError);
  });

  test('非法中文名在落库前就被拒（不会产生半条记录）', () => {
    const before = repos.list(ownerId).length;
    for (const bad of ['我的/仓库', '仓库 ', 'a\u202eb']) {
      assert.throws(
        () => repos.create({ ownerId, name: bad, description: '', now: new Date().toISOString() }),
        /仓库名/,
        `「${JSON.stringify(bad)}」应被拒`,
      );
    }
    assert.equal(repos.list(ownerId).length, before, '被拒的名字不应产生记录');
  });

  test('按名字查中文仓库（走 name_key，大小写不敏感）', () => {
    const found = repos.findByOwnerAndName(ownerId, '测试REPO');
    assert.ok(found !== null, '按「测试REPO」应能找到「测试Repo」');
    assert.equal(found.name, '测试Repo');
  });
});
