/**
 * 功能：桌面端「登录设备」的判据 —— 纯逻辑（UA/时间/排序）+ 接线（面板真的挂了这三条）。
 *
 * 注意事项：
 *   - `session-view.ts` 是纯函数，这里直接 import 源码跑（Node 类型剥离），不起浏览器；
 *   - 源码判据只认 `data-role` 与 API 调用，不认文案排版 —— 改文案不该让判据红；
 *   - 移动端必须**没有**这块（与账户自助同一条挂账纪律），所以最后一条是反向断言。
 *
 * 踩过的坑：无（首次实现）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  describeLastSeen,
  describeSession,
  sortSessions,
  summarizeUserAgent,
} from '../client/src/sync/session-view.ts';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(REPO, path), 'utf8');

const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const EDGE_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0';
const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const NOW = Date.UTC(2026, 10, 26, 8, 0, 0);

function session(overrides = {}) {
  return {
    id: 's1',
    createdAt: new Date(NOW - 3_600_000).toISOString(),
    lastSeenAt: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + 3_600_000).toISOString(),
    ip: '127.0.0.1',
    userAgent: CHROME_WIN,
    current: false,
    ...overrides,
  };
}

test('★★★ UA 识别：Edge 不许被认成 Chrome', () => {
  assert.equal(summarizeUserAgent(CHROME_WIN), 'Chrome · Windows');
  assert.equal(summarizeUserAgent(EDGE_WIN), 'Edge · Windows');
  assert.equal(summarizeUserAgent(FIREFOX_LINUX), 'Firefox · Linux');
  assert.equal(summarizeUserAgent(SAFARI_IOS), 'Safari · iOS');
});

test('★★ 认不出的 UA 原样截断，不假装认识', () => {
  assert.equal(summarizeUserAgent(''), '未知设备');
  assert.equal(summarizeUserAgent('   '), '未知设备');
  const long = 'X'.repeat(60);
  assert.equal(summarizeUserAgent(long), `${'X'.repeat(40)}…`);
  assert.equal(summarizeUserAgent('curl/8.0'), 'curl/8.0');
});

test('★★★ 最近活动：四档相对时间 + 坏值不猜', () => {
  const iso = (delta) => new Date(NOW + delta).toISOString();
  assert.equal(describeLastSeen(iso(-30_000), NOW), '刚刚');
  assert.equal(describeLastSeen(iso(0), NOW), '刚刚');
  /* 未来时间按"刚刚"：时钟偏差不该说出"3 分钟后" */
  assert.equal(describeLastSeen(iso(180_000), NOW), '刚刚');
  assert.equal(describeLastSeen(iso(-5 * 60_000), NOW), '5 分钟前');
  assert.equal(describeLastSeen(iso(-3 * 3_600_000), NOW), '3 小时前');
  assert.equal(describeLastSeen(iso(-2 * 86_400_000), NOW), '2 天前');
  assert.equal(describeLastSeen('not-a-date', NOW), '时间未知');
});

test('★★★ 排序：当前设备永远第一行，其余按最近活动倒序', () => {
  const oldestCurrent = session({ id: 'current', current: true, lastSeenAt: new Date(NOW - 86_400_000).toISOString() });
  const recent = session({ id: 'recent', lastSeenAt: new Date(NOW - 60_000).toISOString() });
  const stale = session({ id: 'stale', lastSeenAt: new Date(NOW - 7_200_000).toISOString() });

  assert.deepEqual(
    sortSessions([stale, recent, oldestCurrent]).map((item) => item.id),
    ['current', 'recent', 'stale'],
  );
  /* 不就地改入参：调用方还要拿原数组做"其它设备数量" */
  const input = [stale, recent];
  sortSessions(input);
  assert.deepEqual(input.map((item) => item.id), ['stale', 'recent']);
});

test('★★ 一行文案：IP 缺失说"未知"，时间走同一套相对描述', () => {
  const view = describeSession(session({ ip: '', lastSeenAt: new Date(NOW - 120_000).toISOString() }), NOW);
  assert.equal(view.title, 'Chrome · Windows');
  assert.equal(view.meta, 'IP 未知 · 最近活动 2 分钟前');
});

test('★★★★ 面板接线：列表 / 单台退出 / 退出其它 / 刷新，四个入口都在', () => {
  const dialog = read('client/src/sync/account-dialog.ts');
  for (const role of [
    'account-sessions',
    'account-session-row',
    'account-session-current',
    'account-session-revoke',
    'account-sessions-revoke-others',
    'account-sessions-refresh',
  ]) {
    assert.ok(dialog.includes(`'${role}'`), `缺 data-role：${role}`);
  }
  assert.match(dialog, /fetchAccountSessions\(/, '面板没有拉会话列表');
  assert.match(dialog, /revokeAccountSession\(/, '面板没有单台退出');
  assert.match(dialog, /revokeOtherSessions\(/, '面板没有"退出其它设备"');
  assert.ok(!dialog.includes('innerHTML'), '面板不许用 innerHTML');
});

test('★★★ 客户端 API 走账户会话端点，且不自己拼鉴权头', () => {
  const client = read('client/src/sync/repo-client.ts');
  assert.ok(client.includes("'/api/account/sessions'"), '列表端点不对');
  assert.ok(client.includes('/api/account/sessions/'), '单台退出端点不对');
  assert.ok(client.includes("'/api/account/sessions/revoke-all'"), '退出其它设备端点不对');
  assert.ok(client.includes('encodeURIComponent(sessionId)'), '会话 id 必须转义后再进路径');
});

test('★★★★ 安卓端不许有这块（挂账，与账户自助同一条纪律）', () => {
  const shell = read('client/src/chat/shell.ts');
  assert.ok(!shell.includes('account-sessions'), '移动端出现了登录设备 UI，违反挂账决定');
  assert.ok(!shell.includes('revokeOtherSessions'), '移动端调用了退出其它设备');
});
