/**
 * 世界书条目激活判定（v0.1.7 / T15.4，决策 #270）。
 *
 * ## 为什么这个函数必须在 `shared` 里、且只能有一份
 *
 * 项目里有两处需要"这条世界书条目算不算生效"：
 *
 * | 场景 | 需要什么 |
 * |---|---|
 * | 编辑器审计（字数/规则校验） | **全量**参与统计 |
 * | 聊天上下文拼装 | **只把激活的**塞进 messages |
 *
 * 如果各写一套，会出现"编辑器里显示 12 条激活，聊天时只进去 9 条" ——
 * 而两边**都有自己的测试、都是绿的**。用户没法自证，我们也查不出来。
 * 所以 #270 明确要求共用同一个判定函数。
 *
 * ## 判定的输入是"最近若干条消息"，不是"整段历史"
 *
 * ST 的 `scan_depth` 就是这个含义：只在最近 N 楼里找关键词。
 * 拿整段历史去扫会让早期提过一次的名字一直激活某个条目，
 * 结果越聊上下文越大、越聊越跑偏。
 */

import type { StWorldbookEntry } from '../model/sillytavern.js';

/**
 * ST 的缺省值（与 `shared/src/audit/st-defaults.ts` 一致）。
 *
 * `enabled` 缺省 **true**、`constant` 缺省 **false**。
 * 这两条如果搞反了，表现是"用户新写的条目一条都不生效"或"每条都生效"，
 * 而两种都不报错。
 */
const DEFAULT_ENABLED = true;
const DEFAULT_CONSTANT = false;
/** ST 的 scan_depth 缺省值 */
export const DEFAULT_SCAN_DEPTH = 4;

export interface ActivationOptions {
  /**
   * 最近若干条消息的正文（已按时间顺序，最后一条最新）。
   *
   * 调用方负责截取；这里不再二次截取 —— 因为"深度"的单位是**消息条数**，
   * 而调用方才知道哪几条算"楼"（ST 里同一条消息的 swipe 不算新楼）。
   */
  recentText: string;
  /** ST 的 `scan_depth`；缺省 4 */
  scanDepth?: number;
  /**
   * 概率激活用的随机源。
   *
   * 注入而不是直接 `Math.random()`：否则测试不可复现，
   * 而"这条 30% 概率的条目到底该不该进上下文"必须能被钉死。
   */
  random?: () => number;
}

/** 一条条目的激活结论 + 依据 */
export interface ActivationVerdict {
  index: number;
  entry: StWorldbookEntry;
  active: boolean;
  /**
   * 为什么是这个结论。取值固定几种，便于测试断言与界面显示：
   * `disabled` / `constant` / `keyword` / `no-keyword` / `probability` / `empty`
   */
  reason: 'disabled' | 'constant' | 'keyword' | 'no-keyword' | 'probability' | 'empty';
  /** 命中的关键词（`keyword` 时有值） */
  matchedKeys?: string[];
}

/**
 * 关键词是否出现在文本里。
 *
 * ## 逐条子串匹配，不做分词
 *
 * ST 就是这么做的（`public/scripts/world-info.js` 的 `matchesKeys`）：
 * 关键词可以是任意短语，包括中文、标点、正则符号字面量。
 * 一旦引入分词，"西奥"这种两字名字会被切碎，命中率立刻下降。
 *
 * ## `selective` + `secondary_keys` 是 **AND**
 *
 * 主关键词命中 + 任意一个次关键词也命中，才算激活。
 * 关系搞反（OR）会让条目在该沉默的时候被激活 —— 表现为"聊着聊着突然开始念设定"。
 */
