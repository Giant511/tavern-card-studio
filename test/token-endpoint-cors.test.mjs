/**
 * `/api/token` 的 Host 校验与 CORS 收口（2026-11-24）。
 *
 * ## 两个独立的攻击面
 *
 * **① 任意网页读令牌**
 *
 * 全部响应默认带 `Access-Control-Allow-Origin: *`。取令牌是 GET、不触发预检，
 * 同机访问时 socket 就是 127.0.0.1、门禁天然通过 —— 公网页面一行
 * `fetch('http://127.0.0.1:8730/api/token')` 就能拿到全局令牌。
 * 现在这个端点摘掉 ACAO：跨源 JS 读不到，而同源页面与原生通道（Tauri IPC、
 * 安卓 Java 桥）不看 CORS，功能不受影响。
 *
 * **② DNS rebinding**
 *
 * 攻击者的域名解析到 127.0.0.1，请求真打到本机服务，回环门禁也通过。
 * 唯一能区分的是 `Host`。所以这个端点额外要求 Host 是本机名。
 *
 * ## 判据
 *
 * 纯函数 + 静态断言（本文件），不启进程：
 *
 * ```text
 *   ① Host 白名单：放行回环各类写法，拒绝外部域名 / 空 Host
 *   ② 静态：/api/token 路由里必须出现摘除 ACAO 的调用
 * ```
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { isLocalHostHeader } from '../server/dist/http/app.js';

const ROOT = join(import.meta.dirname, '..');

test('★★★★★ Host 白名单：本机各种写法都放行', () => {
  const allowed = [
    '127.0.0.1',
    '127.0.0.1:8730',
    '127.0.0.1:8731',
    '127.0.0.53:8730',
    'localhost',
    'localhost:8730',
    'LOCALHOST:8730',
    'app.localhost:8730',
    '[::1]',
    '[::1]:8730',
    '::1',
  ];
  for (const host of allowed) {
    assert.equal(isLocalHostHeader(host), true, `本机名被拒：${host}`);
  }
});

test('★★★★★ Host 白名单：外部域名与空 Host 一律拒绝', () => {
  const denied = [
    '',
    '   ',
    'evil.com',
    'evil.com:8730',
    '127.0.0.1.evil.com',
    'localhost.evil.com',
    '192.168.1.10:8730',
    '10.0.0.1',
    '0.0.0.0:8730',
    '127.0.0.1.nip.io',
    '[::1].evil.com',
    '127.0.0.256',
    '[::2]:8730',
  ];
  for (const host of denied) {
    assert.equal(isLocalHostHeader(host), false, `外部/异常 Host 被放行：${host}`);
  }
});

test('★★★★★ 静态：/api/token 路由必须摘掉 ACAO', () => {
  /*
   * 判据盯的是"这段代码还在不在"。有人重构时把 removeHeader 删掉，
   * 上面那几条纯函数测试仍然全绿 —— 但洞回来了。所以这里直接读源码断言。
   */
  const source = readFileSync(join(ROOT, 'server/src/http/app.ts'), 'utf8');
  const start = source.indexOf("router.get('/api/token'");
  assert.ok(start >= 0, '找不到 /api/token 路由 —— 判据需要同步更新');

  // 取到该路由注册的结尾（下一个 router.xxx 之前）
  const nextRoute = source.indexOf('router.', start + 10);
  const body = source.slice(start, nextRoute > 0 ? nextRoute : source.length);

  assert.ok(
    body.includes("removeHeader('Access-Control-Allow-Origin')"),
    '/api/token 没有摘掉 ACAO —— 任意网页又能读到令牌了',
  );
  assert.ok(
    body.includes('isLocalHostHeader('),
    '/api/token 没有做 Host 校验 —— DNS rebinding 可用',
  );
});

test('★★★★ 静态：全局 ACAO 仍保留（客户端依赖它，不能一刀切掉）', () => {
  const source = readFileSync(join(ROOT, 'server/src/http/app.ts'), 'utf8');
  assert.ok(
    source.includes("res.setHeader('Access-Control-Allow-Origin', '*')"),
    '全局 ACAO 被删了 —— 桌面/安卓的原生通道虽然不看 CORS，但同源页面与调试页会坏',
  );
});
