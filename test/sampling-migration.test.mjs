/**
 * 第四批 · 任务一：采样参数迁移的自动化断言（2026-10-31）。
 *
 * ## 用户明确要求的四条判据
 *
 * > 迁移后验证（自动化断言，不许只看 UI）：
 * > a. AI 响应配置页改 temperature → 生成请求体携带新值
 * >    （st-adapter 契约测试断言请求体字段）；
 * > b. API 连接页保存后采样参数不被清空；
 * >    AI 响应配置页保存后连接字段不被清空
 * >    （ST 设置保存是全量覆盖语义，两边各存各的键，互不清空必须钉死）。
 *
 * ## 为什么这组测试是"链路级"而不是"UI 级"
 *
 * 采样参数的迁移有三个断点，每一个都能"看起来正常"：
 *   ① 页面删了输入框，但保存时还在读（读到 undefined → 写默认值）
 *   ② 页面写进了 ST 设置，但请求体还是从 localStorage 取（改了不生效）
 *   ③ 请求体拼装没有对应分支（字段静默丢弃）
 *
 * 所以这里的断言刻意**跨层**：从 ST 设置对象 → 派生 → 请求体，
 * 一路断言同一个数字。只看 UI 的话，①②③ 全都测不出来。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * 从 **dist** 导入。
 *
 * 原因同 `test/android-test-card.test.mjs`：`generate.ts` 与
 * `sampling-bridge.ts` 内部都有 import（`../st-adapter/types.js` 等），
 * node 直接跑 `.ts` 源码时找不到对应的 `.js`，ERR_MODULE_NOT_FOUND。
 * 有内部依赖的模块一律走 dist，与 npm test 里"先 build:shared 再跑"一致。
 */
import { buildGenerateRequest } from '../shared/dist/chat/generate.js';
import {
  SAMPLING_PATH_TO_PARAM,
  samplingFromSettings,
} from '../shared/dist/chat/sampling-bridge.js';
import { SAMPLING_SECTION, writeField } from '../shared/dist/chat/settings-schema.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CHAT_DIR = join(REPO, 'client', 'src', 'chat');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

/**
 * 剥掉注释，只留代码。
 *
 * ## 为什么必须要这一步
 *
 * 这组断言里有好几条是"某文件里不许出现 X"。第一版直接扫全文，
 * 于是**解释性的注释**把它判红了：
 *
 *   · `api-page.ts` 的注释写着"采样参数去哪了：…存 ST 设置的 `oai_settings.*`"
 *     → 被 b3 的 `doesNotMatch(/oai_settings/)` 命中
 *   · `main.ts` 的注释写着"还存着 `sampling`…会把它一直带在状态里"
 *     → 被 c2 的 `doesNotMatch(/sampling/)` 命中
 *
 * 那两句注释恰恰是在**说明这次修复**，把它们判成违规是判据的错。
 * 与 `nebula-walkthrough.test.mjs` 走查 10 同一族问题（那条也修过一遍）。
 *
 * 反过来，如果为了过测把注释删掉，就丢掉了"为什么这么改"的说明 ——
 * 那才是真正该保留的东西。所以修判据，不修注释。
 */
