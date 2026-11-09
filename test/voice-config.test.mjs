/**
 * 语音配置的默认值与会话记忆（v0.1.7 / T15.6 终版）。
 *
 * 守三件事：
 *   1. 设置项「语音发送前需确认」**默认 false**（零中断直发是默认体验）；
 *   2. 会话记忆 `voiceMode`：新会话回「说话」，切换后记住，且**不置脏**；
 *   3. ASR 与语音偏好的配置**双向隔离**（改一边不动另一边）。
 *
 * ## 第 3 条为什么值得单独测
 *
 * 需求原文把这条列为「重申，防接线合并」。它的失效形态很难查：
 * 不是"报错"，而是"改 ASR 厂商之后聊天突然不能用了" ——
 * 两件事在用户心里毫无关联。所以用作用域补丁器把它变成当场抛错。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ASR_CONFIG_KEYS,
  CONFIG_SCOPES,
  ConfigScopeError,
  DEFAULT_VOICE_MODE,
  VOICE_PREF_KEYS,
  applyScopedPatch,
  overlappingConfigKeys,
} from '@tcs/shared';

import { CardSession } from '../client/src/session/card-session.ts';
import { createEmptyCard } from '@tcs/shared';

/* ───────────── 默认值 ───────────── */

test('★ 设置项「语音发送前需确认」默认 false', async () => {
  // 从契约的默认配置读，而不是从设置面板读 —— 面板只是呈现，默认值在契约层
  const { DEFAULT_CLIENT_CONFIG } = await import('../client/src/contract/types.ts');
  assert.equal(
    DEFAULT_CLIENT_CONFIG.voiceConfirmBeforeSend,
    false,
    '默认必须关闭：语音的价值是快，默认开等于每条都先交一次确认税',
  );
  // 必须是布尔而不是 undefined：undefined 会让"缺键回落"逻辑与"用户显式关闭"混在一起
  assert.equal(typeof DEFAULT_CLIENT_CONFIG.voiceConfirmBeforeSend, 'boolean');
});

/* ───────────── 会话记忆 ───────────── */

test('★ 新会话默认「说话」，不继承上一个会话', () => {
  const a = new CardSession({ card: createEmptyCard() });
  assert.equal(a.voiceMode, DEFAULT_VOICE_MODE);
  assert.equal(a.voiceMode, 'speak');

  // 在 a 上切成「内心/动作」
  a.setVoiceMode('inner');
  assert.equal(a.voiceMode, 'inner');

  // 新建 b：必须回到默认，而不是跟着 a 变成 inner
  const b = new CardSession({ card: createEmptyCard() });
  assert.equal(b.voiceMode, 'speak', '模式按会话记忆，不是全局偏好');

  // a 自己还记得
  assert.equal(a.voiceMode, 'inner', 'a 的记忆不该被 b 影响');
});

test('★ 切语音模式**不置脏**（不改变卡片内容）', () => {
  const session = new CardSession({ card: createEmptyCard() });
  // 先落一次盘，清掉初始脏状态
  const clean = session.dirty;

  session.setVoiceMode('message');
  assert.equal(
    session.dirty,
    clean,
    '切模式只影响下一条语音怎么包裹，不该让标签上出现 ● 并弹未保存对话框',
  );
});

test('会话 voiceMode 接受坏值并收敛（不抛错）', () => {
  const session = new CardSession({ card: createEmptyCard() });
  session.setVoiceMode('shout');
  assert.equal(session.voiceMode, 'speak', '坏值收敛成默认而不是崩');
  session.setVoiceMode(null);
  assert.equal(session.voiceMode, 'speak');
  session.setVoiceMode('message');
  assert.equal(session.voiceMode, 'message');
});

test('同一模式重复设置是空操作（不产生新状态）', () => {
  const session = new CardSession({ card: createEmptyCard() });
  session.setVoiceMode('inner');
  const before = session.voiceMode;
  session.setVoiceMode('inner');
  assert.equal(session.voiceMode, before);
});

