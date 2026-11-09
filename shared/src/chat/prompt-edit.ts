/**
 * 提示词的**新增 / 编辑 / 删除**写回层（2026-11-07）。
 *
 * ## 用户的要求
 *
 * > AI响应中提示词管理中增加自定义编辑和增加提示词的功能，和原生ST一样。
 *
 * 之前这一页只能**开关**（`prompt-toggle.ts`）。用户要在 App 里调提示词，
 * 就得回 ST 网页 —— 而这是个手机 App，那条路等于没有。
 *
 * ## ★★★ 为什么必须操作"原始预设体"，而不是解析后的模型
 *
 * `parsePromptConfig()` 只挑它认识的 11 个字段，**其余全部丢掉**。
 * 而 ST 的一条提示词实际有更多键：
 *
 * ```text
 *   identifier / name / content / role / system_prompt / marker
 *   injection_position / injection_depth / injection_order
 *   injection_trigger     ← 数组，空 = 所有生成类型
 *   forbid_overrides      ← 布尔
 *   extension             ← 布尔（是否扩展自带）
 * ```
 *
 * 如果拿解析后的对象写回去，`injection_trigger` / `forbid_overrides`
 * 会被静默抹掉 —— 用户那些"只在续写时生效"的提示词就变成"总是生效"。
 * 这正是 §106 那条「31 字段不许丢」的同一类错误。
 *
 * 所以这里的规矩是：**只改我们管的 6 个字段，其余原样 spread**。
 */

import type { ParsedPromptConfig, PromptRole, StPrompt } from './prompt-config.js';

/** 一次编辑要写进去的值（不含 identifier —— 那个是身份，不改） */
export interface PromptDraft {
  name: string;
  content: string;
  role: PromptRole;
  /** `0` = 跟随顺序，`1` = 按深度插入历史 */
  injectionPosition: number;
  /** 仅 `injectionPosition === 1` 有意义 */
  injectionDepth: number;
  /** 越小越靠前；ST 缺省 100 */
  injectionOrder: number;
}

/** 写回结果。`changed === false` 表示"本来就是这状态"，可以省一次 IO */
export type PromptWriteResult =
  | { ok: true; body: Record<string, unknown>; changed: boolean }
  | { ok: false; reason: string };

/** 新建时的默认值（与 ST 新建一条时的初值一致） */
export const NEW_PROMPT_DRAFT: PromptDraft = {
  name: '',
  content: '',
  role: 'system',
  injectionPosition: 0,
  injectionDepth: 0,
  injectionOrder: 100,
};

/**
 * 生成一个新提示词的 identifier。
 *
 * ## 为什么不用 `Date.now()` 或递增下标
 *
 * identifier 是 ST 里的**主键**，会被写进 `prompts` 和每一份
 * `prompt_order`。用时间戳有两个问题：
 *
 * ```text
 *   同一毫秒建两条  → 撞车，后一条覆盖前一条（列表里少一条，极难发现）
 *   用下标 prompt-N → 与 parsePromptConfig 给"没 identifier 的项"造的兜底 id 撞
 * ```
 *
 * 所以用 `crypto.randomUUID()`；没有就退回"时间 + 随机"，且加 `tcs-` 前缀
 * 保证永远不与 ST 自己生成的 uuid 冲突。
 */
export function newPromptIdentifier(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === 'function') {
    try {
      return `tcs-${c.randomUUID()}`;
    } catch {
      /* 某些环境有 crypto 但 randomUUID 会抛（非安全上下文）—— 走兜底 */
    }
  }
  const rand = Math.random().toString(36).slice(2, 10);
  return `tcs-${Date.now().toString(36)}-${rand}`;
}

/** 从预设体里取出 `prompts` 数组（原样，不复制） */
function promptsOf(root: Record<string, unknown>): unknown[] | null {
  const raw = root['prompts'];
  return Array.isArray(raw) ? raw : null;
}

/**
 * 新建一条提示词。
 *
 * ## 同时要办两件事
 *
 * ```text
 *   ① prompts 数组里加一条
 *   ② **每一份** prompt_order 里加一行（enabled: true）
 * ```
 *
 * 只做 ① 的话，新提示词"存在但不发送" —— 解析时会因为"不在顺序表里"
 * 被判为忽略，用户看到的是"我加了，但没生效"。
 *
 * 为什么是"每一份"而不是"当前那一份"：预设里通常只有一份全局顺序表
 * （`character_id: 100000`），但也可能有按角色分的多份。加到全部里
 * 与 ST 的行为一致，也避免"换个角色就不见了"。
 */
