/**
 * 功能
 * 仓库页的全部行为：登录注册、连通性探测、三层列表（仓库 / 卡片 / 版本）的
 * 拉取与渲染、版本导入。从 AppShell 的 23 个 `repo*` 方法搬出（原 840 行）。
 *
 * 注意事项
 * 状态不在本模块，在 `RepoState`（见 repo-state.ts）。每条函数第一个参数是
 * `host: RepoHost`，通过 `host.state.xxx` 读写状态。
 * `render*` 系列会改 `host.state` 并把 DOM 挂到 `host.pageHost`，不要在渲染中途
 * 再调一次同级的 render（会叠两层页面）。
 * `runRepoRequest` 是统一的 401 续期重试入口，新加仓库请求请走它，
 * 不要自己写 try/catch。
 *
 * 踩过的坑
 * 这些方法原来在 `AppShell` 里，靠 `this.repo*` 直接读写 19 个散落字段。
 * 字段散在 600–790 行之间且与卡片页、聊天页字段交错，读一段仓库代码要
 * 上下翻几百行才知道有几个状态；漏看一个就会把「这个标志位谁在写」判断错。
 * 现在状态收进一个对象，函数签名上就能看到它依赖什么。
 */

import type { RepoConfigState } from '@tcs/shared';
import {
  buildPngCard,
  describeBridgeError,
  type ImportPlan,
  convertEmbeddedWorldbook,
  isPngBytes,
  parseCharacterList,
  parsePngCard,
  planCardImport,
  resolveRepoOrigin,
  stringifyStCard,
} from '@tcs/shared';

import {
  login as apiLogin,
  logout as apiLogout,
  refresh as apiRefresh,
  register as apiRegister,
} from '../auth/auth-client';
import { convertToPng } from '../export/face-convert';
import { pickFetch, setInsecureOrigins } from './native-fetch';
import { loadThumbnail } from './thumbnail';
import { renderRepoPage as renderRepoPageView, type RepoLinkState, type RepoRow, type RepoStatus } from './repo-page';
import { renderRepoCardsPage as renderRepoCardsPageView, type RepoCardRow } from './repo-cards-page';
import { renderRepoCardPage as renderRepoCardPageView, type RepoVersionRow } from './repo-card-page';
import {
  clearRepoAuth,
  readRepoAuthFor,
  writeRepoAuth,
  writeRepoConfig,
} from './repo-store';
import {
  deleteCard as repoDeleteCard,
  fetchFace as repoFetchFace,
  fetchVersionText as repoFetchVersionText,
  listCards as repoListCards,
  listVersions as repoListVersions,
  rollbackCard as repoRollbackCard,
  uploadCard as repoUploadCard,
} from '../sync/server-sync';
import { listRepos as repoListRepos } from '../sync/repo-client';
import type { CardSummary } from '../sync/server-sync';

import type { CardWriteResult } from './shell-contract';
import type { RepoState } from './repo-state';
import type { DocLike, ElLike } from './chat-view';
import type { ShellOptions } from './shell-contract';
import type { StChatBridge } from './st-bridge';

/**
 * 功能
 * 本模块能碰的壳能力。
 *
 * 注意事项
 * 只有 6 个方法，都是"页面级"动作。加新成员前先想清楚是不是可以
 * 折进 `RepoState` 或从参数传进来 —— 这个接口越长，仓库页与壳越难分开。
 *
 * 踩过的坑
 * 无。
 */
export interface RepoHost {
  readonly state: RepoState;
  readonly doc: DocLike;
  /** 承载页面的容器。渲染前可能为 null（渲染函数内部会判空返回） */
  readonly pageHost: ElLike | null;
  readonly bridge: StChatBridge;
  /**
   * 用户已确认「不校验证书」的 origin 列表。
   * 可写：保存仓库配置时按 `ackedPlainOrigin` 与 `trustedCertOrigins` 重算。
   */
  insecureOrigins: string[];
  readonly options: ShellOptions;

  /** 连 ST / 壳的通用连接包装 */
  withConnection<T>(run: () => Promise<T>): Promise<T>;
  /** 自签证书信任流程。origin 决定「信任哪个地址」，不是装饰参数 */
  withCertTrust<T>(origin: string, action: () => Promise<T>): Promise<T>;
  /** 重绘当前页（会走转场） */
  renderPage(): void;
  /** 回上一级（层级表） */
  goBackOneLevel(): boolean;
  /** 给导入的卡规划文件名（重名时问用户）。返回 null 表示用户取消 */
  resolveCardPlacement(input: {
    jsonText: string;
    cardId: string;
    confirmOverwrite: boolean;
  }): Promise<ImportPlan | null>;

  /**
   * 把一张卡写进本地卡片库。
   *
   * 返回值里的 `worldbook` 三态要如实转告用户：`none` 是卡本来没书（不用提示），
   * `failed` 是有书但没落地（必须提示，否则用户以为卡带了书）。
   */
  writeCardToLibrary(input: {
    plan: ImportPlan;
    jsonText: string;
    base: Uint8Array | null;
  }): Promise<CardWriteResult>;
}

