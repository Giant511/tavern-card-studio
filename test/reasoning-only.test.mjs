/**
 * 推理模型"正文为空"的处置（2026-11-02 用户报"重新生成没反应"）。
 *
 * ## 真实现象
 *
 * > 删除消息后点击重新生成，没有反应，重新发消息也不行，
 * > 但是我 api 后台是看到了两条消耗
 *
 * ## 真机证据（logcat，`deepseek-v4-pro`）
 *
 * ```text
 *   generate: source=custom model_len=15 custom_url=https://ai.ota1245.top/v1 messages=21
 *   frame#0  {"choices":[{"delta":{"role":"assistant"},"finish_reason":null...
 *   frame#1  {"choices":[{"delta":{"reasoning_content":"我们需要"},"finish_reas...
 *   frame#2  {"choices":[{"delta":{"reasoning_content":"理解"},"finish_reas...
 *   post_stream 结束：frames=302 err=false
 *   emit done
 *   [mobile] 这次没有生成任何内容
 * ```
 *
 * **302 帧全是 `reasoning_content`，`content` 一个字没有。**
 * API 后台 `510 / 300` ⇒ `max_tokens=300` 被思维链吃完了。
 *
 * ## 三个必须分开的失败形态
 *
 * | 形态 | 真实原因 | 该给什么建议 |
 * |---|---|---|
 * | 有思维链 + `finish_reason: length` | 预算被思考耗尽 | 调大 max_tokens / 换非推理模型 |
 * | 有思维链 + 无截断 | 模型只思考不回答 | 同上 |
 * | 无思维链也无正文 | 上游真的空返回 | 查模型名是否可用 |
 *
 * 原来三合一成一句"这次没有生成任何内容，换个说法" ——
 * **"换个说法"完全不对症**：换多少说法都会在同一个地方被截断。
 * 而用户能改的旋钮（最大回复长度）界面上根本没有。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createStreamState,
  finalizeOutput,
  startStreaming,
} from '../shared/dist/chat/stream.js';

const ROOT = join(import.meta.dirname, '..');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const apiPage = strip(readFileSync(join(ROOT, 'client/src/chat/api-page.ts'), 'utf8'));
const shell = strip(readFileSync(join(ROOT, 'client/src/chat/shell.ts'), 'utf8'));
const panel = strip(readFileSync(join(ROOT, 'client/src/chat/chat-panel.ts'), 'utf8'));
const css = readFileSync(join(ROOT, 'client/src/chat/chat.css'), 'utf8');

/* ═══════════════════════════════════════════════════════════
   一、finalizeOutput 的三分支
   ═══════════════════════════════════════════════════════════ */

test('★★★ 只有思维链、没有正文 ⇒ 提示"预算被思考吃了" + 指向 max_tokens', () => {
  /*
   * 真机实测的就是这一支：302 帧全是 reasoning_content。
   */
  const state = {
    ...startStreaming(),
    text: '',
    reasoning: '我们需要理解用户的问题……',
    finishReason: 'length',
  };
  const out = finalizeOutput(state);

  assert.equal(out.ok, false, '没有正文就是失败（不能当成成功塞个空消息）');
  assert.match(out.message, /思考/, '要点明"思考"这个真因');
  assert.match(out.message, /最大回复长度|max_tokens/, '要指向用户能改的那个旋钮');
  assert.equal(
    /换个说法/.test(out.message),
    false,
    '不许再给"换个说法"——换多少说法都会在同一处被截断',
  );
});

test('★★★ 有思维链但没截断 ⇒ 仍指向 max_tokens，但不谎称被截断', () => {
  const state = {
    ...startStreaming(),
    text: '',
    reasoning: '思考了一些内容',
    finishReason: 'stop',
  };
  const out = finalizeOutput(state);
  assert.equal(out.ok, false);
  assert.match(out.message, /最大回复长度/, '仍要指向 max_tokens');
  assert.equal(
    /被 max_tokens 截断/.test(out.message),
    false,
    'finish_reason 不是 length 时不许说"被截断"',
  );
});

test('★★ 既无正文也无思维链 ⇒ 归因"上游确实空返回"', () => {
  const state = { ...createStreamState(), phase: 'streaming', text: '', reasoning: '' };
  const out = finalizeOutput(state);
  assert.equal(out.ok, false);
  assert.match(out.message, /上游|模型名/, '要指向"上游/模型名"这类可查的东西');
  /*
   * 判的是"有没有**误归因**到预算"，不是"有没有出现『思考』两个字"。
   *
   * 文案里说"既无正文也无思考过程"是**陈述事实**，不是归因；
   * 第一版断言直接禁"思考"二字，把它误判成违规了。
   */
  assert.equal(
    /预算|max_tokens|最大回复长度/.test(out.message),
    false,
    '没有思维链时不许把原因归到"预算被思考吃了"',
  );
});

test('★★ 有正文时一切照旧（不许被新分支影响）', () => {
  const state = { ...startStreaming(), text: '你好呀', reasoning: '一些思考' };
  const out = finalizeOutput(state);
  assert.equal(out.ok, true);
  assert.equal(out.text, '你好呀');
});

