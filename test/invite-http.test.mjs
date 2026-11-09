/**
 * 邀请码注册的 HTTP 端到端（v0.1.7）。
 *
 * ## 与另外两组的分工
 *
 * | 文件 | 测什么 |
 * |---|---|
 * | `invite-store.test.mjs` | 存储层：原子扣减、事务回滚、时效上限 |
 * | `invite-register.test.mjs` | 服务层：四档模式互不影响、撞车不扣额度 |
 * | **本文件** | **HTTP 链路**：端点在哪、谁能调、真实注册走通 |
 *
 * ## 端点位置是这里最该钉住的事
 *
 * 邀请码管理在**控制面**（`/control/invites`，控制端口），**不在**数据面
 * （`/api/invites`，API 端口）。原因是凭证模型不同：
 *
 *   · 控制面用**全局访问令牌**（`auth.token`），面板就是这么登录的；
 *   · 数据面用**账户 JWT 或仓库令牌**。
 *
 * 面板自己跑在控制端口上，它调 `/api/invites` 连 origin 都不对。
 * 第一版把路由挂在数据面、判据写成「账户 JWT + admin」，于是面板上
 * 这个功能**整块不可用**，而服务层单测全绿（单测直接调 `AuthService`，
 * 绕过了路由）。⇒ 本文件必须真的起服务、真的按面板的方式调用。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createDefaultConfig, writeConfig } from '../server/dist/config.js';

const ROOT = join(import.meta.dirname, '..');
const ENTRY = join(ROOT, 'server', 'dist', 'index.js');
const NODE = process.execPath;

/** 全局访问令牌：控制面的唯一凭证（面板登录用的就是它） */
const GLOBAL_TOKEN = 'H'.repeat(43);

let workDir;
let child;
/** 数据面端口（`/api/*`） */
let port;
/** 控制面端口（`/control/*`，面板所在） */
let controlPort;
let configPath;
const serverLogs = [];

/** 发一个 JSON 请求。`control: true` 时打到控制端口。 */
function request(path, options = {}) {
  const targetPort = options.port ?? (options.control === true ? controlPort : port);
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), 'utf8');
    const headers = { ...(options.headers || {}) };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(body.length);
    }
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    const req = httpRequest(
      { host: '127.0.0.1', port: targetPort, path, method: options.method || 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-invite-http-'));
  configPath = join(workDir, 'config.json');
  port = 28100 + Math.floor(Math.random() * 200);
  controlPort = port + 1;

  const config = createDefaultConfig({
    token: GLOBAL_TOKEN,
    port,
    controlPort,
    host: '127.0.0.1',
    controlHost: '127.0.0.1',
    dataDir: join(workDir, 'store'),
  });

  /*
   * 用 `open` 引导。
   *
   * **不能用 `admin-only`**：它的语义是"只有已登录管理员能建号"，
   * 而首账户本身还没建出来 —— 第一条注册就拿到
   * `403 FORBIDDEN: 仅管理员可以创建账户`（第一版踩过，15 条用例全挂在 before）。
   */
  config.auth.registerMode = 'open';
  writeConfig(configPath, config);

  child = spawn(NODE, [ENTRY, 'serve', '--config', configPath, '--log-level', 'warn'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => serverLogs.push(String(c)));
  child.stderr.on('data', (c) => serverLogs.push(String(c)));

  let lastProbe = '(从未探测)';
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await delay(200);
    try {
      const res = await request('/api/health');
      lastProbe = `HTTP ${String(res.status)}`;
      if (res.status === 200) break;
    } catch (error) {
      lastProbe = error?.code ?? String(error);
    }
  }
  if (lastProbe !== 'HTTP 200') {
    throw new Error(`服务未就绪（${lastProbe}）：\n${serverLogs.join('')}`);
  }
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
      /* Windows 上偶尔删不掉，不影响结论 */
    }
  }
});

/**
 * 把注册模式切到指定值。
 *
 * 控制端口的 `PUT /control/config` 是 **patch 语义**（字段缺席＝保持原值），
 * 且 `GET /control/config` 返回的 auth 段里 token 已被脱敏成 `tokenMasked` ——
 * 把 GET 的整份再 PUT 回去会抹掉凭证。所以只发要改的那个字段。
 *
 * 判据不能只看 200：`normalizeConfig` 会把不认识的值**静默回落 `closed`**，
 * 而 PUT 照样返回 200。必须回读磁盘。
 */
async function setRegisterMode(mode) {
  const res = await request('/control/config', {
    method: 'PUT',
    control: true,
    token: GLOBAL_TOKEN,
    body: { auth: { registerMode: mode } },
  });
  assert.equal(res.status, 200, `切换注册模式失败：${res.text}`);

  const saved = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(
    saved.auth.registerMode,
    mode,
    `切换后磁盘上是 ${saved.auth.registerMode}，期望 ${mode}（枚举不认识会静默回落 closed）`,
  );
}