export function repoOrigin(host: RepoHost): string | null {
  const resolved = resolveRepoOrigin(host.state.config);
  return resolved.ok ? resolved.address.origin : null;
}

export async function repoFetchWithRefresh<T>(host: RepoHost, origin: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!isUnauthorized(host, error)) throw error;
    const renewed = await refreshRepoAuth(host);
    if (!renewed) throw repoExpiredError(host);
    return await work();
  }
}

export function isUnauthorized(host: RepoHost, error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'UNAUTHORIZED'
  );
}

export function repoExpiredError(host: RepoHost): Error {
  host.state.authExpired = true;
  host.options.onNotify?.('登录已过期，请重新登录', 'warn');
  /* 让页面刷一次：这会把它从「已登录」切到「需要重新登录」的形态 */
  host.renderPage();
  return new Error('登录已过期，请点「重新登录」');
}

export async function refreshRepoAuth(host: RepoHost): Promise<boolean> {
  /* 已经在刷 ⇒ 等同一个结果，不要各刷各的 */
  if (host.state.refreshInFlight !== null) return await host.state.refreshInFlight;

  const origin = repoOrigin(host);
  if (origin === null || host.state.auth.refreshToken === '') return false;

  const task = (async (): Promise<boolean> => {
    try {
      const bundle = await host.withCertTrust(origin, () =>
        apiRefresh(origin, host.state.auth.refreshToken, { fetchImpl: pickFetch() }),
      );
      /*
       * ★ refresh token 也换了（轮换），必须**立刻**把新的存下来。
       *
       * 不存的话：这次续期能成功，但下次（2 小时后）拿的还是旧 refresh
       * token，而它早已被服务端作废 ⇒ 那时就真的只能重新登录了。
       */
      host.state.auth = {
        accessToken: bundle.accessToken,
        refreshToken: bundle.refreshToken,
        accessExpiresAt: bundle.accessExpiresAt,
        userId: bundle.user.userId,
        username: bundle.user.username,
      };
      await writeRepoAuth(origin, host.state.auth);
      host.state.authExpired = false;
      return true;
    } catch {
      /*
       * 静默返回 false，由调用方统一提示。
       *
       * 这里不 `onNotify`：续期失败时可能有多个请求同时走到，
       * 弹三条"登录已过期"比一条更糟（用户会以为出了三个错）。
       */
      return false;
    }
  })();

  host.state.refreshInFlight = task;
  try {
    return await task;
  } finally {
    host.state.refreshInFlight = null;
  }
}

export function repoStatus(host: RepoHost): RepoStatus {
  return {
    config: host.state.config,
    username: host.state.auth.accessToken === '' ? null : host.state.auth.username,
    /*
     * ★★★ 只认「真的续期失败」这一个事实（2026-11-07 修正）。
     *
     * 第一版这里按**本地时钟**判断 `accessExpiresAt < now`，于是问题变成：
     *
     * ```text
     *   隔天打开 App
     *     ⇒ access 一定过期（只有 2 小时）
     *     ⇒ 页面直接写"登录已过期，请重新登录"
     *     ⇒ 而其实 refresh token 还有 30 天，完全能自动续上
     * ```
     *
     * 那等于把"用户无感的自动续期"变成了"每次重启都吓用户一跳"，
     * 还逼他重新输密码 —— 比原来的 bug 更糟。
     *
     * 所以本地时钟**不再参与**这个判断。流程改成：
     *
     * ```text
     *   进仓库页（显示「已登录」）
     *     → 发请求 → 401 → 自动 refresh → 成功 ⇒ 用户完全无感 ✓
     *                                    → 失败 ⇒ 置 repoAuthExpired
     *                                             UI 才知道要重新登录
     * ```
     *
     * `repoAuthExpired` 是**我试过并失败**的事实，不是推测。
     */
    expired: host.state.authExpired,
    repoTokenMode: false,
    link: host.state.link,
    linkDetail: host.state.linkDetail,
    linkCheckedAt: host.state.linkCheckedAt,
  };
}

export async function probeRepoLink(host: RepoHost): Promise<{ state: RepoLinkState; detail: string }> {
  const settle = (state: RepoLinkState, detail: string): { state: RepoLinkState; detail: string } => {
    host.state.link = state;
    host.state.linkDetail = detail;
    host.state.linkCheckedAt = Date.now();
    return { state, detail };
  };

  const origin = repoOrigin(host);
  if (origin === null) {
    /*
     * 地址还没填好（切到自定义仓库但没写地址）。
     *
     * 这**不是离线** —— 是"还没配"。给 offline 会让用户去查网络，
     * 而实际要做的是把地址填上。所以保留 unknown 并说明原因。
     */
    return settle('unknown', '还没填服务端地址');
  }

  try {
    /*
     * 直接打 `/version`，**不带 Authorization**。
     *
     * 带了反而不好：令牌过期会被服务端回 401，而我们本来就把 401 算在线，
     * 所以不影响结论 —— 但不带能让这次请求更纯粹地"只测连通"，
     * 也不会在服务端留下一次带凭据的访问记录。
     */
    const response = await host.withCertTrust(origin, () =>
      pickFetch()(`${origin}/version`, { method: 'GET' }),
    );

    /*
     * 任何 HTTP 响应都说明连上了。`response.status > 0` 是判据 ——
     * 0 表示"没拿到状态码"（原生通道的失败路径会给 0）。
     */
    if (response.status > 0) {
      const at = new Date();
      const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
      return settle('online', `服务端有响应（HTTP ${String(response.status)}），${hhmm} 确认`);
    }
    return settle('offline', '服务端没有返回状态码');
  } catch (error) {
    /*
     * 连不上。把**原始原因**带上（`cause` 里可能是证书问题），
     * 否则用户只看到"连不上"，不知道该改地址还是换个网络。
     */
    return settle('offline', describeBridgeError(error).message);
  }
}

