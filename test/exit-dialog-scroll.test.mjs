/**
 * 退出确认弹窗 + 滚动跟随的判据（2026-11-03，第二十四批）。
 *
 * ## 用户两个需求
 *
 * > 返回到最上一级后，再使用系统返回时提示是否退出APP
 * > （文案：您确认要离开世界吗？您的角色会伤心的。按钮：狠心离开 / 我还想再聊一会）
 * > 切到聊天页面的时候会自己从头开始滚动，我只要【用户发出】【角色回复气泡】
 * > 【唤出取消键盘】【打开语音面板】时跟随滚动，其他的时候应该保持原样
 *
 * ## 这组守什么
 *
 * 退出弹窗的失败方式：
 * ```text
 *   到顶直接退出       → 用户误触返回就没了（这个弹窗就是防这个）
 *   弹窗开了再按返回    → 应该关弹窗，不是再弹一个 / 退出
 *   点遮罩误退         → 退出不可逆，点空白不该退
 *   文案不对           → 用户说的原话，一个字不能少
 * ```
 *
 * 滚动的失败方式（全是静默的）：
 * ```text
 *   恢复历史还滚到底    → 切 Tab 回来被拽到最底部（用户报的 bug）
 *   不保存滚动位置      → 切回来停在顶部，丢了位置
 * ```
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CHAT_DIR = join(REPO, 'client', 'src', 'chat');
const MOBILE_DIR = join(REPO, 'client', 'src', 'mobile');

const shellSrc = () => readFileSync(join(CHAT_DIR, 'shell.ts'), 'utf8');
const panelSrc = () => readFileSync(join(CHAT_DIR, 'chat-panel.ts'), 'utf8');
const cssSrc = () => readFileSync(join(CHAT_DIR, 'chat.css'), 'utf8');

/* ═══════════════════════════════════════════════════════════
   一、退出确认弹窗
   ═══════════════════════════════════════════════════════════ */

test('★★★ 到顶层时弹确认框，而不是直接退出', () => {
  /*
   * 用户要的是"再使用系统返回时**提示**是否退出"，不是"直接退"。
   * 所以 `goBackOneLevel` 到顶层不能 `return false` 让上层 `exit(0)`，
   * 而要自己弹窗。
   */
  const src = shellSrc();
  const start = src.indexOf('goBackOneLevel(): boolean');
  const rest = src.slice(start + 10);
  /* 取到下一个 `private ` 方法边界为止（否则 slice 到文件尾，把别的
     return false 也抓进来，判据就假红） */
  const next = rest.indexOf('\n  private ');
  const block = rest.slice(0, next < 0 ? rest.length : next);

  assert.match(block, /openExitDialog\(\)/, '到顶层要弹确认框');
  assert.ok(!/return false;/.test(block), 'goBackOneLevel 到顶层不应再 return false');
});

test('★★★ 文案必须逐字匹配用户原话', () => {
  const src = shellSrc();

  assert.match(src, /您确认要离开世界吗？/, '标题');
  assert.match(src, /您的角色会伤心的。/, '副标题');
  assert.match(src, /狠心离开/, '确认按钮');
  assert.match(src, /我还想再聊一会/, '取消按钮');
});

test('★★★ 「狠心离开」调 exitApp，而不是直接 exit', () => {
  /*
   * exit 由外壳注入（动态 import），壳只负责调 `exitApp` 这个抽象。
   * 直接在这里 import @tauri-apps/api 会破坏"纯 Web 环境也能跑"。
   */
  const src = shellSrc();
  const start = src.indexOf('private openExitDialog');
  const block = src.slice(start);

  assert.match(block, /this\.exitApp\(\)/, '确认按钮要调 exitApp');
});

test('★★ 弹窗已开时再按返回 = 关弹窗（不是再弹一个）', () => {
  const src = shellSrc();
  const start = src.indexOf('goBackOneLevel(): boolean');
  const block = src.slice(start, start + 900);

  assert.match(block, /if \(this\.exitOverlay !== null\)/, '要先判断弹窗是否已开');
  assert.match(block, /closeExitDialog\(\)/, '已开则关闭');
});

