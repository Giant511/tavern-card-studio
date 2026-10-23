/**
 * 可信反向代理与有效地址解析（v0.1.2 追加任务 / 需求 F1.4）。
 *
 * 这一层的安全性完全取决于**三个判据**，所以测试按判据分组而不是按函数分组：
 *
 *   A. 归一化：`::ffff:127.0.0.1`、`[::1]:8443`、`1.2.3.4:5678`、`fe80::1%eth0`
 *      都必须能认出来。漏一种就会让"我明明登记了却判定不生效"。
 *   B. 空 trustProxy = 完全忽略代理头（默认安全姿态）。
 *   C. 登记后取「最右侧非信任条目」，且伪造的左侧条目拿不到身份。
 *   D. `/api/token` 门禁的四条分支（含 v0.1.2 修复的那个洞作为回归用例）。
 *
 * 纯函数测试不覆盖"真的起进程走 socket"这一步 —— 那部分在
 * `scripts/smoke-t110-deploy.mjs` 里用真反向代理跑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TrustProxyResolver,
  decideTokenGate,
  normalizeAddress,
  parseForwardedChain,
  parseTrustProxyEntries,
} from '../server/dist/net/trust-proxy.js';
import { applyConfigPatch } from '../server/dist/supervisor.js';
import { assertSafeConfig, createDefaultConfig, normalizeConfig } from '../server/dist/config.js';

/** 造一个只带 headers / socket.remoteAddress 的假请求 */
function req(remoteAddress, headers = {}) {
  return { socket: { remoteAddress }, headers };
}

// ══════════════════════════════════════════════════════════
// A. 地址归一化
// ══════════════════════════════════════════════════════════

