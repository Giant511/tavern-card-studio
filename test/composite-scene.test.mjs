/**
 * 「初始场景」复合板块（2026-11-09）。
 *
 * ## 产品形态（用户口径，两次纠正后的最终版）
 *
 * > 我编辑器里面的初始场景板块其实是包含两个字段的内容，
 * > 一个就是开场白，一个就是情景。
 *
 * 所以：**板块数仍是 8**，「初始场景」一个板块内部按子标题分两段：
 *
 * ```text
 *   【初始场景】
 *   @@开场白
 *   （first_mes；多条用分隔行 --- 切，导出为 alternate_greetings）
 *   @@情景
 *   （scenario）
 * ```
 *
 * ## 这个文件守的是什么
 *
 * 用户已经写好了 `composite-scene.ts` 的实现，但没有判据。而这条链上
 * **有四处任何一处断了都不会报错**：
 *
 * ```text
 *   ① 旧 TXT（无 @@ 标记）被当成"情景"或报错  → 所有历史文件错位
 *   ② 渲染时省掉空段的标记                    → 用户看不到"情景可以写"
 *   ③ 只回写 first_mes / alternate_greetings  → 改的情境静默丢失
 *   ④ residual.scenario 没进 StCardData        → 界面上改了、prompt 里没有
 * ```
 *
 * 其中 ③ 最阴：板块文本看起来改过了，界面也正常，只有下一轮对话时才
 * 发现"我写的场景没生效"。所以三条字段一起回写这件事必须钉住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BLOCK_IDS,
  BLOCK_DEFINITION_MAP,
  DEFAULT_GREETING_FORMAT,
  SCENE_SECTION_LABELS,
  createEmptyCard,
  findPreset,
  loadPresets,
  parseCardText,
  parseCompositeScene,
  parseGreetings,
  reflectFieldBlocks,
  renderCardText,
  renderCompositeScene,
  setFieldBlockText,
} from '../shared/dist/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRESET_DIR = join(ROOT, 'rules', 'presets');
const inputs = readdirSync(PRESET_DIR)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(join(PRESET_DIR, name), 'utf8')));
const { presets } = loadPresets(inputs);
const DEFAULT_PRESET = findPreset(presets, 'default');

/* ═══════════════════════════════════════════════════════════
   ① 形态：仍是 8 板块，scenario 不占板块位
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 板块数仍是 8：scenario 不单独占板块', () => {
  /*
   * 2026-11-08 我误把 scenario 做成独立第九板块，用户指出
   * 「初始场景本来就装两个字段」，已撤回。
   *
   * 这条判据防的是"以后又有人想单独开一块"：`scenario` 不是 BlockId，
   * 它只是 initial-scene 板块里的一个子段。
   */
  assert.equal(BLOCK_IDS.length, 8, '板块数必须是 8');
  assert.ok(BLOCK_IDS.includes('initial-scene'), '要有初始场景板块');
  /* .mjs 里不能写 TS 的 `as` 断言 —— 用 Array.from 转成普通数组再查 */
  assert.ok(
    !Array.from(BLOCK_IDS).includes('scenario'),
    'scenario 不许作为独立板块 id',
  );
  assert.ok(
    !('scenario' in BLOCK_DEFINITION_MAP),
    'BLOCK_DEFINITION_MAP 里不许有 scenario 定义',
  );
});

test('★★★★ 初始场景板块声明自己写三个 ST 字段', () => {
  const def = BLOCK_DEFINITION_MAP['initial-scene'];
  assert.equal(def.stField, 'first_mes', '主字段是 first_mes');
  const also = def.alsoWrites ?? [];
  assert.ok(also.includes('alternate_greetings'), '还要写 alternate_greetings');
  assert.ok(also.includes('scenario'), '还要写 scenario');
  assert.equal(def.kind, 'field-backed', '是字段板块（不拼进 description）');
});

test('★★★ 子标记用 @@ 前缀（与世界书 @@ENTRY 同一套视觉语言）', () => {
  assert.equal(SCENE_SECTION_LABELS.greeting, '@@开场白');
  assert.equal(SCENE_SECTION_LABELS.scenario, '@@情景');
});

