/**
 * 仓库地址策略判据（2026-11-04，T15.2 决策④）。
 *
 * ## 这一层的错误都是"静默的"
 *
 * ```text
 *   地址归一化错   → 请求打到别的机器，报"账号不存在"，用户以为密码记错
 *   明文闸门错     → 令牌明文过网，而界面上一切正常
 *   可降级         → 一次手改 localStorage 就长期用 http
 *   ack 作用域错   → 确认过 A 机器，顺带放行了 B 机器
 * ```
 *
 * 四种都不会抛错。所以逐条钉。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLOUD_INVITE_HINT,
  CLOUD_REPO_HOST,
  CLOUD_REPO_ORIGIN,
  CLOUD_REPO_PORT,
  emptyRepoConfig,
  isPlainHttpOrigin,
  needsInviteCode,
  needsPlainHttpAck,
  parseRepoAddress,
  parseRepoConfig,
  resolveRepoOrigin,
} from '../shared/dist/repo/repo-target.js';

/* ═══════════════════════════════════════════════════════════
   一、内置云仓库：强制 https、不可降级
   ═══════════════════════════════════════════════════════════ */

test('★★★ 内置云仓库地址是固定的 https + 443', () => {
  /*
   * ★ 2026-11-04 用户更正：端口是 **443**，不是 8730。
   *
   * 8730 是自部署实例的默认 HTTP 端口（管理面板里 "HTTP 监听 ...:8730"），
   * 云仓库走标准 HTTPS 端口，前面有反代。
   *
   * 443 是 https 默认端口 ⇒ origin 里**不带** `:443`
   * （`https://h:443` 与 `https://h` 是同一个地方，写出来只是噪音）。
   */
  assert.equal(CLOUD_REPO_HOST, 'ai.gezblog.xyz');
  assert.equal(CLOUD_REPO_PORT, 443);
  assert.equal(CLOUD_REPO_ORIGIN, 'https://ai.gezblog.xyz');
});

test('★★ 云仓库解析出的 port 是 null（443 是默认端口，不算"显式端口"）', () => {
  /*
   * `port` 字段的语义是"**显式非默认端口**"（见 `ParsedRepoAddress`）。
   *
   * 两处语义不一致会出事：调用方若拿 `port` 拼地址，443 会让 origin 变成
   * `https://h:443`，与 `CLOUD_REPO_ORIGIN` 不相等 ⇒ "是否同一台机器"判错。
   */
  const resolved = resolveRepoOrigin(emptyRepoConfig());
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.address.port, null);
  assert.equal(resolved.address.scheme, 'https');
});

test('★★★ 内置模式绝不给 http（即使 customAddress 被写成 http）', () => {
  /*
   * 这是"不可降级"最容易被绕过的地方：`kind === 'cloud'` 但
   * `customAddress` 里塞了 `http://ai.gezblog.xyz:8730`。
   *
   * 若实现是"先看 customAddress 有没有值"，就会给出 http —— 令牌明文过网。
   * 正确做法：cloud 模式**完全不看**用户输入。
   */
  const state = {
    kind: 'cloud',
    customAddress: 'http://ai.gezblog.xyz:8730',
    ackedPlainOrigin: 'http://ai.gezblog.xyz:8730',
  };

  const resolved = resolveRepoOrigin(state);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.address.origin, CLOUD_REPO_ORIGIN);
  assert.equal(resolved.address.scheme, 'https');
});

test('★★★ 内置模式不需要明文确认（它本来就是 https）', () => {
  const state = emptyRepoConfig();
  assert.equal(needsPlainHttpAck(state, CLOUD_REPO_ORIGIN), false);
});

test('★★ 内置模式要显示邀请码字段，自定义不要', () => {
  assert.equal(needsInviteCode({ ...emptyRepoConfig(), kind: 'cloud' }), true);
  assert.equal(needsInviteCode({ ...emptyRepoConfig(), kind: 'custom' }), false);
});

test('★★★ 邀请码说明是用户指定的固定文案（不许改写）', () => {
  assert.equal(CLOUD_INVITE_HINT, '内置云仓库需找开发者拿邀请码才可注册登录');
});

/* ═══════════════════════════════════════════════════════════
   二、地址解析
   ═══════════════════════════════════════════════════════════ */

