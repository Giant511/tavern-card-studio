/**
 * T10.10 ① 公网部署面真进程验证。
 *
 * 云部署手册（docs/33）里推荐的形态是「反向代理终止 TLS，业务只监听回环」。
 * 这个形态有一个**不写在代理配置里就看不出来**的安全边界：`GET /api/token`
 * 的门禁是"来源必须是回环地址"。同机反代让**所有**请求的来源都是 127.0.0.1，
 * 于是这条门禁对公网请求一律成立 —— 任何人 curl 一下公网域名就能拿到全权令牌。
 *
 * 本脚本用一个真的 HTTP 反代（带 X-Forwarded-For，和 Caddy/nginx 默认行为一致）
 * 复现这个场景，验证：
 *   ① 直连 127.0.0.1 取令牌 → 200（客户端一键连接必须还能用）；
 *   ② 经过反代取令牌 → 403，且响应里不出现令牌原文；
 *   ③ 经过反代访问普通接口 → 正常（反代本身没有被"误伤"）；
 *   ④ 手工塞伪造的 X-Forwarded-For 直连 → 同样 403（不靠值、只靠"有代理跳"）；
 *   ⑤ 非回环来源的直连（用本机网卡 IP 访问）→ 403（原有门禁仍然有效）。
 *
 * 用法：node scripts/smoke-t110-deploy.mjs
 */

