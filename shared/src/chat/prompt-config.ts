/**
 * ST「提示词管理器」（Prompt Manager）的**解析层**（2026-11-03）。
 *
 * ## 为什么需要这一层
 *
 * 用户在 ST 网页里能调一整套提示词：12 个内置槽位 + 任意多条自己加的，
 * 每条能选 `system` / `user` / `assistant`、能决定「跟随顺序」还是
 * 「按深度插进聊天历史」、能单独开关。**这套东西决定回复像不像那个角色。**
 *
 * 而我们 App 之前用的是自己写死的一段 system prompt（`st-adapter/context.ts`
 * 的 `buildSystemPrompt`）—— 它压根不读这个配置。
 * 结果就是：同样的卡、同样的模型，在 ST 里更贴，在 App 里差点意思。
 *
 * ## 为什么完全照 ST 的语义，而不是自己发明一套
 *
 * 用户会用 ST 网页调好、导出一份预设（`prompts` + `prompt_order`），
 * 然后指望在 App 里得到同样效果。**任何自创的简化都会让调教成果打折**，
 * 而且用户无从归因（"我明明设了，为什么不生效"）。
 *
 * ## ★★★ 零内容硬编码（用户两次明令）
 *
 * 这里**只做结构映射**：`identifier → 从哪取内容`。
 *
 * 不写死任何提示词正文、不内置任何"推荐提示词"、不给任何项默认开启。
 * 用户的「防角色全知」这类条目全部来自他自己的预设文件。
 *
 * ```text
 *   允许硬编码：'main' 这个 identifier 对应卡片的哪一段   ← 结构
 *   禁止硬编码：'main' 里应该写什么话                     ← 内容
 * ```
 */

/** 一条提示词能扮演的角色（与 ST 的 `prompt.role` 同义） */
export type PromptRole = 'system' | 'user' | 'assistant';

/**
 * 注入位置。
 *
 * `RELATIVE` = 跟着 `prompt_order` 走（ST 里是 0）
 * `ABSOLUTE` = 不参与顺序，按 `injection_depth` 插进聊天历史（ST 里是 1）
 */
export const INJECTION_RELATIVE = 0;
export const INJECTION_ABSOLUTE = 1;

/** ST 预设里的一条提示词（原样保留未知字段，便于将来扩） */
export interface StPrompt {
  identifier: string;
  name: string;
  /** 提示词正文。内置标记位（marker）的正文是空串，内容由卡片/世界书/历史填 */
  content: string;
  role: PromptRole;
  /**
   * `true` = 内置槽位（ST 叫 "Global Prompt"）。
   * 这类项的正文可以被用户改，但"内容从哪来"是固定的。
   */
  systemPrompt: boolean;
  /** `true` = 标记位（占位），运行时才展开 */
  marker: boolean;
  /** 见 `INJECTION_RELATIVE` / `INJECTION_ABSOLUTE`；缺省按跟随顺序 */
  injectionPosition: number;
  /** 仅 `ABSOLUTE` 有意义：插到倒数第几条之前 */
  injectionDepth: number;
  /** 同一深度内的排序（越小越靠前）；缺省 100（与 ST 一致） */
  injectionOrder: number;
}

/** 顺序表里的一项：某个 identifier 是否启用、排第几 */
export interface StPromptOrderEntry {
  identifier: string;
  enabled: boolean;
}

/** 顺序表来源 —— 决定"这条 order 凭什么被选中"，出问题时要能解释 */
export type PromptOrderSource =
  /** 与当前角色卡的 id 精确匹配（ST 的按角色卡策略） */
  | 'character'
  /** 全局默认（ST 的 `dummyId`，100000） */
  | 'global'
  /** 文件里只有一条 order —— 就用它（见下面 ★ 的说明） */
  | 'only-one'
  /** 找不到任何可用的 order */
  | 'none';

/** 解析结果 */
export interface ParsedPromptConfig {
  prompts: readonly StPrompt[];
  /** 选中的顺序表；`null` 表示配置文件里没有可用顺序 */
  order: readonly StPromptOrderEntry[] | null;
  orderSource: PromptOrderSource;
  /**
   * 解析过程中的问题（**给用户看的**，不是给开发看的）。
   * 例如"预设里有 3 条提示词没在顺序表里，已忽略"。
   */
  warnings: readonly string[];
}

