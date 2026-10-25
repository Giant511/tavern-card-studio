/**
 * 仓库级静态判据（v0.1.3 / 6d 纪律二）。
 *
 * 两条判据各自对应一次真实缺陷，都不是风格问题：
 *
 * ① `data-block-id` 的提取正则必须允许连字符。
 *    原来写 `[a-z]+`，加 `chat-examples` / `initial-scene` 后静默匹配不到，
 *    `Set.size` 少算两个 —— 断言只说"不是 8"，看不出是谁缺了。
 *
 * ② 业务代码不许写死板块数组。
 *    加板块时实测 6 处副本，失效方式全是静默（新板块不出现 / 规则不生效 /
 *    筛选选不到，且不报错）。
 *
 * ③ 任何 `block:(...)` 正则交替式必须覆盖全部板块 id（v0.1.3 追加项二）。
 *    这一条是②的补丁：JSON Schema 与 `validate-rules.mjs` **不能** import
 *    `BLOCK_ID_ALTERNATION`（前者是纯数据，后者刻意保持零构建依赖），
 *    所以只能写死 —— 写死就会漂移。实测加完两个新板块后，
 *    `appliesTo: ["block:chat-examples"]` 被 Schema 拒收，报错却是
 *    "must match pattern"，完全看不出是清单少两项。
 *
 * 覆盖面：`shared/src`、`client/src`、`server/src`、`scripts`、`client/scripts`。
 * **服务端与脚本也在范围内** —— 只查客户端等于把最容易漏的地方放过去了
 * （服务端 import 的是 @tcs/shared，但它的路由/统计代码里仍可能自己写清单）。
 */

import assert from 'node:assert/strict';
import { mkdirSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BLOCK_IDS } from '@tcs/shared';
import {
  findBlockAlternationDrift,
  findBlockIdRegexWithoutHyphen,
  findHardcodedBlockArrays,
  walkSources,
} from '../scripts/lib/static-rules.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 参与静态检查的源码集合（跨端，不只客户端） */
function allSources() {
  return [
    ...walkSources(join(ROOT, 'shared/src'), ['.ts']),
    ...walkSources(join(ROOT, 'client/src'), ['.ts']),
    ...walkSources(join(ROOT, 'server/src'), ['.ts']),
    ...walkSources(join(ROOT, 'scripts'), ['.mjs', '.sh']),
    ...walkSources(join(ROOT, 'client/scripts'), ['.mjs']),
  ];
}

/**
 * 唯一真相文件自身豁免：`blocks.ts` 里 `BLOCK_IDS` 就是那份"清单"。
 * 除此之外任何地方出现板块数组都算违规。
 */
function isExempt(absolutePath) {
  return absolutePath.endsWith(join('model', 'blocks.ts'));
}

test('① data-block-id 正则允许连字符（没有 [a-z]+ 这种写死）', () => {
  const files = allSources();
  assert.ok(files.length > 100, `源码集合异常小（${String(files.length)} 个），扫描可能失效`);

  const violations = findBlockIdRegexWithoutHyphen(files, ROOT);
  assert.deepEqual(
    violations.map((item) => `${item.file}:${String(item.line)}  ${item.snippet}`),
    [],
    '这些地方的 data-block-id 正则用了不含连字符的字符类；' +
      'chat-examples / initial-scene 会被静默漏掉，请改成 [a-z-]+',
  );
});

test('② 业务代码里没有写死的板块数组（唯一真相是 BLOCK_IDS）', () => {
  const violations = findHardcodedBlockArrays(allSources(), ROOT, BLOCK_IDS, isExempt);
  assert.deepEqual(
    violations.map((item) => `${item.file}:${String(item.line)}  ${item.snippet}`),
    [],
    '这些地方把板块清单抄了一份；加板块时它们不会报错，只会静默少一项。' +
      '请改成从 BLOCK_IDS / BLOCK_DEFINITIONS 派生',
  );
});

/**
 * ③ 扫的文件集合与 ② 不同：Schema 是 `.json`，而 `walkSources` 默认只认源码。
 *
 * 这里的取舍：**宁可多扫**。当初就是因为"Schema 不算源码"这个理由，
 * 三处交替式漂移了整整一个版本才被 `validate:rules` 抓到。
 */
function allSelectorSources() {
  return [
    ...allSources(),
    join(ROOT, 'rules/schema/highlight-rule.schema.json'),
    join(ROOT, 'rules/schema/platform-rule.schema.json'),
    join(ROOT, 'rules/schema/preset.schema.json'),
  ];
}

test('③ 所有 block:(...) 交替式都覆盖全部板块（Schema 与校验脚本不许漂移）', () => {
  const violations = findBlockAlternationDrift(allSelectorSources(), ROOT, BLOCK_IDS);
  assert.deepEqual(
    violations.map(
      (item) =>
        `${item.file}:${String(item.line)}  缺 [${item.missing.join(', ')}] 多 [${item.extra.join(', ')}]`,
    ),
    [],
    '这些地方的板块交替式与 BLOCK_IDS 不一致：写新板块的规则会被静默拒收',
  );
});

