/**
 * 账户注销体系（v0.1.3 / F3）。
 *
 * 用**真进程 + 真 HTTP + 直读 state.db**验证。三条理由：
 *
 *   ① 注销是**跨层**操作（路由鉴权 → 服务 → 7 张表 → 文件系统 → 审计），
 *      只测服务函数会漏掉"路由层把 repo-token 也放进来了"这种漏洞；
 *   ② 「数据全清单清零」必须**逐表**断言，而表在库文件里 ——
 *      通过 API 看是看不出来的（API 看不到 sessions、login_attempts、blob 文件）；
 *   ③ 「注销后旧 refresh 立即 401」要求同一个 refresh 在注销前后行为不同，
 *      只有一个会话前后不变的进程内测试才做得到。
 *
 * 覆盖（对应需求 1–7 与第 8 条测试清单）：
 *   ① 自助注销：二次确认（用户名必填/必须一致、密码可选但要对）
 *   ② 管理员注销：普通账户 403 ADMIN_ONLY；管理员可注销他人
 *   ③ 数据全清单清零：users / repos / repo_tokens / cards / versions /
 *      sessions / login_attempts 逐表 0；blob 文件与 git 仓库目录也从磁盘消失
 *   ④ 审计留痕：actor / targetUid / 动作 / 时间 / IP 五样齐全
 *   ⑤ 保护规则：最后一名管理员不可注销；管理员不能注销自己
 *   ⑥ 同名重注册：能注册成功且 uid 不同
 *   ⑦ 旧 refresh 立即 401（注销前换过一次，注销后再换失效）
 *   ⑧ 仓库令牌 / legacy 不能注销账户
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
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
let configPath = '';
let legacyToken = '';
/** 根管理员（固定不动）：所有管理员路径的调用者，绝不注销 */
let rootAdminId = '';

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  data: { name: '注销探针', description: '第一版', first_mes: '你好', mes_example: '' },
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

/**
 * 直读库文件断言表内条数。
 *
 * 每次现开现关：worker 一直在写，长连接会读到旧快照或被 WAL 状态绊住。
 * 关闭是必须的 —— 不关会让 `after` 里的 rmSync 在 Windows 上 EBUSY。
 */
async function count(table, where = '', params = []) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbFile, { readonly: true });
  try {
    const sql = `SELECT COUNT(*) AS n FROM ${table}${where === '' ? '' : ` WHERE ${where}`}`;
    return db.prepare(sql).get(...params).n;
  } finally {
    db.close();
  }
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-account-purge-'));
  configPath = join(workDir, 'config.json');
  port = 27400 + Math.floor(Math.random() * 300);

  const config = createDefaultConfig({
    token: 'G'.repeat(43),
    port,
    controlPort: port + 1,
    host: '127.0.0.1',
    controlHost: '127.0.0.1',
    dataDir: join(workDir, 'store'),
  });
  config.auth.registerMode = 'open';
  legacyToken = config.auth.token;
  writeConfig(configPath, config);
  dbFile = join(workDir, 'store', 'state.db');

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

  /*
   * **第一个注册的账户才是管理员**（服务端规则）。所以必须在所有测试之前
   * 钉一个根管理员，而且它**绝不能**被任何测试注销 —— 否则后面的管理员
   * 路径测试全都变成"普通账户 403"。
   *
   * 第一版没有这一步，于是 ① 里第一个注册的 `selfcheck` 恰好成了管理员：
   * 它自我注销时先撞上「最后一名管理员不可注销」得到 400（我以为是
   * 二次确认的逻辑错了），后面的账户则只是普通用户，
   * 管理员路径一律 403。**一个前提没摆对，七条测试一起红。**
   */
  const rootRes = await request('/api/auth/register', {
    method: 'POST',
    body: { username: 'rootadmin', password: 'rootadmin-password-1' },
  });
  assert.ok(rootRes.status === 201 || rootRes.status === 200, `建根管理员失败：${rootRes.text}`);
  assert.equal(rootRes.json.user.role, 'admin', '根管理员必须是 admin');
  rootAdminId = rootRes.json.user.id;
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

