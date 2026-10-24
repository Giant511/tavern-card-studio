/**
 * 世界书 TXT 格式 v1.0（已冻结，规范见 docs/04-worldbook-txt-spec.md）。
 *
 * 冻结决策（三条）：
 * 1. 条目锚点是 `entry.id`；**TXT 中出现重复 id → 报错并给出行号，禁止静默合并**。
 * 2. 正文转义采用「方案 A」：写出时凡匹配 `/^\\*@@/` 的行首加一个 `\`，
 *    解析时凡匹配 `/^\\+@@/` 的行去掉第一个 `\`。因此字面 `\@@END 0` 会被写成 `\\@@END 0`，
 *    round-trip 严格无损（不会出现「字面 \@@ 被吃掉」的边界）。
 * 3. `extensions` 等非人读字段不进 TXT，靠 id 合并保留；**id 冲突时报错，不做猜测性归属**。
 *
 * 合并语义（T2.2 写死）：**导入时 TXT 是世界书的事实源**——
 * TXT 中不存在的条目即视为删除，TXT 中的条目覆盖 11 个可见字段，
 * 其余字段（extensions / 未知键）按 id 从原条目挂回。
 */

import type { StWorldbookEntry } from '../model/sillytavern.js';
import {
  DEFAULT_WORLDBOOK_FORMAT,
  labelForField,
  reverseLabelMap,
  WORLDBOOK_KNOWN_FIELDS,
  type WorldbookFormatParams,
} from './worldbook-preset.js';

/** 会出现在 TXT 头部中的字段（v1.0 写出顺序；实际顺序由格式预设的 fieldOrder 决定） */
export const WORLDBOOK_HEADER_ORDER = [
  'name',
  'keys',
  'secondary_keys',
  'constant',
  'enabled',
  'insertion_order',
  'position',
  'priority',
  'case_sensitive',
  'selective',
  'comment',
] as const;

/** 参与「TXT 覆盖原条目」的可见字段（含正文；id 是锚点不参与覆盖） */
export const WORLDBOOK_VISIBLE_KEYS = [...WORLDBOOK_HEADER_ORDER, 'content'] as const;

const BOOL_FIELDS = new Set<string>(['constant', 'enabled', 'case_sensitive', 'selective']);
const NUMBER_FIELDS = new Set<string>(['insertion_order', 'priority']);
const LIST_FIELDS = new Set<string>(['keys', 'secondary_keys']);
/** 行首可能有 0 个或多个反斜杠，紧跟 `@@`：写出/解析的统一判定式 */
const ESCAPE_TARGET = /^\\*@@/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 标记模板 → 整行正则。`{id}` 处匹配非空白串，其余部分按字面。
 *
 * 空白规则看**模板本身**：
 *   · `@@ENTRY {id}`（占位符前有空格）→ 要求至少一个空白，`@@ENTRY0` 不算条目；
 *   · `条目{id}：`（占位符紧贴文字）→ 允许零个空白，中文格式里"条目4："才是常态。
 *
 * 写死 `[ \t]+` 会让所有中文风格的开标记都必须写成"条目 4："，
 * 而用户的文件从来不是那样写的。
 */
function markerPattern(template: string): RegExp {
  const at = template.indexOf('{id}');
  const prefixRaw = at < 0 ? template : template.slice(0, at);
  const suffix = at < 0 ? '' : template.slice(at + 4);
  const requiresSpace = /\s$/.test(prefixRaw);
  const prefix = prefixRaw.trimEnd();
  const gap = requiresSpace ? '[ \\t]+' : '[ \\t]*';
  return new RegExp(`^${escapeRegExp(prefix)}${gap}(\\S+)${escapeRegExp(suffix)}[ \\t]*$`);
}

/** 无 `{id}` 的标记（正文标记）→ 整行正则 */
function exactLinePattern(mark: string): RegExp {
  return new RegExp(`^${escapeRegExp(mark.trimEnd())}[ \\t]*$`);
}

interface CompiledFormat {
  entryStart: RegExp;
  contentMark: RegExp;
  entryEnd: RegExp;
  labels: Map<string, string>;
  fieldCore: string;
}

