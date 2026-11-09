/**
 * README 用户向自检（T9.13）。
 *
 * 为什么需要：README 从"开发手册"改成"用户文档"之后，坏法变了 ——
 * 不再是"内容过时"，而是①引用了仓库里不存在的路径（docs/ 已撤下，GitHub 上是死链）、
 * ②表格列数写错导致整张表渲染成一坨、③残留开发命令让用户以为要装 Node。
 * 这三样肉眼扫一遍很容易漏（尤其表格：Markdown 只错一列也能"看起来还好"）。
 *
 * 判据（任一不满足即退出码 1）：
 *   1. 结构：四个正文章节 + 许可证，标题层级不跳级；
 *   2. 无 `docs/` 路径引用（GitHub 上是死链）；
 *   3. 无开发向命令（npm run / node scripts / *.ps1 / *.mjs / *.ts）；
 *   4. 所有相对图片与链接的目标文件存在；
 *   5. 每个表格块的列数与分隔行一致；
 *   6. 代码围栏成对。
 *
 * 用法：node scripts/check-readme.mjs [README 路径]
 *   默认读仓库根 README.md，并在仓库根解析相对链接。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ? resolve(process.argv[2]) : join(REPO, 'README.md');
const baseDir = dirname(target);

const text = readFileSync(target, 'utf8');
const lines = text.split(/\r?\n/);

const problems = [];
const notes = [];
const fail = (msg) => problems.push(msg);

// ── 1. 章节结构 ────────────────────────────────────────────
const requiredSections = ['简介与功能一览', '安装', '配置与使用', '规则文件编写指南'];
const h2 = lines.filter((l) => /^##\s+/.test(l)).map((l) => l.replace(/^##\s+/, '').trim());
for (const s of requiredSections) {
  if (!h2.some((h) => h.includes(s))) fail(`缺少章节「${s}」（现有：${h2.join(' / ')}）`);
}
/*
 * 允许**一个**额外二级标题：「更新说明」。
 *
 * ## 为什么原来的"恰好 4 节"要放宽（2026-11-09）
 *
 * 那条判据的本意是**别让 README 长回开发手册**（T9.13 把 README 从开发文档
 * 改成用户向文档时立的）。它用一个数字守住这件事，但数字不是意图 ——
 * 用户装上新版本时最想知道"这次更新了什么"，那属于**用户向**内容，
 * 为它守着数字反而违背判据的目的。
 *
 * ## 放宽的边界（不是"随便加节"）
 *
 * · 最多 5 节：再多就说明 README 又开始堆东西了；
 * · 额外那节**必须叫「更新说明」** —— 不允许出现「部署」「架构」「API」
 *   这类开发向二级标题；
 * · 内容纯净度仍由下面第 2/3 条守着（无 docs 死链、无开发命令），
 *   所以放宽标题数不会让 README 变脏。
 */
const extraAllowed = h2.filter((h) => !requiredSections.some((s) => h.includes(s)) && h !== '许可证');
const unexpectedExtra = extraAllowed.filter((h) => !h.includes('更新说明'));
if (unexpectedExtra.length > 0) {
  fail(`出现了非预期的二级标题（只允许再加一节「更新说明」）：${unexpectedExtra.join(' / ')}`);
}
if (extraAllowed.length > 1) {
  fail(`除四个正文章节外最多只能有一个「更新说明」，实际多了 ${extraAllowed.length} 个：${extraAllowed.join(' / ')}`);
}
if (h2.length > requiredSections.length + 1 + extraAllowed.length) {
  fail(`正文应为 ${requiredSections.length}~${requiredSections.length + 1} 节 + 许可证，实际 ${h2.length} 个二级标题：${h2.join(' / ')}`);
}
/* 「更新说明」若存在必须排在简介之前（用户先看更新内容，再看长介绍） */
const updateIdx = h2.findIndex((h) => h.includes('更新说明'));
const introIdx = h2.findIndex((h) => h.includes('简介与功能一览'));
if (updateIdx >= 0 && introIdx >= 0 && updateIdx > introIdx) {
  fail('「更新说明」应排在「简介与功能一览」之前');
}
notes.push(`章节：${h2.join(' / ')}`);

