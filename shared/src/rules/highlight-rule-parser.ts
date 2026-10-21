/**
 * 语法高亮规则文件的加载、校验与继承合并（T3.1）。
 *
 * 与平台规则保持同一套做法：运行时做轻量结构校验（不依赖 Ajv，离线安装包不必带它），
 * 命令行侧 `scripts/validate-rules.mjs` 仍用 Ajv 按 JSON Schema 做完整校验。
 *
 * 校验分三层：
 *   1. 结构：必填字段、类型、取值区间、id 命名；
 *   2. 语义：scope 引用存在、正则可编译、选择器语法、id 唯一；
 *   3. 继承：extends 目标存在、不成环、合并后 scope 引用仍可解析。
 */

import type {
  EditorTypography,
  HighlightRule,
  HighlightRuleFile,
  HighlightScope,
  HighlightTheme,
  MatchSpec,
  ResolvedHighlightRule,
} from './highlight-rule.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SCOPE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const COLOR_PATTERN = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|[a-zA-Z]{3,20})$/;
const FLAGS_PATTERN = /^[gimsu]*$/;
const SELECTOR_PATTERN = /^(\*|block:(basic|personality|settings|special|user|worldbook)|field:[a-z_]+)$/;
const MATCH_TYPES = new Set(['regex', 'word-list', 'line-prefix', 'delimiter-block']);

export interface HighlightParseResult {
  file: HighlightRuleFile | null;
  errors: string[];
  /** 不阻断加载，但值得在 UI 上提示（如空关键字、可疑颜色） */
  warnings: string[];
}

