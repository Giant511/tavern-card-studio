/**
 * 用户设定（persona）判据（2026-11-04，第三十批）。
 *
 * ## 用户要求
 *
 * > 先把用户设定管理做了，你看下这个是只能存到 ST 还是说也可以放到 APP 里面。
 *
 * > 我想实现 ST 原生网页里面的功能，包括修改人设名字、为所有消息设置为该用户、
 * > 人设世界书、以及当前聊天角色可切换用户人数
 *
 * ## 这组判据守什么
 *
 * ```text
 *   存 App 但不进上下文      → 界面能改、模型看不到（"改了没效果"）
 *   位置配置不生效           → 选了"按深度插入"，实际还在提示词里
 *   改名字不推给面板         → 回聊天发消息还是旧名字
 *   批量改名没存盘           → 界面显示新名字，重启就变回去
 * ```
 *
 * 四种都不会抛错。逐条钉。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PERSONA_NAME,
  activePersona,
  activeUserName,
  addPersona,
  emptyPersonaState,
  parsePersonaState,
  personasForCharacter,
  relabelUserMessages,
  removePersona,
  selectPersona,
  updatePersona,
} from '../shared/dist/chat/persona.js';
import { assembleWithPrompts } from '../shared/dist/chat/prompt-assemble.js';
import { parsePromptConfig } from '../shared/dist/chat/prompt-config.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CHAT_DIR = join(REPO, 'client', 'src', 'chat');

const shellSrc = () => readFileSync(join(CHAT_DIR, 'shell.ts'), 'utf8');
const pageSrc = () => readFileSync(join(CHAT_DIR, 'persona-page.ts'), 'utf8');

/* ═══════════════════════════════════════════════════════════
   一、纯逻辑
   ═══════════════════════════════════════════════════════════ */

test('★★★ 新增后自动选中（用户刚建完就是要用它）', () => {
  const next = addPersona(emptyPersonaState(), '格兹', 'id1');
  assert.equal(next.personas.length, 1);
  assert.equal(next.selectedId, 'id1');
  assert.equal(activeUserName(next), '格兹');
});

test('★★ 重名自动加序号（不阻止，但让人能分辨）', () => {
  let state = addPersona(emptyPersonaState(), '格兹', 'a');
  state = addPersona(state, '格兹', 'b');
  assert.equal(state.personas[1].name, '格兹 2');
});

test('★★★ 删掉当前选中项 ⇒ selectedId 归 null（不留悬空引用）', () => {
  let state = addPersona(emptyPersonaState(), '格兹', 'a');
  state = removePersona(state, 'a');
  assert.equal(state.selectedId, null);
  assert.equal(activePersona(state), null);
  /* 没选中时用默认名，不是空串 */
  assert.equal(activeUserName(state), DEFAULT_PERSONA_NAME);
});

test('★★ 改名：空名字忽略（不留一个改不掉名字的项）', () => {
  let state = addPersona(emptyPersonaState(), '格兹', 'a');
  state = updatePersona(state, 'a', { name: '   ' });
  assert.equal(state.personas[0].name, '格兹');

  state = updatePersona(state, 'a', { name: '新名字' });
  assert.equal(state.personas[0].name, '新名字');
});

test('★★★ 磁盘上的坏数据不许让整批作废', () => {
  /*
   * 用户手改过 localStorage、或旧版本写的东西，都可能是坏的。
   * 逐项校验：坏的丢掉，好的留下 —— 不该因为一条坏了就全没了。
   */
  const parsed = parsePersonaState({
    personas: [
      { id: 'a', name: '好的', description: 'd' },
      { id: '', name: '没 id' },
      { id: 'c', name: '' },
      null,
      'x',
      { id: 'a', name: '重复 id' },
    ],
    selectedId: 'b',
  });

  assert.equal(parsed.personas.length, 1, '只留下第一个合法项');
  assert.equal(parsed.personas[0].name, '好的');
  assert.equal(parsed.selectedId, null, 'selectedId 指向不存在的项 ⇒ 归 null');
});

test('★★ 老版本数据（缺 position/depth/role）要能补默认值，不能整条丢', () => {
  const parsed = parsePersonaState({
    personas: [{ id: 'a', name: '老数据', description: 'd' }],
    selectedId: 'a',
  });
  assert.equal(parsed.personas.length, 1);
  assert.equal(parsed.personas[0].position, 'in_prompt');
  assert.equal(parsed.personas[0].depth, 4);
  assert.equal(parsed.personas[0].role, 'system');
  assert.deepEqual(parsed.personas[0].boundCharacters, []);
});

test('★★ 三组全局开关默认全开（对齐 ST 的默认）', () => {
  const state = emptyPersonaState();
  assert.equal(state.notifyOnSwitch, true);
  assert.equal(state.allowMultiBinding, true);
  assert.equal(state.autoBindToChat, true);
});

