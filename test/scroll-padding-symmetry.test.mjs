/**
 * 滚动容器的内边距要**上下对称**（2026-11-06）。
 *
 * ## 用户报的
 *
 * 截图圈出「卡片」页标题下面那条 —— 标题栏底边和第一张卡片**完全贴住**。
 *
 * ## 真机实测的根因
 *
 * ```text
 *   条目之间            16px
 *   底部内边距          16px
 *   顶栏 → 第一个条目    0px   ← 只有这里是 0
 * ```
 *
 * `.nb-scroll` 只写了 `padding-bottom`，**`padding-top` 完全缺失**。
 *
 * ## 为什么"一直没被发现"
 *
 * 四个页面全是 0，但只有卡片页最刺眼：
 *
 * ```text
 *   卡片页    第一个是实心大卡片(.nb-section)  + 顶栏有 border-bottom
 *             ⇒ 卡片像被标题栏压着
 *   仓库/我的  第一个是小号分组标题
 *             ⇒ 视觉冲突不明显
 * ```
 *
 * 所以这条判据要盯的是**性质**（上下内边距不能差太多），不是某个页面。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const css = read('client/src/chat/chat.css');

/** 取某个选择器的声明块（第一处） */
function blockOf(source, selector) {
  const at = source.indexOf(`${selector} {`);
  assert.ok(at > 0, `找不到 ${selector}`);
  return source.slice(at, source.indexOf('}', at) + 1);
}

test('★★★★ 滚动容器必须有 padding-top（否则第一条目贴住标题栏）', () => {
  const rule = blockOf(css, '.nb-scroll');

  assert.match(
    rule,
    /padding-top:\s*var\(--nb-sp-\d\)/,
    '要有 padding-top（用间距 token，不写裸像素）',
  );
  assert.match(rule, /padding-bottom:/, 'padding-bottom 也要在');
});

test('★★★★ 上下内边距不许差太多（一侧有一侧没有就是"太挤"）', () => {
  /*
   * 原来只有 bottom 有值、top 是隐式 0 —— 这种"漏一半"最容易漏，
   * 因为 CSS 合法、控制台不报错、单看任意一侧都正常。
   *
   * 判据：两边的**基础 token** 必须相同（底部允许再加安全区）。
   */
  const rule = blockOf(css, '.nb-scroll');

  const top = /padding-top:\s*var\((--nb-sp-\d)\)/.exec(rule);
  const bottom = /padding-bottom:\s*calc\(\s*var\((--nb-sp-\d)\)/.exec(rule);
  assert.ok(top !== null, 'padding-top 要用间距 token');
  assert.ok(bottom !== null, 'padding-bottom 要用间距 token');

  assert.equal(
    top[1],
    bottom[1],
    `上下内边距的基础值必须一致（现在是 top=${top[1]} / bottom=${bottom[1]}）`,
  );
});

test('★★★ 内边距不许写裸像素（要与间距体系一致）', () => {
  /*
   * 裸 `16px` 在那个位置看着没问题，但它绕过了 token。
   * 有一天整体调间距（比如暗色/大字模式），这里就会成为唯一不跟随的地方。
   */
  const rule = blockOf(css, '.nb-scroll');
  assert.doesNotMatch(rule, /padding-(top|bottom):\s*\d+px/, '不许写裸像素');
});
