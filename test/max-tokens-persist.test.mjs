/**
 * 「最大回复长度」只保留一个入口（2026-11-21 用户决定）。
 *
 * ## 这一版改了什么
 *
 * 原来有两处都能设「最大回复长度」，写的是**同一个键**
 * `oai_settings.openai_max_tokens`：
 *
 * ```text
 *   API 连接页    → apiState.maxTokens（localStorage，按源存）
 *   AI 响应配置   → oai_settings.openai_max_tokens（ST 设置）
 * ```
 *
 * 而 API 页那份在 `deriveSampling()` 里**覆盖** ST 的值。于是：
 *
 * ```text
 *   用户在 API 页填 4096 → 保存 → 值确实进了 ST
 *   下次再进这一页      → 输入框显示 2048（草稿没从 apiState 回填）
 *   ⇒ 看起来"没保存"；再点一次保存就把 4096 覆盖成 2048
 * ```
 *
 * 用户报的「自定义接口里的回复长度无法保存（看起来像是无法保存，实际是保存了的）」
 * 就是这个。他自己的判断也对：**两处入口写同一个键，留一处更合理**。
 *
 * ## 现在的分工
 *
 * ```text
 *   「AI 响应配置」页  唯一入口，直接读写 openai_max_tokens
 *   保存连接配置       只写 源 / 模型 / 地址，不碰回复长度
 *   派生采样           只从 ST 设置派生，不再被 App 侧覆盖
 * ```
 *
 * ## 为什么保留 ST 落盘这条路（而不是删掉整个机制）
 *
 * 「AI 响应配置」页走的是 `mutateSettings`（GET → 改 → 整份 POST）。
 * 这条路径**必须**保留并且**必须**真的写进 ST —— 请求体的 `max_tokens`
 * 由 `samplingFromSettings()` 从 ST 派生，只存在 App 侧是不生效的。
 * 那部分判据在 `settings-schema` 与「AI 响应配置」的页测试里，不在这份。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('★★★★★ API 连接页不许再有「最大回复长度」', () => {
  /*
   * 两种写法都要禁：输入框（data-role）与标签文案。
   * 只禁 data-role 的话，将来有人写一个不带 data-role 的输入框照样过。
   */
  const page = strip(read('client/src/chat/api-page.ts'));
  assert.doesNotMatch(page, /max-tokens-input/, '不许再有这一格');
  assert.doesNotMatch(page, /最大回复长度/, '不许再出现这个标签');
});

test('★★★★★ 页面状态里不许再存 maxTokens', () => {
  /*
   * 只要 `ApiPageState` 还带这个字段，就一定会有人再把它接回保存链路。
   * 从类型上删掉是唯一彻底的写法。
   */
  const page = strip(read('client/src/chat/api-page.ts'));

  /* ApiPageState 定义段（interface 到 DEFAULT_API_STATE 之间） */
  const at = page.indexOf('export interface ApiPageState');
  assert.ok(at > 0, 'ApiPageState 要存在');
  const body = page.slice(at, page.indexOf('export const DEFAULT_API_STATE'));
  assert.doesNotMatch(body, /maxTokens/, 'ApiPageState 里不该再有 maxTokens');
});

test('★★★★ 保存连接配置只写源 / 模型 / 地址', () => {
  /*
   * `buildStConnectionPatch` 的职责就是这三件。
   * 它曾经还写 `openai_max_tokens` —— 结果是"只改模型名，长度被重置"。
   */
  const persist = strip(read('shared/src/chat/api-persist.ts'));
  const at = persist.indexOf('export function buildStConnectionPatch');
  assert.ok(at > 0, 'buildStConnectionPatch 要存在');
  const body = persist.slice(at, at + 2200);

  assert.match(body, /chat_completion_source/, '要写源');
  assert.match(body, /MODEL_FIELD_BY_SOURCE/, '要写模型');
  assert.match(body, /custom_url/, '要写地址');
  assert.doesNotMatch(body, /openai_max_tokens/, '不许写回复长度');
});

test('★★★★ 回读校验不许核回复长度', () => {
  /*
   * 写了才核。不写却核 = 每次保存连接都报一条假的"没写进去"，
   * 用户会被反复误导。
   */
  const persist = strip(read('shared/src/chat/api-persist.ts'));
  const at = persist.indexOf('export function verifyConnectionPersisted');
  assert.ok(at > 0, 'verifyConnectionPersisted 要存在');
  const body = persist.slice(at, at + 2600);
  assert.doesNotMatch(body, /openai_max_tokens/, '不该核这个键');
});

test('★★★★ 「AI 响应配置」必须保留唯一入口', () => {
  /*
   * 去掉一处的前提是另一处**确实存在且写的是同一个键**。
   * 这两条一起断言，防止"两边都删了"这种最坏结果。
   */
  const schema = read('shared/src/chat/settings-schema.ts');
  assert.match(schema, /label: '最大回复长度（Token）'/, '标签要在');
  assert.match(
    schema,
    /path: \['oai_settings', 'openai_max_tokens'\]/,
    '写的必须是 ST 的那个键',
  );
});

test('★★★ 派生采样只认 ST，不许被 App 侧覆盖', () => {
  /*
   * 这是两处入口"能打架"的机制所在：只要 `deriveSampling` 还读
   * `apiState.maxTokens`，就算 UI 删了，旧 localStorage 里的值仍会在
   * 下一次启动时把 ST 的值盖掉。
   */
  const shell = strip(read('client/src/chat/shell.ts'));
  const at = shell.indexOf('private deriveSampling');
  assert.ok(at > 0, 'deriveSampling 要存在');
  const body = shell.slice(at, at + 900);

  assert.match(body, /samplingFromSettings/, '要从 ST 设置派生');
  assert.doesNotMatch(body, /apiState/, '不许再读 apiState');
  assert.doesNotMatch(body, /maxTokens/, '不许再单独钉 maxTokens');
});

test('★★★ 外壳里不许再有写 maxTokens 的旁路方法', () => {
  /*
   * `writeMaxTokens` 是当年为"API 页那一格"造的第二条写 ST 的路径。
   * 留着它，将来任何一个入口都能绕过「AI 响应配置」改这个键。
   */
  const shell = strip(read('client/src/chat/shell.ts'));
  assert.doesNotMatch(shell, /writeMaxTokens/, '这个方法应已删除');
});

test('★★ 旧 localStorage 里的 maxTokens 读回时要被忽略', () => {
  /*
   * 升级用户的本机还留着 `{..., maxTokens: 4096}`。
   * 读回时若不丢弃，它会重新变成"App 侧那份"，与 ST 的值再次分叉。
   */
  const main = strip(read('client/src/mobile/main.ts'));
  const at = main.indexOf('function readApiState') >= 0
    ? main.indexOf('function readApiState')
    : main.indexOf('DEFAULT_API_STATE');
  assert.ok(at > 0, '要能找到读回配置的那段');
  const body = main.slice(at, at + 2600);
  assert.doesNotMatch(body, /\['maxTokens'\]/, '不许再从 localStorage 读它');
});
