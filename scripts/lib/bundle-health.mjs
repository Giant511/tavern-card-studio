/**
 * 打包健康检查（2026-10-24 生产故障「客户端白屏 / asset not found: index.html」的防线）
 *
 * 那次故障的本质是：**时间链只保证「新」，不保证「有」**。
 * `report:release` 原本只断言 `client/dist ≤ tcs-shell.exe` —— 只要 exe 比 dist 晚，
 * 无论 exe 里到底有没有内嵌资源，都算绿。结果发出一个 1.91 MB 的 MSI：
 * 前端产物一个字节都没进去，运行期 `tauri::manager` 报 `asset not found: index.html`，
 * 窗口一片白。
 *
 * 这里给出三条**内容级**判据（都不依赖 mtime，也不依赖「体积看起来差不多」）：
 *
 *   1. `auditDist`        —— 产物目录本身是不是「有内容」：入口 html 在根、总字节数达标、
 *                            引用的静态资源真实存在、没有 0 字节文件。
 *   2. `auditShellAssets` —— exe 里到底有没有 dist 的每个文件。Tauri 的内嵌方式是把
 *                            **资源键（相对路径）留在字符串常量里**、**文件内容 brotli 压缩**
 *                            后 `include_bytes!`。所以键是明文的（`/assets/main-xxxx.js`），
 *                            可以逐文件 `includes` 判定；而界面文案在压缩体里，仍然是 0 命中，
 *                            不要拿它做判据。
 *   3. `auditMsiSize`     —— 新包相对上一版不得骤降（默认 ≥70%）。
 *                            骤降 = 内嵌资源丢失的强信号。
 *
 * 注意 70% 这条阈值**单独不够**：本次故障的客户端 MSI 是 1,998,848 / 2,703,360 = 73.9%，
 * 恰好从 70% 网眼里漏过去。真正的判据是第 2 条（逐文件命中），体积回归只当兜底网。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

/** dist 总字节数下限。实测正常构建 client/dist ≈ 3.38 MB，取 500 KB 作下限（留足富余，只抓「几乎空」）。 */
export const DIST_MIN_BYTES = 500 * 1024;

/** 新 MSI 相对上一版的最小体积比。低于它即判红。 */
export const MSI_MIN_RATIO = 0.7;

/** 递归列出目录下所有文件（返回相对路径，正斜杠），并统计总字节数。 */
export function listFiles(dir) {
  const files = [];
  let totalBytes = 0;
  const walk = (current, base) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else {
        const bytes = statSync(full).size;
        totalBytes += bytes;
        files.push({ rel, bytes, path: full });
      }
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return { files, totalBytes };
}

