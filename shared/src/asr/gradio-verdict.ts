/**
 * 判定 Gradio SSE 的**结局**（v0.1.7 / 第八批问题一）。
 *
 * ## 为什么需要这一层
 *
 * 原来客户端只有两个判断：
 *
 * ```ts
 * const serverError = extractGradioError(events);   // 有 error 事件 → 拿原因
 * if (serverError !== null) return fail(…);
 * const text = extractTranscript(events);           // 有 complete → 拿文本
 * if (text === null) return fail('服务跑完了但没有返回文字');
 * ```
 *
 * 这个二分会把**五种完全不同的结局**压成两种，后果全是**错误的归因**：
 *
 * | 真实结局 | 二分法给出的文案 | 为什么错 |
 * |---|---|---|
 * | 流被服务端掐断（服务崩了） | 「服务跑完了但没有返回文字」 | 服务**没跑完**，它崩了。文案却让用户去查"音频里有没有人声" |
 * | error 事件但 data 是 `{}` | 「服务端返回了错误但没有说明原因。」 | 是真的没原因，但**没告诉用户任何可核查的东西** |
 * | 流正常结束但没 complete | 「服务跑完了但没有返回文字」 | 这个归因反而是对的 |
 *
 * 2026-11-01 实测就是这样：SSE 只收到 7 个 `heartbeat`（203 字节）就被
 * `terminated`，之后整个服务 `ECONNREFUSED`（ping 仍通，28ms）。
 * 而客户端给的是"服务跑完了但没有返回文字" —— 把人引向了完全错误的方向。
 *
 * ## 为什么要 `truncated` 这个入参
 *
 * "流被掐断"**在事件列表里看不出来**：读到 7 个 heartbeat 就断，
 * 和"服务端只发了 7 个 heartbeat 然后正常关闭连接"，
 * 解析出来都是同样 7 个事件。唯一的区别在读取层 ——
 * `reader.read()` 是 `done:true`（正常结束）还是抛异常（被掐断）。
 *
 * 所以读取层必须把这个事实**带出来**，不能像原来那样 `catch {}` 吞掉。
 */

import type { GradioSseEvent } from './gradio.js';
import { BLANK_REASON, extractGradioError, extractTranscript } from './gradio.js';

/** SSE 的五种结局 */
export type GradioSseVerdict =
  /** 拿到非空文本 */
  | { kind: 'complete'; text: string }
  /**
   * 服务端发了 `error` 事件，且能取到它对这次请求的原话。
   * `reason` 是**服务端的原话**，不改写。
   */
  | { kind: 'server-error'; reason: string }
  /**
   * 服务端发了 `error` 事件，但 data 里没有可读原因（`{}` / 空串）。
   *
   * 带上 `receivedBytes` 与 `truncated`，因为这两项决定了下一步该查什么：
   * 收到的字节很少 + 被截断 ⇒ 服务在报错的同时就崩了。
   */
  | {
      kind: 'server-error-blank';
      /** 收到的字节数（诊断用） */
      receivedBytes: number;
      /** 读取是否被掐断（`reader.read()` 抛异常） */
      truncated: boolean;
      /** error 事件的 data 原文（通常就是 `{}`） */
      raw: string;
    }
  /**
   * 流被掐断，且既没有 complete 也没有 error。
   *
   * **这是 2026-11-01 实测遇到的那一种**：服务在推理时退出，
   * TCP 连接随之断开。鉴于是"服务没了"，处置是去看那台机器，
   * 不是去改音频。
   */
  | { kind: 'truncated'; receivedBytes: number; lastEvent: string | null }
  /** 流正常结束，但没有 complete 事件 */
  | { kind: 'no-result'; receivedBytes: number };

/**
 * 判定结局。
 *
 * @param events 解析出来的 SSE 事件（顺序保留）
 * @param options.truncated 读取层是否被掐断（**必须来自 `reader.read()` 的异常**，
 *   不能靠事件数量猜）
 * @param options.receivedBytes 收到的原始字节数，只用于诊断
 *
 * ## 判定的顺序（这个顺序本身是判据）
 *
 * 1. **complete + 有文本** → 成功。
 *    先判成功再判错误：服务端可能先发一帧 error（模型加载警告）再发 complete，
 *    那种情况转写是成功的，不该因为中间有 error 就判失败。
 * 2. **error 事件** → 失败，优先报服务端原话。
 * 3. **被截断** → 失败，报"连接被断开"。
 * 4. 其余 → "没有结果"。
 */
export function judgeGradioSse(
  events: readonly GradioSseEvent[],
  options: { truncated: boolean; receivedBytes: number },
): GradioSseVerdict {
  const text = extractTranscript(events);
  if (text !== null && text.trim() !== '') {
    return { kind: 'complete', text };
  }

  /*
   * 文本是空串也算"服务确实跑完了"：那是"说了但没识别出来"，
   * 与"服务坏了"必须分开（这个分流在上层 `classifyEmptyTranscript()`，
   * 这里只负责把"跑完了"这个事实说清楚）。
   */
  const hasComplete = events.some((e) => e.event === 'complete');
  if (hasComplete && text !== null) {
    return { kind: 'complete', text };
  }

  const reason = extractGradioError(events);
  if (reason !== null) {
    /*
     * `extractGradioError` 取不到字段时会返回那句无信息量的兜底话。
     * 这里把它识别出来，转成带诊断字段的 `server-error-blank` ——
     * 同样是"没原因"，但后者能让用户/我看到收到多少字节、有没有断。
     */
    if (reason === BLANK_REASON) {
      const errorEvent = events.filter((e) => e.event === 'error').pop();
      return {
        kind: 'server-error-blank',
        receivedBytes: options.receivedBytes,
        truncated: options.truncated,
        raw: errorEvent?.data ?? '',
      };
    }
    return { kind: 'server-error', reason };
  }

  if (options.truncated) {
    const last = events[events.length - 1];
    return {
      kind: 'truncated',
      receivedBytes: options.receivedBytes,
      lastEvent: last === undefined ? null : last.event,
    };
  }

  return { kind: 'no-result', receivedBytes: options.receivedBytes };
}

/**
 * 兜底话的**定义源在 `gradio.ts`**，这里重新导出便于调用方只 import 一个文件。
 *
 * 不在这个文件里再定义一份：两处字符串一分叉，判定层就认不出兜底话，
 * 又退回那句无信息量的文案 —— 而且**测试不会红**（两处各自都"对"）。
 */
export { BLANK_REASON };
