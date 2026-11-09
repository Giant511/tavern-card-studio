/**
 * 移动端仓库状态：配置 + 登录态持久化（2026-11-04，T15.2 阶段 A）。
 *
 * ## 用户要求
 *
 * > 杀 App 重进后仓库配置与登录态保持。
 *
 * ## 为什么要单独一层，不复用桌面端的配置存储
 *
 * 桌面端的 `PersistedAuth` 落在 Tauri 的应用配置里（`config-scopes` 那套，
 * 走原生命令）。手机端没有那个文件布局，但**状态形状可以完全一样** ——
 * 所以这里只做"把 `PersistedAuth` 和 `RepoConfigState` 存进 localStorage"，
 * 不重写任何协议、不改 `AuthSession` 的接口。
 *
 * ## 存储键为什么分两个
 *
 * ```text
 *   tcs.mobile.repoConfig  —— 服务端地址策略（可能包含 http 确认记录）
 *   tcs.mobile.repoAuth    —— 令牌与用户信息
 * ```
 *
 * 分开而不是合一：切换服务端地址时必须能**独立**清掉登录态（在 A 机登录的
 * 令牌发到 B 机会 401），但不能连带清掉"用户选的是自定义 / 内置"这个选择。
 */

import { parseRepoConfig, emptyRepoConfig, type RepoConfigState } from '@tcs/shared';

/** 与桌面端 `PersistedAuth` 同形状（只取手机端用得到的键） */
export interface MobileRepoAuth {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  userId: string;
  username: string;
}

export const EMPTY_REPO_AUTH: MobileRepoAuth = {
  accessToken: '',
  refreshToken: '',
  accessExpiresAt: 0,
  userId: '',
  username: '',
};

const LS_CONFIG = 'tcs.mobile.repoConfig';
const LS_AUTH = 'tcs.mobile.repoAuth';
/**
 * 按 origin 分槽的登录态（2026-11-05）。
 *
 * ## 为什么不再只用一份
 *
 * 用户报：
 *
 * > 只要从内置云仓库切到自定义仓库，或者是自定义切到内置云仓库，
 * > 登录状态都会消失，但是杀掉进程和切换到其他页面不会消失
 *
 * 原实现只有一份 `LS_AUTH`，`saveRepoConfig` 里"origin 变了就
 * `clearRepoAuth()`"。清是对的（不同服务器的 token 绝不能混用），
 * 但**清掉之后没地方恢复** —— 切回原来的服务器还得重新登录。
 *
 * 现在按 origin 各存一份：
 *
 * ```text
 *   切到 B  → 读 B 那份（多半是空）→ 显示未登录   ✅ 正确
 *   切回 A  → 读 A 那份            → 恢复登录      ✅ 用户要的
 * ```
 *
 * 安全性没有变化：token 仍然只在本机，且**永远不会跨 origin 使用** ——
 * 按 origin 做 key 恰恰是把这条约束写进存储结构。
 */
const LS_AUTH_BY_ORIGIN = 'tcs.mobile.repoAuthByOrigin';

/** 取 localStorage；不可用时返回 null（而不是抛错） */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    /* 隐私模式 / 被策略禁用时会抛 */
    return null;
  }
}

/** 读仓库配置（坏值回落到内置云仓库） */
export function readRepoConfig(): RepoConfigState {
  const store = storage();
  if (store === null) return emptyRepoConfig();
  try {
    const raw = store.getItem(LS_CONFIG);
    if (raw === null) return emptyRepoConfig();
    return parseRepoConfig(JSON.parse(raw));
  } catch {
    return emptyRepoConfig();
  }
}

/** 写仓库配置。失败抛错 —— 静默失败会让用户以为存了 */
export async function writeRepoConfig(state: RepoConfigState): Promise<void> {
  const store = storage();
  if (store === null) throw new Error('这台设备上存不了仓库配置（没有可用的本地存储）。');
  store.setItem(LS_CONFIG, JSON.stringify(state));

  /* 回读校验：以读到的为准 */
  const back = store.getItem(LS_CONFIG);
  if (back === null) throw new Error('仓库配置写进去之后读不回来了。');
}

