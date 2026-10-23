/**
 * 探针：短 sha 与"版本序号"的解析冲突。
 *
 * 怀疑点：`resolveVersion` 先判 `/^\d+$/` → 当成序号；而 git 提交 sha 是十六进制，
 * 八位里全是 0-9 的概率是 (10/16)^8 ≈ 2.3%，四位约 15%。
 * 也就是说「按短 sha 取版本」这条公开用法，会以固定概率直接 404。
 *
 * 这个探针不靠概率碰运气：它直接问服务端「这个 sha 当作 rev 能不能解析」，
 * 并把该卡的版本列表一并打出来，好确认 sha 确实存在、只是被当成了序号。
 *
 * 用法：node scripts/probe-shortsha.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'tcs-shortsha-'));
const port = 19800 + Math.floor(Math.random() * 60);
const token = 'probe-global-token-aaaaaaaaaaaaaaaaaaaa';

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
      logLevel: 'error',
      auth: {
        token,
        require: true,
        publicPaths: ['/api/health'],
        registerMode: 'closed',
        jwtSecret: 'unit-test-jwt-secret-aaaaaaaaaaaaaaaaaaaaaaaa',
      },
      tls: { mode: 'off', httpsPort: port + 1000, certPath: '', keyPath: '' },
      service: { mode: 'process', name: 'P', displayName: 'P', autoStart: false },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);

const child = spawn(process.execPath, ['server/dist/index.js', 'worker', '--config', join(work, 'config.json')], {
  cwd: REPO,
  stdio: 'ignore',
});
const base = `http://127.0.0.1:${String(port)}`;

async function call(path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

try {
  // 等服务端
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) break;
    } catch {
      /* 还没起 */
    }
    await delay(150);
  }

  const bytes = readFileSync(join(REPO, 'test', 'fixtures', 'sample-card.json'), 'utf8');
  const created = await call('/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bytes,
  });
  const cardId = created.json?.card?.id;
  console.log(`卡片：${cardId}`);

  // 造若干个版本，收集它们的 commit sha
  const shas = [created.json?.version?.commit];
  for (let i = 2; i <= 6; i += 1) {
    const bumped = bytes.replace('"name": "林晚照"', `"name": "林晚照${String(i)}"`);
    const res = await call(`/api/cards/${cardId}/versions?message=v${String(i)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bumped,
    });
    if (res.status === 201) shas.push(res.json?.commit);
  }

  console.log('\n=== 逐个 sha 当前缀使用（长度 4 / 8）===');
  let digitOnly = 0;
  for (const sha of shas) {
    if (!sha) continue;
    const p8 = sha.slice(0, 8);
    const p4 = sha.slice(0, 4);
    const r8 = await call(`/api/cards/${cardId}/versions/${p8}`);
    const r4 = await call(`/api/cards/${cardId}/versions/${p4}`);
    const isDigit8 = /^\d+$/.test(p8);
    if (isDigit8) digitOnly += 1;
    console.log(
      `${sha.slice(0, 12)}… 前缀8=${p8}${isDigit8 ? '(纯数字!)' : ''} → ${String(r8.status)}` +
        `  前缀4=${p4}${/^\d+$/.test(p4) ? '(纯数字!)' : ''} → ${String(r4.status)}`,
    );
    if (r8.status !== 200) console.log(`    错误体：${JSON.stringify(r8.json?.error ?? r8.json)}`);
    if (r4.status !== 200) console.log(`    错误体：${JSON.stringify(r4.json?.error ?? r4.json)}`);
  }

  // 关键实证：直接拿一个「纯数字 sha」当 rev，看服务端把它当什么
  const digitSha = shas.find((sha) => sha && /^\d+$/.test(sha.slice(0, 8)));
  console.log('\n=== 结论 ===');
  if (digitSha) {
    console.log(`存在纯数字 8 位前缀的提交：${digitSha.slice(0, 8)}`);
    const r = await call(`/api/cards/${cardId}/versions/${digitSha.slice(0, 8)}`);
    console.log(`查询结果 ${String(r.status)}：${JSON.stringify(r.json?.error ?? r.json).slice(0, 200)}`);
  } else {
    console.log(`本次 ${String(shas.length)} 个提交里没有纯数字 8 位前缀（概率约 2.3%/个）。`);
    console.log('为稳定复现，用一个"数字型序号"验证语义：/versions/999 应报「版本不存在」而不是「提交不存在」。');
    const r = await call(`/api/cards/${cardId}/versions/999`);
    console.log(`  /versions/999 → ${String(r.status)}：${JSON.stringify(r.json?.error ?? r.json).slice(0, 160)}`);
  }
} finally {
  child.kill();
  await delay(300);
  rmSync(work, { recursive: true, force: true });
}
