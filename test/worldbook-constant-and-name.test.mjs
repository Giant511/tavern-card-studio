/**
 * G7：世界书"常驻"语义与条目名清洗（v0.1.5）。
 *
 * 三项引擎修改各自对应一个线上症状，测试按"错了会静默误判"的那面写：
 *   1. `parseBool` 认不认 `是/否` —— 不认 ⇒ 持续型条目 constant 永远 false
 *      ⇒「非常驻却无关键词」对它们全线误报（用户实测 29 条）；
 *   2. `when` 的 `exists`/`absent` —— 没有它，只能用"某字段有没有出现"来区分
 *      条目类型这件很自然的事就写不出来；
 *   3. `cleanInlineName` —— 剥不干净 ⇒ 条目名里留着引号，而条目名会进审计文案。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_WORLDBOOK_FORMAT,
  parseWorldbookPreset,
  parseWorldbookTextWith,
} from '@tcs/shared';

const ROOT = join(import.meta.dirname, '..');
const TEMP = 'D:/Desktop/桌面文件/temp';

/** 用户那份中文格式预设（真实文件，不手搓） */
function userPreset(overrides = {}) {
  const raw = JSON.parse(readFileSync(join(TEMP, '幻梦AI世界书格式预设.json'), 'utf8'));
  return parseWorldbookPreset({ ...raw, format: { ...raw.format, ...overrides } }).preset;
}

/** 内置默认格式（严格档，用来对照） */
const BUILTIN = DEFAULT_WORLDBOOK_FORMAT;

// ─────────────────────────────────────────────────────────────
// 1. parseBool 认 是/否
// ─────────────────────────────────────────────────────────────

test('常驻：是 → constant=true（中文布尔标签）', () => {
  const preset = userPreset({ labelMap: { ...userPreset().format.labelMap, constant: '常驻' } });
  const r = parseWorldbookTextWith('【条目0：甲】\n常驻：是\n内容：正文', preset.format);
  assert.equal(r.entries[0]?.constant, true, '`是` 没被识别成 true');
});

test('常驻：否 → constant=false', () => {
  const preset = userPreset({ labelMap: { ...userPreset().format.labelMap, constant: '常驻' } });
  const r = parseWorldbookTextWith('【条目0：甲】\n常驻：否\n内容：正文', preset.format);
  assert.equal(r.entries[0]?.constant, false);
});

test('英文与数字写法仍然有效（true/false/1/0/yes/no/on/off）', () => {
  const preset = userPreset({ labelMap: { ...userPreset().format.labelMap, constant: '常驻' } });
  const pairs = [
    ['true', true],
    ['false', false],
    ['1', true],
    ['0', false],
    ['YES', true],
    ['no', false],
    ['On', true],
    ['OFF', false],
    ['是', true],
    ['否', false],
  ];
  for (const [written, expected] of pairs) {
    const r = parseWorldbookTextWith(`【条目0：甲】\n常驻：${written}\n内容：正文`, preset.format);
    assert.equal(r.entries[0]?.constant, expected, `「${written}」应解析为 ${String(expected)}`);
  }
});

test('认不出的值 → warning 且**不猜**（constant 保持缺省）', () => {
  /*
   * `真/假` 刻意不认（需求明确"不得猜"）。猜错的代价比报错大：
   * `常驻：假` 若被当成 true，条目会变成常驻，而用户以为它是关键词条目。
   */
  const preset = userPreset({ labelMap: { ...userPreset().format.labelMap, constant: '常驻' } });
  for (const written of ['真', '假', '对', '错', '√', '也许']) {
    const r = parseWorldbookTextWith(`【条目0：甲】\n常驻：${written}\n内容：正文`, preset.format);
    assert.equal(r.entries[0]?.constant, undefined, `「${written}」不该被猜成布尔值`);
    const bad = r.issues.filter((issue) => issue.code === 'bad-value');
    assert.equal(bad.length, 1, `「${written}」应给一条 bad-value warning`);
  }
});

test('bad-value 的文案里给出可写值（否则用户不知道能写什么）', () => {
  const preset = userPreset({ labelMap: { ...userPreset().format.labelMap, constant: '常驻' } });
  const r = parseWorldbookTextWith('【条目0：甲】\n常驻：也许\n内容：正文', preset.format);
  const message = r.issues.find((issue) => issue.code === 'bad-value')?.message ?? '';
  assert.match(message, /是\/否/);
  assert.match(message, /true\/false/);
});

test('不写常驻字段时行为不变（constant 缺省 undefined ⇒ 审计按 false 处理）', () => {
  const preset = userPreset();
  const r = parseWorldbookTextWith('【条目0：甲】\n内容：正文', preset.format);
  assert.equal(r.entries[0]?.constant, undefined);
  assert.equal(r.issues.filter((issue) => issue.severity === 'error').length, 0);
});

