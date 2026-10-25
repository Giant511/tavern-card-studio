/**
 * SillyTavern 原生 JSON 的解析与序列化（T1.1）。
 *
 * 解析目标：任意来源的卡片（V1 / V2 / V3、含未知扩展字段）都能读进统一模型而不丢数据。
 * 序列化目标：输出符合 SillyTavern 习惯的键顺序，且未改动的文本逐字还原。
 */

import { BLOCK_IDS, DESCRIPTION_BLOCK_IDS, type BlockId } from '../model/blocks.js';
import { cloneJson, isJsonObject, type JsonObject, type JsonValue } from '../model/json.js';
import { detectSpec, type StCharacterBook, type StCharacterCard, type StSpecVersion, type StWorldbookEntry } from '../model/sillytavern.js';
import {
  createEmptyCard,
  UNIFIED_CARD_SCHEMA_VERSION,
  type CardBlock,
  type CardMeta,
  type StResidual,
  type UnifiedCard,
} from '../model/unified-card.js';
import { assembleDescription, parseDescription, type AssembleOptions } from './description.js';
import { applyFieldBlockReflection, blocksWithFieldBlocks } from './field-blocks.js';
import type { GreetingFormatParams } from './greeting-preset.js';
import { renderWorldbookText } from './worldbook.js';

export class StCardParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StCardParseError';
  }
}

export interface ParseIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ParseStCardResult {
  card: UnifiedCard;
  issues: ParseIssue[];
}

/** data 段中由模型接管的键（其余进 passthrough） */
const DATA_MODELED_KEYS = new Set([
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'creator_notes',
  'system_prompt',
  'post_history_instructions',
  'alternate_greetings',
  'character_book',
  'tags',
  'creator',
  'character_version',
  'nickname',
  'group_only_greetings',
  'source',
  'creation_date',
  'modification_date',
]);

/** V1 顶层由模型接管的键 */
const V1_MODELED_KEYS = new Set([
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'creatorcomment',
  'creator_notes',
  'character_book',
  'tags',
  'creator',
  'character_version',
  'system_prompt',
  'post_history_instructions',
  'alternate_greetings',
  'extensions',
]);

/** V2/V3 顶层会与 data 同步的「V1 兼容副本」 */
export const LEGACY_TOP_LEVEL_KEYS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'] as const;

function pickEntries(book: unknown): StWorldbookEntry[] {
  if (!isJsonObject(book)) return [];
  const entries = book['entries'];
  if (!Array.isArray(entries)) return [];
  return entries.filter(isJsonObject).map((entry) => cloneJson(entry as JsonObject) as unknown as StWorldbookEntry);
}

function buildBlocks(description: string, personality: string): {
  blocks: CardBlock[];
  structured: boolean;
  preface: string;
  separator: string;
  raw: string;
} {
  const parsed = parseDescription(description);
  const personalityBlock: CardBlock = {
    id: 'personality',
    text: personality,
    raw: personality,
    dirty: false,
    anchor: { field: 'personality', headingText: null, headingSpan: null, bodySpan: null },
  };
  // 只产出「description 分段 + 性格」这几种板块；
  // 两个字段板块（对话示例 / 初始场景）要等 residual 解析出来才能填，
  // 由 blocksWithFieldBlocks 在 residual 之后补齐（顺序也由它统一到 BLOCK_IDS）。
  const blocks = DESCRIPTION_BLOCK_IDS.map(
    (id) => parsed.blocks.find((block) => block.id === id)!,
  );
  return {
    blocks: [personalityBlock, ...blocks],
    structured: parsed.structured,
    preface: parsed.preface,
    separator: parsed.separator,
    raw: description,
  };
}

export interface ParseStCardOptions {
  /**
   * 「初始场景」多条开场白的分隔格式（v0.1.3 / 追加项一）。
   *
   * 缺省 = 冻结默认值。传它是为了让**用户选的初始场景预设**真正生效：
   * JSON 里的 first_mes / alternate_greetings 是分开存的，分隔符不参与存储，
   * 但它决定板块视图怎么拼（`---` 还是 `===`），而视图是用户编辑的对象。
   */
  greetingFormat?: GreetingFormatParams;
}

