import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * 仓库行尾守卫：所有入库的 `.sh` 与 `.mjs` 必须是 LF。
 *
 * 两类文件踩的是同一个坑，只是暴露方式不同（`.mjs` 那半是 2026-10-29 补的，
 * 详见下面第二组测试的注释）。
 *
 * ## 为什么需要这条
 *
 * 2026-10-28（v0.1.7 阶段 0）加交叉编译脚本时，`git commit` 警告：
 * `LF will be replaced by CRLF the next time Git touches it`。
 *
 * 查下去发现是个**已经存在**的坑：`.gitattributes` 只给 `scripts/hooks/*`
 * 声明了 `eol=lf`，仓库里另外 16 个 `.sh` 全是 `unspecified`，
 * 而本机 `core.autocrlf=true` ⇒ 它们**重新检出时会被转成 CRLF**。
 *
 * 而且不是"将来才会坏"：查的那一刻就有 7 个工作区副本已经是 CRLF 了
 * （`scripts/capture-v14-faces.sh` 等），只是没人从 Linux 跑过它们。
 *
 * ## 为什么它特别难发现
 *
 * CRLF 的 shell 脚本在 **Windows 的 Git Bash 上能跑**（它对行尾有容忍），
 * 只在 Linux/WSL/CI 上炸：
 *
 * ```text
 * bash: ./build.sh: /bin/bash^M: bad interpreter: No such file or directory
 * ```
 *
 * 所以本地怎么测都是绿的，一路绿到 CI 或交叉编译宿主才红 ——
 * 而那时候排查的人根本不会想到"行尾"这件事。这类"环境特异 + 延迟暴露"
 * 的组合，正适合用一条静态断言钉死。
 *
 * ## 判据为什么用 `git check-attr` + `--eol` 而不是读文件字节
 *
 * 读工作区字节只能证明"现在是对的"，证明不了"下次检出还是对的" ——
 * 而**下次检出**才是真正出事的时刻。`check-attr` 问的是 Git 的规则，
 * `--eol` 报的是索引与工作区的实际状态，两者合起来才是完整判据。
 *
 * ## 实现注记：git 只 spawn 一次
 *
 * 第一版是每个文件 spawn 一次 `git ls-files --eol`，23 个文件在 Windows 上
 * 抛 `spawnSync git EBUSY`（本项目 memory §4 记过：EBUSY 只在捕获输出时出现）。
 * 改成**一次** `git ls-files --eol '*.sh'` 拿全部结果再解析 ——
 * 少 22 次进程创建，顺带绕开这个坑。
 */

/** 跑一次 git，返回 stdout。失败时把 stderr 带进断言消息，避免只看到 EBUSY。 */
function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`git ${args.join(' ')} 失败：${error.stderr?.toString() ?? error.message}`);
  }
}

test('所有入库的 .sh 都声明了 eol=lf（否则重新检出后在 Linux 上跑不起来）', () => {
  const root = join(import.meta.dirname, '..');
  const files = git(root, ['ls-files', '*.sh'])
    .split('\n')
    .filter((line) => line.trim() !== '');
  assert.ok(files.length > 0, '一个 .sh 都没找到？路径或 git 调用不对');

  const output = git(root, ['check-attr', 'eol', ...files]);
  const unspecified = output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .filter((line) => line.endsWith(': eol: unspecified'))
    .map((line) => line.replace(/: eol: unspecified$/, ''));

  assert.deepEqual(
    unspecified,
    [],
    '这些脚本没有 eol 声明，core.autocrlf=true 时会被检出成 CRLF，' +
      `在 Linux/WSL/CI 上会 bad interpreter：\n  ${unspecified.join('\n  ')}`,
  );
});

test('工作区里的 .sh 当前确实是 LF（不是 CRLF）', () => {
  /*
   * 上一条守的是"规则对不对"，这一条守的是"按规则落下来之后对不对"。
   * 两条都要有：规则对但工作区已被污染时，只有后者能发现 ——
   * 而这条正是当场抓到 7 个 CRLF 副本的那条。
   *
   * `git ls-files --eol` 输出形如：
   *   i/lf    w/lf    attr/text eol:lf    scripts/xxx.sh
   *   i/lf    w/crlf  attr/text eol=lf    scripts/yyy.sh   ← 工作区被污染
   */
  const root = join(import.meta.dirname, '..');
  const lines = git(root, ['ls-files', '--eol', '*.sh'])
    .split('\n')
    .filter((line) => line.trim() !== '');

  const bad = lines.filter((line) => !line.includes('w/lf'));
  assert.deepEqual(
    bad.map((line) => line.trim()),
    [],
    '这些脚本工作区里不是 LF（Windows 的 Git Bash 能容忍，Linux/CI 会 bad interpreter）：\n  ' +
      bad.map((line) => line.trim()).join('\n  '),
  );
});

