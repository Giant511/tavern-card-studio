/**
 * 三条用户报的缺陷（2026-11-05）。
 *
 * ## 一、键盘避让：`window.activeElement` 是 `undefined`
 *
 * 用户：
 *
 * > 还有仓库里面，你的键盘避让没做，你再检查一下，所有用户可输入文本的地方
 * > 都应该做键盘避让（包括系统的密码输入键盘）
 *
 * CSS 那条链（`.nb-app` 的 `padding-bottom`）一直是好的 —— 真机上量得到
 * `kb=370px / pad=314px / 可见底边 464`。坏的是**滚动**那一半：
 *
 * ```ts
 * // mobile/main.ts 原来
 * attachFocusScroll(globalThis, …)        // ← 传的是 window
 * // focus-scroll.ts 里
 * const active = doc.activeElement        // ← window.activeElement = undefined
 * ```
 *
 * `activeElement` 只存在于 `document` 上。于是 `revealFocusedInput` 每次
 * 第一行就 `return false`，**一次滚都没滚过**。
 *
 * 真机证据（`.verify/diag-focus-timeline.mjs`）：
 *
 * ```text
 *   +120 起  可见底=464  kb=370px   ← CSS 正常
 *   元素底边恒为 632               ← 被盖住 168px
 *   scrollTop 恒为 0               ← 从未动过
 * ```
 *
 * ## 二、切换仓库类型丢登录态
 *
 * 用户：
 *
 * > 只要从内置云仓库切到自定义仓库，或者是自定义切到内置云仓库，
 * > 登录状态都会消失，但是杀掉进程和切换到其他页面不会消失
 *
 * ## 三、思考链开关
 *
 * 用户：
 *
 * > 在 AI 响应里面做一个开关，打开显示完整思考链，关闭就只显示思考回复中
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** 剥注释（解释文字里会引用被禁/被要求的写法） */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
}

const mainSrc = stripComments(read('client/src/mobile/main.ts'));
const focusSrc = stripComments(read('client/src/chat/focus-scroll.ts'));
const panelSrc = stripComments(read('client/src/chat/chat-panel.ts'));
const shellSrc = stripComments(read('client/src/chat/shell.ts'));
const settingsSrc = stripComments(read('client/src/chat/chat-settings.ts'));

/* ═══════════════════════════════════════════════════════════
   一、键盘避让
   ═══════════════════════════════════════════════════════════ */

