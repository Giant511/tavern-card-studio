/**
 * 仓库卡面压缩决策（v0.1.7 增补二）—— `planStoreFace` 的单元测试。
 *
 * ## 为什么用"假编码器"而不是真图
 *
 * 决策里最容易错的是**搜索过程**：二分有没有收敛到最高可行质量、
 * 阶梯会不会跳档、会不会在同一个尺寸上重复编码。这些跟像素内容无关，
 * 用一个"查表返回字节数"的假编码器就能穷举，还能精确构造边界。
 *
 * 真图只能验"这张图压出来多大"，验不出"搜索策略对不对" ——
 * 而后者一旦错了，表现是"明明能进 250KB 却被拒"或"用了 q90 而不是 q94"，
 * 用户完全看不出来。
 *
 * ## 判据的独立性
 *
 * 每个用例都断言**调用序列**（编了几次、每次什么质量/尺寸），
 * 不只是断言最终结论。只断言结论的话，"把所有质量都试一遍最后取最小的"
 * 这种笨实现也能通过，而它会让用户多等好几倍。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planStoreFace } from '../client/src/export/face-pipeline.ts';
import {
  STORE_FACE_MAX_BYTES,
  STORE_RESIZE_LADDER,
  WEBP_QUALITY_FLOOR,
  WEBP_QUALITY_START,
} from '../client/src/export/face-spec.ts';

const LIMIT = STORE_FACE_MAX_BYTES;

/**
 * 跑一遍管线，编码结果由 `sizeOf(attempt)` 决定。
 * 返回最终结论 + 调用序列（用来断言"搜索过程"而不仅是结论）。
 */
function run(input, sizeOf) {
  const calls = [];
  const plan = planStoreFace(input);
  let step = plan.next(0);
  let guard = 0;
  while (!step.done) {
    const attempt = step.value;
    calls.push(attempt);
    guard += 1;
    assert.ok(guard <= 32, '编码次数超过 32 —— 搜索没有收敛（死循环）');
    step = plan.next(sizeOf(attempt));
  }
  return { outcome: step.value, calls };
}

const PHOTO = { originalIsPng: false, originalBytes: 4 * 1024 * 1024, width: 4000, height: 3000 };

/* ───────────── 平涂例外 ───────────── */

test('平涂例外：PNG 原图已达标 → 一个字节都不编，直接保留', () => {
  const { outcome, calls } = run(
    { originalIsPng: true, originalBytes: 120 * 1024, width: 800, height: 800 },
    () => {
      throw new Error('这条路径不该发生任何编码');
    },
  );
  assert.equal(outcome.kind, 'keep-original');
  assert.equal(calls.length, 0);
});

test('平涂例外只认"是 PNG 且够小"：PNG 但超限 → 照样走 WebP', () => {
  const { outcome, calls } = run(
    { originalIsPng: true, originalBytes: LIMIT + 1, width: 1200, height: 1200 },
    () => 200 * 1024,
  );
  assert.equal(outcome.kind, 'accepted');
  assert.equal(calls[0].format, 'webp');
});

test('非 PNG（JPG/WebP）即使很小也不走保留原图 —— 它进不了 ST 的 PNG 容器', () => {
  const { outcome, calls } = run(
    { originalIsPng: false, originalBytes: 50 * 1024, width: 600, height: 600 },
    () => 40 * 1024,
  );
  assert.equal(outcome.kind, 'accepted');
  assert.equal(calls[0].format, 'webp');
});

/* ───────────── 起点与阶梯 ───────────── */

test('q95 一次过 → 只用 q95、不缩放、只编 1 次', () => {
  const { outcome, calls } = run(PHOTO, () => 200 * 1024);
  assert.equal(outcome.kind, 'accepted');
  assert.equal(outcome.attempt.quality, WEBP_QUALITY_START);
  assert.equal(outcome.attempt.maxLongEdge, null);
  assert.equal(outcome.downscaled, false);
  assert.equal(calls.length, 1);
});

test('长边 800 的图：不试 1600/1200/900（那三档等于同一张图编三次）', () => {
  const { calls, outcome } = run(
    { originalIsPng: false, originalBytes: 900 * 1024, width: 800, height: 600 },
    // 所有质量都超限，逼它走完整个候选列表
    () => LIMIT + 1,
  );
  assert.equal(outcome.kind, 'rejected');
  const sizes = [...new Set(calls.map((c) => c.maxLongEdge))];
  assert.deepEqual(sizes, [null], `不该出现比原图大的档，实际试过：${JSON.stringify(sizes)}`);
});

test('阶梯每档都试过一次且顺序是从大到小', () => {
  const { calls, outcome } = run(PHOTO, () => LIMIT + 1);
  assert.equal(outcome.kind, 'rejected');
  const sizes = [...new Set(calls.map((c) => c.maxLongEdge))];
  assert.deepEqual(sizes, [null, ...STORE_RESIZE_LADDER]);
});

/* ───────────── 二分 ───────────── */

