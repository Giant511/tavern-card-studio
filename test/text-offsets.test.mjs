/**
 * 文本偏移 → 行列（T4.4 定位契约）。
 *
 * 这里单独成文件是因为它是一个**被很多地方依赖的基础换算**：审计问题的行号、
 * 世界书 TXT 错误的定位都经过它。换算错了，所有"点一下跳到第 N 行"都会偏。
 *
 * 2026-10-23（T10.9）实测发现它在 CRLF 上多算一行：遇到 `\r` 就 +1 行，
 * 紧接着的 `\n` 又被算一次。以前所有用例都跑在 LF 文本上，所以一直没暴露；
 * 而本仓库工作区与 Windows 用户导出的文件普遍是 CRLF。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { offsetToLineColumn } from '../shared/dist/index.js';

test('T10.9 LF：行号与列号按码点算', () => {
  const text = 'abc\ndef\nghi';
  assert.deepEqual(offsetToLineColumn(text, 0), { line: 1, column: 1 });
  assert.deepEqual(offsetToLineColumn(text, 2), { line: 1, column: 3 });
  assert.deepEqual(offsetToLineColumn(text, 4), { line: 2, column: 1 });
  assert.deepEqual(offsetToLineColumn(text, 8), { line: 3, column: 1 });
});

test('T10.9 CRLF：一个 CRLF 只算一个断行（修复前会多算）', () => {
  const text = 'abc\r\ndef\r\nghi';
  // 第二行开头（'d'）在偏移 5
  assert.deepEqual(offsetToLineColumn(text, 5), { line: 2, column: 1 });
  // 第三行开头（'g'）在偏移 10
  assert.deepEqual(offsetToLineColumn(text, 10), { line: 3, column: 1 });
});

test('T10.9 CRLF 与 LF 的行号完全一致（同一份内容的两种存法）', () => {
  const lf = '{\n  "a": 1,\n  "b": 2\n}';
  const crlf = lf.replace(/\n/g, '\r\n');
  // 两种存法里，'}' 都是第 4 行第 1 列
  const lfAt = lf.indexOf('}');
  const crlfAt = crlf.indexOf('}');
  assert.deepEqual(offsetToLineColumn(lf, lfAt), { line: 4, column: 1 });
  assert.deepEqual(offsetToLineColumn(crlf, crlfAt), { line: 4, column: 1 });
});

test('T10.9 纯 CR（老 Mac 风格）：同样只算一个断行', () => {
  const text = 'a\rb\rc';
  assert.deepEqual(offsetToLineColumn(text, 2), { line: 2, column: 1 });
  assert.deepEqual(offsetToLineColumn(text, 4), { line: 3, column: 1 });
});

test('T10.9 列号按码点：emoji 不会被算成 2 列', () => {
  const text = '🙂x';
  // 偏移 2 是 'x'：码点位置 2 → 第 1 行第 2 列（emoji 只占 1 列）
  assert.deepEqual(offsetToLineColumn(text, 2), { line: 1, column: 2 });
});

test('T10.9 偏移越界时夹到文本长度，不返回负数或 NaN', () => {
  const text = 'ab';
  assert.deepEqual(offsetToLineColumn(text, 999), { line: 1, column: 3 });
  assert.deepEqual(offsetToLineColumn(text, -5), { line: 1, column: 1 });
});
