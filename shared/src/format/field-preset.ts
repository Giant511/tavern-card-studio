/**
 * 字段板块（初始场景 / 对话示例）的**格式预设**（v0.1.3 / 追加项一）。
 *
 * ## 这两块为什么也需要预设
 *
 * 「初始场景」和「对话示例」不是 description 的分段，它们各自落在独立的 ST 字段上：
 *
 * | 板块 | id | 字段 |
 * |---|---|---|
 * | 初始场景 | `initial-scene` | `first_mes` + `alternate_greetings`（多条用分隔行切分） |
 * | 对话示例 | `chat-examples` | `mes_example` |
 *
 * 只要"一段文本 ↔ 一个（或两个）字段"的映射存在，就存在**写法**问题：
 * 分隔行可以是 `---`、`===` 或 `--- 下一段 ---`；段落也可能带标签行
 * （`【开场白】`）。这些是格式，不是内容，所以与 TXT 预设、世界书预设一样
 * 交给用户用预设换，而不是改代码。
 *
 * ## 与世界书预设完全同构的五条语义
 *
 *   · schema 校验（`schemaVersion` / `id` / `name` / `version` / `block` / `format`）；
 *   · unknown-keys warning（不阻断，但点名并给"是不是想写 xxx"）；
 *   · 同 id 覆盖（由 `client/src/rules/preset-library.ts` 统一实现，本文件只负责解析）；
 *   · 不自动切换（导入 = 加入候选，选中才生效）；
 *   · 原子回退（解析失败时上层原样返回旧列表）。
 *
 * ## 冻结语义（铁律，与世界书预设同一口径）
 *
 * **冻结的是 `default` 预设的参数值，不是"格式不可参数化"这件事。**
 * `DEFAULT_GREETING_PRESET.format` 必须让 `renderGreetings` 的输出与 v0.1.3
 * 已发布的行为**逐字节相同** —— `test/field-preset.test.mjs` 的第一条铁律守它。
 * 所以默认 `labelMap` 是空对象（不写任何标签行），默认 `separator` 就是
 * `DEFAULT_GREETING_FORMAT.separator`。
 *
 * ## 只做格式，不做内容
 *
 * 这两块的**内容**（开场白写得好不好、示例对话是否合理）没有客观标准，
 * 本工具不校验。预设里也不接受任何"内容规则"字段 —— 想约束内容请写平台规则
 * （且需显式 `contentOptIn: true`，见 `shared/src/rules/format-only-blocks.ts`）。
 */

import { BLOCK_DEFINITION_MAP } from '../model/blocks.js';
import { DEFAULT_GREETING_FORMAT, greetingDividerToken } from './greeting-preset.js';
import { suggestSimilarKey } from './worldbook-preset.js';

/** 这两个板块的 id 就是预设的 `block` 取值 */
export type FieldPresetBlock = 'initial-scene' | 'chat-examples';

/** 格式参数；两块共用同一形状，语义按 `block` 区分 */
export interface FieldFormatParams {
  /**
   * 分隔串。
   *
   *   · `initial-scene`：多条开场白之间的分隔（非空、含换行、且必须有一行
   *     非空文字作为识别标记）；冻结默认 `\n\n---\n\n`。
   *   · `chat-examples`：示例对话的**轮次分隔**，仅用于审计统计轮数，
   *     **不改写正文**；空串 = 不切分（冻结默认）。
   */
  separator: string;
  /**
   * 字段标签映射：段角色 → 标签文字。
   *
   *   · `initial-scene`：`first`（第一条开场白）、`alternate`（备用开场白，
   *     支持 `{n}` 占位符，渲染时替换为序号）。
   *   · `chat-examples`：`turn`（轮次的称呼，用于审计文案）。
   *
   * **空对象 = 不写标签、不认标签**，即 v0.1.3 已发布的行为。
   */
  labelMap: Record<string, string>;
}

export interface FieldPreset {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  /** 内置预设（界面只读；`default` 必须为 true） */
  builtin?: boolean;
  /** 这个预设只能用于哪个板块 —— 防止"把对话示例预设套到初始场景上" */
  block: FieldPresetBlock;
  format: FieldFormatParams;
  meta?: { author?: string; updatedAt?: string };
}

export interface FieldPresetParseResult {
  preset: FieldPreset | null;
  errors: string[];
  warnings: string[];
}

