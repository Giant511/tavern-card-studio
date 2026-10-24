/**
 * 世界书 TXT 格式预设（T10.31，格式轨）。
 *
 * ## 为什么要参数化
 *
 * docs/04 冻结的 v1.0 格式（`@@ENTRY 0` / `@@CONTENT` / `@@END 0` + `字段: 值`）
 * 是**标准**，不是**唯一**。用户的卡可能来自别的工具，标记写成 `[[条目 4]]`、
 * 字段标签写成中文「关键词:」、字段顺序也不同。以前这些只能改代码 —— 那不是用户该付的成本。
 *
 * 所以把「怎么写」抽成参数：开闭标记模板、字段标签映射、字段行顺序、分隔符。
 * 而「写什么」（条目名必填、关键词至少 N 个、触发深度范围）留在平台规则里（语义轨）。
 * 两条轨的分界见 docs/04 §双轨制。
 *
 * ## 冻结语义（重要，别改）
 *
 * **冻结的是 `default` 预设的参数值，不是"格式不可参数化"这件事。**
 * `DEFAULT_WORLDBOOK_FORMAT` 必须让 `renderWorldbookText` 的输出与 v1.0 规范
 * **逐字节相同** —— `test/worldbook-preset.test.mjs` 的第一条铁律测试守它。
 * 也就是说：参数化本身是零风险的重构，风险全在"`default` 的参数写错"，
 * 而那个用字节比对就能钉死。
 *
 * ## 参数与"括号"的对应
 *
 * 需求里说的「开闭括号」在世界书格式里就是三个标记行：
 * 条目开标记、正文标记、条目闭标记。它们都支持 `{id}` 占位符。
 */

/** 世界书 TXT 的可参数化部分；字段名与 docs/04 的 v1.0 字段一一对应 */
export interface WorldbookFormatParams {
  /** 条目开标记模板，必须含 `{id}`，如 `@@ENTRY {id}`、`[[条目 {id}]]` */
  entryOpen: string;
  /** 正文开始标记（整行匹配） */
  contentMark: string;
  /** 条目闭标记模板，必须含 `{id}` */
  entryClose: string;
  /** 字段行顺序；只影响写出，解析按任意顺序都认 */
  fieldOrder: string[];
  /** 字段标签映射：字段键 → TXT 里的标签文字。未列出的键用键名本身 */
  labelMap: Record<string, string>;
  /** 字段名与值之间的分隔串（默认 `": "`） */
  fieldSeparator: string;
  /** 列表字段（keys / secondary_keys）的项分隔串（默认 `", "`） */
  listSeparator: string;
  /** 条目之间的分隔串（默认两个换行） */
  entrySeparator: string;
}

export interface WorldbookPreset {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  /** 内置预设（界面只读；`default` 必须为 true） */
  builtin?: boolean;
  format: WorldbookFormatParams;
  meta?: { author?: string; updatedAt?: string };
}

export interface WorldbookPresetParseResult {
  preset: WorldbookPreset | null;
  errors: string[];
  warnings: string[];
}

/** v1.0 冻结字段顺序（docs/04）。也是 `default` 预设的 fieldOrder */
export const WORLDBOOK_FIELD_ORDER_V1 = [
  'name',
  'keys',
  'secondary_keys',
  'constant',
  'enabled',
  'insertion_order',
  'position',
  'priority',
  'case_sensitive',
  'selective',
  'comment',
] as const;

/** 解析时认识的字段（写出顺序由 fieldOrder 决定，这里是白名单） */
export const WORLDBOOK_KNOWN_FIELDS = [
  ...WORLDBOOK_FIELD_ORDER_V1,
  'content',
] as const;

/**
 * v1.0 冻结参数。**改动任何一个字符串都等于改了冻结格式** ——
 * 铁律测试会立刻变红，这是刻意的。
 */
export const DEFAULT_WORLDBOOK_FORMAT: WorldbookFormatParams = {
  entryOpen: '@@ENTRY {id}',
  contentMark: '@@CONTENT',
  entryClose: '@@END {id}',
  fieldOrder: [...WORLDBOOK_FIELD_ORDER_V1],
  labelMap: {},
  fieldSeparator: ': ',
  listSeparator: ', ',
  entrySeparator: '\n\n',
};

