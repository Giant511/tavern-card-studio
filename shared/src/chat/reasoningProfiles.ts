/**
 * 思考模式的能力表（2026-11-07，P0）。
 *
 * ## 为什么需要这张表
 *
 * 各家"关思考"的参数**不是同一个**，而且分属四族：
 *
 * ```text
 *   thinking.type        DeepSeek / GLM / Kimi / MiniMax / 豆包 / Claude / Z.AI
 *   enable_thinking      阿里百炼 / 硅基流动 / vLLM·SGLang 自部署
 *   reasoning_effort     OpenAI / xAI / 阶跃
 *   think                Ollama 本地
 * ```
 *
 * ★★★ **绝对不要"双写"**（同时发 `thinking` 和 `enable_thinking`）。
 *
 * 真机实测（2026-11-07，DeepSeek 官方 API）：
 *
 * ```text
 *   thinking:{type:'disabled'}   → 思考 0 字     ✅ 真的关掉了
 *   enable_thinking:false        → 思考 52 字    ❌ 被静默忽略
 * ```
 *
 * 服务端遇到不认识的字段**不报错、直接忽略**。所以双写会让界面显示
 * "已关闭"、模型其实还在思考、token 照烧 —— 这比"不支持"更糟，
 * 因为用户失去了发现问题的线索。
 *
 * 结论：**按厂商精确匹配，只发那一族的参数。**
 *
 * ## 为什么做成纯数据
 *
 * 厂商改参数是常态（GLM 就已从 `max/high/low` 扩到
 * `max/xhigh/high/medium/low/minimal/none`）。表是数据，改表不用改代码；
 * 逻辑只认 `family` 和 `on` / `off`。
 */

/** 参数族 —— 决定"关"这个动作要写哪个字段 */
export type ParamFamily =
  | 'thinking.type'
  | 'enable_thinking'
  | 'reasoning_effort'
  | 'think';

/**
 * 用户的思考意图。**三态**，不是布尔。
 *
 * `auto` 的意思是"**不干预**" —— 一个字段都不发，让厂商用它的默认值。
 *
 * 为什么必须保留 `auto`：各家默认值不同（DeepSeek/Kimi/GLM/豆包/硅基默认**开**，
 * Qwen 混合模型默认开但 `qwen3-vl-*` 默认关）。用布尔开关会把
 * "我不想管"强行解释成"关"，那是在替用户做错决定。
 */
export type ThinkingIntent = 'auto' | 'off' | 'on';

/**
 * 「思考长度」的调节方式。
 *
 * 为什么不是所有厂商都有：`thinking_budget` 只有 Qwen / 硅基这一族支持；
 * GLM 是 `reasoning_effort` 枚举；DeepSeek / Kimi 官方接口没有这个旋钮。
 */
export interface BudgetSpec {
  /** 注入到请求体的字段名 */
  readonly key: string;
  /** `number` = 数值上限（thinking_budget）；`enum` = 档位（reasoning_effort） */
  readonly kind: 'number' | 'enum';
  /** `kind === 'number'` 时的取值范围 */
  readonly min?: number;
  readonly max?: number;
  /** `kind === 'enum'` 时的可选档位，从轻到重 */
  readonly options?: readonly string[];
  /**
   * 用户**没动过**这个旋钮时的显示值。
   *
   * 为什么需要它：UI 一进来就要有个值可显示。若拿 `fallback`（最轻档）当默认，
   * 用户会以为"系统建议最轻"，从而把一个本来正常的默认值当成推荐值。
   * `default` 是**厂商的常规默认**（Qwen `thinking_budget` 4096，GLM `max`）。
   */
  readonly default: number | string;
  /**
   * 强制思考模型降级时用的值。
   *
   * 语义是"既然关不掉，那就让它别想太久" —— 所以取**最轻**那一档，
   * 而不是中间值。用户点的是"关"，我们给的是"尽量少"。
   */
  readonly fallback: number | string;
  /** 给 UI 看的一句话（说清这个旋钮影响什么） */
  readonly hint: string;
}

