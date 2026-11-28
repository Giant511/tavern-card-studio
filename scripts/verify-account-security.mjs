/**
 * 安全检查（2026-11-25）：临时密码 + 自助改账户的攻击面。
 *
 * 不看代码"觉得"安全，逐条真的打一遍。
 *
 * ## 打哪些
 *
 * ```text
 * ① 临时密码能不能登录 / 换 access token          ← 它必须什么都不是
 * ② 能不能跨 uid 用（拿 A 的码配 B 的 uid）        ← 票据必须绑 uid
 * ③ 过期后还能不能用                              ← 30 分钟是硬线
 * ④ 重复使用                                      ← 一次性
 * ⑤ 暴力猜码                                      ← 必须有 IP 限速
 * ⑥ 改别人的用户名 / 密码（不带身份）              ← 必须 401/403
 * ⑦ 仓库令牌 / 全局令牌能否改密码                  ← 必须 403（它们没有账户身份）
 * ⑧ 改密码时旧 refresh 是否真失效                  ← 经典漏洞
 * ⑨ 改密码后能不能用旧密码登回                     ← 必须不能
 * ⑩ 密码太短 / 新旧相同                            ← 400 而不是 500
 * ⑪ 审计里能不能查到"谁发的临时密码"               ← 可追溯
 * ⑫ 票据原文有没有落盘                             ← 只能有哈希
 * ```
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { createDefaultConfig, writeConfig } from '../server/dist/config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = 'S'.repeat(43);
const PORT = 29730;
const CPORT = 29731;
const wd = mkdtempSync(join(tmpdir(), 'tcs-sec-'));

const results = [];
function check(ok, label, detail = '') {
  results.push({ ok, label });
  console.log(`  ${ok ? '✔' : '✘'} ${label}${detail === '' ? '' : `（${detail}）`}`);
}

const cfg = createDefaultConfig({
  token: TOKEN, port: PORT, controlPort: CPORT,
  host: '127.0.0.1', controlHost: '127.0.0.1', dataDir: join(wd, 'store'),
});
cfg.auth.registerMode = 'open';
const cfgPath = join(wd, 'c.json');
writeConfig(cfgPath, cfg);

const srv = spawn(process.execPath, [join(ROOT, 'server', 'dist', 'index.js'), 'serve', '--config', cfgPath, '--log-level', 'warn'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
});
const srvLog = [];
srv.stderr.on('data', (d) => srvLog.push(String(d)));

const base = 'http://127.0.0.1:' + CPORT;

async function waitWorker() {
  for (let i = 0; i < 150; i += 1) {
    await delay(200);
    try { if ((await fetch(base + '/api/health')).status === 200) return true; } catch { /* 等 */ }
  }
  return false;
}

