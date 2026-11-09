/**
 * 「重新生成」的判据（2026-11-05）。
 *
 * ## 用户报的现象
 *
 * > 补充一下：重新生成的问题是我用语音的时候，语音服务响应较慢然后出现了这个问题
 *
 * 「语音服务响应较慢」这个补充信息很关键 —— 它把排查方向从"生成请求坏了"
 * 推到"**两路生成同时在跑**"。因为语音这条路径**不经过发送按钮**：
 * `voice-panel` 转写完成后直接调 `onSend → sendText`，所以按钮上的
 * `disabled` 状态拦不住它。
 *
 * 于是这个序列成立：
 *
 * ```text
 *   ① 按住说话 → 松手 → ASR 很慢（十几秒没动静）
 *   ② 用户以为卡住，点了 ↻ 重新生成 → 第一路生成开始
 *   ③ ASR 终于返回 → sendText 又发起第二路生成
 *   ⇒ 两路流同时写 this.messages：
 *      · this.handle 被覆盖，前一路的 done 回调按**旧下标**写正文
 *      · 正文长进别的气泡，或两边都超时报"连不上"
 * ```
 *
 * ## 顺着这条线查出来的三个缺陷
 *
 * | # | 缺陷 | 后果 |
 * |---|---|---|
 * | ① | 生成完直接改 `mes`，不走 `appendSwipe` | 旧回复连同 `swipes` 一起丢，滑不回去 |
 * | ② | 两条失败路径都不还原被弹出的那条 | 一次失败就永久少一条回复（其中一条还会落盘） |
 * | ③ | `regenerate` / `sendText` 都没有并发守卫 | 两路生成打架 |
 *
 * ## 为什么用静态判据而不是 DOM 测试
 *
 * 这三件事都是**控制流**：并发守卫要"在动手之前判"，还原要"在报错之前做"。
 * 用 DOM 测试只能观察结果，而结果取决于时序 —— 拿 stub 假装慢转写会写得
 * 又长又不稳。静态判据在这里恰好能表达真正的约束：
 * "守卫必须出现在改动数组之前"、"失败分支必须出现 restore"。
 *
 * 真机行为由 `.verify/probe-regenerate.mjs` 验（点 ↻ 后看候选数与正文）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** 剥注释：解释文字里会引用被禁/被要求的写法 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
}

const PANEL = 'client/src/chat/chat-panel.ts';

/** 取一个方法的方法体（从签名的 `{` 到匹配的收尾大括号） */
function methodBody(src, signature) {
  const at = src.indexOf(signature);
  assert.ok(at >= 0, `找不到方法 ${signature}`);

  /*
   * ★ 不能直接 `indexOf('{', at)`。
   *
   * `sendText(text: string, voice?: { voice: boolean; durationMs?: number })`
   * 的参数类型里就有一对花括号，取第一个 `{` 会把方法体截成
   * `{ voice: boolean; durationMs?: number }` —— 于是判据报"没有并发守卫"，
   * 而代码里明明有。**判据自己错了比漏判更费时间**：会让人去改本来正确的代码。
   *
   * 正确做法：先跳过参数列表（括号配对），参数列表之后的第一个 `{` 才是方法体。
   */
  let i = src.indexOf('(', at);
  assert.ok(i > 0, `${signature} 没有参数列表`);
  let paren = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '(') paren += 1;
    else if (src[i] === ')') {
      paren -= 1;
      if (paren === 0) break;
    }
  }
  const open = src.indexOf('{', i);
  assert.ok(open > 0, `${signature} 没有方法体`);

  let depth = 0;
  for (let j = open; j < src.length; j += 1) {
    const ch = src[j];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, j + 1);
    }
  }
  assert.fail(`${signature} 的大括号没闭合`);
  return '';
}

const panel = stripComments(read(PANEL));

test('★★★ regenerate 必须有并发守卫，且判在弹消息**之前**', () => {
  /*
   * 顺序是这条判据的全部意义。
   *
   * `popLastAssistant` 一调用，`this.messages` 就已经被改动了（少了一条）。
   * 守卫写在它后面，即使拦下来了也要额外还原 —— 而"拦下来"和"还原"
   * 两个动作各写一遍，迟早有一处漏掉。
   *
   * 所以要求：`isBusy(this.stream)` 出现在 `popLastAssistant` 之前。
   */
  const body = methodBody(panel, 'async regenerate(');
  const atGuard = body.indexOf('isBusy(this.stream)');
  const atPop = body.indexOf('popLastAssistant');

  assert.ok(atGuard >= 0, 'regenerate 里没有 isBusy 守卫 ⇒ 生成中再点 ↻ 会起第二路生成');
  assert.ok(atPop >= 0, 'regenerate 里没有 popLastAssistant');
  assert.ok(
    atGuard < atPop,
    'isBusy 守卫必须在 popLastAssistant 之前：弹出动作已经改了 this.messages，拦在之后就晚了',
  );
});

