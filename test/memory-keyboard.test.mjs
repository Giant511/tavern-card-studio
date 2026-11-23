/**
 * 记忆面板的软键盘避让（2026-11-22，用户报「记忆功能里面你没做软键盘适配吧」）。
 *
 * ## 用户的要求
 *
 * > 键盘适配要适配各种机型的，不要只顾着固定某些型号
 *
 * 所以这份判据的重心是**不能有设备特判**，而不是钉某台机器上的数值：
 *
 * ```text
 * A. 机制必须是通用的        变量 + 系统 API，不出现任何品牌/型号
 * B. 关键 CSS 契约           三条易错的：padding 谁扣、box-sizing、上限基准
 * C. 三个真实翻盘点          都有真机/真渲染证据，见各条注释
 * ```
 *
 * ## 为什么静态判据不够、还要一个渲染矩阵
 *
 * 键盘避让在这个项目里反复出过"值算出来了但没生效"（memory §119/§130）。
 * 静态断言只能证明"写了这几行"。真渲染矩阵在
 * `scripts/kb-avoidance-matrix.mjs`（需要 Chrome，不挂在 `npm test` 里）：
 *
 * ```bash
 * node scripts/kb-avoidance-matrix.mjs
 * ```
 *
 * 它跑 3 种视口高度 × 5 种键盘高度 = 15 组，判据是
 * 「面板底边不越键盘上沿、顶边不出屏、内容够不着时列表可滚」。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const CSS = strip(read('client/src/chat/chat.css'));
const PANEL = strip(read('client/src/chat/memory-page.ts'));
const MAIN = strip(read('client/src/mobile/main.ts'));
const ACTIVITY = strip(
  read('client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/MainActivity.kt'),
);

/** 从 chat.css 取一个规则块 */
function blockOf(selector) {
  const at = CSS.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `找不到 ${selector} 的样式块`);
  const end = CSS.indexOf('\n}', at);
  return CSS.slice(at, end + 2);
}

/* ═══════════════════════════════════════════════════════════
   A. 不许设备特判（用户明确要求）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 键盘避让不许按机型/品牌特判', () => {
  /*
   * 用户原话：「键盘适配要适配各种机型的，不要只顾着固定某些型号」。
   *
   * 正确的做法是只用两个与设备无关的量：
   *
   * ```text
   *   visualViewport.height        键盘弹起时它会变小（所有 WebView 通用）
   *   WindowInsets.Type.ime()      系统给的 IME 高度（Android 11+ 通用）
   * ```
   *
   * 一旦出现 `Build.MODEL == "V2507A"` 这类判断，就意味着"换台机器就废"，
   * 而且那种代码在真机上表现为"静默失效"——不报错，只是不避让。
   */
  const sources = {
    'memory-page.ts': PANEL,
    'mobile/main.ts': MAIN,
    'MainActivity.kt': ACTIVITY,
  };
  const forbidden = /Build\.MODEL|Build\.MANUFACTURER|Build\.BRAND|userAgent\.includes\(/;
  for (const [name, src] of Object.entries(sources)) {
    /*
     * 允许在**日志**里打印机型 —— 排除两种形态：
     *   · 同一行里有 `StLog.` / `log.` / `console.`
     *   · 纯字符串字面量的续行（多行日志的后续行，形态是 `"..."`
     *     那样的独立字符串，不可能构成条件判断）
     */
    const lines = src
      .split('\n')
      .filter((line) => forbidden.test(line))
      .filter((line) => !/StLog\.|log\.|console\./.test(line))
      .filter((line) => {
        const t = line.trim();
        return !(t.startsWith('"') || t.startsWith("'"));
      });
    assert.deepEqual(lines, [], `${name} 里出现了按机型分支的代码：\n${lines.join('\n')}`);
  }
});

