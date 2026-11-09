/**
 * 语音条宽度映射（v0.1.7 / T15.6，2026-10-30 用户要求）。
 *
 * ## 需求原文
 *
 * > 这个音频限制长度，最长不要超过屏幕宽度的一半
 *
 * 也就是**上限**是硬约束，但短语音不该也占满那个宽度 ——
 * 一句"嗯"撑出半屏宽的条，视觉上很怪，而 QQ 那种按时长递增的做法
 * 恰好让"短话短条、长话长条"，一眼能看出长短。
 *
 * ## 为什么抽成纯函数
 *
 * 「按时长算宽度」看着简单，但有几个必须定的边界：
 *   · 极短录音（< 0.5 秒）给多宽？太窄点不中，太宽失真；
 *   · 超过某个时长后就不该再涨（否则 30 秒能顶满整屏）；
 *   · 屏幕窄时半屏宽也随之变小，不能写死像素。
 *
 * 这些都是可测的算术，不该埋在 CSS 或 DOM 里靠目测。
 */

/**
 * 语音条最小宽度（px）。
 *
 * 为什么是 64：一条 0.3 秒的"嗯"如果只有 20px 宽，看起来像渲染错误；
 * 64px 足以放下「▶ 3 根小柱」，同时明显短于正常语音条。
 */
export const VOICE_BAR_MIN_PX = 64;

/**
 * 宽度上限占可用宽度的比例 = 0.5（屏幕宽度的一半，需求原文）。
 */
export const VOICE_BAR_MAX_RATIO = 0.5;

/**
 * 达到上限宽度的时长（毫秒）。
 *
 * 8 秒：正常一句话大约 3–6 秒，8 秒后已经是长段落 ——
 * 再往后加宽不再提供"多长"的信息（用户听不出来 12 秒和 20 秒的差别），
 * 只会白占屏幕。
 */
export const VOICE_BAR_FULL_AT_MS = 8000;

/**
 * 按时长算语音条宽度。
 *
 * @param durationMs 录音时长（毫秒）。非法值（NaN/负数）按 0 处理
 * @param availableWidthPx 可用宽度（通常是输入区或消息列表的内容宽度）
 * @returns 像素宽度，落在 `[min(minPx, halfWidth), halfWidth]` 之间
 *
 * 注意：`availableWidthPx` 很小时（比如 100），半屏 = 50 < minPx = 64。
 * 这种极端情况取 **halfWidth** 而不是 minPx —— 需求明确说"不超过屏宽一半"，
 * 上限优先于下限。否则在极窄屏上会违反需求。
 */
export function voiceBarWidth(
  durationMs: number,
  availableWidthPx: number,
  options: { minPx?: number; maxRatio?: number; fullAtMs?: number } = {},
): number {
  const minPx = options.minPx ?? VOICE_BAR_MIN_PX;
  const maxRatio = options.maxRatio ?? VOICE_BAR_MAX_RATIO;
  const fullAtMs = options.fullAtMs ?? VOICE_BAR_FULL_AT_MS;

  const available = Number.isFinite(availableWidthPx) ? Math.max(0, availableWidthPx) : 0;
  const halfWidth = available * maxRatio;
  if (halfWidth <= 0) return 0;

  const ms = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;

  /*
   * 时长比例：0 → 0，fullAtMs 及以上 → 1。
   *
   * 用**开方曲线**而不是线性：线性会让 1 秒和 2 秒的条宽差一倍，
   * 而人的时长感知更接近对数 —— 短语音之间的差别应该更明显，
   * 长语音之间反而不必。sqrt 正好是"前段涨得快、后段趋平"。
   */
  const ratio = fullAtMs <= 0 ? 1 : Math.min(1, Math.sqrt(ms / fullAtMs));

  const width = minPx + (halfWidth - minPx) * ratio;

  // 上限优先：极窄屏时宁可窄于 minPx，也不许超过半屏
  return Math.min(halfWidth, Math.max(Math.min(minPx, halfWidth), width));
}

/**
 * 时长文案（如 `1"`）。
 *
 * QQ 用 `1"` 表示 1 秒。这里向上取整到整数秒并至少给 1 ——
 * 显示 `0"` 会让人以为没录上。
 */
export function voiceDurationLabel(durationMs: number): string {
  const ms = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  const seconds = Math.ceil(ms / 1000);
  return `${Math.max(1, seconds)}"`;
}

/**
 * 录音中的**时钟**显示：`0:01`、`0:59`、`1:02`（2026-11-02 用户给的布局图）。
 *
 * ## 与 `voiceDurationLabel()` 为什么不是同一个函数
 *
 * 两者服务于不同位置，语义也不同：
 *
 * | 用途 | 格式 | 为什么 |
 * |---|---|---|
 * | 消息气泡上的时长 | `5"` | 它是**结果**，"5 秒"读起来比 `0:05` 短，不占地方 |
 * | 录音中的计时 | `0:01` | 它是**进行中的时钟**，要能看出"还在走"，且与用户对表盘的直觉一致 |
 *
 * 合并成一个函数的话，要么气泡上出现 `0:05`（比现在啰嗦），
 * 要么录音计时显示 `1"`（看不出这是个时钟）。
 *
 * ## 为什么从 0 开始（而不是 `voiceDurationLabel` 的"最少 1"）
 *
 * 录音刚开始时真实值就是 0 秒。图片里也写着 `0:00` ——
 * 那一刻"已录 0 秒"是**准确**的，不该为了好看显示 1。
 */
export function formatRecordClock(durationMs: number): string {
  const ms = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}
