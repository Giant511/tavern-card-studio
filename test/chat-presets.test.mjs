/**
 * 预设（切换 / 导入）的纯逻辑判据（2026-11-03）。
 *
 * ## 这组测试守的核心缺陷类型
 *
 * **"两套字段名"**：ST 的预设文件里叫 `temperature`，设置里叫 `temp_openai`。
 * 不做映射直接把预设体合并进 `oai_settings`，结果是：
 * 写入了一批 ST 根本不读的键 ⇒ 界面上"导入成功"、下拉里多了一条，
 * 选中它**生成行为一个字节都没变**。
 *
 * 这类缺陷不会报错、不会红、日志里也看不出来 —— 只能靠判据钉住映射。
 *
 * ## 第二个坑：换预设把用户的模型换掉
 *
 * `settingsToUpdate` 里 103 条有 56 条是"连接设置"（模型名、反代地址、key 槽位）。
 * ST 自己在 `bind_preset_to_connection` 为假时会跳过它们。我们照同样规则跳 ——
 * 用户只想换个采样风格，模型被换了是很难归因的"故障"。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PRESET_CONNECTION_KEYS,
  PRESET_KEY_TO_SETTING,
  currentPresetName,
  mergePresetIntoOai,
  parsePresetList,
  planApplyPreset,
  presetKeyToSetting,
  presetBodiesByName,
  presetNameFromFile,
  validatePresetBody,
} from '../shared/dist/chat/presets.js';

/* ═══════════════════════════════════════════════════════════
   一、短名 → 长名
   ═══════════════════════════════════════════════════════════ */

test('★ 短名必须映射成 ST 设置里的长名（否则导入的预设不生效）', () => {
  /*
   * 这张表的出处：`public/scripts/openai.js` 的 `settingsToUpdate`。
   * 这里把 8 条逐个钉死 —— 只断言"表非空"是不够的，
   * 映射写反（`temp_openai → temperature`）同样会过。
   */
  const expected = {
    temperature: 'temp_openai',
    frequency_penalty: 'freq_pen_openai',
    presence_penalty: 'pres_pen_openai',
    top_p: 'top_p_openai',
    top_k: 'top_k_openai',
    top_a: 'top_a_openai',
    min_p: 'min_p_openai',
    repetition_penalty: 'repetition_penalty_openai',
  };

  for (const [short, long] of Object.entries(expected)) {
    assert.equal(
      PRESET_KEY_TO_SETTING[short],
      long,
      `${short} 必须映射到 ${long}（ST 设置里的真实键名）`,
    );
    assert.equal(presetKeyToSetting(short), long);
  }
});

test('同名的键原样返回（seed / n / openai_max_tokens 不该被改）', () => {
  for (const key of ['seed', 'n', 'openai_max_tokens', 'names_behavior', 'verbosity']) {
    assert.equal(presetKeyToSetting(key), key);
  }
});

test('★ 映射表不许把短名映射成短名（写反的典型形态）', () => {
  for (const [short, long] of Object.entries(PRESET_KEY_TO_SETTING)) {
    assert.notEqual(long, short, `${short} 被映射成了自己，等于没映射`);
    assert.match(long, /_openai$|_pen_openai$/, `${short} 的目标 ${long} 不像 ST 的设置键名`);
  }
});

/* ═══════════════════════════════════════════════════════════
   二、切换预设：哪些改、哪些不许改
   ═══════════════════════════════════════════════════════════ */

const SAMPLE_PRESET = {
  temperature: 0.65,
  top_p: 0.9,
  frequency_penalty: 0.25,
  presence_penalty: 0.1,
  repetition_penalty: 1.05,
  top_a: 0.3,
  min_p: 0.02,
  openai_max_tokens: 900,
  seed: -1,
  reasoning_effort: 'medium',
  verbosity: 'low',
  names_behavior: 1,
  squash_system_messages: false,
  prompts: [{ identifier: 'main', content: 'x' }],
  prompt_order: [{ order: [] }],
  // 连接类 —— 这些绝不能跟着预设换
  chat_completion_source: 'openrouter',
  openai_model: 'gpt-4-turbo',
  custom_url: 'https://evil.example/v1',
  reverse_proxy: 'https://another.example',
};