/* ═════════ 控制面：谁能管理邀请码 ═════════ */

test('★ 无令牌调用 /control/invites 被拒（401）', async () => {
  const res = await request('/control/invites', { control: true });
  assert.equal(res.status, 401, res.text);
});

test('★ 错误令牌被拒（401）', async () => {
  const res = await request('/control/invites', { control: true, token: 'not-the-token' });
  assert.equal(res.status, 401, res.text);
});

test('★ 全局令牌可以列出邀请码，并拿到上限（界面不维护第二份常量）', async () => {
  const res = await request('/control/invites', { control: true, token: GLOBAL_TOKEN });
  assert.equal(res.status, 200, res.text);
  assert.ok(Array.isArray(res.json.invites));
  // 上限必须由服务端下发：两处各写一份必然漂移
  assert.equal(res.json.limits.maxUses, 3);
  assert.equal(res.json.limits.maxValidityMs, 15 * 24 * 60 * 60 * 1000);
});

test('★ 全局令牌可以生成邀请码（8 位、3 次、状态 active）', async () => {
  const res = await request('/control/invites', {
    method: 'POST',
    control: true,
    token: GLOBAL_TOKEN,
    body: { validityMs: 86400000, note: 'e2e' },
  });
  assert.equal(res.status, 201, res.text);
  assert.match(res.json.invite.code, /^[A-Z2-9]{8}$/);
  assert.equal(res.json.invite.max_uses, 3);
  assert.equal(res.json.invite.remaining, 3);
  assert.equal(res.json.invite.state, 'active');
  assert.equal(res.json.invite.note, 'e2e');
});

test('★ 超过 15 天被**服务端**拒绝（不能靠界面挡）', async () => {
  const res = await request('/control/invites', {
    method: 'POST',
    control: true,
    token: GLOBAL_TOKEN,
    body: { validityMs: 16 * 24 * 60 * 60 * 1000 },
  });
  assert.equal(res.status, 400, res.text);
  assert.equal(res.json.error.code, 'BAD_REQUEST');
});

test('validityMs 非数字 / 0 / 负数 都被拒（400）', async () => {
  for (const bad of ['abc', null, 0, -1000]) {
    const res = await request('/control/invites', {
      method: 'POST',
      control: true,
      token: GLOBAL_TOKEN,
      body: { validityMs: bad },
    });
    assert.equal(res.status, 400, `validityMs=${String(bad)} 应当 400：${res.text}`);
  }
});

test('★ 数据面**没有** /api/invites（只有一套鉴权语义）', async () => {
  /*
   * 防御性断言：若日后有人又在 worker 上加一套 `/api/invites`，
   * 就会出现两种凭证模型（全局令牌 vs 账户 JWT），而"哪套生效"取决于
   * 请求打到哪个端口 —— 那是最难查的一类不一致。
   * 邀请码管理的唯一入口是控制面的 `/control/invites`。
   */
  const res = await request('/api/invites', { token: GLOBAL_TOKEN });
  assert.equal(res.status, 404, `数据面不该有 /api/invites，实际 ${String(res.status)}：${res.text}`);
});

/* ═════════ 数据面：注册必须带码 ═════════ */

test('★ invite 模式下不带邀请码注册被拒（403 INVITE_REQUIRED）', async () => {
  await setRegisterMode('invite');
  const res = await request('/api/auth/register', {
    method: 'POST',
    body: { username: 'nokeyuser', password: 'some-password-123' },
  });
  assert.equal(res.status, 403, res.text);
  assert.equal(res.json.error.code, 'INVITE_REQUIRED');
});

test('★ 无效邀请码被拒（403 INVITE_INVALID）', async () => {
  const res = await request('/api/auth/register', {
    method: 'POST',
    body: { username: 'badkeyuser', password: 'some-password-123', inviteCode: 'ZZZZZZZZ' },
  });
  assert.equal(res.status, 403, res.text);
  assert.equal(res.json.error.code, 'INVITE_INVALID');
});

test('★ 有效邀请码可以完成注册，且剩余次数减 1', async () => {
  const created = await request('/control/invites', {
    method: 'POST',
    control: true,
    token: GLOBAL_TOKEN,
    body: { validityMs: 86400000 },
  });
  const code = created.json.invite.code;

  const res = await request('/api/auth/register', {
    method: 'POST',
    body: { username: 'invited1', password: 'invited-password-1', inviteCode: code },
  });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.user.username, 'invited1');
  assert.ok(typeof res.json.accessToken === 'string' && res.json.accessToken !== '', '应当直接登录');

  const list = await request('/control/invites', { control: true, token: GLOBAL_TOKEN });
  const found = list.json.invites.find((item) => item.code === code);
  assert.ok(found !== undefined);
  assert.equal(found.remaining, 2);
});

