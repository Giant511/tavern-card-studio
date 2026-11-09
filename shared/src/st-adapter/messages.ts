/**
 * 聊天消息的读取 / 归一 / 写回（v0.1.7 / T15.4）。
 *
 * 这个模块只干一件事：**让消息在"读进来 → 改几处 → 写回去"的往返里不丢字段**。
 *
 * ## 为什么值得单独一个模块
 *
 * ST 的聊天文件是 JSONL，每条消息里除了 `mes` 还有很多字段：
 * `swipes`（重新生成的候选）、`swipe_id`（当前看第几个）、`swipe_info`（每次生成的时间）、
 * `extra`（附加快照）。移动端只关心正文，但这些字段**必须原样带回去**。
 *
 * 丢了会怎样：用户在手机上聊三句，回桌面发现
 * "我把这条重新生成过 5 次，候选全没了" —— 而这不是他能理解的因果。
 * 契约 §5.3 的判据原话是「除自己改动的字段外**必须逐字段不变**」。
 *
 * 所以这里的原则是：**不认识的字段一律保留**，绝不按白名单重建对象。
 */

import type { StChatMessage } from './types.js';

/**
 * 读聊天的结果。
 *
 * ## 三个 `kind` 对应 ST 的三种真实返回（2026-10-29 契约测试实测修正）
 *
 * | ST 返回 | 触发条件 | 我们的判定 |
 * |---|---|---|
 * | `{}` | 角色聊天目录不存在（ST 顺手建目录）、或没传 `file_name` | `missing` |
 * | `[]` | 聊天文件读不到（不存在 / 权限 / 空文件） | `empty` |
 * | `非空数组` | 正常聊天 | `chat` |
 *
 * ⚠ **`empty` 不等于"这是新聊天"**。`getChatData` 的实现是
 * 「读不到就返回 `[]`」（`src/endpoints/chats.js:580` 的注释原文：
 * *If the chatFilePath cannot be read, this will return []*），
 * 所以 `[]` 同时覆盖"文件不存在"与"文件存在但读失败"两种情形 ——
 * 后者如果被当成新聊天、再整份覆盖保存，**用户的真实历史就没了**。
 *
 * 所以调用方拿到 `empty` 时必须再做一次交叉验证（见 `canSaveOverEmpty`）。
 * 这是本项目里"把两种不同状态合并成一个"代价最高的一处。
 */
export type ChatReadResult =
  | { kind: 'chat'; messages: StChatMessage[] }
  | { kind: 'missing' }
  | { kind: 'empty' }
  | { kind: 'malformed'; reason: string };

/**
 * 解析 `/api/chats/get` 的返回（契约陷阱 #4）。
 *
 * ## 为什么返回三态而不是直接给数组
 *
 * 聊天不存在时 ST 返回 **`{}` 而不是 404**。把 `{}` 当空聊天是最坏的处理：
 * 用户看到一片空白 → 以为聊天丢了 → 点发送 → 适配器把 `[header, 新消息]`
 * 全量写回（`/api/chats/save` 是覆盖语义）→ **真的把历史冲掉了**。
 *
 * 所以这里显式区分"不存在"与"空聊天"，让调用方能决定是"新建"还是"报错"。
 * 判据是 `Array.isArray()`，不是 `Object.keys().length`——
 * 后者对 `{}` 与 `[]` 都给 0，区分不出来。
 */
export function parseChatResponse(raw: unknown): ChatReadResult {
  if (Array.isArray(raw)) {
    /*
     * 空数组单独一种 kind。
     *
     * 第一版把它并进 `chat`（当成"存在但没消息"），而契约测试在真 ST 上
     * 立刻证明这是错的：`[]` 的真实含义是**读不到**（见类型注释的源码引用）。
     * 合并的后果是"读失败 → 当成新聊天 → 保存覆盖 → 历史没了"。
     */
    if (raw.length === 0) return { kind: 'empty' };
    return { kind: 'chat', messages: raw as StChatMessage[] };
  }
  if (raw !== null && typeof raw === 'object' && Object.keys(raw as object).length === 0) {
    return { kind: 'missing' };
  }
  return {
    kind: 'malformed',
    reason: '服务端返回的不是消息数组（可能聊天文件损坏，或 ST 版本变了）',
  };
}

