/**
 * 语音接线（v0.1.7 / T15.6）—— DOM 交互 + 三条红线。
 *
 * ## 这一组守什么
 *
 * 1. **三个挂载点真的接上了**（不是占位）；
 * 2. **完整交互链路**：按住 → 波形 → 松手 → 转写 → 包裹 → 直发/待确认；
 * 3. **三条红线**：音频直连厂商 / ASR 与聊天配置隔离 / voice 标记 round-trip。
 *
 * 波形与状态机的纯逻辑已在 `test/voice.test.mjs`（36 条）与
 * `test/voice-config.test.mjs`（9 条）里验过。这里**不重复验那部分** ——
 * 只验"接线有没有把它们接对"。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { setVoiceFlag, isVoiceMsg } from '@tcs/shared';
import { VoicePanel } from '../client/src/chat/voice-panel.ts';
import { buildAsrEndpoint, blobToBase64, transcribe } from '../client/src/chat/asr-client.ts';
import { byteAmplitudeToRaw, peakAmplitude, pickMimeType } from '../client/src/chat/recorder.ts';
import { VOICE_MOUNTS } from '../client/src/chat/chat-view.ts';

/* ── 极简 DOM stub（与 chat-view-dom 同一套能力，加 value/rect） ── */

function makeDoc() {
  const createElement = (tag) => {
    const attributes = new Map();
    const node = {
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      innerHTML: '',
      hidden: false,
      value: '',
      dataset: {},
      children: [],
      listeners: {},
      append(...nodes) {
        for (const one of nodes) {
          this.children.push(typeof one === 'string' ? { textContent: one, children: [], isText: true } : one);
        }
      },
      replaceChildren(...nodes) {
        this.children = [];
        this.append(...nodes);
      },
      setAttribute(name, value) {
        attributes.set(name, String(value));
      },
      getAttribute(name) {
        return attributes.has(name) ? attributes.get(name) : null;
      },
      addEventListener(type, handler) {
        (this.listeners[type] ??= []).push(handler);
      },
      removeEventListener() {},
      getBoundingClientRect() {
        return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      },
      fire(type, payload = {}) {
        for (const handler of this.listeners[type] ?? []) handler({ type, target: this, ...payload });
      },
    };
    return node;
  };

  const winListeners = {};
  return {
    createElement,
    defaultView: {
      addEventListener(type, handler) {
        (winListeners[type] ??= []).push(handler);
      },
    },
    fireWindow(type, payload = {}) {
      for (const handler of winListeners[type] ?? []) handler({ type, ...payload });
    },
  };
}

function findAll(root, predicate) {
  const found = [];
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (node.isText !== true && predicate(node)) found.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return found;
}
const byRole = (root, role) => findAll(root, (n) => n.getAttribute('data-role') === role);
const byId = (root, id) => findAll(root, (n) => n.getAttribute('id') === id);

const flush = () => new Promise((r) => setImmediate(r));

/*
 * ★ `pointerup` 必须从 **window** 派发，不是从 mic。
 *
 * 面板把 pointerup 绑在 window 上（`voice-panel.ts` 的 renderMic 里有说明）：
 * 手指按住麦克风往上滑到 chips 再松手，事件目标已经不是 mic 了 ——
 * 绑在 mic 上会漏掉这种"滑出后松手"，表现为**录音永远停不下来**。
 *
 * 我第一版测试就是 `mic.fire('pointerup')`，7 条全红。
 * 那不是实现的问题，是测试没模拟真实事件流。
 */

/** 假录音/转写：可控振幅、可控转写结果 */
function fakeTransport(options = {}) {
  const calls = { start: 0, stop: 0, discard: 0, transcribe: 0 };
  let amplitude = options.amplitude ?? 20000;
  return {
    calls,
    setAmplitude(v) {
      amplitude = v;
    },
    async start() {
      calls.start += 1;
      return {
        amplitude: () => amplitude,
        async stop() {
          calls.stop += 1;
          return new Blob(['fake-audio'], { type: 'audio/webm' });
        },
        discard() {
          calls.discard += 1;
        },
      };
    },
    async transcribe() {
      calls.transcribe += 1;
      if (options.transcribeError !== undefined) throw new Error(options.transcribeError);
      return options.transcript ?? '你好啊';
    },
  };
}

/**
 * 找语音态的大圆按钮。
 *
 * ## ★ 2026-11-02 为什么改成"两个容器都找"
 *
 * 布局改成三圆横排后，大圆从 `stage` 移到了 `chips`（三圆那一行）里 ——
 * 因为三个圆必须在同一个 flex 行里才能左右对称（分两个容器靠外边距
 * 对齐会在窄屏偏移）。
 *
 * 原来这些判据写的是 `findAll(mounts.stage, …)`，于是全部报
 * 「语音态里应当有大圆按钮」—— 而按钮其实在，只是换了容器。
 *
 * 这是第 6 次「判据钉结构」。判据的意图是**"大圆存在且可按住"**，
 * 不是"它必须挂在 stage 下面"。所以这里两个容器都找。
 */
function findBigmic(mounts) {
  const inStage = findAll(mounts.stage, (n) => n.className.includes('nb-voice-bigmic'))[0];
  if (inStage !== undefined) return inStage;
  return findAll(mounts.chips, (n) => n.className.includes('nb-voice-bigmic'))[0];
}

/**
 * 进入语音态并按住大圆按钮。
 *
 * 2026-10-30 用户把形态改成两级：先点工具栏小图标进语音态
 * （输入框与发送消失），再按住大圆说话。所以测试也要走两步 ——
 * 直接 `mic.fire('pointerdown')` 已经不会开始录音了。
 */
async function beginVoice(mounts) {
  mounts.mic.fire('click');
  await flush();
  const bigmic = findBigmic(mounts);
  assert.ok(bigmic !== undefined, '语音态里应当有大圆按钮');
  bigmic.fire('pointerdown', {});
  await flush();
  return bigmic;
}

/** 造一个面板 + 收集发送出去的消息 */
function makePanel(overrides = {}) {
  const doc = makeDoc();
  const sent = [];
  const notes = [];
  const transport = overrides.transport ?? fakeTransport();
  const panel = new VoicePanel({
    doc,
    asrConfigured: overrides.asrConfigured ?? true,
    confirmBeforeSend: overrides.confirmBeforeSend ?? false,
    transport: overrides.asrConfigured === false ? undefined : transport,
    onSend: (text) => {
      sent.push(text);
    },
    onNotify: (message, kind) => {
      notes.push({ message, kind });
    },
    onNeedAsrConfig: overrides.onNeedAsrConfig,
    onDraftShown: overrides.onDraftShown,
    // 测试里不要真等 120ms
    setInterval: () => 1,
    clearInterval: () => {},
  });
  const mounts = panel.render();
  // 大圆按钮在 stage 内部，取出来方便测试按住
  const bigmic = findBigmic(mounts);
  return { panel, mounts, bigmic, doc, sent, notes, transport };
}

/* ═══════════════════════════════════════════════════════════
   一、三个挂载点接上了
   ═══════════════════════════════════════════════════════════ */