/** 每个板块允许的标签键（不在表里的键一律报错，避免"写了个不生效的标签"） */
export const FIELD_PRESET_LABEL_KEYS: Readonly<Record<FieldPresetBlock, readonly string[]>> = {
  'initial-scene': ['first', 'alternate'],
  'chat-examples': ['turn'],
};

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export const FIELD_PRESET_KEYS = [
  '$schema',
  'schemaVersion',
  'id',
  'name',
  'version',
  'description',
  'builtin',
  'block',
  'format',
  'meta',
] as const;

export const FIELD_FORMAT_KEYS = ['separator', 'labelMap'] as const;

/**
 * 冻结的默认预设（两块各一份）。
 *
 * `initial-scene` 的 separator 直接取 `DEFAULT_GREETING_FORMAT.separator` ——
 * **不在两处各写一遍字符串**：那样改了一处就成了"默认值有两个"，铁律测试
 * 只能守住其中一个。
 */
export const DEFAULT_GREETING_PRESET: FieldPreset = {
  schemaVersion: 1,
  id: 'default',
  name: '标准初始场景（v0.1.3 冻结）',
  version: '1.0.0',
  description: '多条开场白用空行 + --- + 空行切分，不写段标签。等价于逐字节的既有行为。',
  builtin: true,
  block: 'initial-scene',
  format: { separator: DEFAULT_GREETING_FORMAT.separator, labelMap: {} },
};

export const DEFAULT_CHAT_EXAMPLES_PRESET: FieldPreset = {
  schemaVersion: 1,
  id: 'default',
  name: '标准对话示例（v0.1.3 冻结）',
  version: '1.0.0',
  description: '示例对话按原文整段保存（mes_example），不切分轮次、不写标签。',
  builtin: true,
  block: 'chat-examples',
  format: { separator: '', labelMap: {} },
};

/** 板块 → 默认预设 */
export const DEFAULT_FIELD_PRESETS: Readonly<Record<FieldPresetBlock, FieldPreset>> = {
  'initial-scene': DEFAULT_GREETING_PRESET,
  'chat-examples': DEFAULT_CHAT_EXAMPLES_PRESET,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  warnings: string[],
): void {
  for (const key of Object.keys(value)) {
    if ((allowed as readonly string[]).includes(key)) continue;
    const suggestion = suggestSimilarKey(key, allowed);
    const prefix = where === '' ? '' : `${where}.`;
    warnings.push(
      suggestion === null
        ? `未知字段 ${prefix}${key}（不在规范内，已忽略）`
        : `未知字段 ${prefix}${key}（已忽略）—— 是不是想写 ${prefix}${suggestion}？`,
    );
  }
}

/**
 * 校验并规范化一份字段板块预设。
 *
 * @param input 解析后的 JSON
 * @param expectedBlock 传了就校验 `block` 是否匹配（导入时按入口区分，
 *   防止用户把「对话示例预设」导进「初始场景」那一栏，之后一脸困惑）
 */