test('★★★ 没写协议默认 https（安全的一侧）', () => {
  /*
   * 默认 http 的话，用户以为在填域名，实际"默默用了明文"，事后无从察觉。
   * 默认 https 最坏结果是明确的连接失败 —— 那会让人来问，而不是被窃听。
   */
  const r = parseRepoAddress('repo.example.com:8730');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.address.origin, 'https://repo.example.com:8730');
  assert.equal(r.address.scheme, 'https');
});

test('★★ 各种写法都归一到同一个 origin', () => {
  const cases = [
    'https://repo.example.com:8730',
    'https://repo.example.com:8730/',
    'https://repo.example.com:8730/api',
    'HTTPS://Repo.Example.COM:8730',
    '  https://repo.example.com:8730  ',
    'repo.example.com:8730',
  ];

  for (const input of cases) {
    const r = parseRepoAddress(input);
    assert.equal(r.ok, true, `${input} 应该能解析`);
    if (!r.ok) continue;
    assert.equal(r.address.origin, 'https://repo.example.com:8730', `${input} 归一化错`);
  }
});

test('★★★ 默认端口不写进 origin（否则同一台机器算成两个地址）', () => {
  /*
   * `https://h:443` 与 `https://h` 是同一个地方。
   * 两种写法算成两个 origin 的后果：
   *   · "确认过明文"对不上 ⇒ 反复弹窗
   *   · 登录态按 origin 存的话会丢
   */
  const a = parseRepoAddress('https://h.example.com:443');
  const b = parseRepoAddress('https://h.example.com');
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(a.address.origin, b.address.origin);
  assert.equal(a.address.origin, 'https://h.example.com');
  assert.equal(a.address.port, null);

  const c = parseRepoAddress('http://h.example.com:80');
  assert.equal(c.ok, true);
  if (!c.ok) return;
  assert.equal(c.address.origin, 'http://h.example.com');
});

test('★★★ 非法输入要给出人能看懂的原因', () => {
  const bad = [
    ['', /请填写/],
    ['ftp://h', /不支持/],
    ['https://', /没有主机名/],
    ['https://h:abc', /端口必须是数字/],
    ['https://h:99999', /1–65535/],
    ['https://h_a.com', /不认识的字符/],
    ['https://.h.com', /点号位置/],
  ];

  for (const [input, pattern] of bad) {
    const r = parseRepoAddress(input);
    assert.equal(r.ok, false, `${input} 应该被拒绝`);
    if (r.ok) continue;
    assert.match(r.reason, pattern, `${input} 的拒绝原因不对：${r.reason}`);
  }
});

test('★★ IPv6 字面量能解析（方括号形式）', () => {
  const r = parseRepoAddress('http://[::1]:8730');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.address.origin, 'http://[::1]:8730');
});

/* ═══════════════════════════════════════════════════════════
   三、明文风险闸门
   ═══════════════════════════════════════════════════════════ */

test('★★★ https 永不弹风险提示', () => {
  const state = { ...emptyRepoConfig(), kind: 'custom', customAddress: 'https://a.com:8730' };
  const resolved = resolveRepoOrigin(state);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(isPlainHttpOrigin(resolved.address.origin), false);
  assert.equal(needsPlainHttpAck(state, resolved.address.origin), false);
});

test('★★★ http 且没确认过 ⇒ 必须弹', () => {
  const state = { ...emptyRepoConfig(), kind: 'custom', customAddress: 'http://a.com:8730' };
  const resolved = resolveRepoOrigin(state);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(needsPlainHttpAck(state, resolved.address.origin), true);
});

test('★★★ 确认过这台机器 ⇒ 不再重复打扰', () => {
  const state = {
    kind: 'custom',
    customAddress: 'http://a.com:8730',
    ackedPlainOrigin: 'http://a.com:8730',
  };
  const resolved = resolveRepoOrigin(state);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(needsPlainHttpAck(state, resolved.address.origin), false);
});

test('★★★ 换了机器 ⇒ 必须重新确认（ack 不许跨地址生效）', () => {
  /*
   * 这是"确认过 A 顺带放行 B"的防线。用户确认了 `http://a.com`，
   * 然后把地址改成 `http://b.com` —— 那是另一台机器，别人的可能，
   * 必须重新问。
   */
  const state = {
    kind: 'custom',
    customAddress: 'http://b.com:8730',
    ackedPlainOrigin: 'http://a.com:8730',
  };
  const resolved = resolveRepoOrigin(state);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(needsPlainHttpAck(state, resolved.address.origin), true);
});

