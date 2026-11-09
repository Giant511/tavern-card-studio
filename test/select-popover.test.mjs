/**
 * 下拉面板的判据（2026-11-03）。
 *
 * ## 这组守的核心缺陷类型
 *
 * **"元素对、位置错"**：面板本身渲染得完美（颜色渐变、选中高亮、选项齐全），
 * 但它出现在**视口外**或被滚动容器裁掉 —— 用户看到的现象是"点了没反应"。
 *
 * 这类缺陷 DOM 断言全绿（元素在、`textContent` 对），只有量
 * `getBoundingClientRect` 才发现。所以定位逻辑抽成纯函数 `placePopover()`，
 * 把"贴着屏幕底部时怎么办"这种真机上偶发、单测里好造的情形全钉住。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { placePopover, ROW_HEIGHT } from '../shared/dist/chat/select-placement.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CHAT_DIR = join(REPO, 'client', 'src', 'chat');

/** 造一个锚点矩形 */
function anchor(top, width = 320) {
  return { top, bottom: top + 48, left: 16, width };
}

/* ═══════════════════════════════════════════════════════════
   一、定位：不许跑到视口外
   ═══════════════════════════════════════════════════════════ */

test('★ 空间够时向下展开，面板顶边贴着触发器底边 + 间隙', () => {
  const p = placePopover({
    anchor: anchor(100),
    optionCount: 3,
    viewportHeight: 800,
    viewportWidth: 400,
  });

  assert.equal(p.side, 'down');
  assert.ok(p.top > 148, '面板不能盖住触发器（top 必须大于触发器 bottom=148）');
  assert.ok(p.top < 160, `间隙不该太大，实际 top=${String(p.top)}`);
  assert.equal(p.maxHeight, 3 * ROW_HEIGHT + 8, '空间够时要能放下全部选项，不滚动');
});

test('★★★ 贴着屏幕底部时要向上翻转（否则面板跑到视口外，看起来像"点了没反应"）', () => {
  /*
   * 这是这个组件最容易出的缺陷：设置页滚到底部时，最后几个下拉离屏幕下缘
   * 只有几十像素。若一律向下展开，面板会整个落在视口外 ——
   * DOM 里元素存在、`textContent` 也对，但用户什么都看不见。
   */
  const viewportHeight = 800;
  const p = placePopover({
    anchor: anchor(740), // 触发器底边 = 788，下面只剩 12px
    optionCount: 6,
    viewportHeight,
    viewportWidth: 400,
  });

  assert.equal(p.side, 'up', '下方放不下、上方更宽敞时必须向上翻转');
  assert.ok(p.top >= 0, `面板顶边不许是负数，实际 ${String(p.top)}`);
  assert.ok(
    p.top + p.maxHeight <= 740 - 4 + 1,
    `面板底边必须落在触发器上方（触发器 top=740），实际底边=${String(p.top + p.maxHeight)}`,
  );
  assert.ok(p.maxHeight > 0, 'maxHeight 必须为正，否则面板不可见');
});

test('★ 上下都不够时选较宽敞的一侧，且绝不超出视口', () => {
  /*
   * 30 个选项在任何手机上都不可能一次放下。此时**不能**一律向下 ——
   * 那会让面板贴着屏幕底边只剩几十像素，看起来像"只开了一条缝"。
   *
   * 正确行为：取上下之间更宽敞的那一侧，把高度夹到该侧空间，内部滚动。
   * 无论选哪侧，底边都不许越过视口。
   */
  const viewportHeight = 800;

  /* 触发器在中线偏上 ⇒ 上方更宽敞 ⇒ 向上 */
  const upper = placePopover({
    anchor: anchor(400), // 下方 336、上方 384
    optionCount: 30,
    viewportHeight,
    viewportWidth: 400,
  });
  assert.equal(upper.side, 'up', '上方更宽敞时应向上');
  assert.ok(upper.top >= 0, `面板顶边不许是负数，实际 ${String(upper.top)}`);
  assert.ok(upper.maxHeight > 0);
  assert.ok(upper.top + upper.maxHeight <= 800, '面板不许超出视口下边');

  /* 触发器偏下 ⇒ 下方更宽敞 ⇒ 向下 */
  const lower = placePopover({
    anchor: anchor(600), // 下方 136、上方 584
    optionCount: 30,
    viewportHeight,
    viewportWidth: 400,
  });
  assert.equal(lower.side, 'up', '上方 584 > 下方 136，仍然向上');

  /* 触发器贴近顶边 ⇒ 下方更宽敞 ⇒ 向下 */
  const top = placePopover({
    anchor: anchor(20), // 下方 716、上方几乎为 0
    optionCount: 30,
    viewportHeight,
    viewportWidth: 400,
  });
  assert.equal(top.side, 'down', '贴着顶边时只能向下');
  assert.ok(top.top + top.maxHeight <= 800, `面板不许超出视口，实际 ${String(top.top + top.maxHeight)}`);
});

