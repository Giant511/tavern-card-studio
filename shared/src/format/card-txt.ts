/**
 * 整卡 TXT 的渲染与导入（T2.2）。
 *
 * 与 ST JSON 的分工：
 * - `serializeStCard`（ST JSON 导出）**永不重排**板块；
 * - `renderCardText`（整卡 TXT 导出）按预设 `blockOrder` 排列段落——
 *   因为「预设」本身就是 TXT 排版的完整定义，等价于一次「应用预设」。
 *
 * 导入端（见 docs/06-txt-import-mode.md）：
 * - 解析永远按标题在文件中的出现位置，**不依赖预设顺序**；
 * - 默认 `strict`：六个板块缺任一 → 报错并中止导入，报错含缺失板块名、预期行号、可用别名；
 * - `lenient`：缺失板块按空块填充并在结果中明确警告，空块带 `block.missing = true` 供 UI 标记；
 * - 无法识别的标题行给出「最接近板块」猜测提示（如繁体「世界書」→ 世界书）；
 * - 任何 error 级问题都会让 `ok = false`，`applyCardText` 此时**原样返回原卡片**（绝不静默丢数据）。
 */

import { BLOCK_DEFINITION_MAP, BLOCK_IDS, type BlockId } from '../model/blocks.js';
import { createEmptyCard, type CardBlock, type UnifiedCard } from '../model/unified-card.js';
import { iterateLines, matchHeadingLine, normalizeHeading, parseDescription } from './description.js';
import { headingTextFor, presetAliasTable, type TxtPreset } from './preset.js';
import {
  mergeWorldbookEntries,
  parseWorldbookText,
  renderWorldbookText,
  type MergeWorldbookResult,
  type WorldbookParseIssue,
} from './worldbook.js';

export type CardTextMode = 'strict' | 'lenient';

export interface RenderCardTextOptions {
  /** 空板块是否仍输出标题行（默认 true，保证严格模式可回读） */
  includeEmptyBlocks?: boolean;
  /** 覆盖世界书 TXT；缺省用 card.worldbook.text，再缺省用 entries 渲染 */
  worldbookText?: string;
}

export interface ParseCardTextOptions {
  /** strict（默认）：缺板块即中止；lenient：缺失按空块填充并警告 */
  mode?: CardTextMode;
}

export type CardTextIssueCode =
  | 'missing-block'
  | 'unknown-heading'
  | 'duplicate-heading'
  | 'worldbook-error'
  | 'worldbook-warning';

export interface CardTextIssue {
  severity: 'error' | 'warning';
  code: CardTextIssueCode;
  message: string;
  /** 1-based 行号（缺失板块为「预期位置」） */
  line?: number;
  blockId?: BlockId;
  /** 可用别名 / 猜测提示 */
  hint?: string;
}

export interface UnknownHeading {
  headingText: string;
  line: number;
  suggestion: { blockId: BlockId; alias: string } | null;
}

export interface ParseCardTextResult {
  /** strict 模式且存在 error 时为 null */
  card: UnifiedCard | null;
  issues: CardTextIssue[];
  /** 是否没有任何 error 级问题 */
  ok: boolean;
  /** 文件中缺失的板块（按预设顺序） */
  missing: BlockId[];
  unknownHeadings: UnknownHeading[];
  worldbook: { entries: ReturnType<typeof parseWorldbookText>['entries']; issues: WorldbookParseIssue[] } | null;
}

export interface ApplyCardTextResult {
  card: UnifiedCard;
  issues: CardTextIssue[];
  ok: boolean;
  /** 是否真的写回了卡片；false 表示因 error 保持原卡片不变 */
  changed: boolean;
  merge: MergeWorldbookResult | null;
}

// ---------------------------------------------------------------- 标题猜测

