/**
 * ST「提示词管理器」解析 + 拼装的判据（2026-11-03）。
 *
 * ## 这组守的是什么
 *
 * 用户会用 ST 网页调好一整套提示词（几十条、混用 system/user、
 * 有的按顺序、有的按深度插进历史），然后指望在 App 里得到同样效果。
 *
 * 失败方式全是**静默的**：
 *   · 顺序表选错 ⇒ 一条提示词都不生效，界面看起来完全正常
 *   · role 读错 ⇒ 本该是 user 的指令当成 system，模型行为变样
 *   · 深度算错 ⇒ 插到错误位置，越界还会插出上下文
 *
 * 所以判据要钉的是**顺序、role、位置**这三样，而不是"有没有内容"。
 *
 * ## ★★★ 关于测试样本
 *
 * 用用户提供的真实预设（`38 项 / 27 条自定义`）当样本，但只在测试里**读**它，
 * 没有任何一句正文被写进产品代码。用户明令：「这个地方就是留给用户自定义的」。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parsePromptConfig } from '../shared/dist/chat/prompt-config.js';
import { assembleWithPrompts } from '../shared/dist/chat/prompt-assemble.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/** 空的卡（拼装需要它，但大多数判据不关心卡字段） */
function makeCard(overrides = {}) {
  return {
    name: '测试角色',
    description: '角色的描述',
    personality: '角色性格',
    scenario: '场景描述',
    first_mes: '',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '',
    extensions: {},
    ...overrides,
  };
}

/* ═══════════════════════════════════════════════════════════
   一、解析：顺序表的选取（最贵的失败点）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 顺序表的 character_id 不是 100000 时，只有一条也要用它', () => {
  /*
   * ## 这是最贵的一个坑
   *
   * ST 的全局策略用 `character_id === 100000` 那条。但用户从**别人的环境**
   * 导出的预设，`character_id` 往往是对方环境的 id（实测样本是 **100001**）。
   *
   * 若严格按 100000 找 ⇒ 整份配置被判成"没有顺序"⇒
   * **用户几十条自己调的提示词一条都不生效**，而界面上看起来一切正常。
   */
  const config = parsePromptConfig({
    prompts: [
      { identifier: 'a', name: '甲', content: '内容甲', role: 'system' },
      { identifier: 'b', name: '乙', content: '内容乙', role: 'user' },
    ],
    prompt_order: [
      { character_id: 100001, order: [{ identifier: 'a', enabled: true }, { identifier: 'b', enabled: true }] },
    ],
  });

  assert.equal(config.orderSource, 'only-one', '只有一条 order 时就用它');
  assert.deepEqual(config.order?.map((one) => one.identifier), ['a', 'b']);
});

test('★★ 多条 order 且没有 100000 时不许乱猜（返回 null 让调用方回退）', () => {
  /*
   * 猜错比不猜更糟：用户的提示词会以**错误的顺序**发出去，
   * 表现为"提示词生效了但效果不对"，比完全不生效更难查。
   */
  const config = parsePromptConfig({
    prompts: [{ identifier: 'a', name: '甲', content: '内容', role: 'system' }],
    prompt_order: [
      { character_id: 200001, order: [{ identifier: 'a', enabled: true }] },
      { character_id: 200002, order: [{ identifier: 'a', enabled: true }] },
    ],
  });
  assert.equal(config.order, null);
  assert.equal(config.orderSource, 'none');
});

test('★ 当前角色卡 id 精确匹配时优先用它', () => {
  const config = parsePromptConfig(
    {
      prompts: [{ identifier: 'a', name: '甲', content: '内容', role: 'system' }],
      prompt_order: [
        { character_id: 100000, order: [{ identifier: 'a', enabled: true }] },
        { character_id: 777, order: [{ identifier: 'a', enabled: false }] },
      ],
    },
    { characterId: 777 },
  );
  assert.equal(config.orderSource, 'character');
  assert.equal(config.order?.[0]?.enabled, false, '要取匹配当前卡的那条');
});

