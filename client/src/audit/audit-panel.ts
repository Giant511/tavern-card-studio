/**
 * 审计面板（T6.5）。
 *
 * 结构：
 *   ┌ 摘要（等级计数，可点击当筛选器）
 *   ├ 筛选条（严重度 / 类别 / 板块 / 关键字）
 *   ├ 字数分布（八板块条形 + 合计，顺序同 BLOCK_IDS）
 *   └ 问题列表（按板块或类别分组；每条可点击定位）
 *
 * 约束：
 *   · 位置信息**只消费**报告里的 location（blockId/line/column/start/end），
 *     这里不做任何"从文本反推偏移"的计算；
 *   · 渲染只走 textContent / createElement，不用 innerHTML（见 validate 第 11 项）；
 *   · 视图模型（过滤/分组/排序/字数）在 audit-model.ts，本文件只管画。
 */

import type { AuditIssue, AuditReport, BlockId, IssueCategory, Severity } from '@tcs/shared';
import { BLOCK_DEFINITIONS } from '@tcs/shared';

import {
  CATEGORY_LABELS,
  EMPTY_FILTER,
  SEVERITY_LABELS,
  buildWordBars,
  countByCategory,
  countBySeverity,
  filterIssues,
  filterSummary,
  groupIssues,
  sortIssues,
  type AuditFilter,
  type GroupMode,
} from './audit-model';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface AuditPanelOptions {
  /** 点击某条问题（定位到板块内偏移） */
  onLocate: (issue: AuditIssue) => void;
  /** 点击板块行（展开并聚焦该板块） */
  onFocusBlock?: (blockId: BlockId) => void;
}

/**
 * 板块筛选下拉的选项。
 *
 * **从 `BLOCK_DEFINITIONS` 派生，不在这里再抄一份板块表**：这三行曾是客户端里
 * 第三份板块清单副本（`block-doc.ts` 两份 + 这里一份），加板块时它不会报错，
 * 表现只是「审计面板筛不到新板块的问题」—— 用户会以为新板块没有审计。
 *
 * 顺序即 `BLOCK_IDS`（世界书在最后）。首尾两个非板块选项单独拼。
 */
const BLOCK_FILTER_OPTIONS: Array<{ value: BlockId | 'all' | null; label: string }> = [
  { value: 'all', label: '全部板块' },
  ...BLOCK_DEFINITIONS.map((definition) => ({ value: definition.id as BlockId, label: definition.label })),
  { value: null, label: '仅全文级' },
];

/**
 * 筛选条里的类别顺序 = 报告里「按来源分组」的顺序。
 *
 * `worldbook`（T10.9）放在最后：它是最具体的一路，用户排查时通常先看
 * 「完整性」和「格式」，世界书条目问题属于局部细节。
 */
const CATEGORIES: IssueCategory[] = ['completeness', 'format', 'platform-rule', 'structure', 'worldbook'];

export class AuditPanel {
  private readonly root: HTMLElement;
  private readonly summaryEl: HTMLElement;
  private readonly filterBar: HTMLElement;
  private readonly wordSection: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly countEl: HTMLElement;
  /** 计数行（"审计 N 条"）。必须留引用：clear() 后要靠 ensureMounted() 把它挂回去 */
  private readonly listHead: HTMLElement;

  private report: AuditReport | null = null;
  private filter: AuditFilter = { ...EMPTY_FILTER };
  private groupMode: GroupMode = 'block';
  private activeIssueId: string | null = null;

  constructor(
    private readonly options: AuditPanelOptions,
    mount: HTMLElement,
  ) {
    this.root = mount;

    // 摘要
    this.summaryEl = el('div', 'audit-summary');
    // 筛选条
    this.filterBar = el('div', 'audit-filters');
    // 字数分布
    this.wordSection = el('div', 'audit-words');
    // 计数 + 列表
    this.listHead = el('div', 'audit-list-head');
    this.countEl = el('span', 'audit-count', '—');
    this.listHead.append(this.countEl);
    this.listEl = el('div', 'audit-list');

    this.root.append(this.summaryEl, this.filterBar, this.wordSection, this.listHead, this.listEl);
    this.renderFilters();
  }

  /** 设置新报告并重绘（编辑后由 app 调用） */
  setReport(report: AuditReport): void {
    this.report = report;
    this.render();
  }

