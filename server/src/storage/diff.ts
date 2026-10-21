/**
 * 版本对比（T5.2）。三层，各自回答一个不同的问题：
 *
 *   bytes —— 两份上传字节是否**逐字节相同**（sha256 + 首个差异偏移）。回滚是否真的还原，看这一层。
 *   lines —— 按原始字节切行后的 unified diff（含行尾），给人看的改动位置。
 *   json  —— 解析后按 JSON 路径列字段改动（如 `data.description`），给人看的改动语义。
 *
 * 任何一层都不修改原始字节；json 层解析失败时只是不产出该层，不影响另外两层。
 */

import { createHash } from 'node:crypto';

export interface ByteComparison {
  identical: boolean;
  fromSha256: string;
  toSha256: string;
  fromSize: number;
  toSize: number;
  sizeDelta: number;
  /** 首个不同字节的下标（0-based）；完全相同时为 null */
  firstDiffOffset: number | null;
  /** 共同前缀字节数 */
  commonPrefix: number;
  /** 共同后缀字节数 */
  commonSuffix: number;
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function compareBytes(from: Buffer, to: Buffer): ByteComparison {
  const limit = Math.min(from.length, to.length);
  let commonPrefix = 0;
  while (commonPrefix < limit && from[commonPrefix] === to[commonPrefix]) commonPrefix += 1;

  let commonSuffix = 0;
  while (
    commonSuffix < limit - commonPrefix &&
    from[from.length - 1 - commonSuffix] === to[to.length - 1 - commonSuffix]
  ) {
    commonSuffix += 1;
  }

  const identical = from.length === to.length && commonPrefix === from.length;
  return {
    identical,
    fromSha256: sha256Of(from),
    toSha256: sha256Of(to),
    fromSize: from.length,
    toSize: to.length,
    sizeDelta: to.length - from.length,
    firstDiffOffset: identical ? null : commonPrefix,
    commonPrefix,
    commonSuffix,
  };
}

export type DiffLineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  /** 原始行（保留行尾；仅用于精确呈现） */
  text: string;
  /** 去掉行尾后的展示文本 */
  display: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

export interface LineDiff {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** 行数超出比较上限，中段被折叠成一次替换 */
  truncated: boolean;
  oldLineCount: number;
  newLineCount: number;
  /** 行序列相同但字节不同（典型：仅换行风格/结尾换行差异） */
  equalLinesButDifferentBytes: boolean;
}

const MAX_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split(/(?<=\n)/);
  return parts.filter((part) => part !== '');
}

function displayOf(line: string): string {
  return line.replace(/\r?\n$/, '');
}

