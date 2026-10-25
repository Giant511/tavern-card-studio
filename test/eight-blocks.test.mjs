/**
 * 八板块（v0.1.3 / F6b）的 shared 侧测试。
 *
 * 覆盖四块最容易出错、又最容易"看起来没问题"的地方：
 *   1. **开场白分隔行的往返**：单条 / 多条 / 空段 / 正文本身含分隔行；
 *   2. **dirty 门控**：没编辑过的卡，导出必须与导入逐字节相同（含 first_mes 里的 `---`）；
 *   3. **旧预设补齐**：六板块预设不再被拒，补齐幂等，且补齐后导出与 default 一致；
 *   4. **字段归属**：开场白与示例对话不得混进 description（字数、TXT 段、选择器三处）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BLOCK_IDS,
  BLOCK_DEFINITION_MAP,
  DEFAULT_GREETING_FORMAT,
  DEFAULT_HEADINGS,
  applyCardText,
  checkPresetConformance,
  collectScopedTexts,
  countCardWords,
  createEmptyCard,
  fillBlockOrder,
  parseCardText,
  parsePreset,
  parseStCard,
  planPresetApply,
  presetGreetingFormat,
  renderCardText,
  renderDescriptionText,
  renderGreetings,
  parseGreetings,
  serializeStCard,
} from '../shared/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const defaultPresetRaw = JSON.parse(readFileSync(join(here, '../rules/presets/default.json'), 'utf8'));
const sample = JSON.parse(readFileSync(join(here, 'fixtures/sample-card.json'), 'utf8'));

/** 取默认预设（解析后是"已补齐"的形态，用于对照） */
function defaultPreset() {
  const { preset, errors } = parsePreset(defaultPresetRaw);
  assert.deepEqual(errors, []);
  return preset;
}

// ---------------------------------------------------------------- 1. 板块模型

test('BLOCK_IDS 是八项且顺序符合需求（… 用户 → 对话示例 → 初始场景 → 世界书）', () => {
  assert.equal(BLOCK_IDS.length, 8);
  assert.deepEqual(
    [...BLOCK_IDS],
    ['basic', 'personality', 'settings', 'special', 'user', 'chat-examples', 'initial-scene', 'worldbook'],
  );
});

test('两个新板块是字段板块，承载字段名实相符', () => {
  assert.equal(BLOCK_DEFINITION_MAP['chat-examples'].kind, 'field-backed');
  assert.equal(BLOCK_DEFINITION_MAP['chat-examples'].stField, 'mes_example');
  assert.equal(BLOCK_DEFINITION_MAP['initial-scene'].kind, 'field-backed');
  assert.equal(BLOCK_DEFINITION_MAP['initial-scene'].stField, 'first_mes');
  assert.deepEqual(BLOCK_DEFINITION_MAP['initial-scene'].alsoWrites, ['alternate_greetings']);
});

test('createEmptyCard 从 BLOCK_IDS 派生：7 个块（worldbook 不在 blocks 里）', () => {
  const card = createEmptyCard('测试');
  assert.equal(card.blocks.length, 7);
  assert.deepEqual(
    card.blocks.map((block) => block.id),
    BLOCK_IDS.filter((id) => id !== 'worldbook'),
  );
});

// ---------------------------------------------------------------- 2. 开场白格式

test('开场白：没有备用开场白时 render 逐字节返回 first_mes（不 trim、不加分隔行）', () => {
  const firstMes = '  前面有空格\n剧情分隔线\n---\n后面还有  \n';
  assert.equal(renderGreetings(firstMes, []), firstMes);
});

test('开场白：多条按分隔行切分，第一条回 first_mes', () => {
  const text = `第一条\n\n---\n\n第二条\n\n---\n\n第三条`;
  const parsed = parseGreetings(text);
  assert.equal(parsed.split, true);
  assert.equal(parsed.firstMes, '第一条');
  assert.deepEqual(parsed.alternateGreetings, ['第二条', '第三条']);
});

test('开场白：没有分隔行 = 单条（存量卡兼容）', () => {
  const text = '只有一段，里面提到 --- 但不是整行\n还有 --- 这样的行尾';
  const parsed = parseGreetings(text);
  assert.equal(parsed.split, false);
  assert.equal(parsed.firstMes, text);
  assert.deepEqual(parsed.alternateGreetings, []);
});

