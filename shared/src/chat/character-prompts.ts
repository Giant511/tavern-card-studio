/**
 * 角色级提示词覆盖（2026-11-15，v0.2.0 主功能）。
 *
 * ## 这一层解决什么
 *
 * 用户诉求原话：
 *
 * > 我偏向于做成跟随角色，不同的角色应该有不同的提示词方便用户微调角色的回复。
 *
 * ST 自己的机制是**全局**的：提示词内容、顺序、开关都跟着 Chat Completion
 * 预设走，一份预设一套；只有 `main` / `jailbreak` 两个槽能被卡片覆盖
 * （见 `prompt-assemble.ts` 的 `cardOverrideFor`）。
 *
 * 这一层在**不改 ST 预设**的前提下，把"某个角色的差异"叠加上去。
 *
 * ## 为什么是 overlay 而不是"每角色存一份完整副本"
 *
 * ```text
 *   副本方案：38 条 × N 个角色，且全局改了之后各副本还是旧文本
 *            —— 界面看不出差别，用户会以为"我改了但没生效"
 *   overlay：只存与全局不同的项。8 个角色都不动 ⇒ 行为与今天完全一致
 * ```
 *
 * 三层优先级（与 ST 的 `prompts.override()` 同语义）：
 *
 * ```text
 *   角色覆盖内容  >  全局预设内容     → 最终文本
 *   角色覆盖开关  >  全局 order 开关  → 是否发送
 *   （顺序不动：手机上拖拽本就容易误触，顺序在 ST 页面上调）
 * ```
 *
 * ## 存哪里
 *
 * `data.extensions.tcs.prompts`。依据（三份，力度不同）：
 *
 * - **V2 规范 MUST**：`extensions` 可含任意键，且"Character editors MUST NOT
 *   destroy unknown key-value pairs"；
 * - **V3 规范禁止自造顶层字段**，应用私有数据**只能**放 `extensions`；
 * - **ST 自己就这么干**：`data.extensions.depth_prompt.{prompt,depth,role}`
 *   就是"角色专属提示词"，只是它只给了**一条**、且只能按深度注入。
 *
 * 命名空间沿用已有的 `tcs`（`data.extensions.tcs.cardId` 已在用这个位置，
 * 见 `client/src/session/card-id.ts`）。
 *
 * ## 纯函数
 *
 * 整个文件不碰 DOM、不碰网络、不读 localStorage —— 判据可以直接跑。
 */

import type { ParsedPromptConfig, PromptRole, StPrompt } from './prompt-config.js';
import { INJECTION_ABSOLUTE, INJECTION_RELATIVE } from './prompt-config.js';

/* ═══════════════════════════════════════════════════════════
   数据结构
   ═══════════════════════════════════════════════════════════ */

/** 当前结构版本。将来改形状时用它做迁移 */
export const CHARACTER_PROMPTS_VERSION = 1;

/**
 * 对**全局某一条**的覆盖。
 *
 * 只存与全局不同的部分：开关不同存 `enabled`，正文不同存 `content`。
 * 两个都没变就不该有这一项（省体积，也让"本角色已改"的标记准确）。
 */
export interface PromptOverride {
  /** 与全局不同的启用状态。缺省 = 沿用全局 */
  enabled?: boolean;
  /**
   * 与全局不同的正文。
   *
   * **只对非标记位有效**（`main` / `nsfw` / `jailbreak` / 用户自建项）。
   * 标记位（`charDescription` / `chatHistory` / `worldInfo*` 等 8 个）的
   * 内容来自卡片与时序，覆盖它们语义不清 —— 写入时被拒绝。
   */
  content?: string;
  /** 长注释。ST 忽略它（按 V2 的 unknown key 规则保留），只有 App 显示 */
  comment?: string;
}

/**
 * 角色**特有**的提示词（全局里没有这一条）。
 *
 * `id` 由 App 生成（`tcs-1` / `tcs-2`…），用作 `identifier`。
 */
