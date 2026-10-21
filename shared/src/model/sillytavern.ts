/**
 * SillyTavern 角色卡原生 JSON 类型（V1 / V2 / V3 兼容）。
 * 参考：Character Card V2 spec、Character Card V3（CCV3）规范、SillyTavern 源码 fields。
 *
 * 说明：所有类型都保留 `[key: string]: unknown` 之外的 passthrough 能力由
 * models/unified-card.ts 的 passthrough 机制处理，不在类型层强约束。
 */

import type { JsonObject } from './json.js';

/** 世界书条目（character_book.entries[]，SillyTavern World Info 兼容结构） */
export interface StWorldbookEntry {
  id?: number;
  keys: string[];
  secondary_keys?: string[];
  /** 条目正文 */
  content: string;
  /** 是否常驻（不被关键词触发） */
  constant?: boolean;
  /** 是否启用（ST 私有字段） */
  enabled?: boolean;
  insertion_order?: number;
  /** 0=before_char 1=after_char */
  position?: number | string;
  case_sensitive?: boolean;
  name?: string;
  priority?: number;
  comment?: string;
  selective?: boolean;
  extensions?: JsonObject;
  [key: string]: unknown;
}

export interface StCharacterBook {
  name?: string;
  description?: string;
  scan_depth?: number;
  token_budget?: number;
  recursive_scanning?: boolean;
  extensions?: JsonObject;
  entries: StWorldbookEntry[];
  [key: string]: unknown;
}

/** CCV3 内嵌资源（图片/音频等），V2 无此字段 */
export interface StAsset {
  type: string;
  uri: string;
  name: string;
  [key: string]: unknown;
}

/** V2/V3 卡片的 data 段。V1 卡片没有 data 段，字段平铺在顶层。 */
export interface StCardData {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string[];
  character_book?: StCharacterBook;
  tags: string[];
  creator: string;
  character_version: string;
  extensions: JsonObject;

  // ---- V3 新增 ----
  nickname?: string;
  creator_notes_multilingual?: Record<string, string>;
  source?: string[] | string;
  group_only_greetings?: string[];
  creation_date?: number;
  modification_date?: number;
  assets?: StAsset[];

  [key: string]: unknown;
}

/** 完整卡片：顶层可能是 V1（平铺）或 V2/V3（spec + data）。 */
export interface StCharacterCard {
  spec?: 'chara_card_v2' | 'chara_card_v3';
  spec_version?: string;
  data?: StCardData;

  // ---- V1 顶层字段（V2 卡片为了向后兼容也会保留一份）----
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  creatorcomment?: string;
  avatar?: string;
  talkativeness?: string;
  fav?: boolean;
  tags?: string[];
  create_date?: string;

  [key: string]: unknown;
}

export type StSpecVersion = 'v1' | 'v2' | 'v3';

/** 判定卡片规范版本；无 spec 字段即视为 V1。 */
export function detectSpec(card: StCharacterCard): StSpecVersion {
  if (card.spec === 'chara_card_v3') return 'v3';
  if (card.spec === 'chara_card_v2') return 'v2';
  return 'v1';
}
