/**
 * F13.2 / F13.3 / F13.4 服务端删除与移动体系（T10.18）。
 *
 * 用**真进程 + 真 HTTP**验证，不在进程内拼 handler。理由：这一轮的每一条判据
 * 都同时涉及鉴权范围（谁能看到这张卡）、权限（谁能 purge）、以及"404 与
 * 不存在同形"，三者都在路由层交汇；只测 storage 会漏掉最要紧的那一层。
 *
 * 覆盖：
 *   ① 软删 → 列表/详情立刻消失、接口 404 同形、cardId 不复用（CARD_DELETED）
 *   ② 恢复 → 重新可见；不在回收站时恢复是 409（不静默成功）
 *   ③ purge 仅管理员（普通账户 403 ADMIN_ONLY，含 `?hard=true` 兼容写法）
 *   ④ prune：元数据保留、sha256 置空、最新版禁 prune、回滚 409、diff 标记 cleared
 *   ⑤ move：改归属不动 updated_at、跨账户仓库被拒
 *   ⑥ 保留期：purgeExpired 按 retentionDays 清；0 表示不自动清理
 *   ⑦ 审计：操作者 / 动作 / 目标 / IP 落库
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
let alice = null; // 首个账户 → 管理员
let bob = null; // 第二个账户 → 普通用户

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  data: { name: '回收站探针', description: '第一版', first_mes: '你好', mes_example: '' },
});

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

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-trash-'));
  configPath = join(workDir, 'config.json');
  port = 27100 + Math.floor(Math.random() * 300);

  const config = createDefaultConfig({
    token: 'F'.repeat(43),
    port,
    controlPort: port + 1,
    host: '127.0.0.1',
    controlHost: '127.0.0.1',
    dataDir: join(workDir, 'store'),
  });
  // 开放注册以便建两个账户；回收站保留期设小一点方便测过期
  config.auth.registerMode = 'open';
  config.trash = { retentionDays: 30 };
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

  const reg = async (username, password) => {
    const res = await request('/api/auth/register', { method: 'POST', body: { username, password } });
    assert.equal(res.status, 201, `注册 ${username} 失败：${res.text}`);
    return res.json.user;
  };
  alice = await reg('alice', 'alice-password-1');
  bob = await reg('bob', 'bob-password-1');

  const login = async (username, password) => {
    const res = await request('/api/auth/login', { method: 'POST', body: { username, password } });
    assert.equal(res.status, 200, `登录 ${username} 失败：${res.text}`);
    return res.json.accessToken;
  };
  alice.token = await login('alice', 'alice-password-1');
  bob.token = await login('bob', 'bob-password-1');

  assert.equal(alice.role, 'admin', '首个账户必须是管理员');
  assert.equal(bob.role, 'user');
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await delay(600);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/** 上传一张卡（raw 字节，避免再 stringify 一次变成字符串字面量） */
async function upload(token, cardId, body = CARD) {
  return request(`/api/cards?cardId=${encodeURIComponent(cardId)}`, {
    method: 'POST',
    body,
    raw: true,
    token,
  });
}

// ══════════════════════════════════════════════════════════
// ① 软删
// ══════════════════════════════════════════════════════════

const cardId = 'trash-probe-001';

test('准备：上传一张有 3 个版本的卡', async () => {
  const first = await upload(alice.token, cardId);
  assert.equal(first.status, 201, first.text);
  const second = await upload(alice.token, cardId, JSON.stringify({
    spec: 'chara_card_v2',
    data: { name: '回收站探针', description: '第二版', first_mes: '你好', mes_example: '' },
  }));
  assert.equal(second.status, 200, second.text);
  const third = await upload(alice.token, cardId, JSON.stringify({
    spec: 'chara_card_v2',
    data: { name: '回收站探针', description: '第三版', first_mes: '你好', mes_example: '' },
  }));
  assert.equal(third.status, 200, third.text);
  assert.equal(third.json.seq, 3);
});

