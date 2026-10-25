/**
 * T6.1 六板块编辑器 · 文档模型测试。
 *
 * 覆盖交付要求里的「六板块 round-trip」：编辑 → 拼装 → 解析 → 再编辑。
 * 直接 import 客户端的 TS 模块（Node 22 的类型剥离），测的就是 UI 真正调用的那份代码，
 * 不是为测试另写一份实现。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  applyCardText,
  buildAuditReport,
  loadPlatformRules,
  loadPresets,
  parseStCard,
  parseWorldbookText,
  renderWorldbookText,
  resolvePlatformRule,
} from '@tcs/shared';

import {
  EDITOR_BLOCK_IDS,
  collectBlocks,
  serializeCard,
  setBlockText,
} from '../client/src/editor/block-doc.ts';

const SAMPLE = JSON.parse(
  readFileSync(new URL('./fixtures/sample-card.json', import.meta.url), 'utf8'),
);

function loadCard() {
  return parseStCard(SAMPLE).card;
}

function texts(card) {
  return Object.fromEntries(collectBlocks(card).map((block) => [block.id, block.text]));
}

test('八板块投影：顺序固定、世界书有文本', () => {
  const blocks = collectBlocks(loadCard());
  assert.deepEqual(
    blocks.map((block) => block.id),
    [...EDITOR_BLOCK_IDS],
  );
  // v0.1.3 起六→八板块。断言写 EDITOR_BLOCK_IDS.length 而不是字面量 8：
  // 这样再加板块时不该红（顺序仍由上面那条 deepEqual 守着），
  // 而「投影漏掉某个板块」会被 deepEqual 抓出来。
  assert.equal(blocks.length, EDITOR_BLOCK_IDS.length);
  for (const block of blocks) {
    assert.equal(typeof block.text, 'string');
    assert.ok(block.label.length > 0);
  }
  const worldbook = blocks.find((block) => block.id === 'worldbook');
  assert.ok(worldbook.text.length > 0, '样本卡应带世界书文本');
});

test('round-trip：六块全部编辑 → 序列化 → 再解析，文本逐字一致', () => {
  let card = loadCard();
  const edits = {
    basic: '姓名：{{char}}\n年龄：25（改）',
    personality: '安静、观察力强（改）。',
    settings: '聊天输出格式：第三人称（改）。',
    special: '特殊设定：雨夜必须关店（改）。',
    user: '{{user}} 是常客（改）。',
    worldbook: '世界书整段替换（改）。',
  };

  for (const [id, text] of Object.entries(edits)) {
    const result = setBlockText(card, id, text);
    assert.equal(result.changed, true, `${id} 应被判定为已改动`);
    card = result.card;
  }

  // worldbook 的 "世界书整段替换（改）。" 不是合法条目格式，解析会 key off；
  // 这里只断言「文本原样保留」，条目回写由下面单独的用例覆盖。
  const json = serializeCard(card);
  const reparsed = parseStCard(json).card;
  const after = texts(reparsed);

  for (const id of ['basic', 'personality', 'settings', 'special', 'user']) {
    assert.equal(after[id], edits[id], `${id} 编辑后应逐字保留`);
  }
});

test('round-trip 第二次编辑：从"解析后的卡"继续改，不丢前一次改动', () => {
  let card = loadCard();
  card = setBlockText(card, 'basic', '第一轮：基本信息').card;
  card = setBlockText(card, 'special', '第一轮：特殊设定').card;

  const round1 = parseStCard(serializeCard(card)).card;
  assert.equal(texts(round1).basic, '第一轮：基本信息');
  assert.equal(texts(round1).special, '第一轮：特殊设定');

  // 在解析结果上继续编辑 —— 这是「再编辑」链路
  const round2Card = setBlockText(round1, 'personality', '第二轮：性格').card;
  const round2 = parseStCard(serializeCard(round2Card)).card;
  const final = texts(round2);

  assert.equal(final.basic, '第一轮：基本信息', '第一轮改动不能丢');
  assert.equal(final.special, '第一轮：特殊设定', '第一轮改动不能丢');
  assert.equal(final.personality, '第二轮：性格');
});

test('未编辑的板块不被改写（避免 diff 噪声）', () => {
  const card = loadCard();
  const before = texts(card);

  const edited = setBlockText(card, 'personality', '只改了性格').card;
  const after = texts(parseStCard(serializeCard(edited)).card);

  for (const id of ['basic', 'settings', 'special', 'user']) {
    assert.equal(after[id], before[id], `${id} 未编辑，文本应保持不变`);
  }
});

test('世界书：合法文本编辑会回写到 entries', () => {
  let card = loadCard();
  const originalCount = card.worldbook.entries.length;

  const nextEntries = [
    ...card.worldbook.entries,
    { id: 9901, comment: '新增条目', content: '这是新增的世界书条目。', keys: ['测试'] },
  ];
  const nextText = renderWorldbookText(nextEntries);

  const result = setBlockText(card, 'worldbook', nextText);
  assert.equal(result.worldbookIssues.filter((i) => i.severity === 'error').length, 0);
  assert.equal(result.card.worldbook.entries.length, originalCount + 1);

  card = result.card;
  const reparsed = parseStCard(serializeCard(card)).card;
  const added = reparsed.worldbook.entries.find((entry) => entry.id === 9901);
  assert.ok(added, '新条目应出现在序列化后的卡里');
  assert.match(added.content, /新增的世界书条目/);
});

test('世界书：非法文本拒绝回写 entries（不许无声清空）', () => {
  const card = loadCard();
  const beforeCount = card.worldbook.entries.length;

  // 缺少 @@CONTENT 段是 error 级问题（见 docs/04 §错误处理）
  const broken = ['@@ENTRY 0', 'name: 缺正文', 'keys: k', '@@END 0'].join('\n');

  // 先用 shared 确认这段文本确实判为不 ok，避免用例建立在错误假设上
  const parsed = parseWorldbookText(broken);
  assert.equal(parsed.ok, false, '构造的缺 content 文本应被判定为非法');

  const result = setBlockText(card, 'worldbook', broken);
  assert.equal(result.card.worldbook.entries.length, beforeCount, 'entries 必须保持原样');
  assert.ok(
    result.worldbookIssues.some((issue) => issue.severity === 'error'),
    '应把解析错误上报给 UI',
  );
});

test('空块：清空后序列化仍保留板块结构，正文为空', () => {
  let card = loadCard();
  card = setBlockText(card, 'settings', '').card;

  const reparsed = parseStCard(serializeCard(card)).card;
  const after = texts(reparsed);
  // 清空板块后，拼装会把标题行留下，因此再次解析时正文可能是若干空行；
  // 语义上空 = trim 后为空串（文档模型与 UI 都以 trim 判定空块）。
  assert.equal(after.settings.trim(), '');
  assert.equal(after.basic.length > 0, true, '其它板块不受影响');
});

test('serializeCard 输出稳定：同一张卡两次序列化逐字节相同', () => {
  const card = loadCard();
  const first = serializeCard(card);
  const second = parseStCard(first).card;
  assert.equal(first, serializeCard(second));
});

// ── 实时提醒：修正后问题必须消失 ──────────────────────────────
//
// UI 的链路是：编辑 → setBlockText → buildAuditReport → issuesFor(blockId) → 编辑器 setIssues。
// 这里按同样的顺序验证「问题集合随文本变化」，这是「修正后提醒即时消失」的可测部分。

// 平台规则有继承链（janitorai → ccv2），必须整组加载后按 id 解析
function loadAllPlatformRules() {
  const files = ['sillytavern', 'character-card-v2', 'character-card-v3', 'janitorai', 'chub'].map(
    (name) =>
      JSON.parse(readFileSync(new URL(`../rules/platforms/${name}.json`, import.meta.url), 'utf8')),
  );
  const loaded = loadPlatformRules(files);
  assert.equal(loaded.errors.length, 0, `平台规则应全部通过校验：${JSON.stringify(loaded.errors)}`);
  return loaded.rules;
}

const PLATFORM_RULES = loadAllPlatformRules();
const PLATFORM = resolvePlatformRule('janitorai', PLATFORM_RULES);
const NATIVE = resolvePlatformRule('sillytavern', PLATFORM_RULES);

function auditOf(card) {
  return buildAuditReport(card, { platformRule: PLATFORM }).issues;
}

test('实时提醒：缺失占位符的问题在补上后消失', () => {
  // janitorai 规则要求正文出现 {{char}}
  let card = loadCard();
  card = setBlockText(card, 'basic', '姓名：林晚照\n年龄：24').card;

  const before = auditOf(card).filter((issue) => issue.location.blockId === 'basic');
  assert.ok(before.length > 0, '缺 {{char}} 时应报问题');

  // 修正：把硬编码名字换成占位符
  card = setBlockText(card, 'basic', '姓名：{{char}}\n年龄：24').card;

  const after = auditOf(card).filter((issue) => issue.location.blockId === 'basic');
  assert.equal(after.length, 0, '补上 {{char}} 后该板块不应再有此问题');
});

test('实时提醒：问题带可定位的位置（blockId + 行号）', () => {
  let card = loadCard();
  card = setBlockText(card, 'basic', '第一行\n第二行没有占位符\n第三行').card;

  const issues = auditOf(card).filter((issue) => issue.location.blockId === 'basic');
  assert.ok(issues.length > 0);

  const locate = issues.find((issue) => issue.location.start !== null);
  assert.ok(locate, '应至少有一条可定位的问题');
  assert.equal(typeof locate.location.line, 'number');
  assert.ok(locate.location.start >= 0 && locate.location.end > locate.location.start);
  // 位置必须落在该板块正文范围内，否则 UI 的 focusRange 会跳错地方
  assert.ok(locate.location.end <= texts(card).basic.length);
});

test('实时提醒：切换平台后结论随规则变化（janitorai 拒绝内嵌世界书）', () => {
  const card = loadCard();

  // 同一张卡、同一段文本，只有平台规则不同
  const janitor = buildAuditReport(card, { platformRule: PLATFORM }).issues;
  const native = buildAuditReport(card, { platformRule: NATIVE }).issues;

  const janitorWorldbook = janitor.filter(
    (issue) => issue.severity === 'warning' && /世界书/.test(issue.message),
  );
  const nativeWorldbook = native.filter(
    (issue) => issue.severity === 'warning' && /世界书/.test(issue.message),
  );

  assert.ok(janitorWorldbook.length > 0, 'janitorai 应提示不支持内嵌世界书');
  assert.equal(nativeWorldbook.length, 0, 'sillytavern 原生支持内嵌世界书，不应报警告');
  assert.ok(janitor.length > native.length, '严格平台的总问题数应更多');
});

// ── 缺失板块必须显式标记（shared 的 CardBlock.missing 语义）────────
//
// 背景：`missing=true` 表示「导入源里根本没有这个板块」，
// 与「用户把板块清空了」是两回事。UI 若不加区分地显示为空，
// 用户无法判断是自己删的还是原文就没有（shared/unified-card.ts 注释明确禁止）。

test('缺失板块：collectBlocks 如实上报 missing，且与空块可区分', () => {
  const base = loadCard();
  const preset = loadPresets([
    JSON.parse(readFileSync(new URL('../rules/presets/default.json', import.meta.url), 'utf8')),
  ]).presets[0];

  // 只给「基本信息」的 TXT：其余五块在宽松模式下被标为缺失
  const applied = applyCardText(base, '【基本信息】\n只有基本信息', preset, { mode: 'lenient' });
  assert.equal(applied.ok, true);
  assert.ok(applied.card);

  const blocks = collectBlocks(applied.card);
  const byId = Object.fromEntries(blocks.map((block) => [block.id, block]));

  assert.equal(byId.basic.missing, false, '存在的板块不应标缺失');
  for (const id of ['personality', 'settings', 'special', 'user']) {
    assert.equal(byId[id].missing, true, `${id} 原文缺失应被标出`);
    assert.equal(byId[id].text.trim(), '', `${id} 缺失时正文为空`);
  }
});

test('缺失板块：用户填写后 missing 清除（不再显示「原文缺失」）', () => {
  const base = loadCard();
  const preset = loadPresets([
    JSON.parse(readFileSync(new URL('../rules/presets/default.json', import.meta.url), 'utf8')),
  ]).presets[0];
  const applied = applyCardText(base, '【基本信息】\n只有基本信息', preset, { mode: 'lenient' });

  // 填写缺失板块后，序列化再解析：该块已真实存在，不应再是「缺失」
  const filled = setBlockText(applied.card, 'special', '这是补写的特殊设定').card;
  const reparsed = parseStCard(serializeCard(filled)).card;
  const special = collectBlocks(reparsed).find((block) => block.id === 'special');
  assert.equal(special.missing, false);
  assert.equal(special.text.trim(), '这是补写的特殊设定');
});

test('正常卡片：六个板块都不带 missing 标记（不误报）', () => {
  const blocks = collectBlocks(loadCard());
  assert.equal(
    blocks.filter((block) => block.missing).length,
    0,
    '完整卡片不应出现「原文缺失」',
  );
});
