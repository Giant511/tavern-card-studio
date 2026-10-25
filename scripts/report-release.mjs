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

import { auditDist, auditMsiSize, auditMsiShellAssets, auditShellAssets, findPriorMsi, mb as humanMb } from './lib/bundle-health.mjs';
import { checkStamp } from './lib/dist-stamp.mjs';
import { checkSentinels } from './lib/feature-sentinels.mjs';

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

// `server/src ≤ server/dist` 这条 mtime 断言在 v0.1.3 / 6d 被**换掉**了。
//
// 起因是一次误报：做静态判据的负向验证时往 `server/src/context.ts` 追加了一行注释，
// 验证完用 `git checkout` 还原 —— **内容一字不差，但 mtime 变成现在**。
// 于是这条断言红着说"打包用了旧产物"，而 `check:dist` 的内容指纹明明通过。
//
// 这就是 mtime 证明不了内容的又一个实例（决策 #113）：`tsc -b` 是增量的，
// 内容没变就不会重新 emit，dist 的 mtime 自然停在旧时间。用 mtime 判"是否最新"，
// 在"改过又改回"和"改了但产出没变"两种情况下都会误报。
//
// 现在改用内容指纹（与 `npm run check:dist` 同一判据、同一实现）：
// 构建时把 src 的相对路径与字节混进 sha256 存进 `dist/.build-stamp.json`，
// 这里重算一遍比对。判据更严格（真的能抓"没重编"），也不会被 mtime 骗。
const serverStamp = checkStamp('server');
if (serverStamp.ok) {
  say(`   OK ${`server/dist 与 server/src 内容一致（${serverStamp.current.hash.slice(0, 12)}…）`.padEnd(34)}`.padEnd(52));
} else {
  for (const reason of serverStamp.reasons) fail(reason.trim());
}

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
  // 包内规则必须与仓库**逐字节相同**（v0.1.3 / 6d）。
  //
  // 为什么这条不能只靠上面的 mtime 断言：`pack:server` 保留源文件时间戳，
  // mtime 断言在"改了源码但没重新 pack"时依然通过 —— 那正是 mtime 骗人的老坑。
  // 而规则是**数据**，两份拷贝一旦漂移，服务端审计与客户端预览会得出不同结论
  // （八板块改造时包内那份还是六板块，实测过）。
  compareTree(join(ROOT, 'rules'), join(ROOT, 'release/server/app/rules'), 'rules = 包内规则');
}
say('');

// ── 内嵌资源 / 体积回归 ──────────────────────────────────
//
// 这一段是 2026-10-24 生产故障（客户端白屏，`asset not found: index.html`）的产物。
//
// 那次的教训很具体：**时间链只保证「新」，不保证「有」**。上面第 2 节全部通过，
// 发出去的客户端 MSI 里却一个前端文件都没有 —— exe 比 dist 晚，但 exe 是空的。
// 所以这里补三条内容级判据（判据细节见 scripts/lib/bundle-health.mjs 顶部注释）：
//   ① dist 本身健康：入口 html 在根、总量达标、引用的资源真实存在、无 0 字节文件；
//   ② exe 真的内嵌了 dist 的**每一个**文件（Tauri 把资源键留成明文，可逐键 includes）；
//   ③ 新 MSI 不得比上一版骤降（<70%）。
//
// 特别说明 ③ 单独不够：本次故障的客户端 MSI 是 1,998,848 / 2,703,360 = 73.9%，
// 恰好从 70% 的网眼里漏过去 —— 真正拦住它的是 ②。别把 ③ 当成主判据。
say('3. 客户端内嵌资源与 MSI 体积回归');

const distAudit = auditDist(join(ROOT, 'client/dist'), { required: ['perf.html'] });
if (distAudit.ok) {
  say(`   OK ${`client/dist 健康：${distAudit.files.length} 个文件，${humanMb(distAudit.totalBytes)}`.padEnd(34)}`.padEnd(52));
} else {
  for (const problem of distAudit.problems) fail(`client/dist 不健康：${problem}`);
}

