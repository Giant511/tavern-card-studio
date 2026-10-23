/**
 * 「我的卡片」列表的行视图（T10.7）。
 *
 * 需求要求一行里同时给出四样东西：**角色名 · cardId · 仓库 · vN**。
 * 为什么四样都要：
 *   · 角色名 —— 人认得出的那个；
 *   · cardId —— 服务端认卡依据，跨端稳定的身份（F11）；只有名字时用户没法确认
 *     "我改的到底是哪一张"；
 *   · 仓库 —— 同一张卡名在不同仓库里可能重复，不给仓库就分不清；
 *   · vN —— 没有版本号的卡是"建过但没传过内容"，与 v1 是两回事。
 *
 * 纯函数、无 DOM：这四个字段的降级规则要能被单测钉住，而不是靠看截图。
 */

import type { CardSummary } from './server-sync.js';

export interface CardRowView {
  /** 主行：角色名（空则占位） */
  name: string;
  /** 寻址键，原样显示（不截断 —— 用户可能要复制） */
  cardId: string;
  /** 仓库名；未归属时为「未归属仓库」 */
  repo: string;
  /** 「v3」或「v—」（从未上传过内容） */
  version: string;
  /** 一行摘要：`角色名 · cardId · 仓库 · v3` */
  summary: string;
  /** 是否已删除（列表默认不含，但 includeDeleted 时会有） */
  deleted: boolean;
}

export function toCardRow(item: CardSummary): CardRowView {
  const name = item.name.trim() === '' ? '（未命名）' : item.name;
  const cardId = item.cardId;
  const repo = item.repoName === null || item.repoName === '' ? '未归属仓库' : item.repoName;
  const version = item.latestSeq > 0 ? `v${item.latestSeq}` : 'v—';

  return {
    name,
    cardId,
    repo,
    version,
    summary: `${name} · ${cardId} · ${repo} · ${version}`,
    deleted: item.deleted,
  };
}

/** 列表为空时的文案：区分"服务端没有卡"与"过滤后没有卡" */
export function emptyCardsText(query: string): string {
  return query.trim() === ''
    ? '这个账户下还没有角色卡。上传一次就会出现在这里。'
    : `没有匹配「${query.trim()}」的角色卡。`;
}

/**
 * 「服务端还没按账户过滤」的诚实提示。
 *
 * 只有"账户登录"时才提：legacy 全局令牌本来就该看到全部卡片，
 * 对它说"还没隔离"是废话。而账户登录下不提，用户会误以为列表已经按账户过滤。
 *
 * 这条提示在 T10.10（卡片按账户 + 仓库过滤）落地后应当删除 ——
 * 留着会变成一句永远为真的免责声明。
 */
export function isolationNote(isAccountLogin: boolean): string | null {
  return isAccountLogin
    ? '服务端尚未按账户过滤（v0.1.2 已知限制）：列表可能包含其他账户的卡片。'
    : null;
}
