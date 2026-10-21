/**
 * description 字段的分块解析与拼装（T1.2 的基础设施）。
 *
 * 设计要点：解析不重排、不规范化原文，只记录「标题行」与「正文」的区间；
 * 拼装时对原文做「区间替换 + 定点插入」，未改动的字节逐字保留。
 */

import { BLOCK_DEFINITION_MAP, DESCRIPTION_BLOCK_IDS, type BlockId } from '../model/blocks.js';
import type { CardBlock, DescriptionDocument } from '../model/unified-card.js';
import { skipWhitespaceBackward, skipWhitespaceForward } from '../text/count.js';

/** 四个写入 description 的板块 */
const DESCRIPTION_IDS = DESCRIPTION_BLOCK_IDS;

/** 板块标题别名表（标题归一化后比对，允许用户改文案） */
const HEADING_ALIASES: Readonly<Record<string, BlockId>> = {
  基本信息: 'basic',
  基本资料: 'basic',
  基础信息: 'basic',
  角色信息: 'basic',
  角色档案: 'basic',
  档案: 'basic',
  信息: 'basic',
  性格: 'personality',
  性格设定: 'personality',
  个性: 'personality',
  性格特征: 'personality',
  personality: 'personality',
  其他设定: 'settings',
  其它设定: 'settings',
  其他: 'settings',
  其他信息: 'settings',
  输出设定: 'settings',
  行为准则: 'settings',
  特殊设定: 'special',
  特别设定: 'special',
  特殊: 'special',
  特殊规则: 'special',
  用户相关设定: 'user',
  用户设定: 'user',
  玩家设定: 'user',
  用户相关: 'user',
  用户信息: 'user',
  user: 'user',
};

interface HeadingPattern {
  /** 从整行文本中提取标题文字 */
  extract: (line: string) => string | null;
}

const HEADING_PATTERNS: readonly HeadingPattern[] = [
  {
    // 【基本信息】
    extract: (line) => {
      const match = /^\s*【([^】\n]{1,40})】\s*$/.exec(line);
      return match?.[1]?.trim() ?? null;
    },
  },
  {
    // ## 基本信息 / ### 性格
    extract: (line) => {
      const match = /^\s*#{1,6}\s+(.{1,40}?)\s*#*\s*$/.exec(line);
      return match?.[1]?.trim() ?? null;
    },
  },
  {
    // [基本信息]
    extract: (line) => {
      const match = /^\s*\[([^\]\n]{1,40})\]\s*$/.exec(line);
      return match?.[1]?.trim() ?? null;
    },
  },
  {
    // **基本信息**
    extract: (line) => {
      const match = /^\s*\*\*([^*\n]{1,40})\*\*\s*$/.exec(line);
      return match?.[1]?.trim() ?? null;
    },
  },
];

export function normalizeHeading(text: string): string {
  return text
    .replace(/[\s\u3000]+/gu, '')
    .replace(/[:：]+$/u, '')
    .toLowerCase();
}

/** 把标题文字解析成板块 id；无法识别返回 null（视为普通正文） */
export function resolveHeadingBlock(
  headingText: string,
  aliases?: Readonly<Record<string, BlockId>>,
): BlockId | null {
  const key = normalizeHeading(headingText);
  const direct = aliases ? aliases[key] : HEADING_ALIASES[key];
  if (direct && DESCRIPTION_IDS.includes(direct)) return direct;
  return null;
}

/** 把预设里的 alias 数组转成「归一化标题 → 板块」查询表 */
export function buildAliasTable(
  aliases: Partial<Record<BlockId, readonly string[]>>,
): Record<string, BlockId> {
  const table: Record<string, BlockId> = {};
  for (const [blockId, list] of Object.entries(aliases)) {
    if (!list) continue;
    for (const alias of list) table[normalizeHeading(alias)] = blockId as BlockId;
  }
  return table;
}

export interface LineInfo {
  start: number;
  /** 不含换行符的内容结束位置 */
  contentEnd: number;
  /** 下一行起始位置（含换行符） */
  nextStart: number;
  text: string;
}

export function* iterateLines(text: string): Generator<LineInfo> {
  let start = 0;
  while (start <= text.length) {
    let cursor = start;
    while (cursor < text.length && text[cursor] !== '\n' && text[cursor] !== '\r') cursor += 1;
    const contentEnd = cursor;
    if (cursor < text.length) {
      if (text[cursor] === '\r' && text[cursor + 1] === '\n') cursor += 2;
      else cursor += 1;
    }
    yield { start, contentEnd, nextStart: cursor, text: text.slice(start, contentEnd) };
    if (cursor >= text.length) break;
    start = cursor;
  }
}