interface Edit {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

/** LCS 编辑脚本；超上限时退化为「公共前后缀 + 中间整体替换」 */
function editScript(a: string[], b: string[]): { edits: Edit[]; truncated: boolean } {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const aMid = a.slice(prefix, a.length - suffix);
  const bMid = b.slice(prefix, b.length - suffix);
  const edits: Edit[] = [];

  for (let i = 0; i < prefix; i += 1) {
    edits.push({ kind: 'context', text: a[i]!, oldLine: i + 1, newLine: i + 1 });
  }

  if (aMid.length * bMid.length > MAX_CELLS) {
    aMid.forEach((line, index) => edits.push({ kind: 'del', text: line, oldLine: prefix + index + 1, newLine: null }));
    bMid.forEach((line, index) => edits.push({ kind: 'add', text: line, oldLine: null, newLine: prefix + index + 1 }));
  } else {
    const rows = aMid.length + 1;
    const cols = bMid.length + 1;
    const table = new Uint32Array(rows * cols);
    for (let i = aMid.length - 1; i >= 0; i -= 1) {
      for (let j = bMid.length - 1; j >= 0; j -= 1) {
        table[i * cols + j] =
          aMid[i] === bMid[j]
            ? table[(i + 1) * cols + j + 1]! + 1
            : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < aMid.length && j < bMid.length) {
      if (aMid[i] === bMid[j]) {
        edits.push({ kind: 'context', text: aMid[i]!, oldLine: prefix + i + 1, newLine: prefix + j + 1 });
        i += 1;
        j += 1;
      } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
        edits.push({ kind: 'del', text: aMid[i]!, oldLine: prefix + i + 1, newLine: null });
        i += 1;
      } else {
        edits.push({ kind: 'add', text: bMid[j]!, oldLine: null, newLine: prefix + j + 1 });
        j += 1;
      }
    }
    while (i < aMid.length) {
      edits.push({ kind: 'del', text: aMid[i]!, oldLine: prefix + i + 1, newLine: null });
      i += 1;
    }
    while (j < bMid.length) {
      edits.push({ kind: 'add', text: bMid[j]!, oldLine: null, newLine: prefix + j + 1 });
      j += 1;
    }
  }

  for (let k = 0; k < suffix; k += 1) {
    const oldIndex = a.length - suffix + k;
    const newIndex = b.length - suffix + k;
    edits.push({ kind: 'context', text: a[oldIndex]!, oldLine: oldIndex + 1, newLine: newIndex + 1 });
  }

  return { edits, truncated: aMid.length * bMid.length > MAX_CELLS };
}

function buildHunks(edits: Edit[], context: number, oldLineCount: number, newLineCount: number): DiffHunk[] {
  const changed = edits.map((edit) => edit.kind !== 'context');
  const hunks: DiffHunk[] = [];
  let index = 0;
  while (index < edits.length) {
    if (!changed[index]) {
      index += 1;
      continue;
    }
    const start = Math.max(0, index - context);
    let end = index;
    while (end < edits.length) {
      if (changed[end]) {
        end += 1;
        continue;
      }
      // 两处改动间隔不超过 2*context 时合并成一个 hunk
      let next = end;
      while (next < edits.length && !changed[next]) next += 1;
      if (next < edits.length && next - end <= context * 2) {
        end = next;
        continue;
      }
      break;
    }
    const sliceEnd = Math.min(edits.length, end + context);
    const lines = edits.slice(start, sliceEnd);
    const oldNumbers = lines.filter((line) => line.oldLine !== null).map((line) => line.oldLine!);
    const newNumbers = lines.filter((line) => line.newLine !== null).map((line) => line.newLine!);
    const oldStart = oldNumbers[0] ?? Math.max(1, Math.min(oldLineCount, 1));
    const newStart = newNumbers[0] ?? Math.max(1, Math.min(newLineCount, 1));
    const oldLines = oldNumbers.length;
    const newLines = newNumbers.length;
    hunks.push({
      oldStart,
      oldLines,
      newStart,
      newLines,
      header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
      lines: lines.map((line) => ({
        kind: line.kind,
        text: line.text,
        display: displayOf(line.text),
        oldLine: line.oldLine,
        newLine: line.newLine,
      })),
    });
    index = sliceEnd;
  }
  return hunks;
}

export function diffLines(
  fromText: string,
  toText: string,
  options: { context?: number; bytesDiffer?: boolean } = {},
): LineDiff {
  const a = splitLines(fromText);
  const b = splitLines(toText);
  const { edits, truncated } = editScript(a, b);
  const hunks = buildHunks(edits, options.context ?? 3, a.length, b.length);
  const added = edits.filter((edit) => edit.kind === 'add').length;
  const removed = edits.filter((edit) => edit.kind === 'del').length;
  return {
    hunks,
    added,
    removed,
    truncated,
    oldLineCount: a.length,
    newLineCount: b.length,
    equalLinesButDifferentBytes: options.bytesDiffer === true && added === 0 && removed === 0,
  };
}

export type JsonChangeKind = 'added' | 'removed' | 'changed';

export interface JsonChange {
  path: string;
  kind: JsonChangeKind;
  before?: unknown;
  after?: unknown;
}

export interface JsonDiff {
  changes: JsonChange[];
  truncated: boolean;
  /** 任一侧解析失败时为 false，changes 为空 */
  parsed: boolean;
}

const MAX_JSON_CHANGES = 500;
const MAX_VALUE_TEXT = 400;

function summarizeValue(value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_VALUE_TEXT) {
    return `${value.slice(0, MAX_VALUE_TEXT)}…(${value.length} 字符)`;
  }
  if (Array.isArray(value)) return `[数组 ${value.length} 项]`;
  if (value && typeof value === 'object') return '[对象]';
  return value;
}

function walkDiff(a: unknown, b: unknown, path: string, out: JsonChange[]): void {
  if (out.length > MAX_JSON_CHANGES) return;
  if (a === b) return;

  const bothObjects =
    a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b);
  if (bothObjects) {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      if (!(key in aObj)) out.push({ path: childPath, kind: 'added', after: summarizeValue(bObj[key]) });
      else if (!(key in bObj)) out.push({ path: childPath, kind: 'removed', before: summarizeValue(aObj[key]) });
      else walkDiff(aObj[key], bObj[key], childPath, out);
      if (out.length > MAX_JSON_CHANGES) return;
    }
    return;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      const childPath = `${path}[${index}]`;
      if (index >= a.length) out.push({ path: childPath, kind: 'added', after: summarizeValue(b[index]) });
      else if (index >= b.length) out.push({ path: childPath, kind: 'removed', before: summarizeValue(a[index]) });
      else walkDiff(a[index], b[index], childPath, out);
      if (out.length > MAX_JSON_CHANGES) return;
    }
    return;
  }

  out.push({ path, kind: 'changed', before: summarizeValue(a), after: summarizeValue(b) });
}

export function diffJson(fromText: string, toText: string): JsonDiff {
  let a: unknown;
  let b: unknown;
  try {
    a = JSON.parse(fromText) as unknown;
    b = JSON.parse(toText) as unknown;
  } catch {
    return { changes: [], truncated: false, parsed: false };
  }
  const changes: JsonChange[] = [];
  walkDiff(a, b, '', changes);
  return { changes, truncated: changes.length > MAX_JSON_CHANGES, parsed: true };
}
