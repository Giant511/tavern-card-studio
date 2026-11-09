/**
 * ST 内部 API 的类型（v0.1.7 / T15.4）。
 *
 * 全项目的 ST 调用都收在这一层，渲染层只认这里的类型，不认识 HTTP。
 *
 * ## 行号引用纪律
 *
 * 本文件里每个端点都标了「源码文件:行号」，行号取自 ST **1.19.0** 源码树。
 * 行号会随版本漂移，所以：
 *   · 注释里的行号是**给人查证用的线索**，不是断言；
 *   · 真正的守卫是 `test/st-contract-v1.19.test.mjs` —— 它按**形状**断言，
 *     并把版本号写成常量，ST 升版时它先红。
 * 这条分工来自契约文档 §0 的原话：「按形状断言，不按行号断言」。
 */

/** 契约钉死的 ST 版本。测试里比对这个值，不匹配就红。 */
export const ST_CONTRACT_VERSION = '1.19.0';

/**
 * v1 支持的六个后端（决策 #269）。
 *
 * 为什么只有六个：前五个是 OpenAI 兼容或近似，流式解析共用一条路径；
 * `claude` 形状不同，单独一条解包分支。其余 19 个源用逃生门覆盖 ——
 * 每多一个就多一条解包分支和一份真机验证成本，而 v1 的目标是闭环不是全覆盖。
 */
export const SUPPORTED_CHAT_SOURCES = [
  'openai',
  'custom',
  'deepseek',
  'openrouter',
  'groq',
  'claude',
] as const;

export type StChatSource = (typeof SUPPORTED_CHAT_SOURCES)[number];

/**
 * 这个后端 v1 支不支持。
 *
 * ## 为什么必须显式判、不许静默回退
 *
 * 用户手里可能有多个厂商的 key。收到 `makersuite` 却当成 `openai` 发出去，
 * 就是**拿着 A 厂商的 key 去打 B 厂商的域名** —— 轻则 401 让人以为 key 填错，
 * 重则把 key 泄露给第三方。所以这里返回 false 时调用方必须
 * **明确报「该后端暂未支持，请在高级功能里用原生界面」**（契约 §3.3.1 实现纪律）。
 */
export function isSupportedChatSource(value: unknown): value is StChatSource {
  return typeof value === 'string' && (SUPPORTED_CHAT_SOURCES as readonly string[]).includes(value);
}

/** 角色（`POST /api/characters/all` 的元素；`src/endpoints/characters.js:1466`） */
export interface StCharacter {
  name: string;
  /**
   * 头像文件名，**含 `.png`**。
   *
   * 它同时是**聊天目录名**（契约陷阱 #2）。所以拼路径永远用它，绝不用 `name` ——
   * 角色改名后 `name` 变了而 `avatar` 不变，用 `name` 拼会找不到旧聊天。
   */
  avatar: string;
  /** 上次打开的聊天名（**无扩展名**） */
  chat?: string;
  /**
   * 原始卡 JSON 字符串（仅 full 模式有）。
   *
   * `performance.lazyLoadCharacters` 为真时列表项是 shallow 对象，**没有这个字段**。
   * 所以取卡详情必须走 `/api/characters/get`，不能拿列表项当详情用。
   */
  json_data?: string;
  [key: string]: unknown;
}

/**
 * 聊天列表项（`src/endpoints/chats.js:413-422`）。
 *
 * ⚠ `file_name` 带 `.jsonl`、`file_id` 不带 —— 双轨是契约陷阱 #3。
 * 用错的结果是 400 或建出怪文件。
 */
export interface StChatInfo {
  /** 聊天名（**无扩展名**）—— 给 `get` / `save` 用 */
  file_id: string;
  /** 聊天名（**带 `.jsonl`**）—— 给 `rename` / `delete` 用 */
  file_name: string;
  /** 给人看的字符串，如 `"12.3 kB"`。**不是字节数**，别拿它排序（陷阱 #9） */
  file_size: string;
  chat_items: number;
  /** 最后一条消息的截断预览 */
  mes: string;
  last_mes: number;
  match?: string;
  chat_metadata?: Record<string, unknown>;
}

