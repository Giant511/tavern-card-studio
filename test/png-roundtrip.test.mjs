/**
 * PNG 卡 round-trip 矩阵（v0.1.4 / T12.6）。
 *
 * 需求的铁律是「PNG 内容（JSON 部分）与图像部分**分别断言**」。所以这个文件里
 * 每一类断言都写两遍：一次针对卡内容，一次针对像素。
 *
 * ## 矩阵
 *
 * | 夹具 | 导入 | 导出（同一 spec） | 再导入 | 断言 |
 * |---|---|---|---|---|
 * | fixture-v2.png | chara → V2 | chara | 内容一致 | 内容 + 图像 |
 * | fixture-v3.png | ccv3 → V3 | ccv3 | 内容一致 | 内容 + 图像 |
 * | fixture-both.png | ccv3（优先） | ccv3 | 只剩一个块 | 内容 + 图像 |
 * | fixture-bare.png | bare（纯图） | — | — | 不报错 |
 *
 * ## 为什么"导入 → 导出 → 再导入"要断言三次内容
 *
 * 只断言"导出后能读回"是不够的：`buildPngCard` 里若把 JSON 重新序列化，
 * 读回来的对象仍然深相等 —— 但用户下次打开时会发现键序变了、diff 里全是噪声。
 * 所以这里同时比较"深相等"与"关键字段逐字相等"。
 *
 * ## 替换语义（需求 T12.6 第三条）
 *
 * 旧块不残留 + 二次导出不产生重复块。这两条如果不测，最典型的后果是：
 * 用户把 A 卡（PNG）的封面换成默认卡面导出 B 卡，B 的 PNG 里还带着 A 的正文。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildPngCard,
  parsePngCard,
  readPngChunks,
  stripPngCardData,
  summarizePng,
} from '../shared/dist/png-card.js';
import { parseStCard, serializeStCard } from '../shared/dist/index.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'png');

function fixture(name) {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

/** 图像部分：IHDR + IDAT + PLTE + tRNS 的原始块字节（顺序敏感） */
function imageBytesOf(bytes) {
  return readPngChunks(bytes)
    .filter((chunk) => ['IHDR', 'PLTE', 'IDAT', 'tRNS', 'gAMA', 'iCCP', 'sRGB'].includes(chunk.type))
    .map((chunk) => Buffer.from(chunk.raw).toString('hex'))
    .join('|');
}

/** 卡内容：解析出的 JSON 对象 */
function cardOf(bytes) {
  const result = parsePngCard(bytes);
  assert.equal(result.kind, 'card', '期望这是一张 PNG 卡');
  if (result.kind !== 'card') throw new Error('unreachable');
  return result;
}

// ══════════════════════════════════════════════════════════
// 矩阵：三张卡夹具 × 导入 → 导出 → 再导入

for (const [file, expectedKeyword, expectedSpec] of [
  ['fixture-v2.png', 'chara', 'chara_card_v2'],
  ['fixture-v3.png', 'ccv3', 'chara_card_v3'],
  ['fixture-both.png', 'ccv3', 'chara_card_v3'],
]) {
  test(`${file}：导入 → 导出 → 再导入，内容与图像分别一致`, () => {
    const original = fixture(file);

    // ── ① 导入：走客户端真实管线（parsePngCard → parseStCard → UnifiedCard）
    const imported = cardOf(original);
    assert.equal(imported.keyword, expectedKeyword);
    assert.equal(imported.json.spec, expectedSpec);

    const parsed = parseStCard(imported.jsonText);
    assert.equal(parsed.card.meta.spec, expectedSpec === 'chara_card_v3' ? 'v3' : 'v2');

    // ── ② 导出：与 JSON 导出同一份序列化（这里直接用它，模拟真实链路）
    const payload = serializeStCard(parsed.card, {});
    const jsonText = `${JSON.stringify(payload, null, 2)}\n`;
    const spec = parsed.card.meta.spec === 'v3' ? 'v3' : 'v2';
    const exported = buildPngCard(original, jsonText, spec);

    // ── ③ 再导入
    const reimported = cardOf(exported);

    // 内容断言
    assert.deepEqual(reimported.json, JSON.parse(jsonText), '卡内容深相等');
    assert.equal(reimported.json.data.name, imported.json.data.name, '角色名逐字相同');
    assert.equal(reimported.json.spec, expectedSpec, 'spec 没有被改写');
    assert.equal(reimported.keyword, expectedKeyword, '写回的 keyword 与 spec 一致');

    // 图像断言：像素相关块的原始字节**逐字节**相同
    assert.equal(
      imageBytesOf(exported),
      imageBytesOf(original),
      '图像块被改动了 —— 像素不允许重编码',
    );

    // 尺寸不变
    const before = summarizePng(original);
    const after = summarizePng(exported);
    assert.equal(after.width, before.width);
    assert.equal(after.height, before.height);

    // 块数：导出后只有一个卡块（不累积）
    assert.equal(after.cardChunkCount, 1, '导出后必须只有一个 ccv3/chara 块');
  });
}