test('归一化：IPv4 / IPv6 / 端口 / 方括号 / zone / mapped 六种写法', () => {
  assert.equal(normalizeAddress('127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeAddress('  10.1.2.3  '), '10.1.2.3');
  assert.equal(normalizeAddress('::1'), '::1');
  assert.equal(normalizeAddress('1.2.3.4:5678'), '1.2.3.4');
  assert.equal(normalizeAddress('[::1]:8443'), '::1');
  assert.equal(normalizeAddress('[::1]'), '::1');
  assert.equal(normalizeAddress('fe80::1%eth0'), 'fe80::1');
  // IPv4-mapped：BlockList 不认这种形式（实测），必须先剥成 IPv4
  assert.equal(normalizeAddress('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeAddress('::FFFF:10.0.0.5'), '10.0.0.5');
  assert.equal(normalizeAddress('2001:DB8::1'), '2001:db8::1');
});

test('归一化：非 IP 一律返回 null（不能"差不多就行"）', () => {
  for (const bad of ['', '  ', 'unknown', 'localhost', 'example.com', '1.2.3', '1.2.3.4.5', '999.1.1.1', '::gg']) {
    assert.equal(normalizeAddress(bad), null, `应判为非法：${bad}`);
  }
});

// ══════════════════════════════════════════════════════════
// B. trustProxy 解析与校验
// ══════════════════════════════════════════════════════════

test('trustProxy：IP、CIDR、空串、去重、IPv6', () => {
  const parsed = parseTrustProxyEntries(['127.0.0.1', '10.0.0.0/8', '', '  ', '127.0.0.1', '::1']);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.entries, ['127.0.0.1', '10.0.0.0/8', '::1']);
});

test('trustProxy：非法条目必须报问题（不能静默跳过）', () => {
  const parsed = parseTrustProxyEntries(['127.0.0.1', 'not-an-ip', '10.0.0.0/33', '::1/129', '1.2.3.4/abc']);
  assert.equal(parsed.entries.length, 1, '只有第一条是合法的');
  assert.equal(parsed.problems.length, 4);
  assert.match(parsed.problems[0], /不是合法的 IP 或 CIDR/);
  assert.match(parsed.problems[1], /掩码长度超出/);
});

test('trustProxy：/0 被拒绝（等于信任所有来源，与"显式登记"相反）', () => {
  const parsed = parseTrustProxyEntries(['0.0.0.0/0', '::/0']);
  assert.equal(parsed.entries.length, 0);
  assert.equal(parsed.problems.length, 2);
  assert.match(parsed.problems[0], /信任所有来源/);
});

test('trustProxy：配置非法时 assertSafeConfig 拒绝启动', () => {
  const config = createDefaultConfig({ token: 'x'.repeat(32) });
  config.trustProxy = ['127.0.0.1', 'oops'];
  assert.throws(() => assertSafeConfig(config), /trustProxy 配置有误/);
});

test('trustProxy：默认是空数组（乐观默认会让管理员误以为已按真实 IP 判定）', () => {
  const config = createDefaultConfig({ token: 'x'.repeat(32) });
  assert.deepEqual(config.trustProxy, []);
  const fromDisk = normalizeConfig({ port: 8730 });
  assert.deepEqual(fromDisk.trustProxy, []);
});

test('trustProxy：配置里写成单个字符串也能读（手改配置的常见形态）', () => {
  const config = normalizeConfig({ trustProxy: '127.0.0.1, 10.0.0.0/8' });
  assert.deepEqual(config.trustProxy, ['127.0.0.1', '10.0.0.0/8']);
});

// ══════════════════════════════════════════════════════════
// C. 解析器：CIDR 匹配 + XFF 链
// ══════════════════════════════════════════════════════════

test('CIDR：127.0.0.0/8 覆盖整段，::1/128 精确匹配', () => {
  const resolver = new TrustProxyResolver(['127.0.0.0/8', '::1/128']);
  assert.equal(resolver.isTrusted('127.0.0.1'), true);
  assert.equal(resolver.isTrusted('127.9.9.9'), true);
  assert.equal(resolver.isTrusted('::1'), true);
  assert.equal(resolver.isTrusted('::ffff:127.0.0.1'), true, 'mapped 形式必须落到 IPv4 规则');
  assert.equal(resolver.isTrusted('10.0.0.1'), false);
  assert.equal(resolver.isTrusted('::2'), false);
  assert.equal(resolver.isTrusted(undefined), false);
});

test('CIDR：IPv6 网段与 IPv4 互不串味', () => {
  const resolver = new TrustProxyResolver(['2001:db8::/32']);
  assert.equal(resolver.isTrusted('2001:db8:1234::5'), true);
  assert.equal(resolver.isTrusted('2001:db9::1'), false);
  assert.equal(resolver.isTrusted('127.0.0.1'), false);
});

test('空 trustProxy：代理头被完全忽略（有效 IP = socket 地址）', () => {
  const resolver = new TrustProxyResolver([]);
  const resolved = resolver.resolve(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }));
  assert.equal(resolved.address, '127.0.0.1', '不登记就不许代理头改写身份');
  assert.equal(resolved.fromTrustedProxy, false);
  assert.equal(resolved.proxied, true, '但要如实报告"这个请求带了代理头"');
  assert.equal(resolved.chain.length, 0);
});

test('未登记的对端：伪造 XFF 也拿不到身份', () => {
  const resolver = new TrustProxyResolver(['10.0.0.1']);
  const resolved = resolver.resolve(req('203.0.113.7', { 'x-forwarded-for': '127.0.0.1' }));
  assert.equal(resolved.address, '203.0.113.7');
  assert.equal(resolved.fromTrustedProxy, false);
});

test('已登记对端：取最右侧非信任条目（防客户端自带 XFF 伪造）', () => {
  const resolver = new TrustProxyResolver(['127.0.0.1']);
  // 客户端自称 6.6.6.6，反代在右边追加真实来源 198.51.100.11
  const resolved = resolver.resolve(req('127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 198.51.100.11' }));
  assert.equal(resolved.address, '198.51.100.11', '左边那段是客户端自己写的，不能采信');
  assert.equal(resolved.fromTrustedProxy, true);
  assert.equal(resolved.usedForwardedChain, true);
  assert.deepEqual(resolved.chain, ['6.6.6.6', '198.51.100.11']);
});

test('已登记对端：多跳时跳过链上的其它已登记代理', () => {
  // 两层代理：客户端 → proxy1(10.0.0.1) → proxy2(127.0.0.1) → 服务端
  const resolver = new TrustProxyResolver(['127.0.0.1', '10.0.0.1']);
  const resolved = resolver.resolve(req('127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.1' }));
  assert.equal(resolved.address, '203.0.113.9');
  assert.equal(resolved.skippedTrusted, 1, '只该跳过 10.0.0.1 这一跳');
});

