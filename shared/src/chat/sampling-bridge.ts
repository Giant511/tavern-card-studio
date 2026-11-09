import { readField, SAMPLING_SECTION } from './settings-schema.js';

/* ═══════════════════════════════════════════════════════════
   采样参数：ST 设置 → 请求体的单一派生点
   （2026-10-31 第四批 / 采样参数从「API 连接」迁移到「AI 响应配置」）

   ## 为什么需要这一层

   契约（`docs/adapter-contract-st-v1.19.md:219`）明确写着：

   > **采样参数全在请求体**，服务端不读 `settings.json`

   也就是说：**写进 ST 设置并不等于生效** —— 只有随请求体发出去的才生效。

   所以迁移之后必须有两件事同时成立：
     1. 存储落在 ST 设置（用户要求"仍走 ST 设置接口"）；
     2. 请求体从那份存储**派生**出值（否则改了不生效）。

   这一层就是第 2 件事。放在 `shared` 里是因为它同时被
   `client`（组装 ctx）与契约测试（断言请求体字段）使用 ——
   写两份必然分叉。

   ## 为什么用「映射表 + 交叉校验」而不是给 SettingField 加字段

   给 `SettingField` 加一个 `requestKey` 字段看起来更省事，但那会把
   "界面元数据"和"协议映射"混在一起：将来某个字段只在界面出现、
   不进请求体时（比如纯展示项），就得分不清是"漏了映射"还是"故意不映射"。

   独立一张表 + 两条测试（见 `test/chat-settings-schema.test.mjs`）：
     · `SAMPLING_SECTION` 里每个字段都必须有映射（否则"改了发不出去"）
     · 映射表里每个键都必须在 `SAMPLING_SECTION` 里（否则是残留）
   两边互相钉死，任何一侧改了另一边没跟上都会红。
   ═══════════════════════════════════════════════════════════ */

/** 从 ST 设置派生出来的采样参数（键名与 `SamplingParams` 对齐） */
export interface DerivedSampling {
  temperature?: number;
  topP?: number;
  topK?: number;
  topA?: number;
  minP?: number;
  maxTokens?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  repetitionPenalty?: number;
  seed?: number;
  /** 字符串枚举（`auto` / `low` / `medium` / `high` / `min` / `max`） */
  reasoningEffort?: string;
  verbosity?: string;
}

/**
 * 一条映射：ST 设置路径 → 请求体参数 + 该参数的取值类型。
 *
 * ## 为什么需要 `kind`
 *
 * 原来只收数字（`typeof value === 'number'`），因为采样参数全是数字。
 * 2026-11-03 补「推理强度」「长度」两项时它们**是字符串枚举**
 * （`auto` / `low` / `medium` / `high` / `min` / `max`），
 * 一律按数字处理会把它们静默丢掉 —— 界面能改、请求体里没有，
 * 又是一个"假控件"。
 *
 * 所以类型必须写进映射表，由映射表决定怎么取值，而不是让读取函数猜。
 */
export interface SamplingMapping {
  param: keyof DerivedSampling;
  kind: 'number' | 'string';
}

/**
 * ST 设置路径 → 采样参数键。
 *
 * 键是 `SettingField.path.join('.')`。值必须存在于 `DerivedSampling` 里
 * （类型系统保证），且必须是 `SamplingParams` 认得的键
 * （`buildGenerateRequest` 里逐字段判断，没有分支就等于发不出去）。
 *
 * ★ 这张表**只收真要发出去的字段**。`SAMPLING_SECTION` 里标 `sent: false`
 * 的（ST 前端专用的那些）**故意不在这里**，因为给它们编一个"请求体参数"
 * 只会让人以为它们生效了。
 */