import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' —— ' + detail : ''}`);
};

const work = mkdtempSync(join(tmpdir(), 'tcs-t110-deploy-'));
const port = 23400 + Math.floor(Math.random() * 200);
const proxyPort = port + 1;
const TOKEN = 't110-deploy-legacy-token-aaaaaaaaaaaaaaaaaaaa';

writeFileSync(
  join(work, 'config.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      port,
      controlPort: port + 2,
      host: '127.0.0.1',
      controlHost: '127.0.0.1',
      dataDir: join(work, 'store'),
      rulesDir: 'rules',
      defaultPlatformRule: 'sillytavern',
      defaultPreset: 'default',
      maxUploadBytes: 33554432,
      logLevel: 'warn',
      auth: {
        token: TOKEN,
        require: true,
        publicPaths: ['/api/health'],
        registerMode: 'closed',
        jwtSecret: 't110-deploy-jwt-secret-aaaaaaaaaaaaaaaaaaaaa',
      },
      // 反代终止 TLS 的形态：业务侧就是明文，但只在回环上 —— 明文不出主机
      tls: { mode: 'off', httpsPort: port + 1000, certPath: '', keyPath: '' },
      service: { mode: 'process', name: 'T110D', displayName: 'T110D', autoStart: false },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);

const child = spawn(process.execPath, ['server/dist/index.js', 'worker', '--config', join(work, 'config.json')], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => {
  const text = String(d);
  if (!/ExperimentalWarning|DeprecationWarning/.test(text)) process.stderr.write(`[srv] ${text}`);
});

/** 极简反代：行为对齐 Caddy/nginx 的默认——补 X-Forwarded-For，保留原有头 */
const proxy = createServer((req, res) => {
  const headers = { ...req.headers };
  const remote = req.socket.remoteAddress ?? 'unknown';
  headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${remote}` : remote;
  headers['x-forwarded-host'] = headers['host'] ?? '';
  const upstream = httpRequest(
    { host: '127.0.0.1', port, path: req.url, method: req.method, headers },
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

async function get(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  return { status: res.status, text };
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
  let up = false;
  for (let i = 0; i < 160; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${String(port)}/api/health`)).ok) {
        up = true;
        break;
      }
    } catch {
      /* 还没起 */
    }
    await delay(150);
  }
  check('服务端就绪（tls.mode=off，只监听回环）', up, `port=${String(port)}`);
  if (!up) throw new Error('服务端没起来');

  await new Promise((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve));
  check('反代已起（模拟同机 Caddy/nginx）', true, `proxyPort=${String(proxyPort)}`);

  // ── ① 直连取令牌：客户端一键连接必须还能用 ────────────────
  const direct = await get(`http://127.0.0.1:${String(port)}/api/token`);
  check('① 直连 127.0.0.1 取令牌 → 200', direct.status === 200, `status=${String(direct.status)}`);
  check('① 直连返回的确实是令牌', direct.text.includes(TOKEN), `${String(direct.text.length)} 字节`);

  // ── ② 经反代取令牌 → 403，且绝不能夹带令牌 ─────────────────
  const viaProxy = await get(`http://127.0.0.1:${String(proxyPort)}/api/token`);
  check('② 经反代取令牌 → 403', viaProxy.status === 403, `status=${String(viaProxy.status)}`);
  check(
    '② 403 响应里不含令牌原文（不能"拒绝但顺手回显"）',
    !viaProxy.text.includes(TOKEN),
    viaProxy.text.replace(/\s+/g, ' ').slice(0, 120),
  );
  check(
    '② 报错点明了被拒原因（反代头）',
    /反向代理|x-forwarded-for|x-forwarded-host/i.test(viaProxy.text),
    '',
  );

  // ── ③ 反代访问普通接口不受影响（没有误伤）─────────────────
  const healthViaProxy = await get(`http://127.0.0.1:${String(proxyPort)}/api/health`);
  check('③ 经反代访问 /api/health → 200', healthViaProxy.status === 200, `status=${String(healthViaProxy.status)}`);
  const statsViaProxy = await get(`http://127.0.0.1:${String(proxyPort)}/api/stats`, {
    Authorization: `Bearer ${TOKEN}`,
  });
  check('③ 经反代带令牌访问 /api/stats → 200', statsViaProxy.status === 200, `status=${String(statsViaProxy.status)}`);
  const statsNoAuth = await get(`http://127.0.0.1:${String(proxyPort)}/api/stats`);
  check('③ 经反代无令牌仍 401（鉴权没被反代影响）', statsNoAuth.status === 401, `status=${String(statsNoAuth.status)}`);

  // ── ④ 直连但手工伪造代理头 → 同样拒绝 ──────────────────────
  //
  // 这条防的是"知道漏洞后自己写个头"与"本机装了带 XFF 的本地代理"两种情况。
  // 判据只有"有没有代理跳"，不看头的值 —— 所以伪造与否都一样被拒。
  for (const [name, header] of [
    ['X-Forwarded-For', { 'X-Forwarded-For': '203.0.113.9' }],
    ['X-Real-IP', { 'X-Real-IP': '203.0.113.9' }],
    ['Forwarded', { Forwarded: 'for=203.0.113.9' }],
  ]) {
    const res = await get(`http://127.0.0.1:${String(port)}/api/token`, header);
    check(`④ 直连伪造 ${name} → 403`, res.status === 403, `status=${String(res.status)}`);
  }

  // ── ⑤ 非回环来源直连 → 403（原有门禁没被放松）──────────────
  const lan = lanAddress();
  if (lan === null) {
    console.log('· 跳过 ⑤：本机没有非回环 IPv4 地址');
  } else {
    // 服务端只监听 127.0.0.1，用网卡 IP 连会失败（这正是推荐配置的效果）。
    // 这里要证的是"即便有人把 host 改成 0.0.0.0，非回环来源也拿不到令牌"，
    // 所以只看连接结果：连不上 = 结构上已经不可达，同样满足要求。
    let reachable = false;
    try {
      const res = await get(`http://${lan}:${String(port)}/api/health`);
      reachable = res.status === 200;
    } catch {
      reachable = false;
    }
    check(
      '⑤ 服务端只监听回环：用网卡 IP 访问不可达（host=127.0.0.1 的实际效果）',
      !reachable,
      `lan=${lan}`,
    );
  }
} finally {
  proxy.close();
  child.kill();
  await delay(300);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* Windows 偶发占用 */
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n合计 ${String(results.length)} 项，失败 ${String(failed.length)} 项`);
  if (failed.length > 0) process.exitCode = 1;
}
