/**
 * 审计面板的视图模型（T6.5）——纯逻辑，无 DOM，可在 Node 里单测。
 *
 * 面板要做的事：过滤、分组、排序、字数分布换算。
 * 这些都是「输入报告 → 输出可渲染结构」，与界面无关，所以单独一层。
 * UI 层（audit-panel.ts）只负责把这里的结果画成节点。
 */

import {
  BLOCK_DEFINITIONS,
  type AuditIssue,
  type AuditReport,
  type BlockId,
  type IssueCategory,
  type Severity,
} from '@tcs/shared';

export const SEVERITY_LABELS: Record<Severity, string> = {
  error: '错误',
  warning: '警告',
  info: '提示',
};

export const CATEGORY_LABELS: Record<IssueCategory, string> = {
  completeness: '完整性',
  format: '格式',
  'platform-rule': '平台规则',
  structure: '结构',
};

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** 面板过滤条件 */
export interface AuditFilter {
  /** 严重度筛选；空集合 = 不筛 */
  severities: ReadonlySet<Severity>;
  /** 类别筛选；空集合 = 不筛 */
  categories: ReadonlySet<IssueCategory>;
  /** 板块筛选；'all' = 不筛，null = 只看不属于任何板块（全文级） */
  blockId: BlockId | 'all' | null;
  /** 搜索关键字（匹配 message / hint / 命中文本），空串 = 不筛 */
  query: string;
}

export const EMPTY_FILTER: AuditFilter = {
  severities: new Set<Severity>(),
  categories: new Set<IssueCategory>(),
  blockId: 'all',
  query: '',
};

export function filterIssues(issues: readonly AuditIssue[], filter: AuditFilter): AuditIssue[] {
  const query = filter.query.trim().toLowerCase();

  return issues.filter((issue) => {
    if (filter.severities.size > 0 && !filter.severities.has(issue.severity)) return false;
    if (filter.categories.size > 0 && !filter.categories.has(issue.category)) return false;

    if (filter.blockId !== 'all') {
      if (filter.blockId === null) {
        if (issue.location.blockId !== null) return false;
      } else if (issue.location.blockId !== filter.blockId) {
        return false;
      }
    }

    if (query !== '') {
      const haystack = [issue.message, issue.hint ?? '', issue.location.excerpt ?? '', issue.location.lineText ?? '']
        .join('\n')
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }

    return true;
  });
}

export function sortIssues(issues: readonly AuditIssue[]): AuditIssue[] {
  return [...issues].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;

    // 同一严重度内按板块顺序，再把全文级（blockId=null）放最后
    const blockOrder = (issue: AuditIssue): number => {
      if (issue.location.blockId === null) return BLOCK_DEFINITIONS.length;
      const index = BLOCK_DEFINITIONS.findIndex((def) => def.id === issue.location.blockId);
      return index === -1 ? BLOCK_DEFINITIONS.length : index;
    };
    const byBlock = blockOrder(a) - blockOrder(b);
    if (byBlock !== 0) return byBlock;

    return (a.location.start ?? Number.MAX_SAFE_INTEGER) - (b.location.start ?? Number.MAX_SAFE_INTEGER);
  });
}

export interface IssueGroup {
  key: string;
  /** 分组标题（板块名 / 类别名 / 「全文」） */
  title: string;
  /** 该组内最高严重度，用于标题徽标配色 */
  worstSeverity: Severity | null;
  issues: AuditIssue[];
}

export type GroupMode = 'block' | 'category' | 'none';

/**
 * 分组。'block' 模式下「不属于任何板块」的问题单独成一组并排在最后，
 * 因为它们是全文口径（如总字数、字段缺失），与具体板块无关。
 */
