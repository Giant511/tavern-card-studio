/**
 * 转场缓动必须在**多种刷新率下都不难看**（2026-11-05）。
 *
 * ## 用户的要求
 *
 * > 我这里提一嘴，你做的动画应该要兼容别的手机系统或者设备，
 * > 不能就只用我连到电脑上的这个设备为基准
 *
 * ## 这条判据守什么
 *
 * 第一版按 **260ms ÷ 60fps = 16 帧** 挑曲线 —— 那个前提是一台设备的属性。
 * 同一段时长换台机器帧数就变：
 *
 * ```text
 *   120Hz  31 帧      60Hz  16 帧      30fps  8 帧      20fps  5 帧
 * ```
 *
 * 在 60Hz 上最优的曲线，到 20fps 可能**一帧跨掉四分之三** —— 用户看到的就是"跳"。
 *
 * 所以这里**真算**：把 CSS 里用的 `cubic-bezier` 解出来，在
 * 20/30/60/90/120fps 五档下各采样一遍每帧位移，用「最差那一档」判定。
 *
 * ```text
 *   cv         单帧位移的标准差 / 均值     ≤ 0.6
 *   最差首帧    任何一档的第一帧跨度        ≤ 0.40
 * ```
 *
 * 现状（换算后的 `0.35, 0.5, 0.65, 0.9`）：最差 cv 0.39、最差首帧 27% ✅
 * 原来的 `0.16, 1, 0.3, 1`：最差 cv 1.57、最差首帧 74% ❌
 *
 * 这条判据的价值：以后有人"为了手感"把曲线调陡，只要它在低帧率下崩，
 * 这里就红 —— 而不是等用户在别的手机上看到卡顿。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const tokens = readFileSync(
  new URL('../client/src/chat/nebula-tokens.css', import.meta.url),
  'utf8',
);

/** 从 CSS 里取出 `--nb-ease-nav` 的 cubic-bezier 四个参数 */
function navEasing() {
  const match = /--nb-ease-nav:\s*cubic-bezier\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/.exec(
    tokens,
  );
  assert.ok(match !== null, '必须有 --nb-ease-nav: cubic-bezier(a, b, c, d)');
  return match.slice(1, 5).map(Number);
}

/** 解 cubic-bezier：给时间进度 x，求位移进度 y */
function bezierY(x1, y1, x2, y2, x) {
  const bx = (u) => 3 * (1 - u) ** 2 * u * x1 + 3 * (1 - u) * u ** 2 * x2 + u ** 3;
  const by = (u) => 3 * (1 - u) ** 2 * u * y1 + 3 * (1 - u) * u ** 2 * y2 + u ** 3;

  let u = x;
  for (let i = 0; i < 40; i += 1) {
    const diff = bx(u) - x;
    if (Math.abs(diff) < 1e-7) break;
    const d = 3 * (1 - u) ** 2 * x1 + 6 * (1 - u) * u * (x2 - x1) + 3 * u ** 2 * (1 - x2);
    if (Math.abs(d) < 1e-9) break;
    u -= diff / d;
    u = Math.min(1, Math.max(0, u));
  }
  return by(u);
}

/** 时长必须与 CSS 里的一致；这里读出来，避免判据和代码各写一份 */
function navDurationMs() {
  const match = /--nb-dur-nav:\s*([\d.]+)ms/.exec(tokens);
  assert.ok(match !== null, '必须有 --nb-dur-nav: <n>ms');
  return Number(match[1]);
}

/** 按某个帧率采样，返回 { cv, first, maxStep, frames } */
function profileAt(fps) {
  const [x1, y1, x2, y2] = navEasing();
  const duration = navDurationMs();
  const frameMs = 1000 / fps;
  const frames = Math.max(2, Math.round(duration / frameMs));

  const steps = [];
  let prev = 0;
  for (let i = 1; i <= frames; i += 1) {
    const t = Math.min(1, (i * frameMs) / duration);
    const y = bezierY(x1, y1, x2, y2, t);
    steps.push(y - prev);
    prev = y;
  }
  steps[steps.length - 1] += 1 - prev;

  const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
  const sd = Math.sqrt(steps.reduce((acc, s) => acc + (s - mean) ** 2, 0) / steps.length);
  return {
    fps,
    frames,
    cv: mean > 0 ? sd / mean : 99,
    first: steps[0],
    maxStep: Math.max(...steps),
  };
}

const FPS_LIST = [20, 30, 60, 90, 120];