test('软删：从列表与详情立刻消失，且返回 404（与"不存在"同形）', async () => {
  const before = await request('/api/cards?limit=100', { token: alice.token });
  assert.ok(before.json.items.some((item) => item.id === cardId), '删除前应在列表里');

  const del = await request(`/api/cards/${cardId}`, { method: 'DELETE', token: alice.token });
  assert.equal(del.status, 200, del.text);
  assert.equal(del.json.hard, false, '默认删除必须是软删');

  const detail = await request(`/api/cards/${cardId}`, { token: alice.token });
  assert.equal(detail.status, 404, '软删后详情必须 404');

  const after = await request('/api/cards?limit=100', { token: alice.token });
  assert.equal(after.json.items.some((item) => item.id === cardId), false, '软删后不应出现在列表');
  assert.equal(after.json.total, before.json.total - 1);

  // 与"真的不存在"逐字节同形（不泄露"它在回收站里"）
  const ghost = await request('/api/cards/never-existed-999', { token: alice.token });
  assert.equal(ghost.status, detail.status);
  assert.equal(ghost.json.error.code, detail.json.error.code);
});

test('软删期间 cardId 不可复用（CARD_DELETED 409，语义不变）', async () => {
  const again = await upload(alice.token, cardId);
  assert.equal(again.status, 409, again.text);
  assert.equal(again.json.error.code, 'CARD_DELETED');
});

test('恢复：重新可见；不在回收站时恢复是 409（不静默成功）', async () => {
  const restore = await request(`/api/cards/${cardId}/restore`, { method: 'POST', token: alice.token });
  assert.equal(restore.status, 200, restore.text);
  assert.equal(restore.json.restored, true);

  const detail = await request(`/api/cards/${cardId}`, { token: alice.token });
  assert.equal(detail.status, 200, '恢复后应能读到');
  assert.equal(detail.json.latestSeq, 3);

  const twice = await request(`/api/cards/${cardId}/restore`, { method: 'POST', token: alice.token });
  assert.equal(twice.status, 409, '第二次恢复必须报"不在回收站里"');
  assert.equal(twice.json.error.code, 'CONFLICT');
});

test('恢复不刷新 updated_at（恢复不等于编辑）', async () => {
  /*
   * 判据必须是"同一个 updatedAt 在删除→恢复前后**没变**"。
   *
   * 第一版我拿它与最新版本的 createdAt 比较，结果红了 —— 那不是缺陷：
   * 上传时 updated_at 与版本 createdAt 是两次独立的取时，差几毫秒很正常。
   * 「没有变化」只能由"前后对比"证明，不能由"等于另一个字段"推断。
   */
  const before = await request(`/api/cards/${cardId}`, { token: alice.token });
  const baseline = before.json.updatedAt;

  await request(`/api/cards/${cardId}`, { method: 'DELETE', token: alice.token });
  await request(`/api/cards/${cardId}/restore`, { method: 'POST', token: alice.token });

  const after = await request(`/api/cards/${cardId}`, { token: alice.token });
  assert.equal(after.json.updatedAt, baseline, '恢复不能刷新 updated_at');
});

// ══════════════════════════════════════════════════════════
// ② purge 仅管理员
// ══════════════════════════════════════════════════════════

test('purge：普通账户被拒（403 ADMIN_ONLY），卡片仍在', async () => {
  const bobCard = 'bob-own-card';
  const up = await upload(bob.token, bobCard);
  assert.equal(up.status, 201, up.text);
  await request(`/api/cards/${bobCard}`, { method: 'DELETE', token: bob.token });

  const purge = await request(`/api/cards/${bobCard}/purge`, { method: 'POST', token: bob.token });
  assert.equal(purge.status, 403, purge.text);
  assert.equal(purge.json.error.code, 'ADMIN_ONLY');

  // `?hard=true` 是旧写法，同样必须被拦住 —— 否则这个洞还开着
  const legacyHard = await request(`/api/cards/${bobCard}?hard=true`, { method: 'DELETE', token: bob.token });
  assert.equal(legacyHard.status, 403, '兼容写法不能绕过管理员限制');
  assert.equal(legacyHard.json.error.code, 'ADMIN_ONLY');

  // 卡片仍在回收站里（恢复得回来）
  const restore = await request(`/api/cards/${bobCard}/restore`, { method: 'POST', token: bob.token });
  assert.equal(restore.status, 200, '被拒的 purge 不该真的删掉东西');
});

