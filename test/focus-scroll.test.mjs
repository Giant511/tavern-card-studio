/**
 * 「聚焦输入框滚进可见区」的算术判据（2026-11-04）。
 *
 * 用户报的现象：点输入框，键盘弹起，页面**完全不跟随**，输入框被盖住。
 *
 * CSS 那边让页面变矮，这里负责"滚不滚"。而算错这件事**全是静默的**：
 * 多滚一点用户看到内容跳一下，少滚一点看起来像"没修好"，
 * 两者都不会报错。所以算术单独钉。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FOCUS_SCROLL_MARGIN, focusScrollTop } from '../client/src/chat/focus-scroll.ts';

/* 基准：容器可见区 0–481（键盘占了下面 370），内容可滚 */
const base = {
  visibleTop: 0,
  visibleBottom: 481,
  scrollTop: 0,
  scrollHeight: 1200,
  clientHeight: 481,
};

test('★★★ 底边被键盘挡住 ⇒ 往下滚到刚好露出（含余量）', () => {
  /* 输入框在 400–450，余量 12 ⇒ 底边该落在 469 */
  const next = focusScrollTop({ ...base, elementTop: 400, elementBottom: 450 });
  assert.equal(next, 0, '450 < 469，本来就可见，不该滚');
});

test('★★★ 底边超出可见区 ⇒ 滚到 visibleBottom - 余量', () => {
  /* 输入框在 430–520，超出 481 ⇒ 需要往下滚 520-(481-12)=51 */
  const next = focusScrollTop({ ...base, elementTop: 430, elementBottom: 520 });
  assert.equal(next, 51);
});

test('★★ 顶边被挡（往回滚）⇒ 减到 visibleTop + 余量', () => {
  /*
   * 已滚到 300，输入框顶边在视口 10 处（被顶部压住 2px —— 余量要 12）
   * ⇒ overflowTop = (0 + 12) - 10 = 2 ⇒ scrollTop 300 - 2 = 298。
   *
   * 滚完之后元素顶边落在 10 + (300-298) = 12 = visibleTop + 余量 ✅
   */
  const next = focusScrollTop({
    ...base,
    scrollTop: 300,
    elementTop: 10,
    elementBottom: 60,
  });
  assert.equal(next, 298);
});

test('★★★ 完整可见 ⇒ 一动不动（用户手动滑过就别动）', () => {
  const next = focusScrollTop({ ...base, scrollTop: 120, elementTop: 200, elementBottom: 260 });
  assert.equal(next, 120);
});

test('★★★ 不许滚过内容底部（否则白屏一片）', () => {
  const next = focusScrollTop({
    ...base,
    scrollTop: 700,
    scrollHeight: 1200,
    elementTop: 1150,
    elementBottom: 1190,
  });
  assert.equal(next, 719, '1200-481=719，夹到边界');
});

test('★★ 不许滚成负数', () => {
  const next = focusScrollTop({
    ...base,
    scrollTop: 5,
    elementTop: -200,
    elementBottom: -150,
  });
  assert.equal(next, 0);
});

test('★★ 可见区没排好（bottom <= top）⇒ 不动', () => {
  const next = focusScrollTop({
    ...base,
    visibleTop: 500,
    visibleBottom: 481,
    elementTop: 600,
    elementBottom: 650,
  });
  assert.equal(next, 0);
});

test('★ 余量是 12px（改它要改这条）', () => {
  assert.equal(FOCUS_SCROLL_MARGIN, 12);
});

/* ═══════════════════════════════════════════════════════════
   二、CSS 侧：避让必须在**页面级**，且只能有一处
   ═══════════════════════════════════════════════════════════ */

