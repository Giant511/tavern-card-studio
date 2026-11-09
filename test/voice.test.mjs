/**
 * 语音交互纯逻辑（v0.1.7 / T15.6 终版）。
 *
 * ## 这一组守的是什么
 *
 * 需求给的测试清单，逐条对应：
 *
 * 1. `wrapVoiceText` 三模式**字面值** / 防双包裹 / 空文本拒绝
 * 2. 滑动未命中回落「说话」
 * 3. 会话记忆与默认值
 * 4. 实时波形：假振幅序列断言高度变化，松手停帧
 * 5. `extra.tcs.voice` 标记随消息 round-trip
 * 6. 确认开 / 关两态（关=零中断直发；开=待确认、编辑值生效、取消=作废）
 *
 * ## 一个刻意的严格之处：字面值按**码位**断言
 *
 * 「说话」模式要中文弯引号 `U+201C` / `U+201D`。如果按字形断言（`assert.equal(text, '“你好”')`），
 * 那么源码里写成 ASCII 直引号 `"你好"` 的**错误实现也能通过** ——
 * 因为在某些字体下两者看起来几乎一样。所以这里显式比对码位。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_VOICE_MODE,
  VOICE_MODES,
  amplitudeToLevel,
  applyTranscript,
  barHeights,
  beginRecording,
  beginTranscribing,
  CANCEL_SLIDE_PX,
  cancelDraft,
  cancelRecording,
  commitDraft,
  coerceVoiceMode,
  createVoiceFlow,
  createWaveform,
  editDraft,
  freezeWaveform,
  hasVoiceActivity,
  highlightVoiceMode,
  hitTestVoiceChip,
  isAlreadyWrapped,
  isBlankVoiceText,
  isCancelSlide,
  isVoiceMsg,
  isVoiceMode,
  MIN_BAR_LEVEL,
  pushAmplitude,
  resolveVoiceMode,
  setVoiceFlag,
  setFlowMode,
  wrapVoiceText,
  wrapVoiceTextOrEmpty,
} from '@tcs/shared';

/* ═══════════════════════════════════════════════════════════
   1. wrapVoiceText —— 三模式字面值
   ═══════════════════════════════════════════════════════════ */

test('★ 三模式的包裹字面值（按码位，不按字形）', () => {
  const speak = wrapVoiceText('你好', 'speak');
  assert.equal(speak.ok, true);
  if (!speak.ok) return;
  // 逐字符断言码位：U+201C “ / U+201D ”
  assert.equal(speak.text.charCodeAt(0), 0x201c, '「说话」的开引号必须是 U+201C（中文弯引号）');
  assert.equal(speak.text.charCodeAt(speak.text.length - 1), 0x201d, '闭引号必须是 U+201D');
  assert.equal(speak.text.slice(1, -1), '你好', '包裹不能改动正文');

  const inner = wrapVoiceText('叹了口气', 'inner');
  assert.equal(inner.ok, true);
  if (!inner.ok) return;
  assert.equal(inner.text, '(叹了口气)');
  assert.equal(inner.text.charCodeAt(0), 0x28, '「内心/动作」用半角左括号');

  const message = wrapVoiceText('在忙', 'message');
  assert.equal(message.ok, true);
  if (!message.ok) return;
  assert.equal(message.text.charCodeAt(0), 0x300c, '「消息」的开符是 U+300C 「');
  assert.equal(message.text.charCodeAt(message.text.length - 1), 0x300d, '闭符是 U+300D 」');
  assert.equal(message.text.slice(1, -1), '在忙');
});

test('speak 模式不能误用 ASCII 直引号（U+0022 会让人以为是代码里的引号）', () => {
  const result = wrapVoiceText('测试', 'speak');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.notEqual(result.text.charCodeAt(0), 0x22, '开引号不许是 ASCII "');
  assert.notEqual(result.text.charCodeAt(result.text.length - 1), 0x22, '闭引号不许是 ASCII "');
});

