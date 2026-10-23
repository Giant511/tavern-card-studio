/**
 * T10.7 登录态单测：持久化 / 静默续期 / 401 恢复 / 登出。
 *
 * 这里**不测界面**（那是 E2E 的事），只固定三条语义：
 *   · 续期单飞（并发续期会让轮换后的 refresh 被判重放）；
 *   · 401 先续期，续不上才算过期；
 *   · 登录态只写自己那四个键，绝不触碰任何"卡片会话"状态。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuthSession, EMPTY_AUTH } from '../client/src/auth/session.ts';

const NOW = 1_700_000_000_000;
const HOUR = 3600_000;

function user(name = 'alice') {
  return { userId: `u-${name}`, username: name, role: 'user' };
}

function bundle(overrides = {}) {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    accessExpiresAt: NOW + HOUR,
    refreshExpiresAt: NOW + 30 * 24 * HOUR,
    sessionId: 's1',
    user: user(),
    ...overrides,
  };
}

/** 打点版假 api：记录调用次数与参数 */
function fakeApi(overrides = {}) {
  const calls = { login: [], register: [], refresh: [], logout: [], fetchPolicy: [] };
  const api = {
    calls,
    login: async (url, input) => {
      calls.login.push({ url, input });
      return bundle();
    },
    register: async (url, input) => {
      calls.register.push({ url, input });
      return { created: true, tokens: bundle(), user: user(input.username) };
    },
    refresh: async (url, token) => {
      calls.refresh.push({ url, token });
      return bundle({ accessToken: 'access-2', refreshToken: 'refresh-2' });
    },
    logout: async (url, token) => {
      calls.logout.push({ url, token });
    },
    fetchPolicy: async () => ({ registerMode: 'closed', accessTtlSeconds: 7200, authRequired: true }),
    ...overrides,
  };
  return api;
}

/** 记录所有写盘 patch，用于断言"只写自己的键" */
function fakeStore(initial = EMPTY_AUTH, sink = { saved: [] }) {
  return {
    sink,
    load: async () => ({ ...initial }),
    save: async (patch) => {
      sink.saved.push({ ...patch });
    },
  };
}

function makeSession({ initial, api, now = NOW, skew, store } = {}) {
  const usedStore = store ?? fakeStore(initial);
  const usedApi = api ?? fakeApi();
  const phases = [];
  const session = new AuthSession({
    load: usedStore.load,
    save: usedStore.save,
    serverUrl: () => 'http://127.0.0.1:8730',
    now: () => now,
    ...(skew === undefined ? {} : { refreshSkewMs: skew }),
    onPhaseChange: (phase) => phases.push(phase),
    api: usedApi,
  });
  return { session, store: usedStore, api: usedApi, phases };
}

test('T10.7 启动：没有任何令牌 → anonymous，不发请求', async () => {
  const { session, api, phases } = makeSession();
  const ok = await session.bootstrap();
  assert.equal(ok, false);
  assert.equal(session.currentPhase, 'anonymous');
  assert.equal(api.calls.refresh.length, 0);
  assert.deepEqual(phases, ['anonymous']);
});

test('T10.7 启动：令牌还早着到期 → 直接 authenticated，不续期', async () => {
  const initial = { accessToken: 'a', refreshToken: 'r', accessExpiresAt: NOW + HOUR, authUser: user() };
  const { session, api } = makeSession({ initial });
  const ok = await session.bootstrap();
  assert.equal(ok, true);
  assert.equal(session.currentPhase, 'authenticated');
  assert.equal(api.calls.refresh.length, 0);
  assert.equal(session.accessToken, 'a');
});

test('T10.7 启动：剩不到 5 分钟 → 静默续期一次并落盘', async () => {
  const initial = {
    accessToken: 'old',
    refreshToken: 'refresh-1',
    accessExpiresAt: NOW + 60_000,
    authUser: user(),
  };
  const { session, api, store } = makeSession({ initial });
  const ok = await session.bootstrap();
  assert.equal(ok, true);
  assert.equal(api.calls.refresh.length, 1);
  assert.equal(api.calls.refresh[0].token, 'refresh-1');
  assert.equal(session.accessToken, 'access-2');
  assert.equal(session.refreshToken, 'refresh-2');
  // 写盘必须带上新到期时间，否则下次启动又判"该续期"，每次都多一次请求
  assert.equal(store.sink.saved.at(-1).accessExpiresAt, NOW + HOUR);
});

