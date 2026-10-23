/**
 * T10.8 单测：仓库选择与令牌展示的纯逻辑。
 *
 * 重点钉住两条会被"看起来能用"掩盖的问题：
 *   · 预选仓库：remembered 指向已删除的仓库时不能盲选它（否则上传会写到不存在的仓库）；
 *   · 令牌过期/吊销的展示顺序：吊销优先于过期（一把被吊销但未过期的令牌仍然不可用）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  describeExpiry,
  describeScopes,
  pickRepoId,
  toRepoOptions,
  tokenState,
  uploadTargetText,
} from '../client/src/sync/repo-select.ts';

const repo = (id, name, isDefault = false, cardCount = 0) => ({
  id,
  name,
  description: '',
  isDefault,
  cardCount,
  createdAt: '2026-10-23T00:00:00.000Z',
});

test('T10.8 预选仓库：默认仓库优先', () => {
  const repos = [repo('r2', 'work'), repo('r1', 'default', true)];
  assert.equal(pickRepoId(repos), 'r1');
});

test('T10.8 预选仓库：没有默认标记时取第一个', () => {
  const repos = [repo('r2', 'work'), repo('r3', 'other')];
  assert.equal(pickRepoId(repos), 'r2');
});

test('T10.8 预选仓库：remembered 仍然存在时优先（连着传几张不用反复选）', () => {
  const repos = [repo('r1', 'default', true), repo('r2', 'work')];
  assert.equal(pickRepoId(repos, 'r2'), 'r2');
});

test('T10.8 预选仓库：remembered 指向已删除的仓库时**回落**，不盲选', () => {
  const repos = [repo('r1', 'default', true)];
  assert.equal(pickRepoId(repos, 'r-deleted'), 'r1');
});

test('T10.8 预选仓库：空列表返回 null（不假装选中）', () => {
  assert.equal(pickRepoId([]), null);
  assert.equal(pickRepoId([], 'r1'), null);
});

test('T10.8 仓库下拉项：默认仓库带标记，其余不带', () => {
  const options = toRepoOptions([repo('r1', 'default', true, 3), repo('r2', 'work')]);
  assert.deepEqual(
    options.map((option) => option.label),
    ['default（默认）', 'work'],
  );
  assert.equal(options[0].cardCount, 3);
});

test('T10.8 上传目标文案：三项齐全（名字 · cardId · 仓库）', () => {
  assert.equal(
    uploadTargetText({ cardName: '林晚照', cardId: 'c-1', repoName: 'default' }),
    '林晚照 · c-1 · default',
  );
  // 未归属仓库要显式说出来，不能留空
  assert.equal(
    uploadTargetText({ cardName: '林晚照', cardId: 'c-1', repoName: null }),
    '林晚照 · c-1 · 未归属仓库',
  );
});

test('T10.8 范围文案：delete 归属"写"，与 requiredScope() 单一来源一致', () => {
  assert.equal(describeScopes(['read']), '读');
  assert.equal(describeScopes(['read', 'write']), '读 + 写（含删除）');
  assert.equal(describeScopes(['read', 'write', 'rollback']), '读 + 写（含删除） + 回滚');
  assert.equal(describeScopes([]), '（无范围）');
});

test('T10.8 过期展示：null 必须显式说"永不过期"（空白会被读成"不知道"）', () => {
  assert.equal(describeExpiry(null), '永不过期');
  assert.equal(describeExpiry(''), '永不过期');
  const now = Date.parse('2026-10-23T00:00:00.000Z');
  assert.equal(describeExpiry('2027-01-01T00:00:00.000Z', now), '2027-01-01');
  assert.match(describeExpiry('2026-01-01T00:00:00.000Z', now), /已过期/);
});

test('T10.8 令牌状态：吊销优先于过期', () => {
  const now = Date.parse('2026-10-23T00:00:00.000Z');
  // 已吊销且未过期 → revoked（不能说"可用"）
  assert.equal(
    tokenState({ revokedAt: '2026-10-22T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' }, now),
    'revoked',
  );
  // 未吊销但已过期 → expired
  assert.equal(tokenState({ revokedAt: null, expiresAt: '2026-01-01T00:00:00.000Z' }, now), 'expired');
  // 正常
  assert.equal(tokenState({ revokedAt: null, expiresAt: '2027-01-01T00:00:00.000Z' }, now), 'active');
  // 永不过期
  assert.equal(tokenState({ revokedAt: null, expiresAt: null }, now), 'active');
});
