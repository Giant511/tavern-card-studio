/**
 * 预设格式（T2.3）：标题风格、分隔符风格、板块顺序。
 *
 * 三条硬规则（已与需求方确认）：
 * 1. **解析永远按标题出现的位置**，与预设顺序无关；
 * 2. **导出不主动重排**——非标准顺序的卡片原样导出，字节不变；
 * 3. 只有用户点「应用预设」时才按 `blockOrder` 重排（本文件的 plan/apply）。
 *
 * `blockOrder` 必须是六个板块的排列（含 worldbook）：worldbook 不参与 description 拼装，
 * 但这保证了「顺序」这一概念在预设里是完整且无歧义的，TXT 整体导出时按它排段落。
 */

import { BLOCK_DEFINITION_MAP, BLOCK_IDS, type BlockId } from '../model/blocks.js';
import type { UnifiedCard } from '../model/unified-card.js';
import { buildAliasTable, normalizeHeading, parseDescription } from './description.js';
import { suggestSimilarKey } from './worldbook-preset.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const TITLE_TOKEN = '{title}';

export interface PresetHeading {
  /** 标题行模板，必须含有 `{title}`，如 `【{title}】`、`## {title}`、`[{title}]` */
  pattern: string;
  /** 该板块可识别的标题文案，第一项为默认文案；六个板块都必须给出 */
  aliases: string[];
}

export interface PresetWorldbookOptions {
  /** TXT 里是否为世界书单独输出一段标题（默认 true） */
  includeHeading?: boolean;
}

export interface TxtPreset {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  /** 内置预设（只读，界面上不允许删除） */
  builtin?: boolean;
  /** 六个板块的完整顺序 */
  blockOrder: BlockId[];
  headings: Record<BlockId, PresetHeading>;
  /** 板块之间的分隔符，必须含换行 */
  separator: string;
  worldbook?: PresetWorldbookOptions;
  meta?: { author?: string; updatedAt?: string };
}

export interface PresetParseResult {
  preset: TxtPreset | null;
  errors: string[];
  /**
   * 未知键（多半是拼错）。T10.30 起与平台规则共用同一套 F4 口径：
   * **不阻断导入**（前向兼容），但必须点名并给出"是不是想写 xxx"。
   */
  warnings: string[];
}

/** 预设顶层允许的键（白名单，与 preset.schema.json 同步） */
const PRESET_KEYS = [
  '$schema',
  'schemaVersion',
  'id',
  'name',
  'version',
  'description',
  'builtin',
  'blockOrder',
  'headings',
  'separator',
  'worldbook',
  'meta',
] as const;

const HEADING_KEYS = ['pattern', 'aliases'] as const;
const WORLDBOOK_OPTION_KEYS = ['includeHeading'] as const;
const META_KEYS = ['author', 'updatedAt'] as const;

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim() !== '');
}

/**
 * 生成某个板块的标题行：套用预设装饰符，`title` 缺省时用该板块首个别名。
 * 保留用户改过的标题文案（如把「基本信息」改成「角色档案」）只换装饰符。
 */
export function headingTextFor(preset: TxtPreset, blockId: BlockId, title?: string | null): string {
  const heading = preset.headings[blockId];
  const label = title?.trim() || heading?.aliases[0] || BLOCK_DEFINITION_MAP[blockId].defaultHeading;
  return (heading?.pattern ?? `【${TITLE_TOKEN}】`).split(TITLE_TOKEN).join(label);
}

/** 预设的别名表（归一化标题 → 板块），供 parseDescription 使用 */
export function presetAliasTable(preset: TxtPreset): Record<string, BlockId> {
  const aliases: Partial<Record<BlockId, readonly string[]>> = {};
  for (const blockId of BLOCK_IDS) {
    const heading = preset.headings[blockId];
    if (heading) aliases[blockId] = heading.aliases;
  }
  return buildAliasTable(aliases);
}

/** 组装成 assembleDescription / serializeStCard 可用的参数 */
export function presetAssembleOptions(preset: TxtPreset): {
  heading: (blockId: BlockId) => string;
  order: BlockId[];
} {
  return {
    heading: (blockId) => headingTextFor(preset, blockId),
    order: [...preset.blockOrder],
  };
}

