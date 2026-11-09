/**
 * 百炼新接入方式的判据（2026-11-07）。
 *
 * 用户要求：「阿里百炼现在改接入方式了，原来的那个地址已经停止维护了…
 * 你要根据最新的厂商文档进行接入」。
 *
 * 这一批有三类风险，全部来自**真实实测**：
 *
 * ```text
 *   ① 老协议还在（/audio/transcriptions）  → 404，而文案会说"地址填错了"
 *   ② 没注入 nativeFetch                   → 真机上所有语音方式都报"网络请求失败"
 *   ③ blur 抹掉刚输入的 key                → 保存时当成"没改"，提示"没有输入秘钥"
 * ```
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ASR_PRESETS,
  ASR_ADVANCED_PRESETS,
  ASR_RELAY_PRESET,
  findAsrPreset,
} from '../shared/dist/asr/preset-table.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/* ═══════════════════════════════════════════════════════════
   ① 协议与预设
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 百炼不能再用 OpenAI 兼容的 /audio/transcriptions', () => {
  /*
   * 实测（真实 key，2026-11-07）：
   *
   * ```text
   *   POST {base}/audio/transcriptions                  → 404（端点根本不存在）
   *   POST {base}/api/v1/services/aigc/
   *        multimodal-generation/generation
   *        model=qwen3-asr-flash                       → 200 {"output":{...},"text":"嗯。"}
   * ```
   *
   * 用户手上那把 key 是 `sk-ws-…` 的专属实例 key，两个域名
   * （通用 dashscope / 专属 ws-*）**都能通**，所以不该把实例域名写死进预设。
   */
  const p = findAsrPreset('aliyun-paraformer');
  assert.ok(p !== null, '百炼那条预设还要在（id 不能改，老配置指着它）');
  assert.equal(p.protocol, 'dashscope-audio', '必须换成原生多模态协议');
  assert.equal(p.model, 'qwen3-asr-flash', 'paraformer-v2 已不在模型列表里');
});

test('★★★★★ 预设 id 的一个字都不许改（改了老用户配置就失效）', () => {
  /* 三条线各有一组：主模板 / 高级 / 中转站 —— 缺一组就等于少一类能力 */
  const ids = [
    ...ASR_PRESETS.map((one) => one.id),
    ...ASR_ADVANCED_PRESETS.map((one) => one.id),
    ASR_RELAY_PRESET.id,
  ];
  for (const must of ['aliyun-paraformer', 'groq', 'openai', 'qwen-audio', 'funasr-local']) {
    assert.ok(ids.includes(must), `缺预设 id：${must}（改 id 等于让老配置失效）`);
  }
});

test('★★★★ Qwen-Audio 那条也不能停在已下架的模型上', () => {
  /*
   * 实测：`qwen-audio-turbo` 走 chat/completions 返回
   *
   * ```json
   * {"code":"model_not_supported",
   *  "message":"Unsupported model `qwen-audio-turbo` for OpenAI compatibility mode."}
   * ```
   *
   * 整条线都不在兼容层里了，不是模型名写错。
   */
  const p = findAsrPreset('qwen-audio');
  assert.ok(p !== null);
  assert.notEqual(p.model, 'qwen-audio-turbo', 'qwen-audio-turbo 已下架');
  assert.equal(p.protocol, 'dashscope-audio');
});

/* ═══════════════════════════════════════════════════════════
   ② 真机上必须走原生桥
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 语音转写必须走原生 HTTP 桥（WebView 的 fetch 不通）', () => {
  /*
   * 这一条是**最严重的**：修之前，所有语音方式在真机上都不可能成功。
   *
   * 真机现象：点「测试连接」永远显示
   * 「网络请求失败。请检查网络连接，或确认这个地址可达。」
   * —— 而同一把 key 用 curl 打同一个地址是 200。
   *
   * 真因：这个 WebView 的网络栈没通（memory §104）。项目里认证 / 仓库 / 同步
   * 全部走 `nativeFetch`，**唯独语音转写漏了**。
   */
  const src = stripComments(read('client/src/chat/asr-client.ts'));

  assert.match(src, /from '\.\/native-fetch\.ts'/, '要引入 nativeFetch');
  assert.match(src, /hasNativeHttp\(\)/, '要判有没有原生通道');
  assert.match(src, /pickFetch\(/, '要有统一的 fetch 选型');
  /*
   * 关键：选型必须是"桥优先"。
   *
   * `pickFetch` 内部的最后一档回落到 `globalThis.fetch` 是**对的**
   * （桌面预览没有原生桥），错的是"无条件回落到它"。
   * 所以断言语义：`hasNativeHttp()` 必须在 `globalThis.fetch` 之前出现。
   */
  const pickAt = src.indexOf('function pickFetch');
  assert.ok(pickAt > 0, '要有 pickFetch');
  const pickBlock = src.slice(pickAt, src.indexOf('\n}', pickAt));
  const bridgeAt = pickBlock.indexOf('hasNativeHttp()');
  const globalAt = pickBlock.indexOf('globalThis.fetch');
  assert.ok(bridgeAt > 0 && globalAt > 0, '两档都要在');
  assert.ok(bridgeAt < globalAt, '原生桥必须在 globalThis.fetch 之前');
});

