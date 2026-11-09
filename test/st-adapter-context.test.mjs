/**
 * 世界书激活 + 消息上下文拼装（v0.1.7 / T15.4，决策 #270）。
 *
 * ## 为什么这组测试最重要
 *
 * 契约 §5.2 把"消息上下文拼装"列为 v1 最大的隐藏工作量 —— 它没有服务端接口，
 * 是 ST 前端在浏览器里算出来的。算错的后果**全部是"AI 表现得不太对"**：
 *   · 世界书漏带 → 很像"模型变笨了"；
 *   · 常驻条目没进去 → "它忘了我写的基础设定"；
 *   · `post_history_instructions` 位置错 → "格式要求说了不听"。
 * 没有一条会报错，所以只能靠测试钉。
 *
 * ## 激活判定的两条硬纪律（决策 #270）
 *
 * 1. **只有一份判定函数**（`shared/src/rules/worldbook-activation.ts`），
 *    审计与聊天都调它。各写一套的后果是"编辑器显示 12 条激活、聊天只进 9 条"，
 *    而两边都有自己的测试、都是绿的。
 * 2. `enabled` 缺省 **true**、`constant` 缺省 **false**（与 ST 一致）。
 *    这两条搞反表现为"新写的条目一条都不生效"或"每条都生效"，都不报错。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONTEXT_GAPS,
  DEFAULT_SCAN_DEPTH,
  activeEntriesInOrder,
  assembleContext,
  buildContinueInput,
  judgeEntries,
} from '@tcs/shared';

const card = {
  name: '西奥',
  description: '{{char}} 是图书管理员。',
  personality: '安静',
  scenario: '深夜的图书馆',
  first_mes: '你来了。',
  mes_example: '',
  creator_notes: '作者写给自己的话，不该进上下文',
  system_prompt: '',
  post_history_instructions: '用短句回复。',
  alternate_greetings: [],
  tags: [],
  creator: 'x',
  character_version: '1.0',
  extensions: {},
};

/* ───────────── 激活判定 ───────────── */

test('enabled=false 不激活；缺省视为 true', () => {
  const entries = [
    { keys: ['图书馆'], content: '关掉的条目', enabled: false },
    { keys: ['图书馆'], content: '没写 enabled 的条目' },
  ];
  const verdicts = judgeEntries(entries, { recentText: '图书馆' });
  assert.equal(verdicts[0].active, false);
  assert.equal(verdicts[0].reason, 'disabled');
  assert.equal(verdicts[1].active, true);
});

test('constant=true 不看关键词直接激活', () => {
  const verdicts = judgeEntries([{ keys: [], content: '基础设定', constant: true }], {
    recentText: '完全无关的话',
  });
  assert.equal(verdicts[0].active, true);
  assert.equal(verdicts[0].reason, 'constant');
});

test('没有 keys 且非常驻 → 永不激活（ST 行为）', () => {
  const verdicts = judgeEntries([{ keys: [], content: '孤儿条目' }], { recentText: '孤儿条目' });
  assert.equal(verdicts[0].active, false);
});

test('空正文不激活（进上下文只浪费 token）', () => {
  const verdicts = judgeEntries([{ keys: ['a'], content: '   ' }], { recentText: 'a' });
  assert.equal(verdicts[0].active, false);
  assert.equal(verdicts[0].reason, 'empty');
});

test('关键词命中（大小写不敏感是缺省）', () => {
  const verdicts = judgeEntries([{ keys: ['Library'], content: 'x' }], {
    recentText: 'i went to the LIBRARY',
  });
  assert.equal(verdicts[0].active, true);
  assert.deepEqual(verdicts[0].matchedKeys, ['Library']);
});

test('case_sensitive=true 时区分大小写', () => {
  const verdicts = judgeEntries([{ keys: ['Library'], content: 'x', case_sensitive: true }], {
    recentText: 'library',
  });
  assert.equal(verdicts[0].active, false);
});

test('selective + secondary_keys 是 AND（主中次不中 → 不激活）', () => {
  /*
   * 关系搞反（OR）会让条目在该沉默的时候被激活 ——
   * 表现为"聊着聊着突然开始念设定"。
   */
  const entries = [
    { keys: ['图书馆'], secondary_keys: ['钥匙'], content: 'x', selective: true },
  ];
  assert.equal(judgeEntries(entries, { recentText: '图书馆' })[0].active, false);
  assert.equal(judgeEntries(entries, { recentText: '图书馆 钥匙' })[0].active, true);
});

