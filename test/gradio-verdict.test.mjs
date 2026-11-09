/**
 * Gradio SSE 结局判定（v0.1.7 / 第八批问题一）。
 *
 * ## 这组测试守什么
 *
 * 用户报的是**一句具体的话**：点测试弹出
 * 「语音服务报错：服务端返回了错误但没有说明原因。」
 *
 * 这句话的问题不是"措辞不好"，而是**它归错因**。实测（2026-11-01 15:41）：
 *
 * ```
 * GET /config                              → 200（7 个 api 全在）
 * GET /gradio_api/info                     → 404
 * POST /gradio_api/upload                  → 200（拿到服务端路径）
 * POST /gradio_api/call/transcribe_with_progress → 200（拿到 event_id）
 * GET  .../{event_id}                      → 200 text/event-stream，
 *                                            7 个 heartbeat / 203 字节后 terminated
 * 之后 GET /config                         → ECONNREFUSED（ping 仍通 28ms）
 * ```
 *
 * 也就是：**服务在推理时整体退出了**。而客户端把它报成"服务端返回了错误"，
 * 甚至（在另一条分支上）会报成"服务跑完了但没有返回文字" —— 后者会把用户
 * 引去查"音频里有没有人声"。
 *
 * 所以判据是：**五种结局必须给出五种不同的结论**，且每种都带可核查的事实。
 *
 * ## 为什么 `truncated` 必须由外部传入
 *
 * 事件列表里分辨不出"读到 7 个就断"和"只发了 7 个然后正常关闭"。
 * 唯一证据在读取层（`reader.read()` 抛没抛异常）。
 * 所以这个函数**不接受"猜"**，只接受读取层给的事实。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BLANK_REASON, judgeGradioSse } from '@tcs/shared';

/** 造一个 complete 事件（Gradio 的三元组：指标 / 文本 / 文件） */
function completeEvent(text) {
  return {
    event: 'complete',
    data: JSON.stringify([{ 转写耗时: '3.2s' }, text, { path: '/tmp/out.txt' }]),
  };
}

const heartbeat = { event: 'heartbeat', data: 'null' };
const sevenHeartbeats = Array.from({ length: 7 }, () => heartbeat);

/* ═══════════════════════════════════════════════════════════
   ① 成功
   ═══════════════════════════════════════════════════════════ */

test('★ 有 complete 且取到文本 → complete，文本原样带出', () => {
  const verdict = judgeGradioSse([heartbeat, completeEvent('你好世界')], {
    truncated: false,
    receivedBytes: 120,
  });
  assert.equal(verdict.kind, 'complete');
  assert.equal(verdict.text, '你好世界');
});

test('★ 空文本也算"服务跑完了"（空转写要交给上层分流，不是链路故障）', () => {
  /*
   * 这是**故意**的：`text === ''` 表示"说了但没识别出来"，
   * 与"服务坏了"是两件事。在判定层把它判失败，会让两种情况混成一句话。
   */
  const verdict = judgeGradioSse([completeEvent('')], { truncated: false, receivedBytes: 90 });
  assert.equal(verdict.kind, 'complete', '空串仍是 complete，交给 classifyEmptyTranscript 分流');
  assert.equal(verdict.text, '');
});

test('★ 先有 error 再有 complete → 以 complete 为准（转写其实成功了）', () => {
  /*
   * 有的应用会先发一帧 error（模型加载警告）再发 complete。
   * 先判 error 会把一次成功的转写报成失败 —— 而且用户重试也一样失败，
   * 因为每次都会先来那一帧。
   */
  const verdict = judgeGradioSse(
    [{ event: 'error', data: '{"error":"模型加载慢，已改用 CPU"}' }, completeEvent('好的')],
    { truncated: false, receivedBytes: 200 },
  );
  assert.equal(verdict.kind, 'complete');
  assert.equal(verdict.text, '好的');
});

/* ═══════════════════════════════════════════════════════════
   ② 服务端报了错，且说了原因
   ═══════════════════════════════════════════════════════════ */

test('★★ error 事件带原因 → 原样带出（服务端的话比我们猜的准）', () => {
  const verdict = judgeGradioSse(
    [
      heartbeat,
      { event: 'error', data: '{"error":"CUDA out of memory. Tried to allocate 2.00 GiB"}' },
    ],
    { truncated: false, receivedBytes: 150 },
  );
  assert.equal(verdict.kind, 'server-error');
  assert.equal(verdict.reason, 'CUDA out of memory. Tried to allocate 2.00 GiB');
});

test('★ error 事件的 data 是纯文本时也原样带出', () => {
  const verdict = judgeGradioSse([{ event: 'error', data: '模型文件不存在' }], {
    truncated: false,
    receivedBytes: 60,
  });
  assert.equal(verdict.kind, 'server-error');
  assert.equal(verdict.reason, '模型文件不存在');
});

/* ═══════════════════════════════════════════════════════════
   ③ 服务端报了错但没说原因（用户看到的那句的源头）
   ═══════════════════════════════════════════════════════════ */

test('★★ error 事件 data 是 `{}` → server-error-blank，且必须带诊断字段', () => {
  /*
   * 这是用户截图那句文案的源头：`extractGradioError` 取不到 `error` 字段时
   * 给一句「服务端返回了错误但没有说明原因。」，**没有任何可核查的东西**。
   *
   * 判定层要把它单独识别出来（用 `BLANK_REASON` 常量比对），
   * 并附上"收到多少字节、有没有被掐断" —— 这两项才让用户能去对日志。
   */
  const verdict = judgeGradioSse([heartbeat, { event: 'error', data: '{}' }], {
    truncated: true,
    receivedBytes: 203,
  });
  assert.equal(verdict.kind, 'server-error-blank');
  assert.equal(verdict.receivedBytes, 203, '要带出收到的字节数');
  assert.equal(verdict.truncated, true, '要带出是否被掐断');
  assert.equal(verdict.raw, '{}', 'error 事件原文要留着');
});

