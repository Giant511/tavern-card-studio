/**
 * T9.7 按 ID 归档（F11 服务端语义）。
 *
 * 验证四件事，对应需求里的四条硬约束：
 *   1. 遗留卡片（服务端自动发号、`slug-6hex` 形态）**只读兼容**：
 *      能列、能取、能看历史、能回滚；老库升级时 `id_source` 列自动补成 `legacy`。
 *   2. 上传语义：带 cardId → 存在追加 / 不存在新建；响应明确回 cardId 与 seq；
 *      **绝不静默丢弃 cardId 退回发号**（空串、非法、旧服务端都是响亮失败）。
 *   3. 分叉：远端最新 seq ≠ 客户端基线 → 返回 FORK 警告，但**照常写入**。
 *   4. 列表与寻址：列表项含 cardId + 角色名；历史/回滚按 cardId 寻址。
 *
 * 运行：node --test test/card-id-archive.test.mjs（需先 npm run build:server）
 */

import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = join(import.meta.dirname, '..');
const NODE = process.execPath;
const ENTRY = join(ROOT, 'server', 'dist', 'index.js');

const PORT = 19500 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;

const SAMPLE = readFileSync(join(ROOT, 'test', 'fixtures', 'sample-card.json'));

let workDir = '';
let child = null;
let token = '';
const logs = [];

/** 改一下名字，让版本之间有可辨识的差异 */
function cardBytes(name) {
  const raw = JSON.parse(SAMPLE.toString('utf8'));
  raw.data.name = name;
  raw.name = name;
  return Buffer.from(JSON.stringify(raw, null, 2) + '\n', 'utf8');
}

async function request(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.token !== null) headers.Authorization = `Bearer ${options.token ?? token}`;
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body,
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(buffer.toString('utf8'));
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, json, buffer };
}

async function waitFor(check, timeoutMs = 20000, intervalMs = 150) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await check()) return true;
    } catch {
      // 继续等
    }
    await delay(intervalMs);
  }
  return false;
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-cardid-'));
  child = spawn(
    NODE,
    [
      ENTRY,
      'serve',
      '--config',
      join(workDir, 'config.json'),
      '--port',
      String(PORT),
      '--data-dir',
      join(workDir, 'store'),
      '--rules-dir',
      join(ROOT, 'rules'),
      '--log-level',
      'warn',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => logs.push(chunk));
  child.stderr.on('data', (chunk) => logs.push(chunk));

  const configured = await waitFor(() => {
    if (!existsSync(join(workDir, 'config.json'))) return false;
    token = JSON.parse(readFileSync(join(workDir, 'config.json'), 'utf8')).auth.token;
    return true;
  });
  if (!configured) throw new Error(`服务端未创建配置：\n${logs.join('')}`);

  const healthy = await waitFor(async () => (await request('/api/health', { token: null })).status === 200);
  if (!healthy) throw new Error(`服务端未就绪：\n${logs.join('')}`);
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(4000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  rmSync(workDir, { recursive: true, force: true });
});

// ── 1. 带 ID 上传：新建 / 追加 ──────────────────────────────

test('按 ID 上传：首个版本新建，响应明确回 cardId 与 seq', async () => {
  const res = await request('/api/cards?cardId=lin-0001&message=v1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: cardBytes('林晚照'),
  });

  assert.equal(res.status, 201);
  assert.equal(res.json.cardId, 'lin-0001', '顶层必须直接给 cardId');
  assert.equal(res.json.seq, 1, '顶层必须直接给 seq');
  assert.equal(res.json.created, true);
  assert.deepEqual(res.json.warnings, []);
  assert.equal(res.headers.get('x-tcs-card-id'), 'lin-0001');
  assert.equal(res.headers.get('x-tcs-card-seq'), '1');
  // 建卡时用的是用户给的 ID，不是服务端发的号
  assert.equal(res.json.card.cardId, 'lin-0001');
  assert.equal(res.json.card.idSource, 'client');
});

test('按 ID 上传：同 ID 第二次 → 追加版本，不新建第二张卡', async () => {
  const res = await request('/api/cards?cardId=lin-0001&message=v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: cardBytes('林晚照 二版'),
  });

  assert.equal(res.status, 200, '追加返回 200（新建才是 201）');
  assert.equal(res.json.created, false);
  assert.equal(res.json.cardId, 'lin-0001');
  assert.equal(res.json.seq, 2);

  const list = await request('/api/cards?q=lin-0001');
  assert.equal(list.json.items.filter((item) => item.cardId === 'lin-0001').length, 1, '不能出现两张同 ID 的卡');
});

test('按 ID 上传：卡名以最新版本 meta.name 为准（列表里要能直接显示）', async () => {
  const list = await request('/api/cards?q=lin-0001');
  const item = list.json.items.find((entry) => entry.cardId === 'lin-0001');
  assert.ok(item, '列表里应有 lin-0001');
  assert.equal(item.name, '林晚照 二版');
  assert.equal(item.latestSeq, 2, '顶层 latestSeq 必须有值（旧客户端曾因字段名不符恒读 0）');
  assert.equal(item.versionCount, 2);
  assert.equal(item.idSource, 'client');
});

