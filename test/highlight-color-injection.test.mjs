/**
 * 高亮颜色值的注入防线（2026-11-24）。
 *
 * ## 这次修的是什么
 *
 * 颜色值会被**三处**原样拼进标记：
 *
 * ```text
 *   shared/highlight-engine.ts  scopeCss()        → style="${style}"
 *   shared/highlight-engine.ts  renderInlineHtml() → theme 的 style 属性
 *   client/editor/highlight.ts  applySchemeStyles() → <style> 的 CSS 文本
 * ```
 *
 * 原来的 `COLOR_PATTERN` 用 `rgba?\([^)]+\)`，字符类是"除右括号外的一切"，
 * 于是下面这个值能过校验：
 *
 * ```text
 *   rgba(a" onmouseover="alert&#40;1&#41;")
 * ```
 *
 * 浏览器解析时 `style` 在第一个 `"` 处截断，`onmouseover` 成为真实事件属性，
 * `&#40;` / `&#41;` 解码成括号。桌面端被 Tauri CSP `script-src 'self'` 兜住，
 * 但 DOM 注入本身成立；换到任何去掉 CSP 的场景（浏览器预览、复用这套渲染层的页面）
 * 就是可执行的 XSS。
 *
 * ## 判据分三层
 *
 * ```text
 *   ① 解析层拒收          parseHighlightRule 报 error，方案根本装不进来
 *   ② 输出层兜底          scopeCss / renderInlineHtml 对非法值回落，绝不原样输出
 *   ③ 负向断言            产物里不得出现 onmouseover= / 裸引号 / 花括号
 * ```
 *
 * 只判 ① 不够：用户可能绕过解析层直接构造对象（测试、脚本、将来的导入通道）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compileHighlightRule,
  parseHighlightRule,
  renderInlineHtml,
  safeColorValue,
  scopeCss,
} from '../shared/dist/index.js';

/** 报告里手工复现过的载荷，外加同类变体 */
const PAYLOADS = [
  'rgba(a" onmouseover="alert&#40;1&#41;")',
  "rgba(a' onmouseover='alert(1)')",
  'red;}body{display:none}',
  '#fff;background:url(javascript:alert(1))',
  'rgb(0,0,0)\\";background:url(x)',
  'red<!--',
  'expression(alert(1))',
];

/** 合法值：收紧字符集不能把它们一起打死 */
const LEGIT = [
  '#fff',
  '#ffffff',
  '#a1b2c3d4',
  'rgba(255, 0, 0, 0.5)',
  'rgb(0 0 0 / 50%)',
  'hsl(120deg, 50%, 50%)',
  'red',
  'transparent',
  'currentColor',
];

function schemeWith(color) {
  return {
    schemaVersion: 1,
    id: 'evil-scheme',
    name: '注入测试',
    version: '1.0.0',
    theme: { foreground: color, background: color },
    scopes: [{ id: 'bad', label: '坏', color }],
    rules: [
      { id: 'r1', scope: 'bad', match: { type: 'word-list', words: ['hi'] } },
    ],
  };
}

test('★★★★★ 解析层：注入载荷必须被拒收（报 error）', () => {
  for (const payload of PAYLOADS) {
    const result = parseHighlightRule(schemeWith(payload));
    assert.equal(result.file, null, `载荷未被拒：${payload}`);
    assert.ok(result.errors.length > 0, `载荷未产生错误：${payload}`);
  }
});

test('★★★★ 解析层：合法颜色不得被误伤', () => {
  for (const color of LEGIT) {
    const result = parseHighlightRule(schemeWith(color));
    assert.notEqual(result.file, null, `合法值被拒：${color}（${result.errors.join('; ')}）`);
  }
});

test('★★★★★ 输出层：safeColorValue 非法值回落、合法值原样', () => {
  for (const payload of PAYLOADS) {
    assert.equal(safeColorValue(payload, 'FALLBACK'), 'FALLBACK', `未回落：${payload}`);
  }
  for (const color of LEGIT) {
    assert.equal(safeColorValue(color, 'FALLBACK'), color, `被误伤：${color}`);
  }
});

test('★★★★★ 输出层：renderInlineHtml 的产物不含可逃逸的引号与事件属性', () => {
  /*
   * 绕过解析层直接构造（模拟"未来某个新导入通道漏了校验"）：
   * 输出层必须自己兜住，不能指望上游。
   */
  const compiled = compileHighlightRule(schemeWith('rgba(a" onmouseover="alert(1)")'));
  const html = renderInlineHtml('hi there hi', compiled, { blockId: 'personality' });

  assert.ok(!/onmouseover\s*=/i.test(html), `产物里出现了事件属性：${html.slice(0, 200)}`);
  /*
   * 属性值里不该有裸双引号：`style="…"` 一旦被内部引号截断就逃逸。
   * 允许 `&quot;`（转义形式），不允许裸 `"` 出现在 style 的内容里。
   */
  const styleMatch = /style="([^"]*)"/.exec(html);
  if (styleMatch !== null) {
    assert.ok(!styleMatch[1].includes('"'), 'style 属性值内部含裸引号');
  }
  assert.ok(!/\{|\}/.test(html), `产物里出现了花括号（CSS 文本逃逸）：${html}`);
});

test('★★★★★ 输出层：scopeCss 对非法颜色回落，不输出原值', () => {
  const css = scopeCss({ color: 'red;}body{display:none}', backgroundColor: '#fff;background:url(x)' });
  assert.ok(!css.includes('}'), `scopeCss 输出含花括号：${css}`);
  assert.ok(!css.includes('display:none'), `scopeCss 透传了注入片段：${css}`);
});

test('★★★ 主题色同样走白名单（不是只管 scope.color）', () => {
  const compiled = compileHighlightRule(schemeWith('#123456'));
  // 直接把 theme 换掉，模拟"解析层被绕过"
  const tampered = { ...compiled, theme: { foreground: 'x"}', background: 'y{color:red}' } };
  const html = renderInlineHtml('hi', tampered, { blockId: 'personality' });
  assert.ok(!html.includes('x"}'), 'theme.foreground 未走白名单');
  assert.ok(!html.includes('color:red}'), 'theme.background 未走白名单');
});
