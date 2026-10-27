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
import { isFieldBlock } from './field-blocks.js';
import { parseGreetings, type GreetingFormatParams } from './greeting-preset.js';
import {
  headingTextFor,
  presetAliasTable,
  presetGreetingFormat,
  separatorToken,
  trimTrailingSeparatorText,
  type TxtPreset,
} from './preset.js';
import {
  DEFAULT_WORLDBOOK_FORMAT,
  type WorldbookFormatParams,
} from './worldbook-preset.js';
import {
  mergeWorldbookEntries,
  parseWorldbookTextWith,
  renderWorldbookText,
  type MergeWorldbookResult,
  type WorldbookParseIssue,
} from './worldbook.js';

export type CardTextMode = 'strict' | 'lenient';

/**
 * 未识别内容的分隔符（v0.1.2 / F14 之后冻结，见 docs/06 §7）。
 *
 * `preserveUnrecognized` 模式下，所有未识别片段被拼进【其他设定】时，在它们前面
 * 插这一行（前后各一空行）。它有三个作用：
 *   1. 让人一眼看出"从这行往下不是原【其他设定】的内容，是我没认出来的东西"；
 *   2. 让机制**幂等**：再次导入时识别到这行，就知道下面已经是保全过的区域，
 *      于是不再补一个分隔符（否则每导一次多一行，几次之后文件里全是分隔符）；
 *   3. 让"有没有未识别内容"这件事在导出结果里**可被机器判定** —— UI 与测试
 *      都不必再猜。
 *
 * 等号的数量刻意固定（12 个），不随标题长度变化：它是格式的一部分，不是排版。
 */
export const UNRECOGNIZED_SEPARATOR_LINE =
  '════════════ 以下内容为未识别的板块数据，请自行排版 ════════════';

export interface RenderCardTextOptions {
  /** 空板块是否仍输出标题行（默认 true，保证严格模式可回读） */
  includeEmptyBlocks?: boolean;
  /** 覆盖世界书 TXT；缺省用 card.worldbook.text，再缺省用 entries 渲染 */
  worldbookText?: string;
}

export interface ParseCardTextOptions {
  /** strict（默认）：缺板块即中止；lenient：缺失按空块填充并警告 */
  mode?: CardTextMode;
  /**
   * 「初始场景」多条开场白的分隔格式（v0.1.3 / 追加项一）。
   * 缺省按 TXT 预设的 `greeting.separator`，再缺省用冻结默认值。
   */
  greetingFormat?: GreetingFormatParams;
  /**
   * **全量保全**（v0.1.2，见 docs/06 §7）。默认 `false`，TXT 导入路径显式开启。
   *
   * 开启后 `mode` 不再起作用（两种模式行为一致），因为保全机制优先于"缺板块"语义：
   *   · 一个板块都没识别出来 → 原文**逐字节**整体放进【其他设定】；
   *   · 识别出至少一个 → 未识别的片段按原序拼进【其他设定】已识别内容的下方，
   *     前面插一行 {@link UNRECOGNIZED_SEPARATOR_LINE}；
   *   · 不再产出 `missing-block` 问题，也不给板块打 `missing` 标记 ——
   *     内容没丢，"缺失"这个词在这里是错的。
   *
   * 为什么用开关而不是直接改默认：`applyCardText` 同时服务于"编辑器保存"
   * （文本是我们自己渲染出来的，必然六个标题齐全）与"TXT 导入"（外来文本）。
   * 前者一旦也走保全，用户手删一个标题再保存就会被自动补一段分隔符进【其他设定】——
   * 那不是保全，那是自作主张。
   */
  preserveUnrecognized?: boolean;
  /**
   * 世界书 TXT 的格式（v0.1.5 / G4）。
   *
   * 不传就用冻结的 `@@ENTRY` 格式 —— 那会让自定义格式的 TXT 卡在导入时
   * 世界书段解析失败（`【条目N：…】` 这类写法一条都认不出）。
   * 客户端导入 TXT 卡时应传当前选中的世界书预设。
   */
  worldbookFormat?: WorldbookFormatParams;
}

