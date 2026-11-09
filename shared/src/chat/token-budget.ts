/**
 * Token 计数与上下文预算裁剪（2026-11-03，第十九批 ③+④）。
 *
 * ## 为什么需要这一层
 *
 * 拼完 messages 不等于能发。模型的**上下文窗口是硬上限**：
 * 超出就报 400（有的上游更糟 —— 静默截断，回复变糊）。
 *
 * ST 的做法（`ChatCompletion.setTokenBudget` + `populateChatHistory`）：
 *
 * ```text
 *   预算 = openai_max_context - openai_max_tokens
 *     ↑ 上面两项都是用户在预设里填的
 *   历史从**最新一条往前**加，加不下就停
 * ```
 *
 * 之前我们**完全不裁** —— 长对话必然超。用户现象是"聊久了就报错"或
 * "后面越来越不记得"，而这两种都极难联想到"没算 token"。
 *
 * ## ★★★ 为什么"放不下就停"而不是"跳过继续"
 *
 * ST 是 `if (canAfford) 插入; else break;` —— 一旦某条放不下**停止**，
 * 不是跳过它去试更早的。
 *
 * 这不是偷懒，是语义需要：对话是**连续上下文**。
 * 如果倒数第 3 条太长被跳过、却保留倒数第 4 条，模型会看到
 * 「A 说了话 → 角色回了话」中间缺一段，它就会**自己脑补**那段缺的内容，
 * 表现为"它开始编造之前没发生的事"。少几轮历史只是记性差，
 * 中间的洞会让它说错话。
 *
 * 所以这里刻意与 ST 对齐：**要么连续保留尾部，要么整段不保留**。
 */

import type { PromptRole } from './prompt-config.js';

/**
 * 每条消息的 token 估算字节数（与 ST 的 `BYTES_PER_TOKEN` 一致）。
 *
 * 这是**兜底估算**：真机优先走 ST 的 `/api/tokenizers/openai/count`
 * 拿真实分词结果，只有拿不到时才用它。
 *
 * 为什么取值 3.35：ST 里就是 `export const BYTES_PER_TOKEN = 3.35`。
 * 与它一致的好处是"估算和 ST 自己算的差不多"，
 * 用户对比两边数字时不会觉得我们坏得离谱。
 */
export const BYTES_PER_TOKEN = 3.35;

/** 一条待裁剪的消息 */
export interface BudgetMessage {
  role: PromptRole;
  content: string;
}

/** 裁剪输入 */
export interface TokenBudgetInput {
  messages: readonly BudgetMessage[];
  /**
   * 每条消息**是否允许被裁掉**（与 `messages` 等长）。
   *
   * `false` = 必留：提示词槽位、用户自己写的规则 —— 裁掉它们
   * 等于把用户调教好的效果扔掉，比少几轮历史严重得多。
   * `true` = 可裁：对话历史。
   */
  trimmable: readonly boolean[];
  /**
   * 「预算紧张时**优先整块丢掉**」的标记（与 `messages` 等长，可选）。
   *
   * ## 为什么需要第三档（2026-11-09，对齐 ST）
   *
   * 原来只有两档：必留 / 可裁。而"可裁"实际只有对话历史，于是
   * 预算不够时**只能裁最近几轮对话**，示例对话（`mes_example`）永远不动。
   *
   * 查 ST 源码（`scripts/openai.js` 的 `populateDialogueExamples`）：
   *
   * ```js
   *   if (!chatCompletion.canAffordAll([newExampleChat, ...chatMessages])) break;  // 整块丢
   * ```
   *
   * ST 的口径是"示例放不下就**整块不要**，历史照留"。
   * 我们的口径正好相反 —— 长对话里"记性变差但示例一直在"，
   * 而示例是用来示范说话风格的，丢了只是语气淡一点；
   * 历史丢了角色直接失忆。所以对齐 ST 是对的。
   *
   * ## 语义
   *
   * `true` = 这一条属于"第一批被丢掉的"。
   * 丢弃是**整块**的（要么都留、要么都丢），与 ST 的 `break` 一致 ——
   * 只留半份示例比不留更糟：模型会以为角色的说话风格只有那一种。
   *
   * 不传 / 长度不符 ⇒ 行为与改动前**完全一样**（向后兼容）。
   */
  dropFirst?: readonly boolean[];
  /** 预算 = `openai_max_context - openai_max_tokens` */
  budget: number;
  /** 计数函数（注入：真机用 ST 端点，单测用估算） */
  countTokens: (text: string) => number;
}

