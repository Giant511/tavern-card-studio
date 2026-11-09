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
import {
  DEFAULT_API_STATE,
  DEFAULT_MAX_TOKENS,
} from '../client/src/chat/api-page.ts';

const ROOT = join(import.meta.dirname, '..');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
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
   二、"最大回复长度"必须有界面入口
   ═══════════════════════════════════════════════════════════ */

test('★★★ API 页要有「最大回复长度」输入框', () => {
  /*
   * 用户遇到"生成不出内容"时，界面上原来**没有任何旋钮可调** ——
   * 只能换模型。而这一格正是推理模型的唯一自救入口。
   */
  assert.match(apiPage, /最大回复长度/, '要有这个字段的标签');
  assert.match(apiPage, /data-role',\s*'max-tokens-input'/, '要能按 data-role 找到它');
  assert.match(apiPage, /DEFAULT_MAX_TOKENS/, '要有默认值');
});

test('★★★ 默认值必须足够大（300/800 实测都不够）', () => {
  /*
   * `oai_settings.openai_max_tokens` 出厂 300：推理模型光思考就吃掉 300，
   * 正文 0 字（真机实测 302 帧全是思维链）。
   *
   * 我第一版改到 800，理由"够装一段思考 + 一段回复" —— **实测打脸**：
   * 两次同样的配置，思维链分别是 459 字与 2074 字，800 在第二次里
   * 连思考都装不完。
   */
  assert.ok(
    DEFAULT_MAX_TOKENS >= 2048,
    `默认值 ${String(DEFAULT_MAX_TOKENS)} 太小：实测 2074 字思维链就需要 ~2100 token`,
  );
  assert.equal(DEFAULT_API_STATE.maxTokens, DEFAULT_MAX_TOKENS, '默认状态要带上它');
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

test('★★ 输入值要夹在合理范围（防止手改 localStorage 塞天文数字）', () => {
  /* 太小连正常回复都装不下；太大弱模型会卡死、预付费站点可能直接拒 */
  assert.match(apiPage, /n\s*>=\s*256/, '下界 256');
  assert.match(apiPage, /n\s*<=\s*8192/, '上界 8192');
});

test('★★★ 保存时必须落进 ST 设置（否则请求体里还是旧值）', () => {
  /*
   * 请求体的 `max_tokens` 由 `samplingFromSettings()` 从 ST 设置派生。
   * 只在 App 侧存一个数字**不会生效** —— 界面显示 800、请求里还是 300。
   * 这是最典型的"改了但没变"。
   */
  assert.match(shell, /private async writeMaxTokens/, '要有写入 ST 的方法');
  const at = shell.indexOf('private async writeMaxTokens');
  const body = shell.slice(at, at + 1600);
  assert.match(body, /mutateSettings/, '要走 mutateSettings（GET→改→整份 POST）');
  assert.match(body, /openai_max_tokens/, '要写这个字段');
  /*
   * 断言"写完要把新采样推给聊天面板"。接受 `deriveSampling` ——
   * 它是 `samplingFromSettings` 的包装（统一钉上 maxTokens 的那一个）。
   * 写死旧名字会在重构后误红，而行为其实没变。
   */
  assert.match(
    body,
    /deriveSampling|samplingFromSettings/,
    '写完要把新采样推给聊天面板',
  );
  assert.match(body, /setContext\(\{\s*sampling/, '要真的推给面板');
});

test('★★ 写 max_tokens 失败不许阻断"保存连接配置"', () => {
  /*
   * 连接配置本身已经存成功了；长度上限写失败只是这一项没生效。
   * 抛错会让用户看到"保存失败"，但其实源和模型都存好了 —— 误导。
   */
  const at = shell.indexOf('const reason = await this.writeMaxTokens(');
  assert.ok(at > 0, '要调用 writeMaxTokens 并拿到 reason');
  const around = shell.slice(at, at + 400);
  assert.match(around, /onNotify/, '失败了要提示');
  assert.equal(/throw new Error/.test(around), false, '不许抛（会误导成"保存失败"）');
});

/* ═══════════════════════════════════════════════════════════
   三、流式期间要显示思维链（否则气泡一直是空的）
   ═══════════════════════════════════════════════════════════ */

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