export type CardTextIssueCode =
  | 'missing-block'
  | 'unknown-heading'
  | 'duplicate-heading'
  | 'worldbook-error'
  | 'worldbook-warning'
  /** 保全机制：原文整体放进【其他设定】（0 板块识别） */
  | 'unrecognized-whole'
  /** 保全机制：N 段未识别内容已放进【其他设定】 */
  | 'unrecognized-preserved';

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

/**
 * 保全机制的结论（`preserveUnrecognized` 开启时才有意义）。
 *
 * UI 靠它生成状态栏那句话（"识别到 N 个板块，M 段原文已放入【其他设定】"），
 * 测试靠它断言"到底保了几段、是不是整体放置"。
 */
export interface PreservedInfo {
  /** 是否真的往【其他设定】里放了东西 */
  applied: boolean;
  /** 0 板块识别 → 原文整体放置 */
  wholeText: boolean;
  /** 未识别片段数（`wholeText` 时为 0） */
  fragments: number;
  /** 识别出的板块数（不含世界书；世界书走既有结构化路径） */
  blockCount: number;
  /** 这些片段是从哪个行号开始的（1-based，供 UI 定位） */
  fragmentLines: number[];
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
  worldbook: { entries: ReturnType<typeof parseWorldbookTextWith>['entries']; issues: WorldbookParseIssue[] } | null;
  /** 保全结论；未开启保全时为 null */
  preserved: PreservedInfo | null;
}

export interface ApplyCardTextResult {
  card: UnifiedCard;
  issues: CardTextIssue[];
  ok: boolean;
  /** 是否真的写回了卡片；false 表示因 error 保持原卡片不变 */
  changed: boolean;
  merge: MergeWorldbookResult | null;
  /** 保全结论（未开启保全时为 null） */
  preserved: PreservedInfo | null;
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
      /*
       * 世界书段的内容来源优先级（v0.1.5 / G3-3 复查后确认，保持原语义）：
       *   ① 显式传入的 `worldbookText`
       *   ② `card.worldbook.text`（编辑器里正在编辑的原文）
       *   ③ 从 `entries` 渲染出的 `@@ENTRY` 段
       *
       * ②在③之前是刻意的：用户在面板里改了文本但还没成功解析时，
       * TXT 至少要把他写的东西写出来 —— 而不是悄悄换成"上一次解析成功的条目"。
       */
      body =
        options.worldbookText ??
        (card.worldbook.text !== '' ? card.worldbook.text : renderWorldbookText(card.worldbook.entries));
    } else {
      body = block?.text ?? '';
    }
    if (!includeEmpty && body.trim() === '') continue;

    /*
     * `worldbook.includeHeading`（v0.1.5 / G3-3）。
     *
     * 这个参数原来**只被 schema 校验、从未被渲染读取** —— README §4.3 把它写成
     * 一个生效的开关，实际设成 false 也照样输出 `【世界书】`。属于"文档承诺了
     * 但没实现"，现已接上。
     *
     * 只对世界书段生效（README 的字段名就是 `worldbook.includeHeading`）：
     * 其它板块的标题是**解析锚点**，去掉就再也读不回来了，所以那里的开关
     * 语义不同，不做成通用能力。
     */
    const skipHeading = id === 'worldbook' && preset.worldbook?.includeHeading === false;
    if (skipHeading) {
      if (body.trim() !== '') parts.push(body);
      continue;
    }
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
  /**
   * 标题行之后一行的起始偏移（正文起点候选）。
   * 保全机制要"标题行原样保留、只换正文"，需要这个边界。
   */
  nextStart: number;
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
  /**
   * **所有**标题行（认得的 + 不认得的）按出现顺序。
   *
   * 保全机制需要它：未识别片段是"标题行 + 它的正文"，边界必须对两种标题一视同仁，
   * 否则一个不认得的 `## 招式` 会被吞进上一个板块的正文里，看起来"没丢"，
   * 但用户永远不知道它为什么不正常。
   */
  units: HeadingUnit[];
}

