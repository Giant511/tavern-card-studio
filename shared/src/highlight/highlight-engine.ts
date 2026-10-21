/**
 * 高亮渲染引擎（T3.2）。
 *
 * 输入一段文本 + 编译后的规则集，输出互不重叠的着色区间 `HighlightSpan[]`。
 * 引擎只做「哪段文字属于哪个 scope」，不关心具体用什么 UI 画出来——
 * CodeMirror 用 span 建 Decoration，预览/导出用 `renderInlineHtml` 直接生成 HTML。
 *
 * 冲突消解（与 docs/03 §4 一致，结果必须确定性可复现）：
 *   候选区间排序键 = priority 降序 → 命中长度降序 → 声明顺序升序 → 起始偏移升序；
 *   按序贪心接受，与已接受区间重叠的候选丢弃（区间占位模型）。
 */

import type { BlockId } from '../model/blocks.js';
import type { HighlightScope, HighlightSpan, MatchSpec, ResolvedHighlightRule } from '../rules/highlight-rule.js';

/** 单条规则编译后的形式 */
export interface CompiledHighlightRuleItem {
  id: string;
  scope: string;
  priority: number;
  /** 在文件中的声明顺序，序号小的优先（同优先级同长度时） */
  order: number;
  /** null 表示对所有板块生效 */
  appliesTo: string[] | null;
  matcher: CompiledMatcher;
}

export type CompiledMatcher =
  | { kind: 'regex'; source: string; flags: string; wholeLine: boolean }
  | { kind: 'words'; words: string[]; caseSensitive: boolean; wholeWord: boolean }
  | { kind: 'line-prefix'; prefix: string }
  | { kind: 'delimiter'; open: string; close: string; escape: string | null };

/** 编译后的规则集：正则已预检、规则已排序，可安全复用于多次渲染 */
export interface CompiledHighlightRule {
  id: string;
  name: string;
  version: string;
  theme: ResolvedHighlightRule['theme'];
  editor: ResolvedHighlightRule['editor'];
  scopes: Record<string, HighlightScope>;
  /** 已剔除 enabled:false 的规则，按 priority 降序排好 */
  rules: CompiledHighlightRuleItem[];
  lineage: string[];
}

export interface HighlightContext {
  /** 当前渲染的板块；不属于任何板块（如 ST 原生字段编辑框）时为 null */
  blockId?: BlockId | null;
  /** 当前渲染的 ST 字段名，用于匹配 `field:<name>` 选择器 */
  field?: string | null;
}

