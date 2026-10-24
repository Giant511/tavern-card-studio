/**
 * 运行期写安装目录自检（F14.3 / T10.24）。
 *
 * ## 为什么要有它
 *
 * 卸载删不干净的根因不是"卸载动作不够狠"，而是**运行期往安装目录写了东西**：
 * 早期 `start-server.cmd` 直接把 `dataDir` 解析成 `cwd\data`，在安装目录里跑一次
 * 就在 Program Files 下生成了一个库（T10.15 已修，T10.23 负责清理遗留）。
 * 只清不防，等于每加一条新的写路径都要回头补一次清理动作。
 *
 * 所以这里做**检测**：服务跑起来之后，任何以安装目录为前缀的写入都被记下来并告警。
 *
 * ## 为什么是"快照比对"而不是"拦 fs 调用"
 *
 * 最直觉的写法是 monkey-patch `fs.writeFileSync` 之类。在 Node 的 ESM 下**行不通**：
 * `import { writeFileSync } from 'node:fs'` 的命名绑定在模块实例化时就从 CJS 导出
 * 快照下来了，之后再改 `fs.writeFileSync` 属性，已导入的绑定**不会**跟着变 ——
 * 于是补丁只对自己有用，而"自己"恰恰是唯一不需要防的那部分。
 *
 * 快照比对看的是**结果**：启动时给安装目录拍一张（路径 → 大小/mtime），运行中定期
 * 再拍一张，新增/改动的条目就是"被写过"。这比拦调用更强：
 *   · 子进程（git、eventcreate、杀软）写的东西一样能看见；
 *   · 不依赖任何模块内部实现，升级 Node 不会失效；
 *   · 可测：造文件、比快照，全是真实行为，不需要 mock 模块加载器。
 *
 * 代价：① 拿不到调用栈（只有路径），所以底下还有一条"配置项静态检查"补上
 * "是哪个配置键指进来的"；② 有轮询间隔（默认 60s），写入后最迟一个周期被发现。
 *
 * ## 告警但不阻断
 *
 * 它是**诊断工具，不是门卫**。写入照样成功、服务照样启动，只留痕迹：
 * 启动日志 warn + 应用程序事件日志。理由：把"某次写失败"升级成"服务起不来"，
 * 会让一个诊断问题变成一个可用性问题 —— 而且真正该修的是那条写路径，不是当下这一次。
 *
 * ## 白名单的取舍（与 T10.23 的删除白名单**不是**同一份）
 *
 * T10.23 的白名单是"这些是残留，卸载时删掉"；这里的白名单是"这些路径允许写"。
 * **故意不复用**：往安装目录写 `data\`、`logs\` 正是要抓的缺陷，把它设成"允许"
 * 等于把唯一的检测目标排除掉。默认白名单为空；只有当管理员**有意**把 `dataDir`
 * 指到安装目录里时，才用 `installDirWriteAllow` 显式放行（那种配置本身会在
 * "配置项静态检查"里先告警一次，放行只是不再重复刷屏）。
 */

import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { writeApplicationEvent } from './eventlog.js';

export type InstallDirIssueKind = 'config-path' | 'residue' | 'runtime-write';

export interface InstallDirIssue {
  kind: InstallDirIssueKind;
  /** 出问题的路径（配置检查里是配置值，其余是绝对路径） */
  path: string;
  /** 一句话说清"看到了什么" */
  detail: string;
  /** 建议动作（写给看日志的人，不是写给程序的） */
  hint: string;
}

// ────────────────────────────────────────────── 路径判定

/**
 * `child` 是否在 `parent` 之内（大小写不敏感，Windows 语义）。
 *
 * 为什么不能直接 `child.startsWith(parent)`：
 *   `C:\Program Files\Tavern Card Studio Server` 是另一个目录
 *   `C:\Program Files\Tavern Card Studio Server.backup` 的前缀 —— 前者删掉/清理时
 *   绝不能碰后者。这个坑在 T10.15 的布局判别里踩过（用 `data\config.json` 是否存在
 *   来猜布局），所以这里显式要求边界上是一个分隔符。
 */
export function isPathInside(parent: string, child: string): boolean {
  const root = resolve(parent).replace(/[\\/]+$/, '');
  const target = resolve(child);
  if (root.toLowerCase() === target.toLowerCase()) return true;
  const prefix = `${root}${process.platform === 'win32' ? '\\' : '/'}`.toLowerCase();
  return target.toLowerCase().startsWith(prefix);
}

/** 相对路径（相对安装目录，用 `/` 分隔）。不在里面时返回 null。 */
export function relativeToInstallDir(installDir: string, absPath: string): string | null {
  if (!isPathInside(installDir, absPath)) return null;
  const root = resolve(installDir).replace(/[\\/]+$/, '');
  return resolve(absPath).slice(root.length).replace(/^[\\/]+/, '').replace(/[\\/]+/g, '/') || '';
}

