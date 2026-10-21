/**
 * 整卡 TXT 的渲染 / 导入测试（T2.2）。
 * 覆盖：非标准板块顺序无损、严格模式中止、宽松模式可见空块、别名猜测、
 * 世界书「TXT 事实源」合并、字面 \@@、重复 id 保护。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  applyCardText,
  parseCardText,
  parsePreset,
  parseStCard,
  renderCardText,
  serializeStCard,
  suggestBlockForHeading,
  presetAliasTable,
} from '../shared/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(readFileSync(join(here, 'fixtures/sample-card.json'), 'utf8'));
const defaultPresetRaw = JSON.parse(readFileSync(join(here, '../rules/presets/default.json'), 'utf8'));

function presetWithOrder(blockOrder) {
  const { preset, errors } = parsePreset({ ...defaultPresetRaw, id: 'test-order', blockOrder });
  assert.deepEqual(errors, []);
  return preset;
}

const DEFAULT_PRESET = presetWithOrder(defaultPresetRaw.blockOrder);
/** 非标准顺序：用户相关设定 → 特殊设定 → 基本信息 → 性格 → 其他设定 → 世界书 */
const SHUFFLED = presetWithOrder(['user', 'special', 'basic', 'personality', 'settings', 'worldbook']);

function sampleCard() {
  return parseStCard(sample).card;
}

test('非标准板块顺序：render → parse → render 严格无损', () => {
  const card = sampleCard();
  const text = renderCardText(card, SHUFFLED);
  const result = parseCardText(text, SHUFFLED);
  assert.deepEqual(result.issues, []);
  assert.equal(result.ok, true);
  assert.equal(renderCardText(result.card, SHUFFLED), text);
});

test('非标准板块顺序：解析顺序 = 文件中的出现顺序，不按预设重排', () => {
  const text = renderCardText(sampleCard(), SHUFFLED);
  const { card } = parseCardText(text, SHUFFLED);
  const order = card.blocks
    .filter((block) => block.anchor?.headingSpan)
    .sort((a, b) => a.anchor.headingSpan.start - b.anchor.headingSpan.start)
    .map((block) => block.id);
  assert.deepEqual(order, ['user', 'special', 'basic', 'settings']);
  // description 顺序与文件一致（personality 是独立字段，不在 description 里）
  assert.equal(card.description.raw.indexOf('【用户相关设定】') < card.description.raw.indexOf('【基本信息】'), true);
});

test('非标准板块顺序：导出 ST JSON 不重排，与导入内容一致', () => {
  const text = renderCardText(sampleCard(), SHUFFLED);
  const { card } = parseCardText(text, SHUFFLED);
  const out = serializeStCard(card);
  assert.equal(out.data.description, card.description.raw);
  assert.match(out.data.description, /【用户相关设定】[\s\S]*【基本信息】/);
  // 性格仍在 personality 字段
  assert.equal(out.data.personality, sample.data.personality);
});

test('严格模式（默认）：缺少任一板块即中止导入，报错含板块名、行号、可用别名', () => {
  const full = renderCardText(sampleCard(), DEFAULT_PRESET);
  const withoutSpecial = full.split('\n\n').filter((part) => !part.startsWith('【特殊设定】')).join('\n\n');
  const result = parseCardText(withoutSpecial, DEFAULT_PRESET);
  assert.equal(result.card, null);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['special']);
  const issue = result.issues.find((item) => item.code === 'missing-block');
  assert.equal(issue.severity, 'error');
  assert.equal(issue.blockId, 'special');
  assert.ok(issue.message.includes('特殊设定'));
  assert.ok(issue.message.includes('第'));
  assert.equal(typeof issue.line, 'number');
  assert.ok(issue.hint.includes('特殊设定'));
});

test('严格模式：世界书结构错误同样中止导入', () => {
  const broken = [
    '【基本信息】',
    '年龄 24',
    '【性格】',
    '冷淡',
    '【其他设定】',
    '简洁',
    '【特殊设定】',
    '无',
    '【用户相关设定】',
    '邻居',
    '【世界书】',
    '@@ENTRY 0',
    'keys: a',
    '@@CONTENT',
    'A',
    '@@END 0',
    '',
    '@@ENTRY 0',
    'keys: b',
    '@@CONTENT',
    'B',
    '@@END 0',
  ].join('\n\n');
  const result = parseCardText(broken, DEFAULT_PRESET);
  assert.equal(result.card, null);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'worldbook-error' && issue.message.includes('重复')));
});

