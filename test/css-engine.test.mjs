/**
 * CSS 引擎能力判据（2026-11-04）。
 *
 * ## 为什么需要这一条
 *
 * 抽屉的"整卡一圈亮边框"改完之后，真机上量出来是这样：
 *
 * ```text
 *   row.borderTopColor === 'rgb(244, 242, 251)'
 *   box.borderTopColor === 'rgb(244, 242, 251)'
 * ```
 *
 * 两边"相同"，而且都设了 `border-color: var(--nb-card-open-border)`。
 * 只看"是否相等"会判通过 —— 但 `rgb(244, 242, 251)` 是
 * `--nb-text-1`（近白），**不是**紫色。
 *
 * 真因：本机 WebView 是 **Chrome 87**（Android 11 的系统 WebView），
 * `CSS.supports('color', 'color-mix(...)')` 返回 `false`。而浏览器遇到
 * 不认识的函数不是"跳过这个函数"，而是**整条声明在计算值阶段失效**，
 * `border-color` 于是回落到 `currentColor` —— 也就是文字色。
 *
 * 同样的失效还发生在三处 `box-shadow`（语音大按钮的光晕）和一处
 * `background`（「正在使用」徽标底）上。它们**从写下的那天起就没生效过**，
 * 因为视觉上"看起来也还行"，一直没人报。
 *
 * ## 这条判据拦住什么
 *
 * 移动端 CSS（`client/src/chat/*.css`，跑在 WebView 里）里**不许**出现
 * 下面这些语法。桌面端 `client/src/styles.css` 跑在 WebView2（Chromium
 * 版本跟随 Edge，一直很新）里，不在此列。
 *
 * | 语法 | 最低 Chrome | 本机 87 行不行 |
 * |---|---|---|
 * | `color-mix()` | 111 | ✗ |
 * | `:is()` / `:where()` 选择器 | 88 | ✗ |
 * | `:has()` 选择器 | 105 | ✗ |
 * | `aspect-ratio` | 88 | ✗ |
 *
 * 要加新的写法，先在真机上 `CSS.supports(...)` 验一次，再把结论写回这张表。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/** 移动端 CSS（WebView 里跑的） */
const MOBILE_CSS = ['client/src/chat/chat.css', 'client/src/chat/nebula-tokens.css'];

/** 剥掉注释：解释规则本身会用禁的写法做例子 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * 禁用清单。`pattern` 只扫**代码**（注释已剥掉）。
 *
 * `minChrome` 只用来说明；判据不解析版本号 —— 目的只是"别再写进来"。
 */
const BANNED = [
  { pattern: /color-mix\(/g, what: 'color-mix()', minChrome: 111, alt: '写成 rgba() 字面量（值从主色 token 取）' },
  { pattern: /:is\(/g, what: ':is()', minChrome: 88, alt: '展开成逗号分隔的选择器列表' },
  { pattern: /:where\(/g, what: ':where()', minChrome: 88, alt: '直接用普通选择器（本项目的样式没有需要被覆盖的场景）' },
  { pattern: /:has\(/g, what: ':has()', minChrome: 105, alt: '在 TS 里加一个 class / data 属性来表达' },
  { pattern: /aspect-ratio\s*:/g, what: 'aspect-ratio', minChrome: 88, alt: '用 padding-top 百分比，或直接给宽高' },
];

for (const file of MOBILE_CSS) {
  for (const rule of BANNED) {
    test(`★★★ ${file} 不许用 ${rule.what}（Chrome 87 会整条失效）`, () => {
      const css = stripComments(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
      const hits = [...css.matchAll(rule.pattern)];
      assert.equal(
        hits.length,
        0,
        `本机 WebView 是 Chrome 87，不支持 ${rule.what}（需 Chrome ${String(rule.minChrome)}+）。` +
          `属性值里出现它会让**整条声明**失效并回落到 currentColor / 不生效，` +
          `而且没有任何报错。改用：${rule.alt}`,
      );
    });
  }
}

test('★★★ 半透明色必须写成 rgba 字面量（说明见 nebula-tokens.css）', () => {
  /*
   * 这条是上一条的**正向**补充：不只是"别用 color-mix"，还要确认
   * 关键的那几个半透明色确实写成了 rgba —— 否则有人把它删掉之后
   * 判据全绿，而光晕又没了。
   */
  const css = stripComments(readFileSync(new URL('../client/src/chat/chat.css', import.meta.url), 'utf8'));
  const rgbas = [...css.matchAll(/rgba\(139, 92, 246, [\d.]+\)/g)];
  assert.ok(rgbas.length >= 3, `主色的半透明变体至少要有 3 处（光晕两处 + 徽标底一处），实际 ${String(rgbas.length)}`);

  const tokens = stripComments(
    readFileSync(new URL('../client/src/chat/nebula-tokens.css', import.meta.url), 'utf8'),
  );
  assert.match(
    tokens,
    /--nb-card-open-border:[ \t]*rgba\(/,
    '展开卡的边框色也必须是 rgba 字面量，不能用 color-mix',
  );
});
