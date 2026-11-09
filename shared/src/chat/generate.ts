/**
 * 聊天生成的请求准备（v0.1.7 / T15.5）。
 *
 * ## 三件事，都在契约里点明过
 *
 * 1. **六后端源**（决策 #269）：`openai` / `custom` / `deepseek` / `openrouter`
 *    / `groq` / `claude`。其余**明确报错，不许静默回退**到 openai ——
 *    静默回退的后果是用户选了"某个没支持的源"，请求发到 openai 的地址上，
 *    拿到一个 401 或者（更糟）被别家按自己格式解析后返回一堆乱码，
 *    而他完全看不出"是这里没支持"。
 *
 * 2. **采样参数随请求体带**（契约 §3.3 / 陷阱 #1 的补充）：ST 的服务端
 *    **不读** `settings` 里的采样参数，只认请求体。所以 temperature / top_p
 *    这类必须自己拼进去；只在设置里写一遍，生成时完全无效。
 *
 * 3. **key 只写不读**（契约 §3.5）：`/api/secrets/write` 能写，
 *    但读回来的是掩码。所以界面上**不许**尝试回显 key ——
 *    那不是"读一下"，那是拿不到还要假装拿到了。
 *
 * ## 流式判定不看响应头（陷阱 #10）
 *
 * ST 的流式响应**没有** `Content-Type: text/event-stream`。
 * 所以"是不是流式"只能由**我们自己发出去的请求参数**决定 ——
 * 见 `isStreamingRequest`（已在 `sse.ts`，这里复用不重写）。
 *
 * 决策 #269 / 契约 §3.3。
 */

import type { StChatSource, StGenerateRequest } from '../st-adapter/types.js';
import { SUPPORTED_CHAT_SOURCES, isSupportedChatSource } from '../st-adapter/types.js';
import {
  buildReasoningInjection,
  manualProfile,
  matchProfile,
  mergeUserBody,
  resolveBudgetValue,
  type BudgetSpec,
  type ParamFamily,
  type ReasoningProfile,
  type ThinkingIntent,
} from './reasoningProfiles.js';

/**
 * v1 支持的六个后端源。**这个数组来自 `types.ts` 的 `SUPPORTED_CHAT_SOURCES`**，
 * 不在这里另写一份 —— 两处各写一份必然分叉（改一处忘了另一处，
 * 界面上能选但请求被拒，或反之）。
 */
export const CHAT_SOURCES: readonly StChatSource[] = SUPPORTED_CHAT_SOURCES;

/** 后端源的展示名与说明。给 API 连接页用。 */
/*
 * `modelPlaceholder` 是**模型名的真实样例**，不是"例如 xxx"这种空话。
 *
 * 为什么要给：模型名是最难记的字段，而且各家命名规则完全不同
 * （`gpt-4o-mini` / `deepseek-chat` / `anthropic/claude-3.5-sonnet` /
 * `claude-sonnet-4-20250514`）。给一个能直接抄的例子，
 * 比写"请填写正确的模型名"有用得多 —— 后者等于没说。
 *
 * 2026-10-31 加：此前只有一句通用 placeholder「例如 gpt-4o-mini」，
 * 在 DeepSeek / Claude 下会误导（它们没有 `gpt-` 开头的模型）。
 */
export const CHAT_SOURCE_LABELS: Record<
  StChatSource,
  { label: string; hint: string; modelPlaceholder: string }
> = {
  openai: {
    label: 'OpenAI',
    hint: '官方接口，需要 OpenAI 的 key',
    modelPlaceholder: 'gpt-4o-mini',
  },
  custom: {
    label: '自定义（OpenAI 兼容）',
    hint: '任意兼容 OpenAI 格式的服务，自己填地址',
    modelPlaceholder: '按你的服务填',
  },
  deepseek: {
    label: 'DeepSeek',
    hint: 'DeepSeek 官方接口',
    /*
     * ★ 2026-11-07 更正示例值。
     *
     * `GET https://api.deepseek.com/models` 实测返回的**正式**模型名只有：
     *
     * ```text
     *   deepseek-v4-pro     DeepSeek-V4-Pro      上下文 1048576
     *   deepseek-flash      DeepSeek-V4.1-Flash  上下文 1048576（支持图片）
     * ```
     *
     * 而这里原来写的是 `deepseek-chat`。
     *
     * ★ 分辨清楚一件事：`deepseek-chat` 并**不是**错的 —— 实测它仍可用，
     *   服务端会把它别名到 `deepseek-flash`（响应里 `model` 字段就是
     *   `deepseek-flash`）。但它是个**不写在文档里**的兼容别名，
     *   而且指向的是 flash 而不是 pro：用户以为自己用的是旗舰，
     *   实际跑在轻量模型上。
     *
     * 所以示例值改成正式名称。示例的作用是"能直接抄着用、且用的是
     * 你以为的那个东西"，别名做不到第二条。
     */
    modelPlaceholder: 'deepseek-v4-pro',
  },
  openrouter: {
    label: 'OpenRouter',
    hint: '一个 key 用多家模型',
    modelPlaceholder: 'anthropic/claude-3.5-sonnet',
  },
  groq: {
    label: 'Groq',
    hint: '推理速度快',
    modelPlaceholder: 'llama-3.3-70b-versatile',
  },
  claude: {
    label: 'Claude',
    hint: 'Anthropic 官方接口',
    modelPlaceholder: 'claude-sonnet-4-20250514',
  },
};

