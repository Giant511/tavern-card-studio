/**
 * 功能哨兵（v0.1.3 生产反馈「新 MSI 缺 F5 界面」的防线）。
 *
 * ## 这个文件补的是哪个洞
 *
 * `auditDist` 只回答「产物**有没有内容**」：入口在根、总量达标、引用的资源存在、
 * 没有 0 字节文件。它**不回答「内容是不是这一版」** —— 一个两天前的 dist 只要
 * 结构完整，照样全绿。`auditShellAssets` 也只回答「exe 里有没有这些资源键」。
 *
 * 于是存在一个真实的空档：vite build 失败被忽略 / `--skip-ui` 复用了旧 dist /
 * 切了分支没重编 —— 三种情况下 dist 都"健康"，打进 MSI 的却是旧界面。
 *
 * 哨兵就是补这个：在 dist 里**断言近期交付的功能特征字符串还在**。
 *
 * ## 为什么必须在 tauri build 之前查
 *
 * Tauri 把前端产物 brotli 压缩后内嵌进 exe（见 bundle-health.mjs 顶部）。
 * 一旦进了 exe，任何界面文案在二进制里都是 **0 命中** —— 拿 MSI/exe 直接搜索
 * 得出的"缺功能"结论是假阴性（本仓库踩过：白屏那次也是被 0 命中骗过）。
 * dist 是明文，这一步正好落在「明文还在」的窗口里。
 *
 * ## 三条实现约束（都是踩过的坑）
 *
 * 1. **不扫 `.map`**：sourcemap 的 `sourcesContent` 里存着源码原文。
 *    打包产物把文案丢了但 sourcemap 还在时，扫 .map 会假绿 —— 那正是要抓的故障。
 * 2. **不只看 `index.html`**：它是外壳（<5 KB），界面文案在 `assets/*.js` 里。
 *    真实判据是"整个 dist 的构建产物里出现过"，范围放宽到全部 js/css/html。
 * 3. **文案按「用户在界面上看得见的原文」写**：压缩后注释会被剥掉，所以命中
 *    就等于"存在这个字符串字面量"，不是"源码里提过一嘴"。
 *
 * ## 维护规则
 *
 * 删功能、改文案 → 同步改这张表。**找不到就红**，逼人当场表态；
 * 这条红线是故意的：静默失效的检查等于没有检查。
 * `test/feature-sentinels.test.mjs` 还会双向校验「表里的文案在 client/src 里确实存在」，
 * 防止文案改名后哨兵变成一个永远查不到的孤儿（那时构建会红，但原因难查）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 参与扫描的扩展名（构建产物） */
const SCAN_EXTENSIONS = ['.js', '.css', '.html'];

/** 明确排除的：sourcemap 里存着源码原文，扫它等于扫源码，会假绿 */
const EXCLUDE_SUFFIXES = ['.map'];

/**
 * 哨兵清单。
 *
 * 字段：
 *   feature  需求编号（与需求文档一致）
 *   title    这一条功能的一句话说明（报告里直接用）
 *   since    该功能首次进入交付物的版本
 *   expect   至少要命中的界面原文，每条都写明"在哪看得见"
 *
 * `text` 必须是**界面上真实出现的连续字符串**。不要写变量名、不要写注释里的词。
 *
 * @type {ReadonlyArray<{
 *   feature: string, title: string, since: string,
 *   expect: ReadonlyArray<{ text: string, where: string }>,
 * }>}
 */
export const FEATURE_SENTINELS = [
  {
    feature: 'F5',
    title: '令牌体系理顺：legacy 全局令牌收进「高级 · 兼容模式」折叠区',
    since: '0.1.1',
    expect: [
      {
        text: '高级 · 兼容模式',
        where: '设置面板 › 高级折叠区标题（原先是常驻的令牌输入框）',
      },
      {
        text: '全局令牌（legacy）',
        where: '折叠区里的字段标签（≤v0.1.1 服务端才用得到）',
      },
    ],
  },
  {
    feature: 'F6',
    title: '八板块：新增「初始场景」「对话示例」两个字段板块',
    since: '0.1.3',
    expect: [
      { text: '对话示例', where: '板块标题（chat-examples → mes_example）' },
      { text: '初始场景', where: '板块标题（initial-scene → first_mes / alternate_greetings）' },
    ],
  },
];

