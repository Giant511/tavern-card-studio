/**
 * 审计面板「结构必须一直挂在容器里」的结构性测试（F6 防回归，2026-10-23）。
 *
 * 为什么要有这一层：F6 的故障形态是**完全静默**的 —— 数据算出来了、计数行也更新了、
 * 控制台一声不响，只是正文那五个区块被摘出了 DOM。浏览器侧的 DOM 断言能守住
 * 当前这条路径（见 scripts/verify-audit-panel.mjs 的 ④），但它需要起浏览器；
 * 而这类事故的诱因往往是一行"看起来无害"的清理代码。
 *
 * 所以这里补一道纯 Node 的源码守卫：
 *   ① `clear()` 不许用 `root.replaceChildren()` 清空容器
 *      （那是把区块本身摘掉，而它们的引用还留在类里，之后 render() 就往空气里写）；
 *   ② 必须存在 `ensureMounted()`，且 `render()` 开头调用它（自愈）；
 *   ③ 五个区块都要在构造函数里挂到容器上（少挂一个也不会报错，只会少一块内容）。
 *
 * 这类测试判据是"代码形状"而不是"行为"，看起来偏硬 —— 但它拦的正是
 * "行为无法观测"的那一类故障，和 test/boot-layout.test.mjs 拦 grid 行数是同一个理由。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const SOURCE = readFileSync(new URL('../client/src/audit/audit-panel.ts', import.meta.url), 'utf8');

/** 从 `name(...): void {`/`name(...) {` 开始，按大括号配对取出方法体 */
function methodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `源码里找不到 ${signature}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  throw new Error(`${signature} 的大括号没有配对`);
}

// ── ① clear() 不许摘掉容器结构 ────────────────────────────
test('clear() 不得用 root.replaceChildren() 清空容器（F6 的直接成因）', () => {
  const body = methodBody(SOURCE, 'clear(): void');
  assert.equal(
    /this\.root\s*\.\s*replaceChildren\s*\(/.test(body),
    false,
    'clear() 里出现了 this.root.replaceChildren()：会把五个区块摘出 DOM，' +
      '而它们的引用仍留在类里，之后 render() 全部写进游离节点（正文永久空白且不报错）。' +
      '清内容，不要清结构。',
  );
  // 反过来：它必须真的清掉内容，否则空工作台会残留上一张卡的问题列表
  assert.match(body, /this\.listEl\s*\.\s*replaceChildren\s*\(/, 'clear() 应当清空问题列表');
});

test('clear() 会重新挂载并给出"尚未审计"的摘要', () => {
  const body = methodBody(SOURCE, 'clear(): void');
  assert.match(body, /this\.ensureMounted\s*\(/, 'clear() 必须先 ensureMounted()');
  assert.match(body, /尚未审计/, 'clear() 应给出明确的空态文案');
});

// ── ② render() 自愈 ──────────────────────────────────────
test('render() 开头调用 ensureMounted()（写内容前先确认结构在 DOM 里）', () => {
  const body = methodBody(SOURCE, 'private render(): void');
  const firstStatement = body.split('\n').map((l) => l.trim()).filter((l) => l !== '' && l !== '{' && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))[0];
  assert.match(
    firstStatement ?? '',
    /this\.ensureMounted\(\)/,
    `render() 的第一句应当是 this.ensureMounted()，实际是：${firstStatement ?? '(空)'}`,
  );
});

test('ensureMounted() 把五个区块都挂回去', () => {
  const body = methodBody(SOURCE, 'private ensureMounted(): void');
  for (const field of ['this.summaryEl', 'this.filterBar', 'this.wordSection', 'this.listHead', 'this.listEl']) {
    assert.match(body, new RegExp(field.replace('.', '\\.')), `ensureMounted() 漏了 ${field}`);
  }
});

// ── ③ 构造时结构完整 ────────────────────────────────────
test('构造函数把这五个区块挂到容器上', () => {
  assert.match(
    SOURCE,
    /this\.root\.append\(\s*this\.summaryEl,\s*this\.filterBar,\s*this\.wordSection,\s*this\.listHead,\s*this\.listEl,?\s*\)/,
    '构造函数的 root.append(...) 应当挂载全部五个区块',
  );
});

test('listHead 是字段而不是局部变量（否则 ensureMounted 拿不到它）', () => {
  assert.match(SOURCE, /private readonly listHead: HTMLElement/, 'listHead 必须是类字段');
  assert.equal(
    /const listHead = el\(/.test(SOURCE),
    false,
    'listHead 不能是局部变量：clear() 之后要靠它把计数行重新挂回容器',
  );
});
