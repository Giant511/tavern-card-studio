/**
 * Gradio 协议路线（v0.1.7 / 决策 #338）。
 *
 * ## 为什么这是第三条路线，而不是"再给 OpenAI 兼容加个变体"
 *
 * 前两条路线（`transcriptions` / `chat-audio`）的共同前提是
 * **服务端实现了 OpenAI 的接口形状**。而 Gradio 应用完全没有这个前提 ——
 * 它暴露的是"页面上有几个输入框、点了按钮调用哪个函数"，
 * 请求体是一个**按位置排的参数数组**。
 *
 * 所以：
 *
 * | 路线 | 请求体 | 一次调用 |
 * |---|---|---|
 * | `transcriptions` | multipart（`file` + `model`） | 1 次 POST，响应即结果 |
 * | `chat-audio` | JSON（`input_audio`） | 1 次 POST，响应即结果 |
 * | `gradio` | JSON（`{data: [...]}` 位置数组） | **3 次**：upload → call → poll |
 *
 * 前两条是"一次问答"，Gradio 是"提交任务 + 等结果"，这是**异步任务模型**，
 * 所以它不可能塞进同一条代码路径。
 *
 * ## 三步的形状（真机对齐 2026-11-01，服务为 Gradio 6.2.0）
 *
 * ```text
 * ① POST {prefix}/upload                      multipart files=<音频>
 *    → ["C:\\...\\gradio\\<hash>\\voice.wav"]   （服务端路径，可能多条）
 * ② POST {prefix}/call/{endpoint}             {"data": [参数...]}
 *    → {"event_id": "dc543b65..."}
 * ③ GET  {prefix}/call/{endpoint}/{event_id}  （SSE 流）
 *    → event: complete
 *      data: [指标, "转写文本", 文件信息]
 * ```
 *
 * ## ★ 参数数组怎么来 —— 这是本文件最重要的一处取舍
 *
 * 第②步的 `data` 是**按位置**排的，把音频插错位置不会报"位置错"，
 * 而是让服务端拿着一个字符串当音频、拿着文件当模型类型 ——
 * 表现为一个莫名其妙的 500，用户完全无法自查。
 *
 * 三种做法：
 *
 * 1. **写死 11 个位置**（对着 Fun-ASR 当前版本数）。最短，但换一个
 *    应用（Whisper-WebUI）就全错，且错得没有征兆。
 * 2. **让用户手填参数表**。不可能 —— 他打开这个页面的目的是"填个地址就能用"。
 * 3. **问服务端**：`GET {prefix}/info` 会返回端点的**参数表**
 *    （每个参数的组件类型、有没有默认值、默认值是多少）。
 *    按"组件类型 + 默认值"填，就与具体应用解耦。
 *
 * 本文件选 3。多一次 GET 换来的是"换一个 Gradio 应用也能用"，
 * 以及一个可解释的失败（拿不到参数表时说"这个地址不像 Gradio 4+ 服务"，
 * 而不是抛一个 500）。
 *
 * 补充：不缓存参数表。缓存能让"每次转写少一次请求"，但代价是
 * 用户改了服务端（换模型目录、加参数）后我们还在用旧表 ——
 * 那是"改完没反应"这类最难查的故障。局域网内一次 17KB 的 GET 不值得冒这个险。
 */

import type { AsrPreset } from './preset-table.js';

/* ───────────────────────── 地址 ───────────────────────── */

/** Gradio 4+ 的默认 API 前缀 */
export const GRADIO_DEFAULT_PREFIX = '/gradio_api';

/**
 * 规整用户填的地址。
 *
 * 三种常见输入都要能吃下：
 * - `http://192.168.1.5:7860` → 原样
 * - `http://192.168.1.5:7860/` → 去掉尾斜杠（否则拼出 `//gradio_api`）
 * - `http://192.168.1.5:7860/gradio_api` → 去掉这段（用户从浏览器地址栏复制的
 *   往往是"页面地址+接口前缀"，他并不知道那是前缀而不是 base）
 *
 * ⚠️ 不做的事：不补 `http://`。用户填 `192.168.1.5:7860` 时补与不补都能连上，
 * 但填 `https://x` 时我们不该擅自降级成 http。判据留给他自己填的协议头。
 */
