/**
 * aggregate 口径测试（补充要求 1）
 *
 * 同一份违规内容，两种口径必须给出不同粒度的问题：
 *  - aggregate: false（默认）→ 逐块报，每个问题指向具体板块（location.blockId 有值）；
 *  - aggregate: true        → 全文合计只报一次，location 全为 null、aggregate 标记为 true。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  issuesByBlock,
  parsePlatformRule,
  parseStCard,
  resolvePlatformRule,
  setBlockText,
  validateCard,
} from '../shared/dist/index.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/sample-card.json', import.meta.url));
const baseCard = parseStCard(JSON.parse(readFileSync(FIXTURE, 'utf8'))).card;

function makeRule(rule) {
  return {
    schemaVersion: 1,
    id: 'agg-test',
    name: '聚合口径测试',
    version: '1.0.0',
    target: { spec: 'v2', specVersion: '2.0' },
    placeholders: { char: ['{{char}}'], user: ['{{user}}'] },
    fields: [],
    rules: [
      {
        id: 'char-check',
        type: 'placeholder-min-count',
        token: 'char',
        min: 1,
        scope: ['block:basic', 'block:settings'],
        severity: 'error',
        message: '必须用 {{char}} 指代角色',
        ...rule,
      },
    ],
  };
}

/** 造一张 basic / settings 都不含 {{char}} 的卡片 */
function cardWithoutChar() {
  const card = structuredClone(baseCard);
  setBlockText(card, 'basic', '年龄 24，身高 168cm');
  setBlockText(card, 'settings', '输出格式：每段不超过 3 行');
  return card;
}

function run(rule, card) {
  const parsed = parsePlatformRule(makeRule(rule));
  assert.deepEqual(parsed.errors, [], `规则本身应合法：${parsed.errors.join(' | ')}`);
  return validateCard(card, resolvePlatformRule('agg-test', [parsed.rule]));
}

test('aggregate:false —— 每个违规板块各报一条，并指向具体板块', () => {
  const issues = run({ aggregate: false }, cardWithoutChar());
  assert.equal(issues.length, 2, '两个板块都缺 {{char}}，应报 2 条');
  assert.deepEqual(
    issues.map((issue) => issue.location.blockId),
    ['basic', 'settings'],
    '问题必须归属到具体板块，UI 才能显示板块名并跳转',
  );
  assert.ok(issues.every((issue) => issue.aggregate !== true));
  assert.ok(issues.every((issue) => issue.location.start === 0));
});

test('aggregate:true —— 同一违规只报一条，且不归属任何板块', () => {
  const issues = run({ aggregate: true }, cardWithoutChar());
  assert.equal(issues.length, 1, '全文合计口径只允许一条问题');
  const [issue] = issues;
  assert.equal(issue.aggregate, true);
  assert.equal(issue.location.blockId, null, '合计问题不属于某个板块');
  assert.equal(issue.location.field, null);
  assert.equal(issue.location.start, null);
  assert.match(issue.message, /全文合计 0 次，至少 1 次/);
});

test('aggregate:false 与 true 的判定结果可以不同：仅一块达标', () => {
  const card = structuredClone(baseCard);
  setBlockText(card, 'basic', '{{char}} 年龄 24');
  setBlockText(card, 'settings', '输出格式：每段不超过 3 行');

  const perBlock = run({ aggregate: false }, card);
  assert.equal(perBlock.length, 1);
  assert.equal(perBlock[0].location.blockId, 'settings', '逐块口径应点名 settings');

  const aggregated = run({ aggregate: true }, card);
  assert.equal(aggregated.length, 0, '全文合计已出现 1 次，应通过');
});

test('aggregate:true 不会出现在任何板块分组里（编辑区左侧标记只标真的违规板块）', () => {
  const issues = run({ aggregate: true }, cardWithoutChar());
  assert.equal(issuesByBlock(issues).size, 0);
});

test('pattern-required 同样支持两种口径（<START> 检查）', () => {
  const card = structuredClone(baseCard);
  setBlockText(card, 'special', '她从不上二楼。');
  setBlockText(card, 'user', '{{user}} 是她的邻居。');
  const rule = {
    type: 'pattern-required',
    id: 'start-tag',
    pattern: '<START>',
    min: 1,
    scope: ['block:special', 'block:user'],
    message: '特殊设定与用户相关设定需要给出 <START> 示例',
  };

  const perBlock = run(rule, card);
  assert.equal(perBlock.length, 2);
  assert.deepEqual(perBlock.map((issue) => issue.location.blockId), ['special', 'user']);

  const aggregated = run({ ...rule, aggregate: true }, card);
  assert.equal(aggregated.length, 1);
  assert.equal(aggregated[0].location.blockId, null);
  assert.match(aggregated[0].message, /全文合计 0 次/);
});

test('aggregate:true 的超上限（max）也只报一次', () => {
  const card = structuredClone(baseCard);
  setBlockText(card, 'basic', '{{char}} 与 {{char}}');
  setBlockText(card, 'settings', '{{char}} 的语气要冷');
  const issues = run({ aggregate: true, min: 1, max: 2 }, card);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /全文合计 3 次，上限 2 次/);
});
