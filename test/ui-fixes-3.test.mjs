/**
 * 三处界面修正的判据（2026-11-04，第三十二批）。
 *
 * ## 用户提的三件事
 *
 * 1. CFG 那里说明改成「暂不支持」，后面一大段删掉；展开层级不要左侧竖条
 * 2. 聊天设置里的「用户设置」和卡片里的「用户设定管理」是否重复
 * 3. 红米手机上系统手势条遮挡底部 Tab 栏，iQOO 上正常，要自适应
 *
 * ## 三条的共同点：都不是"写错代码"，而是"写对了但不合适"
 *
 * ```text
 *   ① 说明写了原因      → 对开发者有用，对用户是噪音
 *   ② 两个入口指同一件事 → 各自都能用，放一起就重复
 *   ③ 只信任 env()      → 符合标准，但这个 WebView 里它恒为 0
 * ```
 *
 * 所以判据守的不是"有没有实现"，而是"会不会退回去"。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

/**
 * 剥掉 CSS / JS 注释。
 *
 * ## 为什么每条判据都要先剥
 *
 * 这些判据的解释文字里**必然**会引用被禁的东西 ——
 * 比如"原来这里写了 border-left"、"不能用 box-sizing: border-box"。
 * 不剥的话判据会被自己的说明命中，变成恒红。
 *
 * 这个坑在这个项目里已经踩过四五次（§91 / §93 / §102）。所以这次
 * 直接做成工具函数，一处定义、处处用 —— 而不是每处手写一遍 replace。
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*$/gm, '')
    .replace(/\s\/\/[^\n]*$/gm, '');
}

/* ═══════════════════════════════════════════════════════════
   一、不支持的功能只说「暂不支持」
   ═══════════════════════════════════════════════════════════ */

test('★★★ 不支持项的文案只许是「暂不支持」，不写原因', () => {
  /*
   * 用户原话：
   *
   * > 加一个提示为暂不支持就行（不要再加为什么不支持了，
   * > 这个是开发阶段的文字，我要的是用户该看到的东西）
   *
   * "因为 CFG 要把上下文发两次、成本翻倍"——那是**给自己看的判断依据**。
   * 用户看到只会想"那到底能不能用"。
   */
  const { SAMPLING_SECTION } = JSON.parse('{}') ?? {};
  void SAMPLING_SECTION;

  const src = read('shared/src/chat/settings-schema.ts');
  const hits = [...src.matchAll(/unsupported:\s*'([^']*)'/g)].map((m) => m[1]);

  assert.ok(hits.length > 0, '应该有 unsupported 文案');
  for (const text of hits) {
    assert.equal(text, '暂不支持', `不支持项的文案必须只有「暂不支持」，实际：「${text}」`);
  }
});

test('★★★ 菜单里的空状态页也只说「暂不支持」', () => {
  const shell = read('client/src/chat/shell.ts');
  /*
   * ★ 2026-11-04：世界书已经不是空状态了（变成真页面），
   * 只剩「用户 UI 设置」这一项。判据跟着收窄 —— 但要求没放松。
   */
  const start = shell.indexOf("if (groupId === 'ui')");
  assert.ok(start > 0, '找不到 ui 的空状态分支');
  const block = shell.slice(start, start + 700);

  assert.match(block, /text: '暂不支持'/, '空状态正文必须是「暂不支持」');
  /* 不许出现"因为/原因/所以"这类解释 */
  assert.doesNotMatch(block, /text: '[^']*(因为|所以|原因)[^']*'/, '不要写原因');
});

