/**
 * 消息上下文拼装（v0.1.7 / T15.4，决策 #270）。
 *
 * ## 这是 v1 最大的隐藏工作量
 *
 * 契约 §5.2 把它列在「需要前端拼装」的第一条：ST 的聊天请求体里那个
 * `messages` 数组，**没有对应的服务端接口** —— 它由 ST 前端在浏览器里算出来。
 * 也就是说：桌面端能聊，是因为 `public/script.js` 在拼；移动端要自己拼。
 *
 * 拼的东西有四类：
 *
 * ```text
 * system   ← 角色卡字段（description / personality / scenario）+ 世界书激活条目
 * system   ← post_history_instructions（插在历史之后的"越狱/格式要求"）
 * user     ← 用户人设（persona）
 * 历史     ← 已发生的对话（user/assistant 交替）
 * ```
 *
 * ## 为什么不做"完美复刻 ST"
 *
 * ST 的拼装散落在 `script.js` 上千行里，含大量 UI 状态（作者注释开关、
 * 格式化偏好、`mes_example` 的宏替换…）。照抄等于把它的复杂度搬过来。
 *
 * 这里的口径是：**保证语义等价的最小集合**，并把"没做到的部分"显式列出来
 * （见 `CONTEXT_GAPS`），而不是假装全实现了。用户觉得哪里不对时，
 * 能一眼看到"这一段我们没做"，而不是怀疑整体坏了。
 */

import type { StCardData, StWorldbookEntry } from '../model/sillytavern.js';
import { activeEntriesInOrder, DEFAULT_SCAN_DEPTH } from '../rules/worldbook-activation.js';
import type { StChatMessage } from './types.js';

/** 拼装需要的输入 */
export interface ContextInput {
  /** 角色卡数据（已从 `json_data` 解析出来的 `data` 段） */
  card: StCardData;
  /** 世界书条目（取自 `card.character_book.entries`，调用方可先合并卡片外置条目） */
  worldbook?: readonly StWorldbookEntry[];
  /** 已发生的历史消息（**不含** header；最后一条是最新的） */
  history: readonly StChatMessage[];
  /** 用户人设（可为空） */
  persona?: { name?: string; description?: string };
  /** 本次要发送的用户输入（有值时追加在最后） */
  userMessage?: string;
  /** 世界书扫描深度；缺省 4 */
  scanDepth?: number;
  /** 概率激活的随机源（测试注入） */
  random?: () => number;
  /** 是否把 `mes_example` 拼进 system prompt（桌面上有开关，缺省 false） */
  includeExamples?: boolean;
}

/** 拼好的上下文 */
export interface AssembledContext {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /**
   * 每条消息**是否允许被 token 预算裁掉**（与 `messages` 等长）。
   *
   * 只有对话历史是 `true`；系统提示、人设、post_history 一律 `false`。
   *
   * 2026-11-03 补：原来没有这个字段，于是走这条回退路径时
   * **完全不裁** —— 长对话照样超上下文。两条路径的能力必须一致，
   * 否则"用旧逻辑的用户"会踩一个"用新逻辑的用户"不会踩的坑。
   */
  trimmable: boolean[];
  /**
   * 「预算紧张时优先整块丢掉」的标记（与 `messages` 等长）。
   *
   * 这条**旧拼装路径**（v1，把提示词整体拼成 system）里、示例对话是
   * system 的一部分，没有独立槽位可丢 —— 所以这里恒为 `false`。
   * 字段存在只是为了与 `PromptAssembleResult` 对齐：调用方（chat-panel）
   * 两条路径共用同一段预算代码，少一个字段就要在那里分枝。
   */
  dropFirst: boolean[];
  /** 参与拼装的世界书条目数与具体条目（便于界面显示"本次带入 5 条设定"） */
  worldbookUsed: Array<{ index: number; title: string; reason: string }>;
  /** 人设是否生效 */
  personaUsed: boolean;
  /** 本次拼装**没做**的部分（见 `CONTEXT_GAPS`） */
  gaps: readonly string[];
}

/**
 * v1 明确没做的拼装项。
 *
 * 写出来是因为**沉默的缺失最贵**：用户觉得"AI 好像不太像我写的那个角色"，
 * 我们却无从解释。有了这份清单，排查时可以直接对照。
 */
export const CONTEXT_GAPS = [
  '作者注释未拼入上下文 —— 它是给作者看的，默认不进上下文',
  '宏替换只做 {{char}} / {{user}} 两个；不做 {{random}} / {{pick}} / {{time}} 等',
  '世界书递归扫描未实现，只做单轮关键词匹配',
  '向量化召回（extensions.vectorized）未实现',
] as const;