export function repoSyncConfig(host: RepoHost): { serverUrl: string; token: string } | null {
  const origin = repoOrigin(host);
  if (origin === null) return null;
  return { serverUrl: origin, token: host.state.auth.accessToken };
}

export async function runRepoRequest<T>(host: RepoHost, 
  work: (config: { serverUrl: string; token: string }) => Promise<T>,
): Promise<T> {
  const first = repoSyncConfig(host);
  if (first === null) throw new Error('还没配置服务端地址');

  return await repoFetchWithRefresh(host, first.serverUrl, async () => {
    /* ★ 每次执行都重新取：续期后这里拿到的才是新 token */
    const config = repoSyncConfig(host);
    if (config === null) throw new Error('还没配置服务端地址');
    return await host.withCertTrust(config.serverUrl, () => work(config));
  });
}

export async function saveRepoConfig(host: RepoHost, next: RepoConfigState): Promise<boolean> {
  const beforeOrigin = repoOrigin(host);
  const beforeKind = host.state.config.kind;

  /* 合并证书信任：页面传上来的可能是旧副本 */
  const merged: RepoConfigState = {
    ...next,
    trustedCertOrigins:
      next.trustedCertOrigins.length >= host.state.config.trustedCertOrigins.length
        ? next.trustedCertOrigins
        : host.state.config.trustedCertOrigins,
  };

  await writeRepoConfig(merged);
  host.state.config = merged;

  host.insecureOrigins = [
    ...(merged.ackedPlainOrigin === '' ? [] : [merged.ackedPlainOrigin]),
    ...merged.trustedCertOrigins,
  ];
  setInsecureOrigins(host.insecureOrigins);

  const afterOrigin = repoOrigin(host);
  if (beforeOrigin !== afterOrigin || beforeKind !== merged.kind) {
    const hadAuth = host.state.auth.accessToken !== '';

    /*
     * ★★★ 切换服务端 = **登出旧服务端**，不再"换槽保留"（2026-11-05）。
     *
     * 上一版是"把当前登录态存进旧 origin 那一格，再从新 origin 那一格读"，
     * 目的是让用户切回来不用重登。**那个设计被用户判为危险**：
     *
     * > 还有一个很危险的问题就是自定义和云仓库可以同时登录
     *
     * 真机录屏证实：内置云仓库「已登录：Gez」、自定义仓库「已登录：testuser」，
     * 两套凭据并存，切过去还会拿错令牌（报「缺少或无效的访问令牌」）。
     *
     * 现在：**同一时间只允许一处登录**。切换即登出，
     * 新服务端从"未登录"开始 —— 想用它就重新登录。
     *
     * `writeRepoAuth` 里也加了同样的互斥（登录任一处就清掉其它 origin），
     * 两处是**同一条纪律的两个入口**：一个是切换离开，一个是登录进来。
     *
     * ★ 登出要**说一声**：莫名"掉登录"会让用户以为是 bug
     * （上一版改动的起因正是这个），所以给一条明确的提示。
     */
    if (hadAuth) {
      await clearRepoAuth(beforeOrigin ?? '');
      host.options.onNotify?.(
        beforeKind === merged.kind
          ? '换了服务端地址，已退出原来的登录'
          : '切换了仓库类型，已退出原来的登录',
        'warn',
      );
    }

    /*
     * 新服务端**不再从槽里恢复** —— 那里现在是空的。
     * 留这一句而不是直接置空，是为了让"同一 origin 只改了写法"的情况
     * 仍然走读盘（`beforeOrigin === afterOrigin` 时根本不会进这个分支，
     * 所以这里必定是空）。
     */
    host.state.auth = readRepoAuthFor(afterOrigin ?? '');

    /*
     * ★★★ 换了服务端，**旧的连通结论必须作废**（2026-11-06）。
     *
     * 连通状态有 60 秒的"新鲜期"（见 `repo-link` 那段：短时间内切走再
     * 切回来不重新探测）。但"切了服务端"是完全不同的事 —— 前一秒
     * 还在 A 上测出 `online`，切到 B 之后如果沿用这个结论：
     *
     * ```text
     *   A 通、B 不通  ⇒ 界面显示绿灯「已连接」，点上传却失败
     *   A 不通、B 通  ⇒ 界面显示红灯「连不上」，其实 B 好好儿的
     * ```
     *
     * 两种都会让用户去查错方向。所以这里把状态清回 `unknown`，
     * 新页面进来会立刻重新探测（进页面时 `unknown` ⇒ 探测并显示「检测中」）。
     *
     * ★ 不用"只重置时间戳、保留状态"—— 保留旧状态仍然是错的结论。
     */
    host.state.link = 'unknown';
    host.state.linkDetail = '';
    host.state.linkCheckedAt = 0;
    /* 卡片缓存同理（`onCachedCards` 已有 origin 校验，这里显式清更明确） */
    host.state.cardsCache = [];
    host.state.cardsCacheOrigin = '';

    return hadAuth || host.state.auth.accessToken !== '';
  }
  return false;
}