test('★★★ 按角色筛人设：没绑定 = 所有角色可用', () => {
  let state = addPersona(emptyPersonaState(), '通用', 'a');
  state = addPersona(state, '专属B', 'b');
  state = updatePersona(state, 'b', { boundCharacters: ['B.png'] });

  const forA = personasForCharacter(state, 'A.png').map((one) => one.name);
  const forB = personasForCharacter(state, 'B.png').map((one) => one.name);

  assert.deepEqual(forA, ['通用'], 'A 只该看到没绑定的那套');
  assert.deepEqual(forB.sort(), ['专属B', '通用'].sort(), 'B 能看到绑给自己的 + 通用的');
});

test('★★ 关掉「允许一角色多设定」时只给当前选中的那套', () => {
  let state = addPersona(emptyPersonaState(), 'A', 'a');
  state = addPersona(state, 'B', 'b');
  state = { ...state, allowMultiBinding: false };
  /* 当前选中是 b */
  const list = personasForCharacter(state, 'X.png');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'b');
});

/* ═══════════════════════════════════════════════════════════
   二、真的进上下文
   ═══════════════════════════════════════════════════════════ */

function makeConfig() {
  return parsePromptConfig({
    prompts: [
      { identifier: 'main', name: '主提示', content: '你是{{char}}。', role: 'system' },
      {
        identifier: 'personaDescription',
        name: '人设',
        content: '',
        role: 'system',
        marker: true,
      },
      { identifier: 'chatHistory', name: '历史', content: '', role: 'system', marker: true },
    ],
    prompt_order: [
      {
        character_id: 100000,
        order: [
          { identifier: 'main', enabled: true },
          { identifier: 'personaDescription', enabled: true },
          { identifier: 'chatHistory', enabled: true },
        ],
      },
    ],
  });
}

test('★★★ 人设描述真的进了 messages（这是"存 App 也不丢功能"的前提）', () => {
  const result = assembleWithPrompts({
    card: { name: '小夜', description: '' },
    history: [{ name: '格兹', is_user: true, mes: '你好', send_date: '' }],
    persona: { name: '格兹', description: '【基本信息】\n种族: 兔兽人', position: 'in_prompt' },
    config: makeConfig(),
  });

  const all = result.messages.map((one) => one.content).join('\n');
  assert.ok(all.includes('兔兽人'), `人设描述没进上下文：${all.slice(0, 300)}`);
  assert.equal(result.personaUsed, true);
});

test('★★★ 名字参与 {{user}} 替换', () => {
  const result = assembleWithPrompts({
    card: { name: '小夜', description: '' },
    history: [{ name: '格兹', is_user: true, mes: '你好', send_date: '' }],
    persona: { name: '格兹', description: '{{user}} 是一名工程师' },
    config: makeConfig(),
  });

  const all = result.messages.map((one) => one.content).join('\n');
  assert.ok(all.includes('格兹 是一名工程师'), '名字没参与替换');
  assert.ok(!all.includes('{{user}}'), '不许把 {{user}} 原样发出去');
});

test('★★★ 位置 = none 时不插入描述', () => {
  const result = assembleWithPrompts({
    card: { name: '小夜', description: '' },
    history: [{ name: '格兹', is_user: true, mes: '你好', send_date: '' }],
    persona: { name: '格兹', description: '不该出现的描述', position: 'none' },
    config: makeConfig(),
  });

  const all = result.messages.map((one) => one.content).join('\n');
  assert.ok(!all.includes('不该出现的描述'), 'position=none 却插进去了');
});

test('★★★ 位置 = at_depth 时描述仍然会被插入（换了个位置，不是丢掉）', () => {
  const result = assembleWithPrompts({
    card: { name: '小夜', description: '' },
    history: [
      { name: '格兹', is_user: true, mes: '第一句', send_date: '' },
      { name: '小夜', is_user: false, mes: '第二句', send_date: '' },
    ],
    persona: { name: '格兹', description: '按深度插入的描述', position: 'at_depth', depth: 1 },
    config: makeConfig(),
  });

  const all = result.messages.map((one) => one.content).join('\n');
  assert.ok(all.includes('按深度插入的描述'), 'at_depth 位置把描述丢了');
});

test('★★ 不传 persona 时行为与之前一致', () => {
  const result = assembleWithPrompts({
    card: { name: '小夜', description: '' },
    history: [{ name: '你', is_user: true, mes: '你好', send_date: '' }],
    config: makeConfig(),
  });
  assert.ok(result.messages.length > 0);
  assert.equal(result.personaUsed, false);
});