export interface HighlightLoadResult {
  rules: HighlightRuleFile[];
  errors: { index: number; id: string | null; errors: string[] }[];
  warnings: { index: number; id: string | null; warnings: string[] }[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isColor(value: unknown): boolean {
  return typeof value === 'string' && COLOR_PATTERN.test(value);
}

function checkRegex(errors: string[], where: string, pattern: string, flags?: string): void {
  try {
    new RegExp(pattern, (flags ?? '').replace(/[gy]/g, ''));
  } catch (error) {
    errors.push(`${where}: 正则无法编译 — ${(error as Error).message}`);
  }
}

function validateEditor(errors: string[], editor: unknown): void {
  if (!isObject(editor)) {
    errors.push('editor 必须是对象');
    return;
  }
  const ranges: [string, number, number][] = [
    ['fontSize', 8, 48],
    ['lineHeight', 1, 3],
    ['tabSize', 1, 8],
  ];
  for (const [key, min, max] of ranges) {
    const value = editor[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`editor.${key} 必须是数字`);
    } else if (value < min || value > max) {
      errors.push(`editor.${key} 需在 ${min}..${max} 之间（当前 ${value}）`);
    }
  }
  if (editor['tabSize'] !== undefined && typeof editor['tabSize'] === 'number' && !Number.isInteger(editor['tabSize'])) {
    errors.push('editor.tabSize 必须是整数');
  }
  if (editor['fontFamily'] !== undefined && typeof editor['fontFamily'] !== 'string') {
    errors.push('editor.fontFamily 必须是字符串');
  }
}

function validateTheme(errors: string[], theme: unknown): void {
  if (!isObject(theme)) {
    errors.push('theme 必须是对象');
    return;
  }
  for (const key of ['foreground', 'background']) {
    if (!isColor(theme[key])) errors.push(`theme.${key} 必须是合法颜色值（#RGB / #RRGGBB / rgba() / 颜色名）`);
  }
  for (const key of ['caret', 'selectionBackground']) {
    if (theme[key] !== undefined && !isColor(theme[key])) {
      errors.push(`theme.${key} 必须是合法颜色值`);
    }
  }
}

function validateScope(errors: string[], warnings: string[], index: number, scope: unknown): void {
  const where = `scopes[${index}]`;
  if (!isObject(scope)) {
    errors.push(`${where}: 必须是对象`);
    return;
  }
  const id = scope['id'];
  if (typeof id !== 'string' || !SCOPE_ID_PATTERN.test(id)) errors.push(`${where}: id 不合法`);
  if (typeof scope['label'] !== 'string' || scope['label'] === '') errors.push(`${where}: 缺少 label`);
  if (!isColor(scope['color'])) errors.push(`${where}: color 必须是合法颜色值`);
  const background = scope['backgroundColor'];
  if (background !== null && background !== undefined && !isColor(background)) {
    errors.push(`${where}: backgroundColor 必须是合法颜色值或 null`);
  }
  for (const key of ['bold', 'italic', 'underline', 'strikethrough']) {
    if (scope[key] !== undefined && typeof scope[key] !== 'boolean') {
      errors.push(`${where}: ${key} 必须是布尔值`);
    }
  }
  if (isColor(scope['color']) && isColor(background) && scope['color'] === background) {
    warnings.push(`${where}: 文字色与背景色相同，实际不可读`);
  }
}

function validateMatch(errors: string[], warnings: string[], where: string, match: unknown): void {
  if (!isObject(match)) {
    errors.push(`${where}.match: 必须是对象`);
    return;
  }
  const type = match['type'];
  if (typeof type !== 'string' || !MATCH_TYPES.has(type)) {
    errors.push(`${where}.match.type "${String(type)}" 不受支持（应为 regex / word-list / line-prefix / delimiter-block）`);
    return;
  }

  if (type === 'regex') {
    const pattern = match['pattern'];
    if (typeof pattern !== 'string' || pattern === '') {
      errors.push(`${where}.match: regex 必须提供 pattern`);
    } else {
      checkRegex(errors, `${where}.match`, pattern, typeof match['flags'] === 'string' ? match['flags'] : undefined);
    }
    if (match['flags'] !== undefined && (typeof match['flags'] !== 'string' || !FLAGS_PATTERN.test(match['flags']))) {
      errors.push(`${where}.match.flags 只能是 g/i/m/s/u 的组合`);
    }
    if (match['wholeLine'] !== undefined && typeof match['wholeLine'] !== 'boolean') {
      errors.push(`${where}.match.wholeLine 必须是布尔值`);
    }
    if (typeof match['flags'] === 'string' && match['flags'].includes('g') === false) {
      warnings.push(`${where}.match: 正则未带 g 标志，只会命中第一个匹配（引擎会自动补 g）`);
    }
    return;
  }

  if (type === 'word-list') {
    const words = match['words'];
    if (!Array.isArray(words) || words.length === 0) {
      errors.push(`${where}.match: word-list 必须提供非空 words 数组`);
      return;
    }
    words.forEach((word, index) => {
      if (typeof word !== 'string' || word === '') errors.push(`${where}.match.words[${index}]: 不能为空字符串`);
      else if (word.trim() === '') warnings.push(`${where}.match.words[${index}]: 仅含空白字符，不会命中任何内容`);
    });
    for (const key of ['caseSensitive', 'wholeWord']) {
      if (match[key] !== undefined && typeof match[key] !== 'boolean') {
        errors.push(`${where}.match.${key} 必须是布尔值`);
      }
    }
    return;
  }

  if (type === 'line-prefix') {
    const prefix = match['prefix'];
    if (typeof prefix !== 'string' || prefix === '') errors.push(`${where}.match: line-prefix 必须提供 prefix`);
    else if (prefix.length > 32) errors.push(`${where}.match.prefix 长度上限 32`);
    return;
  }

  const open = match['open'];
  const close = match['close'];
  if (typeof open !== 'string' || open === '') errors.push(`${where}.match: delimiter-block 必须提供 open`);
  if (typeof close !== 'string' || close === '') errors.push(`${where}.match: delimiter-block 必须提供 close`);
  if (typeof match['escape'] === 'string' && match['escape'].length !== 1) {
    errors.push(`${where}.match.escape 必须是单个字符`);
  }
}

/**
 * 解析并校验一份高亮规则文件。
 * 返回 file=null 表示不可用（调用方应保留当前方案，不替换）。
 */
export function parseHighlightRule(input: unknown): HighlightParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isObject(input)) {
    return { file: null, errors: ['高亮规则文件顶层必须是对象'], warnings: [] };
  }
  if (input['schemaVersion'] !== 1) errors.push('schemaVersion 必须为 1');
  if (typeof input['id'] !== 'string' || !ID_PATTERN.test(input['id'])) errors.push('id 不合法');
  if (typeof input['name'] !== 'string' || input['name'] === '') errors.push('name 不能为空');
  if (typeof input['version'] !== 'string' || !VERSION_PATTERN.test(input['version'])) errors.push('version 必须是 x.y.z');
  if (input['description'] !== undefined && typeof input['description'] !== 'string') errors.push('description 必须是字符串');
  if (input['extends'] !== undefined && input['extends'] !== null && typeof input['extends'] !== 'string') {
    errors.push('extends 必须是字符串或 null');
  }

  if (input['editor'] !== undefined) validateEditor(errors, input['editor']);
  validateTheme(errors, input['theme']);

  // --- scopes ---
  const scopeIds = new Set<string>();
  if (!Array.isArray(input['scopes'])) {
    errors.push('scopes 必须是数组');
  } else if (input['scopes'].length === 0) {
    errors.push('scopes 至少需要 1 条样式定义');
  } else {
    (input['scopes'] as unknown[]).forEach((scope, index) => {
      validateScope(errors, warnings, index, scope);
      if (isObject(scope) && typeof scope['id'] === 'string') {
        if (scopeIds.has(scope['id'])) errors.push(`scopes 中 id "${scope['id']}" 重复`);
        scopeIds.add(scope['id']);
      }
    });
  }

  // --- rules ---
  const inherited = typeof input['extends'] === 'string' && input['extends'] !== '';
  if (!Array.isArray(input['rules'])) {
    errors.push('rules 必须是数组');
  } else {
    const ruleIds = new Set<string>();
    (input['rules'] as unknown[]).forEach((rule, index) => {
      const where = `rules[${index}]`;
      if (!isObject(rule)) {
        errors.push(`${where}: 必须是对象`);
        return;
      }
      const id = rule['id'];
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) errors.push(`${where}: id 不合法`);
      else if (ruleIds.has(id)) errors.push(`${where}: id "${id}" 重复`);
      if (typeof id === 'string') ruleIds.add(id);

      if (typeof rule['scope'] !== 'string' || rule['scope'] === '') {
        errors.push(`${where}: 缺少 scope`);
      } else if (!scopeIds.has(rule['scope'])) {
        // 继承场景下允许引用父级 scope，合并后再复核（见 resolveHighlightRule）
        if (inherited) warnings.push(`${where}: scope "${rule['scope']}" 不在本文件 scopes 中，需由父规则集 "${input['extends']}" 提供`);
        else errors.push(`${where}: 引用了未定义的 scope "${rule['scope']}"`);
      }

      validateMatch(errors, warnings, where, rule['match']);

      const priority = rule['priority'];
      if (priority !== undefined) {
        if (typeof priority !== 'number' || !Number.isInteger(priority)) errors.push(`${where}: priority 必须是整数`);
        else if (priority < -1000 || priority > 1000) errors.push(`${where}: priority 需在 -1000..1000（当前 ${priority}）`);
      }
      if (rule['enabled'] !== undefined && typeof rule['enabled'] !== 'boolean') {
        errors.push(`${where}: enabled 必须是布尔值`);
      }
      const appliesTo = rule['appliesTo'];
      if (appliesTo !== undefined) {
        const list = Array.isArray(appliesTo) ? appliesTo : [appliesTo];
        if (list.length === 0) errors.push(`${where}: appliesTo 不能为空数组`);
        for (const item of list) {
          if (typeof item !== 'string' || !SELECTOR_PATTERN.test(item)) {
            errors.push(`${where}: appliesTo 中的 "${String(item)}" 不是合法选择器`);
          }
        }
      }
    });
  }

  if (input['metadata'] !== undefined && !isObject(input['metadata'])) errors.push('metadata 必须是对象');

  if (errors.length > 0) return { file: null, errors, warnings };
  return { file: input as unknown as HighlightRuleFile, errors: [], warnings };
}