/* ═══════════════════════════════════════════════════════════
   ② 渲染：两段标记始终写出来（可发现性）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 空板块也写出两段标记（否则用户不知道情景可以写）', () => {
  /*
   * 省掉空段的标记，新卡就只剩 `@@开场白` 一行 ——
   * 用户没有线索知道"这里还能写情景"。
   */
  const text = renderCompositeScene({ firstMes: '', alternateGreetings: [], scenario: '' });
  assert.ok(text.includes(SCENE_SECTION_LABELS.greeting), '要写开场白标记');
  assert.ok(text.includes(SCENE_SECTION_LABELS.scenario), '要写情景标记');
});

test('★★★★ 渲染：开场白在前、情景在后，且都带标记', () => {
  const text = renderCompositeScene({
    firstMes: '她推门进来，雨水顺着发梢滴下。',
    alternateGreetings: [],
    scenario: '雨夜的东京，霓虹倒映在积水里。',
  });
  const gi = text.indexOf(SCENE_SECTION_LABELS.greeting);
  const si = text.indexOf(SCENE_SECTION_LABELS.scenario);
  assert.ok(gi >= 0 && si >= 0, '两段标记都要在');
  assert.ok(gi < si, '开场白必须在情景之前（顺序即语义）');
  assert.ok(text.includes('她推门进来'), '开场白正文要在');
  assert.ok(text.includes('雨夜的东京'), '情景正文要在');
});

test('★★★★ 多条开场白仍用分隔行切（复用 greeting-preset 的既有能力）', () => {
  const text = renderCompositeScene({
    firstMes: '第一条',
    alternateGreetings: ['第二条'],
    scenario: '场景',
  });
  /* 分隔行是 DEFAULT_GREETING_FORMAT.separator 里的 `---` */
  assert.ok(text.includes('---'), '多条开场白之间要有分隔行');
  assert.ok(text.includes('第一条') && text.includes('第二条'));
});

/* ═══════════════════════════════════════════════════════════
   ③ 解析：兼容旧 TXT（最要紧的一条）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 旧 TXT（没有 @@ 标记）→ 整段按开场白，情景为空', () => {
  /*
   * v0.1.7 之前导出的 TXT 里，「初始场景」正文只有开场白，一个 @@ 都没有。
   *
   * 若把它当成情景、或者报"缺少标记"，**用户所有历史 TXT 都会错位或导不进来**。
   * 这条是整个改动里最不能错的一处。
   */
  const legacy = '她推门进来，雨水顺着发梢滴下。';
  const parsed = parseCompositeScene(legacy, DEFAULT_GREETING_FORMAT);

  assert.equal(parsed.hasMarkers, false, '要认出这是无标记的旧格式');
  assert.equal(parsed.firstMes, legacy, '整段都是 first_mes');
  assert.deepEqual(parsed.alternateGreetings, [], '不该凭空多出备用开场白');
  assert.equal(parsed.scenario, '', '情景必须是空串，不能把开场白当情景');
});

test('★★★★★ 旧 TXT 里的分隔行仍按多条开场白切（不是情景）', () => {
  const legacy = `第一条\n\n---\n\n第二条`;
  const parsed = parseCompositeScene(legacy, DEFAULT_GREETING_FORMAT);
  assert.equal(parsed.hasMarkers, false);
  assert.equal(parsed.firstMes, '第一条');
  assert.deepEqual(parsed.alternateGreetings, ['第二条'], '两条开场白要切开');
  assert.equal(parsed.scenario, '', '情景仍为空');
});

test('★★★★★ 有标记时：两段各归其位', () => {
  const text = `${SCENE_SECTION_LABELS.greeting}\n她推门进来。\n\n${SCENE_SECTION_LABELS.scenario}\n雨夜的东京。`;
  const parsed = parseCompositeScene(text, DEFAULT_GREETING_FORMAT);
  assert.equal(parsed.hasMarkers, true, '要认出有标记');
  assert.equal(parsed.firstMes, '她推门进来。');
  assert.equal(parsed.scenario, '雨夜的东京。');
});

