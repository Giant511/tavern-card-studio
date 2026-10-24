/**
 * 世界书内容校验：规则集化后的等价性 + 自定义能力（T10.32 / T10.33）。
 *
 * 三组断言：
 *   ① **等价性**：同一违规样本，问题列表（ruleId + severity + entryId + 文案）与 T10.9
 *      的硬编码检查逐项一致。这是"重构没顺手改判据"的唯一证据。
 *   ② **去重**：同一处违规只报一次；结构问题（类型坏了）与语义问题不并存。
 *   ③ **可覆盖**：同 id 覆盖 severity/阈值、`enabled:false` 禁用、新 id 追加。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkWorldbookFormat, parseStCard, resolvePlatformRule } from '../shared/dist/index.js';

const ROOT = join(import.meta.dirname, '..');
const SAMPLE = parseStCard(JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'sample-card.json'), 'utf8'))).card;

function withEntries(entries) {
  const card = structuredClone(SAMPLE);
  card.worldbook = { entries, text: '', dirty: false, raw: null };
  return card;
}

const BASE_RULE = {
  schemaVersion: 1,
  id: 'wb-rules-test',
  name: 'wb-rules-test',
  version: '1.0.0',
  target: { spec: 'any' },
  placeholders: { char: ['{{char}}'], user: ['{{user}}'] },
  fields: [],
  rules: [],
};

/** 审计世界书（结构 + 语义），返回 worldbook 类别的问题 */
function audit(card, rules = []) {
  const resolved = resolvePlatformRule('wb-rules-test', [{ ...BASE_RULE, rules }]);
  return checkWorldbookFormat(card, { platformRule: resolved });
}

function brief(issues) {
  return issues
    .map((issue) => `${issue.ruleId}|${issue.severity}|e${String(issue.location.entryId ?? '-')}|${issue.message}`)
    .sort();
}

// ────────────────────────────────────────────── ① 等价性

test('等价性：五种标准违规的内置检查结果与 T10.9 逐项一致（含文案）', () => {
  const card = withEntries([
    // 无关键词且非常驻
    { id: 0, name: '无键', keys: [], content: '正文' },
    // 关键词里有空项
    { id: 1, name: '空键', keys: ['  ', '银座'], content: '正文' },
    // selective 开了但没有次级键
    { id: 2, name: '选择', keys: ['a'], content: '正文', selective: true },
    // 正文是空的
    { id: 3, name: '空正文', keys: ['b'], content: '   ' },
    // position 不在规范内
    { id: 4, name: '位置', keys: ['c'], content: '正文', position: 'middle' },
  ]);

  assert.deepEqual(brief(audit(card)), [
    'builtin:worldbook-blank-key|warning|e1|世界书「空键」的关键词里有 1 个空项（当前 1 个空项）',
    'builtin:worldbook-entry-empty-content|warning|e3|世界书「空正文」的正文是空的',
    'builtin:worldbook-no-trigger|warning|e0|世界书「无键」没有任何关键词，也不是常驻（constant: false）——永远不会被触发（当前 0 项，至少 1 项）',
    'builtin:worldbook-position-invalid|warning|e4|世界书「位置」的 position 取值不在 SillyTavern 规范内（middle）',
    'builtin:worldbook-selective-without-secondary|warning|e2|世界书「选择」开启了 selective，但没有 secondary_keys（当前 0 项，至少 1 项）',
  ]);
});

test('等价性：constant 常驻条目不算"永不触发"（与 T10.9 同判据）', () => {
  const card = withEntries([{ id: 0, keys: [], content: '常驻', constant: true }]);
  assert.equal(audit(card).some((issue) => issue.ruleId === 'builtin:worldbook-no-trigger'), false);
});

test('等价性：这些语义问题都归入 worldbook 类别、指向世界书板块', () => {
  const card = withEntries([{ id: 0, keys: [], content: '正文' }]);
  for (const issue of audit(card)) {
    assert.equal(issue.category, 'worldbook');
    assert.equal(issue.location.blockId, 'worldbook');
    assert.equal(issue.location.field, 'character_book');
  }
});

// ────────────────────────────────────────────── ② 去重

test('去重：同一条目同一违规只报一次', () => {
  const card = withEntries([{ id: 0, keys: [], content: '正文' }]);
  const ids = audit(card)
    .filter((issue) => issue.ruleId === 'builtin:worldbook-no-trigger')
    .map((issue) => issue.id);
  assert.equal(ids.length, 1);
  assert.equal(new Set(ids).size, 1);
});

