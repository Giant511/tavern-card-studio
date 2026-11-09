/**
 * 点气泡编辑 / 一键复制 / 删除（2026-11-02 用户要求）。
 *
 * 原话：
 * > 聊天界面可以点击任意气泡修改文本或者一键复制或者删除消息，
 * > 并且修改后可以以上下文的形式在下一条回复中（即聊天记录会作为上下文的一部分）
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const panel = strip(readFileSync(join(ROOT, 'client/src/chat/chat-panel.ts'), 'utf8'));
const view = strip(readFileSync(join(ROOT, 'client/src/chat/chat-view.ts'), 'utf8'));
const menu = strip(readFileSync(join(ROOT, 'client/src/chat/bubble-menu.ts'), 'utf8'));
const css = readFileSync(join(ROOT, 'client/src/chat/chat.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/* ═══════════════════════════════════════════════════════════
   一、定位：下标必须写进 DOM
   ═══════════════════════════════════════════════════════════ */

test('★★★ 每条消息要把下标写进 DOM（不能用 indexOf 找）', () => {
  /*
   * `messages` 里可能有内容完全相同的两条（重复说一句话很常见）。
   * 点击时用 `indexOf` 会永远命中第一条 ⇒ 用户点了第二条、改的却是第一条。
   */
  assert.match(view, /setAttribute\('data-msg-index'/, '渲染时要写 data-msg-index');
  assert.match(view, /index:\s*index|index\b/, 'renderMessageList 要把 index 传下去');
  assert.match(panel, /closest\('\[data-msg-index\]'\)/, '点击时要从 DOM 属性往上找');
  /* 不许用 indexOf 按内容找 */
  assert.equal(
    /indexOf\(.*message|indexOf\(.*\.mes/.test(panel),
    false,
    '不许用 indexOf 按内容反查下标（内容相同的两条会错）',
  );
});

test('★★ 点到的不是消息时返回 null（点空白不弹菜单）', () => {
  assert.match(menu === '' ? panel : panel, /bubbleIndexAt/);
  const at = panel.indexOf('function bubbleIndexAt');
  assert.ok(at > 0, '要有 bubbleIndexAt');
  const body = panel.slice(at, at + 700);
  assert.match(body, /return null/, '找不到消息要返回 null');
});

/* ═══════════════════════════════════════════════════════════
   二、"点"要能和"滑"区分开
   ═══════════════════════════════════════════════════════════ */

test('★★★ 区分点按与滑动（否则每次滑切候选都弹菜单）', () => {
  /*
   * 这个容器同时承载左右滑切候选。若直接用 `click`，
   * 一次滑动在松手时也会派发 click ⇒ 每次滑动都弹菜单。
   */
  const at = panel.indexOf('list.addEventListener(\'touchend\'');
  assert.ok(at > 0, '要有 touchend 判定');
  const body = panel.slice(at, at + 1200);
  assert.match(body, /moved\s*>\s*\d+/, '要判位移阈值');
  assert.match(body, /Date\.now\(\)\s*-\s*start\.t/, '要判时长阈值');
  /* 位移阈值不能设成 0（手指点一下也有抖动） */
  const m = /moved\s*>\s*(\d+)/.exec(body);
  assert.ok(m !== null);
  assert.ok(Number(m[1]) >= 4, `位移阈值 ${m?.[1]}px 太小，正常点按会被当成滑动`);
});

/* ═══════════════════════════════════════════════════════════
   三、编辑后必须进上下文
   ═══════════════════════════════════════════════════════════ */

test('★★★ 编辑要写回 messages 并落盘（这才叫"进上下文"）', () => {
  /*
   * 用户明确要求「修改后可以以上下文的形式在下一条回复中」。
   *
   * 下一轮 `buildPrompt` 读的就是 `this.messages`，所以关键是：
   *   ① 改 `this.messages[index]`
   *   ② 调 `onChatChanged` 落盘（否则下次打开还是旧内容）
   * 不需要额外"重发"。
   */
  const at = panel.indexOf('onSaveEdit:');
  assert.ok(at > 0, '要有 onSaveEdit');
  const body = panel.slice(at, at + 700);
  assert.match(body, /this\.messages\s*=\s*updated/, '要真的更新 messages');
  assert.match(body, /mes:\s*next/, '要把新文本写进 mes');
  assert.match(body, /onChatChanged/, '要落盘（否则重开还是旧内容）');
});

test('★★★ 编辑保存要走增量更新，不许整屏重渲染', () => {
  /* 与流式收尾同一个理由：`render()` 会 replaceChildren 整屏闪一下 */
  const at = panel.indexOf('private patchMessageText');
  assert.ok(at > 0, '要有 patchMessageText');
  const body = panel.slice(at, at + 900);
  assert.match(body, /innerHTML\s*=/, '要替换气泡内容');
  assert.match(body, /renderMessageHtml/, '要走统一的转义渲染（不许直接塞原文）');
});

test('★★ 编辑空文本不清空消息', () => {
  const at = menu.indexOf("id: 'edit'");
  assert.ok(at > 0);
  /* 保存按钮里要拦空串 */
  /*
   * 窗口给 1400 字符：从 `bubble-edit-save` 到空串判断之间还有一段
   * 多行注释（解释"为什么空文本不保存"），800 字符不够。
   */
  const saveAt = menu.indexOf("bubble-edit-save");
  assert.ok(saveAt > 0, '找不到保存按钮');
  const body = menu.slice(saveAt, saveAt + 1400);

  /*
   * 实际写法是先 `const next = String(...).trim()` 再判 `next === ''`。
   * 所以判"有没有 trim"和"有没有空串判断"两件事，**不要求它们在同一行** ——
   * 第一版写死 `/trim\(\)\s*===\s*''/` 就因为这个分两步而误判。
   */
  assert.match(body, /\.trim\(\)/, '要先 trim（否则全是空格的也算有内容）');
  assert.match(body, /===\s*''/, '要判空串');
  assert.match(body, /删除/, '要引导用户改用删除');
});

/* ═══════════════════════════════════════════════════════════
   四、复制：三层降级
   ═══════════════════════════════════════════════════════════ */

test('★★★ 复制要三层降级（现代 API → execCommand → 失败提示）', () => {
  /*
   * `navigator.clipboard` 要求安全上下文 + 用户手势，Android WebView 里
   * 不一定可用；`execCommand('copy')` 是 Chrome 87 仍然支持的兜底。
   * 只写一种的话，在另一种环境上就是"点了没反应"。
   */
  const at = panel.indexOf('private async writeClipboard');
  assert.ok(at > 0, '要有 writeClipboard');
  const body = panel.slice(at, at + 1600);
  assert.match(body, /clipboard\?\.writeText/, '第一层：navigator.clipboard');
  assert.match(body, /execCommand\?\.\('copy'\)/, '第二层：execCommand 兜底');
  assert.match(body, /return false/, '第三层：失败要能返回 false（好让菜单提示）');
});

test('★★ 复制失败要告诉用户，不能静默', () => {
  const at = menu.indexOf("id: 'copy'");
  const body = menu.slice(at, at + 800);
  assert.match(body, /复制失败/, '失败要有提示文案');
  assert.match(body, /长按/, '要给出可行的替代办法');
});

/* ═══════════════════════════════════════════════════════════
   五、删除
   ═══════════════════════════════════════════════════════════ */

test('★★★ 删除要真的从 messages 移除并落盘', () => {
  const at = panel.indexOf('onDelete:');
  assert.ok(at > 0, '要有 onDelete');
  const body = panel.slice(at, at + 600);
  assert.match(body, /splice\(index,\s*1\)/, '要 splice 掉那一条');
  assert.match(body, /onChatChanged/, '要落盘');
});

/* ═══════════════════════════════════════════════════════════
   六、菜单生命周期（别留僵尸面板）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 面板 dispose 时要关掉菜单（否则切 Tab 后浮空）', () => {
  const at = panel.indexOf('  dispose(): void {');
  assert.ok(at > 0, '要有 dispose');
  const body = panel.slice(at, at + 500);
  assert.match(body, /bubbleMenu\?\.close\(\)/, 'dispose 要关菜单');
});

test('★★ 同一时刻只允许一个菜单', () => {
  const at = panel.indexOf('private openBubbleActions');
  const body = panel.slice(at, at + 400);
  assert.match(body, /this\.bubbleMenu\?\.close\(\)/, '开新菜单前先关旧的');
});

test('★★★ 语音消息也允许编辑（用户要求"任意气泡"）', () => {
  /*
   * 第一版我排除了语音消息，理由是"改文本会与音频条的时长对不上"。
   *
   * 但用户原话是「点击**任意**气泡修改文本」—— 而语音消息的文字
   * 正是**识别结果**，识别错了最需要能改。音频条记的是"当时说了几秒"，
   * 与后来订正的文字并不冲突。
   *
   * 判据反过来说明这一点，防止有人（包括我）再"好心"加回去。
   */
  const at = panel.indexOf('private openBubbleActions');
  const body = panel.slice(at, at + 900);
  assert.equal(
    /editable:[^,\n]*isVoiceMsg/.test(body),
    false,
    '可编辑性不许再用 isVoiceMsg 排除 —— 用户要的是"任意气泡"',
  );
  assert.match(body, /editable:[^,\n]*trim\(\)\s*!==\s*''/, '只看有没有正文');
});

test('★★ 菜单不许用 alert / confirm / prompt（阻塞主线程）', () => {
  /* 流式期间弹这些会把打字机卡住（memory 记过） */
  assert.equal(/window\.(alert|confirm|prompt)\(/.test(menu), false, '不许用阻塞式对话框');
  assert.equal(/\balert\(/.test(menu), false, '不许用 alert');
});

/* ═══════════════════════════════════════════════════════════
   七、样式
   ═══════════════════════════════════════════════════════════ */

test('★★★ 菜单层级要高于通知（菜单是模态，通知不是）', () => {
  const notifyZ = /\.nb-notify\s*\{[^}]*z-index:\s*(\d+)/.exec(css)?.[1];
  const sheetZ = /\.nb-sheet-mask\s*\{[^}]*z-index:\s*(\d+)/.exec(css)?.[1];
  assert.ok(notifyZ !== undefined && sheetZ !== undefined, '两处都要有 z-index');
  assert.ok(
    Number(sheetZ) > Number(notifyZ),
    `菜单(${String(sheetZ)}) 层级要高于通知(${String(notifyZ)})`,
  );
});

test('★★ 删除按钮用红色，但要有 danger 标记（便于判据与视觉区分）', () => {
  assert.match(menu, /danger:\s*true/, '删除动作要标 danger');
  assert.match(css, /\.nb-sheet-action\[data-danger='true'\]/, 'danger 态要有样式');
});

/* ═══════════════════════════════════════════════════════════
   八、★★★ firstTouch 在 touchend 上必须能取到坐标
   ═══════════════════════════════════════════════════════════ */

test('★★★ firstTouch 不能用 `touches ?? changedTouches`（touchend 时 touches 是空数组）', () => {
  /*
   * ## 这个 bug 的可怕之处
   *
   * `touchend` 时 `touches` 是**空数组**（抬起的那根手指已不在其中），
   * 而空数组不是 `null`/`undefined` —— `??` **不会**降级，
   * 于是取到 `list[0] === undefined`、返回 `null`。
   *
   * 后果：所有依赖 `touchend` 坐标的逻辑开头就 `return` 了。
   * 「点气泡弹菜单」整个不生效，而 `touchstart` 一切正常 ——
   * **只看"事件有没有派发"完全看不出问题**（实测两个事件都在派）。
   *
   * 我在真机上找了很久：日志显示 touchend 的 target 带 hasIdx=true、
   * idx=32，可菜单就是不出现。差别只在这一个函数的取值上。
   */
  const at = panel.indexOf('function firstTouch');
  assert.ok(at > 0, '要有 firstTouch');
  const body = panel.slice(at, at + 1500);

  assert.equal(
    /touches\s*\?\?\s*maybe\.changedTouches/.test(body),
    false,
    '不许用 `touches ?? changedTouches` —— touchend 时 touches 是空数组，?? 不降级',
  );
  /* 要按长度判断 */
  assert.match(body, /\.length\s*>\s*0/, '要按长度选，不能只判 null/undefined');
  assert.match(body, /changedTouches/, '要有 changedTouches 兜底');
});

/* ═══════════════════════════════════════════════════════════
   九、★★★ 补丁定位必须按属性，不能按 children 下标
   ═══════════════════════════════════════════════════════════ */

test('★★★ 增量更新要按 data-msg-index 找，不能用 children[index]', () => {
  /*
   * 列表里除了消息还有别的东西（草稿卡、空状态、日期分隔）。
   * `list.children[index]` 会整体错位 —— 实测症状是
   * 「编辑保存后气泡文字没变」（补丁打到了另一条上）。
   *
   * 属性是渲染时按 `messages` 下标写的，那才是唯一可靠的定位依据。
   */
  for (const fn of ['patchMessageText', 'patchStreamingMessage']) {
    const at = panel.indexOf('private ' + fn);
    assert.ok(at > 0, '找不到 ' + fn);
    const body = panel.slice(at, at + 1600);
    assert.match(
      body,
      /getAttribute\('data-msg-index'\)/,
      fn + ' 要按属性找目标',
    );
    assert.equal(
      /children\[index\]/.test(body),
      false,
      fn + ' 不许用 children[index]（会被非消息节点挤错位）',
    );
  }
});

/* ═══════════════════════════════════════════════════════════
   十、★★★ 补丁必须能找到列表容器（listEl 自己就是 msglist）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 补丁不许"只在 children 里找 data-role=msglist"', () => {
  /*
   * ## 这个 bug 让两个补丁函数一直是死代码
   *
   * `mount()` 里 `listEl` 建出来就带 `data-role='msglist'`，
   * 而 `renderMessageList(..., { into: this.listEl })` 是渲染**进**它、
   * 不在里面再套一层。所以 `listEl.children` 全是 `.nb-msg`，
   * 「在 children 里找 msglist」永远返回 undefined ⇒ 函数第一段就 return。
   *
   * 真机实测（`probe-listel.mjs`）：
   * ```text
   *   [data-role="msglist"] 数量 = 1，children = 34（全是消息），嵌套 0
   * ```
   *
   * 症状极隐蔽：编辑保存后**通知弹了**（说明 `onSaveEdit` 跑到了）、
   * `this.messages` 也改了，唯独气泡文字不变 —— 看起来像"保存没生效"。
   * 流式那边同病：文字永远不逐字出现。
   */
  assert.match(panel, /private resolveMsgList\(/, '要有统一的容器解析函数');

  for (const fn of ['patchMessageText', 'patchStreamingMessage']) {
    const at = panel.indexOf('private ' + fn);
    assert.ok(at > 0, '找不到 ' + fn);
    const body = panel.slice(at, at + 1800);
    assert.match(body, /resolveMsgList\(\)/, fn + ' 要统一走 resolveMsgList()');
  }

  /* resolveMsgList 必须先判 listEl 自己 */
  const at = panel.indexOf('private resolveMsgList');
  const body = panel.slice(at, at + 900);
  assert.match(body, /this\.listEl\.getAttribute\('data-role'\)\s*===\s*'msglist'/, '要先判 listEl 自己');
  assert.match(body, /return this\.listEl/, '命中就直接用 listEl');
});

/* ═══════════════════════════════════════════════════════════
   十一、★★★ 找气泡不许数层级（语音消息多一层）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 找正文气泡要用 bubbleOf/querySelector，不许 children[0].children[0]', () => {
  /*
   * 语音消息的 column 里**先**放一条 `.nb-voice-bubble`（音频波形条），
   * 然后才是 `.nb-bubble`：
   *
   *   .nb-msg > div > [ .nb-voice-bubble, .nb-bubble ]
   *
   * 所以 `children[0].children[0]` 对普通消息拿到 `.nb-bubble`、
   * **对语音消息拿到 `.nb-voice-bubble`** —— 往里写文字会把那条 5" 波形签名覆盖掉。
   *
   * 表现：「有的消息能改、有的不能改」，看起来毫无规律。
   * 我在真机上三轮回溯才定位到它（`probe-rowel.mjs` 显示 c00 是 nb-voice-bubble）。
   */
  assert.match(panel, /function bubbleOf\(/, '要有统一的 bubbleOf()');

  for (const fn of ['patchMessageText', 'patchStreamingMessage']) {
    const at = panel.indexOf('private ' + fn);
    assert.ok(at > 0, '找不到 ' + fn);
    const body = panel.slice(at, at + 2000);
    assert.equal(
      /children\[0\]\?\.children\[0\]/.test(body),
      false,
      fn + ' 不许用 children[0].children[0]（语音消息会拿到 nb-voice-bubble）',
    );
    assert.match(body, /bubbleOf\(/, fn + ' 要走 bubbleOf()');
  }
});