/**
 * 聊天消息（JSONL 里 `[0]` 之后的对象，契约 §5.3）。
 *
 * ## 为什么要保留全部字段
 *
 * 只留 `role`/`content` 会把 `swipes` / `swipe_info` / `extra` 抹掉。
 * 用户在手机上聊几句再回桌面，会发现「重新生成的候选全没了」——
 * 而那不是他能理解的现象。所以适配器读进来再写回去，
 * **除自己改动的字段外必须逐字段不变**，这条写进了契约测试。
 */
export interface StChatMessage {
  name: string;
  is_user: boolean;
  is_system?: boolean;
  send_date?: string;
  /** 消息正文 */
  mes: string;
  extra?: Record<string, unknown>;
  /** 重新生成的候选文本 */
  swipes?: string[];
  /** 当前显示第几个候选 */
  swipe_id?: number;
  swipe_info?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** 聊天文件第 0 条 header（前端构造，`public/script.js:7428-7445`） */
export interface StChatHeader {
  user_name: string;
  character_name: string;
  chat_metadata: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * header 的两个字段字面量就是 `"unused"`（契约 §3.2）。
 *
 * 真正的用户名由服务端从 session 取（`chats.js:547`）。
 * 这里写成常量而不是让调用方传：传了也不会被 ST 采用，
 * 反而会让人以为"填了就有用"。
 */
export const ST_HEADER_PLACEHOLDER = 'unused';

/** 生成请求（只列 v1 需要的；完整清单 `public/scripts/openai.js:2803-2828`） */
export interface StGenerateRequest {
  chat_completion_source: StChatSource;
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /**
   * 是否流式。
   *
   * **这是判断"是不是流式"的唯一依据** —— 不能用响应头判断，因为
   * ST 的 `forwardFetchResponse` 不设置 `Content-Type`（契约 §4.1）。
   */
  stream: boolean;
  temperature?: number;
  top_p?: number;
  /** 部分后端支持（Anthropic / Google 系）。v1 拼装时按需带 */
  top_k?: number;
  max_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  /**
   * 重复惩罚（2026-10-31 第四批加）。
   *
   * ST 侧确实支持：`chat-completions.js:1554` 透传、`:2328`/`:2497` 按后端
   * 塞进 bodyParams。但我们的类型此前没有它 —— 于是「AI 响应配置」页里
   * 那个「重复惩罚」字段**改了也发不出去**（`buildGenerateRequest` 里
   * 没有对应分支，静默丢弃）。
   *
   * 这正是本批要钉死的那类缺陷："字段有了、UI 有了、就是不通"。
   */
  repetition_penalty?: number;
  /**
   * Top A —— 按概率动态裁剪候选（2026-11-03 补）。
   *
   * ST 侧：`chat-completions.js` 里有 4 处 `request.body.top_a`。
   */
  top_a?: number;
  /**
   * Min P —— 概率下限裁剪（2026-11-03 补）。
   *
   * ST 侧：`chat-completions.js` 里有 5 处 `request.body.min_p`。
   */
  min_p?: number;
  /**
   * 随机种子（2026-11-03 补）。
   *
   * ★ `-1` **不允许**出现在这里：ST 语义里 -1 是"随机"，
   * 而把它当值发出去，部分上游会判参数非法。拼装层已统一解释为"不带"。
   */
  seed?: number;
  /**
   * 推理强度（2026-11-03 补）：`min` / `low` / `medium` / `high` / `max`。
   *
   * ★ `auto` 不允许出现 —— 同上，它是"不指定"的意思，不是合法取值。
   */
  reasoning_effort?: string;
  /** 啰嗦程度（2026-11-03 补）：`low` / `medium` / `high`。`auto` 同上不带 */
  verbosity?: string;
  /** 停止串。ST 侧字段名是 `stop`（数组），不是单值 */
  stop?: string[];
  /**
   * 「继续」用的 prefill。
   *
   * 语义是"接着这段往下写"，**不是**"再问一遍"。所以历史里必须去掉那条
   * assistant（否则模型看到重复开头会立刻复读）—— 见 `buildContinueInput`。
   */
  prefill?: string;
  /** 多密钥时指定用哪一条 */
  secret_id?: string;
  /** 仅 `chat_completion_source === 'custom'` */
  custom_url?: string;
  reverse_proxy?: string;
  /** 供 ST 侧统计/缓存用 */
  chat_id?: string;