/**
 * 只替换两个最基础的宏。
 *
 * 为什么只做两个：`{{char}}` 与 `{{user}}` 出现在**几乎每张卡**的
 * description 与 first_mes 里，不替换的话 AI 会把字面量 "{{char}}" 当成名字。
 * 其余宏（随机/时间/变量）要么依赖运行时状态，要么影响很小，
 * 做半个不如不做 —— 半吊子的宏系统比没有更难查。
 */
function applyBasicMacros(text: string, charName: string, userName: string): string {
  return text.split('{{char}}').join(charName).split('{{user}}').join(userName);
}

/**
 * 把角色卡字段拼成一段 system prompt。
 *
 * ## 段顺序为什么是这样
 *
 * 大模型的注意力对**开头与结尾**更强。所以：
 *   · 身份与设定（`description`/`personality`）放最前 —— 决定"我是谁"；
 *   · 场景与示例放中间 —— 参考性内容，位置敏感度低；
 *   · `post_history_instructions` 单独一段、放**历史之后**（见 `assembleContext`），
 *     因为它通常写的是"回复格式要求"，越靠后越容易被遵守。
 *
 * 空字段直接跳过、不留空行：一串空行会把上下文拉长，而它对模型没有信息量。
 */
function buildSystemPrompt(input: ContextInput, charName: string, userName: string): string {
  const card = input.card;
  const parts: string[] = [];

  const push = (label: string, value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed === '') return;
    parts.push(label === '' ? applyBasicMacros(trimmed, charName, userName) : `【${label}】\n${applyBasicMacros(trimmed, charName, userName)}`);
  };

  /*
   * 卡自带的 system_prompt 若有内容，放最前面 ——
   * 它是作者对整个对话的顶层指示，优先于描述性字段。
   */
  push('', card.system_prompt);
  push('角色设定', card.description);
  push('性格', card.personality);
  push('场景', card.scenario);

  // 世界书：只放激活的，按 insertion_order
  const recentText = buildRecentText(input);
  const active = activeEntriesInOrder(input.worldbook ?? [], {
    recentText,
    scanDepth: input.scanDepth ?? DEFAULT_SCAN_DEPTH,
    ...(input.random === undefined ? {} : { random: input.random }),
  });
  if (active.length > 0) {
    const blocks = active
      .map(({ entry }) => applyBasicMacros(String(entry.content).trim(), charName, userName))
      .filter((text) => text !== '');
    if (blocks.length > 0) {
      parts.push(`【世界书】\n${blocks.join('\n\n')}`);
    }
  }

  if (input.includeExamples === true) {
    push('对话示例', card.mes_example);
  }

  return parts.join('\n\n');
}

/**
 * 世界书关键词扫描用的文本。
 *
 * 取最近 `scanDepth` 条历史 + 本次用户输入。
 * 本次输入必须进扫描范围 —— 否则用户刚说的话里提到某个名字，
 * 对应的设定条目不会激活，表现为"它没听懂我刚提的那个地方"。
 */
function buildRecentText(input: ContextInput): string {
  const depth = input.scanDepth ?? DEFAULT_SCAN_DEPTH;
  const tail = input.history.slice(-depth);
  const lines = tail.map((message) => (typeof message.mes === 'string' ? message.mes : ''));
  if (typeof input.userMessage === 'string' && input.userMessage !== '') {
    lines.push(input.userMessage);
  }
  return lines.join('\n');
}

/**
 * 拼装完整上下文。
 *
 * 顺序：`[system] → 历史 → [post_history_instructions] → [本次用户输入]`
 *
 * `post_history_instructions` 插在历史之后、用户输入之前，与 ST 的行为一致。
 * 放最前面会被历史淹没（模型对长上下文中段最不敏感）。
 */
