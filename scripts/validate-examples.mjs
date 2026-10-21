/**
 * 范例文件校验（可复跑）。
 *
 * 目的：examples/ 是交付给用户照抄的样本，**必须真的能用**。
 * 只断言"文件存在"没有意义，这里逐个走真实解析链路：
 *   · 卡片 JSON → parseStCard（并检查规格/板块/世界书）
 *   · TXT → applyCardText 宽松导入
 *   · 世界书 TXT → parseWorldbookText
 *   · 平台规则 / 高亮方案 / 预设 → 对应 parse + resolve/compile
 *   · 坏规则 → **必须被拒绝**（否则示例会误导用户）
 *
 * 用法：node scripts/validate-examples.mjs
 * 退出码：0 全部通过；1 有失败项
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyCardText,
  compileHighlightRule,
  importHighlightRuleText,
  loadPlatformRules,
  loadPresets,
  parsePlatformRule,
  parseStCard,
  parseWorldbookText,
  renderWorldbookText,
  resolveHighlightRule,
  resolvePlatformRule,
} from '@tcs/shared';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EX = join(REPO, 'examples');
const readJson = (rel) => JSON.parse(readFileSync(join(EX, rel), 'utf8'));
const readText = (rel) => readFileSync(join(EX, rel), 'utf8');

let failures = 0;
function check(ok, label, detail = '') {
  if (ok) {
    console.log(`  ✔ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✘ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

const builtinRules = ['sillytavern', 'character-card-v2', 'character-card-v3', 'janitorai', 'chub'].map(
  (name) => JSON.parse(readFileSync(join(REPO, 'rules/platforms', `${name}.json`), 'utf8')),
);
const builtinHighlights = ['default', 'dark', 'minimal'].map((name) =>
  JSON.parse(readFileSync(join(REPO, 'rules/highlight', `${name}.json`), 'utf8')),
);
const builtinPresets = ['default', 'divider', 'markdown'].map((name) =>
  JSON.parse(readFileSync(join(REPO, 'rules/presets', `${name}.json`), 'utf8')),
);

// ── 卡片 ───────────────────────────────────────────────────
console.log('范例卡片');
for (const file of readdirSync(join(EX, 'cards')).filter((name) => name.endsWith('.json'))) {
  const rel = join('cards', file);
  try {
    const parsed = parseStCard(readJson(rel));
    const isBrokenSample = file.startsWith('broken-');
    const name = parsed.card.meta.name;
    if (isBrokenSample) {
      // 坏样本允许 name 为空，但结构必须仍能解析（否则演示不出"审计拦截"）
      check(name === '', `${rel} 应故意缺 name`, `实际 name=${JSON.stringify(name)}`);
    } else {
      check(name !== '', `${rel} 可解析且 name 非空（${name}）`);
    }
    check(parsed.card.blocks.length >= 5, `${rel} 至少 5 个板块`, `实际 ${parsed.card.blocks.length}`);
  } catch (error) {
    check(false, `${rel} 可解析`, error instanceof Error ? error.message : String(error));
  }
}

// v3 规格
try {
  const v3 = parseStCard(readJson('cards/lin-wanzhao-v3.json')).card;
  check(v3.meta.spec === 'v3', 'v3 样例被识别为 v3 规格', `实际 ${v3.meta.spec}`);
} catch (error) {
  check(false, 'v3 样例规格识别', String(error));
}

// ── TXT ────────────────────────────────────────────────────
console.log('\n范例 TXT');
const preset = loadPresets(builtinPresets).presets.find((item) => item.id === 'default');
const cardForTxt = parseStCard(readJson('cards/lin-wanzhao-v2.json')).card;
const txt = readText('cards/lin-wanzhao.txt');
const applied = applyCardText(cardForTxt, txt, preset, { mode: 'lenient' });
check(applied.ok, 'cards/lin-wanzhao.txt 可被宽松导入');
if (applied.ok) {
  const filled = applied.card.blocks.filter((block) => block.text.trim() !== '').length;
  check(filled >= 5, '导入后至少 5 个板块有内容', `实际 ${filled}`);
}

const wb = parseWorldbookText(readText('cards/worldbook.txt'));
check(wb.ok, 'cards/worldbook.txt 是合法世界书 TXT');
check(wb.entries.length >= 2, 'worldbook.txt 至少 2 个条目', `实际 ${wb.entries.length}`);
check(
  renderWorldbookText(wb.entries) === readText('cards/worldbook.txt').replace(/\n$/, ''),
  'worldbook.txt 往返后逐字一致',
);

// ── 自定义规则 ─────────────────────────────────────────────
console.log('\n自定义规则');
const strict = readJson('rules/platform-sillytavern-strict.json');
const strictParsed = parsePlatformRule(strict);
check(strictParsed.rule !== null, '严格示例规则通过 schema', strictParsed.errors.join('; '));
if (strictParsed.rule) {
  const merged = [...builtinRules.filter((rule) => rule.id !== strict.id), strictParsed.rule];
  try {
    const resolved = resolvePlatformRule('sillytavern-strict', merged);
    check(resolved.id === 'sillytavern-strict', '严格示例规则可解析（继承链完整）');
    check(
      resolved.rules.some((rule) => rule.id === 'no-halfwidth-brackets'),
      '自定义规则 no-halfwidth-brackets 已并入',
    );
    // 父规则（sillytavern）自带字段定义与内置检查，继承后都应保留
    check(
      resolved.fields.some((field) => field.path === 'meta.name'),
      '继承到了父规则的字段定义（meta.name）',
      resolved.fields.map((f) => f.path).join(', '),
    );
    check(
      resolved.rules.length > 2,
      '继承了父规则的内置检查',
      `合并后共 ${resolved.rules.length} 条`,
    );
  } catch (error) {
    check(false, '严格示例规则继承链', error instanceof Error ? error.message : String(error));
  }
}

const warm = readJson('rules/highlight-warm-paper.json');
const warmImport = importHighlightRuleText(JSON.stringify(warm));
check(warmImport.ok, '暖纸高亮方案通过 schema', warmImport.errors.join('; '));
if (warmImport.ok && warmImport.file) {
  try {
    const merged = [...builtinHighlights.filter((s) => s.id !== warm.id), warmImport.file];
    const resolved = resolveHighlightRule('warm-paper', merged);
    const compiled = compileHighlightRule(resolved);
    check(compiled !== null, '暖纸高亮方案可编译');
    check(resolved.scopes.length >= 8, '继承了父方案的作用域', `实际 ${resolved.scopes.length}`);
  } catch (error) {
    check(false, '暖纸高亮方案编译', error instanceof Error ? error.message : String(error));
  }
}

const hashPreset = readJson('presets/hash-heading.json');
const presetLoad = loadPresets([...builtinPresets, hashPreset]);
const loaded = presetLoad.presets.find((item) => item.id === 'hash-heading');
check(loaded !== undefined, '井号标题预设通过校验', presetLoad.errors.map((e) => JSON.stringify(e)).join('; '));
if (loaded) {
  check(loaded.separator === '\n\n', '预设分隔符为单个空行');
  check(
    Object.values(loaded.headings).every((heading) => heading.pattern.includes('##')),
    '所有标题都带 ## 前缀',
  );
}

// ── 坏样本必须被拒 ─────────────────────────────────────────
console.log('\n坏样本（必须被拒绝）');
const bad = readJson('rules/broken-platform-rule.json');
const badParsed = parsePlatformRule(bad);
check(badParsed.rule === null, 'broken-platform-rule.json 被拒绝（不应导入成功）');
check(badParsed.errors.length >= 2, '至少报出 2 处错误', `实际 ${badParsed.errors.length}`);

const brokenCardParsed = parseStCard(readJson('cards/broken-missing-name.json'));
check(
  brokenCardParsed.card.meta.name === '',
  'broken-missing-name.json 的 name 为空（供审计拦截演示）',
);

// ── 汇总 ───────────────────────────────────────────────────
console.log('');
if (failures === 0) {
  console.log('全部范例通过校验。');
  process.exit(0);
}
console.log(`失败 ${failures} 项。`);
process.exit(1);