test('★ 三个挂载点的 id 与 T15.5 承诺的一致（不许自造）', () => {
  const { mounts } = makePanel();
  assert.equal(mounts.mic.getAttribute('id'), VOICE_MOUNTS.mic);
  assert.equal(mounts.chips.getAttribute('id'), VOICE_MOUNTS.chips);
  assert.equal(mounts.confirm.getAttribute('id'), VOICE_MOUNTS.confirm);
});

test('★ 麦克风从 div 换成 button（可聚焦、可被读屏念出）', () => {
  const { mounts } = makePanel();
  assert.equal(mounts.mic.tagName, 'BUTTON');
  assert.equal(mounts.mic.getAttribute('type'), 'button');
  // 语义变了：小图标现在是「切换到语音输入」，不是「按住说话」
  assert.equal(mounts.mic.getAttribute('aria-label'), '切换到语音输入');
});

test('★ 麦克风类名不变（48×48 由 CSS token 保证，不许内联尺寸）', () => {
  const { mounts } = makePanel();
  assert.equal(mounts.mic.className, 'nb-mic-slot');
  assert.equal(mounts.mic.getAttribute('style'), null, '不许写内联尺寸 —— 走查第 2 条靠 token 守');
});

test('★ chips：hidden 改 false，且三个档位用 .nb-chip（2026-11-02 三圆横排）', () => {
  const { mounts } = makePanel();
  assert.equal(mounts.chips.hidden, false, '三个圆在语音态里要一直可见');
  /*
   * ★ 用**精确类名**匹配，不能用 `includes('nb-chip')`。
   *
   * 容器自己的类名是 `nb-voice-chips-slot`，里面含子串 `nb-chip` ——
   * 用 includes 会把它也算进来（实测得到 5 个而不是 3 个）。
   * 这里改成 `=== 'nb-chip'`：既避免误匹配，也保证"档位圆用的是专属类"。
   */
  const chips = findAll(mounts.chips, (n) => n.className === 'nb-chip');
  assert.equal(chips.length, 2, '左右各一个档位圆（中间那个是大圆按钮，不是 chip）');
  for (const chip of chips) {
    assert.equal(chip.getAttribute('role'), 'radio');
    assert.ok(
      ['inner', 'message'].includes(chip.getAttribute('data-voice-mode') ?? ''),
      `档位圆的 data-voice-mode 只能是 inner / message，实际 ${String(chip.getAttribute('data-voice-mode'))}`,
    );
  }
  /*
   * 大圆本身也是「说话」这一档，所以 `data-voice-mode=speak` 必须在它身上 ——
   * 否则"按住中间 = 说话"这个语义在 DOM 上没有落点，读屏与验收都看不见。
   */
  const big = findBigmic(mounts);
  assert.ok(big !== undefined, '缺大圆');
  assert.equal(big.getAttribute('data-voice-mode'), 'speak');
});

test('★ 待确认条：默认隐藏；内部有音频条 + 可编辑文本 + 确认 + 取消', () => {
  /*
   * 2026-10-30 用户把形态改成「消息流里的草稿卡」：
   * 音频条（时长决定长度、纯视觉不播放）+ 文字气泡（点一下就地改）+ 确认/取消。
   *
   * 所以波形缩略的类名从 `nb-voice-wave-thumb` 变成 `nb-voice-bar-wave`。
   * 这类"结构变了测试要跟着改"的断言有个坑：**改测试很容易改成"随便长啥样都过"**。
   * 这里的做法是保留每一处**具体的类名**，只把过时的那个换掉 —— 不是放宽成
   * "有 descendant 就算过"。
   */
  const { mounts } = makePanel();
  assert.equal(mounts.confirm.hidden, true, '没在确认态时不该占屏幕');

  const barbox = byRole(mounts.confirm, 'voice-barbox');
  assert.equal(barbox.length, 1, '缺音频条');

  const wave = findAll(barbox[0], (n) => n.className === 'nb-voice-bar-wave');
  assert.equal(wave.length, 1, '缺波形缩略');
  assert.ok(findAll(wave[0], (n) => n.className === 'nb-voice-wave-bar').length >= 8, '缩略图柱子太少');

  const draft = byRole(mounts.confirm, 'voice-draft');
  assert.equal(draft.length, 1, '缺可编辑文本');
  assert.equal(draft[0].tagName, 'TEXTAREA');

  assert.equal(byRole(mounts.confirm, 'voice-send').length, 1, '缺确认');
  assert.equal(byRole(mounts.confirm, 'voice-cancel').length, 1, '缺取消');
});

/* ═══════════════════════════════════════════════════════════
   二、交互链路
   ═══════════════════════════════════════════════════════════ */

test('★ 未配置 ASR：麦克风置灰但**点击要跳配置页**（不许静默）', async () => {
  let wentToConfig = 0;
  const { mounts, notes } = makePanel({
    asrConfigured: false,
    onNeedAsrConfig: () => {
      wentToConfig += 1;
    },
  });

  // 置灰用 data-enabled，不是 disabled —— disabled 会让点击根本不触发
  assert.equal(mounts.mic.getAttribute('data-enabled'), 'false');
  assert.equal(mounts.mic.getAttribute('aria-label'), '语音识别未配置，点击去配置');

  mounts.mic.fire('click');
  await flush();

  assert.equal(wentToConfig, 1, '点击必须跳配置页');
  assert.equal(notes.length, 1, '要给一句话说明，不是静默无响应');
  assert.ok(notes[0].message.includes('配置'), notes[0].message);
});

test('★ 按住 → 录音态 + chips 浮起', async () => {
  const { mounts, transport } = makePanel();
  const bigmic = await beginVoice(mounts);
  await flush();

  assert.equal(transport.calls.start, 1, '应当开始录音');
  assert.equal(bigmic.getAttribute('data-recording'), 'true', '录音态应当反映在大圆按钮上');
  assert.equal(mounts.chips.getAttribute('data-active'), 'true');
  /*
   * 录音中波形画在**顶部那一条**上（2026-11-02 布局改造），不再塞进大圆。
   *
   * 判据从"大圆里有柱子"改成"顶部两段各有一排柱子，且大圆里**没有**柱子"——
   * 后半句是反向断言：如果谁把波形又画回大圆，会出现两处波形同时在跳。
   */
  assert.ok(
    findAll(mounts.stage, (n) => n.className === 'nb-voice-wave-bar').length >= 8,
    '录音时顶部应有波形柱（两段合计 ≥ 8 根）',
  );
  assert.equal(
    findAll(bigmic, (n) => n.className === 'nb-bigmic-bar').length,
    0,
    '大圆里不该再画波形（顶部已有，两处同时跳会显得很乱）',
  );
  /* 顶部波形行要标出"录音中"，CSS 靠它决定跳动还是压平 */
  const waveRow = byRole(mounts.stage, 'voice-waveclock')[0];
  assert.ok(waveRow !== undefined, '缺顶部波形行');
  assert.equal(waveRow.getAttribute('data-recording'), 'true');
});

