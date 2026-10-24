/**
 * 打包健康判据的自测（2026-10-24 客户端白屏事故的防线，本身也要有测试）。
 *
 * 这些断言之所以要写，是因为**判据自己也会错**。这次的第一个版本就写过两个假通过：
 *   · 用裸 `includes('/index.html')` 判断内嵌：故障 exe 里恰好有 3 处样板字符串
 *     （WebView2 未安装提示页 `registration</noscript>./index.html` 等）命中，
 *     于是 9 个文件「8 缺 1 有」，判据差点自己放行；
 *   · `MsiRecordGetStringW` 的缓冲区长度少传 1，把 4,029,952 读成 "402995"、
 *     `tcs-shell.exe` 读成 `tcs-shell.ex`，看上去像"文件名不对"。
 *
 * 所以这里用**构造样本**把判据钉死：该红的必须红，该绿的必须绿。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auditDist, auditMsiSize, auditShellAssets, findPriorMsi } from '../scripts/lib/bundle-health.mjs';

/** 造一个临时工作区，测试结束自动删。 */
function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tcs-bundle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(path, content) {
  writeFileSync(path, content);
}

test('auditDist：空目录判红', (t) => {
  const dir = workspace(t);
  const empty = join(dir, 'dist');
  mkdirSync(empty, { recursive: true });
  const result = auditDist(empty);
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /空的/);
});

test('auditDist：目录不存在判红', (t) => {
  const dir = workspace(t);
  const result = auditDist(join(dir, 'nope'));
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /不存在/);
});

test('auditDist：总量达标但引用了不存在的资源 → 判红', (t) => {
  const dir = workspace(t);
  const dist = join(dir, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  // index.html 指向一个并没有产出的 js：这是「html 是新的、assets 还是旧的」的典型形态
  write(join(dist, 'index.html'), `<script src="./assets/main-abc.js"></script>${'x'.repeat(2000)}`);
  const result = auditDist(dist, { minBytes: 1024 });
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /引用了不存在的 \.\/assets\/main-abc\.js/);

  // 把资源补上就该绿
  write(join(dist, 'assets', 'main-abc.js'), 'console.log(1)');
  assert.equal(auditDist(dist, { minBytes: 1024 }).ok, true);
});

test('auditDist：0 字节文件判红', (t) => {
  const dir = workspace(t);
  const dist = join(dir, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  write(join(dist, 'index.html'), 'x'.repeat(2000));
  write(join(dist, 'assets', 'main-abc.js'), '');
  const result = auditDist(dist, { minBytes: 1024 });
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /0 字节文件/);
});

test('auditShellAssets：资源键全在 → 绿；缺一个 → 红并指名', (t) => {
  const dir = workspace(t);
  const dist = join(dir, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  write(join(dist, 'index.html'), '<html></html>');
  write(join(dist, 'assets', 'main-abc.js'), 'console.log(1)');

  const good = join(dir, 'good.exe');
  write(good, Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('/assets/main-abc.js', 'utf8'), Buffer.from([0])]));
  const goodResult = auditShellAssets(good, dist);
  assert.equal(goodResult.ok, true);
  // index.html 不参与字节判据（样板字符串会假阳性），要如实报「跳过」
  assert.deepEqual(goodResult.skipped, ['index.html']);
  assert.equal(goodResult.checked, 1);

  const bad = join(dir, 'bad.exe');
  write(bad, Buffer.from('nothing embedded here', 'utf8'));
  const badResult = auditShellAssets(bad, dist);
  assert.equal(badResult.ok, false);
  assert.deepEqual(badResult.missing, ['assets/main-abc.js']);
});

test('auditShellAssets：exe 不存在 → 红而不是抛异常', (t) => {
  const dir = workspace(t);
  const dist = join(dir, 'dist');
  mkdirSync(dist, { recursive: true });
  write(join(dist, 'index.html'), '<html></html>');
  const result = auditShellAssets(join(dir, 'missing.exe'), dist);
  assert.equal(result.ok, false);
  assert.equal(result.checked, 0);
});

test('auditMsiSize：低于 70% 判红，边界 70% 判绿', (t) => {
  const dir = workspace(t);
  const prior = join(dir, 'prior.msi');
  write(prior, Buffer.alloc(1_000_000));

  const dropped = join(dir, 'dropped.msi');
  write(dropped, Buffer.alloc(699_999));
  const droppedResult = auditMsiSize(dropped, prior);
  assert.equal(droppedResult.ok, false);
  assert.ok(droppedResult.ratio < 0.7);

  const boundary = join(dir, 'boundary.msi');
  write(boundary, Buffer.alloc(700_000));
  assert.equal(auditMsiSize(boundary, prior).ok, true);
});

test('auditMsiSize：没有基线时跳过而不是判红', (t) => {
  const dir = workspace(t);
  const msi = join(dir, 'a.msi');
  write(msi, Buffer.alloc(1234));
  const result = auditMsiSize(msi, null);
  assert.equal(result.skipped, true);
  assert.equal(result.ok, true);
});

test('findPriorMsi：取小于当前版本的最大者，并忽略同版本', (t) => {
  const dir = workspace(t);
  for (const name of [
    'Tavern Card Studio_0.1.0_x64_en-US.msi',
    'Tavern Card Studio_0.1.1_x64_en-US.msi',
    'Tavern Card Studio_0.1.2_x64_en-US.msi',
  ]) {
    write(join(dir, name), Buffer.alloc(10));
  }
  const prior = findPriorMsi(dir, 'client', '0.1.2');
  assert.equal(prior.version, '0.1.1');

  // 版本号回退（比如重打 0.1.0）时不能返回 null —— 退而取「任意不同版本里最新的」，
  // 因为此时不存在「更早的版本」可比，拿最新的一版当基线才有意义。
  const older = findPriorMsi(dir, 'client', '0.1.0');
  assert.notEqual(older, null);
  assert.equal(older.version, '0.1.2');
});

test('findPriorMsi：release 目录里只有当前版本 → null（跳过判定）', (t) => {
  const dir = workspace(t);
  write(join(dir, 'TavernCardStudioServer-0.1.2.msi'), Buffer.alloc(10));
  assert.equal(findPriorMsi(dir, 'server', '0.1.2'), null);
});
