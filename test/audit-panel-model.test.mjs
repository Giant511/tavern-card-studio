/**
 * 审计面板视图模型测试（T6.5）。
 *
 * 用**真实报告**驱动：`buildAuditReport` 跑一遍 sample-card + 五份平台规则，
 * 不手搓 AuditIssue 结构——否则测的是我想象的格式，不是 shared 实际产出的格式。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  buildAuditReport,
  loadPlatformRules,
  loadPresets,
  parseStCard,
  resolvePlatformRule,
} from '@tcs/shared';

import {
  EMPTY_FILTER,
  buildWordBars,
  countByCategory,
  countBySeverity,
  filterIssues,
  filterSummary,
  groupIssues,
  sortIssues,
  summaryText,
} from '../client/src/audit/audit-model.ts';

const CARD = parseStCard(
  JSON.parse(readFileSync(new URL('./fixtures/sample-card.json', import.meta.url), 'utf8')),
).card;

const PLATFORM_RULES = loadPlatformRules(
  ['sillytavern', 'character-card-v2', 'character-card-v3', 'janitorai', 'chub'].map((name) =>
    JSON.parse(readFileSync(new URL(`../rules/platforms/${name}.json`, import.meta.url), 'utf8')),
  ),
).rules;

const PRESET = loadPresets([
  JSON.parse(readFileSync(new URL('../rules/presets/default.json', import.meta.url), 'utf8')),
]).presets[0];

function reportFor(platformId, card = CARD) {
  return buildAuditReport(card, {
    platformRule: resolvePlatformRule(platformId, PLATFORM_RULES),
    preset: PRESET,
  });
}

// ── 过滤 ────────────────────────────────────────────────────

test('过滤：默认条件不筛掉任何问题', () => {
  const report = reportFor('sillytavern');
  const shown = filterIssues(report.issues, EMPTY_FILTER);
  assert.equal(shown.length, report.issues.length);
});

test('过滤：按严重度', () => {
  const report = reportFor('janitorai');
  const errors = filterIssues(report.issues, {
    ...EMPTY_FILTER,
    severities: new Set(['error']),
  });
  assert.ok(errors.every((issue) => issue.severity === 'error'));
  assert.equal(errors.length, countBySeverity(report.issues).error);
});

test('过滤：按类别', () => {
  const report = reportFor('janitorai');
  const format = filterIssues(report.issues, {
    ...EMPTY_FILTER,
    categories: new Set(['format']),
  });
  assert.ok(format.every((issue) => issue.category === 'format'));
});

test('过滤：按板块，含「只看全文级」', () => {
  const report = reportFor('sillytavern');

  const settings = filterIssues(report.issues, { ...EMPTY_FILTER, blockId: 'settings' });
  assert.ok(settings.every((issue) => issue.location.blockId === 'settings'));

  const globalOnly = filterIssues(report.issues, { ...EMPTY_FILTER, blockId: null });
  assert.ok(globalOnly.every((issue) => issue.location.blockId === null));
  assert.ok(globalOnly.length > 0, '样本卡应有全文级问题（字段缺失等）');
});

test('过滤：关键字命中 message / hint / 命中文本', () => {
  const report = reportFor('sillytavern');
  const hit = filterIssues(report.issues, { ...EMPTY_FILTER, query: '占位符' });
  assert.ok(hit.length > 0);
  assert.ok(hit.every((issue) => /占位符/.test(issue.message) || /占位符/.test(issue.hint ?? '')));

  const none = filterIssues(report.issues, { ...EMPTY_FILTER, query: '这字符串一定不存在xyzzy' });
  assert.equal(none.length, 0);
});

test('过滤：多个条件是与关系', () => {
  const report = reportFor('janitorai');
  const both = filterIssues(report.issues, {
    ...EMPTY_FILTER,
    severities: new Set(['error', 'warning']),
    categories: new Set(['platform-rule']),
  });
  assert.ok(both.every((issue) => issue.category === 'platform-rule' && issue.severity !== 'info'));
});

// ── 排序 ────────────────────────────────────────────────────

test('排序：错误在前，同严重度内按板块顺序，全文级排最后', () => {
  const report = reportFor('janitorai');
  const sorted = sortIssues(report.issues);

  const weights = { error: 0, warning: 1, info: 2 };
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(
      weights[sorted[i - 1].severity] <= weights[sorted[i].severity],
      '严重度必须单调不减',
    );
  }

  const firstGlobal = sorted.findIndex((issue) => issue.location.blockId === null);
  if (firstGlobal !== -1) {
    const after = sorted.slice(firstGlobal);
    assert.ok(
      after.every((issue) => issue.location.blockId === null),
      '全文级问题必须集中在末尾',
    );
  }
});

// ── 分组 ────────────────────────────────────────────────────

test('分组：按板块，顺序同 BLOCK_IDS，全文组在最后', () => {
  const report = reportFor('sillytavern');
  const groups = groupIssues(sortIssues(report.issues), 'block');

  const blockOrder = ['basic', 'personality', 'settings', 'special', 'user', 'worldbook'];
  const positions = groups
    .filter((group) => group.key !== '__global__')
    .map((group) => blockOrder.indexOf(group.key));

  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i - 1] < positions[i], '板块分组必须按固定顺序');
  }

  const globalIndex = groups.findIndex((group) => group.key === '__global__');
  if (globalIndex !== -1) {
    assert.equal(globalIndex, groups.length - 1, '「全文」组必须在最后');
  }

  // 分组不漏问题
  const total = groups.reduce((sum, group) => sum + group.issues.length, 0);
  assert.equal(total, report.issues.length);
});

test('分组：按类别，组内最严重度正确', () => {
  const report = reportFor('janitorai');
  const groups = groupIssues(report.issues, 'category');
  assert.ok(groups.length > 0);

  for (const group of groups) {
    const severities = new Set(group.issues.map((issue) => issue.severity));
    if (group.worstSeverity === 'error') assert.ok(severities.has('error'));
    if (group.worstSeverity === 'warning') assert.ok(!severities.has('error') && severities.has('warning'));
  }

  const total = groups.reduce((sum, group) => sum + group.issues.length, 0);
  assert.equal(total, report.issues.length);
});

test('分组：none 模式只返回一组，标题固定', () => {
  const report = reportFor('sillytavern');
  const groups = groupIssues(report.issues, 'none');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'all');
  assert.equal(groups[0].issues.length, report.issues.length);
});

// ── 计数与摘要 ──────────────────────────────────────────────

test('计数：严重度与 summary 一致', () => {
  const report = reportFor('janitorai');
  const counts = countBySeverity(report.issues);
  assert.equal(counts.error, report.summary.error);
  assert.equal(counts.warning, report.summary.warning);
  assert.equal(counts.info, report.summary.info);
});

test('计数：类别取报告自带 byCategory', () => {
  const report = reportFor('sillytavern');
  const counts = countByCategory(report);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.equal(total, report.issues.length, '类别计数之和应等于问题总数');
});

test('摘要：含不可导出标记', () => {
  const report = reportFor('sillytavern');
  const text = summaryText(report);
  assert.match(text, /错误 \d+/);
  assert.match(text, /可导出|不可导出/);
});

test('摘要：筛选后描述区分总量与筛出量', () => {
  assert.equal(filterSummary(10, 10), '共 10 条');
  assert.equal(filterSummary(10, 3), '筛出 3 / 10 条');
});

// ── 字数分布 ────────────────────────────────────────────────

test('字数：六板块都出现，百分比在合理范围', () => {
  const report = reportFor('sillytavern');
  const bars = buildWordBars(report);

  assert.equal(bars.length, 6);
  for (const bar of bars) {
    assert.ok(bar.percent >= 0 && bar.percent <= 100);
    assert.ok(bar.share >= 0 && bar.share <= 100);
    assert.ok(bar.label.length > 0);
  }

  // 字数最多的板块 percent 必须是 100
  const maxChars = Math.max(...bars.map((bar) => bar.chars));
  const maxBar = bars.find((bar) => bar.chars === maxChars);
  assert.equal(maxBar.percent, 100);

  // share 之和应接近 100（存在四舍五入误差）
  const shareSum = bars.reduce((sum, bar) => sum + bar.share, 0);
  assert.ok(Math.abs(shareSum - 100) < 1, `占比之和应 ≈100，实际 ${shareSum}`);
});

test('字数：与报告 total 口径一致', () => {
  const report = reportFor('sillytavern');
  const bars = buildWordBars(report);
  const sum = bars.reduce((acc, bar) => acc + bar.chars, 0);
  assert.equal(sum, report.wordCount.total.chars);
});