export function groupIssues(issues: readonly AuditIssue[], mode: GroupMode): IssueGroup[] {
  if (mode === 'none') {
    return [{ key: 'all', title: '全部问题', worstSeverity: worstOf(issues), issues: [...issues] }];
  }

  const buckets = new Map<string, IssueGroup>();

  for (const issue of issues) {
    let key: string;
    let title: string;

    if (mode === 'category') {
      key = issue.category;
      title = CATEGORY_LABELS[issue.category] ?? issue.category;
    } else if (issue.location.blockId === null) {
      key = '__global__';
      title = '全文';
    } else {
      key = issue.location.blockId;
      title =
        BLOCK_DEFINITIONS.find((def) => def.id === issue.location.blockId)?.label ??
        issue.location.blockId;
    }

    const existing = buckets.get(key);
    if (existing) {
      existing.issues.push(issue);
      existing.worstSeverity = worseOf(existing.worstSeverity, issue.severity);
    } else {
      buckets.set(key, { key, title, worstSeverity: issue.severity, issues: [issue] });
    }
  }

  const groups = [...buckets.values()];

  if (mode === 'block') {
    const order = new Map<string, number>(BLOCK_DEFINITIONS.map((def, index) => [def.id, index]));
    groups.sort((a, b) => {
      const ai = order.has(a.key) ? order.get(a.key)! : Number.MAX_SAFE_INTEGER;
      const bi = order.has(b.key) ? order.get(b.key)! : Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });
  } else {
    // 类别模式：按严重度权重排，把问题最多的组放前
    groups.sort((a, b) => {
      const sa = SEVERITY_ORDER[a.worstSeverity ?? 'info'];
      const sb = SEVERITY_ORDER[b.worstSeverity ?? 'info'];
      if (sa !== sb) return sa - sb;
      return b.issues.length - a.issues.length;
    });
  }

  return groups;
}

function worseOf(current: Severity | null, next: Severity): Severity {
  if (current === null) return next;
  return SEVERITY_ORDER[next] < SEVERITY_ORDER[current] ? next : current;
}

function worstOf(issues: readonly AuditIssue[]): Severity | null {
  let worst: Severity | null = null;
  for (const issue of issues) worst = worseOf(worst, issue.severity);
  return worst;
}

/** 严重度计数（用于筛选按钮上的数字） */
export function countBySeverity(issues: readonly AuditIssue[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) counts[issue.severity] += 1;
  return counts;
}

/** 各类别计数（用报告自带的 byCategory；缺省时按 issues 现算） */
export function countByCategory(report: AuditReport): Record<IssueCategory, number> {
  const base: Record<IssueCategory, number> = {
    completeness: 0,
    format: 0,
    'platform-rule': 0,
    structure: 0,
  };
  for (const [key, value] of Object.entries(report.byCategory ?? {})) {
    if (key in base && typeof value === 'number') base[key as IssueCategory] = value;
  }
  return base;
}

export interface WordBar {
  blockId: BlockId;
  label: string;
  chars: number;
  /** 相对最大值的百分比（0–100），用于画条形 */
  percent: number;
  /** 占六板块合计的百分比（0–100，保留 1 位小数） */
  share: number;
}

/**
 * 字数分布。用的是报告里的 blocks（六板块，顺序同 BLOCK_IDS）。
 * percent 相对**最大值**而非合计：小板块占比个位数时条形会看不见，
 * 相对最大值更容易看出差异；share 则给读者真实占比。
 */
export function buildWordBars(report: AuditReport): WordBar[] {
  const blocks = report.wordCount?.blocks ?? [];
  const max = blocks.reduce((acc, block) => Math.max(acc, block.chars), 0);
  const total = report.wordCount?.total?.chars ?? 0;

  return blocks.map((block) => ({
    blockId: block.blockId,
    label: block.label,
    chars: block.chars,
    percent: max === 0 ? 0 : Math.round((block.chars / max) * 100),
    share: total === 0 ? 0 : Number(((block.chars / total) * 100).toFixed(1)),
  }));
}

/** 顶部一行摘要：如「错误 2 · 警告 5 · 提示 3 · 不可导出」 */
export function summaryText(report: AuditReport): string {
  const { error, warning, info, exportable } = report.summary;
  const parts = [`错误 ${error}`, `警告 ${warning}`, `提示 ${info}`];
  parts.push(exportable ? '可导出' : '不可导出');
  return parts.join(' · ');
}

/**
 * 面板状态（筛选后）的整体描述，给状态栏用。
 * 与 summaryText 的区别：这个反映"当前筛选"，含过滤掉的条数。
 */
export function filterSummary(total: number, shown: number): string {
  if (shown === total) return `共 ${total} 条`;
  return `筛出 ${shown} / ${total} 条`;
}
