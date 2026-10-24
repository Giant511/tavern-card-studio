/**
 * T10.25 验证脚本（scripts/verify-t1025-uninstall.ps1）的守卫。
 *
 * 这个脚本只能在**提权真机**上发挥完整作用，所以 CI 与单测里跑不到它 —— 而它能
 * 坏掉的方式恰好都是"读起来没问题、用起来不对"：
 *
 *   1. **没有 UTF-8 BOM**：Windows PowerShell 5.1 无 BOM 时按 ANSI(cp936) 读 .ps1，
 *      中文全部乱码；更糟的是乱码里可能凑出引号，直接把脚本读成语法错误。
 *      本仓库另外三个带中文的 .ps1 都有 BOM，这是既有约定。
 *   2. **出现了删除动作**：用户明确要求"只读断言 + 不代替用户做删除动作"。
 *      一旦有人为了"自动清场"往里面写 Remove-Item，这个脚本就从证据工具变成
 *      破坏工具 —— 而且它跑在管理员会话里。
 *   3. **报告不落盘**：证据回收靠 report 文件，写不出来等于没验。
 *   4. **两轮的期望搞混**：DataKept / DataRemoved 的断言方向相反，写反了会得到
 *      "看起来通过"的假结论。
 *
 * 语法层面（PowerShell 解析器）在这里测不了 —— 本机 Node 无法 spawn 子进程，
 * 起不了 powershell.exe。那部分靠 `<PS>` 手工跑一次 Parser::ParseFile 验证，
 * 已记在 PLAN 的 T10.25 条目里。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const REPO = join(import.meta.dirname, '..');
const SCRIPT = join(REPO, 'scripts', 'verify-t1025-uninstall.ps1');

const raw = readFileSync(SCRIPT);
const text = raw.toString('utf8').replace(/^\uFEFF/, '');

test('脚本存在，且是带 BOM 的 UTF-8（PS 5.1 无 BOM 会把中文读成 ANSI）', () => {
  assert.ok(existsSync(SCRIPT));
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], '缺少 UTF-8 BOM');
  assert.ok(!text.includes('\uFFFD'), '文件里有替换字符（编码已损坏）');
  assert.match(text, /T10\.25/, '抬头应写明任务号');
});

test('三个 Phase 与两个 Expect 都在', () => {
  assert.match(text, /ValidateSet\('Guide', 'Setup', 'Check'\)/, '缺少 Phase 参数集');
  assert.match(text, /ValidateSet\('DataRemoved', 'DataKept'\)/, '缺少 Expect 参数集');
  for (const phase of ['Guide', 'Setup', 'Check']) {
    assert.match(text, new RegExp(`'${phase}'\\s*\\{`), `入口 switch 里缺少 ${phase} 分支`);
  }
  // 默认 Phase 必须是 Guide：不带参数直接跑不应产生任何写操作
  assert.match(text, /\[string\]\$Phase = 'Guide'/, '默认 Phase 应为 Guide');
});

test('不代替用户删除：脚本里没有任何删除动作', () => {
  // 先剥掉注释行：抬头里提到 `msiexec /qn` 是在解释"为什么脚本不代跑卸载"，
  // 那是说明文字，不是动作。断言只针对可执行部分。
  const code = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  const forbidden = [
    /\bRemove-Item\b/i,
    /\bRemove-ItemProperty\b/i,
    /\bdel\s+\/s/i,
    /\brmdir\b/i,
    /\bRemoveDirectory\b/i,
    /\bClear-RecycleBin\b/i,
    /\bStart-Process\s+msiexec\b/i, // 卸载必须由用户点，脚本不代为执行
    /\bmsiexec(\.exe)?\s+[\/x]/i,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(code, pattern, `脚本里出现了不允许的动作：${pattern}`);
  }
  // Setup 只创建，不清理。允许 New-Item / WriteAllText。
  assert.match(code, /New-Item -ItemType Directory/, 'Setup 需要创建残留夹具');
});

test('断言方向正确：DataKept 要求数据目录存在，DataRemoved 要求不存在', () => {
  // 找 Check 里按 Expect 分支的那一段
  assert.match(text, /if \(\$Expect -eq 'DataRemoved'\)[\s\S]*?Add-Check \(-not \$dataExists\)/,
    'DataRemoved 分支必须断言数据目录不存在');
  assert.match(text, /Add-Check \$dataExists '数据目录被保留'/,
    'DataKept 分支必须断言数据目录存在');
});

test('看的是"这一轮"的证据：只断言日志最后一块', () => {
  // 日志追加写，重试会留多块；拿第一块会把上一轮结论当本轮
  assert.match(text, /function Get-LastLogBlock/, '缺少最后一块解析');
  assert.match(text, /starts\[\$starts\.Count - 1\]/, '必须取最后一块的起点');
});

test('证据落盘：report 同时出 md 与 json，并且路径会打印给用户', () => {
  assert.match(text, /t1025-report-/, '报告文件名前缀不对');
  assert.match(text, /\.md"?\)/, '缺少 markdown 报告');
  assert.match(text, /\.json"?\)/, '缺少 json 报告');
  assert.match(text, /把这两个文件 \+ 截图一起发回来/, '结尾要告诉用户怎么交回证据');
  assert.match(text, /截图清单（手工）/, '报告里要有截图清单（脚本代替不了截图）');
});

test('不假设提权：Check 不强制管理员，Setup 才检查', () => {
  // Setup 必须检查管理员（要往 Program Files 写夹具）
  const setupBody = text.slice(text.indexOf('function Invoke-Setup'), text.indexOf('function Invoke-Check'));
  assert.match(setupBody, /Test-IsAdmin/, 'Setup 必须检查管理员权限');
  // Check 只读，任何用户都该能跑
  const checkBody = text.slice(text.indexOf('function Invoke-Check'));
  assert.doesNotMatch(checkBody, /if \(-not \(Test-IsAdmin\)\)/, 'Check 不应强制管理员');
});

test('中文与框线字符在 CP936 里可渲染（否则用户终端看到一堆问号）', () => {
  // ↳ ✔ ✘ 这类符号在 cp936 下渲染成 ?，会把提示语读成乱码 —— 已实测过
  for (const bad of ['\u21b3', '\u2714', '\u2718', '\u25b6']) {
    assert.ok(!text.includes(bad), `出现了终端渲染不了的字符：U+${bad.codePointAt(0).toString(16)}`);
  }
});