/** 怎么认出"当前是这家" */
export interface ProfileMatch {
  /**
   * 服务地址里的片段（不区分大小写）。
   *
   * 为什么地址优先于模型名：地址是**用户明确填的**，比模型名可靠得多。
   * 中转站的模型名可能带前缀（`[次0.2]claude-opus-4-8`），
   * 而地址至少指向真实厂商。
   */
  readonly baseUrlPatterns?: readonly string[];
  /**
   * 模型名的正则（字符串形式，`new RegExp` 编译）。
   *
   * 用途：用户在自定义源里填了官方地址之外的**中转站**时，
   * 地址匹配不上，只能靠模型名兜底。
   */
  readonly modelPatterns?: readonly string[];
}

/** 一家厂商的思考参数配方 */
export interface ReasoningProfile {
  /** 稳定标识，UI 与日志都用它 */
  readonly id: string;
  /** 给人看的名字 */
  readonly label: string;
  readonly match: ProfileMatch;
  readonly family: ParamFamily;
  /** 开启思考时注入的字段 */
  readonly on: Readonly<Record<string, unknown>>;
  /** 关闭思考时注入的字段 */
  readonly off: Readonly<Record<string, unknown>>;
  /** 思考长度旋钮（这家没有就不写） */
  readonly budget?: BudgetSpec;
  /**
   * **关不掉思考**的模型（正则字符串）。
   *
   * 存在这些模型是因为厂商把思考做成了模型固有行为：
   * `deepseek-reasoner` / `qwen3-*-thinking` / `GLM-5.3` / `kimi-k2.7-code` …
   *
   * 对它们发 `off` 会被拒或被忽略。正确处理是**降级**：
   * 发 `on` + 把 budget 压到最轻，并在 UI 上如实说"关不掉，已限长"。
   * **不许**在界面上写"已关闭" —— 那是撒谎。
   */
  readonly forcedThinking?: readonly string[];
  /** 已核对的日期（YYYY-MM-DD）。过久未核对的项要在 UI 上提示可能过期 */
  readonly verifiedAt: string;
  /** 一句人话说明（UI 直接显示） */
  readonly note?: string;
}

/**
 * P0 只做四家：DeepSeek / Qwen / GLM / Kimi。
 *
 * 顺序有意义：**先地址、后模型名**是按精确度降序排的。
 * `matchProfile` 会先跑完一轮地址匹配，再跑模型名兜底。
 */
