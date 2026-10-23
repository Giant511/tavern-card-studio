/**
 * 两个 `.cmd` 启动器的守卫（v0.1.2 追加任务）。
 *
 * 2026-10-23 生产反馈：`start-server.cmd user migrate Gez` 没有进 CLI，
 * 而是**起了一个 supervisor**，子命令被静默丢掉。原因：脚本把 `serve` 写死在
 * node 命令行里，再把 `%*` 拼在末尾 —— `serve … user migrate Gez`，
 * 而 CLI 取 `positional[0]` 当子命令，于是 `user` 成了被忽略的多余位置参数。
 *
 * 这些断言防的就是这类"脚本把参数吃掉"的回归：它们直接跑**生成函数**，
 * 而不是读打包产物（产物可能还没生成）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { INSTALL_LAYOUT_MARKER, buildLauncherCmd } from '../scripts/bundle-launchers.mjs';

const ROOT = join(import.meta.dirname, '..');
const start = buildLauncherCmd('start');
const cli = buildLauncherCmd('cli');

/** 找到真正执行 node 的那一行 */
function nodeLine(script) {
  const line = script
    .split('\r\n')
    .find((item) => item.includes('node.exe') && item.includes('index.js'));
  assert.ok(line, '脚本里必须有调用 node 的那一行');
  return line;
}

test('启动器不写死子命令：%* 决定跑什么', () => {
  for (const [name, script] of [
    ['start-server.cmd', start],
    ['tcs-server.cmd', cli],
  ]) {
    const line = nodeLine(script);
    // 整行里不能出现 `" serve` 这种把子命令写死的形态
    assert.doesNotMatch(line, /\bindex\.js"\s+serve\b/, `${name} 不能把 serve 写死在命令行里`);
    assert.match(line, /%\*$/, `${name} 必须以 %* 结尾，让用户参数原样透传`);
    assert.ok(
      line.indexOf('index.js') < line.indexOf('%*'),
      `${name} 的 %* 必须在 node 入口之后`,
    );
  }
});

test('默认值放在 %* 之前，用户自己的 --config 能覆盖', () => {
  const line = nodeLine(start);
  assert.ok(
    line.indexOf('--config') < line.indexOf('%*'),
    '--config 必须出现在 %* 之前，否则用户传的 --config 会被覆盖',
  );
  assert.match(line, /--rules-dir/);
});

test('配置解析顺序：TCS_CONFIG > MSI 标记 > 绿色包 data', () => {
  for (const [name, script] of [
    ['start-server.cmd', start],
    ['tcs-server.cmd', cli],
  ]) {
    const envAt = script.indexOf('if not "%TCS_CONFIG%"=="" goto run');
    const markerAt = script.indexOf('if not exist "%HERE%install-layout.ini" goto green');
    const programDataAt = script.indexOf('set "TCS_CONFIG=%ProgramData%\\TavernCardStudio\\config.json"');
    const greenAt = script.indexOf('set "TCS_CONFIG=%HERE%data\\config.json"');

    assert.ok(envAt > 0, `${name} 必须先看 TCS_CONFIG`);
    assert.ok(markerAt > envAt, `${name} 的环境变量判断要在标记判断之前`);
    assert.ok(programDataAt > markerAt, `${name} 的 MSI 分支要在标记判断之后`);
    assert.ok(greenAt > programDataAt, `${name} 的绿色包分支是兜底`);
  }
});

test('不得用"data\\config.json 是否存在"来猜布局', () => {
  // 那是猜：绿色包跑过一次就有这个文件；MSI 安装版被误跑一次也会有。
  // 猜错的后果是写进另一个库，而两处都不报错。
  for (const script of [start, cli]) {
    assert.ok(
      !/if exist "%HERE%data\\config\.json"/.test(script),
      '布局判别必须用 install-layout.ini 标记，不能靠 data\\config.json 是否存在',
    );
  }
});

test('脚本纯 ASCII（cmd.exe 按 OEM 代码页读，中文注释会乱码）', () => {
  for (const [name, script] of [
    ['start-server.cmd', start],
    ['tcs-server.cmd', cli],
  ]) {
    const nonAscii = [...script].filter((ch) => ch.codePointAt(0) > 127);
    assert.equal(nonAscii.length, 0, `${name} 含非 ASCII 字符：${nonAscii.join('')}`);
  }
});

test('MSI 布局标记文件与生成器里的常量一致（防两处漂移）', () => {
  const onDisk = readFileSync(join(ROOT, 'installer', 'install-layout.ini'), 'utf8').replace(/\r\n/g, '\n');
  const generated = INSTALL_LAYOUT_MARKER.replace(/\r\n/g, '\n');
  assert.equal(onDisk.trim(), generated.trim());
  assert.match(onDisk, /layout=msi/);
});

test('打 MSI 时确实把这个标记文件编进去', () => {
  const wxs = readFileSync(join(ROOT, 'installer', 'Product.wxs'), 'utf8');
  assert.match(wxs, /Id="LayoutMarkerComponent"/, 'Product.wxs 缺少标记组件');
  assert.match(wxs, /Name="install-layout\.ini"/, '组件里要有 install-layout.ini');
  assert.match(wxs, /<ComponentRef Id="LayoutMarkerComponent" \/>/, '组件没挂进 Feature 就不会安装');

  const build = readFileSync(join(ROOT, 'installer', 'build-msi.ps1'), 'utf8');
  assert.match(build, /'-d', "LayoutMarker=/, '构建脚本没把 LayoutMarker 传给 wix');
  assert.match(build, /install-layout\\\.ini/, '构建后内容断言要包含 install-layout.ini');
});

test('绿色包不生成布局标记（否则安装版与绿色包又分不清）', () => {
  const pack = readFileSync(join(ROOT, 'scripts', 'pack-server.mjs'), 'utf8');
  assert.ok(
    !pack.includes("writeFileSync(join(OUT, 'install-layout.ini')"),
    'pack-server 不得往绿色包里写 install-layout.ini',
  );
});