export function matchHeadingLine(line: string): string | null {
  for (const pattern of HEADING_PATTERNS) {
    const heading = pattern.extract(line);
    if (heading) return heading;
  }
  return null;
}

/**
 * 取分隔符中唯一的一行文字（如 `\n\n---\n\n` → `---`）；纯空白分隔符返回 null。
 * 只有单行分隔符才需要剔除，多行分隔符按原样留在 gap 里即可。
 */
function separatorToken(separator: string): string | null {
  const lines = separator
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.length === 1 ? lines[0]! : null;
}

/** 去掉正文末尾的分隔符行（若存在），返回新的正文结束偏移 */
function stripTrailingSeparatorLine(raw: string, from: number, end: number, token: string): number {
  let lastNonEmpty: LineInfo | null = null;
  for (const line of iterateLines(raw.slice(0, end))) {
    if (line.start < from) continue;
    if (line.text.trim() !== '') lastNonEmpty = line;
  }
  if (!lastNonEmpty || lastNonEmpty.text.trim() !== token) return end;
  if (lastNonEmpty.start <= from) return end;
  return skipWhitespaceBackward(raw, from, lastNonEmpty.start);
}

export interface DescriptionParseResult {
  /** 四个 description 板块（按固定顺序，缺失板块 text 为空、anchor 为 null） */
  blocks: CardBlock[];
  structured: boolean;
  preface: string;
  separator: string;
}

export interface DescriptionParseOptions {
  /** 标题别名表（已归一化）；来自预设格式，缺省用内置别名表 */
  aliases?: Readonly<Record<string, BlockId>>;
  /**
   * 当前预设的板块分隔符。用于把「分隔符行」（如单独一行 `---`）从板块正文里剔除，
   * 否则用同一预设再次拼装时会重复写出分隔符。缺省不剔除。
   */
  separator?: string;
}