test('宽松模式：缺失板块按空块填充，结果中明确警告且块带 missing 标记', () => {
  const full = renderCardText(sampleCard(), DEFAULT_PRESET);
  const withoutSpecial = full.split('\n\n').filter((part) => !part.startsWith('【特殊设定】')).join('\n\n');
  const result = parseCardText(withoutSpecial, DEFAULT_PRESET, { mode: 'lenient' });
  assert.notEqual(result.card, null);
  assert.equal(result.ok, true, '缺失板块只是警告级，不阻断导入');
  assert.deepEqual(result.missing, ['special']);
  const warning = result.issues.find((issue) => issue.code === 'missing-block');
  assert.equal(warning.severity, 'warning');
  assert.ok(warning.message.includes('已按空块处理'));
  const special = result.card.blocks.find((block) => block.id === 'special');
  assert.equal(special.text, '');
  assert.equal(special.missing, true);
  // 正常存在的板块不能带 missing 标记（避免「无声清空」被误判）
  const basic = result.card.blocks.find((block) => block.id === 'basic');
  assert.equal(basic.missing, false);
});

test('未识别标题：给出「最接近板块」猜测提示（繁体 世界書 → 世界书）', () => {
  const text = [
    '【基本信息】',
    '年龄 24',
    '【性格】',
    '冷淡',
    '【其他设定】',
    '简洁',
    '【特殊设定】',
    '无',
    '【用户相关设定】',
    '邻居',
    '【世界書】',
    '@@ENTRY 0',
    'keys: a',
    '@@CONTENT',
    'A',
    '@@END 0',
  ].join('\n\n');
  const result = parseCardText(text, DEFAULT_PRESET);
  const unknown = result.unknownHeadings[0];
  assert.equal(unknown.headingText, '世界書');
  assert.ok(unknown.suggestion);
  assert.equal(unknown.suggestion.blockId, 'worldbook');
  assert.equal(unknown.suggestion.alias, '世界书');
  const issue = result.issues.find((item) => item.code === 'unknown-heading');
  assert.ok(issue.hint.includes('是否想写「世界书」'));
  // 严格模式下确实同时报「世界书缺失」
  assert.ok(result.missing.includes('worldbook'));
});

test('suggestBlockForHeading：距离过远时不猜', () => {
  const aliases = presetAliasTable(DEFAULT_PRESET);
  assert.equal(suggestBlockForHeading('附录', aliases), null);
  assert.equal(suggestBlockForHeading('世界書', aliases).blockId, 'worldbook');
  assert.equal(suggestBlockForHeading('世界設定', aliases).blockId, 'worldbook');
});

test('整卡往返：字面 \\@@ 在 TXT 中严格无损（经世界书 v1.0 转义）', () => {
  const card = sampleCard();
  card.worldbook.entries = [
    { id: 0, keys: ['a'], content: '@@END 0\n\\@@END 0\n\\\\@@END 0' },
  ];
  card.worldbook.text = '';
  const text = renderCardText(card, DEFAULT_PRESET);
  const result = parseCardText(text, DEFAULT_PRESET);
  assert.deepEqual(result.issues, []);
  assert.equal(result.card.worldbook.entries[0].content, '@@END 0\n\\@@END 0\n\\\\@@END 0');
  assert.equal(renderCardText(result.card, DEFAULT_PRESET), text);
});

test('applyCardText：TXT 为事实源——TXT 中删掉的条目即删除，extensions 按 id 挂回', () => {
  const card = sampleCard();
  card.worldbook.entries = [
    { id: 0, keys: ['a'], content: 'A', extensions: { tag: 'A' } },
    { id: 1, keys: ['b'], content: 'B', extensions: { tag: 'B' } },
  ];
  card.worldbook.text = '';
  const full = renderCardText(card, DEFAULT_PRESET);
  // 在 TXT 里删掉 id 0 的整块
  const edited = full.replace(/@@ENTRY 0[\s\S]*?@@END 0\n\n?/, '');
  assert.ok(!edited.includes('@@ENTRY 0'));
  const applied = applyCardText(card, edited, DEFAULT_PRESET);
  assert.equal(applied.ok, true);
  assert.equal(applied.changed, true);
  assert.deepEqual(applied.merge.removed, [0]);
  assert.deepEqual(applied.merge.preserved, [1]);
  assert.deepEqual(applied.card.worldbook.entries.map((entry) => entry.id), [1]);
  assert.deepEqual(applied.card.worldbook.entries[0].extensions, { tag: 'B' });
  assert.equal(applied.card.worldbook.entries[0].content, 'B');
});

