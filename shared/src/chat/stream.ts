/**
 * 生成中的会话状态（v0.1.7 / T15.5）。
 *
 * ## 为什么要单独一个状态机
 *
 * 「流式输出」看着像"把收到的文字拼起来"，实际上有四个必须想清的状态：
 *
 * | 状态 | 屏幕上 | 用户能做什么 |
 * |---|---|---|
 * | `idle` | 没有光标 | 发送、切候选、重新生成 |
 * | `streaming` | 末尾呼吸圆点 + 文字在长 | 只能停止 |
 * | `stopping` | 同上，但按钮变成"正在停" | 不能再点 |
 * | `failed` | 一条错误提示 + 重试入口 | 重试 / 关掉提示 |
 *
 * 少一个状态就会出问题：
 *   · 没有 `stopping` → 用户连点"停止"，会发多个 abort；
 *   · 没有 `failed` → 错误只闪一下，用户没看到就没了；
 *   · 把 `failed` 当 `idle` → 用户不知道刚才失败了，只看到"没反应"。
 *
 * ## ★ 停止 = 断连，不是发 `/stop` 端点
 *
 * 契约 §3.3.2 / Spike② 已钉：**ST 没有 `/stop` 端点**。停生成只能 abort 掉
 * HTTP 请求（Rust 侧 `StAbort.abort()`）。所以这里的"停止"只改状态、
 * 由调用方去断连 —— 这个模块不碰网络。
 *
 * ## 为什么"打字机"要在这里判
 *
 * 需求第 9 条要求"打字机效果必须可见 —— 这是无 Content-Type 陷阱的直接验证"。
 * 如果 `pushChunk` 把整段一次吞进去，界面就会"卡一下然后整段出现"，
 * 而那正好是**陷阱 #10 没被解决**的表现（误判成非流式）。
 *
 * 所以 `pushChunk` 必须**累积地**产出可见增量，并且我们能断言
 * "chunk 到了 N 次，文本长度涨了 N 次"。
 *
 * 契约 §3.3 / §4.1 / 陷阱 #10。
 */

import type { StStreamEvent } from '../st-adapter/types.js';

export type StreamPhase = 'idle' | 'streaming' | 'stopping' | 'failed';

export interface StreamState {
  readonly phase: StreamPhase;
  /** 已累积的正文（渲染它） */
  readonly text: string;
  /** 已累积的思考过程（部分后端有） */
  readonly reasoning: string;
  /** 收到过多少个文本增量。**用来证明打字机是渐进的**，不是一次性填满 */
  readonly chunkCount: number;
  /** 失败时的人话提示 */
  readonly error: string | null;
  /** 完成原因（`done` 事件带的 finishReason） */
  readonly finishReason: string | null;
}

export function createStreamState(): StreamState {
  return {
    phase: 'idle',
    text: '',
    reasoning: '',
    chunkCount: 0,
    error: null,
    finishReason: null,
  };
}

/** 点"发送"或"重新生成"：进入 streaming，清空上一轮的痕迹。 */
export function startStreaming(): StreamState {
  return { ...createStreamState(), phase: 'streaming' };
}

/**
 * 收到一个流式事件。
 *
 * 逐事件返回**新对象**（不可变），这样 UI 侧可以用引用比较决定是否重绘。
 *
 * 关键：`phase` 不是 `streaming` 时**忽略文本增量**。
 * 为什么：abort 之后网络可能还有几个包在路上，那时再往 text 里追加，
 * 用户会看到"我停了它，文字还在长"。
 */
export function applyStreamEvent(state: StreamState, event: StStreamEvent): StreamState {
  switch (event.type) {
    case 'text': {
      if (state.phase !== 'streaming' && state.phase !== 'stopping') return state;
      if (event.text === '') return state;
      return {
        ...state,
        text: state.text + event.text,
        chunkCount: state.chunkCount + 1,
      };
    }
    case 'reasoning': {
      if (state.phase !== 'streaming' && state.phase !== 'stopping') return state;
      if (event.text === '') return state;
      return { ...state, reasoning: state.reasoning + event.text };
    }
    case 'done': {
      if (state.phase === 'failed') return state;
      return {
        ...state,
        phase: 'idle',
        finishReason: event.finishReason ?? null,
      };
    }
    case 'error': {
      return {
        ...state,
        phase: 'failed',
        error: event.message,
      };
    }
    default:
      return state;
  }
}

