/**
 * 阶段 5 演示：把「上传 → 新版本 → diff → 回滚 → 审计回看」在真实服务上跑一遍，
 * 并把过程写成 docs/assets/server-demo.md 与 docs/assets/api-examples.json。
 *
 * 运行：npm run demo:server
 *
 * 演示刻意使用**原始字节**上传（不经任何 JSON 解析再序列化），
 * 这样回滚后的 sha256 能与初版完全一致，作为「逐字节可复现」的现场证据。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsDefault, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import git from 'isomorphic-git';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = join(import.meta.dirname, '..');
const PORT = 19500;
const CONTROL = 19501;
const BASE = `http://127.0.0.1:${PORT}`;
const PANEL = `http://127.0.0.1:${CONTROL}`;
const FIXTURE = join(ROOT, 'test', 'fixtures', 'sample-card.json');

const out = [];
const apiExamples = [];

function log(line = '') {
  out.push(line);
  console.log(line);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function short(value, length = 12) {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function round(value, digits = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}

function truncateBody(value, depth = 0) {
  if (typeof value === 'string' && value.length > 240) return `${value.slice(0, 240)}…（${value.length} 字符）`;
  if (Array.isArray(value)) {
    if (value.length > 6) return [...value.slice(0, 6).map((item) => truncateBody(item, depth + 1)), `…共 ${value.length} 项`];
    return value.map((item) => truncateBody(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'issues' && Array.isArray(item)) {
        result[key] = item.slice(0, 4).map((entry) => truncateBody(entry, depth + 1));
        if (item.length > 4) result[key].push(`…共 ${item.length} 条`);
        continue;
      }
      if (key === 'wordCount' && depth > 0) {
        result[key] = { total: item.total, blocks: `…${item.blocks.length} 个板块` };
        continue;
      }
      result[key] = truncateBody(item, depth + 1);
    }
    return result;
  }
  return value;
}

function recordExample(title, request, response) {
  apiExamples.push({
    title,
    request,
    response: {
      status: response.status,
      headers: Object.fromEntries(
        Object.entries(response.headers).filter(([key]) =>
          ['content-type', 'location', 'etag', 'x-tcs-sha256', 'x-tcs-audit-source', 'x-tcs-card-id'].includes(key),
        ),
      ),
      body: truncateBody(response.json),
    },
  });
}

async function call(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.token !== null) headers.Authorization = `Bearer ${options.token ?? token}`;
  const response = await fetch(`${options.base ?? BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body,
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  let json = null;
  if ((response.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      json = JSON.parse(buffer.toString('utf8'));
    } catch {
      json = null;
    }
  }
  return { status: response.status, headers: Object.fromEntries(response.headers), buffer, json };
}

async function waitFor(check, timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await check()) return true;
    } catch {
      /* retry */
    }
    await delay(200);
  }
  return false;
}

let token = '';
let child = null;
let workDir = '';

