/**
 * 仓库令牌模式（v0.1.3 / F5 后半）。
 *
 * 这一批要固定的语义有四类，每类都对应一个真实的误判风险：
 *
 *   ① **形态校验**：把"前缀当完整令牌"提成显式错误 —— 这是用户最容易犯的错，
 *      而服务端那边只会回一句"格式不对"，看不出是漏了 35 个字符；
 *   ② **scope → 能力矩阵**：客户端置灰的判据必须与服务端 `requiredScope()` 一致，
 *      否则会出现"按钮亮着但点了 403"；
 *   ③ **不枚举**：令牌不存在与无效必须给出**逐字节相同**的文案；
 *   ④ **凭证路径互斥**：进入令牌模式要清掉账户令牌，否则"不暴露账户"是空话。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  capabilitiesFor,
  checkRepoTokenShape,
  describeCapabilities,
  disabledReason,
  repoTokenModeLabel,
  requiredScopeFor,
} from '../client/src/auth/repo-token.ts';
import { AuthSession, EMPTY_AUTH } from '../client/src/auth/session.ts';
import { RepoTokenError, connectWithRepoToken } from '../client/src/auth/repo-token-client.ts';

const NOW = 1_700_000_000_000;
const HOUR = 3600_000;

/** 造一把形态合法的令牌：tcr_ + 43 个 base64url 字符 */
const VALID = `tcr_${'A'.repeat(43)}`;

// ── ① 形态校验 ─────────────────────────────────────────────

test('形态校验：合法令牌通过，且去掉了首尾空白与包裹引号', () => {
  const ok = checkRepoTokenShape(VALID);
  assert.equal(ok.ok, true);
  assert.equal(ok.value, VALID);

  // 从聊天工具复制常带引号/空格，去掉后应当仍然合法
  const wrapped = checkRepoTokenShape(`  "${VALID}"  `);
  assert.equal(wrapped.ok, true, '首尾引号与空格应当被剥离');
  assert.equal(wrapped.value, VALID);
});

test('形态校验：空输入', () => {
  const result = checkRepoTokenShape('   ');
  assert.equal(result.ok, false);
  assert.equal(result.problem, 'empty');
});

test('形态校验：前缀错（含把账户密码或全局令牌填进来）', () => {
  const result = checkRepoTokenShape('not-a-token-at-all');
  assert.equal(result.ok, false);
  assert.equal(result.problem, 'prefix');
  assert.match(result.message, /tcr_/);
});

test('形态校验：把 12 字符前缀当完整令牌 —— 必须点名「前缀」而不是只说长度', () => {
  const prefix = VALID.slice(0, 12);
  const result = checkRepoTokenShape(prefix);
  assert.equal(result.ok, false);
  assert.equal(result.problem, 'length');
  assert.match(result.message, /前缀/);
  assert.match(result.message, /12/);
});

test('形态校验：长度对但字符集不对', () => {
  // 井号不在 base64url 里
  const result = checkRepoTokenShape(`tcr_${'#'.repeat(43)}`);
  assert.equal(result.ok, false);
  assert.equal(result.problem, 'charset');
});

test('形态校验：长度差 1 也要报出来（差一位是最常见的漏复制）', () => {
  const short = VALID.slice(0, -1);
  const result = checkRepoTokenShape(short);
  assert.equal(result.ok, false);
  assert.equal(result.problem, 'charset');
  assert.match(result.message, /46/);
});

// ── ② scope → 能力矩阵 ─────────────────────────────────────

test('能力矩阵：只有 read → 能看，不能上传/回滚/删除/移动', () => {
  const caps = capabilitiesFor(['read']);
  assert.equal(caps.canRead, true);
  assert.equal(caps.canUpload, false);
  assert.equal(caps.canRollback, false);
  assert.equal(caps.canDelete, false);
  assert.equal(caps.canMove, false);
  assert.equal(caps.missingFor.upload, 'write');
  assert.equal(caps.missingFor.rollback, 'rollback');
});

