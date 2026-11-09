/**
 * ASR 厂商预设模板表（v0.1.7 / T15.6，决策 #267）。
 *
 * ## 为什么是"一张表"而不是 if/else
 *
 * 决策 #267 的原话是「模板表随版本维护，新厂商加入只改表不改代码 ——
 * 这是让这张表成为**数据**而不是 `if/else` 的原因」。
 *
 * 写成 `if (vendor === 'groq') { ... }` 的代价不是"代码难看"，而是：
 * 每加一个厂商都要改逻辑、走一次发版、过一遍回归测试。
 * 而这张表里没有逻辑，只有「厂商 → 默认值」的映射。
 *
 * ## 这张表被定稿过两次
 *
 * 2026-10-29 用户给了定稿（base_url / model / 标注三方齐备），
 * 并明确了一条与初版不同的口径：**DeepSeek / Kimi 这类纯文本厂商
 * 不在选项里出现**，只在「使用说明」里解释。
 * 这比"出现在下拉里但选中后报错"更干净 —— 见 `TEXT_ONLY_VENDORS_NOTE`。
 */

/**
 * 协议路线。
 *
 * - `transcriptions`：OpenAI 兼容的 `POST {base}/audio/transcriptions`（路线 A，默认）
 * - `chat-audio`：音频走 chat 协议上传（路线 B，高级模式）
 * - `gradio`：自建的 Gradio 应用（路线 C，`upload → call → poll` 三步，决策 #338）
 *
 * 三者不是"配置项不同"，是**请求体完全不同**（决策 #266）。
 * 所以它属于预设的一部分，不能让用户自己切 —— 切错了必然失败。
 *
 * ## 为什么第三条路值得单独实现，而不是"让用户自己写个 OpenAI 兼容网关"
 *
 * 因为 Gradio 是**自建语音服务最常见的形态**：Fun-ASR、Whisper-WebUI、
 * SenseVoice 这些开源项目的默认启动方式就是 `python app.py` 起一个 Gradio 页面。
 * 用户在局域网里已经把它跑起来了，唯一缺的就是一个能填地址的客户端。
 *
 * 要求他再写一层 OpenAI 兼容网关，等于把"能用"变成"要开发"。
 */
export type AsrProtocol =
  | 'transcriptions'
  | 'chat-audio'
  /** DashScope 原生多模态：`/api/v1/services/aigc/multimodal-generation/generation` */
  | 'dashscope-audio'
  | 'gradio';

export interface AsrPreset {
  /** 稳定标识，存进配置。**不要改**，改了等于让老用户的配置失效 */
  id: string;
  /** 下拉里显示的名字 */
  name: string;
  protocol: AsrProtocol;
  /**
   * 默认 base_url。
   *
   * 空串表示**必须手填**（本地 whisper.cpp / 中转站）。
   * 用空串而不是 `undefined`：配置项本身是字符串，
   * 空串在表单里就是"空输入框"，语义一致。
   */
  baseUrl: string;
  /** 推荐 model 名。空串表示由用户手填 */
  model: string;
  /**
   * 标注（给用户看的取舍说明）。
   *
   * 写法纪律：只说**用户能拿它做决策**的事 —— 网络可达性、费用、语言优势。
   * 不写"基于 xx 模型"这类实现信息。
   */
  note: string;
  /** 是否属于「高级模式」（路线 B） */
  advanced: boolean;
  /**
   * 这条路线是否**需要 API key**（决策 #338）。
   *
   * 为什么它必须进预设而不是"key 空着就跳过校验"：
   * 「key 为空」是一个**瞬时输入状态**（用户还没填），
   * 「这条路线不需要 key」是一个**线路属性**。
   * 用前者代替后者，会把"忘了填 key"静默变成"能保存"，然后用户拿到 401 才回来找原因。
   *
   * 显式声明成 `false` 的只有自建服务（`gradio` 路线）：
   * 自己电脑上的服务没有鉴权，硬要填一个 key 反而是多余的。
   */
  requiresKey: boolean;
  /**
   * 仅 `gradio` 路线：**模型路径**字段的默认值。
   *
   * 自建服务常常要在请求里带上"权重放在哪个目录"。
   * 这个值不能塞进 `model`：`model` 是"选哪个模型"（`fun-asr-nano`），
   * 路径是"权重在哪"（`./models/Fun-ASR-Nano`）—— 两者是不同字段，
   * 合并后用户改了一个就必然要改另一个。
   */
  modelPath?: string;
  /**
   * 仅 `gradio` 路线：要调用的端点名（`api_name`，不带前导斜杠）。
   *
   * 留空表示**自动探测**（取唯一带 Audio 输入、且有多路输出的那个端点）。
   * 之所以允许写死：自动探测是启发式，而用户的部署是确定的 ——
   * 万一他的应用有两个转写端点，让他能指定比让他猜更省事。
   */
  endpoint?: string;
}

