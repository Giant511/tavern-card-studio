/**
 * 平台规则加载 / 继承 / 校验测试（T1.3）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadPlatformRules,
  parsePlatformRule,
  parseStCard,
  resolvePlatformRule,
  summarizeIssues,
  validateCard,
  setBlockText,
} from '../shared/dist/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLATFORM_DIR = join(ROOT, 'rules', 'platforms');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'sample-card.json');

const inputs = readdirSync(PLATFORM_DIR)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(join(PLATFORM_DIR, name), 'utf8')));

const { rules, errors } = loadPlatformRules(inputs);
const { card } = parseStCard(JSON.parse(readFileSync(FIXTURE, 'utf8')));

test('五份内置平台规则全部加载成功', () => {
  assert.deepEqual(errors, []);
  assert.deepEqual(
    rules.map((rule) => rule.id).sort(),
    ['ccv2', 'ccv3', 'chub', 'janitorai', 'sillytavern'],
  );
});

test('继承链解析：janitorai → ccv2 → sillytavern', () => {
  const resolved = resolvePlatformRule('janitorai', rules);
  assert.deepEqual(resolved.lineage, ['sillytavern', 'ccv2', 'janitorai']);
  assert.equal(resolved.target.spec, 'v2');
  // 父规则字段被继承
  assert.ok(resolved.fields.some((field) => field.path === 'description'));
  // 同名规则被子规则覆盖（janitorai 把 {{char}} 从 warning 提为 error）
  const charRule = resolved.rules.find((rule) => rule.id === 'char-placeholder-required');
  assert.equal(charRule.severity, 'error');
});

test('占位符词表合并后可用于反查', () => {
  const chub = resolvePlatformRule('chub', rules);
  assert.equal(chub.placeholderLookup['<BOT>'], 'char');
  assert.equal(chub.placeholderLookup['{{user}}'], 'user');
});

test('示例卡片在 SillyTavern 规则下无 error', () => {
  const resolved = resolvePlatformRule('sillytavern', rules);
  const issues = validateCard(card, resolved);
  const summary = summarizeIssues(issues);
  assert.equal(summary.error, 0, `不应有 error，实际：${issues.map((i) => i.message).join(' | ')}`);
  assert.equal(summary.exportable, true);
});

test('示例卡片在 JanitorAI 规则下：世界书给出 warning，无 error', () => {
  const resolved = resolvePlatformRule('janitorai', rules);
  const issues = validateCard(card, resolved);
  const summary = summarizeIssues(issues);
  assert.equal(summary.error, 0, issues.filter((i) => i.severity === 'error').map((i) => i.message).join(' | '));
  const worldbook = issues.find((issue) => issue.ruleId === 'worldbook-not-supported');
  assert.ok(worldbook, '应提示 JanitorAI 不支持内嵌世界书');
  assert.equal(worldbook.severity, 'warning');
});

test('必填字段缺失产生 error 且可定位', () => {
  const empty = structuredClone(card);
  empty.meta.name = '';
  const resolved = resolvePlatformRule('sillytavern', rules);
  const issues = validateCard(empty, resolved);
  const nameIssue = issues.find((issue) => issue.ruleId.includes('field-required') && issue.location.field === 'name');
  assert.ok(nameIssue);
  assert.equal(nameIssue.severity, 'error');
});

test('问题定位精确到板块与字符偏移（用于编辑器内标记）', () => {
  const mutated = structuredClone(card);
  setBlockText(mutated, 'basic', '【基本信息】之外的内容 <BOT> 出现了伪标签');
  const resolved = resolvePlatformRule('janitorai', rules);
  const issues = validateCard(mutated, resolved);
  const tagIssue = issues.find((issue) => issue.ruleId === 'forbid-angle-tags');
  assert.ok(tagIssue);
  assert.equal(tagIssue.location.blockId, 'basic');
  assert.equal(tagIssue.location.excerpt, '<BOT>');
  assert.ok(tagIssue.location.start >= 0);
});

test('聚合统计：{{char}} 在多个板块合计出现即可满足 min', () => {
  const single = structuredClone(card);
  setBlockText(single, 'basic', '年龄 24，身高 168cm');
  setBlockText(single, 'settings', '输出格式：每段不超过 3 行');
  setBlockText(single, 'special', '{{char}} 从不上二楼');
  const resolved = resolvePlatformRule('janitorai', rules);
  const issues = validateCard(single, resolved);
  assert.equal(
    issues.filter((issue) => issue.ruleId === 'char-placeholder-required').length,
    0,
    'special 板块已出现 {{char}}，聚合口径应通过',
  );
});

test('修正内容后问题即时消失（同一份规则重跑）', () => {
  const resolved = resolvePlatformRule('janitorai', rules);
  const broken = structuredClone(card);
  setBlockText(broken, 'basic', '年龄 24 <BOT>');
  const before = validateCard(broken, resolved).filter((issue) => issue.ruleId === 'forbid-angle-tags');
  assert.equal(before.length, 1);
  setBlockText(broken, 'basic', '年龄 24 {{char}}');
  const after = validateCard(broken, resolved).filter((issue) => issue.ruleId === 'forbid-angle-tags');
  assert.equal(after.length, 0);
});

test('非法规则文件被拒绝并给出可读错误', () => {
  const bad = {
    schemaVersion: 1,
    id: 'Bad_ID',
    name: '',
    version: '1',
    target: { spec: 'v9' },
    placeholders: { char: [], user: ['{{user}}'] },
    fields: [],
    rules: [{ id: 'x', type: 'nope', message: '', scope: 'block:nope', severity: 'fatal' }],
  };
  const result = parsePlatformRule(bad);
  assert.equal(result.rule, null);
  assert.ok(result.errors.length >= 4, result.errors.join(' | '));
});

test('自定义规则：{{char}} 出现次数不足时按聚合口径报错', () => {
  const custom = {
    schemaVersion: 1,
    id: 'custom-strict',
    name: '严格平台',
    version: '1.0.0',
    target: { spec: 'v2', specVersion: '2.0' },
    placeholders: { char: ['{{char}}'], user: ['{{user}}'] },
    fields: [],
    rules: [
      {
        id: 'char-twice',
        type: 'placeholder-min-count',
        token: 'char',
        min: 99,
        aggregate: true,
        scope: '*',
        severity: 'error',
        message: '全文 {{char}} 出现次数不足',
      },
    ],
  };
  const parsed = parsePlatformRule(custom);
  assert.deepEqual(parsed.errors, []);
  const resolved = resolvePlatformRule('custom-strict', [parsed.rule]);
  const issues = validateCard(card, resolved);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].ruleId, 'char-twice');
  assert.equal(issues[0].aggregate, true);
  assert.equal(issues[0].location.blockId, null);
  assert.ok(issues[0].message.includes('全文合计'), issues[0].message);
});
