/**
 * 平台规则文件的加载、校验与继承合并（T1.3）。
 *
 * 运行时不依赖 Ajv：这里做一层轻量结构校验，覆盖 schema 的关键约束（必填、枚举、正则可编译、
 * 选择器语法、占位符引用）。离线安装包里不必带 Ajv，命令行侧仍用 Ajv 做完整校验。
 */

import type {
  ContentRule,
  FieldRequirement,
  PlaceholderKey,
  PlatformRuleFile,
  ResolvedPlatformRule,
  Selector,
} from './platform-rule.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SELECTOR_PATTERN = /^(\*|block:(basic|personality|settings|special|user|worldbook)|field:[a-z_]+)$/;
const TOKEN_PATTERN = /^(char|user|custom:[a-zA-Z][a-zA-Z0-9_]{0,31})$/;
const SEVERITIES = new Set(['error', 'warning', 'info']);
const RULE_TYPES = new Set([
  'placeholder-min-count',
  'placeholder-forbid',
  'pattern-forbid',
  'pattern-required',
  'length',
  'non-empty',
  'forbidden-words',
]);

export interface RuleParseResult {
  rule: PlatformRuleFile | null;
  errors: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.length > 0);
}

function checkSelector(errors: string[], where: string, scope: unknown): void {
  const list = Array.isArray(scope) ? scope : [scope];
  if (list.length === 0) {
    errors.push(`${where}: scope 不能为空`);
    return;
  }
  for (const item of list) {
    if (typeof item !== 'string' || !SELECTOR_PATTERN.test(item)) {
      errors.push(`${where}: 选择器 "${String(item)}" 不合法（应为 *、block:<id> 或 field:<字段名>）`);
    }
  }
}

function checkRegex(errors: string[], where: string, pattern: string, flags?: string): void {
  try {
    new RegExp(pattern, (flags ?? '').replace(/[gy]/g, ''));
  } catch (error) {
    errors.push(`${where}: 正则无法编译 — ${(error as Error).message}`);
  }
}

function validateField(errors: string[], index: number, field: unknown): void {
  const where = `fields[${index}]`;
  if (!isObject(field)) {
    errors.push(`${where}: 必须是对象`);
    return;
  }
  if (typeof field['path'] !== 'string' || field['path'] === '') errors.push(`${where}: 缺少 path`);
  if (typeof field['label'] !== 'string' || field['label'] === '') errors.push(`${where}: 缺少 label`);
  if (typeof field['required'] !== 'boolean') errors.push(`${where}: required 必须是布尔值`);
  if (field['severity'] !== undefined && !SEVERITIES.has(String(field['severity']))) {
    errors.push(`${where}: severity 只能是 error/warning/info`);
  }
  if (field['stDefault'] !== undefined && typeof field['stDefault'] !== 'boolean') {
    errors.push(`${where}: stDefault 必须是布尔值`);
  }
  if (typeof field['pattern'] === 'string') {
    checkRegex(errors, where, field['pattern'], typeof field['flags'] === 'string' ? field['flags'] : undefined);
  }
  const minLength = field['minLength'];
  const maxLength = field['maxLength'];
  if (typeof minLength === 'number' && typeof maxLength === 'number' && minLength > maxLength) {
    errors.push(`${where}: minLength(${minLength}) 大于 maxLength(${maxLength})`);
  }
}