test('默认模式是「说话」', () => {
  const withDefault = wrapVoiceText('默认');
  const explicit = wrapVoiceText('默认', 'speak');
  assert.deepEqual(withDefault, explicit);
  assert.equal(DEFAULT_VOICE_MODE, 'speak');
  assert.deepEqual([...VOICE_MODES], ['speak', 'inner', 'message'], 'chip 顺序：最常用在最左');
});

/* ── 防双包裹 ───────────────────────────────────────────── */

test('★ 已含同类包裹符时不再包一层（防 ASR 转出引号）', () => {
  // ASR 可能自己转出带引号的文本
  const quoted = wrapVoiceText('“你好”', 'speak');
  assert.equal(quoted.ok, true);
  if (!quoted.ok) return;
  assert.equal(quoted.text, '“你好”', '已经包过就不该变成 ““你好””');
  assert.equal(quoted.wrapped, false, 'wrapped=false 让 UI 能提示"已是引用格式"');

  const parens = wrapVoiceText('(笑)', 'inner');
  assert.equal(parens.ok, true);
  if (!parens.ok) return;
  assert.equal(parens.text, '(笑)', '不该变成 ((笑))');

  const bracket = wrapVoiceText('「在吗」', 'message');
  assert.equal(bracket.ok, true);
  if (!bracket.ok) return;
  assert.equal(bracket.text, '「在吗」');
});

test('全角括号也算「内心/动作」已包裹（中文语境常见）', () => {
  // 中文 ASR 完全可能吐出「（笑）」这种全角括号
  const full = wrapVoiceText('（笑）', 'inner');
  assert.equal(full.ok, true);
  if (!full.ok) return;
  assert.equal(full.text, '（笑）', '全角括号不该被再包一层半角');
  assert.equal(full.wrapped, false);
});

test('只有一半引号时仍然包裹（半残输入不该被当成已包裹）', () => {
  // 窄判据的已知代价：这里选择"再包一层"而不是"放弃包裹"，
  // 因为后者会让消息失去语音标记（比多重引号更糟）
  const half = wrapVoiceText('“只有开头', 'speak');
  assert.equal(half.ok, true);
  if (!half.ok) return;
  assert.equal(half.wrapped, true);
  assert.equal(half.text, '““只有开头”');
});

test('引号在中间不算已包裹（避免"包含即拒绝"的坑）', () => {
  // 如果用"包含"判定，`他说“你好”` 会原样发出 —— 一条没有语音标记的消息
  const middle = wrapVoiceText('他说“你好”', 'speak');
  assert.equal(middle.ok, true);
  if (!middle.ok) return;
  assert.equal(middle.wrapped, true, '引号只在中间，应当包裹');
  assert.equal(middle.text, '“他说“你好””');
});

test('跨模式不互认（说话模式的弯引号不阻止消息模式包裹）', () => {
  const cross = wrapVoiceText('“引用”', 'message');
  assert.equal(cross.ok, true);
  if (!cross.ok) return;
  assert.equal(cross.text, '「“引用”」', '「消息」模式该包直角引号');
  assert.equal(cross.wrapped, true);
});

/* ── 空文本拒绝 ─────────────────────────────────────────── */

test('★ 空文本与纯空白不发送', () => {
  for (const empty of ['', '   ', '\t\n', '\u3000', '\u00a0']) {
    const result = wrapVoiceText(empty, 'speak');
    assert.equal(result.ok, false, `「${JSON.stringify(empty)}」应当被拒绝`);
    if (result.ok) continue;
    assert.equal(result.reason, 'blank');
    // 便捷包装返回空串而不是抛错：一次"说话太轻没录到"不该崩掉聊天面板
    assert.equal(wrapVoiceTextOrEmpty(empty, 'speak'), '');
  }
});

