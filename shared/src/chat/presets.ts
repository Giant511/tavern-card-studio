/**
 * ST 的「对话补全预设」—— 列表、切换、导入的**纯逻辑**（2026-11-03）。
 *
 * ## 这个文件解决什么问题
 *
 * 用户要求「AI 响应配置需要支持导入配置和切换配置，导入配置可以导入 json 格式
 *（原生 ST 是支持的）」。
 *
 * ST 原生里这套东西叫 "Chat Completion preset"，落盘在
 * `<user>/OpenAI Settings/*.json`。它的接口形态（读 `src/endpoints/presets.js`
 * 与 `public/scripts/openai.js` 确认，不是猜的）：
 *
 * | 要做的事 | 接口 |
 * |---|---|
 * | 列出预设 | `POST /api/settings/get` 的 `openai_setting_names` + `openai_settings` |
 * | 当前用的是哪个 | `settings.oai_settings.preset_settings_openai` |
 * | 保存/导入 | `POST /api/presets/save`，body `{ apiId: 'openai', name, preset }` |
 * | 删除 | `POST /api/presets/delete` |
 *
 * ## ★★★ 两套字段名：预设文件用短名，设置用长名
 *
 * 这是最容易写错的地方。实测 `OpenAI Settings/Default.json`：
 *
 * ```text
 *   temperature         ← 预设文件里的键
 *   frequency_penalty
 *   top_p
 * ```
 *
 * 而 `settings.json` 的 `oai_settings` 里叫：
 *
 * ```text
 *   temp_openai
 *   freq_pen_openai
 *   top_p_openai
 * ```
 *
 * 映射来自 `public/scripts/openai.js` 的 `settingsToUpdate`（103 条，
 * 已程序化提取核对）。**不照这张表映射，导入的预设会"看起来导入成功、
 * 但温度还是老值"** —— 因为写进了 `oai_settings.temperature` 这个不存在的键。
 *
 * ## 为什么不直接照搬整份预设到 oai_settings
 *
 * `settingsToUpdate` 里 103 条中有 **56 条是"连接设置"**
 * （模型名、反代地址、各家 key 槽位…）。ST 自己在切换预设时，
 * 如果 `bind_preset_to_connection` 为假就**跳过**这些。
 *
 * 我们照同样的规则跳过：换个预设不该把用户的模型和接口地址换掉。
 * 用户只是想换采样风格，结果模型被换了 —— 那是很难归因的"故障"。
 */

import type { SettingField } from './settings-schema.js';

/**
 * 预设文件的短名 → `oai_settings` 的键。
 *
 * 只收**名字不一样**的那些；同名的（`seed`、`n`、`openai_max_tokens`…）
 * 不需要出现在这里 —— 见 `presetKeyToSetting`。
 *
 * 出处：`public/scripts/openai.js` 的 `settingsToUpdate`。
 */
export const PRESET_KEY_TO_SETTING: Readonly<Record<string, string>> = {
  temperature: 'temp_openai',
  frequency_penalty: 'freq_pen_openai',
  presence_penalty: 'pres_pen_openai',
  top_p: 'top_p_openai',
  top_k: 'top_k_openai',
  top_a: 'top_a_openai',
  min_p: 'min_p_openai',
  repetition_penalty: 'repetition_penalty_openai',
};

/**
 * **连接类**预设键：切换预设时**必须跳过**。
 *
 * 出处同上，是 `settingsToUpdate` 里第 4 个位置为 `true` 的那些
 * （ST 用这个标记判断"是否属于连接"）。
 *
 * 为什么要显式列出来而不是"不在白名单里就跳过"：
 * 白名单会漏掉以后 ST 新加的参数；黑名单只会多带一个无害的字段。
 * 两者的失败代价不对称 —— 漏掉＝用户的模型被换掉（严重），
 * 多带＝一个没人读的键（无害）。
 */
