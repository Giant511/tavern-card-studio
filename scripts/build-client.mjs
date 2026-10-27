#!/usr/bin/env node
/**
 * 客户端打包的唯一入口（T10.37 / v0.1.3 加固）。
 *
 * ## 历史：这个脚本为什么存在
 *
 * 2026-10-24 发出去的客户端 MSI 是**白屏**的 —— `tcs-shell.exe` 里一个前端文件
 * 都没有，运行期 `asset not found: index.html`。那次的手工流程是
 * 「vite build → tauri build → 拷到 release」，三步之间没有任何断言：
 *
 *   · `tauri build` 的返回值是 0（cargo 成功、WiX 成功），坏的是**内容**；
 *   · `report:release` 只断言 `client/dist ≤ exe` 的 mtime，exe 比 dist 晚就算绿；
 *   · 体积从 2.82 MB 掉到 1.91 MB（73.9%）还被上一轮解释成「strip 生效」。
 *
 * ## 现在：显式顺序，任何一步失败即停
 *
 *   0. clean          删掉 client/dist（杜绝上一版残留的哈希文件混进来）
 *   1. vite build     前端产物
 *   2. dist 健康      入口在根、总量达标、引用的资源真实存在、无 0 字节文件
 *   3. 功能哨兵       **近期交付的界面原文必须在 dist 里**（见 lib/feature-sentinels.mjs）
 *   4. 内嵌是否过期   缺资源键 / exe 早于 dist → touch src/lib.rs 强制 codegen 重跑
 *   5. tauri build    编译 + WiX 打包
 *   6. 构建树 exe     必须内嵌 dist 的每一个资源键
 *   7. 出厂件         **解开 MSI，审计里面那个 exe**（构建树里的不是出厂件，见下）
 *   8. 时间链         dist ≤ exe、dist ≤ MSI
 *   9. 体积回归       不得低于上一版的 70%
 *  10. 交付           全部通过才拷进 release/
 *
 * ## 第 3 步与第 7 步补的是两个不同的洞
 *
 * · `auditDist`（第 2 步）只保证产物**有内容**，不保证是**这一版**。
 *   一个两天前的 dist 只要结构完整照样全绿。哨兵补的就是这个：
 *   它必须落在 tauri build **之前**，因为内嵌之后文案被 brotli 压缩，
 *   在 exe/MSI 里是 0 命中（拿二进制搜索得出"缺功能"是假阴性，踩过）。
 * · 第 7 步的原因：Tauri 打完包会**再 patch 一次 exe 写 bundle 类型**
 *   （实测 MSI 内是 `TAURI_BUNDLE_TYPE_VAR_MSI`、构建树是 `_VAR_UNK`，差 3 字节）。
 *   所以 `target/release/tcs-shell.exe` 与出厂件是两个不同的二进制，
 *   只审计构建树 = 审计了一个没发出去的文件。
 *
 * 用法：node scripts/build-client.mjs [--skip-ui]
 *        --skip-ui  跳过 clean + vite build，直接复用现有 dist（哨兵照样查）
 * 退出码：0 通过；1 任一步失败（此时 release/ 不会被写入）
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  auditDist,
  auditMsiSize,
  auditMsiShellAssets,
  auditShellAssets,
  findPriorMsi,
  mb,
  rel,
} from './lib/bundle-health.mjs';
import { checkSentinels, validateRegistry } from './lib/feature-sentinels.mjs';
import { checkVersionLiterals, versionBasisText } from './check-version-literal.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLIENT = join(ROOT, 'client');
const SRC_TAURI = join(CLIENT, 'src-tauri');
const DIST = join(CLIENT, 'dist');
const EXE = join(SRC_TAURI, 'target/release/tcs-shell.exe');
const BUNDLE_DIR = join(SRC_TAURI, 'target/release/bundle/msi');
const RELEASE = join(ROOT, 'release');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const MSI_NAME = `Tavern Card Studio_${VERSION}_x64_en-US.msi`;

const skipUi = process.argv.includes('--skip-ui');

const say = (text = '') => console.log(text);
const step = (index, text) => say(`\n▸ ${index}. ${text}`);
const ok = (text) => say(`  ✔ ${text}`);
const note = (text) => say(`  · ${text}`);

/** 任何一步失败：立刻停，release/ 不写。 */
function die(text) {
  say(`  ✘ ${text}`);
  say('\n结论：未通过 —— release/ 未写入，不要发布');
  process.exit(1);
}