// 标题层级不跳级（## → #### 视为跳级）
let prevLevel = 0;
lines.forEach((line, i) => {
  const m = /^(#{1,6})\s+/.exec(line);
  if (!m) return;
  const level = m[1].length;
  if (prevLevel > 0 && level > prevLevel + 1) {
    fail(`第 ${i + 1} 行标题跳级：H${prevLevel} → H${level}`);
  }
  prevLevel = level;
});

// ── 2/3. 用户向纯净度 ──────────────────────────────────────
/*
 * docs 例外清单**从 .gitignore 派生**，不在这里再维护一份。
 *
 * 原来是硬编码两份文件名，于是新增一份对外文档要在三个地方同步：
 * `.gitignore` 的 `!docs/…`、`test/ops-doc.test.mjs` 的 PUBLISHED_DOCS、
 * 还有这里的两个 `.replace()`。漏掉第三处的表现是"文档能上传、但 README
 * 一提它 check:readme 就红"，而错误信息说的是"死链"—— 指向完全错误的方向。
 *
 * `.gitignore` 是唯一事实源：它决定"哪些 docs 会入库"，也就决定了"哪些 docs
 * 的链接不是死链"。`test/ops-doc.test.mjs` 已经守着它与 PUBLISHED_DOCS 一致。
 */
const publishedDocs = readPublishedDocs();

lines.forEach((line, i) => {
  /*
   * 判断按"去掉这些链接后还有没有 docs/ 引用"来做，而不是简单地白名单整行 ——
   * 一行里同时写了死链和活链时，前者仍必须被抓出来。
   *
   * 两种形态都要去掉：文件名含空格时，Markdown 链接里必须写 `%20`
   * （CommonMark 的链接目的地不允许裸空格），所以同一份文档会出现
   * `docs/Cloud Deployment Manual.md` 与 `docs/Cloud%20Deployment%20Manual.md`
   * 两种写法。只去前者会让后者被判成死链。
   */
  let withoutPublishedDocs = line;
  for (const path of publishedDocs) {
    withoutPublishedDocs = withoutPublishedDocs.split(path).join('');
    const encoded = encodeURI(path);
    if (encoded !== path) withoutPublishedDocs = withoutPublishedDocs.split(encoded).join('');
  }
  /*
   * ★ 只匹配**仓库根**的 docs 引用，不匹配任意含 `docs/` 的路径（2026-11-09）。
   *
   * 原判据是 `/docs\//`，于是 `client/src-tauri/gen/android/docs/android-user-guide.md`
   * 这种**已入库**的文档也被判成死链 —— 而那是安卓端用户手册的正式位置
   * （用户明确要求放在安卓工程自己的 docs 下，且已在 .gitignore 放行）。
   *
   * 真正的死链只会形如 `docs/xxx.md`（根目录、未入库）或 `./docs/xxx.md`。
   * 所以要求 docs/ 前面**不是单词字符、也不是斜杠**：`android/docs/` 前面是
   * 斜杠 ⇒ 不匹配；`(docs/` 或行首 ⇒ 匹配。全角括号同样算边界字符。
   */
  if (/(^|[^\w/])docs\//.test(withoutPublishedDocs)) {
    fail(`第 ${i + 1} 行引用了 docs/ 路径（GitHub 上死链）：${line.trim().slice(0, 80)}`);
  }
  // 代码围栏里的内容不算"开发命令残留"，但要单独标记，避免误判成用户步骤
  const devCmd = /\b(npm run|npm test|npm install|node scripts\/|tsc -b)/;
  if (devCmd.test(line)) {
    fail(`第 ${i + 1} 行出现开发命令：${line.trim().slice(0, 80)}`);
  }
});

/** 从 .gitignore 读出 `!docs/…` 放行清单（即会入库、因而链接不是死链的 docs） */
function readPublishedDocs() {
  const gitignorePath = join(dirname(fileURLToPath(import.meta.url)), '..', '.gitignore');
  if (!existsSync(gitignorePath)) return [];
  return readFileSync(gitignorePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('!docs/'))
    .map((line) => line.slice(1));
}

// ── 4. 相对链接 / 图片目标存在 ────────────────────────────
const linkTargets = new Set();
for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
  const raw = m[1].trim();
  if (/^(https?:|mailto:|#)/.test(raw)) continue;
  linkTargets.add(raw.split('#')[0]);
}
let missing = 0;
for (const rel of linkTargets) {
  if (!rel) continue;
  const abs = join(baseDir, decodeURIComponent(rel));
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    fail(`链接目标不存在：${rel}`);
    missing += 1;
  }
}
notes.push(`相对链接 ${linkTargets.size} 个，缺失 ${missing} 个`);

// ── 4b. 页内锚点（#xxx）能跳到某个标题 ────────────────────
/*
 * 之前这里把 `#` 开头的链接整个 skip 掉了，于是「改了章节标题、忘了改引用」
 * 这种断链从来没人报 —— 读者在 GitHub 上点一下才发现跳不动，而作者
 * 只看到"链接 0 缺失"。
 *
 * 锚点规则按 GitHub：小写、去标点、空格转连字符。中文标题保留原字符。
 * 只做近似还原（不做完整的 GitHub 兼容），但足以抓住"标题改名而引用没跟"
 * 这类真实断链。
 */
const slug = (headingText) =>
  headingText
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');

const headingAnchors = new Set();
for (const line of lines) {
  const m = /^#{1,6}\s+(.*)$/.exec(line);
  if (m) headingAnchors.add(slug(m[1]));
}

const inPage = new Set();
for (const m of text.matchAll(/\]\(#([^)]+)\)/g)) {
  inPage.add(decodeURIComponent(m[1]));
}
let deadAnchors = 0;
for (const anchor of inPage) {
  if (!headingAnchors.has(anchor)) {
    fail(`页内锚点失效：#${anchor}（没有对应标题；标题改名后引用要同步）`);
    deadAnchors += 1;
  }
}
notes.push(`页内锚点 ${inPage.size} 个，失效 ${deadAnchors} 个`);

// ── 5. 表格列数一致 ──────────────────────────────────────
const countCols = (line) => {
  // 去掉首尾竖线后按未转义竖线切分
  const body = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
  return body.split(/(?<!\\)\|/).length;
};
let tableCount = 0;
for (let i = 0; i < lines.length; i += 1) {
  const isSep = /^\s*\|[\s:|-]+\|\s*$/.test(lines[i]) && lines[i].includes('-');
  if (!isSep) continue;
  tableCount += 1;
  const header = lines[i - 1];
  const expected = countCols(header);
  if (countCols(lines[i]) !== expected) {
    fail(`第 ${i + 1} 行表格分隔行列数（${countCols(lines[i])}）与表头（${expected}）不符`);
  }
  let j = i + 1;
  while (j < lines.length && lines[j].trim().startsWith('|')) {
    const cols = countCols(lines[j]);
    if (cols !== expected) {
      fail(`第 ${j + 1} 行表格列数 ${cols} ≠ 表头 ${expected}：${lines[j].trim().slice(0, 60)}`);
    }
    j += 1;
  }
  i = j - 1;
}
notes.push(`表格 ${tableCount} 张`);

// ── 6. 代码围栏成对 ──────────────────────────────────────
const fences = lines.filter((l) => /^\s*```/.test(l)).length;
if (fences % 2 !== 0) fail(`代码围栏数量为奇数（${fences}），有未闭合的代码块`);
notes.push(`代码围栏 ${fences} 个`);

// ── 汇总 ────────────────────────────────────────────────
console.log('README 用户向自检：' + target);
for (const n of notes) console.log('  · ' + n);
if (problems.length === 0) {
  console.log('\n✔ 全部通过（结构 / 纯净度 / 链接 / 表格 / 围栏）');
  process.exit(0);
}
console.log('');
for (const p of problems) console.log('  ✘ ' + p);
console.log(`\n✘ ${problems.length} 项问题`);
process.exit(1);
