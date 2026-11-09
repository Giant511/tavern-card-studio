/**
 * 消息列表的滚动策略（v0.1.7 / T15.5）。
 *
 * ## 为什么这是纯逻辑、还值得单测
 *
 * "聊天界面自动滚到底"看起来是一行代码，但它有两个**方向相反**的错误：
 *
 * | 做法 | 后果 |
 * |---|---|
 * | 不自动滚 | 发完消息看不到回复，用户以为没发出去 |
 * | **无条件**自动滚 | 往回翻历史时被强行拉到底，永远读不到上面的内容 |
 *
 * 第二种更糟：第一种用户会说"怎么不动"，第二种用户会觉得"这软件坏了"，
 * 而且**在长对话里才会出现**（短对话压根没有可翻的历史），很容易漏测。
 *
 * 所以判据是「**用户本来就在底部**才跟着滚」。这条能用纯函数表达，
 * 也就能在 Node 里断言，不必靠真机试。
 */

/** 距底部多少像素以内算"在底部"。 */
export const STICK_THRESHOLD_PX = 48;

export interface ScrollMetrics {
  /** 内容总高度（`scrollHeight`） */
  scrollHeight: number;
  /** 视口高度（`clientHeight`） */
  clientHeight: number;
  /** 当前滚动位置（`scrollTop`） */
  scrollTop: number;
}

/**
 * 内容是否已经贴底（含容差）。
 *
 * 容差 48px 的理由：手指滑动很难精确停在 0 偏移；
 * 而"差一点点"与"在底部"在体验上是一回事。取太小会让用户
 * 明明觉得在底部、但程序认为不在，于是不跟随 —— 与不自动滚同样的症状。
 */
export function isNearBottom(metrics: ScrollMetrics): boolean {
  const distance = metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop;
  return distance <= STICK_THRESHOLD_PX;
}

/**
 * 内容变化前，记录"是否该继续跟随"。
 *
 * ## 为什么要在**变化前**判断，而不是变化后
 *
 * 新消息一插进来，`scrollHeight` 立刻变大 —— 此时算"距底距离"**必然**变远，
 * 于是任何实现都会得出"用户不在底部"，自动滚永远不生效。
 *
 * 所以正确顺序是：
 *   1. 内容变化**前**问一次 `shouldStick(现在)` 并记下结果；
 *   2. 内容变化后，若记为 true 才滚到底。
 *
 * 这个顺序依赖是"看不见的"—— 写反了代码照样跑，只是不生效，
 * 而现象是"有时候滚有时候不滚"，极难归因。所以抽成两函数把它显式化。
 */
export function shouldStick(metrics: ScrollMetrics): boolean {
  return isNearBottom(metrics);
}

/**
 * 流式增量是否该继续贴底。
 *
 * 与 `shouldStick` 同一判据，单独一个名字是为了让调用点读起来清楚：
 * 流式是"高频小增量"，语义是"跟着光标走"，与"新消息插入"不同。
 *
 * 但注意：**流式期间不该无条件贴底**。用户在生成过程中往上看，
 * 是真实需求（想回看某条设定），强行拉回来等于不让他读。
 */
export function shouldFollowStream(metrics: ScrollMetrics, userPinnedToBottom: boolean): boolean {
  return userPinnedToBottom && isNearBottom(metrics);
}
