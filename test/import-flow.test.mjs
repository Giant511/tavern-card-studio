/**
 * T10.9 客户端导入流程（纯逻辑层）。
 *
 * 只测"决定"，不测界面：
 *   · TXT 角色卡：严格拒绝 / 宽松补空，两者的结论必须能被区分；
 *   · 世界书：失败时**绝不**返回可写入的卡（否则会把"没解析出来的条目"当成"用户删除"）。
 *
 * 界面是否照着做由 `scripts/verify-t109.mjs` 的端到端负责。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadPresets, parseStCard } from '../shared/dist/index.js';
import {
  applyWorldbookImport,
  exportWorldbookText,
  previewCardText,
  previewWorldbook,
  suggestWorldbookFileName,
} from '../client/src/editor/import-flow.ts';

const ROOT = join(import.meta.dirname, '..');
const preset = loadPresets([JSON.parse(readFileSync(join(ROOT, 'rules', 'presets', 'default.json'), 'utf8'))])
  .presets[0];
const baseCard = parseStCard(
  JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'sample-card.json'), 'utf8')),
).card;

/** 只有「基本信息」一段的 TXT：缺其余四个板块 */
const PARTIAL_TXT = `【基本信息】
她叫林晚照，开了家咖啡馆。
`;

/**
 * 六个板块齐全的 TXT。
 *
 * 标题必须用**默认预设的别名**（`settings` 的别名是「其他设定」而不是「场景」）——
 * 写错一个标题，严格模式就会以"缺板块"中止，而这恰恰测不到"完整文本能导入"。
 */
const FULL_TXT = `【基本信息】
她叫林晚照，开了家咖啡馆。

【性格】
安静，话少。

【其他设定】
对话以第三人称叙述。

【特殊设定】
无。

【用户设定】
{{user}} 是常客。

【世界书】
@@ENTRY 0
name: 咖啡馆
keys: 咖啡馆
@@CONTENT
二楼是仓库。
@@END 0`;

test('T10.9 TXT 严格模式：缺板块 → 拒绝导入，且报出缺哪些', () => {
  const preview = previewCardText(baseCard, PARTIAL_TXT, preset, 'strict');
  assert.equal(preview.canImport, false);
  assert.equal(preview.card, null);
  const missing = preview.issues.filter((issue) => issue.code === 'missing-block');
  assert.ok(missing.length >= 4, `应报出多个缺失板块，实际 ${JSON.stringify(preview.issues)}`);
  for (const issue of missing) assert.equal(issue.severity, 'error');
});

test('T10.9 TXT 宽松模式：同一份文本可导入，缺失板块以 warning + 空块标记体现', () => {
  const preview = previewCardText(baseCard, PARTIAL_TXT, preset, 'lenient');
  assert.equal(preview.canImport, true);
  assert.ok(preview.card);
  // 缺失的板块必须被点名（不能只说"已按空处理"）
  assert.ok(preview.missingBlocks.length >= 4, JSON.stringify(preview.missingBlocks));
  const missingIssues = preview.issues.filter((issue) => issue.code === 'missing-block');
  assert.ok(missingIssues.length >= 4);
  for (const issue of missingIssues) assert.equal(issue.severity, 'warning');
  // 被填空的板块要带 missing 标记，与"用户清空"区分
  const flagged = preview.card.blocks.filter((block) => block.missing === true);
  assert.ok(flagged.length >= 4);
});

test('T10.9 TXT 完整文本：两种模式都能导入，且不带缺失标记', () => {
  for (const mode of ['strict', 'lenient']) {
    const preview = previewCardText(baseCard, FULL_TXT, preset, mode);
    assert.equal(preview.canImport, true, `${mode} 模式应可导入`);
    assert.deepEqual(preview.missingBlocks, []);
    assert.equal(preview.worldbookEntries, 1, 'TXT 里的世界书段要一并解析出来');
    assert.match(preview.card.blocks.find((block) => block.id === 'basic').text, /林晚照/);
  }
});

test('T10.9 TXT 导入不会碰 meta（角色名等来自当前卡，不由 TXT 决定）', () => {
  const preview = previewCardText(baseCard, FULL_TXT, preset, 'lenient');
  assert.equal(preview.card.meta.name, baseCard.meta.name);
});

// ── 世界书 ────────────────────────────────────────────────

const GOOD_JSON = JSON.stringify(
  { entries: [{ id: 0, keys: ['银座'], content: '一' }, { id: 1, keys: ['耳钉'], content: '二' }] },
  null,
  2,
);

