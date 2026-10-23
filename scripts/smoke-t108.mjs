/**
 * T10.8 冒烟：服务端按账户 + 仓库过滤，以及 legacy 全局令牌降权。
 *
 * 用户拍板的行为（2026-10-23）：
 *   · legacy 全局令牌在多账户环境下**只看未归属卡片**（`owner_id = ''`）；
 *   · 单账户环境行为不变（未归属的都还在，账户自己的也都看得到）。
 *
 * 这里验的是"跨账户一律看不见"，而且**要求 404 的响应体逐字节相等** ——
 * 只断言状态码不够：文案或字段差一点，就退化成"这个 id 存在但不是你的"的枚举器
 * （docs/29 §2.1–2.2）。
 *
 * 用法：node scripts/smoke-t108.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' —— ' + detail : ''}`);
};

const work = mkdtempSync(join(tmpdir(), 'tcs-t108-'));
const port = 20300 + Math.floor(Math.random() * 100);
const legacyToken = 't108-legacy-token-aaaaaaaaaaaaaaaaaaaa';

const configPath = join(work, 'config.json');
writeFileSync(
  configPath,
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
      logLevel: 'error',
      auth: {
        token: legacyToken,
        require: true,
        publicPaths: ['/api/health'],
        registerMode: 'open',
        jwtSecret: 'unit-test-jwt-secret-aaaaaaaaaaaaaaaaaaaaaaaa',
      },
      tls: { mode: 'off', httpsPort: port + 1000, certPath: '', keyPath: '' },
      service: { mode: 'process', name: 'T108', displayName: 'T108', autoStart: false },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);

const child = spawn(process.execPath, ['server/dist/index.js', 'worker', '--config', configPath], {
  cwd: REPO,
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(`[srv] ${String(d)}`));

const base = `http://127.0.0.1:${String(port)}`;

async function call(path, { method = 'GET', body, token, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
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

const cardJson = readFileSync(join(REPO, 'test', 'fixtures', 'sample-card.json'), 'utf8');
const namedCard = (name) => cardJson.replace('"name": "林晚照"', `"name": "${name}"`);

async function runCli(args) {
  return new Promise((resolvePromise) => {
    const cli = spawn(process.execPath, ['server/dist/index.js', ...args], { cwd: REPO, stdio: 'ignore' });
    cli.on('exit', (code) => resolvePromise(code));
  });
}

try {
  // 等服务端
  let up = false;
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        up = true;
        break;
      }
    } catch {
      /* 还没起 */
    }
    await delay(150);
  }
  check('服务端就绪', up, base);

  // ── 准备：一个账户 + 两张卡（一张归账户、一张归 legacy）────
  const reg = await call('/api/auth/register', {
    method: 'POST',
    body: { username: 'alice', password: 'alice-password-1' },
  });
  check('账户 alice 已创建（首账户即管理员）', reg.status === 201, `status=${reg.status}`);
  const aliceToken = reg.json?.accessToken;

  const aliceUpload = await call('/api/cards?cardId=alice-card', {
    method: 'POST',
    body: namedCard('爱丽丝的卡'),
    token: aliceToken,
    raw: true,
  });
  check('账户上传一张卡（归默认仓库）', aliceUpload.status === 201,
    `status=${aliceUpload.status} repo=${aliceUpload.json?.card?.repoName ?? '?'}`);

  const orphanUpload = await call('/api/cards?cardId=orphan-card', {
    method: 'POST',
    body: namedCard('未归属的卡'),
    token: legacyToken,
    raw: true,
  });
  check('legacy 上传的卡是「未归属」', orphanUpload.status === 201,
    `owner=${JSON.stringify(orphanUpload.json?.card?.repoName)}`);

  // ── 1. legacy 降权：看不见账户的卡，看得见未归属的卡 ────────
  const legacyList = await call('/api/cards?limit=100', { token: legacyToken });
  const legacyIds = (legacyList.json?.items ?? []).map((item) => item.cardId);
  check('legacy 列表不含账户的卡', !legacyIds.includes('alice-card'), JSON.stringify(legacyIds));
  check('legacy 列表含未归属的卡', legacyIds.includes('orphan-card'), JSON.stringify(legacyIds));
  check('legacy 列表条数 = 服务端返回的 total', legacyList.json?.total === legacyIds.length,
    `total=${legacyList.json?.total} items=${legacyIds.length}`);

  // ── 2. 跨账户读取：一律 404，且与"不存在"形状完全一致 ────────
  //
  // 比较方式要斟酌：404 会把**调用方自己传的 id** 回显在 message 里，
  // 所以两次不同 id 的响应天然不会逐字节相等。真正要证的是
  // 「除回显的 id 之外，其余部分一字不差」—— 把 id 归一化后再比。
  // 如果哪天有人给"不属于你"加了额外字段或不同文案，归一化后仍会不等。
  const normalizeId = (text, id) => text.split(id).join('<ID>');

  const legacyPeek = await call('/api/cards/alice-card', { token: legacyToken });
  const legacyMissing = await call('/api/cards/no-such-card-xyz', { token: legacyToken });
  check('legacy 读账户的卡 → 404', legacyPeek.status === 404, `status=${legacyPeek.status}`);
  check(
    '404 与「不存在」除回显 id 外逐字节相同',
    normalizeId(legacyPeek.text, 'alice-card') === normalizeId(legacyMissing.text, 'no-such-card-xyz'),
    `peek=${legacyPeek.text.replace(/\s+/g, ' ').slice(0, 80)}`,
  );

  const legacyVersions = await call('/api/cards/alice-card/versions', { token: legacyToken });
  check('legacy 读账户卡的版本 → 404', legacyVersions.status === 404, `status=${legacyVersions.status}`);
  const legacyRaw = await call('/api/cards/alice-card/raw', { token: legacyToken });
  check('legacy 读账户卡的原文 → 404', legacyRaw.status === 404, `status=${legacyRaw.status}`);

  const legacyOwn = await call('/api/cards/orphan-card', { token: legacyToken });
  check('legacy 读未归属的卡 → 200', legacyOwn.status === 200, `status=${legacyOwn.status}`);

  // ── 3. 账户侧：看自己的、看不到未归属的 ────────────────────
  const aliceList = await call('/api/cards?limit=100', { token: aliceToken });
  const aliceIds = (aliceList.json?.items ?? []).map((item) => item.cardId);
  check('账户列表含自己的卡', aliceIds.includes('alice-card'), JSON.stringify(aliceIds));
  check('账户列表不含未归属的卡', !aliceIds.includes('orphan-card'), JSON.stringify(aliceIds));

  const alicePeekOrphan = await call('/api/cards/orphan-card', { token: aliceToken });
  const aliceMissing = await call('/api/cards/no-such-card-xyz', { token: aliceToken });
  check('账户读未归属的卡 → 404', alicePeekOrphan.status === 404, `status=${alicePeekOrphan.status}`);
  check('账户侧 404 也与「不存在」同形', 
    normalizeId(alicePeekOrphan.text, 'orphan-card') === normalizeId(aliceMissing.text, 'no-such-card-xyz'),
    `peek=${alicePeekOrphan.text.replace(/\s+/g, ' ').slice(0, 80)}`);

  // ── 4. 跨账户写入：不能"借"别人的 ID ──────────────────────
  const legacyHijack = await call('/api/cards?cardId=alice-card', {
    method: 'POST',
    body: namedCard('劫持写入'),
    token: legacyToken,
    raw: true,
  });
  check('legacy 用账户的 cardId 上传 → 404（不能跨账户写）', legacyHijack.status === 404,
    `status=${legacyHijack.status}`);
  const aliceAfter = await call('/api/cards/alice-card/versions', { token: aliceToken });
  check('账户卡的版本数没被污染', aliceAfter.json?.total === 1, `total=${aliceAfter.json?.total}`);
  const aliceName = await call('/api/cards/alice-card', { token: aliceToken });
  check('账户卡的内容没被改写', aliceName.json?.name === '爱丽丝的卡', aliceName.json?.name);

  // ── 5. stats：计数跟着凭证走 + isolationEnforced ───────────
  const legacyStats = await call('/api/stats', { token: legacyToken });
  const aliceStats = await call('/api/stats', { token: aliceToken });
  check('stats 下发 isolationEnforced: true', legacyStats.json?.isolationEnforced === true,
    String(legacyStats.json?.isolationEnforced));
  check('legacy stats 只统计未归属卡片', legacyStats.json?.cards === 1, `cards=${legacyStats.json?.cards}`);
  check('账户 stats 只统计自己的卡片', aliceStats.json?.cards === 1, `cards=${aliceStats.json?.cards}`);
  check('legacy stats 标了 scope.kind = unowned', legacyStats.json?.scope?.kind === 'unowned',
    JSON.stringify(legacyStats.json?.scope));
  check('账户 stats 标了 scope.kind = owner', aliceStats.json?.scope?.kind === 'owner',
    JSON.stringify(aliceStats.json?.scope));

  // ── 6. 事件流也过滤（否则等于绕一层读别人的卡 id）──────────
  const legacyEvents = await call('/api/events?limit=200', { token: legacyToken });
  const aliceEvents = await call('/api/events?limit=200', { token: aliceToken });
  const legacyEventCards = (legacyEvents.json?.items ?? []).map((item) => item.cardId).filter(Boolean);
  const aliceEventCards = (aliceEvents.json?.items ?? []).map((item) => item.cardId).filter(Boolean);
  check('legacy 事件里不含账户的卡 id', !legacyEventCards.includes('alice-card'),
    JSON.stringify([...new Set(legacyEventCards)].slice(0, 5)));
  check('账户事件里不含未归属卡 id', !aliceEventCards.includes('orphan-card'),
    JSON.stringify([...new Set(aliceEventCards)].slice(0, 5)));

  // ── 7. 仓库令牌：范围再收窄到单个仓库 ─────────────────────
  const repos = await call('/api/repos', { token: aliceToken });
  const defaultRepo = (repos.json?.items ?? []).find((item) => item.isDefault) ?? repos.json?.items?.[0];
  check('账户有默认仓库', defaultRepo !== undefined, defaultRepo?.name ?? '(无)');

  const issued = await call(`/api/repos/${String(defaultRepo?.id)}/tokens`, {
    method: 'POST',
    body: { name: '冒烟读令牌', scopes: ['read'] },
    token: aliceToken,
  });
  check('签发仓库读令牌（原文只出现一次）', issued.status === 201 && typeof issued.json?.token === 'string',
    `status=${issued.status} note=${issued.json?.note ? '有' : '无'}`);
  const repoToken = issued.json?.token ?? '';

  const repoTokensList = await call('/api/cards?limit=100', { token: repoToken });
  const repoIds = (repoTokensList.json?.items ?? []).map((item) => item.cardId);
  check('仓库令牌能看到本仓库的卡', repoIds.includes('alice-card'), JSON.stringify(repoIds));
  check('仓库令牌看不到未归属的卡', !repoIds.includes('orphan-card'), JSON.stringify(repoIds));
  const repoStats = await call('/api/stats', { token: repoToken });
  check('仓库令牌 stats 标了 repoId', repoStats.json?.scope?.repoId === defaultRepo?.id,
    JSON.stringify(repoStats.json?.scope));

  // ── 8. adopt 之后 legacy 就看不见了 ───────────────────────
  //
  // 注意 `tcs-server user adopt <用户名>` 是**批量**动作：把当前所有
  // `owner_id = ''` 的卡一次划给该账户（它的语义就是"接管历史遗留数据"）。
  // 所以 adopt 之后 legacy 应该**一张都看不到**，而不是少一张。
  const adoptUpload = await call('/api/cards?cardId=adopt-me', {
    method: 'POST',
    body: namedCard('等着被接管'),
    token: legacyToken,
    raw: true,
  });
  check('legacy 再造一张未归属卡', adoptUpload.status === 201, `status=${adoptUpload.status}`);
  const beforeAdopt = await call('/api/cards?limit=100', { token: legacyToken });
  const beforeIds = (beforeAdopt.json?.items ?? []).map((item) => item.cardId);
  check('adopt 前 legacy 能看到它（还有之前那张）',
    beforeIds.includes('adopt-me') && beforeIds.includes('orphan-card'), JSON.stringify(beforeIds));

  const adoptCode = await runCli(['user', 'adopt', 'alice', '--config', configPath]);
  check('CLI adopt 执行成功', adoptCode === 0, `exit=${String(adoptCode)}`);

  const afterAdoptLegacy = await call('/api/cards?limit=100', { token: legacyToken });
  const afterAdoptIds = (afterAdoptLegacy.json?.items ?? []).map((item) => item.cardId);
  check('adopt 后 legacy 一张都看不到（批量接管了全部未归属卡片）',
    afterAdoptIds.length === 0, JSON.stringify(afterAdoptIds));
  check('adopt 后 legacy 的 stats 归零', (await call('/api/stats', { token: legacyToken })).json?.cards === 0, '');

  const afterAdoptAlice = await call('/api/cards?limit=100', { token: aliceToken });
  const afterAdoptAliceIds = (afterAdoptAlice.json?.items ?? []).map((item) => item.cardId);
  check('adopt 后账户能看到被接管的卡', afterAdoptAliceIds.includes('adopt-me'), JSON.stringify(afterAdoptAliceIds));
  check('adopt 后账户也能看到更早那张未归属卡', afterAdoptAliceIds.includes('orphan-card'),
    JSON.stringify(afterAdoptAliceIds));
  const adoptCard = await call('/api/cards/adopt-me', { token: aliceToken });
  check('adopt 后账户能读到内容', adoptCard.status === 200 && adoptCard.json?.name === '等着被接管',
    `status=${adoptCard.status} name=${adoptCard.json?.name}`);
  check('adopt 的卡进了默认仓库（不是「未归属仓库」）', adoptCard.json?.repoName === defaultRepo?.name,
    `repoName=${adoptCard.json?.repoName ?? '(null)'}`);

  const adoptRepoToken = await call('/api/cards?limit=100', { token: repoToken });
  check('adopt 的卡也进了默认仓库（仓库令牌可见）',
    (adoptRepoToken.json?.items ?? []).some((item) => item.cardId === 'adopt-me'),
    JSON.stringify((adoptRepoToken.json?.items ?? []).map((item) => item.cardId)));

  // ── 9. legacy 的运维用途没被废掉：新建的未归属卡照样可见 ────
  const fresh = await call('/api/cards?cardId=after-adopt-orphan', {
    method: 'POST',
    body: namedCard('adopt 之后新建的未归属卡'),
    token: legacyToken,
    raw: true,
  });
  check('adopt 之后 legacy 仍能新建卡', fresh.status === 201, `status=${fresh.status}`);
  const legacyFinal = await call('/api/cards?limit=100', { token: legacyToken });
  const finalIds = (legacyFinal.json?.items ?? []).map((item) => item.cardId);
  check('legacy 仍看得到自己新建的未归属卡（降权不等于废掉）',
    finalIds.length === 1 && finalIds[0] === 'after-adopt-orphan', JSON.stringify(finalIds));
} finally {
  child.kill();
  await delay(300);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* Windows 偶发占用，留给系统清理 */
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${String(results.length - failed.length)}/${String(results.length)} 通过`);
  if (failed.length > 0) process.exitCode = 1;
}