export const DEFAULT_WORLDBOOK_PRESET: WorldbookPreset = {
  schemaVersion: 1,
  id: 'default',
  name: '标准世界书（v1.0 冻结）',
  version: '1.0.0',
  description: 'docs/04 冻结的 @@ENTRY / @@CONTENT / @@END 格式，字段标签即字段名。',
  builtin: true,
  format: DEFAULT_WORLDBOOK_FORMAT,
};

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const ID_TOKEN = '{id}';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 预设里出现、但 v1.0 不认识的格式键 → 走 F4 的未知键 warning（不阻断） */
const FORMAT_KEYS = [
  'entryOpen',
  'contentMark',
  'entryClose',
  'fieldOrder',
  'labelMap',
  'fieldSeparator',
  'listSeparator',
  'entrySeparator',
] as const;

const PRESET_KEYS = ['$schema', 'schemaVersion', 'id', 'name', 'version', 'description', 'builtin', 'format', 'meta'] as const;

/** 预设参数的白名单（供客户端与测试复用，避免两处各写一份） */
export const WORLDBOOK_PRESET_KEYS = PRESET_KEYS;
export const WORLDBOOK_FORMAT_KEYS = FORMAT_KEYS;

export function suggestSimilarKey(unknown: string, allowed: readonly string[]): string | null {
  // 局部实现，避免 format 层反向依赖 rules 层（unknown-keys 在 rules 下，
  // 而 format 被 rules 依赖 —— 反向 import 会形成环）。
  const lower = unknown.toLowerCase();
  let best: { key: string; distance: number } | null = null;
  for (const key of allowed) {
    const target = key.toLowerCase();
    const distance = distanceOf(lower, target);
    const limit = target.length <= 4 ? 1 : 2;
    if (distance <= limit && (best === null || distance < best.distance)) best = { key, distance };
  }
  return best?.key ?? null;
}

/** Damerau-Levenshtein（相邻互换算 1 步），与 rules/unknown-keys.ts 的实现同源 */
function distanceOf(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) matrix[i]![0] = i;
  for (let j = 0; j < cols; j += 1) matrix[0]![j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(matrix[i - 1]![j]! + 1, matrix[i]![j - 1]! + 1, matrix[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, matrix[i - 2]![j - 2]! + 1);
      }
      matrix[i]![j] = value;
    }
  }
  return matrix[rows - 1]![cols - 1]!;
}

