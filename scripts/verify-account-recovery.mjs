/**
 * 账户自助管理 + 运维兜底（2026-11-25）。
 *
 * ## 这一批要验的四件事
 *
 * ```text
 * ① 运维能按用户名 / UID 过滤找到账户
 * ② 运维「临时密码」→ 拿到 UID + 12 位码
 * ③ 用户拿「UID + 临时密码」只能改密码 —— **不能登录**
 * ④ 用户登录后能自助改名 / 改密码，改密码后必须重新登录
 * ```
 *
 * ## 判据为什么长这样
 *
 * ③ 的核心是**反向断言**：拿临时密码去 `/api/auth/login` 必须 401。
 *   如果那条能过，所谓"临时密码"就是一把长期密码，整个设计就废了。
 *
 * ④ 改密码后断言「旧 refresh token 立即 401」——
 *   改密码不踢会话是经典漏洞（攻击者手里的 refresh token 还能续期）。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { createDefaultConfig, writeConfig } from '../server/dist/config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = 'T'.repeat(43);
const PORT = 29710;
const CPORT = 29711;
const CDP = 9499;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const wd = mkdtempSync(join(tmpdir(), 'tcs-ticket-'));

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

function req(path, { method = 'GET', body, token, panel = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (panel) headers.Authorization = 'Bearer ' + TOKEN;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

let chrome = null;

try {
  if (!(await waitWorker())) throw new Error('worker 没起来：\n' + srvLog.join(''));

  const admin = await (await req('/api/auth/register', {
    method: 'POST',
    body: { username: 'rootadmin', password: 'rootadmin-password-1' },
  })).json();
  const alice = await (await req('/api/auth/register', {
    method: 'POST',
    body: { username: 'alice', password: 'alice-password-1' },
  })).json();
  check(admin.user.role === 'admin', '第一个注册的是管理员');
  check(typeof alice.user.uid === 'string' && alice.user.uid.length > 5, '注册返回 uid', alice.user.uid);

  /* ── ① 账户列表能拿到用户名与 uid（过滤的数据基础） ── */
  console.log('\n① 账户列表与过滤');
  const accounts = await (await req('/control/accounts?limit=200', { panel: true })).json();
  check(Array.isArray(accounts.items) && accounts.items.length === 2, '控制面返回账户列表', `${String(accounts.items?.length)} 条`);
  const aliceRow = (accounts.items || []).find((it) => it.username === 'alice');
  check(aliceRow !== undefined && typeof aliceRow.uid === 'string' && aliceRow.uid !== '', '列表里带 uid（过滤要用它）', aliceRow?.uid);

  /* ── ② 生成临时密码 ── */
  console.log('\n② 运维生成临时密码');
  const issueRes = await req(`/control/accounts/${String(aliceRow.id)}/temp-password`, { method: 'POST', panel: true });
  const issue = await issueRes.json();
  check(issueRes.status === 200, '生成成功', `HTTP ${String(issueRes.status)}`);
  check(/^[A-Z0-9]{12}$/.test(issue.code || ''), '临时密码是 12 位大写字母数字', issue.code);
  check(issue.uid === alice.user.uid, '返回的 uid 与账户一致');
  check(typeof issue.expiresAt === 'string' && issue.expiresAt > new Date().toISOString(), '有未来到期时间', issue.expiresAt);

  /* 再生成一次 → 旧的应该作废（每人同时只有一枚） */
  const issue2 = await (await req(`/control/accounts/${String(aliceRow.id)}/temp-password`, { method: 'POST', panel: true })).json();
  check(issue2.code !== issue.code, '再次生成得到不同的码');

  /* ── ③ 临时密码只能改密码，不能登录 ── */
  console.log('\n③ 临时密码的作用范围');
  const loginWithTicket = await req('/api/auth/login', {
    method: 'POST',
    body: { username: 'alice', password: issue.code },
  });
  check(loginWithTicket.status === 401, '★ 拿临时密码登录必须 401（它不是密码）', `HTTP ${String(loginWithTicket.status)}`);

  /* 用旧的那枚（已被作废）改密码 → 失败 */
  const oldTicket = await req('/api/auth/reset-password', {
    method: 'POST',
    body: { uid: alice.user.uid, code: issue.code, newPassword: 'alice-new-password-1' },
  });
  check(oldTicket.status === 401, '★ 上一枚（已被新票据作废）不能用', `HTTP ${String(oldTicket.status)}`);

  /* 用新的那枚改密码 → 成功 */
  const resetRes = await req('/api/auth/reset-password', {
    method: 'POST',
    body: { uid: alice.user.uid, code: issue2.code, newPassword: 'alice-new-password-1' },
  });
  check(resetRes.status === 200, '用 UID + 临时密码改密码成功', `HTTP ${String(resetRes.status)}`);
  const resetBody = await resetRes.json();
  check(resetBody.revoked >= 1, '改密码时吊销了会话', `revoked=${String(resetBody.revoked)}`);

  /* 同一枚再用一次 → 失败（一次性） */
  const reuse = await req('/api/auth/reset-password', {
    method: 'POST',
    body: { uid: alice.user.uid, code: issue2.code, newPassword: 'alice-another-password-1' },
  });
  check(reuse.status === 401, '★ 同一枚临时密码不能重复使用', `HTTP ${String(reuse.status)}`);

  /* 新密码能登录 */
  const loginNew = await req('/api/auth/login', {
    method: 'POST',
    body: { username: 'alice', password: 'alice-new-password-1' },
  });
  check(loginNew.status === 200, '新密码能登录', `HTTP ${String(loginNew.status)}`);

  /* 旧密码登不上 */
  const loginOld = await req('/api/auth/login', {
    method: 'POST',
    body: { username: 'alice', password: 'alice-password-1' },
  });
  check(loginOld.status === 401, '旧密码已失效', `HTTP ${String(loginOld.status)}`);

  /* ── ④ 自助改名 / 改密码 ── */
  console.log('\n④ 用户自助改名 / 改密码');
  const aliceSession = await (await req('/api/auth/login', {
    method: 'POST',
    body: { username: 'alice', password: 'alice-new-password-1' },
  })).json();

  const renameWrongPw = await req('/api/account/username', {
    method: 'POST',
    token: aliceSession.accessToken,
    body: { currentPassword: 'wrong-password', newUsername: 'alice2' },
  });
  check(renameWrongPw.status === 403, '改名的密码错 → 403', `HTTP ${String(renameWrongPw.status)}`);

  const rename = await req('/api/account/username', {
    method: 'POST',
    token: aliceSession.accessToken,
    body: { currentPassword: 'alice-new-password-1', newUsername: 'alice2' },
  });
  const renameBody = await rename.json();
  check(rename.status === 200, '改名成功', `HTTP ${String(rename.status)}`);
  check(renameBody.uid === alice.user.uid, '★ uid 不变（终身标识）', renameBody.uid);
  check(renameBody.username === 'alice2', '新用户名生效', renameBody.username);

  /* 改名不踢会话 */
  check((await req('/api/auth/me', { token: aliceSession.accessToken })).status === 200, '改名后会话仍有效（不该被登出）');

  /* 撞名 */
  const dup = await req('/api/account/username', {
    method: 'POST',
    token: aliceSession.accessToken,
    body: { currentPassword: 'alice-new-password-1', newUsername: 'rootadmin' },
  });
  check(dup.status === 400, '改成已存在的名字 → 400', `HTTP ${String(dup.status)}`);

  /* 改密码：旧 refresh 立即失效 */
  const beforeChange = aliceSession.refreshToken;
  const changePw = await req('/api/account/password', {
    method: 'POST',
    token: aliceSession.accessToken,
    body: { currentPassword: 'alice-new-password-1', newPassword: 'alice-final-password-1' },
  });
  check(changePw.status === 200, '自助改密码成功', `HTTP ${String(changePw.status)}`);

  const reuseRefresh = await req('/api/auth/refresh', {
    method: 'POST',
    body: { refreshToken: beforeChange },
  });
  check(reuseRefresh.status === 401, '★ 改密码后旧 refresh token 立即失效', `HTTP ${String(reuseRefresh.status)}`);

  const loginFinal = await req('/api/auth/login', {
    method: 'POST',
    body: { username: 'alice2', newPassword: 'x', password: 'alice-final-password-1' },
  });
  check(loginFinal.status === 200, '新用户名 + 新密码能登录', `HTTP ${String(loginFinal.status)}`);

  /* ── ⑤ 面板 UI：过滤框与临时密码按钮 ── */
  console.log('\n⑤ 面板 UI');
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

  await send('Page.navigate', { url: base + '/' });
  await delay(1500);
  await ev(
    "(function(){document.getElementById('login-token').value=" + JSON.stringify(TOKEN) +
      ";document.getElementById('login-form').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));return true;})()",
  );
  await delay(1500);
  await ev("(function(){document.querySelector('[data-view=governance]').click();return true;})()");
  await delay(800);
  await ev(
    "(function(){document.getElementById('gov-username').value='rootadmin';" +
      "document.getElementById('gov-password').value='rootadmin-password-1';" +
      "document.getElementById('gov-login').click();return true;})()",
  );
  await delay(2500);
  check((await ev("document.getElementById('gov-account-filter') !== null")) === true, '账户表有过滤框');

  const allRows = await ev("document.querySelectorAll('#gov-accounts tr').length");
  await ev("(function(){const i=document.getElementById('gov-account-filter');i.value='alice2';i.dispatchEvent(new Event('input'));return true;})()");
  await delay(400);
  const filteredRows = await ev("document.querySelectorAll('#gov-accounts tr').length");
  check(filteredRows < allRows, '按用户名过滤后行数变少', `${String(allRows)} → ${String(filteredRows)}`);
  const filteredText = await ev("document.getElementById('gov-accounts').textContent");
  check(filteredText.includes('alice2'), '过滤结果里有目标账户');

  /* 按 UID 过滤（uid 是 uuid，取前 8 位足够唯一） */
  const uidPrefix = String(alice.user.uid).slice(0, 8);
  await ev(
    `(function(){const i=document.getElementById('gov-account-filter');i.value=${JSON.stringify(uidPrefix)};` +
      "i.dispatchEvent(new Event('input'));return true;})()",
  );
  await delay(400);
  const byUid = await ev("document.getElementById('gov-accounts').textContent");
  check(byUid.includes(uidPrefix), '★ 按 uid 前缀也能过滤到', uidPrefix);

  /* 找不到时要说清 */
  await ev("(function(){const i=document.getElementById('gov-account-filter');i.value='zzz-not-exist';i.dispatchEvent(new Event('input'));return true;})()");
  await delay(400);
  const hintText = await ev("document.getElementById('gov-account-filter-hint').textContent");
  check(/没有匹配/.test(hintText), '无匹配时给出明确提示', hintText.slice(0, 40));

  /* 清空 */
  await ev("(function(){document.getElementById('gov-account-filter-clear').click();return true;})()");
  await delay(400);
  check((await ev("document.querySelectorAll('#gov-accounts tr').length")) === allRows, '清空后恢复全部行');

  /* 临时密码按钮真能生成并弹窗 */
  await ev(
    `(function(){window.confirm=()=>true;const b=[...document.querySelectorAll('[data-role=gov-account-temp-password]')]` +
      `.find((x)=>x.dataset.accountId===${JSON.stringify(aliceRow.id)});if(!b) throw new Error('找不到按钮');b.click();return true;})()`,
  );
  await delay(1600);
  const dialogShown = await ev("document.getElementById('ticket-overlay').hidden === false");
  const dialogCode = await ev("document.getElementById('ticket-code').value");
  const dialogUid = await ev("document.getElementById('ticket-uid').value");
  check(dialogShown === true, '点「临时密码」弹出结果弹窗');
  check(/^[A-Z0-9]{12}$/.test(dialogCode || ''), '弹窗里显示 12 位码', dialogCode);
  check(dialogUid === alice.user.uid, '弹窗里同时给出 uid');

  /* 关掉后明文不留在 DOM 里 */
  await ev("(function(){document.getElementById('ticket-done').click();return true;})()");
  await delay(300);
  check((await ev("document.getElementById('ticket-code').value")) === '', '关闭后明文从 DOM 清掉');
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
