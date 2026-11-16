/**
 * 角色级提示词覆盖的判据（2026-11-15，v0.2.0 主功能）。
 *
 * 六条性质，每一条都对应一个"不这么做就会出错"的具体后果：
 *
 * ```text
 * ① 空覆盖必须**原样返回**       —— 零迁移成本的唯一技术保证
 * ② override 只改与全局不同的项   —— 否则"本角色已改"标记全线误报
 * ③ 标记位只允许开关，不许改正文   —— 内容来自卡与时序，覆盖会让两个真相打架
 * ④ 写入 extensions 必须深合并    —— 整块替换会删掉 depth_prompt / world /
 *                                    tcs.cardId，V2 规范 MUST NOT
 * ⑤ 超限拒绝保存并带具体数字      —— 截断的 JSON 之后会在更莫名的地方炸
 * ⑥ 「恢复默认」后行为回到全局    —— 否则用户会发现"怎么改都变回去"
 * ```
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyCharacterPrompts,
  clearOverride,
  effectiveContent,
  effectiveEnabled,
  emptyCharacterPrompts,
  hasOverride,
  isCharacterPromptsEmpty,
  nextOwnPromptId,
  ownIdentifierOf,
  parseCharacterPrompts,
  PROMPT_LIMITS,
  removeOwnPrompt,
  setCharacterPromptContent,
  setCharacterPromptEnabled,
  upsertOwnPrompt,
  validateCharacterPrompts,
  writeCharacterPrompts,
} from '../shared/dist/chat/character-prompts.js';

/** 造一份最小的全局配置（形状与 `parsePromptConfig` 的产物一致） */
function globalConfig() {
  return {
    prompts: [
      {
        identifier: 'main',
        name: 'Main Prompt',
        content: 'Write {{char}} reply.',
        role: 'system',
        systemPrompt: true,
        marker: false,
        injectionPosition: 0,
        injectionDepth: 0,
        injectionOrder: 100,
      },
      {
        identifier: 'charDescription',
        name: 'Char Description',
        content: '',
        role: 'system',
        systemPrompt: true,
        marker: true,
        injectionPosition: 0,
        injectionDepth: 0,
        injectionOrder: 100,
      },
      {
        identifier: 'jailbreak',
        name: 'Jailbreak',
        content: 'Be brief.',
        role: 'system',
        systemPrompt: true,
        marker: false,
        injectionPosition: 0,
        injectionDepth: 0,
        injectionOrder: 100,
      },
    ],
    order: [
      { identifier: 'main', enabled: true },
      { identifier: 'charDescription', enabled: true },
      { identifier: 'jailbreak', enabled: true },
    ],
    orderSource: 'global',
    warnings: [],
  };
}

/* ═══════════════════════════════════════════════════════════
   ① 空覆盖原样返回（零迁移成本）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 空覆盖必须原样返回 —— 用户的 8 个角色一个都没配时行为不能变', () => {
  /*
   * 这是"零迁移成本"的**唯一技术保证**：没配过提示词的用户，
   * 升级后输出必须与升级前逐字段相同。
   *
   * 如果这里返回了一个"看起来一样"的新对象，判据就得退化成深比较 ——
   * 而深比较抓不到"数组顺序变了但内容相同"这类微妙差异（顺序恰恰是
   * 提示词的语义之一）。所以要求**引用相等**。
   */
  const config = globalConfig();

  assert.equal(applyCharacterPrompts(config, null), config, 'null ⇒ 原样返回');
  assert.equal(applyCharacterPrompts(config, emptyCharacterPrompts()), config, '空配置 ⇒ 原样返回');

  assert.equal(isCharacterPromptsEmpty(null), true);
  assert.equal(isCharacterPromptsEmpty(emptyCharacterPrompts()), true);
  assert.equal(
    isCharacterPromptsEmpty({ version: 1, overrideOrder: { main: { enabled: false } }, own: [] }),
    false,
    '只要有一项覆盖就不算空',
  );
});

