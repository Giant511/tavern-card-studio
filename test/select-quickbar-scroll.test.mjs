/**
 * 全局禁选中 / 快捷输入条 / 流式跟随滚动（2026-11-02 用户三条要求）。
 *
 * 原话：
 * > 除了聊天界面，其他界面原本文本可以输入的地方以外，全部都给我禁掉长按复制
 * > 在聊天界面添加三个快捷输入按键 "、（）、「」，这个要小一点，不遮挡文字；
 * > 再在快捷键那一排加一个重新生成按钮
 * > 语音或文本发出去后，用户的气泡滚动了但是角色回复的气泡却不会自己滚动，
 * > 而是黑屏一瞬（感觉像是黑屏，也可能是刷新）然后需要用户手动滑一下才可以看到角色的回复
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const css = readFileSync(join(ROOT, 'client/src/chat/chat.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const panel = strip(readFileSync(join(ROOT, 'client/src/chat/chat-panel.ts'), 'utf8'));
const rawMain = readFileSync(join(ROOT, 'client/src/mobile/main.ts'), 'utf8');
const main = strip(rawMain);

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m !== null, `找不到规则 ${selector}`);
  return m[1];
}

/* ═══════════════════════════════════════════════════════════
   一、全局禁长按复制（白名单：输入类 + 聊天记录）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 全局默认禁止选中', () => {
  const body = ruleBody('body *');
  assert.match(body, /user-select:[ ]*none/, '要 user-select:none');
  assert.match(body, /-webkit-user-select:[ ]*none/, '要带前缀（老 WebView）');
  assert.match(body, /-webkit-touch-callout:[ ]*none/, '要拦长按 callout');
});

test('★★★ 白名单只有两类：聊天记录 + 输入类', () => {
  /*
   * 用户原话：「除了聊天界面，其他界面原本文本可以输入的地方以外，
   * 全部都给我禁掉长按复制」—— 所以白名单**就是这两类**，
   * 多放一个（比如整页）就等于没做。
   */
  assert.match(ruleBody('.nb-msglist'), /user-select:[ ]*text/, '聊天记录要可选中');
  assert.match(ruleBody('.nb-msglist *'), /user-select:[ ]*text/, '聊天记录里的元素也要可选中');

  /* 输入类用一条组合选择器 */
  const m = /input,\s*textarea,\s*\[contenteditable='true'\],\s*\[contenteditable=''\]\s*\{([^}]*)\}/.exec(css);
  assert.ok(m !== null, '要有 input/textarea/contenteditable 的白名单规则');
  assert.match(m[1], /user-select:[ ]*text/, '输入类要可选中');
});

