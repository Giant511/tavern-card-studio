/**
 * `buildExportAsync` 的调用点必须给满 6 个参数（2026-11-24）。
 *
 * ## 为什么要一条静态判据
 *
 * 这个函数的签名是：
 *
 * ```text
 *   (card, preset, format, greetingFormat, faceBytes, chatExamplesFormat?)
 * ```
 *
 * 第 6 个参数是可选的 —— 这在类型上合法，于是**漏传不会报错**。
 * 实测（代码分析报告 P0-5）三处调用点漏传：推 ST、另存为、导出对话框。
 * 后果是同一张卡从不同出口出去 `mes_example` 排版不同：
 * 上传到服务端的带了对话示例格式，导出/另存的没带。
 *
 * 把参数改成必填仍然防不住 —— 漏传时 TypeScript 会红，但**下一个人可以
 * 在调用点写 `undefined` 让自己变绿**。所以这里判的是"调用点出现了
 * 取格式的那个表达式"，而不是"参数个数对不对"。
 *
 * 判据用括号配对切出完整调用片段，避免"数逗号"被嵌套调用骗过。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readEditorImplNoComments } from './lib/editor-source.mjs';

const ROOT = join(import.meta.dirname, '..');

/** 允许出现 `buildExportAsync(...)` 调用的文件（新增调用点要登记在这里） */
const CALL_SITES = [
  'client/src/editor/app.ts',
  'client/src/export/export-dialog.ts',
];

/** 从 `start`（指向 `(`）开始做括号配对，返回闭合 `)` 之后的下标 */
function matchParen(text, start) {
  let depth = 0;
  let inString = null;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString !== null) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** 抽出所有 `buildExportAsync(...)` 的实参片段 */
function callSitesIn(source) {
  const out = [];
  const needle = 'buildExportAsync(';
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at < 0) break;
    // 跳过正则/注释里的偶然命中：要求前面不是字母（排除 xxxbuildExportAsync）
    const before = source[at - 1] ?? '';
    if (/[A-Za-z0-9_$]/.test(before)) {
      from = at + needle.length;
      continue;
    }
    const openParen = at + needle.length - 1;
    const end = matchParen(source, openParen);
    out.push({ at, text: source.slice(openParen, end) });
    from = end;
  }
  return out;
}

test('★★★★★ 每个 buildExportAsync 调用点都传了 chatExamplesFormat', () => {
  let total = 0;
  for (const rel of CALL_SITES) {
    const source = readFileSync(join(ROOT, rel), 'utf8');
    const sites = callSitesIn(source);
    assert.ok(sites.length > 0, `${rel} 里找不到调用点 —— 文件改名了？判据需要同步`);
    for (const site of sites) {
      total += 1;
      const line = source.slice(0, site.at).split('\n').length;
      assert.ok(
        site.text.includes('chatExamplesFormat'),
        `${rel}:${String(line)} 的 buildExportAsync 漏传 chatExamplesFormat —— ` +
          '同一张卡从不同出口导出会得到不同的 mes_example 排版',
      );
    }
  }
  assert.ok(total >= 3, `只扫到 ${String(total)} 个调用点，预期至少 3 个`);
});

test('★★★ 导出对话框的状态里确实带出了对话示例格式', () => {
  /*
   * 光在调用点写 `state.chatExamplesFormat` 不够 —— 如果 `getState()` 没提供
   * 这个键，运行时永远是 undefined，等于没传。这条盯住供给端。
   */
  const app = readEditorImplNoComments();
  const marker = 'chatExamplesFormat: this.chatExamplesFormat()';
  assert.ok(
    app.includes(marker),
    'ExportDialog 的 getState() 没有提供 chatExamplesFormat —— 对话框那一侧仍然是漏的',
  );
});