/**
 * 主模板（路线 A：OpenAI 兼容转写）。
 *
 * 顺序是**刻意的**：阿里在前。因为目标用户是中文用户，
 * 而"国内直连"是第一个筛选项 —— 排序本身就是一次引导。
 */
export const ASR_PRESETS: readonly AsrPreset[] = [
  {
    /*
     * ★ id 保持 `aliyun-paraformer` 不变（2026-11-07）。
     *
     * id 存进用户的配置里。改名 = 老用户的语音配置全部失效、
     * 回落到"没选服务商"。所以宁可让 id 带一个历史名字，
     * 也不能为了"看起来整齐"而改它。
     */
    id: 'aliyun-paraformer',
    name: '阿里百炼 · 语音识别',
    /*
     * ★★★ 协议换了：**不再走 OpenAI 兼容的 `/audio/transcriptions`**。
     *
     * 2026-11-07 用真实 key 实测（新地址 `ws-*.maas.aliyuncs.com`）：
     *
     * ```text
     *   POST {base}/audio/transcriptions            → 404（这个端点不存在）
     *   POST {base}/api/v1/services/aigc/
     *        multimodal-generation/generation
     *        model=qwen3-asr-flash                 → 200 { output.choices[0]...text }
     *        model=paraformer-v2                   → 400 "url error"（它只收 file URL）
     *        model=fun-asr-flash-*                 → 400 同上
     * ```
     *
     * 也就是说：百炼的同步转写现在是**多模态生成接口 + qwen3-asr-flash**，
     * 而 `paraformer-v2` 在新的 OpenAI 兼容层里**已不在模型列表**
     * （`/models` 返回 182 个模型，里面没有它）。
     *
     * 保留旧地址会让用户拿到 404，而 404 的文案是"地址填错了"——
     * 他看着文档上写着兼容模式，完全对不上。
     */
    protocol: 'dashscope-audio',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3-asr-flash',
    note: '国内直连 · 中文最强',
    advanced: false,
    requiresKey: true,
  },
  {
    id: 'groq',
    name: 'Groq',
    protocol: 'transcriptions',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3-turbo',
    note: '免费额度大 · 速度快 · 需海外网络',
    advanced: false,
    requiresKey: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'transcriptions',
    baseUrl: 'https://api.openai.com/v1',
    model: 'whisper-1',
    note: '需海外网络与外币付费',
    advanced: false,
    requiresKey: true,
  },
  {
    id: 'whisper-cpp',
    name: '本地 whisper.cpp',
    protocol: 'transcriptions',
    // 手填：自建服务的地址完全取决于用户摆在哪个端口
    baseUrl: '',
    model: '',
    note: '隐私优先 · 需自建服务',
    advanced: false,
    requiresKey: true,
  },
  {
    /*
     * 第三条协议路线（决策 #338）。
     *
     * 与上面的 whisper.cpp 的区别不只是"协议不同"：
     * whisper.cpp 那条是**让用户自己去搭一个 OpenAI 兼容接口**，
     * 而这条是**直接对接已经跑起来的 Gradio 页面** —— 后者是
     * Fun-ASR / Whisper-WebUI / SenseVoice 这些项目的默认启动方式，
     * 用户通常已经跑好了，只是缺一个能填地址的客户端。
     *
     * baseUrl 必须手填：服务在用户自己的机器/局域网里，地址只有他知道。
     * model 恒为 `fun-asr-nano`（这是该应用的合法取值之一，见 `gradio.ts` 的说明）；
     * 模型路径是**另一个字段**，不能和 model 合并（见 `AsrPreset.modelPath`）。
     */
    id: 'funasr-local',
    name: '本地 Fun-ASR（Gradio）',
    protocol: 'gradio',
    baseUrl: '',
    model: 'fun-asr-nano',
    modelPath: './models/Fun-ASR-Nano',
    note: '自建服务 · 局域网地址手填 · 不需要 key',
    advanced: false,
    requiresKey: false,
  },
] as const;

/**
 * 高级模板（路线 B：音频走 chat 协议）。
 *
 * 与主模板分开两个数组，而不是一个数组加 `advanced` 标记再 filter ——
 * 因为 UI 上是两个分组，分开写省得两边各 filter 一次还写错。
 * `advanced` 字段仍保留，供"只取全部"的场景使用。
 */