/* ═══════════════════════════════════════════════════════════
   二、「最大回复长度」只能有一个入口
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 「最大回复长度」只能有一个入口：AI 响应配置', () => {
  /*
   * 用户报「自定义接口里的回复长度看起来保存不了」。追下去发现不是保存坏了，
   * 而是**同一个东西有两个入口**：
   *
   *   ① API 连接页   → apiState.maxTokens（localStorage，按源）
   *   ② AI 响应配置  → oai_settings.openai_max_tokens（ST 设置）
   *
   * 而前者在派生采样时**覆盖**后者。两处值不一致时用户无从判断哪个生效，
   * 更糟的是 API 页每次保存都会顺手把长度改回它自己那份。
   *
   * 用户的判断是对的：留一处更合理。保留「AI 响应配置」，
   * 它直接读写 ST 那个键，是唯一入口也是唯一真相。
   */
  assert.doesNotMatch(apiPage, /max-tokens-input/, 'API 页不许再有这一格');
  assert.doesNotMatch(apiPage, /最大回复长度/, 'API 页不许再出现这个标签');

  const schema = read('shared/src/chat/settings-schema.ts');
  assert.match(schema, /label: '最大回复长度（Token）'/, '「AI 响应配置」要保留唯一入口');
  assert.match(schema, /'openai_max_tokens'/, '唯一入口要写 ST 的这个键');
});

test('★★★★ 保存连接配置不许顺手改回复长度', () => {
  /*
   * `buildStConnectionPatch` 只该写「连接」三件套（源 / 模型 / 地址）。
   * 它曾经还写 `openai_max_tokens`，结果是「只改模型名，长度被重置」。
   */
  const persist = strip(read('shared/src/chat/api-persist.ts'));
  assert.doesNotMatch(persist, /openai_max_tokens/, '不该再写这个键');
  assert.doesNotMatch(shell, /writeMaxTokens/, '外壳不该再有写它的方法');
});

test('★★★ 派生采样不许被 App 侧那份覆盖', () => {
  /*
   * 覆盖是「两处入口」能互相打架的根本原因：`deriveSampling()` 本该只反映
   * ST 设置，而它曾经拿 `apiState.maxTokens` 盖上去 —— 于是 ST 里改的值
   * 看不见效果。
   */
  const at = shell.indexOf('private deriveSampling');
  assert.ok(at > 0, 'deriveSampling 要存在');
  const body = shell.slice(at, at + 900);
  assert.doesNotMatch(body, /apiState/, '不该再读 apiState');
  assert.match(body, /samplingFromSettings/, '只从 ST 设置派生');
});

test('★★ 回复长度不许设人为上限（用户报过正常不该有限制）', () => {
  /*
   * 原来 App 侧写死 8192，填 100000 会被静默换成默认值 ——
   * 用户改了不生效，回复写到一半被截断，界面上一句解释都没有。
   *
   * 现在这一格归 schema 管，上限只拦明显误触（多按几个零）。
   */
  const schema = strip(read('shared/src/chat/settings-schema.ts'));
  const at = schema.indexOf("path: ['oai_settings', 'openai_max_tokens']");
  assert.ok(at > 0, 'schema 里要有这一项的 path');
  const block = schema.slice(at, at + 700);
  assert.match(block, /max: 1_000_000/, '上限要留到一百万（只拦误触）');
  assert.doesNotMatch(block, /max: 32_000/, '32k 那道闸必须清掉');
});

test('★★★ 建议数值要按实际思维链长度算，不能给固定数', () => {
  /*
   * 同一模型两次实测：459 字（1200 够）与 2074 字（1200 不够）。
   * 固定写"建议 800"会让第二次照样失败 —— 而用户已经照做了。
   */
  const short = finalizeOutput({
    ...startStreaming(),
    text: '',
    reasoning: '思'.repeat(459),
    finishReason: 'length',
  });
  const long = finalizeOutput({
    ...startStreaming(),
    text: '',
    reasoning: '思'.repeat(2074),
    finishReason: 'length',
  });

  const num = (m) => {
    const hit = /调到 (\d+) 或更大/.exec(m);
    return hit === null ? null : Number(hit[1]);
  };
  const a = num(short.message);
  const b = num(long.message);
  assert.ok(a !== null && b !== null, '文案里要有具体数字');
  assert.ok(b > a, `思维链更长时建议值必须更大（459→${String(a)}，2074→${String(b)}）`);
  assert.ok(a > 459, '建议值要大于思维链本身');
  assert.ok(b > 2074, '建议值要大于思维链本身');
});

test('★★★ 正文为空但有思维链时，气泡要显示思考内容', () => {
  /*
   * 真机录屏里：一个空泡 + 一个呼吸点，十几秒没动静。
   * 而 logcat 显示后台一直在收帧（302 帧）—— 用户完全看不出它在干活。
   */
  assert.match(panel, /state\.reasoning/, '流式渲染要看 reasoning');
  assert.match(panel, /nb-thinking/, '要有一个区分"过程"的样式类');
  assert.match(css, /\.nb-thinking\s*\{/, '样式要存在');
});

test('★★ 思考预览必须视觉上区别于正文（否则会被当成回复）', () => {
  const m = /\.nb-thinking\s*\{([^}]*)\}/.exec(css);
  assert.ok(m !== null);
  const body = m[1];
  assert.match(body, /font-style:\s*italic/, '要斜体');
  assert.match(body, /color:\s*var\(--nb-text-3\)/, '要更暗（过程而非结果）');
  /* 思维链很长且高频更新，不限高会把气泡撑满整屏 */
  assert.match(body, /max-height/, '要限高');
});
