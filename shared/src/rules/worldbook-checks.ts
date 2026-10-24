/**
 * 默认世界书校验规则集（T10.33，语义轨）。
 *
 * ## 它解决什么
 *
 * T10.9 的世界书检查是**硬编码在 `audit/format.ts` 里的一段代码**：写死了 9 条判据、
 * 写死了文案、写死了 severity。用户想说「我们这个项目要求条目名必填、关键词至少 2 个」，
 * 只能来改源码 —— 而那是不该由用户付的成本，也是内置规则集要存在的原因。
 *
 * 现在这 9 条变成**数据**（`ContentRule[]`），由同一个规则引擎求值。
 * 于是三件事同时成立：
 *
 *   1. 内置检查与用户规则走**同一套求值代码**（去重铁律：不并存两套口径）；
 *   2. 用户可以用同样的 id 覆盖某条（改 severity / 改文案 / 改阈值）；
 *   3. 用户可以用 `enabled: false` 关掉单条。
 *
 * ## 边界（已拍板）
 *
 * 内置**只覆盖 SillyTavern 规范的标准语义** —— 触发键、空关键词、selective 与次级键、
 * position 取值、insertion_order 非负。像「条目名必填」「关键词至少 N 个」「触发深度上限」
 * 这类**项目偏好**不进内置：那是个别用户的约定，内置了就会变成对所有用户的误报。
 * 它们走自定义规则（导入）。
 *
 * ## 为什么这里不用 JSON 文件
 *
 * 规则集是**判据**而不是配置：它必须与引擎的规则类型、选择器语法同步演进，
 * 放在 TS 里能享受类型检查；放 JSON 则两处漂移只会表现为"运行时不生效"。
 * 用户要复制它去改时，「导出当前规则」会把这份规则集序列化出来（见 client 的导出）。
 */

import type { ContentRule } from './platform-rule.js';

/** 世界书规则统一用这个类别，审计面板才能归到「世界书」分组 */
const WB_CATEGORY = 'worldbook' as const;

/**
 * 内置规则。**id 与 T10.9 的 `builtin:worldbook-*` 完全一致** ——
 * 那是等价性测试的锚点，也是用户覆盖/禁用时的引用名。
 */
export const DEFAULT_WORLDBOOK_RULES: readonly ContentRule[] = [
  {
    id: 'builtin:worldbook-entry-empty-content',
    type: 'non-empty',
    message: '世界书{entry}的正文是空的',
    hint: '空条目不会给对话提供任何信息，通常应该删除或补内容',
    scope: 'worldbook:entries[].content',
    severity: 'warning',
    category: WB_CATEGORY,
  },
  {
    id: 'builtin:worldbook-no-trigger',
    type: 'list-count',
    min: 1,
    // constant 缺省即 false（ST 语义），所以用 notEquals 而不是 equals:false ——
    // 后者会漏掉"没写 constant 字段"的条目，而那正是最常见的写法。
    when: { field: 'constant', notEquals: true },
    message: '世界书{entry}没有任何关键词，也不是常驻（constant: false）——永远不会被触发',
    hint: '补关键词，或把 constant 设为 true 让它常驻',
    scope: 'worldbook:entries[].keys',
    severity: 'warning',
    category: WB_CATEGORY,
  },
  {
    id: 'builtin:worldbook-blank-key',
    type: 'list-no-blank-items',
    message: '世界书{entry}的关键词里有 {count} 个空项',
    hint: '空关键词会匹配一切，等于让条目常驻；要常驻请用 constant: true',
    scope: 'worldbook:entries[].keys',
    severity: 'warning',
    category: WB_CATEGORY,
  },
  {
    id: 'builtin:worldbook-selective-without-secondary',
    type: 'list-count',
    min: 1,
    when: { field: 'selective', equals: true },
    message: '世界书{entry}开启了 selective，但没有 secondary_keys',
    hint: 'selective 要求次级关键词同时命中；没有次级关键词时该设置不起作用',
    scope: 'worldbook:entries[].secondary_keys',
    severity: 'warning',
    category: WB_CATEGORY,
  },
  {
    id: 'builtin:worldbook-position-invalid',
    type: 'pattern-required',
    // ST 只认这两个字符值（或数字位置）；空值不算错（缺省由平台补）
    when: { field: 'position', present: true },
    pattern: '^(before_char|after_char|-?\\d+)$',
    message: '世界书{entry}的 position 取值不在 SillyTavern 规范内（{value}）',
    hint: '规范值为 before_char / after_char；旧数据里的数字位置也接受',
    scope: 'worldbook:entries[].position',
    severity: 'warning',
    category: WB_CATEGORY,
  },
  {
    id: 'builtin:worldbook-insertion-order-negative',
    type: 'number-range',
    min: 0,
    when: { field: 'insertion_order', present: true },
    message: '世界书{entry}的 insertion_order 是负数（{value}）',
    hint: '插入顺序用非负整数表示优先级，负数在部分前端会被截断成 0',
    scope: 'worldbook:entries[].insertion_order',
    severity: 'warning',
    category: WB_CATEGORY,
  },
];

/** 内置规则的 id 集合（用户覆盖/禁用时按它校验"改的是不是内置那一条"） */
export const DEFAULT_WORLDBOOK_RULE_IDS: readonly string[] = DEFAULT_WORLDBOOK_RULES.map((rule) => rule.id);

/** 规则是否属于世界书条目域（由世界书规则集统一求值） */
export function isWorldbookScopedRule(rule: ContentRule): boolean {
  const selectors = Array.isArray(rule.scope) ? rule.scope : [rule.scope];
  return selectors.some((selector) => selector.startsWith('worldbook:entries[].'));
}

/**
 * 合并「默认集 + 用户在平台规则里写的世界书规则」。
 *
 * 合并规则与平台规则继承链一致：**同 id 后写覆盖前写**，`enabled: false` 等于禁用，
 * 新 id 追加。这样用户不必理解两套语义，只记住"同 id 就是改它"。
 */
export function mergeWorldbookRules(userRules: readonly ContentRule[]): ContentRule[] {
  const byId = new Map<string, ContentRule>();
  for (const rule of DEFAULT_WORLDBOOK_RULES) byId.set(rule.id, rule);
  for (const rule of userRules) {
    // 只接管世界书域的规则：`worldbook:entries[].*` 选择器，或复用了内置 id。
    // 不设这道门的话，用户的普通板块规则会被塞进世界书评估路径，凭空多出一堆条目级问题。
    if (!isWorldbookScopedRule(rule) && !byId.has(rule.id)) continue;
    byId.set(rule.id, rule);
  }
  return [...byId.values()].filter((rule) => rule.enabled !== false);
}

/** 规则集是否全部被禁用（UI 用来显示"世界书校验已关闭"） */
export function isWorldbookRuleSetEmpty(rules: readonly ContentRule[]): boolean {
  return mergeWorldbookRules(rules).length === 0;
}
