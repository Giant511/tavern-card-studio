/**
 * API 连接配置落盘链路的判据（2026-11-04，第二十八批）。
 *
 * ## 用户批准的取证目标
 *
 * > App 点保存后，custom/deepseek-v4-pro 写到了哪里
 * > （App 本地状态 / ST secrets / ST settings 各写没写），
 * > ST 侧 openai/gpt-4-turbo 为何仍是旧值
 *
 * ## 取证结论（改之前的真实状态）
 *
 * | 目标 | 写了吗 | 证据 |
 * |---|---|---|
 * | App 本地状态 | ✅ | `writeApiState` → `localStorage` |
 * | ST secrets | ❌ | `SecretWriter` 接口定义了，`writer.` 在 api-page.ts 里**零引用** |
 * | ST settings | ❌ | 只写过 `max_tokens`，source/model/url 一项没写 |
 *
 * 所以 ST 一直是出厂值。App 内能聊是因为**请求体用本地那份**。
 *
 * ## 这组判据守两条线
 *
 * ```text
 *   写对地方：源 → 正确的 ST 字段（写错字段名 = 保存成功但值为空）
 *   说对话  ：UI 的"已保存"必须由回读校验决定（改之前无条件显示成功）
 * ```
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MODEL_FIELD_BY_SOURCE,
  buildStConnectionPatch,
  secretKeyOf,
  usesCustomUrl,
  verifyConnectionPersisted,
} from '../shared/dist/chat/api-persist.js';
import { buildGenerateRequest } from '../shared/dist/chat/generate.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CHAT_DIR = join(REPO, 'client', 'src', 'chat');
const shellSrc = () => readFileSync(join(CHAT_DIR, 'shell.ts'), 'utf8');
const apiPageSrc = () => readFileSync(join(CHAT_DIR, 'api-page.ts'), 'utf8');

/* ═══════════════════════════════════════════════════════════
   一、源 → ST 字段的映射（写错字段名是最隐蔽的失败）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 六个源的模型字段名逐个核对', () => {
  /*
   * 字段名写错的后果：ST 保存成功、界面显示"已保存"，
   * 但那个源的模型还是空 —— 用户到逃生门一看才发现。
   *
   * 这些名字是从 `public/scripts/openai.js` 与真实 settings 里查来的，
   * 不是猜的。`deepseek_model` / `groq_model` 在出厂 settings 里**没有**，
   * 写进去才出现（所以更容易以为"字段名不对"）。
   */
  assert.equal(MODEL_FIELD_BY_SOURCE.openai, 'openai_model');
  assert.equal(MODEL_FIELD_BY_SOURCE.custom, 'custom_model');
  assert.equal(MODEL_FIELD_BY_SOURCE.deepseek, 'deepseek_model');
  assert.equal(MODEL_FIELD_BY_SOURCE.openrouter, 'openrouter_model');
  assert.equal(MODEL_FIELD_BY_SOURCE.groq, 'groq_model');
  assert.equal(MODEL_FIELD_BY_SOURCE.claude, 'claude_model');
});

test('★★★ secrets 键名是 api_key_<源>（ST 的约定）', () => {
  assert.equal(secretKeyOf('custom'), 'api_key_custom');
  assert.equal(secretKeyOf('openai'), 'api_key_openai');
  assert.equal(secretKeyOf('claude'), 'api_key_claude');
});

/* ═══════════════════════════════════════════════════════════
   二、补丁构造
   ═══════════════════════════════════════════════════════════ */

test('★★★ custom 源写 source + custom_model + custom_url', () => {
  const patch = buildStConnectionPatch({
    source: 'custom',
    model: 'deepseek-v4-pro',
    baseUrl: 'https://ai.ota1245.top/v1',
  });

  assert.equal(patch['chat_completion_source'], 'custom');
  assert.equal(patch['custom_model'], 'deepseek-v4-pro');
  assert.equal(patch['custom_url'], 'https://ai.ota1245.top/v1');
  /* 不许顺手写别的源字段 —— 那会把用户另一套配置改掉 */
  assert.equal('openai_model' in patch, false);
});