/** 批量加载：单份失败不影响其他规则集 */
export function loadHighlightRules(inputs: readonly unknown[]): HighlightLoadResult {
  const rules: HighlightRuleFile[] = [];
  const errors: HighlightLoadResult['errors'] = [];
  const warnings: HighlightLoadResult['warnings'] = [];
  inputs.forEach((input, index) => {
    const result = parseHighlightRule(input);
    const id = isObject(input) && typeof input['id'] === 'string' ? input['id'] : null;
    if (result.file) rules.push(result.file);
    else errors.push({ index, id, errors: result.errors });
    if (result.warnings.length > 0) warnings.push({ index, id, warnings: result.warnings });
  });
  return { rules, errors, warnings };
}

function mergeScopes(parent: HighlightScope[], child: HighlightScope[]): HighlightScope[] {
  const byId = new Map<string, HighlightScope>();
  const order: string[] = [];
  for (const scope of parent) {
    if (!byId.has(scope.id)) order.push(scope.id);
    byId.set(scope.id, scope);
  }
  for (const scope of child) {
    if (!byId.has(scope.id)) order.push(scope.id);
    byId.set(scope.id, scope);
  }
  return order.map((id) => byId.get(id)!);
}

function mergeRules(parent: HighlightRule[], child: HighlightRule[]): HighlightRule[] {
  const byId = new Map<string, HighlightRule>();
  const order: string[] = [];
  for (const rule of parent) {
    if (!byId.has(rule.id)) order.push(rule.id);
    byId.set(rule.id, rule);
  }
  for (const rule of child) {
    if (!byId.has(rule.id)) order.push(rule.id);
    byId.set(rule.id, rule);
  }
  return order.map((id) => byId.get(id)!);
}

