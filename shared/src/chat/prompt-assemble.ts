/**
 * 按 ST「提示词管理器」的语义拼装 messages（2026-11-03）。
 *
 * ## 它替代了什么
 *
 * 之前 `st-adapter/context.ts` 的 `buildSystemPrompt` 做的是：
 *
 * ```text
 *   卡.system_prompt + 【角色设定】+【性格】+【场景】+【世界书】+【对话示例】
 *   → 全塞进**一条** system 消息，顺序写死
 * ```
 *
 * 现在改成：按 `prompt_order` 逐条走，每项独立成一条消息，
 * 角色（system/user/assistant）和位置都由配置决定。
 *
 * ## 与 ST 的对应关系（对着 `public/scripts/openai.js` 核过）
 *
 * | 我们的函数 | ST 的对应 |
 * |---|---|
 * | `assembleWithPrompts` | `populateChatCompletion` |
 * | `resolveSlotContent` | `preparePromptsForChatCompletion` 建的系统槽 |
 * | `applyDepthInjections` | `populateChatHistory` 末尾那段 depth 循环 |
 * | `applyBasicMacros` | `substituteParams`（我们只做两个宏，见 `CONTEXT_GAPS`） |
 *
 * ## ★ 零内容硬编码
 *
 * 这里没有任何一句提示词正文。内置槽位的**正文从卡片/世界书/历史来**，
 * 自建项的正文来自用户的配置。唯一"写死"的是 `identifier → 从哪取内容`
 * 这张映射表 —— 那是结构，不是内容。
 */

import type { StCardData, StWorldbookEntry } from '../model/sillytavern.js';
import { activeEntriesInOrder, DEFAULT_SCAN_DEPTH } from '../rules/worldbook-activation.js';
import type { StChatMessage } from '../st-adapter/types.js';
import {
  type ParsedPromptConfig,
  type PromptRole,
  type StPrompt,
  INJECTION_ABSOLUTE,
} from './prompt-config.js';
import { type AuthorNoteConfig, shouldInjectAuthorNote } from './author-note.js';
import type { PersonaPosition } from './persona.js';

/**
 * 作者注释在拼装里的内部标识。
 *
 * `__` 前缀 + 不可能与预设里的 identifier 重名 —— 它不来自用户配置，
 * 是我们运行时合成的一条。用可读名字是为了出错时日志能看懂。
 */
const AUTHOR_NOTE_ID = '__author_note__';

/** 人设描述在深度注入里的内部标识（同上：不来自用户配置，运行时合成） */
const PERSONA_DESCRIPTION_ID = '__user_persona__';

/** 拼装输入 */
export interface PromptAssembleInput {
  card: StCardData;
  /**
   * 世界书条目。
   *
   * 调用方**显式传**（与 `st-adapter/context.ts` 的 `assembleContext` 同一约定）：
   * 这样允许把卡片外的条目（全局世界书）合并进来。
   * 不传的话世界书一条都不会激活，而界面看起来完全正常。
   */
  worldbook?: readonly StWorldbookEntry[];
  history: readonly StChatMessage[];
  /**
   * 当前生效的用户设定。
   *
   * `position` 决定描述插到哪（对齐 ST 的 `persona_description_positions`）：
   * - 不传 / `in_prompt` ⇒ 填 `personaDescription` 槽位（旧行为）
   * - `at_depth` / `top_an` / `bottom_an` ⇒ 走深度注入那条通道
   * - `none` ⇒ 完全不插
   */
  persona?: {
    name?: string;
    description?: string;
    position?: PersonaPosition;
    depth?: number;
    role?: PromptRole;
  };
  userMessage?: string;
  scanDepth?: number;
  random?: () => number;
  /** 从预设解析出来的提示词配置（`null` 时调用方应回退到旧拼装） */
  config: ParsedPromptConfig;
  /**
   * 示例分隔提示（ST 的 `new_example_chat_prompt`）。
   * 从用户配置读，读不到就空串 —— 不内置任何措辞。
   */
  newExampleChatPrompt?: string;
  /** 场景/性格的包装格式（ST 的 `scenario_format` / `personality_format`） */
  scenarioFormat?: string;
  personalityFormat?: string;
  /** 世界书条目的包装格式（ST 的 `wi_format`） */
  wiFormat?: string;
  /**
   * 作者注释（2026-11-03，第二十七批）。
   *
   * 不传 = 不用作者注释（与"填了但为空"等价）。
   * 判定"这一轮要不要插"在 `shared/chat/author-note.ts`，
   * 插入位置复用 `applyDepthInjections` —— 与 ST 的扩展注入同一条路。
   */
  authorNote?: AuthorNoteConfig;
}

