/**
 * 人设与角色的绑定要真的生效（2026-11-11）。
 *
 * ## 用户报的一串现象，其实是一件事
 *
 * ```text
 *   ① 角色绑定了人设，聊天里不能自动使用
 *   ② 切换聊天角色不会自动加载人设，显示的是上一个角色绑的那个
 *   ③ 手动加载又提示"还没有人设"
 *   ④ 必须去人设界面点「使用」，而那一按应用到所有角色
 * ```
 *
 * 根因：`personaState.selectedId` 是**全局唯一**的一个 id，切角色时没人动它。
 * 于是新角色继续用旧人设；而 `personasForCharacter` 又因为"当前这套绑的是
 * 别人"把它筛掉 ⇒ 界面显示"还没有人设"。
 *
 * ④ 是前三条的后果：用户只能手动点「使用」，而它改的正是那个全局 id。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  emptyPersonaState,
  addPersona,
  pickPersonaForCharacter,
  syncPersonaToCharacter,
} from '../shared/dist/chat/persona.js';

const ROOT = join(import.meta.dirname, '..');

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 造一套人设状态：default（不绑）+ 两套各绑一个角色 */
function setup() {
  /** @type {any} */
  let state = emptyPersonaState();
  state = addPersona(state, '默认人设', 'p-default');
  state = addPersona(state, '威廉的设定', 'p-w');
  state = addPersona(state, '西奥的设定', 'p-x');
  const bound = (id, avatar) => {
    const at = state.personas.findIndex((one) => one.id === id);
    const list = [...state.personas];
    list[at] = { ...list[at], boundCharacters: [avatar] };
    state = { ...state, personas: list };
  };
  bound('p-w', '威廉.png');
  bound('p-x', '西奥.png');
  return state;
}

test('★★★★★ 切到绑定了人设的角色 → 自动用那套', () => {
  /*
   * 这正是用户要的"角色绑定了人设，聊天里自动使用"。
   */
  const state = { ...setup(), selectedId: 'p-w' };
  const next = syncPersonaToCharacter(state, '西奥.png');
  assert.equal(next.selectedId, 'p-x', '切到西奥就该用西奥绑的那套');

  const picked = pickPersonaForCharacter(state, '西奥.png');
  assert.equal(picked?.id, 'p-x');
});

test('★★★★★ 切到没绑定人设的角色 → 用默认人设，不是继续用上一个', () => {
  /*
   * 用户报的"切角色后显示的是上一个角色绑的人设"，
   * 在"新角色没人设"时应该落到默认人设上。
   */
  const state = { ...setup(), selectedId: 'p-w' };
  const picked = pickPersonaForCharacter(state, '林晚照.png');
  assert.equal(picked?.id, 'p-default', '没人设的角色用默认那套');
});

test('★★★★ 当前这套已经绑着这个角色 → 不动它', () => {
  /*
   * 用户可能在同一角色下有多套可选（开了「允许一角色多设定」），
   * 他手动挑了一套 —— 切回来时不该被强行换成"第一套"。
   */
  const state = { ...setup(), selectedId: 'p-x' };
  const next = syncPersonaToCharacter(state, '西奥.png');
  assert.equal(next, state, '没变化时要返回同一个引用（调用方据此决定要不要落盘）');
});

test('★★★★ 专属人设优先于默认人设', () => {
  /*
   * 一个角色同时满足"有专属人设"和"存在默认人设"时，专属的必须赢 ——
   * 否则"绑定到角色"这个功能等于没用。
   */
  const state = setup();
  const picked = pickPersonaForCharacter(state, '威廉.png');
  assert.equal(picked?.id, 'p-w', '专属人设优先');
});

test('★★★ 一套人设都没有 → null（退回默认名）', () => {
  const empty = emptyPersonaState();
  assert.equal(pickPersonaForCharacter(empty, '威廉.png'), null);
  assert.equal(syncPersonaToCharacter(empty, '威廉.png'), empty, '空状态原样返回');
});

test('★★★★★ 切角色与冷启动都要对齐人设', () => {
  /*
   * 两处都调 `applyPersonaForCharacter`：
   *
   * ```text
   *   切角色    → 用户点了一个新角色
   *   冷启动    → 恢复上次的会话（上次退出时的人设可能是别的角色绑的）
   * ```
   *
   * 漏掉冷启动的话，重进 App 还是"上一个人设"。
   */
  const src = stripComments(read('client/src/chat/shell.ts'));

  /*
   * ★ 数的是 `this.applyPersonaForCharacter(` —— 定义处写的是
   * `private applyPersonaForCharacter(`（不带 `this.`），所以这里只有调用点。
   * 两处：切角色 + 冷启动恢复。
   */
  const calls = [...src.matchAll(/this\.applyPersonaForCharacter\(/g)].length;
  assert.ok(calls >= 2, `切角色与冷启动两处都要调，实际 ${String(calls)} 处`);
  assert.match(src, /private applyPersonaForCharacter\(/, '要有这个方法的定义');
});

test('★★★★★ 缩略图清理必须修在 writeCardToLibrary 内部（两条导入路径共用）', () => {
  /*
   * 用户第一次报「下载后头像还是兜底」，我修在了仓库下载那条调用上；
   * 第二次报「直接导入 PNG 卡，缩略图还是兜底」—— 说明**修在调用方就是会漏**。
   *
   * 仓库下载与本地导入都走 `writeCardToLibrary`，修在那里才不会漏第三条路。
   */
  const src = stripComments(read('client/src/chat/shell.ts'));

  const at = src.indexOf('private async writeCardToLibrary');
  assert.ok(at > 0, '找不到 writeCardToLibrary');
  const body = src.slice(at, at + 5000);

  assert.match(body, /invalidateThumbnail\(plan\.avatar/, '写卡后要删 ST 的缩略图缓存');
  assert.match(body, /clearThumbnailCacheFor\(plan\.avatar\)/, '也要清 App 内存缓存');
});
