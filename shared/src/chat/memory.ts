/**
 * 角色级「记忆」（2026-11-22，v0.2.2）。
 *
 * ## 它解决什么
 *
 * 用户原话：
 *
 * > 类似于长期记忆这种（世界书虽然可以编辑但是每次聊天都多点几步进去很不方便，
 * > 作者注释也是同样的原因，这个主打的就是随手可改，只需要点一次就可以打开界面更改）
 *
 * 痛点不是"缺一个存记忆的地方"，而是**改一次要点四五步**。所以这一层的价值几乎
 * 全在"点一次就能改"上，数据结构只要够简单就行。
 *
 * ## 与现有三样东西的区别（别混）
 *
 * ```text
 *   世界书      条目化、按关键字激活、可编辑但入口深
 *   作者注释    全局（extension_settings.note.default）、不是角色级
 *   角色提示词  随卡走（写在 PNG 的 extensions.tcs 里）
 *   本模块      只存本地、按角色分槽、每次请求固定注入、不写进卡
 * ```
 *
 * ## 为什么纯函数
 *
 * 整个文件不碰 DOM、不碰网络、不读 localStorage —— 判据可以直接跑。
 * 存储读写留在 `client/src/mobile/main.ts`，界面留在 `client/src/chat/memory-page.ts`。
 */

import { estimateTokens } from './token-budget.js';

/** 结构版本。将来改形状时用它做迁移 */
export const MEMORY_VERSION = 1;

/**
 * 总字符上限。
 *
 * ## 为什么是 3000 而不是用户最初提的 4000–5000
 *
 * 3000 汉字 = 9000 字节 ≈ 2687 token（`BYTES_PER_TOKEN = 3.35`）。
 * 而输入预算是 `上下文 − 回复预留`：
 *
 * ```text
 *   上下文 4096（schema fallback）− 回复 800 = 3296   ⇒ 记忆占 81.5%
 *   上下文 8192                     − 2048  = 6144   ⇒ 43.7%
 *   上下文 32768                    − 2048  = 30720  ⇒  8.7%
 * ```
 *
 * 4096 那一档会出真问题：记忆是不可裁项（见 `prompt-assemble.ts` 的
 * `trimmable = false`），预算不够时被裁的是**聊天历史** ——
 * 用户看到的是"我明明在聊天，它怎么什么都不记得"。
 *
 * 3000 是用户自己折中后的决定。界面必须实时显示 token 与占比，
 * 超过 50% 时提示调大上下文。
 */
export const MEMORY_MAX_CHARS = 3000;

/** 单条记忆 */
export interface MemoryEntry {
  /** 稳定 id（`mem-1` / `mem-2`…），编辑与删除靠它定位 */
  id: string;
  /** 正文。**字符数只算这一项**，不含元数据 */
  text: string;
  /** 创建时间（毫秒）。只给界面排序用，不发给模型 */
  at: number;
}

/** 一个角色的全部记忆 */
export interface CharacterMemory {
  entries: MemoryEntry[];
}

/** 存档根结构（`localStorage['tcs.mobile.memory']`） */
export interface MemoryStore {
  version: number;
  /** 键是 avatar 文件名（如 `西奥.png`） */
  byAvatar: Record<string, CharacterMemory>;
}

/** 空存档 */
export function emptyMemoryStore(): MemoryStore {
  return { version: MEMORY_VERSION, byAvatar: {} };
}

/** 计算已用字符数。只算 `text`，不把 id / 时间戳算进去 */
export function usedChars(entries: readonly MemoryEntry[]): number {
  let total = 0;
  for (const one of entries) total += one.text.length;
  return total;
}

/** 剩余可用字符数。已超限时返回负数 —— 调用方要靠它显示"超出多少" */
export function remainingChars(entries: readonly MemoryEntry[]): number {
  return MEMORY_MAX_CHARS - usedChars(entries);
}

/** 是否在限额内（保存按钮的启用条件） */
export function withinLimit(entries: readonly MemoryEntry[]): boolean {
  return usedChars(entries) <= MEMORY_MAX_CHARS;
}