test('开场白：整行等于标记才算分隔（正文里提到 --- 不算）', () => {
  const parsed = parseGreetings('说明：--- 表示分镜切换\n\n---\n\n第二条');
  assert.deepEqual(parsed.alternateGreetings, ['第二条']);
  assert.equal(parsed.firstMes, '说明：--- 表示分镜切换');
});

test('开场白：多段 round-trip 逐字节相等（含空段）', () => {
  const cases = [
    ['甲', []],
    ['甲', ['乙']],
    ['甲', ['乙', '丙']],
    ['', ['乙']],
    ['甲', ['', '丙']],
    ['甲\n换行\n\n空行', ['乙\n\n双空行']],
  ];
  for (const [first, alternates] of cases) {
    const text = renderGreetings(first, alternates);
    const parsed = parseGreetings(text);
    assert.equal(parsed.firstMes, first, `first_mes 不一致：${JSON.stringify([first, alternates])}`);
    assert.deepEqual(parsed.alternateGreetings, alternates, `greetings 不一致：${JSON.stringify([first, alternates])}`);
  }
});

test('开场白格式的默认值已冻结（改它 = 破坏所有历史 TXT）', () => {
  assert.equal(DEFAULT_GREETING_FORMAT.separator, '\n\n---\n\n');
  assert.ok(Object.isFrozen(DEFAULT_GREETING_FORMAT));
});

// ---------------------------------------------------------------- 3. ST JSON 往返

function cardWithGreetings() {
  const raw = JSON.parse(JSON.stringify(sample));
  const data = raw.data ?? raw;
  // first_mes 本身**不含**分隔行：那种情况另有测试（二义性）
  data.first_mes = '开场白一';
  data.alternate_greetings = ['备用一', '备用二'];
  data.mes_example = '<START>\n{{user}}: 你好\n{{char}}: 你好呀';
  return raw;
}

test('导入 JSON 后板块里能看到开场白与示例对话', () => {
  const { card } = parseStCard(JSON.stringify(cardWithGreetings()));
  const scene = card.blocks.find((block) => block.id === 'initial-scene');
  const examples = card.blocks.find((block) => block.id === 'chat-examples');
  assert.ok(scene && examples);
  // 1 条 first_mes + 2 条备用 = 3 段，两处分隔行
  assert.equal(scene.text, '开场白一\n\n---\n\n备用一\n\n---\n\n备用二');
  assert.equal(examples.text, '<START>\n{{user}}: 你好\n{{char}}: 你好呀');
});

test('未编辑时导出与导入完全一致（dirty 门控）', () => {
  const original = cardWithGreetings();
  const { card } = parseStCard(JSON.stringify(original));
  const out = serializeStCard(card);
  assert.equal(out.data.first_mes, original.data.first_mes);
  assert.deepEqual(out.data.alternate_greetings, original.data.alternate_greetings);
  assert.equal(out.data.mes_example, original.data.mes_example);
});

test('未编辑时 first_mes 里的 --- 不会被当成分隔行切开（静默改数据的红线）', () => {
  const original = JSON.parse(JSON.stringify(sample));
  const data = original.data ?? original;
  data.first_mes = '第一幕\n\n---\n\n第二幕';
  data.alternate_greetings = [];
  const { card } = parseStCard(JSON.stringify(original));
  const out = serializeStCard(card);
  assert.equal(out.data.first_mes, '第一幕\n\n---\n\n第二幕');
  assert.deepEqual(out.data.alternate_greetings, []);
});

test('编辑过板块才回写：改初始场景 → first_mes 与 alternate_greetings 都跟着变', () => {
  const { card } = parseStCard(JSON.stringify(cardWithGreetings()));
  const edited = {
    ...card,
    blocks: card.blocks.map((block) =>
      block.id === 'initial-scene'
        ? { ...block, text: '新开场\n\n---\n\n新备用甲\n\n---\n\n新备用乙', dirty: true }
        : block,
    ),
  };
  const out = serializeStCard(edited);
  assert.equal(out.data.first_mes, '新开场');
  assert.deepEqual(out.data.alternate_greetings, ['新备用甲', '新备用乙']);
});

