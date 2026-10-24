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
 *   "worldbook:entries[].name" → 世界书**每个条目**的某个字段（T10.32 语义轨）
 * 数组表示「任一命中即生效」。
 *
 * 为什么世界书要用 `entries[].field` 这种看起来像代码的写法：
 * 世界书的核心校验对象是**条目**，不是整段文本。「条目名必填」「关键词至少 2 个」
 * 「触发深度在 0..10」都必须逐条判定并把问题定位到具体条目；`field:character_book`
 * 只能拿到拼接后的整段 TXT，既算不出条目数，也没法告诉用户是第几条坏了。
 *
 * 可寻址的世界书字段见 `WORLDBOOK_SELECTABLE_FIELDS`（与 worldbook-preset 的字段表同源）。
 */

import type { BlockId } from '../model/blocks.js';
import type { IssueCategory } from '../audit/types.js';

export type Severity = 'error' | 'warning' | 'info';

/** 世界书条目里可被规则寻址的字段 */
export const WORLDBOOK_SELECTABLE_FIELDS = [
  'name',
  'keys',
  'secondary_keys',
  'content',
  'comment',
  'position',
  'insertion_order',
  'priority',
  'depth',
  'constant',
  'enabled',
  'selective',
  'case_sensitive',
] as const;

export type WorldbookField = (typeof WORLDBOOK_SELECTABLE_FIELDS)[number];

export type Selector =
  | '*'
  | `block:${BlockId}`
  | `field:${string}`
  | `worldbook:entries[].${WorldbookField}`;

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

/**
 * 同一条目内跨字段的条件（T10.33）。
 *
 * 「关键词为空且不是常驻 → 永不触发」「开了 selective 却没有次级关键词」
 * 这两条判据都跨两个字段。没有条件能力的话，只能给每种组合造一个专用规则类型；
 * 有了它，`list-count` + `when` 就能表达，用户也能自己写出同样的组合。
 */
export interface RuleCondition {
  /** 条目字段名（worldbook scope 用） */
  field: string;
  /** 字段值必须严格等于它 |
   */
  equals?: string | number | boolean;
  /** 字段值必须不等于它（用于 constant 缺省 = false 的语义） */
  notEquals?: string | number | boolean;
  /** true = 字段必须存在；false = 字段必须不存在 */
  present?: boolean;
}

interface BaseContentRule {
  id: string;
  /** 人类可读说明，会出现在问题列表中；支持 {entry} / {count} / {value} 占位符 */
  message: string;
  scope: Selector | Selector[];
  severity: Severity;
  enabled?: boolean;
  /** 修复建议（展示给用户，不做自动替换） */
  hint?: string;
  /**
   * 问题归属的审计类别（T10.33）。
   *
   * 世界书条目校验必须显示在审计面板的「世界书」分组下，否则用户会在
   * 「平台规则」里看到一堆「条目 3 没有关键词」，却不知道说的是世界书。
   * 缺省按规则 id 推（`builtin:` 前缀 → completeness，其余 → platform-rule）。
   */
  category?: IssueCategory;
  /** 同一 scope 内的跨字段条件（见 RuleCondition） */
  when?: RuleCondition;
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

/**
 * 数值范围（T10.32）。作用于 `worldbook:entries[].insertion_order` / `.priority` /
 * `.depth` 这类数值字段。
 *
 * 为什么不用现成的 `length`：那规则量的是**文本长度**，而触发深度是数字语义。
 * 硬拿 length 套，用户得把「越界」写成"字数不够"，提示语必然对不上。
 *
 * `required: false`（默认）：字段缺失不报 —— 缺失该由 `non-empty` 或 fields 检查负责，
 * 否则同一条目上会同时冒出「没有触发深度」和「触发深度越界」两个问题。
 */
export interface NumberRangeRule extends BaseContentRule {
  type: 'number-range';
  min?: number;
  max?: number;
  /** true 时字段缺失/非数值也报问题 */
  required?: boolean;
}

/**
 * 列表项数（T10.32）。作用于 `worldbook:entries[].keys` / `.secondary_keys`。
 *
 * 「关键词至少 2 个」用 `length` 量的是 `keys.join(', ')` 的字符数 ——
 * 3 个单字关键词和 1 个长关键词可能长度相同，判据直接是错的。
 */
export interface ListCountRule extends BaseContentRule {
  type: 'list-count';
  min?: number;
  max?: number;
}

/**
 * 列表里不允许空项（T10.33）。
 *
 * 「空关键词」在世界书里是个隐蔽坑：`keys: ["", "银座"]` 中的空串会匹配**一切输入**，
 * 等于让条目常驻，而 JSON 和导出结果都看不出异常。
 * 用 `list-count` 表达不了（项数是 2，没错），用 `pattern-forbid` 也表达不了
 * （拼接后的文本里空项表现为两个相邻逗号，正则会误伤合法值）。
 */
export interface ListNoBlankItemsRule extends BaseContentRule {
  type: 'list-no-blank-items';
}

export type ContentRule =
  | PlaceholderCountRule
  | PlaceholderForbidRule
  | PatternForbidRule
  | PatternRequiredRule
  | LengthRule
  | NonEmptyRule
  | ForbiddenWordsRule
  | NumberRangeRule
  | ListCountRule
  | ListNoBlankItemsRule;

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
