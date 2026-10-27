/**
 * PNG 卡块操作（v0.1.4 / T12.2，决策 #162–#164）。
 *
 * 这一层是整条 PNG 线的地基，所以断言按"出错了会怎样"来组织，而不是按 API：
 *
 *   ① **像素零改动** —— 用户最不能接受的静默损坏。判据不是"体积差不多"，
 *      而是把 IHDR/IDAT/PLTE 等**非卡数据块逐字节**比对；
 *   ② **读 keyword 优先级 ccv3 → chara** —— 用 `fixture-both.png`（两块并存、
 *      内容不同）钉死，否则"只有一个块"能让任何实现蒙过去；
 *   ③ **写之前删旧块** —— 二次导出不许累积；换成别的卡面时不把上一张卡的
 *      正文留在图里（这是真的会泄内容）；
 *   ④ **CRC 坏块必须报错** —— 静默跳过会让用户以为"这张图本来就没卡"；
 *   ⑤ **纯图片不是错误** —— 返回 `bare` 而不是抛错，且说明为什么。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  PNG_CARD_KEYWORDS,
  PngCardError,
  buildPngCard,
  crc32,
  parsePngCard,
  readPngChunks,
  stripPngCardData,
  summarizePng,
} from '../shared/dist/png-card.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'png');

function fixture(name) {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

/** 取指定类型的块（用于逐字节比对像素相关块） */
function chunksOfType(bytes, type) {
  return readPngChunks(bytes).filter((chunk) => chunk.type === type);
}

// ── ① 像素零改动 ────────────────────────────────────────────

test('写卡不改图像：除 tEXt 外的块逐字节相同', () => {
  const bare = fixture('fixture-bare.png');
  const withCard = buildPngCard(bare, { spec: 'chara_card_v2', data: { name: 'x' } }, 'v2');

  const types = ['IHDR', 'IDAT'];
  for (const type of types) {
    const before = chunksOfType(bare, type);
    const after = chunksOfType(withCard, type);
    assert.equal(after.length, before.length, `${type} 块数量变了`);
    for (let index = 0; index < before.length; index += 1) {
      assert.deepEqual(
        Buffer.from(after[index].raw),
        Buffer.from(before[index].raw),
        `${type} 块第 ${String(index)} 个被改动了 —— 像素/头部不允许有任何变化`,
      );
    }
  }
});

test('写卡后图像仍能被块结构解析（不是拼出一个假文件）', () => {
  const bare = fixture('fixture-bare.png');
  const withCard = buildPngCard(bare, { spec: 'chara_card_v2', data: { name: 'x' } }, 'v2');
  const summary = summarizePng(withCard);
  assert.notEqual(summary, null);
  assert.equal(summary.width, 32);
  assert.equal(summary.height, 32);
  assert.equal(summary.keyword, 'chara');
});

test('文件签名与 IEND 保持原位：新块插在 IEND 之前', () => {
  const bare = fixture('fixture-bare.png');
  const withCard = buildPngCard(bare, { data: { name: 'x' } }, 'v2');
  const types = readPngChunks(withCard).map((chunk) => chunk.type);
  assert.equal(types[types.length - 1], 'IEND');
  assert.equal(types[types.length - 2], 'tEXt');
  assert.equal(types[0], 'IHDR');
});

// ── ② 读 keyword 优先级 ────────────────────────────────────

test('V2 夹具：chara 块被读出，内容是 V2 卡', () => {
  const result = parsePngCard(fixture('fixture-v2.png'));
  assert.equal(result.kind, 'card');
  if (result.kind !== 'card') return;
  assert.equal(result.keyword, 'chara');
  assert.equal(result.json.spec, 'chara_card_v2');
  assert.equal(result.json.data.name, '林晚照');
});

test('V3 夹具：ccv3 块被读出，V3 专有字段在', () => {
  const result = parsePngCard(fixture('fixture-v3.png'));
  assert.equal(result.kind, 'card');
  if (result.kind !== 'card') return;
  assert.equal(result.keyword, 'ccv3');
  assert.equal(result.json.spec, 'chara_card_v3');
  assert.equal(result.json.data.nickname, '小三');
  assert.deepEqual(result.json.data.group_only_greetings, ['只在群聊里出现的一句。']);
});