/** 拼好的结果 */
export interface PromptAssembleResult {
  messages: Array<{ role: PromptRole; content: string }>;
  /**
   * 每条消息**是否允许被 token 预算裁掉**（与 `messages` 等长）。
   *
   * 只有对话历史是 `true`。提示词槽位与用户自定义项一律 `false` ——
   * 裁掉它们等于把用户调教好的效果扔掉，比少几轮历史严重得多。
   */
  trimmable: boolean[];
  /**
   * 「预算紧张时优先整块丢掉」的标记（与 `messages` 等长）。
   *
   * 目前只有**对话示例**（`mes_example`）为 `true`。理由见
   * `token-budget.ts` 的 `dropFirst` 注释：对齐 ST 的
   * `canAffordAll` 语义 —— 示例放不下就整块不要，历史照留。
   */
  dropFirst: boolean[];
  worldbookUsed: Array<{ index: number; title: string; reason: string }>;
  personaUsed: boolean;
  gaps: readonly string[];
  /** 本次实际用了几条提示词、跳过了几条（界面可显示，排查也有据可查） */
  report: {
    applied: number;
    skippedDisabled: number;
    skippedEmpty: number;
    depthInjected: number;
    orderSource: string;
  };
}

/** 这一版拼装**明确没做**的部分（写出来，别让用户猜） */
export const PROMPT_GAPS = [
  '宏替换只做 {{char}} / {{user}} 两个；不做 {{random}} / {{pick}} / {{time}} 等',
  '世界书递归扫描未实现，只做单轮关键词匹配',
  '向量化召回（extensions.vectorized）未实现',
  /*
   * 作者注释 2026-11-03（第二十七批）已实现，从缺口里移除了 ——
   * 它现在按 ST 的 interval/depth 规则插进历史。
   * 仍然没做的：角色专属注释（`note.chara`）与世界书附加（`wiAddition`）。
   */
  '作者注释只做全局默认（extension_settings.note.default），不做角色专属注释与世界书附加',
  '相邻 system 消息未做 squash 合并（ST 的「压缩系统消息」开关）',
  /*
   * ★ 原来这句写的是「对话示例未按 <START> 拆成多条消息」—— **那是错的**。
   *
   * 查 ST 源码（`openai.js` 的 `setOpenAIMessageExamples` /
   * `parseExampleIntoIndividual`）之后的真相：
   *
   * ```js
   * item.replace(/<START>/i, '{Example Dialogue:}')   // 只替换、不带 g
   * for (let i = 1; i < tmp.length; i += 1) {         // 第 0 行无条件跳过
   *   if (cur_str.startsWith(name1 + ':')) { ... }    // 真正的切分依据
   * }
   * ```
   *
   * `<START>` **从来不参与切分**，它只是被替换掉、然后随第 0 行一起丢弃。
   * 真正的切分是"行首说话人前缀"。把 `<START>` 当成分隔符去写，
   * 改出来的功能会和 ST 对不上 —— 而两边都"有测试"。
   */
  '对话示例未按说话人拆成多条消息（ST 按行首 名字: 切分），而是一条整体送入',
] as const;

/** 内置标记位 → 从哪取内容（**结构映射，不是内容**） */
const MARKER_IDENTIFIERS = new Set([
  'worldInfoBefore',
  'worldInfoAfter',
  'charDescription',
  'charPersonality',
  'scenario',
  'personaDescription',
  'dialogueExamples',
  'chatHistory',
]);

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 只替换两个最基础的宏（与旧拼装保持一致的口径）。
 *
 * 为什么只做两个：`{{char}}` 与 `{{user}}` 出现在几乎每张卡里，
 * 不替换的话模型会把字面量当成名字。其余宏依赖运行时状态，
 * 做半个不如不做（半吊子宏系统比没有更难查）。
 */
export function applyBasicMacros(text: string, charName: string, userName: string): string {
  return text.split('{{char}}').join(charName).split('{{user}}').join(userName);
}

/** 世界书关键词扫描用的文本（最近 N 条 + 本次输入） */
function buildRecentText(input: PromptAssembleInput): string {
  const depth = input.scanDepth ?? DEFAULT_SCAN_DEPTH;
  const tail = input.history.slice(-depth);
  const lines = tail.map((message) => (typeof message.mes === 'string' ? message.mes : ''));
  if (typeof input.userMessage === 'string' && input.userMessage !== '') {
    lines.push(input.userMessage);
  }
  return lines.join('\n');
}

