/**
 * `when` 的条件存在性（v0.1.5 / G7，出路三）。
 *
 * ## 这个能力为什么非有不可
 *
 * 用户的世界书分"持续世界书"与"关键词世界书"两节，字段谱系不同：
 *   持续型：有 `priority`（触发概率），没有 `position`（触发深度），没有 keywords
 *   关键词型：有 `position` 与 keywords，没有 `priority`
 *
 * 于是"某字段有没有出现"本身就是**区分两类条目**的信号 —— 不必给每条都手写
 * 一个 `constant` 标记。`exists` / `absent` 就是把这个信号写进规则。
 *
 * 断言重点放在**语义边界**（`priority: 0` 算存在、`undefined`/`null` 不算），
 * 因为把"存在性"和"值真假"混为一谈是最容易犯的错。
 *
 * 走 `@tcs/shared` 的公开 API（`validateWorldbookRules`）而不是引源码：
 * 打包出去的正是 dist，源码路径只在仓库里成立。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_WORLDBOOK_RULES,
  PLATFORM_RULE_WHEN_KEYS,
  createEmptyCard,
  resolvePlatformRule,
  validateWorldbookRules,
} from '@tcs/shared';

const ROOT = join(import.meta.dirname, '..');
const RULE_ID = 'wb-keys-required-when-not-constant';

/** 造一份最小平台规则：只放被测的那条内容规则 */
function buildRule(when) {
  return {
    schemaVersion: 1,
    id: 'test-rule',
    name: 'test',
    version: '1.0.0',
    target: 'sillytavern',
    placeholders: { char: ['{{char}}'], user: ['{{user}}'] },
    rules: [
      {
        id: RULE_ID,
        type: 'list-count',
        min: 1,
        message: '条目「{entry}」不是常驻条目，却没有任何关键词',
        scope: 'worldbook:entries[].keys',
        severity: 'error',
        category: 'worldbook',
        when,
      },
    ],
  };
}

/** 跑一遍，返回该规则报出的条数 */
function countIssues(entries, when) {
  const rule = resolvePlatformRule('test-rule', [buildRule(when)]);
  const card = createEmptyCard('测试');
  card.worldbook = { entries, text: '', dirty: false, raw: null };
  return validateWorldbookRules(card, rule).filter((issue) => issue.ruleId === RULE_ID).length;
}

/** 持续型条目：有 priority，无 keys */
const PERSISTENT = { id: 0, name: '西奥核心关系逻辑', keys: [], content: '正文', priority: 100 };
/** 关键词型条目：有 keys 与 position，无 priority */
const KEYWORDED = { id: 1, name: '成人剧情规则', keys: ['成人', '性'], content: '正文', position: 4 };

test('exists:true → 只对"有该字段"的条目生效', () => {
  const entries = [PERSISTENT, { ...KEYWORDED, id: 2, keys: [] }];
  assert.equal(countIssues(entries, { field: 'priority', exists: true }), 1, '应当只报持续型那条');
});

test('absent:true → 只对"没有该字段"的条目生效（跳过持续型）', () => {
  const entries = [PERSISTENT, { ...KEYWORDED, id: 2, keys: [] }];
  assert.equal(countIssues(entries, { field: 'priority', absent: true }), 1, '关键词型那条应被报出');
});

test('用户场景：持续型条目不因"没有关键词"被误报', () => {
  /*
   * 用户实测 29 条误报的最小复现：持续型条目没有 constant 标记、也没有关键词，
   * 规则条件是"不是常驻"，于是全线命中。
   */
  const sevenPersistent = Array.from({ length: 7 }, (_, index) => ({
    ...PERSISTENT,
    id: index,
    priority: 100,
  }));

  // 前置：旧写法确实全中 —— 先复现误报，再证明新写法能消掉
  assert.equal(
    countIssues(sevenPersistent, { field: 'constant', notEquals: true }),
    7,
    '前置：不加存在性条件时 7 条全中（复现误报）',
  );
  assert.equal(
    countIssues(sevenPersistent, { field: 'priority', absent: true }),
    0,
    '持续型应当被跳过',
  );
});

test('存在性口径：0 与空串算存在，undefined/null 不算', () => {
  assert.equal(countIssues([{ ...PERSISTENT, priority: 0 }], { field: 'priority', exists: true }), 1, '0 算存在');
  assert.equal(countIssues([{ ...PERSISTENT, priority: '' }], { field: 'priority', exists: true }), 1, '空串算存在');
  assert.equal(
    countIssues([{ ...PERSISTENT, priority: undefined }], { field: 'priority', exists: true }),
    0,
    'undefined 不算存在',
  );
  assert.equal(
    countIssues([{ ...PERSISTENT, priority: null }], { field: 'priority', exists: true }),
    0,
    'null 不算存在',
  );
});

test('exists:false 等价于 absent:true', () => {
  const entries = [PERSISTENT, { ...KEYWORDED, id: 2, keys: [] }];
  assert.equal(
    countIssues(entries, { field: 'priority', exists: false }),
    countIssues(entries, { field: 'priority', absent: true }),
  );
});

test('旧写法 present 仍然有效（不能把已写好的规则弄坏）', () => {
  const entries = [PERSISTENT, { ...KEYWORDED, id: 2, keys: [] }];
  assert.equal(
    countIssues(entries, { field: 'priority', present: true }),
    countIssues(entries, { field: 'priority', exists: true }),
  );
  assert.equal(
    countIssues(entries, { field: 'priority', present: false }),
    countIssues(entries, { field: 'priority', absent: true }),
  );
});

test('存在性与值条件同时写：两个都要满足', () => {
  const entries = [
    { ...PERSISTENT, priority: 100 },
    { ...PERSISTENT, id: 1, priority: 0 },
  ];
  assert.equal(countIssues(entries, { field: 'priority', exists: true, notEquals: 0 }), 1);
});

test('when 的键白名单包含 exists/absent/present（否则会被报未知键）', () => {
  const keys = [...PLATFORM_RULE_WHEN_KEYS];
  for (const key of ['field', 'equals', 'notEquals', 'exists', 'absent', 'present']) {
    assert.ok(keys.includes(key), `PLATFORM_RULE_WHEN_KEYS 缺 ${key}`);
  }
});

test('schema 允许 exists/absent（additionalProperties:false 下必须显式登记）', () => {
  const schema = JSON.parse(
    readFileSync(join(ROOT, 'rules/schema/platform-rule.schema.json'), 'utf8'),
  );
  const whenSchema = schema.definitions.contentRule.properties.when;
  assert.equal(whenSchema.additionalProperties, false, '前提变了这条检查就没意义了');
  for (const key of ['exists', 'absent']) {
    assert.ok(key in whenSchema.properties, `when.properties 缺 ${key}`);
  }
});

test('内置规则集里的 when 写法未被破坏（回归）', () => {
  const rule = DEFAULT_WORLDBOOK_RULES.find((item) => item.id === 'builtin:worldbook-no-trigger');
  assert.ok(rule !== undefined);
  assert.deepEqual(rule.when, { field: 'constant', notEquals: true });
});
