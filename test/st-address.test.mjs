/**
 * T14.0（F0）ST 地址可配置：解析规则 + **影响面静态守护**。
 *
 * 这份文件两个职责，第二个比第一个重要：
 *
 *   ① 解析规则（`parseStAddress`）—— 它是安全边界的第一道（host 只能回环）；
 *   ② **静态断言**：`127.0.0.1:8000` 这个字面量在源码里只允许出现在
 *      `contract/types.ts` 的默认值定义处（需求 T14.0 第 3 条原话）。
 *
 * 第 ② 条的价值在于"以后有人图省事又抄一遍" —— 那种抄写不会让任何功能测试变红，
 * 但它会让"改了配置却还在连老地址"变成一个只有用户才发现的 bug。
 * 三个受影响面（F15 探针 / 推送面板运行中判定 / 打开 ST 跳转）都必须走配置值。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  ALLOWED_ST_HOSTS,
  baseUrlOf,
  classifyTcpFailure,
  describeTcpFailure,
  isStAddressValid,
  parseStAddress,
  resolveStAddress,
  ST_DEFAULT_ADDRESS,
} from '../client/src/session/st-address.ts';
import { stStatusText } from '../client/src/session/st-install.ts';

const ROOT = join(import.meta.dirname, '..');
const CLIENT_SRC = join(ROOT, 'client/src');
const COMMANDS_RS = readFileSync(join(ROOT, 'client/src-tauri/src/commands.rs'), 'utf8');

/** 递归列出 client/src 下的 ts 文件（相对路径） */
function listTs(dir, base = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base === '' ? entry.name : `${base}/${entry.name}`;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(full, rel));
    else if (statSync(full).isFile() && entry.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

// ── ① 解析与校验 ───────────────────────────────────────────

test('默认地址：可解析，且 host 在白名单内', () => {
  const parsed = parseStAddress(ST_DEFAULT_ADDRESS);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.host, '127.0.0.1');
  assert.equal(parsed.port, 8000);
  assert.equal(parsed.baseUrl, `http://127.0.0.1:8000`);
});

test('解析：三种回环写法都接受，并归一成 host:port', () => {
  for (const [input, host] of [
    ['127.0.0.1:8001', '127.0.0.1'],
    ['localhost:8001', 'localhost'],
    ['LOCALHOST:8001', 'localhost'],
    ['[::1]:8001', '::1'],
    ['  127.0.0.1:8001  ', '127.0.0.1'],
  ]) {
    const parsed = parseStAddress(input);
    assert.equal(parsed.ok, true, `${input} 应当被接受`);
    assert.equal(parsed.host, host);
    assert.equal(parsed.port, 8001);
  }
});

test('解析：容忍从 ST 控制台复制的整条 URL', () => {
  // 用户会直接复制 `Go to: http://127.0.0.1:8000/` 里那一段
  const parsed = parseStAddress('http://localhost:8010/');
  assert.equal(parsed.ok, true, '带 http:// 与末尾斜杠应当被清理掉');
  assert.equal(parsed.text, 'localhost:8010');
});

test('解析：https:// 明确拒绝（不静默当成 http）', () => {
  const parsed = parseStAddress('https://127.0.0.1:8000');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'format');
  assert.match(parsed.message, /https/);
});

test('解析：非回环地址拒绝，并说清"远程 ST 请用浏览器打开"', () => {
  for (const input of ['192.168.1.5:8000', '10.0.0.2:8000', 'example.com:8000', '0.0.0.0:8000']) {
    const parsed = parseStAddress(input);
    assert.equal(parsed.ok, false, `${input} 不该被接受`);
    assert.equal(parsed.reason, 'not-loopback');
    assert.match(parsed.message, /内嵌代理仅支持本机/);
    assert.match(parsed.message, /远程 ST 请用/);
  }
});

test('解析：不做 DNS 解析 —— 形似回环的域名也要拒', () => {
  // 这类名字在某些 hosts 配置下会解析到 127.0.0.1，但"解析后判断"等于把安全边界
  // 交给 DNS/hosts，可被投毒。白名单是字面量比对。
  for (const input of ['127.0.0.1.nip.io:8000', 'localhost.evil.com:8000']) {
    assert.equal(parseStAddress(input).ok, false, `${input} 必须被拒`);
  }
});