test('★★★★★ 时长与缓动都在 token 里（不许散落在关键帧上）', () => {
  assert.match(tokens, /--nb-dur-nav:\s*\d+ms/, '要有时长 token');
  assert.match(tokens, /--nb-ease-nav:\s*cubic-bezier\(/, '要有缓动 token');
  const duration = navDurationMs();
  assert.ok(
    duration >= 180 && duration <= 400,
    `时长 ${String(duration)}ms 超出合理区间：太短在低帧率下只剩两三帧，太长显得拖`,
  );
});

test('★★★ 缓动单独一条，不与 ease-out 共用', () => {
  /*
   * `--nb-ease-out` 是"急速到位"（8% 时间走 83%），给单页淡入用没问题。
   * 整页横移的位移距离大 100 倍，同一条曲线就会"猛窜"。
   * 两件事共用一个 token，改了一个必然拖坏另一个。
   */
  const easeOut = /--nb-ease-out:\s*cubic-bezier\(\s*([\d.]+)/.exec(tokens);
  const nav = /--nb-ease-nav:\s*cubic-bezier\(\s*([\d.]+)/.exec(tokens);
  assert.ok(easeOut !== null && nav !== null, '两条都要在');
  assert.notEqual(easeOut[1], nav[1], '两条曲线不该是同一个值（用途不同）');
});

test('★★★ 每一档刷新率下，单帧位移都要匀（cv ≤ 0.6）', () => {
  for (const fps of FPS_LIST) {
    const one = profileAt(fps);
    assert.ok(
      one.cv <= 0.6,
      `${String(fps)}fps（${String(one.frames)} 帧）单帧位移太不匀：cv=${one.cv.toFixed(2)}。` +
        '这一档的用户会看到"猛一下然后停住"。',
    );
  }
});

test('★★★ 第一帧不许跨掉太多（任何一档都 ≤ 40%）', () => {
  /*
   * 第一帧的跨度决定"起手跟不跟手"。超过 40% 就是"一帧跳掉小半屏"，
   * 低帧率设备上尤其明显 —— 用户的原话是"卡顿"，实际是这一步跳太大。
   */
  for (const fps of FPS_LIST) {
    const one = profileAt(fps);
    assert.ok(
      one.first <= 0.4,
      `${String(fps)}fps 的第一帧就跨了 ${(one.first * 100).toFixed(0)}%（上限 40%）`,
    );
  }
});

test('★★★ 不能是"线性"也不能"中途倒退"', () => {
  /*
   * 两个极端都不行：
   *
   * ```text
   *   完全线性   没有"到位"的手感，像被硬拖过去
   *   中途倒退   位移忽大忽小，肉眼看就是抖
   * ```
   *
   * 判据：60fps 下每一帧的位移量必须**单调不增**（只能越来越小）。
   */
  const [x1, y1, x2, y2] = navEasing();
  const duration = navDurationMs();
  const frameMs = 1000 / 60;
  const frames = Math.round(duration / frameMs);

  const steps = [];
  let prev = 0;
  for (let i = 1; i <= frames; i += 1) {
    const t = Math.min(1, (i * frameMs) / duration);
    const y = bezierY(x1, y1, x2, y2, t);
    steps.push(y - prev);
    prev = y;
  }

  for (let i = 1; i < steps.length; i += 1) {
    assert.ok(
      steps[i] <= steps[i - 1] + 1e-6,
      `第 ${String(i + 1)} 帧比上一帧快了（${(steps[i] * 100).toFixed(1)}% > ${(steps[i - 1] * 100).toFixed(1)}%），曲线有回弹`,
    );
  }

  /* 不能太接近线性：最后几帧必须明显比第一帧慢 */
  assert.ok(
    steps[steps.length - 1] < steps[0] * 0.5,
    '收尾太生硬（最后一帧和第一帧差不多快），等于没有缓动',
  );
});

test('★★★ 最低档刷新率下也要够帧数（否则曲线再匀也是"几格动画"）', () => {
  /*
   * 曲线匀不匀是一件事，**有没有足够的帧**是另一件。
   *
   * ```text
   *   260ms @ 60fps = 16 帧   够
   *   260ms @ 30fps =  8 帧   勉强
   *   260ms @ 20fps =  5 帧   底线
   *   260ms @ 15fps =  4 帧   不该再短了
   * ```
   *
   * 这条守的是"别把时长改得太短"：有人为了手感"更利落"把 `--nb-dur-nav`
   * 调到 150ms，在 60Hz 上看着还行，到 30fps 就只剩 2 帧 —— 等于没有动画。
   */
  const worst = profileAt(20);
  assert.ok(
    worst.frames >= 5,
    `20fps 下只有 ${String(worst.frames)} 帧（至少要 5 帧）。时长 ${String(navDurationMs())}ms 太短了。`,
  );
});

test('★★ 判据自身可信：已知的坏曲线必须被判红', () => {
  /*
   * 如果判据写得松，什么曲线都能过 —— 那它就只是装饰。
   * 这里拿原来那条（0.16, 1, 0.3, 1）反算一遍，确认它**过不了**上面那条 cv 判据。
   */
  const [x1, y1, x2, y2] = [0.16, 1, 0.3, 1];
  const duration = navDurationMs();
  const fps = 20;
  const frameMs = 1000 / fps;
  const frames = Math.round(duration / frameMs);
  const steps = [];
  let prev = 0;
  for (let i = 1; i <= frames; i += 1) {
    const t = Math.min(1, (i * frameMs) / duration);
    const y = bezierY(x1, y1, x2, y2, t);
    steps.push(y - prev);
    prev = y;
  }
  steps[steps.length - 1] += 1 - prev;

  const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
  const sd = Math.sqrt(steps.reduce((acc, s) => acc + (s - mean) ** 2, 0) / steps.length);
  const cv = sd / mean;

  assert.ok(
    cv > 0.6,
    `原来那条 0.16,1,0.3,1 在 20fps 下 cv=${cv.toFixed(2)}，本该被判红 —— ` +
      '如果它也能过，说明判据太松，守不住东西',
  );
});
