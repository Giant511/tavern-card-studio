/**
 * 聊天面板纯逻辑（v0.1.7 / T15.5）。
 *
 * 四组：
 *   ① swipe —— `mes` 与 `swipes[swipe_id]` 必须同步（最容易错的一处）
 *   ② 手势 —— 契约 §8.2 的两条轨迹对拍，且**判定看起手位置**
 *   ③ 生成请求 —— 六后端源、采样参数随请求体、不支持要报错不回退
 *   ④ 流式 —— 打字机必须是**渐进**的（这是陷阱 #10 的直接验证）
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appendSwipe,
  applyStreamEvent,
  buildContinueInput,
  buildGenerateRequest,
  CHAT_SOURCES,
  classifyGesture,
  canSwipeLeft,
  canSwipeRight,
  createStreamState,
  currentSwipeIndex,
  dismissError,
  EDGE_WIDTH,
  explainGenerateError,
  finalizeOutput,
  isBusy,
  isSupportedChatSource,
  MIN_SWIPE_DISTANCE,
  popLastAssistant,
  requestStop,
  resolveTrace,
  showsCaret,
  startStreaming,
  swipeCount,
  swipeNext,
  swipePrev,
  swipeTo,
  isNearBottom,
  shouldFollowStream,
  shouldStick,
  unsupportedSourceMessage,
  updateCurrentSwipeText,
} from '@tcs/shared';

/* ═══════════════════════════════════════════════════════════
   ① swipe
   ═══════════════════════════════════════════════════════════ */

const msgWithSwipes = (extra = {}) => ({
  name: '角色',
  is_user: false,
  mes: '候选B',
  swipes: ['候选A', '候选B', '候选C'],
  swipe_id: 1,
  swipe_info: [{}, {}, {}],
  ...extra,
});

test('★ 切候选时 mes 与 swipe_id 必须同步', () => {
  const m = msgWithSwipes();
  const next = swipeNext(m);

  assert.equal(next.swipe_id, 2, 'swipe_id 要跟着变');
  assert.equal(next.mes, '候选C', 'mes 必须同步 —— 只改 swipe_id 的话界面还是旧文字');

  assert.equal(swipeCount(next), 3, '候选数不变');
});

test('右滑回上一个候选', () => {
  const m = msgWithSwipes();
  const prev = swipePrev(m);
  assert.equal(prev.swipe_id, 0);
  assert.equal(prev.mes, '候选A');
});

test('边界处不动（不越界、不抛错）', () => {
  const first = swipeTo(msgWithSwipes(), 0);
  assert.equal(swipePrev(first), first, '已是第一个，右滑应原样返回');
  assert.equal(canSwipeRight(first), false);

  const last = swipeTo(msgWithSwipes(), 2);
  assert.equal(swipeNext(last), last, '已是最后一个，左滑应原样返回');
  assert.equal(canSwipeLeft(last), false);
});

test('swipeTo 越界时夹到合法范围（手势连点不该崩）', () => {
  const m = msgWithSwipes();
  assert.equal(swipeTo(m, 99).swipe_id, 2);
  assert.equal(swipeTo(m, -5).swipe_id, 0);
});

test('没有 swipes 字段时按 1 个候选处理', () => {
  const plain = { name: '角色', is_user: false, mes: '只有一条' };
  assert.equal(swipeCount(plain), 1);
  assert.equal(canSwipeLeft(plain), false);
  assert.equal(canSwipeRight(plain), false);
  assert.equal(currentSwipeIndex(plain), 0);
});

test('★ 首次追加候选：原 mes 落成第 1 个候选（不丢最初那版）', () => {
  const original = { name: '角色', is_user: false, mes: '最初那版', send_date: '2026-10-30T00:00:00.000Z' };
  const after = appendSwipe(original, '新生成的一版');

  assert.deepEqual(after.swipes, ['最初那版', '新生成的一版'], '原 mes 必须是第 1 个候选');
  assert.equal(after.swipe_id, 1, '切到新的那版');
  assert.equal(after.mes, '新生成的一版');
  assert.equal(after.swipe_info?.length, 2, 'swipe_info 长度必须与 swipes 一致');
});

test('再次追加不重复落原 mes', () => {
  const once = appendSwipe({ name: '角色', is_user: false, mes: 'A' }, 'B');
  const twice = appendSwipe(once, 'C');
  assert.deepEqual(twice.swipes, ['A', 'B', 'C']);
  assert.equal(twice.swipe_id, 2);
  assert.equal(twice.mes, 'C');
});

