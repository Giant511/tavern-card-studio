/**
 * 审计结果模型（T4.4）：编辑区实时提醒与审计面板共用同一套问题数据。
 *
 * 位置契约（客户端「点击定位」消费方）：
 *   每条问题都带 location，其中 blockId / field / start / end / line / column 一律**显式给出**，
 *   无法定位时写 null（而不是省略键）——客户端不需要处理 undefined，拿到 null 就显示「全文」。
 *   - blockId + start/end：定位到板块正文内的字符区间（编辑器直接 setSelectionRange）；
 *   - line / column：同一区间的行号列号（1-based），用于面板里显示「第 3 行第 7 列」；
 *   - field：不属于板块的字段级问题（如 name / first_mes / character_book）；
 *   - entryId：世界书问题指向的具体条目。
 */

import type { BlockId } from '../model/blocks.js';
import type { Severity, Selector } from '../rules/platform-rule.js';

export const AUDIT_REPORT_SCHEMA_VERSION = 1 as const;

export type IssueCategory = 'completeness' | 'format' | 'platform-rule' | 'structure';

export interface IssueLocation {
  /** 所属板块；不属于任何板块时为 null（如 meta 字段、全文合计） */
  blockId: BlockId | null;
  /** 所属 ST 字段（如 first_mes / alternate_greetings[0]）；板块内文本为 null */
  field: string | null;
  /** 文本偏移（相对于该板块 text），无法定位时为 null */
  start: number | null;
  end: number | null;
  /** 1-based 行号（相对板块正文）；无法定位时为 null */
  line: number | null;
  /** 1-based 列号（按码点计）；无法定位时为 null */
  column: number | null;
  /** 命中原文片段，便于 UI 展示 */
  excerpt?: string;
  /** 命中所在行的整行文本，UI 可整行高亮 */
  lineText?: string;
  /** 世界书条目 id；非世界书问题为 null */
  entryId?: number | null;
}

export interface AuditIssue {
  /** 稳定 id：同一问题在多次审计中保持一致，便于 UI 做「修正即消失」的差量更新 */
  id: string;
  /** 产生该问题的规则 id（内置检查使用 builtin:<name>） */
  ruleId: string;
  category: IssueCategory;
  severity: Severity;
  message: string;
  hint?: string;
  location: IssueLocation;
  /** 触发该问题的选择器，便于按板块聚合 */
  selector?: Selector;
  /**
   * 是否为全文合计口径的问题（规则里写了 `"aggregate": true`）。
   * 这类问题不对应单一板块，`location` 的 blockId / field / start / end / line / column 全为 null，
   * UI 应显示在「全文」分组而不是某个板块下。
   */
  aggregate?: boolean;
}

/** 单个板块的字数统计（T4.1） */
export interface BlockWordCount {
  blockId: BlockId;
  /** 板块中文名 */
  label: string;
  /** 原始字符数（含空白） */
  chars: number;
  /** 不含空白字符数 */
  charsNoSpace: number;
  /** 中日韩字符数 */
  cjk: number;
  /** 拉丁词数 */
  words: number;
  /** 字符数口径的总词数 = cjk + words */
  totalWords: number;
  /** 正文是否为空（trim 后） */
  empty: boolean;
  /** 导入源中根本没有该板块标题（宽松模式填充的空块；UI 必须显式标记） */
  missing: boolean;
}

export interface WordCountTotal {
  chars: number;
  charsNoSpace: number;
  cjk: number;
  words: number;
  totalWords: number;
}

export interface WordCountReport {
  /** 六个板块各自的字数（顺序同 BLOCK_IDS） */
  blocks: BlockWordCount[];
  /** 六板块合计 */
  total: WordCountTotal;
  /**
   * 按落盘字段口径的合计（与平台长度规则同一口径）：
   * description = 除性格外五板块之和，personality = 性格，character_book = 世界书条目。
   */
  byField: {
    description: WordCountTotal;
    personality: WordCountTotal;
    character_book: WordCountTotal;
  };
}

export interface AuditSummary {
  error: number;
  warning: number;
  info: number;
  /** 是否可导出（无 error 级问题） */
  exportable: boolean;
}

export interface AuditReport {
  /** 报告结构版本（AUDIT_REPORT_SCHEMA_VERSION） */
  schemaVersion: typeof AUDIT_REPORT_SCHEMA_VERSION;
  /** 审计时间（ISO 8601） */
  generatedAt: string;
  /** 被审计卡片的标识信息 */
  card: {
    name: string;
    spec: string;
    specVersion: string;
    /** 导入来源（文件路径 / 服务端 id），新建为空串 */
    source: string;
  };
  /** 使用的平台规则 */
  platformRule: {
    id: string | null;
    name?: string;
    version?: string;
    /** 继承链，如 ["sillytavern","ccv2"] */
    lineage?: string[];
  };
  /** 使用的 TXT 预设 */
  presetId: string | null;
  wordCount: WordCountReport;
  issues: AuditIssue[];
  summary: AuditSummary;
  /** 各类别计数（面板 tab 徽标用） */
  byCategory: Record<IssueCategory, number>;
}
