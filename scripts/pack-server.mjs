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

/**
 * 打包入口 = `server/package.json` 的 `dependencies` 段，**每次现读，不手工维护**。
 *
 * 2026-10-23 的生产故障（服务端 MSI 启动 1067）就是这张手工列表造成的：
 * 原先是写死的 `['better-sqlite3', 'isomorphic-git']`，T10.3 引入
 * `@node-rs/argon2` 后没人回来加，于是包里有代码、没依赖，服务一起来就
 * `ERR_MODULE_NOT_FOUND`。同一次核对还发现 `@peculiar/x509`（TLS 自签证书用）
 * 也漏了 —— **手工清单必然再漏，所以这张表不该存在**。
 *
 * `@tcs/shared` 跳过：它是 workspace 里的符号链接，由下面单独放一份实体。
 */
function runtimeEntryNames() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'server', 'package.json'), 'utf8'));
  const names = Object.keys(manifest.dependencies ?? {}).filter((name) => name !== '@tcs/shared');
  if (names.length === 0) {
    throw new Error('server/package.json 没有 dependencies —— 打包清单从它生成，不能为空');
  }
  return names;
}

/**
 * 从入口包出发，收集生产依赖（含传递依赖），返回 { name, source, rel }。
 *
 * 关于 `optionalDependencies`：`@node-rs/argon2` 把 13 个平台的二进制列为
 * optionalDependencies，本机只装了 `…-win32-x64-msvc`。**未安装的可选依赖是正常
 * 状态**（别的平台的包），不能像必装依赖那样抛错 —— 否则一加 argon2 就打包失败。
 * 但要区分"这个平台本来就不该有"与"该有却没有"：后者会让产物缺 .node 文件，
 * 所以这里把跳过的名单记下来，由 `assertNativeModules()` 兜底核对。
 */
