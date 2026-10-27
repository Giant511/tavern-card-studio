/**
 * 契约对齐：`read_binary_file`（v0.1.4 / T12.3）。
 *
 * 契约层最容易出的错不是"实现写错"，而是**两侧慢慢分叉**：
 * TS 改了字段名、Rust 没改；或者 Rust 加了错误码，TS 的封闭集合里没有。
 * 这类错误在运行时表现为"字段是 undefined"，而 TypeScript 一句都不报
 * （IPC 边界上的对象是 `any`）。
 *
 * 所以这里不测"功能"，只测**两侧说的是同一件事**：
 *   ① TS 类型里有这个字段，Rust 结构体里也有（名字逐字对齐 camelCase）；
 *   ② 命令注册在 `invoke_handler!` 里，且 TS 侧调用名一致；
 *   ③ 错误码集合是本项目契约里已有的那套（不新增、不改名）；
 *   ④ 文档（docs/11）里登记了这个能力 —— **仅在文档存在时校验**。
 *
 * 关于 ④ 为什么要条件判断：`docs/11` 属于内部规范，按项目约定**不入库**
 * （`.gitignore` 只放行三份对外文档）。在干净 clone / CI 上它根本不存在，
 * 无条件断言会让这套测试一上来就红，而红的原因与本改动无关。
 * 契约的**机器判据**（①②③）全部落在仓库内文件上，文档只是给人看的补充。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const TYPES_TS = readFileSync(join(ROOT, 'client/src/contract/types.ts'), 'utf8');
const SHELL_TS = readFileSync(join(ROOT, 'client/src/contract/shell.ts'), 'utf8');
const COMMANDS_RS = readFileSync(join(ROOT, 'client/src-tauri/src/commands.rs'), 'utf8');
const LIB_RS = readFileSync(join(ROOT, 'client/src-tauri/src/lib.rs'), 'utf8');
const DOC_PATH = join(ROOT, 'docs/11-shell-capability-contract.md');
const DOC = existsSync(DOC_PATH) ? readFileSync(DOC_PATH, 'utf8') : '';

/** 从 TS 接口体里抠出字段名（只取 `name:` 形式） */
function tsFields(source, interfaceName) {
  const match = new RegExp(`export interface ${interfaceName}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  assert.notEqual(match, null, `TS 里找不到 interface ${interfaceName}`);
  const body = match[1];
  const fields = [];
  for (const line of body.split('\n')) {
    const field = /^\s{2}([a-zA-Z][a-zA-Z0-9]*)\??:/.exec(line);
    if (field !== null) fields.push(field[1]);
  }
  return fields;
}

/** 从 Rust 结构体里抠出字段名（`pub name: Type,`） */
function rustFields(source, structName) {
  const match = new RegExp(`pub struct ${structName}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  assert.notEqual(match, null, `Rust 里找不到 struct ${structName}`);
  const body = match[1];
  const fields = [];
  for (const line of body.split('\n')) {
    const field = /^\s*pub\s+([a-z_][a-z0-9_]*)\s*:/.exec(line);
    if (field !== null) fields.push(field[1]);
  }
  return fields;
}

function snakeToCamel(name) {
  return name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

test('BinaryFile：TS 与 Rust 的字段逐字对齐', () => {
  const ts = tsFields(TYPES_TS, 'BinaryFile');
  const rust = rustFields(COMMANDS_RS, 'BinaryFile').map(snakeToCamel);

  assert.deepEqual(
    ts,
    rust,
    '两侧字段不一致 —— serde 是 camelCase，所以 Rust 的 snake_case 换过来必须完全相同',
  );
  // 具体内容也钉一下，免得"两边一起改错"仍然通过
  assert.deepEqual(ts, ['pathDisplay', 'base64', 'bytesLen', 'sha256']);
});

test('BinaryFile：Rust 结构体带 camelCase 序列化', () => {
  // 结构体上方必须紧跟 `#[serde(rename_all = "camelCase")]`
  const index = COMMANDS_RS.indexOf('pub struct BinaryFile');
  assert.ok(index > 0);
  const before = COMMANDS_RS.slice(Math.max(0, index - 300), index);
  assert.ok(
    before.includes('rename_all = "camelCase"'),
    'BinaryFile 缺 serde camelCase 声明 —— 前端会拿到 path_display 这种 snake_case 字段',
  );
});

test('命令已注册，且 TS 调用名与 Rust 函数名一致', () => {
  assert.ok(
    LIB_RS.includes('commands::read_binary_file'),
    'read_binary_file 没有注册进 invoke_handler —— 前端调用会报 command not found',
  );
  assert.ok(
    COMMANDS_RS.includes('pub fn read_binary_file('),
    'Rust 侧没有 read_binary_file 函数',
  );
  assert.ok(
    SHELL_TS.includes("call<BinaryFile>('read_binary_file'"),
    'TS 侧调用名与 Rust 函数名不一致',
  );
});

test('错误码不新增：与 read_text_exact 完全同一套', () => {
  // 二进制读取**不该**有 NOT_UTF8（二进制没有非法字符这回事）。
  // 但其余错误必须同形，否则调用方要维护两套错误处理。
  const fn = /pub fn read_binary_file\([\s\S]*?\n\}/.exec(COMMANDS_RS);
  assert.notEqual(fn, null);
  const body = fn[0];

  for (const code of ['absolute_path', 'ensure_readable_file', 'ShellError::TooLarge', 'ShellError::io']) {
    assert.ok(body.includes(code), `read_binary_file 缺 ${code} —— 与 read_text_exact 不同形`);
  }
  assert.ok(!body.includes('NotUtf8'), '二进制读取不该产生 NOT_UTF8');
});

test('base64 编码器不经第三方 crate（换依赖要改这里）', () => {
  const cargo = readFileSync(join(ROOT, 'client/src-tauri/Cargo.toml'), 'utf8');
  assert.ok(!/^\s*base64\s*=/m.test(cargo), 'base64 改成了第三方 crate —— 同步删掉手写实现与它的 RFC 向量测试');
});

test('docs/11 登记了这项能力（文档存在时校验）', () => {
  if (DOC === '') {
    // 内部规范不入库：干净 clone 上不存在是正常的（见文件头 ④ 的说明）
    return;
  }
  assert.ok(DOC.includes('read_binary_file'), 'docs/11 的能力清单里没有 read_binary_file');
  assert.ok(DOC.includes('BinaryFile'), 'docs/11 的类型对齐表里没有 BinaryFile');
  assert.ok(DOC.includes('I8'), 'docs/11 的不变量里缺 I8（字节数与 sha256 描述原始字节）');
});

test('渲染层不直接 import @tauri-apps（能力只能经契约层）', () => {
  // 这条由 validate-config 强制；这里做交叉断言，避免那条检查被误删后无人发现
  const validate = readFileSync(join(ROOT, 'client/scripts/validate-config.mjs'), 'utf8');
  assert.ok(
    validate.includes("isContract") || validate.includes('src/contract'),
    'validate-config 里的"仅契约层可依赖 @tauri-apps"检查不见了',
  );
});