/** 校验并规范化（缺省参数按 v1.0 补齐；`builtin` 缺省为 false —— 用户导入的一定不是内置） */
export function parseWorldbookPreset(input: unknown): WorldbookPresetParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isObject(input)) return { preset: null, errors: ['世界书预设顶层必须是对象'], warnings };
  if (input['schemaVersion'] !== 1) errors.push('schemaVersion 必须为 1');
  if (typeof input['id'] !== 'string' || !ID_PATTERN.test(input['id'])) {
    errors.push('id 不合法（小写字母/数字/._-，2-64 位）');
  }
  if (typeof input['name'] !== 'string' || input['name'].trim() === '') errors.push('name 不能为空');
  if (typeof input['version'] !== 'string' || !VERSION_PATTERN.test(input['version'])) {
    errors.push('version 必须是 x.y.z');
  }

  for (const key of Object.keys(input)) {
    if ((PRESET_KEYS as readonly string[]).includes(key)) continue;
    const suggestion = suggestSimilarKey(key, PRESET_KEYS);
    warnings.push(
      suggestion === null
        ? `未知字段 ${key}（不在规范内，已忽略）`
        : `未知字段 ${key}（已忽略）—— 是不是想写 ${suggestion}？`,
    );
  }

  const rawFormat = input['format'];
  if (!isObject(rawFormat)) {
    errors.push('format 必须是对象（至少给出 entryOpen / contentMark / entryClose）');
    return { preset: null, errors, warnings };
  }

  for (const key of Object.keys(rawFormat)) {
    if ((FORMAT_KEYS as readonly string[]).includes(key)) continue;
    const suggestion = suggestSimilarKey(key, FORMAT_KEYS);
    warnings.push(
      suggestion === null
        ? `未知字段 format.${key}（不在规范内，已忽略）`
        : `未知字段 format.${key}（已忽略）—— 是不是想写 format.${suggestion}？`,
    );
  }

  const template = (key: 'entryOpen' | 'entryClose'): string => {
    const value = rawFormat[key];
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`format.${key} 必须是非空字符串`);
      return DEFAULT_WORLDBOOK_FORMAT[key];
    }
    if (!value.includes(ID_TOKEN)) {
      errors.push(`format.${key} 必须含 ${ID_TOKEN} 占位符（否则条目 id 无处可写，round-trip 会丢 id）`);
      return DEFAULT_WORLDBOOK_FORMAT[key];
    }
    if (value.includes('\n') || value.includes('\r')) {
      errors.push(`format.${key} 不能含换行（标记必须是一整行）`);
      return DEFAULT_WORLDBOOK_FORMAT[key];
    }
    return value;
  };

  const entryOpen = template('entryOpen');
  const entryClose = template('entryClose');

  const contentMark = rawFormat['contentMark'];
  let contentMarkText = DEFAULT_WORLDBOOK_FORMAT.contentMark;
  if (typeof contentMark !== 'string' || contentMark.trim() === '') {
    errors.push('format.contentMark 必须是非空字符串');
  } else if (/\r|\n/.test(contentMark)) {
    errors.push('format.contentMark 不能含换行');
  } else {
    contentMarkText = contentMark;
  }

  // 三个标记必须互不相同，否则解析无法判定"这一行到底是什么"
  const marks = [
    ['entryOpen', entryOpen.replace(ID_TOKEN, '')],
    ['contentMark', contentMarkText],
    ['entryClose', entryClose.replace(ID_TOKEN, '')],
  ] as const;
  for (let i = 0; i < marks.length; i += 1) {
    for (let j = i + 1; j < marks.length; j += 1) {
      if (marks[i]![1].trim() === marks[j]![1].trim()) {
        errors.push(`format.${marks[i]![0]} 与 format.${marks[j]![0]} 的标记文字相同，解析会二义`);
      }
    }
  }

  // 字段顺序：给的是「先写哪些」，没列出的已知字段按 v1.0 顺序补在后面
  const fieldOrder: string[] = [];
  const rawOrder = rawFormat['fieldOrder'];
  if (rawOrder !== undefined) {
    if (!Array.isArray(rawOrder)) {
      errors.push('format.fieldOrder 必须是字符串数组');
    } else {
      for (const item of rawOrder) {
        if (typeof item !== 'string') {
          errors.push(`format.fieldOrder 含非字符串项：${JSON.stringify(item)}`);
          continue;
        }
        if (!(WORLDBOOK_KNOWN_FIELDS as readonly string[]).includes(item)) {
          errors.push(`format.fieldOrder 含未知字段 "${item}"（可选：${WORLDBOOK_KNOWN_FIELDS.join(' / ')}）`);
          continue;
        }
        if (item === 'content') {
          errors.push('format.fieldOrder 不能含 content（正文由 contentMark 分隔，不是字段行）');
          continue;
        }
        if (fieldOrder.includes(item)) errors.push(`format.fieldOrder 中 "${item}" 重复`);
        else fieldOrder.push(item);
      }
    }
  }
  for (const field of WORLDBOOK_FIELD_ORDER_V1) {
    if (!fieldOrder.includes(field)) fieldOrder.push(field);
  }

  // 标签映射：键必须在已知字段内，值不能为空、不能含换行/分隔符
  const labelMap: Record<string, string> = {};
  const rawLabelMap = rawFormat['labelMap'];
  const fieldSeparator = typeof rawFormat['fieldSeparator'] === 'string' ? rawFormat['fieldSeparator'] : DEFAULT_WORLDBOOK_FORMAT.fieldSeparator;
  if (rawLabelMap !== undefined) {
    if (!isObject(rawLabelMap)) {
      errors.push('format.labelMap 必须是对象（字段键 → 标签文字）');
    } else {
      const seenLabels = new Map<string, string>();
      for (const [field, label] of Object.entries(rawLabelMap)) {
        if (!(WORLDBOOK_KNOWN_FIELDS as readonly string[]).includes(field)) {
          errors.push(`format.labelMap 含未知字段 "${field}"`);
          continue;
        }
        if (typeof label !== 'string' || label.trim() === '') {
          errors.push(`format.labelMap.${field} 必须是非空字符串`);
          continue;
        }
        if (/\r|\n/.test(label)) {
          errors.push(`format.labelMap.${field} 不能含换行`);
          continue;
        }
        if (fieldSeparator !== '' && label.includes(fieldSeparator.trim())) {
          errors.push(`format.labelMap.${field} 含字段分隔符 "${fieldSeparator.trim()}"，解析会错位`);
          continue;
        }
        const owner = seenLabels.get(label);
        if (owner && owner !== field) {
          errors.push(`format.labelMap 里 "${label}" 同时给了 ${owner} 与 ${field}，反解会二义`);
        } else {
          seenLabels.set(label, field);
        }
        labelMap[field] = label;
      }
    }
  }

  const rawFieldSeparator = rawFormat['fieldSeparator'];
  if (rawFieldSeparator !== undefined && (typeof rawFieldSeparator !== 'string' || rawFieldSeparator.trim() === '')) {
    errors.push('format.fieldSeparator 必须含冒号或其它可见字符（否则字段名与值无法切分）');
  }
  const listSeparator = rawFormat['listSeparator'];
  if (listSeparator !== undefined && (typeof listSeparator !== 'string' || listSeparator === '')) {
    errors.push('format.listSeparator 必须是非空字符串');
  }
  const entrySeparator = rawFormat['entrySeparator'];
  if (entrySeparator !== undefined && (typeof entrySeparator !== 'string' || !entrySeparator.includes('\n'))) {
    errors.push('format.entrySeparator 必须含换行（否则相邻条目会粘成一行）');
  }

  if (errors.length > 0) return { preset: null, errors, warnings };

  const preset: WorldbookPreset = {
    schemaVersion: 1,
    id: input['id'] as string,
    name: input['name'] as string,
    version: input['version'] as string,
    builtin: input['builtin'] === true,
    format: {
      entryOpen,
      contentMark: contentMarkText,
      entryClose,
      fieldOrder,
      labelMap,
      fieldSeparator: typeof rawFieldSeparator === 'string' ? rawFieldSeparator : DEFAULT_WORLDBOOK_FORMAT.fieldSeparator,
      listSeparator: typeof listSeparator === 'string' ? listSeparator : DEFAULT_WORLDBOOK_FORMAT.listSeparator,
      entrySeparator: typeof entrySeparator === 'string' ? entrySeparator : DEFAULT_WORLDBOOK_FORMAT.entrySeparator,
    },
  };
  if (typeof input['description'] === 'string') preset.description = input['description'];
  if (isObject(input['meta'])) {
    const meta: { author?: string; updatedAt?: string } = {};
    if (typeof input['meta']['author'] === 'string') meta.author = input['meta']['author'];
    if (typeof input['meta']['updatedAt'] === 'string') meta.updatedAt = input['meta']['updatedAt'];
    preset.meta = meta;
  }
  return { preset, errors: [], warnings };
}

/** 标签 → 字段键（解析用）；同一标签只映射一个字段（解析阶段已校验） */
export function reverseLabelMap(params: WorldbookFormatParams): Map<string, string> {
  const map = new Map<string, string>();
  for (const [field, label] of Object.entries(params.labelMap)) map.set(label, field);
  return map;
}

/** 字段键 → 写出时的标签 */
export function labelForField(params: WorldbookFormatParams, field: string): string {
  return params.labelMap[field] ?? field;
}
