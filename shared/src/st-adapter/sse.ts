/**
 * 流式协议解析（v0.1.7 / T15.4）。
 *
 * ## 这一节最容易写错的地方（契约 §4.1 原文）
 *
 * ST 的 `forwardFetchResponse` 只复制状态码与状态文本，**不设置 `Content-Type`**，
 * 然后把上游字节流原样透传（`src/util.js:745-746`、`:763-764`）。
 *
 * 于是：
 *   · 响应头里**没有** `text/event-stream`；
 *   · **不能**用 `Content-Type` 判断是不是流式 —— 只能看自己请求里的 `stream: true`；
 *   · 事件形状 = 上游厂商原生格式，ST 不做任何归一化。
 *
 * 按"标准 SSE"去想的人会写成 `if (ct.includes('event-stream'))`，
 * 然后在真机上**永远走非流式分支**。表现不是报错，是
 * "能出字但一次性蹦出来、没有打字机效果" —— 用户会觉得"这软件很卡"，
 * 而开发者查日志什么异常都看不到。
 *
 * 所以本模块的入口**不接收 Content-Type**：拿不到就不可能用错。
 */

import type { StChatSource, StStreamEvent } from './types.js';

/**
 * 解析器收到的帧。
 *
 * 刻意只暴露 `data` —— SSE 的 `event:`/`id:`/`retry:` 字段 ST 与各厂商都没用到，
 * 暴露出来只会让人以为要处理它们。
 */
export interface SseFrame {
  data: string;
}

/**
 * 从字节流里切出 SSE 帧。
 *
 * ## 为什么自己实现而不引库
 *
 * 现成的 SSE 库几乎都假设 `Content-Type: text/event-stream`，或者要求传 Response 对象。
 * 而这里的输入是**一个裸字节流**（来自 Rust 侧 forward 过来的 chunk），
 * 没有 Response 可言。
 *
 * ## 分帧规则（与 `public/scripts/sse-stream.js:19` 对齐）
 *
 * 帧之间用空行分隔，而行尾可能是 `\n`、`\r\n`、`\r` 三种混用
 * （ST 前端的正则就是 `/r?n?r?n/`）。只认 `\n\n` 会把 `\r\n\r\n` 的流切成半截。
 *
 * ## 为什么保留剩余缓冲
 *
 * TCP 分片不保证按帧边界到达。一个 `data: {...}` 极可能被切成两个 chunk。
 * 不保留 remainder 就会把 JSON 截断，然后 `JSON.parse` 抛错 ——
 * 而那个错误看起来像"厂商返回了坏数据"，实际是我们自己切坏的。
 */
export class SseFrameSplitter {
  #buffer = '';

  /** 喂一个 chunk，返回它凑齐了的帧（可能 0 个或多个） */
  push(chunk: string): SseFrame[] {
    this.#buffer += chunk;
    const frames: SseFrame[] = [];

    /*
     * 用正则找分隔符的位置，而不是 split —— split 会丢掉"未完成的那一截"，
     * 而那正是下次要接着拼的东西。
     */
    const sep = /\r\n\r\n|\r\r|\n\n/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = sep.exec(this.#buffer)) !== null) {
      const raw = this.#buffer.slice(lastIndex, match.index);
      lastIndex = match.index + match[0].length;
      const frame = parseFrame(raw);
      if (frame !== null) frames.push(frame);
    }

    this.#buffer = this.#buffer.slice(lastIndex);
    return frames;
  }

  /** 流结束时把残留当最后一帧处理（有些实现最后不补空行） */
  flush(): SseFrame[] {
    const rest = this.#buffer;
    this.#buffer = '';
    if (rest.trim() === '') return [];
    const frame = parseFrame(rest);
    return frame === null ? [] : [frame];
  }
}

