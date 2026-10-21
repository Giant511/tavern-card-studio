/**
 * 静态校验工具的测试：决策表序号解析 + git config ini 写入。
 *
 * 这两个工具都直接动项目文件（README 决策表、.git/config），
 * 出错代价高且不易察觉，所以必须有单测——不依赖真实仓库状态。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkDecisionTable } from '../scripts/check-decision-table.mjs';
import { setHooksPathInIni } from '../scripts/enable-hooks.mjs';

function writeTemp(name, content) {
  const dir = mkdtempSync(join(tmpdir(), 'tcs-validate-'));
  const file = join(dir, name);
  writeFileSync(file, content, 'utf8');
  return file;
}

function makeTable(rows) {
  return [
    '# 测试',
    '',
    '| # | 决策 | 落地方式 |',
    '|---|---|---|',
    ...rows.map((n) => `| ${n} | 决策 ${n} | xx |`),
    '',
    '后续正文',
  ].join('\n');
}

// ── 决策表序号 ──────────────────────────────────────────────

test('决策表：连续序号通过', () => {
  const file = writeTemp('README.md', makeTable([1, 2, 3]));
  const result = checkDecisionTable(file);
  assert.equal(result.ok, true);
  assert.deepEqual(result.numbers, [1, 2, 3]);
});

test('决策表：缺号被捕获（模拟误删相邻行）', () => {
  const file = writeTemp('README.md', makeTable([1, 2, 4, 5]));
  const result = checkDecisionTable(file);
  assert.equal(result.ok, false);
  assert.match(result.problems.join(), /#2 之后跳到 #4（缺 1 条）/);
});

test('决策表：重复与倒序都被捕获', () => {
  const dup = checkDecisionTable(writeTemp('a.md', makeTable([1, 2, 2, 3])));
  assert.equal(dup.ok, false);
  assert.match(dup.problems.join(), /#2 重复出现/);

  const back = checkDecisionTable(writeTemp('b.md', makeTable([1, 3, 2])));
  assert.equal(back.ok, false);
  assert.match(back.problems.join(), /顺序倒了/);
});

test('决策表：首条不是 #1 被捕获', () => {
  const result = checkDecisionTable(writeTemp('README.md', makeTable([2, 3])));
  assert.equal(result.ok, false);
  assert.match(result.problems.join(), /首条不是 #1/);
});

test('决策表：CRLF 文件同样正确解析（本机 autocrlf=true）', () => {
  const crlf = makeTable([1, 2, 3]).replace(/\n/g, '\r\n');
  const result = checkDecisionTable(writeTemp('README.md', crlf));
  assert.equal(result.ok, true);
  assert.deepEqual(result.numbers, [1, 2, 3]);
});

test('决策表：文件不存在 / 无表头时明确失败', () => {
  const missing = checkDecisionTable(join(tmpdir(), 'definitely-not-here-12345.md'));
  assert.equal(missing.ok, false);
  assert.match(missing.problems.join(), /找不到文件/);

  const noTable = checkDecisionTable(writeTemp('x.md', '# 只有标题\n\n没有表格'));
  assert.equal(noTable.ok, false);
  assert.match(noTable.problems.join(), /没找到以「#」为首列的决策表/);
});

test('决策表：只统计第一张表，不会串到后面的表格', () => {
  const content = [
    '| # | 决策 |',
    '|---|---|',
    '| 1 | a |',
    '| 2 | b |',
    '',
    '| 序号 | 另一张表 |',
    '|---|---|',
    '| 99 | 不该被读进来 |',
  ].join('\n');
  const result = checkDecisionTable(writeTemp('README.md', content));
  assert.equal(result.ok, true);
  assert.deepEqual(result.numbers, [1, 2]);
});

// ── git config ini 写入 ─────────────────────────────────────

test('ini：已有 [core] 段且无 hooksPath → 插入段首', () => {
  const ini = '[core]\n\trepositoryformatversion = 0\n\tbare = false\n';
  const out = setHooksPathInIni(ini, 'scripts/hooks');
  assert.match(out, /\[core\]\n\thooksPath = scripts\/hooks\n\trepositoryformatversion/);
});

test('ini：已有 hooksPath → 原地替换，不产生第二份', () => {
  const ini = '[core]\n\thooksPath = old/path\n\tbare = false\n';
  const out = setHooksPathInIni(ini, 'scripts/hooks');
  assert.equal(out.match(/hooksPath/g).length, 1);
  assert.match(out, /hooksPath = scripts\/hooks/);
  assert.doesNotMatch(out, /old\/path/);
});

test('ini：没有 [core] 段 → 末尾追加', () => {
  const ini = '[remote "origin"]\n\turl = git@example.com:a/b.git\n';
  const out = setHooksPathInIni(ini, 'scripts/hooks');
  assert.match(out, /\[core\]\n\thooksPath = scripts\/hooks\n$/);
});

test('ini：插入不会破坏后续段落', () => {
  const ini = '[core]\n\tbare = false\n[remote "origin"]\n\turl = x\n';
  const out = setHooksPathInIni(ini, 'scripts/hooks');
  const coreIdx = out.indexOf('[core]');
  const remoteIdx = out.indexOf('[remote "origin"]');
  const hooksIdx = out.indexOf('hooksPath');
  assert.ok(coreIdx < hooksIdx && hooksIdx < remoteIdx, 'hooksPath 必须落在 [core] 段内');
});

test('ini：幂等——连写两次结果相同', () => {
  const once = setHooksPathInIni('[core]\n\tbare = false\n', 'scripts/hooks');
  const twice = setHooksPathInIni(once, 'scripts/hooks');
  assert.equal(once, twice);
});
