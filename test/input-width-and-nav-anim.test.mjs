/**
 * 三条（2026-11-05 第二批）。
 *
 * ## 一、文本输入框横向没占满
 *
 * 用户：
 *
 * > 开场白、用户设定、世界书里面的文本输入框横向没有占满屏幕看起来很怪
 * > （这个注意不同手机的屏幕尺寸兼容）
 *
 * ## 二、AI 响应配置页没有键盘避让
 *
 * 用户：
 *
 * > AI 响应配置里面还是没有键盘避让
 *
 * ## 三、返回上一级的动画
 *
 * 用户：
 *
 * > 做返回上一级的动画（不管是手势触发的还是点左上角触发的返回都用同一套动画）
 *
 * ## 这三条的共同点
 *
 * 三个都是"**结构上就不成立**"，而不是"参数没调好"：
 *
 * ```text
 *   输入框    textarea 的宽度来自 cols=20，不像 block 那样铺满父宽
 *             `.nb-input` 的 `flex: 1` 在 display:block 的父容器里无效
 *   键盘避让  滚动容器白名单漏了 `.nb-list`（聊天设置各级页面用它滚动）
 *   返回动画  动画必须挂在"重绘"这个唯一出口，否则手势那条路径没有
 * ```
 *
 * 所以判据全部钉"结构"，不钉像素、不钉某台机器的实测值。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/*
 * 方向规则是**跑真函数**验的，不是抠正则。
 *
 * `turnDirection` 放在 `shared/src/chat/nav.ts` 就是为了这个 ——
 * 和 `parentRouteOf()` 同一个理由：纯逻辑能在 Node 里直接跑，
 * 而"读源码找 `? 'push' : 'back'`"只能答"代码里有没有这句话"。
 *
 * `npm test` 会先 `build:shared`，所以这里 import 的是刚编译的 dist。
 */
import { turnDirection } from '../shared/dist/chat/nav.js';

/** Tab 从左到右的顺序（与 `shell.ts` 的 `TABS` 一致，判据里有守卫核对） */
const TAB_ORDER = ['chat', 'cards', 'repo', 'me'];

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** 剥注释（解释文字里会引用被要求的写法，不剥就是自己骗自己） */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
}

const css = stripComments(read('client/src/chat/chat.css'));
const focusSrc = stripComments(read('client/src/chat/focus-scroll.ts'));
const shellSrc = stripComments(read('client/src/chat/shell.ts'));
/** 方向规则的**实现**（纯函数，已挪出 shell 以便真跑） */
const navSrc = stripComments(read('shared/src/chat/nav.ts'));

/** 取某个类选择器那一块声明（到第一个 `}` 为止） */
function blockOf(source, selector) {
  const at = source.indexOf(`${selector} {`);
  assert.ok(at > 0, `找不到 ${selector}`);
  return source.slice(at, source.indexOf('}', at) + 1);
}

/**
 * 取某个选择器的**全部**规则块（拼在一起）。
 *
 * 同一个选择器可以出现在多处：比如 `.nb-page-layer[data-nav-pending]`
 * 既在 `will-change` 那一组里、又有一条单独的 `opacity: 0`。
 * `blockOf` 只取第一处，断言就会看错块。
 */
function blocksOf(source, selector) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(`${selector} {`, from);
    if (at < 0) break;
    out.push(source.slice(at, source.indexOf('}', at) + 1));
    from = at + 1;
  }
  assert.ok(out.length > 0, `找不到 ${selector}`);
  return out.join('\n');
}

/* ═══════════════════════════════════════════════════════════
   一、输入框占满宽度
   ═══════════════════════════════════════════════════════════ */

test('★★★ .nb-input 必须显式 width: 100%（textarea 不会自动铺满）', () => {
  /*
   * `<textarea>` 与 `<input>` 是 **replaced-ish 的表单控件**：
   * 宽度来自 `cols` / `size` 属性，默认 `cols=20`，**不是**父容器宽度。
   *
   * 真机实测（393dp／dpr 2.75）：
   *
   * ```text
   *   .nb-field-body   width=361   display=block
   *   textarea         width=212   cssWidth=185.818px   ← 父宽的 59%
   * ```
   *
   * 为什么原来只写 `flex: 1` 不行：`flex` 属性只在父容器是 flex 时有效，
   * 而 `.nb-field-body` 是 `display: block`。
   */
  const block = blockOf(css, '.nb-input');
  assert.match(block, /width:\s*100%/, '.nb-input 要 width: 100%');
});

test('★★★ width 必须和 box-sizing: border-box 成对出现', () => {
  /*
   * 只给宽度的后果：`padding` 加在 100% **之外** ⇒ 右侧溢出屏幕。
   * 草稿卡（`.nb-pop`）上踩过一次完全一样的坑。
   */
  const block = blockOf(css, '.nb-input');
  assert.match(block, /box-sizing:\s*border-box/, '要有 border-box，否则 padding 撑破 100%');
});