export async function repoLoginWith(host: RepoHost, 
  config: RepoConfigState,
  username: string,
  password: string,
): Promise<void> {
  await saveRepoConfig(host, config);

  const resolved = resolveRepoOrigin(host.state.config);
  if (!resolved.ok) throw new Error(resolved.reason);
  const origin = resolved.address.origin;

  /*
   * ★ 注入 `pickFetch()` 而不是默认的全局 fetch。
   *
   * 真机实测：这个 WebView 里 fetch 完全不可用（连 127.0.0.1 都
   * `Failed to fetch`），而聊天走的是 invoke 到 Rust，从没经过它。
   * 所以这里换成走 Android 原生 HTTP 通道。
   */
  const bundle = await host.withCertTrust(origin, () =>
    apiLogin(origin, { username, password }, { fetchImpl: pickFetch() }),
  );

  host.state.auth = {
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken,
    accessExpiresAt: bundle.accessExpiresAt,
    userId: bundle.user.userId,
    username: bundle.user.username,
  };
  await writeRepoAuth(repoOrigin(host) ?? '', host.state.auth);
  host.options.onNotify?.(`已登录：${host.state.auth.username}`, 'ok');
  host.renderPage();
}

export async function repoRegisterWith(host: RepoHost, 
  config: RepoConfigState,
  username: string,
  password: string,
  inviteCode: string,
): Promise<void> {
  await saveRepoConfig(host, config);

  const resolved = resolveRepoOrigin(host.state.config);
  if (!resolved.ok) throw new Error(resolved.reason);
  const origin = resolved.address.origin;

  /*
   * 邀请码**只在内置云仓库才传**。
   *
   * `auth-client.register` 的注释写明"无条件透传没影响"，但这里还是
   * 按"内置才传"来做：让请求体与用户看到的东西一致（自定义模式下
   * 界面上没有邀请码框，请求里也不该出现一个用户没填过的字段）。
   */
  const invite =
    host.state.config.kind === 'cloud' && inviteCode !== '' ? inviteCode : undefined;

  const outcome = await host.withCertTrust(origin, () =>
    apiRegister(
      origin,
      { username, password, inviteCode: invite },
      { fetchImpl: pickFetch() },
    ),
  );

  /*
   * `tokens === null` 表示服务端只建了号、没给会话
   * （`admin-only` 模式下管理员替人建号的场景）。那种情况不能假装登录成功。
   */
  if (outcome.tokens === null) {
    host.options.onNotify?.('账户已创建，请用新账号登录', 'ok');
    host.renderPage();
    return;
  }

  /* ★ 注册后自动登录（用户明确要求） */
  host.state.auth = {
    accessToken: outcome.tokens.accessToken,
    refreshToken: outcome.tokens.refreshToken,
    accessExpiresAt: outcome.tokens.accessExpiresAt,
    userId: outcome.user.userId,
    username: outcome.user.username,
  };
  await writeRepoAuth(repoOrigin(host) ?? '', host.state.auth);
  host.options.onNotify?.(`已注册并登录：${host.state.auth.username}`, 'ok');
  host.renderPage();
}

