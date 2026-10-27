/**
 * 离线验证脚本的断言体（v0.1.3 / 6d）。
 *
 * 这里直接 import 脚本导出的 run 函数，跑同一份断言（而不是 subprocess 调 CLI）。
 * 理由是「更快、不占端口、退出码不参与判定」；
 * 顺带一个环境事实：本机 `spawnSync` 返回 EBUSY，但**异步 spawn 可用**
 * （`verify-t110-matrix.mjs` 用它起服务端跑通了 194 项）。
 *
 * 为什么这比"再写一份测试"好：
 * 两份实现一定会漂移 —— 而漂移的那一份通常是不常跑的脚本，
 * 于是"测试绿了但脚本红了"或反之，谁也不知道该信哪个。
 *
 * 覆盖范围（都登记在 scripts/lib/verify-inventory.mjs）：
 *   · verify-import-atomic   —— 坏规则不污染规则库
 *   · verify-export-roundtrip —— 导出再用回来的内容一致（含两个新板块）
 *   · verify-t1034-custom    —— 四条自定义路径（预设/规则/世界书格式）
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runAuditDualSample } from '../scripts/verify-audit-dual-sample.mjs';
import { runExportRoundtrip } from '../scripts/verify-export-roundtrip.mjs';
import { runImportAtomic } from '../scripts/verify-import-atomic.mjs';
import { runT1034Custom } from '../scripts/verify-t1034-custom.mjs';

/** 把脚本的 checks 结构转成断言失败信息（比 assert.equal(failures, 0) 好排查） */
function assertAllPassed(label, { checks, failures }) {
  const failed = checks.filter((item) => !item.ok);
  const detail = failed
    .map((item) => `  · ${item.label ?? item.name}${item.detail === '' || item.detail === undefined ? '' : `（${item.detail}）`}`)
    .join('\n');
  assert.equal(
    failures,
    0,
    `${label}：${String(failed.length)}/${String(checks.length)} 项失败\n${detail}`,
  );
  assert.ok(checks.length > 0, `${label}：一条断言都没跑，脚本可能提前 return 了`);
}

test('verify-import-atomic：坏规则文件不污染现有规则库', () => {
  const result = runImportAtomic();
  assertAllPassed('verify-import-atomic', result);
  // 18 项 = 5 种坏输入 × 3 条 + 坏正则 3 条。数量变化时提醒一下，防止被静默删断言。
  assert.equal(result.checks.length, 18, `断言数从 18 变成 ${String(result.checks.length)}，确认是有意改动`);
});

test('verify-export-roundtrip：JSON / TXT / 世界书三种格式都覆盖全部文本板块', () => {
  const result = runExportRoundtrip();
  assertAllPassed('verify-export-roundtrip', result);
  /*
   * 21 项 = JSON（7 板块 + 世界书条目数）+ TXT（7 板块 + 可导入）
   *       + 世界书（样本非空 + JSON 可导入 + JSON 逐条 + TXT 可导入 + TXT 逐条）
   *        = 8 + 8 + 5
   *
   * v0.1.3 收尾时从 16 加到 21：原来世界书只比"条目数一致"，
   * 条目数对得上而正文丢了照样全绿 —— 而世界书正文是最要紧的那部分。
   */
  assert.equal(result.checks.length, 21, `断言数从 21 变成 ${String(result.checks.length)}，确认是有意改动`);
});

test('verify-t1034-custom：四条自定义路径（预设 / 规则 / 世界书格式）', () => {
  const result = runT1034Custom();
  assertAllPassed('verify-t1034-custom', result);
  assert.equal(result.checks.length, 26, `断言数从 26 变成 ${String(result.checks.length)}，确认是有意改动`);
});

test('verify-audit-dual-sample：六板块旧卡可审计，八板块新卡正常校验', () => {
  const result = runAuditDualSample();
  assertAllPassed('verify-audit-dual-sample', result);
  /*
   * 26 → 28（v0.1.5 / G3-1）：新增"标准 ST 卡"样本的两条断言。
   *
   * 原来的样本 A 名为「六板块旧卡」，但它 first_mes / mes_example / alternate_greetings
   * 都**有内容** —— 那种形态在 JSON 上与标准 SillyTavern 卡完全一样（ST 把这两块
   * 放在顶层字段，从不写进 description）。用一个"字段有内容的卡"去断言
   * 「报旧格式卡片且说"不含这两块"」，等于把线上那条误报写成了期望值。
   * 现在拆成两张样本：真旧卡（字段全空，仍必须报 info）+ 标准 ST 卡（有内容，不许报）。
   */
  assert.equal(result.checks.length, 28, `断言数从 28 变成 ${String(result.checks.length)}，确认是有意改动`);
});