export function assembleContext(input: ContextInput): AssembledContext {
  const charName = input.card.name !== '' ? input.card.name : 'Assistant';
  const userName = input.persona?.name !== undefined && input.persona.name !== '' ? input.persona.name : 'User';

  const messages: AssembledContext['messages'] = [];
  const trimmable: boolean[] = [];
  /** 推入一条消息（`canTrim` 决定它能不能被预算裁掉） */
  const push = (
    role: 'system' | 'user' | 'assistant',
    content: string,
    canTrim: boolean,
  ): void => {
    messages.push({ role, content });
    trimmable.push(canTrim);
  };

  const systemPrompt = buildSystemPrompt(input, charName, userName);
  if (systemPrompt !== '') {
    push('system', systemPrompt, false);
  }

  /*
   * 人设也进 system，而不是伪装成 user 消息。
   *
   * 伪装成 user 会让模型的"谁在说话"混淆 ——
   * 表现为偶尔用人设的口吻去回复用户。
   */
  const personaDescription = input.persona?.description?.trim() ?? '';
  if (personaDescription !== '') {
    push('system', `【用户人设】\n${applyBasicMacros(personaDescription, charName, userName)}`, false);
  }

  // 历史：跳过系统消息与空正文
  for (const message of input.history) {
    if (message.is_system === true) continue;
    const text = typeof message.mes === 'string' ? message.mes.trim() : '';
    if (text === '') continue;
    push(message.is_user === true ? 'user' : 'assistant', applyBasicMacros(text, charName, userName), true);
  }

  const postHistory = typeof input.card.post_history_instructions === 'string'
    ? input.card.post_history_instructions.trim()
    : '';
  if (postHistory !== '') {
    push('system', applyBasicMacros(postHistory, charName, userName), false);
  }

  if (typeof input.userMessage === 'string' && input.userMessage.trim() !== '') {
    push('user', applyBasicMacros(input.userMessage.trim(), charName, userName), false);
  }

  // 把世界书命中明细回传，界面要显示"本次带入 N 条设定"
  const recentText = buildRecentText(input);
  const active = activeEntriesInOrder(input.worldbook ?? [], {
    recentText,
    scanDepth: input.scanDepth ?? DEFAULT_SCAN_DEPTH,
    ...(input.random === undefined ? {} : { random: input.random }),
  });

  return {
    messages,
    trimmable,
    /* 旧路径没有独立的示例槽位 ⇒ 一条都不"优先丢" */
    dropFirst: messages.map(() => false),
    worldbookUsed: active.map(({ entry, verdict }) => ({
      index: verdict.index,
      title: typeof entry.comment === 'string' && entry.comment !== ''
        ? entry.comment
        : (typeof entry.name === 'string' ? entry.name : `条目 ${verdict.index + 1}`),
      reason: verdict.reason,
    })),
    personaUsed: personaDescription !== '',
    gaps: CONTEXT_GAPS,
  };
}

/**
 * 「继续」/「重新生成」要用的一种特殊请求：把最后一条 assistant 消息当 prefill。
 *
 * ST 前端做的就是这件事（契约 §5.2）。注意不是"再发一次同样的请求"——
 * 那样模型会重新回答，而不是接着写。
 */
export function buildContinueInput(
  input: ContextInput,
): ContextInput & { prefill: string } {
  /*
   * ★ 2026-10-30 修：原实现按「末位」截断，与实际定位到的下标可能不一致。
   *
   * 原代码：
   *   const last = [...history].reverse().find((m) => m.is_user !== true);
   *   const history = input.history.slice(0, -1);   // ← 假定 last 就是最后一个
   *
   * 一旦最后一条是 **user**（history = [user, assistant, user]），
   * `find` 定位到索引 1 的 assistant，而 `slice(0, -1)` 删掉的是索引 2 的 user：
   *   · assistant 既在历史里、又当 prefill（模型看到重复开头会立刻复读）；
   *   · 最后那条 user 消息**消失**（用户刚说的话被吞了）。
   *
   * 首版之所以没暴露：只在"最后一条就是 assistant"时测过 —— 而"继续"
   * 也确实多在这个场景触发。但 `assembleContext` 同样会用这个函数，
   * 一旦上游状态不同就出错，且现象（"我说的话怎么没发过去"）极难联想到截断。
   *
   * 改成按**定位到的下标**截断，两处同源。
   */
  let index = -1;
  for (let i = input.history.length - 1; i >= 0; i -= 1) {
    if (input.history[i]?.is_user !== true) {
      index = i;
      break;
    }
  }

  const last = index >= 0 ? input.history[index] : undefined;
  const prefill = last !== undefined && typeof last.mes === 'string' ? last.mes : '';
  if (index < 0 || prefill === '') {
    return { ...input, history: [...input.history], prefill };
  }

  /*
   * 历史里去掉**那一条** assistant —— 否则它会既在历史里、又当 prefill。
   * 用索引切片而不是 slice(0,-1)：两者只有在"它就是末位"时才等价。
   */
  const history = [...input.history.slice(0, index), ...input.history.slice(index + 1)];
  return { ...input, history, prefill };
}