/**
 * 读登录态。
 *
 * ## 这里的校验只需要一条
 *
 * 令牌为空就等于没登录 —— 其余字段都只是显示用的。
 * 所以不做"逐字段严格校验"，只保证类型对，避免界面拿到 `undefined`
 * 拼出 `已登录：undefined`。
 */
export function readRepoAuth(): MobileRepoAuth {
  const store = storage();
  if (store === null) return { ...EMPTY_REPO_AUTH };
  try {
    const raw = store.getItem(LS_AUTH);
    if (raw === null) return { ...EMPTY_REPO_AUTH };
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return { ...EMPTY_REPO_AUTH };
    const obj = parsed as Record<string, unknown>;

    const str = (key: string): string => (typeof obj[key] === 'string' ? (obj[key] as string) : '');
    const num = (key: string): number =>
      typeof obj[key] === 'number' && Number.isFinite(obj[key] as number)
        ? (obj[key] as number)
        : 0;

    return {
      accessToken: str('accessToken'),
      refreshToken: str('refreshToken'),
      accessExpiresAt: num('accessExpiresAt'),
      userId: str('userId'),
      username: str('username'),
    };
  } catch {
    return { ...EMPTY_REPO_AUTH };
  }
}

/** 读整张 origin → 登录态的表 */
function readAuthMap(store: Storage): Record<string, MobileRepoAuth> {
  const raw = store.getItem(LS_AUTH_BY_ORIGIN);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return {};
    const out: Record<string, MobileRepoAuth> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object') continue;
      out[key] = normalizeAuth(value as Record<string, unknown>);
    }
    return out;
  } catch {
    return {};
  }
}

/** 把任意对象收成 `MobileRepoAuth`（坏字段给默认值） */
function normalizeAuth(obj: Record<string, unknown>): MobileRepoAuth {
  const str = (key: string): string => (typeof obj[key] === 'string' ? (obj[key] as string) : '');
  const num = (key: string): number =>
    typeof obj[key] === 'number' && Number.isFinite(obj[key] as number) ? (obj[key] as number) : 0;
  return {
    accessToken: str('accessToken'),
    refreshToken: str('refreshToken'),
    accessExpiresAt: num('accessExpiresAt'),
    userId: str('userId'),
    username: str('username'),
  };
}

/**
 * 读某个 origin 的登录态。
 *
 * `origin` 为空串时返回空登录态（还没有服务端就没什么可登的）。
 *
 * ## 向后兼容
 *
 * 老版本只有一份 `LS_AUTH`。这里在"新表里没有这个 origin"时回落到它 ——
 * 老用户升级后**不用重新登录**（那次读到的登录态会被下次写回迁移进新表）。
 */
export function readRepoAuthFor(origin: string): MobileRepoAuth {
  if (origin === '') return { ...EMPTY_REPO_AUTH };
  const store = storage();
  if (store === null) return { ...EMPTY_REPO_AUTH };

  const map = readAuthMap(store);
  const hit = map[origin];
  if (hit !== undefined && hit.accessToken !== '') return hit;

  /* 老键兜底（只在它属于当前 origin 时才算 —— 单份时代没有 origin 概念，
     所以只在"这份 token 是这个 origin 登出来的"时可信。用配置里的
     `kind` 无法判定 origin，保守做法是只在 origin 就是当前配置时用） */
  /*
   * ★★★ 2026-11-05 收紧：**表里已经有别的 origin 时不许用老键**。
   *
   * 老键（`LS_AUTH`）是"还没有按 origin 分表"那个年代的遗留。上一版
   * 只要它存在就返回 —— 于是"表里存着 A 的凭据、切到 B"时，
   * B 会把 A 的老键值当自己的登录态，**绕过了互斥**。
   *
   * 现在只在整张表为空时兜底 —— 那才是真正的"从老版本升级上来、
   * 一次都没写过新表"的场景。
   */
  const legacyRaw = Object.keys(map).length === 0 ? store.getItem(LS_AUTH) : null;
  if (legacyRaw !== null) {
    try {
      const parsed: unknown = JSON.parse(legacyRaw);
      if (parsed !== null && typeof parsed === 'object') {
        const legacy = normalizeAuth(parsed as Record<string, unknown>);
        if (legacy.accessToken !== '') return legacy;
      }
    } catch {
      /* 坏值当没有 */
    }
  }

  return { ...EMPTY_REPO_AUTH };
}

