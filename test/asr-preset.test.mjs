/**
 * ASR 预设模板表（v0.1.7 / T15.6，2026-10-29 定稿）单测。
 *
 * ## 这组测试守的是什么
 *
 * 定稿给了 8 个条目的 base_url / model / 标注。**逐字钉住**，因为：
 * - base_url 拼错一个字符，用户拿到的是 404，而提示会说"该中转站不支持转写" ——
 *   归因完全错（实际是我们拼错了）；
 * - model 名写错，拿到 400/404，同样归因错。
 *
 * 这类错误**不会在本机报错**，只会在用户手机上表现为"配了不能用"。
 *
 * 第二类测试守的是几条**刻意的设计取舍**（DeepSeek 不出现、中转站独立成条、
 * 空 model 不猜），它们的共同点是"看起来可以偷懒但故意没偷"。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ALL_ASR_PRESETS,
  ASR_ADVANCED_PRESETS,
  ASR_PRESETS,
  ASR_QUICK_GUIDE,
  ASR_RELAY_MODEL_HINT,
  ASR_RELAY_PRESET,
  ASR_RELAY_PRIVACY_NOTE,
  CHAT_RELAY_NOTE,
  TEXT_ONLY_VENDORS_NOTE,
  findAsrPreset,
  presetsForMode,
  requiresManualInput,
  validateAsrConfig,
} from '@tcs/shared';

/* ───────────── 定稿原文逐字钉 ───────────── */

test('★ 四条 OpenAI 兼容主模板的 base_url / model / 标注与定稿逐字一致', () => {
  /*
   * 这张表是"定稿"，所以测试里**再写一遍期望值**是故意的：
   * 如果有人为了"让测试过"去改代码里的常量，这里会红。
   */
  const expected = [
    {
      id: 'aliyun-paraformer',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      /*
       * ★ 2026-11-07 改：`paraformer-v2` → `qwen3-asr-flash`。
       *
       * 用户报「百炼改接入方式了，原来的地址已停止维护」，实测确认：
       *
       * ```text
       *   /compatible-mode/v1/audio/transcriptions  → 404（端点不存在）
       *   /compatible-mode/v1 下已无 paraformer-v2（/models 182 个里没有它）
       *   原生 multimodal-generation + qwen3-asr-flash → 200
       * ```
       *
       * 所以定稿表本身要跟着厂商改。这里**仍然逐字钉住**，
       * 只是钉的是"现在正确的那一版"—— 判据的意图（不许为了让测试过而
       * 偷改常量）没变。
       */
      model: 'qwen3-asr-flash',
      note: '国内直连 · 中文最强',
      /*
       * 百炼换协议了（2026-11-07）：它不再走 OpenAI 兼容的
       * `/audio/transcriptions`（实测 404），改走阿里原生的
       * `multimodal-generation`。其余三条仍是 multipart。
       */
      protocol: 'dashscope-audio',
    },
    {
      id: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'whisper-large-v3-turbo',
      note: '免费额度大 · 速度快 · 需海外网络',
      protocol: 'transcriptions',
    },
    {
      id: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'whisper-1',
      note: '需海外网络与外币付费',
      protocol: 'transcriptions',
    },
    {
      id: 'whisper-cpp',
      baseUrl: '',
      model: '',
      note: '隐私优先 · 需自建服务',
      protocol: 'transcriptions',
    },
  ];

  /*
   * 2026-11-01 第六批：主模板多了第 5 条（`funasr-local`，gradio 路线）。
   * 判据的意图不变 —— **这四条 OpenAI 兼容模板逐字钉住**，
   * 新增的那条单独一张测试，不从这张表的长度推断。
   */
  assert.ok(ASR_PRESETS.length >= expected.length, '主模板条数不该少于定稿的四条');
  for (const [index, want] of expected.entries()) {
    const preset = ASR_PRESETS[index];
    assert.equal(preset.id, want.id);
    assert.equal(preset.baseUrl, want.baseUrl, `${want.id} 的 base_url 不一致`);
    assert.equal(preset.model, want.model, `${want.id} 的 model 不一致`);
    assert.equal(preset.note, want.note, `${want.id} 的标注不一致`);
    assert.equal(preset.protocol, want.protocol, `${want.id} 的 protocol 不一致`);
    assert.equal(preset.advanced, false);
  }
});