/*
 * `isSupportedChatSource` **不在这里重写** —— `st-adapter/types.ts` 已有同名实现，
 * 且带着"为什么必须显式判、不许静默回退"的完整理由。两处各写一份必然分叉
 * （改一处忘另一处，就会出现"界面上能选但请求被拒"或反之）。
 * 这里直接复用，见文件头的 import。
 */

/**
 * 不支持时的报错文案。
 *
 * 按项目纪律，**每一句给用户看的话都要能指导下一步**：
 * 「不支持的接口类型」不合格，用户不知道该改什么。
 */
export function unsupportedSourceMessage(value: string): string {
  return (
    `接口类型「${value}」不支持。` +
    `可选：${CHAT_SOURCES.join(' / ')}。` +
    '需要其它服务的话，选「自定义（OpenAI 兼容）」并填写它的地址。'
  );
}

/** 采样参数。全部可选 —— 不传就用服务端缺省。 */
export interface SamplingParams {
  temperature?: number;
  topP?: number;
  topK?: number;
  /** 按概率动态裁剪候选（ST 请求体字段 `top_a`） */
  topA?: number;
  /** 概率下限裁剪（ST 请求体字段 `min_p`） */
  minP?: number;
  maxTokens?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  /** 重复惩罚（ST 请求体字段 `repetition_penalty`） */
  repetitionPenalty?: number;
  /** 随机种子。`-1` 表示随机（ST 语义），见下面 `buildGenerateRequest` 的处理 */
  seed?: number;
  /**
   * 推理强度（ST 请求体字段 `reasoning_effort`）。
   *
   * 取值是**字符串枚举**：`min` / `low` / `medium` / `high` / `max`。
   * `auto` 不会出现在这里 —— 派生层已经把它当作"不干预"剔除了
   * （部分中转站不认 `auto`，会直接 400）。
   */
  reasoningEffort?: string;
  /** 啰嗦程度（ST 请求体字段 `verbosity`）：`low` / `medium` / `high` */
  verbosity?: string;
  /** 停止串。ST 的字段名是 `stop`（数组） */
  stop?: readonly string[];

  /**
   * 思考意图（2026-11-07，P0 思考适配层）。
   *
   * `auto` = **不干预**（一个字段都不发，让厂商用它的默认值）。
   *
   * ★ 为什么不复用布尔：各家默认值不同（DeepSeek/Kimi/GLM/豆包/硅基默认**开**，
   * `qwen3-vl-*` 默认关）。用布尔会把"我不想管"强行解释成"关"，
   * 那是在替用户做错决定 —— 而且用户看不出是被谁改的。
   */
  thinkingIntent?: ThinkingIntent;
  /** 思考长度（`thinking_budget` 数值 / `reasoning_effort` 档位）。含义随厂商变 */
  thinkingBudget?: number | string;
  /**
   * 用户手动指定的参数族（2026-11-07，兜底）。
   *
   * 给了就优先于自动识别。用途：接口不在能力表里时，
   * 用户按厂商文档自选一族，参数就能正常发出去。
   */
  thinkingFamily?: ParamFamily;
}

/** 拼装生成请求需要的全部输入 */
export interface BuildGenerateInput {
  /** 后端源。**必须已被 `isSupportedChatSource` 确认过** */
  source: StChatSource;
  model: string;
  /** 已经由 `assembleContext` 算好的 messages */
  messages: StGenerateRequest['messages'];
  /** 用户这次输入（用于「继续」时的 prefill 之外的场景） */
  sampling?: SamplingParams;
  /** 「继续」用：把最后一条 assistant 的正文作为 prefill */
  prefill?: string;
  /** 是否流式。v1 恒为 true（自研面板要打字机效果） */
  stream?: boolean;
  /**
   * 自定义服务地址（契约 §3.2 的 `custom_url`，**只对 custom 源有意义**）。
   *
   * 2026-10-31 第五批：`ApiPageState.baseUrl` 之前连存都没存，
   * 更不用说带进请求体。结果是用户填了地址、保存成功、生成时 ST
   * 仍然用 `reverse_proxy` 里的旧值（或官方地址）—— 表现为"填了没用"。
   */
  customUrl?: string;
  /**
   * 用户手写的请求体补充（JSON 或 YAML），与能力表算出来的**合并**，
   * 且**用户优先**。
   *
   * P0 阶段 UI 还没做这个入口，但接口先留着：
   * 能力表一定有过期的一天，那条"用户能自救"的路不能堵死。
   */
  customIncludeBody?: string;
}

/**
 * 这次用的是哪条通道（2026-11-07）。
 *
 * ```text
 *   native    ST 自己支持思考开关 → 发 include_reasoning（+ reasoning_effort）
 *   inject    custom 源 + 认得这家 → custom_include_body 注入那家的参数
 *   fallback  都不行 → 什么都不发，并标记 unsupported 让 UI 说实话
 * ```
 */
export type ReasoningChannel = 'native' | 'inject' | 'fallback';

