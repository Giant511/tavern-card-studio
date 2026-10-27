/**
 * v0.1.6 / T14.1 T14.3 的判据（Node 直接跑，不需要 Tauri 壳）。
 *
 * 分三块：
 *   1. **地址解析两侧对拍** —— 与 Rust 的 `parse_st_address` 共用
 *      `test/fixtures/st-address-cases.json`；
 *   2. **静态断言** —— iframe 地址只能来自壳、CSP 只放开回环、代理目标不可被
 *      渲染层指定。这些是**安全边界**，不适合用"跑一遍看看"来验；
 *   3. **纯逻辑** —— 面板宽度钳制、推送链路的四种结局（用假依赖真跑）。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { parseStAddress, resolveStAddress, ALLOWED_ST_HOSTS } from '../client/src/session/st-address.ts';
import { ST_DEFAULT_ADDRESS } from '../client/src/contract/types.ts';
import {
  clampPaneWidth,
  isPaneWidthUsable,
  ST_PANE_COLLAPSED_WIDTH,
  ST_PANE_WIDTH_DEFAULT,
  ST_PANE_WIDTH_MAX,
  ST_PANE_WIDTH_MIN,
} from '../client/src/session/st-pane-layout.ts';
import { pushCardToSt } from '../client/src/session/st-push.ts';

const ROOT = join(import.meta.dirname, '..');
const CLIENT_SRC = join(ROOT, 'client', 'src');
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/st-address-cases.json'), 'utf8'));

function readSource(relative) {
  return readFileSync(join(CLIENT_SRC, relative), 'utf8');
}

/** 剥掉 // 与 /* *\/ 注释（静态断言必须只看代码，不看解释性文字） */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

// ── ① 地址解析：与 Rust 共用一份用例表 ──────────────────────

test('地址用例表：TS 与 fixture 逐条一致（Rust 读的是同一份文件）', () => {
  const fixtureDefault = FIXTURE.default;
  assert.equal(
    fixtureDefault,
    ST_DEFAULT_ADDRESS,
    '默认地址两侧分叉：fixture 与 contract/types.ts 的 ST_DEFAULT_ADDRESS 不一致',
  );
  assert.deepEqual([...ALLOWED_ST_HOSTS].sort(), [...FIXTURE.allowedHosts].sort());

  let checked = 0;
  for (const item of FIXTURE.cases) {
    const parsed = parseStAddress(item.input);
    if (item.ok) {
      assert.equal(parsed.ok, true, `「${item.input}」应当合法，实际：${parsed.message ?? ''}`);
      assert.equal(parsed.host, item.host, `「${item.input}」的 host`);
      assert.equal(parsed.port, item.port, `「${item.input}」的 port`);
    } else {
      assert.equal(parsed.ok, false, `「${item.input}」应当被拒`);
      assert.equal(parsed.reason, item.reason, `「${item.input}」的失败原因`);
    }
    checked += 1;
  }
  assert.ok(checked >= 20, `用例太少（${checked} 条），对拍等于没做`);
});

test('非法配置回落默认值，而不是让功能瘫掉', () => {
  for (const raw of [null, undefined, '', '   ', '192.168.1.5:8000', 'localhost.evil.com:8000']) {
    const resolved = resolveStAddress(raw);
    assert.equal(resolved.port, 8000, `配置 ${String(raw)} 应当回落默认端口`);
  }
  // 合法的自定义端口要如实生效（T14.7 改端口全链路的前提）
  assert.equal(resolveStAddress('127.0.0.1:8001').port, 8001);
});

// ── ② 静态断言：这是安全边界，不是风格偏好 ──────────────────

test('iframe 的地址只允许来自壳（唯一一处赋值，且来自 proxyOrigin）', () => {
  const source = stripComments(readSource('session/st-pane.ts'));
  const assignments = [...source.matchAll(/\.src\s*=\s*([^;\n]+)/g)].map((match) => match[1].trim());
  assert.equal(
    assignments.length,
    1,
    `全文件只允许一处给 iframe 设 src（实际 ${String(assignments.length)} 处：${assignments.join(' | ')}）`,
  );
  assert.equal(
    assignments[0],
    'proxyOrigin',
    'iframe src 只能来自 proxyOrigin（壳返回的 baseUrl），不能拼、不能读配置直连',
  );
});

