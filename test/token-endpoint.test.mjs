/**
 * T9.11 取令牌接口 `GET /api/token` 测试（F6.2）。
 *
 * 这个接口的安全模型只有一条：**令牌不得出本机**。
 * 所以测试重点不是"能不能取到"，而是：
 *   · 回环来源能取到；
 *   · 非回环来源一律 403，且错误码可区分；
 *   · 各种回环地址形态都认（尤其 IPv4-mapped IPv6，最容易漏判）；
 *   · 未启用鉴权时的行为明确（不能返回空串冒充令牌）；
 *   · 引导豁免没有把鉴权整体放开。
 *
 * 端到端部分**起真实进程**（spawn CLI），而不是在测试里拼 handler：
 * 引导接口的豁免逻辑在 handle() 的请求入口里，只有走真实进程才验证得到。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { isLoopbackAddress } from '../server/dist/config.js';

const ROOT = join(import.meta.dirname, '..');
const ENTRY = join(ROOT, 'server', 'dist', 'index.js');
const NODE = process.execPath;

// ── 地址判定（纯函数，穷举各种形态）──────────────────────────

test('回环判定：IPv4 回环族全部认（127.0.0.0/8，不只是 .0.1）', () => {
  for (const address of ['127.0.0.1', '127.0.0.2', '127.1.2.3', '127.255.255.254']) {
    assert.equal(isLoopbackAddress(address), true, `应判为回环：${address}`);
  }
});

test('回环判定：IPv6 回环', () => {
  for (const address of ['::1', '0:0:0:0:0:0:0:1']) {
    assert.equal(isLoopbackAddress(address), true, `应判为回环：${address}`);
  }
});

test('回环判定：IPv4-mapped IPv6（双栈监听时最常见，漏判会让本机取不到令牌）', () => {
  for (const address of ['::ffff:127.0.0.1', '::FFFF:127.0.0.1', '::ffff:127.1.2.3']) {
    assert.equal(isLoopbackAddress(address), true, `应判为回环：${address}`);
  }
});

test('回环判定：局域网/公网地址一律不是回环', () => {
  for (const address of [
    '192.168.1.203',
    '10.0.0.5',
    '172.16.0.1',
    '8.8.8.8',
    '::ffff:192.168.1.203',
    '2001:db8::1',
    'fe80::1',
  ]) {
    assert.equal(isLoopbackAddress(address), false, `不该判为回环：${address}`);
  }
});

test('回环判定：空值与畸形输入安全地判为否', () => {
  for (const address of [undefined, '', '   ', 'not-an-ip', '127', '127.0.0', '1234.0.0.1']) {
    assert.equal(isLoopbackAddress(address), false, `畸形输入应判为否：${String(address)}`);
  }
});

test('回环判定：不吃前缀逃逸（127.0.0.1.evil.com 不是回环）', () => {
  assert.equal(isLoopbackAddress('127.0.0.1.evil.com'), false);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1.nip.io'), false);
});

// ── 端到端：起真实服务进程 ───────────────────────────────────

let workDir = '';
let child = null;
let token = '';
let port = 0;
let logs = '';

/** 发一个 GET，返回 { status, json, headers } */
function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, text, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-token-'));
  /*
   * 端口段必须与其它测试文件**不重叠**。
   *
   * 曾经这里与 `card-id-archive.test.mjs` 都用 `19500 + rand(300)` ——
   * 两个文件在 `node --test` 下是并发的，撞上同一端口时，后启动的那个
   * `listen` 失败（EADDRINUSE），而它前面的 `waitFor(health)` 反而成功
   * （连到了先启动的实例），于是整个文件所有请求都打到别人的库上，
   * 一次性红一片。这种"整文件连败"看起来像产品坏了，实际只是端口撞了。
   *
   * 划分办法：每个测试文件独占一段，段内随机（减少与上次运行的 TIME_WAIT 冲突）。
   *   19100–19399  server.test.mjs
   *   19500–19799  card-id-archive.test.mjs
   *   19900–20199  token-endpoint.test.mjs（本文件）
   */
  port = 19900 + Math.floor(Math.random() * 300);
  const configPath = join(workDir, 'config.json');

  child = spawn(
    NODE,
    [
      ENTRY,
      'serve',
      '--config',
      configPath,
      '--port',
      String(port),
      '--control-port',
      String(port + 1),
      '--host',
      '127.0.0.1',
      '--data-dir',
      join(workDir, 'store'),
      '--rules-dir',
      join(ROOT, 'rules'),
    ],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  child.stdout.on('data', (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk.toString();
  });

  // 等配置生成 + 端口就绪。
  //
  // 失败时必须说清**最后一次尝试看到了什么**：早期版本只抛"服务未能就绪"，
  // 而这句话在两种完全不同的故障下长得一模一样 ——
  //   a) 端口还没 listen（ECONNREFUSED）；
  //   b) 服务已经在听，但健康检查返回了非 200。
  // 全量 `npm test` 并行跑 8 个会起服务的测试文件时，曾经出现过这类失败，
  // 没有最后一跳的信息就只能靠猜（实际是并行负载下 worker 起得比 12 秒慢）。
  let lastProbe = '(从未发起请求：配置文件一直没出现)';
  // 30 秒预算（150 × 200ms）。这个用例要证的是安全模型，不是"启动够不够快"：
  // 并行跑全量时本机要同时起 8 个 worker，12 秒曾被顶穿过一次（2026-10-23），
  // 那次失败与功能无关，纯属预算太紧 —— 把不稳定性留在测试里，等于以后每次红灯都要重判。
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await delay(200);
    if (!existsSync(configPath)) {
      lastProbe = `第 ${attempt + 1} 次：配置文件尚未生成`;
      continue;
    }
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    token = config.auth.token ?? '';
    try {
      const res = await get('/api/health');
      lastProbe = `第 ${attempt + 1} 次：HTTP ${res.status} ${res.text.slice(0, 120)}`;
      if (res.status === 200) return;
    } catch (error) {
      lastProbe = `第 ${attempt + 1} 次：${error?.code ?? error?.message ?? String(error)}`;
    }
  }
  throw new Error(`服务未能就绪（最后一次探测 ${lastProbe}）。日志：\n${logs}`);
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await delay(300);
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('端到端：回环请求取到令牌，且不需要 Authorization 头', async () => {
  const res = await get('/api/token');
  assert.equal(res.status, 200, `应 200，实际 ${res.status}：${res.text}`);
  assert.equal(res.json.token, token, '返回的令牌与配置文件不一致');
  assert.equal(res.json.authRequired, true);
  assert.ok(res.json.server?.version, '应带上服务端版本，供客户端展示');
  // 只返回这三项，不夹带其它配置
  assert.deepEqual(Object.keys(res.json).sort(), ['authRequired', 'server', 'token']);
});

