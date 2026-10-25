/**
 * 字段板块（对话示例 / 初始场景）与 ST 字段的双向绑定（v0.1.3 / F6b）。
 *
 * ## 权威在哪
 *
 * **`UnifiedCard.residual` 是权威，板块的 `text` 是它的可编辑视图。**
 * 这与 description 那套（`anchor` + `dirty` + 原文）是同一个思路，但更简单：
 * 字段板块没有"原文区间"可言，它的原文就是字段值本身。
 *
 * 于是只有两个方向：
 *   · **导入后**（`blocksWithFieldBlocks`）：`residual → 板块文本`，`dirty = false`；
 *   · **导出前**（`reflectFieldBlocks`）：**仅当板块 `dirty` 时** `板块文本 → residual`。
 *
 * 为什么导出要 `dirty` 门控，而不是无条件重算：
 * 初始场景的多条开场白靠分隔行切分。存量卡的 `first_mes` 正文里天然可能有一行 `---`
 * （剧情分隔线，很常见）。若无条件"渲染 → 再解析"，那一行就会被当成开场白分隔符，
 * 卡里的内容悄悄从 1 条变成 2 条 —— **静默改数据**，比缺功能严重。
 * `dirty` 的含义是"用户在这张卡上真的动过这个板块"，此时切分是他的意图。
 */

import { BLOCK_DEFINITION_MAP, BLOCK_IDS, type BlockId } from '../model/blocks.js';
import type { CardBlock, StResidual, UnifiedCard } from '../model/unified-card.js';
import {
  DEFAULT_GREETING_FORMAT,
  parseGreetings,
  renderGreetings,
  type GreetingFormatParams,
} from './greeting-preset.js';

/**
 * 该板块是否由残余字段驱动。
 *
 * 按 `kind` 派生，不写死 id：v0.1.3 之后如果再加一个"独占某字段"的板块，
 * 只要在 BLOCK_DEFINITIONS 里标成 `field-backed`，这里与所有调用点自动跟随。
 */
export function isFieldBlock(id: BlockId): boolean {
  return BLOCK_DEFINITION_MAP[id]?.kind === 'field-backed';
}

/** 从残余字段渲染出板块文本 */
export function fieldBlockTextFrom(
  residual: Pick<StResidual, 'firstMes' | 'mesExample' | 'alternateGreetings'>,
  id: BlockId,
  format: GreetingFormatParams = DEFAULT_GREETING_FORMAT,
): string {
  if (id === 'initial-scene') {
    return renderGreetings(residual.firstMes, residual.alternateGreetings, format);
  }
  if (id === 'chat-examples') return residual.mesExample;
  return '';
}

export function fieldBlockText(
  card: UnifiedCard,
  id: BlockId,
  format: GreetingFormatParams = DEFAULT_GREETING_FORMAT,
): string {
  return fieldBlockTextFrom(card.residual, id, format);
}

function fieldBlock(id: BlockId, text: string, missing = false): CardBlock {
  return {
    id,
    text,
    raw: text,
    dirty: false,
    // 字段板块没有 description 区间，锚点必须是 null。
    // 若误给一个"空锚点对象"，assembleDescription 会把它当成"有锚点但区间为 0"的板块，
    // 从而跳过"新板块插入"的分支 —— 内容就再也写不进导出了。
    anchor: null,
    ...(missing ? { missing: true } : {}),
  };
}

/**
 * 导入路径：把已解析出的板块补成"完整的 8 板块（除去世界书）"。
 *
 * 非字段板块保持传入的样子；两个字段板块**一律**从残余字段重建 ——
 * 导入时它们还没有独立正文，残余字段就是唯一可信来源。
 */
export function blocksWithFieldBlocks(
  blocks: readonly CardBlock[],
  residual: Pick<StResidual, 'firstMes' | 'mesExample' | 'alternateGreetings'>,
  format: GreetingFormatParams = DEFAULT_GREETING_FORMAT,
): CardBlock[] {
  const byId = new Map<BlockId, CardBlock>(blocks.map((block) => [block.id, block]));
  return BLOCK_IDS.filter((id) => id !== 'worldbook').map((id) => {
    if (isFieldBlock(id)) {
      const text = fieldBlockTextFrom(residual, id, format);
      return fieldBlock(id, text);
    }
    const existing = byId.get(id);
    if (existing) return existing;
    // 防御：解析器没产出该板块（理论上不会），给一个"缺失"空块而不是塞 undefined
    return { id, text: '', raw: '', dirty: false, anchor: null, missing: true };
  });
}