test('前后空白不算（" 你好 " 要正常包裹）', () => {
  const result = wrapVoiceText(' 你好 ', 'speak');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.text, '“ 你好 ”', '不做 trim：句尾停顿是有意义的');
});

test('isBlankVoiceText 与 wrapVoiceText 口径一致', () => {
  assert.equal(isBlankVoiceText('   '), true);
  assert.equal(isBlankVoiceText('啊'), false);
  assert.equal(isAlreadyWrapped('“好”', 'speak'), true);
  assert.equal(isAlreadyWrapped('“好”', 'message'), false);
});

/* ═══════════════════════════════════════════════════════════
   2. 滑动选模式
   ═══════════════════════════════════════════════════════════ */

/** 三个 chip 横排（与 UI 布局一致：说话在最左） */
const CHIPS = [
  { mode: 'speak', x: 20, y: 100, width: 100, height: 44 },
  { mode: 'inner', x: 130, y: 100, width: 120, height: 44 },
  { mode: 'message', x: 260, y: 100, width: 100, height: 44 },
];

test('★ 滑到哪个 chip 就是哪个模式', () => {
  assert.equal(hitTestVoiceChip({ x: 70, y: 122 }, CHIPS), 'speak');
  assert.equal(hitTestVoiceChip({ x: 190, y: 122 }, CHIPS), 'inner');
  assert.equal(hitTestVoiceChip({ x: 310, y: 122 }, CHIPS), 'message');
});

test('★ 滑动未命中回落「说话」（滑偏了不能发成别的模式）', () => {
  // 完全在 chip 区域外（手指还在麦克风上）
  const belowMic = { x: 200, y: 600 };
  assert.equal(hitTestVoiceChip(belowMic, CHIPS), null, '没打中要返回 null');
  assert.equal(resolveVoiceMode(belowMic, CHIPS), 'speak', '没打中 → 说话');

  // 落在两个 chip 之间的缝隙
  const gap = { x: 125, y: 122 };
  assert.equal(resolveVoiceMode(gap, CHIPS, 'speak'), 'speak');
});

test('不滑动直接松手 = 说话（最常用路径零成本）', () => {
  // 手指没离开麦克风，point 为 null（没产生滑动）
  assert.equal(resolveVoiceMode(null, CHIPS), 'speak');
});

test('命中区比视觉大一圈（thumb 落点误差）', () => {
  // 视觉上 y 只到 144，y=150 已经出了边框 —— 但在 slop 内应当仍算命中
  const justOutside = { x: 70, y: 150 };
  assert.equal(hitTestVoiceChip(justOutside, CHIPS), 'speak');
  // 超出 slop（12px）就真的不认了
  const farOutside = { x: 70, y: 170 };
  assert.equal(hitTestVoiceChip(farOutside, CHIPS), null);
});

test('高亮：没命中时保持原样（手指刚起步不该跳回说话）', () => {
  assert.equal(highlightVoiceMode({ x: 200, y: 600 }, CHIPS, 'inner'), 'inner');
  assert.equal(highlightVoiceMode({ x: 190, y: 122 }, CHIPS, 'speak'), 'inner');
  assert.equal(highlightVoiceMode(null, CHIPS, 'message'), 'message');
});

test('模式值收敛：坏值回落默认，不抛错', () => {
  assert.equal(isVoiceMode('speak'), true);
  assert.equal(isVoiceMode('shout'), false);
  assert.equal(isVoiceMode(null), false);
  assert.equal(coerceVoiceMode('shout'), 'speak');
  assert.equal(coerceVoiceMode(undefined), 'speak');
  assert.equal(coerceVoiceMode('message'), 'message');
});

/* ═══════════════════════════════════════════════════════════
   3. 实时波形
   ═══════════════════════════════════════════════════════════ */

