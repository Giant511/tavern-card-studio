/**
 * 超上下文（max token）错误必须说清是哪种超、超多少（v0.2.2 / 2026-11-22）。
 *
 * ## 用户报的现象
 *
 * > 不知道为什么会出现这个max token的问题，之前设置为96k的时候可以正常用
 *
 * 上游原话（中转站转发 OpenAI 系）：
 *
 * ```text
 *   400 This model's maximum context length is 1048576 tokens.
 *       However, you requested 1049987 tokens
 *       (665987 in the messages, 384000 in the completion).
 * ```
 *
 * ## 三个数字各有各的处置
 *
 * ```text
 *   消息 665987   历史带太多   ⇒ 调小「上下文长度」（它决定带多少历史）
 *   回复 384000   回复预算太大 ⇒ 把「最大回复长度」降到窗口的 1/4 以内
 *   合计 1049987  超出 1048576 ⇒ 上面两件事至少做一件
 * ```
 *
 * 原来它落到兜底分支，只截前 120 字 —— 而数字全在后半段，
 * 用户拿到一句没有数字、也没有办法的英文。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  computeBudget,
  explainGenerateError,
  looksLikeContextOverflow,
  parseContextOverflow,
} from '@tcs/shared';

/** 上游原话（中转站把 JSON 压成一句话之后的样子） */
const MESSAGE =
  "This model's maximum context length is 1048576 tokens. However, you requested 1049987 tokens (665987 in the messages, 384000 in the completion). Please reduce the length of the messages or completion.";

/** 同一句但还在 JSON 外壳里（Rust 侧解析失败时的兜底形态） */
const RAW_JSON = JSON.stringify({
  error: { message: MESSAGE, type: 'invalid_request_error', code: 'context_length_exceeded' },
});

test('① 认得出超上下文（三种措辞）', () => {
  assert.equal(looksLikeContextOverflow(MESSAGE), true);
  assert.equal(looksLikeContextOverflow(RAW_JSON), true);
  assert.equal(looksLikeContextOverflow('{"code":"context_length_exceeded"}'), true);
  assert.equal(looksLikeContextOverflow('Please reduce the length of the messages.'), true);
  // 反例：别把普通 400 也吃进来
  assert.equal(looksLikeContextOverflow('Key 错误：Key 填错、过期或未设置 Bearer。'), false);
  assert.equal(looksLikeContextOverflow(''), false);
});

test('② 三个数字都抠出来（千分位也要认）', () => {
  const nums = parseContextOverflow(MESSAGE);
  assert.notEqual(nums, null);
  assert.equal(nums.total, 1049987);
  assert.equal(nums.messages, 665987);
  assert.equal(nums.completion, 384000);

  const commas = parseContextOverflow('you requested 1,049,987 tokens (665,987 in the messages, 384,000 in the completion)');
  assert.equal(commas.total, 1049987);
  assert.equal(commas.messages, 665987);
});

test('③ 抠不到数字时返回 null（不许编一个出来）', () => {
  assert.equal(parseContextOverflow('context_length_exceeded'), null);
  assert.equal(parseContextOverflow('too many tokens'), null);
});

test('④ 文案要带上明细与两个可执行的动作', () => {
  const text = explainGenerateError(400, MESSAGE);
  assert.match(text, /上下文/, '必须说清是哪一类超限');
  assert.match(text, /1,049,987/, '总数要给出来');
  assert.match(text, /665,987/, '消息占用');
  assert.match(text, /384,000/, '回复占用');
  assert.match(text, /上下文长度/, '要指向那个能改的开关');
  assert.match(text, /最大回复长度/, '另一个能改的开关也要点出来');
});

test('⑤ 带 JSON 外壳时同样能读（Rust 抽取失败的那条退路）', () => {
  const text = explainGenerateError(400, RAW_JSON);
  assert.match(text, /1,049,987/);
});

test('⑥ 没有数字的变体也不炸，仍然给动作', () => {
  const text = explainGenerateError(413, 'context_length_exceeded');
  assert.match(text, /上下文/);
  assert.ok(!text.includes('undefined'), '缺数字时不许把 undefined 印出来');
  assert.ok(!text.includes('null'), '缺数字时不许把 null 印出来');
});

/* ── 预算：回复上限不能把预算撑成负数（否则"不裁"会一路发全量） ── */

test('⑦ computeBudget：正常是 窗口 − 回复', () => {
  assert.equal(computeBudget(96000, 32000), 64000);
  assert.equal(computeBudget(1048576, 32000), 1016576);
});

test('⑧ computeBudget：回复比窗口还大时留四分之一给输入', () => {
  assert.equal(computeBudget(32000, 32000), 8000);
  assert.equal(computeBudget(32000, 64000), 8000);
});

test('⑨ computeBudget：窗口无效时返回 0（调用方据此不裁）', () => {
  assert.equal(computeBudget(0, 32000), 0);
  assert.equal(computeBudget(undefined, 32000), 0);
  assert.equal(computeBudget(Number.NaN, 32000), 0);
});