test('★ 松手 → 转写 → 直发（确认关）', async () => {
  const { mounts, doc, sent, transport, panel } = makePanel({ confirmBeforeSend: false });

  const bigmic = await beginVoice(mounts);
  await flush();
  assert.equal(panel.snapshot().flow.stage, 'recording');

  doc.fireWindow('pointerup', { clientX: 100, clientY: 100 });
  await flush();
  await flush();

  assert.equal(transport.calls.stop, 1, '应当停止录音');
  assert.equal(transport.calls.transcribe, 1, '应当调用转写');
  assert.equal(sent.length, 1, '确认关时应当立刻发送');
  /*
   * 默认模式是 speak，`wrapVoiceText` 会包成**中文弯引号**。
   * 我第一版期望写成裸的转写文本，实测才发现带包裹符 ——
   * 包裹符是需求要的（语音内容要能看出这是说出来的），不是多余装饰。
   */
  assert.equal(sent[0], '“你好啊”', '直发内容必须是包裹后的文本');
  assert.equal(panel.snapshot().flow.stage, 'idle');
});

test('★ 确认开 → 停留待确认，条可见，draft=已包裹文本', async () => {
  const { mounts, doc, sent, panel } = makePanel({ confirmBeforeSend: true });

  const bigmic = await beginVoice(mounts);
  await flush();
  doc.fireWindow('pointerup', {});
  await flush();
  await flush();

  assert.equal(sent.length, 0, '确认开时**不许**自动发送');
  assert.equal(panel.snapshot().flow.stage, 'confirming');
  assert.equal(panel.snapshot().flow.draft, '“你好啊”', 'draft 是已包裹文本（需求写明编辑对象是已包裹文本）');
});

test('★ 点击「确认」：发的是编辑框的**编辑值**，不是原始转写', async () => {
  const { mounts, doc, sent, panel } = makePanel({ confirmBeforeSend: true });

  await beginVoice(mounts);
  await flush();
  doc.fireWindow('pointerup', {});
  await flush();
  await flush();

  /*
   * ★ 必须先点文字气泡进编辑态，再改值。
   *
   * 第一版这条测试是直接 `draft.value = '我改过的内容'` 然后点确认 ——
   * 那时实现读的就是 textarea 的 value，所以能过。但**这个前提是假的**：
   * 只读态下 textarea 是隐藏的空壳，真实用户不点文字就写不进它。
   * 于是"测试直接塞值"掩盖了"实现依赖一个隐藏输入框"的错误。
   * 现在改成走真实交互：点开 → 改 → 点确认。
   */
  byRole(mounts.confirm, 'voice-textview')[0].fire('click');
  const draft = byRole(mounts.confirm, 'voice-draft')[0];
  draft.value = '我改过的内容';
  byRole(mounts.confirm, 'voice-send')[0].fire('click');
  await flush();

  assert.equal(sent.length, 1);
  assert.equal(sent[0], '我改过的内容', '编辑后发送=编辑值（需求 §2）');
  assert.equal(panel.snapshot().flow.stage, 'idle');
});

test('★ 点击「取消」= 本次作废（不发、不留文本）', async () => {
  const { mounts, doc, sent, panel } = makePanel({ confirmBeforeSend: true });

  const bigmic = await beginVoice(mounts);
  await flush();
  doc.fireWindow('pointerup', {});
  await flush();
  await flush();
  assert.equal(panel.snapshot().flow.stage, 'confirming');

  byRole(mounts.confirm, 'voice-cancel')[0].fire('click');
  await flush();

  assert.equal(sent.length, 0, '取消不该发送');
  assert.equal(panel.snapshot().flow.stage, 'idle');
  assert.equal(panel.snapshot().flow.draft, null, '取消=作废，不许留文本（用户拍板）');
  assert.equal(mounts.confirm.hidden, true, '取消后确认条要消失');
});

test('★ 空白转写：不发、给提示、回 idle（不挂浮层）', async () => {
  const transport = fakeTransport({ transcript: '   ' });
  const { mounts, doc, sent, notes, panel } = makePanel({ transport, confirmBeforeSend: false });

  const bigmic = await beginVoice(mounts);
  await flush();
  doc.fireWindow('pointerup', {});
  await flush();
  await flush();

  assert.equal(sent.length, 0, '空白不许发送');
  assert.equal(panel.snapshot().flow.stage, 'idle');
  assert.ok(notes.some((n) => n.message.includes('没听清')), '要给提示而不是静默消失');
});

test('★ 转写失败：回 idle + 人话提示（不是卡在 transcribing）', async () => {
  const transport = fakeTransport({ transcribeError: 'key 不对，请重新填写' });
  const { mounts, doc, sent, notes, panel } = makePanel({ transport });

  const bigmic = await beginVoice(mounts);
  await flush();
  doc.fireWindow('pointerup', {});
  await flush();
  await flush();

  assert.equal(sent.length, 0);
  assert.equal(panel.snapshot().flow.stage, 'idle', '出错必须回 idle，否则浮层一直挂着');
  assert.ok(notes.some((n) => n.message.includes('key')), '错误文案要传出去');
});

test('★★ 录音中**横向**滑动切模式（2026-11-01 改成左滑内心/右滑消息）', async () => {
  /*
   * ★ 这条原来是"上滑命中 chips"的判据。
   *
   * 用户实测反馈他根本没用出上滑选 chips（原话：「实测麦克风不是长按上滑选择，
   * 而是点按后说话，然后再点文本类型」），并建议改成 QQ 那样的横向滑动：
   * 左滑=内心、右滑=消息、中间=说话。
   *
   * 所以这条判据**跟着手势一起改**，而不是删掉 —— 删掉就等于
   * "这功能不再有人守"。改的是"怎么切"，守的是"能切且切对"。
   */
  const { mounts, panel } = makePanel();

  /*
   * ★ 2026-11-02 手势判据改成**命中圆按钮**，所以这里要先给三个圆造矩形。
   *
   * 原来判的是横向位移（`dx <= -56` ⇒ 内心），只要坐标够远就行；
   * 现在判的是"手指落点是否在某个圆的矩形里"，与视觉完全一致
   * （用户原话是"按住并滑到这个按钮上使用"）。
   *
   * 布局（与 CSS 一致，取自真机 1080×2400 的一半量级）：
   * ```text
   *   左圆   x 20..84    右圆   x 276..340
   *   大圆   x 116..204
   *   纵向   y 760..824（三个圆同一行）
   * ```
   * 桩里给 `getBoundingClientRect` 后，`modeUnderPoint()` 才能判出档位。
   */
  const RECTS = {
    inner: { left: 20, top: 760, width: 64, height: 64 },
    message: { left: 276, top: 760, width: 64, height: 64 },
    speak: { left: 116, top: 748, width: 88, height: 88 },
  };
  for (const [mode, chipBox] of Object.entries(RECTS)) {
    const node =
      mode === 'speak'
        ? findBigmic(mounts)
        : findAll(mounts.chips, (n) => n.getAttribute?.('data-voice-mode') === mode)[0];
    assert.ok(node !== undefined, `缺 ${mode} 的圆`);
    node.getBoundingClientRect = () => chipBox;
  }

  /*
   * 必须带坐标按下去：`pressStart` 是上滑取消的基准点，
   * 空事件（`beginVoice` 那种 `{}`）不会设它，后续 move 会被直接跳过。
   */
  mounts.mic.fire('click');
  await flush();
  const bigmic = findBigmic(mounts);
  assert.ok(bigmic !== undefined, '语音态里应当有大圆按钮');
  bigmic.fire('pointerdown', { clientX: 160, clientY: 792 });
  await flush();

  assert.equal(panel.snapshot().flow.mode, 'speak', '默认模式是「说话」');

  /* 滑到左圆中心（52, 792）→ 内心 */
  panel.handlePointerMove(52, 792);
  assert.equal(panel.snapshot().flow.mode, 'inner', '滑到左圆上应当切到「内心」');

  /* 滑到右圆中心（308, 792）→ 消息 */
  panel.handlePointerMove(308, 792);
  assert.equal(panel.snapshot().flow.mode, 'message', '滑到右圆上应当切到「消息」');

  /* 滑回大圆中间 → 说话 */
  panel.handlePointerMove(160, 792);
  assert.equal(panel.snapshot().flow.mode, 'speak', '滑回中间应当回到「说话」');

  /*
   * 反向断言：滑到**两圆之间的空白地带**（如 x=110）也要回到说话，
   * 而不是保持上一次的档位 —— 用户手抖划出圆外时仍在"对着中间说话"。
   */
  panel.handlePointerMove(52, 792);
  assert.equal(panel.snapshot().flow.mode, 'inner');
  panel.handlePointerMove(110, 792);
  assert.equal(panel.snapshot().flow.mode, 'speak', '滑到空白处应回落「说话」');
});

