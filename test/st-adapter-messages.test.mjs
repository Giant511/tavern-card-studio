/**
 * 聊天消息读写（v0.1.7 / T15.4）—— `shared/src/st-adapter/messages.ts` 的单测。
 *
 * ## 这一组守的是什么
 *
 * 契约 §5.3 的判据原话：「除自己改动的字段外**必须逐字段不变**」。
 * 丢了 `swipes` 的后果是用户在手机上聊几句、回桌面发现"我重新生成过 5 次的候选全没了"——
 * 而这不在他能理解的因果里。
 *
 * 第二组守的是陷阱 #4：`/api/chats/get` 对不存在的聊天返回 `{}` 而不是 404。
 * 把 `{}` 当空聊天 → 用户看到空白 → 点发送 → 全量覆盖 → **真的把历史冲掉**。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canSaveOverEmpty,
  createMessage,
  diffMessageRoundTrip,
  joinForSave,
  parseChatResponse,
  splitHeader,
  withMessageText,
  withNewSwipe,
  withSwipeIndex,
} from '@tcs/shared';
import { buildChatHeader, buildChatSaveBody } from '@tcs/shared';
// v0.1.7 / T15.6：语音标记（extra.tcs.voice）也要过这条契约
import { isVoiceMsg, setVoiceFlag } from '@tcs/shared';

/* ───────────── 读：{} 不是空聊天 ───────────── */

test('★ 返回 {} 判成"不存在"，不是"空聊天"（陷阱 #4）', () => {
  const result = parseChatResponse({});
  assert.equal(result.kind, 'missing');
});

test('★ 返回 [] 判成 `empty`，不是 `chat`（真 ST 实测纠正）', () => {
  /*
   * 第一版把它并进 `chat`（"存在但没消息"），契约测试在真 ST 上当场证明这是错的：
   * `src/endpoints/chats.js:580` 的注释原文是
   *   "If the chatFilePath cannot be read, this will return []"
   * 也就是说 `[]` = **读不到**，而"读不到"里包含"文件存在但读失败"。
   * 把它当成新聊天再整份覆盖保存，用户历史当场消失。
   */
  const result = parseChatResponse([]);
  assert.equal(result.kind, 'empty');
});

test('★ empty 必须经 canSaveOverEmpty 交叉验证才能保存', () => {
  const empty = parseChatResponse([]);
  // 不在列表里 → 确实新聊天，可以写
  assert.equal(canSaveOverEmpty(empty, false).ok, true);
  // 在列表里却读到空 → 读失败，绝不能覆盖
  const blocked = canSaveOverEmpty(empty, true);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /避免覆盖/);
});

test('canSaveOverEmpty：missing 可以直接写（目录都不存在）', () => {
  assert.equal(canSaveOverEmpty(parseChatResponse({}), false).ok, true);
});

test('canSaveOverEmpty：正常聊天可以直接写', () => {
  assert.equal(canSaveOverEmpty(parseChatResponse([{ mes: 'x' }]), true).ok, true);
});

test('canSaveOverEmpty：malformed 一律拒绝', () => {
  const result = canSaveOverEmpty(parseChatResponse({ foo: 1 }), false);
  assert.equal(result.ok, false);
});

test('返回非数组非空对象判成 malformed 并给原因', () => {
  const result = parseChatResponse({ foo: 'bar' });
  assert.equal(result.kind, 'malformed');
  assert.match(result.reason, /不是消息数组/);
});

test('返回 null 也算 malformed（不静默当空）', () => {
  assert.equal(parseChatResponse(null).kind, 'malformed');
});

/* ───────────── header 拆分 ───────────── */

test('正常情况：第 0 条是 header，其余是消息', () => {
  const raw = [
    { user_name: 'unused', character_name: 'unused', chat_metadata: {} },
    { name: 'user', is_user: true, mes: '你好' },
  ];
  const { header, body } = splitHeader(raw);
  assert.equal(header.user_name, 'unused');
  assert.equal(body.length, 1);
});

test('第 0 条带 mes 时**不当 header**（手工编辑过的文件可能没 header）', () => {
  /*
   * 硬按"第 0 条一定是 header"拆，会把第一条真实消息当 header 吞掉 ——
   * 用户少看到一句话，而且下次保存时它消失在 header 里。
   */
  const raw = [{ name: 'user', is_user: true, mes: '我是第一条真消息' }];
  const { header, body } = splitHeader(raw);
  assert.deepEqual(header, {});
  assert.equal(body.length, 1);
  assert.equal(body[0].mes, '我是第一条真消息');
});

