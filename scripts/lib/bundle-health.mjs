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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