// ── 2. 不得静默丢弃 cardId ─────────────────────────────────

test('空 cardId：明确 400，不退回服务端发号', async () => {
  const before = (await request('/api/cards')).json.total;
  const res = await request('/api/cards?cardId=', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: cardBytes('空 ID 测试'),
  });

  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'BAD_CARD_ID');
  const after = (await request('/api/cards')).json.total;
  assert.equal(after, before, '失败的上传不能在服务端留下卡');
});

test('非法 ID：逐类拒绝，并且不产生任何卡片', async () => {
  const before = (await request('/api/cards')).json.total;
  const bad = ['has space', 'a/b', 'a\\b', '-leading', 'trailing-', '中文ID', 'x'.repeat(65)];

  for (const id of bad) {
    const res = await request(`/api/cards?cardId=${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: cardBytes('非法 ID'),
    });
    assert.equal(res.status, 400, `应拒绝：${id}`);
    assert.equal(res.json.error.code, 'BAD_CARD_ID');
  }

  const after = (await request('/api/cards')).json.total;
  assert.equal(after, before, '非法 ID 一张都不能进库');
});

test('cardId 在两处给出且不一致：400（不去猜用户本意）', async () => {
  const res = await request('/api/cards?cardId=aaa-1111', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-TCS-Card-Id': 'bbb-2222' },
    body: cardBytes('冲突 ID'),
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'BAD_CARD_ID');
});

test('不带 cardId：服务端发号并标记 idSource=auto（旧版客户端兼容路径）', async () => {
  const res = await request('/api/cards?message=auto', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: cardBytes('自动发号'),
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.card.idSource, 'auto');
  // 遗留格式：`<slug>-<6 位 hex>`
  assert.match(res.json.cardId, /^[a-z0-9-]+-[0-9a-f]{6}$/, `自动发号 ID 形态变了：${res.json.cardId}`);
});

// ── 3. 分叉警告 ────────────────────────────────────────────

test('分叉：基线落后于远端 → FORK 警告，但版本照常写入', async () => {
  const res = await request('/api/cards?cardId=lin-0001&baseSeq=1&message=v3-from-old-base', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: cardBytes('林晚照 分叉分支'),
  });

  assert.equal(res.status, 200, '分叉不是失败');
  assert.equal(res.json.seq, 3, '内容必须写进去');
  assert.equal(res.json.warnings.length, 1);
  const warning = res.json.warnings[0];
  assert.equal(warning.code, 'FORK');
  assert.equal(warning.baseSeq, 1);
  assert.equal(warning.remoteLatestSeq, 2);
  assert.match(warning.message, /分叉/);

  const versions = await request('/api/cards/lin-0001/versions');
  assert.equal(versions.json.total, 3, '三条历史都在（分叉历史只增不删）');
});

test('基线一致：不报分叉（不能因为"传了 baseSeq"就一律警告）', async () => {
  const res = await request('/api/cards?cardId=lin-0001&baseSeq=3&message=v4', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: cardBytes('林晚照 四版'),
  });
  assert.equal(res.json.seq, 4);
  assert.deepEqual(res.json.warnings, [], `基线一致不该有警告：${JSON.stringify(res.json.warnings)}`);
});

test('远端没有这张卡但客户端有基线 → REMOTE_MISSING 警告并建 v1', async () => {
  const res = await request('/api/cards?cardId=lost-card-9x9x&baseSeq=7', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: cardBytes('历史丢失的卡'),
  });

  assert.equal(res.status, 201);
  assert.equal(res.json.seq, 1);
  assert.equal(res.json.warnings.length, 1);
  assert.equal(res.json.warnings[0].code, 'REMOTE_MISSING');
  assert.equal(res.json.warnings[0].baseSeq, 7);
  assert.equal(res.json.warnings[0].remoteLatestSeq, null);
});

// ── 4. 列表与按 ID 寻址 ────────────────────────────────────

test('历史按 cardId 寻址：取版本、取原文、diff 全部可用', async () => {
  const history = await request('/api/cards/lin-0001/versions');
  assert.equal(history.json.total, 4);
  assert.deepEqual(
    history.json.items.map((item) => item.seq),
    [4, 3, 2, 1],
    '按 seq 倒序',
  );

  const raw = await request('/api/cards/lin-0001/raw?version=1');
  assert.equal(raw.status, 200);
  assert.match(raw.buffer.toString('utf8'), /林晚照/);

  const diff = await request('/api/cards/lin-0001/diff?from=1&to=2');
  assert.equal(diff.status, 200);
  assert.equal(diff.json.identical, false);
});

test('回滚按 cardId 寻址：以旧版字节新建提交，历史只增不改', async () => {
  const res = await request('/api/cards/lin-0001/rollback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: 1, message: '回滚到 v1' }),
  });

  // 回滚在语义上是"新建一个版本"，所以服务端沿用 201（与建卡/建版本一致）
  assert.equal(res.status, 201);
  assert.equal(res.json.version.seq, 5, '回滚 = 新建一个版本');
  assert.equal(res.json.version.kind, 'rollback');

  // 回滚后的字节必须与 v1 逐字节相同
  const latest = await request('/api/cards/lin-0001/raw');
  const v1 = await request('/api/cards/lin-0001/raw?version=1');
  assert.deepEqual(latest.buffer, v1.buffer, '回滚后内容必须与目标版本逐字节相等');

  const history = await request('/api/cards/lin-0001/versions');
  assert.equal(history.json.total, 5, '历史只增不减');
});

// ── 5. 遗留卡片只读兼容 ────────────────────────────────────

test('遗留格式卡（服务端当年发号）：能列、能取、能看历史、能回滚', async () => {
  const created = await request('/api/cards?message=legacy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: cardBytes('遗留卡片'),
  });
  const legacyId = created.json.cardId;
  assert.match(legacyId, /^[a-z0-9-]+-[0-9a-f]{6}$/);

  const list = await request('/api/cards');
  const item = list.json.items.find((entry) => entry.cardId === legacyId);
  assert.ok(item, '遗留卡必须出现在列表里');
  assert.equal(item.name, '遗留卡片');

  const detail = await request(`/api/cards/${legacyId}`);
  assert.equal(detail.status, 200, '遗留卡必须能按 ID 取详情');

  const history = await request(`/api/cards/${legacyId}/versions`);
  assert.equal(history.status, 200);
  assert.equal(history.json.total, 1);

  // 追加一个版本再回滚，证明它不是"只读死卡"
  const appended = await request(`/api/cards?cardId=${legacyId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: cardBytes('遗留卡片 二版'),
  });
  assert.equal(appended.json.seq, 2, '遗留 ID 也能继续追加版本');

  const rollback = await request(`/api/cards/${legacyId}/rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: 1 }),
  });
  assert.equal(rollback.status, 201, '遗留卡必须能回滚（回滚=新建版本，故 201）');
  assert.equal(rollback.json.version.seq, 3);
});

test('软删过的 ID 不复用：再上传报 409，避免把旧历史连带复活', async () => {
  await request('/api/cards?cardId=deleted-0001', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: cardBytes('将被删除'),
  });
  const removed = await request('/api/cards/deleted-0001', { method: 'DELETE' });
  assert.equal(removed.status, 200);

  const again = await request('/api/cards?cardId=deleted-0001', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: cardBytes('想复用 ID'),
  });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, 'CARD_DELETED');
});

// ── 6. 老库升级：id_source 列自动补齐 ──────────────────────

test('老库迁移：没有 id_source 列的库打开后自动补列，老行标记为 legacy', async () => {
  const Database = (await import('better-sqlite3')).default;
  const { Db } = await import('../server/dist/storage/db.js');

  const dbFile = join(workDir, 'old-schema.db');
  // 手工造一个 v0.1.0 形态的库：**没有** id_source 列
  const legacy = new Database(dbFile);
  legacy.exec(`
    CREATE TABLE cards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      spec TEXT NOT NULL DEFAULT '',
      spec_version TEXT NOT NULL DEFAULT '',
      creator TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      source_filename TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      version_count INTEGER NOT NULL DEFAULT 0,
      latest_seq INTEGER,
      latest_commit TEXT,
      latest_sha256 TEXT,
      latest_size INTEGER,
      latest_message TEXT,
      latest_at TEXT,
      parse_warnings_json TEXT NOT NULL DEFAULT '[]',
      audit_sha256 TEXT,
      audit_error TEXT,
      audit_generated_at TEXT,
      audit_error_count INTEGER,
      audit_warning_count INTEGER,
      audit_info_count INTEGER,
      audit_exportable INTEGER
    );
  `);
  legacy
    .prepare(
      `INSERT INTO cards (id, name, created_at, updated_at, version_count, latest_seq)
       VALUES ('card-abcdef', '遗留老卡', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 1, 1)`,
    )
    .run();
  legacy.close();

  const db = new Db(dbFile);
  try {
    const columns = db.handle.prepare('PRAGMA table_info(cards)').all();
    assert.ok(
      columns.some((column) => column.name === 'id_source'),
      '打开老库时应补出 id_source 列',
    );

    const row = db.getCard('card-abcdef');
    assert.ok(row, '老数据必须还能读出来');
    assert.equal(row.id_source, 'legacy', '迁移前入库的卡应被标记为 legacy');
    assert.equal(row.name, '遗留老卡');
  } finally {
    db.close();
    rmSync(dbFile, { force: true });
    rmSync(`${dbFile}-wal`, { force: true });
    rmSync(`${dbFile}-shm`, { force: true });
  }
});
