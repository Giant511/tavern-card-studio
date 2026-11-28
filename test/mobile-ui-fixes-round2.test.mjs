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
import { readShellImplNoComments } from './lib/shell-source.mjs';

/*
 * 不能用 `URL.pathname`：仓库路径含中文（`D:\Claw\代码开发\...`），
 * `pathname` 会做百分号编码，`readFileSync` 报 ENOENT —— 而报错信息
 * 看起来像"文件不存在"，很容易误判成文件被删了。
 */
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CHAT_DIR = join(REPO, 'client', 'src', 'chat');

const css = () => readFileSync(join(CHAT_DIR, 'chat.css'), 'utf8');
const shellSrc = () => readShellImplNoComments();

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
   *
   * ## 2026-11-22 改判据：底色不再要求相同
   *
   * 用户要求把发送按钮从 `↑` 图标改成写着「发送」的文字按钮，并且
   * **用底色表达能不能发**（灰=不能发、蓝=能发）。它因此从"图标按钮"
   * 变成了"主操作按钮"，与麦克风不再是同一个视觉物件 ——
   * 继续要求两边底色逐字相同，等于逼着主操作按钮不能有自己的状态色。
   *
   * 但**形状语言必须仍然一致**：并排挨着的两个控件，圆角与描边
   * 一旦不同，看起来就是"两个来源的东西拼在一起"（这正是本条判据
   * 当初要抓的那个观感）。所以留下 checked 的两项：
   *
   * ```text
   *   border-radius   都是 pill
   *   border          都是 1px solid（颜色可以不同：发送是 transparent）
   * ```
   *
   * 底色那条改成"必须走 token"：灰/蓝两态都取自
   * `--nb-send-idle-*` / `--nb-send-go-*`，不许写裸色值。
   */
  const source = css();
  const mic = blockOf(source, '.nb-mic-slot');
  const send = blockOf(source, '.nb-send');

  assert.equal(
    propOf(mic, 'border-radius'),
    propOf(send, 'border-radius'),
    `圆角必须一致（mic=${propOf(mic, 'border-radius')} / send=${propOf(send, 'border-radius')}）`,
  );

  const borderWidth = (block) => {
    const value = propOf(block, 'border');
    return value === null ? null : value.replace(/\s+var\([^)]*\)|\s+transparent/gi, '').trim();
  };
  assert.equal(
    borderWidth(mic),
    borderWidth(send),
    `描边宽度/线型必须一致（mic=${propOf(mic, 'border')} / send=${propOf(send, 'border')}）`,
  );

  assert.match(
    propOf(send, 'background') ?? '',
    /var\(--nb-send-idle-bg\)/,
    '发送按钮的底色必须走 token（灰/蓝两态在 nebula-tokens.css 的 §1.2b）',
  );
  void mic;
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
  /*
   * ★ 2026-11-12：加了第三个收纳项「诊断日志」。
   *
   * 守的性质没变（**每一个都要进 .nb-scroll**），判据跟着加严：
   * 从"两个都在"变成"三个都在"。
   *
   * 这条判据历史上已经因为"条目数量变了"红过两次（见上面那段注释），
   * 每次都是判据写死了条目数而不是写"这些条目都要在"。
   * 现在仍然写死三个 —— 但这是刻意的：新增条目时就该来这里加一项，
   * 那一步能提醒作者"别忘了让它可滚"。
   */
  /*
   * ★ 用"取这一次 append 调用"而不是"逐字匹配参数列表"。
   *
   * 逐字匹配会被**夹在参数之间的注释**打断（本次就因为给诊断项写了段
   * 注释而误红）。而参数之间写注释是完全正常的代码风格，
   * 判据不该逼人为了迁就它而不写注释。
   */
  /*
   * ★ 定位必须从 `renderApiSection` **反查**到那个 `scroller.append(`。
   *
   * 文件里有多个 `scroller.append(`（角色页第 1507 行那个是另一处），
   * 直接 indexOf 拿到的是第一个 —— 又一种"前缀撞车"。
   */
  const apiAt = src.indexOf('this.renderApiSection(),');
  assert.ok(apiAt > 0, '找不到 renderApiSection 的挂载');
  const callAt = src.lastIndexOf('scroller.append(', apiAt);
  assert.ok(callAt > 0, 'renderApiSection 前面没有 scroller.append');
  const callEnd = src.indexOf('\n    );', callAt);
  const call = src.slice(callAt, callEnd < 0 ? callAt + 1200 : callEnd);

  for (const item of ['this.renderApiSection()', 'this.renderVoiceSection()', 'this.renderDiagSection()']) {
    assert.ok(call.includes(item), `${item} 必须 append 进 .nb-scroll（挂到 pageHost 就不会滚）`);
  }
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
