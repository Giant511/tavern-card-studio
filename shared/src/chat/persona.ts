/**
 * 用户设定（persona）—— 多套人设，存在 App 里（2026-11-04，第三十批）。
 *
 * ## 用户的两个问题，以及这里的答案
 *
 * > 先把用户设定管理做了，你看下这个是只能存到 ST 还是说也可以放到 APP 里面。
 *
 * **可以放 App 里，而且应该放 App 里。** 依据：
 *
 * ST 的 persona 在拼装时只需要名字与描述：
 *
 * ```ts
 * // shared/chat/prompt-assemble.ts
 * persona?: { name?: string; description?: string };
 * ```
 *
 * - `name` 用于 `{{user}}` 宏替换（"你"叫什么）
 * - `description` 填进 `personaDescription` 槽位（"你"是谁）
 *
 * 这两样都是**纯文本**。而 ST 的 `power_user.personas` 那套结构，是给
 * **它自己的前端**组装 prompt 时用的 —— 我们的请求是自己拼 messages
 * 发过去的，根本不走那条路（服务端不读 settings.json，见 §99 取证）。
 *
 * 所以写进 ST 而 App 不读 = "改了不生效"；两边都写 = 三处各存一份、
 * 迟早不一致。**存在 App 里、由 App 自己读，是唯一不会分叉的做法。**
 *
 * ## 第二版（同日）：对齐 ST 原生面板
 *
 * 用户补充要求实现 ST 网页里的那几项：
 *
 * > 包括修改人设名字、为所有消息设置为该用户、人设世界书、
 * > 以及当前聊天角色可切换用户人数
 *
 * 对应到 ST 的 `power_user.persona_descriptions[avatarId]`：
 *
 * ```js
 * { description, position, depth, role, lorebook, title, connections }
 * ```
 *
 * 所以这里补齐了 `position` / `depth` / `role` / `lorebook` / 角色绑定，
 * 以及三个全局开关（切换提示 / 允许一角色多设定 / 自动绑定到聊天）。
 *
 * ## 刻意不出现"引擎 / ST / SillyTavern"字样
 *
 * 用户原话：
 *
 * > 用户不需要知道 ST 是什么，只需要知道 APP 有完整聊天功能就行，
 * > 即 ST 和 APP 在用户看来是一个整体而不是割裂的
 *
 * 客户装的是一个安装包，不该看见内部有几个部件。
 */

import type { PromptRole } from './prompt-config.js';

/**
 * 人设描述插到哪里（对齐 ST 的 `persona_description_positions`）。
 *
 * | ST 常量 | 值 | 含义 |
 * |---|---|---|
 * | `IN_PROMPT` | 0 | 在故事字符串 / 提示词管理器中（默认） |
 * | `TOP_AN` | 2 | 作者注释顶部 |
 * | `BOTTOM_AN` | 3 | 作者注释底部 |
 * | `AT_DEPTH` | 4 | 按深度插进历史 |
 * | `NONE` | 9 | 不插入 |
 *
 * ★ ST 的 `AFTER_CHAR = 1` 已废弃，不实现（照抄它会让"从 ST 导过来的
 * 配置"落到一个我们根本不处理的值上）。
 */
export type PersonaPosition = 'in_prompt' | 'top_an' | 'bottom_an' | 'at_depth' | 'none';

/** 一套用户设定 */
export interface Persona {
  /** 稳定标识（重命名不变，删除/选中都靠它） */
  id: string;
  /** 显示名，同时用于 `{{user}}` 替换 */
  name: string;
  /** 人设描述，插进上下文的那段文本 */
  description: string;
  /** 插到哪 */
  position: PersonaPosition;
  /** `at_depth` 时的深度：从末尾往前数第几条 */
  depth: number;
  /** 以什么身份插入 */
  role: PromptRole;
  /**
   * 关联的世界书名（空串 = 不关联）。
   *
   * ST 里这是一个下拉，选一个已有的世界书。我们不复制世界书内容，
   * 只记名字 —— 内容仍然由世界书本身提供。
   */
  lorebook: string;
  /**
   * 绑定到哪些角色（空数组 = 默认人设，所有角色都能用）。
   *
   * 对应 ST 的 `connections`。用户要的「当前聊天角色可切换用户人数」
   * 就是这个：一个角色可以绑多套设定，聊天时能切换。
   */
  boundCharacters: string[];
  /**
   * 头像（缩略图 data URL；空串 = 没设，界面画名字首字占位）。
   *
   * ## 为什么存 data URL 而不是文件路径
   *
   * 这套设定存在 **App 自己的 localStorage** 里（不进引擎），
   * 而 localStorage 只能放字符串。缩略图上传时已经缩到 96×96 的 JPEG
   * （几 KB），整份状态几十 KB —— 远低于 localStorage 的 5 MB 配额。
   *
   * 存路径的话要额外管"文件在哪、删人设时删文件"，且换设备就失效。
   */
  avatar: string;
}