export function renderRepoPage(host: RepoHost): void {
  if (host.pageHost === null) return;

  const page = renderRepoPageView(host.doc, repoStatus(host), {
    onConfigChange: async (next) => {
      const authCleared = await saveRepoConfig(host, next);

      /*
       * ★★★ 只在「登录态被清掉」时重画整页。
       *
       * 2026-11-04 真机验收抓到的缺陷（③⑪⑫⑮ 一起红）：
       *
       * ```text
       *   用户填了用户名 / 密码
       *   → 点地址框（失焦触发 change）→ 地址存盘 → renderPage()
       *   → 页面重建，用户名密码回到空（它们在 render 的闭包里）
       *   → 再点「登录」→ 守卫报「用户名和密码都要填」
       * ```
       *
       * 而且更糟：`change` 是在**点登录按钮导致失焦**时触发的，
       * 于是用户点的正是那颗即将被移除的按钮 —— 表现为"点了没反应"。
       *
       * 地址变了但 origin 没变（同一个服务端换个写法）时，账户区
       * 压根不需要变；`kind` 切换由页面自己的 `paint()` 收尾。
       * 只有"换了服务端 ⇒ 令牌作废"这一件事必须整页重画，
       * 因为要从「已登录」翻回登录表单。
       */
      if (authCleared) host.renderPage();
    },

    onLogin: async (config, username, password) => {
      await repoLoginWith(host, config, username, password);
    },

    onRegister: async (config, username, password, inviteCode) => {
      await repoRegisterWith(host, config, username, password, inviteCode);
    },

    onLogout: async () => {
      const origin = repoOrigin(host);
      if (origin !== null && host.state.auth.accessToken !== '') {
        /*
         * 服务端吊销失败也照常清本地。
         *
         * 用户的诉求是"从这台机器上退出"，不该因为网络问题被困住。
         */
        try {
          await apiLogout(origin, host.state.auth.accessToken, { fetchImpl: pickFetch() });
        } catch {
          /* 忽略：本地照样清 */
        }
      }
      await clearRepoAuth();
      host.state.auth = { accessToken: '', refreshToken: '', accessExpiresAt: 0, userId: '', username: '' };
      host.options.onNotify?.('已登出', 'ok');
      host.renderPage();
    },

    onProbeLink: () => probeRepoLink(host),

    /* ── 仓库列表（一级，2026-11-06）── */

    /*
     * 拉仓库列表。
     *
     * ★ 这是把"一页到底"改成三级的核心：服务端支持多仓库
     *   （`/api/repos`，带 `cardCount`），所以列表直接用它。
     */
    onListRepos: async () => {
      const items = await runRepoRequest(host, (config) =>
        /* 仓库列表接口只认账户令牌，所以要显式给 `accessToken` 字段名 */
        repoListRepos(
          { serverUrl: config.serverUrl, accessToken: config.token },
          { fetchImpl: pickFetch() },
        ),
      );
      const rows: RepoRow[] = items.map((one) => ({
        id: one.id,
        name: one.name,
        description: one.description,
        cardCount: one.cardCount,
        isDefault: one.isDefault,
      }));
      host.state.reposCache = rows;
      return rows;
    },

    onCachedRepos: () => host.state.reposCache,

    /**
     * 「刷新」按钮（2026-11-07，用户建议）。
     *
     * ## 它做三件事，顺序不能反
     *
     * ```text
     *   ① 清掉"已过期"标记 —— 用户主动重试了，先给它一次干净机会
     *   ② 重新拉仓库列表   —— 失败会抛出，由页面显示原因
     *   ③ 重探连通性       —— 顶部指示灯要跟着更新
     * ```
     *
     * ★ 先清标记再拉：如果先拉再清，那么"令牌已失效"的状态下
     *   拉取会立刻因为标记而走失败分支，用户点了刷新还是看到过期提示 ——
     *   等于这个按钮没用。
     */
    onRefresh: async () => {
      host.state.authExpired = false;
      /*
       * 主动刷新时把缓存的"过期结论"也丢掉：这次要走真正的网络。
       * 不清的话，`runRepoRequest` 里续期成功的路径是对的，但
       * 假如下面 `onListRepos` 因为别的原因失败，缓存会让人以为
       * 刷新没发生。
       */
      host.state.reposCache = [];

      /* 这一步失败就抛给页面，别吞 —— 用户点了按钮就是要一个结果 */
      const rows = await runRepoRequest(host, (config) =>
        repoListRepos(
          { serverUrl: config.serverUrl, accessToken: config.token },
          { fetchImpl: pickFetch() },
        ),
      );
      host.state.reposCache = rows.map((one) => ({
        id: one.id,
        name: one.name,
        description: one.description,
        cardCount: one.cardCount,
        isDefault: one.isDefault,
      }));

      /*
       * 点亮顶部指示灯。单独的 catch：探测失败不该让"刷新列表"这个动作
       * 显示成失败（列表可能已经成功了）。
       *
       * ★ 不用 `host.state.link = result.state` —— `probeRepoLink()` 内部
       *   已经在 `settle()` 里写过这些字段了，外面再赋一次是重复。
       *   重复写同一件事，将来改了其中一处就会分叉。
       */
      void probeRepoLink(host).catch(() => {
        /* 探测是附加信息，失败就保持原样 */
      });

      host.options.onNotify?.('已刷新', 'ok');
      host.renderPage();
    },

    onOpenRepo: (repoId, repoName) => {
      host.state.repoId = repoId;
      host.state.repoName = repoName;
      host.state.cardId = null;
      host.state.cardTitle = '';
      /* 进二级：清掉上次的列表状态，避免先显示别的仓库的卡 */
      host.state.cardsState = null;
      host.state.cardsError = '';
      host.renderPage();
      void loadRepoCards(host, repoId);
    },

    /* 上传列表里的圆形头像（与角色选择器同一个取图实现） */
    onThumbnail: (avatar: string) => loadThumbnail(avatar),

    onPickLocalCard: async () => {
      const raw = await host.withConnection(() => host.bridge.listCharactersRaw());
      const parsed = parseCharacterList(raw);
      if (!parsed.ok) throw new Error(parsed.reason);
      return parsed.items.map((one) => ({ avatar: one.avatar, name: one.name }));
    },

    onUpload: async (avatar) => {
      /*
       * 从 ST 引擎读出这张卡，解出卡 JSON 原文。
       *
       * 走 PNG 而不是 `/api/characters/get`：后者返回的是 ST 加工过的视图，
       * 拿它上传会把加工痕迹一起传进仓库（`chat_size` / `date_last_chat` 之类）。
       * PNG 里那份才是用户创作的内容。
       */
      const pngBytes = await host.withConnection(() => host.bridge.characterPng(avatar));
      const parsed = parsePngCard(new Uint8Array(pngBytes));
      /*
       * `kind === 'bare'` = 这张 PNG 里没有卡数据块。
       * 那不是"没卡可传"，而是这张卡的数据只在 .json 里（或文件损坏）——
       * 两种情况都不该悄悄传一张空卡上去，所以直接报错让用户看到。
       */
      if (parsed.kind !== 'card') {
        throw new Error(`这张卡没有内嵌设定数据（${parsed.note}）`);
      }

      /*
       * 不加 cardId：让服务端按内容/标题判定新建还是追加版本。
       *
       * ★ 这里**没有**做"本地查映射再决定 cardId"—— 桌面端有一整套
       * `st-push-name` 处理这件事，那套依赖"卡文件里存了 cardId"。
       * 手机端读的卡来自 ST 目录，里面通常没有 `extensions.tcs.cardId`，
       * 所以退化成"按标题 upsert"是当前唯一正确的行为。
       */
      const result = await runRepoRequest(host, (config) =>
        repoUploadCard(config, { text: parsed.jsonText }, { fetchImpl: pickFetch() }),
      );
      return { created: result.created, seq: result.seq };
    },

    onLoadVersions: async (cardId) => {
      const items = await runRepoRequest(host, (config) =>
        repoListVersions(config, cardId, { fetchImpl: pickFetch() }),
      );
      return items.map((one) => ({
        seq: one.seq,
        commit: one.commit,
        createdAt: one.commit,
        sha256: one.sha256,
        message: one.message ?? '',
      }));
    },

    onRollback: async (cardId, seq) => {
      await runRepoRequest(host, (config) =>
        repoRollbackCard(config, cardId, seq, { fetchImpl: pickFetch() }),
      );
    },

    onDeleteCard: async (cardId) => {
      await runRepoRequest(host, (config) =>
        repoDeleteCard(config, cardId, { fetchImpl: pickFetch() }),
      );
    },

    /**
     * 把仓库里某一版**下载成一张本地角色卡**（2026-11-04，用户要求）。
     *
     * ## 没有「ST」字样
     *
     * 用户明令：这里是对用户可见的流程，必须说"角色库 / 卡片"，
     * 不能说内部引擎的名字。所有文案都在 `repo-page.ts` 与这里，
     * `test/no-internal-terms.test.mjs` 会扫。
     *
     * ## 四步，每步都可能单独失败
     *
     * ```text
     *   ① 拉那一版的 JSON 原文        → 网络/权限失败
     *   ② 算出文件名与块类型           → 纯函数（planCardImport）
     *   ③ 拿一张 PNG 当容器            → 内置兜底卡面（桌面端同一张）
     *   ④ buildPngCard + 原子写文件     → 写盘失败
     * ```
     */
    onImportVersion: (cardId, seq) => importRepoVersion(host, cardId, seq),

    onNotify: (message, kind) => host.options.onNotify?.(message, kind),
  });

  /*
   * 把"下载某一版"暴露给三级页面（2026-11-06）。
   *
   * 那段逻辑就跑在上面的 `onImportVersion` 闭包里，三级页面是另一个
   * 函数拿不到它。这里留一个引用，等于"页面一渲染就绪就可用"。
   * 没就绪时（理论上进不到三级）三级页面会给一句人话。
   */
  host.state.importVersion = (cardId, seq) =>
    importRepoVersion(host, cardId, seq);

  host.pageHost.append(page);
}

