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

/** 这次要落盘的连接配置 */
export interface ApiConnectionTarget {
  source: StChatSource;
  model: string;
  /** 自定义地址（只有 `custom` 源用得上） */
  baseUrl: string;
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
  const patch: Record<string, unknown> = {
    chat_completion_source: target.source,
    [MODEL_FIELD_BY_SOURCE[target.source]]: target.model,
  };

  if (usesCustomUrl(target.source) && target.baseUrl.trim() !== '') {
    patch['custom_url'] = target.baseUrl.trim();
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

  /* ① 源 */
  if (o['chat_completion_source'] !== expected.source) {
    problems.push(
      `源没写进去：期望 ${expected.source}，实际 ${String(o['chat_completion_source'])}`,
    );
  }

  /* ② 模型（按源对应的字段） */
  const modelField = MODEL_FIELD_BY_SOURCE[expected.source];
  if (o[modelField] !== expected.model) {
    problems.push(
      `模型没写进去：期望 ${expected.model}，实际 ${String(o[modelField])}（字段 ${modelField}）`,
    );
  }

  /* ③ 自定义地址（只有 custom 且填了才校验） */
  if (usesCustomUrl(expected.source) && expected.baseUrl.trim() !== '') {
    if (o['custom_url'] !== expected.baseUrl.trim()) {
      problems.push(
        `地址没写进去：期望 ${expected.baseUrl.trim()}，实际 ${String(o['custom_url'])}`,
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