test('面板源码里不出现任何 http(s) 字面量（地址不归渲染层管）', () => {
  const source = stripComments(readSource('session/st-pane.ts'));
  assert.ok(
    !/https?:\/\//.test(source),
    '面板源码里出现了 URL 字面量 —— 代理地址必须由壳给出（决策 #221）',
  );
});

test('CSP frame-src 只放开回环三写法（与 F0 白名单镜像）', () => {
  const config = JSON.parse(readFileSync(join(ROOT, 'client/src-tauri/tauri.conf.json'), 'utf8'));
  const csp = config?.app?.security?.csp ?? '';
  const match = /(?:^|;)\s*frame-src\s+([^;]*)/.exec(csp);
  assert.ok(match !== null, 'CSP 里没有 frame-src：iframe 会被 default-src 拦掉');
  const sources = match[1].trim().split(/\s+/).filter(Boolean);
  assert.deepEqual(
    sources.sort(),
    ['http://127.0.0.1:*', 'http://[::1]:*', 'http://localhost:*'].sort(),
    'frame-src 的主机必须与回环白名单一一对应，端口放开（内核分配）',
  );
  // 宽 CSP 的启用条件（决策 #223）：出现"iframe 用户可控 URL"时必须先收窄
  assert.ok(
    !sources.includes('*') && !sources.includes('http:') && !sources.includes('https:'),
    'frame-src 不能放开到任意源',
  );
});

test('代理命令不接受目标参数（目标由壳从配置读）', () => {
  const shell = readSource('contract/shell.ts');
  assert.match(shell, /export function stProxyStart\(\): Promise<ProxyInfo>/, 'stProxyStart 不能接受参数');
  const rust = readFileSync(join(ROOT, 'client/src-tauri/src/commands.rs'), 'utf8');
  const signature = /pub async fn st_proxy_start\(([\s\S]*?)\) -> ShellResult/.exec(rust);
  assert.notEqual(signature, null, 'Rust 侧找不到 st_proxy_start');
  assert.ok(
    !/\b(host|port|url|target)\s*:/.test(signature[1]),
    `st_proxy_start 的入参里出现了目标参数：${signature[1].trim()} —— 边界由渲染层决定就没了`,
  );
});

test('渲染层不直接引用 ST 地址去拼 URL（只走 resolveStAddress 与代理）', () => {
  /*
   * 只盯 **ST 的 8000**，不盯服务端的 8730/8731：后者是另一套地址，
   * 它本来就该有明确常量（`net/local-connect.ts`）。第一版这条断言写成
   * "任何 http://127.0.0.1"，于是把服务端地址也一并拦了 —— 断言比事实更严
   * 同样是坏的：它会逼着后来的人去改真代码。
   */
  const allowed = new Set([join('contract', 'types.ts')]);
  const offenders = [];
  for (const file of walk(CLIENT_SRC)) {
    const relative = file.slice(CLIENT_SRC.length).replace(/^[\\/]/, '');
    if (allowed.has(relative)) continue;
    const source = stripComments(readFileSync(file, 'utf8'));
    if (/(127\.0\.0\.1|localhost):8000/.test(source)) offenders.push(relative);
  }
  assert.deepEqual(
    offenders,
    [],
    '这些文件里硬写了 ST 地址（应当走 resolveStAddress 或壳给的代理地址）：' + offenders.join(', '),
  );
});

// ── ③ 面板宽度（纯逻辑）────────────────────────────────────

test('宽度钳制：坏值不报错，按最近边界处理', () => {
  assert.equal(clampPaneWidth(ST_PANE_WIDTH_DEFAULT), ST_PANE_WIDTH_DEFAULT);
  assert.equal(clampPaneWidth(100), ST_PANE_WIDTH_MIN, '太窄应当抬到下限');
  assert.equal(clampPaneWidth(5000), ST_PANE_WIDTH_MAX, '太宽应当压到上限');
  assert.equal(clampPaneWidth(Number.NaN), ST_PANE_WIDTH_DEFAULT, 'NaN 用默认值');
  assert.equal(clampPaneWidth(Number.POSITIVE_INFINITY), ST_PANE_WIDTH_DEFAULT);
  assert.equal(clampPaneWidth(459.6), 460, '取整');
});