test('★★★ 世界书已经是真页面（不再走空状态）', () => {
  /*
   * 用户 2026-11-04 要求「开始动工聊天里面的世界书管理」。
   * 它现在是三层真页面（列表 / 条目 / 展开编辑）+ 全局设置。
   *
   * 这条判据守的是"别把它退回空状态" —— 那种回退很容易发生：
   * 重构菜单时顺手把两个 groupId 又合并回同一个分支。
   */
  const shell = read('client/src/chat/shell.ts');
  assert.match(
    shell,
    /if \(groupId === 'worldbook'\) \{\s*this\.renderWorldbookPage\(\);/,
    'worldbook 要渲染真页面',
  );
  assert.doesNotMatch(
    shell,
    /groupId === 'worldbook' \|\| groupId === 'ui'/,
    '两个 groupId 不许再合并成同一个空状态分支',
  );
});

test('★★★ 「暂不支持」的说明不许带左侧竖条（像折叠面板的层级线）', () => {
  /*
   * 用户看到的是一条竖线，会以为"这一条还能再展开"。
   * 实际上它只是一句说明 —— 装饰传达了错误的可交互暗示。
   */
  const css = stripComments(read('client/src/chat/chat.css'));
  const start = css.indexOf('.nb-field-hint--unsupported');
  assert.ok(start > 0, '找不到样式');
  const block = css.slice(start, css.indexOf('}', start));

  assert.doesNotMatch(block, /border-left/, '不支持的提示不许带左侧竖条');
});

/* ═══════════════════════════════════════════════════════════
   二、用户设定只有一个入口
   ═══════════════════════════════════════════════════════════ */

test('★★★ 聊天设置里不再有指向 persona 的入口', async () => {
  /*
   * 用户问："聊天设置里面的用户设置和卡片里面的用户设定管理是否重复了？"
   *
   * 答：重复了。而且 ST 的 `user-settings-button` 本来指**界面外观**
   * （配色、示例消息行为、power user），persona 在 ST 里是**独立的一级入口**
   * `persona-management-button`。
   *
   * 所以按用户要求：保留这一项但改名「用户 UI 设置」（回到它本来的语义），
   * 内容标「暂不支持」；persona 只留在「卡片」Tab。
   */
  const { CHAT_SETTINGS_GROUPS } = await import('../shared/dist/chat/settings-schema.js');

  const ids = CHAT_SETTINGS_GROUPS.map((one) => one.id);
  assert.ok(!ids.includes('persona'), '聊天设置里不该再有 persona 入口');

  const ui = CHAT_SETTINGS_GROUPS.find((one) => one.id === 'ui');
  assert.ok(ui !== undefined, '应该有 ui 分组（用户要求保留为后续功能）');
  assert.equal(ui.label, '用户 UI 设置', '分组名必须是「用户 UI 设置」');
});

test('★★★ persona 的真实入口在「卡片」Tab', () => {
  const shell = read('client/src/chat/shell.ts');
  assert.match(shell, /entryRole: 'persona-entry'/, '卡片 Tab 要有用户设定入口');
  assert.match(shell, /this\.renderPersonaPage\(\)/, '要能打开真的管理页');
});

/* ═══════════════════════════════════════════════════════════
   三、底部安全区（红米手势条遮挡）
   ═══════════════════════════════════════════════════════════ */

test('★★★ Tab 栏的底部安全区必须带兜底值', () => {
  /*
   * ## 真因
   *
   * 原来只写 `padding-bottom: env(safe-area-inset-bottom, 0px)`，
   * 而这个 WebView 里 `env(safe-area-inset-*)` **恒为 0**
   * （顶部那条注释早就记过这件事，底部漏了）。
   *
   * 于是 Tab 栏 padding-bottom = 0，透明的系统手势条直接压在上面。
   *
   * 为什么 iQOO 上没露：那台可能三键导航（不透明、内容不延伸过去），
   * 或者对透明手势条处理不同。**这不是"某台机器坏了"，而是依赖系统行为的脆弱写法。**
   */
  const css = stripComments(read('client/src/chat/chat.css'));
  const start = css.indexOf('.nb-tabbar {');
  assert.ok(start > 0, '找不到 .nb-tabbar');
  const block = css.slice(start, css.indexOf('\n}', start));

  assert.match(block, /--nb-safe-bottom/, '要优先用 Android 注入的真实值');

  /*
   * ★ 判据从 `max(...)` 改成 `var(..., 兜底)`（2026-11-04 本机实测后）。
   *
   * 第一版写 `max(var(--nb-safe-bottom, …), 20px)`，实测发现：
   *
   * ```text
   *   注入成功 = 16px（真实手势条高度）
   *   max(16px, 20px) = 20px   ← 兜底压过了真值
   * ```
   *
   * 多 4px 无害，但逻辑错了：兜底的意义是"拿不到时才用"。
   * `var(--nb-safe-bottom, <兜底>)` 才能"有真值用真值、没真值用兜底"。
   *
   * 仍然要求有像素兜底 —— 只是位置从"外层 max"变成"var 的 fallback"。
   */
  assert.match(block, /var\(--nb-safe-bottom/, '要用 var() 取注入值');
  assert.match(block, /\b\d+px\)/, '必须有一个像素兜底值（拿不到注入值时用）');
  assert.doesNotMatch(
    block,
    /max\(\s*var\(--nb-safe-bottom/,
    'max() 会让兜底压过较小的真值 —— 真值 16px 时会变成 20px',
  );
});

test('★★★ Tab 栏不许用 border-box 压扁图标', () => {
  /*
   * ## 这是我自己第一版写错、自己算出来的
   *
   * ```text
   *   box-sizing: border-box
   *   min-height: 56px
   *   padding-bottom: 20px
   *     ⇒ 内容区只剩 36px ⇒ 图标 + 文字被压扁
   * ```
   *
   * 正确做法是保持 content-box：内容区 56px + padding 20px = 总高 76px。
   */
  const css = stripComments(read('client/src/chat/chat.css'));
  const start = css.indexOf('.nb-tabbar {');
  const block = css.slice(start, css.indexOf('\n}', start));

  assert.doesNotMatch(
    block,
    /box-sizing:\s*border-box/,
    'border-box 会让 padding 吃掉内容区高度 —— 图标被压扁',
  );
});

test('★★★ Android 侧要注入 --nb-safe-bottom', () => {
  /*
   * CSS 那边加了 `var(--nb-safe-bottom, ...)`，但**变量得有地方写**。
   * 光改 CSS 不改 Android 的话，真值永远是空，只能吃 20px 兜底 ——
   * 三键导航（48dp）的机器上仍然会被遮 28dp。
   */
  const kt = read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/MainActivity.kt',
  );

  assert.match(kt, /--nb-safe-bottom/, '要注入这个变量');
  assert.match(kt, /Type\.navigationBars\(\)/, '要读真实的导航栏 inset（不是写死高度）');
});

test('★★ 横屏时导航栏在侧面 ⇒ 允许 bottom 为 0', () => {
  /*
   * 横屏下三键导航在屏幕右侧，`navigationBars().bottom` 就是 0。
   * 这是**正确值**，不该被当成"读失败"再兜一个 48dp 出来 ——
   * 那样横屏会多一条空白。
   *
   * 所以注入的是 `navDp`（可能为 0），CSS 的兜底 20px 负责"完全拿不到"的情况。
   * 这条判据提醒：别为了"更安全"把 0 当失败。
   */
  const kt = read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/MainActivity.kt',
  );
  assert.match(kt, /navigationBars\(\)\)\.bottom/, '直接取 bottom（0 是合法值）');
});

