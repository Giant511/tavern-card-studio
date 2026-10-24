/**
 * 世界书格式预设（T10.31）：铁律 + round-trip。
 *
 * 这个文件里**第一条测试是全局最重要的**：`default` 预设的参数必须让
 * `renderWorldbookText` 的输出与 docs/04 v1.0 冻结格式**逐字节相同**。
 * 期望值在测试里**手写**（不是用 `renderWorldbookTextWith(entries, DEFAULT_...)` 反算）——
 * 反算出来的"一致"什么也证明不了。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_WORLDBOOK_FORMAT,
  DEFAULT_WORLDBOOK_PRESET,
  parseWorldbookPreset,
} from '../shared/dist/format/worldbook-preset.js';
import {
  parseWorldbookText,
  parseWorldbookTextWith,
  renderWorldbookText,
  renderWorldbookTextWith,
} from '../shared/dist/format/worldbook.js';

/** 覆盖全部 11 个可见字段 + 正文的条目（字段顺序故意写乱，写出顺序由预设决定） */
const ENTRIES = [
  {
    id: 0,
    name: '银座',
    keys: ['银座', 'Ginza'],
    secondary_keys: [],
    constant: false,
    enabled: true,
    insertion_order: 100,
    position: 'before_char',
    priority: 10,
    case_sensitive: false,
    selective: true,
    comment: '地名',
    content: '银座是东京的一个区。',
  },
  {
    id: 1,
    name: '常驻设定',
    keys: [],
    constant: true,
    content: '第一行\n第二行',
  },
];

/** v1.0 冻结格式的**手写**期望值 */
const V1_EXPECTED = [
  '@@ENTRY 0',
  'name: 银座',
  'keys: 银座, Ginza',
  'secondary_keys:',
  'constant: false',
  'enabled: true',
  'insertion_order: 100',
  'position: before_char',
  'priority: 10',
  'case_sensitive: false',
  'selective: true',
  'comment: 地名',
  '@@CONTENT',
  '银座是东京的一个区。',
  '@@END 0',
  '',
  '@@ENTRY 1',
  'name: 常驻设定',
  'keys:',
  'constant: true',
  '@@CONTENT',
  '第一行',
  '第二行',
  '@@END 1',
].join('\n');

// ────────────────────────────────────────────── 1. 铁律

test('铁律：default 预设参数就是 v1.0 冻结参数（字面比对，防手滑改动）', () => {
  assert.deepEqual(DEFAULT_WORLDBOOK_FORMAT, {
    entryOpen: '@@ENTRY {id}',
    contentMark: '@@CONTENT',
    entryClose: '@@END {id}',
    fieldOrder: [
      'name',
      'keys',
      'secondary_keys',
      'constant',
      'enabled',
      'insertion_order',
      'position',
      'priority',
      'case_sensitive',
      'selective',
      'comment',
    ],
    labelMap: {},
    fieldSeparator: ': ',
    listSeparator: ', ',
    entrySeparator: '\n\n',
  });
  assert.equal(DEFAULT_WORLDBOOK_PRESET.id, 'default');
  assert.equal(DEFAULT_WORLDBOOK_PRESET.builtin, true);
});

test('铁律：default 预设导出的世界书与 v1.0 冻结格式逐字节相同', () => {
  assert.equal(renderWorldbookText(ENTRIES), V1_EXPECTED);
  // 显式走 with 版本也必须一致（两条入口不能分叉）
  assert.equal(renderWorldbookTextWith(ENTRIES, DEFAULT_WORLDBOOK_FORMAT), V1_EXPECTED);
});

test('铁律：default 解析能读回自己写出的文本（字段与正文逐项相等）', () => {
  const parsed = parseWorldbookText(V1_EXPECTED);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.issues));
  assert.equal(parsed.entries.length, 2);
  const first = parsed.entries[0];
  assert.deepEqual(first.keys, ['银座', 'Ginza']);
  assert.equal(first.position, 'before_char');
  assert.equal(first.insertion_order, 100);
  assert.equal(first.selective, true);
  assert.equal(first.content, '银座是东京的一个区。');
  assert.equal(parsed.entries[1].content, '第一行\n第二行');
});

// ────────────────────────────────────────────── 2. 自定义格式

