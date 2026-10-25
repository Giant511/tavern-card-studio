/**
 * 注销的会话层与审计保留期（v0.1.3 / F3）。
 *
 * 这两块都不在 HTTP 层，所以单独测：
 *
 *   ① **注销成功后本地登录态必须清空**。不清的话账户已经不存在，而客户端
 *      还拿着一个指向空气的 access token —— 后续每个请求都 401，
 *      用户会以为"注销失败了"。这一步纯逻辑，应该被钉住。
 *   ② **注销失败不能清状态**。失败常见于「密码错」「最后一个管理员」这类
 *      可纠正的原因，把人踢下线只会让他更迷惑。
 *   ③ **审计保留期边界**：90 天前的删、90 天内的留。判据是 ISO 字符串比较，
 *      所以两边格式必须一致 —— 这里专门测一次"格式一致性"，因为
 *      events.at 一直是 `toISOString()` 写的，一旦有人用本地时间拼边界就会错。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { AuthSession, EMPTY_AUTH } from '../client/src/auth/session.ts';
import { Db } from '../server/dist/storage/db.js';
import { AUDIT_RETENTION_DAYS, pruneAuditEvents } from '../server/dist/account/purge.js';

const NOW = 1_700_000_000_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const USER = { userId: 'u-1', username: 'alice', role: 'user' };

const RECEIPT = {
  uid: 'usr_abcd2345',
  username: 'alice',
  counts: {
    cards: 3,
    versions: 5,
    repos: 2,
    repoTokens: 1,
    sessions: 2,
    loginAttempts: 1,
    blobs: 4,
    gitRepos: 3,
  },
  warnings: [],
};

/** 假 api：默认注销成功，可按需注入失败 */
function makeSession({ initial = {}, deleteImpl } = {}) {
  const saved = [];
  const calls = [];
  const session = new AuthSession({
    load: async () => ({ ...EMPTY_AUTH, ...initial }),
    save: async (patch) => {
      saved.push({ ...patch });
    },
    serverUrl: () => 'http://127.0.0.1:8730',
    now: () => NOW,
    api: {
      login: async () => {
        throw new Error('不该被调用');
      },
      register: async () => ({ created: true, tokens: null, user: null }),
      refresh: async () => {
        throw new Error('不该被调用');
      },
      logout: async () => {},
      fetchPolicy: async () => null,
      fetchAccountSummary: async (url, token) => {
        calls.push({ kind: 'summary', url, token });
        return { username: 'alice', uid: 'usr_abcd2345', cards: 3, versions: 5, repos: 2, repoTokens: 1, sessions: 2 };
      },
      deleteAccount: async (url, token, input) => {
        calls.push({ kind: 'delete', url, token, input });
        if (deleteImpl !== undefined) return deleteImpl(input);
        return RECEIPT;
      },
    },
  });
  return { session, saved, calls };
}

/** 已登录且**同时**残留一把仓库令牌：注销必须把两条路径的键全清掉 */
const LOGGED_IN = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  accessExpiresAt: NOW + HOUR,
  authUser: USER,
};

test('① 注销成功后本地登录态全部清空（含仓库令牌的五个键）', async () => {
  const { session, saved } = makeSession({ initial: LOGGED_IN });
  assert.equal(await session.bootstrap(), true);
  assert.equal(session.mode, 'account');

  const receipt = await session.deleteAccount('alice', 'pw');
  assert.equal(receipt.username, 'alice');

  assert.equal(session.mode, 'none', '注销后不该还认为自己有凭证');
  assert.equal(session.accessToken, '');
  assert.equal(session.refreshToken, '');
  assert.equal(session.user, null);
  assert.equal(session.hasCredentials, false);
  assert.equal(session.currentPhase, 'anonymous');

  const patch = saved.at(-1);
  for (const key of [
    'accessToken',
    'refreshToken',
    'repoToken',
    'repoTokenRepoId',
    'repoTokenRepoName',
  ]) {
    assert.ok(key in patch, `清理补丁应包含 ${key}`);
  }
  assert.equal(patch.accessToken, '');
  assert.equal(patch.repoToken, '');
});

test('①b 注销时把用户名与密码原样交给服务端（判据在服务端，不在客户端）', async () => {
  const { session, calls } = makeSession({ initial: LOGGED_IN });
  await session.bootstrap();
  await session.deleteAccount('alice', 'secret-pw');
  const call = calls.find((item) => item.kind === 'delete');
  assert.equal(call.input.confirmUsername, 'alice');
  assert.equal(call.input.password, 'secret-pw');
  assert.equal(call.token, 'access-1');
});

test('①c 不传密码时不往请求体里塞空密码（服务端约定"给了就要对"）', async () => {
  const { session, calls } = makeSession({ initial: LOGGED_IN });
  await session.bootstrap();
  await session.deleteAccount('alice');
  const call = calls.find((item) => item.kind === 'delete');
  assert.equal(call.input.password, undefined, '未填密码时不该传 password 字段');
});

test('② 注销失败不能清空登录态（"密码错"不该把人踢下线）', async () => {
  const { session } = makeSession({
    initial: LOGGED_IN,
    deleteImpl: () => {
      throw new Error('密码不正确');
    },
  });
  await session.bootstrap();

  await assert.rejects(() => session.deleteAccount('alice', 'wrong'), /密码不正确/);
  assert.equal(session.mode, 'account', '失败后仍应是账户模式');
  assert.equal(session.accessToken, 'access-1', '失败不该清掉 access');
  assert.equal(session.user?.username, 'alice');
  assert.equal(session.currentPhase, 'authenticated');
});

