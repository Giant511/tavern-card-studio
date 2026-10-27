/**
 * 用户预设库的磁盘格式（v0.1.5 / G5）。
 *
 * 这一层的错误**全部是静默型**，所以每条断言都指向一个具体后果：
 *   · 序列化丢了 id → 下次导入同 id 会存成两条，库无限膨胀；
 *   · 解析时一条坏数据把整库判死 → 用户 6 个预设一起消失；
 *   · 版本不认就直接拒绝 → 装了新版再退回旧版，预设全没；
 *   · 超限不拦 → 一个畸形文件让启动卡几秒，用户只看到"打开很慢"。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PRESET_LIBRARY_LIMITS,
  PRESET_LIBRARY_VERSION,
  parsePresetLibrary,
  removeLibraryItem,
  serializePresetLibrary,
  upsertLibraryItem,
} from '../client/src/rules/preset-store.ts';

/**
 * 造一条样本。
 *
 * 这里不写 `import type { PresetLibraryItem }` —— Node 的类型剥离只去掉
 * **类型注解**，`import type` 语句本身仍会被当作值导入解析而报语法错误。
 * 既有测试（card-id.test.mjs 等）同样只导入值，保持一致。
 *
 * @param {Record<string, unknown>} [overrides]
 * @returns {{ kind: string, id: string | null, name: string, text: string }}
 */
const sample = (overrides = {}) => ({
  kind: 'worldbook',
  id: 'huanmeng',
  name: '幻梦AI世界书格式预设.json',
  text: '{"id":"huanmeng","name":"幻梦AI"}',
  ...overrides,
});

test('往返：序列化再解析，条目逐字段相同', () => {
  const items = [
    sample(),
    sample({ kind: 'greeting', id: 'greet-a', name: 'a.json', text: '{"id":"greet-a"}' }),
    sample({ kind: 'chat-examples', id: 'chat-a', name: 'b.json', text: '{"id":"chat-a"}' }),
  ];
  const result = parsePresetLibrary(serializePresetLibrary(items, new Date('2026-10-26T00:00:00Z')));
  assert.equal(result.error, null);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.items, items);
});

test('落盘的版本号与常量一致（改格式必须显式改版本）', () => {
  const parsed = JSON.parse(serializePresetLibrary([], new Date('2026-10-26T00:00:00Z')));
  assert.equal(parsed.version, PRESET_LIBRARY_VERSION);
  assert.equal(parsed.savedAt, '2026-10-26T00:00:00.000Z');
});

test('原文逐字节保真：含换行与中文的文件不会被重新格式化', () => {
  const text = '{\n  "id": "x",\n  "名称": "中文键",\n  "extra": 1\n}\n';
  const round = parsePresetLibrary(serializePresetLibrary([sample({ text })]));
  assert.equal(round.items[0]?.text, text, '含未知键与 CRLF/LF 的原文必须原样回来');
});

test('一条坏数据只丢它自己，其余照常加载', () => {
  // 这是最要紧的容错：坏一条不该让 5 个预设一起消失
  const doc = {
    version: PRESET_LIBRARY_VERSION,
    items: [
      { kind: 'worldbook', id: 'ok1', name: 'a', text: '{"id":"ok1"}' },
      { kind: '外星预设', id: 'bad', name: 'b', text: '{}' }, // 未知 kind
      { kind: 'txt', id: 'no-text', name: 'c' }, // 缺 text
      { kind: 'greeting', id: 'ok2', name: 'd', text: '{"id":"ok2"}' },
      { notAnObject: true }, // 不是对象
    ],
  };
  const result = parsePresetLibrary(JSON.stringify(doc));
  assert.equal(result.error, null);
  assert.deepEqual(
    result.items.map((item) => item.id),
    ['ok1', 'ok2'],
  );
  assert.equal(result.warnings.length, 3, '三条坏数据各给一条警告：' + result.warnings.join(' / '));
  for (const warning of result.warnings) assert.match(warning, /已跳过/);
});

test('顶层不是 JSON / 不是对象 → error，且不返回任何条目', () => {
  for (const text of ['不是 JSON', '[]', 'null', '42']) {
    const result = parsePresetLibrary(text);
    assert.notEqual(result.error, null, `${text} 应当报 error`);
    assert.deepEqual(result.items, [], `${text} 不该返回条目`);
  }
  // items 不是数组同样是致命（说明文件被换成了别的东西）
  const wrongItems = parsePresetLibrary(JSON.stringify({ version: 1, items: {} }));
  assert.notEqual(wrongItems.error, null);
});