export interface FieldBlockReflection {
  /** 需要覆盖的残余字段（只含真的被改过的） */
  override: Partial<Pick<StResidual, 'firstMes' | 'mesExample' | 'alternateGreetings'>>;
  /** 被回写的板块（诊断/测试用） */
  written: BlockId[];
}

/**
 * 导出路径：算出"应当写进 ST 的残余字段"，只处理 `dirty` 的字段板块。
 * 纯函数，不改卡片 —— 序列化侧据此替换 residual，避免把副作用带进只读流程。
 */
export function reflectFieldBlocks(
  card: UnifiedCard,
  format: GreetingFormatParams = DEFAULT_GREETING_FORMAT,
): FieldBlockReflection {
  const override: FieldBlockReflection['override'] = {};
  const written: BlockId[] = [];

  const examples = card.blocks.find((block) => block.id === 'chat-examples');
  if (examples && examples.dirty) {
    override.mesExample = examples.text;
    written.push('chat-examples');
  }

  const scene = card.blocks.find((block) => block.id === 'initial-scene');
  if (scene && scene.dirty) {
    const parsed = parseGreetings(scene.text, format);
    override.firstMes = parsed.firstMes;
    override.alternateGreetings = parsed.alternateGreetings;
    written.push('initial-scene');
  }

  return { override, written };
}

/** 把残余字段回写结果套到卡片上（返回新对象；无改动时原样返回同一个引用） */
export function applyFieldBlockReflection(
  card: UnifiedCard,
  format: GreetingFormatParams = DEFAULT_GREETING_FORMAT,
): UnifiedCard {
  const { override, written } = reflectFieldBlocks(card, format);
  if (written.length === 0) return card;
  return { ...card, residual: { ...card.residual, ...override } };
}

/**
 * 把字段板块的**视图**刷新成 residual 的最新值（只刷新未编辑的板块）。
 *
 * 模型里 residual 是权威、板块 text 是视图，两者在导入时就一致。
 * 但若有人直接改 `card.residual.firstMes`（测试、将来的批量脚本），
 * 视图就会过期 —— 而读视图的地方（TXT 导出、审计、平台切换）不会报错，
 * 只会安静地用过期的文本。这个函数是"读之前先把视图刷新一下"的标准入口。
 *
 * `dirty` 的板块**不刷新**：那是用户正在编辑的内容，重新渲染会覆盖掉它。
 */
export function refreshFieldBlockViews(
  card: UnifiedCard,
  format: GreetingFormatParams = DEFAULT_GREETING_FORMAT,
): UnifiedCard {
  let changed = false;
  const blocks = card.blocks.map((block) => {
    if (!isFieldBlock(block.id) || block.dirty) return block;
    const text = fieldBlockTextFrom(card.residual, block.id, format);
    if (text === block.text) return block;
    changed = true;
    // 只更新视图（text），**不动 raw**：raw 是"导入时的原文"，与 description.raw 同性质，
    // 留着供「重置」用。改它会让历史写法泄漏进 JSON 快照（也会让平台切换的
    // "旧占位符是否还在卡里"这类检查误报）。
    return { ...block, text };
  });
  return changed ? { ...card, blocks } : card;
}

/**
 * 编辑路径：把某字段板块的新文本写进卡片（`text` + `dirty`），返回新卡片。
 * 文本没变时原样返回，便于上层判断"要不要重跑校验"。
 */
export function setFieldBlockText(
  card: UnifiedCard,
  id: BlockId,
  text: string,
): { card: UnifiedCard; changed: boolean } {
  const existing = card.blocks.find((block) => block.id === id);
  if (!existing) return { card, changed: false };
  if (existing.text === text) return { card, changed: false };
  return {
    card: {
      ...card,
      blocks: card.blocks.map((block) => (block.id === id ? { ...block, text, dirty: true } : block)),
    },
    changed: true,
  };
}
