/**
 * 导入原子性验证（T6.3 验收项）。
 *
 * 断言：任何坏规则文件都不得改变现有规则库 —— 失败分支必须原样返回。
 *
 * ── 为什么导出 `runImportAtomic` 而不是只做 CLI ──────────────────
 *
 * 抽成可导入的函数：CLI 调它、`test/` 也调它。这样同一份断言在两处执行，
 * **不存在两份实现漂移**的可能。
 *
 * （补一句环境事实，避免后人误判：本机 `spawnSync(...)` 返回 EBUSY，是被环境阻断；
 *  但**异步 `spawn` 是正常的** —— `verify-t110-matrix.mjs` 就用它起服务端并跑通 194 项。
 *  所以这里选 import 而不是 subprocess，理由是「更快、无端口、退出码不参与判定」，
 *  不是「完全不能 spawn」。）
 *
 * 参见 docs/41-testing-discipline.md §1 与 §9（脚本清点）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { importHighlightScheme, importPlatformRule } from '../client/src/rules/rule-library.ts';

const ROOT = join(import.meta.dirname, '..');

const PLATFORM_IDS = ['sillytavern', 'character-card-v2', 'character-card-v3', 'janitorai', 'chub'];
const HIGHLIGHT_IDS = ['default', 'dark', 'minimal'];

function readJson(relative) {
  return JSON.parse(readFileSync(join(ROOT, relative), 'utf8'));
}

/** @returns {{checks: {ok: boolean, label: string, detail: string}[], failures: number}} */
export function runImportAtomic() {
  const checks = [];
  const expect = (ok, label, detail = '') => checks.push({ ok, label, detail });

  const platformFiles = PLATFORM_IDS.map((id) => readJson(`rules/platforms/${id}.json`));
  const highlightFiles = HIGHLIGHT_IDS.map((id) => readJson(`rules/highlight/${id}.json`));
  const beforePlatforms = JSON.stringify(platformFiles);

  // 五种坏输入：每种的共同要求是「ok=false + 原列表引用未变 + 有错误说明」
  const badCases = [
    ['空字符串', ''],
    ['截断 JSON', '{ "id": "x", "name": '],
    ['非对象', '[1,2,3]'],
    ['缺 schemaVersion', JSON.stringify({ id: 'x', name: 'X', version: '1.0.0' })],
    ['id 非法', JSON.stringify({ ...platformFiles[0], id: 'Bad ID!' })],
  ];

  for (const [label, text] of badCases) {
    const result = importPlatformRule(platformFiles, text);
    const unchanged = JSON.stringify(result.value) === beforePlatforms;
    expect(result.ok === false, `平台规则·${label}：应判定为失败`);
    expect(unchanged, `平台规则·${label}：原列表必须原样返回`);
    expect(result.issues.length > 0, `平台规则·${label}：必须给出错误说明`);
  }

  // 高亮方案：坏正则必须被拒，且不得产出编译结果
  const base = highlightFiles[0];
  const badRegex = {
    ...base,
    id: 'bad-re',
    rules: [{ ...base.rules[0], match: { type: 'regex', pattern: '([unclosed' } }],
  };
  const scheme = importHighlightScheme(highlightFiles[0], highlightFiles, JSON.stringify(badRegex));
  expect(scheme.ok === false, '高亮方案·坏正则：应判定为失败');
  expect(scheme.value === highlightFiles[0], '高亮方案·坏正则：必须回退到原方案');
  expect(scheme.compiled === null, '高亮方案·坏正则：不得产出编译结果');

  return { checks, failures: checks.filter((item) => !item.ok).length };
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const { checks, failures } = runImportAtomic();
  for (const item of checks) {
    if (item.ok) continue;
    console.log(`  FAIL ${item.label}${item.detail === '' ? '' : `  — ${item.detail}`}`);
  }
  console.log(
    failures === 0
      ? `全部通过（${String(checks.length)} 项）：坏文件不会污染现有规则库。`
      : `失败 ${String(failures)} 项（共 ${String(checks.length)} 项）。`,
  );
  process.exit(failures === 0 ? 0 : 1);
}