export function normalizeGradioBase(baseUrl: string): string {
  let base = baseUrl.trim().replace(/\/+$/, '');
  if (base.toLowerCase().endsWith(GRADIO_DEFAULT_PREFIX)) {
    base = base.slice(0, -GRADIO_DEFAULT_PREFIX.length).replace(/\/+$/, '');
  }
  return base;
}

/** 拼 `/config`。单独一个函数是为了让测试钉住"不会拼出双斜杠" */
export function buildConfigUrl(baseUrl: string): string {
  return `${normalizeGradioBase(baseUrl)}/config`;
}

/** 从 `/config` 里读 API 前缀（Gradio 4+ 有；读不到就用默认值） */
export function parseGradioConfig(payload: unknown): { apiPrefix: string; version: string } {
  const empty = { apiPrefix: GRADIO_DEFAULT_PREFIX, version: '' };
  if (payload === null || typeof payload !== 'object') return empty;
  const record = payload as Record<string, unknown>;
  const prefix = record['api_prefix'];
  const version = record['version'];
  return {
    apiPrefix:
      typeof prefix === 'string' && prefix.trim() !== ''
        ? `/${prefix.trim().replace(/^\/+|\/+$/g, '')}`
        : GRADIO_DEFAULT_PREFIX,
    version: typeof version === 'string' ? version : '',
  };
}

export function buildInfoUrl(baseUrl: string, apiPrefix: string): string {
  return `${normalizeGradioBase(baseUrl)}${apiPrefix}/info`;
}

export function buildUploadUrl(baseUrl: string, apiPrefix: string): string {
  return `${normalizeGradioBase(baseUrl)}${apiPrefix}/upload`;
}

/**
 * 拼 `/call` 的地址。
 *
 * `eventId` 为空 → 提交任务；不为空 → 拉结果。
 * 两者**只差一个斜杠和一段 id**，但一个是 POST 一个是 GET，
 * 所以分成两个函数，别让调用方记这件事。
 */
export function buildCallUrl(baseUrl: string, apiPrefix: string, endpoint: string): string {
  const name = endpoint.replace(/^\/+/, '');
  return `${normalizeGradioBase(baseUrl)}${apiPrefix}/call/${name}`;
}

export function buildPollUrl(
  baseUrl: string,
  apiPrefix: string,
  endpoint: string,
  eventId: string,
): string {
  return `${buildCallUrl(baseUrl, apiPrefix, endpoint)}/${encodeURIComponent(eventId)}`;
}

/* ───────────────────── 端点参数表 ───────────────────── */

/** `/info` 里的一个参数 */
export interface GradioParam {
  /** 组件类型：`Audio` / `Textbox` / `Dropdown` / `Number` / `Checkbox` … */
  component: string;
  /** 有没有默认值。没有默认值的参数**必须**给一个值，否则服务端可能崩 */
  hasDefault: boolean;
  defaultValue: unknown;
  /** 界面上那个标签（`🤖 模型类型`）—— 只用于**认人**，不用于判断 */
  label: string;
}

export interface GradioEndpoint {
  /** 端点名，不带前导斜杠（`transcribe_with_progress`） */
  name: string;
  params: GradioParam[];
  /** 输出个数。少于 2 个时"取 [1]"必然落空 */
  returnCount: number;
}

/**
 * 解析 `/info`。
 *
 * ## 为什么返回值是"端点表"而不是"唯一的那个端点"
 *
 * 因为同一个 Gradio 应用有多个端点（Fun-ASR 就有 7 个：改下拉、显示音频信息、
 * 载入示例…）。选哪个是**策略**，放在 `pickTranscribeEndpoint()` 里，
 * 这样策略能被单独测试、也能被预设覆盖。
 */