export const ASR_ADVANCED_PRESETS: readonly AsrPreset[] = [
  {
    id: 'qwen-audio',
    name: 'Qwen-Audio ASR（百炼）',
    /*
     * ★ 2026-11-07 实测：原来的 `qwen-audio-turbo` + `chat-audio` 已经不能用。
     *
     * ```text
     *   POST /compatible-mode/v1/chat/completions
     *        model=qwen-audio-turbo
     *   → 404 {"code":"model_not_supported",
     *          "message":"Unsupported model `qwen-audio-turbo` for OpenAI compatibility mode."}
     * ```
     *
     * 也就是说这条线**整条都不在兼容层里了**，不是模型名写错。
     * 换成与「阿里百炼 · 语音识别」同一条原生路径，模型用 `qwen-audio-3.0-asr-flash`
     * —— 它与 `fun-asr-flash` 一样需要 `parameters.format`（已在客户端统一带上）。
     */
    protocol: 'dashscope-audio',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-audio-3.0-asr-flash',
    note: '抗噪 · 听懂语气词',
    advanced: true,
    requiresKey: true,
  },
  {
    id: 'gemini',
    name: 'Gemini',
    protocol: 'chat-audio',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    /*
     * model 留空：Gemini 的模型 ID 随版本滚动得很快
     * （gemini-2.0-flash / 2.5-flash / exp-* …），写死一个必然过期。
     * 空串时表单表现为"需要你填"，比填一个过期的默认值更诚实 ——
     * 后者会让人以为"选了就能用"，然后拿到 404 回来。
     */
    model: '',
    note: '海外',
    advanced: true,
    requiresKey: true,
  },
] as const;

/**
 * 中转站 / 自定义（设计定稿 2026-10-29）。
 *
 * ## 为什么单独一条而不是让用户改上表的 base_url
 *
 * 因为"改 base_url 但保留厂商预设的 model 名"是一个**必然失败**的组合：
 * 中转站的模型 ID 是它自己起的名字（`gpt-4o-mini`、`whisper-1`、甚至 `-xl`），
 * 与直连厂商的 model 不是一套。把两者混在一个条目里，
 * 用户会填出"Groq 的 base_url + 中转站的模型名"这种组合然后报 404。
 *
 * 所以中转站是一个**独立条目**：三字段全手填，语义是"我知道自己在填什么"。
 */
export const ASR_RELAY_PRESET: AsrPreset = {
  id: 'relay',
  name: '中转站 / 自定义',
  protocol: 'transcriptions',
  baseUrl: '',
  model: '',
  note: 'model 填你站里的 ID · 多数中转站兼容 OpenAI 接口',
  advanced: false,
  requiresKey: true,
} as const;

/** 全部预设（主 + 高级 + 中转站），按 UI 分组顺序 */
export const ALL_ASR_PRESETS: readonly AsrPreset[] = [
  ...ASR_PRESETS,
  ASR_RELAY_PRESET,
  ...ASR_ADVANCED_PRESETS,
];

/**
 * 配置页顶部的选择指引（一句话）。
 *
 * 定稿原文：「国内网络选阿里，有海外网络选 Groq」。
 *
 * 为什么值得单独一个常量：这句话是整页**唯一**帮用户做决定的文字。
 * 散在模板里当 note 的话，用户要在六个选项之间自己比较 ——
 * 而他打开这个页面的第一反应是"我该选哪个"。
 */
export const ASR_QUICK_GUIDE = '国内网络选阿里，有海外网络选 Groq。';

/**
 * 纯文本厂商的说明（决策 #268 的定稿口径）。
 *
 * ## 与初版口径的差别（重要）
 *
 * 补丁 §F4 当初写的是「配置页给出此提示」，我第一版理解为
 * "在语音配置页里列出来然后提示不可用"。
 * **2026-10-29 定稿改为：选项里不出现，只在使用说明里解释。**
 *
 * 这个改法更好，理由是"列出来再报错"本身就是一次挫败：
 * 用户会先选、填 key、测试、失败，才知道这条路不通。
 * 而说明里的一句话，是在他**动手之前**就把它排除掉。
 *
 * 注意文案里必须给出**正确位置**（聊天后端）——
 * 只说"不能用"会让用户以为这个 key 白买了。
 */
export const TEXT_ONLY_VENDORS_NOTE =
  'DeepSeek、Kimi 等纯文本模型没有语音识别能力，不能用于语音配置；' +
  '它们的正确位置是聊天后端。';