test('编辑对话示例 → 只改 mes_example，不动开场白族', () => {
  const { card } = parseStCard(JSON.stringify(cardWithGreetings()));
  const edited = {
    ...card,
    blocks: card.blocks.map((block) =>
      block.id === 'chat-examples' ? { ...block, text: '<START>\n新示例', dirty: true } : block,
    ),
  };
  const out = serializeStCard(edited);
  assert.equal(out.data.mes_example, '<START>\n新示例');
  assert.equal(out.data.first_mes, '开场白一');
  assert.deepEqual(out.data.alternate_greetings, ['备用一', '备用二']);
});

test('description 里不会出现新板块的标题（字段归属不串）', () => {
  const { card } = parseStCard(JSON.stringify(cardWithGreetings()));
  assert.ok(!card.description.raw.includes('开场白一'));
  assert.ok(!card.description.raw.includes('<START>'));
  const out = serializeStCard(card);
  assert.ok(!out.data.description.includes('开场白一'));
});

// ---------------------------------------------------------------- 4. 旧预设补齐

function legacySixBlockPreset() {
  const raw = JSON.parse(JSON.stringify(defaultPresetRaw));
  raw.id = 'legacy-six';
  raw.blockOrder = ['basic', 'personality', 'settings', 'special', 'user', 'worldbook'];
  for (const id of ['chat-examples', 'initial-scene']) delete raw.headings[id];
  delete raw.greeting;
  return raw;
}

test('六板块旧预设：校验通过（不再硬报错），并补齐到八板块', () => {
  const { preset, errors, notices } = parsePreset(legacySixBlockPreset());
  assert.deepEqual(errors, []);
  assert.ok(preset, '旧预设应当仍能加载');
  assert.deepEqual(preset.blockOrder, [
    'basic',
    'personality',
    'settings',
    'special',
    'user',
    'chat-examples',
    'initial-scene',
    'worldbook',
  ]);
  assert.ok(notices.some((text) => text.includes('已自动扩展为八板块')), '必须给出 info 提示');
});

test('补齐位置符合需求：对话示例 → 初始场景 → 世界书（不是甩到末尾）', () => {
  // 世界书排在最前的怪顺序：两个新板块仍应落到 worldbook **之前**（规范顺序里它们在前面）
  const partial = ['worldbook', 'basic', 'personality', 'settings', 'special', 'user'];
  const filled = fillBlockOrder(partial);
  assert.deepEqual(filled, [
    'chat-examples',
    'initial-scene',
    'worldbook',
    'basic',
    'personality',
    'settings',
    'special',
    'user',
  ]);
  // 常规六板块顺序：两个新板块落在 worldbook 之前
  const normal = fillBlockOrder(['basic', 'personality', 'settings', 'special', 'user', 'worldbook']);
  assert.equal(normal.indexOf('chat-examples'), 5);
  assert.equal(normal.indexOf('initial-scene'), 6);
  assert.equal(normal.indexOf('worldbook'), 7);
});

test('补齐幂等：补两次结果相同', () => {
  const once = fillBlockOrder(['basic', 'personality', 'settings', 'special', 'user', 'worldbook']);
  const twice = fillBlockOrder(once);
  assert.deepEqual(twice, once);
});

test('补齐后的旧预设与 default 导出同一张卡，字节完全相同', () => {
  const { preset: legacy } = parsePreset(legacySixBlockPreset());
  const { preset: def } = parsePreset(defaultPresetRaw);
  const { card } = parseStCard(JSON.stringify(cardWithGreetings()));
  assert.equal(renderCardText(card, legacy), renderCardText(card, def));
});

test('旧预设补出来的 headings 与内置默认表一致（不是随手编的别名）', () => {
  const { preset } = parsePreset(legacySixBlockPreset());
  assert.deepEqual(preset.headings['chat-examples'].aliases, [...DEFAULT_HEADINGS['chat-examples'].aliases]);
  assert.deepEqual(preset.headings['initial-scene'].aliases, [...DEFAULT_HEADINGS['initial-scene'].aliases]);
  assert.equal(presetGreetingFormat(preset).separator, DEFAULT_GREETING_FORMAT.separator, '旧预设缺 greeting 时必须落到冻结默认值');
});

