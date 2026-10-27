/**
 * G8 防回归：F15 推送产物必须是**合法的 PNG 角色卡**。
 *
 * ## 这条测试守的是什么
 *
 * 上一轮推送的是 ST 原生 JSON：落盘正确、ST 的「导入角色卡」也能成功，但
 * **角色目录扫描器不显示它**（刷新、重启都无效）。用户的实证是"导出的 PNG
 * 手动放进 characters 目录 + 刷新 → 角色正常出现；同内容 JSON 落盘 + 重启
 * 均不可见"，加上现有角色全部是 PNG —— 结论是 ST 1.18 的文件夹扫描只认 PNG，
 * JSON 仅 UI 导入那一条路径可用（决策 #212）。
 *
 * 所以这份文件断言三件事，缺一条这次修复就等于没做：
 *   ① 产物是**真 PNG**（有 IHDR/IDAT/tEXt/IEND，能被 parsePngCard 解析）；
 *   ② 数据块是 `ccv3`（V3 卡）或 `chara`（V2 卡），且**只有一个**（不累积重复块）；
 *   ③ 读回来的卡里 `name` / `first_mes` 与导出前一致 —— 只看"块存在"不够，
 *      块里可以是任何东西；
 *   ④ 像素与原图逐字节一致（IHDR + IDAT 原始字节完全相同，零重编码）。
 *
 * 走的是**真实管线**：`buildExportAsync(card, preset, 'png', …)` —— 与「导出 PNG」
 * 「另存为 PNG」同一个函数，所以这里绿的，用户手里那份也是绿的。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  parsePngCard,
  parseStCard,
  readPngChunks,
  summarizePng,
  PNG_KEYWORD_FOR_SPEC,
} from '../shared/dist/index.js';
import { buildExportAsync } from '../client/src/export/export-card.ts';
import {
  describePushFace,
  staleJsonSiblings,
  stPushFileName,
  ST_PUSH_EXTENSION,
} from '../client/src/session/st-install.ts';

const ROOT = join(import.meta.dirname, '..');
const SAMPLE_JSON = readFileSync(join(ROOT, 'test', 'fixtures', 'sample-card.json'), 'utf8');
const FACE_V2 = new Uint8Array(readFileSync(join(ROOT, 'test', 'fixtures', 'png', 'fixture-v2.png')));

/**
 * 取图片本体（除 tEXt 之外的所有 chunk 原始字节拼接）。
 *
 * 为什么这样比"重新编码后再解码比较像素"更强：本项目导出**不做任何重编码**
 * （`buildPngCard` 只是在原图字节流里插入一个 tEXt 块），所以"去掉 tEXt 之后
 * 逐字节相同"就是"像素逐一相同"的严格证明，不需要实现一个 PNG 解码器。
 */
function imageBytesWithoutCardChunks(bytes) {
  const chunks = readPngChunks(bytes);
  const parts = [];
  for (const chunk of chunks) {
    if (chunk.type === 'tEXt') {
      const keyword = String.fromCharCode(...chunk.data.subarray(0, Math.max(0, chunk.data.indexOf(0))));
      if (keyword === 'ccv3' || keyword === 'chara') continue;
    }
    parts.push(chunk.type, ...chunk.data);
  }
  return Buffer.from(parts);
}

test('推送产物是 PNG（不是 JSON）—— 扩展名常量与理由都在一处', () => {
  // 这条常量是"推送格式"的唯一真相源：改回 json 必须同时改这里的断言
  assert.equal(ST_PUSH_EXTENSION, 'png');
});

test('推送文件名用 .png，冲突加序号（不覆盖）', () => {
  assert.equal(stPushFileName('西奥', []), '西奥.png');
  assert.equal(stPushFileName('西奥', ['西奥.png']), '西奥 (2).png');
  // 关键：同名的 **.json** 不该占用 png 的序号 —— 换成 PNG 之后它们是两个文件，
  // 但 ST 只认 png，所以 png 应该能直接用原名
  assert.equal(stPushFileName('西奥', ['西奥.json']), '西奥.png');
});