test('★★ 非 custom 源不写 custom_url（避免动到用户的地址配置）', () => {
  const patch = buildStConnectionPatch({
    source: 'openai',
    model: 'gpt-4o',
    baseUrl: 'https://example.com/v1',
  });

  assert.equal(patch['chat_completion_source'], 'openai');
  assert.equal(patch['openai_model'], 'gpt-4o');
  assert.equal('custom_url' in patch, false, 'openai 源不该碰 custom_url');
});

test('★★ baseUrl 为空时不写 custom_url（别把用户在 ST 里配的地址清掉）', () => {
  const patch = buildStConnectionPatch({ source: 'custom', model: 'm', baseUrl: '   ' });
  assert.equal('custom_url' in patch, false);
});

test('★★ usesCustomUrl 只对 custom 为真', () => {
  assert.equal(usesCustomUrl('custom'), true);
  for (const source of ['openai', 'deepseek', 'openrouter', 'groq', 'claude']) {
    assert.equal(usesCustomUrl(source), false);
  }
});

/* ═══════════════════════════════════════════════════════════
   三、回读校验
   ═══════════════════════════════════════════════════════════ */

/** 造一份"写入成功之后"的 settings */
function settingsAfter(patch) {
  return { oai_settings: { ...patch } };
}

test('★★★ 写入正确时校验通过', () => {
  const target = { source: 'custom', model: 'deepseek-v4-pro', baseUrl: 'https://ai.ota1245.top/v1' };
  const verdict = verifyConnectionPersisted(settingsAfter(buildStConnectionPatch(target)), {
    ...target,
    keyWritten: true,
  });
  assert.equal(verdict.ok, true, verdict.problems.join('；'));
});

test('★★★ 字段名写错时必须报出来（不能"保存成功"了事）', () => {
  /*
   * 模拟真实故障：把模型写进了 `openai_model`，但源是 custom。
   * 这种错误 POST 会返回 200，ST 也接受了 —— 只有回读能发现。
   */
  const verdict = verifyConnectionPersisted(
    { oai_settings: { chat_completion_source: 'custom', openai_model: 'deepseek-v4-pro' } },
    { source: 'custom', model: 'deepseek-v4-pro', baseUrl: '', keyWritten: true },
  );

  assert.equal(verdict.ok, false, '字段名错位必须报错');
  assert.match(verdict.problems.join('；'), /模型没写进去/);
});

test('★★★ 源没写进去必须报出来', () => {
  const verdict = verifyConnectionPersisted(
    { oai_settings: { chat_completion_source: 'openai', custom_model: 'x' } },
    { source: 'custom', model: 'x', baseUrl: '', keyWritten: true },
  );

  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join('；'), /源没写进去/);
});

test('★★ 地址没写进去必须报出来', () => {
  const verdict = verifyConnectionPersisted(
    { oai_settings: { chat_completion_source: 'custom', custom_model: 'm', custom_url: 'https://old' } },
    { source: 'custom', model: 'm', baseUrl: 'https://new', keyWritten: true },
  );

  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join('；'), /地址没写进去/);
});

test('★★ 没写 key 且 ST 里也没有旧值 → 提醒（否则必然 401）', () => {
  const verdict = verifyConnectionPersisted(
    { oai_settings: { chat_completion_source: 'custom', custom_model: 'm' } },
    { source: 'custom', model: 'm', baseUrl: '', keyWritten: false },
  );

  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join('；'), /秘钥/);
});

test('★★ ST 里已有旧 key 时不重复提醒', () => {
  const verdict = verifyConnectionPersisted(
    { oai_settings: { chat_completion_source: 'custom', custom_model: 'm', proxy_password: 'sk-old' } },
    { source: 'custom', model: 'm', baseUrl: '', keyWritten: false },
  );

  assert.equal(verdict.ok, true, verdict.problems.join('；'));
});