test('未知板块 / 重复板块仍然是硬错误（不能被"补齐"掩盖）', () => {
  const withUnknown = legacySixBlockPreset();
  withUnknown.blockOrder = [...withUnknown.blockOrder, 'not-a-block'];
  const unknown = parsePreset(withUnknown);
  assert.equal(unknown.preset, null);
  assert.ok(unknown.errors.some((text) => text.includes('未知板块')));

  const withDuplicate = legacySixBlockPreset();
  withDuplicate.blockOrder = ['basic', 'basic', 'settings', 'special', 'user', 'worldbook'];
  const duplicate = parsePreset(withDuplicate);
  assert.equal(duplicate.preset, null);
  assert.ok(duplicate.errors.some((text) => text.includes('重复')));
});

test('default 预设的别名表与代码里的 DEFAULT_HEADINGS 一致（两处不能各写一份）', () => {
  const { preset } = parsePreset(defaultPresetRaw);
  for (const id of BLOCK_IDS) {
    assert.deepEqual(preset.headings[id].aliases, [...DEFAULT_HEADINGS[id].aliases], `板块 ${id} 的别名不一致`);
    assert.equal(preset.headings[id].pattern, DEFAULT_HEADINGS[id].pattern, `板块 ${id} 的标题模板不一致`);
  }
});

test('别名全局唯一：没有一条别名同时属于两个板块', () => {
  const { preset } = parsePreset(defaultPresetRaw);
  const owner = new Map();
  for (const id of BLOCK_IDS) {
    for (const alias of preset.headings[id].aliases) {
      const key = alias.trim().toLowerCase();
      const previous = owner.get(key);
      assert.ok(previous === undefined || previous === id, `别名「${alias}」同时属于 ${previous} 与 ${id}`);
      owner.set(key, id);
    }
  }
});

// ---------------------------------------------------------------- 5. TXT 往返

test('TXT 导出再导入：开场白族与示例对话仍在原字段，不进 description', () => {
  const preset = defaultPreset();
  const { card } = parseStCard(JSON.stringify(cardWithGreetings()));
  const text = renderCardText(card, preset);
  const back = parseCardText(text, preset, { preserveUnrecognized: true });
  assert.ok(back.ok, JSON.stringify(back.issues));
  assert.equal(back.card.residual.firstMes, '开场白一');
  assert.deepEqual(back.card.residual.alternateGreetings, ['备用一', '备用二']);
  assert.equal(back.card.residual.mesExample, '<START>\n{{user}}: 你好\n{{char}}: 你好呀');
  assert.ok(!back.card.description.raw.includes('开场白一'));
});

test('TXT 三段往返幂等：导出 → 导入 → 再导出，逐字节相同', () => {
  const preset = defaultPreset();
  const { card } = parseStCard(JSON.stringify(cardWithGreetings()));
  const first = renderCardText(card, preset);
  const once = parseCardText(first, preset, { preserveUnrecognized: true });
  const second = renderCardText(once.card, preset);
  assert.equal(second, first);
  const twice = parseCardText(second, preset, { preserveUnrecognized: true });
  assert.equal(renderCardText(twice.card, preset), first);
});

test('applyCardText 只回写开场白族三个字段，不清空 scenario 等其余残余字段', () => {
  const preset = defaultPreset();
  const { card } = parseStCard(JSON.stringify(cardWithGreetings()));
  const before = { ...card.residual };
  const text = renderCardText(card, preset);
  const applied = applyCardText(card, text, preset, { preserveUnrecognized: true });
  assert.ok(applied.ok);
  assert.equal(applied.card.residual.scenario, before.scenario);
  assert.equal(applied.card.residual.systemPrompt, before.systemPrompt);
  assert.equal(applied.card.residual.firstMes, '开场白一');
});

