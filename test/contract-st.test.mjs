/**
 * 契约对齐：F15 / T13.1 的四条原生能力（`probe_paths` / `find_st_candidates` /
 * `extract_zip_to` / `spawn_detached`）+ 恢复的 `open_external`。
 *
 * 与 `contract-binary.test.mjs` 同一条思路：不测"功能"，测**两侧说的是同一件事**。
 * 这里额外多一类断言 —— **安全约束必须在壳侧**（判据、白名单、沙箱边界），
 * 因为它们最容易在后续重构里被"顺手挪到前端"。挪走了功能照样能用，
 * 但任何能触发前端的人都能启动任意程序，而测试不会红。
 *
 * 所以本文件里有一组"静态顺序断言"：例如"ST 判据必须出现在 spawn 之前"。
 * 这类断言看着笨，抓的正是"检查还在、但已经不再拦任何东西"的那种退化。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const TYPES_TS = readFileSync(join(ROOT, 'client/src/contract/types.ts'), 'utf8');
const SHELL_TS = readFileSync(join(ROOT, 'client/src/contract/shell.ts'), 'utf8');
const ERRORS_TS = readFileSync(join(ROOT, 'client/src/contract/errors.ts'), 'utf8');
const COMMANDS_RS = readFileSync(join(ROOT, 'client/src-tauri/src/commands.rs'), 'utf8');
const ERROR_RS = readFileSync(join(ROOT, 'client/src-tauri/src/error.rs'), 'utf8');
const LIB_RS = readFileSync(join(ROOT, 'client/src-tauri/src/lib.rs'), 'utf8');
const HEX_HTML = readFileSync(join(ROOT, 'client/index.html'), 'utf8');
const DOC_PATH = join(ROOT, 'docs/11-shell-capability-contract.md');
const DOC = existsSync(DOC_PATH) ? readFileSync(DOC_PATH, 'utf8') : '';

function tsFields(source, interfaceName) {
  const match = new RegExp(`export interface ${interfaceName}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  assert.notEqual(match, null, `TS 里找不到 interface ${interfaceName}`);
  const fields = [];
  for (const line of match[1].split('\n')) {
    const field = /^\s{2}([a-zA-Z][a-zA-Z0-9]*)\??:/.exec(line);
    if (field !== null) fields.push(field[1]);
  }
  return fields;
}

function rustFields(source, structName) {
  const match = new RegExp(`pub struct ${structName}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  assert.notEqual(match, null, `Rust 里找不到 struct ${structName}`);
  const fields = [];
  for (const line of match[1].split('\n')) {
    const field = /^\s*pub\s+([a-z_][a-z0-9_]*)\s*:/.exec(line);
    if (field !== null) fields.push(field[1]);
  }
  return fields;
}

function snakeToCamel(name) {
  return name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

const STRUCT_PAIRS = [
  ['PathProbe', ['path', 'exists']],
  ['StCandidates', ['home', 'dirs']],
  ['SpawnReceipt', ['pid', 'logPath']],
  ['ExtractReceipt', ['destPath', 'hasStStructure']],
  ['PortProbe', ['alive', 'host', 'port', 'elapsedMs', 'errorKind', 'errorMessage']],
];

for (const [name, expected] of STRUCT_PAIRS) {
  test(`${name}：TS 与 Rust 的字段逐字对齐`, () => {
    const ts = tsFields(TYPES_TS, name);
    const rust = rustFields(COMMANDS_RS, name).map(snakeToCamel);
    assert.deepEqual(ts, rust, `${name} 两侧字段不一致（serde 是 camelCase）`);
    assert.deepEqual(ts, expected, `${name} 的字段集合本身也钉一下`);
  });

  test(`${name}：Rust 结构体带 camelCase 序列化`, () => {
    const index = COMMANDS_RS.indexOf(`pub struct ${name}`);
    assert.ok(index > 0);
    const before = COMMANDS_RS.slice(Math.max(0, index - 300), index);
    assert.ok(before.includes('rename_all = "camelCase"'));
  });
}

test('六条命令都注册在 invoke_handler 里，且 TS 调用名一致', () => {
  const pairs = [
    ['probe_paths', 'probePaths'],
    ['find_st_candidates', 'findStCandidates'],
    ['probe_st_alive', 'probeStAlive'],
    ['extract_zip_to', 'extractZipTo'],
    ['spawn_detached', 'spawnDetached'],
    ['open_external', 'openExternal'],
  ];
  for (const [command, tsName] of pairs) {
    assert.ok(LIB_RS.includes(`commands::${command}`), `${command} 没注册进 invoke_handler`);
    assert.ok(COMMANDS_RS.includes(`pub fn ${command}(`), `Rust 侧没有 ${command}`);
    assert.ok(SHELL_TS.includes(`'${command}'`), `契约层没有调用 ${command}（${tsName}）`);
  }
});

test('probe_st_alive：只连回环，不接受主机名（不是端口扫描器）', () => {
  const signature = /pub fn probe_st_alive\(([^)]*)\)/.exec(COMMANDS_RS);
  assert.notEqual(signature, null, 'Rust 侧没有 probe_st_alive');
  // 只允许 port 参数 —— 出现 host 参数就说明它能把探测打到别的机器上
  assert.ok(signature[1].includes('port'), 'probe_st_alive 丢了 port 参数');
  assert.ok(!/host\s*:/.test(signature[1]), 'probe_st_alive 不该接受 host 参数（只能探本机回环）');

  const body = /pub fn probe_st_alive\([\s\S]*?\n\}/.exec(COMMANDS_RS);
  assert.notEqual(body, null);
  assert.ok(body[0].includes('127, 0, 0, 1'), '主机名必须写死 127.0.0.1');
  assert.ok(body[0].includes('connect_timeout'), '必须带超时，否则端口被黑洞吞掉时会挂死 UI');
});

test('spawn_detached 失败时必须写诊断日志（生产反馈：日志 0 字节）', () => {
  const body = /pub fn spawn_detached\([\s\S]*?\n\}/.exec(COMMANDS_RS);
  assert.notEqual(body, null);
  assert.ok(
    body[0].includes('spawn_detached FAILED'),
    '启动失败路径必须落一条带 cmd/cwd/原始错误的诊断日志，否则线上只能看到一句"启动失败"',
  );
});

test('启动白名单：TS 类型与 Rust 常量逐字一致', () => {
  const rustLine = /pub const SPAWN_TARGETS: \[&str; 3\] = \[(.*?)\];/.exec(COMMANDS_RS);
  assert.notEqual(rustLine, null, 'Rust 侧的 SPAWN_TARGETS 变了名字或形状');
  const rustTargets = rustLine[1].split(',').map((item) => item.trim().replace(/"/g, ''));

  const tsLine = /export type SpawnTarget = ([^;]+);/.exec(TYPES_TS);
  assert.notEqual(tsLine, null, 'TS 侧没有 SpawnTarget 类型');
  const tsTargets = tsLine[1].split('|').map((item) => item.trim().replace(/'/g, ''));

  assert.deepEqual(tsTargets, rustTargets, '两侧白名单必须一模一样');
  assert.deepEqual(rustTargets, ['start.bat', 'node.exe', 'server.js']);
});

test('安全约束在壳侧：ST 判据必须出现在 spawn 之前', () => {
  const body = /pub fn spawn_detached\([\s\S]*?\n\}/.exec(COMMANDS_RS);
  assert.notEqual(body, null);
  const source = body[0];

  const checkIndex = source.indexOf('looks_like_st_root(&target_dir)');
  const spawnIndex = source.indexOf('.spawn()');
  assert.ok(checkIndex > 0, 'spawn_detached 里没有 ST 判据 —— 任意目录的 start.bat 都能被拉起');
  assert.ok(spawnIndex > 0);
  assert.ok(
    checkIndex < spawnIndex,
    'ST 判据必须在 spawn 之前（放到后面等于没检查：进程已经起来了）',
  );

  const allowIndex = source.indexOf('SPAWN_TARGETS.contains');
  assert.ok(allowIndex > 0 && allowIndex < spawnIndex, '白名单校验也必须在 spawn 之前');
});

test('spawn_detached 不接受任意可执行文件：没有通用 command 参数', () => {
  const signature = /pub fn spawn_detached\(([^)]*)\)/.exec(COMMANDS_RS);
  assert.notEqual(signature, null);
  // 只有 app + cmd + cwd；出现 args / exe / path 这类参数就说明白名单被绕开了
  assert.ok(signature[1].includes('cmd: String'), 'cmd 参数名变了');
  assert.ok(!/args\s*:/.test(signature[1]), '不该接受自由参数数组');
});

test('解压的沙箱边界：目标必须落在用户主目录下', () => {
  const body = /pub fn extract_zip_to\([\s\S]*?\n\}/.exec(COMMANDS_RS);
  assert.notEqual(body, null);
  assert.ok(
    body[0].includes('canonical_dest.starts_with(&canonical_home)'),
    'extract_zip_to 少了"只能解到用户主目录下"的校验',
  );
  assert.ok(body[0].includes('PathNotAllowed'), '越界时必须报 PATH_NOT_ALLOWED');
});

test('open_external：只放行 http/https，且拒绝控制字符', () => {
  const body = /pub fn open_external\([\s\S]*?\n\}/.exec(COMMANDS_RS);
  assert.notEqual(body, null);
  assert.ok(body[0].includes('starts_with("http://")'));
  assert.ok(body[0].includes('starts_with("https://")'));
  assert.ok(body[0].includes('is_control'), '控制字符必须拒（URL 拼接被污染的迹象）');
});

test('新增两个错误码，两侧都有', () => {
  for (const code of ['TOO_MANY_PATHS', 'SPAWN_REJECTED']) {
    assert.ok(ERROR_RS.includes(`"${code}"`), `error.rs 缺 ${code}`);
    assert.ok(ERRORS_TS.includes(`'${code}'`), `errors.ts 缺 ${code}`);
  }
  // SPAWN_REJECTED 与 PATH_NOT_ALLOWED 必须是两个码：前者是"这不是 ST"（正常状态），
  // 后者是越权尝试。混成一个会让 UI 把"还没装 ST"报成安全错误。
  assert.ok(ERRORS_TS.includes("| 'PATH_NOT_ALLOWED'"));
});

test('顶栏有 F15 的入口按钮，且在零标签时会被禁用', () => {
  assert.ok(HEX_HTML.includes('id="btn-st"'), 'index.html 里没有 ST 入口');
  assert.ok(HEX_HTML.includes('在 SillyTavern 中测试'), '按钮文案与需求不一致');
  const app = readFileSync(join(ROOT, 'client/src/editor/app.ts'), 'utf8');
  assert.ok(
    /for \(const id of \[[^\]]*'btn-st'[^\]]*\]/.test(app),
    'btn-st 没进 setCardActionEnabled 的清单 —— 零标签时点它会因为没有活动会话而抛错',
  );
});

test('渲染层不自己拼 ST 的 URL 常量（统一从 st-install 取）', () => {
  const dialog = readFileSync(join(ROOT, 'client/src/session/st-dialog.ts'), 'utf8');
  assert.ok(!dialog.includes("'http://127.0.0.1:8000'"), 'st-dialog 里硬编码了 ST 地址，应当用 ST_BASE_URL');
  assert.ok(dialog.includes('ST_BASE_URL'));
});

test('docs/11 登记了这六项能力（文档存在时校验）', () => {
  if (DOC === '') return; // 内部规范不入库，干净 clone 上不存在是正常的
  for (const needle of [
    'probe_paths',
    'find_st_candidates',
    'probe_st_alive',
    'extract_zip_to',
    'spawn_detached',
    'open_external',
  ]) {
    assert.ok(DOC.includes(needle), `docs/11 的能力清单里没有 ${needle}`);
  }
  for (const type of ['PathProbe', 'StCandidates', 'PortProbe', 'SpawnReceipt', 'ExtractReceipt']) {
    assert.ok(DOC.includes(type), `docs/11 的类型对齐表里没有 ${type}`);
  }
});
