/**
 * 下拉面板的**跨设备**判据（2026-11-07）。
 *
 * ## 用户两次明令
 *
 * > 我这里提一嘴，你做的动画应该要兼容别的手机系统或者设备，
 * > 不能就只用我连到电脑上的这个设备为基准
 *
 * > 再次重申，所有的 UI 设计不能只依据我当前连到电脑上的这台手机，
 * > 要保证不同手机可以兼容
 *
 * 第一版修"人设下拉竖排"时我又犯了同一个错：写了
 * `POPOVER_MIN_WIDTH = 160` —— 一个拿 360dp / 16px 凑出来的像素值。
 * 它在 1.3× 字体缩放、320dp 小屏、平板、14px 字号档上全都不成立。
 *
 * ## 所以判据怎么钉
 *
 * 不钉某一个具体宽度，钉**性质**：
 *
 * ```text
 *   ① 可读下限：面板内文字可用宽度 ≥ MIN_CHARS × 实际字号
 *   ② 不溢出：left ≥ EDGE 且 left + width ≤ 视口宽 - EDGE
 *   ③ 不缩成一条：平板/宽屏上面板不能比触发器还窄
 *   ④ 单调性：字号变大 ⇒ 最小宽度必须跟着变大（否则系统字体放大就白设了）
 * ```
 *
 * 在**全区间**上验：覆盖率取最差组合，而不是"我这台能过"。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  placePopover,
  popoverMinWidth,
  POPOVER_CHROME_PX,
  POPOVER_MIN_CHARS,
  POPOVER_MAX_MIN_WIDTH,
} from '../shared/src/chat/select-placement.ts';

/**
 * 要覆盖的真实设备与设置组合。
 *
 * 宽度取的都是 CSS px（dp），不是物理像素 —— WebView 的 `innerWidth`
 * 就是 CSS px，与 `devicePixelRatio` 无关。
 */
const VIEWPORTS = [
  { name: '320dp 小屏（老机型 / 分屏）', width: 320, height: 568 },
  { name: '360dp 常见安卓', width: 360, height: 800 },
  { name: '393dp Pixel 类', width: 393, height: 873 },
  { name: '412dp 大屏安卓', width: 412, height: 915 },
  { name: '480dp 小折叠外屏', width: 480, height: 1024 },
  { name: '768dp 折叠屏展开', width: 768, height: 1024 },
  { name: '1024dp 平板横屏', width: 1024, height: 768 },
];

/**
 * 字号档：0.85× / 1× / 1.15× / 1.3× / 1.5× / 2× 系统字体缩放，
 * 以及 token 里真实的 14px 档。
 */
const FONT_SIZES = [12, 13.6, 14, 16, 18.4, 20.8, 24, 32];

/** 触发器宽度：人设胶囊那种很窄的，到全宽输入框 */
const ANCHOR_WIDTHS = [64, 89, 120, 240, 361];

const EDGE = 12;

/** 一行文字实际可用的宽度（扣掉面板 padding、行 padding、对勾占位） */
function labelWidthOf(panelWidth) {
  return panelWidth - (POPOVER_CHROME_PX - 8);
}

test('★★★★★ 任何「屏宽 × 字号 × 触发器宽」组合下，文字都放得下 9 个字', () => {
  /*
   * 这是"不竖排"的真正判据：只要标签可用宽 ≥ 9 × 字号，
   * 最长的那些人设名（`不设人设（用默认名）`）就能在一行内显示，
   * 不会逐字换行。
   */
  const failures = [];

  for (const vp of VIEWPORTS) {
    for (const fontSize of FONT_SIZES) {
      for (const anchorWidth of ANCHOR_WIDTHS) {
        const placement = placePopover({
          anchor: { top: 100, bottom: 130, left: 20, width: anchorWidth },
          optionCount: 8,
          viewportHeight: vp.height,
          viewportWidth: vp.width,
          minWidth: popoverMinWidth(fontSize, vp.width),
        });

        const usable = labelWidthOf(placement.width);
        const need = POPOVER_MIN_CHARS * fontSize;

        /*
         * ★ 小屏 + 大字号时，物理上真的放不下（320dp 屏 + 32px 字号，
         *   9 个字要 288px，加 chrome 后 344px，而可用上限只有 296px）。
         *
         *   这时候**不该失败** —— 面板已经顶到视口上限了，再要更宽只能
         *   溢出屏幕。真正的兜底是 CSS 的 `nowrap + ellipsis`：放不下就省略，
         *   至少还是横着读得出来，而不是竖排。
         *
         *   所以判据是：要么放得下 9 个字，要么面板已经用满视口宽度。
         */
        const capped = placement.width >= vp.width - EDGE * 2 - 0.5;

        if (usable < need && !capped) {
          failures.push(
            `${vp.name} / ${String(fontSize)}px / 触发器${String(anchorWidth)}px ⇒ 可用 ${String(Math.round(usable))}px < 需要 ${String(need)}px，且未用满视口（面板 ${String(placement.width)}px）`,
          );
        }
      }
    }
  }

  assert.deepEqual(failures, [], `这些组合会竖排或换行：\n${failures.join('\n')}`);
});