test('★★★ 安全区注入必须在页面加载之后重试（一次写不进去）', () => {
  /*
   * ## 这个缺陷的样子（2026-11-04 真机 CDP 实测）
   *
   * ```text
   *   getPropertyValue('--nb-safe-top')    → ""   ← 空！
   *   getPropertyValue('--nb-safe-bottom') → ""   ← 空！
   * ```
   *
   * 也就是说 Android 侧的注入**从来没成功过**。而顶部之所以看着正常，
   * 是因为 CSS 写了 `max(..., 24px)` 兜底 —— **兜底掩盖了坏掉的机制**。
   *
   * ## 真因
   *
   * 原来只有 `webView.post { injectSafeArea(...) }`，那是在
   * `onWebViewCreate` 里、页面**还是空白**的时候。两层问题：
   *
   * ```text
   *   ① 当次执行：document.documentElement 可能是 null ⇒ 脚本静默失败
   *   ② 即使成功：页面一导航就换新 document，
   *      documentElement.style 上写的东西全丢
   * ```
   *
   * 所以必须**在页面加载之后重试**。这条判据守的就是"有重试"。
   */
  const kt = read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/MainActivity.kt',
  );

  assert.match(kt, /scheduleSafeAreaInjection/, '要有多时机注入的入口');
  /* 至少三次延迟 —— 一次不够（页面加载是异步的） */
  const delays = kt.match(/postDelayed\(\{[^}]*injectSafeArea[^}]*\}, (\d+)L\)/g);
  const loop = /for \(delay in longArrayOf\([^)]+\)\)/.test(kt);
  assert.ok(
    loop || (delays !== null && delays.length >= 3),
    '注入必须按多个时间点重试（单次注入在页面导航后会丢）',
  );
});

test('★★★ 注入失败时不许写 -1 这种脏值', () => {
  /*
   * 缓存用 -1 表示"还不知道"。直接把它写进 CSS 会变成 `--nb-safe-top: -1px`，
   * 负 padding 在 CSS 里是**非法值**，整条声明静默失效 —— 又是那种
   * "界面看着不对但没有任何报错"的故障。
   *
   * 所以不知道时**不写**，让 CSS 的兜底值生效。
   */
  const kt = read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/MainActivity.kt',
  );

  assert.match(kt, /if \(safeTopDp >= 0\)/, '只在拿到真值时才写 top');
  assert.match(kt, /if \(safeBottomDp >= 0\)/, '只在拿到真值时才写 bottom');
});
