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

/** 每个 scope 一个 mark 类，样式在 styles.css 里定义 */
function markFor(scope: string): Decoration {
  return Decoration.mark({ class: `tcs-hl tcs-hl-${scope}` });
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
    decoration: markFor(span.scope),
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
 */
export function buildPreviewFragment(
  text: string,
  compiled: CompiledHighlightRule,
  context: HighlightContext,
): DocumentFragment {
  const html = renderInlineHtml(text, compiled, context, { breakLines: true });
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const fragment = document.createDocumentFragment();
  const body = parsed.body;
  while (body.firstChild) {
    fragment.append(document.importNode(body.firstChild, true));
  }
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

  const theme = scheme.theme;
  if (theme) {
    lines.push(`:root{--tcs-fg:${theme.foreground};--tcs-bg:${theme.background};}`);
    if (theme.caret) lines.push(`:root{--tcs-caret:${theme.caret};}`);
    if (theme.selectionBackground) {
      lines.push(`:root{--tcs-selection:${theme.selectionBackground};}`);
    }
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
