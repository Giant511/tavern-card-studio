/**
 * 「新两板块 v0.1.3 只做格式审计」这条边界（追加项一 / 2）。
 *
 * 需求原文：
 *   > 平台规则对它们的内容级检查默认关闭（scope 含新板块的平台规则中，
 *   > 内容类规则仅当规则作者显式声明才生效；格式类检查照常）
 *
 * ## 这条边界最容易做错的地方
 *
 * **按整条规则挡，而不是按每段文本挡。** 直觉写法是"scope 里有新板块就跳过整条
 * 规则"，但那会连带关掉 `scope: "*"` 规则对 basic/settings 的检查 ——
 * 一条规则波及两个板块，就把整张卡的检查废了。所以本文件第一条测试
 * 钉的就是这个：同一条 `scope: "*"` 的规则，**basic 仍然报、新板块不报**。
 *
 * ## 另外两条不受影响的路径
 *
 *   · `contentOptIn: true` —— 规则作者显式负责，照常跑；
 *   · `field:first_mes` / `field:mes_example` —— 显式点名 ST 字段，
 *     那是明确声明，不该被这条边界拦（`<START>` 标记、开场白非空正是靠它）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  collectScopedTexts,
  FORMAT_ONLY_BLOCK_IDS,
  isFormatOnlyBlock,
  loadPlatformRules,
  parseStCard,
  ruleIsFullyGated,
  scopeForContentRule,
  validateCard,
} from '@tcs/shared';

const CARD = parseStCard(
  JSON.parse(readFileSync(new URL('./fixtures/sample-card.json', import.meta.url), 'utf8')),
).card;

/**
 * 手工造一条**一定会命中**的内容规则。
 *
 * 用 `length max: 1` 而不是 `non-empty`：样本卡每个板块都有正文，
 * `non-empty` 一条都不会报 —— 那样"没命中新板块"就成了空证明
 * （判据必须先能命中，才谈得上"被跳过"）。
 */
function rule(overrides) {
  return {
    id: 'test-rule',
    type: 'length',
    max: 1,
    message: '这一段太长',
    scope: '*',
    severity: 'warning',
    ...overrides,
  };
}

/** 用最小平台规则把 card 跑一遍（只需要 placeholders 与 rules） */
function runRules(rules) {
  const platform = {
    schemaVersion: 1,
    id: 'test',
    name: '测试',
    version: '1.0.0',
    extends: null,
    target: { spec: 'any' },
    placeholders: { char: ['{{char}}'], user: ['{{user}}'] },
    fields: [],
    rules,
    lineage: ['test'],
    placeholderLookup: { '{{char}}': 'char', '{{user}}': 'user' },
  };
  return validateCard(CARD, platform);
}

const hitBlocks = (issues) => [...new Set(issues.map((issue) => issue.location.blockId))].sort();

// ══════════════════════════════════════════════════════════
// 1. 粒度：每段文本，不是整条规则
// ══════════════════════════════════════════════════════════

test('scope:"*" 的内容规则：基础板块照报，两个新板块被跳过（不是整条失效）', () => {
  const issues = runRules([rule({ id: 'star-nonempty', scope: '*' })]);
  const blocks = hitBlocks(issues);

  assert.ok(blocks.includes('basic'), `basic 必须仍然被检查：${JSON.stringify(blocks)}`);
  assert.ok(!blocks.includes('initial-scene'), `initial-scene 不该被内容规则命中：${JSON.stringify(blocks)}`);
  assert.ok(!blocks.includes('chat-examples'), `chat-examples 不该被内容规则命中：${JSON.stringify(blocks)}`);
});

test('scope 只写新板块 → 整条规则被完全折叠（且能识别出"完全折叠"）', () => {
  const onlyNew = rule({ id: 'only-new', scope: ['block:initial-scene', 'block:chat-examples'] });
  assert.deepEqual(runRules([onlyNew]), [], '只针对新板块的内容规则不应产出任何问题');

  const scoped = collectScopedTexts(CARD, onlyNew.scope);
  assert.ok(scoped.length > 0, '前提：这两块在样本卡里确实有文本');
  assert.deepEqual(scopeForContentRule(scoped, onlyNew), [], '过滤后应当是空集');
  assert.equal(
    ruleIsFullyGated(scoped, onlyNew),
    true,
    '判据要吃**过滤前**的集合：拿过滤后的空集去问，答案永远是"没有全部被挡"',
  );
  // 反向：不波及专用的规则不算"整体折叠"
  const broad = collectScopedTexts(CARD, '*');
  assert.equal(ruleIsFullyGated(broad, onlyNew), false);
});