test('★ 100000 存在时用它（ST 的全局默认）', () => {
  const config = parsePromptConfig({
    prompts: [{ identifier: 'a', name: '甲', content: '内容', role: 'system' }],
    prompt_order: [
      { character_id: 300001, order: [{ identifier: 'a', enabled: false }] },
      { character_id: 100000, order: [{ identifier: 'a', enabled: true }] },
    ],
  });
  assert.equal(config.orderSource, 'global');
});

test('★★ 顺序表引用了不存在的提示词时要告诉用户', () => {
  /*
   * 静默跳过是这里最不该有的行为：用户看到"顺序里有 30 项"
   * 而实际发出 25 项，会以为是模型不听话。
   */
  const config = parsePromptConfig({
    prompts: [{ identifier: 'a', name: '甲', content: '内容', role: 'system' }],
    prompt_order: [
      {
        character_id: 100000,
        order: [
          { identifier: 'a', enabled: true },
          { identifier: 'ghost-1', enabled: true },
          { identifier: 'ghost-2', enabled: true },
        ],
      },
    ],
  });
  assert.equal(config.warnings.length, 1);
  assert.match(config.warnings[0], /2 项/);
});

test('★ prompts 是 JSON 字符串时也要能解析（真机就是这样）', () => {
  /*
   * 本项目 §87.3 踩过：`openai_settings[i]` 每项是 **JSON 字符串**。
   * 只吃对象的话，真机上一条都读不到，而单测喂对象会全绿。
   */
  const config = parsePromptConfig(JSON.stringify({
    prompts: JSON.stringify([{ identifier: 'a', name: '甲', content: '内容', role: 'user' }]),
    prompt_order: JSON.stringify([{ character_id: 100000, order: [{ identifier: 'a', enabled: true }] }]),
  }));

  assert.equal(config.prompts.length, 1);
  assert.equal(config.prompts[0].role, 'user');
  assert.equal(config.order?.length, 1);
});

test('★ 没有 prompts 时返回空配置而不抛异常', () => {
  /*
   * 采样参数预设里没有 prompts。这时必须能安全返回，
   * 由调用方回退到旧拼装 —— 没有提示词配置时聊天得照常能用。
   */
  const config = parsePromptConfig({ temperature: 1 });
  assert.deepEqual(config.prompts, []);
  assert.equal(config.order, null);
  assert.equal(config.orderSource, 'none');
});

/* ═══════════════════════════════════════════════════════════
   二、拼装：顺序、role、内容来源
   ═══════════════════════════════════════════════════════════ */

test('★★★ 按 prompt_order 的顺序拼，且 role 照配置走', () => {
  /*
   * 旧实现把描述/性格/场景全塞进一条 system、顺序写死。
   * 现在每条独立、role 由配置决定 —— 这是"像不像那个角色"的关键。
   */
  const config = parsePromptConfig({
    prompts: [
      { identifier: 'u1', name: '用户指令', content: '第一条', role: 'user' },
      { identifier: 's1', name: '系统指令', content: '第二条', role: 'system' },
      { identifier: 'a1', name: '助手指令', content: '第三条', role: 'assistant' },
    ],
    prompt_order: [
      {
        character_id: 100000,
        order: [
          { identifier: 'u1', enabled: true },
          { identifier: 's1', enabled: true },
          { identifier: 'a1', enabled: true },
        ],
      },
    ],
  });

  const result = assembleWithPrompts({ card: makeCard(), history: [], config });

  assert.deepEqual(result.messages, [
    { role: 'user', content: '第一条' },
    { role: 'system', content: '第二条' },
    { role: 'assistant', content: '第三条' },
  ]);
  assert.equal(result.report.applied, 3);
});

test('★★ 禁用的项不发，且计入 skippedDisabled', () => {
  const config = parsePromptConfig({
    prompts: [
      { identifier: 'on', name: '开', content: '要发', role: 'system' },
      { identifier: 'off', name: '关', content: '不要发', role: 'system' },
    ],
    prompt_order: [
      {
        character_id: 100000,
        order: [
          { identifier: 'on', enabled: true },
          { identifier: 'off', enabled: false },
        ],
      },
    ],
  });

  const result = assembleWithPrompts({ card: makeCard(), history: [], config });
  assert.deepEqual(result.messages.map((m) => m.content), ['要发']);
  assert.equal(result.report.skippedDisabled, 1);
});

