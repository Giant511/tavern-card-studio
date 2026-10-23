/**
 * T10.7 客户端认证层单测。
 *
 * 重点不是"能登录"，而是三条**界面规则**：
 *   · 认证失败文案必须是服务端原话（客户端不得翻译）；
 *   · 取不到注册策略时 fail-closed；
 *   · 卡片行四个字段的降级规则。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  AuthClientError,
  fetchPolicy,
  login,
  logout,
  refresh,
  register,
} from '../client/src/auth/auth-client.ts';
import {
  authErrorMessage,
  isCredentialFailure,
  isNetworkFailure,
  phaseLabel,
  registerHint,
  shouldShowRegister,
} from '../client/src/auth/policy.ts';
import { emptyCardsText, isolationNote, toCardRow } from '../client/src/sync/card-row.ts';

const BASE = 'http://127.0.0.1:8730';

/** 最小 Response 替身：客户端只用 ok / status / json() */
function reply(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function fetchOnce(status, body, sink = { calls: [] }) {
  const impl = async (url, init) => {
    sink.calls.push({ url, init });
    return reply(status, body);
  };
  return { impl, sink };
}

const SERVER_TEXT = '用户名或密码不正确';

test('T10.7 登录成功：解析出 access/refresh/到期时间/用户', async () => {
  const expires = new Date(Date.now() + 7200_000).toISOString();
  const { impl, sink } = fetchOnce(200, {
    user: { id: 'u1', username: 'alice', role: 'user' },
    tokenType: 'Bearer',
    accessToken: 'a.b.c',
    refreshToken: 'r1',
    accessExpiresAt: expires,
    refreshExpiresAt: expires,
    sessionId: 's1',
  });

  const bundle = await login(BASE, { username: 'alice', password: 'p' }, { fetchImpl: impl });
  assert.equal(bundle.accessToken, 'a.b.c');
  assert.equal(bundle.refreshToken, 'r1');
  assert.equal(bundle.user.userId, 'u1');
  assert.equal(bundle.user.username, 'alice');
  assert.equal(bundle.user.role, 'user');
  assert.equal(bundle.accessExpiresAt, Date.parse(expires));
  assert.equal(sink.calls[0].url, `${BASE}/api/auth/login`);
  assert.equal(sink.calls[0].init.method, 'POST');
});

test('T10.7 登录 401：文案与服务端逐字节一致（不翻译、不加后缀）', async () => {
  const { impl } = fetchOnce(401, { error: { code: 'INVALID_CREDENTIALS', message: SERVER_TEXT } });
  await assert.rejects(
    () => login(BASE, { username: 'alice', password: 'wrong' }, { fetchImpl: impl }),
    (error) => {
      assert.ok(error instanceof AuthClientError);
      assert.equal(error.code, 'BAD_CREDENTIALS');
      // 关键断言：完全相等。任何"（可能是密码错了）"之类的补充都会破坏枚举面
      assert.equal(error.displayMessage, SERVER_TEXT);
      assert.equal(authErrorMessage(error), SERVER_TEXT);
      return true;
    },
  );
});

test('T10.7 401 与 403 只要服务端文案相同，客户端输出就相同（不按状态码分支翻译）', async () => {
  const { impl: i401 } = fetchOnce(401, { error: { code: 'INVALID_CREDENTIALS', message: SERVER_TEXT } });
  const { impl: i403 } = fetchOnce(403, { error: { code: 'ACCOUNT_DISABLED', message: SERVER_TEXT } });

  const first = await login(BASE, { username: 'a', password: 'x' }, { fetchImpl: i401 }).catch((e) => e);
  const second = await login(BASE, { username: 'a', password: 'x' }, { fetchImpl: i403 }).catch((e) => e);
  assert.equal(authErrorMessage(first), authErrorMessage(second));
});

test('T10.7 服务端没给 message 时用中性描述（不含原因推测）', async () => {
  const { impl } = fetchOnce(401, {});
  const error = await login(BASE, { username: 'a', password: 'x' }, { fetchImpl: impl }).catch((e) => e);
  assert.equal(error.displayMessage, '无法完成请求（HTTP 401）');
  for (const guess of ['密码', '不存在', '锁定', '已过期']) {
    assert.equal(error.displayMessage.includes(guess), false, `不应包含推测词「${guess}」`);
  }
});

test('T10.7 注册关闭：403 REGISTRATION_CLOSED 单独识别，文案原样', async () => {
  const { impl } = fetchOnce(403, {
    error: { code: 'REGISTRATION_CLOSED', message: '本服务端未开放自助注册。' },
  });
  const error = await register(BASE, { username: 'a', password: 'p' }, { fetchImpl: impl }).catch(
    (e) => e,
  );
  assert.equal(error.code, 'REGISTER_CLOSED');
  assert.equal(error.displayMessage, '本服务端未开放自助注册。');
  assert.equal(isCredentialFailure(error), true);
});

test('T10.7 admin-only 建号：服务端不返回令牌 → tokens 为 null（不假装登录成功）', async () => {
  const { impl } = fetchOnce(201, { user: { id: 'u2', username: 'bob', role: 'user' } });
  const outcome = await register(BASE, { username: 'bob', password: 'p' }, { fetchImpl: impl });
  assert.equal(outcome.created, true);
  assert.equal(outcome.tokens, null);
  assert.equal(outcome.user.username, 'bob');
});

test('T10.7 refresh：拿到轮换后的新 refresh', async () => {
  const { impl, sink } = fetchOnce(200, {
    user: { id: 'u1', username: 'alice', role: 'user' },
    accessToken: 'new-access',
    refreshToken: 'r2',
    accessExpiresAt: new Date(Date.now() + 1000).toISOString(),
    sessionId: 's1',
  });
  const bundle = await refresh(BASE, 'r1', { fetchImpl: impl });
  assert.equal(bundle.accessToken, 'new-access');
  assert.equal(bundle.refreshToken, 'r2');
  assert.equal(JSON.parse(sink.calls[0].init.body).refreshToken, 'r1');
});

test('T10.7 令牌不完整时判失败，不返回半套令牌', async () => {
  const { impl } = fetchOnce(200, { accessToken: 'only-access', user: { username: 'a' } });
  const error = await login(BASE, { username: 'a', password: 'p' }, { fetchImpl: impl }).catch(
    (e) => e,
  );
  assert.ok(error instanceof AuthClientError);
  assert.equal(error.code, 'SERVER');
});

test('T10.7 网络失败：判 NETWORK，且文案不涉及凭证', async () => {
  const impl = async () => {
    throw new TypeError('fetch failed');
  };
  const error = await login(BASE, { username: 'a', password: 'p' }, { fetchImpl: impl }).catch(
    (e) => e,
  );
  assert.equal(error.code, 'NETWORK');
  assert.equal(isNetworkFailure(error), true);
  assert.equal(isCredentialFailure(error), false);
  assert.equal(/密码|账户/.test(error.displayMessage), false);
});

test('T10.7 登出遇到 401 视为已达成目的（不抛）', async () => {
  const { impl } = fetchOnce(401, { error: { code: 'UNAUTHORIZED', message: 'x' } });
  await assert.doesNotReject(() => logout(BASE, 'dead', { fetchImpl: impl }));
});

test('T10.7 策略：未知 registerMode 一律回落 closed；authRequired 缺省为 true', async () => {
  const { impl } = fetchOnce(200, { registerMode: 'whatever', accessTtlSeconds: 60 });
  const policy = await fetchPolicy(BASE, { fetchImpl: impl });
  assert.equal(policy.registerMode, 'closed');
  assert.equal(policy.accessTtlSeconds, 60);
  assert.equal(policy.authRequired, true);
});

test('T10.7 注册入口显隐：closed 不显示；admin-only 仅管理员可见；策略缺失不显示', () => {
  const admin = { userId: 'u', username: 'root', role: 'admin' };
  const user = { userId: 'u2', username: 'alice', role: 'user' };

  assert.equal(shouldShowRegister({ registerMode: 'closed', accessTtlSeconds: 1, authRequired: true }, admin), false);
  assert.equal(shouldShowRegister({ registerMode: 'open', accessTtlSeconds: 1, authRequired: true }, null), true);
  assert.equal(shouldShowRegister({ registerMode: 'admin-only', accessTtlSeconds: 1, authRequired: true }, null), false);
  assert.equal(shouldShowRegister({ registerMode: 'admin-only', accessTtlSeconds: 1, authRequired: true }, user), false);
  assert.equal(shouldShowRegister({ registerMode: 'admin-only', accessTtlSeconds: 1, authRequired: true }, admin), true);
  // 取不到策略 = fail-closed
  assert.equal(shouldShowRegister(null, admin), false);
});

test('T10.7 注册策略说明文案随模式变化，且不预测成败', () => {
  assert.match(registerHint('closed'), /未开放自助注册/);
  assert.match(registerHint('open'), /开放自助注册/);
  assert.match(registerHint('admin-only'), /仅管理员/);
  assert.equal(/一定|必然|肯定/.test(registerHint('open')), false);
});

test('T10.7 顶栏账户文案：三种状态', () => {
  assert.equal(phaseLabel('anonymous', null), '登录…');
  assert.equal(phaseLabel('authenticated', { userId: 'u', username: 'alice', role: 'user' }), 'alice');
  assert.match(phaseLabel('authenticated', { userId: 'u', username: 'root', role: 'admin' }), /管理员/);
  assert.match(phaseLabel('expired', { userId: 'u', username: 'alice', role: 'user' }), /登录已过期/);
});

test('T10.7 卡片行：四字段齐全（角色名 · cardId · 仓库 · vN）', () => {
  const row = toCardRow({
    cardId: 'c-1',
    id: 'c-1',
    name: '林晚照',
    repoId: 'r1',
    repoName: 'default',
    latestSeq: 3,
    latestSha256: '',
    updatedAt: '2026-10-23T00:00:00.000Z',
    deleted: false,
    idSource: 'client',
    versionCount: 3,
  });
  assert.equal(row.summary, '林晚照 · c-1 · default · v3');
  assert.equal(row.repo, 'default');
  assert.equal(row.version, 'v3');
});

test('T10.7 卡片行降级：空名字/未归属仓库/从未上传各有明确占位', () => {
  const row = toCardRow({
    cardId: 'c-2',
    id: 'c-2',
    name: '   ',
    repoId: '',
    repoName: null,
    latestSeq: 0,
    latestSha256: '',
    updatedAt: '',
    deleted: false,
    idSource: 'legacy',
    versionCount: 0,
  });
  assert.equal(row.name, '（未命名）');
  assert.equal(row.repo, '未归属仓库');
  // v— 与 v0 必须区分：v0 会让人以为"第 0 版"，实际是从没传过内容
  assert.equal(row.version, 'v—');
  assert.equal(row.summary, '（未命名） · c-2 · 未归属仓库 · v—');
});

test('T10.7 空列表文案区分"没有卡"与"搜索无结果"', () => {
  assert.match(emptyCardsText(''), /还没有角色卡/);
  assert.match(emptyCardsText('  abc '), /abc/);
});

test('T10.8 隔离提示：账户登录 + 服务端未隔离才提示（服务端说 true 就不提）', () => {
  // 服务端已强制隔离（T10.8 起恒为 true）→ 不该再出现"未隔离"的免责声明
  assert.equal(isolationNote(true, true), null);
  // 旧版服务端没有该字段 → 那提示仍然是真的，必须保留
  assert.match(isolationNote(true, null), /没有按账户过滤/);
  assert.match(isolationNote(true, false), /没有按账户过滤/);
  // legacy 只该看到未归属卡片，对它说"未隔离"是废话
  assert.equal(isolationNote(false, null), null);
  assert.equal(isolationNote(false, true), null);
});

test('T10.7 源码守卫：认证客户端里没有本地化的凭证文案（只看字符串字面量）', () => {
  // 只要有人在 auth-client.ts 里写下 `'用户名或密码错误'` 这类映射，
  // 这个测试就红 —— 那正是把服务端抹平的枚举面重建起来。
  // 注释里出现这些词是允许的（那是在解释"为什么不这么做"），所以只扫字符串字面量。
  const source = readFileSync('client/src/auth/auth-client.ts', 'utf8');
  const literals = [...source.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? '',
  );
  for (const phrase of ['用户名或密码', '密码错误', '账户不存在', '已被锁定']) {
    const hit = literals.find((text) => text.includes(phrase));
    assert.equal(hit, undefined, `auth-client.ts 的字符串字面量里不应出现「${phrase}」，实际：${hit}`);
  }
});
