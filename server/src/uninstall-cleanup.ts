/**
 * 卸载清理：`tcs-server cleanup`（F14.2 / T10.23）。
 *
 * ## 它解决的是哪一类问题
 *
 * Windows Installer 卸载时只删**它自己装的**文件（File 表）以及它创建过的空目录。
 * 凡是运行期生成的、不在文件清单里的东西，都会让安装目录"删不干净"：
 *
 *   · `data\`   —— 在安装目录里直接跑 `start-server.cmd`（绿色包布局的习惯）
 *                  时，配置默认落在 `cwd\data`，于是 Program Files 下多出一个库；
 *   · `logs\`、`cache\`、`tmp\` —— 运行期随手写的缓存与日志；
 *   · 顶层的 `*.log` / `*.tmp`。
 *
 * 这些目录里往往还留着用户的数据（`data\state.db` 有账户与卡片索引），所以
 * **不能**用"删掉安装目录下所有非清单文件"这种粗暴规则 —— 用户可能把自己的
 * 笔记、导出的卡放在安装目录里，而那属于用户文件。本模块因此只删**白名单**
 * 里的几类运行期生成物，其余一律保留并记录。
 *
 * ## 为什么不用 PowerShell 写
 *
 * 本机 Node **无法 spawn 任何子进程**（`spawnSync('cmd.exe', …)` 返回 EBUSY），
 * 所以写成 .ps1 的话，本仓库的单元测试**一行都跑不到它** —— 只能靠"读源文件断言
 * 里有某个字符串"，那种测试咬不住逻辑（排序错了、字节数算错了都不会红）。
 * 写成 TS 模块则可以真的建一堆文件、真的删一遍、真的读日志来断言。
 *
 * 代价：清理动作依赖安装目录里的 `node.exe` 与 `app\server\dist\`。卸载时它们
 * 都还在（本动作排在 `RemoveFiles` 之前），但若用户手删过，清理会失败 ——
 * 那种情况下 MSI 本来也会把整个目录清空，且调用方用 `Return="ignore"` 兜底。
 *
 * ## 日志落在哪（一个容易踩的坑）
 *
 * 首选 `<dataDir>\logs\uninstall-cleanup.log`，这样用户以后还能翻到。
 * 但**绝不创建 dataDir**：用户若勾了"同时删除数据"，dataDir 在清理之前就被删了，
 * 这里再建一次就会留下一个空的 `C:\ProgramData\TavernCardStudio`，
 * 让"卸载后全清"变成谎言。所以 dataDir 不存在时改写到 `%TEMP%`。
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// ────────────────────────────────────────────── 白名单（唯一来源）
//
// 只匹配**安装目录顶层**的名字：`app\` 下面全是安装清单内的文件，一旦允许
// 递归匹配，白名单就等于"整个安装目录"，误删风险立刻失控。
// 名字比对一律小写（Windows 文件系统不区分大小写）。

export type CleanupCategory = 'data' | 'logs' | 'cache' | 'temp' | 'logfile' | 'tmpfile';

export interface WhitelistRule {
  category: CleanupCategory;
  kind: 'dir' | 'file';
  /** 顶层名字判定（大小写不敏感） */
  matches: (name: string) => boolean;
  /** 写进日志的说明：为什么这一类算"运行期生成物" */
  note: string;
}

const lower = (name: string): string => name.toLowerCase();

