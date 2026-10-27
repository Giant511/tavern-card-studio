/**
 * 版本号字面量守护（v0.1.6 需求二：全仓清点，一处不漏）。
 *
 * ## 它防的是什么
 *
 * 2026-10-27 实测：服务端包名已经叫 `TavernCardStudioServer-0.1.5.msi`，
 * 而包里的 `SERVER_VERSION` 与 `server/package.json` 还停在 **0.1.3**；
 * 装完自动打开的 `connect-guide.html` 页标题写着 **0.1.2**（四版没动）。
 * 三处都不是"编译错误"，全是"看起来对"：包能打、服务能起、页面能打开，
 * 只有用户 / 支持人员去核对版本号时才发现对不上。
 *
 * ## 为什么不能只写「不许出现 v0.1.5」
 *
 * 那是把判据钉在**这一次的值**上：下一次升到 0.1.7 时它照样绿，
 * 而 0.1.6 会变成新的残留（这正是 connect-guide 那条测试的历史：
 * 断言写死 `0.1.2`，连升三版都没人改，测试一直在替漂移作保）。
 *
 * 所以主判据是**结构**的：所有"版本载体"都必须等于单一真源（根 `package.json`）。
 * 「不许残留 v0.1.5」只作为补网，拦那些不属于已知载体的裸字面量。
 *
 * ## 什么算"载体"，什么不算
 *
 * 载体 = 某个会被机器读走、或会被用户当"当前版本"读到的位置（见 `CARRIERS`）。
 * 不算 = 历史标注。区分方式很具体：
 *   · `since: '0.1.5'`（哨兵表里"该功能从哪版开始"）—— 记的是事实，升版不能改；
 *   · 行内写成「0.1.2 起…」—— 同上，是行为分界点；
 *   · 锁文件里**依赖**的版本（`http-body-util v0.1.5`）—— 与产品版本无关，
 *     改它等于伪造依赖，`Cargo.lock` / `package-lock.json` 因此整份不参与裸字面量扫描
 *     （产品自身在 `Cargo.lock` 里的那一条由 `tcs-shell` 载体单独校验）。
 *
 * ## 用法
 *
 *   node scripts/check-version-literal.mjs          # 人看
 *   npm run check:version                           # 同上
 *   import { checkVersionLiterals } from …          # 供 validate-config / 构建脚本 / 单测调用
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * 已被取代的产品版本号：不允许再以**裸值**出现在工作区。
 *
 * 维护规则：每次发布把**刚被取代**的那个版本追加进来。
 * 表只增不减 —— 清干净的旧值不会再回来，留着就是回归网。
 * （判断依据见文件头：带 `v` 前缀的、`since:` 的、"X 起"的历史语境都不算裸值。）
 */
export const SUPERSEDED = ['0.1.5'];

/** 参与文本扫描的扩展名 */
const TEXT_EXTENSIONS = [
  '.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.toml', '.lock',
  '.ps1', '.cmd', '.bat', '.sh', '.md', '.html', '.css', '.wxs', '.wxl',
  '.xml', '.yml', '.yaml', '.txt', '.ini', '.rtf', '.example',
];

/**
 * 扫描时整棵跳过的目录（都是"不是产品内容"或"由构建生成"的地方）。
 *
 * · node_modules / target / dist / build —— 依赖与构建产物，不是工作区内容；
 * · release —— 历次发布报告与旧 MSI，本来就要提旧版本号；
 * · .verify —— 本地取证脚本的输出；
 * · docs —— 内部开发文档（含本机路径与历史排障记录，不入库）；
 * · assets —— 界面截图；
 * · data / server/data —— 运行时目录（含明文令牌）；
 * · test —— 夹具的职责就是**构造任意版本号**（"解析 0.1.2 的卡"这类场景），
 *   把它们判成漂移只会逼人用 `'0.1.' + '5'` 这种写法绕过去。
 *   测试里真正危险的"把当前版本写死成期望值"由两条更强的判据兜住：
 *   载体一致性（本文件）与 `test/connect-guide.test.mjs` 里那条从真源派生的断言。
 */
const SKIP_DIRS = new Set([
  'node_modules', 'target', 'dist', 'build', 'out', 'release', '.verify',
  'docs', 'assets', 'data', '.git', '.tools', 'generated', 'obj', 'test',
]);

/** 跳过单个文件（本地内部文档，含大量历史版本号）。路径相对仓库根、正斜杠 */
const SKIP_FILES = new Set([
  'memory.md',
  'PLAN.md',
  'installer.zip',
  'package-lock.json',
  'client/src-tauri/Cargo.lock',
]);

