/**
 * 打包清单与运行时依赖的一致性（v0.1.2 热修）。
 *
 * 2026-10-23 生产故障：服务端 MSI 装好后启动报 1067，日志
 * `Cannot find package '@node-rs/argon2'`。源码对、tsc 过、单测全绿、
 * MSI 构建成功、体积正常 —— 唯独依赖没进包。
 *
 * 根因是 `pack-server.mjs` 里那张**手工硬编码**的入口列表：
 * 原先是 `['better-sqlite3', 'isomorphic-git']`，T10.3 引入 argon2 时没人回来改。
 * 同一次核对还发现 `@peculiar/x509`（TLS 自签）也漏了 —— 漏了两个。
 *
 * 所以这里守的是**机制**，不是清单内容：
 *   1. 打包脚本不得再出现手写的包名列表（判据：源码里不出现包名字面量数组）；
 *   2. `server/package.json` 的每个 dependencies 都必须能从产物里解析到；
 *   3. 原生模块（.node）必须在产物里（包目录在、二进制不在，症状完全一样）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PACK = readFileSync(join(ROOT, 'scripts/pack-server.mjs'), 'utf8');
const SERVER_MANIFEST = JSON.parse(readFileSync(join(ROOT, 'server/package.json'), 'utf8'));
const BUNDLE_MODULES = join(ROOT, 'release/server/app/node_modules');

test('打包入口来自 package.json，不是手写列表', () => {
  // 判据：脚本里必须有"读 server/package.json 的 dependencies"这一步
  assert.match(
    PACK,
    /server['"],\s*['"]package\.json['"]/,
    'pack-server.mjs 没有读 server/package.json —— 说明清单还是手写的',
  );
  assert.match(PACK, /runtimeEntryNames/, '缺少从 manifest 派生入口的函数');

  // 反例守卫：这两个包名曾经被硬编码在 collectRuntimePackages 的调用处。
  // 如果它们又出现在"调用时传入的数组"里，说明有人退回了手工清单。
  assert.doesNotMatch(
    PACK,
    /collectRuntimePackages\(\s*\[/,
    'collectRuntimePackages 不能接收手写数组 —— 必须传 runtimeEntryNames()',
  );
});

test('server 的每个 dependencies 都出现在产物里', () => {
  const deps = Object.keys(SERVER_MANIFEST.dependencies ?? {});
  assert.ok(deps.length >= 5, `dependencies 数量异常：${String(deps.length)}`);

  // 产物可能还没生成（干净检出），此时跳过而不是误报
  if (!existsSync(BUNDLE_MODULES)) {
    assert.ok(true, '尚未执行 pack:server，跳过产物检查');
    return;
  }

  const missing = deps.filter(
    (name) => name !== '@tcs/shared' && !existsSync(join(BUNDLE_MODULES, name, 'package.json')),
  );
  assert.deepEqual(missing, [], `这些依赖没打进产物：${missing.join('、')}`);
});

test('关键原生模块的 .node 二进制在产物里', () => {
  if (!existsSync(BUNDLE_MODULES)) {
    assert.ok(true, '尚未执行 pack:server，跳过');
    return;
  }
  const binaries = [
    ['better-sqlite3', join(BUNDLE_MODULES, 'better-sqlite3/build/Release/better_sqlite3.node')],
    [
      '@node-rs/argon2-win32-x64-msvc',
      join(BUNDLE_MODULES, '@node-rs/argon2-win32-x64-msvc/argon2.win32-x64-msvc.node'),
    ],
  ];
  for (const [name, file] of binaries) {
    assert.ok(existsSync(file), `${name} 的 .node 二进制缺失：${file}`);
  }
});

test('@node-rs/argon2 的平台包必须与 host 架构匹配', () => {
  const pkgDir = join(ROOT, 'node_modules', '@node-rs', 'argon2');
  if (!existsSync(pkgDir)) {
    assert.ok(true, '未安装 argon2，跳过');
    return;
  }
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const optional = Object.keys(manifest.optionalDependencies ?? {});
  // 平台包是按 optionalDependencies 方式发布的：本机只会装其中一个。
  // 打包时必须把它带上，否则 argon2 的 JS 层找不到二进制。
  const expected = `@node-rs/argon2-${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`;
  assert.ok(
    optional.some((name) => name.startsWith(expected)),
    `optionalDependencies 里找不到 ${expected}*：${optional.join('、')}`,
  );

  if (existsSync(BUNDLE_MODULES)) {
    const installed = readdirSync(join(BUNDLE_MODULES, '@node-rs')).filter((name) => name.startsWith('argon2-'));
    assert.ok(
      installed.some((name) => name.startsWith(expected.replace('@node-rs/', ''))),
      `产物里没有 ${expected} 平台包，只有：${installed.join('、') || '（空）'}`,
    );
  }
});

test('selfcheck 命令存在，且能约束"只从包内解析"', () => {
  const SELFCHECK = readFileSync(join(ROOT, 'server/src/selfcheck.ts'), 'utf8');
  const CLI = readFileSync(join(ROOT, 'server/src/cli.ts'), 'utf8');

  // 四个依赖都要真跑一次，不能只 import
  for (const dep of ['@node-rs/argon2', '@peculiar/x509', 'better-sqlite3', 'isomorphic-git']) {
    assert.ok(SELFCHECK.includes(dep), `selfcheck 没有覆盖 ${dep}`);
  }
  // 约束能力：这是"包内缺依赖却从仓库根找到"的唯一防线
  assert.match(SELFCHECK, /requireInside/, 'selfcheck 缺 requireInside 守卫');
  assert.match(SELFCHECK, /fileURLToPath/, '路径归一必须用 fileURLToPath（自剥 file:// 在 Windows 上比不对）');

  // CLI 必须真的把参数传下去 —— 第一版忘了传，导致守门形同虚设
  assert.match(
    CLI,
    /selfCheckCommand\(\s*typeof bundleRoot === 'string'[^)]*\)/,
    'cli.ts 没有把 --bundle-root 传给 selfCheckCommand（参数没传 = 守卫从未生效）',
  );
});
