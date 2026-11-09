/**
 * ASR 失败分流 + 模型列表（v0.1.7 / T15.6，2026-10-29 定稿）单测。
 *
 * ## 这组测试守的是"用户会不会去改错东西"
 *
 * 定稿把失败分成三类，因为三类处置**互相排斥**：
 * - 401/403 → 换 key 或充值（换厂商没用）
 * - 404/405 → 换中转站或改直连（换 key 没用）
 * - 超时/网络 → 换网络（改配置没用）
 *
 * 混成一句"配置不可用"，用户必然去改那个没坏的东西。
 *
 * 第二组守的是「获取模型列表」的**静默降级**：
 * 它失败了也必须保持手填、不弹错误 —— 因为手填一直可用，这按钮只是省事。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildModelsUrl,
  classifyAsrFailure,
  classifyEmptyTranscript,
  interpretModelsResponse,
  parseModelsResponse,
} from '@tcs/shared';

/* ───────────── 失败分流 ───────────── */

test('★ 401 / 403 → 密钥或余额（不是"接口不支持"）', () => {
  for (const status of [401, 403]) {
    const failure = classifyAsrFailure({ status });
    assert.equal(failure.kind, 'auth');
    assert.match(failure.message, /密钥无效或余额不足/);
  }
});

test('★ 404 / 405 → 接口不支持（文案与定稿逐字一致）', () => {
  for (const status of [404, 405]) {
    const failure = classifyAsrFailure({ status });
    assert.equal(failure.kind, 'unsupported-endpoint');
    assert.equal(
      failure.message,
      '该中转站不支持语音转写接口（/audio/transcriptions），请更换中转站或使用直连厂商。',
    );
  }
});

test('★ 网络失败没有状态码，不能被报成"密钥无效"', () => {
  /*
   * 这是最容易写错的一处：用 `status === undefined` 去猜，
   * 猜错就把超时报成密钥问题，用户会去换一个本来好用的 key。
   */
  const timeout = classifyAsrFailure({ errorKind: 'timeout' });
  assert.equal(timeout.kind, 'network');
  assert.match(timeout.message, /超时/);

  const network = classifyAsrFailure({ errorKind: 'network' });
  assert.equal(network.kind, 'network');
  assert.match(network.message, /网络/);
});

test('没有状态码也没给 errorKind 时按网络处理（兜底不误报密钥）', () => {
  const failure = classifyAsrFailure({});
  assert.equal(failure.kind, 'network');
});

test('429 单独一类：处置是等一会儿，不是改配置', () => {
  const failure = classifyAsrFailure({ status: 429 });
  assert.equal(failure.kind, 'rate-limit');
  assert.match(failure.message, /稍后重试/);
});

test('其它状态码带上原始信息，便于排查但不泄露整段响应', () => {
  const failure = classifyAsrFailure({ status: 500, detail: 'x'.repeat(300) });
  assert.equal(failure.kind, 'other');
  assert.match(failure.message, /500/);
  // 截断到 120 字符，避免把整段 HTML 错误页塞进界面
  assert.ok(failure.message.length < 260, '未截断，可能把整段响应塞进界面');
});

test('★ 三条文案互不相同（混成一句就等于没有分流）', () => {
  const auth = classifyAsrFailure({ status: 401 }).message;
  const endpoint = classifyAsrFailure({ status: 404 }).message;
  const network = classifyAsrFailure({ errorKind: 'timeout' }).message;
  assert.notEqual(auth, endpoint);
  assert.notEqual(endpoint, network);
  assert.notEqual(auth, network);
});

/* ───────────── 空转写 ───────────── */

test('★ 转写返回空文本算失败（定稿要求"非空才允许启用"）', () => {
  /*
   * 空文本的真实成因有三种：音频没人声、格式不支持（服务端静默返回空）、
   * 模型名填错。三种都不能算"配置可用" —— 否则用户会在真正要说话时才发现它不工作。
   */
  assert.notEqual(classifyEmptyTranscript(''), null);
  assert.notEqual(classifyEmptyTranscript('   '), null);
  assert.equal(classifyEmptyTranscript('你好，今天天气不错'), null);
});

test('空转写的提示要能指向"检查模型名"（不只是"没说话"）', () => {
  const failure = classifyEmptyTranscript('');
  assert.ok(failure !== null);
  assert.match(failure.message, /模型名/);
});

/* ───────────── /models 地址 ───────────── */

test('★ base_url 末尾多余的斜杠要去掉（否则拼出 //models，部分网关 404）', () => {
  assert.equal(buildModelsUrl('https://api.groq.com/openai/v1'), 'https://api.groq.com/openai/v1/models');
  assert.equal(buildModelsUrl('https://api.groq.com/openai/v1/'), 'https://api.groq.com/openai/v1/models');
  assert.equal(buildModelsUrl('https://x.com/v1///'), 'https://x.com/v1/models');
});

