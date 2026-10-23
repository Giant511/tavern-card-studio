/**
 * T10.21 权限矩阵回归：用户/管理员 × 本人/他人资源 × 删/移/清/恢复/彻底清除。
 *
 * 这一份不是"再测一遍功能"，而是把**权限边界**排成矩阵逐格打。
 * 判据只有两类，每条都必须明确属于哪类：
 *
 *   · **不可见 → 404**（与"不存在"同形，不泄露存在性）
 *   · **可见但无权 → 403 + 明确错误码**（`ADMIN_ONLY` 或 `FORBIDDEN`）
 *
 * 最容易写错的是"该 404 的地方给了 403"—— 那等于告诉对方"这个 id 真的存在"。
 * 所以矩阵里每一格都断言**具体状态码**，不接受"反正不是 200"。
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
let legacyToken = '';

/** 角色：admin（管理员）/ user（普通）/ other（另一个普通账户） */
const people = {};

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

const card = (name) => JSON.stringify({ spec: 'chara_card_v2', data: { name, description: 'd', first_mes: 'hi', mes_example: '' } });

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-matrix-'));
  configPath = join(workDir, 'config.json');
  port = 27800 + Math.floor(Math.random() * 150);

  const config = createDefaultConfig({
    token: 'M'.repeat(43),
    port,
    controlPort: port + 1,
    host: '127.0.0.1',
    controlHost: '127.0.0.1',
    dataDir: join(workDir, 'store'),
  });
  config.auth.registerMode = 'open';
  legacyToken = config.auth.token;
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

  for (const [key, username] of [['admin', 'root'], ['user', 'alice'], ['other', 'bob']]) {
    const password = `${username}-password-1`;
    const reg = await request('/api/auth/register', { method: 'POST', body: { username, password } });
    assert.equal(reg.status, 201, reg.text);
    const login = await request('/api/auth/login', { method: 'POST', body: { username, password } });
    assert.equal(login.status, 200, login.text);
    const repos = await request('/api/repos', { token: login.json.accessToken });
    people[key] = {
      token: login.json.accessToken,
      id: reg.json.user.id,
      role: reg.json.user.role,
      repoId: repos.json.items.find((item) => item.isDefault).id,
    };
  }
  assert.equal(people.admin.role, 'admin');
  assert.equal(people.user.role, 'user');
  assert.equal(people.other.role, 'user');
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await delay(600);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/** 每个用例造一张"干净"的卡，避免用例之间互相污染 */
async function freshCard(ownerKey, cardId, { versions = 2 } = {}) {
  for (let index = 1; index <= versions; index += 1) {
    const res = await request(`/api/cards?cardId=${cardId}`, {
      method: 'POST',
      body: card(`${ownerKey} 的卡 v${String(index)}`),
      raw: true,
      token: people[ownerKey].token,
    });
    assert.ok([200, 201].includes(res.status), `造卡失败：${res.text}`);
  }
  return cardId;
}

// ══════════════════════════════════════════════════════════
// 矩阵定义
// ══════════════════════════════════════════════════════════

/**
 * 每一行 = 一个动作 × 一个调用者 × 一个目标归属，给出期望状态与错误码。
 *
 * 期望值全部手写、逐条评审 —— 不用"如果是管理员就允许"这类推导。
 * 推导会让矩阵失去意义：它只是把实现再写一遍，两边一起错就都发现不了。
 */
