#!/usr/bin/env node
/**
 * G1 端到端：仓库改名三态（v0.1.4）。
 *
 * ## 这个脚本存在的理由
 *
 * v0.1.3 发出去的客户端里，对一个仓库点「改名」会报
 * 「改名失败：无法连接服务端」——而同一刻顶栏显示"已连接"，上传、签发令牌
 * 的界面都正常。
 *
 * 根因（决策 #159）：服务端的 CORS 预检把允许方法写死成
 * `GET, POST, PUT, DELETE, OPTIONS`，**独独漏了 PATCH**。改名用的正是 PATCH。
 * 壳里页面来源是 `tauri://localhost`，与 `http://127.0.0.1:8730` 必然跨域，
 * 非简单方法要先过预检；预检里没有 PATCH ⇒ WebView **根本不发实际请求**，
 * `fetch` 抛 `TypeError: Failed to fetch`，客户端只能归类成 NETWORK，
 * 于是显示「无法连接服务端」。
 *
 * 为什么全部浏览器断言都是绿的：E2E 跑在同源页面里，同源请求**不触发预检**。
 * 这是又一个"只在壳里错"的缺陷 —— 与 `window.confirm` 被插件改成 async 同族。
 *
 * ## 因此断言分两层
 *
 * 1. **预检层**（这是根因所在）：用壳里真实的 `Origin: tauri://localhost` 发 OPTIONS，
 *    断言 `Access-Control-Allow-Methods` 覆盖客户端用到的每个方法。
 *    修好之前这里必然红 —— 这正是它作为回归防线的意义。
 * 2. **三态层**（这是用户看到的）：成功 / 403 权限不足 / 真断网，
 *    断言三种文案**互不相同**，且 403 文案里不含"无法连接"。
 *    需求明确不允许三者共用同一句。
 *
 * 用法：npm run build:server && node scripts/verify-g1-rename.mjs
 * 退出码：0 全绿；1 有断言失败
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';

const REPO = process.cwd();
const STAMP = `${String(Date.now())}-${String(process.pid)}`;
const WORK = join(REPO, '.verify', 'g1-rename', `run-${STAMP}`);

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  OK   ${name}${detail === '' ? '' : `  [${detail}]`}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail === '' ? '' : `  [${detail}]`}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

// 客户端真实实现（type stripping 直接吃 .ts，与 test/repo-token-mode.test.mjs 同一套做法）
const { renameRepo, listRepos, createRepo, RepoClientError } = await import(
  '../client/src/sync/repo-client.ts'
);

const PORT = await freePort();
const DEAD_PORT = await freePort(); // 只为拿一个"当前没人监听"的端口
const BASE = `http://127.0.0.1:${String(PORT)}`;
const DATA_DIR = join(WORK, 'data');
const CONFIG = join(WORK, 'config.json');
mkdirSync(DATA_DIR, { recursive: true });
writeFileSync(
  CONFIG,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      port: PORT,
      controlPort: await freePort(),
      host: '127.0.0.1',
      controlHost: '127.0.0.1',
      dataDir: DATA_DIR.replace(/\\/g, '/'),
      rulesDir: join(REPO, 'rules').replace(/\\/g, '/'),
      defaultPlatformRule: 'sillytavern',
      defaultPreset: 'default',
      maxUploadBytes: 33_554_432,
      logLevel: 'error',
      auth: {
        token: 'g1-rename-token-eeeeeeeeeeeeeeeeeeeee',
        require: true,
        publicPaths: ['/api/health'],
        // 开放注册：本脚本要自己建账户，不想依赖 CLI 的 stdin 交互
        registerMode: 'open',
        jwtSecret: 'g1-rename-secret-eeeeeeeeeeeeeeeeeeeee',
      },
      tls: { mode: 'off', httpsPort: await freePort(), certPath: '', keyPath: '' },
      service: { mode: 'process', name: 'G1RENAME', displayName: 'G1RENAME', autoStart: false },
      trash: { retentionDays: 30 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const child = spawn(process.execPath, ['server/dist/index.js', 'worker', '--config', CONFIG], {
  cwd: REPO,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '' },
});
let serverLog = '';
child.stdout.on('data', (chunk) => {
  serverLog += String(chunk);
});
child.stderr.on('data', (chunk) => {
  serverLog += String(chunk);
});

let exitCode = 0;
try {
  await waitReady();

  // ══════════════════════════════════════════════════════
  // 0. 预检层：壳里真实的跨域来源
  // ══════════════════════════════════════════════════════
  console.log('\n【0】CORS 预检（Origin: tauri://localhost）—— 根因所在');
  /*
   * 注意这里必须**方法配它自己的路径**。
   *
   * `Access-Control-Allow-Methods` 现在是**按路径**从路由表派生的，所以
   * `OPTIONS /api/repos` 只会声明 GET/POST（那个路径就这两个路由），
   * 拿 PATCH 去问 `/api/repos` 得到"不允许"是**正确**的 —— 第一版用例
   * 在同一个路径上把所有方法都试了一遍，于是把正确行为判成了失败。
   * 真正要守的是：**每个方法在它自己的路径上必须被允许**。
   */
  const preflightCases = [
    { method: 'GET', path: '/api/repos' },
    { method: 'POST', path: '/api/repos' },
    { method: 'PATCH', path: '/api/repos/demo-id' },
    { method: 'DELETE', path: '/api/repos/demo-id' },
    { method: 'POST', path: '/api/repos/demo-id/default' },
    { method: 'POST', path: '/api/repos/demo-id/tokens' },
    { method: 'PATCH', path: '/api/tokens/demo-id' },
    { method: 'DELETE', path: '/api/tokens/demo-id' },
  ];
  for (const item of preflightCases) {
    const res = await fetch(`${BASE}${item.path}`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'tauri://localhost',
        'Access-Control-Request-Method': item.method,
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    const allow = (res.headers.get('access-control-allow-methods') ?? '')
      .split(',')
      .map((entry) => entry.trim().toUpperCase())
      .filter((entry) => entry !== '');
    check(
      `预检允许 ${item.method} ${item.path}`,
      allow.includes(item.method),
      allow.join(', '),
    );
  }
  // 改名路径单独再看一次：它是本次事故的现场
  {
    const res = await fetch(`${BASE}/api/repos/whatever-id`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'tauri://localhost',
        'Access-Control-Request-Method': 'PATCH',
      },
    });
    const allow = (res.headers.get('access-control-allow-methods') ?? '')
      .split(',')
      .map((item) => item.trim().toUpperCase());
    check('改名路径 /api/repos/:id 的预检含 PATCH', allow.includes('PATCH'), allow.join(', '));
  }

  // ══════════════════════════════════════════════════════
  // 1. 前置：建账户、建仓库
  // ══════════════════════════════════════════════════════
  console.log('\n【1】前置：注册账户（首个账户自动管理员）');
  const registered = await postJson('/api/auth/register', {
    username: 'g1owner',
    password: 'password-1234',
  });
  const accessToken = typeof registered.json?.accessToken === 'string' ? registered.json.accessToken : '';
  check('注册返回 accessToken', accessToken !== '', `HTTP ${String(registered.status)}`);

  const config = { serverUrl: BASE, accessToken };

  const repoEn = await createRepo(config, { name: 'warehouse-en' });
  check('建仓库（英文名）', repoEn.name === 'warehouse-en', repoEn.id);

  // ══════════════════════════════════════════════════════
  // 2. 成功态：中英文各改一次
  // ══════════════════════════════════════════════════════
  console.log('\n【2】成功态：改名（英文 → 中文）');
  const renamedEn = await renameRepo(config, repoEn.id, { name: 'warehouse-renamed' });
  check('英文名改名成功', renamedEn.name === 'warehouse-renamed', renamedEn.name);

  const renamedCn = await renameRepo(config, repoEn.id, { name: '素材仓库' });
  check('中文名改名成功', renamedCn.name === '素材仓库', renamedCn.name);

  const listed = await listRepos(config);
  const same = listed.find((item) => item.id === repoEn.id);
  check('列表里读回的是新名字（不是本地缓存）', same?.name === '素材仓库', same?.name);

  // 服务端真实响应码：不靠客户端封装，直接看 HTTP
  {
    const res = await fetch(`${BASE}/api/repos/${repoEn.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '素材仓库-直连' }),
    });
    check('PATCH /api/repos/:id 直连返回 200', res.status === 200, `HTTP ${String(res.status)}`);
  }

  // ══════════════════════════════════════════════════════
  // 3. 403 态：仓库令牌不能管理仓库
  // ══════════════════════════════════════════════════════
  console.log('\n【3】403 态：用仓库令牌（读权限）改名');

  const issued = await postJson(
    `/api/repos/${repoEn.id}/tokens`,
    { name: 'g1-read', scopes: ['read'] },
    { Authorization: `Bearer ${accessToken}` },
  );
  const repoTok = typeof issued.json?.token === 'string' ? issued.json.token : '';
  check('签发只读仓库令牌', repoTok.startsWith('tcr_'), `HTTP ${String(issued.status)}`);

  const tokConfig = { serverUrl: BASE, accessToken: repoTok };
  let forbidden = null;
  try {
    await renameRepo(tokConfig, repoEn.id, { name: '不该成功' });
  } catch (error) {
    forbidden = error;
  }
  check('改名被拒绝（抛错了）', forbidden instanceof RepoClientError, forbidden?.name ?? '(没抛错)');
  check('错误码是 FORBIDDEN（不是 NETWORK）', forbidden?.code === 'FORBIDDEN', forbidden?.code);
  check('HTTP 状态是 403', forbidden?.status === 403, String(forbidden?.status));
  check(
    '文案说的是权限（服务端原话）',
    typeof forbidden?.displayMessage === 'string' && forbidden.displayMessage.includes('仓库令牌不能管理'),
    forbidden?.displayMessage,
  );
  check(
    '文案里**没有**「无法连接服务端」',
    typeof forbidden?.displayMessage === 'string' && !forbidden.displayMessage.includes('无法连接'),
    forbidden?.displayMessage,
  );

  // ══════════════════════════════════════════════════════
  // 4. 真断网态：端口没人监听
  // ══════════════════════════════════════════════════════
  console.log('\n【4】断网态：服务端不可达');
  const deadConfig = { serverUrl: `http://127.0.0.1:${String(DEAD_PORT)}`, accessToken };
  let network = null;
  try {
    await renameRepo(deadConfig, repoEn.id, { name: '连不上' }, { timeoutMs: 3000 });
  } catch (error) {
    network = error;
  }
  check('断网时抛错', network instanceof RepoClientError, network?.name ?? '(没抛错)');
  check('错误码是 NETWORK', network?.code === 'NETWORK', network?.code);
  check(
    '文案是「无法连接服务端」',
    network?.displayMessage === '无法连接服务端',
    network?.displayMessage,
  );

  // ══════════════════════════════════════════════════════
  // 5. 三态文案互不相同（需求硬要求）
  // ══════════════════════════════════════════════════════
  console.log('\n【5】三态文案不允许共享同一句');
  const successText = `已改名为「${renamedCn.name}」`;
  const forbiddenText = forbidden?.displayMessage ?? '';
  const networkText = network?.displayMessage ?? '';
  const all = [successText, forbiddenText, networkText];
  check('三条文案都非空', all.every((item) => item !== ''), all.length);
  check('成功 ≠ 403', successText !== forbiddenText);
  check('成功 ≠ 断网', successText !== networkText);
  check('403 ≠ 断网', forbiddenText !== networkText, `${forbiddenText} | ${networkText}`);
} catch (error) {
  failed += 1;
  exitCode = 1;
  console.log(`\n  FAIL 脚本异常：${error instanceof Error ? error.message : String(error)}`);
  if (serverLog !== '') console.log(`\n服务端日志尾部：\n${serverLog.split('\n').slice(-8).join('\n')}`);
} finally {
  try {
    child.kill('SIGTERM');
  } catch {
    /* 已退 */
  }
  await new Promise((resolve) => setTimeout(resolve, 600));
  try {
    child.kill('SIGKILL');
  } catch {
    /* 同上 */
  }
  try {
    rmSync(WORK, { recursive: true, force: true });
  } catch {
    /* 归档即可，不因清理失败改结论 */
  }
}

async function postJson(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

async function waitReady() {
  for (let i = 0; i < 150; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.status === 200) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('服务端 30 秒内没有就绪');
}

console.log(`\n合计 ${passed} 项通过，${failed} 项失败`);
if (failed > 0) {
  console.log('结论：未通过');
  process.exit(1);
}
console.log('结论：通过（改名三态文案互不相同，预检覆盖 PATCH）');
process.exit(exitCode);