test('★ 两条高级模板与定稿一致（Qwen-Audio / Gemini）', () => {
  const qwen = findAsrPreset('qwen-audio');
  assert.ok(qwen !== null);
  /*
   * ★ 2026-11-07 实测：`qwen-audio-turbo` + `chat-audio` 整条线都不能用了。
   *
   * ```json
   * {"code":"model_not_supported",
   *  "message":"Unsupported model `qwen-audio-turbo` for OpenAI compatibility mode."}
   * ```
   *
   * 所以它与百炼主模板一起换成阿里原生协议，模型用 `qwen-audio-3.0-asr-flash`。
   */
  assert.equal(qwen.protocol, 'dashscope-audio');
  assert.equal(qwen.model, 'qwen-audio-3.0-asr-flash');
  assert.equal(qwen.note, '抗噪 · 听懂语气词');
  assert.equal(qwen.advanced, true);

  const gemini = findAsrPreset('gemini');
  assert.ok(gemini !== null);
  assert.equal(gemini.protocol, 'chat-audio');
  assert.equal(gemini.note, '海外');
  /*
   * Gemini 的 model **故意留空**：模型 ID 随版本滚动得很快。
   * 写死一个必然过期，而"填了个过期的默认值"比"要求手填"更糟 ——
   * 用户会以为选了就能用。
   */
  assert.equal(gemini.model, '', 'Gemini 的 model 不该被填成固定值');
});

test('★ 阿里排在第一位（排序本身就是一次引导）', () => {
  /*
   * 目标用户是中文用户，"国内直连"是第一个筛选项。
   * 如果有人按字母序重排（aliyun 恰好还是第一，所以换个断言角度）：
   * 断言的是**第一个是阿里且标注含"国内"**，而不是"数组按字母序"。
   */
  assert.equal(ASR_PRESETS[0].id, 'aliyun-paraformer');
  assert.match(ASR_PRESETS[0].note, /国内/);
});

/* ───────────── 几条刻意的取舍 ───────────── */

test('★ DeepSeek / Kimi 等纯文本厂商**不出现在选项里**（定稿口径）', () => {
  /*
   * 这是与初版口径的差别：补丁 §F4 原写"配置页给出此提示"，
   * 我第一版理解为"列在下拉里然后提示不可用"。
   * 定稿改为**选项里不出现**，只在使用说明里解释。
   *
   * 为什么后者更好：列出来再报错，用户要先选、填 key、测试、失败，
   * 才知道此路不通。说明里的一句话是在他动手之前就排除掉。
   */
  const textOnly = ['deepseek', 'kimi', 'moonshot', 'zhipu', 'baichuan'];
  for (const id of textOnly) {
    assert.equal(findAsrPreset(id), null, `${id} 不该出现在语音预设里`);
  }
  // 但说明文案必须有，且要给出正确位置
  assert.match(TEXT_ONLY_VENDORS_NOTE, /DeepSeek/);
  assert.match(TEXT_ONLY_VENDORS_NOTE, /没有语音识别能力/);
  assert.match(TEXT_ONLY_VENDORS_NOTE, /聊天后端/, '只说"不能用"会让用户以为 key 白买了');
});

test('★ 中转站是**独立条目**，不是"改某个厂商的 base_url"', () => {
  /*
   * 因为"中转站 base_url + 直连厂商的 model 名"是必然失败的组合：
   * 中转站的模型 ID 是它自己起的名字。混在一条里，用户会填出这种组合然后 404。
   */
  assert.equal(ASR_RELAY_PRESET.id, 'relay');
  assert.equal(ASR_RELAY_PRESET.baseUrl, '', '中转站的 base_url 必须手填');
  assert.equal(ASR_RELAY_PRESET.model, '', '中转站的 model 必须手填');
  assert.match(ASR_RELAY_MODEL_HINT, /模型名填你站里对应的 ID/);
  assert.match(ASR_RELAY_MODEL_HINT, /兼容 OpenAI 接口/);
});

test('★ 中转站两个模式都要出现（转写与 chat 都可能被中转）', () => {
  const basic = presetsForMode(false);
  const advanced = presetsForMode(true);
  assert.ok(basic.some((p) => p.id === 'relay'), '主模式缺中转站');
  assert.ok(advanced.some((p) => p.id === 'relay'), '高级模式缺中转站');
});

test('配置指引是一句话，且点明了两个主机厂商', () => {
  assert.equal(ASR_QUICK_GUIDE, '国内网络选阿里，有海外网络选 Groq。');
});

test('中转站隐私补充文案必须存在（否则"隐私优先"是空头承诺）', () => {
  assert.match(ASR_RELAY_PRIVACY_NOTE, /音频会经过第三方服务器/);
});

test('聊天侧的中转站说明只加一句话，不额外开发', () => {
  assert.match(CHAT_RELAY_NOTE, /OpenAI 兼容中转站/);
  assert.match(CHAT_RELAY_NOTE, /自定义/);
});

/* ───────────── 字段填充判定 ───────────── */

