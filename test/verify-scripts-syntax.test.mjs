/**
 * `.verify/*.mjs` 里「模板字符串内注释不许出现反引号」的判据（2026-11-04）。
 *
 * ## 为什么需要它
 *
 * 这个仓库的验收脚本大量使用这种形状：
 *
 * ```js
 * const r = await ev(`(async () => {
 *   // 页内代码
 * })()`);
 * ```
 *
 * 整段是**模板字符串**。于是在里面写注释时，任何反引号都会把字符串提前截断。
 *
 * 我在同一天**连续犯了三次**，症状不同：
 *
 * ```text
 *   第一次  注释里写 .nb-notify（带反引号）            → ReferenceError: notify is not defined
 *   第二次  注释里写 chara / ccv3（带反引号）          → SyntaxError: missing ) after argument list
 *   第三次  注释里写 String.fromCharCode（带反引号）    → 同一个 SyntaxError
 * ```
 *
 * 第一次是运行时崩，后两次是语法错。语法错还算走运 —— 被截断后**恰好仍然合法**
 * 的情况会让脚本静默跑错逻辑，那比崩溃难查得多。所以必须有一条判据直接盯规则本身。
 *
 * ## 为什么不用 `node --check` 全扫
 *
 * 试过：目录里 234 个脚本，每个起一次 node 进程（Windows 上每个上百毫秒），
 * 整条测试跑不完就被掐了。而"语法能不能过"改哪个脚本就会在用的时候暴露，
 * 这里要防的是**还没跑到就先写错** —— 纯文本扫描就够。
 *
 * ## 怎么避免误报
 *
 * 文件头的 Markdown 代码块用三个反引号标记（奇数个），任何"数奇偶"的实现
 * 都会被它带偏。所以这里只扫 **`ev(` 之后到该字符串闭合**这一段，
 * 且只认"行首是 `*` 或 `//`"的注释行。
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(REPO, '.verify');
const files = readdirSync(DIR).filter((name) => name.endsWith('.mjs'));

/** 在一段源码里找「页内模板的注释含反引号」的位置 */
function findOffenders(text) {
  const hits = [];
  let inside = false;

  text.split('\n').forEach((line, index) => {
    const ticks = line.split('`').length - 1;

    if (!inside) {
      /* 进入：这一行是 ev( 调用的开头，且反引号个数为奇（说明字符串从这里开始） */
      if (/\bev\(\s*`/.test(line) && ticks % 2 === 1) inside = true;
      return;
    }

    const stripped = line.trim();
    const isComment =
      stripped.startsWith('*') || stripped.startsWith('//') || stripped.startsWith('/*');

    if (isComment && ticks > 0) hits.push(index + 1);

    /* 收尾：本行的奇数个反引号意味着字符串在这一行闭合 */
    if (ticks % 2 === 1) inside = false;
  });

  return hits;
}

test('★★★ 页内模板（ev(...)）的注释里不许出现反引号', () => {
  const problems = [];

  for (const name of files) {
    const text = readFileSync(join(DIR, name), 'utf8');
    for (const line of findOffenders(text)) problems.push(`${name}:${String(line)}`);
  }

  assert.deepEqual(
    problems,
    [],
    '下面这些页内模板的注释里有反引号，会把模板字符串提前截断：\n' + problems.join('\n'),
  );
});

test('★★ 判据自检：三类写法都要判对', () => {
  /*
   * 判据最容易变成"永远绿"的东西。用三段人造源码证明它真的会区分。
   * 这是变异验证的轻量版 —— 不改仓库文件，直接喂字符串。
   */
  const cases = [
    /* ① 模板内注释带反引号 ⇒ 必须报 */
    {
      why: '模板内注释带反引号',
      text: 'const r = await ev(`(async () => {\n * 看 .nb-notify 在不在\n})()`);\n'.replace(
        '.nb-notify',
        '`.nb-notify`',
      ),
      expected: [2],
    },
    /* ② 模板内注释不带反引号 ⇒ 不报 */
    {
      why: '模板内注释不带反引号',
      text: 'const r = await ev(`(async () => {\n * 看 nb-notify 在不在\n})()`);\n',
      expected: [],
    },
    /* ③ 模板外的注释带反引号 ⇒ 不报 */
    {
      why: '模板外注释带反引号',
      text: '/** 看 `.nb-notify` */\nconst x = 1;\n',
      expected: [],
    },
  ];

  for (const one of cases) {
    assert.deepEqual(findOffenders(one.text), one.expected, `自检失败：${one.why}`);
  }
});