/** 整套用户设定状态（落盘用） */
export interface PersonaState {
  personas: Persona[];
  /** 当前选中哪一套。`null` = 没选（此时用默认名） */
  selectedId: string | null;
  /* ── 三组全局开关（对齐 ST 的「全局设置」）── */
  /** 切换用户设定时显示提示 */
  notifyOnSwitch: boolean;
  /** 允许每个角色与多个用户设定绑定 */
  allowMultiBinding: boolean;
  /** 自动把选择的人设绑定到当前聊天 */
  autoBindToChat: boolean;
}

/** 没有用户设定时的名字（与旧行为一致，不凭空改名） */
export const DEFAULT_PERSONA_NAME = '旅人';

/** 名字长度上限。太长会在顶栏与气泡里挤压排版 */
const MAX_NAME_LEN = 24;
/** 描述长度上限。留足空间，但不至于让人写一整本设定集 */
const MAX_DESC_LEN = 4000;
/** 深度上限（与深度注入那边一致） */
const MAX_DEPTH = 100;

/** ST 的值 → 我们的值（含已废弃的 1，映射到默认行为） */
const POSITION_BY_ST_VALUE: Record<number, PersonaPosition> = {
  0: 'in_prompt',
  1: 'in_prompt', // AFTER_CHAR，已废弃
  2: 'top_an',
  3: 'bottom_an',
  4: 'at_depth',
  9: 'none',
};

/** 我们的值 → ST 的值（导入导出/对齐时用） */
export const ST_VALUE_BY_POSITION: Record<PersonaPosition, number> = {
  in_prompt: 0,
  top_an: 2,
  bottom_an: 3,
  at_depth: 4,
  none: 9,
};

/** 空状态 */
export function emptyPersonaState(): PersonaState {
  return {
    personas: [],
    selectedId: null,
    notifyOnSwitch: true,
    allowMultiBinding: true,
    autoBindToChat: true,
  };
}

/** 截断到上限（静默裁掉多余部分，不报错） */
function clampText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asRole(value: unknown): PromptRole {
  if (value === 'user') return 'user';
  if (value === 'assistant') return 'assistant';
  return 'system';
}

function asPosition(value: unknown): PersonaPosition {
  if (typeof value === 'string' && value in ST_VALUE_BY_POSITION) {
    return value as PersonaPosition;
  }
  if (typeof value === 'number') return POSITION_BY_ST_VALUE[value] ?? 'in_prompt';
  return 'in_prompt';
}

/**
 * 从磁盘读回来的东西里恢复状态。
 *
 * ## 为什么要这么小心
 *
 * localStorage 里的东西可能是**上一版**写的、被手改过的、或者是 `null`。
 * 直接 `JSON.parse` 之后当它可信，会在后面到处崩
 * （"读回数组但不是数组"这类错误在真机上表现为列表空白，最难查）。
 *
 * ## 校验规则
 *
 * - `personas` 必须是数组，**逐项**校验；坏项丢掉，不整批作废
 *   （用户写坏了一条，不该让他全部设定消失）
 * - `id` / `name` 为空或类型不对 ⇒ 丢掉该项
 * - `selectedId` 指向不存在的 id ⇒ 归 null（而不是留着悬空引用）
 * - 老版本只有 `{id,name,description}` ⇒ 缺的字段用默认值补齐，
 *   **不因为缺 position 就把这条丢掉**
 */