/** 这次思考设置的最终结论（**给 UI 用**，不是日志） */
export interface ReasoningPlan {
  readonly channel: ReasoningChannel;
  /** 命中的厂商 id；没命中为 null */
  readonly profileId: string | null;
  readonly intent: ThinkingIntent;
  /**
   * 用户要"关"，但模型强制思考 ⇒ 已降级为"限制长度"。
   * UI 必须据此显示"关不掉，已限长"，**不许**显示"已关闭"。
   */
  readonly degraded: boolean;
  /** 认不出这家 / 这个源不支持 ⇒ UI 要说明"设置不会生效" */
  readonly unsupported: boolean;
  /** 一句话说明（直接显示给用户） */
  readonly reason?: string;
  /**
   * 正常但**需要解释**的情况（不是错误）。
   *
   * 目前只有一种：DeepSeek / Claude 这类原生源下，用户选「自动」时
   * ST 会**默认关闭**思考（它恒发 `thinking:{type:'disabled'}`）。
   * 不说清的话用户会以为"自动"给了厂商默认（开），实际是关。
   */
  readonly note?: string;
}

/**
 * 预演结果 —— **UI 层的唯一数据来源**（2026-11-07，P0 第三步）。
 *
 * ## 为什么 UI 必须只吃这个对象
 *
 * 用户明令：「不要在前端去猜模型名字或厂商，必须且只能依赖 ReasoningPlan」。
 *
 * 这条不只是洁癖：判断"这次能不能关思考"需要知道三件事 ——
 * 源、地址、模型名、以及能力表。前端如果自己拼，就有了第二份判定逻辑；
 * 改能力表时必然只有一处被改，于是**界面显示可用、请求里其实没发**。
 *
 * 所以前端拿到的是"结论 + 渲染所需的元数据"，一个判断都不做。
 */
export interface ReasoningPreview {
  /** 结论（分支 A/B/C 全靠它） */
  readonly plan: ReasoningPlan;
  /** 命中厂商的显示名；UI 用来写"当前按 DeepSeek 的规则处理" */
  readonly profileLabel: string | null;
  /**
   * 思考长度旋钮。
   *
   * `null` = 这家没有这个旋钮（DeepSeek / Kimi 官方接口），UI **隐藏**该项。
   * `value` 已经是**夹取后**的值，UI 直接回显即可（与真正发出去的一致）。
   */
  readonly budget: { readonly spec: BudgetSpec; readonly value: number | string } | null;
  /**
   * 这次要注入的字段（注入通道）。UI 一般不直接用，但"预览请求体"的调试
   * 面板要显示它 —— 用户能看见到底发了什么，比解释十句都有用。
   */
  readonly injectionBody: Record<string, unknown>;
  /**
   * 「推理强度」这一项**由谁负责**（2026-11-07 修双入口）。
   *
   * ## 为什么不能只用一个布尔
   *
   * 早先这里叫 `effortEffective: boolean`。但实测发现它盖不住第三种情况：
   *
   * ```text
   *   deepseek / glm 的「思考长度」用的就是 reasoning_effort 这个字段
   *   ⇒ 高级设置里再放一个「推理强度」，两个控件指向同一个字段
   * ```
   *
   * 真实现象：GLM 的注入体里明明写着 `reasoning_effort: "max"`，
   * 但「高级设置 → 推理强度」是灰的 —— 用户看到"同一个东西一个能用一个不能用"。
   *
   * 所以改成三态：
   *
   * ```text
   *   'budget'    已被「思考长度」接管 ⇒ 高级项**隐藏**（不是置灰）
   *   'advanced'  高级项自己可用（原生通道，走 include_reasoning + effort）
   *   'none'      谁也发不出去 ⇒ 高级项置灰并说明原因
   * ```
   *
   * ★ `'budget'` 必须**隐藏而不是置灰**：置灰会暗示"这里本来能调，
   *   只是现在不行"，而实际上用户想要的那个旋钮就在上面，能调。
   */
  readonly effortHandled: 'budget' | 'advanced' | 'none';

  /**
   * 「思考长度」这一项目前**是否真的起作用**（2026-11-07）。
   *
   * 用户问的原话：
   *
   * > 思考和思考长度没有说明这两个选型的关系，思考关闭后思考长度是
   * > 有效还是无效这个没有说明。
   *
   * 答案分三种情况：
   *
   * ```text
   *   思考 = 关，模型可关     → false  已经不想了，再限长度毫无意义
   *   思考 = 关，模型关不掉   → true   降级就是靠压这个值实现的（关键！）
   *   思考 = 自动 / 开        → true   只要这家有旋钮就有效
   * ```
   *
   * ★ 中间那一格不能搞错：强制思考的模型上，用户点了「关闭」，
   *   一切实际控制都落在「思考长度」上。把它置灰等于让用户
   *   完全失去控制手段 —— 而且界面上会显得"关了也没用"。
   */
  readonly budgetEffective: boolean;

  /**
   * 一句给用户看的解释：为什么长度可调 / 为什么不可调。
   *
   * **UI 直接显示这一句**，不要自己拼 —— 三种情况的措辞差别很大，
   * 而"什么时候该说哪句"已经在上面那个布尔里算过了。
   */
  readonly budgetNote: string;
}

/**
 * ST 里**原生**读 `include_reasoning` 的源。
 *
 * 只列这两家是因为查过 ST 源码：
 *
 * ```text
 *   deepseek → thinking:{type: include_reasoning?'enabled':'disabled'}（恒发）
 *              且 reasoning_effort 的转发条件也是 include_reasoning && effort
 *   claude   → 决定是否算 thinking.budget_tokens
 * ```
 *
 * `openrouter` 虽然也读，但它的语义是"要不要把思考内容返回给你"，
 * 不是"要不要思考"——放在这里会误导，P0 先不列。
 */