test('去重：不同类型坏掉的条目只报结构问题，不再冒出"正文是空的"', () => {
  const card = withEntries([
    { id: 0, keys: ['a'], content: 42 },
    { id: 1, keys: '银座', content: '正文' },
  ]);
  const ids = audit(card).map((issue) => issue.ruleId);
  assert.ok(ids.includes('builtin:worldbook-entry-bad-content'));
  assert.ok(ids.includes('builtin:worldbook-entry-bad-keys'));
  // 类型问题由结构检查负责；语义规则必须跳过，否则同一处报两遍
  assert.equal(ids.includes('builtin:worldbook-entry-empty-content'), false, JSON.stringify(ids));
  assert.equal(ids.includes('builtin:worldbook-no-trigger'), false, JSON.stringify(ids));
});

test('去重：问题 id 在多个条目之间不重复（否则客户端差量更新会互相顶掉）', () => {
  const card = withEntries([
    { id: null, keys: [], content: '一' },
    { id: null, keys: [], content: '二' },
  ]);
  const ids = audit(card).map((issue) => issue.id);
  assert.equal(new Set(ids).size, ids.length, JSON.stringify(ids));
});

// ────────────────────────────────────────────── ③ 覆盖 / 禁用 / 追加

test('覆盖：同 id 改 severity 生效（内置那条被替换，不是并存）', () => {
  const card = withEntries([{ id: 0, keys: [], content: '正文' }]);
  const issues = audit(card, [
    {
      id: 'builtin:worldbook-no-trigger',
      type: 'list-count',
      min: 1,
      when: { field: 'constant', notEquals: true },
      message: '自定义：{entry}没有触发词',
      scope: 'worldbook:entries[].keys',
      severity: 'error',
      category: 'worldbook',
    },
  ]);
  const hits = issues.filter((issue) => issue.ruleId === 'builtin:worldbook-no-trigger');
  assert.equal(hits.length, 1, '不能既有内置那条又有覆盖那条');
  assert.equal(hits[0].severity, 'error');
  assert.match(hits[0].message, /自定义：/);
});

test('禁用：enabled:false 关掉单条，其它内置规则照常', () => {
  const card = withEntries([{ id: 0, keys: ['a'], content: '   ' }]);
  const issues = audit(card, [
    {
      id: 'builtin:worldbook-entry-empty-content',
      type: 'non-empty',
      message: '（已禁用）',
      scope: 'worldbook:entries[].content',
      severity: 'warning',
      enabled: false,
    },
  ]);
  const ids = issues.map((issue) => issue.ruleId);
  assert.equal(ids.includes('builtin:worldbook-entry-empty-content'), false, JSON.stringify(ids));
});

test('追加：条目名必填 / 关键词至少 2 个 / 触发深度范围，三条都能表达', () => {
  const card = withEntries([
    { id: 0, name: '', keys: ['只有一个'], content: '正文', insertion_order: 99 },
    { id: 1, name: '正常', keys: ['甲', '乙'], content: '正文', insertion_order: 3 },
  ]);
  const issues = audit(card, [
    {
      id: 'mine:entry-name-required',
      type: 'non-empty',
      message: '条目名不能为空（{entry}）',
      scope: 'worldbook:entries[].name',
      severity: 'error',
      category: 'worldbook',
    },
    {
      id: 'mine:keys-at-least-two',
      type: 'list-count',
      min: 2,
      message: '关键词至少 2 个',
      scope: 'worldbook:entries[].keys',
      severity: 'warning',
      category: 'worldbook',
    },
    {
      id: 'mine:insertion-order-range',
      type: 'number-range',
      min: 0,
      max: 10,
      message: '触发深度必须在 0..10',
      scope: 'worldbook:entries[].insertion_order',
      severity: 'warning',
      category: 'worldbook',
    },
  ]);

  const nameHit = issues.find((issue) => issue.ruleId === 'mine:entry-name-required');
  assert.ok(nameHit);
  assert.equal(nameHit.severity, 'error');
  assert.equal(nameHit.location.entryId, 0);

  const keysHit = issues.filter((issue) => issue.ruleId === 'mine:keys-at-least-two');
  assert.equal(keysHit.length, 1, '只有第 0 条不足 2 个');
  assert.equal(keysHit[0].location.entryId, 0);
  assert.match(keysHit[0].message, /至少 2 项/);

  const orderHit = issues.filter((issue) => issue.ruleId === 'mine:insertion-order-range');
  assert.equal(orderHit.length, 1);
  assert.equal(orderHit[0].location.entryId, 0);
  assert.match(orderHit[0].message, /上限 10/);
});

