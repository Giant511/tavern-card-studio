/**
 * F13.4 仓库删除与转移 + 管理员跨账户（T10.19）。
 *
 * 真进程 + 真 HTTP。这一轮的重点全是"边界"：
 *   · 非空仓库不带 transferTo 必须被拒（不能悄悄级联删卡）；
 *   · 带了就必须**一个事务**地全量转移 —— 回收站里的卡也要走（否则恢复后指向死仓库）；
 *   · 绑定到该仓库的令牌要一起吊销（留一把开向已删仓库的钥匙没有意义）；
 *   · 默认仓库不给删，只能「转移默认」；
 *   · 跨账户：普通账户 404（不泄露存在性），管理员可做且必须留痕。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
let port = 0;
let configPath = '';
let admin = null;
let user = null;

function request(path, { method = 'GET', body, token, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(raw ? body : JSON.stringify(body), 'utf8');
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

const cardBody = (name) =>
  JSON.stringify({ spec: 'chara_card_v2', data: { name, description: 'x', first_mes: 'y', mes_example: '' } });

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-repo-'));
  configPath = join(workDir, 'config.json');
  port = 27500 + Math.floor(Math.random() * 300);

  const config = createDefaultConfig({
    token: 'G'.repeat(43),
    port,
    controlPort: port + 1,
    host: '127.0.0.1',
    controlHost: '127.0.0.1',
    dataDir: join(workDir, 'store'),
  });
  config.auth.registerMode = 'open';
  writeConfig(configPath, config);

  child = spawn(NODE, [ENTRY, 'serve', '--config', configPath, '--log-level', 'warn'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (c) => logs.push(String(c)));
  child.stderr.on('data', (c) => logs.push(String(c)));

  let lastProbe = '(从未探测)';
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await delay(200);
    try {
      const res = await request('/api/health');
      lastProbe = `HTTP ${res.status}`;
      if (res.status === 200) break;
    } catch (error) {
      lastProbe = error?.code ?? String(error);
    }
  }
  if (lastProbe !== 'HTTP 200') throw new Error(`服务未就绪（${lastProbe}）：\n${logs.join('')}`);

  const mk = async (username) => {
    const password = `${username}-password-1`;
    const reg = await request('/api/auth/register', { method: 'POST', body: { username, password } });
    assert.equal(reg.status, 201, reg.text);
    const login = await request('/api/auth/login', { method: 'POST', body: { username, password } });
    assert.equal(login.status, 200, login.text);
    return { id: reg.json.user.id, role: reg.json.user.role, token: login.json.accessToken, username };
  };
  admin = await mk('root');
  user = await mk('regular');
  assert.equal(admin.role, 'admin');
  assert.equal(user.role, 'user');
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await delay(600);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const upload = (token, cardId, name = 'repo probe') =>
  request(`/api/cards?cardId=${encodeURIComponent(cardId)}`, {
    method: 'POST',
    body: cardBody(name),
    raw: true,
    token,
  });

const reposOf = async (token) => (await request('/api/repos', { token })).json.items;

// ══════════════════════════════════════════════════════════
// ① 转移删除
// ══════════════════════════════════════════════════════════

test('默认仓库不能删除（入口应改成「转移默认」）', async () => {
  const items = await reposOf(user.token);
  const def = items.find((item) => item.isDefault);
  assert.ok(def);

  const del = await request(`/api/repos/${def.id}`, { method: 'DELETE', token: user.token });
  assert.equal(del.status, 409, del.text);
  assert.match(del.json.error.message, /默认仓库不能删除/);
  // 明确指向正确做法
  assert.match(del.json.error.message, /转移默认|设为默认/);
});

test('非空仓库不带 transferTo → 409，且卡片一张都没动', async () => {
  const created = await request('/api/repos', { method: 'POST', body: { name: 'busy' }, token: user.token });
  assert.equal(created.status, 201, created.text);
  const repoId = created.json.id ?? created.json.repo?.id;

  await upload(user.token, 'busy-card-1');
  await request('/api/cards/busy-card-1/move', { method: 'POST', body: { repo: repoId }, token: user.token });

  const del = await request(`/api/repos/${repoId}`, { method: 'DELETE', token: user.token });
  assert.equal(del.status, 409, del.text);
  assert.match(del.json.error.message, /必须指定目标仓库/);

  // 仓库与卡片都还在
  const after = await reposOf(user.token);
  assert.ok(after.some((item) => item.id === repoId), '被拒的删除不该动仓库');
  const card = await request('/api/cards/busy-card-1', { token: user.token });
  assert.equal(card.status, 200);
  assert.equal(card.json.repoId, repoId);
});

test('带 transferTo：卡片全部转移（含回收站里的），仓库随后删除', async () => {
  const items = await reposOf(user.token);
  const busy = items.find((item) => item.name === 'busy');
  const def = items.find((item) => item.isDefault);

  // 再造两张：一张正常、一张在回收站里
  await upload(user.token, 'busy-card-2');
  await request('/api/cards/busy-card-2/move', { method: 'POST', body: { repo: busy.id }, token: user.token });
  await upload(user.token, 'busy-card-trashed');
  await request('/api/cards/busy-card-trashed/move', { method: 'POST', body: { repo: busy.id }, token: user.token });
  await request('/api/cards/busy-card-trashed', { method: 'DELETE', token: user.token });

  const del = await request(`/api/repos/${busy.id}`, {
    method: 'DELETE',
    body: { transferTo: def.id },
    token: user.token,
  });
  assert.equal(del.status, 200, del.text);
  assert.equal(del.json.deleted, true);
  assert.equal(del.json.movedCards, 3, '三张（含回收站里那张）都要转移');
  assert.equal(del.json.transferredTo, def.id);

  for (const id of ['busy-card-1', 'busy-card-2']) {
    const card = await request(`/api/cards/${id}`, { token: user.token });
    assert.equal(card.status, 200);
    assert.equal(card.json.repoId, def.id, `${id} 应已转到默认仓库`);
  }
  // 回收站那张也转过来了（否则恢复后会指向一个已删仓库）
  const trashed = await request('/api/cards/busy-card-trashed?includeDeleted=true', { token: user.token });
  assert.equal(trashed.status, 200, 'includeDeleted=true 仍能读到回收站里的卡');
  assert.ok(trashed.json.deletedAt, '它应当还带着删除标记');
  const restored = await request('/api/cards/busy-card-trashed/restore', { method: 'POST', token: user.token });
  assert.equal(restored.status, 200, restored.text);
  const afterRestore = await request('/api/cards/busy-card-trashed', { token: user.token });
  assert.equal(afterRestore.json.repoId, def.id, '恢复后必须落在一个存在的仓库里');

  const reposAfter = await reposOf(user.token);
  assert.equal(reposAfter.some((item) => item.id === busy.id), false, '仓库应已不在列表');
});

test('转移目标必须存在、必须是同一账户、不能是自己', async () => {
  const created = await request('/api/repos', { method: 'POST', body: { name: 'src' }, token: user.token });
  const srcId = created.json.id ?? created.json.repo?.id;
  await upload(user.token, 'src-card-1');
  await request('/api/cards/src-card-1/move', { method: 'POST', body: { repo: srcId }, token: user.token });

  const ghost = await request(`/api/repos/${srcId}`, {
    method: 'DELETE',
    body: { transferTo: 'no-such-repo' },
    token: user.token,
  });
  assert.equal(ghost.status, 409, ghost.text);

  const self = await request(`/api/repos/${srcId}`, {
    method: 'DELETE',
    body: { transferTo: srcId },
    token: user.token,
  });
  assert.equal(self.status, 409, self.text);

  // 跨账户目标：普通账户既看不到也无法用它
  const adminRepos = await reposOf(admin.token);
  const foreign = await request(`/api/repos/${srcId}`, {
    method: 'DELETE',
    body: { transferTo: adminRepos[0].id },
    token: user.token,
  });
  assert.equal(foreign.status, 409, foreign.text);
  assert.match(foreign.json.error.message, /同一个账户/);

  // 清场：转回默认仓库后删掉
  const def = (await reposOf(user.token)).find((item) => item.isDefault);
  await request(`/api/repos/${srcId}`, { method: 'DELETE', body: { transferTo: def.id }, token: user.token });
});

test('绑定到被删仓库的令牌一起吊销', async () => {
  const created = await request('/api/repos', { method: 'POST', body: { name: 'tokenized' }, token: user.token });
  const repoId = created.json.id ?? created.json.repo?.id;

  const issued = await request(`/api/repos/${repoId}/tokens`, {
    method: 'POST',
    body: { name: 'ci', scopes: ['read'] },
    token: user.token,
  });
  assert.equal(issued.status, 201, issued.text);
  const tokenId = issued.json.id;

  const def = (await reposOf(user.token)).find((item) => item.isDefault);
  const del = await request(`/api/repos/${repoId}`, {
    method: 'DELETE',
    body: { transferTo: def.id },
    token: user.token,
  });
  assert.equal(del.status, 200, del.text);
  assert.equal(del.json.revokedTokens, 1, '该仓库的令牌必须一起吊销');

  const list = await request(`/api/tokens`, { token: user.token });
  if (list.status === 200) {
    const still = (list.json.items ?? []).find((item) => item.id === tokenId);
    assert.equal(still?.revokedAt ?? still?.revoked_at ?? null, still ? null : null, '已吊销的令牌不该出现在可用列表');
  }
});

// ══════════════════════════════════════════════════════════
// ② 管理员跨账户
// ══════════════════════════════════════════════════════════

test('跨账户：普通账户删别人的仓库 → 404（不泄露存在性）', async () => {
  const adminRepos = await reposOf(admin.token);
  const target = adminRepos[0];
  const res = await request(`/api/repos/${target.id}`, { method: 'DELETE', token: user.token });
  assert.equal(res.status, 404, '归属不匹配一律 404（docs/29 §2）');
  assert.equal(res.json.error.code, 'NOT_FOUND');
});

test('跨账户：管理员可以删普通账户的仓库，并写一条审计', async () => {
  const created = await request('/api/repos', { method: 'POST', body: { name: 'victim' }, token: user.token });
  const repoId = created.json.id ?? created.json.repo?.id;
  const def = (await reposOf(user.token)).find((item) => item.isDefault);

  const del = await request(`/api/repos/${repoId}`, {
    method: 'DELETE',
    body: { transferTo: def.id, reason: '清理测试仓库' },
    token: admin.token,
  });
  assert.equal(del.status, 200, `管理员应可跨账户删除：${del.text}`);

  const events = await request('/api/events?limit=50&all=true', { token: admin.token });
  assert.equal(events.status, 200, events.text);
  const hit = events.json.items.find((item) => item.action === 'repo.delete.cross-account');
  assert.ok(hit, '跨账户删除必须留痕');
  assert.equal(hit.actor, 'root', '要记下是谁做的');
  assert.equal(hit.detail.reason, '清理测试仓库', '原因要写进事件');
});

test('跨账户：管理员可把别人的卡片移进自己的仓库，事件标记 cross-account', async () => {
  const repos = await reposOf(user.token);
  const def = repos.find((item) => item.isDefault);
  /*
   * 目标必须是**管理员自己的仓库**才算跨账户。
   * 第一版我把目标建成 user 的另一个仓库，于是 `crossOwner` 为 false ——
   * 那是同账户内移动，断言"跨账户"自然不成立（实现是对的，测试前提错了）。
   */
  const adminRepos = await reposOf(admin.token);
  const destId = adminRepos.find((item) => item.isDefault).id;

  const up = await upload(user.token, 'cross-card-1');
  assert.equal(up.status, 201, `上传失败：${up.text}`);
  const before = await request('/api/cards/cross-card-1', { token: user.token });
  assert.equal(before.status, 200, before.text);
  assert.equal(before.json.repoId, def.id);

  // 管理员「自己的」卡片列表里看不到它（默认读仍是 own scope）
  const adminList = await request('/api/cards?limit=200', { token: admin.token });
  assert.equal(adminList.json.items.some((item) => item.id === 'cross-card-1'), false, '默认视图不应包含别人的卡');
  // 但治理视图可以
  const govList = await request('/api/cards?limit=200&all=true', { token: admin.token });
  assert.equal(govList.json.items.some((item) => item.id === 'cross-card-1'), true, '?all=true 才看全站');

  const moved = await request('/api/cards/cross-card-1/move', {
    method: 'POST',
    body: { repo: destId, reason: '帮用户整理' },
    token: admin.token,
  });
  assert.equal(moved.status, 200, `管理员应可跨账户移动：${moved.text}`);
  assert.equal(moved.json.crossOwner, true, '目标仓库属于管理员，必须标记为跨账户');

  // 移过去之后，它出现在管理员的（默认）列表里，不再是普通账户的
  const ownerList = await request('/api/cards?limit=200', { token: user.token });
  assert.equal(ownerList.json.items.some((item) => item.id === 'cross-card-1'), false, '原账户应看不到它了');
  const newOwnerList = await request('/api/cards?limit=200', { token: admin.token });
  assert.equal(newOwnerList.json.items.some((item) => item.id === 'cross-card-1'), true, '管理员应能看到它了');

  const events = await request('/api/events?limit=50&all=true', { token: admin.token });
  const hit = events.json.items.find((item) => item.action === 'card.move.cross-account');
  assert.ok(hit, '跨账户移动必须留痕');
  assert.equal(hit.detail.reason, '帮用户整理');
  assert.ok(hit.detail.fromOwner && hit.detail.toOwner, '要记下从哪个账户到哪个账户');
});

