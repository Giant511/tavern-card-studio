/**
 * 保存反馈 + 已选角色误判（2026-11-01 两个问题点）。
 *
 * ## 问题一：保存后无任何反馈
 *
 * 用户截图 21:32：点保存后停在原页，无成功提示也无失败提示。
 *
 * 取证到**两处断点**：
 *
 * | 断点 | 现象 |
 * |---|---|
 * | ① `status.hidden = true` 无条件执行 | "已保存"写进了 textContent，但元素被隐藏 ⇒ 一个字看不到 |
 * | ② 语音页**根本没有 `notice` 机制** | 整页重绘后 status 是旧节点，改它无效果 |
 *
 * 而**保存本身是成功的**（localStorage 里字段都对）—— 这正是用户
 * "无法判断是否保存成功"的一半原因：不是失败，是反馈丢了。
 *
 * ## 问题二：已选角色仍提示"先选择一个角色"并跳转
 *
 * 根因是**我上一轮修复引入的回归**：读回历史走 `setMessages`，
 * 而 `setMessages` 不设 `avatar` ⇒ `sendText` 判 `avatar === null`。
 *
 * 两处断点：
 * | 断点 | 现象 |
 * |---|---|
 * | ① `setMessages` 不设 avatar | 有历史时面板没有角色身份 |
 * | ② `sendText` 用 `onNeedApiConfig()` 跳 Tab | 违规跳转，还会丢掉刚打的草稿 |
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const apiPage = read('client/src/chat/api-page.ts');
const voicePage = read('client/src/chat/voice-settings.ts');
const shell = read('client/src/chat/shell.ts');
const chatPanel = read('client/src/chat/chat-panel.ts');
const main = read('client/src/mobile/main.ts');

/* ═══════════════════════════════════════════════════════════
   问题一：保存反馈
   ═══════════════════════════════════════════════════════════ */

