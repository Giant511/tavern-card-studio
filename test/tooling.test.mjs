/**
 * 静态校验工具的测试：决策表序号解析 + git config ini 写入。
 *
 * 这两个工具都直接动项目文件（PLAN.md 决策表、.git/config），
 * 出错代价高且不易察觉，所以必须有单测——不依赖真实仓库状态。
 */

import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { checkDecisionTable } from '../scripts/check-decision-table.mjs';
import { setHooksPathInIni } from '../scripts/enable-hooks.mjs';
import { CARRIERS, checkVersionLiterals, describeVersionBasis, findBareVersions, REPO_ROOT } from '../scripts/check-version-literal.mjs';

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
  const file = writeTemp('table.md', makeTable([1, 2, 3]));
  const result = checkDecisionTable(file);
  assert.equal(result.ok, true);
  assert.deepEqual(result.numbers, [1, 2, 3]);
});

test('决策表：缺号被捕获（模拟误删相邻行）', () => {
  const file = writeTemp('table.md', makeTable([1, 2, 4, 5]));
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
  const result = checkDecisionTable(writeTemp('table.md', makeTable([2, 3])));
  assert.equal(result.ok, false);
  assert.match(result.problems.join(), /首条不是 #1/);
});

/*
 * 2026-10-27 真实事故：在 PLAN.md 决策表**前面**加了一张 `| # | 规程 | 落地方式 |`
 * 的表（§0.1 六条规程）。当时的实现取"第一张 `#` 开头的表"，于是抓到那张 6 行表、
 * 报「✔ 共 6 条（#1–#6）」并退出 0 —— **真正的 228 条决策表一行都没检查**。
 *
 * 守卫失效却不报错，比守卫报错严重得多：它把"没检查"伪装成"检查通过"。
 * 现在按"编号行最多的一张"选，且 detail 里带行号。
 */
test('决策表：前面还有别的 # 表时，必须选编号行最多的那张（防假绿）', () => {
  const content = [
    '# 测试',
    '',
    '## 规程',
    '',
    '| # | 规程 | 落地方式 |',
    '|---|---|---|',
    '| 1 | a | b |',
    '| 2 | c | d |',
    '| 3 | e | f |',
    '',
    '## 决策',
    '',
    '| # | 决策 | 落地方式 |',
    '|---|---|---|',
    ...[1, 2, 3, 4, 5].map((n) => `| ${n} | 决策 ${n} | xx |`),
    '',
  ].join('\n'); 

  const result = checkDecisionTable(writeTemp('table.md', content));
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.numbers,
    [1, 2, 3, 4, 5],
    '应当解析的是 5 行那张（决策表），而不是前面 3 行那张（规程表）',
  );
  assert.match(result.detail, /取编号行最多的一张/, 'detail 要说明是怎么选的');
});

