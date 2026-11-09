/**
 * 面板 dispose 必须解绑 window 监听（2026-11-02 真机抓到的麦克风泄漏）。
 *
 * ## 真机证据
 *
 * 松手 218ms 后页面已回 idle（`onPointerUp` 跑完了），设备侧却仍有
 * **两个** active 录音：
 *
 * ```text
 * riid 2615; active? true  ... pack:com.taverncardstudio.client
 * riid 2623; active? true  ... pack:com.taverncardstudio.client
 * ```
 *
 * 一个属于当前面板（已释放），另一个是**旧面板开的、没人释放**。
 *
 * ## 泄漏链条（三处都不报错，所以只能靠静态判据）
 *
 * 1. `render()` 每次都调 `bindWindowPointers()`（注释写"只绑一次"，
 *    但代码里**没有任何"已绑过就跳过"的判断**）
 * 2. `dispose()` 只 `releaseRecording()`，**没解绑**
 * 3. ⇒ 每切一次 Tab 多一套监听；旧面板已从 DOM 摘掉（所以任何 DOM 断言
 *    都看不到它），但它还在听 `pointerdown` 并自己 `transport.start()`
 *
 * ## 为什么这组判据必须存在
 *
 * 每个面板自己的"出口"都写对了（stop/discard 都在），所以按"出口审计"
 * 的思路永远发现不了。它错在**实例数量**上，而 DOM 上看不出实例数量。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const raw = readFileSync(join(ROOT, 'client/src/chat/voice-panel.ts'), 'utf8');
/** 剥注释：本项目因"注释被当代码"踩过 6 次 */
const voice = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('★★★ bindWindowPointers 必须幂等（重复调用不再新增监听）', () => {
  const start = voice.indexOf('private bindWindowPointers(');
  assert.ok(start >= 0, '找不到 bindWindowPointers');
  const end = voice.indexOf('private unbindWindowPointers(', start);
  assert.ok(end > start, '找不到 unbindWindowPointers（解绑是这条判据的另一半）');
  const body = voice.slice(start, end);

  /*
   * 钉"守卫在最前面"：`if (this.pointerBindTarget !== null) return;`
   * 没有它，每次 render 都会多一套监听 —— 而那才是路由到"多实例同时开麦"的起点。
   */
  assert.match(
    body,
    /if \(this\.pointerBindTarget !== null\) return;/,
    '必须"已绑过就跳过"，否则每次 render 都新增一套监听',
  );
});

test('★★★ 三个监听必须存引用（匿名函数无法 removeEventListener）', () => {
  const start = voice.indexOf('private bindWindowPointers(');
  const end = voice.indexOf('private unbindWindowPointers(', start);
  const body = voice.slice(start, end);

  /*
   * `removeEventListener` 要求同一个函数引用。把箭头函数直接传给
   * addEventListener 就等于放弃了"能解绑"的能力 —— 这正是原来的写法。
   */
  assert.match(body, /const onUp = /, 'pointerup 的处理函数要具名存引用');
  assert.match(body, /const onCancel = /, 'pointercancel 要具名存引用');
  assert.match(body, /const onMove = /, 'pointermove 要具名存引用');
  assert.match(body, /this\.onPointerUpBound = onUp;/, '引用要存到字段上');
  assert.match(body, /this\.onPointerCancelBound = onCancel;/);
  assert.match(body, /this\.onPointerMoveBound = onMove;/);
});

test('★★★ dispose 必须先解绑再释放录音', () => {
  const start = voice.indexOf('dispose(): void');
  assert.ok(start >= 0, '找不到 dispose');
  const end = voice.indexOf('render(): VoiceMounts', start);
  const body = voice.slice(start, end > start ? end : start + 800);

  const unbindAt = body.indexOf('this.unbindWindowPointers()');
  const releaseAt = body.indexOf("this.releaseRecording('dispose')");
  assert.ok(unbindAt >= 0, 'dispose 必须解绑 window 监听（否则旧面板仍在听事件并自己开麦）');
  assert.ok(releaseAt >= 0, 'dispose 仍要释放录音');
  assert.ok(
    unbindAt < releaseAt,
    '顺序：先解绑再释放（释放过程中有 await，事件进来会让已 dispose 的面板重新开麦）',
  );
});

test('★★ unbindWindowPointers 三种类型都要解，且清空引用', () => {
  const start = voice.indexOf('private unbindWindowPointers(');
  assert.ok(start >= 0, '找不到 unbindWindowPointers');
  /*
   * 用**下一个方法声明**当边界。这里不能写 `private onPointerDown`
   * —— 它的真实签名是 `private async onPointerDown(`，少了 `async` 就找不到。
   * 统一按"下一个 `(` 的方法签名"找：`setVoiceStage(`。
   */
  const end = voice.indexOf('setVoiceStage(', start);
  assert.ok(end > start, '找不到 unbindWindowPointers 的结束位置');
  const body = voice.slice(start, end);

  for (const type of ['pointerup', 'pointercancel', 'pointermove']) {
    assert.ok(
      body.includes(`'${type}'`),
      `解绑 ${type}（少一个就是"漏一类事件"，症状与完全不解绑一样隐蔽）`,
    );
  }
  /* 引用清空，避免重复解绑时误移除别人的监听 */
  assert.match(body, /this\.pointerBindTarget = null;/);
  assert.match(body, /this\.onPointerUpBound = null;/);
});

test('★★★ 第三道防线：已 dispose 的面板不许再开麦', () => {
  /*
   * 前面两道（幂等 + 解绑）都是"机制正确"层面的。
   * 这一条是"无论机制怎么错，也不许悄悄多占一路麦克风"——
   * 因为多占一路的后果用户只能感受到（别的应用录不了音），
   * 我们这边**没有任何报错**。
   */
  const start = voice.indexOf('private async onPointerDown(');
  assert.ok(start >= 0, '找不到 onPointerDown');
  const body = voice.slice(start, start + 900);
  assert.match(body, /if \(this\.disposed\) return;/, 'onPointerDown 开头必须判 disposed');
});
