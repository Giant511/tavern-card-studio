/**
 * ASR 客户端（v0.1.7 / T15.6）—— **直连用户配置的厂商域名**。
 *
 * ## ★ 红线：TCS 服务端零接触
 *
 * 需求原文（§五 验收第 6 条）：音频直调用户配置的 ASR 域名，
 * **TCS 服务端零接触**。这条不是"设计偏好"，是隐私承诺 ——
 * 用户的声音不该经过我们的服务器。
 *
 * 落地方式：这个文件里 `fetch` 的 URL **只由 `baseUrl + 路径` 组成**，
 * 不存在任何"转发到 TCS 服务端"的分支。测试里有一条静态断言守着
 * （`test/voice-wiring.test.mjs` 扫源码，确认没有引用 TCS 的任何域名/路径前缀）。
 *
 * ## 三条协议路线
 *
 * | 路线 | 端点 | 请求体 |
 * |---|---|---|
 * | A（默认） | `POST {base}/audio/transcriptions` | multipart：`file` + `model` |
 * | B（高级） | `POST {base}/chat/completions` | JSON：`input_audio`（OpenAI 兼容形态） |
 * | C（自建） | `upload → call → poll`（Gradio） | JSON：位置参数数组 |
 *
 * 路线 C 的**请求体形状由服务端决定**（参数按位置排），所以它的参数表
 * 要先问服务端拿。那部分纯逻辑在 `shared/src/asr/gradio.ts`，
 * 本文件只负责发请求与把失败折算成文案。
 *
 * **路线 B 的形状各厂商不同**（`input_audio` / `inline_data` / `audio_url`），
 * 文档 §3.1 把它列成"设计时必须回答、现在没答案"的开放问题。
 * 本期只实现 OpenAI 兼容的 `input_audio` 形态 —— 多厂商变体**没做**，
 * 如实写进"没做到的"。这样选的理由：`input_audio` 是覆盖面最广的一种，
 * 而按厂商分叉需要真实的各家响应样本，我没有。
 */

import {
  buildCallUrl,
  buildConfigUrl,
  buildFileData,
  buildGradioArgs,
  buildInfoUrl,
  buildPollUrl,
  buildUploadUrl,
  classifyAsrFailure,
  coerceToChoices,
  findDropdownByLabel,
  judgeGradioSse,
  normalizeGradioBase,
  parseGradioConfig,
  parseGradioDropdowns,
  parseGradioInfo,
  parseSse,
  parseUploadResponse,
  pickTranscribeEndpoint,
  type AsrFailure,
  type AsrPreset,
} from '@tcs/shared';
import { hasNativeHttp, nativeFetch } from './native-fetch.ts';

/** 一次转写请求的输入 */
export interface AsrRequest {
  preset: AsrPreset;
  /** 用户填的 base_url（已去除尾部斜杠） */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 仅 gradio 路线：模型权重所在目录（`./models/Fun-ASR-Nano`） */
  modelPath?: string;
  audio: Blob;
  /** 音频格式后缀，决定 multipart 里的文件名（部分厂商按扩展名判格式） */
  extension?: string;
  /** 超时（毫秒）。默认 30s —— 3 秒音频在弱网下也可能十几秒 */
  timeoutMs?: number;
  /** 注入 fetch（测试用） */
  fetchImpl?: typeof fetch;
}

export type AsrResult =
  | { ok: true; text: string }
  | { ok: false; failure: AsrFailure };

/**
 * 拼端点。
 *
 * 为什么不用 `new URL(path, base)`：`new URL('/audio/transcriptions', 'https://x/v1')`
 * 会得到 `https://x/audio/transcriptions`（**丢掉 `/v1`**），而厂商的 base_url
 * 恰恰常带 `/v1`。用字符串拼接并把斜杠规整好，行为可预测。
 *
 * 文档 §表里记着这条：中转站文档常给**全路径**，用户会整段复制 ——
 * 所以还要处理"用户把完整端点粘进 base_url"的情况。
 */
/**
 * DashScope 原生多模态路径（百炼的同步转写走这里）。
 *
 * ★★★ 它**不在** `/compatible-mode/v1` 底下，而是 `/api/v1/...` —— 那是
 * 阿里自己的 API 命名空间。所以拼地址时要把兼容层前缀剥掉：
 *
 * ```text
 *   用户填  https://dashscope.aliyuncs.com/compatible-mode/v1
 *   实际打  https://dashscope.aliyuncs.com/api/v1/services/aigc/
 *           multimodal-generation/generation
 * ```
 *
 * 2026-11-07 实测：`{base}/audio/transcriptions` 对这个域名返回 **404**，
 * 而上面那条路径 + `qwen3-asr-flash` 返回 200。所以"兼容模式"这个名字
 * 有误导性 —— 兼容的是 chat，不是 audio。
 */
