/**
 * TXT 导入「全量保全」机制（v0.1.2 反馈项二 / T10.27）。
 *
 * 设计原则只有一句：**无论识别出几个板块，原文零丢失**。未识别的部分整体进
 * 【其他设定】，由用户自行排版。规范见 docs/06 §7（已冻结）。
 *
 * 为什么这一组测试要逐字节比对：这条需求的失败形态全都是"看起来成功了"——
 *   · 少一个片段 → 导入成功、界面正常，用户的设定悄悄没了；
 *   · 多一个分隔符 → 第一次导入对，导出再导入就多一行；
 *   · 0 命中时把原文 trim 一下 → 首尾空行没了，而"格式内容完全不变"是硬要求。
 * 所以判断"对不对"只能靠 `===` 与"分隔符出现次数"，不能靠"有内容"。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  UNRECOGNIZED_SEPARATOR_LINE,
  applyCardText,
  parseCardText,
  parsePreset,
  parseStCard,
  renderCardText,
} from '../shared/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const defaultPresetRaw = JSON.parse(readFileSync(join(here, '../rules/presets/default.json'), 'utf8'));
const DEFAULT_PRESET = parsePreset(defaultPresetRaw).preset;
const sample = JSON.parse(readFileSync(join(here, 'fixtures/sample-card.json'), 'utf8'));

const PRESERVE = { preserveUnrecognized: true };

function settingsOf(card) {
  return card.blocks.find((block) => block.id === 'settings');
}

function countSeparator(text) {
  return text.split(UNRECOGNIZED_SEPARATOR_LINE).length - 1;
}

// 三条样本：全部未识别 / 混合（标准板块 + 条目式 + 世界书）/ 全部标准。
// 全部标准那条用来钉住"不该动的时候一个字都不动"。

/** 样本 A：0 命中 —— 整个文件是"条目N：xxx"式的自由文本 */
const SAMPLE_ZERO = [
  '条目1：这是一段完全自由的设定文本',
  '它没有使用任何【】或 ## 标题',
  '所以整篇都不该被切分。',
  '',
  '条目2：第二段',
  '  缩进与空行都是原文的一部分',
  '',
  '',
  '条目3：结尾',
].join('\n');

/** 样本 B：混合 —— 标准板块 + 条目式 + 一个未知标题段 + 世界书 */
const SAMPLE_MIXED = [
  '【基本信息】',
  '名字：林晚照',
  '年龄：27',
  '',
  '【性格】',
  '冷静，话少。',
  '',
  '## 战斗系统',
  '条目1：先攻按敏捷排序',
  '条目2：暴击倍率 1.5',
  '',
  '【其他设定】',
  '这是已识别到的其他设定内容。',
  '',
  '## 招式表',
  '条目甲：斩击',
  '条目乙：突刺',
  '',
  '【世界书】',
  '@@ENTRY 1',
  'name: 晚照',
  'keys: 晚照',
  '@@CONTENT',
  '主角。',
  '@@END 1',
].join('\n');

test('0 命中：settings 逐字节等于原文，其余板块为空，且不报缺失', () => {
  const result = parseCardText(SAMPLE_ZERO, DEFAULT_PRESET, PRESERVE);

  assert.equal(result.ok, true);
  assert.ok(result.card, '保全模式下 0 命中不该中止导入');
  assert.equal(settingsOf(result.card).text, SAMPLE_ZERO, '必须逐字节相等（不 trim、不重拼、不加分隔符）');
  assert.equal(settingsOf(result.card).missing, false, '整体放置不等于"缺失"');
  assert.equal(countSeparator(settingsOf(result.card).text), 0, '0 命中时不加分隔符');

  // 审计口径：不能报"缺失板块"
  assert.equal(
    result.issues.filter((issue) => issue.code === 'missing-block').length,
    0,
    '0 命中时不允许出现 missing-block',
  );
  assert.equal(result.preserved.wholeText, true);
  assert.equal(result.preserved.blockCount, 0);

  // 其余板块为空且**不打 missing 标记**（否则审计会报"原文缺失"）
  for (const block of result.card.blocks) {
    if (block.id === 'settings') continue;
    assert.equal(block.text, '', `${block.id} 应为空`);
    assert.equal(block.missing, false, `${block.id} 不该被标记 missing`);
  }

  // 状态栏那句话必须能拿到
  const whole = result.issues.find((issue) => issue.code === 'unrecognized-whole');
  assert.ok(whole, '缺少 unrecognized-whole 提示');
  assert.match(whole.message, /未识别到任何板块，原文已整体放入【其他设定】/);
});

