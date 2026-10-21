/**
 * 「平台规则 JSON」类型定义（T0.4）。
 * 与 rules/schema/platform-rule.schema.json 一一对应，任何字段变更必须同步两处。
 *
 * 作用域选择器（scope / selector）语法：
 *   "*"                     → 全部文本板块
 *   "block:basic"           → 指定板块（basic/personality/settings/special/user/worldbook）
 *   "field:first_mes"       → 指定 SillyTavern 原生字段（name/description/personality/
 *                             scenario/first_mes/mes_example/creator_notes/system_prompt/
 *                             post_history_instructions/alternate_greetings/character_book）
 * 数组表示「任一命中即生效」。
 */

import type { BlockId } from '../model/blocks.js';

export type Severity = 'error' | 'warning' | 'info';

export type Selector = '*' | `block:${BlockId}` | `field:${string}`;

export type PlaceholderKey = 'char' | 'user' | `custom:${string}`;

/** 字段完整性要求 */
export interface FieldRequirement {
  /** ST 原生字段名，或模型路径（meta.name / meta.creator / meta.tags / meta.creatorNotes） */
  path: string;
  label: string;
  required: boolean;
  minLength?: number;
  maxLength?: number;
  /** 正则（ECMAScript），不符即报问题 */
  pattern?: string;
  flags?: string;
  severity?: Severity;
  message?: string;
  /**
   * 该字段在目标规范里**有缺省值**（T4.2 两级语义）。
   * true 时「字段未写出」不报 error，最多 info 级提示——缺省语义由 SillyTavern 运行时补齐，
   * 把它算成 error 会在版本 diff 里制造噪声，也违背「解析端不注入缺省值」的约定。
   * 例如世界书条目的 constant / insertion_order。角色名 name 这类无缺省值的字段必须为 false。
   */
  stDefault?: boolean;
}

interface BaseContentRule {
  id: string;
  /** 人类可读说明，会出现在问题列表中 */
  message: string;
  scope: Selector | Selector[];
  severity: Severity;
  enabled?: boolean;
  /** 修复建议（展示给用户，不做自动替换） */
  hint?: string;
}

export interface PlaceholderCountRule extends BaseContentRule {
  type: 'placeholder-min-count';
  /** 引用 placeholders 中的键 */
  token: PlaceholderKey;
  min: number;
  max?: number;
  /** true=把所有 scope 文本合并统计（默认逐块统计） */
  aggregate?: boolean;
}

export interface PlaceholderForbidRule extends BaseContentRule {
  type: 'placeholder-forbid';
  token: PlaceholderKey;
}

export interface PatternForbidRule extends BaseContentRule {
  type: 'pattern-forbid';
  pattern: string;
  flags?: string;
}

export interface PatternRequiredRule extends BaseContentRule {
  type: 'pattern-required';
  pattern: string;
  flags?: string;
  /** 至少出现次数，默认 1 */
  min?: number;
  /** true=把所有 scope 文本合并统计（默认逐块统计） */
  aggregate?: boolean;
}

export interface LengthRule extends BaseContentRule {
  type: 'length';
  min?: number;
  max?: number;
  /** 计数单位：char=字符数（不含空白），word=词数；默认 char */
  unit?: 'char' | 'word';
}

export interface NonEmptyRule extends BaseContentRule {
  type: 'non-empty';
}

export interface ForbiddenWordsRule extends BaseContentRule {
  type: 'forbidden-words';
  words: string[];
  caseSensitive?: boolean;
}

export type ContentRule =
  | PlaceholderCountRule
  | PlaceholderForbidRule
  | PatternForbidRule
  | PatternRequiredRule
  | LengthRule
  | NonEmptyRule
  | ForbiddenWordsRule;

export type ContentRuleType = ContentRule['type'];

/** 自动适配操作：切换平台时由 T1.4 执行（需用户确认） */
export type AutoFixOp =
  | {
      type: 'replace-text';
      ruleId?: string;
      scope?: Selector | Selector[];
      from: string;
      to: string;
      caseSensitive?: boolean;
    }
  | {
      type: 'replace-regex';
      ruleId?: string;
      scope?: Selector | Selector[];
      pattern: string;
      flags?: string;
      replacement: string;
    }
  | {
      type: 'trim';
      ruleId?: string;
      scope?: Selector | Selector[];
    };

export interface PlatformTarget {
  /** 导出时使用哪一版 ST 规范 */
  spec: 'v1' | 'v2' | 'v3' | 'any';
  specVersion?: string;
}

export interface PlatformRuleFile {
  schemaVersion: 1;
  /** 唯一标识，自定义规则需保证不与他人冲突 */
  id: string;
  name: string;
  version: string;
  description?: string;
  /** 继承的规则 id；null 表示从零定义 */
  extends?: string | null;
  target: PlatformTarget;
  placeholders: {
    /** 角色占位符的所有合法写法，第一个为主写法 */
    char: string[];
    /** 用户占位符的所有合法写法，第一个为主写法 */
    user: string[];
    /** 其他自定义占位符（如 {{scenario}}），键为自定义名 */
    custom?: Record<string, string[]>;
  };
  fields: FieldRequirement[];
  rules: ContentRule[];
  autoFix?: AutoFixOp[];
  metadata?: {
    author?: string;
    homepage?: string;
    license?: string;
    updatedAt?: string;
  };
}

/** 解析后的规则（合并 extends 后） */
export interface ResolvedPlatformRule extends PlatformRuleFile {
  /** 实际继承链，从根到自身 */
  lineage: string[];
  /** 占位符展开后的查询表：写法 → 键 */
  placeholderLookup: Record<string, PlaceholderKey>;
}