export function parseFieldPreset(input: unknown, expectedBlock?: FieldPresetBlock): FieldPresetParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isObject(input)) return { preset: null, errors: ['预设文件顶层必须是对象'], warnings };
  collectUnknownKeys(input, FIELD_PRESET_KEYS, '', warnings);

  if (input['schemaVersion'] !== 1) errors.push('schemaVersion 必须为 1');
  if (typeof input['id'] !== 'string' || !ID_PATTERN.test(input['id'])) {
    errors.push('id 不合法（小写字母/数字/._-，2-64 位）');
  }
  if (typeof input['name'] !== 'string' || input['name'].trim() === '') errors.push('name 不能为空');
  if (typeof input['version'] !== 'string' || !VERSION_PATTERN.test(input['version'])) {
    errors.push('version 必须是 x.y.z');
  }

  const block = input['block'];
  if (block !== 'initial-scene' && block !== 'chat-examples') {
    errors.push('block 必须是 "initial-scene" 或 "chat-examples"（决定这份预设能用在哪）');
  } else if (expectedBlock !== undefined && block !== expectedBlock) {
    errors.push(
      `这份预设是给「${BLOCK_DEFINITION_MAP[block].label}」用的，不能导入到「${
        BLOCK_DEFINITION_MAP[expectedBlock].label
      }」`,
    );
  }

  const rawFormat = input['format'];
  if (!isObject(rawFormat)) {
    errors.push('format 必须是对象（至少给出 separator 与 labelMap）');
    return { preset: null, errors, warnings };
  }
  collectUnknownKeys(rawFormat, FIELD_FORMAT_KEYS, 'format', warnings);

  const resolvedBlock: FieldPresetBlock =
    block === 'chat-examples' ? 'chat-examples' : 'initial-scene';

  // ── separator ────────────────────────────────────────────
  let separator = '';
  const rawSeparator = rawFormat['separator'];
  if (rawSeparator === undefined) {
    separator = DEFAULT_FIELD_PRESETS[resolvedBlock].format.separator;
  } else if (typeof rawSeparator !== 'string') {
    errors.push('format.separator 必须是字符串');
  } else if (rawSeparator === '') {
    // 空串只有一个合法含义：「不切分」。它只对对话示例成立 ——
    // 初始场景空串会让多条开场白无处安放，那属于配置错误。
    if (resolvedBlock === 'initial-scene') {
      errors.push('format.separator 不能为空（初始场景需要它切分多条开场白）');
    } else {
      separator = '';
    }
  } else if (!rawSeparator.includes('\n')) {
    errors.push('format.separator 必须含换行，否则相邻段落会粘在同一行');
  } else if (greetingDividerToken(rawSeparator) === null) {
    errors.push('format.separator 必须有一行非空文字作为识别标记（例如 "\\n\\n---\\n\\n"）');
  } else {
    separator = rawSeparator;
  }

  // ── labelMap ─────────────────────────────────────────────
  const labelMap: Record<string, string> = {};
  const rawLabelMap = rawFormat['labelMap'];
  if (rawLabelMap !== undefined) {
    if (!isObject(rawLabelMap)) {
      errors.push('format.labelMap 必须是对象（角色 → 标签文字）');
    } else {
      const allowed = FIELD_PRESET_LABEL_KEYS[resolvedBlock];
      const seen = new Map<string, string>();
      for (const [role, label] of Object.entries(rawLabelMap)) {
        if (!allowed.includes(role)) {
          errors.push(
            `format.labelMap 含未知角色 "${role}"（${BLOCK_DEFINITION_MAP[resolvedBlock].label}可用：${allowed.join(' / ')}）`,
          );
          continue;
        }
        if (typeof label !== 'string' || label.trim() === '') {
          errors.push(`format.labelMap.${role} 必须是非空字符串`);
          continue;
        }
        if (/[\r\n]/.test(label)) {
          errors.push(`format.labelMap.${role} 不能含换行（标签必须是单独一行）`);
          continue;
        }
        // 标签文字若与分隔标记同形，解析会二义（既像标签又像分隔行）
        const token = greetingDividerToken(separator);
        if (token !== null && label.trim() === token) {
          errors.push(`format.labelMap.${role} 与 separator 的识别标记 "${token}" 相同，解析会二义`);
          continue;
        }
        const owner = seen.get(label);
        if (owner !== undefined && owner !== role) {
          errors.push(`format.labelMap 里 "${label}" 同时给了 ${owner} 与 ${role}，反解会二义`);
        } else {
          seen.set(label, role);
        }
        labelMap[role] = label;
      }
    }
  }

  if (errors.length === 0 && resolvedBlock === 'chat-examples' && separator !== '' && Object.keys(labelMap).length === 0) {
    // 不是错误，只是提醒：设了轮次分隔却没有任何标签，说明只想要"数轮数"。
    warnings.push('已设置轮次分隔但没给 labelMap.turn：审计文案会用默认的「轮」称呼');
  }

  if (errors.length > 0) return { preset: null, errors, warnings };

  const preset: FieldPreset = {
    schemaVersion: 1,
    id: input['id'] as string,
    name: input['name'] as string,
    version: input['version'] as string,
    builtin: input['builtin'] === true,
    block: resolvedBlock,
    format: { separator, labelMap },
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

export interface EffectiveGreetingFormat {
  format: { separator: string; labelMap: Record<string, string> };
  /**
   * 这份格式从哪来 —— 面板要如实显示。
   *
   * `greeting-preset`：来自「初始场景预设」（v0.1.3 追加项一之后的正主）
   * `txt-preset`：来自 TXT 预设的 `greeting.separator`（v0.1.3 早期写法，仍兼容）
   * `frozen`：两者都没给，用冻结默认值
   */
  source: 'greeting-preset' | 'txt-preset' | 'frozen';
}

/**
 * 「初始场景」最终生效的格式。
 *
 * 优先级（**先专用后通用**）：
 *   1. 用户选了非内置的初始场景预设 → 用它；
 *   2. 否则 TXT 预设显式写了 `greeting.separator` → 用它（兼容 v0.1.3 早期的预设文件，
 *      那时分隔符只存在于 TXT 预设里；不兼容会让已发布的预设静默失效）；
 *   3. 否则冻结默认值。
 *
 * 为什么不干脆只认 1：v0.1.3 的 TXT 预设资产里已经可能带 `greeting.separator`，
 * 直接忽略等于"用户设过的值不见了"，而界面上又没有任何提示。
 */
export function effectiveGreetingFormat(
  greetingPreset: FieldPreset | null | undefined,
  txtGreeting: { separator?: string } | null | undefined,
): EffectiveGreetingFormat {
  const fromPreset = greetingPreset?.format;

  // ① 用户选了**自定义**初始场景预设 → 它是正主，谁也覆盖不了
  if (fromPreset !== undefined && greetingPreset?.builtin !== true) {
    return {
      format: { separator: fromPreset.separator, labelMap: { ...fromPreset.labelMap } },
      source: 'greeting-preset',
    };
  }

  const txtSeparator =
    typeof txtGreeting?.separator === 'string' && txtGreeting.separator !== ''
      ? txtGreeting.separator
      : null;
  const presetSeparator = fromPreset?.separator ?? null;

  /*
   * ② TXT 预设的 `greeting.separator`：只在与当前值**不同**时才算"接管"。
   *
   * 内置 TXT 预设（default / divider / markdown）**都写了** `greeting.separator`，
   * 而且值就等于冻结默认值。若按"有值就标 txt-preset"判定，面板会一直显示
   * 「当前生效的分隔符来自 TXT 预设」—— 而用户明明选的是「标准初始场景（v0.1.3 冻结）」。
   * 值相同却说是另一个来源，是**说错了**（哪怕结果一样）。
   *
   * 判据改成"值不同"之后：
   *   · TXT 预设值与当前一致 → 不接管，来源如实反映实际生效的那份；
   *   · TXT 预设值不同（用户导入过自定义 TXT 预设）→ 标 txt-preset，
   *     面板会明确提示"选择一份自定义的初始场景预设会覆盖它"。
   *
   * 值不同时**让 TXT 预设赢**是刻意的：它的存在证明用户手上有一份
   * 按那种分隔符写成的卡（v0.1.3 早期只有这条路径），改判会让存量卡被切错。
   */
  if (txtSeparator !== null && txtSeparator !== (presetSeparator ?? DEFAULT_GREETING_FORMAT.separator)) {
    return { format: { separator: txtSeparator, labelMap: {} }, source: 'txt-preset' };
  }

  // ③ 自定义预设已在①返回；这里只剩内置默认或没有预设
  if (fromPreset !== undefined) {
    return {
      format: { separator: fromPreset.separator, labelMap: { ...fromPreset.labelMap } },
      source: fromPreset.separator === DEFAULT_GREETING_FORMAT.separator ? 'frozen' : 'greeting-preset',
    };
  }
  return {
    format: { separator: txtSeparator ?? DEFAULT_GREETING_FORMAT.separator, labelMap: {} },
    source: txtSeparator === null ? 'frozen' : 'txt-preset',
  };
}

/**
 * 示例对话的轮数。
 *
 * 只在预设显式给了 `separator` 时才有意义 —— 冻结默认（空串）返回 `null`，
 * 表示"不统计"，而不是"0 轮"。这个区别很重要：把"没配置"显示成"0 轮"
 * 会让用户以为自己的对话示例是空的。
 */
export function countExampleTurns(text: string, format: FieldFormatParams): number | null {
  if (format.separator === '') return null;
  const token = greetingDividerToken(format.separator);
  if (token === null) return null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let turns = 1;
  for (const line of lines) {
    if (line.trim() === token) turns += 1;
  }
  return turns;
}

/** 面板摘要：一眼看出这份预设到底改了什么 */
export function describeFieldPreset(preset: FieldPreset): string {
  const separator =
    preset.format.separator === ''
      ? '不切分'
      : JSON.stringify(preset.format.separator).replace(/\\n/g, '⏎');
  const labels = Object.entries(preset.format.labelMap)
    .map(([role, label]) => `${role}=${label}`)
    .join(' / ');
  return `分隔 ${separator}${labels === '' ? ' · 无标签' : ` · 标签 ${labels}`}`;
}
