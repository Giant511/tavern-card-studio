/**
 * 生成审计报告范例（T4.4 交付物）：docs/assets/audit-report-sample.json
 *
 * 刻意构造一张「问题卡」，让四类来源各出一条：
 *   · 平台规则 error：角色名为空、<BOT> 伪标签、全文缺 {{char}}（aggregate）
 *   · 平台规则 warning：JanitorAI 不支持内嵌世界书
 *   · 格式检查 error：世界书 TXT 重复条目 id（带行号）
 *   · 格式检查 info：标题装饰符与预设不一致、有 ST 缺省值但未写出
 *
 * 运行：node scripts/gen-audit-sample.mjs
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildAuditReport,
  stringifyAuditReport,
  parseStCard,
  loadPlatformRules,
  resolvePlatformRule,
  loadPresets,
  findPreset,
  describeIssueLocation,
} from '../shared/dist/index.js';

const ROOT = join(import.meta.dirname, '..');
const GENERATED_AT = '2026-10-21T04:00:00.000Z';

const DESCRIPTION = [
  '【基本信息】',
  '年龄 24，身高 168cm，咖啡馆夜班店员。',
  '',
  '【其他设定】',
  '<BOT> 说话简短，不爱解释。',
  '',
  '【特殊设定】',
  '她从不进厨房。',
  '',
  '## 用户相关设定',
  '{{user}} 是常来的邻居，两人只在深夜聊天。',
].join('\n');

const WORLDBOOK_TEXT = [
  '@@ENTRY 0',
  'keys: 咖啡馆',
  '@@CONTENT',
  '咖啡馆位于银座四丁目，二楼是仓库。',
  '@@END 0',
  '',
  '@@ENTRY 0',
  'keys: 银耳钉',
  '@@CONTENT',
  '左耳的银耳钉是母亲留下的。',
  '@@END 0',
].join('\n');

function loadRules() {
  const platformInputs = readdirSync(join(ROOT, 'rules', 'platforms'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(ROOT, 'rules', 'platforms', name), 'utf8')));
  const presetInputs = readdirSync(join(ROOT, 'rules', 'presets'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(ROOT, 'rules', 'presets', name), 'utf8')));
  const platforms = loadPlatformRules(platformInputs).rules;
  const presets = loadPresets(presetInputs).presets;
  return {
    platformRule: resolvePlatformRule('janitorai', platforms),
    preset: findPreset(presets, 'default'),
  };
}

function main() {
  const { card } = parseStCard({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '',
      description: DESCRIPTION,
      personality: '冷淡，但记得每位常客的口味。',
      scenario: '',
      first_mes: '你来啦。今天还是老样子？',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: ['原创'],
      creator: '',
      character_version: '',
      extensions: {},
      character_book: {
        name: '咖啡馆',
        entries: [
          { id: 0, keys: ['咖啡馆'], content: '咖啡馆位于银座四丁目，二楼是仓库。' },
          { id: 1, keys: ['银耳钉'], content: '左耳的银耳钉是母亲留下的。' },
        ],
      },
    },
  });

  // 用户把世界书 TXT 改坏了：第二条 id 写成了 0（重复）
  card.worldbook.text = WORLDBOOK_TEXT;
  card.worldbook.dirty = true;

  const { platformRule, preset } = loadRules();
  const report = buildAuditReport(card, {
    platformRule,
    preset,
    rawJsonText: JSON.stringify({ spec: 'chara_card_v2', data: { name: '示例' } }),
    now: () => GENERATED_AT,
  });

  const outDir = join(ROOT, 'docs', 'assets');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'audit-report-sample.json');
  writeFileSync(outPath, `${stringifyAuditReport(report)}\n`, 'utf8');

  console.log(`✔ 已写出 ${outPath}`);
  console.log(`  问题 ${report.issues.length} 条：error=${report.summary.error} warning=${report.summary.warning} info=${report.summary.info} exportable=${report.summary.exportable}`);
  for (const issue of report.issues) {
    console.log(`  ${issue.severity.padEnd(7)} ${issue.category.padEnd(13)} ${describeIssueLocation(issue).padEnd(22)} ${issue.ruleId}`);
  }
  console.log('  字数分布：');
  for (const block of report.wordCount.blocks) {
    console.log(`    ${block.label.padEnd(7)} chars=${String(block.chars).padStart(4)} 不含空白=${String(block.charsNoSpace).padStart(4)} 字数=${String(block.totalWords).padStart(4)}`);
  }
  console.log(`    合计    chars=${report.wordCount.total.chars} 不含空白=${report.wordCount.total.charsNoSpace} 字数=${report.wordCount.total.totalWords}`);
}

main();