function matchesKeys(text: string, entry: StWorldbookEntry): string[] {
  const caseSensitive = entry.case_sensitive === true;
  const haystack = caseSensitive ? text : text.toLowerCase();

  const normalize = (value: string): string => (caseSensitive ? value : value.toLowerCase());

  const primary = Array.isArray(entry.keys) ? entry.keys.filter(isNonEmptyString) : [];
  const hitPrimary = primary.filter((key) => haystack.includes(normalize(key)));
  if (hitPrimary.length === 0) return [];

  const secondary = Array.isArray(entry.secondary_keys)
    ? entry.secondary_keys.filter(isNonEmptyString)
    : [];
  // 没配次关键词时，selective 不起作用（ST 的行为）
  if (entry.selective === true && secondary.length > 0) {
    const hitSecondary = secondary.some((key) => haystack.includes(normalize(key)));
    if (!hitSecondary) return [];
  }

  return hitPrimary;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 判定单条是否激活。
 *
 * 判定顺序**不可调换**，每一层都在挡一类具体的错：
 *
 * 1. `enabled === false` → 不激活。用户关掉的条目不该生效。
 * 2. 正文为空 → 不激活。空条目进上下文只会浪费 token。
 * 3. `constant === true` → 激活。常驻条目不看关键词（这是它的定义）。
 * 4. `keys` 为空且非常驻 → 不激活。没有触发条件的条目在 ST 里是"永不触发"。
 * 5. 关键词匹配 → 不中则不激活。
 * 6. 概率 → 未通过则不激活。
 */
export function judgeEntry(
  entry: StWorldbookEntry,
  index: number,
  options: ActivationOptions,
): ActivationVerdict {
  const enabled = entry.enabled ?? DEFAULT_ENABLED;
  if (enabled === false) {
    return { index, entry, active: false, reason: 'disabled' };
  }

  const content = typeof entry.content === 'string' ? entry.content.trim() : '';
  if (content === '') {
    return { index, entry, active: false, reason: 'empty' };
  }

  const constant = entry.constant ?? DEFAULT_CONSTANT;
  if (constant === true) {
    return { index, entry, active: true, reason: 'constant' };
  }

  const keys = Array.isArray(entry.keys) ? entry.keys.filter(isNonEmptyString) : [];
  if (keys.length === 0) {
    return { index, entry, active: false, reason: 'no-keyword' };
  }

  const matchedKeys = matchesKeys(options.recentText, entry);
  if (matchedKeys.length === 0) {
    return { index, entry, active: false, reason: 'no-keyword' };
  }

  /*
   * 概率激活：`entry.probability` 是 0–100 的百分比（ST 用整数）。
   * 缺省 100（必然激活）。判据用 `<` 而不是 `<=`，
   * 否则 probability=0 在 random()=0 时会意外激活。
   */
  const probability = typeof entry.probability === 'number' ? entry.probability : 100;
  if (probability < 100) {
    const random = options.random ?? Math.random;
    if (!(random() * 100 < probability)) {
      return { index, entry, active: false, reason: 'probability', matchedKeys };
    }
  }

  return { index, entry, active: true, reason: 'keyword', matchedKeys };
}

/**
 * 判定全部条目的激活状态。
 *
 * 返回**全部**条目（含未激活的），而不是只返回激活的。
 * 因为审计侧要"全量参与统计" —— 它需要知道哪些没生效、为什么。
 * 聊天侧自己 `.filter(v => v.active)` 就行。
 *
 * 这一条设计决定正是 #270 说的"共用同一个判定函数"的落地点：
 * 一个函数，两种消费方式，不会分叉。
 */
export function judgeEntries(
  entries: readonly StWorldbookEntry[],
  options: ActivationOptions,
): ActivationVerdict[] {
  return entries.map((entry, index) => judgeEntry(entry, index, options));
}

/**
 * 只取激活的条目，按 `insertion_order` 排序。
 *
 * 排序规则与 ST 一致：`insertion_order` 小的在前（缺省 100）。
 * 不排序的话，条目在上下文里的先后取决于文件里的顺序 ——
 * 而用户调整顺序的意图就是"这条要在那条之前生效"。
 *
 * 稳定排序：`insertion_order` 相同时保持原顺序（`Array.sort` 在现代引擎里是稳定的）。
 */
export function activeEntriesInOrder(
  entries: readonly StWorldbookEntry[],
  options: ActivationOptions,
): { entry: StWorldbookEntry; verdict: ActivationVerdict }[] {
  const verdicts = judgeEntries(entries, options).filter((verdict) => verdict.active);
  verdicts.sort((a, b) => insertionOrder(a.entry) - insertionOrder(b.entry));
  return verdicts.map((verdict) => ({ entry: verdict.entry, verdict }));
}

function insertionOrder(entry: StWorldbookEntry): number {
  return typeof entry.insertion_order === 'number' ? entry.insertion_order : 100;
}