test('★★★★★ multipart 也必须在真机上能发（不许只发字符串）', () => {
  /*
   * ★ 这一条改过一次口径（2026-11-07），过程值得记：
   *
   * 第一版发现"原生桥只收字符串 body"之后，我选择**拦住 multipart 并给提示**。
   * 那个决定是错的 —— 它让 Groq / OpenAI / 本地 whisper.cpp / 中转站
   * 四种方式在真机上**全部不可用**（真机实测 9 种只有 2 种能用）。
   *
   * 正确做法是把桥扩成能发二进制：`FormData` → `new Response(form)`
   * → arrayBuffer → base64 → 原生侧 `bodyBase64` 解码后写出。
   *
   * 所以判据从"要拦住"改成"要支持"：
   * ```text
   *   native-fetch: 认 FormData、转 base64、Content-Type 取 Response 生成的那个
   *   StBridge.kt : 认 bodyBase64、解码后写字节
   * ```
   */
  const bridge = stripComments(read('client/src/chat/native-fetch.ts'));
  assert.match(bridge, /instanceof FormData/, '原生 fetch 要认 FormData');
  assert.match(bridge, /bodyBase64/, '要把表单转成 base64');
  assert.match(bridge, /encoded\.headers\.get\('content-type'\)/, 'Content-Type 必须取 Response 生成的那个（含 boundary）');
  assert.match(bridge, /bytesToBase64/, '要有字节→base64（分块，避免超大参数）');

  const kotlin = read('client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StBridge.kt');
  assert.match(kotlin, /bodyBase64/, 'Kotlin 侧要认 bodyBase64');
  assert.match(kotlin, /Base64\.decode/, '要解码成字节再写');

  /* 反向：不许再有"拦住 multipart"的临时方案 */
  const src = stripComments(read('client/src/chat/asr-client.ts'));
  assert.doesNotMatch(src, /multipartUnavailable/, '临时拦截要撤掉（能力已经有了）');
});

/* ═══════════════════════════════════════════════════════════
   ③ 填了 key 却说没填
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 失焦时不许抹掉刚输入的 key', () => {
  /*
   * 用户原话：「我填入秘钥并保存后提示没有输入秘钥」。
   *
   * 真因：
   * ```text
   *   keyStateOnBlur(...) 正确返回 'editing'（注释都写着"保存时要读它"）
   *   ↓
   *   paintKeyField() 无条件执行 keyInput.value = keyFieldValue(state)
   *   ↓
   *   keyFieldValue('editing') === ''   ← 值被抹掉
   *   ↓
   *   保存时 keyToSave('') → null → 当作"这次没改 key" → 报"还没有 key"
   * ```
   *
   * ★ 为什么探针测不出来：脚本用 `element.click()` 不移动焦点、不触发 blur。
   *   **只有真手指能复现**。
   */
  const src = stripComments(read('client/src/chat/voice-settings.ts'));

  assert.match(src, /keepTyped/, '要区分"填了内容"与"没填"');
  assert.match(
    src,
    /const keepTyped = next === 'editing' && \(keyInput\.value \?\? ''\)\.trim\(\) !== ''/,
    '判据是"状态与内容同时满足"',
  );

  /*
   * 位置关系：blur 处理器里 `keepTyped` 为真时必须 **return 在前**、
   * `paintKeyField()` 在后 —— 反了就等于没修。
   */
  const blurAt = src.indexOf("addEventListener?.('blur'");
  assert.ok(blurAt > 0, '要找到 blur 处理器');
  const blurBlock = src.slice(blurAt, src.indexOf('});', blurAt));
  const returnAt = blurBlock.indexOf('return;');
  const paintAt = blurBlock.indexOf('paintKeyField()');
  assert.ok(returnAt > 0 && paintAt > 0, 'blur 里两段都要在');
  assert.ok(returnAt < paintAt, '填了内容的分支必须先 return，否则照样被清空');
});