test('★ 一张码用满 3 次后，第 4 个注册被拒', async () => {
  const created = await request('/control/invites', {
    method: 'POST',
    control: true,
    token: GLOBAL_TOKEN,
    body: { validityMs: 86400000 },
  });
  const code = created.json.invite.code;

  for (let i = 1; i <= 3; i += 1) {
    const res = await request('/api/auth/register', {
      method: 'POST',
      body: { username: `batch${String(i)}`, password: 'batch-password-1234', inviteCode: code },
    });
    assert.equal(res.status, 201, `第 ${String(i)} 个应当成功：${res.text}`);
  }

  const fourth = await request('/api/auth/register', {
    method: 'POST',
    body: { username: 'batch4', password: 'batch-password-1234', inviteCode: code },
  });
  assert.equal(fourth.status, 403, fourth.text);
  assert.equal(fourth.json.error.code, 'INVITE_INVALID');
});

test('★ 邀请码可以带格式（小写 / 连字符 / 空格）—— 粘贴带格式不该失败', async () => {
  const created = await request('/control/invites', {
    method: 'POST',
    control: true,
    token: GLOBAL_TOKEN,
    body: { validityMs: 86400000 },
  });
  const code = created.json.invite.code;
  const pretty = ` ${code.slice(0, 4).toLowerCase()}-${code.slice(4).toLowerCase()} `;

  const res = await request('/api/auth/register', {
    method: 'POST',
    body: { username: 'prettyuser', password: 'pretty-password-123', inviteCode: pretty },
  });
  assert.equal(res.status, 201, `带格式的码应当被接受：${res.text}`);
});

/* ═════════ 作废 ═════════ */

test('★ 作废后该码立刻不能用，列表里状态为 revoked', async () => {
  const created = await request('/control/invites', {
    method: 'POST',
    control: true,
    token: GLOBAL_TOKEN,
    body: { validityMs: 86400000 },
  });
  const invite = created.json.invite;

  const del = await request(`/control/invites/${invite.id}`, {
    method: 'DELETE',
    control: true,
    token: GLOBAL_TOKEN,
  });
  assert.equal(del.status, 200, del.text);
  assert.equal(del.json.invite.state, 'revoked');

  const reg = await request('/api/auth/register', {
    method: 'POST',
    body: { username: 'afterrevoke', password: 'after-revoke-pass-1', inviteCode: invite.code },
  });
  assert.equal(reg.status, 403, reg.text);
  assert.equal(reg.json.error.code, 'INVITE_INVALID');
});

test('作废不存在的 id 返回 404', async () => {
  const res = await request('/control/invites/no-such-id', {
    method: 'DELETE',
    control: true,
    token: GLOBAL_TOKEN,
  });
  assert.equal(res.status, 404, res.text);
});

test('作废是幂等的（重复作废仍 200，保留最早时间）', async () => {
  const created = await request('/control/invites', {
    method: 'POST',
    control: true,
    token: GLOBAL_TOKEN,
    body: { validityMs: 86400000 },
  });
  const id = created.json.invite.id;
  const first = await request(`/control/invites/${id}`, {
    method: 'DELETE',
    control: true,
    token: GLOBAL_TOKEN,
  });
  const second = await request(`/control/invites/${id}`, {
    method: 'DELETE',
    control: true,
    token: GLOBAL_TOKEN,
  });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200, '重复作废不该报错');
  assert.equal(second.json.invite.revoked_at, first.json.invite.revoked_at, '保留最早的作废时间');
});

/* ═════════ 老模式在 HTTP 层不回归 ═════════ */

test('★ 切回 closed 后注册被拒（REGISTRATION_CLOSED）', async () => {
  await setRegisterMode('closed');
  const res = await request('/api/auth/register', {
    method: 'POST',
    body: { username: 'closedtry', password: 'closed-try-pass-123' },
  });
  assert.equal(res.status, 403, res.text);
  assert.equal(res.json.error.code, 'REGISTRATION_CLOSED');
});

test('★ 切回 open 后不带邀请码也能注册（老行为原样）', async () => {
  await setRegisterMode('open');
  const res = await request('/api/auth/register', {
    method: 'POST',
    body: { username: 'openuser', password: 'open-user-password-1' },
  });
  assert.equal(res.status, 201, `open 模式不该要求邀请码：${res.text}`);
});

test('★ open 模式下传了一个不存在的码也不影响（该字段不被读）', async () => {
  const res = await request('/api/auth/register', {
    method: 'POST',
    body: { username: 'openuser2', password: 'open-user-password-2', inviteCode: 'ZZZZZZZZ' },
  });
  assert.equal(res.status, 201, `open 模式不该因为这个字段拒绝：${res.text}`);
});