// ────────────────────────────────────────────── 1. 配置项静态检查

/**
 * 检查"会被写入的配置路径"是否落在安装目录里。
 *
 * 只看 `dataDir`：`rulesDir` 在 MSI 布局下**本来就在安装目录里**
 * （`%BASE%\app\rules`，见 installer/ServiceHost.xml 的 arguments），
 * 但它是**只读**的 —— 把它也拿来判会得到一个永远为真的告警，
 * 那种告警的结局是所有人都不看日志了。
 */
export function checkDataDirOutsideInstallDir(dataDir: string, installDir: string): InstallDirIssue | null {
  if (!isPathInside(installDir, dataDir)) return null;
  return {
    kind: 'config-path',
    path: dataDir,
    detail: `dataDir 落在安装目录内（${relativeToInstallDir(installDir, dataDir) || '.'}）`,
    hint:
      '把 dataDir 改到安装目录之外（默认 C:\\ProgramData\\TavernCardStudio）。' +
      '写在安装目录里的库、日志与仓库会在卸载时残留，且升级时可能被整体替换。',
  };
}

// ────────────────────────────────────────────── 2. 安装目录残留扫描

/**
 * 启动时扫安装目录顶层，找出 T10.23 那六类"运行期生成物"。
 *
 * 这是"上次运行写过安装目录"的证据 —— 比"这次写的时候抓现行"更早一步：
 * 大多数回归是**上一次**留下的，而残留会一直在那儿。
 *
 * 只扫顶层：`app\` 下是安装清单，递归进去只会读到正常文件。
 */
const RESIDUE_DIRS = new Set(['data', 'logs', 'cache', '.cache', 'tmp', 'temp']);
const RESIDUE_FILE = /\.(log|tmp|temp)$/i;

export function scanInstallDirResidue(installDir: string): InstallDirIssue[] {
  if (!existsSync(installDir)) return [];
  let names: string[];
  try {
    names = readdirSync(installDir);
  } catch {
    return [];
  }

  const issues: InstallDirIssue[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    let isDirectory = false;
    try {
      isDirectory = lstatSync(join(installDir, name)).isDirectory();
    } catch {
      continue;
    }
    const matches = isDirectory ? RESIDUE_DIRS.has(lower) : RESIDUE_FILE.test(name);
    if (!matches) continue;
    issues.push({
      kind: 'residue',
      path: join(installDir, name),
      detail: `安装目录里存在运行期生成物：${name}`,
      hint: '说明有代码路径在往安装目录写。本次启动不清理（清理归 tcs-server cleanup），但要查出写入者。',
    });
  }
  return issues;
}

// ────────────────────────────────────────────── 3. 运行期快照比对

export interface SnapshotEntry {
  size: number;
  mtimeMs: number;
}

export type InstallDirSnapshot = Map<string, SnapshotEntry>;

/**
 * 递归快照（相对路径 → 大小/mtime）。
 *
 * 不跟随符号链接/目录联接：跟随会把目标目录的整棵树拍进来，既慢又会让
 * "安装目录被写"这个判据失真（改的是别处的文件）。
 */
export function snapshotInstallDir(installDir: string, prefix = '', out: InstallDirSnapshot = new Map()): InstallDirSnapshot {
  const dir = prefix === '' ? installDir : join(installDir, prefix);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const relative = prefix === '' ? name : `${prefix}/${name}`;
    const absolute = join(dir, name);
    let info;
    try {
      info = lstatSync(absolute);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) {
      // 记一条但不进去：链接本身的时间戳变化也算"被改过"
      out.set(relative, { size: 0, mtimeMs: info.mtimeMs });
      continue;
    }
    if (info.isDirectory()) {
      snapshotInstallDir(installDir, relative, out);
      continue;
    }
    out.set(relative, { size: info.size, mtimeMs: info.mtimeMs });
  }
  return out;
}

/** 白名单匹配：相对路径前缀（目录）或整段相等（文件）。 */
function isAllowed(relativePath: string, allow: readonly string[]): boolean {
  const target = relativePath.toLowerCase();
  for (const raw of allow) {
    const entry = raw.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
    if (entry === '') continue;
    if (target === entry) return true;
    if (target.startsWith(`${entry}/`)) return true;
  }
  return false;
}

/**
 * 比对两张快照，返回"新增 / 内容变了"的条目。
 *
 * 只报这两类，**不报删除**：服务运行期删掉安装目录里的文件属于更严重的问题，
 * 但它不是本任务的检测目标（而且 MSI 升级会正常删文件，报出来全是噪音）。
 */
