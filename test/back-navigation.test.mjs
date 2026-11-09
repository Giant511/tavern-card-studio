/**
 * 返回层级的判据（2026-11-03，第二十三批）。
 *
 * ## 用户报的两个问题
 *
 * > 正常左上方是返回上一级，但是点了之后直接就退到聊天设置里了，
 * > 还有我想让系统的返回手势也生效为返回上一级
 *
 * ## 为什么这组判据值得单独写
 *
 * 返回行为的失败方式都是"**能用，但退错层**"：
 *
 * ```text
 *   跳级退（这次）   → 用户在第三级点返回，被扔回第一级，得重新点两次才能回来
 *   手势没接管       → 直接退出应用（丢掉正在读的页面）
 *   返回什么都不做   → 按钮看着是好的，点了没反应
 *   两套实现分叉     → 按钮退一步、手势退两步，用户永远学不会
 * ```
 *
 * 四种都不报错。所以层级必须做成可单测的纯函数，而不是散在各页的 if 里。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parentRouteOf } from '../shared/dist/chat/nav.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CHAT_DIR = join(REPO, 'client', 'src', 'chat');
const MOBILE_DIR = join(REPO, 'client', 'src', 'mobile');

/* ═══════════════════════════════════════════════════════════
   一、层级表（用户报的 bug 就在这里）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 提示词管理的上一级是「AI 响应配置」，不是聊天设置菜单', () => {
  /*
   * 这是用户报的**原 bug**：点了返回直接退到聊天设置。
   *
   * 层级：聊天 → 聊天设置 → AI 响应配置 → 提示词管理。
   * 从提示词管理点返回，应该回到「AI 响应配置」。
   */
  assert.equal(parentRouteOf('prompts'), 'sampling');
  assert.notEqual(parentRouteOf('prompts'), 'menu', '跳级退就是这个 bug');
});

test('★★★ 聊天文件页的上一级是「聊天操作」，不是菜单', () => {
  /* 同样的跳级问题：聊天设置 → 聊天操作 → 聊天文件 */
  assert.equal(parentRouteOf('files'), 'actions');
});

test('★★ 各分组页的上一级是聊天设置菜单', () => {
  for (const group of ['sampling', 'formatting', 'worldbook', 'persona', 'behavior']) {
    assert.equal(parentRouteOf(group), 'menu', `${group} 的上一级应是菜单`);
  }
});

test('★★ 聊天操作页的上一级是菜单', () => {
  assert.equal(parentRouteOf('actions'), 'menu');
});

test('★★ 菜单的上一级是聊天本身（null）', () => {
  /*
   * `null` 也是"一级" —— 表示"回到聊天页"。
   * 这里如果返回 `'menu'` 就是死循环（点了没反应）。
   */
  assert.equal(parentRouteOf('menu'), null);
});

test('★★★ 未知路由也要有上一级（不许返回 undefined 导致"点了没反应"）', () => {
  /*
   * 将来新加一个分组页、忘了录入时，最坏的结果应该是"退到菜单"（少退一级），
   * 而不是"什么都不做"。后者用户会以为返回键坏了。
   */
  const unknown = parentRouteOf('某个还没做过的新页面');
  assert.equal(typeof unknown, 'string', '至少要给一个可退的目标');
  assert.equal(unknown, 'menu');
});

/* ═══════════════════════════════════════════════════════════
   二、单一入口（界面按钮与系统手势共用）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 各页的返回按钮统一走 goBackOneLevel（不再各写各的目标）', () => {
  /*
   * 这个 bug 的根因就是"上一级是谁"被实现了 5 遍：
   * `renderChatPrompts` 写死 `'menu'`、`renderChatSettingsSection` 写
   * `route === 'menu' ? null : 'menu'`…… 只要有两份就会分叉。
   *
   * 判据：除了「进入」某个页面（`onOpenXxx` / `onManageFiles` / 齿轮按钮），
   * 所有 `onBack` 里不许再出现写死的路由赋值。
   */
  const src = readFileSync(join(CHAT_DIR, 'shell.ts'), 'utf8');

  /* 抓出所有 `onBack: () => { ... }` 的块 */
  const blocks = [...src.matchAll(/onBack: \(\) => \{([\s\S]*?)\n      \},/g)];
  assert.ok(blocks.length >= 4, `应该有多处 onBack，实际找到 ${String(blocks.length)} 处`);

  for (const block of blocks) {
    /*
     * 角色选择器的 onBack 是**关浮层**，不涉及路由 —— 允许它自己处理。
     */
    if (block[1].includes('pickerOpen')) continue;

    assert.ok(
      block[1].includes('goBackOneLevel'),
      `这个 onBack 没走统一入口：${block[1].trim().slice(0, 60)}`,
    );
  }
});

