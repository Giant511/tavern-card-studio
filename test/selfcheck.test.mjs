/**
 * `selfcheck` 自身的行为（v0.1.2 热修）。
 *
 * 这条命令是"打包漏依赖"的唯一装机前防线，所以它自己必须可信：
 *   · 四个依赖都要**真的跑**（不是 import 一下就算）；
 *   · 给了 `requireInside` 时，从包外解析到的依赖必须判失败；
 *   · 路径比较必须用 fileURLToPath（自剥 file:// 在 Windows 上比不对）。
 *
 * 「从包外解析」这条用**故意错配的根目录**来构造：把根设成一个必然不包含
 * 依赖的路径，四个依赖就都应该失败。这样不必真的移走文件，也能证伪。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { runSelfCheck } from '../server/dist/selfcheck.js';

const ROOT = join(import.meta.dirname, '..');

test('selfcheck：不加约束时四个依赖全部通过', async () => {
  const { ok, steps } = await runSelfCheck();
  assert.equal(steps.length, 4, `应检查 4 个依赖，实际 ${String(steps.length)}`);
  assert.deepEqual(
    steps.map((step) => step.name),
    ['@node-rs/argon2', '@peculiar/x509', 'better-sqlite3', 'isomorphic-git'],
  );
  for (const step of steps) {
    assert.equal(step.ok, true, `${step.name} 应通过：${step.error ?? ''}`);
    assert.ok(step.resolved, `${step.name} 应记录解析路径`);
  }
  assert.equal(ok, true);
});

test('selfcheck：约束根目录后，从包外解析的依赖一律判失败', async () => {
  // 用一个不可能包含这些依赖的目录当根：全部应从"包外"解析 → 全部失败
  const { ok, steps } = await runSelfCheck({ requireInside: join(ROOT, 'client/src') });
  assert.equal(ok, false, '根目录不含依赖时不该报通过');
  assert.equal(steps.length, 4);
  for (const step of steps) {
    assert.equal(step.ok, false, `${step.name} 应因"包外解析"而失败`);
    assert.match(step.error ?? '', /从包外解析到了/, `${step.name} 的报错应点名包外解析`);
  }
});

test('selfcheck：解析到的路径确实落在给定根目录内时才通过', async () => {
  // 依赖实际来自仓库根的 node_modules，用它当根就应该全过 ——
  // 这条同时证明"约束不是无条件失败"
  const { ok, steps } = await runSelfCheck({ requireInside: ROOT });
  assert.equal(ok, true, steps.map((step) => `${step.name}:${String(step.ok)} ${step.error ?? ''}`).join(' | '));
});

test('selfcheck：报错信息里带出实际路径（排查时不用再猜）', async () => {
  const { steps } = await runSelfCheck({ requireInside: join(ROOT, 'client/src') });
  const argon = steps.find((step) => step.name === '@node-rs/argon2');
  assert.ok(argon);
  assert.match(argon.error ?? '', /argon2/, '错误里应包含包名或实际路径');
});