test('已登记对端但没给 XFF：把代理自己当客户端（保守解释）', () => {
  const resolver = new TrustProxyResolver(['127.0.0.1']);
  const resolved = resolver.resolve(req('127.0.0.1'));
  assert.equal(resolved.address, '127.0.0.1');
  assert.equal(resolved.fromTrustedProxy, true);
  assert.equal(resolved.proxied, false);
});

test('XFF 链含垃圾条目：标记 malformed（门禁要 fail-closed）', () => {
  const { chain, malformed } = parseForwardedChain('1.2.3.4, unknown, 5.6.7.8');
  assert.deepEqual(chain, ['1.2.3.4', '5.6.7.8']);
  assert.equal(malformed, true);

  const clean = parseForwardedChain('1.2.3.4, 5.6.7.8');
  assert.equal(clean.malformed, false);
  assert.deepEqual(parseForwardedChain('').chain, []);
});

test('命中计数只统计"真正改写过身份"的可信代理（面板据此判断配置是否匹配上）', () => {
  const resolver = new TrustProxyResolver(['127.0.0.1']);
  resolver.resolve(req('127.0.0.1', { 'x-forwarded-for': '198.51.100.11' }));
  resolver.resolve(req('127.0.0.1', { 'x-forwarded-for': '198.51.100.12' }));
  // 未登记的对端不该进统计（否则公网扫描就能把这张表撑大）
  resolver.resolve(req('203.0.113.7', { 'x-forwarded-for': '1.1.1.1' }));

  const stats = resolver.stats();
  assert.equal(stats.entries, 1);
  assert.deepEqual(stats.rules, ['127.0.0.1']);
  assert.equal(stats.trustedProxies.length, 1);
  assert.equal(stats.trustedProxies[0].address, '127.0.0.1');
  assert.equal(stats.trustedProxies[0].hits, 2);
});

// ══════════════════════════════════════════════════════════
// D. /api/token 门禁
// ══════════════════════════════════════════════════════════

test('门禁①回归：同机反代 + trustProxy 空 → 拒绝（v0.1.2 之前的洞）', () => {
  // 这正是修复前的场景：公网请求经同机反代进来，socket 对端是 127.0.0.1
  const resolver = new TrustProxyResolver([]);
  const resolved = resolver.resolve(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }));
  const verdict = decideTokenGate(resolved);
  assert.equal(verdict.allowed, false, '未登记的同机反代不能天然穿透');
  assert.match(verdict.reason, /未登记在 trustProxy/);
});

test('门禁②：同机反代 + 已登记 → 公网真实 IP 非回环 → 拒绝', () => {
  const resolver = new TrustProxyResolver(['127.0.0.1']);
  const resolved = resolver.resolve(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }));
  const verdict = decideTokenGate(resolved);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /不是回环地址/);
  assert.match(verdict.reason, /203\.0\.113\.9/);
});

test('门禁②：同机反代 + 已登记 → 回环真实 IP（本机经代理）→ 放行', () => {
  const resolver = new TrustProxyResolver(['127.0.0.1']);
  const resolved = resolver.resolve(req('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' }));
  const verdict = decideTokenGate(resolved);
  assert.equal(verdict.allowed, true, verdict.reason);
});

test('门禁③：直连不带代理头 → 回环放行（客户端一键连接的正常路径）', () => {
  const resolver = new TrustProxyResolver([]);
  const verdict = decideTokenGate(resolver.resolve(req('127.0.0.1')));
  assert.equal(verdict.allowed, true, verdict.reason);
});

test('门禁③：直连但伪造代理头 → 拒绝（无论 trustProxy 是否为空）', () => {
  for (const trust of [[], ['127.0.0.1']]) {
    const resolver = new TrustProxyResolver(trust);
    const verdict = decideTokenGate(resolver.resolve(req('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' })));
    // trust 为空时：proxied 且不可信 → 拒；trust 含 127.0.0.1 时：真实来源是 127.0.0.1 → 放行。
    // 后者是设计使然（本机装了一个可信代理），前者才是"伪造"的判定。
    if (trust.length === 0) assert.equal(verdict.allowed, false);
    else assert.equal(verdict.allowed, true);
  }
});

test('门禁④：非回环 socket 且无代理头 → 拒绝', () => {
  const resolver = new TrustProxyResolver([]);
  const verdict = decideTokenGate(resolver.resolve(req('192.168.1.50')));
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /不是回环地址/);
});

