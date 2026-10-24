/**
 * 平台规则引擎（T1.3）：按解析后的规则校验卡片，产出结构化问题列表。
 * 该列表同时供编辑器实时提醒（T6.4）与审计面板（T4/T6.5）使用，两边数据完全一致。
 */

import type { AuditIssue, IssueCategory, IssueLocation } from '../audit/types.js';
import type { BlockId } from '../model/blocks.js';
import type { UnifiedCard } from '../model/unified-card.js';
import { countText, findLiteralOffsets, measure, offsetToLineColumn, lineTextAt } from '../text/count.js';
import type { ContentRule, FieldRequirement, ResolvedPlatformRule, Severity, Selector } from './platform-rule.js';
import { collectScopedTexts, normalizeSelectorList, readFieldText, type ScopedText } from './scopes.js';
import { isWorldbookScopedRule, mergeWorldbookRules } from './worldbook-checks.js';

const MAX_ISSUES_PER_RULE = 20;

function makeIssue(params: {
  ruleId: string;
  severity: Severity;
  message: string;
  hint?: string;
  blockId: BlockId | null;
  field: string | null;
  start: number | null;
  end: number | null;
  text: string;
  selector?: Selector | string;
  aggregate?: boolean;
  /** 世界书条目（T10.32）：问题要落到具体条目上，面板才能点进去 */
  entryId?: number | null;
  entryIndex?: number | null;
  category?: IssueCategory;
}): AuditIssue {
  const entryId = params.entryId ?? null;
  const entryIndex = params.entryIndex ?? null;
  // T4.4 位置契约：能定位到偏移的问题一律补出行号/列号/整行文本，供客户端「点击定位」
  const location: IssueLocation = {
    blockId: params.blockId,
    field: params.field,
    start: params.start,
    end: params.end,
    line: null,
    column: null,
  };
  if (params.start !== null && params.start >= 0) {
    const { line, column } = offsetToLineColumn(params.text, params.start);
    location.line = line;
    location.column = column;
    location.lineText = lineTextAt(params.text, params.start);
  }
  if (params.start !== null && params.end !== null && params.end > params.start) {
    location.excerpt = params.text.slice(params.start, Math.min(params.end, params.start + 80));
  }
  if (entryId !== null || entryIndex !== null) {
    location.entryId = entryId;
    if (entryId === null) location.entryIndex = entryIndex;
  }
  const issue: AuditIssue = {
    // id 里必须带条目定位：世界书每条目的 blockId/field/start 都相同，
    // 只用它们会产出重复 id，客户端按 id 做差量更新时会互相顶掉。
    id: `${params.ruleId}|${params.blockId ?? params.field ?? '-'}|${params.start ?? -1}${
      entryId !== null ? `|e${String(entryId)}` : entryIndex !== null ? `|i${String(entryIndex)}` : ''
    }`,
    ruleId: params.ruleId,
    category: params.category ?? (params.ruleId.startsWith('builtin:') ? 'completeness' : 'platform-rule'),
    severity: params.severity,
    message: params.message,
    location,
  };
  if (params.hint) issue.hint = params.hint;
  if (params.selector) issue.selector = params.selector as Selector;
  if (params.aggregate) issue.aggregate = true;
  return issue;
}

function selectorsFor(scope: Selector | Selector[]): string[] {
  return normalizeSelectorList(scope);
}

function variantList(rule: ResolvedPlatformRule, token: string): string[] {
  if (token === 'char') return rule.placeholders.char;
  if (token === 'user') return rule.placeholders.user;
  if (token.startsWith('custom:')) return rule.placeholders.custom?.[token.slice(7)] ?? [];
  return [];
}

/**
 * 跨字段条件是否满足（T10.33）。
 *
 * 条件读的是**同一条目**的原始字段：不必为「关键词为空且非常驻」造一个专用规则类型，
 * 用户也能用 `list-count` + `when` 写出同样的判据。
 */