export const PROFILES: readonly ReasoningProfile[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    match: {
      baseUrlPatterns: ['api.deepseek.com', 'deepseek.com'],
      modelPatterns: ['^deepseek-'],
    },
    family: 'thinking.type',
    on: { thinking: { type: 'enabled' } },
    off: { thinking: { type: 'disabled' } },
    /*
     * `deepseek-reasoner` 是"纯推理模型"，思考是它的存在方式。
     */
    forcedThinking: ['^deepseek-reasoner$'],
    budget: {
      /*
       * DeepSeek 官方接口没有 `thinking_budget`（那是 Qwen 那一族的），
       * 但它接受 `reasoning_effort`。2026-11-07 实测（同一道狼羊白菜题，
       * max_tokens=8192）：
       *
       * ```text
       *   low      思考  3196 字 | 正文 274 字 | 34s
       *   high     思考  2957 字 | 正文 189 字 | 35s   ← 与 low 无区别
       *   max      思考 18208 字 | 正文 353 字 | 83s   ← 5.7 倍思考量
       *   不传     思考  5155 字 | 正文 176 字 | 49s
       * ```
       *
       * ★★★ 两条重要发现：
       *
       * 1. **`low` 与 `high` 实际没有区别**，只有 `max` 明显加码。
       *    所以只列这三档没意义 —— 但也不该只给 `max`，
       *    因为 `low` 才是 RP 该用的档（34s vs 83s）。
       *    这里保留三档，把 **default 设成 `low`**：
       *    ★ 若照 GLM 那样把 default 设成最高档，用户一进 RP
       *    就是每题等 83 秒、烧 1.8 万字思考 —— 那就是他最初抱怨的
       *    "延迟非常大并且非常消耗 token"。
       *
       * 2. **`medium` / `minimal` / `none` 全都不报错**（实测 5473/2379/4295 字）。
       *    说明 DeepSeek 对不认识的档位**静默忽略**、退回默认 ——
       *    所以绝不能把它们放进 options：用户选了"无"以为关掉了思考，
       *    实际思考量 4295 字（比 low 还多）。这与"双写"是同一类陷阱。
       *
       * ★ 还有一条：思考字数与 effort 不是单调关系（low 3196 > high 2957），
       *   所以**不能用字数判断档位是否生效**，得看耗时（34s vs 83s）。
       *   我第一版探针就用字数下了"effort 不生效"的错误结论。
       */
      key: 'reasoning_effort',
      kind: 'enum',
      options: ['low', 'high', 'max'],
      default: 'low',
      fallback: 'low',
      hint: '思考深度。低档更快更省；最高档很慢、很耗 token。',
    },
    verifiedAt: '2026-11-07',
    note: '官方接口支持开关思考。关掉后 token 约为原来的 1/5。',
  },
  {
    id: 'qwen',
    label: '通义千问 / 阿里百炼',
    match: {
      baseUrlPatterns: ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'],
      modelPatterns: ['^qwen', '^qwq'],
    },
    family: 'enable_thinking',
    on: { enable_thinking: true },
    off: { enable_thinking: false },
    budget: {
      key: 'thinking_budget',
      kind: 'number',
      min: 128,
      max: 32768,
      default: 4096,
      fallback: 128,
      hint: '思考最多用多少 token。到上限会截断思考、立刻开始回复。',
    },
    /*
     * `qwen3-vl-plus/flash` 默认 **false**（不开），带 `-thinking` 后缀的是纯推理模型。
     * 后者关不掉。
     */
    forcedThinking: ['-thinking$'],
    verifiedAt: '2026-11-07',
    note: '百炼的 OpenAI 兼容接口用 enable_thinking 控制思考。',
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    match: {
      baseUrlPatterns: ['open.bigmodel.cn', 'bigmodel.cn'],
      modelPatterns: ['^glm-', '^charge-'],
    },
    family: 'thinking.type',
    on: { thinking: { type: 'enabled' } },
    off: { thinking: { type: 'disabled' } },
    budget: {
      /*
       * GLM 没有 `thinking_budget`，它用 `reasoning_effort` 的档位。
       *
       * ★ 档位因模型而异，这里取**最保守的公共子集**
       *   （GLM-5.3 只认 `max/high/low`，多传一个 `medium` 会 400）。
       *   所以只列这三档。
       */
      key: 'reasoning_effort',
      kind: 'enum',
      options: ['low', 'high', 'max'],
      /*
       * ★ default 故意**不是**厂商默认值（智谱文档说 GLM-5.2+ 默认 `max`）。
       *
       * 理由与本 App 的场景有关：RP 要的是响应速度，`max` 是"深度思考"档，
       * 每题几万字思考、几十秒等待 —— 那正是用户最初抱怨的
       * "延迟非常大并且非常消耗 token"。
       *
       * 所以取中间档 `high`：比 `max` 快，比 `low` 保留一定推理能力。
       * 想更深可以自己上调，但**默认不该把用户拖进最慢的一档**。
       */
      default: 'high',
      /* 强制思考降级时压到最轻 */
      fallback: 'low',
      hint: '思考深度。低档更快更省，高档更慢更贵。',
    },
    /* GLM-5.3 / 5.3-FLASH / 4.7 是强制思考，关不掉 */
    forcedThinking: ['^glm-5\\.3', '^glm-4\\.7'],
    verifiedAt: '2026-11-07',
    note: 'GLM-5.3 / 4.7 强制思考；其余模型可关。',
  },
  {
    id: 'kimi',
    label: 'Kimi / Moonshot',
    match: {
      baseUrlPatterns: ['api.moonshot.cn', 'api.moonshot.ai'],
      modelPatterns: ['^kimi-', '^moonshot-'],
    },
    family: 'thinking.type',
    on: { thinking: { type: 'enabled' } },
    off: { thinking: { type: 'disabled' } },
    /*
     * Kimi 的 `thinking.keep` 是"多轮里保留多少历史 reasoning_content"，
     * **不是**长度上限 —— 语义不同，不能当 budget 用。
     * 所以这家没有 budget。
     */
    forcedThinking: ['^kimi-k2\\.7-code'],
    verifiedAt: '2026-11-07',
    note: 'K2.x 默认开思考；k2.7-code 强制思考。',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    match: {
      baseUrlPatterns: ['generativelanguage.googleapis.com', 'googleapis.com'],
      modelPatterns: ['^gemini-'],
    },
    family: 'reasoning_effort',
    on: { reasoning_effort: 'high' },
    /*
     * ★ `none` 是 Gemini 官方文档写明的"关思考"取值，**但只对 2.5 系有效**。
     *
     * 对 3 / 4 系发 `none` 会被忽略（官方原文：
     * "Reasoning cannot be turned off for Gemini 2.5 Pro or 3 models"）。
     * 那种忽略**不报错**，所以那些型号必须靠 `forcedThinking` 拦住，
     * 走"降级到限长"那条路。
     */
    off: { reasoning_effort: 'none' },
    budget: {
      /*
       * Gemini 的 OpenAI 兼容层把 `reasoning_effort` 映射到
       * `thinking_level` / `thinking_budget`（官方对照表）：
       *
       * ```text
       *   minimal → 1,024       low  → 1,024
       *   medium  → 8,192       high → 24,576
       * ```
       *
       * ★ 官方明确：`reasoning_effort` 与 `thinking_level`/`thinking_budget`
       *   **不能同时用**。这正是本方案"绝不许双写"的又一个例证。
       */
      key: 'reasoning_effort',
      kind: 'enum',
      options: ['minimal', 'low', 'medium', 'high'],
      default: 'low',
      fallback: 'minimal',
      hint: '思考深度。低档更快更省；高档更慢、思考更多。',
    },
    /*
     * 关不掉的两类：
     *
     * ```text
     *   gemini-2.5-pro          官方写明不可关
     *   gemini-3* / gemini-4*   官方写明不可关
     * ```
     *
     * `gemini-2.5-flash` 可以用 `none` 关，所以**不在**这里。
     */
    forcedThinking: ['^gemini-2\\.5-pro', '^gemini-3', '^gemini-4'],
    verifiedAt: '2026-11-07',
    note: 'Gemini 2.5 Pro 与 3/4 系无法关闭思考，只能调深度。',
  },
  {
    id: 'claude',
    label: 'Claude',
    match: {
      /*
       * 这里**只覆盖中转站的 claude**。官方 Anthropic 走 ST 的 `claude` 源
       * （原生通道，由 `include_reasoning` + budget_tokens 控制），
       * 不经过这张表 —— 但地址/模型名匹配上也无害：
       * `NATIVE_REASONING_SOURCES` 会先判源，走原生那条路。
       */
      baseUrlPatterns: ['api.anthropic.com'],
      modelPatterns: ['^claude-'],
    },
    family: 'thinking.type',
    on: { thinking: { type: 'enabled' } },
    off: { thinking: { type: 'disabled' } },
    /*
     * ★ 没有 budget：Anthropic 的思考长度是 `thinking.budget_tokens`
     *   （要与 `max_tokens` 联动、且必须 < max_tokens）。那是**嵌套字段**，
     *   我们的 `BudgetSpec` 只会写顶层 key，塞不进去。
     *
     *   官方源那条路由 ST 自己算（`calculateClaudeBudgetTokens`），
     *   所以这里缺 budget 只影响"中转站 + claude"这一格 —— 可以接受：
     *   开关仍然有效，只是不能调长度。
     */
    forcedThinking: ['-thinking$'],
    verifiedAt: '2026-11-07',
    note: '带 -thinking 后缀的型号关不掉思考。',
  },
];

