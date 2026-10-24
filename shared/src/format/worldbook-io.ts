/**
 * 世界书独立导入 / 导出（T10.9）。
 *
 * 支持两种来源，**自动识别**：
 *   · `character_book` JSON（ST 原生形态：裸数组 / `{entries}` / `{character_book:{entries}}`）；
 *   · 纯 TXT 条目格式（docs/04 冻结的 v1.0 格式）。
 *
 * 为什么单独一个模块而不是塞进 `worldbook.ts`：
 *   `worldbook.ts` 是**冻结规范**的实现，只认 TXT；它的每条规则都对应 docs/04 的一节，
 *   改动要走升版本流程。JSON 导入是另一个方向的映射（外部数据 → 内部模型），
 *   校验口径与错误定位方式都不同，混在一起会让"冻结点不得回退"这句话失去意义。
 *
 * 三条硬规则：
 *
 *  1. **JSON 未改动时逐字节写回**（`exportWorldbook` 的 `verbatim`）。
 *     用户的文件可能有自己的缩进、键顺序、`\u` 转义。我们只做"读 → 看 → 写回"，
 *     不该顺手把它重排成我们的风格 —— 那会让一次"打开又保存"变成一整篇 diff。
 *     改动过才走规范序列化，并明确告知（`verbatim: false`）。
 *
 *  2. **错误必须能定位**。语法错误按字符偏移换成 1-based 行/列；
 *     条目级错误给 `entryIndex`，并尽量带上行号（扫描原文里该条目对象的起点）。
 *     只说"格式不对"等于让用户自己数括号。
 *
 *  3. **不静默丢弃**。顶层周边字段（`name` / `scan_depth` / `extensions` 等）
 *     全部进 `meta` 并原样带出；条目里的未知键留在条目对象里（`[key: string]: unknown`
 *     本来就允许）。丢字段是最难被发现的错误——导出后才发现就晚了。
 */

import type { StCharacterBook, StWorldbookEntry } from '../model/sillytavern.js';
import { offsetToLineColumn } from '../text/count.js';
import { parseWorldbookTextWith, renderWorldbookTextWith } from './worldbook.js';
import { DEFAULT_WORLDBOOK_FORMAT, type WorldbookFormatParams } from './worldbook-preset.js';

/** 复述一遍形状，供本文件内部的 `location` 变量使用（列号按码点，见 text/count） */
type Location = { line?: number; column?: number };

export type WorldbookFormat = 'json' | 'txt';

export interface WorldbookIoIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  /** 1-based 行号（能定位时） */
  line?: number;
  /** 1-based 列号（能定位时） */
  column?: number;
  /** 条目下标（0-based），条目级问题才有 */
  entryIndex?: number;
  hint?: string;
}

export interface WorldbookImportResult {
  /** 识别出的格式；无法识别时 null */
  format: WorldbookFormat | null;
  entries: StWorldbookEntry[];
  /** `character_book` 的周边字段（不含 `entries`），导出时原样带出 */
  meta: Record<string, unknown>;
  issues: WorldbookIoIssue[];
  ok: boolean;
  /** 原文（用于"未改动则逐字节写回"） */
  rawText: string;
}

// ---------------------------------------------------------------- 定位

/**
 * 从 `JSON.parse` 的错误信息里取出字符偏移。
 *
 * V8 的措辞**跨版本变过**：Node 20 及之前是
 * `Unexpected token } in JSON at position 45`，而 Node 22 改成了
 * `Unexpected token ']', ..."片段" is not valid JSON` —— **完全没有 position**。
 * 2026-10-23 实测踩到：同一段坏 JSON 在 Node 22 上拿不到偏移，
 * 于是"错误定位"这个需求点等于没实现。
 *
 * 所以这里只作为**快速路径**：取不到就让 {@link findJsonSyntaxError} 自己扫一遍。
 * 依赖第三方报错文案是很难维护的耦合，能少依赖一层就少一层。
 */
export function offsetFromJsonError(message: string): number | null {
  const match = /at position (\d+)/.exec(message);
  if (match?.[1] === undefined) return null;
  const offset = Number.parseInt(match[1], 10);
  return Number.isFinite(offset) ? offset : null;
}

