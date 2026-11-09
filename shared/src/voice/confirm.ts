/**
 * 语音发送的确认流状态机（v0.1.7 / T15.6 终版）。
 *
 * ## 为什么要有这一层
 *
 * 「语音发送前需确认」这个开关看起来只是"多一个 if"，实际上它把一条
 * 线性流程变成了**两条**，而两条的边界条件很容易写错：
 *
 * ```text
 * 关（默认）：按住 → 转写 → 包裹 → 直发 → 气泡出现          ← 一条直线
 * 开：       按住 → 转写 → 包裹 → 待确认条 → 编辑 → 发送 → 气泡
 *                                     ↘ 取消 → **作废，什么都不留**
 * ```
 *
 * 第三行是重点。"取消"的语义是**本次语音直接作废**：
 * 不落消息、不留输入框、不留下一条"待发送"的残影。
 * 如果实现成"清空输入框"，用户会得到一条空消息或一个空着的输入框 ——
 * 两种都不是他要的。
 *
 * 用一个显式状态机而不是散落的布尔标志，是为了让"作废"成为一个
 * **可断言的状态转移**（`cancelDraft` 返回 idle 且 draft 为空），
 * 而不是一句注释。
 *
 * 决策 #308。
 */

import { isVoiceMode, type VoiceMode } from './types.js';
import { type WrapVoiceResult, wrapVoiceText } from './wrap.js';

/**
 * 语音流程所处的阶段。
 *
 * | 阶段 | 含义 | 屏幕上有什么 |
 * |---|---|---|
 * | `idle` | 没在录音 | 只有一个麦克风（+ 常驻的模式指示） |
 * | `recording` | 按住中 | 浮层 + chips + 实时波形 |
 * | `transcribing` | 松手后等 ASR | 浮层 + 波形定格 |
 * | `confirming` | 等用户确认 | 待确认条（可编辑） |
 */
export type VoiceStage = 'idle' | 'recording' | 'transcribing' | 'confirming';

export interface VoiceFlow {
  readonly stage: VoiceStage;
  /** 当前模式（chips 高亮哪个）。`idle` 时代表"下次要用的模式" */
  readonly mode: VoiceMode;
  /**
   * 待确认的**已包裹**文本。
   *
   * 注意是"已包裹"：需求明确写了「编辑对象是已包裹文本」。
   * 先包裹再给用户改，与"先裸文本后包裹"的差别在于 ——
   * 用户改的是最终发出去的东西，所见即所发（§6 转写完成态=可编辑）。
   */
  readonly draft: string | null;
}

export function createVoiceFlow(mode: VoiceMode): VoiceFlow {
  return { stage: 'idle', mode, draft: null };
}

/** 按住麦克风。记录本次要用的模式（模式在按下时就定了，滑动会改它）。 */
export function beginRecording(flow: VoiceFlow, mode: VoiceMode): VoiceFlow {
  return { stage: 'recording', mode, draft: null };
}

/** 录音中滑动改模式（chips 高亮跟随，还没松手，不影响 draft）。 */
export function setFlowMode(flow: VoiceFlow, mode: unknown): VoiceFlow {
  if (!isVoiceMode(mode)) return flow;
  if (flow.mode === mode) return flow;
  return { ...flow, mode };
}

/** 松手：进入等 ASR 的阶段。 */
export function beginTranscribing(flow: VoiceFlow): VoiceFlow {
  if (flow.stage !== 'recording') return flow;
  return { ...flow, stage: 'transcribing', draft: null };
}

/**
 * ASR 转写回来了。
 *
 * 这是整个流程的**分岔点**，返回 `send` 字段告诉调用方"现在该发什么"：
 *   · `send !== null` → 确认关，立刻发这条（调用方直接落消息）；
 *   · `send === null` 且 `stage === 'confirming'` → 确认开，等用户点发送；
 *   · `stage === 'idle'` → 转写是空白，**整条作废**（不发送、不留条）。
 *
 * @param confirmRequired 来自配置 `voiceConfirmBeforeSend`
 */