test('★★ 内容为空的项要跳过（空消息浪费 token，还可能让上游 400）', () => {
  const config = parsePromptConfig({
    prompts: [{ identifier: 'empty', name: '空', content: '   ', role: 'system' }],
    prompt_order: [{ character_id: 100000, order: [{ identifier: 'empty', enabled: true }] }],
  });

  const result = assembleWithPrompts({ card: makeCard(), history: [], config });
  assert.deepEqual(result.messages, []);
  assert.equal(result.report.skippedEmpty, 1);
});

test('★★ 标记位的内容从卡片来，不是从配置的 content 来', () => {
  /*
   * `charDescription` 这条在配置里的 `content` 是空串（它是标记位），
   * 真正的内容必须从**卡片**取。若误用 content，角色描述整段丢失 ——
   * 而 prompt_order 里明明有它，排查时很难想到"取错来源"。
   */
  const config = parsePromptConfig({
    prompts: [{ identifier: 'charDescription', name: 'Char Description', content: '', marker: true, system_prompt: true }],
    prompt_order: [{ character_id: 100000, order: [{ identifier: 'charDescription', enabled: true }] }],
  });

  const result = assembleWithPrompts({
    card: makeCard({ description: '这是卡里的描述' }),
    history: [],
    config,
  });

  assert.deepEqual(result.messages, [{ role: 'system', content: '这是卡里的描述' }]);
});

test('★★ 世界书按 position 拆 before / after（旧实现合并成一段）', () => {
  /*
   * ST 里条目有 `position` 字段（`before_char` / `after_char`），
   * 分别落在 World Info (before) 与 (after) 两个槽位。
   * 合并成一段会让"放在角色设定之后"的条目失去位置意义。
   */
  const config = parsePromptConfig({
    prompts: [
      { identifier: 'worldInfoBefore', name: 'Lorebook Before', content: '', marker: true, system_prompt: true },
      { identifier: 'worldInfoAfter', name: 'Lorebook After', content: '', marker: true, system_prompt: true },
    ],
    prompt_order: [
      {
        character_id: 100000,
        order: [
          { identifier: 'worldInfoBefore', enabled: true },
          { identifier: 'worldInfoAfter', enabled: true },
        ],
      },
    ],
  });

  const result = assembleWithPrompts({
    card: makeCard(),
    history: [],
    config,
    worldbook: [
      { keys: ['苹果'], content: '苹果设定', position: 'before_char', enabled: true },
      { keys: ['苹果'], content: '苹果后续', position: 'after_char', enabled: true },
    ],
    userMessage: '苹果',
  });

  const texts = result.messages.map((m) => m.content);
  assert.ok(texts.includes('苹果设定'), 'before 条目要进 before 槽');
  assert.ok(texts.includes('苹果后续'), 'after 条目要进 after 槽');
  assert.equal(texts.indexOf('苹果设定') < texts.indexOf('苹果后续'), true, 'before 要在 after 之前');
});

test('★ 对话示例用用户的分隔提示，不给内置措辞（零内容硬编码）', () => {
  /*
   * 用户明令：「不要写死」「这个地方就是留给用户自定义的」。
   * 所以没有分隔提示时**不加任何前缀**，而不是塞一句我们编的中文。
   */
  const config = parsePromptConfig({
    prompts: [{ identifier: 'dialogueExamples', name: 'Chat Examples', content: '', marker: true, system_prompt: true }],
    prompt_order: [{ character_id: 100000, order: [{ identifier: 'dialogueExamples', enabled: true }] }],
  });
  const card = makeCard({ mes_example: '<START>\n{{user}}: 你好\n{{char}}: 你好呀' });

  /* 无分隔提示 ⇒ 原样，无前缀 */
  const plain = assembleWithPrompts({ card, history: [], config });
  assert.equal(plain.messages.length, 1);
  assert.equal(plain.messages[0].content.startsWith('测试角色'.repeat(0)), true);
  assert.match(plain.messages[0].content, /^<START>/, '没有分隔提示时不许加前缀');

  /* 有分隔提示 ⇒ 用用户的 */
  const withSep = assembleWithPrompts({ card, history: [], config, newExampleChatPrompt: '【用户自定义分隔】' });
  assert.match(withSep.messages[0].content, /^【用户自定义分隔】/);
});

