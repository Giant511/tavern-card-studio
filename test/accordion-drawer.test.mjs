/**
 * 「我的」页 / 「卡片」页收纳项的**抽屉形态**判据（2026-11-05）。
 *
 * ## 为什么要单开一条
 *
 * 用户说：「我的页面的抽屉式UI你没有改」。
 *
 * 上一轮我只改了人设抽屉和世界书抽屉（`.nb-drawer`），漏了 `renderAccordion`
 * 产生的收纳项（`.nb-acc-panel`）—— 而它长得和抽屉第一版**一模一样**的那个缺陷：
 *
 * ```text
 *   ┏━━━━━━━━━━━━━━━┓   行：紫边框 + 下圆角 16  → 看起来是一张完整的卡
 *   ┃ API 连接    ⌄  ┃
 *   ┗━━━━━━━━━━━━━━━┛
 *   ┃               ┃   面板：只有左边一条紫色竖条 + 极淡白边、底色还不同
 * ```
 *
 * 真机量到的原始数据（`.verify/diag-me-accordion.mjs`）：
 *
 * ```text
 *   headerBorder = [rgb(139,92,246) ×4]        行：实心紫，四边
 *   panelBorder  = [rgb(244,242,251),         面板：上边回落成**文字色**
 *                   rgba(255,255,255,.086) ×3]      其余三边是极淡白
 *   headerBottomRadius = 16px                  行下圆角没归零
 *   panelTopWidth = 0px                        面板上边宽 0（肉眼看不见）
 *   headerBg = rgb(38,34,53) vs panelBg = rgb(28,25,41)   两个块
 * ```
 *
 * 注意 `panelBorder[0]` 是 `rgb(244,242,251)` —— 那是 `--nb-text-1`，
 * 说明面板的 `border-top` 简写把 `border-top-color` 重置成了 `currentColor`。
 * 与人设抽屉踩过的是同一个坑（§106.12），宽度 0 所以肉眼不可见。
 *
 * ## 判据分两层
 *
 * 1. **静态**（本文件）：CSS 里必须写成"行 + 相邻兄弟面板"这一对规则，
 *    且不许再有左侧竖条 —— 这类缺陷只在真机截图里看得出来，
 *    但成因（两份色值、竖条）在源码里就能钉死。
 * 2. **真机**（`.verify/probe-me-drawer.mjs`）：逐条比四边颜色、圆角、缝隙。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** 剥注释（解释文字里会引用被禁的写法） */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
}

const css = stripComments(read('client/src/chat/chat.css'));

/** 取某个选择器的规则体 */
function ruleBody(src, selector) {
  const at = src.indexOf(`${selector} {`);
  assert.ok(at >= 0, `找不到规则 ${selector}`);
  const end = src.indexOf('}', at);
  return src.slice(at, end + 1);
}

test('★★★ 展开行与面板必须用同一个边框 token（框只框半截的来源）', () => {
  /*
   * 用相邻兄弟选择器，而不是给面板单独写一遍色值 ——
   * 两处各写一份，改一处忘另一处，"半截框"就会回来。
   */
  const row = ruleBody(css, ".nb-src-item[aria-expanded='true']");
  assert.match(
    row,
    /border-color:[ \t]*var\(--nb-card-open-border\)/,
    '展开行必须用 --nb-card-open-border（与人设/世界书抽屉同一个 token）',
  );

  const panel = ruleBody(css, ".nb-src-item[aria-expanded='true'] + .nb-acc-panel");
  assert.match(
    panel,
    /border-color:[ \t]*var\(--nb-card-open-border\)/,
    '面板必须跟随同一个 token，且挂在相邻兄弟选择器上',
  );
  assert.match(panel, /border-top:[ \t]*0/, '面板上边由行的底边充当，不能再画一道（否则叠成 2px）');

  /*
   * ★★★ 顺序：`border-top: 0` 必须在 `border-color` **之前**。
   *
   * 它是简写，展开含 `border-top-color: currentColor`。写在后面会把上边颜色
   * 重置成文字色（近白）。宽度 0 时肉眼看不见 —— 真机上就是这么漏过去的：
   * 面板 `borderTopColor` 量出来是 `rgb(244, 242, 251)`，其余三边是紫色。
   * 人设抽屉踩过同一个坑（§106.12），这里同一个判据再守一遍。
   */
  const iTop = panel.indexOf('border-top:');
  const iColor = panel.indexOf('border-color:');
  assert.ok(iTop >= 0 && iColor >= 0, '找不到 border-top 或 border-color');
  assert.ok(
    iTop < iColor,
    'border-top: 0 必须写在 border-color 之前，否则上边颜色会被重置成 currentColor',
  );
});

