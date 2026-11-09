/**
 * 预算紧张时的裁剪优先级（2026-11-09，C2）。
 *
 * ## 为什么要改
 *
 * 改之前只有两档标记：必留 / 可裁。而"可裁"实际只有对话历史 ——
 * 于是预算不够时**只能裁最近几轮对话**，示例对话（`mes_example`）永远不动。
 *
 * 表现是长对话里「记性变差但示例一直在」：角色刚说过的事忘了，
 * 却还在照着一百轮前写的示例说话。
 *
 * ## ST 的做法（`scripts/openai.js` 的 `populateDialogueExamples`）
 *
 * ```js
 *   if (!chatCompletion.canAffordAll([newExampleChat, ...chatMessages])) break;
 * ```
 *
 * 放不下就**整块丢**示例，历史照留。理由很直接：
 *
 * ```text
 *   示例     决定"角色怎么说话" → 丢了只是语气淡一点
 *   历史     决定"角色记得什么" → 丢了立刻失忆
 * ```
 *
 * ## 这条判据守什么
 *
 * 1. 预算宽裕 ⇒ 一条都不丢（不能"总是先丢示例"，那是另一个极端）
 * 2. 预算只够历史 + 必留 ⇒ **整块**丢示例，历史一条不少
 * 3. 丢完示例仍然不够 ⇒ 才开始裁历史
 * 4. 示例**整块**丢，不半留（只留半份示例会把语气带偏）
 * 5. 旧调用方（不传 `dropFirst`）行为**完全不变**
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyTokenBudget } from '../shared/dist/chat/token-budget.js';
import { assembleWithPrompts } from '../shared/dist/chat/prompt-assemble.js';

/** 每条消息算 10 token（内容长度与定价解耦，断言才好读） */
const TEN = () => 10;
/** 按内容长度算，用来构造"这条特别大"的用例 */
const BY_LEN = (text) => text.length;

function budget(messages, trimmable, dropFirst, limit) {
  return applyTokenBudget({
    messages,
    trimmable,
    budget: limit,
    countTokens: TEN,
    ...(dropFirst === undefined ? {} : { dropFirst }),
  });
}

/* ═══════════════════════════════════════════════════════════
   ① 宽裕时不丢
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 预算宽裕：示例与历史都留着（不能"总是先丢示例"）', () => {
  /*
   * 这条防的是**过度纠正**：一听说"要丢示例"，就写成"有示例就丢"。
   * 预算够的时候丢示例是纯粹的损失 —— 用户白写的示例进不了上下文。
   */
  const messages = [
    { role: 'system', content: '系统提示' },
    { role: 'system', content: '示例对话' },
    { role: 'user', content: '历史一' },
    { role: 'assistant', content: '历史二' },
  ];
  const r = budget(messages, [false, false, true, true], [false, true, false, false], 1000);

  assert.equal(r.messages.length, 4, '预算够 ⇒ 一条都不丢');
  assert.equal(r.droppedCount, 0);
  assert.equal(r.overBudget, false);
});

/* ═══════════════════════════════════════════════════════════
   ② 紧张时先整块丢示例
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 预算只够历史：整块丢示例，历史一条不少', () => {
  const messages = [
    { role: 'system', content: '系统提示' },
    { role: 'system', content: '示例对话' },
    { role: 'user', content: '历史一' },
    { role: 'assistant', content: '历史二' },
  ];
  /*
   * 必留 1 + 历史 2 = 30；加上示例 40。预算 35 ⇒ 放不下示例、放得下历史。
   */
  const r = budget(messages, [false, false, true, true], [false, true, false, false], 35);

  assert.equal(r.messages.length, 3, '只丢了示例那一条');
  assert.equal(r.droppedCount, 1);
  assert.ok(
    !r.messages.some((one) => one.content === '示例对话'),
    '示例要被丢掉',
  );
  assert.deepEqual(
    r.messages.map((one) => one.content),
    ['系统提示', '历史一', '历史二'],
    '历史必须一条不少 —— 这是与改之前最大的区别',
  );
  assert.equal(r.overBudget, false);
});

test('★★★★★ 示例必须整块丢，不许只留一半', () => {
  /*
   * 示例可能被拆成多条（示例里有多轮对话）。ST 的语义是"放不下就整块不要"。
   *
   * 只留半份更糟：模型会以为角色的说话风格就是那半份里那一种，
   * 反而把语气带偏 —— 比不给示例更误导。
   */
  const messages = [
    { role: 'system', content: '系统提示' },
    { role: 'system', content: '示例第一段' },
    { role: 'system', content: '示例第二段' },
    { role: 'system', content: '示例第三段' },
    { role: 'user', content: '历史一' },
  ];
  /* 必留 1 + 历史 1 = 20；示例 30 ⇒ 全放 50。预算 25 ⇒ 只够历史 */
  const r = budget(
    messages,
    [false, false, false, false, true],
    [false, true, true, true, false],
    25,
  );

  assert.equal(r.messages.length, 2, '三条示例**全部**丢掉');
  assert.deepEqual(r.messages.map((one) => one.content), ['系统提示', '历史一']);
});

