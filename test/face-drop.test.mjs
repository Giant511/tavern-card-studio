/**
 * 取回落盘的撞名决策（v0.1.7 增补三）—— `decideFaceDrop` 的单元测试。
 *
 * ## 为什么每一条都要测
 *
 * 这一组决策的错法**全部是"静默丢数据"**：
 *   · 该问的时候直接覆盖 → 用户手工改过的那份没了；
 *   · 该覆盖的时候另存 → 磁盘上堆 `(2)(3)(4)`，用户分不清哪份是真正在用的；
 *   · 异卡撞名当成同卡 → 覆盖掉别人的卡；
 *   · 标签占用不转交 → 内存与磁盘不一致，编辑器里还是旧内容。
 *
 * 而且它们**都不会报错**，全都"看起来很成功"。所以必须逐支穷举，
 * 包括优先级顺序（标签占用必须压过身份判定）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decideFaceDrop, DIRTY_CHOICES, saveAsLabel } from '../client/src/export/face-drop.ts';

const CID = 'card-abc123';

/** 默认输入：目标存在、同卡、干净、未被打开、不比远端新 */
function input(overrides = {}) {
  return {
    targetExists: true,
    localCardId: CID,
    incomingCardId: CID,
    openInTab: false,
    localDirty: false,
    localNewer: false,
    ...overrides,
  };
}

test('目标不存在 → 直接写，不做任何询问', () => {
  assert.equal(decideFaceDrop(input({ targetExists: false, localCardId: null })).kind, 'write');
});

test('同卡 + 本地干净 → 直接覆盖（工作副本保持唯一，不产生编号垃圾）', () => {
  const d = decideFaceDrop(input());
  assert.equal(d.kind, 'overwrite');
  assert.match(d.reason, /直接覆盖/);
});

test('同卡 + 有未保存修改 → 三选，不静默覆盖', () => {
  const d = decideFaceDrop(input({ localDirty: true }));
  assert.equal(d.kind, 'ask-dirty');
  assert.match(d.reason, /未保存/);
});

test('同卡 + 本地比远端新 → 也算脏（可能用别的工具改过）', () => {
  const d = decideFaceDrop(input({ localNewer: true }));
  assert.equal(d.kind, 'ask-dirty');
  assert.match(d.reason, /更新/);
});

test('本地无 cardId（老卡 / 外部导入）→ 询问，**不**自动覆盖也不自动另存', () => {
  const d = decideFaceDrop(input({ localCardId: null }));
  assert.equal(d.kind, 'ask-unknown');
  assert.match(d.reason, /没有卡片标识/);
});

/*
 * 这条防的是"空串等于空串"的隐蔽 bug。
 *
 * 若不拦，`incomingCardId === ''` 与 `localCardId === ''` 会被判成同一张卡，
 * 于是第二张静默覆盖第一张 —— 而这两个恰恰是最不该判等的一对。
 */
test('我方没有 cardId（空串）→ 询问，不能因为"都是空串"就判同卡覆盖', () => {
  const d = decideFaceDrop(input({ localCardId: '', incomingCardId: '' }));
  assert.equal(d.kind, 'ask-unknown');
  assert.match(d.reason, /卡片标识/);
});

test('本地有 cardId 但我方没有 → 仍然询问（无法证明是同一张）', () => {
  const d = decideFaceDrop(input({ localCardId: 'card-other', incomingCardId: '' }));
  assert.equal(d.kind, 'ask-unknown');
  assert.match(d.reason, /还没有卡片标识/);
});

test('异卡撞名 → 加序号另存，不动对方那份', () => {
  const d = decideFaceDrop(input({ localCardId: 'card-other' }));
  assert.equal(d.kind, 'save-as');
  assert.match(d.reason, /另一张卡/);
});

/* ───────────── 优先级 ───────────── */

test('标签占用压过"同卡干净"：不能绕过内存里的编辑器直接写盘', () => {
  const d = decideFaceDrop(input({ openInTab: true }));
  assert.equal(d.kind, 'defer-to-open-tab');
});

test('标签占用压过"无 cardId"：走既有的导入替换确认，不重复弹窗', () => {
  const d = decideFaceDrop(input({ openInTab: true, localCardId: null }));
  assert.equal(d.kind, 'defer-to-open-tab');
});

test('标签占用压过"异卡"', () => {
  const d = decideFaceDrop(input({ openInTab: true, localCardId: 'card-other' }));
  assert.equal(d.kind, 'defer-to-open-tab');
});

test('目标不存在时，即便"打开着"也直接写（没有同名文件要替换）', () => {
  assert.equal(decideFaceDrop(input({ targetExists: false, openInTab: true })).kind, 'write');
});

test('无 cardId 压过"脏"：身份都没有，谈不上干不干净', () => {
  const d = decideFaceDrop(input({ localCardId: null, localDirty: true }));
  assert.equal(d.kind, 'ask-unknown');
});

/* ───────────── 弹窗文案 ───────────── */

test('三选按钮的顺序是 覆盖本地 / 另存为 / 查看差异，且覆盖被标成危险动作', () => {
  assert.deepEqual(
    DIRTY_CHOICES.map((c) => c.id),
    ['overwrite', 'save-as', 'diff'],
  );
  assert.equal(DIRTY_CHOICES[0].danger, true, '覆盖本地必须标成危险动作');
  assert.notEqual(DIRTY_CHOICES[2].danger, true, '查看差异不是危险动作');
});

test('另存文案把序号插在扩展名之前', () => {
  assert.equal(saveAsLabel('西奥.png'), '另存为 西奥 (2).png');
  assert.equal(saveAsLabel('西奥.v2.png'), '另存为 西奥.v2 (2).png');
});

test('没有扩展名时不能把序号拼到文件名里', () => {
  assert.equal(saveAsLabel('西奥'), '另存为 西奥 (2)');
});