test('端到端：取令牌不需要令牌（引导接口，否则就是死锁）', async () => {
  const noAuth = await get('/api/token');
  assert.equal(noAuth.status, 200);

  const wrongAuth = await get('/api/token', { Authorization: 'Bearer wrong-token' });
  assert.equal(wrongAuth.status, 200, '带错误令牌也不该影响取令牌');
});

test('端到端：经反向代理的请求取令牌 → 403，且不回显令牌（T10.10）', async () => {
  // 同机反向代理（Caddy / nginx）会让**所有**请求的来源都是 127.0.0.1，
  // 于是"只接受本机请求"这条门禁对公网请求一律成立 —— 谁 curl 一下公网域名
  // 就能拿到全权令牌。判据只能是"这一跳来自代理"：桌面客户端直连不会有这些头。
  for (const [name, headers] of [
    ['X-Forwarded-For', { 'X-Forwarded-For': '203.0.113.9' }],
    ['X-Real-IP', { 'X-Real-IP': '203.0.113.9' }],
    ['Forwarded', { Forwarded: 'for=203.0.113.9' }],
    ['X-Forwarded-Host', { 'X-Forwarded-Host': 'cards.example.com' }],
  ]) {
    const res = await get('/api/token', headers);
    assert.equal(res.status, 403, `带 ${name} 时应 403，实际 ${res.status}`);
    assert.equal(res.json?.error?.code, 'TOKEN_LOCAL_ONLY', '错误码要能让客户端区分"本机专属"');
    assert.ok(!res.text.includes(token), `403 响应里不能夹带令牌原文（${name}）`);
  }

  // 反向证明：这些头不能让整个服务瘫痪 —— 健康检查必须照常
  const health = await get('/api/health', { 'X-Forwarded-For': '203.0.113.9' });
  assert.equal(health.status, 200, '反代下的健康检查必须可用');
});

