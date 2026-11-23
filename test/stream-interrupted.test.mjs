/**
 * 生成被上游掐断时，不能显示成"完整回复"（v0.2.2 / 2026-11-22）。
 *
 * ## 用户报的现象
 *
 * > 这个中转站的错误捕捉不到了，显示不了
 *
 * 他拿到的是"看起来正常"的一条回复，但内容只有半句 —— 中转站限流、
 * 上游 502、读超时都可能让字节流在半句话上结束。我们的判定原来只有一条：
 *
 * ```ts
 *   if (text.trim().length > 0) return { ok: true, message: '' };
 * ```
 *
 * 只要涨过一个字就算成功，于是"被掐断"和"写完"在界面上完全一样。
 *
 * ## 判据怎么来的
 *
 * 结束方式有三种，必须分开：
 *
 * ```text
 *   帧里的 done    上游说了 finish_reason / [DONE] / message_stop ⇒ 写完了
 *   桥的 done     字节流结束（无论怎么结束），sawDone 说明见没见过 [DONE]
 *   用户停止       requestStop 之后到的那一整段都不算"上游问题"
 * ```
 *
 * 关键在于**两者要合起来判**：只发 `finish_reason` 不发 `[DONE]` 的中转站
 * 很多，单看 `sawDone === false` 会把完整回复误报成半截。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyStreamEvent,
  createStreamState,
  finalizeOutput,
  requestStop,
  startStreaming,
} from '@tcs/shared';

/** 走一段正常正文 */
function withText(state, text) {
  return applyStreamEvent(state, { type: 'text', text });
}

test('正常收尾：帧里有 finish_reason ⇒ 不提示', () => {
  let state = startStreaming();
  state = withText(state, '她转过身来。');
  state = applyStreamEvent(state, { type: 'done', finishReason: 'stop' });
  state = applyStreamEvent(state, { type: 'done', sawDone: true });

  assert.equal(state.sawEnd, true);
  const out = finalizeOutput(state);
  assert.equal(out.ok, true);
  assert.equal(out.message, '', '完整回复不该有任何提示');
});

test('只有 finish_reason、没有 [DONE]（很多中转站）⇒ 仍算完整', () => {
  let state = startStreaming();
  state = withText(state, '她把杯子推过来。');
  // 帧里先到 done，然后桥的 done 带 sawDone=false
  state = applyStreamEvent(state, { type: 'done', finishReason: 'stop' });
  state = applyStreamEvent(state, { type: 'done', sawDone: false });

  assert.equal(state.sawEnd, true, '帧里的 done 已经证明上游写完了');
  assert.equal(finalizeOutput(state).message, '');
});

test('连接被掐断：有正文也要说"可能不完整"', () => {
  let state = startStreaming();
  state = withText(state, '她转过身来，还没说完');
  // 一帧 done 都没有，桥最后说没见过 [DONE]
  state = applyStreamEvent(state, { type: 'done', sawDone: false });

  assert.equal(state.sawEnd, false);
  const out = finalizeOutput(state);
  assert.equal(out.ok, true, '已经收到的正文不能丢');
  assert.equal(out.text, '她转过身来，还没说完');
  assert.match(out.message, /回复可能不完整/);
  assert.match(out.message, /断开了连接/);
});

test('被掐断且一个字都没收到 ⇒ 判失败，不能留空气泡', () => {
  let state = startStreaming();
  state = applyStreamEvent(state, { type: 'done', sawDone: false });

  const out = finalizeOutput(state);
  assert.equal(out.ok, false);
  assert.match(out.message, /断开了连接/);
});

test('用户点停止：有正文不提示，空正文提示"已停止"', () => {
  let stopped = startStreaming();
  stopped = withText(stopped, '她转过身来。');
  stopped = requestStop(stopped);
  stopped = applyStreamEvent(stopped, { type: 'done', sawDone: false });

  assert.equal(stopped.stopRequested, true);
  assert.equal(finalizeOutput(stopped).ok, true);
  assert.equal(finalizeOutput(stopped).message, '', '自己停的不该被说成"上游出问题"');

  let empty = startStreaming();
  empty = requestStop(empty);
  empty = applyStreamEvent(empty, { type: 'done', sawDone: false });
  const out = finalizeOutput(empty);
  assert.equal(out.ok, false);
  assert.match(out.message, /已停止生成/);
});

test('老版本桥不带 sawDone ⇒ 退回旧行为，不报中断', () => {
  let state = startStreaming();
  state = withText(state, '她转过身来。');
  state = applyStreamEvent(state, { type: 'done' });

  assert.equal(state.sawEnd, true, '缺省等价于 true：不知道就别吓人');
  assert.equal(finalizeOutput(state).message, '');
});

test('上游明确报错时，错误优先于"可能不完整"', () => {
  let state = startStreaming();
  state = withText(state, '半句话');
  state = applyStreamEvent(state, { type: 'error', message: '上游返回 500' });
  state = applyStreamEvent(state, { type: 'done', sawDone: false });

  assert.equal(state.phase, 'failed', 'failed 之后 done 不许把状态改回 idle');
  assert.equal(state.error, '上游返回 500');
  const out = finalizeOutput(state);
  assert.equal(out.ok, true);
  assert.equal(out.message, '', '错误由 stream.error 单独显示，不要在这里重复');
});

test('createStreamState 的初值：没结束标记、没请求停止', () => {
  const state = createStreamState();
  assert.equal(state.sawEnd, false);
  assert.equal(state.ended, false);
  assert.equal(state.stopRequested, false);
});

test('还没结束就收尾（面板提前 dispose / 单测）⇒ 不许说"上游断开"', () => {
  /*
   * 这一条是补出来的：`finalizeOutput` 原来判的是"没见着结束标记"，
   * 而**没结束**的状态同样没见着 —— 于是"只有思维链"那三条判据全红，
   * 它们压根没发过 done 事件。
   *
   * 正确判据是「结束了，但没见着结束标记」（`ended && !sawEnd`）。
   */
  const half = withText(startStreaming(), '她转过身来。');
  assert.equal(half.ended, false);
  assert.equal(half.sawEnd, false);

  const out = finalizeOutput(half);
  assert.equal(out.ok, true);
  assert.equal(out.message, '', '不知道后来怎样了，就别下结论');

  /* 只有思维链、没有正文、也没结束 ⇒ 仍然指向"预算被思考吃了" */
  const thinkingOnly = applyStreamEvent(startStreaming(), { type: 'reasoning', text: '思考中' });
  const budget = finalizeOutput(thinkingOnly);
  assert.equal(budget.ok, false);
  assert.match(budget.message, /最大回复长度/, '这条文案原来是被"断连"分支顶掉的');
});

test('requestStop 只对 streaming 生效（连点十次也只算一次）', () => {
  const idle = createStreamState();
  assert.equal(requestStop(idle).stopRequested, false, 'idle 不该被置上停止标记');

  const streaming = startStreaming();
  const once = requestStop(streaming);
  const twice = requestStop(once);
  assert.equal(once.stopRequested, true);
  assert.equal(twice.phase, 'stopping');
  assert.equal(twice.stopRequested, true);
});
