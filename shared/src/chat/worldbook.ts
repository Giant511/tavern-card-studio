/**
 * 世界书（World Info）纯逻辑（2026-11-04，用户要求「实现原生 ST 的对应可实现的所有功能」）。
 *
 * ## 什么是世界书
 *
 * 一组「关键词 → 内容」的条目。聊天里出现关键词时，对应条目被插入上下文。
 * 用户用它给角色加背景设定、地名、专有名词解释。
 *
 * ## 这里做什么、不做什么
 *
 * ```text
 * 做：条目模型、增删改、启用/禁用、关键词解析、整份写回的 payload
 * 不做：界面（worldbook-page.ts）、网络（st-bridge.ts）
 * ```
 *
 * ## 为什么字段这么多，而且必须**原样保留**
 *
 * ST 的条目有 31 个字段（`uid` `key` `content` `order` `position` `depth`
 * `probability` `group` …）。我们只编辑其中一部分，其余**一个都不能丢**：
 * 写回是**整份覆盖**（§93），少一个字段就等于把它删了。
 *
 * 所以模型用「已知字段 + `extra` 原样桶」：
 * 认识的字段参与编辑，不认识/暂不编辑的整体塞进 `extra` 原样带回去。
 * 这样以后 ST 加新字段也不会被我们写丢。
 */

/** 插入位置（ST 的 `position` 常量） */
export const WORLD_POSITION = {
  /** 角色定义之前 */
  beforeChar: 0,
  /** 角色定义之后 */
  afterChar: 1,
  /** 作者注释顶部 */
  topAN: 2,
  /** 作者注释底部 */
  bottomAN: 3,
  /** 按深度插进 @D */
  atDepth: 4,
  /** 示例消息顶部 */
  topEM: 5,
  /** 示例消息底部 */
  bottomEM: 6,
} as const;

export type WorldPosition = (typeof WORLD_POSITION)[keyof typeof WORLD_POSITION];

/** 给用户看的插入位置说法（不出现 ST 常量名） */
export const WORLD_POSITION_OPTIONS: ReadonlyArray<{ value: WorldPosition; label: string }> = [
  { value: WORLD_POSITION.beforeChar, label: '角色设定之前' },
  { value: WORLD_POSITION.afterChar, label: '角色设定之后' },
  { value: WORLD_POSITION.topAN, label: '作者注释上方' },
  { value: WORLD_POSITION.bottomAN, label: '作者注释下方' },
  { value: WORLD_POSITION.atDepth, label: '按深度插入对话' },
  { value: WORLD_POSITION.topEM, label: '示例消息上方' },
  { value: WORLD_POSITION.bottomEM, label: '示例消息下方' },
];

/** 一条世界书条目（只建模我们真的会编辑的字段） */
export interface WorldEntry {
  uid: number;
  /** 主关键词。命中任意一个就触发 */
  keys: string[];
  /** 次关键词：要和主关键词同时出现才触发（空 = 不看） */
  secondaryKeys: string[];
  /** 备注（列表里显示的名字） */
  comment: string;
  content: string;
  /**
   * 常驻：不看关键词，永远插入。
   *
   * 与 `selective` 是两个独立开关，用户常混。常驻条目会**永久吃掉**
   * 上下文预算，启用前要让人知道代价。
   */
  constant: boolean;
  /** 选择性：只有主+次关键词都命中才触发（`constant` 为真时无效） */
  selective: boolean;
  /** 禁用：留在这本世界书里但不参与匹配 */
  disabled: boolean;
  /** 插入顺序（越大越靠后） */
  order: number;
  /** 插入位置 */
  position: number;
  /** 深度（`position` 为按深度插入时才有意义） */
  depth: number;
  /** 触发概率（0–100）。100 = 必触发 */
  probability: number;
  /** 是否用概率（关掉则视为 100） */
  useProbability: boolean;
  /** 分组名（同组条目只取一条） */
  group: string;
  /** 分组权重（组内挑选时的权重） */
  groupWeight: number;
  /**
   * 不参与编辑的原始字段。
   *
   * 写回时**原样并回**。`scanDepth` / `caseSensitive` / `matchWholeWords` /
   * `useGroupScoring` / `role` / `automationId` 这些现在不在界面上露面，
   * 但一个都不能丢 —— 丢了等于帮用户改了设置。
   */
  extra: Record<string, unknown>;
}

