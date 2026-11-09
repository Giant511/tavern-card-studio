/**
 * 抽屉视觉判据（2026-11-04，用户否掉左侧竖线方案后重做）。
 *
 * ## 用户原话
 *
 * > 这个太丑了，要表示层级就全部框选，别整成左边只有一个竖条，
 * > 或者你干脆全部都不要框起来，有别的办法更美观你也可以按那个来，
 * > **你全部排查一遍，后面如果要做抽屉式就按本轮的方法来**
 *
 * ## 为什么竖线被否
 *
 * 一条 2px 竖线**只圈住抽屉那一段的高度**，它说的是"这一坨是独立的"，
 * 而要说的恰恰相反："这一坨属于上面那一行"。方向反了。
 * 而且竖线把内容整体右移，左右内边距不对称，看起来像排版错。
 *
 * ## 现在：连体卡片
 *
 * ```text
 *   ┌─────────────────┐  行（上圆角）
 *   ├─────────────────┤  共享那一条边
 *   │                 │  抽屉（下圆角）
 *   └─────────────────┘
 * ```
 *
 * 这条判据是给**以后新做的抽屉**用的 —— 照抄 `.nb-drawer` + `data-open`，
 * 别自己再发明一种层级标记。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** 剥注释（解释文字里会引用被禁的写法） */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*$/gm, '')
    .replace(/\s\/\/[^\n]*$/gm, '');
}

/** 取某个选择器的规则体（从 `{` 到第一个 `}`） */
function ruleBody(css, selector) {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at > 0, `找不到规则 ${selector}`);
  return css.slice(at, css.indexOf('}', at));
}

const CSS = 'client/src/chat/chat.css';

test('★★★ 抽屉本体必须框起来（上边不画、其余三边画）', () => {
  const css = stripComments(read(CSS));
  const body = ruleBody(css, '\n.nb-drawer');

  assert.match(body, /border:[ 	]*1px solid/, '要一圈边框');
  assert.match(body, /border-top:[ 	]*0/, '上边不画 —— 那条由行的下边框画，两边都画会变成 2px');
  assert.match(body, /border-radius:[ 	]*0 0/, '下圆角要与行拼上');
  assert.ok(body.includes('var(--nb-surface-1)'), '底色要与行一致，否则「一张卡」的错觉断掉');
});

test('★★★ 展开的那一行要把下圆角与下边距归零', () => {
  const css = stripComments(read(CSS));
  const body = ruleBody(css, ".nb-listitem[data-open='true']");

  assert.match(body, /margin-bottom:[ 	]*0/, '不归零的话中间会裂开一条缝');
  assert.match(body, /border-bottom-left-radius:[ 	]*0/, '左下圆角要归零');
  assert.match(body, /border-bottom-right-radius:[ 	]*0/, '右下圆角要归零');
});

test('★★★ 表示层级不许用 border-left（这是用户明确否掉的写法）', () => {
  /*
   * 只查**规则体**里的 border-left，跳过注释。
   *
   * 三类合法用途不算：
   *   · `.nb-bubble blockquote`  —— Markdown 引用，引用块本来就该有竖线
   *   · `.nb-thinking`           —— 思维链旁注
   *   · `.nb-notify[danger/warn]` —— 通知的语义色
   *
   * 它们的共同点是**语义**（引用 / 旁注 / 危险），不是"从属关系"。
   */
  const css = stripComments(read(CSS));
  const allowed = ['.nb-bubble blockquote', '.nb-thinking', ".nb-notify[data-kind='danger']", ".nb-notify[data-kind='warn']"];

  for (const selector of ['.nb-drawer', '.nb-persona-drawer', '.nb-wb-editor']) {
    const at = css.indexOf(`${selector} {`);
    if (at < 0) continue;
    const body = css.slice(at, css.indexOf('}', at));
    assert.doesNotMatch(body, /border-left/, `${selector} 不许用 border-left 表达层级`);
  }

  /* 反向确认：全文件里剩下的 border-left 只属于那几个合法用途 */
  const all = [...css.matchAll(/([^{}]+)\{[^}]*border-left/g)].map((m) => m[1].trim().split('\n').pop() ?? '');
  for (const selector of all) {
    const ok = allowed.some((one) => selector.includes(one.trim()));
    assert.ok(ok, `这个选择器用 border-left 做装饰了：${selector}（层级请用 .nb-drawer 连体卡片）`);
  }
});

test('★★★ 每个抽屉都用了通用类（不许各写一套）', () => {
  for (const [file, role] of [
    ['client/src/chat/persona-page.ts', 'persona-drawer'],
    ['client/src/chat/worldbook-page.ts', 'worldbook-entry-editor'],
  ]) {
    const src = stripComments(read(file));
    assert.match(
      src,
      /'nb-drawer nb-[^']*'/,
      `${file} 的抽屉要带 nb-drawer 通用类（否则每个抽屉各长一个样）`,
    );
    void role;
  }
});