test('★ 流式更新要写 swipes 对应位置（否则切回去看到旧版）', () => {
  const m = swipeTo(msgWithSwipes(), 2);
  const streaming = updateCurrentSwipeText(m, '候选C（写到一半）');
  assert.equal(streaming.mes, '候选C（写到一半）');
  assert.equal(streaming.swipes?.[2], '候选C（写到一半）', 'swipes 也要更新');
  assert.equal(streaming.swipes?.[0], '候选A', '别的候选不许被改');
});

test('popLastAssistant 取出最后一条 assistant 并给下标', () => {
  const history = [
    { name: '我', is_user: true, mes: '问' },
    { name: '角色', is_user: false, mes: '答1' },
    { name: '我', is_user: true, mes: '再问' },
    { name: '角色', is_user: false, mes: '答2' },
  ];
  const r = popLastAssistant(history);
  assert.equal(r.index, 3);
  assert.equal(r.target?.mes, '答2');
  assert.deepEqual(r.history.map((m) => m.mes), ['问', '答1', '再问']);
});

test('popLastAssistant 全是用户消息时返回 null', () => {
  const r = popLastAssistant([{ name: '我', is_user: true, mes: '问' }]);
  assert.equal(r.target, null);
  assert.equal(r.index, -1);
});

/* ═══════════════════════════════════════════════════════════
   ② 手势（契约 §8.2 两条轨迹）
   ═══════════════════════════════════════════════════════════ */

test('★ 轨迹一：左缘起手右滑 = 返回（最高优先级，即使压在气泡上）', () => {
  const result = classifyGesture({
    startX: 8, // 在 0–20 的左缘区
    startY: 400,
    currentX: 120,
    currentY: 402,
    startedInBubble: true, // 故意设成气泡上 —— 返回仍然优先
  });
  assert.deepEqual(result, { kind: 'back' }, '左缘起手右滑必须是返回，不能被切候选抢走');
});

test('★ 轨迹二：气泡内左滑 = 下一个候选', () => {
  const result = classifyGesture({
    startX: 200,
    startY: 300,
    currentX: 120,
    currentY: 302,
    startedInBubble: true,
  });
  assert.deepEqual(result, { kind: 'swipe', direction: 'next' });
});

test('气泡内右滑 = 上一个候选', () => {
  const result = classifyGesture({
    startX: 100,
    startY: 300,
    currentX: 180,
    currentY: 300,
    startedInBubble: true,
  });
  assert.deepEqual(result, { kind: 'swipe', direction: 'prev' });
});

test('★ 气泡外左滑不占用（留给页面滚动）', () => {
  const result = classifyGesture({
    startX: 200,
    startY: 300,
    currentX: 120,
    currentY: 300,
    startedInBubble: false,
  });
  assert.deepEqual(result, { kind: 'none' });
});

test('★ 判定看起手位置，不看当前位置（这是本模块存在的理由）', () => {
  // 从屏幕中间起手、滑到左缘 —— 不许判成"返回"
  const fromMiddle = classifyGesture({
    startX: 200,
    startY: 300,
    currentX: 10,
    currentY: 300,
    startedInBubble: false,
  });
  assert.notDeepEqual(fromMiddle, { kind: 'back' }, '起手不在左缘就不该是返回');
  assert.deepEqual(fromMiddle, { kind: 'none' });

  // 从左缘起手、滑到屏幕中间 —— 仍然是返回（虽然当前位置早就不在左缘）
  const fromEdge = classifyGesture({
    startX: 10,
    startY: 300,
    currentX: 300,
    currentY: 300,
    startedInBubble: false,
  });
  assert.deepEqual(fromEdge, { kind: 'back' }, '起手在左缘就该整段归返回');
});

test('位移不够当作点击（不误吞点击）', () => {
  const result = classifyGesture({
    startX: 100,
    startY: 300,
    currentX: 100 + MIN_SWIPE_DISTANCE - 1,
    currentY: 300,
    startedInBubble: true,
  });
  assert.deepEqual(result, { kind: 'none' });
});

test('偏垂直的滑动不占用（否则页面滚不动）', () => {
  const result = classifyGesture({
    startX: 200,
    startY: 300,
    currentX: 210,
    currentY: 400, // 竖直位移远大于水平
    startedInBubble: true,
  });
  assert.deepEqual(result, { kind: 'none' });
});