/** 按 id 取一条（UI 与测试用） */
export function profileById(id: string): ReasoningProfile | null {
  return PROFILES.find((p) => p.id === id) ?? null;
}

/** 编译正则；非法模式返回 null（不抛，配置写错不该让整个生成失败） */
function compile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

/**
 * 模型名的**规范化**：剥掉中转站前缀，只留真实模型名。
 *
 * ## 必须做这一步的三个理由（都是真机抓到的）
 *
 * 中转站/聚合平台给模型名加前缀是**常态**，而且格式五花八门：
 *
 * ```text
 *   组织前缀    Pro/zai-org/GLM-4.7            ← 硅基流动
 *               deepseek-ai/DeepSeek-V3
 *   方括号标签  [反重力次]gemini-4-argon        ← 用户截图里的中转站
 *               [次0.2]claude-opus-4-6-thinking
 *   倍率前缀    0.12[ais]gemini-2.5-pro         ← 数字倍率 + 方括号
 *               0.1[vertex]gemini-3.8-flash
 * ```
 *
 * ★ 这类缺陷的**掩盖性极强**：DeepSeek / Qwen 的模型名本来就以自己的
 *   名字开头（`deepseek-ai/DeepSeek-V3`、`Qwen/Qwen3-…`），恰好能匹配。
 *   只测这两家会得出"识别没问题"的错误结论 —— 只有 GLM / Kimi 会漏。
 *
 * ## 规范化的顺序（顺序有讲究）
 *
 * ```text
 *   ① 取最后一个 `/` 之后        Pro/zai-org/GLM-4.7   → GLM-4.7
 *   ② 剥掉所有 [...] 标签        [反重力次]gemini-4     → gemini-4
 *   ③ 剥掉开头的数字倍率         0.12gemini-2.5-pro     → gemini-2.5-pro
 *   ④ 去掉首尾空白
 * ```
 *
 * ★ **先 `/` 后 `[]`**：`Pro/[标签]GLM-4.7` 这种顺序反过来会先切掉
 *   标签后面的全部内容，把模型名也切没了。
 *
 * ★ **不切 `:` 后缀**：`glm-4.6:free` / `:nitro`（OpenRouter）是修饰词，
 *   切了改变语义，而它们不影响前缀匹配（`glm-4.6:free` 仍匹配 `^glm-`）。
 */
