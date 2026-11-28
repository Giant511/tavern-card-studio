/**
 * 账户治理事件只对管理员可见（2026-11-24）。
 *
 * ## 修的是什么
 *
 * `events` 表的可见性原来是"有 `card_id` 就按卡片过滤，没有就全体可见"。
 * 账户注销事件（`account.purge.*`）故意不带 `card_id`（注销不针对某张卡），
 * 于是正好落进"全体可见"那条通路 —— 而它带的是：
 *
 * ```text
 *   targetUserId / targetUid / targetUsername   别人的账户名录
 *   actor / ip                                   谁在什么时候、从哪个 IP 干的
 *   reason                                       注销原因（可能是"违规"）
 * ```
 *
 * 一个只有 `read` 权限的仓库令牌就能把这些拉下来。这是跨租户泄露，
 * 与"看到别人有多少张卡"不是同一量级。
 *
 * ## 现在的分档
 *
 * ```text
 *   运维事件（token 轮换 / 服务启停）    与账户内容无关 → 全体可见，不传 options
 *   治理事件（account.*）               只有管理员 → 传 { includeAdminEvents: true }
 * ```
 *
 * ## 判据
 *
 * 直接对 SQLite 跑真实查询（`better-sqlite3` 同步 API，无需起进程）。
 * 两个方向都要测：**非管理员看不到**、**管理员看得到** ——
 * 只测前者的判据在"管理员也被挡住"的实现上照样会绿。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { Db } = await import('../server/dist/storage/db.js');
const { scopeFromIdentity } = await import('../server/dist/storage/card-scope.js');

const workDir = mkdtempSync(join(tmpdir(), 'tcs-event-scope-'));

test.after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** 建一个只属于 alice 的库，塞三条事件 */
function seed() {
  const db = new Db(join(workDir, `ev-${String(Date.now())}-${Math.random().toString(16).slice(2)}.db`));
  // 运维事件：不带 card_id，也不是 account.*
  db.appendEvent({ at: new Date().toISOString(), level: 'info', action: 'token.rotate', cardId: null, detail: {} });
  // 治理事件：不带 card_id，前缀 account.
  db.appendEvent({
    at: new Date().toISOString(),
    level: 'warn',
    action: 'account.purge.admin',
    cardId: null,
    detail: { targetUsername: 'bob', reason: 'test' },
  });
  return db;
}

/** 非管理员（普通账户）的可见范围 */
const USER_SCOPE = scopeFromIdentity({ via: 'jwt', userId: 'u-alice', role: 'user', username: 'alice' });

test('★★★★★ 非管理员看不到 account.* 治理事件', () => {
  const db = seed();
  const actions = db.listEvents(50, USER_SCOPE).map((row) => row.action);
  assert.ok(!actions.includes('account.purge.admin'), `泄露了治理事件：${actions.join(', ')}`);
  db.close();
});

test('★★★★★ 非管理员仍能看到运维事件（不能一刀切藏起来）', () => {
  const db = seed();
  const actions = db.listEvents(50, USER_SCOPE).map((row) => row.action);
  assert.ok(actions.includes('token.rotate'), `运维事件被误藏：${actions.join(', ')}`);
  db.close();
});

test('★★★★★ 管理员能看到 account.* 治理事件（治理页依赖它）', () => {
  const db = seed();
  const actions = db
    .listEvents(50, USER_SCOPE, { includeAdminEvents: true })
    .map((row) => row.action);
  assert.ok(actions.includes('account.purge.admin'), `管理员也看不到治理事件：${actions.join(', ')}`);
  db.close();
});

test('★★★★ ALL_CARDS 范围同样受限（不是只有"按账户过滤"那条分支才管）', () => {
  /*
   * `scope.clause === ''` 那条分支（ALL_CARDS）是另一个 SQL，容易漏改。
   * 这里显式覆盖：管理员传 true 才看得到，否则看不到。
   */
  const db = seed();
  const ALL = { kind: 'all' };
  const withoutFlag = db.listEvents(50, ALL).map((row) => row.action);
  assert.ok(!withoutFlag.includes('account.purge.admin'), 'ALL_CARDS 分支漏了过滤');
  const withFlag = db.listEvents(50, ALL, { includeAdminEvents: true }).map((row) => row.action);
  assert.ok(withFlag.includes('account.purge.admin'), 'ALL_CARDS + 管理员标记应当可见');
  db.close();
});
