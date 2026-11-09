/**
 * 滑动选模式的手势判定（v0.1.7 / T15.6 终版）。
 *
 * ## 交互长什么样
 *
 * ```text
 *                ┌──────────┬──────────────┬──────────────┐
 *                │ 🗣 说话  │ 💭 内心/动作  │ 💬 消息      │   ← chips 浮层
 *                └──────────┴──────────────┴──────────────┘
 *                          ↑ 手指滑到这里，松手即按该模式发送
 *                     ●  ← 麦克风（按住起点）
 * ```
 *
 * - 按住麦克风 → 三个 chip 浮起，默认焦点在「说话」；
 * - 手指滑向目标 chip → 那个 chip 高亮、波形变色；
 * - 松手 → 按当前高亮的模式发送；
 * - **不滑动直接松手 = 说话**（最常用路径零额外动作）。
 *
 * ## 为什么判据是"落在 chip 的矩形里"，不是"滑动方向"
 *
 * 方向判定（往上滑=内心、往左滑=消息）看起来更"手势感"，但：
 *   · 三个模式对应用三个方向，方向之间没有自然的语义顺序（用户要记）；
 *   · 手指的方向角度抖动很大，45° 边界附近会**反复切换高亮**，看起来像卡了；
 *   · 而且方向判定无法表达"我不小心滑偏了，那就当说话"这个安全默认 ——
 *     落点判定天然有这种"没打中就回默认"的性质。
 *
 * ## 为什么命中区要比视觉大一圈
 *
 * 拇指按压的落点分布半径通常有 8–12mm。按视觉边框判定会让用户在
 * "差一点"的时候掉回「说话」—— 而他明明滑到了「消息」上，只是偏了两毫米。
 * 所以默认给 `hitSlop`，把每个 chip 的判定矩形向外扩。
 *
 * 决策 #303。
 */

import { DEFAULT_VOICE_MODE, type VoiceMode } from './types.js';

/** 屏幕坐标点 */
export interface Point {
  x: number;
  y: number;
}

/** 一个 chip 的布局矩形（单位与指针事件一致，通常为 CSS px） */
export interface ChipRect {
  mode: VoiceMode;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 默认命中扩展量（px）。按视觉边框外扩，弥补拇指落点误差。 */
export const DEFAULT_HIT_SLOP = 12;

function contains(rect: ChipRect, point: Point, slop: number): boolean {
  const left = rect.x - slop;
  const top = rect.y - slop;
  const right = rect.x + rect.width + slop;
  const bottom = rect.y + rect.height + slop;
  // 右/下边界用 `<`：相邻两个 chip 的扩区会重叠，用开区间让"边界上"
  // 只归属一个 chip，避免同一个点同时命中两个（那样高亮会闪）。
  return point.x >= left && point.x < right && point.y >= top && point.y < bottom;
}

/**
 * 命中测试：这个点落在哪个 chip 上。**没命中返回 null**。
 *
 * 返回 null 而不是直接回默认值，是为了让调用方能区分两件事：
 *   · 没滑（手指还在麦克风上）→ 不改变高亮，仍是上一次的模式；
 *   · 滑了但没打中 → 回落「说话」。
 * 两者对 UI 的影响不同（前者不该让高亮跳回说话），所以不能在底层合并。
 *
 * 多个 chip 扩区重叠时，取**中心点距离最近**的那个 —— 这是唯一不会
 * 在重叠带里随机跳的选择。
 */
export function hitTestVoiceChip(
  point: Point,
  chips: readonly ChipRect[],
  slop: number = DEFAULT_HIT_SLOP,
): VoiceMode | null {
  const hits = chips.filter((chip) => contains(chip, point, slop));
  if (hits.length === 0) return null;

  // 取中心点最近的那个。不写 `hits[0].mode` 的短路分支 ——
  // `noUncheckedIndexedAccess` 下 `hits[0]` 是 `ChipRect | undefined`，
  // 而"先短路再访问"会让类型收窄散在两处。统一走一遍循环，只有一个出口。
  let best: ChipRect | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const chip of hits) {
    const cx = chip.x + chip.width / 2;
    const cy = chip.y + chip.height / 2;
    const distance = (point.x - cx) ** 2 + (point.y - cy) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = chip;
    }
  }
  return best === null ? null : best.mode;
}

/**
 * 松手时最终用哪个模式。
 *
 * 这是"松手即发送"的唯一判定入口，把两条规则收在一处：
 *   1. 命中了 chip → 用那个模式；
 *   2. **没命中 → 回落「说话」**（含"根本没滑动"的情况）。
 *
 * 第 2 条是关键的安全默认：用户按住说话是最高频动作，
 * 任何"滑偏了导致消息没发出去 / 发成别的模式"都是不可接受的。
 */
export function resolveVoiceMode(
  point: Point | null,
  chips: readonly ChipRect[],
  fallback: VoiceMode = DEFAULT_VOICE_MODE,
): VoiceMode {
  if (!point) return fallback;
  return hitTestVoiceChip(point, chips) ?? fallback;
}

/**
 * 高亮该用哪个模式。
 *
 * 与 `resolveVoiceMode` 的差别只在"没命中"时：高亮**保持原样**，
 * 因为手指可能只是从麦克风往上挪了两毫米（还在起步阶段），
 * 这时把高亮打回「说话」会让"已经滑到内心"的状态突然跳掉。
 */
export function highlightVoiceMode(
  point: Point | null,
  chips: readonly ChipRect[],
  current: VoiceMode,
): VoiceMode {
  if (!point) return current;
  return hitTestVoiceChip(point, chips) ?? current;
}

/* ═══════════════════════════════════════════════════════════
   上滑取消（2026-11-02 方向由"下滑"改成"上滑"）
   ═══════════════════════════════════════════════════════════ */