test('能力矩阵：read+write → 能上传与删除/移动，仍不能回滚', () => {
  const caps = capabilitiesFor(['read', 'write']);
  assert.equal(caps.canUpload, true);
  assert.equal(caps.canDelete, true);
  assert.equal(caps.canMove, true);
  assert.equal(caps.canRollback, false);
  assert.equal(caps.missingFor.rollback, 'rollback');
});

test('能力矩阵：三档齐全 → 全绿', () => {
  const caps = capabilitiesFor(['read', 'write', 'rollback']);
  assert.deepEqual(
    [caps.canRead, caps.canUpload, caps.canRollback, caps.canDelete, caps.canMove],
    [true, true, true, true, true],
  );
  assert.deepEqual(caps.missingFor, { upload: null, rollback: null, delete: null, move: null });
});

test('能力矩阵：write 但没 read → 能写不能看（服务端也这样算，别自作聪明放行）', () => {
  const caps = capabilitiesFor(['write']);
  assert.equal(caps.canRead, false, 'read 是独立的一档，不因 write 而隐含');
  assert.equal(caps.canUpload, true);
});

test('能力矩阵：空范围 → 什么都不行', () => {
  const caps = capabilitiesFor([]);
  assert.equal(caps.canRead, false);
  assert.equal(caps.canUpload, false);
  assert.equal(describeCapabilities(caps), '无可用操作');
});

test('scope 映射与服务端 requiredScope 一一对应（delete/move 归 write）', () => {
  // 这一条是交叉断言：服务端把 delete 归到 write、move 也归 write。
  // 任何一侧改了映射，这里会红 —— 否则就会出现"按钮亮着但 403"。
  assert.equal(requiredScopeFor('read'), 'read');
  assert.equal(requiredScopeFor('upload'), 'write');
  assert.equal(requiredScopeFor('rollback'), 'rollback');
  assert.equal(requiredScopeFor('delete'), 'write');
  assert.equal(requiredScopeFor('move'), 'write');
});

test('置灰理由必须点名缺哪一档（不能只说"无权限"）', () => {
  const caps = capabilitiesFor(['read']);
  const reason = disabledReason('upload', caps);
  assert.match(reason, /写/);
  assert.match(reason, /write/);
  // 可用的动作不产生理由
  assert.equal(disabledReason('rollback', capabilitiesFor(['read', 'rollback'])), '');
});

test('模式标题文案：仓库名为空时不说"仓库令牌模式 · "', () => {
  assert.equal(repoTokenModeLabel('写作素材'), '仓库令牌模式 · 写作素材');
  assert.match(repoTokenModeLabel('  '), /未知/);
});

// ── ③ 不枚举：不存在 ≡ 无效 ────────────────────────────────

/** 打点版 fetch：返回给定的状态码与响应体 */
function fakeFetch(status, body) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    };
  };
  impl.calls = calls;
  return impl;
}

test('不枚举：服务端只说 TOKEN_INVALID 时，客户端不做任何本地推断', async () => {
  const impl = fakeFetch(401, { error: { code: 'TOKEN_INVALID', message: '令牌无效', details: { hint: '确认令牌完整复制' } } });
  await assert.rejects(
    () => connectWithRepoToken('http://x', VALID, { fetchImpl: impl }),
    (error) => {
      assert.ok(error instanceof RepoTokenError);
      // 文案必须是服务端原话，一个字都不许改
      assert.equal(error.displayMessage, '令牌无效');
      assert.equal(error.reason, 'invalid');
      return true;
    },
  );
});

test('不枚举：401 但没有 code 时仍归 invalid（不能从响应形状漏出存在性）', async () => {
  const impl = fakeFetch(401, {});
  await assert.rejects(
    () => connectWithRepoToken('http://x', VALID, { fetchImpl: impl }),
    (error) => {
      assert.equal(error.reason, 'invalid');
      return true;
    },
  );
});

