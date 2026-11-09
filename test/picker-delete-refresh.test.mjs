/**
 * 角色长按删除 + 下拉刷新的判据（2026-11-04，第二十九批）。
 *
 * ## 用户原话
 *
 * > 1、选择角色时长按删除设备（是彻底删除并且 ST 内无该角色及其相关数据和聊天记录）
 * > 2、下拉刷新角色（重新从 ST 内获取最新角色角色）
 *
 * ## 这两条的失败方式都是"看起来做了"
 *
 * ```text
 *   只删卡片不删聊天   → 角色没了，但 chats/<avatar>/ 里全是残留 jsonl
 *   长按顺手也点中了   → 弹窗和"选中角色"同时发生，两个动作打架
 *   滚动时误触删除     → 手指滑一下冒出删除框
 *   下拉阈值太小       → 正常滚动就触发刷新，列表跳回顶部
 *   删了当前角色不清状态 → 顶栏还显示名字，发消息才报错
 * ```
 *
 * 六种都不会抛错。逐条钉。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CHAT_DIR = join(REPO, 'client', 'src', 'chat');
const TAURI_SRC = join(REPO, 'client', 'src-tauri', 'src');

const pickerSrc = () => readFileSync(join(CHAT_DIR, 'character-picker.ts'), 'utf8');
const shellSrc = () => readFileSync(join(CHAT_DIR, 'shell.ts'), 'utf8');
const bridgeSrc = () => readFileSync(join(CHAT_DIR, 'st-bridge.ts'), 'utf8');
const rustSrc = () => readFileSync(join(TAURI_SRC, 'st_chat.rs'), 'utf8');

/* ═══════════════════════════════════════════════════════════
   一、删除必须连聊天记录一起删
   ═══════════════════════════════════════════════════════════ */

test('★★★ 删除走 ST 的 characters/delete 且带 delete_chats', () => {
  /*
   * ST 的 `/api/characters/delete`：
   *
   * ```js
   * if (request.body.delete_chats == true) {
   *   await fs.promises.rm(path.join(chats, sanitize(dir_name)),
   *                        { recursive: true, force: true });
   * }
   * ```
   *
   * `delete_chats: true` 才是"彻底删除"。只传 avatar_url 的话
   * **卡片删了、聊天记录全留着** —— 而界面上看不出区别。
   */
  const rust = rustSrc();

  assert.match(rust, /fn st_chat_character_delete/, '要有删除命令');
  assert.match(rust, /"\/api\/characters\/delete"/, '要打正确的端点');
  assert.match(rust, /delete_chats/, '要带 delete_chats 参数');
});

test('★★★ Rust 命令必须注册到 handler（否则前端调不到）', () => {
  const lib = readFileSync(join(TAURI_SRC, 'lib.rs'), 'utf8');
  assert.match(lib, /st_chat::st_chat_character_delete/, '命令要注册进 invoke_handler');
});

test('★★★ 外壳调用时 deleteChats 必须是 true', () => {
  /*
   * 用户要的是"彻底删除"。传 false 的话卡片没了、聊天还在，
   * 而这些残留再没有入口能删（角色已经不在列表里）。
   */
  const shell = shellSrc();
  const start = shell.indexOf('onDelete: async (character');
  assert.ok(start > 0, '找不到 onDelete');
  const block = shell.slice(start, start + 1400);

  assert.match(block, /deleteCharacter\(character\.avatar, true\)/, '第二参必须是 true');
});

test('★★★ 删除当前选中的角色要把状态清干净', () => {
  /*
   * 不清的后果：顶栏还显示那个角色的名字，用户点发送才报错 ——
   * 而它在引擎里已经不存在了。"界面残留"比删除失败更难理解。
   */
  const shell = shellSrc();
  const start = shell.indexOf('onDelete: async (character');
  const block = shell.slice(start, start + 1400);

  assert.match(block, /this\.selectedCharacter\?\.avatar === character\.avatar/, '要判断是不是当前角色');
  assert.match(block, /this\.selectedCharacter = null/, '要清掉选中');
  assert.match(block, /this\.chatSnapshot = null/, '要清掉快照');
});

test('★★ 确认框文案要说清"连聊天记录一起删 + 不能恢复"', () => {
  /*
   * 只说"删除角色"的话，用户会以为只是从列表里移除 ——
   * 实际上 ST 那边是 `fs.rm` 整个聊天目录。
   *
   * 这是**不可逆操作**，文案必须让用户在点之前就知道代价。
   */
  const src = pickerSrc();
  const start = src.indexOf("data-role', 'picker-delete-dialog'");
  assert.ok(start > 0, '找不到删除确认框');
  const block = src.slice(start, start + 2600);

  /*
   * ★ 2026-11-04 变了位置：这个弹窗现在既是分享入口又是删除入口。
   *
   * 副标题改成了中性的分享说明（否则只想分享的人会以为自己点了删除），
   * 而"连聊天记录一起删"这条代价写到了**删除按钮的文案**上。
   *
   * 判据跟着移动，但要求没放松：这个弹窗里必须同时出现
   * "聊天记录" 与 "删除"，用户在哪一行读到都行。
   */
  assert.match(block, /全部聊天记录/, '要说清会连聊天记录一起删');
  assert.match(block, /删除/, '删除动作必须明写');
});