export interface OwnPrompt {
  id: string;
  /** 简短标题。ST 里也能看到（官文档：`name` 不发给模型，仅供管理页识别） */
  name: string;
  content: string;
  role: PromptRole;
  /** 是否启用。卡作者在这里表达"导入后默认开/关" */
  enabled: boolean;
  /** 长注释，只有 App 显示 */
  comment?: string;
  /**
   * 注入位置。缺省 = 跟随顺序（`RELATIVE`）。
   *
   * `position: 1`（`ABSOLUTE`）时按 `depth` 插进聊天历史 ——
   * 这是 ST 里"角色注释"那类用法，用户可能需要。
   */
  injection?: {
    position: number;
    depth: number;
    order: number;
  };
}

/** 一份角色级的提示词配置（就是 `data.extensions.tcs.prompts` 的值） */
export interface CharacterPromptConfig {
  version: number;
  /** 键是全局那条的 `identifier` */
  overrideOrder: Record<string, PromptOverride>;
  own: OwnPrompt[];
}

/** 空配置 —— 判据与「恢复默认」都用它 */
export function emptyCharacterPrompts(): CharacterPromptConfig {
  return { version: CHARACTER_PROMPTS_VERSION, overrideOrder: {}, own: [] };
}

/** 是否等于空（用来判"这个角色没做过任何改动"） */
export function isCharacterPromptsEmpty(config: CharacterPromptConfig | null): boolean {
  if (config === null) return true;
  return Object.keys(config.overrideOrder).length === 0 && config.own.length === 0;
}

/* ═══════════════════════════════════════════════════════════
   上限（PLAN §5.6）
   ═══════════════════════════════════════════════════════════ */

/**
 * 上限数值。
 *
 * 依据：卡片藏在 PNG 的 tEXt chunk 里、base64 后 ×1.33；而 ST 的预设本身
 * 38 条能正常跑，说明单条正文的实用上限在 2~4 KB 量级。
 *
 * **超限不截断**：截断的 JSON 之后会在更莫名的地方炸。要明确报错并拒绝保存。
 */
export const PROMPT_LIMITS = {
  /** 每条 content 的字符上限 */
  contentPerPrompt: 4000,
  /** 每条 name 的字符上限 */
  nameLength: 40,
  /** 每条 comment 的字符上限 */
  commentLength: 500,
  /** 角色特有提示词的条数上限 */
  ownCount: 20,
  /** 全部正文总量（own 的 content 之和） */
  totalContent: 24000,
} as const;

export interface LimitViolation {
  /** 给人看的一句话（带具体数字，用户能据此删） */
  message: string;
  /** 哪一项超了，便于判据定位 */
  kind: 'ownCount' | 'contentPerPrompt' | 'nameLength' | 'commentLength' | 'totalContent';
}

/**
 * 校验一份配置是否在上限内。
 *
 * 返回空数组 = 全部合格。**不修改入参**（校验与修正是两件事）。
 *
 * 错误信息必须带具体数字：用户看到「第 3 条正文 5,240 字符，超过 4,000」
 * 才知道该删哪里；只说「超出限制」等于让他自己找。
 */