const MAX_SPANS = 4000;
const MAX_MATCH_ITERATIONS = 20000;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ensureGlobalFlag(flags: string): string {
  const cleaned = flags.replace(/[^gimsu]/g, '');
  const deduped = [...new Set(cleaned.split(''))].join('');
  return deduped.includes('g') ? deduped : `${deduped}g`;
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

/** 取 index 所在行的边界（不含行尾换行符） */
function lineBounds(text: string, index: number): { start: number; end: number } {
  let start = index;
  while (start > 0 && text[start - 1] !== '\n') start -= 1;
  let end = index;
  while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end += 1;
  return { start, end };
}

function compileMatcher(match: MatchSpec): CompiledMatcher {
  switch (match.type) {
    case 'regex':
      return {
        kind: 'regex',
        source: match.pattern,
        flags: ensureGlobalFlag(match.flags ?? 'g'),
        wholeLine: match.wholeLine === true,
      };
    case 'word-list':
      return {
        kind: 'words',
        words: match.words.filter((word) => word !== ''),
        caseSensitive: match.caseSensitive === true,
        wholeWord: match.wholeWord !== false,
      };
    case 'line-prefix':
      return { kind: 'line-prefix', prefix: match.prefix };
    case 'delimiter-block':
      return { kind: 'delimiter', open: match.open, close: match.close, escape: match.escape ?? null };
    default:
      return { kind: 'words', words: [], caseSensitive: false, wholeWord: false };
  }
}

/**
 * 把解析后的规则集编译成可复用的内部结构。
 * 排序在这里做一次，渲染时只做扫描。
 */
export function compileHighlightRule(rule: ResolvedHighlightRule): CompiledHighlightRule {
  const scopes: Record<string, HighlightScope> = {};
  for (const scope of rule.scopes) scopes[scope.id] = scope;

  const items: CompiledHighlightRuleItem[] = [];
  rule.rules.forEach((item, order) => {
    if (item.enabled === false) return;
    items.push({
      id: item.id,
      scope: item.scope,
      priority: item.priority ?? 0,
      order,
      appliesTo: item.appliesTo === undefined ? null : Array.isArray(item.appliesTo) ? [...item.appliesTo] : [item.appliesTo],
      matcher: compileMatcher(item.match),
    });
  });
  items.sort((a, b) => b.priority - a.priority || a.order - b.order);

  return {
    id: rule.id,
    name: rule.name,
    version: rule.version,
    theme: rule.theme,
    editor: rule.editor,
    scopes,
    rules: items,
    lineage: rule.lineage,
  };
}

/**
 * 规则是否作用于当前渲染上下文。
 * 完全没有上下文信息（blockId 与 field 都是 undefined）时不过滤——调用方没说在哪渲染，
 * 就不该让 appliesTo 把规则全部挡掉。
 */
export function ruleMatchesContext(item: CompiledHighlightRuleItem, context: HighlightContext): boolean {
  if (item.appliesTo === null) return true;
  if (context.blockId === undefined && context.field === undefined) return true;
  const blockId = context.blockId ?? null;
  const field = context.field ?? null;
  for (const selector of item.appliesTo) {
    if (selector === '*') return true;
    if (selector.startsWith('block:')) {
      if (blockId !== null && selector.slice(6) === blockId) return true;
      continue;
    }
    if (selector.startsWith('field:')) {
      const name = selector.slice(6);
      if (field !== null && field === name) return true;
      // 板块上下文里给出等价字段名：性格板块对应 personality，世界书对应 character_book
      if (blockId === 'personality' && name === 'personality') return true;
      if (blockId === 'worldbook' && name === 'character_book') return true;
      if (blockId !== null && blockId !== 'personality' && blockId !== 'worldbook' && name === 'description') return true;
      continue;
    }
  }
  return false;
}

interface Candidate {
  start: number;
  end: number;
  ruleId: string;
  scope: string;
  priority: number;
  order: number;
}

function matchRegex(text: string, matcher: Extract<CompiledMatcher, { kind: 'regex' }>, item: CompiledHighlightRuleItem, out: Candidate[]): void {
  let regex: RegExp;
  try {
    regex = new RegExp(matcher.source, matcher.flags);
  } catch {
    // 编译失败在加载期已拦截；这里静默跳过，保证渲染不抛异常
    return;
  }
  let match: RegExpExecArray | null;
  let guard = 0;
  while ((match = regex.exec(text)) !== null && guard < MAX_MATCH_ITERATIONS) {
    guard += 1;
    let start = match.index;
    let end = start + match[0].length;
    if (matcher.wholeLine) {
      // 以「命中的最后一个字符」所在行为准：像 `^\s*(...){3,}$` 这类正则会因为 `\s*`
      // 吃掉上一行末尾的换行，导致 match.index 落在前一行，按它取行会得到空区间。
      const anchor = end > start ? end - 1 : start;
      const bounds = lineBounds(text, anchor);
      start = bounds.start;
      end = bounds.end;
    }
    if (end > start) {
      out.push({ start, end, ruleId: item.id, scope: item.scope, priority: item.priority, order: item.order });
    }
    if (match[0].length === 0) regex.lastIndex += 1;
  }
}

function matchWords(text: string, matcher: Extract<CompiledMatcher, { kind: 'words' }>, item: CompiledHighlightRuleItem, out: Candidate[]): void {
  for (const word of matcher.words) {
    const regex = new RegExp(escapeRegExp(word), matcher.caseSensitive ? 'g' : 'gi');
    let match: RegExpExecArray | null;
    let guard = 0;
    while ((match = regex.exec(text)) !== null && guard < MAX_MATCH_ITERATIONS) {
      guard += 1;
      const start = match.index;
      const end = start + match[0].length;
      // wholeWord 只对拉丁词有意义；中文相邻字符不是 \w，天然可命中
      const boundaryOk = !matcher.wholeWord || (!isWordChar(text[start - 1]) && !isWordChar(text[end]));
      if (end > start && boundaryOk) {
        out.push({ start, end, ruleId: item.id, scope: item.scope, priority: item.priority, order: item.order });
      }
      if (match[0].length === 0) regex.lastIndex += 1;
    }
  }
}

function matchLinePrefix(text: string, matcher: Extract<CompiledMatcher, { kind: 'line-prefix' }>, item: CompiledHighlightRuleItem, out: Candidate[]): void {
  let index = 0;
  while (index < text.length) {
    const bounds = lineBounds(text, index);
    if (text.startsWith(matcher.prefix, bounds.start)) {
      out.push({
        start: bounds.start,
        end: Math.min(bounds.start + matcher.prefix.length, bounds.end),
        ruleId: item.id,
        scope: item.scope,
        priority: item.priority,
        order: item.order,
      });
    }
    index = bounds.end + 1;
    if (bounds.end >= text.length) break;
  }
}

function matchDelimiter(text: string, matcher: Extract<CompiledMatcher, { kind: 'delimiter' }>, item: CompiledHighlightRuleItem, out: Candidate[]): void {
  let index = 0;
  while (index < text.length) {
    const openAt = text.indexOf(matcher.open, index);
    if (openAt === -1) break;
    const bodyStart = openAt + matcher.open.length;
    let cursor = bodyStart;
    let closeAt = -1;
    while (cursor < text.length) {
      if (matcher.escape && text.startsWith(matcher.escape, cursor) && text.startsWith(matcher.close, cursor + matcher.escape.length)) {
        cursor += matcher.escape.length + matcher.close.length;
        continue;
      }
      if (text.startsWith(matcher.close, cursor)) {
        closeAt = cursor;
        break;
      }
      // 未闭合：只匹配到行尾（docs/03 §3.1）
      if (text[cursor] === '\n') break;
      cursor += 1;
    }
    if (closeAt === -1) {
      const bounds = lineBounds(text, openAt);
      const end = Math.max(bodyStart, bounds.end);
      if (end > openAt) {
        out.push({ start: openAt, end, ruleId: item.id, scope: item.scope, priority: item.priority, order: item.order });
      }
      index = Math.max(bounds.end + 1, openAt + 1);
      continue;
    }
    const end = closeAt + matcher.close.length;
    out.push({ start: openAt, end, ruleId: item.id, scope: item.scope, priority: item.priority, order: item.order });
    index = end;
  }
}

function collectCandidates(text: string, compiled: CompiledHighlightRule, context: HighlightContext): Candidate[] {
  const out: Candidate[] = [];
  if (text === '') return out;
  for (const item of compiled.rules) {
    if (!ruleMatchesContext(item, context)) continue;
    switch (item.matcher.kind) {
      case 'regex':
        matchRegex(text, item.matcher, item, out);
        break;
      case 'words':
        matchWords(text, item.matcher, item, out);
        break;
      case 'line-prefix':
        matchLinePrefix(text, item.matcher, item, out);
        break;
      case 'delimiter':
        matchDelimiter(text, item.matcher, item, out);
        break;
      default:
        break;
    }
  }
  return out;
}

/** 已占用区间按 start 有序插入，便于二分查找空闲片段 */
function insertSorted(list: Candidate[], item: Candidate): void {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (list[mid]!.start < item.start) low = mid + 1;
    else high = mid;
  }
  list.splice(low, 0, item);
}

