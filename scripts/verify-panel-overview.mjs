/**
 * 面板两项改动的端到端验证。
 *
 * ```text
 * ① 总览统计是全站的（不是"我这个账号可见的那一片"）
 * ② 刷新 / 新标签页之后不用重新登录
 *   · 面板令牌：勾「记住这台设备」→ localStorage，关浏览器也在
 *   · 治理账户：勾「记住此设备 7 天」→ 用 refresh token 免密
 * ```
 *
 * ## 判据为什么是这些
 *
 * ① 造**两个账户各自的卡**，然后用管理员登录看总览 —— 数字必须是三个人之和，
 *    不是管理员自己那一张。这是用户报的那个问题的直接反证。
 * ② 直接 `Page.reload` 与**新开标签页**（sessionStorage 不跨标签，只有
 *    localStorage 能过这一关）。后者是关键：用户"点刷新要重登"很可能就是
 *    在新标签页里看到的。
 *
 * ## 跑法
 *
 * ```bash
 * npm run build:server && node scripts/verify-panel-overview.mjs
 * ```
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { createDefaultConfig, writeConfig } from '../server/dist/config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = 'P'.repeat(43);
const PORT = 29690;
const CPORT = 29691;
const CDP = 9495;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const wd = mkdtempSync(join(tmpdir(), 'tcs-panel-'));

const results = [];
function check(ok, label, detail = '') {
  results.push({ ok, label });
  console.log(`  ${ok ? '✔' : '✘'} ${label}${detail === '' ? '' : `（${detail}）`}`);
}

const cfg = createDefaultConfig({
  token: TOKEN,
  port: PORT,
  controlPort: CPORT,
  host: '127.0.0.1',
  controlHost: '127.0.0.1',
  dataDir: join(wd, 'store'),
});
cfg.auth.registerMode = 'open';
const cfgPath = join(wd, 'c.json');
writeConfig(cfgPath, cfg);

const srv = spawn(process.execPath, [join(ROOT, 'server', 'dist', 'index.js'), 'serve', '--config', cfgPath, '--log-level', 'warn'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const srvLog = [];
srv.stderr.on('data', (d) => srvLog.push(String(d)));

async function waitWorker() {
  for (let i = 0; i < 150; i += 1) {
    await delay(200);
    try {
      const res = await fetch('http://127.0.0.1:' + CPORT + '/api/health');
      if (res.status === 200) return true;
    } catch {
      /* 等 */
    }
  }
  return false;
}

const base = 'http://127.0.0.1:' + CPORT;

function post(path, body, token) {
  return fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify(body),
  });
}

/**
 * 造一张最简卡（走真实上传接口，让库里真有数据）。
 *
 * 接口收的是**文件原始字节**，元数据走 query（见 `requireCardBody`）：
 * `POST /api/cards?filename=…`，body 是 JSON 文件内容本身。
 */
async function createCard(token, name) {
  const cardJson = JSON.stringify({
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name,
      description: `${name} 的描述`,
      personality: '',
      scenario: '',
      first_mes: '你好',
      mes_example: '',
    },
  });
  const query = new URLSearchParams({ filename: `${name}.json`, message: '创建' });
  return fetch(base + '/api/cards?' + query.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: cardJson,
  });
}

let chrome = null;