export function parsePersonaState(raw: unknown): PersonaState {
  const base = emptyPersonaState();
  if (raw === null || typeof raw !== 'object') return base;
  const obj = raw as Record<string, unknown>;

  const list = Array.isArray(obj['personas']) ? obj['personas'] : [];
  const personas: Persona[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const one = item as Record<string, unknown>;

    const id = typeof one['id'] === 'string' ? one['id'].trim() : '';
    const name = typeof one['name'] === 'string' ? one['name'].trim() : '';
    if (id === '' || name === '') continue;
    /* 重复 id 只留第一个 —— 两个同 id 会让"选中/删除"都作用到错的那个 */
    if (seen.has(id)) continue;
    seen.add(id);

    const bound = Array.isArray(one['boundCharacters'])
      ? one['boundCharacters'].filter((x): x is string => typeof x === 'string' && x !== '')
      : [];

    const depthRaw = typeof one['depth'] === 'number' ? Math.round(one['depth']) : 4;

    personas.push({
      id,
      name: clampText(name, MAX_NAME_LEN),
      description: typeof one['description'] === 'string' ? clampText(one['description'], MAX_DESC_LEN) : '',
      position: asPosition(one['position']),
      depth: Math.min(Math.max(depthRaw, 0), MAX_DEPTH),
      role: asRole(one['role']),
      lorebook: typeof one['lorebook'] === 'string' ? one['lorebook'] : '',
      boundCharacters: bound,
    avatar: typeof one['avatar'] === 'string' ? one['avatar'] : '',
    });
  }

  const rawSelected = typeof obj['selectedId'] === 'string' ? obj['selectedId'] : null;
  const selectedId =
    rawSelected !== null && personas.some((one) => one.id === rawSelected) ? rawSelected : null;

  return {
    personas,
    selectedId,
    notifyOnSwitch: asBool(obj['notifyOnSwitch'], base.notifyOnSwitch),
    allowMultiBinding: asBool(obj['allowMultiBinding'], base.allowMultiBinding),
    autoBindToChat: asBool(obj['autoBindToChat'], base.autoBindToChat),
  };
}

/**
 * 当前生效的那一套。
 *
 * 没选中 / 选中项已被删 ⇒ 返回 null，调用方用默认值。
 * **不返回一个"空 persona"对象** —— 那会让 `personaUsed` 判成 true，
 * 于是在上下文里凭空多一段空的描述包装。
 */
export function activePersona(state: PersonaState): Persona | null {
  if (state.selectedId === null) return null;
  return state.personas.find((one) => one.id === state.selectedId) ?? null;
}

/** 当前生效的名字（没选就用默认名） */
export function activeUserName(state: PersonaState): string {
  return activePersona(state)?.name ?? DEFAULT_PERSONA_NAME;
}

/**
 * 某个角色能用的设定有哪些。
 *
 * 规则（对齐 ST）：
 * - 绑定了这个角色的人设 ⇒ 可用
 * - 没绑定任何角色的人设（= 默认人设）⇒ 所有角色都可用
 * - 开了「允许一角色多设定」才会有多套；关掉时只看选中的那套
 *
 * ★ 关掉多绑定时**不是**"只显示第一套"，而是"只显示当前选中的" ——
 * 用户关这个开关的意思是"别让我每次挑"，不是"帮我挑一个"。
 */
export function personasForCharacter(state: PersonaState, avatar: string): Persona[] {
  if (!state.allowMultiBinding) {
    const current = activePersona(state);
    if (current === null) return [];
    /* 当前这套如果明确绑了别的角色，就不该出现在这个角色下 */
    if (current.boundCharacters.length > 0 && !current.boundCharacters.includes(avatar)) {
      return [];
    }
    return [current];
  }

  return state.personas.filter(
    (one) => one.boundCharacters.length === 0 || one.boundCharacters.includes(avatar),
  );
}