test('★★ 宏只替换 char / user', () => {
  const config = parsePromptConfig({
    prompts: [{ identifier: 'p', name: 'P', content: '{{char}} 对 {{user}} 说', role: 'system' }],
    prompt_order: [{ character_id: 100000, order: [{ identifier: 'p', enabled: true }] }],
  });

  const result = assembleWithPrompts({
    card: makeCard({ name: '小明' }),
    history: [],
    persona: { name: '老王' },
    config,
  });

  assert.equal(result.messages[0].content, '小明 对 老王 说');
});

test('★ 历史展开成多条消息，且顺序不变', () => {
  const config = parsePromptConfig({
    prompts: [{ identifier: 'chatHistory', name: 'Chat History', content: '', marker: true, system_prompt: true }],
    prompt_order: [{ character_id: 100000, order: [{ identifier: 'chatHistory', enabled: true }] }],
  });

  const result = assembleWithPrompts({
    card: makeCard(),
    history: [
      { is_user: true, mes: '第一句' },
      { is_user: false, mes: '第二句' },
    ],
    config,
  });

  assert.deepEqual(result.messages, [
    { role: 'user', content: '第一句' },
    { role: 'assistant', content: '第二句' },
  ]);
});

test('★★★ 深度注入：injection_position=1 的不走顺序，按 depth 插进历史', () => {
  /*
   * 这是 ST 里"把指令插到对话中间"的能力。若当成普通项按顺序发，
   * 它会跑到最前面 —— 模型对开头和结尾最敏感，放错位置等于没设。
   *
   * depth=0 表示**最后一条之前**（最靠近当前输入）。
   */
  const config = parsePromptConfig({
    prompts: [
      { identifier: 'chatHistory', name: 'Chat History', content: '', marker: true, system_prompt: true },
      {
        identifier: 'deep',
        name: '深度指令',
        content: '深度指令内容',
        role: 'system',
        injection_position: 1,
        injection_depth: 0,
      },
    ],
    prompt_order: [
      {
        character_id: 100000,
        order: [
          { identifier: 'chatHistory', enabled: true },
          { identifier: 'deep', enabled: true },
        ],
      },
    ],
  });

  const result = assembleWithPrompts({
    card: makeCard(),
    history: [
      { is_user: true, mes: '旧问题' },
      { is_user: false, mes: '旧回答' },
    ],
    config,
    userMessage: '新问题',
  });

  const contents = result.messages.map((m) => m.content);
  assert.equal(result.report.depthInjected, 1);
  assert.ok(
    contents.indexOf('深度指令内容') > contents.indexOf('旧回答'),
    'depth=0 要插在历史之后',
  );
  assert.equal(contents[contents.length - 1], '新问题', '用户输入永远最后');
});

test('★★ 深度注入不会因为历史太短而越界', () => {
  /*
   * `injection_depth` 可能远大于历史长度（用户从别处导入的配置里常有 depth=4，
   * 而新聊天只有 1 条历史）。算错下标会插到数组外，或负下标把消息弄丢。
   */
  const config = parsePromptConfig({
    prompts: [
      { identifier: 'chatHistory', name: 'Chat History', content: '', marker: true, system_prompt: true },
      { identifier: 'deep', name: '深', content: '深指令', role: 'system', injection_position: 1, injection_depth: 4 },
    ],
    prompt_order: [
      {
        character_id: 100000,
        order: [
          { identifier: 'chatHistory', enabled: true },
          { identifier: 'deep', enabled: true },
        ],
      },
    ],
  });

  const result = assembleWithPrompts({
    card: makeCard(),
    history: [{ is_user: true, mes: '唯一一条' }],
    config,
  });

  assert.ok(result.messages.length >= 2, '注入后消息不该变少');
  assert.ok(
    result.messages.every((m) => typeof m.content === 'string' && m.content !== ''),
    '不许出现空消息',
  );
});

