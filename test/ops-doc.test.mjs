// 运维命令手册（docs/server cmd.md）的守卫。
//
// 为什么要有这个文件：
//   1. `docs/server cmd.md` 是**唯一**随仓库上传的 docs 文件，它同时是用户的
//      运维入口。命令面一变而它没跟着变，用户照着敲就会失败 —— 而没有任何
//      编译/类型检查会因此报错（2026-10-23 已经因为同类原因连续踩过：
//      说明页停在 v0.1.1、命令名写成产物里不存在的 `tcs-server`）。
//   2. `.gitignore` 用 `docs/*` + `!docs/server cmd.md` 精确放行一个文件。
//      这条规则很脆：写回 `docs/`（目录）就会让例外失效，多写一个 `!` 就会
//      把开发文档泄漏到公开仓库。
//
// 判据全部基于**文件内容**，不调用 git —— 本机 Node 无法 spawn 任何子进程
// （实测 `execFileSync('git', …)` 返回 EBUSY），靠 git 的断言在这里跑不起来。

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const DOC = join(ROOT, 'docs', 'server cmd.md');
const CLI = join(ROOT, 'server', 'src', 'cli.ts');
const GITIGNORE = join(ROOT, '.gitignore');

const doc = existsSync(DOC) ? readFileSync(DOC, 'utf8') : '';
const cli = readFileSync(CLI, 'utf8');
const gitignore = readFileSync(GITIGNORE, 'utf8');

/** 从 cli.ts 的内置帮助里取命令面（唯一来源，不在这里维护第二份清单） */
function helpCommands() {
  const start = cli.indexOf('命令：');
  const end = cli.indexOf('选项：', start);
  assert.ok(start > 0 && end > start, 'cli.ts 的 printHelp 结构变了，请同步本守卫');
  const block = cli.slice(start, end);
  const commands = [];
  for (const line of block.split('\n')) {
    const match = /^\s*`\s{2}([a-z]+(?: [a-z|]+)?)\s{2}/.exec(line);
    if (!match) continue;
    // `config show|path` → ['config show', 'config path']
    const [head, tail] = splitOnce(match[1].trim());
    if (tail === undefined) {
      commands.push(head);
      continue;
    }
    for (const variant of tail.split('|')) commands.push(`${head} ${variant}`);
  }
  return commands;
}

function splitOnce(text) {
  const at = text.indexOf(' ');
  return at < 0 ? [text, undefined] : [text.slice(0, at), text.slice(at + 1)];
}

/** 从 cli.ts 的"未知操作"报错里取 user / service 的子动作清单 */
function subActions(prefix) {
  const match = new RegExp(`未知的 ${prefix} 操作：[^（(]*[（(]([^）)]+)[）)]`).exec(cli);
  assert.ok(match, `cli.ts 里找不到 ${prefix} 的未知操作报错，请同步本守卫`);
  return match[1].split('/').map((item) => item.trim()).filter(Boolean);
}

test('文件存在，且带"随版本更新"的维护约定', () => {
  assert.ok(doc.length > 2000, 'docs/server cmd.md 缺失或过短');
  assert.match(doc, /维护约定/, '必须写明本文件随版本更新');
});

test('cli.ts 帮助里的每条命令都在手册中', () => {
  const commands = helpCommands();
  assert.ok(commands.length >= 8, `帮助里只解析出 ${String(commands.length)} 条命令，解析规则可能失效`);
  const missing = commands.filter((cmd) => !doc.includes(cmd));
  assert.deepEqual(missing, [], `手册缺少这些命令：${missing.join('、')}`);
});

test('user / service 的每个子动作都在手册中', () => {
  const users = subActions('user');
  const services = subActions('service');
  assert.ok(users.includes('migrate') && users.includes('adopt'), 'user 子动作解析异常');
  const missing = [
    ...users.map((action) => `user ${action}`),
    ...services.map((action) => `service ${action}`),
  ].filter((cmd) => !doc.includes(cmd));
  assert.deepEqual(missing, [], `手册缺少这些子动作：${missing.join('、')}`);
});

test('帮助里的每个选项都在手册的选项表里', () => {
  const start = cli.indexOf('选项：');
  const block = cli.slice(start, start + 2000);
  const flags = [...block.matchAll(/`\s+(--[a-z-]+)\s+</g)].map((match) => match[1]);
  assert.ok(flags.length >= 8, `只解析出 ${String(flags.length)} 个选项`);
  const missing = flags.filter((flag) => !doc.includes(flag));
  assert.deepEqual(missing, [], `手册缺少这些选项：${missing.join('、')}`);
});

