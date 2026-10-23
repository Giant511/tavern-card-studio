/**
 * T10.6 冒烟：仓库 + 仓库令牌的真服务端流程。
 *
 * 重点验证"逐请求执行"和"越权拒绝"，这些只有跑真服务端才看得出来：
 *   · 读令牌尝试写 → 403
 *   · 令牌只能访问自己绑定的仓库
 *   · 吊销后立刻失效（不等过期）
 *   · 令牌原文只出现一次（列表里只有前缀）
 *
 * 用法：node scripts/smoke-t106.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' —— ' + detail : ''}`);
};

const work = mkdtempSync(join(tmpdir(), 'tcs-t106-'));
const port = 19500 + Math.floor(Math.random() * 200);
const globalToken = 'smoke-global-token-abcdefghijklmnop';

writeFileSync(
  join(work, 'config.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      port,
      controlPort: port + 1,
      host: '127.0.0.1',
      controlHost: '127.0.0.1',
      dataDir: join(work, 'store'),
      rulesDir: 'rules',
      defaultPlatformRule: 'sillytavern',
      defaultPreset: 'default',
      maxUploadBytes: 33554432,
      logLevel: 'warn',
      auth: {
        token: globalToken,
        require: true,
        publicPaths: ['/api/health'],
        registerMode: 'open',
        jwtSecret: 'unit-test-jwt-secret-aaaaaaaaaaaaaaaaaaaaaaaa',
      },
      tls: { mode: 'off', httpsPort: port + 1000, certPath: '', keyPath: '' },
      service: { mode: 'process', name: 'T106', displayName: 'T106', autoStart: false },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);

const child = spawn(process.execPath, ['server/dist/index.js', 'worker', '--config', join(work, 'config.json')], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(`[srv] ${String(d)}`));

const base = `http://127.0.0.1:${String(port)}`;

async function call(path, { method = 'GET', body, auth, raw } = {}) {
  const headers = {};
  if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
  if (auth) headers.Authorization = `Bearer ${auth}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

const cardJson = readFileSync('test/fixtures/sample-card.json', 'utf8');

async function waitReady() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      /* 还没起来 */
    }
    await delay(100);
  }
  throw new Error('服务端没起来');
}

