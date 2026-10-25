/**
 * 预设格式与板块顺序测试（T2.3 + 补充要求 3）
 *
 * 覆盖：
 *  - 三份内置预设可加载、blockOrder 覆盖六板块、别名覆盖六板块标题；
 *  - 非法预设被拒绝（缺板块 / 别名冲突 / pattern 缺 {title} / 分隔符无换行）；
 *  - 非标准顺序 round-trip 无损；
 *  - 导出不主动重排；只有「应用预设」才重排；
 *  - 分隔线预设重复解析不会叠加分隔符。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyPreset,
  descriptionOrderOf,
  findPreset,
  headingTextFor,
  loadPresets,
  parseStCard,
  parsePreset,
  planPresetApply,
  presetAliasTable,
  renderDescriptionText,
  serializeStCard,
  setBlockText,
} from '../shared/dist/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRESET_DIR = join(ROOT, 'rules', 'presets');

const inputs = readdirSync(PRESET_DIR)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(join(PRESET_DIR, name), 'utf8')));
const { presets, errors } = loadPresets(inputs);

const DEFAULT_PRESET = findPreset(presets, 'default');
const DIVIDER_PRESET = findPreset(presets, 'divider');

/** 板块顺序被故意打乱（用户→特殊→基本），并使用 CRLF 换行 */
const NON_STANDARD_DESCRIPTION = [
  '【用户相关设定】',
  '{{user}} 是她的邻居。',
  '',
  '【特殊设定】',
  '她从不进厨房。',
  '',
  '【基本信息】',
  '年龄 24，身高 168cm。',
].join('\r\n');

function nonStandardCard() {
  const raw = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '乱序卡',
      description: NON_STANDARD_DESCRIPTION,
      personality: '冷淡',
      scenario: '',
      first_mes: '你来啦。',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '',
      extensions: {},
    },
    name: '乱序卡',
    description: NON_STANDARD_DESCRIPTION,
    personality: '冷淡',
    scenario: '',
    first_mes: '你来啦。',
    mes_example: '',
  };
  return { raw, card: parseStCard(raw).card };
}

test('三份内置预设全部加载成功', () => {
  assert.deepEqual(errors, []);
  assert.deepEqual(presets.map((preset) => preset.id).sort(), ['default', 'divider', 'markdown']);
});

test('每个预设的 blockOrder 都是八板块的完整排列，别名表覆盖八个板块', () => {
  for (const preset of presets) {
    assert.equal(preset.blockOrder.length, 8, `${preset.id}: blockOrder 长度应为 8`);
    assert.deepEqual(
      [...preset.blockOrder].sort(),
      ['basic', 'chat-examples', 'initial-scene', 'personality', 'settings', 'special', 'user', 'worldbook'],
      `${preset.id}: blockOrder 必须覆盖八个板块`,
    );
    const table = presetAliasTable(preset);
    for (const blockId of ['basic', 'personality', 'settings', 'special', 'user', 'chat-examples', 'initial-scene', 'worldbook']) {
      assert.ok(table[preset.headings[blockId].aliases[0]] === blockId, `${preset.id}: ${blockId} 的别名未生效`);
      assert.ok(preset.headings[blockId].aliases.length > 0, `${preset.id}: ${blockId} 缺少别名`);
    }
  }
});

test('默认预设的板块顺序固定为 基本→性格→其他→特殊→用户→对话示例→初始场景→世界书', () => {
  assert.deepEqual(DEFAULT_PRESET.blockOrder, [
    'basic',
    'personality',
    'settings',
    'special',
    'user',
    'chat-examples',
    'initial-scene',
    'worldbook',
  ]);
  assert.equal(headingTextFor(DEFAULT_PRESET, 'basic'), '【基本信息】');
  assert.equal(headingTextFor(presets.find((preset) => preset.id === 'markdown'), 'basic'), '## 基本信息');
});

test('非法预设被拒绝：缺板块 / 别名冲突 / pattern 缺 {title} / 分隔符无换行', () => {
  const base = structuredClone(DEFAULT_PRESET);

  // v0.1.3 起「缺板块」不再是错误：补成八板块并给 info 提示（旧预设不能被拒之门外）。
  const partial = structuredClone(base);
  partial.blockOrder = ['basic', 'personality', 'settings', 'special', 'user'];
  const partialResult = parsePreset(partial);
  assert.deepEqual(partialResult.errors, []);
  assert.equal(partialResult.preset.blockOrder.length, 8);
  assert.ok(partialResult.notices.some((text) => text.includes('已自动扩展为八板块')));

  // 真正的硬错误是「写了不存在的板块」：拼写错误不能被补齐逻辑掩盖
  const unknown = structuredClone(base);
  unknown.blockOrder = ['basic', 'personality', 'settings', 'special', 'user', 'worldbook', 'not-a-block'];
  const unknownResult = parsePreset(unknown);
  assert.equal(unknownResult.preset, null);
  assert.ok(unknownResult.errors.some((error) => error.includes('未知板块')), unknownResult.errors.join(' | '));

  const collision = structuredClone(base);
  collision.headings.special.aliases = ['基本信息'];
  const collisionResult = parsePreset(collision);
  assert.equal(collisionResult.preset, null);
  assert.ok(collisionResult.errors.some((error) => error.includes('二义')), collisionResult.errors.join(' | '));

  const noToken = structuredClone(base);
  noToken.headings.basic.pattern = '【基本信息】';
  const noTokenResult = parsePreset(noToken);
  assert.equal(noTokenResult.preset, null);
  assert.ok(noTokenResult.errors.some((error) => error.includes('{title}')), noTokenResult.errors.join(' | '));

  const noNewline = structuredClone(base);
  noNewline.separator = ' ';
  const noNewlineResult = parsePreset(noNewline);
  assert.equal(noNewlineResult.preset, null);
  assert.ok(noNewlineResult.errors.some((error) => error.includes('含换行')), noNewlineResult.errors.join(' | '));
});