test('推送产物：合法 PNG + 单一 ccv3/chara 块 + 卡内容读得回来', async () => {
  const parsed = parseStCard(SAMPLE_JSON);
  const artifact = await buildExportAsync(parsed.card, null, 'png', undefined, FACE_V2);

  assert.equal(artifact.format, 'png', '推送产物必须是 PNG（G8 的核心）');
  assert.ok(artifact.png instanceof Uint8Array);

  // ① 是真 PNG：四个必需结构块齐全
  const summary = summarizePng(artifact.png);
  assert.notEqual(summary, null, '产物不是合法 PNG');
  assert.ok(summary.width > 0 && summary.height > 0, '缺 IHDR 尺寸');
  for (const required of ['IHDR', 'IDAT', 'tEXt', 'IEND']) {
    assert.ok(summary.chunkTypes.includes(required), `PNG 缺少 ${required} 块：${summary.chunkTypes.join(',')}`);
  }

  // ② 数据块 keyword 与卡的 spec 对应，且**只有一个**（重复块会让文件里留着旧卡正文）
  const expectedKeyword = PNG_KEYWORD_FOR_SPEC[parsed.card.meta.spec === 'v3' ? 'v3' : 'v2'];
  assert.equal(summary.keyword, expectedKeyword, '数据块 keyword 与卡的 spec 不匹配');
  assert.equal(summary.cardChunkCount, 1, `卡数据块必须只有一个，实际 ${String(summary.cardChunkCount)}`);

  // ③ 块里的卡内容读得回来（只看"块存在"不够，块里可以是任何东西）
  const reread = parsePngCard(artifact.png);
  assert.equal(reread.kind, 'card', '写进去的卡读不回来');
  const back = parseStCard(reread.jsonText).card;
  assert.equal(back.meta.name, parsed.card.meta.name, '角色名在往返中变了');
  const firstMesOf = (card) => card.blocks.find((block) => block.id === 'initial-scene').text;
  assert.equal(firstMesOf(back), firstMesOf(parsed.card), '初始场景（first_mes）在往返中变了');
  assert.ok(firstMesOf(back).trim() !== '', '夹具的初始场景本来就该非空（否则这条断言是空转）');
});

test('推送产物：像素与原图逐字节一致（零重编码）', async () => {
  const parsed = parseStCard(SAMPLE_JSON);
  const artifact = await buildExportAsync(parsed.card, null, 'png', undefined, FACE_V2);

  // 本项目导出不重编码图像：插入一个 tEXt 块，其余字节原样保留。
  // 所以"剥掉卡块后逐字节相同"就是"像素逐一相同"的严格证明。
  const before = imageBytesWithoutCardChunks(FACE_V2);
  const after = imageBytesWithoutCardChunks(artifact.png);
  assert.equal(
    after.length,
    before.length,
    `剥掉卡块后字节数变了（${String(before.length)} → ${String(after.length)}），说明图像被重编码了`,
  );
  assert.ok(after.equals(before), '剥掉卡块后仍有字节差异 —— 图像不再与用户那张逐字节相同');

  // IDAT 单独再钉一次：它是真正的像素数据
  const idatOf = (bytes) => Buffer.concat(readPngChunks(bytes).filter((c) => c.type === 'IDAT').map((c) => Buffer.from(c.data)));
  assert.ok(idatOf(artifact.png).equals(idatOf(FACE_V2)), 'IDAT（像素数据）被重新编码了');
});

test('推送产物：重复导出不累积卡块（换封面也不会留下旧卡）', async () => {
  const parsed = parseStCard(SAMPLE_JSON);
  const once = await buildExportAsync(parsed.card, null, 'png', undefined, FACE_V2);
  // 把产物当作"原图"再导一次 —— 模拟"同一张图反复导出"
  const twice = await buildExportAsync(parsed.card, null, 'png', undefined, once.png);

  const summary = summarizePng(twice.png);
  assert.notEqual(summary, null);
  assert.equal(summary.cardChunkCount, 1, '第二次导出后出现了多个卡块 —— 旧卡正文会留在图里');
});

test('卡面来源说明：三种来源各自说清楚，不装懂', () => {
  assert.match(describePushFace({ from: 'source', fileName: null, note: '' }), /原图/);
  assert.match(describePushFace({ from: 'library', fileName: 'a.png', note: '' }), /a\.png/);
  assert.match(describePushFace({ from: 'default', fileName: null, note: '' }), /内置默认卡面/);
  // 有 note（转码/压缩）时以 note 为准 —— 那是用户更该知道的信息
  assert.equal(
    describePushFace({ from: 'library', fileName: 'a.jpg', note: '已把 a.jpg 转为 PNG' }),
    '卡面：已把 a.jpg 转为 PNG',
  );
});

test('旧 JSON 遗留：只认完全同名的那份，不误伤别的卡', () => {
  assert.deepEqual(staleJsonSiblings('西奥', ['西奥.json', '西奥 (2).json', '别人.json']), ['西奥.json']);
  assert.deepEqual(staleJsonSiblings('西奥', ['西奥.png']), []);
  // 大小写不敏感（Windows 上本来就同一个文件）
  assert.deepEqual(staleJsonSiblings('xiao', ['XIao.json']), ['XIao.json']);
  // 带序号的不算"同名残留"：那是另一张的备份，不该提示用户删
  assert.deepEqual(staleJsonSiblings('西奥', ['西奥 (2).json']), []);
});