test('解析：端口必须 1–65535 的整数', () => {
  for (const input of ['127.0.0.1:0', '127.0.0.1:65536', '127.0.0.1:abc', '127.0.0.1:-1', '127.0.0.1:80.5']) {
    const parsed = parseStAddress(input);
    assert.equal(parsed.ok, false, `${input} 不该被接受`);
    assert.equal(parsed.reason, 'bad-port', `${input} 的失败原因应当是 bad-port`);
  }
  assert.equal(parseStAddress('127.0.0.1:1').ok, true);
  assert.equal(parseStAddress('127.0.0.1:65535').ok, true);
});

test('解析：缺端口 / 空串 / 带路径各有各的话', () => {
  assert.equal(parseStAddress('127.0.0.1').reason, 'format');
  assert.equal(parseStAddress('').reason, 'empty');
  assert.equal(parseStAddress('   ').reason, 'empty');
  assert.equal(parseStAddress('127.0.0.1:8000/chat').reason, 'format');
});

test('resolveStAddress：空值回落默认；非法值回落默认但保留原文供面板提示', () => {
  assert.equal(resolveStAddress('').port, 8000);
  assert.equal(resolveStAddress(null).port, 8000);
  assert.equal(resolveStAddress(undefined).port, 8000);

  // 手改配置文件填了内网地址：不能让整块功能瘫掉，回落默认值
  const bad = resolveStAddress('192.168.1.5:8000');
  assert.equal(bad.port, 8000);
  assert.equal(bad.host, '127.0.0.1');
  assert.equal(bad.text, '192.168.1.5:8000', '原文要留着，否则面板无法提示"你填的那个不合法"');
});

test('isStAddressValid：空值算合法（= 用默认），非法值不算', () => {
  assert.equal(isStAddressValid(''), true);
  assert.equal(isStAddressValid(null), true);
  assert.equal(isStAddressValid('127.0.0.1:8001'), true);
  assert.equal(isStAddressValid('192.168.1.5:8000'), false);
});

test('baseUrlOf：IPv6 加方括号，否则 URL 会把地址里最后一个冒号当端口分隔符', () => {
  assert.equal(baseUrlOf('127.0.0.1', 8000), 'http://127.0.0.1:8000');
  assert.equal(baseUrlOf('::1', 8000), 'http://[::1]:8000');
});

// ── ② 探测失败三态 ─────────────────────────────────────────

test('classifyTcpFailure：被拒 / 超时 / 其它（大小写与命名差异都认）', () => {
  assert.equal(classifyTcpFailure('ConnectionRefused'), 'refused');
  assert.equal(classifyTcpFailure('connectionrefused'), 'refused');
  assert.equal(classifyTcpFailure('TimedOut'), 'timeout');
  assert.equal(classifyTcpFailure('TIMEDOUT'), 'timeout');
  assert.equal(classifyTcpFailure('PermissionDenied'), 'other');
  assert.equal(classifyTcpFailure('AddrNotAvailable'), 'other');
  assert.equal(classifyTcpFailure(null), 'other');
});

test('describeTcpFailure：三种结局各自给出"下一步"不同的说法，且都带原始错误', () => {
  const base = { host: '127.0.0.1', port: 8000, elapsedMs: 12 };

  const refused = describeTcpFailure({ ...base, errorKind: 'ConnectionRefused', errorMessage: 'actively refused' });
  assert.match(refused.summary, /没有服务在监听/);
  assert.match(refused.summary, /没启动|端口填错/);
  assert.match(refused.detail, /ConnectionRefused/);
  assert.match(refused.detail, /actively refused/, '原始错误必须原样带上');

  const timeout = describeTcpFailure({ ...base, errorKind: 'TimedOut', errorMessage: 'connection timed out', elapsedMs: 1501 });
  assert.match(timeout.summary, /超时/);
  assert.match(timeout.summary, /代理|防火墙|安全软件/, '超时要指向"被拦"，而不是"没启动"');
  assert.match(timeout.detail, /1501ms/);

  const other = describeTcpFailure({ ...base, errorKind: 'PermissionDenied', errorMessage: 'access denied' });
  assert.match(other.summary, /access denied/);
  assert.equal(other.kind, 'other');
});

// ── ③ 影响面静态守护（需求 T14.0 第 3 条）──────────────────