/** 一本世界书的全局激活设置（ST 的 `world_info` 顶层那组） */
export interface WorldGlobalSettings {
  /** 扫描深度：往回看几条消息找关键词 */
  scanDepth: number;
  /** 上下文百分比：世界书最多能占上下文的百分之几 */
  contextPercent: number;
  /** Token 预算上限。0 = 按百分比算 */
  budgetCap: number;
  /** 最小激活数：至少插几条（不足时按顺序补） */
  minActivations: number;
  /** 最大深度：扫描最多回溯多少条 */
  maxDepth: number;
  /** 最大递归深度：条目内容里出现的关键词能再触发几层 */
  maxRecursionDepth: number;
  /** 包括名称：把角色名/人设名也算作关键词 */
  includeNames: boolean;
  /** 递归扫描：允许条目内容触发别的条目 */
  recursive: boolean;
  /** 区分大小写 */
  caseSensitive: boolean;
  /** 匹配整个单词 */
  matchWholeWords: boolean;
  /** 使用群组评分 */
  useGroupScoring: boolean;
  /** 溢出警报：超出预算时提醒 */
  overflowAlert: boolean;
  /** 插入策略 */
  insertionStrategy: 'evenly' | 'character_first' | 'global_first';
}

export const DEFAULT_GLOBAL_SETTINGS: WorldGlobalSettings = {
  scanDepth: 2,
  contextPercent: 25,
  budgetCap: 0,
  minActivations: 0,
  maxDepth: 0,
  maxRecursionDepth: 0,
  includeNames: true,
  recursive: true,
  caseSensitive: false,
  matchWholeWords: true,
  useGroupScoring: false,
  overflowAlert: false,
  insertionStrategy: 'character_first',
};

export const INSERTION_STRATEGY_OPTIONS: ReadonlyArray<{
  value: WorldGlobalSettings['insertionStrategy'];
  label: string;
}> = [
  { value: 'character_first', label: '角色世界书优先' },
  { value: 'global_first', label: '全局世界书优先' },
  { value: 'evenly', label: '平均分配' },
];

/* ───────────────────────── 解析 ───────────────────────── */

/** 只留字符串，去掉空串与首尾空白 */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** 参与编辑的字段名（其余全部进 `extra`） */
const KNOWN_FIELDS = new Set([
  'uid',
  'key',
  'keysecondary',
  'comment',
  'content',
  'constant',
  'selective',
  'disable',
  'order',
  'position',
  'depth',
  'probability',
  'useProbability',
  'group',
  'groupWeight',
]);

/**
 * 把 ST 的一条原始条目解析成 `WorldEntry`。
 *
 * **不认识的字段一律进 `extra`**，不在解析阶段丢弃任何东西 ——
 * 写回时还要原样带回去。
 */
export function parseWorldEntry(raw: unknown, fallbackUid: number): WorldEntry | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const one = raw as Record<string, unknown>;

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(one)) {
    if (!KNOWN_FIELDS.has(key)) extra[key] = value;
  }

  return {
    uid: num(one['uid'], fallbackUid),
    keys: stringList(one['key']),
    secondaryKeys: stringList(one['keysecondary']),
    comment: typeof one['comment'] === 'string' ? one['comment'] : '',
    content: typeof one['content'] === 'string' ? one['content'] : '',
    constant: bool(one['constant'], false),
    selective: bool(one['selective'], true),
    disabled: bool(one['disable'], false),
    order: num(one['order'], 100),
    position: num(one['position'], WORLD_POSITION.beforeChar),
    depth: num(one['depth'], 4),
    probability: num(one['probability'], 100),
    useProbability: bool(one['useProbability'], true),
    group: typeof one['group'] === 'string' ? one['group'] : '',
    groupWeight: num(one['groupWeight'], 100),
    extra,
  };
}

export interface ParsedWorldbook {
  /** 条目（按 `order` 升序、同序按 uid） */
  entries: WorldEntry[];
  /** 解析中跳过的坏条目数（不是 0 时要告诉用户） */
  skipped: number;
}

/** 解析 `{ entries: { "0": {...}, ... } }` */
export function parseWorldbook(raw: unknown): ParsedWorldbook {
  const out: WorldEntry[] = [];
  let skipped = 0;

  const container =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)['entries']
      : null;

  if (container !== null && typeof container === 'object' && !Array.isArray(container)) {
    let index = 0;
    for (const [key, value] of Object.entries(container as Record<string, unknown>)) {
      const asNumber = Number(key);
      const entry = parseWorldEntry(value, Number.isFinite(asNumber) ? asNumber : index);
      if (entry === null) skipped += 1;
      else out.push(entry);
      index += 1;
    }
  } else if (Array.isArray(container)) {
    /* 少数工具导出的是数组；按顺序给 uid */
    container.forEach((value, index) => {
      const entry = parseWorldEntry(value, index);
      if (entry === null) skipped += 1;
      else out.push(entry);
    });
  }

  out.sort((a, b) => (a.order === b.order ? a.uid - b.uid : a.order - b.order));
  return { entries: out, skipped };
}

/**
 * 把 `WorldEntry` 还原成 ST 的原始条目对象。
 *
 * `extra` 先铺底，已知字段覆盖在上面 —— 顺序很重要：
 * 反过来会让 `extra` 里的同名旧值盖掉用户刚改的字段。
 */