export function normalizeModelName(model: string): string {
  let name = model.trim();
  if (name === '') return '';

  /* ① 组织前缀 */
  const slash = name.lastIndexOf('/');
  if (slash >= 0) name = name.slice(slash + 1);

  /* ② 方括号标签（可能不止一个） */
  name = name.replace(/\[[^\]]*\]/g, '');

  /* ③ 数字倍率（`0.12` / `1.5` / `2`）—— 只在开头时剥 */
  name = name.replace(/^\d+(?:\.\d+)?\s*/, '');

  /* ④ 前面几步可能留下空白（`[标签] 名字` 这种写法） */
  return name.trim();
}

/** 一组正则里有没有命中的 */
function anyMatch(patterns: readonly string[] | undefined, value: string): boolean {
  if (patterns === undefined || value === '') return false;
  for (const p of patterns) {
    const re = compile(p);
    if (re !== null && re.test(value)) return true;
  }
  return false;
}

/** 匹配输入 */
export interface ProfileLookupInput {
  /** 自定义源里用户填的服务地址；官方源可以不传 */
  readonly baseUrl?: string;
  readonly model: string;
}

/**
 * 找出当前配置属于哪一家。
 *
 * ## 两轮匹配，顺序不能反
 *
 * ```text
 *   第 1 轮：只比 baseUrl      ← 地址是用户明确填的，最权威
 *   第 2 轮：只比 model        ← 中转站场景的兜底（地址不认识，但模型名认识）
 * ```
 *
 * 如果反过来（模型名优先），一个在官方地址上跑着"名叫 `deepseek-*`
 * 的别的模型"会被误判 —— 那种情况极少，但误判的代价是整个思考参数
 * 发到了不认它的服务上（静默忽略 → 假关闭）。
 *
 * 两轮都未命中 ⇒ 返回 `null`，上层走"通道③ 兜底"并标记 `unsupported`。
 */
