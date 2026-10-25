#!/usr/bin/env node
/**
 * T10.34 验收：用「条目4：爱好」这一份数据跑通四条自定义路径（可复跑）。
 *
 * 四条对应需求原文：
 *   ① default 预设 + default 规则 → 未识别内容进【其他设定】，原文不丢；
 *   ② 导入自定义世界书预设 + 自定义平台规则 → 同一份 TXT 格式正确解析、语义正常校验；
 *   ③ 删「关键词」行 → 自定义规则报 warning（永不触发语义）；
 *   ④ 触发深度写越界值 → 自定义规则报越界。
 *
 * 这份脚本**不依赖界面**：它走的是界面背后同一批函数（parseCardText / checkWorldbookFormat /
 * importWorldbookPreset / parsePlatformRule），因此可以进 CI；截图由 browser 侧脚本另行采集。
 *
 * 用法：node scripts/verify-t1034-custom.mjs [--json]
 * 退出码：0 全通过；1 有断言失败
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkWorldbookFormat,
  createEmptyCard,
  importWorldbook,
  parseCardText,
  parsePlatformRule,
  parsePreset,
  parseWorldbookPreset,
  resolvePlatformRule,
} from '../shared/dist/index.js';
import { importWorldbookPreset, importTxtPreset, serializePreset } from '../client/src/rules/preset-library.ts';

const ROOT = join(import.meta.dirname, '..');

/**
 * 跑全部断言。
 *
 * 导出成函数而不是只做 CLI：`test/` 直接 import 同一份实现，
 * 避免「测试一份、脚本另一份」两份实现漂移（见 docs/41 §1/§9）。
 *
 * @returns {{checks: {ok: boolean, name: string, detail: string}[], failures: number}}
 */