/** 直接调 node 跑 CLI，不经过 shell —— 本机 `spawnSync('cmd.exe')` 会 EBUSY。 */
function runNode(script, args, cwd) {
  execFileSync(process.execPath, [script, ...args], { cwd, stdio: 'inherit' });
}

say(`Tavern Card Studio ${VERSION} · 客户端打包（唯一入口，失败即停）`);
say(`仓库：${ROOT}`);

// 哨兵表自身先自检：文案太短/重复/没写位置，说明这张表已经退化了
const registryProblems = validateRegistry();
if (registryProblems.length > 0) {
  for (const problem of registryProblems) say(`  ✘ ${problem}`);
  die('哨兵表不合格 —— 先修 scripts/lib/feature-sentinels.mjs');
}

// 版本号载体一致性（v0.1.6）：MSI 文件名由 package.json 的 version 决定，
// 但版本号还散落在 tauri.conf / Cargo.toml / Cargo.lock / SERVER_VERSION /
// 服务端打包脚本 / 安装说明页里。打出来的包名对、里面印的版本不对，是
// "版本号骗人"这一类事故（v0.1.5 实测：包名 v0.1.5、服务端内部 v0.1.3、
// 说明页 0.1.2）。放在最前面：这一步不过，后面几步的产物都不用看。
const versionCheck = checkVersionLiterals(ROOT);
if (!versionCheck.ok) {
  for (const problem of versionCheck.problems) say(`  ✘ ${problem}`);
  die('版本号载体不一致 —— 先跑 npm run check:version 看清单');
}
say(`  ✔ ${versionCheck.carriers.length} 处版本载体都等于 ${versionCheck.current}`);
// 载体一致只证明"改全了"，不证明"这个版本号该存在"。升不升由需求文档决定（决策 #232），
// 脚本看不到文档，所以把「当前版本 vs 最新 tag」摆出来，让人自己核对一眼。
say(`  · ${versionBasisText(versionCheck.current, ROOT)}`);

// ── 0. clean ─────────────────────────────────────────────
/*
 * 清理**只走 `clean-client-dist.mjs` 一处**（归档式 rename）。
 *
 * 这一行原来是 `rmSync(DIST, { recursive: true, force: true })`，与
 * `build:ui` 里的清理重复，而且同样会撞 safe-delete：
 *
 *     [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":62,"threshold":50,
 *       "targets":["...\client\dist"],"targetCount":1}
 *
 * 计数是按 turn 累计的（此前截图/快照/测试的删除都算进去了），所以"打包前删一次
 * dist"这种最普通的动作会在某几轮里突然失败 —— 而它又是打包流水线的第 0 步，
 * 一失败整条链就停。归档用 rename，一次系统调用、不是删除，不受该钩子约束。
 */
step(0, 'clean（把上一版 dist 归档，不是删除）');
if (skipUi) {
  note('跳过（--skip-ui）：直接复用现有 dist，哨兵仍会检查');
} else {
  runNode(join(ROOT, 'scripts/clean-client-dist.mjs'), [], ROOT);
  ok('client/dist 已归档（旧产物在 .verify/dist-archive/，可对比）');
}

// ── 1. 前端产物 ───────────────────────────────────────────
step(1, 'vite build（前端产物）');
if (skipUi) {
  note('跳过（--skip-ui）');
} else {
  runNode(join(ROOT, 'node_modules/vite/bin/vite.js'), ['build'], CLIENT);
  ok('vite build 完成');
}

// ── 2. dist 健康 ─────────────────────────────────────────
step(2, 'dist 健康检查（只保证「有内容」，不保证「是这一版」）');
const distAudit = auditDist(DIST, { required: ['perf.html'] });
if (!distAudit.ok) {
  for (const problem of distAudit.problems) say(`  ✘ dist 不健康：${problem}`);
  die('dist 不健康，不进入打包');
}
ok(`${distAudit.files.length} 个文件，合计 ${mb(distAudit.totalBytes)}（${distAudit.totalBytes} 字节）`);
for (const file of distAudit.files) say(`     ${String(file.bytes).padStart(9)}  ${file.rel}`);

