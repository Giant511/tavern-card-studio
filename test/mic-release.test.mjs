/**
 * 麦克风句柄释放（2026-11-01 发布阻断级）。
 *
 * ## 用户报的现象
 *
 * > App 退到后台后，QQ 等第三方应用语音功能无法录音；
 * > 重新给 QQ 授予权限无效；杀掉本 App 后台后，其他应用录音立即恢复正常。
 *
 * ## 取证结论（`.verify/mic-leak-evidence.md`）
 *
 * ```text
 * getUserMedia → track.readyState = "live"
 * 按 Home 切后台，等 5 秒
 * 再查 → readyState 仍是 "live"，live: 1
 * ```
 *
 * **WebView 不会因为切后台而释放麦克风**，而我们的代码当时没有任何
 * `visibilitychange` 监听 ⇒ 按住说话时切后台，`pointerup` 永远不到达，
 * `this.recording` 保持非空 ⇒ 麦克风被独占。
 *
 * 三条症状全部对上：他方录不到 / 重授权限无效（权限一直 granted）/ 杀进程即愈。
 *
 * ## 这组测试守什么
 *
 * 用户明确要求"审计录音器全生命周期，覆盖所有出口，每条路径都要有句柄释放的归属"。
 * 所以判据是**逐出口**的：哪一条漏了就必须红，而不是"整体看起来能释放"。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { MODE_SLIDE_PX, modeByHorizontalSlide } from '@tcs/shared';

const ROOT = join(import.meta.dirname, '..');
const voice = readFileSync(join(ROOT, 'client/src/chat/voice-panel.ts'), 'utf8');
const chatPanel = readFileSync(join(ROOT, 'client/src/chat/chat-panel.ts'), 'utf8');
const recorder = readFileSync(join(ROOT, 'client/src/chat/recorder.ts'), 'utf8');

/* ═══════════════════════════════════════════════════════════
   ① 所有出口都必须有释放归属
   ═══════════════════════════════════════════════════════════ */