export function validateCharacterPrompts(config: CharacterPromptConfig): LimitViolation[] {
  const out: LimitViolation[] = [];

  if (config.own.length > PROMPT_LIMITS.ownCount) {
    out.push({
      kind: 'ownCount',
      message:
        `本角色特有提示词有 ${String(config.own.length)} 条，` +
        `超过上限 ${String(PROMPT_LIMITS.ownCount)} 条。删掉一些再保存。`,
    });
  }

  let total = 0;
  config.own.forEach((prompt, index) => {
    const label = prompt.name.trim() === '' ? `第 ${String(index + 1)} 条` : `「${prompt.name.trim()}」`;
    total += prompt.content.length;

    if (prompt.content.length > PROMPT_LIMITS.contentPerPrompt) {
      out.push({
        kind: 'contentPerPrompt',
        message:
          `${label} 正文 ${String(prompt.content.length)} 字符，` +
          `超过每条上限 ${String(PROMPT_LIMITS.contentPerPrompt)}。`,
      });
    }
    if (prompt.name.length > PROMPT_LIMITS.nameLength) {
      out.push({
        kind: 'nameLength',
        message:
          `${label} 的标题 ${String(prompt.name.length)} 字符，` +
          `超过上限 ${String(PROMPT_LIMITS.nameLength)}。`,
      });
    }
    if ((prompt.comment ?? '').length > PROMPT_LIMITS.commentLength) {
      out.push({
        kind: 'commentLength',
        message:
          `${label} 的注释 ${String((prompt.comment ?? '').length)} 字符，` +
          `超过上限 ${String(PROMPT_LIMITS.commentLength)}。`,
      });
    }
  });

  /* 覆盖项的正文也占总量与单条额度 —— 否则可以通过"覆盖"绕过上限 */
  for (const [identifier, override] of Object.entries(config.overrideOrder)) {
    const content = override.content;
    if (content === undefined) continue;
    total += content.length;
    if (content.length > PROMPT_LIMITS.contentPerPrompt) {
      out.push({
        kind: 'contentPerPrompt',
        message:
          `覆盖「${identifier}」的正文 ${String(content.length)} 字符，` +
          `超过每条上限 ${String(PROMPT_LIMITS.contentPerPrompt)}。`,
      });
    }
    if ((override.comment ?? '').length > PROMPT_LIMITS.commentLength) {
      out.push({
        kind: 'commentLength',
        message:
          `覆盖「${identifier}」的注释 ${String((override.comment ?? '').length)} 字符，` +
          `超过上限 ${String(PROMPT_LIMITS.commentLength)}。`,
      });
    }
  }

  if (total > PROMPT_LIMITS.totalContent) {
    out.push({
      kind: 'totalContent',
      message:
        `全部提示词正文合计 ${String(total)} 字符，` +
        `超过总量上限 ${String(PROMPT_LIMITS.totalContent)}。`,
    });
  }

  return out;
}

/* ═══════════════════════════════════════════════════════════
   解析（从卡片 extensions 读）
   ═══════════════════════════════════════════════════════════ */

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asRole(value: unknown): PromptRole {
  return value === 'user' || value === 'assistant' ? value : 'system';
}

/**
 * 从卡片的 `data.extensions` 里解析出角色级提示词配置。
 *
 * 入参是**整个 extensions 对象**（不是 `.tcs.prompts`）—— 这样调用方
 * 不用知道命名空间细节，也便于将来加别的 `tcs.*` 键。
 *
 * ## 容错到"什么都不信"的程度
 *
 * 卡片来自别人，`extensions` 里什么都可能有：字符串、数组、`null`、
 * 数字。任何一层形状不对就**当成没有**（返回 `null`），而不是抛异常或
 * 猜一个形状 —— 猜错的后果是"用户的提示词发到模型里去了"，那比不生效更糟。
 */
