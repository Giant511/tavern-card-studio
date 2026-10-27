/**
 * ST 面板的收起 / 展开（v0.1.6 真机缺陷四）。
 *
 * ## 现场
 *
 * 点「收起」进折叠态，折叠条上那个「⟨」**点了没反应**，面板再也展不开。
 * 折叠条本身是渲染出来的、按钮也在（截图里能看到红框标着它），所以不是样式问题。
 *
 * ## 根因
 *
 * 按钮绑定写死成 `() => this.setCollapsed(true)`。收起/展开**共用一个按钮**，
 * 而写死 true 等于告诉它"永远是收起"：折叠态下点「⟨」又执行一次收起，
 * 界面当然一点变化都没有 —— 用户看到的就是"点了没反应"。
 *
 * 这不是"漏接事件"，而是**按钮自带了一份状态判断**。所以修法不是"补一个分支"，
 * 而是让状态转换只剩一处（`nextCollapsed`），按钮只调 `toggleCollapsed()`。
 *
 * ## 这组测试怎么钉
 *
 * ① 纯状态机：`setCollapsed(true)` → **点展开** → 必须展开，且宽度回到记忆值。
 * ② 静态断言：面板源码里**不许**出现 `setCollapsed(true)` / `setCollapsed(false)`
 *    以外的按钮自带判断（按钮回调必须走 toggleCollapsed）。
 * ③ 宽度派生：折叠时是条宽、展开时是记忆值 —— 不是"展开时把宽度还回去"，
 *    而是折叠期间记忆值从未被改写（不存在"忘了还"这种可能）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  COLLAPSED_WIDTH,
  nextCollapsed,
  paneWidthFor,
  toggleGlyph,
  toggleLabel,
} from '../client/src/session/st-pane-collapse.ts';

const ROOT = join(import.meta.dirname, '..');
const PANE = readFileSync(join(ROOT, 'client', 'src', 'session', 'st-pane.ts'), 'utf8');

/** 剥注释：静态断言只看代码，不看解释性文字（否则注释里的反例会被当成违规） */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ── ① 状态机（就是"点一下按钮"这件事）──────────────────────

test('收起态点展开按钮：必须展开（真机缺陷四的最小复现）', () => {
  // 用户操作序列：展开 → 点「收起」→ 点「⟨」
  let collapsed = false;
  collapsed = nextCollapsed(collapsed); // 点「收起」
  assert.equal(collapsed, true, '第一次点击应当收起');

  collapsed = nextCollapsed(collapsed); // 点「⟨」—— 这里以前是 no-op
  assert.equal(collapsed, false, '收起态再点一次必须展开（旧实现写死 true，所以点不动）');
});

test('来回点不会卡住：四次点击的状态序列是 false/true/false/true', () => {
  let collapsed = false;
  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    collapsed = nextCollapsed(collapsed);
    seen.push(collapsed);
  }
  assert.deepEqual(seen, [true, false, true, false]);
});

// ── ② 宽度：展开必须回到记忆值 ──────────────────────────────

test('宽度由状态派生：折叠是条宽，展开是记忆值', () => {
  const remembered = 612;
  assert.equal(paneWidthFor(true, remembered), COLLAPSED_WIDTH);
  assert.equal(paneWidthFor(false, remembered), remembered);
});

test('折叠不吞掉记忆值：来回切换后宽度仍等于原值', () => {
  const remembered = 612;
  // 折叠期间"宽度"一直是条宽，但记忆值没被改写 —— 所以展开必然回到 612
  for (const collapsed of [true, false, true, false]) {
    assert.equal(paneWidthFor(collapsed, remembered), collapsed ? COLLAPSED_WIDTH : remembered);
  }
});

test('折叠条宽度是正数且明显小于展开宽度（否则折叠等于没折叠）', () => {
  assert.ok(COLLAPSED_WIDTH > 0);
  assert.ok(COLLAPSED_WIDTH < 300, `折叠条 ${String(COLLAPSED_WIDTH)}px 太宽了`);
});

// ── ③ 文案：两种状态互通，且符号与标题不矛盾 ────────────────

test('符号与可读名称一一对应（折叠显示 ⟨，展开显示「收起」）', () => {
  assert.equal(toggleGlyph(true), '⟨');
  assert.equal(toggleGlyph(false), '收起');
  assert.equal(toggleLabel(true), '展开 SillyTavern 面板');
  assert.equal(toggleLabel(false), '收起 SillyTavern 面板');
});

test('折叠态的 aria-label 说的是"展开"—— 读屏用户点它应当是展开', () => {
  // 这条不是形式主义：aria-label 写错方向时，读屏用户和视觉用户会遇到同一个 bug
  assert.match(toggleLabel(true), /展开/);
  assert.doesNotMatch(toggleLabel(true), /收起/);
});

// ── ④ 静态断言：按钮不许自带状态判断 ────────────────────────

test('面板内收起按钮的绑定必须走 toggleCollapsed（不许写死方向）', () => {
  const source = stripComments(PANE);
  const binding = /this\.toggleButton\s*=\s*this\.iconButton\(\s*'[^']*'\s*,\s*'st-pane-toggle'\s*,\s*([^)]*\)?[^)]*)\)/.exec(
    source,
  );
  assert.notEqual(binding, null, '找不到 toggleButton 的绑定');
  assert.match(
    binding[1],
    /toggleCollapsed\s*\(/,
    `收起按钮必须调 toggleCollapsed()，实际绑定：${binding[1].trim()} —— ` +
      '写死 setCollapsed(true) 会让折叠态点不动（真机缺陷四）',
  );
  assert.doesNotMatch(
    binding[1],
    /setCollapsed\s*\(\s*(true|false)\s*\)/,
    '按钮回调里不许直接指定收起/展开方向：方向只能由当前状态决定',
  );
});

test('toggleCollapsed 只有一个实现，且用 nextCollapsed 决定方向', () => {
  const source = stripComments(PANE);
  const impls = [...source.matchAll(/toggleCollapsed\s*\([^)]*\)\s*:\s*void\s*\{([\s\S]*?)\n  \}/g)];
  assert.equal(impls.length, 1, `toggleCollapsed 应当只有一处实现，实际 ${String(impls.length)} 处`);
  assert.match(impls[0][1], /nextCollapsed\s*\(/, 'turn 向必须来自 nextCollapsed，不能自己写 ! 或真假值');
});

test('宽度赋值只有一处，且由 paneWidthFor 派生（避免 CSS 与 TS 各写一份）', () => {
  const source = stripComments(PANE);
  const assignments = [...source.matchAll(/--st-pane-width'/g)];
  assert.equal(
    assignments.length,
    1,
    `--st-pane-width 只该有一处 setProperty，实际 ${String(assignments.length)} 处 —— ` +
      '折叠与拖拽各写一份必然分叉（分叉的表现只是"右边多留一片空白"）',
  );

  /*
   * 判据是"这一段代码里有没有调用 paneWidthFor"，而不是"模板串里有没有"：
   * 唯一写入点先算出 width 再写进去（`const width = paneWidthFor(…)`），
   * 模板串里当然看不到函数名。第一版断言写成"模板串必须含 paneWidthFor"，
   * 于是把正确的实现判成了违规 —— **断言比事实更严也是坏的**。
   */
  const at = assignments[0].index ?? 0;
  const context = source.slice(Math.max(0, at - 600), at + 200);
  assert.match(context, /paneWidthFor\s*\(/, '宽度必须由 paneWidthFor 派生，不能在这里自己写三目运算');
});
