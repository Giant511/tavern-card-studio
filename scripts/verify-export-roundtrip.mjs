/**
 * 导出 round-trip 证明：导出 TXT/JSON → 重新导入 → 内容一致。
 * 断言失败即退出码 1，可作为验收脚本复跑。
 */
import { readFileSync } from 'node:fs';
import { applyCardText, loadPresets, parseStCard } from '../shared/dist/index.js';
import { buildTxtExport, buildJsonExport } from '../client/src/export/export-card.ts';

const preset = loadPresets([JSON.parse(readFileSync('rules/presets/default.json','utf8'))]).presets[0];
const card = parseStCard(JSON.parse(readFileSync('test/fixtures/sample-card.json','utf8'))).card;
let fail = 0;
const check = (ok, label) => { console.log((ok ? '  PASS ' : '  FAIL ') + label); if (!ok) fail++; };

const ids = ['basic', 'personality', 'settings', 'special', 'user'];
const textOf = (c, id) => (c.blocks.find(b => b.id === id)?.text ?? '').trim();

console.log('=== JSON round-trip ===');
const json = buildJsonExport(card, preset);
const fromJson = parseStCard(JSON.parse(json.text)).card;
console.log('  导出 ' + json.bytes + ' 字节 / ' + json.fileName);
for (const id of ids) check(textOf(fromJson, id) === textOf(card, id), id + ' 一致');
check(fromJson.worldbook.entries.length === card.worldbook.entries.length, '世界书条目数一致');

console.log('');
console.log('=== TXT round-trip ===');
const txt = buildTxtExport(card, preset);
const applied = applyCardText(card, txt.text, preset, { mode: 'lenient' });
console.log('  导出 ' + txt.bytes + ' 字节 / ' + txt.fileName + ' / 可导入= ' + applied.ok);
check(applied.ok, 'TXT 能被重新导入');
for (const id of ['basic', 'settings', 'special', 'user']) {
  check(textOf(applied.card, id) === textOf(card, id), id + ' 一致');
}

console.log('');
console.log(fail === 0 ? '全部通过（' + ids.length + ' 板块 + 世界书 + TXT 导入）' : '失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