/** 把预设的板块顺序裁剪成「仅 description 板块」的完整顺序（缺失项按默认顺序补齐） */
export function resolveDescriptionOrder(order?: readonly BlockId[]): readonly BlockId[] {
  if (!order) return DESCRIPTION_IDS;
  const result = order.filter((id) => DESCRIPTION_IDS.includes(id));
  for (const id of DESCRIPTION_IDS) {
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

function emptyBlock(id: BlockId): CardBlock {
  return { id, text: '', raw: '', dirty: false, anchor: null };
}

function detectSeparator(raw: string, gaps: string[]): string {
  const counter = new Map<string, number>();
  for (const gap of gaps) {
    const normalized = gap.replace(/\r\n/g, '\n');
    if (normalized.trim() === '' && normalized.includes('\n')) {
      const key = normalized.length > 4 ? '\n\n' : normalized;
      counter.set(key, (counter.get(key) ?? 0) + 1);
    }
  }
  let best = '\n\n';
  let bestCount = 0;
  for (const [key, count] of counter) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best === '\n' ? '\n' : '\n\n';
}

/**
 * 解析 description 文本。
 * 重复标题（同一板块出现两次）不会开启新板块——第二次标题连同内容留在上一板块正文内，
 * 这样既不丢内容，也不会让用户看到两个同名板块。
 *
 * 传入 `aliases`（来自预设格式）时，只认该表的别名；否则用内置别名表。
 * 无论哪种口径，解析都不依赖标题顺序，也不重排原文——这是「非标准顺序也能无损回写」的前提。
 */
export function parseDescription(raw: string, options: DescriptionParseOptions = {}): DescriptionParseResult {
  interface Candidate {
    blockId: BlockId;
    headingText: string;
    lineStart: number;
    lineEnd: number;
    nextStart: number;
  }

  const aliases = options.aliases;
  const candidates: Candidate[] = [];
  const seen = new Set<BlockId>();

  for (const line of iterateLines(raw)) {
    const headingText = matchHeadingLine(line.text);
    if (!headingText) continue;
    const blockId = resolveHeadingBlock(headingText, aliases);
    if (!blockId || seen.has(blockId)) continue;
    seen.add(blockId);
    candidates.push({
      blockId,
      headingText,
      lineStart: line.start,
      lineEnd: line.contentEnd,
      nextStart: line.nextStart,
    });
  }

  if (candidates.length === 0) {
    const start = skipWhitespaceForward(raw, 0);
    const end = skipWhitespaceBackward(raw, start, raw.length);
    const text = raw.slice(start, end);
    const basic: CardBlock = {
      id: 'basic',
      text,
      raw: text,
      dirty: false,
      anchor: {
        field: 'description',
        headingText: null,
        headingSpan: null,
        bodySpan: { start, end: start > end ? start : end },
      },
    };
    return {
      blocks: DESCRIPTION_IDS.map((id) => (id === 'basic' ? basic : emptyBlock(id))),
      structured: false,
      preface: raw.slice(0, start),
      separator: '\n\n',
    };
  }

  const byId = new Map<BlockId, CardBlock>();
  const gaps: string[] = [];
  const sepToken = options.separator ? separatorToken(options.separator) : null;

  candidates.forEach((candidate, index) => {
    const bodyStart = candidate.nextStart;
    const bodyEnd = index + 1 < candidates.length ? candidates[index + 1]!.lineStart : raw.length;
    const start = skipWhitespaceForward(raw, bodyStart, bodyEnd);
    let end = skipWhitespaceBackward(raw, bodyStart, bodyEnd);
    if (sepToken) end = stripTrailingSeparatorLine(raw, bodyStart, end, sepToken);
    let realStart = start;
    if (end < start) {
      realStart = bodyStart;
      end = bodyEnd;
    }
    const text = raw.slice(realStart, end);
    byId.set(candidate.blockId, {
      id: candidate.blockId,
      text,
      raw: text,
      dirty: false,
      anchor: {
        field: 'description',
        headingText: candidate.headingText,
        headingSpan: { start: candidate.lineStart, end: candidate.nextStart },
        bodySpan: { start: realStart, end },
      },
    });
    gaps.push(raw.slice(end, bodyEnd));
  });

  return {
    blocks: DESCRIPTION_IDS.map((id) => byId.get(id) ?? emptyBlock(id)),
    structured: true,
    preface: raw.slice(0, candidates[0]!.lineStart),
    separator: detectSeparator(raw, gaps),
  };
}

/** 标题行生成：默认预设使用【标题】 */
export function defaultHeadingFor(blockId: BlockId): string {
  return `【${BLOCK_DEFINITION_MAP[blockId].defaultHeading}】`;
}

export interface AssembleOptions {
  /** 新建板块时使用的标题生成函数，默认【标题】 */
  heading?: (blockId: BlockId) => string;
  /**
   * 板块顺序（来自预设格式，可含 worldbook，worldbook 会被忽略）。
   * 仅决定「新建卡片拼装顺序」与「新增板块插入位置」，解析出的原文顺序永不主动重排。
   */
  order?: readonly BlockId[];
}

/**
 * 把板块文本拼回 description。
 * - 尚无原文（新建卡片）：按 order 用 separator 拼接；
 * - 已有原文：只替换 dirty 板块的正文区间，新板块按 order 定点插入，其余字节原样保留。
 */
export function assembleDescription(
  blocks: CardBlock[],
  doc: DescriptionDocument,
  options: AssembleOptions = {},
): string {
  const heading = options.heading ?? defaultHeadingFor;
  const order = resolveDescriptionOrder(options.order);
  const orderIndex = (id: BlockId): number => order.indexOf(id);

  const descBlocks = blocks
    .filter((block) => DESCRIPTION_IDS.includes(block.id))
    .sort((a, b) => orderIndex(a.id) - orderIndex(b.id));

  if (doc.raw === '') {
    return descBlocks
      .filter((block) => block.text.trim() !== '')
      .map((block) => `${heading(block.id)}\n${block.text}`)
      .join(doc.separator);
  }

  interface Edit {
    start: number;
    end: number;
    text: string;
  }
  const edits: Edit[] = [];

  for (const block of descBlocks) {
    const anchor = block.anchor;
    if (!anchor || anchor.field !== 'description' || !anchor.bodySpan) continue;
    if (!block.dirty) continue;
    edits.push({ start: anchor.bodySpan.start, end: anchor.bodySpan.end, text: block.text });
  }

  const anchored = descBlocks
    .filter((block) => block.anchor?.field === 'description' && block.anchor.headingSpan)
    .sort((a, b) => (a.anchor!.headingSpan!.start - b.anchor!.headingSpan!.start));

  for (const block of descBlocks) {
    if (block.anchor) continue;
    if (block.text.trim() === '') continue;
    const payload = `${heading(block.id)}\n${block.text}`;
    const next = anchored.find((item) => orderIndex(item.id) > orderIndex(block.id));
    if (next?.anchor?.headingSpan) {
      edits.push({ start: next.anchor.headingSpan.start, end: next.anchor.headingSpan.start, text: `${payload}${doc.separator}` });
      continue;
    }
    const trimmedEnd = skipWhitespaceBackward(doc.raw, 0, doc.raw.length);
    if (trimmedEnd === doc.raw.length) {
      edits.push({ start: doc.raw.length, end: doc.raw.length, text: `${doc.separator}${payload}` });
    } else {
      edits.push({ start: trimmedEnd, end: trimmedEnd, text: `${doc.separator}${payload}` });
    }
  }

  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let output = doc.raw;
  for (const edit of edits) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  return output;
}