export function parseCharacterPrompts(extensions: unknown): CharacterPromptConfig | null {
  if (extensions === null || typeof extensions !== 'object' || Array.isArray(extensions)) return null;
  const tcs = (extensions as Record<string, unknown>)['tcs'];
  if (tcs === null || typeof tcs !== 'object' || Array.isArray(tcs)) return null;
  const raw = (tcs as Record<string, unknown>)['prompts'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const root = raw as Record<string, unknown>;

  /* overrideOrder */
  const overrideOrder: Record<string, PromptOverride> = {};
  const rawOrder = root['overrideOrder'];
  if (rawOrder !== null && typeof rawOrder === 'object' && !Array.isArray(rawOrder)) {
    for (const [identifier, value] of Object.entries(rawOrder as Record<string, unknown>)) {
      if (identifier === '') continue;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      const one: PromptOverride = {};
      if (typeof item['enabled'] === 'boolean') one.enabled = item['enabled'];
      if (typeof item['content'] === 'string' && item['content'] !== '') one.content = item['content'];
      const comment = asText(item['comment']);
      if (comment !== '') one.comment = comment;
      /* 三个都空 = 这条覆盖没有意义，不占位 */
      if (one.enabled === undefined && one.content === undefined && one.comment === undefined) continue;
      overrideOrder[identifier] = one;
    }
  }

  /* own */
  const own: OwnPrompt[] = [];
  const rawOwn = root['own'];
  if (Array.isArray(rawOwn)) {
    for (const value of rawOwn) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      const id = asText(item['id']).trim();
      const content = asText(item['content']);
      /* 没有 id 或没有正文的条目没有意义 —— 静默跳过（它是垃圾数据，不是用户的配置） */
      if (id === '' || content.trim() === '') continue;

      const injectionRaw = item['injection'];
      let injection: OwnPrompt['injection'];
      if (injectionRaw !== null && typeof injectionRaw === 'object' && !Array.isArray(injectionRaw)) {
        const inj = injectionRaw as Record<string, unknown>;
        const num = (key: string, fallback: number): number =>
          typeof inj[key] === 'number' && Number.isFinite(inj[key] as number)
            ? (inj[key] as number)
            : fallback;
        injection = {
          position: num('position', INJECTION_RELATIVE),
          depth: num('depth', 4),
          order: num('order', 100),
        };
      }

      const one: OwnPrompt = {
        id,
        name: asText(item['name']).trim(),
        content,
        role: asRole(item['role']),
        /* 缺省**启用**：卡作者写了这条，意思就是要它生效 */
        enabled: item['enabled'] !== false,
      };
      const comment = asText(item['comment']);
      if (comment !== '') one.comment = comment;
      if (injection !== undefined) one.injection = injection;
      own.push(one);
    }
  }

  if (Object.keys(overrideOrder).length === 0 && own.length === 0) return null;

  return { version: CHARACTER_PROMPTS_VERSION, overrideOrder, own };
}

/* ═══════════════════════════════════════════════════════════
   应用（overlay 到全局配置）
   ═══════════════════════════════════════════════════════════ */

/**
 * 覆盖项里 `content` 只允许出现在这些标识符上。
 *
 * 它们是"内容由用户自己写"的槽（ST 里 `system_prompt: true` 且非标记位）。
 * 标记位（`charDescription` / `chatHistory` / `worldInfo*`…）的内容来自
 * 卡片与时序 —— 覆盖它们会让"角色描述"和"卡片描述"两个真相打架。
 */
const CONTENT_OVERRIDABLE = new Set(['main', 'nsfw', 'jailbreak']);

/**
 * 把角色覆盖叠到全局配置上。
 *
 * ## 空覆盖必须**原样返回**
 *
 * 这是"零迁移成本"的技术保证：用户没给任何角色配过提示词时，
 * 输出必须与输入**逐字段相同**。判据直接断言这一点（`deepEqual` 或引用相等）。
 *
 * ## 为什么先处理 override 再追加 own
 *
 * `own` 的 `identifier` 用 `tcs-*` 前缀，正常不会与全局撞名；但
 * `overrideOrder` 的键是全局 identifier，必须在追加 own **之前**应用，
 * 否则自己新加的条目可能被一份脏数据"覆盖"掉。
 *
 * @returns 新的配置对象（不改入参）
 */