/** 扫描结果：出错字符偏移 + 人话描述 */
export interface JsonSyntaxError {
  offset: number;
  message: string;
}

/**
 * 极小的 JSON 语法扫描器，只用来**定位**（合法与否由 `JSON.parse` 判定）。
 *
 * 为什么自己写：见 {@link offsetFromJsonError} 上面那段 —— 原生报错不再给位置，
 * 而"第 3 行第 5 列多了个逗号"与"格式不对"是完全不同的帮助。
 *
 * 只覆盖常见结构性错误（括号/逗号/引号/尾随逗号/未加引号的键），
 * 不做数值规范化校验（`01` 这类由 JSON.parse 拒掉，扫描器放过也没关系 ——
 * 它只在 parse 已经失败之后才被调用，作用是**找位置**，不是判合法性）。
 */
export function findJsonSyntaxError(text: string): JsonSyntaxError | null {
  let i = 0;
  const len = text.length;

  const fail = (message: string, at = i): JsonSyntaxError => ({ offset: Math.min(at, len), message });
  const skipWs = (): void => {
    while (i < len && /\s/.test(text[i]!)) i += 1;
  };

  function parseString(): JsonSyntaxError | null {
    const start = i;
    i += 1; // 开引号
    while (i < len) {
      const char = text[i]!;
      if (char === '\\') {
        i += 2;
        continue;
      }
      if (char === '"') {
        i += 1;
        return null;
      }
      if (char === '\n' || char === '\r') {
        return fail('字符串里不能直接换行（要写成 \\n）', i);
      }
      i += 1;
    }
    return fail('字符串没有闭合（缺右双引号）', start);
  }

  function parseNumber(): JsonSyntaxError | null {
    const start = i;
    if (text[i] === '-') i += 1;
    while (i < len && /[0-9]/.test(text[i]!)) i += 1;
    if (text[i] === '.') {
      i += 1;
      while (i < len && /[0-9]/.test(text[i]!)) i += 1;
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i += 1;
      if (text[i] === '+' || text[i] === '-') i += 1;
      while (i < len && /[0-9]/.test(text[i]!)) i += 1;
    }
    return i === start ? fail('这里需要一个值') : null;
  }

  function parseValue(): JsonSyntaxError | null {
    skipWs();
    if (i >= len) return fail('内容意外结束，可能缺少右括号或值');
    const char = text[i]!;
    if (char === '{') return parseObject();
    if (char === '[') return parseArray();
    if (char === '"') return parseString();
    if (char === '-' || (char >= '0' && char <= '9')) return parseNumber();
    if (text.startsWith('true', i)) {
      i += 4;
      return null;
    }
    if (text.startsWith('false', i)) {
      i += 5;
      return null;
    }
    if (text.startsWith('null', i)) {
      i += 4;
      return null;
    }
    return fail(`无法识别的值起始字符 ${JSON.stringify(char)}`);
  }

  function parseObject(): JsonSyntaxError | null {
    i += 1; // {
    skipWs();
    if (text[i] === '}') {
      i += 1;
      return null;
    }
    for (;;) {
      skipWs();
      if (i >= len) return fail('对象没有闭合（缺右花括号）');
      if (text[i] !== '"') return fail('对象的键必须用双引号包起来');
      const keyError = parseString();
      if (keyError) return keyError;
      skipWs();
      if (text[i] !== ':') return fail('键后面缺少冒号');
      i += 1;
      const valueError = parseValue();
      if (valueError) return valueError;
      skipWs();
      if (text[i] === ',') {
        i += 1;
        skipWs();
        // 尾随逗号：`{ "a": 1, }` —— 最常见的错误，也是最容易自己数错的
        if (text[i] === '}') return fail('对象末尾多了逗号（JSON 不允许尾随逗号）');
        continue;
      }
      if (text[i] === '}') {
        i += 1;
        return null;
      }
      return fail(`对象里缺少逗号或右花括号（当前 ${i >= len ? '已到末尾' : JSON.stringify(text[i])}）`);
    }
  }

  function parseArray(): JsonSyntaxError | null {
    i += 1; // [
    skipWs();
    if (text[i] === ']') {
      i += 1;
      return null;
    }
    for (;;) {
      const valueError = parseValue();
      if (valueError) return valueError;
      skipWs();
      if (text[i] === ',') {
        i += 1;
        skipWs();
        if (text[i] === ']') return fail('数组末尾多了逗号（JSON 不允许尾随逗号）');
        continue;
      }
      if (text[i] === ']') {
        i += 1;
        return null;
      }
      return fail(`数组里缺少逗号或右方括号（当前 ${i >= len ? '已到末尾' : JSON.stringify(text[i])}）`);
    }
  }

  const error = parseValue();
  if (error) return error;
  skipWs();
  if (i < len) return fail('JSON 结束后还有多余内容');
  return null;
}

