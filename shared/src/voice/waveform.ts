/**
 * 按住录音时的实时波形（v0.1.7 / T15.6 终版，进 v1）。
 *
 * 需求原文：
 *
 * ```text
 * 按住录音期间，浮层中央显示实时波形（Android 录音振幅驱动，
 * 渐变着色，120ms 刷新）；松手即停并定格一帧后进入发送/确认流。
 * ```
 *
 * ## 这一层只管"振幅 → 柱高"
 *
 * 不碰 canvas、不碰 `MediaRecorder`、不碰定时器。理由是这三样都不可测 ——
 * 而"波形有没有跟着声音动"恰恰是该被测的东西。
 * 所以把纯逻辑抽出来：**给一串假振幅，断言柱高真的变了**；
 * **调用冻结后再给振幅，断言柱高不再变**（松手停帧）。
 *
 * 渲染侧只需要：拿 `bars()` 的数组去画，颜色用 `--nb-grad-primary`（夜航设计册）。
 *
 * ## 两条会让波形"看起来不对"的细节
 *
 * 1. **线性映射看起来是死的**。`getMaxAmplitude()` 给的是 0..32767 的线性值，
 *    而人说话大部分时间落在 2000–8000 这个很窄的低段 —— 直接线性归一化，
 *    柱高会长期贴着底部，用户以为没在录。所以走对数曲线（见 `amplitudeToLevel`）。
 * 2. **静音不能真的画成 0**。留一条最小高度，否则波形断开、看起来像坏了。
 *    但也不能太大，否则"没声音"和"有声音"分不出来。
 */

/** Android `MediaRecorder.getMaxAmplitude()` 的量程上限 */
export const MAX_RAW_AMPLITUDE = 32767;

/** 柱子的最小可见高度（0..1）。静音时保留一条细线。 */
export const MIN_BAR_LEVEL = 0.06;

/** 默认柱数。32 根在 360dp 宽的手机上约每根 8dp（含间距），视觉密度合适。 */
export const DEFAULT_BAR_COUNT = 32;

/** 刷新间隔（ms）。需求写死 120ms —— 更快没必要（人眼看不出），更慢会顿。 */
export const WAVEFORM_REFRESH_MS = 120;

/**
 * 原始振幅 → 0..1 的可视等级（对数曲线）。
 *
 * 曲线是 `log10(1 + 9x)`：x=0→0，x=1→1，而 x=0.1（约 3277，正常说话的下限）
 * 会映射到 **0.279** —— 也就是**低声说话也能看到近三成高**，这是这条曲线存在的全部意义。
 * （这个数是实测值，不是估的：`amplitudeToLevel(3277) === 0.2788`。
 *   初版文档写过 0.41，那是凭感觉估的，测试当场把它抓出来了。）
 *
 * 负值 / NaN 一律当 0：`getMaxAmplitude()` 在某些机型上会返回负值或 -1
 * （录音还没真正开始时），直接进 `Math.log` 会得到 NaN，
 * 而 NaN 画到 canvas 上表现为"柱子全消失"，比波形不对更难查。
 */
export function amplitudeToLevel(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const linear = Math.min(raw, MAX_RAW_AMPLITUDE) / MAX_RAW_AMPLITUDE;
  const curved = Math.log10(1 + 9 * linear);
  return Math.max(0, Math.min(1, curved));
}

/** 波形状态。`bars` 是最旧的在前、最新的在后（左→右生长）。 */
export interface WaveformState {
  readonly bars: readonly number[];
  /** 松手后置 true：此后 `pushAmplitude` 不再改变任何柱子 */
  readonly frozen: boolean;
}

/**
 * 造一段空波形。
 *
 * 柱子填 `MIN_BAR_LEVEL` 而不是 0 —— 一上来就是"一条细线"，
 * 而不是"什么都没有"。后者在浮层刚升起的那一帧看起来像加载失败。
 */
export function createWaveform(barCount: number = DEFAULT_BAR_COUNT): WaveformState {
  const count = Math.max(1, Math.floor(barCount));
  return { bars: new Array<number>(count).fill(MIN_BAR_LEVEL), frozen: false };
}

/**
 * 推进一帧：把新振幅压入右端，最旧的从左端挤出。
 *
 * 冻结后**原样返回同一个对象**（不是副本）。用引用相等做判据，
 * 渲染侧可以用 `prev === next` 直接跳过重绘 —— 而这也顺带让
 * "松手后还在更新"这种 bug 变成可断言的事实。
 */
export function pushAmplitude(state: WaveformState, rawAmplitude: number): WaveformState {
  if (state.frozen) return state;
  const level = Math.max(MIN_BAR_LEVEL, amplitudeToLevel(rawAmplitude));
  // 保留最后一根作为"峰值保持"参照：新值不低于上一根的 40% 时直接用新值，
  // 否则取两者中较高的那个 —— 否则手指微动时波形会疯狂抖动。
  const previous = state.bars[state.bars.length - 1] ?? MIN_BAR_LEVEL;
  const smoothed = level >= previous * 0.4 ? level : previous * 0.4;
  const next = state.bars.slice(1).concat(Math.min(1, smoothed));
  return { bars: next, frozen: false };
}

/** 冻结（松手）。已冻结时幂等返回原对象。 */
export function freezeWaveform(state: WaveformState): WaveformState {
  if (state.frozen) return state;
  return { bars: state.bars.slice(), frozen: true };
}

/**
 * 取当前柱高（0..1），已应用最小高度。
 *
 * 单独给出而不是让渲染侧直接用 `state.bars`：最小高度的钳制必须只有一处，
 * 否则"某处忘了 clamp"就会出现一根 0 高度的柱子，看起来是断的。
 */
export function barHeights(state: WaveformState): number[] {
  return state.bars.map((level) => Math.max(MIN_BAR_LEVEL, Math.min(1, level)));
}

/** 波形里是否已经有"明显在动"的柱子（用于判断"录到声音了吗"） */
export function hasVoiceActivity(state: WaveformState, threshold = 0.2): boolean {
  return state.bars.some((level) => level >= threshold);
}
