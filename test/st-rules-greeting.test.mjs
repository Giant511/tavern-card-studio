/**
 * ST 规则包必须能拦住「别的平台写法」（2026-11-05，用户决定 3 + 5）。
 *
 * ## 为什么需要这条
 *
 * 用户报的那张卡是**桌面端按「别的平台规则」审计**、按 ST 格式导出的。
 * 查下来最讽刺的一点：
 *
 * ```text
 *   character-card-v3.json   ✅ 有 example-uses-start-marker
 *   chub.json                ✅ 有同名规则
 *   sillytavern.json          ❌ 一条都没有
 * ```
 *
 * **ST 原生规则包最不懂 ST** —— 用户选它审计就一路绿灯，于是带着
 * 「用户：」「角色：」（中文全角冒号）的卡就这么导出去了。
 * 而 ST 匹配不到说话人会把**整块示例静默丢掉**（不报错、不提示）。
 *
 * 所以这里钉两件事：
 *   1. `sillytavern.json` 必须有那几条规则，且都是 `warning`
 *      （`error` 会拦导出，存量卡一升级就被卡住，用户会很难受）
 *   2. 规则名必须与文档里引用的一致 —— 文档和规则两处写同一件事，
 *      不同名就必然分叉（§106.14 那个 `fieldRow` 两份实现的老路）
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const rules = JSON.parse(read('rules/platforms/sillytavern.json'));
const byId = new Map(rules.rules.map((one) => [one.id, one]));

test('★★★ ST 规则包必须检查对话示例的 <START>', () => {
  const rule = byId.get('example-uses-start-marker');
  assert.ok(rule !== undefined, 'sillytavern.json 缺少 example-uses-start-marker');
  assert.equal(rule.type, 'pattern-required');
  assert.equal(rule.scope, 'field:mes_example', '要落在 mes_example 字段上，不是整个板块');
  assert.equal(rule.severity, 'warning', '用 warning：error 会拦导出，存量卡一升级就被卡');
});

test('★★★ 必须拦住「用户：」「角色：」这类中文冒号说话人行', () => {
  /*
   * 这是那张卡的实际写法。ST 的 `parseExampleIntoIndividual` 只认
   * `startsWith(name1 + ':')`（半角冒号），中文冒号匹配不上 ⇒
   * 整块被静默丢弃。
   */
  const rule = byId.get('example-speaker-halfwidth-colon');
  assert.ok(rule !== undefined, '缺少 example-speaker-halfwidth-colon');
  assert.equal(rule.type, 'pattern-forbid');
  assert.equal(rule.severity, 'warning');

  /* 规则要真的能命中那张卡的写法 */
  const re = new RegExp(rule.pattern, rule.flags ?? '');
  assert.match('用户：(把咖啡推过去)"你又放凉了"', re, '应命中「用户：」');
  assert.match('角色：(瞥了一眼)"少管我"', re, '应命中「角色：」');
  assert.doesNotMatch('{{user}}: hello', re, '半角冒号的宏写法不该命中');
});

test('★★★ 必须拦住「{{char}}：」这种全角冒号', () => {
  /*
   * 写法已经用宏了，但冒号是全角 —— 同样匹配不上。
   * 这种"看起来完全正确"的写法最容易漏。
   */
  const rule = byId.get('example-macro-halfwidth-colon');
  assert.ok(rule !== undefined, '缺少 example-macro-halfwidth-colon');
  const re = new RegExp(rule.pattern, rule.flags ?? '');
  assert.match('{{char}}：你还没走？', re, '应命中全角冒号');
  assert.doesNotMatch('{{char}}: 你还没走？', re, '半角冒号不该命中');
});

test('★★ 开场白为空要有提示（它现在是新聊天的第一条消息）', () => {
  const rule = byId.get('first-mes-not-empty');
  assert.ok(rule !== undefined, '缺少 first-mes-not-empty');
  assert.equal(rule.severity, 'warning');
  assert.equal(rule.scope, 'field:first_mes');
});

test('★★★ 新增规则一律 warning，不许用 error 拦导出', () => {
  /*
   * 存量卡（比如用户那张）本来就长这样。给 error 会让"升级工具之后
   * 老卡导不出去"——那个体验比"没提示"更糟。
   */
  for (const id of [
    'example-uses-start-marker',
    'example-speaker-halfwidth-colon',
    'example-macro-halfwidth-colon',
    'first-mes-not-empty',
  ]) {
    assert.equal(byId.get(id)?.severity, 'warning', `${id} 的严重级必须是 warning`);
  }
});

test('★★★ 规则 id 要与 README 里引用的一致（同一件事不许写两处不同的名字）', () => {
  /*
   * 审计报告里每条问题都带 `ruleId`（`audit/types.ts:56`），
   * 所以文档可以逐条引用。**文档写的名字必须能在规则包里找到**，
   * 否则用户看到"规则 example-xxx 未通过"却在文档里搜不到。
   */
  const readme = read('README.md');
  const mentioned = [
    'example-uses-start-marker',
    'example-speaker-halfwidth-colon',
    'example-macro-halfwidth-colon',
    'first-mes-not-empty',
  ];
  for (const id of mentioned) {
    assert.ok(byId.has(id), `规则包里没有 ${id}`);
    assert.ok(readme.includes(id), `README 里没提到 ${id} —— 文档与规则必须同名，否则必然分叉`);
  }
});

test('★★ 规则里提到的写法要真的存在（不许引用不存在的规则类型）', () => {
  const types = new Set([
    'placeholder-min-count',
    'placeholder-forbid',
    'pattern-forbid',
    'pattern-required',
    'length',
    'non-empty',
    'forbidden-words',
  ]);
  for (const one of rules.rules) {
    assert.ok(types.has(one.type), `未知规则类型 ${String(one.type)}（${one.id}）`);
  }
});