/**
 * 找出 entries 数组里每个元素对象的起始偏移。
 *
 * 为什么需要它：`JSON.parse` 只说"某处不对"，而条目级问题
 * （第 3 个条目不是对象、`keys` 不是数组）若不给出原文位置，用户只能自己数。
 *
 * 实现是一个极小的扫描器：先定位承载 entries 的 `[`，再按字符串/括号深度
 * 切出顶层元素起点。扫不出来就返回空数组 —— 宁可不给位置，也不给错位置。
 */
export function locateEntryOffsets(text: string, entriesKeySeen = false): number[] {
  const starts: number[] = [];
  let arrayStart = -1;

  if (!entriesKeySeen) {
    // 裸数组形态：第一个非空白字符是 `[`
    const first = text.search(/\S/);
    if (first >= 0 && text[first] === '[') arrayStart = first;
  }
  if (arrayStart < 0) {
    // `"entries" : [ ... ]` 形态
    const keyMatch = /"entries"\s*:\s*\[/.exec(text);
    if (keyMatch) arrayStart = keyMatch.index + keyMatch[0].length - 1;
  }
  if (arrayStart < 0) return starts;

  let depth = 0;
  let inString = false;
  let escaped = false;
  /** 数组第一层：当前是否在等一个新元素（`[` 之后、或 `,` 之后） */
  let expectElement = true;

  for (let i = arrayStart; i < text.length; i += 1) {
    const char = text[i]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      // 字符串也可能是一个（非法的）数组元素，同样要能定位
      if (depth === 1 && expectElement) {
        starts.push(i);
        expectElement = false;
      }
      inString = true;
      continue;
    }

    if (char === '[') {
      depth += 1;
      if (depth === 1) expectElement = true;
      continue;
    }

    if (char === '{') {
      if (depth === 1 && expectElement) {
        starts.push(i);
        expectElement = false;
      }
      depth += 1;
      continue;
    }

    if (char === ']' || char === '}') {
      // `]` 与 `}` 都要配对：只认 `]` 的话对象闭合没人认领，
      // 深度只增不减，后面的元素会被当成"内层"而全部漏掉（第一版就是这个错）。
      depth -= 1;
      if (depth === 0) break;
      continue;
    }

    if (depth !== 1) continue;

    if (char === ',') {
      expectElement = true;
      continue;
    }
    if (/\s/.test(char)) continue;
    if (expectElement) {
      // 数字/true/false/null 这类标量元素
      starts.push(i);
      expectElement = false;
    }
  }
  return starts;
}

// ---------------------------------------------------------------- JSON

