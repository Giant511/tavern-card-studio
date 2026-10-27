/**
 * 生成 G7 取证夹具（v0.1.5）—— **只在本地跑，产物不进仓库、不进安装包**。
 *
 * ## 为什么不把夹具放进 `test/fixtures/`
 *
 * 夹具内容是用户真实的世界书（成人向角色扮演设定）与他的自定义规则。
 * 放进仓库等于把用户内容永久写进版本历史；更糟的是，如果哪天有人把它接到
 * UI 的静态资源路径上，就会随 MSI 发出去。
 *
 * 所以：**产物只写进 `client/dist/g7/`**，而 `build:client` 的第 0 步会把整个
 * dist 归档重建 —— 它的生命周期只有"这次截图"。
 *
 * ## 两个形态
 *
 * · `before`：预设不登记 constant、条目也不写「常驻」、规则也没有存在性条件
 *   —— 这就是用户当前遇到的 14 条误报。
 * · `after`：只改规则（`when` 用 `priority` 的**不存在**来排除持续型条目），
 *   **条目文本一字不改** —— 出路三，也是用户打算用的那条路。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = join('client', 'dist', 'g7');
const TEMP = 'D:/Desktop/桌面文件/temp';
const WB_TEXT = join('.verify', 'xiao-worldbook.txt');

const NEEDED = [
  join(TEMP, '幻梦AI世界书格式预设.json'),
  join(TEMP, '幻梦AI平台规则.json'),
  WB_TEXT,
];

const missing = NEEDED.filter((path) => !existsSync(path));
if (missing.length > 0) {
  console.error('缺少本地输入（这些是用户文件，按设计不入库）：');
  for (const path of missing) console.error('  - ' + path);
  process.exit(2);
}

const presetRaw = JSON.parse(readFileSync(NEEDED[0], 'utf8'));
const ruleRaw = JSON.parse(readFileSync(NEEDED[1], 'utf8'));
const wbText = readFileSync(WB_TEXT, 'utf8');

if (!wbText.includes('触动') && !wbText.includes('触发概率')) {
  console.error('世界书文本看起来不对（没找到「触发概率」）—— 检查 .verify/xiao-worldbook.txt');
  process.exit(2);
}

/** before：原样。预设的 labelMap 里没有 constant ⇒ 「常驻」写不进来 */
const before = {
  label: '修复前',
  worldbookText: wbText,
  worldbookPreset: presetRaw,
  platformRule: ruleRaw,
};

/*
 * after：只动规则。
 *
 * 关键一处：`{ field: 'priority', absent: true }` ——
 * `priority`（触发概率）**只出现在持续型条目**上，所以"它不存在"正好等价于
 * "这是关键词型条目"。于是「没有关键词」这条规则只对关键词型求值，持续型被跳过。
 *
 * 内置规则 `builtin:worldbook-no-trigger` 也是同样的误报来源，所以用一个同 id 的
 * 规则覆盖它（同 id 覆盖是既有语义，不是特例）。
 */
const ruleAfter = JSON.parse(JSON.stringify(ruleRaw));
for (const id of ['wb-keys-required-when-not-constant', 'wb-position-range-when-not-constant']) {
  const target = ruleAfter.rules.find((rule) => rule.id === id);
  if (target) target.when = { field: 'priority', absent: true };
}
ruleAfter.rules.push({
  id: 'builtin:worldbook-no-trigger',
  type: 'list-count',
  min: 1,
  message: '世界书{entry}没有任何关键词，也不是常驻 —— 永远不会被触发',
  hint: '补关键词，或把 constant 设为 true 让它常驻',
  scope: 'worldbook:entries[].keys',
  severity: 'warning',
  category: 'worldbook',
  when: { field: 'priority', absent: true },
});

const after = {
  label: '修复后（出路三：when 存在性条件，条目文本未改）',
  worldbookText: wbText,
  worldbookPreset: presetRaw,
  platformRule: ruleAfter,
};

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, payload] of [
  ['before', before],
  ['after', after],
]) {
  const file = join(OUT_DIR, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`  ${file}  ${Buffer.byteLength(JSON.stringify(payload))} 字节`);
}
console.log('夹具已生成（只在 dist 里，build:client 会连带清掉）');