/** 裁剪结果 */
export interface TokenBudgetResult {
  messages: BudgetMessage[];
  /** 与被裁掉的那部分对应的 `trimmable` 标记（长度与 `messages` 一致，便于上层继续处理） */
  trimmable: boolean[];
  /** 一共用掉多少 token（估算或实测，取决于 `countTokens`） */
  usedTokens: number;
  /** 预算 */
  budget: number;
  /** 被裁掉几条 */
  droppedCount: number;
  /**
   * 必留项**自己就超预算**了。
   *
   * 这时不做任何裁剪（裁也放不下），但必须让上层能把这件事告诉用户 ——
   * 否则用户看到的是"发出去报错"，而我们本可以提前说
   * "你的提示词加起来就超过上下文了，去关掉几条"。
   */
  overBudget: boolean;
  /** 估算出来的"必留项"占用（排查用） */
  requiredTokens: number;
}

/**
 * 估算一段文本的 token 数（ST 的 `guesstimate` 同款）。
 *
 * 按 UTF-8 **字节数**而不是字符数 —— 中文一个字 3 字节，
 * 按字符算会**低估三倍**，而低估的后果正是"以为没超、发出去 400"。
 */
export function estimateTokens(text: string): number {
  if (typeof text !== 'string' || text === '') return 0;
  const bytes = utf8ByteLength(text);
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

/**
 * 数 UTF-8 字节数。
 *
 * 不用 `TextEncoder`：`shared` 要能在没有 DOM/Buffer 的环境里跑
 * （单测、以及将来可能复用到 Rust 侧的逻辑里）。
 * 手写一遍很便宜，且行为确定 —— 不依赖运行时实现差异。
 */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * 按预算裁剪消息。
 *
 * ## 算法
 *
 * ```text
 *   1. 必留项全部保留，累计它们的 token
 *   2. 若必留项已超预算 → 不裁，标 overBudget（让界面提醒用户去关提示词）
 *   3. 否则从**最后一条可裁消息**往前加，放不下就停
 *   4. 输出的顺序保持原样（只是把"停住"之前的那些可裁项去掉）
 * ```
 *
 * ## 为什么要"从后往前"再"按原顺序输出"
 *
 * 对话的**尾部**才是当前的语境。从前往后保留会留下"开局寒暄"、
 * 丢掉"刚刚发生的事"，角色立刻失忆。
 */
export function applyTokenBudget(input: TokenBudgetInput): TokenBudgetResult {
  const { budget, countTokens } = input;

  /*
   * ★★★ `dropFirst` 预处理（2026-11-09）。
   *
   * ## 为什么放在**最前面**，而不是算完必留项再判
   *
   * 第一版把它放在"必留项超预算"之后，于是踩了一个死结：
   * 示例对话的 `trimmable` 是 `false`（它不该被"裁历史"那套逻辑碰），
   * 所以它被算进了 `requiredTokens`。预算紧张时 `requiredTokens > budget`
   * 先成立 ⇒ 直接走 overBudget 分支 ⇒ **永远走不到"丢示例"**。
   * 判据当场抓到了（"预算只够历史"那条报实际 5 条、期望 2 条）。
   *
   * ## 正确顺序
   *
   * ```text
   *   1. 全量放得下           → 一条不丢
   *   2. 放不下 且 有 dropFirst → 整块丢掉它们，然后用剩下的继续走原算法
   *   3. 丢完仍不够           → 原算法继续裁历史（保住最新的）
   * ```
   *
   * 语义与 ST 的 `canAffordAll([example, ...history])` + `break` 一致：
   * 先看"示例 + 历史"整体放不放得下，放不下就把示例整块去掉。
   */
  let messages: readonly BudgetMessage[] = input.messages;
  let trimmable: readonly boolean[] = input.trimmable;

  const dropFirstInput = input.dropFirst;
  const dropFirstValid =
    dropFirstInput !== undefined &&
    dropFirstInput.length === messages.length &&
    dropFirstInput.some((flag) => flag === true);

  /** 这次因为 `dropFirst` 丢掉了几条（计入最终 droppedCount） */
  let droppedByDropFirst = 0;

  if (dropFirstValid) {
    const totalAll = messages.reduce((acc, one) => acc + countTokens(one.content), 0);
    if (totalAll > budget) {
      const keptMessages: BudgetMessage[] = [];
      const keptTrim: boolean[] = [];
      for (let i = 0; i < messages.length; i += 1) {
        if (dropFirstInput![i] === true) {
          /* 计数要数**丢掉的**，不是数保留的（第一版写反了，测试当场抓到） */
          droppedByDropFirst += 1;
          continue;
        }
        const one = messages[i];
        const flag = trimmable[i];
        if (one === undefined || flag === undefined) continue;
        keptMessages.push(one);
        keptTrim.push(flag);
      }
      messages = keptMessages;
      trimmable = keptTrim;
    }
  }

  /* 长度不一致说明调用方搞错了对应关系 —— 宁可不动，也不猜 */
  if (trimmable.length !== messages.length) {
    const used = messages.reduce((acc, one) => acc + countTokens(one.content), 0);
    return {
      messages: [...messages],
      trimmable: [...trimmable],
      usedTokens: used,
      budget,
      droppedCount: droppedByDropFirst,
      overBudget: used > budget,
      requiredTokens: used,
    };
  }

  /* ── 1. 必留项的占用 ── */
  let requiredTokens = 0;
  for (let i = 0; i < messages.length; i += 1) {
    if (trimmable[i] !== true) {
      const one = messages[i];
      if (one !== undefined) requiredTokens += countTokens(one.content);
    }
  }

  /*
   * 预算无效（0、负数、NaN）：不裁。
   *
   * `openai_max_context` 没填或填错时会出现 0。这时**不裁**是对的 ——
   * 裁成空上下文比超一点更糟（模型完全不知道在演谁）。
   */
  if (!Number.isFinite(budget) || budget <= 0) {
    const used = messages.reduce((acc, one) => acc + countTokens(one.content), 0);
    return {
      messages: [...messages],
      trimmable: [...trimmable],
      usedTokens: used,
      budget,
      droppedCount: droppedByDropFirst,
      overBudget: false,
      requiredTokens,
    };
  }

  /* ── 2. 必留项自己就超了 ── */
  if (requiredTokens > budget) {
    const used = messages.reduce((acc, one) => acc + countTokens(one.content), 0);
    return {
      messages: [...messages],
      trimmable: [...trimmable],
      usedTokens: used,
      budget,
      droppedCount: droppedByDropFirst,
      overBudget: true,
      requiredTokens,
    };
  }

  /* ── 3. 从最后一条可裁消息往前，放不下就停 ── */
  let remaining = budget - requiredTokens;
  /**
   * 从哪一条开始（含）整段丢掉。
   *
   * `null` = 全部放得下，一条都不丢。
   *
   * ★ 这里必须用"含"，不是"早于"——
   * 第一版用的是 `cutoff = i; ... i < cutoff` 才丢，
   * 于是"放不下的那一条"自己反而被保留（它明明是最该丢的那条）。
   * 写完一定要用"单条超长历史"的用例验，光看代码很容易觉得对。
   */
  let dropFrom: number | null = null;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (trimmable[i] !== true) continue;
    const one = messages[i];
    if (one === undefined) continue;

    const cost = countTokens(one.content);
    if (cost > remaining) {
      /*
       * ★ 停住，不是跳过。
       * 跳过会在对话中间挖洞，模型会自己脑补缺失那一段（见文件头）。
       */
      dropFrom = i;
      break;
    }
    remaining -= cost;
  }

  /* ── 4. 按原顺序输出 ── */
  const outMessages: BudgetMessage[] = [];
  const outTrimmable: boolean[] = [];
  let droppedCount = 0;

  for (let i = 0; i < messages.length; i += 1) {
    const isTrimmable = trimmable[i] === true;
    /* 可裁且落在丢弃区间内 ⇒ 丢掉。必留项无论下标如何都保留 */
    if (isTrimmable && dropFrom !== null && i <= dropFrom) {
      droppedCount += 1;
      continue;
    }
    const one = messages[i];
    if (one === undefined) continue;
    outMessages.push(one);
    outTrimmable.push(isTrimmable);
  }

  const usedTokens = outMessages.reduce((acc, one) => acc + countTokens(one.content), 0);

  return {
    messages: outMessages,
    trimmable: outTrimmable,
    usedTokens,
    budget,
    /*
     * 两段加起来：预处理丢掉的示例 + 这段裁掉的历史。
     * 少算前者会让界面显示"只丢了 1 条"，而实际丢了 4 条。
     */
    droppedCount: droppedCount + droppedByDropFirst,
    overBudget: false,
    requiredTokens,
  };
}

/**
 * 算预算：`上下文上限 − 留给回复的额度`。
 *
 * 与 ST 的 `setTokenBudget(context, response)` 一致。
 *
 * 为什么不是直接用 `openai_max_context`：那会把窗口**全给输入**，
 * 模型没有余量写回复，上游会以"输出被截断"或 400 收场。
 */
export function computeBudget(contextLimit: unknown, responseLimit: unknown): number {
  const context = typeof contextLimit === 'number' && Number.isFinite(contextLimit) ? contextLimit : 0;
  const response = typeof responseLimit === 'number' && Number.isFinite(responseLimit) ? responseLimit : 0;
  if (context <= 0) return 0;
  /* 回复额度比上下文还大是配置错误，兜底成"至少留四分之一给输入" */
  if (response >= context) return Math.floor(context * 0.25);
  return context - response;
}
