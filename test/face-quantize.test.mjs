/**
 * 量化 + indexed PNG 编码（v0.1.7 增补二）—— `quantizeMedianCut` / `encodeIndexedPng` 的单元测试。
 *
 * ## 判据为什么必须是"解回来"
 *
 * 编码器的输出要喂给 **ST 和图片查看器**，不是喂给我们自己。所以断言不能停在
 * "函数没抛错、字节非空"：一个把 IDAT 写成 raw deflate 的实现同样会返回
 * 一堆非空字节，然后所有解码器都报"PNG 已损坏"。
 *
 * 这里用 `node:zlib` 把 IDAT **解压**、按 PNG 规则还原扫描线，再逐像素
 * 与输入的量化结果比对 —— 只有这一步能证明"写对了"。
 *
 * CRC 单独复核一遍：PNG 的 CRC 覆盖 `type + data`（不含 length），
 * 少算或多算 4 字节的实现能骗过大多数肉眼看字节的人，但解码器会拒收。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync, inflateSync } from 'node:zlib';

import { encodeIndexedPng, quantizeMedianCut } from '../client/src/export/face-quantize.ts';
import { crc32 } from '../shared/src/png-card.ts';
import { ST_AVATAR_COLORS } from '../client/src/export/face-spec.ts';

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 造一块 RGBA 像素 */
function rgba(pixels) {
  return new Uint8Array(pixels.flat());
}

/** 解析 PNG chunk（只认 length/type/data/crc，够验证用） */
function readChunks(bytes) {
  const chunks = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length =
      ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const crc =
      ((bytes[offset + 8 + length] << 24) |
        (bytes[offset + 9 + length] << 16) |
        (bytes[offset + 10 + length] << 8) |
        bytes[offset + 11 + length]) >>>
      0;
    chunks.push({ type, data, crc, crcInput: bytes.subarray(offset + 4, offset + 8 + length) });
    offset += 12 + length;
  }
  return chunks;
}

const deflate = async (raw) => new Uint8Array(deflateSync(Buffer.from(raw)));

/* ───────────── 量化 ───────────── */

test('单色图量化成 1 色，所有下标都是 0', () => {
  const data = rgba(Array.from({ length: 16 }, () => [255, 0, 0, 255]));
  const q = quantizeMedianCut(data, 256);
  assert.equal(q.colorCount, 1);
  assert.deepEqual([...q.palette.subarray(0, 4)], [255, 0, 0, 255]);
  assert.ok([...q.indices].every((i) => i === 0));
});

test('两色图量化成 2 色，且两色各自映射到不同下标', () => {
  const pixels = [];
  for (let i = 0; i < 8; i += 1) pixels.push([0, 0, 255, 255]);
  for (let i = 0; i < 8; i += 1) pixels.push([255, 255, 0, 255]);
  const q = quantizeMedianCut(rgba(pixels), 256);

  assert.equal(q.colorCount, 2);
  const first = q.indices[0];
  const ninth = q.indices[8];
  assert.notEqual(first, ninth, '两种颜色不该映射到同一个下标');
  // 前 8 个像素同色 ⇒ 同下标；后 8 个同理
  assert.ok([...q.indices.subarray(0, 8)].every((i) => i === first));
  assert.ok([...q.indices.subarray(8)].every((i) => i === ninth));
});

test('颜色数不超过目标色数', () => {
  // 造 64 种不同颜色，只要 8 色
  const pixels = [];
  for (let r = 0; r < 4; r += 1) {
    for (let g = 0; g < 4; g += 1) {
      for (let b = 0; b < 4; b += 1) pixels.push([r * 80, g * 80, b * 80, 255]);
    }
  }
  const q = quantizeMedianCut(rgba(pixels), 8);
  assert.ok(q.colorCount <= 8, `实际 ${q.colorCount} 色，超过目标 8`);
  assert.ok(q.colorCount >= 2, '多色图不该塌成 1 色');
});

test('目标色数大于实际颜色数时，不造假色（colorCount 不超过真实色数）', () => {
  const pixels = [];
  for (let i = 0; i < 10; i += 1) pixels.push([10, 20, 30, 255]);
  for (let i = 0; i < 10; i += 1) pixels.push([200, 100, 50, 255]);
  const q = quantizeMedianCut(rgba(pixels), 256);
  assert.equal(q.colorCount, 2);
});

test('256 色的上限对渐变成立（这条是头像的真实场景）', () => {
  const pixels = [];
  for (let i = 0; i < 4096; i += 1) {
    const v = Math.round((i / 4096) * 255);
    pixels.push([v, 255 - v, (v * 3) % 256, 255]);
  }
  const q = quantizeMedianCut(rgba(pixels), ST_AVATAR_COLORS);
  assert.ok(q.colorCount <= ST_AVATAR_COLORS);
  assert.ok(q.colorCount > 200, `渐变应尽量用满调色板，实际只有 ${q.colorCount} 色`);
});

/* ───────────── PNG 编码 ───────────── */

