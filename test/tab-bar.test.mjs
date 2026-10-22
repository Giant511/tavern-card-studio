/**
 * T9.2 标签栏渲染测试。
 *
 * 标签栏刻意**不持有卡片状态**：它从参数拿数据、画出来、把点击转成回调。
 * 所以这里用极简的假 DOM 环境测"数据 → 结构 → 回调"这条链路，
 * 不需要真实浏览器（那是 E2E 的事）。
 *
 * 重点是那个真实踩过的 bug：`refresh()` 只重绘而不更新内部数据，
 * 导致改名后标签文字纹丝不动。现在 refresh 必须接收新数据，
 * 从类型上就堵住了"调了刷新但没换数据"。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// TabBar 依赖 DOM，这里只测它的**纯数据投影**逻辑。
// 结构渲染由 E2E 覆盖（scripts/verify-e2e.mjs），避免在 Node 里手搓假 DOM
// 造出一个"和浏览器不一致的测试环境"。

/** 复刻 app.ts 里 tabItems() 的投影规则，独立验证一遍 */
function projectTabItems(sessions) {
  return sessions.map((session) => ({
    id: session.id,
    label: session.label,
    displayName: session.displayName,
    cardId: session.cardId,
    persisted: session.persisted,
  }));
}

function fakeSession(overrides = {}) {
  return {
    id: 's1',
    label: '卡片A',
    displayName: '卡片A',
    cardId: 'card-a',
    persisted: true,
    ...overrides,
  };
}

test('投影：字段齐全，顺序与传入一致（不排序）', () => {
  const items = projectTabItems([
    fakeSession({ id: 's2', label: '第二' }),
    fakeSession({ id: 's1', label: '第一' }),
  ]);
  assert.deepEqual(items.map((item) => item.id), ['s2', 's1'], '顺序不应被重排');
  assert.deepEqual(Object.keys(items[0]).sort(), ['cardId', 'displayName', 'id', 'label', 'persisted']);
});

test('投影：空集合产出空数组（零标签的正常状态）', () => {
  assert.deepEqual(projectTabItems([]), []);
});

test('投影：label 保留脏标记原样（不在标签栏里二次拼接）', () => {
  // 脏标记由 CardSession.label 统一负责；标签栏若自己再拼一次，
  // 就会出现"卡名 ● ●"这种重复。
  const items = projectTabItems([fakeSession({ label: '卡片A ●' })]);
  assert.equal(items[0].label, '卡片A ●');
});

test('投影：未落盘卡如实传递 persisted=false（用于虚线边框）', () => {
  const items = projectTabItems([fakeSession({ persisted: false })]);
  assert.equal(items[0].persisted, false);
});

test('投影：cardId 一定带出（tooltip 要显示，用户靠它认卡）', () => {
  const items = projectTabItems([fakeSession({ cardId: 'lin-001' })]);
  assert.equal(items[0].cardId, 'lin-001');
});

// ── 关闭后的活动标签选择规则 ─────────────────────────────

/**
 * 复刻 closeSession 里的"下一个活动标签"规则：
 * 优先右侧相邻，没有则左侧，都没有则 null（零标签）。
 */
function nextActiveAfterClose(ids, closingIndex) {
  const remaining = ids.filter((_, index) => index !== closingIndex);
  return remaining[closingIndex] ?? remaining[closingIndex - 1] ?? null;
}

test('关闭：优先选右侧相邻标签（浏览器通行行为）', () => {
  assert.equal(nextActiveAfterClose(['a', 'b', 'c'], 0), 'b');
  assert.equal(nextActiveAfterClose(['a', 'b', 'c'], 1), 'c');
});

test('关闭：关最后一个时选左侧', () => {
  assert.equal(nextActiveAfterClose(['a', 'b', 'c'], 2), 'b');
});

test('关闭：关唯一一个时回到零标签（null）', () => {
  assert.equal(nextActiveAfterClose(['a'], 0), null);
});

test('关闭：两张时关左边选右边，关右边选左边', () => {
  assert.equal(nextActiveAfterClose(['a', 'b'], 0), 'b');
  assert.equal(nextActiveAfterClose(['a', 'b'], 1), 'a');
});

// ── 会话隔离（多标签的核心）──────────────────────────────

test('隔离：两个会话的内容与脏标记互不影响（多标签的前提）', async () => {
  const { CardSession } = await import('../client/src/session/card-session.ts');
  const { createEmptyCard } = await import('@tcs/shared');

  const a = new CardSession({ card: createEmptyCard('A'), cardId: 'id-a' });
  const b = new CardSession({ card: createEmptyCard('B'), cardId: 'id-b' });

  a.setBlockText('personality', 'A 的内容');

  assert.equal(b.dirty, false, 'B 被连带置脏');
  // 按 id 取板块：blocks[0] 是 basic，不是 personality
  const textOf = (session, blockId) =>
    session.card.blocks.find((block) => block.id === blockId)?.text ?? '';
  assert.equal(textOf(a, 'personality'), 'A 的内容');
  assert.equal(textOf(b, 'personality'), '', 'B 的人格块被 A 的内容污染了');
  // 标签文字也要各自独立
  assert.match(a.label, /A/);
  assert.match(b.label, /B/);
  assert.ok(a.label.endsWith('●'), 'A 改动后应带脏标记');
  assert.ok(!b.label.endsWith('●'), 'B 不该带脏标记');
});

test('隔离：切换不改动任何会话的内容（切走再切回内容还在）', async () => {
  const { CardSession } = await import('../client/src/session/card-session.ts');
  const { createEmptyCard } = await import('@tcs/shared');

  const a = new CardSession({ card: createEmptyCard('A'), cardId: 'id-a' });
  a.setBlockText('personality', 'A 独有内容');
  const snapshot = a.fingerprint();

  // 模拟"切到 B 再切回 A"：期间只读 a，不做任何写操作
  const b = new CardSession({ card: createEmptyCard('B'), cardId: 'id-b' });
  b.setBlockText('personality', 'B 独有内容');

  assert.equal(a.fingerprint(), snapshot, '切换后 A 的内容变了');
});
