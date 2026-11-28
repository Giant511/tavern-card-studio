/**
 * 登录设备与会话管理（2026-11-24 / 报告 P2-3）。
 *
 * ## 这个文件盯的是什么
 *
 * `SessionStore` 有三个方法此前**没有任何调用者**，而文档把"设备列表"
 * "改密码踢下线"写成了既有功能。三个方法加上 `LoginLimiter.unlock`
 * 现在各有真实入口，这个文件逐条验证它们**真的生效**：
 *
 * ```text
 *   listActive        → GET    /api/account/sessions
 *   revoke            → DELETE /api/account/sessions/:id
 *   revokeAllForUser  → POST   /api/account/sessions/revoke-all      （保留当前）
 *                       POST   /api/accounts/:id/revoke-sessions     （管理员全踢）
 *   unlock            → POST   /api/accounts/:id/unlock-login
 *   prune             → worker 定时器（本文件直接测存储层）
 * ```
 *
 * ## 为什么起真进程
 *
 * 权限分支是这一批的主要风险面：普通账户能不能踢别人、管理员端点有没有
 * 漏守卫。只测服务函数测不出来 —— 那些分支在路由层。
 *
 * ## 判据的两个方向
 *
 * 每条"允许"的用例都配一条"拒绝"的：
 *
 * ```text
 *   能看自己的会话       ×  看不到别人的
 *   能踢自己的会话       ×  踢别人的回 404（不区分"不存在"与"不是你的"）
 *   管理员能强制下线     ×  普通账户 403
 *   管理员能解封         ×  普通账户 403
 * ```
 *
 * 只测允许方向的话，"所有人都能做"的实现也会全绿。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createDefaultConfig, writeConfig } from '../server/dist/config.js';

const ROOT = join(import.meta.dirname, '..');
const ENTRY = join(ROOT, 'server', 'dist', 'index.js');
const NODE = process.execPath;

let child = null;
let workDir = '';
let dbFile = '';
let port = 0;

/** 根管理员（open 模式下第一个注册的账户） */
let admin = null;
/** 普通账户 A / B */
let alice = null;
let bob = null;

function request(path, { method = 'GET', body, token } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        },
      },
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
          resolve({ status: res.statusCode ?? 0, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 注册一个账户，返回 `{ id, token, refreshToken }` */
async function register(username, password) {
  const res = await request('/api/auth/register', { method: 'POST', body: { username, password } });
  assert.ok(res.status === 201 || res.status === 200, `注册 ${username} 失败：${res.text}`);
  return {
    id: res.json.user.id,
    username,
    password,
    token: res.json.accessToken,
    refreshToken: res.json.refreshToken,
  };
}

/** 用 refresh token 换新 access（验证会话是否真的失效） */
function refresh(refreshToken) {
  return request('/api/auth/refresh', { method: 'POST', body: { refreshToken } });
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-session-mgmt-'));
  // 端口段避开 account-purge（29100+）与 repo-transfer（27500+）
  port = 29500 + Math.floor(Math.random() * 300);

  const config = createDefaultConfig({
    token: 'S'.repeat(43),
    port,
    controlPort: port + 1,
    host: '127.0.0.1',
    controlHost: '127.0.0.1',
    dataDir: join(workDir, 'store'),
  });
  config.auth.registerMode = 'open';
  const configPath = join(workDir, 'config.json');
  writeConfig(configPath, config);
  dbFile = join(workDir, 'store', 'state.db');

  child = spawn(NODE, [ENTRY, 'serve', '--config', configPath, '--log-level', 'warn'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (c) => logs.push(String(c)));
  child.stderr.on('data', (c) => logs.push(String(c)));

  let last = '(从未探测)';
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await delay(200);
    try {
      const res = await request('/api/health');
      last = `HTTP ${res.status}`;
      if (res.status === 200) break;
    } catch (error) {
      last = error?.code ?? String(error);
    }
  }
  if (last !== 'HTTP 200') throw new Error(`服务未就绪（${last}）：\n${logs.join('')}`);

  // open 模式下第一个注册的成为管理员 —— 顺序不能变
  admin = await register('rootadmin', 'rootadmin-password-1');
  assert.equal((await request('/api/account/sessions', { token: admin.token })).status, 200);
  alice = await register('alice', 'alice-password-1');
  bob = await register('bob', 'bob-password-1');
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await delay(800);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (workDir) {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发 EBUSY：临时目录留给系统清理，不让它把测试判成红 */
    }
  }
});

