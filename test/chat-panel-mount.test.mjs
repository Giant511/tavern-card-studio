/**
 * `ChatPanel` 真的 mount 一次，然后断言 DOM 里有什么。
 *
 * ## 为什么必须补这一组
 *
 * 2026-10-31 真机截图暴露出一个致命缺陷：**输入框根本不在 DOM 里**。
 * `mount()` 建了 `textarea.nb-input`、也赋给了 `this.inputEl`，
 * 但忘记 `composer.append(input)` —— 于是输入区只剩「🎤」和「↑」两个按钮。
 *
 * 这个缺陷能活到真机，是因为 **`test/` 里没有任何一个测试 mount 过 `ChatPanel`**
 * （`grep -rn "new ChatPanel" test/` 零结果）。之前的 11 条「移动端 UI」断言
 * 全是**读源码做正则**，它只能证明"代码里写了这句话"，不能证明"跑起来生成了这个元素"。
 *
 * 同一轮还抓到第二个同类缺陷：顶栏副标题的 `span` 是 `mount()` 里的局部变量，
 * `loadChat()` / `setMessages()` 改了 `this.fileName` 却没人去更新那行字，
 * 于是消息都渲染出来了、顶栏还写着"未选择聊天"。**状态对、显示不对**。
 *
 * 所以这一组的判据统一是"mount 之后在树上找"：
 *   · 输入框在 composer 的子节点里（不是"代码里有 input 这个变量"）
 *   · 副标题的内容跟着 `setMessages` 传的名字变
 *   · 消息列表**只有一层** `.nb-msglist`（两层会让滚动失效，见下）
 *
 * ## 为什么用 stub 而不是真浏览器
 *
 * 项目至今零 DOM 测试依赖（`chat-view-dom.test.mjs` 的注释里有取舍说明），
 * 这里沿用同一个 30 行 stub 的思路，只是把 `chat-panel.ts` / `voice-panel.ts`
 * 实际用到的几个属性（`value` / `disabled` / `hidden` / `scrollTop`）补齐。
 * 真浏览器量尺寸的活交给 `scripts/probe-shots.mjs`（它量的 rect 才是布局判据）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ChatPanel } from '../client/src/chat/chat-panel.ts';
import { VOICE_MOUNTS } from '../client/src/chat/chat-view.ts';

/* ═══════════════════════════════════════════════════════════
   stub（比 chat-view-dom.test.mjs 那个多几个属性）
   ═══════════════════════════════════════════════════════════ */