test('fixture-both.png：导出后旧的 chara 块被清掉（两块变一块）', () => {
  const original = fixture('fixture-both.png');
  assert.equal(summarizePng(original).cardChunkCount, 2, '夹具本身应当有两个卡块');

  const imported = cardOf(original);
  const exported = buildPngCard(original, imported.jsonText, 'v3');

  const summary = summarizePng(exported);
  assert.equal(summary.cardChunkCount, 1, '导出必须把同名的旧块一起清掉');
  assert.equal(summary.keyword, 'ccv3');

  // V2 的内容不能再出现在字节里
  assert.ok(
    !Buffer.from(exported).toString('latin1').includes(Buffer.from('V2 角色').toString('base64').slice(0, 20)),
    'V2 的角色名 base64 片段仍留在导出结果里 —— 旧 chara 块没删干净',
  );
});

// ══════════════════════════════════════════════════════════
// 替换语义：换卡面 / 二次导出

test('换封面导出：用另一张卡当封面时，旧卡的正文不许留在图里', () => {
  // 场景：用户拿 fixture-v2（含"林晚照"的卡）当 B 卡的封面
  const cover = fixture('fixture-v2.png');
  const newCardJson = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { name: 'B 卡', description: 'B 的内容', first_mes: 'B 的开场' },
  };

  const exported = buildPngCard(cover, newCardJson, 'v2');
  const text = Buffer.from(exported).toString('latin1');

  // 关键：A 卡的角色名 base64 片段不该再出现
  const oldNameB64 = Buffer.from('林晚照', 'utf8').toString('base64');
  assert.ok(!text.includes(oldNameB64), '旧卡的角色名仍在 PNG 里 —— 换封面没剥旧块');

  const reread = cardOf(exported);
  assert.equal(reread.json.data.name, 'B 卡');
  assert.equal(summarizePng(exported).cardChunkCount, 1);
});

test('二次导出（换 spec 往返）不累积块，内容跟着最后一次', () => {
  let bytes = fixture('fixture-v2.png');
  for (let round = 0; round < 4; round += 1) {
    const spec = round % 2 === 0 ? 'v3' : 'v2';
    bytes = buildPngCard(bytes, { spec: `round-${String(round)}`, data: { name: `第${String(round)}轮` } }, spec);
    const summary = summarizePng(bytes);
    assert.equal(summary.cardChunkCount, 1, `第 ${String(round + 1)} 次导出后块数不是 1`);
    assert.equal(summary.keyword, spec === 'v3' ? 'ccv3' : 'chara');
  }
  assert.equal(cardOf(bytes).json.data.name, '第3轮');
});

// ══════════════════════════════════════════════════════════
// 纯图片路径

test('fixture-bare.png：不报错，且能当封面用（剥掉卡数据后仍是合法 PNG）', () => {
  const bare = fixture('fixture-bare.png');
  const result = parsePngCard(bare);
  assert.equal(result.kind, 'bare');

  // 当封面用：写一张卡进去
  const exported = buildPngCard(bare, { data: { name: '用纯图当封面' } }, 'v2');
  assert.equal(cardOf(exported).json.data.name, '用纯图当封面');
  assert.equal(imageBytesOf(exported), imageBytesOf(bare));
});

