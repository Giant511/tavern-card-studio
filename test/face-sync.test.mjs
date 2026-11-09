/**
 * 上传卡面时的「要不要传」决策（v0.1.7 修订二）—— `syncFaceAfterUpload` 的单元测试。
 *
 * ## 为什么值得单测
 *
 * 这条逻辑的每个分叉都对应一个**用户看得见但不一定说得出**的后果：
 *
 *   · 「没变也传」→ 每次保存都白花几百 KB 上行，用户只觉得"上传有点慢"
 *   · 「变了不传」→ 服务端的封面永远是第一张，而本地显示的是新的
 *   · 「失败就报错」→ 用户改完设定点上传，看到红色错误，以为白改了
 *
 * 三条都不会让功能"坏掉"，只会让人莫名其妙 —— 正是最该用测试钉住的那类。
 *
 * 用真 PNG（`buildPngCard` 造一张含卡数据块的）而不是假字节：
 * 「剥掉卡数据块」这条判据只有真 PNG 才能验，假字节永远走不到。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildPngCard, stripPngCardData } from '../shared/dist/index.js';
import { syncFaceAfterUpload } from '../client/src/sync/face-sync.ts';

/** 一张最小的合法 PNG（1×1），用作底图 */
const BASE_PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
);

/** 造一张"含卡数据块"的 PNG —— 模拟从 PNG 导入的卡 */
function pngWithCard(json) {
  // 第 3 个参数是 spec 字符串（'v2' | 'v3'），不是对象 —— 传错会让 readPngChunks 收到 undefined
  return buildPngCard(BASE_PNG, json, 'v2');
}

const CARD_JSON = JSON.stringify({ spec: 'chara_card_v2', data: { name: '探针' } });

test('没有图源：不上传，摘要清成 null（否则换图后会被误判"没变"）', async () => {
  let called = false;
  const outcome = await syncFaceAfterUpload({
    pngBytes: null,
    lastUploadedSha: 'stale-sha',
    upload: async () => {
      called = true;
      return { changed: true, sha256: 'x' };
    },
  });
  assert.equal(called, false, '没有图就不该发请求');
  assert.equal(outcome.attempted, false);
  assert.equal(outcome.sha256, null, '摘要必须清掉，不能留旧值');
});

test('上传的是**剥掉卡数据块**的纯图，不是原 PNG', async () => {
  const withCard = pngWithCard(CARD_JSON);
  // 前提校验：这张 PNG 确实比纯图大（说明卡数据块真的在里面）
  assert.ok(withCard.byteLength > BASE_PNG.byteLength, '构造的测试数据不含卡数据块');

  let sent = null;
  await syncFaceAfterUpload({
    pngBytes: withCard,
    lastUploadedSha: null,
    upload: async (bytes) => {
      sent = bytes;
      return { changed: true, sha256: 'sha' };
    },
  });

  assert.notEqual(sent, null, '该上传却没上传');
  assert.deepEqual(
    Array.from(sent),
    Array.from(stripPngCardData(withCard)),
    '发出去的字节必须等于"剥掉卡数据块"的结果 —— JSON 已经在版本流里，不该再存一份',
  );
  assert.ok(sent.byteLength < withCard.byteLength, '剥过之后应当变小');
});

test('摘要未变：不发请求（这是常态路径，用户不该为它等）', async () => {
  const withCard = pngWithCard(CARD_JSON);
  const pureSha = await shaReady(stripPngCardData(withCard));

  let called = false;
  const outcome = await syncFaceAfterUpload({
    pngBytes: withCard,
    lastUploadedSha: pureSha,
    upload: async () => {
      called = true;
      return { changed: false, sha256: pureSha };
    },
  });

  assert.equal(called, false, '摘要一样就不该发请求');
  assert.equal(outcome.attempted, false);
  assert.equal(outcome.sha256, pureSha, '会话里记的摘要要保持正确');
  assert.equal(outcome.note, '', '常态路径不该打扰用户');
});

test('图变了：上传并采用服务端返回的摘要', async () => {
  const withCard = pngWithCard(CARD_JSON);
  let payload = null;
  const outcome = await syncFaceAfterUpload({
    pngBytes: withCard,
    lastUploadedSha: 'old-sha',
    upload: async (bytes, mime) => {
      payload = { size: bytes.byteLength, mime };
      return { changed: true, sha256: 'server-sha' };
    },
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.sha256, 'server-sha', '要信服务端那份（它才是真正存下来的）');
  assert.equal(payload.mime, 'image/png');
});

test('上传失败：不抛异常，返回可读提示，且保留旧摘要', async () => {
  const withCard = pngWithCard(CARD_JSON);
  const outcome = await syncFaceAfterUpload({
    pngBytes: withCard,
    lastUploadedSha: 'old-sha',
    upload: async () => {
      throw new Error('服务端 500');
    },
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.sha256, 'old-sha', '失败时不能把摘要改成新的（否则下次会被判"没变"而永久漏传）');
  assert.match(outcome.note, /封面没能上传/, '要说清"内容已保存、封面没传上"');
  assert.match(outcome.note, /服务端 500/, '原始错误要带上，不然没法排查');
});

test('图片结构异常：退回"不上传"并提示（至少卡本身还是好的）', async () => {
  // 不是 PNG：stripPngCardData 会抛
  const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const outcome = await syncFaceAfterUpload({
    pngBytes: garbage,
    lastUploadedSha: null,
    upload: async () => ({ changed: true, sha256: 'x' }),
  });
  assert.equal(outcome.attempted, false, '剥不掉时不该把垃圾当封面传上去');
  assert.match(outcome.note, /没能去卡数据块/);
});

/** 用同一套 WebCrypto 算摘要（与实现同源，不自己再造一个算法） */
async function shaReady(bytes) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
