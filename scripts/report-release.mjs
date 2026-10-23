#!/usr/bin/env node
/**
 * 发布物核验（T10.10 ④）：双 MSI 的体积、sha256、时间链断言，一次打印齐。
 *
 * 为什么不让 `verify-build.ps1` 一个人干完：它只管客户端。服务端 MSI 由
 * `installer/build-msi.ps1` 产出，两者是两条独立的流水线，最后却要在同一份
 * 发布说明里并列 —— 没有统一的复算入口时，"这次到底打进去了哪些代码"
 * 只能靠两份日志互相印证，人眼一漏就是发错包。
 *
 * 时间链的铁律（PLAN.md 决策 #22）：**只断言「源/dist ≤ 各自的交付物」**，
 * 不断言两个交付物之间的先后 —— Tauri 打完包后会再 patch 一次 exe 写 bundle 类型，
 * 而 MSI 是先临时生成再整体挪位（mtime 被保留），比较它们没有意义。
 *
 * 用法：node scripts/report-release.mjs [--version 0.1.2]
 * 退出码：0 全部通过；1 任一时间链断言失败或产物缺失
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const versionArg = process.argv.indexOf('--version');
const VERSION = versionArg > -1 ? (process.argv[versionArg + 1] ?? '') : JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

const lines = [];
const failures = [];
const say = (text = '') => {
  lines.push(text);
  console.log(text);
};

function fail(text) {
  failures.push(text);
  say(`  ✘ ${text}`);
}

/** 目录下最新的 mtime（递归，只看给定扩展名） */
function newestMtime(dir, extensions) {
  let newest = 0;
  let newestFile = '';
  const walk = (current) => {
    for (const name of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, name.name);
      if (name.isDirectory()) {
        if (name.name === 'node_modules' || name.name === 'target') continue;
        walk(full);
        continue;
      }
      if (extensions !== null && !extensions.some((ext) => name.name.endsWith(ext))) continue;
      const mtime = statSync(full).mtimeMs;
      if (mtime > newest) {
        newest = mtime;
        newestFile = full;
      }
    }
  };
  if (!existsSync(dir)) return { mtime: 0, file: '(目录不存在)' };
  walk(dir);
  return { mtime: newest, file: newestFile };
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} 秒`;
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function describe(file) {
  if (!existsSync(file)) return null;
  const stat = statSync(file);
  return { path: file, bytes: stat.size, mtime: stat.mtimeMs, sha256: sha256(file) };
}

say(`Tavern Card Studio ${VERSION} · 发布物核验`);
say(`仓库：${ROOT}`);
say('');

// ── 产物清单 ─────────────────────────────────────────────
const clientMsi = join(ROOT, 'release', `Tavern Card Studio_${VERSION}_x64_en-US.msi`);
const clientMsiBundled = join(
  ROOT,
  'client/src-tauri/target/release/bundle/msi',
  `Tavern Card Studio_${VERSION}_x64_en-US.msi`,
);
const serverMsi = join(ROOT, 'release', `TavernCardStudioServer-${VERSION}.msi`);
const shellExe = join(ROOT, 'client/src-tauri/target/release/tcs-shell.exe');

const artifacts = [
  ['客户端 MSI', describe(existsSync(clientMsi) ? clientMsi : clientMsiBundled)],
  ['服务端 MSI', describe(serverMsi)],
  ['客户端 exe', describe(shellExe)],
];

say('1. 体积与哈希');
for (const [label, info] of artifacts) {
  if (info === null) {
    fail(`${label} 不存在（找过 ${label === '客户端 MSI' ? `${relative(ROOT, clientMsi)} 与 bundle 目录` : relative(ROOT, serverMsi)}）`);
    continue;
  }
  say(`   ${label.padEnd(10)} ${mb(info.bytes).padStart(9)}  ${String(info.bytes).padStart(9)} 字节`);
  say(`   ${''.padEnd(10)} sha256 ${info.sha256}`);
  say(`   ${''.padEnd(10)} 路径 ${relative(ROOT, info.path)}`);
}
say('');

// ── 时间链 ───────────────────────────────────────────────
say('2. 时间链断言（源/dist ≤ 各自的交付物）');

const sharedSrc = newestMtime(join(ROOT, 'shared/src'), ['.ts']);
const sharedDist = newestMtime(join(ROOT, 'shared/dist'), ['.js']);
const clientSrc = newestMtime(join(ROOT, 'client/src'), ['.ts', '.css', '.html']);
const clientDist = newestMtime(join(ROOT, 'client/dist'), ['.js', '.css', '.html']);
const serverSrc = newestMtime(join(ROOT, 'server/src'), ['.ts']);
const serverDist = newestMtime(join(ROOT, 'server/dist'), ['.js']);
const serverPublic = newestMtime(join(ROOT, 'server/public'), ['.html', '.js', '.css']);
// MSI 里内嵌的那份服务端副本（build-msi.ps1 从 release/server 取的）
const bundleServerDist = newestMtime(join(ROOT, 'release/server/app/server/dist'), ['.js']);
const rulesNewest = newestMtime(join(ROOT, 'rules'), ['.json']);

/** 断言 `earlier ≤ later`，`what` 用于报错文案 */
function assertOrder(earlier, later, what) {
  if (earlier.mtime === 0 || later.mtime === 0) {
    fail(`${what}：一侧缺失（${earlier.mtime === 0 ? '源' : '产物'}）`);
    return;
  }
  const gap = later.mtime - earlier.mtime;
  const label = `${what.padEnd(34)} 间隔 ${(gap >= 0 ? '+' : '') + seconds(gap)}`.padEnd(52);
  if (gap >= 0) say(`   OK ${label}`);
  else fail(`${what}：产物比源**早** ${seconds(-gap)}（说明打包用了旧产物）`);
}

const clientArtifact = artifacts[0][1];
const serverArtifact = artifacts[1][1];

assertOrder(sharedSrc, sharedDist, 'shared/src ≤ shared/dist');
assertOrder(sharedDist, clientDist, 'shared/dist ≤ client/dist');
assertOrder(clientSrc, clientDist, 'client/src ≤ client/dist');
assertOrder(rulesNewest, clientDist, 'rules ≤ client/dist（打进客户端资源）');
if (clientArtifact) {
  assertOrder(clientDist, { mtime: clientArtifact.mtime }, 'client/dist ≤ 客户端 MSI');
}
if (existsSync(shellExe)) {
  assertOrder(clientDist, { mtime: statSync(shellExe).mtimeMs }, 'client/dist ≤ tcs-shell.exe');
}

assertOrder(sharedSrc, sharedDist, 'shared/src ≤ shared/dist（服务端链路）');
assertOrder(sharedDist, serverDist, 'shared/dist ≤ server/dist');
assertOrder(serverSrc, serverDist, 'server/src ≤ server/dist');
assertOrder(serverPublic, serverDist, 'server/public ≤ server/dist');
if (serverArtifact) {
  // MSI 内嵌的是 release/server 里的副本，先断言"副本不旧于刚编的 dist"，
  // 再断言"副本 ≤ MSI"。两级都要，否则"打了包但没重新 pack:server"仍会漏过。
  assertOrder(serverDist, { mtime: bundleServerDist.mtime }, 'server/dist ≤ 包内副本（release/server）');
  assertOrder(serverDist, { mtime: serverArtifact.mtime }, 'server/dist ≤ 服务端 MSI');
  assertOrder({ mtime: rulesNewest.mtime }, { mtime: serverArtifact.mtime }, 'rules ≤ 服务端 MSI');
}
say('');

// ── 交叉说明 ─────────────────────────────────────────────
say('3. 不做的断言（写在这里，免得下次又有人加）');
say('   · 不断言「exe ≤ MSI」：Tauri 打完包会再 patch 一次 exe 写 bundle 类型，');
say('     MSI 则是先临时生成再整体挪位（mtime 被保留），两者先后无意义。');
say('   · 不用 sha256 比对历史构建：WiX 写入构建时间戳，MSI 不是逐字节可复现的，');
say('     哈希只能「发布时记录、随包分发」，不能拿来校验新构建。');
say('');

if (failures.length > 0) {
  say(`结论：未通过（${String(failures.length)} 项）`);
  process.exitCode = 1;
} else {
  say('结论：通过');
}