test('★ 振幅序列驱动柱高变化（不是静止的图）', () => {
  let wave = createWaveform(8);
  const silent = barHeights(wave);
  assert.equal(silent.length, 8);
  assert.ok(
    silent.every((h) => h === MIN_BAR_LEVEL),
    '刚创建时应当是等高的细线（不是 0，否则看起来像坏了）',
  );

  // 喂一串逐渐变大的振幅
  for (const amp of [500, 2000, 8000, 20000, 32000]) {
    wave = pushAmplitude(wave, amp);
  }
  const loud = barHeights(wave);
  assert.ok(
    Math.max(...loud) > Math.max(...silent) + 0.3,
    `大声时柱高应当明显变高，得到 ${JSON.stringify(loud)}`,
  );

  // 只在右端生长：最左边仍是最早的状态
  assert.equal(loud.length, 8, '柱数不变');

  /*
   * 静音回落。
   *
   * 注意这里要喂**足够多**的帧：实现了"峰值保持"（每帧最多降到上一帧的 40%），
   * 所以从 0.99 落到底部需要几帧，而 8 柱的窗口要整窗刷完才会全部到底。
   * 一帧就断言"全平"会红 —— 而那是我第一版测试写错的地方，
   * 不是实现错：逐帧陡然归零会让波形看起来在抖。
   */
  const frames = wave.bars.length * 3;
  for (let i = 0; i < frames; i += 1) wave = pushAmplitude(wave, 0);
  const quiet = barHeights(wave);
  assert.ok(
    Math.max(...quiet) <= MIN_BAR_LEVEL + 1e-9,
    `静音 ${frames} 帧后应当回到细线，实际 ${JSON.stringify(quiet)}`,
  );
});

test('★ 松手停帧：冻结后振幅不再改变任何柱子', () => {
  let wave = createWaveform(6);
  wave = pushAmplitude(wave, 20000);
  const frozen = freezeWaveform(wave);
  assert.equal(frozen.frozen, true);

  const snapshot = [...frozen.bars];
  // 冻结后再喂一串大振幅 —— 必须完全不动
  let after = frozen;
  for (const amp of [100, 30000, 32000, 5000]) {
    after = pushAmplitude(after, amp);
  }
  assert.deepEqual([...after.bars], snapshot, '冻结后柱高不许再变（松手即定格）');
  assert.equal(after, frozen, '冻结后 push 应当返回同一对象（渲染侧可据此跳过重绘）');

  // 幂等
  assert.equal(freezeWaveform(frozen), frozen);
});

test('振幅归一化是对数曲线（低声也要看得见）', () => {
  assert.equal(amplitudeToLevel(0), 0);
  assert.equal(amplitudeToLevel(-5), 0, '负值当 0（某些机型会返回 -1）');
  assert.equal(amplitudeToLevel(Number.NaN), 0, 'NaN 当 0，否则 canvas 上柱子全消失');
  assert.equal(amplitudeToLevel(32767), 1);

  /*
   * 10% 量程（3277）实测映射到 0.2788。
   *
   * 这里断言 "> 0.25" 而不是写死 0.2788：曲线参数将来可能微调，
   * 而"低声也要看得见"这个**性质**才是判据。写死精确值会让调参变成改测试。
   */
  const quiet = amplitudeToLevel(3277);
  assert.ok(quiet > 0.25, `低声（10% 量程）应当映射到 0.25 以上，实际 ${quiet.toFixed(4)}`);
  // 单调
  assert.ok(amplitudeToLevel(8000) > amplitudeToLevel(2000));
});

test('柱高被钳制在 [MIN_BAR_LEVEL, 1]', () => {
  const wave = createWaveform(4);
  for (const h of barHeights(wave)) {
    assert.ok(h >= MIN_BAR_LEVEL && h <= 1);
  }
  // 喂超量程
  let big = createWaveform(4);
  for (let i = 0; i < 10; i += 1) big = pushAmplitude(big, 999999);
  for (const h of barHeights(big)) assert.ok(h <= 1);
});