/* ═══════════════════════════════════════════════════════════
   ② override 语义
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 覆盖开关与正文，且不改入参', () => {
  const config = globalConfig();
  let overlay = emptyCharacterPrompts();

  overlay = setCharacterPromptEnabled(overlay, 'jailbreak', false, true);
  const applied = applyCharacterPrompts(config, overlay);

  assert.equal(
    applied.order?.find((one) => one.identifier === 'jailbreak')?.enabled,
    false,
    '角色级关掉 jailbreak',
  );
  /* 其余条目不受影响 */
  assert.equal(applied.order?.find((one) => one.identifier === 'main')?.enabled, true);
  /* 入参没被改 */
  assert.equal(config.order[2].enabled, true, '不许改入参（applyCharacterPrompts 是纯函数）');
});

test('★★★★★ 与全局值相同就删掉这一项（否则"已改"标记全线误报）', () => {
  /*
   * 用户在角色 A 里把某条开关点了两次（关→开），如果每次都留一项
   * `{enabled: true}`，那 `overrideOrder` 里会攒下一堆"与全局相同"的条目，
   * 界面上每条都会显示「本角色已改」—— 用户根本分不清哪些真的改过。
   */
  let overlay = emptyCharacterPrompts();
  overlay = setCharacterPromptEnabled(overlay, 'main', false, true);
  assert.ok(overlay.overrideOrder['main'], '先关掉');

  overlay = setCharacterPromptEnabled(overlay, 'main', true, true);
  assert.equal(overlay.overrideOrder['main'], undefined, '改回与全局相同 ⇒ 该项消失');
  assert.equal(isCharacterPromptsEmpty(overlay), true);
});

test('★★★★★ 正文覆盖：与全局相同就删，不同就存', () => {
  let overlay = emptyCharacterPrompts();
  const r1 = setCharacterPromptContent(overlay, 'main', '新正文', '旧正文', false);
  assert.equal(r1.ok, true);
  overlay = r1.config;
  assert.equal(overlay.overrideOrder['main']?.content, '新正文');

  const r2 = setCharacterPromptContent(overlay, 'main', '旧正文', '旧正文', false);
  assert.equal(r2.ok, true);
  assert.equal(r2.config.overrideOrder['main'], undefined, '改回全局原文 ⇒ 覆盖消失');
});

test('★★★★★ 标记位不许改正文 —— 要**拒绝**，不是静默忽略', () => {
  /*
   * 静默忽略的表现是「我改了、保存了、但发出去的还是原来那段」，
   * 用户会认为整个功能是坏的。而"拒绝 + 说明原因"能让他立刻理解。
   */
  const r = setCharacterPromptContent(emptyCharacterPrompts(), 'charDescription', '想改', '', true);
  assert.equal(r.ok, false);
  assert.match(r.reason, /不能在这里改/, '要说清为什么不许改');

  /* 但开关是允许的 */
  const enabled = setCharacterPromptEnabled(emptyCharacterPrompts(), 'charDescription', false, true);
  assert.equal(enabled.overrideOrder['charDescription']?.enabled, false);
});

test('★★★★ 脏数据里的标记位 content 不会生效（防御，不报错）', () => {
  /*
   * 别的工具（或手工改过的 PNG）可能在 `overrideOrder` 里给标记位写了 content。
   * 那不该让渲染出问题 —— 按 ST 的"不认识就忽略"处理。
   */
  const overlay = {
    version: 1,
    overrideOrder: { charDescription: { content: '脏数据' } },
    own: [],
  };
  const applied = applyCharacterPrompts(globalConfig(), overlay);
  const desc = applied.prompts.find((one) => one.identifier === 'charDescription');
  assert.equal(desc?.content, '', '标记位的 content 不许被覆盖');
});

/* ═══════════════════════════════════════════════════════════
   ③ own 项
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 角色特有提示词要追加进 prompts 与 order', () => {
  const overlay = upsertOwnPrompt(emptyCharacterPrompts(), {
    id: 'tcs-1',
    name: '说话简短',
    content: '每次回复不超过三句。',
    role: 'system',
    enabled: true,
  });

  const applied = applyCharacterPrompts(globalConfig(), overlay);

  const added = applied.prompts.find((one) => one.identifier === 'tcs-1');
  assert.ok(added !== undefined, '要进 prompts');
  assert.equal(added.marker, false, '自建项不是标记位');
  assert.equal(added.systemPrompt, false, '与 ST 的 Prompt 构造器一致');
  assert.equal(added.content, '每次回复不超过三句。');

  /* 必须在 order 里 —— 不在顺序表里的项不会发送（这是 ST 的语义） */
  assert.equal(
    applied.order?.find((one) => one.identifier === 'tcs-1')?.enabled,
    true,
    '要进 order，否则永远不发',
  );
});