export function renderRepoCardsPage(host: RepoHost): void {
  if (host.pageHost === null) return;

  const page = renderRepoCardsPageView(
    host.doc,
    {
      repoName: host.state.repoName,
      cards: host.state.cardsState,
      error: host.state.cardsError,
    },
    {
      onLoadCards: async () => fetchRepoCards(host),
      onFace: async (cardId) => loadCardFace(host, cardId),
      onOpenCard: (cardId, title) => {
        host.state.cardId = cardId;
        host.state.cardTitle = title;
        host.state.versionsState = null;
        host.state.versionsError = '';
        host.renderPage();
        void loadRepoVersions(host, cardId);
      },
      onBack: () => host.goBackOneLevel(),
      onNotify: (message, kind) => host.options.onNotify?.(message, kind),
    },
  );

  host.pageHost.append(page);
}

export function renderRepoCardPage(host: RepoHost): void {
  if (host.pageHost === null) return;
  const cardId = host.state.cardId;
  if (cardId === null) return;

  const page = renderRepoCardPageView(
    host.doc,
    {
      cardTitle: host.state.cardTitle,
      repoName: host.state.repoName,
      versions: host.state.versionsState,
      error: host.state.versionsError,
    },
    {
      onLoadVersions: async () => fetchRepoVersions(host, cardId),
      /*
       * 下载：把这一版导入成手机上的一张新卡。
       *
       * ★ 复用原来 `onImportVersion` 的整条逻辑（取文本 → 规划文件名 →
       *   拼 PNG → 写盘）。它已经被真机验证过，不要在这里重写一份。
       */
      onDownload: async (seq) => {
        const action = host.state.importVersion;
        if (action === null) throw new Error('下载入口没有就绪，切一下页面再试');
        await action(cardId, seq);
      },
      /* 设为最新 = 服务端的 rollback（以旧版新建一个提交） */
      onSetLatest: async (seq) => {
        await runRepoRequest(host, (config) =>
          repoRollbackCard(config, cardId, seq, { fetchImpl: pickFetch() }),
        );
        /* 回滚会产生新版本 ⇒ 重新拉一遍，否则列表还是旧的 */
        host.state.versionsState = null;
        host.renderPage();
        void loadRepoVersions(host, cardId);
      },
      onDeleteCard: async () => {
        await runRepoRequest(host, (config) =>
          repoDeleteCard(config, cardId, { fetchImpl: pickFetch() }),
        );
        /*
         * 删完要让二级重新拉 —— 否则返回后那张卡还在列表里，
         * 点进去必然 404。
         */
        host.state.cardsState = null;
        host.state.reposCache = [];
      },
      onBack: () => host.goBackOneLevel(),
      onNotify: (message, kind) => host.options.onNotify?.(message, kind),
    },
  );

  host.pageHost.append(page);
}