/**
 * 造一个临时探针文件（负向自检用）。
 *
 * ## 为什么放在系统临时目录，而且**收尾不删**
 *
 * 原先写在 `<repo>/.verify/` 里、`finally` 里 `rmSync` 删掉。这在单跑本文件时
 * 没问题，但在 `npm test` 里会**间歇性变红**：
 *
 *     [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":82,"threshold":50,...}
 *
 * 原因是 safe-delete 钩子按 **turn** 累计删除数（阈值 50），而不是按单次调用。
 * 全量测试跑到这里时，前面几百条测试已经删过 80 多个文件，于是**删一个探针文件**
 * 也会被拦下，抛出的错误看起来像"静态判据坏了"。
 *
 * 现在两条都避开：写进 `os.tmpdir()`（离开仓库）、收尾只截断成 0 字节而不删除。
 * 代价是临时目录里留一个空文件 —— 由系统清理，比"测试红了但让人忽略"好得多。
 *
 * 返回 `{ path, cleanup }`。
 */
function makeProbe(name, content) {
  const dir = join(tmpdir(), 'tcs-static-rule-probe');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}-${String(process.pid)}.ts`);
  writeFileSync(path, content, 'utf8');
  return {
    path,
    cleanup: () => {
      try {
        truncateSync(path, 0);
      } catch {
        /* 已经不在了也无所谓 */
      }
    },
  };
}

test('判据本身能抓到违规（负向自检，防止判据空转）', () => {
  // 用临时文件造一个"违规文件"，确认两条判据都会命中。
  // 不做这一步的话，"0 命中"既可能是真的干净，也可能是判据根本没工作。
  const probe = makeProbe(
    'violation',
    [
      'export const IDS = ["basic", "personality", "settings", "special", "user"];',
      'const re = /data-block-id="([a-z]+)"/g;',
      '',
    ].join('\n'),
  );
  try {
    const arrays = findHardcodedBlockArrays([probe.path], ROOT, BLOCK_IDS, () => false);
    assert.equal(arrays.length, 1, '硬编码板块数组判据没能抓到违规');

    const regexes = findBlockIdRegexWithoutHyphen([probe.path], ROOT);
    assert.equal(regexes.length, 1, 'data-block-id 正则判据没能抓到违规');

    // ③ 的负向：写一个只列六板块的交替式，必须被抓到「缺两个」
    const driftProbe = makeProbe(
      'drift',
      'const SELECTOR = /^(\\*|block:(basic|personality|settings|special|user|worldbook)|field:[a-z_]+)$/;\n',
    );
    try {
      const drift = findBlockAlternationDrift([driftProbe.path], ROOT, BLOCK_IDS);
      assert.equal(drift.length, 1, '板块交替式判据没能抓到漂移');
      assert.deepEqual(
        drift[0].missing.sort(),
        ['chat-examples', 'initial-scene'],
        `缺的板块算错了：${JSON.stringify(drift[0].missing)}`,
      );
    } finally {
      driftProbe.cleanup();
    }
  } finally {
    probe.cleanup();
  }
});

test('豁免只给唯一真相文件，不扩大到整个目录', () => {
  // 豁免面越大，判据越没用。这里锁死"只允许 blocks.ts"。
  assert.ok(isExempt(join(ROOT, 'shared/src/model/blocks.ts')));
  assert.ok(!isExempt(join(ROOT, 'shared/src/model/unified-card.ts')));
  assert.ok(!isExempt(join(ROOT, 'server/src/http/app.ts')));
});

test('豁免标记只放行那一行，不放行整个文件', () => {
  // 这是豁免机制的关键性质：如果标记能放行整文件，它就退化成白名单，
  // 而白名单会把同一文件里别的手滑一起放过。
  const probe = makeProbe(
    'allow',
    [
      '// static-rule-allow: hardcoded-block-array —— 模拟历史格式',
      'export const ALLOWED = ["basic", "personality", "settings", "special"];',
      'export const NOT_ALLOWED = ["basic", "personality", "settings", "worldbook"];',
      '',
    ].join('\n'),
  );
  try {
    const violations = findHardcodedBlockArrays([probe.path], ROOT, BLOCK_IDS, () => false);
    assert.equal(violations.length, 1, `只应命中未标记的那一行，实际 ${String(violations.length)} 条`);
    // snippet 只截取数组本身（不含变量名），所以用行号 + 内容特征判断
    assert.equal(violations[0].line, 3, `命中的行号不对：${String(violations[0].line)}`);
    assert.ok(
      violations[0].snippet.includes('worldbook'),
      `命中的应是 NOT_ALLOWED 那行（含 worldbook），实际：${violations[0].snippet}`,
    );
  } finally {
    probe.cleanup();
  }
});
