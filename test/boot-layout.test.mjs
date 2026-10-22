/**
 * 布局骨架的静态一致性：`body` 的直接子元素个数 **必须等于**
 * `grid-template-rows` 声明的行数。
 *
 * 为什么要有这条测试（2026-10-22 的真实回归）：
 * T9.2 往 `body` 里插了标签栏，子元素从 4 个变成 5 个，但 CSS 仍写着
 * `grid-template-rows: auto auto minmax(0, 1fr) auto`（四行）。
 * 多出来的元素落进**隐式行**，于是 `minmax(0, 1fr)` 那一行被前面的同步条占掉：
 * 同步条被撑到几百像素高、主区挤成 `auto` 高度、内容溢出到视口外。
 * 表现是"顶部一大片空白"，而所有单元测试、类型检查、cargo check 全是绿的 ——
 * 只有看截图才发现。这条静态断言就是给这类"结构对不上"兜底的。
 *
 * 它不能替代截图验收（比如行内 `auto` 的顺序错了它看不出来），
 * 但能在"加了个兄弟节点却忘了改 CSS"时立刻响。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const ROOT = join(import.meta.dirname, '..');
function join(...parts) {
  return parts.join('/').replace(/\/+/g, '/');
}

const HTML = readFileSync(`${ROOT}/client/index.html`, 'utf8');
const CSS = readFileSync(`${ROOT}/client/src/styles.css`, 'utf8');

/** `body` 的直接子元素：本文件里它们都缩进 4 个空格 */
function bodyChildren() {
  const start = HTML.indexOf('<body');
  const end = HTML.lastIndexOf('</body>');
  assert.ok(start > 0 && end > start, 'index.html 里找不到 body');
  const body = HTML.slice(start, end);

  // 不参与布局的标签要排除：`<script>` 同样是 body 的子元素，
  // 但 UA 样式表给了它 display:none，不会占 grid 行。
  const NOT_RENDERED = new Set(['script', 'style', 'link', 'template', 'meta']);

  const tags = [];
  for (const line of body.split('\n')) {
    // 只认"缩进恰好 4 空格 + 以 < 开头"的行 = body 的直接子元素开头
    const match = /^ {4}<([a-zA-Z][\w-]*)\b/.exec(line);
    if (!match) continue;
    if (NOT_RENDERED.has(match[1].toLowerCase())) continue;
    tags.push({ tag: match[1], line: line.trim().slice(0, 60) });
  }
  return tags;
}

/** `grid-template-rows` 里声明的行数（`minmax(0, 1fr)` 含空格，不能直接 split） */
function declaredRows() {
  const match = /grid-template-rows:\s*([^;]+);/.exec(CSS);
  assert.ok(match, 'styles.css 里找不到 grid-template-rows');
  const value = match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
  const tokens = value.match(/minmax\([^)]*\)|repeat\([^)]*\)|auto|[\d.]+(fr|px|%|rem|vh)/g);
  assert.ok(tokens && tokens.length > 0, `无法解析 grid-template-rows：${value}`);
  return { tokens, value };
}

test('body 的直接子元素数与 grid-template-rows 的行数一致', () => {
  const children = bodyChildren();
  const { tokens, value } = declaredRows();

  assert.equal(
    children.length,
    tokens.length,
    `body 有 ${children.length} 个直接子元素（${children.map((c) => c.tag).join(', ')}），` +
      `但 grid-template-rows 只声明了 ${tokens.length} 行（${value}）。` +
      '多出来的元素会落进隐式行，把 1fr 那一行挤给别的元素 —— 表现是顶部出现大片空白。',
  );
});

test('body 的子元素顺序与预期一致（header / 标签栏 / 同步条 / 主区 / 状态栏）', () => {
  const tags = bodyChildren().map((child) => child.tag);
  assert.deepEqual(tags, ['header', 'div', 'div', 'main', 'footer'], `实际顺序：${tags.join(' → ')}`);

  // 第二、三个 div 必须是标签栏与同步条，否则"谁占 1fr"这件事又变了
  const hosts = bodyChildren().map((child) => child.line);
  assert.match(hosts[1], /id="tabbar-host"/, '第二个元素应是标签栏容器');
  assert.match(hosts[2], /id="sync-bar"/, '第三个元素应是同步状态条');
});

test('可变高度的行恰好一行（1fr），其余都是 auto', () => {
  const { tokens } = declaredRows();
  const flexible = tokens.filter((token) => token.includes('fr'));
  assert.equal(flexible.length, 1, `应该只有一行是 1fr，实际：${tokens.join(' ')}`);
  assert.match(flexible[0], /^minmax\(0,\s*1fr\)$/, '主区那一行要写成 minmax(0, 1fr)，否则内容会把行撑开');
});
