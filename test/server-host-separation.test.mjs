/**
 * API 监听地址与管理面板监听地址的**隔离**（2026-10-21 安全修复）。
 *
 * 被修掉的缺陷：`host` 同时用于 worker（API，8730）和 supervisor（面板，8731）。
 * 于是「把 API 开给局域网」这一个动作，会连带把管理面板页面（`/`、`/app.js`）
 * 也暴露出去 —— 这些静态资源在 `PANEL_PUBLIC_PATHS` 里是**免鉴权**的，
 * 实测从局域网 IP `GET /` 返回 200（只有 `/control/*` 要 token）。
 *
 * 修复：新增 `controlHost`，默认 `127.0.0.1`，且**不跟随 `host`**。
 * 本文件钉住三件事：
 *   1. 默认值与老配置升级后的行为都是「面板回环」；
 *   2. 面板地址只由 `controlHost` 决定，改 `host` 不影响它；
 *   3. 展示用地址要把 `0.0.0.0` 换成可浏览地址（否则日志/CLI 打印出打不开的链接）。
 *
 * 运行：node --test test/server-host-separation.test.mjs（需先 npm run build:server）
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertSafeConfig,
  createDefaultConfig,
  isLoopbackHost,
  normalizeConfig,
  reachableHost,
} from '../server/dist/config.js';
import { applyConfigPatch } from '../server/dist/supervisor.js';

test('默认配置：API 与面板都只听回环', () => {
  const config = createDefaultConfig();
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.controlHost, '127.0.0.1');
  assert.notEqual(config.port, config.controlPort, '两个端口必须分开');
});

test('老配置文件（无 controlHost，host 已是 0.0.0.0）升级后面板自动收回回环', () => {
  // 这是升级路径的关键：用户之前为了局域网把 host 设成 0.0.0.0，
  // 老配置里没有 controlHost。若缺省值跟随 host，等于升级后面板仍然暴露。
  const legacy = {
    schemaVersion: 1,
    port: 8730,
    controlPort: 8731,
    host: '0.0.0.0',
    dataDir: 'C:\\data',
    rulesDir: 'C:\\rules',
    defaultPlatformRule: 'sillytavern',
    defaultPreset: 'default',
    maxUploadBytes: 1024,
    logLevel: 'info',
    auth: { token: 'abc', require: true, publicPaths: ['/api/health'] },
    service: { mode: 'process', name: 'x', displayName: 'X', autoStart: true },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const config = normalizeConfig(legacy);
  assert.equal(config.host, '0.0.0.0', 'API 保持用户设定的局域网地址');
  assert.equal(config.controlHost, '127.0.0.1', '面板必须自动收回回环');
});

test('显式配置的 controlHost 被保留（不被 host 覆盖）', () => {
  const config = normalizeConfig({ host: '0.0.0.0', controlHost: '192.168.1.5' });
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.controlHost, '192.168.1.5');
});

test('命令行 --control-host 覆盖生效，且不影响 host', () => {
  const config = normalizeConfig({ host: '0.0.0.0' }, { controlHost: '10.0.0.2' });
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.controlHost, '10.0.0.2');
});

test('面板保存时只改 API 地址，不会把已设的面板地址重置成默认值', () => {
  // 真实场景：用户特意把面板开到 192.168.1.5 做远程运维，
  // 之后某次只想把 API 端口从 8730 改成 8740，请求体里没有 controlHost。
  // 若 patch 用默认值兜底，面板地址会被悄悄改回 127.0.0.1，远程运维直接断掉。
  const current = normalizeConfig({ host: '127.0.0.1', controlHost: '192.168.1.5', port: 8730 });
  const patched = applyConfigPatch(current, { port: 8740 });
  assert.equal(patched.port, 8740);
  assert.equal(patched.controlHost, '192.168.1.5', '未传 controlHost 时必须保持原值');
});

test('面板保存时可以显式改 controlHost', () => {
  const current = normalizeConfig({ host: '127.0.0.1', controlHost: '127.0.0.1' });
  const patched = applyConfigPatch(current, { controlHost: '0.0.0.0' });
  assert.equal(patched.controlHost, '0.0.0.0');
  assert.equal(patched.host, '127.0.0.1', '改面板地址不应影响 API 地址');
});

test('两个地址互不串改（改 host 不动 controlHost，反之亦然）', () => {
  const base = normalizeConfig({ host: '127.0.0.1', controlHost: '127.0.0.1' });
  const onlyApi = applyConfigPatch(base, { host: '0.0.0.0' });
  assert.equal(onlyApi.host, '0.0.0.0');
  assert.equal(onlyApi.controlHost, '127.0.0.1');

  const onlyPanel = applyConfigPatch(base, { controlHost: '0.0.0.0' });
  assert.equal(onlyPanel.controlHost, '0.0.0.0');
  assert.equal(onlyPanel.host, '127.0.0.1');
});

test('reachableHost：把不可浏览的绑定地址换成可访问地址', () => {
  // 监听 0.0.0.0 意味着「所有网卡」，但浏览器打不开 http://0.0.0.0:8731/。
  // 日志与 CLI 里展示的必须是 127.0.0.1，否则用户点了打不开还以为是服务坏了。
  assert.equal(reachableHost('0.0.0.0'), '127.0.0.1');
  assert.equal(reachableHost('::'), '[::1]');
  assert.equal(reachableHost('[::]'), '[::1]');
  assert.equal(reachableHost('127.0.0.1'), '127.0.0.1');
  assert.equal(reachableHost('192.168.1.5'), '192.168.1.5', '具体地址原样返回');
});

test('isLoopbackHost 判定', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    assert.equal(isLoopbackHost(host), true, `${host} 应判为回环`);
  }
  for (const host of ['0.0.0.0', '::', '192.168.1.5', 'example.com']) {
    assert.equal(isLoopbackHost(host), false, `${host} 不应判为回环`);
  }
});

test('面板监听非回环且关闭鉴权 → 拒绝启动（面板静态资源本身免鉴权）', () => {
  // host 保持回环，只让 controlHost 非回环 —— 这样才会命中面板那条检查，
  // 而不是先被 API 的检查拦下（两者是独立的规则，必须分别可验）。
  const config = normalizeConfig({
    host: '127.0.0.1',
    controlHost: '0.0.0.0',
    auth: { require: false },
  });
  assert.throws(
    () => assertSafeConfig(config),
    /管理面板监听地址.*非回环.*必须开启鉴权/s,
    '面板开到非回环又关掉 token 时必须拒绝',
  );
});

test('面板监听非回环但开启鉴权 → 允许（远程运维场景，token 仍保护控制接口）', () => {
  const config = normalizeConfig({
    host: '0.0.0.0',
    controlHost: '0.0.0.0',
    auth: { require: true },
  });
  assert.doesNotThrow(() => assertSafeConfig(config));
});