const MATRIX = [
  // ── 删除（软删）──────────────────────────────
  { action: '删除', expect: 200, who: 'user', target: 'user', run: (who, target, id) => request(`/api/cards/${id}`, { method: 'DELETE', token: people[who].token }) },
  { action: '删除', expect: 404, who: 'user', target: 'other', run: (who, target, id) => request(`/api/cards/${id}`, { method: 'DELETE', token: people[who].token }) },
  { action: '删除', expect: 200, who: 'admin', target: 'user', run: (who, target, id) => request(`/api/cards/${id}`, { method: 'DELETE', token: people[who].token }) },

  // ── 恢复 ────────────────────────────────────
  { action: '恢复', expect: 200, who: 'user', target: 'user', pre: 'delete', run: (who, target, id) => request(`/api/cards/${id}/restore`, { method: 'POST', token: people[who].token }) },
  { action: '恢复', expect: 404, who: 'user', target: 'other', pre: 'delete', run: (who, target, id) => request(`/api/cards/${id}/restore`, { method: 'POST', token: people[who].token }) },
  { action: '恢复', expect: 409, who: 'user', target: 'user', pre: 'none', run: (who, target, id) => request(`/api/cards/${id}/restore`, { method: 'POST', token: people[who].token }) },

  // ── 移动（同账户内）───────────────────────────
  { action: '移动', expect: 200, who: 'user', target: 'user', run: (who, target, id) => request(`/api/cards/${id}/move`, { method: 'POST', body: { repo: people[who].repoId }, token: people[who].token }) },
  { action: '移动', expect: 404, who: 'user', target: 'other', run: (who, target, id) => request(`/api/cards/${id}/move`, { method: 'POST', body: { repo: people[who].repoId }, token: people[who].token }) },

  // ── 清除版本内容（prune）──────────────────────
  { action: '清除内容', expect: 200, who: 'user', target: 'user', run: (who, target, id) => request(`/api/cards/${id}/versions/1/prune`, { method: 'POST', token: people[who].token }) },
  { action: '清除内容', expect: 404, who: 'user', target: 'other', run: (who, target, id) => request(`/api/cards/${id}/versions/1/prune`, { method: 'POST', token: people[who].token }) },
  { action: '清除内容', expect: 200, who: 'admin', target: 'user', run: (who, target, id) => request(`/api/cards/${id}/versions/1/prune`, { method: 'POST', token: people[who].token }) },

  // ── 彻底清除（purge）──────────────────────────
  { action: '彻底清除', expect: 403, who: 'user', target: 'user', code: 'ADMIN_ONLY', run: (who, target, id) => request(`/api/cards/${id}/purge`, { method: 'POST', token: people[who].token }) },
  /*
   * 普通账户 purge 别人的卡 → **403 而不是 404**。
   *
   * `requireAdmin` 在查卡之前跑，所以对普通账户来说这个端点的答复恒定是
   * "你没这个能力"，与目标是否存在/归属完全无关（下一条用例会逐字节验证）。
   * 这与 T10.10 那条"只读令牌写任何目标都是同一个 403"是同一个模式：
   * **权限前置的 403 不构成枚举面**，因为它不随目标变化。
   * 反过来说，如果有人把它改成"先查卡再判权"，就会得到 404/403 可区分的信号 ——
   * 那才是真的泄露，也正是这条断言要钉住的东西。
   */
  { action: '彻底清除', expect: 403, who: 'user', target: 'other', code: 'ADMIN_ONLY', run: (who, target, id) => request(`/api/cards/${id}/purge`, { method: 'POST', token: people[who].token }) },
  { action: '彻底清除', expect: 200, who: 'admin', target: 'user', pre: 'delete', run: (who, target, id) => request(`/api/cards/${id}/purge`, { method: 'POST', token: people[who].token }) },

  // ── 兼容写法 ?hard=true 也必须只给管理员 ─────────
  { action: '硬删(?hard)', expect: 403, who: 'user', target: 'user', code: 'ADMIN_ONLY', run: (who, target, id) => request(`/api/cards/${id}?hard=true`, { method: 'DELETE', token: people[who].token }) },
  { action: '硬删(?hard)', expect: 403, who: 'user', target: 'other', code: 'ADMIN_ONLY', run: (who, target, id) => request(`/api/cards/${id}?hard=true`, { method: 'DELETE', token: people[who].token }) },
];

