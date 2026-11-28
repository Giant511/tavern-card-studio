/**
 * 功能
 * 仓库页这一族状态的容器。从 AppShell 的 19 个 `repo*` 字段收拢而来。
 *
 * 注意事项
 * 这里的字段是**可变状态**，壳持有一份实例并原样传给 repo-actions.ts 的函数。
 * 不要按字段复制，也不要在外部缓存某个子字段的引用 —— 函数会整体替换
 * `cards` / `versions` 这类数组（`state.cards = rows`），缓存旧引用会读到过期值。
 *
 * 踩过的坑
 * 这 19 个字段原来散在 AppShell 的 600–790 行之间，中间夹着卡片页与聊天页的字段。
 * 读一段仓库代码要上下翻几百行才知道它有哪几个状态，而漏看一个的后果是
 * 「这个标志位谁在写」判断错，进而改错刷新时机。
 */

import type { RepoConfigState } from '@tcs/shared';

import type { RepoCardRow } from './repo-cards-page';
import type { RepoRow, RepoLinkState, RepoStatus } from './repo-page';
import type { RepoVersionRow } from './repo-card-page';
import type { MobileRepoAuth } from './repo-store';

export interface RepoState {
  /** 用户填的服务端地址与仓库名等 */
  config: RepoConfigState;

  /** 仓库页的登录态。`accessToken` 为空即未登录 */
  auth: MobileRepoAuth;

  /** 续期失败过。与「本地时钟判断过期」区分，见 repoStatus 的注释 */
  authExpired: boolean;

  /** 连通性三态：unknown / ok / refused 等 */
  link: RepoLinkState;
  /** 连通性的补充说明（失败原因的人话） */
  linkDetail: string;
  /** 上次探测的时间戳（毫秒）。0 = 没探过 */
  linkCheckedAt: number;

  /** 卡片列表缓存，避免每次进二级页都拉一遍 */
  cardsCache: RepoCardRow[];
  /** 上面那份缓存对应的 origin。换了服务端就要失效 */
  cardsCacheOrigin: string;

  /** 当前选中的仓库 */
  repoId: string | null;
  repoName: string;

  /** 当前选中的卡（三级页） */
  cardId: string | null;
  cardTitle: string;

  /** 二级页的卡片列表。null = 还没拉到 */
  cardsState: RepoCardRow[] | null;
  cardsError: string;

  /** 三级页的版本列表。null = 还没拉到 */
  versionsState: RepoVersionRow[] | null;
  versionsError: string;

  /** 仓库下拉的列表缓存 */
  reposCache: RepoRow[];

  /** 正在进行的刷新。非 null 表示已有一个在跑，别再发 */
  refreshInFlight: Promise<boolean> | null;

  /**
   * 「下载某一版」的入口。
   *
   * 由二级页渲染时赋值、三级页回调里取用 —— 三级页是另一个函数，
   * 拿不到二级页闭包里的那段逻辑，所以留一个引用。
   * null 表示还没渲染过二级页（理论上进不到三级）。
   */
  importVersion: ((cardId: string, seq: number) => Promise<void>) | null;
}

/**
 * 功能
 * 造一份初始状态。
 *
 * 注意事项
 * 必须用函数而不是模块级常量：常量会被多个实例共享，改一处影响全局。
 * 这里读一次本机配置（readRepoConfig），所以调用时机要在配置可用之后。
 *
 * 踩过的坑
 * 无。
 */
export function createRepoState(seed: {
  config: RepoConfigState;
  auth: MobileRepoAuth;
  link?: RepoLinkState;
}): RepoState {
  return {
    config: seed.config,
    auth: seed.auth,
    authExpired: false,
    link: seed.link ?? 'unknown',
    linkDetail: '',
    linkCheckedAt: 0,
    cardsCache: [],
    cardsCacheOrigin: '',
    repoId: null,
    repoName: '',
    cardId: null,
    cardTitle: '',
    cardsState: null,
    cardsError: '',
    versionsState: null,
    versionsError: '',
    reposCache: [],
    refreshInFlight: null,
    importVersion: null,
  };
}

/** repoStatus 的返回结构（保留在壳里对外暴露时用同一份类型） */
export type { RepoStatus };
