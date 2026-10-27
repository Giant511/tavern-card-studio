/**
 * 契约对齐：预设库的三条命令（v0.1.5 / G5）。
 *
 * 与 `contract-binary.test.mjs` 同一思路 —— 不测功能，只测**两侧说的是同一件事**：
 *   ① TS 的函数名与 Rust 命令名逐字一致，且都注册在 `invoke_handler!` 里；
 *   ② 渲染层**没有**任何"自己拼预设库路径"的代码（那是 I9 的核心）；
 *   ③ 文档登记（仅在 docs/11 存在时校验，它是内部规范、不入库）。
 *
 * ②是本轮最要紧的一条：预设库路径一旦由渲染层拼出来，路径策略变化时
 * 表现是"预设又丢了"，而排查的人会去查"保存逻辑有没有跑"，不会想到路径。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const SHELL_TS = readFileSync(join(ROOT, 'client/src/contract/shell.ts'), 'utf8');
const COMMANDS_RS = readFileSync(join(ROOT, 'client/src-tauri/src/commands.rs'), 'utf8');
const LIB_RS = readFileSync(join(ROOT, 'client/src-tauri/src/lib.rs'), 'utf8');
const DOC_PATH = join(ROOT, 'docs/11-shell-capability-contract.md');
const DOC = existsSync(DOC_PATH) ? readFileSync(DOC_PATH, 'utf8') : '';

const COMMANDS = ['read_preset_library', 'write_preset_library'];

test('两条命令都注册在 invoke_handler! 里（没注册 = 运行时 "command not found"）', () => {
  for (const name of COMMANDS) {
    assert.match(LIB_RS, new RegExp(`commands::${name}`), `${name} 没注册`);
  }
});

test('Rust 侧定义了命令，TS 侧调用的名字逐字相同', () => {
  for (const name of COMMANDS) {
    assert.ok(COMMANDS_RS.includes(`pub fn ${name}(`), `Rust 里没有 ${name}`);
    assert.ok(SHELL_TS.includes(`'${name}'`), `TS 侧没有调用 ${name}（IPC 名不一致会静默失败）`);
  }
});

test('读写都走同一个路径解析函数（渲染层传不了路径）', () => {
  for (const name of COMMANDS) {
    const at = COMMANDS_RS.indexOf(`pub fn ${name}(`);
    assert.notEqual(at, -1);
    // 取函数签名到下一个 tauri::command 之间的片段
    const body = COMMANDS_RS.slice(at, at + 900);
    assert.match(body, /preset_library_path\(/, `${name} 没有用 preset_library_path 解析路径`);
    assert.ok(!body.includes('path: String'), `${name} 不该接受 path 参数（违反 I9）`);
  }
});

test('读：文件不存在返回 None 而不是报错（I10）', () => {
  const at = COMMANDS_RS.indexOf('pub fn read_preset_library(');
  const body = COMMANDS_RS.slice(at, at + 700);
  assert.match(body, /Option<TextFile>/, '返回类型必须是 Option<TextFile>');
  assert.match(body, /if !target\.exists\(\)/, '要先判断文件是否存在');
  assert.match(body, /Ok\(None\)/, '不存在时返回 None');
});

test('写：与 write_file_atomic 共用 write_atomic_impl（原子性不许在一条路径上退化）', () => {
  const at = COMMANDS_RS.indexOf('pub fn write_preset_library(');
  const body = COMMANDS_RS.slice(at, at + 900);
  assert.match(body, /write_atomic_impl\(/, '必须复用 write_atomic_impl');
  assert.match(body, /create_dir_all/, '应用配置目录可能不存在，要按需创建');
});

test('渲染层没有解析/拼装预设库路径（I9：位置只有壳知道）', () => {
  /*
   * 禁止的是**路径解析 API**（`app_config_dir` 之类），不是文件名本身。
   * 提示文案里提一句 `preset-library.json` 是好事 —— 用户出问题时知道去哪看。
   * 真正要防的是渲染层自己算出目录再拼。
   */
  const files = [
    'client/src/editor/app.ts',
    'client/src/rules/preset-persist.ts',
    'client/src/rules/preset-store.ts',
    'client/src/rules/preset-library.ts',
  ];
  for (const file of files) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    for (const needle of ['app_config_dir', 'appConfigDir', 'appDataDir', 'APPDATA']) {
      assert.ok(
        !source.includes(needle),
        `${file} 里出现了 ${needle} —— 预设库位置只能由壳解析（docs/11 I9）`,
      );
    }
  }
});

test('preset-persist 不 import contract（依赖倒置：IO 由 App 注入，才测得动时序）', () => {
  const source = readFileSync(join(ROOT, 'client/src/rules/preset-persist.ts'), 'utf8');
  assert.ok(
    !/from '\.\.\/contract/.test(source),
    'preset-persist 直接依赖 contract 了 —— 那它就无法在 Node 里单测',
  );
});

test('docs/11 登记了 C9 与 I9/I10（文档存在时校验）', () => {
  if (DOC === '') return; // 内部规范不入库，干净 clone 上不存在是正常的
  assert.ok(DOC.includes('read_preset_library'), 'docs/11 能力清单里没有 read_preset_library');
  assert.ok(DOC.includes('| C9 |'), 'docs/11 里缺 C9 这一行');
  assert.ok(DOC.includes('| I9 |'), 'docs/11 不变量缺 I9（路径只有一处知道）');
  assert.ok(DOC.includes('| I10 |'), 'docs/11 不变量缺 I10（文件不存在不是错误）');
});