/** 中文标签 + 不同标记 + 不同字段顺序 + 不同分隔符 */
const CUSTOM = parseWorldbookPreset({
  schemaVersion: 1,
  id: 'cn-labels',
  name: '中文标签世界书',
  version: '1.0.0',
  format: {
    entryOpen: '[[条目 {id}]]',
    contentMark: '[[正文]]',
    entryClose: '[[结束 {id}]]',
    fieldOrder: ['name', 'keys', 'position', 'insertion_order'],
    labelMap: {
      name: '名称',
      keys: '关键词',
      position: '触发位置',
      insertion_order: '触发深度',
    },
    fieldSeparator: '：',
    listSeparator: '、',
    entrySeparator: '\n\n',
  },
}).preset;

test('自定义预设：解析中文标签与自定义标记', () => {
  assert.ok(CUSTOM);
  const text = [
    '[[条目 4]]',
    '名称：爱好',
    '关键词：读书、电影',
    '触发位置：after_char',
    '触发深度：5',
    '[[正文]]',
    '主角喜欢读书和看电影。',
    '[[结束 4]]',
  ].join('\n');

  const parsed = parseWorldbookTextWith(text, CUSTOM.format);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.issues));
  assert.equal(parsed.entries.length, 1);
  const entry = parsed.entries[0];
  assert.equal(entry.id, 4);
  assert.equal(entry.name, '爱好');
  assert.deepEqual(entry.keys, ['读书', '电影']);
  assert.equal(entry.position, 'after_char');
  assert.equal(entry.insertion_order, 5);
  assert.equal(entry.content, '主角喜欢读书和看电影。');
});

test('自定义预设：round-trip 无损（含正文多行、空关键词、常驻）', () => {
  assert.ok(CUSTOM);
  const original = [
    { id: 4, name: '爱好', keys: ['读书', '电影'], position: 'after_char', insertion_order: 5, content: '第一段\n\n第二段\n' },
    { id: 5, name: '常驻', keys: [], constant: true, content: '无关键词' },
  ];
  const rendered = renderWorldbookTextWith(original, CUSTOM.format);
  const parsed = parseWorldbookTextWith(rendered, CUSTOM.format);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.issues));
  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(parsed.entries[0].keys, ['读书', '电影']);
  assert.equal(parsed.entries[0].content, '第一段\n\n第二段\n');
  assert.equal(parsed.entries[1].constant, true);
  assert.deepEqual(parsed.entries[1].keys, []);
  // 再渲染一次必须与本轮逐字节相同（幂等）
  assert.equal(renderWorldbookTextWith(parsed.entries, CUSTOM.format), rendered);
});

test('自定义预设：字段顺序只影响写出，解析不依赖顺序', () => {
  assert.ok(CUSTOM);
  const text = [
    '[[条目 0]]',
    '触发深度：7',
    '关键词：甲',
    '名称：乱序',
    '[[正文]]',
    '正文',
    '[[结束 0]]',
  ].join('\n');
  const parsed = parseWorldbookTextWith(text, CUSTOM.format);
  assert.equal(parsed.ok, true);
  const entry = parsed.entries[0];
  assert.equal(entry.name, '乱序');
  assert.deepEqual(entry.keys, ['甲']);
  assert.equal(entry.insertion_order, 7);
  // 写出时按预设顺序：name → keys → position → insertion_order
  const rendered = renderWorldbookTextWith([entry], CUSTOM.format);
  assert.ok(rendered.indexOf('名称：') < rendered.indexOf('关键词：'));
  assert.ok(rendered.indexOf('关键词：') < rendered.indexOf('触发深度：'));
});

test('自定义预设：认不出的标签只报 unknown-field，不影响其它字段', () => {
  assert.ok(CUSTOM);
  const text = [
    '[[条目 0]]',
    '名称：甲',
    '体重：3',
    '关键词：乙',
    '[[正文]]',
    '正文',
    '[[结束 0]]',
  ].join('\n');
  const parsed = parseWorldbookTextWith(text, CUSTOM.format);
  const unknown = parsed.issues.filter((issue) => issue.code === 'unknown-field');
  assert.equal(unknown.length, 1);
  assert.match(unknown[0].message, /体重/);
  assert.equal(parsed.entries[0].name, '甲');
  assert.deepEqual(parsed.entries[0].keys, ['乙']);
});