test('★ 用户贴了完整接口路径时要退到根（中转站文档常给全路径）', () => {
  assert.equal(
    buildModelsUrl('https://relay.com/v1/audio/transcriptions'),
    'https://relay.com/v1/models',
  );
  assert.equal(
    buildModelsUrl('https://relay.com/v1/chat/completions'),
    'https://relay.com/v1/models',
  );
  // 带 query 也要能退
  assert.equal(
    buildModelsUrl('https://relay.com/v1/audio/transcriptions?x=1'),
    'https://relay.com/v1/models',
  );
});

test('★ 不擅自补 /v1（有的站是 /api/v1、/openai/v1，猜错比不补更糟）', () => {
  assert.equal(buildModelsUrl('https://relay.com'), 'https://relay.com/models');
});

test('空 base_url 返回空串（调用方据此不发请求）', () => {
  assert.equal(buildModelsUrl(''), '');
  assert.equal(buildModelsUrl('   '), '');
});

/* ───────────── /models 解析 ───────────── */

test('标准形状 { data: [{id, owned_by}] } 能解析', () => {
  const parsed = parseModelsResponse({
    data: [
      { id: 'whisper-1', owned_by: 'openai' },
      { id: 'whisper-large-v3-turbo', owned_by: 'groq' },
    ],
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.models.map((m) => m.id), ['whisper-1', 'whisper-large-v3-turbo']);
  assert.equal(parsed.models[0].ownedBy, 'openai');
});

test('直接返回数组 / 字符串数组都能解析（不同站形状不一样）', () => {
  const arrayForm = parseModelsResponse([{ id: 'a' }, { name: 'b' }, 'c']);
  assert.equal(arrayForm.ok, true);
  assert.deepEqual(arrayForm.models.map((m) => m.id), ['a', 'b', 'c']);
});

test('重复模型名要去重并按名字排序（下拉里有重复项会让人以为有两个模型）', () => {
  const parsed = parseModelsResponse({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.models.map((m) => m.id), ['a', 'b']);
});

test('空列表 / 无 id 的项判失败，不返回空数组当成功', () => {
  /*
   * 返回"成功但 0 个模型"会让 UI 显示一个空下拉框 ——
   * 用户会以为站里没模型，而实际是返回形状不认识。
   */
  assert.equal(parseModelsResponse({ data: [] }).ok, false);
  assert.equal(parseModelsResponse({ data: [{}] }).ok, false);
  assert.equal(parseModelsResponse(null).ok, false);
  assert.equal(parseModelsResponse('text').ok, false);
});

/* ───────────── 静默降级（定稿核心） ───────────── */

test('★ 401/403 在 /models 上也静默降级（不报"密钥无效"）', () => {
  /*
   * 定稿明确要求静默。理由站得住：`GET /models` 需要**额外的权限范围**，
   * 很多站的 key 允许转写但不允许列模型 —— 此时 401 完全不说明转写不可用。
   * 真正的判据是那段 3 秒测试音频。
   *
   * 若在这里因 401 弹"密钥无效"，用户会去换一个本来好用的 key。
   */
  for (const status of [401, 403]) {
    const outcome = interpretModelsResponse({ status, payload: {} });
    assert.equal(outcome.kind, 'fallback');
  }
});

test('★ 404/405 静默降级（不是所有站都开 /models）', () => {
  for (const status of [404, 405]) {
    assert.equal(interpretModelsResponse({ status, payload: {} }).kind, 'fallback');
  }
});

test('★ 任何失败都只产生 fallback，不产生错误对象', () => {
  /*
   * footer 的判据：这个函数的返回类型里**没有 error 字段**。
   * 类型层面就保证了"不会报错打扰"。
   */
  for (const status of [400, 401, 403, 404, 405, 429, 500, 502]) {
    const outcome = interpretModelsResponse({ status, payload: null });
    assert.equal(outcome.kind, 'fallback', `${String(status)} 不该是 ok`);
  }
});

test('成功时返回 ok 与模型列表', () => {
  const outcome = interpretModelsResponse({
    status: 200,
    payload: { data: [{ id: 'whisper-1' }] },
  });
  assert.equal(outcome.kind, 'ok');
  if (outcome.kind === 'ok') {
    assert.deepEqual(outcome.models.map((m) => m.id), ['whisper-1']);
  }
});

test('200 但内容不识别 → fallback（不是 ok 空列表）', () => {
  const outcome = interpretModelsResponse({ status: 200, payload: { unexpected: true } });
  assert.equal(outcome.kind, 'fallback');
});