interface HeadingUnit {
  kind: 'known' | 'unknown';
  /** `kind === 'known'` 时是板块 id */
  blockId: BlockId | null;
  headingText: string;
  /** 1-based 行号 */
  line: number;
  /** 标题行起始偏移 */
  start: number;
  /** 标题行之后一行的起始偏移（正文起点候选） */
  nextStart: number;
}

/**
 * @param splitAtUnknown 板块正文是否在**不认得的标题行**处截断。
 *
 * 保全模式必须为 true：那些片段要被搬进【其他设定】，如果正文还把它们含在里面，
 * 导出时同一段文字会出现两次（一次跟着原板块，一次跟着【其他设定】后面）——
 * 实测就是这么发现的：`## 战斗系统` 既出现在【性格】后面，又出现在分隔符下方。
 *
 * 非保全模式必须为 false：旧语义是"不认得的标题，其内容归入上一板块正文"
 * （docs/06 §1 的 unknown-heading 提示就是这么写的）。这时若也截断，
 * 那段文字就真的没了 —— 那正是本任务要消灭的事。
 */
function scanSections(
  text: string,
  aliases: Readonly<Record<string, BlockId>>,
  splitAtUnknown = false,
): ScanResult {
  const lines = [...iterateLines(text)];
  const marks: { line: number; index: number; start: number; nextStart: number; blockId: BlockId; headingText: string }[] = [];
  const duplicates: { blockId: BlockId; line: number }[] = [];
  const unknownHeadings: UnknownHeading[] = [];
  const units: HeadingUnit[] = [];
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
      units.push({
        kind: 'unknown',
        blockId: null,
        headingText,
        line: lineNumber,
        start: line.start,
        nextStart: line.nextStart,
      });
      return;
    }
    if (seen.has(blockId)) {
      duplicates.push({ blockId, line: lineNumber });
      // 重复标题**不**成为单元边界：它的内容继续留在首次出现那个板块的正文里
      // （内容不丢，且不在保全层面制造第二个同名片段）
      return;
    }
    seen.add(blockId);
    marks.push({ line: lineNumber, index, start: line.start, nextStart: line.nextStart, blockId, headingText });
    units.push({
      kind: 'known',
      blockId,
      headingText,
      line: lineNumber,
      start: line.start,
      nextStart: line.nextStart,
    });
  });

  units.sort((a, b) => a.start - b.start);

  const sections: Section[] = marks.map((mark, position) => {
    let bodyEnd: number;
    if (splitAtUnknown && mark.blockId !== 'worldbook') {
      // 世界书例外：它的正文里出现的标题式行属于世界书 TXT 格式（docs/04），不是片段
      bodyEnd = text.length;
      for (const unit of units) {
        if (unit.start > mark.start) {
          bodyEnd = unit.start;
          break;
        }
      }
    } else {
      bodyEnd = position + 1 < marks.length ? marks[position + 1]!.start : text.length;
    }
    const bodyStart = mark.nextStart;
    let start = bodyStart;
    while (start < bodyEnd && /\s/.test(text[start]!)) start += 1;
    let end = bodyEnd;
    while (end > start && /\s/.test(text[end - 1]!)) end -= 1;
    return {
      blockId: mark.blockId,
      headingText: mark.headingText,
      line: mark.line,
      start: mark.start,
      nextStart: mark.nextStart,
      end,
      body: text.slice(start, end),
    };
  });

  return { sections, duplicates, unknownHeadings, lineCount: lines.length, units };
}

/** 从 `from` 起跳掉空白，返回首个非空白字符偏移（越界则返回 `from`） */
function skipWhitespaceForward(text: string, from: number, limit: number): number {
  let cursor = from;
  while (cursor < limit && /\s/.test(text[cursor]!)) cursor += 1;
  return cursor;
}