/** 写某个 origin 的登录态（成功后回读校验） */
export async function writeRepoAuth(origin: string, state: MobileRepoAuth): Promise<void> {
  const store = storage();
  if (store === null) throw new Error('这台设备上存不了登录态（没有可用的本地存储）。');

  const map = readAuthMap(store);
  if (origin === '') {
    /*
     * 没有 origin（还没配服务端）时不该有登录态。写进老键只为兼容
     * 极早期的调用顺序（配置先存、origin 后算）。
     */
    store.setItem(LS_AUTH, JSON.stringify(state));
    if (store.getItem(LS_AUTH) === null) throw new Error('登录态写进去之后读不回来了。');
    return;
  }

  map[origin] = state;
  /*
   * ★★★ 互斥：**同一时间只允许一个服务端处于登录态**（2026-11-05）。
   *
   * 用户报：
   *
   * > 在登录任意一个仓库类型的服务端时，互相切换仓库类型会卡很久，
   * > 而且还有一个很危险的问题就是自定义和云仓库可以同时登录
   *
   * 真机录屏里就是这样：内置云仓库显示「已登录：Gez」，
   * 切到自定义仓库显示「已登录：testuser」，再切回去 Gez 还在 ——
   * 两套凭据并存，切过去还会拿错令牌（报「缺少或无效的访问令牌」）。
   *
   * 原来这里刻意"只写这一格、不动别的 origin"（`clearRepoAuth` 的注释里
   * 写明了那个意图），为的是"切回来还能恢复"。**那个设计是错的**：
   *
   * ```text
   *   安全性：两份 token 同时有效，等于两个账号同时在线
   *   正确性：界面上一次只显示一个服务端，却有两份凭据 —— 用户无法判断
   *           "我现在到底是谁"
   * ```
   *
   * 现在登录任何一处都**清掉其它 origin 的凭据**。代价是切回去要重登 ——
   * 那是安全的必要代价，用户也明确把"同时在线"列为危险。
   */
  for (const key of Object.keys(map)) {
    if (key !== origin) delete map[key];
  }
  store.setItem(LS_AUTH_BY_ORIGIN, JSON.stringify(map));
  if (store.getItem(LS_AUTH_BY_ORIGIN) === null) {
    throw new Error('登录态写进去之后读不回来了。');
  }
  /* 迁移完成：老键可以退休了（留着会让"切回去"读到两份不同的值） */
  store.removeItem(LS_AUTH);
}

/**
 * 清某个 origin 的登录态。
 *
 * ★ 2026-11-05 改：现在**全局只有一份登录态**（见 `writeRepoAuth` 的互斥段），
 * 所以 `origin` 参数只用来做"要不要清"的判断，不再有"别的 origin 要保留"。
 * 保留参数是为了不破坏调用签名。
 */
export async function clearRepoAuth(origin?: string): Promise<void> {
  const store = storage();
  if (store === null) return;

  if (origin === undefined || origin === '') {
    /* 不带 origin = 清全部（退出登录、令牌失效这类"我这个人都登出"的语义） */
    store.removeItem(LS_AUTH);
    store.removeItem(LS_AUTH_BY_ORIGIN);
    return;
  }

  const map = readAuthMap(store);
  delete map[origin];
  store.setItem(LS_AUTH_BY_ORIGIN, JSON.stringify(map));
  store.removeItem(LS_AUTH);
}