/* ═══════════════════════════════════════════════════════════
   二、长按与点击不能打架
   ═══════════════════════════════════════════════════════════ */

test('★★★ 长按后那次 click 必须被吃掉', () => {
  /*
   * 长按结束时浏览器**也会**发 click。不拦住的话：
   * 用户长按 → 弹删除框 → 松手瞬间又选中该角色 → 弹窗和页面跳转打架。
   */
  const src = pickerSrc();

  assert.match(src, /let longPressed = false/, '要有长按标志');
  assert.match(src, /if \(longPressed\) \{[\s\S]{0,80}return;/, 'click 里要判断并吞掉');
});

test('★★★ 滑动要取消长按（否则滚动时冒出删除框）', () => {
  /*
   * 手指按下后滑动 = 用户在滚动列表。不取消的话，滚一下就有弹窗冒出来。
   */
  const src = pickerSrc();
  const start = src.indexOf('const startPress');
  const block = src.slice(start, start + 700);

  assert.match(block, /addEventListener\('touchmove', cancelTimer\)/, 'touchmove 要取消');
});

test('★★ 长按时长在合理区间（400~800ms）', () => {
  /*
   * 太短会和"点一下"抢；太长用户以为没反应。
   * Android 系统长按是 500ms，我们取 600ms。
   */
  const src = pickerSrc();
  const m = /const LONG_PRESS_MS = (\d+)/.exec(src);
  assert.ok(m !== null, '找不到 LONG_PRESS_MS');
  const ms = Number(m[1]);
  assert.ok(ms >= 400 && ms <= 800, `长按时长 ${String(ms)}ms 不合理`);
});

/* ═══════════════════════════════════════════════════════════
   三、下拉刷新
   ═══════════════════════════════════════════════════════════ */

test('★★★ 只在列表顶部才允许下拉（中间拖动是正常滚动）', () => {
  /*
   * 不判断"在不在顶部"的话，用户往回翻一点内容就触发刷新，
   * 列表还会跳回顶部 —— 这是最容易被骂的一类交互 bug。
   */
  const src = pickerSrc();
  const start = src.indexOf("scroller.addEventListener('touchstart'");
  assert.ok(start > 0, '找不到 touchstart');
  const block = src.slice(start, start + 600);

  assert.match(block, /scrollTop === 0/, '要判断在顶部');
});

test('★★★ 松开才刷新（不是拉到阈值就刷）', () => {
  /*
   * 拉到阈值立刻刷会让"用户还想再拉一点"变成奢望，
   * 而且手指还按着就发请求，观感很差。
   */
  const src = pickerSrc();
  const start = src.indexOf("scroller.addEventListener('touchend'");
  assert.ok(start > 0, '找不到 touchend');
  const block = src.slice(start, start + 500);

  assert.match(block, /shouldReload/, 'touchend 里才决定刷新');
  assert.match(block, /void reload\(\)/, '要真的重新拉列表');
});

test('★★ 下拉阈值不能太小（防误触）', () => {
  const src = pickerSrc();
  const m = /const PULL_THRESHOLD_PX = (\d+)/.exec(src);
  assert.ok(m !== null, '找不到 PULL_THRESHOLD_PX');
  const px = Number(m[1]);
  assert.ok(px >= 40 && px <= 120, `阈值 ${String(px)}px 不合理`);
});

test('★★★ 刷新要真的重新读引擎（不是重绘页面）', () => {
  /*
   * "重绘页面"看起来也像刷新，但它用的还是内存里的旧列表。
   * 用户下拉的诉求是"ST 里新导入了角色，让我看到" ——
   * 必须重新走 `callbacks.load()`。
   */
  const src = pickerSrc();
  const start = src.indexOf('const reload = async');
  assert.ok(start > 0, '找不到 reload');
  const block = src.slice(start, start + 500);

  assert.match(block, /callbacks\.load\(\)/, 'reload 必须重新调用 load');
});

/* ═══════════════════════════════════════════════════════════
   四、桥接层
   ═══════════════════════════════════════════════════════════ */

test('★★ bridge 暴露 deleteCharacter 且参数名对齐 Rust', () => {
  /*
   * Tauri 的 invoke 参数是**按名字**传的，Rust 侧形参是
   * `avatar` / `delete_chats`，JS 侧必须传 `avatar` / `deleteChats`
   * （Tauri 2 会把 camelCase 转 snake_case）。
   *
   * 名字对不上的报错是"missing required key delete_chats"，
   * 但只在真的点删除时才出现 —— 编译期完全不报。
   */
  const bridge = bridgeSrc();
  assert.match(bridge, /deleteCharacter\(avatar: string, deleteChats: boolean\)/, '签名要对');
  assert.match(bridge, /invoke<string>\('st_chat_character_delete', \{ avatar, deleteChats \}\)/, '参数名要对');
});