test('EDGE_WIDTH 就是契约写的 20', () => {
  assert.equal(EDGE_WIDTH, 20);
  // 边界值：x=20 算左缘，x=21 不算
  assert.deepEqual(
    classifyGesture({ startX: 20, startY: 100, currentX: 100, currentY: 100, startedInBubble: false }),
    { kind: 'back' },
  );
  assert.deepEqual(
    classifyGesture({ startX: 21, startY: 100, currentX: 100, currentY: 100, startedInBubble: false }),
    { kind: 'none' },
  );
});

test('★ 整条轨迹只结算一次（不能每帧都切，否则会"嗖"地跳到最后一个）', () => {
  // 一条从 200 到 50 的左滑轨迹
  const points = [];
  for (let x = 200; x >= 50; x -= 10) points.push({ x, y: 300 });

  const result = resolveTrace(points, true);
  assert.deepEqual(result, { kind: 'swipe', direction: 'next' }, '整条轨迹只给一个结论');
});

test('resolveTrace 用最远点（滑出去又滑回来仍算滑过）', () => {
  const points = [
    { x: 200, y: 300 },
    { x: 100, y: 300 }, // 最远
    { x: 190, y: 300 }, // 又滑回来了
  ];
  assert.deepEqual(resolveTrace(points, true), { kind: 'swipe', direction: 'next' });
});

test('resolveTrace 空轨迹/单点 = 无手势', () => {
  assert.deepEqual(resolveTrace([], true), { kind: 'none' });
  assert.deepEqual(resolveTrace([{ x: 200, y: 300 }], true), { kind: 'none' });
});

/* ═══════════════════════════════════════════════════════════
   ③ 生成请求
   ═══════════════════════════════════════════════════════════ */

test('★ 六后端源就是契约 #269 那六个', () => {
  assert.deepEqual([...CHAT_SOURCES].sort(), [
    'claude',
    'custom',
    'deepseek',
    'groq',
    'openai',
    'openrouter',
  ]);
});