test('★★★★★ 面板永远不溢出视口左右边界', () => {
  const failures = [];

  for (const vp of VIEWPORTS) {
    for (const fontSize of FONT_SIZES) {
      /* 触发器贴着左边缘、居中、贴着右边缘三种极限位置 */
      const anchors = [
        { left: 0, width: 89 },
        { left: Math.round(vp.width / 2) - 45, width: 89 },
        { left: vp.width - 89, width: 89 },
        { left: 0, width: 361 },
        { left: vp.width - 200, width: 200 },
      ];

      for (const a of anchors) {
        const p = placePopover({
          anchor: { top: 100, bottom: 130, left: a.left, width: a.width },
          optionCount: 8,
          viewportHeight: vp.height,
          viewportWidth: vp.width,
          minWidth: popoverMinWidth(fontSize, vp.width),
        });

        if (p.left < EDGE - 0.5) {
          failures.push(`${vp.name} 左溢出：left=${String(p.left)}`);
        }
        if (p.left + p.width > vp.width - EDGE + 0.5) {
          failures.push(
            `${vp.name} 右溢出：left=${String(p.left)} + width=${String(p.width)} > ${String(vp.width - EDGE)}（字号 ${String(fontSize)}，触发器 left=${String(a.left)} w=${String(a.width)}）`,
          );
        }
      }
    }
  }

  assert.deepEqual(failures, [], `这些组合会溢出屏幕：\n${failures.slice(0, 10).join('\n')}`);
});

test('★★★★ 平板/宽屏上面板不会被压成一条（不会比触发器还窄）', () => {
  /*
   * 反方向的问题：如果最小宽度写成"视口百分比"，在 1024dp 平板上
   * 反而会算出很小的值。这里确认"面板 ≥ 触发器宽"这条对齐规则没丢。
   */
  for (const vp of VIEWPORTS) {
    const p = placePopover({
      anchor: { top: 100, bottom: 130, left: 100, width: 361 },
      optionCount: 8,
      viewportHeight: vp.height,
      viewportWidth: vp.width,
      minWidth: popoverMinWidth(16, vp.width),
    });
    assert.ok(
      p.width >= Math.min(361, vp.width - EDGE * 2) - 0.5,
      `${vp.name}: 面板 ${String(p.width)}px 比触发器 361px 还窄`,
    );
  }
});

test('★★★★★ 字号变大 ⇒ 最小宽度必须变大（否则系统字体缩放白设）', () => {
  /*
   * 这条是"兼容"的核心：如果最小宽度是个固定像素，那么用户把系统字体
   * 调到 1.5× 之后，面板还是那么宽，文字就又开始竖排了 —— 而界面
   * 其他地方都变大了，看起来更糟。
   */
  let prev = 0;
  for (const fontSize of FONT_SIZES) {
    const w = popoverMinWidth(fontSize);
    assert.ok(w > prev, `字号 ${String(fontSize)}px 的最小宽度 ${String(w)}px 没有比上一档大`);
    prev = w;
  }

  /* 而且必须是**线性**增长：字号翻倍，宽度也要翻倍（除了固定的 chrome） */
  const at16 = popoverMinWidth(16);
  const at32 = popoverMinWidth(32);
  assert.equal(at32 - POPOVER_CHROME_PX, (at16 - POPOVER_CHROME_PX) * 2, '文字部分应随字号线性缩放');
});

test('★★★ 读不到字号时不许返回 0（那等于没有下限）', () => {
  /*
   * `readOptionFontSize()` 可能拿不到值。若 `popoverMinWidth` 对
   * 非法输入返回 0，面板就退回"跟着 89px 触发器"，竖排 bug 复发 ——
   * 而且是**静默**复发（不报错、不红单测）。
   */
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const w = popoverMinWidth(bad);
    assert.ok(w > 0, `fontSize=${String(bad)} 时返回了 ${String(w)}，必须有正的下限`);
    assert.equal(w, popoverMinWidth(16), '非法输入应按 16px 兜底');
  }
});

test('★★★ 垂直方向：面板不出上下边界（含小屏 + 键盘弹起的极端情况）', () => {
  const failures = [];
  for (const vp of VIEWPORTS) {
    /* 键盘弹起时可视高度可能只剩一半 */
    for (const height of [vp.height, Math.round(vp.height * 0.5), 320]) {
      for (const anchorTop of [40, Math.round(height / 2), height - 60]) {
        const p = placePopover({
          anchor: { top: anchorTop, bottom: anchorTop + 30, left: 20, width: 120 },
          optionCount: 8,
          viewportHeight: height,
          viewportWidth: vp.width,
          minWidth: popoverMinWidth(16, vp.width),
        });
        if (p.top < 0) failures.push(`${vp.name} h=${String(height)} 顶部溢出 top=${String(p.top)}`);
        if (p.top + p.maxHeight > height + 0.5) {
          failures.push(`${vp.name} h=${String(height)} 底部溢出 ${String(p.top)}+${String(p.maxHeight)}>${String(height)}`);
        }
      }
    }
  }
  assert.deepEqual(failures, [], failures.slice(0, 8).join('\n'));
});