/* ─────────────── .mjs：同族问题，2026-10-29 发现 ───────────────
 *
 * 与 `.sh` 完全同构：`.gitattributes` 只给 `*.sh` 声明了 eol，`.mjs` 是
 * `unspecified`，而本机 `core.autocrlf=true`。后果比 `.sh` 那次更隐蔽一档：
 *
 * 1. `package.json` 里全是 `node scripts/x.mjs` 的调用形式 —— **不经过 shebang**，
 *    所以 CRLF 的 .mjs 能正常跑，本机怎么测都是绿的；
 * 2. 只有 19 个 .mjs 带 `#!/usr/bin/env node`，在 Linux/CI 上 `./x.mjs` 直接执行时
 *    才会 `bad interpreter: /usr/bin/env node^M`；
 * 3. 而且当时已经有一个**真的坏了**：`scripts/lib/feature-sentinels.mjs` 的
 *    HEAD blob 本身就是 CRLF（521 CR / 515 LF，其中 6 行是历史转换事故留下的
 *    双 CR `\r\r\n`），即它被以 CRLF 形式提交进仓库了。
 *
 * ## 为什么这里守索引层、不像 .sh 那样守工作区
 *
 * `.sh` 要被执行，工作区状态直接决定能不能跑，所以那条必须看 `w/`。
 * `.mjs` 的执行判据在工作区上并不成立（见上，不经 shebang），
 * 而如果照抄"工作区必须 w/lf"，当前有 81 个 autocrlf 遗留的 `w/crlf` 会**假红** ——
 * 它们的内容在索引里是 LF，下次检出就会自愈，没有任何问题。
 *
 * 所以这里问的是"**提交进仓库的内容**是不是 LF"，也就是 CI 检出后会拿到什么。
 * 这正是本文件开头那条原则：断言内容，而不是它的当前表示。
 */

test('所有入库的 .mjs 都声明了 eol=lf（否则重新检出后在 Linux 上 bad interpreter）', () => {
  const root = join(import.meta.dirname, '..');
  const files = git(root, ['ls-files', '*.mjs'])
    .split('\n')
    .filter((line) => line.trim() !== '');
  assert.ok(files.length > 0, '一个 .mjs 都没找到？路径或 git 调用不对');

  const output = git(root, ['check-attr', 'eol', ...files]);
  const unspecified = output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .filter((line) => line.endsWith(': eol: unspecified'))
    .map((line) => line.replace(/: eol: unspecified$/, ''));

  assert.deepEqual(
    unspecified,
    [],
    '这些 .mjs 没有 eol 声明，core.autocrlf=true 时会被检出成 CRLF：\n  ' + unspecified.join('\n  '),
  );
});

test('索引里的 .mjs blob 都是 LF（这条才是 CI 检出后拿到的东西）', () => {
  /*
   * 只看 `i/` 列。`git ls-files --eol` 的两列语义：
   *   i/ = 索引（即将提交进仓库的内容）  ← 断言这一列
   *   w/ = 工作区（受 autocrlf 影响，可自愈）  ← 刻意不管
   *
   * 会出现 `i/-text`：git 的二进制启发式把文件判成二进制时不做行尾归一化，
   * 那种文件永远不会被"修好"，所以也当错误报出来。
   *
   * ## 判别力边界（实测过，别高估这一条）
   *
   * 本条查的是索引里**已存在的 blob**，而 `git add` 会先跑 clean filter 归一化。
   * 所以在 `core.autocrlf=true` 的本机上，一个新提交进去的 CRLF 文件会被当场
   * 转成 LF —— 这条**恒绿**，抓不到。实测确认：造一个 CRLF 的 .mjs 并 `git add`，
   * 报 `i/lf`。
   *
   * 它真正能红的两种情况（都实测过）：
   *   1. **历史遗留的坏 blob** —— 绕过了归一化提交进仓库的（`feature-sentinels.mjs`
   *      原来就是 `i/-text`）。用 `git hash-object -w --no-filters` +
   *      `git update-index --cacheinfo` 可复现，实测报 `i/crlf` → 本条红。
   *   2. `core.autocrlf=false` 的环境（Linux CI 默认）里，属性缺失时。
   *
   * 也就是说：**防新问题靠上一条（属性声明），本条负责考古。** 两条都要，
   * 但别把这条当成"提交前的保险"。
   */
  const root = join(import.meta.dirname, '..');
  const lines = git(root, ['ls-files', '--eol', '*.mjs'])
    .split('\n')
    .filter((line) => line.trim() !== '');

  const bad = lines.filter((line) => !line.startsWith('i/lf'));
  assert.deepEqual(
    bad.map((line) => line.trim()),
    [],
    '这些 .mjs 在索引里不是 LF（CI 检出后会拿到 CRLF，带 shebang 的执行会失败）：\n  ' +
      bad.map((line) => line.trim()).join('\n  '),
  );
});