test('默认卡面（内置资源）能被当封面写入，且尺寸保持 768×1024', () => {
  /*
   * 这条断言守的是"内置资源本身是合法 PNG"—— 它是用户提供的静态资产，
   * 如果哪天被替换成一张 webp 改名，`buildPngCard` 会立刻报 NOT_PNG，
   * 而不是等到用户点导出时才发现。
   */
  const defaultFace = new Uint8Array(
    readFileSync(join(import.meta.dirname, '..', 'client', 'src-tauri', 'resources', 'card-face-default.png')),
  );
  const summary = summarizePng(defaultFace);
  assert.notEqual(summary, null, '内置默认卡面不是合法 PNG');
  assert.equal(summary.width, 768);
  assert.equal(summary.height, 1024);
  assert.equal(summary.keyword, null, '内置卡面不该带卡数据');

  const exported = buildPngCard(defaultFace, { spec: 'chara_card_v2', data: { name: '默认封面' } }, 'v2');
  assert.equal(cardOf(exported).json.data.name, '默认封面');
  assert.equal(imageBytesOf(exported), imageBytesOf(defaultFace), '默认卡面的像素被改动了');
  assert.equal(summarizePng(exported).width, 768);
});

// ══════════════════════════════════════════════════════════
// 审计 / 字数 / 世界书在 PNG 卡上同样生效（需求 T12.6 第四条）

test('从 PNG 导入的卡能走完整审计：字数、世界书、板块识别都生效', async () => {
  const { parseStCard: parse } = await import('../shared/dist/index.js');
  const { buildAuditReport } = await import('../shared/dist/audit/report.js');

  const imported = cardOf(fixture('fixture-v3.png'));
  const parsed = parse(imported.jsonText);

  // ① 板块识别：V3 夹具里 description 带【基本信息】，应被切成板块
  const basic = parsed.card.blocks.find((block) => block.id === 'basic');
  assert.notEqual(basic, undefined, 'PNG 导入后板块没建起来');
  assert.ok(basic.text.includes('姓名'), '基本信息板块内容为空');

  // ② 世界书：V3 夹具带 character_book（空条目）
  assert.equal(parsed.card.worldbook.entries.length, 0, 'V3 夹具的世界书条目数');

  // ③ 审计本身（不给 platformRule 也够 —— 这里验的是"PNG 导入的卡能走审计管线"，
  //    而不是"某条平台规则判得对不对"，那是 audit.test.mjs 的活）
  const report = buildAuditReport(parsed.card, {});
  // ③ 字数：必须包含 first_mes / mes_example 两项（八板块口径）。
  //    `byField` 的每一项是**计数对象**（chars / charsNoSpace / cjk / words / totalWords），
  //    不是数字 —— 断言要指名到 chars，否则拿对象比 0 永远是 false 或永远 true。
  assert.ok(report.wordCount.byField.first_mes.chars > 0, 'first_mes 字数没有被统计');
  assert.ok(report.wordCount.byField.mes_example.chars > 0, 'mes_example 字数没有被统计');
  // 而且这两个字段**不能**被并进 description（八板块改造的核心边界）
  const descChars = report.wordCount.byField.description.chars;
  assert.ok(
    descChars < report.wordCount.total.chars,
    'description 字数等于全文 —— first_mes/mes_example 被错误地算进了 description',
  );

  // ④ 审计铁律：PNG 导入的卡不该因为"来源是图片"而出现 error
  const errors = report.issues.filter((issue) => issue.severity === 'error');
  assert.deepEqual(errors, [], 'PNG 卡上出现了 error 级问题');
});

test('stripPngCardData 对已经干净的图是幂等的（重复调用字节不变）', () => {
  const bare = fixture('fixture-bare.png');
  const once = stripPngCardData(bare);
  const twice = stripPngCardData(once);
  assert.deepEqual(Buffer.from(twice), Buffer.from(once));
});