test('★★ 切到「内心」后发送，包裹符要跟着变', async () => {
  /*
   * 手势从"上滑命中 chip"改成"横向滑动"（2026-11-01），
   * 所以选模式的步骤要跟着改 —— 但**断言的核心没变**：
   * 切到内心之后，发出去的文字要带（）包裹。
   *
   * 这条守的是"模式真的影响输出"，而不是"手势怎么选"。
   */
  const { mounts, doc, sent, panel } = makePanel({ confirmBeforeSend: false });

  /*
   * 2026-11-02 起"选内心"要**滑到左圆上**，所以先给左圆造矩形 ——
   * 判定已从位移阈值改成命中矩形（见 `handlePointerMove` 的注释）。
   */
  const bigmic0 = findBigmic(mounts);
  const innerChip = findAll(mounts.chips, (n) => n.getAttribute?.('data-voice-mode') === 'inner')[0];
  assert.ok(bigmic0 !== undefined && innerChip !== undefined, '缺大圆或左圆');
  bigmic0.getBoundingClientRect = () => ({ left: 116, top: 748, width: 88, height: 88 });
  innerChip.getBoundingClientRect = () => ({ left: 20, top: 760, width: 64, height: 64 });

  mounts.mic.fire('click');
  await flush();
  const bigmic = findBigmic(mounts);
  bigmic.fire('pointerdown', { clientX: 160, clientY: 792 });
  await flush();

  panel.handlePointerMove(52, 792); // 滑到左圆 = inner

  doc.fireWindow('pointerup', { clientX: 52, clientY: 792 });
  await flush();
  await flush();

  assert.equal(sent.length, 1);
  /*
   * 「内心/动作」模式包成圆括号；「说话」是弯引号。
   *
   * 用**具体值**而不是 `notEqual(..., 裸文本)`：后者在"所有模式都不包裹"
   * 的实现下也会通过（都不等于裸文本），等于没验。
   */
  assert.equal(sent[0], '(你好啊)', '「内心/动作」模式应当包成圆括号');
});

/* ═══════════════════════════════════════════════════════════
   三、红线
   ═══════════════════════════════════════════════════════════ */

test('★★ 红线一：ASR 端点只由用户 base_url 拼成，TCS 服务端零接触', () => {
  /*
   * 这条是静态断言：扫源码，确认 ASR 客户端里**不存在**任何 TCS 域名字面量。
   *
   * 为什么用静态断言而不是运行时抓包：运行时抓包只能证明"这一次没发"，
   * 而静态断言证明"代码里根本没有这条路径"—— 后者才是红线该有的强度。
   * （运行时抓包另有一条，见 `test/voice-redline.test.mjs`。）
   */
  const source = readFileSync(join(import.meta.dirname, '..', 'client', 'src', 'chat', 'asr-client.ts'), 'utf8');

  // 排除注释（文档里会提到"不经 TCS"这类话）
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const forbidden = ['taverncard', 'tcs-server', '10.9.0', 'localhost:8730', '127.0.0.1:8730'];
  for (const word of forbidden) {
    assert.equal(
      code.toLowerCase().includes(word),
      false,
      `ASR 客户端里出现了 ${word} —— 音频不许经过 TCS 服务端`,
    );
  }
});

test('★ ASR 端点拼接：带 /v1 的 base 不会被吃掉', () => {
  assert.equal(
    buildAsrEndpoint('https://api.openai.com/v1', 'transcriptions'),
    'https://api.openai.com/v1/audio/transcriptions',
  );
  // 用户把完整端点粘进来：不重复拼
  assert.equal(
    buildAsrEndpoint('https://api.openai.com/v1/audio/transcriptions', 'transcriptions'),
    'https://api.openai.com/v1/audio/transcriptions',
  );
  // 尾部斜杠要规整
  assert.equal(
    buildAsrEndpoint('https://x.com/v1/', 'transcriptions'),
    'https://x.com/v1/audio/transcriptions',
  );
  // 路线 B
  assert.equal(buildAsrEndpoint('https://x.com/v1', 'chat-audio'), 'https://x.com/v1/chat/completions');
});

test('★ 转写请求打到用户填的域名（fake fetch 记录 URL）', async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return { text: '识别结果' };
      },
    };
  };

  const result = await transcribe({
    preset: { id: 'openai', name: 'OpenAI', protocol: 'transcriptions', baseUrl: '', model: '', note: '', advanced: false },
    baseUrl: 'https://asr.example.com/v1',
    apiKey: 'sk-user',
    model: 'whisper-1',
    audio: new Blob(['x'], { type: 'audio/webm' }),
    fetchImpl: fakeFetch,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.text, '识别结果');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://asr.example.com/v1/audio/transcriptions', '必须直连用户填的域名');
  // Authorization 带的是用户的 key
  assert.equal(seen[0].init.headers.Authorization, 'Bearer sk-user');
});

