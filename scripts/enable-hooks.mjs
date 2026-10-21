/**
 * 启用仓库内的 git 钩子（pre-commit 校验 README 决策表序号）。
 *
 * 实现方式：**直接改 `.git/config`**，不 spawn git。
 *
 * 为什么不用 `git config core.hooksPath …`：
 *   在受管环境里 Node 可能根本无法 spawn git（本机实测：PortableGit 的 git.exe
 *   从 Node 调用恒返回 EBUSY，连 `cmd.exe /c echo` 都失败）。写配置文件是纯文件操作，
 *   不受这个限制，也更好测。
 *
 * 为什么用 Node 而不是 .ps1：
 *   Windows PowerShell 5.1 会把**无 BOM 的 .ps1** 按系统 ANSI 代码页解码，
 *   中文注释直接乱码并导致语法解析失败（本机实测过）。Node 没有这个坑。
 *
 * 用法：npm run enable:hooks
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS_PATH = 'scripts/hooks';

/** 找到 git 目录（支持 .git 为目录，或为 worktree/submodule 的 gitdir 指针文件） */
function resolveGitDir(repo) {
  const dotGit = join(repo, '.git');
  if (!existsSync(dotGit)) return null;

  const stat = statSync(dotGit);
  if (stat.isDirectory()) return dotGit;

  // .git 是文件：内容形如 `gitdir: ../.git/worktrees/xxx`
  const text = readFileSync(dotGit, 'utf8');
  const match = /^gitdir:\s*(.+)$/m.exec(text);
  if (!match) return null;
  const target = match[1].trim();
  return isAbsolute(target) ? target : resolve(repo, target);
}

/**
 * 在 ini 文本里设置 `[core] hooksPath`。
 * - 已有 `[core]` 段：段内替换或插入 hooksPath
 * - 没有 `[core]` 段：追加到末尾
 * 返回新文本（不写盘，便于单测）。
 */
export function setHooksPathInIni(iniText, hooksPath) {
  const lines = iniText.split('\n');
  const coreStart = lines.findIndex((line) => /^\s*\[core\]\s*$/i.test(line));

  if (coreStart === -1) {
    // 末尾补一个 [core] 段
    const trimmed = iniText.endsWith('\n') || iniText === '' ? iniText : `${iniText}\n`;
    return `${trimmed}[core]\n\thooksPath = ${hooksPath}\n`;
  }

  // 找 [core] 段的结束位置（下一个 [section] 或文件末尾）
  let coreEnd = lines.length;
  for (let i = coreStart + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[i])) {
      coreEnd = i;
      break;
    }
  }

  // 段内已有 hooksPath → 原地替换
  for (let i = coreStart + 1; i < coreEnd; i += 1) {
    if (/^\s*hooksPath\s*=/i.test(lines[i])) {
      lines[i] = `\thooksPath = ${hooksPath}`;
      return lines.join('\n');
    }
  }

  // 段内没有 → 插到段首（紧跟 [core] 之后）
  lines.splice(coreStart + 1, 0, `\thooksPath = ${hooksPath}`);
  return lines.join('\n');
}

function main() {
  const gitDir = resolveGitDir(REPO);
  if (!gitDir || !existsSync(gitDir)) {
    console.error('✘ 找不到 .git 目录：当前目录不是 git 仓库。');
    console.error(`  手动启用：在仓库根目录执行  git config core.hooksPath ${HOOKS_PATH}`);
    process.exit(1);
  }

  const hookFile = join(REPO, HOOKS_PATH, 'pre-commit');
  if (!existsSync(hookFile)) {
    console.error(`✘ 找不到钩子文件：${hookFile}`);
    process.exit(1);
  }

  const configPath = join(gitDir, 'config');
  if (!existsSync(configPath)) {
    console.error(`✘ 找不到 ${configPath}`);
    process.exit(1);
  }

  const before = readFileSync(configPath, 'utf8');
  const after = setHooksPathInIni(before, HOOKS_PATH);
  const changed = after !== before;

  if (changed) writeFileSync(configPath, after, 'utf8');

  // 回读校验，不靠"我以为写进去了"
  const verify = readFileSync(configPath, 'utf8');
  const ok = new RegExp(`^\\s*hooksPath\\s*=\\s*${HOOKS_PATH.replace(/\//g, '\\/')}\\s*$`, 'm').test(verify);
  if (!ok) {
    console.error('✘ 写入后回读未发现 hooksPath，配置可能未生效。');
    process.exit(1);
  }

  console.log(`${changed ? '✔ 已写入' : '✔ 已是目标值'}：${configPath}`);
  console.log(`  [core] hooksPath = ${HOOKS_PATH}`);
  console.log('  生效的钩子：pre-commit（改 README.md 时校验决策表序号）');
  console.log('');
  console.log('验证方式：修改 README.md 决策表后 git add && git commit，');
  console.log('应看到 [pre-commit] 输出"决策表序号连续"。');
}

// 只有直接运行时才执行（被 import 做单测时不跑）
const isCli = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isCli) main();