const DASHSCOPE_AUDIO_PATH = '/api/v1/services/aigc/multimodal-generation/generation';

/**
 * 从用户填的 base 里**剥掉**兼容层前缀，得到 API 根。
 *
 * 兼容两种填法：
 * ```text
 *   https://x/compatible-mode/v1   ->  https://x
 *   https://x                      ->  https://x
 * ```
 * 也容忍用户直接粘了完整端点。
 */
function dashscopeRootOf(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (base.endsWith(DASHSCOPE_AUDIO_PATH)) return base.slice(0, -DASHSCOPE_AUDIO_PATH.length);
  return base.replace(/\/compatible-mode\/v1$/, '');
}

export function buildAsrEndpoint(baseUrl: string, protocol: AsrPreset['protocol']): string {
  if (protocol === 'dashscope-audio') {
    const raw = baseUrl.trim().replace(/\/+$/, '');
    /* 用户已经粘了完整端点：保持原样，不再拼 */
    if (raw.endsWith(DASHSCOPE_AUDIO_PATH)) return raw;
    return `${dashscopeRootOf(raw)}${DASHSCOPE_AUDIO_PATH}`;
  }

  const base = baseUrl.trim().replace(/\/+$/, '');
  const suffix = protocol === 'transcriptions' ? '/audio/transcriptions' : '/chat/completions';

  /*
   * 用户已经把完整端点粘进来了 —— 不再拼一层。
   *
   * 判据：base 已以目标后缀结尾。这样 `https://x/v1/audio/transcriptions`
   * 保持原样，而 `https://x/v1` 会变成 `https://x/v1/audio/transcriptions`。
   */
  if (base.endsWith(suffix)) return base;
  return `${base}${suffix}`;
}

/**
 * 这次请求该用哪个 fetch。
 *
 * ## ★★★ 真机上 `globalThis.fetch` 根本不通
 *
 * 2026-11-07 真机复现：语音设置里点「测试连接」永远是
 * **"网络请求失败。请检查网络连接，或确认这个地址可达。"** ——
 * 而同一把 key 用 curl 打同一个地址是 200。
 *
 * 原因不是网络，是**这个 WebView 的网络栈没通**（memory §104 记过：
 * 连 `http://127.0.0.1` 都是 TypeError）。本项目所有外网请求
 * （认证 / 仓库 / 同步）都走 Android 原生桥 `nativeFetch`，
 * **唯独语音转写漏了** —— 所以"所有语音方式"在真机上都不可能成功。
 *
 * ## 调用方仍可覆盖
 *
 * `req.fetchImpl` 优先（测试注入桩就靠它），其次原生桥，最后才是 `fetch`。
 * 桌面预览没有原生桥，走 `fetch` 是对的。
 */
function pickFetch(override?: typeof fetch): typeof fetch {
  if (override !== undefined) return override;
  if (hasNativeHttp()) return nativeFetch;
  return globalThis.fetch;
}

/** 从 base_url 里猜一个合理的扩展名（厂商按它判格式） */
function extensionFor(audio: Blob, override?: string): string {
  if (override !== undefined && override !== '') return override;
  const type = audio.type.toLowerCase();
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'm4a';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('wav')) return 'wav';
  return 'webm';
}

/**
 * 发一次转写。
 *
 * ## 错误分流全部交给纯逻辑
 *
 * `classifyAsrFailure` 已经有 19 条测试（401/404/429/网络/超时各有文案），
 * 这里**不自己写 if-else 文案** —— 写了就是两份，而两份一定会分叉。
 */