/** 从 `end` 往前跳掉空白，返回新的结束偏移 */
function skipWhitespaceBackward(text: string, from: number, end: number): number {
  let cursor = end;
  while (cursor > from && /\s/.test(text[cursor - 1]!)) cursor -= 1;
  return cursor;
}

/**
 * 在一段文本里找分隔符行，返回它的起始偏移；没有则 null。
 *
 * 按**整行**比对（trim 后相等），不做子串匹配：分隔符是格式标记，
 * 用户正文里恰好提到这几个字（比如把这句话贴进设定里）不该被当成标记。
 */
function findSeparatorLine(text: string, from: number, end: number): number | null {
  for (const line of iterateLines(text.slice(0, end))) {
    if (line.start < from) continue;
    if (line.text.trim() === UNRECOGNIZED_SEPARATOR_LINE) return line.start;
  }
  return null;
}

function emptyTextBlock(id: BlockId, missing: boolean): CardBlock {
  return { id, text: '', raw: '', dirty: false, anchor: null, missing };
}

function aliasHint(preset: TxtPreset, blockId: BlockId): string {
  const aliases = preset.headings[blockId]?.aliases ?? [BLOCK_DEFINITION_MAP[blockId].defaultHeading];
  return aliases.join(' / ');
}

// ---------------------------------------------------------------- 全量保全

interface PreservationPlan {
  /** 是否有东西需要放进【其他设定】 */
  applied: boolean;
  /** 0 板块识别 → 原文整体放置（逐字节，不加分隔符） */
  wholeText: boolean;
  /** 识别出的板块数（含世界书：它也是"认得的标题"） */
  blockCount: number;
  /** 【其他设定】里"已识别"的部分（分隔符之前）；null = 该标题没出现 */
  settingsHead: string | null;
  /** 文件里已经存在的保全尾段（从分隔符那行起）；null = 还没有 */
  existingTail: string | null;
  /** 未识别片段（原文，含各自标题行），按文档顺序 */
  fragments: { text: string; line: number }[];
  /** 已经处在保全区域里、不必重复报告的未知标题行号 */
  suppressedUnknownLines: Set<number>;
}

/**
 * 计算保全方案（纯函数，不碰卡片）。
 *
 * 三条边界规则值得单独说明：
 *
 * 1. **世界书是边界黑洞**：它的正文里出现的"标题行"属于世界书 TXT 格式
 *    （docs/04），不是未识别片段。所以世界书的正文一直延伸到**下一个认得的板块**
 *    为止，中间的未知标题既不切分、也不搬走 —— 搬走会把世界书拆坏。
 * 2. **首个标题之前的前言也是内容**：旧实现直接把它丢了（`descriptionRaw`
 *    从第一个 section 的标题行开始拼）。保全模式下它作为一个无标题片段进【其他设定】。
 * 3. **重复标题不算片段**：它的内容已经在首次出现的板块正文里（`scanSections`
 *    就不把它当单元边界），再当一个片段会导致同一段文字出现两次。
 */