export function applyCharacterPrompts(
  config: ParsedPromptConfig,
  overlay: CharacterPromptConfig | null,
): ParsedPromptConfig {
  if (overlay === null || isCharacterPromptsEmpty(overlay)) return config;

  const overrideKeys = Object.keys(overlay.overrideOrder);
  if (overrideKeys.length === 0 && overlay.own.length === 0) return config;

  /* ① 应用 override：改 prompts 里的 content / order 里的 enabled */
  const prompts: StPrompt[] = config.prompts.map((prompt) => {
    const override = overlay.overrideOrder[prompt.identifier];
    if (override === undefined) return prompt;

    let next = prompt;
    /*
     * 正文覆盖：只对"可覆盖正文"的槽生效。
     *
     * 其余槽（含标记位与用户自建项）**静默忽略 content** —— 但这不是
     * "悄悄吞掉用户的改动"：写入侧（`setPromptContent`）会直接拒绝，
     * 所以能读到这里的 content 只可能来自别的工具写的脏数据。
     * 那种情况按 ST 的语义"不认识就忽略"处理，不破坏现有渲染。
     */
    if (override.content !== undefined && CONTENT_OVERRIDABLE.has(prompt.identifier)) {
      next = { ...next, content: override.content };
    }
    return next;
  });

  const order = config.order === null ? null : config.order.map((entry) => {
    const override = overlay.overrideOrder[entry.identifier];
    if (override === undefined || override.enabled === undefined) return entry;
    return { ...entry, enabled: override.enabled };
  });

  /* ② 追加 own */
  if (overlay.own.length === 0) {
    return { ...config, prompts, order };
  }

  const existing = new Set(prompts.map((one) => one.identifier));
  const addedPrompts: StPrompt[] = [];
  const addedOrder: Array<{ identifier: string; enabled: boolean }> = [];

  for (const own of overlay.own) {
    const identifier = ownIdentifierOf(own);
    /*
     * 撞名就跳过。`tcs-*` 正常撞不上；撞上说明卡片里有两段同 id 的脏数据
     * （或有人手工改过）。跳过比覆盖好 —— 覆盖会静默丢一条。
     */
    if (existing.has(identifier)) continue;
    existing.add(identifier);

    const injection = own.injection ?? { position: INJECTION_RELATIVE, depth: 4, order: 100 };
    addedPrompts.push({
      identifier,
      name: own.name.trim() === '' ? identifier : own.name.trim(),
      content: own.content,
      role: own.role,
      /* 用户自建项：`systemPrompt` / `marker` 都是 false（与 ST 的 `Prompt` 构造器一致） */
      systemPrompt: false,
      marker: false,
      injectionPosition: injection.position,
      injectionDepth: injection.depth,
      injectionOrder: injection.order,
    });
    addedOrder.push({ identifier, enabled: own.enabled });
  }

  if (addedPrompts.length === 0) {
    return { ...config, prompts, order };
  }

  /*
   * 顺序表为 null 时**只加 prompts、不加 order**。
   *
   * 因为 `order === null` 的语义是"这个预设没有顺序表"，而
   * `assembleWithPrompts` 会退回"用 prompts 的数组顺序"。此时追加到
   * prompts 末尾就已经生效；凭空造一份 order 反而会改变其余条目的顺序。
   */
  return {
    ...config,
    prompts: [...prompts, ...addedPrompts],
    order: order === null ? null : [...order, ...addedOrder],
  };
}

/** own 项在全局配置里的 `identifier`（`tcs-` 前缀避免与预设撞名） */
export function ownIdentifierOf(own: OwnPrompt): string {
  return own.id.startsWith('tcs-') ? own.id : `tcs-${own.id}`;
}

/**
 * 把「全局预设」与「角色覆盖」合成面板真正要用的那一份配置。
 *
 * ## 全局为 `null` 时角色配置**整体不生效**（这条必须钉住）
 *
 * `promptConfig === null` 的语义是"用户没导入预设"，此时面板回退到
 * `assembleContext` 的**固定拼装**（角色描述 / 人设 / 世界书 / 历史，
 * 都是硬编码顺序）。
 *
 * 如果这时把 overlay 接上，`prompts.length > 0` 会让面板切到提示词管理器
 * 模式 —— 而那套拼装依赖预设里的 `charDescription` / `chatHistory` /
 * `worldInfoBefore` 等槽位。没有预设就没有这些槽，**整段角色描述和
 * 聊天历史会一起消失**，只剩下卡片自带的那一两条 own 提示词。
 *
 * 那比"角色配置不生效"严重得多：模型直接不知道在扮演谁。
 *
 * 所以：
 *
 * ```text
 *   全局 null  + 角色有配置  ⇒  null（回退固定拼装，角色配置等用户导预设后再生效）
 *   全局有值    + 角色空      ⇒  全局原样返回（引用相等，零成本）
 *   全局有值    + 角色有配置  ⇒  叠加后的新对象
 * ```
 *
 * @returns 面板要用的配置；`null` 表示走固定拼装
 */
