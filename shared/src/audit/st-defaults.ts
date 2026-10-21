/**
 * SillyTavern 缺省字段表（T4.3「缺省字段处理」的唯一事实源）。
 *
 * 背景：阶段 2 拍板「解析端不注入缺省值」——TXT 里没写的字段，解析结果里就不存在该键。
 * 由此带来的审计语义（T4.2 两级语义 + T4.3 缺省字段处理）：
 *   · 平台规范**真正必填**且无缺省值的字段（如 `name`）缺失 → `error`，阻断导出；
 *   · **有 ST 缺省值**的字段（如 `constant`、`insertion_order`）未写出 → 最多 `info`，不阻断导出。
 *
 * 本表只用于审计提示（给出「目标平台会用什么值兜底」），**不参与渲染、不参与导出**，
 * 也绝不回写进卡片 JSON——写回会制造版本 diff 噪声，违背阶段 2 的决定。
 *
 * 缺省值以 SillyTavern 新建条目时的 UI 默认值为准；不同版本可能微调，
 * 这里的用途是「提示作者别误以为漏了东西」，不是精确运行时语义。
 */

import type { UnifiedCard } from '../model/unified-card.js';
import type { StWorldbookEntry } from '../model/sillytavern.js';

export interface StDefaultField {
  /** 展示用路径 */
  path: string;
  /** 中文名 */
  label: string;
  /** SillyTavern 的兜底值（展示文本） */
  defaultValue: string;
  /** 归属 */
  scope: 'card' | 'book' | 'entry';
}

export const ST_DEFAULT_FIELDS: readonly StDefaultField[] = [
  // ---- 卡片级（落在 data 段；未建模 → 在 passthrough.data 里）----
  { scope: 'card', path: 'talkativeness', label: '话痨程度', defaultValue: '0.5' },
  { scope: 'card', path: 'fav', label: '收藏标记', defaultValue: 'false' },
  { scope: 'card', path: 'extensions', label: '扩展字段', defaultValue: '{}' },

  // ---- 世界书根级 ----
  { scope: 'book', path: 'scan_depth', label: '扫描深度', defaultValue: '依 SillyTavern 预设（默认 100）' },
  { scope: 'book', path: 'token_budget', label: '令牌预算', defaultValue: '依 SillyTavern 预设（默认 512）' },
  { scope: 'book', path: 'recursive_scanning', label: '递归扫描', defaultValue: 'false' },
  { scope: 'book', path: 'extensions', label: '扩展字段', defaultValue: '{}' },

  // ---- 世界书条目级 ----
  { scope: 'entry', path: 'constant', label: '常驻', defaultValue: 'false' },
  { scope: 'entry', path: 'selective', label: '选择性触发', defaultValue: 'true' },
  { scope: 'entry', path: 'insertion_order', label: '插入顺序', defaultValue: '100' },
  { scope: 'entry', path: 'enabled', label: '启用', defaultValue: 'true' },
  { scope: 'entry', path: 'position', label: '插入位置', defaultValue: '0（角色定义之前）' },
  { scope: 'entry', path: 'case_sensitive', label: '大小写敏感', defaultValue: 'false（依 ST 设置）' },
  { scope: 'entry', path: 'priority', label: '优先级', defaultValue: '0' },
  { scope: 'entry', path: 'extensions', label: '扩展字段', defaultValue: '{}' },
];

export interface OmittedDefault {
  field: StDefaultField;
  /** 受影响的条目 id 列表（仅 entry 级有值；card/book 级为空数组） */
  entryIds: number[];
  /** 条目级：受影响的条目数 */
  count: number;
}

function hasKey(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && key in (value as Record<string, unknown>);
}

/**
 * 列出卡片中「未写出但有 ST 缺省值」的字段。
 * 条目级字段只要**有任意一条目**缺失就列出（并给出条目数），不逐条刷屏。
 */
export function collectOmittedDefaults(card: UnifiedCard): OmittedDefault[] {
  const omitted: OmittedDefault[] = [];
  const data = card.passthrough?.data ?? {};
  const book = card.worldbook?.raw ?? null;
  const entries = card.worldbook?.entries ?? [];

  for (const field of ST_DEFAULT_FIELDS) {
    if (field.scope === 'card') {
      if (!hasKey(data, field.path) && !hasKey(card, field.path)) {
        omitted.push({ field, entryIds: [], count: 1 });
      }
      continue;
    }

    if (field.scope === 'book') {
      if (entries.length === 0) continue; // 没有世界书就不谈世界书字段
      if (!book || !hasKey(book, field.path)) {
        omitted.push({ field, entryIds: [], count: 1 });
      }
      continue;
    }

    const missingIds: number[] = [];
    for (const entry of entries) {
      if (!hasKey(entry, field.path)) missingIds.push(typeof entry.id === 'number' ? entry.id : -1);
    }
    if (missingIds.length > 0) {
      omitted.push({ field, entryIds: missingIds, count: missingIds.length });
    }
  }

  return omitted;
}

/** 判断某个字段是否属于「有 ST 缺省值」的字段（供平台规则层复用，避免两处维护） */
export function isStDefaultField(path: string): boolean {
  return ST_DEFAULT_FIELDS.some((field) => field.path === path);
}

/** 取某个字段的缺省值说明；不属于缺省字段返回 null */
export function stDefaultValueOf(path: string): string | null {
  return ST_DEFAULT_FIELDS.find((field) => field.path === path)?.defaultValue ?? null;
}

/** 单条目缺了哪些缺省字段（世界书 TXT 面板给作者看） */
export function omittedEntryDefaults(entry: StWorldbookEntry): StDefaultField[] {
  return ST_DEFAULT_FIELDS.filter((field) => field.scope === 'entry' && !hasKey(entry, field.path));
}