export function matchProfile(input: ProfileLookupInput): ReasoningProfile | null {
  const baseUrl = (input.baseUrl ?? '').trim().toLowerCase();
  /*
   * ★ 用**规范化后**的模型名比对（剥掉 `org/` 前缀）。
   *
   * 见 `normalizeModelName` 的长注释：`Pro/zai-org/GLM-4.7` 这种
   * 硅基流动官方格式原来一个都认不出。
   */
  const model = normalizeModelName(input.model);

  if (baseUrl !== '') {
    for (const p of PROFILES) {
      if (anyMatch(p.match.baseUrlPatterns, baseUrl)) return p;
    }
  }
  if (model !== '') {
    for (const p of PROFILES) {
      if (anyMatch(p.match.modelPatterns, model)) return p;
    }
  }
  return null;
}

/**
 * 这个模型是不是"关不掉思考"的。
 *
 * ★ 同样吃规范化名 —— `Pro/zai-org/GLM-4.7` 必须命中 `^glm-4\.7`，
 *   否则"强制思考"的模型会被当成可关，用户点「关闭」得到静默无效，
 *   而界面还告诉他"已关闭"。
 */
export function isForcedThinking(profile: ReasoningProfile, model: string): boolean {
  return anyMatch(profile.forcedThinking, normalizeModelName(model));
}

/**
 * 一次注入的结果。
 *
 * 三个字段是给**上层和 UI** 用的，不只是日志：
 * - `degraded`：用户要"关"，我们只能给"限长" —— UI 必须如实提示
 * - `unsupported`：这家不认识（或字段对不上），UI 要说明"设置不会生效"
 */
export interface ReasoningInjection {
  /** 要注入到请求体的字段（空对象 = 不干预） */
  readonly body: Record<string, unknown>;
  /** 用户要关，但模型关不掉 ⇒ 已降级为"限长" */
  readonly degraded: boolean;
  /** 说清为什么降级 / 为什么没生效（给 UI 的一句话） */
  readonly reason?: string;
}

/**
 * 把一个原始输入夹成合法值。
 *
 * 导出的原因：UI 要显示"当前有效值"（用户输 1 的时候控件上应该回显 128，
 * 而不是留着一个会被悄悄夹掉的 1 —— 那会让人以为设置没保存）。
 * 与注入用的是**同一个函数**，所以显示值和实际发出去的值必然一致。
 */
export function resolveBudgetValue(
  spec: BudgetSpec,
  raw: number | string | undefined,
): number | string {
  if (spec.kind === 'enum') {
    const options = spec.options ?? [];
    const wanted = typeof raw === 'string' ? raw.trim() : '';
    if (wanted !== '' && options.includes(wanted)) return wanted;
    return raw === undefined ? spec.default : spec.fallback;
  }
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : Number.NaN;
  if (Number.isNaN(n)) return spec.default;
  const min = spec.min ?? 0;
  const max = spec.max ?? Number.MAX_SAFE_INTEGER;
  /* 夹到合法区间：超出范围的值上游会 400，比"用默认"更糟 */
  return Math.min(max, Math.max(min, n));
}

/**
 * 按能力表算出"这次该往请求体里塞什么"。
 *
 * ## 四种输入 → 四种输出
 *
 * ```text
 *   intent = auto                     → {}            不干预，让厂商用默认
 *   intent = off，模型可关            → profile.off
 *   intent = off，模型关不掉          → profile.on + budget 压到最轻   （degraded = true）
 *   intent = on                       → profile.on（+ 用户指定的 budget）
 * ```
 *
 * ★ `auto` 必须是**空对象**，不能用 `profile.off` 代替 —— 那会把
 *   "我不想管" 变成 "我要求关"，而各家默认不同，替用户决定就是错的。
 */