/**
 * 这条能不能存。空正文不能存 —— 存了就是一个看不见的空条目，
 * 用户会以为"我加了但没生效"。
 */
export function isEntryStorable(text: string): boolean {
  return text.trim().length > 0;
}

/**
 * 记忆大约占多少 token。
 *
 * ## 必须用 `estimateTokens`，不许自己再算一遍
 *
 * 那是预算裁剪用的**同一个函数**（`token-budget.ts`）。另写一套的话，
 * 界面上的数字与实际裁剪结果必然对不上，而用户会照那个数字去调上下文。
 */
export function memoryTokens(entries: readonly MemoryEntry[]): number {
  return estimateTokens(entries.map((one) => one.text).join('\n'));
}

/** 预算视图（界面实时提示用） */
export interface MemoryBudgetView {
  chars: number;
  maxChars: number;
  /** 剩余字符（负数=超出） */
  remaining: number;
  tokens: number;
  /** 输入预算（`上下文 − 回复预留`）。未设置上下文时为 0 */
  inputBudget: number;
  /** 记忆占输入预算的百分比。`inputBudget` 为 0 时是 `null`（无法估算） */
  percent: number | null;
  /** 占比是否已达到"该提醒"的程度 */
  tight: boolean;
}

/**
 * 占比超过这个值就提醒用户调大上下文。
 *
 * 50% 的依据：记忆之外还要放 system prompt、角色设定、世界书、对话示例
 * 和聊天历史。记忆占一半时，剩下五样挤在另一半里，历史基本进不去。
 */
const TIGHT_PERCENT = 50;

/**
 * 组装界面要显示的一组数字。
 *
 * ★ 上下文为 0 时 `computeBudget` 的语义是"不裁剪"，此时**不能算占比** ——
 * 会显示一个假百分比（除以 0 得 Infinity，或者干脆 100%）。
 * 所以 `percent` 返回 `null`，界面退化成"未设置上下文长度，无法估算"。
 */
export function memoryBudgetView(
  entries: readonly MemoryEntry[],
  inputBudget: number,
): MemoryBudgetView {
  const chars = usedChars(entries);
  const tokens = memoryTokens(entries);
  const budget = Number.isFinite(inputBudget) && inputBudget > 0 ? Math.floor(inputBudget) : 0;
  const percent = budget === 0 ? null : Math.round((tokens / budget) * 100);
  return {
    chars,
    maxChars: MEMORY_MAX_CHARS,
    remaining: MEMORY_MAX_CHARS - chars,
    tokens,
    inputBudget: budget,
    percent,
    tight: percent !== null && percent >= TIGHT_PERCENT,
  };
}

/* ═══════════════════════════════════════════════════════════
   解析（外部数据一律当不可信）
   ═══════════════════════════════════════════════════════════ */

/** 把未知值收成字符串；非字符串返回空串 */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 解析一个条目的数组。
 *
 * 两种写法都认：字符串、`{text}` 对象。后者是为了将来加字段时
 * 老文件还能读（也便于用户手工编辑 JSON）。
 */
function parseEntries(raw: unknown): MemoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: MemoryEntry[] = [];
  let seq = 0;
  for (const item of raw) {
    let text = '';
    let at = 0;
    if (typeof item === 'string') {
      text = item;
    } else if (item !== null && typeof item === 'object') {
      const row = item as Record<string, unknown>;
      text = asText(row['text']);
      at = typeof row['at'] === 'number' && Number.isFinite(row['at']) ? row['at'] : 0;
    }
    /* 空正文一律丢掉：留着只会变成一个看不见的条目 */
    if (!isEntryStorable(text)) continue;
    seq += 1;
    out.push({ id: `mem-${String(seq)}`, text, at });
  }
  return out;
}

/**
 * 解析整个存档。
 *
 * 任何一层坏掉都退回"空"，**不抛异常** —— 记忆读不出来时聊天必须照常能用，
 * 不能因为一个坏 JSON 就让整个 App 打不开。
 */