test('★★★★ 自建项默认启用，但可以关掉', () => {
  const on = upsertOwnPrompt(emptyCharacterPrompts(), {
    id: 'tcs-1', name: 'A', content: 'x', role: 'system', enabled: true,
  });
  const off = upsertOwnPrompt(emptyCharacterPrompts(), {
    id: 'tcs-1', name: 'A', content: 'x', role: 'system', enabled: false,
  });

  assert.equal(
    applyCharacterPrompts(globalConfig(), on).order?.at(-1)?.enabled,
    true,
  );
  assert.equal(
    applyCharacterPrompts(globalConfig(), off).order?.at(-1)?.enabled,
    false,
    '卡作者可以表达"导入后默认关"',
  );
});

test('★★★★ id 前缀要补齐（`1` → `tcs-1`），撞名要跳过', () => {
  assert.equal(ownIdentifierOf({ id: '1', name: '', content: 'x', role: 'system', enabled: true }), 'tcs-1');
  assert.equal(ownIdentifierOf({ id: 'tcs-9', name: '', content: 'x', role: 'system', enabled: true }), 'tcs-9');

  /* 与全局 identifier 撞名时不覆盖、不丢 —— 跳过那一项 */
  const overlay = {
    version: 1,
    overrideOrder: {},
    own: [
      { id: 'main', name: '撞名', content: '不该覆盖 main', role: 'system', enabled: true },
    ],
  };
  const applied = applyCharacterPrompts(globalConfig(), overlay);
  const main = applied.prompts.filter((one) => one.identifier === 'main');
  assert.equal(main.length, 1, '不许出现两条 main');
  assert.equal(main[0].content, 'Write {{char}} reply.', '原来的 main 不许被顶掉');
});

test('★★★★ nextOwnPromptId 要取未占用的最小正整数', () => {
  let overlay = emptyCharacterPrompts();
  assert.equal(nextOwnPromptId(overlay), 'tcs-1');
  overlay = upsertOwnPrompt(overlay, { id: 'tcs-1', name: '', content: 'x', role: 'system', enabled: true });
  assert.equal(nextOwnPromptId(overlay), 'tcs-2');
  overlay = upsertOwnPrompt(overlay, { id: 'tcs-3', name: '', content: 'x', role: 'system', enabled: true });
  assert.equal(nextOwnPromptId(overlay), 'tcs-2', '中间空出来的优先复用');
});

/* ═══════════════════════════════════════════════════════════
   ④ 写回 extensions 必须深合并
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 写回不许删掉别的工具的键（V2 规范 MUST NOT）', () => {
  /*
   * `extensions` 里可能还有：ST 的 `depth_prompt` / `world` / `fav`、
   * 我们自己的 `tcs.cardId`、别的工具的一堆命名空间。
   *
   * 整块替换 = 全部删掉。而 V2 规范对编辑器是 **MUST NOT destroy
   * unknown key-value pairs**。
   *
   * 本项目已有同源教训：`card-id.ts` 写 `tcs.cardId` 时踩过同一个坑。
   */
  const extensions = {
    depth_prompt: { prompt: 'ST 的角色注释', depth: 4, role: 'system' },
    world: '某世界书',
    fav: true,
    otherTool: { keep: 'me' },
    tcs: { cardId: 'Card-abc-001' },
  };

  const overlay = upsertOwnPrompt(emptyCharacterPrompts(), {
    id: 'tcs-1', name: '短', content: '简短。', role: 'system', enabled: true,
  });
  const written = writeCharacterPrompts(extensions, overlay);

  assert.deepEqual(written['depth_prompt'], extensions.depth_prompt, 'depth_prompt 要原样保留');
  assert.equal(written['world'], '某世界书');
  assert.equal(written['fav'], true);
  assert.deepEqual(written['otherTool'], { keep: 'me' });

  const tcs = written['tcs'];
  assert.equal(tcs['cardId'], 'Card-abc-001', 'tcs 里别的键也要保留');
  assert.ok(tcs['prompts'] !== undefined, '新配置要写进去');

  /* 入参没被改 */
  assert.equal((extensions['tcs'])['prompts'], undefined);
});

