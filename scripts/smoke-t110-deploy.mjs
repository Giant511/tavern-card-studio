/**
 * v0.1.2 追加任务：反向代理穿透 `/api/token` 回环门禁的正式修复 —— 真进程验证。
 *
 * 背景：同机反代时 `socket.remoteAddress` 恒为 `127.0.0.1`，于是"只接受本机请求"
 * 这条门禁对**所有公网请求**成立。止血版"见到代理头就拒"堵上了洞，但把
 * "反代 + 真实 IP" 这条正确路径一起废掉（连本机经代理都取不到令牌，且无法按真实 IP 限速）。
 *
 * 本脚本用**真的反向代理**（自己追加 `X-Forwarded-For`，与 Caddy/nginx 默认行为一致）
 * 逐条验证新方案 `trustProxy`：
 *
 *   ① 同机反代 + trustProxy 空 → 403（**修复前的洞，作为回归用例**）
 *   ② 同机反代 + trustProxy 登记了代理 → 公网真实 IP 非回环 → 403；
 *      回环真实 IP（本机经反代）→ 200
 *   ③ 客户端自带 XFF（伪造）+ 反代追加 → 取「最右侧非信任条目」，伪造无效
 *   ④ 限速按**有效 IP** 分桶：经同一反代的两个不同真实 IP 独立计数
 *   ⑤ 白名单用 CIDR 形式（127.0.0.0/8、::1/128）
 *   ⑥ 未登记信任时的旧行为对照：两人共用一个桶（证明 ④ 不是碰巧）
 *
 * 用法：node scripts/smoke-t110-deploy.mjs
 */

import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' —— ' + detail : ''}`);
};

const TOKEN = 't110-deploy-legacy-token-aaaaaaaaaaaaaaaaaaaa';
const BASE_PORT = 23600 + Math.floor(Math.random() * 200);

const dirs = [];
const children = [];
const proxies = [];

function writeConfig(dir, port, trustProxy) {
  const path = join(dir, 'config.json');
  writeFileSync(
    path,
    JSON.stringify(
      {
        schemaVersion: 1,
        port,
        controlPort: port + 2,
        host: '127.0.0.1',
        controlHost: '127.0.0.1',
        dataDir: join(dir, 'store'),
        rulesDir: 'rules',
        defaultPlatformRule: 'sillytavern',
        defaultPreset: 'default',
        maxUploadBytes: 33554432,
        // info：B⓪ 要验启动日志是否写明了信任表（warn 级别下 info 行不会输出）
        logLevel: 'info',
        // 反代终止 TLS 的形态：业务侧明文，但只在回环上
        tls: { mode: 'off', httpsPort: port + 1000, certPath: '', keyPath: '' },
        trustProxy,
        auth: {
          token: TOKEN,
          require: true,
          publicPaths: ['/api/health'],
          // 限速用例需要一个"密码正确"的对照组账户，所以这一份配置开放注册。
          // 这是测试实例，不是生产推荐（生产用 admin-only，见 docs/33 §2.3）。
          registerMode: 'open',
          jwtSecret: 't110-deploy-jwt-secret-aaaaaaaaaaaaaaaaaaaaa',
        },
        service: { mode: 'process', name: 'T110D', displayName: 'T110D', autoStart: false },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  return path;
}

function startWorker(configPath) {
  const child = spawn(process.execPath, ['server/dist/index.js', 'worker', '--config', configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = { out: '', err: '' };
  child.stdout.on('data', (d) => (logs.out += String(d)));
  child.stderr.on('data', (d) => {
    logs.err += String(d);
    const text = String(d);
    if (!/ExperimentalWarning|DeprecationWarning/.test(text)) process.stderr.write(`[srv] ${text}`);
  });
  children.push(child);
  return { child, logs };
}

/**
 * 反向代理：**追加** X-Forwarded-For（不是覆盖）。
 *
 * 这一点是刻意的 —— 真实代理（Caddy/nginx）都是"在已有头后面追加自己看到的对端"，
 * 所以客户端伪造的左侧条目会被保留。我们要验证的正是"服务端从右往左取"，
 * 用覆盖式的假代理就测不到这条。
 */
function startProxy(upstreamPort, appendAddress) {
  const server = createServer((req, res) => {
    const headers = { ...req.headers };
    const existing = headers['x-forwarded-for'];
    headers['x-forwarded-for'] = existing ? `${existing}, ${appendAddress}` : appendAddress;
    headers['x-forwarded-host'] = headers['host'] ?? '';
    const upstream = httpRequest(
      { host: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end('bad gateway');
    });
    req.pipe(upstream);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      proxies.push(server);
      resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 });
    });
  });
}

async function get(url, headers = {}, method = 'GET', body) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

async function waitReady(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${String(port)}/api/health`)).ok) return true;
    } catch {
      /* 还没起 */
    }
    await delay(150);
  }
  return false;
}

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return null;
}

