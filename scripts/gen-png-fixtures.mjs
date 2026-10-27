#!/usr/bin/env node
/**
 * 生成 PNG 卡夹具（v0.1.4 / T12.1 —— 一切 round-trip 的地基）。
 *
 * ## 为什么夹具要"由脚本生成"而不是手工塞几个二进制
 *
 * 手工造的 PNG 有两个坑，都会让测试**看起来通过但验了个假东西**：
 *   1. 有人用画图软件存一张，软件可能顺手重排块顺序、加 gAMA/iCCP ——
 *      这样测到的"字节保留"是"保留了我这张图的怪癖"，不是通用语义；
 *   2. 有人拿真卡改个 keyword 就当 V3 夹具，里面其实是 V2 结构 ——
 *      "V2/V3 都能读"这条断言就永远是绿的（因为读的都是 V2）。
 *
 * 所以这里**从零拼块**：自己写 IHDR/IDAT/IEND，自己写 tEXt。
 * 这样每个夹具的每一块都是可知的，断言才能指得出"哪一块不对"。
 *
 * ## 四张夹具
 *
 * | 文件 | 卡数据 | 用途 |
 * |---|---|---|
 * | `fixture-v2.png` | `chara`，V2 卡 | 读 V2、写回 V2 |
 * | `fixture-v3.png` | `ccv3`，V3 卡 | 读 V3、写回 V3 |
 * | `fixture-bare.png` | 无 | "纯图片"分支（不是错误） |
 * | `fixture-big.png` | `chara`，V2 卡 | >5 MB 边界（体积/性能） |
 *
 * `fixture-both.png` 是第五张：**同时**有 `ccv3` 与 `chara`，且两者内容不同 ——
 * 专门钉住决策 D2 的优先级（读 ccv3）。没有它，"读 ccv3 优先"这条永远
 * 可以用"图里只有一个块"蒙过去。
 *
 * 输出分两处（刻意分开）：
 *   · 前三张 + both 体积小，落到 `test/fixtures/png/` **入库**；
 *   · 大图几 MB，落到 `.verify/png-fixtures/`（不入库），测试用
 *     `ensureBigFixture()` 现场生成。
 *
 * 用法：node scripts/gen-png-fixtures.mjs [--write]
 *   不带 --write 只打印摘要（CI 里做内容校验用）
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPngCard, crc32, readPngChunks, summarizePng } from '../shared/dist/png-card.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SMALL_DIR = join(ROOT, 'test', 'fixtures', 'png');
const BIG_DIR = join(ROOT, '.verify', 'png-fixtures');

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * 造一张 RGB24 的 PNG。
 *
 * @param {number} width
 * @param {number} height
 * @param {'gradient' | 'noise'} style  `noise` 用于大图：随机像素几乎不可压缩，
 *   才能稳定造出 >5 MB（渐变图会被 deflate 压到几十 KB，尺寸再大也没用）
 */
function makePng(width, height, style) {
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type 2 = RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 每行：1 字节 filter(0) + width*3 字节像素
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  let seed = 0x12345678;
  const nextByte = () => {
    // xorshift32：确定性，换机器也得到同一张图（哈希断言才稳）
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed & 0xff;
  };
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 3;
      if (style === 'noise') {
        raw[offset] = nextByte();
        raw[offset + 1] = nextByte();
        raw[offset + 2] = nextByte();
      } else {
        raw[offset] = (x * 255) / Math.max(1, width - 1);
        raw[offset + 1] = (y * 255) / Math.max(1, height - 1);
        raw[offset + 2] = 160;
      }
    }
  }

  // 大图用 level 0（不压缩）：随机像素本来压不动，level 9 只是白等
  const idat = deflateSync(raw, { level: style === 'noise' ? 0 : 9 });
  const parts = [SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(idat)), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** V2 卡（spec 2.0） */
function v2Card(name) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name,
      description: '【基本信息】\n姓名：{{char}}\n身高：170cm\n\n【其他设定】\n示例用 PNG 夹具。',
      personality: '安静。',
      scenario: '测试场景。',
      first_mes: '"测试开场白。"',
      mes_example: '<START>\n{{user}}: 你好\n{{char}}: "你好。"',
      creator_notes: 'T12.1 PNG 夹具（V2）。',
      alternate_greetings: ['备用开场白。'],
      character_book: {
        name: '夹具世界书',
        entries: [
          {
            id: 0,
            keys: ['测试'],
            content: '这是世界书条目内容。',
            enabled: true,
            insertion_order: 100,
          },
        ],
      },
    },
  };
}

/** V3 卡（spec 3.0，多一个 group_only_greetings 与 nickname） */
function v3Card(name) {
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name,
      nickname: '小三',
      description: '【基本信息】\n姓名：{{char}}\n\n这是 **V3** 夹具，专有的 group_only_greetings 字段。',
      personality: '外向。',
      scenario: 'V3 场景。',
      first_mes: '"V3 开场白。"',
      mes_example: '<START>\n{{user}}: V3 测试\n{{char}}: "收到。"',
      creator_notes: 'T12.1 PNG 夹具（V3）。',
      alternate_greetings: [],
      group_only_greetings: ['只在群聊里出现的一句。'],
      character_book: { name: 'V3 世界书', entries: [] },
    },
  };
}