test('★ 403 归到 auth（多数厂商用 403 表示 key 不对）', async () => {
  const result = await transcribe({
    preset: { id: 'openai', name: 'OpenAI', protocol: 'transcriptions', baseUrl: '', model: '', note: '', advanced: false },
    baseUrl: 'https://x.com/v1',
    apiKey: 'bad',
    model: 'm',
    audio: new Blob(['x']),
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.kind, 'auth');
});

test('★ 404 归到 unsupported-endpoint（换 key 没用，要换中转站）', async () => {
  const result = await transcribe({
    preset: { id: 'x', name: 'X', protocol: 'transcriptions', baseUrl: '', model: '', note: '', advanced: false },
    baseUrl: 'https://x.com/v1',
    apiKey: 'k',
    model: 'm',
    audio: new Blob(['x']),
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.kind, 'unsupported-endpoint');
  assert.ok(result.failure.message.includes('换') || result.failure.message.includes('中转'), result.failure.message);
});

test('★★ 红线三：extra.tcs.voice 经保存/读取链路后仍在', () => {
  /*
   * 契约测试第 6 条的用例在 `test/st-adapter-messages.test.mjs` 里已经跑过
   * 完整 JSONL 链路。这里验的是**语音面板打标记这一侧**：
   * 面板发出消息时必须真的带上标记，否则那条契约测试守的是"写进去能读回来"，
   * 而"写没写"没人管。
   */
  const base = { name: '我', is_user: true, mes: '“你好”' };
  const flagged = setVoiceFlag(base);

  assert.equal(isVoiceMsg(flagged), true);
  // 经 JSON round-trip（模拟存盘再读回）
  const reloaded = JSON.parse(JSON.stringify(flagged));
  assert.equal(isVoiceMsg(reloaded), true, 'round-trip 后徽标必须还在');

  // 打字发的消息不许带标记
  assert.equal(isVoiceMsg(base), false);
});

/* ═══════════════════════════════════════════════════════════
   四、录音工具的换算（真源接入后最容易错的一处）
   ═══════════════════════════════════════════════════════════ */

test('★ 振幅换算：静音中点 128 → 0，满幅 → 接近上限', () => {
  assert.equal(byteAmplitudeToRaw(128), 0, '128 是静音中点');
  assert.equal(byteAmplitudeToRaw(0), 32768, '最低点为满幅负向');
  assert.equal(byteAmplitudeToRaw(255), 32512);
  // 越界要 clamp，不许溢出成负数
  assert.equal(byteAmplitudeToRaw(-10), 32768);
  assert.equal(byteAmplitudeToRaw(300), 32512);
});

test('★ peakAmplitude 取峰值（不取平均，否则语音音节被稀释）', () => {
  const silence = new Uint8Array([128, 128, 128, 128]);
  assert.equal(peakAmplitude(silence), 0);

  // 一个尖峰夹在静音里：平均会接近 0，峰值应抓到它
  const oneSpike = new Uint8Array([128, 128, 250, 128, 128]);
  assert.ok(peakAmplitude(oneSpike) > 30000, `峰值应当抓到 ${peakAmplitude(oneSpike)}`);
});

test('★ mimeType 优先级：mp4 优先（iOS 只认它），都没有就返回空让浏览器自己选', () => {
  assert.equal(pickMimeType((t) => t === 'audio/mp4'), 'audio/mp4');
  assert.equal(
    pickMimeType((t) => t === 'audio/webm;codecs=opus' || t === 'audio/webm'),
    'audio/webm;codecs=opus',
    'mp4 与 webm 都支持时优先 mp4',
  );
  assert.equal(pickMimeType(() => false), '', '一个都不支持时不许硬塞类型');
});

test('blobToBase64 能转（路线 B 要用）', async () => {
  const blob = new Blob([new Uint8Array([104, 105])]); // "hi"
  const b64 = await blobToBase64(blob);
  assert.equal(b64.length > 0, true);
  // "hi" 的 base64 是 aGk=
  assert.equal(b64, 'aGk=');
});

test('★ 待确认态要收起 chips（两者都定位在输入区上方，会重叠）', async () => {
  /*
   * 2026-10-30 录屏实测发现：确认条与 chips 都 `bottom: 100%`，
   * 同时显示时波形与 chip 文字压在一起，两边都看不清。
   *
   * 语义上也不该有 chips —— 录音已结束，切模式没有意义。
   */
  const { mounts, doc, panel } = makePanel({ confirmBeforeSend: true });

  // 录音中：chips 可见（要能滑动切模式）
  const bigmic = await beginVoice(mounts);
  await flush();
  assert.equal(mounts.chips.hidden, false, '录音中 chips 必须可见');

  // 松手进确认态：chips 收起
  doc.fireWindow('pointerup', {});
  await flush();
  await flush();

  assert.equal(panel.snapshot().flow.stage, 'confirming');
  assert.equal(mounts.chips.hidden, true, '确认态必须收起 chips，否则与确认条重叠');
  assert.equal(mounts.confirm.hidden, false, '确认条这时要显示');
});

test('取消回到 idle 后 chips 要重新出现', async () => {
  const { mounts, doc } = makePanel({ confirmBeforeSend: true });
  const bigmic = await beginVoice(mounts);
  await flush();
  doc.fireWindow('pointerup', {});
  await flush();
  await flush();

  byRole(mounts.confirm, 'voice-cancel')[0].fire('click');
  await flush();
  assert.equal(mounts.chips.hidden, false, '取消后要能再次看到模式');
});

/* ═══════════════════════════════════════════════════════════
   五、语音态形态（2026-10-30 用户改的要求）
   ═══════════════════════════════════════════════════════════ */

test('★ 语音态：舞台出现、含大圆按钮 + 提示 + 切回键盘', () => {
  const { mounts, panel } = makePanel();
  assert.equal(panel.currentStage(), 'keyboard', '默认是键盘态');

  mounts.mic.fire('click');

  assert.equal(panel.currentStage(), 'voice');
  // 舞台自己承载形态属性，CSS 据此显示
  assert.equal(mounts.stage.getAttribute('data-voice'), 'voice');

  const bigmic = [findBigmic(mounts)].filter(Boolean);
  assert.equal(bigmic.length, 1, '缺大圆按钮');

  const hint = byRole(mounts.stage, 'voice-stage-hint');
  assert.equal(hint.length, 1, '缺提示文字');
  /*
   * ★ 2026-11-02 按用户原话改：未按住时只写「按住说话」。
   *
   * 用户原话：「按住中间的按钮是提示**上滑取消**，松开识别为对话」——
   * 也就是"上滑取消"这句**按住之后才出现**。没按住时它还派不上用场，
   * 而那一刻最需要的是"怎么开始"。
   *
   * 反向断言也要有：未按住时**不许**出现"取消"两个字 ——
   * 否则用户一进语音态就看到"取消"，会以为按下去就会出事。
   */
  assert.equal(hint[0].textContent, '按住说话', hint[0].textContent);
  assert.ok(!hint[0].textContent.includes('取消'), '没按住时不该提取消');

  const exit = byRole(mounts.stage, 'voice-stage-exit');
  assert.equal(exit.length, 1, '缺切回键盘 —— 没有它就进得去出不来');

  /* 顶部「波形 · 计时」一行（2026-11-02 用户给的布局图） */
  const waveClock = byRole(mounts.stage, 'voice-waveclock');
  assert.equal(waveClock.length, 1, '缺顶部波形+计时那一行');
  const clock = byRole(mounts.stage, 'voice-clock');
  assert.equal(clock.length, 1, '缺录音计时');
  assert.equal(clock[0].textContent, '0:00', '未录音时计时是 0:00（图片里就是这样）');
});

test('★★ 语音态要广播 onStageChange（输入框与发送的显隐靠它）', () => {
  const stages = [];
  const doc = makeDoc();
  const panel = new VoicePanel({
    doc,
    asrConfigured: true,
    confirmBeforeSend: false,
    transport: fakeTransport(),
    onSend: () => {},
    onStageChange: (stage) => stages.push(stage),
    setInterval: () => 1,
    clearInterval: () => {},
  });
  const mounts = panel.render();

  mounts.mic.fire('click');
  assert.deepEqual(stages, ['voice'], '进语音态要广播');

  byRole(mounts.stage, 'voice-stage-exit')[0].fire('click');
  assert.deepEqual(stages, ['voice', 'keyboard'], '切回键盘也要广播');
});

test('★ 大圆按钮明显比工具栏图标大（不然"按住"不好按）', () => {
  /*
   * 断言的是**类名归属**而不是像素：像素靠 CSS（走查第 2 条守热区），
   * 而这里要守的是"长按目标换成了一个更大的元素"这个结构事实。
   */
  const { mounts } = makePanel();
  const bigmic = findBigmic(mounts);
  assert.ok(bigmic !== undefined);
  assert.equal(bigmic.className, 'nb-voice-bigmic', '大圆按钮要有自己的类（尺寸在 CSS 里）');
  // 它不该是 48px 的图标按钮类
  assert.equal(bigmic.className.includes('nb-icon-btn'), false);
  assert.equal(bigmic.className.includes('nb-mic-slot'), false);
});

test('★ 大圆按钮的 aria 语义是「按住说话」', () => {
  const { mounts } = makePanel();
  const bigmic = findBigmic(mounts);
  assert.equal(bigmic.getAttribute('aria-label'), '按住说话');
  assert.equal(bigmic.getAttribute('type'), 'button');
});

test('★★ 切回键盘要复位录音状态（否则留下挂着的状态机）', async () => {
  const { mounts, panel, transport } = makePanel();
  await beginVoice(mounts);
  assert.equal(panel.snapshot().flow.stage, 'recording');

  byRole(mounts.stage, 'voice-stage-exit')[0].fire('click');
  await flush();

  assert.equal(panel.currentStage(), 'keyboard');
  assert.equal(panel.snapshot().flow.stage, 'idle', '离开语音态必须回 idle');
  assert.equal(transport.calls.discard, 1, '正在录的音要丢弃');
});

test('★ 未配置 ASR 时点小图标：不进语音态，而是跳配置页', () => {
  let wentToConfig = 0;
  const { mounts, panel } = makePanel({
    asrConfigured: false,
    onNeedAsrConfig: () => {
      wentToConfig += 1;
    },
  });

  mounts.mic.fire('click');
  assert.equal(wentToConfig, 1);
  assert.equal(panel.currentStage(), 'keyboard', '未配置时不许进语音态（进去也只能干看）');
});

/* ═══════════════════════════════════════════════════════════
   七、上滑取消（2026-10-31 落地，2026-11-02 方向改成上滑）
   ═══════════════════════════════════════════════════════════ */

/** 按住大圆并带上起点坐标（上滑取消需要基准点） */
async function beginVoiceAt(mounts, x, y) {
  mounts.mic.fire('click');
  await flush();
  const bigmic = findBigmic(mounts);
  assert.ok(bigmic !== undefined, '语音态里应当有大圆按钮');
  bigmic.fire('pointerdown', { clientX: x, clientY: y });
  await flush();
  return bigmic;
}

test('★★ 上滑超过阈值 → 松手取消：不发、不转写、录音被丢弃', async () => {
  /*
   * 用户 2026-10-31 原话：「长按语音按钮下滑取消」，
   * 2026-11-02 改成：「按住按钮上滑一段距离取消」（方向调整，理由见 gesture.ts）。
   *
   * 这条测的是**整条链路**，所以三个"不该发生"的都必须断言：
   *   · 不发消息；
   *   · 不调 ASR（取消还去转写等于既花钱又慢，而且转写完了还得扔掉）；
   *   · 录音 Blob 要 discard（不 discard 就是泄漏一个 MediaRecorder）。
   */
  const { mounts, doc, sent, notes, transport, panel } = makePanel({ confirmBeforeSend: false });

  await beginVoiceAt(mounts, 180, 600);
  assert.equal(panel.snapshot().flow.stage, 'recording');

  /*
   * ★ 2026-11-02 方向改成**上滑**（用户明确要求「按住按钮上滑一段距离取消」）。
   * 所以这里从 600 抬到 500（上滑 100px，超过 64 的阈值）。
   */
  panel.handlePointerMove(178, 500);
  await flush();
  assert.equal(panel.snapshot().flow.stage, 'recording', '滑动本身不结束录音');
  assert.equal(sent.length, 0);

  doc.fireWindow('pointerup', { clientX: 178, clientY: 500 });
  await flush();
  await flush();

  assert.equal(sent.length, 0, '取消不该发消息');
  assert.equal(transport.calls.transcribe, 0, '取消不该调 ASR（白花钱）');
  assert.equal(transport.calls.stop, 0, '取消不该产出一段音频再扔掉');
  assert.equal(transport.calls.discard, 1, '录音必须 discard，否则泄漏 MediaRecorder');
  assert.equal(panel.snapshot().flow.stage, 'idle', '回到 idle');
  assert.equal(panel.snapshot().flow.draft, null, '不许留文本');
  assert.ok(notes.some((n) => n.message.includes('取消')), '要给一句"已取消"，否则用户不知道是取消还是丢了');
});

test('★★ 阈值内的上抬不算取消（否则每次说话都被当成取消）', async () => {
  /*
   * 拇指按住时自然抖动十几像素是常态。阈值存在的唯一理由就是它。
   * 这条是反向保护：把阈值改成 0 的实现会在这里红。
   *
   * 2026-11-02 方向改成上滑后，这里跟着改成"只抬 10px"。
   */
  const { mounts, doc, sent, transport, panel } = makePanel({ confirmBeforeSend: false });

  await beginVoiceAt(mounts, 180, 600);
  panel.handlePointerMove(180, 590); // 只抬了 10px
  await flush();

  doc.fireWindow('pointerup', { clientX: 180, clientY: 590 });
  await flush();
  await flush();

  assert.equal(transport.calls.transcribe, 1, '阈值内应当正常转写');
  assert.equal(sent.length, 1, '阈值内应当正常发送');
  assert.equal(transport.calls.discard, 0);
});

test('★★ 松手坐标才是最终判据（最后一次 move 不算数）', async () => {
  /*
   * 真实情况：pointermove 是节流的，最后一次 move 之后手指可能又滑动了一点
   * 才松手。如果只信 `cancelling`（由 move 算出），会出现
   * "提示写着松手取消、结果还是发出去了"。
   *
   * 这里故意**不给任何 move**，只在松手时给一个很靠下的坐标 ——
   * 若实现只信 cancelling，这条会红。
   */
  const { mounts, doc, sent, transport, panel } = makePanel({ confirmBeforeSend: false });

  await beginVoiceAt(mounts, 180, 600);
  // 一次 move 都不发，松手时给一个很高（上滑 120px）的坐标
  doc.fireWindow('pointerup', { clientX: 180, clientY: 480 });
  await flush();
  await flush();

  assert.equal(sent.length, 0, '松手时已经上滑超过阈值，必须取消');
  assert.equal(transport.calls.transcribe, 0);
  assert.equal(panel.snapshot().flow.stage, 'idle');
});

test('★★ 取消态要反映在按钮与提示上（用户得看见"松手就取消"）', async () => {
  /*
   * 只做逻辑不做视觉的话，用户不知道自己滑够了没有 ——
   * 全靠松手后才发现白说了，那和没有这个功能一样。
   */
  const { mounts, panel } = makePanel({ confirmBeforeSend: false });
  const bigmic = await beginVoiceAt(mounts, 180, 600);

  const hint = findAll(mounts.stage, (n) => n.getAttribute('data-role') === 'voice-stage-hint')[0];
  assert.ok(hint !== undefined, '缺提示文字');
  assert.equal(bigmic.getAttribute('data-cancelling'), 'false', '刚开始不是取消态');
  /*
   * ★ 2026-11-02 按用户原话改文案判据：
   * > 按住中间的按钮是提示**上滑取消**，松开识别为对话
   *
   * 所以按住后那行字必须是「上滑取消」。而"左右滑切档"**不再写进提示** ——
   * 左右两个圆本身就在屏幕上、还写着「内心/动作」「消息」，
   * 再拿一行字去教"左右滑"是重复；而"上滑"在界面上**没有任何痕迹**
   * （看不见"往上滑"这个方向），所以只有它需要教。
   */
  assert.equal(hint.textContent, '上滑取消', `按住后提示必须是「上滑取消」：${hint.textContent}`);
  assert.equal(hint.getAttribute('data-state'), 'recording');

  panel.handlePointerMove(180, 500);
  await flush();

  assert.equal(bigmic.getAttribute('data-cancelling'), 'true', '取消态要反映在按钮上');
  assert.equal(hint.textContent, '松开 取消');
  assert.equal(hint.getAttribute('data-state'), 'cancel');

  // 滑回来 → 恢复成"上滑取消"
  panel.handlePointerMove(180, 610);
  await flush();
  assert.equal(bigmic.getAttribute('data-cancelling'), 'false', '滑回来要退出取消态');
  assert.equal(hint.textContent, '上滑取消', `滑回后提示要变回来：${hint.textContent}`);
});

test('★★ pointercancel（系统抢走按压）也要复位取消态', async () => {
  /*
   * `pointercancel` 是"系统把这次按压抢走了"：来电、控制中心下拉、
   * 系统返回手势。真实手机上很常见，而它**不走 pointerup**。
   *
   * 漏复位的后果是隐形的：下次一按住，`pressStart` 还是上一次的坐标，
   * 新手指位置与旧起点一比就可能直接判成"取消" —— 用户会说
   * "有时候按下去什么反应都没有"，而日志里什么都没有。
   *
   * 这条是变异测试逼出来的：把"按下时复位 cancelling"删掉后测试全绿，
   * 我去查哪个出口漏了，发现就是这里。
   */
  const { mounts, doc, panel } = makePanel({ confirmBeforeSend: false });
  const bigmic = await beginVoiceAt(mounts, 180, 600);

  panel.handlePointerMove(180, 500);
  await flush();
  assert.equal(bigmic.getAttribute('data-cancelling'), 'true', '先进入取消态');

  // 系统抢走按压
  doc.fireWindow('pointercancel', {});
  await flush();

  assert.equal(
    bigmic.getAttribute('data-cancelling'),
    'false',
    'pointercancel 后必须退出取消态（否则界面停在「松开 取消」）',
  );
  assert.equal(panel.snapshot().flow.stage, 'idle', '回 idle');
});

test('★★ 取消后能立刻重新录（状态机没被卡住）', async () => {
  /*
   * 取消路径如果漏了某个复位（比如没清 `cancelling`），
   * 下一次录音一按下去就被判成取消 —— 而用户完全不知道发生了什么。
   */
  const { mounts, doc, sent, transport, panel } = makePanel({ confirmBeforeSend: false });

  await beginVoiceAt(mounts, 180, 600);
  doc.fireWindow('pointerup', { clientX: 180, clientY: 480 });
  await flush();
  await flush();
  assert.equal(sent.length, 0);

  // 第二次：正常按住、不滑、松手
  await beginVoiceAt(mounts, 180, 600);
  assert.equal(panel.snapshot().flow.stage, 'recording', '第二次必须能正常录');
  assert.equal(
    findBigmic(mounts).getAttribute('data-cancelling'),
    'false',
    '第二次按下去不该还带着上一次的取消态',
  );

  doc.fireWindow('pointerup', { clientX: 180, clientY: 600 });
  await flush();
  await flush();
  assert.equal(sent.length, 1, '第二次应当正常发出');
  assert.equal(transport.calls.transcribe, 1);
});

/* ═══════════════════════════════════════════════════════════
   六、待确认草稿卡片（2026-10-30 用户给的形态）
   ═══════════════════════════════════════════════════════════ */

test('★ 草稿卡片结构：音频条 + 文字气泡 + 确认/取消', () => {
  const { mounts } = makePanel();
  const card = mounts.confirm;

  assert.ok(card.className.includes('nb-voice-draft-card'), card.className);
  assert.equal(byRole(card, 'voice-barbox').length, 1, '缺音频条');
  assert.equal(byRole(card, 'voice-textview').length, 1, '缺文字气泡');
  assert.equal(byRole(card, 'voice-draft').length, 1, '缺编辑框');
  assert.equal(byRole(card, 'voice-send').length, 1, '缺确认');
  assert.equal(byRole(card, 'voice-cancel').length, 1, '缺取消');
});

test('★ 确认按钮文案是「确认」不是「发送」（用户示意图里就是这两个字）', () => {
  const { mounts } = makePanel();
  assert.equal(byRole(mounts.confirm, 'voice-send')[0].textContent, '确认');
  assert.equal(byRole(mounts.confirm, 'voice-cancel')[0].textContent, '取消');
});

test('★ 音频条的播放图标是装饰，不是按钮（说了纯视觉不播放）', () => {
  /*
   * 需求明确"纯视觉，不播放"。如果做成 button，用户会以为能点，
   * 点了没反应比没有这个图标更糟。
   */
  const { mounts } = makePanel();
  const card = mounts.confirm;
  const buttons = findAll(card, (n) => n.tagName === 'BUTTON');
  const roles = buttons.map((b) => b.getAttribute('data-role'));
  // 只有确认和取消两个按钮
  assert.deepEqual(roles.sort(), ['voice-cancel', 'voice-send']);
  // 音频条整体对读屏隐藏
  assert.equal(byRole(card, 'voice-barbox')[0].getAttribute('aria-hidden'), 'true');
});

test('★ 草稿默认隐藏（没在确认态不该占消息列表）', () => {
  const { mounts } = makePanel();
  assert.equal(mounts.confirm.hidden, true);
});

test('★ 进确认态后草稿可见，且文字已包裹', async () => {
  const { mounts, doc } = makePanel({ confirmBeforeSend: true });
  await beginVoice(mounts);
  doc.fireWindow('pointerup', {});
  await flush();
  await flush();

  assert.equal(mounts.confirm.hidden, false, '确认态要显示草稿');
  const view = byRole(mounts.confirm, 'voice-textview')[0];
  // 只读态走 markdown 渲染，所以检查 innerHTML 里有内容
  assert.ok(view.innerHTML.length > 0, '文字气泡要有内容');
  assert.ok(view.innerHTML.includes('你好啊'), view.innerHTML);
});

test('★★ 点文字气泡 → 就地变可编辑（不是弹窗）', async () => {
  const { mounts, doc, panel } = makePanel({ confirmBeforeSend: true });
  await beginVoice(mounts);
  doc.fireWindow('pointerup', {});
  await flush();
  await flush();

  const view = byRole(mounts.confirm, 'voice-textview')[0];
  const editor = byRole(mounts.confirm, 'voice-draft')[0];

  assert.equal(view.hidden, false, '初始是只读态');
  assert.equal(editor.hidden, true, '编辑框初始隐藏');

  view.fire('click');

  assert.equal(view.hidden, true, '进入编辑后只读态让位');
  assert.equal(editor.hidden, false, '编辑框出现');
  assert.equal(editor.value, panel.snapshot().flow.draft, '编辑框要带当前文本');
});

test('★★ 编辑后失焦即存，确认时发的是编辑值', async () => {
  const { mounts, doc, sent } = makePanel({ confirmBeforeSend: true });
  await beginVoice(mounts);
  doc.fireWindow('pointerup', {});
  await flush();
  await flush();

  const view = byRole(mounts.confirm, 'voice-textview')[0];
  const editor = byRole(mounts.confirm, 'voice-draft')[0];

  view.fire('click');
  editor.value = '我改过的内容';
  editor.fire('blur'); // 失焦即存

  // 失焦后回到只读态，且显示的是改后的文字
  assert.equal(view.hidden, false);
  assert.ok(view.innerHTML.includes('我改过的内容'), view.innerHTML);

  byRole(mounts.confirm, 'voice-send')[0].fire('click');
  await flush();

  assert.equal(sent.length, 1);
  assert.equal(sent[0], '我改过的内容', '发出去的必须是编辑值');
});

test('★★★ 不点文字、直接点「确认」→ 发的是转写原文（不是空）', async () => {
  /*
   * 这是本次抓到的**真 bug**，不是测试挑剔：
   *
   * 「发送」原来读的是 textarea 的 value，而只读态下 textarea 是隐藏的空壳，
   * value 恒为空串 ⇒ 用户「录完 → 看了眼文字没问题 → 直接点确认」，
   * 拿到的是空 ⇒ 报「内容为空，没有发送」。屏幕上明明白白显示着转写文字。
   *
   * 这种 bug 单元测试全绿、功能验收也未必红（验收脚本往往先改个文字再点发送），
   * 只有在**"不改就确认"**这条最短路径上才炸。所以单独钉一条。
   */
  const { mounts, doc, sent, notes } = makePanel({ confirmBeforeSend: true });
  await beginVoice(mounts);
  doc.fireWindow('pointerup', {});
  await flush();
  await flush();

  // 一次都不碰文字气泡，直接点确认
  byRole(mounts.confirm, 'voice-send')[0].fire('click');
  await flush();

  assert.equal(notes.length, 0, `不该有任何提示（尤其不该是"内容为空"）：${JSON.stringify(notes)}`);
  assert.equal(sent.length, 1, '必须真的发出去');
  assert.equal(sent[0], '“你好啊”', '发的是已包裹的转写原文');
});

test('★★★ 点开文字再原样关掉，草稿不能被清空', async () => {
  /*
   * 同一颗 bug 的另一个入口：点开编辑框 → 什么都不改 → 失焦。
   * 第一版 `enterEdit` 用编辑框自己的空值当种子，于是"点一下就清空"。
   * 这条钉住"点开→失焦"这条往返不能改写草稿。
   */
  const { mounts, doc, sent, panel } = makePanel({ confirmBeforeSend: true });
  await beginVoice(mounts);
  doc.fireWindow('pointerup', {});
  await flush();
  await flush();

  const view = byRole(mounts.confirm, 'voice-textview')[0];
  const editor = byRole(mounts.confirm, 'voice-draft')[0];

  view.fire('click');
  editor.fire('blur');

  assert.equal(panel.snapshot().flow.draft, '“你好啊”', '点开又关掉，草稿必须原样');

  byRole(mounts.confirm, 'voice-send')[0].fire('click');
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0], '“你好啊”');
});