  /**
   * 确保五个区块挂在容器里。
   *
   * 为什么需要它：`clear()` 曾经用 `root.replaceChildren()` 把容器清空，但
   * 五个区块的**引用还在这个类里**——它们只是脱离了 DOM。之后 `render()`
   * 照常往这些游离节点写内容，于是「数据在、计数在、正文永远是空白」，
   * 控制台一声不响（F6，2026-10-23 复现：容器 0 子节点、report 里 8 条问题）。
   *
   * `clear()` 已经改成只清内容，但这个自愈函数保留：面板容器的清空可能来自
   * 任何一处（样式重置、未来的空态重绘），而"渲染写进游离节点"这种故障
   * 完全静默，靠测试很难兜住所有入口。挂载是幂等的，代价只有一次比较。
   */
  private ensureMounted(): void {
    if (this.root.childElementCount === 0) {
      this.root.append(this.summaryEl, this.filterBar, this.wordSection, this.listHead, this.listEl);
    }
  }

  /**
   * 清空面板（零标签 / 空工作台时用）。
   *
   * 为什么单独一个方法而不是 `setReport(null)`：这里表达的是"当前没有正在审计
   * 的卡"，与"审计完了、0 条问题"是两种不同状态（后者要有空态文案）。
   *
   * **不要用 `root.replaceChildren()` 实现"清空"。** 那样摘掉的是五个区块本身，
   * 而它们的引用仍留在本类里；后续 `render()` 会继续往这些脱离 DOM 的节点写，
   * 界面就永远空白且不报错（F6 事故）。清内容、不清结构。
   */
  clear(): void {
    this.report = null;
    this.activeIssueId = null;
    this.ensureMounted();

    this.summaryEl.className = 'audit-summary';
    this.summaryEl.textContent = '尚未审计（未打开角色卡）';
    this.wordSection.replaceChildren();
    this.listEl.replaceChildren();
    this.countEl.textContent = '—';
    // 筛选条要重建：它的按钮既承载计数，也是后续 renderFilterCounts 的定位点，
    // 只清空不重建的话，下次 setReport 时计数就更新不动了。
    this.renderFilters();
  }

  /** 外部要求聚焦某条问题（例如从编辑器跳过来） */
  setActiveIssue(issueId: string | null): void {
    this.activeIssueId = issueId;
    this.renderList();
  }

  getFilter(): AuditFilter {
    return this.filter;
  }