test('★★ 没有顺序表时用 prompts 数组本身的顺序（不是什么都不发）', () => {
  const config = parsePromptConfig({
    prompts: [
      { identifier: 'a', name: '甲', content: '内容甲', role: 'system' },
      { identifier: 'b', name: '乙', content: '内容乙', role: 'system' },
    ],
  });
  assert.equal(config.order, null);

  const result = assembleWithPrompts({ card: makeCard(), history: [], config });
  assert.deepEqual(result.messages.map((m) => m.content), ['内容甲', '内容乙']);
});

/* ═══════════════════════════════════════════════════════════
   三、真实样本（用户提供，只读，不进产品代码）
   ═══════════════════════════════════════════════════════════ */

const SAMPLE = join(REPO, 'test', 'fixtures', 'st-preset-sample.json');

test('★★★ 真实样本（38 项 / 27 条自定义）能完整拼出来', () => {
  /*
   * 这份样本是用户从别的电脑导入的真实预设。它有三个"刁钻"的地方：
   *
   *   1. `prompt_order[0].character_id = 100001`（不是 100000）—— 走 only-one 兜底
   *   2. 27 条用户自定义项，`role` 混用 system / user
   *   3. 部分项 `enabled: false`（三选一规则里没选中的那些）
   *
   * 用它当样本是为了证明**真实配置能吃下来**，而不是只吃我们自己造的规整数据。
   */
  const raw = JSON.parse(readFileSync(SAMPLE, 'utf8'));
  const config = parsePromptConfig(raw);

  assert.equal(config.orderSource, 'only-one', 'character_id=100001 要走 only-one');
  assert.equal(config.prompts.length, 38);
  assert.equal(config.order?.length, 38);
  assert.deepEqual(config.warnings, [], '这份样本不该有缺引用的警告');

  /*
   * 38 项里 29 项启用、9 项禁用。
   *
   * ★ 第一版我凭"三选一"猜成 32/6，跑出来才发现数错了。
   * 这不是"约等于就行"的数字：它同时校验了
   * `enabled` 的读取方向（读反了会得到 9）与顺序表的完整性。
   */
  const enabledCount = config.order.filter((one) => one.enabled).length;
  assert.equal(enabledCount, 29, `启用项个数变了（实际 ${String(enabledCount)}）`);

  const result = assembleWithPrompts({
    card: makeCard({ description: '卡描述', personality: '卡性格', scenario: '卡场景' }),
    history: [
      { is_user: true, mes: '历史问题' },
      { is_user: false, mes: '历史回答' },
    ],
    persona: { name: '我', description: '我的人设' },
    config,
    userMessage: '本次问题',
  });

  /* 至少要发出几十条（32 个启用项里有空内容的会跳过） */
  assert.ok(result.messages.length >= 20, `消息数太少：${String(result.messages.length)}`);
  assert.equal(result.report.skippedDisabled, 9, '应有 9 项被禁用');

  /* role 必须混用 —— 全是 system 说明 role 读丢了 */
  const roles = new Set(result.messages.map((m) => m.role));
  assert.ok(roles.has('user'), '样本里有 role=user 的项，拼出来必须有 user');
  assert.ok(roles.has('system'), '也必须有 system');

  /* 最后一条永远是本次用户输入 */
  assert.equal(result.messages[result.messages.length - 1].content, '本次问题');
});

