/**
 * 模型类型 / 模型路径的**校正**（2026-11-02 实机录音跑通的最后一环）。
 *
 * ## 为什么要有这组判据
 *
 * 服务端对下拉框参数有服务端校验：值必须在 `/config` 的 `props.choices` 里。
 * 而 App 里"模型路径"是用户手填的，placeholder 原来写的是
 * `./models/Fun-ASR-Nano`（**正斜杠**），服务端只认
 * `./models\Fun-ASR-Nano`（**反斜杠**）。
 *
 * 实测（同一段音频、同一服务）：
 *
 * ```text
 *   ./models\Fun-ASR-Nano  → ok=true   正文「都是文本。」
 *   ./models/Fun-ASR-Nano  → ok=false  （客户端 error data 为空，界面只说"失败"）
 *   ./models（留空）        → ok=true   Model ID: None  正文空   ← 假成功
 * ```
 *
 * 真机上存的**就是**正斜杠 ⇒ 语音 100% 用不了，而界面上看不出原因。
 *
 * ## 修法的两层
 *
 * 1. `coerceToChoices()` 把用户输入归一（斜杠 / 大小写 / 空格）到服务端
 *    接受的那个写法；留空时用服务端列表第一项（**顺带实现"路径可省略"**）。
 * 2. placeholder 改成反斜杠 —— 不让提示文字本身成为错误来源。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  coerceToChoices,
  findDropdownByLabel,
  parseGradioDropdowns,
} from '../shared/dist/asr/gradio.js';

const ROOT = join(import.meta.dirname, '..');

/* ═══════════════════════════════════════════════════════════
   一、parseGradioDropdowns：从 /config 拿合法值
   ═══════════════════════════════════════════════════════════ */

test('★★★ 能从 /config 里取出下拉框的合法值（两种 choices 形状都要认）', () => {
  /*
   * Gradio 允许两种 choices 形状，实测这台服务用的是**二元组**：
   *   `[["./models\\Fun-ASR-Nano", "./models\\Fun-ASR-Nano"]]`
   * 而别的版本可能给纯值数组 `["a","b"]`。两种都要认，否则换版本就静默失效。
   */
  const payload = {
    components: [
      {
        id: 25,
        type: 'dropdown',
        props: { label: '🤖 模型类型', value: 'fun-asr-nano', choices: [['fun-asr-nano', 'fun-asr-nano'], ['sensevoice', 'sensevoice']] },
      },
      {
        id: 26,
        type: 'dropdown',
        props: { label: '📂 模型路径', value: './models\\Fun-ASR-Nano', choices: [['./models\\Fun-ASR-Nano', './models\\Fun-ASR-Nano']] },
      },
      /* 纯值形状 + 干扰项（非 dropdown 必须被忽略） */
      { id: 39, type: 'dropdown', props: { label: '下载方式', value: 'requests', choices: ['requests', 'ffmpeg'] } },
      { id: 7, type: 'audio', props: { label: '上传音频' } },
    ],
  };
  const drops = parseGradioDropdowns(payload);
  assert.equal(drops.length, 3, '只收 dropdown，audio 要忽略');

  const type = findDropdownByLabel(drops, (l) => /模型|model/.test(l) && !/路径|path/.test(l));
  const path = findDropdownByLabel(drops, (l) => /路径|path/.test(l));
  assert.ok(type !== null && path !== null, '要能按标签区分"类型"与"路径"');
  assert.deepEqual(type.choices, ['fun-asr-nano', 'sensevoice']);
  assert.deepEqual(path.choices, ['./models\\Fun-ASR-Nano']);
  assert.equal(drops[2].choices.length, 2, '纯值形状也要认');
});

test('★★ 脏输入不能抛（服务返回形状不对时返回空数组）', () => {
  for (const bad of [null, undefined, 42, 'x', {}, { components: 'no' }, { components: [null, 1] }]) {
    assert.deepEqual(parseGradioDropdowns(bad), [], `输入 ${JSON.stringify(bad)} 应当返回空数组`);
  }
});

/* ═══════════════════════════════════════════════════════════
   二、coerceToChoices：把用户输入校正到服务端接受的写法
   ═══════════════════════════════════════════════════════════ */

const PATH = './models\\Fun-ASR-Nano';

test('★★★ 正斜杠必须被归一成服务端的反斜杠（真机坏在这里）', () => {
  const r = coerceToChoices('./models/Fun-ASR-Nano', [PATH]);
  assert.ok(r !== null);
  assert.equal(r.value, PATH, '要返回服务端列表里的那个写法');
  assert.equal(r.fallback, false, '这是"等价改写"，不是回落');
});