test('★ 面板宽度跟触发器一致，且不超出视口安全边距', () => {
  const p1 = placePopover({
    anchor: { top: 100, bottom: 148, left: 16, width: 320 },
    optionCount: 3,
    viewportHeight: 800,
    viewportWidth: 400,
  });
  assert.equal(p1.width, 320, '宽度应与触发器一致');

  /* 触发器比视口还宽（异常情况）：夹到视口内 */
  const p2 = placePopover({
    anchor: { top: 100, bottom: 148, left: 0, width: 900 },
    optionCount: 3,
    viewportHeight: 800,
    viewportWidth: 400,
  });
  assert.ok(p2.width <= 400 - 12, `宽度要夹到视口内，实际 ${String(p2.width)}`);
  assert.ok(p2.left >= 0 && p2.left + p2.width <= 400, '左右都不许出视口');
});

test('★ 一行的高度常量与 CSS 里的 min-height 对得上', () => {
  /*
   * `ROW_HEIGHT` 参与"放得下几行"的计算。若它与 CSS 的 `.nb-select-option
   * { min-height }` 不一致，算出来的 maxHeight 会与实际渲染高度不符 ——
   * 表现为"面板明明算得下，却出现了滚动条"或反过来。
   *
   * 这种"两份数字"的地方最容易分叉，所以直接对一遍。
   */
  const css = readFileSync(join(CHAT_DIR, 'chat.css'), 'utf8');
  const block = /\.nb-select-option\s*\{([\s\S]*?)\}/.exec(css);
  assert.notEqual(block, null, '找不到 .nb-select-option 规则');
  const minHeight = /min-height:\s*(\d+)px/.exec(block[1]);
  assert.notEqual(minHeight, null, '.nb-select-option 要有 px 单位的 min-height');
  assert.equal(
    Number(minHeight[1]),
    ROW_HEIGHT,
    `JS 的 ROW_HEIGHT=${String(ROW_HEIGHT)} 必须与 CSS 的 min-height=${minHeight[1]} 一致`,
  );
});

/* ═══════════════════════════════════════════════════════════
   二、源码层面的红线
   ═══════════════════════════════════════════════════════════ */