/** 预编译一次，避免在逐行循环里反复构造正则与反查表 */
function compileFormat(params: WorldbookFormatParams): CompiledFormat {
  const core = params.fieldSeparator.trim() === '' ? ':' : params.fieldSeparator.trim();
  return {
    entryStart: markerPattern(params.entryOpen),
    contentMark: exactLinePattern(params.contentMark),
    entryEnd: markerPattern(params.entryClose),
    labels: reverseLabelMap(params),
    fieldCore: core,
  };
}


export type WorldbookIssueCode =
  | 'invalid-id'
  | 'duplicate-id'
  | 'missing-content'
  | 'missing-end'
  | 'mismatched-end'
  | 'orphan-marker'
  | 'unknown-field'
  | 'bad-value'
  | 'unexpected-line'
  | 'leading-text'
  // 注意：没有 'no-keys' —— 见 closeDraft 里的注释（语义判据归规则集）
  ;

export interface WorldbookParseIssue {
  severity: 'error' | 'warning';
  code: WorldbookIssueCode;
  message: string;
  /** 1-based 行号 */
  line?: number;
  entryId?: number;
}

export interface ParseWorldbookResult {
  entries: StWorldbookEntry[];
  issues: WorldbookParseIssue[];
  /** 是否存在 error 级问题；存在时禁止调用 mergeWorldbookEntries（残缺条目会被判为删除） */
  ok: boolean;
}

export interface MergeWorldbookOptions {
  /**
   * TXT 中不存在的原条目是否删除；默认 true（TXT 为事实源）。
   * 置 false 时，原表多余条目按原顺序追加到结果末尾。
   */
  dropMissing?: boolean;
}

export interface MergeWorldbookResult {
  entries: StWorldbookEntry[];
  /** TXT 中有、原表中没有的 id（新增条目） */
  added: number[];
  /** 原表有、TXT 中删除的 id（按 TXT 事实源删除，必须让用户可见） */
  removed: number[];
  /** 机器字段（extensions / 未知键）按 id 挂回成功的条目 id */
  preserved: number[];
}

// ---------------------------------------------------------------- 工具

/** 按行拆分但**保留行尾换行符**，用于正文逐字节还原（CRLF 也能原样回来） */
function splitKeepEol(text: string): string[] {
  if (text === '') return [];
  return text.split(/(?<=\n)/);
}

function splitLineEol(line: string): { content: string; eol: string } {
  if (line.endsWith('\r\n')) return { content: line.slice(0, -2), eol: '\r\n' };
  if (line.endsWith('\n')) return { content: line.slice(0, -1), eol: '\n' };
  return { content: line, eol: '' };
}

/** 写出：行首 `@@` / `\@@` / `\\@@` …… 一律再加一个反斜杠 */
export function escapeContentLine(line: string): string {
  return ESCAPE_TARGET.test(line) ? `\\${line}` : line;
}

/** 解析：行首 `\@@` / `\\@@` …… 去掉第一个反斜杠 */
export function unescapeContentLine(line: string): string {
  return ESCAPE_TARGET.test(line) && line.startsWith('\\') ? line.slice(1) : line;
}

function formatCsvList(items: readonly string[], separator: string): string {
  const needle = separator.trim() === '' ? separator : separator.trim();
  return items
    .map((item) => (item.includes(needle) || item.includes('"') ? `"${item.split('"').join('\\"')}"` : item))
    .join(separator);
}

/**
 * 列表字段解析。
 *
 * 分隔符可配置（`listSeparator`），但**引号与转义规则固定** —— 那是 CSV 的语法，
 * 不是格式偏好：允许用户把分隔符改成 `、` 却又要自己发明转义规则，只会让文件不可移植。
 */
function parseCsvList(value: string, separator: string): string[] {
  if (value.trim() === '') return [];
  const sep = separator.trim() === '' ? separator : separator.trim();
  const items: string[] = [];
  let current = '';
  let quoted = false;
  const sepLength = Math.max(1, sep.length);
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quoted) {
      if (char === '\\' && value[index + 1] === '"') {
        current += '"';
        index += 1;
        continue;
      }
      if (char === '"') {
        quoted = false;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (value.startsWith(sep, index)) {
      items.push(current.trim());
      current = '';
      index += sepLength - 1;
      continue;
    }
    current += char;
  }
  items.push(current.trim());
  return items;
}