test('★★★ 行下圆角与下外边距必须归零（否则中间露出一条缝）', () => {
  const row = ruleBody(css, ".nb-src-item[aria-expanded='true']");
  assert.match(row, /border-bottom-left-radius:[ \t]*0/, '左下圆角要归零');
  assert.match(row, /border-bottom-right-radius:[ \t]*0/, '右下圆角要归零');
  assert.match(row, /margin-bottom:[ \t]*0/, '下外边距要归零，面板才接得上');
});

test('★★★ 面板不许再用左侧 3px 竖条（用户两次都说它丑）', () => {
  /*
   * 竖条是"半截的框"：只贴左边，展开之后上下左右都不连续。
   * 用户原话「要表示层级就全部框选」「左边只有一个竖条」。
   */
  assert.doesNotMatch(
    css,
    /inset 3px 0 0 0/,
    '整个 chat.css 里不许再有 `box-shadow: inset 3px 0 0 0`（左侧竖条已废弃）',
  );
});

test('★★★ 行与面板底色必须相同（两个块最明显的破绽就是底色不同）', () => {
  const row = ruleBody(css, ".nb-src-item[aria-expanded='true']");
  const panel = ruleBody(css, ".nb-src-item[aria-expanded='true'] + .nb-acc-panel");
  const base = ruleBody(css, '.nb-acc-panel');

  const rowBg = /background:[ \t]*(var\(--nb-surface-\d\))/.exec(row)?.[1];
  assert.ok(rowBg !== undefined, '展开行必须显式设底色（否则会沿用 surface-1，与面板不同）');

  /* 面板那侧：相邻兄弟规则里要么显式写，要么靠基础规则；两者必须一致 */
  const panelBg = /background:[ \t]*(var\(--nb-surface-\d\))/.exec(panel)?.[1]
    ?? /background:[ \t]*(var\(--nb-surface-\d\))/.exec(base)?.[1];
  assert.equal(panelBg, rowBg, `行底 ${String(rowBg)} 与面板底 ${String(panelBg)} 必须相同`);
});

test('★★ 面板上外边距为 0（原来是 -4px 用来抵消行的下外边距，现在两边都是 0）', () => {
  const base = ruleBody(css, '.nb-acc-panel');
  assert.match(base, /margin:[ \t]*0[ \t]/, '面板 margin 的第一段（上）必须是 0');
  assert.doesNotMatch(base, /margin:[ \t]*calc\(/, '不应用负外边距互相抵消 —— 那种写法改一边就裂开');
});

test('★★ 选中态仍然有视觉表达（aria-pressed 的规则不许被删）', () => {
  /*
   * `test/mobile-ui-fixes.test.mjs` 有一条硬要求：`[aria-pressed='true']`
   * 必须被至少一条 CSS 规则消费，否则"点了接口选项没有任何可见变化"。
   *
   * 这一轮我把竖条换成了"边框 + 底色"，规则本身必须还在。
   */
  const pressed = ruleBody(css, ".nb-src-item[aria-pressed='true']");
  assert.match(pressed, /border-color:/, '选中态要有边框色');
  assert.match(pressed, /background:/, '选中态要有底色');
});

test('★★ 同一选择器只许出现一次（重复会让后一处静默覆盖前一处）', () => {
  for (const selector of [
    '.nb-acc-panel',
    ".nb-src-item[aria-expanded='true']",
    ".nb-src-item[aria-pressed='true']",
    ".nb-src-item[aria-expanded='true'] + .nb-acc-panel",
  ]) {
    const hits = [...css.matchAll(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} {`, 'gm'))].length;
    assert.equal(hits, 1, `选择器 ${selector} 出现了 ${String(hits)} 次`);
  }
});

test('★★★ 两个产出方都要维护 aria-expanded（CSS 靠它选状态）', () => {
  /*
   * CSS 现在用 `[aria-expanded='true']` 决定"这一行要不要变成抽屉的上半截"。
   * 所以两个产出方都必须真的维护它 —— 少一处，那一处的行就永远不变成抽屉。
   *
   * 为什么不另加 `data-open`：同一状态两个属性必然分叉（§106.14 的
   * `fieldRow` 两份实现就是这种形状）。`aria-expanded` 本来就存在且同源。
   */
  for (const file of ['client/src/chat/shell.ts', 'client/src/chat/api-page.ts']) {
    const src = stripComments(read(file));
    assert.match(
      src,
      /setAttribute\('aria-expanded',\s*String\(/,
      `${file} 没有维护 aria-expanded ⇒ 那一处的收纳项永远不会显示成抽屉`,
    );
  }
});
