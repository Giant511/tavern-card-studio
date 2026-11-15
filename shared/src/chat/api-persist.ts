/**
 * API 连接配置 → SillyTavern 的落盘规则（2026-11-04，第二十八批）。
 *
 * ## 为什么需要这个文件
 *
 * 用户批准排查「API 配置保存链路」，取证结论是：
 *
 * ```text
 *   App 点保存 → 只写了 localStorage（tcs.mobile.apiState）
 *              → ST 的 secrets 从来没写过
 *              → ST 的 settings 只写了 max_tokens，source/model/url 一项没写
 * ```
 *
 * 于是 ST 里始终是出厂值 `openai / gpt-4-turbo`，而 App 里是
 * `custom / deepseek-v4-pro` —— 两边不一致。App 内聊天能通，是因为
 * 请求体用的是**本地那份**；但 ST 逃生门里看到的永远是旧的。
 *
 * ## 这里只放"映射与校验"的纯逻辑
 *
 * 真正的网络写入在 `shell.ts`（它要过连接门）。把它们分开的好处：
 * "custom 源该写 `custom_model` 还是 `openai_model`"这种规则可以在
 * Node 里逐条断言，不必上真机猜。
 */

import type { StChatSource } from '../st-adapter/types.js';

/**
 * 这个地址是不是"本机/局域网" —— 也就是**可能不需要 API key** 的那种。
 *
 * ## 为什么需要它
 *
 * 有些接口是用户自己在电脑/同一台手机上跑的（ollama、koboldcpp、vLLM、
 * LM Studio）。它们通常不校验 key —— 空着也能用。
 *
 * 而「没有 key」这件事在别处是明确的错误。所以就得分：
 *
 * ```text
 *   公网地址 + 没有 key  ⇒ 一定失败，必须提示
 *   本地地址 + 没有 key  ⇒ 可能正常，不打扰
 * ```
 *
 * ## 判据
 *
 * ```text
 *   127.0.0.0/8、::1             回环
 *   localhost                    回环的域名写法
 *   10.0.2.2                     Android 模拟器访问宿主机的地址
 *   192.168.* / 10.* / 172.16~31.*  局域网私有段
 *   *.local                       mDNS
 * ```
 *
 * ★ 不判端口、不判路径：只看主机部分。用户可能把本地服务放在任何端口。
 *
 * ★ 宁可**漏判成公网**（多提示一次），也不要漏判成本地（该提示时不提示）——
 *   前者只是啰嗦，后者会让用户又掉进"看起来配好了其实 401"那个坑。
 */
