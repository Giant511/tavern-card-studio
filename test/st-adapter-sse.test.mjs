/**
 * 流式解析（v0.1.7 / T15.4）—— `shared/src/st-adapter/sse.ts` 的单测。
 *
 * ## 这一组测试守的是什么
 *
 * 契约 §4.1 的核心事实：**ST 不设置 `Content-Type`**，事件形状是厂商原生格式。
 * 按"标准 SSE"写代码的人会判断响应头，然后在真机上永远走非流式分支 ——
 * 表现不是报错，是"能出字但一次性蹦出来、没有打字机效果"。
 *
 * 所以第一组用例专门验：**在不给任何 Content-Type 的前提下**解析仍然正确。
 * 这个模块的 API 签名里根本没有响应头参数，但测试要把它写成判据 ——
 * 否则将来有人"顺手"加一个 `contentType?: string` 参数，测试不会红。
 *
 * ## 第二组守的是分帧
 *
 * TCP 分片不保证按帧边界到达。一个 `data: {...}` 极可能被切成两个 chunk。
 * 不保留 remainder 就会把 JSON 截断，然后 `JSON.parse` 抛错 ——
 * 而那个错误看起来像"厂商返回了坏数据"，实际是我们自己切坏的。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SseFrameSplitter,
  ensureTerminal,
  isStreamingRequest,
  translateFrame,
} from '@tcs/shared';
import { SUPPORTED_CHAT_SOURCES } from '@tcs/shared';

/* ───────────── 分帧 ───────────── */

test('分帧：三种行尾（\\n\\n / \\r\\n\\r\\n / \\r\\r）都要认', () => {
  /*
   * ST 前端的正则就是 `/r?n?r?n/`（契约 §4.2 记的 `sse-stream.js:19`），
   * 说明上游三种都可能出现。只认 `\n\n` 会把 `\r\n\r\n` 的流切成半截。
   */
  for (const sep of ['\n\n', '\r\n\r\n', '\r\r']) {
    const splitter = new SseFrameSplitter();
    const frames = splitter.push(`data: {"a":1}${sep}data: {"b":2}${sep}`);
    assert.equal(frames.length, 2, `分隔符 ${JSON.stringify(sep)} 没被识别`);
    assert.equal(frames[0].data, '{"a":1}');
    assert.equal(frames[1].data, '{"b":2}');
  }
});

test('分帧：一个帧被 TCP 切成两半时要能拼回来', () => {
  const splitter = new SseFrameSplitter();
  // 前半截没有空行，不该产出帧
  assert.deepEqual(splitter.push('data: {"choices":[{"delta"'), []);
  // 后半截补齐并带分隔符
  const frames = splitter.push(':{"content":"你好"}}]}\n\n');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data, '{"choices":[{"delta":{"content":"你好"}}]}');
});

test('分帧：一次 chunk 里凑齐三帧要全部吐出', () => {
  const splitter = new SseFrameSplitter();
  const frames = splitter.push('data: 1\n\ndata: 2\n\ndata: 3\n\n');
  assert.deepEqual(frames.map((f) => f.data), ['1', '2', '3']);
});

test('分帧：`data:` 后有无空格都认，冒号开头的注释行忽略', () => {
  const splitter = new SseFrameSplitter();
  const frames = splitter.push(': keep-alive\n\ndata:no-space\n\ndata: with-space\n\n');
  assert.deepEqual(frames.map((f) => f.data), ['no-space', 'with-space']);
});

test('flush：最后不带空行时也能取出残留', () => {
  const splitter = new SseFrameSplitter();
  assert.deepEqual(splitter.push('data: [DONE]'), []);
  assert.deepEqual(splitter.flush().map((f) => f.data), ['[DONE]']);
});

/* ───────────── 翻译：无 Content-Type 也正确（核心） ───────────── */

