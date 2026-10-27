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

  /*
   * 定位决策表：**首列表头为 `#` 的表不止一张**（PLAN.md 里「发布流程动作表」也是）。
   *
   * 所以不能取"第一张"。2026-10-27 实测过一次假绿：新加的一张 §0.1 六条规程表
   * （表头 `| # | 规程 | 落地方式 |`）插在决策表之前，脚本抓到它后报了
   * 「✔ 共 6 条（#1–#6）」并退出 0 —— **真正的决策表一行都没检查**。
   * 守卫失效却不报错，比守卫报错严重得多。
   *
   * 现在的规则：把所有 `#` 开头表都解析出来，**取编号行最多的那张**（决策表 200+ 行，
   * 其它同类表都只有个位数）。并且在 detail 里带上行号，误判时看得见。
   */
  const candidates = [];
  for (let headerIndex = 0; headerIndex < lines.length; headerIndex += 1) {
    if (!/^\|\s*#\s*\|/.test(lines[headerIndex])) continue;
    const numbers = [];
    for (let i = headerIndex + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.startsWith('|')) break; // 表格结束
      if (/^\|[\s:|-]+\|$/.test(line)) continue; // 分隔行 |---|---|
      const match = /^\|\s*(\d+)\s*\|/.exec(line);
      if (match) numbers.push(Number(match[1]));
    }
    candidates.push({ headerIndex, numbers });
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      numbers: [],
      problems: ['没找到以「#」为首列的决策表'],
      detail: '表头缺失',
    };
  }

  const chosen = candidates.reduce((best, item) =>
    item.numbers.length > best.numbers.length ? item : best,
  );
  const numbers = chosen.numbers;
  // 行号从 1 开始给人看（headerIndex 是 0 基）
  const where =
    candidates.length > 1
      ? `第 ${chosen.headerIndex + 1} 行那张（共 ${candidates.length} 张 # 开头的表，取编号行最多的一张）`
      : `第 ${chosen.headerIndex + 1} 行`;

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
    ? `${problems.join('；')}（检查的是${where}）`
    : `共 ${numbers.length} 条（#1–#${numbers[numbers.length - 1]}，${where}）`;

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
