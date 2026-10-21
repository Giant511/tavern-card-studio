/**
 * 单个板块的 CodeMirror 6 编辑器封装。
 *
 * 职责边界：
 *   · 只负责「一段文本 + 一组装饰」的编辑与呈现；
 *   · 不认识卡片、不认识审计、不认识面板；
 *   · 折叠时由调用方 `destroy()`，保证隐藏板块不进 DOM。
 */

import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  keymap,
  type DecorationSet,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import type { BlockId, CompiledHighlightRule } from '@tcs/shared';

import { buildHighlightRanges, toDecorationSet } from './highlight';

/** 审计问题在编辑器里的投影（位置是**板块内**的码元偏移） */
export interface EditorIssue {
  id: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  start: number | null;
  end: number | null;
}

const EMPTY_ISSUES: readonly EditorIssue[] = [];

const setIssuesEffect = StateEffect.define<readonly EditorIssue[]>();

const issueField = StateField.define<readonly EditorIssue[]>({
  create: () => EMPTY_ISSUES,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setIssuesEffect)) return effect.value;
    }
    return value;
  },
});

function buildDecorations(
  view: EditorView,
  compiled: CompiledHighlightRule | null,
  blockId: BlockId,
): DecorationSet {
  const text = view.state.doc.toString();
  const ranges = buildHighlightRanges(text, compiled, { blockId });

  for (const issue of view.state.field(issueField)) {
    if (issue.start === null || issue.end === null) continue;
    const from = Math.max(0, Math.min(issue.start, text.length));
    const to = Math.max(from, Math.min(issue.end, text.length));
    if (from >= to) continue;
    ranges.push({
      from,
      to,
      decoration: Decoration.mark({
        class: `tcs-issue tcs-issue-${issue.severity}`,
        attributes: { title: issue.message },
      }),
    });
  }

  return toDecorationSet(ranges);
}

function decorationExtension(compiled: CompiledHighlightRule | null, blockId: BlockId): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, compiled, blockId);
      }

      update(update: { view: EditorView; docChanged: boolean; transactions: readonly { effects: readonly StateEffect<unknown>[] }[] }): void {
        const issuesChanged = update.transactions.some((tr) =>
          tr.effects.some((effect) => effect.is(setIssuesEffect)),
        );
        if (update.docChanged || issuesChanged) {
          this.decorations = buildDecorations(update.view, compiled, blockId);
        }
      }
    },
    { decorations: (value) => value.decorations },
  );

  return [issueField, plugin];
}

const baseTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, Consolas, "Cascadia Mono", monospace',
    lineHeight: '1.65',
  },
  '.cm-content': { padding: '10px 0' },
  '.cm-line': { padding: '0 12px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftWidth: '2px' },
});

export interface BlockEditorOptions {
  parent: HTMLElement;
  text: string;
  blockId: BlockId;
  compiled: CompiledHighlightRule | null;
  /** 文档变化（已去掉装饰影响） */
  onChange: (text: string) => void;
}

export class BlockEditor {
  readonly view: EditorView;
  private readonly compiled: CompiledHighlightRule | null;

  constructor(options: BlockEditorOptions) {
    this.compiled = options.compiled;

    const extensions: Extension[] = [
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      keymap.of([...defaultKeymap, ...historyKeymap]),
      baseTheme,
      decorationExtension(this.compiled, options.blockId),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          options.onChange(update.state.doc.toString());
        }
      }),
    ];

    this.view = new EditorView({
      parent: options.parent,
      state: EditorState.create({ doc: options.text, extensions }),
    });
  }

  getText(): string {
    return this.view.state.doc.toString();
  }

  /** 更新问题标记（重新校验后调用；传空数组即全部清除） */
  setIssues(issues: readonly EditorIssue[]): void {
    this.view.dispatch({ effects: setIssuesEffect.of(issues) });
  }

  /** 定位并选中某段（问题列表点击时用），同时滚动到视口中央 */
  focusRange(start: number | null, end: number | null): void {
    const length = this.view.state.doc.length;
    const from = Math.max(0, Math.min(start ?? 0, length));
    const to = Math.max(from, Math.min(end ?? from, length));
    this.view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
    });
    this.view.focus();
  }

  destroy(): void {
    this.view.destroy();
  }
}
