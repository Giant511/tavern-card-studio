/**
 * 零标签状态下「取回 / 回滚」的决策（v0.1.3 追加项三）。
 *
 * ## 为什么单独一个纯函数
 *
 * 这段逻辑有三个真会出事的点，而它们全都无法在界面上可靠地验证：
 *
 *   1. **cardId 必须用服务端的那个**。新建会话时若按角色名重新生成 cardId，
 *      用户下一次「上传当前内容」会在服务端**新建一张卡**，而原卡的历史还留
 *      在那儿 —— 两份历史从此分叉，而且没有任何提示。
 *   2. **基线 seq 要用"远端最新"，不是"目标版本"**。回滚会在服务端新建一个
 *      版本（v5 回滚到 v2 → 远端变成 v6），基线记成 2 的话下一次上传会被判分叉。
 *   3. **名字要按本地标签去重**。服务端允许两张不同仓库的同名卡，本地标签栏
 *      不允许同名（`TabBar` 用名字做定位）。
 *
 * 写在 `app.ts` 里就只能靠手点验证，所以抽成纯函数、由
 * `test/remote-apply.test.mjs` 钉死三态。
 *
 * ## 三种状态
 *
 * | 状态 | action | 新名字 | 状态栏 |
 * |---|---|---|---|
 * | 零标签 + 取回 | `create` | 卡片名（去重） | 已创建卡片「x」并载入 v3 内容 |
 * | 零标签 + 回滚 | `create` | 卡片名（去重） | 已回滚并载入 v2 内容 |
 * | 有标签（任意） | `replace` | 不新建 | 沿用既有文案 |
 *
 * 「有标签时行为不变」是需求明写的：那时是**替换当前卡**，沿用既有确认语义，
 * 所以这里刻意**不**改状态栏文案（改了就等于顺手改了既有交互的反馈）。
 */

import { uniqueCardName } from '../editor/open-name.ts';

export type RemoteApplyMode = 'restore' | 'rollback';

export interface RemoteApplyInput {
  /** 当前是否有活动会话（有标签） */
  hasSession: boolean;
  mode: RemoteApplyMode;
  /**
   * 服务端那张卡的 cardId。
   *
   * 必须是**历史面板里选中的那张**的 id —— 零标签时可以选别人的卡来看历史，
   * 在这里取回/回滚之后建出来的本地卡就该指向那张服务端卡。
   */
  serverCardId: string;
  /** 目标版本号（用户点的那一版） */
  targetSeq: number;
  /**
   * 应用之后**远端的最新** seq。
   *
   * 取回时等于 `targetSeq`；回滚时是服务端新建的那个版本号（> targetSeq）。
   */
  remoteSeq: number;
  /** 新卡要用的角色名（通常是 `card.meta.name`） */
  cardName: string;
  /** 本地已打开的标签名，用于重名去重 */
  existingNames: readonly string[];
}

export interface RemoteApplyPlan {
  /** `create` = 零标签，新建会话；`replace` = 有标签，替换当前卡 */
  action: 'create' | 'replace';
  /** `create` 时要用的角色名（已去重）；`replace` 时为 null */
  newSessionName: string | null;
  /** 会话要用的 cardId —— **恒等于 `serverCardId`**，否则上传会新建远端卡 */
  cardId: string;
  /** 会话要记的远端基线 */
  baseSeq: number;
  /** 状态栏一句话 */
  status: string;
}

/**
 * 算出「取回 / 回滚」该怎么做。
 *
 * 纯函数：不改卡片、不碰会话、不发请求，只回答"该新建还是替换、用什么名字、
 * 记哪个基线、状态栏说什么"。
 */
export function planRemoteApply(input: RemoteApplyInput): RemoteApplyPlan {
  if (input.hasSession) {
    return {
      action: 'replace',
      newSessionName: null,
      cardId: input.serverCardId,
      baseSeq: input.remoteSeq,
      // 既有文案（v0.1.2 起就在用）：说明"原文件未自动保存"，提醒另存。
      // 需求要求「已有标签时现有行为不变」，所以这里逐字保留。
      status: `已载入服务端 v${String(input.targetSeq)} 的内容（原文件未自动保存，建议另存）`,
    };
  }

  // 与「零标签打开文件建卡」**共用同一个**去重实现（open-name.ts）：
  // 两处各写一份的话，序号规则迟早一个 ` (2)`、一个 `-2`。
  const name = uniqueCardName(input.cardName, input.existingNames);
  return {
    action: 'create',
    newSessionName: name,
    // **不是** generateCardId(name)：见文件头第 1 条
    cardId: input.serverCardId,
    baseSeq: input.remoteSeq,
    status:
      input.mode === 'rollback'
        ? `已回滚并载入 v${String(input.targetSeq)} 内容`
        : `已创建卡片「${name}」并载入 v${String(input.targetSeq)} 内容`,
  };
}