test('★★ 读不回设置时不许当成"校验通过"', () => {
  for (const bad of [null, undefined, 'x', {}, { oai_settings: null }]) {
    const verdict = verifyConnectionPersisted(bad, {
      source: 'custom',
      model: 'm',
      baseUrl: '',
      keyWritten: true,
    });
    assert.equal(verdict.ok, false, `输入 ${JSON.stringify(bad)} 不该判通过`);
  }
});

/* ═══════════════════════════════════════════════════════════
   四、跨层：保存的值 → 生成请求体（同采样参数那次的钉法）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 跨层：保存 custom/deepseek-v4-pro 后，请求体的 source/model 就是它', () => {
  /*
   * 用户要求：
   *
   * > 验收：App 保存 → 生成请求体的 source/model 为新值
   * >（跨层断言，同采样参数那次的钉法）
   *
   * 两层各自被钉住：
   *   ① 保存 → ST settings（本文件上面那些断言）
   *   ② ctx.source/ctx.model → 请求体（下面这条）
   * 而 shell 的 onSave 会把 state.source/model 同时写进 apiState 与 ctx，
   * 所以两段串起来就是"保存的模型 = 请求里的模型"。
   */
  const state = { source: 'custom', model: 'deepseek-v4-pro', baseUrl: 'https://ai.ota1245.top/v1' };

  const built = buildGenerateRequest({
    source: state.source,
    model: state.model,
    messages: [{ role: 'user', content: 'hi' }],
    customUrl: state.baseUrl,
  });

  assert.equal(built.ok, true);
  if (!built.ok) return;

  assert.equal(built.request.chat_completion_source, 'custom', '请求体里的源必须是新值');
  assert.equal(built.request.model, 'deepseek-v4-pro', '请求体里的模型必须是新值');
  assert.equal(built.request.custom_url, 'https://ai.ota1245.top/v1');
});

/* ═══════════════════════════════════════════════════════════
   五、接线：这些事真的被做了吗
   ═══════════════════════════════════════════════════════════ */

test('★★★ onSave 必须真的写 ST（不能只写 localStorage）', () => {
  /*
   * 这是本次缺陷的本体：改之前 `onSave` 的第一步是
   * `this.apiState = state; await onPersistApi(state)` —— 全是本机动作，
   * ST 一次都没碰。所以判据要钉"调用顺序"：
   * **写 ST 必须在写本地之前**。
   */
  const shell = shellSrc();
  const start = shell.indexOf('onSave: async (state, apiKey)');
  assert.ok(start > 0, '找不到 onSave');
  const block = shell.slice(start, start + 2600);

  const stAt = block.indexOf('writeApiConnectionToSt');
  const localAt = block.indexOf('onPersistApi');
  assert.ok(stAt > 0, 'onSave 必须调用 writeApiConnectionToSt');
  assert.ok(localAt > 0, '找不到本地落盘');
  assert.ok(stAt < localAt, '写 ST 必须在写本地之前（ST 是"保存"的实质）');
});

test('★★★ UI 的"已保存"由回读结果决定，不是无条件显示', () => {
  const shell = shellSrc();
  const start = shell.indexOf('onSave: async (state, apiKey)');
  /*
   * 用"下一个标记"当边界，不用固定长度 —— onSave 块里注释很长，
   * 写死 3800 会切掉尾部（第一版就是这么假红的）。
   */
  const end = shell.indexOf('this.apiPageEl = page;', start);
  assert.ok(start > 0 && end > start, '找不到 onSave 的边界');
  const block = shell.slice(start, end);

  assert.match(block, /if \(stOk && localError === null\)/, '成功路径要判断');
  assert.match(block, /只保存到本机/, '失败路径要明说没同步进引擎');

  /*
   * 失败要**弹可见提示**（不能只把一句话写进重绘后的页面）。
   *
   * 断言方式：从"只保存到本机"那句往后 800 字符内必须出现 danger 通知。
   * 不用 `onNotify?.([\s\S]{0,300}danger)` —— 这个块里有多处 onNotify，
   * 第一处到 danger 的距离会超（第一版就是这么假红的）。
   */
  const failBranch = block.slice(block.indexOf('只保存到本机'));
  assert.match(failBranch.slice(0, 800), /onNotify[\s\S]{0,200}danger/, '失败要弹可见提示');
});