test('★★★ 判据自身可信：故意给一个过窄的 minWidth 必须被上面那条判出来', () => {
  /*
   * 反证。如果 `placePopover` 无论传什么都返回足够宽的，上面那些
   * "放得下 9 个字"的判据就是**恒绿**的 —— 什么都没测到。
   *
   * 这里明确构造一个"不给下限"的场景（模拟第一版的 bug），
   * 确认"可用宽度 < 需要宽度"确实会发生。
   */
  const buggy = placePopover({
    anchor: { top: 100, bottom: 130, left: 20, width: 89 },
    optionCount: 8,
    viewportHeight: 800,
    viewportWidth: 360,
    /* 不传 minWidth = 第一版的行为（严格跟触发器同宽） */
  });

  assert.equal(buggy.width, 89, '不传 minWidth 时应当严格跟触发器同宽（这是老行为）');
  const usable = labelWidthOf(buggy.width);
  assert.ok(
    usable < POPOVER_MIN_CHARS * 16,
    `89px 面板的可用宽 ${String(Math.round(usable))}px 应该小于 9 字所需的 ${String(POPOVER_MIN_CHARS * 16)}px —— 若不是，说明"竖排判据"根本没在测东西`,
  );
});

/* ═══════════════════════════════════════════════════════════
   观感下限（2026-11-07 第二次反馈）
   ═══════════════════════════════════════════════════════════ */

test('★★★★ 面板不许"太窄看着别扭"：至少占视口一半（有上限）', () => {
  /*
   * 用户第二次反馈：
   *
   * > 面板展开的尺寸太小也是会有这种问题的出现
   *
   * "9 个字"是**可读性**下限，14px 字号下只有 182px —— 在 360dp 屏上
   * 只占一半，看起来像一条窄浮条。所以再加"至少占视口一半"的观感下限。
   *
   * ★ 用比例而不是绝对像素：这条同样是"不拿某台设备凑数"的落实。
   */
  const failures = [];
  for (const vp of VIEWPORTS) {
    const w = popoverMinWidth(14, vp.width);
    const expected = Math.min(vp.width * 0.5, POPOVER_MAX_MIN_WIDTH);
    if (w < expected - 0.5) {
      failures.push(`${vp.name}: 下限 ${String(w)}px < 观感下限 ${String(Math.round(expected))}px`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('★★★ 平板上面板不许占掉半边屏（比例下限要有上限）', () => {
  /*
   * 反方向的约束：1024dp 平板上 0.5 = 512px，而人设名通常不到 10 个字，
   * 512px 的空面板会很怪。
   */
  const at1024 = popoverMinWidth(14, 1024);
  assert.ok(
    at1024 <= POPOVER_MAX_MIN_WIDTH,
    `1024dp 上下限 ${String(at1024)}px 超过了 ${String(POPOVER_MAX_MIN_WIDTH)}px 的上限`,
  );
  /* 但也不能小到放不下 9 个字 */
  assert.ok(at1024 >= POPOVER_MIN_CHARS * 14 + POPOVER_CHROME_PX, '再小就放不下 9 个字了');
});

test('★★★ 不传视口宽时只按可读性算（老调用方/单测兼容）', () => {
  const noViewport = popoverMinWidth(14);
  assert.equal(noViewport, POPOVER_MIN_CHARS * 14 + POPOVER_CHROME_PX, '不传视口就只算字数下限');
  assert.ok(popoverMinWidth(14, 360) >= noViewport, '传了视口只会更宽，不会更窄');
});

test('★★★★ 选项字号必须是 14（用户两次说"太大了"）', () => {
  /*
   * 走查 4 只要求 `.nb-bubble` / `.nb-input`（正文）是 16px。
   * 下拉选项不是正文 —— 它一次列 5~10 行，是"挑一个"的列表。
   * 16px × 长中文名 ⇒ 面板要么很宽要么被挤。
   */
  const css = readFileSync(
    new URL('../client/src/chat/chat.css', import.meta.url),
    'utf8',
  );
  const start = css.indexOf('.nb-select-option {');
  assert.ok(start > 0, '找不到 .nb-select-option 定义');
  const block = css.slice(start, css.indexOf('}', start));
  assert.match(block, /font-size:\s*var\(--nb-fs-14\)/, '选项字号应是 --nb-fs-14');
});