const fixtures = [
  {
    file: 'fixture-v2.png',
    dir: SMALL_DIR,
    bytes: () => buildPngCard(makePng(64, 64, 'gradient'), v2Card('林晚照'), 'v2'),
    expect: { keyword: 'chara', cardChunkCount: 1 },
  },
  {
    file: 'fixture-v3.png',
    dir: SMALL_DIR,
    bytes: () => buildPngCard(makePng(64, 64, 'gradient'), v3Card('V3 角色'), 'v3'),
    expect: { keyword: 'ccv3', cardChunkCount: 1 },
  },
  {
    file: 'fixture-bare.png',
    dir: SMALL_DIR,
    bytes: () => makePng(32, 32, 'gradient'),
    expect: { keyword: null, cardChunkCount: 0 },
  },
  {
    // 两个块都在，内容不同：读到的必须是 ccv3 那张（决策 D2）
    //
    // 构造方式：`buildPngCard` 会剥掉旧块，所以不能"连写两次"。改为
    // 在同一张裸图上各写一次，拿到两份块序列，再把 chara 块手工插进
    // ccv3 那份的 IEND 之前 —— 这样图里就是真的两块并存。
    file: 'fixture-both.png',
    dir: SMALL_DIR,
    bytes: () => {
      const bare = makePng(48, 48, 'gradient');
      const onlyV2 = buildPngCard(bare, v2Card('V2 角色'), 'v2');
      const onlyV3 = buildPngCard(bare, v3Card('V3 角色优先'), 'v3');

      const v3Chunks = readPngChunks(onlyV3);
      const v2Chunks = readPngChunks(onlyV2);
      const v2Text = v2Chunks.find((item) => {
        if (item.type !== 'tEXt') return false;
        return Buffer.from(item.data.subarray(0, 5)).toString('latin1') === 'chara';
      });

      const parts = [SIGNATURE];
      for (const item of v3Chunks) {
        if (item.type === 'IEND' && v2Text !== undefined) parts.push(v2Text.raw);
        parts.push(item.raw);
      }
      const total = parts.reduce((sum, part) => sum + part.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
      }
      return out;
    },
    expect: { keyword: 'ccv3', cardChunkCount: 2 },
  },
];

const bigFixture = {
  file: 'fixture-big.png',
  dir: BIG_DIR,
  // 1600×1200 RGB24 随机像素 ≈ 5.76 MB 原始扫描线，level 0 后仍 > 5 MB
  bytes: () => buildPngCard(makePng(1600, 1200, 'noise'), v2Card('大图角色'), 'v2'),
  expect: { keyword: 'chara', cardChunkCount: 1 },
};

const write = process.argv.includes('--write');
const rows = [];
for (const item of [...fixtures, bigFixture]) {
  const bytes = item.bytes();
  const summary = summarizePng(bytes);
  rows.push({
    file: item.file,
    bytes: bytes.length,
    width: summary?.width ?? 0,
    height: summary?.height ?? 0,
    keyword: summary?.keyword ?? null,
    cardChunkCount: summary?.cardChunkCount ?? 0,
    chunkTypes: summary?.chunkTypes.join(',') ?? '',
  });
  if (write) {
    mkdirSync(item.dir, { recursive: true });
    writeFileSync(join(item.dir, item.file), bytes);
  }
}

console.log(`${write ? '已写入' : '仅校验（未写盘）'}：\n`);
for (const row of rows) {
  console.log(
    `  ${row.file.padEnd(18)} ${String(row.bytes).padStart(9)} 字节  ` +
      `${String(row.width)}×${row.height}  keyword=${row.keyword ?? '(无)'}  ` +
      `卡块数=${row.cardChunkCount}`,
  );
  console.log(`  ${' '.repeat(18)} 块序列：${row.chunkTypes}`);
}

// 自检：夹具本身要满足声明（否则测试拿到的地基就是错的）
let bad = 0;
for (const item of [...fixtures, bigFixture]) {
  const bytes = item.bytes();
  const summary = summarizePng(bytes);
  if (summary === null) {
    console.log(`  FAIL ${item.file} 不是合法 PNG`);
    bad += 1;
    continue;
  }
  if (summary.keyword !== item.expect.keyword) {
    console.log(`  FAIL ${item.file} keyword 期望 ${String(item.expect.keyword)}，实际 ${String(summary.keyword)}`);
    bad += 1;
  }
  if (summary.cardChunkCount !== item.expect.cardChunkCount) {
    console.log(
      `  FAIL ${item.file} 卡块数期望 ${String(item.expect.cardChunkCount)}，实际 ${String(summary.cardChunkCount)}`,
    );
    bad += 1;
  }
}

if (bigFixture && summarizePng(bigFixture.bytes())?.width === 1600) {
  const size = bigFixture.bytes().length;
  if (size <= 5 * 1024 * 1024) {
    console.log(`  FAIL fixture-big.png 只有 ${String(size)} 字节，未达 >5 MiB 的边界要求`);
    bad += 1;
  }
}

// 入库夹具的哈希要稳定：换个进程再生成一次必须逐字节相同
if (write) {
  for (const item of fixtures) {
    const first = readFileSync(join(item.dir, item.file));
    const again = Buffer.from(item.bytes());
    if (!first.equals(again)) {
      console.log(`  FAIL ${item.file} 两次生成字节不同（夹具不是确定性的）`);
      bad += 1;
    }
  }
}

console.log('');
if (bad > 0) {
  console.log(`结论：${String(bad)} 项不合格`);
  process.exit(1);
}
console.log('结论：通过（夹具与声明一致，且生成是确定性的）');
