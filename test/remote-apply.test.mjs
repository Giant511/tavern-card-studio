/**
 * 零标签状态下「取回 / 回滚」自动建卡（v0.1.3 追加项三）。
 *
 * 三态是需求明确要求的：**零标签取回 / 零标签回滚 / 有标签不受影响**。
 *
 * 判据里最要紧的一条是 `cardId` 恒等于服务端那个 —— 它错了不会立刻报错，
 * 而是在用户下一次「上传当前内容」时才炸：服务端会**新建一张卡**，
 * 原卡的历史留在另一条 id 下，两份历史从此分叉且无任何提示。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planRemoteApply } from '../client/src/sync/remote-apply.ts';
import { uniqueCardName } from '../client/src/editor/open-name.ts';

const SERVER_CARD_ID = 'lin-wan-zhao';

function base(overrides = {}) {
  return {
    hasSession: false,
    mode: 'restore',
    serverCardId: SERVER_CARD_ID,
    targetSeq: 3,
    remoteSeq: 3,
    cardName: '林晚照',
    existingNames: [],
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════
// 1. 零标签 + 取回
// ══════════════════════════════════════════════════════════

test('零标签取回：新建会话，cardId 用服务端那个，状态栏说清楚建了哪张卡', () => {
  const plan = planRemoteApply(base());
  assert.equal(plan.action, 'create');
  assert.equal(plan.newSessionName, '林晚照');
  assert.equal(plan.cardId, SERVER_CARD_ID, 'cardId 必须等于服务端卡 id，否则下次上传会新建远端卡');
  assert.equal(plan.baseSeq, 3);
  assert.equal(plan.status, '已创建卡片「林晚照」并载入 v3 内容');
});

test('零标签取回：与本地重名时标签加序号，但 cardId 不变', () => {
  const plan = planRemoteApply(base({ existingNames: ['林晚照', '林晚照 (2)'] }));
  assert.equal(plan.newSessionName, '林晚照 (3)');
  assert.equal(plan.cardId, SERVER_CARD_ID, '改名字不该改 id —— 它们是两件事');
  assert.ok(plan.status.includes('林晚照 (3)'), plan.status);
});

test('零标签取回：名字为空时给兜底名（不能建出一个空标签）', () => {
  const plan = planRemoteApply(base({ cardName: '   ' }));
  assert.equal(plan.newSessionName, '未命名角色');
  assert.equal(plan.cardId, SERVER_CARD_ID);
});

// ══════════════════════════════════════════════════════════
// 2. 零标签 + 回滚
// ══════════════════════════════════════════════════════════

test('零标签回滚：新建会话，基线记"远端新建的那个版本号"', () => {
  // 回滚到 v2 会在服务端新建 v6，基线必须是 6
  const plan = planRemoteApply(base({ mode: 'rollback', targetSeq: 2, remoteSeq: 6 }));
  assert.equal(plan.action, 'create');
  assert.equal(plan.baseSeq, 6, '基线记成目标版本(2)会让下次上传被误判成分叉');
  assert.equal(plan.status, '已回滚并载入 v2 内容');
  assert.equal(plan.cardId, SERVER_CARD_ID);
});

test('零标签回滚：文案里不出现"创建卡片"（那是取回才有的说法）', () => {
  const plan = planRemoteApply(base({ mode: 'rollback', targetSeq: 1, remoteSeq: 4 }));
  assert.ok(!plan.status.includes('创建'), plan.status);
  assert.ok(plan.status.includes('v1'), plan.status);
});

// ══════════════════════════════════════════════════════════
// 3. 有标签：行为完全不变
// ══════════════════════════════════════════════════════════

test('有标签取回：替换当前卡，不新建会话、不改名字', () => {
  const plan = planRemoteApply(base({ hasSession: true }));
  assert.equal(plan.action, 'replace');
  assert.equal(plan.newSessionName, null);
  assert.equal(plan.baseSeq, 3);
  assert.equal(
    plan.status,
    '已载入服务端 v3 的内容（原文件未自动保存，建议另存）',
    '有标签时的文案是 v0.1.2 就在用的，需求要求"行为不变"，所以逐字钉住',
  );
});

test('有标签回滚：同样是替换，基线仍取远端最新', () => {
  const plan = planRemoteApply(base({ hasSession: true, mode: 'rollback', targetSeq: 2, remoteSeq: 7 }));
  assert.equal(plan.action, 'replace');
  assert.equal(plan.newSessionName, null);
  assert.equal(plan.baseSeq, 7);
});

test('有标签时即使本地有同名标签，也不会给"新名字"（不新建就不需要去重）', () => {
  const plan = planRemoteApply(base({ hasSession: true, existingNames: ['林晚照'] }));
  assert.equal(plan.newSessionName, null);
});

// ══════════════════════════════════════════════════════════
// 4. 与「打开文件建卡」共用同一套去重规则
// ══════════════════════════════════════════════════════════

test('去重规则与打开文件建卡一致（不写第二份实现）', () => {
  const existing = ['A', 'A (2)'];
  assert.equal(uniqueCardName('A', existing), 'A (3)');
  assert.equal(planRemoteApply(base({ cardName: 'A', existingNames: existing })).newSessionName, 'A (3)');
});
