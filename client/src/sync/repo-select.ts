/**
 * 仓库选择的纯逻辑（T10.8）—— 不碰 DOM、不碰网络，便于单测。
 *
 * 为什么单独成文件："上传时选哪个仓库"是个会被反复改的默认行为，
 * 而它一旦错了（比如默认选到空仓库、或选到一个已删除的仓库），
 * 用户看到的是"上传成功但卡不见了"。这种 bug 只能靠单测钉住，截图看不出来。
 */

import type { RepoSummary } from './repo-client.js';

export interface RepoOption {
  id: string;
  name: string;
  /** 下拉项显示文本：默认仓库带标记，便于一眼分辨 */
  label: string;
  isDefault: boolean;
  cardCount: number;
}

/**
 * 预选哪个仓库。
 *
 * 优先级：
 *   1. `remembered`（本次会话上次选的）—— 连着传几张卡时不用反复选，
 *      但**只在它仍然存在时**才用：仓库可能刚被删除；
 *   2. 服务端标记的默认仓库；
 *   3. 第一个（服务端按默认仓库优先、其余按名字排序）。
 *
 * 库为空时返回 null —— 调用方应显示"还没有仓库"，而不是假装选中了什么。
 * 注意：账户注册时会自动建默认仓库，所以正常情况下不会为空；
 * 为空只可能是"没登录 / 用的是仓库令牌"。
 */
export function pickRepoId(
  repos: readonly RepoSummary[],
  remembered?: string | null,
): string | null {
  if (repos.length === 0) return null;
  if (remembered && repos.some((repo) => repo.id === remembered)) return remembered;
  const fallback = repos.find((repo) => repo.isDefault) ?? repos[0];
  return fallback?.id ?? null;
}

export function toRepoOptions(repos: readonly RepoSummary[]): RepoOption[] {
  return repos.map((repo) => ({
    id: repo.id,
    name: repo.name,
    label: repo.isDefault ? `${repo.name}（默认）` : repo.name,
    isDefault: repo.isDefault,
    cardCount: repo.cardCount,
  }));
}

/**
 * 上传目标的说明文案。
 *
 * 必须显示仓库名：同一个角色名在不同仓库里可以重复（仓库名只在账户内唯一，
 * 角色名更没有全局约束），不显示仓库用户就没法确认"我这次传到哪儿了"。
 */
export function uploadTargetText(input: {
  cardName: string;
  cardId: string;
  repoName: string | null;
}): string {
  const repo = input.repoName === null || input.repoName === '' ? '未归属仓库' : input.repoName;
  return `${input.cardName} · ${input.cardId} · ${repo}`;
}

/** 令牌范围的中文说明（与 docs/08 的三档一致，delete 归 write） */
export function describeScopes(scopes: readonly string[]): string {
  if (scopes.length === 0) return '（无范围）';
  const map: Record<string, string> = {
    read: '读',
    write: '写（含删除）',
    rollback: '回滚',
  };
  return scopes.map((scope) => map[scope] ?? scope).join(' + ');
}

/**
 * 过期时间的展示。
 *
 * `null` 要显式说"永不过期"，而不是留空 —— 空白会被读成"不知道"，
 * 而"永不过期"是一个需要用户主动确认的安全选择。
 */
export function describeExpiry(expiresAt: string | null, now = Date.now()): string {
  if (expiresAt === null || expiresAt === '') return '永不过期';
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return expiresAt;
  if (at <= now) return `已过期（${expiresAt.slice(0, 10)}）`;
  return expiresAt.slice(0, 10);
}

/** 令牌状态：吊销 > 过期 > 可用（顺序重要：吊销的令牌即使未过期也不可用） */
export function tokenState(
  token: { revokedAt: string | null; expiresAt: string | null },
  now = Date.now(),
): 'revoked' | 'expired' | 'active' {
  if (token.revokedAt !== null) return 'revoked';
  if (token.expiresAt !== null) {
    const at = Date.parse(token.expiresAt);
    if (Number.isFinite(at) && at <= now) return 'expired';
  }
  return 'active';
}