const NATIVE_REASONING_SOURCES: readonly StChatSource[] = ['deepseek', 'claude'];

/** 拼装结果。用判别式把"为什么不合法"带出来。 */
export type BuildGenerateResult =
  | {
      ok: true;
      request: StGenerateRequest;
      /**
       * 思考设置的结论（2026-11-07）。
       *
       * 成功时**一定**有（哪怕是 `unsupported`），因为 UI 要靠它决定
       * 显示"已关闭"还是"关不掉，已限长"还是"这个接口不支持"。
       */
      reasoning: ReasoningPlan;
    }
  | {
      ok: false;
      /**
       * 失败原因分类。
       *
       * `missing-custom-url`（2026-11-01 加）：选了「自定义（OpenAI 兼容）」
       * 却没带地址。
       *
       * 为什么必须显式失败：不带 `custom_url` 时 ST 会回落到内置 OpenAI 地址，
       * 用的是**另一个** key 槽位 —— 结果是 15 毫秒就返回、界面上一个空气泡。
       * 那种失败**没有任何可归因的信息**，用户只能看到"发了没反应"。
       */
      reason: 'unsupported-source' | 'empty-model' | 'empty-messages' | 'missing-custom-url';
      message: string;
    };

/**
 * 拼装 `/api/backends/chat-completions/generate` 的请求体。
 *
 * ## 为什么采样参数要在这里逐个显式映射
 *
 * ST 的字段名是驼峰（`top_p` / `top_k` / `max_tokens` / `presence_penalty`），
 * 而界面上是给人看的（`topP`）。**两层名字的映射只有这一处**，
 * 散到各处就会出现"温度传了、top_p 没传"这种半生效状态。
 *
 * ## 为什么 `stream` 默认 true
 *
 * 自研面板要打字机效果。传 `false` 会拿到一次性 JSON，界面就只能"卡一下然后整段出现"，
 * 而用户会以为卡住了。这个默认值是产品决定，不是技术缺省。
 */
export function buildGenerateRequest(input: BuildGenerateInput): BuildGenerateResult {
  if (!isSupportedChatSource(input.source)) {
    return {
      ok: false,
      reason: 'unsupported-source',
      message: unsupportedSourceMessage(String(input.source)),
    };
  }

  const model = input.model.trim();
  if (model === '') {
    return {
      ok: false,
      reason: 'empty-model',
      message: '还没填模型名。到「我的 → API 连接」里选一个接口并填写模型名。',
    };
  }

  if (input.messages.length === 0) {
    return {
      ok: false,
      reason: 'empty-messages',
      message: '没有可发送的内容。检查角色卡与聊天记录是否为空。',
    };
  }

  const request: StGenerateRequest = {
    chat_completion_source: input.source,
    model,
    messages: input.messages.map((m) => ({ ...m })),
    stream: input.stream !== false,
  };

  // 采样参数：只写有值的（`undefined` 会被 JSON.stringify 丢掉，但显式判断更清楚）
  const s = input.sampling ?? {};
  if (typeof s.temperature === 'number') request.temperature = s.temperature;
  if (typeof s.topP === 'number') request.top_p = s.topP;
  if (typeof s.topK === 'number') request.top_k = s.topK;
  if (typeof s.topA === 'number') request.top_a = s.topA;
  if (typeof s.minP === 'number') request.min_p = s.minP;
  if (typeof s.maxTokens === 'number') request.max_tokens = s.maxTokens;
  if (typeof s.presencePenalty === 'number') request.presence_penalty = s.presencePenalty;
  if (typeof s.frequencyPenalty === 'number') request.frequency_penalty = s.frequencyPenalty;
  if (typeof s.repetitionPenalty === 'number') request.repetition_penalty = s.repetitionPenalty;

  /*
   * 种子：`-1` 是 ST 语义的"随机"，**不是**一个可以发出去的种子值。
   *
   * ST 的各个后端处理方式不同，有的把 `-1` 当"随机"，有的直接原样传给上游
   * 导致上游报参数非法。所以这里统一把 `-1` 解释成"不带这个字段"，
   * 与"用户没设置"完全等价 —— 顺便也覆盖了"用户从预设里导入了一个 -1"的情况。
   */
  if (typeof s.seed === 'number' && Number.isFinite(s.seed) && s.seed >= 0) {
    request.seed = Math.trunc(s.seed);
  }

  /*
   * 字符串枚举：只认非空、且不是 `auto` 的值。
   *
   * `auto` 在 ST 里表示"不指定"，但把它**发出去**是一个具体的取值。
   * 有些中转站/上游不认 `auto`，会直接 400 —— 而用户只是选了"自动"，
   * 得到的却是"请求失败"，难归因。派生层与这里各拦一道。
   */
  if (typeof s.reasoningEffort === 'string') {
    const effort = s.reasoningEffort.trim();
    if (effort !== '' && effort !== 'auto') request.reasoning_effort = effort;
  }
  if (typeof s.verbosity === 'string') {
    const verbosity = s.verbosity.trim();
    if (verbosity !== '' && verbosity !== 'auto') request.verbosity = verbosity;
  }
  if (Array.isArray(s.stop) && s.stop.length > 0) request.stop = [...s.stop];

  if (typeof input.prefill === 'string' && input.prefill !== '') {
    request.prefill = input.prefill;
  }

  /*
   * 自定义地址：`source === 'custom'` 时必须带，且不能为空。
   *
   * ★ 2026-11-01：原来是"有就带、没有就静默不带"。那是个真缺陷 ——
   * 不带 `custom_url` 时 ST 会回落到内置 OpenAI 地址、用另一个 key 槽位，
   * 于是请求 15 毫秒就结束，界面上只留一个空气泡，**没有任何可归因的信息**。
   * 现在缺地址直接判失败，把原因说清楚。
   */
  if (input.source === 'custom') {
    const url = typeof input.customUrl === 'string' ? input.customUrl.trim() : '';
    if (url === '') {
      return {
        ok: false,
        reason: 'missing-custom-url',
        message: '自定义接口还没填服务地址。到「我的 → API 连接」里填上（到 /v1 为止）再发。',
      };
    }
    request.custom_url = url;
  }

  /* ── 思考模式：三通道判定（2026-11-07，P0）── */
  const reasoning = applyReasoningPlan(input, request);

  return { ok: true, request, reasoning };
}