const ENTRY_SCALAR_FIELDS = new Set<string>(['name', 'comment', 'content']);
const ENTRY_LIST_FIELDS = new Set<string>(['keys', 'secondary_keys']);
const ENTRY_BOOL_FIELDS = new Set<string>(['constant', 'enabled', 'case_sensitive', 'selective']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 校验并归一化单个条目。
 *
 * 不认识的键**原样保留**（`[key: string]: unknown` 允许），只在类型明显不对时告警。
 * 不做"补齐缺省值"：缺失就是缺失，注入默认值会污染版本 diff（docs/04 §3.2 同一条理由）。
 */
function normalizeEntry(
  raw: unknown,
  index: number,
  location: Location,
  issues: WorldbookIoIssue[],
): StWorldbookEntry | null {
  if (!isObject(raw)) {
    issues.push({
      severity: 'error',
      code: 'entry-not-object',
      message: `第 ${String(index + 1)} 个条目不是对象（收到 ${Array.isArray(raw) ? 'array' : typeof raw}）`,
      entryIndex: index,
      ...location,
      hint: '世界书条目必须是对象：{ "keys": [...], "content": "..." }',
    });
    return null;
  }

  const entry: StWorldbookEntry = { ...(raw as StWorldbookEntry) };

  if (entry.content === undefined) {
    entry.content = '';
    issues.push({
      severity: 'warning',
      code: 'entry-no-content',
      message: `第 ${String(index + 1)} 个条目缺少 content，已按空正文处理`,
      entryIndex: index,
      ...location,
    });
  } else if (typeof entry.content !== 'string') {
    issues.push({
      severity: 'error',
      code: 'entry-bad-content',
      message: `第 ${String(index + 1)} 个条目的 content 不是字符串（收到 ${typeof entry.content}）`,
      entryIndex: index,
      ...location,
    });
    return null;
  }

  if (entry.keys === undefined) {
    entry.keys = [];
    issues.push({
      severity: 'warning',
      code: 'entry-no-keys',
      message: `第 ${String(index + 1)} 个条目缺少 keys，已按空关键词处理（若非 constant 则永远不会触发）`,
      entryIndex: index,
      ...location,
    });
  } else if (!Array.isArray(entry.keys)) {
    issues.push({
      severity: 'error',
      code: 'entry-bad-keys',
      message: `第 ${String(index + 1)} 个条目的 keys 不是数组（收到 ${typeof entry.keys}）`,
      entryIndex: index,
      ...location,
      hint: '单关键词也要写成数组： "keys": ["银座"]',
    });
    return null;
  } else if (entry.keys.some((key) => typeof key !== 'string')) {
    issues.push({
      severity: 'warning',
      code: 'entry-key-not-string',
      message: `第 ${String(index + 1)} 个条目的 keys 里含非字符串项，已转为字符串`,
      entryIndex: index,
      ...location,
    });
    entry.keys = entry.keys.map((key) => String(key));
  }

  // secondary_keys 同 rules；类型不对时**保留原值**并告警（不静默删字段）
  if (entry.secondary_keys !== undefined && !Array.isArray(entry.secondary_keys)) {
    issues.push({
      severity: 'warning',
      code: 'entry-bad-secondary-keys',
      message: `第 ${String(index + 1)} 个条目的 secondary_keys 不是数组，已忽略该字段`,
      entryIndex: index,
      ...location,
    });
    delete entry.secondary_keys;
  }

  for (const field of ENTRY_SCALAR_FIELDS) {
    const value = entry[field];
    if (value !== undefined && typeof value !== 'string') {
      issues.push({
        severity: 'warning',
        code: 'entry-bad-scalar',
        message: `第 ${String(index + 1)} 个条目的 ${field} 不是字符串，已转为字符串`,
        entryIndex: index,
        ...location,
      });
      (entry as Record<string, unknown>)[field] = String(value);
    }
  }

  for (const field of ENTRY_LIST_FIELDS) {
    if (field === 'keys') continue;
    const value = entry[field];
    if (value === undefined) continue;
    if (!Array.isArray(value)) continue; // 上面已处理
  }

  for (const field of ENTRY_BOOL_FIELDS) {
    const value = entry[field];
    if (value !== undefined && typeof value !== 'boolean') {
      issues.push({
        severity: 'warning',
        code: 'entry-bad-boolean',
        message: `第 ${String(index + 1)} 个条目的 ${field} 不是布尔值（收到 ${String(value)}），已忽略`,
        entryIndex: index,
        ...location,
      });
      delete entry[field];
    }
  }

  if (entry.id !== undefined) {
    if (typeof entry.id !== 'number' || !Number.isInteger(entry.id) || entry.id < 0) {
      issues.push({
        severity: 'error',
        code: 'entry-bad-id',
        message: `第 ${String(index + 1)} 个条目的 id 不是非负整数（收到 ${JSON.stringify(entry.id)}）`,
        entryIndex: index,
        ...location,
        hint: 'id 是合并锚点，必须是 0、1、2…… 这样的整数；缺省时导入会自动补号',
      });
      return null;
    }
  }

  return entry;
}

/** 把内层对象里的 `entries` 拆出来，其余字段作为 meta */
function splitCharacterBook(book: Record<string, unknown>): {
  entries: unknown;
  meta: Record<string, unknown>;
  hasEntriesKey: boolean;
} {
  const meta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(book)) {
    if (key === 'entries') continue;
    meta[key] = value;
  }
  return { entries: book['entries'], meta, hasEntriesKey: 'entries' in book };
}

