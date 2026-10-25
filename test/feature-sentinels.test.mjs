/**
 * 功能哨兵与打包顺序的守卫（v0.1.3 / 生产反馈「MSI 缺 F5 界面」）。
 *
 * 三点：
 *   ① 哨兵表本身不许退化（文案太短 / 重复 / 没写"在哪看得见"）；
 *   ② 表里的文案在 `client/src` 里必须真的存在 —— 改了界面文案却没改表，
 *      哨兵会变成一个永远查不到的孤儿，构建红得莫名其妙；
 *   ③ **负向验证**：造一个缺哨兵的 dist，`checkSentinels` 必须红；
 *      再造一个"哨兵只存在于 .map 的 sourcesContent 里"的 dist，也必须红。
 *      第 ③ 条是这套检查的命门：真实故障就是"产物丢了文案但 sourcemap 还在"，
 *      如果扫描范围包含了 .map，它会稳定假绿。
 *
 * 另外守一件事：`build-client.mjs` 的步骤顺序是显式的（clean → vite build →
 * 哨兵 → tauri build → 出厂件 → 时间链），顺序被打乱就等于防线失效，
 * 所以这里直接对源码断言步骤编号单调递增、关键标记按序出现。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FEATURE_SENTINELS,
  checkSentinels,
  isScannable,
  validateRegistry,
} from '../scripts/lib/feature-sentinels.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 造一个临时 dist 目录，返回路径与清理函数 */
function makeDist(files) {
  const dir = mkdtempSync(join(tmpdir(), 'tcs-sentinel-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('① 哨兵表自身合格（文案长度、去重、必填 where、since 形态）', () => {
  assert.deepEqual(validateRegistry(), []);
  assert.ok(FEATURE_SENTINELS.length > 0, '哨兵表不能为空');
});

test('② 每条哨兵文案在 client/src 里确实存在（防止改文案后表变成孤儿）', () => {
  // 只读源码，不做类型检查：这里只关心"这串字还在不在"
  const sources = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|css|html)$/.test(entry.name)) continue;
      sources.push({ rel: full, text: readFileSync(full, 'utf8') });
    }
  };
  walk(join(ROOT, 'client/src'));
  walk(join(ROOT, 'shared/src'));
  assert.ok(sources.length > 50, `只扫到 ${sources.length} 个源文件，路径不对？`);

  for (const group of FEATURE_SENTINELS) {
    for (const item of group.expect) {
      const hit = sources.some((source) => source.text.includes(item.text));
      assert.ok(
        hit,
        `哨兵「${item.text}」（${group.feature}）在 client/src 与 shared/src 里都找不到 —— ` +
          '如果界面文案改了，请同步更新 scripts/lib/feature-sentinels.mjs',
      );
    }
  }
});

test('③ 负向验证：dist 里没有哨兵时必须红', () => {
  const { dir, cleanup } = makeDist({
    'index.html': '<!DOCTYPE html><html><body><div id="app"></div></body></html>',
    'assets/main-abc.js': 'const x="一些不相干的界面文字";export{x};',
  });
  try {
    const result = checkSentinels(dir);
    assert.equal(result.ok, false, '缺哨兵却判绿 —— 这道防线等于没有');
    assert.ok(result.problems.length > 0);
    for (const group of FEATURE_SENTINELS) {
      for (const item of group.expect) {
        assert.ok(
          result.problems.some((problem) => problem.includes(item.text)),
          `没有点名缺失的哨兵「${item.text}」`,
        );
      }
    }
  } finally {
    cleanup();
  }
});

test('④ 负向验证：哨兵只在 .map 的 sourcesContent 里 → 仍必须红', () => {
  // 真实故障形态：打包产物丢了文案，但 sourcemap 里存着源码原文
  const sourceMap = JSON.stringify({
    version: 3,
    sources: ['../../src/settings/settings-dialog.ts'],
    sourcesContent: FEATURE_SENTINELS.flatMap((group) => group.expect.map((item) => item.text)).join('\n'),
  });
  const { dir, cleanup } = makeDist({
    'index.html': '<!DOCTYPE html><html><body></body></html>',
    'assets/main-abc.js': 'export const nothing = 1;',
    'assets/main-abc.js.map': sourceMap,
  });
  try {
    const result = checkSentinels(dir);
    assert.equal(result.ok, false, '扫到了 sourcemap 里的源码原文 —— .map 必须被排除');
    assert.ok(result.scanned.skipped >= 1, '应当至少跳过 1 个 .map');
  } finally {
    cleanup();
  }
});

test('⑤ 正向验证：哨兵齐全时通过，并报出命中文件与处数', () => {
  const allTexts = FEATURE_SENTINELS.flatMap((group) => group.expect.map((item) => item.text));
  const { dir, cleanup } = makeDist({
    'index.html': '<!DOCTYPE html><html><body></body></html>',
    'assets/main-abc.js': `const a=${JSON.stringify(allTexts[0])};const b=${JSON.stringify(allTexts[1])};`,
    'assets/rules-xyz.js': allTexts.slice(2).map((text) => JSON.stringify(text)).join(','),
    'assets/main-abc.js.map': '{"version":3}',
  });
  try {
    const result = checkSentinels(dir);
    assert.equal(result.ok, true, `应当通过，实际问题：${result.problems.join('；')}`);
    assert.equal(result.results.length, allTexts.length);
    assert.ok(result.results.every((item) => item.hits > 0 && item.file !== null));
    assert.equal(result.scanned.skipped, 1, '.map 应被跳过');
  } finally {
    cleanup();
  }
});

test('⑥ 扫描范围：js/css/html 参与，.map 与其它扩展名不参与', () => {
  assert.equal(isScannable('assets/main.js'), true);
  assert.equal(isScannable('assets/rules.css'), true);
  assert.equal(isScannable('index.html'), true);
  assert.equal(isScannable('assets/main.js.map'), false);
  assert.equal(isScannable('data.json'), false);
});

test('⑦ 打包脚本的步骤顺序是显式的且单调递增', () => {
  const source = readFileSync(join(ROOT, 'scripts/build-client.mjs'), 'utf8');
  const indexes = [...source.matchAll(/step\((\d+),\s*'([^']*)'\)/g)].map((match) => Number(match[1]));
  assert.ok(indexes.length >= 10, `只找到 ${indexes.length} 个 step，流水线被削短了`);

  const expected = [...indexes].sort((a, b) => a - b);
  assert.deepEqual(indexes, expected, `步骤编号必须单调递增，实际：${indexes.join(' → ')}`);
  assert.deepEqual(
    indexes,
    indexes.map((_, position) => position),
    `步骤编号必须从 0 连续（不许跳号），实际：${indexes.join(' → ')}`,
  );

  // 关键标记必须按这个先后出现：clean 早于 vite build，哨兵早于 tauri build
  const markers = [
    ['clean（', 'clean'],
    ['vite build（前端产物）', 'vite build'],
    ['功能哨兵（', '功能哨兵'],
    ['tauri build（编译', 'tauri build'],
    ['出厂件校验（', '出厂件校验'],
    ['时间链断言（', '时间链断言'],
  ];
  let last = -1;
  for (const [marker, label] of markers) {
    const at = source.indexOf(marker);
    assert.ok(at > -1, `找不到标记「${label}」—— 这一步被删掉了？`);
    assert.ok(at > last, `「${label}」的位置不在上一步之后 —— 顺序被打乱，防线失效`);
    last = at;
  }
});