test('空数组不炸', () => {
  assert.deepEqual(splitHeader([]), { header: {}, body: [] });
});

/* ───────────── round-trip：不丢字段（核心） ───────────── */

test('★ 改正文后 swipes / swipe_info / extra 逐字段不变', () => {
  const original = {
    name: '西奥',
    is_user: false,
    send_date: '2026-10-28T10:00:00.000Z',
    mes: '原文',
    extra: { api: 'openai', model: 'gpt-4o' },
    swipes: ['候选1', '候选2', '候选3'],
    swipe_id: 1,
    swipe_info: [{ send_date: 'a' }, { send_date: 'b' }],
  };
  const edited = withMessageText(original, '改后的正文');

  assert.equal(edited.mes, '改后的正文');
  assert.deepEqual(edited.swipes, original.swipes);
  assert.deepEqual(edited.swipe_info, original.swipe_info);
  assert.deepEqual(edited.extra, original.extra);
  assert.equal(edited.swipe_id, 1);
});

/*
 * ★ 语音标记过契约（v0.1.7 / T15.6 终版，需求「扩契约测试第 6 条消息对象用例」）。
 *
 * 为什么这条必须挂在**契约测试**里而不是语音自己的测试里：
 *
 *   `extra.tcs.voice` 是写进**用户聊天文件**的东西。它的失效形态不是报错，
 *   而是"换台设备徽标就没了"—— 用户至多觉得"有点怪"，不会报 bug。
 *   所以要像 swipes 一样，用同一条判据守着：读进来再写回去，逐字段不变。
 *
 * 这里走的是完整链路：打标记 → joinForSave（JSONL 行）→ JSON 解析回来 → 逐字段对拍。
 * 少任何一步，"写进去了但读不回来"都会漏。
 */
test('★ 语音标记经保存/读取链路后仍在，且不污染其它字段', () => {
  // 一条真实的 ST 用户消息：extra 里已经有 ST 自己的东西
  const original = {
    name: '我',
    is_user: true,
    send_date: '2026-10-30T08:00:00.000Z',
    mes: '“在吗”',
    extra: { api: 'openai', tcs: { cardId: 'demo-card' } },
    swipes: ['“在吗”'],
    swipe_id: 0,
  };

  const flagged = setVoiceFlag(original);
  assert.equal(isVoiceMsg(flagged), true);

  // 走真实的保存链路（拼 header → JSONL 数组）
  const header = buildChatHeader({ userName: 'unused', characterName: '西奥' });
  const lines = joinForSave(header, [flagged]);

  // 每一行都要能 JSON.stringify / parse（ST 的 .jsonl 就是这个形状）
  const reloaded = JSON.parse(JSON.stringify(lines));
  assert.equal(reloaded.length, 2, 'header + 1 条消息');

  const message = reloaded[1];
  assert.equal(isVoiceMsg(message), true, 'round-trip 后徽标必须还在（这是"随消息走"的判据）');
  assert.equal(message.extra.tcs.cardId, 'demo-card', 'tcs 命名空间里的其它键不许被语音标记挤掉');
  assert.equal(message.extra.api, 'openai', "extra 顶层别人的字段也不许动（契约 §5.3）");
  assert.equal(message.mes, '“在吗”', '正文不许变');
  assert.deepEqual(message.swipes, ['“在吗”'], 'swipes 不许变');
  assert.equal(message.swipe_id, 0);

  // 反向：去掉标记后这条消息与原始消息**逐字段一致**
  const cleared = setVoiceFlag(flagged, false);
  assert.equal(isVoiceMsg(cleared), false);
  assert.deepEqual(
    cleared,
    original,
    '取消语音标记后应当回到原始形状（不留空对象、不留 false）',
  );
});

test('diffMessageRoundTrip：原样往返应当零差异', () => {
  const messages = [
    { name: '西奥', is_user: false, mes: '你好', swipes: ['a'], swipe_id: 0 },
  ];
  assert.deepEqual(diffMessageRoundTrip(messages, messages), []);
});