export function parsePreset(input: unknown): PresetParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isObject(input)) return { preset: null, errors: ['预设文件顶层必须是对象'], warnings };
  collectUnknownKeys(input, PRESET_KEYS, '', warnings);
  if (input['schemaVersion'] !== 1) errors.push('schemaVersion 必须为 1');
  if (typeof input['id'] !== 'string' || !ID_PATTERN.test(input['id'])) errors.push('id 不合法（小写字母/数字/._-，2-64 位）');
  if (typeof input['name'] !== 'string' || input['name'].trim() === '') errors.push('name 不能为空');
  if (typeof input['version'] !== 'string' || !VERSION_PATTERN.test(input['version'])) errors.push('version 必须是 x.y.z');

  // ---- 板块顺序 ----
  const blockOrder = input['blockOrder'];
  if (!Array.isArray(blockOrder)) {
    errors.push('blockOrder 必须是数组');
  } else {
    const seen = new Set<string>();
    for (const item of blockOrder) {
      if (typeof item !== 'string' || !(BLOCK_IDS as readonly string[]).includes(item)) {
        errors.push(`blockOrder 含未知板块 "${String(item)}"（可选：${BLOCK_IDS.join(' / ')}）`);
        continue;
      }
      if (seen.has(item)) errors.push(`blockOrder 中板块 "${item}" 重复`);
      seen.add(item);
    }
    for (const id of BLOCK_IDS) {
      if (!seen.has(id)) errors.push(`blockOrder 缺少板块 "${id}"（顺序必须是六个板块的完整排列）`);
    }
    if (Array.isArray(blockOrder) && blockOrder.length !== BLOCK_IDS.length && seen.size === BLOCK_IDS.length) {
      errors.push(`blockOrder 长度应为 ${BLOCK_IDS.length}，实际 ${blockOrder.length}`);
    }
  }

  // ---- 标题模板与别名 ----
  const headings = input['headings'];
  const aliasOwner = new Map<string, BlockId>();
  if (!isObject(headings)) {
    errors.push('headings 必须是对象（六个板块各一项）');
  } else {
    for (const blockId of BLOCK_IDS) {
      const heading = headings[blockId];
      if (!isObject(heading)) {
        errors.push(`headings.${blockId} 缺失`);
        continue;
      }
      const pattern = heading['pattern'];
      if (typeof pattern !== 'string' || !pattern.includes(TITLE_TOKEN)) {
        errors.push(`headings.${blockId}.pattern 必须是含 ${TITLE_TOKEN} 的字符串`);
      }
      collectUnknownKeys(heading, HEADING_KEYS, `headings.${blockId}`, warnings);
      const aliases = heading['aliases'];
      if (!isStringArray(aliases)) {
        errors.push(`headings.${blockId}.aliases 必须是非空字符串数组`);
        continue;
      }
      for (const alias of aliases) {
        const key = normalizeHeading(alias);
        const owner = aliasOwner.get(key);
        if (owner && owner !== blockId) {
          errors.push(`标题别名 "${alias}" 同时属于 ${owner} 与 ${blockId}，解析会二义`);
        } else {
          aliasOwner.set(key, blockId);
        }
      }
    }
    for (const key of Object.keys(headings)) {
      if (!(BLOCK_IDS as readonly string[]).includes(key)) errors.push(`headings 含未知板块 "${key}"`);
    }
  }

  // ---- 分隔符 ----
  const separator = input['separator'];
  if (typeof separator !== 'string' || separator === '') {
    errors.push('separator 必须是非空字符串');
  } else if (!separator.includes('\n')) {
    errors.push('separator 必须含换行，否则板块会粘在同一行');
  }

  const worldbook = input['worldbook'];
  if (worldbook !== undefined) {
    if (!isObject(worldbook)) {
      errors.push('worldbook 必须是对象');
    } else {
      collectUnknownKeys(worldbook, WORLDBOOK_OPTION_KEYS, 'worldbook', warnings);
      if (worldbook['includeHeading'] !== undefined && typeof worldbook['includeHeading'] !== 'boolean') {
        errors.push('worldbook.includeHeading 必须是布尔值');
      }
    }
  }

  if (isObject(input['meta'])) collectUnknownKeys(input['meta'], META_KEYS, 'meta', warnings);

  if (errors.length > 0) return { preset: null, errors, warnings };
  return { preset: input as unknown as TxtPreset, errors: [], warnings };
}

export function loadPresets(inputs: readonly unknown[]): {
  presets: TxtPreset[];
  errors: { index: number; id: string | null; errors: string[] }[];
  warnings: { index: number; id: string | null; warnings: string[] }[];
} {
  const presets: TxtPreset[] = [];
  const errors: { index: number; id: string | null; errors: string[] }[] = [];
  const warnings: { index: number; id: string | null; warnings: string[] }[] = [];
  inputs.forEach((input, index) => {
    const result = parsePreset(input);
    const id = isObject(input) && typeof input['id'] === 'string' ? input['id'] : null;
    if (result.preset) presets.push(result.preset);
    else errors.push({ index, id, errors: result.errors });
    if (result.warnings.length > 0) warnings.push({ index, id, warnings: result.warnings });
  });
  return { presets, errors, warnings };
}

export function findPreset(presets: readonly TxtPreset[], id: string): TxtPreset | null {
  return presets.find((preset) => preset.id === id) ?? null;
}

/** description 侧的实际板块顺序（按标题在原文中的位置，无结构时返回空数组） */
export function descriptionOrderOf(card: UnifiedCard): BlockId[] {
  return card.blocks
    .filter((block) => block.anchor?.field === 'description' && block.anchor.headingSpan)
    .sort((a, b) => a.anchor!.headingSpan!.start - b.anchor!.headingSpan!.start)
    .map((block) => block.id);
}

