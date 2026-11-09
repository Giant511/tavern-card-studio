/**
 * 聊天页 UI 的 DOM 断言（v0.1.7 / T15.5）。
 *
 * ## 为什么不引 jsdom / happy-dom
 *
 * 项目至今 **零 DOM 测试依赖**。为一个页面的结构断言装一整套 DOM 实现，
 * 代价（依赖面 + 与真实浏览器仍不一致）大于收益。
 *
 * 做法：`chat-view.ts` 只依赖一个 **30 行的 `ElLike` 接口**，
 * 测试里实现一个同样小的 stub。断言的是**真实渲染出来的树**，
 * 不是源码字符串 —— 这一点比我原来想读源码做正则要硬得多：
 * 读源码只能证明"代码里写了这个 id"，stub 能证明"跑起来确实生成了这个元素"。
 *
 * ## 这一组守的是什么
 *
 * 1. **T15.6 三个挂载点真的存在且 id 对**（语音接入的接口契约）
 * 2. 气泡结构与消息角色对应
 * 3. 语音徽标只在 `extra.tcs.voice === true` 时出现
 * 4. 候选指示只在多候选时出现
 * 5. 呼吸点只在生成中出现
 * 6. 空状态不许出现"暂无数据"
 * 7. 渲染出的 HTML 里**没有裸 `<script`**（XSS 在 UI 层的最后一道）
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setVoiceFlag, voiceDurationMs } from '@tcs/shared';

import { VOICE_MOUNTS, renderEmptyState, renderMessage, renderMessageList, renderVoiceMounts } from '../client/src/chat/chat-view.ts';

/* ═══════════════════════════════════════════════════════════
   极简 DOM stub（只实现 chat-view.ts 用到的那点能力）
   ═══════════════════════════════════════════════════════════ */

