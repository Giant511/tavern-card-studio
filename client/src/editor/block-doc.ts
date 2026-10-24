/**
 * 六板块文档模型（纯逻辑，无 DOM / 无 CodeMirror 依赖）。
 *
 * 这一层是可单测的：编辑 → 拼装 → 解析 → 再编辑 的 round-trip 就在这里验证。
 * UI 层（app.ts）只负责把这里的快照渲染成编辑器，不自己拼字符串。
 *
 * 与 shared 的分工：
 *   · 板块拆分/拼装、世界书 TXT 解析、ST 序列化 —— 全部复用 shared，本文件不重复实现；
 *   · 本文件只做「六板块视图」到「UnifiedCard」的投影与回写。
 */

import {
  applyCardText,
  BLOCK_DEFINITIONS,
  parseWorldbookText,
  renderWorldbookText,
  serializeStCard,
  type BlockId,
  type CardBlock,
  type PreservedInfo,
  type TxtPreset,
  type UnifiedCard,
} from '@tcs/shared';

/** 五个「纯文本」板块（世界书单独走结构化路径） */
export const TEXT_BLOCK_IDS = ['basic', 'personality', 'settings', 'special', 'user'] as const;
export type TextBlockId = (typeof TEXT_BLOCK_IDS)[number];

/** 六个板块（含 worldbook），顺序即 UI 展示顺序 */
export const EDITOR_BLOCK_IDS: readonly BlockId[] = [
  'basic',
  'personality',
  'settings',
  'special',
  'user',
  'worldbook',
];

export interface EditorBlockSnapshot {
  id: BlockId;
  label: string;
  description: string;
  /** 编辑器里的文本（不含标题行） */
  text: string;
  /** 字符数（码点），用于卡片头部统计 */
  length: number;
  /** 空块：UI 需要显式提示，而不是看起来像坏了 */
  empty: boolean;
  /** 该块是否被标记为「原文缺失、按空处理」 */
  missing: boolean;
}

const DEFINITION_MAP = new Map(BLOCK_DEFINITIONS.map((def) => [def.id, def]));

function labelOf(id: BlockId): string {
  return DEFINITION_MAP.get(id)?.label ?? id;
}

function descriptionOf(id: BlockId): string {
  return DEFINITION_MAP.get(id)?.description ?? '';
}

function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

function findBlock(card: UnifiedCard, id: TextBlockId): CardBlock | undefined {
  return card.blocks.find((block) => block.id === id);
}

/** 把卡片投影成六板块快照（UI 的唯一数据源） */
export function collectBlocks(card: UnifiedCard): EditorBlockSnapshot[] {
  return EDITOR_BLOCK_IDS.map((id) => {
    if (id === 'worldbook') {
      // 优先用 text；若为空但 entries 非空，按 entries 现场渲染（导入的卡可能是这种情况）
      const section = card.worldbook;
      const text =
        section.text !== '' ? section.text : renderWorldbookText(section.entries ?? []);
      return {
        id,
        label: labelOf(id),
        description: descriptionOf(id),
        text,
        length: codePointLength(text),
        empty: text.trim() === '',
        missing: false,
      };
    }

    const block = findBlock(card, id as TextBlockId);
    return {
      id,
      label: labelOf(id),
      description: descriptionOf(id),
      text: block?.text ?? '',
      length: codePointLength(block?.text ?? ''),
      empty: (block?.text ?? '').trim() === '',
      missing: block?.missing === true,
    };
  });
}

export interface SetBlockResult {
  card: UnifiedCard;
  /** 该块文本是否真的变化（UI 用它决定要不要重跑校验） */
  changed: boolean;
  /** 世界书解析出的问题（仅 worldbook 块可能非空） */
  worldbookIssues: Array<{ severity: 'error' | 'warning'; message: string; line?: number }>;
}