/**
 * 取 header（第 0 条），保留其余为消息。
 *
 * 为什么要拆开：`/api/chats/save` 要求"完整数组含第 0 条 header"。
 * 但 UI 不该看到 header —— 它没有 `mes`，是一个结构占位。
 * 所以适配器在边界上拆一次，写回时再拼上。
 */
export function splitHeader(messages: readonly StChatMessage[]): {
  header: Record<string, unknown>;
  body: StChatMessage[];
} {
  if (messages.length === 0) {
    return { header: {}, body: [] };
  }
  const [first, ...rest] = messages;
  /*
   * 有 `mes` 就不是 header。
   *
   * 不能按"第 0 条一定是 header"硬拆：手工编辑过的聊天文件可能删了 header，
   * 或者从别的工具导入的文件本来就没有。硬拆会把第一条真实消息当 header
   * 吞掉 —— 用户少看到一句话，而且下次保存时它会消失在 header 里。
   */
  if (first !== undefined && typeof first['mes'] === 'string') {
    return { header: {}, body: [...messages] };
  }
  return { header: (first ?? {}) as Record<string, unknown>, body: rest };
}

/**
 * 新建一条消息。
 *
 * 只填必要字段，其余交给 ST 的缺省。刻意**不预填** `swipes`：
 * 空数组和"没有这个字段"在 ST 前端不是一回事（前者会让候选条显示 0/0）。
 */
export function createMessage(input: {
  name: string;
  isUser: boolean;
  text: string;
  now?: Date;
}): StChatMessage {
  const message: StChatMessage = {
    name: input.name,
    is_user: input.isUser,
    send_date: (input.now ?? new Date()).toISOString(),
    mes: input.text,
  };
  return message;
}

/**
 * 修改某条消息的正文，**其余字段原样保留**。
 *
 * 用展开而不是重建对象 —— 这是"不认识的字段一律保留"的落地点。
 * 如果有人在这里改成 `{ name, is_user, mes }`，swipes 就会消失，
 * 而这个 bug 在单测里只有 round-trip 测试能抓到。
 */
export function withMessageText(message: StChatMessage, text: string): StChatMessage {
  return { ...message, mes: text };
}

/**
 * 给某条消息追加一个 swipe 候选（swipe / 重新生成的落地点）。
 *
 * ## 为什么要把旧值推进 `swipes` 再改 `swipe_id`
 *
 * ST 的语义是：`swipes` 存全部候选，`swipe_id` 指向当前显示的那个。
 * 重新生成一次 = 追加候选并把指针移过去，**而不是覆盖 `mes`**。
 * 只改 `mes` 的话，用户左滑想回看上一版就什么都没有了 —— 而左滑切候选
 * 正是决策 #271 定下的交互。
 */
export function withNewSwipe(
  message: StChatMessage,
  candidate: string,
  now: Date = new Date(),
): StChatMessage {
  const existing = Array.isArray(message.swipes) ? message.swipes : [];
  /*
   * 首次生成候选时，把当前 `mes` 当成第 1 个候选推进去 ——
   * 否则用户第一次重新生成，就再也看不到原来那句话了。
   */
  const swipes = existing.length === 0 ? [message.mes, candidate] : [...existing, candidate];
  const swipeInfo = Array.isArray(message.swipe_info) ? [...message.swipe_info] : [];
  swipeInfo.push({ send_date: now.toISOString() });
  return {
    ...message,
    mes: candidate,
    swipes,
    swipe_id: swipes.length - 1,
    swipe_info: swipeInfo,
  };
}