export function parseMemoryStore(raw: unknown): MemoryStore {
  if (raw === null || typeof raw !== 'object') return emptyMemoryStore();
  const root = raw as Record<string, unknown>;
  const byAvatarRaw = root['byAvatar'];
  if (byAvatarRaw === null || typeof byAvatarRaw !== 'object' || Array.isArray(byAvatarRaw)) {
    return emptyMemoryStore();
  }

  const byAvatar: Record<string, CharacterMemory> = {};
  for (const [avatar, value] of Object.entries(byAvatarRaw as Record<string, unknown>)) {
    if (avatar.trim() === '') continue;
    if (value === null || typeof value !== 'object') continue;
    /* 兼容两种形状：`{entries:[…]}` 与直接一个数组 */
    const entriesRaw = Array.isArray(value)
      ? value
      : (value as Record<string, unknown>)['entries'];
    const entries = parseEntries(entriesRaw);
    if (entries.length > 0) byAvatar[avatar] = { entries };
  }

  return { version: MEMORY_VERSION, byAvatar };
}

/** 取某个角色的记忆（没有就返回空数组，不返回 undefined） */
export function memoryOf(store: MemoryStore, avatar: string): MemoryEntry[] {
  return store.byAvatar[avatar]?.entries ?? [];
}

/**
 * 写入某个角色的记忆，返回**新**存档。
 *
 * 条目为空时把该角色的槽整个删掉 —— 否则存档里会堆一堆空壳，
 * 而"有没有记忆"的判断会一直是"有"。
 */
export function withMemoryOf(
  store: MemoryStore,
  avatar: string,
  entries: readonly MemoryEntry[],
): MemoryStore {
  const next: Record<string, CharacterMemory> = { ...store.byAvatar };
  if (entries.length === 0) {
    delete next[avatar];
  } else {
    next[avatar] = { entries: [...entries] };
  }
  return { version: MEMORY_VERSION, byAvatar: next };
}

/* ═══════════════════════════════════════════════════════════
   导入 / 导出
   ═══════════════════════════════════════════════════════════ */

/**
 * 导出文件的结构。
 *
 * ## 只有两项，是用户明确要求的
 *
 * > 记忆导出导入是单独的json，只需要在json里面放入这个角色名字和记忆条目就行，
 * > 不要放卡设定世界书提示词之类的
 *
 * 所以这里没有角色设定、没有世界书、没有提示词、也没有时间戳。
 */
export interface MemoryExportFile {
  character: string;
  memories: string[];
}

/** 组装导出内容。条目只留正文，去掉 id 与时间戳 —— 那些是本地状态 */
export function buildExportFile(characterName: string, entries: readonly MemoryEntry[]): MemoryExportFile {
  return { character: characterName, memories: entries.map((one) => one.text) };
}

/**
 * 导出文件名。
 *
 * 清理规则与 `chatExportFileName`（`chat-export.ts:232`）一致：
 * 去掉控制字符与文件系统不接受的字符，空名兜底，长度截到 40。
 * 两处都留一份是有意的 —— 一个在聊天导出、一个在记忆导出，
 * 抽公共函数会让"改一个影响另一个"，而这两个的兜底文案不同。
 */
export function memoryExportFileName(characterName: string): string {
  let out = '';
  for (const ch of Array.from(characterName.trim())) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    if ('/\\:*?"<>|'.includes(ch)) continue;
    out += ch;
  }
  out = out.trim().slice(0, 40);
  return `${out === '' ? '角色' : out} · 记忆.json`;
}

/** 导入结果 */
export interface ImportResult {
  /** 解析出的角色名（可能为空串） */
  character: string;
  /** 实际新增的条目 */
  added: MemoryEntry[];
  /** 因为与已有条目重复而跳过的条数 */
  skipped: number;
  /** 因正文为空被丢弃的条数 */
  droppedEmpty: number;
}

/**
 * 解析导入文件。
 *
 * ## 容错范围
 *
 * ```text
 *   { character, memories: ["…"] }         ← 我们自己导出的
 *   { character, memories: [{text:"…"}] }  ← 手工改过的
 *   { character, entries: […] }            ← 早期写法 / 别的工具
 *   裸数组 ["…"]                            ← 用户直接从别处粘的
 * ```
 *
 * 角色名缺失不算错（会返回空串），由界面提示"这份文件没写角色名"。
 */