export function parseGradioInfo(payload: unknown): GradioEndpoint[] {
  if (payload === null || typeof payload !== 'object') return [];
  const named = (payload as Record<string, unknown>)['named_endpoints'];
  if (named === null || typeof named !== 'object') return [];

  const endpoints: GradioEndpoint[] = [];
  for (const [key, value] of Object.entries(named as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const rawParams = Array.isArray(record['parameters']) ? record['parameters'] : [];
    const params: GradioParam[] = [];
    for (const raw of rawParams) {
      if (raw === null || typeof raw !== 'object') continue;
      const p = raw as Record<string, unknown>;
      params.push({
        component: typeof p['component'] === 'string' ? p['component'] : '',
        hasDefault: p['parameter_has_default'] === true,
        defaultValue: p['parameter_default'],
        label: typeof p['label'] === 'string' ? p['label'] : '',
      });
    }
    endpoints.push({
      name: key.replace(/^\/+/, ''),
      params,
      returnCount: Array.isArray(record['returns']) ? record['returns'].length : 0,
    });
  }
  return endpoints;
}

/**
 * 挑一个"转写"端点。
 *
 * ## 判据的顺序与理由
 *
 * 1. 指定了名字就用指定的（用户的部署是确定的，不该被启发式覆盖）；
 * 2. 否则取**有 Audio 输入 + 输出 ≥ 2** 的那个 —— 输出 ≥2 是因为
 *    转写应用普遍返回"指标 + 文本"（[1] 才是文本），
 *    只返回一个字符串的端点更像"改下拉"这类杂项；
 * 3. 名字里带 `transcrib` 的优先（同样合格时，名字是唯一无歧义的信息）。
 *
 * 返回 `null` 表示"不像一个转写服务"，由调用方给出可解释的失败。
 */
export function pickTranscribeEndpoint(
  endpoints: readonly GradioEndpoint[],
  preferred?: string,
): GradioEndpoint | null {
  if (preferred !== undefined && preferred.trim() !== '') {
    const wanted = preferred.trim().replace(/^\/+/, '');
    return endpoints.find((ep) => ep.name === wanted) ?? null;
  }

  const candidates = endpoints.filter(
    (ep) => ep.params.some((p) => p.component === 'Audio') && ep.returnCount >= 2,
  );
  if (candidates.length === 0) return null;
  const named = candidates.find((ep) => /transcrib/i.test(ep.name));
  return named ?? candidates[0] ?? null;
}

/* ───────────────────── 参数数组 ───────────────────── */

/** 已上传音频在服务端的表示（Gradio 4+ 的 `FileData`） */
export interface GradioFileData {
  path: string;
  orig_name?: string;
  meta?: { _type: 'gradio.FileData' };
}

export function buildFileData(serverPath: string, filename: string): GradioFileData {
  return {
    path: serverPath,
    orig_name: filename,
    // Gradio 5+ 用 `meta._type` 认这是文件；缺了它会被当成普通对象
    meta: { _type: 'gradio.FileData' },
  };
}

export interface GradioArgsInput {
  fileData: GradioFileData;
  /** 用户配置的模型名（`fun-asr-nano`） */
  model: string;
  /** 用户配置的模型路径（`./models/Fun-ASR-Nano`），可空 */
  modelPath?: string;
}

/**
 * 按参数表拼出 `data` 数组。
 *
 * ## 填充规则（每条都对应一个真实的坑）
 *
 * | 参数 | 填什么 | 为什么 |
 * |---|---|---|
 * | `Audio` | 上传后的文件 | 这就是音频本体 |
 * | 其它 | 有默认值 → 用默认值 | **默认值是服务端自己的合法取值**，比我们猜的准 |
 * | 没有默认值 | `null` | 这些是可选（开始/结束时间、音频链接），`null` 是 Gradio 的空值 |
 * | 认得出是模型名 → | 用用户配置覆盖默认值 | 用户改了模型就得生效，不能被默认值吃掉 |
 *
 * ## 为什么"认得出来才覆盖"，而不是"按位置硬覆盖"
 *
 * 位置随应用版本变（同一个应用加一个参数，后面全部右移一位）。
 * 所以只在**能确认身份**时覆盖，认不出就用服务端默认值 ——
 * 后者恰好也等于我们想填的值（`fun-asr-nano` 就是它的默认值）。
 * 这条设计的失败模式是"用户改了模型但没生效"，
 * 而按位置硬覆盖的失败模式是"整套参数错位、服务端 500"。
 * 前者可解释，后者不可查。
 */
export function buildGradioArgs(endpoint: GradioEndpoint, input: GradioArgsInput): unknown[] {
  return endpoint.params.map((param) => {
    if (param.component === 'Audio') return input.fileData;

    const identity = `${param.label}`.toLowerCase();

    // 模型名：标签里带"模型"且不带"路径"，或有默认值且与配置的模型同名
    const looksLikeModelPath = /路径|path|目录|dir/.test(identity);
    const looksLikeModelType = /模型|model/.test(identity) && !looksLikeModelPath;

    if (looksLikeModelType && !looksLikeModelPath && input.model.trim() !== '') {
      return input.model.trim();
    }
    if (looksLikeModelPath && input.modelPath !== undefined && input.modelPath.trim() !== '') {
      return input.modelPath.trim();
    }
    // 有默认值的、以及我们认得出的常见下拉（下载方式等），一律交给服务端默认值
    if (param.hasDefault) return param.defaultValue;
    /*
     * 没有默认值的 Textbox 是"或输入音频链接地址"这类**可选替代输入**。
     * 传 `null` 等价于"这条路径没用"，服务端会走上传文件那条。
     * 传空串反而可能被当成"你给了一个空链接"。
     */
    return null;
  });
}

/* ───────────────────── 上传响应 ───────────────────── */

/**
 * 解析 `/upload` 的响应，取服务端路径。
 *
 * 真实响应是一个**数组**（一次可传多个文件）：`["C:\\...\\voice.wav"]`。
 * 兼容三种形态：纯字符串数组、`FileData` 对象数组、单个对象。
 * 都取不到就返回 `null`，让上层说"服务没有接收这个音频"。
 */
export function parseUploadResponse(payload: unknown): string | null {
  const first = Array.isArray(payload) ? payload[0] : payload;
  if (typeof first === 'string' && first.trim() !== '') return first;
  if (first !== null && typeof first === 'object') {
    const path = (first as Record<string, unknown>)['path'];
    if (typeof path === 'string' && path.trim() !== '') return path;
  }
  return null;
}

/* ───────────────────── 结果（SSE） ───────────────────── */

export interface GradioSseEvent {
  event: string;
  data: string;
}

/**
 * 解析 SSE 流。
 *
 * ## 为什么不用 `EventSource`
 *
 * 因为 `EventSource` 不允许带请求头、也不能复用已 POST 出来的 `event_id` ——
 * 它只能连一个 GET。而我们要的是"POST 提交拿到 id，再 GET 拉结果"，
 * 用 `EventSource` 反而要绕。用 `fetch` + 手工切块更直接，且能在 Node 里跑（测试要）。
 *
 * 容错：`event:` 行缺失时按 `message` 处理（有的代理会改写）。
 */
export function parseSse(raw: string): GradioSseEvent[] {
  const events: GradioSseEvent[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (dataLines.length > 0) events.push({ event, data: dataLines.join('\n') });
  }
  return events;
}

/**
 * 从 SSE 里取转写文本。
 *
 * ## 固定取 `[1]`（用户明确要求：三元组取第二个）
 *
 * 真机形态（Fun-ASR 6.2.0，输出为 `[指标, 文本, 文件]`）：
 *
 * ```json
 * [{"转写耗时":"3.2s"}, "你好世界", {"path":"...", "url":"..."}]
 * ```
 *
 * 取 `[1]` 而不是"找第一个字符串"：指标那一项也可能是字符串
 * （不同版本里它可能是纯文本日志），"找第一个字符串"会把日志当成转写结果。
 *
 * 返回 `null` 表示**没有拿到结果**（不是"结果为空串"）——
 * 两者的处置完全不同：前者是链路问题，后者要交给
 * `classifyEmptyTranscript()` 走"空转写"分流。
 */
export function extractTranscript(events: readonly GradioSseEvent[]): string | null {
  // 有 complete 就只看 complete；流式中间态（generating）里的 data 不是终值
  const complete = events.filter((e) => e.event === 'complete');
  const source = complete.length > 0 ? complete : events.filter((e) => e.event === 'generating');
  if (source.length === 0) return null;

  const last = source[source.length - 1];
  if (last === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(last.data);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const second = parsed[1];
  if (typeof second === 'string') return second;
  /*
   * 少数应用把文本放在对象里（`{text: "..."}`）。
   * 这种情况取出来是"尽力而为"，但它仍然比返回 null 好 ——
   * 前者能识别出文字，后者会报"服务没返回结果"，把一次成功的转写说成失败。
   */
  if (second !== null && typeof second === 'object') {
    const text = (second as Record<string, unknown>)['text'];
    if (typeof text === 'string') return text;
  }
  return null;
}

/**
 * `extractGradioError` 在"取不到可读原因"时给的兜底话。
 *
 * ## 为什么要抽成常量
 *
 * 判定层（`gradio-verdict.ts`）需要知道"这句话是我们自己编的，不是服务端原话" ——
 * 只有这样才能把"服务端说了什么"与"我们兜底了一句"分开处理：
 * 后者必须补充诊断信息（收到多少字节、有没有被掐断）才有用。
 *
 * 如果两处各写一遍字符串，改一处忘另一处就是**静默失效**：
 * 判定层认不出来，又退回那句无信息量的话。
 */
export const BLANK_REASON = '服务端返回了错误但没有说明原因。';

/** SSE 里有没有 `error` 事件；有就把它的话原样带出来（那是服务端的原话） */
export function extractGradioError(events: readonly GradioSseEvent[]): string | null {
  const error = events.find((e) => e.event === 'error');
  if (error === undefined) return null;

  const raw = error.data.trim();
  let parsed: unknown;
  let isJson = true;
  try {
    parsed = JSON.parse(raw);
  } catch {
    isJson = false;
    parsed = null;
  }

  /*
   * 是 JSON 对象：只认 `error` 字段。
   *
   * ⚠️ 这里**不许**退回去把 `raw` 当文案用：`data: {}` 的原文是 `"{}"`，
   * 拿它当提示等于给用户看两个花括号 —— 比"没有说明原因"更糟。
   * 这个分支是变异验证抓出来的（初版就是这么错的）。
   */
  if (isJson) {
    if (parsed !== null && typeof parsed === 'object') {
      const message = (parsed as Record<string, unknown>)['error'];
      if (typeof message === 'string' && message.trim() !== '') return message.trim();
    }
    return BLANK_REASON;
  }

  // 不是 JSON：服务端给的是纯文本，那就是它的原话
  return raw === '' ? BLANK_REASON : raw.slice(0, 200);
}

/* ───────────────────── 预设适配 ───────────────────── */

/** 这条预设是不是 Gradio 路线 */
export function isGradioPreset(preset: AsrPreset): boolean {
  return preset.protocol === 'gradio';
}

/**
 * Gradio 路线的地址提示语（配置页用）。
 *
 * 需求原话：「填部署机器的局域网地址，如 http://192.168.1.x:7860」。
 * 这句必须出现在**输入框旁边**而不是说明文档里 ——
 * 用户填错地址的唯一线索就是这一行。
 */
export const GRADIO_BASE_URL_HINT = '填部署机器的局域网地址，如 http://192.168.1.x:7860';

/** 模型路径字段的说明 */
export const GRADIO_MODEL_PATH_HINT = '权重所在的目录。服务默认给的就够用，一般不用改。';

/* ───────────────────── 下拉框合法值（2026-11-02） ───────────────────── */

/**
 * 一个下拉框在当前服务端的**合法值列表**。
 *
 * ## 为什么需要它
 *
 * 服务端对下拉框参数有**服务端校验**：值必须在这个列表里，否则
 * `gradio.exceptions.Error: Value: xxx is not in the list of choices: [...]`。
 *
 * 而 App 里"模型路径"是用户手填的文本框，placeholder 写的是
 * `./models/Fun-ASR-Nano`（**正斜杠**），服务端实际只接受
 * `./models\Fun-ASR-Nano`（**反斜杠**）—— 用户照着填必然被拒，
 * 而客户端拿到的 `error` 事件 data 是**空的**，什么都看不到。
 *
 * 实测（2026-11-02）：正斜杠 → `ok=false`；反斜杠 → 正常转写。
 * 详见 memory §77.2。
 */
export interface GradioDropdown {
  /** 组件类型（归一成小写），只保留 dropdown */
  label: string;
  /** 合法值（已展开 `[label, value]` 二元组，只留 value） */
  choices: string[];
  /** 服务端当前值 */
  current: string | null;
}

/** 从 `/config` 的 `components` 里收集所有下拉框的合法值 */
export function parseGradioDropdowns(payload: unknown): GradioDropdown[] {
  if (payload === null || typeof payload !== 'object') return [];
  const components = (payload as Record<string, unknown>)['components'];
  if (!Array.isArray(components)) return [];

  const out: GradioDropdown[] = [];
  for (const c of components) {
    if (c === null || typeof c !== 'object') continue;
    const rec = c as Record<string, unknown>;
    if (String(rec['type'] ?? '').toLowerCase() !== 'dropdown') continue;
    const props = rec['props'];
    if (props === null || typeof props !== 'object') continue;
    const p = props as Record<string, unknown>;

    const rawChoices = p['choices'];
    const choices: string[] = [];
    if (Array.isArray(rawChoices)) {
      for (const item of rawChoices) {
        /*
         * Gradio 允许两种形状：
         *   `["a", "b"]`            —— 纯值
         *   `[["显示名", "值"]]`     —— (label, value) 二元组
         * 只取**值**：传上去的是值，不是显示名。
         */
        if (typeof item === 'string') choices.push(item);
        else if (Array.isArray(item) && typeof item[1] === 'string') choices.push(item[1]);
      }
    }
    const value = p['value'];
    out.push({
      label: typeof p['label'] === 'string' ? p['label'] : '',
      choices,
      current: typeof value === 'string' ? value : null,
    });
  }
  return out;
}

/** 按标签找下拉框（`match` 命中任一标签词即可） */
export function findDropdownByLabel(
  dropdowns: readonly GradioDropdown[],
  match: (label: string) => boolean,
): GradioDropdown | null {
  for (const d of dropdowns) if (match(d.label.toLowerCase())) return d;
  return null;
}

/**
 * 把用户输入**校正**到服务端接受的写法。
 *
 * ## 规则（按优先级）
 *
 * 1. 列表为空 → 返回 `null`（无法校正，交给调用方用原值）
 * 2. 输入为空 → 用列表第一项（这就是"模型路径可以留空"的实现）
 * 3. 完全相等 → 原样
 * 4. **归一后相等** → 用列表里那个
 *    （归一 = 斜杠统一成 `\`、去掉首尾空值与重复分隔符、小写）
 * 5. 都不匹配 → 用列表第一项，并标 `fallback: true`
 *
 * ## 为什么第 4 步要专门处理斜杠
 *
 * 这是实测踩到的**唯一**真实差异：同一个路径，用户按 placeholder 写
 * 正斜杠、服务端只认反斜杠。不归一的话，"填对了"和"填错了"在界面上
 * 长得一模一样，只有服务端控制台能看到原因。
 *
 * ## 为什么第 5 步是"回落"而不是"报错"
 *
 * 服务端的下拉往往只有一个合法值（当前就是），此时用户填什么都不会是
 * 他的本意 —— 让链路跑通比纠正他的输入更有价值。但必须标出
 * `fallback: true`，好让上层能提示"已改用服务端的值"。
 */
export function coerceToChoices(
  wanted: string,
  choices: readonly string[],
): { value: string; exact: boolean; fallback: boolean } | null {
  if (choices.length === 0) return null;

  const trimmed = wanted.trim();
  if (trimmed === '') return { value: choices[0] as string, exact: false, fallback: true };

  if (choices.includes(trimmed)) return { value: trimmed, exact: true, fallback: false };

  const norm = (s: string): string =>
    s
      .trim()
      .toLowerCase()
      .replace(/\//g, '\\')
      .replace(/\\+/g, '\\')
      .replace(/\\$/g, '');

  const target = norm(trimmed);
  for (const c of choices) {
    if (norm(c) === target) return { value: c, exact: false, fallback: false };
  }

  return { value: choices[0] as string, exact: false, fallback: true };
}