test('★★ 切换预设计算出的写入项：采样参数映射成长名', () => {
  const plan = planApplyPreset(SAMPLE_PRESET, '我的预设');

  assert.equal(plan.updates['temp_openai'], 0.65, 'temperature 必须写成 temp_openai');
  assert.equal(plan.updates['top_p_openai'], 0.9);
  assert.equal(plan.updates['freq_pen_openai'], 0.25);
  assert.equal(plan.updates['pres_pen_openai'], 0.1);
  assert.equal(plan.updates['repetition_penalty_openai'], 1.05);
  assert.equal(plan.updates['top_a_openai'], 0.3);
  assert.equal(plan.updates['min_p_openai'], 0.02);

  /* 同名键原样 */
  assert.equal(plan.updates['openai_max_tokens'], 900);
  assert.equal(plan.updates['seed'], -1);
  assert.equal(plan.updates['reasoning_effort'], 'medium');
  assert.equal(plan.updates['verbosity'], 'low');
  assert.equal(plan.updates['names_behavior'], 1);

  assert.equal(plan.presetName, '我的预设');
});

test('★★★ 切换预设不许改连接设置（模型 / 地址 / 源）', () => {
  const plan = planApplyPreset(SAMPLE_PRESET, 'p');

  for (const key of ['chat_completion_source', 'openai_model', 'custom_url', 'reverse_proxy']) {
    assert.equal(
      key in plan.updates,
      false,
      `${key} 属于连接设置，换预设时绝不能写进 oai_settings（会把用户的模型/接口换掉）`,
    );
    assert.ok(plan.skipped.includes(key), `${key} 应出现在 skipped 里，便于给用户解释"我没动你的模型"`);
  }
});

test('★ 切换预设也不搬 prompts / prompt_order', () => {
  /*
   * 它们是 ST 的提示词列表结构（数组套对象）。我们的 App 不用它，
   * 照搬容易把 ST 那边的顺序弄坏 —— 而用户下次打开 ST 会发现提示词乱了，
   * 完全想不到是 App 做的。
   */
  const plan = planApplyPreset(SAMPLE_PRESET, 'p');
  assert.equal('prompts' in plan.updates, false);
  assert.equal('prompt_order' in plan.updates, false);
});

test('★ 连接设置黑名单必须覆盖 ST 的真实连接键（抽查 + 关键项必须在内）', () => {
  /* 抽查几个"换了会立刻出事"的 */
  for (const key of ['chat_completion_source', 'openai_model', 'claude_model', 'custom_url', 'reverse_proxy', 'proxy_password']) {
    assert.ok(PRESET_CONNECTION_KEYS.has(key), `${key} 必须在连接设置黑名单里`);
  }
  /* 采样参数绝不能被误判成连接设置 */
  for (const key of ['temperature', 'top_p', 'seed', 'n', 'verbosity']) {
    assert.equal(PRESET_CONNECTION_KEYS.has(key), false, `${key} 是采样参数，不该在连接黑名单里`);
  }
});

test('mergePresetIntoOai 返回新对象，且写入 preset_settings_openai', () => {
  const before = { temp_openai: 1, top_p_openai: 1, chat_completion_source: 'openai' };
  const plan = planApplyPreset(SAMPLE_PRESET, '新预设');
  const after = mergePresetIntoOai(before, plan);

  assert.notEqual(after, before, '必须返回新对象');
  assert.equal(before['temp_openai'], 1, '原对象不许被改');
  assert.equal(after['temp_openai'], 0.65);
  assert.equal(after['preset_settings_openai'], '新预设');
  assert.equal(
    after['chat_completion_source'],
    'openai',
    '连接设置保持原值（预设里的 openrouter 不许覆盖它）',
  );
});