test('hasVoiceActivity 判断"到底有没有录到声音"', () => {
  const silence = createWaveform(8);
  assert.equal(hasVoiceActivity(silence), false);
  let loud = createWaveform(8);
  loud = pushAmplitude(loud, 30000);
  assert.equal(hasVoiceActivity(loud), true);
});

/* ═══════════════════════════════════════════════════════════
   4. extra.tcs.voice 标记
   ═══════════════════════════════════════════════════════════ */

test('★ setVoiceFlag 打标记，且不许抹掉别人的 extra 字段', () => {
  // 模拟一条 ST 消息：extra 里已经有 ST 扩展塞的东西
  const original = {
    name: '角色',
    is_user: true,
    mes: '“你好”',
    extra: { some_st_extension: { keep: 'me' }, tcs: { cardId: 'abc' } },
    swipes: ['候选'],
    swipe_id: 0,
  };

  const flagged = setVoiceFlag(original);
  assert.equal(isVoiceMsg(flagged), true);
  // 别人的字段必须原样还在（契约 §5.3 逐字段保留）
  assert.deepEqual(flagged.extra.some_st_extension, { keep: 'me' });
  assert.equal(flagged.extra.tcs.cardId, 'abc', 'tcs 命名空间里的其它键不许被覆盖');
  assert.equal(flagged.extra.tcs.voice, true);
  // 消息其它字段也不许动
  assert.equal(flagged.mes, original.mes);
  assert.deepEqual(flagged.swipes, ['候选']);
  assert.equal(flagged.swipe_id, 0);

  // 原对象不可变（纯函数）
  assert.equal(original.extra.tcs.voice, undefined, '不许就地修改入参');
});

test('setVoiceFlag(false) 删键而不是写 false（不给每条消息加冗余键）', () => {
  const flagged = setVoiceFlag({ mes: 'x' });
  const cleared = setVoiceFlag(flagged, false);
  assert.equal(isVoiceMsg(cleared), false);
  assert.equal(cleared.extra, undefined, 'extra 空了就该整块删掉，不留空对象');
});

test('isVoiceMsg 严格判 === true（字符串 "true" 不算）', () => {
  assert.equal(isVoiceMsg({}), false);
  assert.equal(isVoiceMsg({ extra: {} }), false);
  assert.equal(isVoiceMsg({ extra: { tcs: {} } }), false);
  // 手改配置可能写成字符串，按真值判会误显示徽标
  assert.equal(isVoiceMsg({ extra: { tcs: { voice: 'true' } } }), false);
  assert.equal(isVoiceMsg({ extra: { tcs: { voice: 1 } } }), false);
  assert.equal(isVoiceMsg({ extra: { tcs: { voice: true } } }), true);
});

test('★ 标记经 JSON round-trip 不丢（切设备 / 回桌面端徽标还在）', () => {
  // ST 把每条消息 JSON.stringify 成一行写进 .jsonl，读回来要还原
  const flagged = setVoiceFlag({ name: '角色', is_user: true, mes: '“在吗”', extra: { tcs: { cardId: 'x' } } });
  const line = JSON.stringify(flagged);
  const parsed = JSON.parse(line);

  assert.equal(isVoiceMsg(parsed), true, 'round-trip 后徽标必须还在');
  assert.equal(parsed.extra.tcs.cardId, 'x', '其它 tcs 字段也要在');
  assert.equal(parsed.mes, '“在吗”', '正文不受影响');
});

/* ═══════════════════════════════════════════════════════════
   5. 确认流两态
   ═══════════════════════════════════════════════════════════ */

test('★ 确认关闭（默认）→ 转写完成即直发，零中断', () => {
  let flow = createVoiceFlow('speak');
  flow = beginRecording(flow, 'speak');
  flow = beginTranscribing(flow);
  assert.equal(flow.stage, 'transcribing');

  const { flow: after, send } = applyTranscript(flow, '你好', false);
  assert.equal(send, '“你好”', '确认关闭时必须立刻给出要发的文本');
  assert.equal(after.stage, 'idle', '不留在待确认条上');
  assert.equal(after.draft, null, '直发后不留 draft（否则会有一份重复的待确认文本）');
});