/**
 * 决定这次的思考参数走哪条通道，并**就地**把它写进请求体（2026-11-07，P0）。
 *
 * ## 为什么必须分三条通道
 *
 * 因为 ST 对不同源的处理方式**完全不同**（都查过源码）：
 *
 * ```text
 *   deepseek 源   ST 恒发 thinking:{...}，且 reasoning_effort 要 include_reasoning 才转发
 *   claude 源     include_reasoning 决定算不算 thinking.budget_tokens
 *   custom 源     ★ 完全不读思考相关字段，但有 custom_include_body 能注入任意 JSON
 *   openai 源     reasoning_effort 受硬编码白名单（只认 o1/o3/o4/gpt-5.x）
 *   siliconflow   ★ 分支里干脆没有 thinking 处理
 * ```
 *
 * ⇒ 只靠 `include_reasoning` 最多覆盖两家；要"最大兼容"必须用注入通道。
 *
 * ## 通道选择规则（顺序即优先级）
 *
 * ```text
 *   ① native    源 ∈ {deepseek, claude} 且认得出厂商 → include_reasoning
 *   ② inject    source === 'custom' 且认得出厂商     → custom_include_body
 *   ③ fallback  其它                                   → 不发，标记 unsupported
 * ```
 *
 * ## auto 为什么"什么都不发"，而不是发成 off
 *
 * `auto` 的语义是"我不想管，用厂商默认"。而各家默认值不同
 * （DeepSeek/Kimi/GLM/豆包默认开，`qwen3-vl-*` 默认关）。
 * 把 auto 翻译成 off 就是**替用户做错决定**，而且他还看不出是谁改的。
 *
 * ★ 代价要说清：原生通道下 ST 会**默认关**思考（它恒发 `disabled`），
 *   所以 DeepSeek 源上"自动"实际等于"关"。这不是我们造成的，
 *   但必须通过 `note` 告诉用户 —— 否则他选"自动"会困惑为什么没有思考。
 */
/**
 * 预演：只算「这次会走哪条通道、UI 该显示什么」，**不碰请求体**。
 *
 * ## 为什么必须单独一个函数（而不是让 UI 自己判断）
 *
 * UI 在**渲染时**就要知道"当前配置能不能关思考"。如果前端自己按
 * `source === 'custom'` / `model.startsWith('deepseek')` 去猜，
 * 那就有了**第二份**判定逻辑 —— 改能力表时必然只有一处被改，
 * 于是界面显示"可用"而请求里其实没发（或反之）。
 * 那正是本项目反复出现的缺陷形状。
 *
 * 所以：`previewReasoningPlan` 与 `applyReasoningPlan` **共用同一个实现**，
 * 前者给 UI，后者给发送。能力表变了，两边同时变。
 *
 * ## `effortHandled` 是干什么的
 *
 * 「推理强度」（`reasoning_effort`）有三种处境，必须分开表达：
 *
 * ```text
 *   'advanced'  原生通道能发（实测 deepseek 源 + include_reasoning + effort
 *               三者都到达上游）⇒ 高级设置里那个下拉可用
 *   'budget'    这家的「思考长度」旋钮**就是** reasoning_effort
 *               （DeepSeek / GLM）⇒ 已被上面那个控件接管，高级项隐藏
 *   'none'      注入通道且预算不是 effort ⇒ 发不出去，高级项置灰
 * ```
 *
 * ★ 中间这一态是 2026-11-07 补的。原来只有一个布尔，表达不了
 *   "这个字段已经有别的主人在调它"，于是 GLM 上出现
 *   "注入体里明明有 reasoning_effort，高级项却是灰的" 这种自相矛盾。
 */
