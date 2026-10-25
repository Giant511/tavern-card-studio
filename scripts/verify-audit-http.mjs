#!/usr/bin/env node
/**
 * 审计双样本的**真实服务端**冒烟（v0.1.3 收尾）。
 *
 * 与 `scripts/verify-audit-dual-sample.mjs` 的分工：
 *   · 那份是**离线**直调 `AuditService.run(bytes)`，验的是判断逻辑本身；
 *   · 这份起一个真 worker，把**同一对字节** POST 到 `/api/audit`，验的是
 *     "HTTP 这一层有没有把结论原样送出来" —— 请求体解析、鉴权、报告序列化、
 *     响应头，任何一环掉链子，离线脚本都还是绿的。
 *
 * 两份脚本共用 `buildDualSamples()`：样本只造一次，所以"离线绿、HTTP 红"时
 * 一定是实现或传输层的问题，不会是"两边喂的根本不是同一对卡"。
 *
 * 判据（与离线版对齐，但只留能在 HTTP 上看出来的）：
 *   · 六板块旧卡：200 + `builtin:legacy-six-block` 恰好一条 info + error = 0 + 可导出；
 *   · 八板块新卡：200 + **没有** legacy 提示 + error = 0；
 *   · 响应头 `X-TCS-Audit-Source: ad-hoc`（证明走的是临时审计而非缓存路径）。
 *
 * 用法：npm run build:server && node scripts/verify-audit-http.mjs
 * 退出码：0 全绿；1 有断言失败
 */

import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildDualSamples } from './verify-audit-dual-sample.mjs';

const REPO = process.cwd();
const STAMP = `${String(Date.now())}-${String(process.pid)}`;
const WORK = join(REPO, '.verify', 'audit-http', `run-${STAMP}`);
const TOKEN = 'audit-http-token-eeeeeeeeeeeeeeeeeeeeee';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  OK   ${name}${detail === '' ? '' : `  [${detail}]`}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail === '' ? '' : `  [${detail}]`}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const PORT = await freePort();
const DATA_DIR = join(WORK, 'data');
const CONFIG = join(WORK, 'config.json');
mkdirSync(DATA_DIR, { recursive: true });

const now = new Date().toISOString();
writeFileSync(
  CONFIG,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      port: PORT,
      controlPort: await freePort(),
      host: '127.0.0.1',
      controlHost: '127.0.0.1',
      dataDir: DATA_DIR.replace(/\\/g, '/'),
      rulesDir: join(REPO, 'rules').replace(/\\/g, '/'),
      defaultPlatformRule: 'sillytavern',
      defaultPreset: 'default',
      maxUploadBytes: 33_554_432,
      logLevel: 'error',
      auth: {
        token: TOKEN,
        require: true,
        publicPaths: ['/api/health'],
        registerMode: 'closed',
        jwtSecret: 'audit-http-secret-eeeeeeeeeeeeeeeeeeeee',
      },
      tls: { mode: 'off', httpsPort: await freePort(), certPath: '', keyPath: '' },
      service: { mode: 'process', name: 'AUDITHTTP', displayName: 'AUDITHTTP', autoStart: false },
      trash: { retentionDays: 30 },
      createdAt: now,
      updatedAt: now,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const child = spawn(process.execPath, ['server/dist/index.js', 'worker', '--config', CONFIG], {
  cwd: REPO,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '' },
});
let serverLog = '';
child.stdout.on('data', (chunk) => {
  serverLog += String(chunk);
});
child.stderr.on('data', (chunk) => {
  serverLog += String(chunk);
});

async function cleanup() {
  try {
    child.kill('SIGTERM');
  } catch {
    /* 已退 */
  }
  await new Promise((resolve) => setTimeout(resolve, 800));
  try {
    child.kill('SIGKILL');
  } catch {
    /* 同上 */
  }
}

async function postAudit(bytes, label) {
  const response = await fetch(`http://127.0.0.1:${String(PORT)}/api/audit`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'X-TCS-Filename': label,
    },
    body: bytes,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, json, text };
}

async function waitReady() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(PORT)}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`worker 未就绪：\n${serverLog.slice(-1500)}`);
}

try {
  console.log(`\n审计双样本 · 真实服务端冒烟（worker 127.0.0.1:${String(PORT)}）`);
  await waitReady();

  const sample = buildDualSamples();
  console.log(`  样本：旧格式 ${String(sample.legacyBytes.byteLength)} 字节 / 新格式 ${String(sample.newBytes.byteLength)} 字节`);

  // ── 旧六板块卡 ──
  const legacy = await postAudit(sample.legacyBytes, 'legacy-six-block.json');
  check('旧卡：HTTP 200', legacy.status === 200, String(legacy.status));
  check('旧卡：响应用 ad-hoc 审计路径', legacy.headers.get('x-tcs-audit-source') === 'ad-hoc', String(legacy.headers.get('x-tcs-audit-source')));
  const legacyIssues = legacy.json?.issues ?? [];
  const legacyNotice = legacyIssues.filter((issue) => issue.ruleId === 'builtin:legacy-six-block');
  check('旧卡：error = 0（铁律）', legacy.json?.summary?.error === 0, String(legacy.json?.summary?.error));
  check('旧卡：判为可导出', legacy.json?.summary?.exportable === true, String(legacy.json?.summary?.exportable));
  check('旧卡：恰好一条「旧格式卡片」提示', legacyNotice.length === 1, `实际 ${String(legacyNotice.length)} 条`);
  check(
    '旧卡：提示级别是 info',
    legacyNotice[0]?.severity === 'info',
    String(legacyNotice[0]?.severity),
  );
  check(
    '旧卡：不逐条报板块缺失',
    legacyIssues.filter((issue) => issue.ruleId === 'builtin:block-missing').length === 0,
  );

  // ── 新八板块卡 ──
  const fresh = await postAudit(sample.newBytes, 'eight-block.json');
  check('新卡：HTTP 200', fresh.status === 200, String(fresh.status));
  const freshIssues = fresh.json?.issues ?? [];
  check('新卡：error = 0', fresh.json?.summary?.error === 0, String(fresh.json?.summary?.error));
  check(
    '新卡：**不**出现「旧格式卡片」提示',
    freshIssues.filter((issue) => issue.ruleId === 'builtin:legacy-six-block').length === 0,
  );

  // ── 反向确认 HTTP 层没有偷偷兜底：空请求体必须被拒 ──
  const empty = await fetch(`http://127.0.0.1:${String(PORT)}/api/audit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: '',
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  check('空请求体被拒（400，不是 200 空报告）', empty.status === 400, String(empty.status));
} catch (error) {
  failed += 1;
  console.log(`\n运行中抛错：${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await cleanup();
}

console.log(`\n结果：${String(passed)} 项通过，${String(failed)} 项失败`);
if (failed > 0) {
  console.log(`worker 日志尾部：\n${serverLog.slice(-1500)}`);
  process.exit(1);
}
try {
  rmSync(join(WORK, 'data'), { recursive: true, force: true });
} catch {
  /* .verify 不入库，清不掉也无所谓 */
}
process.exit(0);
