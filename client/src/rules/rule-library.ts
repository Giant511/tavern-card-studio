/**
 * 规则库（T6.3）：平台规则 / 高亮方案的运行时集合 + 原子导入。
 *
 * 为什么要有这一层：
 *   · 导入是**破坏性操作**——一份坏规则文件不能污染正在用的规则集；
 *   · 校验错误是纯字符串（`fields[0].path: 缺少 path`），UI 要显示"哪个字段"就得结构化；
 *   · 这些都能脱离 DOM 测试，所以放在纯逻辑层。
 *
 * 契约约束：读文件走 `../contract` 的 `pickRuleFile` / `readTextExact`，本文件不碰文件系统。
 */

import {
  compileHighlightRule,
  groupRuleIssues,
  splitRuleError,
  type RuleIssue,
  importHighlightRuleText,
  parsePlatformRule,
  resolveHighlightRule,
  resolvePlatformRule,
  type CompiledHighlightRule,
  type HighlightRuleFile,
  type PlatformRuleFile,
  type ResolvedPlatformRule,
  type ResolvedHighlightRule,
} from '@tcs/shared';

export interface ImportOutcome<T> {
  /** 是否成功替换（false 时 `value` 一定是传入的原值） */
  ok: boolean;
  /** 生效的值：成功是新导入的，失败是原值（原子回退） */
  value: T;
  issues: RuleIssue[];
  warnings: string[];
  /** 成功时的规则 id，便于提示"已切换到 xxx" */
  id: string | null;
  name: string | null;
}

/**
 * 导入平台规则（原子）。
 *
 * 失败时**原样返回 current**，调用方不需要写回滚代码——
 * 这是「坏文件不污染现有规则」的保证点。
 */
export function importPlatformRule(
  current: readonly PlatformRuleFile[],
  text: string,
): ImportOutcome<PlatformRuleFile[]> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text) as unknown;
  } catch (error) {
    return {
      ok: false,
      value: [...current],
      issues: [
        {
          where: '',
          message: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
          group: '',
          index: null,
        },
      ],
      warnings: [],
      id: null,
      name: null,
    };
  }

  const result = parsePlatformRule(parsedJson);
  if (!result.rule) {
    return {
      ok: false,
      value: [...current],
      issues: result.errors.map(splitRuleError),
      warnings: result.warnings,
      id: null,
      name: null,
    };
  }

  const rule = result.rule;

  // 继承链必须可解析：否则"导入成功"却在切换时才炸，属于更糟的失败方式。
  // 这里用「current + 新规则」试解析一次，坏链当场拒绝。
  const merged = [...current.filter((item) => item.id !== rule.id), rule];
  try {
    resolvePlatformRule(rule.id, merged);
  } catch (error) {
    return {
      ok: false,
      value: [...current],
      issues: [
        {
          where: 'extends',
          message: `继承链无法解析：${error instanceof Error ? error.message : String(error)}`,
          group: 'extends',
          index: null,
        },
      ],
      warnings: [],
      id: null,
      name: null,
    };
  }

  return {
    ok: true,
    value: merged,
    issues: [],
    // 未知字段等"不阻断但必须可见"的问题（T10.10 补 F4）
    warnings: result.warnings,
    id: rule.id,
    name: rule.name,
  };
}

export interface HighlightImportOutcome extends ImportOutcome<HighlightRuleFile | null> {
  /** 成功时编译好的规则集，可直接交给编辑器 */
  compiled: CompiledHighlightRule | null;
  resolved: ResolvedHighlightRule | null;
}

/**
 * 导入高亮方案（原子）。
 *
 * 比平台规则多一步：**必须能编译**。只通过 schema 但正则编不过的方案，
 * 导入后会让整个编辑器高亮失效，所以编译失败也算导入失败。
 */
export function importHighlightScheme(
  current: HighlightRuleFile | null,
  siblings: readonly HighlightRuleFile[],
  text: string,
): HighlightImportOutcome {
  const imported = importHighlightRuleText(text);

  if (!imported.ok || !imported.file) {
    const issues = imported.errors.map(splitRuleError);
    return {
      ok: false,
      value: current,
      issues,
      warnings: imported.warnings,
      id: null,
      name: null,
      compiled: null,
      resolved: null,
    };
  }

  const file = imported.file;
  const merged = [...siblings.filter((item) => item.id !== file.id), file];

  let resolved: ResolvedHighlightRule;
  try {
    resolved = resolveHighlightRule(file.id, merged);
  } catch (error) {
    return {
      ok: false,
      value: current,
      issues: [
        {
          where: 'extends',
          message: `继承链无法解析：${error instanceof Error ? error.message : String(error)}`,
          group: 'extends',
          index: null,
        },
      ],
      warnings: imported.warnings,
      id: null,
      name: null,
      compiled: null,
      resolved: null,
    };
  }

  let compiled: CompiledHighlightRule;
  try {
    compiled = compileHighlightRule(resolved);
  } catch (error) {
    return {
      ok: false,
      value: current,
      issues: [
        {
          where: 'rules',
          message: `编译失败（正则或作用域有问题）：${
            error instanceof Error ? error.message : String(error)
          }`,
          group: 'rules',
          index: null,
        },
      ],
      warnings: imported.warnings,
      id: null,
      name: null,
      compiled: null,
      resolved: null,
    };
  }

  return {
    ok: true,
    value: file,
    issues: [],
    warnings: imported.warnings,
    id: file.id,
    name: file.name,
    compiled,
    resolved,
  };
}

export { splitRuleError, groupRuleIssues };
export type { RuleIssue };