test('非标准顺序（用户→特殊→基本，CRLF）：解析不重排，preserve 导出逐字一致', () => {
  const { raw, card } = nonStandardCard();
  assert.equal(card.description.structured, true);
  assert.deepEqual(descriptionOrderOf(card), ['user', 'special', 'basic']);
  const out = serializeStCard(card, { legacyTopLevel: 'preserve' });
  assert.deepStrictEqual(out, raw);
});

test('导出不主动重排：sync 导出的 description 仍是非标准顺序', () => {
  const { card } = nonStandardCard();
  const out = serializeStCard(card);
  const description = out.data.description;
  const indexBasic = description.indexOf('【基本信息】');
  const indexSpecial = description.indexOf('【特殊设定】');
  const indexUser = description.indexOf('【用户相关设定】');
  assert.ok(indexUser < indexSpecial && indexSpecial < indexBasic, description);
});

test('应用默认预设：按 基本→特殊→用户 重排，空板块不输出', () => {
  const { card } = nonStandardCard();
  const plan = planPresetApply(card, DEFAULT_PRESET);
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.beforeOrder, ['user', 'special', 'basic']);
  assert.deepEqual(plan.afterOrder, ['basic', 'settings', 'special', 'user']);
  assert.equal(
    plan.text,
    ['【基本信息】', '年龄 24，身高 168cm。', '', '【特殊设定】', '她从不进厨房。', '', '【用户相关设定】', '{{user}} 是她的邻居。'].join('\n'),
  );
  assert.ok(plan.changes.some((change) => change.includes('板块顺序')));

  const { card: applied } = applyPreset(card, DEFAULT_PRESET);
  assert.deepEqual(descriptionOrderOf(applied), ['basic', 'special', 'user']);
  assert.equal(applied.description.raw, plan.text);
});

test('应用预设保留用户改过的标题文案，只换装饰符', () => {
  const custom = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '改名卡',
      description: '【角色档案】\n年龄 30\n\n【其他设定】\n输出简洁',
      personality: '沉默',
      scenario: '',
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
    },
    name: '改名卡',
  };
  const { card } = parseStCard(custom);
  const markdown = presets.find((preset) => preset.id === 'markdown');
  const { card: applied, plan } = applyPreset(card, markdown);
  assert.match(plan.text, /^## 角色档案\n年龄 30/);
  assert.match(plan.text, /## 其他设定\n输出简洁/);
  assert.ok(applied.description.structured);
  // 性格仍在 personality 字段，不会被写进 description
  assert.equal(applied.blocks.find((block) => block.id === 'personality').text, '沉默');
  assert.ok(!plan.text.includes('沉默'));
  assert.equal(serializeStCard(applied).data.personality, '沉默');
});

test('应用预设后仍可增量编辑：只替换被改板块，顺序保持预设顺序', () => {
  const { card } = nonStandardCard();
  const { card: applied } = applyPreset(card, DEFAULT_PRESET);
  setBlockText(applied, 'special', '她从不进厨房，也不吃甜食。');
  const out = serializeStCard(applied);
  const description = out.data.description;

  assert.ok(description.includes('她从不进厨房，也不吃甜食。'));
  assert.ok(!description.includes('她从不进厨房。\n'), '旧文本应被替换而不是追加');
  assert.ok(description.indexOf('【基本信息】') < description.indexOf('【特殊设定】'));
  assert.ok(description.indexOf('【特殊设定】') < description.indexOf('【用户相关设定】'));
});

test('分隔线预设：重复解析不会叠加 ---，再次应用预设为无变化', () => {
  const { card } = nonStandardCard();
  const { card: applied, plan } = applyPreset(card, DIVIDER_PRESET);
  assert.ok(plan.text.includes('\n\n---\n\n'));
  assert.equal((plan.text.match(/^---$/gm) ?? []).length, 2, plan.text);

  const second = planPresetApply(applied, DIVIDER_PRESET);
  assert.equal(second.changed, false, `重复应用不应产生变化，实际文本：\n${second.text}`);
  assert.equal((second.text.match(/^---$/gm) ?? []).length, 2);
});

test('自定义顺序预设：按用户给定顺序渲染，别名表仍覆盖八板块', () => {
  const custom = structuredClone(DEFAULT_PRESET);
  custom.id = 'custom-reverse';
  custom.name = '反序测试';
  custom.builtin = false;
  custom.blockOrder = ['user', 'worldbook', 'special', 'settings', 'personality', 'basic'];

  const { preset, errors: customErrors } = parsePreset(custom);
  assert.deepEqual(customErrors, []);
  // 用户给的六个板块的相对顺序必须原样保留；缺的两个按规范位置补齐
  const userGiven = ['user', 'worldbook', 'special', 'settings', 'personality', 'basic'];
  assert.deepEqual(
    preset.blockOrder.filter((id) => userGiven.includes(id)),
    userGiven,
    '补齐不能打乱用户给定的相对顺序',
  );
  assert.equal(preset.blockOrder.length, 8);

  const { card } = nonStandardCard();
  const plan = planPresetApply(card, preset);
  const indexUser = plan.text.indexOf('【用户相关设定】');
  const indexSpecial = plan.text.indexOf('【特殊设定】');
  const indexBasic = plan.text.indexOf('【基本信息】');
  assert.ok(indexUser < indexSpecial && indexSpecial < indexBasic, plan.text);

  // 渲染函数不会把 worldbook 当成 description 板块
  assert.ok(!renderDescriptionText(card, preset).includes('【世界书】'));
});