function mergeHighlight(parent: HighlightRuleFile, child: HighlightRuleFile): HighlightRuleFile {
  return {
    ...child,
    extends: parent.id,
    description: child.description ?? parent.description,
    editor: { ...(parent.editor ?? {}), ...(child.editor ?? {}) },
    theme: { ...parent.theme, ...child.theme } as HighlightTheme,
    scopes: mergeScopes(parent.scopes, child.scopes),
    rules: mergeRules(parent.rules, child.rules),
    metadata: child.metadata ?? parent.metadata,
  };
}

/** 解析继承链并合并；id 不存在、形成环、或合并后 scope 仍缺失时抛错 */
export function resolveHighlightRule(id: string, rules: readonly HighlightRuleFile[]): ResolvedHighlightRule {
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const chain: HighlightRuleFile[] = [];
  const seen = new Set<string>();
  let cursor: string | null | undefined = id;

  while (cursor) {
    if (seen.has(cursor)) throw new Error(`高亮规则继承链出现环：${[...seen, cursor].join(' -> ')}`);
    const rule = byId.get(cursor);
    if (!rule) throw new Error(`高亮规则集 "${cursor}" 不存在`);
    seen.add(cursor);
    chain.unshift(rule);
    cursor = rule.extends ?? null;
  }

  let merged: HighlightRuleFile = chain[0]!;
  for (const rule of chain.slice(1)) merged = mergeHighlight(merged, rule);

  // 合并后复核 scope 引用（父级未提供时会在这里暴露）
  const scopeIds = new Set(merged.scopes.map((scope) => scope.id));
  for (const rule of merged.rules) {
    if (!scopeIds.has(rule.scope)) {
      throw new Error(`高亮规则集 "${id}" 的规则 "${rule.id}" 引用了未定义的 scope "${rule.scope}"（继承链：${chain.map((item) => item.id).join(' -> ')}）`);
    }
  }

  return { ...merged, lineage: chain.map((rule) => rule.id) };
}

export function resolveAllHighlightRules(rules: readonly HighlightRuleFile[]): ResolvedHighlightRule[] {
  return rules.map((rule) => resolveHighlightRule(rule.id, rules));
}

/** 选择器合法性守卫，供编辑器表单复用 */
export function isValidHighlightSelector(value: string): boolean {
  return SELECTOR_PATTERN.test(value);
}

export type { EditorTypography, MatchSpec };