export function serializeWorldEntry(entry: WorldEntry): Record<string, unknown> {
  return {
    ...entry.extra,
    uid: entry.uid,
    key: entry.keys,
    keysecondary: entry.secondaryKeys,
    comment: entry.comment,
    content: entry.content,
    constant: entry.constant,
    selective: entry.selective,
    disable: entry.disabled,
    order: entry.order,
    position: entry.position,
    depth: entry.depth,
    probability: entry.probability,
    useProbability: entry.useProbability,
    group: entry.group,
    groupWeight: entry.groupWeight,
  };
}

/**
 * 整份写回用的 payload（`{ entries: { "uid": {...} } }`）。
 *
 * ## 为什么键是 `uid` 而不是数组下标
 *
 * ST 用 `uid` 做键，界面上「条目 3」也指着同一个 `uid`。
 * 用下标的话删掉一条之后，其余条目的键全部前移 ——
 * 用户保存后再打开会发现"改的是另一条"。
 */
export function serializeWorldbook(entries: readonly WorldEntry[]): {
  entries: Record<string, unknown>;
} {
  const out: Record<string, unknown> = {};
  for (const entry of entries) out[String(entry.uid)] = serializeWorldEntry(entry);
  return { entries: out };
}

/* ───────────────────────── 编辑操作 ───────────────────────── */

/** 下一个可用的 uid（现有最大 + 1；空书从 0 开始） */
export function nextUid(entries: readonly WorldEntry[]): number {
  let max = -1;
  for (const entry of entries) if (entry.uid > max) max = entry.uid;
  return max + 1;
}

/** 新建一条空条目 */
export function makeEntry(entries: readonly WorldEntry[]): WorldEntry {
  return {
    uid: nextUid(entries),
    keys: [],
    secondaryKeys: [],
    comment: '',
    content: '',
    constant: false,
    selective: true,
    disabled: false,
    order: 100,
    position: WORLD_POSITION.beforeChar,
    depth: 4,
    probability: 100,
    useProbability: true,
    group: '',
    groupWeight: 100,
    extra: {},
  };
}

/** 改一条（按 uid 定位；找不到就原样返回，不静默新建） */
export function updateEntry(
  entries: readonly WorldEntry[],
  uid: number,
  patch: Partial<Omit<WorldEntry, 'uid'>>,
): WorldEntry[] {
  return entries.map((entry) => (entry.uid === uid ? { ...entry, ...patch, uid: entry.uid } : entry));
}

/** 删一条 */
export function removeEntry(entries: readonly WorldEntry[], uid: number): WorldEntry[] {
  return entries.filter((entry) => entry.uid !== uid);
}

/** 开关某一条的启用状态 */
export function toggleEntry(entries: readonly WorldEntry[], uid: number): WorldEntry[] {
  return entries.map((entry) =>
    entry.uid === uid ? { ...entry, disabled: !entry.disabled } : entry,
  );
}

/**
 * 把用户输入的关键词串拆成数组。
 *
 * 分隔符认三种：英文逗号、中文逗号、换行。用户在手机上打中文逗号很常见，
 * 只认英文逗号会得到一整个长关键词（然后永远匹配不上）。
 */