test('T10.9 世界书预览：JSON / TXT 都能识别并给出条目数', () => {
  const json = previewWorldbook(GOOD_JSON);
  assert.equal(json.format, 'json');
  assert.equal(json.canImport, true);
  assert.equal(json.entryCount, 2);

  const txt = previewWorldbook('@@ENTRY 0\nkeys: a\n@@CONTENT\n正文\n@@END 0');
  assert.equal(txt.format, 'txt');
  assert.equal(txt.canImport, true);
  assert.equal(txt.entryCount, 1);
});

test('T10.9 世界书预览：坏 JSON → canImport=false 且带行号', () => {
  const preview = previewWorldbook('{\n  "entries": [\n    { "id": 0, },\n  ]\n}');
  assert.equal(preview.canImport, false);
  const issue = preview.issues.find((item) => item.code === 'json-syntax');
  assert.ok(issue);
  assert.equal(typeof issue.line, 'number');
});

test('T10.9 世界书导入：失败时 applyWorldbookImport 返回 null（绝不写回）', () => {
  const preview = previewWorldbook('这只是一段没有条目的说明文字');
  assert.equal(preview.canImport, false);
  assert.equal(applyWorldbookImport(baseCard, preview), null);
});

test('T10.9 世界书导入：成功后 entries / text / raw 三者同步', () => {
  const preview = previewWorldbook(GOOD_JSON);
  const next = applyWorldbookImport(baseCard, preview);
  assert.ok(next);
  assert.equal(next.worldbook.entries.length, 2);
  // text 要能立刻在编辑器里看到条目
  assert.match(next.worldbook.text, /@@ENTRY 0/);
  assert.match(next.worldbook.text, /@@END 1/);
  // raw 保留周边字段（这里 JSON 没有周边字段，但 entries 要在，供整卡导出）
  assert.deepEqual(
    next.worldbook.raw.entries.map((entry) => entry.id),
    [0, 1],
  );
});

test('T10.9 世界书导入：JSON 周边字段进 raw，整卡导出时不丢', () => {
  const withMeta = JSON.stringify({
    name: '测试书',
    scan_depth: 4,
    extensions: { source: 'external' },
    entries: [{ id: 0, keys: ['a'], content: 'x' }],
  });
  const next = applyWorldbookImport(baseCard, previewWorldbook(withMeta));
  assert.ok(next);
  assert.equal(next.worldbook.raw.name, '测试书');
  assert.equal(next.worldbook.raw.scan_depth, 4);
  assert.deepEqual(next.worldbook.raw.extensions, { source: 'external' });
});

test('T10.9 导出：未改动时逐字节写回原文（JSON 往返无损）', () => {
  // 故意用非规范缩进与键顺序
  const messy = '{"entries":[{"keys":["银座"],"content":"一","id":0}],"scan_depth":2}';
  const preview = previewWorldbook(messy);
  const card = applyWorldbookImport(baseCard, preview);
  const exported = exportWorldbookText(card, 'json', preview.result);
  assert.equal(exported.verbatim, true);
  assert.equal(exported.text, messy);
});

test('T10.9 导出：改动条目后走规范序列化并告知', () => {
  const preview = previewWorldbook(GOOD_JSON);
  const card = applyWorldbookImport(baseCard, preview);
  const edited = {
    ...card,
    worldbook: {
      ...card.worldbook,
      entries: card.worldbook.entries.map((entry, index) =>
        index === 0 ? { ...entry, content: '改过了' } : entry,
      ),
    },
  };
  const exported = exportWorldbookText(edited, 'json', preview.result);
  assert.equal(exported.verbatim, false);
  assert.match(String(exported.reason), /改动/);
  assert.equal(JSON.parse(exported.text).entries[0].content, '改过了');
});

test('T10.9 导出 TXT：按冻结格式渲染，内容可再解析', () => {
  const preview = previewWorldbook(GOOD_JSON);
  const card = applyWorldbookImport(baseCard, preview);
  const exported = exportWorldbookText(card, 'txt', preview.result);
  assert.match(exported.text, /@@ENTRY 0/);
  const reparsed = previewWorldbook(exported.text);
  assert.equal(reparsed.canImport, true);
  assert.equal(reparsed.entryCount, 2);
});

test('T10.9 建议文件名：非法字符替换，后缀随格式', () => {
  const card = { ...baseCard, meta: { ...baseCard.meta, name: 'a/b:c*?' } };
  const name = suggestWorldbookFileName(card, 'json');
  assert.match(name, /\.json$/);
  assert.equal(/[\\/:*?"<>|]/.test(name.replace(/\.json$/, '')), false);
  assert.match(suggestWorldbookFileName(baseCard, 'txt'), /\.txt$/);
});