test('★ 不支持的后端源要报错，不许静默回退到 openai', () => {
  for (const bad of ['makersuite', 'vertexai', 'cohere', '']) {
    const r = buildGenerateRequest({
      source: bad,
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r.ok, false, `${bad} 应当被拒绝`);
    if (r.ok) continue;
    assert.equal(r.reason, 'unsupported-source');
    // 文案要能指导下一步（这是项目纪律）
    assert.ok(r.message.includes('自定义') || r.message.includes('不支持'), r.message);
  }
});

test('isSupportedChatSource 是复用而非重写（同一份判据）', () => {
  assert.equal(isSupportedChatSource('openai'), true);
  assert.equal(isSupportedChatSource('makersuite'), false);
  assert.equal(isSupportedChatSource(null), false);
  const message = unsupportedSourceMessage('makersuite');
  assert.ok(message.includes('makersuite') && message.includes('可选'), message);
});

test('★ 采样参数必须进请求体（服务端不读设置，只认请求体）', () => {
  const r = buildGenerateRequest({
    source: 'openai',
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
    sampling: { temperature: 0.8, topP: 0.9, topK: 40, maxTokens: 512, presencePenalty: 0.1, stop: ['\n\n'] },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const req = r.request;

  assert.equal(req.temperature, 0.8);
  assert.equal(req.top_p, 0.9, '字段名必须是 ST 认的 top_p（不是 topP）');
  assert.equal(req.top_k, 40);
  assert.equal(req.max_tokens, 512, '必须是 max_tokens');
  assert.equal(req.presence_penalty, 0.1);
  assert.deepEqual(req.stop, ['\n\n']);
});

test('没给的采样参数不写进请求体（避免用 0 覆盖服务端缺省）', () => {
  const r = buildGenerateRequest({
    source: 'openai',
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal('temperature' in r.request, false);
  assert.equal('top_p' in r.request, false);
});

test('stream 默认 true（打字机效果的前提）', () => {
  const r = buildGenerateRequest({
    source: 'openai',
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.request.stream, true);
});

test('继续请求带 prefill', () => {
  const r = buildGenerateRequest({
    source: 'openai',
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
    prefill: '他抬起头',
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.request.prefill, '他抬起头');
});

test('模型名为空要报错并指导下一步', () => {
  const r = buildGenerateRequest({ source: 'openai', model: '  ', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'empty-model');
  assert.ok(r.message.includes('API 连接'), r.message);
});

test('空 messages 要报错', () => {
  const r = buildGenerateRequest({ source: 'openai', model: 'gpt-4o', messages: [] });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'empty-messages');
});

test('403 / 401 / 429 的文案要分开（HTML 响应体不许直接丢给用户）', () => {
  assert.ok(explainGenerateError(403, '<html>...').includes('重新连接'));
  assert.ok(explainGenerateError(401, '<html>...').includes('key'));
  assert.ok(explainGenerateError(429, '').includes('频繁'));
  // 兜底也不许把 HTML 原样吐出来
  const fallback = explainGenerateError(418, '<html><body>x</body></html>');
  assert.ok(fallback.includes('418'), fallback);
});

/* ═══════════════════════════════════════════════════════════
   ④ 流式（陷阱 #10 的直接验证）
   ═══════════════════════════════════════════════════════════ */

test('★ 打字机必须是渐进的（这是无 Content-Type 陷阱的直接验证）', () => {
  let state = startStreaming();
  const lengths = [];

  // 模拟流式：五段增量依次到达
  for (const piece of ['他', '抬起', '头', '，', '看向窗外']) {
    state = applyStreamEvent(state, { type: 'text', text: piece });
    lengths.push(state.text.length);
  }

  // 关键断言：每次到达都让文本变长（不是"最后一口气填满"）
  // 「他」1 +「抬起」2 +「头」1 +「，」1 +「看向窗外」4 = 9
  assert.deepEqual(lengths, [1, 3, 4, 5, 9], `长度必须逐个增长，实际 ${JSON.stringify(lengths)}`);
  assert.equal(state.chunkCount, 5, '增量次数要能数出来');
  assert.equal(state.text, '他抬起头，看向窗外');
});

test('done 之后回到 idle 并记下 finishReason', () => {
  let state = startStreaming();
  state = applyStreamEvent(state, { type: 'text', text: 'x' });
  state = applyStreamEvent(state, { type: 'done', finishReason: 'stop' });

  assert.equal(state.phase, 'idle');
  assert.equal(state.finishReason, 'stop');
  assert.equal(showsCaret(state), false, '结束后不该还有呼吸点');
});

test('★ 停止后到达的包必须被丢弃（否则"我停了它还在长"）', () => {
  let state = startStreaming();
  state = applyStreamEvent(state, { type: 'text', text: '前半' });
  state = requestStop(state);
  assert.equal(state.phase, 'stopping');

  const after = applyStreamEvent(state, { type: 'text', text: '后半' });
  // stopping 期间还允许收（正在断连），但一旦 done 就不许再追加
  const done = applyStreamEvent(after, { type: 'done' });
  const late = applyStreamEvent(done, { type: 'text', text: '迟到的包' });
  assert.equal(late.text.includes('迟到的包'), false, `迟到的增量必须被丢弃：${late.text}`);
});

test('连点停止只产生一次状态变化', () => {
  const streaming = startStreaming();
  const once = requestStop(streaming);
  const twice = requestStop(once);
  const thrice = requestStop(twice);
  assert.equal(twice, once, '重复点击应原样返回（同一引用）');
  assert.equal(thrice, once);
});

test('idle 时点停止是空操作', () => {
  const idle = createStreamState();
  assert.equal(requestStop(idle), idle);
});

test('error 进 failed 并带人话，可 dismiss', () => {
  let state = startStreaming();
  state = applyStreamEvent(state, { type: 'error', message: 'key 不对' });
  assert.equal(state.phase, 'failed');
  assert.equal(state.error, 'key 不对');

  const dismissed = dismissError(state);
  assert.equal(dismissed.phase, 'idle');
  assert.equal(dismissed.error, null);
});

test('isBusy 覆盖 streaming 与 stopping', () => {
  assert.equal(isBusy(createStreamState()), false);
  assert.equal(isBusy(startStreaming()), true);
  assert.equal(isBusy(requestStop(startStreaming())), true);
});

test('★ 空输出是一种真实失败（不许静默当成功）', () => {
  const empty = finalizeOutput(createStreamState());
  assert.equal(empty.ok, false);
  assert.ok(empty.message.includes('没有生成'), empty.message);

  let partial = startStreaming();
  partial = applyStreamEvent(partial, { type: 'text', text: '有内容' });
  const ok = finalizeOutput(partial);
  assert.equal(ok.ok, true);
  assert.equal(ok.text, '有内容');
});

/* ═══════════════════════════════════════════════════════════
   ⑤ 回归：buildContinueInput 的截断 bug
   ═══════════════════════════════════════════════════════════ */

test('★ 继续：最后一条是 assistant 时正常（原有场景）', () => {
  const r = buildContinueInput({
    card: {},
    history: [
      { name: '我', is_user: true, mes: '问' },
      { name: '角色', is_user: false, mes: '答' },
    ],
  });
  assert.equal(r.prefill, '答');
  assert.deepEqual(r.history.map((m) => m.mes), ['问'], 'assistant 要从历史里去掉');
});

test('★ 继续：最后一条是 user 时不许吞掉它（2026-10-30 修的 bug）', () => {
  /*
   * 原实现用 slice(0,-1) 截断，假定"定位到的 assistant 就是末位"。
   * 一旦末位是 user（[user, assistant, user]），它会删掉那条 **user**，
   * 而 assistant 仍留在历史里 ⇒ 既重复开头、又吞掉用户刚说的话。
   */
  const r = buildContinueInput({
    card: {},
    history: [
      { name: '我', is_user: true, mes: '第一句' },
      { name: '角色', is_user: false, mes: '回答A' },
      { name: '我', is_user: true, mes: '第二句' },
    ],
  });

  assert.equal(r.prefill, '回答A');
  assert.deepEqual(
    r.history.map((m) => m.mes),
    ['第一句', '第二句'],
    '被去掉的必须是那条 assistant，不是最后那条 user',
  );
});

test('继续：没有 assistant 时 prefill 为空、历史不动', () => {
  const r = buildContinueInput({
    card: {},
    history: [{ name: '我', is_user: true, mes: '只有我说的话' }],
  });
  assert.equal(r.prefill, '');
  assert.deepEqual(r.history.map((m) => m.mes), ['只有我说的话']);
});

/* ═══════════════════════════════════════════════════════════
   ⑥ 滚动跟随（两个方向都会错）
   ═══════════════════════════════════════════════════════════ */

test('★ 在底部时应当跟随', () => {
  // scrollHeight 1200 / clientHeight 600 / scrollTop 600 → 精确贴底
  assert.equal(isNearBottom({ scrollHeight: 1200, clientHeight: 600, scrollTop: 600 }), true);
});

test('★ 往回翻历史时不许跟随（否则永远读不到上面的内容）', () => {
  // 用户滚到中间
  assert.equal(isNearBottom({ scrollHeight: 1200, clientHeight: 600, scrollTop: 100 }), false);
});

test('容差 48px 内算在底部（手指很难精确停在 0）', () => {
  assert.equal(isNearBottom({ scrollHeight: 1200, clientHeight: 600, scrollTop: 600 - 48 }), true);
  assert.equal(isNearBottom({ scrollHeight: 1200, clientHeight: 600, scrollTop: 600 - 49 }), false);
});

test('内容比视口短时恒算在底部', () => {
  assert.equal(isNearBottom({ scrollHeight: 300, clientHeight: 600, scrollTop: 0 }), true);
});

test('★ 流式跟随要求"用户本来在底部"', () => {
  const atBottom = { scrollHeight: 1200, clientHeight: 600, scrollTop: 600 };
  const scrolledUp = { scrollHeight: 1200, clientHeight: 600, scrollTop: 100 };

  assert.equal(shouldFollowStream(atBottom, true), true);
  assert.equal(shouldFollowStream(scrolledUp, true), false, '用户在往回看时不许把视口拉回底部');
  assert.equal(shouldFollowStream(atBottom, false), false, '用户主动取消跟随后不许自动拉');
});

test('shouldStick 与 isNearBottom 同一判据（不许两套）', () => {
  const cases = [
    { scrollHeight: 1200, clientHeight: 600, scrollTop: 600 },
    { scrollHeight: 1200, clientHeight: 600, scrollTop: 0 },
    { scrollHeight: 100, clientHeight: 600, scrollTop: 0 },
  ];
  for (const metrics of cases) {
    assert.equal(shouldStick(metrics), isNearBottom(metrics), JSON.stringify(metrics));
  }
});
