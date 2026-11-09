/**
 * API 连接页的 DOM 断言（v0.1.7 / T15.5）。
 *
 * 守三件契约里点名的硬约束：
 *   1. **六后端源**都在列表里；不支持的源给出可操作的报错（不回退到 openai）
 *   2. **采样参数**确实收集起来交给保存回调（它们要随请求体发出去）
 *   3. **key 只写不读** —— 输入框永远空白，不许有任何回显路径
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHAT_SOURCES, CHAT_SOURCE_LABELS } from '@tcs/shared';
import { DEFAULT_API_STATE, renderApiPage } from '../client/src/chat/api-page.ts';

/* ── 极简 DOM stub（与 chat-view-dom 测试同一套最小能力） ── */

function makeDoc() {
  const createElement = (tag) => {
    const attributes = new Map();
    return {
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      innerHTML: '',
      hidden: false,
      value: '',
      disabled: false,
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
      /** 触发事件（测试用） */
      fire(type) {
        for (const handler of this.listeners[type] ?? []) handler({ type, target: this });
      },
      text() {
        return this.textContent;
      },
    };
  };
  return { createElement, createTextNode: (text) => ({ textContent: text, children: [], isText: true }) };
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
const bySource = (root, source) => findAll(root, (n) => n.getAttribute('data-source') === source);

/** 假 bridge：只记录 writeSecret 调用 */
function fakeBridge() {
  const calls = [];
  return {
    calls,
    writeSecret: async (key, value, label) => {
      calls.push({ key, value, label });
      return 'ok';
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/* ═══════════════════════════════════════════════════════════
   ① 六后端源
   ═══════════════════════════════════════════════════════════ */

test('★ 六个后端源一个不少（决策 #269）', () => {
  const doc = makeDoc();
  const page = renderApiPage(doc, fakeBridge(), DEFAULT_API_STATE, { onSave: async () => {} });

  for (const source of CHAT_SOURCES) {
    const node = bySource(page, source);
    assert.equal(node.length, 1, `${source} 没出现在列表里`);
  }
  // 也不许多出来
  const all = findAll(page, (n) => n.getAttribute('data-source') !== null);
  assert.equal(all.length, CHAT_SOURCES.length, '源的数量必须恰好等于六个');
});

test('每个源都有给人看的名字与说明（不是光秃秃的英文 id）', () => {
  const doc = makeDoc();
  const page = renderApiPage(doc, fakeBridge(), DEFAULT_API_STATE, { onSave: async () => {} });

  for (const source of CHAT_SOURCES) {
    const node = bySource(page, source)[0];
    const text = JSON.stringify(findAll(node, () => true).map((n) => n.textContent));
    assert.ok(text.includes(CHAT_SOURCE_LABELS[source].label), `${source} 缺 label`);
    assert.ok(CHAT_SOURCE_LABELS[source].hint.length > 0, `${source} 缺 hint`);
  }
});

test('当前源是选中态（aria-pressed 供无障碍与测试用）', () => {
  const doc = makeDoc();
  const page = renderApiPage(doc, fakeBridge(), { ...DEFAULT_API_STATE, source: 'deepseek' }, {
    onSave: async () => {},
  });
  assert.equal(bySource(page, 'deepseek')[0].getAttribute('aria-pressed'), 'true');
  assert.equal(bySource(page, 'openai')[0].getAttribute('aria-pressed'), 'false');
});

test('点另一个源会切换选中态', () => {
  const doc = makeDoc();
  const page = renderApiPage(doc, fakeBridge(), DEFAULT_API_STATE, { onSave: async () => {} });

  bySource(page, 'groq')[0].fire('click');
  assert.equal(bySource(page, 'groq')[0].getAttribute('aria-pressed'), 'true');
  assert.equal(bySource(page, 'openai')[0].getAttribute('aria-pressed'), 'false');
});

/* ═══════════════════════════════════════════════════════════
   ② 采样参数 —— 第四批起**不在这一页**了

   2026-10-31 用户要求：「采样参数从「我的 → API 连接」页移除，移入聊天页
   顶栏设置按钮内的「AI 响应配置」页（采样随生成请求体下发，属聊天行为配置，
   非账户级配置）」。

   所以原先这五条"输入框在、初值对、越界夹紧、坏值回落、说明文案"全部失效 ——
   它们测的是被删掉的东西。

   ★ 这里**不是删掉断言**，而是反过来钉住"确实没了"。
   删掉的话，将来有人把采样字段加回连接页，不会有任何测试变红；
   而"两个地方都能改采样"正是用户明确要避免的状态（他说"两处都不丢字段"，
   前提是字段只在正确的地方）。
   ═══════════════════════════════════════════════════════════ */

test('★★ 采样输入框不许再出现在 API 连接页', () => {
  const doc = makeDoc();
  const page = renderApiPage(doc, fakeBridge(), DEFAULT_API_STATE, { onSave: async () => {} });

  for (const key of ['temperature', 'topP', 'maxTokens']) {
    const input = byRole(page, `sampling-${key}`);
    assert.equal(input.length, 0, `API 连接页不该再有 sampling-${key} 输入框（采样已迁到 AI 响应配置页）`);
  }
});

test('★★ 保存交出去的状态里不许带 sampling', async () => {
  /*
   * 只删输入框、但保存时仍往 state 里塞 sampling（比如读 undefined 得默认值），
   * 后果是"连接页保存"会把采样打回默认 —— 用户改个模型名，温度就回去了。
   */
  const doc = makeDoc();
  let saved = null;
  const page = renderApiPage(doc, fakeBridge(), { ...DEFAULT_API_STATE, model: 'gpt-4o' }, {
    onSave: async (state) => {
      saved = state;
    },
  });

  byRole(page, 'save-api')[0].fire('click');
  await flush();

  assert.ok(saved !== null, '保存回调没被调用');
  assert.equal(Object.hasOwn(saved, 'sampling'), false, `状态里不该再有 sampling，实际：${JSON.stringify(saved)}`);
});

test('★ 连接页只剩连接类字段（接口源 / 模型名 / key）', () => {
  /*
   * 用户要求：「API 连接页只保留连接类字段（接口源 / 模型名 / key / 地址）」。
   *
   * 判据用"这些必须在"，比"这些不许在"更重要 ——
   * 前者保证迁移没把该留的一起删掉（那才是灾难）。
   */
  const doc = makeDoc();
  const page = renderApiPage(doc, fakeBridge(), DEFAULT_API_STATE, { onSave: async () => {} });

  assert.ok(byRole(page, 'source-list')[0] !== undefined, '接口源列表必须在');
  assert.ok(byRole(page, 'model-input').length >= 1, '模型名输入必须在');
  assert.ok(byRole(page, 'key-input').length >= 1, 'key 输入必须在');
});

test('★ 连接页不该再出现「采样参数」这个标题（空标题会让用户以为功能丢了）', () => {
  const doc = makeDoc();
  const page = renderApiPage(doc, fakeBridge(), DEFAULT_API_STATE, { onSave: async () => {} });
  const texts = JSON.stringify(findAll(page, () => true).map((n) => n.textContent));
  assert.equal(texts.includes('采样参数'), false, '不该再有「采样参数」字样');
});

/* ═══════════════════════════════════════════════════════════
   ③ key 只写不读
   ═══════════════════════════════════════════════════════════ */

test('★ key 输入框初始必须是空的（不许回显任何已存的 key）', () => {
  const doc = makeDoc();
  const page = renderApiPage(doc, fakeBridge(), DEFAULT_API_STATE, { onSave: async () => {} });
  const keyInput = byRole(page, 'key-input')[0];
  assert.equal(keyInput.value, '', 'key 输入框必须是空白');
  assert.equal(keyInput.getAttribute('type'), 'password', 'key 要用密码框');

  /*
   * ★★★ 2026-11-07 改判据（前提变了，不是放松要求）。
   *
   * 原来这里断言页面文本必须含「不会再显示」—— 因为旧文案在
   * **所有非 masked 态**都写着「key 已保存，这里不会再显示」。
   * 而那句话正是用户那条 `400 {"error":true}` 的直接原因：
   * 他在一个**从来没配过 key** 的源上看到「key 已保存」，
   * 于是不再填，然后发消息必失败。
   *
   * 现在的语义是：
   *
   * ```text
   *   empty    （没配）  → '还没有配 key…'            ← 说现状 + 下一步
   *   editing  （在填）  → '粘贴…然后点保存'
   *   masked   （配过）  → '真 key 不会再显示…'      ← 原判据要保的那层意思
   * ```
   *
   * 所以判据分两段验：
   *   ① 默认（没配 key）**不许**说"已保存/不会再显示"
   *   ② 真配过时（hasKeyFor → true）才说"不会再显示"
   */
  const initialText = JSON.stringify(findAll(page, () => true).map((n) => n.textContent));
  assert.ok(
    !/已保存|不会再显示/.test(initialText),
    `没配 key 时不许说"已保存/不会再显示"（用户会以为配好了）：${initialText.slice(0, 160)}`,
  );
  assert.ok(/还没有配 key/.test(initialText), '没配 key 时要明说');

  /* 配过的那一份：显示掩码 + 说明不会回显 */
  const doc2 = makeDoc();
  const page2 = renderApiPage(doc2, fakeBridge(), DEFAULT_API_STATE, {
    onSave: async () => {},
    hasKeyFor: () => true,
  });
  const maskedInput = byRole(page2, 'key-input')[0];
  assert.ok(maskedInput.value.length > 0, '配过时要显示掩码（证明"存进去了"）');
  /*
   * 掩码态用 `text` 而不是 `password` —— 因为它要**显示** `••••••••••••`
   * 这串掩码字符本身（`keyFieldType` 的既定设计）。用 password 的话
   * 浏览器会把这串圆点再显示成圆点，两者叠起来反而更乱。
   *
   * 真正要防"泄露真 key"的是 `keyFieldValue()` 只返回掩码串，
   * 这一点由上面 `value.length > 0` + 下面 `KEY_MASK` 的断言共同保证。
   */
  assert.equal(maskedInput.getAttribute('type'), 'text', '掩码态用 text 显示掩码串');
  assert.equal(maskedInput.value, '••••••••••••', '掩码态显示的就是掩码串，不是真 key');
  const maskedText = JSON.stringify(findAll(page2, () => true).map((n) => n.textContent));
  assert.ok(
    maskedText.includes('不会再显示'),
    `配过时必须说明"真 key 不会再显示"，否则用户会怀疑没存上：${maskedText.slice(0, 160)}`,
  );
});

test('★ 填了 key 才会写进 ST；留空表示不改', async () => {
  const doc = makeDoc();
  const bridge = fakeBridge();
  let savedCount = 0;
  const page = renderApiPage(doc, bridge, { ...DEFAULT_API_STATE, model: 'gpt-4o' }, {
    onSave: async () => {
      savedCount += 1;
    },
  });

  // ① 留空保存：不许调 writeSecret（否则会把已存的 key 覆盖成空串）
  byRole(page, 'save-api')[0].fire('click');
  await flush();
  assert.equal(bridge.calls.length, 0, '留空时不许写 key');
  assert.equal(savedCount, 1, '其它设置仍要保存');

  // ② 填了 key：要写，且写进对应源的槽位
  byRole(page, 'key-input')[0].value = 'sk-test-123';
  byRole(page, 'save-api')[0].fire('click');
  await flush();
  assert.equal(bridge.calls.length, 1);
  assert.equal(bridge.calls[0].key, `api_key_${DEFAULT_API_STATE.source}`);

  /*
   * ③ ★ 写完之后**不再清空**，而是显示一串星号（2026-11-02 用户要求）。
   *
   * 原来这条断言的是 `value === ''`，理由是"避免看起来还存着"。
   * 但真机反馈是相反的：用户原话「秘钥也改一下，改成可见的一串星号…
   * 这样用户才知道自己有没有配置」—— 空白让他无法判断到底存没存上。
   *
   * 所以现在要同时断言三件事：
   *   · 框里**有内容**（不是空）
   *   · 内容是**掩码**（不是真 key —— 真 key 绝不能回显）
   *   · `type=text`（否则浏览器会把星号再掩一层，用户看到的是圆点，
   *     分不清"这是占位"还是"我真有一个 12 位的 key"）
   */
  const afterSave = byRole(page, 'key-input')[0];
  assert.notEqual(afterSave.value, '', '保存后不该是空白（用户要能看出"已配置"）');
  assert.notEqual(afterSave.value, 'sk-test-123', '真 key 绝不许回显');
  assert.match(afterSave.value, /^•+$/, `保存后应是掩码串，实际 ${JSON.stringify(afterSave.value)}`);
  assert.equal(afterSave.getAttribute('type'), 'text', '掩码要用 text 才看得见是星号');
});

test('★★★ 掩码串绝不能被当成新 key 写进 ST', async () => {
  /*
   * 这是本轮改动里**唯一会造成数据损坏**的分支：
   * 如果保存时把展示用的 `'••••••••••••'` 当新 key 写进 SillyTavern，
   * 用户真实 key 就被覆盖成一串圆点 ⇒ 之后所有请求 401，
   * 而错误只显示"鉴权失败"，没人能想到原因。
   *
   * 场景：用户已配置过（框里是掩码），他只想改模型名就点保存。
   */
  const doc = makeDoc();
  const bridge = fakeBridge();
  const page = renderApiPage(doc, bridge, { ...DEFAULT_API_STATE, model: 'gpt-4o' }, {
    onSave: async () => {},
    hasKeyFor: () => true,
  });

  /* 已配置过的源，打开就该看到掩码 */
  const keyBox = byRole(page, 'key-input')[0];
  assert.match(keyBox.value, /^•+$/, '已配置过要显示掩码');
  assert.equal(keyBox.getAttribute('data-key-state'), 'masked');

  /* 直接点保存（没动 key）⇒ 不许写 */
  byRole(page, 'save-api')[0].fire('click');
  await flush();
  assert.equal(bridge.calls.length, 0, '掩码态保存不许写 key（写了就是覆盖真 key）');
});

/* ═══════════════════════════════════════════════════════════
   ④ 校验顺序与报错
   ═══════════════════════════════════════════════════════════ */

test('★ 没填模型名要报错，且不调保存（不许静默存一个空模型）', async () => {
  const doc = makeDoc();
  let saved = 0;
  const page = renderApiPage(doc, fakeBridge(), { ...DEFAULT_API_STATE, model: '' }, {
    onSave: async () => {
      saved += 1;
    },
  });

  byRole(page, 'save-api')[0].fire('click');
  await flush();

  assert.equal(saved, 0, '模型为空时不许保存');
  const status = byRole(page, 'api-status')[0];
  assert.equal(status.hidden, false, '要给可见的报错');
  assert.ok(status.textContent.includes('模型'), status.textContent);
});

test('报错文案要指导下一步（不是"保存失败"四个字）', async () => {
  const doc = makeDoc();
  const page = renderApiPage(doc, fakeBridge(), { ...DEFAULT_API_STATE, model: '' }, {
    onSave: async () => {},
  });
  byRole(page, 'save-api')[0].fire('click');
  await flush();

  const text = byRole(page, 'api-status')[0].textContent;
  // 「填完再保存」这类可操作的话，而不是单纯的错误词
  assert.ok(text.length > 6, `报错太短，用户不知道怎么办：${text}`);
});

test('保存成功要有可见反馈', async () => {
  const doc = makeDoc();
  const page = renderApiPage(doc, fakeBridge(), { ...DEFAULT_API_STATE, model: 'gpt-4o' }, {
    onSave: async () => {},
  });
  byRole(page, 'save-api')[0].fire('click');
  await flush();

  const status = byRole(page, 'api-status')[0];
  assert.equal(status.hidden, false);
  assert.ok(status.textContent.includes('已保存'), status.textContent);
});

test('★★ 旧的"两处设置分工"说明必须撤掉（它已经不再成立）', () => {
  /*
   * 这句文案原来是：
   *   「这些值会随每次请求一起发出去。SillyTavern 的设置页里改这些不会影响这里。」
   *
   * 它当年是对的 —— 那时采样存在 localStorage，与 ST 设置是两份互不相干的副本。
   *
   * **但第四批迁移之后它变成了误导**：现在采样就存在 ST 设置里，
   * 在 ST 设置页改是**会影响**的（下次进聊天页就播种过来）。
   * 留着这句话等于告诉用户一个已经反过来的事实。
   *
   * 这类"迁移后忘了改文案"是最容易漏的一步：功能对了、测试绿了，
   * 界面上却还写着旧世界的规则。所以用断言钉住它必须消失。
   */
  const doc = makeDoc();
  const page = renderApiPage(doc, fakeBridge(), DEFAULT_API_STATE, { onSave: async () => {} });
  const text = JSON.stringify(findAll(page, () => true).map((n) => n.textContent));

  assert.equal(text.includes('不会影响这里'), false, '这句旧说明必须撤掉（采样现在就在 ST 设置里）');
});
