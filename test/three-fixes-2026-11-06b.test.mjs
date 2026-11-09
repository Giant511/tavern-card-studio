/**
 * 三个真机问题的判据（2026-11-06 第十四批）。
 *
 * 用户一次提三条：
 *
 * > 1、示例和开场白保存后没有提示。
 * > 2、在这个场景下没有键盘避让。
 * > 3、找个地方加一个可以方便切换当前聊天的人设的东西。
 *
 * ## 这三条的共同点：都是"代码写了但用户看不见"
 *
 * | 问题 | 代码里明明有 | 用户看到的 |
 * |---|---|---|
 * | ① | `onNotify('已保存到卡片')` | 什么都没发生 |
 * | ② | `revealFocusedInput()` + 白名单 | 输入框被键盘盖住 |
 * | ③ | 用户设定管理页 | 聊天时换人设要跳三层 |
 *
 * 所以判据不能只查"有没有那个调用"，必须查**那条路真的通**。
 * 其中 ② 用假 DOM **真跑**一遍遍历逻辑 —— 那是唯一能证明
 * "滚的是 `.nb-scroll` 而不是 `.nb-list`"的方式。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { revealFocusedInput, FOCUS_SCROLL_MARGIN } from '../client/src/chat/focus-scroll.ts';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/**
 * 剥掉注释再断言。
 *
 * ★ 今天已经因为 `indexOf` 命中注释假红三次（§129）。凡"找某个调用在不在
 * 某段里"的判据，一律先剥注释，否则解释规则的文字会被当成代码。
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

const shellSrc = stripComments(read('client/src/chat/shell.ts'));
const greetingSrc = stripComments(read('client/src/chat/greeting-page.ts'));
const panelSrc = stripComments(read('client/src/chat/chat-panel.ts'));
const cssSrc = read('client/src/chat/chat.css');

/* ═══════════════════════════════════════════════════════════
   ① 保存后要有提示
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 保存后的通知必须在**重绘之后**发（否则被一起删掉）', () => {
  /*
   * 真因（真机取证）：
   *
   * ```text
   *   onNotify('已保存到卡片')   ← 通知挂进 .nb-topbar
   *   renderGreeting()          ← pageHost.replaceChildren()
   *                               连 .nb-greeting（含 topbar）一起删
   *                                ⇒ 通知跟着消失
   * ```
   *
   * 用户看到的就是"点保存，毫无反应"。而代码里确实有提示 ——
   * **写了但看不见**比没写更难查。
   *
   * 判据：按源码顺序，`renderGreeting()` 的出现位置必须早于
   * 成功通知那一句。用行首锚点定位，避免命中注释
   * （已经剥过一遍注释，这里再加行首约束）。
   */
  const at = shellSrc.indexOf('private async saveGreeting');
  assert.ok(at > 0, '找不到 saveGreeting');
  const body = shellSrc.slice(at, at + 6000);

  /*
   * ★★★ 必须取**最后一次** `renderGreeting()`（2026-11-06 变异验证抓到的）。
   *
   * 这个方法里有**两处**重绘：
   *
   * ```text
   *   this.renderGreeting();   ← ① 加载态（按钮变"保存中"）
   *   … 写盘 …
   *   this.renderGreeting();   ← ② 保存完成，这次才是关键
   *   onNotify('已保存到卡片')
   * ```
   *
   * 第一版判据用 `search()` 取第一个匹配 —— 它永远指向 ①，而 ① 当然在
   * 通知之前。于是把通知挪回 ②之前（还原原来那个 bug）判据**照样全绿**：
   * 变异验证把这条假绿抓出来了。
   *
   * 要钉的是"**最后一次**重绘在通知之前"，取全部匹配再拿最后一个。
   */
  const redraws = [...body.matchAll(/^ {4}this\.renderGreeting\(\);$/gm)].map((m) => m.index ?? -1);
  const notify = body.search(/this\.options\.onNotify\?\.\('已保存到卡片'/);

  assert.ok(redraws.length >= 2, `saveGreeting 里应该有两处重绘，实际 ${String(redraws.length)}`);
  assert.ok(notify > 0, '找不到「已保存到卡片」通知');

  const lastRedraw = redraws[redraws.length - 1];
  assert.ok(
    lastRedraw < notify,
    '最后一次 renderGreeting() 必须先执行，通知才能挂在**新**渲染出来的 topbar 里',
  );
});

