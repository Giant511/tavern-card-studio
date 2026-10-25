/**
 * 角色卡统一内部模型（UnifiedCard）。
 *
 * 设计目标（对应 T0.3）：
 * 1. 八个板块为编辑与审计的一等公民（v0.1.3 起；此前六个）。其中 description 分段的那几个
 *    与 TXT 分块格式一一对应，两个字段板块（对话示例 / 初始场景）直接对应独立 ST 字段。
 * 2. 与 SillyTavern 原生 JSON 双向转换「无损」：
 *    - 通过 `raw` + `anchor`（原文偏移量）实现「只替换改动片段」的补丁式序列化，
 *      未被用户编辑过的板块一律逐字还原，不重排、不丢空格、不丢未知字段。
 *    - 所有未建模字段进入 `passthrough`，序列化时原样写回。
 * 3. 平台差异（占位符写法、字段映射等）不进入模型，由平台规则层在序列化时施加。
 *
 * 序列化算法（详见 docs/01-unified-card-model.md）：
 *   ① block.dirty === false 且存在 anchor → 使用原文片段，逐字保留；
 *   ② block.dirty === true  且存在 anchor → 仅替换 bodySpan 区间；
 *   ③ block 无 anchor（新建卡片 / 新增板块）→ 按 order 与 separator 拼接插入。
 */

import { BLOCK_IDS, type BlockId } from './blocks.js';
import type { JsonObject, JsonValue } from './json.js';
import type { StCharacterBook, StSpecVersion, StWorldbookEntry } from './sillytavern.js';

export const UNIFIED_CARD_SCHEMA_VERSION = 1 as const;

/** 文本区间（基于 UTF-16 code unit 偏移，与 JS 字符串索引一致） */
export interface TextSpan {
  start: number;
  end: number;
}

/** 板块在原文中的锚点；用于无损回写 */
export interface BlockAnchor {
  /** 该板块落在哪个 ST 字段里 */
  field: 'description' | 'personality';
  /** 原文标题文本（不含「【】」「## 」等装饰符），未识别到标题时为 null */
  headingText: string | null;
  /** 标题行（含装饰符与换行）在原文中的区间 */
  headingSpan: TextSpan | null;
  /** 正文在原文中的区间（可为零长度） */
  bodySpan: TextSpan | null;
}

export interface CardBlock {
  id: BlockId;
  /** 板块正文（不含标题行）。UI 编辑的就是这段文本。 */
  text: string;
  /** 导入时该板块的原始文本；用于「重置」与无锚点板块（如 personality）的无损回写 */
  raw: string;
  /** 用户是否改动过该块；未改动则序列化时直接复用原文 */
  dirty: boolean;
  /** 原文锚点；null 表示该块为新建内容 */
  anchor: BlockAnchor | null;
  /**
   * 该板块在导入源中**根本没有标题**（宽松模式填充的空块）。
   * 仅用于 UI 显式标记「缺失、已按空处理」，不允许无声清空——
   * 正常存在的空板块（有标题、正文为空）此值为 false。
   */
  missing?: boolean;
}

/** description 字段的文档级信息 */
export interface DescriptionDocument {
  /** 导入时的 description 原文；新建卡片为空串 */
  raw: string;
  /** 板块之间的分隔符（新建/追加板块时使用） */
  separator: string;
  /** 是否从原文中识别出了结构化的板块标题 */
  structured: boolean;
  /** 原文开头、第一个板块标题之前的文本（保留用途，如作者留言） */
  preface: string;
}

/** 世界书板块：结构化数据 + 可编辑的 TXT 表示（TXT 格式在阶段 2 定义） */
export interface WorldbookSection {
  entries: StWorldbookEntry[];
  /** 世界书板块的 TXT 表示 */
  text: string;
  /** 是否被编辑过（编辑后需反向解析回 entries） */
  dirty: boolean;
  /** 原始 character_book 的其他字段（name / scan_depth / extensions 等） */
  raw: StCharacterBook | null;
}

export interface CardMeta {
  name: string;
  creator: string;
  characterVersion: string;
  creatorNotes: string;
  tags: string[];
  spec: StSpecVersion;
  specVersion: string;
  /** 头像文件路径（可选，客户端本地使用，不写入 JSON） */
  avatarPath: string | null;
}

/** 未纳入板块的核心字段（保持原值，客户端以独立表单项编辑） */
export interface StResidual {
  scenario: string;
  firstMes: string;
  mesExample: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  alternateGreetings: string[];
  groupOnlyGreetings: string[];
  nickname: string;
  source: JsonValue | null;
  creationDate: number | null;
  modificationDate: number | null;
}

/** 未建模字段的透传容器，保证 round-trip 不丢数据 */
export interface Passthrough {
  /** 顶层未知键 */
  top: JsonObject;
  /** data 段未知键 */
  data: JsonObject;
}

export interface CardSource {
  /** 导入来源（客户端文件路径或服务端卡片 id），新建时为空 */
  origin: string;
  /** 导入时间（ISO 8601） */
  importedAt: string;
  /** 原始文件大小（字节），未知为 null */
  byteSize: number | null;
}

export interface UnifiedCard {
  schemaVersion: typeof UNIFIED_CARD_SCHEMA_VERSION;
  meta: CardMeta;
  /** 有序板块列表（BLOCK_IDS 去掉 worldbook；worldbook 在下方独立字段） */
  blocks: CardBlock[];
  description: DescriptionDocument;
  worldbook: WorldbookSection;
  residual: StResidual;
  passthrough: Passthrough;
  source: CardSource;
}

/** 新建空白卡片 */
export function createEmptyCard(name = ''): UnifiedCard {
  // 从 BLOCK_IDS 派生：加板块时只需要改 blocks.ts，不必记得这里还有一份清单
  // （世界书不是 CardBlock，它独占世界书字段）
  const blockIds: BlockId[] = BLOCK_IDS.filter((id) => id !== 'worldbook');
  return {
    schemaVersion: UNIFIED_CARD_SCHEMA_VERSION,
    meta: {
      name,
      creator: '',
      characterVersion: '',
      creatorNotes: '',
      tags: [],
      spec: 'v2',
      specVersion: '2.0',
      avatarPath: null,
    },
    blocks: blockIds.map((id) => ({ id, text: '', raw: '', dirty: false, anchor: null })),
    description: { raw: '', separator: '\n\n', structured: false, preface: '' },
    worldbook: { entries: [], text: '', dirty: false, raw: null },
    residual: {
      scenario: '',
      firstMes: '',
      mesExample: '',
      systemPrompt: '',
      postHistoryInstructions: '',
      alternateGreetings: [],
      groupOnlyGreetings: [],
      nickname: '',
      source: null,
      creationDate: null,
      modificationDate: null,
    },
    passthrough: { top: {}, data: {} },
    source: { origin: '', importedAt: new Date().toISOString(), byteSize: null },
  };
}

/** 取某板块；不存在时返回 undefined */
export function findBlock(card: UnifiedCard, id: BlockId): CardBlock | undefined {
  return card.blocks.find((block) => block.id === id);
}

/** 写入板块文本并置 dirty 标记 */
export function setBlockText(card: UnifiedCard, id: BlockId, text: string): void {
  const block = card.blocks.find((item) => item.id === id);
  if (!block) return;
  if (block.text !== text) {
    block.text = text;
    block.dirty = true;
  }
}