export function parseStCard(input: unknown, options: ParseStCardOptions = {}): ParseStCardResult {
  let source: JsonValue;
  if (typeof input === 'string') {
    try {
      source = JSON.parse(input) as JsonValue;
    } catch (error) {
      throw new StCardParseError(`角色卡 JSON 无法解析：${(error as Error).message}`);
    }
  } else {
    source = input as JsonValue;
  }

  if (!isJsonObject(source)) {
    throw new StCardParseError('角色卡 JSON 顶层必须是对象');
  }

  const card = source as StCharacterCard;
  const spec = detectSpec(card);
  const issues: ParseIssue[] = [];

  const data = isJsonObject(card.data) ? (card.data as JsonObject) : undefined;
  if (spec !== 'v1' && !data) {
    issues.push({ path: 'data', message: '卡片缺少 data 段，已按 V1 结构回退读取顶层字段', severity: 'warning' });
  }

  // V1 读顶层；V2/V3 优先读 data，单字段缺失时回退顶层（兼容残缺卡片）
  const pickValue = (key: string): JsonValue | undefined => {
    const primary = spec === 'v1' ? (source as JsonObject)[key] : (data ?? (source as JsonObject))[key];
    if (primary !== undefined) return primary;
    return (source as JsonObject)[key];
  };
  const pickStr = (key: string): string => {
    const value = pickValue(key);
    return typeof value === 'string' ? value : '';
  };
  const pickStrings = (key: string): string[] => {
    const value = pickValue(key);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
  };
  const pickNum = (key: string): number | null => {
    const value = pickValue(key);
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };

  const description = pickStr('description');
  const personality = pickStr('personality');

  const built = buildBlocks(description, personality);

  const bookValue = pickValue('character_book');
  const characterBookRaw = isJsonObject(bookValue) ? (cloneJson(bookValue) as unknown as StCharacterBook) : null;

  const entries = pickEntries(characterBookRaw);
  if (characterBookRaw && !Array.isArray(characterBookRaw['entries'])) {
    issues.push({ path: 'character_book.entries', message: 'character_book 缺少 entries 数组，已按空世界书处理', severity: 'warning' });
  }

  const creatorNotes = pickStr('creator_notes') || pickStr('creatorcomment') || pickStr('creator_notes');

  const meta: CardMeta = {
    name: pickStr('name'),
    creator: pickStr('creator'),
    characterVersion: pickStr('character_version'),
    creatorNotes,
    tags: pickStrings('tags'),
    spec,
    specVersion: typeof card.spec_version === 'string' ? card.spec_version : spec === 'v3' ? '3.0' : spec === 'v2' ? '2.0' : '',
    avatarPath: null,
  };

  const residual: StResidual = {
    scenario: pickStr('scenario'),
    firstMes: pickStr('first_mes'),
    mesExample: pickStr('mes_example'),
    systemPrompt: pickStr('system_prompt'),
    postHistoryInstructions: pickStr('post_history_instructions'),
    alternateGreetings: pickStrings('alternate_greetings'),
    groupOnlyGreetings: pickStrings('group_only_greetings'),
    nickname: pickStr('nickname'),
    source: pickValue('source') ?? null,
    creationDate: pickNum('creation_date'),
    modificationDate: pickNum('modification_date'),
  };

  const passthroughData: JsonObject = {};
  if (spec !== 'v1') {
    for (const [key, value] of Object.entries(data ?? {})) {
      if (!DATA_MODELED_KEYS.has(key)) passthroughData[key] = cloneJson(value);
    }
  } else if (isJsonObject((source as JsonObject)['extensions'])) {
    // V1 卡片把 extensions 放在顶层，统一收进 data 侧
    passthroughData['extensions'] = cloneJson((source as JsonObject)['extensions'] as JsonObject);
  }

  const passthroughTop: JsonObject = {};
  for (const [key, value] of Object.entries(source as JsonObject)) {
    if (key === 'spec' || key === 'spec_version' || key === 'data') continue;
    const modeled = spec === 'v1' ? V1_MODELED_KEYS.has(key) : false;
    if (!modeled) passthroughTop[key] = cloneJson(value);
  }

  const byteSize = typeof input === 'string' ? new TextEncoder().encode(input).length : null;

  const unified: UnifiedCard = {
    ...createEmptyCard(meta.name),
    schemaVersion: UNIFIED_CARD_SCHEMA_VERSION,
    meta,
    blocks: blocksWithFieldBlocks(built.blocks, residual, options.greetingFormat),
    description: {
      raw: built.raw,
      separator: built.separator,
      structured: built.structured,
      preface: built.preface,
    },
    worldbook: {
      entries,
      text: renderWorldbookText(entries),
      dirty: false,
      raw: characterBookRaw,
    },
    residual,
    passthrough: { top: passthroughTop, data: passthroughData },
    source: { origin: '', importedAt: new Date().toISOString(), byteSize },
  };

  return { card: unified, issues };
}

export function parseStCardText(text: string, options: ParseStCardOptions = {}): ParseStCardResult {
  return parseStCard(text, options);
}

export interface SerializeStCardOptions extends AssembleOptions {
  /**
   * 顶层 V1 兼容副本（name/description/personality/scenario/first_mes/mes_example）的处理方式：
   * - `sync`（默认）：按当前模型重新生成，避免导出后顶层字段陈旧；
   * - `preserve`：沿用导入时的原文副本，用于严格 round-trip 校验。
   */
  legacyTopLevel?: 'sync' | 'preserve';
  /** 强制导出规范；缺省沿用卡片自身版本 */
  targetSpec?: StSpecVersion;
  /** 「初始场景」多条开场白的分隔格式；缺省 = 冻结默认值 */
  greetingFormat?: GreetingFormatParams;
}