export interface ParseWorldbookJsonResult {
  entries: StWorldbookEntry[];
  meta: Record<string, unknown>;
  issues: WorldbookIoIssue[];
  ok: boolean;
}

/**
 * 解析 `character_book` JSON 文本。
 *
 * 接受三种形态（都见过实际文件）：
 *   1. `[ {id,keys,content}, ... ]`                   —— 有人只存条目数组
 *   2. `{ "entries": [ ... ], "name": "..." }`         —— ST 的 character_book 本体
 *   3. `{ "data": { "character_book": {...} } }` 或 `{ "character_book": {...} }`
 *      —— 整张卡里带出来的
 */
export function parseWorldbookJson(text: string): ParseWorldbookJsonResult {
  const issues: WorldbookIoIssue[] = [];
  const blank: ParseWorldbookJsonResult = { entries: [], meta: {}, issues, ok: false };

  if (text.trim() === '') {
    issues.push({ severity: 'error', code: 'empty-input', message: '文件是空的，没有可导入的世界书' });
    return blank;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const nativeMessage = error instanceof Error ? error.message : String(error);
    // 先试原生报错里的 position（老 Node 有），拿不到就自己扫一遍定位
    const nativeOffset = offsetFromJsonError(nativeMessage);
    const scanned = nativeOffset === null ? findJsonSyntaxError(text) : null;
    const offset = nativeOffset ?? scanned?.offset ?? null;
    const location: Location = offset === null ? {} : offsetToLineColumn(text, offset);
    issues.push({
      severity: 'error',
      code: 'json-syntax',
      message: `JSON 语法错误：${scanned?.message ?? nativeMessage}`,
      ...location,
      ...(offset === null
        ? {}
        : { hint: `出错位置在字符 ${String(offset)} 附近（第 ${String(location.line)} 行第 ${String(location.column)} 列）` }),
    });
    return blank;
  }

  // ── 定位承载 entries 的数组在原文中的位置（给条目级错误带行号）──
  const isBareArray = Array.isArray(parsed);
  const entryOffsets = locateEntryOffsets(text, !isBareArray);

  let entriesRaw: unknown;
  let meta: Record<string, unknown> = {};

  if (Array.isArray(parsed)) {
    entriesRaw = parsed;
  } else if (isObject(parsed)) {
    // 整卡形态：优先取 character_book
    const outerBook = isObject(parsed['character_book']) ? (parsed['character_book'] as Record<string, unknown>) : null;
    const dataBook =
      isObject(parsed['data']) && isObject((parsed['data'] as Record<string, unknown>)['character_book'])
        ? ((parsed['data'] as Record<string, unknown>)['character_book'] as Record<string, unknown>)
        : null;
    const book = outerBook ?? dataBook ?? parsed;

    if (book['character_book'] === null) {
      // 显式 `"character_book": null`：合法的"没有世界书"
      issues.push({
        severity: 'warning',
        code: 'no-character-book',
        message: '文件里的 character_book 是 null，将导入一个空世界书',
      });
      return { entries: [], meta: {}, issues, ok: true };
    }

    const split = splitCharacterBook(book);
    entriesRaw = split.entries;
    meta = split.meta;
    if (!split.hasEntriesKey) {
      issues.push({
        severity: 'error',
        code: 'no-entries-key',
        message: 'JSON 里没有 entries 字段，无法识别为世界书',
        hint: '支持三种形态：条目数组、{ "entries": [...] }、或整卡里的 character_book',
      });
      return { entries: [], meta, issues, ok: false };
    }
    if (!Array.isArray(entriesRaw)) {
      issues.push({
        severity: 'error',
        code: 'entries-not-array',
        message: `entries 不是数组（收到 ${entriesRaw === null ? 'null' : typeof entriesRaw}）`,
      });
      return { entries: [], meta, issues, ok: false };
    }
  } else {
    issues.push({
      severity: 'error',
      code: 'bad-root',
      message: `JSON 顶层必须是数组或对象（收到 ${parsed === null ? 'null' : typeof parsed}）`,
    });
    return blank;
  }

  const list = entriesRaw as unknown[];
  const entries: StWorldbookEntry[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const offset = entryOffsets[index];
    const location: Location = offset === undefined ? {} : offsetToLineColumn(text, offset);
    const entry = normalizeEntry(list[index], index, location, issues);
    if (entry !== null) entries.push(entry);
  }

  const hasError = issues.some((issue) => issue.severity === 'error');
  return { entries, meta, issues, ok: !hasError };
}

