/**
 * T10.9 世界书独立导入 / 导出。
 *
 * 重点覆盖需求点名的四类边界：
 *   ① 坏 JSON 的**错误定位**（行/列，而不是"格式不对"一句话）；
 *   ② 缺 id 自动补号**并写回**（v1.0 冻结格式点，不得回退）；
 *   ③ 行首 `@@` 转义；
 *   ④ 字面 `\@@` 的**双重**转义（方案 A 的核心保障）；
 * 外加需求 4 的硬要求：JSON → 导入 → 导出 → **逐字节一致**。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  detectWorldbookFormat,
  exportWorldbook,
  importWorldbook,
  locateEntryOffsets,
  offsetFromJsonError,
  parseWorldbookJson,
  renderWorldbookJson,
  renderWorldbookText,
  parseWorldbookText,
  toCharacterBook,
} from '../shared/dist/index.js';

// ── ① 错误定位 ─────────────────────────────────────────────

test('T10.9 坏 JSON：给出 1-based 行号与列号，不是一句"格式不对"', () => {
  // 第 3 行第 21 列附近多了一个逗号
  const broken = `{
  "entries": [
    { "id": 0, "keys": [], "content": "x" },
  ]
}`;
  const result = parseWorldbookJson(broken);
  assert.equal(result.ok, false);
  const issue = result.issues.find((item) => item.code === 'json-syntax');
  assert.ok(issue, `应报 json-syntax，实际 ${JSON.stringify(result.issues)}`);
  assert.equal(issue.severity, 'error');
  // 位置必须落在文件内，且指向出错的那一行附近
  assert.equal(typeof issue.line, 'number');
  assert.ok(issue.line >= 3, `行号应指向第 3 行附近，实际 ${String(issue.line)}`);
  assert.ok(issue.message.includes('JSON 语法错误'));
});

test('T10.9 坏 JSON：偏移与行列换算（CRLF 只算一次换行）', () => {
  const text = '{\r\n  "a": 1,\r\n}';
  const offset = text.indexOf('}');
  const fromError = offsetFromJsonError(`Unexpected token } in JSON at position ${String(offset)}`);
  assert.equal(fromError, offset);

  const result = parseWorldbookJson(text);
  const issue = result.issues.find((item) => item.code === 'json-syntax');
  assert.ok(issue);
  assert.equal(issue.line, 3, 'CRLF 要按一个换行算，所以 } 在第 3 行');
});

test('T10.9 坏 JSON：取不到偏移时不编位置', () => {
  assert.equal(offsetFromJsonError('Boom without position'), null);
});

test('T10.9 条目级错误带 entryIndex 与行号', () => {
  const text = `{
  "entries": [
    { "id": 0, "keys": ["a"], "content": "ok" },
    "这是字符串不是对象",
    { "id": 2, "keys": ["c"], "content": "ok2" }
  ]
}`;
  const result = parseWorldbookJson(text);
  assert.equal(result.ok, false);
  const bad = result.issues.find((item) => item.code === 'entry-not-object');
  assert.ok(bad);
  assert.equal(bad.entryIndex, 1);
  assert.equal(typeof bad.line, 'number');
  assert.ok(bad.line >= 3 && bad.line <= 5, `行号应指向第二个条目，实际 ${String(bad.line)}`);
});

test('T10.9 条目 offsets 扫描：三种 JSON 形态都能定位', () => {
  const bare = '[{"id":0},{"id":1}]';
  assert.equal(locateEntryOffsets(bare).length, 2);

  const wrapped = '{"entries":[{"id":0},{"id":1},{"id":2}]}';
  assert.equal(locateEntryOffsets(wrapped, true).length, 3);

  // 字符串里的 `[` 不能被当成数组起点
  const tricky = '{"entries":[{"id":0,"content":"有 [ 和 ] 和 \\" 引号"},{"id":1}]}';
  assert.equal(locateEntryOffsets(tricky, true).length, 2);
});

// ── 三种 JSON 形态 ────────────────────────────────────────

test('T10.9 JSON 形态：裸数组 / {entries} / 整卡 character_book 都能导入', () => {
  const bare = importWorldbook('[{"id":0,"keys":["a"],"content":"x"}]');
  assert.equal(bare.ok, true);
  assert.equal(bare.entries.length, 1);

  const wrapped = importWorldbook('{"entries":[{"id":0,"keys":["a"],"content":"x"}],"name":"书"}');
  assert.equal(wrapped.ok, true);
  assert.equal(wrapped.entries.length, 1);
  assert.equal(wrapped.meta['name'], '书');

  const whole = importWorldbook(
    '{"data":{"character_book":{"entries":[{"id":0,"keys":["a"],"content":"x"}],"scan_depth":4}}}',
  );
  assert.equal(whole.ok, true);
  assert.equal(whole.entries.length, 1);
  assert.equal(whole.meta['scan_depth'], 4, '周边字段必须保留，导出时带出');
});

test('T10.9 JSON：character_book 为 null 视为空世界书（合法，不报错）', () => {
  const result = importWorldbook('{"character_book": null}');
  assert.equal(result.ok, true);
  assert.equal(result.entries.length, 0);
});

test('T10.9 JSON：没有 entries 字段 → error，不静默导成空世界书', () => {
  const result = importWorldbook('{"name":"只有名字"}');
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'no-entries-key'));
});

test('T10.9 JSON：条目缺 keys / content 时告警但仍可导入（不静默丢条目）', () => {
  const result = importWorldbook('{"entries":[{"id":0}]}');
  assert.equal(result.ok, true, '只有 warning 时应可导入');
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.entries[0].keys, []);
  assert.equal(result.entries[0].content, '');
  assert.ok(result.issues.some((issue) => issue.code === 'entry-no-keys'));
});

// ── 需求 4：逐字节往返 ────────────────────────────────────

const MESSY_JSON = `{"entries":[
    {"id":0,"keys":["银座"],"content":"第一行\\n第二行","extensions":{"x":1}},
    {"id":1,"keys":["耳钉"],"content":"遗物","constant":true}
],"name":"测试书","scan_depth":3}`;

test('T10.9 JSON → 导入 → 导出：未改动时**逐字节一致**', () => {
  const imported = importWorldbook(MESSY_JSON);
  assert.equal(imported.ok, true);
  const exported = exportWorldbook({
    entries: imported.entries,
    meta: imported.meta,
    format: 'json',
    source: imported,
  });
  assert.equal(exported.verbatim, true, '未改动必须走原文写回');
  assert.equal(exported.text, MESSY_JSON);
  // 逐字节比较（不是"解析后相等"）
  assert.ok(Buffer.from(exported.text, 'utf8').equals(Buffer.from(MESSY_JSON, 'utf8')));
});

test('T10.9 JSON：改动条目后走规范序列化，并明确告知（不是悄悄重排）', () => {
  const imported = importWorldbook(MESSY_JSON);
  const edited = imported.entries.map((entry, index) =>
    index === 0 ? { ...entry, content: '改过了' } : entry,
  );
  const exported = exportWorldbook({ entries: edited, meta: imported.meta, format: 'json', source: imported });
  assert.equal(exported.verbatim, false);
  assert.match(String(exported.reason), /改动/);
  const reparsed = JSON.parse(exported.text);
  assert.equal(reparsed.entries[0].content, '改过了');
  // 周边字段与未知键都要在
  assert.equal(reparsed.name, '测试书');
  assert.equal(reparsed.scan_depth, 3);
  assert.deepEqual(reparsed.entries[0].extensions, { x: 1 });
});

test('T10.9 JSON 规范序列化幂等：render(parse(render(x))) === render(x)', () => {
  const imported = importWorldbook(MESSY_JSON);
  const once = renderWorldbookJson(imported.entries, imported.meta);
  const twice = renderWorldbookJson(parseWorldbookJson(once).entries, imported.meta);
  assert.equal(once, twice);
});

test('T10.9 JSON：键顺序不同不算改动（仍走原文写回）', () => {
  const imported = importWorldbook(MESSY_JSON);
  // 深拷贝并把 content 放到前面：语义没变
  const reordered = imported.entries.map((entry) => {
    const { content, ...rest } = entry;
    return { content, ...rest };
  });
  const exported = exportWorldbook({ entries: reordered, meta: imported.meta, format: 'json', source: imported });
  assert.equal(exported.verbatim, true);
});

// ── ②③④ TXT 边界（v1.0 冻结点）───────────────────────────

test('T10.9 缺 id：导入后补号、导出写回 id，二次导出稳定', () => {
  // 缺 id 的条目（模拟从 JSON 导入的条目没有 id）
  const entries = [{ keys: ['x'], content: '无 id 的正文' }];
  const rendered = renderWorldbookText(entries);
  // 补号规则是「当前已用编号 +1」；一个都没用时从 0 开始（与 ST 的默认起步一致）
  assert.match(rendered, /@@ENTRY 0/, '缺 id 时应补成 0');
  assert.match(rendered, /@@END 0/);

  const reparsed = parseWorldbookText(rendered);
  assert.equal(reparsed.ok, true);
  assert.equal(reparsed.entries[0].id, 0);
  assert.equal(reparsed.entries[0].content, '无 id 的正文');

  // 二次导出稳定：写入 id 后再渲染，字节不变
  assert.equal(renderWorldbookText(reparsed.entries), rendered);
});

test('T10.9 缺 id：已用编号存在时跳过占用的号码', () => {
  const entries = [
    { id: 0, keys: ['a'], content: '有 id' },
    { keys: ['b'], content: '缺 id' },
  ];
  const rendered = renderWorldbookText(entries);
  assert.match(rendered, /@@ENTRY 1/, '0 已被占用，补号应给 1');
  const reparsed = parseWorldbookText(rendered);
  assert.deepEqual(
    reparsed.entries.map((entry) => entry.id),
    [0, 1],
  );
});

test('T10.9 行首 @@ 转义：正文里的 @@END 0 被写成 \\@@END 0 并能还原', () => {
  const entries = [{ id: 0, keys: ['a'], content: '@@END 0\n第二行' }];
  const rendered = renderWorldbookText(entries);
  assert.ok(rendered.includes('\\@@END 0'), `正文里的 @@END 应转义，实际：\n${rendered}`);

  const reparsed = parseWorldbookText(rendered);
  assert.equal(reparsed.ok, true, JSON.stringify(reparsed.issues));
  assert.equal(reparsed.entries[0].content, '@@END 0\n第二行');
});

test('T10.9 字面 \\@@ 双重转义：写成 \\\\@@ 并还原为 \@@（方案 A 核心保障）', () => {
  const entries = [{ id: 0, keys: ['a'], content: '\\@@END 0' }];
  const rendered = renderWorldbookText(entries);
  assert.ok(rendered.includes('\\\\@@END 0'), `字面 \\@@ 应再加一层转义，实际：\n${rendered}`);

  const reparsed = parseWorldbookText(rendered);
  assert.equal(reparsed.ok, true);
  // 关键：不能被吃掉一个反斜杠
  assert.equal(reparsed.entries[0].content, '\\@@END 0');
  assert.notEqual(reparsed.entries[0].content, '@@END 0');
});

test('T10.9 三层反斜杠同样无损（\\@@ → \\\\\\@@ 往返）', () => {
  const cases = ['@@END 0', '\\@@END 0', '\\\\@@END 0'];
  for (const content of cases) {
    const rendered = renderWorldbookText([{ id: 0, keys: ['a'], content }]);
    const reparsed = parseWorldbookText(rendered);
    assert.equal(reparsed.entries[0].content, content, `内容 ${JSON.stringify(content)} 往返失真`);
  }
});

test('T10.9 TXT 导入：纯文字文件（无 @@ENTRY）报 error，不静默导成空世界书', () => {
  const result = importWorldbook('这只是一段说明文字，没有任何条目。');
  assert.equal(result.format, 'txt');
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'txt-no-entries'));
});

test('T10.9 TXT 导入：重复 id 沿用 v1.0 的 error（不静默合并）', () => {
  const text = `@@ENTRY 0
keys: a
@@CONTENT
一
@@END 0

@@ENTRY 0
keys: b
@@CONTENT
二
@@END 0`;
  const result = importWorldbook(text);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'txt-duplicate-id'));
});

test('T10.9 格式识别：JSON 看首字符，TXT 看 @@ENTRY', () => {
  assert.equal(detectWorldbookFormat('  {"entries":[]}'), 'json');
  assert.equal(detectWorldbookFormat('[{"id":0}]'), 'json');
  assert.equal(detectWorldbookFormat('@@ENTRY 0\nkeys: a\n'), 'txt');
  assert.equal(detectWorldbookFormat('  \n  @@ENTRY 0'), 'txt');
  assert.equal(detectWorldbookFormat(''), null);
  // BOM 不影响识别
  assert.equal(detectWorldbookFormat('\uFEFF{"entries":[]}'), 'json');
});

test('T10.9 TXT 导出按冻结格式规范化，且内容无损', () => {
  const imported = importWorldbook(MESSY_JSON);
  const exported = exportWorldbook({ entries: imported.entries, meta: imported.meta, format: 'txt' });
  assert.equal(exported.verbatim, false);
  assert.match(String(exported.reason), /冻结格式/);
  const reparsed = parseWorldbookText(exported.text);
  assert.equal(reparsed.ok, true);
  assert.equal(reparsed.entries.length, 2);
  assert.equal(reparsed.entries[0].content, '第一行\n第二行');
  assert.equal(reparsed.entries[1].constant, true);
});

test('T10.9 toCharacterBook：周边字段与条目一起带出', () => {
  const book = toCharacterBook([{ id: 0, keys: ['a'], content: 'x' }], { name: '书', scan_depth: 2 });
  assert.equal(book.name, '书');
  assert.equal(book.scan_depth, 2);
  assert.equal(book.entries.length, 1);
});
