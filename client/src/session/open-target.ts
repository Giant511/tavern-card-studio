/**
 * 「打开一张卡」的落点决策：**同名覆盖，异名新建**（2026-11-17，用户报）。
 *
 * ## 要修的是什么
 *
 * 旧行为：不管打开哪张卡，一律 `replaceCard` —— 把当前标签的内容整个换掉。
 * 于是"打开一张新卡"等于"悄悄丢弃当前卡的内容"，而用户并没有要求丢弃
 * （他可能以为会新开一个标签，这是多标签编辑器的常识预期）。
 *
 * 用户原话：
 *
 * > 点打开选择一张新的卡的时候会自动替换当前的卡的内容，打开应该检查是否与
 * > 已打开的卡名字相同，如果不同就创建新卡并导入，如果有相同的才覆盖替换，
 * > 这个仅限打开路径（不管是TXT、JSON、PNG）
 *
 * ## 三条规则，各有理由
 *
 * ```text
 * ① 名字为空的待打开卡 → 一律新建
 *    空名字拿去比较会把「任何一张未命名卡」都判成同名 ⇒ 覆盖别人的内容。
 *    宁可多开一个标签（可关闭），也不能静默覆盖。
 *
 * ② 同名时优先覆盖**当前活动**标签
 *    多个同名标签是可能存在的（JSON 的 meta.name 不受去重约束）。
 *    用户视线在哪张，就改哪张 —— 改另一张会表现为"我点了打开，界面没变"。
 *
 * ③ 比较用 trim 后的严格相等，不做大小写/全半角归一
 *    「名字相同」是用户能自己核对的判据。做模糊匹配会让"看起来不一样的名字
 *    却互相覆盖"，而那种覆盖是不可撤销的（内容直接被换掉）。
 *    归一化只会让边界变得无法解释。
 * ```
 *
 * ## 为什么是纯函数
 *
 * 这段逻辑决定"会不会覆盖用户的内容"，必须能被判据直接覆盖到，
 * 而不是只能靠点界面验。调用方（app.ts）只负责执行结论。
 */

/** 已打开标签的最小信息（只要这两项，避免把整个会话类型拖进来） */
export interface OpenSessionRef {
  id: string;
  name: string;
}

export interface OpenTargetInput {
  /** 待打开那张卡的卡名（可能为空串） */
  incomingName: string;
  /** 当前已打开的所有标签 */
  openSessions: readonly OpenSessionRef[];
  /** 当前活动标签 id（零标签时 null） */
  activeId: string | null;
}

export type OpenTarget =
  /** 覆盖已有标签（`sessionId` 可能不是当前活动标签，调用方要先切过去） */
  | { kind: 'replace'; sessionId: string; name: string }
  /**
   * 新建标签并导入。
   *
   * **不带名字**：新卡的名字由调用方定（JSON/PNG 用卡里的 `meta.name`，
   * TXT 用文件名推导，且要经过去重）—— 这个函数只回答"该不该新建"。
   */
  | { kind: 'create' };

/** 比较用的键：去掉首尾空白。空串表示"没有名字"，不参与同名匹配 */
export function nameKey(name: string | null | undefined): string {
  return (name ?? '').trim();
}

/**
 * 决定这次「打开」该落到哪个标签。
 *
 * 返回的 `name` 是**被覆盖那张卡的名字**，供调用方写状态栏 ——
 * 「覆盖了哪一张」必须说出来，否则用户不知道有旧内容被换掉。
 */
export function decideOpenTarget(input: OpenTargetInput): OpenTarget {
  const key = nameKey(input.incomingName);
  if (key === '') return { kind: 'create' };

  const matches = input.openSessions.filter((item) => nameKey(item.name) === key);
  if (matches.length === 0) return { kind: 'create' };

  // 同名多个：优先当前活动那个；否则取第一个（顺序 = 标签顺序，可预期）
  const active = input.activeId === null ? undefined : matches.find((item) => item.id === input.activeId);
  const chosen = active ?? matches[0]!;
  return { kind: 'replace', sessionId: chosen.id, name: key };
}