try {
  if (!(await waitWorker())) throw new Error('worker 没起来：\n' + srvLog.join(''));

  /* ── 造数据：3 个账户，各 1 张卡 ─────────────────── */
  const admin = await (await post('/api/auth/register', { username: 'rootadmin', password: 'rootadmin-password-1' })).json();
  const u1 = await (await post('/api/auth/register', { username: 'alice', password: 'alice-password-1' })).json();
  const u2 = await (await post('/api/auth/register', { username: 'bob', password: 'bob-password-1' })).json();

  for (const [u, name] of [
    [admin, '管理员的卡'],
    [u1, 'Alice 的卡'],
    [u2, 'Bob 的卡'],
  ]) {
    const r = await createCard(u.accessToken, name);
    if (r.status !== 200 && r.status !== 201) {
      console.log('建卡失败', r.status, (await r.text()).slice(0, 200));
    }
  }

  console.log('\n① 全站统计（控制面）');
  const statsRes = await fetch(base + '/control/stats', { headers: { Authorization: 'Bearer ' + TOKEN } });
  const stats = await statsRes.json();
  const stats2 = await statsRes.json().catch(() => null);
  void stats2;
  console.log('   /control/stats =', JSON.stringify(stats));
  check(statsRes.status === 200, '/control/stats 返回 200', String(statsRes.status));
  check(stats?.accounts?.total === 3, '账户数 = 3（全站）', `实际 ${String(stats?.accounts?.total)}`);
  check(stats?.cards === 3, '角色卡数 = 3（三人的卡都在）', `实际 ${String(stats?.cards)}`);

  /* 对照：数据面按凭证过滤，管理员只看到自己 1 张 —— 证明确有区别 */
  const apiStats = await (await fetch(base + '/api/stats', { headers: { Authorization: 'Bearer ' + admin.accessToken } })).json();
  check(apiStats.cards === 1, '对照：/api/stats 按凭证过滤（管理员只见自己 1 张）', `实际 ${String(apiStats.cards)}`);

  /* ── 起浏览器 ─────────────────────────────────── */
  chrome = spawn(
    CHROME,
    ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--remote-debugging-port=' + CDP, '--user-data-dir=' + join(wd, 'cr'), 'about:blank'],
    { stdio: 'ignore' },
  );

  let page = null;
  for (let i = 0; i < 60; i += 1) {
    await delay(250);
    try {
      const list = await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json();
      page = list.find((t) => t.type === 'page');
      if (page) break;
    } catch {
      /* 等 */
    }
  }
  if (!page) throw new Error('CDP 没起来');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', () => res(), { once: true });
    ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
    setTimeout(() => rej(new Error('ws timeout')), 8000);
  });

  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id);
      pend.delete(m.id);
      if (m.error) rej(new Error(JSON.stringify(m.error)));
      else res(m.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pend.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => {
        if (pend.has(i)) {
          pend.delete(i);
          rej(new Error('timeout:' + method));
        }
      }, 20000);
    });

  await send('Page.enable');
  await send('Runtime.enable');
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
    return r.result?.value;
  };

  console.log('\n② 面板登录 + 记住这台设备');

  await send('Page.navigate', { url: base + '/' });
  await delay(1500);
  await ev(
    "(function(){document.getElementById('login-token').value=" +
      JSON.stringify(TOKEN) +
      ";document.getElementById('login-remember').checked=true;" +
      "document.getElementById('login-form').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));return true;})()",
  );
  await delay(2000);
  check((await ev("document.getElementById('app').hidden")) === false, '登录后进入面板');

  const statCards = await ev("document.getElementById('stat-cards').textContent");
  const statAccounts = await ev("document.getElementById('stat-accounts').textContent");
  const statRepos = await ev("document.getElementById('stat-repos').textContent");
  console.log(`   总览显示：账户 ${statAccounts} / 角色卡 ${statCards} / 仓库 ${statRepos}`);
  check(statCards === '3', '总览「角色卡」显示全站 3 张（不是自己那 1 张）', statCards);
  check(statAccounts === '3', '总览「账户」显示 3', statAccounts);

  await send('Page.reload', { ignoreCache: false });
  await delay(2500);
  check((await ev("document.getElementById('app').hidden")) === false, '刷新后仍在面板内（不用重登）');
  check((await ev("(localStorage.getItem('tcs.token')||'').length")) === 43, 'localStorage 里存了令牌');

  console.log('\n③ 新标签页（sessionStorage 不跨标签，只有 localStorage 能过）');
  const newTarget = await send('Target.createTarget', { url: 'about:blank' });
  const list = await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json();
  const freshPage = list.find((t) => t.id === newTarget.targetId);
  if (!freshPage) throw new Error('新标签页没建起来');
  const ws2 = new WebSocket(freshPage.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws2.addEventListener('open', () => res(), { once: true });
    ws2.addEventListener('error', () => rej(new Error('ws2 error')), { once: true });
    setTimeout(() => rej(new Error('ws2 timeout')), 8000);
  });
  let id2 = 0;
  const pend2 = new Map();
  ws2.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pend2.has(m.id)) {
      const { res, rej } = pend2.get(m.id);
      pend2.delete(m.id);
      if (m.error) rej(new Error(JSON.stringify(m.error)));
      else res(m.result);
    }
  });
  const send2 = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id2;
      pend2.set(i, { res, rej });
      ws2.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => {
        if (pend2.has(i)) {
          pend2.delete(i);
          rej(new Error('timeout2:' + method));
        }
      }, 20000);
    });
  await send2('Page.enable');
  await send2('Runtime.enable');
  const ev2 = async (expr) => {
    const r = await send2('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval2 error');
    return r.result?.value;
  };
  await send2('Page.navigate', { url: base + '/' });
  await delay(2500);
  check((await ev2("document.getElementById('app').hidden")) === false, '新标签页也在面板内（免密生效）');

  console.log('\n④ 治理页：7 天免密');
  await ev2("(function(){document.querySelector('[data-view=governance]').click();return true;})()");
  await delay(1200);
  check((await ev2("document.getElementById('gov-login-card').hidden")) === false, '首次进治理页要求登录');

  await ev2(
    "(function(){document.getElementById('gov-username').value='rootadmin';" +
      "document.getElementById('gov-password').value='rootadmin-password-1';" +
      "document.getElementById('gov-remember').checked=true;" +
      "document.getElementById('gov-login').click();return true;})()",
  );
  await delay(2500);
  check((await ev2("document.getElementById('gov-login-card').hidden")) === true, '账户密码登录成功');
  const remembered = await ev2("(localStorage.getItem('tcs.gov.remember')||'').length > 0");
  check(remembered === true, '勾选后 refresh token 落进 localStorage');

  /* 模拟"关掉浏览器再开"：清掉 sessionStorage（access token），只留 localStorage */
  await ev2('(function(){sessionStorage.clear();return true;})()');
  await send2('Page.reload', { ignoreCache: false });
  await delay(3000);
  await ev2("(function(){document.querySelector('[data-view=governance]').click();return true;})()");
  await delay(2500);
  const autoIn = await ev2("document.getElementById('gov-login-card').hidden");
  const who = await ev2("document.getElementById('gov-who').textContent");
  check(autoIn === true, '清掉会话后仍自动登录（用 refresh token 续期）');
  check(typeof who === 'string' && who.includes('rootadmin'), '显示当前登录账户', who);
  check(typeof who === 'string' && who.includes('免密'), '显示 7 天免密剩余天数', who);

  console.log('\n⑤ 取消勾选后不再免密');
  /* 用 id 点，不靠文案找按钮 —— 文案随时会改，id 是契约 */
  await ev2("(function(){document.getElementById('gov-logout').click();return true;})()");
  await delay(800);
  check((await ev2("(localStorage.getItem('tcs.gov.remember')||'').length")) === 0, '退出后清掉记住的凭证');
  await send2('Page.reload', { ignoreCache: false });
  await delay(2500);
  await ev2("(function(){document.querySelector('[data-view=governance]').click();return true;})()");
  await delay(2000);
  check((await ev2("document.getElementById('gov-login-card').hidden")) === false, '退出后刷新需要重新登录');
} catch (error) {
  console.error('验证失败：', error.message);
  results.push({ ok: false, label: '脚本异常：' + error.message });
} finally {
  try {
    srv.kill('SIGTERM');
    await delay(600);
    if (srv.exitCode === null) srv.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  if (chrome) chrome.kill();
  try {
    rmSync(wd, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发 EBUSY */
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} 通过`);
if (failed.length > 0) {
  console.log('失败：' + failed.map((f) => f.label).join(' / '));
  process.exit(1);
}
process.exit(0);