/** 码点级编辑距离（繁简差异如「世界書」/「世界书」距离为 1） */
export function levenshtein(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * 给无法识别的标题行猜测「最接近的板块」。
 * 阈值：编辑距离 ≤ 2 且 ≤ 长度的一半（避免把完全无关的标题也猜一遍）。
 */
export function suggestBlockForHeading(
  headingText: string,
  aliases: Readonly<Record<string, BlockId>>,
): { blockId: BlockId; alias: string; distance: number } | null {
  const target = normalizeHeading(headingText);
  if (target === '') return null;
  const targetChars = Array.from(target);
  const limit = Math.max(1, Math.min(2, Math.ceil(targetChars.length / 2)));
  let best: { blockId: BlockId; alias: string; distance: number } | null = null;
  for (const [alias, blockId] of Object.entries(aliases)) {
    const distance = levenshtein(targetChars, Array.from(alias));
    if (distance > limit) continue;
    if (!best || distance < best.distance) best = { blockId, alias, distance };
  }
  return best;
}

// ---------------------------------------------------------------- 渲染

/** 整卡 → TXT（按预设 blockOrder 排列段落） */
export function renderCardText(card: UnifiedCard, preset: TxtPreset, options: RenderCardTextOptions = {}): string {
  const includeEmpty = options.includeEmptyBlocks ?? true;
  const byId = new Map(card.blocks.map((block) => [block.id, block]));
  const parts: string[] = [];

  for (const id of preset.blockOrder) {
    const block = byId.get(id);
    const heading = headingTextFor(preset, id, block?.anchor?.headingText ?? null);
    let body: string;
    if (id === 'worldbook') {
      body =
        options.worldbookText ??
        (card.worldbook.text !== '' ? card.worldbook.text : renderWorldbookText(card.worldbook.entries));
    } else {
      body = block?.text ?? '';
    }
    if (!includeEmpty && body.trim() === '') continue;
    parts.push(body.trim() === '' ? heading : `${heading}\n${body}`);
  }

  return parts.join(preset.separator);
}

// ---------------------------------------------------------------- 解析

interface Section {
  blockId: BlockId;
  headingText: string;
  /** 1-based 标题行号 */
  line: number;
  /** 标题行起始偏移 */
  start: number;
  /** 正文结束偏移（已裁掉尾部空白） */
  end: number;
  body: string;
}

interface ScanResult {
  sections: Section[];
  duplicates: { blockId: BlockId; line: number }[];
  unknownHeadings: UnknownHeading[];
  /** 文件总行数 */
  lineCount: number;
}

function scanSections(text: string, aliases: Readonly<Record<string, BlockId>>): ScanResult {
  const lines = [...iterateLines(text)];
  const marks: { line: number; index: number; start: number; nextStart: number; blockId: BlockId; headingText: string }[] = [];
  const duplicates: { blockId: BlockId; line: number }[] = [];
  const unknownHeadings: UnknownHeading[] = [];
  const seen = new Set<BlockId>();

  lines.forEach((line, index) => {
    const headingText = matchHeadingLine(line.text);
    if (!headingText) return;
    const blockId = aliases[normalizeHeading(headingText)];
    const lineNumber = index + 1;
    if (!blockId) {
      unknownHeadings.push({
        headingText,
        line: lineNumber,
        suggestion: suggestBlockForHeading(headingText, aliases),
      });
      return;
    }
    if (seen.has(blockId)) {
      duplicates.push({ blockId, line: lineNumber });
      return;
    }
    seen.add(blockId);
    marks.push({ line: lineNumber, index, start: line.start, nextStart: line.nextStart, blockId, headingText });
  });

  const sections: Section[] = marks.map((mark, position) => {
    const bodyStart = mark.nextStart;
    const bodyEnd = position + 1 < marks.length ? marks[position + 1]!.start : text.length;
    let start = bodyStart;
    while (start < bodyEnd && /\s/.test(text[start]!)) start += 1;
    let end = bodyEnd;
    while (end > start && /\s/.test(text[end - 1]!)) end -= 1;
    return {
      blockId: mark.blockId,
      headingText: mark.headingText,
      line: mark.line,
      start: mark.start,
      end,
      body: text.slice(start, end),
    };
  });

  return { sections, duplicates, unknownHeadings, lineCount: lines.length };
}

function emptyTextBlock(id: BlockId, missing: boolean): CardBlock {
  return { id, text: '', raw: '', dirty: false, anchor: null, missing };
}

function aliasHint(preset: TxtPreset, blockId: BlockId): string {
  const aliases = preset.headings[blockId]?.aliases ?? [BLOCK_DEFINITION_MAP[blockId].defaultHeading];
  return aliases.join(' / ');
}

/**
 * TXT → 统一模型。
 * description 侧的处理：把文件中所有「属于 description 的段落」按其**原始顺序**拼接成
 * `description.raw`（每段内部的字节逐字保留），再交给 `parseDescription` 取锚点；
 * 性格、世界书段落不进入 description（性格写回 `personality` 字段）。
 */
export function parseCardText(text: string, preset: TxtPreset, options: ParseCardTextOptions = {}): ParseCardTextResult {
  const mode = options.mode ?? 'strict';
  const aliases = presetAliasTable(preset);
  const scan = scanSections(text, aliases);
  const issues: CardTextIssue[] = [];

  const byBlock = new Map<BlockId, Section>();
  for (const section of scan.sections) byBlock.set(section.blockId, section);

  // ---- 未识别 / 重复标题 ----
  for (const unknown of scan.unknownHeadings) {
    const label = unknown.suggestion ? BLOCK_DEFINITION_MAP[unknown.suggestion.blockId].label : null;
    issues.push({
      severity: 'warning',
      code: 'unknown-heading',
      line: unknown.line,
      message: `第 ${unknown.line} 行的标题「${unknown.headingText}」无法识别为任何板块`,
      hint: unknown.suggestion
        ? `是否想写「${unknown.suggestion.alias}」（${label}）？`
        : '该行内容将归入上一板块正文；可用标题见预设别名表',
    });
  }
  for (const duplicate of scan.duplicates) {
    issues.push({
      severity: 'warning',
      code: 'duplicate-heading',
      line: duplicate.line,
      blockId: duplicate.blockId,
      message: `第 ${duplicate.line} 行重复出现「${BLOCK_DEFINITION_MAP[duplicate.blockId].label}」标题，该段内容已归入首次出现的板块`,
    });
  }

  // ---- 缺失板块 ----
  const orderIndex = new Map<BlockId, number>(preset.blockOrder.map((id, index) => [id, index]));
  const missing = BLOCK_IDS.filter((id) => !byBlock.has(id));
  for (const blockId of missing) {
    const presetIndex = orderIndex.get(blockId) ?? BLOCK_IDS.indexOf(blockId);
    let expectedLine = 1;
    for (const section of scan.sections) {
      const sectionIndex = orderIndex.get(section.blockId) ?? 0;
      if (sectionIndex < presetIndex) expectedLine = section.line + section.body.split('\n').length + 1;
    }
    issues.push({
      severity: mode === 'strict' ? 'error' : 'warning',
      code: 'missing-block',
      line: expectedLine,
      blockId,
      message:
        mode === 'strict'
          ? `缺少板块「${BLOCK_DEFINITION_MAP[blockId].label}」（预期位置：第 ${expectedLine} 行附近），导入已中止`
          : `缺少板块「${BLOCK_DEFINITION_MAP[blockId].label}」（预期位置：第 ${expectedLine} 行附近），已按空块处理`,
      hint: `可用标题：${aliasHint(preset, blockId)}`,
    });
  }

  // ---- 世界书 ----
  const worldbookSection = byBlock.get('worldbook');
  const worldbookParsed = parseWorldbookText(worldbookSection?.body ?? '');
  for (const issue of worldbookParsed.issues) {
    issues.push({
      severity: issue.severity,
      code: issue.severity === 'error' ? 'worldbook-error' : 'worldbook-warning',
      line: issue.line,
      message: issue.message,
    });
  }

  // ---- description ----
  const descriptionSections = scan.sections
    .filter((section) => section.blockId !== 'worldbook' && section.blockId !== 'personality')
    .sort((a, b) => a.start - b.start);
  const descriptionRaw = descriptionSections
    .map((section) => text.slice(section.start, section.end))
    .join(preset.separator);
  const parsedDescription = parseDescription(descriptionRaw, { aliases, separator: preset.separator });
  const parsedById = new Map(parsedDescription.blocks.map((block) => [block.id, block]));

  const buildCard = (): UnifiedCard => {
    const card = createEmptyCard();
    const personalitySection = byBlock.get('personality');
    const personalityText = personalitySection?.body ?? '';

    card.blocks = BLOCK_IDS.filter((id) => id !== 'worldbook').map((id) => {
      if (id === 'personality') {
        return {
          id: 'personality' as BlockId,
          text: personalityText,
          raw: personalityText,
          dirty: false,
          anchor: {
            field: 'personality' as const,
            headingText: personalitySection?.headingText ?? null,
            headingSpan: null,
            bodySpan: null,
          },
          missing: !personalitySection,
        };
      }
      const parsed = parsedById.get(id);
      if (parsed && parsed.anchor) return { ...parsed, missing: false };
      return emptyTextBlock(id, true);
    });

    card.description = {
      raw: descriptionRaw,
      separator: preset.separator,
      structured: parsedDescription.structured,
      preface: parsedDescription.preface,
    };
    card.worldbook = {
      entries: worldbookParsed.entries,
      text: renderWorldbookText(worldbookParsed.entries),
      dirty: false,
      raw: null,
    };
    return card;
  };

  const hasError = issues.some((issue) => issue.severity === 'error');
  if (mode === 'strict') {
    return {
      card: hasError ? null : buildCard(),
      issues,
      ok: !hasError,
      missing,
      unknownHeadings: scan.unknownHeadings,
      worldbook: { entries: worldbookParsed.entries, issues: worldbookParsed.issues },
    };
  }

  return {
    card: buildCard(),
    issues,
    ok: !hasError,
    missing,
    unknownHeadings: scan.unknownHeadings,
    worldbook: { entries: worldbookParsed.entries, issues: worldbookParsed.issues },
  };
}

/**
 * 把 TXT 编辑结果写回既有卡片（编辑区「保存」走这条路径）。
 * 关键保证：**存在 error 时原样返回原卡片**，绝不静默丢弃世界书条目或板块内容。
 * 世界书按「TXT 为事实源」合并，`extensions` 等机器字段按 id 挂回。
 */
export function applyCardText(card: UnifiedCard, text: string, preset: TxtPreset, options: ParseCardTextOptions = {}): ApplyCardTextResult {
  const result = parseCardText(text, preset, options);
  if (!result.ok || !result.card) {
    return { card, issues: result.issues, ok: result.ok, changed: false, merge: null };
  }

  const next: UnifiedCard = structuredClone(card);
  next.blocks = result.card.blocks;
  next.description = result.card.description;
  const merge = mergeWorldbookEntries(card.worldbook.entries, result.card.worldbook.entries);
  next.worldbook = {
    entries: merge.entries,
    text: renderWorldbookText(merge.entries),
    dirty: false,
    raw: card.worldbook.raw,
  };
  return { card: next, issues: result.issues, ok: true, changed: true, merge };
}