/**
 * 版本载体清单。
 *
 * `read` 返回该载体里的版本字符串；找不到时返回 `null`（由调用方判为失败）。
 * `hint` 写"改这里是为了让谁看到" —— 失败信息里直接给出来，免得人对着路径猜。
 */
export const CARRIERS = [
  {
    file: 'package.json',
    where: 'version',
    hint: '单一真源：客户端打包脚本与 check:version 都以它为准',
    read: (root) => readJson(root, 'package.json')?.version,
  },
  {
    file: 'client/package.json',
    where: 'version',
    hint: '诊断日志里的「应用版本」由 Vite 内联这个字段（不硬编码）',
    read: (root) => readJson(root, 'client/package.json')?.version,
  },
  {
    file: 'shared/package.json',
    where: 'version',
    hint: 'workspace 包：与服务端/客户端同批交付，不能单独落后',
    read: (root) => readJson(root, 'shared/package.json')?.version,
  },
  {
    file: 'server/package.json',
    where: 'version',
    hint: '服务端包版本（MSI 文件名与自检报告都跟着它走）',
    read: (root) => readJson(root, 'server/package.json')?.version,
  },
  {
    file: 'client/src-tauri/tauri.conf.json',
    where: 'version',
    hint: '决定客户端 MSI 文件名（Tavern Card Studio_<v>_x64_en-US.msi）与「应用和功能」里的版本',
    read: (root) => readJson(root, 'client/src-tauri/tauri.conf.json')?.version,
  },
  {
    file: 'client/src-tauri/Cargo.toml',
    where: '[package].version',
    hint: '壳二进制版本（诊断日志里的「壳版本」）',
    read: (root) => readCargoPackageVersion(root, 'client/src-tauri/Cargo.toml'),
  },
  {
    file: 'client/src-tauri/Cargo.lock',
    where: '[[package]] tcs-shell',
    hint: '锁文件里本项目的版本（改了 Cargo.toml 却忘了它，cargo build 会自动同步）',
    read: (root) => readCargoLockPackageVersion(root, 'client/src-tauri/Cargo.lock', 'tcs-shell'),
  },
  {
    file: 'server/src/context.ts',
    where: 'SERVER_VERSION',
    hint: '服务端启动横幅 / --version / /api/health 都打印它（v0.1.5 时这里还停在 v0.1.3）',
    read: (root) => readMatch(root, 'server/src/context.ts', /SERVER_VERSION\s*=\s*'([^']+)'/),
  },
  {
    file: 'installer/build-msi.ps1',
    where: '$Version 默认值',
    hint: '决定服务端 MSI 文件名（TavernCardStudioServer-<v>.msi）与 ProductVersion',
    read: (root) => readMatch(root, 'installer/build-msi.ps1', /\$Version\s*=\s*'([^']+)'/),
  },
  {
    file: 'installer/connect-guide.html',
    where: '标题里的当前版本',
    hint: '装完服务端自动打开的第一页；写旧版会让用户以为装错了包',
    read: (root) => readMatch(root, 'installer/connect-guide.html', /服务端\s+(\d+\.\d+\.\d+)\s*·\s*如何连接/),
  },
];

/** 「X 起」「从 X 升级」这类历史语境：版本号是行为分界点，升版不该动它 */
const HISTORY_CONTEXT = /起|升级|更早|之前打出来|修复版|及以后/;

function readText(root, rel) {
  const path = join(root, rel);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function readJson(root, rel) {
  const raw = readText(root, rel);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 只认 `[package]` 段里的 version —— 依赖内联表的 `version = "…"` 不是产品版本 */
function readCargoPackageVersion(root, rel) {
  const raw = readText(root, rel);
  if (raw === null) return null;
  let inPackage = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inPackage = trimmed === '[package]';
      continue;
    }
    if (!inPackage) continue;
    const hit = /^version\s*=\s*"([^"]+)"/.exec(trimmed);
    if (hit) return hit[1];
  }
  return null;
}

/** Cargo.lock 里按包名取版本（`tcs-shell` 是产品自己，其余同名版本号都是依赖） */
function readCargoLockPackageVersion(root, rel, name) {
  const raw = readText(root, rel);
  if (raw === null) return null;
  const blocks = raw.split(/^\[\[package\]\]$/m);
  for (const block of blocks) {
    const nameHit = /^\s*name\s*=\s*"([^"]+)"/m.exec(block);
    if (!nameHit || nameHit[1] !== name) continue;
    const verHit = /^\s*version\s*=\s*"([^"]+)"/m.exec(block);
    if (verHit) return verHit[1];
  }
  return null;
}