test('宽度记忆的可用判定：null 是正常状态（没拖过）', () => {
  assert.equal(isPaneWidthUsable(null), false);
  assert.equal(isPaneWidthUsable(undefined), false);
  assert.equal(isPaneWidthUsable(ST_PANE_WIDTH_DEFAULT), true);
  assert.equal(isPaneWidthUsable(ST_PANE_WIDTH_MIN - 1), false);
  assert.equal(isPaneWidthUsable(ST_PANE_WIDTH_MAX + 1), false);
  assert.equal(isPaneWidthUsable(Number.NaN), false);
});

test('折叠条宽是个正数且小于下限（否则折叠等于没折叠）', () => {
  assert.ok(ST_PANE_COLLAPSED_WIDTH > 0);
  assert.ok(ST_PANE_COLLAPSED_WIDTH < ST_PANE_WIDTH_MIN);
});

// ── ④ 推送链路（用假依赖真跑四种结局）──────────────────────

function makeDeps(overrides = {}) {
  const written = [];
  const deps = {
    written,
    probeDir: async () => ({ exists: true, reason: null }),
    scanDir: async () => ({ names: [], truncated: false }),
    writeBinary: async (path, base64, sha256) => {
      written.push({ path, base64, sha256 });
      return { verified: true };
    },
    ...overrides,
  };
  return deps;
}

const artifact = {
  bytes: new Uint8Array([1, 2, 3]),
  sha256: 'abc',
  fileName: 'ignored.png',
  face: { from: 'source', fileName: null, note: '' },
};

test('推送：同名就加序号，绝不覆盖（内容级判据是落盘路径）', async () => {
  const deps = makeDeps({ scanDir: async () => ({ names: ['西奥.png', '西奥 (2).png'], truncated: false }) });
  const result = await pushCardToSt({
    charactersDir: 'C:\\ST\\data\\default-user\\characters',
    cardName: '西奥',
    build: async () => artifact,
    deps,
  });
  assert.equal(result.ok, true);
  assert.equal(result.fileName, '西奥 (3).png');
  assert.equal(deps.written.length, 1, '只写一份');
  assert.ok(deps.written[0].path.endsWith('西奥 (3).png'), `落盘路径：${deps.written[0].path}`);
  assert.equal(deps.written[0].sha256, 'abc', '写前摘要断言要传下去');
});

test('推送：目录扫描被截断时宁可不推（"没有同名"这个结论不成立）', async () => {
  const deps = makeDeps({ scanDir: async () => ({ names: [], truncated: true }) });
  const result = await pushCardToSt({
    charactersDir: 'C:\\ST\\characters',
    cardName: '西奥',
    build: async () => artifact,
    deps,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /太多/);
  assert.equal(deps.written.length, 0, '截断时不该写任何东西');
});

test('推送：闸门拦下时不写盘（返回 null 的那条路）', async () => {
  const deps = makeDeps();
  const result = await pushCardToSt({
    charactersDir: 'C:\\ST\\characters',
    cardName: '西奥',
    build: async () => null,
    deps,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /导出被拦下/);
  assert.equal(deps.written.length, 0);
});

test('推送：回读自证失败不能报成功', async () => {
  const deps = makeDeps({ writeBinary: async () => ({ verified: false }) });
  const result = await pushCardToSt({
    charactersDir: 'C:\\ST\\characters',
    cardName: '西奥',
    build: async () => artifact,
    deps,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /校验未通过/);
});

test('推送：旧 JSON 只提示、不报错（ST 忽略它，用户可自行删）', async () => {
  const deps = makeDeps({ scanDir: async () => ({ names: ['西奥.json'], truncated: false }) });
  const result = await pushCardToSt({
    charactersDir: 'C:\\ST\\characters',
    cardName: '西奥',
    build: async () => artifact,
    deps,
  });
  assert.equal(result.ok, true);
  assert.equal(result.fileName, '西奥.png', '.json 不占用 .png 的序号');
  assert.match(result.staleNote, /西奥\.json/);
});

test('推送：目录建不出来要说原因，不是"未知错误"', async () => {
  const deps = makeDeps({ probeDir: async () => ({ exists: false, reason: '目录被占用' }) });
  const result = await pushCardToSt({
    charactersDir: 'C:\\ST\\characters',
    cardName: '西奥',
    build: async () => artifact,
    deps,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /目录被占用/);
});