export function diffInstallDirSnapshot(
  before: InstallDirSnapshot,
  after: InstallDirSnapshot,
  options: { allow?: readonly string[] } = {},
): InstallDirIssue[] {
  const allow = options.allow ?? [];
  const issues: InstallDirIssue[] = [];
  for (const [relative, entry] of after) {
    if (isAllowed(relative, allow)) continue;
    const previous = before.get(relative);
    if (previous === undefined) {
      issues.push({
        kind: 'runtime-write',
        path: relative,
        detail: `运行期新增文件：${relative}（${entry.size} 字节）`,
        hint: '有代码路径在往安装目录写。查这条路径的来源（配置项 / 启动器 / 临时文件）。',
      });
      continue;
    }
    if (previous.size !== entry.size || previous.mtimeMs !== entry.mtimeMs) {
      issues.push({
        kind: 'runtime-write',
        path: relative,
        detail: `运行期改动了安装目录里的文件：${relative}（${previous.size} → ${entry.size} 字节）`,
        hint: '安装目录内的文件应是只读的。它被改写说明有写入路径，需要定位。',
      });
    }
  }
  return issues;
}

// ────────────────────────────────────────────── 4. 运行期监视

export interface InstallDirWatchOptions {
  installDir: string;
  /** 轮询间隔；默认 60_000。设 0 表示只在手动 poll() 时比对（测试用）。 */
  intervalMs?: number;
  /** 允许写入的相对路径前缀，默认空（见文件头"白名单的取舍"） */
  allow?: readonly string[];
  /** 每发现一条新问题调用一次（已去重） */
  onIssue: (issue: InstallDirIssue) => void;
  /** 注入事件日志写入器（测试用；默认走 eventcreate） */
  writeEventLog?: (message: string) => void;
  /** 注入时钟（测试用） */
  now?: () => Date;
}

export interface InstallDirWatch {
  /** 手动比对一次（也会做去重），返回本次新发现的问题 */
  poll: () => InstallDirIssue[];
  /** 停止轮询并恢复（不恢复任何全局状态 —— 本实现没有改动 fs） */
  stop: () => void;
  /** 累计去重键，便于测试断言 */
  seen: () => string[];
  /** 当前基线快照的条目数 */
  baselineSize: () => number;
}

/**
 * 启动运行期监视。
 *
 * 关键约束：任何内部异常都**不能**把服务带崩 —— 定时器回调里抛出的异常在 Node 里
 * 是未捕获异常，会让进程退出。这个模块的定位是诊断，它自己的失败必须只记一条
 * 日志（这里选择静默吞掉并在下一次 poll 重试，因为 logger 可能正是被观察的对象）。
 */
export function startInstallDirWatch(options: InstallDirWatchOptions): InstallDirWatch {
  const intervalMs = options.intervalMs ?? 60_000;
  const allow = options.allow ?? [];
  const seen = new Set<string>();
  let baseline = snapshotInstallDir(options.installDir);

  const poll = (): InstallDirIssue[] => {
    let current: InstallDirSnapshot;
    try {
      current = snapshotInstallDir(options.installDir);
    } catch {
      return [];
    }
    let found: InstallDirIssue[];
    try {
      found = diffInstallDirSnapshot(baseline, current, { allow });
    } catch {
      return [];
    }
    // 基线前移：同一个文件被反复改写时不该每个周期都告警一次，
    // 但"改动了"这件事本身已经在第一次被报出来了。
    baseline = current;

    const fresh: InstallDirIssue[] = [];
    for (const issue of found) {
      const key = `${issue.kind}:${issue.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(issue);
      try {
        options.onIssue(issue);
      } catch {
        // 告警通道自己失败不能影响服务（见函数头）
      }
      try {
        (options.writeEventLog ?? writeApplicationEvent)(
          `install-dir write detected: ${issue.detail}`,
        );
      } catch {
        // 事件日志需要管理员；失败只意味着少一条线索，不影响主流程
      }
    }
    return fresh;
  };

  let timer: NodeJS.Timeout | null = null;
  if (intervalMs > 0) {
    timer = setInterval(() => {
      poll();
    }, intervalMs);
    // 不能阻止进程退出：服务退出时不需要等这个定时器
    timer.unref?.();
  }

  return {
    poll,
    stop: () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    seen: () => [...seen],
    baselineSize: () => baseline.size,
  };
}

// ────────────────────────────────────────────── 汇总

/**
 * 启动时的一次性检查（配置项 + 残留），返回所有问题。
 * 与运行期监视分开：这两个问题在**启动那一刻**就能确定，不必等一轮轮询。
 */
export function checkInstallDirAtStartup(input: {
  installDir: string;
  dataDir: string;
}): InstallDirIssue[] {
  const issues: InstallDirIssue[] = [];
  const configIssue = checkDataDirOutsideInstallDir(input.dataDir, input.installDir);
  if (configIssue) issues.push(configIssue);
  issues.push(...scanInstallDirResidue(input.installDir));
  return issues;
}

/** 安装目录：MSI 与绿色包布局里 `node.exe` 都在根部，取它的目录即可。 */
export function installDirFromExecPath(execPath: string = process.execPath): string {
  const index = Math.max(execPath.lastIndexOf('\\'), execPath.lastIndexOf('/'));
  return index > 0 ? execPath.slice(0, index) : execPath;
}