test('★ 确认开启 → 出待确认条，发送前不进气泡', () => {
  let flow = createVoiceFlow('inner');
  flow = beginRecording(flow, 'inner');
  flow = beginTranscribing(flow);

  const { flow: after, send } = applyTranscript(flow, '叹了口气', true);
  assert.equal(send, null, '确认开启时不许直接发');
  assert.equal(after.stage, 'confirming', '要停在待确认条上');
  assert.equal(after.draft, '(叹了口气)', 'draft 是**已包裹**文本（编辑对象就是它）');
});

test('★ 确认开启 → 编辑后发送的是编辑值', () => {
  let flow = createVoiceFlow('speak');
  flow = beginRecording(flow, 'speak');
  flow = beginTranscribing(flow);
  flow = applyTranscript(flow, '你好门', true).flow;

  // 用户把 ASR 识别错的字改掉（注意改的是已包裹的文本）
  flow = editDraft(flow, '“你好呀”');
  const { flow: done, send } = commitDraft(flow);
  assert.equal(send, '“你好呀”', '发出去的必须是编辑后的值，不是原始转写');
  assert.equal(done.stage, 'idle');
  assert.equal(done.draft, null);
});

test('★ 取消 = 本次语音直接作废（不落消息、不留输入框）', () => {
  let flow = createVoiceFlow('message');
  flow = beginRecording(flow, 'message');
  flow = beginTranscribing(flow);
  flow = applyTranscript(flow, '在忙', true).flow;
  assert.equal(flow.stage, 'confirming');

  const cancelled = cancelDraft(flow);
  assert.equal(cancelled.stage, 'idle');
  assert.equal(cancelled.draft, null, '取消后不许留下任何待发送文本');
  // 没有 send 返回值这件事本身就是"作废"：调用方拿不到任何东西可发
});

test('删除到空串后点发送：不发空消息，回到 idle', () => {
  let flow = createVoiceFlow('speak');
  flow = beginRecording(flow, 'speak');
  flow = beginTranscribing(flow);
  flow = applyTranscript(flow, '有内容', true).flow;
  flow = editDraft(flow, '   ');

  const { send, flow: done } = commitDraft(flow);
  assert.equal(send, null, '空白不许发出去');
  assert.equal(done.stage, 'idle');
});

test('空转写不发送，也不留一条空的待确认条', () => {
  let flow = createVoiceFlow('speak');
  flow = beginRecording(flow, 'speak');
  flow = beginTranscribing(flow);

  const { flow: after, send } = applyTranscript(flow, '   ', true);
  assert.equal(send, null);
  assert.equal(after.stage, 'idle', '空白转写要回 idle，否则浮层一直挂着');
  assert.equal(after.draft, null);
});

test('录音中滑动改模式，松手后按新模式包裹', () => {
  let flow = createVoiceFlow('speak');
  flow = beginRecording(flow, 'speak');
  flow = setFlowMode(flow, 'message');
  assert.equal(flow.mode, 'message', 'chips 高亮要跟着走');

  flow = beginTranscribing(flow);
  const { send } = applyTranscript(flow, '在吗', false);
  assert.equal(send, '「在吗」', '按松手时的高亮模式包裹');
});

test('非法模式值被忽略（不打断录音）', () => {
  let flow = createVoiceFlow('speak');
  flow = beginRecording(flow, 'speak');
  const same = setFlowMode(flow, 'shout');
  assert.equal(same, flow, '坏值应当原样返回，不该改成默认值');
  assert.equal(same.mode, 'speak');
});

