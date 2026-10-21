/**
 * T6.2 预设切换 + T6.3 规则导入的测试。
 *
 * 两处都**用 shared 的真实产物**驱动：
 *   · 预设用真实的 rules/presets/*.json；
 *   · 规则导入用真实的 rules/platforms/*.json、rules/highlight/*.json，
 *     坏文件则通过对真实文件做定向破坏得到（而不是手搓一个假结构）。
 *
 * 重点验证两条容易写错的语义：
 *   ① 选择预设 ≠ 重排（原文一个字节都不动）；
 *   ② 导入失败必须原子回退（原规则列表原样返回）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  loadHighlightRules,
  loadPlatformRules,
  loadPresets,
  parseStCard,
  serializeStCard,
  planPresetApply,
  applyPresetPlan,
} from '@tcs/shared';

import {
  groupRuleIssues,
  importHighlightScheme,
  importPlatformRule,
  splitRuleError,
} from '../client/src/rules/rule-library.ts';
import {
  decideApplyPreset,
  describePresets,
  previewPresetSelection,
  selectPreset,
} from '../client/src/rules/preset-switch.ts';

const CARD = parseStCard(
  JSON.parse(readFileSync(new URL('./fixtures/sample-card.json', import.meta.url), 'utf8')),
).card;

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

const PRESETS = loadPresets([
  readJson('../rules/presets/default.json'),
  readJson('../rules/presets/divider.json'),
  readJson('../rules/presets/markdown.json'),
]).presets;

const PLATFORM_FILES = ['sillytavern', 'character-card-v2', 'character-card-v3', 'janitorai', 'chub'].map(
  (name) => readJson(`../rules/platforms/${name}.json`),
);

const HIGHLIGHT_FILES = ['default', 'dark', 'minimal'].map((name) =>
  readJson(`../rules/highlight/${name}.json`),
);

function presetById(id) {
  const found = PRESETS.find((item) => item.id === id);
  assert.ok(found, `预设 ${id} 不存在`);
  return found;
}

// ── 预设：描述与选择 ────────────────────────────────────────

test('预设：三套内置预设都能描述出顺序与分隔符', () => {
  const choices = describePresets(PRESETS);
  assert.equal(choices.length, 3);
  for (const choice of choices) {
    assert.ok(choice.name.length > 0);
    assert.ok(choice.orderLabel.length > 0);
    assert.ok(choice.separatorLabel.length > 0);
  }
  const divider = choices.find((c) => c.id === 'divider');
  assert.match(divider.separatorLabel, /---/, 'divider 预设的分隔符应显示为 ---');
});

test('预设：selectPreset 只产出装配参数，不碰卡片', () => {
  const before = JSON.stringify(CARD);
  const selection = selectPreset(presetById('divider'));
  assert.equal(JSON.stringify(CARD), before, 'selectPreset 不允许修改卡片');
  assert.equal(typeof selection.assembleOptions.heading, 'function');
  assert.ok(selection.assembleOptions.order.length > 0);
});

test('预设：选择后导出用新标题，但原文 description 不变', () => {
  const divider = presetById('divider');
  const selection = selectPreset(divider);

  const exported = serializeStCard(CARD, selection.assembleOptions);
  const exportedDescription = exported.data.description;

  // 原文（card.description.raw）必须一字未改
  assert.equal(CARD.description.raw, parseStCard(
    JSON.parse(readFileSync(new URL('./fixtures/sample-card.json', import.meta.url), 'utf8')),
  ).card.description.raw, '选择预设后原文不应变化');

  // 导出文本里应出现 divider 的标题样式
  const basicHeading = selection.assembleOptions.heading('basic');
  assert.ok(
    exportedDescription.includes(basicHeading),
    `导出应包含 divider 的标题「${basicHeading}」`,
  );
});

test('预设：previewPresetSelection 指出顺序是否会在导出时不同', () => {
  const preview = previewPresetSelection(CARD, presetById('markdown'));
  assert.ok(preview.presentBlocks.length > 0);
  assert.ok(preview.exportOrder.length > 0);
  assert.equal(typeof preview.orderWouldDiffer, 'boolean');
  assert.ok(preview.headingSample, '应有标题示例');
  assert.ok(preview.headingSample.after.length > 0);
});

// ── 预设：应用（唯一重排入口）──────────────────────────────

test('应用预设：无变化时返回 noop，不要求确认', () => {
  const current = presetById('default');
  const decision = decideApplyPreset(CARD, current);
  // sample-card 本身就是 default 格式，所以应当是 noop
  assert.equal(decision.kind, 'noop');
});

test('应用预设：切换到 divider 时要求确认，并给出变更摘要', () => {
  const decision = decideApplyPreset(CARD, presetById('divider'));
  assert.equal(decision.kind, 'confirm');
  if (decision.kind === 'confirm') {
    assert.ok(decision.plan.changed);
    assert.ok(decision.message.length > 0, '必须告诉用户会改什么');
  }
});

test('应用预设：applyPresetPlan 之后原文确实按新预设重排，且可再解析', () => {
  const divider = presetById('divider');
  const plan = planPresetApply(CARD, divider);
  assert.equal(plan.changed, true);

  const applied = applyPresetPlan(CARD, plan);
  assert.notEqual(applied.description.raw, CARD.description.raw, '应用后原文应变化');
  assert.equal(applied.description.separator, divider.separator);

  // 重排后的文本应能被该预设重新解析出同样多的板块
  const reparsedPlan = planPresetApply(applied, divider);
  assert.equal(reparsedPlan.changed, false, '二次应用不应再有变化（幂等）');
});

test('应用预设：只重排 description 侧，性格字段不动', () => {
  const personalityBefore = CARD.blocks.find((b) => b.id === 'personality').text;
  const plan = planPresetApply(CARD, presetById('markdown'));
  const applied = applyPresetPlan(CARD, plan);
  assert.equal(
    applied.blocks.find((b) => b.id === 'personality').text,
    personalityBefore,
    '性格是独立字段，不参与重排',
  );
});

// ── 规则导入：错误解析 ──────────────────────────────────────

test('错误解析：能拆出字段路径、分组与序号', () => {
  const issue = splitRuleError('fields[2].path: 缺少 path');
  assert.equal(issue.where, 'fields[2].path');
  assert.equal(issue.message, '缺少 path');
  assert.equal(issue.group, 'fields');
  assert.equal(issue.index, 2);

  const fileLevel = splitRuleError('规则文件顶层必须是对象');
  assert.equal(fileLevel.where, '');
  assert.equal(fileLevel.message, '规则文件顶层必须是对象');
  assert.equal(fileLevel.group, '');
});

test('错误解析：按 group 归并，文件级排最前', () => {
  const groups = groupRuleIssues([
    splitRuleError('rules[0].severity: severity 只能是 error/warning/info'),
    splitRuleError('字段定义有问题'),
    splitRuleError('fields[1].label: 缺少 label'),
  ]);
  const byGroup = Object.fromEntries(groups.map((g) => [g.group, g]));
  assert.ok(byGroup.fields);
  assert.ok(byGroup.rules);
  assert.equal(byGroup.fields.items.length, 1);
});

// ── 规则导入：平台规则（原子回退）────────────────────────────

test('平台规则：导入合法文件后进入列表并可按 id 解析', () => {
  const custom = { ...readJson('../rules/platforms/sillytavern.json'), id: 'custom-a', name: '自定义 A' };
  const result = importPlatformRule(PLATFORM_FILES, JSON.stringify(custom));
  assert.equal(result.ok, true);
  assert.equal(result.id, 'custom-a');
  assert.equal(result.value.length, PLATFORM_FILES.length + 1);
});

test('平台规则：非法 JSON → 原子回退，原列表一字不改', () => {
  const before = JSON.stringify(PLATFORM_FILES);
  const result = importPlatformRule(PLATFORM_FILES, '{ "id": "x", ');
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result.value), before, '失败必须原样返回');
  assert.ok(result.issues.length > 0);
  assert.match(result.issues[0].message, /JSON 解析失败/);
});

test('平台规则：schema 不合法 → 错误带字段位置', () => {
  const broken = { ...readJson('../rules/platforms/sillytavern.json'), id: 'Bad Id!' };
  const result = importPlatformRule(PLATFORM_FILES, JSON.stringify(broken));
  assert.equal(result.ok, false);
  assert.ok(result.issues.length > 0);
  const idIssue = result.issues.find((issue) => /id/.test(issue.message));
  assert.ok(idIssue, '应指出 id 有问题');
});

test('平台规则：继承链断掉 → 拒绝导入（不等到切换时才炸）', () => {
  const orphan = {
    ...readJson('../rules/platforms/sillytavern.json'),
    id: 'orphan-rule',
    name: '断链规则',
    extends: 'no-such-parent',
  };
  const result = importPlatformRule(PLATFORM_FILES, JSON.stringify(orphan));
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].group, 'extends');
  assert.match(result.issues[0].message, /继承链无法解析/);
});

test('平台规则：同 id 重复导入是替换而非追加', () => {
  const again = { ...readJson('../rules/platforms/sillytavern.json'), name: '改过名字' };
  const result = importPlatformRule(PLATFORM_FILES, JSON.stringify(again));
  assert.equal(result.ok, true);
  assert.equal(result.value.length, PLATFORM_FILES.length, '同 id 应覆盖');
  assert.equal(result.value.find((r) => r.id === 'sillytavern').name, '改过名字');
});

// ── 规则导入：高亮方案（原子回退 + 必须可编译）────────────────

test('高亮：导入合法方案后能编译出规则集', () => {
  const custom = { ...readJson('../rules/highlight/minimal.json'), id: 'custom-hl', name: '自定义高亮' };
  const result = importHighlightScheme(HIGHLIGHT_FILES[0], HIGHLIGHT_FILES, JSON.stringify(custom));
  assert.equal(result.ok, true);
  assert.equal(result.id, 'custom-hl');
  assert.ok(result.compiled, '成功时必须给出编译结果');
  assert.ok(result.resolved);
});

test('高亮：坏 JSON → 回退到原方案，compiled 为空', () => {
  const current = HIGHLIGHT_FILES[0];
  const result = importHighlightScheme(current, HIGHLIGHT_FILES, '{ oops');
  assert.equal(result.ok, false);
  assert.equal(result.value, current, '应原样返回当前方案');
  assert.equal(result.compiled, null);
});

test('高亮：正则编不过的方案被拒绝（否则整个编辑器高亮会失效）', () => {
  const base = readJson('../rules/highlight/minimal.json');
  const broken = {
    ...base,
    id: 'bad-regex',
    rules: [{ ...base.rules[0], match: { type: 'regex', pattern: '([unclosed' } }],
  };
  const result = importHighlightScheme(HIGHLIGHT_FILES[0], HIGHLIGHT_FILES, JSON.stringify(broken));
  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some((issue) => /正则|编译/.test(issue.message)),
    `应指出正则/编译问题，实际：${JSON.stringify(result.issues)}`,
  );
});

test('高亮：schema 缺字段 → 错误带位置，且原方案不变', () => {
  const base = readJson('../rules/highlight/minimal.json');
  const broken = { ...base, id: 'no-scopes', scopes: [], rules: [{ ...base.rules[0], scope: 'nope' }] };
  const result = importHighlightScheme(HIGHLIGHT_FILES[0], HIGHLIGHT_FILES, JSON.stringify(broken));
  assert.equal(result.ok, false);
  assert.equal(result.value, HIGHLIGHT_FILES[0]);
  assert.ok(result.issues.length > 0);
});

test('真实规则文件全部能加载（基线自检，防止 fixture 漂移）', () => {
  assert.equal(loadPlatformRules(PLATFORM_FILES).errors.length, 0);
  assert.equal(loadHighlightRules(HIGHLIGHT_FILES).errors.length, 0);
  assert.equal(PRESETS.length, 3);
});

test('预设预览：原文标题取完整标题行，能看出与预设的差异', () => {
  const preview = previewPresetSelection(CARD, presetById('divider'));
  assert.ok(preview.headingSample);

  // 原文标题行应含装饰符（【】），否则和预设的渲染结果看起来一样，用户看不出差异
  assert.match(
    preview.headingSample.before,
    /^【.+】$/,
    '原文标题应含【】',
  );
  assert.ok(preview.headingSample.after.length > 0);

  // 隔离回归：不能用 headingText（只有内文，不含装饰符）
  const block = CARD.blocks.find((b) => b.id === preview.headingSample.blockId);
  assert.notEqual(
    preview.headingSample.before,
    block.anchor.headingText,
    '不能用 headingText 冒充原文标题行',
  );
});

test('预设预览：分隔符显示为可读文本而非 JSON 转义串', () => {
  const preview = previewPresetSelection(CARD, presetById('divider'));
  assert.ok(!preview.separatorBeforeLabel.includes('\\n'), '不应出现转义串');
  assert.match(preview.separatorAfterLabel, /---/, 'divider 预设应显示为 ---');
});

test('预设预览：导出顺序显示中文名而非内部 id', () => {
  const preview = previewPresetSelection(CARD, presetById('divider'));
  assert.ok(!/\bbasic\b|\bpersonality\b/.test(preview.exportOrderLabel), '不应出现内部 id');
  assert.match(preview.exportOrderLabel, /基本/);
});

test('语义：已有原文时，选择预设不改变导出（只有应用预设才重排）', () => {
  const divider = presetById('divider');
  const preview = previewPresetSelection(CARD, divider);
  assert.equal(preview.affectsExport, false, '已有原文时不应声称会影响导出');
  assert.match(preview.effectNote, /已有原文/);

  // 事实核验：换预设施加装配参数，导出文本不变
  const withDefault = serializeStCard(CARD, selectPreset(presetById('default')).assembleOptions);
  const withDivider = serializeStCard(CARD, selectPreset(divider).assembleOptions);
  const withMarkdown = serializeStCard(CARD, selectPreset(presetById('markdown')).assembleOptions);
  assert.equal(withDivider.data.description, withDefault.data.description);
  assert.equal(withMarkdown.data.description, withDefault.data.description);
});

test('语义：空卡时，装配参数确实决定导出标题', () => {
  const empty = parseStCard(JSON.parse(readFileSync(new URL('./fixtures/sample-card.json', import.meta.url), 'utf8'))).card;
  // 造一张"无原文"的卡：只保留板块正文，清空 raw
  const fresh = {
    ...empty,
    description: { raw: '', separator: '\n\n', structured: false, preface: '' },
  };

  const preview = previewPresetSelection(fresh, presetById('markdown'));
  assert.equal(preview.affectsExport, true, '无原文时应提示会影响导出');
  assert.match(preview.effectNote, /还没有原文/);

  const markdownOut = serializeStCard(fresh, selectPreset(presetById('markdown')).assembleOptions);
  const defaultOut = serializeStCard(fresh, selectPreset(presetById('default')).assembleOptions);
  assert.notEqual(
    markdownOut.data.description,
    defaultOut.data.description,
    'markdown 与 default 的标题样式不同，导出应可区分',
  );
  assert.match(markdownOut.data.description, /## /, 'markdown 预设应导出 ## 标题');
});
