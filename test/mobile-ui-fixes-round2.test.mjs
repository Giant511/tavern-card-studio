/**
 * 2026-10-31 第二轮移动端 UI 修复的回归守卫（问题四 / 五 / 六）。
 *
 * ## 为什么单独一个文件
 *
 * 上一批（问题一 / 二 / 三）在 `mobile-ui-fixes.test.mjs` 里，都是**读源码做正则**。
 * 这一批是在"对着修复后的截图逐一核对"时又发现的三个新缺陷，性质不同：
 *
 * | 编号 | 缺陷 | 为什么上一批测试没抓住 |
 * |---|---|---|
 * | 四 | 麦克风按钮是浏览器默认灰方块 | 它"有 48×48 的尺寸"，量尺寸的断言是绿的 |
 * | 五 | 「我的」页溢出不滚动 | 只验过"元素存在"，没验过"内容能滚到" |
 * | 六 | 语音条目显示内部 id `aliyun-paraformer` | 值确实拼进去了，功能对、文案错 |
 *
 * 三条的共同点是：**代码在跑、断言是绿的、用户看到的是错的**。
 * 所以判据必须落在"用户看到什么"上 —— 圆角/底色/边框的值、
 * 滚动容器的 `min-height`、副标题拼接的是不是显示名。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * 不能用 `URL.pathname`：仓库路径含中文（`D:\Claw\代码开发\...`），
 * `pathname` 会做百分号编码，`readFileSync` 报 ENOENT —— 而报错信息
 * 看起来像"文件不存在"，很容易误判成文件被删了。
 */
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CHAT_DIR = join(REPO, 'client', 'src', 'chat');

const css = () => readFileSync(join(CHAT_DIR, 'chat.css'), 'utf8');
const shellSrc = () => readFileSync(join(CHAT_DIR, 'shell.ts'), 'utf8');

/** 取出某个选择器的第一段声明块（`{` 到最近的 `}`） */
function blockOf(source, selector) {
  const i = source.indexOf(`${selector} {`);
  assert.ok(i > 0, `找不到选择器 ${selector}`);
  return source.slice(i, source.indexOf('}', i));
}

/**
 * 去掉 CSS 注释。
 *
 * ★ 这一步不能省。
 *
 * `.nb-mic-slot` 的注释里**原文引用**了 UA 的默认值
 * （"`border-radius: 0`"、"`background: rgb(107,107,107)`"），
 * 而第一版 `propOf()` 用 `border-radius:\s*([^;]+);` 直接在这段文本里找，
 * 匹配到的是注释里那个 `0` —— 于是判据报"mic=0 与 send=999px 不一致"，
 * **而代码其实是对的**。
 *
 * 这就是"测试把缺陷写成期望值"的反面：测试把**注释**当成了实现。
 * 剥掉注释再取值，才是在验真实声明。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 取一个 CSS 属性的值（无则返回 null） */
function propOf(block, prop) {
  const m = stripComments(block).match(new RegExp(`(?:^|[;{\\s])${prop}:\\s*([^;]+);`));
  return m === null ? null : m[1].trim();
}

/* ═══════════════════════════════════════════════════════════
   问题四：麦克风按钮是浏览器默认外观
   ═══════════════════════════════════════════════════════════ */

test('★ 问题四：.nb-mic-slot 必须重置按钮的 UA 外观', () => {
  /*
   * `.nb-mic-slot` 是 `<button>`（无障碍要求），而按钮有浏览器默认外观。
   * 2026-10-31 真机/截图实测的默认值是：
   *   background: rgb(107, 107, 107)
   *   border:     2px solid ButtonBorder  → 白
   *   border-radius: 0px
   * 也就是一个**灰方块**，紧挨着圆角+夜空底色的发送按钮。
   *
   * 判据写三条而不是"有 background 就行"：缺任何一条都还是方块。
   */
  const block = blockOf(css(), '.nb-mic-slot');

  assert.match(block, /border-radius:\s*var\(--nb-radius-pill\)/, `麦克风要圆角，实际：${block}`);
  assert.match(block, /background:\s*var\(--nb-surface-2\)/, `麦克风要夜空底色（不能留 UA 的灰），实际：${block}`);
  assert.match(block, /border:\s*1px solid var\(--nb-glass-border\)/, `麦克风边框要用 token，实际：${block}`);
});