export const PRESET_CONNECTION_KEYS: ReadonlySet<string> = new Set([
  'chat_completion_source',
  'group_models',
  'sort_models',
  'openai_model',
  'claude_model',
  'openrouter_model',
  'openrouter_use_fallback',
  'openrouter_providers',
  'openrouter_quantizations',
  'openrouter_allow_fallbacks',
  'openrouter_middleout',
  'ai21_model',
  'mistralai_model',
  'cohere_model',
  'perplexity_model',
  'groq_model',
  'chutes_model',
  'siliconflow_model',
  'siliconflow_endpoint',
  'minimax_model',
  'minimax_endpoint',
  'electronhub_model',
  'nanogpt_model',
  'nanogpt_provider',
  'nanogpt_payg_override',
  'deepseek_model',
  'aimlapi_model',
  'xai_model',
  'pollinations_model',
  'pollinations_endpoint',
  'moonshot_model',
  'fireworks_model',
  'cometapi_model',
  'custom_model',
  'custom_url',
  'custom_include_body',
  'custom_exclude_body',
  'custom_include_headers',
  'custom_prompt_post_processing',
  'google_model',
  'vertexai_model',
  'zai_model',
  'zai_endpoint',
  'workers_ai_model',
  'workers_ai_account_id',
  'reverse_proxy',
  'proxy_password',
  'show_external_models',
  'bypass_status_check',
  'vertexai_auth_mode',
  'vertexai_region',
  'vertexai_express_project_id',
  'azure_base_url',
  'azure_deployment_name',
  'azure_api_version',
  'azure_openai_model',
]);

/** 预设键 → `oai_settings` 键。同名的原样返回 */
export function presetKeyToSetting(key: string): string {
  return PRESET_KEY_TO_SETTING[key] ?? key;
}

/** 一份预设的基本信息（给下拉用） */
export interface PresetSummary {
  name: string;
  /** 这份预设里有多少个字段（给用户一个"像不像空文件"的判断依据） */
  fieldCount: number;
}

/**
 * 从 `/api/settings/get` 的返回里取预设清单。
 *
 * ## 返回的三种形态都要认
 *
 * ST 不同版本 / 不同路径下 `openai_settings` 可能是：
 *   · 数组（现代版本，`[{...}, {...}]`，与 `openai_setting_names` 的**索引**对应）
 *   · 对象（早期版本，`{ 'Default': {...} }`）
 *   · 字符串化后的 JSON
 *
 * 只认一种的实现会在换版本时静默给空列表 —— 界面上就是"一个预设都没有"，
 * 而用户明明有一堆。
 */
export function parsePresetList(payload: unknown): PresetSummary[] {
  if (payload === null || typeof payload !== 'object') return [];
  const root = payload as Record<string, unknown>;

  const rawNames = root['openai_setting_names'];
  const rawBodies = root['openai_settings'];

  /* 形态 A：数组（或字符串化的 JSON） */
  if (Array.isArray(rawNames)) {
    const bodies = coerceBodyList(rawBodies);
    return rawNames
      .filter((one): one is string => typeof one === 'string')
      .map((name, index) => ({
        name,
        fieldCount: countFields(bodies[index] ?? bodies[byNameIndex(bodies, name)] ?? null),
      }));
  }

  /* 形态 B：对象 { name: index } 或 { name: body } */
  if (rawNames !== null && typeof rawNames === 'object') {
    const bodies = coerceBodyList(rawBodies);
    return Object.entries(rawNames as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'number' || typeof value === 'string')
      .map(([name, value]) => ({
        name,
        fieldCount: countFields(bodies[typeof value === 'number' ? value : 0] ?? null),
      }));
  }

  /* 形态 C：只有 openai_settings 是个对象 */
  if (rawBodies !== null && typeof rawBodies === 'object' && !Array.isArray(rawBodies)) {
    return Object.entries(rawBodies as Record<string, unknown>).map(([name, value]) => ({
      name,
      fieldCount: countFields(value),
    }));
  }

  return [];
}

/** 取"当前正在用的预设名" */
export function currentPresetName(settings: unknown): string {
  if (settings === null || typeof settings !== 'object') return '';
  const oai = (settings as Record<string, unknown>)['oai_settings'];
  if (oai === null || typeof oai !== 'object') return '';
  const name = (oai as Record<string, unknown>)['preset_settings_openai'];
  return typeof name === 'string' ? name : '';
}

