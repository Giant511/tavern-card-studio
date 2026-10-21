/**
 * 阶段 5 测试：服务端 CRUD（T5.1）/ 版本控制（T5.2）/ 审计（T5.3）/ 服务控制与鉴权（T5.4、T5.6）。
 *
 * 重点验证两条硬约束：
 *   · 上传字节原样入库（sha256 一致、blob 与 Git 提交里的 card.json 都逐字节相等、无 JSON 重排）；
 *   · 审计报告随版本快照存储，历史版本回看的是当时的结论（refresh 只读重算，不改快照）。
 *
 * 运行：node --test test/server.test.mjs（需先 npm run build:server）
 */

import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = join(import.meta.dirname, '..');
const NODE = process.execPath;
const ENTRY = join(ROOT, 'server', 'dist', 'index.js');

const PORT = 19100 + Math.floor(Math.random() * 300);
const CONTROL_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const PANEL = `http://127.0.0.1:${CONTROL_PORT}`;

let workDir = '';
let child = null;
let token = '';
const capturedLogs = [];

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function request(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.token !== null) headers.Authorization = `Bearer ${options.token ?? token}`;
  let response;
  try {
    response = await fetch(`${options.base ?? BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body,
    });
  } catch (error) {
    process.stderr.write(`[request failed] ${options.method ?? 'GET'} ${options.base ?? BASE}${path}\n${capturedLogs.join('')}\n`);
    throw error;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  let json = null;
  if ((response.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      json = JSON.parse(buffer.toString('utf8'));
    } catch {
      json = null;
    }
  }
  return { status: response.status, headers: response.headers, buffer, json };
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

function readConfig() {
  return JSON.parse(readFileSync(join(workDir, 'config.json'), 'utf8'));
}

/** 以子进程方式跑一次 CLI，用于验证部署期行为（cwd、配置文件创建等） */
function runCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(NODE, [ENTRY, ...args], {
      cwd: options.cwd ?? ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const SAMPLE = readFileSync(join(ROOT, 'test', 'fixtures', 'sample-card.json'));

/** 刻意用「非标准键序 + 4 空格缩进 + CRLF」，验证服务端不会重排/美化 */
function awkwardCard(name) {
  const raw = JSON.parse(SAMPLE.toString('utf8'));
  const body = {
    extensions: raw.data?.extensions ?? {},
    tags: raw.data?.tags ?? [],
    first_mes: raw.data?.first_mes ?? '你好。',
    description: raw.data?.description ?? '',
    name,
    personality: raw.data?.personality ?? '',
    scenario: raw.data?.scenario ?? '',
    mes_example: raw.data?.mes_example ?? '',
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      creator_notes: '',
      name,
      description: raw.data?.description ?? '',
      personality: raw.data?.personality ?? '',
      tags: raw.data?.tags ?? [],
      spec: 'chara_card_v2',
      spec_version: '2.0',
    },
  };
  return Buffer.from(JSON.stringify(body, null, 4).replace(/\n/g, '\r\n'), 'utf8');
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-server-test-'));
  rmSync(join(workDir, 'store'), { recursive: true, force: true });

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
  child.stdout.on('data', (chunk) => capturedLogs.push(chunk));
  child.stderr.on('data', (chunk) => capturedLogs.push(chunk));

  const ready = await waitFor(() => {
    if (!existsSync(join(workDir, 'config.json'))) return false;
    const config = readConfig();
    token = config.auth.token;
    return true;
  });
  if (!ready) throw new Error(`服务端未在期限内创建配置：\n${capturedLogs.join('')}`);

  const healthy = await waitFor(async () => {
    const result = await request('/api/health', { token: null });
    return result.status === 200;
  });
  if (!healthy) throw new Error(`服务端未在期限内就绪：\n${capturedLogs.join('')}`);
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(4000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  rmSync(workDir, { recursive: true, force: true });
});

test('T5.6 鉴权：健康检查公开，其余接口必须带 Bearer token', async () => {
  const health = await request('/api/health', { token: null });
  assert.equal(health.status, 200);
  assert.equal(health.json.status, 'ok');

  const denied = await request('/api/cards', { token: null });
  assert.equal(denied.status, 401);
  assert.equal(denied.json.error.code, 'UNAUTHORIZED');
  assert.match(String(denied.headers.get('www-authenticate')), /Bearer/);

  const wrong = await request('/api/cards', { token: 'not-the-token' });
  assert.equal(wrong.status, 401);

  const ok = await request('/api/auth/verify');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
});

test('T5.1 上传：原始字节原样入库，读取逐字节相等（键序/缩进/CRLF 不被改写）', async () => {
  const bytes = awkwardCard('字节保真测试');
  const created = await request('/api/cards?message=首次上传&filename=awkward.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bytes,
  });
  assert.equal(created.status, 201);
  const id = created.json.card.id;
  assert.match(id, /^[a-z0-9-]+-[0-9a-f]{6}$/);
  assert.equal(created.json.version.seq, 1);
  assert.equal(created.json.version.sha256, sha256(bytes));
  assert.equal(created.json.card.sourceFilename, 'awkward.json');

  const raw = await request(`/api/cards/${id}/raw`);
  assert.equal(raw.status, 200);
  assert.equal(raw.buffer.equals(bytes), true, '下载字节必须与上传字节完全相同');
  assert.equal(raw.headers.get('x-tcs-sha256'), sha256(bytes));
  assert.equal(sha256(raw.buffer), sha256(bytes));

  // blob 落盘内容与上传字节一致
  const blobPath = join(workDir, 'store', 'blobs', sha256(bytes).slice(0, 2), sha256(bytes));
  assert.equal(existsSync(blobPath), true);
  assert.equal(readFileSync(blobPath).equals(bytes), true);

  // Git 裸仓库可被原生 git 识别：HEAD / objects / refs 齐全
  const repo = join(workDir, 'store', 'repos', `${id}.git`);
  assert.equal(existsSync(join(repo, 'HEAD')), true);
  assert.equal(existsSync(join(repo, 'objects')), true);
  assert.equal(existsSync(join(repo, 'refs', 'heads', 'main')), true);
  assert.equal(existsSync(join(repo, '.git')), false, '裸仓库不应再套一层 .git');

  return id;
});

let cardId = '';
let exactBytes = null;
let v1Sha = '';

test('T5.1 列表与详情：名称/规范/版本计数/审计摘要', async () => {
  const bytes = awkwardCard('列表检索目标');
  const created = await request('/api/cards?message=列表用', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bytes,
  });
  assert.equal(created.status, 201);
  cardId = created.json.card.id;
  exactBytes = bytes;
  v1Sha = created.json.version.sha256;

  const list = await request('/api/cards');
  assert.equal(list.status, 200);
  assert.ok(list.json.total >= 2);
  const found = list.json.items.find((item) => item.id === cardId);
  assert.ok(found);
  assert.equal(found.name, '列表检索目标');
  assert.equal(found.versionCount, 1);
  assert.ok(found.audit, '每个版本都应带有审计摘要');
  assert.equal(typeof found.audit.error, 'number');

  const search = await request('/api/cards?q=列表检索');
  assert.equal(search.json.total, 1);
  assert.equal(search.json.items[0].id, cardId);

  const detail = await request(`/api/cards/${cardId}`);
  assert.equal(detail.status, 200);
  // spec 是统一模型里的规范代号（v1/v2/v3），不是原始 spec 字符串
  assert.equal(detail.json.spec, 'v2');
  assert.ok(Array.isArray(detail.json.parseWarnings));
  assert.equal(detail.json.latest.seq, 1);
});

test('T5.2 新版本：提交历史递增，diff 三层各自成立', async () => {
  // 只改 data.name（最后一次出现），顶层 V1 兼容副本保持原样：diff 应精确落在 data.name 上
  const text = exactBytes.toString('utf8');
  const marker = '"name": "列表检索目标"';
  const at = text.lastIndexOf(marker);
  assert.ok(at > 0);
  const changed = Buffer.from(
    `${text.slice(0, at)}"name": "列表检索目标（改）"${text.slice(at + marker.length)}`,
    'utf8',
  );
  const created = await request(`/api/cards/${cardId}/versions?message=改名&author=测试`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: changed,
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.seq, 2);
  assert.equal(created.json.parentCommit, (await request(`/api/cards/${cardId}/versions/1`)).json.commit);

  const history = await request(`/api/cards/${cardId}/versions`);
  assert.equal(history.json.total, 2);
  assert.deepEqual(
    history.json.items.map((item) => item.seq),
    [2, 1],
  );
  assert.equal(history.json.items[0].message, '改名');
  assert.equal(history.json.items[0].author, '测试');

  const diff = await request(`/api/cards/${cardId}/diff?from=1&to=2`);
  assert.equal(diff.status, 200);
  assert.equal(diff.json.identical, false);
  assert.equal(diff.json.bytes.fromSha256, v1Sha);
  assert.equal(diff.json.bytes.toSha256, sha256(changed));
  assert.equal(diff.json.bytes.sizeDelta, changed.length - exactBytes.length);
  assert.equal(typeof diff.json.bytes.firstDiffOffset, 'number');
  assert.deepEqual(
    diff.json.json.changes.map((change) => change.path),
    ['data.name'],
    '只改 data.name 时，diff 应精确落在 data.name 上（顶层兼容副本未动）',
  );
  assert.ok(diff.json.lines.hunks.length >= 1);
  assert.match(diff.json.lines.hunks[0].header, /^@@ -\d+,\d+ \+\d+,\d+ @@$/);
  assert.equal(diff.json.lines.added, 1);
  assert.equal(diff.json.lines.removed, 1);

  // 按提交短 sha 取版本
  const shortSha = created.json.commit.slice(0, 8);
  const bySha = await request(`/api/cards/${cardId}/versions/${shortSha}`);
  assert.equal(bySha.status, 200);
  assert.equal(bySha.json.seq, 2);

  // include 过滤：只要 bytes 层时不返回 hunks
  const bytesOnly = await request(`/api/cards/${cardId}/diff?from=1&to=2&include=bytes`);
  assert.equal(bytesOnly.json.lines.hunks.length, 0);
  assert.equal(bytesOnly.json.json.changes.length, 0);
  assert.equal(bytesOnly.json.bytes.identical, false);
});

test('T5.2 同字节重复提交：新提交但 diff 逐字节相同（版本不产生噪声）', async () => {
  const again = await request(`/api/cards/${cardId}/versions?message=空提交`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(exactBytes.toString('utf8'), 'utf8'),
  });
  assert.equal(again.status, 201);
  assert.equal(again.json.seq, 3);

  const diff = await request(`/api/cards/${cardId}/diff?from=2&to=3`);
  assert.equal(diff.json.identical, false, '第 2 版改过名字，与第 1 版不同');
  const same = await request(`/api/cards/${cardId}/diff?from=1&to=3`);
  assert.equal(same.json.identical, true, '与 v1 同字节时必须判定为 identical');
  assert.equal(same.json.bytes.firstDiffOffset, null);
  assert.equal(same.json.lines.hunks.length, 0);
});

test('T5.2 回滚：以目标版本字节新建提交，历史只增不改', async () => {
  const before = await request(`/api/cards/${cardId}/versions`);
  const rollback = await request(`/api/cards/${cardId}/rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: 1, message: '回滚到初版' }),
  });
  assert.equal(rollback.status, 201);
  assert.equal(rollback.json.version.seq, before.json.total + 1);
  assert.equal(rollback.json.version.sha256, v1Sha);
  assert.equal(rollback.json.version.kind, 'rollback');
  assert.equal(rollback.json.version.meta.rollbackOf, 1);
  assert.equal(rollback.json.restoredFrom.seq, 1);

  const after = await request(`/api/cards/${cardId}/versions`);
  assert.equal(after.json.total, before.json.total + 1, '回滚不能删除历史');

  const raw = await request(`/api/cards/${cardId}/raw?version=${rollback.json.version.seq}`);
  assert.equal(raw.buffer.equals(exactBytes), true);

  const diff = await request(`/api/cards/${cardId}/diff?from=1&to=${rollback.json.version.seq}`);
  assert.equal(diff.json.identical, true);
  assert.equal(diff.json.bytes.fromSha256, diff.json.bytes.toSha256);
});

