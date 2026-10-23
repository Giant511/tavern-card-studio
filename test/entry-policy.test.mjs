/**
 * 入口状态矩阵（v0.1.2 追加任务：凭证门槛错序修复）。
 *
 * 这一组断言守的是**顺序**而不是文案：
 *   · 能不能开始 —— 只看有没有服务端地址；
 *   · 能做什么   —— 才看有没有凭证。
 *
 * 上一版把两件事混成一件（`isSyncReady` 要求 tokenValid === true），
 * 于是"没登录"被显示成"鉴权未通过"，"没配地址"被显示成"未连接"。
 * 这些用例把每一格都钉住，改回去就会红。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canOpenAccount,
  connectionLabel,
  hasServerUrl,
  identityLabel,
  resolveAccountEntry,
  resolveServerReach,
  resolveSyncGate,
  syncGateMessage,
  syncHintText,
} from '../client/src/auth/entry-policy.ts';

const probeOk = { reachable: true, tokenValid: null, cardCount: 3, url: 'http://h:1' };
const probeDown = { reachable: false, tokenValid: null, cardCount: null, url: null };

test('地址"有没有"只看地址本身，与可达性无关', () => {
  assert.equal(hasServerUrl('http://h:1'), true);
  assert.equal(hasServerUrl('   '), false, '空白不算配置');
  assert.equal(hasServerUrl(''), false);
  assert.equal(hasServerUrl(undefined), false);
  assert.equal(hasServerUrl(null), false);
});

test('可达性：未探测/不可达都归 unreachable（仅用于展示）', () => {
  assert.equal(resolveServerReach('http://h:1', probeOk), 'reachable');
  assert.equal(resolveServerReach('http://h:1', probeDown), 'unreachable');
  assert.equal(resolveServerReach('http://h:1', null), 'unreachable');
  assert.equal(resolveServerReach('', probeOk), 'no-server', '没地址时不该说"不可达"');
});

test('账户入口：只有"没地址"才拦；令牌与探测结果都不参与', () => {
  // 关键回归：地址有、未登录 → 放行
  assert.equal(resolveAccountEntry('http://h:1', 'anonymous'), 'anonymous');
  assert.equal(canOpenAccount('anonymous'), true, '未登录必须能打开登录界面');

  assert.equal(resolveAccountEntry('http://h:1', 'authenticated'), 'authenticated');
  assert.equal(resolveAccountEntry('http://h:1', 'expired'), 'anonymous', '过期也算未登录，要能重登');

  assert.equal(resolveAccountEntry('', 'anonymous'), 'no-server');
  assert.equal(canOpenAccount('no-server'), false);

  // 探测结果完全不影响这个判断：服务端不通时仍然可以打开登录框
  // （登录请求自己会报网络错误，那才是准确的失败位置）
});

test('同步门槛：地址 + 凭证 = ready；未登录是 need-login，不是"未连接"', () => {
  assert.equal(resolveSyncGate('http://h:1', true), 'ready');
  assert.equal(resolveSyncGate('http://h:1', false), 'need-login');
  assert.equal(resolveSyncGate('', true), 'no-server');
  assert.equal(resolveSyncGate('', false), 'no-server');
});

test('同步面板文案：未登录说"登录后可同步"', () => {
  assert.match(syncGateMessage('need-login'), /登录后可同步/);
  assert.doesNotMatch(syncGateMessage('need-login'), /未连接/);
  assert.match(syncGateMessage('no-server'), /地址/);
  assert.equal(syncGateMessage('ready'), '');
});

test('同步提示条：三态文案互不相同，且未登录不写成"同步不可用"', () => {
  const ready = syncHintText('ready', 3);
  assert.match(ready.text, /同步已就绪/);
  assert.match(ready.text, /3 张卡/);
  assert.equal(ready.tone, 'ok');

  const needLogin = syncHintText('need-login', null);
  assert.match(needLogin.text, /登录后可同步/);
  assert.equal(needLogin.tone, 'warn');

  const noServer = syncHintText('no-server', null);
  assert.match(noServer.text, /地址/);
  assert.equal(noServer.tone, 'warn');
  assert.notEqual(needLogin.text, noServer.text, '两种"不能同步"的原因必须分开说');
});

test('连接胶囊：四态文案', () => {
  assert.deepEqual(connectionLabel('', null, 'anonymous'), { text: '未配置', tone: 'off' });
  assert.deepEqual(connectionLabel('http://h:1', probeDown, 'anonymous'), { text: '未连接', tone: 'off' });
  // 可达但没登录：不是错误状态，用 warn 而不是 bad
  assert.deepEqual(connectionLabel('http://h:1', probeOk, 'anonymous'), {
    text: '已连接 · 未登录',
    tone: 'warn',
  });
  assert.deepEqual(connectionLabel('http://h:1', probeOk, 'authenticated'), { text: '已连接', tone: 'on' });
});

test('身份行：已登录显示账户令牌，不显示"全局令牌"', () => {
  assert.equal(identityLabel('authenticated', { userId: 'u1', username: 'alice', role: 'user' }), '已登录：alice（账户令牌）');
  assert.equal(
    identityLabel('authenticated', { userId: 'u1', username: 'root', role: 'admin' }),
    '已登录：root（管理员 · 账户令牌）',
  );
  assert.equal(identityLabel('anonymous', null), '未登录');
  assert.match(identityLabel('expired', { userId: 'u1', username: 'alice', role: 'user' }), /登录已过期（alice）/);
});