test('T10.7 续期失败：置 expired，清令牌但**保留用户名**（好告诉用户是谁过期了）', async () => {
  const api = fakeApi({
    refresh: async () => {
      throw Object.assign(new Error('invalid'), { code: 'BAD_CREDENTIALS', displayMessage: 'x' });
    },
  });
  const initial = {
    accessToken: 'old',
    refreshToken: 'refresh-1',
    accessExpiresAt: NOW + 60_000,
    authUser: user('bob'),
  };
  const { session, store, phases } = makeSession({ initial, api });
  const ok = await session.bootstrap();
  assert.equal(ok, false);
  assert.equal(session.currentPhase, 'expired');
  assert.equal(session.accessToken, '');
  assert.equal(session.refreshToken, '');
  assert.equal(session.user.username, 'bob');
  assert.equal(store.sink.saved.at(-1).authUser, undefined, '清令牌时不应顺手把用户名也清掉');
  assert.equal(phases.at(-1), 'expired');
});

test('T10.7 续期单飞：并发 3 次只发 1 个请求（否则 refresh 轮换会判重放）', async () => {
  let resolveRefresh;
  const gate = new Promise((resolve) => {
    resolveRefresh = resolve;
  });
  let calls = 0;
  const api = fakeApi({
    refresh: async () => {
      calls += 1;
      await gate; // 卡住，制造并发窗口
      return bundle({ accessToken: 'access-2', refreshToken: 'refresh-2' });
    },
  });
  const initial = {
    accessToken: 'old',
    // 先让 bootstrap 不触发续期（离到期远），再手工并发调 refreshNow
    accessExpiresAt: NOW + 2 * HOUR,
    refreshToken: 'refresh-1',
    authUser: user(),
  };
  const { session } = makeSession({ initial, api });
  await session.bootstrap();

  const all = Promise.all([session.refreshNow(), session.refreshNow(), session.refreshNow()]);
  resolveRefresh();
  const results = await all;
  assert.deepEqual(results, [true, true, true]);
  assert.equal(calls, 1, '三个并发续期必须合并成一次');
});

test('T10.7 ensureFresh：离到期还远时不发请求，返回 true', async () => {
  const initial = { accessToken: 'a', refreshToken: 'r', accessExpiresAt: NOW + 2 * HOUR, authUser: user() };
  const { session, api } = makeSession({ initial });
  await session.bootstrap();
  const ok = await session.ensureFresh();
  assert.equal(ok, true);
  assert.equal(api.calls.refresh.length, 0);
});

test('T10.7 401 恢复：先续期，成功后重试原请求（用新令牌）', async () => {
  const initial = { accessToken: 'a1', refreshToken: 'r1', accessExpiresAt: NOW + 2 * HOUR, authUser: user() };
  const { session, api } = makeSession({ initial });
  await session.bootstrap();

  const seen = [];
  const result = await session.authorized(
    async (token) => {
      seen.push(token);
      if (seen.length === 1) throw Object.assign(new Error('401'), { code: 'UNAUTHORIZED' });
      return `ok:${token}`;
    },
    (error) => error?.code === 'UNAUTHORIZED',
  );

  assert.equal(result, 'ok:access-2');
  assert.deepEqual(seen, ['a1', 'access-2']);
  assert.equal(api.calls.refresh.length, 1);
  assert.equal(session.currentPhase, 'authenticated');
});

test('T10.7 401 恢复失败：续不上就抛原错误，并置 expired', async () => {
  const api = fakeApi({
    refresh: async () => {
      throw Object.assign(new Error('gone'), { code: 'BAD_CREDENTIALS' });
    },
  });
  const initial = { accessToken: 'a1', refreshToken: 'r1', accessExpiresAt: NOW + 2 * HOUR, authUser: user() };
  const { session } = makeSession({ initial, api });
  await session.bootstrap();

  await assert.rejects(
    () =>
      session.authorized(
        async () => {
          throw Object.assign(new Error('401'), { code: 'UNAUTHORIZED' });
        },
        (error) => error?.code === 'UNAUTHORIZED',
      ),
    /401/,
  );
  assert.equal(session.currentPhase, 'expired');
});