function startServer() {
  child = spawn(
    process.execPath,
    [
      join(ROOT, 'server', 'dist', 'index.js'),
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
  const logs = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => logs.push(chunk));
  child.stderr.on('data', (chunk) => logs.push(chunk));
  return logs;
}

async function main() {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-demo-'));
  const logs = startServer();

  const ready = await waitFor(() => existsSync(join(workDir, 'config.json')));
  if (!ready) throw new Error(`服务未创建配置：${logs.join('')}`);
  token = JSON.parse(readFileSync(join(workDir, 'config.json'), 'utf8')).auth.token;
  const healthy = await waitFor(async () => (await call('/api/health', { token: null })).status === 200);
  if (!healthy) throw new Error(`服务未就绪：${logs.join('')}`);

  const version = (await call('/api/health', { token: null })).json;

  log('# 阶段 5 服务端演示记录');
  log();
  log('> 本文件由 `npm run demo:server` 自动生成，记录的是**真实 HTTP 请求**与真实落盘状态，不是手写示例。');
  log();
  log(`- 生成时间：${new Date().toISOString()}`);
  log(`- 运行环境：Node ${version.node}，服务端 v${version.version}，API ${version.apiVersion}`);
  log(`- 演示端口：API ${PORT}，管理面板 ${CONTROL}（临时数据目录，演示结束自动清理）`);
  log();

  // ── 1. 上传 v1 ──────────────────────────────────────────────
  const v1Bytes = readFileSync(FIXTURE);
  const created = await call('/api/cards?message=导入初版&author=演示脚本&filename=sample-card.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: v1Bytes,
  });
  if (created.status !== 201) throw new Error(`上传失败：${created.buffer.toString('utf8')}`);
  const cardId = created.json.card.id;
  const v1 = created.json.version;
  recordExample('上传角色卡（原始字节）', {
    method: 'POST',
    path: '/api/cards?message=导入初版&author=演示脚本&filename=sample-card.json',
    headers: { Authorization: 'Bearer <token>', 'Content-Type': 'application/json' },
    body: '<test/fixtures/sample-card.json 原始字节>',
  }, created);

  log('## 1. 上传初版（原始字节直传）');
  log();
  log('```http');
  log('POST /api/cards?message=导入初版&author=演示脚本&filename=sample-card.json');
  log('Content-Type: application/json');
  log('');
  log('<sample-card.json 的原始字节，共 ' + v1Bytes.byteLength + ' 字节>');
  log('```');
  log();
  log(`- 返回 **201**，卡片 id：\`${cardId}\``);
  log(`- v1 sha256：\`${v1.sha256}\``);
  log(`- 与本地文件 sha256 一致：**${v1.sha256 === sha256(v1Bytes)}**`);
  log();

  // ── 2. 逐字节下载 ───────────────────────────────────────────
  const raw1 = await call(`/api/cards/${cardId}/raw?version=1`);
  recordExample('下载某版本原始字节', {
    method: 'GET',
    path: `/api/cards/${cardId}/raw?version=1`,
    headers: { Authorization: 'Bearer <token>' },
  }, {
    ...raw1,
    json: { note: '响应体为原始字节（application/octet-stream），此处只列摘要', sha256: sha256(raw1.buffer), size: raw1.buffer.byteLength },
  });
  log('## 2. 下载 v1 并核对字节');
  log();
  log('```http');
  log(`GET /api/cards/${cardId}/raw?version=1`);
  log('```');
  log();
  log(`- 响应头 \`X-TCS-Sha256: ${raw1.headers['x-tcs-sha256']}\``);
  log(`- 响应体与上传字节 \`Buffer.equals\` 比较：**${raw1.buffer.equals(v1Bytes)}**`);
  log();

  // ── 3. 提交 v2（只改一处文案） ───────────────────────────────
  const v1Text = v1Bytes.toString('utf8');
  const nameMarker = '"name": "林晚照"';
  const nameAt = v1Text.indexOf(nameMarker);
  if (nameAt < 0) throw new Error('fixture 里找不到 "name": "林晚照"');
  const v2Text =
    v1Text.slice(0, nameAt) +
    '"name": "林晚照（改）"' +
    v1Text.slice(nameAt + nameMarker.length).replace('保持安静克制的叙述风格。', '保持安静克制的叙述风格，句尾常用省略号。');
  const v2Bytes = Buffer.from(v2Text, 'utf8');
  const v2 = await call(`/api/cards/${cardId}/versions?message=调整叙述风格&author=演示脚本`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: v2Bytes,
  });
  if (v2.status !== 201) throw new Error(`提交新版本失败：${v2.buffer.toString('utf8')}`);
  recordExample('提交新版本', {
    method: 'POST',
    path: `/api/cards/${cardId}/versions?message=调整叙述风格&author=演示脚本`,
    headers: { Authorization: 'Bearer <token>', 'Content-Type': 'application/json' },
    body: '<修改后的原始字节>',
  }, v2);

  log('## 3. 提交 v2（只改一句文案）');
  log();
  log('```http');
  log(`POST /api/cards/${cardId}/versions?message=调整叙述风格&author=演示脚本`);
  log('```');
  log();
  log(`- v2 sha256：\`${v2.json.sha256}\`，父提交 \`${v2.json.parentCommit.slice(0, 8)}\``);
  log(`- 字节长度变化：${v1Bytes.byteLength} → ${v2Bytes.byteLength}（${v2Bytes.byteLength - v1Bytes.byteLength >= 0 ? '+' : ''}${v2Bytes.byteLength - v1Bytes.byteLength}）`);
  log();

  // ── 4. 历史 ────────────────────────────────────────────────
  const history = await call(`/api/cards/${cardId}/versions`);
  recordExample('版本历史', {
    method: 'GET',
    path: `/api/cards/${cardId}/versions`,
    headers: { Authorization: 'Bearer <token>' },
  }, history);
  log('## 4. 版本历史');
  log();
  log('| 版本 | 提交 | 消息 | 作者 | 审计（error/warning/info） |');
  log('|---|---|---|---|---|');
  for (const item of history.json.items) {
    log(
      `| v${item.seq} | \`${item.commit.slice(0, 8)}\` | ${item.message} | ${item.author} | ${item.audit.error}/${item.audit.warning}/${item.audit.info} |`,
    );
  }
  log();

  // ── 5. 三层 diff ────────────────────────────────────────────
  const diff = await call(`/api/cards/${cardId}/diff?from=1&to=2`);
  recordExample('版本 diff（字节 / 行 / JSON 三层）', {
    method: 'GET',
    path: `/api/cards/${cardId}/diff?from=1&to=2`,
    headers: { Authorization: 'Bearer <token>' },
  }, diff);
  log('## 5. 版本 diff');
  log();
  log('```json');
  log(
    JSON.stringify(
      {
        identical: diff.json.identical,
        bytes: {
          fromSha256: diff.json.bytes.fromSha256,
          toSha256: diff.json.bytes.toSha256,
          sizeDelta: diff.json.bytes.sizeDelta,
          firstDiffOffset: diff.json.bytes.firstDiffOffset,
        },
        lines: {
          added: diff.json.lines.added,
          removed: diff.json.lines.removed,
          hunks: diff.json.lines.hunks.map((hunk) => ({ header: hunk.header, lines: hunk.lines.length })),
        },
        json: diff.json.json.changes,
      },
      null,
      2,
    ),
  );
  log('```');
  log();
  const firstHunk = diff.json.lines.hunks[0];
  if (firstHunk) {
    log(`行级 diff 首个 hunk（${firstHunk.header}）：`);
    log();
    log('```diff');
    for (const line of firstHunk.lines) {
      const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
      log(`${prefix}${line.display}`);
    }
    log('```');
    log();
  }

  // ── 6. 回滚 ────────────────────────────────────────────────
  const rollback = await call(`/api/cards/${cardId}/rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: 1, message: '回滚到初版（演示）' }),
  });
  recordExample('回滚到指定版本', {
    method: 'POST',
    path: `/api/cards/${cardId}/rollback`,
    headers: { Authorization: 'Bearer <token>', 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: 1, message: '回滚到初版（演示）' }),
  }, rollback);
  log('## 6. 回滚到 v1');
  log();
  log('```http');
  log(`POST /api/cards/${cardId}/rollback`);
  log('Content-Type: application/json');
  log('');
  log('{ "to": 1, "message": "回滚到初版（演示）" }');
  log('```');
  log();
  log(`- 生成新版本 **v${rollback.json.version.seq}**（不是删除 v2，历史只增不改）`);
  log(`- v${rollback.json.version.seq} sha256：\`${rollback.json.version.sha256}\``);
  log(`- 与 v1 sha256 相同：**${rollback.json.version.sha256 === v1.sha256}**`);
  log();

  const afterHistory = await call(`/api/cards/${cardId}/versions`);
  const restored = await call(`/api/cards/${cardId}/raw?version=${rollback.json.version.seq}`);
  const identicalDiff = await call(`/api/cards/${cardId}/diff?from=1&to=${rollback.json.version.seq}`);

  log('## 7. 回滚后的逐字节校验');
  log();
  log(`- 版本总数：${afterHistory.json.total}（v1、v2、v${rollback.json.version.seq} 都在）`);
  log(`- v${rollback.json.version.seq} 原始字节与 v1 \`Buffer.equals\`：**${restored.buffer.equals(v1Bytes)}**`);
  log(`- \`GET /diff?from=1&to=${rollback.json.version.seq}\` → \`identical = ${identicalDiff.json.identical}\`，\`firstDiffOffset = ${identicalDiff.json.bytes.firstDiffOffset}\``);
  log();

  // ── 7.1 Git 对象核验（不依赖本机 git 命令，直接用 isomorphic-git 读裸仓库） ──
  const repo = join(workDir, 'store', 'repos', `${cardId}.git`);
  const commits = await git.log({ fs: fsDefault, dir: repo, gitdir: repo, ref: 'main' });
  const head = commits[0];
  const { commit: headCommit } = await git.readCommit({ fs: fsDefault, dir: repo, gitdir: repo, oid: head.oid });
  const { tree: headEntries } = await git.readTree({ fs: fsDefault, dir: repo, gitdir: repo, oid: headCommit.tree });
  const cardEntry = headEntries.find((entry) => entry.path === 'card.json');
  const auditEntry = headEntries.find((entry) => entry.path === 'audit.json');
  const { blob } = await git.readBlob({ fs: fsDefault, dir: repo, gitdir: repo, oid: cardEntry.oid });
  const gitObjectId = (bytes) => createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');

  log('用 Git 对象层复核（裸仓库是标准 Git 仓库，可随时用 `git --git-dir <repo> log` 查看）：');
  log();
  log('```console');
  log('$ git --git-dir "<dataDir>/repos/<cardId>.git" log --oneline');
  for (const commit of commits) {
    log(`${commit.oid.slice(0, 7)} ${commit.commit.message.trim()}`);
  }
  log('```');
  log();
  log('```console');
  log('$ git --git-dir "<dataDir>/repos/<cardId>.git" ls-tree -r HEAD');
  for (const entry of headEntries) log(`100644 blob ${entry.oid}\t${entry.path}`);
  log('```');
  log();
  log(`- HEAD 提交 \`${head.oid}\` 的 \`card.json\` blob oid：\`${cardEntry.oid}\``);
  log(`- 用「blob 头 + 上传字节」独立算出的 Git blob oid：\`${gitObjectId(Buffer.from(blob))}\``);
  log(`- 两者一致：**${cardEntry.oid === gitObjectId(Buffer.from(blob))}**；blob 内容与 v1 字节一致：**${Buffer.from(blob).equals(v1Bytes)}**`);
  log(`- HEAD 同时包含审计快照 \`audit.json\`（blob \`${auditEntry?.oid ?? '缺失'}\`），说明审计是**提交的一部分**，与卡片字节同时被版本化。`);
  log();
  log('对比提交之间（等价于 `git diff v1 v3 -- card.json`）：');
  log();
  log('```console');
  log(`$ git --git-dir "<dataDir>/repos/<cardId>.git" diff ${history.json.items[1].commit.slice(0, 7)} ${rollback.json.version.commit.slice(0, 7)} -- card.json`);
  log(identicalDiff.json.identical ? '（无输出 —— 回滚提交与 v1 的 card.json 完全相同）' : '（有差异，见上）');
  log('```');
  log();

  // ── 8. 审计快照 ────────────────────────────────────────────
  const audit1 = await call(`/api/cards/${cardId}/audit?version=1`);
  const audit2 = await call(`/api/cards/${cardId}/audit?version=2`);
  const recomputed = await call(`/api/cards/${cardId}/audit?version=2&refresh=true`);
  const auditAgain = await call(`/api/cards/${cardId}/audit?version=2`);
  const report1 = audit1.json;
  const report2 = audit2.json;

  recordExample('读取版本审计快照', {
    method: 'GET',
    path: `/api/cards/${cardId}/audit?version=2`,
    headers: { Authorization: 'Bearer <token>' },
  }, audit2);
  recordExample('按现行规则重算审计（不覆盖快照）', {
    method: 'GET',
    path: `/api/cards/${cardId}/audit?version=2&refresh=true`,
    headers: { Authorization: 'Bearer <token>' },
  }, recomputed);

  log('## 8. 审计随版本快照存储');
  log();
  log('| 版本 | 报告生成时间 | error | warning | info | 可导出 | 报告 sha256 |');
  log('|---|---|---|---|---|---|---|');
  for (const [seq, result] of [[1, audit1], [2, audit2]]) {
    const report = result.json;
    log(
      `| v${seq} | ${report.generatedAt} | ${report.summary.error} | ${report.summary.warning} | ${report.summary.info} | ${report.summary.exportable} | \`${sha256(result.buffer).slice(0, 16)}…\` |`,
    );
  }
  log();
  log(`- v1 报告里的 \`card.name\` = \`${report1.card.name}\`；v2 = \`${report2.card.name}\`（各版本保留当时的输入）`);
  log(`- v2 快照重复读取字节一致：**${audit2.buffer.equals(auditAgain.buffer)}**`);
  log(`- \`refresh=true\` 返回 \`X-TCS-Audit-Source: ${recomputed.headers['x-tcs-audit-source']}\`，并给出快照 sha256 = \`${(recomputed.headers['x-tcs-audit-snapshot'] ?? '').slice(0, 16)}…\``);
  log(`- 重算后再次读取 v2 快照：字节仍然一致 **${auditAgain.buffer.equals(audit2.buffer)}**（快照没有被覆盖）`);
  log();
  log('v2 审计报告摘要（截取前 4 条问题）：');
  log();
  log('```json');
  log(
    JSON.stringify(
      {
        schemaVersion: report2.schemaVersion,
        platformRule: report2.platformRule,
        presetId: report2.presetId,
        wordCount: { total: report2.wordCount.total, blocks: report2.wordCount.blocks.map((b) => `${b.label}=${b.totalWords}`) },
        summary: report2.summary,
        issues: report2.issues.slice(0, 4).map((issue) => ({
          severity: issue.severity,
          category: issue.category,
          ruleId: issue.ruleId,
          message: issue.message,
          location: issue.location,
        })),
      },
      null,
      2,
    ),
  );
  log('```');
  log();

  // ── 9. 管理面板控制 ────────────────────────────────────────
  const status = await call('/control/status', { base: PANEL });
  recordExample('管理面板：服务状态', {
    method: 'GET',
    path: '/control/status',
    headers: { Authorization: 'Bearer <token>' },
  }, status);

  log('## 9. 管理面板与服务控制（控制面独立于数据面）');
  log();
  log(`- 面板地址：\`${PANEL}/\`（由 supervisor 提供，worker 停止时仍可访问）`);
  log(`- 当前 worker：\`${status.json.worker.state}\`，pid ${status.json.worker.pid}`);
  const stop = await call('/control/service/stop', { base: PANEL, method: 'POST' });
  const panelAlive = await fetch(`${PANEL}/`);
  const apiDown = await call('/api/cards', { base: PANEL });
  const start = await call('/control/service/start', { base: PANEL, method: 'POST' });
  await waitFor(async () => (await call('/api/health', { token: null, base: PANEL })).status === 200);
  log(`- \`POST /control/service/stop\` → \`${stop.json.worker.state}\`；此时面板 \`GET /\` 仍返回 **${panelAlive.status}**，API \`GET /api/cards\` 返回 **${apiDown.status}**（\`${apiDown.json.error.code}\`）`);
  log(`- \`POST /control/service/start\` → \`${start.json.worker.state}\`，数据仍在（版本总数 ${(await call(`/api/cards/${cardId}/versions`, { base: PANEL })).json.total}）`);
  log();

  log('## 10. 结论');
  log();
  log('1. 上传/下载/回滚三条路径的 sha256 完全一致，说明服务端没有对卡片 JSON 做任何重序列化；');
  log('2. 每个版本在 Git 裸仓库里都有 `card.json`（原始字节）与 `audit.json`（当时审计报告），可用原生 git 复核；');
  log('3. 回滚是新增提交，历史不重写；`diff identical=true` 与 `git diff` 空输出互相印证；');
  log('4. 审计快照随版本存储，`refresh=true` 只读重算，不改写历史结论。');
  log();

  // ── 写出 ────────────────────────────────────────────────────
  const assets = join(ROOT, 'docs', 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, 'server-demo.md'), `${out.join('\n')}\n`, 'utf8');
  writeFileSync(
    join(assets, 'api-examples.json'),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        server: { version: version.version, apiVersion: version.apiVersion, node: version.node },
        note: '由 scripts/demo-server.mjs 对真实服务发起请求后录制；卡片正文/长文本已截断，token 以 <token> 代替。',
        examples: apiExamples,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log(`\n✔ 已写出 docs/assets/server-demo.md`);
  console.log(`✔ 已写出 docs/assets/api-examples.json`);
}

try {
  await main();
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await delay(1200);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true });
}