/**
 * 把一个原始帧块解析成 `{data}`。
 *
 * 一个块可能有多行 `data:`（SSE 规范要求按 `\n` 拼接），
 * 但实际厂商都只发一行。两种都支持，成本很低。
 */
function parseFrame(raw: string): SseFrame | null {
  const lines = raw.split(/\r\n|\r|\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    // 冒号开头是注释（`:` 心跳），厂商偶尔会发
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      // 规范：`data: ` 的那个空格要吃掉，但 `data:xxx` 也合法
      const value = line.slice(5);
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  }
  if (dataLines.length === 0) return null;
  return { data: dataLines.join('\n') };
}

/**
 * 这些源用 OpenAI 兼容的 `choices[].delta` 形状。
 *
 * 与契约 §4.2 的表一致。`claude` 不在里面 —— 它是
 * `content_block_delta`，且**没有 `[DONE]`**。
 */
const OPENAI_COMPAT_SOURCES: readonly StChatSource[] = [
  'openai',
  'custom',
  'deepseek',
  'openrouter',
  'groq',
];

/**
 * 把一个 SSE 帧翻译成归一化事件。
 *
 * @param frame      切出来的帧
 * @param source     请求里用的 `chat_completion_source`（**不是**从响应推的）
 * @returns 0..2 个事件：一帧可能同时带 reasoning 与 text，也可能什么都不带
 *
 * ## 为什么需要 source 参数
 *
 * 因为响应里没有任何字段标注厂商（ST 原样透传，契约 §4.1）。
 * 拿不到厂商就只能猜形状 —— 而猜错的后果是把 Claude 的
 * `content_block_delta` 当 OpenAI 的 `choices` 读，读出来是空字符串，
 * 表现为"模型不回复"。所以厂商必须由调用方从**请求**带进来。
 */
export function translateFrame(frame: SseFrame, source: StChatSource): StStreamEvent[] {
  const data = frame.data.trim();

  // `[DONE]` 是 OpenAI 兼容族的终止标记（`openai.js:3173`）
  if (data === '[DONE]') return [{ type: 'done' }];

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    /*
     * 不是 JSON 就当普通文本往外吐。
     *
     * 为什么不报错：有些代理/网关会在流里插入非 JSON 的心跳或错误文本
     * （`data: rate limited` 之类）。直接失败会让用户丢掉整段已经生成的内容；
     * 当作正文继续，至少已有的字还在，而且用户在屏幕上看得见那句话。
     */
    return data === '' ? [] : [{ type: 'text', text: data }];
  }

  if (parsed === null || typeof parsed !== 'object') {
    return [];
  }
  const obj = parsed as Record<string, unknown>;

  /*
   * 错误对象优先判：厂商会在 200 的流里塞 `{error:{message}}`
   * （契约 §4.3 末尾记的 `chat-completions.js:2710` 形状）。
   * 先判它，避免把错误当正文渲染出来给用户看。
   */
  const error = obj['error'];
  if (error !== undefined && error !== null) {
    const message =
      typeof error === 'object' && error !== null && typeof (error as Record<string, unknown>)['message'] === 'string'
        ? String((error as Record<string, unknown>)['message'])
        : typeof error === 'string'
          ? error
          : '生成失败（厂商未给出原因）';
    return [{ type: 'error', message }];
  }

  if (OPENAI_COMPAT_SOURCES.includes(source)) {
    return translateOpenAi(obj);
  }
  if (source === 'claude') {
    return translateClaude(obj);
  }
  /*
   * 走到这里说明 source 不在 v1 支持范围内。
   * `normalizeChatSource` 本该在更早的地方拦住，这里是第二道。
   * 返回 error 而不是空数组 —— 空数组会让 UI 一直等下去。
   */
  return [{ type: 'error', message: `暂不支持解析这个后端的流式响应（${source}）` }];
}