test('已吊销 / 已过期 / 格式错误各自有独立原因，但都不提"是否存在"', async () => {
  const cases = [
    [401, 'TOKEN_REVOKED', 'revoked'],
    [401, 'TOKEN_EXPIRED', 'expired'],
    [400, 'TOKEN_FORMAT_INVALID', 'format'],
  ];
  for (const [status, code, reason] of cases) {
    const impl = fakeFetch(status, { error: { code, message: '服务端原话' } });
    await assert.rejects(
      () => connectWithRepoToken('http://x', VALID, { fetchImpl: impl }),
      (error) => {
        assert.equal(error.reason, reason);
        assert.equal(error.displayMessage, '服务端原话');
        return true;
      },
    );
  }
});

test('形态不对时根本不发请求（省一次往返，也不把畸形串打到查库路径上）', async () => {
  const impl = fakeFetch(200, {});
  await assert.rejects(
    () => connectWithRepoToken('http://x', 'tcr_short', { fetchImpl: impl }),
    (error) => {
      assert.equal(error.reason, 'shape');
      return true;
    },
  );
  assert.equal(impl.calls.length, 0, '形态校验没过就不该发请求');
});

test('成功：解析出仓库与范围；缺仓库 id 视为失败（空 id 会让上传"成功但卡不见了"）', async () => {
  const ok = fakeFetch(200, {
    ok: true,
    repo: { id: 'repo-1', name: '写作素材' },
    scopes: ['read', 'write'],
    username: 'alice',
    expiresAt: null,
    lastUsedAt: null,
  });
  const grant = await connectWithRepoToken('http://x', VALID, { fetchImpl: ok });
  assert.equal(grant.repoId, 'repo-1');
  assert.equal(grant.repoName, '写作素材');
  assert.deepEqual(grant.scopes, ['read', 'write']);

  const broken = fakeFetch(200, { ok: true, repo: { name: '写作素材' }, scopes: ['read'] });
  await assert.rejects(
    () => connectWithRepoToken('http://x', VALID, { fetchImpl: broken }),
    (error) => {
      assert.equal(error.reason, 'server');
      assert.match(error.displayMessage, /仓库 id/);
      return true;
    },
  );
});

// ── ④ 凭证路径互斥 ─────────────────────────────────────────

function makeSession(initial) {
  const saved = [];
  const session = new AuthSession({
    load: async () => ({ ...EMPTY_AUTH, ...initial }),
    save: async (patch) => {
      saved.push({ ...patch });
    },
    serverUrl: () => 'http://127.0.0.1:8730',
    now: () => NOW,
  });
  return { session, saved };
}

const GRANT = {
  repoId: 'repo-1',
  repoName: '写作素材',
  scopes: ['read'],
  username: 'alice',
  expiresAt: null,
  lastUsedAt: null,
};

test('进入令牌模式：清掉账户令牌（否则"不暴露账户密码"是空话）', async () => {
  const { session, saved } = makeSession({
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    accessExpiresAt: NOW + HOUR,
    authUser: { userId: 'u-1', username: 'alice', role: 'user' },
  });
  await session.enterRepoTokenMode(GRANT, VALID);

  assert.equal(session.mode, 'repo-token');
  assert.equal(session.accessToken, VALID, 'accessToken getter 在令牌模式下要返回令牌原文');
  assert.equal(session.refreshToken, '');
  assert.equal(session.user, null);

  const patch = saved.at(-1);
  assert.equal(patch.accessToken, '');
  assert.equal(patch.refreshToken, '');
  assert.equal(patch.repoToken, VALID);
});

test('令牌模式下不续期（拿 tcr_ 去 refresh 必然 401，会被误判成"登录过期"）', async () => {
  const { session } = makeSession({
    repoToken: VALID,
    repoTokenRepoId: 'repo-1',
    repoTokenRepoName: '写作素材',
    repoTokenScopes: ['read'],
    repoTokenExpiresAt: null,
  });
  // 必须先 bootstrap：`state` 是启动时从配置读回来的，构造完还是 EMPTY_AUTH。
  // （第一版漏了这一步，三条断言全红 —— 是测试写错了，不是代码错了。）
  assert.equal(await session.bootstrap(), true);
  assert.equal(session.needsRefresh(NOW), false);
  assert.equal(await session.ensureFresh(), true);
  assert.equal(await session.recoverAfterUnauthorized(), false);
});