export const SAMPLING_PATH_TO_PARAM: Readonly<Record<string, SamplingMapping>> = {
  'oai_settings.temp_openai': { param: 'temperature', kind: 'number' },
  'oai_settings.top_p_openai': { param: 'topP', kind: 'number' },
  'oai_settings.top_k_openai': { param: 'topK', kind: 'number' },
  'oai_settings.top_a_openai': { param: 'topA', kind: 'number' },
  'oai_settings.min_p_openai': { param: 'minP', kind: 'number' },
  'oai_settings.openai_max_tokens': { param: 'maxTokens', kind: 'number' },
  'oai_settings.pres_pen_openai': { param: 'presencePenalty', kind: 'number' },
  'oai_settings.freq_pen_openai': { param: 'frequencyPenalty', kind: 'number' },
  'oai_settings.repetition_penalty_openai': { param: 'repetitionPenalty', kind: 'number' },
  'oai_settings.seed': { param: 'seed', kind: 'number' },
  'oai_settings.reasoning_effort': { param: 'reasoningEffort', kind: 'string' },
  'oai_settings.verbosity': { param: 'verbosity', kind: 'string' },
};

/**
 * 从 ST 设置对象里读出采样参数。
 *
 * ## 三条设计约束
 *
 * 1. **缺失字段不写 `undefined` 之外的假值**：调用方（`buildGenerateRequest`）
 *    逐字段判类型，所以给 `undefined` 就是"不带这个字段"，
 *    让 ST 用它自己的默认值 —— 这比我们猜一个默认值更安全。
 * 2. **不做范围校验**：越界该在保存时由 `validateNumber` 拦住并告诉用户。
 *    在这里再夹一次会让"保存时说了上限、发给模型时又是另一个值"。
 * 3. **读不到就返回空对象**：`{}` 意思是"全用 ST 默认"，
 *    而不是"全用 0" —— 后者会让模型输出完全失控。
 */
export function samplingFromSettings(settings: Record<string, unknown>): DerivedSampling {
  /*
   * 累加器用宽松类型，最后再断言成 `DerivedSampling`。
   *
   * 为什么不能直接 `out: DerivedSampling` 然后 `out[mapping.param] = value`：
   * `mapping.param` 的类型是 `keyof DerivedSampling`（一个联合），
   * TypeScript 无法把 `number | string` 收窄到"这次这一键对应的那个类型"，
   * 于是报 `Type 'number' is not assignable to type 'undefined'`。
   *
   * 这里的安全性由 `SamplingMapping.param` 的约束（必须是 `keyof DerivedSampling`）
   * 加上 `kind` 与字段实际类型的人工对应来保证；判据在
   * `test/chat-settings-schema.test.mjs` 里逐字段核对请求体取值。
   */
  const out: Record<string, number | string> = {};

  for (const field of SAMPLING_SECTION.fields) {
    const pathKey = field.path.join('.');
    const mapping = SAMPLING_PATH_TO_PARAM[pathKey];
    if (mapping === undefined) continue;

    const value = readField(settings, field);

    if (mapping.kind === 'number') {
      /*
       * ST 设置里可能是 `"1"`（字符串，从表单读回来的），
       * 那种值直接给请求体会让 ST 那边的 `Number()` 转换时机不可控 ——
       * 而 `buildGenerateRequest` 是用 `typeof === 'number'` 判断的，
       * 传字符串会被**静默丢弃**。所以这里显式转一次。
       */
      if (typeof value === 'number' && Number.isFinite(value)) {
        out[mapping.param] = value;
      } else if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) out[mapping.param] = parsed;
      }
      continue;
    }

    /*
     * 字符串枚举：只认非空字符串。
     *
     * ★ 特别处理 `'auto'`：ST 的语义是"不干预"，即**不该出现在请求体里**。
     * 带着 `reasoning_effort: 'auto'` 发出去，部分中转站会当成一个未知值
     * 直接 400（实测过同类问题：`'auto'` 不是 OpenAI 的合法 effort）。
     * 所以 auto 一律当作"不带这个字段"。
     */
    if (typeof value === 'string' && value.trim() !== '' && value.trim() !== 'auto') {
      out[mapping.param] = value.trim();
    }
    // 其它类型（布尔 / null / 对象 / 'auto'）一律跳过 —— 宁可让 ST 用默认值
  }

  return out as DerivedSampling;
}

/**
 * 采样参数的兜底默认值（ST 设置读不到时用）。
 *
 * 与 `SAMPLING_SECTION.fields[].fallback` 同源，不另写一份 ——
 * 两处各写一份默认值，升级时必然只有一处被改。
 */
export const DEFAULT_SAMPLING: DerivedSampling = samplingFromSettings({});
