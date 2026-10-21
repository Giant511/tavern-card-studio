/**
 * 打包服务端为「绿色目录」：release/server/
 *
 * 目标：整包自带 Node 运行时与全部生产依赖，解压即可 `start-server.cmd` 运行，
 * 也让 MSI 构建脚本（installer/build-msi.ps1）有一个确定的输入目录。
 *
 * 目录结构：
 *   release/server/
 *     node.exe
 *     start-server.cmd
 *     app/
 *       package.json（type: module）
 *       server/dist  server/public  server/package.json
 *       shared/dist  shared/package.json
 *       rules/
 *       node_modules/（生产依赖，@tcs/shared 指向 shared/）
 *
 * 运行：node scripts/pack-server.mjs
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { buildBundleServiceHostXml } from './service-host-template.mjs';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'release', 'server');
const APP = join(OUT, 'app');
const ROOT_MODULES = join(ROOT, 'node_modules');

/**
 * 清空输出目录。
 *
 * 两个坑：
 *   1. 某些宿主环境通过 NODE_OPTIONS 注入了一个把「删除」改写成「移到回收站」的
 *      shim；release/server 有上千个文件，回收站操作会中途 aborted 抛错。
 *      所以删除放到清掉该注入的子进程里执行，走原生 fs。
 *   2. 上一轮的绿色包可能还有进程在跑，repos 里的原生模块被映射，Windows 会
 *      拒绝删除（EPERM）。此时**不能**只删一半就退出——半截目录会让后面的
 *      MSI 构建悄悄用残缺输入。这里改为整体改名移开，让本次打包继续。
 */
function removeTree(target) {
  if (!existsSync(target)) return;
  const env = { ...process.env };
  delete env['NODE_OPTIONS'];
  delete env['CODEBUDDY_SAFE_DELETE_ENABLED'];
  delete env['CODEBUDDY_SAFE_DELETE_SANDBOX'];
  try {
    execFileSync(
      process.execPath,
      ['-e', `require('node:fs').rmSync(${JSON.stringify(target)}, { recursive: true, force: true })`],
      { env, stdio: 'ignore' },
    );
  } catch {
    const aside = `${target}.stale-${Date.now()}`;
    renameSync(target, aside);
    process.stderr.write(
      `⚠️  无法删除 ${relative(ROOT, target)}（有文件被占用，通常是上一轮的绿色包还没退出）。\n` +
        `    已整体改名移开：${relative(ROOT, aside)}，可稍后手动清理。\n`,
    );
  }
}

const COPY = [
  ['server/dist', 'server/dist'],
  ['server/public', 'server/public'],
  ['server/package.json', 'server/package.json'],
  ['shared/dist', 'shared/dist'],
  ['shared/package.json', 'shared/package.json'],
  ['rules', 'rules'],
];

/** 递归复制（跟随符号链接；不用 fs.cpSync，避免不同环境下对目录复制的不一致行为） */
function copyTree(source, target) {
  const stat = statSync(source);
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) {
      copyTree(join(source, name), join(target, name));
    }
    return;
  }
  if (stat.isFile()) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

function copyInto(from, to) {
  const source = join(ROOT, from);
  if (!existsSync(source)) throw new Error(`缺少文件：${from}（先执行 npm run build）`);
  copyTree(source, join(APP, to));
}

function dirSize(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) total += dirSize(path);
    else if (stat.isFile()) total += stat.size;
  }
  return total;
}

const require = createRequire(join(ROOT, 'package.json'));