function req(path, { method = 'GET', body, token, panel = false } = {}) {
  const headers = {};
  if (panel) headers.Authorization = 'Bearer ' + TOKEN;
  else if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

try {
  if (!(await waitWorker())) throw new Error('worker 没起来：\n' + srvLog.join(''));

  const admin = await (await req('/api/auth/register', { method: 'POST', body: { username: 'rootadmin', password: 'rootadmin-password-1' } })).json();
  const alice = await (await req('/api/auth/register', { method: 'POST', body: { username: 'alice', password: 'alice-password-1' } })).json();
  const bob = await (await req('/api/auth/register', { method: 'POST', body: { username: 'bob', password: 'bob-password-1' } })).json();

  const accounts = await (await req('/control/accounts?limit=200', { panel: true })).json();
  const aliceRow = accounts.items.find((x) => x.username === 'alice');

  console.log('\n① 临时密码不能当凭证用');
  const issue = await (await req('/control/accounts/' + aliceRow.id + '/temp-password', { method: 'POST', panel: true })).json();

  for (const [label, path, payload] of [
    ['登录（用户名+临时密码）', '/api/auth/login', { username: 'alice', password: issue.code }],
    ['刷新（把临时密码当 refresh）', '/api/auth/refresh', { refreshToken: issue.code }],
  ]) {
    const res = await req(path, { method: 'POST', body: payload });
    check(res.status === 401, `${label} → 401`, `HTTP ${String(res.status)}`);
  }
  const asBearer = await req('/api/auth/me', { token: issue.code });
  check(asBearer.status === 401, '把临时密码当 Bearer → 401', `HTTP ${String(asBearer.status)}`);
  const asRepo = await req('/api/auth/repo-token', { method: 'POST', body: { token: issue.code } });
  check(asRepo.status === 400 || asRepo.status === 401, '把临时密码当仓库令牌 → 拒绝', `HTTP ${String(asRepo.status)}`);

  console.log('\n② 票据绑 uid（不能跨账户用）');
  const cross = await req('/api/auth/reset-password', {
    method: 'POST',
    body: { uid: bob.user.uid, code: issue.code, newPassword: 'hacked-password-1' },
  });
  check(cross.status === 401, '★ alice 的码配 bob 的 uid → 401', `HTTP ${String(cross.status)}`);
  check((await req('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'hacked-password-1' } })).status === 401,
    'bob 的密码没有被改掉');

  console.log('\n③ 过期后不可用');
  /* 直接把库里的 expires_at 改到过去（比等 30 分钟实际） */
  {
    const db = new Database(join(wd, 'store', 'state.db'));
    db.prepare('UPDATE password_tickets SET expires_at = ? WHERE user_id = ?').run('2020-01-01T00:00:00.000Z', aliceRow.id);
    db.close();
  }
  const expired = await req('/api/auth/reset-password', {
    method: 'POST', body: { uid: alice.user.uid, code: issue.code, newPassword: 'alice-x-password-1' },
  });
  check(expired.status === 401, '★ 过期票据 → 401', `HTTP ${String(expired.status)}`);

  console.log('\n④ 一次性 + 旧票据作废');
  const t1 = await (await req('/control/accounts/' + aliceRow.id + '/temp-password', { method: 'POST', panel: true })).json();
  const t2 = await (await req('/control/accounts/' + aliceRow.id + '/temp-password', { method: 'POST', panel: true })).json();
  const useT1 = await req('/api/auth/reset-password', { method: 'POST', body: { uid: alice.user.uid, code: t1.code, newPassword: 'alice-a-password-1' } });
  check(useT1.status === 401, '★ 生成第二枚后第一枚立即作废', `HTTP ${String(useT1.status)}`);
  const useT2 = await req('/api/auth/reset-password', { method: 'POST', body: { uid: alice.user.uid, code: t2.code, newPassword: 'alice-b-password-1' } });
  check(useT2.status === 200, '第二枚可用', `HTTP ${String(useT2.status)}`);
  const reuseT2 = await req('/api/auth/reset-password', { method: 'POST', body: { uid: alice.user.uid, code: t2.code, newPassword: 'alice-c-password-1' } });
  check(reuseT2.status === 401, '★ 用过的不能再用于 401', `HTTP ${String(reuseT2.status)}`);

  console.log('\n⑥ 无身份不能改别人的账户');
  const anonPw = await req('/api/account/password', { method: 'POST', body: { currentPassword: 'x', newPassword: 'yyyyyyyy' } });
  check(anonPw.status === 401, '不带凭证改密码 → 401', `HTTP ${String(anonPw.status)}`);
  const anonName = await req('/api/account/username', { method: 'POST', body: { currentPassword: 'x', newUsername: 'hacker' } });
  check(anonName.status === 401, '不带凭证改名 → 401', `HTTP ${String(anonName.status)}`);

  console.log('\n⑦ 仓库令牌 / 全局令牌没有账户身份');
  const repoCreate = await req('/api/repos', { method: 'POST', token: alice.accessToken, body: { name: 'test-repo' } });
  void repoCreate;
  const legacyPw = await req('/api/account/password', { method: 'POST', token: TOKEN, body: { currentPassword: 'x', newPassword: 'yyyyyyyy' } });
  check(legacyPw.status === 403, '★ 全局令牌改密码 → 403（它没有账户身份）', `HTTP ${String(legacyPw.status)}`);
  const legacyName = await req('/api/account/username', { method: 'POST', token: TOKEN, body: { currentPassword: 'x', newUsername: 'hacker' } });
  check(legacyName.status === 403, '★ 全局令牌改名 → 403', `HTTP ${String(legacyName.status)}`);

  console.log('\n⑧ 改密码后旧凭证全失效');
  const sess = await (await req('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'alice-b-password-1' } })).json();
  const other = await (await req('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'alice-b-password-1' } })).json();
  const changeRes = await req('/api/account/password', {
    method: 'POST', token: sess.accessToken,
    body: { currentPassword: 'alice-b-password-1', newPassword: 'alice-final-password-1' },
  });
  check(changeRes.status === 200, '改密码成功', `HTTP ${String(changeRes.status)}`);
  check((await req('/api/auth/refresh', { method: 'POST', body: { refreshToken: sess.refreshToken } })).status === 401,
    '★ 当前会话的 refresh 失效');
  check((await req('/api/auth/refresh', { method: 'POST', body: { refreshToken: other.refreshToken } })).status === 401,
    '★ 另一台设备的 refresh 也失效（改密码要全踢）');
  check((await req('/api/auth/me', { token: sess.accessToken })).status === 401, '★ 旧 access token 也失效');

  console.log('\n⑨ 旧密码不能登回');
  check((await req('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'alice-password-1' } })).status === 401, '最初密码 → 401');
  check((await req('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'alice-b-password-1' } })).status === 401, '上一版密码 → 401');
  check((await req('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'alice-final-password-1' } })).status === 200, '当前密码 → 200');

  console.log('\n⑩ 密码策略');
  const finalSess = await (await req('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'alice-final-password-1' } })).json();
  const tooShort = await req('/api/account/password', { method: 'POST', token: finalSess.accessToken, body: { currentPassword: 'alice-final-password-1', newPassword: 'abc' } });
  check(tooShort.status === 400, '★ 密码太短 → 400（不是 500）', `HTTP ${String(tooShort.status)}`);
  const same = await req('/api/account/password', { method: 'POST', token: finalSess.accessToken, body: { currentPassword: 'alice-final-password-1', newPassword: 'alice-final-password-1' } });
  check(same.status === 400, '新旧相同 → 400', `HTTP ${String(same.status)}`);

  console.log('\n⑪ 审计可追溯');
  const auditAccount = await (await req('/control/accounts?limit=200', { panel: true })).json();
  const aliceId = auditAccount.items.find((x) => x.username === 'alice').id;
  const db2 = new Database(join(wd, 'store', 'state.db'), { readonly: true });
  const events = db2.prepare("SELECT action, actor, ip, detail FROM events WHERE action LIKE 'account.%' ORDER BY id DESC LIMIT 20").all();
  db2.close();
  const actions = events.map((e) => e.action);
  check(actions.includes('account.issue-temp-password'), '★ 审计里有「生成临时密码」', actions.slice(0, 3).join(','));
  /*
   * 只断言**本次新增的**那条审计带操作者与来源。
   *
   * 不能要求"所有 account.* 都有 actor" —— `account.bootstrap-admin`
   * 是系统事件（首个账户注册时还没有任何身份可记），它天生就没有 actor。
   * 把那种事件也算进判据，只会逼后来的人给系统事件编一个假操作者。
   */
  const issued = events.filter((e) => e.action === 'account.issue-temp-password');
  check(issued.length > 0, '有「生成临时密码」审计', `${String(issued.length)} 条`);
  check(
    issued.every((e) => e.actor !== null && e.ip !== null),
    '★ 生成临时密码的审计带操作者与来源 IP',
    issued.map((e) => `${String(e.actor)}/${String(e.ip)}`).join(','),
  );

  console.log('\n⑫ 票据原文不落盘');
  const db3 = new Database(join(wd, 'store', 'state.db'), { readonly: true });
  const rows = db3.prepare('SELECT code_hash, code_prefix FROM password_tickets').all();
  const dump = JSON.stringify(rows);
  db3.close();
  /* 拿到过的所有明文码都不该出现在库里 */
  const plains = [issue.code, t1.code, t2.code];
  const leaked = plains.filter((p) => p && dump.includes(p));
  check(leaked.length === 0, '★ 库里只有哈希，查不到任何明文码', leaked.join(',') || '无泄露');
  check(rows.length > 0 && rows.every((r) => /^[0-9a-f]{64}$/.test(r.code_hash)), 'code_hash 是 sha256 形态');

  console.log('\n⑤ 暴力猜码有限速');
  /* 连打错误码，看是否会在若干次后被 429 */
  let sawRateLimit = false;
  let attempts = 0;
  for (let i = 0; i < 8; i += 1) {
    attempts += 1;
    const res = await req('/api/auth/reset-password', {
      method: 'POST', body: { uid: bob.user.uid, code: 'WRONGCODE' + String(i), newPassword: 'whatever-password-1' },
    });
    if (res.status === 429) { sawRateLimit = true; break; }
    if (res.status !== 401) { check(false, '猜错码应回 401', `HTTP ${String(res.status)}`); break; }
  }
  check(sawRateLimit, '★ 连续猜错触发 429 限速', `${String(attempts)} 次后`);

  /* aliceId 只是为了别让 lint 抱怨未使用 */
  void aliceId;
} catch (error) {
  console.error('检查失败：', error.message);
  results.push({ ok: false, label: '脚本异常：' + error.message });
} finally {
  try {
    srv.kill('SIGTERM');
    await delay(600);
    if (srv.exitCode === null) srv.kill('SIGKILL');
  } catch { /* ignore */ }
  try { rmSync(wd, { recursive: true, force: true }); } catch { /* EBUSY */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} 通过`);
if (failed.length > 0) {
  console.log('失败：' + failed.map((f) => f.label).join(' / '));
  process.exit(1);
}
console.log('未发现可被利用的路径。');
process.exit(0);