test('★★★ API 页：有 notice 时 status 不许被隐藏', () => {
  /*
   * 原来这里是：
   * ```js
   * if (callbacks.notice !== undefined) { status.textContent = ...; }
   * status.hidden = true;          // ← 无条件，把上面那行彻底废掉
   * ```
   *
   * 判据不能只断言 `textContent`（那样原代码也能过）——
   * **必须断言可见性**。这正是原测试假绿的原因。
   */
  assert.match(apiPage, /const hasNotice =/, '要先算出有没有提示');
  assert.match(apiPage, /status\.hidden = !hasNotice/, '隐藏与否取决于有没有提示');
  assert.doesNotMatch(
    apiPage.replace(/\/\*[\s\S]*?\*\//g, ''),
    /^\s*status\.hidden = true;$/m,
    '不许无条件隐藏 status（注释里的历史说明不算）',
  );
});

test('★★★ 语音页也要有 notice（原来彻底没有）', () => {
  /*
   * API 页有 `notice`，语音页**没有** —— 所以那边连"写进去了但看不见"
   * 都算不上，是整页重绘后提示彻底丢失。
   */
  assert.match(voicePage, /notice\?: string;/, '语音页回调要有 notice');
  assert.match(voicePage, /const hasNotice =/, '要算有没有提示');
  assert.match(voicePage, /status\.hidden = !hasNotice/, '按提示决定显隐');
});

test('★★ 外壳要在重绘前记下提示，两个页面都要', () => {
  assert.match(shell, /pendingApiNotice/, 'API 页要记');
  assert.match(shell, /pendingVoiceNotice/, '语音页要记');
  assert.match(shell, /notice: this\.pendingApiNotice \?\? undefined/, 'API 页要传');
  assert.match(shell, /notice: this\.pendingVoiceNotice \?\? undefined/, '语音页要传');
});

test('★★★ 保存结果以**回读**为准，不许只看写入没抛错', () => {
  /*
   * 用户原话：「保存结果必须以回读为准（写入后读回比对），
   * 不许只看写入调用未抛错就算成功」。
   *
   * 原来两个写入函数都是 `catch { /* 吞掉 *​/ }` —— 失败完全静默，
   * 界面显示"已保存"而其实什么都没存。
   */
  for (const [name, fn] of [
    ['writeApiState', 'API'],
    ['writeVoiceSettings', '语音'],
  ]) {
    const start = main.indexOf(`function ${name}(`);
    assert.ok(start > 0, `要有 ${name}`);
    const body = main.slice(start, main.indexOf('\n}', start));

    assert.match(body, /storage\.getItem\(/, `${fn}要回读`);
    assert.match(body, /throw new Error/, `${fn}失败要抛错，不许吞`);
  }
});

test('★★ 回读要比对**具体字段**，不是只判断"读到了"', () => {
  /*
   * 只判断 `getItem() !== null` 抓不到"写进去了但字段被覆盖/丢失"。
   * 用户要求的是"读回比对"，比对就必须落到字段上。
   */
  const apiStart = main.indexOf('async function writeApiState(');
  const apiBody = main.slice(apiStart, main.indexOf('\n}', apiStart));
  assert.match(apiBody, /record\['source'\]/, 'API 要比对接口源');
  assert.match(apiBody, /record\['model'\]/, 'API 要比对模型名');
  assert.match(apiBody, /record\['baseUrl'\]/, 'API 要比对服务地址');

  const voiceStart = main.indexOf('async function writeVoiceSettings(');
  const voiceBody = main.slice(voiceStart, main.indexOf('\n}', voiceStart));
  assert.match(voiceBody, /record\['presetId'\]/, '语音要比对厂商');
  assert.match(voiceBody, /record\['model'\]/, '语音要比对模型名');
});

test('★★ 反馈文案要带"当前生效摘要"（不只是一句"已保存"）', () => {
  /*
   * 只写"已保存"信息量太低：用户还要自己回想"我存的是哪个厂商、哪个模型"。
   */
  assert.match(
    shell,
    /pendingVoiceNotice = `已保存 · \$\{voiceSummary\(settings\)\}`/,
    '语音提示要带摘要',
  );
});

/* ═══════════════════════════════════════════════════════════
   问题二：已选角色误判
   ═══════════════════════════════════════════════════════════ */

test('★★★ `setMessages` 必须能设置 avatar（这是根因）', () => {
  /*
   * 上一轮修复让"冷启动读回历史"生效 ⇒ `chatSnapshot` 非空 ⇒
   * `renderChat()` 走 `setMessages` 分支，**绕过 `newChat()`** ——
   * 而 `newChat()` 是唯一设置 `avatar` 的地方。
   *
   * 结果：历史有了、身份没有 ⇒ 发消息判"没选角色"。
   */
  const fn = chatPanel.slice(chatPanel.indexOf('  setMessages('));
  const body = fn.slice(0, fn.indexOf('\n  }') + 4);
  assert.match(fn.slice(0, 200), /avatar\?: string/, 'setMessages 要接受 avatar 参数');
  assert.match(body, /this\.avatar = avatar/, '要真的设上去');
});

test('★★★ 外壳调 setMessages 时必须传 avatar', () => {
  /*
   * 判据钉**完整调用形态**，不是"某处出现 selectedCharacter" ——
   * 后者在上下文中到处都是，缺陷能溜过去（这个错本轮已经犯过一次）。
   */
  assert.match(
    shell,
    /panel\.setMessages\(\s*this\.chatSnapshot\.messages,\s*this\.chatSnapshot\.fileName,\s*this\.selectedCharacter\?\.avatar,\s*\)/,
    'setMessages 要传第三个参数 avatar',
  );
});

test('★★★ `sendText` 判没选角色时**不许跳 Tab**', () => {
  /*
   * 用户原话：「跳转行为只应发生在"用户点配置入口"时，
   * 发送消息失败绝不应跳 Tab」。
   *
   * 而且跳去「我的」页也解决不了 —— 选角色的入口在聊天页顶栏 ☰，
   * 不在「我的」页。所以那个跳转连"导向正确的地方"都算不上。
   */
  const fn = chatPanel.slice(chatPanel.indexOf('async sendText('));
  const raw = fn.slice(0, fn.indexOf('const base: StChatMessage'));

  assert.match(raw, /onNotify\?\.\(/, '要给就地提示');

  /*
   * ★ 必须**剥离注释**再断言"不许出现 onNeedApiConfig"。
   *
   * 我在修法的注释里写了「原来这里是 `this.callbacks.onNeedApiConfig?.()`」
   * 来说明改了什么 —— 不剥注释的话，那句被解释的历史代码会被当成现存代码，
   * 判据**假红**。
   *
   * 这是本项目今天第三次踩「注释被当成代码」（前两次：走查 6 的
   * `transition: height`、`mic-release` 里禁 stage 判断那条）。
   * **静态扫描第一步永远是剥离注释** —— 这条已经写进 memory 了，
   * 还是又犯了一次，说明它不是"记得就行"，得靠模板固定。
   */
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(
    code,
    /onNeedApiConfig/,
    'sendText 里不许调 onNeedApiConfig（那会跳 Tab；注释里的历史说明不算）',
  );
});

test('★ 提示要指向真正的入口（☰），而不是"去看 API 配置"', () => {
  const fn = chatPanel.slice(chatPanel.indexOf('async sendText('));
  const body = fn.slice(0, fn.indexOf('const base: StChatMessage'));
  assert.match(body, /☰/, '提示要告诉用户去哪点');
});

test('★★ 保留 `generate` 里那处跳转（它确实该跳）', () => {
  /*
   * `generate()` 里 `built.reason === 'empty-model'` 时跳配置页是**对的** ——
   * 那时确实要去「我的」填模型名。
   *
   * 这条测试守的是"别把该跳的也一起删掉"：修"不该跳"时容易一刀切。
   */
  const fn = chatPanel.slice(chatPanel.indexOf('private async generate('));
  const body = fn.slice(0, fn.indexOf('const placeholder'));
  assert.match(body, /built\.reason === 'empty-model'[\s\S]{0,200}?onNeedApiConfig/, '这处该跳的要留着');
});

/* ═══════════════════════════════════════════════════════════
   问题一追加：初始值回填必须**完整**（2026-11-01 真机取证）
   ═══════════════════════════════════════════════════════════ */

test('★★★ API 页：打开时 baseUrl 必须从 initial 回填，不许写死空串', () => {
  /*
   * 真机实测（2026-11-01 23:25）拿到的形状：
   *
   *   localStorage['tcs.mobile.apiState']
   *     = {source:'custom', model:'[次0.2]claude-opus-4-8',
   *        baseUrl:'https://ai.ota1245.top/v1'}
   *
   *   打开 API 配置页后
   *     model-input.value   = '[次0.2]claude-opus-4-8'   ← 回填了
   *     baseurl-input.value = ''                          ← 没回填
   *
   *   点「保存」→ api-status = '自定义接口要填服务地址。填到 /v1 为止，再保存。'
   *
   * ⇒ 用户看到"保存没反应/保存不了"，而他的地址一直好好存着。
   *
   * ## 这条判据为什么必须钉"两个字段都在"
   *
   * 只断言"代码里出现了 initial.baseUrl"是不够的：
   * `baseUrl: source === initial.source ? initial.baseUrl : ''` 与
   * `model: source === initial.source ? initial.model : ''` 必须**并列**
   * 出现在同一段 drafts 初始化里 —— 这才是"回填动作完整"的形态。
   * 前一版正是只有 model 那一半，而测试全绿（根本没有判据看这里）。
   */
  const start = apiPage.indexOf('const drafts = new Map<');
  assert.ok(start >= 0, '找不到 drafts 初始化段');
  /*
   * 切片终点要避开注释里的 `});`：注释块里写了示例代码。
   * 先剥注释再切片，否则 `apiPage.indexOf('});')` 可能落在注释中间。
   */
  const stripped = apiPage.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const s2 = stripped.indexOf('const drafts = new Map<');
  assert.ok(s2 >= 0, '剥注释后找不到 drafts 初始化段');
  const block = stripped.slice(s2, stripped.indexOf('});', s2) + 3);

  assert.match(
    block,
    /model:\s*source === initial\.source \? initial\.model : ''/,
    'model 要继承 initial.model',
  );
  assert.match(
    block,
    /baseUrl:\s*source === initial\.source \? initial\.baseUrl : ''/,
    '★ baseUrl 也必须继承 initial.baseUrl（写死空串会让保存走校验失败分支）',
  );

  /*
   * 反向断言：不许再出现 `baseUrl: ''` 这种"看着像初始化其实清空"的写法。
   * 没有这一条，将来有人把上面那行改回去、只留下 model 那半，测试仍然绿。
   */
  assert.doesNotMatch(
    block,
    /baseUrl:\s*''/,
    '不许把 baseUrl 写成空串（那等于打开页面就把已保存的地址清掉）',
  );
});

test('★★ 语音页的 baseUrl 回填同样不许丢（对照：它本来就是对的）', () => {
  /*
   * 两页做同一件事（把 initial 填进输入框），如果只有一页写对，
   * 就说明"同一件事写两遍"的分叉已经发生。
   * 这条钉住语音页不要被将来的重构带坏。
   */
  assert.match(
    voicePage,
    /\(urlInput as unknown as HTMLInputElement\)\.value = initial\.baseUrl/,
    '语音页 urlInput 要直接用 initial.baseUrl',
  );
  assert.match(
    voicePage,
    /\(modelInput as unknown as HTMLInputElement\)\.value = initial\.model/,
    '语音页 modelInput 要直接用 initial.model',
  );
});