/** 新增一套。名字重复时自动加序号，不报错打断用户 */
export function addPersona(state: PersonaState, name: string, id: string): PersonaState {
  const trimmed = name.trim();
  const finalName = trimmed === '' ? '未命名' : clampText(trimmed, MAX_NAME_LEN);

  /*
   * 重名不阻止，只加序号。
   *
   * 理由：重名本身不造成功能问题（用 id 区分），但用户看到两个一模一样的
   * 名字会分不清自己在改哪套 —— 所以给他一个可辨认的默认名。
   */
  let candidate = finalName;
  let index = 2;
  while (state.personas.some((one) => one.name === candidate)) {
    candidate = `${finalName} ${String(index)}`;
    index += 1;
  }

  const next: Persona = {
    id,
    name: candidate,
    description: '',
    position: 'in_prompt',
    depth: 4,
    role: 'system',
    lorebook: '',
    boundCharacters: [],
    avatar: '',
  };

  return {
    personas: [...state.personas, next],
    /* 新建后**自动选中** —— 用户刚建完就是要用它 */
    selectedId: id,
    notifyOnSwitch: state.notifyOnSwitch,
    allowMultiBinding: state.allowMultiBinding,
    autoBindToChat: state.autoBindToChat,
  };
}

/** 改一套。空名字忽略（不留一个改不掉名字的项） */
export function updatePersona(
  state: PersonaState,
  id: string,
  patch: {
    name?: string;
    description?: string;
    position?: PersonaPosition;
    depth?: number;
    role?: PromptRole;
    lorebook?: string;
    boundCharacters?: string[];
    avatar?: string;
  },
): PersonaState {
  return {
    ...state,
    personas: state.personas.map((one) => {
      if (one.id !== id) return one;
      return {
        ...one,
        name:
          patch.name !== undefined && patch.name.trim() !== ''
            ? clampText(patch.name.trim(), MAX_NAME_LEN)
            : one.name,
        description:
          patch.description !== undefined
            ? clampText(patch.description, MAX_DESC_LEN)
            : one.description,
        position: patch.position ?? one.position,
        depth:
          patch.depth !== undefined
            ? Math.min(Math.max(Math.round(patch.depth), 0), MAX_DEPTH)
            : one.depth,
        role: patch.role ?? one.role,
        lorebook: patch.lorebook ?? one.lorebook,
        boundCharacters: patch.boundCharacters ?? one.boundCharacters,
        avatar: patch.avatar ?? one.avatar,
      };
    }),
  };
}

/**
 * 删一套。
 *
 * 删掉的正好是当前选中项 ⇒ `selectedId` 归 null（回到默认名）。
 * 不归 null 的话 `activePersona` 会返回 null 但 `selectedId` 还指着空 ——
 * 下次新建时"自动选中"会覆盖它，看起来自愈了，但中间那段时间状态是脏的。
 */
export function removePersona(state: PersonaState, id: string): PersonaState {
  return {
    ...state,
    personas: state.personas.filter((one) => one.id !== id),
    selectedId: state.selectedId === id ? null : state.selectedId,
  };
}

/** 选中一套 */
export function selectPersona(state: PersonaState, id: string | null): PersonaState {
  if (id === null) return { ...state, selectedId: null };
  if (!state.personas.some((one) => one.id === id)) return state;
  return { ...state, selectedId: id };
}

/**
 * 「为所有消息设置为该用户」时要改哪些消息。
 *
 * ## 用户原话
 *
 * > 为所有消息设置为该用户
 *
 * 即：把这段聊天里**所有由用户发出的消息**的名字换成这个人设的名字。
 *
 * ## 为什么只改 `is_user` 的
 *
 * 角色发的消息名字是角色名，改成用户的名字会让对话彻底错乱
 * （看起来像角色在自称用户）。
 *
 * ## 为什么要返回新数组而不是就地改
 *
 * 调用方要拿它去 `setMessages` + 存盘。就地改会让面板手里的数组
 * 与磁盘上的不一致，而"改了但没存"是这类批量操作最容易漏的一步。
 */
export function relabelUserMessages<T extends { is_user: boolean; name: string }>(
  messages: readonly T[],
  name: string,
): T[] {
  const target = name.trim();
  if (target === '') return messages.slice();
  return messages.map((one) => (one.is_user ? { ...one, name: target } : one));
}
