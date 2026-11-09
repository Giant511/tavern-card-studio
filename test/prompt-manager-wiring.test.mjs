/**
 * 「提示词管理器」的**接线**判据（2026-11-03）。
 *
 * ## 为什么拼装逻辑测过了，还要单独测接线
 *
 * 本项目已经出现过 **6 次**「函数写好了但没人调」：
 *
 * ```text
 *   §70.3  聊天不保存      —— save 函数存在，没人调
 *   §71.2  API 配置页回填  —— 回填函数存在，入口没接
 *   §88    语音链路         —— 面板做完，链路没接
 * ```
 *
 * 每次现象都一样：**功能看起来存在，实际一点没生效**，而且单测全绿
 * （单测直接调那个函数，当然绿）。
 *
 * 所以这组判据不看"逻辑对不对"（那是 `prompt-manager.test.mjs` 的事），
 * 只看**数据从哪来、有没有真的接进生成链路**。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CHAT_DIR = join(REPO, 'client', 'src', 'chat');

const shellSrc = () => readFileSync(join(CHAT_DIR, 'shell.ts'), 'utf8');
const panelSrc = () => readFileSync(join(CHAT_DIR, 'chat-panel.ts'), 'utf8');

test('★★★ 面板要真的按配置拼装（不是只把配置存起来）', () => {
  /*
   * 最常见的"假接线"：把 `promptConfig` 放进 ctx、一路传下去，
   * 但拼装处仍然调旧的 `assembleContext`。
   *
   * 那种情况下配置传得再对也没用，而代码看起来"该接的都接了"。
   */
  const src = panelSrc();

  assert.match(src, /assembleWithPrompts\(\{/, '生成时要调新拼装器');
  assert.match(src, /usePromptManager/, '要有"用哪条路径"的判断');

  /*
   * 两条路径都必须存在 —— 没有配置时回退到旧拼装。
   * 只写新路径的话，用户在 ST 里没有预设时聊天会发空上下文。
   */
  assert.match(src, /:\s*assembleContext\(\{/, '必须保留旧拼装的回退');
});

test('★★★ 没有配置时必须回退（不能发空上下文）', () => {
  /*
   * `promptConfig` 为 `null` 或 `prompts` 为空时，`assembleWithPrompts`
   * 会拼出几乎空的消息列表 —— 模型完全不知道在扮演谁。
   *
   * 这比用旧逻辑更糟：旧逻辑至少带上了角色描述。
   */
  const src = panelSrc();

  assert.match(
    src,
    /promptConfig !== null && promptConfig\.prompts\.length > 0/,
    '要判"配置存在且非空"才走新路径',
  );
});

test('★★★ 外壳必须真的调用播种（否则配置永远是 null）', () => {
  /*
   * ★ 这条是本轮最该守的：`seedPromptConfig()` 写好了但没人调，
   * 现象就是"提示词管理器做完了，但一点效果都没有"。
   */
  const src = shellSrc();

  assert.match(src, /private async seedPromptConfig\(\)/, '要有播种方法');
  assert.match(src, /void this\.seedPromptConfig\(\);/, '要在进聊天页时调用它');

  /* 与 seedSampling 并列，不许被注释掉 */
  const callSite = src.slice(src.indexOf('void this.seedPromptConfig();') - 200, src.indexOf('void this.seedPromptConfig();'));
  assert.equal(/\/\/\s*void this\.seedPromptConfig/.test(callSite), false, '不许是注释掉的调用');
});

test('★★ 切换预设后要重新解析提示词（否则换了预设提示词不换）', () => {
  /*
   * 采样值切了、提示词没切 —— 表现是"换了预设，风格只变了一半"。
   * 这种半生效最难归因：用户会以为模型不稳定。
   */
  const src = shellSrc();
  const applyBlock = src.slice(src.indexOf('apply: async (name)'));

  const samplingAt = applyBlock.indexOf('this.chatPanel?.setContext({ sampling:');
  const promptAt = applyBlock.indexOf('promptConfig: this.promptConfig');
  assert.ok(samplingAt > 0, '切换后要更新采样');
  assert.ok(promptAt > 0, '切换后也要更新提示词配置');
  assert.ok(promptAt > samplingAt, '两处都该在 apply 成功分支里（顺序上提示词在后）');
});

test('★★ 读的是「预设体」而不是 settings.json（实机验过那条是空的）', () => {
  /*
   * 2026-11-03 实机：
   *
   * ```text
   *   settings.json 的 oai_settings → 0 个键
   *   OpenAI Settings/*.json        → 62 个键，含 prompts + prompt_order
   * ```
   *
   * 若从 settings.json 读 `oai_settings.prompts`，永远是 undefined ⇒
   * 配置恒为 null ⇒ 静默回退到旧逻辑，而用户完全不知道。
   */
  const src = shellSrc();
  const block = src.slice(src.indexOf('private async seedPromptConfig()'));

  assert.match(block, /presetBodiesByName\(/, '要从预设体取（不是从 oai_settings）');
  assert.match(block, /currentPresetName\(/, '要知道当前用的是哪个预设');
});

test('★ 解析出的警告要能到用户眼前（不许静默跳过）', () => {
  /*
   * 顺序表引用了不存在的项、`character_id` 对不上……这些都会导致
   * "设了不生效"。静默跳过等于让用户自己猜。
   */
  const src = shellSrc();
  const block = src.slice(src.indexOf('private async seedPromptConfig()'));

  assert.match(block, /config\.warnings\.length > 0/, '要检查解析警告');
  assert.match(block, /onNotify\?\.\(/, '警告要给用户看到');
});

/* ═══════════════════════════════════════════════════════════
   五、token 预算的接线（2026-11-03，④）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 生成前必须真的按预算裁剪（不是拼完直接发）', () => {
  /*
   * 这是 ④ 的核心接线。漏了它的现象是"长对话报 400"，
   * 而代码看起来一切正常（拼装没错、请求也没错，只是没裁）。
   */
  const src = panelSrc();

  assert.match(src, /applyBudget\(/, '要有按预算裁剪的步骤');
  assert.match(src, /await this\.applyBudget\(/, '裁剪是异步的（要等真实分词）');
  assert.match(src, /finalMessages = budgeted\.dropped\.messages/, '发出去的必须是裁剪后的');
  assert.match(
    src,
    /messages: finalMessages/,
    'buildGenerateRequest 要收裁剪后的消息',
  );
});

test('★★★ 逐条标记要跟着 system 指令一起左移', () => {
  /*
   * 「AI 帮答」会在最前面插一条 system 指令。若不同步把 `trimmable`
   * 也左移一位，标记会**整体错位一格** ——
   * 表现是"裁掉了不该裁的那条"（比如把用户提示词当历史删了），
   * 而且完全是静默的。
   */
  const src = panelSrc();

  assert.match(src, /\[false, \.\.\.assembled\.trimmable\]/, '插了 system 就要补一个 false 在最前');
});

test('★★ 裁剪掉了历史要告诉用户（否则像"AI 记性变差"）', () => {
  /*
   * 不说的话，用户会以为模型变笨了 —— 而实际是我们主动丢了最早的几轮。
   * 一句话就能把这件事从"缺陷"变成"预期"。
   */
  const src = panelSrc();

  assert.match(src, /budgeted\.dropped\.trimmedCount > 0/, '要判断有没有裁掉');
  assert.match(src, /已略过最早/, '要明说裁了几条');
});

test('★★ 必留项超预算要提醒用户去关提示词', () => {
  /*
   * 这时裁什么都是错的（裁也放不下）。不提醒的话，
   * 用户看到的是"发出去报错"，而我们本可以提前说清原因。
   */
  const src = panelSrc();
  assert.match(src, /budgeted\.overBudget/, '要处理必留超限');
  assert.match(src, /超过上下文预算/, '要给一句能指导行动的话');
});

test('★★ 计数失败必须回退估算，不能因此卡住发送', () => {
  /*
   * ST 没起来、分词器加载失败都会让真实计数抛错。
   * 那时**不能中断发送** —— 用估算值继续。
   */
  const src = panelSrc();

  assert.match(src, /estimateTokens\(/, '要用估算兜底');
  /* 真实计数必须包在 try 里 */
  const block = src.slice(src.indexOf('async applyBudget'));
  const tryAt = block.indexOf('try {');
  const countAt = block.indexOf('this.bridge.countTokens');
  assert.ok(tryAt > 0 && countAt > tryAt, '真实计数必须在 try 里');
});

test('★★★ 预算的两个输入要从 ST 设置读（不是写死）', () => {
  const shell = shellSrc();

  assert.match(shell, /openai_max_context/, '上下文上限要读 ST 的值');
  assert.match(shell, /openai_max_tokens/, '回复额度也要读');
  assert.match(shell, /contextLimit = contextLimit/, '要存到外壳上供预算回调使用');
});

test('★★ 设置页要显示预算（用户才看得到改完的效果）', () => {
  /*
   * `上下文长度` 就在这张表单里。改完没有任何反馈的话，
   * 用户不知道"这数字够不够"，也不知道"上次用了多少"。
   */
  const src = readFileSync(join(CHAT_DIR, 'chat-settings.ts'), 'utf8');
  assert.match(src, /callbacks\.budget/, '设置页要读预算');
  assert.match(src, /上下文预算/, '要把预算显示出来');

  const shell = shellSrc();
  assert.match(shell, /budget: \(\) =>/, '外壳要给 budget 回调');
  assert.match(shell, /computeBudget\(/, '预算要用共享公式算');
});