/**
 * 点"停止"。
 *
 * 只有 `streaming` 能进 `stopping` —— 重复点击直接原样返回，
 * 所以连点十次也只会产生一次状态变化（abort 由调用方在状态变化时发一次）。
 */
export function requestStop(state: StreamState): StreamState {
  if (state.phase !== 'streaming') return state;
  return { ...state, phase: 'stopping' };
}

/** 用户关掉错误提示 / 点重试前的复位。 */
export function dismissError(state: StreamState): StreamState {
  if (state.phase !== 'failed') return state;
  return { ...state, phase: 'idle', error: null };
}

/** 生成过程中是否该禁用"发送/重新生成/切候选" */
export function isBusy(state: StreamState): boolean {
  return state.phase === 'streaming' || state.phase === 'stopping';
}

/** 是否该在消息末尾显示那个呼吸圆点 */
export function showsCaret(state: StreamState): boolean {
  return state.phase === 'streaming' || state.phase === 'stopping';
}

/**
 * 把累积的文本落成一条消息的形态检查。
 *
 * 单独抽出来的理由：**空输出是一种真实的失败**（上游返回 200 但一个字都没有），
 * 而它的表现是"气泡出现了，但是空的" —— 用户会以为界面坏了。
 * 所以要有明确的判定与文案，不能静默当成成功。
 */
export function finalizeOutput(state: StreamState): { ok: boolean; text: string; message: string } {
  const text = state.text;
  if (text.trim().length > 0) return { ok: true, text, message: '' };

  /*
   * ═══════════════════════════════════════════════════════════
   * 空正文要分三种，它们的**修法完全不同**
   * ═══════════════════════════════════════════════════════════
   *
   * 2026-11-02 真机实测（`deepseek-v4-pro`，logcat 原文）：
   *
   * ```text
   *   frame#0  {"delta":{"role":"assistant"}}                ← 只有角色
   *   frame#1  {"delta":{"reasoning_content":"我们需要"}}     ← 只有思维链
   *   frame#2  {"delta":{"reasoning_content":"理解"}}
   *   ... post_stream 结束：frames=302 err=false              ← 流正常结束
   * ```
   *
   * 302 帧全是 `reasoning_content`，`content` 一个字没有。
   * 而 API 后台显示 `510 / 300` —— **max_tokens=300 被思维链吃完了**。
   *
   * 原来这里只有一句"没有生成任何内容"，用户看到的是：
   * 气泡消失、没有任何东西、但钱扣了。而"换个说法"这个建议
   * **完全不对症** —— 换多少说法都会在同一个地方被截断。
   */

  const thinking = state.reasoning.trim();

  /* ① 只有思维链、没有正文 ⇒ 预算被思考耗尽（本机实测的就是这种） */
  if (thinking.length > 0) {
    const truncated = state.finishReason === 'length';

    /*
     * ★ 建议数值要**按这次的思维链长度算**，不能给一个固定数。
     *
     * 真机实测两次：一次 459 字思维链（1200 够用、出了正文），
     * 一次 2074 字（1200 仍不够）。同一个模型、同样的配置，
     * 思维链长度差 4 倍 —— 固定写"建议 800"会让第二次照样失败，
     * 而用户已经照做了，只会觉得"这功能就是坏的"。
     *
     * 中文大约 1 字 ≈ 1 token（保守），再给正文留 400 的余量，
     * 向上取整到 100。
     */
    const suggest = Math.ceil((thinking.length + 400) / 100) * 100;
    return {
      ok: false,
      text: '',
      message: truncated
        ? `模型把回复预算全用在思考上了（收到 ${String(thinking.length)} 字思维链、0 字正文），随后被截断。` +
          `请到「我的 → API 连接」把「最大回复长度」调到 ${String(suggest)} 或更大，或换一个非推理模型。`
        : `模型只输出了思考过程（${String(thinking.length)} 字）、没有正文。` +
          `请到「我的 → API 连接」把「最大回复长度」调到 ${String(suggest)} 或更大，或换一个非推理模型。`,
    };
  }

  /* ② 连思维链都没有 ⇒ 上游确实什么都没返回 */
  return {
    ok: false,
    text: '',
    message:
      '这次没有生成任何内容（上游返回成功但既无正文也无思考过程）。' +
      '若反复出现，请到「我的 → API 连接」检查模型名是否可用。',
  };
}