test('★★★★★ 不许多品牌名出现在判断逻辑里', () => {
  /*
   * 同上：`originOS` / `MIUI` / `EMUI` 这类判断一旦出现，就等于把
   * "适配"做成了"穷举已知机型"。
   */
  const brands = /originos|miui|emui|oneui|hyperos|coloros/i;
  for (const [name, src] of [
    ['memory-page.ts', PANEL],
    ['mobile/main.ts', MAIN],
    ['MainActivity.kt', ACTIVITY],
  ]) {
    const hits = src.split('\n').filter((line) => brands.test(line) && !/^\s*\*/.test(line));
    assert.deepEqual(hits, [], `${name} 里出现了 ROM 名判断`);
  }
});

test('★★★★★ 键盘高度必须来自系统 API，不许写死', () => {
  /*
   * 写死任何一个数字都会在另一种形态下错：
   *
   * ```text
   *   手势导航约 24dp   三键导航约 48dp   横屏三键在侧面（bottom=0）
   *   中文输入法 300±    手写/五笔更高      带候选栏再加一截
   * ```
   *
   * 原生侧必须用 `WindowInsets.Type.ime()`（低版本退回
   * `systemWindowInsetBottom`），并且用 `density` 换算而不是假定 1x/3x。
   */
  assert.match(ACTIVITY, /WindowInsets\.Type\.ime\(\)/, '要用系统给的 IME inset');
  assert.match(ACTIVITY, /displayMetrics\.density/, '要按实际 density 换算');
  /* 不许把某个 dp 值当常量用 */
  assert.doesNotMatch(ACTIVITY, /const val\s+KB_HEIGHT|IME_HEIGHT\s*=\s*\d+/, '不许写死键盘高度');
});