test('★★ 秘钥"已配置"标记只在真的写进 ST 时才认', () => {
  /*
   * 改之前无条件 `apiKeyPresent.add()` —— 于是 UI 显示"已配置秘钥"，
   * 而引擎里一个字节都没有，用户发消息才发现 401。
   */
  const shell = shellSrc();
  const start = shell.indexOf('onSave: async (state, apiKey)');
  const block = shell.slice(start, start + 2600);

  assert.match(block, /apiKey !== null && stOk && localError === null/, '标记要带条件');
});

test('★★ 三处都走同一个连接门（不能绕过 withConnection）', () => {
  /*
   * 直接调 `bridge.writeSecret()` 会绕过连接门，第一次保存必然
   * `StUnavailable`（memory §71 记过这个坑，那时表现是"连不上 SillyTavern"）。
   */
  const shell = shellSrc();

  /*
   * ★ 2026-11-09：写秘钥的位置从 `writeApiConnectionToSt` 挪到了
   *   api-page 经注入的 `SecretWriter`（避免两处都写导致 secrets 翻倍）。
   *
   *   **它守的性质没变**：写秘钥必须过连接门，不许直接调 Tauri 命令。
   *   只是现在那道门在**注入处**，所以判据跟到注入处。
   */
  assert.match(
    shell,
    /writeSecret:\s*\(key[^)]*\)\s*=>\s*\n?\s*this\.withConnection\(\(\) => this\.bridge\.writeSecret/,
    '注入给 api-page 的 writeSecret 必须包连接门',
  );

  const start = shell.indexOf('private async writeApiConnectionToSt');
  assert.ok(start > 0);
  const block = shell.slice(start, start + 4000);

  /* 这一层现在只回读校验 —— 校验同样必须过连接门 */
  assert.match(block, /this\.withConnection\(\(\) => this\.bridge\.secretPresent\(\)\)/, '回读要过连接门');
  assert.match(block, /getRaw: \(\) => this\.withConnection/, '读设置要过连接门');
  assert.match(block, /save: \(settings\) => this\.withConnection/, '存设置要过连接门');
});

test('★★ api-page 里那个从未被使用的 SecretWriter 要么用起来、要么别留着骗人', () => {
  /*
   * 取证时发现：`SecretWriter` 接口和 `writer` 参数在 api-page.ts 里
   * **一次都没被使用**（`writer.` 零匹配）。它看起来像"这一页负责写秘钥"，
   * 实际上从来没有 —— 这种"看着像做了"的代码比没有更坏。
   *
   * 现在秘钥写入移到外壳（`writeApiConnectionToSt`），
   * 所以这一页**不该**还挂着一个不用的 writer 参数。
   */
  const page = apiPageSrc();
  const uses = /\bwriter\.\w+\(/.test(page);
  if (uses) return; /* 将来若在这一页内部写了，也算合理 */
  assert.ok(
    !/function renderApiPage\([^)]*writer/.test(page),
    'renderApiPage 还收着 writer 却从不使用 —— 要么用起来，要么删掉',
  );
});

test('★★★ 没填新 key 时不写 secrets（ST 是追加语义，别灌垃圾）', () => {
  /*
   * ST 的 `/api/secrets/write` 是**追加**语义（支持多 key 轮换），
   * 不是覆盖 —— 实测 `secrets.json` 里 `api_key_custom` 是个数组，
   * 每写一次多一条，`active: true` 的那条才生效。
   *
   * 所以"每次点保存都写一遍 key"会灌出一堆重复记录。
   * 判据：只有用户**真的填了新 key**（`apiKey !== null` 且非空）才写。
   */
  const shell = shellSrc();
  const start = shell.indexOf('private async writeApiConnectionToSt');
  assert.ok(start > 0);
  const block = shell.slice(start, start + 2200);

  assert.match(
    block,
    /if \(apiKey !== null && apiKey\.trim\(\) !== ''\)/,
    '写 secrets 必须有"用户填了新 key"这个前置条件',
  );
});
