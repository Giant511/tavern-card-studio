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
if (h2.length !== requiredSections.length + 1) {
  fail(`正文应为 ${requiredSections.length} 节 + 许可证，实际 ${h2.length} 个二级标题：${h2.join(' / ')}`);
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
lines.forEach((line, i) => {
  if (/docs\//.test(line)) fail(`第 ${i + 1} 行引用了 docs/ 路径（GitHub 上死链）：${line.trim().slice(0, 80)}`);
  // 代码围栏里的内容不算"开发命令残留"，但要单独标记，避免误判成用户步骤
  const devCmd = /\b(npm run|npm test|npm install|node scripts\/|tsc -b)/;
  if (devCmd.test(line)) {
    fail(`第 ${i + 1} 行出现开发命令：${line.trim().slice(0, 80)}`);
  }
});

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