test('★★★★★ 空配置要删掉自己那个键，不留空壳', () => {
  /*
   * 用户点了「恢复默认」之后，卡里不该留 `{version:1, overrideOrder:{}, own:[]}`
   * —— 那会让人以为这个角色有配置。
   */
  const extensions = { tcs: { cardId: 'x', prompts: { version: 1, overrideOrder: {}, own: [{ id: 'a' }] } } };
  const written = writeCharacterPrompts(extensions, emptyCharacterPrompts());

  const tcs = written['tcs'];
  assert.equal(tcs['prompts'], undefined, 'prompts 键要删掉');
  assert.equal(tcs['cardId'], 'x', '但 tcs 里别的键保留');

  /* 连 tcs 都空了 ⇒ 整个删掉 */
  const only = writeCharacterPrompts({ tcs: { prompts: { version: 1, overrideOrder: {}, own: [] } } }, emptyCharacterPrompts());
  assert.equal(only['tcs'], undefined, 'tcs 空了就整个删掉');
});

test('★★★★ extensions 形状怪异时不许抛（导入的卡什么形状都可能有）', () => {
  const weird = [null, undefined, 'a string', 42, [], { tcs: 'not-an-object' }, { tcs: [] }];
  for (const value of weird) {
    const written = writeCharacterPrompts(value, emptyCharacterPrompts());
    assert.equal(typeof written, 'object', `${String(value)} 也要能处理`);
    assert.ok(!Array.isArray(written));
  }
});

/* ═══════════════════════════════════════════════════════════
   ⑤ 解析（从卡片读）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 解析：正常数据要读出来', () => {
  const config = parseCharacterPrompts({
    tcs: {
      cardId: 'x',
      prompts: {
        version: 1,
        overrideOrder: {
          main: { enabled: false, comment: '这个角色不需要系统提示' },
          jailbreak: { content: '换个越狱词' },
        },
        own: [
          { id: 'tcs-1', name: '简短', content: '三句以内。', role: 'assistant', enabled: false, comment: '作者备注' },
        ],
      },
    },
  });

  assert.ok(config !== null);
  assert.equal(config.overrideOrder['main']?.enabled, false);
  assert.equal(config.overrideOrder['main']?.comment, '这个角色不需要系统提示');
  assert.equal(config.overrideOrder['jailbreak']?.content, '换个越狱词');
  assert.equal(config.own.length, 1);
  assert.equal(config.own[0].role, 'assistant');
  assert.equal(config.own[0].enabled, false, '卡里写 false 要如实读出来（"默认关"是作者的意图）');
});

test('★★★★★ 解析：任何一层形状不对都当"没有"，不许猜', () => {
  /*
   * 卡片来自别人，`extensions` 里什么都可能有。猜错的后果是
   * "用户的提示词发到模型里去了" —— 比不生效更糟。
   */
  const cases = [
    null,
    undefined,
    'string',
    42,
    [],
    {},
    { tcs: null },
    { tcs: 'x' },
    { tcs: [] },
    { tcs: {} },
    { tcs: { prompts: null } },
    { tcs: { prompts: [] } },
    { tcs: { prompts: {} } },                       // 三层都空 ⇒ null
    { tcs: { prompts: { overrideOrder: {}, own: [] } } },  // 空配置 ⇒ null
  ];
  for (const value of cases) {
    assert.equal(parseCharacterPrompts(value), null, `${JSON.stringify(value)} 应解析为 null`);
  }
});