export const CLEANUP_WHITELIST: readonly WhitelistRule[] = [
  {
    category: 'data',
    kind: 'dir',
    matches: (name) => lower(name) === 'data',
    note: 'green-bundle layout artefact: running the bundle in place writes config/state here',
  },
  {
    category: 'logs',
    kind: 'dir',
    matches: (name) => lower(name) === 'logs',
    note: 'runtime log directory created inside the install dir',
  },
  {
    category: 'cache',
    kind: 'dir',
    matches: (name) => lower(name) === 'cache' || lower(name) === '.cache',
    note: 'runtime cache directory',
  },
  {
    category: 'temp',
    kind: 'dir',
    matches: (name) => lower(name) === 'tmp' || lower(name) === 'temp',
    note: 'runtime temporary directory',
  },
  {
    category: 'logfile',
    kind: 'file',
    matches: (name) => /\.log$/i.test(name),
    note: 'top-level *.log left behind by a foreground run',
  },
  {
    category: 'tmpfile',
    kind: 'file',
    matches: (name) => /\.(tmp|temp)$/i.test(name),
    note: 'top-level *.tmp / *.temp',
  },
];

/**
 * 判定安装目录顶层的一个条目是否属于白名单。
 * 不在名单里 → `null`（保留，只记录）。
 */
export function classifyEntry(name: string, isDirectory: boolean): WhitelistRule | null {
  for (const rule of CLEANUP_WHITELIST) {
    if (rule.kind === 'dir' && !isDirectory) continue;
    if (rule.kind === 'file' && isDirectory) continue;
    if (rule.matches(name)) return rule;
  }
  return null;
}

// ────────────────────────────────────────────── 结果结构

export interface CleanupEntry {
  /** 相对安装目录的路径，用 `/` 分隔，便于断言与阅读 */
  path: string;
  category: CleanupCategory;
  kind: 'dir' | 'file';
  bytes: number;
  files: number;
  removed: boolean;
  /** 删除失败的原因（只有失败时才有） */
  reason?: string;
  /** 是符号链接/目录联接时只删链接本身，不递归进去 */
  link?: boolean;
}

export interface KeptEntry {
  path: string;
  kind: 'dir' | 'file';
  bytes: number;
}

export interface CleanupResult {
  installDir: string;
  logPath: string;
  entries: CleanupEntry[];
  kept: KeptEntry[];
  removedBytes: number;
  removedFiles: number;
  failed: number;
  /** 事件日志的写入结果：'skipped' / 'written' / 'failed: …' */
  eventLog: string;
  /** installDir 不存在时为 true（此时什么都没做） */
  missingDir?: boolean;
  /** 干跑：清单算出来了但一个都没删 */
  dryRun?: boolean;
}

export interface CleanupOptions {
  installDir: string;
  /** 数据目录（日志首选位置）。**不会被创建** —— 见文件头注释。 */
  dataDir?: string;
  /** dataDir 不可用时的日志落点，默认 `%TEMP%\TavernCardStudio-uninstall-cleanup.log` */
  fallbackLogPath?: string;
  /** 写入 Windows 应用程序事件日志（需要管理员；失败只记录不改结果） */
  eventLog?: boolean;
  now?: Date;
  /** 注入删除器：测试用它构造"删不掉"，生产走真实 rmSync */
  remove?: (absPath: string, isDirectory: boolean) => void;
  /** 注入事件日志写入器（测试用） */
  writeEventLog?: (message: string) => void;
  /** 干跑时置 true：不写日志文件 */
  noLog?: boolean;
}

// ────────────────────────────────────────────── 度量

function measure(absPath: string): { bytes: number; files: number; link: boolean } {
  let info;
  try {
    info = lstatSync(absPath);
  } catch {
    return { bytes: 0, files: 0, link: false };
  }
  // 符号链接 / 目录联接：**不进去**。递归进去就可能删到目标目录里的东西
  // （例如用户把 data 做成目录联接指向真正的库），而"删链接"本身已经足够。
  if (info.isSymbolicLink()) return { bytes: 0, files: 0, link: true };
  if (!info.isDirectory()) return { bytes: info.size, files: 1, link: false };

  let bytes = 0;
  let files = 0;
  let names: string[] = [];
  try {
    names = readdirSync(absPath);
  } catch {
    return { bytes: 0, files: 0, link: false };
  }
  for (const name of names) {
    const child = measure(join(absPath, name));
    bytes += child.bytes;
    files += child.files;
  }
  return { bytes, files, link: false };
}