test('非 recording 阶段 beginTranscribing 是空操作（防止乱序事件）', () => {
  const flow = createVoiceFlow('speak');
  assert.equal(beginTranscribing(flow).stage, 'idle');
});

test('非 confirming 阶段 editDraft / commitDraft 是空操作', () => {
  const flow = createVoiceFlow('speak');
  assert.equal(editDraft(flow, 'x').draft, null);
  assert.equal(commitDraft(flow).send, null);
});


/* ═══════════════════════════════════════════════════════════
   7. 上滑取消（2026-10-31 落地；2026-11-02 方向改成上滑）
   ═══════════════════════════════════════════════════════════ */

test('★★ 上滑超过阈值才算取消（阈值内不算）', () => {
  /*
   * 阈值存在的唯一理由：按住时拇指会自然抖动。
   * 判据是"往上走了多少"，不是"有没有往上走" —— 后者会让每次说话
   * 都被判成取消。
   */
  const start = { x: 180, y: 600 };

  assert.equal(isCancelSlide(start, { x: 180, y: 600 - CANCEL_SLIDE_PX + 1 }), false, '差 1px 不算');
  assert.equal(isCancelSlide(start, { x: 180, y: 600 - CANCEL_SLIDE_PX }), true, '正好到阈值算');
  assert.equal(isCancelSlide(start, { x: 180, y: 600 - 200 }), true, '超过当然算');

  // 往下滑绝不能是取消（旧方向必须失效）
  assert.equal(isCancelSlide(start, { x: 180, y: 800 }), false, '下滑不是取消');
  // 纯横向滑动也不是
  assert.equal(isCancelSlide(start, { x: 20, y: 600 }), false, '横滑不改变纵向位移');
});

test('★★ 上滑取消按「相对起点」判，且要求纵向占优', () => {
  /*
   * 两点：
   * ① 相对起点 —— 相邻判定在"中途改主意"时会断（中间那几帧可能是斜的）
   * ② 纵向占优 —— 左滑时拇指走弧线会自然上抬，只看纵向会把
   *    "想发内心独白"判成"取消"，结果一句话都没发出去
   */
  const start = { x: 180, y: 600 };
  // 一路纯上滑到起点上方 80
  assert.equal(isCancelSlide(start, { x: 180, y: 520 }), true, '从起点算已经高了 80，必须判取消');

  // 斜着滑（横向占优）：不算取消
  assert.equal(isCancelSlide(start, { x: 100, y: 530 }), false, '左滑 80 + 上抬 70：横向占优，不是取消');
  assert.equal(isCancelSlide(start, { x: 260, y: 530 }), false, '右滑 80 + 上抬 70：同样不是取消');
});

test('★★ cancelRecording：只在 recording 阶段有效，结果与 cancelDraft 完全一致', () => {
  /*
   * 两个"作废"（录音中下滑、待确认点取消）如果结果不一致，
   * 用户会遇到"同样取消，有时干净有时留残影"，而代码上看不出差别。
   * 所以这里逐字段比。
   */
  const recording = beginRecording(createVoiceFlow('speak'), 'inner');
  const cancelled = cancelRecording(recording);

  assert.equal(cancelled.stage, 'idle');
  assert.equal(cancelled.draft, null, '不许留文本');
  assert.equal(cancelled.mode, 'inner', '模式要保留（下次还用这个）');

  // 与确认态的取消结果逐字段相同
  const confirming = { stage: 'confirming', mode: 'inner', draft: '(x)' };
  assert.deepEqual(cancelDraft(confirming), cancelled, '两条作废路径的结果必须一字不差');

  // 其它阶段是空操作 —— 松手后才下滑，不该还能取消
  for (const stage of ['idle', 'transcribing', 'confirming']) {
    const flow = { stage, mode: 'speak', draft: null };
    assert.equal(cancelRecording(flow), flow, `${stage} 阶段不该被 cancelRecording 改动`);
  }
});