/**
 * 中转站的隐私补充文案（定稿第 4 条）。
 *
 * 原文与 §2「服务端零接触音频」并不矛盾，但**必须补上**：
 * 直连厂商时音频只到厂商，走中转时多经过一层第三方。
 * 不写这一句，"隐私优先"就成了空头承诺。
 */
export const ASR_RELAY_PRIVACY_NOTE = '使用中转站时，音频会经过第三方服务器。';

/**
 * 中转站的「模型名」填法说明（定稿第 1 条）。
 */
export const ASR_RELAY_MODEL_HINT = '模型名填你站里对应的 ID，多数中转站兼容 OpenAI 接口。';

/**
 * 聊天后端（F5）的中转站说明（定稿第 5 条）。
 *
 * ST 的 `custom` 源 + `reverse_proxy` **本来**就是中转站接法，
 * 所以这条只加一句说明，**不额外开发** —— 定稿明确要求"不额外开发"。
 * 写进常量是为了让它和 ASR 侧的中转站说明成对出现，
 * 将来有人想在聊天侧"也做一个中转站配置页"时能看到这里已经有答案。
 */
export const CHAT_RELAY_NOTE =
  '支持 OpenAI 兼容中转站：后端选「自定义」，在反代地址里填中转站地址即可。';

/** 按 id 找预设。找不到返回 `null`（不抛错：配置里可能存着旧版本的 id） */
export function findAsrPreset(id: string): AsrPreset | null {
  return ALL_ASR_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * 这个预设是否还需要用户填 base_url / model。
 *
 * UI 用它决定"字段是否置灰"与"保存按钮是否可用"。
 * 单独一个函数而不是让 UI 判 `preset.baseUrl === ''`：
 * 那样每处都要判两次（baseUrl 与 model），必然有人漏判 model。
 */
export function requiresManualInput(preset: AsrPreset): { baseUrl: boolean; model: boolean } {
  return { baseUrl: preset.baseUrl === '', model: preset.model === '' };
}

/**
 * 校验三字段是否填齐（保存前调）。
 *
 * 返回的是**缺哪个字段**，不是一句"请填写完整"：
 * 用户点保存被拦时，要能一眼看到是 base_url 空着还是 model 空着。
 *
 * ## key 是否必填由**预设**决定（决策 #338）
 *
 * 自建 Gradio 服务没有鉴权，硬要一个 key 只会让用户去编一串字符塞进去。
 * 但这里判的是 `preset.requiresKey === false`，**不是** `apiKey === ''` ——
 * 后者会把"忘了填 key"变成"能保存"，用户拿到 401 才回头找原因。
 *
 * ## presetId 找不到时按"需要 key"处理
 *
 * 配置里可能存着旧版本的 id（用户升级前选的厂商被下线了）。
 * 此时**保守地要求 key**：多填一个字段是可恢复的，
 * 而"以为不需要 key"要到 401 才发现，且错误信息指向鉴权、不指向配置。
 */
export function validateAsrConfig(input: {
  presetId: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}): { ok: true } | { ok: false; missing: Array<'baseUrl' | 'apiKey' | 'model'> } {
  const preset = findAsrPreset(input.presetId);
  const keyRequired = preset === null ? true : preset.requiresKey;

  const missing: Array<'baseUrl' | 'apiKey' | 'model'> = [];
  if (input.baseUrl.trim() === '') missing.push('baseUrl');
  if (keyRequired && input.apiKey.trim() === '') missing.push('apiKey');
  if (input.model.trim() === '') missing.push('model');
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/**
 * 这条预设要不要显示 key 输入框。
 *
 * 单独一个函数而不是让 UI 判 `preset.requiresKey !== false`：
 * 那个表达式在"找不到预设"时要写成 `!== false` 才对（三态），
 * 每处都要想一遍，必然有人写成 `=== true` 然后让旧配置的用户看不到 key 框。
 */
export function needsApiKey(presetId: string): boolean {
  const preset = findAsrPreset(presetId);
  return preset === null ? true : preset.requiresKey;
}

/**
 * 只取某个模式下的预设（主 / 高级）。
 *
 * 两个模式**都包含中转站** —— 中转站既可能是转写接口，也可能被拿来转 chat，
 * 所以它在两边都该出现。放在这里统一加，而不是在 UI 里各加一次
 * （各加一次的后果是有人只加了一边）。
 */
export function presetsForMode(advanced: boolean): AsrPreset[] {
  return [...(advanced ? ASR_ADVANCED_PRESETS : ASR_PRESETS), ASR_RELAY_PRESET];
}
