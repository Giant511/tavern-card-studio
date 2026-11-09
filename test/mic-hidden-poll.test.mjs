/**
 * 退后台释放的**兜底**：不依赖 `visibilitychange` 的巡检。
 *
 * ## 为什么需要这一组（2026-11-02 真机取证）
 *
 * 新装 APK 冷启动后首次录音，按住 → HOME，2 秒后采样整机：
 *
 * ```text
 * RecordActivityMonitor → riid 1967; active? true        ← 麦克风还占着
 *
 * JS 侧：
 *   document.hidden === true                             ← 页面确实在后台
 *   心跳 __tcsHb 仍在更新                                 ← JS 没被冻结
 *   trace = [gum-called, gum-resolved]                   ← visibilitychange 没来
 * ```
 *
 * 三个条件同时成立 ⇒ **通知"该释放了"的事件漏发了，而 JS 活着**。
 *
 * 同一台设备上另外两个对照（都成功，`micReleased === 'visibility'`）：
 * - 录音中 HOME ×2 ⇒ 事件都到了
 * - 非录音态 HOME ×3 ⇒ 事件都到了
 *
 * 所以它不是"每次都漏"，而是**至少漏过一次**。对发布阻断级的问题，
 * "偶发失效"等于没修 —— 用户遇到的正是偶发。
 *
 * ## 这组判据守什么
 *
 * 守"即使事件一次都不来，麦克风也不会被一直占着"。
 * 判据必须**钉住巡检的存在与它的两个分支**，因为：
 * 只断言"有 releaseRecording 调用"的话，原来那个 60 秒一次性定时器
 * 也能通过 —— 而它意味着最长 60 秒别的应用录不了音。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const raw = readFileSync(join(ROOT, 'client/src/chat/voice-panel.ts'), 'utf8');

/** 剥掉注释再扫 —— 本项目已因"注释被当代码"踩过 4 次 */
const voice = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** 取 `armWatchdog` 整个方法体 */
function watchdogBody() {
  const start = voice.indexOf('private armWatchdog(');
  assert.ok(start >= 0, '找不到 armWatchdog');
  /* 到下一个同级方法声明为止 */
  const rest = voice.slice(start);
  const end = rest.indexOf('private isDocHidden(');
  assert.ok(end > 0, '找不到 isDocHidden（巡检依赖它做判定）');
  return rest.slice(0, end);
}

test('★★★ 巡检间隔常量存在，且明显小于 60 秒超时', () => {
  /*
   * 这条是"兜底真的更快"的量纲判据。
   *
   * 若巡检间隔等于超时（60 秒），那它和原来的一次性定时器没有区别 ——
   * 名字叫巡检、行为没缩短，属于**改了个名字就宣称修好了**。
   */
  const poll = /const MIC_FOREGROUND_POLL_MS = (\d[\d_]*)/.exec(voice);
  const watchdog = /const MIC_WATCHDOG_MS = (\d[\d_]*)/.exec(voice);
  assert.ok(poll !== null, '必须有 MIC_FOREGROUND_POLL_MS');
  assert.ok(watchdog !== null, '必须有 MIC_WATCHDOG_MS');

  const pollMs = Number(poll[1].replaceAll('_', ''));
  const watchdogMs = Number(watchdog[1].replaceAll('_', ''));
  assert.ok(pollMs > 0, '巡检间隔要大于 0');
  assert.ok(
    pollMs * 10 <= watchdogMs,
    `巡检间隔 ${String(pollMs)}ms 必须远小于超时 ${String(watchdogMs)}ms（否则等于没缩短）`,
  );
});