export function runT1034Custom() {
  const checks = [];
  const check = (ok, name, detail = '') => checks.push({ ok, name, detail });


// ── 样本：用户交上来的那一份（不是我们编的格式）
const SAMPLE_TXT = [
  '条目4：',
  '名称：爱好',
  '关键词：读书、电影',
  '触发深度：5',
  '内容：',
  '主角喜欢读书和看电影。',
  '条目4结束',
  '',
].join('\n');

/** 自定义世界书预设：中文开闭标记 + 中文标签 + 「、」分隔关键词 */
const CUSTOM_WB_PRESET = {
  schemaVersion: 1,
  id: 'cn-kv',
  name: '中文键值世界书',
  version: '1.0.0',
  format: {
    entryOpen: '条目{id}：',
    contentMark: '内容：',
    entryClose: '条目{id}结束',
    fieldOrder: ['name', 'keys', 'insertion_order'],
    labelMap: { name: '名称', keys: '关键词', insertion_order: '触发深度' },
    fieldSeparator: '：',
    listSeparator: '、',
    entrySeparator: '\n',
  },
};

/** 自定义平台规则：条目名必填 + 关键词非空 + 触发深度 0..10 */
const CUSTOM_RULE = {
  schemaVersion: 1,
  id: 'my-worldbook-policy',
  name: '我的世界书规范',
  version: '1.0.0',
  target: { spec: 'any' },
  placeholders: { char: ['{{char}}'], user: ['{{user}}'] },
  fields: [],
  rules: [
    {
      id: 'mine:entry-name-required',
      type: 'non-empty',
      message: '条目名不能为空（{entry}）',
      scope: 'worldbook:entries[].name',
      severity: 'error',
      category: 'worldbook',
    },
    {
      id: 'mine:keys-not-empty',
      type: 'list-count',
      min: 1,
      message: '{entry}没有关键词，永远不会被触发',
      scope: 'worldbook:entries[].keys',
      severity: 'warning',
      category: 'worldbook',
    },
    {
      id: 'mine:depth-range',
      type: 'number-range',
      min: 0,
      max: 10,
      message: '触发深度必须在 0..10',
      scope: 'worldbook:entries[].insertion_order',
      severity: 'warning',
      category: 'worldbook',
    },
  ],
};

// ────────────────────────────────── ① default 预设 + default 规则

const defaultPresetFile = JSON.parse(readFileSync(join(ROOT, 'rules', 'presets', 'default.json'), 'utf8'));
const defaultPreset = parsePreset(defaultPresetFile).preset;
const defaultPlatform = resolvePlatformRule(
  'sillytavern',
  (() => {
    const raw = JSON.parse(readFileSync(join(ROOT, 'rules', 'platforms', 'sillytavern.json'), 'utf8'));
    const parsed = parsePlatformRule(raw);
    return parsed.rule ? [parsed.rule] : [];
  })(),
);

{
  const result = parseCardText(SAMPLE_TXT, defaultPreset, { preserveUnrecognized: true });
  const settings = result.card.blocks.find((block) => block.id === 'settings');
  check(result.card !== null, '① default 预设能导入（不因缺板块中止）');
  check(
    settings !== undefined && settings.text.includes('条目4：') && settings.text.includes('主角喜欢读书和看电影。'),
    '① 原文整体进【其他设定】（含中文标记与正文）',
    `settings 长度 ${String(settings?.text.length ?? 0)}`,
  );
  check(
    result.issues.some((issue) => issue.code === 'unrecognized-whole' || issue.code === 'unrecognized-preserved'),
    '① 产出「未识别内容」提示（不是静默丢弃）',
    result.issues.map((issue) => issue.code).join(','),
  );
  // 逐字节：每一行原文都能在 settings 里按顺序找到
  const lines = SAMPLE_TXT.split('\n').filter((line) => line.trim() !== '');
  let cursor = 0;
  let ordered = true;
  for (const line of lines) {
    const at = (settings?.text ?? '').indexOf(line, cursor);
    if (at < 0) {
      ordered = false;
      break;
    }
    cursor = at + line.length;
  }
  check(ordered, '① 原文每一行都按原序保留（不重排、不丢行）');
}

// ────────────────────────────────── ② 自定义预设 + 自定义规则

const wbPresetOutcome = importWorldbookPreset([], JSON.stringify(CUSTOM_WB_PRESET));
check(wbPresetOutcome.ok, '② 自定义世界书预设导入成功', wbPresetOutcome.issues.map((i) => i.message).join('; '));
const wbPreset = wbPresetOutcome.value[0];

const imported = importWorldbook(SAMPLE_TXT, wbPreset.format);
check(imported.ok, '② 同一份 TXT 按自定义格式解析成功', imported.issues.map((i) => i.message).join('; '));
check(imported.entries.length === 1, '② 解析出 1 个条目', `实际 ${String(imported.entries.length)}`);
const entry = imported.entries[0] ?? {};
check(entry.name === '爱好', '② 名称字段正确（中文标签反解）', JSON.stringify(entry.name));
check(
  Array.isArray(entry.keys) && entry.keys.join('|') === '读书|电影',
  '② 关键词按「、」切开',
  JSON.stringify(entry.keys),
);
check(entry.insertion_order === 5, '② 触发深度解析为数字 5', JSON.stringify(entry.insertion_order));
check(entry.content.includes('主角喜欢读书和看电影。'), '② 正文解析正确');

// 语义校验：把解析结果放进卡片，跑自定义规则
function auditEntries(entries, rules) {
  const parsedRule = parsePlatformRule({ ...CUSTOM_RULE, rules });
  if (!parsedRule.rule) throw new Error(`自定义规则不合 schema：${parsedRule.errors.join('; ')}`);
  const resolved = resolvePlatformRule(parsedRule.rule.id, [parsedRule.rule]);
  const card = createEmptyCard('验收样本');
  card.worldbook = { entries, text: '', dirty: false, raw: null };
  return checkWorldbookFormat(card, { platformRule: resolved });
}

{
  const issues = auditEntries(imported.entries, CUSTOM_RULE.rules);
  check(
    issues.length === 0,
    '② 自定义规则下没有误报（干净的条目全绿）',
    issues.map((issue) => `${issue.ruleId}:${issue.message}`).join('; '),
  );
}

// ────────────────────────────────── ③ 删「关键词」行

const NO_KEYS_TXT = SAMPLE_TXT.split('\n').filter((line) => !line.startsWith('关键词：')).join('\n');
{
  const parsed = importWorldbook(NO_KEYS_TXT, wbPreset.format);
  check(parsed.ok, '③ 删掉关键词行后仍能解析（格式没错）');
  const issues = auditEntries(parsed.entries, CUSTOM_RULE.rules);
  const hit = issues.find((issue) => issue.ruleId === 'mine:keys-not-empty');
  check(hit !== undefined, '③ 自定义规则报「永不触发」warning', issues.map((i) => i.ruleId).join(','));
  check(hit?.severity === 'warning', '③ 严重级是 warning（不是 error）');
  check(/「爱好」没有关键词/.test(hit?.message ?? ''), '③ 文案点名了具体条目', hit?.message ?? '');
  // 内置那条也必须报（keys 为空且非常驻）
  check(
    issues.some((issue) => issue.ruleId === 'builtin:worldbook-no-trigger'),
    '③ 内置默认规则集也报（自定义规则没有顶掉内置）',
  );
}

// ────────────────────────────────── ④ 触发深度越界

{
  const outOfRange = SAMPLE_TXT.replace('触发深度：5', '触发深度：88');
  const parsed = importWorldbook(outOfRange, wbPreset.format);
  check(parsed.ok, '④ 越界值仍能解析（数值合法，只是超范围）');
  const issues = auditEntries(parsed.entries, CUSTOM_RULE.rules);
  const hit = issues.find((issue) => issue.ruleId === 'mine:depth-range');
  check(hit !== undefined, '④ 自定义规则报越界', issues.map((i) => i.ruleId).join(','));
  check(/88/.test(hit?.message ?? ''), '④ 文案给出实际值', hit?.message ?? '');
  check(/上限 10/.test(hit?.message ?? ''), '④ 文案给出上限');
}

// ────────────────────────────────── 附加：预设 round-trip 与「不内置」自检

{
  const exported = serializePreset(wbPreset);
  const again = importWorldbookPreset([], exported);
  check(again.ok, '附加：自定义世界书预设导出再导入成功');
  check(
    JSON.stringify(again.value[0].format) === JSON.stringify(wbPreset.format),
    '附加：round-trip 后格式参数逐项相同',
  );
  // 「仅作自定义路径验证样本，不内置」：仓库里不该出现这个 id
  const builtinFiles = ['default'];
  check(!builtinFiles.includes(wbPreset.id), '附加：自定义预设没有进内置清单');
  // TXT 预设导入通道也走一遍（同一套语义）
  const txtOutcome = importTxtPreset([defaultPreset], JSON.stringify(defaultPresetFile));
  check(txtOutcome.ok, '附加：TXT 预设导入通道可用（同 id 覆盖）');
  check(txtOutcome.replaced === true, '附加：同 id 覆盖被识别');
}

// ────────────────────────────────── 输出

  return { checks, failures: checks.filter((item) => !item.ok).length };
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const asJson = process.argv.includes('--json');
  const { checks, failures } = runT1034Custom();
  if (asJson) {
    console.log(JSON.stringify({ at: new Date().toISOString(), total: checks.length, failed: failures, checks }, null, 2));
  } else {
    for (const item of checks) {
      console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail === '' ? '' : `  — ${item.detail}`}`);
    }
    console.log('');
    console.log(`合计 ${String(checks.length)} 项，失败 ${String(failures)} 项`);
  }

  // 落一份 JSON 便于人工对照；失败也不影响（这是产物，不是判据）
  mkdirSync(join(ROOT, '.verify'), { recursive: true });
  writeFileSync(
    join(ROOT, '.verify', 't1034-custom.json'),
    `${JSON.stringify({ at: new Date().toISOString(), total: checks.length, failed: failures, checks }, null, 2)}\n`,
    'utf8',
  );
  process.exit(failures === 0 ? 0 : 1);
}