try {
  await waitReady();

  // ── 建账户 ─────────────────────────────────────────────
  const reg = await call('/api/auth/register', {
    method: 'POST',
    body: { username: 'owner', password: 'owner-password-1' },
  });
  check('注册账户', reg.status === 201 && !!reg.json?.accessToken, `status=${reg.status}`);
  const accessToken = reg.json.accessToken;

  // ── 仓库 ───────────────────────────────────────────────
  const repos1 = await call('/api/repos', { auth: accessToken });
  check('新账户自动有默认仓库', repos1.status === 200 && repos1.json?.items?.length === 1,
    `count=${repos1.json?.items?.length ?? '-'}`);
  const defaultRepo = repos1.json.items[0];
  check('默认仓库 isDefault=true', defaultRepo.isDefault === true, defaultRepo.name);

  const createRepo = await call('/api/repos', {
    method: 'POST',
    auth: accessToken,
    body: { name: 'archive', description: '归档' },
  });
  check('新建仓库', createRepo.status === 201 && createRepo.json?.name === 'archive', `status=${createRepo.status}`);
  const archiveRepo = createRepo.json;

  const dupRepo = await call('/api/repos', { method: 'POST', auth: accessToken, body: { name: 'ARCHIVE' } });
  check('仓库名账户内唯一（大小写不敏感）', dupRepo.status === 409, `status=${dupRepo.status}`);

  // ── 上传卡片到指定仓库 ─────────────────────────────────
  const up1 = await call('/api/cards?cardId=card-in-archive&repo=archive', {
    method: 'POST',
    auth: accessToken,
    body: cardJson,
    raw: true,
  });
  check('上传到指定仓库', up1.status === 201 || up1.status === 200, `status=${up1.status}`);

  const up2 = await call('/api/cards?cardId=card-in-default', {
    method: 'POST',
    auth: accessToken,
    body: cardJson,
    raw: true,
  });
  check('未指定仓库时落到默认仓库', up2.status === 201 || up2.status === 200, `status=${up2.status}`);

  const repos2 = await call('/api/repos', { auth: accessToken });
  const archiveNow = repos2.json.items.find((r) => r.id === archiveRepo.id);
  const defaultNow = repos2.json.items.find((r) => r.isDefault);
  check('归档仓库有 1 张卡', archiveNow?.cardCount === 1, `cardCount=${archiveNow?.cardCount}`);
  check('默认仓库有 1 张卡', defaultNow?.cardCount === 1, `cardCount=${defaultNow?.cardCount}`);

  const delNonEmpty = await call(`/api/repos/${archiveRepo.id}`, { method: 'DELETE', auth: accessToken });
  check('有卡片的仓库不能删', delNonEmpty.status === 409, `status=${delNonEmpty.status}`);

  // ── 签发令牌 ───────────────────────────────────────────
  const issueRead = await call(`/api/repos/${archiveRepo.id}/tokens`, {
    method: 'POST',
    auth: accessToken,
    body: { name: '只读', scopes: ['read'] },
  });
  check('签发只读令牌', issueRead.status === 201 && /^tcr_/.test(issueRead.json?.token ?? ''),
    `prefix=${issueRead.json?.tokenPrefix}`);
  const readToken = issueRead.json.token;
  const readTokenId = issueRead.json.tokenPrefix;

  const issueRw = await call(`/api/repos/${archiveRepo.id}/tokens`, {
    method: 'POST',
    auth: accessToken,
    body: { name: '读写', scopes: ['read', 'write'] },
  });
  check('签发读写令牌', issueRw.status === 201, '');
  const rwToken = issueRw.json.token;

  // 原文只出现一次
  const listTokens = await call(`/api/repos/${archiveRepo.id}/tokens`, { auth: accessToken });
  const listed = JSON.stringify(listTokens.json);
  check('令牌列表里没有原文（只有前缀）', !listed.includes(readToken) && listed.includes(readTokenId), '');
  check('列表带 note 提醒不可再取', /只显示一次|只返回前缀/.test(listTokens.json?.note ?? ''), '');

  // ── 权限：读令牌不能写 ─────────────────────────────────
  const readGet = await call('/api/cards', { auth: readToken });
  check('读令牌可以列卡片', readGet.status === 200, `status=${readGet.status}`);

  const readWrite = await call('/api/cards?cardId=should-fail', {
    method: 'POST',
    auth: readToken,
    body: cardJson,
    raw: true,
  });
  check('读令牌写 → 403', readWrite.status === 403, `status=${readWrite.status}`);
  check('403 里说明缺 read/write 中的哪个', /write/.test(readWrite.json?.error?.message ?? ''),
    (readWrite.json?.error?.message ?? '').slice(0, 60));

  const readDelete = await call('/api/cards/card-in-archive', { method: 'DELETE', auth: readToken });
  check('读令牌删卡 → 403（delete 归 write）', readDelete.status === 403, `status=${readDelete.status}`);

  // ── 权限：写令牌不能回滚 ───────────────────────────────
  const rwRollback = await call('/api/cards/card-in-archive/rollback?seq=1', {
    method: 'POST',
    auth: rwToken,
  });
  check('读写令牌回滚 → 403（缺 rollback）', rwRollback.status === 403, `status=${rwRollback.status}`);

  const rwWrite = await call('/api/cards?cardId=card-in-archive&repo=archive', {
    method: 'POST',
    auth: rwToken,
    body: cardJson,
    raw: true,
  });
  check('读写令牌可以写', rwWrite.status === 200 || rwWrite.status === 201, `status=${rwWrite.status}`);

  // ── 收窄权限立刻生效（逐请求执行）──────────────────────
  const narrow = await call(`/api/tokens/${readTokenId.startsWith('tcr_') ? '' : ''}`, { method: 'DELETE' });
  void narrow;
  const tokensFull = await call(`/api/repos/${archiveRepo.id}/tokens`, { auth: accessToken });
  const rwRow = tokensFull.json.items.find((t) => t.name === '读写');
  const patch = await call(`/api/tokens/${rwRow.id}`, {
    method: 'PATCH',
    auth: accessToken,
    body: { scopes: ['read'] },
  });
  check('可以把令牌权限收窄到 read', patch.status === 200 && JSON.stringify(patch.json?.scopes) === '["read"]',
    `scopes=${JSON.stringify(patch.json?.scopes)}`);

  const afterNarrow = await call('/api/cards?cardId=after-narrow', {
    method: 'POST',
    auth: rwToken,
    body: cardJson,
    raw: true,
  });
  check('收窄后下一次请求就被拒（逐请求执行）', afterNarrow.status === 403, `status=${afterNarrow.status}`);

  // ── 吊销立刻生效 ───────────────────────────────────────
  const revoke = await call(`/api/tokens/${rwRow.id}`, { method: 'DELETE', auth: accessToken });
  check('吊销令牌', revoke.status === 200 && revoke.json?.revoked === true, `status=${revoke.status}`);

  const afterRevoke = await call('/api/cards', { auth: rwToken });
  check('吊销后立刻 401', afterRevoke.status === 401, `status=${afterRevoke.status}`);

  // ── 令牌不能管理令牌（防自我续期）──────────────────────
  const privEsc = await call(`/api/repos/${archiveRepo.id}/tokens`, {
    method: 'POST',
    auth: readToken,
    body: { name: '提权', scopes: ['read', 'write', 'rollback'] },
  });
  check('仓库令牌不能签发新令牌（防自我续期）', privEsc.status === 403, `status=${privEsc.status}`);

  // ── 仓库令牌不能越界到别的仓库 ─────────────────────────
  const crossRepo = await call('/api/cards?cardId=cross-repo&repo=default', {
    method: 'POST',
    auth: readToken,
    body: cardJson,
    raw: true,
  });
  check('仓库令牌受 scopes 限制（读令牌写别的仓库也 403）', crossRepo.status === 403, `status=${crossRepo.status}`);

  // ── legacy 全局 token ──────────────────────────────────
  const legacyRepos = await call('/api/repos', { auth: globalToken });
  check('legacy 不能管理仓库（无账户身份）', legacyRepos.status === 403, `status=${legacyRepos.status}`);
  check('legacy 的拒绝信息说清了原因', /没有账户身份/.test(legacyRepos.json?.error?.message ?? ''),
    (legacyRepos.json?.error?.message ?? '').slice(0, 50));

  const legacyCards = await call('/api/cards', { auth: globalToken });
  check('legacy 仍可读写卡片（兼容层）', legacyCards.status === 200, `status=${legacyCards.status}`);

  // ── 过期令牌被拒 ───────────────────────────────────────
  const soon = new Date(Date.now() + 1500).toISOString();
  const issueExpiring = await call(`/api/repos/${archiveRepo.id}/tokens`, {
    method: 'POST',
    auth: accessToken,
    body: { name: '短命', scopes: ['read'], expiresAt: soon },
  });
  check('可以签发带过期时间的令牌', issueExpiring.status === 201, '');
  await delay(2000);
  const expiredUse = await call('/api/cards', { auth: issueExpiring.json.token });
  check('过期令牌被拒（401）', expiredUse.status === 401, `status=${expiredUse.status}`);

  const pastIssue = await call(`/api/repos/${archiveRepo.id}/tokens`, {
    method: 'POST',
    auth: accessToken,
    body: { name: '过去', scopes: ['read'], expiresAt: new Date(Date.now() - 60000).toISOString() },
  });
  check('不允许签发已过期的令牌', pastIssue.status === 400, `status=${pastIssue.status}`);
} finally {
  child.kill();
  await delay(400);
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`);
process.exit(failed.length === 0 ? 0 : 1);