// ────────────────────────────────────────────── 3. 预设本身的校验

test('预设校验：标记必须含 {id}，否则 round-trip 会丢 id', () => {
  const result = parseWorldbookPreset({
    schemaVersion: 1,
    id: 'bad',
    name: 'bad',
    version: '1.0.0',
    format: { entryOpen: '[[条目]]', contentMark: '[[正文]]', entryClose: '[[结束 {id}]]' },
  });
  assert.equal(result.preset, null);
  assert.ok(result.errors.some((error) => error.includes('{id}')));
});

test('预设校验：三个标记文字相同 → 解析二义', () => {
  const result = parseWorldbookPreset({
    schemaVersion: 1,
    id: 'dup-mark',
    name: 'dup',
    version: '1.0.0',
    format: { entryOpen: '[[X {id}]]', contentMark: '[[X]]', entryClose: '[[X {id}]]' },
  });
  assert.equal(result.preset, null);
  assert.ok(result.errors.some((error) => error.includes('二义')));
});

test('预设校验：labelMap 同一标签给了两个字段 → 反解二义', () => {
  const result = parseWorldbookPreset({
    schemaVersion: 1,
    id: 'dup-label',
    name: 'dup',
    version: '1.0.0',
    format: {
      entryOpen: '@@ENTRY {id}',
      contentMark: '@@CONTENT',
      entryClose: '@@END {id}',
      labelMap: { name: '字段', comment: '字段' },
    },
  });
  assert.equal(result.preset, null);
  assert.ok(result.errors.some((error) => error.includes('二义')));
});

test('预设校验：fieldOrder 不能含 content；未知字段报错', () => {
  const result = parseWorldbookPreset({
    schemaVersion: 1,
    id: 'bad-order',
    name: 'bad',
    version: '1.0.0',
    format: {
      entryOpen: '@@ENTRY {id}',
      contentMark: '@@CONTENT',
      entryClose: '@@END {id}',
      fieldOrder: ['content', 'nope'],
    },
  });
  assert.equal(result.preset, null);
  assert.ok(result.errors.some((error) => error.includes('content')));
  assert.ok(result.errors.some((error) => error.includes('nope')));
});

test('预设校验：未知键走 warning 不阻断（F4 机制），并能给出改名建议', () => {
  const result = parseWorldbookPreset({
    schemaVersion: 1,
    id: 'typo',
    name: 'typo',
    version: '1.0.0',
    format: {
      entryOpen: '@@ENTRY {id}',
      contentMark: '@@CONTENT',
      entryClose: '@@END {id}',
      fieldSeperator: ': ',
      labelMap: { name: '名称' },
    },
  });
  assert.ok(result.preset, JSON.stringify(result.errors));
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /fieldSeperator/);
  assert.match(result.warnings[0], /fieldSeparator/);
});

test('预设校验：缺省参数按 v1.0 补齐；未列出的字段排在已知字段之后', () => {
  const result = parseWorldbookPreset({
    schemaVersion: 1,
    id: 'partial',
    name: 'partial',
    version: '1.0.0',
    format: {
      entryOpen: '[[E {id}]]',
      contentMark: '[[C]]',
      entryClose: '[[X {id}]]',
      fieldOrder: ['comment'],
    },
  });
  assert.ok(result.preset, JSON.stringify(result.errors));
  const format = result.preset.format;
  assert.equal(format.fieldSeparator, ': ');
  assert.equal(format.listSeparator, ', ');
  assert.equal(format.entrySeparator, '\n\n');
  assert.equal(format.fieldOrder[0], 'comment');
  assert.equal(format.fieldOrder.length, 11, '十一个字段一个都不能少');
  assert.equal(new Set(format.fieldOrder).size, 11);
});

test('预设校验：用户导入的预设 builtin 缺省为 false（不会伪装成内置）', () => {
  const result = parseWorldbookPreset({
    schemaVersion: 1,
    id: 'mine',
    name: 'mine',
    version: '1.0.0',
    format: { entryOpen: '@@ENTRY {id}', contentMark: '@@CONTENT', entryClose: '@@END {id}' },
  });
  assert.equal(result.preset?.builtin, false);
});