// ══════════════════════════════════════════════════════════
// 设备列表
// ══════════════════════════════════════════════════════════

test('★★★★ 设备列表：列出自己的活跃会话，当前设备带 current 标记', async () => {
  const res = await request('/api/account/sessions', { token: alice.token });
  assert.equal(res.status, 200, res.text);
  assert.ok(Array.isArray(res.json.items), '返回结构应为 { items: [] }');
  assert.ok(res.json.items.length >= 1, '至少应有当前这一个会话');
  const current = res.json.items.filter((one) => one.current === true);
  assert.equal(current.length, 1, '有且只有一个会话应被标成当前设备');
  // 设备信息齐全：没有 UA / IP 的话列表没法用
  assert.ok(typeof current[0].userAgent === 'string', '缺 userAgent');
  assert.ok(typeof current[0].createdAt === 'string', '缺 createdAt');
});

test('★★★★ 设备列表：只看得到自己的，看不到别人的', async () => {
  const mine = await request('/api/account/sessions', { token: alice.token });
  const ids = new Set(mine.json.items.map((one) => one.id));

  // bob 刚注册，他的会话 id 不该出现在 alice 的列表里
  const bobList = await request('/api/account/sessions', { token: bob.token });
  for (const one of bobList.json.items) {
    assert.equal(ids.has(one.id), false, `alice 的列表里出现了 bob 的会话 ${one.id}`);
  }
});

test('★★★ 设备列表：仓库令牌与 legacy 令牌不能查（只认账户登录）', async () => {
  /*
   * 会话列表带 IP 与 UA，属于账户私有信息。仓库令牌是"给某个仓库的受限授权"，
   * 不该看到设备清单。这条与 `/api/account/summary` 的口径一致。
   */
  const legacy = await request('/api/account/sessions', { token: 'S'.repeat(43) });
  assert.equal(legacy.status, 403, `legacy 应当 403，实际 ${String(legacy.status)}`);
});

// ══════════════════════════════════════════════════════════
// 踢下线
// ══════════════════════════════════════════════════════════

test('★★★★★ 踢自己的会话：refresh 立即失效', async () => {
  // 再造一个会话，这样踢掉它不会影响当前登录
  const second = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'alice', password: 'alice-password-1' },
  });
  assert.equal(second.status, 200, second.text);
  const secondToken = second.json.accessToken;
  const secondRefresh = second.json.refreshToken;

  const list = await request('/api/account/sessions', { token: alice.token });
  const other = list.json.items.find((one) => one.current === false);
  assert.ok(other !== undefined, '应当能看到第二个会话');

  const del = await request(`/api/account/sessions/${other.id}`, {
    method: 'DELETE',
    token: alice.token,
  });
  assert.equal(del.status, 200, del.text);
  assert.equal(del.json.revoked, true);
  assert.equal(del.json.self, false, '踢的不是当前设备');

  // 会话吊销立即生效：access 与 refresh 都不能再用
  const after = await request('/api/account/summary', { token: secondToken });
  assert.equal(after.status, 401, `被踢的 access 仍可用（${String(after.status)}）`);
  const refreshed = await refresh(secondRefresh);
  assert.equal(refreshed.status, 401, `被踢的 refresh 仍能续期（${String(refreshed.status)}）`);
});

test('★★★★★ 踢别人：回 404，且对方的会话不受影响', async () => {
  const bobList = await request('/api/account/sessions', { token: bob.token });
  const bobSession = bobList.json.items[0];

  const del = await request(`/api/account/sessions/${bobSession.id}`, {
    method: 'DELETE',
    token: alice.token,
  });
  // 「不存在」与「不是你的」同一个 404：不给会话 id 留枚举面
  assert.equal(del.status, 404, `跨账户踢人没被拦住（${String(del.status)}）`);

  const stillOk = await request('/api/account/sessions', { token: bob.token });
  assert.equal(stillOk.status, 200, 'bob 的会话被误踢了');
});