test('0 命中：逐字节保全连首尾空行与 CRLF 都不改', () => {
  const text = '\r\n\r\n条目1：前导空行\r\n正文\r\n\r\n';
  const result = parseCardText(text, DEFAULT_PRESET, PRESERVE);
  assert.equal(settingsOf(result.card).text, text, 'CRLF 与前导空行都必须原样保留');
});

test('≥1 命中：命中板块正确、未识别片段按原序进 settings、分隔符恰好一次', () => {
  const result = parseCardText(SAMPLE_MIXED, DEFAULT_PRESET, PRESERVE);
  assert.ok(result.card);
  const settings = settingsOf(result.card).text;

  // 1. 命中板块正常填入
  const basic = result.card.blocks.find((block) => block.id === 'basic');
  assert.match(basic.text, /名字：林晚照/);
  assert.match(basic.text, /年龄：27/);
  const personality = result.card.blocks.find((block) => block.id === 'personality');
  assert.match(personality.text, /冷静，话少。/);

  // 2. settings = 已识别的其他设定内容 + 分隔符 + 片段
  assert.equal(countSeparator(settings), 1, '分隔符必须恰好出现一次');
  const [head, tail] = settings.split(UNRECOGNIZED_SEPARATOR_LINE);
  assert.match(head, /这是已识别到的其他设定内容/, '已识别内容在分隔符之前');
  assert.ok(head.trim().endsWith('这是已识别到的其他设定内容。'), '已识别内容不该被片段污染');

  // 3. 片段按文档顺序、各自保留标题行、片段之间空行分隔
  const battleAt = tail.indexOf('## 战斗系统');
  const movesAt = tail.indexOf('## 招式表');
  assert.ok(battleAt >= 0 && movesAt >= 0, '两个片段都要在');
  assert.ok(battleAt < movesAt, '片段必须按文档出现顺序排列');
  assert.match(tail, /## 战斗系统\n条目1：先攻按敏捷排序\n条目2：暴击倍率 1\.5/);
  assert.match(tail, /## 招式表\n条目甲：斩击\n条目乙：突刺/);

  // 4. 世界书不参与保全（走结构化路径）
  assert.equal(result.card.worldbook.entries.length, 1);
  assert.ok(!settings.includes('主角。'), '世界书内容不该被搬进 settings');

  assert.equal(result.preserved.blockCount, 4, '识别到的板块：基本信息/性格/其他设定/世界书');
  assert.equal(result.preserved.fragments, 2);
});

test('分隔符格式：前后各一空行，单行醒目', () => {
  const result = parseCardText(SAMPLE_MIXED, DEFAULT_PRESET, PRESERVE);
  const settings = settingsOf(result.card).text;
  const pattern = new RegExp(`\\n\\n${UNRECOGNIZED_SEPARATOR_LINE}\\n\\n`);
  assert.match(settings, pattern, '分隔符前后必须各有一个空行');
});

test('settings 未被识别：settings = 分隔符 + 全部片段', () => {
  const text = ['【基本信息】', '名字：甲', '', '## 战斗系统', '条目1：先攻'].join('\n');
  const result = parseCardText(text, DEFAULT_PRESET, PRESERVE);
  const settings = settingsOf(result.card);
  assert.ok(settings.text.startsWith(UNRECOGNIZED_SEPARATOR_LINE), '分隔符必须在最前');
  assert.match(settings.text, /## 战斗系统\n条目1：先攻/);
  assert.equal(result.preserved.fragments, 1);
});

test('没有未识别内容时不插分隔符（干净文件不该被动）', () => {
  const text = ['【基本信息】', '名字：乙', '', '【性格】', '温和', '', '【其他设定】', '普通'].join('\n');
  const result = parseCardText(text, DEFAULT_PRESET, PRESERVE);
  const settings = settingsOf(result.card).text;
  assert.equal(settings, '普通', '干净文件里 settings 只能是原文');
  assert.equal(countSeparator(settings), 0);
  assert.equal(result.preserved.fragments, 0);
  assert.equal(result.preserved.applied, true);
});

test('round-trip：导入 → 导出 → 再导入，内容不再二次加工', () => {
  const first = parseCardText(SAMPLE_MIXED, DEFAULT_PRESET, PRESERVE).card;
  const exported = renderCardText(first, DEFAULT_PRESET);
  const second = parseCardText(exported, DEFAULT_PRESET, PRESERVE).card;

  assert.equal(countSeparator(settingsOf(first).text), 1);
  assert.equal(countSeparator(settingsOf(second).text), 1, '分隔符不能越导越多');

  // 内容稳定：再导出一次必须与第一次导出逐字节相同
  assert.equal(renderCardText(second, DEFAULT_PRESET), exported, '导出结果必须稳定');

  // 每个板块的**内容**也稳定。
  //
  // 用 trim 比较而不是逐个字节：空板块在"渲染 → 解析"后会被读成几个换行符
  // （`renderCardText` 输出 `【特殊设定】\n`，解析时空正文把紧随的分隔空行也算进
  // section 的切片里）。这是既有行为，与保全无关，且 `renderCardText` 会把纯空白
  // 正文重新压成空标题 —— 也就是说**导出结果**不受影响。真正不能变的是内容，
  // 所以这里比内容，导出稳定性另由上面那条 `renderCardText` 逐字节断言守住。
  for (const block of first.blocks) {
    const again = second.blocks.find((item) => item.id === block.id);
    assert.equal(again.text.trim(), block.text.trim(), `${block.id} 在 round-trip 后内容变了`);
  }
});

test('round-trip：0 命中样本导出后再导入仍然稳定', () => {
  const first = parseCardText(SAMPLE_ZERO, DEFAULT_PRESET, PRESERVE).card;
  assert.equal(settingsOf(first).text, SAMPLE_ZERO);

  const exported = renderCardText(first, DEFAULT_PRESET);
  const secondResult = parseCardText(exported, DEFAULT_PRESET, PRESERVE);
  const third = renderCardText(secondResult.card, DEFAULT_PRESET);
  assert.equal(third, exported, '第二次导出必须与第一次逐字节相同');

  // 再导入不该冒出新的"未识别"告警：第一次导出已把整体放置写成了【其他设定】段
  const unknown = secondResult.issues.filter((issue) => issue.code === 'unrecognized-whole');
  assert.equal(unknown.length, 0, '这时候 settings 已经被识别，不该再说"一个板块都没认出"');
});

test('round-trip：首次导入的未知标题不再重复告警（已在保全区域里）', () => {
  const first = parseCardText(SAMPLE_MIXED, DEFAULT_PRESET, PRESERVE);
  const unknownFirst = first.issues.filter((issue) => issue.code === 'unknown-heading');
  assert.equal(unknownFirst.length, 2, '首次导入应如实报出两处未知标题');

  const exported = renderCardText(first.card, DEFAULT_PRESET);
  const second = parseCardText(exported, DEFAULT_PRESET, PRESERVE);
  const unknownSecond = second.issues.filter((issue) => issue.code === 'unknown-heading');
  assert.equal(unknownSecond.length, 0, '分隔符下方的标题已经是"已知的未识别内容"，不该再报');
});

test('严格/宽松模式在保全下行为一致', () => {
  const strict = parseCardText(SAMPLE_MIXED, DEFAULT_PRESET, { ...PRESERVE, mode: 'strict' });
  const lenient = parseCardText(SAMPLE_MIXED, DEFAULT_PRESET, { ...PRESERVE, mode: 'lenient' });
  assert.equal(strict.ok, true);
  assert.equal(lenient.ok, true);
  assert.equal(settingsOf(strict.card).text, settingsOf(lenient.card).text);
  assert.equal(strict.issues.filter((i) => i.code === 'missing-block').length, 0);
  assert.equal(lenient.issues.filter((i) => i.code === 'missing-block').length, 0);
});

test('不开保全时旧语义完全不变（编辑器保存路径不能被动）', () => {
  const text = ['【基本信息】', '名字：丙'].join('\n');
  const strict = parseCardText(text, DEFAULT_PRESET);
  assert.equal(strict.ok, false, '严格模式仍然中止');
  assert.equal(strict.card, null);
  assert.ok(strict.issues.some((issue) => issue.code === 'missing-block' && issue.severity === 'error'));
  assert.equal(strict.preserved, null);

  const lenient = parseCardText(text, DEFAULT_PRESET, { mode: 'lenient' });
  assert.equal(lenient.ok, true);
  assert.ok(lenient.issues.some((issue) => issue.code === 'missing-block'));
  assert.equal(lenient.preserved, null);
});

test('取消导入：卡片逐字节不变（applyCardText 不改原卡）', () => {
  const card = parseStCard(sample).card;
  const before = JSON.stringify(card);
  const result = applyCardText(card, SAMPLE_MIXED, DEFAULT_PRESET, PRESERVE);
  assert.equal(result.changed, true);
  assert.equal(JSON.stringify(card), before, 'applyCardText 不能改传入的卡（必须改副本）');
});

test('前言（首个标题之前的内容）也不丢', () => {
  const text = ['写在最前面的几句话', '它们不属于任何板块', '', '【基本信息】', '名字：丁'].join('\n');
  const result = parseCardText(text, DEFAULT_PRESET, PRESERVE);
  const settings = settingsOf(result.card).text;
  assert.match(settings, /写在最前面的几句话/, '前言必须进【其他设定】，不能丢');
  assert.equal(result.preserved.fragments, 1);
});

test('世界书正文里的标题行不被当成片段搬走', () => {
  const text = [
    '【基本信息】',
    '名字：戊',
    '',
    '【世界书】',
    '条目1',
    'id: 1',
    'keys: 戊',
    'content: 第一行',
    '## 这是世界书正文里的一行标题式文字',
    'content 续行',
  ].join('\n');
  const result = parseCardText(text, DEFAULT_PRESET, PRESERVE);
  const settings = settingsOf(result.card).text;
  assert.equal(settings, '', '不该从世界书里搬东西出来');
  assert.equal(result.preserved.fragments, 0);
});

test('重复标题不算片段（内容已经在首次出现的板块里）', () => {
  const text = ['【基本信息】', '名字：己', '', '【基本信息】', '重复段落'].join('\n');
  const result = parseCardText(text, DEFAULT_PRESET, PRESERVE);
  const settings = settingsOf(result.card).text;
  assert.equal(settings, '', '重复标题的段落不该同时出现在 settings');
  assert.match(result.card.blocks.find((b) => b.id === 'basic').text, /重复段落/);
});

test('description.raw 与 settings 内容一致（否则审计会说 raw 与板块不符）', () => {
  const result = parseCardText(SAMPLE_MIXED, DEFAULT_PRESET, PRESERVE);
  assert.match(result.card.description.raw, /## 战斗系统/);
  assert.match(result.card.description.raw, /## 招式表/);
  assert.match(result.card.description.raw, new RegExp(UNRECOGNIZED_SEPARATOR_LINE));
});

test('保全不产生 error 级问题（导入不该被自己的机制中止）', () => {
  for (const text of [SAMPLE_ZERO, SAMPLE_MIXED, '', '   ', '纯文本没有标题']) {
    const result = parseCardText(text, DEFAULT_PRESET, PRESERVE);
    const errors = result.issues.filter((issue) => issue.severity === 'error');
    assert.deepEqual(errors, [], `样本「${text.slice(0, 12)}」产生了 error：${errors.map((e) => e.message).join('; ')}`);
  }
});

test('分隔符下方用户手写的普通文本必须保留（不许因为"已保全"就吞掉）', () => {
  // 这条是负向注入逼出来的：第一版把 existingTail 当成"就是那一行分隔符"，
  // 于是分隔符下方**没有任何标题的**手写内容会在再次导入时消失。
  // 那不是理论问题 —— 用户完全可能按分隔符的提示，直接在下面补自己的段落。
  const text = [
    '【基本信息】',
    '名字：庚',
    '',
    '【其他设定】',
    '原有内容。',
    '',
    UNRECOGNIZED_SEPARATOR_LINE,
    '',
    '这是用户自己在分隔符下方补的一段说明，没有标题。',
    '第二行也一样。',
  ].join('\n');

  const result = parseCardText(text, DEFAULT_PRESET, PRESERVE);
  const settings = settingsOf(result.card).text;
  assert.match(settings, /原有内容。/);
  assert.match(settings, /这是用户自己在分隔符下方补的一段说明，没有标题。/);
  assert.match(settings, /第二行也一样。/);
  assert.equal(countSeparator(settings), 1, '不该再多补一个分隔符');
});