test('预设体不是对象时给空计划（不炸）', () => {
  for (const bad of [null, undefined, 42, 'x', []]) {
    const plan = planApplyPreset(bad, 'p');
    assert.deepEqual(plan.updates, {}, `${String(bad)} 应得到空 updates`);
    assert.equal(plan.presetName, 'p');
  }
});

/* ═══════════════════════════════════════════════════════════
   三、导入前的校验
   ═══════════════════════════════════════════════════════════ */

test('★★ 导错文件要拒绝并说清原因（不能静默 200）', () => {
  /*
   * `POST /api/presets/save` 对内容不做任何校验，传 `{}` 也 200。
   * 所以"像不像预设"必须我们自己判 —— 否则用户导了个角色卡，
   * 界面报成功、下拉多一条、选中毫无变化。
   */
  assert.equal(validatePresetBody({}).ok, false, '空对象要拒绝');
  assert.equal(validatePresetBody(null).ok, false);
  assert.equal(validatePresetBody([]).ok, false, '数组要拒绝');
  assert.equal(validatePresetBody('text').ok, false);

  const card = { name: '角色', description: '...', first_mes: '...' };
  const verdict = validatePresetBody(card);
  assert.equal(verdict.ok, false, '角色卡不是预设，要拒绝');
  if (!verdict.ok) {
    assert.match(verdict.reason, /角色卡|不认识|没有/, '拒绝理由要让人看懂');
  }
});

test('★ 认得真预设（含只改一个参数的）', () => {
  assert.equal(validatePresetBody({ temperature: 0.5 }).ok, true);
  assert.equal(validatePresetBody(SAMPLE_PRESET).ok, true);

  const only = validatePresetBody({ temperature: 0.5 });
  assert.equal(only.ok, true);
  if (only.ok) assert.equal(only.fieldCount, 1);
});

/* ═══════════════════════════════════════════════════════════
   四、读预设清单（三种返回形态都要认）
   ═══════════════════════════════════════════════════════════ */

test('★★ 清单解析：数组 / 对象 / 字符串化 三种形态都要认', () => {
  /*
   * 只认一种的实现会在换 ST 版本时**静默给空列表** ——
   * 界面表现是"一个预设都没有"，而用户明明装了一堆。
   * 那种缺陷没有任何报错，只能靠"三种形态都喂一遍"来防。
   *
   * ★★★ 2026-11-03 真机修正：**每一项也是 JSON 字符串**，不是对象。
   *
   * 下面是真机 `/api/settings/get` 的实测形状：
   *
   * ```text
   *   openai_setting_names = ["Default"]
   *   openai_settings      = ["{\n  \"chat_completion_source\": \"openai\", ... }"]
   *                          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ typeof === 'string'
   * ```
   *
   * 第一版的测试喂的是**对象**，所以实现按对象写也全绿 ——
   * 而真机上每一项都被跳过，切换预设时报"找不到名为 X 的预设"。
   * 这就是「桩比真实更宽容」造成的假绿（memory §60 / §74.3 同类）。
   *
   * 所以这里**主要**用字符串形态断言，对象形态只作兼容性覆盖。
   */
  /* 主用例：真机形态（body 是字符串） */
  const modernReal = {
    openai_setting_names: ['Default', 'Creative'],
    openai_settings: [JSON.stringify({ temperature: 1 }), JSON.stringify({ temperature: 1.3, top_p: 0.9 })],
  };
  const real = parsePresetList(modernReal);
  assert.deepEqual(real.map((one) => one.name), ['Default', 'Creative']);
  assert.equal(real[1].fieldCount, 2, '字符串形态的预设体也要能数出字段数');

  /* 兼容：body 是对象（早期/别家分支） */
  const modernObjects = {
    openai_setting_names: ['Default', 'Creative'],
    openai_settings: [{ temperature: 1 }, { temperature: 1.3, top_p: 0.9 }],
  };
  const list1 = parsePresetList(modernObjects);
  assert.deepEqual(list1.map((one) => one.name), ['Default', 'Creative']);
  assert.equal(list1[1].fieldCount, 2);

  const legacy = {
    openai_setting_names: { Default: 0, Creative: 1 },
    openai_settings: [JSON.stringify({ temperature: 1 }), JSON.stringify({ temperature: 1.3 })],
  };
  const list2 = parsePresetList(legacy);
  assert.deepEqual(list2.map((one) => one.name), ['Default', 'Creative']);

  const stringified = {
    openai_setting_names: ['Default'],
    openai_settings: JSON.stringify([{ temperature: 1, n: 1 }]),
  };
  const list3 = parsePresetList(stringified);
  assert.equal(list3.length, 1);
  assert.equal(list3[0].fieldCount, 2, '整个数组字符串化时也要能数出字段数');
});

