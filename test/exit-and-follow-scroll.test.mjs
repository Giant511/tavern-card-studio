/**
 * 退出失败 + 发消息不跟随的判据（2026-11-03，第二十五批）。
 *
 * ## 用户报的两条
 *
 * > 1、点狠心退出时没有退出APP。2、在用户发了消息后并没有自动滚动
 *
 * ## 这两个都是"静默失败"，所以必须钉死
 *
 * ```text
 *   退出失败没提示  → 用户点了一下，什么也没发生（他以为是 App 卡了）
 *   权限没开        → invoke 被拒，代码看起来完全正常
 *   void 吞错误     → 唯一能暴露问题的渠道被关掉了
 *   发消息不跟随    → 消息发出去了但看不见，用户以为没发出去
 * ```
 *
 * 四条都不会抛错、不会写日志，只能靠判据守。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CHAT_DIR = join(REPO, 'client', 'src', 'chat');
const MOBILE_DIR = join(REPO, 'client', 'src', 'mobile');
const TAURI_DIR = join(REPO, 'client', 'src-tauri');

const shellSrc = () => readFileSync(join(CHAT_DIR, 'shell.ts'), 'utf8');
const panelSrc = () => readFileSync(join(CHAT_DIR, 'chat-panel.ts'), 'utf8');
const mainSrc = () => readFileSync(join(MOBILE_DIR, 'main.ts'), 'utf8');

/* ═══════════════════════════════════════════════════════════
   一、退出必须真的能退
   ═══════════════════════════════════════════════════════════ */

test('★★★ capabilities 必须授予 core:app:allow-exit', () => {
  /*
   * `core:default` **不含** allow-exit（退出是危险操作，Tauri 默认不授予）。
   *
   * 缺这条的后果不是报错，而是 `invoke('plugin:app|exit')` 被权限系统
   * 静默拒绝 —— 用户点「狠心离开」，界面关掉弹窗，App 却还在。
   *
   * ★ 权限标识符是 `core:app:allow-exit`，**不是** `app:allow-exit`：
   * app 是 Tauri 的 core plugin，前缀必须是 `core:`。
   */
  const caps = JSON.parse(readFileSync(join(TAURI_DIR, 'capabilities', 'default.json'), 'utf8'));
  const list = Array.isArray(caps.permissions) ? caps.permissions : [];

  assert.ok(
    list.includes('core:app:allow-exit'),
    `capabilities 里缺 core:app:allow-exit，退出会被权限静默拒绝。当前：${JSON.stringify(list)}`,
  );
});

test('★★★ 退出调用不许用 void 吞错误', () => {
  /*
   * 用户报「点狠心退出时没有退出APP」，而界面上**一句提示都没有**。
   * 真因就是 `void exit(0)`：invoke 的 rejection 被丢掉了。
   */
  const main = mainSrc();
  assert.match(main, /shell\.exitApp = \(\) => exit\(0\)/, '要返回 Promise 交回壳处理');
});

test('★★★ 退出失败要让用户看见（不能默默失败）', () => {
  const src = shellSrc();
  const start = src.indexOf('private openExitDialog');
  const block = src.slice(start);

  assert.match(block, /Promise\.resolve\(this\.exitApp\(\)\)\.catch/, '要 catch 住失败');
  assert.match(block, /退出没成功/, '要给出可见提示');
});

/* ═══════════════════════════════════════════════════════════
   二、发消息 / 收回复必须跟随滚动
   ═══════════════════════════════════════════════════════════ */

test('★★★ 发消息时强制跟随（不看"本来在不在底部"）', () => {
  /*
   * 用户要的是「用户发出…时跟随滚动」——这是**必须跟**，
   * 不是"本来在底部才跟"。
   *
   * 上一批我只做了"恢复历史不滚"，却没保证"发送时一定滚"，
   * 于是用户在翻历史时发消息，消息插在下面而视口不动 ——
   * 他看到的现象就是"发了消息没有自动滚动"。
   */
  const src = panelSrc();
  const start = src.indexOf('async sendText(');
  const block = src.slice(start, start + 3000);

  assert.match(block, /this\.forceFollow = true/, '发送前要打开强制跟随');
});

test('★★★ 回复开始时也强制跟随', () => {
  const src = panelSrc();
  const start = src.indexOf('const targetIndex = asSwipe');
  assert.ok(start > 0, '找不到占位消息那段');
  const block = src.slice(start, start + 400);

  assert.match(block, /this\.forceFollow = true/, '占位气泡出现时要跟');
});

test('★★★ 流式输出期间强制跟随（否则回复长出去看不见）', () => {
  const src = panelSrc();
  const start = src.indexOf('private stickToBottomIfNeeded');
  const block = src.slice(start, start + 1200);

  assert.match(block, /if \(!this\.forceFollow\)/, '要先看是否强制跟随');
  assert.match(block, /shouldStick\(/, '非强制时才退回条件判断');
});

test('★★ 用户手指碰列表 = 停止跟随（想翻历史时别抢）', () => {
  /*
   * 强制跟随不能变成"永远拽到底"：用户往上翻时 AI 还在流式输出，
   * 一路贴底他就读不了上面。
   *
   * 用 touchstart / wheel 而不是 scroll 事件：程序自己设 scrollTop
   * **也会**触发 scroll，导致区分不了"用户滚"和"我滚"。
   */
  const src = panelSrc();
  assert.match(src, /addEventListener\('touchstart'/, '触摸要停止跟随');
  assert.match(src, /this\.forceFollow = false/, '触摸后关掉强制跟随');
});

test('★★★ 恢复历史时重置强制跟随（否则切 Tab 又滚到底）', () => {
  /*
   * `forceFollow` 是**面板实例**上的状态。切 Tab 会重建面板，
   * 但 `setMessages` 恢复历史时如果不清它，残留的 true 会让
   * 任何一次 `markStick()` 无条件贴底 —— 等于把上一批修好的
   * "切页不滚到底"又弄坏。
   */
  const src = panelSrc();
  const start = src.indexOf('setMessages(messages');
  const end = src.indexOf('getScrollTop(): number');
  const block = src.slice(start, end);

  assert.match(block, /this\.forceFollow = false/, '恢复历史要重置');
});