// ── 功能哨兵（v0.1.3 生产反馈「MSI 缺 F5 界面」的防线）────────────────
//
// 上面那条 `client/dist 健康` 只保证产物**有内容**，不保证是**这一版**：
// 一个两天前的 dist 结构完整、引用齐全，照样全绿。哨兵补的就是这个空档。
//
// 它必须落在明文窗口里：Tauri 把前端 brotli 压缩后内嵌，进 exe 之后任何界面文案
// 都是 0 命中 —— 用 `strings MSI | grep 兼容模式` 得出的"缺功能"是假阴性。
// 所以哨兵查的是 dist，不是 exe。
const sentinelAudit = checkSentinels(join(ROOT, 'client/dist'));
if (sentinelAudit.ok) {
  say(`   OK ${`功能哨兵 ${sentinelAudit.results.length} 项全部命中（扫 ${sentinelAudit.scanned.files} 个产物）`.padEnd(34)}`.padEnd(52));
  for (const result of sentinelAudit.results) {
    say(`      ·  [${result.feature}] 「${result.text}」${result.hits} 处 → ${result.file}`);
  }
} else {
  for (const problem of sentinelAudit.problems) fail(problem);
}

const embedAudit = auditShellAssets(shellExe, join(ROOT, 'client/dist'));
if (embedAudit.ok) {
  say(`   OK ${`exe 内嵌了全部 ${embedAudit.checked} 个 dist 文件`.padEnd(34)}`.padEnd(52));
} else {
  fail(
    `exe 缺 ${embedAudit.missing.length}/${embedAudit.checked} 个内嵌资源键` +
      `（例：${embedAudit.missing.slice(0, 3).join('、')}）—— 这个包装上去就是白屏`,
  );
}

// 出厂件审计：审计**MSI 里那个** exe，而不是构建树里的那个。
//
// 原因见 bundle-health.mjs 的 auditMsiShellAssets 注释：Tauri 打完包会再 patch 一次
// exe 写 bundle 类型，于是 `target/release/tcs-shell.exe` 与出厂件不是同一个二进制
// （实测差 3 字节，mtime 反而更晚）。只审计构建树 = 审计了一个没发出去的文件。
if (clientArtifact !== null) {
  const shipped = auditMsiShellAssets(clientArtifact.path, join(ROOT, 'client/dist'));
  if (shipped.skipped) {
    say(`   ·  ${`出厂件审计跳过：${shipped.reason}`.padEnd(34)}`.padEnd(52));
  } else if (shipped.ok) {
    say(`   OK ${`MSI 内的 exe 内嵌了全部 ${shipped.checked} 个资源键`.padEnd(34)}`.padEnd(52));
    say(`      出厂件 exe ${shipped.exeBytes} 字节 sha256 ${shipped.exeSha256.slice(0, 16)}…`);
  } else {
    fail(
      `MSI 内的 exe 缺 ${shipped.missing.length}/${shipped.checked} 个资源键` +
        `（例：${shipped.missing.slice(0, 3).join('、')}）—— 出厂件里的前端不是当前这一版`,
    );
  }
}

/** 体积回归断言，客户端与服务端共用 */
function assertMsiRegression(family, artifact, label) {
  if (artifact === null) {
    fail(`${label}：产物缺失，无法做体积回归`);
    return;
  }
  const prior = findPriorMsi(join(ROOT, 'release'), family, VERSION);
  const result = auditMsiSize(artifact.path, prior?.path ?? null);
  if (result.skipped) {
    say(`   ·  ${`${label}：release/ 下没有其它版本，跳过体积回归`.padEnd(34)}`.padEnd(52));
    return;
  }
  const ratioText = `${(result.ratio * 100).toFixed(1)}%（上一版 ${prior.version} ${humanMb(result.priorBytes)}）`;
  if (result.ok) {
    say(`   OK ${`${label} 体积 ${ratioText}`.padEnd(34)}`.padEnd(52));
  } else {
    fail(`${label} 体积只有上一版的 ${ratioText}，低于 70% 下限 —— 先查内嵌资源是否丢了`);
  }
}

assertMsiRegression('client', clientArtifact, '客户端 MSI');