function conditionHolds(item: ScopedText, condition: ContentRule['when']): boolean {
  if (!condition) return true;
  const entry = item.entry;
  if (!entry) return true; // 非条目 scope 不参与条目条件
  const actual = entry[condition.field];
  if (condition.equals !== undefined && actual !== condition.equals) return false;
  if (condition.notEquals !== undefined && actual === condition.notEquals) return false;
  if (condition.present === true && (actual === undefined || actual === null)) return false;
  if (condition.present === false && actual !== undefined && actual !== null) return false;
  return true;
}

/**
 * 文案占位符。`{entry}` 让同一条规则对多个条目给出可区分的话
 * （`世界书「银座」没有关键词`），否则用户只看到 5 条一模一样的提示。
 *
 * `{count}` / `{value}` 优先用调用方给的实参：同一条规则在不同类型下，
 * "数量"与"数值"的来源不同（列表项数 vs 字段文本），全靠 item 会取到错的那个。
 */
function fillMessage(template: string, item: ScopedText, value?: string | number): string {
  if (!template.includes('{')) return template;
  const text = value === undefined ? item.text : String(value);
  const count = value === undefined ? (item.listCount ?? 0) : value;
  return template
    .split('{entry}')
    .join(item.entryLabel ?? '该条目')
    .split('{count}')
    .join(String(count))
    .split('{value}')
    .join(text);
}

function checkFields(card: UnifiedCard, rule: ResolvedPlatformRule): AuditIssue[] {
  const issues: AuditIssue[] = [];

  for (const field of rule.fields) {
    const info = readFieldText(card, field.path);
    const label = field.label || field.path;
    const empty = info.isArray ? info.itemCount === 0 : info.text.trim() === '';

    if (field.required && empty) {
      // T4.2 两级语义：有 ST 缺省值的字段未写出不是缺陷，降级为 info；
      // 只有平台规范真正必填且无缺省值的字段（如 name）才算 error、阻断导出。
      const severity: Severity = field.stDefault ? 'info' : (field.severity ?? 'error');
      const message = field.stDefault
        ? (field.message ?? `${label}（${field.path}）未写出，导出时将由目标平台按缺省值处理`)
        : (field.message ?? `${label}（${field.path}）不能为空`);
      issues.push(
        makeIssue({
          ruleId: `builtin:field-required:${field.path}`,
          severity,
          message,
          ...(field.stDefault ? { hint: '该字段有规范缺省值，保留不写可减少版本 diff 噪声' } : {}),
          blockId: info.blockId,
          field: info.field,
          start: 0,
          end: 0,
          text: info.text,
        }),
      );
      continue;
    }

    if (empty) continue;

    const severity: Severity = field.severity ?? 'error';
    const length = info.isArray ? info.itemCount : countText(info.text).charsNoSpace;
    if (field.minLength !== undefined && length < field.minLength) {
      issues.push(
        makeIssue({
          ruleId: `builtin:field-min-length:${field.path}`,
          severity,
          message: field.message ?? `${label} 太短：当前 ${length}，至少需要 ${field.minLength}`,
          blockId: info.blockId,
          field: info.field,
          start: 0,
          end: Math.min(info.text.length, 1),
          text: info.text,
        }),
      );
    }
    if (field.maxLength !== undefined && length > field.maxLength) {
      issues.push(
        makeIssue({
          ruleId: `builtin:field-max-length:${field.path}`,
          severity,
          message: field.message ?? `${label} 超出上限：当前 ${length}，上限 ${field.maxLength}`,
          blockId: info.blockId,
          field: info.field,
          start: 0,
          end: Math.min(info.text.length, 1),
          text: info.text,
        }),
      );
    }
    if (field.pattern) {
      let matched = true;
      try {
        matched = new RegExp(field.pattern, (field.flags ?? '').replace(/[gy]/g, '')).test(info.text);
      } catch {
        matched = true;
      }
      if (!matched) {
        issues.push(
          makeIssue({
            ruleId: `builtin:field-pattern:${field.path}`,
            severity,
            message: field.message ?? `${label} 不符合格式要求`,
            blockId: info.blockId,
            field: info.field,
            start: 0,
            end: Math.min(info.text.length, 1),
            text: info.text,
          }),
        );
      }
    }
  }

  return issues;
}