test('旧六板块 TXT（没有两个新标题）导入不出 error，且内容不丢', () => {
  const preset = defaultPreset();
  const legacyText = [
    '【基本信息】\n身高 170',
    '【性格】\n温和',
    '【其他设定】\n用简体',
    '【特殊设定】\n无',
    '【用户相关设定】\n{{user}} 是同事',
  ].join('\n\n');
  const parsed = parseCardText(legacyText, preset, { preserveUnrecognized: true });
  assert.ok(parsed.ok);
  assert.equal(parsed.issues.filter((issue) => issue.severity === 'error').length, 0);
  assert.equal(parsed.card.residual.firstMes, '');
  // 两个字段板块标 missing（供 UI 说明"这个文件里没有"），但不是 error
  const scene = parsed.card.blocks.find((block) => block.id === 'initial-scene');
  assert.equal(scene.missing, true);
});

// ---------------------------------------------------------------- 6. 选择器与统计

test('选择器：block:chat-examples / block:initial-scene 都能解析并取到文本', () => {
  const { card } = parseStCard(JSON.stringify(cardWithGreetings()));
  const examples = collectScopedTexts(card, 'block:chat-examples');
  assert.equal(examples.length, 1);
  assert.equal(examples[0].field, 'mes_example');
  assert.ok(examples[0].text.includes('<START>'));

  const scene = collectScopedTexts(card, 'block:initial-scene');
  assert.equal(scene.length, 1);
  assert.equal(scene[0].field, 'first_mes');
  assert.ok(scene[0].text.includes('开场白一'));
});

test('选择器：field:description 不吞掉字段板块的文本', () => {
  const { card } = parseStCard(JSON.stringify(cardWithGreetings()));
  const texts = collectScopedTexts(card, 'field:description');
  for (const item of texts) {
    assert.ok(!item.text.includes('开场白一'), '开场白不该出现在 description 里');
    assert.ok(!item.text.includes('<START>'), '示例对话不该出现在 description 里');
  }
});

test('字数：byField.description 不含两个字段板块，total 含', () => {
  const { card } = parseStCard(JSON.stringify(cardWithGreetings()));
  const report = countCardWords(card);
  assert.equal(report.blocks.length, 8);
  const descriptionSum = card.blocks
    .filter((block) => ['basic', 'settings', 'special', 'user'].includes(block.id))
    .reduce((sum, block) => sum + Array.from(block.text).length, 0);
  assert.equal(report.byField.description.chars, descriptionSum);
  assert.ok(report.byField.first_mes.chars > 0);
  assert.ok(report.byField.mes_example.chars > 0);
  assert.equal(
    report.total.chars,
    report.byField.description.chars +
      report.byField.personality.chars +
      report.byField.first_mes.chars +
      report.byField.mes_example.chars +
      report.byField.character_book.chars,
  );
});

// ---------------------------------------------------------------- 7. 已知二义性（不静默）

test('first_mes 正文自带分隔行 + 有备用开场白：TXT 往返会多切一条（已知限制，必须被审计提示）', () => {
  const raw = JSON.parse(JSON.stringify(sample));
  const data = raw.data ?? raw;
  data.first_mes = '第一幕\n\n---\n\n第二幕';
  data.alternate_greetings = ['备用一'];
  const { card } = parseStCard(JSON.stringify(raw));

  // 未编辑时导出不受影响（dirty 门控）
  const direct = serializeStCard(card);
  assert.equal(direct.data.first_mes, '第一幕\n\n---\n\n第二幕');
  assert.deepEqual(direct.data.alternate_greetings, ['备用一']);

  // 但一旦经 TXT 往返（板块文本被重新解析），"第一幕/第二幕"会变成两条开场白。
  // 这是「分隔行切分」这条格式规则的固有限制：文本层面本来就分不清
  // "第一条消息里的分镜" 与 "两条开场白"。
  const preset = defaultPreset();
  const text = renderCardText(card, preset);
  const back = parseCardText(text, preset, { preserveUnrecognized: true });
  assert.equal(back.card.residual.firstMes, '第一幕');
  assert.deepEqual(back.card.residual.alternateGreetings, ['第二幕', '备用一']);
  // 内容没丢（三段全在），丢的是"哪两段属于同一条"这个信息
  assert.equal(back.card.residual.firstMes + back.card.residual.alternateGreetings.join(''), '第一幕第二幕备用一');
});