/** 递归列出目录下所有文件（相对路径，正斜杠） */
function listFiles(dir, base = '') {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base === '' ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else out.push({ rel, path: join(dir, entry.name), bytes: statSync(join(dir, entry.name)).size });
  }
  return out;
}

/** 该文件是否参与哨兵扫描 */
export function isScannable(rel) {
  if (EXCLUDE_SUFFIXES.some((suffix) => rel.endsWith(suffix))) return false;
  return SCAN_EXTENSIONS.some((ext) => rel.endsWith(ext));
}

/**
 * 在 dist 的构建产物里查哨兵。
 *
 * @param {string} distDir
 * @returns {{
 *   ok: boolean,
 *   results: Array<{feature: string, title: string, text: string, where: string,
 *                   hits: number, file: string|null}>,
 *   problems: string[],
 *   scanned: { files: number, bytes: number, skipped: number },
 * }}
 */
export function checkSentinels(distDir) {
  const problems = [];
  const all = listFiles(distDir);
  if (all.length === 0) {
    return {
      ok: false,
      results: [],
      problems: [`产物目录不存在或为空：${distDir}`],
      scanned: { files: 0, bytes: 0, skipped: 0 },
    };
  }

  const scannable = all.filter((file) => isScannable(file.rel));
  const skipped = all.length - scannable.length;
  if (scannable.length === 0) {
    return {
      ok: false,
      results: [],
      problems: [`没有可扫描的构建产物（${all.length} 个文件全是 .map）`],
      scanned: { files: 0, bytes: 0, skipped },
    };
  }

  // 一次性读进内存：dist 只有几 MB，比逐条哨兵反复读盘快得多
  const contents = scannable.map((file) => ({
    rel: file.rel,
    text: readFileSync(file.path, 'utf8'),
  }));

  const results = [];
  for (const group of FEATURE_SENTINELS) {
    for (const item of group.expect) {
      let hits = 0;
      let firstFile = null;
      for (const content of contents) {
        const count = content.text.split(item.text).length - 1;
        if (count > 0) {
          hits += count;
          if (firstFile === null) firstFile = content.rel;
        }
      }
      results.push({
        feature: group.feature,
        title: group.title,
        text: item.text,
        where: item.where,
        hits,
        file: firstFile,
      });
      if (hits === 0) {
        problems.push(
          `${group.feature} 哨兵缺失：「${item.text}」（应出现在 ${item.where}）` +
            ` —— 说明 dist 不是当前这一版，别打包`,
        );
      }
    }
  }

  return {
    ok: problems.length === 0,
    results,
    problems,
    scanned: {
      files: scannable.length,
      bytes: scannable.reduce((sum, file) => sum + file.bytes, 0),
      skipped,
    },
  };
}

/**
 * 表自身的一致性检查（供测试用，构建时也顺手跑一遍）。
 *
 * 三条：文案不能太短（否则到处命中，等于没查）、同组内不许重复、
 * `since` 必须是版本号形态。哨兵表一旦退化，这套检查就废了。
 *
 * @returns {string[]} 问题列表，空数组表示正常
 */
export function validateRegistry() {
  const problems = [];
  if (FEATURE_SENTINELS.length === 0) problems.push('哨兵表是空的');
  for (const group of FEATURE_SENTINELS) {
    if (!/^\d+\.\d+\.\d+$/.test(group.since)) {
      problems.push(`${group.feature} 的 since 不是版本号：${group.since}`);
    }
    if (group.expect.length === 0) problems.push(`${group.feature} 没有任何 expect 项`);
    const seen = new Set();
    for (const item of group.expect) {
      if (item.text.length < 4) {
        problems.push(`${group.feature} 的哨兵过短（<4 字符）：${item.text} —— 满屏都会命中，等于没查`);
      }
      if (seen.has(item.text)) problems.push(`${group.feature} 的哨兵重复：${item.text}`);
      seen.add(item.text);
      if (typeof item.where !== 'string' || item.where.trim() === '') {
        problems.push(`${group.feature} 的哨兵没写「在哪看得见」：${item.text}`);
      }
    }
  }
  return problems;
}