function checkContentRule(card: UnifiedCard, rule: ResolvedPlatformRule, contentRule: ContentRule): AuditIssue[] {
  if (contentRule.enabled === false) return [];
  const issues: AuditIssue[] = [];
  const scoped = collectScopedTexts(card, contentRule.scope);

  const report = (params: {
    start: number;
    end: number;
    message?: string;
    text: string;
    item: ScopedText;
  }): void => {
    if (issues.length >= MAX_ISSUES_PER_RULE) return;
    // 世界书条目问题不给字符偏移：那个偏移是**字段值**内部的偏移，
    // 而 location.start 的语义是「板块正文内的偏移」。混用会让点击定位跳到无关位置。
    const isEntry = params.item.entryIndex !== undefined && params.item.entryIndex !== null;
    issues.push(
      makeIssue({
        ruleId: contentRule.id,
        severity: contentRule.severity,
        message: fillMessage(params.message ?? contentRule.message, params.item),
        ...(contentRule.hint ? { hint: contentRule.hint } : {}),
        ...(contentRule.category ? { category: contentRule.category } : {}),
        blockId: params.item.blockId,
        field: params.item.field,
        start: isEntry ? null : params.start,
        end: isEntry ? null : params.end,
        text: params.text,
        selector: params.item.selector,
        ...(isEntry ? { entryId: params.item.entryId ?? null, entryIndex: params.item.entryIndex ?? null } : {}),
      }),
    );
  };

  // 汇总模式：把所有 scope 文本合并统计（适用于「全文至少出现 N 次」这类平台要求）。
  // 口径要点：整条规则只产出一个问题，且不归属任何单一板块（location 全为 null、
  // aggregate 为 true），避免 UI 里出现「同一个全文问题被算到第一个板块头上」。
  if ((contentRule.type === 'placeholder-min-count' || contentRule.type === 'pattern-required') && contentRule.aggregate) {
    if (scoped.length === 0) return issues;

    let total = 0;
    if (contentRule.type === 'placeholder-min-count') {
      const variants = variantList(rule, contentRule.token);
      for (const item of scoped) {
        for (const variant of variants) total += findLiteralOffsets(item.text, variant).length;
      }
    } else {
      const flags = contentRule.flags ?? 'g';
      const regex = new RegExp(contentRule.pattern, flags.includes('g') ? flags : `${flags}g`);
      for (const item of scoped) total += (item.text.match(regex) ?? []).length;
    }

    const min = contentRule.type === 'placeholder-min-count' ? contentRule.min : (contentRule.min ?? 1);
    const max = contentRule.type === 'placeholder-min-count' ? contentRule.max : undefined;
    const overMax = max !== undefined && total > max;

    if (total < min || overMax) {
      const range = overMax ? `全文合计 ${total} 次，上限 ${max} 次` : `全文合计 ${total} 次，至少 ${min} 次`;
      issues.push(
        makeIssue({
          ruleId: contentRule.id,
          severity: contentRule.severity,
          message: `${contentRule.message}（${range}）`,
          ...(contentRule.hint ? { hint: contentRule.hint } : {}),
          blockId: null,
          field: null,
          start: null,
          end: null,
          text: '',
          aggregate: true,
        }),
      );
    }
    return issues;
  }

  for (const item of scoped) {
    if (!conditionHolds(item, contentRule.when)) continue;
    // 类型本身坏了（如 content 是数字）：由审计的结构检查报，这里跳过，
    // 否则同一处会出现"正文不是字符串"+"正文是空的"两条（去重铁律）
    if (item.valueType === 'other') continue;
    const { text } = item;
    const base = { text, item };
    switch (contentRule.type) {
      case 'placeholder-min-count': {
        const variants = variantList(rule, contentRule.token);
        let total = 0;
        const firstOffsets: number[] = [];
        for (const variant of variants) {
          const offsets = findLiteralOffsets(text, variant);
          total += offsets.length;
          for (const offset of offsets) firstOffsets.push(offset);
        }
        firstOffsets.sort((a, b) => a - b);
        if (total < contentRule.min) {
          report({ start: 0, end: Math.min(text.length, 40), ...base });
        } else if (contentRule.max !== undefined && total > contentRule.max) {
          const offset = firstOffsets[contentRule.max] ?? 0;
          report({ start: offset, end: offset + 8, ...base });
        }
        break;
      }

      case 'placeholder-forbid': {
        const variants = variantList(rule, contentRule.token);
        for (const variant of variants) {
          for (const offset of findLiteralOffsets(text, variant)) {
            report({ start: offset, end: offset + variant.length, ...base });
          }
        }
        break;
      }

      case 'pattern-forbid': {
        const flags = contentRule.flags ?? 'g';
        const regex = new RegExp(contentRule.pattern, flags.includes('g') ? flags : `${flags}g`);
        let match: RegExpExecArray | null;
        let guard = 0;
        while ((match = regex.exec(text)) !== null && guard < MAX_ISSUES_PER_RULE) {
          guard += 1;
          const start = match.index;
          const end = start + match[0].length;
          report({ start, end, ...base });
          if (match[0].length === 0) regex.lastIndex += 1;
        }
        break;
      }

      case 'pattern-required': {
        const flags = contentRule.flags ?? 'g';
        const regex = new RegExp(contentRule.pattern, flags.includes('g') ? flags : `${flags}g`);
        let count = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
          count += 1;
          if (match[0].length === 0) regex.lastIndex += 1;
        }
        if (count < (contentRule.min ?? 1)) {
          report({ start: 0, end: Math.min(text.length, 40), ...base });
        }
        break;
      }

      case 'length': {
        const unit = contentRule.unit ?? 'char';
        const value = unit === 'word' ? countText(text).totalWords : measure(text, unit);
        if (contentRule.min !== undefined && value < contentRule.min) {
          report({
            start: 0,
            end: Math.min(text.length, 40),
            message: `${contentRule.message}（当前 ${value}，至少 ${contentRule.min}）`,
            ...base,
          });
        } else if (contentRule.max !== undefined && value > contentRule.max) {
          report({
            start: 0,
            end: Math.min(text.length, 40),
            message: `${contentRule.message}（当前 ${value}，上限 ${contentRule.max}）`,
            ...base,
          });
        }
        break;
      }

      case 'non-empty': {
        if (text.trim() === '') report({ start: 0, end: 0, ...base });
        break;
      }

      case 'number-range': {
        // 数值字段的判据是**数值**，不是文本长度。缺失时只在 required 才报。
        const value = item.numberValue ?? null;
        if (value === null) {
          if (contentRule.required === true) {
            report({ start: 0, end: 0, message: `${contentRule.message}（字段缺失）`, ...base });
          }
          break;
        }
        if (contentRule.min !== undefined && value < contentRule.min) {
          report({
            start: 0,
            end: 0,
            message: `${contentRule.message}（当前 ${String(value)}，下限 ${String(contentRule.min)}）`,
            ...base,
          });
        } else if (contentRule.max !== undefined && value > contentRule.max) {
          report({
            start: 0,
            end: 0,
            message: `${contentRule.message}（当前 ${String(value)}，上限 ${String(contentRule.max)}）`,
            ...base,
          });
        }
        break;
      }

      case 'list-count': {
        // 项数走 listCount：拿 join 后的文本量长度会把"3 个单字关键词"与"1 个长关键词"判成一样
        const count = item.listCount ?? 0;
        if (contentRule.min !== undefined && count < contentRule.min) {
          report({
            start: 0,
            end: 0,
            message: `${fillMessage(contentRule.message, item, count)}（当前 ${String(count)} 项，至少 ${String(contentRule.min)} 项）`,
            ...base,
          });
        } else if (contentRule.max !== undefined && count > contentRule.max) {
          report({
            start: 0,
            end: 0,
            message: `${fillMessage(contentRule.message, item, count)}（当前 ${String(count)} 项，上限 ${String(contentRule.max)} 项）`,
            ...base,
          });
        }
        break;
      }

      case 'list-no-blank-items': {
        // 空项的隐蔽性：空串会匹配一切输入，等于让条目常驻，而 JSON 与导出都看不出异常
        const list = item.listValues ?? [];
        const blanks = list.filter((entry) => typeof entry !== 'string' || entry.trim() === '').length;
        if (blanks > 0) {
          report({
            start: 0,
            end: 0,
            message: `${fillMessage(contentRule.message, item, blanks)}（当前 ${String(blanks)} 个空项）`,
            ...base,
          });
        }
        break;
      }

      case 'forbidden-words': {
        const haystack = contentRule.caseSensitive ? text : text.toLowerCase();
        for (const word of contentRule.words) {
          const needle = contentRule.caseSensitive ? word : word.toLowerCase();
          let index = haystack.indexOf(needle);
          while (index !== -1 && issues.length < MAX_ISSUES_PER_RULE) {
            report({ start: index, end: index + word.length, ...base });
            index = haystack.indexOf(needle, index + Math.max(1, needle.length));
          }
        }
        break;
      }

      default:
        break;
    }
  }

  return issues;
}