/* ───────────── ASR 与语音偏好隔离 ───────────── */

test('★ ASR 键与语音偏好键不重名（没有串味的物理基础）', () => {
  const collisions = overlappingConfigKeys();
  assert.deepEqual(collisions, [], `发现重名键：${collisions.join('；')}`);

  // 再直接对拍一次，避免 overlappingConfigKeys 自己写错
  const asr = new Set(ASR_CONFIG_KEYS);
  for (const key of VOICE_PREF_KEYS) {
    assert.equal(asr.has(key), false, `${key} 不该同时属于 ASR`);
  }
});

test('★ 改 ASR 配置不影响语音偏好（反向也成立）', () => {
  // 一份"两条都在"的配置：模拟真实的应用配置对象
  const config = {
    asrBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    asrApiKey: 'sk-old',
    asrModel: 'paraformer-v2',
    asrPresetId: 'aliyun',
    voiceConfirmBeforeSend: false,
  };

  // ① 换 ASR 厂商（改三个 asr 键）
  const afterAsr = applyScopedPatch(config, 'asr', {
    asrBaseUrl: 'https://api.groq.com/openai/v1',
    asrApiKey: 'sk-new',
    asrModel: 'whisper-large-v3',
  });
  assert.equal(
    afterAsr.voiceConfirmBeforeSend,
    false,
    '换 ASR 厂商**不许**动确认开关：那会静默改掉用户的交互习惯',
  );

  // ② 打开确认开关（改语音偏好）
  const afterVoice = applyScopedPatch(config, 'voice', { voiceConfirmBeforeSend: true });
  assert.equal(afterVoice.asrBaseUrl, config.asrBaseUrl, '改交互偏好不许动 ASR 地址');
  assert.equal(afterVoice.asrApiKey, config.asrApiKey, '改交互偏好不许动 ASR 密钥');
  assert.equal(afterVoice.asrModel, config.asrModel, '改交互偏好不许动 ASR 模型');
  assert.equal(afterVoice.asrPresetId, config.asrPresetId, '改交互偏好不许动厂商选择');

  // ③ 原对象不可变（纯函数）
  assert.equal(config.voiceConfirmBeforeSend, false);
  assert.equal(config.asrApiKey, 'sk-old');
});

test('★ 跨作用域写入直接抛错（不是静默忽略）', () => {
  const config = { asrModel: 'x', voiceConfirmBeforeSend: false };

  // 想用"语音"这次调用顺手改 ASR —— 必须被拦下
  assert.throws(
    () => applyScopedPatch(config, 'voice', { asrModel: 'y' }),
    (error) => {
      assert.ok(error instanceof ConfigScopeError);
      assert.deepEqual(error.offendingKeys, ['asrModel']);
      // 错误信息要能指导下一步：说清允许哪些键
      assert.match(error.message, /voiceConfirmBeforeSend/);
      return true;
    },
    '跨作用域必须抛错：静默忽略等于没防，接线错了照样串味',
  );

  // 反方向同理
  assert.throws(
    () => applyScopedPatch(config, 'asr', { voiceConfirmBeforeSend: true }),
    ConfigScopeError,
  );

  // 作用域内的合法写入不抛
  const ok = applyScopedPatch(config, 'asr', { asrModel: 'whisper-1' });
  assert.equal(ok.asrModel, 'whisper-1');
  assert.equal(ok.voiceConfirmBeforeSend, false, '作用域内写入也不许碰另一个作用域');
});

test('作用域声明本身是完整的（新增作用域不会漏掉键）', () => {
  assert.deepEqual(Object.keys(CONFIG_SCOPES).sort(), ['asr', 'voice']);
  assert.deepEqual([...ASR_CONFIG_KEYS].sort(), ['asrApiKey', 'asrBaseUrl', 'asrModel', 'asrPresetId']);
  assert.deepEqual([...VOICE_PREF_KEYS], ['voiceConfirmBeforeSend']);
});
