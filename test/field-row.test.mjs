/**
 * 表单字段行判据（2026-11-04）。
 *
 * ## 这条判据是为哪个缺陷写的
 *
 * 世界书抽屉真机截图里，每个字段下面都多出一个**带边框的框**：
 *
 * ```text
 *   备注
 *   [ eldoria ]
 *   ┌────────────────────────────────┐
 *   │ 列表中显示的名字。不填就用第一个│   ← 本该是灰色小字
 *   └────────────────────────────────┘
 * ```
 *
 * 一眼看不出来是哪来的，因为 DOM 里类的名字看起来"很像说明"：
 * 那份本地 `fieldRow` 里写的是 `el(doc, 'p', 'nb-note')`。
 *
 * 而 `.nb-note` 是**提示条**：
 *
 * ```css
 * .nb-note {
 *   margin: ...; padding: ...; border-radius: ...;
 *   border: 1px solid var(--nb-glass-border);   ← 就是这个框
 *   background: var(--nb-surface-1);
 * }
 * ```
 *
 * 正确的类是 `.nb-field-hint`（只有字号、颜色、行高）。
 *
 * ## 根因不是"选错类名"，是"同一件事写了两遍"
 *
 * `persona-page.ts` 与 `worldbook-page.ts` 各有一份 `fieldRow`，逻辑逐字
 * 相同，只有那一行的类名不同。两份一旦分叉，改一份另一份不会跟着对。
 * 所以判据不只盯类名，还盯"只许有一份实现"。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** 剥注释（解释文字里会引用被禁的写法） */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
}

const PAGES = ['client/src/chat/persona-page.ts', 'client/src/chat/worldbook-page.ts'];

test('★★★ 字段说明必须用 nb-field-hint，不许用 nb-note（那是提示条，带边框）', () => {
  for (const file of PAGES) {
    const src = stripComments(read(file));
    assert.doesNotMatch(
      src,
      /el\(doc,\s*'[a-z]+',\s*'nb-note'\)[^;]*hint/s,
      `${file} 把字段说明画成了 nb-note（提示条）。字段说明要用 nb-field-hint，否则每个字段下面多一个框`,
    );
  }

  /* 正向：共用实现里确实是 nb-field-hint */
  const shared = stripComments(read('client/src/chat/field-row.ts'));
  assert.match(shared, /'nb-field-hint'/, '共用 fieldRow 里要用 nb-field-hint');
  assert.doesNotMatch(shared, /'nb-note'/, '共用 fieldRow 里不许出现 nb-note');
});

test('★★★ fieldRow 只许有一份实现（两份必然分叉）', () => {
  /*
   * 这个缺陷能存在，就是因为两份实现里只有一行不同。判据直接拦"再写一份"：
   * 除 `field-row.ts` 之外，任何文件里出现 `function fieldRow` 都算重复。
   */
  for (const file of PAGES) {
    const src = stripComments(read(file));
    assert.doesNotMatch(
      src,
      /function\s+fieldRow\s*\(/,
      `${file} 又定义了一份 fieldRow。请 import { fieldRow } from './field-row.ts'`,
    );
  }

  const shared = stripComments(read('client/src/chat/field-row.ts'));
  assert.match(shared, /export\s+function\s+fieldRow\s*\(/, 'field-row.ts 要导出 fieldRow');
});

test('★★★ 两个页面都从共用模块 import fieldRow', () => {
  for (const file of PAGES) {
    const src = stripComments(read(file));
    assert.match(
      src,
      /import\s*\{[^}]*\bfieldRow\b[^}]*\}\s*from\s*'\.\/field-row\.ts'/,
      `${file} 没有从 './field-row.ts' 引入 fieldRow`,
    );
  }
});

test('★★ 说明文字用 span 不用 p（p 自带上下外边距，在 gap 布局里会多一截）', () => {
  const shared = stripComments(read('client/src/chat/field-row.ts'));
  assert.match(shared, /el\(doc,\s*'span',\s*'nb-field-hint'\)/, '字段说明要用 span');
});

test('★★ 空串与 undefined 都不画说明（空串会留一条空白占位）', () => {
  const shared = stripComments(read('client/src/chat/field-row.ts'));
  assert.match(shared, /hintText\s*!==\s*undefined\s*&&\s*hintText\s*!==\s*''/, '要同时判空串');
});