/** 规范序列化：2 空格缩进 + 固定键顺序（只为"改过的内容"准备，未改动的走原文写回） */
export function renderWorldbookJson(
  entries: readonly StWorldbookEntry[],
  meta: Record<string, unknown> = {},
): string {
  const normalized = entries.map((entry) => {
    const ordered: Record<string, unknown> = {};
    if (typeof entry.id === 'number') ordered['id'] = entry.id;
    ordered['keys'] = entry.keys ?? [];
    if (entry.secondary_keys !== undefined) ordered['secondary_keys'] = entry.secondary_keys;
    ordered['content'] = entry.content ?? '';
    for (const field of ['name', 'comment', 'constant', 'enabled', 'insertion_order', 'position', 'priority', 'case_sensitive', 'selective', 'extensions'] as const) {
      if (entry[field] !== undefined) ordered[field] = entry[field];
    }
    // 未知键追加在末尾，保持原相对顺序
    for (const [key, value] of Object.entries(entry)) {
      if (!(key in ordered) && key !== 'id') ordered[key] = value;
    }
    return ordered;
  });

  const book: Record<string, unknown> = { ...meta, entries: normalized };
  return `${JSON.stringify(book, null, 2)}\n`;
}

// ---------------------------------------------------------------- 统一入口

/** 识别格式：JSON 看首个非空白字符，TXT 看 `@@ENTRY` 标记 */
export function detectWorldbookFormat(text: string): WorldbookFormat | null {
  const stripped = text.replace(/^\uFEFF/, '').trimStart();
  if (stripped === '') return null;
  if (stripped.startsWith('{') || stripped.startsWith('[')) return 'json';
  if (/^@@ENTRY[ \t]/m.test(text)) return 'txt';
  // 没有 JSON 外壳、也没有条目标记：可能是只有说明文字的文件。
  // 判 txt 但会在解析时给出 no-entries 错误（比"猜成 JSON 然后报语法错"更接近真相）。
  return 'txt';
}

/**
 * 导入世界书（自动识别 JSON / TXT）。
 *
 * `ok === false` 时调用方**不得**写回卡片：残缺结果会把"没导入的条目"当成"用户删除"。
 */
