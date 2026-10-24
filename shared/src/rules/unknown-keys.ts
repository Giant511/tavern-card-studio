/**
 * 未知字段检查（T10.10 · 补 F4）。
 *
 * 背景：解析器是**白名单式**的 —— 只读它认识的键，其余静默忽略。
 * 对使用者来说这是最坏的一种失败：把 `match` 写成 `mach`、把 `color` 写成 `colour`，
 * 文件 schema 依然"看着没问题"，导入提示成功，然后规则完全不生效，
 * 且没有任何一处告诉你为什么。规则文件是手写的 JSON，拼错一个字母的概率极高。
 *
 * 因此这里对**不认识的键**给 warning（而不是 error）：
 *
 *   · 不阻断 —— 前向兼容。v0.2 新增的字段不应该让 v0.1.2 拒绝导入整份规则；
 *   · 但必须**点名**，并尽量给出"你是不是想写 xxx"，让用户一眼看到拼错的位置。
 *
 * 判据是「键不在白名单里」。白名单必须与 JSON Schema 保持同步 ——
 * 这也是为什么它写在解析器旁边而不是散落在各 validate 函数里。
 */

/**
 * 编辑距离（Damerau-Levenshtein，最优字符串对齐版本）。
 *
 * 与纯 Levenshtein 的差别只有一条：**相邻两字符互换算 1 步**。
 * 这不是学术洁癖 —— 手打 JSON 最常见的错误就是把 `from` 打成 `form`、
 * `enabled` 打成 `enabeld`，纯 Levenshtein 会把它算成 2 步，
 * 而短键的容错窗口只有 1，于是最该给建议的那类错误反而悄悄不提示。
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) matrix[i]![0] = i;
  for (let j = 0; j < cols; j += 1) matrix[0]![j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        matrix[i - 1]![j]! + 1, // 删除
        matrix[i]![j - 1]! + 1, // 插入
        matrix[i - 1]![j - 1]! + cost, // 替换
      );
      // 相邻互换
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, matrix[i - 2]![j - 2]! + 1);
      }
      matrix[i]![j] = value;
    }
  }
  return matrix[rows - 1]![cols - 1]!;
}

/**
 * 找一个"最像"的合法键。
 *
 * 阈值随长度放宽（短键更容易撞上），但**不超过 2**：
 * 距离 3 以上基本是另一个词，给建议反而误导。
 */
export function suggestKey(unknown: string, allowed: readonly string[]): string | null {
  const lower = unknown.toLowerCase();
  let best: { key: string; distance: number } | null = null;
  for (const key of allowed) {
    const distance = editDistance(lower, key.toLowerCase());
    const limit = key.length <= 4 ? 1 : 2;
    if (distance <= limit && (best === null || distance < best.distance)) {
      best = { key, distance };
    }
  }
  return best?.key ?? null;
}

/**
 * 检查一个对象的键是否都在白名单内，不在的进 `warnings`。
 *
 * `where` 是给人看的位置前缀（`rules[0].match` 这种），空串表示文件顶层。
 * 用 `snake_case` / `kebab-case` 之类的**同义写法**也算未知 —— 因为我们不会猜它的语义，
 * 但会在提示里点名原样拼写，用户可以自己对照 schema。
 */
export function checkUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  warnings: string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (allowedSet.has(key)) continue;
    const suggestion = suggestKey(key, allowed);
    const prefix = where === '' ? '' : `${where}.`;
    warnings.push(
      suggestion === null
        ? `未知字段 ${prefix}${key}（不在规范内，已忽略；如拼写有误请对照文档更正）`
        : `未知字段 ${prefix}${key}（已忽略）—— 是不是想写 ${suggestion}？`,
    );
  }
}

/** 平台规则顶层允许的键 */
export const PLATFORM_RULE_KEYS = [
  'schemaVersion',
  'id',
  'name',
  'version',
  'description',
  'extends',
  'target',
  'placeholders',
  'fields',
  'rules',
  'autoFix',
  'metadata',
] as const;

/** 平台规则 target 段 */
export const PLATFORM_TARGET_KEYS = ['spec', 'specVersion'] as const;

/** 平台规则 placeholders 段（custom 的二级键是用户自定义的，不检查） */
export const PLATFORM_PLACEHOLDER_KEYS = ['char', 'user', 'custom'] as const;

/** 平台规则 fields[] 元素 */
export const PLATFORM_FIELD_KEYS = [
  'path',
  'label',
  'required',
  'minLength',
  'maxLength',
  'pattern',
  'flags',
  'severity',
  'message',
  'stDefault',
] as const;

/** 平台规则 rules[] 元素：基础键 + 各 type 的专属键并集 */
export const PLATFORM_RULE_ELEMENT_KEYS = [
  'id',
  'type',
  'message',
  'scope',
  'severity',
  'enabled',
  'hint',
  // T10.33：世界书条目规则用（category 决定审计分组，when 表达跨字段条件）
  'category',
  'when',
  // placeholder-min-count / placeholder-forbid / pattern-required
  'token',
  'min',
  'max',
  'aggregate',
  // pattern-forbid / pattern-required / replace-regex
  'pattern',
  'flags',
  // length
  'unit',
  // forbidden-words
  'words',
  'caseSensitive',
  // number-range
  'required',
] as const;

/** 平台规则 rule.when 段（T10.33，同一条目内的跨字段条件） */
export const PLATFORM_RULE_WHEN_KEYS = ['field', 'equals', 'notEquals', 'present'] as const;

/** 平台规则 autoFix[] 元素 */
export const PLATFORM_AUTOFIX_KEYS = [
  'type',
  'ruleId',
  'scope',
  'from',
  'to',
  'caseSensitive',
  'pattern',
  'flags',
  'replacement',
] as const;

/** 平台规则 metadata */
export const PLATFORM_METADATA_KEYS = ['author', 'homepage', 'license', 'updatedAt'] as const;

/** 高亮方案顶层 */
export const HIGHLIGHT_RULE_KEYS = [
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

export const HIGHLIGHT_EDITOR_KEYS = ['fontSize', 'lineHeight', 'tabSize', 'fontFamily'] as const;

export const HIGHLIGHT_THEME_KEYS = ['foreground', 'background', 'caret', 'selectionBackground'] as const;

export const HIGHLIGHT_SCOPE_KEYS = [
  'id',
  'label',
  'color',
  'backgroundColor',
  'bold',
  'italic',
  'underline',
  'strikethrough',
] as const;

/** 高亮 rules[] 元素 */
export const HIGHLIGHT_RULE_ELEMENT_KEYS = ['id', 'scope', 'match', 'priority', 'enabled', 'appliesTo'] as const;

/** 高亮 rules[].match（四种 type 的键并集） */
export const HIGHLIGHT_MATCH_KEYS = [
  'type',
  'pattern',
  'flags',
  'wholeLine',
  'words',
  'caseSensitive',
  'wholeWord',
  'prefix',
  'open',
  'close',
  'escape',
] as const;

/** 高亮方案 metadata（与平台规则的 metadata 同形） */
export const HIGHLIGHT_METADATA_KEYS = PLATFORM_METADATA_KEYS;