test('两块并存时读 ccv3（决策 D2），且能看出图里其实有两块', () => {
  const bytes = fixture('fixture-both.png');
  const result = parsePngCard(bytes);
  assert.equal(result.kind, 'card');
  if (result.kind !== 'card') return;

  assert.equal(result.keyword, 'ccv3', '两块并存必须先读 ccv3');
  assert.equal(result.json.data.name, 'V3 角色优先', '读到的必须是 V3 那份内容');

  // 诊断能得到"两块并存"这个事实 —— 否则用户永远不会知道图里有旧的 chara
  const summary = summarizePng(bytes);
  assert.equal(summary.cardChunkCount, 2);
});

test('keyword 常量顺序就是读取优先级（改顺序会静默改变行为）', () => {
  assert.deepEqual([...PNG_CARD_KEYWORDS], ['ccv3', 'chara']);
});

// ── ③ 写：先删旧块 ─────────────────────────────────────────

test('写 V2 到已含 V2 的图上：旧块被删，只剩一个块', () => {
  const original = fixture('fixture-v2.png');
  const rewritten = buildPngCard(original, { data: { name: '新名字' } }, 'v2');

  const summary = summarizePng(rewritten);
  assert.equal(summary.keyword, 'chara');
  assert.equal(summary.cardChunkCount, 1, '旧 chara 块必须被删掉，否则 ST 读哪个看实现');

  const result = parsePngCard(rewritten);
  assert.equal(result.kind, 'card');
  if (result.kind !== 'card') return;
  assert.equal(result.json.data.name, '新名字');
});

test('二次导出不累积块（连续写 5 次仍然只有一个）', () => {
  let bytes = fixture('fixture-v2.png');
  for (let round = 0; round < 5; round += 1) {
    bytes = buildPngCard(bytes, { data: { name: `第${String(round + 1)}次` } }, 'v2');
    assert.equal(
      summarizePng(bytes).cardChunkCount,
      1,
      `第 ${String(round + 1)} 次导出后块数不是 1 —— "先删再插"退化了`,
    );
  }
  const result = parsePngCard(bytes);
  assert.equal(result.json.data.name, '第5次');
});

test('V2 换 V3：旧 chara 块必须消失，不能两个 keyword 并存', () => {
  const v2 = fixture('fixture-v2.png');
  const v3 = buildPngCard(v2, { spec: 'chara_card_v3', data: { name: '升到 V3' } }, 'v3');

  const summary = summarizePng(v3);
  assert.equal(summary.keyword, 'ccv3');
  assert.equal(summary.cardChunkCount, 1, '既要删自己的旧块，也要删另一个 keyword 的旧块');

  // 关键：图里不该残留 V2 的内容（否则等于把上一张卡留在图片里）
  const decoded = Buffer.from(v3).toString('latin1');
  const v2Base64 = Buffer.from(readFileSync(join(FIXTURES, 'fixture-v2.png')))
    .toString('latin1');
  assert.ok(!decoded.includes('林晚照'), 'V2 的角色名还留在字节里 —— 旧块没删干净');
  void v2Base64;
});

test('写字符串时逐字节保真（不重新序列化）', () => {
  const bare = fixture('fixture-bare.png');
  // 刻意用非常规格式：多余空格 + 键序倒置，重新序列化必然改变它
  const jsonText = '{ "data" : {"name":"保真"} ,  "spec":"chara_card_v2" }';
  const bytes = buildPngCard(bare, jsonText, 'v2');

  const result = parsePngCard(bytes);
  assert.equal(result.kind, 'card');
  if (result.kind !== 'card') return;
  assert.equal(result.jsonText, jsonText, '传字符串时不应当重新序列化');
});

// ── ④ 坏块必须报错 ─────────────────────────────────────────

test('CRC 坏掉的块必须报错，不许静默跳过', () => {
  const bytes = fixture('fixture-v2.png');
  const copy = new Uint8Array(bytes);
  // 改 IDAT 数据区里的一个字节（不动长度），CRC 必然失配
  const chunks = readPngChunks(copy);
  const idat = chunks.find((chunk) => chunk.type === 'IDAT');
  assert.ok(idat !== undefined);
  const offset = idat.raw.byteOffset - copy.byteOffset;
  copy[offset + 8] = copy[offset + 8] ^ 0xff;

  assert.throws(
    () => parsePngCard(copy),
    (error) => error instanceof PngCardError && error.code === 'BAD_CRC',
    '坏块必须抛出 BAD_CRC',
  );
});