test('q95 超、q90 过 → 二分找到**最高可行质量**（不是直接退到 q90）', () => {
  /*
   * 构造一张"质量每降 1，字节少 10KB"的图：
   *   q95=300K(超) q94=240K q93=230K q92=220K q91=210K q90=200K
   * 正确答案是 q94 —— 它是最高的可行质量，比 q90 多留 4 档。
   */
  const table = {
    95: 300 * 1024,
    94: 240 * 1024,
    93: 230 * 1024,
    92: 220 * 1024,
    91: 210 * 1024,
    90: 200 * 1024,
  };
  const { outcome, calls } = run(PHOTO, (a) => table[a.quality] ?? LIMIT + 1);

  assert.equal(outcome.kind, 'accepted');
  assert.equal(outcome.attempt.quality, 94, '二分应停在 94，而不是退到 90');
  // 顺序必须是 q95 → q90 → 二分
  assert.deepEqual(
    calls.map((c) => c.quality),
    [95, 90, 92, 93, 94],
    '搜索顺序不对（应为 起点 95 → 下限 90 → 二分 92/93/94）',
  );
});

test('二分给出的质量，其字节数确实不超限（结论与证据自洽）', () => {
  const sizeOf = (a) => (a.quality >= 93 ? LIMIT + 1000 : 200 * 1024);
  const { outcome } = run(PHOTO, sizeOf);
  assert.equal(outcome.kind, 'accepted');
  // q93 超、q92 过 ⇒ 应停在 92
  assert.equal(outcome.attempt.quality, 92);
  assert.ok(sizeOf(outcome.attempt) <= LIMIT, '接受的质量必须自己也能过线');
});

test('每个尺寸最多编 5 次（q95 + q90 + 二分 3 次），不会退化成线性扫描', () => {
  const { calls } = run(PHOTO, (a) => (a.quality === 90 ? 200 * 1024 : LIMIT + 1));
  const perSize = new Map();
  for (const call of calls) {
    const key = String(call.maxLongEdge);
    perSize.set(key, (perSize.get(key) ?? 0) + 1);
  }
  for (const [key, count] of perSize) {
    assert.ok(count <= 5, `尺寸 ${key} 编了 ${String(count)} 次，二分没收住`);
  }
});

/* ───────────── 降尺寸 ───────────── */

test('原尺寸不行 → 降到 1600 并从头用 q95 试', () => {
  const sizeOf = (a) => {
    if (a.maxLongEdge === null) return LIMIT + 1; // 原尺寸怎么都超
    if (a.maxLongEdge === 1600) return 200 * 1024; // 1600 一档就够
    return LIMIT + 1;
  };
  const { outcome, calls } = run(PHOTO, sizeOf);
  assert.equal(outcome.kind, 'accepted');
  assert.equal(outcome.attempt.maxLongEdge, 1600);
  assert.equal(outcome.attempt.quality, WEBP_QUALITY_START, '换尺寸后要从 q95 重新开始');
  assert.equal(outcome.downscaled, true);
  // 原尺寸试满（95、90），然后 1600 的 q95
  assert.deepEqual(
    calls.map((c) => `${String(c.maxLongEdge)}:${String(c.quality)}`),
    ['null:95', 'null:90', '1600:95'],
  );
});

test('一直降到 900 才成功 → downscaled 为 true 且尺寸是 900', () => {
  const sizeOf = (a) => (a.maxLongEdge === 900 ? 240 * 1024 : LIMIT + 1);
  const { outcome } = run(PHOTO, sizeOf);
  assert.equal(outcome.kind, 'accepted');
  assert.equal(outcome.attempt.maxLongEdge, 900);
});

test('900px + q90 仍超 → 拒绝，文案让人"换一张更简洁的"而不是报技术错误', () => {
  const { outcome, calls } = run(PHOTO, () => LIMIT + 1);
  assert.equal(outcome.kind, 'rejected');
  assert.match(outcome.reason, /换一张更简洁/);
  // 拒绝前必须把最后一档的 q90 也试过 —— 否则是"提前放弃"
  const last = calls[calls.length - 1];
  assert.equal(last.maxLongEdge, STORE_RESIZE_LADDER[STORE_RESIZE_LADDER.length - 1]);
  assert.equal(last.quality, WEBP_QUALITY_FLOOR);
});

test('拒绝文案里带上了"压到多少仍超限"的证据', () => {
  const { outcome } = run(PHOTO, () => LIMIT + 1);
  assert.match(outcome.reason, /900px/);
  assert.match(outcome.reason, /q90/);
});

/* ───────────── 不放大 ───────────── */

test('原图 4000px：阶梯会真的缩放（目标都小于原图长边）', () => {
  const { calls } = run(PHOTO, () => LIMIT + 1);
  const downs = calls.filter((c) => c.maxLongEdge !== null);
  assert.ok(downs.length > 0);
  for (const call of downs) {
    assert.ok(
      call.maxLongEdge < 4000,
      `缩放目标 ${String(call.maxLongEdge)} 不小于原图长边，等于没缩`,
    );
  }
});

test('恰好等于阶梯档位的原图不试那一档（<= 而非 <）', () => {
  const { calls } = run(
    { originalIsPng: false, originalBytes: 900 * 1024, width: 1200, height: 1200 },
    () => LIMIT + 1,
  );
  const sizes = [...new Set(calls.map((c) => c.maxLongEdge))];
  assert.deepEqual(sizes, [null, 900], '1200 与起始 1200 同尺寸，不该编两次');
});