test('是/否 在**内置**格式下同样有效（不是只给自定义预设开的例外）', () => {
  const r = parseWorldbookTextWith('@@ENTRY 0\nconstant: 是\n@@CONTENT\n正文\n@@END 0', BUILTIN);
  assert.equal(r.entries[0]?.constant, true);
});

// ─────────────────────────────────────────────────────────────
// 3. cleanInlineName 迭代剥离
// ─────────────────────────────────────────────────────────────

test('用户样本：「…」】 → 去掉成对引号与孤立尾符', () => {
  const preset = userPreset();
  const r = parseWorldbookTextWith('【条目0：「西奥核心关系逻辑」】\n内容：正文', preset.format);
  assert.equal(r.entries[0]?.name, '西奥核心关系逻辑');
});

test('回归矩阵：NAME_PAIRS 每一对都能剥干净', () => {
  const preset = userPreset();
  const pairs = [
    ['【', '】'],
    ['[', ']'],
    ['（', '）'],
    ['(', ')'],
    ['《', '》'],
    ['「', '」'],
    ['『', '』'],
  ];
  for (const [open, close] of pairs) {
    // ① 整体成对
    let r = parseWorldbookTextWith(`【条目0：${open}名字${close}】\n内容：正文`, preset.format);
    assert.equal(r.entries[0]?.name, '名字', `成对 ${open}${close} 没剥干净`);

    // ② 成对 + 孤立尾符（用户的样本形态）
    r = parseWorldbookTextWith(`【条目0：${open}名字${close}】】\n内容：正文`, preset.format);
    assert.equal(r.entries[0]?.name, '名字', `${open}${close} 与孤立尾符并存时没剥干净`);

    // ③ 孤立首符
    r = parseWorldbookTextWith(`【条目0：${open}名字】\n内容：正文`, preset.format);
    assert.equal(r.entries[0]?.name, '名字', `孤立首符 ${open} 没剥`);

    // ④ 孤立尾符
    r = parseWorldbookTextWith(`【条目0：名字${close}】\n内容：正文`, preset.format);
    assert.equal(r.entries[0]?.name, '名字', `孤立尾符 ${close} 没剥`);
  }
});

test('内部括号绝不能被剥（`设定（草稿）` 那对括号是名字的一部分）', () => {
  const preset = userPreset();
  for (const name of ['设定（草稿）', '设定(草稿)', '甲【乙】丙', 'A「B」C', '（前）后', '前（后）']) {
    const r = parseWorldbookTextWith(`【条目0：${name}】\n内容：正文`, preset.format);
    assert.equal(r.entries[0]?.name, name, `「${name}」被误剥了`);
  }
});

test('多层包裹能剥干净（【「名字」】）', () => {
  const preset = userPreset();
  const r = parseWorldbookTextWith('【条目0：【「名字」】】\n内容：正文', preset.format);
  assert.equal(r.entries[0]?.name, '名字');
});

test('退化输入不会留下空字符串名字（宁可没名字，也不要 name: ""）', () => {
  const preset = userPreset();
  /*
   * `【条目0：【】】` 的行内剩余是 `【】】` —— 剥到底只剩括号，剥完就是空。
   * 期望的是**字段不设置**（审计文案会退化成「第 N 条」），而不是
   * `name: ""` —— 空名字会让引用它的规则算出「世界书「」没有关键词」。
   */
  for (const line of ['【条目0：【】】', '【条目0：】】', '【条目0：「」】']) {
    const r = parseWorldbookTextWith(`${line}\n内容：正文`, preset.format);
    const name = r.entries[0]?.name;
    assert.ok(
      name === undefined || name.trim() !== '',
      `${line} 产生了空字符串名字：${JSON.stringify(name)}`,
    );
  }
});

// ─────────────────────────────────────────────────────────────
// 2. when exists / absent（在规则引擎层验，见 rule-condition 测试）
// ─────────────────────────────────────────────────────────────

test('schema 里登记了 exists / absent（否则 additionalProperties:false 会拒绝）', () => {
  const schema = JSON.parse(
    readFileSync(join(ROOT, 'rules/schema/platform-rule.schema.json'), 'utf8'),
  );
  const whenProps = Object.keys(schema.definitions.contentRule.properties.when.properties);
  for (const key of ['exists', 'absent', 'present']) {
    assert.ok(whenProps.includes(key), `when.properties 缺 ${key}`);
  }
  assert.equal(
    schema.definitions.contentRule.properties.when.additionalProperties,
    false,
    '这条检查的前提是 additionalProperties:false —— 若改成 true 本测试失去意义',
  );
});