function planPreservation(text: string, scan: ScanResult): PreservationPlan {
  const units = scan.units;
  const knownUnits = units.filter((unit) => unit.kind === 'known');

  if (knownUnits.length === 0) {
    return {
      applied: text.trim() !== '',
      wholeText: true,
      blockCount: 0,
      settingsHead: null,
      existingTail: null,
      fragments: [],
      suppressedUnknownLines: new Set(),
    };
  }

  /** 第 index 个单元的正文结束偏移 */
  const bodyEndOf = (index: number): number => {
    const unit = units[index]!;
    if (unit.kind === 'known' && unit.blockId === 'worldbook') {
      for (let next = index + 1; next < units.length; next += 1) {
        if (units[next]!.kind === 'known') return units[next]!.start;
      }
      return text.length;
    }
    return index + 1 < units.length ? units[index + 1]!.start : text.length;
  };

  // ---- 前言（第一个标题之前的所有内容）----
  const fragments: { text: string; line: number }[] = [];
  const preambleEnd = units[0]!.start;
  const preamble = text.slice(0, skipWhitespaceBackward(text, 0, preambleEnd));
  if (preamble.trim() !== '') fragments.push({ text: preamble.trim(), line: 1 });

  // ---- 未识别单元（跳过被世界书吞掉的那些）----
  let cursor = 0;
  while (cursor < units.length) {
    const unit = units[cursor]!;
    const end = bodyEndOf(cursor);
    if (unit.kind === 'unknown') {
      const body = text.slice(unit.start, skipWhitespaceBackward(text, unit.start, end));
      if (body.trim() !== '') fragments.push({ text: body.trim(), line: unit.line });
    }
    let next = cursor + 1;
    while (next < units.length && units[next]!.start < end) next += 1;
    cursor = next;
  }

  // ---- 【其他设定】已识别部分 / 已存在的保全尾段 ----
  let settingsHead: string | null = null;
  let existingTail: string | null = null;
  const suppressedUnknownLines = new Set<number>();

  const settingsIndex = units.findIndex((unit) => unit.kind === 'known' && unit.blockId === 'settings');
  if (settingsIndex >= 0) {
    const settingsUnit = units[settingsIndex]!;
    const bodyStart = skipWhitespaceForward(text, settingsUnit.nextStart, text.length);
    const bodyEnd = bodyEndOf(settingsIndex);
    const separatorAt = findSeparatorLine(text, bodyStart, bodyEnd);
    const headEnd = separatorAt === null ? bodyEnd : separatorAt;
    settingsHead = text.slice(bodyStart, skipWhitespaceBackward(text, bodyStart, headEnd));
    if (separatorAt !== null) {
      existingTail = text.slice(separatorAt, skipWhitespaceBackward(text, separatorAt, bodyEnd));
      // 分隔符**之后**的任何未知标题都已经是"上次保全过的内容"。
      // 注意边界不能用 bodyEnd：正文在第一个未知标题处就截断了，
      // 用它当上界会把分隔符下方那些片段全漏掉（它们正是"不该再报"的那批）。
      for (const unit of units) {
        if (unit.kind === 'unknown' && unit.start > separatorAt) suppressedUnknownLines.add(unit.line);
      }
    }
  }

  return {
    applied: true,
    wholeText: false,
    blockCount: knownUnits.length,
    settingsHead,
    existingTail,
    fragments,
    suppressedUnknownLines,
  };
}

/**
 * 按保全方案拼出【其他设定】的最终正文。
 *
 * 幂等在这里：如果文件里已经有分隔符（`existingTail`），就不再补一行 ——
 * 否则"导入 → 导出 → 再导入"每轮多一行分隔符，几次之后文件里全是它。
 */
function assemblePreservedSettings(plan: PreservationPlan): string {
  const parts: string[] = [];
  const head = plan.settingsHead?.trim() ?? '';
  if (head !== '') parts.push(head);
  if (plan.existingTail !== null) parts.push(plan.existingTail);
  else if (plan.fragments.length > 0) parts.push(UNRECOGNIZED_SEPARATOR_LINE);
  if (plan.fragments.length > 0) parts.push(plan.fragments.map((fragment) => fragment.text).join('\n\n'));
  return parts.join('\n\n');
}

/**
 * TXT → 统一模型。
 * description 侧的处理：把文件中所有「属于 description 的段落」按其**原始顺序**拼接成
 * `description.raw`（每段内部的字节逐字保留），再交给 `parseDescription` 取锚点；
 * 性格、世界书段落不进入 description（性格写回 `personality` 字段）。
 */