test('概率激活：random 注入后可复现', () => {
  const entries = [{ keys: ['a'], content: 'x', probability: 30 }];
  // random=0.1 → 10 < 30 → 激活
  assert.equal(judgeEntries(entries, { recentText: 'a', random: () => 0.1 })[0].active, true);
  // random=0.9 → 90 < 30 不成立 → 不激活
  const skip = judgeEntries(entries, { recentText: 'a', random: () => 0.9 })[0];
  assert.equal(skip.active, false);
  assert.equal(skip.reason, 'probability');
});

test('probability=0 在 random=0 时也不激活（判据用 < 不是 <=）', () => {
  const verdicts = judgeEntries([{ keys: ['a'], content: 'x', probability: 0 }], {
    recentText: 'a',
    random: () => 0,
  });
  assert.equal(verdicts[0].active, false);
});

test('返回全部条目（含未激活），因为审计要全量统计', () => {
  /*
   * 这正是 #270 说"共用同一个判定函数"的落地点：
   * 一个函数，审计取全部、聊天自己 filter，不会分叉。
   */
  const entries = [
    { keys: ['命中'], content: 'x' },
    { keys: ['不命中'], content: 'y' },
  ];
  const verdicts = judgeEntries(entries, { recentText: '这段里有命中' });
  assert.equal(verdicts.length, 2);
  assert.equal(verdicts.filter((v) => v.active).length, 1);
});

test('激活条目按 insertion_order 升序（缺省 100）', () => {
  const entries = [
    { keys: ['a'], content: '后', insertion_order: 50 },
    { keys: ['a'], content: '先', insertion_order: 10 },
    { keys: ['a'], content: '中' },
  ];
  const ordered = activeEntriesInOrder(entries, { recentText: 'a' });
  assert.deepEqual(ordered.map((item) => item.entry.content), ['先', '后', '中']);
});

/* ───────────── 上下文拼装 ───────────── */

test('★ 角色卡字段进 system，creator_notes 不进（它不给模型看）', () => {
  const result = assembleContext({ card, history: [] });
  const system = result.messages[0].content;
  assert.match(system, /图书管理员/);
  assert.match(system, /安静/);
  assert.match(system, /深夜的图书馆/);
  assert.equal(system.includes('作者写给自己的话'), false);
});

test('★ {{char}} / {{user}} 被替换（不替换的话模型会把字面量当名字）', () => {
  const result = assembleContext({
    card,
    history: [],
    persona: { name: '旅人' },
  });
  const joined = result.messages.map((m) => m.content).join('\n');
  assert.equal(joined.includes('{{char}}'), false);
  assert.match(joined, /西奥 是图书管理员/);
});

test('历史按 user/assistant 交替映射，跳过系统消息与空正文', () => {
  const result = assembleContext({
    card,
    history: [
      { name: 'u', is_user: true, mes: '在吗' },
      { name: 's', is_user: false, is_system: true, mes: '系统提示' },
      { name: '西奥', is_user: false, mes: '在。' },
      { name: 'u', is_user: true, mes: '   ' },
    ],
  });
  const roles = result.messages.map((m) => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'system']);
});

test('★ post_history_instructions 排在历史**之后**、用户输入之前', () => {
  /*
   * 它通常写"回复格式要求"，越靠后越容易被遵守。
   * 放最前面会被历史淹没（模型对长上下文中段最不敏感）。
   */
  const result = assembleContext({
    card,
    history: [{ name: 'u', is_user: true, mes: '在吗' }],
    userMessage: '继续',
  });
  const contents = result.messages.map((m) => m.content);
  const postIndex = contents.findIndex((text) => text.includes('短句回复'));
  const historyIndex = contents.findIndex((text) => text === '在吗');
  const userIndex = contents.findIndex((text) => text === '继续');
  assert.ok(postIndex > historyIndex, 'post_history 应在历史之后');
  assert.ok(postIndex < userIndex, 'post_history 应在用户输入之前');
});