/**
 * 从 [start, end) 中扣掉已占用的部分，返回剩余空闲片段。
 * 含义：高优先级规则占用的区间不允许被覆盖，但**未被占用的部分仍可着色**。
 * 例如「{{char}} 你来了」这句对话里，{{char}} 归 placeholder，前后两段仍归 dialogue。
 */
function freeParts(start: number, end: number, occupied: Candidate[]): [number, number][] {
  const parts: [number, number][] = [];
  let cursor = start;
  for (const item of occupied) {
    if (item.end <= cursor) continue;
    if (item.start >= end) break;
    if (item.start > cursor) parts.push([cursor, Math.min(item.start, end)]);
    cursor = Math.max(cursor, item.end);
    if (cursor >= end) break;
  }
  if (cursor < end) parts.push([cursor, end]);
  return parts.filter(([from, to]) => to > from);
}

/**
 * 计算着色区间。
 * 返回值按 start 升序、彼此不重叠；零长度匹配不产出（不参与着色）。
 * 候选区间若与已占用区间部分重叠，只保留未占用的部分（可能被切成多段）。
 */
export function computeHighlightSpans(text: string, compiled: CompiledHighlightRule, context: HighlightContext = {}): HighlightSpan[] {
  const candidates = collectCandidates(text, compiled, context);
  candidates.sort(
    (a, b) =>
      b.priority - a.priority ||
      b.end - b.start - (a.end - a.start) ||
      a.order - b.order ||
      a.start - b.start,
  );

  const occupied: Candidate[] = [];
  const accepted: Candidate[] = [];
  for (const candidate of candidates) {
    if (accepted.length >= MAX_SPANS) break;
    for (const [start, end] of freeParts(candidate.start, candidate.end, occupied)) {
      if (accepted.length >= MAX_SPANS) break;
      const piece: Candidate = { ...candidate, start, end };
      accepted.push(piece);
      insertSorted(occupied, piece);
    }
  }
  accepted.sort((a, b) => a.start - b.start || a.end - b.end);
  return accepted.map((item) => ({ start: item.start, end: item.end, scope: item.scope, ruleId: item.ruleId }));
}