export function buildReasoningInjection(
  profile: ReasoningProfile,
  intent: ThinkingIntent,
  budget?: number | string,
  model = '',
): ReasoningInjection {
  if (intent === 'auto') {
    return { body: {}, degraded: false };
  }

  if (intent === 'on') {
    const body: Record<string, unknown> = { ...profile.on };
    if (profile.budget !== undefined && budget !== undefined) {
      body[profile.budget.key] = resolveBudgetValue(profile.budget, budget);
    }
    return { body, degraded: false };
  }

  /* 以下 intent === 'off' */
  if (!isForcedThinking(profile, model)) {
    return { body: { ...profile.off }, degraded: false };
  }

  /*
   * 关不掉 ⇒ 降级：仍然要"开"，但把长度压到最轻。
   *
   * 为什么不是"什么都不发"：不发 = 用厂商默认 = 通常就是"开"，
   * 而且默认的思考长度可能很长。降级至少能省一部分。
   */
  const body: Record<string, unknown> = { ...profile.on };
  if (profile.budget !== undefined) {
    body[profile.budget.key] = profile.budget.fallback;
    return {
      body,
      degraded: true,
      reason: `${profile.label} 的「${model}」会强制思考、关不掉，已改为限制思考长度。`,
    };
  }
  return {
    body,
    degraded: true,
    reason: `${profile.label} 的「${model}」会强制思考，且这个接口没有"限制思考长度"的选项。`,
  };
}

/** 把注入对象序列化成 ST 要的 `custom_include_body` 字符串 */
export function serializeInjectionBody(body: Readonly<Record<string, unknown>>): string {
  /*
   * 用 JSON 而不是手写 YAML。
   *
   * ST 侧是 `yaml.parse(custom_include_body)`，而 **JSON 是 YAML 的子集** ——
   * `JSON.stringify` 的产出一定能被 `yaml.parse` 正确解析。
   * 自己拼 YAML 反而要处理引号、缩进、中文、冒号转义，出错面大得多。
   */
  return JSON.stringify(body);
}

/**
 * 合并"能力表算出来的"与"用户手写的"。
 *
 * ## 用户手写优先，且只在合法时合并
 *
 * 为什么允许用户覆盖：能力表一定会有过期的一天（厂商改参数）。
 * 当表错的时候，用户至少还能手写救回来 —— 那条路不能堵死。
 *
 * 若用户手写不是合法 JSON，就**不合并**、原样返回他的手写内容
 * （可能是 YAML，交给 ST 自己解析）。这种做法保证了：
 * 手写永远不会被我们的"聪明"弄坏。
 */
export function mergeUserBody(
  injection: Readonly<Record<string, unknown>>,
  userBody: string | undefined,
): string {
  /*
   * ★ 注意 `raw` 与 `trimmed` 是两个变量。
   *
   * 早先的写法只有 `const user = (...).trim()`，最后 `return user` ——
   * 于是"原样透传"的承诺是假的：YAML 的尾部换行、前导空格都被抹掉了。
   * 虽然 trim 过的 YAML 通常仍合法，但用户手写的内容**不该被我们改写**，
   * 尤其是有缩进语义的时候。
   */
  const raw = userBody ?? '';
  const trimmed = raw.trim();
  if (trimmed === '') return serializeInjectionBody(injection);

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return JSON.stringify({ ...injection, ...(parsed as Record<string, unknown>) });
    }
  } catch {
    /* 不是 JSON：当作 YAML 原样交出去 */
  }
  return raw;
}

/* ═══════════════════════════════════════════════════════════
   兜底：用户手动指定参数族（2026-11-07，任务 ④）
   ═══════════════════════════════════════════════════════════ */

/**
 * 某一族的**通用配方**（不针对具体厂商）。
 *
 * ## 为什么需要这个
 *
 * 能力表只覆盖 4 家，而 OpenAI 兼容的服务有几十家
 * （豆包 / MiniMax / 硅基流动 / 阶跃 / 各类中转站…）。
 * 逐家写正则必然腐烂：厂商改名、模型换代、中转站加前缀。
 *
 * 而它们的**参数族只有四族**（这是稳定的结构事实，不会因为
 * 多一家厂商而变化）。所以给用户一个"我手动告诉你是哪一族"的入口，
 * 覆盖面立刻从 4 家变成"任何厂商"，且**不需要我们维护**。
 *
 * ## 与自动识别的优先级
 *
 * ```text
 *   用户手选了   → 用它（用户的判断优先于我们的猜测）
 *   没手选       → 走 matchProfile 自动识别
 *   都没有       → 兜底通道，如实说"不会生效"
 * ```
 *
 * ★ 手选优先是刻意的：能力表会过期，而用户手上可能就有厂商文档。
 *   那条"用户能自救"的路不能堵死（与 `mergeUserBody` 同一条纪律）。
 */