test('上述二义性必须由审计给 info 提示（不能静默改条数）', () => {
  const raw = JSON.parse(JSON.stringify(sample));
  const data = raw.data ?? raw;
  data.first_mes = '第一幕\n\n---\n\n第二幕';
  data.alternate_greetings = ['备用一'];
  const { card } = parseStCard(JSON.stringify(raw));
  const issues = checkPresetConformance(card, defaultPreset());
  const hint = issues.find((issue) => issue.ruleId === 'builtin:greeting-divider-ambiguous');
  assert.ok(hint, '必须有一条 info 说明分隔行条数多于备用开场白');
  assert.equal(hint.severity, 'info');
  assert.ok(hint.message.includes('分隔行'));
});

test('没有二义性时不出那条 info（避免噪音）', () => {
  const { card } = parseStCard(JSON.stringify(cardWithGreetings()));
  const issues = checkPresetConformance(card, defaultPreset());
  assert.equal(issues.filter((issue) => issue.ruleId === 'builtin:greeting-divider-ambiguous').length, 0);
});

// ---------------------------------------------------------------- 8. description 拼装边界

test('renderDescriptionText 只拼 description 侧四个板块（新板块一个都不能进来）', () => {
  const preset = defaultPreset();
  const { card } = parseStCard(JSON.stringify(cardWithGreetings()));
  const text = renderDescriptionText(card, preset);
  for (const forbidden of ['【对话示例】', '【初始场景】', '<START>', '开场白一']) {
    assert.ok(!text.includes(forbidden), `description 拼装里不该出现 ${forbidden}：\n${text}`);
  }
  // 反证：确实是按板块拼的，不是空串
  assert.ok(text.includes('【基本信息】'), 'description 应当包含基本信息段');
});

test('planPresetApply 的 afterOrder 只含 description 侧（不含 worldbook / 性格 / 字段板块）', () => {
  const preset = defaultPreset();
  const { card } = parseStCard(JSON.stringify(cardWithGreetings()));
  const plan = planPresetApply(card, preset);
  assert.deepEqual(plan.afterOrder, ['basic', 'settings', 'special', 'user']);
});

// ---------------------------------------------------------------- 9. 缺失标记必须被读（回归）

test('字段板块的 missing 标记会产出 builtin:block-missing（info 级，不是 warning）', () => {
  const { card } = parseStCard(JSON.stringify(sample));
  const examples = card.blocks.find((block) => block.id === 'chat-examples');
  examples.text = '';
  examples.raw = '';
  examples.missing = true;

  const issues = checkPresetConformance(card, defaultPreset());
  const missing = issues.filter((issue) => issue.ruleId === 'builtin:block-missing');
  assert.equal(missing.length, 1, '字段板块的 missing 必须被检查到 —— 6b 里它曾因范围写错完全不触发');
  assert.equal(missing[0].location.blockId, 'chat-examples');
  assert.equal(missing[0].severity, 'info', '字段板块缺失是可选内容，只能 info');
  assert.equal(missing[0].location.field, 'mes_example', '字段名要指向真正的落盘字段');
});

test('两个字段板块都缺失（旧格式卡）：只出 legacy 一条，不出逐条 block-missing', () => {
  const { card } = parseStCard(JSON.stringify(sample));
  for (const id of ['chat-examples', 'initial-scene']) {
    const block = card.blocks.find((item) => item.id === id);
    block.text = '';
    block.raw = '';
    block.missing = true;
  }
  const issues = checkPresetConformance(card, defaultPreset());
  assert.equal(issues.filter((issue) => issue.ruleId === 'builtin:legacy-six-block').length, 1);
  assert.equal(
    issues.filter((issue) => issue.ruleId === 'builtin:block-missing').length,
    0,
    '两个都缺时逐条再报就是纯噪音，legacy 那条已经说清了',
  );
});

test('description 分段板块缺失仍是 warning（不能被字段板块的降级带偏）', () => {
  const { card } = parseStCard(JSON.stringify(sample));
  const settings = card.blocks.find((block) => block.id === 'settings');
  settings.text = '';
  settings.raw = '';
  settings.missing = true;

  const issues = checkPresetConformance(card, defaultPreset());
  const missing = issues.find((issue) => issue.ruleId === 'builtin:block-missing');
  assert.ok(missing);
  assert.equal(missing.severity, 'warning');
  assert.equal(missing.location.blockId, 'settings');
});
