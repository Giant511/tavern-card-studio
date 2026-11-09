/**
 * 三条红线复核（v0.1.7 / T15.6）。
 *
 * 需求 §5 原文三条：
 *   ① 音频直调用户配置的 ASR 域名，**TCS 服务端零接触**；
 *   ② ASR 与聊天后端配置隔离；
 *   ③ 语音消息 round-trip：`extra.tcs.voice` 经保存/读取后仍在。
 *
 * ## 这个文件与 `voice-wiring.test.mjs` 的分工
 *
 * `voice-wiring` 里已经各自带了一条（端点拼接、静态扫源码、setVoiceFlag round-trip）。
 * 这个文件补的是**更硬的证据形态**：
 *   · ① 用**运行时抓包**（拦截 fetch，记录每一次真实请求的 URL），
 *     而不是只看源码里没有 TCS 字样；
 *   · ② 用 `applyScopedPatch` 的**真抛错**，而不是"扫源码没有那个键"；
 *   · ③ 走**完整 JSONL 保存/读取链路**，而不是只 JSON.stringify/parse。
 *
 * 两种一起才有意义：静态证明"代码里没有那条路"，运行时证明"跑起来也没走"。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyScopedPatch,
  ConfigScopeError,
  overlappingConfigKeys,
  CONFIG_SCOPES,
  buildChatHeader,
  joinForSave,
  setVoiceFlag,
  isVoiceMsg,
} from '@tcs/shared';

import { transcribe } from '../client/src/chat/asr-client.ts';

const PRESET_A = {
  id: 'aliyun-paraformer',
  name: '阿里百炼 Paraformer',
  protocol: 'transcriptions',
  baseUrl: '',
  model: '',
  note: '',
  advanced: false,
};

/* ═══════════════════════════════════════════════════════════
   红线 ①：TCS 服务端零接触（运行时抓包）
   ═══════════════════════════════════════════════════════════ */

test('★★ 红线①：整条转写链路只向用户配置的域名发请求', async () => {
  /*
   * 抓包方式：注入一个 fake fetch，记录**每一次**调用的完整 URL。
   *
   * 为什么这比"扫源码没有 TCS 字样"更强：
   * 源码里可能通过配置读到一个 TCS 地址（不是字面量），静态扫不出来。
   * 而抓包记录的是"真的发了什么"。
   *
   * 同时断言"只发了一次" —— 如果实现里悄悄加了个"上报"请求，
   * 那条会在这里露出来。
   */
  const captured = [];
  const fakeFetch = async (url, init) => {
    captured.push({ url: String(url), method: init?.method, headers: init?.headers });
    return {
      ok: true,
      status: 200,
      async json() {
        return { text: '识别结果' };
      },
    };
  };

  const userBase = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const result = await transcribe({
    preset: PRESET_A,
    baseUrl: userBase,
    apiKey: 'sk-user-key',
    model: 'paraformer-v2',
    audio: new Blob(['fake'], { type: 'audio/webm' }),
    fetchImpl: fakeFetch,
  });

  assert.equal(result.ok, true);

  // 只发一次，且 host 必须是用户填的那个
  assert.equal(captured.length, 1, `应当只发一次请求，实际 ${captured.length} 次`);
  const url = new URL(captured[0].url);
  assert.equal(url.host, 'dashscope.aliyuncs.com', '必须直连用户填的域名');
  assert.equal(url.pathname, '/compatible-mode/v1/audio/transcriptions');

  /*
   * 反向判据：请求里不许出现任何"我们的服务端"特征。
   *
   * 列出的是本项目历史上用过的服务端地址形态（serverUrl 默认值、
   * 内网 IP、TCS 特有的路径前缀）
   */
  const forbiddenPatterns = [
    /8730/, // 服务端默认端口
    /taverncard/i,
    /tcs-server/i,
    /10\.9\.0\./,
    /\/api\/cards/,
    /\/api\/auth/,
  ];
  for (const pattern of forbiddenPatterns) {
    assert.equal(
      pattern.test(captured[0].url),
      false,
      `请求 URL 命中了服务端特征 ${pattern}：${captured[0].url}`,
    );
  }
});

