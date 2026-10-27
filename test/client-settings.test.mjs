/**
 * 设置面板与连接探测（T6.8）测试。
 *
 * 探测函数接受注入的 `fetch`，所以不需要真起服务端就能覆盖所有分支：
 *   可达 / 不可达 / 非本服务 / 要求鉴权但没填 token / token 错 / token 对 / 超时。
 *
 * 重点验证的是"反馈是否准确"——把 token 错误报成"已连接"是这类面板最常见的坑。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isSyncReady,
  normalizeServerUrl,
  probeServer,
} from '../client/src/net/server-probe.ts';

// ── URL 归一化 ───────────────────────────────────────────────

test('URL：常见写法都能归一化', () => {
  const cases = [
    ['http://127.0.0.1:8730', 'http://127.0.0.1:8730'],
    ['http://127.0.0.1:8730/', 'http://127.0.0.1:8730'],
    ['http://127.0.0.1:8730///', 'http://127.0.0.1:8730'],
    ['127.0.0.1:8730', 'http://127.0.0.1:8730'],
    ['192.168.1.20:8730', 'http://192.168.1.20:8730'],
    ['https://card.example.com', 'https://card.example.com'],
    ['  https://card.example.com/  ', 'https://card.example.com'],
    ['http://nas.local:8730/api', 'http://nas.local:8730/api'],
  ];
  for (const [input, expected] of cases) {
    const result = normalizeServerUrl(input);
    assert.equal(result.ok, true, `应接受：${input}`);
    assert.equal(result.url, expected, `归一化错误：${input}`);
  }
});

test('URL：空值与非法协议被拒绝，且给出原因', () => {
  const empty = normalizeServerUrl('   ');
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'empty');

  for (const bad of ['file:///C:/secret.json', 'javascript:alert(1)', 'ftp://host/x']) {
    const result = normalizeServerUrl(bad);
    assert.equal(result.ok, false, `应拒绝：${bad}`);
    assert.equal(result.reason, 'bad-scheme');
  }
});

test('URL：局域网与域名都保留原有主机', () => {
  for (const host of ['192.168.1.20', '10.0.0.5', '172.16.3.9', 'card.example.com', 'nas.local']) {
    const result = normalizeServerUrl(`${host}:8730`);
    assert.equal(result.ok, true);
    assert.match(result.url, new RegExp(`^http://${host.replace(/\./g, '\\.')}:8730$`));
  }
});

// ── 假 fetch：按 URL 返回预设响应 ────────────────────────────

function makeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, headers: init.headers ?? {} });
    const key = String(url);
    const handler = routes[key];
    if (!handler) {
      throw new TypeError(`unexpected request: ${key}`);
    }
    return handler(init);
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const HEALTH_OK = { status: 'ok', version: '0.1.0', authRequired: true };

test('探测：连不上时报"不可达"，且不误报 token 状态', async () => {
  const fetchImpl = makeFetch({
    'http://127.0.0.1:8730/api/health': () => {
      throw new TypeError('Failed to fetch');
    },
  });
  const result = await probeServer({ serverUrl: '127.0.0.1:8730', token: 'x' }, { fetchImpl });

  assert.equal(result.reachable, false);
  assert.equal(result.tokenValid, null);
  assert.equal(result.stage, 'health');
  assert.match(result.message, /无法连接/);
  assert.equal(isSyncReady(result), false);
});

test('探测：地址不是本服务端时给出明确提示', async () => {
  const fetchImpl = makeFetch({
    'http://127.0.0.1:9999/api/health': () => new Response('<html>nginx</html>', { status: 200 }),
  });
  const result = await probeServer({ serverUrl: 'http://127.0.0.1:9999', token: '' }, { fetchImpl });

  assert.equal(result.reachable, false);
  assert.equal(result.stage, 'health');
  // 断言"说清了这可能不是本服务端"，不锁死具体措辞 ——
  // 文案会随界面规范化调整，锁原文等于让测试替旧措辞作保
  assert.match(result.message, /无法识别|不是本服务端|不是 Tavern Card Studio/);
});

test('探测：health.status 不是 ok 时不认作已连接', async () => {
  const fetchImpl = makeFetch({
    'http://h:1/api/health': () => jsonResponse({ status: 'degraded' }),
  });
  const result = await probeServer({ serverUrl: 'http://h:1', token: '' }, { fetchImpl });

  assert.equal(result.reachable, false);
  assert.match(result.message, /状态异常/);
});

test('探测：未填 token → 可达但未登录（不是失败）', async () => {
  const fetchImpl = makeFetch({
    'http://h:1/api/health': () => jsonResponse(HEALTH_OK),
  });
  const result = await probeServer({ serverUrl: 'http://h:1', token: '   ' }, { fetchImpl });

  assert.equal(result.reachable, true);
  assert.equal(result.authRequired, true);
  assert.equal(result.tokenValid, null);
  assert.equal(result.stage, 'auth');
  // v0.1.2 追加任务：措辞从「要求鉴权：未填写 token」改成「未登录」——
  // 前者把还没登录说成服务端在索要凭证，正是本次要修的错序表述
  assert.match(result.message, /未登录/);
  assert.doesNotMatch(result.message, /未填写 token/);
  assert.equal(isSyncReady(result), false);
});

test('探测：token 错误 → 明确 401，且不显示已连接', async () => {
  const fetchImpl = makeFetch({
    'http://h:1/api/health': () => jsonResponse(HEALTH_OK),
    'http://h:1/api/stats': () => jsonResponse({ error: { code: 'UNAUTHORIZED' } }, 401),
  });
  const result = await probeServer({ serverUrl: 'http://h:1', token: 'wrong' }, { fetchImpl });

  assert.equal(result.reachable, true);
  assert.equal(result.tokenValid, false);
  assert.equal(result.stage, 'auth');
  assert.match(result.message, /令牌无效|token 无效/);
  assert.equal(isSyncReady(result), false);
});

test('探测：token 正确 → 同步就绪，并带上卡片数', async () => {
  const fetchImpl = makeFetch({
    'http://h:1/api/health': () => jsonResponse(HEALTH_OK),
    'http://h:1/api/stats': () => jsonResponse({ cards: { total: 7 } }),
  });
  const result = await probeServer({ serverUrl: 'http://h:1', token: 'good' }, { fetchImpl });

  assert.equal(result.reachable, true);
  assert.equal(result.tokenValid, true);
  assert.equal(result.cardCount, 7);
  assert.equal(result.stage, 'ok');
  assert.match(result.message, /token 有效/);
  assert.match(result.message, /7 张卡/);
  assert.equal(isSyncReady(result), true);

  // 必须带 Bearer 头
  const statsCall = fetchImpl.calls.find((call) => call.url.endsWith('/api/stats'));
  assert.equal(statsCall.headers.Authorization, 'Bearer good');
});

test('探测：服务端不需要鉴权时不请求 /api/stats，也算同步就绪', async () => {
  const fetchImpl = makeFetch({
    'http://h:1/api/health': () => jsonResponse({ status: 'ok', version: '0.1.0', authRequired: false }),
  });
  const result = await probeServer({ serverUrl: 'http://h:1', token: '' }, { fetchImpl });

  assert.equal(result.reachable, true);
  assert.equal(result.authRequired, false);
  assert.equal(isSyncReady(result), true);
  assert.equal(fetchImpl.calls.length, 1, '不应再请求受保护接口');
});

test('探测：超时被兜住，不无限悬挂', async () => {
  const fetchImpl = async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  };
  const result = await probeServer(
    { serverUrl: 'http://h:1', token: 'x' },
    { fetchImpl, timeoutMs: 50 },
  );

  assert.equal(result.reachable, false);
  assert.match(result.message, /超时/);
});

test('探测：URL 非法时一次请求都不发', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error('should not be called');
  };
  const result = await probeServer({ serverUrl: '', token: 'x' }, { fetchImpl });

  assert.equal(result.stage, 'url');
  assert.equal(result.reachable, false);
  assert.equal(called, false, '空地址不应触发网络请求');
});

test('isSyncReady：null 与不可达一律 false', () => {
  assert.equal(isSyncReady(null), false);
  assert.equal(
    isSyncReady({
      reachable: false,
      version: null,
      authRequired: null,
      tokenValid: null,
      cardCount: null,
      latencyMs: null,
      url: null,
      message: '',
      stage: 'health',
    }),
    false,
  );
});
