/**
 * 语音输入设置页（v0.1.7 / T15.6）。
 *
 * 守四件事 + 一条红线：
 *   ① 「发送前需确认」默认 false，且改动能读出来；
 *   ② 选厂商模板 → 自动填 base_url / model；
 *   ③ key 只写不读（永远空白，保存后清空）；
 *   ④ 测试连接的**文案边界**：说清"验的是链路，不是识别质量"；
 *   ⑤ ★ 红线二：ASR 配置与聊天配置隔离（本页只写语音字段）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { ALL_ASR_PRESETS } from '@tcs/shared';
import {
  DEFAULT_VOICE_SETTINGS,
  makeTestAudio,
  renderVoiceSettingsPage,
} from '../client/src/chat/voice-settings.ts';

/* ── DOM stub（需要 value / checked / selected） ── */

function makeDoc() {
  const createElement = (tag) => {
    const attributes = new Map();
    /*
     * ★ 要给 `<select>` 模拟浏览器的「默认选中第一个 option」。
     *
     * 真实浏览器里 `select.value` 在未显式选过时是**第一个 option 的值**；
     * 而裸 stub 里它是空串 —— 于是 `read().presetId` 拿到 ''，
     * 「测试连接」直接报"选一个服务商"，三条测试假红。
     *
     * 这不是实现的问题，是 stub 比浏览器少了一条行为。
     * 修 stub 而不是改实现去兼容 stub —— 后者会让真实环境变差。
     */
    const node = {
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      innerHTML: '',
      hidden: false,
      value: '',
      checked: false,
      selected: false,
      children: [],
      listeners: {},
      append(...nodes) {
        for (const one of nodes) {
          const child = typeof one === 'string' ? { textContent: one, children: [], isText: true } : one;
          this.children.push(child);
          // 浏览器行为：select 未选时 value 是第一个 option 的 value
          if (this.tagName === 'SELECT' && child.getAttribute?.('value') !== null && this.value === '') {
            this.value = child.getAttribute('value');
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
      fire(type) {
        for (const handler of this.listeners[type] ?? []) handler({ type, target: this });
      },
    };
    return node;
  };
  return { createElement };
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
const flush = () => new Promise((r) => setImmediate(r));

/**
 * 选一个服务商（2026-11-05）。
 *
 * 服务商从原生 `<select>` 改成了**行列表**（与「API 连接」同一套形态），
 * 所以驱动方式的语义也跟着从"改 value + 触发 change"变成"点那一行"。
 *
 * ## 为什么不去改实现来迁就测试
 *
 * 可以保留一个隐藏的 `<select>` 让老测试继续跑 —— 但那是**假控件**：
 * 界面上没有它，测试却在操作它。这种"测试绿、界面坏"的组合在本项目
 * 出现过（§102 的 `sent:false`）。所以改测试，不改实现。
 */
const choosePreset = (page, presetId) => {
  const row = findAll(
    page.root,
    (n) =>
      n.getAttribute('data-role') === 'asr-preset-item' &&
      n.getAttribute('data-preset-id') === presetId,
  )[0];
  assert.ok(row !== undefined, `找不到服务商行 ${presetId}`);
  row.fire('click');
};

function makePage(overrides = {}) {
  const doc = makeDoc();
  const saved = [];
  const notes = [];
  const page = renderVoiceSettingsPage(doc, overrides.initial ?? DEFAULT_VOICE_SETTINGS, {
    onSave: async (settings, key) => {
      saved.push({ settings, key });
    },
    onNotify: (message, kind) => notes.push({ message, kind }),
    testAudio: async () => new Blob(['t'], { type: 'audio/wav' }),
    fetchImpl: overrides.fetchImpl,
    onFetchModels: overrides.onFetchModels,
  });
  return { page, doc, saved, notes };
}

/* ═══════════════════════════════════════════════════════════
   ① 确认开关（C5）
   ═══════════════════════════════════════════════════════════ */

test('★ 「发送前需确认」默认是 false（决策 C5）', () => {
  assert.equal(DEFAULT_VOICE_SETTINGS.confirmBeforeSend, false);
});

test('★ 开关状态能读出来（read() 是唯一取值入口）', () => {
  const { page } = makePage();
  assert.equal(page.read().confirmBeforeSend, false);

  const toggle = byRole(page.root, 'confirm-toggle')[0];
  toggle.checked = true;
  assert.equal(page.read().confirmBeforeSend, true, '开关改动要能被读到');
});

test('开关旁边要说清两种模式的差别（用户才能做决策）', () => {
  const { page } = makePage();
  const text = JSON.stringify(findAll(page.root, () => true).map((n) => n.textContent));
  assert.ok(text.includes('可编辑') && text.includes('直接发'), '要说明开着/关着的差别');
});

/* ═══════════════════════════════════════════════════════════
   ② 厂商模板自动填
   ════════════���══════════════════════════════════════════════ */

test('★ 服务商列表里有全部厂商模板', () => {
  /*
   * 2026-11-05：从 `<select>` 改成行列表（与「API 连接」同一套形态）。
   * 断言的对象跟着换，但守的东西没变 —— **表里每个模板都要有一个入口**。
   */
  const { page } = makePage();
  const rows = byRole(page.root, 'asr-preset-item');
  assert.equal(rows.length, ALL_ASR_PRESETS.length);

  /* 每个模板 id 都要有对应的行（不只是数量对得上） */
  const ids = rows.map((one) => one.getAttribute('data-preset-id'));
  for (const preset of ALL_ASR_PRESETS) {
    assert.ok(ids.includes(preset.id), `模板 ${preset.id} 没有对应的行`);
  }
});

test('★ 选模板 → 自动填 base_url 与 model（这是模板表存在的意义）', () => {
  const { page } = makePage();
  // 找一个 base/model 都非空、且**不是当前默认**的模板（否则点了没变化）
  const preset = ALL_ASR_PRESETS.find(
    (p) => p.baseUrl !== '' && p.model !== '' && p.id !== DEFAULT_VOICE_SETTINGS.presetId,
  );
  assert.ok(preset !== undefined, '至少应有一个模板自带 base/model');

  choosePreset(page, preset.id);

  /* 字段在展开的面板里 —— 所以取的时候要重新查（不是点之前缓存的那个） */
  assert.equal(byRole(page.root, 'asr-base-url')[0].value, preset.baseUrl, 'base_url 应当被自动填');
  assert.equal(byRole(page.root, 'asr-model')[0].value, preset.model, 'model 应当被自动填');
});

test('切模板不会清空用户手填的值（模板该字段为空时保留原值）', () => {
  const { page } = makePage();
  // 手填一个自建服务地址
  byRole(page.root, 'asr-base-url')[0].value = 'https://my-own-asr.local/v1';

  // 找一个 baseUrl 为空的模板（本地/中转站，需手填）
  const blank = ALL_ASR_PRESETS.find((p) => p.baseUrl === '' && p.id !== DEFAULT_VOICE_SETTINGS.presetId);
  if (blank === undefined) return; // 没有这种模板就跳过（表变了也不该红）

  choosePreset(page, blank.id);
  assert.equal(
    byRole(page.root, 'asr-base-url')[0].value,
    'https://my-own-asr.local/v1',
    '模板为空时不许清空用户已填的值',
  );
});

/* ═══════════════════════════════════════════════════════════
   ③ key 只写不读
   ═══════════════════════════════════════════════════════════ */

test('★ key 输入框初始空白、密码类型', () => {
  const { page } = makePage();
  const key = byRole(page.root, 'asr-key')[0];
  assert.equal(key.value, '', 'key 不许回显');
  assert.equal(key.getAttribute('type'), 'password');
});

test('★★ 保存后 key 显示掩码（2026-11-02 用户要求：要能看出"已配置"）', async () => {
  /*
   * 原来这条断言 `value === ''`，理由是"避免看起来还存着"。
   * 但用户实测反馈相反：空白让他无法判断到底存没存上 ——
   * 原话「秘钥也改一下，改成可见的一串星号…这样用户才知道自己有没有配置」。
   *
   * 现在改为断言：有内容、是掩码、不是真 key、type=text（看得见星号）。
   */
  const { page, saved } = makePage({
    initial: { ...DEFAULT_VOICE_SETTINGS, baseUrl: 'https://x/v1', model: 'm' },
  });

  const key = byRole(page.root, 'asr-key')[0];
  key.value = 'sk-secret';
  byRole(page.root, 'save-voice')[0].fire('click');
  await flush();

  assert.equal(saved.length, 1);
  assert.equal(saved[0].key, 'sk-secret', 'key 要交给外壳');

  const after = byRole(page.root, 'asr-key')[0];
  assert.notEqual(after.value, '', '保存后不该空白（用户要能看出已配置）');
  assert.notEqual(after.value, 'sk-secret', '真 key 绝不许回显');
  assert.match(after.value, /^•+$/, `应是掩码串，实际 ${JSON.stringify(after.value)}`);
  assert.equal(after.getAttribute('data-key-state'), 'masked');
  assert.equal(after.getAttribute('type'), 'text', '掩码要用 text 才看得见是星号');
});

test('★ 留空保存 = 不改 key（传 null，不许覆盖成空串）', async () => {
  const { page, saved } = makePage({
    initial: { ...DEFAULT_VOICE_SETTINGS, baseUrl: 'https://x/v1', model: 'm' },
  });

  byRole(page.root, 'save-voice')[0].fire('click');
  await flush();

  assert.equal(saved.length, 1);
  assert.equal(saved[0].key, null, '留空必须是 null，不是空串');
});

test('地址或模型为空时不许保存，且给可操作提示', async () => {
  const { page, saved } = makePage({
    initial: { ...DEFAULT_VOICE_SETTINGS, baseUrl: '', model: '' },
  });

  /*
   * 必须**显式清空**再验。
   *
   * 第一版直接点保存，结果 saved.length 是 1 —— 因为选模板时
   * `applyPreset` 已经自动把 baseUrl/model 填上了（那是正确行为）。
   * "initial 传空" 不等于 "表单里是空"，中间有自动填这一步。
   */
  byRole(page.root, 'asr-base-url')[0].value = '';
  byRole(page.root, 'asr-model')[0].value = '';

  byRole(page.root, 'save-voice')[0].fire('click');
  await flush();

  assert.equal(saved.length, 0, '字段为空时不许保存');
  const status = byRole(page.root, 'voice-status')[0];
  assert.equal(status.hidden, false);
  assert.ok(status.textContent.includes('都要填'), status.textContent);
});

/* ═══════════════════════════════════════════════════════════
   ④ 测试连接的文案边界
   ═══════════════════════════════════════════════════════════ */

test('★ 测试连接成功时要说清"验的是链路不是识别质量"', async () => {
  /*
   * 内置测试音是**合成音**，ASR 识别不出有意义的文字。
   * 如果只提示"测试通过"，用户会以为识别效果好，
   * 用起来发现识别错就以为是 bug。
   */
  const { page } = makePage({
    initial: { ...DEFAULT_VOICE_SETTINGS, baseUrl: 'https://x/v1', model: 'm' },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      /*
       * ★ 回**阿里原生**形状（2026-11-07）。
       *
       * 默认预设 `aliyun-paraformer` 已改成 `dashscope-audio` 协议，
       * 它的响应是 `output.choices[0].message.content[0].text`。
       * 桩若还回 Whisper 的 `{text:''}`，会解析失败并报
       * "服务返回的内容看不懂" —— 那是**桩过时**，不是代码坏了。
       */
      async json() {
        return { output: { choices: [{ message: { content: [{ text: '' }] } }] } };
      },
    }),
  });

  byRole(page.root, 'asr-key')[0].value = 'k';
  byRole(page.root, 'test-asr')[0].fire('click');
  await flush();
  await flush();

  const status = byRole(page.root, 'voice-status')[0];
  assert.equal(status.hidden, false);
  assert.ok(status.textContent.includes('连接正常'), status.textContent);
  assert.ok(
    status.textContent.includes('合成的') || status.textContent.includes('服务本身'),
    `文案没交代清楚验证边界：${status.textContent}`,
  );
});

test('测试失败时用 classifyAsrFailure 的文案（不自己写）', async () => {
  const { page } = makePage({
    initial: { ...DEFAULT_VOICE_SETTINGS, baseUrl: 'https://x/v1', model: 'm' },
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });

  byRole(page.root, 'asr-key')[0].value = 'bad';
  byRole(page.root, 'test-asr')[0].fire('click');
  await flush();
  await flush();

  const status = byRole(page.root, 'voice-status')[0];
  /*
   * 401 的文案来自 `errors.ts`（有 19 条测试守着），实际是「密钥无效或余额不足」。
   *
   * 我第一版断言找 `key` 字样，但实现用的是中文「密钥」—— 断言写窄了。
   * 这里改成验"说出了鉴权问题"这个语义，不绑死具体措辞
   * （措辞会随文案迭代变，而语义不会）。
   */
  assert.ok(
    status.textContent.includes('密钥') ||
      status.textContent.includes('key') ||
      status.textContent.includes('凭据'),
    status.textContent,
  );
  assert.equal(status.getAttribute('data-kind'), 'danger');
});

test('缺字段时按顺序提示（地址 → 模型 → key）', async () => {
  const { page } = makePage();

  // 先清空（模板会自动填，不清空测不到"缺字段"这条分支）
  byRole(page.root, 'asr-base-url')[0].value = '';
  byRole(page.root, 'asr-model')[0].value = '';

  byRole(page.root, 'test-asr')[0].fire('click');
  await flush();
  assert.ok(byRole(page.root, 'voice-status')[0].textContent.includes('服务地址'));

  byRole(page.root, 'asr-base-url')[0].value = 'https://x/v1';
  byRole(page.root, 'test-asr')[0].fire('click');
  await flush();
  assert.ok(byRole(page.root, 'voice-status')[0].textContent.includes('模型'));

  byRole(page.root, 'asr-model')[0].value = 'm';
  byRole(page.root, 'test-asr')[0].fire('click');
  await flush();
  assert.ok(byRole(page.root, 'voice-status')[0].textContent.includes('key'));
});

/* ═══════════════════════════════════════════════════════════
   ⑤ 红线二：配置隔离
   ═══════════════════════════════════════════════════════════ */

test('★★ 红线二：语音设置页只写语音字段，不碰聊天配置', () => {
  /*
   * 静态断言：这一页的源码里**不许出现**聊天侧的配置键。
   *
   * 为什么用静态断言：运行时很难证明"没写某个字段"（要 mock 全部写入口）。
   * 而扫源码能直接证明"这一页根本不知道有那些字段"。
   *
   * 隔离的第二层是 `config-scopes.applyScopedPatch` 对跨作用域写入抛错 ——
   * 那层有 `test/voice-config.test.mjs` 的 9 条测试。
   */
  const source = readFileSync(join(import.meta.dirname, '..', 'client', 'src', 'chat', 'voice-settings.ts'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const chatOnlyKeys = ['serverUrl', 'chatProvider', 'chatModel', 'temperature', 'topP', 'maxTokens', 'apiKey_'];
  for (const key of chatOnlyKeys) {
    assert.equal(
      code.includes(key),
      false,
      `语音设置页里出现了聊天侧字段 ${key} —— 两者必须隔离`,
    );
  }

  // 反过来：它应当只有语音聚合的读写
  assert.ok(code.includes('VoiceSettings'), '本页应当只操作 VoiceSettings');
});

test('★ read() 返回的只有语音字段（形状上就排除了串写）', () => {
  const { page } = makePage();
  const value = page.read();
  /*
   * 2026-11-01 第六批：多了 `modelPath`（gradio 路线的模型权重目录）。
   * 判据的**意图没变**：形状上就排除"串写聊天字段"（`serverUrl` / `provider` 等）。
   */
  assert.deepEqual(
    Object.keys(value).sort(),
    ['baseUrl', 'confirmBeforeSend', 'model', 'modelPath', 'presetId'],
    'VoiceSettings 只该有这几个键（多出来的必须也是语音字段）',
  );
});

/* ═══════════════════════════════════════════════════════════
   ⑥ 测试音频
   ═══════════════════════════════════════════════════════════ */

test('★ 内置测试音频是合法的 WAV（44 字节头 + PCM）', async () => {
  const blob = await makeTestAudio(3, 16000);
  assert.equal(blob.type, 'audio/wav');

  const buffer = await blob.arrayBuffer();
  const view = new DataView(buffer);
  const ascii = (offset, len) =>
    String.fromCharCode(...Array.from({ length: len }, (_, i) => view.getUint8(offset + i)));

  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(ascii(8, 4), 'WAVE');
  assert.equal(ascii(12, 4), 'fmt ');
  assert.equal(view.getUint16(20, true), 1, 'PCM 格式');
  assert.equal(view.getUint16(22, true), 1, '单声道');
  assert.equal(view.getUint32(24, true), 16000, '采样率');
  assert.equal(view.getUint16(34, true), 16, '16 位');
  assert.equal(ascii(36, 4), 'data');

  // 3 秒 × 16000 Hz × 2 字节 + 44 头
  assert.equal(buffer.byteLength, 44 + 3 * 16000 * 2);
});

test('测试音频不是纯静音（纯静音会被部分服务判成没有输入）', async () => {
  const blob = await makeTestAudio(1, 16000);
  const view = new DataView(await blob.arrayBuffer());
  let peak = 0;
  for (let i = 44; i < view.byteLength - 1; i += 2) {
    peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
  }
  assert.ok(peak > 5000, `测试音频振幅太低（${peak}），可能被判成静音`);
});

/* ═══════════════════════════════════════════════════════════
   ⑦ Gradio 路线（决策 #338）：字段随预设切换
   ═══════════════════════════════════════════════════════════ */

test('★★ 选「本地 Fun-ASR（Gradio）」→ key 输入框隐藏、模型路径出现', () => {
  const { page } = makePage();
  // 切之前（阿里）：key 在、模型路径不在
  assert.equal(byRole(page.root, 'asr-key-row')[0].hidden, false);
  assert.equal(byRole(page.root, 'asr-model-path-row')[0].hidden, true);

  choosePreset(page, 'funasr-local');

  /*
   * 自建服务没有鉴权。留着一个 key 输入框，用户会以为"必须编一个" ——
   * 而他编的那个值从来不会被用到。
   */
  assert.equal(byRole(page.root, 'asr-key-row')[0].hidden, true, '不需要 key 的路线要藏掉 key 框');
  assert.equal(byRole(page.root, 'asr-model-path-row')[0].hidden, false, '模型路径要出现');
  assert.equal(
    byRole(page.root, 'fetch-models')[0].hidden,
    true,
    '「获取模型列表」要藏掉 —— Gradio 没有 /models，点了必然失败',
  );

  // 模板带的默认值要填进去
  assert.equal(byRole(page.root, 'asr-model')[0].value, 'fun-asr-nano');
  assert.equal(byRole(page.root, 'asr-model-path')[0].value, './models/Fun-ASR-Nano');
});

test('★ 从 Gradio 切回厂商 → key 框与「获取模型列表」要**回来**', () => {
  /*
   * 单向隐藏是最常见的写法（只 `hidden = true` 从不复原），
   * 表现是"换回阿里之后 key 框再也不出现了" —— 用户只能重装。
   */
  const { page } = makePage();
  choosePreset(page, 'funasr-local');
  choosePreset(page, 'groq');

  assert.equal(byRole(page.root, 'asr-key-row')[0].hidden, false, 'key 框必须回来');
  assert.equal(byRole(page.root, 'fetch-models')[0].hidden, false, '获取模型列表必须回来');
  assert.equal(byRole(page.root, 'asr-model-path-row')[0].hidden, true, '模型路径要收起来');
});

test('★ Gradio 的地址提示语是"局域网地址"（不是 https://…/v1）', () => {
  const { page } = makePage();
  choosePreset(page, 'funasr-local');

  const url = byRole(page.root, 'asr-base-url')[0];
  assert.match(
    String(url.getAttribute('placeholder')),
    /192\.168\.1\.x:7860/,
    '占位符要给一个具体的例子，否则用户不知道该填什么',
  );
});

test('★ Gradio 路线：key 留空点「保存」也能存（并把 modelPath 带上）', async () => {
  const { page, saved } = makePage();
  choosePreset(page, 'funasr-local');

  byRole(page.root, 'asr-base-url')[0].value = 'http://192.168.1.5:7860';
  // key 一个字都不填

  byRole(page.root, 'save-voice')[0].fire('click');
  await flush();

  assert.equal(saved.length, 1, 'key 为空不该拦住保存');
  assert.equal(saved[0].key, null, '没填 key 就传 null（不改动已存的）');
  assert.equal(saved[0].settings.presetId, 'funasr-local');
  assert.equal(saved[0].settings.modelPath, './models/Fun-ASR-Nano');
});

test('★ Gradio 路线：没填地址点「保存」仍要拦（key 可选不等于全放宽）', async () => {
  const { page, saved } = makePage();
  choosePreset(page, 'funasr-local');

  byRole(page.root, 'save-voice')[0].fire('click');
  await flush();

  assert.equal(saved.length, 0, '没填服务地址不该能保存');
});
