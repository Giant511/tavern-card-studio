/**
 * 生成 examples/ 下的范例文件（可复跑）。
 *
 * 为什么用脚本生成而不是手写 JSON：
 *   · 手写容易漏字段、缩进不一致，范例本身就是"给人看的标准样本"，不能有瑕疵；
 *   · 由真实 shared 代码产出，等于顺带验证了"这些结构确实能被解析/序列化"。
 *
 * 生成后仍有校验：`node scripts/validate-examples.mjs`（见 docs/17）。
 *
 * 用法：node scripts/gen-examples.mjs
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createEmptyCard,
  loadPresets,
  parseStCard,
  planPresetApply,
  applyPresetPlan,
  presetAssembleOptions,
  renderWorldbookText,
  serializeStCard,
} from '@tcs/shared';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'examples');
const readJson = (rel) => JSON.parse(readFileSync(join(REPO, rel), 'utf8'));
const writeJson = (rel, value) => {
  const target = join(OUT, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};
const writeText = (rel, text) => {
  const target = join(OUT, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
};

const preset = loadPresets([readJson('rules/presets/default.json')]).presets[0];
const base = parseStCard(readJson('test/fixtures/sample-card.json')).card;

/** 把卡片按某规格导出为 ST JSON 对象 */
function toSt(card, spec) {
  return serializeStCard(card, { ...presetAssembleOptions(preset), targetSpec: spec });
}

function withBlocks(card, edits) {
  const next = structuredClone(card);
  for (const [id, text] of Object.entries(edits)) {
    const block = next.blocks.find((item) => item.id === id);
    if (block) {
      block.text = text;
      block.dirty = true;
    }
  }
  return next;
}

// ── ① v2 卡片（完整六板块 + 世界书）──────────────────────
writeJson('cards/lin-wanzhao-v2.json', toSt(base, 'v2'));

// ── ② v3 卡片（同内容、不同规格，用于验证规格切换）──────
writeJson('cards/lin-wanzhao-v3.json', toSt(base, 'v3'));

// ── ③ 纯 TXT（六板块，带【】标题与空行分隔）────────────
const txtCard = applyPresetPlan(base, planPresetApply(base, preset));
writeText(
  'cards/lin-wanzhao.txt',
  [
    '【基本信息】',
    txtCard.blocks.find((b) => b.id === 'basic').text,
    '',
    '【性格】',
    txtCard.blocks.find((b) => b.id === 'personality').text,
    '',
    '【其他设定】',
    txtCard.blocks.find((b) => b.id === 'settings').text,
    '',
    '【特殊设定】',
    txtCard.blocks.find((b) => b.id === 'special').text,
    '',
    '【用户相关设定】',
    txtCard.blocks.find((b) => b.id === 'user').text,
  ].join('\n'),
);

// ── ④ 世界书 TXT（v1.0 格式，可直接粘进世界书板块）──────
writeText('cards/worldbook.txt', renderWorldbookText(base.worldbook.entries));

// ── ⑤ 最小卡片：只有姓名与一句描述（演示"缺失板块"）─────
const minimal = createEmptyCard('空白示例');
const minimalCard = withBlocks(minimal, {
  basic: '姓名：{{char}}\n身份：测试用最小卡片',
  personality: '沉默寡言。',
});
writeJson('cards/minimal-v2.json', toSt(minimalCard, 'v2'));

// ── ⑥ 故意缺必填字段的卡（演示导出拦截）─────────────────
const brokenSt = toSt(base, 'v2');
brokenSt.data.name = '';
if (brokenSt.data.description) {
  brokenSt.data.description = brokenSt.data.description.replace(/【基本信息】[\s\S]*?(?=【|$)/, '');
}
writeJson('cards/broken-missing-name.json', brokenSt);

// ── ⑦ 自定义平台规则（继承 sillytavern，加两条更严的规则）──
const strictRule = {
  ...readJson('rules/platforms/sillytavern.json'),
  id: 'sillytavern-strict',
  name: 'SillyTavern（严格示例）',
  version: '1.0.0',
  description: '示例：继承原生规则并追加两条自定义检查，用于演示"自定义规则导入"。',
  extends: 'sillytavern',
  // 规则类型取自 shared 的 RULE_TYPES（regex 不属于平台规则，别照高亮规则的写法抄）
  rules: [
    {
      id: 'no-halfwidth-brackets',
      type: 'pattern-forbid',
      pattern: '\\[[^\\]]{1,20}\\]',
      scope: '*',
      severity: 'warning',
      message: '正文里出现了半角方括号 [ ]，容易与模板占位符混淆',
      hint: '改用全角【】或删掉括号',
    },
    {
      id: 'require-age',
      type: 'pattern-required',
      pattern: '年龄',
      scope: ['block:basic'],
      severity: 'info',
      message: '基本信息里没有写年龄',
      hint: '补一行「年龄：xx」更完整',
    },
  ],
};
writeJson('rules/platform-sillytavern-strict.json', strictRule);

// ── ⑧ 自定义高亮方案（继承 default，改配色）──────────────
const warmScheme = {
  ...readJson('rules/highlight/default.json'),
  id: 'warm-paper',
  name: '暖纸（示例）',
  version: '1.0.0',
  description: '示例：继承默认方案，仅调整主题色与占位符配色。',
  extends: 'default',
  theme: {
    foreground: '#3a2f28',
    background: '#fdf8f0',
    caret: '#c2410c',
    selectionBackground: '#f7e0c8',
  },
  scopes: readJson('rules/highlight/default.json').scopes.map((scope) =>
    scope.id === 'placeholder'
      ? { ...scope, color: '#0f766e', backgroundColor: '#ccfbf1' }
      : scope,
  ),
};
writeJson('rules/highlight-warm-paper.json', warmScheme);

// ── ⑨ 自定义预设（标题用「##」、分隔符用空行）─────────────
const hashPreset = {
  ...readJson('rules/presets/default.json'),
  id: 'hash-heading',
  name: '井号标题（示例）',
  version: '1.0.0',
  description: '示例：标题用 ## 前缀，分隔符用单个空行。',
  headings: Object.fromEntries(
    Object.entries(readJson('rules/presets/default.json').headings).map(([id, value]) => [
      id,
      { ...value, pattern: '## {title}' },
    ]),
  ),
  separator: '\n\n',
};
writeJson('presets/hash-heading.json', hashPreset);

// ── ⑩ 坏规则（演示导入失败与原子回退）────────────────────
const badRule = {
  ...readJson('rules/platforms/sillytavern.json'),
  id: 'broken-demo',
  fields: [
    { ...readJson('rules/platforms/sillytavern.json').fields[0], label: '' },
    { ...readJson('rules/platforms/sillytavern.json').fields[1], required: 'yes' },
  ],
};
writeJson('rules/broken-platform-rule.json', badRule);

console.log('已生成 examples/：');
for (const rel of [
  'cards/lin-wanzhao-v2.json',
  'cards/lin-wanzhao-v3.json',
  'cards/lin-wanzhao.txt',
  'cards/worldbook.txt',
  'cards/minimal-v2.json',
  'cards/broken-missing-name.json',
  'rules/platform-sillytavern-strict.json',
  'rules/highlight-warm-paper.json',
  'rules/broken-platform-rule.json',
  'presets/hash-heading.json',
]) {
  console.log(`  examples/${rel}`);
}