export async function fetchRepoCards(host: RepoHost): Promise<RepoCardRow[]> {
  const repoId = host.state.repoId;

  const items = await runRepoRequest(host, (config) =>
    repoListCards(config, { fetchImpl: pickFetch(), limit: 200 }),
  );

  /*
   * ★ 按 repoId 过滤在**客户端**做，因为 `/api/cards` 不支持按仓库过滤
   *   （它返回全部，每条带 `repoId`）。服务端加了过滤参数时这里可以简化，
   *   但现在不能假装它有。
   */
  return items
    .filter((one: CardSummary) => repoId === null || one.repoId === repoId)
    .map((one: CardSummary) => ({
      id: one.cardId,
      title: one.name === '' ? one.cardId : one.name,
      seq: one.latestSeq,
      versionCount: one.versionCount,
      updatedAt: one.updatedAt,
      hasFace: one.face !== null,
      /* 卡面内容指纹：缩略图缓存靠它判断"图换了没有"（2026-11-11） */
      faceSha256: one.face?.sha256 ?? null,
    }));
}

export async function fetchRepoVersions(host: RepoHost, cardId: string): Promise<RepoVersionRow[]> {
  const items = await runRepoRequest(host, (config) =>
    repoListVersions(config, cardId, { fetchImpl: pickFetch() }),
  );
  return items.map((one) => ({
    seq: one.seq,
    commit: one.commit,
    createdAt: one.createdAt,
    sha256: one.sha256,
    message: one.message ?? '',
  }));
}

export async function loadCardFace(host: RepoHost, cardId: string): Promise<string | null> {
  let fetched: Awaited<ReturnType<typeof repoFetchFace>>;
  try {
    fetched = await runRepoRequest(host, (config) =>
      repoFetchFace(config, cardId, { fetchImpl: pickFetch() }),
    );
  } catch {
    /* 缩略图是装饰：任何失败都退回兜底头像，不弹通知 */
    return null;
  }
  if (fetched === null) return null;

  /* 字节 → base64：分块转，避免 `String.fromCharCode(...bytes)` 爆栈 */
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < fetched.bytes.length; i += chunk) {
    binary += String.fromCharCode(...fetched.bytes.subarray(i, i + chunk));
  }
  const base64 = globalThis.btoa(binary);
  /*
   * ★ `mime` 用服务端给的 Content-Type，不要写死 `image/png` ——
   *   卡面可能是 webp，写错标签部分 WebView 会拒绝渲染。
   */
  const mime = fetched.mime === '' ? 'image/png' : fetched.mime;
  return `data:${mime};base64,${base64}`;
}

export async function loadRepoCards(host: RepoHost, repoId: string): Promise<void> {
  try {
    const rows = await fetchRepoCards(host);
    /* 用户可能已经退回去了：别把结果写进别的页面 */
    if (host.state.repoId !== repoId) return;
    host.state.cardsState = rows;
    host.state.cardsError = '';
  } catch (error) {
    if (host.state.repoId !== repoId) return;
    host.state.cardsState = [];
    host.state.cardsError = describeBridgeError(error).message;
  }
  host.renderPage();
}

export async function loadRepoListQuietly(host: RepoHost): Promise<void> {
  if (repoSyncConfig(host) === null) return;
  try {
    const items = await runRepoRequest(host, (config) =>
      repoListRepos(
        { serverUrl: config.serverUrl, accessToken: config.token },
        { fetchImpl: pickFetch() },
      ),
    );
    if (host.state.repoId !== null) return;
    host.state.reposCache = items.map((one) => ({
      id: one.id,
      name: one.name,
      description: one.description,
      cardCount: one.cardCount,
      isDefault: one.isDefault,
    }));
    host.renderPage();
  } catch {
    /* 静默：保留当前列表 */
  }
}

export async function loadRepoVersions(host: RepoHost, cardId: string): Promise<void> {
  try {
    const rows = await fetchRepoVersions(host, cardId);
    if (host.state.cardId !== cardId) return;
    host.state.versionsState = rows;
    host.state.versionsError = '';
  } catch (error) {
    if (host.state.cardId !== cardId) return;
    host.state.versionsState = [];
    host.state.versionsError = describeBridgeError(error).message;
  }
  host.renderPage();
}