function formatPosition(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value === 0) return 'before_char';
    if (value === 1) return 'after_char';
    return String(value);
  }
  return null;
}

function parsePosition(value: string): number | string | null {
  const text = value.trim();
  if (text === '') return null;
  if (text === 'before_char') return text;
  if (text === 'after_char') return text;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : text;
}

function parseBool(value: string): boolean | null {
  const text = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  return null;
}

/** 补 id：缺失或非数字时按「当前已用编号 +1」补齐，返回新数组（不改动入参） */
export function ensureEntryIds(entries: readonly StWorldbookEntry[]): {
  entries: StWorldbookEntry[];
  changed: boolean;
} {
  const used = new Set<number>();
  for (const entry of entries) {
    if (typeof entry.id === 'number' && Number.isFinite(entry.id)) used.add(entry.id);
  }
  let next = 0;
  let changed = false;
  const result = entries.map((entry) => {
    if (typeof entry.id === 'number' && Number.isFinite(entry.id)) return entry;
    while (used.has(next)) next += 1;
    used.add(next);
    changed = true;
    return { ...entry, id: next };
  });
  return { entries: result, changed };
}

// ---------------------------------------------------------------- 写出

/** 头部行：空值时不留尾随空格（`secondary_keys:` 而不是 `secondary_keys: `） */
function header(label: string, value: string, fieldSeparator: string): string {
  // v1.0 的 fieldSeparator 是 ": "，空值时要退化成 ":"（不含尾随空格）。
  // 所以空值取 separator 去掉尾部空白后的形态，而不是直接拼 separator。
  return value === '' ? `${label}${fieldSeparator.trimEnd()}` : `${label}${fieldSeparator}${value}`;
}