test('★★★ sendText 必须有并发守卫（语音这条路绕过了发送按钮）', () => {
  const body = methodBody(panel, 'async sendText(');
  const atGuard = body.indexOf('isBusy(this.stream)');
  assert.ok(
    atGuard >= 0,
    'sendText 里没有 isBusy 守卫 ⇒ 语音转写慢时用户点 ↻ 再等 ASR 返回，会两路生成同时跑',
  );
  /*
   * 守卫必须在 push 用户消息之前 —— 否则拦下来时消息已经进数组了，
   * 用户会看到自己那条话发出去了但没有回复。
   */
  const atPush = body.indexOf('this.messages = [...this.messages, message]');
  assert.ok(atPush > 0, 'sendText 里没找到插入用户消息那一行（判据过期了，请更新）');
  assert.ok(atGuard < atPush, 'isBusy 守卫必须在插入用户消息之前');
});

test('★★★ 重新生成必须走 appendSwipe，不许直接覆盖 mes', () => {
  /*
   * 覆盖 `mes` 会把旧的 `swipes` 一起丢掉 —— 用户点一次 ↻ 就再也滑不回去。
   * 而界面上有候选指示器（`1 / 2`），`appendSwipe` 也一直在 `shared` 里
   * 并且有 round-trip 契约测试，说明"多候选"本来就是设计好的形态。
   *
   * 这条判据盯两件事：`appendSwipe` 被 import 了、成功分支里真的用了。
   */
  assert.match(panel, /import\s*\{[\s\S]*?\bappendSwipe\b[\s\S]*?\}\s*from\s*'@tcs\/shared'/, 'appendSwipe 没被 import');

  const body = methodBody(panel, 'private async generate(');
  assert.match(
    body,
    /asSwipe\s*&&\s*restoreTarget\s*!==\s*undefined/,
    '成功分支没有区分"重新生成"与"普通发送"',
  );
  assert.match(body, /appendSwipe\(restoreTarget,\s*output\.text/, '重新生成成功后没有调用 appendSwipe');
});

test('★★★ 两条失败路径都必须还原被弹出的原消息', () => {
  /*
   * `generate` 有两条失败路径：
   *   · 拼请求失败（没配 API / 模型名为空 / 源不支持）
   *   · 空输出（模型没吐字、或中途断连）
   *
   * 两条都必须把被弹出的那条放回去。原来两条都只处理占位消息，
   * 而原消息在 `regenerate()` 里已经被弹出了 —— 于是"删占位"实际删掉的是
   * 用户唯一的那条回复，空输出那条还会 `onChatChanged` 把它落盘。
   */
  const body = methodBody(panel, 'private async generate(');
  /*
   * ★ 判"条件形式"而不是"文本出现次数"。
   *
   * 第一版只数 `restorePoppedMessage(` 出现几次，结果把分支改成
   * `if (false) { this.restorePoppedMessage(...) }` 之后——调用还在、
   * 只是永远不执行——判据依然全绿。变异验证就是这么发现它太弱的。
   *
   * 所以要求完整的 `if (restoreTarget !== undefined) { this.restorePoppedMessage(restoreTarget, insertAt) }`。
   */
  const restores = [
    ...body.matchAll(
      /if\s*\(restoreTarget\s*!==\s*undefined\)\s*\{?\s*this\.restorePoppedMessage\(restoreTarget,\s*insertAt\)/g,
    ),
  ].length;
  assert.ok(
    restores >= 2,
    `失败路径里"还原被弹出消息"的完整分支只有 ${String(restores)} 处，应该有 2 处（拼请求失败 + 空输出）`,
  );

  /* 还原必须在报错**之前**：报错是同步弹提示，用户看到提示时那条还没回来 */
  const atRestore = body.indexOf('restorePoppedMessage');
  const atNotify = body.indexOf('onNotify?.(built.message');
  assert.ok(atRestore > 0 && atNotify > 0, '判据过期：找不到还原或报错位置');
  assert.ok(atRestore < atNotify, '拼请求失败时应先还原再报错，否则用户看到报错时回复还没回来');
});

test('★★★ 还原之后不许再落盘（内容与盘上一致，再存是假写入）', () => {
  const body = methodBody(panel, 'private async generate(');
  /*
   * 空输出那条路径原来无条件 `onChatChanged`。还原之后内容没变，
   * 再通知外壳存一次会让用户以为发生了写入，也会白改一次指纹。
   * 所以要求它被 `restoreTarget === undefined` 包住。
   */
  assert.match(
    body,
    /if\s*\(restoreTarget\s*===\s*undefined\)\s*this\.callbacks\.onChatChanged/,
    '空输出失败后应只在"没有还原"时才 onChatChanged',
  );
});

test('★★ 重新生成按钮要跟生成状态一起置灰', () => {
  /*
   * 只靠守卫不够：按钮看着可点、点下去只弹一句"正在回复中"，
   * 用户会以为按钮坏了。禁用才是"现在不能点"的明确表达。
   */
  const body = methodBody(panel, 'private syncSendButton(');
  assert.match(body, /this\.regenEl/, 'syncSendButton 里没管重新生成按钮');
  assert.match(body, /disabled\s*=\s*busy/, '重新生成按钮没有跟着 busy 置灰');
  /*
   * 复位必须 removeAttribute：`disabled` 是布尔属性，`setAttribute('disabled','')`
   * 仍然是禁用（§2026-11-04 那个"按钮永久变灰"就是这么来的）。
   */
  assert.match(body, /removeAttribute\('disabled'\)/, '复位禁用要用 removeAttribute，不能用空串 setAttribute');
  assert.doesNotMatch(
    body,
    /setAttribute\('disabled',\s*''\)/,
    'setAttribute 空串不能复位布尔属性',
  );
});

test('★★★ 桥抛异常时也必须还原（真机抓到的"消息少一条"）', () => {
  /*
   * 这条是 `.verify/probe-regenerate.mjs` 跑出来的**真机证据**倒逼加的。
   *
   * 前三处还原只覆盖了"函数正常返回"的两条失败分支。但 `bridge.generate`
   * 在**注册监听**那一步就可能抛（`listen` 失败、invoke 被拒），
   * 异常会一路冒到 `regenerate()` 外面：
   *
   * ```text
   *   generate() 抛出 ⇒ finalizeOutput / 失败分支整段跳过
   *                  ⇒ restorePoppedMessage 永不执行
   *   ⇒ 消息数 48 → 47，最后一条变成上一条，落盘里也没有 swipes
   * ```
   *
   * 所以 `bridge.generate` + `handle.done` 必须包在 try/catch 里，
   * 且 catch 要**继续往下走**（不能 `return`），让后面的失败分支照常还原。
   */
  const body = methodBody(panel, 'private async generate(');
  const atTry = body.indexOf('try {');
  const atBridge = body.indexOf('this.bridge.generate');
  const atCatch = body.indexOf('} catch (error) {');
  /*
   * 从 `atCatch` **之后**找还原：方法体里 `restorePoppedMessage` 有两处，
   * 第一处在"拼请求失败"分支（在 try 之前），直接 indexOf 会拿到那一处，
   * 于是判据以为"还原写在 catch 前面"——又一次判据自己错。
   */
  const atRestore = body.indexOf('restorePoppedMessage', atCatch);

  assert.ok(atBridge > 0, '找不到 bridge.generate 调用');
  assert.ok(atTry > 0 && atTry < atBridge, 'bridge.generate 必须在 try 里');
  assert.ok(atCatch > atBridge, '必须有 catch，否则异常会跳过还原');
  assert.ok(atRestore > atCatch, '还原必须在 catch 之后（catch 里不能 return，要往下走到还原）');

  /* catch 里要把 stream 复位，否则 isBusy 永远 true、按钮永久置灰 */
  const catchBody = body.slice(atCatch, body.indexOf('// 收尾'));
  assert.match(catchBody, /this\.stream\s*=\s*createStreamState\(\)/, 'catch 里没复位 stream ⇒ 按钮会永久置灰');
  /* 失败判定要认 thrown，不能只看 output.ok */
  assert.match(body, /thrown\s*!==\s*null\s*\|\|\s*!output\.ok/, '失败判定没认 thrown');
});

test('★★★ 报错文案优先用抛出来的那条', () => {
  /*
   * 走到失败分支时 `this.stream` 已经被复位成空状态，
   * `stream.error` 是 null、`output.message` 只是"没有拿到内容"这种笼统话。
   * 桥的异常信息（"连不上 SillyTavern"之类）才是可排查的那条。
   */
  const body = methodBody(panel, 'private async generate(');
  assert.match(body, /onNotify\?\.\(thrown\s*\?\?/, '报错文案应优先用 thrown');
});

test('★★ 还原时下标要夹到合法范围', () => {
  /*
   * `splice` 对越界下标的直觉是错的（超出长度会追加到末尾，负数从尾部算）。
   * 显式夹一次，出错时只是位置偏一点，不会插到数组外面。
   */
  const body = methodBody(panel, 'private restorePoppedMessage(');
  assert.match(body, /Math\.max\(0,\s*Math\.min\(/, 'restorePoppedMessage 没有夹下标');
  assert.match(body, /splice\(at,\s*0,\s*target\)/, '没找到插回动作');
  /* 还原后必须重画，否则界面上还是缺一条 */
  assert.match(body, /this\.render\(\)/, '还原后没有重画');
});