test('★★★ 巡检每 tick 都检查"页面是否隐藏"，命中就释放', () => {
  const body = watchdogBody();

  /*
   * 钉完整形态，不是"出现某个词"：
   * ① 调 `this.isDocHidden()`（判定走单一来源）
   * ② 命中后调 `releaseRecording('hidden-poll')`
   * ③ **return**（不继续挂下一次 tick —— 释放完还挂着就是白耗电，
   *    而且下一次 tick 会再调一次 releaseRecording）
   */
  assert.match(
    body,
    /if \(this\.isDocHidden\(\)\) \{[\s\S]{0,200}?releaseRecording\('hidden-poll'\)[\s\S]{0,80}?return;/,
    '隐藏时要用 isDocHidden() 判定并 releaseRecording("hidden-poll") 后 return',
  );
});

test('★★★ 巡检会自己续约（不是一次性定时器）', () => {
  /*
   * 一次性定时器 = 原来那个 60 秒看门狗。巡检必须是"检查 → 再挂一次"。
   * 没有这条，把 `setTimeout(tick, ...)` 改成只挂一次也能通过上面那条。
   */
  const body = watchdogBody();
  assert.match(
    body,
    /this\.watchdog = setter\(tick, MIC_FOREGROUND_POLL_MS\)/,
    '巡检结束时要再挂一次（续约），否则退化成一次性定时器',
  );
  /* 至少两处：初次挂 + 续约 */
  const occurrences = (body.match(/setter\(tick, MIC_FOREGROUND_POLL_MS\)/g) ?? []).length;
  assert.ok(occurrences >= 2, `续约点至少要有 2 处（初次 + 续约），实际 ${String(occurrences)} 处`);
});

test('★★ 超时分支仍在（巡检不能把超时兜底弄丢）', () => {
  const body = watchdogBody();
  assert.match(body, /MIC_WATCHDOG_MS/, '超时判定要保留');
  assert.match(
    body,
    /releaseRecording\('watchdog'\)/,
    '超时要走 reason="watchdog"（与 hidden-poll 区分开，排障时才知道是哪条路）',
  );
  assert.match(body, /录音超时/, '超时要给用户一句提示（他不是自己切走的）');
});

test('★★ 隐藏优先于超时判定（先判隐藏，后判超时）', () => {
  /*
   * 两者可能同时成立。真实原因若是"用户切走了"，弹"录音超时"会让
   * 回来的用户以为是应用出错。顺序反了就是归因错。
   */
  const body = watchdogBody();
  const hiddenAt = body.indexOf("releaseRecording('hidden-poll')");
  const timeoutAt = body.indexOf("releaseRecording('watchdog')");
  assert.ok(hiddenAt >= 0 && timeoutAt >= 0, '两个分支都要在');
  assert.ok(hiddenAt < timeoutAt, '隐藏判定必须在超时判定之前');
});

test('★★ 两条路径用同一个判定方法（不许各写一遍表达式）', () => {
  /*
   * `bindVisibilityRelease` 与 `armWatchdog` 都要判断"页面是否不可见"。
   * 两处各写一遍表达式 ⇒ 将来只有一处被改就分叉，出现
   * "事件路径认为可见、轮询认为不可见"的自相矛盾。
   *
   * 判据：`isDocHidden` 有定义，且两处调用点都出现。
   */
  assert.match(voice, /private isDocHidden\(\): boolean/, '要有 isDocHidden 方法');
  const calls = (voice.match(/this\.isDocHidden\(\)/g) ?? []).length;
  assert.ok(calls >= 2, `isDocHidden 至少被调用 2 次（事件路径 + 巡检），实际 ${String(calls)} 次`);

  /*
   * 反向断言：方法体内不许再出现裸的 `visibilityState === 'hidden'` 判定，
   * 那种写法意味着有人又复制了一遍表达式。
   * （`isDocHidden` 自己的方法体除外，所以要切掉它再查。）
   */
  const hiddenMethodStart = voice.indexOf('private isDocHidden(');
  const hiddenMethodEnd = voice.indexOf('private clearWatchdog(');
  const outside = voice.slice(0, hiddenMethodStart) + voice.slice(hiddenMethodEnd);
  assert.doesNotMatch(
    outside,
    /visibilityState\s*===\s*'hidden'/,
    'isDocHidden 之外不许再写裸的 visibilityState 判定（两处一份真相）',
  );
});