// ── 3. 功能哨兵（必须在内嵌之前）──────────────────────────
step(3, '功能哨兵（近期交付的界面原文必须在 dist 里）');
const sentinels = checkSentinels(DIST);
say(
  `     扫描 ${sentinels.scanned.files} 个构建产物（${mb(sentinels.scanned.bytes)}），` +
    `跳过 ${sentinels.scanned.skipped} 个 .map（sourcemap 里有源码原文，扫它会假绿）`,
);
for (const result of sentinels.results) {
  const tail = result.hits > 0 ? `${result.hits} 处 · ${result.file}` : '未命中';
  say(`     ${result.hits > 0 ? '✔' : '✘'} [${result.feature}] 「${result.text}」 ${tail}`);
  if (result.hits > 0) say(`        ${result.where}`);
}
if (!sentinels.ok) {
  for (const problem of sentinels.problems) say(`  ✘ ${problem}`);
  die('dist 缺少近期交付的功能原文 —— 打的不是当前这一版，停下来查 vite build / 分支');
}
ok(`${sentinels.results.length} 个哨兵全部命中`);

// ── 4. 是否需要强制 re-embed ──────────────────────────────
step(4, '内嵌是否已过期（决定要不要强制 codegen 重跑）');
const distNewest = Math.max(...distAudit.files.map((file) => statSync(file.path).mtimeMs));
const before = existsSync(EXE) ? auditShellAssets(EXE, DIST) : { ok: false, missing: ['(exe 不存在)'], checked: 0 };
const exeMtime = existsSync(EXE) ? statSync(EXE).mtimeMs : 0;
if (!before.ok || exeMtime < distNewest) {
  utimesSync(join(SRC_TAURI, 'src/lib.rs'), new Date(), new Date());
  const why = !before.ok ? `缺 ${before.missing.length}/${before.checked} 个资源键` : 'exe 早于 dist';
  note(`现有 exe ${why} → touch src/lib.rs 强制重新生成 context（多花一次 LTO 重链接）`);
} else {
  ok('现有 exe 已内嵌当前 dist 的全部资源键');
}

// ── 5. 打包 ───────────────────────────────────────────────
step(5, 'tauri build（编译 + WiX 打包）');
try {
  runNode(join(ROOT, 'node_modules/@tauri-apps/cli/tauri.js'), ['build'], CLIENT);
} catch (error) {
  die(`tauri build 失败（退出码 ${String(error.status ?? '?')}）`);
}
const bundleMsi = join(BUNDLE_DIR, MSI_NAME);
if (!existsSync(bundleMsi)) die(`tauri build 退出 0 但没有产出 ${rel(ROOT, bundleMsi)}`);
ok(rel(ROOT, bundleMsi));

// ── 6. 构建树 exe 的内嵌资源 ──────────────────────────────
step(6, 'exe 内嵌资源校验（内容级，不看 mtime / 不看体积）');
const embed = auditShellAssets(EXE, DIST);
if (embed.ok) {
  ok(`${embed.checked}/${embed.checked} 个 dist 文件的资源键都在 exe 里`);
} else {
  die(
    `exe 缺 ${embed.missing.length}/${embed.checked} 个资源键` +
      `（例：${embed.missing.slice(0, 3).join('、')}）—— 这个包装上去就是白屏`,
  );
}

// ── 7. 出厂件（MSI 里那个 exe）────────────────────────────
step(7, '出厂件校验（解开 MSI，审计里面那个 exe）');
/*
 * 壳侧（Rust）哨兵：这些字面量必须出现在**出厂 exe** 里。
 *
 * 前端哨兵（脚本/lib/feature-sentinels.mjs）只能守 dist，而 v0.1.6 三个真因
 * 全都修在壳里：`X-Frame-Options` 剥离、`frame-ancestors` 剥离、会话 cookie 改
 * `SameSite=None`。它们不进 dist，只能在这里守 —— 否则"包装上了但壳是旧的"
 * 这类事故没有任何东西能发现（版本号照样对、体积照样正常）。
 */