test('★★★★ 解析：没有 id 或没有正文的 own 项要跳过（垃圾数据）', () => {
  const config = parseCharacterPrompts({
    tcs: {
      prompts: {
        own: [
          { id: '', content: '没有 id' },
          { id: 'tcs-1', content: '   ' },
          { id: 'tcs-2', content: '有效' },
        ],
      },
    },
  });
  assert.equal(config?.own.length, 1, '只留有效那条');
  assert.equal(config?.own[0].id, 'tcs-2');
});

test('★★★★ own 缺省启用（卡作者写了这条就是要它生效）', () => {
  const config = parseCharacterPrompts({
    tcs: { prompts: { own: [{ id: 'tcs-1', content: 'x' }] } },
  });
  assert.equal(config?.own[0].enabled, true);
  assert.equal(config?.own[0].role, 'system', 'role 缺省 system');
});

/* ═══════════════════════════════════════════════════════════
   ⑥ 上限
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 超总量要给出**带具体数字**的错误，并点出最长那条', () => {
  /*
   * 「超出限制」这种话等于让用户自己找。要说到「合计 24,900 字符，
   * 超过总量上限 24,000」他才知道超了多少。
   *
   * ## ★ 2026-11-16 改：从"单条超限"改成"总量超限"
   *
   * 原来这条测的是 `contentPerPrompt: 4000`（单条上限）。用户指出
   * 20 条 × 4000 = 80,000 与总量 24,000 自相矛盾，那个额度永远用不到，
   * 所以单条上限已删掉。
   *
   * 但这条判据守的**性质**没变：**错误信息必须能让用户定位到该改哪里**。
   * 单条上限没了之后，超总量时如果只说"合计 24,900 超过 24,000"，
   * 用户仍然不知道删哪条 —— 所以补上"最长的一条是「X」（N 字符）"。
   */
  const long = 'x'.repeat(PROMPT_LIMITS.totalContent + 240);
  const overlay = {
    version: 1,
    overrideOrder: {},
    own: [{ id: 'tcs-3', name: '长的那条', content: long, role: 'system', enabled: true }],
  };
  const violations = validateCharacterPrompts(overlay);

  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'totalContent');
  assert.match(violations[0].message, new RegExp(String(long.length)), '错误信息里要有实际字符数');
  assert.match(violations[0].message, new RegExp(String(PROMPT_LIMITS.totalContent)), '也要有上限值');
  assert.match(violations[0].message, /长的那条/, '要点名最长的是哪一条（否则用户不知道删哪）');
});

test('★★★★★ 上限三个数必须自洽：条数 × 单条不该超过总量', () => {
  /*
   * 这条判据是**防止那个矛盾再回来**。
   *
   * 用户原话：「你这按条数来算的话每条上限就不对」。
   *
   * 当时的三个数：ownCount=20、contentPerPrompt=4000、totalContent=24000
   * ⇒ 20 × 4000 = 80,000 ≫ 24,000 ⇒ 写到第 7 条就超总量，
   *   界面上的「每条 4000」是句谎话。
   *
   * 现在没有 contentPerPrompt 了（总量天然限制单条）。这条判据钉两件事：
   * ```text
   * ① 不许再出现"每条上限"这类与总量打架的量
   * ② 总量必须 ≥ 一条合理的提示词（否则单条就写不下）
   * ```
   */
  assert.equal(
    'contentPerPrompt' in PROMPT_LIMITS,
    false,
    '不许再有单条上限 —— 它与「条数 × 总量」必然打架',
  );
  assert.ok(PROMPT_LIMITS.totalContent >= 4000, '总量至少要容得下一条正常长度的提示词');
  assert.ok(PROMPT_LIMITS.ownCount >= 1, '条数上限要 ≥ 1');
});