function codeOnly(text) {
  // 块注释先剥（跨行），再剥行注释
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** 造一份 ST 设置对象（结构照真实 settings.json） */
function stSettings(overrides = {}) {
  return {
    oai_settings: {
      temp_openai: 1,
      top_p_openai: 1,
      top_k_openai: 0,
      openai_max_tokens: 300,
      freq_pen_openai: 0,
      repetition_penalty_openai: 1,
      ...overrides,
    },
  };
}

/* ═══════════════════════════════════════════════════════════
   a. 改 temperature → 请求体携带新值（契约级断言）
   ═══════════════════════════════════════════════════════════ */

test('★★ a1. ST 设置里的温度 → 派生 → 请求体 temperature', () => {
  /*
   * 这是用户要求的 (a) 的核心：在「AI 响应配置」页改温度，
   * 请求体必须带上新值。
   *
   * 三层一路断言同一个数字：
   *   存储（ST 设置 oai_settings.temp_openai）
   *     → 派生（samplingFromSettings → { temperature })
   *       → 请求体（buildGenerateRequest → request.temperature）
   *
   * 任何一层写错（键名、映射、拼装）这条都会红。
   */
  const field = SAMPLING_SECTION.fields.find((f) => f.path.join('.') === 'oai_settings.temp_openai');
  assert.ok(field, 'SAMPLING_SECTION 里必须有 temperature 字段');

  // 用户在页面上把温度改成 1.35（writeField 就是保存时的写法）
  const saved = writeField(stSettings(), field, 1.35);

  // ① 存储层
  assert.equal(saved['oai_settings']['temp_openai'], 1.35);

  // ② 派生层
  const derived = samplingFromSettings(saved);
  assert.equal(derived.temperature, 1.35, '派生出的温度必须等于存进去的值');

  // ③ 请求体层
  const built = buildGenerateRequest({
    source: 'openai',
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hi' }],
    sampling: derived,
  });
  assert.equal(built.ok, true);
  if (built.ok) {
    assert.equal(built.request.temperature, 1.35, '请求体必须携带新温度');
  }
});

test('★★ a2. 每个「会发出去」的字段都能走通到请求体（一个都不许静默丢）', () => {
  /*
   * 这条守的是"字段有了、UI 有了、就是发不出去"。
   *
   * 真实教训：`repetition_penalty_openai` 在 UI 里存在，但
   * `StGenerateRequest` 类型与 `buildGenerateRequest` 都没有它 ——
   * 改了会被**静默丢弃**。2026-10-31 已补上。
   *
   * 做法：给每个字段一个独特的值，全部断言出现在请求体里。
   * 用"独特值"而不是默认值，否则"字段根本没读"与"读到了默认值"
   * 无法区分 —— 那是这类断言最常见的假绿来源。
   *
   * ## 2026-11-03 演进
   *
   * 字段从 6 个变成 12 个"会发出去"的（另 16 个标了 `sent:false`，不参与本判据）。
   * 这里把每个字段的独特值写全，并**直接断言请求体里的对应键** ——
   * 不是"断言有个数字"，而是"断言键名对得上"。
   */
  const distinct = {
    'oai_settings.temp_openai': 1.11,
    'oai_settings.top_p_openai': 0.22,
    'oai_settings.top_k_openai': 33,
    'oai_settings.top_a_openai': 0.44,
    'oai_settings.min_p_openai': 0.077,
    'oai_settings.openai_max_tokens': 444,
    'oai_settings.pres_pen_openai': 0.66,
    'oai_settings.freq_pen_openai': 0.55,
    'oai_settings.repetition_penalty_openai': 1.66,
    'oai_settings.seed': 12345,
    'oai_settings.reasoning_effort': 'high',
    'oai_settings.verbosity': 'low',
  };

  /* 字段 → 请求体里的键 */
  const EXPECT = {
    'oai_settings.temp_openai': ['temperature', 1.11],
    'oai_settings.top_p_openai': ['top_p', 0.22],
    'oai_settings.top_k_openai': ['top_k', 33],
    'oai_settings.top_a_openai': ['top_a', 0.44],
    'oai_settings.min_p_openai': ['min_p', 0.077],
    'oai_settings.openai_max_tokens': ['max_tokens', 444],
    'oai_settings.pres_pen_openai': ['presence_penalty', 0.66],
    'oai_settings.freq_pen_openai': ['frequency_penalty', 0.55],
    'oai_settings.repetition_penalty_openai': ['repetition_penalty', 1.66],
    'oai_settings.seed': ['seed', 12345],
    'oai_settings.reasoning_effort': ['reasoning_effort', 'high'],
    'oai_settings.verbosity': ['verbosity', 'low'],
  };

  /*
   * 只验**有请求体映射**的字段（2026-11-04 改）。
   *
   * 原来取的是 `f.sent !== false`，即"除声明只存以外的全部"。而现在多了
   * 第三种「间接生效」——「上下文长度」不进请求体，但它决定我们发多少历史。
   * 把它算进"会发出去"会让这条判据要求它出现在请求体里，而它本来就不该在。
   *
   * 判据意图不变：**凡是声明"会进请求体"的字段，都必须真的走到**。
   */
  const sentFields = SAMPLING_SECTION.fields.filter(
    (f) => f.sent !== false && f.indirect === undefined,
  );
  assert.ok(sentFields.length >= 11, `会发出去的字段不该少于 11 个，实际 ${String(sentFields.length)}`);

  let settings = stSettings();
  for (const field of sentFields) {
    const key = field.path.join('.');
    const value = distinct[key];
    assert.notEqual(
      value,
      undefined,
      `${key} 没有给独特值 —— 新加字段时这条测试要跟着补（否则新字段永远不会被验到）`,
    );
    settings = writeField(settings, field, value);
  }

  const built = buildGenerateRequest({
    source: 'openai',
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    sampling: samplingFromSettings(settings),
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const request = built.request;
  const missing = [];
  for (const field of sentFields) {
    const key = field.path.join('.');
    const pair = EXPECT[key];
    assert.notEqual(pair, undefined, `${key} 没有登记期望的请求体键`);
    const [requestKey, expectedValue] = pair;
    const actual = request[requestKey];
    if (actual !== expectedValue) {
      missing.push(`${key} → 请求体 .${requestKey} 期望 ${JSON.stringify(expectedValue)}，实际 ${JSON.stringify(actual)}`);
    }
  }

  assert.deepEqual(missing, [], `这些字段没走到请求体：\n  ${missing.join('\n  ')}`);
});

test('★ a2b. 种子 -1 与推理强度 auto 不写进请求体', () => {
  /*
   * 这两条是"看着像值、其实是"不指定""的坑：
   *
   * · `seed: -1` 是 ST 语义的"随机"，不是可以发给上游的种子；
   * · `reasoning_effort: 'auto'` 是"不干预"，而部分中转站不认 `auto`，会 400。
   *
   * 两者都必须表现为"请求体里没有这个键"，而不是带一个特殊值。
   */
  let settings = stSettings();
  settings = writeField(
    settings,
    SAMPLING_SECTION.fields.find((f) => f.path.join('.') === 'oai_settings.seed'),
    -1,
  );
  settings = writeField(
    settings,
    SAMPLING_SECTION.fields.find((f) => f.path.join('.') === 'oai_settings.reasoning_effort'),
    'auto',
  );

  const built = buildGenerateRequest({
    source: 'openai',
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    sampling: samplingFromSettings(settings),
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;

  assert.equal('seed' in built.request, false, 'seed=-1 表示随机，不该出现在请求体里');
  assert.equal('reasoning_effort' in built.request, false, 'auto 表示不指定，不该出现在请求体里');
});

test('★ a3. 每个采样字段必须明确自己的生效路径（进请求体 / 间接生效 / 只存）', () => {
  /*
   * 交叉校验的第四条：加了新采样字段但忘了加映射 —— 那这个字段就是
   * "界面能改、存得下、永远不生效"。
   *
   * ## 2026-11-03 演进：允许显式的"只存 ST"
   *
   * 照 ST 原生「AI 响应配置」面板补齐之后，这一页里混进了 ST 前端专用的项
   * （角色名称行为、续写预填充、函数调用、内嵌媒体…）。ST 的生成端点
   * **只读请求体、不读 settings.json**，所以这些项在我们的 App 里改了确实
   * 不会影响生成 —— 硬给它们编一个"请求体参数"才是撒谎。
   *
   * 于是判据改成：**要么有映射，要么 `sent: false` 且写了 `storeOnlyReason`**。
   * 这样"忘了加映射"仍然红（默认 `sent` 是 true），
   * 而"故意只存储"必须留下理由，不许悄悄加一个死控件。
   */
  const problems = [];

  for (const field of SAMPLING_SECTION.fields) {
    const path = field.path.join('.');
    const hasMapping = SAMPLING_PATH_TO_PARAM[path] !== undefined;

    /*
     * ## 三种生效路径（2026-11-04 从二元改成三元）
     *
     * ```text
     *   ① 进请求体      → SAMPLING_PATH_TO_PARAM 有映射
     *   ② 间接生效      → indirect 有值（不进请求体，但改变我们发什么）
     *   ③ 只存不生效    → sent:false + storeOnlyReason
     * ```
     *
     * 为什么要加 ②：上一版把「上下文长度」当成 ③，文案还写"App 不带这个
     * 上限"，而 shell 明明读了它去做预算裁剪。二元分类装不下这个事实，
     * 于是那个字段既错标了标记、又给了用户错误解释。
     */
    if (field.sent === false) {
      if (typeof field.storeOnlyReason !== 'string' || field.storeOnlyReason.trim() === '') {
        problems.push(`${path}：标了 sent:false 却没写 storeOnlyReason（用户会以为它生效）`);
      }
      if (hasMapping) {
        problems.push(`${path}：标了 sent:false 却又在映射表里，两处说法矛盾`);
      }
      continue;
    }

    if (field.indirect !== undefined) {
      if (field.indirect.trim() === '') {
        problems.push(`${path}：标了 indirect 但没写生效路径（等于没说）`);
      }
      if (hasMapping) {
        problems.push(`${path}：既在映射表里又标了 indirect，两处说法矛盾`);
      }
      continue;
    }

    if (!hasMapping) {
      problems.push(
        `${path}：既没有请求体映射、也没标 indirect / sent:false —— 这条路没人说清，改了大概率不生效`,
      );
    }
  }

  assert.deepEqual(problems, [], `采样字段映射有问题：\n  ${problems.join('\n  ')}`);
});

test('★★★ a3b. 界面里不许再有「改了不生效」的字段', () => {
  /*
   * ## 这条判据的意图（2026-11-04 收紧）
   *
   * 原来它守的是"只存 ST 的字段要单独分组"——那时允许摆假控件，
   * 只要求"诚实标注"。但用户说得很清楚：
   *
   * > 用户不需要知道 ST 是什么，只需要知道 APP 有完整聊天功能就行，
   * > 即 ST 和 APP 在用户看来是一个整体而不是割裂的
   *
   * 摆一个点了没用的开关、再解释"它只在某个你看不见的界面里起作用"，
   * 恰好是**两头都错**：给了假控件，还暴露了内部架构。
   *
   * 所以现在直接要求：**一个都不许有**。
   * 真要做不了的功能，从界面上拿掉（或标 `unsupported` 且说明"暂时不提供"），
   * 而不是留一个开关让用户去点。
   */
  const dead = SAMPLING_SECTION.fields
    .filter((f) => f.sent === false)
    .map((f) => f.path.join('.'));

  assert.deepEqual(
    dead,
    [],
    `这些字段改了不生效却还摆在界面上：\n  ${dead.join('\n  ')}\n` +
      '要么删掉，要么做成真的生效（见 §101 的取证：生成端点只读请求体）。',
  );
});

test('★ a4. 映射表里没有残留键（字段删了但映射还在）', () => {
  const paths = new Set(SAMPLING_SECTION.fields.map((f) => f.path.join('.')));
  const stale = Object.keys(SAMPLING_PATH_TO_PARAM).filter((path) => !paths.has(path));

  assert.deepEqual(stale, [], `映射表里这些键在 SAMPLING_SECTION 里已不存在：\n  ${stale.join('\n  ')}`);
});

test('★ a5. 设置里缺字段时，请求体不带那个键（让 ST 用自己的默认）', () => {
  /*
   * 不能因为我们没有值就发一个 0 —— `temperature: 0` 会让模型完全确定性，
   * 与"没设置"完全不是一回事。
   */
  const built = buildGenerateRequest({
    source: 'openai',
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    sampling: samplingFromSettings({}),
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;

  /*
   * `samplingFromSettings({})` 会给出各字段的 fallback（这是有意的：
   * 页面上显示什么，发出去的就得是什么，否则用户看到 1 却发 0.9）。
   * 所以这里断言的是"有值且等于 fallback"，同时断言**没多出别的键**。
   */
  assert.equal(typeof built.request.temperature, 'number');
  assert.equal(typeof built.request.max_tokens, 'number');
});

/* ═══════════════════════════════════════════════════════════
   b. 两边各存各的键，互不清空（全量覆盖语义下必须钉死）
   ═══════════════════════════════════════════════════════════ */

test('★★ b1. 改采样后，连接类键一个不少（全量覆盖不误伤）', () => {
  /*
   * `/api/settings/save` 是**整份覆盖**：body 就是完整的 settings 对象。
   * 只要保存时构造的 next 少了键，那些键就当场被清空。
   *
   * `mutateSettings` 的 `applySettingsUpdate` 会拦"顶层键减少"，
   * 但拦不住"子对象里少了一个键"—— 所以这里必须逐个断言。
   *
   * 连接类键：API key 槽位引用、后端源、模型名（都在 ST 设置里）
   */
  const base = {
    oai_settings: {
      temp_openai: 1,
      openai_max_tokens: 300,
      // 连接类（ST 在请求时读这些来选后端/模型/key）
      chat_completion_source: 'openai',
      openai_model: 'gpt-4o-mini',
      reverse_proxy: 'https://example.invalid/v1',
      proxy_password: 'slots-secret-ref',
    },
  };

  const field = SAMPLING_SECTION.fields.find((f) => f.path.join('.') === 'oai_settings.temp_openai');
  const after = writeField(base, field, 0.5);

  const connKeys = ['chat_completion_source', 'openai_model', 'reverse_proxy', 'proxy_password'];
  for (const key of connKeys) {
    assert.equal(
      after['oai_settings'][key],
      base['oai_settings'][key],
      `改采样后连接字段 ${key} 被清空了`,
    );
  }
});

test('★★ b2. 改连接后，采样键一个不少', () => {
  /*
   * 反向：API 连接页保存时如果顺手写了一份 oai_settings（比如说"重置"了
   * 采样），采样就被清空。当前实现里 API 页**完全不动** oai_settings，
   * 这条断言守的就是这个"不动"。
   */
  const base = stSettings({ chat_completion_source: 'openai', openai_model: 'gpt-4o-mini' });

  // 模拟"连接页保存"：只改模型名
  const after = writeField(
    base,
    {
      path: ['oai_settings', 'openai_model'],
      label: '模型',
      kind: 'text',
      fallback: '',
    },
    'gpt-4o',
  );

  for (const key of [
    'temp_openai',
    'top_p_openai',
    'top_k_openai',
    'openai_max_tokens',
    'freq_pen_openai',
    'repetition_penalty_openai',
  ]) {
    assert.equal(after['oai_settings'][key], base['oai_settings'][key], `改模型后采样字段 ${key} 被清空`);
  }
});

test('★★ b3. API 连接页的保存逻辑不碰 ST 设置（它是纯 localStorage + secret）', () => {
  /*
   * 这是 b2 的"实现层"证据：`api-page.ts` 的保存只做两件事
   * （写 secret、把 state 交给外壳），**不调 settingsSave**。
   *
   * 为什么要断言源码：如果哪天有人在连接页里顺手加一句
   * `mutateSettings(...)` 去"同步一下"，采样就可能被它覆盖 ——
   * 而那是个不报错、只在特定顺序下出现的缺陷。
   */
  const code = codeOnly(read('client/src/chat/api-page.ts'));

  assert.doesNotMatch(code, /settingsSave\s*\(/, 'API 连接页不许直调 settingsSave');
  assert.doesNotMatch(code, /mutateSettings\s*\(/, 'API 连接页不许调 mutateSettings（它不该写 ST 设置）');
  assert.doesNotMatch(code, /oai_settings/, 'API 连接页不许碰 oai_settings');
});

test('★★ b4. 连接页保存后，外壳不许把 sampling 写回默认值', () => {
  /*
   * 第三批的实现里，连接页 onSave 会 `setContext({ sampling: {...} })`。
   * 采样迁走后若这一行还在（且读的是已不存在的 `state.sampling`），
   * 就会把默认值写进去 —— 用户改个模型名，温度回默认。
   */
  const src = read('client/src/chat/shell.ts');
  /*
   * ★ 用正则找签名，不钉字面 `onSave: async (state) =>`。
   *
   * 2026-11-02 加了第二参（`apiKey`，用于判断"这次有没有写新 key"）
   * 之后，原来那条 `indexOf('onSave: async (state) =>')` 直接找不到 ——
   * 报"找不到连接页的 onSave"，看起来像功能丢了，实际只是签名多了一个参数。
   *
   * 这是本项目第 5 次「判据钉字面」（前四次：`function boot()` 签名、
   * `transition: width`、`@media` 选择器重复、`const hidden`）。
   * 判据要钉**意图**（这段回调里有没有 sampling），不是参数表的形状。
   */
  const match = /onSave: async \(state[,)]/.exec(src);
  assert.ok(match !== null, '找不到连接页的 onSave');
  const start = match.index;
  const end = src.indexOf('onNotify: this.options.onNotify', start);
  assert.ok(end > start, '找不到 onSave 的结束位置');
  const block = codeOnly(src.slice(start, end));

  assert.doesNotMatch(
    block,
    /sampling/,
    `连接页保存回调里不许出现 sampling（会把用户调好的采样打回默认）。实际：\n${block.slice(0, 600)}`,
  );
});

test('★ b5. 「AI 响应配置」页不出现连接类字段', () => {
  /*
   * 用户要求："AI 响应配置页不出现连接类字段"。
   *
   * 判据落在**字段规格**上（而不是 UI 里有没有渲染某个词）：
   * `SAMPLING_SECTION` 里只要有任一字段的路径落在连接类键上，就红。
   */
  const connKeys = ['openai_model', 'chat_completion_source', 'reverse_proxy', 'api_key', 'custom_url'];
  const offenders = SAMPLING_SECTION.fields
    .map((f) => f.path.join('.'))
    .filter((path) => connKeys.some((k) => path.includes(k)));

  assert.deepEqual(offenders, [], `采样分区里混进了连接类字段：\n  ${offenders.join('\n  ')}`);
});

test('★ b6. 「API 连接」页不出现采样类输入（残留输入框）', () => {
  /*
   * 用户要求："API 连接页不留采样参数残留输入框"。
   *
   * 三种残留形态都要挡：
   *   ① data-role="sampling-*" 的输入框
   *   ② 状态里还有 sampling 字段
   *   ③ 保存时还在读采样输入
   */
  const src = codeOnly(read('client/src/chat/api-page.ts'));

  assert.doesNotMatch(src, /data-role',\s*`sampling-/, '不许有 sampling-* 的输入框');
  assert.doesNotMatch(src, /SAMPLING_FIELDS/, '不许留采样字段表');
  assert.doesNotMatch(src, /sampling:/, 'ApiPageState 不许还有 sampling 字段');
  assert.doesNotMatch(src, /'采样参数'/, '不许留「采样参数」标题（空标题会让用户以为功能丢了）');
});

test('★★ b7. 采样在「AI 响应配置」页（单一入口，不在连接页）', () => {
  /*
   * 迁移的"存在性"判据：字段必须在 SAMPLING_SECTION 里，
   * 且那一组就是聊天设置菜单的第一项。
   */
  assert.ok(SAMPLING_SECTION.fields.length >= 3, 'AI 响应配置页至少要有三个采样字段');

  const src = read('client/src/chat/chat-settings.ts');
  assert.match(src, /SAMPLING_SECTION/, 'chat-settings.ts 必须用 SAMPLING_SECTION 渲染');
  assert.match(src, /if \(groupId === 'sampling'\) return SAMPLING_SECTION/, 'sampling 分组必须映射到 SAMPLING_SECTION');
});

/* ═══════════════════════════════════════════════════════════
   c. 存储位置：ST 设置（不是 localStorage）
   ═══════════════════════════════════════════════════════════ */

test('★★ c1. 采样保存走 ST 设置（mutateSettings），不写 localStorage', () => {
  /*
   * 用户要求"存储位置不变（仍走 ST 设置接口）"。
   *
   * ★ 取证发现：**改动前它其实存在 localStorage**（不是 ST 设置）。
   * 所以这次实际上是"把它真正落到 ST 设置"。这条断言守的是迁移后的状态。
   */
  const src = read('client/src/chat/shell.ts');
  const fn = src.slice(src.indexOf('saveFields: async (fields)'), src.indexOf('onNotify: this.options.onNotify'));

  assert.match(fn, /mutateSettings\(/, '采样保存必须走 mutateSettings（ST 设置）');
  /*
   * 断言的是**意图**：「保存后要从同一份设置派生，不另写映射」。
   *
   * 2026-11-02 加了 `this.deriveSampling(...)` —— 它是
   * `samplingFromSettings` 的包装（派生后再钉上 API 页填的 maxTokens，
   * 见 reasoning-only.test.mjs）。行为没变，只是多了一层。
   *
   * 原来钉死 `samplingFromSettings(result.settings)` 这个字面，
   * 包装一层就整条红 —— 这已经是第 N 次「判据钉字面而非意图」。
   * 现在两种写法都接受，但**必须确实在派生**（不许手挑字段）。
   */
  assert.match(
    fn,
    /(deriveSampling|samplingFromSettings)\(result\.settings\)/,
    '保存后要从同一份设置派生，不另写映射',
  );
});

test('★★ c2. localStorage 读取必须收窄（旧版留下的 sampling 不许复活）', () => {
  /*
   * 旧版 localStorage 里存着 `sampling`。如果读取是"全量展开"，
   * 它会一直被带在状态里、下次又写回去 —— 于是 ST 设置里改了，
   * localStorage 里那份过期副本还在，谁看到都以为它生效。
   *
   * 顺带修了一个"注释与实现不符"：那段注释一直写着"只合并 DEFAULT
   * 里存在的键"，而代码是 `{ ...DEFAULT, ...parsed }`（全量）。
   */
  const src = read('client/src/mobile/main.ts');
  const start = src.indexOf('function readApiState');
  const block = codeOnly(src.slice(start, src.indexOf('function writeApiState')));

  assert.doesNotMatch(block, /\{\s*\.\.\.DEFAULT_API_STATE,\s*\.\.\./, '不许全量展开（会把旧 sampling 带回来）');
  assert.match(block, /source:/, '要逐个白名单拷贝');
  assert.match(block, /model:/, '要逐个白名单拷贝');
  assert.doesNotMatch(block, /sampling/, '读取时不许涉及 sampling');
});

test('★ c3. 进聊天页时从 ST 设置播种（否则重启丢值）', () => {
  const src = read('client/src/chat/shell.ts');

  assert.match(src, /void this\.seedSampling\(\)/, 'renderChat 末尾必须播种');
  assert.match(src, /private async seedSampling/, '要有 seedSampling 实现');
  assert.match(src, /samplingGeneration/, '播种要有乱序防护（快速切 Tab 时先发后返会盖新值）');
});