test('diffMessageRoundTrip：丢一个字段必须被报出来（这是它的唯一用途）', () => {
  const before = [{ name: '西奥', is_user: false, mes: '你好', swipes: ['a'] }];
  // 模拟"用白名单重建对象"的写法
  const after = [{ name: '西奥', is_user: false, mes: '你好' }];
  const problems = diffMessageRoundTrip(before, after);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /swipes/);
});

test('diffMessageRoundTrip：条数变了直接报条数', () => {
  const problems = diffMessageRoundTrip([{ mes: 'a' }], []);
  assert.match(problems[0], /条数变了/);
});

/* ───────────── swipe ───────────── */

test('首次生成候选时把原 mes 留成第 1 个候选', () => {
  /*
   * 否则用户第一次点"重新生成"，就再也看不到原来那句话了。
   */
  const original = { name: '西奥', is_user: false, mes: '第一版' };
  const next = withNewSwipe(original, '第二版', new Date('2026-10-29T00:00:00Z'));
  assert.deepEqual(next.swipes, ['第一版', '第二版']);
  assert.equal(next.swipe_id, 1);
  assert.equal(next.mes, '第二版');
  assert.equal(next.swipe_info.length, 1);
});

test('已有候选时追加，不重置', () => {
  const original = {
    name: '西奥',
    is_user: false,
    mes: '第二版',
    swipes: ['第一版', '第二版'],
    swipe_id: 1,
  };
  const next = withNewSwipe(original, '第三版');
  assert.deepEqual(next.swipes, ['第一版', '第二版', '第三版']);
  assert.equal(next.swipe_id, 2);
});

test('withSwipeIndex：越界不抛错（滑动是高频手势）', () => {
  const message = { name: '西奥', is_user: false, mes: 'b', swipes: ['a', 'b'], swipe_id: 1 };
  // 滑到头就不动，比弹异常好
  assert.equal(withSwipeIndex(message, 5).mes, 'b');
  assert.equal(withSwipeIndex(message, -1).mes, 'b');
  assert.equal(withSwipeIndex(message, 1.5).mes, 'b');
});

test('withSwipeIndex：正常切候选并同步 mes 与 swipe_id', () => {
  const message = { name: '西奥', is_user: false, mes: 'b', swipes: ['a', 'b'], swipe_id: 1 };
  const next = withSwipeIndex(message, 0);
  assert.equal(next.mes, 'a');
  assert.equal(next.swipe_id, 0);
});

test('没有 swipes 时切候选是空操作', () => {
  const message = { name: '西奥', is_user: false, mes: 'a' };
  assert.equal(withSwipeIndex(message, 0), message);
});

/* ───────────── 写盘形状 ───────────── */

test('joinForSave：有 header 时排第 0 位', () => {
  const joined = joinForSave({ user_name: 'unused' }, [{ name: 'u', is_user: true, mes: 'x' }]);
  assert.equal(joined.length, 2);
  assert.equal((joined[0]).user_name, 'unused');
});

test('joinForSave：没有 header 时不硬塞一个假的', () => {
  /*
   * 塞一个空 header 会被 ST 当成一条没有 mes 的消息，前端渲染成空气泡。
   */
  const joined = joinForSave({}, [{ name: 'u', is_user: true, mes: 'x' }]);
  assert.equal(joined.length, 1);
});

test('header 的两个字段字面量就是 unused（ST 的约定，不是占位符写错）', () => {
  const header = buildChatHeader({ foo: 1 });
  assert.equal(header.user_name, 'unused');
  assert.equal(header.character_name, 'unused');
  assert.deepEqual(header.chat_metadata, { foo: 1 });
});

test('保存请求体必须带完整数组（含 header）', () => {
  const body = buildChatSaveBody('西奥.png', '聊天名', [
    { user_name: 'unused' },
    { name: 'u', is_user: true, mes: 'x' },
  ]);
  assert.equal(Array.isArray(body.chat), true);
  assert.equal(body.chat.length, 2);
  // file_name 不带 .jsonl（陷阱 #3）
  assert.equal(body.file_name, '聊天名');
});

test('createMessage 只填必要字段，不预填 swipes', () => {
  /*
   * 空数组和"没有这个字段"在 ST 前端不是一回事：前者会让候选条显示 0/0。
   */
  const message = createMessage({ name: 'u', isUser: true, text: 'hi', now: new Date('2026-10-29T00:00:00Z') });
  assert.equal(message.mes, 'hi');
  assert.equal(message.send_date, '2026-10-29T00:00:00.000Z');
  assert.equal('swipes' in message, false);
});
