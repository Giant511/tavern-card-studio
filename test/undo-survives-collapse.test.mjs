/**
 * P1-10：撤销随折叠丢失。
 *
 * ## 缺陷
 *
 * 折叠板块时 `BlockEditor` 被 `destroy()`，展开时用 `EditorState.create()`
 * 重建。而 CodeMirror 的撤销栈**就在 `EditorState` 里** —— 于是：
 *
 * ```text
 *   展开 → 打字 → 折叠 → 展开 → Ctrl+Z    什么都没发生
 * ```
 *
 * 用户的预期是"撤销我上一步编辑"，与"我中间折叠过"无关。这条缺陷比一般
 * 撤销问题更烦人：它不报错、不崩，只是"撤销键突然没反应了"，
 * 而用户会怀疑自己记错了。
 *
 * ## 这个文件守三层
 *
 * ```text
 * ① 行为（真 CodeMirror state）—— 复用 state 之后 undo 必须真能撤回
 * ② 决策（纯函数）            —— 什么情况下**不许**复用（内容会被回退）
 * ③ 接线（静态）              —— collapse 存、expand 复用、用完清
 * ```
 *
 * 第 ① 层用 mock target 驱动 `undo` 命令，不需要浏览器：
 * `undo` 只要求 `{ state, dispatch }`。第 ③ 层不能省 —— 决策写得再对，
 * 只要 collapse 没存或 expand 没取，缺陷就还在。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { EditorState } from '@codemirror/state';
import { history, undo, undoDepth } from '@codemirror/commands';

import { makeUndoSnapshot, pickUndoState } from '../client/src/editor/undo-snapshot.ts';

const ROOT = join(import.meta.dirname, '..');
const BLOCK_ACTIONS = readFileSync(join(ROOT, 'client/src/editor/block-actions.ts'), 'utf8');

/** 去掉注释再匹配 —— 否则解释规则的文字会被当成代码（踩过） */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** `undo` / `redo` 只要求 target 有 state 与 dispatch，不需要真 view */
function makeTarget(state) {
  let current = state;
  return {
    get state() {
      return current;
    },
    dispatch(tr) {
      current = tr.state ?? tr;
    },
  };
}

/** 造一个"打过字"的编辑器状态 */
function typedState(initial, inserted) {
  let state = EditorState.create({ doc: initial, extensions: [history()] });
  state = state.update({ changes: { from: initial.length, insert: inserted } }).state;
  return state;
}

/* ═══════════════════════════════════════════════════════════
   ① 行为：复用 state 之后，撤销真的能撤回
   ═══════════════════════════════════════════════════════════ */

test('★★★ 折叠 → 展开 → 撤销必须回到折叠前的内容（P1-10 本体）', () => {
  /*
   * 模拟真实时序：
   *   展开  → 建空编辑器
   *   打字  → 产生撤销栈
   *   折叠  → 存快照、销毁 editor
   *   展开  → **复用快照**（修复点）
   *   撤销  → 必须回到打字前
   */
  const typed = typedState('原始内容', '我新打的字');
  assert.equal(undoDepth(typed), 1, '前提：打字后应有一层撤销栈');

  // 折叠：存快照
  const saved = makeUndoSnapshot(typed, null);

  // 展开：走决策函数（文本与高亮都没变 ⇒ 复用）
  const reused = pickUndoState(saved, typed.doc.toString(), null);
  assert.notEqual(reused, null, '文本与高亮都没变，应当复用快照');

  // 撤销
  const target = makeTarget(reused);
  undo(target);
  assert.equal(
    target.state.doc.toString(),
    '原始内容',
    '折叠过之后撤销仍然要能撤回刚才打的字',
  );
});

test('★★★ 对照：不复用（新建）时撤销无效 —— 说明判据能分辨两种实现', () => {
  /*
   * 这条是"阴性对照"。如果它和上一条都通过，说明判据真的在验行为，
   * 而不是"任何实现都能过"。
   *
   * 它也正好描述了**修复前**的症状。
   */
  const typed = typedState('原始内容', '我新打的字');
  const rebuilt = EditorState.create({
    doc: typed.doc.toString(),
    extensions: [history()],
  });

  assert.equal(undoDepth(rebuilt), 0, '用 create() 重建同内容 state，栈必须归零');

  const target = makeTarget(rebuilt);
  undo(target);
  assert.equal(
    target.state.doc.toString(),
    '原始内容我新打的字',
    '新建的 state 撤销后文本不变 —— 这就是折叠前的旧行为',
  );
});

test('★★ 复用快照后还能继续编辑，且新编辑也进栈', () => {
  const typed = typedState('a', 'b');
  const reused = pickUndoState(makeUndoSnapshot(typed, null), 'ab', null);
  assert.notEqual(reused, null);

  // 复用之后再打一个字
  const more = reused.update({ changes: { from: 2, insert: 'c' } }).state;
  assert.equal(more.doc.toString(), 'abc');

  /*
   * 只验行为：撤销之后内容确实变了。
   *
   * 不验 `undoDepth` 变深 —— 那条第一版写过，红了。原因：CodeMirror 的
   * `newGroupDelay`（默认 500ms）会把相邻编辑**合并成一组**，同步连做的
   * 两次编辑算一步，depth 保持 1。那是它的正常行为，不是缺陷。
   *
   * 也不验"一次 undo 精确回到 ab" —— 同理，回到 a 还是 ab 取决于分组时机。
   */
  const target = makeTarget(more);
  undo(target);
  assert.notEqual(target.state.doc.toString(), 'abc', '复用后的新编辑必须能撤销');
});