const CANONICAL_DATA_ORDER = [
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'creator_notes',
  'system_prompt',
  'post_history_instructions',
  'alternate_greetings',
  'character_book',
  'tags',
  'creator',
  'character_version',
  'extensions',
  'nickname',
  'group_only_greetings',
  'source',
  'creation_date',
  'modification_date',
] as const;

function buildData(card: UnifiedCard, description: string): JsonObject {
  const data: JsonObject = {};
  const blocks = new Map<BlockId, CardBlock>(card.blocks.map((block) => [block.id, block]));

  data['name'] = card.meta.name;
  data['description'] = description;
  data['personality'] = blocks.get('personality')?.text ?? '';
  data['scenario'] = card.residual.scenario;
  data['first_mes'] = card.residual.firstMes;
  data['mes_example'] = card.residual.mesExample;
  data['creator_notes'] = card.meta.creatorNotes;
  data['system_prompt'] = card.residual.systemPrompt;
  data['post_history_instructions'] = card.residual.postHistoryInstructions;
  data['alternate_greetings'] = [...card.residual.alternateGreetings];

  const book = card.worldbook.raw ?? (card.worldbook.entries.length > 0 ? {} : null);
  if (book) {
    const merged: JsonObject = cloneJson(book);
    merged['entries'] = cloneJson(card.worldbook.entries as unknown as JsonValue);
    data['character_book'] = merged;
  }

  data['tags'] = [...card.meta.tags];
  data['creator'] = card.meta.creator;
  data['character_version'] = card.meta.characterVersion;

  const extensions = (card.passthrough.data['extensions'] as JsonObject | undefined) ?? {};
  data['extensions'] = cloneJson(extensions);

  if (card.residual.nickname !== '') data['nickname'] = card.residual.nickname;
  if (card.residual.groupOnlyGreetings.length > 0) data['group_only_greetings'] = [...card.residual.groupOnlyGreetings];
  if (card.residual.source !== null) data['source'] = cloneJson(card.residual.source);
  if (card.residual.creationDate !== null) data['creation_date'] = card.residual.creationDate;
  if (card.residual.modificationDate !== null) data['modification_date'] = card.residual.modificationDate;

  // 未建模字段追加在末尾，保持原有相对顺序
  for (const [key, value] of Object.entries(card.passthrough.data)) {
    if (key in data) continue;
    data[key] = cloneJson(value);
  }

  // 规范化键顺序（未在清单中的键保持追加顺序）
  const ordered: JsonObject = {};
  for (const key of CANONICAL_DATA_ORDER) {
    if (key in data) ordered[key] = data[key]!;
  }
  for (const [key, value] of Object.entries(data)) {
    if (!(key in ordered)) ordered[key] = value;
  }
  return ordered;
}

export function serializeStCard(card: UnifiedCard, options: SerializeStCardOptions = {}): StCharacterCard {
  const spec: StSpecVersion = options.targetSpec ?? card.meta.spec;
  // 字段板块（对话示例 / 初始场景）被改过时，把改动回写到 residual：
  // 只处理 dirty 的板块，未编辑的板块一律用原字段值 —— 否则 first_mes 里
  // 天然含有的一行 `---` 会被当成分隔符切开（静默改数据）。
  const effective = applyFieldBlockReflection(card, options.greetingFormat);
  const description = assembleDescription(card.blocks, card.description, options);
  const data = buildData(effective, description);
  const legacyMode = options.legacyTopLevel ?? 'sync';

  if (spec === 'v1') {
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(card.passthrough.top)) {
      out[key] = cloneJson(value);
    }
    out['name'] = card.meta.name;
    out['description'] = description;
    out['personality'] = data['personality']!;
    out['scenario'] = effective.residual.scenario;
    out['first_mes'] = effective.residual.firstMes;
    out['mes_example'] = effective.residual.mesExample;
    out['creatorcomment'] = card.meta.creatorNotes;
    out['tags'] = [...card.meta.tags];
    out['creator'] = card.meta.creator;
    out['character_version'] = card.meta.characterVersion;
    out['extensions'] = data['extensions']!;
    if (data['character_book']) out['character_book'] = data['character_book'];
    return out as StCharacterCard;
  }

  const out: JsonObject = {
    spec: spec === 'v3' ? 'chara_card_v3' : 'chara_card_v2',
    spec_version: spec === 'v3' ? card.meta.specVersion || '3.0' : card.meta.specVersion || '2.0',
    data,
  };

  for (const key of LEGACY_TOP_LEVEL_KEYS) {
    const preserved = card.passthrough.top[key];
    if (legacyMode === 'preserve' && preserved !== undefined) {
      out[key] = cloneJson(preserved);
    } else {
      out[key] = data[key] ?? '';
    }
  }

  for (const [key, value] of Object.entries(card.passthrough.top)) {
    if (key in out) continue;
    out[key] = cloneJson(value);
  }

  return out as StCharacterCard;
}

export function stringifyStCard(card: UnifiedCard, options: SerializeStCardOptions & { indent?: number } = {}): string {
  const indent = options.indent ?? 2;
  return JSON.stringify(serializeStCard(card, options), null, indent);
}
