/**
 * 卡面图库与记忆的纯逻辑（v0.1.4 / T12.5，决策 #166–#168）。
 *
 * 这一层的错都属于"看起来对、实际串了"：
 *   · 记忆值解码认错 → 下次导出预选到别的图；
 *   · 候选排序把原图排到默认卡面之前 → 每张新卡都拿上一张的封面；
 *   · 同名不同大小写在 Windows 上是同一个文件，不去重会出现两张一样的缩略图。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FACE_MAX_EDGE,
  decodeFaceChoice,
  encodeFaceChoice,
  faceLibraryDir,
  faceScale,
  listFaceCandidates,
  needsPngConversion,
  preselectFace,
  sameChoice,
  scaledSize,
} from '../client/src/export/face-library.ts';

// ── 图库路径 ───────────────────────────────────────────────

test('图库目录跟随卡片目录，并按目录的路径风格拼分隔符', () => {
  assert.equal(faceLibraryDir('C:\\Users\\me\\Documents\\cards'), 'C:\\Users\\me\\Documents\\cards\\card-faces');
  assert.equal(faceLibraryDir('/home/me/cards'), '/home/me/cards/card-faces');
  // 结尾多余分隔符要吃掉，否则拼出 dir\\card-faces
  assert.equal(faceLibraryDir('C:\\cards\\'), 'C:\\cards\\card-faces');
});

// ── 记忆值编解码 ───────────────────────────────────────────

test('记忆值编解码往返一致', () => {
  const cases = [
    { kind: 'default' },
    { kind: 'source' },
    { kind: 'library', name: '封面.png' },
  ];
  for (const choice of cases) {
    const encoded = encodeFaceChoice(choice);
    assert.notEqual(encoded, null);
    assert.deepEqual(decodeFaceChoice(encoded), choice);
  }
});

test('浏览选择不记忆（一次性动作）', () => {
  assert.equal(encodeFaceChoice({ kind: 'browse', path: 'D:\\tmp\\x.png' }), null);
});

test('图库文件名恰好叫 default 时不会被误认成"默认卡面"', () => {
  // 这就是为什么要有 lib: 前缀
  const encoded = encodeFaceChoice({ kind: 'library', name: 'default' });
  assert.equal(encoded, 'lib:default');
  assert.deepEqual(decodeFaceChoice(encoded), { kind: 'library', name: 'default' });
  assert.deepEqual(decodeFaceChoice('default'), { kind: 'default' });
});

test('认不出的记忆值一律当没记过（不猜）', () => {
  for (const raw of [null, undefined, '', 'lib:', 'unknown', 'LIB:x', 42]) {
    assert.equal(decodeFaceChoice(raw), null, `${String(raw)} 应当被忽略`);
  }
});

// ── 候选列表 ───────────────────────────────────────────────

test('候选顺序：默认卡面 → 原图 → 图库（按文件名）', () => {
  const list = listFaceCandidates(['b.png', 'a.png'], true);
  assert.deepEqual(
    list.map((item) => item.choice.kind),
    ['default', 'source', 'library', 'library'],
  );
  assert.deepEqual(
    list.filter((item) => item.choice.kind === 'library').map((item) => item.label),
    ['a.png', 'b.png'],
  );
});

test('没有原图时不渲染"原图"这一项（不是禁用，是不出现）', () => {
  const list = listFaceCandidates(['a.png'], false);
  assert.equal(
    list.some((item) => item.choice.kind === 'source'),
    false,
  );
});

test('非图片扩展名被过滤，同名不同大小写去重', () => {
  const list = listFaceCandidates(['a.png', 'A.PNG', 'notes.txt', 'b.jpg'], true);
  const libraries = list.filter((item) => item.choice.kind === 'library');
  assert.equal(libraries.length, 2, 'a.png 与 A.PNG 在 Windows 上是一个文件');
  assert.ok(list.every((item) => item.choice.kind !== 'library' || !item.label.endsWith('.txt')));
});

// ── 预选（决策 D4）─────────────────────────────────────────

test('预选：记过的可用就用它；不可用回落"有原图用原图"', () => {
  const withSource = listFaceCandidates(['a.png'], true);

  // 记过 a.png → 用它
  const remembered = preselectFace('lib:a.png', withSource);
  assert.deepEqual(remembered, { kind: 'library', name: 'a.png' });

  // 记过 b.png（已被删）→ 回落到原图
  const stale = preselectFace('lib:b.png', withSource);
  assert.deepEqual(stale, { kind: 'source' });

  // 没有原图 → 回落到默认
  const noSource = listFaceCandidates(['a.png'], false);
  assert.deepEqual(preselectFace(null, noSource), { kind: 'default' });
});

test('预选：记忆是 default 就真的是 default（不被"有原图"覆盖）', () => {
  // 用户上次明确选了默认卡面，说明他不想要原图 —— 这是明确的偏好
  const list = listFaceCandidates([], true);
  assert.deepEqual(preselectFace('default', list), { kind: 'default' });
});

// ── 缩放（需求 F4.3）───────────────────────────────────────

test('长边不超过 4096 不缩放', () => {
  assert.equal(faceScale(768, 1024), 1);
  assert.deepEqual(scaledSize(768, 1024), { width: 768, height: 1024, scaled: false });
  assert.equal(faceScale(FACE_MAX_EDGE, 100), 1);
});

test('长边超过 4096 等比压缩，比例按长边算', () => {
  const size = scaledSize(12000, 8000);
  assert.equal(size.scaled, true);
  assert.equal(size.width, 4096);
  assert.equal(Math.round(size.height), 2731); // 8000 * 4096/12000
  // 竖图同理
  const tall = scaledSize(2000, 8000);
  assert.equal(tall.height, 4096);
  assert.equal(tall.width, 1024);
});

test('极端细长的图不会缩成 0 像素', () => {
  const size = scaledSize(10, 100000);
  assert.equal(size.height, FACE_MAX_EDGE);
  assert.ok(size.width >= 1, '短边至少 1px');
});

// ── 格式判定 ───────────────────────────────────────────────

test('只有 .png 免转码；jpg/jpeg/webp 都要转', () => {
  assert.equal(needsPngConversion('a.png'), false);
  assert.equal(needsPngConversion('a.PNG'), false);
  assert.equal(needsPngConversion('a.jpg'), true);
  assert.equal(needsPngConversion('a.jpeg'), true);
  assert.equal(needsPngConversion('a.webp'), true);
});

test('sameChoice 对同名库图与不同路径的浏览项判得准', () => {
  assert.equal(sameChoice({ kind: 'default' }, { kind: 'default' }), true);
  assert.equal(sameChoice({ kind: 'default' }, { kind: 'source' }), false);
  assert.equal(
    sameChoice({ kind: 'library', name: 'a.png' }, { kind: 'library', name: 'a.png' }),
    true,
  );
  assert.equal(
    sameChoice({ kind: 'library', name: 'a.png' }, { kind: 'library', name: 'b.png' }),
    false,
  );
  assert.equal(
    sameChoice({ kind: 'browse', path: 'D:\\a.png' }, { kind: 'browse', path: 'D:\\b.png' }),
    false,
  );
});