export function parseImportFile(raw: unknown): { character: string; entries: MemoryEntry[] } {
  if (Array.isArray(raw)) {
    return { character: '', entries: parseEntries(raw) };
  }
  if (raw === null || typeof raw !== 'object') {
    return { character: '', entries: [] };
  }
  const root = raw as Record<string, unknown>;
  const character = asText(root['character']).trim();
  const list = root['memories'] ?? root['entries'];
  return { character, entries: parseEntries(list) };
}

/**
 * 把导入的条目合并进现有列表。
 *
 * ## 为什么默认只合并、不做替换
 *
 * 替换是一次误点就清空全部记忆的操作，而记忆是用户手写的、没有其他备份
 * （导出文件可能没生成过）。合并最坏情况是多了几条，删掉即可。
 *
 * ## 去重按完全一致
 *
 * 不做 trim 后再比：用户可能刻意保留前后空白（比如想让某条排在最前）。
 * 也不做相似度匹配 —— "看起来差不多"的两条可能含义不同，自动合并会丢信息。
 */
export function mergeImported(
  existing: readonly MemoryEntry[],
  incoming: readonly MemoryEntry[],
  now: number,
): ImportResult {
  const seen = new Set(existing.map((one) => one.text));
  /*
   * 新条目从现有最大编号往后排。
   *
   * 不重新从 1 开始：那会与现有条目的 id 撞车，而 id 是编辑/删除的定位依据 ——
   * 撞了之后改一条会同时改到另一条。
   */
  let seq = 0;
  for (const one of existing) {
    const m = /^mem-(\d+)$/.exec(one.id);
    if (m !== null) seq = Math.max(seq, Number(m[1]));
  }

  const added: MemoryEntry[] = [];
  let skipped = 0;
  for (const one of incoming) {
    if (!isEntryStorable(one.text)) continue;
    if (seen.has(one.text)) {
      skipped += 1;
      continue;
    }
    seen.add(one.text);
    seq += 1;
    added.push({ id: `mem-${String(seq)}`, text: one.text, at: now });
  }

  const droppedEmpty = incoming.length - added.length - skipped;
  return { character: '', added, skipped, droppedEmpty: Math.max(0, droppedEmpty) };
}

/** 给新条目分配一个不撞车的 id */
export function nextEntryId(entries: readonly MemoryEntry[]): string {
  let max = 0;
  for (const one of entries) {
    const m = /^mem-(\d+)$/.exec(one.id);
    if (m !== null) max = Math.max(max, Number(m[1]));
  }
  return `mem-${String(max + 1)}`;
}

/* ═══════════════════════════════════════════════════════════
   注入上下文
   ═══════════════════════════════════════════════════════════ */

/** 注入时用的包裹格式。留空正文时调用方应跳过 */
export interface MemoryInjectConfig {
  entries: readonly MemoryEntry[];
  /** 以什么身份插入。默认 system */
  role?: 'system' | 'user' | 'assistant';
}

/**
 * 生成要注入的那段文本。
 *
 * ## 为什么自己加标题
 *
 * 裸的若干行文本，模型不知道那是"当事人的长期记忆"还是"上一轮的残留"。
 * 一行标题把它定性成背景资料。
 *
 * ## 为什么条目之间用换行而不是编号
 *
 * 编号（`1. 2. 3.`）会让模型以为那是待办事项或步骤，
 * 而记忆是并列的事实。
 *
 * ## 为什么这里没有"你应当记住"这类祈使句
 *
 * 指令性措辞会与用户自己的提示词抢权重。记忆是**资料**，不是命令。
 * 用户在提示词里怎么写由他决定。
 */
export function renderMemoryBlock(entries: readonly MemoryEntry[]): string {
  const lines = entries.map((one) => one.text.trim()).filter((text) => text !== '');
  if (lines.length === 0) return '';
  return `【长期记忆】\n${lines.join('\n')}`;
}

/** 注入用的角色，缺省 system */
export function memoryRole(config: MemoryInjectConfig): 'system' | 'user' | 'assistant' {
  return config.role ?? 'system';
}
