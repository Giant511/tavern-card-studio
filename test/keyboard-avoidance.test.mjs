/**
 * 键盘弹起时的聊天区避让（2026-11-02 用户报「聊天记录被遮住」）。
 *
 * ## 现象（三个录屏同一个问题）
 *
 * ```text
 *   点输入框 → 键盘弹出 → 输入区跑到键盘上方 ✅
 *   但消息区被压得太矮，最后一条消息只露出半截 ❌
 * ```
 *
 * 用户的话：「文本框出来了，但是聊天记录会被遮住，应该和文本框一样整体往上移」。
 *
 * ## 实测出来的两个原因
 *
 * ### ① 多避让了 tabbar 的 56px
 *
 * `.nb-app` 是 `header + .nb-chat + tabbar` 三行，`.nb-chat` 的底部
 * **本来就在 tabbar 之上**。键盘弹起时 tabbar 被盖住、不再需要占位，
 * 可它那 56px 还占在 `.nb-chat` 下面 —— 于是 `padding-bottom: 键盘高`
 * 就多推了 56px，中间露出一条空白，消息区白白少掉 56px。
 *
 * 真机实测（键盘 370px）：
 * ```text
 *   padding 370px → 输入区底部 424，键盘上沿 481  ⇒ 中间 57px 空白
 *   padding 314px → 输入区底部 481 = 键盘上沿    ✅
 * ```
 *
 * ### ② 聚焦后没有滚到底
 *
 * 可用高度变小、列表变矮，但**滚动位置没变** ⇒ 原先可见的最后一条
 * 被新边界裁掉下半截。列表底部本来留了 56px 空白，滚到底就完整可见。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const css = readFileSync(join(ROOT, 'client/src/chat/chat.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const panel = readFileSync(join(ROOT, 'client/src/chat/chat-panel.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m !== null, `找不到规则 ${selector}`);
  return m[1];
}

/* ═══════════════════════════════════════════════════════════
   一、避让值必须减掉 tabbar 高度
   ═══════════════════════════════════════════════════════════ */

test('★★★ 避让 padding 必须减去 tabbar 高度（否则多推 56px）', () => {
  /*
   * ★ 2026-11-04 换成 `.nb-app`。
   *
   * 原来判 `.nb-chat`。但只修聊天页时仓库页 / 我的页全被键盘盖住
   * （用户报的就是这个），所以避让上移到最外层。
   *
   * 而**不能**放在 `.nb-page`：它是 `flex: 1` 子项，高度由父容器分配，
   * padding 只把内容压扁（真机实测 `.nb-scroll` 剩 43px、页面底边 778 没动）。
   * 唯一能真正缩矮的是 `position: fixed; inset: 0` 的 `.nb-app`。
   */
  const body = ruleBody('.nb-app');
  assert.match(body, /padding-bottom:/, '.nb-app 要有避让 padding');

  /*
   * 判据钉**两个要素同时出现**：
   *   · `var(--nb-tabbar-h)` 被减掉
   *   · 外面套 `max(0px, …)`（键盘没弹时不能算出负数）
   *
   * 只钉"有 padding-bottom"不够 —— 那正是上一版（错的）的写法。
   */
  assert.match(
    body,
    /var\(--nb-tabbar-h\)/,
    '必须减去 tabbar 高度：.nb-chat 底部本来就在 tabbar 之上，不减就多推 56px',
  );
  assert.match(body, /max\(\s*0px/, '外层要 max(0px, …)：键盘没弹时不能得到负 padding');
});

test('★★★ 键盘高度取两条信号的最大值（两个都可能在各自机型上失效）', () => {
  const body = ruleBody('.nb-app');
  /*
   * | 变量 | 谁写 | 什么时候有效 |
   * |---|---|---|
   * | `--nb-kb-inset` | JS 读 visualViewport | 键盘**参与视口**的 WebView |
   * | `--nb-kb-inset-native` | Android 读 WindowInsets | 键盘是 **overlay** 的 WebView |
   *
   * 本机型实测只有 native 那条有值（370px），JS 那条恒为 0。
   * 取 max 而不是二选一：任一失效另一个能补，两条都失效落到 0（等于没修，不会更差）。
   */
  assert.match(body, /var\(--nb-kb-inset, 0px\)/, '要读 JS 那条');
  assert.match(body, /var\(--nb-kb-inset-native, 0px\)/, '要读 Android 那条');
  const maxCount = (body.match(/max\(/g) ?? []).length;
  assert.ok(maxCount >= 2, `两条信号要取 max，且外层还有一层 max(0px,…)，实际 ${String(maxCount)} 处`);
});

/* ═══════════════════════════════════════════════════════════
   二、聚焦后要滚到底
   ═══════════════════════════════════════════════════════════ */

test('★★★ 输入框 focus 时要把消息列表滚到底', () => {
  /*
   * 只改 padding 不够：列表高度变了但滚动位置没变，
   * 最后一条消息仍然会被新边界裁掉下半截。
   */
  assert.match(
    panel,
    /addEventListener\?\.\('focus'/,
    '输入框要监听 focus（键盘弹起的信号）',
  );

  /* 滚动必须发生在 focus 回调里，且写的是 scrollTop */
  const at = panel.indexOf("addEventListener?.('focus'");
  assert.ok(at > 0, "找不到 focus 监听");
  const around = panel.slice(Math.max(0, at - 1600), at + 400);
  assert.match(around, /scrollTop\s*=/, '要真的改 scrollTop（而不是只调 syncSendButton）');
});

test('★★ 滚动要延迟，不能立即执行', () => {
  /*
   * `--nb-kb-inset-native` 是 Android 在键盘**动画过程中**写入的。
   * 立即滚会按"键盘还没弹"的旧高度算，随后列表又被压缩、又裁掉半截。
   */
  const at = panel.indexOf("addEventListener?.('focus'");
  const around = panel.slice(Math.max(0, at - 1600), at + 200);
  assert.match(around, /setTimeout\(/, '要延迟滚动，等键盘动画与布局稳定');
  /* 回调体里有几行，窗口放到 500 字符 */
  const m = /setTimeout\([\s\S]{0,500}?,\s*(\d+)\s*\)/.exec(around);
  assert.ok(m !== null, '找不到 setTimeout 的延时');
  const delay = Number(m[1]);
  assert.ok(delay >= 200, `延时 ${String(delay)}ms 太短，键盘动画（250–300ms）还没结束`);
});
