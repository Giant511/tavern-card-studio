/**
 * T4.4 结构化审计报告。
 *
 * 一份报告同时供三处消费：
 *   · 编辑器实时提醒（按板块取自己那几条）；
 *   · 审计面板（按严重级/类别分组）；
 *   · 导出前拦截（只看 summary.exportable）。
 *
 * 报告是纯 JSON（无函数、无 Map），可直接落盘、可跨进程传（服务端 T5.3 复用同一份实现）。
 */

import { BLOCK_IDS } from '../model/blocks.js';
import type { UnifiedCard } from '../model/unified-card.js';
import type { ResolvedPlatformRule } from '../rules/platform-rule.js';
import { summarizeIssues, validateCard } from '../rules/platform-rule-engine.js';
import type { TxtPreset } from '../format/preset.js';
import { AUDIT_REPORT_SCHEMA_VERSION } from './types.js';
import type { AuditIssue, AuditReport, IssueCategory } from './types.js';
import { checkFormat } from './format.js';
import { countCardWords } from './word-count.js';

const CATEGORIES: readonly IssueCategory[] = ['completeness', 'format', 'platform-rule', 'structure'];

export interface AuditOptions {
  /** 平台规则（不给则跳过「内容是否符合平台规则」这一路） */
  platformRule?: ResolvedPlatformRule | null;
  /** TXT 预设（不给则跳过「TXT 分块是否符合预设」这一路） */
  preset?: TxtPreset | null;
  /** 原始 JSON 文本（给了就额外验证其可解析性） */
  rawJsonText?: string | null;
  /** 是否产出「有 ST 缺省值但未写出」的 info 提示，默认 true */
  includeStDefaults?: boolean;
  /** 审计时间戳注入点（测试用，保证报告可复现） */
  now?: () => string;
}

function countByCategory(issues: readonly AuditIssue[]): Record<IssueCategory, number> {
  const counts = Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as Record<IssueCategory, number>;
  for (const issue of issues) counts[issue.category] = (counts[issue.category] ?? 0) + 1;
  return counts;
}

/** 问题排序：板块顺序 → 严重级 → 偏移，保证面板里顺序稳定 */
const SEVERITY_RANK: Readonly<Record<string, number>> = { error: 0, warning: 1, info: 2 };

export function sortIssues(issues: readonly AuditIssue[]): AuditIssue[] {
  return [...issues].sort((a, b) => {
    const blockA = a.location.blockId ? BLOCK_IDS.indexOf(a.location.blockId) : 99;
    const blockB = b.location.blockId ? BLOCK_IDS.indexOf(b.location.blockId) : 99;
    if (blockA !== blockB) return blockA - blockB;
    const severityDelta = (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3);
    if (severityDelta !== 0) return severityDelta;
    const startA = a.location.start ?? -1;
    const startB = b.location.start ?? -1;
    if (startA !== startB) return startA - startB;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * 组装审计报告。
 * 三个来源：平台规则（T4.2 + 平台内容规则）、格式检查（T4.3）、字数统计（T4.1）。
 */
export function buildAuditReport(card: UnifiedCard, options: AuditOptions = {}): AuditReport {
  const issues: AuditIssue[] = [];

  if (options.platformRule) {
    issues.push(...validateCard(card, options.platformRule));
  }
  issues.push(
    ...checkFormat(card, {
      preset: options.preset ?? null,
      rawJsonText: options.rawJsonText ?? null,
      includeStDefaults: options.includeStDefaults,
    }),
  );

  const sorted = sortIssues(issues);

  return {
    schemaVersion: AUDIT_REPORT_SCHEMA_VERSION,
    generatedAt: options.now ? options.now() : new Date().toISOString(),
    card: {
      name: card.meta?.name ?? '',
      spec: card.meta?.spec ?? '',
      specVersion: card.meta?.specVersion ?? '',
      source: card.source?.origin ?? '',
    },
    platformRule: {
      id: options.platformRule?.id ?? null,
      ...(options.platformRule?.name ? { name: options.platformRule.name } : {}),
      ...(options.platformRule?.version ? { version: options.platformRule.version } : {}),
      ...(options.platformRule?.lineage ? { lineage: [...options.platformRule.lineage] } : {}),
    },
    presetId: options.preset?.id ?? null,
    wordCount: countCardWords(card),
    issues: sorted,
    summary: summarizeIssues(sorted),
    byCategory: countByCategory(sorted),
  };
}

/** 报告 → 带缩进的 JSON 文本（落盘/传输用） */
export function stringifyAuditReport(report: AuditReport, indent = 2): string {
  return JSON.stringify(report, null, indent);
}

/** 只保留某严重级及以上（面板筛选） */
export function filterBySeverity(issues: readonly AuditIssue[], min: 'error' | 'warning' | 'info'): AuditIssue[] {
  const threshold = SEVERITY_RANK[min] ?? 0;
  return issues.filter((issue) => (SEVERITY_RANK[issue.severity] ?? 3) <= threshold);
}
