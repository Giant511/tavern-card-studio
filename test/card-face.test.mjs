/**
 * 卡面资产（v0.1.7 修订二）—— 存储层判据。
 *
 * ## 为什么不走 HTTP
 *
 * 这一轮要钉住的是三条**语义**，它们全在 storage 层：
 *
 *   ① sha256 未变就**什么都不做**（不写 blob、不改行、不记事件）
 *   ② 换卡面**不产生版本**（versionCount / latestSeq 不动）
 *   ③ 换卡面**不改 updated_at**（那是"内容变了"的时间，列表按它排序）
 *
 * 权限（readScope）与状态码（404 / 413 / 415）走的是既有机制，
 * 在 `trash-prune.test.mjs` 那套真 HTTP 里已经覆盖过同类路径，
 * 这里不重复搭一个进程 —— 重复的代价是测试跑得慢、而判据没变强。
 *
 * ## 为什么"未变就跳过"值得单独测
 *
 * 客户端每次上传都会带上当前卡面。如果服务端每次都写一遍，
 * 审计日志会被 `card.face.replace` 淹没 —— 而真正需要追溯的那次
 * （"谁把这卡的封面换了"）就找不出来了。更实际的是：50 次上传 =
 * 50 条无用事件，导出审计报告时全是噪音。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BlobStore } from '../server/dist/storage/blobs.js';
import { CardService, FACE_MAX_BYTES, normalizeFaceMime } from '../server/dist/storage/cards.js';
import { Db } from '../server/dist/storage/db.js';
import { GitStore } from '../server/dist/storage/git-store.js';

/** 真实的 1×1 PNG（67 字节）。服务端不解析图片，但用真图片让"存的是图"这件事可读 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
/** 另一张不同的图：只改一个字节就够让摘要不同 */
const PNG_OTHER = Buffer.concat([PNG_1X1.subarray(0, PNG_1X1.length - 1), Buffer.from([0x00])]);