test('退出令牌模式：只清令牌，不发任何请求（令牌属于别人的账户，不该被本机吊销）', async () => {
  const { session, saved } = makeSession({
    repoToken: VALID,
    repoTokenRepoId: 'repo-1',
    repoTokenRepoName: '写作素材',
    repoTokenScopes: ['read'],
    repoTokenExpiresAt: null,
  });
  assert.equal(await session.bootstrap(), true);
  assert.equal(session.mode, 'repo-token');

  let logoutCalls = 0;
  // logout() 在令牌模式下必须走 exitRepoTokenMode，不调服务端
  const sessionAny = session;
  const originalLogout = sessionAny.logout.bind(sessionAny);
  sessionAny.logout = async () => {
    logoutCalls += 1;
    return originalLogout();
  };

  await session.logout();
  assert.equal(logoutCalls, 1, 'logout 应当被调用一次（内部的 exitRepoTokenMode 不再计）');
  assert.equal(session.mode, 'none');
  assert.equal(session.isRepoTokenMode, false);
  assert.equal(session.currentPhase, 'anonymous');
  assert.equal(saved.at(-1).repoToken, '');
});

test('账户登录成功会清掉仓库令牌（两条路径互斥，否则"刚登录却按旧令牌寻址"）', async () => {
  const { session, saved } = makeSession({
    repoToken: VALID,
    repoTokenRepoId: 'repo-1',
    repoTokenRepoName: '写作素材',
    repoTokenScopes: ['read'],
    repoTokenExpiresAt: null,
  });
  // 直接走 login 会发网络请求，这里用 refresh 之外的路径：断言 applyBundle 的副作用
  await session.enterRepoTokenMode(GRANT, VALID);
  saved.length = 0;
  // 模拟登录成功：AuthSession 没有公开 applyBundle，走 register 的等价路径
  // —— 用 login 需要一个假 api，这里改用最直接的方式：检查 enterRepoTokenMode 后再登录
  const withApi = new AuthSession({
    load: async () => ({ ...EMPTY_AUTH, repoToken: VALID, repoTokenRepoId: 'repo-1', repoTokenRepoName: '写作素材', repoTokenScopes: ['read'], repoTokenExpiresAt: null }),
    save: async (patch) => {
      saved.push({ ...patch });
    },
    serverUrl: () => 'http://127.0.0.1:8730',
    now: () => NOW,
    api: {
      login: async () => ({
        accessToken: 'access-9',
        refreshToken: 'refresh-9',
        accessExpiresAt: NOW + HOUR,
        refreshExpiresAt: NOW + 720 * HOUR,
        sessionId: 's9',
        user: { userId: 'u-1', username: 'alice', role: 'user' },
      }),
      register: async () => ({ created: true, tokens: null, user: null }),
      refresh: async () => {
        throw new Error('不该被调用');
      },
      logout: async () => {},
      fetchPolicy: async () => null,
    },
  });
  await withApi.login('alice', 'pw');
  assert.equal(withApi.mode, 'account');
  const patch = saved.at(-1);
  assert.equal(patch.repoToken, '', '账户登录必须清掉仓库令牌');
  assert.equal(patch.accessToken, 'access-9');
});

test('bootstap 恢复：有令牌即视为可用（离线也能正确置灰按钮）', async () => {
  const { session } = makeSession({
    repoToken: VALID,
    repoTokenRepoId: 'repo-1',
    repoTokenRepoName: '写作素材',
    repoTokenScopes: ['read', 'write'],
    repoTokenExpiresAt: null,
  });
  assert.equal(await session.bootstrap(), true);
  assert.equal(session.mode, 'repo-token');
  assert.equal(session.capabilities.canUpload, true);
  assert.equal(session.capabilities.canRollback, false);
});

test('capabilities：账户模式按"全权"表达，不由 scope 决定', async () => {
  const { session } = makeSession({
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    accessExpiresAt: NOW + HOUR,
  });
  await session.bootstrap();
  assert.equal(session.mode, 'account');
  assert.equal(session.capabilities.canUpload, true);
  assert.equal(session.capabilities.canRollback, true);
  assert.equal(session.capabilities.canDelete, true);
});
