// 运维/部署文档的守卫。
//
// 为什么要有这个文件：
//   1. `docs/server-cmd.md` 等是随仓库上传的少数几份 docs，它们同时是用户的入口。
//      命令面一变而它没跟着变，用户照着敲就会失败 —— 而没有任何编译/类型检查会因此报错
//      （2026-10-23 已经因为同类原因连续踩过：说明页停在 v0.1.1、
//      命令名写成产物里不存在的 `tcs-server`）。
//   2. `.gitignore` 用 `docs/*` + `!docs/<文件名>` 精确放行指定文件。
//      这条规则很脆：写回 `docs/`（目录）就会让例外失效，多写一个 `!` 就会
//      把开发文档泄漏到公开仓库。
//
// 判据全部基于**文件内容**，不调用 git —— 本机 `execFileSync('git', …)` 返回 EBUSY
// （`spawnSync` 的同步路径走不通；**异步 `spawn` 是可用的**，端到端脚本靠它起服务端）。

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const DOC = join(ROOT, 'docs', 'server-cmd.md');
const DEV_DOC = join(ROOT, 'docs', 'server-developer.md');
const CLOUD_DOC = join(ROOT, 'docs', 'Cloud Deployment Manual.md');
const CLI = join(ROOT, 'server', 'src', 'cli.ts');
const GITIGNORE = join(ROOT, '.gitignore');

/** 允许随仓库上传的 docs 文件（相对仓库根，正斜杠）。新增上传项必须同时改这里。 */
const PUBLISHED_DOCS = [
  'docs/server-cmd.md',
  'docs/server-developer.md',
  'docs/Cloud Deployment Manual.md',
];

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
    // 末尾的 `[...]` 是可选的参数提示（如 `cleanup [--dry-run]`）。
    //
    // 漏掉这一段会让整行**静默逃过本守卫**：`cleanup [--dry-run]` 这种写法里，
    // 命令名后面只有一个空格再接 `[`，原正则要求命令名后紧跟两个空格，
    // 于是匹配失败、`continue` 掉 —— 命令没进清单，手册漏写也不会红。
    // 2026-10-24 加 `cleanup` 时实测到这一点（当时手册里根本没有它，本用例却是绿的）。
    const match = /^\s*`\s{2}([a-z]+(?: [a-z|]+)?)(?: \[[^\]]*\])?\s{2}/.exec(line);
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
  assert.ok(doc.length > 2000, 'docs/server-cmd.md 缺失或过短');
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

test('.gitignore：docs 只放行名单内的文件，其余一律本地', () => {
  const lines = gitignore.split(/\r?\n/).map((line) => line.trim());

  // 目录级排除会让所有 `!` 失效 —— 必须排除"目录内容"
  assert.ok(lines.includes('docs/*'), '必须是 docs/*（写 docs/ 会让例外失效）');
  assert.ok(!lines.includes('docs/'), '不能出现裸 docs/：目录一旦被忽略，!docs/… 全部失效');

  const exceptions = lines.filter((line) => line.startsWith('!docs/'));
  assert.deepEqual(
    exceptions,
    PUBLISHED_DOCS.map((path) => `!${path}`),
    'docs 下的放行清单与 PUBLISHED_DOCS 不一致；新增上传项需同时改两处',
  );
});

test('放行的 docs 文件都真实存在（写错名字会静默少传一份文档）', () => {
  for (const path of PUBLISHED_DOCS) {
    assert.ok(existsSync(join(ROOT, path)), `${path} 不存在 —— .gitignore 放行了一个不存在的文件`);
  }
});

/**
 * 云部署手册的守卫（v0.1.3 新增，随仓库发布）。
 *
 * 这份文件的特殊性：它**教用户配反代**，而反代配错的症状全是"能用但行为诡异"
 * （限速全局化、令牌从公网取走）。所以判据不是"文件存在"，而是"关键内容在不在"：
 * 三种代理是否并列、Apache 是不是真的双 vhost、`trustProxy` 的两个事故有没有写、
 * 以及那条已知文案问题有没有登记成 v0.1.4 需求。
 */
test('云部署手册：必备章节齐全', () => {
  const cloud = existsSync(CLOUD_DOC) ? readFileSync(CLOUD_DOC, 'utf8') : '';
  assert.ok(cloud.length > 4000, '云部署手册缺失或过短');
  assert.match(cloud, /维护约定/, '必须写明维护约定：影响部署行为的改动要同步本文件');

  // 三选一，且三种代理并列（章节号固定，便于交叉引用）
  assert.match(cloud, /三选一即可/, '必须明说三种反代任选其一');
  for (const heading of ['### 2.1 Caddy', '### 2.2 nginx', '### 2.3 Apache']) {
    assert.ok(cloud.includes(heading), `缺少章节：${heading}`);
  }

  // Apache 必须是"双 vhost 完整配置"，不是片段
  assert.ok(
    cloud.includes('<VirtualHost *:80>') && cloud.includes('<VirtualHost *:443>'),
    'Apache 章节必须给完整的两个 vhost（80 + 443），只给 ProxyPass 片段等于没给',
  );

  // trustProxy：两个事故场景都要在（这是"不配会怎样"的判据）
  assert.match(cloud, /事故一/, '缺少 trustProxy 事故一');
  assert.match(cloud, /事故二/, '缺少 trustProxy 事故二');
  assert.match(cloud, /锁定|限速/, '事故一必须说清"限速按 IP 分桶"的机制');
  assert.match(cloud, /\/api\/token/, '事故二必须点名 /api/token');
  assert.ok(
    cloud.includes('Require all denied') || cloud.includes('return 403') || cloud.includes('respond @token 403'),
    '三份代理配置都必须显式挡掉 /api/token（纵深防御）',
  );

  // 已知交互 + v0.1.4 需求
  assert.match(cloud, /TLS 由反代终止/, '必须写明"反代终止 TLS"的应有文案');
  assert.match(cloud, /v0\.1\.4/, '未实现的部分必须登记为 v0.1.4 需求');
});

test('云部署手册：代码围栏外不出现会被当成 HTML 的尖括号', () => {
  /*
   * 这份文档会发布到 GitHub。围栏外写 `host=<地址>` 这类内容时，GitHub 会把
   * `<地址>` 当 HTML 标签**直接吃掉** —— 本地用编辑器预览、或用只看纯文本的
   * 工具检查，都发现不了；只有真在网页上看才缺一块内容。
   * 判据：去掉行内代码与围栏后，不应再出现 `<` + 标签名。
   */
  const cloud = existsSync(CLOUD_DOC) ? readFileSync(CLOUD_DOC, 'utf8') : '';
  let inFence = false;
  const offenders = [];
  cloud.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const withoutInlineCode = line.replace(/`[^`]*`/g, '');
    if (/<\/?[a-zA-Z]/.test(withoutInlineCode)) offenders.push(`第 ${index + 1} 行：${line.trim().slice(0, 60)}`);
  });
  assert.deepEqual(offenders, [], `这些行会被 GitHub 当成 HTML 吞掉：\n${offenders.join('\n')}`);
});