function readMatch(root, rel, pattern) {
  const raw = readText(root, rel);
  if (raw === null) return null;
  const hit = pattern.exec(raw);
  return hit ? hit[1] : null;
}

/** 递归列出候选文本文件（相对路径统一用正斜杠） */
function listTextFiles(root, base = '') {
  const dir = base === '' ? root : join(root, base);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base === '' ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...listTextFiles(root, rel));
      continue;
    }
    if (SKIP_FILES.has(rel)) continue;
    if (!TEXT_EXTENSIONS.some((ext) => rel.toLowerCase().endsWith(ext))) continue;
    out.push(rel);
  }
  return out;
}

/**
 * 校验全部载体。
 *
 * @param {string} [root]
 * @returns {{
 *   ok: boolean,
 *   current: string|null,
 *   carriers: Array<{ file: string, where: string, got: string|null, ok: boolean, hint: string }>,
 *   problems: string[],
 * }}
 */
export function checkVersionLiterals(root = REPO_ROOT) {
  const problems = [];
  const current = readJson(root, 'package.json')?.version ?? null;
  if (typeof current !== 'string' || !/^\d+\.\d+\.\d+$/.test(current)) {
    return {
      ok: false,
      current: null,
      carriers: [],
      problems: ['根 package.json 的 version 缺失或不是三段式 —— 它是所有载体的单一真源，必须先修这里'],
    };
  }

  const carriers = CARRIERS.map((carrier) => {
    let got = null;
    try {
      got = carrier.read(root);
    } catch (error) {
      got = null;
      problems.push(`${carrier.file} 读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof got !== 'string' || got === '') {
      problems.push(`${carrier.file} 里找不到 ${carrier.where}（载体本来就该存在）—— ${carrier.hint}`);
      return { file: carrier.file, where: carrier.where, got: null, ok: false, hint: carrier.hint };
    }
    const same = got === current;
    if (!same) {
      problems.push(`${carrier.file} 的 ${carrier.where} 是 ${got}，应为 ${current} —— ${carrier.hint}`);
    }
    return { file: carrier.file, where: carrier.where, got, ok: same, hint: carrier.hint };
  });

  return { ok: problems.length === 0, current, carriers, problems };
}

/**
 * 已发布版本号的裸字面量不得残留。
 *
 * 「裸」= 前面不是 `v`/`V`/数字/点。`v0.1.5`（历史标注）与 `127.0.0.1`（IP）
 * 都不算。命中行若含 `since:` 或历史语境词（「X 起」「从 X 升级」）则放行。
 *
 * @param {string} [root]
 * @param {ReadonlyArray<string>} [versions]
 * @returns {{ ok: boolean, hits: Array<{ version: string, file: string, line: number, text: string }> }}
 */
export function findBareVersions(root = REPO_ROOT, versions = SUPERSEDED) {
  const hits = [];
  for (const rel of listTextFiles(root)) {
    let raw;
    try {
      raw = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    // 二进制文件（含 NUL）直接跳过：rtf/zip 之类可能命中扩展名但不是文本
    if (raw.includes('\u0000')) continue;
    const lines = raw.split(/\r?\n/);
    for (const version of versions) {
      const escaped = version.replace(/\./g, '\\.');
      const pattern = new RegExp(`(?<![vV\\d.])${escaped}(?![\\d.])`, 'g');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!pattern.test(line)) continue;
        pattern.lastIndex = 0;
        if (/\bsince\s*:/.test(line)) continue;
        if (HISTORY_CONTEXT.test(line)) continue;
        // 放行**只有这一行**：`SUPERSEDED` 的定义必须写出那个值，否则本脚本没法工作。
        // 不放行整个文件 —— 文件里其它地方写错（比如把真源读成 v0.1.5）仍然要红。
        if (rel === 'scripts/check-version-literal.mjs' && /^\s*export const SUPERSEDED\s*=/.test(line)) continue;
        hits.push({ version, file: rel, line: i + 1, text: line.trim().slice(0, 120) });
      }
    }
  }
  return { ok: hits.length === 0, hits };
}

/**
 * 当前版本相对"最新已发布 tag"的位置（决策 #232：升版判据绑在需求文档上）。
 *
 * 纯函数，只为了一件事：**让"已升版但还没发布"这个状态在动手时可见**。
 * 脚本永远看不到需求文档（它在仓库外、还可能已被移走），所以这里不做判断、
 * 只把事实摆出来 —— 该不该升由文档决定，人得自己核对一眼。
 *
 * @param {string} current 根 package.json 的版本
 * @param {string|null|undefined} latestTag 形如 `v0.1.5`；`null` = 读不到
 */
export function describeVersionBasis(current, latestTag) {
  const tagVersion = typeof latestTag === 'string' ? latestTag.trim().replace(/^v/i, '') : '';
  if (!/^\d+\.\d+\.\d+$/.test(tagVersion)) {
    return {
      kind: 'unknown',
      text: `版本依据：当前 ${current}；读不到已发布 tag（无 git 或无 tag），无法判断是否已升版 —— 自己核对需求文档`,
    };
  }
  const cmp = compareSemver(current, tagVersion);
  if (cmp === 0) {
    return { kind: 'same', text: `版本依据：当前 ${current} = 最新 tag v${tagVersion}（同版本重打，不需要升版）` };
  }
  if (cmp > 0) {
    return {
      kind: 'ahead',
      text:
        `版本依据：当前 ${current} 高于最新 tag v${tagVersion} —— 已升版、尚未发布。` +
        `确认手上有 ${current}需求文档或 ${current}追加（决策 #232）；没有就是私自升版，应改回 v${tagVersion}`,
    };
  }
  return {
    kind: 'behind',
    text:
      `版本依据：当前 ${current} 低于最新 tag v${tagVersion} —— 比已发布的还旧。` +
      '先查分支对不对（是不是停在旧 rel 上了），别在这里打包',
  };
}

/** 三段式数值比较：a>b 返回 1，相等 0，a<b 返回 -1 */
function compareSemver(a, b) {
  const pa = String(a).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pb = String(b).split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 读本仓库最新的 `v*` tag；读不到就返回 null（没有 git、没 tag、或不在仓库里都可能） */
function readLatestTag(root) {
  try {
    const out = execFileSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = out.split('\n').map((line) => line.trim()).find((line) => line !== '');
    return first ?? null;
  } catch {
    return null;
  }
}

/**
 * 「版本依据」一句话（`describeVersionBasis` + 读 tag 的组合）。
 *
 * 打包脚本也要用：`build-client.mjs` 在版本载体校验通过后打印它 ——
 * 那时候最该被看见的不是"10 个载体一致"（那只能证明改全了），
 * 而是"这个版本号到底该不该存在"（决策 #232）。
 */
export function versionBasisText(current, root = REPO_ROOT) {
  return describeVersionBasis(current, readLatestTag(root)).text;
}

/** 命令行入口：人看的报告 + 退出码 */
export function run(root = REPO_ROOT) {
  const result = checkVersionLiterals(root);
  const bare = findBareVersions(root);

  console.log(`单一真源：根 package.json = ${result.current ?? '（读不到）'}`);
  if (result.current) {
    console.log(`  ${versionBasisText(result.current, root)}`);
  }
  for (const carrier of result.carriers) {
    const mark = carrier.ok ? '✔' : '✘';
    console.log(`  ${mark} ${carrier.file.padEnd(34)} ${carrier.where} = ${carrier.got ?? '（缺失）'}`);
  }
  console.log(
    bare.ok
      ? `✔ 没有残留的裸版本字面量（检查了 ${SUPERSEDED.join(' / ')}）`
      : `✘ 发现 ${bare.hits.length} 处残留的裸版本字面量：`,
  );
  for (const hit of bare.hits) {
    console.log(`  ${hit.file}:${hit.line}  ${hit.version}  ${hit.text}`);
  }

  const problems = [...result.problems];
  if (problems.length > 0) {
    console.log('');
    for (const problem of problems) console.log(`✘ ${problem}`);
  }
  if (!result.ok || !bare.ok) {
    console.log(
      '\n提示：历史标注（since: /「0.1.2 起…」/ 带 v 前缀）不算漂移；' +
        '需要改的是"当前版本"那类载体，见本文件头部的分类说明。',
    );
    return 1;
  }
  console.log('\n✔ 版本号载体全部一致');
  return 0;
}

// 直接执行才跑 CLI；被 validate-config / 单测 import 时只导出函数
// （用 basename 比对而不是路径全等：Windows 上 argv 的大小写与分隔符不保证一致）
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/scripts/check-version-literal.mjs')) {
  process.exit(run());
}
