/**
 * 选择器解析与「按选择器取文本」（T1.3 规则引擎的地基）。
 *
 * 选择器语法：`*` | `block:<blockId>` | `field:<stFieldName>`
 * 返回的 ScopedText 带 blockId / field，问题定位与编辑器内标记都依赖它。
 */

import type { BlockId } from '../model/blocks.js';
import { BLOCK_IDS } from '../model/blocks.js';
import type { UnifiedCard } from '../model/unified-card.js';
import type { Selector } from './platform-rule.js';

export type ParsedSelector =
  | { kind: 'all'; raw: string }
  | { kind: 'block'; blockId: BlockId; raw: string }
  | { kind: 'field'; field: string; raw: string };

const BLOCK_SELECTOR = /^block:(basic|personality|settings|special|user|worldbook)$/;
const FIELD_SELECTOR = /^field:([a-z_]+)$/;

export function parseSelector(selector: string): ParsedSelector | null {
  if (selector === '*') return { kind: 'all', raw: selector };
  const block = BLOCK_SELECTOR.exec(selector);
  if (block) return { kind: 'block', blockId: block[1] as BlockId, raw: selector };
  const field = FIELD_SELECTOR.exec(selector);
  if (field) return { kind: 'field', field: field[1] as string, raw: selector };
  return null;
}

export interface ScopedText {
  /** 去重键：同一段文本被多个选择器命中时只保留一次 */
  key: string;
  blockId: BlockId | null;
  field: string | null;
  text: string;
  selector: string;
}

export const SELECTABLE_FIELDS = [
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
  'group_only_greetings',
  'character_book',
] as const;

const RESIDUAL_FIELD_MAP: Readonly<Record<string, keyof UnifiedCard['residual']>> = {
  scenario: 'scenario',
  first_mes: 'firstMes',
  mes_example: 'mesExample',
  system_prompt: 'systemPrompt',
  post_history_instructions: 'postHistoryInstructions',
};

export function normalizeSelectorList(scope: Selector | Selector[]): string[] {
  return Array.isArray(scope) ? scope : [scope];
}

export function collectScopedTexts(card: UnifiedCard, scope: Selector | Selector[]): ScopedText[] {
  const selectors = normalizeSelectorList(scope);
  const collected = new Map<string, ScopedText>();

  const push = (item: ScopedText): void => {
    if (!collected.has(item.key)) collected.set(item.key, item);
  };

  for (const raw of selectors) {
    const parsed = parseSelector(raw);
    if (!parsed) continue;

    if (parsed.kind === 'all') {
      for (const blockId of BLOCK_IDS) {
        if (blockId === 'worldbook') {
          if (card.worldbook.text.trim() === '') continue;
          push({ key: `block:worldbook`, blockId: 'worldbook', field: 'character_book', text: card.worldbook.text, selector: raw });
          continue;
        }
        const block = card.blocks.find((item) => item.id === blockId);
        if (!block) continue;
        push({
          key: `block:${blockId}`,
          blockId,
          field: blockId === 'personality' ? 'personality' : 'description',
          text: block.text,
          selector: raw,
        });
      }
      continue;
    }

    if (parsed.kind === 'block') {
      if (parsed.blockId === 'worldbook') {
        push({ key: `block:worldbook`, blockId: 'worldbook', field: 'character_book', text: card.worldbook.text, selector: raw });
        continue;
      }
      const block = card.blocks.find((item) => item.id === parsed.blockId);
      if (!block) continue;
      push({
        key: `block:${block.id}`,
        blockId: block.id,
        field: block.id === 'personality' ? 'personality' : 'description',
        text: block.text,
        selector: raw,
      });
      continue;
    }

    const field = parsed.field;
    if (field === 'name') {
      push({ key: 'field:name', blockId: null, field, text: card.meta.name, selector: raw });
    } else if (field === 'description') {
      for (const block of card.blocks) {
        if (block.id === 'personality') continue;
        push({ key: `block:${block.id}`, blockId: block.id, field: 'description', text: block.text, selector: raw });
      }
    } else if (field === 'personality') {
      const block = card.blocks.find((item) => item.id === 'personality');
      push({ key: 'block:personality', blockId: 'personality', field, text: block?.text ?? '', selector: raw });
    } else if (field === 'creator_notes') {
      push({ key: 'field:creator_notes', blockId: null, field, text: card.meta.creatorNotes, selector: raw });
    } else if (field === 'character_book') {
      push({ key: 'field:character_book', blockId: 'worldbook', field, text: card.worldbook.text, selector: raw });
    } else if (field in RESIDUAL_FIELD_MAP) {
      const key = RESIDUAL_FIELD_MAP[field]!;
      const value = card.residual[key];
      const text = typeof value === 'string' ? value : '';
      push({ key: `field:${field}`, blockId: null, field, text, selector: raw });
    } else if (field === 'alternate_greetings' || field === 'group_only_greetings') {
      const list = field === 'alternate_greetings' ? card.residual.alternateGreetings : card.residual.groupOnlyGreetings;
      list.forEach((text, index) => {
        push({ key: `field:${field}[${index}]`, blockId: null, field: `${field}[${index}]`, text, selector: raw });
      });
    }
  }

  return [...collected.values()];
}