test('追加：删掉关键词行 → 自定义「永不触发」规则报 warning', () => {
  // 验收第 3 条的自定义等价物：不依赖内置那条，用 list-count 自己表达
  const card = withEntries([{ id: 4, name: '爱好', keys: [], content: '喜欢读书' }]);
  const issues = audit(card, [
    {
      id: 'mine:no-trigger',
      type: 'list-count',
      min: 1,
      message: '{entry}没有关键词，永远不会被触发',
      scope: 'worldbook:entries[].keys',
      severity: 'warning',
      category: 'worldbook',
    },
  ]);
  const hit = issues.find((issue) => issue.ruleId === 'mine:no-trigger');
  assert.ok(hit);
  assert.equal(hit.severity, 'warning');
  assert.match(hit.message, /「爱好」没有关键词/);
});

test('追加：触发深度越界（负数或超上限）都会报出具体值', () => {
  const card = withEntries([
    { id: 0, name: '负', keys: ['a'], content: '正文', insertion_order: -1 },
    { id: 1, name: '超', keys: ['b'], content: '正文', insertion_order: 88 },
  ]);
  const issues = audit(card, [
    {
      id: 'mine:depth',
      type: 'number-range',
      min: 0,
      max: 50,
      message: '触发深度超出范围',
      scope: 'worldbook:entries[].insertion_order',
      severity: 'error',
      category: 'worldbook',
    },
  ]);
  const hits = issues.filter((issue) => issue.ruleId === 'mine:depth');
  assert.equal(hits.length, 2);
  assert.match(hits[0].message, /-1/);
  assert.match(hits[1].message, /88/);
});

test('作用域守卫：拼错的 worldbook 字段名不会静默生效（也不误伤）', () => {
  const card = withEntries([{ id: 0, keys: [], content: '正文' }]);
  const issues = audit(card, [
    {
      id: 'mine:typo',
      type: 'non-empty',
      message: '不该出现',
      // 少写一个 s：解析成 null → 该规则不命中任何文本
      scope: 'worldbook:entries[].key',
      severity: 'error',
      category: 'worldbook',
    },
  ]);
  assert.equal(issues.some((issue) => issue.ruleId === 'mine:typo'), false);
});

test('作用域守卫：普通板块规则不会被塞进世界书评估路径', () => {
  const card = withEntries([{ id: 0, keys: [], content: '正文' }]);
  const issues = audit(card, [
    {
      id: 'mine:block-rule',
      type: 'non-empty',
      message: '基本信息不能为空',
      scope: 'block:basic',
      severity: 'error',
    },
  ]);
  assert.equal(issues.some((issue) => issue.ruleId === 'mine:block-rule'), false);
});

// ────────────────────────────────────────────── ④ 端到端去重（审计报告层）

test('去重（端到端）：buildAuditReport 里每条世界书规则对每个条目只报一次', async () => {
  // 这条是实测抓出来的：用户写的世界书规则会同时被 validateCard 与
  // validateWorldbookRules 求值，于是 mine:depth-range 在同一次审计里出现两次。
  // 断言放在**审计报告**层而不是引擎层，因为只有组装后才看得出"整体重复"。
  const { buildAuditReport } = await import('../shared/dist/index.js');
  const card = withEntries([{ id: 4, name: '\u7231\u597d', keys: [], content: '\u6b63\u6587', insertion_order: 88 }]);
  const resolved = resolvePlatformRule('wb-rules-test', [
    {
      ...BASE_RULE,
      rules: [
        {
          id: 'mine:depth-range',
          type: 'number-range',
          min: 0,
          max: 10,
          message: 'depth out of range',
          scope: 'worldbook:entries[].insertion_order',
          severity: 'warning',
          category: 'worldbook',
        },
      ],
    },
  ]);
  const report = buildAuditReport(card, { platformRule: resolved });

  const depth = report.issues.filter((issue) => issue.ruleId === 'mine:depth-range');
  assert.equal(depth.length, 1, `同一条目同一条规则只该报一次，实际 ${String(depth.length)} 次`);

  const noTrigger = report.issues.filter((issue) => issue.ruleId === 'builtin:worldbook-no-trigger');
  assert.equal(noTrigger.length, 1, '内置那条也只该报一次');

  const ids = report.issues.map((issue) => issue.id);
  assert.equal(new Set(ids).size, ids.length, JSON.stringify(ids));
});