/**
 * 把 `/api/settings/get` 的返回整理成 `{ 预设名: 预设体 }`。
 *
 * ## 为什么与 `parsePresetList` 分开
 *
 * 列表只需要"名字 + 字段数"（给下拉用，轻量）；
 * 切换需要**整份预设体**。两者的容错逻辑一样（三种返回形态），
 * 但输出不同。合成一个函数会让调用方拿到一堆它不用的数据。
 *
 * 两种形态的对应关系：
 *   · 数组形态：`openai_setting_names[i]` ↔ `openai_settings[i]`
 *   · 对象形态：`openai_setting_names = { name: index }`
 */
export function presetBodiesByName(payload: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (payload === null || typeof payload !== 'object') return out;

  const root = payload as Record<string, unknown>;
  const rawNames = root['openai_setting_names'];
  const bodies = coerceBodyList(root['openai_settings']);

  if (Array.isArray(rawNames)) {
    rawNames.forEach((name, index) => {
      if (typeof name !== 'string') return;
      const body = bodies[index];
      if (body !== null && typeof body === 'object') out[name] = body;
    });
    return out;
  }

  if (rawNames !== null && typeof rawNames === 'object') {
    for (const [name, value] of Object.entries(rawNames as Record<string, unknown>)) {
      const index = typeof value === 'number' ? value : Number(value);
      const body = Number.isFinite(index) ? bodies[index] : undefined;
      if (body !== null && typeof body === 'object') out[name] = body;
    }
    return out;
  }

  /* 兜底：`openai_settings` 本身是 `{ name: body }` */
  const rawBodies = root['openai_settings'];
  if (rawBodies !== null && typeof rawBodies === 'object' && !Array.isArray(rawBodies)) {
    for (const [name, raw] of Object.entries(rawBodies as Record<string, unknown>)) {
      const body = coerceBodyEntry(raw);
      if (body !== null && typeof body === 'object') out[name] = body;
    }
  }

  return out;
}

/** 切换预设的结果 */
export interface ApplyPresetPlan {
  /** 要写进 `oai_settings` 的键值（已从短名映射成长名、已剔除连接项） */
  updates: Record<string, unknown>;
  /** 当前预设名（`preset_settings_openai`） */
  presetName: string;
  /** 因为属于连接设置而被跳过的键（给用户看的"我没动你的模型"） */
  skipped: string[];
}

/**
 * 从一份预设体算出"切换过去要改什么"。
 *
 * **纯函数**：不读网络、不改传进来的对象。判据可以直接喂假数据。
 *
 * ## 跳过的三类
 *
 * 1. 连接设置（见 `PRESET_CONNECTION_KEYS`）—— 不能因为换预设就把模型换掉
 * 2. `prompts` / `prompt_order` —— 这是 ST 的提示词列表结构（数组套对象），
 *    我们的 App 不用它；照搬容易把 ST 那边的顺序弄坏而不自知
 * 3. 值为 `undefined` / 函数（JSON 里不会有，防御）
 */
export function planApplyPreset(presetBody: unknown, presetName: string): ApplyPresetPlan {
  const updates: Record<string, unknown> = {};
  const skipped: string[] = [];

  if (presetBody === null || typeof presetBody !== 'object') {
    return { updates, presetName, skipped };
  }

  for (const [key, value] of Object.entries(presetBody as Record<string, unknown>)) {
    if (PRESET_CONNECTION_KEYS.has(key) || key === 'prompts' || key === 'prompt_order') {
      skipped.push(key);
      continue;
    }
    if (value === undefined) continue;
    updates[presetKeyToSetting(key)] = value;
  }

  return { updates, presetName, skipped };
}

/**
 * 校验一份"用户选的 JSON 文件"是不是能当预设用。
 *
 * ## 为什么需要校验（而不是直接 POST）
 *
 * `POST /api/presets/save` 对 `preset` 的内容**不做任何检查** ——
 * 传 `{}` 也会 200。于是用户导错文件（比如一个角色卡 JSON）时，
 * 界面上"导入成功"、下拉里多了一条，选中它却什么都没变。
 *
 * 所以这里先判"看起来像不像一份对话补全预设"：
 * 至少要有**一个**我们认识的采样键。全不认识就明确拒绝并说清原因。
 */
