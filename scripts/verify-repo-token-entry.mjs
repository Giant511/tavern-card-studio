#!/usr/bin/env node
/**
 * 仓库令牌连接入口的端到端冒烟（v0.1.3 / F5 后半）。
 *
 * ## 为什么单测之外还要这一层
 *
 * 单测直接调 `verifyRepoTokenEntry`，绕过了 HTTP 层与 TokenGate 的豁免列表。
 * 而这次改动**恰好动了那个豁免列表**（`/api/auth/repo-token` 必须免鉴权）：
 * 豁免没加上时单测全绿、真机全 401 —— 这种错只有真发一次请求才看得见。
 *
 * ## 测什么
 *
 *   1. 端点免鉴权（不带任何凭证也能调）
 *   2. 成功路径：返回绑定的仓库与范围，`tokenType` 明确不是账户会话
 *   3. `lastUsedAt` 会被记上（第二次调用能看到）
 *   4. `GET /api/auth/me` 对仓库令牌如实报 `via:'repo-token'`（上一版错报 'jwt'）
 *   5. 已吊销 → 401 TOKEN_REVOKED
 *   6. 不存在 → 401 TOKEN_INVALID，且与"仓库已删"那条**响应逐字节相同**
 *   7. 格式错误 → 400 TOKEN_FORMAT_INVALID
 *
 * 只比状态码不够：文案或字段差一点，就退化成"这把令牌存在但不是你的"的枚举器
 * （与 `smoke-t108.mjs` 判 404 同一条道理）。
 *
 * 用法：node scripts/verify-repo-token-entry.mjs
 * 退出码：0 全通过；1 有断言失败
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, okValue, detail) => {
  results.push({ name, ok: okValue, detail });
  console.log(`${okValue ? '✔' : '✘'} ${name}${detail === undefined || detail === '' ? '' : ` —— ${detail}`}`);
};

const work = mkdtempSync(join(tmpdir(), 'tcs-repo-token-e2e-'));
const port = 20600 + Math.floor(Math.random() * 100);
const legacyToken = 'repo-token-e2e-legacy-aaaaaaaaaaaaaaaa';

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
        jwtSecret: 'repo-token-e2e-secret-aaaaaaaaaaaaaaaaaaaa',
      },
      tls: { mode: 'off', httpsPort: port + 1000, certPath: '', keyPath: '' },
      service: { mode: 'process', name: 'RTE', displayName: 'RTE', autoStart: false },
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
child.stderr.on('data', (chunk) => process.stderr.write(`[srv] ${String(chunk)}`));

const base = `http://127.0.0.1:${String(port)}`;

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = { Accept: 'application/json' };
  if (token !== undefined && token !== null) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

/** 发一把令牌；失败时返回 null 并记一条失败（后续断言会连带暴露） */
async function issue(accessToken, repoId, name, scopes, extra = {}) {
  const response = await call(`/api/repos/${repoId}/tokens`, {
    method: 'POST',
    token: accessToken,
    body: { name, scopes, ...extra },
  });
  const raw = response.json?.token;
  if (typeof raw !== 'string' || !raw.startsWith('tcr_')) {
    check(`签发令牌 ${name}`, false, response.text.slice(0, 160));
    return null;
  }
  return raw;
}