test('★★★★ 丢完示例仍然不够 → 继续裁历史（不能只丢示例就完事）', () => {
  const messages = [
    { role: 'system', content: '系统提示' },
    { role: 'system', content: '示例' },
    { role: 'user', content: '旧历史' },
    { role: 'user', content: '新历史' },
  ];
  /*
   * 必留 1 = 10；示例 1 = 10；历史 2 = 20。总 40。
   *
   * 预算 25 的算路：
   * ```text
   *   40 > 25              ⇒ 先丢示例（整块）→ 剩 30
   *   必留 10 + 历史 20    > 25  ⇒ 还得裁历史
   *   10 + 最新一条 10 = 20 ≤ 25 ⇒ 保住最新一条，丢掉较旧那条
   * ```
   * 预算取 15 就不成立（连"必留 + 一条历史"都放不下），那测的是
   * "全都放不下"，不是"裁历史保最新"。
   */
  const r = budget(messages, [false, false, true, true], [false, true, false, false], 25);

  assert.ok(!r.messages.some((one) => one.content === '示例'), '示例先丢');
  assert.ok(r.messages.length < 3, '历史也被裁了');
  /* 裁历史仍然保留最新的那条（从后往前保） */
  assert.ok(
    r.messages.some((one) => one.content === '新历史'),
    '必须保住最近一条历史',
  );
});

/* ═══════════════════════════════════════════════════════════
   ③ 向后兼容
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 不传 dropFirst：行为与改之前完全一样（旧调用方不受影响）', () => {
  const messages = [
    { role: 'system', content: '系统提示' },
    { role: 'system', content: '示例' },
    { role: 'user', content: '历史一' },
    { role: 'user', content: '历史二' },
  ];
  const r = budget(messages, [false, false, true, true], undefined, 35);

  /* 旧行为：示例是必留，只能裁历史 */
  assert.ok(r.messages.some((one) => one.content === '示例'), '不传标记时示例不会被丢');
  assert.ok(r.droppedCount > 0, '改裁历史');
});

test('★★★★ dropFirst 长度不符：忽略它，不猜对应关系', () => {
  /*
   * 与 `trimmable` 长度不一致时的处置一致：宁可不动，也不猜。
   * 猜错的后果是"裁掉了系统提示却留着示例"，而且静默。
   */
  const messages = [
    { role: 'system', content: '系统提示' },
    { role: 'system', content: '示例' },
    { role: 'user', content: '历史' },
  ];
  const r = budget(messages, [false, false, true], [false, true], 1000);
  assert.equal(r.messages.length, 3, '长度不符 ⇒ 一律不按优先丢处理');
});

/* ═══════════════════════════════════════════════════════════
   ④ 拼装层真的把示例标出来了
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 拼装结果里只有对话示例被标记为"优先丢"', () => {
  /*
   * 这是"标记从哪来"的唯一源头。若 `assemblePrompt` 忘了标，
   * 上面所有预算判据都成了空转（永远走不到"丢示例"那条路）。
   */
  const card = {
    name: '测试',
    description: '描述',
    personality: '性格',
    scenario: '场景',
    first_mes: '开场白',
    mes_example: '{{user}}: 你好\n{{char}}: 你好呀',
  };
  const config = {
    prompts: [
      { identifier: 'main', name: '主提示', content: '你是 {{char}}', role: 'system', systemPrompt: true, marker: false, injectionPosition: 0, injectionDepth: 4, injectionOrder: 100, enabled: true },
      { identifier: 'dialogueExamples', name: '示例', content: '', role: 'system', systemPrompt: true, marker: true, injectionPosition: 0, injectionDepth: 4, injectionOrder: 100, enabled: true },
      { identifier: 'chatHistory', name: '历史', content: '', role: 'system', systemPrompt: true, marker: true, injectionPosition: 0, injectionDepth: 4, injectionOrder: 100, enabled: true },
    ],
    order: [
      { identifier: 'main', enabled: true },
      { identifier: 'dialogueExamples', enabled: true },
      { identifier: 'chatHistory', enabled: true },
    ],
  };

  const result = assembleWithPrompts({
    card,
    config,
    history: [
      { name: '我', is_user: true, mes: '在吗', send_date: '1' },
      { name: '角色', is_user: false, mes: '在', send_date: '2' },
    ],
  });

  assert.equal(result.dropFirst.length, result.messages.length, '长度必须与 messages 一致');

  const exampleIdx = result.messages.findIndex((one) => one.content.includes('你好呀'));
  assert.ok(exampleIdx >= 0, `示例应当进了上下文：${JSON.stringify(result.messages)}`);
  assert.equal(result.dropFirst[exampleIdx], true, '示例必须被标记为优先丢');

  /*
   * 历史与其它提示词都不能被标 —— 一条标错就等于"该保的被丢了"。
   */
  for (let i = 0; i < result.messages.length; i += 1) {
    const one = result.messages[i];
    if (one === undefined) continue;
    if (i === exampleIdx) continue;
    assert.equal(result.dropFirst[i], false, `第 ${String(i)} 条（${one.content.slice(0, 12)}…）不该被标记`);
  }
});