function renderEntry(entry: StWorldbookEntry, index: number, params: WorldbookFormatParams): string {
  const id = typeof entry.id === 'number' && Number.isFinite(entry.id) ? entry.id : index;
  const idText = String(id);
  const lines: string[] = [params.entryOpen.split('{id}').join(idText)];

  for (const key of params.fieldOrder) {
    const value = (entry as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    const label = labelForField(params, key);
    if (LIST_FIELDS.has(key)) {
      if (Array.isArray(value)) {
        lines.push(header(label, formatCsvList(value.filter((item): item is string => typeof item === 'string'), params.listSeparator), params.fieldSeparator));
      }
      continue;
    }
    if (BOOL_FIELDS.has(key)) {
      if (typeof value === 'boolean') lines.push(header(label, value ? 'true' : 'false', params.fieldSeparator));
      continue;
    }
    if (NUMBER_FIELDS.has(key)) {
      if (typeof value === 'number' && Number.isFinite(value)) lines.push(header(label, String(value), params.fieldSeparator));
      continue;
    }
    if (key === 'position') {
      const text = formatPosition(value);
      if (text !== null) lines.push(header(label, text, params.fieldSeparator));
      continue;
    }
    if (typeof value === 'string') lines.push(header(label, value, params.fieldSeparator));
  }

  const content = typeof entry.content === 'string' ? entry.content : '';
  const close = params.entryClose.split('{id}').join(idText);
  if (content === '') return `${lines.join('\n')}\n${params.contentMark}\n${close}`;

  let body = '';
  for (const rawLine of splitKeepEol(content)) {
    const { content: text, eol } = splitLineEol(rawLine);
    body += `${escapeContentLine(text)}${eol}`;
  }
  // 正文与闭标记之间固定补一个换行（解析端正好去掉这一个），
  // 因此正文自带尾换行时会写成「空行 + 闭标记」，逐字节可还原。
  return `${lines.join('\n')}\n${params.contentMark}\n${body}\n${close}`;
}

/** entries → 世界书 TXT（按格式预设；空数组返回空串） */
export function renderWorldbookTextWith(
  entries: readonly StWorldbookEntry[],
  params: WorldbookFormatParams,
): string {
  if (entries.length === 0) return '';
  const { entries: normalized } = ensureEntryIds(entries);
  return normalized.map((entry, index) => renderEntry(entry, index, params)).join(params.entrySeparator);
}

/** entries → 世界书 TXT（v1.0 冻结格式）。空数组返回空串。 */
export function renderWorldbookText(entries: readonly StWorldbookEntry[]): string {
  return renderWorldbookTextWith(entries, DEFAULT_WORLDBOOK_FORMAT);
}


// ---------------------------------------------------------------- 解析

interface DraftEntry {
  id: number;
  line: number;
  fields: Record<string, unknown>;
  sawContent: boolean;
  bodyRaw: string[];
}

/**
 * 字段行 → `{ field, value }`。
 *
 * `field` 为 null 表示标签不认识（调用方据此报 unknown-field）。
 * 反解顺序：**先按预设的标签映射**，再按字段名本身 —— 这样自定义预设既可以
 * 把 `keys` 写成「关键词」，也可以不改标签直接沿用字段名。
 */
function parseFieldLine(
  line: string,
  fmt: CompiledFormat,
): { field: string | null; label: string; value: string } | null {
  const at = line.indexOf(fmt.fieldCore);
  if (at <= 0) return null;
  const label = line.slice(0, at).trim();
  if (label === '') return null;
  let value = line.slice(at + fmt.fieldCore.length);
  // 与 v1.0 的 `[ \t]?` 一致：吃掉紧跟的一个空白字符，多的留给值本身
  if (value.startsWith(' ') || value.startsWith('\t')) value = value.slice(1);
  const mapped = fmt.labels.get(label);
  const field =
    mapped ?? ((WORLDBOOK_KNOWN_FIELDS as readonly string[]).includes(label) ? label : null);
  return { field, label, value };
}

/**
 * 世界书 TXT → entries（按格式预设）。
 * 所有结构问题都带行号返回；error 级问题意味着「不要拿结果去做合并」。
 */
export function parseWorldbookTextWith(text: string, params: WorldbookFormatParams): ParseWorldbookResult {
  const fmt = compileFormat(params);
  const issues: WorldbookParseIssue[] = [];
  const entries: StWorldbookEntry[] = [];
  const seenIds = new Set<number>();
  let draft: DraftEntry | null = null;
  let leadingText = false;
  /** 缺正文标记被整块剔除的条目（id + 起始行） */
  const droppedMissingContent: { id: number; line: number }[] = [];
  const contentMarkText = params.contentMark;

  const closeDraft = (endLine: number): void => {
    if (!draft) return;
    // 缺 @@CONTENT 的条目整块不参与解析（保留原条目，避免被覆盖成空内容）
    if (!draft.sawContent) {
      droppedMissingContent.push({ id: draft.id, line: draft.line });
      draft = null;
      return;
    }
    const joined = draft.bodyRaw.join('');
    // 去掉紧邻 @@END 之前的那一个换行（写出时补的）
    const content = joined.endsWith('\r\n') ? joined.slice(0, -2) : joined.endsWith('\n') ? joined.slice(0, -1) : joined;
    const entry: Record<string, unknown> = { ...draft.fields, id: draft.id, content };
    if (!('keys' in entry)) entry['keys'] = [];
    entries.push(entry as unknown as StWorldbookEntry);
    // 「keys 为空且非常驻 → 永不触发」**不在这里报**（T10.33 去重铁律）：
    // 它已由 `rules/worldbook-checks.ts` 的默认规则集 `builtin:worldbook-no-trigger` 判定。
    // 解析器只管"这段文本能不能读成条目"，判语义是规则引擎的职责 ——
    // 两处都报会让同一条违规在审计面板里出现两遍。
    draft = null;
  };

  const lines = splitKeepEol(text);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]!;
    const lineNumber = index + 1;
    const { content: line } = splitLineEol(rawLine);

    if (fmt.entryStart.test(line)) {
      if (draft) {
        issues.push({
          severity: 'error',
          code: 'missing-end',
          entryId: draft.id,
          line: lineNumber,
          message: `条目 ${draft.id} 缺少闭标记（在第 ${lineNumber} 行遇到下一个开标记）`,
        });
        closeDraft(lineNumber - 1);
      }
      const raw = fmt.entryStart.exec(line)?.[1] ?? '';
      const id = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
      if (!Number.isFinite(id)) {
        issues.push({
          severity: 'error',
          code: 'invalid-id',
          line: lineNumber,
          message: `条目开标记的 id 必须是非负整数，实际为 "${raw}"`,
        });
        continue;
      }
      if (seenIds.has(id)) {
        issues.push({
          severity: 'error',
          code: 'duplicate-id',
          entryId: id,
          line: lineNumber,
          message: `条目 id ${id} 重复（首次出现于上文，第 ${lineNumber} 行再次声明）；禁止静默合并，请改为唯一 id`,
        });
      }
      seenIds.add(id);
      draft = { id, line: lineNumber, fields: {}, sawContent: false, bodyRaw: [] };
      continue;
    }

    if (fmt.contentMark.test(line)) {
      if (!draft) {
        issues.push({ severity: 'error', code: 'orphan-marker', line: lineNumber, message: `第 ${lineNumber} 行的正文标记出现在任何条目之前` });
        continue;
      }
      draft.sawContent = true;
      continue;
    }

    const endMatch = fmt.entryEnd.exec(line);
    if (endMatch) {
      const rawId = endMatch[1] ?? '';
      const id = /^\d+$/.test(rawId) ? Number(rawId) : Number.NaN;
      if (!draft) {
        issues.push({ severity: 'error', code: 'orphan-marker', line: lineNumber, message: `第 ${lineNumber} 行的闭标记 ${rawId} 没有对应的开标记` });
        continue;
      }
      if (id !== draft.id) {
        // 以开标记配对为准：该行原样留在正文里，继续等待匹配的闭标记
        issues.push({
          severity: 'error',
          code: 'mismatched-end',
          entryId: draft.id,
          line: lineNumber,
          message: `闭标记 ${rawId} 与条目标记 ${draft.id} 的 id 不一致（以开标记为准）`,
        });
        draft.bodyRaw.push(`${line}\n`);
        continue;
      }
      closeDraft(lineNumber);
      continue;
    }

    if (!draft) {
      if (line.trim() !== '' && !leadingText) {
        leadingText = true;
        issues.push({
          severity: 'warning',
          code: 'leading-text',
          line: lineNumber,
          message: `第 ${lineNumber} 行位于第一个条目标记之前，已作为世界书说明文字忽略`,
        });
      }
      continue;
    }

    if (!draft.sawContent) {
      const header = parseFieldLine(line, fmt);
      if (!header) {
        issues.push({
          severity: 'warning',
          code: 'unexpected-line',
          entryId: draft.id,
          line: lineNumber,
          message: `条目 ${draft.id} 在正文标记之前出现非字段行，已忽略：${line.slice(0, 30)}`,
        });
        continue;
      }
      const key = header.field;
      const label = header.label;
      const value = header.value;
      if (key === null) {
        issues.push({
          severity: 'warning',
          code: 'unknown-field',
          entryId: draft.id,
          line: lineNumber,
          message: `条目 ${draft.id} 的字段 "${label}" 不是已知字段，已忽略（如果是标签写法不同，请在当前世界书预设的 labelMap 里登记）`,
        });
        continue;
      }
      if (LIST_FIELDS.has(key)) {
        draft.fields[key] = parseCsvList(value, params.listSeparator);
        continue;
      }
      if (BOOL_FIELDS.has(key)) {
        const bool = parseBool(value);
        if (bool === null) {
          issues.push({ severity: 'warning', code: 'bad-value', entryId: draft.id, line: lineNumber, message: `条目 ${draft.id} 的 ${key} 不是布尔值（${value}），已忽略` });
          continue;
        }
        draft.fields[key] = bool;
        continue;
      }
      if (NUMBER_FIELDS.has(key)) {
        const numeric = Number(value.trim());
        if (value.trim() === '' || !Number.isFinite(numeric)) {
          issues.push({ severity: 'warning', code: 'bad-value', entryId: draft.id, line: lineNumber, message: `条目 ${draft.id} 的 ${key} 不是数字（${value}），已忽略` });
          continue;
        }
        draft.fields[key] = numeric;
        continue;
      }
      if (key === 'position') {
        const parsed = parsePosition(value);
        if (parsed === null) {
          issues.push({ severity: 'warning', code: 'bad-value', entryId: draft.id, line: lineNumber, message: `条目 ${draft.id} 的 position 无法识别（${value}），已忽略` });
          continue;
        }
        draft.fields[key] = parsed;
        continue;
      }
      draft.fields[key] = value;
      continue;
    }

    const { content: bodyText, eol } = splitLineEol(rawLine);
    draft.bodyRaw.push(`${unescapeContentLine(bodyText)}${eol}`);
  }

  if (draft) {
    issues.push({
      severity: 'error',
      code: 'missing-end',
      entryId: draft.id,
      line: lines.length,
      message: `条目 ${draft.id} 缺少闭标记（文件结束仍未闭合）`,
    });
    closeDraft(lines.length);
  }

  // 缺正文标记的条目已在 closeDraft 中整块剔除，这里补 error
  for (const dropped of droppedMissingContent) {
    issues.push({
      severity: 'error',
      code: 'missing-content',
      entryId: dropped.id,
      line: dropped.line,
      message: `条目 ${dropped.id} 缺少正文标记（第 ${dropped.line} 行），整块未参与解析，原条目保持不变`,
    });
  }

  return { entries, issues, ok: issues.every((issue) => issue.severity !== 'error') };
}

