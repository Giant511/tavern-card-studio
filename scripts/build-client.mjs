#!/usr/bin/env node
/**
 * 客户端打包的唯一入口（T10.37）。
 *
 * 为什么要有这个脚本：2026-10-24 发出去的客户端 MSI 是**白屏**的 ——
 * `tcs-shell.exe` 里一个前端文件都没有，运行期 `asset not found: index.html`。
 * 那次的手工流程是「vite build → tauri build → 拷到 release」，三步之间没有任何断言：
 *
 *   · `tauri build` 的返回值是 0（cargo 成功、WiX 成功），坏的是**内容**；
 *   · `report:release` 只断言 `client/dist ≤ exe` 的 mtime，exe 比 dist 晚就算绿；
 *   · 体积从 2.82 MB 掉到 1.91 MB（73.9%）还被上一轮解释成「strip 生效」，
 *     70% 的粗网也拦不住。
 *
 * 所以这里把三步收成一条链，并在**构建前**和**构建后**各放断言：
 *
 *   ① vite build 之后：dist 健康（入口在根、总量达标、引用的资源真实存在、无 0 字节文件）；
 *   ② 如果现有 exe 不含新 dist 的所有资源键，就 touch 一次 crate 根 ——
 *      强制 `generate_context!` 重新执行。cargo 的增量判定对「dist 内容变了但 rust 源没变」
 *      并不总是可靠，这一步花一次重编译的钱换确定性；
 *   ③ tauri build 之后：exe 必须内嵌 dist 的**每一个**文件（逐键 includes，见 bundle-health）；
 *   ④ MSI 体积回归：不得低于上一版的 70%；
 *   ⑤ 全部通过才拷进 release/。
 *
 * 用法：node scripts/build-client.mjs [--skip-ui]
 * 退出码：0 通过；1 任一断言失败（此时 release/ 不会被写入）
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  auditDist,
  auditMsiSize,
  auditShellAssets,
  findPriorMsi,
  mb,
  rel,
} from './lib/bundle-health.mjs';

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
const failures = [];

const say = (text = '') => console.log(text);
const step = (text) => say(`\n▸ ${text}`);
const ok = (text) => say(`  ✔ ${text}`);
const bad = (text) => {
  failures.push(text);
  say(`  ✘ ${text}`);
};

/** 直接调 node 跑 CLI，不经过 shell —— 本机 `spawnSync('cmd.exe')` 会 EBUSY。 */
function runNode(script, args, cwd) {
  execFileSync(process.execPath, [script, ...args], { cwd, stdio: 'inherit' });
}

say(`Tavern Card Studio ${VERSION} · 客户端打包（唯一入口）`);
say(`仓库：${ROOT}`);

// ── ① 前端产物 ───────────────────────────────────────────
step('1. vite build（前端产物）');
if (skipUi) {
  say('  跳过（--skip-ui），直接复用现有 dist');
} else {
  runNode(join(ROOT, 'node_modules/vite/bin/vite.js'), ['build'], CLIENT);
}

step('2. dist 健康检查（构建前断言：只保证「新」不保证「有」的洞）');
const distAudit = auditDist(DIST, { required: ['perf.html'] });
if (!distAudit.ok) {
  for (const problem of distAudit.problems) bad(`dist 不健康：${problem}`);
  say('\n结论：未通过（dist 不健康，不进入打包）');
  process.exit(1);
}
ok(`${distAudit.files.length} 个文件，合计 ${mb(distAudit.totalBytes)}（${distAudit.totalBytes} 字节）`);
for (const file of distAudit.files) say(`     ${String(file.bytes).padStart(9)}  ${file.rel}`);