/** ST 的全局默认顺序表 id */
const GLOBAL_ORDER_ID = 100000;

/** `injection_order` 缺省值（与 ST 一致） */
const DEFAULT_INJECTION_ORDER = 100;

/**
 * 把任意值读成字符串。缺省空串。
 *
 * 不用 `String(value ?? '')`：`null` 会变成 `"null"`，那会被当成正文发出去。
 */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 把任意值读成有限数字，否则用缺省 */
function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 把一个 role 值收敛到三选一 */
function asRole(value: unknown, fallback: PromptRole): PromptRole {
  return value === 'system' || value === 'user' || value === 'assistant' ? value : fallback;
}

/**
 * 从一份 ST 预设（`oai_settings` 形状的对象）里解析出提示词配置。
 *
 * ## 能吃的形状
 *
 * 预设文件里 `prompts` 是对象数组、`prompt_order` 是
 * `[{ character_id, order: [{ identifier, enabled }] }]`。
 *
 * 但**别人的 ST 可能把 `prompts` 存成 JSON 字符串**（本项目 §87.3 踩过：
 * `openai_settings[i]` 每项是字符串）。所以两种都吃。
 *
 * ## 拿不到时返回什么
 *
 * 返回 `order: null` + `orderSource: 'none'`，**不抛异常**。
 * 调用方据此回退到旧的固定拼装 —— 没有提示词配置时聊天必须照常能用。
 */
export function parsePromptConfig(
  raw: unknown,
  options?: { characterId?: number | string },
): ParsedPromptConfig {
  const warnings: string[] = [];
  const root = coerceObject(raw);
  if (root === null) {
    return { prompts: [], order: null, orderSource: 'none', warnings };
  }

  const prompts = coercePromptList(root['prompts']);
  if (prompts.length === 0) {
    /*
     * 没有 prompts 数组 —— 可能这个预设只存了采样参数。
     * 这不是错误，只是"没有提示词配置可用"，回退即可。
     */
    return { prompts: [], order: null, orderSource: 'none', warnings };
  }

  const picked = pickOrder(root['prompt_order'], options?.characterId);
  if (picked.order === null) {
    warnings.push('这份配置里没有可用的提示词顺序，将继续使用内置顺序。');
  }

  /*
   * 顺序表里引用了不存在的 identifier：跳过并**告诉用户**。
   *
   * 静默跳过是这份代码里最不该有的行为之一 —— 用户看到"顺序里有 30 项"
   * 而实际只发出去 25 项，会以为是模型不听话。
   */
  if (picked.order !== null) {
    const known = new Set(prompts.map((one) => one.identifier));
    const missing = picked.order.filter((one) => !known.has(one.identifier));
    if (missing.length > 0) {
      warnings.push(
        `顺序表里有 ${String(missing.length)} 项在提示词列表里找不到，已忽略。`,
      );
    }
  }

  return { prompts, order: picked.order, orderSource: picked.source, warnings };
}

/**
 * 选一条顺序表。
 *
 * ## ★★★ 为什么需要 `only-one` 这条兜底
 *
 * ST 的全局策略用 `character_id === 100000` 那条。但用户从**别人的环境**
 * 导出的预设，`character_id` 往往是对方环境的 id（实测样本是 **100001**）。
 * 严格按 100000 找的话，整份配置会被判成"没有顺序"⇒
 * **用户的 27 条自己调的提示词一条都不会生效**，而界面上看起来一切正常。
 *
 * 所以规则是"逐级退让"：
 *
 * | 顺序 | 条件 | 说明 |
 * |---|---|---|
 * | 1 | 与当前角色卡 id 匹配 | 最精确 |
 * | 2 | `100000` | ST 的全局默认 |
 * | 3 | **只有一条** | 就是它了 —— 没有歧义，不用白不用 |
 * | 4 | 都没有 | `null`，调用方回退 |
 *
 * 第 3 条只在"没有歧义"时生效；多于一条又没有 100000 时不猜
 * （猜错比不猜更糟：用户的提示词会以错误的顺序发出去）。
 */