test('★ error 事件 data 是空串，同样进 server-error-blank', () => {
  const verdict = judgeGradioSse([{ event: 'error', data: '' }], {
    truncated: false,
    receivedBytes: 0,
  });
  assert.equal(verdict.kind, 'server-error-blank');
  assert.equal(verdict.receivedBytes, 0);
});

test('★ 兜底话的常量只有一处定义（两处各写一遍就必然分叉）', () => {
  /*
   * 判定层靠字符串比对认出"这是我们自己编的兜底话"。
   * 如果 `gradio.ts` 与 `gradio-verdict.ts` 各定义一份，改一处忘另一处时：
   *   · 判定层认不出来 → 又退回那句无信息量的话
   *   · 而两边"各自都自洽"→ **测试不会红**
   * 所以这条断言钉住"定义源唯一、且真的就是那句话"。
   */
  assert.equal(BLANK_REASON, '服务端返回了错误但没有说明原因。');

  const raw = judgeGradioSse([{ event: 'error', data: '{}' }], {
    truncated: false,
    receivedBytes: 0,
  });
  assert.equal(
    raw.kind,
    'server-error-blank',
    '判定层必须认出这句兜底话（否则说明常量没对上）',
  );
});

/* ═══════════════════════════════════════════════════════════
   ④ 连接被掐断（实测就是这个）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 只有 heartbeat 且被截断 → truncated（不是"没有结果"）', () => {
  /*
   * **这是 2026-11-01 15:41 实测的真实形态**：
   * 7 个 heartbeat / 203 字节后被 terminated，没有任何 complete 或 error。
   *
   * 关键：`truncated: true` 必须导致 `kind === 'truncated'`，
   * 而不是 `'no-result'`。后者会说"服务跑完了但没有返回转写结果"，
   * 把人引去查音频 —— 但服务**没跑完，它退出了**。
   */
  const verdict = judgeGradioSse(sevenHeartbeats, { truncated: true, receivedBytes: 203 });
  assert.equal(verdict.kind, 'truncated');
  assert.equal(verdict.receivedBytes, 203);
  assert.equal(verdict.lastEvent, 'heartbeat', '要带出最后一个事件名，便于判断进展到哪');
});

test('★★ 同一批事件，truncated 与否结论必须不同（这是判据的核心）', () => {
  /*
   * 这两条一起看才说明"truncated 真的被用上了"：
   * 事件列表完全相同，只有读取层的事实不同，结论就必须不同。
   *
   * 如果实现里忽略了 `truncated`，这两条会得到同一个 kind —— 那时
   * "服务崩了"会被永远报成"服务跑完了但没有结果"。
   */
  const cut = judgeGradioSse(sevenHeartbeats, { truncated: true, receivedBytes: 203 });
  const closedNormally = judgeGradioSse(sevenHeartbeats, { truncated: false, receivedBytes: 203 });

  assert.equal(cut.kind, 'truncated');
  assert.equal(closedNormally.kind, 'no-result');
  assert.notEqual(cut.kind, closedNormally.kind);
});

test('★ 一个事件都没收到且被截断 → 仍算 truncated（不是"没有结果"）', () => {
  const verdict = judgeGradioSse([], { truncated: true, receivedBytes: 0 });
  assert.equal(verdict.kind, 'truncated');
  assert.equal(verdict.lastEvent, null, '没有事件时明确给 null，不要编');
});

/* ═══════════════════════════════════════════════════════════
   ⑤ 流正常结束但没有终值
   ═══════════════════════════════════════════════════════════ */

test('★ 正常关闭但没有 complete → no-result（这种才该提音频内容）', () => {
  const verdict = judgeGradioSse([heartbeat, { event: 'generating', data: '[{"p":1}]' }], {
    truncated: false,
    receivedBytes: 180,
  });
  assert.equal(verdict.kind, 'no-result');
  assert.equal(verdict.receivedBytes, 180);
});

test('★ complete 的 data 不是数组 → 取不到文本，按"没有结果"处理', () => {
  const verdict = judgeGradioSse([{ event: 'complete', data: '{"weird":true}' }], {
    truncated: false,
    receivedBytes: 40,
  });
  assert.equal(verdict.kind, 'no-result');
});

/* ═══════════════════════════════════════════════════════════
   ⑥ 五种结局互斥且全覆盖
   ═══════════════════════════════════════════════════════════ */

test('★ 五种 kind 的取值集合固定（避免以后悄悄加一种而没人处理）', () => {
  const kinds = new Set([
    judgeGradioSse([completeEvent('x')], { truncated: false, receivedBytes: 1 }).kind,
    judgeGradioSse([{ event: 'error', data: '{"error":"boom"}' }], {
      truncated: false,
      receivedBytes: 1,
    }).kind,
    judgeGradioSse([{ event: 'error', data: '{}' }], { truncated: false, receivedBytes: 1 }).kind,
    judgeGradioSse([heartbeat], { truncated: true, receivedBytes: 1 }).kind,
    judgeGradioSse([heartbeat], { truncated: false, receivedBytes: 1 }).kind,
  ]);
  assert.deepEqual(
    [...kinds].sort(),
    ['complete', 'no-result', 'server-error', 'server-error-blank', 'truncated'],
  );
});