test('applyCardText：重排时 extensions 跟随 id 而不是位置', () => {
  const card = sampleCard();
  card.worldbook.entries = [
    { id: 0, keys: ['a'], content: 'A', extensions: { tag: 'A' } },
    { id: 1, keys: ['b'], content: 'B', extensions: { tag: 'B' } },
  ];
  card.worldbook.text = '';
  const edited =
    '@@ENTRY 1\nname: B\nkeys: b\n@@CONTENT\nB2\n@@END 1\n\n@@ENTRY 0\nname: A\nkeys: a\n@@CONTENT\nA2\n@@END 0';
  const full = [
    '【基本信息】',
    '年龄 24',
    '【性格】',
    '冷淡',
    '【其他设定】',
    '简洁',
    '【特殊设定】',
    '无',
    '【用户相关设定】',
    '邻居',
    `【世界书】\n${edited}`,
  ].join('\n\n');
  const applied = applyCardText(card, full, DEFAULT_PRESET);
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.card.worldbook.entries.map((entry) => entry.id), [1, 0]);
  assert.deepEqual(applied.card.worldbook.entries.map((entry) => entry.extensions), [{ tag: 'B' }, { tag: 'A' }]);
  assert.deepEqual(applied.card.worldbook.entries.map((entry) => entry.content), ['B2', 'A2']);
});

test('applyCardText：存在 error 时原样返回原卡片，绝不静默丢数据', () => {
  const card = sampleCard();
  const broken = [
    '【基本信息】',
    '年龄 24',
    '【性格】',
    '冷淡',
    '【其他设定】',
    '简洁',
    '【特殊设定】',
    '无',
    '【用户相关设定】',
    '邻居',
    '【世界书】',
    '@@ENTRY 0',
    'keys: a',
    '@@CONTENT',
    'A',
    '@@END 0',
    '',
    '@@ENTRY 0',
    'keys: b',
    '@@CONTENT',
    'B',
    '@@END 0',
  ].join('\n\n');
  const applied = applyCardText(card, broken, DEFAULT_PRESET);
  assert.equal(applied.ok, false);
  assert.equal(applied.changed, false);
  assert.equal(applied.merge, null);
  // 卡片引用未变，世界书条目一条不少
  assert.deepEqual(applied.card.worldbook.entries, card.worldbook.entries);
});

test('重复标题：后出现的同名板块不开启新板块，内容归入首次出现处并警告', () => {
  const text = [
    '【基本信息】',
    '年龄 24',
    '【基本信息】',
    '重复标题下的内容',
    '【其他设定】',
    '简洁',
    '【性格】',
    '冷淡',
    '【特殊设定】',
    '无',
    '【用户相关设定】',
    '邻居',
    '【世界书】',
  ].join('\n\n');
  const result = parseCardText(text, DEFAULT_PRESET);
  const warning = result.issues.find((issue) => issue.code === 'duplicate-heading');
  assert.ok(warning);
  assert.equal(warning.blockId, 'basic');
  assert.equal(result.card.blocks.find((block) => block.id === 'basic').text.includes('重复标题下的内容'), true);
});

test('空卡片渲染：六个标题都在，严格模式可回读（幂等）', () => {
  const card = sampleCard();
  for (const block of card.blocks) block.text = '';
  card.worldbook.entries = [];
  card.worldbook.text = '';
  const text = renderCardText(card, DEFAULT_PRESET);
  for (const heading of ['【基本信息】', '【性格】', '【其他设定】', '【特殊设定】', '【用户相关设定】', '【世界书】']) {
    assert.ok(text.includes(heading), heading);
  }
  const result = parseCardText(text, DEFAULT_PRESET);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.equal(renderCardText(result.card, DEFAULT_PRESET), text);
});