/**
 * 把某个板块的文本写回卡片，返回**新卡片**（不就地改，便于撤销/对比）。
 *
 * 文本板块：设置 text + dirty，由 serializeStCard 在拼装时写回 description / personality。
 * 世界书块：解析 TXT → entries。**解析出 error 时拒绝写回**（保留上一次的 entries），
 *           避免「半截世界书」被当成删除全部条目。
 */
export function setBlockText(card: UnifiedCard, id: BlockId, text: string): SetBlockResult {
  if (id === 'worldbook') {
    const previous = card.worldbook.text;
    if (previous === text) {
      return { card, changed: false, worldbookIssues: [] };
    }

    const parsed = parseWorldbookText(text);
    const issues = parsed.issues.map((issue) => ({
      severity: issue.severity,
      message: issue.message,
      ...(issue.line === undefined ? {} : { line: issue.line }),
    }));

    if (!parsed.ok) {
      // 拒绝写回：entries 保持原样，仅记录文本（供 UI 显示用户正在编辑什么）
      return {
        card: { ...card, worldbook: { ...card.worldbook, text, dirty: true } },
        changed: true,
        worldbookIssues: issues,
      };
    }

    return {
      card: {
        ...card,
        worldbook: { ...card.worldbook, text, entries: parsed.entries, dirty: true },
      },
      changed: true,
      worldbookIssues: issues,
    };
  }

  const blockId = id as TextBlockId;
  const existing = findBlock(card, blockId);
  if (!existing) {
    // 卡片里没有该块的登记项（理论上不会发生：parseStCard 会补齐空块）
    return { card, changed: false, worldbookIssues: [] };
  }
  if (existing.text === text) {
    return { card, changed: false, worldbookIssues: [] };
  }

  const blocks = card.blocks.map((block) =>
    block.id === blockId ? { ...block, text, dirty: true } : block,
  );
  return { card: { ...card, blocks }, changed: true, worldbookIssues: [] };
}

/**
 * 序列化为 SillyTavern JSON 文本。
 * 缩进固定 2 空格 + 结尾换行：与服务端/导出链路保持一致，避免 diff 噪声。
 *
 * T6.2 接入预设后，这里改为传 `presetAssembleOptions(preset)` 得到的 heading/order，
 * 让「编辑期视图」与「导出格式」共用同一套标题与顺序。
 */
export function serializeCard(card: UnifiedCard): string {
  const result = serializeStCard(card);
  return `${JSON.stringify(result, null, 2)}\n`;
}

/** 六板块合计字数（按码点，给 UI 显示用；正式统计走审计报告） */
export function totalLength(blocks: readonly EditorBlockSnapshot[]): number {
  return blocks.reduce((sum, block) => sum + block.length, 0);
}

/**
 * 整卡 TXT 导入（复用 shared 的 applyCardText）。
 *
 * 放在这一层而不是 UI 里，原因有两个：
 *   · 导入结果会影响 worldbook 的 entries 合并，属于文档模型变更，必须可单测；
 *   · 宽松模式会产出 `missing` 标记，这个语义是面板要显示的，不能在上层临时拼。
 *
 * **全量保全默认开启**（v0.1.2 反馈项二，docs/06 §7）：无论认出几个板块，
 * 原文零丢失 —— 未识别部分整体进【其他设定】。因此这里不再有"被拒绝"的
 * 因缺板块路径；`card` 为 null 只剩世界书结构错误这一类。
 */
export function importCardText(
  card: UnifiedCard,
  text: string,
  preset: TxtPreset,
  mode: 'strict' | 'lenient' = 'lenient',
): {
  card: UnifiedCard | null;
  issues: Array<{ code: string; message: string; line?: number }>;
  preserved: PreservedInfo | null;
} {
  const result = applyCardText(card, text, preset, { mode, preserveUnrecognized: true });
  const issues = result.issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    ...(issue.line === undefined ? {} : { line: issue.line }),
  }));
  if (!result.ok || !result.card) {
    return { card: null, issues, preserved: result.preserved };
  }
  return { card: result.card, issues, preserved: result.preserved };
}