function validateRule(errors: string[], index: number, rule: unknown, declaredTokens: Set<string>): void {
  const where = `rules[${index}]`;
  if (!isObject(rule)) {
    errors.push(`${where}: 必须是对象`);
    return;
  }
  const id = rule['id'];
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) errors.push(`${where}: id 不合法（小写字母/数字/._-，2-64 位）`);
  const type = rule['type'];
  if (typeof type !== 'string' || !RULE_TYPES.has(type)) {
    errors.push(`${where}: type "${String(type)}" 不受支持`);
    return;
  }
  if (typeof rule['message'] !== 'string' || rule['message'] === '') errors.push(`${where}: 缺少 message`);
  if (!SEVERITIES.has(String(rule['severity']))) errors.push(`${where}: severity 只能是 error/warning/info`);
  checkSelector(errors, where, rule['scope']);

  if (type.startsWith('placeholder')) {
    const token = rule['token'];
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      errors.push(`${where}: token "${String(token)}" 不合法`);
    } else if (!declaredTokens.has(token)) {
      errors.push(`${where}: token "${token}" 未在 placeholders 中声明`);
    }
  }
  if (type === 'placeholder-min-count' && typeof rule['min'] !== 'number') {
    errors.push(`${where}: placeholder-min-count 必须提供 min`);
  }
  if ((type === 'pattern-forbid' || type === 'pattern-required') && typeof rule['pattern'] !== 'string') {
    errors.push(`${where}: ${type} 必须提供 pattern`);
  }
  if (typeof rule['pattern'] === 'string') {
    checkRegex(errors, where, rule['pattern'], typeof rule['flags'] === 'string' ? rule['flags'] : undefined);
  }
  if (type === 'forbidden-words' && !isStringArray(rule['words'])) {
    errors.push(`${where}: forbidden-words 必须提供非空 words 数组`);
  }
  const min = rule['min'];
  const max = rule['max'];
  if (typeof min === 'number' && typeof max === 'number' && min > max) {
    errors.push(`${where}: min(${min}) 大于 max(${max})`);
  }
}

export function parsePlatformRule(input: unknown): RuleParseResult {
  const errors: string[] = [];

  if (!isObject(input)) {
    return { rule: null, errors: ['规则文件顶层必须是对象'] };
  }
  if (input['schemaVersion'] !== 1) errors.push('schemaVersion 必须为 1');
  if (typeof input['id'] !== 'string' || !ID_PATTERN.test(input['id'])) errors.push('id 不合法');
  if (typeof input['name'] !== 'string' || input['name'] === '') errors.push('name 不能为空');
  if (typeof input['version'] !== 'string' || !VERSION_PATTERN.test(input['version'])) errors.push('version 必须是 x.y.z');

  const target = input['target'];
  if (!isObject(target)) {
    errors.push('缺少 target');
  } else if (!['v1', 'v2', 'v3', 'any'].includes(String(target['spec']))) {
    errors.push('target.spec 只能是 v1/v2/v3/any');
  }

  const placeholders = input['placeholders'];
  const declaredTokens = new Set<string>();
  if (!isObject(placeholders)) {
    errors.push('缺少 placeholders');
  } else {
    for (const key of ['char', 'user']) {
      if (!isStringArray(placeholders[key])) errors.push(`placeholders.${key} 必须是非空字符串数组`);
      else declaredTokens.add(key);
    }
    const custom = placeholders['custom'];
    if (custom !== undefined) {
      if (!isObject(custom)) {
        errors.push('placeholders.custom 必须是对象');
      } else {
        for (const [name, variants] of Object.entries(custom)) {
          if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(name)) errors.push(`placeholders.custom 的键 "${name}" 不合法`);
          if (!isStringArray(variants)) errors.push(`placeholders.custom.${name} 必须是非空字符串数组`);
          else declaredTokens.add(`custom:${name}`);
        }
      }
    }
  }

  const fields = input['fields'];
  if (!Array.isArray(fields)) errors.push('fields 必须是数组');
  else fields.forEach((field, index) => validateField(errors, index, field));

  const rules = input['rules'];
  if (!Array.isArray(rules)) errors.push('rules 必须是数组');
  else rules.forEach((rule, index) => validateRule(errors, index, rule, declaredTokens));

  if (Array.isArray(rules)) {
    const seen = new Set<string>();
    for (const rule of rules) {
      if (!isObject(rule) || typeof rule['id'] !== 'string') continue;
      if (seen.has(rule['id'])) errors.push(`rules 中 id "${rule['id']}" 重复`);
      seen.add(rule['id']);
    }
  }

  const autoFix = input['autoFix'];
  if (autoFix !== undefined) {
    if (!Array.isArray(autoFix)) errors.push('autoFix 必须是数组');
    else {
      autoFix.forEach((op, index) => {
        if (!isObject(op)) {
          errors.push(`autoFix[${index}]: 必须是对象`);
          return;
        }
        if (!['replace-text', 'replace-regex', 'trim'].includes(String(op['type']))) {
          errors.push(`autoFix[${index}]: type 不受支持`);
        }
        if (op['type'] === 'replace-text' && (typeof op['from'] !== 'string' || typeof op['to'] !== 'string')) {
          errors.push(`autoFix[${index}]: replace-text 需要 from/to`);
        }
        if (op['type'] === 'replace-regex') {
          if (typeof op['pattern'] !== 'string') errors.push(`autoFix[${index}]: replace-regex 需要 pattern`);
          else checkRegex(errors, `autoFix[${index}]`, op['pattern'], typeof op['flags'] === 'string' ? op['flags'] : undefined);
          if (typeof op['replacement'] !== 'string') errors.push(`autoFix[${index}]: replace-regex 需要 replacement`);
        }
        if (op['scope'] !== undefined) checkSelector(errors, `autoFix[${index}]`, op['scope']);
      });
    }
  }

  if (errors.length > 0) return { rule: null, errors };
  return { rule: input as unknown as PlatformRuleFile, errors: [] };
}