test('★★★★ 低版本要有一条明确的兜底路径（不能静默什么都不做）', () => {
  /*
   * `WindowInsets.Type.ime()` 是 API 30（Android 11）才有的。
   *
   * ## 代码的选择：不退回 `systemWindowInsetBottom`
   *
   * 那个值在键盘弹起时**混着导航栏/手势条**，分不清"键盘 300 + 手势 20"
   * 与"键盘 320"，多扣一截反而更歪。所以 API < 30 时原生侧不写这个变量。
   *
   * ## 那批机器靠什么
   *
   * JS 侧的 `visualViewport`（`keyboard-inset.ts`）—— 它在所有 WebView 上都有。
   * 两边各写**不同的** CSS 变量，CSS 里取 `max()`：
   *
   * ```text
   *   --nb-kb-inset          JS 按 visualViewport 算（全平台）
   *   --nb-kb-inset-native   Android 按 IME inset 写（API 30+）
   * ```
   *
   * 谁有值用谁，谁失效由另一个补上。这才是"适配各种机型"的落点。
   *
   * 判据钉三件事：分支存在、低版本**有日志说明**（不静默）、
   * JS 那条路径在、CSS 取 `max()`。
   */
  assert.match(ACTIVITY, /Build\.VERSION\.SDK_INT\s*>=\s*Build\.VERSION_CODES\.R/, '要判 API 30');
  /* 低版本分支必须留下痕迹，不许静默 */
  const elseAt = ACTIVITY.indexOf('API ${Build.VERSION.SDK_INT} < 30');
  assert.ok(elseAt > 0, '低版本分支要有日志说明，不能静默跳过');
  /* JS 侧的兜底必须在 */
  const js = read('client/src/chat/keyboard-inset.ts');
  assert.match(js, /visualViewport/, 'JS 侧要靠 visualViewport 兜底');
  assert.match(js, /export function attachKeyboardInset/, '要有安装入口');
  /* 而 CSS 必须把两个变量取 max */
  const mask = blockOf('.nb-sheet-mask');
  assert.match(mask, /max\(\s*var\(--nb-kb-inset[^)]*\)\s*,\s*var\(--nb-kb-inset-native/, 'CSS 要取两者的 max');
});

/* ═══════════════════════════════════════════════════════════
   B. 关键 CSS 契约（三条都踩过）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 键盘高度要扣在 mask 上（面板是 fixed，不吃 .nb-app 的 padding）', () => {
  /*
   * 聊天页的避让写在 `.nb-app` 的 `padding-bottom` 上。而记忆面板是
   * `position: fixed; inset: 0` —— 定位基准是**视口**，
   * `.nb-app` 的 padding 对它完全无效。
   *
   * 所以必须在 `.nb-sheet-mask` 上再扣一次，否则面板下半截直接落在键盘后面，
   * 用户看不到自己在打什么。
   */
  const mask = blockOf('.nb-sheet-mask');
  assert.match(mask, /position:\s*fixed/, '前提：它确实是 fixed');
  assert.match(
    mask,
    /padding-bottom:\s*max\(\s*var\(--nb-kb-inset/,
    'mask 要扣键盘高度',
  );
  /* 两个变量取 max：JS 与原生各覆盖一半时刻 */
  assert.match(mask, /--nb-kb-inset-native/, '要同时考虑原生写入的那个变量');
});

test('★★★★★ .nb-sheet 必须 box-sizing: border-box', () => {
  /*
   * ## 这一条是真实翻车的记录，不是洁癖
   *
   * `max-height` 默认约束**内容盒**。`.nb-sheet` 有
   * `padding: var(--nb-sp-4)` + `padding-bottom: calc(… + env(…))`，
   * 合计约 33px。不加 border-box 时真渲染量到：
   *
   * ```text
   *   可用高度（mask 内容盒）    1008
   *   max-height                 1007   ← 只限内容盒
   *   内容盒实测                  989    ← 没到上限，不裁
   *   边框盒 = 989 + padding 33  1022   ← 超出 14px
   *   ⇒ 顶边 = −14                       标题被顶出屏幕
   * ```
   *
   * ★ 关键点：只看 `computedStyle.maxHeight` 会显示 1007，**看起来完全正常**。
   *   必须量 `getBoundingClientRect()` 才能发现。
   */
  const sheet = blockOf('.nb-sheet');
  assert.match(sheet, /box-sizing:\s*border-box/, '不加这条会溢出 padding 的 33px');
});

test('★★★★★ 面板上限要用 calc(100vh − 键盘高)，不许用百分比', () => {
  /*
   * 第一版写 `min(78vh, 100%)`，想的是"父容器内容盒已经扣过键盘"。
   * 真渲染实测：`100%` 在 flex 项上解析不可靠，算出来 1022 > 可用 1008。
   *
   * `calc(100vh - max(键盘变量))` 与父容器内容盒是同一个基准
   * （mask 是 `inset: 0`，padding-bottom 就是键盘高），但**不依赖百分比解析**。
   */
  for (const selector of ['.nb-sheet', '.nb-sheet--memory']) {
    const body = blockOf(selector);
    assert.match(body, /calc\(\s*100vh\s*-\s*max\(/, `${selector} 要用 calc 扣键盘高度`);
    /* 不许再出现百分比上限（那正是失效的写法） */
    assert.doesNotMatch(body, /max-height:\s*min\([^)]*100%/, `${selector} 不许用百分比`);
  }
});

test('★★★★ 复杂函数要有简单值兜底（老 WebView 会把整条丢掉）', () => {
  /*
   * `min()` / `max()` / `calc()` 里嵌 `max()` 需要 Chrome 79+。
   * 项目 minSdk 24（Android 7），那批机器的 WebView 可能更老。
   *
   * 老浏览器遇到不认识的值会**丢掉整条声明** —— 只写一条的话，
   * 连 `78vh` 都没有了，面板会按内容高度无限长。
   *
   * 所以必须是"简单值在前、新语法在后"。
   */
  for (const selector of ['.nb-sheet', '.nb-sheet--memory']) {
    const body = blockOf(selector);
    const decls = [...body.matchAll(/max-height:\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.ok(decls.length >= 2, `${selector} 要写两条 max-height`);
    assert.ok(
      !decls[0].includes('min(') && !decls[0].includes('calc('),
      `${selector} 的第一条必须是简单值，实际是 ${decls[0]}`,
    );
  }
  const mask = blockOf('.nb-sheet-mask');
  const pads = [...mask.matchAll(/padding-bottom:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(pads.length >= 2, 'mask 的 padding-bottom 要写两条');
  assert.ok(!pads[0].includes('max('), `mask 第一条 padding-bottom 要简单，实际是 ${pads[0]}`);
});

test('★★★★ 记忆列表必须能滚（min-height: 0 是 flex 子项能滚的前提）', () => {
  /*
   * `.nb-memory-list` 是 `flex: 1 1 auto` 的子项。flex 项的默认
   * `min-height` 是 `auto`（等于内容高度），不显式设 0 的话
   * 它会被内容撑开、**永远不产生滚动条**，面板被压缩时末端条目就够不着。
   */
  const list = blockOf('.nb-memory-list');
  assert.match(list, /min-height:\s*0/, '不设 0 就滚不动');
  assert.match(list, /overflow-y:\s*auto/, '要能滚');
});

/* ═══════════════════════════════════════════════════════════
   C. 聚焦时把输入框滚进可见区
   ═══════════════════════════════════════════════════════════ */

test('★★★★ 两个记忆类都要在滚动白名单里', () => {
  /*
   * `focus-scroll.ts` 的 `SCROLLER_SELECTORS` 只有命中才会去滚。
   * 漏一个的表现是"点了输入框，光标在屏幕外"。
   */
  const src = strip(read('client/src/chat/focus-scroll.ts'));
  assert.match(src, /'\.nb-memory-list'/, '列表要能作为滚动容器');
  assert.match(src, /'\.nb-memory-input'/, '输入框自身内容超出时也要能滚');
});

test('★★★★★ 面板打开时，可见底边要取面板底边而不是页面底边', () => {
  /*
   * ## 两个原因
   *
   * ```text
   * ① 面板是 fixed 浮层，不在 .nb-page 里 —— 底边根本不是一个位置
   * ② .nb-page 的 bottom 已经扣过 tabbar 高度（.nb-app 的 padding 里减了
   *    --nb-tabbar-h），比真实键盘上沿低约 56px。对聊天页那是对的
   *    （输入栏就在 tabbar 上方），对浮层会**多算 56px 可见空间** ——
   *    结果"以为已经露出来了，其实还差一截"
   * ```
   */
  assert.match(MAIN, /querySelector\('\.nb-sheet'\)/, '要先找面板');
  const at = MAIN.indexOf("querySelector('.nb-sheet')");
  const around = MAIN.slice(at, at + 400);
  assert.match(around, /getBoundingClientRect\(\)\.bottom/, '取它的底边');
  /* 找不到面板时才退回页面底边 */
  assert.match(around, /\.nb-page/, '要有退回页面底边的分支');
});

/* ═══════════════════════════════════════════════════════════
   D. 真渲染矩阵（脚本要在、命令要能跑）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 真渲染矩阵脚本存在，且覆盖多视口 × 多键盘', () => {
  /*
   * 静态判据证明不了"布局真的被推上去"。矩阵脚本用无头 Chrome
   * 跑 3 视口 × 5 键盘 = 15 组，量 `getBoundingClientRect()`
   * 而不是 `computedStyle`（后者看不出 padding 溢出，见上面那条）。
   *
   * 不挂在 `npm test` 里（需要 Chrome，CI 环境未必有），
   * 但脚本必须留在仓库，改动键盘避让后要手工跑一次：
   *
   * ```bash
   * node scripts/kb-avoidance-matrix.mjs
   * ```
   */
  const src = read('scripts/kb-avoidance-matrix.mjs');
  assert.match(src, /getBoundingClientRect/, '要量真实矩形，不只看 computedStyle');
  const viewports = [...src.matchAll(/\{\s*label:\s*'[^']+',\s*height:\s*\d+/g)].length;
  const keyboards = [...src.matchAll(/\{\s*label:\s*'[^']+',\s*inset:\s*\d+/g)].length;
  assert.ok(viewports >= 3, `视口只覆盖了 ${String(viewports)} 种`);
  assert.ok(keyboards >= 5, `键盘只覆盖了 ${String(keyboards)} 种`);
  /* 判据本身要包含"底边不越键盘上沿" */
  assert.match(src, /sheetBottom > kbTop/, '要有"底边越过键盘上沿"这条判据');
});