test('产出的 PNG：签名 / IHDR 字段 / PLTE / IEND 都对', async () => {
  const pixels = [];
  for (let i = 0; i < 8; i += 1) pixels.push([1, 2, 3, 255]);
  for (let i = 0; i < 8; i += 1) pixels.push([250, 240, 230, 255]);
  const q = quantizeMedianCut(rgba(pixels), 256);
  const png = await encodeIndexedPng(4, 4, q, deflate);

  assert.deepEqual([...png.subarray(0, 8)], PNG_SIG, 'PNG 签名不对');

  const chunks = readChunks(png);
  assert.deepEqual(
    chunks.map((c) => c.type),
    ['IHDR', 'PLTE', 'IDAT', 'IEND'],
    'chunk 顺序/种类不对（不透明图不该有 tRNS）',
  );

  const ihdr = chunks[0].data;
  const width = (ihdr[0] << 24) | (ihdr[1] << 16) | (ihdr[2] << 8) | ihdr[3];
  const height = (ihdr[4] << 24) | (ihdr[5] << 16) | (ihdr[6] << 8) | ihdr[7];
  assert.equal(width >>> 0, 4);
  assert.equal(height >>> 0, 4);
  assert.equal(ihdr[8], 8, 'bit depth 必须是 8');
  assert.equal(ihdr[9], 3, 'color type 必须是 3（indexed）');
  assert.equal(ihdr[12], 0, '不能是隔行');

  assert.equal(chunks[1].data.length, q.colorCount * 3, 'PLTE 必须恰好 3×色数 字节');
});

test('每个 chunk 的 CRC 都正确（覆盖 type+data，不含 length）', async () => {
  const q = quantizeMedianCut(rgba(Array.from({ length: 4 }, () => [9, 8, 7, 255])), 4);
  const png = await encodeIndexedPng(2, 2, q, deflate);
  for (const chunk of readChunks(png)) {
    assert.equal(chunk.crc >>> 0, crc32(chunk.crcInput) >>> 0, `${chunk.type} 的 CRC 不对`);
  }
});

test('**IDAT 解压后能还原每一个像素的下标**（这条才是"真的编码对了"）', async () => {
  const width = 5;
  const height = 3;
  // 造一块每像素颜色都不同的图，量化后下标各不相同才验得出错位
  const pixels = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      pixels.push([x * 40, y * 70, x * 10 + y, 255]);
    }
  }
  const q = quantizeMedianCut(rgba(pixels), 15);
  const png = await encodeIndexedPng(width, height, q, deflate);

  const idat = readChunks(png).find((c) => c.type === 'IDAT');
  assert.ok(idat, '没有 IDAT');
  const raw = new Uint8Array(inflateSync(Buffer.from(idat.data)));

  const stride = width + 1;
  assert.equal(raw.length, stride * height, '解压后长度不对（每行多一个 filter 字节）');
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * stride], 0, `第 ${y} 行的 filter 字节不是 0`);
    for (let x = 0; x < width; x += 1) {
      const got = raw[y * stride + 1 + x];
      const want = q.indices[y * width + x];
      assert.equal(got, want, `像素 (${x},${y}) 的下标错位`);
    }
  }
});

test('带透明的图写出 tRNS；全不透明的图不写', async () => {
  const opaque = quantizeMedianCut(rgba(Array.from({ length: 4 }, () => [1, 1, 1, 255])), 4);
  const opaquePng = await encodeIndexedPng(2, 2, opaque, deflate);
  assert.ok(!readChunks(opaquePng).some((c) => c.type === 'tRNS'), '全不透明不该有 tRNS');

  const pixels = [];
  for (let i = 0; i < 4; i += 1) pixels.push([1, 1, 1, 0]);
  for (let i = 0; i < 4; i += 1) pixels.push([200, 200, 200, 255]);
  const alpha = quantizeMedianCut(rgba(pixels), 8);
  const alphaPng = await encodeIndexedPng(2, 4, alpha, deflate);
  const trns = readChunks(alphaPng).find((c) => c.type === 'tRNS');
  assert.ok(trns, '有透明像素时必须写 tRNS');
  assert.equal(trns.data.length, alpha.colorCount, 'tRNS 长度必须等于色数');
});

test('尺寸或调色板为空时明确抛错，不产出半个 PNG', async () => {
  const empty = { indices: new Uint8Array(0), palette: new Uint8Array(0), colorCount: 0 };
  await assert.rejects(() => encodeIndexedPng(2, 2, empty, deflate), /没有可编码的像素/);
  await assert.rejects(
    () => encodeIndexedPng(0, 2, quantizeMedianCut(rgba([[1, 1, 1, 255]]), 2), deflate),
    /没有可编码的像素/,
  );
});

test('512×512 头像尺寸下的编码能吃下（性能与内存的冒烟）', async () => {
  const edge = 512;
  const pixels = [];
  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      pixels.push([(x * 255) / edge, (y * 255) / edge, 128, 255]);
    }
  }
  const q = quantizeMedianCut(rgba(pixels), ST_AVATAR_COLORS);
  const png = await encodeIndexedPng(edge, edge, q, deflate);
  assert.ok(png.length > 1000, '512×512 的 PNG 不该只有几百字节');
  // 索引图 = 1 byte/px，压缩后必须**小于**原始 24-bit 的体积，否则说明白做了
  assert.ok(png.length < edge * edge * 3, '索引 PNG 比 24-bit 还大，说明没起到作用');
});
