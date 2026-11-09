/**
 * ST 引擎生命周期判据（v0.1.7 / T15.3）。
 *
 * 这四组判据抽成纯逻辑的理由：它们在 Android 原生代码里**没法在 CI 里跑**，
 * 而每一个写错都会产生"只有真机上偶发才看得到"的问题。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  candidatePorts,
  DEFAULT_ST_PORT,
  describePortConflict,
  describeProbe,
  describeUnpack,
  foregroundNoticeText,
  PROBE_INTERVAL_MS,
  PROBE_TIMEOUT_MS,
  shouldKeepProbing,
  shouldKillOrphan,
  shouldRestartService,
  ST_UNPACKED_BYTES,
  unpackProgress,
} from '@tcs/shared';

/* ═══════════════════════════════════════════════════════════
   一、端口探活
   ═══════════════════════════════════════════════════════════ */

test('探活参数：间隔 500ms、上限 30s（给低端机留余量）', () => {
  assert.equal(PROBE_INTERVAL_MS, 500);
  assert.equal(PROBE_TIMEOUT_MS, 30_000);
  // 30 秒内能探 60 次，足够覆盖 spike 实测的 8–14 秒启动
  assert.ok(PROBE_TIMEOUT_MS / PROBE_INTERVAL_MS >= 20);
});

test('★ 未超时应继续等', () => {
  assert.equal(shouldKeepProbing(0), true);
  assert.equal(shouldKeepProbing(10_000), true);
  assert.equal(shouldKeepProbing(PROBE_TIMEOUT_MS - 1), true);
});

test('★ 到了上限就停（不许无限等）', () => {
  assert.equal(shouldKeepProbing(PROBE_TIMEOUT_MS), false);
  assert.equal(shouldKeepProbing(PROBE_TIMEOUT_MS + 5000), false);
});

test('★ 被取消时立刻停（用户点了"停止"，不许还在等）', () => {
  assert.equal(shouldKeepProbing(0, true), false);
  assert.equal(shouldKeepProbing(1000, true), false);
});

test('★ 超时文案要能指导下一步（不是"启动超时"四个字）', () => {
  const text = describeProbe('timeout', PROBE_TIMEOUT_MS);
  assert.ok(text.includes('再等'), `没告诉用户可以等：${text}`);
  assert.ok(text.includes('日志') || text.includes('高级'), `没给出排查入口：${text}`);
});

test('就绪文案带实际耗时', () => {
  assert.ok(describeProbe('listening', 12_000).includes('12'));
});

/* ═══════════════════════════════════════════════════════════
   二、孤儿进程清理（双判据）
   ═══════════════════════════════════════════════════════════ */

test('★★ 服务在跑 = 正常实例，绝不杀（否则每次回前台都断一次会话）', () => {
  const verdict = shouldKillOrphan({ hasProcess: true, hasListener: true, serviceRunning: true });
  assert.equal(verdict.kill, false);
  assert.ok(verdict.reason.includes('正常'), verdict.reason);
});

test('★★ 双判据都命中才杀', () => {
  const verdict = shouldKillOrphan({ hasProcess: true, hasListener: true, serviceRunning: false });
  assert.equal(verdict.kill, true);
  assert.ok(verdict.reason.includes('孤儿'), verdict.reason);
});

test('★★ 只有进程没有端口：不杀（可能在启动中，或会自己退出）', () => {
  const verdict = shouldKillOrphan({ hasProcess: true, hasListener: false, serviceRunning: false });
  assert.equal(verdict.kill, false);
  assert.ok(verdict.reason.includes('启动中') || verdict.reason.includes('等下一轮'), verdict.reason);
});

test('★★★ 只有端口没有进程：坚决不杀（那可能是别人的程序）', () => {
  /*
   * 这是最危险的一种。
   *
   * 端口 8000 被占、但我们的进程不存在 —— 如果这时"以为是自己的残留"
   * 就去杀，会杀掉用户自己装的其它服务。而用户完全不知道发生了什么。
   *
   * 所以判据必须是"杀不了"，并把原因说清楚（换端口或关掉占用者）。
   */
  const verdict = shouldKillOrphan({ hasProcess: false, hasListener: true, serviceRunning: false });
  assert.equal(verdict.kill, false);
  assert.ok(verdict.reason.includes('其它程序'), verdict.reason);
  assert.ok(verdict.reason.includes('换端口') || verdict.reason.includes('关掉'), verdict.reason);
});

test('什么都没发现时不动', () => {
  const verdict = shouldKillOrphan({ hasProcess: false, hasListener: false, serviceRunning: false });
  assert.equal(verdict.kill, false);
});