export function validateCard(card: UnifiedCard, rule: ResolvedPlatformRule): AuditIssue[] {
  const issues = [...checkFields(card, rule)];
  for (const contentRule of rule.rules) {
    // 世界书**条目域**规则不在这里跑（T10.33 去重铁律）：
    // 它们需要「默认规则集 + 用户规则」合并后逐条目求值，唯一的入口是
    // validateWorldbookRules（由 checkWorldbookFormat 调用）。
    // 若这里也跑一遍，用户写的每条世界书规则都会产出两份问题 ——
    // 实测就是 `mine:depth-range` 在同一审计里出现两次。
    if (isWorldbookScopedRule(contentRule)) continue;
    issues.push(...checkContentRule(card, rule, contentRule));
  }
  issues.sort((a, b) => {
    const blockA = a.location.blockId ?? '';
    const blockB = b.location.blockId ?? '';
    if (blockA !== blockB) return blockA < blockB ? -1 : 1;
    const startA = a.location.start ?? -1;
    const startB = b.location.start ?? -1;
    return startA - startB;
  });
  return issues;
}

/**
 * 只跑「世界书条目」这一类规则（T10.33）。
 *
 * 合并顺序：内置默认集 → 当前平台规则里声明的同域规则（同 id 覆盖、`enabled:false` 禁用、
 * 新 id 追加）。这样"内置检查"与"用户规则"是**同一套求值代码、同一份问题列表**，
 * 不存在两处各报一半或同一违规报两遍。
 */
export function validateWorldbookRules(card: UnifiedCard, rule: ResolvedPlatformRule): AuditIssue[] {
  const issues: AuditIssue[] = [];
  for (const contentRule of mergeWorldbookRules(rule.rules)) {
    issues.push(...checkContentRule(card, rule, contentRule));
  }
  return issues;
}

/** 校验并汇总 */
export function summarizeIssues(issues: AuditIssue[]): { error: number; warning: number; info: number; exportable: boolean } {
  const summary = { error: 0, warning: 0, info: 0, exportable: true };
  for (const issue of issues) {
    summary[issue.severity] += 1;
    if (issue.severity === 'error') summary.exportable = false;
  }
  return summary;
}

/** 仅返回某个板块的问题（编辑器左侧标记用） */
export function issuesByBlock(issues: AuditIssue[]): Map<BlockId, AuditIssue[]> {
  const map = new Map<BlockId, AuditIssue[]>();
  for (const issue of issues) {
    const blockId = issue.location.blockId;
    if (!blockId) continue;
    const list = map.get(blockId) ?? [];
    list.push(issue);
    map.set(blockId, list);
  }
  return map;
}

export type { FieldRequirement };