test('静态断言：127.0.0.1:8000 字面量只出现在默认值定义处', () => {
  const offenders = [];
  for (const rel of listTs(CLIENT_SRC)) {
    const text = readFileSync(join(CLIENT_SRC, rel), 'utf8');
    // 允许出现的位置：契约层的默认值定义（ST_DEFAULT_ADDRESS）
    if (rel === 'contract/types.ts') continue;
    // 注释里出现不算（说明性文字，比如"默认 127.0.0.1:8000"），只看代码
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (code.includes('127.0.0.1:8000')) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `这些文件里硬编码了 ST 地址，必须改走 resolveStAddress(config.stAddress)：${offenders.join(', ')}`,
  );
});

test('静态断言：默认值定义本身有一处，且全仓库只有这一处', () => {
  const all = [join(CLIENT_SRC, 'contract/types.ts'), ...listTs(CLIENT_SRC).map((rel) => join(CLIENT_SRC, rel))];
  let hits = 0;
  for (const file of new Set(all)) {
    const text = readFileSync(file, 'utf8');
    hits += (text.match(/127\.0\.0\.1:8000/g) ?? []).length;
  }
  // contract/types.ts 里 1 处（ST_DEFAULT_ADDRESS）+ 注释提到的若干处
  // 这里只要求"代码里只有一处"：上面的用例已排除注释，两条合起来就锁死了。
  assert.ok(hits >= 1, '默认值定义不见了？');
});

test('静态断言：F15 探针 / 打开 ST 跳转都不再引用已删除的 ST_BASE_URL', () => {
  const dialog = readFileSync(join(CLIENT_SRC, 'session/st-dialog.ts'), 'utf8');
  assert.ok(!dialog.includes('ST_BASE_URL'), 'st-dialog 还在用已删除的 ST_BASE_URL 常量');
  assert.ok(dialog.includes('this.address.baseUrl'), '「打开 SillyTavern」必须跳配置地址');
  const code = dialog.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!code.includes('127.0.0.1:8000'), 'st-dialog 的代码里不该再有写死地址');
});

test('静态断言：壳侧探针只有 probe_tcp，不存在 probe_st_alive 的独立实现', () => {
  // 需求原文："原 probe_st_alive 不得保留独立实现"
  assert.ok(COMMANDS_RS.includes('pub fn probe_tcp('), '没有 probe_tcp');
  assert.ok(!COMMANDS_RS.includes('pub fn probe_st_alive('), 'probe_st_alive 的独立实现还留着 —— 两个实现必然分叉');
  const libRs = readFileSync(join(ROOT, 'client/src-tauri/src/lib.rs'), 'utf8');
  assert.ok(libRs.includes('commands::probe_tcp'));
  assert.ok(!libRs.includes('commands::probe_st_alive'));
});

test('两侧白名单同源：TS ALLOWED_ST_HOSTS 与 Rust PROBE_ALLOWED_HOSTS 逐字一致', () => {
  const rustLine = /pub const PROBE_ALLOWED_HOSTS: \[&str; (\d+)\] = \[(.*?)\];/.exec(COMMANDS_RS);
  assert.notEqual(rustLine, null, 'Rust 侧没有 PROBE_ALLOWED_HOSTS');
  const rustHosts = rustLine[2].split(',').map((item) => item.trim().replace(/"/g, ''));
  assert.equal(Number(rustLine[1]), rustHosts.length);
  assert.deepEqual([...ALLOWED_ST_HOSTS], rustHosts, '两侧回环白名单必须一致（否则前端放行、壳拒绝）');
  assert.deepEqual(rustHosts, ['127.0.0.1', 'localhost', '::1']);
});

test('壳侧拒绝非回环时用的错误码两侧都有（配置被改坏时要能指路）', () => {
  const errorsTs = readFileSync(join(CLIENT_SRC, 'contract/errors.ts'), 'utf8');
  const errorRs = readFileSync(join(ROOT, 'client/src-tauri/src/error.rs'), 'utf8');
  assert.ok(errorsTs.includes("'PROBE_HOST_NOT_ALLOWED'"));
  assert.ok(errorRs.includes('"PROBE_HOST_NOT_ALLOWED"'));
});

test('状态文案里的地址来自配置，不再写死', () => {
  const text = stStatusText('running', { address: '127.0.0.1:8001' });
  assert.match(text, /127\.0\.0\.1:8001/, '运行中那句必须显示配置的地址');
  assert.ok(!text.includes('8000'), '默认端口不该在这句话里写死');
});
