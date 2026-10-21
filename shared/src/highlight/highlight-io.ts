/**
 * 高亮规则 JSON 的导入 / 导出（T3.3）。
 *
 * 三条约束：
 *   1. 导出**字段顺序固定**（schemaVersion → id → name → …），便于版本 diff 与人工比对；
 *   2. 导入失败**不破坏当前高亮**：返回 file=null 与具体错误，由 `applyHighlightRuleImport` 保留旧方案；
 *   3. 导入即校验，校验口径与运行时加载完全一致（`parseHighlightRule`），不存在「能导入但不能用」。
 */

import type { HighlightRuleFile } from '../rules/highlight-rule.js';
import { parseHighlightRule } from '../rules/highlight-rule-parser.js';

export interface HighlightImportResult {
  file: HighlightRuleFile | null;
  errors: string[];
  warnings: string[];
  ok: boolean;
}

export interface HighlightApplyResult {
  /** 生效的规则集：导入失败时为传入的 current（原样不动） */
  file: HighlightRuleFile | null;
  /** 是否真的替换了 */
  replaced: boolean;
  errors: string[];
  warnings: string[];
  ok: boolean;
}

const TOP_KEY_ORDER = [
  'schemaVersion',
  'id',
  'name',
  'version',
  'description',
  'extends',
  'editor',
  'theme',
  'scopes',
  'rules',
  'metadata',
] as const;

const SCOPE_KEY_ORDER = ['id', 'label', 'color', 'backgroundColor', 'bold', 'italic', 'underline', 'strikethrough'] as const;
const RULE_KEY_ORDER = ['id', 'scope', 'priority', 'match', 'appliesTo', 'enabled'] as const;
const EDITOR_KEY_ORDER = ['fontFamily', 'fontSize', 'lineHeight', 'tabSize'] as const;
const THEME_KEY_ORDER = ['foreground', 'background', 'caret', 'selectionBackground'] as const;

function orderKeys(source: Record<string, unknown>, order: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of order) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  // 未知键原样保留在末尾，避免导出丢掉扩展字段
  for (const key of Object.keys(source)) {
    if (!(key in result)) result[key] = source[key];
  }
  return result;
}

function normalizeForExport(file: HighlightRuleFile): Record<string, unknown> {
  const source = file as unknown as Record<string, unknown>;
  const ordered = orderKeys(source, TOP_KEY_ORDER);

  if (Array.isArray(source['scopes'])) {
    ordered['scopes'] = (source['scopes'] as Record<string, unknown>[]).map((scope) => orderKeys(scope, SCOPE_KEY_ORDER));
  }
  if (Array.isArray(source['rules'])) {
    ordered['rules'] = (source['rules'] as Record<string, unknown>[]).map((rule) => {
      const next = orderKeys(rule, RULE_KEY_ORDER);
      const match = rule['match'];
      if (match && typeof match === 'object') {
        // match 先放 type，其余字段按原顺序（各类型专属字段互不冲突）
        next['match'] = orderKeys(match as Record<string, unknown>, ['type']);
      }
      return next;
    });
  }
  if (source['editor'] && typeof source['editor'] === 'object') {
    ordered['editor'] = orderKeys(source['editor'] as Record<string, unknown>, EDITOR_KEY_ORDER);
  }
  if (source['theme'] && typeof source['theme'] === 'object') {
    ordered['theme'] = orderKeys(source['theme'] as Record<string, unknown>, THEME_KEY_ORDER);
  }
  return ordered;
}

/** 导出为格式化 JSON 文本（2 空格缩进，尾随换行，字段顺序固定） */
export function exportHighlightRuleText(file: HighlightRuleFile, indent = 2): string {
  return `${JSON.stringify(normalizeForExport(file), null, indent)}\n`;
}

/** 导入并校验：任何错误都返回 file=null，绝不返回半成品 */
export function importHighlightRuleText(text: string): HighlightImportResult {
  const raw = typeof text === 'string' ? text.replace(/^\uFEFF/, '') : '';
  if (raw.trim() === '') {
    return { file: null, errors: ['内容为空'], warnings: [], ok: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { file: null, errors: [`JSON 解析失败 — ${(error as Error).message}`], warnings: [], ok: false };
  }

  const result = parseHighlightRule(parsed);
  if (!result.file) {
    return { file: null, errors: result.errors, warnings: result.warnings, ok: false };
  }
  return { file: result.file, errors: [], warnings: result.warnings, ok: true };
}

/**
 * 导入并替换当前方案。导入失败时原样返回 current（replaced=false），
 * 保证「导入失败不破坏当前高亮」。
 */
export function applyHighlightRuleImport(
  current: HighlightRuleFile | null,
  text: string,
): HighlightApplyResult {
  const imported = importHighlightRuleText(text);
  if (!imported.ok || !imported.file) {
    return { file: current, replaced: false, errors: imported.errors, warnings: imported.warnings, ok: false };
  }
  return { file: imported.file, replaced: true, errors: [], warnings: imported.warnings, ok: true };
}

/** 从文件对象导出（编辑器「另存为」直接落盘用） */
export function exportHighlightRuleFile(file: HighlightRuleFile, indent = 2): string {
  return exportHighlightRuleText(file, indent);
}