test('★★★ 光靠 CSS 不够：Android 长按菜单是 contextmenu', () => {
  /*
   * `-webkit-touch-callout` 是 **iOS** 属性，Android 上无效（实测
   * `getPropertyValue` 返回空串）。Android 的长按菜单走 `contextmenu` 事件，
   * 必须显式 `preventDefault()`。
   */
  /*
   * 用**原始文本**判，不用剥注释后的：注释里也出现 `contextmenu` 这个词
   * （解释这段代码的文字），剥注释的正则在本文件上会把整段代码一起吃掉，
   * 于是判据读到"没有"——这本身就说明拿剥注释文本当下标不可靠。
   * 改为直接在原文里找 `doc.addEventListener?.('contextmenu'`。
   */
  assert.match(rawMain, /doc\.addEventListener\?\.\('contextmenu'/, '要拦全局 contextmenu');

  const at = rawMain.indexOf("doc.addEventListener?.('contextmenu'");
  const around = rawMain.slice(at, at + 900);
  assert.match(around, /preventDefault/, '要 preventDefault');
  /* 白名单要与 CSS 一致 */
  assert.match(around, /'TEXTAREA'/, '输入框要放行');
  assert.match(around, /\.nb-msglist/, '聊天记录要放行');
});

/* ═══════════════════════════════════════════════════════════
   二、快捷输入条 + 重新生成
   ═══════════════════════════════════════════════════════════ */

test('★★★ 三个符号 + 重新生成，都在同一排', () => {
  const bar = ruleBody('.nb-quickbar');
  assert.match(bar, /flex:[ ]*0 0 100%/, '快捷条要独占一整行');
  assert.match(bar, /order:[ ]*-1/, '要排在输入框上面');

  /* 三个符号成对插入 */
  for (const [open, close] of [['"', '"'], ['（', '）'], ['「', '」']]) {
    assert.ok(
      panel.includes(`open: '${open}'`) && panel.includes(`close: '${close}'`),
      `缺「${open}${close}」这一对`,
    );
  }
  /* 重新生成按钮存在且接到真方法 */
  assert.match(panel, /data-role',\s*'chat-regenerate'/, '要有重新生成按钮');
  assert.match(panel, /this\.regenerate\(\)/, '要真的调用 regenerate()');
});

test('★★★ 快捷键要"小一点、不遮挡文字"', () => {
  /*
   * 用户明确说「这个要小一点，不遮挡文字」。
   * 高度给 28px：比输入框（51px）矮一截，整条只占 36px 左右，
   * 同时 34px 的最小宽度仍够手指点。
   */
  const key = ruleBody('.nb-quickkey');
  const m = /height:\s*(\d+)px/.exec(key);
  assert.ok(m !== null, '要给明确高度');
  const h = Number(m[1]);
  assert.ok(h <= 32, `快捷键高度 ${String(h)}px 太大，用户要求"小一点"`);
  assert.ok(h >= 24, `快捷键高度 ${String(h)}px 太小，手指点不准`);
  assert.match(key, /min-width:[ ]*\d+px/, '要保证最小点击宽度');
});

test('★★ 语音态隐藏快捷条（那时输入框不在了）', () => {
  assert.match(
    css,
    /\.nb-composer\[data-voice='true'\]\s*\.nb-quickbar\s*\{[^}]*display:\s*none/,
    '语音态要隐藏快捷条，否则白占高度',
  );
});

test('★★ 成对插入要把光标放中间（没选中时）', () => {
  assert.match(panel, /setSelectionRange/, '要设光标位置');
  /*
   * 没选中文字时，光标应落在两个符号**中间**（`start + open.length`），
   * 否则用户点完还得自己往左挪一格。
   */
  assert.match(panel, /selected === '' \?[^;]*open\.length/, '没选中时光标要落中间');
});

/* ═══════════════════════════════════════════════════════════
   三、流式跟随滚动 + 不重渲染（黑屏一瞬）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 流式 patch 必须跟随滚动（否则回复长出去看不见）', () => {
  /*
   * 用户原话：「角色回复的气泡却不会自己滚动…需要用户手动滑一下」。
   *
   * 根因：`patchStreamingMessage` 只改文本、**从不滚动**，
   * 于是气泡一个字一个字变长而视口纹丝不动。
   */
  const at = panel.indexOf('private patchStreamingMessage');
  assert.ok(at > 0, '找不到 patchStreamingMessage');
  const body = panel.slice(at, at + 3000);
  assert.match(body, /stickToBottomIfNeeded\(\)/, 'patch 末尾要跟随滚动');

  /* 判据要用 shouldStick：用户翻上去看历史时不能被拽回来 */
  const stickAt = panel.indexOf('private stickToBottomIfNeeded');
  assert.ok(stickAt > 0, '要抽出 stickToBottomIfNeeded');
  const stickBody = panel.slice(stickAt, stickAt + 700);
  assert.match(stickBody, /shouldStick\(/, '要用 shouldStick 判"用户是否还贴着底"');
  assert.match(stickBody, /scrollTop = /, '要真的改 scrollTop');
});

test('★★★ 收尾不许整表重渲染（黑屏一瞬的来源）', () => {
  /*
   * 用户原话：「黑屏一瞬（感觉像是黑屏，也可能是刷新）」。
   *
   * 根因：流式结束后调 `this.render()`，而 `render()` 第一行是
   * `listEl.replaceChildren()` —— 整屏清空再重插，那一帧就是一片空白，
   * 同时滚动位置在重建中丢失。
   */
  /* 收尾分支里应改为 patch，而不是 render */
  /*
   * ★ 锚点改过一次（2026-11-05）。
   *
   * 原来锚 `const final: StChatMessage = ` —— 那行在"重新生成改成 appendSwipe"
   * 时被替换掉了（成功分支现在写 `const settled = ...`），于是这条判据
   * 报的是"找不到收尾分支"，**看起来像缺陷回来了，其实是锚点过期**。
   *
   * 改成锚 `finalizeOutput` 之后的成功分支起点：语义没变（"收尾不许整表重渲染"），
   * 但不再依赖某个具体变量名。
   */
  const finalizeAt = panel.indexOf('const output = finalizeOutput(this.stream);');
  assert.ok(finalizeAt > 0, '找不到收尾（finalizeOutput）');
  const settleAt = panel.indexOf('const settled = this.messages.slice();', finalizeAt);
  assert.ok(settleAt > 0, '找不到收尾成功分支');
  const tail = panel.slice(settleAt, settleAt + 1800);
  assert.match(tail, /patchStreamingMessage\(/, '收尾要改成增量 patch');
  assert.equal(
    /^\s*this\.render\(\);/m.test(tail.split('this.callbacks.onChatChanged')[0] ?? ''),
    false,
    '收尾分支里不许再整表 render()（黑屏就是它）',
  );
});

test('★★ 呼吸点收尾要能移除（不能只加不删）', () => {
  const at = panel.indexOf('private patchStreamingMessage');
  const body = panel.slice(at, at + 3000);
  assert.match(body, /!showsCaret\(state\) && hasDot/, '状态结束时要移除呼吸点');
});