test('★★★ 不许再出现原生 <select>（真机弹窗白底白字，改不了）', () => {
  /*
   * 用户原话：
   *
   * > AI 响应配置的所有下拉框里面都显示不出来，而且这个下拉框的样式有点丑，
   * > 和 APP 的 UI 风格一点也不搭，不要这种弹窗式的
   *
   * 真机抽帧：`<select>` 元素本身完全正常（361×51、近白文字、深色底），
   * 坏的是**点开后的系统弹窗** —— 白底 + 白字，6 个选项一个都看不见。
   * 那个弹窗是 WebView 用系统控件画的，`<option>` 的样式写 CSS 全部无效。
   *
   * 所以只要源码里还有 `el(doc, 'select'`，这个缺陷就一定还在。
   */
  const files = ['chat-settings.ts', 'select-popover.ts', 'select-placement.ts'];
  for (const file of files) {
    /*
     * 纯逻辑挪到了 `shared/src/chat/select-placement.ts`（client 是 `noEmit`，
     * 单测导入不进来），所以按文件是否存在挑目录 —— 写死一个目录会让
     * 这条判据在"文件挪走"时变成 ENOENT 而不是有意义的红。
     */
    const path = existsSync(join(CHAT_DIR, file))
      ? join(CHAT_DIR, file)
      : join(REPO, 'shared', 'src', 'chat', file);
    assert.ok(existsSync(path), `找不到 ${file}`);
    const src = readFileSync(path, 'utf8');
    assert.equal(
      /el\(\s*doc\s*,\s*'select'/.test(src),
      false,
      `${file} 里不许创建 <select>`,
    );
  }
});

test('★★ 位置只通过 CSS 变量写，不拼内联 top/left', () => {
  /*
   * 本项目对"内联样式"有明确取舍：`main.ts` 的通知曾用 `style.cssText` 拼
   * `bottom`，被走查判据拦下（`test/notify-and-sound.test.mjs`）。
   *
   * 这里的做法与键盘避让一致：JS 只写 `--pop-*` 变量，排版仍由 CSS 决定。
   */
  const src = readFileSync(join(CHAT_DIR, 'select-popover.ts'), 'utf8');

  assert.match(src, /style\.setProperty\('--pop-top'/, 'top 要通过 CSS 变量写');
  assert.match(src, /style\.setProperty\('--pop-left'/, 'left 要通过 CSS 变量写');
  assert.match(src, /style\.setProperty\('--pop-width'/, 'width 要通过 CSS 变量写');
  assert.match(src, /style\.setProperty\('--pop-max-h'/, 'max-height 要通过 CSS 变量写');

  assert.equal(
    /cssText/.test(src),
    false,
    '不许用 cssText 拼内联样式（走查判据明确禁止）',
  );
  assert.equal(
    /style\.(top|left|width|maxHeight)\s*=/.test(src),
    false,
    '不许直接给 style.top / style.left 赋值',
  );
});

test('★ 面板挂在 body 上，不挂在滚动容器里（否则会被 overflow 裁掉）', () => {
  /*
   * `.nb-list` 是 `overflow-y: auto`。绝对定位的子元素会被滚动容器裁掉，
   * 靠屏幕底部的下拉会被切一半。所以挂 body + `position: fixed`。
   */
  const src = readFileSync(join(CHAT_DIR, 'select-popover.ts'), 'utf8');
  /*
   * 代码里的写法是 `(doc as unknown as { body?: ... }).body` 再 `host?.append(...)`
   * —— 因为 `DocLike` 刻意不声明 `body`（渲染层只暴露 createElement）。
   * 所以断言"取了 body"而不是"字面上出现 document.body"。
   */
  assert.match(src, /\{\s*body\?:/, '要通过断言取 doc.body');
  assert.match(src, /host\?\.append/, '要真的挂到 body 上');
  /*
   * ★★★ 2026-11-03：不再用全屏遮罩接外部点击。
   *
   * 那个遮罩盖在触发器上，第二次点触发器时 `pointerdown` 先落到遮罩、
   * 遮罩关闭后这次点击的 `click` 又派发到下面的触发器 ⇒ 又开一次。
   * 用户看到的就是「只会重新展开，点一下收不回去」。
   * 改用 document 级 `pointerdown` + 目标判断。
   */
  assert.equal(
    /nb-popover-mask/.test(src),
    false,
    '不许再用全屏遮罩（它会抢走触发器的点击，导致点一下收不回去）',
  );
  assert.match(src, /'pointerdown', onPointerDown, true/, '外部点击关闭要用 document 级 pointerdown（捕获）');

  const css = readFileSync(join(CHAT_DIR, 'chat.css'), 'utf8');
  const block = /\.nb-select-popover\s*\{([\s\S]*?)\}/.exec(css);
  assert.notEqual(block, null, '找不到 .nb-select-popover 规则');
  assert.match(block[1], /position:\s*fixed/, '面板必须 fixed 定位（否则跟随滚动错位）');
});

test('★ 选中项要能被认出来（底色高亮 + data-selected）', () => {
  const src = readFileSync(join(CHAT_DIR, 'select-popover.ts'), 'utf8');
  assert.match(src, /setAttribute\('data-selected',\s*'true'\)/, '选中项要打 data-selected');

  const css = readFileSync(join(CHAT_DIR, 'chat.css'), 'utf8');
  assert.match(
    css,
    /\.nb-select-option\[data-selected='true'\]\s*\{[^}]*background:/,
    '选中项要有底色高亮（与 ST 原生下拉一致）',
  );
});

test('★★ 设置页两处下拉都必须走自己画的控件（不许只换一半）', () => {
  /*
   * 预设选择器和枚举字段是同一个系统弹窗问题。只换枚举、留着预设用原生
   * select，用户会在同一页看到一个好下拉和一个坏弹窗 —— 比全坏更困惑。
   */
  const src = readFileSync(join(CHAT_DIR, 'chat-settings.ts'), 'utf8');
  const calls = src.match(/makeSelectTrigger\(doc,/g);
  assert.notEqual(calls, null, '设置页要用 makeSelectTrigger');
  assert.ok(
    calls.length >= 2,
    `预设选择器与枚举字段都要用它，实际只调了 ${String(calls.length)} 次`,
  );
});

test('★★ 面板必须有 box-sizing: border-box（否则比控件宽出一截）', () => {
  /*
   * ## 真机实测（r58）
   *
   * ```text
   *   触发器 361px → 面板 371px
   *   差 10px = padding 4+4 + border 1+1
   * ```
   *
   * JS 把 `--pop-width` 算成"与触发器同宽"（361），但面板自己有 padding 与边框。
   * 默认 `content-box` 会把这些**加**到 width 上 ⇒ 面板右边比控件多出一截。
   *
   * 这个 10px 的错位在截图上一眼就看见，而在 DOM 断言里完全看不见 ——
   * `--pop-width` 变量值是**对的**，错的只是它的解释方式。
   *
   * 同一个坑 2026-11-02 在草稿卡上踩过（`width:100%` 缺 box-sizing 导致溢出）。
   */
  const css = readFileSync(join(CHAT_DIR, 'chat.css'), 'utf8');
  const block = /\.nb-select-popover\s*\{([\s\S]*?)\}/.exec(css);
  assert.notEqual(block, null, '找不到 .nb-select-popover 规则');

  /*
   * ★★★ 断言**声明行**，不是子串。
   *
   * 第一版写的是 `assert.match(block[1], /box-sizing:\s*border-box/)`，
   * 于是变异（把声明删掉）之后测试**依然全绿** —— 因为那条声明的上方
   * 注释里正好也写着「`box-sizing: border-box` 必须有」，子串匹配被注释满足了。
   *
   * 这类"判据被自己的注释/文档满足"的坑最容易骗人：变异验证是它唯一的照妖镜。
   * 现在要求 `box-sizing:` 出现在**行首**（跳过注释与缩进后的第一个非空白字符），
   * 注释里的反引号包裹形式不会满足。
   */
  const declared = /(^|\n)\s*box-sizing:\s*border-box\s*;/.test(block[1]);
  assert.equal(declared, true, '面板必须真的声明 box-sizing: border-box（width 才是外宽）');
});

/* ═══════════════════════════════════════════════════════════
   三、toggle：点一下开、再点一下收
   ═══════════════════════════════════════════════════════════ */

test('★★★ 触发器必须是 toggle：已经开着时再点要收起，不是重新展开', () => {
  /*
   * ## 用户报的缺陷（原话）
   *
   * > 点下拉框只会重新展开而不是点一下打开再点一下收回
   *
   * ## 两个成因，缺一不可
   *
   * ① `trigger` 的 click **无条件** `openSelectPopover(...)`。
   *    第二次点等于又开一个（旧的被单实例逻辑关掉）—— 看起来就是"重新展开"。
   *
   * ② 当时还有一层 `position: fixed; inset: 0` 的全屏遮罩盖在触发器上。
   *    第二次点的 `pointerdown` 先落到遮罩 → 遮罩关闭并移除；
   *    紧接着这次点击的 `click` 派发到遮罩下方的触发器 → 又开一次。
   *    **遮罩是主因**：它让触发器根本收不到"第一次点击"的完整语义。
   *
   * ## 为什么这条判据只能写源码级
   *
   * `ElLike` 是刻意极简的接口（没有 `contains` / `click()` 的可靠语义），
   * 在单测里造出"点一次、再点一次"的真实事件流不现实。
   * 真正的行为验证放在真机脚本
   * `.verify/verify-select-popover.mjs`「⑫ 再点触发器要收起」。
   * 这里钉的是**结构**：必须有 `handle !== null` 的收起分支。
   */
  const src = readFileSync(join(CHAT_DIR, 'select-popover.ts'), 'utf8');

  const clickBlock = src.slice(src.indexOf("trigger.addEventListener?.('click'"));
  const endIndex = clickBlock.indexOf('\n  });');
  const body = clickBlock.slice(0, endIndex);

  assert.match(body, /if \(handle !== null\)/, '必须有"已经开着"的判断分支');
  assert.match(body, /handle\.close\(\)/, '已经开着时要调用 close()，而不是再开一次');

  /*
   * 收起分支必须出现在"打开"之前。
   *
   * ★ 这里只能匹配 `handle = openSelectPopover(`，不能匹配裸的
   * `openSelectPopover(` —— 上面那段注释里也写着这个词
   * （"原来这里无条件 `openSelectPopover(...)`"），
   * 裸匹配会把注释里的位置当成调用位置，断言就永远失败。
   * 这是"判据被注释/文档满足"的镜像问题：**位置比较也会被注释骗**。
   */
  const closeAt = body.indexOf('handle.close()');
  const openAt = body.indexOf('handle = openSelectPopover(');
  assert.ok(closeAt > 0, '找不到收起调用');
  assert.ok(openAt > 0, '找不到打开调用');
  assert.ok(closeAt < openAt, '收起判断必须在"打开"之前，否则永远走不到');
});

test('★★ 外部点击判断要排除触发器本身（否则会关掉又立刻开一次）', () => {
  /*
   * document 级 `pointerdown` 判断"点在不在面板里"。若不排除触发器，
   * 点触发器时这里会先 `close()`，然后触发器的 `click` 又 `openSelectPopover` ——
   * 现象和用遮罩时一模一样：**点了收不回去**。
   */
  const src = readFileSync(join(CHAT_DIR, 'select-popover.ts'), 'utf8');
  const block = src.slice(src.indexOf('const onPointerDown = '));
  const body = block.slice(0, block.indexOf('\n  };'));

  assert.match(body, /contains\(panel, target\)/, '要排除"点在面板里"');
  assert.match(body, /contains\(options\.anchorEl, target\)/, '要排除"点在触发器上"');
});

test('★ 面板内部滚动不许关闭面板', () => {
  /*
   * 6 个选项在小屏上可能要内部滚一下才看得全。滚一下面板就消失，
   * 用户会以为"点错了"。
   */
  const src = readFileSync(join(CHAT_DIR, 'select-popover.ts'), 'utf8');
  const block = src.slice(src.indexOf('const onScroll = '));
  const body = block.slice(0, block.indexOf('\n  };'));

  assert.match(body, /contains\(panel, target\)/, '滚动事件来自面板内部时要忽略');
});

test('★ 同一时刻只允许一个下拉打开', () => {
  /*
   * 面板挂在 `body` 上，不在字段行子树里。不做单实例的话，
   * 点另一个下拉时前一个会**留在屏幕上** —— 两个面板同时开着，
   * 而前一个还锚在旧触发器上，位置也不对。
   */
  const src = readFileSync(join(CHAT_DIR, 'select-popover.ts'), 'utf8');
  assert.match(src, /closeActiveSelectPopover\(\);\s*\n/, '打开新面板前要先关掉旧的');
  assert.match(src, /activeSelectPopover = handle/, '要登记当前打开的那个');
});

test('★ 触发器不许"一聚焦就变紫"（手机上会一直紫着，像选中态）', () => {
  /*
   * `.nb-input:focus` 把边框转成星云紫 —— 那对文本框是对的（"可以打字了"），
   * 但对下拉触发器不行：手机上点一次之后焦点一直留在按钮上，
   * 于是它**一直紫着**。真机录屏里就是这个样子（用户点完下拉，触发器带紫边）。
   *
   * 改法：紫边改成只在 `aria-expanded='true'` 时出现，并在关闭时 blur。
   */
  const css = readFileSync(join(CHAT_DIR, 'chat.css'), 'utf8');

  assert.match(
    css,
    /\.nb-select-trigger:focus:not\(\[aria-expanded='true'\]\)/,
    '要有"聚焦但未展开时不显示紫边"的规则',
  );
  assert.match(
    css,
    /\.nb-select-trigger\[aria-expanded='true'\]\s*\{[^}]*border-color:\s*var\(--nb-nebula-a\)/,
    '展开时才用紫边表示状态',
  );

  const src = readFileSync(join(CHAT_DIR, 'select-popover.ts'), 'utf8');
  assert.match(src, /\.blur\?\.\(\)/, '关闭时要主动放弃焦点（否则下次按键还会闪紫边）');
});
