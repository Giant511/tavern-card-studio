/**
 * 预设切换（T6.2）——纯逻辑，无 DOM。
 *
 * 需要严格区分两个动作，它们**语义完全不同**：
 *
 *   ① **选择预设**（切换视图/导出格式）：只影响「标题文案」与「导出时的拼装方式」，
 *      **原文一个字节都不动**。用户看到的板块文本保持不变，编辑器里的内容不变。
 *
 *   ② **应用预设**（重排）：唯一会改动原文顺序的操作，
 *      必须经 `planPresetApply` → 用户确认 → `applyPresetPlan`。
 *      UI 不得自行拼字符串重排（契约：这是唯一重排入口）。
 *
 * 之所以抽成一文件：这两条语义一旦混在一起，很容易写成"切预设就把文本重排了"，
 * 而那是不可撤销的数据改动。
 */

import {
  headingTextFor,
  planPresetApply,
  presetAssembleOptions,
  presetAliasTable,
  type BlockId,
  type PresetApplyPlan,
  type TxtPreset,
  type UnifiedCard,
} from '@tcs/shared';

export interface PresetChoice {
  id: string;
  name: string;
  version: string;
  description: string;
  builtin: boolean;
  /** 段落分隔符的可见写法（如 `---`），便于在列表里区分 */
  separatorLabel: string;
  /** 板块顺序的可读文本 */
  orderLabel: string;
}

// 列表里用的短名（比板块定义里的全名更适合一行显示）。顺序取自 BLOCK_IDS，
// 新增板块时若这里没写，会自动退化成长名而不是 undefined。
const BLOCK_LABELS: Record<BlockId, string> = {
  basic: '基本',
  personality: '性格',
  settings: '其他',
  special: '特殊',
  user: '用户',
  'chat-examples': '对话示例',
  'initial-scene': '初始场景',
  worldbook: '世界书',
};

function separatorLabel(separator: string): string {
  const visible = separator
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (visible.length === 0) return '（空行）';
  return visible.join(' ');
}

/** 把预设转成下拉列表用的选项（含顺序与分隔符摘要，便于区分三套内置预设） */
export function describePresets(presets: readonly TxtPreset[]): PresetChoice[] {
  return presets.map((preset) => ({
    id: preset.id,
    name: preset.name,
    version: preset.version,
    description: preset.description ?? '',
    builtin: preset.builtin === true,
    separatorLabel: separatorLabel(preset.separator),
    orderLabel: preset.blockOrder
      .filter((id) => id !== 'worldbook')
      .map((id) => BLOCK_LABELS[id] ?? id)
      .join(' → '),
  }));
}

export interface PresetSelection {
  preset: TxtPreset;
  /** 导出/拼装时用的标题与顺序（交给 serializeStCard） */
  assembleOptions: ReturnType<typeof presetAssembleOptions>;
  /** 解析时用的别名表（识别该预设的标题写法） */
  aliases: Record<string, BlockId>;
}

/**
 * 选择预设（不重排）。
 *
 * 只产出「装配参数」，不改卡片。调用方把 assembleOptions 传给
 * `serializeStCard(card, options)`，导出的标题/顺序即按新预设，而原文不动。
 */
export function selectPreset(preset: TxtPreset): PresetSelection {
  return {
    preset,
    assembleOptions: presetAssembleOptions(preset),
    aliases: presetAliasTable(preset),
  };
}

/** 预设切换对导出的影响预览（不改卡片，仅说明"导出会变成什么"） */
export interface PresetPreview {
  presetId: string;
  /** 当前卡片里非空板块的 id（用于对比顺序） */
  presentBlocks: BlockId[];
  /** 导出后的板块顺序（内部 id，供逻辑比较） */
  exportOrder: BlockId[];
  /** 导出顺序的可读文本（中文名），直接给 UI 用 */
  exportOrderLabel: string;
  /** 顺序是否会与当前原文顺序不同（true 表示"导出后看起来像重排了"，但原文没动） */
  orderWouldDiffer: boolean;
  /** 标题样式示例：用第一个非空板块演示 */
  headingSample: {
    blockId: BlockId;
    /** 原文里的完整标题行（含【】等装饰符），无锚点时 null */
    before: string | null;
    /** 按预设渲染后的标题 */
    after: string;
  } | null;
  /** 分隔符的可见写法（如 `（空行）` / `---`），比 JSON 转义串好读 */
  separatorBeforeLabel: string;
  separatorAfterLabel: string;
  /**
   * 选择该预设**是否真的会改变导出结果**。
   *
   * 实测（2026-10-21）：`serializeStCard` 对**已有原文**只替换 dirty 板块的正文，
   * 标题行与分隔符一律沿用原文 —— 所以"选择预设"对已有卡片的导出几乎没有影响：
   *   · 空卡（无原文）：装配参数决定标题与顺序，markdown 导出 `## 基本信息`；
   *   · 已有原文：导出仍是原文的标题与分隔符，只有「应用预设」才重排。
   * UI 必须如实说明，否则用户会以为"选了 markdown 就会导出成 markdown"。
   */
  affectsExport: boolean;
  /** 一句可直接显示给用户的说明 */
  effectNote: string;
}