/** 世界书 TXT → entries（v1.0 冻结格式）。自定义格式用 `parseWorldbookTextWith`。 */
export function parseWorldbookText(text: string): ParseWorldbookResult {
  return parseWorldbookTextWith(text, DEFAULT_WORLDBOOK_FORMAT);
}

// ---------------------------------------------------------------- 合并

/**
 * 合并：TXT 解析结果为**事实源**。
 * - TXT 中的条目覆盖原条目的 11 个可见字段 + content；
 * - 原条目的其余字段（extensions / 未知键）按 id 挂回；
 * - 原表有、TXT 中没有的 id → 删除（除非 dropMissing=false）；
 * - TXT 有、原表没有的 id → 新增条目。
 *
 * 注意：调用前应确认 `parseWorldbookText().ok === true`，
 * 否则残缺条目会被误判为「用户删除」。
 */
export function mergeWorldbookEntries(
  original: readonly StWorldbookEntry[],
  parsed: readonly StWorldbookEntry[],
  options: MergeWorldbookOptions = {},
): MergeWorldbookResult {
  const dropMissing = options.dropMissing ?? true;
  const visibleKeys = new Set<string>(WORLDBOOK_VISIBLE_KEYS as readonly string[]);

  const originalById = new Map<number, StWorldbookEntry>();
  for (const entry of original) {
    if (typeof entry.id === 'number' && Number.isFinite(entry.id) && !originalById.has(entry.id)) {
      originalById.set(entry.id, entry);
    }
  }

  const result: StWorldbookEntry[] = [];
  const added: number[] = [];
  const removed: number[] = [];
  const preserved: number[] = [];
  const seen = new Set<number>();

  for (const parsedEntry of parsed) {
    const id = parsedEntry.id;
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      result.push({ ...parsedEntry });
      continue;
    }
    seen.add(id);
    const originalEntry = originalById.get(id);
    if (!originalEntry) {
      result.push({ ...parsedEntry });
      added.push(id);
      continue;
    }
    const merged: Record<string, unknown> = { ...originalEntry };
    let carried = false;
    for (const key of Object.keys(originalEntry)) {
      if (key !== 'id' && !visibleKeys.has(key)) carried = true;
    }
    for (const key of WORLDBOOK_VISIBLE_KEYS) {
      const value = (parsedEntry as Record<string, unknown>)[key];
      if (value !== undefined) merged[key] = value;
      else delete merged[key];
    }
    merged['id'] = id;
    if (carried) preserved.push(id);
    result.push(merged as unknown as StWorldbookEntry);
  }

  const leftovers: StWorldbookEntry[] = [];
  for (const [id, entry] of originalById) {
    if (seen.has(id)) continue;
    if (dropMissing) removed.push(id);
    else leftovers.push(entry);
  }
  if (leftovers.length > 0) {
    result.push(
      ...original.filter((entry) => leftovers.includes(entry)),
    );
  }

  return { entries: result, added, removed, preserved };
}