test('★★★★★ 条数、总量、name、comment 都要查', () => {
  const many = Array.from({ length: PROMPT_LIMITS.ownCount + 1 }, (_, i) => ({
    id: `tcs-${String(i + 1)}`,
    name: 'n',
    content: 'c',
    role: 'system',
    enabled: true,
  }));
  assert.equal(
    validateCharacterPrompts({ version: 1, overrideOrder: {}, own: many })[0].kind,
    'ownCount',
  );

  const heavy = Array.from({ length: 10 }, (_, i) => ({
    id: `tcs-${String(i + 1)}`,
    name: 'n',
    content: 'x'.repeat(3000),
    role: 'system',
    enabled: true,
  }));
  const kinds = validateCharacterPrompts({ version: 1, overrideOrder: {}, own: heavy }).map((one) => one.kind);
  assert.ok(kinds.includes('totalContent'), '10 × 3000 = 30000 > 24000');

  const longName = validateCharacterPrompts({
    version: 1,
    overrideOrder: {},
    own: [{ id: 'tcs-1', name: 'x'.repeat(60), content: 'c', role: 'system', enabled: true }],
  });
  assert.ok(longName.some((one) => one.kind === 'nameLength'));

  const longComment = validateCharacterPrompts({
    version: 1,
    overrideOrder: {},
    own: [{ id: 'tcs-1', name: 'n', content: 'c', role: 'system', enabled: true, comment: 'x'.repeat(600) }],
  });
  assert.ok(longComment.some((one) => one.kind === 'commentLength'));
});

test('★★★★ 覆盖项的正文也占总量额度（否则可以绕过上限）', () => {
  /*
   * 只能靠"覆盖"两个字的正文把总量顶爆 —— 如果不计入，用户可以把
   * 24000 字全塞进 overrideOrder 而不触发任何上限。
   *
   * ★ 2026-11-16：原来靠单条上限测（contentPerPrompt + 1），
   *   单条上限删掉后改成靠总量测。守的性质一样（覆盖项不许绕过）。
   */
  const overlay = {
    version: 1,
    overrideOrder: { main: { content: 'x'.repeat(PROMPT_LIMITS.totalContent + 1) } },
    own: [],
  };
  const violations = validateCharacterPrompts(overlay);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'totalContent');
  assert.match(violations[0].message, /覆盖「main」/, '要说明最长的是覆盖项');
});

test('★★★★ 合格的配置要零违规', () => {
  const overlay = upsertOwnPrompt(emptyCharacterPrompts(), {
    id: 'tcs-1', name: '短', content: '正常长度的正文。', role: 'system', enabled: true,
  });
  assert.deepEqual(validateCharacterPrompts(overlay), []);
});

/* ═══════════════════════════════════════════════════════════
   ⑦ 恢复默认 / 显示用的派生值
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 恢复默认后行为回到全局', () => {
  let overlay = emptyCharacterPrompts();
  overlay = setCharacterPromptEnabled(overlay, 'jailbreak', false, true);
  overlay = upsertOwnPrompt(overlay, { id: 'tcs-1', name: 'x', content: 'y', role: 'system', enabled: true });

  /* 单条恢复 */
  const one = clearOverride(overlay, 'jailbreak');
  assert.equal(one.overrideOrder['jailbreak'], undefined);
  assert.equal(one.own.length, 1, '清覆盖不动 own');

  /* 删 own */
  const two = removeOwnPrompt(one, 'tcs-1');
  assert.equal(two.own.length, 0);
  assert.equal(isCharacterPromptsEmpty(two), true, '清完就是空');

  /* 空 ⇒ 应用时不改变全局 */
  const config = globalConfig();
  assert.equal(applyCharacterPrompts(config, two), config);
});

test('★★★★ 生效值与"已改"标记要能分别算出来（UI 不许自己拼）', () => {
  let overlay = emptyCharacterPrompts();
  overlay = setCharacterPromptEnabled(overlay, 'jailbreak', false, true);
  overlay = setCharacterPromptContent(overlay, 'main', '新正文', '旧正文', false).config;

  assert.equal(effectiveEnabled(true, overlay, 'jailbreak'), false);
  assert.equal(effectiveEnabled(true, overlay, 'main'), true, '没改开关 ⇒ 沿用全局');
  assert.equal(effectiveContent('旧正文', overlay, 'main'), '新正文');
  assert.equal(effectiveContent('旧正文', overlay, 'jailbreak'), '旧正文', '没改正文 ⇒ 沿用全局');

  assert.equal(hasOverride(overlay, 'main'), true);
  assert.equal(hasOverride(overlay, 'charDescription'), false);
  assert.equal(hasOverride(null, 'main'), false);
});