/** 从 index.html 里抽出本地静态资源引用（`./assets/x.js` 这种），用于「引用了但没产出」的漏检。 */
function localRefs(html) {
  const refs = [];
  const pattern = /(?:src|href)\s*=\s*["'](\.\/[^"'?#]+)/g;
  let match;
  while ((match = pattern.exec(html)) !== null) if (!refs.includes(match[1])) refs.push(match[1]);
  return refs;
}

/**
 * 产物目录健康检查。
 *
 * @param {string} dir        产物目录（`client/dist` 或 `server/dist`）
 * @param {object} [options]
 * @param {string} [options.entry]       入口 html 相对路径，默认 `index.html`
 * @param {number} [options.minBytes]    总字节下限
 * @param {string[]} [options.required]  额外必须存在的相对路径（如 `perf.html`）
 * @returns {{ok: boolean, totalBytes: number, files: object[], problems: string[]}}
 */
export function auditDist(dir, options = {}) {
  const { entry = 'index.html', minBytes = DIST_MIN_BYTES, required = [] } = options;
  const problems = [];

  if (!existsSync(dir)) {
    return { ok: false, totalBytes: 0, files: [], problems: [`产物目录不存在：${dir}`] };
  }

  const { files, totalBytes } = listFiles(dir);
  if (files.length === 0) {
    problems.push('产物目录是空的（0 个文件）');
    return { ok: false, totalBytes, files, problems };
  }

  // ① 入口必须落在根上。放错目录（dist/dist/index.html）时 Tauri 只会拿到一个空映射。
  const entryFile = files.find((file) => file.rel === entry);
  if (entryFile === undefined) {
    problems.push(`根目录缺少 ${entry}（现有文件：${files.slice(0, 6).map((file) => file.rel).join('、')}${files.length > 6 ? ' …' : ''}）`);
  } else if (entryFile.bytes < 1024) {
    problems.push(`${entry} 只有 ${entryFile.bytes} 字节，像是不完整的产物`);
  }

  // ② 总量下限。只抓「几乎空」，不拿它判断「对不对」。
  if (totalBytes < minBytes) {
    problems.push(`产物合计 ${totalBytes} 字节 < 下限 ${minBytes} 字节`);
  }

  // ③ 0 字节文件：中断的构建会留下空壳，比缺文件更难发现。
  const empty = files.filter((file) => file.bytes === 0);
  if (empty.length > 0) {
    problems.push(`${empty.length} 个 0 字节文件（例：${empty.slice(0, 3).map((file) => file.rel).join('、')}）`);
  }

  // ④ html 引用的本地资源必须真实产出。这条抓的是「html 是新的、assets 还是旧的」。
  if (entryFile !== undefined) {
    const html = readFileSync(entryFile.path, 'utf8');
    for (const ref of localRefs(html)) {
      const target = ref.replace(/^\.\//, '');
      if (!files.some((file) => file.rel === target)) problems.push(`${entry} 引用了不存在的 ${ref}`);
    }
  }

  for (const rel of required) {
    if (!files.some((file) => file.rel === rel)) problems.push(`缺少必需的 ${rel}`);
  }

  return { ok: problems.length === 0, totalBytes, files, problems };
}

/**
 * 不参与「字节存在性」判据的文件。
 *
 * `index.html` 这个名字在 exe 里有 3 处**样板/库内字面量**，与是否内嵌无关：
 *   · WebView2 未安装提示页：`registration</noscript>./index.html`
 *   · 同一段提示页的词典式文本：`…structure of/index.html pub…`
 *   · `tauri::manager` 的回退字面量：`AssetKey::from("index.html")`
 * 实测那个「一个资源都没内嵌」的故障 exe 里 4 处命中里 3 处是这些，
 * 于是「8 缺 1 有」—— 判据差点自己放过去。
 *
 * 所以入口 html 改由 `auditDist` 判（它在 dist 根上必须有、且大小正常、
 * 引用的资源必须真实存在）；内嵌判据只看带哈希的 `assets/*` 这类高熵键，
 * 它们不可能出现在样板文字里。两者合起来覆盖「没打包」和「index.html 放错位置」。
 */
const KEY_PROBE_IGNORE = new Set(['index.html']);

/**
 * exe 是否内嵌了整个 dist。
 *
 * 判据：dist 里每个文件的相对路径都必须以 `/<rel>` 的形态出现在 exe 字节里。
 * Tauri 生成的映射里键是明文字符串、内容才是 brotli 压缩的，所以「键全在」= 内嵌完整；
 * 这与「界面文案在压缩体里 0 命中」并不矛盾 —— 前者是键，后者是内容。
 *
 * @param {string} exePath
 * @param {string} distDir
 * @returns {{ok: boolean, checked: number, skipped: string[], missing: string[]}}
 */
export function auditShellAssets(exePath, distDir) {
  if (!existsSync(exePath)) return { ok: false, checked: 0, skipped: [], missing: ['(exe 不存在)'] };
  const { files } = listFiles(distDir);
  if (files.length === 0) return { ok: false, checked: 0, skipped: [], missing: ['(dist 为空，无从比对)'] };

  const binary = readFileSync(exePath);
  const missing = [];
  const skipped = [];
  for (const file of files) {
    if (KEY_PROBE_IGNORE.has(file.rel)) {
      skipped.push(file.rel);
      continue;
    }
    const key = `/${file.rel.split(sep).join('/')}`;
    if (!binary.includes(Buffer.from(key, 'utf8'))) missing.push(file.rel);
  }
  return { ok: missing.length === 0, checked: files.length - skipped.length, skipped, missing };
}

/**
 * 体积回归：新包相对上一版不得低于 `minRatio`。
 *
 * @param {string} msiPath   新 MSI
 * @param {string} priorPath 上一版 MSI（可为 null，此时跳过判定）
 * @param {number} [minRatio]
 * @returns {{ok: boolean, ratio: number|null, bytes: number, priorBytes: number|null, skipped: boolean}}
 */
export function auditMsiSize(msiPath, priorPath, minRatio = MSI_MIN_RATIO) {
  const bytes = existsSync(msiPath) ? statSync(msiPath).size : 0;
  if (priorPath === null || !existsSync(priorPath)) {
    return { ok: true, ratio: null, bytes, priorBytes: null, skipped: true };
  }
  const priorBytes = statSync(priorPath).size;
  const ratio = bytes / priorBytes;
  return { ok: ratio >= minRatio, ratio, bytes, priorBytes, skipped: false };
}

/**
 * 在 release 目录里找「同一产品线的上一版 MSI」。
 *
 * 做法：按文件名里的版本号排序，取小于当前版本的最大者；没有更早的版本时
 * 退而取任意不同版本（避免版本号回退时无基线）。都没有则返回 null（跳过判定并说明）。
 *
 * @param {string} releaseDir
 * @param {string} family         `client` | `server`
 * @param {string} currentVersion
 */
export function findPriorMsi(releaseDir, family, currentVersion) {
  if (!existsSync(releaseDir)) return null;
  const patterns = {
    client: /^Tavern Card Studio_(.+)_x64_en-US\.msi$/i,
    server: /^TavernCardStudioServer-(.+)\.msi$/i,
  };
  const pattern = patterns[family];
  const candidates = [];
  for (const name of readdirSync(releaseDir)) {
    const match = pattern.exec(name);
    if (match === null || match[1] === currentVersion) continue;
    candidates.push({ version: match[1], path: join(releaseDir, name) });
  }
  if (candidates.length === 0) return null;

  const parse = (version) => version.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const compare = (a, b) => {
    const left = parse(a);
    const right = parse(b);
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      const diff = (left[i] ?? 0) - (right[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  };
  const current = parse(currentVersion);
  const earlier = candidates.filter((candidate) => compare(candidate.version, currentVersion) < 0);
  const pool = earlier.length > 0 ? earlier : candidates;
  pool.sort((a, b) => compare(b.version, a.version));
  return pool[0];
}

/** 人类可读的体积。 */
export const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

/** 相对仓库根的路径，便于日志可点。 */
export const rel = (root, path) => relative(root, path) || path;

/**
 * 找 WiX 的 `dark.exe`（MSI 反编译器）。
 *
 * 为什么它一定存在：Tauri 打 MSI 就是用 WiX 打的，工具链被缓存在
 * `%LOCALAPPDATA%\tauri\WixTools*`。也就是说**只要刚刚成功产出了一个 MSI，
 * 这个 exe 就在**。找不到只有两种情况：宿主把缓存清掉了，或者装了另一份 WiX。
 * 所以三种位置都找：Tauri 缓存（全部 WixTools* 目录）、Program Files 的两处。
 *
 * @returns {string|null}
 */
export function findWixDark() {
  const candidates = [];
  const localAppData = process.env['LOCALAPPDATA'];
  if (localAppData !== undefined) {
    const tauriDir = join(localAppData, 'tauri');
    if (existsSync(tauriDir)) {
      for (const name of readdirSync(tauriDir)) {
        if (/^WixTools/i.test(name)) candidates.push(join(tauriDir, name, 'dark.exe'));
      }
    }
  }
  for (const base of [process.env['ProgramFiles(x86)'], process.env['ProgramFiles'], process.env['ProgramW6432']]) {
    if (base === undefined) continue;
    for (const version of ['WiX Toolset v3.14', 'WiX Toolset v3.11']) {
      candidates.push(join(base, version, 'bin', 'dark.exe'));
    }
  }
  return candidates.find((path) => existsSync(path)) ?? null;
}

/**
 * 把 MSI 解开，取出**里面那个** exe，再对它做内嵌资源审计。
 *
 * ## 为什么不审计 `target/release/tcs-shell.exe`
 *
 * 因为它不是出厂件。Tauri 打完包之后会**再 patch 一次 exe 写 bundle 类型**：
 * 实测同一次构建里，MSI 内的 exe 是 `TAURI_BUNDLE_TYPE_VAR_MSI`，
 * 而构建树里的是 `TAURI_BUNDLE_TYPE_VAR_UNK` —— 两者只差 **3 个字节**，
 * 但确实是两个不同的二进制，且构建树那个的 mtime 反而晚 10 秒
 * （`report-release.mjs` 第 5 节专门写了「不断言 exe ≤ MSI」，就是这个原因）。
 *
 * 于是"审计构建树的 exe"其实审计了一个**没有发出去的文件**。
 * v0.1.3 的「MSI 缺功能」反馈排查时正是卡在这里：先要证明出厂件里到底有什么。
 *
 * ## 判据
 *
 * 与 `auditShellAssets` 完全相同（逐资源键 includes）。这里额外说明一点：
 * vite 产出的文件名本身是**内容哈希**（`main-BzSOta9K.js`），所以
 * "键在"不只是"名字在"，而是"这一版内容被内嵌了" —— 换一版内容名字就会变。
 *
 * @param {string} msiPath
 * @param {string} distDir
 * @returns {{
 *   ok: boolean, skipped: boolean, reason?: string,
 *   checked: number, missing: string[], exeBytes: number, exeSha256: string,
 *   dark: string|null,
 * }}
 */
/**
 * 在一份 exe 的字节里找"必须存在"的壳侧字符串，返回**缺了哪些**。
 *
 * 为什么要转 latin1：Node 的 `Buffer.includes(string)` 默认按 utf8 编码去找，
 * 而读进来的 `Buffer` 里非 ASCII 字节已经"碎了" —— 对纯 ASCII 的字面量没问题，
 * 但用 `toString('latin1')` 转成"一字节一字符"的字符串后再 `includes`，
 * 匹配语义与字节级完全一致，也不会因为编码猜错而漏。
 *
 * 反过来：**不要**拿它去找中文。latin1 会把多字节拆成单字节，中文永远匹配不上；
 * 需要找中文时用 `bytes.includes(Buffer.from(s, 'utf8'))`。这里的调用方
 * （`x-frame-options` / `frame-ancestors` / `SameSite=None`）全是 ASCII，
 * 所以刻意只支持这套用法，并在测试里把这条约束钉住。
 */
export function findMissingStrings(bytes, needles) {
  const text = bytes.toString('latin1');
  return needles.filter((needle) => !text.includes(needle));
}

export function auditMsiShellAssets(msiPath, distDir, options = {}) {
  /*
   * `options.strings`：要在这份 exe 里找到的**壳侧（Rust）**字符串。
   *
   * 为什么需要：功能哨兵只扫前端产物（dist），而有些修复完全发生在壳里 ——
   * v0.1.6 的 `SameSite=None` / `frame-ancestors` 都是 Rust 常量，永远不会出现在
   * dist 里。若给它们写前端哨兵，那条断言必然假红；不写又没有任何东西盯着
   * "这版包里的壳到底是不是带修复的那个"。
   *
   * 判据是**内容级**的：在出厂 exe 的字节里找这些字面量。Rust 的字符串常量
   * 以 UTF-8 落在只读数据段，`includes` 就能命中（2026-10-27 实测）。
   */
  const needles = Array.isArray(options.strings) ? options.strings : [];
  const skippedResult = (reason) => ({
    ok: false,
    skipped: true,
    reason,
    checked: 0,
    missing: [],
    missingStrings: needles.slice(),
    exeBytes: 0,
    exeSha256: '',
    dark: null,
  });

  if (!existsSync(msiPath)) return skippedResult(`MSI 不存在：${msiPath}`);
  const dark = findWixDark();
  if (dark === null) {
    return skippedResult('找不到 dark.exe（WiX 反编译器）—— 无法审计出厂件里的 exe');
  }

  const workDir = mkdtempSync(join(tmpdir(), 'tcs-msi-audit-'));
  try {
    execFileSync(dark, ['-x', join(workDir, 'out'), '-o', join(workDir, 'out.wxs'), msiPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
    });

    // 取 `File/` 下最大的那个文件当主程序：客户端包里 4.9 MB 的 exe 与
    // 几 KB 的规则/脚本差着三个数量级，不需要猜文件名（dark 导出时名字会变成 `Path`）。
    const fileDir = join(workDir, 'out', 'File');
    if (!existsSync(fileDir)) return skippedResult('dark.exe 没有导出 File 目录（MSI 结构异常）');
    let main = null;
    for (const name of readdirSync(fileDir, { withFileTypes: true })) {
      if (!name.isFile()) continue;
      const full = join(fileDir, name.name);
      const bytes = statSync(full).size;
      if (main === null || bytes > main.bytes) main = { path: full, bytes };
    }
    if (main === null) return skippedResult('MSI 的 File 目录是空的');

    const bytes = readFileSync(main.path);
    const audit = auditShellAssets(main.path, distDir);
    const missingStrings = findMissingStrings(bytes, needles);
    return {
      ok: audit.ok && missingStrings.length === 0,
      skipped: false,
      checked: audit.checked,
      missing: audit.missing,
      missingStrings,
      exeBytes: main.bytes,
      exeSha256: createHash('sha256').update(bytes).digest('hex'),
      dark,
    };
  } catch (error) {
    return skippedResult(`dark.exe 解包失败：${String(error.message).split('\n')[0]}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
