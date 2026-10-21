/**
 * 世界书 TXT 格式 v1.0 的双向解析与合并语义测试。
 * 覆盖冻结决策：id 锚点 + 重复 id 报错、\@@ 双重转义、extensions 按 id 挂回、TXT 为事实源。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  ensureEntryIds,
  mergeWorldbookEntries,
  parseWorldbookText,
  renderWorldbookText,
  WORLDBOOK_VISIBLE_KEYS,
} from '../shared/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(readFileSync(join(here, 'fixtures/sample-card.json'), 'utf8'));

/** 只保留 TXT 可见字段，用于「可见字段无损」断言 */
function visible(entry) {
  const out = {};
  for (const key of WORLDBOOK_VISIBLE_KEYS) {
    if (key in entry) out[key] = entry[key];
  }
  return out;
}

function roundTrip(entries) {
  const text = renderWorldbookText(entries);
  const parsed = parseWorldbookText(text);
  return { text, parsed };
}

test('样例卡世界书：TXT → 解析 → 合并 深度相等（含 extensions 与未知键）', () => {
  const entries = sample.data.character_book.entries.map((entry) => ({ ...entry, extensions: { keep: 'me' } }));
  const { parsed } = roundTrip(entries);
  assert.deepEqual(parsed.issues, []);
  const merged = mergeWorldbookEntries(entries, parsed.entries);
  assert.deepEqual(merged.entries, entries);
  assert.deepEqual(merged.added, []);
  assert.deepEqual(merged.removed, []);
  assert.deepEqual(merged.preserved, [0, 1]);
});

test('可见字段往返：parse(render(e)) 的可见字段与原条目一致', () => {
  const entries = sample.data.character_book.entries;
  const { parsed } = roundTrip(entries);
  assert.deepEqual(parsed.entries.map(visible), entries.map(visible));
});

test('幂等：render(parse(render(e))) === render(e)', () => {
  const entries = sample.data.character_book.entries;
  const once = renderWorldbookText(entries);
  const twice = renderWorldbookText(parseWorldbookText(once).entries);
  assert.equal(twice, once);
});

test('转义：正文行首 @@ / \\@@ / \\\\@@ 三种形态 round-trip 严格无损', () => {
  const content = ['@@END 3', '\\@@END 3', '\\\\@@END 3', 'C:\\@@x', '@@CONTENT', 'normal'].join('\n');
  const entries = [{ id: 3, keys: ['a'], content }];
  const { text, parsed } = roundTrip(entries);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.entries[0].content, content);
  // 写出确实做了「多一个反斜杠」的转义
  assert.ok(text.includes('\n\\@@END 3\n'));
  assert.ok(text.includes('\n\\\\@@END 3\n'));
  assert.ok(text.includes('\n\\\\\\@@END 3\n'));
  // 非行首的 C:\@@x 不受影响
  assert.ok(text.includes('\nC:\\@@x\n'));
});

test('转义：字面 \\@@ 不会被吃掉（方案 A 的核心保障）', () => {
  const literally = '\\@@END 0';
  const { parsed } = roundTrip([{ id: 0, keys: ['a'], content: literally }]);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.entries[0].content, literally);
});

test('正交性：key: value、---、连续空行、行尾空格、CRLF 均逐字还原', () => {
  const cases = [
    'keys: 银座\n---\n\n\n行尾空格   \n',
    'line1\r\nline2\r\n',
    '\n\n开头两个空行\n',
    '结尾无换行',
    'a\n\n\n\nb',
  ];
  for (const content of cases) {
    const { parsed } = roundTrip([{ id: 0, keys: ['a'], content }]);
    assert.equal(parsed.entries[0].content, content, JSON.stringify(content));
  }
});

test('重复 id：报错并给出行号，且不静默合并（两条目都保留在结果里）', () => {
  const text = [
    '@@ENTRY 0',
    'keys: a',
    '@@CONTENT',
    'A',
    '@@END 0',
    '',
    '@@ENTRY 0',
    'keys: b',
    '@@CONTENT',
    'B',
    '@@END 0',
  ].join('\n');
  const parsed = parseWorldbookText(text);
  const dup = parsed.issues.filter((issue) => issue.code === 'duplicate-id');
  assert.equal(dup.length, 1);
  assert.equal(dup[0].severity, 'error');
  assert.equal(dup[0].entryId, 0);
  assert.equal(dup[0].line, 7);
  assert.equal(parsed.ok, false);
  // 禁止静默合并：两条都还在，由调用方决定是否中止
  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(parsed.entries.map((entry) => entry.content), ['A', 'B']);
});

test('结构错误：缺 @@CONTENT / 缺 @@END / @@END id 不匹配 均报 error 并带行号', () => {
  const noContent = parseWorldbookText('@@ENTRY 0\nkeys: a\n@@END 0');
  assert.equal(noContent.ok, false);
  assert.ok(noContent.issues.some((issue) => issue.code === 'missing-content' && issue.severity === 'error'));
  assert.deepEqual(noContent.entries, []);

  const noEnd = parseWorldbookText('@@ENTRY 1\nkeys: a\n@@CONTENT\nA');
  assert.equal(noEnd.ok, false);
  assert.ok(noEnd.issues.some((issue) => issue.code === 'missing-end' && issue.severity === 'error'));

  const mismatch = parseWorldbookText('@@ENTRY 2\nkeys: a\n@@CONTENT\nA\n@@END 9');
  assert.equal(mismatch.ok, false);
  const mismatched = mismatch.issues.find((issue) => issue.code === 'mismatched-end');
  assert.equal(mismatched.line, 5);
  assert.equal(mismatched.entryId, 2);
});