export function createPrompt(
  body: unknown,
  draft: PromptDraft,
  identifier: string,
): PromptWriteResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: '当前预设的内容读不出来（不是对象），没法新增提示词。' };
  }
  const root = body as Record<string, unknown>;

  const prompts = promptsOf(root);
  if (prompts === null) {
    return { ok: false, reason: '这份预设里没有提示词列表，没法新增。' };
  }
  if (prompts.some((one) => readId(one) === identifier)) {
    return { ok: false, reason: '标识符撞车了，请重试一次。' };
  }

  /*
   * 新条目的键**照 ST 的 `Prompt` 构造器给全**（`PromptManager.js`）。
   *
   * 给全而不是只给 6 个：ST 自己会读 `marker` / `system_prompt` /
   * `forbid_overrides` / `injection_trigger`，缺键时它按 `undefined` 走，
   * 大多数情况能兜住，但 `shouldTrigger()` 对**非数组**返回 true，
   * 而 `Array.isArray(undefined) === false` ⇒ 侥幸正确。
   * 不依赖侥幸运气：显式写 `[]`。
   */
  const entry: Record<string, unknown> = {
    identifier,
    name: draft.name,
    content: draft.content,
    role: draft.role,
    system_prompt: false,
    marker: false,
    injection_position: draft.injectionPosition,
    injection_depth: draft.injectionDepth,
    injection_order: draft.injectionOrder,
    injection_trigger: [],
    forbid_overrides: false,
  };

  const nextOrder = addToAllOrders(root['prompt_order'], identifier);

  return {
    ok: true,
    body: { ...root, prompts: [...prompts, entry], ...nextOrder },
    changed: true,
  };
}

/**
 * 改一条已有的提示词。
 *
 * ★ 只改这 6 个字段，其余 keys **原样保留**（见文件头那段说明）。
 */
export function updatePrompt(
  body: unknown,
  identifier: string,
  draft: PromptDraft,
): PromptWriteResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: '当前预设的内容读不出来（不是对象），没法保存这条提示词。' };
  }
  const root = body as Record<string, unknown>;
  const prompts = promptsOf(root);
  if (prompts === null) return { ok: false, reason: '这份预设里没有提示词列表，没法保存。' };

  const index = prompts.findIndex((one) => readId(one) === identifier);
  if (index < 0) {
    return { ok: false, reason: '预设里找不到这条提示词，可能刚在别处删掉了。' };
  }

  const old = prompts[index];
  if (old === null || typeof old !== 'object' || Array.isArray(old)) {
    return { ok: false, reason: '这条提示词的内容不对（不是对象），没法保存。' };
  }
  const oldEntry = old as Record<string, unknown>;

  const nextEntry: Record<string, unknown> = {
    ...oldEntry,
    name: draft.name,
    content: draft.content,
    role: draft.role,
    injection_position: draft.injectionPosition,
    injection_depth: draft.injectionDepth,
    injection_order: draft.injectionOrder,
  };

  /* 内容没变就不写：省一次整份预设的上传，也避免无意义的保存时间戳 */
  const changed = !sameEntry(oldEntry, nextEntry);
  if (!changed) return { ok: true, body: root, changed: false };

  const nextPrompts = prompts.map((one, i) => (i === index ? nextEntry : one));
  return { ok: true, body: { ...root, prompts: nextPrompts }, changed: true };
}

/**
 * 删一条提示词。
 *
 * ## 为什么内置槽位不许删
 *
 * `marker === true` 的那些是**结构位**（角色描述、世界书、对话历史…）。
 * 删掉它们不会"少发一段"，而是让拼装时**找不到内容来源** ——
 * 表现是角色完全不像、或者请求格式坏掉，而用户只会觉得"模型抽风了"。
 *
 * 自定义提示词（marker 为 false）可以删，那才是用户自己加的东西。
 */
