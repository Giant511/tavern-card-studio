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
 * 文本偏移 → 行号/列号（T4.4 客户端「点击定位」用）。
 * 换行符一律按「一个断行」计：`\n`、`\r\n`、`\r` 都只 +1 行。
 * 列号按码点计，与 `chars` 口径一致（emoji 不会被算成 2 列）。
 */
export function offsetToLineColumn(text: string, offset: number): LineColumn {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;

  for (let index = 0; index < clamped; index += 1) {
    const char = text[index];
    if (char === '\n') {
      line += 1;
      lineStart = index + 1;
    } else if (char === '\r') {
      line += 1;
      lineStart = text[index + 1] === '\n' ? index + 2 : index + 1;
    }
  }

  let column = 1;
  for (const _char of text.slice(lineStart, clamped)) column += 1;
  return { line, column };
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