test('T5.3 审计快照：随版本存储，历史回看当时的结论；refresh 不覆盖快照', async () => {
  const snapshot = await request(`/api/cards/${cardId}/audit?version=2`);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.headers.get('x-tcs-audit-source'), 'snapshot');
  assert.equal(snapshot.headers.get('x-tcs-audit-for-version'), '2');
  const report = JSON.parse(snapshot.buffer.toString('utf8'));
  assert.equal(report.schemaVersion, 1);
  assert.ok(Array.isArray(report.issues));
  assert.equal(typeof report.wordCount.total.chars, 'number');
  assert.equal(report.card.name, '列表检索目标（改）');

  // 报告字节被存成 blob，重复读取逐字节一致
  const again = await request(`/api/cards/${cardId}/audit?version=2`);
  assert.equal(again.buffer.equals(snapshot.buffer), true);

  // 旧版本（v1）保留的是当时的报告：名字不同、字数不同
  const v1Report = JSON.parse((await request(`/api/cards/${cardId}/audit?version=1`)).buffer.toString('utf8'));
  assert.equal(v1Report.card.name, '列表检索目标');
  assert.notEqual(v1Report.generatedAt, report.generatedAt);

  // 按现行规则重算：不覆盖快照
  const refreshed = await request(`/api/cards/${cardId}/audit?version=2&refresh=true`);
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.headers.get('x-tcs-audit-source'), 'recomputed');
  assert.equal(refreshed.headers.get('x-tcs-audit-snapshot'), snapshot.headers.get('etag')?.replaceAll('"', ''));

  const stillSnapshot = await request(`/api/cards/${cardId}/audit?version=2`);
  assert.equal(stillSnapshot.buffer.equals(snapshot.buffer), true, 'refresh 不得改写历史快照');
});