test('★★★★ 退出其它设备：保留当前会话', async () => {
  // alice 再造两个会话
  const a = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'alice', password: 'alice-password-1' },
  });
  const b = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'alice', password: 'alice-password-1' },
  });
  assert.equal(a.status, 200, a.text);
  assert.equal(b.status, 200, b.text);

  const res = await request('/api/account/sessions/revoke-all', {
    method: 'POST',
    token: alice.token,
    body: {},
  });
  assert.equal(res.status, 200, res.text);
  assert.ok(res.json.revoked >= 2, `应至少踢掉两个会话，实际 ${String(res.json.revoked)}`);

  // 当前这个还能用（"退出其它设备"顺带把自己踢掉会让用户以为操作失败）
  const me = await request('/api/account/sessions', { token: alice.token });
  assert.equal(me.status, 200, '当前会话被一起踢掉了');
  assert.equal(me.json.items.length, 1, '列表里应只剩当前这一个');

  // 另外两个不能续期
  assert.equal((await refresh(a.json.refreshToken)).status, 401);
  assert.equal((await refresh(b.json.refreshToken)).status, 401);
});

// ══════════════════════════════════════════════════════════
// 管理员：强制下线
// ══════════════════════════════════════════════════════════

test('★★★★★ 强制下线：普通账户 403', async () => {
  const res = await request(`/api/accounts/${bob.id}/revoke-sessions`, {
    method: 'POST',
    token: alice.token,
    body: {},
  });
  assert.equal(res.status, 403, `普通账户能踢别人（${String(res.status)}）`);
  assert.equal(res.json?.error?.code, 'ADMIN_ONLY');
});

test('★★★★★ 强制下线：管理员可踢，被踢的 access 立即 401', async () => {
  const res = await request(`/api/accounts/${bob.id}/revoke-sessions`, {
    method: 'POST',
    token: admin.token,
    body: {},
  });
  assert.equal(res.status, 200, res.text);
  assert.ok(res.json.revoked >= 1, '至少要踢掉 bob 那条会话');

  const after = await request('/api/account/summary', { token: bob.token });
  assert.equal(after.status, 401, `被强制下线的 access 仍可用（${String(after.status)}）`);

  // 重新登录给后续用例留一个可用会话
  const relogin = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'bob', password: 'bob-password-1' },
  });
  assert.equal(relogin.status, 200, relogin.text);
  bob = { ...bob, token: relogin.json.accessToken, refreshToken: relogin.json.refreshToken };
});

test('★★★ 强制下线：目标不存在回 404', async () => {
  const res = await request('/api/accounts/no-such-user/revoke-sessions', {
    method: 'POST',
    token: admin.token,
    body: {},
  });
  assert.equal(res.status, 404);
});

// ══════════════════════════════════════════════════════════
// 管理员：解除登录锁定
// ══════════════════════════════════════════════════════════

test('★★★★★ 解除登录锁定：普通账户 403', async () => {
  const res = await request(`/api/accounts/${bob.id}/unlock-login`, {
    method: 'POST',
    token: alice.token,
    body: {},
  });
  assert.equal(res.status, 403, `普通账户能解封（${String(res.status)}）`);
});

