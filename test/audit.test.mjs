/**
 * 阶段 4 测试：字数统计（T4.1）/ 字段完整性两级语义（T4.2）/ 格式规范检查（T4.3）/ 审计报告（T4.4）
 *
 * 运行：node --test test/audit.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  parseStCard,
  loadPlatformRules,
  resolvePlatformRule,
  loadPresets,
  findPreset,
  countCardWords,
  countBlockWords,
  collectOmittedDefaults,
  isStDefaultField,
  checkJsonValidity,
  checkPresetConformance,
  checkWorldbookFormat,
  checkStDefaults,
  checkFormat,
  buildAuditReport,
  stringifyAuditReport,
  describeIssueLocation,
  groupIssues,
  filterBySeverity,
} from '../shared/dist/index.js';

const ROOT = join(import.meta.dirname, '..');

function loadPlatform(id) {
  const inputs = readdirSync(join(ROOT, 'rules', 'platforms'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(ROOT, 'rules', 'platforms', name), 'utf8')));
  return resolvePlatformRule(id, loadPlatformRules(inputs).rules);
}

function loadPreset(id) {
  const inputs = readdirSync(join(ROOT, 'rules', 'presets'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(ROOT, 'rules', 'presets', name), 'utf8')));
  return findPreset(loadPresets(inputs).presets, id);
}

const DEFAULT_PRESET = loadPreset('default');
const JANITORAI = loadPlatform('janitorai');
const CCV2 = loadPlatform('ccv2');

function sampleCard() {
  const raw = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'sample-card.json'), 'utf8'));
  return parseStCard(raw).card;
}

function makeCard(overrides = {}) {
  return parseStCard({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '示例角色',
      description: '【基本信息】\n年龄 24\n\n【特殊设定】\n她从不进厨房。',
      personality: '冷淡',
      scenario: '',
      first_mes: '你来啦。',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: ['原创'],
      creator: '',
      character_version: '',
      extensions: {},
      ...overrides,
    },
  }).card;
}

// ---------------------------------------------------------------- T4.1

test('T4.1 字数统计：六板块分布 + 合计 = 各板块之和', () => {
  const card = sampleCard();
  const report = countCardWords(card);

  assert.deepEqual(report.blocks.map((block) => block.blockId), [
    'basic', 'personality', 'settings', 'special', 'user', 'worldbook',
  ]);
  assert.equal(report.blocks[0].label, '基本信息');

  const sum = report.blocks.reduce((acc, block) => acc + block.chars, 0);
  assert.equal(report.total.chars, sum);
  const sumNoSpace = report.blocks.reduce((acc, block) => acc + block.charsNoSpace, 0);
  assert.equal(report.total.charsNoSpace, sumNoSpace);
  // 每块 totalWords = cjk + words
  for (const block of report.blocks) {
    assert.equal(block.totalWords, block.cjk + block.words);
    assert.ok(block.chars >= block.charsNoSpace);
  }
  assert.ok(report.total.chars > 0);
});

test('T4.1 世界书按 entries 计（不含 @@ENTRY / keys: 等标记）', () => {
  const card = makeCard({
    character_book: {
      entries: [{ id: 0, keys: ['咖啡馆'], content: '咖啡馆位于银座四丁目。' }],
    },
  });
  const report = countCardWords(card);
  const worldbook = report.blocks.find((block) => block.blockId === 'worldbook');
  // keys + content = 「咖啡馆」+「咖啡馆位于银座四丁目。」= 3 + 12 = 15 字符
  assert.equal(worldbook.chars, 15);
  assert.equal(worldbook.empty, false);

  // TXT 表示里含标记，字数不应按 TXT 走
  const textLength = card.worldbook.text.length;
  assert.ok(textLength > worldbook.chars, `TXT(${textLength}) 应长于净字数(${worldbook.chars})`);
  assert.equal(countBlockWords(card, 'worldbook').chars, 15);
});

test('T4.1 byField 口径与落盘字段一致', () => {
  const card = sampleCard();
  const report = countCardWords(card);
  const nonPersonality = report.blocks.filter((block) => block.blockId !== 'personality' && block.blockId !== 'worldbook');
  const expected = nonPersonality.reduce((acc, block) => acc + block.chars, 0);
  assert.equal(report.byField.description.chars, expected);
  assert.equal(report.byField.personality.chars, report.blocks.find((block) => block.blockId === 'personality').chars);
  assert.equal(report.byField.character_book.chars, report.blocks.find((block) => block.blockId === 'worldbook').chars);
});

test('T4.1 空板块与缺失板块可区分（empty / missing）', () => {
  const card = makeCard();
  const empty = card.blocks.find((block) => block.id === 'settings');
  empty.text = '';
  const missing = card.blocks.find((block) => block.id === 'special');
  missing.text = '';
  missing.missing = true;

  const report = countCardWords(card);
  const settings = report.blocks.find((block) => block.blockId === 'settings');
  const special = report.blocks.find((block) => block.blockId === 'special');
  assert.equal(settings.empty, true);
  assert.equal(settings.missing, false);
  assert.equal(special.empty, true);
  assert.equal(special.missing, true, '导入时不存在的板块必须能被 UI 单独标记');
});

// ---------------------------------------------------------------- T4.2 / T4.3 缺省字段

test('T4.2 name 缺失 → error 且阻断导出；有缺省值的字段未写出 → info', () => {
  const card = makeCard({ name: '' });
  const issues = buildAuditReport(card, { platformRule: JANITORAI, preset: DEFAULT_PRESET }).issues;

  const nameIssue = issues.find((issue) => issue.ruleId === 'builtin:field-required:meta.name');
  assert.ok(nameIssue);
  assert.equal(nameIssue.severity, 'error');
  assert.equal(nameIssue.category, 'completeness');

  const defaultIssues = issues.filter((issue) => issue.ruleId === 'builtin:st-defaults-omitted');
  assert.equal(defaultIssues.length, 1);
  assert.equal(defaultIssues[0].severity, 'info');
});

test('T4.3 缺省字段处理证明：只产 1 条 info，不报 error、不阻断导出、不回写 JSON', () => {
  const card = makeCard({
    character_book: {
      entries: [
        // 故意不写 constant / selective / insertion_order / position / priority
        { id: 0, keys: ['咖啡馆'], content: 'A' },
        { id: 1, keys: ['耳钉'], content: 'B' },
      ],
    },
  });

  const omitted = collectOmittedDefaults(card);
  const paths = omitted.map((item) => item.field.path);
  for (const expected of ['talkativeness', 'fav', 'constant', 'selective', 'insertion_order']) {
    assert.ok(paths.includes(expected), `应列出缺省字段 ${expected}：${paths.join(',')}`);
  }
  const constant = omitted.find((item) => item.field.path === 'constant');
  assert.equal(constant.count, 2, '两条目都缺 constant → 汇总成 1 条、count=2');
  assert.deepEqual(constant.entryIds, [0, 1]);
  assert.ok(isStDefaultField('constant'));
  assert.ok(!isStDefaultField('name'));

  const defaults = checkStDefaults(card);
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0].severity, 'info');
  assert.ok(defaults[0].message.includes('constant'));

  const report = buildAuditReport(card, { platformRule: CCV2, preset: DEFAULT_PRESET });
  const severityOfDefaults = report.issues.filter((issue) => issue.ruleId === 'builtin:st-defaults-omitted');
  assert.equal(severityOfDefaults.length, 1);
  assert.equal(severityOfDefaults[0].severity, 'info');
  assert.equal(report.summary.exportable, true, '缺省字段未写出不得阻断导出');

  // 不回写：结构化数据里仍然没有这些键
  const serialized = JSON.stringify(card.worldbook.entries);
  assert.ok(!serialized.includes('"constant"'));
  assert.ok(!serialized.includes('"insertion_order"'));
});

test('T4.3 关闭 includeStDefaults 后缺省提示消失', () => {
  const card = makeCard();
  const withInfo = buildAuditReport(card, { platformRule: CCV2 });
  const without = buildAuditReport(card, { platformRule: CCV2, includeStDefaults: false });
  assert.ok(withInfo.issues.some((issue) => issue.ruleId === 'builtin:st-defaults-omitted'));
  assert.ok(!without.issues.some((issue) => issue.ruleId === 'builtin:st-defaults-omitted'));
});

// ---------------------------------------------------------------- T4.3 其他检查

test('T4.3 原始 JSON 非法 → error 并中止（不产生后续检查）', () => {
  const card = makeCard();
  const issues = checkJsonValidity(card, '{ "spec": "chara_card_v2", ');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].ruleId, 'builtin:json-invalid');
  assert.equal(issues[0].severity, 'error');
  assert.equal(issues[0].location.field, 'file');

  const clean = checkJsonValidity(card, '{"spec":"chara_card_v2","data":{}}');
  assert.deepEqual(clean, []);
});

test('T4.3 标题装饰符与预设不一致 → info（解析不受影响）', () => {
  const card = makeCard({
    description: '## 基本信息\n年龄 24\n\n## 特殊设定\n她从不进厨房。',
  });
  const issues = checkPresetConformance(card, DEFAULT_PRESET);
  const decorators = issues.filter((issue) => issue.ruleId === 'builtin:preset-heading-decorator');
  assert.equal(decorators.length, 2);
  assert.equal(decorators[0].severity, 'info');
  assert.ok(decorators[0].message.includes('预设「【基本信息】」'));

  // 别名仍是预设内的文案，所以不会报别名问题
  assert.ok(!issues.some((issue) => issue.ruleId === 'builtin:preset-heading-alias'));
});

test('T4.3 标题别名不在预设中 → warning 并给出可用别名', () => {
  // 「角色档案」能被内置别名表识别为 basic，但自定义预设只认「基本信息」→ 换预设就认不出来
  const card = makeCard({ description: '【角色档案】\n年龄 24' });
  const fake = {
    ...DEFAULT_PRESET,
    headings: { ...DEFAULT_PRESET.headings, basic: { pattern: '【{title}】', aliases: ['基本信息'] } },
  };
  const issues = checkPresetConformance(card, fake);
  const alias = issues.find((issue) => issue.ruleId === 'builtin:preset-heading-alias');
  assert.ok(alias, JSON.stringify(issues.map((issue) => issue.ruleId)));
  assert.equal(alias.severity, 'warning');
  assert.equal(alias.location.blockId, 'basic');
  assert.ok(alias.hint.includes('基本信息'));
});

test('T4.3 板块顺序与预设不一致 → info，且明确提示不会自动重排', () => {
  const card = makeCard({
    description: '【用户相关设定】\n{{user}} 是邻居\n\n【基本信息】\n年龄 24',
  });
  const issues = checkPresetConformance(card, DEFAULT_PRESET);
  const order = issues.find((issue) => issue.ruleId === 'builtin:block-order');
  assert.ok(order);
  assert.equal(order.severity, 'info');
  assert.ok(order.hint.includes('不会主动重排'));
});

test('T4.3 世界书 TXT 重复 id → error，带行号与偏移', () => {
  const card = makeCard({
    character_book: {
      entries: [
        { id: 0, keys: ['a'], content: 'A' },
        { id: 1, keys: ['b'], content: 'B' },
      ],
    },
  });
  card.worldbook.text = ['@@ENTRY 0', 'keys: a', '@@CONTENT', 'A', '@@END 0', '', '@@ENTRY 0', 'keys: b', '@@CONTENT', 'B', '@@END 0'].join('\n');

  const issues = checkWorldbookFormat(card);
  const duplicate = issues.find((issue) => issue.ruleId === 'builtin:worldbook-duplicate-id');
  assert.ok(duplicate, JSON.stringify(issues));
  assert.equal(duplicate.severity, 'error');
  assert.equal(duplicate.location.line, 7);
  assert.equal(duplicate.location.column, 1);
  assert.equal(duplicate.location.entryId, 0);
  assert.equal(card.worldbook.text.slice(duplicate.location.start, duplicate.location.end), '@@ENTRY 0');

  // 结构化侧重复 id 也能查出来
  const structured = makeCard({ character_book: { entries: [{ id: 3, keys: ['a'], content: 'A' }, { id: 3, keys: ['b'], content: 'B' }] } });
  const dup2 = checkWorldbookFormat(structured).find((issue) => issue.ruleId === 'builtin:worldbook-duplicate-entry-id');
  assert.ok(dup2);
  assert.equal(dup2.severity, 'error');
});

// ---------------------------------------------------------------- T4.4

test('T4.4 报告是纯 JSON（可 parse、无 Map/函数）且字段齐全', () => {
  const card = sampleCard();
  const report = buildAuditReport(card, {
    platformRule: JANITORAI,
    preset: DEFAULT_PRESET,
    rawJsonText: '{"spec":"chara_card_v2"}',
    now: () => '2026-10-21T04:00:00.000Z',
  });

  const roundTrip = JSON.parse(stringifyAuditReport(report));
  assert.deepEqual(roundTrip, JSON.parse(JSON.stringify(report)));

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.generatedAt, '2026-10-21T04:00:00.000Z');
  assert.equal(report.platformRule.id, 'janitorai');
  assert.ok(report.platformRule.lineage.includes('ccv2'));
  assert.equal(report.presetId, 'default');
  assert.equal(typeof report.card.name, 'string');
  assert.ok(report.wordCount.blocks.length === 6);
  assert.deepEqual(Object.keys(report.summary).sort(), ['error', 'exportable', 'info', 'warning']);
  // T10.9：新增 worldbook 类别 —— 世界书的条目结构 / id / 触发键问题
  // 不再混在「格式」里（混在一起时面板上"格式 12 条"看不出到底是排版还是条目坏了）
  assert.deepEqual(Object.keys(report.byCategory).sort(), [
    'completeness',
    'format',
    'platform-rule',
    'structure',
    'worldbook',
  ]);
});

test('T4.4 每条问题都携带位置信息（blockId/field/start/end/line/column 键齐全）', () => {
  const card = makeCard({ name: '' });
  const report = buildAuditReport(card, { platformRule: JANITORAI, preset: DEFAULT_PRESET });
  assert.ok(report.issues.length >= 3);

  for (const issue of report.issues) {
    const keys = Object.keys(issue.location).sort();
    for (const key of ['blockId', 'column', 'end', 'field', 'line', 'start']) {
      assert.ok(keys.includes(key), `${issue.ruleId} 的 location 缺少 ${key}：${keys.join(',')}`);
    }
    assert.ok(typeof issue.id === 'string' && issue.id.length > 0);
    assert.ok(['completeness', 'format', 'platform-rule', 'structure'].includes(issue.category));
    // aggregate 问题允许全 null，其余至少要能定位到板块或字段
    if (!issue.aggregate) {
      assert.ok(
        issue.location.blockId !== null || issue.location.field !== null,
        `${issue.ruleId} 既无 blockId 也无 field`,
      );
    }
  }
});

test('T4.4 板块内违规：行号/列号/偏移与实际文本对得上（点击定位）', () => {
  const card = makeCard({
    description: '【特殊设定】\n第一行\n第二行\n<BOT> 出现在第三行',
  });
  const report = buildAuditReport(card, { platformRule: JANITORAI, preset: DEFAULT_PRESET });
  const hit = report.issues.find((issue) => issue.ruleId === 'forbid-angle-tags');
  assert.ok(hit, JSON.stringify(report.issues.map((issue) => issue.ruleId)));

  const block = card.blocks.find((item) => item.id === 'special');
  assert.equal(hit.location.blockId, 'special');
  assert.equal(hit.location.line, 3);
  assert.equal(hit.location.column, 1);
  assert.equal(block.text.slice(hit.location.start, hit.location.end), '<BOT>');
  assert.equal(hit.location.lineText, '<BOT> 出现在第三行');
  assert.equal(describeIssueLocation(hit), '特殊设定 · 第 3 行第 1 列');
});

test('T4.4 全文合计问题：位置全 null，分组落在「无归属」而非某个板块', () => {
  const card = makeCard({ description: '【基本信息】\n年龄 24' });
  const report = buildAuditReport(card, { platformRule: JANITORAI, preset: DEFAULT_PRESET });
  const aggregate = report.issues.find((issue) => issue.aggregate);
  assert.ok(aggregate);
  assert.equal(aggregate.location.blockId, null);
  assert.equal(aggregate.location.start, null);
  assert.equal(aggregate.location.line, null);
  assert.equal(describeIssueLocation(aggregate), '全文');

  const groups = groupIssues(report.issues);
  const grouped = [...groups.byBlock.values()].flat();
  assert.ok(!grouped.some((issue) => issue.aggregate), 'aggregate 问题不应出现在任何板块分组里');
  assert.ok(groups.unscoped.some((issue) => issue.aggregate));
});

test('T4.4 分组与筛选：按板块/字段/全文三路，按严重级过滤', () => {
  const card = makeCard({ name: '' });
  const report = buildAuditReport(card, { platformRule: JANITORAI, preset: DEFAULT_PRESET });
  const groups = groupIssues(report.issues);

  for (const [blockId, list] of groups.byBlock) {
    assert.ok(list.every((issue) => issue.location.blockId === blockId));
  }
  for (const [field, list] of groups.byField) {
    assert.ok(list.every((issue) => issue.location.field === field));
  }
  const total = [...groups.byBlock.values(), ...groups.byField.values()].reduce((acc, list) => acc + list.length, 0) + groups.unscoped.length;
  assert.equal(total, report.issues.length);

  const errorsOnly = filterBySeverity(report.issues, 'error');
  assert.ok(errorsOnly.length > 0);
  assert.ok(errorsOnly.every((issue) => issue.severity === 'error'));
  assert.ok(filterBySeverity(report.issues, 'warning').length >= errorsOnly.length);
});

test('T4.4 报告可复现：同一输入两次审计（除时间戳外）完全一致', () => {
  const card = sampleCard();
  const options = {
    platformRule: JANITORAI,
    preset: DEFAULT_PRESET,
    now: () => '2026-10-21T04:00:00.000Z',
  };
  const a = buildAuditReport(card, options);
  const b = buildAuditReport(card, options);
  assert.equal(stringifyAuditReport(a), stringifyAuditReport(b));
});

test('T4.4 checkFormat 汇总三类检查，error 会反映到 exportable', () => {
  const card = makeCard({
    character_book: {
      entries: [
        { id: 0, keys: ['a'], content: 'A' },
        { id: 1, keys: ['b'], content: 'B' },
      ],
    },
  });
  card.worldbook.text = ['@@ENTRY 0', 'keys: a', '@@CONTENT', 'A', '@@END 0', '', '@@ENTRY 0', 'keys: b', '@@CONTENT', 'B', '@@END 0'].join('\n');

  const issues = checkFormat(card, { preset: DEFAULT_PRESET });
  assert.ok(issues.some((issue) => issue.ruleId === 'builtin:worldbook-duplicate-id'));

  const report = buildAuditReport(card, { platformRule: CCV2, preset: DEFAULT_PRESET });
  assert.equal(report.summary.exportable, false, '存在重复 id 时不可导出');
  assert.equal(report.summary.error, report.issues.filter((issue) => issue.severity === 'error').length);
});