function makeDoc() {
  const createElement = (tag) => {
    const attributes = new Map();
    const node = {
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      innerHTML: '',
      hidden: false,
      dataset: {},
      children: [],
      listeners: {},
      append(...nodes) {
        for (const one of nodes) {
          if (typeof one === 'string') {
            // 真实 DOM 会包成文本节点；这里用一个最小对象等价表示
            this.children.push({ textContent: one, children: [], isText: true });
          } else {
            this.children.push(one);
          }
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
    };
    return node;
  };

  return {
    createElement,
    createTextNode: (text) => ({ textContent: text, children: [], isText: true }),
  };
}

/** 在树里按条件找所有元素 */
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

function findById(root, id) {
  return findAll(root, (node) => node.getAttribute('id') === id)[0];
}

function findByRole(root, role) {
  return findAll(root, (node) => node.getAttribute('data-role') === role);
}

/* ═══════════════════════════════════════════════════════════
   一、T15.6 三个挂载点（本期最重要的接口契约）
   ═══════════════════════════════════════════════════════════ */

test('★ 语音挂载点的 id 常量就是这几个（语音接入的唯一真相）', () => {
  /*
   * 2026-10-30 用户把交互改成两级（点小图标进语音态 → 按住大圆说话），
   * 于是挂载点从三个变成五个。
   *
   * 这里逐个钉住字面值而不是只验"数量对"：id 是**跨模块契约**
   * （T15.5 承诺给 T15.6 的接口），改了就等于单方面毁约。
   */
  assert.equal(VOICE_MOUNTS.mic, 'nb-voice-mic');
  assert.equal(VOICE_MOUNTS.stage, 'nb-voice-stage');
  assert.equal(VOICE_MOUNTS.bigmic, 'nb-voice-bigmic');
  assert.equal(VOICE_MOUNTS.chips, 'nb-voice-chips');
  assert.equal(VOICE_MOUNTS.confirm, 'nb-voice-confirm');

  // id 不许重复 —— 重复会让 getElementById 命中错的那个
  const values = Object.values(VOICE_MOUNTS);
  assert.equal(new Set(values).size, values.length, '挂载点 id 有重复');
});

test('★ 占位渲染出的挂载点都带 id 与可定位标记', () => {
  /*
   * `renderVoiceMounts` 是 T15.5 的**占位实现**，只造 mic / chips / confirm
   * 三个含 id 的容器；`stage` 与 `bigmic` 由 `VoicePanel.render()` 造
   * （它们是语音态里的东西，占位阶段还不存在）。
   *
   * 所以这里只校验"它造出来的那些" —— 拿 VOICE_MOUNTS 全量去比会假红。
   * 五个挂载点齐全这件事由 `test/voice-wiring.test.mjs` 验（真面板）。
   */
  const doc = makeDoc();
  const mounts = renderVoiceMounts(doc);

  for (const [key, node] of Object.entries(mounts)) {
    const expectedId = VOICE_MOUNTS[key];
    assert.ok(expectedId !== undefined, `${key} 不是合法的挂载点名`);
    assert.equal(node.getAttribute('id'), expectedId, `${key} 的 id 不对`);
    assert.equal(
      node.getAttribute('data-tcs-voice-mount'),
      key,
      `${key} 缺少 data-tcs-voice-mount（定位靠它）`,
    );
  }

  // 占位阶段不造 stage/bigmic，明确写出来，避免以后有人以为漏了
  assert.equal('stage' in mounts, false, '占位不造 stage（它属于语音态）');
  assert.equal('bigmic' in mounts, false, '占位不造 bigmic（它属于语音态）');
});

test('★ 未接入时两个浮层是隐藏的（不许挡住输入区）', () => {
  const doc = makeDoc();
  const mounts = renderVoiceMounts(doc);
  assert.equal(mounts.chips.hidden, true, 'chips 浮层默认必须隐藏');
  assert.equal(mounts.confirm.hidden, true, '待确认条默认必须隐藏');
  assert.equal(mounts.mic.hidden, false, '麦克风位应当可见（置灰形态）');
});

test('挂载点的样式类与 T15.6 规格一致（尺寸/位置来自 CSS）', () => {
  const doc = makeDoc();
  const mounts = renderVoiceMounts(doc);
  assert.equal(mounts.mic.className, 'nb-mic-slot');
  assert.equal(mounts.chips.className, 'nb-voice-chips-slot');
  assert.equal(mounts.confirm.className, 'nb-voice-confirm-slot');
});

test('麦克风位在未配置时是"置灰"语义（不是无响应）', () => {
  const doc = makeDoc();
  const mounts = renderVoiceMounts(doc);
  // 设计册 §7.2：未配置 ASR 时麦克风置灰，点击弹引导 —— 不是静默无响应
  assert.equal(mounts.mic.getAttribute('aria-hidden'), 'true');
  // 本期还没有点击引导（T15.6 才接），但要能看出它是占位
  assert.ok(mounts.mic.textContent.length > 0, '占位也应有可见内容，不能是空白盒子');
});

/* ═══════════════════════════════════════════════════════════
   二、消息渲染
   ═══════════════════════════════════════════════════════════ */

test('角色消息与用户消息的类名对应（气泡朝向）', () => {
  const doc = makeDoc();
  const char = renderMessage(doc, { name: '西奥', is_user: false, mes: '你好' });
  const user = renderMessage(doc, { name: '我', is_user: true, mes: '你也好' });

  assert.ok(char.className.includes('nb-msg--char'), char.className);
  assert.ok(user.className.includes('nb-msg--user'), user.className);
  assert.equal(char.getAttribute('data-role'), 'char');
  assert.equal(user.getAttribute('data-role'), 'user');
});

test('★ 气泡正文走 markdown 渲染（粗体变成 <strong>）', () => {
  const doc = makeDoc();
  const node = renderMessage(doc, { name: '西奥', is_user: false, mes: '**重要**的话' });
  const bubble = findByRole(node, 'char')[0];
  const inner = findAll(bubble, (n) => n.className === 'nb-bubble')[0];
  assert.ok(inner.innerHTML.includes('<strong>重要</strong>'), inner.innerHTML);
});

test('★ 渲染出的气泡里不许有裸 script（XSS 在 UI 层收口）', () => {
  const doc = makeDoc();
  const node = renderMessage(doc, {
    name: '西奥',
    is_user: false,
    mes: '<script>alert(1)</script>**粗**',
  });
  const bubble = findAll(node, (n) => n.className === 'nb-bubble')[0];
  assert.equal(bubble.innerHTML.includes('<script'), false, bubble.innerHTML);
  assert.ok(bubble.innerHTML.includes('<strong>粗</strong>'), '正常标记仍要生效');
});

test('宏替换生效（角色名进了正文）', () => {
  const doc = makeDoc();
  const node = renderMessage(
    doc,
    { name: '西奥', is_user: false, mes: '{{char}} 笑了' },
    { charName: '西奥' },
  );
  const bubble = findAll(node, (n) => n.className === 'nb-bubble')[0];
  assert.ok(bubble.innerHTML.includes('西奥 笑了'), bubble.innerHTML);
});

test('★ 语音消息：音频条在上、识别文字在下（2026-10-31 用户要求）', () => {
  /*
   * 用户原话：「语音气泡下是识别出来的文字」。
   *
   * 所以判据不只是"有没有那条音频条"，还必须钉住**顺序** ——
   * 音频条排在文字气泡**之前**。只断言"都存在"的话，实现成
   * "文字在上、音频条在下"也会通过，而那就不是用户要的形态了。
   */
  const doc = makeDoc();
  const plain = renderMessage(doc, { name: '我', is_user: true, mes: '普通' });
  assert.equal(findByRole(plain, 'voice-bubble').length, 0, '非语音消息不许有音频条');

  const voiced = renderMessage(doc, {
    name: '我',
    is_user: true,
    mes: '“语音”',
    extra: { tcs: { voice: true } },
  });
  const bars = findByRole(voiced, 'voice-bubble');
  assert.equal(bars.length, 1, '语音消息必须有且只有一条音频条');

  /*
   * 顺序：音频条必须在文字气泡之前。
   * 取两者在树里的出现顺序（findAll 是深度优先先序，所以下标即文档序）。
   */
  const all = [];
  const walk = (node) => {
    all.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(voiced);
  const barIndex = all.indexOf(bars[0]);
  const bubbleIndex = all.findIndex((n) => n.className === 'nb-bubble');
  assert.ok(barIndex >= 0 && bubbleIndex >= 0);
  assert.ok(barIndex < bubbleIndex, '音频条必须排在文字气泡之前（"语音气泡下是识别文字"）');

  // 语义不能丢：读屏要知道这是语音（徽标删了，语义挪到这里）
  assert.ok(
    (bars[0].getAttribute('aria-label') ?? '').includes('语音'),
    `音频条要带 aria-label 说明这是语音：${bars[0].getAttribute('aria-label')}`,
  );
  assert.equal(bars[0].getAttribute('role'), 'img', '整条音频条对读屏是一个整体符号');
});

test('★★ 音频条里的 ▶ 不是按钮（消息里没有音频数据，不暗示可播放）', () => {
  /*
   * 消息模型里只有转写文字，没有音频文件 —— 这条音频条不可播放。
   * 如果 ▶ 做成 button，用户会点，点了没反应，比没有这个图标更糟。
   */
  const doc = makeDoc();
  const voiced = renderMessage(doc, {
    name: '我',
    is_user: true,
    mes: '“语音”',
    extra: { tcs: { voice: true } },
  });
  const buttons = findAll(voiced, (n) => n.tagName === 'BUTTON');
  assert.equal(buttons.length, 0, '语音消息里不该有任何按钮（音频条纯视觉）');

  const play = findAll(voiced, (n) => n.className === 'nb-voice-bubble-play')[0];
  assert.ok(play !== undefined, '缺播放图标');
  assert.equal(play.tagName, 'SPAN', '▶ 必须是 span，不能是可点的 button');
});

test('★ 语音消息的时长：有时长就显示，没时长不显示 0"', () => {
  const doc = makeDoc();

  const withDur = renderMessage(doc, {
    name: '我',
    is_user: true,
    mes: '“语音”',
    extra: { tcs: { voice: true, voiceMs: 3200 } },
  });
  const dur = findAll(withDur, (n) => n.className === 'nb-voice-bubble-dur')[0];
  assert.ok(dur !== undefined, '有时长就该显示');
  // 3.2 秒 → 3"（向下取整会让 3.2 显示成 3；Math.round 也是 3）
  assert.equal(dur.textContent, '3"', `时长文案不对：${dur.textContent}`);

  /*
   * 历史消息没有 voiceMs（这个字段是 2026-10-31 才加的）。
   * 此时**不显示时长元素**，而不是显示 `0"` / `NaN"` / `undefined"`。
   */
  const noDur = renderMessage(doc, {
    name: '我',
    is_user: true,
    mes: '“语音”',
    extra: { tcs: { voice: true } },
  });
  assert.equal(
    findAll(noDur, (n) => n.className === 'nb-voice-bubble-dur').length,
    0,
    '拿不到时长就不显示，不要显示 0"',
  );
  // 音频条本身还在 —— "这是语音"这个事实是确定的，时长只是补强
  assert.equal(findByRole(noDur, 'voice-bubble').length, 1);
});

test('★ 时长进 extra.tcs.voiceMs，且不影响 extra.tcs.voice 的判据', () => {
  /*
   * 为什么是平级新键而不是把 `voice` 改成对象：
   * `voice === true` 这个判据已经写进了 `isVoiceMsg`、写进了测试、
   * 也写进了**已经存在的聊天记录**。改成对象会让所有老消息变成"不是语音"。
   */
  const base = { name: '我', is_user: true, mes: 'x' };

  const withDur = setVoiceFlag(base, true, 3200);
  assert.equal(withDur.extra.tcs.voice, true, 'voice 仍是布尔 true（不许改成对象）');
  assert.equal(withDur.extra.tcs.voiceMs, 3200);
  assert.equal(voiceDurationMs(withDur), 3200);

  // 不带时长：不写这个键
  const noDur = setVoiceFlag(base, true);
  assert.equal('voiceMs' in noDur.extra.tcs, false, '拿不到时长就不写 voiceMs');
  assert.equal(voiceDurationMs(noDur), null);

  // 0 / 负数 / NaN 都不写 —— 0 毫秒的录音不存在，写进去只会显示 0"
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const one = setVoiceFlag(base, true, bad);
    assert.equal('voiceMs' in one.extra.tcs, false, `${bad} 不该被写进 voiceMs`);
  }

  // 取消语音标记时，时长必须一起清（否则留下"不是语音但有语音时长"）
  const cleared = setVoiceFlag(withDur, false);
  assert.equal(cleared.extra, undefined, 'extra 应当整体清空');
});

test('★ 候选指示只在多候选时出现（1/1 是噪音）', () => {
  const doc = makeDoc();
  const single = renderMessage(doc, { name: '西奥', is_user: false, mes: '单条' });
  assert.equal(findByRole(single, 'swipe-indicator').length, 0);

  const multi = renderMessage(doc, {
    name: '西奥',
    is_user: false,
    mes: 'B',
    swipes: ['A', 'B', 'C'],
    swipe_id: 1,
  });
  const indicator = findByRole(multi, 'swipe-indicator');
  assert.equal(indicator.length, 1);
  assert.equal(indicator[0].textContent, '2 / 3', '下标要显示成 1-based');
});

test('★ 呼吸点只在生成中那条出现', () => {
  const doc = makeDoc();
  const messages = [
    { name: '我', is_user: true, mes: '问' },
    { name: '西奥', is_user: false, mes: '答到一半' },
  ];

  const idle = renderMessageList(doc, messages);
  const breathingIdle = findAll(idle, (n) => n.className.includes('nb-breathing'));
  assert.equal(breathingIdle.length, 0, '不生成时不该有呼吸点');

  const streaming = renderMessageList(doc, messages, { streamingIndex: 1 });
  const breathing = findAll(streaming, (n) => n.className.includes('nb-breathing'));
  assert.equal(breathing.length, 1, '生成中应当恰好一个呼吸点');

  // 呼吸点必须在**那条**消息里，不是第一条
  const items = findByRole(streaming, 'msglist')[0].children;
  const firstHas = findAll(items[0], (n) => n.className.includes('nb-breathing')).length;
  const secondHas = findAll(items[1], (n) => n.className.includes('nb-breathing')).length;
  assert.equal(firstHas, 0);
  assert.equal(secondHas, 1);
});

test('消息列表按顺序渲染，条数一致', () => {
  const doc = makeDoc();
  const messages = [
    { name: '我', is_user: true, mes: 'a' },
    { name: '西奥', is_user: false, mes: 'b' },
    { name: '我', is_user: true, mes: 'c' },
  ];
  const list = renderMessageList(doc, messages);
  const items = findByRole(list, 'msglist')[0].children;
  assert.equal(items.length, 3);
  assert.equal(items[0].getAttribute('data-role'), 'user');
  assert.equal(items[1].getAttribute('data-role'), 'char');
  assert.equal(items[2].getAttribute('data-role'), 'user');
});

test('时间戳格式化成 HH:MM；坏值不显示', () => {
  const doc = makeDoc();
  const good = renderMessage(doc, {
    name: '西奥',
    is_user: false,
    mes: 'x',
    send_date: '2026-10-30T09:05:00.000Z',
  });
  const meta = findAll(good, (n) => n.className === 'nb-msg-meta')[0];
  assert.ok(meta.children.some((c) => /^\d{2}:\d{2}$/.test(c.textContent ?? '')), '应有 HH:MM');

  const bad = renderMessage(doc, { name: '西奥', is_user: false, mes: 'x', send_date: '不是时间' });
  const badMeta = findAll(bad, (n) => n.className === 'nb-msg-meta');
  // 坏时间应当整条 meta 都不出现（或至少没有 Invalid Date 字样）
  const allText = JSON.stringify(badMeta.map((m) => m.children.map((c) => c.textContent)));
  assert.equal(allText.includes('Invalid'), false, allText);
});

/* ═══════════════════════════════════════════════════════════
   三、空状态（设计册 §7.3）
   ═══════════════════════════════════════════════════════════ */

test('★ 空状态不许出现"暂无数据"（要说人话 + 给下一步）', () => {
  const doc = makeDoc();
  const node = renderEmptyState(doc, {
    halo: '💬',
    title: '还没有对话',
    text: '说第一句话吧 —— 角色会接着回答。',
    actions: [{ label: '选择角色', primary: true }],
  });

  const text = JSON.stringify(
    findAll(node, () => true).map((n) => n.textContent),
  );
  assert.equal(text.includes('暂无数据'), false, `不许用"暂无数据"：${text}`);
  assert.ok(text.includes('还没有对话'), '要有具体的说明');
  assert.ok(text.includes('选择角色'), '要有明确的下一步动作');
});

test('空状态的主行动按钮带 primary 样式', () => {
  const doc = makeDoc();
  const node = renderEmptyState(doc, {
    halo: 'x',
    title: 't',
    text: 'y',
    actions: [{ label: '主', primary: true }, { label: '次' }],
  });
  const buttons = findAll(node, (n) => n.tagName === 'BUTTON');
  assert.equal(buttons.length, 2);
  assert.ok(buttons[0].className.includes('nb-btn--primary'), buttons[0].className);
  assert.equal(buttons[1].className.includes('nb-btn--primary'), false);
});

test('空状态的插画对读屏隐藏（纯装饰）', () => {
  const doc = makeDoc();
  const node = renderEmptyState(doc, { halo: '💬', title: 't', text: 'y', actions: [] });
  const halo = findAll(node, (n) => n.className === 'nb-empty-halo')[0];
  assert.equal(halo.getAttribute('aria-hidden'), 'true');
});

/* ═══════════════════════════════════════════════════════════
   四、流式期间也必须走 markdown 渲染
   ═══════════════════════════════════════════════════════════ */

test('★ 流式正文要渲染标记，不能用纯文本（否则中途显示一堆星号）', () => {
  /*
   * 这条是截图看出来的：demo 里流式阶段用 `textContent` 写入，
   * 录屏里 `*声音低了半度*` 的星号原样显示，直到生成结束才变成斜体。
   *
   * 真实面板同理 —— 用户会先看到一秒的裸标记。
   * 判据：流式与结束后的渲染**必须走同一个函数**（`renderMessageHtml`）。
   */
  const doc = makeDoc();
  const node = renderMessage(doc, { name: '西奥', is_user: false, mes: '*低声*说' });
  const bubble = findAll(node, (n) => n.className === 'nb-bubble')[0];
  assert.equal(bubble.innerHTML.includes('<em>低声</em>'), true, bubble.innerHTML);
  assert.equal(bubble.innerHTML.includes('*'), false, `不许残留星号：${bubble.innerHTML}`);
});