/**
 * 切到第 N 个候选（左滑/右滑调它）。
 *
 * 越界时返回原对象而不是抛错：滑动是高频手势，抛错会在用户快速滑动时
 * 弹出一堆异常。让它"滑到头就不动"更符合手感。
 */
export function withSwipeIndex(message: StChatMessage, index: number): StChatMessage {
  const swipes = Array.isArray(message.swipes) ? message.swipes : [];
  if (swipes.length === 0) return message;
  if (!Number.isInteger(index) || index < 0 || index >= swipes.length) return message;
  const text = swipes[index];
  if (typeof text !== 'string') return message;
  return { ...message, mes: text, swipe_id: index };
}

/**
 * 把 header 与消息体拼回可写盘的完整数组。
 *
 * 顺序必须是 `[header, ...body]` —— ST 读的时候把 `[0]` 当 header，
 * 写在别的位置会被当成一条没有 `mes` 的消息（前端渲染成空气泡）。
 */
export function joinForSave(
  header: Record<string, unknown>,
  body: readonly StChatMessage[],
): unknown[] {
  const hasHeader = Object.keys(header).length > 0;
  return hasHeader ? [header, ...body] : [...body];
}

/**
 * round-trip 自检：读进来再写回去，除显式改动的字段外必须逐字段不变。
 *
 * 这个函数本身不修数据，只**报告差异**。用法是契约测试里
 * 拿真实 ST 返回的消息跑一遍，断言差异为空。
 *
 * 为什么不在生产路径里自动修：自动修意味着"猜"，而猜错的后果是静默篡改
 * 用户数据。宁可让测试红，也不要在用户文件上做无授权的修复。
 */
export function diffMessageRoundTrip(
  before: readonly StChatMessage[],
  after: readonly StChatMessage[],
): string[] {
  const problems: string[] = [];
  if (before.length !== after.length) {
    problems.push(`消息条数变了：${before.length} → ${after.length}`);
    return problems;
  }
  for (let index = 0; index < before.length; index += 1) {
    const a = before[index];
    const b = after[index];
    if (a === undefined || b === undefined) continue;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const av = JSON.stringify(a[key]);
      const bv = JSON.stringify(b[key]);
      if (av !== bv) {
        problems.push(`第 ${index} 条的 \`${key}\` 变了：${av ?? 'undefined'} → ${bv ?? 'undefined'}`);
      }
    }
  }
  return problems;
}

/**
 * 拿到 `empty` 之后，能不能把它当成"新聊天"直接保存。
 *
 * ## 为什么必须有这一层
 *
 * 见 `ChatReadResult` 的注释：`[]` 同时覆盖"文件不存在"与"读失败"。
 * 只有**这个聊天确实不在列表里**时，才能认定它是新的、可以安全首次写入。
 *
 * 若聊天在列表里（说明文件存在、有内容）却读到 `[]` —— 那是读失败，
 * 此时保存就是整份覆盖，用户的历史会当场消失。
 * 正确处置是**报错让用户重试**，不是"尽力而为地写一份"。
 *
 * @param readResult   `/api/chats/get` 的解析结果
 * @param existsInList 这个 `file_id` 是否出现在 `/api/characters/chats` 的返回里
 */
export function canSaveOverEmpty(
  readResult: ChatReadResult,
  existsInList: boolean,
): { ok: true } | { ok: false; reason: string } {
  if (readResult.kind === 'chat') return { ok: true };
  if (readResult.kind === 'missing') return { ok: true };
  if (readResult.kind === 'malformed') {
    return { ok: false, reason: readResult.reason };
  }
  // kind === 'empty'
  if (existsInList) {
    return {
      ok: false,
      reason:
        '这个聊天在列表里存在，但读取时返回了空内容。为避免覆盖掉你的历史，本次保存已取消。' +
        '请重试；若反复出现，聊天文件可能已损坏。',
    };
  }
  return { ok: true };
}