/**
 * 把一段内容套进用户的格式串。
 *
 * ST 的 `stringFormat` 里 `{}` 是占位。我们只支持**单个 `{}`** ——
 * 够覆盖 `scenario_format`（默认 `{{scenario}}` 之类）的实际用法，
 * 复杂的格式化留给后续。格式串为空时原样返回。
 */
function wrapWithFormat(format: string | undefined, content: string): string {
  if (format === undefined) return content;
  const trimmed = format.trim();
  if (trimmed === '') return content;
  if (!trimmed.includes('{}')) return content;
  return trimmed.replace('{}', content);
}

/**
 * 解析"世界书"这条标记位要用的内容。
 *
 * ★ 按 `entry.position` 拆 before / after —— 这是 ST 的真实行为
 * （`world-info.js` 里 `world_info_position.before/after`）。
 * 旧实现把两者合并成一段，会让"放在角色设定之后"的条目失去位置意义。
 */
function resolveWorldInfo(
  input: PromptAssembleInput,
  charName: string,
  userName: string,
  which: 'before' | 'after',
): string {
  const active = activeEntriesInOrder(input.worldbook ?? [], {
    recentText: buildRecentText(input),
    scanDepth: input.scanDepth ?? DEFAULT_SCAN_DEPTH,
    ...(input.random === undefined ? {} : { random: input.random }),
  });

  const blocks: string[] = [];
  for (const { entry } of active) {
    const position = asText(entry.position);
    const isAfter = position === 'after_char';
    if (which === 'after' ? !isAfter : isAfter) continue;
    const text = applyBasicMacros(asText(entry.content).trim(), charName, userName);
    if (text !== '') blocks.push(text);
  }

  if (blocks.length === 0) return '';
  return wrapWithFormat(input.wiFormat, blocks.join('\n'));
}

/**
 * 解析一条提示词最终要发什么内容。
 *
 * 返回 `null` = 这条这次不发（内容为空）。
 *
 * ## 三类分开处理
 *
 * 1. **标记位**（`marker: true`）—— 内容从卡片/世界书/人设/历史来；
 * 2. **内置可编辑槽**（`system_prompt: true` 但非标记位，如 `main` / `nsfw` /
 *    `jailbreak`）—— 用用户配置里的 `content`；
 * 3. **用户自建项** —— 同样用 `content`。
 *
 * 2 与 3 处理方式一样，区别只在语义（前者是 ST 给的默认文本，后者是用户加的）。
 */
function resolveSlotContent(
  prompt: StPrompt,
  input: PromptAssembleInput,
  charName: string,
  userName: string,
): string | null {
  const card = input.card;

  if (prompt.marker !== true && !MARKER_IDENTIFIERS.has(prompt.identifier)) {
    /* 普通正文：套宏后直接用 */
    const text = applyBasicMacros(prompt.content.trim(), charName, userName);
    return text === '' ? null : text;
  }

  switch (prompt.identifier) {
    case 'worldInfoBefore':
      return emptyToNull(resolveWorldInfo(input, charName, userName, 'before'));
    case 'worldInfoAfter':
      return emptyToNull(resolveWorldInfo(input, charName, userName, 'after'));
    case 'charDescription':
      return emptyToNull(applyBasicMacros(asText(card.description).trim(), charName, userName));
    case 'charPersonality':
      return emptyToNull(
        wrapWithFormat(input.personalityFormat, applyBasicMacros(asText(card.personality).trim(), charName, userName)),
      );
    case 'scenario':
      return emptyToNull(
        wrapWithFormat(input.scenarioFormat, applyBasicMacros(asText(card.scenario).trim(), charName, userName)),
      );
    case 'personaDescription': {
      /*
       * ★ 只有 `in_prompt`（或不指定）才走这个槽位（2026-11-04）。
       *
       * 用户选了「按深度插入」「作者注释上方」等位置时，描述要在
       * 深度注入那一步出现，不能在槽位里再来一遍 ——
       * 否则同一段描述在上下文里出现两次，模型会当成两条不同的设定。
       */
      const position = input.persona?.position ?? 'in_prompt';
      if (position !== 'in_prompt') return null;

      const description = input.persona?.description?.trim() ?? '';
      if (description === '') return null;
      return applyBasicMacros(description, charName, userName);
    }
    case 'dialogueExamples': {
      const example = applyBasicMacros(asText(card.mes_example).trim(), charName, userName);
      if (example === '') return null;
      /*
       * 用户没有自定义分隔提示时**不加任何前缀** ——
       * 内置一句中文标语就等于替用户写提示词了（违反零内容硬编码）。
       */
      const separator = asText(input.newExampleChatPrompt).trim();
      return separator === '' ? example : `${separator}\n${example}`;
    }
    default:
      /*
       * 未识别的标记位（将来 ST 新增的槽）：把 content 当正文发。
       * 不静默丢弃 —— 丢掉会让用户的配置"看起来生效了但少了东西"。
       */
      return emptyToNull(applyBasicMacros(prompt.content.trim(), charName, userName));
  }
}