test('世界书只带激活的，且回传明细供界面显示', () => {
  const result = assembleContext({
    card,
    worldbook: [
      { keys: ['图书馆'], content: '图书馆在二楼。', comment: '位置' },
      { keys: ['龙'], content: '龙住在山顶。', comment: '龙' },
      { keys: [], content: '基础世界设定。', constant: true, comment: '基础' },
    ],
    history: [{ name: 'u', is_user: true, mes: '图书馆在哪' }],
  });
  const system = result.messages[0].content;
  assert.match(system, /图书馆在二楼/);
  assert.match(system, /基础世界设定/);
  assert.equal(system.includes('龙住在山顶'), false);
  assert.equal(result.worldbookUsed.length, 2);
  assert.deepEqual(result.worldbookUsed.map((w) => w.title).sort(), ['位置', '基础'].sort());
});

test('★ 本次用户输入必须进世界书扫描范围', () => {
  /*
   * 否则用户刚说的话里提到某个名字，对应条目不会激活 ——
   * 表现为"它没听懂我刚提的那个地方"。
   */
  const result = assembleContext({
    card,
    worldbook: [{ keys: ['龙'], content: '龙住在山顶。', comment: '龙' }],
    history: [{ name: 'u', is_user: true, mes: '你好' }],
    userMessage: '说说那只龙',
  });
  assert.match(result.messages[0].content, /龙住在山顶/);
  assert.equal(result.worldbookUsed.length, 1);
});

test('扫描深度只看最近 N 条（默认 4）', () => {
  /*
   * 拿整段历史去扫会让早期提过一次的名字一直激活条目，
   * 结果越聊上下文越大、越聊越跑偏。
   */
  const history = [
    { name: 'u', is_user: true, mes: '龙' },
    ...Array.from({ length: 10 }, (_, i) => ({ name: 'u', is_user: true, mes: `闲话${i}` })),
  ];
  const result = assembleContext({
    card,
    worldbook: [{ keys: ['龙'], content: '龙住在山顶。', comment: '龙' }],
    history,
  });
  // 「龙」在最早期，超出默认深度 → 不激活
  assert.equal(result.worldbookUsed.length, 0);
  assert.equal(DEFAULT_SCAN_DEPTH, 4);
});

test('人设进 system 而不是伪装成 user 消息', () => {
  /*
   * 伪装成 user 会让模型的"谁在说话"混淆 ——
   * 表现为偶尔用人设的口吻去回复用户。
   */
  const result = assembleContext({
    card,
    history: [],
    persona: { name: '旅人', description: '一个话很少的旅人。' },
  });
  const personaMessage = result.messages.find((m) => m.content.includes('话很少的旅人'));
  assert.equal(personaMessage.role, 'system');
  assert.equal(result.personaUsed, true);
});

test('没有正文的历史不会生出空气泡', () => {
  const result = assembleContext({
    card,
    history: [{ name: 'u', is_user: true, mes: '' }],
  });
  assert.equal(result.messages.filter((m) => m.content === '').length, 0);
});

test('gaps 如实列出没做的部分（沉默的缺失最贵）', () => {
  const result = assembleContext({ card, history: [] });
  assert.ok(result.gaps.length > 0);
  assert.equal(result.gaps, CONTEXT_GAPS);
  assert.ok(result.gaps.some((gap) => gap.includes('递归扫描')));
});

/* ───────────── 继续 / 重新生成 ───────────── */

test('★ 「继续」把最后一条 assistant 当 prefill，并从历史里摘掉', () => {
  /*
   * 不摘掉的话它会既在历史里、又当 prefill，
   * 模型看到重复开头会立刻重复输出。
   */
  const result = buildContinueInput({
    card,
    history: [
      { name: 'u', is_user: true, mes: '讲个故事' },
      { name: '西奥', is_user: false, mes: '从前有座山，' },
    ],
  });
  assert.equal(result.prefill, '从前有座山，');
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].mes, '讲个故事');
});

test('没有 assistant 消息时 prefill 为空且历史不动', () => {
  const result = buildContinueInput({
    card,
    history: [{ name: 'u', is_user: true, mes: '在吗' }],
  });
  assert.equal(result.prefill, '');
  assert.equal(result.history.length, 1);
});