test('★★★★★ 解除登录锁定：锁住时报 ACCOUNT_LOCKED，解开后一次就能登', async () => {
  /*
   * 这是这一批里唯一需要"先制造坏状态"的判据。
   *
   * 造法：用错密码连打 5 次（`DEFAULT_RATE_LIMIT.maxFailures`），
   * 触发账户维度锁定。此时即使用**正确**密码也登不上 —— 那正是锁的含义。
   * 但状态码不能再用 401：401 会被用户读成"密码错"，分不清是锁了还是打错字。
   *
   * ★ 两个维度要一次清干净（这条判据抓到过一次）：
   *   五次失败把 **IP 维度也锁了**；面板只清账户维度时，管理员点了"解除锁定"
   *   仍然登不上。现在面板与 CLI 同口径，一次调用清 account + 全部 ip 行。
   */
  const victim = await register('lockme', 'lockme-password-1');

  for (let i = 0; i < 5; i += 1) {
    await request('/api/auth/login', {
      method: 'POST',
      body: { username: 'lockme', password: `wrong-password-${String(i)}` },
    });
  }

  const locked = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'lockme', password: 'lockme-password-1' },
  });
  assert.equal(locked.status, 423, `五次失败后应报 423（实际 ${String(locked.status)}）：${locked.text}`);
  assert.equal(locked.json?.error?.code, 'ACCOUNT_LOCKED', '锁定要有独立错误码，不能复用密码错');
  assert.match(String(locked.json?.error?.message ?? ''), /锁定/, '文案要明说账号锁定');
  assert.match(String(locked.json?.error?.message ?? ''), /10 分钟/, '文案要给出等待时长');
  const retryAfter = Number(locked.json?.error?.details?.retryAfterSeconds);
  assert.ok(retryAfter > 0, '要带 retryAfterSeconds，前端才能倒计时');
  /*
   * P5 的判据不止"文案写了 10 分钟"：锁必须真的锁 10 分钟。
   *
   * `DEFAULT_RATE_LIMIT.lockMs` 是 10 分钟，第 5 次失败时落 locked_until；
   * 这里取 9 到 10 分钟的区间（请求本身耗时几毫秒），文案与效果对不上时
   * 这条会红：改小 lockMs 会让下界失守，文案乱写会让断言前面那条红。
   */
  assert.ok(
    retryAfter >= 9 * 60 && retryAfter <= 10 * 60,
    `锁定要真的持续 10 分钟，实际 ${String(retryAfter)} 秒`,
  );
  const again = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'lockme', password: 'wrong-password-again' },
  });
  assert.equal(again.status, 423, '锁定期间再试仍是 423');
  assert.ok(
    Number(again.json?.error?.details?.retryAfterSeconds) <= retryAfter,
    '锁定期间继续尝试不许把锁续期（否则可被用来无限拒绝服务）',
  );

  const unlock = await request(`/api/accounts/${victim.id}/unlock-login`, {
    method: 'POST',
    token: admin.token,
    body: {},
  });
  assert.equal(unlock.status, 200, unlock.text);
  assert.ok(unlock.json.clearedAccount >= 1, `账户维度应有记录被清，实际 ${String(unlock.json.clearedAccount)}`);
  assert.ok(unlock.json.clearedIps >= 1, `IP 维度也应在同一次调用里清掉，实际 ${String(unlock.json.clearedIps)}`);
  assert.ok(
    unlock.json.cleared === unlock.json.clearedAccount + unlock.json.clearedIps,
    'cleared 必须等于两个维度之和',
  );
  assert.equal(
    'remainingIpHint' in unlock.json,
    false,
    '不该再让管理员猜 IP 还锁着没有',
  );

  const back = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'lockme', password: 'lockme-password-1' },
  });
  assert.equal(back.status, 200, `解封后仍登不上（${String(back.status)}）：${back.text}`);
});