export async function transcribe(req: AsrRequest): Promise<AsrResult> {
  /*
   * Gradio 是**异步任务模型**（提交 → 拿 id → 拉结果），
   * 与下面"一次 POST 就有响应"的两条路线没有可复用的一段，
   * 所以整条链路单独一个函数。
   */
  if (req.preset.protocol === 'gradio') return transcribeViaGradio(req);

  const doFetch = pickFetch(req.fetchImpl);
  if (doFetch === undefined) {
    return {
      ok: false,
      failure: { kind: 'network', message: '这个环境不能发网络请求。' },
    };
  }


  const endpoint = buildAsrEndpoint(req.baseUrl, req.preset.protocol);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? 30_000);

  try {
    const response =
      req.preset.protocol === 'transcriptions'
        ? await postTranscriptions(doFetch, endpoint, req, controller.signal)
        : req.preset.protocol === 'dashscope-audio'
          ? await postDashscopeAudio(doFetch, endpoint, req, controller.signal)
          : await postChatAudio(doFetch, endpoint, req, controller.signal);

    clearTimeout(timeout);

    if (!response.ok) {
      /*
       * ★★★ 先看一种"其实是成功"的失败（2026-11-07 实测）。
       *
       * 阿里的 `qwen-audio-3.0-asr-flash` / `fun-asr-flash-*` 在**音频里没人声**
       * 时返回：
       *
       * ```text
       *   HTTP 400 {"code":"CLIENT_ERROR","message":"ASR_RESPONSE_HAVE_NO_WORDS"}
       * ```
       *
       * 这不是故障 —— 服务收到音频、做了识别、结论是"没有可识别的词"。
       * 但按状态码它会落到"语音服务返回了未能识别的问题（服务端返回 400）"，
       * 而**内置测试音本来就是合成音、没有人声**，所以用户在设置页点
       * 「测试连接」必然看到这条"问题"，以为是坏的。
       *
       * 所以这里把它翻译成 `ok: true` + 空文本：
       * 上层 `classifyEmptyTranscript` 会给一句准确的话（"没听到内容"），
       * 测试连接那边则显示"链路正常、只是测试音没人声"。
       */
      /*
       * 只在 400 上试 —— 那个 code 只以 400 出现，而读 body 是有代价的
       * （body 只能读一次），不该平白吃掉 401/404 的响应。
       *
       * `typeof response.text === 'function'` 也不能省：注入的桩
       * （测试 / 桌面）可能只实现 `json()`，直接调 `text()` 会抛
       * TypeError，然后被外层 catch 成"网络请求失败" —— 一个假故障。
       */
      if (response.status === 400 && typeof response.text === 'function') {
        const bodyText = await response.text().catch(() => '');
        if (bodyText.includes('ASR_RESPONSE_HAVE_NO_WORDS') || bodyText.includes('NO_WORDS')) {
          return { ok: true, text: '' };
        }
      }

      // 403 在多数厂商等价于 key 不对（不是权限模型）—— 归到 auth 才能给出对的动作
      const status = response.status === 403 ? 401 : response.status;
      return { ok: false, failure: classifyAsrFailure({ status, protocol: req.preset.protocol }) };
    }

    const text = await readText(response, req.preset.protocol);
    if (text === null) {
      return {
        ok: false,
        failure: {
          kind: 'other',
          message: '服务返回的内容看不懂，可能选错了协议或模型。',
        },
      };
    }
    return { ok: true, text };
  } catch (error) {
    clearTimeout(timeout);
    const name = (error as { name?: string })?.name ?? '';
    if (name === 'AbortError') {
      return { ok: false, failure: classifyAsrFailure({ errorKind: 'timeout', protocol: req.preset.protocol }) };
    }
    return { ok: false, failure: classifyAsrFailure({ errorKind: 'network', protocol: req.preset.protocol }) };
  }
}