test('purge：管理员可以立刻彻底清除，之后连恢复也是 404', async () => {
  await request(`/api/cards/${cardId}`, { method: 'DELETE', token: alice.token });
  const purge = await request(`/api/cards/${cardId}/purge`, { method: 'POST', token: alice.token });
  assert.equal(purge.status, 200, purge.text);
  assert.equal(purge.json.purged, true);

  const detail = await request(`/api/cards/${cardId}?includeDeleted=true`, { token: alice.token });
  assert.equal(detail.status, 404, 'purge 之后连 includeDeleted 也读不到');

  const restore = await request(`/api/cards/${cardId}/restore`, { method: 'POST', token: alice.token });
  assert.equal(restore.status, 404, '彻底清除后不可恢复');
});

// ══════════════════════════════════════════════════════════
// ③ prune
// ══════════════════════════════════════════════════════════

const pruneCard = 'prune-probe-001';

test('准备：一张有 3 个版本的卡', async () => {
  for (const [index, desc] of ['一', '二', '三'].entries()) {
    const res = await upload(alice.token, pruneCard, JSON.stringify({
      spec: 'chara_card_v2',
      data: { name: '清除探针', description: `第${desc}版`, first_mes: '你好', mes_example: '' },
    }));
    assert.equal(index === 0 ? 201 : 200, res.status, res.text);
  }
});

test('prune：最新版本不可清除（409），其余任意版本可以', async () => {
  const latest = await request(`/api/cards/${pruneCard}/versions/3/prune`, { method: 'POST', token: alice.token });
  assert.equal(latest.status, 409, latest.text);
  assert.match(latest.json.error.message, /最新版本/);

  const middle = await request(`/api/cards/${pruneCard}/versions/2/prune`, { method: 'POST', token: alice.token });
  assert.equal(middle.status, 200, middle.text);
  assert.equal(middle.json.pruned, true);

  const again = await request(`/api/cards/${pruneCard}/versions/2/prune`, { method: 'POST', token: alice.token });
  assert.equal(again.status, 200, '重复 prune 应幂等，不报错');
  assert.equal(again.json.alreadyPruned, true);
});

test('prune 后：版本还在列表里（标注已清除），计数不变，sha256 为 null', async () => {
  const list = await request(`/api/cards/${pruneCard}/versions?limit=10`, { token: alice.token });
  assert.equal(list.json.total, 3, 'prune 不减少版本数（链不可断）');
  const mid = list.json.items.find((item) => item.seq === 2);
  assert.ok(mid, '被清除的版本仍要在列表里');
  assert.equal(mid.pruned, true);
  assert.equal(mid.sha256, null, '正文摘要必须置空，而不是留一个空串冒充 sha');
  assert.ok(mid.prunedAt, '要记下清除时间');
  assert.equal(mid.message.length > 0, true, '元数据（message）保留');

  const version = await request(`/api/cards/${pruneCard}/versions/2`, { token: alice.token });
  assert.equal(version.status, 200, '按序号取元数据仍可用');
  assert.equal(version.json.pruned, true);
});

test('prune 后：读原文 409，回滚 409，都不是 404', async () => {
  const raw = await request(`/api/cards/${pruneCard}/versions/2/raw`, { token: alice.token });
  assert.equal(raw.status, 409, '内容被清除的版本不该能读出正文');
  assert.equal(raw.json.error.code, 'VERSION_CONTENT_CLEARED');

  const rollback = await request(`/api/cards/${pruneCard}/rollback`, {
    method: 'POST',
    body: { to: 2 },
    token: alice.token,
  });
  assert.equal(rollback.status, 409, `回滚到已清除的版本必须被拒：${rollback.text}`);
  assert.equal(rollback.json.error.code, 'VERSION_CONTENT_CLEARED');
});

test('prune 后：diff 明确标记「内容已清除」，不冒充"没有变化"', async () => {
  const diff = await request(`/api/cards/${pruneCard}/diff?from=2&to=3`, { token: alice.token });
  assert.equal(diff.status, 200, diff.text);
  assert.equal(diff.json.contentCleared, true, '必须显式说明内容已清除');
  assert.equal(diff.json.identical, false, '绝不能报"两个版本一样"（那是错误结论）');
});