test('★★★ 退后台必须释放（主泄漏点）', () => {
  /*
   * 这是用户报的那个 bug 的正解。
   * 光有 `releaseRecording()` 函数不够 —— 必须真的绑到 `visibilitychange`。
   *
   * 这是本项目第 N 次"函数写了没人调"，所以判据钉**绑定语句**本身。
   */
  assert.match(voice, /addEventListener\?\.\('visibilitychange'/, '要监听 visibilitychange');
  assert.match(
    voice,
    /addEventListener\?\.\('visibilitychange'[\s\S]{0,200}?releaseRecording/,
    'visibilitychange 里要真的释放',
  );
});

test('★★ 只在**不可见**时释放（回到前台不许误停录音）', () => {
  /*
   * `visibilitychange` 在"回到前台"时也会触发（hidden 变 false）。
   * 无条件释放会把用户正常录音打断 —— 那是把一个 bug 换成另一个。
   *
   * ## 为什么这条断言在 2026-11-02 改写
   *
   * 原文钉的是**字面形态**：
   * ```js
   * assert.match(voice, /const hidden =/);
   * assert.match(voice, /if \(hidden\) this\.releaseRecording/);
   * ```
   * 而我在加"隐藏巡检"兜底时，把判定抽成了 `isDocHidden()`（事件路径与
   * 轮询共用一份真相），写法变成：
   * ```js
   * if (this.isDocHidden()) this.releaseRecording('visibility');
   * ```
   * 意图完全相同（甚至更严：判定只有一处），但字面变了 ⇒ 判据假红。
   *
   * 这是**第 4 次**「判据钉字面」（前三次：`function boot()` 签名、
   * `transition: width`、`@media` 选择器重复，见 memory §70.15）。
   *
   * 改判据的正确方向不是放宽到"出现 releaseRecording 就算过"
   * （那样无条件释放也会绿），而是**钉住意图的两端**：
   *   ① 释放前必须有一次"是否隐藏"的判定
   *   ② 不许存在"事件一到就无条件释放"的形态
   */
  const eventStart = voice.indexOf("addEventListener?.('visibilitychange'");
  assert.ok(eventStart >= 0, '要监听 visibilitychange');
  /*
   * 取 onHide 的处理体：从监听注册往前找 `const onHide =`。
   * 用"注册点之前最近的处理函数定义"而不是固定行号 —— 行号会随注释漂移。
   */
  const onHideStart = voice.lastIndexOf('const onHide', eventStart);
  assert.ok(onHideStart >= 0, '找不到 onHide 处理函数');
  const onHideBody = voice.slice(onHideStart, eventStart);

  /* ① 释放之前要有隐藏判定 */
  assert.match(
    onHideBody,
    /isDocHidden\(\)/,
    '释放前必须判"是否不可见"（判定走 isDocHidden 单一来源）',
  );
  assert.match(
    onHideBody,
    /isDocHidden\(\)\)\s*this\.releaseRecording\(/,
    '只有不可见时才释放',
  );

  /* ② 反向断言：不许无条件释放 */
  assert.doesNotMatch(
    onHideBody,
    /onHide = \(\): void => \{\s*this\.releaseRecording/,
    '不许在 onHide 一进来就无条件 releaseRecording（那会让回到前台也停录音）',
  );
});

test('★★ `pagehide` 也要释放（页面被销毁时 visibilitychange 不一定来）', () => {
  assert.match(voice, /'pagehide'/, '要监听 pagehide');
});

test('★★★ 切 Tab（dispose）必须释放，而不只是丢引用', () => {
  /*
   * 原来 `ChatPanel.dispose()` 里只有 `this.voicePanel = null`。
   * 而 `switchTab()` 每次离开聊天页都会调它 ⇒ 录音中切 Tab 就泄漏。
   */
  assert.match(
    chatPanel,
    /this\.voicePanel\?\.dispose\(\);/,
    'dispose 里要真的调 voicePanel.dispose()',
  );
  assert.match(voice, /dispose\(\): void \{/, 'VoicePanel 要有 dispose');
  assert.match(
    voice,
    /dispose\(\): void \{[\s\S]{0,300}?releaseRecording/,
    'VoicePanel.dispose 里要释放',
  );
});

test('★★ `pointercancel`（来电/闹钟打断）必须释放', () => {
  /* 这正是用户要求矩阵里的"使用中来电/闹钟打断后同样释放" */
  assert.match(
    voice,
    /onPointerCancel[\s\S]{0,600}?this\.releaseRecording\('pointer-cancel'\)/,
    'pointercancel 要释放',
  );
});

test('★★ 切回键盘态要释放（无条件，不再加 stage 前置判断）', () => {
  /*
   * 原来是 `if (this.flow.stage === 'recording') this.recording?.discard()`。
   * 条件判断在释放路径上是纯风险：多判一个条件就多一种漏放的可能。
   */
  assert.match(voice, /this\.releaseRecording\('stage-keyboard'\)/, '切键盘要释放');

  /*
   * ★ 这条必须先**剥离注释**。
   *
   * 我在注释里写了"原来是 `if (this.flow.stage === 'recording') this.recording?.discard()`"
   * 来说明改了什么 —— 于是不剥注释时，那句被解释的历史代码会被当成现存代码，
   * 判据**假红**。
   *
   * 这是本项目第三次踩「注释被当成代码」（前两次：走查 6 的 `transition: height`、
   * 走查 10 的文案扫描）。**任何基于正则的静态扫描，第一步都该剥离注释。**
   */
  const voiceCode = voice.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(
    voiceCode,
    /if \(this\.flow\.stage === 'recording'\) this\.recording\?\.discard\(\)/,
    '释放路径上不许留 stage 前置判断（注释里的历史说明不算）',
  );
});

test('★★★ `releaseRecording` 必须真的 stop 掉流（不只是清引用）', () => {
  const fn = voice.slice(voice.indexOf('releaseRecording(reason: string)'));
  const body = fn.slice(0, fn.indexOf('\n  }') + 4);
  assert.match(body, /current\.discard\(\)/, '要调 discard（内部会 stop tracks）');
  assert.match(body, /this\.recording = null/, '要清引用');
  assert.match(body, /this\.clearWatchdog\(\)/, '要清看门狗');
});

/* ═══════════════════════════════════════════════════════════
   ② 看门狗：触摸序列卡死时的兜底
   ═══════════════════════════════════════════════════════════ */

test('★★ 录音要有看门狗（触摸序列可能永远不结束）', () => {
  assert.match(voice, /MIC_WATCHDOG_MS/, '要有上限常量');
  assert.match(voice, /this\.armWatchdog\(\)/, '录音开始后要起看门狗');
  /*
   * 只要求"`onPointerUp` 里有 `clearWatchdog`"，不钉先后顺序。
   *
   * 第一版钉的是「clearWatchdog 紧跟 stage 判断」，而实际代码把 clear 放在
   * stage 判断**之后**（先确认在录音态才清）—— 语义上完全正确，
   * 判据却假红。**顺序不是这条判据要守的东西，"有没有清"才是。**
   */
  const upFn = voice.slice(voice.indexOf('private async onPointerUp'));
  const upBody = upFn.slice(0, upFn.indexOf('private async onPointerCancel'));
  assert.match(upBody, /this\.clearWatchdog\(\)/, 'onPointerUp 里要清看门狗');
});

/* ═══════════════════════════════════════════════════════════
   ③ `start()` 中途抛错不许泄漏已拿到的 stream
   ═══════════════════════════════════════════════════════════ */

test('★★★ `start()` 里每一步失败都要 stop 已拿到的 stream', () => {
  /*
   * `getUserMedia` 成功之后，`new Ctx()` / `createMediaStreamSource` /
   * `new Recorder` 都可能抛。原来那些 catch 只是 `throw new Error(...)`，
   * **已经打开的麦克风没人关** —— 用户看到"打不开麦克风"，
   * 实际后果却是"其他应用都录不到音"。这类泄漏最难归因。
   */
  assert.match(recorder, /const releaseStream = \(\): void =>/, '要有统一的释放函数');
  assert.match(recorder, /for \(const track of stream\.getTracks\(\)\)/, '要遍历 track 停掉');

  /* 三个 catch 各要有一次 releaseStream —— 用出现次数钉住，少一处就红 */
  const calls = recorder.match(/releaseStream\(\);/g) ?? [];
  assert.ok(
    calls.length >= 3,
    `三个失败分支都要释放（context / audio graph / recorder），实际 ${String(calls.length)} 处`,
  );
});

/* ═══════════════════════════════════════════════════════════
   ④ 横向滑动切模式（用户 2026-11-01 建议）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 左滑=内心、右滑=消息、中间=说话', () => {
  /*
   * 用户的建议原话：
   * 「左滑是内心动作（即文本内容是放到（）中），右滑是消息（即文本内容是放到「」中），
   *   中间长按释放就是说话（即文本内容是放到""中）」
   */
  const start = { x: 200, y: 500 };
  assert.equal(modeByHorizontalSlide(start, { x: 200 - MODE_SLIDE_PX, y: 500 }), 'inner');
  assert.equal(modeByHorizontalSlide(start, { x: 200 + MODE_SLIDE_PX, y: 500 }), 'message');
  assert.equal(modeByHorizontalSlide(start, { x: 200, y: 500 }), 'speak');
});

test('★ 正好等于阈值就算切换（不是"差一像素才切"）', () => {
  /*
   * 用户滑到刚好 56px 停住时，他确实滑了整整一个阈值那么多。
   * 若判成"不切换"，他会以为手势没生效，然后反复加大幅度。
   */
  const start = { x: 200, y: 500 };
  assert.equal(modeByHorizontalSlide(start, { x: 200 - MODE_SLIDE_PX, y: 500 }, MODE_SLIDE_PX), 'inner');
  assert.equal(modeByHorizontalSlide(start, { x: 200 + MODE_SLIDE_PX, y: 500 }, MODE_SLIDE_PX), 'message');
});

test('★ 没滑够仍是说话（说话是最高频动作，不许滑偏就发不出去）', () => {
  const start = { x: 200, y: 500 };
  assert.equal(modeByHorizontalSlide(start, { x: 200 - MODE_SLIDE_PX + 1, y: 500 }), 'speak');
  assert.equal(modeByHorizontalSlide(start, { x: 200 + MODE_SLIDE_PX - 1, y: 500 }), 'speak');
});

test('★★ 纵向位移不影响模式（与下滑取消正交）', () => {
  /*
   * 取消判 `dy`、模式判 `dx`。如果模式判定也看 `dy`，
   * 用户"往下滑想取消"就会顺带把模式改成别的 —— 取消之后还要多发一步判断。
   */
  const start = { x: 200, y: 500 };
  assert.equal(modeByHorizontalSlide(start, { x: 200, y: 700 }), 'speak', '只往下滑不改模式');
  assert.equal(modeByHorizontalSlide(start, { x: 200 - 60, y: 700 }), 'inner', '斜着滑按横向算');
});

test('★★★ 松手时按坐标重算，不只信缓存的 pendingMode', () => {
  /*
   * 最后一次 `pointermove` 之后手指可能又滑回中间，或者根本没收到 move。
   * 只信缓存会出现"界面高亮着内心、结果发成了说话"。
   *
   * ## ★ 2026-11-02：判据从"调 modeByHorizontalSlide"改成"调 modeUnderPoint"
   *
   * 手势从**横向位移阈值**改成了**命中圆按钮矩形**（用户原话是
   * 「按住并滑到这个按钮上使用」）。所以要钉的是**意图**：
   *
   *   ① 松手时用松手坐标重算（不是只看 `pendingMode`）
   *   ② 重算函数与拖动时**同一个**（不同就会"高亮内心、发成消息"）
   *   ③ 缓存只能当兜底
   *
   * 而不是钉某个具体函数名 —— 那正是第 6 次"判据钉实现"。
   */
  assert.match(
    voice,
    /const hitMode = upPoint === null \? null : this\.modeUnderPoint\(upPoint\)/,
    '松手要按松手坐标重算',
  );

  const moveStart = voice.indexOf('handlePointerMove(clientX: number');
  assert.ok(moveStart >= 0, '找不到 handlePointerMove');
  const moveBody = voice.slice(moveStart, moveStart + 1400);
  assert.match(moveBody, /this\.modeUnderPoint\(point\)/, '拖动也要用同一个 modeUnderPoint');

  assert.match(
    voice,
    /const finalMode = hitMode \?\? this\.pendingMode/,
    '缓存只能当兜底（命中不到时），不能是首选',
  );
});

/* ═══════════════════════════════════════════════════════════
   ⑤ 可观测点：释放要能被断言
   ═══════════════════════════════════════════════════════════ */

test('★★ 释放要在 DOM 上留痕（否则验收脚本无法断言"真的释放了"）', () => {
  /*
   * `this.recording === null` 只能证明我们自己清干净了，
   * 不能证明设备真的松手了。所以在 body 上打一个属性给验收脚本用。
   */
  assert.match(chatPanel, /onReleaseMic:/, '要接上 onReleaseMic');
  assert.match(chatPanel, /dataset\['micReleased'\]/, '要写到 dataset 上');
});