test('决策表：误选到短表会被缺号断言揭穿（双保险）', () => {
  // 就算选择逻辑退化成"取第一张"，也不该在**长表有缺号**时给出绿灯。
  // 这条用"第一张表完整且短、第二张表更长且缺号"来钉：选错了就会误报通过。
  // 注意第二张必须**行数更多** —— 行数相同时 reduce 保留第一张（平局取先），
  // 那就变成"选了短表"而不是"选了长表"，测的就不是这件事了。
  const content = [
    '# 测试',
    '',
    '| # | 规程 | 落地方式 |',
    '|---|---|---|',
    '| 1 | a | b |',
    '| 2 | c | d |',
    '',
    '| # | 决策 | 落地方式 |',
    '|---|---|---|',
    '| 1 | x | y |',
    '| 3 | x | y |',
    '| 4 | x | y |',
    '| 5 | x | y |',
    '',
  ].join('\n');

  const result = checkDecisionTable(writeTemp('table.md', content));
  assert.equal(result.ok, false, '长表缺 #2，必须红');
  assert.match(result.problems.join(), /#1 之后跳到 #3/);
});

test('决策表：CRLF 文件同样正确解析（本机 autocrlf=true）', () => {
  const crlf = makeTable([1, 2, 3]).replace(/\n/g, '\r\n');
  const result = checkDecisionTable(writeTemp('table.md', crlf));
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
  const result = checkDecisionTable(writeTemp('table.md', content));
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

// ── 版本号载体一致性（scripts/check-version-literal.mjs）──────
//
// 这一组的意义不在"跑通"，而在**双向**：
//   ① 真仓库现在必须全绿（否则打包前就有人改了一处载体、漏了其它几处）；
//   ② 把任意一个载体改成旧值**必须红** —— 否则这个守护就是"永远绿的摆设"
//      （本项目在 v0.1.5 吃过一次：断言写死 0.1.2，连升三版没人改，一直绿）；
//   ③ 历史标注（since: / 带 v 前缀 / 「X 起」）与依赖声明的版本号必须**不**红，
//      否则下一个人会为了让守护变绿去伪造历史。

/** 把真实的载体文件复制到临时目录，得到一个可以随便篡改的"假仓库" */
function makeVersionFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tcs-version-'));
  for (const carrier of CARRIERS) {
    const target = join(dir, carrier.file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(REPO_ROOT, carrier.file), target);
  }
  return dir;
}

function writeAt(dir, rel, content) {
  const target = join(dir, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

test('版本号：真实仓库的所有载体都等于 package.json', () => {
  const result = checkVersionLiterals(REPO_ROOT);
  assert.deepEqual(result.problems, [], result.problems.join('\n'));
  assert.equal(result.carriers.length, CARRIERS.length);
  assert.ok(result.carriers.every((carrier) => carrier.ok));
});

test('版本号：真实仓库里没有残留的裸旧版本号', () => {
  const bare = findBareVersions(REPO_ROOT);
  assert.deepEqual(
    bare.hits.map((hit) => `${hit.file}:${hit.line} ${hit.text}`),
    [],
    '历史标注请写成 v0.1.x / since: / 「X 起」，不要留下会被当成"当前版本"的裸值',
  );
});

test('版本号：改任意一处载体都必须红（逐载体注入）', () => {
  const current = checkVersionLiterals(REPO_ROOT).current;
  for (const carrier of CARRIERS) {
    // 改根 package.json 等于改真源，不构成漂移（其载体是它自己）
    if (carrier.file === 'package.json') continue;

    const dir = makeVersionFixture();
    const path = join(dir, carrier.file);
    const raw = readFileSync(path, 'utf8');
    // 整份替换而不是替换第一处：Cargo.lock 里 `0.1.6` 可能先出现在某个依赖上，
    // 只替换首处会出现"夹具其实没改到产品那一条"的假绿（第一次写就撞上了）。
    const mutated = raw.split(current).join('9.9.9');
    assert.notEqual(mutated, raw, `${carrier.file} 里没找到 ${current}，夹具已失效`);
    writeFileSync(path, mutated, 'utf8');

    const result = checkVersionLiterals(dir);
    assert.equal(result.ok, false, `${carrier.file} 改成 9.9.9 之后仍然全绿 —— 这个载体没被守护到`);
    assert.ok(
      result.problems.some((problem) => problem.includes(carrier.file)),
      `失败信息里必须点名是哪个文件，实际是：\n${result.problems.join('\n')}`,
    );
  }
});

test('版本号：载体文件缺失也是红灯（不是默认通过）', () => {
  const dir = makeVersionFixture();
  rmSync(join(dir, 'server/src/context.ts'));
  const result = checkVersionLiterals(dir);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes('SERVER_VERSION')));
});

test('版本号：Cargo.toml 只认 [package] 段，依赖内联表的 version 不算产品版本', () => {
  const dir = makeVersionFixture();
  writeAt(
    dir,
    'client/src-tauri/Cargo.toml',
    '[package]\nname = "tcs-shell"\nversion = "0.1.6"\n\n[dependencies]\nfoo = { version = "9.9.9" }\n',
  );
  assert.equal(checkVersionLiterals(dir).ok, true);
});

// ── 升版依据（决策 #232：升不升只看需求文档）──────────────
//
// 脚本看不见需求文档，所以它**不做判断**、只把"当前版本 vs 最新 tag"摆出来。
// 这一组的价值是钉住四种措辞各自出现在哪种现场 —— 特别是 `ahead`：
// 那是"已升版但还没发布"，也是唯一需要人去核对需求文档的时刻；
// 措辞里必须出现"没有就是私自升版"，否则它会被当成一句普通提示划过去。

test('升版依据：当前版本等于最新 tag → 同版本重打，不需要升版', () => {
  const basis = describeVersionBasis('0.1.5', 'v0.1.5');
  assert.equal(basis.kind, 'same');
  assert.match(basis.text, /同版本重打/);
});

test('升版依据：当前版本更高 → 点名"已升版尚未发布"并要求核对需求文档', () => {
  const basis = describeVersionBasis('0.1.6', 'v0.1.5');
  assert.equal(basis.kind, 'ahead');
  assert.match(basis.text, /已升版/);
  assert.match(basis.text, /0\.1\.6需求文档/);
  assert.match(basis.text, /私自升版/, '这句是判据：没有需求文档就是私自升版');
});

test('升版依据：当前版本更低 → 提示查分支，别在这里打包', () => {
  const basis = describeVersionBasis('0.1.5', 'v0.1.6');
  assert.equal(basis.kind, 'behind');
  assert.match(basis.text, /分支|旧 rel/);
});

test('升版依据：读不到 tag 时如实说"无法判断"，不假装通过', () => {
  for (const tag of [null, undefined, '', 'nightly']) {
    const basis = describeVersionBasis('0.1.6', tag);
    assert.equal(basis.kind, 'unknown', `tag=${String(tag)} 应判为 unknown`);
    assert.match(basis.text, /核对需求文档/);
  }
});

test('升版依据：版本比较按数值不按字典序（0.1.10 高于 0.1.9）', () => {
  assert.equal(describeVersionBasis('0.1.10', 'v0.1.9').kind, 'ahead');
  assert.equal(describeVersionBasis('0.1.9', 'v0.1.10').kind, 'behind');
  assert.equal(describeVersionBasis('0.2.0', 'v0.1.99').kind, 'ahead');
});

test('版本号：裸旧版本号被抓，历史标注 / IP / 依赖声明放行', () => {
  const bad = makeVersionFixture();
  writeAt(bad, 'client/src/bad.ts', "const v = '0.1.5';\n");
  const hits = findBareVersions(bad).hits;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'client/src/bad.ts');

  const clean = makeVersionFixture();
  writeAt(
    clean,
    'client/src/ok.ts',
    [
      '// v0.1.5 起就有这个入口（历史标注，带 v 前缀）',
      "export const meta = { since: '0.1.5' };",
      "const url = 'http://127.0.0.1:8730';", // 前 7 个字符长得像版本号
      '// 0.1.5 起服务端按账户隔离卡片（行为分界点）',
    ].join('\n'),
  );
  writeAt(clean, 'client/src-tauri/Cargo.lock', '[[package]]\nname = "http-body-util"\nversion = "0.1.5"\n');
  writeAt(clean, 'package-lock.json', '{ "packages": { "node_modules/x": { "version": "0.1.5" } } }\n');
  assert.deepEqual(findBareVersions(clean).hits, []);
});
