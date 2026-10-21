/**
 * 平台规则切换与内容适配测试（T1.4）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applySwitchPlan,
  describeSwitchPlan,
  loadPlatformRules,
  parseStCard,
  planPlatformSwitch,
  resolvePlatformRule,
  setBlockText,
  validateCard,
} from '../shared/dist/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLATFORM_DIR = join(ROOT, 'rules', 'platforms');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'sample-card.json');

const inputs = readdirSync(PLATFORM_DIR)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(join(PLATFORM_DIR, name), 'utf8')));
const { rules } = loadPlatformRules(inputs);

const chub = resolvePlatformRule('chub', rules);
const janitor = resolvePlatformRule('janitorai', rules);

function cardWith(token) {
  const { card } = parseStCard(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  setBlockText(card, 'basic', `${token} 的档案：年龄 24，身高 168cm`);
  setBlockText(card, 'user', `你叫${token}，是常客`);
  card.residual.firstMes = `${token}抬起头看了你一眼。`;
  return card;
}

test('chub → janitorai：<BOT>/<USER> 被归一为双花括号写法', () => {
  const card = cardWith('<BOT>');
  const plan = planPlatformSwitch(card, chub, janitor);

  const replaced = plan.changes.filter((change) => change.from === '<BOT>');
  assert.ok(replaced.length >= 1);
  assert.ok(replaced.every((change) => change.to === '{{char}}'));
  assert.ok(plan.card.blocks.find((block) => block.id === 'basic').text.includes('{{char}}'));
  assert.ok(plan.card.residual.firstMes.includes('{{char}}'));
  assert.ok(!JSON.stringify(plan.card).includes('<BOT>'));
});

test('切换是纯函数：原卡片不被修改', () => {
  const card = cardWith('<BOT>');
  planPlatformSwitch(card, chub, janitor);
  assert.ok(card.blocks.find((block) => block.id === 'basic').text.includes('<BOT>'));
});

test('已符合目标平台写法时无变更', () => {
  const card = cardWith('{{char}}');
  const plan = planPlatformSwitch(card, chub, janitor);
  assert.equal(plan.changes.length, 0, describeSwitchPlan(plan));
  assert.equal(plan.card.blocks.find((block) => block.id === 'basic').text, card.blocks.find((block) => block.id === 'basic').text);
});

test('变更清单可读（用于确认弹窗）', () => {
  const card = cardWith('<BOT>');
  const plan = planPlatformSwitch(card, chub, janitor);
  const text = describeSwitchPlan(plan);
  assert.ok(text.includes('<BOT> → {{char}}'), text);
  assert.ok(text.includes('处'));
});

test('确认后应用变更：板块置 dirty 并可导出为新写法', () => {
  const card = cardWith('<BOT>');
  const plan = planPlatformSwitch(card, chub, janitor);
  applySwitchPlan(card, plan);
  const basic = card.blocks.find((block) => block.id === 'basic');
  assert.equal(basic.dirty, true);
  assert.ok(basic.text.includes('{{char}}'));
});

test('切换后重新校验：伪标签问题消失', () => {
  const card = cardWith('<BOT>');
  const before = validateCard(card, janitor).filter((issue) => issue.ruleId === 'forbid-angle-tags');
  assert.ok(before.length > 0);
  const plan = planPlatformSwitch(card, chub, janitor);
  const after = validateCard(plan.card, janitor).filter((issue) => issue.ruleId === 'forbid-angle-tags');
  assert.equal(after.length, 0);
});

test('世界书条目内容也参与占位符归一', () => {
  const card = cardWith('{{char}}');
  card.worldbook.entries[0].content = '<BOT> 的书店位于青石巷。';
  const plan = planPlatformSwitch(card, chub, janitor);
  assert.ok(plan.changes.some((change) => change.blockId === 'worldbook'));
  assert.ok(plan.card.worldbook.entries[0].content.includes('{{char}}'));
  assert.ok(plan.card.worldbook.text.includes('{{char}}'));
});
