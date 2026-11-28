/**
 * 控制面转发的来源标注与 `/api/token` 门禁（2026-11-24）。
 *
 * ## 修的是什么
 *
 * `supervisor` 代理 `/api/*` 时原来只重写 `host`，不标注来源。
 * worker 看到的对端永远是 `127.0.0.1`、且没有代理头 ⇒ 门禁判"本机直连" ⇒
 * **无凭证返回全局令牌**。而全局令牌同时是控制面凭证。
 *
 * 后果：面板一旦监听在局域网地址（配置允许，注释说是为远程运维），
 * `curl http://<LAN-IP>:8731/api/token` 即可接管整机。
 *
 * ## 现在的约定
 *
 * supervisor 注入 `x-tcs-control-hop: supervisor` + 真实来源 `x-forwarded-for`；
 * worker 在「标记头匹配 **且** socket 是回环」时才把来源当真。
 *
 * 判据穷举四类请求，全部用纯函数跑，不起进程：
 *
 * ```text
 *   ① 面板转发的局域网请求   → 有效地址是 LAN 地址 → 门禁拒
 *   ② 面板转发的本机请求     → 有效地址是 127.0.0.1 → 门禁放行
 *   ③ 外部伪造标记头         → socket 非回环 → 不认，仍按自己的地址算
 *   ④ 面板漏注入来源头       → fail-closed（门禁拒），不静默放行
 * ```
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TrustProxyResolver, decideTokenGate } from '../server/dist/net/trust-proxy.js';

/** 造一个只带 socket.remoteAddress 与 headers 的最小请求 */
function fakeReq(socketAddress, headers = {}) {
  return { socket: { remoteAddress: socketAddress }, headers };
}

const resolver = new TrustProxyResolver([]);

test('★★★★★ 面板转发的局域网请求：有效地址是 LAN 地址，门禁必须拒', () => {
  const resolved = resolver.resolve(
    fakeReq('127.0.0.1', {
      'x-tcs-control-hop': 'supervisor',
      'x-forwarded-for': '192.168.1.77',
    }),
  );
  assert.equal(resolved.address, '192.168.1.77', '控制面标注的来源没被采用');
  const verdict = decideTokenGate(resolved);
  assert.equal(verdict.allowed, false, '局域网来源竟然通过了取令牌门禁');
});

test('★★★★★ 面板转发的本机请求：仍然放行（一键连接不能坏）', () => {
  const resolved = resolver.resolve(
    fakeReq('127.0.0.1', {
      'x-tcs-control-hop': 'supervisor',
      'x-forwarded-for': '127.0.0.1',
    }),
  );
  assert.equal(resolved.address, '127.0.0.1');
  assert.equal(decideTokenGate(resolved).allowed, true, '本机请求被误拒，一键连接会坏');
});

test('★★★★★ 外部伪造标记头：socket 非回环 ⇒ 标记无效，XFF 被忽略', () => {
  const resolved = resolver.resolve(
    fakeReq('203.0.113.9', {
      'x-tcs-control-hop': 'supervisor',
      'x-forwarded-for': '127.0.0.1',
    }),
  );
  assert.equal(resolved.address, '203.0.113.9', '外部伪造的标记头被当真了');
  assert.equal(resolved.fromTrustedProxy, false);
  assert.equal(decideTokenGate(resolved).allowed, false);
});

test('★★★★★ 面板漏注入来源头：fail-closed，不静默放行', () => {
  /*
   * 防的是"将来改 supervisor 时漏了注入"—— 那种情况下若仍按本机直连放行，
   * 洞会静默回来。宁可 403（客户端提示手动复制令牌），也不要无凭证发令牌。
   */
  const resolved = resolver.resolve(fakeReq('127.0.0.1', { 'x-tcs-control-hop': 'supervisor' }));
  assert.equal(resolved.proxied, true, '应当标记为"存在代理跳"，让门禁拒');
  assert.equal(resolved.fromTrustedProxy, false, '缺来源头时不该被当成可信代理');
  assert.equal(decideTokenGate(resolved).allowed, false);
});

test('★★★★ 普通本机直连（不带任何头）仍然放行', () => {
  const resolved = resolver.resolve(fakeReq('127.0.0.1'));
  assert.equal(resolved.address, '127.0.0.1');
  assert.equal(decideTokenGate(resolved).allowed, true);
});

test('★★★★ 未登记代理 + 伪造 XFF：地址取 socket，不取头', () => {
  const resolved = resolver.resolve(fakeReq('198.51.100.4', { 'x-forwarded-for': '127.0.0.1' }));
  assert.equal(resolved.address, '198.51.100.4');
  assert.equal(decideTokenGate(resolved).allowed, false);
});

test('★★★ 登记过的反代仍按原语义工作（不能因为这次改动废掉 trustProxy）', () => {
  const trusted = new TrustProxyResolver(['127.0.0.1']);
  const resolved = trusted.resolve(
    fakeReq('127.0.0.1', { 'x-forwarded-for': '10.0.0.5, 127.0.0.1' }),
  );
  assert.equal(resolved.address, '10.0.0.5', '登记代理的链路解析退化');
  assert.equal(resolved.fromTrustedProxy, true);
  // 10.x 不是回环 ⇒ 门禁拒（这是正确行为：令牌不得出本机）
  assert.equal(decideTokenGate(resolved).allowed, false);
});