try {
  // ── 实例 A：trustProxy 空（默认安全姿态）────────────────────
  {
    const dir = mkdtempSync(join(tmpdir(), 'tcs-t110-a-'));
    dirs.push(dir);
    const port = BASE_PORT;
    const worker = startWorker(writeConfig(dir, port, []));
    const ready = await waitReady(port);
    check('实例 A（trustProxy=[]）就绪', ready, `port=${String(port)}`);
    if (!ready) throw new Error('实例 A 没起来，后续断言无意义');

    const direct = await get(`http://127.0.0.1:${String(port)}/api/token`);
    check('A① 本机直连取令牌 → 200（客户端一键连接仍可用）', direct.status === 200, `status=${String(direct.status)}`);
    check('A① 返回的确实是令牌', direct.text.includes(TOKEN));

    // ① 回归：这就是修复前泄漏的那个场景
    const proxyA = await startProxy(port, '203.0.113.9');
    const viaProxy = await get(`http://127.0.0.1:${String(proxyA.port)}/api/token`);
    check(
      'A② 回归：同机反代 + trustProxy 空 → 403（修复前的洞）',
      viaProxy.status === 403,
      `status=${String(viaProxy.status)}`,
    );
    check('A② 403 不含令牌原文（不能"拒绝但顺手回显"）', !viaProxy.text.includes(TOKEN));
    check(
      'A② 拒绝原因点名"未登记在 trustProxy"（给出可执行的修法）',
      /未登记在 trustProxy/.test(viaProxy.text),
      viaProxy.json?.error?.message?.slice(0, 80) ?? '',
    );

    // 直连但自己伪造代理头：同样拒绝（判据是"有代理跳"，不看值）
    for (const [name, header] of [
      ['X-Forwarded-For', { 'X-Forwarded-For': '127.0.0.1' }],
      ['X-Real-IP', { 'X-Real-IP': '127.0.0.1' }],
      ['Forwarded', { Forwarded: 'for=127.0.0.1' }],
    ]) {
      const forged = await get(`http://127.0.0.1:${String(port)}/api/token`, header);
      check(`A③ 直连伪造 ${name} → 403`, forged.status === 403, `status=${String(forged.status)}`);
    }

    // 反代下其它接口不受影响
    const healthViaProxy = await get(`http://127.0.0.1:${String(proxyA.port)}/api/health`);
    check('A④ 经反代访问 /api/health → 200（没把整个服务误伤）', healthViaProxy.status === 200,
      `status=${String(healthViaProxy.status)}`);
    const statsNoAuth = await get(`http://127.0.0.1:${String(proxyA.port)}/api/stats`);
    check('A④ 经反代无令牌仍 401', statsNoAuth.status === 401, `status=${String(statsNoAuth.status)}`);

    // 只监听回环：网卡 IP 不可达
    const lan = lanAddress();
    if (lan !== null) {
      let reachable = false;
      try {
        reachable = (await get(`http://${lan}:${String(port)}/api/health`)).status === 200;
      } catch {
        reachable = false;
      }
      check('A⑤ host=127.0.0.1 时用网卡 IP 不可达', !reachable, `lan=${lan}`);
    }
  }

  // ── 实例 B：trustProxy 用 CIDR 形式登记本机 ────────────────
  {
    const dir = mkdtempSync(join(tmpdir(), 'tcs-t110-b-'));
    dirs.push(dir);
    const port = BASE_PORT + 10;
    const worker = startWorker(writeConfig(dir, port, ['127.0.0.0/8', '::1/128']));
    const ready = await waitReady(port);
    check('实例 B（trustProxy=["127.0.0.0/8","::1/128"]）就绪', ready, `port=${String(port)}`);
    if (!ready) throw new Error('实例 B 没起来');

    // 日志要打印信任表，运维不必翻配置
    check(
      'B⓪ 启动日志写明信任表',
      /127\.0\.0\.0\/8/.test(worker.logs.out) && /trustProxy/.test(worker.logs.out),
      '',
    );

    const publicProxy = await startProxy(port, '203.0.113.9');
    const publicPeek = await get(`http://127.0.0.1:${String(publicProxy.port)}/api/token`);
    check(
      'B① 已登记代理 + 公网真实 IP → 403（真实来源不是回环）',
      publicPeek.status === 403,
      `status=${String(publicPeek.status)}`,
    );
    check(
      'B① 报错里给出有效地址（诊断不必再猜）',
      publicPeek.json?.error?.details?.effectiveAddress === '203.0.113.9',
      JSON.stringify(publicPeek.json?.error?.details ?? {}),
    );

    const loopProxy = await startProxy(port, '127.0.0.1');
    const loopPeek = await get(`http://127.0.0.1:${String(loopProxy.port)}/api/token`);
    check(
      'B② 已登记代理 + 回环真实 IP（本机经反代）→ 200',
      loopPeek.status === 200,
      `status=${String(loopPeek.status)}`,
    );

    // ③ XFF 伪造：客户端自带一段，反代在右边追加真实来源
    const forgeProxy = await startProxy(port, '203.0.113.9');
    const forged = await get(`http://127.0.0.1:${String(forgeProxy.port)}/api/token`, {
      // 伪造"我是本机"，希望门禁放行
      'X-Forwarded-For': '127.0.0.1',
    });
    check(
      'B③ 客户端伪造 XFF=127.0.0.1 + 反代追加真实 IP → 仍 403（取最右侧非信任条目）',
      forged.status === 403,
      `status=${String(forged.status)}`,
    );
    check(
      'B③ 有效地址是反代追加的那一段，不是客户端伪造的那一段',
      forged.json?.error?.details?.effectiveAddress === '203.0.113.9',
      `effective=${String(forged.json?.error?.details?.effectiveAddress)}`,
    );

    // 链里塞垃圾 → fail-closed
    const junkProxy = await startProxy(port, 'not-an-ip');
    const junk = await get(`http://127.0.0.1:${String(junkProxy.port)}/api/token`);
    check(
      'B④ XFF 链含无法解析条目 → 403（fail-closed）',
      junk.status === 403 && /无法解析/.test(junk.text),
      `status=${String(junk.status)}`,
    );

    // 面板/统计用的代理状态
    const stats = await get(`http://127.0.0.1:${String(port)}/api/stats`, { Authorization: `Bearer ${TOKEN}` });
    // 注意 `::1/128` 会被规范化成 `::1`（单主机前缀不写出来，与 `127.0.0.1` 形态一致）。
    // 这不是丢信息：两者语义相同，规范化换来的是"不会因为写法不同而存成两条规则"。
    check(
      'B⑤ /api/stats 下发 proxy.entries 与规范化后的规则',
      stats.json?.proxy?.entries === 2 && JSON.stringify(stats.json?.proxy?.rules) === '["127.0.0.0/8","::1"]',
      JSON.stringify(stats.json?.proxy ?? {}),
    );
    check(
      'B⑤ /api/stats 的 trustedProxies 记录了真正生效的对端（127.0.0.1）',
      (stats.json?.proxy?.trustedProxies ?? []).some((item) => item.address === '127.0.0.1' && item.hits > 0),
      JSON.stringify(stats.json?.proxy?.trustedProxies ?? []),
    );

    // ④ 限速按有效 IP 分桶
    //
    // 可观测性上的一个坑：**锁定期间返回的仍是 401，不是 429**。
    // 这是刻意的（`auth/service.ts` 的注释：返回 429 等于告诉攻击者
    // "你成功触发了锁定"，就变成新的侧信道）。所以不能靠状态码判断是否被锁，
    // 改用"**密码正确却仍被拒**"这个动作来观测 —— 它只在锁定态出现。
    const alice = { username: 'alice-limit', password: 'alice-password-1' };
    const registered = await get(`http://127.0.0.1:${String(port)}/api/auth/register`, {}, 'POST', alice);
    check(
      'B⑥ 准备：注册对照账户（用于"密码正确仍被拒"的观测）',
      registered.status === 201,
      `status=${String(registered.status)}`,
    );

    const loginVia = (proxyPort, username, password) =>
      get(`http://127.0.0.1:${String(proxyPort)}/api/auth/login`, {}, 'POST', { username, password });

    const proxyA = await startProxy(port, '198.51.100.11');
    const proxyB = await startProxy(port, '198.51.100.22');

    // 5 次失败全部走 IP-A，且用**不同的用户名** —— 否则账户维度会先被锁，
    // 那就分不清到底是"按 IP 锁"还是"按账户锁"了。
    const attempts = [];
    for (let index = 0; index < 5; index += 1) {
      attempts.push((await loginVia(proxyA.port, `ghost-${String(index)}`, 'wrong-password-xyz')).status);
    }
    check(
      'B⑥ 真实 IP 198.51.100.11 连续 5 次失败 → 每次都是 401',
      attempts.every((status) => status === 401),
      JSON.stringify(attempts),
    );

    const lockedCorrect = await loginVia(proxyA.port, alice.username, alice.password);
    check(
      'B⑥ 该 IP 下用**正确密码**也登不进（401，锁定生效）',
      lockedCorrect.status === 401,
      `status=${String(lockedCorrect.status)}`,
    );

    // 同一反代后面的**另一个**真实 IP 不受影响 —— 这就是"按有效 IP 限速"
    const otherOk = await loginVia(proxyB.port, alice.username, alice.password);
    check(
      'B⑦ 同一反代后的另一个真实 IP（198.51.100.22）用正确密码**能**登进（200）',
      otherOk.status === 200,
      `status=${String(otherOk.status)}`,
    );
    check(
      'B⑦ 返回的是该账户自己的 access token',
      typeof otherOk.json?.accessToken === 'string' && otherOk.json.accessToken.length > 0,
      '',
    );
  }

  // ── 实例 C：对照 —— trustProxy 空时两人共用一个桶 ───────────
  //
  // 这一组存在的意义：证明 B⑦ 不是"限速根本没生效"的假通过。
  // 同样的两个真实 IP、同样的失败次数，只是不登记代理 → 必须一起被锁。
  {
    const dir = mkdtempSync(join(tmpdir(), 'tcs-t110-c-'));
    dirs.push(dir);
    const port = BASE_PORT + 20;
    const worker = startWorker(writeConfig(dir, port, []));
    const ready = await waitReady(port);
    check('实例 C（trustProxy=[] 对照组）就绪', ready, `port=${String(port)}`);
    if (!ready) throw new Error('实例 C 没起来');

    const proxiesC = [await startProxy(port, '198.51.100.11'), await startProxy(port, '198.51.100.22')];
    const loginC = (proxyPort, username, password) =>
      get(`http://127.0.0.1:${String(proxyPort)}/api/auth/login`, {}, 'POST', { username, password });

    const bob = { username: 'bob-limit', password: 'bob-password-1' };
    const registeredC = await get(`http://127.0.0.1:${String(port)}/api/auth/register`, {}, 'POST', bob);
    check('C⓪ 准备：注册对照账户', registeredC.status === 201, `status=${String(registeredC.status)}`);

    // 4 次走真实 IP-A，1 次走真实 IP-B —— 但未登记信任时两者都归到 127.0.0.1
    for (let index = 0; index < 4; index += 1) {
      await loginC(proxiesC[0].port, `void-${String(index)}`, 'wrong-password-xyz');
    }
    await loginC(proxiesC[1].port, 'void-fifth', 'wrong-password-xyz');

    const lockedC = await loginC(proxiesC[1].port, bob.username, bob.password);
    check(
      'C① 未登记信任时两个真实 IP 共用一个桶（4+1 次即锁）→ 正确密码也被拒',
      lockedC.status === 401,
      `status=${String(lockedC.status)}`,
    );
    const lockedC2 = await loginC(proxiesC[0].port, bob.username, bob.password);
    check(
      'C② 另一条真实 IP 也被一起锁住（这就是"限速全局化"）',
      lockedC2.status === 401,
      `status=${String(lockedC2.status)}`,
    );
  }
} finally {
  for (const server of proxies) {
    try {
      server.close();
    } catch {
      /* 已关闭 */
    }
  }
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
  }
  await delay(400);
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 偶发占用 */
    }
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n合计 ${String(results.length)} 项，失败 ${String(failed.length)} 项`);
  if (failed.length > 0) {
    console.log('\n失败项：');
    for (const item of failed) console.log(`  ✘ ${item.name}${item.detail ? ' —— ' + item.detail : ''}`);
    process.exitCode = 1;
  }
}
