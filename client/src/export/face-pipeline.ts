/**
 * 仓库卡面资产的压缩决策（v0.1.7 增补二）。
 *
 * ## 为什么是生成器而不是一个"压到 250KB"的函数
 *
 * 压缩率和内容强相关：同样 q90，平涂插画可能 80KB，噪点照片可能 900KB。
 * 所以**不可能**在不真正编码一次的情况下知道结果。于是决策必须是
 * "试一次 → 看字节数 → 决定下一步"的循环。
 *
 * 把它写成生成器的好处：**决策逻辑是纯的、可穷举测试**，而真正的编码
 * （canvas / WebP）由调用方注入。测试里可以用一个假的编码器说
 * "这个质量出这么多字节"，从而把"二分有没有找对质量""阶梯有没有跳档"
 * 这些容易错的地方钉死，不用等一张真图。
 *
 * ## 搜索策略（严格按需求，别自己发挥）
 *
 *  1. **平涂例外**：原图就是 PNG 且已 ≤250KB → 直接保留 PNG（真无损）。
 *  2. 每个候选尺寸（原尺寸 → 1600 → 1200 → 900）内部：
 *     a. 先试 q95（起点，大多数图到这里就过）
 *     b. 不过则试 q90（下限）
 *     c. q90 过而 q95 不过 → 在 (q90, q95) 之间**二分**找最高可行质量
 *     d. q90 也不过 → 这个尺寸放弃，降一档
 *  3. 降到 900 且 q90 仍不过 → 拒绝，文案让人换图。
 *
 * 注意 2c：二分是为了"能用 q93 就不退回 q90"，不是为了提高成功率 ——
 * 质量是用户看得见的东西，能多留一分就多留一分。
 */

import {
  STORE_FACE_MAX_BYTES,
  STORE_RESIZE_LADDER,
  WEBP_QUALITY_FLOOR,
  WEBP_QUALITY_START,
  FACE_REJECT_HINT,
} from './face-spec.ts';

/** 一次编码尝试。`maxLongEdge: null` = 不缩放（保持原尺寸）。 */
export interface FaceAttempt {
  format: 'png' | 'webp';
  /** WebP 质量 0–100。PNG 无此概念，统一填 {@link WEBP_QUALITY_START} 以免多一种空值。 */
  quality: number;
  /** 目标长边；null = 原尺寸 */
  maxLongEdge: number | null;
}

export type FacePipelineOutcome =
  /** 原图直接可用（平涂 PNG 已达标），一个字节都没动 */
  | { kind: 'keep-original'; reason: string }
  /** 用某次尝试的结果 */
  | { kind: 'accepted'; attempt: FaceAttempt; reason: string; downscaled: boolean }
  /** 压不下去 */
  | { kind: 'rejected'; reason: string };

export interface StoreFaceInput {
  /** 原图是不是 PNG（只有 PNG 才可能走"保留原图"那条路） */
  originalIsPng: boolean;
  /** 原图字节数 */
  originalBytes: number;
  width: number;
  height: number;
}

/**
 * 依次产出编码尝试；每次 `next(上次编码的真实字节数)` 推进。
 *
 * 用法：
 * ```ts
 * const plan = planStoreFace({ ... });
 * let step = plan.next(0);           // 第一次的 size 入参被忽略
 * while (!step.done) {
 *   const size = await encode(step.value);   // 真编码
 *   step = plan.next(size);
 * }
 * step.value;                        // FacePipelineOutcome
 * ```
 */
export function* planStoreFace(input: StoreFaceInput): Generator<FaceAttempt, FacePipelineOutcome, number> {
  const { originalIsPng, originalBytes, width, height } = input;

  // ① 平涂例外：PNG 且已达标 ⇒ 保留原图，真无损。
  //    判据只用"是 PNG + 够小"，不猜"是不是平涂"—— 小本身就是平涂的证据。
  if (originalIsPng && originalBytes > 0 && originalBytes <= STORE_FACE_MAX_BYTES) {
    return {
      kind: 'keep-original',
      reason: `原图是 PNG 且只有 ${String(Math.round(originalBytes / 1024))} KB，直接保留原图（无损）`,
    };
  }

  const originalLongEdge = Math.max(width, height);

  /*
   * 候选尺寸：原尺寸（null）在前，然后是从大到小、且**真的比原图小**的阶梯档。
   *
   * 过滤掉比原图大的档很重要：一张 800px 的图如果把 1600/1200/900 都试一遍，
   * 那三次是**同一张图重复编码三次**（不会放大），纯浪费用户等待时间，
   * 还会让最后一次"900px 仍超限"的结论建立在三次同样的结果上。
   */
  const ladder = STORE_RESIZE_LADDER.filter((edge) => edge < originalLongEdge);
  const sizes: (number | null)[] = [null, ...ladder];

  for (const maxLongEdge of sizes) {
    // ②a 先试 q95
    let size = yield { format: 'webp', quality: WEBP_QUALITY_START, maxLongEdge };
    if (size <= STORE_FACE_MAX_BYTES) {
      return {
        kind: 'accepted',
        attempt: { format: 'webp', quality: WEBP_QUALITY_START, maxLongEdge },
        reason: describe(maxLongEdge, WEBP_QUALITY_START),
        downscaled: maxLongEdge !== null,
      };
    }

    // ②b 再试下限 q90
    size = yield { format: 'webp', quality: WEBP_QUALITY_FLOOR, maxLongEdge };
    if (size > STORE_FACE_MAX_BYTES) {
      continue; // ②d 这个尺寸没救，降一档
    }

    /*
     * ②c q90 过了、q95 没过 ⇒ 二分找最高的可行质量。
     *
     * 区间是**开区间**的写法：lo 已知可行、hi 已知不可行，
     * 收敛到 hi - lo === 1 时 lo 就是答案。
     * 最后一次 yield 之后如果还不行（理论上不会，lo 从 q90 起就是可行的），
     * 落到下面的兜底 return —— 宁可交出 q90 也不要空手而归。
     */
    let lo = WEBP_QUALITY_FLOOR;
    let hi = WEBP_QUALITY_START;
    let bestSize = size;

    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const midSize = yield { format: 'webp', quality: mid, maxLongEdge };
      if (midSize <= STORE_FACE_MAX_BYTES) {
        lo = mid;
        bestSize = midSize;
      } else {
        hi = mid;
      }
    }

    return {
      kind: 'accepted',
      attempt: { format: 'webp', quality: lo, maxLongEdge },
      reason: describe(maxLongEdge, lo),
      downscaled: maxLongEdge !== null,
    };
  }

  // ③ 所有尺寸 + q90 都不行
  return {
    kind: 'rejected',
    reason: `${FACE_REJECT_HINT}（已经压到 ${String(STORE_RESIZE_LADDER[STORE_RESIZE_LADDER.length - 1] ?? 900)}px / q${String(WEBP_QUALITY_FLOOR)} 仍超过 250KB）`,
  };
}

function describe(maxLongEdge: number | null, quality: number): string {
  const sizePart = maxLongEdge === null ? '原尺寸' : `长边 ${String(maxLongEdge)}px`;
  return `${sizePart} · WebP q${String(quality)}`;
}