/** 路线 A：multipart 表单 */
async function postTranscriptions(
  doFetch: typeof fetch,
  endpoint: string,
  req: AsrRequest,
  signal: AbortSignal,
): Promise<Response> {
  const form = new FormData();
  const ext = extensionFor(req.audio, req.extension);
  // 文件名带扩展名：部分厂商（含自建 whisper.cpp）按扩展名判格式
  form.append('file', req.audio, `voice.${ext}`);
  form.append('model', req.model);
  // language 不传：让服务端自动判，传了反而可能限制识别范围

  return doFetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${req.apiKey}` },
    body: form,
    signal,
  });
}

/**
 * 从 MIME 里取一个"格式名"（`audio/wav` → `wav`）。
 *
 * 阿里原生接口要 `parameters.format`，而它认的是裸格式名不是 MIME。
 * `audio/x-wav` / `audio/wave` 都归到 `wav`：它们指的是同一个东西。
 */
function formatOf(mime: string): string {
  const sub = mime.toLowerCase().split('/')[1] ?? '';
  const bare = sub.split(';')[0]?.trim() ?? '';
  if (bare === '') return 'wav';
  if (bare === 'x-wav' || bare === 'wave' || bare === 'vnd.wave') return 'wav';
  if (bare === 'mpeg' || bare === 'mp3') return 'mp3';
  if (bare === 'mp4' || bare === 'm4a') return 'm4a';
  if (bare === 'ogg' || bare === 'webm') return bare;
  return bare;
}

/**
 * 路线 A'：DashScope 原生多模态（百炼的同步转写）。
 *
 * ## 与 `chat-audio` 的三处差别（都实测过）
 *
 * ```text
 *                chat-audio（OpenAI 兼容）      dashscope-audio（阿里原生）
 *   路径         {base}/chat/completions        /api/v1/services/aigc/...
 *   音频字段     input_audio: {data, format}    content[].audio = "data:audio/wav;base64,..."
 *   结果位置     choices[0].message.content     output.choices[0].message.content[0].text
 * ```
 *
 * ★ 音频那一步**必须带 `data:` 前缀**。不带的话阿里返回 `400 {}`
 *   （空 body，没有任何提示）—— 这个失败形态极难查：看起来像"地址错了"
 *   或"key 错了"，实际只是少了个 MIME 段。
 *
 * ★ 不传文字指令。加了反而可能让它"回答"而不是"转写" ——
 *   这个模型是纯转写模型，多给一句要求会带来多余输出。
 */
async function postDashscopeAudio(
  doFetch: typeof fetch,
  endpoint: string,
  req: AsrRequest,
  signal: AbortSignal,
): Promise<Response> {
  const base64 = await blobToBase64(req.audio);
  const mime = req.audio.type === '' ? 'audio/wav' : req.audio.type;

  /*
   * ★ `parameters.format` 不能省（2026-11-07 实测）。
   *
   * 同一把 key、同一段音频：
   *
   * ```text
   *   qwen-audio-3.0-asr-flash  parameters={}              → 400 UNSUPPORTED_FORMAT "format is empty"
   *   qwen-audio-3.0-asr-flash  parameters={format:'wav'}  → 400 ASR_RESPONSE_HAVE_NO_WORDS（静音没词，说明它跑通了）
   *   fun-asr-flash-*           同上一模一样
   *   qwen3-asr-flash           带不带都是 200
   * ```
   *
   * 也就是说：**少了这个字段，有一个能用，两个报"格式为空"**。
   * 而 `UNSUPPORTED_FORMAT` 这个名字会把人引向"音频编码不对"，
   * 实际只是少传了一个元数据。
   *
   * 格式从 mime 里取（`audio/wav` → `wav`），与 data URL 那段同源，
   * 不会出现"声明 wav 实际 mp3"。
   */
  const body = {
    model: req.model,
    input: {
      messages: [
        {
          role: 'user',
          content: [{ audio: `data:${mime};base64,${base64}` }],
        },
      ],
    },
    parameters: { format: formatOf(mime) },
  };

  return doFetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
}

/** 路线 B：chat 协议带音频（OpenAI 兼容的 `input_audio` 形态） */
async function postChatAudio(
  doFetch: typeof fetch,
  endpoint: string,
  req: AsrRequest,
  signal: AbortSignal,
): Promise<Response> {
  const base64 = await blobToBase64(req.audio);
  const ext = extensionFor(req.audio, req.extension);

  const body = {
    model: req.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '请把这段语音原样转写成文字，不要加任何解释或标点补全。' },
          { type: 'input_audio', input_audio: { data: base64, format: ext } },
        ],
      },
    ],
  };

  return doFetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
}

/** 从响应里取文本。两条协议的响应形状不同 */
async function readText(response: Response, protocol: AsrPreset['protocol']): Promise<string | null> {
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return null;
  }

  if (protocol === 'transcriptions') {
    // Whisper 系列：{ text: "..." }
    const text = (json as { text?: unknown }).text;
    if (typeof text === 'string') return text;
    // 少数实现返回 { result: "..." }
    const result = (json as { result?: unknown }).result;
    if (typeof result === 'string') return result;
    return null;
  }

  if (protocol === 'dashscope-audio') {
    /*
     * 阿里原生形状：`output.choices[0].message.content[0].text`
     *
     * 实测响应（1 秒静音）：
     * ```json
     * {"output":{"choices":[{"message":{"content":[{"text":"嗯。"}],
     *   "annotations":[{"language":"zh","emotion":"neutral"}]}}]},
     *  "usage":{"audio_tokens":25}}
     * ```
     *
     * 只要文本；情绪/语种是附带输出，当前用不上。
     */
    const output = (json as { output?: { choices?: unknown } }).output;
    const choices = output?.choices;
    if (!Array.isArray(choices)) return null;
    const first = choices[0] as { message?: { content?: unknown } } | undefined;
    const content = first?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const joined = content
        .map((part) => (typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
        .join('');
      /*
       * ★ 空串要**原样返回空串**，不许返回 `null`（2026-11-07）。
       *
       * `null` 的语义是"响应形状看不懂"，会提示"可能选错了协议或模型"；
       * 而"识别出来是空的"是**另一种结论**，由 `classifyEmptyTranscript`
       * 单独给话（"没听到内容"）。
       *
       * 第一版这里写了 `joined === '' ? null : joined`，于是合成测试音
       * （本来就没有词）被报成"协议选错了" —— 用户会去乱改配置。
       * Whisper 那支一直是 `return text`（空串就空串），这里与它对齐。
       */
      return joined;
    }
    return null;
  }

  // chat 协议：choices[0].message.content
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return null;
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const content = first?.message?.content;
  if (typeof content === 'string') return content;
  // 有的实现 content 是分段数组
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('');
    return joined === '' ? null : joined;
  }
  return null;
}

/* ───────────────────── 路线 C：Gradio ───────────────────── */

/**
 * 探测类请求的超时（`/config`、`/info`、`/upload`）。
 *
 * 这几个都是"服务端立刻就该答复"的请求。给 15s 而不是 30s：
 * 地址填错时用户不该等半分钟才知道。
 */
const GRADIO_PROBE_TIMEOUT_MS = 15_000;

/**
 * 拉结果的超时（`poll`）。
 *
 * 默认 120s：第一次转写要加载权重，Fun-ASR 在 CPU 上冷启动确实可能几十秒。
 * 给太短会把"正在算"误报成"服务挂了" —— 而这两者的处置完全不同
 * （前者等一等，后者去看那台机器）。
 */
const GRADIO_POLL_TIMEOUT_MS = 120_000;

/**
 * 发一次请求，把"抛异常"统一折算成 `AsrFailure`。
 *
 * ## 为什么所有 gradio 请求都过这一个函数
 *
 * 五个请求（config / info / upload / call / poll）如果各自写 try/catch，
 * 就会出现五份"网络失败怎么报"，而它们一定会分叉 ——
 * 最后用户看到的文案取决于他卡在哪一步，而不是取决于真实原因。
 */
async function requestOrFailure(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  protocol: AsrPreset['protocol'],
): Promise<{ ok: true; response: Response } | { ok: false; failure: AsrFailure }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(url, { ...init, signal: controller.signal });
    return { ok: true, response };
  } catch (error) {
    const name = (error as { name?: string })?.name ?? '';
    const errorKind = name === 'AbortError' ? 'timeout' : 'network';
    return { ok: false, failure: classifyAsrFailure({ errorKind, protocol }) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 逐块读响应体，**读失败时保留已读到的部分**。
 *
 * ## 为什么不用 `response.text()`
 *
 * 真机实测（2026-11-01）：服务端的 worker 在推理中途挂掉时，
 * SSE 流会被**直接掐断**（chunked 编码没有结束块）。
 * 此时 `response.text()` 抛 `TypeError: terminated`，**已收到的内容全部丢失** ——
 * 于是我们只能报"网络失败"，而服务端其实已经告诉我们原因了
 * （它发过一条 `event: error`，就在那 203 个字节里）。
 *
 * 逐块读能把那 203 字节留下来，从而报出服务端的原话。
 */
/**
 * 读 SSE 流，**并把"是否被掐断"这个事实带出来**。
 *
 * ## 为什么必须返回 `truncated`（2026-11-01 第八批问题一）
 *
 * 原来这个函数 `catch {}` 吞掉异常、只返回字符串。于是：
 *
 * · 服务端正常发完就关连接 → `done:true`，字符串完整
 * · 服务端在推理时崩了、TCP 断开 → 抛异常，字符串是残的
 *
 * **两者在调用方看起来一模一样**。结果客户端把"服务崩了"报成
 * 「服务跑完了但没有返回文字」，把人引去查音频里有没有人声。
 *
 * 事件列表里也分辨不出来：读到 7 个 heartbeat 就断，和"只发了 7 个然后正常关闭"
 * 解析出来都是同样 7 个事件。**唯一的证据在读取层**，所以只能在这里记。
 */
async function readStreamKeepingPartial(
  response: Response,
): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (body === null) {
    // 没有流可用（某些实现会给 null body）：退回整段读，读不到才算截断
    try {
      return { text: await response.text(), truncated: false };
    } catch {
      return { text: '', truncated: true };
    }
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let truncated = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done === true) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    /*
     * 流被掐断：保留已读到的部分，**并记下这件事**。
     * 典型原因：服务端进程退出（实测过：之后整个端口 ECONNREFUSED，ping 仍通）。
     */
    truncated = true;
  }
  return { text, truncated };
}

/**
 * 路线 C：Gradio 的三步调用。
 *
 * ```text
 * ① GET  /config                 → 确认是 Gradio、拿 api_prefix
 * ② GET  {prefix}/info           → 拿端点参数表（决定 data 数组怎么排）
 * ③ POST {prefix}/upload         → 音频上传到服务端，拿服务端路径
 * ④ POST {prefix}/call/{端点}    → 提交任务，拿 event_id
 * ⑤ GET  {prefix}/call/{端点}/{event_id} → SSE，等 complete
 * ```
 *
 * 比需求里说的"两步"多了 ①②：这两步是**为了让 ④ 的参数数组是对的**。
 * 不探测就只能写死位置，换一个应用立刻错位（详见 `shared/src/asr/gradio.ts`）。
 */
async function transcribeViaGradio(req: AsrRequest): Promise<AsrResult> {
  const doFetch = req.fetchImpl ?? globalThis.fetch;
  if (doFetch === undefined) {
    return { ok: false, failure: { kind: 'network', message: '这个环境不能发网络请求。' } };
  }

  const protocol = req.preset.protocol;
  const base = normalizeGradioBase(req.baseUrl);
  const fail = (failure: AsrFailure): AsrResult => ({ ok: false, failure });

  /* ① /config —— 确认这是 Gradio，并拿到 api_prefix */
  const configOutcome = await requestOrFailure(
    doFetch,
    buildConfigUrl(base),
    { method: 'GET' },
    GRADIO_PROBE_TIMEOUT_MS,
    protocol,
  );
  if (!configOutcome.ok) return fail(configOutcome.failure);
  if (!configOutcome.response.ok) {
    return fail(
      classifyAsrFailure({ status: configOutcome.response.status, protocol }),
    );
  }

  let configJson: unknown;
  try {
    configJson = await configOutcome.response.json();
  } catch {
    return fail({
      kind: 'unsupported-endpoint',
      message: '这个地址返回的不是 Gradio 的配置，请确认填的是 Gradio 应用的地址。',
    });
  }
  const config = parseGradioConfig(configJson);

  /* ② /info —— 端点参数表 */
  const infoOutcome = await requestOrFailure(
    doFetch,
    buildInfoUrl(base, config.apiPrefix),
    { method: 'GET' },
    GRADIO_PROBE_TIMEOUT_MS,
    protocol,
  );
  if (!infoOutcome.ok) return fail(infoOutcome.failure);
  if (!infoOutcome.response.ok) {
    return fail(classifyAsrFailure({ status: infoOutcome.response.status, protocol }));
  }

  let infoJson: unknown;
  try {
    infoJson = await infoOutcome.response.json();
  } catch {
    return fail({ kind: 'unsupported-endpoint', message: '服务没有返回可用的接口列表。' });
  }

  const endpoint = pickTranscribeEndpoint(parseGradioInfo(infoJson), req.preset.endpoint);
  if (endpoint === null) {
    /*
     * 这一步失败时**必须说清"为什么不像"**，否则用户会以为地址是对的。
     * 常见真相：地址填到了别的 Gradio 应用上（那里确实有个页面）。
     */
    return fail({
      kind: 'unsupported-endpoint',
      message:
        '这个 Gradio 应用里没有找到语音转写接口。请确认地址指向的是语音识别服务（页面上有音频上传按钮）。',
    });
  }

  /* ③ /upload */
  const ext = extensionFor(req.audio, req.extension);
  const filename = `voice.${ext}`;
  const form = new FormData();
  form.append('files', req.audio, filename);

  const uploadOutcome = await requestOrFailure(
    doFetch,
    buildUploadUrl(base, config.apiPrefix),
    { method: 'POST', body: form },
    GRADIO_PROBE_TIMEOUT_MS,
    protocol,
  );
  if (!uploadOutcome.ok) return fail(uploadOutcome.failure);
  if (!uploadOutcome.response.ok) {
    return fail(classifyAsrFailure({ status: uploadOutcome.response.status, protocol }));
  }

  let uploadJson: unknown;
  try {
    uploadJson = await uploadOutcome.response.json();
  } catch {
    return fail({ kind: 'other', message: '服务没有接受这个音频（上传接口返回的内容无法解析）。' });
  }
  const serverPath = parseUploadResponse(uploadJson);
  if (serverPath === null) {
    return fail({
      kind: 'other',
      message: '服务没有接受这个音频。可能是文件格式不被支持，或服务端存储目录不可写。',
    });
  }

  /*
   * ③b 把"模型类型 / 模型路径"校正到**服务端接受的写法**（2026-11-02）。
   *
   * ## 为什么必须做
   *
   * 服务端对下拉框参数有服务端校验：值必须在 `/config` 的 `props.choices`
   * 里，否则报 `Value: xxx is not in the list of choices`。
   *
   * 而 App 里"模型路径"是用户手填的，placeholder 写的是
   * `./models/Fun-ASR-Nano`（**正斜杠**）—— 服务端只认
   * `./models\Fun-ASR-Nano`（**反斜杠**）。实测：
   *
   * ```text
   *   正斜杠 → ok=false（客户端 error data 为空，什么都看不到）
   *   反斜杠 → ok=true  正文「都是文本。」
   * ```
   *
   * 更糟的是真机上存的配置就是正斜杠 ⇒ **100% 转写不了**。
   *
   * ## 顺带实现"路径可留空"
   *
   * 用户不填时用服务端列表里的第一项（那是它自己承认的合法值），
   * 所以"模型路径"这格将来可以干脆从界面上拿掉。
   */
  const dropdowns = parseGradioDropdowns(configJson);
  const typeDropdown = findDropdownByLabel(dropdowns, (l) => /模型|model/.test(l) && !/路径|path|目录|dir/.test(l));
  const pathDropdown = findDropdownByLabel(dropdowns, (l) => /路径|path|目录|dir/.test(l));

  const coercedModel = typeDropdown === null ? null : coerceToChoices(req.model ?? '', typeDropdown.choices);
  const coercedPath =
    pathDropdown === null ? null : coerceToChoices(req.modelPath ?? '', pathDropdown.choices);

  const effectiveModel = coercedModel?.value ?? req.model;
  const effectivePath = coercedPath?.value ?? req.modelPath ?? '';

  /* ④ /call —— 提交任务 */
  const args = buildGradioArgs(endpoint, {
    fileData: buildFileData(serverPath, filename),
    model: effectiveModel,
    ...(effectivePath !== '' ? { modelPath: effectivePath } : {}),
  });

  const callOutcome = await requestOrFailure(
    doFetch,
    buildCallUrl(base, config.apiPrefix, endpoint.name),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: args }),
    },
    GRADIO_PROBE_TIMEOUT_MS,
    protocol,
  );
  if (!callOutcome.ok) return fail(callOutcome.failure);
  if (!callOutcome.response.ok) {
    return fail(classifyAsrFailure({ status: callOutcome.response.status, protocol }));
  }

  let callJson: unknown;
  try {
    callJson = await callOutcome.response.json();
  } catch {
    return fail({ kind: 'other', message: '服务没有返回任务编号，无法等待结果。' });
  }
  const eventId = (callJson as { event_id?: unknown }).event_id;
  if (typeof eventId !== 'string' || eventId === '') {
    return fail({ kind: 'other', message: '服务没有返回任务编号，无法等待结果。' });
  }

  /* ⑤ /call/{id} —— 等结果 */
  const pollOutcome = await requestOrFailure(
    doFetch,
    buildPollUrl(base, config.apiPrefix, endpoint.name, eventId),
    { method: 'GET' },
    req.timeoutMs ?? GRADIO_POLL_TIMEOUT_MS,
    protocol,
  );
  if (!pollOutcome.ok) return fail(pollOutcome.failure);
  if (!pollOutcome.response.ok) {
    return fail(classifyAsrFailure({ status: pollOutcome.response.status, protocol }));
  }

  const { text: raw, truncated } = await readStreamKeepingPartial(pollOutcome.response);
  const events = parseSse(raw);

  /*
   * 判定结局。
   *
   * ★ 这一层是第八批加的。原来只有"有 error → 报错 / 有 complete → 取文字"
   *   两个分支，把**五种结局压成两种**，其中两种归类是错的：
   *   · 流被掐断（服务崩了）→ 报成"服务跑完了但没有返回文字"
   *   · error 但 data 是 `{}` → 报成一句没有任何可核查信息的话
   *
   *   实测（2026-11-01 15:41）：SSE 只收到 7 个 heartbeat / 203 字节就被
   *   `terminated`，之后整个 7860 `ECONNREFUSED`（ping 仍通 28ms）。
   *   详见 `.verify/round8-evidence.md`。
   */
  const verdict = judgeGradioSse(events, { truncated, receivedBytes: raw.length });

  if (verdict.kind === 'complete') {
    /*
     * 空串**不算失败**：返回 `ok: true` 由上层走
     * `classifyEmptyTranscript()` 的"空转写"分流。
     * 在这里判失败会让"说了但没识别出来"和"服务坏了"混成一句话。
     */
    return { ok: true, text: verdict.text };
  }

  if (verdict.kind === 'server-error') {
    // 服务端的原话，不改写 —— 它比我们猜的准
    return fail({ kind: 'other', message: `语音服务报错：${verdict.reason}` });
  }

  if (verdict.kind === 'server-error-blank') {
    /*
     * 服务端报了错但没给原因。
     *
     * 这时候唯一有价值的不是"再猜一遍为什么"，而是**把可核查的事实给出来**：
     * 收到多少字节、连接有没有被掐断。用户拿这两项去对那台机器的日志就能定位。
     */
    const detail =
      verdict.receivedBytes === 0
        ? '服务端在返回任何内容之前就报错了'
        : `服务端在报错前只传回了 ${String(verdict.receivedBytes)} 字节` +
          (verdict.truncated ? '，随后连接就被断开' : '');
    return fail({
      kind: 'other',
      message:
        `语音服务报错，但没有给出原因（${detail}）。` +
        '这通常意味着服务端在推理时出错或退出了，请查看那台机器上服务的控制台输出。',
    });
  }

  if (verdict.kind === 'truncated') {
    /*
     * ★ 这一条是实测遇到的那个：服务在推理时退出，TCP 被断开。
     *
     * 绝不能报成"服务跑完了但没有返回文字" —— 它没跑完，它没了。
     * 提示要指向那台机器（进程/显存/日志），而不是音频内容。
     */
    const seen = verdict.lastEvent === null ? '没有任何进展事件' : `最后一个事件是 ${verdict.lastEvent}`;
    return fail({
      kind: 'other',
      message:
        `语音服务在返回结果前把连接断开了（收到 ${String(verdict.receivedBytes)} 字节，${seen}）。` +
        '常见原因是那台机器上的服务在加载模型或推理时退出（显存不足、模型目录不对、'
        + '或进程被系统结束）。请查看服务端控制台的报错。',
    });
  }

  // no-result：流正常结束，但服务没有给终值
  return fail({
    kind: 'other',
    message:
      `服务跑完了但没有返回转写结果（收到 ${String(verdict.receivedBytes)} 字节）。` +
      '可能是这段音频里没有人声，也可能是服务端的转写步骤没有产出。',
  });
}

/** Blob → base64（不依赖 FileReader，Node 里也能跑） */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // 分块拼，避免大文件时 `String.fromCharCode(...bytes)` 爆栈
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
}

/**
 * 造一个 `VoiceTransport.transcribe`。
 *
 * `getConfig` 每次转写都重新读配置 —— 用户在设置页改完立刻生效，
 * 不必重启面板。缓存配置会让"改完没反应"变成一个新的困惑源。
 */
export function createTranscriber(
  getConfig: () => {
    preset: AsrPreset;
    baseUrl: string;
    apiKey: string;
    model: string;
    /** 仅 gradio 路线：模型权重目录 */
    modelPath?: string;
  } | null,
): (audio: Blob) => Promise<string> {
  return async (audio: Blob) => {
    const config = getConfig();
    if (config === null) {
      throw new Error('还没配置语音识别。去「我的 → 语音输入」里选一个厂商并填 key。');
    }
    const result = await transcribe({ ...config, audio });
    if (!result.ok) {
      // 抛出的是**已经分流好的文案**，UI 直接显示
      throw new Error(result.failure.message);
    }
    return result.text;
  };
}