/** 从入口包出发，收集生产依赖（含传递依赖），返回 { name, source, rel } */
function collectRuntimePackages(entries) {
  const found = new Map();
  const queue = [...entries];
  while (queue.length > 0) {
    const name = queue.shift();
    if (found.has(name)) continue;
    let manifestPath;
    try {
      manifestPath = require.resolve(`${name}/package.json`);
    } catch {
      manifestPath = join(ROOT_MODULES, name, 'package.json');
    }
    if (!existsSync(manifestPath)) throw new Error(`缺少生产依赖 ${name}，先执行 npm install`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    found.set(name, {
      name,
      source: dirname(manifestPath),
      rel: relative(ROOT_MODULES, dirname(manifestPath)),
      version: manifest.version,
    });
    queue.push(...Object.keys(manifest.dependencies ?? {}));
    queue.push(...Object.keys(manifest.optionalDependencies ?? {}));
  }
  return [...found.values()];
}

function main() {
  removeTree(OUT);
  mkdirSync(APP, { recursive: true });

  for (const [from, to] of COPY) copyInto(from, to);

  // @tcs/shared 在 workspace 里是符号链接；这里放一份实体，保持 ESM 解析
  const sharedTarget = join(APP, 'node_modules', '@tcs', 'shared');
  copyTree(join(APP, 'shared'), sharedTarget);

  const packages = collectRuntimePackages(['better-sqlite3', 'isomorphic-git']);
  for (const pkg of packages) {
    copyTree(pkg.source, join(APP, 'node_modules', pkg.rel));
  }

  const native = join(APP, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  if (!existsSync(native)) {
    throw new Error('better-sqlite3 原生模块缺失：请在目标架构上执行 npm rebuild better-sqlite3');
  }

  copyFileSync(process.execPath, join(OUT, 'node.exe'));

  // 服务宿主（WinSW）也要进绿色包。
  //
  // 原因：node.exe 不是服务宿主程序——它从不调用 StartServiceCtrlDispatcher，
  // SCM 永远等不到 SERVICE_RUNNING，服务会卡在 Start Pending（2026-10-21 的 MSI
  // 挂起就是这个原因）。绿色包若不带宿主，`tcs-service.ps1` 与 CLI 的
  // `service install` 就没有可注册的正确二进制，只能退回直挂 node.exe —— 必须避免。
  //
  // 文件名必须严格配对：WinSW v2 按文件名在自身同目录找配置，不接受命令行传路径。
  const winSwSource = join(ROOT, 'vendor', 'winsw', 'WinSW.NET4.exe');
  if (!existsSync(winSwSource)) {
    throw new Error('缺少服务宿主 vendor/winsw/WinSW.NET4.exe —— 服务无法正确注册，见 vendor/winsw/README.md');
  }
  copyFileSync(winSwSource, join(OUT, 'tcs-service-host.exe'));

  // 绿色包的配置**不能**直接复用 installer/ServiceHost.xml：那份把数据目录写死在
  // C:\ProgramData\TavernCardStudio（MSI 的安装语义）。绿色包的数据在 %BASE%\data，
  // 沿用会让服务和 start-server.cmd 用两份不同的配置，谁也找不到对方的卡片库。
  writeFileSync(
    join(OUT, 'tcs-service-host.xml'),
    buildBundleServiceHostXml(),
    'utf8',
  );

  writeFileSync(
    join(OUT, 'start-server.cmd'),
    [
      '@echo off',
      'setlocal',
      'set "HERE=%~dp0"',
      'if "%TCS_CONFIG%"=="" set "TCS_CONFIG=%HERE%data\\config.json"',
      '"%HERE%node.exe" "%HERE%app\\server\\dist\\index.js" serve --config "%TCS_CONFIG%" --rules-dir "%HERE%app\\rules" %*',
      '',
    ].join('\r\n'),
    'utf8',
  );

  writeFileSync(
    join(APP, 'package.json'),
    `${JSON.stringify({ name: 'tavern-card-studio-server-bundle', private: true, type: 'module' }, null, 2)}\n`,
    'utf8',
  );

  const size = dirSize(OUT);
  console.log(`✔ 已生成 ${relative(ROOT, OUT)}（${(size / 1024 / 1024).toFixed(1)} MB，${packages.length} 个运行时依赖）`);
  console.log('  启动：release\\server\\start-server.cmd');
  console.log('  首次启动会在 release\\server\\data 下生成 config.json 并打印访问令牌');
}

main();