function pickOrder(
  raw: unknown,
  characterId: number | string | undefined,
): { order: readonly StPromptOrderEntry[] | null; source: PromptOrderSource } {
  const list = coerceOrderList(raw);
  if (list.length === 0) return { order: null, source: 'none' };

  const byId = (id: number | string): readonly StPromptOrderEntry[] | null => {
    const hit = list.find((one) => String(one.characterId) === String(id));
    return hit === undefined ? null : hit.order;
  };

  if (characterId !== undefined) {
    const matched = byId(characterId);
    if (matched !== null && matched.length > 0) return { order: matched, source: 'character' };
  }

  const global = byId(GLOBAL_ORDER_ID);
  if (global !== null && global.length > 0) return { order: global, source: 'global' };

  if (list.length === 1) {
    const only = list[0];
    if (only !== undefined && only.order.length > 0) return { order: only.order, source: 'only-one' };
  }

  return { order: null, source: 'none' };
}

interface RawOrderList {
  characterId: unknown;
  order: readonly StPromptOrderEntry[];
}

function coerceOrderList(raw: unknown): RawOrderList[] {
  const value = coerceJson(raw);
  if (!Array.isArray(value)) return [];

  const out: RawOrderList[] = [];
  for (const item of value) {
    const entry = coerceObject(item);
    if (entry === null) continue;
    const orderRaw = entry['order'];
    if (!Array.isArray(orderRaw)) continue;

    const order: StPromptOrderEntry[] = [];
    for (const one of orderRaw) {
      const row = coerceObject(one);
      if (row === null) continue;
      const identifier = asText(row['identifier']);
      if (identifier === '') continue;
      order.push({ identifier, enabled: row['enabled'] !== false });
    }
    if (order.length > 0) out.push({ characterId: entry['character_id'], order });
  }
  return out;
}

function coercePromptList(raw: unknown): StPrompt[] {
  const value = coerceJson(raw);
  if (!Array.isArray(value)) return [];

  const out: StPrompt[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    const entry = coerceObject(item);
    if (entry === null) continue;

    let identifier = asText(entry['identifier']);
    const name = asText(entry['name']);
    const marker = entry['marker'] === true;

    /*
     * 没有 identifier 的项：ST 会给它补一个 uuid。我们没有 uuid 生成器，
     * 也不能用 `name` 兜底（重名会互相覆盖）。
     * 用下标造一个稳定 id —— 它只在本份配置内有效，够用。
     */
    if (identifier === '') {
      identifier = `prompt-${String(out.length)}`;
    }
    if (seen.has(identifier)) {
      /* 重复 identifier：后一条覆盖前一条（与 ST 的 Map 语义一致） */
      out.splice(
        out.findIndex((one) => one.identifier === identifier),
        1,
      );
    }
    seen.add(identifier);

    const systemPrompt = entry['system_prompt'] === true;

    out.push({
      identifier,
      name,
      content: asText(entry['content']),
      /*
       * role 缺省是 `system`。
       *
       * ST 里标记位（marker）项的 role 是 `null`（运行时才定），
       * 而用户自建项默认 `system`。这里统一收敛成 `system`，
       * 真正决定消息 role 的是 `resolveMarker` / `prompt.role` ——
       * 见 `prompt-assemble.ts`。
       */
      role: asRole(entry['role'], 'system'),
      systemPrompt,
      marker,
      injectionPosition: asNumber(entry['injection_position'], INJECTION_RELATIVE),
      injectionDepth: asNumber(entry['injection_depth'], 0),
      injectionOrder: asNumber(entry['injection_order'], DEFAULT_INJECTION_ORDER),
    });
  }

  return out;
}

/** 把一个值当 JSON 看待：是字符串就尝试解析，否则原样返回 */
function coerceJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function coerceObject(raw: unknown): Record<string, unknown> | null {
  const value = coerceJson(raw);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * 判断一条提示词是不是「内置槽位」。
 *
 * 内置槽位的**正文从卡片/世界书/历史来**，用户改的那份 content 只是备用。
 * 自建项的正文就是 `content` 本身。
 *
 * 用 `marker` 而不是 `identifier` 白名单来判定，是因为：
 *   · `main` / `nsfw` / `jailbreak` 这三条是"内容可由用户编辑"的内置槽，
 *     它们的 `marker` 是 false，内容就是 `content`；
 *   · 真正需要"运行时填充"的（世界书/描述/历史…）`marker` 一定是 true。
 *
 * 两类的处理方式完全不同，所以这个区分必须精确。
 */
export function isSlotPrompt(prompt: StPrompt): boolean {
  return prompt.marker === true;
}