/** 人类可读的字节数。日志是给人看的，`4120033` 不如 `3.9 MB` 直观。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

// ────────────────────────────────────────────── 日志落点

/**
 * 决定日志写哪里。
 *
 * 关键约束：**不创建 dataDir**。勾了"删除数据"时 dataDir 已经不在，
 * 这里 `mkdir -p` 会把 `C:\ProgramData\TavernCardStudio` 重新建出来，
 * 于是"卸载后全清"不成立（T10.25 要断言这条）。
 */
export function resolveLogPath(options: { dataDir?: string; fallbackLogPath?: string }): string {
  if (options.dataDir && existsSync(options.dataDir)) {
    const dir = join(options.dataDir, 'logs');
    try {
      mkdirSync(dir, { recursive: true });
      return join(dir, 'uninstall-cleanup.log');
    } catch {
      // 建不出来（权限/只读）就退回临时目录，不在这里抛
    }
  }
  return options.fallbackLogPath ?? join(tmpdir(), 'TavernCardStudio-uninstall-cleanup.log');
}

// ────────────────────────────────────────────── 日志正文

const pad = (text: string, width: number): string => (text.length >= width ? text : text + ' '.repeat(width - text.length));

/** 把一次清理结果格式化成日志正文（纯函数，便于断言） */
export function formatCleanupLog(result: CleanupResult, startedAt: Date): string {
  const lines: string[] = [];
  lines.push(`=== Tavern Card Studio uninstall cleanup — ${startedAt.toISOString()} ===`);
  lines.push(`install dir : ${result.installDir}`);
  lines.push(`log file    : ${result.logPath}`);
  lines.push(`policy      : whitelist only (${CLEANUP_WHITELIST.map((rule) => `${rule.kind}:${rule.category}`).join(', ')})`);
  lines.push('');

  if (result.missingDir) {
    lines.push('install dir does not exist or is unreadable — nothing was cleaned.');
    lines.push('');
    return `${lines.join('\n')}\n`;
  }

  if (result.entries.length === 0) {
    lines.push('whitelisted leftovers: none');
  } else {
    lines.push('whitelisted leftovers:');
    for (const entry of result.entries) {
      // 干跑时既不能说 DELETED（没删），也不该说 FAILED（没失败）——
      // 状态词写错会让人以为清理出了问题，而这正是日志要回答的第一个问题。
      const status = result.dryRun ? 'PLANNED' : entry.removed ? 'DELETED' : 'FAILED ';
      const suffix = entry.link ? ' (link only)' : '';
      const size =
        entry.kind === 'dir' ? `${formatBytes(entry.bytes)} in ${entry.files} file(s)` : formatBytes(entry.bytes);
      lines.push(`  ${status} ${pad(entry.path, 24)} ${pad(size, 26)}${suffix}`.trimEnd());
      if (entry.reason && !result.dryRun) lines.push(`          reason: ${entry.reason}`);
    }
  }

  if (result.kept.length > 0) {
    lines.push('');
    lines.push('kept (not on the whitelist — listed for review, NOT deleted):');
    for (const entry of result.kept) {
      const size = entry.kind === 'dir' ? `${formatBytes(entry.bytes)} (dir)` : formatBytes(entry.bytes);
      lines.push(`  KEPT    ${pad(entry.path, 24)} ${size}`.trimEnd());
    }
  }

  lines.push('');
  lines.push(
    result.dryRun
      ? `planned: would delete ${result.entries.length} item(s) — nothing was deleted`
      : `summary: deleted ${result.removedFiles} file(s) / ${formatBytes(result.removedBytes)} in ` +
          `${result.entries.filter((entry) => entry.removed).length} item(s); kept ${result.kept.length} item(s); failed ${result.failed} item(s)`,
  );
  lines.push(`event log: ${result.eventLog}`);
  lines.push(`=== done ${new Date().toISOString()} ===`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

// ────────────────────────────────────────────── 主流程

function defaultRemove(absPath: string, isDirectory: boolean): void {
  const info = lstatSync(absPath);
  if (info.isSymbolicLink()) {
    // 目录联接要用 rmdirSync，文件符号链接用 unlinkSync —— 两者不能混用
    if (isDirectory) rmdirSync(absPath);
    else unlinkSync(absPath);
    return;
  }
  rmSync(absPath, { recursive: isDirectory, force: false });
}

/** 事件日志一行摘要：数据被清掉时文件日志可能在 %TEMP%，事件日志是第二条线索 */
function defaultEventLogWriter(message: string): void {
  const result = spawnSync(
    'eventcreate.exe',
    ['/T', 'INFORMATION', '/ID', '100', '/L', 'APPLICATION', '/SO', 'TavernCardStudio', '/D', message],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error((result.stderr || result.stdout || `eventcreate exited ${result.status}`).trim());
  }
}

/** 只扫描与清理，不写日志（干跑与正式流程共用，保证分类逻辑只有一份） */
function scanAndClean(options: CleanupOptions): CleanupResult {
  const installDir = resolve(options.installDir);
  const remove = options.remove ?? defaultRemove;

  const result: CleanupResult = {
    installDir,
    logPath: resolveLogPath({ dataDir: options.dataDir, fallbackLogPath: options.fallbackLogPath }),
    entries: [],
    kept: [],
    removedBytes: 0,
    removedFiles: 0,
    failed: 0,
    eventLog: 'skipped',
  };

  if (!existsSync(installDir)) {
    result.missingDir = true;
    return result;
  }

  let names: string[];
  try {
    names = readdirSync(installDir).sort();
  } catch {
    result.missingDir = true;
    return result;
  }

  for (const name of names) {
    const absPath = join(installDir, name);
    let isDirectory: boolean;
    let link = false;
    try {
      const info = lstatSync(absPath);
      link = info.isSymbolicLink();
      // 目录联接在 lstat 里是 symlink，要 stat 目标才知道它是不是目录
      isDirectory = info.isDirectory() || (link && statSync(absPath).isDirectory());
    } catch {
      // 连 stat 都读不到的条目：不碰它。删不删不该由"猜"决定。
      result.kept.push({ path: name, kind: 'file', bytes: 0 });
      continue;
    }

    const rule = classifyEntry(name, isDirectory);
    const measured = measure(absPath);

    if (!rule) {
      result.kept.push({ path: name, kind: isDirectory ? 'dir' : 'file', bytes: measured.bytes });
      continue;
    }

    const entry: CleanupEntry = {
      path: name,
      category: rule.category,
      kind: isDirectory ? 'dir' : 'file',
      bytes: measured.bytes,
      files: measured.files,
      removed: false,
    };
    if (link) entry.link = true;

    try {
      remove(absPath, isDirectory);
      entry.removed = true;
      result.removedBytes += measured.bytes;
      result.removedFiles += measured.files;
    } catch (error) {
      // 删不掉要记录**原因**（通常是 EBUSY / EPERM / 文件被占），但不抛出：
      // 卸载不能因为残留清不掉而回滚（与 MSI 侧 Return="ignore" 同一条原则）。
      const code = (error as NodeJS.ErrnoException).code;
      entry.reason = `${code ? `${code}: ` : ''}${error instanceof Error ? error.message : String(error)}`;
      result.failed += 1;
    }
    result.entries.push(entry);
  }

  return result;
}

function writeEventLogLine(result: CleanupResult, options: CleanupOptions): void {
  if (!options.eventLog) return;
  const summary =
    `uninstall cleanup: deleted ${result.removedFiles} file(s) / ${formatBytes(result.removedBytes)}, ` +
    `kept ${result.kept.length}, failed ${result.failed}`;
  try {
    (options.writeEventLog ?? defaultEventLogWriter)(summary);
    result.eventLog = 'written';
  } catch (error) {
    result.eventLog = `failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function writeLog(result: CleanupResult, startedAt: Date): void {
  const text = formatCleanupLog(result, startedAt);
  try {
    const dir = dirname(result.logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // 追加而不是覆盖：一次卸载可能因重试跑两遍，两遍都要留痕
    if (existsSync(result.logPath)) appendFileSync(result.logPath, text, 'utf8');
    else writeFileSync(result.logPath, text, 'utf8');
  } catch {
    // 日志写不进去也不能让清理失败（更不该让卸载回滚）。
    // 此时唯一的痕迹是事件日志（若开启）与 MSI 自己的卸载日志。
  }
}

export function runUninstallCleanup(options: CleanupOptions): CleanupResult {
  const startedAt = options.now ?? new Date();
  const result = scanAndClean(options);
  writeEventLogLine(result, options);
  if (!options.noLog) writeLog(result, startedAt);
  return result;
}

/**
 * 干跑：同一套分类逻辑，删除器换成只记录。**不删文件、不写日志**。
 * 给"我想先看看会删什么"的人用，也用于真机排障。
 */
export function previewUninstallCleanup(options: {
  installDir: string;
  dataDir?: string;
  fallbackLogPath?: string;
}): { result: CleanupResult; text: string } {
  const result = scanAndClean({
    ...options,
    noLog: true,
    remove: () => {
      // 干跑绝不能真删
    },
  });
  for (const entry of result.entries) {
    entry.removed = false;
  }
  result.removedBytes = 0;
  result.removedFiles = 0;
  result.dryRun = true;
  const text = formatCleanupLog(result, new Date()).replace(
    'whitelisted leftovers:',
    'whitelisted leftovers (dry-run — nothing was deleted):',
  );  return { result, text };
}

// ────────────────────────────────────────────── CLI 适配

export interface CleanupCommandOptions {
  installDir?: string;
  dataDir?: string;
  fallbackLogPath?: string;
  eventLog: boolean;
  dryRun: boolean;
}

function defaultInstallDir(): string {
  // MSI 布局里 node.exe 就在安装目录根部
  return dirname(process.execPath);
}

function defaultDataDir(): string | undefined {
  const programData = process.env['ProgramData'];
  return programData ? join(programData, 'TavernCardStudio') : undefined;
}

/**
 * `tcs-server cleanup` 的实现。
 *
 * 默认值刻意与 MSI 布局对齐，这样自定义动作里只需要传 `--event-log`，
 * 不必把安装路径与数据路径写死两份（写死两份就一定会漂）。
 */
export function cleanupCommand(options: CleanupCommandOptions): number {
  const installDir = options.installDir ?? defaultInstallDir();
  const dataDir = options.dataDir ?? defaultDataDir();

  if (options.dryRun) {
    const preview = previewUninstallCleanup({
      installDir,
      ...(dataDir ? { dataDir } : {}),
      ...(options.fallbackLogPath ? { fallbackLogPath: options.fallbackLogPath } : {}),
    });
    process.stdout.write(preview.text);
    process.stdout.write('dry-run: nothing was deleted and no log was written.\n');
    return 0;
  }

  const result = runUninstallCleanup({
    installDir,
    ...(dataDir ? { dataDir } : {}),
    ...(options.fallbackLogPath ? { fallbackLogPath: options.fallbackLogPath } : {}),
    eventLog: options.eventLog,
  });
  process.stdout.write(
    `cleanup: deleted ${result.removedFiles} file(s) / ${formatBytes(result.removedBytes)}; ` +
      `kept ${result.kept.length} item(s); failed ${result.failed} item(s)\n` +
      `log: ${result.logPath}\n`,
  );
  return 0;
}