test('★★★ 留空 → 用服务端列表第一项（这就是"模型路径可省略"）', () => {
  const r = coerceToChoices('', [PATH]);
  assert.ok(r !== null);
  assert.equal(r.value, PATH);
  assert.equal(r.fallback, true, '要标出"用了默认值"，好让上层能提示');
});

test('★★★ 填错 → 回落到服务端合法值，而不是带着错值去撞服务端校验', () => {
  const r = coerceToChoices('./models/Not-Exist', [PATH]);
  assert.ok(r !== null);
  assert.equal(r.value, PATH);
  assert.equal(r.fallback, true);
});

test('★★ 完全相等时原样返回（exact）', () => {
  const r = coerceToChoices(PATH, [PATH]);
  assert.ok(r !== null);
  assert.equal(r.exact, true);
  assert.equal(r.fallback, false);
});

test('★★ 大小写与首尾空格也要归一', () => {
  const r = coerceToChoices('  FUN-ASR-NANO  ', [PATH]);
  assert.ok(r !== null);
  assert.equal(r.value, PATH, '大小写不该决定能不能用');
});

test('★★ 重复斜杠要收敛（`./models//x` 等价 `./models/x`）', () => {
  const r = coerceToChoices('./models//Fun-ASR-Nano', [PATH]);
  assert.ok(r !== null);
  assert.equal(r.value, PATH);
});

test('★★★ 列表为空时返回 null（交给调用方用原值，不要瞎猜）', () => {
  /* 有些服务的下拉是动态的，`choices` 此刻是空 —— 此时不能拿 null 覆盖用户输入 */
  assert.equal(coerceToChoices('./models/x', []), null);
});

test('★★ 多个合法值时可指定非第一个（不能被"总能跑通"掩盖成永远用默认）', () => {
  const choices = ['./models\\A', './models\\B'];
  const r = coerceToChoices('./models/b', choices);
  assert.ok(r !== null);
  assert.equal(r.value, './models\\B', '应当匹配到 B，而不是回落到第一个 A');
  assert.equal(r.fallback, false);
});

/* ═══════════════════════════════════════════════════════════
   三、接入层：asr-client 必须真的用它
   ═══════════════════════════════════════════════════════════ */

const rawClient = readFileSync(join(ROOT, 'client/src/chat/asr-client.ts'), 'utf8');
const client = rawClient.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('★★★ gradio 路线必须在提交前校正 model 与 modelPath', () => {
  /*
   * 判据钉的是**调用关系**，不是实现细节：
   *   · 取了 `/config` 的下拉列表
   *   · 对 model 与 modelPath 都做了 coerce
   *   · 送进 `buildGradioArgs` 的是校正后的值
   */
  assert.match(client, /parseGradioDropdowns\(configJson\)/, '要从 /config 取下拉列表');
  assert.match(client, /coerceToChoices\(req\.model/, '要校正模型类型');
  assert.match(client, /coerceToChoices\(\s*req\.modelPath/, '要校正模型路径');

  const callAt = client.indexOf('buildGradioArgs(endpoint');
  assert.ok(callAt > 0, '找不到 buildGradioArgs 调用');
  const before = client.slice(Math.max(0, callAt - 800), callAt);
  assert.match(before, /effectiveModel/, '送进去的应当是校正后的模型类型');
  assert.match(before, /effectivePath/, '送进去的应当是校正后的模型路径');
});

/* ═══════════════════════════════════════════════════════════
   四、placeholder 不许再写正斜杠
   ═══════════════════════════════════════════════════════════ */

test('★★★ “模型路径”的 placeholder 必须是反斜杠', () => {
  /*
   * 提示文字本身不能成为错误来源。用户会照着 placeholder 抄，
   * 抄一个服务端不认的写法 = 必然失败。
   */
  const settings = readFileSync(join(ROOT, 'client/src/chat/voice-settings.ts'), 'utf8');
  const m = /setAttribute\('placeholder',\s*'([^']*models[^']*)'\)/.exec(settings);
  assert.ok(m !== null, '找不到模型路径的 placeholder');
  const value = m[1];
  assert.ok(
    value.includes('\\'),
    `placeholder 应该是反斜杠写法，实际是 ${JSON.stringify(value)}`,
  );
  assert.equal(
    value.includes('/') && !value.includes('\\'),
    false,
    'placeholder 不许只有正斜杠',
  );
});