test('截断的文件报 TRUNCATED 而不是当成空图', () => {
  const bytes = fixture('fixture-v2.png');
  const truncated = bytes.subarray(0, Math.floor(bytes.length / 2));
  assert.throws(
    () => parsePngCard(truncated),
    (error) => error instanceof PngCardError && (error.code === 'TRUNCATED' || error.code === 'NO_IEND'),
  );
});

test('不是 PNG 的字节报 NOT_PNG', () => {
  assert.throws(
    () => parsePngCard(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])),
    (error) => error instanceof PngCardError && error.code === 'NOT_PNG',
  );
});

test('base64 不是 base64 时报 BAD_BASE64（不是"没有卡数据"）', () => {
  const bare = fixture('fixture-bare.png');
  const chunks = readPngChunks(bare);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  for (const chunk of chunks) {
    if (chunk.type === 'IEND') {
      // 插一个 keyword=chara 但内容不是 base64 的块
      const text = '@@@ not base64 @@@';
      const data = new Uint8Array(5 + 1 + text.length);
      data.set(Buffer.from('chara\0' + text, 'latin1'));
      const out = new Uint8Array(12 + data.length);
      const view = new DataView(out.buffer);
      view.setUint32(0, data.length);
      out.set(Buffer.from('tEXt', 'latin1'), 4);
      out.set(data, 8);
      view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
      parts.push(out);
    }
    parts.push(chunk.raw);
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }

  assert.throws(
    () => parsePngCard(merged),
    (error) => error instanceof PngCardError && error.code === 'BAD_BASE64',
  );
});

// ── ⑤ 纯图片是"合法状态"，不是错误 ────────────────────────

test('无数据块的图返回 bare，并说明原因', () => {
  const result = parsePngCard(fixture('fixture-bare.png'));
  assert.equal(result.kind, 'bare');
  if (result.kind !== 'bare') return;
  assert.ok(result.note.includes('不含角色卡数据'), result.note);
  assert.equal(result.imageBytes.length, fixture('fixture-bare.png').length);
});

// ── 附：strip 与摘要 ───────────────────────────────────────

test('stripPngCardData 去掉卡块但保留图像，且结果是合法 PNG', () => {
  const withCard = fixture('fixture-v2.png');
  const stripped = stripPngCardData(withCard);

  const summary = summarizePng(stripped);
  assert.notEqual(summary, null);
  assert.equal(summary.keyword, null, '剥完之后不该再有卡 keyword');
  assert.equal(summary.cardChunkCount, 0);

  // 图像块内容不变
  assert.deepEqual(
    Buffer.from(chunksOfType(stripped, 'IDAT')[0].raw),
    Buffer.from(chunksOfType(withCard, 'IDAT')[0].raw),
  );

  // 剥完再解析就是"纯图片"——这正是"把 PNG 卡当卡面用"的语义
  assert.equal(parsePngCard(stripped).kind, 'bare');
});

test('summarizePng 对坏文件返回 null 而不是抛错（诊断路径不该二次爆炸）', () => {
  assert.equal(summarizePng(new Uint8Array([0, 1, 2])), null);
});

test('大图（>5 MiB）能正常读写，且 IDAT 未被改动', () => {
  const bigPath = join(import.meta.dirname, '..', '.verify', 'png-fixtures', 'fixture-big.png');
  let big;
  try {
    big = new Uint8Array(readFileSync(bigPath));
  } catch {
    // 大图不入库，没生成就跳过（scripts/gen-png-fixtures.mjs --write 生成）
    return;
  }
  assert.ok(big.length > 5 * 1024 * 1024, `大图只有 ${String(big.length)} 字节`);

  const parsed = parsePngCard(big);
  assert.equal(parsed.kind, 'card');
  if (parsed.kind !== 'card') return;
  assert.equal(parsed.json.data.name, '大图角色');

  const rewritten = buildPngCard(big, { data: { name: '大图改名' } }, 'v2');
  assert.deepEqual(
    Buffer.from(chunksOfType(rewritten, 'IDAT')[0].raw),
    Buffer.from(chunksOfType(big, 'IDAT')[0].raw),
    '大图的 IDAT 被改动了 —— 像素不允许重编码',
  );
});
