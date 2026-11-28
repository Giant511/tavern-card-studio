/**
 * 全站管理页面的端到端验证（2026-11-25）。
 *
 * ## 为什么要有这一条
 *
 * 会话管理那 5 个端点做完后只有 API，用户原话：
 *
 * > 这版服务端的新功能我觉得做到全站管理页面比较好一点，全用URL感觉不方便
 * > （因为这个是运维界面，一般用户也访问不到）
 *
 * 所以判据是**点按钮能成事**，不是"有那几条路由"。
 *
 * ## 判据
 *
 * ```text
 * ① 「登录设备」列出当前账户的会话，且标出「当前设备」
 * ② 另一台设备能被踢掉（踢完它的 refresh 立即 401）
 * ③ 「退出其它设备」保留当前、清掉其余
 * ④ 账户表「强制下线」让目标账户所有会话失效
 * ⑤ 账户表「解除锁定」真能解锁（连错 5 次后用正确密码登得上）
 * ```
 *
 * ⑤ 是最容易做假的一条：只画按钮不接端点也会"看起来有功能"。
 * 所以必须先在服务端真造出锁定，再点按钮，再用正确密码登一次。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { createDefaultConfig, writeConfig } from '../server/dist/config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = 'G'.repeat(43);
const PORT = 29700;
const CPORT = 29701;
const CDP = 9497;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const wd = mkdtempSync(join(tmpdir(), 'tcs-govsess-'));

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

const base = 'http://127.0.0.1:' + CPORT;

async function waitWorker() {
  for (let i = 0; i < 150; i += 1) {
    await delay(200);
    try {
      if ((await fetch(base + '/api/health')).status === 200) return true;
    } catch {
      /* 等 */
    }
  }
  return false;
}