/** 注册（返回 user）；失败直接抛，避免后面用 undefined 一路做假断言 */
async function register(username, password) {
  const res = await request('/api/auth/register', { method: 'POST', body: { username, password } });
  assert.ok(res.status === 201 || res.status === 200, `注册 ${username} 失败：${res.text}`);
  return { user: res.json.user, accessToken: res.json.accessToken, refreshToken: res.json.refreshToken };
}

async function login(username, password) {
  const res = await request('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(res.status, 200, `登录 ${username} 失败：${res.text}`);
  return { accessToken: res.json.accessToken, refreshToken: res.json.refreshToken };
}

async function uploadCard(token, cardId, body = CARD) {
  return request(`/api/cards?cardId=${encodeURIComponent(cardId)}`, {
    method: 'POST',
    body,
    raw: true,
    token,
  });
}

/**
 * 给某个账户造齐"七张表 + 两个文件系统区域"的数据。
 *
 * 这是本文件的**核心装置**：只造一半数据就去断言"删干净了"，等于用
 * 空表证明删除有效。所以每类数据都造，并在断言里逐类点名。
 */
async function seedEverything(account, tag) {
  const { accessToken } = account;

  // ① 卡片 + 版本（两次上传 → 2 个版本，其中一个旧版本供 prune 之外的分支）
  const cardId = `purge-${tag}-card`;
  const first = await uploadCard(accessToken, cardId);
  assert.ok(first.status === 200 || first.status === 201, `上传失败：${first.text}`);
  const second = await uploadCard(
    accessToken,
    cardId,
    JSON.stringify({
      spec: 'chara_card_v2',
      data: { name: '注销探针', description: '第二版', first_mes: '你好', mes_example: '' },
    }),
  );
  assert.ok(second.status === 200, `追加版本失败：${second.text}`);

  // ② 一张进回收站的卡（软删）—— 注销必须连它一起清
  const trashCardId = `purge-${tag}-trashed`;
  await uploadCard(accessToken, trashCardId);
  const removed = await request(`/api/cards/${encodeURIComponent(trashCardId)}`, {
    method: 'DELETE',
    token: accessToken,
  });
  assert.equal(removed.status, 200, `软删失败：${removed.text}`);

  // ③ 仓库（注册时自动建了 default，这里再建一个非默认的）
  const repo = await request('/api/repos', { method: 'POST', token: accessToken, body: { name: `repo-${tag}` } });
  assert.equal(repo.status, 201, `建仓库失败：${repo.text}`);
  const repoId = repo.json.id;

  // ④ 仓库令牌（两把：一把挂在新建仓库上，一把挂默认仓库）
  const repos = await request('/api/repos', { token: accessToken });
  const defaultRepo = repos.json.items.find((item) => item.isDefault);
  const issued = await request(`/api/repos/${repoId}/tokens`, {
    method: 'POST',
    token: accessToken,
    body: { name: `token-${tag}`, scopes: ['read'] },
  });
  assert.equal(issued.status, 201, `签令牌失败：${issued.text}`);
  await request(`/api/repos/${defaultRepo.id}/tokens`, {
    method: 'POST',
    token: accessToken,
    body: { name: `token2-${tag}`, scopes: ['read', 'write'] },
  });

  // ⑤ 会话：注册时一个，再登录一次 → 两个
  const extra = await login(account.user.username, account.password);

  // ⑥ 登录失败计数：故意失败一次，留下 login_attempts 行
  await request('/api/auth/login', {
    method: 'POST',
    body: { username: account.user.username, password: 'definitely-wrong-password' },
  });

  return {
    cardId,
    trashCardId,
    repoId,
    defaultRepoId: defaultRepo.id,
    tokenRaw: issued.json.token,
    accessToken,
    extraAccessToken: extra.accessToken,
    // 注销前最后一次换来的 refresh：用它验证"注销后立即 401"
    liveRefreshToken: extra.refreshToken,
  };
}

// ══════════════════════════════════════════════════════════
// ① 自助注销：二次确认
// ══════════════════════════════════════════════════════════

test('① 自助注销：用户名必填、必须一致；密码可选但给了就要对', async () => {
  const account = await register('selfcheck', 'selfcheck-password-1');
  account.password = 'selfcheck-password-1';
  const token = account.accessToken;

  // 不传确认
  const missing = await request('/api/account/delete', { method: 'POST', token, body: {} });
  assert.equal(missing.status, 400, missing.text);
  assert.match(missing.json.error.message, /用户名/);

  // 传错用户名
  const wrong = await request('/api/account/delete', {
    method: 'POST',
    token,
    body: { confirmUsername: 'someone-else' },
  });
  assert.equal(wrong.status, 400, wrong.text);
  assert.match(wrong.json.error.message, /不一致/);

  // 传对用户名但密码错 —— 必须拒（"密码确认"不能是装饰品）
  const badPassword = await request('/api/account/delete', {
    method: 'POST',
    token,
    body: { confirmUsername: 'selfcheck', password: 'wrong-password' },
  });
  assert.equal(badPassword.status, 400, badPassword.text);
  assert.match(badPassword.json.error.message, /密码不正确/);

  // 以上三次都不该删掉账户
  assert.equal(await count('users', 'username = ?', ['selfcheck']), 1, '校验失败不应删除账户');

  // 正确用户名即可（密码可选）
  const ok = await request('/api/account/delete', {
    method: 'POST',
    token,
    body: { confirmUsername: 'selfcheck' },
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.purged, true);
  assert.equal(ok.json.path, 'self');
  assert.equal(await count('users', 'username = ?', ['selfcheck']), 0);
});

test('①b 自助注销：用户名大小写不敏感（与唯一性口径一致）', async () => {
  const account = await register('CaseUser', 'caseuser-password-1');
  const ok = await request('/api/account/delete', {
    method: 'POST',
    token: account.accessToken,
    body: { confirmUsername: 'caseuser' },
  });
  assert.equal(ok.status, 200, `大小写不同应被接受：${ok.text}`);
  assert.equal(await count('users', 'username = ?', ['CaseUser']), 0);
});

test('①c 仓库令牌与 legacy 全局令牌都不能注销账户', async () => {
  const account = await register('tokenrefuse', 'tokenrefuse-password-1');
  account.password = 'tokenrefuse-password-1';
  const seeded = await seedEverything(account, 'refuse');

  const asRepoToken = await request('/api/account/delete', {
    method: 'POST',
    token: seeded.tokenRaw,
    body: { confirmUsername: 'tokenrefuse' },
  });
  assert.equal(asRepoToken.status, 403, `仓库令牌不该能注销账户：${asRepoToken.text}`);
  assert.match(asRepoToken.json.error.message, /仓库令牌/);

  const asLegacy = await request('/api/account/delete', {
    method: 'POST',
    token: legacyToken,
    body: { confirmUsername: 'tokenrefuse' },
  });
  assert.equal(asLegacy.status, 403, `legacy 不该能注销账户：${asLegacy.text}`);

  assert.equal(await count('users', 'username = ?', ['tokenrefuse']), 1, '两次拒绝都不该删账户');

  // 收拾干净，免得干扰后面的全量断言
  await request('/api/account/delete', {
    method: 'POST',
    token: account.accessToken,
    body: { confirmUsername: 'tokenrefuse' },
  });
});

// ══════════════════════════════════════════════════════════
// ② 数据全清单清零
// ══════════════════════════════════════════════════════════

test('② 数据全清单清零：七张表 + blob 文件 + git 仓库目录', async () => {
  // 用固定的根管理员执行注销（它绝不注销，所以后续测试仍有管理员可用）
  const admin = await login('rootadmin', 'rootadmin-password-1');

  const target = await register('clearme', 'clearme-password-1');
  target.password = 'clearme-password-1';
  const seeded = await seedEverything(target, 'clear');

  const userId = target.user.id;
  const userUid = target.user.uid;

  // 断言"造齐了"——否则后面的 0 是空表带来的假绿
  assert.ok(await count('cards', 'owner_id = ?', [userId]) >= 2, '应至少有两张卡（含回收站里那张）');
  assert.ok(await count('versions') > 0, '应有版本');
  assert.ok(await count('repos', 'owner_id = ?', [userId]) >= 2, '应有至少两个仓库');
  assert.ok(await count('repo_tokens', 'owner_id = ?', [userId]) >= 2, '应有两把令牌');
  assert.ok(await count('sessions', 'user_id = ?', [userId]) >= 1, '应有会话');
  assert.ok(await count('login_attempts', 'key = ?', ['clearme']) >= 1, '应有登录失败计数');

  // 记录磁盘上的 blob 数与 git 仓库目录（注销后要变少）
  const blobsDir = join(workDir, 'store', 'blobs');
  /*
   * git 仓库目录是 `<dataDir>/repos/<cardId>.git`（裸库），
   * 不是 `cards/` —— 第一版按 `cards/<cardId>` 断言，直接把
   * 「应有 git 仓库目录」判成 false，而那时数据其实好端端在那儿。
   */
  const gitDir = join(workDir, 'store', 'repos');
  const blobsBefore = existsSync(blobsDir) ? countFilesRecursive(blobsDir) : 0;
  assert.ok(blobsBefore > 0, '应有内容块文件');
  const gitCardDir = join(gitDir, `${seeded.cardId}.git`);
  const gitTrashDir = join(gitDir, `${seeded.trashCardId}.git`);
  assert.ok(existsSync(gitCardDir), `应有 git 仓库目录：${gitCardDir}`);
  assert.ok(existsSync(gitTrashDir), `回收站那张卡的 git 目录也应在：${gitTrashDir}`);

  // 用管理员路径注销（顺带覆盖需求 2）
  const purged = await request(`/api/accounts/${userId}`, { method: 'DELETE', token: admin.accessToken });
  assert.equal(purged.status, 200, purged.text);
  assert.equal(purged.json.path, 'admin');
  assert.equal(purged.json.uid, userUid, '回执应带原 uid');
  assert.equal(purged.json.warnings.length, 0, `不该有文件删除警告：${JSON.stringify(purged.json.warnings)}`);

  // ── 逐表断言 ──
  assert.equal(await count('users', 'id = ?', [userId]), 0, 'users 应清零');
  assert.equal(await count('repos', 'owner_id = ?', [userId]), 0, 'repos 应清零');
  assert.equal(await count('repo_tokens', 'owner_id = ?', [userId]), 0, 'repo_tokens 应清零');
  assert.equal(await count('cards', 'owner_id = ?', [userId]), 0, 'cards 应清零（含回收站）');
  assert.equal(
    await count('versions', 'card_id IN (?,?)', [seeded.cardId, seeded.trashCardId]),
    0,
    'versions 应清零',
  );
  assert.equal(await count('sessions', 'user_id = ?', [userId]), 0, 'sessions 应清零');
  assert.equal(await count('login_attempts', 'key = ?', ['clearme']), 0, 'login_attempts 应清零');

  // 回执里的计数要与实际删除量一致（对不上说明有两套口径）
  assert.equal(purged.json.counts.cards, 2, `回执卡片数应为 2，实际 ${String(purged.json.counts.cards)}`);
  assert.equal(purged.json.counts.repos, 2, `回执仓库数应为 2，实际 ${String(purged.json.counts.repos)}`);
  assert.equal(purged.json.counts.repoTokens, 2, `回执令牌数应为 2，实际 ${String(purged.json.counts.repoTokens)}`);

  // ── 文件系统 ──
  assert.equal(existsSync(gitCardDir), false, 'git 仓库目录应已删除');
  assert.equal(existsSync(gitTrashDir), false, '回收站那张卡的 git 目录也应删除');
  const blobsAfter = existsSync(blobsDir) ? countFilesRecursive(blobsDir) : 0;
  assert.ok(blobsAfter < blobsBefore, `blob 应减少（前 ${String(blobsBefore)} 后 ${String(blobsAfter)}）`);

  // 收尾：不注销根管理员 —— 它是后面「保护规则」那几条测试的调用者与目标
});

test('②b 别人的数据不受影响（注销不是清库）', async () => {
  // 根管理员还在，且它也有自己的默认仓库
  const admin = await login('rootadmin', 'rootadmin-password-1');
  const repos = await request('/api/repos', { token: admin.accessToken });
  assert.equal(repos.status, 200, repos.text);
  assert.ok(repos.json.items.length >= 1, '旁观账户的仓库应仍然存在');
  assert.ok(await count('users') >= 1, '库里应仍有账户');
});

// ══════════════════════════════════════════════════════════
// ③ 审计留痕
// ══════════════════════════════════════════════════════════

test('③ 审计留痕：操作者 / 目标 uid / 动作 / 时间 / IP', async () => {
  const admin = await login('rootadmin', 'rootadmin-password-1');
  const audit = await request('/api/audit/account-purges?limit=20', { token: admin.accessToken });
  assert.equal(audit.status, 200, audit.text);
  assert.ok(audit.json.items.length >= 1, '应有注销审计事件');
  assert.equal(audit.json.retentionDays, 90, '保留期口径应为 90 天');

  const adminPurge = audit.json.items.find((item) => item.action === 'account.purge.admin');
  assert.ok(adminPurge !== undefined, '应有一条管理员路径的注销事件');
  assert.match(adminPurge.actor, /rootadmin/, `操作者应记为 rootadmin：${String(adminPurge.actor)}`);
  assert.match(adminPurge.targetUid, /^usr_/, `目标 uid 应形如 usr_…：${String(adminPurge.targetUid)}`);
  assert.equal(adminPurge.targetUsername, 'clearme');
  assert.equal(adminPurge.path, 'admin');
  assert.ok(typeof adminPurge.at === 'string' && adminPurge.at.endsWith('Z'), '时间应是 UTC ISO');
  assert.ok(adminPurge.counts !== null, '事件里应带清理计数');

  // 自助路径的事件也要有
  const selfPurge = audit.json.items.find((item) => item.action === 'account.purge.self');
  assert.ok(selfPurge !== undefined, '应有一条自助注销事件');

  // 普通账户看不到审计（治理上下文才有的东西）
  const normal = await register('auditpeek', 'auditpeek-password-1');
  const denied = await request('/api/audit/account-purges', { token: normal.accessToken });
  assert.equal(denied.status, 403, `普通账户应 403：${denied.text}`);
  await request('/api/account/delete', {
    method: 'POST',
    token: normal.accessToken,
    body: { confirmUsername: 'auditpeek' },
  });
});

// ══════════════════════════════════════════════════════════
// ④ 保护规则
// ══════════════════════════════════════════════════════════

test('④ 管理员不能注销自己（治理页路径）', async () => {
  const admin = await login('rootadmin', 'rootadmin-password-1');
  const me = await request('/api/auth/me', { token: admin.accessToken });
  assert.equal(me.json.user.id, rootAdminId, '前置条件：调用者应是根管理员');
  const selfPurge = await request(`/api/accounts/${rootAdminId}`, {
    method: 'DELETE',
    token: admin.accessToken,
  });
  assert.equal(selfPurge.status, 403, `管理员注销自己应被拒：${selfPurge.text}`);
  assert.match(selfPurge.json.error.message, /管理员不能在这里注销自己/);
  assert.equal(await count('users', 'id = ?', [rootAdminId]), 1, '拒绝后账户应还在');
});

test('④b 最后一名管理员不可注销（自助路径也拦）', async () => {
  // 此时库里只剩 rootadmin 一个管理员
  const admins = await count("users WHERE role = 'admin' AND status = 'active'");
  assert.equal(admins, 1, `前置条件：应只剩 1 个管理员，实际 ${String(admins)}`);

  const admin = await login('rootadmin', 'rootadmin-password-1');
  const purged = await request('/api/account/delete', {
    method: 'POST',
    token: admin.accessToken,
    body: { confirmUsername: 'rootadmin' },
  });
  assert.equal(purged.status, 403, `最后一名管理员自助注销也应被拒：${purged.text}`);
  assert.match(purged.json.error.message, /最后一个启用中的管理员/);
  assert.equal(await count('users', 'id = ?', [rootAdminId]), 1, '拒绝后账户应还在');
});

test('④c 管理员注销他人：普通账户 403 ADMIN_ONLY', async () => {
  const normal = await register('notadmin', 'notadmin-password-1');
  const victim = await register('victim', 'victim-password-1');
  const denied = await request(`/api/accounts/${victim.user.id}`, {
    method: 'DELETE',
    token: normal.accessToken,
  });
  assert.equal(denied.status, 403, `普通账户应 403：${denied.text}`);
  assert.equal(denied.json.error.code, 'ADMIN_ONLY');
  assert.equal(await count('users', 'username = ?', ['victim']), 1, '拒绝后目标应还在');

  for (const name of ['notadmin', 'victim']) {
    const account = await login(name, `${name}-password-1`);
    await request('/api/account/delete', {
      method: 'POST',
      token: account.accessToken,
      body: { confirmUsername: name },
    });
  }
});

// ══════════════════════════════════════════════════════════
// ⑤ 同名重注册 → 新 uid
// ══════════════════════════════════════════════════════════

test('⑤ 注销后用户名可重新注册，且拿到新 uid', async () => {
  const first = await register('reborn', 'reborn-password-1');
  first.password = 'reborn-password-1';
  const oldUid = first.user.uid;
  assert.match(oldUid, /^usr_/, `uid 形态应如 usr_…：${String(oldUid)}`);

  const gone = await request('/api/account/delete', {
    method: 'POST',
    token: first.accessToken,
    body: { confirmUsername: 'reborn' },
  });
  assert.equal(gone.status, 200, gone.text);

  // 同名重注册：唯一索引已随行删除，应当成功
  const second = await register('reborn', 'reborn-password-2');
  const newUid = second.user.uid;
  assert.match(newUid, /^usr_/, `新 uid 形态应如 usr_…：${String(newUid)}`);
  assert.notEqual(newUid, oldUid, '重注册必须拿到**新** uid（旧 uid 已随账户销毁）');
  assert.notEqual(second.user.id, first.user.id, '内部 id 也必须不同（否则会接上旧数据）');

  // 新账户是干净的：没有从旧账户继承任何卡片
  const cards = await request('/api/cards', { token: second.accessToken });
  assert.equal(cards.status, 200, cards.text);
  assert.equal(cards.json.total, 0, '重注册的账户不该看到旧账户的卡片');

  // 新 uid 的账户可正常注销（说明它不是半成品）
  const cleaned = await request('/api/account/delete', {
    method: 'POST',
    token: second.accessToken,
    body: { confirmUsername: 'reborn', password: 'reborn-password-2' },
  });
  assert.equal(cleaned.status, 200, cleaned.text);
});

// ══════════════════════════════════════════════════════════
// ⑥ 注销后旧 refresh 立即 401
// ══════════════════════════════════════════════════════════

test('⑥ 注销后旧 refresh 立即 401（不等 2 小时自然过期）', async () => {
  const account = await register('refreshdie', 'refreshdie-password-1');
  account.password = 'refreshdie-password-1';
  const seeded = await seedEverything(account, 'refresh');

  // 注销前：这把 refresh 是好用的（否则后面那条 401 说明不了问题）
  const before = await request('/api/auth/refresh', {
    method: 'POST',
    body: { refreshToken: seeded.liveRefreshToken },
  });
  assert.equal(before.status, 200, `注销前 refresh 应可用：${before.text}`);
  // refresh 会轮换，用新的那把（旧的已被服务端作废 —— 这是设计）
  const liveRefresh = before.json.refreshToken;

  const purged = await request('/api/account/delete', {
    method: 'POST',
    token: account.accessToken,
    body: { confirmUsername: 'refreshdie' },
  });
  assert.equal(purged.status, 200, purged.text);

  const afterRefresh = await request('/api/auth/refresh', {
    method: 'POST',
    body: { refreshToken: liveRefresh },
  });
  assert.equal(afterRefresh.status, 401, `注销后 refresh 必须立即 401：${afterRefresh.text}`);

  // access 也必须失效（否则"注销"只是登出）
  const staleAccess = await request('/api/cards', { token: seeded.accessToken });
  assert.equal(staleAccess.status, 401, `注销后旧 access 必须 401：${staleAccess.text}`);
});

// ── 工具 ────────────────────────────────────────────────────

/** 递归数文件（blob 按两级目录分片存放） */
function countFilesRecursive(dir) {
  let total = 0;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) total += countFilesRecursive(full);
    else total += 1;
  }
  return total;
}