function emptyToNull(text: string): string | null {
  return text === '' ? null : text;
}

/** 把历史展开成消息（跳过系统消息与空正文） */
function historyToMessages(
  input: PromptAssembleInput,
  charName: string,
  userName: string,
): Array<{ role: PromptRole; content: string }> {
  const out: Array<{ role: PromptRole; content: string }> = [];
  for (const message of input.history) {
    if (message.is_system === true) continue;
    const text = typeof message.mes === 'string' ? message.mes.trim() : '';
    if (text === '') continue;
    out.push({
      role: message.is_user === true ? 'user' : 'assistant',
      content: applyBasicMacros(text, charName, userName),
    });
  }
  return out;
}

/**
 * 按配置拼装 messages。
 *
 * ## 主流程
 *
 * ```text
 *   for order 里的每一项（只走 enabled 的）
 *     ├─ 跳过 ABSOLUTE 注入项（它们不走顺序，后面单独插）
 *     ├─ chatHistory → 展开成多条（这是"标记位"里唯一会产生多条消息的）
 *     ├─ 其它 → 解析出内容，作为一条消息
 *     └─ 内容为空 → 跳过（空消息会浪费 token 且可能让上游报错）
 *   ↓
 *   把 ABSOLUTE 项按 injection_depth 插进历史
 *   ↓
 *   末尾追加本次用户输入
 * ```
 */