export function validatePresetBody(body: unknown): { ok: true; fieldCount: number } | { ok: false; reason: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: '这个文件的顶层不是一个 JSON 对象，不像聊天预设文件。' };
  }

  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) {
    return { ok: false, reason: '这个 JSON 是空对象，里面没有任何设置。' };
  }

  /*
   * "认得"= 映射表里的短名 + 长名 + 几个通用键。
   * 不去要求"必须有 temperature" —— 预设可以只改一个参数。
   */
  const KNOWN = new Set([
    ...Object.keys(PRESET_KEY_TO_SETTING),
    ...Object.values(PRESET_KEY_TO_SETTING),
    'openai_max_tokens',
    'openai_max_context',
    'seed',
    'n',
    'names_behavior',
    'stream_openai',
    'preset_settings_openai',
    'prompts',
    'prompt_order',
    'squash_system_messages',
    'reasoning_effort',
    'verbosity',
  ]);

  const hits = keys.filter((one) => KNOWN.has(one));
  if (hits.length === 0) {
    return {
      ok: false,
      reason:
        '这个 JSON 里没有任何对话补全预设认识的字段（比如 temperature / top_p / openai_max_tokens）。' +
        '它可能是角色卡或别的配置文件，不是聊天预设。',
    };
  }

  return { ok: true, fieldCount: keys.length };
}

/**
 * 从文件名推出预设名。
 *
 * ST 的实现是 `file.name.replace(/\.[^/.]+$/, '')` —— 只去掉**最后一个**扩展名，
 * 保留其余部分（`我的.预设.json` → `我的.预设`）。照抄这条，避免两边叫法不一致。
 */
export function presetNameFromFile(fileName: string): string {
  const base = fileName.replace(/\.[^/.]+$/, '');
  return base.trim();
}

/**
 * 把一份预设体套进 `oai_settings`，得到"切换之后"的 oai_settings。
 *
 * 纯函数，返回新对象（不改入参）—— 与 `writeField` 的约定一致。
 */
export function mergePresetIntoOai(
  oaiSettings: Record<string, unknown>,
  plan: ApplyPresetPlan,
): Record<string, unknown> {
  return {
    ...oaiSettings,
    ...plan.updates,
    preset_settings_openai: plan.presetName,
  };
}

/* ── 内部工具 ── */

function coerceBodyList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw.map(coerceBodyEntry);
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(coerceBodyEntry) : [];
    } catch {
      return [];
    }
  }
  if (raw !== null && typeof raw === 'object') {
    return Object.values(raw as Record<string, unknown>).map(coerceBodyEntry);
  }
  return [];
}

/**
 * 把一项预设体统一成对象。
 *
 * ★★★ 2026-11-03 真机发现：`openai_settings` 的每一项是 **JSON 字符串**，
 * 不是对象。
 *
 * 实测 `/api/settings/get` 的返回：
 *
 * ```text
 *   openai_settings[0] = "{\n    \"chat_completion_source\": \"openai\",\n ... }"
 *   typeof openai_settings[0] === 'string'
 * ```
 *
 * ## 这个坑有多贵
 *
 * 我第一版按对象写（`if (body !== null && typeof body === 'object')`），
 * 于是**每一项都被跳过** ⇒ 切换预设时报"找不到名为「X」的预设"，
 * 而列表里明明有它。
 *
 * 更麻烦的是：单元测试当时喂的是对象，全绿。
 * **桩比真实更宽容**（与 memory §60 / §74.3 同一类：假绿来自测试数据不真实）。
 *
 * 现在两种形态都吃，并且真机探针（`.verify/probe-preset-api.mjs`）
 * 第 ④ 条专门钉"写进去的字段能读回来"。
 */
function coerceBodyEntry(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed;
    } catch {
      return null;
    }
  }
  return value;
}

function byNameIndex(bodies: unknown[], name: string): number {
  const index = bodies.findIndex(
    (one) => one !== null && typeof one === 'object' && (one as Record<string, unknown>)['preset_settings_openai'] === name,
  );
  return index >= 0 ? index : 0;
}

function countFields(body: unknown): number {
  /* 预设体可能是 JSON 字符串（真机就是这个形状，见 `coerceBodyEntry`） */
  const entry = coerceBodyEntry(body);
  if (entry === null || typeof entry !== 'object') return 0;
  return Object.keys(entry as Record<string, unknown>).length;
}

/** 给界面用：一个字段是否真会随生成发出去 */
export function isFieldSent(field: SettingField): boolean {
  return field.sent !== false;
}