const SHELL_STRINGS = [
  'x-frame-options',        // 剥 XFO：面板 iframe 才显示得出来
  'frame-ancestors',        // 剥 CSP 的那条指令
  'SameSite=None',          // 会话 cookie 跨站可发：否则卡在「正在初始化…」
];
const shipped = auditMsiShellAssets(bundleMsi, DIST, { strings: SHELL_STRINGS });
if (shipped.skipped) die(`无法审计出厂件：${shipped.reason}`);
if (!shipped.ok) {
  die(
    `MSI 内的 exe 缺 ${shipped.missing.length}/${shipped.checked} 个资源键` +
      `（例：${shipped.missing.slice(0, 3).join('、')}）—— 出厂件里的前端不是当前这一版`,
  );
}
ok(`MSI 内的 exe 内嵌了全部 ${shipped.checked} 个 dist 资源键`);
if (shipped.missingStrings.length > 0) {
  die(
    `MSI 内的 exe 缺 ${shipped.missingStrings.length}/${SHELL_STRINGS.length} 个壳侧关键字符串` +
      `（${shipped.missingStrings.join('、')}）—— 这个包的壳不是带修复的那一版`,
  );
}
ok(`壳侧关键字符串 ${SHELL_STRINGS.length}/${SHELL_STRINGS.length} 命中`);
note(`出厂件 exe ${shipped.exeBytes} 字节 sha256 ${shipped.exeSha256.slice(0, 16)}…`);
const treeSha = createHash('sha256').update(readFileSync(EXE)).digest('hex');
if (treeSha !== shipped.exeSha256) {
  note(
    '构建树 exe 与出厂件哈希不同 —— 已知行为：Tauri 打完包会再 patch 一次 exe 写 bundle 类型' +
      '（2026-10-25 实测仅差 3 字节：TAURI_BUNDLE_TYPE_VAR_MSI → _VAR_UNK）。' +
      '所以第 8 步不断言 exe ≤ MSI。',
  );
} else {
  ok('构建树 exe 与出厂件逐字节相同');
}

// ── 8. 时间链 ────────────────────────────────────────────
step(8, '时间链断言（dist ≤ 各自的交付物）');
function assertOrder(earlier, later, what) {
  const gap = later - earlier;
  const text = `${what} 间隔 ${(gap >= 0 ? '+' : '')}${(gap / 1000).toFixed(1)} 秒`;
  if (gap >= 0) ok(text);
  else die(`${what}：产物比 dist 早 ${((-gap) / 1000).toFixed(1)} 秒 —— 打包用了旧产物`);
}
assertOrder(distNewest, statSync(EXE).mtimeMs, 'dist ≤ tcs-shell.exe');
assertOrder(distNewest, statSync(bundleMsi).mtimeMs, 'dist ≤ 客户端 MSI');
// 不写 `exe ≤ MSI`：Tauri 打完包会再 patch 一次 exe 写 bundle 类型，
// MSI 则是先临时生成再整体挪位（mtime 被保留），两者先后没有意义。见 report-release 第 5 节。

// ── 9. 体积回归 ──────────────────────────────────────────
step(9, 'MSI 体积回归（骤降 = 内嵌资源丢失的强信号）');
const prior = findPriorMsi(RELEASE, 'client', VERSION);
const sizeAudit = auditMsiSize(bundleMsi, prior?.path ?? null);
if (sizeAudit.skipped) {
  note('无基线可比（release/ 下没有其它版本的客户端 MSI），跳过');
} else if (sizeAudit.ok) {
  ok(`${mb(sizeAudit.bytes)} / 上一版 ${prior.version} ${mb(sizeAudit.priorBytes)} = ${(sizeAudit.ratio * 100).toFixed(1)}%`);
} else {
  die(
    `MSI 体积只有上一版 ${prior.version} 的 ${(sizeAudit.ratio * 100).toFixed(1)}% ` +
      `（${sizeAudit.bytes} / ${sizeAudit.priorBytes}），低于 70% 下限 —— 先查内嵌资源是否丢了`,
  );
}

// ── 10. 交付 ─────────────────────────────────────────────
step(10, '拷进 release/');
const target = join(RELEASE, MSI_NAME);
copyFileSync(bundleMsi, target);
const bytes = statSync(target).size;
const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex');
ok(rel(ROOT, target));
say(`     ${bytes} 字节（${mb(bytes)}）`);
say(`     sha256 ${sha256}`);

// 顺带把 dist 清单与哨兵结论落一份，发布说明里可直接引用
const manifest = {
  version: VERSION,
  builtAt: new Date().toISOString(),
  dist: { files: distAudit.files.map((file) => ({ path: file.rel, bytes: file.bytes })), totalBytes: distAudit.totalBytes },
  sentinels: sentinels.results.map((result) => ({
    feature: result.feature,
    text: result.text,
    hits: result.hits,
    file: result.file,
  })),
  exe: { path: rel(ROOT, EXE), bytes: statSync(EXE).size, embeddedAssetKeys: embed.checked, sha256: treeSha },
  shippedExe: { bytes: shipped.exeBytes, sha256: shipped.exeSha256 },
  msi: { path: rel(ROOT, target), bytes, sha256 },
};
const manifestPath = join(RELEASE, `client-${VERSION}.manifest.json`);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
ok(`清单：${rel(ROOT, manifestPath)}`);

say('\n结论：通过');
