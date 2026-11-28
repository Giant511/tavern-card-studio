/**
 * 文本计数工具（字数统计、长度规则共用）。
 * 统一以「码点」而非 UTF-16 code unit 计数，避免 emoji 被算成 2 个字。
 */

const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 基本区
  [0xf900, 0xfaff], // 兼容表意文字
  [0x3040, 0x30ff], // 日文假名
  [0xac00, 0xd7af], // 韩文音节
  [0x20000, 0x2fa1f], // CJK 扩展 B-F
];

const WORD_PATTERN = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;

export interface TextCount {
  /** 码点数（含空白） */
  chars: number;
  /** 码点数（不含空白） */
  charsNoSpace: number;
  /** 中日韩字符数 */
  cjk: number;
  /** 拉丁/数字词数 */
  words: number;
  /** 字符数口径的总词数 = cjk + words */
  totalWords: number;
}

export function isCjkCodePoint(codePoint: number): boolean {
  for (const [start, end] of CJK_RANGES) {
    if (codePoint >= start && codePoint <= end) return true;
  }
  return false;
}

export function countText(text: string): TextCount {
  let chars = 0;
  let charsNoSpace = 0;
  let cjk = 0;

  for (const char of text) {
    chars += 1;
    const codePoint = char.codePointAt(0) ?? 0;
    if (!/\s/u.test(char)) charsNoSpace += 1;
    if (isCjkCodePoint(codePoint)) cjk += 1;
  }

  const words = text.match(WORD_PATTERN)?.length ?? 0;

  return { chars, charsNoSpace, cjk, words, totalWords: cjk + words };
}

/** 长度规则的统一计数口径 */
export function measure(text: string, unit: 'char' | 'word'): number {
  const count = countText(text);
  return unit === 'word' ? count.totalWords : count.charsNoSpace;
}

export interface LineColumn {
  /** 1-based 行号 */
  line: number;
  /** 1-based 列号（按码点计，emoji 算 1 列） */
  column: number;
}

/**
 * 可复用的行号索引（2026-11-24）。
 *
 * ## 为什么需要它
 *
 * `offsetToLineColumn` 每次调用都从 0 扫到 offset。单次用没问题，
 * 但世界书 JSON 解析是"每个条目算一次"（`worldbook-io.ts`）——
 * 于是总复杂度是 O(条目数 × 文本长度)。实测（报告 P1-3）：
 *
 * ```text
 *   2.5k 条 → 0.85 s      5k 条 → 3.36 s      10k 条 → 13.1 s
 * ```
 *
 * 大世界书卡直接卡住界面十几秒，用户以为死了。
 *
 * ## 做法
 *
 * 一次扫描记录所有行首偏移，之后每个查询是二分查找：O(n + m log n)。
 * 语义与 `offsetToLineColumn` **逐字相同**（换行判定、码点列号都一致），
 * 差异只在"扫几次"。两者共用同一段换行逻辑，不会算出两个答案。
 */
export interface LineIndex {
  /** 偏移 → 行列（与 `offsetToLineColumn` 同语义） */
  at(offset: number): LineColumn;
}

/** 建索引：一次 O(n) 扫描，之后每次查询 O(log n) */
export function createLineIndex(text: string): LineIndex {
  // lineStarts[i] = 第 i+1 行的起始偏移
  const lineStarts: number[] = [0];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\r') {
      if (text[index + 1] === '\n') index += 1;
      lineStarts.push(index + 1);
    } else if (char === '\n') {
      lineStarts.push(index + 1);
    }
  }

  return {
    at(offset: number): LineColumn {
      const clamped = Math.max(0, Math.min(offset, text.length));
      // 二分找"最后一个 ≤ clamped 的行首"
      let low = 0;
      let high = lineStarts.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if ((lineStarts[mid] as number) <= clamped) low = mid;
        else high = mid - 1;
      }
      const lineStart = lineStarts[low] as number;
      let column = 1;
      for (const _char of text.slice(lineStart, clamped)) column += 1;
      return { line: low + 1, column };
    },
  };
}

/**
 * 文本偏移 → 行号/列号（T4.4 客户端「点击定位」用）。
 * 换行符一律按「一个断行」计：`\n`、`\r\n`、`\r` 都只 +1 行。
 * 列号按码点计，与 `chars` 口径一致（emoji 不会被算成 2 列）。
 *
 * **CRLF 必须成对跳过**（T10.9 修正）：原实现遇到 `\r` 就把行号 +1 并算出
 * `lineStart`，但循环随后还会走到紧跟的 `\n`，于是又把行号 +1 ——
 * 一个 CRLF 被算成两个断行。表现是 CRLF 文件里"第 3 行"的报错显示成"第 5 行"
 * （每隔一个换行多 +1），而本仓库的工作区与 Windows 用户导出的文件普遍是 CRLF。
 * 以前的用例都在 LF 上跑，所以一直没被发现；`test/text-offsets.test.mjs` 现在同时测两种。
 *
 * ★ 批量场景（同一份文本查多次）改用 `createLineIndex`，否则是 O(n²)。
 */
export function offsetToLineColumn(text: string, offset: number): LineColumn {
  return createLineIndex(text).at(offset);
}

/** 取偏移所在行的整行文本（不含换行符），供 UI 高亮整行 */
export function lineTextAt(text: string, offset: number): string {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let start = 0;
  for (let index = clamped - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === '\n') {
      start = index + 1;
      break;
    }
    if (char === '\r') {
      start = index + 1;
      break;
    }
  }
  let end = text.length;
  for (let index = clamped; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\n' || char === '\r') {
      end = index;
      break;
    }
  }
  return text.slice(start, end);
}

/** 字面量出现次数 */
export function countLiteral(text: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

/** 字面量出现的所有偏移（用于问题定位） */
export function findLiteralOffsets(text: string, needle: string, limit = 200): number[] {
  if (needle === '') return [];
  const offsets: number[] = [];
  let index = text.indexOf(needle);
  while (index !== -1 && offsets.length < limit) {
    offsets.push(index);
    index = text.indexOf(needle, index + needle.length);
  }
  return offsets;
}

const WHITESPACE = /\s/;

/** 从 start 起跳过空白后的位置 */
export function skipWhitespaceForward(text: string, start: number, end = text.length): number {
  let index = start;
  while (index < end && WHITESPACE.test(text[index] ?? '')) index += 1;
  return index;
}

/** 从 end 起向前跳过空白后的位置 */
export function skipWhitespaceBackward(text: string, start: number, end: number): number {
  let index = end;
  while (index > start && WHITESPACE.test(text[index - 1] ?? '')) index -= 1;
  return index;
}
