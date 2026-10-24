/**
 * T10.9 世界书审计（`worldbook` 类别）：条目结构 / id / 触发键。
 *
 * 这一组检查的价值在于「导出正常、运行时无效」：
 *   · `keys: []` 且 `constant: false` 的条目**永远不会被触发**，
 *     但导出、校验、diff 都看不出异常 —— 只有审计能发现；
 *   · 重复 id 会让 `extensions` 归属不确定（合并按 id 匹配）；
 *   · 缺 id 不算错（导出会自动补号），但用户该知道"保存会改动文件"。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkWorldbookFormat,
  checkWorldbookStructure,
  createEmptyCard,
  parseStCard,
  resolvePlatformRule,
} from '../shared/dist/index.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SAMPLE = parseStCard(
  JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'sample-card.json'), 'utf8')),
).card;

function withEntries(entries) {
  const card = structuredClone(SAMPLE);
  card.worldbook = { entries, text: '', dirty: false, raw: null };
  return card;
}

const ruleIds = (issues) => issues.map((issue) => issue.ruleId);

/**
 * T10.33：触发键 / 空关键词 / selective / position / insertion_order 这些**语义**判据
 * 已从结构检查迁到「默认世界书规则集」，由规则引擎求值。
 * 所以这里统一走 checkWorldbookFormat + 一条空平台规则（它只贡献占位符定义）。
 */
const EMPTY_PLATFORM_RULE = {
  schemaVersion: 1,
  id: 'wb-test',
  name: 'wb-test',
  version: '1.0.0',
  target: { spec: 'any' },
  placeholders: { char: ['{{char}}'], user: ['{{user}}'] },
  fields: [],
  rules: [],
};

function auditWorldbook(card, rules = []) {
  const resolved = resolvePlatformRule('wb-test', [{ ...EMPTY_PLATFORM_RULE, rules }]);
  return checkWorldbookFormat(card, { platformRule: resolved });
}

test('T10.9 世界书问题归入 worldbook 类别（不再混在 format 里）', () => {
  const card = withEntries([{ id: 0, keys: [], content: '正文', constant: false }]);
  const issues = auditWorldbook(card);
  assert.ok(issues.length > 0);
  for (const issue of issues) assert.equal(issue.category, 'worldbook');
  // 定位都落在世界书板块
  for (const issue of issues) {
    assert.equal(issue.location.blockId, 'worldbook');
    assert.equal(issue.location.field, 'character_book');
  }
});

test('T10.9 触发键：无 keys 且非常驻 → 永不触发（warning，不是 info）', () => {
  const card = withEntries([{ id: 0, keys: [], content: '正文' }]);
  const issues = auditWorldbook(card);
  const hit = issues.find((issue) => issue.ruleId === 'builtin:worldbook-no-trigger');
  assert.ok(hit, JSON.stringify(ruleIds(issues)));
  assert.equal(hit.severity, 'warning', '永不触发的条目会让作者以为世界书没生效，必须 warning');
  assert.match(hit.message, /永远不会被触发/);
});

test('T10.9 触发键：constant 为 true 时无 keys 是正常的（不报）', () => {
  const card = withEntries([{ id: 0, keys: [], content: '常驻条目', constant: true }]);
  const issues = auditWorldbook(card);
  assert.equal(issues.some((issue) => issue.ruleId === 'builtin:worldbook-no-trigger'), false);
});

test('T10.9 触发键：空字符串关键词会被警告（它会匹配一切，等于常驻）', () => {
  const card = withEntries([{ id: 0, keys: ['  ', '银座'], content: '正文' }]);
  const issues = auditWorldbook(card);
  const hit = issues.find((issue) => issue.ruleId === 'builtin:worldbook-blank-key');
  assert.ok(hit);
  assert.match(hit.message, /空项/);
});

test('T10.9 触发键：selective 开启但没有 secondary_keys → 设置无效', () => {
  const card = withEntries([{ id: 0, keys: ['a'], content: '正文', selective: true }]);
  const issues = auditWorldbook(card);
  assert.ok(issues.some((issue) => issue.ruleId === 'builtin:worldbook-selective-without-secondary'));
});

test('T10.9 id：缺 id → warning（导出会补号，但用户要知情）', () => {
  const card = withEntries([{ keys: ['a'], content: '正文' }]);
  const issues = auditWorldbook(card);
  const hit = issues.find((issue) => issue.ruleId === 'builtin:worldbook-entry-missing-id');
  assert.ok(hit);
  assert.equal(hit.severity, 'warning');
  assert.match(hit.message, /导出时会自动补号/);
});

test('T10.9 id：非整数 / 负数 → error', () => {
  const card = withEntries([
    { id: 1.5, keys: ['a'], content: '正文' },
    { id: -1, keys: ['b'], content: '正文' },
  ]);
  const issues = auditWorldbook(card);
  const hits = issues.filter((issue) => issue.ruleId === 'builtin:worldbook-entry-bad-id');
  assert.equal(hits.length, 2);
  for (const hit of hits) assert.equal(hit.severity, 'error');
});

test('T10.9 id：重复由 checkWorldbookFormat 报（error，禁止静默合并）', () => {
  const card = withEntries([
    { id: 0, keys: ['a'], content: '一' },
    { id: 0, keys: ['b'], content: '二' },
  ]);
  const issues = auditWorldbook(card);
  const hit = issues.find((issue) => issue.ruleId === 'builtin:worldbook-duplicate-entry-id');
  assert.ok(hit);
  assert.equal(hit.severity, 'error');
  assert.equal(hit.category, 'worldbook', '重复 id 属于世界书类别，不是通用格式');
});

test('T10.9 结构：正文为空 → warning（条目不提供任何信息）', () => {
  const card = withEntries([{ id: 0, keys: ['a'], content: '   ' }]);
  const issues = auditWorldbook(card);
  const hit = issues.find((issue) => issue.ruleId === 'builtin:worldbook-entry-empty-content');
  assert.ok(hit);
  assert.equal(hit.severity, 'warning');
});

test('T10.9 结构：keys 不是数组 → error，且不再继续判触发键（避免连锁误报）', () => {
  const card = withEntries([{ id: 0, keys: '银座', content: '正文' }]);
  const issues = auditWorldbook(card);
  assert.ok(issues.some((issue) => issue.ruleId === 'builtin:worldbook-entry-bad-keys'));
  assert.equal(issues.some((issue) => issue.ruleId === 'builtin:worldbook-no-trigger'), false);
});

test('T10.9 干净的世界书不产出任何 worldbook 问题', () => {
  const card = structuredClone(SAMPLE);
  assert.deepEqual(auditWorldbook(card), []);
});

test('T10.9 空卡（没有世界书）不报错', () => {
  const card = createEmptyCard('空卡');
  assert.deepEqual(auditWorldbook(card), []);
});

test('T10.9 条目数上限只给 info（不阻断导出）', () => {
  const entries = Array.from({ length: 201 }, (_, index) => ({
    id: index,
    keys: [`k${String(index)}`],
    content: '正文',
  }));
  const card = withEntries(entries);
  const issues = auditWorldbook(card);
  const hit = issues.find((issue) => issue.ruleId === 'builtin:worldbook-too-many-entries');
  assert.ok(hit);
  assert.equal(hit.severity, 'info');
});