test('★★ 草稿卡出现时要通知外壳滚进视口（否则用户看不到自己说的话）', async () => {
  /*
   * 2026-10-30 录屏抓到的真缺陷：草稿卡的 DOM 完全正常 ——
   * hidden=false、文字对、宽度对、挂在 nb-msglist 里 —— 但截图里
   * **一个像素都看不到**，因为它挂在消息流末尾而列表还停在上面。
   *
   * 这类缺陷所有 DOM 断言都不会红（element 确实存在且可见），
   * 只有看图才发现。所以要把它变成一条可断言的事实：**跃迁时通知一次**。
   */
  let shown = 0;
  const { mounts, doc } = makePanel({ confirmBeforeSend: true, onDraftShown: () => { shown += 1; } });

  assert.equal(shown, 0, '还没开始录，不该通知');

  await beginVoice(mounts);
  assert.equal(shown, 0, '录音中不该通知');

  doc.fireWindow('pointerup', {});
  await flush();
  await flush();

  assert.equal(shown, 1, '进入确认态必须通知一次');
});

test('★★ 通知按「跃迁」发，不是按「当前是确认态」发', async () => {
  /*
   * `syncAll` 每次状态变化都会跑；如果按"当前是 confirming"发通知，
   * 那么确认态里任何一次状态刷新都会把列表拽回底部 ——
   * 用户想往上翻历史会被一直弹回来，而且**看起来像是"列表自己乱跳"**。
   *
   * 这里用 `updateConfig` 制造"确认态里的又一次 syncAll"来钉这个语义：
   * 它确实会调 syncAll（改配置要重画界面），但状态没跃迁，不该再通知。
   *
   * 第一版这条写的是"再 fire 一次 pointerup" —— 那是**假触发**：
   * onPointerUp 开头就有 `if (stage !== 'recording') return`，
   * 根本没走到 syncAll。于是变异测试（把 `if (justShown)` 去掉）
   * 居然还是绿的。判据必须真的触达被测代码，否则等于没验。
   */
  let shown = 0;
  const { mounts, doc, panel } = makePanel({ confirmBeforeSend: true, onDraftShown: () => { shown += 1; } });

  await beginVoice(mounts);
  doc.fireWindow('pointerup', {});
  await flush();
  await flush();
  assert.equal(shown, 1);
  assert.equal(panel.snapshot().flow.stage, 'confirming');

  // 确认态里的又一次 syncAll（改配置会重画）
  panel.updateConfig({ confirmBeforeSend: true });
  assert.equal(panel.snapshot().flow.stage, 'confirming', '仍在确认态');
  assert.equal(shown, 1, '仍在同一个确认态里，不该重复通知');
});

test('★ 编辑框的键盘可达性：文字气泡可聚焦', () => {
  const { mounts } = makePanel();
  const view = byRole(mounts.confirm, 'voice-textview')[0];
  assert.equal(view.getAttribute('role'), 'button');
  assert.equal(view.getAttribute('tabindex'), '0', '要能被键盘 tab 到');
});

test('★ 音频条宽度通过 CSS 变量传（不在 CSS 里写死像素）', async () => {
  /*
   * 宽度是**时长算出来的**，而时长是数据 —— CSS 拿不到。
   * 所以用 `--nb-voice-bar-width` 从 JS 传进去，算法在纯逻辑里（有单测）。
   */
  const { mounts, doc } = makePanel({ confirmBeforeSend: true });
  await beginVoice(mounts);
  doc.fireWindow('pointerup', {});
  await flush();
  await flush();

  const barbox = byRole(mounts.confirm, 'voice-barbox')[0];
  const style = barbox.getAttribute('style') ?? '';
  assert.ok(style.includes('--nb-voice-bar-width'), `应当设置宽度变量：${style}`);
});