test('★★★ 展开的行必须带 data-open（CSS 靠它收圆角）', () => {
  for (const [file, marker] of [
    ['client/src/chat/persona-page.ts', 'openId'],
    ['client/src/chat/worldbook-page.ts', 'editingUid'],
  ]) {
    const src = stripComments(read(file));
    assert.match(
      src,
      /setAttribute\('data-open', 'true'\)/,
      `${file} 展开行没设 data-open ⇒ 抽屉接不上，中间会裂一条缝`,
    );
    void marker;
  }
});

test('★★★ 行与抽屉必须用同一个边框色（否则框只框了半截）', () => {
  /*
   * 这条是第二次真机验收补的。
   *
   * 第一次修只给**行**提亮了边框，抽屉还是默认的淡边框。截图里看起来
   * 是「上半截有亮框，下面一坨没框」—— 而用户要的是"全部框选"。
   *
   * 修法不是"两处各写一遍色值"（改一处忘另一处，迟早又半截），
   * 而是两条规则都引用**同一个 token**，并且抽屉那条挂在上面的行后面
   * （相邻兄弟选择器 `+`），保证"行亮"必然推出"抽屉也亮"。
   */
  const tokens = stripComments(read('client/src/chat/nebula-tokens.css'));
  /*
   * 只要求"有个 token"，不要求它是 color-mix —— 本机 Chrome 87 不支持
   * color-mix，写它会让 border-color 整条失效并回落成文字色（见
   * test/css-engine.test.mjs）。这里改成认 rgba。
   */
  assert.match(
    tokens,
    /--nb-card-open-border:[ \t]*rgba\(/,
    '展开卡的边框色要有一个单独 token（rgba 字面量 —— 不能用 color-mix），行与抽屉共用一个来源',
  );

  const css = stripComments(read(CSS));

  /* 行：四边都用这个 token（底边就是与抽屉共享的那条） */
  const rowRules = [...css.matchAll(/\.nb-listitem\[data-open='true'\]\s*\{[^}]*\}/g)].map((m) => m[0]);
  /*
   * ★ 必须**只有一个**规则块。
   *
   * 我一开始把几何与颜色拆成两块（同一个选择器出现两次），走查判据
   * `test/nebula-walkthrough.test.mjs` 的「同一选择器只许出现一次」当场报红 ——
   * 那条判据是对的：写两处时后一处静默覆盖前一处。所以这里反过来要求
   * 唯一，并在这个块里同时验几何与颜色。
   */
  assert.equal(rowRules.length, 1, `展开行应只有一个规则块，实际 ${String(rowRules.length)} 个`);
  const rowBody = rowRules[0];
  assert.match(rowBody, /margin-bottom:[ \t]*0/, '不归零的话中间会裂开一条缝');
  assert.match(rowBody, /border-bottom-left-radius:[ \t]*0/, '左下圆角要归零');
  assert.match(rowBody, /border-bottom-right-radius:[ \t]*0/, '右下圆角要归零');
  assert.match(rowBody, /border-color:[ \t]*var\(--nb-card-open-border\)/, '展开行没设置 border-color ⇒ 还是默认淡边框');
  assert.match(rowBody, /border-bottom-color:[ \t]*var\(--nb-card-open-border\)/);

  /* 抽屉：紧跟在上面的行后面，用同一个 token，且上边仍不画 */
  const drawerBody = ruleBody(css, ".nb-listitem[data-open='true'] + .nb-drawer");
  assert.match(drawerBody, /border-color:[ \t]*var\(--nb-card-open-border\)/);
  assert.match(drawerBody, /border-top:[ \t]*0/, '抽屉顶边由行的底边框充当，不能再画一道');

  /*
   * ★★★ 顺序：`border-color` 必须写在 `border-top` **之后**。
   *
   * `border-top: 0` 是简写，展开含 `border-top-color: currentColor`。
   * 写在它前面会被重置成文字色（近白）。真机实测过：行的四边是紫色、
   * 抽屉的上边是 `rgb(244, 242, 251)` —— 宽度 0 所以肉眼看不见，
   * 但这是个随时会冒出来的白边。
   */
  const atColor = drawerBody.indexOf('border-color');
  const atTop = drawerBody.indexOf('border-top');
  assert.ok(
    atTop >= 0 && atColor > atTop,
    'border-color 要写在 border-top 之后（border-top 是简写，会把 border-top-color 重置成 currentColor）',
  );
});

test('★★ 抽屉里的第一个分组标题不画顶线（框里不要再套一条线）', () => {
  const css = stripComments(read(CSS));
  const body = ruleBody(css, '.nb-drawer > .nb-settings-group:first-child');
  assert.match(body, /border-top:[ 	]*none/, '框里再加一条横线会显得很碎');
  assert.match(body, /margin-top:[ 	]*0/, '抽屉已有留白，不需要额外顶距');
});