test('★★★ 样本里的自定义提示词内容必须原样出现（不许被改写/丢字段）', () => {
  /*
   * 用户的提示词是他调教出来的成果。任何一个字被改写、
   * 或者某条被静默丢掉，效果都会变 —— 而他无从归因。
   *
   * 这里从样本里取**全部启用项**的内容，逐条断言它在输出里出现过。
   */
  const raw = JSON.parse(readFileSync(SAMPLE, 'utf8'));
  const config = parsePromptConfig(raw);
  const enabledIds = new Set(config.order.filter((one) => one.enabled).map((one) => one.identifier));

  const result = assembleWithPrompts({
    card: makeCard(),
    history: [],
    config,
  });

  const joined = result.messages.map((m) => m.content).join('\n');

  /*
   * ★ 比对前必须**先做同样的宏替换**。
   *
   * 第一版直接拿样本原文当前缀去搜，结果「防角色全知」等 6 条全部"缺失" ——
   * 因为它们的正文里有 `{{user}}`，拼装时被替换成了具体名字，
   * 前 40 字自然对不上。
   *
   * 那次失败是**断言错**、不是代码错。这类"看起来抓到大缺陷"的假红
   * 比假绿更危险：会让我去改本来正确的代码。
   */
  const charName = '测试角色';
  const userName = 'User';
  const applyMacros = (text) => text.split('{{char}}').join(charName).split('{{user}}').join(userName);

  const missing = [];
  for (const prompt of config.prompts) {
    if (!enabledIds.has(prompt.identifier)) continue;
    if (prompt.marker === true) continue; // 标记位内容来自卡片，不在样本里
    const content = applyMacros(prompt.content.trim());
    if (content === '') continue;
    /* 长文本取前 40 字即可区分不同条目，也避免断言消息过长 */
    const probe = content.slice(0, 40);
    if (!joined.includes(probe)) missing.push(prompt.name);
  }

  assert.deepEqual(missing, [], `这些提示词的内容没出现在拼装结果里：${missing.join('、')}`);
});

/* ═══════════════════════════════════════════════════════════
   四、零内容硬编码（用户两次明令）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 产品代码里不许出现任何用户提示词正文', () => {
  /*
   * 用户原话两次：
   *
   * > 不要写死这个防角色全知……因为我这个东西是用户自己导入的，
   * > 要的就是开放性，让用户自己去调教
   *
   * 这条判据的做法：把样本里**每一条提示词的正文片段**拿去搜产品源码，
   * 一条都不许命中。
   *
   * 为什么必须自动化：我完全可能在"给个默认值方便测试"的念头下
   * 把某一条抄进代码，而那种改动看起来无害、review 时极容易放过去。
   */
  const raw = JSON.parse(readFileSync(SAMPLE, 'utf8'));
  const files = [
    join(REPO, 'shared', 'src', 'chat', 'prompt-config.ts'),
    join(REPO, 'shared', 'src', 'chat', 'prompt-assemble.ts'),
  ];

  /* 只取足够长的片段，避免"的""了"这种字误伤 */
  const probes = [];
  for (const prompt of raw.prompts) {
    const content = String(prompt.content ?? '').trim();
    if (content.length < 24) continue;
    probes.push(content.slice(0, 24));
  }
  assert.ok(probes.length > 10, `样本里可用的探针太少（${String(probes.length)}）`);

  const hits = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const probe of probes) {
      if (source.includes(probe)) hits.push(`${file.split(/[\\/]/).pop()}: ${probe}`);
    }
  }

  assert.deepEqual(hits, [], `产品代码里出现了用户的提示词正文：\n  ${hits.join('\n  ')}`);
});

test('★ 提示词正文里也不许出现"内置默认提示词"这类兜底', () => {
  /*
   * 另一种违反方式：给某个槽位塞一句"我们的默认措辞"。
   * 判据：`prompt-assemble.ts` 里不许出现成句的中文正文
   * （注释除外 —— 所以先剥注释）。
   */
  const source = readFileSync(join(REPO, 'shared', 'src', 'chat', 'prompt-assemble.ts'), 'utf8');
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  /*
   * 只看代码行里的中文（注释已剥掉）。
   * 允许出现的：报错文案、`gaps` 里的说明。
   * 所以只检查 `content` 相关的赋值与 `return '...'` 形态。
   */
  const suspicious = [];
  for (const line of codeOnly.split('\n')) {
    const trimmed = line.trim();
    if (!/content\s*[:=]|textContent|return\s+'/.test(trimmed)) continue;
    if (/\/[\u4e00-\u9fa5]/.test(trimmed)) {
      /* 形如 return '中文' */
      suspicious.push(trimmed);
    }
  }
  assert.deepEqual(suspicious, [], `代码里疑似硬编码了中文正文：\n  ${suspicious.join('\n  ')}`);
});