export function applyTranscript(
  flow: VoiceFlow,
  transcript: string,
  confirmRequired: boolean,
): { flow: VoiceFlow; send: string | null } {
  const wrapped: WrapVoiceResult = wrapVoiceText(transcript, flow.mode);

  // 空文本 / 纯空白：不发送。需求原文「空文本/纯空白不发送」。
  // 这里回到 idle 而不是停在 transcribing —— 否则浮层会一直挂着。
  if (!wrapped.ok) {
    return { flow: { stage: 'idle', mode: flow.mode, draft: null }, send: null };
  }

  if (!confirmRequired) {
    // 直发：draft 不落，避免"发出去了但还留着一份待确认文本"
    return { flow: { stage: 'idle', mode: flow.mode, draft: null }, send: wrapped.text };
  }

  return { flow: { stage: 'confirming', mode: flow.mode, draft: wrapped.text }, send: null };
}

/**
 * 编辑待确认文本。
 *
 * 只允许在 `confirming` 阶段改 —— 其它阶段改了也没有意义，
 * 而允许它会让状态机的合法转移变多、测不过来。
 *
 * 允许改成空串：用户可能删光了想取消。此时**不自动取消**
 * （他可能正在重打），但 `commitDraft` 会拒绝发空文本。
 */
export function editDraft(flow: VoiceFlow, text: string): VoiceFlow {
  if (flow.stage !== 'confirming') return flow;
  return { ...flow, draft: text };
}

/**
 * 点「发送」。
 *
 * 发的是 **draft 的当前值**（可能已被编辑），不是 ASR 原始转写 ——
 * 这是需求「编辑后发送=编辑值」的落地点。
 *
 * 空白文本不发（防止用户删光后误点发送，得到一条空消息）。
 */
export function commitDraft(flow: VoiceFlow): { flow: VoiceFlow; send: string | null } {
  if (flow.stage !== 'confirming') return { flow, send: null };
  const text = flow.draft ?? '';
  if (text.trim().length === 0) {
    return { flow: { stage: 'idle', mode: flow.mode, draft: null }, send: null };
  }
  return { flow: { stage: 'idle', mode: flow.mode, draft: null }, send: text };
}

/**
 * 点「取消」= **本次语音直接作废**。
 *
 * 需求原文（用户已拍板）：
 *
 * ```text
 * 取消语义 = 本次语音直接作废，不落消息、不留输入框
 * ```
 *
 * 所以这里回到 `idle` 且 `draft: null` —— 不是"清空文本但留在确认条上"，
 * 也不是"把文本塞回输入框"。两种变通都会让用户以为"我取消的内容还在某处"。
 */
export function cancelDraft(flow: VoiceFlow): VoiceFlow {
  return { stage: 'idle', mode: flow.mode, draft: null };
}

/**
 * 录音中「下滑取消」—— 松手前就放弃这一次。
 *
 * 与 `cancelDraft` 的区别只是**从哪个阶段进来**：
 *   · `cancelDraft`：已经转写完、停在待确认卡上，用户点「取消」；
 *   · `cancelRecording`：还在录，手指下滑表示"这次不算"。
 *
 * 两者的**结果必须完全一致**（回 idle、draft 为 null）。
 * 所以这里直接复用 `cancelDraft` 的实现，而不是各写一份 ——
 * 两个"作废"如果哪天口径不一致（比如一个留 draft 一个不留），
 * 用户会遇到"同样点取消，有时干净有时留残影"，而代码上看不出差别。
 *
 * 只接受 `recording`：其它阶段下滑没有语义（`transcribing` 时录音已经结束、
 * 取消也来不及了，此时应当让 ASR 的结果照常走确认流程）。
 */
export function cancelRecording(flow: VoiceFlow): VoiceFlow {
  if (flow.stage !== 'recording') return flow;
  return cancelDraft(flow);
}
