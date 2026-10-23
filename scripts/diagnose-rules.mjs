/**
 * 附件规则诊断（v0.1.2 任务二）—— 用 shared 真实引擎实跑，不靠肉眼推断。
 *
 * 诊断对象：
 *   · D:/Desktop/通用高亮配置.json（高亮方案，本轮上传的这版）
 *   · D:/Desktop/幻梦AI.json（平台规则）
 *
 * 输出：逐规则命中区间数 / 被切碎数 / 零命中及原因；平台规则校验错误清单；
 * 三个专项核实的实测结论。报告落到 .verify/rules/diagnostic.json。
 *
 * 用法：node scripts/diagnose-rules.mjs [高亮文件] [平台规则文件]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildAuditReport,
  compileHighlightRule,
  computeHighlightSpans,
  loadPlatformRules,
  loadPresets,
  parseHighlightRule,
  parsePlatformRule,
  parseStCard,
  resolveHighlightRule,
  resolvePlatformRule,
} from '../shared/dist/index.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, '.verify', 'rules');
const HL_PATH = process.argv[2] ?? 'D:/Desktop/通用高亮配置.json';
const PR_PATH = process.argv[3] ?? 'D:/Desktop/幻梦AI.json';

mkdirSync(OUT, { recursive: true });

const card = parseStCard(JSON.parse(readFileSync(join(REPO, 'test', 'fixtures', 'sample-card.json'), 'utf8'))).card;
const preset = loadPresets([JSON.parse(readFileSync(join(REPO, 'rules', 'presets', 'default.json'), 'utf8'))]).presets[0];

// 被高亮的文本 = 六个板块按顺序拼起来（与编辑器里实际渲染的文本同源）
const CARD_TEXT = card.blocks.map((b) => b.text).join('\n\n');

const out = { at: new Date().toISOString(), highlightFile: HL_PATH, platformFile: PR_PATH };

const section = (title) => console.log(`\n${'='.repeat(64)}\n${title}\n${'='.repeat(64)}`);

// ══════════════════════════════════════════════════════════
// 一、高亮方案
// ══════════════════════════════════════════════════════════
section('一、高亮方案：' + HL_PATH);
const hlJson = JSON.parse(readFileSync(HL_PATH, 'utf8'));
const hlParsed = parseHighlightRule(hlJson);
console.log(`解析：file=${hlParsed.file ? 'ok' : 'null'} errors=${hlParsed.errors.length} warnings=${hlParsed.warnings.length}`);
for (const e of hlParsed.errors) console.log('  ✘ ' + e);
for (const w of hlParsed.warnings) console.log('  ⚠ ' + w);

out.highlight = { parse: { ok: !!hlParsed.file, errors: hlParsed.errors, warnings: hlParsed.warnings } };

if (hlParsed.file) {
  const resolved = resolveHighlightRule(hlParsed.file.id, [hlParsed.file, ...loadBuiltinHighlights()]);
  const compiled = compileHighlightRule(resolved);
  const allSpans = computeHighlightSpans(CARD_TEXT, compiled);

  console.log(`\n规则数=${compiled.rules.length}  scope 数=${Object.keys(compiled.scopes).length}  文本 ${CARD_TEXT.length} 字符`);
  console.log(`全量命中区间=${allSpans.length}`);
  console.log(`theme: fg=${compiled.theme?.foreground} bg=${compiled.theme?.background}`);

  // 逐规则：单独跑 vs 全量跑
  const perRule = [];
  console.log('\n逐规则统计（单独跑 = 只有这条规则时的命中；全量 = 与其它规则竞争后的存活）：');
  console.log('  id'.padEnd(28) + 'scope'.padEnd(22) + 'prio  单独  全量  被切碎字符');
  for (const item of compiled.rules) {
    const soloCompiled = { ...compiled, rules: [item] };
    const solo = computeHighlightSpans(CARD_TEXT, soloCompiled);
    const inAll = allSpans.filter((s) => s.ruleId === item.id);
    const soloChars = solo.reduce((n, s) => n + (s.end - s.start), 0);
    const allChars = inAll.reduce((n, s) => n + (s.end - s.start), 0);
    perRule.push({
      id: item.id,
      scope: item.scope,
      priority: item.priority,
      solo: solo.length,
      kept: inAll.length,
      soloChars,
      keptChars: allChars,
      eatenChars: Math.max(0, soloChars - allChars),
      zeroHit: solo.length === 0,
    });
    console.log(
      `  ${item.id.padEnd(26)}${item.scope.padEnd(22)}${String(item.priority).padStart(4)}` +
        `${String(solo.length).padStart(6)}${String(inAll.length).padStart(6)}${String(Math.max(0, soloChars - allChars)).padStart(9)}`,
    );
  }
  const zero = perRule.filter((r) => r.zeroHit);
  if (zero.length > 0) {
    console.log('\n零命中规则：');
    for (const r of zero) console.log(`  · ${r.id}（scope=${r.scope}）在 sample-card 上没有任何匹配`);
  }
  const noPriority = compiled.rules.filter((r) => r.priority === 0).length;
  console.log(`\npriority 缺失（归 0）的规则数 = ${noPriority} / ${compiled.rules.length}`);

  out.highlight.engine = {
    ruleCount: compiled.rules.length,
    scopeCount: Object.keys(compiled.scopes).length,
    textLength: CARD_TEXT.length,
    totalSpans: allSpans.length,
    theme: compiled.theme ?? null,
    perRule,
    zeroHit: zero.map((r) => r.id),
    rulesWithoutPriority: noPriority,
    scopes: resolved.scopes.map((s) => ({ id: s.id, label: s.label, color: s.color })),
  };
}

// ══════════════════════════════════════════════════════════
// 二、平台规则
// ══════════════════════════════════════════════════════════
section('二、平台规则：' + PR_PATH);
const prJson = JSON.parse(readFileSync(PR_PATH, 'utf8'));
const prParsed = parsePlatformRule(prJson);
console.log(`解析：rule=${prParsed.rule ? 'ok' : 'null'} errors=${prParsed.errors.length}`);
for (const e of prParsed.errors) console.log('  ✘ ' + e);
out.platform = { parse: { ok: !!prParsed.rule, errors: prParsed.errors } };

if (prParsed.rule) {
  const rule = prParsed.rule;
  console.log(`\nid=${rule.id} extends=${rule.extends ?? 'null'}`);
  console.log(`fields=${rule.fields.length}  rules=${rule.rules.length}  autoFix=${rule.autoFix?.length ?? 0}`);
  console.log('scope 值：', rule.rules.map((r) => JSON.stringify(r.scope)).join(' '));
  console.log('fields 路径：', rule.fields.map((f) => f.path).join(', '));

  // 实跑：把它当唯一平台规则，跑 sample-card
  const builtin = loadPlatformRules(
    ['sillytavern'].map((n) => JSON.parse(readFileSync(join(REPO, 'rules', 'platforms', `${n}.json`), 'utf8'))),
  ).rules;
  let report = null;
  let runError = null;
  try {
    // parsePlatformRule 的产物与 loadPlatformRules 的元素同形，可直接用
    const platformRule = resolvePlatformRule('sillytavern', [...builtin]);
    const merged = { ...platformRule, ...rule, extends: null };
    report = buildAuditReport(card, { platformRule: merged, preset });
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
  }

  if (runError) {
    console.log(`\n实跑失败：${runError}`);
    out.platform.run = { error: runError };
  } else {
    const by = { error: 0, warning: 0, info: 0 };
    for (const i of report.issues) by[i.severity] += 1;
    console.log(`\n实跑 sample-card：issues=${report.issues.length} e=${by.error} w=${by.warning} i=${by.info}`);
    // 哪些问题来自这份规则的 rules[]（ruleId 命中）
    const ruleIds = new Set(rule.rules.map((r) => r.id));
    const fromThis = report.issues.filter((i) => i.ruleId && ruleIds.has(i.ruleId));
    console.log(`其中来自本文件 rules[] 的：${fromThis.length}`);
    for (const i of fromThis) console.log(`  [${i.severity}] ${i.ruleId} — ${i.message.slice(0, 60)}`);
    const fromFields = report.issues.filter((i) => i.category === 'platform-rule' && !i.ruleId);
    console.log(`来自 fields[] 的：${fromFields.length}`);
    for (const i of fromFields) console.log(`  [${i.severity}] ${i.message.slice(0, 60)}`);

    out.platform.run = {
      total: report.issues.length,
      severity: by,
      fromRules: fromThis.map((i) => ({ ruleId: i.ruleId, severity: i.severity, message: i.message })),
      fromFields: fromFields.map((i) => ({ severity: i.severity, message: i.message })),
      ruleIdsThatFired: [...new Set(fromThis.map((i) => i.ruleId))],
    };
  }

  // ── 关键对照：sample-card 本身合规，所以"0 条"不能证明规则没接上 ──
  // 造一张**彻底**违规的卡：占位符要从所有承载文本的地方清掉，
  // 否则 worldbook / residual 里残留一个 {{char}} 就会让 aggregate 统计过关，
  // 看起来像"规则没生效"，其实是我的样本不够脏（第一次就差点这么误判）。
  const bad = structuredClone(card);
  bad.meta.name = '';
  bad.residual.firstMes = '';
  const scrub = (text) =>
    text
      .replace(/\{\{char\}\}/g, '林晚照')
      .replace(/\{\{user\}\}/g, '我');
  for (const block of bad.blocks) block.text = scrub(block.text);
  bad.worldbook.text = scrub(bad.worldbook.text);
  for (const entry of bad.worldbook.entries) {
    if (typeof entry.content === 'string') entry.content = scrub(entry.content);
  }
  for (const key of Object.keys(bad.residual)) {
    const value = bad.residual[key];
    if (typeof value === 'string') bad.residual[key] = scrub(value);
  }
  bad.blocks[0].text += '\n<BOT> 你好，{{ user }}。';

  const builtin2 = loadPlatformRules(
    ['sillytavern'].map((n) => JSON.parse(readFileSync(join(REPO, 'rules', 'platforms', `${n}.json`), 'utf8'))),
  ).rules;
  const mergedForBad = { ...resolvePlatformRule('sillytavern', builtin2), ...rule, extends: null };
  const badReport = buildAuditReport(bad, { platformRule: mergedForBad, preset });
  const badFromRules = badReport.issues.filter((i) => i.ruleId && new Set(rule.rules.map((r) => r.id)).has(i.ruleId));

  console.log('\n对照实验：换成一张明确违规的卡（角色名空、first_mes 空、去掉 {{char}}、加 <BOT> 与 {{ user }}）');
  console.log(`  总问题数=${badReport.issues.length}，其中命中本文件 rules[] 的=${badFromRules.length}`);
  for (const i of badFromRules) console.log(`  ✔ [${i.severity}] ${i.ruleId} — ${i.message.slice(0, 60)}`);
  const firedIds = new Set(badFromRules.map((i) => i.ruleId));
  const notFired = rule.rules.filter((r) => !firedIds.has(r.id));
  if (notFired.length) {
    console.log('  未触发的规则：');
    for (const r of notFired) console.log(`    · ${r.id}（${r.type}）`);
  }
  const badFields = badReport.issues.filter((i) => i.ruleId?.startsWith('builtin:field-'));
  console.log(`  fields[] 命中的问题：${badFields.length}`);
  for (const i of badFields) console.log(`    [${i.severity}] ${i.ruleId} — ${i.message.slice(0, 60)}`);

  out.platform.violationRun = {
    total: badReport.issues.length,
    fromRules: badFromRules.map((i) => ({ ruleId: i.ruleId, severity: i.severity, message: i.message })),
    firedRuleIds: [...firedIds],
    notFired: notFired.map((r) => ({ id: r.id, type: r.type })),
    fromFields: badFields.map((i) => ({ ruleId: i.ruleId, severity: i.severity, message: i.message })),
  };
}

// ══════════════════════════════════════════════════════════
// 三、三个专项核实
// ══════════════════════════════════════════════════════════
section('三、专项核实');

// a. scope 合法值集合 + "*" 的实际行为
{
  const probes = ['*', 'block:basic', 'field:meta.name', 'basic', 'all', 'block:*'];
  const resultsA = probes.map((value) => {
    const candidate = {
      ...JSON.parse(JSON.stringify(prJson)),
      id: `probe-${Math.abs(hash(value))}`,
      extends: null,
      rules: [
        {
          id: 'probe-rule',
          type: 'placeholder-min-count',
          token: 'char',
          min: 1,
          scope: value,
          severity: 'info',
          message: 'probe',
        },
      ],
      fields: [],
      autoFix: [],
    };
    const parsed = parsePlatformRule(candidate);
    return { scope: value, accepted: !!parsed.rule, errors: parsed.errors };
  });
  console.log('\na) scope 合法值实测：');
  for (const r of resultsA) {
    console.log(`   ${JSON.stringify(r.scope).padEnd(20)} → ${r.accepted ? '接受' : '拒绝'}${r.accepted ? '' : '：' + r.errors[0]}`);
  }
  out.probeScope = resultsA;
}

// b. first_mes 路径是否存在
{
  const paths = ['first_mes', 'name', 'meta.name', 'description', 'mes_example', 'scenario'];
  const resultsB = paths.map((path) => {
    // 造一张对应字段为空的卡，看该 path 的 required 检查是否真的报出来。
    // first_mes 属于 UnifiedCard.residual（键名 firstMes），不是板块文本 ——
    // 第一次探测把它设到 residual.st.first_mes 上了，那是错的（等于什么都没改）。
    const probeCard = structuredClone(card);
    if (path === 'meta.name' || path === 'name') probeCard.meta.name = '';
    if (path === 'first_mes') probeCard.residual.firstMes = '';
    if (path === 'mes_example') probeCard.residual.mesExample = '';
    if (path === 'scenario') probeCard.residual.scenario = '';
    if (path === 'description') for (const b of probeCard.blocks) b.text = '';

    const rule = {
      schemaVersion: 1,
      id: `probe-path-${Math.abs(hash(path))}`,
      name: 'probe',
      version: '1.0.0',
      extends: null,
      target: { spec: 'any' },
      placeholders: { char: ['{{char}}'], user: ['{{user}}'] },
      fields: [
        { path, label: 'probe', required: true, minLength: 1, severity: 'error', message: `probe:${path} 缺失` },
      ],
      rules: [],
      autoFix: [],
    };
    const parsed = parsePlatformRule(rule);
    if (!parsed.rule) return { path, accepted: false, errors: parsed.errors, fired: false, severitySeen: null };
    const report = buildAuditReport(probeCard, { platformRule: parsed.rule, preset });
    const hit = report.issues.find((i) => i.message === `probe:${path} 缺失`);
    return {
      path,
      accepted: true,
      errors: [],
      fired: !!hit,
      severitySeen: hit?.severity ?? null,
      // 有 ST 缺省值的字段会被降级为 info（T4.2 两级语义），这里一并记录
      downgraded: hit ? hit.severity !== 'error' : null,
    };
  });
  console.log('\nb) fields[].path 实测（造空值，看 required 是否真的报出来）：');
  for (const r of resultsB) {
    if (!r.accepted) {
      console.log(`   ${r.path.padEnd(14)} → 被解析器拒绝：${r.errors[0]}`);
      continue;
    }
    const state = r.fired ? `有效（报出 ${r.severitySeen}${r.downgraded ? '，因有 ST 缺省值被降级' : ''}）` : '无效（检查被静默跳过）';
    console.log(`   ${r.path.padEnd(14)} → ${state}`);
  }
  out.probePath = resultsB;
}

// c. 未知顶层键
{
  const schemaKeys = new Set([
    'schemaVersion', 'id', 'name', 'version', 'description', 'extends',
    'target', 'placeholders', 'fields', 'rules', 'autoFix', 'metadata',
  ]);
  const fileKeys = Object.keys(prJson);
  const unknown = fileKeys.filter((k) => !schemaKeys.has(k));
  console.log('\nc) 顶层键核对：');
  console.log('   文件里的键：', fileKeys.join(', '));
  console.log('   Schema 认可的键：', [...schemaKeys].join(', '));
  console.log('   未知键：', unknown.length ? unknown.join(', ') : '（无）');
  console.log('   → target / placeholders / autoFix 都是 Schema 内的正规键，不是"另一个引擎的字段"');
  out.probeKeys = { fileKeys, unknown };
}

// ══════════════════════════════════════════════════════════
// 四、CSS 选择器生成（"没有反应"的关键一环）
// ══════════════════════════════════════════════════════════
section('四、CSS 选择器生成（复现 applySchemeStyles 的拼接逻辑）');
if (hlParsed.file) {
  const cssLines = [];
  for (const scope of hlParsed.file.scopes) {
    // 与 client/src/editor/highlight.ts:119 完全同构：模板字符串直接拼 id
    cssLines.push(`.tcs-hl-${scope.id}{color:${scope.color}}`);
  }
  const css = cssLines.join('\n');
  console.log(css.split('\n').slice(0, 4).join('\n'));
  const dotted = hlParsed.file.scopes.filter((s) => s.id.includes('.'));
  console.log(`\n含点号的 scope id：${dotted.length} / ${hlParsed.file.scopes.length}`);
  for (const s of dotted) {
    console.log(`  "${s.id}" → CSS 类 .tcs-hl-${s.id} 会被解析成「同时有 tcs-hl-${s.id.split('.')[0]} 与 ${s.id.split('.').slice(1).join('.')} 两个类」`);
  }
  out.css = { generated: cssLines, dottedScopeIds: dotted.map((s) => s.id) };
}

writeFileSync(join(OUT, 'diagnostic.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log(`\n报告已写入 ${join(OUT, 'diagnostic.json')}`);

// ── 辅助 ────────────────────────────────────────────────
function loadBuiltinHighlights() {
  // 仓库内置高亮方案（用于解析 extends 链）
  const dir = join(REPO, 'rules', 'highlight');
  const files = ['default', 'minimal', 'dialogue'].map((n) => {
    try {
      return parseHighlightRule(JSON.parse(readFileSync(join(dir, `${n}.json`), 'utf8'))).file;
    } catch {
      return null;
    }
  });
  return files.filter(Boolean);
}

function hash(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) | 0;
  return h;
}