test('★★★★ 保存按钮自带三态（已保存 ✓ 不看通知也能看见）', () => {
  /*
   * 只靠顶部通知是不可靠的：它挂在 topbar 里，任何整页重绘都会带走它，
   * 而且 3.2 秒后自动消失。
   *
   * 所以反馈要落在**用户刚点的地方**：按钮自己变成「已保存 ✓」。
   * 这条钉三件事：文案、`data-state`、以及"必须是主按钮样式"。
   */
  assert.match(greetingSrc, /已保存 ✓/, '保存按钮要有「已保存 ✓」这一态');
  assert.match(
    greetingSrc,
    /if \(justSaved\) save\.setAttribute\('data-state', 'done'\)/,
    '要有 data-state=done（样式挂在这里）',
  );
  assert.match(greetingSrc, /state\.savedFlash && !changed/, '已保存态只在"无改动"时成立');
});

test('★★★★ 保存成功要清掉上一轮的错误（否则永远不会显示成功）', () => {
  /*
   * 成功分支原来没清 `error`：上一次失败留下的错误文案会一直挂着，
   * 于是 ① 页面还显示失败 ② 我加的 `if (error === '') 才发通知` 永远不成立。
   *
   * 两个后果叠在一起，表现又回到"保存了没反应"。
   */
  const at = shellSrc.indexOf('private async saveGreeting');
  const body = shellSrc.slice(at, at + 4000);
  const success = body.indexOf('baseline: greetingFingerprint(fresh)');
  assert.ok(success > 0, '找不到成功分支');
  const beforeSuccess = body.slice(Math.max(0, success - 500), success);
  assert.match(beforeSuccess, /error: ''/, '成功分支要清空 error');
});

test('★★★ 「已保存」2 秒后自动回落（不许一直占着主按钮）', () => {
  assert.match(shellSrc, /savedFlash: true/, '保存成功要标记 savedFlash');
  const at = shellSrc.indexOf('savedFlash: true');
  const after = shellSrc.slice(at, at + 1200);
  assert.match(after, /savedFlash: false/, '要有回落');
  assert.match(after, /setTimeout/, '回落靠定时器');
});

test('★★★ 回落定时器要存成字段并在下次保存前清掉', () => {
  /*
   * 连点两次保存时，第一次的定时器会在第二次之后触发，
   * 把刚点亮的「已保存」提前掐掉。所以必须能清。
   */
  assert.match(shellSrc, /private savedFlashTimer: number \| null = null/, '定时器要存字段');
  assert.match(shellSrc, /clearSavedFlashTimer/, '要有清理方法');
  const at = shellSrc.indexOf('savedFlash: true');
  const after = shellSrc.slice(at, at + 400);
  assert.match(after, /clearSavedFlashTimer\(\)/, '设新定时器前先清旧的');
});