test('requiresManualInput 能分别指出 base_url 与 model 是否要手填', () => {
  const aliyun = findAsrPreset('aliyun-paraformer');
  assert.ok(aliyun !== null);
  assert.deepEqual(requiresManualInput(aliyun), { baseUrl: false, model: false });

  const whisperCpp = findAsrPreset('whisper-cpp');
  assert.ok(whisperCpp !== null);
  assert.deepEqual(requiresManualInput(whisperCpp), { baseUrl: true, model: true });

  const gemini = findAsrPreset('gemini');
  assert.ok(gemini !== null);
  // base_url 有默认，model 要手填
  assert.deepEqual(requiresManualInput(gemini), { baseUrl: false, model: true });
});

test('★ 校验要指出**缺哪个字段**，不是一句"请填写完整"', () => {
  /*
   * 用户点保存被拦时，要能一眼看到是 base_url 空着还是 model 空着。
   */
  const allMissing = validateAsrConfig({ presetId: 'relay', baseUrl: '', model: '', apiKey: '' });
  assert.equal(allMissing.ok, false);
  assert.deepEqual(allMissing.missing, ['baseUrl', 'apiKey', 'model']);

  const onlyKey = validateAsrConfig({
    presetId: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3-turbo',
    apiKey: '',
  });
  assert.equal(onlyKey.ok, false);
  assert.deepEqual(onlyKey.missing, ['apiKey']);

  const ok = validateAsrConfig({
    presetId: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3-turbo',
    apiKey: 'gsk_xxx',
  });
  assert.deepEqual(ok, { ok: true });
});

test('纯空白的字段算没填（不能靠打空格混过去）', () => {
  const result = validateAsrConfig({
    presetId: 'relay',
    baseUrl: '   ',
    model: '\t',
    apiKey: '  ',
  });
  assert.equal(result.ok, false);
  assert.equal(result.missing.length, 3);
});

/* ───────────── 表的自洽性 ───────────── */

test('预设 id 全局唯一，且都能被 findAsrPreset 找到', () => {
  const ids = ALL_ASR_PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length, '有重复 id');
  for (const id of ids) {
    assert.ok(findAsrPreset(id) !== null, `${id} 找不到`);
  }
});

test('每个预设的标注都非空（没有空标注的选项）', () => {
  /*
   * 空标注等于让用户在一个没有说明的下拉里盲选。
   */
  for (const preset of ALL_ASR_PRESETS) {
    assert.notEqual(preset.note.trim(), '', `${preset.id} 缺标注`);
  }
});

test('protocol 有四种取值，且与「主/高级」分组一致', () => {
  /*
   * 2026-11-01 第六批：新增第三条路线 `gradio`（决策 #338）。
   * 2026-11-07：新增第四条 `dashscope-audio`（百炼换接入方式）。
   *
   * 判据仍然是"分组与协议要自洽"，但**不能再用一条 `=== 'transcriptions'`
   * 断言** —— 每加一条路线都要回来改这里，而这正是它该有的作用：
   * 加协议时没人能"忘了说一声"。
   *
   * 分组口径：
   * ```text
   *   主模板    transcriptions（multipart）/ gradio（自建）/ dashscope-audio（百炼）
   *   高级模板  dashscope-audio / chat-audio
   * ```
   * 主模板里允许 dashscope-audio：它是"国内首选"，门槛不比别人高。
   * 高级里不再限定 `chat-audio` —— Gemini 仍是 chat，但百炼那两条换协议了。
   */
  const MAIN_OK = ['transcriptions', 'gradio', 'dashscope-audio'];
  const ADV_OK = ['chat-audio', 'dashscope-audio'];

  for (const preset of ASR_PRESETS) {
    assert.ok(MAIN_OK.includes(preset.protocol), `${preset.id} 主模板协议不在允许集合内`);
  }
  for (const preset of ASR_ADVANCED_PRESETS) {
    assert.ok(ADV_OK.includes(preset.protocol), `${preset.id} 高级模板协议不在允许集合内`);
  }

  /* 四种取值都至少要有一条实例，否则"四种取值"这句话是空的 */
  const all = [...ASR_PRESETS, ...ASR_ADVANCED_PRESETS];
  for (const protocol of ['transcriptions', 'chat-audio', 'gradio', 'dashscope-audio']) {
    assert.ok(all.some((p) => p.protocol === protocol), `缺少 ${protocol} 路线的预设`);
  }
});

test('findAsrPreset 对未知 id 返回 null（不抛错：配置里可能存着旧 id）', () => {
  assert.equal(findAsrPreset('no-such-vendor'), null);
  assert.equal(findAsrPreset(''), null);
});