test('★ 红线①：换 base_url 时请求跟着换（证明没有硬编码目标）', async () => {
  const targets = [];

  for (const base of ['https://a.example.com/v1', 'https://b.example.com/v1']) {
    const captured = [];
    await transcribe({
      preset: PRESET_A,
      baseUrl: base,
      apiKey: 'k',
      model: 'm',
      audio: new Blob(['x']),
      fetchImpl: async (url) => {
        captured.push(String(url));
        return { ok: true, status: 200, json: async () => ({ text: 'x' }) };
      },
    });
    targets.push(new URL(captured[0]).host);
  }

  assert.deepEqual(targets, ['a.example.com', 'b.example.com'], '目标必须完全由用户配置决定');
});

test('★ 红线①：Authorization 带的是用户 key，不是任何内置凭据', async () => {
  let authHeader = null;
  await transcribe({
    preset: PRESET_A,
    baseUrl: 'https://x.com/v1',
    apiKey: 'sk-user-provided',
    model: 'm',
    audio: new Blob(['x']),
    fetchImpl: async (_url, init) => {
      authHeader = init.headers.Authorization;
      return { ok: true, status: 200, json: async () => ({ text: 'x' }) };
    },
  });

  assert.equal(authHeader, 'Bearer sk-user-provided');
});

/* ═══════════════════════════════════════════════════════════
   红线 ②：ASR 与聊天配置隔离
   ═══════════════════════════════════════════════════════════ */

test('★★ 红线②：往 ASR 作用域写聊天字段会当场抛错', () => {
  /*
   * 这条是需求原文点名的场景：「改 ASR key 后聊天配置显示不变」。
   *
   * 光靠"界面分开"不够 —— 接线错了照样串。`applyScopedPatch` 让串写
   * 变成**当场抛错**，而不是等线上出现"改语音把聊天弄坏了"。
   */
  const config = { asrBaseUrl: 'https://x/v1', serverUrl: 'http://127.0.0.1:8730' };

  assert.throws(
    () => applyScopedPatch(config, 'asr', { serverUrl: 'http://evil:1' }),
    ConfigScopeError,
    'ASR 作用域里写 serverUrl 必须抛错',
  );

  // 正常写自己的字段没问题
  const next = applyScopedPatch(config, 'asr', { asrBaseUrl: 'https://y/v1' });
  assert.equal(next.asrBaseUrl, 'https://y/v1');
});

test('★★ 红线②：改 ASR 配置后，聊天侧的字段一个都不变', () => {
  /*
   * 模拟真实调用顺序：用户先有完整配置 → 在语音页改了 base/key/model
   * → 断言聊天侧三个字段逐字段不变。
   */
  const before = {
    // 聊天侧
    serverUrl: 'http://127.0.0.1:8730',
    chatProvider: 'deepseek',
    chatModel: 'deepseek-chat',
    // ASR 侧
    asrBaseUrl: 'https://old-asr/v1',
    asrApiKey: 'old-key',
    asrModel: 'old-model',
    asrPresetId: 'aliyun-paraformer',
    // 语音偏好
    voiceConfirmBeforeSend: false,
  };

  const after = applyScopedPatch(before, 'asr', {
    asrBaseUrl: 'https://new-asr/v1',
    asrApiKey: 'new-key',
    asrModel: 'new-model',
    asrPresetId: 'openai-whisper',
  });

  // 聊天侧：逐字段不变（这是需求原话的判据）
  assert.equal(after.serverUrl, before.serverUrl);
  assert.equal(after.chatProvider, before.chatProvider);
  assert.equal(after.chatModel, before.chatModel);

  // ASR 侧：确实变了（否则说明这次写入没生效）
  assert.equal(after.asrBaseUrl, 'https://new-asr/v1');
  assert.equal(after.asrApiKey, 'new-key');
});