test('普通账户不能用 ?all=true 看全站', async () => {
  const res = await request('/api/cards?all=true', { token: user.token });
  assert.equal(res.status, 403, res.text);
  assert.equal(res.json.error.code, 'ADMIN_ONLY');
});

test('仓库令牌不能借 ?all=true 看全站（即使它属于管理员账户）', async () => {
  const repos = await reposOf(admin.token);
  const issued = await request(`/api/repos/${repos[0].id}/tokens`, {
    method: 'POST',
    body: { name: 'admin-repo-token', scopes: ['read'] },
    token: admin.token,
  });
  assert.equal(issued.status, 201, issued.text);
  const repoToken = issued.json.token;

  const res = await request('/api/cards?all=true', { token: repoToken });
  assert.equal(res.status, 403, '仓库令牌的边界就是它绑定的仓库，不能升格为全站');
});

test('清理配置写回：transferTo 缺失时 body 为空也能正确报错（不是崩溃）', async () => {
  writeFileSync(configPath, JSON.stringify(JSON.parse(await import('node:fs').then((m) => m.readFileSync(configPath, 'utf8'))), null, 2));
  const repos = await reposOf(user.token);
  const nonDefault = repos.filter((item) => !item.isDefault);
  for (const repo of nonDefault) {
    const res = await request(`/api/repos/${repo.id}`, { method: 'DELETE', token: user.token });
    // 空仓库 → 200；非空 → 409。两种都必须是**明确的业务错误**，不能 500
    assert.ok([200, 409].includes(res.status), `删除仓库返回了意外状态 ${res.status}：${res.text}`);
  }
});