test('★★★★★ 「已保存」回落时不许重绘整页（会抢走焦点和滚动位置）', () => {
  /*
   * 真机实测（第一版就是重绘的）：
   *
   * ```text
   *   .nb-scroll scrollTop: 648 → 0
   *   activeElement: BODY            ← 输入框被替换掉
   *   --nb-kb-inset-native: 0        ← 键盘被收起
   * ```
   *
   * 即：保存成功 2 秒后，用户正在改下一个字段时会被打断 ——
   * 为了撤掉一句"已保存 ✓"而抢走焦点，代价远大于收益。
   *
   * 判据：回落那个定时器的回调里，不许出现 `renderGreeting()`。
   */
  /*
   * ★ 定位要精确：`savedFlash: false` 在源码里出现两次 ——
   *   一次在错误分支（它后面**确实**跟着 renderGreeting，那是应该的），
   *   一次在定时器回调里（那处不许重绘）。
   *   第一版判据用了 `indexOf('savedFlash: false')`，命中的是错误分支，
   *   于是把"错误时重绘"误判成"回落时重绘"。
   *
   * 第二版改用赋值语句定位，但窗口开 700 字符又跨到了**末尾那次**
   * `renderGreeting()`（方法尾部本来就有一次合法重绘）。
   * 最终按"定时器回调的起止"切片：从 `setTimeout(() => {` 到 `}, 2000)`。
   */
  const timerAt = shellSrc.search(/globalThis\.setTimeout\(\(\) => \{[\s\S]{0,400}?savedFlash: false/);
  assert.ok(timerAt > 0, '找不到回落定时器');
  const closeAt = shellSrc.indexOf('}, 2000)', timerAt);
  assert.ok(closeAt > timerAt, '找不到定时器结束');
  const block = shellSrc.slice(timerAt, closeAt);
  assert.ok(
    !/this\.renderGreeting\(\)/.test(block),
    '回落只许改按钮文字，不许重绘整页',
  );
  assert.match(block, /paintSavedFlashOff/, '应该走就地更新');
});

test('★★★★ 就地回落要校验按钮仍是「已保存」，否则会撒谎', () => {
  /*
   * 这 2 秒内用户可能又改了内容：那次改动把按钮刷成「保存到卡片」。
   * 此时无条件写「没有改动」就是撒谎（用户以为改动丢了）。
   */
  const at = shellSrc.indexOf('private paintSavedFlashOff');
  assert.ok(at > 0, '找不到 paintSavedFlashOff');
  const body = shellSrc.slice(at, at + 1200);
  assert.match(body, /getAttribute\('data-state'\) !== 'done'/, '要先校验状态');
  assert.match(body, /return;/, '不是 done 就直接返回');
});

/* ═══════════════════════════════════════════════════════════
   ② 键盘避让：真正能滚的那一层
   ═══════════════════════════════════════════════════════════ */

/**
 * 造一个假 DOM 节点（只实现 `revealFocusedInput` 会碰的那几个成员）。
 *
 * 数字全部取自真机实测（`.verify/probe-kb-which-scroller.mjs`）：
 *
 * ```text
 *   .nb-scroll  rect 80~464   clientHeight 384  scrollHeight 1138  scrollTop 440  maxScroll 754
 *   .nb-list    rect -344~762 clientHeight 1107 scrollHeight 1107  scrollTop 0    maxScroll 0
 *   textarea    rect 516~660
 *   键盘上沿（visibleBottom）= 464
 * ```
 */
function makeNode({ classes = [], rect, scrollTop = 0, scrollHeight = 0, clientHeight = 0 }) {
  const node = {
    classList: { contains: (name) => classes.includes(name) },
    scrollTop,
    scrollHeight,
    clientHeight,
    getBoundingClientRect: () => rect,
    parentElement: null,
  };
  return node;
}

function chain(...nodes) {
  for (let i = 0; i < nodes.length - 1; i += 1) nodes[i].parentElement = nodes[i + 1];
  return nodes[0];
}

test('★★★★★ 嵌套 scroll>list 时，滚的是能滚的外层（真机复现）', () => {
  /*
   * 用户问题② 的原场景。`.nb-list` 在 `.nb-scroll` 里不是 flex 子项
   * ⇒ 高度被内容撑开 ⇒ maxScroll=0。旧代码就近采纳它，clamp 把目标值
   * 夹回 0，差值为 0 就 return false —— **从不往上看那层真正能滚的**。
   */
  const textarea = makeNode({
    classes: [],
    rect: { top: 516, bottom: 660 },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  });
  const list = makeNode({
    classes: ['nb-list'],
    rect: { top: -344, bottom: 762 },
    scrollTop: 0,
    scrollHeight: 1107,
    clientHeight: 1107, // maxScroll = 0 ⇒ 滚不动
  });
  const scroll = makeNode({
    classes: ['nb-scroll'],
    rect: { top: 80, bottom: 464 },
    scrollTop: 440,
    scrollHeight: 1138,
    clientHeight: 384, // maxScroll = 754 ⇒ 这才是能滚的
  });
  textarea.tagName = 'TEXTAREA';
  chain(textarea, list, scroll);

  const doc = { activeElement: textarea };
  const moved = revealFocusedInput(doc, 464);

  assert.equal(moved, true, '必须滚（输入框底边 660 远超可见底 464）');
  assert.equal(list.scrollTop, 0, '.nb-list 不可滚，不该动它');

  /*
   * 期望值：overflowBottom = 660 - (464 - 12) = 208
   *        next = clamp(440 + 208) = 648（maxScroll 754，不越界）
   */
  const expected = 440 + (660 - (464 - FOCUS_SCROLL_MARGIN));
  assert.equal(scroll.scrollTop, expected, `该滚到 ${String(expected)}`);

  /* 滚完之后输入框底边应该刚好落在"可见底 - 余量"处 */
  const shiftedBottom = 660 - (scroll.scrollTop - 440);
  assert.equal(shiftedBottom, 464 - FOCUS_SCROLL_MARGIN, '滚完底边要落在可见底上方一个余量');
});

test('★★★ 只有一层可滚时照旧采纳它（聊天设置页不会回归）', () => {
  /*
   * 「聊天设置」各级页面没有 `.nb-scroll` 包着，`.nb-list` 自己就是滚动者。
   * 修 ② 时如果把"跳过不可滚容器"写成"跳过 .nb-list"，那一页会立刻坏 ——
   * 而它当初正是用户第二次报"还是没有键盘避让"才修好的。
   */
  const textarea = makeNode({
    classes: [],
    rect: { top: 500, bottom: 560 },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  });
  const list = makeNode({
    classes: ['nb-list'],
    rect: { top: 80, bottom: 464 },
    scrollTop: 100,
    scrollHeight: 1000,
    clientHeight: 384, // maxScroll = 616 ⇒ 它能滚
  });
  textarea.tagName = 'TEXTAREA';
  chain(textarea, list);

  const moved = revealFocusedInput({ activeElement: textarea }, 464);
  assert.equal(moved, true);
  assert.ok(list.scrollTop > 100, '该由 .nb-list 自己滚');
});

test('★★★ 全都不可滚 ⇒ 返回 false（那是真的不需要滚）', () => {
  const textarea = makeNode({
    classes: [],
    rect: { top: 100, bottom: 160 },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  });
  const list = makeNode({
    classes: ['nb-list'],
    rect: { top: 80, bottom: 464 },
    scrollTop: 0,
    scrollHeight: 300,
    clientHeight: 300, // 内容比容器短
  });
  textarea.tagName = 'TEXTAREA';
  chain(textarea, list);

  assert.equal(revealFocusedInput({ activeElement: textarea }, 464), false);
});

test('★★★ 焦点不在输入框上 ⇒ 什么都不做', () => {
  const div = makeNode({ classes: [], rect: { top: 0, bottom: 10 } });
  div.tagName = 'DIV';
  const list = makeNode({
    classes: ['nb-list'],
    rect: { top: 0, bottom: 400 },
    scrollTop: 50,
    scrollHeight: 900,
    clientHeight: 400,
  });
  chain(div, list);

  assert.equal(revealFocusedInput({ activeElement: div }, 400), false);
  assert.equal(list.scrollTop, 50, '不该动');
});

/* ═══════════════════════════════════════════════════════════
   ③ 切换当前聊天的人设
   ═══════════════════════════════════════════════════════════ */

test('★★★★ 聊天顶栏要有可点的人设入口', () => {
  assert.match(panelSrc, /data-role', 'persona-switch'/, '要有 data-role（探针靠它定位）');
  assert.match(panelSrc, /onSwitchPersona/, '点击要能回调出去');
  assert.match(panelSrc, /aria-haspopup', 'listbox'/, '语义上是个下拉');
});

test('★★★★ 外壳没提供切换能力时不许画假按钮', () => {
  /*
   * 与 `onOpenChatSettings` 同一条纪律：点了没反应的按钮比不挂更糟
   * （用户会以为功能坏了）。这里做纯文字。
   */
  assert.match(panelSrc, /this\.callbacks\.onSwitchPersona === undefined/, '要先判有没有回调');
  assert.match(panelSrc, /data-static', 'true'/, '没有回调时是静态文字');
});

test('★★★★★ 可选人设必须来自 personasForCharacter（不许自己过滤）', () => {
  /*
   * 那是"这个角色能用哪几套"的唯一判定（绑定关系 + 全局多绑定开关）。
   * 这里再过滤一遍必然分叉，表现为"管理页能看见、聊天页切不到"。
   */
  const at = shellSrc.indexOf('private openPersonaSwitcher');
  assert.ok(at > 0, '找不到 openPersonaSwitcher');
  const body = shellSrc.slice(at, at + 2500);
  assert.match(body, /personasForCharacter\(this\.personaState/, '必须复用那个判定');
  assert.ok(
    !/personaState\.personas\.filter\(/.test(body),
    '不许在这里自己 filter（两处判定必然分叉）',
  );
});

test('★★★★ 切换人设不跳页（聊天不该被打断）', () => {
  const at = shellSrc.indexOf('private openPersonaSwitcher');
  const body = shellSrc.slice(at, at + 2500);
  assert.ok(!/this\.renderPage\(\)/.test(body), '切人设不许 renderPage（会重建面板、断掉正在流的内容）');
  assert.match(body, /syncPersonaToChat/, '要推送新上下文');
});

test('★★★★ 切换后顶栏胶囊要跟着改名', () => {
  /*
   * `setContext` 只更新了 `userName`，胶囊文字是渲染期写死的 ——
   * 不显式刷一次，用户会看到"切了但名字没变"，那是"改了不生效"。
   */
  const at = shellSrc.indexOf('private syncPersonaToChat');
  const body = shellSrc.slice(at, at + 900);
  assert.match(body, /personaLabel/, 'setContext 要带 personaLabel');
  assert.match(body, /syncPersonaChip/, '还要显式刷新胶囊文字');
});

test('★★★ 人设胶囊的样式在（不然是个裸文字）', () => {
  assert.match(cssSrc, /\.nb-persona-chip \{/, '要有胶囊样式');
  assert.match(cssSrc, /\.nb-topbar-subrow/, '副标题行要能横排两个元素');
  assert.match(cssSrc, /max-width: 42%/, '胶囊要限宽（长名字会挤掉文件名）');
});
