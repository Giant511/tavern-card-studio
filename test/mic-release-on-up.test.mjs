/**
 * 松手立刻释放麦克风（2026-11-02 用户报）。
 *
 * ## 用户原话
 *
 * > 我想要的是**松开=开按钮立刻释放麦克风**，而不只是切换到后台才释放，
 * > 你这个逻辑不通啊。
 *
 * 他说得对。上一轮我修的是"退后台释放"，而**最高频的那条路（松手）**
 * 仍然要等：`recorder.stop()` 里 `track.stop()` 排在 `await stopped` 之后，
 * 而 `stopped` 依赖 `MediaRecorder.onstop` —— 那要等编码器 flush 完。
 *
 * 于是松手之后、转写完成之前的整段时间里，媒体流仍是 `live`，
 * 系统状态栏的麦克风指示还亮着，别的应用仍然录不到音。
 *
 * ## 这组判据守什么
 *
 * 守"释放动作发生在等数据**之前**"。这是一条**顺序**判据：
 * 只看"有没有 track.stop()"是不够的 —— 旧实现也有，只是排在后面。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const raw = readFileSync(join(ROOT, 'client/src/chat/recorder.ts'), 'utf8');
/** 剥注释：本项目因"注释被当代码"踩过 5 次 */
const recorder = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** 取 `stop:` 那个方法体（到 `discard:` 之前） */
function stopBody() {
  const start = recorder.indexOf('stop: async () =>');
  assert.ok(start >= 0, '找不到 stop 方法');
  const end = recorder.indexOf('discard: () =>', start);
  assert.ok(end > start, '找不到 discard（stop 的结束位置）');
  return recorder.slice(start, end);
}

test('★★★ 松手后：先 stop track，再等 onstop', () => {
  /*
   * 这是本轮最核心的一条。顺序反了就等于"松手后还要等编码器"——
   * 用户看到的是"松手了麦克风还亮着"，而代码里明明有 track.stop()。
   */
  const body = stopBody();
  const stopTrackAt = body.indexOf('for (const track of stream.getTracks()) track.stop()');
  /*
   * 找"等数据"那一步。现在写成了 `await Promise.race([stopped, 超时])`，
   * 所以不能再钉字面 `await stopped` —— 那会假红（本轮已因"钉字面"踩过 4 次）。
   * 钉的是**意图**：无论怎么包，`stopped` 这个 promise 必须被 await。
   */
  const awaitStoppedAt = body.indexOf('stopped');

  assert.ok(stopTrackAt >= 0, 'stop() 里必须有 track.stop()');
  assert.ok(awaitStoppedAt >= 0, 'stop() 里要等 onstop 收齐数据');
  assert.ok(
    stopTrackAt < awaitStoppedAt,
    '★ track.stop() 必须排在等 onstop 之前（否则松手后麦克风要等到编码器 flush 完才放）',
  );
  assert.match(body, /await Promise\.race\(\[stopped/, '等数据要 await 那个 race');
});

test('★★★ 等 onstop 必须有超时上限（不许永久挂住）', () => {
  /*
   * 先放麦克风、后等数据之后，`onstop` 就成了唯一可能挂住的地方：
   * 个别 WebView 实现上它可能不触发（编码器异常、页面正在卸载）。
   * 没有上限的 `await` 会让调用方停在"转写中"，界面卡死只能杀进程。
   */
  const body = stopBody();
  assert.match(body, /Promise\.race\(/, 'await 要做成 race（数据 vs 超时）');
  assert.match(body, /STOP_FLUSH_TIMEOUT_MS/, '超时要用具名常量，不许写魔法数字');
});

test('★★ 超时常量存在且量级合理（1–3 秒）', () => {
  /*
   * 太小会丢掉最后一个 dataavailable（录音变成半句）；
   * 太大又退回"松手后等很久"。真机实测 onstop 通常 100–300ms，
   * 1.5 秒是 5 倍余量。
   */
  const m = /const STOP_FLUSH_TIMEOUT_MS = (\d[\d_]*)/.exec(recorder);
  assert.ok(m !== null, '必须有 STOP_FLUSH_TIMEOUT_MS');
  const ms = Number(m[1].replaceAll('_', ''));
  assert.ok(ms >= 1000 && ms <= 3000, `超时应在 1000–3000ms，实际 ${String(ms)}`);
});

test('★★ discard 也先 stop track（取消路径同样不能占着麦克风）', () => {
  const start = recorder.indexOf('discard: () =>');
  assert.ok(start >= 0, '找不到 discard');
  const body = recorder.slice(start, recorder.indexOf('};', start) + 2);
  const stopTrackAt = body.indexOf('track.stop()');
  const closeAt = body.indexOf('context.close()');
  assert.ok(stopTrackAt >= 0, 'discard 必须 stop track');
  assert.ok(closeAt > stopTrackAt, 'discard 里 close 要在 stop 之后（顺序无关但要有）');
});

test('★★★ 松手路径不许依赖"退后台"那条兜底', () => {
  /*
   * 上一轮的修法是 `visibilitychange` → `releaseRecording()`。
   * 那是**兜底**，不是主路径：用户松手时页面根本没隐藏，
   * 那个事件永远不会来。若有人把释放只写在 visibility 分支里，
   * 这条会红。
   *
   * 判据：`stop()` 自己必须完成全部释放（stop track + close context），
   * 而不是留给外部某个回调。
   */
  const body = stopBody();
  assert.match(body, /track\.stop\(\)/, 'stop() 自己要 stop track');
  assert.match(body, /context\.close\(\)/, 'stop() 自己要 close AudioContext');
});
