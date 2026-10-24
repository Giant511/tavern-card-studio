/**
 * CLI 参数解析（T10.36 补）：`--version` / `--help` 别名 + 未知选项拒绝。
 *
 * 起因是一次真实事故：`node index.js --version` 用来做"打包产物能不能启动"的探针，
 * 结果 CLI 不认识 `--version`、位置参数为空，于是**静默落到 serve** ——
 * 起了一个真服务、在仓库根创建了 `data/config.json`、还往 stdout 打印了明文令牌。
 * 一个拼错的选项变成"启动生产服务"，这是最难归因的一类失败。
 *
 * 三层断言：
 *   ① `--version` / `--help` 被识别为子命令（等价写法）；
 *   ② 陌生选项**被记下来**（`unknownFlags`），不静默丢弃；
 *   ③ 正常启动路径不受影响（不带子命令仍落到 serve）。
 *
 * 为什么只测纯函数：本机 Node 无法 spawn 任何子进程（`execFileSync` 返回 EBUSY），
 * "真的退出码是 2"只能在 shell 里验，那一条由 `report:release` 第 3 节与手工命令覆盖。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs } from '../server/dist/cli.js';

test('--version 等价于 version 子命令（不再落到 serve）', () => {
  const options = parseArgs(['--version']);
  assert.equal(options.command, 'version');
  assert.deepEqual(options.unknownFlags, []);
  // 别名被消费掉，不能残留成未知选项
  assert.equal('version' in options.flags, false);
});

test('--help 是一个"请求帮助"标志，不顶掉子命令', () => {
  const options = parseArgs(['--help']);
  // 不转成 help 子命令：那会让 `config show --help` 也变成看总帮助
  assert.equal(options.helpRequested, true);
  assert.deepEqual(options.unknownFlags, []);
  // 无子命令时 command 仍是 serve，但分发处先看 helpRequested 并直接打印帮助
  assert.equal(options.command, 'serve');
});

test('拼错的选项被记进 unknownFlags（而不是静默起服务）', () => {
  const options = parseArgs(['--verison']);
  // command 仍是 serve —— 但调用方会先看 unknownFlags 并拒绝
  assert.equal(options.command, 'serve');
  assert.deepEqual(options.unknownFlags, ['verison']);
});

test('多个未知选项全部列出', () => {
  const options = parseArgs(['serve', '--verison', '--nope=1']);
  assert.deepEqual(options.unknownFlags, ['verison', 'nope']);
});

test('已知选项一个都不该被误判（含 = 形式与布尔开关）', () => {
  const options = parseArgs([
    'serve',
    '--config',
    'C:/tmp/c.json',
    '--port=8730',
    '--control-port',
    '8731',
    '--host',
    '127.0.0.1',
    '--control-host',
    '127.0.0.1',
    '--data-dir',
    'C:/tmp/store',
    '--rules-dir',
    'C:/tmp/rules',
    '--log-level',
    'warn',
    '--trust-proxy',
    '127.0.0.1',
    '--no-worker',
  ]);
  assert.deepEqual(options.unknownFlags, [], `误判：${options.unknownFlags.join(',')}`);
  assert.equal(options.overrides.port, 8730);
  assert.equal(options.overrides.controlPort, 8731);
  assert.equal(options.overrides.logLevel, 'warn');
});

test('卸载清理的选项也在白名单里（它不读配置，但选项必须被认）', () => {
  const options = parseArgs(['cleanup', '--install-dir', 'C:/tmp/x', '--data-dir', 'C:/tmp/y', '--log', 'C:/tmp/z', '--dry-run']);
  assert.deepEqual(options.unknownFlags, []);
  assert.equal(options.command, 'cleanup');
});

test('不带任何参数仍落到 serve（双击启动的行为不变）', () => {
  const options = parseArgs([]);
  assert.equal(options.command, 'serve');
  assert.deepEqual(options.unknownFlags, []);
});

test('--help 与子命令混写时子命令保持不变（这条是第一版写错的地方）', () => {
  // 第一版把 `help` unshift 进 positional 最前面，于是 `config show --help`
  // 变成 command=help、positional=['help','config','show'] —— 想查的命令被顶掉了。
  const options = parseArgs(['config', 'show', '--help']);
  assert.equal(options.command, 'config');
  assert.deepEqual(options.positional, ['config', 'show']);
  assert.equal(options.helpRequested, true);
  assert.equal('help' in options.flags, false, '--help 必须被消费掉，不能落进未知选项');
});

test('--version 只在没有子命令时才当命令（有子命令时按未知选项拒绝）', () => {
  assert.equal(parseArgs(['--version']).command, 'version');
  const mixed = parseArgs(['config', 'show', '--version']);
  assert.equal(mixed.command, 'config');
  // 保留为未知选项：静默打印版本再退出会让人以为命令跑过了
  assert.deepEqual(mixed.unknownFlags, ['version']);
});