export function previewReasoningPlan(input: {
  source: StChatSource;
  model: string;
  customUrl?: string;
  intent: ThinkingIntent;
  budget?: number | string;
  /**
   * 用户手动指定的参数族（兜底，2026-11-07）。
   *
   * 给了就**优先于自动识别** —— 用户手上可能有厂商文档，而我们的
   * 能力表必然会过期。那条"用户能自救"的路必须留着。
   *
   * 不传 = 走 `matchProfile` 自动识别。
   */
  manualFamily?: ParamFamily;
}): ReasoningPreview {
  const intent = input.intent;
  const model = (input.model ?? '').trim();
  /*
   * 只有 custom 源才有"用户填的地址"这个概念。
   * 官方源的地址由 ST 内部常量决定，不需要参与匹配。
   */
  const baseUrl = input.source === 'custom' ? (input.customUrl ?? '') : '';
  /*
   * ★ 手选优先。
   *
   * 顺序不能反：如果先自动识别、认出来了就不用用户的指定，
   * 那么"识别错了但用户知道正确答案"的情况就永远救不回来 ——
   * 而识别错的表现是**静默无效**（参数发出去但对方法认），
   * 用户没有任何线索能发现。
   */
  const profile =
    input.manualFamily === undefined
      ? matchProfile({ baseUrl, model })
      : manualProfile(input.manualFamily);

  const injection =
    profile === null ? null : buildReasoningInjection(profile, intent, input.budget, model);

  /* 思考长度控件的规格与当前显示值（这家没有旋钮就是 null） */
  const budgetView =
    profile?.budget === undefined
      ? null
      : {
          spec: profile.budget,
          value: resolveBudgetValue(profile.budget, input.budget),
        };

  /*
   * 「推理强度」归谁管（2026-11-07 修双入口）。
   *
   * ★ 关键判断：如果这家的「思考长度」旋钮**就是** `reasoning_effort`
   *   （DeepSeek / GLM 是这样），那它已经被上面的控件接管了 ——
   *   高级项必须**隐藏**，否则同一个字段有两个入口，
   *   而且其中一个（走原生字段的那个）在注入通道下还是灰的，
   *   用户会看到"明明注入体里有 reasoning_effort，这里却说不可用"。
   */
  const budgetOwnsEffort = budgetView?.spec.key === 'reasoning_effort';

  /*
   * 「思考长度」此刻是否真的在起作用（2026-11-07）。
   *
   * 三种情况见 `ReasoningPreview.budgetEffective` 的注释。
   * ★ 判断依据只有 intent + degraded + 有没有旋钮 —— 不涉及厂商猜测。
   */
  const forcedByModel = injection?.degraded === true;
  const budgetEffective =
    budgetView !== null && (intent !== 'off' || forcedByModel);

  const budgetNoteOf = (): string => {
    if (budgetView === null) return '';
    if (intent === 'off' && forcedByModel) {
      /*
       * 最关键的一格：用户关不掉，我们就把长度压到最轻。
       * 必须说清"这一项现在就是你唯一的控制手段"。
       */
      return '这个模型关不掉思考，所以你选「关闭」后只能靠这一项压短思考。';
    }
    if (intent === 'off') {
      return '思考已关闭，这一项暂时不生效。要调它请先把思考设为「开启」或「自动」。';
    }
    if (intent === 'auto') {
      return '思考为「自动」时这一项仍然生效：它只限制思考最长多少，不等于开启思考。';
    }
    return '思考开启时，这一项决定它最多想多久。';
  };

  const base = {
    profileLabel: profile?.label ?? null,
    budget: budgetView,
    injectionBody: injection?.body ?? {},
    budgetEffective,
    budgetNote: budgetNoteOf(),
  };

  /* ═══ 通道① 原生 ═══ */
  if (profile !== null && NATIVE_REASONING_SOURCES.includes(input.source)) {
    if (injection?.degraded === true) {
      /*
       * 强制思考的模型（如 deepseek-reasoner）：用户要关也关不掉。
       * UI 必须置灰主开关并显示"已降级"，不许显示"已关闭"。
       */
      return {
        ...base,
        plan: {
          channel: 'native',
          profileId: profile.id,
          intent,
          degraded: true,
          unsupported: false,
          reason: injection.reason,
        },
        /* 原生通道：effort 真能发出去；但若这家用它当「思考长度」就交给那边 */
        effortHandled: budgetOwnsEffort ? 'budget' : 'advanced',
      };
    }

    return {
      ...base,
      plan: {
        channel: 'native',
        profileId: profile.id,
        intent,
        degraded: false,
        unsupported: false,
        /* auto 时要解释"这个源下自动=关" */
        ...(intent === 'auto'
          ? { note: `${profile.label} 源下「自动」会沿用引擎默认（关闭思考）。要开启请选「开」。` }
          : {}),
      },
      effortHandled: budgetOwnsEffort ? 'budget' : 'advanced',
    };
  }

  /* ═══ 通道② 注入（custom 源）═══ */
  if (input.source === 'custom') {
    if (profile === null) {
      return {
        ...base,
        plan: {
          channel: 'fallback',
          profileId: null,
          intent,
          degraded: false,
          unsupported: true,
          reason: '认不出这个自定义接口属于哪一家，思考设置不会生效。',
        },
        effortHandled: 'none',
      };
    }

    return {
      ...base,
      plan: {
        channel: 'inject',
        profileId: profile.id,
        intent,
        degraded: injection?.degraded === true,
        unsupported: false,
        ...(injection?.reason === undefined ? {} : { reason: injection.reason }),
      },
      /*
       * 注入通道的 `reasoning_effort` 会被 ST 的白名单丢掉
       * （只认 o1/o3/o4/gpt-5.x）。
       *
       * 但如果这家的「思考长度」旋钮就是 reasoning_effort，
       * 那它已经通过 `custom_include_body` 真的发出去了 ⇒ 交给 'budget'。
       * 否则高级项在这里发不出去，如实标 'none' 让 UI 置灰。
       */
      effortHandled: budgetOwnsEffort ? 'budget' : 'none',
    };
  }

  /* ═══ 通道③ 兜底 ═══ */
  return {
    ...base,
    plan: {
      channel: 'fallback',
      profileId: profile?.id ?? null,
      intent,
      degraded: false,
      unsupported: true,
      reason:
        profile === null
          ? '这个接口不在思考适配表里，思考设置不会生效。'
          : `「${profile.label}」的思考参数需要走「自定义（OpenAI 兼容）」并填写它的地址才能生效。`,
    },
    effortHandled: 'none',
  };
}

