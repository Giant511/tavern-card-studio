/**
 * 手势头判定（v0.1.7 / T15.5，契约 §8.2 / 决策 #271）。
 *
 * ## 契约原文
 *
 * ```text
 * 左缘 0–20px 起手右滑  →  返回（最高，任何页面都让位）
 * 消息气泡内左滑         →  切 swipe 候选
 * 气泡内右滑             →  不占用（留给系统返回手势的备选）
 * ```
 *
 * ## ★ 判据必须看**起手位置**，不是当前位置
 *
 * 这是本模块存在的最主要理由。如果按"当前手指在哪"判：
 *
 * ```text
 * 用户手指从屏幕中间（x=200）向右滑，滑到 x=15 —— 此时"在左缘"
 *   ⇒ 误判成"返回"，而用户其实是想滑气泡
 * ```
 *
 * 反过来，从 x=10 起手往右滑到 x=180，当前位置已经远离左缘，
 * 按当前位置判又会漏掉返回手势。
 *
 * 所以**起手点（startX）决定是哪种手势**，之后整段轨迹都归它，
 * 中途路过哪里都不改判。这也是系统返回手势的行为方式 —— 用户的肌肉记忆
 * 是从"我从哪儿开始滑"建立起来的。
 *
 * ## 为什么要有最小位移与方向容差
 *
 * 手指按下时会抖。没有阈值的话：
 *   · 每一次点击都会先被判成轻微的滑动（`dx` ±3px）；
 *   · 滑动方向在刚开始的几像素里是噪声，可能先 x+2 再 x-5。
 *
 * 所以要求横向位移超过 `MIN_SWIPE_DISTANCE`，且**水平分量明显大于垂直**
 * （否则斜着滚页面会被当成滑动）。
 */

/** 左缘判定宽度（px）。契约 §8.2 写死 20。 */
export const EDGE_WIDTH = 20;

/**
 * 最小横向位移（px）。小于它就当没滑。
 *
 * 取 8：略大于常见手指抖动幅度（±3~5px），又明显小于一次有意的滑动
 * （通常 40px 以上）。太大的话用户"轻轻一划"就没反应。
 */
export const MIN_SWIPE_DISTANCE = 8;

/**
 * 水平/垂直比例要求：|dx| 必须大于 |dy| 的这个倍数才算横向手势。
 *
 * 1.2 的意思是"必须比垂直位移大 20% 以上"。取 1 会让 45° 斜滑两边都判成命中，
 * 取 2 会让略斜的横滑失效（用户滑横线很少完全水平）。
 */
export const HORIZONTAL_RATIO = 1.2;

export interface GesturePoint {
  x: number;
  y: number;
}

/**
 * 判定的输入。
 *
 * `startX` / `startY` 是**起手点**，`currentX` / `currentY` 是当前位置。
 * 调用方（触摸事件）在 `touchstart` 记下起手点，`touchmove` 时传进来。
 */
export interface GestureInput {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  /** 起手时手指是否落在某条消息气泡上（气泡内左滑才是切候选） */
  startedInBubble: boolean;
}

/**
 * 判定结果。
 *
 * - `back`：返回（右滑起手于左缘）
 * - `swipe`：切候选，`direction` 说明往哪切
 * - `none`：不占用 —— **必须显式返回 `none` 而不是 null**，
 *   因为调用方要区分"没有手势"与"手势被别的东西接管"（后者应交还给系统）
 */
export type GestureResult =
  | { kind: 'back' }
  | { kind: 'swipe'; direction: 'next' | 'prev' }
  | { kind: 'none' };

/** 起手点是否在左缘返回区 */
export function isEdgeStart(x: number): boolean {
  return x >= 0 && x <= EDGE_WIDTH;
}

/**
 * 判一次手势。
 *
 * 优先级严格按契约 §8.2：**返回最高**。所以先判返回，命中了就不再考虑 swipe。
 * 这个顺序不能反 —— 否则在左缘起手右滑、而手指恰好压在某条气泡上时，
 * 会变成"切候选"，用户退不出去。
 */
export function classifyGesture(input: GestureInput): GestureResult {
  const dx = input.currentX - input.startX;
  const dy = input.currentY - input.startY;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);

  // 没动够 —— 当作点击/长按，不占用
  if (absX < MIN_SWIPE_DISTANCE) return { kind: 'none' };
  // 偏垂直 —— 是滚动页面，不占用
  if (absX < absY * HORIZONTAL_RATIO) return { kind: 'none' };

  // ① 返回：起手在左缘 + 向右滑（最高优先级）
  if (isEdgeStart(input.startX) && dx > 0) {
    return { kind: 'back' };
  }

  // ② 切候选：起手在气泡内 + 左滑 = 下一个、右滑 = 上一个
  if (input.startedInBubble) {
    return { kind: 'swipe', direction: dx < 0 ? 'next' : 'prev' };
  }

  // ③ 其余不占用（契约："气泡内右滑不占用，留给系统返回手势的备选"）
  return { kind: 'none' };
}

/**
 * 手势是否应该**阻止默认行为**（`preventDefault`）。
 *
 * 只有真的接管了才拦 —— 无差别 `preventDefault` 会让页面滚不动。
 * 返回手势与切候选都要拦（否则会同时触发系统返回或页面横向滚动）。
 */
export function shouldPreventDefault(result: GestureResult): boolean {
  return result.kind !== 'none';
}

/**
 * 给 UI 用的手势说明（无障碍与调试）。
 *
 * 放在纯逻辑层是因为它是"给用户看的话"，要能被 UI 文案体检扫到。
 */
export function describeGesture(result: GestureResult): string {
  if (result.kind === 'back') return '返回';
  if (result.kind === 'swipe') return result.direction === 'next' ? '下一个候选' : '上一个候选';
  return '无手势';
}

/* ═══════════════════════════════════════════════════════════
   轨迹回放：把一串触摸点喂进来，得到最终判定
   ═══════════════════════════════════════════════════════════ */

/**
 * 一条轨迹的判定（**只输出一次**结果）。
 *
 * 为什么需要"只输出一次"：真实触摸会连续发几十个 `touchmove`。
 * 若每帧都判定，一次左滑会连续切过好几个候选（用户看到"嗖"地跳到最后一个）。
 * 所以正确做法是**整条轨迹只结算一次**，在 `touchend` 时定论。
 *
 * 这个函数就是"把整条轨迹折叠成一个结论"的纯函数，
 * 让 UI 层不必自己维护状态，也让"两条轨迹"的验收可以在 Node 里对拍。
 *
 * @param points 轨迹点（不含起手点之前的准备帧；第一个点应当是起手点）
 * @param startedInBubble 起手时是否在气泡内
 */
export function resolveTrace(
  points: readonly GesturePoint[],
  startedInBubble: boolean,
): GestureResult {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return { kind: 'none' };
  // 用**最远点**而不是终点：用户滑出去又滑回来一半，仍算滑过
  let farthest = first;
  for (const point of points) {
    if (Math.abs(point.x - first.x) > Math.abs(farthest.x - first.x)) farthest = point;
  }
  return classifyGesture({
    startX: first.x,
    startY: first.y,
    currentX: farthest.x,
    currentY: farthest.y,
    startedInBubble,
  });
}