export interface FamilyPreset {
  readonly family: ParamFamily;
  readonly label: string;
  /** 这一族的开启/关闭写法 */
  readonly on: Readonly<Record<string, unknown>>;
  readonly off: Readonly<Record<string, unknown>>;
  /** 给用户看的判断依据（"你的接口文档里写的是哪个字段"） */
  readonly hint: string;
  /**
   * 这一族是否支持"思考长度"。
   *
   * `thinking.type` 族普遍**没有**长度旋钮（DeepSeek 的 effort 是特例，
   * 得按厂商配，不能放进通用配方）。
   */
  readonly budget?: BudgetSpec;
}

/** 四族的通用配方。顺序 = 界面下拉的顺序（按常见程度） */
export const FAMILY_PRESETS: readonly FamilyPreset[] = [
  {
    family: 'thinking.type',
    label: 'thinking（智能体/GLM/Kimi/豆包/MiniMax）',
    on: { thinking: { type: 'enabled' } },
    off: { thinking: { type: 'disabled' } },
    hint: '接口文档里写着 thinking: { type: "enabled" / "disabled" }。智谱、Kimi、豆包方舟、MiniMax 都是这种。',
  },
  {
    family: 'enable_thinking',
    label: 'enable_thinking（百炼/硅基流动/vLLM）',
    on: { enable_thinking: true },
    off: { enable_thinking: false },
    budget: {
      key: 'thinking_budget',
      kind: 'number',
      min: 128,
      max: 32768,
      default: 4096,
      fallback: 128,
      hint: '思考最多用多少 token。到上限会截断思考、立刻开始回复。',
    },
    hint: '接口文档里写着 enable_thinking: true / false。阿里百炼、硅基流动、vLLM/SGLang 自部署都是这种。',
  },
  {
    family: 'reasoning_effort',
    label: 'reasoning_effort（OpenAI/xAI/阶跃）',
    on: { reasoning_effort: 'high' },
    off: { reasoning_effort: 'none' },
    budget: {
      key: 'reasoning_effort',
      kind: 'enum',
      options: ['low', 'medium', 'high'],
      default: 'medium',
      fallback: 'low',
      hint: '思考深度档位。',
    },
    hint: '接口文档里写着 reasoning_effort: low / medium / high。OpenAI o 系列、xAI、阶跃是这种。',
  },
  {
    family: 'think',
    label: 'think（Ollama 本地）',
    on: { think: true },
    off: { think: false },
    hint: '本地 Ollama 用 think: true / false 控制推理模型是否思考。',
  },
];

/** 按族名取通用配方 */
export function familyPresetOf(family: ParamFamily): FamilyPreset | null {
  return FAMILY_PRESETS.find((p) => p.family === family) ?? null;
}

/**
 * 把"用户手选的族"包装成一条 `ReasoningProfile`。
 *
 * ## 为什么要包装而不是写第二套逻辑
 *
 * `buildReasoningInjection` / `isForcedThinking` / UI 的三分支，
 * 全部只依赖 `ReasoningProfile` 的形状。包装一次就能让手选族**复用全部**
 * 现有逻辑 —— 不必在每条路上都加一个 `if (是手选的)` 分支。
 * 那种"第二套逻辑"正是本项目反复出缺陷的地方。
 *
 * `id` 用 `manual:<family>` 前缀，一眼看得出不是自动识别的。
 */
export function manualProfile(family: ParamFamily, label?: string): ReasoningProfile | null {
  const preset = familyPresetOf(family);
  if (preset === null) return null;

  const profile: ReasoningProfile = {
    id: `manual:${family}`,
    label: label ?? `手动指定（${preset.label}）`,
    /* 手选不参与自动匹配 —— 它本身就是"用户已经指定了" */
    match: {},
    family,
    on: preset.on,
    off: preset.off,
    ...(preset.budget === undefined ? {} : { budget: preset.budget }),
    verifiedAt: '2026-11-07',
    note: preset.hint,
  };
  return profile;
}
