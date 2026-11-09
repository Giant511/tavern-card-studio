/**
 * `.ps1` 脚本的**定义前置**检查（2026-10-30）。
 *
 * ## 这条检查治的是什么
 *
 * `scripts/verify-uninstall-msi.ps1` 连续两次真机跑失败，第二次是：
 *
 * ```text
 * Stop-TcsService : 无法将"Stop-TcsService"项识别为 cmdlet、函数、
 * 脚本文件或可运行程序的名称。
 * ```
 *
 * 原因：那个 shell **按执行顺序创建函数，不做声明提升**。我为了改文案方便，
 * 把新增的函数塞在了调用它的位置附近（0.5 段之后），于是脚本跑到 0.5 时
 * 那个函数还没被定义。
 *
 * ## 为什么语法检查抓不到
 *
 * `Parser::ParseFile` 只做词法/语法分析 —— 上面前后的文件**语法完全合法**，
 * 它返回零错误。这类问题只能靠真跑发现，或者靠一条可执行的纪律提前拦住。
 *
 * 所以这里的纪律是：**一个脚本里，所有 `function` 定义必须出现在
 * 第一处 `step` 调用之前**。
 *
 * 为什么锚在 `step` 而不是"第一行可执行语句"：这些验证脚本的骨架就是
 * `step` 分段（0. 自检 / 1. 备份 / 2. 路径 A …），`step` 之前即"准备区"。
 * 用 `step` 当锚点简单、稳定、且与文件本身的可读结构一致。
 *
 * ## 局限（直说）
 *
 * 它只检查"定义是否都在调用之前"，**不检查函数体内的前向引用**——
 * 那种情况是合法的（函数体在被调用时才解析名字），不该报错。
 * 换句话说这条检查偏保守，只会放过"函数体引用后定义的函数"这一种真实情况，
 * 而不会误伤它。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const SCRIPT_DIR = join(ROOT, 'scripts');

/** 行号从 1 开始，便于直接对着编辑器看 */
function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

function scanScripts() {
  return readdirSync(SCRIPT_DIR)
    .filter((name) => name.toLowerCase().endsWith('.ps1'))
    .map((name) => ({ name, source: readFileSync(join(SCRIPT_DIR, name), 'utf8') }));
}

test('★ .ps1 里所有 function 定义都在第一处 step 调用之前', () => {
  const problems = [];

  for (const { name, source } of scanScripts()) {
    const stepMatch = /^step\s/m.exec(source);
    if (!stepMatch) continue; // 不用 step 骨架的脚本不适用本纪律

    const firstStepLine = lineOf(source, stepMatch.index);
    const defRe = /^function\s+([\w-]+)/gm;
    let defMail;
    while ((defMail = defRe.exec(source)) !== null) {
      const defLine = lineOf(source, defMail.index);
      if (defLine > firstStepLine) {
        problems.push(
          `${name}:${defLine} 定义了 ${defMail[1]}，但第一处 step 在第 ${firstStepLine} 行` +
            ` —— 执行到 step 之后才定义，调用时会 "CommandNotFoundException"`,
        );
      }
    }
  }

  assert.deepEqual(
    problems,
    [],
    `发现"定义晚于调用"的脚本（这类问题语法检查抓不到，只有真跑才崩）：\n  ${problems.join('\n  ')}`,
  );
});

test('每个 .ps1 的 function 名在同文件里不重复定义', () => {
  /*
   * 重复定义不报错，**后一个静默覆盖前一个**。
   * 这种 bug 的表现是"改了没生效"，比报错难查得多。
   */
  const problems = [];
  for (const { name, source } of scanScripts()) {
    const seen = new Map();
    const defRe = /^function\s+([\w-]+)/gm;
    let m;
    while ((m = defRe.exec(source)) !== null) {
      const fn = m[1];
      const line = lineOf(source, m.index);
      if (seen.has(fn)) {
        problems.push(`${name}: ${fn} 重复定义（第 ${seen.get(fn)} 行与第 ${line} 行，后者会静默覆盖）`);
      } else {
        seen.set(fn, line);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('verify-uninstall-msi.ps1 必须带 UTF-8 BOM', () => {
  /*
   * PS 5.1 默认按 ANSI(GBK) 读 .ps1。UTF-8 无 BOM 时中文全乱码、
   * **字符串引号被吃掉**，报错指向一堆字符偏移，与真实原因（编码）毫无关系。
   *
   * 这条检查放在这里而不是靠人记：`git` 不管 BOM，
   * 编辑器"另存为 UTF-8（无 BOM）"就坏。
   */
  const buf = readFileSync(join(SCRIPT_DIR, 'verify-uninstall-msi.ps1'));
  assert.equal(
    buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf,
    true,
    '缺少 UTF-8 BOM —— PS 5.1 会把中文读成乱码并吃掉引号',
  );
});
