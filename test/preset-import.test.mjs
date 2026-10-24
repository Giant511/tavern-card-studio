/**
 * 预设导入（T10.30 / T10.31）：原子回退、同 id 覆盖、未知键 warning、改名建议。
 *
 * 与平台规则的导入共用同一套语义（这是需求「交互与 TXT 预设完全同构」的含义），
 * 所以这里断言的口径与 `test/rule-library.test.mjs` 保持一致。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_WORLDBOOK_PRESET, parsePreset } from '../shared/dist/index.js';
import {
  importTxtPreset,
  importWorldbookPreset,
  serializePreset,
  suggestExistingId,
} from '../client/src/rules/preset-library.ts';

const ROOT = join(import.meta.dirname, '..');
const PRESET_TEXT = readFileSync(join(ROOT, 'rules', 'presets', 'default.json'), 'utf8');
const CUSTOM = JSON.parse(PRESET_TEXT);
CUSTOM.id = 'my-format';
CUSTOM.name = '我的格式';
CUSTOM.builtin = false;

const BASE = [JSON.parse(PRESET_TEXT)];

test('导入 TXT 预设：合法文件进列表，且不改变"当前选中"（导入函数不返回选中态）', () => {
  const outcome = importTxtPreset(BASE, JSON.stringify(CUSTOM));
  assert.equal(outcome.ok, true, JSON.stringify(outcome.issues));
  assert.equal(outcome.value.length, 2);
  assert.equal(outcome.id, 'my-format');
  assert.equal(outcome.replaced, false);
  // 原子性：原数组不被修改
  assert.equal(BASE.length, 1);
});

test('导入 TXT 预设：坏 JSON → 失败且列表逐项不变（原子回退）', () => {
  const outcome = importTxtPreset(BASE, '{ not json');
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.value, BASE);
  assert.match(outcome.issues[0].message, /JSON 解析失败/);
});

test('导入 TXT 预设：缺字段 → 报出字段路径，列表不变', () => {
  const broken = { ...CUSTOM, id: 'broken', headings: undefined };
  const outcome = importTxtPreset(BASE, JSON.stringify(broken));
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.value, BASE);
  // 文件级错误没有 `字段: 消息` 前缀（拆不出 where），断言消息本身点名了 headings
  assert.ok(outcome.issues.some((issue) => issue.message.includes('headings')), JSON.stringify(outcome.issues));
});

test('导入 TXT 预设：同 id 覆盖（列表长度不变，replaced=true）', () => {
  const sameId = { ...CUSTOM, id: BASE[0].id, name: '覆盖版' };
  const outcome = importTxtPreset(BASE, JSON.stringify(sameId));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.value.length, 1);
  assert.equal(outcome.replaced, true);
  assert.equal(outcome.value[0].name, '覆盖版');
});

test('导入 TXT 预设：覆盖内置要有提示（本次运行内生效）', () => {
  const sameId = { ...CUSTOM, id: BASE[0].id };
  const outcome = importTxtPreset(BASE, JSON.stringify(sameId));
  assert.equal(outcome.ok, true);
  assert.ok(outcome.warnings.some((text) => /内置预设/.test(text)));
});

test('导入 TXT 预设：未知键只 warning 不阻断（F4 口径），并给改名建议', () => {
  const typo = { ...CUSTOM, id: 'typo-preset', blockOder: [], separatorX: '\n\n' };
  const outcome = importTxtPreset(BASE, JSON.stringify(typo));
  assert.equal(outcome.ok, true, JSON.stringify(outcome.issues));
  assert.ok(outcome.warnings.some((text) => text.includes('blockOder')));
  assert.ok(outcome.warnings.some((text) => text.includes('blockOrder')), '应提示"是不是想写 blockOrder"');
});

test('改名建议：id 与现有项只差一两个字符时提醒「很像但不是同一个」', () => {
  assert.match(suggestExistingId('defualt', ['default']), /default/);
  assert.equal(suggestExistingId('completely-different', ['default']), '');
  assert.equal(suggestExistingId('default', ['default']), '', '同 id 不需要建议（那是覆盖）');
});

test('世界书预设：合法文件导入，默认参数按 v1.0 补齐', () => {
  const outcome = importWorldbookPreset([DEFAULT_WORLDBOOK_PRESET], JSON.stringify({
    schemaVersion: 1,
    id: 'cn-wb',
    name: '中文世界书',
    version: '1.0.0',
    format: {
      entryOpen: '[[条目 {id}]]',
      contentMark: '[[正文]]',
      entryClose: '[[结束 {id}]]',
      labelMap: { keys: '关键词' },
    },
  }));
  assert.equal(outcome.ok, true, JSON.stringify(outcome.issues));
  assert.equal(outcome.value.length, 2);
  const preset = outcome.value.find((item) => item.id === 'cn-wb');
  assert.equal(preset.format.fieldSeparator, ': ');
  assert.equal(preset.format.listSeparator, ', ');
  assert.equal(preset.format.fieldOrder.length, 11);
  assert.equal(preset.format.labelMap.keys, '关键词');
  assert.equal(preset.builtin, false);
});

test('世界书预设：坏文件原子回退（原列表不变）', () => {
  const outcome = importWorldbookPreset([DEFAULT_WORLDBOOK_PRESET], JSON.stringify({
    schemaVersion: 1,
    id: 'bad',
    name: 'bad',
    version: '1.0.0',
    format: { entryOpen: '无占位符', contentMark: 'C', entryClose: 'E {id}' },
  }));
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.value, [DEFAULT_WORLDBOOK_PRESET]);
  assert.ok(outcome.issues.some((issue) => /{id}/.test(issue.message)));
});

test('世界书预设：同 id 覆盖 + 覆盖内置有提示', () => {
  // 用真实内置预设做基线（不要手搓一个假结构）
  assert.ok(parsePreset(JSON.parse(PRESET_TEXT)).preset);
  const payload = {
    schemaVersion: 1,
    id: 'default',
    name: '改过的标准世界书',
    version: '1.0.1',
    format: { entryOpen: '@@E {id}', contentMark: '@@C', entryClose: '@@X {id}' },
  };
  const outcome = importWorldbookPreset([DEFAULT_WORLDBOOK_PRESET], JSON.stringify(payload));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.value.length, 1);
  assert.equal(outcome.replaced, true);
  assert.ok(outcome.warnings.some((text) => /内置/.test(text)));
});

test('导出 → 再导入 round-trip：序列化结果能被再次解析且参数不变', () => {
  const outcome = importTxtPreset(BASE, JSON.stringify(CUSTOM));
  assert.equal(outcome.ok, true);
  const exported = serializePreset(outcome.value.find((item) => item.id === 'my-format'));
  const again = importTxtPreset(BASE, exported);
  assert.equal(again.ok, true, JSON.stringify(again.issues));
  const first = outcome.value.find((item) => item.id === 'my-format');
  const second = again.value.find((item) => item.id === 'my-format');
  assert.deepEqual(second.headings, first.headings);
  assert.equal(second.separator, first.separator);
  assert.deepEqual(second.blockOrder, first.blockOrder);
  assert.equal(again.warnings.length, 0, '导出的文本不该再触发未知键警告');
});