test('★★★ focus-scroll 必须挂到 document（window 上没有 activeElement）', () => {
  /*
   * 这条缺陷极隐蔽：`attachFocusScroll(globalThis, …)` 语法完全合法、
   * TypeScript 也放行（`activeElement?: unknown` 是可选成员），
   * 单测又只测纯函数 `focusScrollTop()` —— 于是**永远不滚，全绿**。
   */
  assert.match(
    mainSrc,
    /attachFocusScroll\(\s*globalThis\.document/,
    'installFocusScroll 必须传 document —— window.activeElement 是 undefined',
  );
  assert.doesNotMatch(
    mainSrc,
    /attachFocusScroll\(\s*globalThis\s*[,)]/,
    '不许再传 globalThis（window）',
  );
});

test('★★★ attachFocusScroll 自己也要兜住"传了 window"的情况', () => {
  /*
   * 光改调用点不够：下次有人在新入口再挂一次，照抄 `globalThis` 又坏。
   * 所以在函数内部把 `host.document ?? host` 解出来。
   */
  assert.match(
    focusSrc,
    /const doc\s*=\s*[\s\S]{0,200}?\.document/,
    'attachFocusScroll 要自己解析出 document',
  );
  assert.match(
    focusSrc,
    /revealFocusedInput\(doc,/,
    'revealFocusedInput 要拿解析后的 doc，不是原始 host',
  );
});

test('★★ 滚动容器白名单必须含实际用到的那几个', () => {
  /*
   * `SCROLLER_SELECTORS` 只有 `.nb-scroll` / `.nb-msglist`。
   * 「我的」页与「卡片」页的表单都在 `.nb-scroll` 里，够用；
   * 但若哪天把表单搬进别的容器，白名单不改就静默不滚。
   *
   * 这里钉"至少含 .nb-scroll"，并把这条风险写成注释。
   */
  assert.match(focusSrc, /SCROLLER_SELECTORS\s*=\s*\[[\s\S]*?\.nb-scroll/, '.nb-scroll 必须在白名单里');
});

/* ═══════════════════════════════════════════════════════════
   二、切换仓库保留各 origin 的登录态
   ═══════════════════════════════════════════════════════════ */

test('★★★ 切换仓库类型 = 登出（不许两套登录态并存）', () => {
  /*
   * ## ★★★ 这条判据在 2026-11-05 晚上**被反向了**
   *
   * 上午写的版本是「切回去要能恢复登录」—— 实现方式是"把当前登录态存进
   * 旧 origin 那一格，再从新 origin 读"。当时的样子：
   *
   * ```text
   *   内置云仓库（已登录 Gez）→ 切自定义仓库
   *     ⇒ 存 Gez 到「云仓库」格，从「自定义」格读
   *   切回内置云仓库
   *     ⇒ Gez 还在 ✅ 不用重登
   * ```
   *
   * 那看起来是个改进，实际埋了两个雷，用户当天就撞上了：
   *
   * > 在登录任意一个仓库类型的服务端时，互相切换仓库类型会卡很久，
   * > 而且还有一个很危险的问题就是自定义和云仓库可以同时登录
   *
   * ```text
   *   ① 两套 token 同时有效 = 两个账号同时在线（安全）
   *   ② 切过去拿错令牌 → 「缺少或无效的访问令牌」（正确性）
   * ```
   *
   * 所以现在**反过来**：切换即登出，同一时间只允许一处登录。
   * 代价是切回来要重登 —— 那是用户明确愿意付的代价。
   *
   * ★ 谁想再改回"切回去自动恢复"，先解决"两个账号同时在线"这件事。
   */
  const shell = shellSrc;
  const start = shell.indexOf('private async saveRepoConfig');
  assert.ok(start > 0, '找不到 saveRepoConfig');
  const block = shell.slice(start, start + 4200);

  /* 切换时要清掉旧登录态 */
  assert.match(block, /await clearRepoAuth\(/, '切换服务端要清掉旧登录态');

  /* 不许再"存进旧 origin" */
  assert.doesNotMatch(
    block,
    /writeRepoAuth\([\s\S]{0,40}?beforeOrigin/,
    '不许把旧登录态存进旧 origin 槽（那就是两套并存）',
  );

  /* 用户要知道自己被动登出了 —— 莫名掉登录会被当成 bug */
  assert.match(block, /onNotify\?\.\(/, '切换导致登出要提示');

  /* 切完之后从存储读新 origin（此时应该是空的） */
  assert.match(block, /this\.repoAuth\s*=\s*readRepoAuthFor\(/, '切完从存储读新 origin');
});

test('★★★ 登录态写入必须互斥（写一处就清掉其它）', () => {
  /*
   * 表结构仍是 origin → 登录态（这样 `readRepoAuthFor` 不用改），
   * 但**写入时清掉其它 origin** —— 于是表里永远最多一条。
   *
   * 两处入口都得守同一条纪律：
   *
   * ```text
   *   ① 登录进来   writeRepoAuth 里清掉别的
   *   ② 切换离开   saveRepoConfig 里 clearRepoAuth
   * ```
   *
   * 只做一处的话，另一条路照样能造出两套并存。
   */
  const store = stripComments(read('client/src/chat/repo-store.ts'));
  assert.match(store, /LS_AUTH_BY_ORIGIN/, '要有 origin → 登录态的表');
  assert.match(store, /map\[origin\] = state/, '写的时候按 origin 分 key');
  assert.match(
    store,
    /for \(const key of Object\.keys\(map\)\)[\s\S]{0,80}?delete map\[key\]/,
    '写入时要清掉其它 origin（否则两个账号同时在线）',
  );
});

test('★★ 退出登录仍要清干净（分槽不等于清不掉）', () => {
  /*
   * "按 origin 分槽"之后有个风险：退出登录时只清当前那格，
   * 别的 origin 的 token 还留着。这里确认"不带 origin = 清全部"
   * 的语义还在，且退出登录走的是那条。
   */
  const store = stripComments(read('client/src/chat/repo-store.ts'));
  assert.match(
    store,
    /if \(origin === undefined \|\| origin === ''\)/,
    '不带 origin 时要清全部',
  );
  assert.match(store, /removeItem\(LS_AUTH_BY_ORIGIN\)/, '要能删掉整张表');
});

/* ═══════════════════════════════════════════════════════════
   三、思考链开关
   ═══════════════════════════════════════════════════════════ */

test('★★★ 开关在「AI 响应配置」页里', () => {
  assert.match(settingsSrc, /data-role', 'reasoning-toggle'/, '要有开关控件');
  assert.match(settingsSrc, /'显示完整思考链'/, '标签要说清是什么');
  /*
   * 它在 `callbacks.reasoning` 上，**不是** `SAMPLING_SECTION.fields` 里 ——
   * 那一节是 ST 设置的映射表，有判据守着"每个字段必须有映射"。
   */
  assert.match(settingsSrc, /callbacks\.reasoning/, '走 reasoning 回调');
});

test('★★★ 两种模式：开=完整，关=只显示"思考中…"', () => {
  const at = panelSrc.indexOf('state.text === \'\' && state.reasoning !== \'\'');
  assert.ok(at > 0, '找不到思考链渲染分支');
  const block = panelSrc.slice(at, at + 1800);

  assert.match(block, /if \(this\.showReasoning\)/, '要按开关分两种模式');
  /* 开：带完整内容 */
  assert.match(block, /思考中…\\n\$\{state\.reasoning\}/, '打开时要拼完整思考链');
  /* 关：只有占位，不拼 reasoning */
  assert.match(block, /think\.textContent = '思考中…';/, '关闭时只显示"思考中…"');
  /*
   * ★ 关键：关闭分支里**不许**出现 `state.reasoning` ——
   * 漏一个字就等于"没关"，而用户要求的正是"关闭就只显示思考回复中"。
   */
  const offBranch = block.slice(
    block.indexOf("think.textContent = '思考中…';") - 200,
    block.indexOf("think.textContent = '思考中…';") + 200,
  );
  assert.doesNotMatch(offBranch, /reasoning\.slice/, '关闭时不许再截尾部若干字');
});

test('★★ 完整模式下要能滚能选（限高 120px + hidden 等于截断）', () => {
  const css = stripComments(read('client/src/chat/chat.css'));
  const at = css.indexOf(".nb-thinking[data-full='true']");
  assert.ok(at > 0, '缺少完整模式的样式');
  const block = css.slice(at, css.indexOf('}', at));

  assert.match(block, /overflow-y:\s*auto/, '要能滚');
  assert.match(block, /max-height:\s*320px/, '要给一个比 120 大的限高');
  assert.match(block, /user-select:\s*text/, '要能选中复制');
});

test('★★★ 开关值存在外壳，新建面板时注入', () => {
  /*
   * 面板每次 `renderChat()` 都是新对象。值只存在面板里的话，
   * 用户翻完开关切一次 Tab，行为又回到默认（关）。
   */
  assert.match(shellSrc, /private showReasoning = false;/, '外壳要持有当前值');
  assert.match(shellSrc, /panel\.setShowReasoning\(this\.showReasoning\)/, '新建面板要注入');
  assert.match(shellSrc, /this\.chatPanel\?\.setShowReasoning\(next\)/, '翻开关要立刻推给已存在的面板');
});

test('★★ 开关要持久化（杀进程重进还在）', () => {
  assert.match(mainSrc, /LS_SHOW_REASONING/, '要有存储键');
  assert.match(mainSrc, /readShowReasoning: readShowReasoning/, '要接到外壳');
  assert.match(mainSrc, /onPersistShowReasoning: writeShowReasoning/, '要能写回');
  /* 默认关：没存过时读出来是 false */
  assert.match(
    mainSrc,
    /getItem\(LS_SHOW_REASONING\) === '1'/,
    '没存过时应当为 false（默认关）',
  );
});