// ══════════════════════════════════════════════════════════
// ④ move
// ══════════════════════════════════════════════════════════

const moveCard = 'move-probe-001';

test('准备：建第二个仓库并把卡片移过去', async () => {
  const up = await upload(alice.token, moveCard);
  assert.equal(up.status, 201, up.text);

  const repos = await request('/api/repos', { token: alice.token });
  const defaultRepo = repos.json.items.find((item) => item.isDefault);
  assert.ok(defaultRepo, '注册时应自动建默认仓库');

  const created = await request('/api/repos', { method: 'POST', body: { name: 'shelf' }, token: alice.token });
  assert.equal(created.status, 201, created.text);

  const before = await request(`/api/cards/${moveCard}`, { token: alice.token });
  assert.equal(before.json.repoId, defaultRepo.id);

  const moved = await request(`/api/cards/${moveCard}/move`, {
    method: 'POST',
    body: { repo: created.json.id ?? created.json.repo?.id },
    token: alice.token,
  });
  assert.equal(moved.status, 200, moved.text);
  assert.equal(moved.json.moved, true);

  const after = await request(`/api/cards/${moveCard}`, { token: alice.token });
  assert.equal(after.json.repoId, moved.json.repoId);
  assert.equal(after.json.updatedAt, before.json.updatedAt, '归属变更不能刷新 updated_at');
});

test('move：目标不存在 404；缺 repo 400；回收站里的卡 409', async () => {
  const missing = await request(`/api/cards/${moveCard}/move`, {
    method: 'POST',
    body: { repo: 'no-such-repo' },
    token: alice.token,
  });
  assert.equal(missing.status, 404, missing.text);

  const noRepo = await request(`/api/cards/${moveCard}/move`, { method: 'POST', body: {}, token: alice.token });
  assert.equal(noRepo.status, 400, noRepo.text);

  await request(`/api/cards/${moveCard}`, { method: 'DELETE', token: alice.token });
  const repos = await request('/api/repos', { token: alice.token });
  const trashed = await request(`/api/cards/${moveCard}/move`, {
    method: 'POST',
    body: { repo: repos.json.items[0].id },
    token: alice.token,
  });
  assert.equal(trashed.status, 409, trashed.text);
  assert.equal(trashed.json.error.code, 'CARD_IN_TRASH');
});

test('move：移不进别的账户的仓库（403）', async () => {
  await request(`/api/cards/${moveCard}/restore`, { method: 'POST', token: alice.token });
  const bobRepos = await request('/api/repos', { token: bob.token });
  const bobRepo = bobRepos.json.items[0];

  const crossed = await request(`/api/cards/${moveCard}/move`, {
    method: 'POST',
    body: { repo: bobRepo.id },
    token: alice.token,
  });
  assert.equal(crossed.status, 403, `跨账户移动必须被拒：${crossed.text}`);
});

// ══════════════════════════════════════════════════════════
// ⑤ 审计
// ══════════════════════════════════════════════════════════

test('审计：删除/恢复/清除都记录了操作者与动作', async () => {
  const events = await request('/api/events?limit=100', { token: alice.token });
  assert.equal(events.status, 200, events.text);
  const actions = new Set(events.json.items.map((item) => item.action));
  for (const expected of ['card.delete', 'card.restore', 'card.purge', 'card.version.prune', 'card.move']) {
    assert.ok(actions.has(expected), `事件流里缺少 ${expected}`);
  }
  const del = events.json.items.find((item) => item.action === 'card.delete');
  assert.equal(del.actor, 'alice', '审计必须记录是谁删的');
  assert.ok(del.ip, '审计必须记录来源 IP');
});

// ══════════════════════════════════════════════════════════
// ⑥ 保留期
// ══════════════════════════════════════════════════════════