/* ═══════════════════════════════════════════════════════════
   ④ 阿里原生请求的形状
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 阿里原生请求必须带 parameters.format', () => {
  /*
   * 实测同一段静音音频、同一把 key：
   *
   * ```text
   *   qwen-audio-3.0-asr-flash  parameters={}              → 400 UNSUPPORTED_FORMAT
   *                                                            "format is empty"
   *   qwen-audio-3.0-asr-flash  parameters={format:'wav'}  → 400 ASR_RESPONSE_HAVE_NO_WORDS
   *                                                            （静音没词 ⇒ 它跑通了）
   *   fun-asr-flash-*           同 上
   *   qwen3-asr-flash           带不带都是 200
   * ```
   *
   * 少了这个字段，三个模型里有一个能用两个报错 —— 而报错名字
   * `UNSUPPORTED_FORMAT` 会把人引向"音频编码不对"，实际只是少个元数据。
   */
  const src = stripComments(read('client/src/chat/asr-client.ts'));
  assert.match(src, /parameters: \{ format: formatOf\(mime\) \}/, '要带 parameters.format');
  assert.match(src, /function formatOf\(/, '要有 MIME → 格式名的换算');
});

test('★★★★ 阿里原生请求的音频要带 data: 前缀（不带会 400 空 body）', () => {
  /*
   * 实测：`content[].audio` 只给裸 base64 → `400 {}`（空 body，无任何提示）。
   * 这个失败形态极难查 —— 看起来像地址错或 key 错，实际只是少个 MIME 段。
   */
  const src = stripComments(read('client/src/chat/asr-client.ts'));
  assert.match(src, /audio: `data:\$\{mime\};base64,\$\{base64\}`/, '音频要带 data: 前缀');
});

test('★★★★ 阿里原生结果从 output.choices 里取', () => {
  /*
   * 响应形状：`{"output":{"choices":[{"message":{"content":[{"text":"嗯。"}]}}]}}`
   * —— 比 OpenAI 多包了一层 `output`。取错层级会得到"看不懂的内容"。
   */
  const src = stripComments(read('client/src/chat/asr-client.ts'));
  /*
   * ★ 不能按 `protocol === 'dashscope-audio'` 找 —— 那字符串在
   *   `buildAsrEndpoint` 里**也有一处**，`indexOf` 取到的是拼地址那段，
   *   于是断言看错了对象（这个错误在本项目已犯过 N 次）。
   *   直接按"解析"标志找。
   */
  const at = src.indexOf('const output = (json as');
  assert.ok(at > 0, '要有一支在解析 dashscope-audio 的响应');
  const block = src.slice(at, at + 900);
  /*
   * 实际代码是 `const output = (json as {output?:{choices?:unknown}}).output;`
   * 然后 `const choices = output?.choices;` —— 所以判据要认这个两步写法，
   * 不能死盯 `output?.choices` 一个字面量（第一版就是这么误报的）。
   */
  assert.match(block, /\.output;/, '要先取出 output');
  assert.match(block, /choices = output\?\.choices/, '再从 output 里取 choices');
});

test('★★★★ base 里的 /compatible-mode/v1 要剥掉再拼原生路径', () => {
  /*
   * ```text
   *   用户填  https://dashscope.aliyuncs.com/compatible-mode/v1
   *   实际打  https://dashscope.aliyuncs.com/api/v1/services/aigc/...
   * ```
   *
   * 不剥的话会拼出 `…/compatible-mode/v1/api/v1/…` —— 404。
   */
  const src = stripComments(read('client/src/chat/asr-client.ts'));
  assert.match(src, /compatible-mode\\\/v1\$/, '要剥掉兼容层前缀');
  assert.match(src, /DASHSCOPE_AUDIO_PATH/, '原生路径要是一个具名常量（两处用同一份）');
});

test('★★★★★ 阿里说"没听到词"要算成功，不是故障', () => {
  /*
   * 实测（2026-11-07，合成测试音）：
   *
   * ```text
   *   qwen-audio-3.0-asr-flash  → HTTP 400
   *        {"code":"CLIENT_ERROR","message":"ASR_RESPONSE_HAVE_NO_WORDS"}
   *   fun-asr-flash-*           同上
   * ```
   *
   * 这不是故障：服务收到音频、做了识别、结论是"没有可识别的词"。
   * 而设置页的内置测试音**本来就是合成音**，所以用户点「测试连接」
   * 必然撞上它 —— 按状态码归类就会报"未能识别的问题（400）"，
   * 用户以为坏了，实际链路完全正常。
   *
   * 所以必须翻译成 `ok: true` + 空文本，让上层说"没听到内容"。
   */
  const src = stripComments(read('client/src/chat/asr-client.ts'));
  assert.match(src, /ASR_RESPONSE_HAVE_NO_WORDS/, '要识别这个 code');
  /*
   * 位置关系：它必须在 `classifyAsrFailure` **之前**处理 ——
   * 反了就等于没修（照样落到 400 的分类里）。
   */
  const at = src.indexOf('ASR_RESPONSE_HAVE_NO_WORDS');
  const classifyAt = src.indexOf('classifyAsrFailure({ status', at);
  assert.ok(at > 0 && classifyAt > at, 'NO_WORDS 的分支必须排在按状态码分类之前');
});
