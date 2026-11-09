/**
 * swipe（重新生成候选）的纯逻辑（v0.1.7 / T15.5）。
 *
 * ## 数据结构在哪
 *
 * 契约 §5.3：候选存在消息对象自己身上 —— `swipes` 数组 + `swipe_id` 指向当前。
 * **没有专门的接口**，适配器只负责把改过的消息存回去（§5.2 表格里写得很清楚）。
 *
 * ## ★ 这里最容易错的一件事：`mes` 与 `swipes[swipe_id]` 必须同步
 *
 * ST 里同一条消息有**两份正文**：
 *   · `mes` —— 当前显示的（渲染读它，历史也读它）
 *   · `swipes[swipe_id]` —— 候选数组里被选中的那个
 *
 * 切候选时只改 `swipe_id` 不改 `mes`，界面上还是旧文字 ——
 * 用户滑了三次，看起来"没反应"，然后第四次要重新生成时把旧的存进历史。
 * 而反过来只改 `mes` 不改 `swipe_id`，回桌面端 ST 打开会显示另一个候选。
 *
 * 所以本模块**所有改变选中项的函数**都同时写这两处，没有例外。
 *
 * ## `swipe_info` 也要跟着动
 *
 * 每个候选有自己的生成时间。切候选时 `swipe_info` 本身不删不改（它是历史记录），
 * 但**追加新候选**时必须同步追加一条，否则 ST 那边数组长度对不上。
 */

import type { StChatMessage } from '../st-adapter/types.js';

/** 这条消息有几个候选。没有 `swipes` 字段时按 1 个算（就是 `mes` 本身）。 */
export function swipeCount(message: StChatMessage): number {
  const swipes = message.swipes;
  if (!Array.isArray(swipes) || swipes.length === 0) return 1;
  return swipes.length;
}

/** 当前选中的候选下标。没有 `swipe_id` 时按 0（ST 的缺省）。 */
export function currentSwipeIndex(message: StChatMessage): number {
  const id = message.swipe_id;
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) return 0;
  const count = swipeCount(message);
  return id >= count ? count - 1 : id;
}

export function canSwipeLeft(message: StChatMessage): boolean {
  // "左滑"= 看下一个候选
  return currentSwipeIndex(message) < swipeCount(message) - 1;
}

export function canSwipeRight(message: StChatMessage): boolean {
  return currentSwipeIndex(message) > 0;
}

/**
 * 切到指定候选。越界时**夹到合法范围**而不是抛错。
 *
 * 为什么不抛错：这个函数的调用方是手势回调 —— 用户连续左滑到边界时
 * 触发一次越界是完全正常的操作，不该让界面崩掉。
 */
export function swipeTo(message: StChatMessage, index: number): StChatMessage {
  const count = swipeCount(message);
  const target = Math.max(0, Math.min(count - 1, Math.floor(index)));
  const swipes = message.swipes;
  const text = Array.isArray(swipes) && swipes[target] !== undefined ? swipes[target] : message.mes;
  return {
    ...message,
    swipe_id: target,
    // ★ 必须同步：渲染读 mes，ST 读 swipes[swipe_id]
    mes: text,
  };
}

/** 下一个候选（左滑）。到头时原样返回。 */
export function swipeNext(message: StChatMessage): StChatMessage {
  if (!canSwipeLeft(message)) return message;
  return swipeTo(message, currentSwipeIndex(message) + 1);
}

/** 上一个候选（右滑）。到第一个时原样返回。 */
export function swipePrev(message: StChatMessage): StChatMessage {
  if (!canSwipeRight(message)) return message;
  return swipeTo(message, currentSwipeIndex(message) - 1);
}

/**
 * 追加一个新生成出来的候选，并切到它。
 *
 * `swipe_info` 的同步规则取自契约 §5.3 的形状：每个候选对应一条
 * `{ send_date, gen_started, gen_finished }`。
 *
 * 首次追加时要把**原来那条 `mes` 也变成第 1 个候选** ——
 * 否则候选数组从 0 开始，用户回看时看不到模型最初那一版。
 * ST 前端就是这么做（`firstMessage` 进 `swipes[0]`）。
 */
export function appendSwipe(
  message: StChatMessage,
  text: string,
  timing: { sendDate?: string; genStarted?: string; genFinished?: string } = {},
): StChatMessage {
  const existing = Array.isArray(message.swipes) ? message.swipes : [];
  const existingInfo = Array.isArray(message.swipe_info) ? message.swipe_info : [];

  // 首次：把现有 mes 落成第 1 个候选
  const swipes = existing.length === 0 ? [message.mes, text] : [...existing, text];
  const info =
    existing.length === 0
      ? [
          { send_date: message.send_date ?? '', gen_started: '', gen_finished: '' },
          {
            send_date: timing.sendDate ?? new Date().toISOString(),
            gen_started: timing.genStarted ?? '',
            gen_finished: timing.genFinished ?? '',
          },
        ]
      : [
          ...existingInfo,
          {
            send_date: timing.sendDate ?? new Date().toISOString(),
            gen_started: timing.genStarted ?? '',
            gen_finished: timing.genFinished ?? '',
          },
        ];

  return {
    ...message,
    swipes,
    swipe_info: info,
    swipe_id: swipes.length - 1,
    mes: text,
  };
}

/**
 * 把当前候选的正文替换掉（流式输出时每来一段就写一次）。
 *
 * 注意它**写 `swipes` 的对应位置**，不只是 `mes` —— 否则流式结束、用户切走再切回，
 * 会看到流式之前的那一版。
 *
 * 没有 `swipes` 字段时只改 `mes`（这是"第一条消息还没重新生成过"的正常形态）。
 */
export function updateCurrentSwipeText(message: StChatMessage, text: string): StChatMessage {
  const swipes = message.swipes;
  if (!Array.isArray(swipes) || swipes.length === 0) {
    return { ...message, mes: text };
  }
  const index = currentSwipeIndex(message);
  const next = swipes.slice();
  next[index] = text;
  return { ...message, swipes: next, mes: text };
}

/**
 * 把最后一条 assistant 消息**弹出历史**，为重新生成做准备。
 *
 * 返回 `{ history, target }`：`target` 是被弹出的那条（候选追加到它身上），
 * `history` 是去掉它之后的数组。
 *
 * 为什么返回下标而不是自己 splice：调用方要拿 `target` 做 `appendSwipe`，
 * 之后再插回原位置。把"取出"和"放回"分开，是为了让中间那段（请求期间）
 * 的界面状态由调用方决定 —— 它可能想先显示一个"生成中"的占位。
 */
export function popLastAssistant(history: readonly StChatMessage[]): {
  history: StChatMessage[];
  target: StChatMessage | null;
  index: number;
} {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (message !== undefined && message.is_user !== true) {
      return {
        history: [...history.slice(0, i), ...history.slice(i + 1)],
        target: message,
        index: i,
      };
    }
  }
  return { history: [...history], target: null, index: -1 };
}