// 服务端同批构建，防同类问题：包内必须有入口与面板，体积同样不许骤降。
const bundleServerEntry = join(ROOT, 'release/server/app/server/dist/index.js');
const bundleServerPanel = join(ROOT, 'release/server/app/server/public/index.html');
for (const [path, what] of [
  [bundleServerEntry, '包内服务端入口 index.js'],
  [bundleServerPanel, '包内面板 public/index.html'],
]) {
  if (existsSync(path)) {
    say(`   OK ${`${what} 存在（${statSync(path).size} 字节）`.padEnd(34)}`.padEnd(52));
  } else {
    fail(`${what} 不存在（${relative(ROOT, path)}）—— 包不完整`);
  }
}
assertMsiRegression('server', serverArtifact, '服务端 MSI');
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
say('4. 打包产物可启动（用包内 node.exe 真跑）');

const bundleNode = join(ROOT, 'release/server/node.exe');
const bundleEntry = join(ROOT, 'release/server/app/server/dist/index.js');
if (!existsSync(bundleNode) || !existsSync(bundleEntry)) {
  fail('找不到 release/server 的 node.exe 或 index.js（先执行 npm run pack:server）');
} else {
  // 清掉 NODE_OPTIONS：某些宿主会注入 require 钩子，而这里要验的是**裸产物**能不能起
  const env = { ...process.env };
  delete env['NODE_OPTIONS'];
  const run = (args, timeout) => {
    const started = Date.now();
    let output = '';
    let code = 0;
    try {
      output = execFileSync(bundleNode, args, {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
      });
    } catch (error) {
      code = typeof error.status === 'number' ? error.status : 1;
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    }
    return { code, output, elapsed: ((Date.now() - started) / 1000).toFixed(1) };
  };

  // ── 第一道：--version（最快失败点，2 秒内）
  //
  // 它能证明的是：**产物能加载、入口能执行**（缺文件、坏包、node 位数不对、
  // 静态 import 链断掉，都在这里立刻炸）。作为"打包产物可启动"的第一道信号足够便宜。
  //
  // 但它**抓不到 argon2 这类运行期依赖缺失** —— 实测过：把
  // `release/server/app/node_modules/@node-rs` 整个移走后 `--version` 照样退出 0，
  // 因为 `--version` 在 load() 之前就 return，压根没走到 auth/password 那条链。
  // 所以别拿它替代第二道：1067 那次事故复现时，`--version` 是绿的。
  const versionRun = run([bundleEntry, '--version'], 30_000);
  const versionLine = versionRun.output.split(/\r?\n/).find((line) => /\d+\.\d+\.\d+/.test(line)) ?? '';
  if (versionRun.code === 0 && versionLine.trim() !== '') {
    say(`   OK --version 通过：${versionLine.trim()}（${versionRun.elapsed} 秒）`);
  } else {
    fail(
      `打包产物跑不起来（--version 退出码 ${String(versionRun.code)}）：` +
        `${(versionRun.output.split(/\r?\n/).find((line) => line.trim() !== '') ?? '(无输出)').trim()}`,
    );
  }

  // ── 第二道：selfcheck（真跑运行时依赖，抓"装到 Program Files 才崩"那一类）
  const started = Date.now();
  // 关键：`--bundle-root` 约束"依赖只能从包里解析"。
  // 不加的话，绿色包放在仓库里时会从**仓库根的 node_modules** 找到缺的包，
  // 自检全绿而装到 C://Program Files 后立刻崩 —— 我实测过这个假通过。
  const checkRun = run([bundleEntry, 'selfcheck', '--bundle-root', join(ROOT, 'release/server/app')], 60_000);
  const { code, output } = checkRun;
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

say('5. 不做的断言（写在这里，免得下次又有人加）');
say('   · 不断言「exe ≤ MSI」：Tauri 打完包会再 patch 一次 exe 写 bundle 类型，');
say('     MSI 则是先临时生成再整体挪位（mtime 被保留），两者先后无意义。');
say('   · 不用 sha256 比对历史构建：WiX 写入构建时间戳，MSI 不是逐字节可复现的，');
say('     哈希只能「发布时记录、随包分发」，不能拿来校验新构建。');
say('   · 不拿体积单独下结论：上一轮把 824,320 字节的差解释成「strip 掉 .debug 段」，');
say('     实际是**内嵌资源整段缺失**（同一命令重建的正确产物是 4,879,360 字节，');
say('     +849,408 正好是 brotli 后的前端体积）。体积只当粗网，逐键 includes 才是判据。');
say('');

if (failures.length > 0) {
  say(`结论：未通过（${String(failures.length)} 项）`);
  process.exitCode = 1;
} else {
  say('结论：通过');
}