function withService(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tcs-face-'));
    const db = new Db(join(dir, 'state.db'));
    try {
      const blobs = new BlobStore(join(dir, 'blobs'));
      const faceBlobs = new BlobStore(join(dir, 'faces'));
      const cards = new CardService(
        db,
        blobs,
        faceBlobs,
        new GitStore(join(dir, 'repos')),
        { analyze: () => ({ throws: 'not used' }) },
        { platformId: 'sillytavern', presetId: 'default' },
        { info() {}, warn() {}, error() {}, debug() {} },
      );

      const now = '2026-10-28T12:00:00.000Z';
      const insertCard = (id) => {
        db.insertCard({
          id,
          id_source: 'client',
          owner_id: '',
          repo_id: '',
          name: id,
          spec: 'chara_card_v2',
          spec_version: '2.0',
          creator: '',
          tags_json: '[]',
          source_filename: '',
          created_at: now,
          updated_at: now,
          deleted_at: null,
          version_count: 2,
          latest_seq: 2,
          latest_commit: 'a'.repeat(40),
          latest_sha256: 'b'.repeat(64),
          latest_size: 10,
          latest_message: 'v2',
          latest_at: now,
          parse_warnings_json: '[]',
          audit_sha256: null,
          audit_error: null,
          audit_generated_at: null,
          audit_error_count: null,
          audit_warning_count: null,
          audit_info_count: null,
          audit_exportable: null,
        });
      };
      await fn({ db, cards, faceBlobs, insertCard, now });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  '首次设置卡面：changed=true，行上四个字段都写上',
  withService(async ({ db, cards, insertCard }) => {
    insertCard('card-1');
    const result = await cards.setFace('card-1', PNG_1X1, 'image/png');
    assert.equal(result.changed, true);
    assert.equal(result.face.size, PNG_1X1.length);
    assert.equal(result.face.mime, 'image/png');

    const row = db.getCard('card-1');
    assert.equal(row.face_sha256, BlobStore.sha256(PNG_1X1));
    assert.equal(row.face_size, PNG_1X1.length);
    assert.equal(row.face_mime, 'image/png');
    assert.notEqual(row.face_updated_at, null);
  }),
);

test(
  '同一张图再传：changed=false，且**不记事件**（否则审计被噪音淹没）',
  withService(async ({ cards, insertCard }) => {
    insertCard('card-1');
    await cards.setFace('card-1', PNG_1X1, 'image/png');
    const before = (await cards.events(50)).filter((e) => e.action.startsWith('card.face'));

    const again = await cards.setFace('card-1', PNG_1X1, 'image/png');
    assert.equal(again.changed, false, '内容一致时不该报"变了"');

    const after = (await cards.events(50)).filter((e) => e.action.startsWith('card.face'));
    assert.equal(after.length, before.length, '空操作不该产生审计事件');
  }),
);

test(
  '换成另一张图：changed=true，事件动作是 replace（不是 add）',
  withService(async ({ cards, insertCard }) => {
    insertCard('card-1');
    await cards.setFace('card-1', PNG_1X1, 'image/png');
    const result = await cards.setFace('card-1', PNG_OTHER, 'image/png');
    assert.equal(result.changed, true);

    const events = (await cards.events(50)).filter((e) => e.action.startsWith('card.face'));
    const actions = events.map((e) => e.action);
    assert.ok(actions.includes('card.face.add'), `首次应当是 add：${actions.join(',')}`);
    assert.ok(actions.includes('card.face.replace'), `换图应当是 replace：${actions.join(',')}`);
  }),
);

test(
  '换卡面**不产生版本**、**不改 updated_at**',
  withService(async ({ db, cards, insertCard, now }) => {
    insertCard('card-1');
    const versionBefore = db.getCard('card-1').version_count;
    const latestBefore = db.getCard('card-1').latest_seq;
    const updatedBefore = db.getCard('card-1').updated_at;

    await cards.setFace('card-1', PNG_1X1, 'image/png');

    const row = db.getCard('card-1');
    assert.equal(row.version_count, versionBefore, '换封面不是新版本');
    assert.equal(row.latest_seq, latestBefore, '最新版本号不许动');
    assert.equal(row.updated_at, updatedBefore, 'updated_at 是"内容变了"的时间，换封面不该刷新它');
    assert.notEqual(row.face_updated_at, null, '卡面自己的时间另记一列');
    // 两列必须不同：updated_at 停在造数据那个时刻，face_updated_at 是「现在」。
    // 写一条恒真断言等于没测 —— 这里比较的是两个真正独立的来源。
    assert.notEqual(row.face_updated_at, row.updated_at);
  }),
);

test(
  '读回卡面：字节与 MIME 一致（blob 读时校验摘要）',
  withService(async ({ cards, insertCard }) => {
    insertCard('card-1');
    await cards.setFace('card-1', PNG_1X1, 'image/webp');
    const face = cards.getFace('card-1');
    assert.deepEqual(face.bytes, PNG_1X1);
    assert.equal(face.mime, 'image/webp');
    assert.equal(face.sha256, BlobStore.sha256(PNG_1X1));
  }),
);

test(
  '没有卡面时 GetFace 抛 FACE_NOT_FOUND（而不是返回空 Buffer）',
  withService(async ({ cards, insertCard }) => {
    insertCard('card-bare');
    assert.throws(
      () => cards.getFace('card-bare'),
      (error) => {
        assert.equal(error.code, 'FACE_NOT_FOUND');
        assert.equal(error.status, 404);
        return true;
      },
      '"没有卡面"是正常状态，但必须与"上传失败"区分开',
    );
  }),
);

test(
  '删除卡面：deleted=true，之后读回 404；再删一次幂等返回 false 且不记事件',
  withService(async ({ db, cards, insertCard }) => {
    insertCard('card-1');
    await cards.setFace('card-1', PNG_1X1, 'image/png');

    const first = cards.deleteFace('card-1');
    assert.equal(first.deleted, true);
    assert.equal(db.getCard('card-1').face_sha256, null);
    assert.throws(() => cards.getFace('card-1'), (e) => e.code === 'FACE_NOT_FOUND');

    const eventsBefore = (await cards.events(50)).filter((e) => e.action === 'card.face.delete');
    const second = cards.deleteFace('card-1');
    assert.equal(second.deleted, false, '本来就没了，不算删到东西');
    const eventsAfter = (await cards.events(50)).filter((e) => e.action === 'card.face.delete');
    assert.equal(eventsAfter.length, eventsBefore.length, '空操作不记事件');
  }),
);

test(
  '删除卡面不删 blob（内容池是共享的，删文件会让别的引用变坏）',
  withService(async ({ cards, faceBlobs, insertCard }) => {
    insertCard('card-1');
    await cards.setFace('card-1', PNG_1X1, 'image/png');
    const sha = BlobStore.sha256(PNG_1X1);
    assert.equal(faceBlobs.has(sha), true);

    cards.deleteFace('card-1');
    assert.equal(faceBlobs.has(sha), true, 'blob 必须还在');
  }),
);

test(
  '超过 250KB：抛 FACE_TOO_LARGE（413）',
  withService(async ({ cards, insertCard }) => {
    insertCard('card-1');
    const huge = Buffer.alloc(FACE_MAX_BYTES + 1, 0x89);
    await assert.rejects(
      () => cards.setFace('card-1', huge, 'image/png'),
      (error) => {
        assert.equal(error.code, 'FACE_TOO_LARGE');
        assert.equal(error.status, 413);
        return true;
      },
    );
  }),
);

/*
 * 边界：**恰好 250KB 必须通过**。
 *
 * 只测"超一个字节被拒"是不够的：把判据写成 `<` 而不是 `<=` 的实现
 * 同样能让上一条通过，但会把所有"刚好压到 250KB"的图全部拒掉 ——
 * 而客户端的压缩管线正是奔着这个尺寸去的，它撞线的概率不低。
 */
test(
  '恰好 250KB：必须通过（判据是 <=，不是 <）',
  withService(async ({ cards, insertCard }) => {
    insertCard('card-1');
    const exact = Buffer.alloc(FACE_MAX_BYTES, 0x89);
    const result = await cards.setFace('card-1', exact, 'image/webp');
    assert.equal(result.changed, true);
    assert.equal(result.face.size, FACE_MAX_BYTES);
  }),
);

test(
  '红线常量本身是 250KB（防止有人"顺手放宽"而测试跟着放宽）',
  () => {
    assert.equal(FACE_MAX_BYTES, 250 * 1024);
  },
);

test(
  '空字节：抛 FACE_EMPTY（400），与"没有卡面"分开',
  withService(async ({ cards, insertCard }) => {
    insertCard('card-1');
    await assert.rejects(
      () => cards.setFace('card-1', Buffer.alloc(0), 'image/png'),
      (error) => {
        assert.equal(error.code, 'FACE_EMPTY');
        assert.equal(error.status, 400);
        return true;
      },
    );
  }),
);

test(
  '不支持的图片类型：抛 FACE_MIME_UNSUPPORTED（415）',
  withService(async ({ cards, insertCard }) => {
    insertCard('card-1');
    await assert.rejects(
      () => cards.setFace('card-1', PNG_1X1, 'image/svg+xml'),
      (error) => {
        assert.equal(error.code, 'FACE_MIME_UNSUPPORTED');
        assert.equal(error.status, 415);
        return true;
      },
    );
  }),
);

test(
  '不存在的卡：setFace / getFace / deleteFace 都 404',
  withService(async ({ cards }) => {
    for (const op of ['set', 'get', 'delete']) {
      if (op === 'set') {
        await assert.rejects(() => cards.setFace('nope', PNG_1X1, 'image/png'), (e) => e.status === 404);
      } else if (op === 'get') {
        assert.throws(() => cards.getFace('nope'), (e) => e.status === 404);
      } else {
        assert.throws(() => cards.deleteFace('nope'), (e) => e.status === 404);
      }
    }
  }),
);

test('MIME 规范化：jpg 别名成 jpeg，参数被剥掉，大小写无关', () => {
  assert.equal(normalizeFaceMime('image/jpg'), 'image/jpeg');
  assert.equal(normalizeFaceMime('IMAGE/PNG'), 'image/png');
  assert.equal(normalizeFaceMime('image/jpeg; charset=binary'), 'image/jpeg');
  assert.equal(normalizeFaceMime('image/gif'), null);
  assert.equal(normalizeFaceMime(''), null);
  assert.equal(normalizeFaceMime('  image/webp  '), 'image/webp');
});

test(
  '卡面摘要进 DTO：summary().face 为 null 时表示"没有卡面"',
  withService(async ({ db, cards, insertCard }) => {
    insertCard('card-1');
    assert.equal(cards.summary(db.getCard('card-1')).face, null, '没有卡面时 face 必须是 null');

    await cards.setFace('card-1', PNG_1X1, 'image/png');
    const face = cards.summary(db.getCard('card-1')).face;
    assert.notEqual(face, null);
    assert.equal(face.sha256, BlobStore.sha256(PNG_1X1));
    assert.equal(face.size, PNG_1X1.length);
    assert.equal(face.mime, 'image/png');
  }),
);