/** 读取某个 ST 字段的完整文本（用于字段完整性检查） */
export function readFieldText(card: UnifiedCard, path: string): { text: string; blockId: BlockId | null; field: string; isArray: boolean; itemCount: number } {
  if (path === 'meta.name') return { text: card.meta.name, blockId: null, field: 'name', isArray: false, itemCount: 0 };
  if (path === 'meta.creator') return { text: card.meta.creator, blockId: null, field: 'creator', isArray: false, itemCount: 0 };
  if (path === 'meta.characterVersion') return { text: card.meta.characterVersion, blockId: null, field: 'character_version', isArray: false, itemCount: 0 };
  if (path === 'meta.creatorNotes') return { text: card.meta.creatorNotes, blockId: null, field: 'creator_notes', isArray: false, itemCount: 0 };
  if (path === 'meta.tags') return { text: card.meta.tags.join(', '), blockId: null, field: 'tags', isArray: true, itemCount: card.meta.tags.length };

  if (path === 'name') return { text: card.meta.name, blockId: null, field: 'name', isArray: false, itemCount: 0 };
  if (path === 'creator_notes') return { text: card.meta.creatorNotes, blockId: null, field: 'creator_notes', isArray: false, itemCount: 0 };
  if (path === 'tags') return { text: card.meta.tags.join(', '), blockId: null, field: 'tags', isArray: true, itemCount: card.meta.tags.length };
  if (path === 'personality') {
    const block = card.blocks.find((item) => item.id === 'personality');
    return { text: block?.text ?? '', blockId: 'personality', field: 'personality', isArray: false, itemCount: 0 };
  }
  if (path === 'description') {
    const text = card.blocks
      .filter((block) => block.id !== 'personality')
      .map((block) => block.text)
      .join('\n\n');
    return { text, blockId: null, field: 'description', isArray: false, itemCount: 0 };
  }
  if (path === 'character_book') {
    return { text: card.worldbook.text, blockId: 'worldbook', field: 'character_book', isArray: false, itemCount: card.worldbook.entries.length };
  }
  if (path === 'alternate_greetings') {
    return { text: card.residual.alternateGreetings.join('\n\n'), blockId: null, field: 'alternate_greetings', isArray: true, itemCount: card.residual.alternateGreetings.length };
  }
  if (path === 'group_only_greetings') {
    return { text: card.residual.groupOnlyGreetings.join('\n\n'), blockId: null, field: 'group_only_greetings', isArray: true, itemCount: card.residual.groupOnlyGreetings.length };
  }
  if (path in RESIDUAL_FIELD_MAP) {
    const key = RESIDUAL_FIELD_MAP[path]!;
    const value = card.residual[key];
    const text = typeof value === 'string' ? value : '';
    return { text, blockId: null, field: path, isArray: false, itemCount: 0 };
  }
  return { text: '', blockId: null, field: path, isArray: false, itemCount: 0 };
}