test('★★★ 键盘避让只写在能真正缩矮的那几层，且同一个盒子不许扣两次', async () => {
  /*
   * ## 踩过的两个坑
   *
   * ```text
   * ① 写在 `.nb-chat`  → 只有聊天页跟随
   * ② 改到 `.nb-page`  → **完全无效**，它是 `flex: 1` 子项，高度由父容器分配，
   *                       padding 只把内容压扁（真机实测 .nb-scroll 剩 43px、
   *                       页面底边 778 一点没动）
   * ```
   *
   * 能靠 padding 真正缩矮的只有 `position: fixed; inset: 0` 的层。
   *
   * ## 为什么现在有三处消费（2026-11-22 扩展）
   *
   * 底部面板（记忆/气泡编辑）是 `position: fixed` 的**浮层**，
   * 定位基准是视口 —— `.nb-app` 的 padding 对它无效。
   * 所以面板那一族也要扣一次，但**扣的层不同**：
   *
   * ```text
   *   .nb-app           padding-bottom   聊天页（页面在它里面）
   *   .nb-sheet-mask    padding-bottom   浮层（把自己抬到键盘上方）
   *   .nb-sheet(-memory) max-height      面板本身不许高过可用区
   * ```
   *
   * ## 唯一真正的错误：同一个盒子扣两次
   *
   * 同一层既减 padding 又减 max-height，会**双倍扣**（内容区被压掉两个键盘高）。
   * 这才是当年"只许出现一次"想守的东西 —— 现在按盒子分别判。
   */
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../client/src/chat/chat.css', import.meta.url), 'utf8');

  const blockOf = (selector) => {
    const start = css.indexOf('\n' + selector + ' {');
    assert.ok(start >= 0, '找不到 ' + selector);
    const end = css.indexOf('\n}', start);
    return css.slice(start, end);
  };

  /* ── 聊天页那一层：仍是 padding ── */
  const appBlock = blockOf('.nb-app');
  assert.ok(appBlock.includes('--nb-kb-inset-native'), '.nb-app 要消费 Android 注入的键盘高度');
  assert.ok(appBlock.includes('box-sizing: border-box'), '.nb-app 必须 border-box 才能向内压');

  /* ── 浮层那一层：padding，且必须 border-box ── */
  const maskBlock = blockOf('.nb-sheet-mask');
  assert.ok(maskBlock.includes('--nb-kb-inset-native'), '.nb-sheet-mask 要扣键盘高度');
  assert.ok(maskBlock.includes('box-sizing: border-box'), 'mask 加 padding 必须 border-box');

  /* ── 面板本身：只许用 max-height，不许再 padding ── */
  for (const selector of ['.nb-sheet', '.nb-sheet--memory']) {
    const block = blockOf(selector);
    assert.ok(
      block.includes('--nb-kb-inset-native'),
      selector + ' 的 max-height 要按键盘高度收',
    );
    assert.ok(
      !/padding[a-z-]*:\s*[^;]*--nb-kb-inset/.test(block),
      selector + ' 已经在 mask 上扣过 padding，这里再扣就是双倍',
    );
  }

  /* ── 同一个盒子不许同时出现两种扣法 ── */
  for (const selector of ['.nb-app', '.nb-sheet-mask', '.nb-sheet', '.nb-sheet--memory']) {
    const block = blockOf(selector);
    const viaPadding = /padding[a-z-]*:\s*[^;]*--nb-kb-inset/.test(block);
    const viaMaxHeight = /max-height:\s*[^;]*--nb-kb-inset/.test(block);
    assert.ok(
      !(viaPadding && viaMaxHeight),
      selector + ' 同时用 padding 和 max-height 扣键盘 → 双倍',
    );
  }

  /* ── `.nb-page` 是 flex 子项，写在那里无效 —— 不许回退 ── */
  const pageBlock = blockOf('.nb-page');
  assert.ok(!pageBlock.includes('--nb-kb-inset'), '.nb-page 是 flex 子项，写在那里无效');
});

test('★★★ .nb-chat 里不许再有 padding-bottom 避让', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../client/src/chat/chat.css', import.meta.url), 'utf8');
  const chatBlock = css.slice(css.indexOf('\n.nb-chat {'), css.indexOf('.nb-tabbar {'));

  assert.doesNotMatch(chatBlock, /--nb-kb-inset/, '聊天页自己不该再扣一次');
});