export function assembleWithPrompts(input: PromptAssembleInput): PromptAssembleResult {
  const charName = asText(input.card.name) !== '' ? input.card.name : 'Assistant';
  const userName =
    input.persona?.name !== undefined && input.persona.name !== '' ? input.persona.name : 'User';

  const messages: PromptAssembleResult['messages'] = [];
  const trimmable: boolean[] = [];
  const dropFirst: boolean[] = [];
  /**
   * 推入一条消息。
   *
   * @param canTrim 能不能被预算裁掉（对话历史 = true）
   * @param asDropFirst 预算紧张时是否**优先整块丢掉**（对话示例 = true）
   */
  const push = (role: PromptRole, content: string, canTrim: boolean, asDropFirst = false): void => {
    messages.push({ role, content });
    trimmable.push(canTrim);
    dropFirst.push(asDropFirst);
  };
  let applied = 0;
  let skippedDisabled = 0;
  let skippedEmpty = 0;
  let depthInjected = 0;

  const order = input.config.order;
  const byId = new Map(input.config.prompts.map((one) => [one.identifier, one]));

  /*
   * 顺序表不存在时用"配置里的顺序"（`prompts` 的数组顺序）。
   *
   * 这比"什么都不发"好：用户导进来的预设，提示词列表本身是有意义的顺序。
   * 而完全不给提示词会让聊天变得比旧实现还差。
   */
  const effectiveOrder =
    order === null
      ? input.config.prompts.map((one) => ({ identifier: one.identifier, enabled: true }))
      : order;

  /** 待做深度注入的（先收集，等历史铺好再插） */
  const depthItems: Array<{ prompt: StPrompt; content: string }> = [];

  for (const entry of effectiveOrder) {
    const prompt = byId.get(entry.identifier);
    if (prompt === undefined) continue;
    if (!entry.enabled) {
      skippedDisabled += 1;
      continue;
    }

    /* ABSOLUTE 项不走顺序 —— 收集起来后面按深度插 */
    if (prompt.injectionPosition === INJECTION_ABSOLUTE) {
      const content = resolveSlotContent(prompt, input, charName, userName);
      if (content === null) {
        skippedEmpty += 1;
      } else {
        depthItems.push({ prompt, content });
      }
      continue;
    }

    /* 历史标记位：展开成多条 */
    if (prompt.identifier === 'chatHistory') {
      const rows = historyToMessages(input, charName, userName);
      if (rows.length === 0) {
        skippedEmpty += 1;
        continue;
      }
      for (const row of rows) push(row.role, row.content, true);
      applied += 1;
      continue;
    }

    const content = resolveSlotContent(prompt, input, charName, userName);
    if (content === null) {
      skippedEmpty += 1;
      continue;
    }
    /*
     * ★ 对话示例是**唯一**"预算紧张时优先丢"的槽位（2026-11-09，对齐 ST）。
     *
     * 理由：示例示范的是"角色怎么说话"，丢了只是语气淡一点；
     * 而对话历史一裁，角色立刻失忆。ST 的选择是保历史、丢示例
     * （`populateDialogueExamples` 的 `canAffordAll` + `break`），
     * 我们之前正好相反 —— 长对话里"记性变差但示例一直在"。
     */
    push(prompt.role, content, false, prompt.identifier === 'dialogueExamples');
    applied += 1;
  }

  /*
   * 作者注释（2026-11-03，第二十七批）。
   *
   * ## 为什么放在"深度注入"之前、复用同一条路
   *
   * ST 里作者注释就是通过 `setExtensionPrompt` + depth 插进历史的，
   * 与 ABSOLUTE 提示词走的是同一套机制。自己再写一遍插入逻辑，
   * 就会出现"两套 depth 语义"—— 同一份配置在两条路上位置不同，
   * 而用户只会觉得"有时候位置不对"。
   *
   * ## 为什么"这一轮插不插"要单独判
   *
   * 作者注释支持"每 N 轮插一次"（ST 的 `defaultInterval`）。
   * 不能每轮都插：那会变成"用户没配间隔却被反复强化"。
   */
  const note = input.authorNote;
  if (note !== undefined && note.text.trim() !== '') {
    const userCount = input.history.filter((one) => one.is_user).length;
    if (shouldInjectAuthorNote(userCount, note.interval)) {
      depthItems.push({
        prompt: {
          identifier: AUTHOR_NOTE_ID,
          name: "Author's Note",
          content: '',
          role: note.role,
          systemPrompt: false,
          marker: false,
          injectionPosition: INJECTION_ABSOLUTE,
          injectionDepth: note.depth,
          injectionOrder: 100,
        },
        /* 与其它提示词一致做宏替换 —— 用户会写 {{char}} / {{user}} */
        content: applyBasicMacros(note.text.trim(), charName, userName),
      });
    }
  }

  /*
   * 人设描述按「非 in_prompt」的位置插入（2026-11-04 第三十批）。
   *
   * ## 为什么复用深度注入
   *
   * ST 里 `AT_DEPTH` 就是"按深度插进历史"，与 ABSOLUTE 提示词同一条路。
   * 再写一套插入逻辑会出现两套 depth 语义 —— 同一份配置在两条路上位置
   * 不同，而用户只会觉得"有时候位置不对"。
   *
   * ## top_an / bottom_an 怎么落到 depth
   *
   * 作者注释本身也是按 depth 插的（默认 4）。"作者注释顶部"就是比它
   * 更靠前一条、"底部"就是更靠后一条。这是**近似**：真正的 ST 是把
   * 两者拼在同一个块里。我们分开插，好处是各自独立可控，
   * 代价是在极短的历史里两者的相对顺序可能反不过来 ——
   * 这种边界不影响理解（两条都是给模型的背景说明）。
   */
  const personaDesc = input.persona?.description?.trim() ?? '';
  const personaPos = input.persona?.position ?? 'in_prompt';
  if (personaDesc !== '' && personaPos !== 'in_prompt' && personaPos !== 'none') {
    const noteDepth = input.authorNote?.depth ?? 4;
    const depth =
      personaPos === 'at_depth'
        ? (input.persona?.depth ?? 4)
        : personaPos === 'top_an'
          ? noteDepth + 1
          : Math.max(0, noteDepth - 1);

    depthItems.push({
      prompt: {
        identifier: PERSONA_DESCRIPTION_ID,
        name: 'User Persona',
        content: '',
        role: input.persona?.role ?? 'system',
        systemPrompt: false,
        marker: false,
        injectionPosition: INJECTION_ABSOLUTE,
        injectionDepth: depth,
        injectionOrder: 100,
      },
      content: applyBasicMacros(personaDesc, charName, userName),
    });
  }

  /* 深度注入：按 depth 从深到浅插，越浅越靠后 */
  if (depthItems.length > 0) {
    depthInjected = applyDepthInjections(messages, trimmable, depthItems);
  }

  /* 本次用户输入永远最后（ST 也是把它接在 history 之后） */
  if (typeof input.userMessage === 'string' && input.userMessage.trim() !== '') {
    push('user', applyBasicMacros(input.userMessage.trim(), charName, userName), false);
  }

  const active = activeEntriesInOrder(input.worldbook ?? [], {
    recentText: buildRecentText(input),
    scanDepth: input.scanDepth ?? DEFAULT_SCAN_DEPTH,
    ...(input.random === undefined ? {} : { random: input.random }),
  });

  return {
    messages,
    trimmable,
    dropFirst,
    worldbookUsed: active.map(({ entry, verdict }) => ({
      index: verdict.index,
      title:
        asText(entry.comment) !== ''
          ? asText(entry.comment)
          : asText(entry.name) !== ''
            ? asText(entry.name)
            : `条目 ${String(verdict.index + 1)}`,
      reason: verdict.reason,
    })),
    personaUsed: (input.persona?.description?.trim() ?? '') !== '',
    gaps: PROMPT_GAPS,
    report: {
      applied,
      skippedDisabled,
      skippedEmpty,
      depthInjected,
      orderSource: input.config.orderSource,
    },
  };
}