test('云部署手册不得含本机路径 / 内网地址（它是要公开的）', () => {
  const cloud = existsSync(CLOUD_DOC) ? readFileSync(CLOUD_DOC, 'utf8') : '';
  const offenders = [];
  for (const [pattern, why] of [
    [/192\.168\.\d+\.\d+/g, '内网地址'],
    [/D:[\\/]Claw/gi, '本机工作目录'],
    [/C:[\\/]Users[\\/]/gi, '本机用户目录'],
    [/\.workbuddy/gi, '本机工具目录'],
    [/tcr_[A-Za-z0-9]{20,}/g, '疑似真实仓库令牌'],
    [/[0-9a-f]{64}/g, '疑似 64 位十六进制密钥'],
  ]) {
    const found = cloud.match(pattern);
    if (found) offenders.push(`${why}: ${found.slice(0, 3).join('、')}`);
  }
  assert.deepEqual(offenders, [], `公开文档里出现了本机信息：\n${offenders.join('\n')}`);
});

test('手册里提到的文件都真实存在（命令名写错就没有这份文档）', () => {
  assert.ok(existsSync(join(ROOT, 'scripts', 'bundle-launchers.mjs')), '启动器生成器缺失');
  assert.ok(existsSync(join(ROOT, 'installer', 'install-layout.ini')), '安装布局标记缺失');
  assert.ok(existsSync(join(ROOT, 'installer', 'connect-guide.html')), '安装说明页缺失');
});