export function importWorldbook(
  text: string,
  /** 世界书格式预设的参数（T10.31）；缺省 = v1.0 冻结格式 */
  preset: WorldbookFormatParams = DEFAULT_WORLDBOOK_FORMAT,
): WorldbookImportResult {
  const stripped = text.replace(/^\uFEFF/, '');
  const format = detectWorldbookFormat(stripped);

  if (format === null) {
    return {
      format: null,
      entries: [],
      meta: {},
      issues: [{ severity: 'error', code: 'empty-input', message: '文件是空的，没有可导入的世界书' }],
      ok: false,
      rawText: stripped,
    };
  }

  if (format === 'json') {
    const result = parseWorldbookJson(stripped);
    return { format, entries: result.entries, meta: result.meta, issues: result.issues, ok: result.ok, rawText: stripped };
  }

  const parsed = parseWorldbookTextWith(stripped, preset);
  const issues: WorldbookIoIssue[] = parsed.issues.map((issue) => ({
    severity: issue.severity,
    code: `txt-${issue.code}`,
    message: issue.message,
    ...(issue.line === undefined ? {} : { line: issue.line }),
    ...(issue.entryId === undefined ? {} : { hint: `条目 id ${String(issue.entryId)}` }),
  }));

  // 纯文字文件（没有任何 @@ENTRY）：不能静默导成空世界书 —— 那样用户会以为导进去了
  // 条目开标记按**当前预设**判定：写死 @@ENTRY 会让自定义预设的合法文件被拒
  const entryMarkPrefix = preset.entryOpen.split('{id}')[0]!.trimEnd();
  if (parsed.entries.length === 0 && /^\s*$/.test(stripped) === false && !stripped.includes(entryMarkPrefix)) {
    issues.push({
      severity: 'error',
      code: 'txt-no-entries',
      message: `没有找到任何条目（当前预设的开标记是「${preset.entryOpen}」），无法识别为世界书 TXT`,
      line: 1,
      hint: `条目格式：${preset.entryOpen.replace('{id}', '0')} / 字段行 / ${preset.contentMark} / 正文 / ${preset.entryClose.replace('{id}', '0')}（见 docs/04）`,
    });
  }

  const ok = !issues.some((issue) => issue.severity === 'error');
  return { format, entries: parsed.entries, meta: {}, issues, ok, rawText: stripped };
}

// ---------------------------------------------------------------- 导出

export interface WorldbookExportInput {
  entries: readonly StWorldbookEntry[];
  meta?: Record<string, unknown>;
  format: WorldbookFormat;
  /** 世界书格式预设的参数（T10.31）；缺省 = v1.0 冻结格式 */
  preset?: WorldbookFormatParams;
  /** 导入结果（提供时可按"未改动"走原文写回） */
  source?: WorldbookImportResult | null;
}

export interface WorldbookExportResult {
  text: string;
  /** true = 直接写回原文（未改动，逐字节一致）；false = 走规范序列化 */
  verbatim: boolean;
  /** 走规范序列化时的原因（给界面说明用） */
  reason?: string;
}

/** 深比较（只用于判断"用户是否改过"，键顺序差异不算改动） */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sameEntries(a: readonly StWorldbookEntry[], b: readonly StWorldbookEntry[]): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * 导出世界书。
 *
 * JSON：若与导入时**语义未变**，原样返回 `source.rawText` —— 这条是需求
 * 「JSON → 导入 → 导出 → 逐字节一致」的唯一可靠实现方式。用户文件的缩进、
 * 键顺序、转义风格都是他自己的，重排一遍等于把"打开又保存"变成整篇 diff。
 *
 * TXT：始终按冻结格式重新渲染（docs/04 §3.5 规定条目间固定空一行、
 * 字段按固定顺序），因此"用户手写的排版"会被规范化 —— 这是格式规范本身的要求，
 * 不是丢信息：解析→渲染对**内容**是无损的（`test/worldbook.test.mjs` 已固化）。
 */
export function exportWorldbook(input: WorldbookExportInput): WorldbookExportResult {
  if (input.format === 'txt') {
    return {
      text: renderWorldbookTextWith(input.entries, input.preset ?? DEFAULT_WORLDBOOK_FORMAT),
      verbatim: false,
      reason: 'TXT 按当前世界书预设重新渲染',
    };
  }

  const source = input.source;
  const meta = input.meta ?? {};

  if (source && source.format === 'json') {
    const entriesUnchanged = sameEntries(input.entries, source.entries);
    const metaUnchanged = stableStringify(meta) === stableStringify(source.meta);
    if (entriesUnchanged && metaUnchanged) {
      return { text: source.rawText, verbatim: true };
    }
  }

  return {
    text: renderWorldbookJson(input.entries, meta),
    verbatim: false,
    reason: source ? '条目或周边字段有改动，已按规范重新序列化' : '没有导入来源，按规范序列化',
  };
}

/** 导出成 `StCharacterBook`（给整卡 JSON 用，保持 `raw` 里的周边字段） */
export function toCharacterBook(
  entries: readonly StWorldbookEntry[],
  raw: StCharacterBook | null = null,
): StCharacterBook {
  return { ...(raw ?? {}), entries: [...entries] };
}