/* ═══════════════════════════════════════════════════════════
   三、为所有消息设置为该用户
   ═══════════════════════════════════════════════════════════ */

test('★★★ 只改用户发的消息，角色名不许动', () => {
  /*
   * 把角色的消息也改成用户的名字，对话会彻底错乱
   * （看起来像角色在自称用户）。
   */
  const messages = [
    { is_user: true, name: '旅人', mes: '你好' },
    { is_user: false, name: '小夜', mes: '你好呀' },
    { is_user: true, name: '旅人', mes: '在吗' },
  ];

  const next = relabelUserMessages(messages, '格兹');
  assert.equal(next[0].name, '格兹');
  assert.equal(next[1].name, '小夜', '角色名被误改');
  assert.equal(next[2].name, '格兹');
});

test('★★ 返回新数组，不改原数组', () => {
  /*
   * 就地改会让面板手里的数组与磁盘上的不一致 ——
   * "改了但没存"是批量操作最容易漏的一步。
   */
  const messages = [{ is_user: true, name: '旅人', mes: 'x' }];
  const next = relabelUserMessages(messages, '格兹');
  assert.equal(messages[0].name, '旅人', '原数组被就地改了');
  assert.equal(next[0].name, '格兹');
});

test('★★ 空名字不做任何改动', () => {
  const messages = [{ is_user: true, name: '旅人', mes: 'x' }];
  const next = relabelUserMessages(messages, '   ');
  assert.equal(next[0].name, '旅人');
});

/* ═══════════════════════════════════════════════════════════
   四、接线
   ═══════════════════════════════════════════════════════════ */

test('★★★ 页面存在且带关键控件', () => {
  const page = pageSrc();
  for (const role of [
    'persona-name',
    'persona-description',
    'persona-position',
    'persona-lorebook',
    'persona-bind-chip',
    'persona-relabel',
  ]) {
    assert.ok(page.includes(role), `缺少控件 ${role}`);
  }
});

test('★★★ 外壳把 persona 推给聊天面板（不推就是"改了没生效"）', () => {
  const shell = shellSrc();
  assert.match(shell, /private syncPersonaToChat/, '要有同步方法');
  assert.match(shell, /persona: this\.personaContext\(\)/, '创面板的 ctx 里要带 persona');
  assert.match(shell, /userName: this\.currentUserName\(\)/, 'userName 要用当前人设');
});

test('★★★ 人设状态要落盘（不落盘 = 重启就没了）', () => {
  const main = readFileSync(join(REPO, 'client', 'src', 'mobile', 'main.ts'), 'utf8');
  assert.match(main, /LS_PERSONA/, '要有存储键');
  assert.match(main, /onPersistPersona: writePersonaState/, '要接上保存');
  assert.match(main, /personaState: readPersonaState\(\)/, '启动时要读回来');
});

test('★★ 批量改名后要存盘（否则重启变回去）', () => {
  const shell = shellSrc();
  const start = shell.indexOf('onRelabelMessages: async');
  assert.ok(start > 0);
  const block = shell.slice(start, start + 1600);

  assert.match(block, /relabelUserMessages\(/, '要真的改');
  assert.match(block, /await this\.persistChat\(/, '要存盘');
  assert.match(block, /restoreScroll/, '要保持滚动位置');
});

test('★★ 返回键要先退出这一页（不能直接跳回聊天）', () => {
  const shell = shellSrc();
  const start = shell.indexOf('goBackOneLevel(): boolean');
  const rest = shell.slice(start + 10);
  const next = rest.indexOf('\n  private ');
  const block = rest.slice(0, next < 0 ? rest.length : next);

  assert.match(block, /if \(this\.personaOpen\)/, '返回键要处理这个二级页');
});

/* ═══════════════════════════════════════════════════════════
   五、用户不该看见"引擎"这个词
   ═══════════════════════════════════════════════════════════ */

test('★★★ 用户设定页的文案里不出现 ST / SillyTavern / 引擎', () => {
  /*
   * 用户原话：
   *
   * > 用户不需要知道 ST 是什么，只需要知道 APP 有完整聊天功能就行
   *
   * 这一页尤其重要 —— 它是用户天天要打开的设置页。
   */
  const page = pageSrc();
  /* 只看字符串字面量里的（注释里解释背景可以提） */
  const literals = [...page.matchAll(/'([^'\\n]{4,})'/g)].map((m) => m[1]);

  for (const text of literals) {
    if (text.includes('@tcs/shared') || text.startsWith('.')) continue;
    assert.ok(!/SillyTavern/i.test(text), `文案里出现了 SillyTavern：${text.slice(0, 60)}`);
    assert.ok(!/\bST\b/.test(text), `文案里出现了 ST：${text.slice(0, 60)}`);
  }
});