test('★★★ 系统返回手势必须真的注册（没注册 = 按返回直接退出应用）', () => {
  const main = readFileSync(join(MOBILE_DIR, 'main.ts'), 'utf8');

  assert.match(main, /onBackButtonPress/, '要监听系统返回');
  assert.match(main, /registerBackGesture\(shell\)/, '要在挂载后注册');
  assert.match(main, /goBackOneLevel\(\)/, '要复用同一个层级逻辑');
});

test('★★★ 到顶层由弹窗决定退出 —— 否则返回键在应用内就没用了', () => {
  /*
   * ## 2026-11-03 第二十四批更新：到顶层不再"直接 exit"，改成弹确认框
   *
   * 用户要求「返回到最上一级后再按返回，提示是否退出」。
   * 所以流程变成：
   *
   * ```text
   *   返回 → goBackOneLevel() → 到顶层 → 弹确认框
   *   确认框「狠心离开」 → shell.exitApp() → exit(0)
   * ```
   *
   * 原判据钉的是 `if (!goBackOneLevel()) exit(0)`（到顶层当场退）。
   * 那句已经是旧行为 —— 保留它会让"弹确认框"这个正确改动被当成违规。
   *
   * 判据的**意图**没变：`onBackButtonPress` 一旦注册，Tauri 就不再走默认
   * 行为，所以"退出"这件事必须有人最终兜住。现在兜住它的是注入的
   * `exitApp` + 弹窗，而不是回调里的当场 exit。
   */
  const main = readFileSync(join(MOBILE_DIR, 'main.ts'), 'utf8');
  const start = main.indexOf('async function registerBackGesture');
  assert.ok(start > 0, '找不到 registerBackGesture');
  const block = main.slice(start);

  assert.match(block, /shell\.goBackOneLevel\(\)/, '返回交给壳处理（到顶层由壳弹窗）');
  /*
   * ★ 2026-11-03 第二十五批：从 `() => void exit(0)` 改成 `() => exit(0)`。
   *
   * `void` 会把 invoke 的 rejection **吞掉** —— 而 capabilities 缺
   * `core:app|allow-exit` 时 invoke 正是被拒绝的那一个。
   * 结果就是用户说的「点狠心退出时没有退出APP」，且界面上毫无提示。
   * 现在让它把 Promise 交回壳，由壳 catch 后弹提示。
   */
  /*
   * ★ 只做**正向**断言。
   *
   * 第一版还加了 `assert.ok(!/void exit(0)/)`，结果被**注释**里解释
   * "原来写的是 void exit(0)" 的那句满足而假红 —— 注释骗判据第 N 次。
   * 正向匹配 `= () => exit(0)` 已经排除了 `void` 前缀（正则要求 `=>` 后
   * 直接是 `exit`，中间夹 `void` 就匹配不上），不需要反向再查一遍。
   */
  assert.match(block, /shell\.exitApp = \(\) => exit\(0\)/, '退出动作注入 exit(0)（不许用 void 吞错误）');
});

test('★★ 非 Android 环境注册失败要静默（浏览器预览/桌面端本来就没有）', () => {
  const main = readFileSync(join(MOBILE_DIR, 'main.ts'), 'utf8');
  const start = main.indexOf('async function registerBackGesture');
  const block = main.slice(start);

  assert.match(block, /try \{/, '要有 try');
  assert.match(block, /await import\('@tauri-apps\/api\/app'\)/, '要动态 import（纯 Web 环境不能静态引入）');
});