test('★★★ 预设体取出来必须是对象（真机给的是 JSON 字符串）', () => {
  /*
   * 这条钉的是 `presetBodiesByName` —— 切换预设要靠它拿到"那份预设的内容"。
   *
   * 若实现只认对象，真机上每一项都被跳过 ⇒ `applyPreset` 报
   * "找不到名为「Creative」的预设"，而列表里明明有它。
   * 真机探针第 ④ 条（`.verify/probe-preset-api.mjs`）抓到了这个问题。
   */
  const payload = {
    openai_setting_names: ['Default', 'Creative'],
    openai_settings: [JSON.stringify({ temperature: 1 }), JSON.stringify({ temperature: 1.3, top_p: 0.9 })],
  };

  const bodies = presetBodiesByName(payload);
  assert.deepEqual(Object.keys(bodies).sort(), ['Creative', 'Default']);

  const creative = bodies['Creative'];
  assert.equal(typeof creative, 'object', '取出来的预设体必须是对象，不能是字符串');
  assert.equal(creative['temperature'], 1.3);
  assert.equal(creative['top_p'], 0.9);

  /* 对象形态也要认 */
  const legacy = presetBodiesByName({
    openai_setting_names: ['Default'],
    openai_settings: [{ temperature: 2 }],
  });
  assert.equal(legacy['Default']['temperature'], 2);

  /* 坏 JSON 只丢掉那一项，不影响其它项 */
  const withBroken = presetBodiesByName({
    openai_setting_names: ['Good', 'Broken'],
    openai_settings: [JSON.stringify({ temperature: 1 }), '{ 这不是 JSON'],
  });
  assert.deepEqual(Object.keys(withBroken), ['Good'], '坏的那一项要被跳过，不能连累好的');
});

test('清单解析遇到垃圾数据给空数组，不抛', () => {
  for (const bad of [null, undefined, 42, 'x', {}, { openai_setting_names: 5 }]) {
    assert.deepEqual(parsePresetList(bad), []);
  }
});

test('取当前预设名', () => {
  assert.equal(currentPresetName({ oai_settings: { preset_settings_openai: 'Default' } }), 'Default');
  assert.equal(currentPresetName({ oai_settings: {} }), '');
  assert.equal(currentPresetName(null), '');
  assert.equal(currentPresetName({ oai_settings: { preset_settings_openai: 3 } }), '', '非字符串一律给空');
});

/* ═══════════════════════════════════════════════════════════
   五、从文件名推预设名
   ═══════════════════════════════════════════════════════════ */

test('★ 预设名从文件名推出，只去最后一个扩展名（与 ST 一致）', () => {
  assert.equal(presetNameFromFile('Creative.json'), 'Creative');
  assert.equal(presetNameFromFile('我的.预设.json'), '我的.预设', '只去掉最后一个扩展名');
  assert.equal(presetNameFromFile('  spaced .json'), 'spaced');
  assert.equal(presetNameFromFile('noext'), 'noext');
});