/* ═══════════════════════════════════════════════════════════
   ② 决策：三种情况必须拒绝复用
   ═══════════════════════════════════════════════════════════ */

test('★★★ 没有快照时返回 null（首次展开）', () => {
  assert.equal(pickUndoState(null, '任意', null), null);
});

test('★★★ 文本被别处改过就不许复用（否则用户改动被悄悄回退）', () => {
  /*
   * 折叠期间内容可能被别的路径改掉：应用预设、重新导入、远端取回、回滚。
   * 那些改动不在旧 state 里。复用旧 state 会把用户的改动**回退掉** ——
   * 比"撤销无效"危险得多。
   */
  const typed = typedState('原始内容', '旧编辑');
  const saved = makeUndoSnapshot(typed, null);

  assert.equal(
    pickUndoState(saved, '原始内容完全不同的新内容', null),
    null,
    '文本不一致必须拒绝',
  );
});

test('★★★ 同长度但内容不同也必须拒绝（不能靠长度判）', () => {
  /*
   * 第一版想用 `doc.length === text.length` 做校验 —— 长度相同但改了一个字
   * 会误判为"可复用"，于是用户那处改动被悄悄回退。
   */
  const typed = typedState('aaaa', 'x');
  const saved = makeUndoSnapshot(typed, null);

  assert.equal(typed.doc.toString().length, 'aaabx'.length + 0, '前提：两者长度相同');
  assert.equal(pickUndoState(saved, 'aaabx', null), null, '长度相同但内容不同，必须拒绝');
});

test('★★★ 高亮规则换过就不许复用（装饰扩展闭包在 state 里）', () => {
  const typed = typedState('t', '1');
  const oldRule = { name: '旧方案' };
  const newRule = { name: '新方案' };
  const saved = makeUndoSnapshot(typed, oldRule);

  assert.equal(pickUndoState(saved, 't1', newRule), null, '高亮换了必须拒绝');
  assert.notEqual(pickUndoState(saved, 't1', oldRule), null, '高亮没换就复用');
});

/* ═══════════════════════════════════════════════════════════
   ③ 接线：collapse 存、expand 取、用完清
   ═══════════════════════════════════════════════════════════ */

test('★★★ collapse 必须在 destroy 之前存快照', () => {
  const body = stripComments(
    BLOCK_ACTIONS.slice(BLOCK_ACTIONS.indexOf('export function collapse(')),
  ).slice(0, 1600);

  const snapshotAt = body.indexOf('makeUndoSnapshot(');
  const destroyAt = body.indexOf('runtime.editor?.destroy()');
  assert.notEqual(snapshotAt, -1, 'collapse 必须调 makeUndoSnapshot —— 否则折叠即丢撤销栈');
  assert.notEqual(destroyAt, -1, 'collapse 里应该有 destroy');
  assert.ok(
    snapshotAt < destroyAt,
    '存快照必须在 destroy **之前**：destroy 之后再读 state 拿不到可信值',
  );
});

test('★★★ expand 必须尝试复用快照', () => {
  const body = stripComments(
    BLOCK_ACTIONS.slice(BLOCK_ACTIONS.indexOf('export function expand(')),
  ).slice(0, 2200);

  assert.match(body, /pickUndoState\(/, 'expand 必须调 pickUndoState，否则存了也没人用');
  assert.match(
    body,
    /state:\s*reused/,
    '复用路径必须把取到的 state 交给 BlockEditor（走 state 分支，不是 text 分支）',
  );
});

test('★★ expand 复用后要把 runtime.undo 清空', () => {
  /*
   * 不清的后果：下次折叠时那份**已经落后**的旧 state 会被当成新快照存下来，
   * 于是第二次展开时校验通不过（或更糟，通过了一个错误的），撤销栈错乱。
   */
  const body = stripComments(
    BLOCK_ACTIONS.slice(BLOCK_ACTIONS.indexOf('export function expand(')),
  ).slice(0, 2200);

  assert.match(body, /runtime\.undo\s*=\s*null/, '复用后必须清空 runtime.undo');
});

test('★★ createBlock 必须把 undo 初始化成 null', () => {
  assert.match(
    stripComments(BLOCK_ACTIONS),
    /undo:\s*null/,
    '新建的块没有折叠过的现场，undo 必须是 null（否则会读到 undefined 走错分支）',
  );
});

test('★★ BlockEditor 的复用分支不许再传 extensions（会被静默忽略）', () => {
  /*
   * `EditorViewConfig` 的文档：只有没给 state 时才用 doc/extensions 创建。
   * 同时给 state 和 extensions，extensions 会被**静默忽略** ——
   * 新的 onChange 不生效，症状是"打字没反应"，而且不报错。
   */
  const editor = stripComments(
    readFileSync(join(ROOT, 'client/src/editor/block-editor.ts'), 'utf8'),
  );
  const reuseBranch = editor.slice(
    editor.indexOf('if (options.state !== undefined)'),
    // 切到 `const extensions` 之前 —— 那之后是新建路径，本来就该有 extensions
    editor.indexOf('const extensions'),
  );
  assert.ok(reuseBranch.length > 0, '找不到复用分支');
  assert.ok(
    !/extensions/.test(reuseBranch),
    '复用分支不许传 extensions：会被静默忽略',
  );
});