test('T10.7 401 恢复：非 401 错误不触发续期（避免无谓刷新）', async () => {
  const initial = { accessToken: 'a1', refreshToken: 'r1', accessExpiresAt: NOW + 2 * HOUR, authUser: user() };
  const { session, api } = makeSession({ initial });
  await session.bootstrap();
  await assert.rejects(
    () =>
      session.authorized(
        async () => {
          throw Object.assign(new Error('404'), { code: 'NOT_FOUND' });
        },
        (error) => error?.code === 'UNAUTHORIZED',
      ),
    /404/,
  );
  assert.equal(api.calls.refresh.length, 0);
});

test('T10.7 登录成功：落盘四个键，进入 authenticated', async () => {
  const { session, store, phases } = makeSession();
  const result = await session.login('alice', 'pw');
  assert.equal(result.user.username, 'alice');
  assert.equal(session.currentPhase, 'authenticated');
  assert.deepEqual(Object.keys(store.sink.saved.at(-1)).sort(), [
    'accessExpiresAt',
    'accessToken',
    'authUser',
    'refreshToken',
  ]);
  assert.deepEqual(phases, ['authenticated']);
});

test('T10.7 admin-only 注册：服务端不给令牌时不改登录态', async () => {
  const api = fakeApi({
    register: async (url, input) => ({ created: true, tokens: null, user: user(input.username) }),
  });
  const { session } = makeSession({ api });
  const outcome = await session.register('bob', 'pw');
  assert.equal(outcome.tokens, null);
  assert.equal(session.currentPhase, 'anonymous');
  assert.equal(session.accessToken, '');
});

test('T10.7 登出：服务端失败也清本地（不把用户困在"登出失败"）', async () => {
  const api = fakeApi({
    logout: async () => {
      throw Object.assign(new Error('down'), { code: 'NETWORK' });
    },
  });
  const initial = { accessToken: 'a', refreshToken: 'r', accessExpiresAt: NOW + HOUR, authUser: user() };
  const { session, store } = makeSession({ initial, api });
  await session.bootstrap();

  await assert.doesNotReject(() => session.logout());
  assert.equal(session.currentPhase, 'anonymous');
  assert.equal(session.accessToken, '');
  assert.equal(session.refreshToken, '');
  const last = store.sink.saved.at(-1);
  assert.equal(last.authUser, null);
  // 关键：只写这四个键，没有任何"清理本地会话"的字段
  assert.deepEqual(Object.keys(last).sort(), ['accessExpiresAt', 'accessToken', 'authUser', 'refreshToken']);
});

test('T10.7 登录态只写自己的键：整个过程不会出现第五个键', async () => {
  const { session, store } = makeSession();
  await session.login('alice', 'pw');
  await session.logout();
  for (const patch of store.sink.saved) {
    for (const key of Object.keys(patch)) {
      assert.ok(
        ['accessToken', 'refreshToken', 'accessExpiresAt', 'authUser'].includes(key),
        `出现越界字段 ${key}：登录态不该碰配置里的其它键`,
      );
    }
  }
});

test('T10.7 skew 夹取：传负数不会变成"永远该续期"', async () => {
  const initial = { accessToken: 'a', refreshToken: 'r', accessExpiresAt: NOW + 10 * 60_000, authUser: user() };
  const { session, api } = makeSession({ initial, skew: -1 });
  await session.bootstrap();
  assert.equal(session.needsRefresh(), false);
  assert.equal(api.calls.refresh.length, 0);
});

test('T10.7 服务端地址为空时登录给明确错误（不静默打向默认端口）', async () => {
  const session = new AuthSession({
    load: async () => ({ ...EMPTY_AUTH }),
    save: async () => {},
    serverUrl: () => null,
    api: fakeApi(),
  });
  await assert.rejects(() => session.login('a', 'b'), /尚未配置服务端地址/);
});