export function deletePrompt(body: unknown, identifier: string): PromptWriteResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: '当前预设的内容读不出来（不是对象），没法删除。' };
  }
  const root = body as Record<string, unknown>;
  const prompts = promptsOf(root);
  if (prompts === null) return { ok: false, reason: '这份预设里没有提示词列表，没法删除。' };

  const target = prompts.find((one) => readId(one) === identifier);
  if (target === undefined) {
    return { ok: false, reason: '预设里找不到这条提示词，可能已经被删掉了。' };
  }
  const entry = target !== null && typeof target === 'object' ? (target as Record<string, unknown>) : {};
  if (entry['marker'] === true) {
    return {
      ok: false,
      reason: '这是内置槽位（内容来自角色卡 / 世界书 / 对话记录），删掉会让角色不像，不能删。',
    };
  }

  const nextPrompts = prompts.filter((one) => readId(one) !== identifier);
  /*
   * 顺序表里**所有**引用都要清掉。
   *
   * 留着的话 `parsePromptConfig` 会报"顺序表里有 N 项找不到" ——
   * 虽然它只是跳过，但用户每次进页面都看到一句警告，
   * 而他自己刚删过、无法消除。
   */
  const nextOrder = removeFromAllOrders(root['prompt_order'], identifier);

  return {
    ok: true,
    body: { ...root, prompts: nextPrompts, ...nextOrder },
    changed: true,
  };
}

/** 取出某条提示词在**原始预设体**里的触发器（只读展示用） */
export function readInjectionTrigger(body: unknown, identifier: string): readonly string[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return [];
  const prompts = promptsOf(body as Record<string, unknown>);
  if (prompts === null) return [];
  const entry = prompts.find((one) => readId(one) === identifier);
  if (entry === null || entry === undefined || typeof entry !== 'object') return [];
  const raw = (entry as Record<string, unknown>)['injection_trigger'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((one): one is string => typeof one === 'string');
}

/** 编辑页需要的"当前值"：从解析后的模型取（它够用），触发器单独读原始体 */
export function draftOf(prompt: StPrompt): PromptDraft {
  return {
    name: prompt.name,
    content: prompt.content,
    role: prompt.role,
    injectionPosition: prompt.injectionPosition,
    injectionDepth: prompt.injectionDepth,
    injectionOrder: prompt.injectionOrder,
  };
}

/** 草稿的校验。返回 `null` = 通过 */
export function validateDraft(draft: PromptDraft): string | null {
  /*
   * 名字为空**不算错**：ST 允许，列表里会用 identifier 兜底显示。
   * 但正文为空对一个非标记位的提示词来说毫无意义 —— 它发出去就是空。
   * 那更可能是"还没写"而不是"故意留空"，所以提示一句。
   */
  if (draft.content.trim() === '') return '这条还没写内容，发出去是空的。';
  if (!Number.isFinite(draft.injectionDepth) || draft.injectionDepth < 0) {
    return '深度要是 0 或更大的整数。';
  }
  if (!Number.isFinite(draft.injectionOrder)) return '排序要是个数字。';
  return null;
}

/* ── 内部工具 ───────────────────────────────────────────── */

function readId(one: unknown): string {
  if (one === null || typeof one !== 'object') return '';
  const value = (one as Record<string, unknown>)['identifier'];
  return typeof value === 'string' ? value : '';
}

function sameEntry(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  for (const key of [
    'name',
    'content',
    'role',
    'injection_position',
    'injection_depth',
    'injection_order',
  ]) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * 给每一份 order 加一行。
 *
 * 不动 `character_id`、不动已有行的顺序 —— 新行加在**末尾**，
 * 这样用户原来调好的相对顺序一条都不变。
 */
function addToAllOrders(raw: unknown, identifier: string): Record<string, unknown> {
  if (!Array.isArray(raw)) return {};
  const next = raw.map((one) => {
    if (one === null || typeof one !== 'object') return one;
    const entry = one as Record<string, unknown>;
    const rows = entry['order'];
    if (!Array.isArray(rows)) return one;
    return {
      ...entry,
      order: [...rows, { identifier, enabled: true }],
    };
  });
  return { prompt_order: next };
}

/** 从每一份 order 里删掉某 identifier */
function removeFromAllOrders(raw: unknown, identifier: string): Record<string, unknown> {
  if (!Array.isArray(raw)) return {};
  const next = raw.map((one) => {
    if (one === null || typeof one !== 'object') return one;
    const entry = one as Record<string, unknown>;
    const rows = entry['order'];
    if (!Array.isArray(rows)) return one;
    return {
      ...entry,
      order: rows.filter((row) => readId(row) !== identifier),
    };
  });
  return { prompt_order: next };
}

/** 这个 identifier 在解析结果里能不能找到（调用方用来判"是不是刚被删了"） */
export function hasPrompt(config: ParsedPromptConfig | null, identifier: string): boolean {
  if (config === null) return false;
  return config.prompts.some((one) => one.identifier === identifier);
}
