/**
 * 配置作用域（v0.1.7 / T15.6 终版）。
 *
 * ## 这个文件治的是一个具体的接线错误
 *
 * 需求重申过两次：
 *
 * ```text
 * ASR（base_url + key + model，厂商模板表 7 项）与聊天后端
 * （聊天面板「API 连接」页，走 ST 设置接口存储）是两套独立配置：
 * 互不可见、互不覆盖；改任一侧不动另一侧（隔离断言进测试）。
 * ```
 *
 * 为什么需要专门防：两者都长得像"填个地址 + 填个 key"，而**存储位置完全不同**
 * （ASR 进本机应用配置 C5；聊天后端进 ST 的 settings 接口）。
 * 一旦有人图省事把 ASR 的 `baseUrl` 也写进 ST 设置，症状是：
 *
 *   · 换 ASR 厂商 → 聊天后端被顺带改掉 → 聊天直接不能用了；
 *   · 或者反过来：在聊天面板改模型 → ASR 的 model 一起变 → 语音识别错乱。
 *
 * 两种都很难查，因为"改 A 坏了 B"不在任何人的因果里。
 *
 * ## 怎么防
 *
 * 把两套配置的**键集合显式声明**，并用 `applyScopedPatch` 只允许写本作用域的键。
 * 这样"接线错了"变成一个**当场抛错**的事实，而不是等线上出现串味。
 *
 * 决策 #309。
 */

/**
 * ASR 配置的键（本机应用配置 C5）。
 *
 * 注意键名带 `asr` 前缀 —— 不是为了好看，是为了让"误写到聊天后端"这件事
 * 在键名上就能看出来。将来聊天后端的键若也进这份配置，前缀天然隔开。
 */
export const ASR_CONFIG_KEYS = ['asrBaseUrl', 'asrApiKey', 'asrModel', 'asrPresetId'] as const;

/**
 * 语音交互偏好的键（本机应用配置 C5）。
 *
 * 这些**不是凭据**，只是交互习惯。与上面的 ASR 键同存一份配置对象，
 * 但语义上互不依赖：换厂商不该重置确认开关。
 */
export const VOICE_PREF_KEYS = ['voiceConfirmBeforeSend'] as const;

/** 所有已声明的配置作用域 */
export const CONFIG_SCOPES = {
  asr: ASR_CONFIG_KEYS,
  voice: VOICE_PREF_KEYS,
} as const;

export type ConfigScopeName = keyof typeof CONFIG_SCOPES;

/**
 * 找出两个（或全部）作用域里**重名**的键。
 *
 * 正常情况返回空数组。非空说明有人把同一个键塞进了两个作用域 ——
 * 那就是"串味"的物理基础，必须在测试里红。
 */
export function overlappingConfigKeys(): string[] {
  const seen = new Map<string, string>();
  const collisions: string[] = [];
  for (const [scopeName, keys] of Object.entries(CONFIG_SCOPES)) {
    for (const key of keys) {
      const previous = seen.get(key);
      if (previous !== undefined) {
        collisions.push(`${key}（同时出现在 ${previous} 与 ${scopeName}）`);
      } else {
        seen.set(key, scopeName);
      }
    }
  }
  return collisions;
}

/** 写入超出作用域时的错误。抛出而不是静默忽略 —— 静默忽略等于没防。 */
export class ConfigScopeError extends Error {
  constructor(
    readonly scope: ConfigScopeName,
    readonly offendingKeys: readonly string[],
  ) {
    super(
      `作用域 ${scope} 不允许写这些键：${offendingKeys.join(', ')}。` +
        `允许的键是 ${CONFIG_SCOPES[scope].join(', ')}。` +
        '如果你确实要写别的键，说明这次改动跨了作用域 —— 请分别调用两次。',
    );
    this.name = 'ConfigScopeError';
  }
}

/**
 * 只在指定作用域内应用补丁。
 *
 * 三条保证：
 *   1. 补丁里出现作用域外的键 → **抛错**（不是悄悄跳过）；
 *   2. 不修改入参（返回新对象）；
 *   3. 作用域外的已有值**原样保留**（这是"隔离"最直接的那条断言）。
 */
export function applyScopedPatch<T extends Record<string, unknown>>(
  config: T,
  scope: ConfigScopeName,
  patch: Record<string, unknown>,
): T {
  const allowed = new Set<string>(CONFIG_SCOPES[scope]);
  const offending = Object.keys(patch).filter((key) => !allowed.has(key));
  if (offending.length > 0) {
    throw new ConfigScopeError(scope, offending);
  }
  return { ...config, ...patch };
}