test('③ 未登录时不能注销（没有凭证可提交）', async () => {
  const { session } = makeSession();
  await session.bootstrap();
  await assert.rejects(() => session.deleteAccount('alice'), /账户登录/);
});

test('③b 仓库令牌模式下不能注销账户（令牌不代表账户身份）', async () => {
  const { session } = makeSession({
    initial: { repoToken: `tcr_${'A'.repeat(43)}`, repoTokenRepoId: 'r-1', repoTokenRepoName: '写作素材', repoTokenScopes: ['read'] },
  });
  await session.bootstrap();
  assert.equal(session.mode, 'repo-token');
  /*
   * 为什么这里能拦住：`deleteAccount` 判的是 `this.state.accessToken`
   * （**原始字段**），不是 `accessToken` getter。
   *
   * 这个区别很关键：getter 在令牌模式下会返回仓库令牌原文（F5 后半的设计，
   * 为的是让既有同步链路零改动按令牌寻址）。如果这里误用了 getter，
   * 判据就会认为"有账户凭证"，然后拿一把 `tcr_` 去调注销接口 ——
   * 服务端会 403，但客户端已经白跑一次，且错误文案来自服务端而不是本地。
   * 正则 `/账户登录/` 固定的是本地这句提示。
   */
  await assert.rejects(() => session.deleteAccount('alice'), /账户登录/);
});

test('④ accountSummary：需要账户登录，且把服务端数字原样带回', async () => {
  const { session, calls } = makeSession({ initial: LOGGED_IN });
  await session.bootstrap();
  const summary = await session.accountSummary();
  assert.equal(summary.cards, 3);
  assert.equal(summary.repoTokens, 1);
  assert.equal(calls.at(-1).kind, 'summary');

  const anon = makeSession();
  await anon.session.bootstrap();
  await assert.rejects(() => anon.session.accountSummary(), /账户登录/);
});

// ── 审计保留期 ──────────────────────────────────────────────

let workDir;
const opened = [];
before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-audit-retention-'));
});
after(() => {
  for (const db of opened) {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
  }
  rmSync(workDir, { recursive: true, force: true });
});

test('⑤ 审计保留 90 天：超期删除、未超期保留', () => {
  const db = new Db(join(workDir, 'audit.db'));
  opened.push(db);
  const now = new Date('2026-10-25T00:00:00.000Z');

  const write = (at) => {
    db.appendEvent({ at, level: 'info', action: 'probe', cardId: null, detail: {} });
  };

  write(new Date(now.getTime() - 200 * DAY).toISOString()); // 远超期
  write(new Date(now.getTime() - 91 * DAY).toISOString()); // 刚超期
  write(new Date(now.getTime() - 89 * DAY).toISOString()); // 还没到
  write(new Date(now.getTime() - 1 * DAY).toISOString()); // 昨天
  write(now.toISOString()); // 刚写

  assert.equal(db.handle.prepare('SELECT COUNT(*) AS n FROM events').get().n, 5);

  const removed = pruneAuditEvents(db.handle, { now });
  assert.equal(removed, 2, '应只删掉 200 天前与 91 天前那两条');
  assert.equal(db.handle.prepare('SELECT COUNT(*) AS n FROM events').get().n, 3, '89 天内的一条不能删');

  // 幂等：再跑一次不该删东西
  assert.equal(pruneAuditEvents(db.handle, { now }), 0);
});

test('⑤b 保留天数必须为正数（0 或负数会让"保留"变成"立刻删光"）', () => {
  const db = new Db(join(workDir, 'audit-guard.db'));
  opened.push(db);
  assert.throws(() => pruneAuditEvents(db.handle, { days: 0 }), /正数/);
  assert.throws(() => pruneAuditEvents(db.handle, { days: -1 }), /正数/);
  assert.throws(() => pruneAuditEvents(db.handle, { days: Number.NaN }), /正数/);
});

test('⑤c 注销事件本身不会被保留期清理误伤（它是刚写的）', () => {
  const db = new Db(join(workDir, 'audit-purge.db'));
  opened.push(db);
  const now = new Date('2026-10-25T00:00:00.000Z');

  // 模拟一条很老的普通事件 + 一条刚写的注销事件
  db.appendEvent({
    at: new Date(now.getTime() - 400 * DAY).toISOString(),
    level: 'info',
    action: 'card.upload',
    cardId: 'old-card',
    detail: {},
  });
  db.appendEvent({
    at: now.toISOString(),
    level: 'warn',
    action: 'account.purge.admin',
    cardId: null,
    detail: { targetUid: 'usr_abcd2345', targetUsername: 'gone' },
    ownerId: 'deleted-user-id',
    actor: 'root (usr_root)',
    ip: '127.0.0.1',
  });

  assert.equal(pruneAuditEvents(db.handle, { now }), 1, '应只删那条 400 天前的');
  const rest = db.handle.prepare('SELECT action, actor, ip, owner_id FROM events').all();
  assert.equal(rest.length, 1);
  assert.equal(rest[0].action, 'account.purge.admin');
  assert.equal(rest[0].actor, 'root (usr_root)');
  assert.equal(rest[0].ip, '127.0.0.1');
  // owner_id 指向已删除的账户 —— 这是审计要的效果：账户没了，记录还认得出是谁
  assert.equal(rest[0].owner_id, 'deleted-user-id');
  assert.equal(AUDIT_RETENTION_DAYS, 90, '保留期常量应为 90 天（需求硬要求）');
});
