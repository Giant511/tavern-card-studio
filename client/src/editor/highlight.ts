/**
 * 高亮渲染：把 shared 的着色区间落到 CodeMirror 装饰，以及只读预览的 DOM 构造。
 *
 * 两条硬约束（docs/11 §8.3）：
 *   1. 着色区间只能来自 shared 的 `computeHighlightSpans`，不在这里重新实现匹配；
 *   2. 渲染层禁止 `innerHTML` / `insertAdjacentHTML`。预览用 `DOMParser` 解析
 *      `renderInlineHtml` 的输出（它已对文本/scope/ruleId 做过 HTML 转义）。
 */

import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet } from '@codemirror/view';
import {
  computeHighlightSpans,
  renderInlineHtml,
  type CompiledHighlightRule,
  type HighlightContext,
  type HighlightRuleFile,
} from '@tcs/shared';

/**
 * 每个 scope 一个 mark 类，样式在 styles.css 里定义。
 *
 * `data-rule` 是 v0.1.3 追加项二加的：把**命中的规则 id** 也写进 DOM。
 *
 * 两个理由：
 *   1. 诊断 —— 某一行被染成了奇怪的色，右键看一眼就知道是哪条规则干的。
 *      以前只能靠"把规则一条条注释掉再刷新"；
 *   2. 可断言 —— 浏览器侧测试能直接断言"`@@ENTRY` 是 `worldbook-entry-open`
 *      染的"，而不是含糊地"它有 heading 类"。后者在规则换实现（比如被
 *      `block-heading` 抢走）时仍然通过，等于没验。
 *
 * 与 `renderInlineHtml`（预览用）输出的 `data-rule` 语义一致，两边可以对读。
 */
function markFor(scope: string, ruleId: string): Decoration {
  return Decoration.mark({
    class: `tcs-hl tcs-hl-${scope}`,
    attributes: { 'data-rule': ruleId },
  });
}

/** 生成纯高亮装饰（不含问题标记；问题标记由 block-editor 叠加） */
export function buildHighlightRanges(
  text: string,
  compiled: CompiledHighlightRule | null,
  context: HighlightContext,
): Array<{ from: number; to: number; decoration: Decoration }> {
  if (!compiled) return [];

  const spans = computeHighlightSpans(text, compiled, context);
  return spans.map((span) => ({
    from: span.start,
    to: span.end,
    decoration: markFor(span.scope, span.ruleId),
  }));
}

/** 把若干区间按 CodeMirror 要求排序后装进 RangeSet */
export function toDecorationSet(
  ranges: Array<{ from: number; to: number; decoration: Decoration }>,
): DecorationSet {
  const sorted = [...ranges].sort((a, b) => (a.from !== b.from ? a.from - b.from : a.to - b.to));
  const builder = new RangeSetBuilder<Decoration>();
  let lastFrom = -1;
  for (const range of sorted) {
    // RangeSetBuilder 要求 from 单调不减；同位置多段允许（mark 可重叠）
    if (range.from < lastFrom || range.from >= range.to) continue;
    builder.add(range.from, range.to, range.decoration);
    lastFrom = range.from;
  }
  return builder.finish();
}

/**
 * 只读预览：把 renderInlineHtml 的结果变成可插入的真实 DOM 节点。
 * 用 DOMParser 而不是 innerHTML —— 内容虽已转义，但保留「永不写 innerHTML」的约定，
 * 让静态检查（grep innerHTML）始终为 0。
 *
 * ⚠️ 这里的循环形状是有讲究的，别改回 `while (body.firstChild) importNode(...)`。
 *
 * `document.importNode(node, true)` 是**深拷贝**：它把节点复制到当前文档，
 * 但**不会**从源文档里移除。所以如果只 append 不删除，`body.firstChild` 永远非空，
 * 循环会无限增长直到渲染进程 OOM 崩溃。
 *
 * 这正是 F8「点渲染预览后整个界面卡死」的根因（2026-10-22 定位）：
 * 界面在本机表现为「卡死、必须重启客户端」，在 headless Chrome 里表现为
 * `Abnormal renderer termination`，且崩溃前没有任何 JS 报错——因为进程是被内存吃死的，
 * try/catch 根本接不住。
 *
 * 现在改用**移动**语义：`fragment.append(...body.childNodes)` 会把节点从 body 中
 * 摘走放进 fragment（先展开成静态数组，避免边遍历边修改活集合）。
 * 既不写 innerHTML，也不会重复拷贝。
 */
export function buildPreviewFragment(
  text: string,
  compiled: CompiledHighlightRule,
  context: HighlightContext,
): DocumentFragment {
  const html = renderInlineHtml(text, compiled, context, { breakLines: true });
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const fragment = document.createDocumentFragment();
  // 展开成数组再 append：childNodes 是活集合，直接遍历会被 append 影响；
  // append 对已在文档中的节点执行的是“移动”，不是复制。
  fragment.append(...Array.from(parsed.body.childNodes));
  return fragment;
}

/**
 * 把高亮方案里的颜色/字重写成 CSS，而不是在 styles.css 里硬编码各 scope 的配色。
 *
 * 为什么要这样：配色属于**规则资产**（rules/highlight/*.json），若写死在样式表里，
 * T6.3 切换高亮方案时界面不会跟着变，且两处配色必然漂移。
 *
 * 实现用 `style.textContent`（不是 innerHTML）：内容只来自我们自己发布的规则文件，
 * 且 <style> 的 textContent 不参与 HTML 解析。
 */
export function applySchemeStyles(scheme: HighlightRuleFile): void {
  const lines: string[] = [];

  /*
   * theme **只写到内容区容器**，绝不写 `:root`（v0.1.3 / F7）。
   *
   * `.cm-host` 是 CM6 编辑器的宿主，`.preview` 是渲染预览 —— 两者都是"卡片内容"，
   * 跟随高亮方案的底色是合理的。而顶栏 / 面板 / 对话框 / 审计面板用应用自身的
   * 设计令牌（--app-fg / --panel / --border），不受任何高亮方案影响。
   *
   * v0.1.2 这里写的是 `:root{--tcs-fg:…;--tcs-bg:…}`，而界面元素又直接读这两个变量，
   * 结果是一套深色方案把整个应用外壳一起染黑 —— 看起来像"应用换主题了"，
   * 但用户只是换了高亮配色。作用域收在这里之后，那个串色路径就不存在了。
   */
  const theme = scheme.theme;
  if (theme) {
    const vars = [`--tcs-fg:${theme.foreground}`, `--tcs-bg:${theme.background}`];
    if (theme.caret) vars.push(`--tcs-caret:${theme.caret}`);
    if (theme.selectionBackground) vars.push(`--tcs-selection:${theme.selectionBackground}`);
    lines.push(`.cm-host, .preview { ${vars.join(';')} }`);
  }

  for (const scope of scheme.scopes) {
    const decls = [`color:${scope.color}`];
    if (scope.backgroundColor) decls.push(`background-color:${scope.backgroundColor}`);
    if (scope.bold) decls.push('font-weight:600');
    if (scope.italic) decls.push('font-style:italic');
    if (scope.underline) decls.push('text-decoration:underline');
    if (scope.strikethrough) decls.push('text-decoration:line-through');
    lines.push(`.tcs-hl-${scope.id}{${decls.join(';')}}`);
  }

  let styleNode = document.getElementById('tcs-scheme-style') as HTMLStyleElement | null;
  if (!styleNode) {
    styleNode = document.createElement('style');
    styleNode.id = 'tcs-scheme-style';
    document.head.append(styleNode);
  }
  styleNode.textContent = lines.join('\n');
}