function buildPlaceholderLookup(rule: PlatformRuleFile): Record<string, PlaceholderKey> {
  const lookup: Record<string, PlaceholderKey> = {};
  for (const variant of rule.placeholders.char) lookup[variant] = 'char';
  for (const variant of rule.placeholders.user) lookup[variant] = 'user';
  for (const [name, variants] of Object.entries(rule.placeholders.custom ?? {})) {
    for (const variant of variants) lookup[variant] = `custom:${name}` as PlaceholderKey;
  }
  return lookup;
}

function mergeRules(parent: PlatformRuleFile, child: PlatformRuleFile): PlatformRuleFile {
  const fieldsByPath = new Map<string, FieldRequirement>();
  for (const field of parent.fields) fieldsByPath.set(field.path, field);
  for (const field of child.fields) fieldsByPath.set(field.path, field);

  const rulesById = new Map<string, ContentRule>();
  for (const rule of parent.rules) rulesById.set(rule.id, rule);
  for (const rule of child.rules) rulesById.set(rule.id, rule);

  const autoFix = [...(parent.autoFix ?? [])];
  const seenFix = new Set(autoFix.map((op) => JSON.stringify(op)));
  for (const op of child.autoFix ?? []) {
    const key = JSON.stringify(op);
    if (!seenFix.has(key)) {
      autoFix.push(op);
      seenFix.add(key);
    }
  }

  return {
    ...child,
    extends: parent.id,
    placeholders: child.placeholders,
    target: child.target,
    fields: [...fieldsByPath.values()],
    rules: [...rulesById.values()],
    autoFix,
    metadata: child.metadata ?? parent.metadata,
  };
}

/** 解析继承链并合并；id 不存在或形成环时抛错 */
export function resolvePlatformRule(id: string, rules: readonly PlatformRuleFile[]): ResolvedPlatformRule {
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const chain: PlatformRuleFile[] = [];
  const seen = new Set<string>();
  let cursor: string | null | undefined = id;

  while (cursor) {
    if (seen.has(cursor)) {
      throw new Error(`平台规则继承链出现环：${[...seen, cursor].join(' -> ')}`);
    }
    const rule = byId.get(cursor);
    if (!rule) throw new Error(`平台规则 "${cursor}" 不存在`);
    seen.add(cursor);
    chain.unshift(rule);
    cursor = rule.extends ?? null;
  }

  let merged = chain[0]!;
  for (const rule of chain.slice(1)) merged = mergeRules(merged, rule);

  return {
    ...merged,
    lineage: chain.map((rule) => rule.id),
    placeholderLookup: buildPlaceholderLookup(merged),
  };
}

export function resolveAllPlatformRules(rules: readonly PlatformRuleFile[]): ResolvedPlatformRule[] {
  return rules.map((rule) => resolvePlatformRule(rule.id, rules));
}

/** 批量加载：解析失败的条目单独收集，不阻断其他规则 */
export function loadPlatformRules(inputs: readonly unknown[]): {
  rules: PlatformRuleFile[];
  errors: { index: number; id: string | null; errors: string[] }[];
} {
  const rules: PlatformRuleFile[] = [];
  const errors: { index: number; id: string | null; errors: string[] }[] = [];
  inputs.forEach((input, index) => {
    const result = parsePlatformRule(input);
    if (result.rule) rules.push(result.rule);
    else errors.push({ index, id: isObject(input) && typeof input['id'] === 'string' ? input['id'] : null, errors: result.errors });
  });
  return { rules, errors };
}

/** 选择器类型守卫，供外部（客户端表单）复用 */
export function isValidSelector(value: string): value is Selector {
  return SELECTOR_PATTERN.test(value);
}
