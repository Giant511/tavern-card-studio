/**
 * 「最大回复长度」必须真的落进 ST settings（2026-11-11）。
 *
 * ## 用户报的两件事，其实是同一件
 *
 * ```text
 * ① 我的 api 里面的最大回复长度改不了……改完保存之后回去一看发现还是 2048
 * ② /api/backends/chat-completions/generate 返回 403
 * ```
 *
 * ## 取证
 *
 * `buildStConnectionPatch` 只写了三个键：
 *
 * ```text
 *   chat_completion_source
 *   <源>_model
 *   custom_url
 * ```
 *
 * **没有 `openai_max_tokens`。** 而这个值恰恰决定两件事：
 *
 * ```text
 *   ① 生成时实际用多少（ST 的 openai.js 读它算 token budget）
 *   ② 上游按它**预扣额度** —— 预扣不下来就是
 *      {"code":"pre_consume_token_quota_failed"} 那条 403
 * ```
 *
 * 所以"改不了"很可能就是"403"的原因：值改不小 ⇒ 预扣下不来 ⇒ 拒绝。
 * 用户坚持"额度是有的"也对 —— 是**预扣**下不来，不是余额为零。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildStConnectionPatch, verifyConnectionPersisted } from '../shared/dist/chat/api-persist.js';

const ROOT = join(import.meta.dirname, '..');

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

test('★★★★★ buildStConnectionPatch 必须写 openai_max_tokens', () => {
  /*
   * 键名带 `openai` 前缀，但它对所有源（custom / deepseek / claude）都生效 ——
   * ST 的 `oai_settings` 只有这一个 token 预算字段。
   * 按"源"去分支会写出一个 ST 根本不读的键，那种错**保存成功、界面正常、
   * 生成时毫无效果**，最难查。
   */
  const patch = buildStConnectionPatch({
    source: 'custom',
    model: 'gpt-4o-mini',
    baseUrl: 'https://example.com/v1',
    maxTokens: 512,
  });

  assert.equal(
    patch['openai_max_tokens'],
    512,
    '最大回复长度没写进 patch —— 用户改了也不会生效',
  );
});

test('★★★★ maxTokens 无效时不许写脏值', () => {
  /*
   * `undefined` / `NaN` / `0` / `-1` 一律跳过，让 ST 保留自己的值。
   *
   * 写进一个 `null` 或 `"abc"` 比不写更坏：ST 会拿它去算预扣额度，
   * 而那正是 403 `pre_consume_token_quota_failed` 的来源。
   */
  const base = { source: 'custom', model: 'm', baseUrl: 'https://e.com/v1' };

  for (const bad of [undefined, Number.NaN, 0, -1]) {
    const patch = buildStConnectionPatch({ ...base, maxTokens: bad });
    assert.ok(
      !('openai_max_tokens' in patch),
      `maxTokens=${String(bad)} 时不该写这个键`,
    );
  }
});

test('★★★★★ 回读校验必须核 max_tokens（否则又是"假成功"）', () => {
  /*
   * 这个项目已经有教训：「POST 返回 200」只证明服务端收下了请求，
   * 不证明它按我们的意思存了。用户明确提出过"回读验证后 UI 才允许显示成功"。
   *
   * 所以 write 加了而 verify 没加，就等于放行了"写了但没生效"。
   */
  /*
   * ★ 只断言 **max_tokens 那一条**。
   *
   * `verifyConnectionPersisted` 还会顺带查 key 是否存在（"这次没写 key
   * 而服务里也没有旧值"）。我第一版拿整个 `problems` 和 `[]` 比，
   * 于是被那条无关的提示搞红了 —— 判据要钉它要管的那一项，别一锅端。
   */
  const maxTokenProblems = (problems) => problems.filter((p) => p.includes('最大回复长度'));

  const ok = verifyConnectionPersisted(
    { oai_settings: { chat_completion_source: 'custom', custom_model: 'm', custom_url: 'https://e.com/v1', openai_max_tokens: 512 } },
    { source: 'custom', model: 'm', baseUrl: 'https://e.com/v1', maxTokens: 512, keyWritten: false },
  );
  assert.deepEqual(maxTokenProblems(ok.problems), [], '一致时不该报 max_tokens 的问题');

  const bad = verifyConnectionPersisted(
    { oai_settings: { chat_completion_source: 'custom', custom_model: 'm', custom_url: 'https://e.com/v1', openai_max_tokens: 2048 } },
    { source: 'custom', model: 'm', baseUrl: 'https://e.com/v1', maxTokens: 512, keyWritten: false },
  );
  assert.equal(bad.ok, false, '值不一致必须报不 ok');
  assert.equal(
    maxTokenProblems(bad.problems).length,
    1,
    `要指名是哪一项没写进去，实际：${bad.problems.join(' / ')}`,
  );
});

test('★★★★ ST 存的可能是字符串，校验不许因此误报', () => {
  /*
   * 老版本 settings.json 里见过 `"300"`（字符串）。
   * 用严格 `!==` 比对，每次保存都会报一条假的"没写进去"，用户被反复误导。
   */
  const result = verifyConnectionPersisted(
    { oai_settings: { chat_completion_source: 'custom', custom_model: 'm', custom_url: 'https://e.com/v1', openai_max_tokens: '512' } },
    { source: 'custom', model: 'm', baseUrl: 'https://e.com/v1', maxTokens: 512, keyWritten: false },
  );
  assert.deepEqual(
    result.problems.filter((p) => p.includes('最大回复长度')),
    [],
    '字符串 "512" 应视为等于数字 512',
  );
});

test('★★★★ 说话人要能落进请求体：maxTokens 必须透到 onSave 调用点', () => {
  /*
   * 类型上加个可选字段很容易，但调用链有一环没传就白做。
   * 钉住那句 `{ source, model, baseUrl, maxTokens }`。
   */
  const page = read('client/src/chat/api-page.ts');
  assert.match(
    page,
    /onSave\(\s*\{[^}]*maxTokens/,
    'api-page 调 onSave 时必须带上 maxTokens',
  );
});