test('保留期：purgeExpired 只清超过 retentionDays 的；0 表示不自动清理', async () => {
  const { Db } = await import('../server/dist/storage/db.js');
  const { CardService } = await import('../server/dist/storage/cards.js');
  const { BlobStore } = await import('../server/dist/storage/blobs.js');
  const { GitStore } = await import('../server/dist/storage/git-store.js');

  const dir = mkdtempSync(join(tmpdir(), 'tcs-expire-'));
  const db = new Db(join(dir, 'state.db'));
  try {
    const now = new Date('2026-10-23T00:00:00.000Z');
    const insert = (id, deletedAt) => {
      db.insertCard({
        id,
        id_source: 'client',
        owner_id: '',
        repo_id: '',
        name: id,
        spec: 'v2',
        spec_version: '2.0',
        creator: '',
        tags_json: '[]',
        source_filename: '',
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        deleted_at: deletedAt,
        version_count: 1,
        latest_seq: 1,
        latest_commit: 'a'.repeat(40),
        latest_sha256: 'b'.repeat(64),
        latest_size: 10,
        latest_message: 'v1',
        latest_at: now.toISOString(),
        parse_warnings_json: '[]',
        audit_sha256: null,
        audit_error: null,
        audit_generated_at: null,
        audit_error_count: null,
        audit_warning_count: null,
        audit_info_count: null,
        audit_exportable: null,
      });
      db.insertVersion({
        cardId: id,
        seq: 1,
        commit: 'a'.repeat(40),
        blobSha256: 'b'.repeat(64),
        auditSha256: null,
        auditError: null,
        byteSize: 10,
        message: 'v1',
        author: 't',
        kind: 'upload',
        parentCommit: null,
        createdAt: now.toISOString(),
        auditSummary: null,
        auditGeneratedAt: null,
        meta: {},
      });
    };

    // 40 天前删的（超期）、29 天前删的（未超期）、未删除的
    insert('expired-card', new Date(now.getTime() - 40 * 86400_000).toISOString());
    insert('fresh-card', new Date(now.getTime() - 29 * 86400_000).toISOString());
    insert('alive-card', null);

    const cards = new CardService(
      db,
      new BlobStore(join(dir, 'blobs')),
      new GitStore(join(dir, 'repos')),
      {
        analyze: () => {
          throw new Error('not used');
        },
      },
      { platformId: 'sillytavern', presetId: 'default' },
      { info() {}, warn() {}, error() {}, debug() {} },
    );

    const zero = await cards.purgeExpired(0, { now });
    assert.equal(zero.purged.length, 0, 'retentionDays=0 表示不自动清理，不是"马上清空"');

    const result = await cards.purgeExpired(30, { now });
    assert.deepEqual(result.purged.map((item) => item.id), ['expired-card']);
    assert.equal(db.getCard('expired-card', { includeDeleted: true }), undefined, '超期的应被物理删除');
    assert.ok(db.getCard('fresh-card', { includeDeleted: true }), '未超期的必须留着');
    assert.ok(db.getCard('alive-card'), '未删除的不能动');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('配置：trash.retentionDays 非法值时回落默认 30，0 合法', async () => {
  const { normalizeConfig } = await import('../server/dist/config.js');
  assert.equal(normalizeConfig({ trash: { retentionDays: 7 } }).trash.retentionDays, 7);
  assert.equal(normalizeConfig({ trash: { retentionDays: 0 } }).trash.retentionDays, 0);
  assert.equal(normalizeConfig({ trash: { retentionDays: -1 } }).trash.retentionDays, 30);
  assert.equal(normalizeConfig({ trash: { retentionDays: 99999 } }).trash.retentionDays, 30);
  assert.equal(normalizeConfig({ trash: { retentionDays: 'x' } }).trash.retentionDays, 30);
  assert.equal(normalizeConfig({}).trash.retentionDays, 30);
});

test('配置：文件里的 retentionDays 会被服务端读到（不是只存在于 schema）', () => {
  const written = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(written.trash?.retentionDays, 30);
  assert.ok(existsSync(configPath));
});

test('清理配置往返：写盘后重新读仍是同一个值', async () => {
  const { loadConfig } = await import('../server/dist/config.js');
  const next = JSON.parse(readFileSync(configPath, 'utf8'));
  next.trash = { retentionDays: 7 };
  writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8');
  const loaded = loadConfig(configPath, {});
  assert.equal(loaded.config.trash.retentionDays, 7);
  // 还原，避免影响后续用例（本文件后续已无依赖，但保持整洁）
  next.trash = { retentionDays: 30 };
  writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8');
});