test('主命令形态只用"装机就有"的东西：node.exe + app\\ + --config', () => {
  assert.match(doc, /\$tcs = "\.\\node\.exe", "\.\\app\\server\\dist\\index\.js"/, '缺少 $tcs 定义（或写成了别的形态）');
  assert.match(doc, /--config", "C:\\ProgramData\\TavernCardStudio\\config\.json"/, '必须显式给出 --config 与真实配置路径');
  assert.match(doc, /--config` 为什么必须写|`--config` 这一段不能省|--config 为什么必须写/, '必须解释 --config 省略的后果');
});

test('不教用户敲裸 tcs-server（产物里没有这个 exe）', () => {
  // 允许出现 `tcs-server.cmd`、`tcs-server 0.1.2`（版本输出）、`tcs-server <命令>`（帮助原文引用）
  const offenders = [];
  for (const line of doc.split('\n')) {
    const trimmed = line.trim();
    if (!/^(?:& )?\$?tcs-server\s/.test(trimmed)) continue;
    // 引用内置帮助/版本输出不算"教用户敲"
    if (/用法：|tcs-server 0\.1\.2 \(node/.test(trimmed)) continue;
    offenders.push(trimmed);
  }
  assert.deepEqual(offenders, [], `这些行在教用户敲裸 tcs-server：\n${offenders.join('\n')}`);
});

test('安全须知：密码只从 stdin、令牌可轮换、--bundle-root 不能省', () => {
  assert.match(doc, /密码只从标准输入读/, '必须写明密码不走命令行参数');
  assert.match(doc, /token rotate/, '必须给出轮换令牌的命令');
  assert.match(doc, /--bundle-root/, 'selfcheck 必须带 --bundle-root（否则假通过）');
  assert.match(doc, /REINSTALLMODE=amus/, '必须给出同版本强制重装的参数');
  assert.match(doc, /按 Ctrl\+C 停止/, '必须说明前台 serve 不是卡住');
});

test('.gitignore：docs 只放行 server cmd.md 这一个文件', () => {
  const lines = gitignore.split(/\r?\n/).map((line) => line.trim());

  // 目录级排除会让所有 `!` 失效 —— 必须排除"目录内容"
  assert.ok(lines.includes('docs/*'), '必须是 docs/*（写 docs/ 会让例外失效）');
  assert.ok(!lines.includes('docs/'), '不能出现裸 docs/：目录一旦被忽略，!docs/… 全部失效');

  const exceptions = lines.filter((line) => line.startsWith('!docs/'));
  assert.deepEqual(
    exceptions,
    ['!docs/server cmd.md'],
    'docs 下的放行清单只能有 server cmd.md；新增上传项需同时改本守卫',
  );
});

test('手册里提到的文件都真实存在（命令名写错就没有这份文档）', () => {
  assert.ok(existsSync(join(ROOT, 'scripts', 'bundle-launchers.mjs')), '启动器生成器缺失');
  assert.ok(existsSync(join(ROOT, 'installer', 'install-layout.ini')), '安装布局标记缺失');
  assert.ok(existsSync(join(ROOT, 'installer', 'connect-guide.html')), '安装说明页缺失');
});