/**
 * 把「按深度注入」的提示词插进已有消息里。
 *
 * ## ST 的语义（`populateChatHistory` 末尾）
 *
 * `injection_depth = 0` 表示**最后一条之前**（最靠近当前输入），
 * 数字越大越往前。同一深度内按 `injection_order` **降序**（ST 里是
 * `sort((a,b) => +b - +a)`），同 role 的内容用换行拼成一条。
 *
 * ## 为什么按"从深到浅"的顺序遍历
 *
 * 插入会改变数组长度。先插靠前的（depth 大的），后面的下标才不会被推走。
 */
function applyDepthInjections(
  messages: PromptAssembleResult['messages'],
  trimmable: boolean[],
  items: ReadonlyArray<{ prompt: StPrompt; content: string }>,
): number {
  const maxDepth = items.reduce((acc, one) => Math.max(acc, one.prompt.injectionDepth), 0);

  let inserted = 0;

  /*
   * 从深到浅：depth 大的先插（更靠前），浅的后插（更靠后）。
   * 这样"越浅越靠后"自然成立，且下标不会被前面的插入推乱。
   */
  for (let depth = maxDepth; depth >= 0; depth -= 1) {
    const atDepth = items.filter((one) => one.prompt.injectionDepth === depth);
    if (atDepth.length === 0) continue;

    /*
     * 同一深度里按 injection_order 降序，再按 role 分组拼成一条。
     *
     * 为什么同 role 要拼：ST 就是这么做的（`orderPrompts.filter(role).map(content).join()`）。
     * 分成多条会让模型看到连续的同类消息，反而更容易被打断。
     */
    const sorted = [...atDepth].sort((a, b) => b.prompt.injectionOrder - a.prompt.injectionOrder);

    const byRole: Array<{ role: PromptRole; parts: string[] }> = [];
    for (const role of ['system', 'user', 'assistant'] as PromptRole[]) {
      const parts = sorted.filter((one) => one.prompt.role === role).map((one) => one.content);
      if (parts.length > 0) byRole.push({ role, parts });
    }

    /*
     * 插入点：从末尾往前数 `depth` 条。
     *
     * depth=0 ⇒ 插在最后一条之前（`messages.length` 位置，但用户输入还没加，
     * 所以就是当前末尾）。用 `Math.max(0, ...)` 兜住"历史太短"的情况。
     */
    const index = Math.max(0, messages.length - depth);
    const rows = byRole.map((one) => ({ role: one.role, content: one.parts.join('\n') }));
    messages.splice(index, 0, ...rows);

    /*
     * ★ `trimmable` 必须**同步插入**，否则两个数组从此错位：
     * 后面按 `trimmable[i]` 判"能不能裁"时，会张冠李戴 ——
     * 把用户的提示词当历史裁掉，或把历史当必留项留下来。
     *
     * 深度注入的是**用户的指令**，一律 `false`（不许裁）。
     */
    trimmable.splice(index, 0, ...rows.map(() => false));

    inserted += rows.length;
  }

  return inserted;
}
