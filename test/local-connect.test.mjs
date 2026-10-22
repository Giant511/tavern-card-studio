/**
 * T9.13 一键连接本机服务端 · 编排逻辑测试（F6.1）。
 *
 * 这里测的是**判断是否正确**，不是"能不能连上"：
 *   · 失败时给的分类对不对（未运行 / 端口被改 / 非本机 / 令牌被拒）；
 *   · 文案里有没有可执行的下一步（写错一个字就会让用户跑去重装）；
 *   · 成功时是否真的把地址与令牌落到配置；
 *   · 校验用的是既有 probeServer 的两步语义，不是另写一套。
 *
 * 全部用注入的 fetch，不起服务端 —— 这样每个分支都能精确构造。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  connectLocalServer,
  describeLocalSuccess,
  explainLocalFailure,
  LOCAL_API_ORIGIN,
  LOCAL_PANEL_ORIGIN,
} from '../client/src/net/local-connect.ts';

// ── 一个可编程的假 fetch ──────────────────────────────────

/**
 * routes: { [url]: handler }
 * handler 返回 { status, body } 或抛错（模拟连接失败）
 */
function makeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    const key = String(url);
    const handler = routes[key];
    if (!handler) {
      // 没登记的地址一律当作"连不上"（模拟端口没人听）
      const error = new Error('fetch failed');
      error.name = 'TypeError';
      throw error;
    }
    const result = await handler(init);
    if (result instanceof Error) throw result;
    const bodyText = typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? {});
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: async () => bodyText,
      json: async () => JSON.parse(bodyText),
    };
  };
  impl.calls = calls;
  return impl;
}

// authRequired 必须带上：probeServer 靠它决定要不要继续校验令牌（见 server-probe.ts ②）。
// 漏了它 probeServer 会短路成"未启用鉴权"，/api/stats 根本不会被调用。
const HEALTH_OK = { status: 200, body: { status: 'ok', version: '0.1.0', authRequired: true } };
// 未启用鉴权的服务端：health 里 authRequired=false
const HEALTH_NO_AUTH = { status: 200, body: { status: 'ok', version: '0.1.0', authRequired: false } };
const TOKEN_OK = { status: 200, body: { token: 'tok-abc', authRequired: true, server: { version: '0.1.0' } } };
const STATS_OK = { status: 200, body: { cards: 3, totalCards: 3 } };

/** 记录 persist 调用 */
function makePersist(shouldThrow = false) {
  const calls = [];
  const fn = async (patch) => {
    calls.push(patch);
    if (shouldThrow) throw new Error('配置文件只读');
  };
  fn.calls = calls;
  return fn;
}

// ── 失败分类 ──────────────────────────────────────────────