test('★★★★ 标记也接受带冒号的写法（用户手写常见）', () => {
  for (const label of [`${SCENE_SECTION_LABELS.scenario}：`, `${SCENE_SECTION_LABELS.scenario}:`]) {
    const text = `${SCENE_SECTION_LABELS.greeting}\n开场\n\n${label}\n情景内容`;
    const parsed = parseCompositeScene(text, DEFAULT_GREETING_FORMAT);
    assert.equal(parsed.scenario, '情景内容', `「${label}」也要认`);
  }
});

test('★★★★ 只写情景、不写开场白：开场白留空，情景正常取出', () => {
  const text = `${SCENE_SECTION_LABELS.scenario}\n只有情景`;
  const parsed = parseCompositeScene(text, DEFAULT_GREETING_FORMAT);
  assert.equal(parsed.hasMarkers, true);
  assert.equal(parsed.firstMes, '');
  assert.equal(parsed.scenario, '只有情景');
});

/* ═══════════════════════════════════════════════════════════
   ④ 回写：三个字段必须一起写
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 改「初始场景」→ 一次写回 first_mes / alternate_greetings / scenario', () => {
  /*
   * 只写前两个的话：用户在板块里改的情景会静默丢掉 ——
   * 板块文本看起来改过了，界面正常，只有下一轮对话才发现"场景没生效"。
   */
  const card = createEmptyCard('测试角色');
  const text = `${SCENE_SECTION_LABELS.greeting}\n第一幕\n\n---\n\n第二幕\n\n${SCENE_SECTION_LABELS.scenario}\n雨夜的东京。`;
  const edited = setFieldBlockText(card, 'initial-scene', text).card;

  const { override, written } = reflectFieldBlocks(edited);
  assert.deepEqual(written, ['initial-scene'], '写的是 initial-scene 这一块');
  assert.equal(override.firstMes, '第一幕', 'first_mes 要写');
  assert.deepEqual(override.alternateGreetings, ['第二幕'], 'alternate_greetings 要写');
  assert.equal(override.scenario, '雨夜的东京。', 'scenario 必须一起写');
});

test('★★★★ 清空情景要真的清空（不许"删了还在 prompt 里"）', () => {
  const card = createEmptyCard('测试角色');
  const filled = setFieldBlockText(
    card,
    'initial-scene',
    `${SCENE_SECTION_LABELS.greeting}\n开场\n\n${SCENE_SECTION_LABELS.scenario}\n有情景`,
  ).card;
  const cleared = setFieldBlockText(
    filled,
    'initial-scene',
    `${SCENE_SECTION_LABELS.greeting}\n开场\n\n${SCENE_SECTION_LABELS.scenario}\n`,
  ).card;

  const { override } = reflectFieldBlocks(cleared);
  assert.equal(override.scenario, '', '清空要写成空串，不是漏掉这个键');
});

test('★★★★ 没改过的板块不写 residual（不污染）', () => {
  const card = createEmptyCard('测试角色');
  const { written, override } = reflectFieldBlocks(card);
  assert.deepEqual(written, [], '干净卡片不该写任何字段');
  assert.equal(override.scenario, undefined);
});

/* ═══════════════════════════════════════════════════════════
   ⑤ 进 prompt（界面填了、上下文里要真有）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 情景落在 residual.scenario（prompt 槽位的来源）', () => {
  /*
   * `prompt-assemble.ts` 的 `case 'scenario'` 读的是 `card.scenario`
   * （`StCardData` 的扁平字段）。所以 residual 必须真的被写上 ——
   * 这一环断了，表现是"界面上填了、上下文里没有"，而两边各自测试都绿。
   */
  const card = createEmptyCard('测试角色');
  const text = `${SCENE_SECTION_LABELS.greeting}\n开场\n\n${SCENE_SECTION_LABELS.scenario}\n雨夜的东京。`;
  const edited = setFieldBlockText(card, 'initial-scene', text).card;
  const { override } = reflectFieldBlocks(edited);
  const merged = { ...edited, residual: { ...edited.residual, ...override } };

  assert.equal(merged.residual.scenario, '雨夜的东京。', 'residual.scenario 必须被写上');
  assert.equal(merged.residual.firstMes, '开场');
});

