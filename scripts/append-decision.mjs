/**
 * 在 PLAN.md 决策表末尾追加一条决策。
 *
 * 用法：node scripts/append-decision.mjs <md 文件> <内容文件>
 *   内容文件里放一整行 markdown 表格行，首列编号随便写（会被改写成正确的下一个号）。
 *
 * 为什么内容必须走文件而不是命令行参数：Windows 上 bash → node 的命令行参数
 * 会按当前代码页（CP936）转换，中文会变成乱码写进文件（第一次就这么踩了：
 * 「分叉」写成了「鍒嗗弶」）。文件读写走 UTF-8，没有这个转换环节。
 *
 * 为什么插入点要限定在「第一张表的范围内」：文件后面还有别的表格，
 * 按「全文最后一个 | 数字 | 行」定位会插到文末去（也踩过）。
 */

import { readFileSync, writeFileSync } from 'node:fs';

const [, , file, contentFile] = process.argv;
if (!file || !contentFile) {
  console.error('用法：node scripts/append-decision.mjs PLAN.md <内容文件>');
  process.exit(2);
}

const text = readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);
const row = readFileSync(contentFile, 'utf8').trim();

// 定位决策表：首列为「#」的表头，直到第一行不是表格行为止
const headerIdx = lines.findIndex((l) => /^\|\s*#\s*\|/.test(l));
if (headerIdx === -1) {
  console.error('没找到以「#」为首列的表头');
  process.exit(1);
}
let endIdx = headerIdx;
let maxNum = 0;
for (let i = headerIdx + 1; i < lines.length; i += 1) {
  if (!lines[i].startsWith('|')) break;
  const m = /^\|\s*(\d+)\s*\|/.exec(lines[i]);
  if (m) maxNum = Math.max(maxNum, Number(m[1]));
  endIdx = i;
}

const nextNum = maxNum + 1;
const normalized = row.replace(/^\|\s*\d*\s*\|/, `| ${String(nextNum)} |`);
lines.splice(endIdx + 1, 0, normalized);
writeFileSync(file, lines.join('\n'), 'utf8');
console.log(`已追加决策 #${String(nextNum)}（插在第 ${String(endIdx + 2)} 行）`);
