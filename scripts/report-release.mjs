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

import { execFileSync } from 'node:child_process';
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
// MSI 里内嵌的那份服务端副本（build-msi.ps1 从 release/server 取的）——
// 它的对错靠下面的内容比对判定，不看 mtime（理由见 compareTree 的注释）
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
assertOrder(serverSrc, serverDist, 'server/src ≤ server/dist');

/**
 * 目录内容比对：两份产物必须逐文件 sha256 相同。
 *
 * 为什么不能像其它环节那样只比 mtime：`tsc -b` 是**增量**构建，输入内容没变就
 * 不重新 emit —— 于是"shared/dist 比 server/dist 新"可以完全正常地出现
 * （shared 被重编了一次但字节没变，server 因此不重编，mtime 停在几小时前）。
 * 2026-10-24 这条 mtime 断言就这么红过一次：查下来包内 `@tcs/shared/dist`
 * 与源码产物 112 个文件逐字节相同，纯粹是假红。
 *
 * 它要防的真实故障仍然存在，只是判据换成内容：**改了 shared、`pack:server`
 * 没重跑，包里还是旧的 shared**。那种情况下文件内容一定不同。
 */
function compareTree(expectedDir, actualDir, what) {
  if (!existsSync(expectedDir) || !existsSync(actualDir)) {
    fail(`${what}：一侧缺失（${existsSync(expectedDir) ? actualDir : expectedDir}）`);
    return;
  }
  const files = [];
  const walk = (current, base) => {
    for (const name of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, name.name);
      const rel = base === '' ? name.name : `${base}/${name.name}`;
      if (name.isDirectory()) walk(full, rel);
      else files.push(rel);
    }
  };
  walk(expectedDir, '');
  const differing = [];
  for (const rel of files) {
    const a = join(expectedDir, rel);
    const b = join(actualDir, rel);
    if (!existsSync(b) || sha256(a) !== sha256(b)) differing.push(rel);
  }
  if (differing.length > 0) {
    fail(`${what}：${differing.length}/${files.length} 个文件内容不同（例：${differing.slice(0, 3).join('、')}）`);
    return;
  }
  say(`   OK ${`${what} ${files.length} 个文件逐字节相同`.padEnd(34)}`.padEnd(52));
}

compareTree(join(ROOT, 'shared/dist'), join(ROOT, 'release/server/app/node_modules/@tcs/shared/dist'), 'shared/dist = 包内 @tcs/shared');
// `server/public` 是**静态资源**，不经过 tsc 编译，所以不能断言它 ≤ server/dist
// （昨天那条断言本身就是错的：改了 index.html 只会让 public 比 dist 新，而根本不
//  需要重新编译 —— 它会稳定地报红，逼人去改一条假规则）。
// 真正该断言的是"面板资源不能晚于打包时刻"，两级：
//   ① public ≤ release/server 里的副本（pack:server 负责 copy）
//   ② public ≤ 服务端 MSI
const bundleServerPublic = newestMtime(join(ROOT, 'release/server/app/server/public'), ['.html', '.js', '.css']);
assertOrder(serverPublic, { mtime: bundleServerPublic.mtime }, 'server/public ≤ 包内副本（release/server）');
if (serverArtifact) {
  // MSI 内嵌的是 release/server 里的副本。这里同样用**内容**比对而不是 mtime：
  // pack:server 保留源文件时间戳，mtime 断言永远通过，等于没断言。
  compareTree(join(ROOT, 'server/dist'), join(ROOT, 'release/server/app/server/dist'), 'server/dist = 包内副本');
  assertOrder(serverDist, { mtime: serverArtifact.mtime }, 'server/dist ≤ 服务端 MSI');
  assertOrder(serverPublic, { mtime: serverArtifact.mtime }, 'server/public ≤ 服务端 MSI');
  assertOrder({ mtime: rulesNewest.mtime }, { mtime: serverArtifact.mtime }, 'rules ≤ 服务端 MSI');
}
say('');

// ── 交叉说明 ─────────────────────────────────────────────
// ── 打包产物可启动 ───────────────────────────────────────
//
// 这是 2026-10-23 生产故障（服务端 MSI 启动 1067）留下的**结构性防线**。
// 那次的现象是：源码对、tsc 过、单测全绿、MSI 构建成功、体积正常 —— 唯独
// `@node-rs/argon2` 没进包（打包清单是手工硬编码的，T10.3 加依赖时没人回来改）。
// 靠人核对清单拦不住（实际同时漏了 argon2 与 @peculiar/x509 两个），
// 所以改成让产物自己跑一遍：用**包内那份 node.exe** 执行 `selfcheck`，
// 真算哈希、真签证书、真开库、真算 git 对象哈希。任一失败即红。
say('3. 打包产物可启动（用包内 node.exe 真跑一遍依赖）');

const bundleNode = join(ROOT, 'release/server/node.exe');
const bundleEntry = join(ROOT, 'release/server/app/server/dist/index.js');
if (!existsSync(bundleNode) || !existsSync(bundleEntry)) {
  fail('找不到 release/server 的 node.exe 或 index.js（先执行 npm run pack:server）');
} else {
  // 清掉 NODE_OPTIONS：某些宿主会注入 require 钩子，而这里要验的是**裸产物**能不能起
  const env = { ...process.env };
  delete env['NODE_OPTIONS'];
  const started = Date.now();
  let output = '';
  let code = 0;
  try {
    // 关键：`--bundle-root` 约束"依赖只能从包里解析"。
    // 不加的话，绿色包放在仓库里时会从**仓库根的 node_modules** 找到缺的包，
    // 自检全绿而装到 C://Program Files 后立刻崩 —— 我实测过这个假通过。
    output = execFileSync(bundleNode, [bundleEntry, 'selfcheck', '--bundle-root', join(ROOT, 'release/server/app')], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
  } catch (error) {
    code = typeof error.status === 'number' ? error.status : 1;
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  for (const line of output.split(/\r?\n/)) {
    if (/^[✔✘]/.test(line) || /^结论：/.test(line)) say(`   ${line.trim()}`);
  }
  if (code === 0 && /结论：通过/.test(output)) {
    say(`   OK 产物自检通过（${elapsed} 秒）`);
  } else {
    fail(`打包产物自检失败（退出码 ${String(code)}）—— 产物缺运行时依赖，见上方 ✘ 项`);
  }
}
say('');

say('4. 不做的断言（写在这里，免得下次又有人加）');
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