test('版本比当前新 → 只警告，仍尽力读取（装回旧版不该丢光）', () => {
  const doc = { version: PRESET_LIBRARY_VERSION + 5, items: [{ kind: 'txt', id: 'a', name: 'n', text: '{}' }] };
  const result = parsePresetLibrary(JSON.stringify(doc));
  assert.equal(result.error, null);
  assert.equal(result.items.length, 1, '要能读出来');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /版本/);
});

test('缺 version 也读，只警告（早期手写文件不至于全废）', () => {
  const result = parsePresetLibrary(JSON.stringify({ items: [{ kind: 'txt', id: 'a', name: 'n', text: '{}' }] }));
  assert.equal(result.error, null);
  assert.equal(result.items.length, 1);
  assert.match(result.warnings[0], /version/);
});

test('单条超限被跳过并说明原因（防畸形文件拖慢启动）', () => {
  const huge = 'x'.repeat(PRESET_LIBRARY_LIMITS.maxItemBytes + 1);
  const result = parsePresetLibrary(
    JSON.stringify({ version: 1, items: [{ kind: 'txt', id: 'big', name: 'n', text: huge }] }),
  );
  assert.deepEqual(result.items, []);
  assert.match(result.warnings[0], /超过单条上限/);
});

test('条数超限只读前 N 条，不静默截断', () => {
  const items = Array.from({ length: PRESET_LIBRARY_LIMITS.maxItems + 3 }, (_, index) => ({
    kind: 'txt',
    id: `p${String(index)}`,
    name: 'n',
    text: '{}',
  }));
  const result = parsePresetLibrary(JSON.stringify({ version: 1, items }));
  assert.equal(result.items.length, PRESET_LIBRARY_LIMITS.maxItems);
  assert.match(result.warnings[0] ?? '', /上限/);
});

test('同 kind 同 id 再导一次 → 替换而不是新增（库不膨胀）', () => {
  let items = upsertLibraryItem([], 'worldbook', 'a.json', '{"id":"w","v":1}', 'w');
  items = upsertLibraryItem(items, 'worldbook', 'a.json', '{"id":"w","v":2}', 'w');
  assert.equal(items.length, 1, '同 id 必须替换');
  assert.match(items[0].text, /"v":2/);
});

test('不同 kind 的同 id 互不影响（六类各有自己的命名空间）', () => {
  let items = upsertLibraryItem([], 'worldbook', 'a', '{"id":"same"}', 'same');
  items = upsertLibraryItem(items, 'greeting', 'a', '{"id":"same"}', 'same');
  assert.equal(items.length, 2, 'kind 不同就是两份不同的预设');
});

test('解析不出 id 时退回按内容去重（绝不存成两条一模一样）', () => {
  let items = upsertLibraryItem([], 'txt', 'a', 'not-json', null);
  items = upsertLibraryItem(items, 'txt', 'a', 'not-json', null);
  assert.equal(items.length, 1);
  // 内容不同、id 未知 → 两条都要留（不能因为没 id 就把它们并了）
  items = upsertLibraryItem(items, 'txt', 'a', 'another', null);
  assert.equal(items.length, 2);
});

test('removeLibraryItem：按 kind 清空 / 按 id 精确删除', () => {
  const items = [
    sample({ id: 'w1' }),
    sample({ id: 'w2' }),
    sample({ kind: 'txt', id: 't1', text: '{}' }),
  ];
  assert.equal(removeLibraryItem(items, 'worldbook', 'w1').length, 2);
  const cleared = removeLibraryItem(items, 'worldbook', null);
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].id, 't1');
});

test('中文按 UTF-8 字节计上限（不是字符数）', () => {
  // 用字符数算会把上限放宽三倍 —— 这条防止"以为拦住了其实没拦"
  const almost = '中'.repeat(Math.floor(PRESET_LIBRARY_LIMITS.maxItemBytes / 3));
  const ok = parsePresetLibrary(JSON.stringify({ version: 1, items: [{ kind: 'txt', id: 'a', name: '', text: almost }] }));
  assert.equal(ok.items.length, 1, '刚好在限内要能读');
  const over = parsePresetLibrary(
    JSON.stringify({ version: 1, items: [{ kind: 'txt', id: 'a', name: '', text: almost + '中中' }] }),
  );
  assert.deepEqual(over.items, [], '超一点也要拦');
});