export function parseCardText(text: string, preset: TxtPreset, options: ParseCardTextOptions = {}): ParseCardTextResult {
  // 保全优先于"缺板块"语义：开启后两种模式行为一致（docs/06 §7）
  const preserve = options.preserveUnrecognized === true;
  const mode = preserve ? 'lenient' : (options.mode ?? 'strict');
  const aliases = presetAliasTable(preset);
  const scan = scanSections(text, aliases, preserve);
  const issues: CardTextIssue[] = [];
  const plan = preserve ? planPreservation(text, scan) : null;

  const byBlock = new Map<BlockId, Section>();
  for (const section of scan.sections) byBlock.set(section.blockId, section);

  // ---- 未识别 / 重复标题 ----
  for (const unknown of scan.unknownHeadings) {
    // 保全模式下这里分三种情况，只报一种：
    //   · 0 板块识别 → 全文整体进【其他设定】，逐行报"无法识别"只会刷满一屏，
    //     改为下面单独一条 unrecognized-whole；
    //   · 该行已在既有保全区域里（上次导入留下的）→ 不重复报，
    //     否则每次打开同一份文件都像"又出了新问题"；
    //   · 其余照报（繁体写错这类提示必须留住）。
    if (plan !== null && (plan.wholeText || plan.suppressedUnknownLines.has(unknown.line))) continue;
    const label = unknown.suggestion ? BLOCK_DEFINITION_MAP[unknown.suggestion.blockId].label : null;
    issues.push({
      severity: 'warning',
      code: 'unknown-heading',
      line: unknown.line,
      message: `第 ${unknown.line} 行的标题「${unknown.headingText}」无法识别为任何板块`,
      hint: unknown.suggestion
        ? `是否想写「${unknown.suggestion.alias}」（${label}）？`
        : preserve
          ? '该段原文将放入【其他设定】；若它本来该是某个板块，请改标题'
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
  //
  // 保全模式下**不产出缺失问题**：内容没有丢，"缺失"这个词在这里是错的
  // （0 板块识别时原文整体在【其他设定】里；≥1 时未识别片段也在那里）。
  // 但 ≥1 的情况下 `missing` 标记仍然照实打 —— 那个板块确实没有标题，
  // 编辑器把它标成「原文缺失」是准确的信息，审计据此提示也不算误报。
  const orderIndex = new Map<BlockId, number>(preset.blockOrder.map((id, index) => [id, index]));
  // 两个字段板块（对话示例 / 初始场景）**不参与"缺失板块"判定**：
  // 它们是可选内容，六板块时代导出的 TXT 里本来就没有这两个标题，
  // 报"缺少板块"会让每一份历史 TXT 都看起来有问题（而内容并没丢）。
  const missing = BLOCK_IDS.filter((id) => !byBlock.has(id) && !isFieldBlock(id));
  for (const blockId of missing) {
    if (preserve) break;
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

  // ---- 保全结论 ----
  const preservedSettings = plan !== null && !plan.wholeText ? assemblePreservedSettings(plan) : null;
  const preservedInfo: PreservedInfo | null =
    plan === null
      ? null
      : {
          applied: plan.applied,
          wholeText: plan.wholeText,
          fragments: plan.fragments.length,
          blockCount: plan.blockCount,
          fragmentLines: plan.fragments.map((fragment) => fragment.line),
        };

  if (plan !== null && plan.wholeText) {
    issues.push({
      severity: 'warning',
      code: 'unrecognized-whole',
      message:
        '未识别到任何板块，原文已整体放入【其他设定】，请自行分块（内容与原文逐字一致）',
      hint: '可用标题见预设别名表；也可以就用一份纯文本，直接在【其他设定】里排版',
    });
  } else if (plan !== null && plan.fragments.length > 0 && plan.existingTail === null) {
    const count = plan.fragments.length;
    issues.push({
      severity: 'warning',
      code: 'unrecognized-preserved',
      message: `识别到 ${String(plan.blockCount)} 个板块，另有 ${String(count)} 段未识别内容已按原序放入【其他设定】`,
      hint: `分隔符下方即为原文，未做任何改写；把这些内容改写成正式板块标题后可重新导入`,
    });
  }

  // ---- 世界书 ----
  const worldbookSection = byBlock.get('worldbook');
  // 按当前世界书预设解析（v0.1.5 / G4）：不传就退回冻结格式
  const worldbookParsed = parseWorldbookTextWith(
    worldbookSection?.body ?? '',
    options.worldbookFormat ?? DEFAULT_WORLDBOOK_FORMAT,
  );
  for (const issue of worldbookParsed.issues) {
    issues.push({
      severity: issue.severity,
      code: issue.severity === 'error' ? 'worldbook-error' : 'worldbook-warning',
      line: issue.line,
      message: issue.message,
    });
  }

  // ---- description ----
  //
  // 保全生效时【其他设定】的正文变了（多了分隔符与片段），而 `description.raw`
  // 是"原文"的权威副本 —— 不跟着改会出现两处不一致：审计会说"raw 与板块重建不符"，
  // 切换预设时又会按旧 raw 找回旧内容（保全的内容凭空消失）。
  // 所以这里按**最终的** settings 文本重建这一段，标题行字节保持原样。
  const descriptionSections = scan.sections
    .filter(
      (section) =>
        section.blockId !== 'worldbook' &&
        section.blockId !== 'personality' &&
        // 字段板块不进 description：它们的内容属于 first_mes / mes_example
        !isFieldBlock(section.blockId),
    )
    .sort((a, b) => a.start - b.start);
  const settingsSection = byBlock.get('settings');
  const descriptionChunks = descriptionSections.map((section) => {
    if (preservedSettings === null || section.blockId !== 'settings') {
      return text.slice(section.start, section.end);
    }
    // 标题行（含其换行）原样保留，其后换成最终正文
    const headingLine = text.slice(section.start, section.nextStart);
    return preservedSettings.trim() === '' ? text.slice(section.start, section.end) : `${headingLine}${preservedSettings}`;
  });
  if (preservedSettings !== null && settingsSection === undefined && preservedSettings.trim() !== '') {
    // 【其他设定】标题压根没出现：补一段出来，否则保全内容在 raw 里无迹可寻
    const heading = headingTextFor(preset, 'settings', null);
    descriptionChunks.push(`${heading}\n${preservedSettings}`);
  }
  const descriptionRaw = descriptionChunks.join(preset.separator);
  const parsedDescription = parseDescription(descriptionRaw, { aliases, separator: preset.separator });
  const parsedById = new Map(parsedDescription.blocks.map((block) => [block.id, block]));

  // ---- 字段板块（v0.1.3）：初始场景 / 对话示例 ----
  //
  // 这两段**不进 description**：它们的正文属于 first_mes / alternate_greetings / mes_example
  // 三个独立顶层字段。若跟着 description 走，用户导出再导入会发现"开场白跑进了 description"。
  //
  // 末尾可能残留板块分隔符（如 divider 预设的 `---`）：它属于排版，不属于内容，
  // 先按预设的板块分隔符剔除，再按开场白分隔符切分。
  const blockSeparatorToken = separatorToken(preset.separator);
  const fieldSectionText = (id: BlockId): string | null => {
    const section = byBlock.get(id);
    if (section === undefined) return null;
    return trimTrailingSeparatorText(section.body, blockSeparatorToken);
  };
  const greetingFormat = options.greetingFormat ?? presetGreetingFormat(preset);
  const greetingText = fieldSectionText('initial-scene');
  const greetings = parseGreetings(greetingText ?? '', greetingFormat);
  const examplesText = fieldSectionText('chat-examples');

  const buildCard = (): UnifiedCard => {
    const card = createEmptyCard();
    const personalitySection = byBlock.get('personality');
    const personalityText = personalitySection?.body ?? '';

    card.blocks = BLOCK_IDS.filter((id) => id !== 'worldbook').map((id) => {
      // 字段板块：正文直接落 residual（见下方），板块里显示同一段文本
      if (isFieldBlock(id)) {
        const text = (id === 'initial-scene' ? greetingText : examplesText) ?? '';
        return {
          id,
          text,
          raw: text,
          dirty: false,
          anchor: null,
          // 0 板块识别时整篇原文在【其他设定】里，说"这两个板块缺失"是误导：
          // 不是缺，是这张卡本来就没有开场白/示例对话（与 personality 的处理一致）
          missing: (id === 'initial-scene' ? greetingText : examplesText) === null && !(plan !== null && plan.wholeText),
        };
      }
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
          // 0 板块识别时整篇原文在【其他设定】里，说"性格板块缺失"会误导：
          // 不是缺，是被有意整体放在一处了（docs/06 §7.1）
          missing: plan !== null && plan.wholeText ? false : !personalitySection,
        };
      }
      // 保全：0 板块识别时原文整体进【其他设定】，**逐字节**（不 trim、不加分隔符）
      if (id === 'settings' && plan !== null && plan.wholeText) {
        return {
          id: 'settings' as BlockId,
          text,
          raw: text,
          dirty: false,
          anchor: { field: 'description' as const, headingText: null, headingSpan: null, bodySpan: null },
          missing: false,
        };
      }
      if (id === 'settings' && preservedSettings !== null) {
        const parsed = parsedById.get('settings');
        return {
          id: 'settings' as BlockId,
          text: preservedSettings,
          raw: preservedSettings,
          dirty: false,
          anchor: parsed?.anchor ?? { field: 'description' as const, headingText: null, headingSpan: null, bodySpan: null },
          // 标题没出现时它是"被我补出来的"，标 missing 才符合事实；
          // 但它现在装着全部原文，所以只有 0 板块识别之外的情况才可能走到这里
          missing: settingsSection === undefined,
        };
      }
      const parsed = parsedById.get(id);
      if (parsed && parsed.anchor) return { ...parsed, missing: false };
      // 0 板块识别时不打缺失标记（整篇在【其他设定】里，见上）
      return emptyTextBlock(id, !(plan !== null && plan.wholeText));
    });

    card.description = {
      raw: descriptionRaw,
      separator: preset.separator,
      structured: parsedDescription.structured,
      preface: parsedDescription.preface,
    };
    // 开场白族与对话示例落在独立字段上，由板块文本解析而来。
    // 空白开场白板块 → 单条空 first_mes（而不是"保留旧值"）：TXT 是本文件的事实源。
    card.residual = {
      ...card.residual,
      firstMes: greetings.firstMes,
      alternateGreetings: [...greetings.alternateGreetings],
      mesExample: examplesText ?? '',
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
      preserved: preservedInfo,
    };
  }

  return {
    card: buildCard(),
    issues,
    ok: !hasError,
    missing,
    unknownHeadings: scan.unknownHeadings,
    worldbook: { entries: worldbookParsed.entries, issues: worldbookParsed.issues },
    preserved: preservedInfo,
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
    return { card, issues: result.issues, ok: result.ok, changed: false, merge: null, preserved: result.preserved };
  }

  const next: UnifiedCard = structuredClone(card);
  next.blocks = result.card.blocks;
  next.description = result.card.description;
  // 只回写"由 TXT 承载"的三个开场白族字段。其余 residual（scenario / system_prompt /
  // 群聊开场白 / extensions 之类）TXT 里没有，绝不能因为解析结果是新建卡就被清空。
  next.residual = {
    ...card.residual,
    firstMes: result.card.residual.firstMes,
    alternateGreetings: [...result.card.residual.alternateGreetings],
    mesExample: result.card.residual.mesExample,
  };
  const merge = mergeWorldbookEntries(card.worldbook.entries, result.card.worldbook.entries);
  next.worldbook = {
    entries: merge.entries,
    text: renderWorldbookText(merge.entries),
    dirty: false,
    raw: card.worldbook.raw,
  };
  return { card: next, issues: result.issues, ok: true, changed: true, merge, preserved: result.preserved };
}