test('★★★ 不许写死像素宽度（用户要求"不同手机屏幕尺寸兼容"）', () => {
  /*
   * 判据的意图：如果哪天为了"看起来刚好"把宽度调成 `width: 320px`，
   * 在 360dp 的机器上还行，到 412dp 的机器上又没占满 —— 这正是用户
   * 让我们注意的兼容性问题。
   *
   * 只允许百分数 / `auto` / `var(--…)`。
   */
  const block = blockOf(css, '.nb-input');
  const widths = [...block.matchAll(/\bwidth:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(widths.length > 0, '至少要有 width 声明');
  for (const value of widths) {
    assert.doesNotMatch(
      value,
      /^\d+(\.\d+)?px$/,
      `不许写死像素宽度：width: ${value}（换屏宽就会再次没占满）`,
    );
  }
});

test('★★ 多行框复用 .nb-input 的那条宽度（不许在 .nb-textarea 再写一遍）', () => {
  /*
   * `greeting-page.ts` / `worldbook-page.ts` 造的是
   * `class="nb-input nb-textarea"` —— 宽度由 `.nb-input` 提供。
   *
   * 这里钉两件事：
   *   ① 那两个页面确实同时带了 `nb-input` 类（否则宽度规则打不到它）
   *   ② `.nb-textarea` 里**没有**第二份 width 声明（同一条声明写两处必分叉）
   */
  const greeting = read('client/src/chat/greeting-page.ts');
  const worldbook = read('client/src/chat/worldbook-page.ts');
  assert.match(greeting, /'textarea', 'nb-input nb-textarea'/, '开场白的多行框要带 nb-input');
  assert.match(worldbook, /'textarea', 'nb-input nb-textarea'/, '世界书的多行框要带 nb-input');

  const block = blockOf(css, '.nb-textarea');
  assert.doesNotMatch(block, /\bwidth:/, '.nb-textarea 不许再写一遍 width（会与 .nb-input 分叉）');
});

/* ═══════════════════════════════════════════════════════════
   二、键盘避让：滚动容器白名单
   ═══════════════════════════════════════════════════════════ */

test('★★★ 滚动容器白名单必须含 .nb-list（聊天设置各级页面用它滚动）', () => {
  /*
   * 用户第二次提键盘避让，这一条就是真因。
   *
   * `chat-settings.ts` 的 DOM：
   *
   * ```text
   *   div.nb-page.nb-chat-settings
   *     div.nb-list                 ← 滚动在这里
   *       div[data-role=settings-form]
   *         textarea.nb-input.nb-input--multiline
   * ```
   *
   * 而白名单原来只有 `.nb-scroll` / `.nb-msglist` ⇒ 往上找不到容器 ⇒
   * `revealFocusedInput` 第一段就 `return false` ⇒ **一次都不滚**。
   */
  assert.match(
    focusSrc,
    /SCROLLER_SELECTORS\s*=\s*\[[\s\S]{0,200}?\.nb-list/,
    '.nb-list 必须在白名单里',
  );
  assert.match(
    focusSrc,
    /SCROLLER_SELECTORS\s*=\s*\[[\s\S]{0,200}?\.nb-sheet/,
    '.nb-sheet（气泡编辑弹层）也要在，里面有 textarea',
  );
});

test('★★★ 白名单里加的必须真的是滚动容器（不是拍脑袋加的类名）', () => {
  /*
   * 反向校验：加了白名单但那个类根本没有 `overflow-y: auto`，
   * 等于什么也没加 —— 而且下次有人按白名单去查会以为已经修好了。
   */
  const list = blockOf(css, '.nb-list');
  assert.match(list, /overflow-y:\s*auto/, '.nb-list 必须是滚动容器');

  const sheet = blockOf(css, '.nb-sheet');
  assert.match(sheet, /overflow-y:\s*auto/, '.nb-sheet 必须是滚动容器');
});

test('★★ 聊天设置页的正文容器就是 .nb-list（页面结构别偷偷换）', () => {
  /*
   * 这条守的是"上面那条判据的前提"。哪天有人把 `nb-list` 换成
   * `nb-scroll`，白名单虽然还留着 `.nb-list`，但页面已经不用它了 ——
   * 那时应该顺手把白名单里多余的那项删掉，而不是让它假装有用。
   */
  const settings = read('client/src/chat/chat-settings.ts');
  const hits = [...settings.matchAll(/el\(doc, 'div', 'nb-list'\)/g)];
  assert.ok(hits.length >= 2, `菜单页与分组页都该用 nb-list，实际 ${String(hits.length)} 处`);
});

/* ═══════════════════════════════════════════════════════════
   二之二、白名单的**覆盖面**（这是这次真因的防线）
   ═══════════════════════════════════════════════════════════ */

/** CSS 里所有声明了 `overflow-y: auto|scroll` 的顶层类名 */
function scrollableClasses(source) {
  const found = new Set();
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = ruleRe.exec(source)) !== null) {
    const selector = match[1];
    const body = match[2];
    if (!/overflow-y\s*:\s*(auto|scroll)/.test(body)) continue;
    for (const one of selector.split(',')) {
      const trimmed = one.trim();
      if (!trimmed.startsWith('.')) continue;
      /* `[data-full='true']` 这类后缀剥掉，只留类名本体 */
      found.add(trimmed.split(/[\s:>[]/)[0]);
    }
  }
  return [...found].sort();
}

test('★★★ 每一个能纵向滚动的容器都要有归属（白名单 或 明确的例外）', () => {
  /*
   * ## 这条判据解决的是"下次还会漏"
   *
   * 这次的真因很朴素：`chat-settings.ts` 用 `.nb-list` 当滚动容器，
   * 而 `SCROLLER_SELECTORS` 里只有 `.nb-scroll` / `.nb-msglist`。
   * 两边各自都"看着没问题"，凑一起就静默不滚。
   *
   * 加新页面时同样的事会再发生一次 —— 所以这里把"CSS 里所有滚动容器"
   * 与"focus-scroll 的白名单"强制对账：
   *
   * ```text
   *   一个类声明了 overflow-y: auto
   *     ⇒ 它里面可能放输入框 ⇒ 必须进白名单
   *     ⇒ 或者它确定不放输入框 ⇒ 进下面的 EXEMPT 并写明理由
   * ```
   *
   * 有新的滚动容器出现时这条会红，逼作者做一次判断
   * —— 这比"再漏一次、等用户报"便宜得多。
   */
  const whitelist = /SCROLLER_SELECTORS\s*=\s*\[([\s\S]*?)\]/.exec(focusSrc)?.[1] ?? '';
  const named = new Set([...whitelist.matchAll(/'(\.nb-[a-z-]+)'/g)].map((one) => one[1].slice(1)));

  /*
   * 例外表：确定**不会**在里面放 `input` / `textarea` 的滚动容器。
   *
   * 每一项都要写理由 —— 写不出来就说明它该进白名单。
   */
  const EXEMPT = new Map([
    ['.nb-model-list', '模型名列表，整行是按钮，没有输入框'],
    ['.nb-select-popover', '下拉候选面板，整行是按钮，没有输入框'],
    ['.nb-thinking', '思考链正文，纯文本展示（data-full 时允许滚动）'],
  ]);

  const all = scrollableClasses(css);
  assert.ok(all.length >= 5, `应当找到多个滚动容器，实际 ${String(all.length)} 个`);

  const orphans = all.filter((one) => !named.has(one.slice(1)) && !EXEMPT.has(one));
  assert.deepEqual(
    orphans,
    [],
    `这些类能纵向滚动，却既不在 SCROLLER_SELECTORS 里、也没有在 EXEMPT 里写明理由：\n` +
      `  ${orphans.join('\n  ')}\n` +
      '如果它里面会出现输入框 ⇒ 加进 focus-scroll.ts 的白名单；\n' +
      '如果确定不会有输入框 ⇒ 加进本判据的 EXEMPT 并写一句为什么。',
  );
});

test('★★ EXEMPT 里的每一条都真的不该放输入框（防止"随手加进去"）', () => {
  /*
   * 例外表一旦变成"漏了就往里塞"，判据就自动失效了。
   * 这里反向查一次：EXEMPT 里的类名不许在造输入框的地方出现。
   */
  const sources = [
    'client/src/chat/chat-settings.ts',
    'client/src/chat/persona-page.ts',
    'client/src/chat/worldbook-page.ts',
    'client/src/chat/greeting-page.ts',
    'client/src/chat/repo-page.ts',
    'client/src/chat/api-page.ts',
    'client/src/chat/voice-settings.ts',
    'client/src/chat/bubble-menu.ts',
    'client/src/chat/chat-actions-page.ts',
  ];

  for (const exempt of ['.nb-model-list', '.nb-select-popover', '.nb-thinking']) {
    const bare = exempt.slice(1);
    for (const rel of sources) {
      const source = stripComments(read(rel));
      /*
       * 只查"把输入控件放进这个容器"—— 即同一段里既造了 input/textarea
       * 又 append 到这个容器。粗糙但够用：这个容器名出现在造输入框的
       * 函数体里就值得人看一眼。
       */
      if (!source.includes(bare)) continue;
      assert.ok(
        !new RegExp(`append\\([^)]*${bare.replace('-', '\\-')}`).test(source),
        `${rel} 往 ${exempt} 里 append 了东西 —— 确认一下是不是输入框，是的话它不该在 EXEMPT 里`,
      );
    }
  }
});

/* ═══════════════════════════════════════════════════════════
   三、页面切换的层叠滑动转场（2026-11-05 第二版）

   ## 第一版做错了什么

   第一版做成"单层淡入 + 位移 24px"。用户拿了一段参考录屏过来说：

   > 我的意思是我想做这种的界面切换和返回动画

   参考里是 **QQ / iOS 那种层叠转场**：两层同时在屏上，新页从侧面滑入、
   旧页退到侧边并压暗。差别不是参数（24px vs 25%），是**结构**：

   ```text
   单层淡入   一层 DOM，先销毁再重建 ⇒ 永远只有一个页面存在
   层叠转场   两层 DOM 同时挂在外壳上 ⇒ 旧页必须活到动画结束
   ```

   所以判定必须钉"存在两层"，而不是"有个 transform"。
   ═══════════════════════════════════════════════════════════ */

test('★★★ 外壳里必须有独立的层容器（两层才能同时在屏上）', () => {
  /*
   * `pageRoot` 是固定外壳（安全区 + 裁切），`pageHost` 是当前那一层。
   * 两者分开，是所有层叠转场的前提 —— 也顺手让 20 个 render 方法
   * 一行都不用改（它们 append 到 `pageHost`，只是 pageHost 换了指向）。
   */
  assert.match(shellSrc, /private pageRoot: ElLike \| null = null;/, '要有外壳字段');
  assert.match(
    shellSrc,
    /const firstLayer = el\(this\.doc, 'div', 'nb-page-layer'\);/,
    'mount 时要先建一个空层',
  );
  assert.match(shellSrc, /this\.pageHost = firstLayer;/, '首层要成为当前页容器');
});

test('★★★ 每次重绘新建一层，不再 replaceChildren 清空外壳', () => {
  /*
   * 原来 `renderPage()` 第一句就是 `pageHost.replaceChildren()` ——
   * 旧页当场销毁，"两层同时存在"根本不可能。
   *
   * 现在必须：新建层 → 全部 render 之后 → 由 `finishPageTurn()` 摘掉旧的。
   */
  const at = shellSrc.indexOf('private renderPage(): void {');
  assert.ok(at > 0, '找不到 renderPage');
  const block = shellSrc.slice(at, shellSrc.indexOf('private finishPageTurn', at));

  assert.match(block, /el\(this\.doc, 'div', 'nb-page-layer'\)/, '要新建一层');
  assert.match(block, /this\.renderActivePage\(\);/, '渲染逻辑要搬进独立方法（那里面的 return 只退出自己）');
  assert.match(block, /this\.finishPageTurn\(/, '末尾要统一收尾');
  assert.doesNotMatch(
    block,
    /this\.pageRoot\.replaceChildren\(\)/,
    '外壳不许被清空（清掉旧页就没有层叠了）',
  );
});

test('★★★ 方向由页面身份推导，不是各处打标记', () => {
  /*
   * "进入下一级"散落在十几处。让每处都记得打标记必然漏，而漏了不报错。
   *
   * 第一版用 `pageDepth(): number`（每个分支手写一个数）。两个问题：
   *
   * ```text
   *   ① 加新二级页忘了在那 +1 ⇒ 那一页没有动画，不报错
   *   ② Tab 之间深度一样，判不出方向（当时干脆抑制掉，用户后来要求补上）
   * ```
   *
   * 现在用**页面身份路径**：深度 = 路径的段数，不需要另维护一份。
   */
  assert.match(shellSrc, /private pageKey\(\): string \{/, '要有页面身份推导');
  assert.match(shellSrc, /const keyBefore = this\.lastPageKey;/, '要记下渲染前的身份');
  assert.match(shellSrc, /keep|this\.lastPageKey = key;/, '渲染后要更新身份');
  assert.match(shellSrc, /key === keyBefore/, '身份不变（同一页重绘）不许播转场');

  /* 不再保留一份独立的深度表 */
  assert.doesNotMatch(shellSrc, /private pageDepth\(\): number \{/, '不许再维护独立的深度表');
  assert.doesNotMatch(shellSrc, /private lastDepth = 0;/, '不许再有 lastDepth 字段');
});

test('★★★ 深度必须等于路径段数（加新页面时深度自动对）', () => {
  /*
   * 这是"不再维护第二份真值"的关键：深度不是手写的数字，是从 key **算**的。
   * 所以 `turnDirection()` 里必须 `split('/').length`，不许出现魔法数字表。
   */
  const at = navSrc.indexOf('export function turnDirection');
  assert.ok(at > 0, '找不到 turnDirection');
  const block = navSrc.slice(at, at + 1200);

  assert.match(block, /split\('\/'\)\.length/, '深度要从路径段数算');
  assert.match(block, /depthAfter > depthBefore \? 'push' : 'back'/, '段数变多=进、变少=退');
});

test('★★★ pageKey 必须覆盖每一个渲染分支（漏了只是没动画，不报错）', () => {
  /*
   * 这条守的是"推导"的完整性：`renderActivePage()` 里判过的每个二级页开关，
   * `pageKey()` 里都要有对应的一段。宁可粗糙，也比"加了新页面忘了写、
   * 然后没人发现"好。
   */
  const keyAt = shellSrc.indexOf('private pageKey(): string {');
  const keyEnd = shellSrc.indexOf('private renderActivePage', keyAt);
  assert.ok(keyAt > 0 && keyEnd > keyAt, '找不到 pageKey 的方法体');
  const keyBody = shellSrc.slice(keyAt, keyEnd);

  const renderAt = shellSrc.indexOf('private renderActivePage(): void {');
  const renderEnd = shellSrc.indexOf('goBackOneLevel(): boolean {', renderAt);
  const renderBody = shellSrc.slice(renderAt, renderEnd);

  const flags = new Set([
    ...[...renderBody.matchAll(/this\.([a-zA-Z]+Open)\b/g)].map((one) => one[1]),
    ...[...renderBody.matchAll(/this\.chatSettingsRoute\b/g)].map(() => 'chatSettingsRoute'),
  ]);

  assert.ok(flags.size >= 3, `应当识别出多个二级页开关，实际 ${String(flags.size)} 个`);

  const missing = [...flags].filter((one) => !keyBody.includes(one));
  assert.deepEqual(
    missing,
    [],
    `这些开关在 renderActivePage 里存在、但 pageKey 没算它们，进那一页会没有动画：${missing.join(', ')}`,
  );
});

test('★★★ 切 Tab 也要播转场（用户明确要求）', () => {
  /*
   * 用户：
   *
   * > 底部 tab 切换的时候也要做相同的动画
   *
   * 第一版刻意**抑制**了（怕"从我的切到聊天"被判成返回、方向反了）。
   * 现在方向由 `turnDirection()` 按 Tab 从左到右的顺序算，所以不该再抑制。
   */
  assert.doesNotMatch(shellSrc, /suppressTransition/, '不许再抑制 Tab 的转场');
  assert.match(shellSrc, /turnDirection\(/, '要调共享的方向函数');
  assert.match(navSrc, /to > from \? 'push' : 'back'/, '同级按 Tab 顺序定方向');
});

test('★★★ 同级切 Tab 的方向按左右顺序（往右点=内容往右翻）', () => {
  /*
   * Tab 顺序：聊天(0) 卡片(1) 仓库(2) 我的(3)。
   * 手指往右点一格，眼睛期待内容也往右翻 —— 与 Android ViewPager 一致。
   *
   * 这条**跑真实函数**，不是抠正则：`turnDirection()` 是导出的纯函数。
   */
  const cases = [
    ['chat', 'cards', 'push', '聊天→卡片：往右，新页从右入'],
    ['chat', 'me', 'push', '聊天→我的：跨三格往右，仍是 push'],
    ['me', 'chat', 'back', '我的→聊天：往左，新页从左回'],
    ['repo', 'cards', 'back', '仓库→卡片：往左'],
    ['chat', 'chat/settings', 'push', '进二级'],
    ['chat/settings', 'chat', 'back', '退二级'],
    ['cards/greeting', 'cards/greeting/edit', 'push', '角色列表→编辑页（关键的一条）'],
    ['cards/greeting/edit', 'cards/greeting', 'back', '编辑页→角色列表'],
    ['cards/greeting', 'cards/persona', 'push', '同一 Tab 里两个二级页互跳'],
    ['chat', 'chat', 'push', '同一页重绘（调用方会按 key 相同跳过，这里给个确定值）'],
  ];

  for (const [from, to, want, why] of cases) {
    assert.equal(turnDirection(from, to, TAB_ORDER), want, `${why}：${from} → ${to}`);
  }

  /*
   * ★ 顺手核一遍：判据里的 Tab 顺序必须与 `shell.ts` 的 `TABS` 一致。
   *
   * 不一致的话上面那十组断言就全在验一份假的顺序（而且照样绿）。
   */
  const tabsBlock = shellSrc.slice(
    shellSrc.indexOf('const TABS: readonly TabDef[] = ['),
    shellSrc.indexOf('];', shellSrc.indexOf('const TABS: readonly TabDef[] = [')) + 2,
  );
  const inShell = [...tabsBlock.matchAll(/id: '([a-z]+)'/g)].map((one) => one[1]);
  assert.deepEqual(inShell, TAB_ORDER, '判据里的 Tab 顺序要与 shell.ts 的 TABS 一致');
});

test('★★★ 角色编辑页必须走 renderPage（否则整页不换层，没有动画）', () => {
  /*
   * 用户报的第二条：
   *
   * > 你遗漏了卡片中的开场与示例中的角色界面，点击进入退出对应角色界面
   * > 的时候没有动画
   *
   * 真因：`openGreetingCard()` 里调的是 `renderGreeting()` ——
   * 它在**当前层里**清空重绘（`pageHost.replaceChildren()`），
   * 不新建层 ⇒ `finishPageTurn()` 没被调用 ⇒ 一层都没换 ⇒ 没有转场。
   */
  const at = shellSrc.indexOf('private async openGreetingCard');
  assert.ok(at > 0, '找不到 openGreetingCard');
  const block = shellSrc.slice(at, shellSrc.indexOf('private async saveGreeting', at));

  const renderPageCalls = [...block.matchAll(/this\.renderPage\(\)/g)].length;
  assert.ok(renderPageCalls >= 2, `进入与加载完成都要走 renderPage，实际 ${String(renderPageCalls)} 处`);
  assert.doesNotMatch(
    block,
    /this\.renderGreeting\(\)/,
    'openGreetingCard 里不许用 renderGreeting（那是同一页重绘，不换层）',
  );
});

test('★★★ 角色数量无关：pageKey 不枚举角色', () => {
  /*
   * 用户特别交代：
   *
   * > 注意如果后续角色多起来后应该如何实现，即不能写死现有的角色，
   * > 后续陆续加进来的也要有动画才行
   *
   * 所以 `pageKey()` 只区分**列表**与**编辑**两种形态，绝不能让
   * avatar / 名字 / 下标出现在 key 里 —— 一旦出现，就等于"只有已知的
   * 那几个角色有动画"，新加的角色走另一条路径。
   */
  const keyAt = shellSrc.indexOf('private pageKey(): string {');
  const keyEnd = shellSrc.indexOf('private renderActivePage', keyAt);
  const keyBody = shellSrc.slice(keyAt, keyEnd);

  for (const banned of ['avatar', 'selectedName', 'index', 'characters[']) {
    assert.ok(
      !keyBody.includes(banned),
      `pageKey 里出现了 ${banned} —— 那会把"哪个角色"写进页面身份，新角色就拿不到同一套动画`,
    );
  }
  /* 但它必须真的区分了"在编辑"这个状态 */
  assert.match(keyBody, /greetingState\.selected/, '要按"有没有选中"区分列表与编辑页');
  assert.match(keyBody, /'cards\/greeting\/edit'/, '编辑页要有自己的路径');
});


test('★★★ 旧层必须活到动画结束，且期间不可交互', () => {
  /*
   * 三个要点，缺一个就会出真缺陷：
   *
   * ```text
   *   立刻删     ⇒ 没有层叠（两层不共存），动画无意义
   *   不设 pointer-events ⇒ 用户在"正在消失的页面"上点到东西
   *   不设 aria-hidden    ⇒ 读屏把两层内容都念一遍
   * ```
   */
  const at = shellSrc.indexOf('private finishPageTurn');
  assert.ok(at > 0, '找不到 finishPageTurn');
  const block = shellSrc.slice(at, at + 3000);

  assert.match(block, /previous\.dataset\['leaving'\] = direction;/, '旧层要标记离开方向');
  assert.match(block, /previous\.setAttribute\('aria-hidden', 'true'\)/, '旧层要 aria-hidden');
  assert.match(block, /setProperty\('pointer-events', 'none'\)/, '旧层要断开点击');
  assert.match(block, /previous\.addEventListener\('animationend', drop\)/, '动画结束再删');
  assert.match(
    block,
    /globalThis\.setTimeout\(drop, budget\)/,
    '还要一个定时兜底（reduced-motion 下不一定补发 animationend）；时长由 animationBudgetMs 算',
  );
});

test('★★★ 动画结束必须摘掉 data-nav（否则 fixed 面板全错位）', () => {
  /*
   * `animation: ... both` 会把终态的 `transform: translateX(0)` 一直保留。
   * 而"元素上有 transform"会让它成为 `position: fixed` 后代的 containing block
   * —— `.nb-select-popover` / `.nb-pop`（下拉面板）正是 fixed 定位。
   *
   * 留着那个 transform，下拉框会改成相对本层定位、位置全错，
   * 而症状跟转场八竿子打不着，极难归因。
   */
  const at = shellSrc.indexOf('private finishPageTurn');
  const block = shellSrc.slice(at, at + 3000);

  assert.match(block, /next\.removeAttribute\('data-nav'\)/, '动画结束要摘掉 data-nav');
  assert.match(block, /next\.addEventListener\('animationend', settle\)/, '挂在新层上');
});

test('★★★★★ 时间轴必须错开（先出后进，不许同时交叉）', () => {
  /*
   * ## 这条是本次转场形态的**核心**
   *
   * 用户：
   *
   * > 上一个页面在出去的时候应该是逐帧的透明度下降**直到看不见**，
   * > 下一个页面进来的时候是逐帧的透明度上升**直到完全将上一个页面遮住**
   *
   * 关键词是"**直到…然后**"—— 先出、后进，不是同时。
   *
   * 第二版做成了同时交叉（旧页 1→0 与新页 0→1 全程并行），
   * 数学上完美（互补偏差 0.000），但中间态是**两页各 50% 混在一起**：
   * 真机上两个页面的标题、正文、列表项互相穿透，眼睛没法聚焦。
   *
   * 现在错开：
   *
   * ```text
   *   0 ───── 35% ───── 100%
   *     旧页淡出   新页淡入
   * ```
   *
   * 判据直接验这个结构：两条关键帧都必须有一个 **35% 附近的关键点**，
   * 且该点的值与起点相同（淡出的停在 0、淡入的停在 0）。
   */
  const inAt = css.indexOf('@keyframes nb-layer-fade-in');
  const inKf = css.slice(inAt, css.indexOf('\n}\n', inAt) + 3);
  const outAt = css.indexOf('@keyframes nb-layer-fade-out');
  const outKf = css.slice(outAt, css.indexOf('\n}\n', outAt) + 3);

  /* 淡入：0% 与 35% 都是 0，100% 是 1 */
  assert.match(inKf, /0%\s*\{\s*opacity:\s*0\s*;?\s*\}/, '淡入 0% 要为 0');
  assert.match(inKf, /35%\s*\{\s*opacity:\s*0\s*;?\s*\}/, '淡入到 35% 之前必须保持 0（等旧页退干净）');
  assert.match(inKf, /100%\s*\{\s*opacity:\s*1\s*;?\s*\}/, '淡入 100% 要到 1');

  /* 淡出：0% 是 1，35% 已经是 0，之后保持 0 */
  assert.match(outKf, /0%\s*\{\s*opacity:\s*1\s*;?\s*\}/, '淡出 0% 要为 1');
  assert.match(outKf, /35%\s*\{\s*opacity:\s*0\s*;?\s*\}/, '淡出到 35% 就要看不见');
  assert.match(outKf, /100%\s*\{\s*opacity:\s*0\s*;?\s*\}/, '淡出之后保持 0');

  /*
   * 反向判据：不许出现"旧页还在降、新页已经在升"的重叠设计。
   * 具体表现是淡入用 `from`/`to` 两帧写满全程（那就是第二版）。
   */
  assert.ok(
    !/from\s*\{[\s\S]{0,40}opacity:\s*0[\s\S]{0,40}\}\s*to\s*\{/.test(inKf),
    '淡入不许用 from→to 两帧写满全程（那会与旧页同时交叉 = 两页混在一起）',
  );

  /* 只许动 opacity —— 不许有位移/缩放 */
  for (const [name, kf] of [['nb-layer-fade-in', inKf], ['nb-layer-fade-out', outKf]]) {
    for (const banned of ['translateX', 'translateY', 'scale(', 'rotate(']) {
      assert.ok(!kf.includes(banned), `${name} 里不许有 ${banned}（现在是纯透明度淡化）`);
    }
  }

  /* 旧的四条滑动关键帧必须删干净 —— 留着会被误用 */
  for (const gone of ['nb-layer-push', 'nb-layer-back', 'nb-layer-recede', 'nb-layer-exit']) {
    assert.ok(!css.includes(`@keyframes ${gone}`), `旧关键帧 ${gone} 应已删除`);
  }
});

test('★★★ 层必须有不透明背景（否则"遮住"做不到）', () => {
  /*
   * 用户说的是"直到**完全将上一个页面遮住**"。而"遮住"需要一个
   * **不透明的底**：
   *
   * ```text
   *   原来  层没有 background ⇒ 两层内容画在 .nb-app 的同一个底上
   *                          ⇒ 半透明时是"字叠字"，不是"盖上"
   *   现在  background: var(--nb-void) ⇒ 新页不透明度一上来就真的盖住
   * ```
   *
   * 用 `--nb-void`（与 `.nb-app` 同一个底）而不是别的色：
   * 两层底色一致，交叉淡化中不会出现"颜色跳一下"。
   */
  const rule = blockOf(css, '.nb-page-layer');
  assert.match(rule, /background:\s*var\(--nb-void\)/, '层要有不透明背景，且用与外壳同一个底色');
});

test('★★★ 预热态只改透明度，不许带 animation', () => {
  /*
   * pending 的作用是"没有动画地待在起点"，好让首帧的布局/栅格化先完成。
   * 带了 animation 就变成"提前播一次"，等于两次动画。
   */
  const rule = blocksOf(css, '.nb-page-layer[data-nav-pending]');
  assert.match(rule, /opacity:\s*0/, 'pending 起点要透明（不可见）');
  /* 只查**声明块内部**有没有 animation，不是整段文本里有这个词 */
  for (const one of rule.split('.nb-page-layer').filter((s) => s.includes('{'))) {
    assert.doesNotMatch(one, /animation\s*:/, 'pending 不许有 animation');
  }
});

test('★★★ 层的几何：绝对定位 + 自己重建 flex 链', () => {
  /*
   * ① `position: absolute` —— 两层必须重叠在同一块区域（交叉淡化要求
   *    新旧两页**完全重合**，否则淡化时会出现两块分开的画面）；
   *    左右下三边贴 0、**顶边让出安全区**（见上面那条判据：
   *    `inset: 0` 会把外壳的 padding 盖住，那是 11-05 顶栏被状态栏压住的成因）。
   * ② `display: flex; flex-direction: column` —— 绝对定位后脱离父级
   *    flex 高度分配，不重建这条链，内部 `.nb-scroll` 的 `flex: 1` 会失效。
   * ③ `overflow: hidden` —— 页面内部滚动容器各自收敛，不外溢。
   */
  const rule = blockOf(css, '.nb-page-layer');
  assert.match(rule, /position:\s*absolute/, '要绝对定位');
  assert.match(rule, /display:\s*flex/, '要重建 flex 链');
  assert.match(rule, /flex-direction:\s*column/, '列方向');
  assert.match(rule, /overflow:\s*hidden/, '要外裁，否则页面能左右拖');
});

test('★★★ 外壳要 overflow: hidden（裁掉滑出屏幕的那层）', () => {
  const rule = blockOf(css, '.nb-page');
  assert.match(rule, /overflow:\s*hidden/, '外壳必须裁切');
});

test('★★★ will-change 只加在正在动的那两层上（静态写会毁掉 fixed 定位）', () => {
  /*
   * `will-change: transform` 同样会建立 fixed 的 containing block。
   * 写成静态声明 = 所有页面永远带着它 = 下拉面板永远错位。
   *
   * 判据不钉具体选择器写法（那是实现细节），钉**性质**：
   * 凡是声明了 `will-change: transform` 的规则，选择器里必须带
   * `[data-nav]` 或 `[data-leaving]` —— 也就是"只在动画期间"。
   */
  const base = blockOf(css, '.nb-page-layer');
  assert.doesNotMatch(base, /will-change/, '基础规则里不许有 will-change');

  const offenders = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = ruleRe.exec(css)) !== null) {
    const selector = match[1].trim();
    const body = match[2];
    if (!/will-change:\s*transform/.test(body)) continue;
    if (selector.includes('[data-nav]') || selector.includes('[data-leaving]')) continue;
    offenders.push(selector.replace(/\s+/g, ' ').slice(0, 70));
  }

  assert.deepEqual(
    offenders,
    [],
    `这些规则静态声明了 will-change: transform，会让 position:fixed 的后代（下拉面板）定位错掉：\n  ${offenders.join('\n  ')}`,
  );
});

test('★★★ 层的顶边必须让出安全区（不许写 inset: 0）', () => {
  /*
   * ## 2026-11-05 真机 bug：顶栏和系统状态栏重叠（红米）
   *
   * > 新bug，我的红米的顶部和系统的重叠了，一定要做不同手机的适配啊
   *
   * 实测（Redmi Note 8 Pro，393×851）：
   *
   * ```text
   *   --nb-safe-top            27px      ← 变量是对的
   *   .nb-page  padding-top    27px      ← 写了，但…
   *   .nb-page-layer  top      0         ← ★ 层从 0 铺满，把 27px 盖住
   *   .nb-topbar-title  top    6.5       ← 被状态栏压住
   * ```
   *
   * 根因：绝对定位的包含块是祖先的 **padding box**，`inset: 0` 的 `top: 0`
   * 对齐 border 内侧（y=0），**不是内容区顶边（y=padding-top）**。
   *
   * 所以这条判据直接禁止 `inset: 0`：写了它，任何加在外壳 `padding` 上的
   * 安全区都会失效，而且**不报错、不红单测**。
   */
  const rule = blockOf(css, '.nb-page-layer');
  assert.doesNotMatch(rule, /inset:\s*0/, '不许写 inset: 0（会盖住外壳的安全区 padding）');
  assert.match(rule, /top:\s*var\(--nb-page-inset-top\)/, 'top 要取安全区变量');
  assert.match(rule, /bottom:\s*0/, '底边贴 0');
  assert.match(rule, /left:\s*0/, '左边贴 0');
  assert.match(rule, /right:\s*0/, '右边贴 0');
});

test('★★★ 安全区数值只许定义一份（在 token 里）', () => {
  /*
   * 这次 bug 的另一半成因是"写了两处、其中一处不起作用"：
   * `.nb-page` 写了 `padding-top`，但它的子元素全是绝对定位的层，
   * padding 对层**不起作用** —— 写了只让人误以为安全区已经处理了。
   *
   * 现在唯一的真值是 token 文件里的 `--nb-page-inset-top`，
   * 由层的 `top` 使用。`chat.css` 里不许再出现第二份安全区取值。
   */
  const tokens = stripComments(read('client/src/chat/nebula-tokens.css'));
  const defMatch = /--nb-page-inset-top:\s*([^;]+);/.exec(tokens);
  assert.ok(defMatch !== null, 'tokens 里要有 --nb-page-inset-top 的定义');
  assert.match(defMatch[1], /--nb-safe-top/, '第一级：Android 注入的真实值');
  assert.match(defMatch[1], /env\(safe-area-inset-top/, '第二级：env() 兜底');
  assert.match(defMatch[1], /,\s*24px\)/, '第三级：24px 兜底');

  /* chat.css 里不许再有第二份（会与 token 分叉） */
  assert.doesNotMatch(
    css,
    /padding-top:\s*max\(var\(--nb-safe-top/,
    '不许在 chat.css 里再写一份安全区取值',
  );
  assert.doesNotMatch(
    css,
    /--nb-page-inset-top:\s*max\(/,
    '变量定义只在 tokens 里（chat.css 只引用）',
  );
});

test('★★ 死规则要删掉（没有两份 padding 就不需要抵消）', () => {
  /*
   * `.nb-page .nb-page { padding-top: 0 }` 是 11-04 为"二级页多出 27px"
   * 加的抵消规则。现在没有任何 `.nb-page` 写 padding-top 了，它失去对象。
   *
   * 留着比删掉更坏：后来的人会以为"内层是有 padding 的、只是被压掉了"，
   * 从而不敢动真正的机制（层的 `top`）。
   */
  assert.doesNotMatch(
    css,
    /\.nb-page\s+\.nb-page\s*\{[^}]*padding-top/,
    '抵消规则已失效，应删除（不留死代码）',
  );
});


test('★★ 时长用 token，不写死毫秒（prefers-reduced-motion 要能塌成 1ms）', () => {
  for (const selector of ['.nb-page-layer[data-nav]', '.nb-page-layer[data-leaving]']) {
    const rule = blockOf(css, selector);
    assert.match(rule, /var\(--nb-dur-nav\)/, `${selector} 要用 --nb-dur-nav`);
    assert.doesNotMatch(rule, /\d+ms/, `${selector} 不许写死毫秒`);
  }
});

test('★★ 两条关键帧只动 opacity（不许触发布局重排）', () => {
  for (const name of ['nb-layer-fade-in', 'nb-layer-fade-out']) {
    const at = css.indexOf(`@keyframes ${name}`);
    assert.ok(at > 0, `缺少 ${name}`);
    /* 关键帧用的是百分比节点（0% / 35% / 100%），不是 from/to */
    const kf = css.slice(at, css.indexOf('\n}\n', at) + 3);
    for (const banned of ['left:', 'margin-left:', 'margin-right:', 'width:', 'top:', 'height:', 'transform:']) {
      assert.ok(!kf.includes(banned), `${name} 里不许改 ${banned}（会触发布局/多一层合成）`);
    }
  }
});

test('★★ 旧页要淡到 0、新页要淡到 1（"看不见"与"完全遮住"）', () => {
  /*
   * 用户原话：
   *
   * > 上一个页面在出去的时候应该是逐帧的透明度下降**直到看不见**，
   * > 下一个页面进来的时候是逐帧的透明度上升**直到完全将上一个页面遮住**
   *
   * 所以终点必须正好是 0 和 1，不能是 0.62 / 0.9 这类"半吊子"值 ——
   * 旧版（层叠滑动）就是停在 0.62，于是旧页永远半透明地留在那儿。
   */
  const outAt = css.indexOf('@keyframes nb-layer-fade-out');
  const outKf = css.slice(outAt, css.indexOf('\n}\n', outAt) + 3);
  assert.match(outKf, /100%\s*\{\s*opacity:\s*0\s*;?\s*\}/, '旧页终点 opacity 必须是 0');

  const inAt = css.indexOf('@keyframes nb-layer-fade-in');
  const inKf = css.slice(inAt, css.indexOf('\n}\n', inAt) + 3);
  assert.match(inKf, /100%\s*\{\s*opacity:\s*1\s*;?\s*\}/, '新页终点 opacity 必须是 1');
});

test('★★★ 新层渲染为空时不许播（宁可留旧页，也不给白屏）', () => {
  const at = shellSrc.indexOf('private finishPageTurn');
  const block = shellSrc.slice(at, at + 3000);

  assert.match(block, /next\.children\.length === 0/, '要检查新层是否为空');
  assert.match(block, /__TCS_PAGE_EMPTY__/, '要留可查的痕迹给探针');
  assert.match(block, /this\.pageHost = previous;/, '空层要退回去、保留旧页');
});

test('★★★ 动画前必须预热一帧（否则首帧卡顿 = 用户说的"残影"）', () => {
  /*
   * 真机帧间隔实测（换曲线之后仍然存在）：
   *
   * ```text
   *   push   0 33 50 17 17 17 17 17 17
   *   back  133 33 67 17 33 16 17 17
   *               ↑ 掉帧全在开头 2～3 帧，之后满 60fps
   * ```
   *
   * 不是持续掉帧，是**首帧开销**：新层刚 append，要布局、
   * 把整页栅格化成纹理、上传给合成器，而动画同时就开始了。
   *
   * 修法：先打 `data-nav-pending` 把层**静态**放到起点，
   * 下一帧（rAF）再换成 `data-nav`。那一帧的绘制就是预热。
   */
  const at = shellSrc.indexOf('private finishPageTurn');
  const block = shellSrc.slice(at, at + 5000);

  assert.match(block, /dataset\['navPending'\] = direction/, '要先打 pending 标记');
  assert.match(block, /delete next\.dataset\['navPending'\]/, '启动时摘掉 pending');
  assert.match(block, /requestAnimationFrame/, '靠 rAF 隔开一帧');
  assert.match(block, /typeof raf === 'function'/, '要判断 rAF 是否存在（Node stub 没有）');

  /*
   * `data-nav` 必须在 rAF 的**回调里**打，不能在同步代码里打 ——
   * 同步打就和"设起点"同一帧，预热白做。
   */
  const startAt = block.indexOf('const start = ');
  const navAt = block.indexOf("next.dataset['nav'] =", startAt);
  const callAt = block.indexOf('raf(start)');
  assert.ok(startAt > 0 && navAt > startAt && callAt > navAt, 'data-nav 要写在 start 回调里，再由 rAF 调用');
});

test('★★★ 兜底预算必须在 data-nav 打上之后算', () => {
  /*
   * `animationBudgetMs()` 读 `getComputedStyle(next).animationDuration`。
   * 预热阶段还没有 `data-nav` ⇒ 读到 `0s` ⇒ 退回常数 600ms，
   * 而真实值是"260 + 200 = 460"。
   *
   * 虽然 600 也够用，但那就等于把"从实际动画算"这条设计废了 ——
   * 又变回"写死一个数"。
   *
   * ★ 判据钉的是**调用关系**，不是源码行号顺序：`arm` 是
   * `const arm = () => {...}` 定义在前面、在 `start()` 里调用。
   * 第一版比"animationBudgetMs 出现在 const start 之后"，
   * 那是文本顺序，代码明明是对的也红。
   */
  const at = shellSrc.indexOf('private finishPageTurn');
  const block = shellSrc.slice(at, at + 5000);

  const startAt = block.indexOf('const start = ');
  assert.ok(startAt > 0, '要有 start 回调');
  const startBody = block.slice(startAt, block.indexOf('};', startAt));

  const navPos = startBody.indexOf("next.dataset['nav']");
  const armPos = startBody.indexOf('arm()');
  assert.ok(navPos > 0, 'start 里要打 data-nav');
  assert.ok(armPos > 0, 'start 里要调 arm()（收尾必须在动画属性就位之后）');
  assert.ok(navPos < armPos, 'data-nav 要先于 arm()，否则预算读到 0s');

  /* arm 里才是真正算预算的地方 */
  const armAt = block.indexOf('const arm = ');
  assert.ok(armAt > 0, '要有 arm 收尾函数');
  const armBody = block.slice(armAt, block.indexOf('};', armAt));
  assert.match(armBody, /animationBudgetMs\(next\)/, 'arm 里要按实际动画时长算预算');
});

test('★★★ 兜底时长必须从实际动画算，不许写死常数', () => {
  /*
   * ## 这条是 2026-11-05 取证时被绊出来的真缺陷
   *
   * 兜底定时器原来写死 600ms（当时 `--nb-dur-nav` 是 260ms，够用）。
   * 但它成了**第二个真值来源**：
   *
   * ```text
   *   把 --nb-dur-nav 调到 800ms（"我觉得太快了"）
   *   ⇒ 600ms 时旧层被删、data-nav 被摘
   *   ⇒ 旧层在动画中途"啪"地消失
   *   ⇒ 而 CSS 里一切正常，从样式查不出任何问题
   * ```
   *
   * 取证时把变量放到 5000ms 想抓中间帧，结果每张截图都是终态 ——
   * 那一刻才明白是兜底把场面拆了。
   *
   * 现在读计算样式里的 `animationDuration`（浏览器真正在用的值），
   * 兜底 = 它 + 200ms。读不到（Node 的 DOM stub）才退回常数。
   */
  const at = shellSrc.indexOf('private finishPageTurn');
  const block = shellSrc.slice(at, at + 3000);

  assert.match(block, /animationBudgetMs\(next\)/, '兜底要用实际动画时长算出来的预算');
  assert.doesNotMatch(
    block,
    /setTimeout\(\s*(settle|drop)\s*,\s*\d{2,}\s*\)/,
    '不许再给兜底定时器写死毫秒',
  );

  /* 辅助函数本身：要读计算样式，且读不到时有兜底 */
  const helperAt = shellSrc.indexOf('function animationBudgetMs');
  assert.ok(helperAt > 0, '找不到 animationBudgetMs');
  const helper = shellSrc.slice(helperAt, helperAt + 1400);

  assert.match(helper, /getComputedStyle/, '要读计算样式（变量可能被继承/覆盖，计算值才是真的）');
  assert.match(helper, /animationDuration/, '读的字段是 animationDuration');
  assert.match(helper, /endsWith\('s'\)/, '要处理 `0.26s` 这种秒单位');
  assert.match(helper, /endsWith\('ms'\)/, '要处理 `260ms` 这种毫秒单位');
  assert.match(helper, /NAV_FALLBACK_MS/, '读不到时要有常数兜底（Node stub 没有 getComputedStyle）');
});