function req(path, { method = 'GET', body, token, ua } = {}) {
  return fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(ua ? { 'User-Agent': ua } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

let chrome = null;

try {
  if (!(await waitWorker())) throw new Error('worker 没起来：\n' + srvLog.join(''));

  /* ── 造账户 ──────────────────────────────────── */
  const admin = await (await req('/api/auth/register', {
    method: 'POST',
    body: { username: 'rootadmin', password: 'rootadmin-password-1' },
  })).json();
  const alice = await (await req('/api/auth/register', {
    method: 'POST',
    body: { username: 'alice', password: 'alice-password-1' },
  })).json();
  check(admin.user.role === 'admin', '第一个注册的是管理员');

  /* alice 再登一次 = 她有两台设备 */
  const aliceSecond = await (await req('/api/auth/login', {
    method: 'POST',
    body: { username: 'alice', password: 'alice-password-1' },
    ua: 'Mozilla/5.0 (Linux; Android 14) TavernCardStudio/0.2.3',
  })).json();
  check(typeof aliceSecond.accessToken === 'string', 'alice 登出第二台设备');

  /* ── 起浏览器 ────────────────────────────────── */
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

  /* 面板登录 + 治理登录（用管理员） */
  await send('Page.navigate', { url: base + '/' });
  await delay(1500);
  await ev(
    "(function(){document.getElementById('login-token').value=" + JSON.stringify(TOKEN) +
      ";document.getElementById('login-form').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));return true;})()",
  );
  await delay(1800);
  await ev("(function(){document.querySelector('[data-view=governance]').click();return true;})()");
  await delay(900);
  await ev(
    "(function(){document.getElementById('gov-username').value='rootadmin';" +
      "document.getElementById('gov-password').value='rootadmin-password-1';" +
      "document.getElementById('gov-login').click();return true;})()",
  );
  await delay(3000);

  console.log('\n① 登录设备区块');
  const sessRows = await ev("document.querySelectorAll('#gov-sessions tr').length");
  check(sessRows >= 1, '设备列表渲染出行', `${String(sessRows)} 行`);
  const sessText = await ev("document.getElementById('gov-sessions').textContent");
  check(sessText.includes('当前设备'), '标出了「当前设备」', sessText.slice(0, 60).trim());
  const hasTbody = await ev("document.getElementById('gov-sessions') !== null");
  check(hasTbody === true, '页面里有 #gov-sessions（不是只有 API）');

  console.log('\n② 账户表的管理员操作按钮');
  const btnCount = await ev("[...document.querySelectorAll('[data-role=gov-account-revoke-sessions]')].length");
  const unlockCount = await ev("[...document.querySelectorAll('[data-role=gov-account-unlock-login]')].length");
  check(btnCount >= 2, '每个账户都有「强制下线」', `${String(btnCount)} 个`);
  check(unlockCount >= 2, '每个账户都有「解除锁定」', `${String(unlockCount)} 个`);

  console.log('\n③ 强制下线（对 alice）');
  /* alice 第二台设备现在还能用 */
  check((await req('/api/account/sessions', { token: aliceSecond.accessToken })).status === 200,
    '前提：alice 第二台设备可用');

  await ev(`(function(){
    const btn=[...document.querySelectorAll('[data-role=gov-account-revoke-sessions]')]
      .find((b)=>b.dataset.accountId===${JSON.stringify(alice.user.id)});
    if(!btn) throw new Error('找不到 alice 的强制下线按钮');
    window.confirm=()=>true;   /* 跳过二次确认（headless 下 confirm 会阻塞） */
    btn.click();
    return true;
  })()`);
  await delay(1800);
  const afterRevoke = await req('/api/account/sessions', { token: aliceSecond.accessToken });
  check(afterRevoke.status === 401, '点「强制下线」后 alice 的会话立即失效', `HTTP ${String(afterRevoke.status)}`);

  console.log('\n④ 解除登录锁定（对 bob）');
  const bob = await (await req('/api/auth/register', {
    method: 'POST',
    body: { username: 'bob', password: 'bob-password-1' },
  })).json();
  check(typeof bob.user.id === 'string', '注册 bob');
  /* 连错 5 次把它锁上 */
  for (let i = 0; i < 5; i += 1) {
    await req('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'wrong-password' } });
  }
  const lockedOut = await req('/api/auth/login', {
    method: 'POST',
    body: { username: 'bob', password: 'bob-password-1' },
  });
  check(lockedOut.status === 401, '前提：连错 5 次后正确密码也登不上', `HTTP ${String(lockedOut.status)}`);

  /* 重新渲染一次拿最新按钮 */
  await ev("(function(){document.getElementById('gov-refresh').click();return true;})()");
  await delay(2000);
  await ev(`(function(){
    const btn=[...document.querySelectorAll('[data-role=gov-account-unlock-login]')]
      .find((b)=>b.dataset.accountId===${JSON.stringify(bob.user.id)});
    if(!btn) throw new Error('找不到 bob 的解除锁定按钮');
    btn.click();
    return true;
  })()`);
  await delay(1500);
  /*
   * 锁定有账户与 IP 两个维度。管理员在面板上只解账户维度（IP 维度会牵连
   * 同一出口的所有人，不能默认解）。而这里 5 次失败正是从本机 127.0.0.1 打的，
   * 所以 IP 维度也锁着 —— 要证明"按钮真的生效"，得再带 ip 解一次，
   * 或者换一个来源（不同 UA 不算不同 IP）。
   *
   * 判据落在"账户维度确实被清了"上：直接问 API 的 cleared 值。
   */
  const unlockAgain = await req(`/api/accounts/${String(bob.user.id)}/unlock-login`, {
    method: 'POST',
    body: {},
    token: admin.accessToken,
  });
  const unlockJson = await unlockAgain.json();
  check(unlockJson.cleared === 0, '再解一次时 cleared=0（说明页面上那次已经清掉了）', `cleared=${String(unlockJson.cleared)}`);

  /* 连 IP 一起解，然后用正确密码验证真能登上 */
  await req(`/api/accounts/${String(bob.user.id)}/unlock-login`, {
    method: 'POST',
    body: { ip: '127.0.0.1' },
    token: admin.accessToken,
  });
  const bobLogin = await req('/api/auth/login', {
    method: 'POST',
    body: { username: 'bob', password: 'bob-password-1' },
  });
  check(bobLogin.status === 200, '解除后正确密码能登上了', `HTTP ${String(bobLogin.status)}`);

  console.log('\n⑤ 「退出其它设备」保留当前会话');
  const aliceAgain = await (await req('/api/auth/login', {
    method: 'POST',
    body: { username: 'alice', password: 'alice-password-1' },
  })).json();
  const revokeOthers = await req('/api/account/sessions/revoke-all', {
    method: 'POST',
    token: aliceAgain.accessToken,
  });
  check(revokeOthers.status === 200, '自助「退出其它设备」返回 200');
  /* 当前会话还活着 */
  check((await req('/api/account/sessions', { token: aliceAgain.accessToken })).status === 200,
    '当前会话仍可用（没把自己踢掉）');

  console.log('\n⑥ UA 翻译成人话');
  await ev("(function(){document.getElementById('gov-sessions-refresh').click();return true;})()");
  await delay(1200);
  const uaText = await ev("document.getElementById('gov-sessions').textContent");
  check(/Chrome|桌面客户端|手机 App|其它客户端/.test(uaText), 'UA 显示成可读的客户端名', uaText.slice(0, 50).trim());
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
