/**
 * 审计问题的构造与消费工具（T4.4）。
 *
 * 「点击定位」契约：每条问题都带完整 location（blockId / field / start / end / line / column），
 * 无法定位的维度写 null，绝不省略键。客户端拿到即可以直接跳转，不需要二次计算。
 */

import { BLOCK_DEFINITION_MAP } from '../model/blocks.js';
import type { BlockId } from '../model/blocks.js';
import type { Severity, Selector } from '../rules/platform-rule.js';
import { lineTextAt, offsetToLineColumn } from '../text/count.js';
import type { AuditIssue, IssueCategory, IssueLocation } from './types.js';

/** 字段中文名（面板显示用） */
export const FIELD_LABELS: Readonly<Record<string, string>> = {
  file: '文件',
  name: '角色名',
  creator: '作者',
  creator_notes: '作者备注',
  character_version: '角色版本',
  tags: '标签',
  description: 'description',
  personality: '性格',
  scenario: '场景',
  first_mes: '开场白',
  mes_example: '示例对话',
  system_prompt: '系统提示',
  post_history_instructions: '历史后指令',
  alternate_greetings: '备选开场白',
  group_only_greetings: '群聊开场白',
  character_book: '世界书',
  nickname: '昵称',
};

export function fieldLabel(field: string | null): string {
  if (!field) return '—';
  return FIELD_LABELS[field] ?? field;
}

export function blockLabel(blockId: BlockId | null): string {
  if (!blockId) return '—';
  return BLOCK_DEFINITION_MAP[blockId]?.label ?? blockId;
}

export interface MakeAuditIssueParams {
  ruleId: string;
  category: IssueCategory;
  severity: Severity;
  message: string;
  hint?: string;
  blockId?: BlockId | null;
  field?: string | null;
  start?: number | null;
  end?: number | null;
  /** 定位所依据的文本（板块正文或字段文本）；给了 start 就必须给 */
  text?: string;
  /**
   * 显式行号（无法给出字符偏移时使用，如世界书 TXT 的语法错误只知道行号）。
   * 给了 start 时优先用 start 换算，本项忽略。
   */
  line?: number | null;
  column?: number | null;
  excerpt?: string;
  entryId?: number | null;
  /** 世界书条目序号（条目没有 id 时的定位手段） */
  entryIndex?: number | null;
  aggregate?: boolean;
  selector?: string;
}

export function makeAuditIssue(params: MakeAuditIssueParams): AuditIssue {
  const blockId = params.blockId ?? null;
  const field = params.field ?? null;
  const start = params.start ?? null;
  const end = params.end ?? null;
  const text = params.text ?? '';

  const location: IssueLocation = {
    blockId,
    field,
    start,
    end,
    line: null,
    column: null,
  };

  if (start !== null && start >= 0) {
    const { line, column } = offsetToLineColumn(text, start);
    location.line = line;
    location.column = column;
    location.lineText = lineTextAt(text, start);
  } else if (params.line !== null && params.line !== undefined) {
    location.line = params.line;
    location.column = params.column ?? 1;
  }
  if (params.excerpt !== undefined) location.excerpt = params.excerpt;
  else if (start !== null && end !== null && end > start) location.excerpt = text.slice(start, Math.min(end, start + 80));
  if (params.entryId !== undefined) location.entryId = params.entryId;
  if (params.entryIndex !== undefined && params.entryIndex !== null) location.entryIndex = params.entryIndex;

  const issue: AuditIssue = {
    // 世界书问题必须把条目定位拼进 id：同一条规则在同一板块上对多个条目产出问题时，
    // 只有 ruleId|blockId|start 会让它们撞成同一个 id，客户端做「差量更新」时会互相顶掉。
    id: `${params.ruleId}|${blockId ?? field ?? '-'}|${start ?? -1}${
      location.entryId !== undefined && location.entryId !== null
        ? `|e${String(location.entryId)}`
        : location.entryIndex !== undefined && location.entryIndex !== null
          ? `|i${String(location.entryIndex)}`
          : ''
    }`,
    ruleId: params.ruleId,
    category: params.category,
    severity: params.severity,
    message: params.message,
    location,
  };
  if (params.hint) issue.hint = params.hint;
  if (params.selector) issue.selector = params.selector as Selector;
  if (params.aggregate) issue.aggregate = true;
  return issue;
}

/** 面板里的位置文案，如「其他设定 · 第 3 行第 7 列」「开场白」「全文」 */
export function describeIssueLocation(issue: AuditIssue): string {
  const { location } = issue;
  if (issue.aggregate || (location.blockId === null && location.field === null)) return '全文';
  if (location.blockId) {
    const label = blockLabel(location.blockId);
    if (location.line !== null && location.column !== null) return `${label} · 第 ${location.line} 行第 ${location.column} 列`;
    return label;
  }
  return fieldLabel(location.field);
}

export interface IssueGroups {
  /** 按板块分组（只含能定位到板块的问题） */
  byBlock: Map<BlockId, AuditIssue[]>;
  /** 字段级问题（不属于任何板块，如 name / first_mes） */
  byField: Map<string, AuditIssue[]>;
  /** 全文级问题（aggregate 或无法归属） */
  unscoped: AuditIssue[];
}

export function groupIssues(issues: readonly AuditIssue[]): IssueGroups {
  const byBlock = new Map<BlockId, AuditIssue[]>();
  const byField = new Map<string, AuditIssue[]>();
  const unscoped: AuditIssue[] = [];

  for (const issue of issues) {
    const blockId = issue.location.blockId;
    if (blockId) {
      const list = byBlock.get(blockId) ?? [];
      list.push(issue);
      byBlock.set(blockId, list);
      continue;
    }
    const field = issue.location.field;
    if (field) {
      const list = byField.get(field) ?? [];
      list.push(issue);
      byField.set(field, list);
      continue;
    }
    unscoped.push(issue);
  }

  return { byBlock, byField, unscoped };
}