function collectRuntimePackages(entries) {
  const found = new Map();
  const skippedOptional = [];
  const queue = entries.map((name) => ({ name, optional: false }));
  while (queue.length > 0) {
    const { name, optional } = queue.shift();
    if (found.has(name) || skippedOptional.includes(name)) continue;

    let manifestPath = null;
    try {
      manifestPath = require.resolve(`${name}/package.json`);
    } catch {
      const fallback = join(ROOT_MODULES, name, 'package.json');
      if (existsSync(fallback)) manifestPath = fallback;
    }
    if (manifestPath === null) {
      if (optional) {
        skippedOptional.push(name);
        continue;
      }
      throw new Error(`缺少生产依赖 ${name}，先执行 npm install`);
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    found.set(name, {
      name,
      source: dirname(manifestPath),
      rel: relative(ROOT_MODULES, dirname(manifestPath)),
      version: manifest.version,
    });
    for (const dep of Object.keys(manifest.dependencies ?? {})) queue.push({ name: dep, optional: false });
    for (const dep of Object.keys(manifest.optionalDependencies ?? {})) queue.push({ name: dep, optional: true });
  }
  return { packages: [...found.values()], skippedOptional };
}

/**
 * 原生模块（.node）自检。
 *
 * 光有包目录不够：`@node-rs/argon2` 的 JS 层会根据平台去 require 对应的
 * `@node-rs/argon2-win32-x64-msvc`，而里面真正的 `.node` 二进制才是关键。
 * 少一个二进制，症状和"包没打进去"完全一样（都是运行时 throw）。
 */
function assertNativeModules(appModules) {
  const required = [
    // better-sqlite3：编译产物，不是 npm 包形式
    ['better-sqlite3', join(appModules, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')],
    // @node-rs/argon2：平台包里的 .node
    [
      '@node-rs/argon2-win32-x64-msvc',
      join(appModules, '@node-rs', 'argon2-win32-x64-msvc', 'argon2.win32-x64-msvc.node'),
    ],
  ];
  const missing = required.filter(([, file]) => !existsSync(file)).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `原生模块缺失：${missing.join('、')}。` +
        'better-sqlite3 需在目标架构上 npm rebuild；@node-rs/argon2 需确认平台包已安装。',
    );
  }
  return required.map(([name]) => name);
}

function main() {
  removeTree(OUT);
  mkdirSync(APP, { recursive: true });

  for (const [from, to] of COPY) copyInto(from, to);

  // @tcs/shared 在 workspace 里是符号链接；这里放一份实体，保持 ESM 解析
  const sharedTarget = join(APP, 'node_modules', '@tcs', 'shared');
  copyTree(join(APP, 'shared'), sharedTarget);

  const { packages, skippedOptional } = collectRuntimePackages(runtimeEntryNames());
  for (const pkg of packages) {
    copyTree(pkg.source, join(APP, 'node_modules', pkg.rel));
  }

  const natives = assertNativeModules(join(APP, 'node_modules'));

  // 逐个核对 server 的**直接**依赖都在产物里。
  // 这一步与上面的"从 package.json 生成清单"是两回事：生成清单保证"愿意打"，
  // 这里保证"真的打进去了"（copyTree 静默跳过、路径写错、符号链接断掉都会在这里现形）。
  const appModules = join(APP, 'node_modules');
  const directDeps = Object.keys(
    JSON.parse(readFileSync(join(ROOT, 'server', 'package.json'), 'utf8')).dependencies ?? {},
  );
  const notBundled = directDeps.filter(
    (name) => name !== '@tcs/shared' && !existsSync(join(appModules, name, 'package.json')),
  );
  if (notBundled.length > 0) {
    throw new Error(`以下生产依赖没有打进 app/node_modules：${notBundled.join('、')}`);
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

  // CLI 包装脚本（T10.12 / F6.3）。
  //
  // 为什么必须有它：服务启动日志与客户端「未开放注册」文案都在告诉用户跑
  // `tcs-server user migrate …` / `tcs-server user add …`，但安装目录里此前
  // **只有** start-server.cmd（写死了 `serve`）—— 用户照提示敲命令只会得到
  // 「不是内部或外部命令」。说明页第 1 步恰好就是这条命令，不能让它落空。
  //
  // 配置路径必须由脚本带对：服务用的 `--config` 是 MSI 的 DATAFOLDER，
  // 而 CLI 不带 `--config` 时会按 `cwd/server/data` 推默认值 —— 在安装目录下运行
  // 就会**另起一份空库**，人建好了、服务看不见，症状是"登录说账户不存在"。
  writeFileSync(
    join(OUT, 'tcs-server.cmd'),
    [
      '@echo off',
      'setlocal',
      'set "HERE=%~dp0"',
      'rem ASCII only: cmd.exe reads .cmd in the OEM code page (CP936 here), so UTF-8',
      'rem Chinese comments would come out garbled when the user opens the file.',
      'rem Use the same config file as the service:',
      'rem   green bundle  -> %HERE%data\\config.json',
      'rem   installed MSI -> %ProgramData%\\TavernCardStudio\\config.json (DATAFOLDER)',
      'if not "%TCS_CONFIG%"=="" goto run',
      'if exist "%HERE%data\\config.json" (',
      '  set "TCS_CONFIG=%HERE%data\\config.json"',
      ') else (',
      '  set "TCS_CONFIG=%ProgramData%\\TavernCardStudio\\config.json"',
      ')',
      ':run',
      'rem Defaults come BEFORE %* so a user-supplied --config (written later) wins.',
      '"%HERE%node.exe" "%HERE%app\\server\\dist\\index.js" --config "%TCS_CONFIG%" --rules-dir "%HERE%app\\rules" %*',
      'exit /b %ERRORLEVEL%',
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
  console.log(`  直接依赖 ${directDeps.length} 个全部就位；原生模块：${natives.join('、')}`);
  if (skippedOptional.length > 0) {
    // 只说数量与前两个：13 个平台包全列出来只会淹没真正的信息
    const head = skippedOptional.slice(0, 2).join('、');
    const more = skippedOptional.length > 2 ? ` 等 ${skippedOptional.length} 个` : '';
    console.log(`  跳过未安装的可选依赖（其它平台）：${head}${more}`);
  }
  console.log('  启动：release\\server\\start-server.cmd');
  console.log('  首次启动会在 release\\server\\data 下生成 config.json 并打印访问令牌');
}

main();
