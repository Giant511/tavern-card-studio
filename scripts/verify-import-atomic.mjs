/**
 * 导入原子性验证（T6.3 验收项，可复跑）。
 *
 * 断言：任何坏规则文件都不得改变现有规则库 —— 失败分支必须原样返回。
 * 退出码：0 全部通过；1 存在缺陷。
 *
 * 运行：node scripts/verify-import-atomic.mjs
 */
import { readFileSync } from 'node:fs';
import { importPlatformRule, importHighlightScheme } from '../client/src/rules/rule-library.ts';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const platformFiles = ['sillytavern','character-card-v2','character-card-v3','janitorai','chub'].map(n => readJson('rules/platforms/'+n+'.json'));
const hlFiles = ['default','dark','minimal'].map(n => readJson('rules/highlight/'+n+'.json'));

const beforeP = JSON.stringify(platformFiles);

const badCases = [
  ['空字符串', ''],
  ['截断 JSON', '{ "id": "x", "name": '],
  ['非对象', '[1,2,3]'],
  ['缺 schemaVersion', JSON.stringify({ id: 'x', name: 'X', version: '1.0.0' })],
  ['id 非法', JSON.stringify({ ...platformFiles[0], id: 'Bad ID!' })],
];

let failures = 0;
function expect(condition, label) {
  if (!condition) {
    failures += 1;
    console.log('  FAIL ' + label);
  }
}

console.log('=== 平台规则：5 种坏输入 ===');
for (let i = 0; i < badCases.length; i++) {
  const label = badCases[i][0];
  const text = badCases[i][1];
  const r = importPlatformRule(platformFiles, text);
  const unchanged = JSON.stringify(r.value) === beforeP;
  const pad = label + ' '.repeat(Math.max(0, 16 - label.length));
  console.log(pad + 'ok=' + String(r.ok).padEnd(5) + ' 原列表未变=' + unchanged + '  错误数=' + r.issues.length);
  expect(r.ok === false, label + ' 应判定为失败');
  expect(unchanged, label + ' 原列表必须原样返回');
  expect(r.issues.length > 0, label + ' 必须给出错误说明');
}

console.log('');
console.log('=== 高亮方案：坏正则必须被拒 ===');
const base = hlFiles[0];
const badRegex = { ...base, id: 'bad-re', rules: [{ ...base.rules[0], match: { type: 'regex', pattern: '([unclosed' } }] };
const rh = importHighlightScheme(hlFiles[0], hlFiles, JSON.stringify(badRegex));
console.log('坏正则 ok=' + rh.ok + '  原方案未变=' + (rh.value === hlFiles[0]) + '  compiled=' + (rh.compiled === null ? 'null OK' : '有值(!)'));
const msg = rh.issues.map(i => (i.where ? i.where + ': ' : '') + i.message).join(' | ');
console.log('  错误: ' + msg.slice(0, 200));
expect(rh.ok === false, '坏正则应判定为失败');
expect(rh.value === hlFiles[0], '坏正则必须回退到原方案');
expect(rh.compiled === null, '坏正则不得产出编译结果');

console.log('');
if (failures === 0) {
  console.log('全部通过：坏文件不会污染现有规则库。');
  process.exit(0);
}
console.log('失败 ' + failures + ' 项。');
process.exit(1);