test('★★ 同一台机器换个写法（大小写/尾斜线）不重复问', () => {
  const state = {
    kind: 'custom',
    customAddress: 'HTTP://A.com:8730/',
    ackedPlainOrigin: 'http://a.com:8730',
  };
  const resolved = resolveRepoOrigin(state);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(needsPlainHttpAck(state, resolved.address.origin), false);
});

/* ═══════════════════════════════════════════════════════════
   四、落盘校验
   ═══════════════════════════════════════════════════════════ */

test('★★★ 磁盘上的脏 kind 回落到 cloud（那是"能用"的那个）', () => {
  /*
   * 回落到 custom 的话，`customAddress` 是空 ⇒ 地址解析失败 ⇒ 仓库页直接不可用。
   * 回落 cloud 至少能用内置仓库。
   */
  for (const bad of [null, undefined, 42, 'custom', {}, { kind: 'weird' }]) {
    const parsed = parseRepoConfig(bad);
    assert.equal(parsed.kind, 'cloud', `输入 ${JSON.stringify(bad)} 应该回落到 cloud`);
  }
});

test('★★★ 脏的 ack 值必须清空（否则闸门失效）', () => {
  /*
   * `http://` 后面空着也算 startsWith 匹配。只判前缀不够，
   * 必须能解析成合法 http origin 才认。
   */
  const dirty = [
    '',
    'http://',
    'ftps://a.com',
    'a.com',
    'not a url',
    123,
  ];

  for (const value of dirty) {
    const parsed = parseRepoConfig({ kind: 'custom', customAddress: 'http://a.com', ackedPlainOrigin: value });
    assert.equal(parsed.ackedPlainOrigin, '', `脏 ack ${JSON.stringify(value)} 应该被清空`);
  }
});

test('★★ 合法的 ack 要保留并归一化', () => {
  const parsed = parseRepoConfig({
    kind: 'custom',
    customAddress: 'http://a.com:8730',
    ackedPlainOrigin: 'HTTP://A.com:8730/',
  });
  assert.equal(parsed.ackedPlainOrigin, 'http://a.com:8730');
});

test('★★ 自定义模式的地址原样保留（用户还要继续编辑）', () => {
  const parsed = parseRepoConfig({ kind: 'custom', customAddress: '  repo.example.com:8730  ' });
  assert.equal(parsed.customAddress, '  repo.example.com:8730  ');
});

/* ═══════════════════════════════════════════════════════════
   五、证书信任（自签 https）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 证书信任要持久化，且允许存多个', () => {
  /*
   * ## 为什么必须持久化
   *
   * 真机实测撞上了自签证书的服务器。第一次登录会弹"证书不受信任"，
   * 用户点确认后能继续。但如果**不记住**，每次重进 App 都要再问一遍。
   *
   * 反复问同一个问题会训练用户无脑点确认 —— 那比不问更糟
   * （真出问题时他也照点）。所以问一次、记住、以后不再问。
   *
   * ## 为什么允许一串（与 `ackedPlainOrigin` 相反）
   *
   * 明文确认的对象是"当前这一个地址"（改了就该重问）；
   * 证书信任是用户对自己服务器的长期判断，切回用过的自签服务器不该重问。
   */
  const state = emptyRepoConfig();
  assert.deepEqual(state.trustedCertOrigins, [], '空状态要有个空数组');

  const parsed = parseRepoConfig({
    kind: 'custom',
    customAddress: 'https://a.com:8443',
    trustedCertOrigins: ['https://a.com:8443', 'https://b.com:9443/', 'https://A.COM:8443'],
  });

  /* 归一化 + 去重：`https://b.com:9443/` 去掉尾斜线，重复的 A.COM 只留一个 */
  assert.deepEqual(
    parsed.trustedCertOrigins.sort(),
    ['https://a.com:8443', 'https://b.com:9443'].sort(),
  );
});

test('★★★ 脏的证书信任项要丢掉', () => {
  const parsed = parseRepoConfig({
    kind: 'custom',
    customAddress: 'https://a.com:8443',
    trustedCertOrigins: ['', 'not a url', 'ftp://x', 123, null, 'https://ok.com'],
  });
  assert.deepEqual(parsed.trustedCertOrigins, ['https://ok.com']);
});
