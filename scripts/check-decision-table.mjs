/**
 * 决策表序号连续性校验（独立脚本，可被 validate 与 git 钩子复用）。
 *
 * 为什么需要：决策表用文本编辑追加条目时，`old_string` 很容易把相邻行
 * 一起吃进替换范围，导致**条目被静默删除**。2026-10-21 一天内发生两次
 * （先丢 #15，后丢 #19），两次都是"看起来只加了一行"，肉眼看 diff 未必发现。
 *
 * 判据：编号列必须从 #1 开始、严格 +1 递增。跳号即说明中间丢了决策。
 *
 * 检查目标：PLAN.md（T9.13 起决策表迁出 README，README 已转为纯用户文档）。
 *
 * 用法：
 *   node scripts/check-decision-table.mjs            # 检查仓库 PLAN.md
 *   node scripts/check-decision-table.mjs <路径>      # 检查指定文件
 * 退出码：0 通过；1 失败
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TARGET = 'PLAN.md';

/**
 * @param {string} readmePath
 * @returns {{ ok: boolean, numbers: number[], problems: string[], detail: string }}
 */
export function checkDecisionTable(readmePath) {
  if (!existsSync(readmePath)) {
    return { ok: false, numbers: [], problems: [`找不到文件 ${readmePath}`], detail: '文件缺失' };
  }

  // 按 \r?\n 切分：本机 core.autocrlf=true，工作区 PLAN.md 是 CRLF，
  // 若只按 '\n' 切，行尾会残留 '\r'，导致分隔行 /^\|[\s:|-]+\|$/ 匹配不上。
  const lines = readFileSync(readmePath, 'utf8').split(/\r?\n/);

  // 定位表头：首列表头为「#」的那张表
  const headerIndex = lines.findIndex((line) => /^\|\s*#\s*\|/.test(line));
  if (headerIndex === -1) {
    return {
      ok: false,
      numbers: [],
      problems: ['没找到以「#」为首列的决策表'],
      detail: '表头缺失',
    };
  }

  const numbers = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith('|')) break; // 表格结束
    if (/^\|[\s:|-]+\|$/.test(line)) continue; // 分隔行 |---|---|
    const match = /^\|\s*(\d+)\s*\|/.exec(line);
    if (match) numbers.push(Number(match[1]));
  }

  if (numbers.length === 0) {
    return { ok: false, numbers, problems: ['决策表里没有解析到任何编号行'], detail: '无编号行' };
  }

  const problems = [];
  if (numbers[0] !== 1) problems.push(`首条不是 #1 而是 #${numbers[0]}`);
  for (let i = 1; i < numbers.length; i += 1) {
    const prev = numbers[i - 1];
    const current = numbers[i];
    if (current === prev) problems.push(`#${current} 重复出现`);
    else if (current < prev) problems.push(`#${prev} 之后回到 #${current}（顺序倒了）`);
    else if (current !== prev + 1) {
      problems.push(`#${prev} 之后跳到 #${current}（缺 ${current - prev - 1} 条）`);
    }
  }

  const detail = problems.length
    ? problems.join('；')
    : `共 ${numbers.length} 条（#1–#${numbers[numbers.length - 1]}）`;

  return { ok: problems.length === 0, numbers, problems, detail };
}

// ── CLI ────────────────────────────────────────────────────
const isCli = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isCli) {
  const target = process.argv[2] ? resolve(process.argv[2]) : join(REPO, DEFAULT_TARGET);
  const result = checkDecisionTable(target);
  if (result.ok) {
    console.log(`✔ 决策表序号连续 —— ${result.detail}`);
    process.exit(0);
  }
  console.error(`✘ 决策表序号有问题 —— ${result.detail}`);
  process.exit(1);
}
