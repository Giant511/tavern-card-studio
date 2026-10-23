/**
 * 卡片可见范围（T10.8，自 T10.10 提前）。
 *
 * 一个请求能看见哪些卡片，完全由它的**凭证**决定。这里把这件事收敛成一个
 * 值对象 + 一段 SQL 片段，好处是：
 *   · 所有查询路径（列表 / 详情 / 版本 / 原文 / 回滚 / 删除 / 统计 / 事件）
 *     共用同一份判据，不会出现"列表过滤了、详情没过滤"这种最常见的漏洞；
 *   · "不属于我"走的是 SQL 的 WHERE，与"不存在"**同一条代码路径** ——
 *     于是两者的响应天然逐字节相同（docs/29 §2.2），不靠人工对齐文案。
 *
 * 三条规则（用户 2026-10-23 拍板）：
 *
 *   1. **账户登录（jwt）**：只看自己 `owner_id` 的卡；仓库令牌再叠加 `repo_id`。
 *   2. **legacy 全局令牌降权**：只看 `owner_id = ''`（未归属）的卡。
 *      为什么降权：全局令牌是 v0.1.1 的"运维凭证"，那时根本不存在账户概念；
 *      一旦库里出现多个账户，再让它看见全部卡片就等于"任何持旧凭证的人都能读
 *      别人的私有内容"。降权到"未归属"是唯一既不断掉它的运维用途（接手历史数据、
 *      跑 adopt）、又不越权的折中。
 *   3. **无身份**（`auth.require = false` 的回环开发模式）：不过滤。
 *      `assertSafeConfig` 已保证这种模式只在回环地址上成立，那里本来就没有
 *      第二个使用者可隔离。
 */

import type { AuthContext } from '../http/auth.js';

export type CardScope =
  /** 不过滤（回环且未开鉴权） */
  | { kind: 'all' }
  /** 只看未归属卡片（legacy 全局令牌） */
  | { kind: 'unowned' }
  /** 只看某账户的卡；`repoId` 非空时再收窄到单个仓库 */
  | { kind: 'owner'; ownerId: string; repoId: string | null };

export const ALL_CARDS: CardScope = { kind: 'all' };
export const UNOWNED_CARDS: CardScope = { kind: 'unowned' };

/**
 * 由请求身份推出可见范围。
 *
 * `identity === null` 只有一种真实来源：`auth.require = false` 的回环模式
 * （TokenGate.check 在 required=false 时直接放行，不解析身份）。那时返回 all。
 */
export function scopeFromIdentity(identity: AuthContext | null): CardScope {
  if (identity === null) return ALL_CARDS;

  if (identity.via === 'legacy') return UNOWNED_CARDS;

  if (identity.via === 'repo-token') {
    // 仓库令牌必然绑定账户（签发时就要 ownerId）；万一数据坏成 null，
    // 按"什么都看不见"处理更安全 —— 返一个不可能匹配的 ownerId 比放行好。
    const ownerId = identity.userId ?? '';
    return {
      kind: 'owner',
      ownerId,
      repoId: identity.repoToken?.repoId ?? null,
    };
  }

  // jwt：账户范围。**管理员不跨账户读卡内容** —— 管理账户与仓库不等于
  // 有权读别人的私有角色卡；需要运维级访问时用 legacy 令牌配合 adopt，
  // 那是一条会被日志记录的动作。
  return { kind: 'owner', ownerId: identity.userId ?? '', repoId: null };
}

/**
 * 生成 SQL 条件片段。
 *
 * 返回 `{ clause, params }`；`clause` 为空串表示不加限制。
 * **一律用命名参数**（`:scopeOwner` 等）而不是拼字面量，值永远走参数绑定。
 *
 * `column` 前缀用于 JOIN 场景（例如事件表要限定 `cards.owner_id`）。
 */
export function scopeSql(
  scope: CardScope,
  prefix = '',
): { clause: string; params: Record<string, string> } {
  switch (scope.kind) {
    case 'all':
      return { clause: '', params: {} };
    case 'unowned':
      return { clause: `${prefix}owner_id = ''`, params: {} };
    case 'owner': {
      const conditions = [`${prefix}owner_id = :scopeOwner`];
      const params: Record<string, string> = { scopeOwner: scope.ownerId };
      if (scope.repoId !== null) {
        conditions.push(`${prefix}repo_id = :scopeRepo`);
        params['scopeRepo'] = scope.repoId;
      }
      return { clause: conditions.join(' AND '), params };
    }
    default: {
      // 穷尽检查：新增 kind 而忘了处理时，这里编译期就报错
      const exhaustive: never = scope;
      return exhaustive;
    }
  }
}

/** 单行是否在范围内（内存判断，用于已取出的行做二次确认） */
export function rowInScope(
  row: { owner_id: string; repo_id: string },
  scope: CardScope,
): boolean {
  switch (scope.kind) {
    case 'all':
      return true;
    case 'unowned':
      return row.owner_id === '';
    case 'owner':
      if (row.owner_id !== scope.ownerId) return false;
      return scope.repoId === null || row.repo_id === scope.repoId;
    default:
      return false;
  }
}

/** 给日志/响应用的可读描述（不含敏感 id 之外的信息） */
export function describeScope(scope: CardScope): string {
  switch (scope.kind) {
    case 'all':
      return 'all';
    case 'unowned':
      return 'unowned';
    case 'owner':
      return scope.repoId === null ? `owner:${scope.ownerId}` : `owner:${scope.ownerId}/repo:${scope.repoId}`;
    default:
      return 'unknown';
  }
}