test('★★★ 解除登录锁定：本来没锁时 clearedAccount=0，不报错', async () => {
  /*
   * 幂等：管理员连点两次不该在第二次报错。返回 0 而不是 404 ——
   * "没有可解的东西"是正常结果，不是失败。
   *
   * 只断言账户维度是 0：IP 行不带账户名，历史上别的用例失败过的 IP
   * 可能还留着，这里清到它们不算错。
   */
  const res = await request(`/api/accounts/${bob.id}/unlock-login`, {
    method: 'POST',
    token: admin.token,
    body: {},
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.clearedAccount, 0);
});

// ══════════════════════════════════════════════════════════
// 存储层：prune
// ══════════════════════════════════════════════════════════

test('★★★★★ prune 清掉过期与早已吊销的会话，保留近期吊销的', async () => {
  /*
   * 为什么直接在库上测：`prune` 由 worker 的 6 小时定时器调用，
   * 测试里等不到。而它要判断的正是"哪些该删、哪些该留"的边界，
   * 这个边界用真库最直观。
   *
   * 三档：
   *   · 过期 90 天、从未吊销        → 删（expires_at < cutoff）
   *   · 30 天前吊销、尚未过期        → 删（revoked_at < cutoff，宽限期 7 天）
   *   · 1 天前吊销、尚未过期         → 留（在宽限期内，用户还能看到"为什么被踢"）
   *   · 一切正常的活跃会话           → 留
   */
  const { default: Database } = await import('better-sqlite3');
  const { SessionStore } = await import('../server/dist/auth/sessions.js');

  const db = new Database(dbFile);
  const store = new SessionStore(db);
  const now = new Date();
  const day = 24 * 3600 * 1000;
  const iso = (offsetMs) => new Date(now.getTime() + offsetMs).toISOString();

  const insert = db.prepare(
    `INSERT INTO sessions (id, user_id, refresh_hash, created_at, updated_at, expires_at, revoked_at, revoke_reason, last_seen_at, user_agent, ip)
     VALUES (@id, @user_id, @refresh_hash, @created_at, @updated_at, @expires_at, @revoked_at, @revoke_reason, NULL, 'test', '127.0.0.1')`,
  );
  const seed = (id, expiresAt, revokedAt) =>
    insert.run({
      id,
      user_id: bob.id,
      // ★ refresh_hash 有唯一约束：三条种子必须用不同的值。
      //   第一版全用 'x'.repeat(64)，于是第二条 insert 就撞 UNIQUE ——
      //   而错误信息指向约束名，很容易被误读成"表结构不对"。
      refresh_hash: `${id}-hash`.padEnd(64, '.'),
      created_at: iso(-90 * day),
      updated_at: iso(-90 * day),
      expires_at: expiresAt,
      revoked_at: revokedAt,
      revoke_reason: revokedAt === null ? null : 'test',
    });

  seed('prune-expired', iso(-90 * day), null);
  seed('prune-old-revoked', iso(+30 * day), iso(-30 * day));
  seed('prune-recent-revoked', iso(+30 * day), iso(-1 * day));

  const removed = store.prune(now);
  assert.ok(removed >= 2, `应至少清掉 2 条，实际 ${String(removed)}`);

  const left = db
    .prepare("SELECT id FROM sessions WHERE id LIKE 'prune-%' ORDER BY id")
    .all()
    .map((row) => row.id);
  assert.deepEqual(left, ['prune-recent-revoked'], `留下的集合不对：${left.join(',')}`);

  db.close();
});

// ══════════════════════════════════════════════════════════
// 文档不撒谎
// ══════════════════════════════════════════════════════════

test('★★★★ 文档承诺的两条解锁路径都必须真实存在', async () => {
  /*
   * 报告 P2-3 的原文是「文档写成了既有功能」：`server-developer.md` 从 v0.1.3
   * 起就写着"管理员着急可以手工解锁（tcs-server 的运维命令，见 server-cmd.md）"，
   * 而那个命令**根本不存在**，`server-cmd.md` 里也查不到。
   *
   * 这类"文档比代码走得快"的洞不会报错，只会在用户最着急的时候（被锁在门外）
   * 变成一条走不通的路。所以钉成判据：文档提到哪条路，代码里就得有那条路。
   */
  const { readFileSync } = await import('node:fs');

  const doc = readFileSync(join(ROOT, 'docs', 'server-developer.md'), 'utf8');
  const cli = readFileSync(join(ROOT, 'server', 'src', 'cli.ts'), 'utf8');

  // ① 文档提到的 HTTP 端点
  assert.ok(
    doc.includes('/api/accounts/:id/unlock-login'),
    '文档没提 HTTP 解锁端点 —— 或者端点改名了而文档没跟',
  );
  const routes = readFileSync(join(ROOT, 'server', 'src', 'http', 'account-routes.ts'), 'utf8');
  assert.ok(
    routes.includes("router.post('/api/accounts/:id/unlock-login'"),
    '文档写了 /api/accounts/:id/unlock-login，但路由里没有',
  );

  // ② 文档提到的 CLI 命令
  assert.ok(doc.includes('tcs-server user unlock'), '文档没提 CLI 解锁命令');
  assert.ok(
    cli.includes("action === 'unlock'"),
    '文档写了 `tcs-server user unlock`，但 cli.ts 里没有这个分支',
  );
  assert.ok(
    cli.includes('|unlock|'),
    'CLI 帮助文本里没有列出 unlock —— 用户查不到这个命令',
  );
});

test('★★★★ 同一设备重新登录：旧会话被 replaced，设备列表仍只有一行', async () => {
  /*
   * 面板在「未勾 7 天免密」时每次刷新都要重新登录。如果每次登录都新建一行，
   * 设备列表会越用越长。这是用户 2026-11-27 报的 P2。
   *
   * 判据落在"同一 IP + 同一 UA 的旧会话被吊销"上，不依赖前端：
   * 第二次登录后，列表里只能有第二次那条，第一次的 refresh 也必须失效。
   */
  const first = await request('/api/auth/login', {
    method: 'POST',
    body: { username: bob.username, password: bob.password, reuseDevice: true },
  });
  assert.equal(first.status, 200, first.text);

  const second = await request('/api/auth/login', {
    method: 'POST',
    body: { username: bob.username, password: bob.password, reuseDevice: true },
  });
  assert.equal(second.status, 200, second.text);

  const listed = await request('/api/account/sessions', { token: second.json.accessToken });
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.json.items.length, 1, `同设备重复登录后仍有 ${String(listed.json.items.length)} 条会话`);

  const oldRefresh = await refresh(first.json.refreshToken);
  assert.equal(oldRefresh.status, 401, '旧会话必须失效，否则"被顶掉"只是列表里看不见');
});
