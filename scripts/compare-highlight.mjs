/**
 * 高亮方案 before/after 对比（v0.1.2 任务二）。
 *
 * 对比两条链：原版 vs 修正版，逐规则给出「单独命中 / 全量存活 / 被切碎字符」，
 * 并复现 applySchemeStyles 的选择器拼接以说明"为什么完全不上色"。
 *
 * 用法：node scripts/compare-highlight.mjs [原版] [修正版]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compileHighlightRule,
  computeHighlightSpans,
  parseHighlightRule,
  parseStCard,
  resolveHighlightRule,
} from '../shared/dist/index.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, '.verify', 'rules');
const BEFORE = process.argv[2] ?? 'D:/Desktop/通用高亮配置.json';
const AFTER = process.argv[3] ?? join(OUT, 'fixed-highlight.json');

mkdirSync(OUT, { recursive: true });

const card = parseStCard(JSON.parse(readFileSync(join(REPO, 'test', 'fixtures', 'sample-card.json'), 'utf8'))).card;
// 与编辑器同源：六板块按顺序拼接。这里额外把开场白与示例对话接上，
// 因为"对话/独白/动作"这些规则主要作用在那两段上。
const BLOCK_TEXT = card.blocks.map((b) => b.text).join('\n\n');
const FULL_TEXT = [BLOCK_TEXT, card.residual.firstMes, card.residual.mesExample].filter(Boolean).join('\n\n');

function builtinSchemes() {
  return ['default', 'minimal', 'dark']
    .map((n) => {
      try {
        return parseHighlightRule(JSON.parse(readFileSync(join(REPO, 'rules', 'highlight', `${n}.json`), 'utf8'))).file;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function analyze(path, label) {
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const parsed = parseHighlightRule(json);
  if (!parsed.file) {
    console.log(`\n${label}：解析失败 —— ${parsed.errors.join('；')}`);
    return null;
  }
  const resolved = resolveHighlightRule(parsed.file.id, [parsed.file, ...builtinSchemes()]);
  const compiled = compileHighlightRule(resolved);

  const rows = [];
  for (const text of [
    { name: '六板块', value: BLOCK_TEXT },
    { name: '六板块+开场白+示例', value: FULL_TEXT },
  ]) {
    const all = computeHighlightSpans(text.value, compiled);
    for (const item of compiled.rules) {
      const solo = computeHighlightSpans(text.value, { ...compiled, rules: [item] });
      const kept = all.filter((s) => s.ruleId === item.id);
      const soloChars = solo.reduce((n, s) => n + (s.end - s.start), 0);
      const keptChars = kept.reduce((n, s) => n + (s.end - s.start), 0);
      rows.push({
        textSet: text.name,
        id: item.id,
        scope: item.scope,
        priority: item.priority,
        solo: solo.length,
        kept: kept.length,
        eaten: Math.max(0, soloChars - keptChars),
        totalSpans: all.length,
      });
    }
  }

  // 复现 applySchemeStyles 的选择器拼接（与 client/src/editor/highlight.ts:119 同构）
  const css = parsed.file.scopes.map((s) => `.tcs-hl-${s.id}{color:${s.color}}`);
  const dotted = parsed.file.scopes.filter((s) => s.id.includes('.'));

  return { label, path, parsed, resolved, compiled, rows, css, dotted };
}

const before = analyze(BEFORE, '原版');
const after = analyze(AFTER, '修正版');

const report = { at: new Date().toISOString(), before: null, after: null };

const render = (data) => {
  if (!data) return;
  const f = data.parsed.file;
  console.log(`\n${'─'.repeat(70)}\n${data.label}：${f.id}（${f.name}）`);
  console.log(`解析 errors=${data.parsed.errors.length} warnings=${data.parsed.warnings.length}  scope=${f.scopes.length}  rules=${f.rules.length}`);
  console.log(`scope id：${f.scopes.map((s) => s.id).join(', ')}`);
  console.log(`priority：${data.compiled.rules.map((r) => r.priority).join(', ')}`);
  console.log('\n  id'.padEnd(28) + 'scope'.padEnd(22) + 'prio  单独  存活  被切碎   text');
  for (const r of data.rows) {
    console.log(
      `  ${r.id.padEnd(26)}${r.scope.padEnd(22)}${String(r.priority).padStart(4)}` +
        `${String(r.solo).padStart(6)}${String(r.kept).padStart(6)}${String(r.eaten).padStart(8)}   ${r.textSet}`,
    );
  }
  const zero = data.rows.filter((r) => r.textSet === '六板块+开场白+示例' && r.solo === 0);
  if (zero.length) console.log(`  零命中：${zero.map((r) => r.id).join(', ')}`);
  const eaten = data.rows.filter((r) => r.textSet === '六板块+开场白+示例' && r.eaten > 0);
  if (eaten.length) console.log(`  被切碎：${eaten.map((r) => `${r.id}(${r.eaten}字)`).join(', ')}`);
  else console.log('  被切碎：无');

  console.log('\n  生成的 CSS 选择器（前 3 条）：');
  for (const line of data.css.slice(0, 3)) console.log('    ' + line);
  if (data.dotted.length) {
    console.log(`  ⚠ ${data.dotted.length} 个 scope id 含点号：${data.dotted.map((s) => s.id).join(', ')}`);
    console.log('    → .tcs-hl-placeholder.char 会被 CSS 解析成「同时有 .tcs-hl-placeholder 和 .char 两个类」，');
    console.log('      而元素上的 class 是 "tcs-hl tcs-hl-placeholder.char"（单个类名），选择器匹配不上 → 完全不上色。');
  } else {
    console.log('  ✔ scope id 无点号，选择器可直接命中');
  }

  return {
    id: f.id,
    errors: data.parsed.errors,
    warnings: data.parsed.warnings,
    scopeIds: f.scopes.map((s) => s.id),
    priorities: data.compiled.rules.map((r) => r.priority),
    rows: data.rows,
    css: data.css,
    dottedScopes: data.dotted.map((s) => s.id),
  };
};

report.before = render(before);
report.after = render(after);

// ── 汇总对比 ──────────────────────────────────────────────
if (before && after) {
  const pick = (data, textSet) => data.rows.filter((r) => r.textSet === textSet);
  const sum = (rows, key) => rows.reduce((n, r) => n + r[key], 0);

  console.log(`\n${'='.repeat(70)}\n汇总（文本集：六板块+开场白+示例）\n${'='.repeat(70)}`);
  const bRows = pick(before, '六板块+开场白+示例');
  const aRows = pick(after, '六板块+开场白+示例');
  console.log(`命中区间总数    原版 ${String(sum(bRows, 'kept')).padStart(3)}  →  修正版 ${String(sum(aRows, 'kept')).padStart(3)}`);
  console.log(`被切碎字符总数  原版 ${String(sum(bRows, 'eaten')).padStart(3)}  →  修正版 ${String(sum(aRows, 'eaten')).padStart(3)}`);
  console.log(`可用 CSS 选择器 原版 ${before.dotted.length === 0 ? '有效' : before.dotted.length + ' 条失效'}  →  修正版 ${after.dotted.length === 0 ? '有效' : after.dotted.length + ' 条失效'}`);
  const pair = bRows.map((b) => ({
    id: b.id,
    before: b.kept,
    after: aRows.find((a) => a.id === b.id)?.kept ?? 0,
  }));
  console.log('\n逐规则命中对比：');
  console.log('  id'.padEnd(30) + '原版  修正版');
  for (const p of pair) console.log(`  ${p.id.padEnd(28)}${String(p.before).padStart(4)}${String(p.after).padStart(8)}`);

  report.summary = {
    beforeKept: sum(bRows, 'kept'),
    afterKept: sum(aRows, 'kept'),
    beforeEaten: sum(bRows, 'eaten'),
    afterEaten: sum(aRows, 'eaten'),
    perRule: pair,
  };
}

writeFileSync(join(OUT, 'highlight-compare.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`\n对比报告：${join(OUT, 'highlight-compare.json')}`);