// ── ② 是否需要强制 re-embed ──────────────────────────────
step('3. 内嵌是否已过期（决定要不要强制 codegen 重跑）');
const distNewest = Math.max(...distAudit.files.map((file) => statSync(file.path).mtimeMs));
const before = existsSync(EXE) ? auditShellAssets(EXE, DIST) : { ok: false, missing: ['(exe 不存在)'], checked: 0 };
const exeMtime = existsSync(EXE) ? statSync(EXE).mtimeMs : 0;
if (!before.ok || exeMtime < distNewest) {
  utimesSync(join(SRC_TAURI, 'src/lib.rs'), new Date(), new Date());
  const why = !before.ok ? `缺 ${before.missing.length}/${before.checked} 个资源键` : 'exe 早于 dist';
  say(`  · 现有 exe ${why} → touch src/lib.rs 强制重新生成 context（多花一次 LTO 重链接）`);
} else {
  ok('现有 exe 已内嵌当前 dist 的全部资源键');
}

// ── ③ 打包 ───────────────────────────────────────────────
step('4. tauri build（编译 + WiX 打包）');
try {
  runNode(join(ROOT, 'node_modules/@tauri-apps/cli/tauri.js'), ['build'], CLIENT);
} catch (error) {
  bad(`tauri build 失败（退出码 ${String(error.status ?? '?')}）`);
  say('\n结论：未通过');
  process.exit(1);
}

// ── ④ 内嵌资源 ───────────────────────────────────────────
step('5. exe 内嵌资源校验（内容级，不看 mtime / 不看体积）');
const embed = auditShellAssets(EXE, DIST);
if (embed.ok) {
  ok(`${embed.checked}/${embed.checked} 个 dist 文件的资源键都在 exe 里`);
} else {
  bad(`exe 缺 ${embed.missing.length}/${embed.checked} 个资源键（例：${embed.missing.slice(0, 3).join('、')}）`);
}

// ── ⑤ 体积回归 ───────────────────────────────────────────
const bundleMsi = join(BUNDLE_DIR, MSI_NAME);
step('6. MSI 体积回归（骤降 = 内嵌资源丢失的强信号）');
const prior = findPriorMsi(RELEASE, 'client', VERSION);
const sizeAudit = auditMsiSize(bundleMsi, prior?.path ?? null);
if (sizeAudit.skipped) {
  say(`  · 无基线可比（release/ 下没有其它版本的客户端 MSI），跳过`);
} else if (sizeAudit.ok) {
  ok(`${mb(sizeAudit.bytes)} / 上一版 ${prior.version} ${mb(sizeAudit.priorBytes)} = ${(sizeAudit.ratio * 100).toFixed(1)}%`);
} else {
  bad(
    `MSI 体积只有上一版 ${prior.version} 的 ${(sizeAudit.ratio * 100).toFixed(1)}% ` +
      `（${sizeAudit.bytes} / ${sizeAudit.priorBytes}），低于 70% 下限`,
  );
}

if (failures.length > 0) {
  say(`\n结论：未通过（${failures.length} 项）—— release/ 未写入，不要发布`);
  process.exit(1);
}

// ── ⑥ 交付 ───────────────────────────────────────────────
step('7. 拷进 release/');
const target = join(RELEASE, MSI_NAME);
copyFileSync(bundleMsi, target);
const bytes = statSync(target).size;
const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex');
ok(`${rel(ROOT, target)}`);
say(`     ${bytes} 字节（${mb(bytes)}）`);
say(`     sha256 ${sha256}`);

// 顺带把 dist 清单落一份，发布说明里可直接引用
const manifest = {
  version: VERSION,
  builtAt: new Date().toISOString(),
  dist: { files: distAudit.files.map((file) => ({ path: file.rel, bytes: file.bytes })), totalBytes: distAudit.totalBytes },
  exe: { path: rel(ROOT, EXE), bytes: statSync(EXE).size, embeddedAssetKeys: embed.checked },
  msi: { path: rel(ROOT, target), bytes, sha256 },
};
const manifestPath = join(RELEASE, `client-${VERSION}.manifest.json`);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
ok(`清单：${rel(ROOT, manifestPath)}`);

say('\n结论：通过');