export interface HighlightSegment {
  start: number;
  end: number;
  text: string;
  /** 未着色段落为 null */
  scope: string | null;
  ruleId: string | null;
}

/** 把文本切成连续的着色/未着色片段，拼接后与原文逐字相等 */
export function tokenizeHighlight(text: string, compiled: CompiledHighlightRule, context: HighlightContext = {}): HighlightSegment[] {
  const spans = computeHighlightSpans(text, compiled, context);
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      segments.push({ start: cursor, end: span.start, text: text.slice(cursor, span.start), scope: null, ruleId: null });
    }
    segments.push({ start: span.start, end: span.end, text: text.slice(span.start, span.end), scope: span.scope, ruleId: span.ruleId });
    cursor = span.end;
  }
  if (cursor < text.length) {
    segments.push({ start: cursor, end: text.length, text: text.slice(cursor), scope: null, ruleId: null });
  }
  return segments;
}

/** 把样式定义转成 CSS 声明（编辑器与 HTML 预览共用） */
export function scopeCss(scope: HighlightScope): string {
  const parts: string[] = [`color:${scope.color}`];
  if (scope.backgroundColor) parts.push(`background-color:${scope.backgroundColor}`);
  if (scope.bold) parts.push('font-weight:600');
  if (scope.italic) parts.push('font-style:italic');
  if (scope.underline) parts.push('text-decoration:underline');
  if (scope.strikethrough) parts.push('text-decoration:line-through');
  return parts.join(';');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface RenderHtmlOptions {
  /** 换行转成 <br>；默认 false（保留 \n，交给外层 <pre>） */
  breakLines?: boolean;
  /** 外层是否包一层带主题样式的容器；默认 true */
  withWrapper?: boolean;
}

/**
 * 渲染成 HTML（用于规则预览、导出样例、以及测试里的可视化断言）。
 * 每个着色片段带 `class="tcs-hl tcs-hl-<scope>"` 与 `data-rule`，便于定位与调试。
 */
export function renderInlineHtml(
  text: string,
  compiled: CompiledHighlightRule,
  context: HighlightContext = {},
  options: RenderHtmlOptions = {},
): string {
  const segments = tokenizeHighlight(text, compiled, context);
  let html = '';
  for (const segment of segments) {
    const escaped = escapeHtml(segment.text);
    const body = options.breakLines ? escaped.replace(/\r?\n/g, '<br>') : escaped;
    if (segment.scope === null) {
      html += body;
      continue;
    }
    const scope = compiled.scopes[segment.scope];
    const style = scope ? scopeCss(scope) : '';
    html += `<span class="tcs-hl tcs-hl-${escapeHtml(segment.scope)}" data-rule="${escapeHtml(segment.ruleId ?? '')}"${style ? ` style="${style}"` : ''}>${body}</span>`;
  }
  if (options.withWrapper === false) return html;
  const theme = compiled.theme;
  const wrapper = `color:${theme.foreground};background:${theme.background}`;
  return `<div class="tcs-highlight" data-scheme="${escapeHtml(compiled.id)}" style="${wrapper}">${html}</div>`;
}