export function isLocalEndpoint(baseUrl: string): boolean {
  const raw = baseUrl.trim();
  if (raw === '') return false;

  /* 取主机名：去掉协议与路径，再去掉端口 */
  let host = raw;
  const schemeAt = host.indexOf('://');
  if (schemeAt >= 0) host = host.slice(schemeAt + 3);
  const slashAt = host.search(/[/?#]/);
  if (slashAt >= 0) host = host.slice(0, slashAt);
  /* IPv6 字面量是 [::1]:8000 这种形状，端口在 ] 之后 */
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    host = close > 0 ? host.slice(1, close) : host.slice(1);
  } else {
    const colonAt = host.lastIndexOf(':');
    if (colonAt >= 0) host = host.slice(0, colonAt);
  }
  host = host.toLowerCase();
  if (host === '') return false;

  if (host === 'localhost' || host.endsWith('.local')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  /* Android 模拟器里 10.0.2.2 是宿主机 */
  if (host === '10.0.2.2') return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 === null) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * 每个源的**官方**接口地址（用于判断"用户填的是不是官方地址"）。
 *
 * 取自 ST 的 `chat-completions.js`（`API_OPENAI` / `API_DEEPSEEK` …）。
 * 只列有固定官方的那些；`custom` 本身没有官方地址。
 */
const OFFICIAL_HOSTS: Partial<Record<StChatSource, readonly string[]>> = {
  openai: ['api.openai.com'],
  deepseek: ['api.deepseek.com'],
  openrouter: ['openrouter.ai'],
  groq: ['api.groq.com'],
  claude: ['api.anthropic.com'],
};

/**
 * 这个地址**属于这个源**吗（即"打进去就是官方端点"）。
 *
 * ## 为什么需要这个判断（2026-11-11，真机取证）
 *
 * 用户报「秘钥存储还是有问题」，截图是：
 *
 * ```text
 *   400 {"code":"","message":"Key 错误: Key 填错、过期或未设置 Bearer。请检查 Key。"}
 * ```
 *
 * 录屏里能看到他做了两件事：
 *
 * ```text
 *   ① 地址填 https://vip4lai.xyz/v1   （中转站）
 *   ② 把源从「自定义」改成了「DeepSeek」
 * ```
 *
 * 而 ST 的分支是这样的（`chat-completions.js`）：
 *
 * ```js
 *   // custom 源
 *   apiUrl = request.body.custom_url;
 *
 *   // deepseek 源
 *   apiUrl = request.body.reverse_proxy || API_DEEPSEEK;   // ← 官方地址
 * ```
 *
 * 我们的代码只有 `source === 'custom'` 才带 `custom_url`，所以源一切成
 * DeepSeek，**地址就被丢掉了** —— 请求发到 `api.deepseek.com`，
 * 却拿着中转站的 key ⇒ 上游回「Key 错误」。
 *
 * **key 一直是存好的，是请求发错了地方。** 用户当然会觉得"秘钥存储有问题"。
 */
export function isOfficialUrlFor(source: StChatSource, url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  if (trimmed === '') return true;
  const hosts = OFFICIAL_HOSTS[source];
  if (hosts === undefined) return false;
  return hosts.some((host) => trimmed.includes(host));
}

/**
 * 「填了自定义地址，但源不是 custom」⇒ 实际该用哪个源。
 *
 * 返回 `'custom'` 表示**必须按 custom 源发**，否则地址不生效。
 *
 * ## 为什么是纠正而不是报错
 *
 * 用户填地址的唯一意图就是"请求打到这个地址"。而 ST 里只有 `custom` 源
 * 会读 `custom_url` —— 所以"填了地址"这件事本身就等价于"要用 custom 源"。
 * 界面上的源选择在这时是**多余且有害**的：它让用户以为选了 DeepSeek
 * 就能用 DeepSeek 的 key 打自己的中转站。
 *
 * ## 只在"确实有地址且不是官方地址"时纠正
 *
 * ```text
 *   地址为空            → 不纠正（用户就是想用官方）
 *   地址是官方地址      → 不纠正（选什么源就用什么源）
 *   地址非空且非官方    → 纠正为 custom（否则地址会被静默丢掉）
 * ```
 */
export function effectiveSourceFor(source: StChatSource, baseUrl: string): StChatSource {
  const trimmed = baseUrl.trim();
  if (trimmed === '') return source;
  if (source === 'custom') return source;
  if (isOfficialUrlFor(source, trimmed)) return source;
  return 'custom';
}

/** 这次要落盘的连接配置 */
export interface ApiConnectionTarget {
  source: StChatSource;
  model: string;
  /** 自定义地址（只有 `custom` 源用得上） */
  baseUrl: string;
  /**
   * 最大回复长度（`oai_settings.openai_max_tokens`）。
   *
   * ## 为什么必须落进 settings（2026-11-11）
   *
   * 用户报：
   *
   * > 我的 api 里面的最大回复长度改不了……改完保存之后回去一看发现还是 2048
   *
   * 取证结论：这一项**从来没写进 ST 的 settings**。`buildStConnectionPatch`
   * 只写了 `chat_completion_source` / 模型字段 / `custom_url`，漏了它。
   *
   * 后果分两层：
   *
   * ```text
   * ① 用户改了没用 —— 生成时用的是 ST settings 里的值，不是 App 里那个数
   * ② 更糟：那个值还决定上游的**预扣额度**
   * ```
   *
   * 第 ② 条是真机日志里那串 403 的另一半原因：
   *
   * ```text
   *   403 {"code":"pre_consume_token_quota_failed"}
   *   = 按 max_tokens 预扣额度时失败
   * ```
   *
   * 也就是说"改不了"和"403"很可能是**同一件事**：值改不小 ⇒ 预扣下不来 ⇒ 拒绝。
   *
   * 所以这个字段不是"顺手补一个"，它可能是那条 403 的正解。
   */
  maxTokens?: number;
}

/**
 * 源 → ST settings 里的模型字段名。
 *
 * ★ 字段名**必须逐个核对**（2026-11-04 从 `public/scripts/openai.js` 与
 * 真实 settings 里查过）：
 *
 * | 源 | 字段 | 备注 |
 * |---|---|---|
 * | openai | `openai_model` | |
 * | custom | `custom_model` | 另外还要写 `custom_url` |
 * | deepseek | `deepseek_model` | 出厂 settings 里**没这个键**，写进去才出现 |
 * | openrouter | `openrouter_model` | |
 * | groq | `groq_model` | 同上，出厂没有 |
 * | claude | `claude_model` | |
 *
 * 猜错字段名的后果很隐蔽：ST 保存成功、界面显示"已保存"，但 ST 里那个源
 * 的模型还是空 —— 用户到逃生门一看才发现。
 */
export const MODEL_FIELD_BY_SOURCE: Record<StChatSource, string> = {
  openai: 'openai_model',
  custom: 'custom_model',
  deepseek: 'deepseek_model',
  openrouter: 'openrouter_model',
  groq: 'groq_model',
  claude: 'claude_model',
};

/**
 * 源 → ST secrets 里的键名。
 *
 * ST 的约定就是 `api_key_` + 源名（`public/scripts/secrets.js` 里能看到
 * `api_key_custom`、`api_key_openai`、`api_key_claude` … 一整排）。
 * 所以不用枚举，直接拼 —— 少一张会过期的映射表。
 */
export function secretKeyOf(source: StChatSource): string {
  return `api_key_${source}`;
}

/** 哪些源需要写 `custom_url`。只有 custom 有自定义地址这个概念 */
export function usesCustomUrl(source: StChatSource): boolean {
  return source === 'custom';
}

/**
 * 构造要写进 ST `oai_settings` 的补丁。
 *
 * 只包含**这次真的该写的键**：
 * - `chat_completion_source` 永远写（它是"用哪个源"的开关）
 * - 模型字段按源选
 * - `custom_url` 只在 custom 时写，而且**只在非空时写** ——
 *   写空串会把用户之前在 ST 里配的地址清掉
 */
export function buildStConnectionPatch(target: ApiConnectionTarget): Record<string, unknown> {
  /*
   * ★★★ 先算"实际该用哪个源"（2026-11-11）。
   *
   * 用户填了中转站地址却选了 DeepSeek 源 ⇒ 必须按 custom 存，
   * 否则 `custom_url` 不写进 settings、请求发到官方地址、上游回「Key 错误」。
   * 详见 `effectiveSourceFor` 的注释（那里有真机取证）。
   */
  const actual = effectiveSourceFor(target.source, target.baseUrl);

  const patch: Record<string, unknown> = {
    chat_completion_source: actual,
    [MODEL_FIELD_BY_SOURCE[actual]]: target.model,
  };

  /*
   * 地址只在**实际走 custom** 时写（2026-11-11 修）。
   *
   * ## 为什么不是"所有源都写"
   *
   * 我第一版写的是"所有源都写，反正 ST 只有 custom 分支读它"。但那样有个
   * 真实风险：用户在 ST 界面里给 custom 源配过一个地址，现在用 openai 源
   * 保存一次，`custom_url` 就被覆盖成 openai 的地址了 —— 他切回 custom
   * 时会发现地址莫名变了。
   *
   * 精准的条件是：**这次真的要用这个地址**。也就是 `actual === 'custom'`。
   *
   * ```text
   *   中转站地址 + deepseek 源 → 纠正为 custom → 写地址 ✓
   *   官方地址  + deepseek 源 → 保持 deepseek → 不写（不动用户配置）✓
   *   空地址                  → 不写 ✓
   * ```
   */
  if (actual === 'custom' && target.baseUrl.trim() !== '') {
    patch['custom_url'] = target.baseUrl.trim();
  }

  /*
   * 最大回复长度：**所有源共用同一个键**（2026-11-11 补）。
   *
   * ST 的 `openai.js` 里就是这么读的：
   *
   * ```js
   *   chatCompletion.setTokenBudget(userSettings.openai_max_context,
   *                                 userSettings.openai_max_tokens);
   * ```
   *
   * 键名带 `openai` 前缀但它对 custom / deepseek / claude 全都生效 ——
   * 别按"源"去分支，那会写出一个 ST 根本不读的键。
   *
   * ★ 只在拿到**有效正整数**时才写：`undefined` / `NaN` / `0` 一律跳过，
   *   让 ST 保留它自己的值。写进去一个 `null` 会让它变成字符串，
   *   而 ST 会拿它去算预扣额度 —— 那比不写更坏。
   */
  if (typeof target.maxTokens === 'number' && Number.isFinite(target.maxTokens) && target.maxTokens >= 1) {
    patch['openai_max_tokens'] = Math.trunc(target.maxTokens);
  }

  return patch;
}

/** 回读校验的结果 */
export interface VerifyResult {
  ok: boolean;
  /** 不一致的项，直接可以拼给用户看 */
  problems: string[];
}

/** 期望值（用于回读比对） */
export interface ExpectedConnection extends ApiConnectionTarget {
  /** 这次有没有写 key。没写就不校验 key 的存在性 */
  keyWritten: boolean;
}

/**
 * 回读校验：ST 里读回来的设置是否与刚才写的一致。
 *
 * ## 为什么必须回读
 *
 * 「POST 返回 200」只证明**服务端收下了请求**，不证明它**按我们的意思存了**。
 * 实测过的情况：
 * - ST 把不认识的键丢掉（字段名写错时，保存成功但值为空）
 * - 写入的是字符串、读回被转成别的类型
 *
 * 用户的要求很明确：
 *
 * > 回读验证后 UI 反馈才允许显示成功
 *
 * 所以 UI 的"已保存"必须由**这个函数的 ok** 决定，不能由 POST 的状态码决定。
 */
export function verifyConnectionPersisted(
  settings: unknown,
  expected: ExpectedConnection,
): VerifyResult {
  const problems: string[] = [];

  if (settings === null || typeof settings !== 'object') {
    return { ok: false, problems: ['读不回设置（服务端返回的不是对象）'] };
  }

  const root = settings as Record<string, unknown>;
  const oai = root['oai_settings'];
  if (oai === null || typeof oai !== 'object') {
    return { ok: false, problems: ['读不回设置（没有 oai_settings）'] };
  }
  const o = oai as Record<string, unknown>;

  /* ① 源（按"填了自定义地址就应落成 custom"的实际值核对） */
  const wantSource = effectiveSourceFor(expected.source, expected.baseUrl);
  if (o['chat_completion_source'] !== wantSource) {
    problems.push(
      `源没写进去：期望 ${wantSource}，实际 ${String(o['chat_completion_source'])}`,
    );
  }

  /* ② 模型（按**实际源**对应的字段） */
  const modelField = MODEL_FIELD_BY_SOURCE[wantSource];
  if (o[modelField] !== expected.model) {
    problems.push(
      `模型没写进去：期望 ${expected.model}，实际 ${String(o[modelField])}（字段 ${modelField}）`,
    );
  }

  /* ③ 自定义地址（填了就必须写进去 —— 现在所有源都会写） */
  if (expected.baseUrl.trim() !== '') {
    if (o['custom_url'] !== expected.baseUrl.trim()) {
      problems.push(
        `地址没写进去：期望 ${expected.baseUrl.trim()}，实际 ${String(o['custom_url'])}`,
      );
    }
  }

  /* ④ 最大回复长度（2026-11-11） */
  if (typeof expected.maxTokens === 'number' && Number.isFinite(expected.maxTokens)) {
    const want = Math.trunc(expected.maxTokens);
    const got = o['openai_max_tokens'];
    /*
     * ★ 比较要宽容类型：ST 存进去可能是数字，也可能被它转成字符串
     *   （老版本 settings.json 里见过 `"300"`）。用 `Number(got)` 归一，
     *   否则每次保存都会报一条假的"没写进去"，用户被反复误导。
     *
     * `Number("")` 是 0、`Number(undefined)` 是 NaN —— 两者都不等于 want，
     * 所以真的没写进去时仍然会报。
     */
    if (Number(got) !== want) {
      problems.push(
        `最大回复长度没写进去：期望 ${String(want)}，实际 ${String(got)}（字段 openai_max_tokens）`,
      );
    }
  }

  /*
   * ④ key
   *
   * ★ ST 的 secrets **写进去读不回来**（契约 §3.5 掩码）—— 所以这里
   * **不能**校验 key 的内容，只能校验"我们确实写过这次写入动作"。
   * 内容校验由调用方在写入那一步的成败来保证。
   *
   * 这里只做一个"如果没写 key 就提醒一下"的静态检查，避免出现
   * "源和模型都改了、但 key 没配 ⇒ 发消息 401"这种半配置状态。
   */
  if (!expected.keyWritten) {
    const existing = o['proxy_password'];
    const hasLegacyPassword = typeof existing === 'string' && existing !== '';
    if (!hasLegacyPassword) {
      problems.push('这次没有写入 API 秘钥，服务里也没有旧值 —— 发消息会因为缺 key 失败');
    }
  }

  return { ok: problems.length === 0, problems };
}