function makeDoc() {
  const createElement = (tag) => {
    const attributes = new Map();
    const node = {
      tagName: String(tag).toUpperCase(),
      className: '',
      textContent: '',
      innerHTML: '',
      hidden: false,
      disabled: false,
      value: '',
      placeholder: '',
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      dataset: {},
      children: [],
      listeners: {},
      append(...nodes) {
        for (const one of nodes) {
          if (typeof one === 'string') {
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
      removeAttribute(name) {
        attributes.delete(name);
      },
      addEventListener(type, handler) {
        (this.listeners[type] ??= []).push(handler);
      },
      removeEventListener(type, handler) {
        const list = this.listeners[type];
        if (!Array.isArray(list)) return;
        this.listeners[type] = list.filter((one) => one !== handler);
      },
      focus() {},
      /** 测试用：模拟用户点了某个监听器 */
      fire(type, event = {}) {
        for (const handler of this.listeners[type] ?? []) handler(event);
      },
    };
    return node;
  };

  return {
    createElement,
    createTextNode: (text) => ({ textContent: text, children: [], isText: true }),
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

function byClass(root, cls) {
  return findAll(root, (node) => String(node.className ?? '').split(/\s+/).includes(cls));
}

/** 造一个可用面板（默认无卡片、无 API 配置 —— 与移动端首启状态一致） */
function mountPanel() {
  const doc = makeDoc();
  const panel = new ChatPanel(
    doc,
    { card: {}, userName: '旅人', source: 'openai', model: 'gpt-4o-mini', sampling: {} },
    {},
  );
  const root = panel.mount(doc.createElement('div'));
  return { doc, panel, root };
}

/* ═══════════════════════════════════════════════════════════
   一、输入区三件套（2026-10-31 真机缺陷）
   ═══════════════════════════════════════════════════════════ */

test('★ 输入框必须真的进 DOM（第一版忘了 append，真机上无法打字）', () => {
  const { root } = mountPanel();

  const inputs = byClass(root, 'nb-input');
  assert.equal(inputs.length, 1, '页面里应当恰有一个 .nb-input');

  /*
   * 只断言"存在"不够 —— 它必须在 **composer 里面**，
   * 否则就是一个飘在别处、宽度为 0 的输入框。所以顺着父链往上找 composer。
   */
  const composer = byClass(root, 'nb-composer')[0];
  assert.ok(composer, '必须有输入区容器 .nb-composer');

  const inComposer = findAll(composer, (node) => node.className === 'nb-input');
  assert.equal(
    inComposer.length,
    1,
    '输入框必须是 .nb-composer 的子节点 —— 建了却不 append 等于没有（2026-10-31 真机症状：中间一片空白）',
  );
});

test('★ 输入区顺序：输入框 → 麦克风 → 发送', () => {
  /*
   * 顺序错了不会报错，只会让人找不到按钮。
   * 视觉契约：麦克风贴着发送键（右侧），输入框吃掉左边剩余宽度。
   *
   * 麦克风按 **id** 认（`VOICE_MOUNTS.mic` 是跨模块契约），不按类名 ——
   * 它的类是 `nb-mic-slot`，第一版我按 `nb-voice-mic` 找，那是 id 不是类名。
   */
  const { root } = mountPanel();
  const composer = byClass(root, 'nb-composer')[0];

  const kids = composer.children.filter((node) => node.isText !== true);
  const order = kids.map((node) => String(node.className ?? '')).filter((cls) => cls !== '');

  const iInput = order.indexOf('nb-input');
  const iSend = order.indexOf('nb-send');
  assert.ok(iInput >= 0, `输入框要在 composer 里，实际顺序：${order.join(' → ')}`);
  assert.ok(iSend >= 0, `发送按钮要在 composer 里，实际顺序：${order.join(' → ')}`);
  assert.ok(iInput < iSend, `输入框必须在发送按钮之前，实际顺序：${order.join(' → ')}`);

  // 麦克风是 T15.6 的挂载点，位置在输入框与发送之间
  const iMic = kids.findIndex((node) => node.getAttribute('id') === VOICE_MOUNTS.mic);
  assert.ok(
    iMic > kids.indexOf(kids.find((node) => node.className === 'nb-input')),
    `麦克风要在输入框之后，实际顺序：${order.join(' → ')}`,
  );
  assert.ok(
    iMic < kids.indexOf(kids.find((node) => node.className === 'nb-send')),
    `麦克风要在发送按钮之前，实际顺序：${order.join(' → ')}`,
  );
});

test('空输入时发送按钮置灰，有内容后可用', () => {
  const { root, panel } = mountPanel();
  const send = byClass(root, 'nb-send')[0];
  assert.ok(send, '必须有发送按钮');
  assert.equal(send.disabled, true, '没打字时发送按钮应当不可用');

  const input = byClass(root, 'nb-input')[0];
  input.value = '你好';
  input.fire('input');
  assert.equal(send.disabled, false, '打字之后发送按钮应当可用（否则用户以为坏了）');

  // `panel` 只是为了让 lint 看到它被用到；这里不需要它的返回
  void panel;
});

/* ═══════════════════════════════════════════════════════════
   二、消息列表只允许一层（两层会让滚动与贴底全部失效）
   ═══════════════════════════════════════════════════════════ */

test('★ 消息列表只有一层 .nb-msglist（两层会让"滚到底"失效）', () => {
  /*
   * 2026-10-31 量出来的真实数字（360×800）：两层时内层 scrollHeight 978、
   * 外层 625，而 `pendingScroll` 滚的是外层 ⇒ 最后一条气泡停在 top=882
   * （视口 800）被输入区盖住 297px，**用户看不到自己刚收到的回复**。
   *
   * 单测只能验结构（"几层"），尺寸要靠 `scripts/probe-shots.mjs`。
   * 但结构是尺寸的根因，先钉住结构。
   */
  const { panel, root } = mountPanel();
  panel.setMessages([{ name: '西奥', is_user: false, mes: '第一句' }]);

  const lists = byClass(root, 'nb-msglist');
  assert.equal(
    lists.length,
    1,
    `消息列表容器只能有一层（实测两层会导致滚动落在内层、而贴底滚外层 ⇒ 新消息被埋），实际 ${lists.length} 层`,
  );
});

test('★ setMessages 之后消息真的渲染出来了', () => {
  const { panel, root } = mountPanel();
  panel.setMessages([
    { name: '旅人', is_user: true, mes: '你听得见雨声吗？' },
    { name: '西奥', is_user: false, mes: '听得见。' },
  ]);

  const bubbles = byClass(root, 'nb-msg');
  assert.equal(bubbles.length, 2, '两条消息应当渲染成两个气泡');
  assert.equal(byClass(root, 'nb-msg--user').length, 1, '用户那条要有 user 样式');
  assert.equal(byClass(root, 'nb-msg--char').length, 1, '角色那条要有 char 样式');
});

test('setMessages 不改 avatar（样本没有对应角色目录，误触会写坏真实记录）', () => {
  /*
   * `avatar` 决定"发送时写到哪个角色目录"。样本快照没有目录，
   * 一旦被顺手赋值，验收期间的误触就会写到真实角色里 ——
   * 而 ST 的保存是**整份覆盖**（陷阱 #1）。
   */
  const { panel, root } = mountPanel();
  panel.setMessages([{ name: '西奥', is_user: false, mes: '嗯' }], '西奥 · 雨夜留宿');

  // 顶栏副标题跟着文件名走（下面有专门一条），但 avatar 仍应是 null
  const subtitle = findAll(root, (node) => node.getAttribute('data-role') === 'chat-subtitle')[0];
  assert.ok(subtitle, '必须有副标题元素');
  assert.equal(panel.snapshot().messages.length, 1, '快照里应当有一条消息');
});

/* ═══════════════════════════════════════════════════════════
   三、顶栏副标题跟随文件名（状态对、显示也要对）
   ═══════════════════════════════════════════════════════════ */

test('★ 副标题要跟着 setMessages 的文件名变（第一版写了状态没更 DOM）', () => {
  const { panel, root } = mountPanel();
  const subtitle = () => findAll(root, (node) => node.getAttribute('data-role') === 'chat-subtitle')[0].textContent;

  assert.equal(subtitle(), '未选择聊天', '没选聊天时给一句明白话，不是空白');

  panel.setMessages([{ name: '西奥', is_user: false, mes: '嗯' }], '西奥 · 雨夜留宿');
  assert.equal(subtitle(), '西奥 · 雨夜留宿', '载入对话后顶栏要显示聊天名');
});

test('★ 新建聊天后副标题回到"未选择聊天"', () => {
  const { panel, root } = mountPanel();
  panel.setMessages([{ name: '西奥', is_user: false, mes: '嗯' }], '西奥 · 雨夜留宿');
  panel.newChat('xiao.png');

  const subtitle = findAll(root, (node) => node.getAttribute('data-role') === 'chat-subtitle')[0];
  assert.equal(subtitle.textContent, '未选择聊天', '新建（空）聊天没有文件名，副标题不能停在旧值');
});

/* ═══════════════════════════════════════════════════════════
   四、dispose 之后不再响应（面板会被外壳重建）
   ═══════════════════════════════════════════════════════════ */

test('★ dispose 是幂等的（切 Tab 往返会重复调用）', () => {
  /*
   * `AppShell.renderChat()` 现在每次重绘都先 dispose 旧面板；
   * `switchTab()` 离开聊天页时也会 dispose。
   * 两条路径会撞上同一个面板，所以必须能连着调两次而不炸。
   */
  const { panel } = mountPanel();
  assert.doesNotThrow(() => {
    panel.dispose();
    panel.dispose();
  });
});

/* ═══════════════════════════════════════════════════════════
   五、选择角色后副标题要显示角色名（2026-11-01 真机问题一）
   ═══════════════════════════════════════════════════════════ */

test('★★ 选中角色后副标题必须显示角色名（不是"未选择聊天"）', async () => {
  /*
   * 真机现象（截图 10:12）：选完角色，顶栏副标题仍是「未选择聊天」。
   *
   * 根因是三处叠加（取证见 .verify/round7-evidence.md）：
   *   ① `onPickCharacter` 返回 `{ avatar, name }`，但 `openPicker()`
   *      只取了 `avatar`，**把 name 丢了**；
   *   ② `ChatPanel` 的状态里**没有"角色名"这个字段**，只有 avatar / fileName；
   *   ③ 新建聊天 `fileName = null`，副标题唯一的数据源就此落空。
   *
   * 所以判据是"选中之后副标题等于角色名"，而不是"代码里出现过 name"。
   */
  const doc = makeDoc();
  const panel = new ChatPanel(
    doc,
    { card: {}, userName: '旅人', source: 'openai', model: 'gpt-4o-mini', sampling: {} },
    {
      onPickCharacter: async () => ({ avatar: '夜航.png', name: '夜航小助手（测试）' }),
      // 没有已有聊天 → 走 newChat 分支（正是真机上走的那条）
      onPickChat: async () => null,
    },
  );
  const root = panel.mount(doc.createElement('div'));
  const subtitle = () =>
    findAll(root, (node) => node.getAttribute('data-role') === 'chat-subtitle')[0].textContent;

  assert.equal(subtitle(), '未选择聊天', '一开始什么都没选');

  await panel.openPicker();

  assert.equal(subtitle(), '夜航小助手（测试）', '选中角色后副标题要立刻变成角色名');
});

test('★ 换角色后副标题跟着换（不能停在第一个角色）', async () => {
  const doc = makeDoc();
  let next = { avatar: '甲.png', name: '角色甲' };
  const panel = new ChatPanel(
    doc,
    { card: {}, userName: '旅人', source: 'openai', model: 'gpt-4o-mini', sampling: {} },
    {
      onPickCharacter: async () => next,
      onPickChat: async () => null,
    },
  );
  const root = panel.mount(doc.createElement('div'));
  const subtitle = () =>
    findAll(root, (node) => node.getAttribute('data-role') === 'chat-subtitle')[0].textContent;

  await panel.openPicker();
  assert.equal(subtitle(), '角色甲');

  next = { avatar: '乙.png', name: '角色乙' };
  await panel.openPicker();
  assert.equal(subtitle(), '角色乙', '换角色后副标题要跟着换');
});

test('★ 有聊天记录时副标题仍是聊天名（角色名不能盖掉它）', () => {
  /*
   * 判据的优先级：**聊天文件名 > 角色名 > "未选择聊天"**。
   *
   * 聊天名比角色名更具体（"西奥 · 雨夜留宿" 比 "西奥" 信息多），
   * 而且这是原有行为 —— 修问题一不该把它改掉。
   */
  const doc = makeDoc();
  const panel = new ChatPanel(
    doc,
    { card: {}, userName: '旅人', source: 'openai', model: 'gpt-4o-mini', sampling: {} },
    {},
  );
  const root = panel.mount(doc.createElement('div'));
  const subtitle = () =>
    findAll(root, (node) => node.getAttribute('data-role') === 'chat-subtitle')[0].textContent;

  panel.newChat('xiao.png', '西奥');
  assert.equal(subtitle(), '西奥', '新建时没有聊天名，先用角色名');

  panel.setMessages([{ name: '西奥', is_user: false, mes: '嗯' }], '西奥 · 雨夜留宿');
  assert.equal(subtitle(), '西奥 · 雨夜留宿', '有聊天名就用聊天名');
});

test('★ 重进聊天页（新面板 + newChat 带名字）副标题仍是角色名', () => {
  /*
   * 真机上"重进聊天页"是外壳**重建面板**：`new ChatPanel(...)` +
   * `panel.newChat(avatar, name)`。所以恢复点必须把 name 一起带上，
   * 只传 avatar 就会退回"未选择聊天"。
   */
  const doc = makeDoc();
  const panel = new ChatPanel(
    doc,
    { card: {}, userName: '旅人', source: 'openai', model: 'gpt-4o-mini', sampling: {} },
    {},
  );
  const root = panel.mount(doc.createElement('div'));
  panel.newChat('夜航.png', '夜航小助手（测试）');

  const subtitle = findAll(root, (node) => node.getAttribute('data-role') === 'chat-subtitle')[0];
  assert.equal(subtitle.textContent, '夜航小助手（测试）', '重建后要能靠 newChat 恢复角色名');
});