test('T5.3 任意字节审计：不入库，返回与卡片无关的报告', async () => {
  const before = (await request('/api/cards')).json.total;
  const result = await request('/api/audit?platform=ccv2&preset=default', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: exactBytes,
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('x-tcs-audit-source'), 'ad-hoc');
  const report = JSON.parse(result.buffer.toString('utf8'));
  assert.equal(report.platformRule.id, 'ccv2');
  assert.equal(report.presetId, 'default');
  assert.ok(report.summary.error + report.summary.warning + report.summary.info > 0);

  const after = (await request('/api/cards')).json.total;
  assert.equal(after, before, '审计接口不能创建卡片');
});

test('T5.1 拒绝非法输入：坏 JSON / 非角色卡 / multipart / 空 body', async () => {
  const badJson = await request('/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from('{ "name": "x", ', 'utf8'),
  });
  assert.equal(badJson.status, 422);
  assert.equal(badJson.json.error.code, 'CARD_PARSE_FAILED');
  assert.equal(typeof badJson.json.error.details.offset, 'number');
  assert.ok(badJson.json.error.details.line >= 1);

  const notCard = await request('/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from('{"hello":"world"}', 'utf8'),
  });
  assert.equal(notCard.status, 422);

  const multipart = await request('/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=----x' },
    body: Buffer.from('----x--', 'utf8'),
  });
  assert.equal(multipart.status, 415);
  assert.equal(multipart.json.error.code, 'UNSUPPORTED_MEDIA_TYPE');

  const empty = await request('/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.alloc(0),
  });
  assert.equal(empty.status, 400);

  const list = await request('/api/cards');
  assert.ok(!list.json.items.some((item) => item.name === 'x'), '非法上传不得出现在列表里');
});

