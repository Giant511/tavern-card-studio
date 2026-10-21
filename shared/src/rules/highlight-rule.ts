/**
 * 「语法高亮规则 JSON」类型定义（T0.5）。
 * 与 rules/schema/highlight-rule.schema.json 一一对应。
 *
 * 匹配优先级（详见 docs/03-highlight-rule-spec.md）：
 *   1. 所有规则按 priority 降序排序（同 priority 按声明顺序）；
 *   2. 依次尝试匹配，已着色区间不再被低优先级规则覆盖；
 *   3. 同 priority 下更长的匹配优先。
 */

import type { Selector } from './platform-rule.js';

/** 一条高亮样式的定义 */
export interface HighlightScope {
  id: string;
  label: string;
  /** 文字颜色，#RGB / #RRGGBB */
  color: string;
  /** 背景色，null 表示不高亮背景 */
  backgroundColor?: string | null;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

export type MatchSpec =
  /** 正则匹配；wholeLine=true 时命中整行 */
  | { type: 'regex'; pattern: string; flags?: string; wholeLine?: boolean }
  /** 关键字列表匹配（按字面量，非正则） */
  | { type: 'word-list'; words: string[]; caseSensitive?: boolean; wholeWord?: boolean }
  /** 行首前缀匹配（用于标题、列表项） */
  | { type: 'line-prefix'; prefix: string }
  /** 成对分隔符包裹的区块（用于 {{...}}、【...】、<tag>...</tag>） */
  | { type: 'delimiter-block'; open: string; close: string; escape?: string };

export interface HighlightRule {
  id: string;
  /** 引用 scopes[].id */
  scope: string;
  match: MatchSpec;
  /** 数值越大越优先，默认 0 */
  priority?: number;
  /** 仅对指定板块生效，缺省为全部 */
  appliesTo?: Selector[];
  enabled?: boolean;
}

export interface EditorTypography {
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  tabSize?: number;
}

export interface HighlightTheme {
  foreground: string;
  background: string;
  caret?: string;
  selectionBackground?: string;
}

export interface HighlightRuleFile {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  /** 继承的规则集 id；null 表示不继承 */
  extends?: string | null;
  editor?: EditorTypography;
  theme: HighlightTheme;
  scopes: HighlightScope[];
  rules: HighlightRule[];
  metadata?: {
    author?: string;
    homepage?: string;
    license?: string;
    updatedAt?: string;
  };
}

/** 解析后的高亮规则集（合并 extends 后） */
export interface ResolvedHighlightRule extends HighlightRuleFile {
  /** 实际继承链，从根到自身 */
  lineage: string[];
}

/** 高亮计算产出的着色片段 */
export interface HighlightSpan {
  start: number;
  end: number;
  scope: string;
  ruleId: string;
}
