/**
 * 验证脚本清点的双向校验（v0.1.3 / 6d）。
 *
 * 目的不是"检查脚本写得好不好"，而是**让漏登记变成红灯**。
 * 已经发生过两次"红着没人发现"：
 *   · verify:e2e 全部场景没带 ?sample=1，快照是空工作台，断言一直是 0 个；
 *   · verify-export-roundtrip 写死六板块清单，加板块后照样全 PASS。
 * 两次的共同点：脚本不在 npm test 链上，所以没人定期看它。
 *
 * 三个方向都查：
 *   ① 磁盘上有、登记表没有 → 红（新脚本必须表态：挂测试，还是写明豁免理由）
 *   ② 登记表有、磁盘上没有 → 红（删脚本要同步删登记，否则表逐渐失真）
 *   ③ 标了 offline 且写了 coveredBy 的，那个测试文件必须真的 import 它 → 红
 *      （防止"登记说挂了、其实没挂"这种自欺）
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  OFFLINE_WITH_ASSERTIONS,
  VERIFY_INVENTORY,
  VERIFY_STATUSES,
} from '../scripts/lib/verify-inventory.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 磁盘上所有"验证类"脚本：verify-*、smoke-*，含 .sh / .ps1 抓取器 */
function scanScripts() {
  const found = [];
  for (const name of readdirSync(join(ROOT, 'scripts'))) {
    if (!/^(verify|smoke|capture|compare|diagnose|probe)-/.test(name)) continue;
    if (!/\.(mjs|sh|ps1)$/.test(name)) continue;
    found.push(`scripts/${name}`);
  }
  return found.sort();
}

test('① 每个验证脚本都在登记表里（新增脚本必须表态）', () => {
  const registered = new Set(VERIFY_INVENTORY.map((entry) => entry.file));
  const unregistered = scanScripts().filter((file) => !registered.has(file));
  assert.deepEqual(
    unregistered,
    [],
    `以下脚本没有登记，无法判断它们该进测试还是该豁免：\n  ${unregistered.join('\n  ')}\n` +
      '请把它们加进 scripts/lib/verify-inventory.mjs，并写明 status / why / evidence。',
  );
});

test('② 登记表里没有已删除的脚本（表要与磁盘一致）', () => {
  const missing = VERIFY_INVENTORY.filter((entry) => !existsSync(join(ROOT, entry.file))).map(
    (entry) => entry.file,
  );
  assert.deepEqual(missing, [], `登记表引用了不存在的文件：\n  ${missing.join('\n  ')}`);
});

test('③ 每条登记都写清了 why 与 evidence（不许留空糊过去）', () => {
  const incomplete = VERIFY_INVENTORY.filter(
    (entry) =>
      typeof entry.why !== 'string' ||
      entry.why.trim().length < 8 ||
      typeof entry.evidence !== 'string' ||
      entry.evidence.trim().length < 4 ||
      typeof entry.run !== 'string' ||
      entry.run.trim() === '',
  ).map((entry) => entry.file);
  assert.deepEqual(incomplete, [], `以下登记缺 why/evidence/run：\n  ${incomplete.join('\n  ')}`);
});

test('④ 标 offline 的必须真的被某个测试导入（不能只在表里声称）', () => {
  assert.ok(OFFLINE_WITH_ASSERTIONS.length >= 3, '离线断言脚本至少 3 个');
  for (const entry of OFFLINE_WITH_ASSERTIONS) {
    assert.ok(entry.coveredBy, `${entry.file} 标了 offline 却没写 coveredBy`);
    const testFile = join(ROOT, entry.coveredBy);
    assert.ok(existsSync(testFile), `${entry.coveredBy} 不存在`);
    const source = readFileSync(testFile, 'utf8');
    const base = entry.file.split('/').pop();
    assert.ok(
      source.includes(base),
      `${entry.coveredBy} 没有 import ${base} —— 登记说挂了测试，实际没挂`,
    );
  }
});

test('⑤ 三个离线脚本都被同一个测试文件覆盖（避免一个脚本挂到不相干的测试里）', () => {
  const covered = new Set(OFFLINE_WITH_ASSERTIONS.map((entry) => entry.coveredBy));
  assert.deepEqual([...covered], ['test/offline-verifiers.test.mjs']);
});

test('清点表本身没有重复登记', () => {
  const files = VERIFY_INVENTORY.map((entry) => entry.file);
  assert.equal(new Set(files).size, files.length, '有文件被登记了两次');
});

test('清点表里 server 侧相关脚本都被标成需要真实服务端（不能谎报 offline）', () => {
  // 抽查：这些名字里带 server / smoke 的核心流程，必然是 live-server
  const mustBeLive = [
    'scripts/verify-sync-live.mjs',
    'scripts/smoke-t105.mjs',
    'scripts/smoke-t106.mjs',
    'scripts/smoke-t110-deploy.mjs',
  ];
  for (const file of mustBeLive) {
    const entry = VERIFY_INVENTORY.find((item) => item.file === file);
    assert.ok(entry, `${file} 未登记`);
    assert.equal(entry.status, 'live-server', `${file} 应标 live-server`);
  }
});

test('②b status 必须是那五个值之一（写错不许静默通过）', () => {
  /*
   * 这条是补上去的，因为我自己撞了：给一条登记写了 `needs-browser`，
   * 而表里只有 offline / browser-dump / live-browser / live-server / elevated。
   *
   * 为什么当时全绿：清点表的校验按**具体值**匹配（不是 `offline` 就不要求被导入，
   * 不在任何 capture 列表里就不检查抓取），一个不认识的值恰好谁都不匹配 ——
   * 于是它既不被检查、也不报错，等于这一格不存在。
   *
   * 而 status 决定了这条脚本"该进哪道门"：写错就意味着**它永远不会被跑**。
   */
  const invalid = VERIFY_INVENTORY.filter((entry) => !VERIFY_STATUSES.has(entry.status)).map(
    (entry) => `${entry.file} → ${String(entry.status)}`,
  );
  assert.deepEqual(
    invalid,
    [],
    `这些登记的 status 不在合法值里（${[...VERIFY_STATUSES].join(' / ')}）：\n  ${invalid.join('\n  ')}`,
  );
});