/* ═══════════════════════════════════════════════════════════
   ⑥ TXT 往返（导出 → 导入）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ TXT 往返：导出的两段都能被原样读回', () => {
  const card = createEmptyCard('测试角色');
  const greeting = '她推门进来，雨水顺着发梢滴下。';
  const scenario = '雨夜的东京，霓虹倒映在积水里。';
  const text = `${SCENE_SECTION_LABELS.greeting}\n${greeting}\n\n${SCENE_SECTION_LABELS.scenario}\n${scenario}`;
  const edited = setFieldBlockText(card, 'initial-scene', text).card;
  const { override } = reflectFieldBlocks(edited);
  const merged = { ...edited, residual: { ...edited.residual, ...override } };

  const txt = renderCardText(merged, DEFAULT_PRESET);
  const parsed = parseCardText(txt, DEFAULT_PRESET);
  const errors = parsed.issues.filter((one) => one.severity === 'error');
  assert.equal(errors.length, 0, `TXT 解析不该报错：${errors.map((o) => o.message).join(' | ')}`);
  assert.ok(parsed.card !== null);

  const block = parsed.card.blocks.find((one) => one.id === 'initial-scene');
  assert.ok(block !== undefined, '要有初始场景块');
  assert.ok(block.text.includes(greeting), `开场白要读回，实际：${block.text}`);
  assert.ok(block.text.includes(scenario), `情景要读回，实际：${block.text}`);
  assert.equal(parsed.card.residual.scenario, scenario, 'residual.scenario 要读回');
});

test('★★★★ 旧格式 TXT 导入：情景为空、开场白不丢', () => {
  const legacyCard = createEmptyCard('老卡');
  const legacyText = '她推门进来，雨水顺着发梢滴下。';
  const txt = `【基本信息】\n档案\n\n【性格】\n温和\n\n【其他设定】\n无\n\n【特殊设定】\n无\n\n【用户相关设定】\n我\n\n【对话示例】\n示例\n\n【初始场景】\n${legacyText}\n\n【世界书】\n`;

  const parsed = parseCardText(txt, DEFAULT_PRESET);
  assert.ok(parsed.card !== null, '旧格式要能导入');
  assert.equal(parsed.card.residual.firstMes, legacyText, '开场白要保住');
  assert.equal(parsed.card.residual.scenario, '', '情景为空（旧文件没有这一段）');
  void legacyCard;
});

/* ═══════════════════════════════════════════════════════════
   ⑦ 与既有能力的兼容
   ═══════════════════════════════════════════════════════════ */

test('★★★ 纯开场白解析保持原样（composite 不改变单段的语义）', () => {
  /*
   * `parseCompositeScene` 内部复用 `parseGreetings`。这条钉住"没有标记时
   * 两者的结果完全一致"，防止以后在 composite 里擅自 trim / 改口径。
   */
  const samples = ['', '单条', '第一条\n\n---\n\n第二条'];
  for (const sample of samples) {
    const a = parseGreetings(sample, DEFAULT_GREETING_FORMAT);
    const b = parseCompositeScene(sample, DEFAULT_GREETING_FORMAT);
    assert.equal(b.firstMes, a.firstMes, `firstMes 不一致：${JSON.stringify(sample)}`);
    assert.deepEqual(b.alternateGreetings, a.alternateGreetings, `备用开场白不一致：${JSON.stringify(sample)}`);
  }
});

test('★★★ 所有预设都能承载两段标记（不留"某个预设下写不了情景"）', () => {
  for (const preset of presets) {
    assert.ok(
      preset.blockOrder.includes('initial-scene'),
      `${preset.id}: 必须有初始场景板块`,
    );
    const heading = preset.headings['initial-scene'];
    assert.ok(heading !== undefined, `${preset.id}: 要有初始场景标题`);
    assert.ok((heading.aliases ?? []).length > 0, `${preset.id}: 要有别名`);
  }
});