export function parseKeywordInput(text: string): string[] {
  return text
    .split(/[,，\n]/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** 关键词数组 → 输入框里显示的一行 */
export function formatKeywordInput(keys: readonly string[]): string {
  return keys.join('，');
}

/* ───────────────────────── 校验 ───────────────────────── */

export interface WorldbookProblem {
  uid: number;
  /** 给人看的一句话 */
  message: string;
}

/**
 * 保存前的检查。
 *
 * 只报**真正会导致"配了不生效"**的情况 —— 不报"最好再补点什么"，
 * 那类提醒多了以后用户会全部忽略。
 */
export function checkWorldbook(entries: readonly WorldEntry[]): WorldbookProblem[] {
  const problems: WorldbookProblem[] = [];
  const seen = new Map<string, number>();

  for (const entry of entries) {
    if (entry.disabled) continue;

    /* 没内容：插进上下文也是空的 */
    if (entry.content.trim() === '') {
      problems.push({ uid: entry.uid, message: '这条没有内容，启用也不会起作用' });
      continue;
    }

    /*
     * 既非常驻、又没有关键词 ⇒ 永远不会触发。
     * 这是最常见的"我加了条目但没效果"。
     */
    if (!entry.constant && entry.keys.length === 0) {
      problems.push({ uid: entry.uid, message: '既没设关键词也不是常驻，永远不会触发' });
    }

    /* 关键词重复：两条争同一个词，只有 order 靠前的生效 —— 几乎总是笔误 */
    for (const key of entry.keys) {
      const normalized = key.toLowerCase();
      const prev = seen.get(normalized);
      if (prev !== undefined) {
        problems.push({ uid: entry.uid, message: `关键词「${key}」和第 ${prev} 条重复` });
      } else {
        seen.set(normalized, entry.uid);
      }
    }
  }

  return problems;
}

/** 一本世界书在列表里的一句话摘要 */
export function describeWorldbook(entries: readonly WorldEntry[]): string {
  if (entries.length === 0) return '还没有条目';
  const enabled = entries.filter((entry) => !entry.disabled).length;
  const constant = entries.filter((entry) => entry.constant && !entry.disabled).length;
  const parts = [`${String(entries.length)} 条`];
  if (enabled !== entries.length) parts.push(`${String(enabled)} 条启用`);
  if (constant > 0) parts.push(`${String(constant)} 条常驻`);
  return parts.join(' · ');
}

/* ───────────────────── 全局设置的读取（ST 的实际字段名） ───────────────────── */

/**
 * 从引擎设置里读出全局激活设置。
 *
 * ## ST 的实际字段名不是我们模型里的名字
 *
 * ```text
 *   我们           ST（settings.world_info）
 *   scanDepth      depth
 *   contextPercent budget.percent
 *   budgetCap      budget.cap
 *   ...
 * ```
 *
 * 这个映射只该有一份。写在两处（读一处、写一处）必然分叉，而分叉的后果是
 * "改了保存了，重进又变回去" —— 用户完全看不出发生了什么。
 *
 * 缺字段一律用默认值：**不猜**。猜错的值会让"扫描深度"这类数字
 * 在第一次打开时就是错的，而用户以为那是他自己的设置。
 */
export function readWorldSettings(group: Record<string, unknown>): WorldGlobalSettings {
  const budget =
    group['budget'] !== null && typeof group['budget'] === 'object' && !Array.isArray(group['budget'])
      ? (group['budget'] as Record<string, unknown>)
      : {};

  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const bool = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback;

  const strategyRaw = group['insertion_strategy'];
  const strategy =
    strategyRaw === 'evenly' || strategyRaw === 'global_first' || strategyRaw === 'character_first'
      ? strategyRaw
      : DEFAULT_GLOBAL_SETTINGS.insertionStrategy;

  return {
    scanDepth: num(group['depth'], DEFAULT_GLOBAL_SETTINGS.scanDepth),
    contextPercent: num(budget['percent'], DEFAULT_GLOBAL_SETTINGS.contextPercent),
    budgetCap: num(budget['cap'], DEFAULT_GLOBAL_SETTINGS.budgetCap),
    minActivations: num(budget['minActivations'], DEFAULT_GLOBAL_SETTINGS.minActivations),
    maxDepth: num(budget['maxDepth'], DEFAULT_GLOBAL_SETTINGS.maxDepth),
    maxRecursionDepth: num(budget['maxRecursionDepth'], DEFAULT_GLOBAL_SETTINGS.maxRecursionDepth),
    includeNames: bool(budget['includeNames'], DEFAULT_GLOBAL_SETTINGS.includeNames),
    recursive: bool(budget['recursive'], DEFAULT_GLOBAL_SETTINGS.recursive),
    overflowAlert: bool(budget['overflowAlert'], DEFAULT_GLOBAL_SETTINGS.overflowAlert),
    caseSensitive: bool(group['case_sensitive'], DEFAULT_GLOBAL_SETTINGS.caseSensitive),
    matchWholeWords: bool(group['match_whole_words'], DEFAULT_GLOBAL_SETTINGS.matchWholeWords),
    useGroupScoring: bool(group['use_group_scoring'], DEFAULT_GLOBAL_SETTINGS.useGroupScoring),
    insertionStrategy: strategy,
  };
}

/**
 * 把我们的模型还原成 ST 的 `world_info` 字段（只含我们负责的项）。
 *
 * 返回的是**要合并进去的那几项**，不是整组 —— 调用方负责
 * `{...原有, ...这一份}`，这样别的字段（例如 `globalSelect`）不会被清掉。
 */
export function writeWorldSettings(
  next: WorldGlobalSettings,
): Record<string, unknown> {
  return {
    depth: next.scanDepth,
    case_sensitive: next.caseSensitive,
    match_whole_words: next.matchWholeWords,
    use_group_scoring: next.useGroupScoring,
    insertion_strategy: next.insertionStrategy,
    budget: {
      percent: next.contextPercent,
      cap: next.budgetCap,
      minActivations: next.minActivations,
      maxDepth: next.maxDepth,
      maxRecursionDepth: next.maxRecursionDepth,
      includeNames: next.includeNames,
      recursive: next.recursive,
      overflowAlert: next.overflowAlert,
    },
  };
}