export function combineGlobalAndCharacter(
  global: ParsedPromptConfig | null,
  overlay: CharacterPromptConfig | null,
): ParsedPromptConfig | null {
  if (global === null || global.prompts.length === 0) return null;
  if (overlay === null || isCharacterPromptsEmpty(overlay)) return global;
  return applyCharacterPrompts(global, overlay);
}

/* ═══════════════════════════════════════════════════════════
   序列化（写回卡片）
   ═══════════════════════════════════════════════════════════ */

/**
 * 把配置写回 `extensions` 对象（**返回新对象，不修改入参**）。
 *
 * ## 必须深合并而不是整块替换
 *
 * `extensions` 里可能还有别的工具的键（`depth_prompt` / `world` / `fav` /
 * `tcs.cardId`…）。整块替换会**把它们全删掉** —— 而 V2 规范对编辑器的
 * 要求是 MUST NOT destroy unknown key-value pairs。
 *
 * 本项目已有同源教训：`client/src/session/card-id.ts` 写 `tcs.cardId` 时
 * 踩过同一个坑，那里 `withCardId()` 的浅合并用的是同一手法。
 *
 * ## 空配置 ⇒ 删掉自己那个键，不写空壳
 *
 * 用户点了「恢复默认」之后，卡里不该留一个 `{version:1, overrideOrder:{}, own:[]}`
 * —— 那会让人以为这个角色有配置。删干净，其余 `tcs.*` 键保留。
 */
export function writeCharacterPrompts(
  extensions: Record<string, unknown> | null,
  config: CharacterPromptConfig,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    extensions !== null && typeof extensions === 'object' && !Array.isArray(extensions)
      ? { ...extensions }
      : {};

  const tcsRaw = base['tcs'];
  const tcs: Record<string, unknown> =
    tcsRaw !== null && typeof tcsRaw === 'object' && !Array.isArray(tcsRaw)
      ? { ...(tcsRaw as Record<string, unknown>) }
      : {};

  if (isCharacterPromptsEmpty(config)) {
    delete tcs['prompts'];
  } else {
    tcs['prompts'] = {
      version: config.version,
      overrideOrder: config.overrideOrder,
      own: config.own,
    };
  }

  if (Object.keys(tcs).length === 0) {
    delete base['tcs'];
  } else {
    base['tcs'] = tcs;
  }
  return base;
}

/* ═══════════════════════════════════════════════════════════
   编辑操作（UI 用，也都是纯函数）
   ═══════════════════════════════════════════════════════════ */

/**
 * 设置某个全局槽的启用状态（角色级）。
 *
 * **与全局相同就删掉这一项** —— 否则 `overrideOrder` 里会攒一堆
 * "enabled 恰好等于全局值"的条目，"本角色已改"的标记会全线误报。
 */
export function setCharacterPromptEnabled(
  config: CharacterPromptConfig,
  identifier: string,
  enabled: boolean,
  globalEnabled: boolean,
): CharacterPromptConfig {
  const next: CharacterPromptConfig = {
    ...config,
    overrideOrder: { ...config.overrideOrder },
  };

  if (enabled === globalEnabled) {
    const existing = next.overrideOrder[identifier];
    if (existing === undefined) return next;
    const { enabled: _drop, ...rest } = existing;
    if (rest.content === undefined && rest.comment === undefined) {
      delete next.overrideOrder[identifier];
    } else {
      next.overrideOrder[identifier] = rest;
    }
    return next;
  }

  next.overrideOrder[identifier] = { ...(next.overrideOrder[identifier] ?? {}), enabled };
  return next;
}