/**
 * 把预演结果**写进请求体**（发送路径）。
 *
 * 除了"写"之外不做任何判断 —— 所有判断都在 `previewReasoningPlan` 里，
 * 这样 UI 看到的和实际发出去的必然一致。
 */
function applyReasoningPlan(input: BuildGenerateInput, request: StGenerateRequest): ReasoningPlan {
  const preview = previewReasoningPlan({
    source: input.source,
    model: input.model,
    customUrl: input.customUrl,
    intent: input.sampling?.thinkingIntent ?? 'auto',
    budget: input.sampling?.thinkingBudget,
    ...(input.sampling?.thinkingFamily === undefined
      ? {}
      : { manualFamily: input.sampling.thinkingFamily }),
  });
  const { plan } = preview;

  if (plan.channel === 'native') {
    /*
     * 降级时仍然发 `true`：发 false 会被 ST 翻成 disabled，
     * 而模型根本不听 —— 结果一样，却让请求体自相矛盾。
     */
    if (plan.intent === 'off' && !plan.degraded) {
      request.include_reasoning = false;
    } else if (plan.intent === 'on' || plan.degraded) {
      request.include_reasoning = true;
    }
    /* intent === 'auto'：不设字段，让 ST 用它自己的默认 */
    return plan;
  }

  if (plan.channel === 'inject') {
    const hasBody = Object.keys(preview.injectionBody).length > 0;
    const hasUserBody = (input.customIncludeBody ?? '').trim() !== '';

    /*
     * 只在"确实有东西要发"时才设这个字段。
     *
     * 为什么不能设空串：ST 里 `if (!yamlString) return;` 对空串是安全的，
     * 但设一个 `""` 会让请求体多一个无意义字段，将来排查时容易误判
     * "用户手写过"。
     */
    if (hasBody || hasUserBody) {
      request.custom_include_body = mergeUserBody(preview.injectionBody, input.customIncludeBody);
    }
    return plan;
  }

  return plan;
}

/**
 * 把服务端返回的错误翻译成人话。
 *
 * 为什么需要这个：ST 的 403 响应体是 **HTML**（契约 §9.3），
 * 直接把 HTML 丢到界面上，用户看到一整页 `<html>...`。
 */
export function explainGenerateError(status: number, bodyPreview: string): string {
  if (status === 403) {
    return '连接凭据失效了。回到聊天页重新连接一次即可（会自动重试一次）。';
  }
  if (status === 401) {
    return 'API key 不对或已过期。到「我的 → API 连接」里重新填一次。';
  }
  if (status === 429) {
    return '请求太频繁，或被上游限流了。等一会儿再试。';
  }
  /*
   * ★★★ 400 + **裸** `{"error":true}`（2026-11-07，用户真机报的那条）。
   *
   * ## 这个形状是什么
   *
   * ST 源码里几乎所有 400 都带 `message`，只有两类不带：
   *
   * ```text
   *   if (!apiKey && !request.body.reverse_proxy)
   *       → response.status(400).send({ error: true })      ← 缺 API key
   *   if (!request.body)
   *       → response.status(400).send({ error: true })      ← 请求体为空
   * ```
   *
   * 两个根因都是"配置/调用不完整"，不是上游的错。而原来它落到最后的
   * 兜底分支，界面上显示的是：
   *
   * ```text
   *   /api/backends/chat-completions/generate 返回 HTTP 400: {"error":true}
   * ```
   *
   * 一句**无法归因**的话 —— 用户既不知道是 key、是模型名、还是网络。
   * 真机取证（2026-11-07）：`secrets.json` 里只有 `api_key_openai` 与
   * `api_key_custom`，**没有 `api_key_deepseek`**；补上之后同一个请求
   * 立刻 200。⇒ 这条文案按"缺 key"来写，命中率最高。
   *
   * ## 为什么文案里要点出「当前这个接口」
   *
   * 用户很可能**别的源配过 key**（他就是），所以必须说清"是当前选的这个
   * 接口没有"，否则他会去看别的源、找不到问题。
   */
  if (status === 400 && isBareErrorTrue(bodyPreview)) {
    return (
      '当前这个接口还没有填 API key（或者没保存成功）。' +
      '到「我的 → API 连接」里展开当前接口，填上 key 并点保存，再回来发消息。'
    );
  }
  /*
   * 400 + **上游明确在怪 key**（2026-11-09）。
   *
   * 与上面那条的区别：上面是 ST 自己说"没有 key"（裸 `{error:true}`），
   * 这里是**请求确实发出去了**、上游收到了、但上游说这个 key 不行。
   *
   * 三种可能必须一起给出来，因为从我们这边分不清：
   *
   * ```text
   *   没存进去       App 显示已配置但 ST 读出来是空（secrets 数组没 active 项）
   *   key 本身不对   复制时少了字符、填了别家的 key
   *   额度用完/过期  中转站最常见，而它的措辞也是"Key 错误"
   * ```
   *
   * ★ 必须提"额度"这一条：用户看到"Key 错误"第一反应是重新粘贴 key，
   *   而真实原因是额度用完了 —— 重粘一百次也没用。
   */
  if (status === 400 && looksLikeKeyRejection(bodyPreview)) {
    return (
      '上游拒绝了这次请求里的 key。可能是三种情况之一：\n' +
      '① key 没真的存进去 —— 到「我的 → API 连接」展开当前接口，' +
      '重新粘贴一次 key 再点保存（保存时请确认下面的提示变成"已配置"）；\n' +
      '② key 填错或已被换掉 —— 重新从服务商那里复制完整的一串；\n' +
      '③ key 还能用但**额度用完 / 已过期** —— 中转站通常也用这句话报额度问题，' +
      '去服务商后台看一下余额与有效期。'
    );
  }
  /*
   * ★★★ 500 分两种，给的指引完全不同（2026-11-07 实测后改）。
   *
   * ## 裸 `{error:true}` 的 500 不是"上游偶尔抽风"
   *
   * ST **从来不透传上游状态码**：`chat-completions.js` 里所有厂商分支
   * 遇到上游错误都写成 `response.status(500).send({ error: true })`
   * （实测数了 5 处裸 error + 一堆 400）。所以上游的 403 到了 App 这边
   * 一律变成"500 + 裸 error"。
   *
   * 而 403 在实践中最常见的原因不是故障，是**这个接口在当前网络/地区不可用**。
   * 真机实测（成都电信 + 手机各测一遍，两个不同出口 IP）：
   *
   * ```text
   *   Groq   → 403 {"error":{"message":"Forbidden"}}          cf-ray …-SIN
   *   Claude → 403 {"error":{"type":"forbidden",
   *                          "message":"Request not allowed"}}
   *   OpenAI → DNS 被污染（解析到 face:b00c 那段），TCP 直接超时
   * ```
   *
   * 这些都不会因为"稍后再试"而变好。原来那句「稍后再试」是**错的指引**：
   * 用户会一直重试，永远学不到"要换网络或换中转站"。
   *
   * ## 为什么不说死"就是地区封锁"
   *
   * 因为 ST 把状态码吃掉了，我们**分不清**上游是 403 还是 500。
   * 所以文案要同时给出两种可能，并把"怎么区分"告诉用户 ——
   * 反复失败 ⇒ 不是临时故障。
   */
  if (status >= 500) {
    if (isBareErrorTrue(bodyPreview)) {
      return (
        `上游拒绝了这次请求（${status}，服务端没给出具体原因）。` +
        '常见两种：① 这个接口在你当前的网络或地区不可用（这种情况重试没用，要换网络或改用中转站）；' +
        '② 上游临时故障（这种等一会儿会好）。如果反复失败，基本是第一种。'
      );
    }
    return `上游服务出错了（${status}）。这通常不是这一端的问题，稍后再试。`;
  }
  // bodyPreview 已经是纯文本截断（调用方负责），这里只兜底
  const hint = bodyPreview.trim().slice(0, 120);
  return hint === ''
    ? `生成失败（${status}）。`
    : `生成失败（${status}）：${hint}`;
}