  /**
   * 是否把思考过程"算作要返回/开启思考"（2026-11-07，P0 思考适配层）。
   *
   * ★ 这个字段在 ST 里的实际语义**因源而异**，而且差异很大：
   *
   * ```text
   *   deepseek     → thinking: { type: include_reasoning ? 'enabled' : 'disabled' }
   *                  ★ 恒发！不传 = disabled = 思考被强制关闭
   *                  且 `reasoning_effort` 的转发条件也是 `include_reasoning && effort`
   *   claude       → 决定是否计算 thinking.budget_tokens
   *   openrouter   → reasoning.exclude = !include_reasoning（不返回思考内容）
   *   custom/openai → **完全不读**（要走 custom_include_body 注入）
   * ```
   *
   * 所以只有"通道① 原生"才设它，注入通道设了也没用。
   */
  include_reasoning?: boolean;

  /**
   * 注入到请求体的任意字段（**只对 `custom` 源生效**）。
   *
   * ## 为什么这是"最大兼容"的唯一口子
   *
   * ST 的 custom 分支里：
   *
   * ```js
   *   bodyParams = { logprobs: ... };
   *   mergeObjectWithYaml(bodyParams, request.body.custom_include_body);  // 浅合并
   *   const requestBody = { messages, model, ..., ...bodyParams };        // 最后展开
   *   if (source === CUSTOM) excludeKeysByYaml(requestBody, request.body.custom_exclude_body);
   * ```
   *
   * `...bodyParams` 在**最后**展开 ⇒ 注入的字段覆盖一切同名键，
   * 而且**不经过任何白名单**（ST 对 `reasoning_effort` 有硬编码模型白名单，
   * 第三方模型全被丢弃 —— 只有这条路能绕过）。
   *
   * ## 格式
   *
   * ST 用 `yaml.parse()` 解析它。**JSON 是 YAML 的子集**，所以直接传
   * `JSON.stringify(obj)` 的产出是安全的，不必手拼 YAML。
   */
  custom_include_body?: string;

  /**
   * 从请求体里**剔除**字段（只对 `custom` 源生效）。
   *
   * 反向用途：某些模型不接受 `temperature` / `presence_penalty`，
   * 发过去会 400。P0 没用到，留给后续。
   */
  custom_exclude_body?: string;
}

/**
 * 归一化后的流式事件。
 *
 * 四种后端的形状差异全部关在适配器里，UI 只认这四种。
 * 少一种就会逼 UI 去分辨厂商 —— 那是把耦合往上推，下一版加后端又要改 UI。
 */
export type StStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'done'; finishReason?: string }
  | { type: 'error'; message: string };

/**
 * 设置。
 *
 * `/api/settings/get` 回来的 `settings` 字段是**字符串**（陷阱 #5），
 * 适配器负责 parse，对外只暴露对象。
 */
export type StSettings = Record<string, unknown>;

/** ST 的密钥槽位名（`/api/secrets/*`） */
export type StSecretKey = string;

/** CSRF 关闭时 `/csrf-token` 返回的哨兵值（`src/server-main.js:203-209`） */
export const ST_CSRF_DISABLED = 'disabled';