export async function fetchRepoFaceForImport(host: RepoHost, 
  cardId: string,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  try {
    const fetched = await runRepoRequest(host, (config) =>
      repoFetchFace(config, cardId, { fetchImpl: pickFetch() }),
    );
    if (fetched === null) return null;
    return { bytes: fetched.bytes, mime: fetched.mime };
  } catch {
    return null;
  }
}

export async function importRepoVersion(host: RepoHost, cardId: string, seq: number): Promise<void> {
  const jsonText = await runRepoRequest(host, (config) =>
    repoFetchVersionText(config, cardId, seq, { fetchImpl: pickFetch() }),
  );

  /* 仓库是权威版本，覆盖本地同名卡是预期行为，不弹确认 */
  const plan = await host.resolveCardPlacement({ jsonText, cardId, confirmOverwrite: false });
  if (plan === null) return;

  /*
   * ★★★ 用**仓库里的卡面**当底图（2026-11-11，用户报的）
   *
   * > 仓库有背景的时候下载没有把仓库的背景下载下来并合并成一张 PNG
   *
   * ## 原来为什么是一张首字封面
   *
   * v0.1.8 时传的是 `base: null`，理由是"仓库卡面是 webp，而
   * `buildPngCard` 只认 PNG —— 转码要 canvas，这条路径只想让内容进来"。
   *
   * 那个理由在当时成立，但**同一个仓库里已经有 `convertToPng` 了**
   * （桌面端导出用的就是它），只是没接到这条路上。于是：
   *
   * ```text
   *   仓库里明明有精心画的卡面
   *   下载下来却是一张"西"字封面
   *   ⇒ 选角色列表里认不出哪张是哪张（正是 v0.1.8 当初想解决的）
   * ```
   *
   * 转念一想，`base: null` 解决的正是它自己想避免的问题：所有卡长得一样。
   *
   * ## 三种情况
   *
   * ```text
   *   ① 仓库有卡面且已是 PNG   → 直接当底图
   *   ② 仓库有卡面但是 webp    → convertToPng 转一张再当底图
   *   ③ 仓库没有卡面           → 首字封面 + 提示用户去配背景
   * ```
   *
   * ③ 按用户要求："如果无背景提示用户选背景或者生成背景"。
   */
  const face = await fetchRepoFaceForImport(host, cardId);
  let base: Uint8Array | null = null;
  /* 背景没合并进去的**真实原因**，下载完要说给用户听 */
  let faceProblem: string | null = null;
  if (face !== null) {
    if (isPngBytes(face.bytes)) {
      base = face.bytes;
    } else {
      try {
        /*
         * 长边限 1024：卡面只用于列表/顶栏，几百 px 就够。
         * 4096 的 canvas 在手机 WebView 上是 64MB —— 那正是它失败的地方。
         */
        base = (
          await convertToPng(
            face.bytes,
            `face.${face.mime.includes('webp') ? 'webp' : 'jpg'}`,
            1024,
          )
        ).bytes;
      } catch (error) {
        /*
         * ★★★ 转码失败**不许静默**（2026-11-11）。
         *
         * 原来这里是 `catch { base = null }` —— 静默退回首字封面。
         * 真机后果：仓库卡面下载花了 13 秒（说明图确实拉下来了），
         * 最终却仍是一个字，而**用户看不到任何解释**，只能报"问题未解决"。
         *
         * 吞掉失败比失败本身更坏：失败还能查，静默只能猜。
         */
        faceProblem =
          error instanceof Error ? error.message : String(error);
        console.warn('[repo-import] 卡面转 PNG 失败', faceProblem);
        base = null;
      }
    }
  }

  const written = await host.writeCardToLibrary({ plan, jsonText, base });
  /*
   * 没有背景图 ⇒ 说清楚"这张卡现在只有首字封面，可以去配一张"。
   *
   * 为什么值得单独提示：用户以为下载下来的卡就是仓库里看到的那张，
   * 结果头像是个字 —— 会当成"下载坏了"。而实际上仓库里那张卡本来
   * 就没有配图，需要有人补一张。
   */
  if (face === null) {
    host.options.onNotify?.(
      '这张卡在仓库里没有背景图，已用首字封面代替。想要头像的话，可以在同步页给它上传一张背景。',
      'warn',
    );
  } else if (faceProblem !== null) {
    /*
     * 有背景但没转成 PNG —— 与"没有背景"是两件事，提示必须分开：
     *
     * ```text
     *   没有背景      → 用户去配一张就好
     *   有背景但转不了 → 是我们的问题，得说清是哪一步失败的
     * ```
     */
    host.options.onNotify?.(
      `这张卡有背景，但没能合并进卡里（${faceProblem}），暂时用首字封面。`,
      'warn',
    );
  }

  /* 书没落地要说一声（角色可用了，所以是 warn 不是 danger） */
  if (written.worldbook === 'failed') {
    host.options.onNotify?.(
      `卡已导入，但内嵌世界书没进来：${written.worldbookFailure ?? '未知原因'}`,
      'warn',
    );
  }
}