test('★ 不给任何 Content-Type 也能正确解析（契约 §4.1 的落地点）', () => {
  /*
   * 这条用例的价值在于"输入里根本没有响应头这个概念"。
   * 如果将来有人把 translateFrame 的签名改成需要 Content-Type，
   * 这个测试会编译失败 —— 那就是我们要的信号。
   */
  const splitter = new SseFrameSplitter();
  const frames = splitter.push('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
  const events = translateFrame(frames[0], 'openai');
  assert.deepEqual(events, [{ type: 'text', text: '你好' }]);
});

test('生成请求的流式判据只看请求参数，不看响应', () => {
  assert.equal(isStreamingRequest({ stream: true }), true);
  assert.equal(isStreamingRequest({ stream: false }), false);
  // 函数签名只接受 {stream} —— 传响应头进去也无处可用
  assert.equal(isStreamingRequest({ stream: 'true' }), false);
});

/* ───────────── 四个后端形状 ───────────── */

test('OpenAI 兼容族：delta.content → text，delta.reasoning_content → reasoning', () => {
  const reasoning = translateFrame(
    { data: '{"choices":[{"delta":{"reasoning_content":"思考中"}}]}' },
    'deepseek',
  );
  assert.deepEqual(reasoning, [{ type: 'reasoning', text: '思考中' }]);

  const text = translateFrame({ data: '{"choices":[{"delta":{"content":"回答"}}]}' }, 'groq');
  assert.deepEqual(text, [{ type: 'text', text: '回答' }]);
});

test('reasoning 的两个字段名都认（reasoning_content 与 reasoning）', () => {
  /*
   * DeepSeek 用 `reasoning_content`，部分网关用 `reasoning`。
   * 只认一个的后果是思维链被静默丢掉 —— 不报错，只是"这个模型的思考过程看不到"。
   */
  const viaReasoning = translateFrame({ data: '{"choices":[{"delta":{"reasoning":"想"}}]}' }, 'openai');
  assert.deepEqual(viaReasoning, [{ type: 'reasoning', text: '想' }]);
});

test('claude：content_block_delta.text → text，thinking_delta → reasoning', () => {
  const text = translateFrame(
    { data: '{"type":"content_block_delta","delta":{"type":"text_delta","text":"嗨"}}' },
    'claude',
  );
  assert.deepEqual(text, [{ type: 'text', text: '嗨' }]);

  const thinking = translateFrame(
    { data: '{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"嗯"}}' },
    'claude',
  );
  assert.deepEqual(thinking, [{ type: 'reasoning', text: '嗯' }]);
});

test('claude 没有 [DONE]，靠 message_stop 或连接关闭收尾', () => {
  const stop = translateFrame({ data: '{"type":"message_stop"}' }, 'claude');
  assert.deepEqual(stop, [{ type: 'done' }]);

  /*
   * 「连接关闭即结束」这一条由调用方补 done（见 ensureTerminal）。
   * 少了它会一直转圈 —— 用户看着像卡死，实际内容早收全了。
   */
  assert.deepEqual(ensureTerminal(false), [{ type: 'done' }]);
  assert.deepEqual(ensureTerminal(true), []);
});

test('OpenAI 兼容族的 finish_reason 也当终止（有网关不发 [DONE]）', () => {
  const events = translateFrame(
    { data: '{"choices":[{"delta":{},"finish_reason":"stop"}]}' },
    'openai',
  );
  assert.deepEqual(events, [{ type: 'done', finishReason: 'stop' }]);
});

test('[DONE] 只对 OpenAI 兼容族有意义', () => {
  assert.deepEqual(translateFrame({ data: '[DONE]' }, 'openai'), [{ type: 'done' }]);
});

/* ───────────── 异常与边界 ───────────── */

test('错误对象优先判，不当正文字渲染', () => {
  const events = translateFrame({ data: '{"error":{"message":"额度不足"}}' }, 'openai');
  assert.deepEqual(events, [{ type: 'error', message: '额度不足' }]);
});

test('非 JSON 帧当正文吐出（网关会插心跳/纯文本错误）', () => {
  /*
   * 直接失败会让用户丢掉整段已经生成的内容；
   * 当正文继续至少已有的字还在，而且那句话用户看得见。
   */
  assert.deepEqual(translateFrame({ data: 'rate limited' }, 'openai'), [
    { type: 'text', text: 'rate limited' },
  ]);
  assert.deepEqual(translateFrame({ data: '' }, 'openai'), []);
});

test('空 choices / 缺 delta 不产出事件，也不抛错', () => {
  assert.deepEqual(translateFrame({ data: '{"choices":[]}' }, 'openai'), []);
  assert.deepEqual(translateFrame({ data: '{"choices":[{}]}' }, 'openai'), []);
  assert.deepEqual(translateFrame({ data: 'null' }, 'openai'), []);
});

test('不支持的后端返回 error，不返回空数组', () => {
  /*
   * 空数组会让 UI 一直等下去；error 至少能让界面收尾并说明原因。
   */
  const events = translateFrame({ data: '{"candidates":[]}' }, 'makersuite');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'error');
});

test('六个支持的后端都能被 translateFrame 处理（不会落到 error 分支）', () => {
  for (const source of SUPPORTED_CHAT_SOURCES) {
    const payload = source === 'claude'
      ? '{"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}'
      : '{"choices":[{"delta":{"content":"x"}}]}';
    const events = translateFrame({ data: payload }, source);
    assert.ok(
      events.every((event) => event.type !== 'error'),
      `${source} 落到了 error 分支：${JSON.stringify(events)}`,
    );
  }
});