test('★ 每种判定都要带原因（杀进程不可逆，事后必须能查）', () => {
  const cases = [
    { hasProcess: true, hasListener: true, serviceRunning: true },
    { hasProcess: true, hasListener: true, serviceRunning: false },
    { hasProcess: true, hasListener: false, serviceRunning: false },
    { hasProcess: false, hasListener: true, serviceRunning: false },
    { hasProcess: false, hasListener: false, serviceRunning: false },
  ];
  for (const probe of cases) {
    const verdict = shouldKillOrphan(probe);
    assert.ok(verdict.reason.length > 5, `缺原因：${JSON.stringify(probe)}`);
  }
});

/* ═══════════════════════════════════════════════════════════
   三、解包进度
   ═══════════════════════════════════════════════════════════ */

test('★ 进度单调、从 0 开始', () => {
  assert.equal(unpackProgress(0), 0);
  let last = -1;
  for (const written of [0, 1e6, 5e7, 1e8, 3e8, 4e8]) {
    const p = unpackProgress(written);
    assert.ok(p >= last, `进度回退了：${p} < ${last}`);
    last = p;
  }
});

test('★★ 到 100% 时显示 0.99（不许"显示满了但还在解"）', () => {
  /*
   * 分母是**预估**值。实际解出来可能比 437MB 大，此时 ratio > 1。
   * 如果直接返回 1，进度条显示 100% 但解包还在继续 —— 用户会以为卡死。
   */
  assert.equal(unpackProgress(ST_UNPACKED_BYTES), 0.99);
  assert.equal(unpackProgress(ST_UNPACKED_BYTES * 2), 0.99);
  assert.ok(unpackProgress(ST_UNPACKED_BYTES * 0.9) < 1);
});

test('★ 解包文案要说清"只需一次"（否则用户以为是每次都这么慢）', () => {
  const mid = describeUnpack(0.4);
  assert.ok(mid.includes('40%'), mid);
  assert.ok(mid.includes('一次'), `没说明只需一次：${mid}`);
});

test('解包文案：0 与接近完成时给不同的话', () => {
  assert.ok(describeUnpack(0).includes('准备'));
  assert.ok(describeUnpack(0.99).includes('启动'));
});

/* ═══════════════════════════════════════════════════════════
   四、前台服务重启策略
   ═══════════════════════════════════════════════════════════ */

test('★★ 用户主动停止 → 绝不重启（否则关不掉）', () => {
  const verdict = shouldRestartService('user');
  assert.equal(verdict.restart, false);
  assert.ok(verdict.reason.includes('关不掉'), verdict.reason);
});

test('★★ 用户划掉任务 → 不重启（视为不想继续跑）', () => {
  assert.equal(shouldRestartService('task-removed').restart, false);
});

test('★ 低内存被杀 → 要重启（那是系统腾内存，不是用户意图）', () => {
  const verdict = shouldRestartService('low-memory');
  assert.equal(verdict.restart, true);
  assert.ok(verdict.reason.includes('内存'), verdict.reason);
});

test('★ 崩溃 → 重启，但一小时内超 3 次就停（防循环崩溃耗电）', () => {
  assert.equal(shouldRestartService('crash', 0).restart, true);
  assert.equal(shouldRestartService('crash', 2).restart, true);

  const gaveUp = shouldRestartService('crash', 3);
  assert.equal(gaveUp.restart, false, '一小时崩 3 次应当停下');
  assert.ok(gaveUp.reason.includes('3'), gaveUp.reason);
});

test('★ 未知原因 → 不重启（宁要用户手动开，也不要不明原因反复拉起）', () => {
  assert.equal(shouldRestartService('unknown').restart, false);
});

test('★ 前台通知要交代内存占用（常驻通知最容易招不满，提前说清）', () => {
  const text = foregroundNoticeText(186);
  assert.ok(text.includes('186'), text);
  assert.ok(text.includes('MB'), text);
  // 需求要求用实测值，不是 152 这个旧的 Node 20 数字
  assert.ok(text.includes('186'), '应当用 Node 22 的实测 RSS');
});

test('通知文案对小数 RSS 取整（不显示 186.47 MB 这种）', () => {
  assert.ok(foregroundNoticeText(186.47).includes('186 MB'));
});

/* ═══════════════════════════════════════════════════════════
   五、端口
   ═══════════════════════════════════════════════════════════ */

test('默认端口 8000（与桌面端 ST 一致，契约 §2.1）', () => {
  assert.equal(DEFAULT_ST_PORT, 8000);
});

test('★ 端口候选按顺序给三个（默认优先）', () => {
  assert.deepEqual(candidatePorts(), [8000, 8001, 8002]);
});

test('★ 端口被占的文案要给出换端口入口', () => {
  const text = describePortConflict(8000);
  assert.ok(text.includes('8000'), text);
  assert.ok(text.includes('换') || text.includes('占用'), text);
});