test('contentOptIn:true → 规则作者显式负责，两个新板块照常被检查', () => {
  const issues = runRules([rule({ id: 'opted-in', scope: '*', contentOptIn: true })]);
  const blocks = hitBlocks(issues);
  assert.ok(blocks.includes('initial-scene'), `开了 contentOptIn 就该命中：${JSON.stringify(blocks)}`);
  assert.ok(blocks.includes('chat-examples'), `开了 contentOptIn 就该命中：${JSON.stringify(blocks)}`);
});

test('显式 field: 选择器不受这条边界影响（blockId 为 null，不是"板块文本"）', () => {
  // `field:mes_example` 是规则作者点名某个 ST 字段，属于明确声明
  const issues = runRules([rule({ id: 'mes-example', scope: 'field:mes_example' })]);
  const fields = [...new Set(issues.map((issue) => issue.location.field))];
  assert.deepEqual(fields, ['mes_example'], `显式字段选择器必须生效，实际命中字段：${JSON.stringify(fields)}`);
});

// ══════════════════════════════════════════════════════════
// 2. 边界本身：纯函数层面
// ══════════════════════════════════════════════════════════

test('边界判据：只有这两个板块被定义为"仅格式"', () => {
  assert.deepEqual([...FORMAT_ONLY_BLOCK_IDS].sort(), ['chat-examples', 'initial-scene']);
  assert.equal(isFormatOnlyBlock('initial-scene'), true);
  assert.equal(isFormatOnlyBlock('chat-examples'), true);
  assert.equal(isFormatOnlyBlock('basic'), false);
  assert.equal(isFormatOnlyBlock('worldbook'), false);
  assert.equal(isFormatOnlyBlock(null), false);
});

test('scopeForContentRule 不修改入参（纯函数）', () => {
  const scoped = [
    { blockId: 'basic', text: 'a' },
    { blockId: 'initial-scene', text: 'b' },
  ];
  const out = scopeForContentRule(scoped, rule({}));
  assert.equal(scoped.length, 2, '入参数组不许被改');
  assert.deepEqual(out.map((item) => item.blockId), ['basic']);
});

// ══════════════════════════════════════════════════════════
// 3. 真实规则资产：内容规则不会被这条边界整条吞掉
// ══════════════════════════════════════════════════════════

test('真实平台规则里，scope 波及新板块的规则在基础板块上仍然生效', () => {
  const files = ['sillytavern', 'character-card-v2', 'character-card-v3', 'janitorai', 'chub'].map((id) =>
    JSON.parse(readFileSync(new URL(`../rules/platforms/${id}.json`, import.meta.url), 'utf8')),
  );
  const loaded = loadPlatformRules(files);
  assert.deepEqual(loaded.errors, [], '内置规则必须先全部通过校验');

  let affected = 0;
  for (const platform of loaded.rules) {
    const resolved = { ...platform, lineage: [platform.id], placeholderLookup: {} };
    for (const item of platform.rules) {
      const scoped = collectScopedTexts(CARD, item.scope);
      const leaked = scoped.filter((entry) => isFormatOnlyBlock(entry.blockId));
      if (leaked.length === 0) continue;
      affected += 1;
      // 前提：这个样本卡里两块都有文本（否则"没命中"是空的证明）
      assert.ok(
        scoped.some((entry) => !isFormatOnlyBlock(entry.blockId)),
        '样本卡里两块之外的板块文本不该全空',
      );
      const issues = validateCard(CARD, { ...resolved, rules: [item] });
      const blocks = hitBlocks(issues);
      assert.ok(
        !blocks.includes('initial-scene') && !blocks.includes('chat-examples'),
        `${platform.id}/${item.id} 命中了新板块：${JSON.stringify(blocks)}`,
      );
    }
  }
  assert.ok(affected > 0, '前提：内置规则里确实有 scope 波及新板块的（否则这条测试什么也没验）');
});