/**
 * 设置某个全局槽的正文覆盖（角色级）。
 *
 * @returns `{ ok: false, reason }` 当这条不允许改正文（标记位等）。
 *   **必须拒绝而不是静默忽略** —— 静默忽略的表现是"我改了、保存了、
 *   但发出去的还是原来那段"，用户会认为整个功能是坏的。
 */
export function setCharacterPromptContent(
  config: CharacterPromptConfig,
  identifier: string,
  content: string,
  globalContent: string,
  isMarker: boolean,
): { ok: true; config: CharacterPromptConfig } | { ok: false; reason: string } {
  if (isMarker) {
    return {
      ok: false,
      reason:
        `「${identifier}」的内容来自角色卡与聊天时序，不能在这里改。` +
        '只能开关它。',
    };
  }

  const next: CharacterPromptConfig = {
    ...config,
    overrideOrder: { ...config.overrideOrder },
  };
  const existing = next.overrideOrder[identifier] ?? {};

  if (content === globalContent) {
    const { content: _drop, ...rest } = existing;
    if (rest.enabled === undefined && rest.comment === undefined) {
      delete next.overrideOrder[identifier];
    } else {
      next.overrideOrder[identifier] = rest;
    }
    return { ok: true, config: next };
  }

  next.overrideOrder[identifier] = { ...existing, content };
  return { ok: true, config: next };
}

/** 删掉某一条覆盖（"恢复全局"） */
export function clearOverride(
  config: CharacterPromptConfig,
  identifier: string,
): CharacterPromptConfig {
  if (config.overrideOrder[identifier] === undefined) return config;
  const next = { ...config.overrideOrder };
  delete next[identifier];
  return { ...config, overrideOrder: next };
}

/** 增删改 own 项（UI 用） */
export function upsertOwnPrompt(config: CharacterPromptConfig, prompt: OwnPrompt): CharacterPromptConfig {
  const index = config.own.findIndex((one) => one.id === prompt.id);
  if (index < 0) {
    return { ...config, own: [...config.own, prompt] };
  }
  const own = [...config.own];
  own[index] = prompt;
  return { ...config, own };
}

/** 删掉一条 own */
export function removeOwnPrompt(config: CharacterPromptConfig, id: string): CharacterPromptConfig {
  const own = config.own.filter((one) => one.id !== id);
  return own.length === config.own.length ? config : { ...config, own };
}

/**
 * 造一个新 own 项的 id（`tcs-N`，N 取当前未占用的最小正整数）。
 *
 * 不用时间戳：`tcs-1752...` 又长又难读，而 UI 上要显示"第几条"。
 */
export function nextOwnPromptId(config: CharacterPromptConfig): string {
  const used = new Set(config.own.map((one) => one.id.replace(/^tcs-/, '')));
  for (let i = 1; ; i += 1) {
    if (!used.has(String(i))) return `tcs-${String(i)}`;
  }
}

/**
 * 某个全局槽在当前角色下**最终**是否启用。
 *
 * UI 要显示"这一条现在到底发不发"，而这个答案在全局值 + 覆盖里 ——
 * 让 UI 自己拼条件必然分叉（本项目已有四次同源教训）。
 */
export function effectiveEnabled(
  globalEnabled: boolean,
  config: CharacterPromptConfig | null,
  identifier: string,
): boolean {
  const override = config?.overrideOrder[identifier];
  if (override === undefined || override.enabled === undefined) return globalEnabled;
  return override.enabled;
}

/** 某个全局槽在当前角色下**最终**的正文（没有覆盖就是全局那段） */
export function effectiveContent(
  globalContent: string,
  config: CharacterPromptConfig | null,
  identifier: string,
): string {
  const override = config?.overrideOrder[identifier];
  if (override === undefined || override.content === undefined) return globalContent;
  return override.content;
}

/** 这一条在本角色下是否有差异（UI 打「本角色已改」标记用） */
export function hasOverride(config: CharacterPromptConfig | null, identifier: string): boolean {
  const override = config?.overrideOrder[identifier];
  if (override === undefined) return false;
  return override.enabled !== undefined || override.content !== undefined;
}