test('★ 问题四：麦克风与发送按钮的视觉参数必须逐字相同', () => {
  /*
   * 更硬的一条：两个按钮并排，圆角 / 底色 / 边框必须一致。
   * 只验"各自有值"会漏掉"一个有值、另一个不同"的情况 ——
   * 那正是用户看到"一个方块一个圆"的原因。
   */
  const source = css();
  const mic = blockOf(source, '.nb-mic-slot');
  const send = blockOf(source, '.nb-send');

  for (const prop of ['border-radius', 'background', 'border']) {
    assert.equal(
      propOf(mic, prop),
      propOf(send, prop),
      `${prop} 两个按钮必须一致（mic=${propOf(mic, prop)} / send=${propOf(send, prop)}）`,
    );
  }
});

/* ═══════════════════════════════════════════════════════════
   问题五：「我的」页内容超出屏幕却不滚
   ═══════════════════════════════════════════════════════════ */

test('★ 问题五：「我的」页的内容必须装进能滚的容器', () => {
  /*
   * `.nb-page` 是 `flex:1; min-height:0` 但**没有 `overflow-y`**，
   * 它按设计只装"一屏放得下"的页面（聊天页的滚动由 `.nb-msglist` 内部承担）。
   *
   * 「我的」页展开接口配置后实测：内容 1558px、可视 690px。
   * 缺滚动容器时 `scrollHeight === clientHeight === 743`，溢出**不产生滚动**：
   * API key 的说明被保存按钮压住截断，语音区块整个看不到。
   */
  const src = shellSrc();

  assert.match(src, /'nb-scroll'/, '「我的」页要用 .nb-scroll 容器');

  /*
   * 2026-10-31 第三批：两个条目合并成一行 append，旧的两条正则都失效了：
   *   旧：`scroller.append(\s*page\s*)`         ← API 页现在是收纳项内部构建
   *   旧：`scroller.append(\s*this.renderVoiceSection\(\)\s*)` ← 前面多了 API 条目
   *
   * 判据改成"这一次 append 里两个条目都在"，比原来的两条更强：
   * 原来允许"只挂了一个"，现在要求**两个都挂上**。
   */
  assert.match(
    src,
    /scroller\.append\(\s*this\.renderApiSection\(\),\s*this\.renderVoiceSection\(\),?\s*\)/s,
    '两个收纳项都必须 append 进 .nb-scroll（挂到 pageHost 就不会滚）',
  );
});

test('★ 问题五：.nb-scroll 的三个属性缺一不可', () => {
  /*
   * `flex:1` 给高度分配、`min-height:0` 允许收缩、`overflow-y:auto` 才真的滚。
   *
   * 少写 `min-height: 0` 时 flex 子项的最小高度是 `auto`，内容会把它顶开、
   * 整页跟着长高，滚动条永远不出现 —— 表现与"完全没加容器"一模一样，
   * 所以这一条必须单独守。
   */
  const block = blockOf(css(), '.nb-scroll');

  assert.match(block, /flex:\s*1/, `.nb-scroll 要 flex:1，实际：${block}`);
  assert.match(block, /min-height:\s*0/, `.nb-scroll 要 min-height:0，实际：${block}`);
  assert.match(block, /overflow-y:\s*auto/, `.nb-scroll 要 overflow-y:auto，实际：${block}`);
});

/* ═══════════════════════════════════════════════════════════
   问题六：语音条目副标题显示内部 id
   ═══════════════════════════════════════════════════════════ */

test('★ 问题六：语音条目显示厂商名，不显示 presetId', () => {
  /*
   * 第一版副标题是 `` `当前：${this.voiceSettings.presetId}` ``，
   * 用户看到"当前：aliyun-paraformer"—— 那是我们的数据结构。
   *
   * 这类问题（界面在跟用户说内部标识）单元测试不会红：值确实拼进去了，
   * 功能也对。只有把"文案"本身当判据才抓得到 —— 与 `verify-ui-copy.mjs`
   * 同一族纪律。
   *
   * ## 2026-10-31 第三批：判据范围要跟着重构走
   *
   * 原来只在 `renderVoiceSection` 之后 2800 个字符里找 `findAsrPreset(` ——
   * 而重构把副标题文案搬进了模块级的 `voiceSummary()`（放在文件前部），
   * 于是片段里找不到，红在了**正确的位置之外**。
   *
   * 改判据（不是改实现去迁就测试）：
   *   · 在整个 `shell.ts` 里找 `findAsrPreset(`  —— 它必须被用到
   *   · 在整个文件里**禁止**出现直接拼 `presetId` 当文案的写法
   * 两条合起来仍然守住原意，且不再依赖"函数在文件哪个位置"。
   */
  const src = shellSrc();

  assert.match(src, /findAsrPreset\(/, '要用 findAsrPreset 取厂商显示名');
  assert.doesNotMatch(
    src,
    /当前：\$\{[^}]*presetId/,
    '副标题不许直接拼 presetId（用户不认识 aliyun-paraformer 这种标识）',
  );
});
