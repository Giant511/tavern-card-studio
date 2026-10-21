/**
 * T4.1 字数统计：总字数 + 按板块字数。
 *
 * 计数口径（与 text/count.ts 一致，全部按**码点**计，emoji 不会算成 2 个字）：
 * - `chars`        含空白的字符数
 * - `charsNoSpace` 不含空白的字符数（长度规则用的就是这个口径）
 * - `cjk`          中日韩字符数
 * - `words`        拉丁/数字词数
 * - `totalWords`   「字数」口径 = cjk + words（中文一字一词，英文一词一计）
 *
 * 世界书特殊处理：按 `entries` 的 **keys + content** 统计，而不是按 TXT 文本统计——
 * `@@ENTRY` / `keys:` 这类标记不属于角色卡内容，计入会虚高。
 * 仅当 entries 为空、但 TXT 非空（用户刚编辑尚未解析）时才退化为按 TXT 统计。
 */

import { BLOCK_DEFINITIONS, BLOCK_IDS } from '../model/blocks.js';
import type { BlockId } from '../model/blocks.js';
import type { UnifiedCard } from '../model/unified-card.js';
import type { StWorldbookEntry } from '../model/sillytavern.js';
import { countText } from '../text/count.js';
import type { BlockWordCount, WordCountReport, WordCountTotal } from './types.js';

const LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  BLOCK_DEFINITIONS.map((definition) => [definition.id, definition.label]),
);

function emptyTotal(): WordCountTotal {
  return { chars: 0, charsNoSpace: 0, cjk: 0, words: 0, totalWords: 0 };
}

function addTotal(target: WordCountTotal, add: WordCountTotal): WordCountTotal {
  return {
    chars: target.chars + add.chars,
    charsNoSpace: target.charsNoSpace + add.charsNoSpace,
    cjk: target.cjk + add.cjk,
    words: target.words + add.words,
    totalWords: target.totalWords + add.totalWords,
  };
}

function toTotal(count: ReturnType<typeof countText>): WordCountTotal {
  return {
    chars: count.chars,
    charsNoSpace: count.charsNoSpace,
    cjk: count.cjk,
    words: count.words,
    totalWords: count.totalWords,
  };
}

/** 世界书条目的可计数字文本：key 列表 + 正文 */
function entryText(entry: StWorldbookEntry): string {
  const keys = Array.isArray(entry.keys) ? entry.keys.filter((key): key is string => typeof key === 'string') : [];
  const content = typeof entry.content === 'string' ? entry.content : '';
  return [keys.join(', '), content].filter((part) => part !== '').join('\n');
}

export function countWorldbook(card: UnifiedCard): { total: WordCountTotal; from: 'entries' | 'text' } {
  const entries = card.worldbook.entries ?? [];
  if (entries.length > 0) {
    let total = emptyTotal();
    for (const entry of entries) total = addTotal(total, toTotal(countText(entryText(entry))));
    return { total, from: 'entries' };
  }
  const text = card.worldbook.text ?? '';
  return { total: toTotal(countText(text)), from: text.trim() === '' ? 'entries' : 'text' };
}

/** 统计单张卡片的字数分布 */
export function countCardWords(card: UnifiedCard): WordCountReport {
  const blocks: BlockWordCount[] = [];
  let grand = emptyTotal();
  let description = emptyTotal();
  let personality = emptyTotal();

  for (const id of BLOCK_IDS) {
    const block = card.blocks.find((item) => item.id === id);
    const count = toTotal(countText(block?.text ?? ''));
    blocks.push({
      blockId: id,
      label: LABELS[id] ?? id,
      chars: count.chars,
      charsNoSpace: count.charsNoSpace,
      cjk: count.cjk,
      words: count.words,
      totalWords: count.totalWords,
      empty: (block?.text ?? '').trim() === '',
      missing: block?.missing === true,
    });
    grand = addTotal(grand, count);
    if (id === 'personality') personality = count;
    else description = addTotal(description, count);
  }

  const worldbook = countWorldbook(card);
  const worldbookBlock = blocks.find((block) => block.blockId === 'worldbook');
  if (worldbookBlock) {
    worldbookBlock.chars = worldbook.total.chars;
    worldbookBlock.charsNoSpace = worldbook.total.charsNoSpace;
    worldbookBlock.cjk = worldbook.total.cjk;
    worldbookBlock.words = worldbook.total.words;
    worldbookBlock.totalWords = worldbook.total.totalWords;
    worldbookBlock.empty = worldbook.total.charsNoSpace === 0;
  }
  grand = addTotal(grand, worldbook.total);

  return {
    blocks,
    total: grand,
    byField: {
      description,
      personality,
      character_book: worldbook.total,
    },
  };
}

/** 单板块字数（UI 实时显示用） */
export function countBlockWords(card: UnifiedCard, blockId: BlockId): WordCountTotal {
  if (blockId === 'worldbook') return countWorldbook(card).total;
  const block = card.blocks.find((item) => item.id === blockId);
  return toTotal(countText(block?.text ?? ''));
}