/**
 * 上滑多少像素才算"取消本次录音"。
 *
 * 64px 是个折中：
 *   · 太小（比如 24px）—— 按住时拇指的自然抖动就会误触发，
 *     用户"说完了"却得到"已取消"，比做不出这个功能更糟；
 *   · 太大 —— 手指要滑半个屏幕高，单手够不到。
 *
 * 60 左右也是 iOS/微信/QQ 一类产品的通行量级，用户有肌肉记忆。
 */
export const CANCEL_SLIDE_PX = 64;

/**
 * 从起点到当前点，是不是一个"上滑取消"的动作。
 *
 * ## ★ 方向在 2026-11-02 从"下滑"改成"上滑"（用户明确要求）
 *
 * 用户原话：
 * > 按住按钮上滑一段距离取消
 *
 * 原来是 `current.y - start.y >= threshold`（**往下**滑）。用户握着手机
 * 按住底部按钮时，往下滑会直接滑出屏幕/压到导航栏，那条取消路径
 * 他从来没用上过。而 QQ 的手感是**上滑取消**。
 *
 * ## 为什么还要要求"纵向占优"
 *
 * 光判 `dy >= 64` 不够：用户左滑选「内心/动作」时，拇指走的是弧线，
 * 天然会带一点上抬。如果只看纵向，**滑向左边的动作可能被判成取消** ——
 * 结果是他想发内心独白，却一句都没发出去，而且界面上没有任何东西
 * 能解释为什么。
 *
 * 所以加一条：纵向位移必须**大于**横向位移的绝对值。
 *   · 纯上滑（dx≈0）→ 一定成立
 *   · 斜着滑（dx=60, dy=65）→ 不算取消
 * 后者按"没取消"处理更安全：说出去的话还能撤回，
 * 没说出去的话他以为自己说了。
 *
 * ## 为什么用「相对起点的位移」而不是「相邻两点的方向」
 *
 * 相邻判定要求手指**持续**向上：用户先左滑选了「内心」，中途改主意想取消，
 * 再往上滑时，中间那几帧可能是横向或斜向的 —— 相邻判定会认为"不是取消"。
 * 相对起点判定天然支持"来回改主意"：只看现在比开始高了没有、高出多少。
 */
export function isCancelSlide(
  start: Point,
  current: Point,
  threshold: number = CANCEL_SLIDE_PX,
): boolean {
  const dy = start.y - current.y; // 向上为正
  const dx = Math.abs(current.x - start.x);
  if (dy < threshold) return false;
  return dy > dx;
}

/* ═══════════════════════════════════════════════════════════
   横向滑动选模式（2026-11-01 用户建议）
   ═══════════════════════════════════════════════════════════ */

/**
 * 横向滑多少像素才算"切到另一个模式"。
 *
 * ## 为什么是 56
 *
 * 与 `CANCEL_SLIDE_PX`（下滑 64）同一量级但略小：
 * 横向滑动比纵向更容易被拇指自然带出（握持时拇指的弧线本来就是横向的），
 * 所以阈值该更宽松一点，否则用户"明明往左滑了"却没切过去。
 *
 * 太小（< 40）会让"按住时手抖"变成"切换模式" —— 用户说了一句正常的话
 * 却发成了内心独白，而**发出去之后改不了**，只能撤回重发。
 */
export const MODE_SLIDE_PX = 56;

/**
 * 按横向位移决定模式（用户 2026-11-01 的建议）。
 *
 * ```text
 * 左滑 → inner   （文本放进（））
 * 右滑 → message （文本放进「」）
 * 中间 → speak   （文本放进 ""）
 * ```
 *
 * ## 为什么用横向位移而不是"上滑命中 chips"
 *
 * 原来实现是：按住后**向上**滑到三个 chip 上，命中哪个用哪个。
 * 实测用户用不出来 —— 他自己描述成"点按后说话，然后再点文本类型"，
 * 说明**上滑选 chips 这个动作他没做出来**（可能没发现，也可能够不到）。
 *
 * 横向滑动的好处：
 *   · 拇指活动范围天然是左右，不需要往上够
 *   · 与"上滑取消"（`isCancelSlide`）不在同一个轴上，两者不会互相误判
 *   · 与 QQ / 微信的手感一致，用户有肌肉记忆
 *
 * ## 为什么返回 speak 而不是 null
 *
 * "没滑够"和"滑回中间"都应该是说话 —— 说话是最高频动作，
 * 任何"滑偏了导致没发出去"都不可接受。
 */
export function modeByHorizontalSlide(
  start: Point,
  current: Point,
  threshold: number = MODE_SLIDE_PX,
): VoiceMode {
  const dx = current.x - start.x;
  /*
   * 用 `>=` / `<=` 而不是 `>` / `<`：正好等于阈值时**算切换**。
   *
   * 反过来（正好等于阈值算不切换）会让"滑到刚好 56px 停住"的用户
   * 以为切换没生效 —— 而他确实滑了整整一个阈值那么多。
   */
  if (dx <= -threshold) return 'inner';
  if (dx >= threshold) return 'message';
  return 'speak';
}

/**
 * 滑动过程中该高亮哪个模式。
 *
 * ## 与 `modeByHorizontalSlide` 是同一个判据
 *
 * 高亮和最终结果**必须完全一致**，否则会出现"高亮着内心、松手却发成消息"。
 * 所以这里不另写逻辑，直接复用 —— 两个函数分开是因为**调用时机不同**
 * （拖动中要每次都求值、松手时求一次），不是判据不同。
 */
export function highlightByHorizontalSlide(
  start: Point,
  current: Point,
  threshold: number = MODE_SLIDE_PX,
): VoiceMode {
  return modeByHorizontalSlide(start, current, threshold);
}