/** 分隔符里的唯一文字行（如 `\n\n---\n\n` → `---`）；纯空白分隔符返回 null */
function separatorToken(separator: string): string | null {
  const lines = separator
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.length === 1 ? lines[0]! : null;
}

/** 去掉板块正文末尾的分隔符行，避免「原文里的 --- + 预设再加一次」重复 */
function trimTrailingSeparatorText(text: string, token: string | null): string {
  if (!token) return text;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0) {
    const last = lines[lines.length - 1] ?? '';
    if (last.trim() === '') {
      lines.pop();
      continue;
    }
    if (last.trim() === token) lines.pop();
    break;
  }
  return lines.join('\n');
}

/** 预设顺序里属于 description 的板块（性格、世界书各有独立字段，不参与拼装） */
function descriptionSideOrder(preset: TxtPreset): BlockId[] {
  return preset.blockOrder.filter((id) => id !== 'worldbook' && id !== 'personality');
}

/** 按预设顺序渲染 description 文本（空板块跳过；性格/世界书不在其中） */
export function renderDescriptionText(card: UnifiedCard, preset: TxtPreset): string {
  const byId = new Map(card.blocks.map((block) => [block.id, block]));
  const token = separatorToken(preset.separator);
  const parts: string[] = [];
  for (const id of descriptionSideOrder(preset)) {
    const block = byId.get(id);
    if (!block || block.text.trim() === '') continue;
    const heading = headingTextFor(preset, id, block.anchor?.headingText ?? null);
    parts.push(`${heading}\n${trimTrailingSeparatorText(block.text, token)}`);
  }
  return parts.join(preset.separator);
}

export interface PresetApplyPlan {
  presetId: string;
  /** 应用前的实际板块顺序（仅出现在原文中的板块） */
  beforeOrder: BlockId[];
  /** 应用后的顺序（仅 description 板块） */
  afterOrder: BlockId[];
  /** 是否需要改动；false 时 apply 会原样返回卡片 */
  changed: boolean;
  /** 重排后的 description 全文 */
  text: string;
  separator: string;
  aliases: Record<string, BlockId>;
  /** 便于 UI 展示的变更摘要 */
  changes: string[];
}

/**
 * 规划「应用预设」：只算结果、不动卡片。
 * 注意：这一步是**唯一**会改变板块顺序的操作；普通导出走 serializeStCard，不重排。
 */
export function planPresetApply(card: UnifiedCard, preset: TxtPreset): PresetApplyPlan {
  const beforeOrder = descriptionOrderOf(card);
  const afterOrder = descriptionSideOrder(preset);
  const text = renderDescriptionText(card, preset);
  const changes: string[] = [];

  const presentAfter = afterOrder.filter((id) => {
    const block = card.blocks.find((item) => item.id === id);
    return Boolean(block && block.text.trim() !== '');
  });
  const presentBefore = beforeOrder.filter((id) => presentAfter.includes(id));
  if (presentBefore.join('>') !== presentAfter.join('>')) {
    changes.push(`板块顺序：${presentBefore.join(' → ') || '（无）'} ⇒ ${presentAfter.join(' → ')}`);
  }
  if (text !== card.description.raw) {
    if (card.description.separator !== preset.separator) {
      changes.push(`分隔符：${JSON.stringify(card.description.separator)} → ${JSON.stringify(preset.separator)}`);
    }
    if (!changes.length) changes.push('标题样式已按预设重排');
  }

  return {
    presetId: preset.id,
    beforeOrder,
    afterOrder,
    changed: text !== card.description.raw,
    text,
    separator: preset.separator,
    aliases: presetAliasTable(preset),
    changes,
  };
}

/** 应用规划结果：返回新卡片（原卡片不变），anchor 指向新文本，后续编辑仍可增量回写 */
export function applyPresetPlan(card: UnifiedCard, plan: PresetApplyPlan): UnifiedCard {
  if (!plan.changed) return card;
  const next: UnifiedCard = structuredClone(card);
  const parsed = parseDescription(plan.text, { aliases: plan.aliases, separator: plan.separator });
  const parsedById = new Map(parsed.blocks.map((block) => [block.id, block]));
  // 只替换 description 侧板块；性格仍是独立字段，不参与重排
  next.blocks = card.blocks.map((block) =>
    block.id === 'personality' ? block : (parsedById.get(block.id) ?? block),
  );
  next.description = {
    raw: plan.text,
    separator: plan.separator,
    structured: parsed.structured,
    preface: parsed.preface,
  };
  return next;
}

/** 一步到位：规划 + 应用（UI 上仍需先展示 plan.changes 让用户确认） */
export function applyPreset(card: UnifiedCard, preset: TxtPreset): { card: UnifiedCard; plan: PresetApplyPlan } {
  const plan = planPresetApply(card, preset);
  return { card: applyPresetPlan(card, plan), plan };
}