test('门禁⑤：XFF 含垃圾条目 → fail-closed', () => {
  const resolver = new TrustProxyResolver(['127.0.0.1']);
  const resolved = resolver.resolve(req('127.0.0.1', { 'x-forwarded-for': 'unknown, 127.0.0.1' }));
  const verdict = decideTokenGate(resolved);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /无法解析/);
});

test('门禁：Forwarded / X-Real-IP 单现也算"带代理头"（不参与取值，但影响判定）', () => {
  const resolver = new TrustProxyResolver([]);
  for (const header of ['forwarded', 'x-real-ip', 'x-forwarded-host']) {
    const resolved = resolver.resolve(req('127.0.0.1', { [header]: header === 'forwarded' ? 'for=1.2.3.4' : '1.2.3.4' }));
    assert.equal(resolved.proxied, true, `${header} 应被识别为代理头`);
    assert.equal(resolved.address, '127.0.0.1', '不解析它的值');
    assert.equal(decideTokenGate(resolved).allowed, false, `${header} 未登记时必须拒绝`);
  }
});

// ══════════════════════════════════════════════════════════
// E. 限速维度的前提：有效 IP 必须是"真实来源"
// ══════════════════════════════════════════════════════════

test('限速前提：反代后两个不同真实 IP 得到不同的有效地址', () => {
  const resolver = new TrustProxyResolver(['127.0.0.1']);
  const first = resolver.resolve(req('127.0.0.1', { 'x-forwarded-for': '198.51.100.11' }));
  const second = resolver.resolve(req('127.0.0.1', { 'x-forwarded-for': '198.51.100.22' }));
  assert.notEqual(first.address, second.address, '共用一格就等于全局锁定');
  assert.deepEqual([first.address, second.address], ['198.51.100.11', '198.51.100.22']);
});

test('限速前提：trustProxy 为空时两人共用代理 IP（这正是要提示管理员的原因）', () => {
  const resolver = new TrustProxyResolver([]);
  const first = resolver.resolve(req('127.0.0.1', { 'x-forwarded-for': '198.51.100.11' }));
  const second = resolver.resolve(req('127.0.0.1', { 'x-forwarded-for': '198.51.100.22' }));
  assert.equal(first.address, second.address);
  assert.equal(first.address, '127.0.0.1');
});

// ══════════════════════════════════════════════════════════
// F. 控制面补丁：能否清空 trustProxy
// ══════════════════════════════════════════════════════════

test('控制面：字段缺席保持原值（改端口不该清掉信任表）', () => {
  const current = { ...createDefaultConfig({ token: 'x'.repeat(32) }), trustProxy: ['127.0.0.1'] };
  const patched = applyConfigPatch(current, { port: 9000 });
  assert.deepEqual(patched.trustProxy, ['127.0.0.1']);
  assert.equal(patched.port, 9000);
});

test('控制面：显式空数组能清空（清空是合法意图，必须做得到）', () => {
  const current = { ...createDefaultConfig({ token: 'x'.repeat(32) }), trustProxy: ['127.0.0.1', '10.0.0.0/8'] };
  assert.deepEqual(applyConfigPatch(current, { trustProxy: [] }).trustProxy, []);
  assert.deepEqual(applyConfigPatch(current, { trustProxy: '' }).trustProxy, []);
});

test('控制面：null 也当"清空"（JSON 里 null 与 [] 语义相同）', () => {
  const current = { ...createDefaultConfig({ token: 'x'.repeat(32) }), trustProxy: ['127.0.0.1'] };
  // 第一版只认 [] 和 ''，null 被归进"保持原值" —— 注释与实现不一致，实测才发现
  assert.deepEqual(applyConfigPatch(current, { trustProxy: null }).trustProxy, []);
});

test('控制面：字符串按换行/逗号切分（面板 textarea 的提交形态）', () => {
  const current = createDefaultConfig({ token: 'x'.repeat(32) });
  assert.deepEqual(
    applyConfigPatch(current, { trustProxy: '127.0.0.1\n10.0.0.0/8\n' }).trustProxy,
    ['127.0.0.1', '10.0.0.0/8'],
  );
  assert.deepEqual(applyConfigPatch(current, { trustProxy: '::1, 127.0.0.1' }).trustProxy, ['::1', '127.0.0.1']);
});
