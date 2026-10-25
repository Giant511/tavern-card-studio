/**
 * 「新两板块 v0.1.3 只做格式审计」这条边界的唯一落点（追加项一 / 2）。
 *
 * ## 为什么要有这个门
 *
 * 平台规则的 `rules` 全是**内容级**检查（占位符、正则、字数、禁用词…）。
 * 而「初始场景」「对话示例」这两块在 v0.1.3 才出现，它们的"内容好不好"
 * 没有客观标准 —— 开场白写得多长算合适？示例对话该几轮？没有共识，
 * 也不该由我们替用户拍板。
 *
 * 于是定一条边界：**scope 波及这两个板块的内容规则默认不生效**，
 * 除非规则作者显式写 `contentOptIn: true`（那是一个明确的责任声明：
 * "我知道这两块是审美题，这条判据我认为有客观标准"）。
 *
 * ## 为什么按"每段文本"而不是"整条规则"来挡
 *
 * 同一条规则的 scope 常常是 `["block:basic", "block:settings"]` 或 `"*"`。
 * 若按整条规则挡：`scope: "*"` 的规则会因为波及两个新板块而整体失效，
 * 连带把 basic/settings 的检查一起关掉 —— 那是把边界做成了事故。
 * 所以挡的粒度是 `ScopedText`：只丢这两块的那几段，其余照跑。
 *
 * ## 什么不受影响
 *
 *   · **格式类检查照常**：`builtin:*` 那些在 `audit/format.ts` 里，不经过本门
 *     （分隔行二义、旧六板块卡、世界书条目结构…都还在）。
 *   · **显式字段选择器**：`field:first_mes` / `field:mes_example` 这类写法是
 *     规则作者**点名**某个 ST 字段，本身就是"显式声明"，不挡。
 *     （`<START>` 标记、开场白非空这类约定正是靠它们表达的。）
 *
 * 决策表条目：#150。
 */

import type { BlockId } from '../model/blocks.js';
import type { ContentRule } from './platform-rule.js';
import type { ScopedText } from './scopes.js';

/** 只做格式审计的两个板块 */
export const FORMAT_ONLY_BLOCK_IDS: readonly BlockId[] = ['initial-scene', 'chat-examples'];

export function isFormatOnlyBlock(blockId: BlockId | null | undefined): boolean {
  if (blockId === null || blockId === undefined) return false;
  return FORMAT_ONLY_BLOCK_IDS.includes(blockId);
}

/**
 * 按「仅格式」边界过滤取到的文本段。
 *
 * 纯函数：输入输出都是数组，方便单测直接喂构造出来的 ScopedText。
 */
export function scopeForContentRule<T extends Pick<ScopedText, 'blockId'>>(
  scoped: readonly T[],
  rule: Pick<ContentRule, 'contentOptIn'>,
): T[] {
  if (rule.contentOptIn === true) return [...scoped];
  return scoped.filter((item) => !isFormatOnlyBlock(item.blockId));
}

/**
 * 这条规则会不会因为边界被整体跳过（供面板/文档生成"为什么这条没生效"的说明）。
 *
 * 只有一种情况是整体跳过：scope 里**只有**这两个板块，且作者没声明 contentOptIn。
 *
 * ⚠ 入参必须是 `collectScopedTexts()` 的**原始**结果（过滤前）。
 * 传过滤后的数组永远是空集 —— 那会被读成"这条规则本来就没命中任何文本"，
 * 与"被边界挡住"是两件完全不同的事，混起来会让诊断信息说谎。
 */
export function ruleIsFullyGated(
  unfilteredScoped: readonly Pick<ScopedText, 'blockId'>[],
  rule: Pick<ContentRule, 'contentOptIn'>,
): boolean {
  if (rule.contentOptIn === true) return false;
  if (unfilteredScoped.length === 0) return false;
  return unfilteredScoped.every((item) => isFormatOnlyBlock(item.blockId));
}
