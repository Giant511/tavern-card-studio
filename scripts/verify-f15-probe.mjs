/**
 * F15 探测取证：**"不发 CORS 头"到底会不会让 `no-cors` 的 fetch 失败**。
 *
 * ## 这个脚本回答的是什么
 *
 * 生产缺陷（2026-10-26）报的是"ST 在跑，客户端判未运行"，初判根因是
 * "ST 不发 CORS 头，webview 的 fetch 被拦"。但 26407bd 里探测**本来就是**
 * `mode: 'no-cors'` —— 所以那个解释站不住。这个脚本把四种写法放在
 * **同一个跨源场景**里实测一遍，把"到底哪种会失败"钉死：
 *
 *   · 页面源用 `http://tauri.localhost:<port>`（Tauri 在 Windows 上的源，
 *     与目标 `http://127.0.0.1:8000` **跨源**）；
 *   · 目标服务**不发任何 `Access-Control-*` 头**（真实 SillyTavern 就这样）。
 *
 * 结论（本机 Chromium 155 实测）：`no-cors` 拿到 opaque 响应 = 成功；
 * 默认 `cors` 才 reject。也就是说 CORS 不是那次误报的成因，
 * 真正的原因是请求根本没出浏览器网络层（代理 / 安全软件 / 本地网络权限）——
 * 判据因此改到壳侧 TCP（决策 #207 / #208）。
 *
 * ## 用法
 *
 *   node scripts/verify-f15-probe.mjs
 *
 * 需要本机有 Chrome（路径与 `capture-e2e-dumps.sh` 同一套探测顺序）。
 * 退出码：0 = 四种写法的表现与预期一致；1 = 不一致（说明浏览器行为变了，
 * 决策 #207 的前提要重估）。
 *
 * ## 为什么这份脚本手工跑、不进 npm test
 *
 * 它要起 headless Chrome 抓一次真实浏览器的行为 —— `npm test` 里没有浏览器。
 * 已在 `scripts/lib/verify-inventory.mjs` 登记为 `browser-dump`。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 目标服务：**刻意不发** Access-Control-* 头（真实 ST 就是这样） */
function startNoCorsTarget(port) {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>no-cors target</title><h1>no cors headers</h1>');
  });
  return new Promise((resolvePromise) => {
    server.listen(port, '127.0.0.1', () => resolvePromise(server));
  });
}

function freePort() {
  return new Promise((resolvePromise) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePromise(port));
    });
  });
}

const PAGE = (targetPort) => `<!doctype html>
<html><head><meta charset="utf-8"><title>pending</title></head>
<body><pre id="out">running…</pre>
<script>
const TARGET = 'http://127.0.0.1:${targetPort}/';
const CASES = [
  ['no-cors + no-store（线上实现）', { mode: 'no-cors', cache: 'no-store' }],
  ['no-cors', { mode: 'no-cors' }],
  ['cors（默认）', { mode: 'cors' }],
  ['默认', {}],
];
(async () => {
  const lines = [];
  for (const [label, init] of CASES) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(TARGET, { ...init, signal: controller.signal });
      lines.push(label + ' → OK type=' + response.type + ' status=' + response.status);
    } catch (error) {
      lines.push(label + ' → ERR name=' + error.name + ' message=' + error.message);
    } finally {
      clearTimeout(timer);
    }
  }
  document.getElementById('out').textContent = lines.join('\\n');
  document.title = 'done';
})();
</script></body></html>`;

function runChrome(chrome, url, userDataDir, extraArgs = []) {
  return new Promise((resolvePromise) => {
    const child = spawn(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--no-first-run',
        `--user-data-dir=${userDataDir}`,
        '--virtual-time-budget=8000',
        ...extraArgs,
        '--dump-dom',
        url,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('close', () => resolvePromise(out));
  });
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'} ${name}${detail === undefined ? '' : `  — ${detail}`}`);
};

async function main() {
  const chrome = findChrome();
  if (chrome === null) {
    console.error('[SKIP] 找不到 Chrome —— 这个脚本要真实浏览器才能断 CORS 行为');
    process.exitCode = 2;
    return;
  }

  const targetPort = await freePort();
  const pagePort = await freePort();
  const target = await startNoCorsTarget(targetPort);

  const work = mkdtempSync(join(tmpdir(), 'tcs-f15-probe-'));

  // 页面源用 tauri.localhost（Tauri 在 Windows 上的 origin）。hosts 里不一定有这个名字，
  // 用 Chrome 的 --host-resolver-rules 把它指到 127.0.0.1 —— 这样 `location.origin`
  // 就是真实那个，跨源关系与壳里一致。
  const pageServer = await new Promise((resolvePromise) => {
    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE(targetPort));
    });
    server.listen(pagePort, '127.0.0.1', () => resolvePromise(server));
  });

  console.log(`页面源：http://tauri.localhost:${pagePort}`);
  console.log(`目标：http://127.0.0.1:${targetPort}（不发 Access-Control-* 头）\n`);

  const dom = await runChrome(
    chrome,
    `http://tauri.localhost:${pagePort}/index.html`,
    join(work, 'profile'),
    ['--host-resolver-rules=MAP tauri.localhost 127.0.0.1'],
  );

  const block = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
  const text = block === null ? '' : block[1];
  if (text.trim() === '' || text.includes('running…')) {
    console.error('[FAIL] 页面没跑完（拿不到探测结果）—— 可能 Chrome 参数或 --dump-dom 行为变了');
    console.error(dom.slice(0, 600));
    process.exitCode = 1;
    await new Promise((r) => pageServer.close(r));
    await new Promise((r) => target.close(r));
    rmSync(work, { recursive: true, force: true });
    return;
  }

  for (const line of text.split('\n').filter((item) => item.trim() !== '')) console.log(`  ${line}`);
  console.log('');

  check('no-cors 能拿到响应（opaque）', /no-cors.*→ OK type=opaque/.test(text), '这是线上实现的写法');
  check('no-cors + no-store 能拿到响应', /no-cors \+ no-store.*→ OK type=opaque/.test(text));
  check(
    '默认 cors 会失败（证明"CORS 头缺失"只在 cors 模式下才是问题）',
    /cors（默认）.*→ ERR name=TypeError/.test(text),
  );
  check(
    '结论：CORS 头缺失不构成 no-cors 失败 = 线上误报不是 CORS 造成的',
    /no-cors \+ no-store.*→ OK/.test(text) && /cors（默认）.*→ ERR/.test(text),
  );

  await new Promise((r) => pageServer.close(r));
  await new Promise((r) => target.close(r));
  rmSync(work, { recursive: true, force: true });

  const failed = results.filter((item) => !item.ok);
  console.log(`\n合计 ${String(results.length)} 项，失败 ${String(failed.length)} 项`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[FAIL]', error);
  process.exitCode = 1;
});