/**
 * 预览"仅仅选择这个预设"会带来的差异。
 *
 * 注意：这里**不调用** `planPresetApply`——那个函数会算出重排后的全文，
 * 属于"应用"的范畴。预览只需说清差异，不该诱导用户以为文本已经被改了。
 */
export function previewPresetSelection(
  card: UnifiedCard,
  preset: TxtPreset,
): PresetPreview {
  const presentBlocks = card.blocks
    .filter((block) => block.id !== 'worldbook' && block.text.trim() !== '')
    .map((block) => block.id);

  const exportOrder = preset.blockOrder.filter((id) => id !== 'worldbook');
  const presentInOrder = exportOrder.filter((id) => presentBlocks.includes(id));

  // 原文当前顺序：按 anchor 的 headingSpan 排；无锚点的板块（新建）排在其后
  const currentOrder = [...card.blocks]
    .filter((block) => block.id !== 'worldbook' && block.text.trim() !== '')
    .sort((a, b) => {
      const aStart = a.anchor?.headingSpan?.start ?? Number.MAX_SAFE_INTEGER;
      const bStart = b.anchor?.headingSpan?.start ?? Number.MAX_SAFE_INTEGER;
      return aStart - bStart;
    })
    .map((block) => block.id);

  const currentPresent = currentOrder.filter((id) => presentBlocks.includes(id));
  const orderWouldDiffer = currentPresent.join('>') !== presentInOrder.join('>');

  const firstBlock = presentInOrder[0];
  const headingSample = firstBlock
    ? {
        blockId: firstBlock,
        before: headingLineOf(card, firstBlock),
        after: headingTextFor(preset, firstBlock),
      }
    : null;

  const hasRaw = card.description.raw.trim() !== '';

  return {
    presetId: preset.id,
    presentBlocks,
    exportOrder: presentInOrder,
    exportOrderLabel: presentInOrder.map((id) => BLOCK_LABELS[id] ?? id).join(' → '),
    orderWouldDiffer,
    headingSample,
    separatorBeforeLabel: separatorLabel(card.description.separator),
    separatorAfterLabel: separatorLabel(preset.separator),
    affectsExport: !hasRaw,
    effectNote: hasRaw
      ? '这张卡已有原文：选择预设不会改变导出（标题与分隔符沿用原文），要换格式请点「应用预设」。'
      : '这张卡还没有原文：导出会按该预设的标题与顺序拼装。',
  };
}

/**
 * 取原文里该板块的**完整标题行**（含【】等装饰符）。
 *
 * 不能用 `anchor.headingText`：它只存标题内文（如「基本信息」），
 * 不含装饰符，于是"原文标题 vs 预设标题"看起来会一模一样（其实是 `基本信息` 对 `【基本信息】`），
 * 用户根本看不出差异。`headingSpan` 指向原文切片，那里才是他实际看到的那一行。
 */
function headingLineOf(card: UnifiedCard, blockId: BlockId): string | null {
  const block = card.blocks.find((item) => item.id === blockId);
  const span = block?.anchor?.headingSpan;
  if (!span) return null;
  return card.description.raw.slice(span.start, span.end).replace(/\r?\n$/, '');
}

export type ApplyPresetDecision =
  | { kind: 'noop'; message: string }
  | { kind: 'confirm'; plan: PresetApplyPlan; message: string };

/**
 * 判断"应用预设"要不要用户确认。
 *
 * 规则：计划里没有变化 → noop（不打扰用户）；
 *       有变化 → 必须 confirm，并把 `plan.changes` 原样交给 UI 展示。
 * 这个函数不执行应用，只做决策——真正写回卡片的是调用方拿到的 plan + `applyPresetPlan`。
 */
export function decideApplyPreset(card: UnifiedCard, preset: TxtPreset): ApplyPresetDecision {
  const plan = planPresetApply(card, preset);
  if (!plan.changed) {
    return { kind: 'noop', message: `当前文本已符合「${preset.name}」的格式，无需重排` };
  }
  const summary =
    plan.changes.length > 0 ? plan.changes.join('；') : '标题样式将按新预设重写';
  return {
    kind: 'confirm',
    plan,
    message: `应用「${preset.name}」会修改原文：${summary}`,
  };
}