test('告警：未知字段、空 keys 且非常驻、@@ENTRY 前说明文字', () => {
  const text = ['说明文字一行', '@@ENTRY 0', 'keys:', 'ext_note: 看不见', '@@CONTENT', 'A', '@@END 0'].join('\n');
  const parsed = parseWorldbookText(text);
  const codes = parsed.issues.map((issue) => issue.code);
  assert.ok(codes.includes('leading-text'));
  assert.ok(codes.includes('unknown-field'));
  assert.ok(codes.includes('no-keys'));
  assert.ok(parsed.issues.every((issue) => issue.severity === 'warning'));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.entries[0].keys, []);
});

test('合并语义：TXT 为事实源——TXT 中删掉的条目即删除', () => {
  const original = [
    { id: 0, keys: ['a'], content: 'A', extensions: { x: 1 } },
    { id: 1, keys: ['b'], content: 'B', extensions: { y: 2 } },
    { id: 2, keys: ['c'], content: 'C' },
  ];
  const parsed = parseWorldbookText('@@ENTRY 0\nkeys: a\n@@CONTENT\nA2\n@@END 0');
  const merged = mergeWorldbookEntries(original, parsed.entries);
  assert.deepEqual(merged.removed, [1, 2]);
  assert.deepEqual(merged.entries.map((entry) => entry.id), [0]);
  assert.equal(merged.entries[0].content, 'A2');
  // extensions 按 id 挂回
  assert.deepEqual(merged.entries[0].extensions, { x: 1 });
  assert.deepEqual(merged.preserved, [0]);
});

test('合并语义：TXT 中重排 → 结果顺序即 TXT 顺序，extensions 跟随 id', () => {
  const original = [
    { id: 0, keys: ['a'], content: 'A', extensions: { x: 1 } },
    { id: 1, keys: ['b'], content: 'B', extensions: { y: 2 } },
    { id: 2, keys: ['c'], content: 'C', extensions: { z: 3 } },
  ];
  const parsed = parseWorldbookText(
    ['@@ENTRY 2', 'keys: c', '@@CONTENT', 'C', '@@END 2', '', '@@ENTRY 0', 'keys: a', '@@CONTENT', 'A', '@@END 0'].join('\n'),
  );
  const merged = mergeWorldbookEntries(original, parsed.entries);
  assert.deepEqual(merged.entries.map((entry) => entry.id), [2, 0]);
  assert.deepEqual(merged.entries.map((entry) => entry.extensions), [{ z: 3 }, { x: 1 }]);
  assert.deepEqual(merged.removed, [1]);
});

test('合并语义：新 id 视为新增；dropMissing=false 时保留原表多余条目', () => {
  const original = [{ id: 0, keys: ['a'], content: 'A' }];
  const parsed = parseWorldbookText('@@ENTRY 9\nkeys: new\n@@CONTENT\nN\n@@END 9');
  const dropped = mergeWorldbookEntries(original, parsed.entries);
  assert.deepEqual(dropped.added, [9]);
  assert.deepEqual(dropped.removed, [0]);

  const kept = mergeWorldbookEntries(original, parsed.entries, { dropMissing: false });
  assert.deepEqual(kept.removed, []);
  assert.deepEqual(kept.entries.map((entry) => entry.id), [9, 0]);
});

test('合并语义：未知键（非 extensions）同样按 id 保留', () => {
  const original = [{ id: 0, keys: ['a'], content: 'A', uid: 'abc', depth: 4 }];
  const { parsed } = roundTrip(original);
  const merged = mergeWorldbookEntries(original, parsed.entries);
  assert.equal(merged.entries[0].uid, 'abc');
  assert.equal(merged.entries[0].depth, 4);
});

test('空世界书：entries [] → 空串；空串 → 无条目无报错', () => {
  assert.equal(renderWorldbookText([]), '');
  const parsed = parseWorldbookText('');
  assert.deepEqual(parsed.entries, []);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.ok, true);
});

test('缺 id：ensureEntryIds 补号且不冲突', () => {
  const entries = [{ keys: ['a'], content: 'A' }, { id: 0, keys: ['b'], content: 'B' }, { keys: ['c'], content: 'C' }];
  const result = ensureEntryIds(entries);
  assert.equal(result.changed, true);
  const ids = result.entries.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  // 原数组不被改动
  assert.equal(entries[0].id, undefined);
  // 补号后渲染 → 解析 → 合并 仍无损
  const { parsed } = roundTrip(result.entries);
  assert.deepEqual(mergeWorldbookEntries(result.entries, parsed.entries).entries, result.entries);
});

test('列表与布尔/数字/位置的写法：含逗号项加引号、position 枚举化', () => {
  const entries = [
    {
      id: 0,
      keys: ['咖啡馆, 二号店', '银座'],
      secondary_keys: [],
      content: 'x',
      constant: true,
      enabled: false,
      insertion_order: 120,
      position: 1,
      case_sensitive: true,
      selective: false,
      comment: '备注',
      name: '条目A',
    },
  ];
  const { text, parsed } = roundTrip(entries);
  assert.ok(text.includes('keys: "咖啡馆, 二号店", 银座'));
  assert.ok(text.includes('position: after_char'));
  assert.deepEqual(parsed.entries[0].keys, ['咖啡馆, 二号店', '银座']);
  assert.equal(parsed.entries[0].position, 'after_char');
  assert.equal(parsed.entries[0].constant, true);
  assert.equal(parsed.entries[0].enabled, false);
  assert.equal(parsed.entries[0].selective, false);
  assert.equal(parsed.entries[0].comment, '备注');
});