try {
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
  if (!up) throw new Error('服务端没起来');

  // ── 1. 免鉴权 ─────────────────────────────────────────
  const anon = await call('/api/auth/repo-token', { method: 'POST', body: { token: 'tcr_short' } });
  check(
    '不带凭证也能调用（400 而非 401，说明没过 TokenGate）',
    anon.status === 400,
    `实际 ${String(anon.status)}：${anon.text.slice(0, 120)}`,
  );
  check('格式错误码为 TOKEN_FORMAT_INVALID', anon.json?.error?.code === 'TOKEN_FORMAT_INVALID', JSON.stringify(anon.json?.error));

  // ── 准备 ───────────────────────────────────────────────
  const reg = await call('/api/auth/register', {
    method: 'POST',
    body: { username: 'alice', password: 'Passw0rd!-alice-1234' },
  });
  const access = reg.json?.accessToken;
  check('注册并登录账户', typeof access === 'string' && access !== '', reg.text.slice(0, 160));
  if (typeof access !== 'string') throw new Error('无法继续');

  const repos = await call('/api/repos', { token: access });
  const repo = (repos.json?.items ?? [])[0];
  check('账户有默认仓库', repo !== undefined, JSON.stringify(repos.json?.items?.map?.((r) => r.name) ?? []));
  if (repo === undefined) throw new Error('无法继续');

  // ── 2. 成功路径 ────────────────────────────────────────
  const rawToken = await issue(access, repo.id, 'e2e-read', ['read']);
  check('签发令牌', rawToken !== null);
  if (rawToken !== null) {
    const good = await call('/api/auth/repo-token', { method: 'POST', body: { token: rawToken } });
    check('有效令牌 200', good.status === 200, `实际 ${String(good.status)}：${good.text.slice(0, 160)}`);
    check('返回绑定的仓库 id', good.json?.repo?.id === repo.id);
    check('返回仓库名', good.json?.repo?.name === repo.name, String(good.json?.repo?.name));
    check('返回范围 read', JSON.stringify(good.json?.scopes) === JSON.stringify(['read']), JSON.stringify(good.json?.scopes));
    check('tokenType 明确不是账户会话', good.json?.tokenType === 'RepoToken', String(good.json?.tokenType));

    // ── 3. lastUsedAt ──────────────────────────────────
    const again = await call('/api/auth/repo-token', { method: 'POST', body: { token: rawToken } });
    check(
      'lastUsedAt 被记上（说明 touch 生效）',
      typeof again.json?.lastUsedAt === 'string' && again.json.lastUsedAt !== '',
      String(again.json?.lastUsedAt),
    );

    // ── 4. /api/auth/me 的 via ─────────────────────────
    const me = await call('/api/auth/me', { token: rawToken });
    check('/api/auth/me 接受仓库令牌', me.status === 200, String(me.status));
    check("via 如实报 'repo-token'", me.json?.via === 'repo-token', String(me.json?.via));
    check('/me 带回绑定的仓库', me.json?.repo?.id === repo.id, JSON.stringify(me.json?.repo));
  }

  // ── 5. 已吊销 ──────────────────────────────────────────
  const revokedRaw = await issue(access, repo.id, 'e2e-revoke', ['read']);
  if (revokedRaw !== null) {
    const list = await call(`/api/repos/${repo.id}/tokens`, { token: access });
    const target = (list.json?.items ?? []).find((item) => item.name === 'e2e-revoke');
    await call(`/api/tokens/${String(target?.id ?? '')}`, { method: 'DELETE', token: access });
    const revoked = await call('/api/auth/repo-token', { method: 'POST', body: { token: revokedRaw } });
    check('已吊销返回 401', revoked.status === 401, String(revoked.status));
    check('错误码 TOKEN_REVOKED', revoked.json?.error?.code === 'TOKEN_REVOKED', JSON.stringify(revoked.json?.error));
  }

  // ── 6. 不枚举 ──────────────────────────────────────────
  /*
   * 判据是「不带令牌的人看不出差别」，所以这里比的是**两把不存在的令牌**：
   * 响应必须逐字节相同 —— 若服务端对"长得像真令牌"的输入给了不同回应，
   * 就等于开了一个存在性探针。控制字符全用 Z，避免与真实令牌撞车。
   */
  const missingA = await call('/api/auth/repo-token', { method: 'POST', body: { token: `tcr_${'Z'.repeat(43)}` } });
  const missingB = await call('/api/auth/repo-token', { method: 'POST', body: { token: `tcr_${'Q'.repeat(43)}` } });
  check('不存在的令牌返回 401', missingA.status === 401, String(missingA.status));
  check('错误码 TOKEN_INVALID', missingA.json?.error?.code === 'TOKEN_INVALID', JSON.stringify(missingA.json?.error));
  check(
    '两把不同的不存在令牌 → 响应逐字节相同（无存在性探针）',
    missingA.text === missingB.text,
    missingA.text === missingB.text ? '' : `\n    A: ${missingA.text}\n    B: ${missingB.text}`,
  );

  /*
   * 另一条真实路径的实测结论（写下来免得下次误判）：
   * 删掉仓库时服务端会**级联吊销**该仓库的令牌（`removeWithTransfer` 返回
   * `revokedTokens`），所以"仓库已删但令牌没吊销"这条路径**通过 API 走不到** ——
   * 拿着那把令牌会得到「已吊销」，那是诚实答案，不是泄露。
   *
   * 因此这里断言的是"删仓库 → 令牌失效"，而不是"仓库已删 ≡ 不存在"；
   * 后者（真正的 invalid 合并）已由 test/repo-token-entry.test.mjs 用直接改库的
   * 方式钉住，因为那条路径只在库被手工改动时才可能出现。
   */
  const tmpRepo = await call('/api/repos', { method: 'POST', token: access, body: { name: 'e2e-tmp-repo' } });
  const tmpId = tmpRepo.json?.repo?.id ?? tmpRepo.json?.id;
  if (typeof tmpId === 'string' && tmpId !== '') {
    const orphanRaw = await issue(access, tmpId, 'e2e-orphan', ['read']);
    const removed = await call(`/api/repos/${tmpId}`, { method: 'DELETE', token: access });
    check('临时仓库已删', removed.status === 200, String(removed.status));
    check('删除仓库会级联吊销其令牌', (removed.json?.revokedTokens ?? 0) >= 1, String(removed.json?.revokedTokens));
    if (orphanRaw !== null) {
      const orphan = await call('/api/auth/repo-token', { method: 'POST', body: { token: orphanRaw } });
      check('仓库已删的令牌失效（401）', orphan.status === 401, String(orphan.status));
      check(
        '按设计给出「已吊销」而不是「不存在」',
        orphan.json?.error?.code === 'TOKEN_REVOKED',
        JSON.stringify(orphan.json?.error?.code),
      );
    }
  } else {
    check('建临时仓库', false, tmpRepo.text.slice(0, 160));
  }
} catch (error) {
  check('冒烟脚本无异常', false, error instanceof Error ? error.message : String(error));
} finally {
  try {
    child.kill();
  } catch {
    /* 已退出 */
  }
  await delay(400);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* Windows 上偶尔删不掉，不影响结论 */
  }
}

const passed = results.filter((item) => item.ok).length;
const failures = results.filter((item) => !item.ok);
console.log(`\n合计：${String(passed)}/${String(results.length)} 通过`);
if (failures.length > 0) {
  console.log('结论：未通过');
  process.exit(1);
}
console.log('结论：通过');