test('T5.1 删除：软删后默认不可见，includeDeleted 可见；hard=true 清理仓库', async () => {
  const bytes = awkwardCard('待删除卡');
  const created = await request('/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bytes,
  });
  const id = created.json.card.id;

  const deleted = await request(`/api/cards/${id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.deleted, true);
  assert.equal(deleted.json.hard, false);

  assert.equal((await request(`/api/cards/${id}`)).status, 404);
  assert.ok(!(await request('/api/cards')).json.items.some((item) => item.id === id));

  const withDeleted = await request('/api/cards?includeDeleted=true');
  const row = withDeleted.json.items.find((item) => item.id === id);
  assert.ok(row);
  assert.ok(row.deletedAt);

  const hard = await request(`/api/cards/${id}?hard=true`, { method: 'DELETE' });
  assert.equal(hard.status, 200);
  assert.equal(hard.json.hard, true);
  assert.equal(existsSync(join(workDir, 'store', 'repos', `${id}.git`)), false);
  assert.equal((await request(`/api/cards/${id}?includeDeleted=true`)).status, 404);
});

test('T5.4 服务控制：停止后面板仍在线、API 返回 503，启动与重启可用', async () => {
  const statusBefore = await request('/control/status', { base: PANEL });
  assert.equal(statusBefore.status, 200);
  assert.equal(statusBefore.json.worker.state, 'running');
  const firstPid = statusBefore.json.worker.pid;

  const stopped = await request('/control/service/stop', { base: PANEL, method: 'POST' });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.worker.state, 'stopped');

  const panelAlive = await fetch(`${PANEL}/`);
  assert.equal(panelAlive.status, 200, 'worker 停止时管理面板必须仍然可访问');
  // 面板上的 /api/* 由控制面反代，worker 停止时应拿到明确的 503（而不是连接被拒）
  const apiDown = await request('/api/cards', { base: PANEL });
  assert.equal(apiDown.status, 503);
  assert.equal(apiDown.json.error.code, 'SERVICE_UNAVAILABLE');

  const started = await request('/control/service/start', { base: PANEL, method: 'POST' });
  assert.equal(started.status, 200);
  assert.equal(started.json.worker.state, 'running');

  const healthy = await waitFor(async () => (await request('/api/health', { token: null })).status === 200);
  assert.equal(healthy, true);

  // 数据在重启后仍在
  const list = await request('/api/cards');
  assert.ok(list.json.total >= 1);

  const restarted = await request('/control/service/restart', { base: PANEL, method: 'POST' });
  assert.equal(restarted.status, 200);
  assert.equal(restarted.json.worker.state, 'running');
  assert.notEqual(restarted.json.worker.pid, firstPid);
});

test('T5.4 配置：写入校验，非法端口冲突被拒绝', async () => {
  const current = (await request('/control/config', { base: PANEL })).json.config;
  const saved = await request('/control/config', {
    base: PANEL,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxUploadBytes: 8 * 1024 * 1024 }),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.config.maxUploadBytes, 8 * 1024 * 1024);
  assert.equal(saved.json.workerRestartRequired, true);
  assert.equal(readConfig().maxUploadBytes, 8 * 1024 * 1024);

  const conflictPort = await request('/control/config', {
    base: PANEL,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ controlPort: current.port }),
  });
  assert.equal(conflictPort.status, 400);
  assert.match(conflictPort.json.error.message, /控制面端口不能与 API 端口相同/);

  // 还原，避免影响后续用例
  await request('/control/config', {
    base: PANEL,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxUploadBytes: current.maxUploadBytes }),
  });
});

test('T5.6 令牌轮换：旧 token 立即失效，新 token 可访问', async () => {
  const rotated = await request('/control/token/rotate', { base: PANEL, method: 'POST' });
  assert.equal(rotated.status, 200);
  const newToken = rotated.json.token;
  assert.equal(typeof newToken, 'string');
  assert.notEqual(newToken, token);
  assert.equal(readConfig().auth.token, newToken);

  // 轮换内部会重启 worker；等它就绪后再验证新旧 token
  const healthy = await waitFor(async () => (await request('/api/health', { token: null })).status === 200);
  assert.equal(healthy, true);

  const oldDenied = await request('/api/cards', { token });
  assert.equal(oldDenied.status, 401);
  const newAllowed = await request('/api/cards', { token: newToken });
  assert.equal(newAllowed.status, 200);

  token = newToken;
});

test('面板资源与未知接口', async () => {
  const panel = await fetch(`${PANEL}/`);
  assert.equal(panel.status, 200);
  assert.match(panel.headers.get('content-type'), /text\/html/);
  const html = await panel.text();
  assert.match(html, /Tavern Card Studio/);
  assert.match(html, /服务控制/);

  const css = await fetch(`${PANEL}/styles.css`);
  assert.equal(css.status, 200);

  const missing = await request('/api/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'NOT_FOUND');
});

/**
 * Windows 服务以 LocalSystem 启动时 cwd 是 C:\Windows\System32。
 * 若新建配置时的默认 dataDir 跟随 cwd，卡片 blob 和 Git 仓库会落到
 * System32 下面，卸载后既找不到也删不干净。这里锁死该回归：
 * dataDir 必须由「配置文件所在目录」推导，与 cwd 无关。
 */
test('T5.4 新建配置：dataDir 由配置文件位置推导，不随 cwd 漂移', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'tcs-cfg-'));
  const configPath = join(sandbox, 'progdata', 'config.json');
  try {
    const result = await runCli(
      ['config', 'show', '--config', configPath, '--rules-dir', join(ROOT, 'rules')],
      { cwd: tmpdir() },
    );
    assert.equal(result.code, 0, result.stderr);
    // 首次创建时令牌明文打印一次，否则服务场景下没人能拿到它
    assert.match(result.stdout, /访问令牌：\S+/);

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(config.dataDir, join(sandbox, 'progdata', 'store'));
    assert.ok(
      !config.dataDir.startsWith(join(tmpdir(), 'server')),
      `dataDir 不应回落到 cwd 相对路径：${config.dataDir}`,
    );
    assert.ok(existsSync(configPath));

    // 再次读取不应覆盖已有配置（created=false 时不再打印令牌）
    const again = await runCli(['config', 'path', '--config', configPath], { cwd: tmpdir() });
    assert.equal(again.code, 0);
    assert.ok(!again.stdout.includes('访问令牌'));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