test('失败：两个端口都没响应 → not-running（未安装 / 未启动）', async () => {
  const result = await connectLocalServer({
    fetchImpl: makeFetch({}),
    persist: makePersist(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'not-running');
  assert.match(result.message, /没有在运行/);
});

test('失败：not-running 的文案必须同时覆盖「未安装」与「未启动」并给出确认方法', () => {
  const failure = explainLocalFailure('not-running');
  const text = failure.steps.join('\n');

  // 两种可能都要出现 —— 从渲染层无法区分，只能让用户自己核对
  assert.match(text, /未安装/, '缺少「未安装」分支');
  assert.match(text, /已安装但未启动|未启动/, '缺少「未启动」分支');
  // 必须给出具体的确认入口，而不是"请检查服务"
  assert.match(text, /services\.msc/, '未给出服务管理器入口');
  assert.match(text, /程序和功能/, '未给出卸载/安装列表入口');
  // 明确说明为什么两种情况看起来一样，避免用户困惑
  assert.match(text, /一样/);
});

test('失败：API 不通但面板通 → port-changed（服务在跑，地址被改）', async () => {
  // 面板 /api/health 返回本服务的 status:ok —— supervisor 会把 health 代理给 worker，
  // 所以"面板 health 通"等价于"服务在跑，只是 API 不在我们预期的地址上"。
  const fetchImpl = makeFetch({
    [`${LOCAL_PANEL_ORIGIN}/api/health`]: () => HEALTH_OK,
  });

  const result = await connectLocalServer({ fetchImpl, persist: makePersist() });

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'port-changed');
  assert.match(result.message, /监听地址被改过/);
  assert.match(result.steps.join('\n'), /参数配置/, '应指引到面板参数配置页确认');
});

test('失败：面板也不通时不应误判成 port-changed', async () => {
  const result = await connectLocalServer({
    fetchImpl: makeFetch({
      // 只让一个不相干的地址通
      'http://elsewhere/api/health': () => HEALTH_OK,
    }),
    persist: makePersist(),
  });
  assert.equal(result.kind, 'not-running');
  assert.notEqual(result.kind, 'port-changed');
});

test('失败：取令牌返回 TOKEN_LOCAL_ONLY → not-local，并提示代理', async () => {
  const result = await connectLocalServer({
    fetchImpl: makeFetch({
      [`${LOCAL_API_ORIGIN}/api/health`]: () => HEALTH_OK,
      [`${LOCAL_API_ORIGIN}/api/token`]: () => ({
        status: 403,
        body: { error: { code: 'TOKEN_LOCAL_ONLY', message: '只接受本机请求' } },
      }),
    }),
    persist: makePersist(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'not-local');
  assert.match(result.steps.join('\n'), /代理/);
});

test('失败：取令牌返回 TOKEN_NOT_CONFIGURED → token-denied，并指引去面板', async () => {
  const result = await connectLocalServer({
    fetchImpl: makeFetch({
      [`${LOCAL_API_ORIGIN}/api/health`]: () => HEALTH_OK,
      [`${LOCAL_API_ORIGIN}/api/token`]: () => ({
        status: 409,
        body: { error: { code: 'TOKEN_NOT_CONFIGURED', message: '服务端未配置访问令牌' } },
      }),
    }),
    persist: makePersist(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'token-denied');
  // 服务端给的原因要透传，不能吞掉换成笼统文案
  assert.match(result.message, /未配置访问令牌/);
});

test('失败：取令牌返回空串 → token-denied（不能当成成功）', async () => {
  const result = await connectLocalServer({
    fetchImpl: makeFetch({
      [`${LOCAL_API_ORIGIN}/api/health`]: () => HEALTH_OK,
      [`${LOCAL_API_ORIGIN}/api/token`]: () => ({ status: 200, body: { token: '' } }),
    }),
    persist: makePersist(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'token-denied');
  assert.match(result.message, /空令牌/);
});

test('失败：取令牌时连接中断 → network', async () => {
  const result = await connectLocalServer({
    fetchImpl: makeFetch({
      [`${LOCAL_API_ORIGIN}/api/health`]: () => HEALTH_OK,
      [`${LOCAL_API_ORIGIN}/api/token`]: () => new TypeError('fetch failed'),
    }),
    persist: makePersist(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'network');
});

test('失败：配置写入抛错 → save-failed，且不谎报成功', async () => {
  const result = await connectLocalServer({
    fetchImpl: makeFetch({
      [`${LOCAL_API_ORIGIN}/api/health`]: () => HEALTH_OK,
      [`${LOCAL_API_ORIGIN}/api/token`]: () => TOKEN_OK,
      [`${LOCAL_API_ORIGIN}/api/stats`]: () => STATS_OK,
    }),
    persist: makePersist(true),
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'save-failed');
  assert.match(result.message, /配置文件只读/);
});

// ── 成功路径 ──────────────────────────────────────────────

test('成功：探测 → 取令牌 → 落配置 → 两步校验，顺序与内容都对', async () => {
  const fetchImpl = makeFetch({
    [`${LOCAL_API_ORIGIN}/api/health`]: () => HEALTH_OK,
    [`${LOCAL_API_ORIGIN}/api/token`]: () => TOKEN_OK,
    [`${LOCAL_API_ORIGIN}/api/stats`]: () => STATS_OK,
  });
  const persist = makePersist();

  const result = await connectLocalServer({ fetchImpl, persist });

  assert.equal(result.ok, true, `应成功，实际：${JSON.stringify(result)}`);
  assert.equal(result.token, 'tok-abc');
  assert.equal(result.authRequired, true);
  assert.equal(result.serverVersion, '0.1.0');
  assert.equal(result.serverUrl, LOCAL_API_ORIGIN);

  // 配置确实被写入，且写入的地址是固定的本机地址（不是用户之前填错的）
  assert.deepEqual(persist.calls, [{ serverUrl: LOCAL_API_ORIGIN, token: 'tok-abc' }]);

  // 走的是既有 probeServer 的两步语义：health + stats 都被调用了
  const urls = fetchImpl.calls.map((call) => call.url);
  assert.ok(urls.some((url) => url.endsWith('/api/health')), '未探 health');
  assert.ok(urls.some((url) => url.endsWith('/api/stats')), '未做 token 校验（缺 /api/stats）');
  assert.ok(urls.some((url) => url.endsWith('/api/token')), '未取令牌');
});

test('成功：固定探 127.0.0.1:8730，不理会已配置的地址', async () => {
  const fetchImpl = makeFetch({
    [`${LOCAL_API_ORIGIN}/api/health`]: () => HEALTH_OK,
    [`${LOCAL_API_ORIGIN}/api/token`]: () => TOKEN_OK,
    [`${LOCAL_API_ORIGIN}/api/stats`]: () => STATS_OK,
  });

  await connectLocalServer({ fetchImpl, persist: makePersist() });

  // 所有请求都应发给本机固定入口
  for (const call of fetchImpl.calls) {
    assert.ok(
      call.url.startsWith(LOCAL_API_ORIGIN),
      `请求不该发往别处：${call.url}`,
    );
  }
});

test('成功：服务端未启用鉴权时如实标注 authRequired=false', async () => {
  const fetchImpl = makeFetch({
    [`${LOCAL_API_ORIGIN}/api/health`]: () => HEALTH_NO_AUTH,
    [`${LOCAL_API_ORIGIN}/api/token`]: () => ({
      status: 200,
      body: { token: 'tok-abc', authRequired: false },
    }),
    [`${LOCAL_API_ORIGIN}/api/stats`]: () => STATS_OK,
  });

  const result = await connectLocalServer({ fetchImpl, persist: makePersist() });
  assert.equal(result.ok, true);
  assert.equal(result.authRequired, false);
});

test('成功：落盘之后校验失败（token 无效）→ 报 token-denied 而不是 ok', async () => {
  const fetchImpl = makeFetch({
    [`${LOCAL_API_ORIGIN}/api/health`]: () => HEALTH_OK,
    [`${LOCAL_API_ORIGIN}/api/token`]: () => TOKEN_OK,
    // stats 401 → probeServer 会判定 tokenValid=false
    [`${LOCAL_API_ORIGIN}/api/stats`]: () => ({
      status: 401,
      body: { error: { code: 'UNAUTHORIZED', message: '令牌无效' } },
    }),
  });

  const result = await connectLocalServer({ fetchImpl, persist: makePersist() });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'token-denied');
});

// ── 文案 ──────────────────────────────────────────────────

test('文案：成功描述区分「令牌有效」与「未启用鉴权」', () => {
  const withAuth = describeLocalSuccess({
    ok: true,
    token: 'x',
    authRequired: true,
    serverVersion: '0.1.0',
    serverUrl: LOCAL_API_ORIGIN,
    probe: { cardCount: 3, latencyMs: 12 },
  });
  assert.match(withAuth, /已连接/);
  assert.match(withAuth, /0\.1\.0/);
  assert.match(withAuth, /令牌有效/);
  assert.match(withAuth, /3 张卡/);

  const noAuth = describeLocalSuccess({
    ok: true,
    token: 'x',
    authRequired: false,
    serverVersion: '0.1.0',
    serverUrl: LOCAL_API_ORIGIN,
    probe: { cardCount: null, latencyMs: null },
  });
  assert.match(noAuth, /未启用鉴权/);
  // 未启用鉴权时不该说"令牌有效"（会让人以为必须填对）
  assert.doesNotMatch(noAuth, /令牌有效/);
});

test('文案：每种失败分类都有非空 message 与至少一条 steps', () => {
  const kinds = ['not-running', 'port-changed', 'not-local', 'token-denied', 'network', 'save-failed'];
  for (const kind of kinds) {
    const failure = explainLocalFailure(kind);
    assert.equal(failure.ok, false);
    assert.ok(failure.message.length > 0, `${kind} 缺少 message`);
    assert.ok(failure.steps.length > 0, `${kind} 缺少 steps`);
    assert.equal(failure.kind, kind);
  }
});