/**
 * body 是不是"裸的 `{error: true}`" —— 只有 `error` 一个键、值为 true。
 *
 * ## 为什么不用 `includes('"error":true')`
 *
 * 上游的错误也可能是 `{"error":{"message":"..."}}`，那种要原样透传
 * （里面有具体原因）。只有"说不清原因"的那个才需要我们翻译。
 *
 * 容忍度：`{"error":true}` / `{ error: true }` / `{"error": true}` 都认；
 * 只要还带了别的键（例如 `message`），就**不算**裸的。
 */
/**
 * 上游是不是在**怪这个 key**（2026-11-09，用户真机报的那条）。
 *
 * ## 为什么要单独认这一种
 *
 * 用户的错误长这样（来自中转站，不是 ST）：
 *
 * ```text
 *   400 {"error":{"code":"","message":"Key 错误：Key 填错、过期或未设置
 *        Bearer。请检查 Key。（request id: …）"}}
 * ```
 *
 * 这句话对用户没有信息量：他不知道是"没存进去""填错了"还是"额度用完了"，
 * 而三种处置完全不同。原来它落到兜底分支，界面原样打印这段英文+中文混排，
 * 用户只能来问。
 *
 * ## 判据为什么用关键词而不是精确匹配
 *
 * 中转站、各家代理、官方 API 的措辞都不一样，但都在说同一件事：
 *
 * ```text
 *   Key 错误 / 无效的令牌 / Incorrect API key / invalid_api_key
 *   Unauthorized / 未设置 Bearer / 鉴权失败 / authentication
 * ```
 *
 * 认关键词，不认某一句原文 —— 否则换个中转站就又认不出了。
 */
function looksLikeKeyRejection(bodyPreview: string): boolean {
  const text = bodyPreview.toLowerCase();
  return (
    /key\s*错误|密钥|秘钥|令牌|鉴权|未设置\s*bearer/.test(bodyPreview) ||
    /invalid[ _-]?api[ _-]?key|incorrect[ _-]?api[ _-]?key|unauthorized|authentication/.test(text) ||
    /bearer/.test(text)
  );
}

function isBareErrorTrue(bodyPreview: string): boolean {
  const text = bodyPreview.trim();
  /* 只取第一层：找最外层对象 */
  const m = /^\{([\s\S]*)\}$/.exec(text);
  if (m === null) return false;
  const inner = m[1] ?? '';
  if (/message|detail|code|hint|reason/i.test(inner)) return false;
  return /["']?error["']?\s*:\s*true/.test(inner);
}