test('★★ 点遮罩空白 = 再聊一会（不误退）', () => {
  /*
   * 退出不可逆，点空白处就退出太危险。
   */
  const src = shellSrc();
  const start = src.indexOf('private openExitDialog');
  const block = src.slice(start);

  assert.match(block, /\.target === overlay/, '点遮罩（非卡片）才关');
  assert.match(block, /closeExitDialog\(\)/, '关的是弹窗，不是退出');
});

test('★★ 退出动作由外壳注入，默认空（桌面端/浏览器不退出）', () => {
  const src = shellSrc();
  /* 2026-11-03 第二十五批：返回值放宽到 `void | Promise<void>`，
     让壳能 catch 到退出失败（原来 `() => void` 无法区分成功/失败） */
  assert.match(src, /exitApp: \(\) => void \| Promise<void> = \(\) => \{\};/, '默认空实现');

  const main = readFileSync(join(MOBILE_DIR, 'main.ts'), 'utf8');
  /* 同上：不许 `void exit(0)` 吞错误 */
  assert.match(main, /shell\.exitApp = \(\) => exit\(0\)/, 'Android 注入 exit(0)');
});

test('★ 弹窗样式走 Nebula token（不硬编码）', () => {
  const css = cssSrc();
  const start = css.indexOf('.nb-exit-overlay');
  const block = css.slice(start, css.indexOf('@keyframes nb-exit-in') + 10);

  assert.match(block, /var\(--nb-surface-2\)/, '卡片用 surface token');
  assert.match(block, /var\(--nb-radius-lg\)/, '圆角用 token');
  assert.match(block, /var\(--nb-nebula-a\)/, '主按钮用主色 token');
});

/* ═══════════════════════════════════════════════════════════
   二、滚动只在指定时机跟随
   ═══════════════════════════════════════════════════════════ */

test('★★★ setMessages 恢复历史不再滚到底（这是用户报的 bug）', () => {
  /*
   * 用户报「切到聊天页面会自己从头开始滚动」。
   * 真因：setMessages 无条件 pendingScroll = true。
   */
  const src = panelSrc();
  const start = src.indexOf('setMessages(messages');
  const end = src.indexOf('getScrollTop(): number');
  const block = src.slice(start, end);

  /*
   * 用带 `this.` 的赋值形式：注释里解释"不再设 pendingScroll"的那句
   * 也含 `pendingScroll = true` 字样，不带 this. 前缀 —— 不区分就会
   * 误把注释当违规（§93.4 的"注释骗判据"）。
   */
  assert.ok(!/this\.pendingScroll\s*=\s*true/.test(block), 'setMessages 里不许再设 pendingScroll=true');
});

test('★★★ 滚动位置被保存/恢复（不是切回来停在顶部）', () => {
  const shell = shellSrc();

  /* 离开时读 */
  const switchBlock = shell.slice(shell.indexOf('switchTab(id: TabId)'));
  assert.match(switchBlock, /getScrollTop\(\)/, '离开聊天页要读滚动位置');
  assert.match(switchBlock, /chatSnapshot\.scrollTop\s*=/, '存进快照');

  /* 回来时还原 */
  const renderBlock = shell.slice(shell.indexOf('private renderChat(): void'));
  assert.match(renderBlock, /restoreScroll\(/, '回来要还原');
});

test('★★★ 面板暴露 getScrollTop / restoreScroll（外壳不摸私有字段）', () => {
  const src = panelSrc();
  assert.match(src, /getScrollTop\(\): number/, '读位置');
  assert.match(src, /restoreScroll\(top: number\)/, '还原位置');
});

test('★★ 消息变化更新快照时保留 scrollTop（不被覆盖成 undefined）', () => {
  const shell = shellSrc();
  const start = shell.indexOf('private handleChatChanged');
  const block = shell.slice(start);

  assert.match(block, /scrollTop: this\.chatSnapshot\?\.scrollTop/, '更新快照要保留旧位置');
});

test('★★ 真正跟随滚动的入口仍保留（发消息/回复走 markStick）', () => {
  /*
   * 别把"恢复历史不滚"修过头 —— 发消息/流式回复还是要跟的。
   * 那条路是 `markStick()` + `stickToBottomIfNeeded()`，必须还在。
   */
  const src = panelSrc();
  assert.match(src, /markStick\(\)/, '发消息前标记');
  assert.match(src, /stickToBottomIfNeeded\(\)/, '流式贴底');
});