test('权限矩阵：逐格断言状态码', async () => {
  const rows = [];
  let index = 0;

  for (const cell of MATRIX) {
    index += 1;
    const targetOwner = cell.target;
    const cardId = `mx-${String(index)}-${cell.action}-${cell.who}-${cell.target}`.replace(/[^a-zA-Z0-9-]/g, '');
    await freshCard(targetOwner, cardId);

    if (cell.pre === 'delete') {
      const del = await request(`/api/cards/${cardId}`, { method: 'DELETE', token: people[targetOwner].token });
      assert.ok([200].includes(del.status), `预置删除失败：${del.text}`);
    }

    const res = await cell.run(cell.who, cell.target, cardId);
    const label = `${cell.who}(${people[cell.who].role}) 对 ${cell.target} 的卡 → ${cell.action}`;
    assert.equal(res.status, cell.expect, `${label}：期望 ${cell.expect}，实际 ${res.status}（${res.text.slice(0, 120)}）`);
    if (cell.code !== undefined) {
      assert.equal(res.json?.error?.code, cell.code, `${label}：错误码应为 ${cell.code}`);
    }
    rows.push(`  ${label.padEnd(46)} → ${res.status}${cell.code ? ` ${cell.code}` : ''}`);
  }

  console.log(`\n权限矩阵 ${rows.length} 格：\n${rows.join('\n')}\n`);
});

test('矩阵补充：purge 的 403 与目标无关（不构成枚举面）', async () => {
  /*
   * 同一把普通账户令牌，对三种目标执行 purge，响应必须**逐字节相同**：
   *   · 自己的卡（存在且属于我）
   *   · 别人的卡（存在但不属于我）
   *   · 根本不存在的 id
   *
   * 只有三者完全一致，才能说"403 没有泄露任何关于目标的信息"。
   * 判据是逐字节，不是"都是 403" —— body 里若有 effectiveTarget 之类的字段，
   * 状态码一样也没用。
   */
  const own = 'mx-403-own';
  const others = 'mx-403-other';
  await freshCard('user', own);
  await freshCard('other', others);

  const responses = [];
  for (const id of [own, others, 'mx-403-nonexistent']) {
    const res = await request(`/api/cards/${id}/purge`, { method: 'POST', token: people.user.token });
    responses.push({ id, status: res.status, body: res.text });
  }

  assert.deepEqual(
    responses.map((item) => item.status),
    [403, 403, 403],
    `三种目标都应 403，实际 ${JSON.stringify(responses.map((item) => item.status))}`,
  );
  const normalize = (body) => body.replace(/mx-403-(own|other|nonexistent)/g, '<id>');
  assert.equal(
    normalize(responses[0].body),
    normalize(responses[1].body),
    '自己与他人的卡：响应体必须相同（否则可用 body 区分归属）',
  );
  assert.equal(
    normalize(responses[0].body),
    normalize(responses[2].body),
    '存在的与不存在的：响应体必须相同（否则构成存在性探测）',
  );
});

test('矩阵补充：普通账户拿别人的 cardId 一律 404（读路径同样不泄露）', async () => {
  const cardId = 'mx-read-other';
  await freshCard('other', cardId);

  const reads = [
    ['详情', `/api/cards/${cardId}`],
    ['原文', `/api/cards/${cardId}/raw`],
    ['版本列表', `/api/cards/${cardId}/versions`],
    ['单个版本', `/api/cards/${cardId}/versions/1`],
    ['diff', `/api/cards/${cardId}/diff?from=1&to=2`],
    ['审计', `/api/cards/${cardId}/audit`],
  ];
  for (const [label, path] of reads) {
    const res = await request(path, { token: people.user.token });
    assert.equal(res.status, 404, `${label} 应 404（不泄露存在性），实际 ${res.status}`);
  }

  // 与"真的不存在"逐字节同形
  const ghost = await request('/api/cards/definitely-not-a-card', { token: people.user.token });
  const real = await request(`/api/cards/${cardId}`, { token: people.user.token });
  assert.equal(ghost.text.replace(/definitely-not-a-card/g, 'X'), real.text.replace(new RegExp(cardId, 'g'), 'X'));
});