/** OpenAI 兼容族：`choices[0].delta.{content,reasoning_content,reasoning}` */
function translateOpenAi(obj: Record<string, unknown>): StStreamEvent[] {
  const choices = obj['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return [];
  const first = choices[0];
  if (first === null || typeof first !== 'object') return [];
  const choice = first as Record<string, unknown>;

  const events: StStreamEvent[] = [];
  const delta = choice['delta'];
  if (delta !== null && typeof delta === 'object') {
    const d = delta as Record<string, unknown>;
    /*
     * 思维链有两个字段名：`reasoning_content`（DeepSeek 等）与
     * `reasoning`（部分网关）。都认，否则思维链会被静默丢掉。
     */
    const reasoning = firstString(d['reasoning_content'], d['reasoning']);
    if (reasoning !== null && reasoning !== '') {
      events.push({ type: 'reasoning', text: reasoning });
    }
    const text = d['content'];
    if (typeof text === 'string' && text !== '') {
      events.push({ type: 'text', text });
    }
  }

  /*
   * `finish_reason` 出现在最后一帧。有它就说明上游正常收尾，
   * 不必再等 `[DONE]` —— 有些网关不发 `[DONE]`，只发这个。
   */
  const finish = choice['finish_reason'];
  if (typeof finish === 'string' && finish !== '') {
    events.push({ type: 'done', finishReason: finish });
  }
  return events;
}

/** Claude：`{type:"content_block_delta", delta:{type:"text_delta", text}}`，**无 `[DONE]`** */
function translateClaude(obj: Record<string, unknown>): StStreamEvent[] {
  const type = obj['type'];

  if (type === 'content_block_delta') {
    const delta = obj['delta'];
    if (delta === null || typeof delta !== 'object') return [];
    const d = delta as Record<string, unknown>;
    // 思维链在 `thinking_delta`
    if (d['type'] === 'thinking_delta' && typeof d['thinking'] === 'string' && d['thinking'] !== '') {
      return [{ type: 'reasoning', text: d['thinking'] }];
    }
    if (typeof d['text'] === 'string' && d['text'] !== '') {
      return [{ type: 'text', text: d['text'] }];
    }
    return [];
  }

  /*
   * Claude 的结束信号是 `message_stop`。
   * 契约写「无 `[DONE]`，连接关闭即结束」—— 所以**连接关闭也必须能收尾**，
   * 这一条由调用方在流结束时补一个 done（见 `ensureTerminal`）。
   */
  if (type === 'message_stop') {
    return [{ type: 'done' }];
  }
  if (type === 'error') {
    const err = obj['error'];
    const message =
      err !== null && typeof err === 'object' && typeof (err as Record<string, unknown>)['message'] === 'string'
        ? String((err as Record<string, unknown>)['message'])
        : '生成失败（Claude 未给出原因）';
    return [{ type: 'error', message }];
  }
  return [];
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/**
 * 流结束时补一个 `done`（如果没有出现过）。
 *
 * ## 为什么必须有这一步
 *
 * 三种情况下流会"正常结束但没有终止标记"：
 *   1. `claude` —— 本来就没有 `[DONE]`，结束就是连接关闭；
 *   2. 部分网关不转发 `[DONE]`；
 *   3. 连接被服务端正常关闭（非异常）。
 *
 * UI 侧通常靠 `done` 来收起"正在输入"状态。少了它，界面会一直转圈 ——
 * 用户看着像卡死，实际内容早就收全了。
 *
 * @param seen 这次生成过程中是否已出现过 done
 */
export function ensureTerminal(seen: boolean): StStreamEvent[] {
  return seen ? [] : [{ type: 'done' }];
}

/**
 * 判断"这次请求是不是流式"。
 *
 * 存在这个函数本身就是一种防御：它**只接受请求参数**，签名里没有响应头。
 * 想用 `Content-Type` 判断的人在这里就写不下去（契约 §4.1 的落地点）。
 */
export function isStreamingRequest(request: { stream: boolean }): boolean {
  return request.stream === true;
}