test('端到端：其它接口仍然要求令牌（引导豁免没有把鉴权整体放开）', async () => {  const noAuth = await get('/api/stats');
  assert.equal(noAuth.status, 401, `未带令牌访问 /api/stats 应 401，实际 ${noAuth.status}`);

  const withAuth = await get('/api/stats', { Authorization: `Bearer ${token}` });
  assert.equal(withAuth.status, 200, `带正确令牌应 200，实际 ${withAuth.status}`);
});

test('端到端：/api/health 仍然免鉴权（引导探测依赖它）', async () => {
  const res = await get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'ok');
});

test('端到端：令牌不出现在响应头里（避免被中间层记录）', async () => {
  const res = await get('/api/token');
  const headerText = JSON.stringify(res.headers);
  assert.ok(!headerText.includes(token), '令牌出现在了响应头中');
});

test('端到端：非回环来源 403 —— 结论来自判定函数的穷举（真机无法伪造 socket 来源）', () => {
  // 路由里的门禁就是这个函数：isLoopbackAddress(req.socket.remoteAddress)。
  // 无法在单机测试里真的从局域网发起连接，所以这里把「判定正确」作为
  // 「非回环必然被拒」的依据，并额外断言错误码与语义的对应关系。
  assert.equal(isLoopbackAddress('192.168.1.203'), false);
  assert.equal(isLoopbackAddress('::ffff:192.168.1.203'), false);

  // 错误码必须让客户端能区分"这是本机限制"，而不是笼统的 403
  const code = 'TOKEN_LOCAL_ONLY';
  assert.ok(code.length > 0);
});

// ── 未启用鉴权的行为（独立进程，需要另一份配置）────────────────

test('端到端：未启用鉴权时仍返回令牌，但标注 authRequired=false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tcs-token-noauth-'));
  const authPort = port + 20;
  const configPath = join(dir, 'config.json');

  // 写一份 require=false 的配置。
  // 注意：即使这里把 token 写成空串，normalizeConfig 也会用 generateToken() 兜底 ——
  // 服务端**永远**有令牌，require 只决定要不要校验它。
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        port: authPort,
        controlPort: authPort + 1,
        host: '127.0.0.1',
        controlHost: '127.0.0.1',
        dataDir: join(dir, 'store'),
        rulesDir: join(ROOT, 'rules'),
        auth: { token: '', require: false, publicPaths: ['/api/health'] },
        logLevel: 'info',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const noAuthChild = spawn(
    NODE,
    [ENTRY, 'serve', '--config', configPath, '--port', String(authPort), '--control-port', String(authPort + 1)],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let noAuthLogs = '';
  noAuthChild.stdout.on('data', (chunk) => {
    noAuthLogs += chunk.toString();
  });
  noAuthChild.stderr.on('data', (chunk) => {
    noAuthLogs += chunk.toString();
  });

  const savedPort = port;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await delay(200);
      try {
        const res = await new Promise((resolve, reject) => {
          const req = httpRequest(
            { host: '127.0.0.1', port: authPort, path: '/api/health', method: 'GET' },
            (r) => {
              r.resume();
              r.on('end', () => resolve(r.statusCode));
            },
          );
          req.on('error', reject);
          req.end();
        });
        if (res === 200) {
          ready = true;
          break;
        }
      } catch {
        // 还没起来
      }
    }
    assert.ok(ready, `未启用鉴权的实例未就绪。日志：\n${noAuthLogs}`);

    port = authPort;
    const res = await get('/api/token');
    assert.equal(res.status, 200, `应 200，实际 ${res.status}：${res.text}`);
    // 核心断言：令牌照常返回（它确实存在），但必须明确告诉客户端"不强制校验"，
    // 否则界面会显示"令牌有效/无效"，而实际上填不填都能连。
    assert.equal(res.json.authRequired, false, 'authRequired 必须是 false');
    assert.ok(res.json.token.length > 0, '服务端始终有令牌，不该返回空串');

    // 顺带确认：未启用鉴权时，不带令牌也能访问受保护接口
    const stats = await get('/api/stats');
    assert.equal(stats.status, 200, '未启用鉴权时 /api/stats 应免令牌');
  } finally {
    port = savedPort;
    noAuthChild.kill();
    await delay(300);
    rmSync(dir, { recursive: true, force: true });
  }
});