test('矩阵补充：legacy 全局令牌的删除能力被降权限制在"未归属卡片"', async () => {
  // 归属了账户的卡，legacy 看不见 → 删除必须 404
  const owned = 'mx-legacy-owned';
  await freshCard('user', owned);
  const denied = await request(`/api/cards/${owned}`, { method: 'DELETE', token: legacyToken });
  assert.equal(denied.status, 404, 'legacy 看不到已归属的卡');

  // legacy 仍然能看到"未归属"的卡（v0.1.1 遗留数据）——用 CLI 之外的方式造不出来，
  // 这里退一步只断言"它的范围没有被这条新能力放大"：管理员的跨账户不适用于它
  const crossMove = await request(`/api/cards/${owned}/move`, {
    method: 'POST',
    body: { repo: people.admin.repoId },
    token: legacyToken,
  });
  assert.equal(crossMove.status, 404, 'legacy 不能借 move 扩大可见范围');
});

test('矩阵补充：仓库删除的权限边界', async () => {
  // 普通账户删别人的仓库 → 404
  const otherRepos = await request('/api/repos', { token: people.other.token });
  const victim = otherRepos.json.items.find((item) => !item.isDefault);
  if (victim) {
    const denied = await request(`/api/repos/${victim.id}`, { method: 'DELETE', token: people.user.token });
    assert.equal(denied.status, 404, '归属不匹配一律 404');
  }

  // 管理员删别人的默认仓库 → 409（默认仓库不能删，跨账户也一样）
  const target = otherRepos.json.items.find((item) => item.isDefault);
  const asAdmin = await request(`/api/repos/${target.id}`, { method: 'DELETE', token: people.admin.token });
  assert.equal(asAdmin.status, 409, '默认仓库对管理员也不能删');

  // 管理员删别人的普通仓库 → 200，并留审计
  const created = await request('/api/repos', { method: 'POST', body: { name: 'victim' }, token: people.other.token });
  const repoId = created.json.id ?? created.json.repo?.id;
  const ok = await request(`/api/repos/${repoId}`, {
    method: 'DELETE',
    body: { transferTo: target.id, reason: '矩阵回归' },
    token: people.admin.token,
  });
  assert.equal(ok.status, 200, ok.text);

  const events = await request('/api/events?limit=50&all=true', { token: people.admin.token });
  assert.ok(
    events.json.items.some((item) => item.action === 'repo.delete.cross-account'),
    '跨账户删除必须留审计',
  );
});

test('矩阵补充：?all=true 只对管理员 jwt 开放', async () => {
  for (const [label, token, expect] of [
    ['普通账户', people.user.token, 403],
    ['legacy', legacyToken, 403],
    ['管理员', people.admin.token, 200],
  ]) {
    const res = await request('/api/cards?all=true', { token });
    assert.equal(res.status, expect, `${label} 的 ?all=true 应为 ${expect}，实际 ${res.status}`);
  }
  // 事件流同理
  assert.equal((await request('/api/events?all=true', { token: people.user.token })).status, 403);
  // 仓库全站列表同理
  assert.equal((await request('/api/repos?all=true', { token: people.user.token })).status, 403);
  assert.equal((await request('/api/repos?all=true', { token: legacyToken })).status, 403);
});

test('矩阵补充：审计记录的 actor 是真实操作者，不是"某个管理员"', async () => {
  const cardId = 'mx-audit-1';
  await freshCard('user', cardId);
  await request(`/api/cards/${cardId}`, { method: 'DELETE', token: people.user.token });
  // 管理员来 purge
  await request(`/api/cards/${cardId}/purge`, { method: 'POST', token: people.admin.token });

  const events = await request('/api/events?limit=100&all=true', { token: people.admin.token });
  const del = events.json.items.find((item) => item.cardId === cardId && item.action === 'card.delete');
  const purge = events.json.items.find((item) => item.cardId === cardId && item.action === 'card.purge');
  assert.equal(del?.actor, 'alice', '删除的 actor 应是卡片主人');
  assert.equal(purge?.actor, 'root', '彻底清除的 actor 应是管理员');
  assert.ok(del?.ip && purge?.ip, '两条都要有来源 IP');
});