  // ── 筛选条 ───────────────────────────────────────────────
  private renderFilters(): void {
    this.filterBar.replaceChildren();

    // 严重度：紧凑的分段按钮
    const severityRow = el('div', 'filter-row');
    severityRow.append(el('span', 'filter-label', '等级'));
    for (const severity of ['error', 'warning', 'info'] as Severity[]) {
      const button = el('button', `chip chip-${severity}`);
      button.type = 'button';
      button.dataset['severity'] = severity;
      const dot = el('span', `dot ${severity}`);
      const text = el('span', 'chip-text', SEVERITY_LABELS[severity]);
      const count = el('span', 'chip-count', '0');
      button.append(dot, text, count);
      button.addEventListener('click', () => {
        const next = new Set(this.filter.severities);
        if (next.has(severity)) next.delete(severity);
        else next.add(severity);
        this.filter = { ...this.filter, severities: next };
        this.render();
      });
      severityRow.append(button);
    }
    this.filterBar.append(severityRow);

    // 类别
    const categoryRow = el('div', 'filter-row');
    categoryRow.append(el('span', 'filter-label', '类别'));
    for (const category of CATEGORIES) {
      const button = el('button', 'chip chip-category');
      button.type = 'button';
      button.dataset['category'] = category;
      const text = el('span', 'chip-text', CATEGORY_LABELS[category]);
      const count = el('span', 'chip-count', '0');
      button.append(text, count);
      button.addEventListener('click', () => {
        const next = new Set(this.filter.categories);
        if (next.has(category)) next.delete(category);
        else next.add(category);
        this.filter = { ...this.filter, categories: next };
        this.render();
      });
      categoryRow.append(button);
    }
    this.filterBar.append(categoryRow);

    // 板块 + 分组 + 搜索
    const controlRow = el('div', 'filter-row');

    const blockSelect = el('select', 'select') as HTMLSelectElement;
    blockSelect.dataset['role'] = 'block-filter';
    for (const option of BLOCK_FILTER_OPTIONS) {
      const node = el('option');
      node.value = option.value === null ? '__global__' : option.value;
      node.textContent = option.label;
      blockSelect.append(node);
    }
    blockSelect.value = 'all';
    blockSelect.addEventListener('change', () => {
      const raw = blockSelect.value;
      this.filter = {
        ...this.filter,
        blockId: raw === '__global__' ? null : (raw as BlockId | 'all'),
      };
      this.render();
    });
    controlRow.append(blockSelect);

    const groupSelect = el('select', 'select') as HTMLSelectElement;
    groupSelect.dataset['role'] = 'group-mode';
    for (const [value, label] of [
      ['block', '按板块分组'],
      ['category', '按类别分组'],
      ['none', '不分组'],
    ] as Array<[GroupMode, string]>) {
      const node = el('option');
      node.value = value;
      node.textContent = label;
      groupSelect.append(node);
    }
    groupSelect.value = this.groupMode;
    groupSelect.addEventListener('change', () => {
      this.groupMode = groupSelect.value as GroupMode;
      this.renderList();
    });
    controlRow.append(groupSelect);

    this.filterBar.append(controlRow);

    // 搜索
    const searchRow = el('div', 'filter-row');
    const search = el('input', 'input search') as HTMLInputElement;
    search.type = 'search';
    search.placeholder = '搜索问题内容…';
    search.dataset['role'] = 'search';
    search.addEventListener('input', () => {
      this.filter = { ...this.filter, query: search.value };
      this.render();
    });
    const reset = el('button', 'btn ghost small', '重置');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      this.filter = { ...EMPTY_FILTER };
      search.value = '';
      blockSelect.value = 'all';
      this.render();
    });
    searchRow.append(search, reset);
    this.filterBar.append(searchRow);
  }

  // ── 渲染主流程 ────────────────────────────────────────────
  private render(): void {
    // 先自愈挂载，再写内容：写进游离节点是静默失败，控制台没有任何提示。
    this.ensureMounted();

    if (this.report === null) {
      this.summaryEl.className = 'audit-summary';
      this.summaryEl.textContent = '尚未审计（未打开角色卡）';
      return;
    }

    this.renderSummary();
    this.renderFilterCounts();
    this.renderWords();
    this.renderList();
  }

  private renderSummary(): void {
    const report = this.report!;
    const { error, warning, info, exportable } = report.summary;

    this.summaryEl.replaceChildren();
    this.summaryEl.className = `audit-summary ${error > 0 ? 'bad' : warning > 0 ? 'warn' : 'ok'}`;

    const line = el('div', 'summary-line');
    line.append(
      el('span', `summary-item ${error > 0 ? 'bad' : ''}`, `错误 ${error}`),
      el('span', `summary-item ${warning > 0 ? 'warn' : ''}`, `警告 ${warning}`),
      el('span', 'summary-item', `提示 ${info}`),
      el('span', `summary-badge ${exportable ? 'ok' : 'bad'}`, exportable ? '可导出' : '不可导出'),
    );
    this.summaryEl.append(line);
    // 只保留字数（等级计数已在上面的 line 里，不再重复一次）
    this.summaryEl.append(
      el('div', 'summary-meta', `八板块合计 ${report.wordCount.total.chars} 字符 / ${report.wordCount.total.totalWords} 字`),
    );
  }

  private renderFilterCounts(): void {
    const report = this.report!;
    const severityCounts = countBySeverity(report.issues);
    const categoryCounts = countByCategory(report);

    for (const button of this.filterBar.querySelectorAll<HTMLButtonElement>('.chip')) {
      const severity = button.dataset['severity'] as Severity | undefined;
      const category = button.dataset['category'] as IssueCategory | undefined;
      const countNode = button.querySelector('.chip-count');
      let active = false;

      if (severity) {
        if (countNode) countNode.textContent = String(severityCounts[severity] ?? 0);
        active = this.filter.severities.has(severity);
      } else if (category) {
        if (countNode) countNode.textContent = String(categoryCounts[category] ?? 0);
        active = this.filter.categories.has(category);
      }

      button.classList.toggle('active', active);
    }
  }

  private renderWords(): void {
    const report = this.report!;
    const bars = buildWordBars(report);

    this.wordSection.replaceChildren();
    const head = el('div', 'words-head');
    head.append(
      el('span', 'words-title', '字数分布'),
      el(
        'span',
        'words-total',
        `合计 ${report.wordCount.total.chars} 字符 / ${report.wordCount.total.totalWords} 字`,
      ),
    );
    this.wordSection.append(head);

    const chart = el('div', 'words-chart');
    for (const bar of bars) {
      const row = el('button', 'word-row');
      row.type = 'button';
      row.dataset['blockId'] = bar.blockId;
      row.title = `点击定位到「${bar.label}」`;

      const label = el('span', 'word-label', bar.label);
      const track = el('span', 'word-track');
      const fill = el('span', 'word-fill');
      fill.style.width = `${bar.percent}%`;
      track.append(fill);
      const value = el('span', 'word-value', `${bar.chars}（${bar.share}%）`);

      row.append(label, track, value);
      row.addEventListener('click', () => this.options.onFocusBlock?.(bar.blockId));
      chart.append(row);
    }
    this.wordSection.append(chart);

    /*
     * 三个"按写入字段统计"的字数（与平台长度规则同一口径，容易和"八板块合计"混淆，
     * 所以单列）。
     *
     * 标签必须是**中文界面名**，不能直接印 `description` / `personality` /
     * `character_book`：这三个是导出文件里的键名，用户在自己写的卡里从来没见过它们，
     * 摆一排英文只会让人猜"这是我哪一段"。
     */
    const byField = report.wordCount.byField;
    const fieldRow = el('div', 'words-fields');
    fieldRow.append(el('span', 'words-fields-title', '各字段字数'));
    fieldRow.append(
      el('span', 'words-field', `角色设定 ${byField.description.totalWords}`),
      el('span', 'words-field', `性格 ${byField.personality.totalWords}`),
      el('span', 'words-field', `世界书 ${byField.character_book.totalWords}`),
    );
    this.wordSection.append(fieldRow);
  }

  private renderList(): void {
    const report = this.report;
    if (!report) return;

    const filtered = filterIssues(report.issues, this.filter);
    const sorted = sortIssues(filtered);
    this.countEl.textContent = filterSummary(report.issues.length, sorted.length);

    this.listEl.replaceChildren();

    if (sorted.length === 0) {
      const empty = el(
        'p',
        'issue-empty',
        report.issues.length === 0 ? '当前平台规则下未发现问题' : '没有符合筛选条件的问题',
      );
      this.listEl.append(empty);
      return;
    }

    for (const group of groupIssues(sorted, this.groupMode)) {
      const section = el('section', 'audit-group');
      const head = el('div', `group-head ${group.worstSeverity ?? 'info'}`);
      head.append(
        el('span', 'group-title', group.title),
        el('span', 'group-count', String(group.issues.length)),
      );
      section.append(head);

      for (const issue of group.issues) {
        section.append(this.renderIssue(issue));
      }
      this.listEl.append(section);
    }
  }

  private renderIssue(issue: AuditIssue): HTMLElement {
    const item = el('button', `issue ${issue.severity}`);
    item.type = 'button';
    item.dataset['issueId'] = issue.id;
    if (issue.id === this.activeIssueId) item.classList.add('active');

    const head = el('span', 'issue-head');
    head.append(el('span', `dot ${issue.severity}`));
    // 位置：行号优先（人能对上），列号补充（便于精确判断）
    const position: string[] = [];
    if (issue.location.line !== null) position.push(`第 ${issue.location.line} 行`);
    if (issue.location.column !== null) position.push(`第 ${issue.location.column} 列`);
    // 没有任何位置信息（aggregate 或 blockId=null）时也要给一句话，
    // 否则头部只剩一个圆点，看起来像渲染坏了。
    if (position.length === 0) position.push(issue.aggregate ? '全文统计' : '全文');
    head.append(el('span', 'issue-pos', position.join(' ')));
    head.append(el('span', 'issue-rule', issue.ruleId));
    item.append(head);

    item.append(el('span', 'issue-msg', issue.message));

    if (issue.hint) item.append(el('span', 'issue-hint', issue.hint));

    if (issue.location.lineText && issue.location.lineText.trim() !== '') {
      const code = el('code', 'issue-line');
      code.textContent = issue.location.lineText.trim();
      item.append(code);
    }

    item.addEventListener('click', () => {
      this.setActiveIssue(issue.id);
      this.options.onLocate(issue);
    });

    return item;
  }
}