test('★ 红线②：语音偏好作用域也隔离（改确认开关不动 ASR 与聊天）', () => {
  const before = {
    serverUrl: 'http://127.0.0.1:8730',
    asrApiKey: 'keep-me',
    voiceConfirmBeforeSend: false,
  };

  const after = applyScopedPatch(before, 'voice', { voiceConfirmBeforeSend: true });

  assert.equal(after.voiceConfirmBeforeSend, true);
  assert.equal(after.asrApiKey, 'keep-me', '改确认开关不许动 ASR key');
  assert.equal(after.serverUrl, 'http://127.0.0.1:8730');
});

test('★ 红线②：两个作用域之间没有重名键（串味的物理基础）', () => {
  const collisions = overlappingConfigKeys();
  assert.deepEqual(collisions, [], `作用域之间有重名键：${JSON.stringify(collisions)}`);
});

test('★ 红线②：ASR 的键名都带 asr 前缀（误写时键名上就能看出来）', () => {
  for (const key of CONFIG_SCOPES.asr) {
    assert.ok(key.startsWith('asr'), `${key} 缺 asr 前缀 —— 误写到聊天侧时看不出来`);
  }
});

/* ═══════════════════════════════════════════════════════════
   红线 ③：语音标记 round-trip（完整 JSONL 链路）
   ═══════════════════════════════════════════════════════════ */

test('★★ 红线③：extra.tcs.voice 经完整保存/读取链路后仍在', () => {
  /*
   * 走真实链路：打标记 → 拼 header → joinForSave（JSONL 行）→ 序列化 →
   * 反序列化 → 逐字段对拍。
   *
   * 为什么必须走完整链路而不只 `JSON.parse(JSON.stringify())`：
   * `joinForSave` 会做字段归一（补默认值、裁剪），那一步才可能**悄悄丢字段**。
   * 只测 stringify 等于跳过了最容易出错的一环。
   */
  const original = {
    name: '我',
    is_user: true,
    send_date: '2026-10-30T12:00:00.000Z',
    mes: '“在吗”',
    // ST 自己会往 extra 里放东西，语音标记必须不挤掉它们
    extra: { api: 'openai', tcs: { cardId: 'demo' } },
    swipes: ['“在吗”'],
    swipe_id: 0,
  };

  const flagged = setVoiceFlag(original);
  assert.equal(isVoiceMsg(flagged), true);

  const header = buildChatHeader({ userName: 'unused', characterName: '西奥' });
  const lines = joinForSave(header, [flagged]);

  // .jsonl 的真实形态：一行一个 JSON
  const reloaded = JSON.parse(JSON.stringify(lines));
  assert.equal(reloaded.length, 2, 'header + 1 条消息');

  const message = reloaded[1];
  assert.equal(isVoiceMsg(message), true, 'round-trip 后徽标必须还在');
  assert.equal(message.extra.tcs.cardId, 'demo', 'tcs 命名空间里的其它键不许被挤掉');
  assert.equal(message.extra.api, 'openai', 'extra 顶层别人的字段也不许动');
  assert.equal(message.mes, '“在吗”');
  assert.deepEqual(message.swipes, ['“在吗”']);
  assert.equal(message.swipe_id, 0);
});

test('★ 红线③：去掉标记后与原始消息逐字段一致（标记只加一个键）', () => {
  const original = { name: '我', is_user: true, mes: 'x', extra: { api: 'openai' } };
  const flagged = setVoiceFlag(original);
  const cleared = setVoiceFlag(flagged, false);

  assert.equal(isVoiceMsg(cleared), false);
  assert.deepEqual(cleared, original, '标记位来回翻转后必须完全还原');
});

test('★ 红线③：打字发的消息不带标记（标记只表示"这条是语音"）', () => {
  const typed = { name: '我', is_user: true, mes: '打字的内容' };
  assert.equal(isVoiceMsg(typed), false);
});
