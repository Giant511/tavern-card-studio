/**
 * 仓库与仓库令牌的 HTTP 客户端（T10.8）。
 *
 * 与 `sync/server-sync.ts` 同一套约定：可注入 fetch、错误统一成带 code 的错误、
 * 不本地化服务端文案。
 *
 * 权限口径（必须记住）：仓库管理只能用**账户登录**的身份（jwt），
 * 仓库令牌能读写卡片但不能管理仓库/令牌本身（防自我续期）。
 * 所以这里的调用失败不一定是 bug，可能只是当前用的是仓库令牌。
 */

import {
  createFetchTransport,
  defaultTransport,
  type HttpTransport,
} from '../net/http-transport.ts';

export interface RepoSummary {
  id: string;
  name: string;
  description: string;
  /** 服务端标记的默认仓库：上传时应当预选它 */
  isDefault: boolean;
  cardCount: number;
  createdAt: string;
}

export interface RepoTokenSummary {
  id: string;
  name: string;
  repoId: string;
  repoName: string;
  scopes: string[];
  tokenPrefix: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface IssuedRepoToken {
  /** **原文只在这一刻存在**：响应里带 note 提醒，之后只能看前缀 */
  token: string;
  tokenPrefix: string;
  name: string;
  repoId: string;
  repoName: string;
  scopes: string[];
  expiresAt: string | null;
  note: string;
}

export type RepoErrorCode = 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT' | 'NETWORK' | 'TIMEOUT' | 'SERVER';

export class RepoClientError extends Error {
  readonly code: RepoErrorCode;
  readonly status: number | null;
  /** 服务端原话（或中性描述），界面直接显示它 */
  readonly displayMessage: string;

  constructor(code: RepoErrorCode, displayMessage: string, status: number | null = null) {
    super(displayMessage);
    this.name = 'RepoClientError';
    this.code = code;
    this.status = status;
    this.displayMessage = displayMessage;
  }
}

export interface RepoClientConfig {
  serverUrl: string;
  /** 账户 access 令牌（仓库管理只认这个） */
  accessToken: string;
}

export interface RepoRequestOptions {
  timeoutMs?: number;
  /** 老测试注入点：给了它就按 fetch 语义发请求（不走原生通道） */
  fetchImpl?: typeof fetch;
  /** 显式指定传输层（优先级最高） */
  transport?: HttpTransport;
}

const DEFAULT_TIMEOUT_MS = 15000;

async function request(
  config: RepoClientConfig,
  path: string,
  init: RequestInit,
  options: RepoRequestOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  /*
   * ★ 走**传输层**，不是裸 fetch（2026-11-24）。
   *
   * 原来是 `options.fetchImpl ?? fetch`。在桌面壳里 `fetch` 是 WebView 的，
   * 它**无法配置证书校验**，于是自签证书服务端上出现：
   *
   * ```text
   *   卡片同步正常（走的是 server_http_request 原生命令）
   *   仓库面板报"无法连接服务端"（走的是这里的 fetch）
   * ```
   *
   * 同一个服务端、同一套配置、两种结论 —— 用户没法理解，也没法自查。
   * `server-sync.ts` 早在 2026-11-17 就改成走传输层了，这里漏了。
   *
   * 顺序与它保持一致：显式 transport > fetchImpl（老测试注入）> 按环境自动选。
   */
  const transport =
    options.transport ??
    (options.fetchImpl === undefined ? defaultTransport() : createFetchTransport(options.fetchImpl));

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(config.accessToken.trim() === '' ? {} : { Authorization: `Bearer ${config.accessToken.trim()}` }),
  };
  const extra = init.headers;
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra as Record<string, string>)) headers[key] = value;
  }

  const outcome = await transport({
    url: `${config.serverUrl.replace(/\/+$/, '')}${path}`,
    method: typeof init.method === 'string' ? init.method : 'GET',
    headers,
    ...(typeof init.body === 'string' ? { body: init.body } : {}),
    timeoutMs,
  });

  if (outcome.status === null) {
    /*
     * `{ cause }` 不可省（2026-11-04 的教训）：把底层原因带上，
     * 否则上层认不出"这是证书问题"，那个"确认风险后继续"的出口永远不弹。
     */
    const code = outcome.errorKind === 'timeout' ? 'TIMEOUT' : 'NETWORK';
    const wrapped = new RepoClientError(code, outcome.error ?? '无法连接服务端');
    (wrapped as Error & { cause?: unknown }).cause = {
      kind: outcome.errorKind,
      message: outcome.error,
    };
    (wrapped as Error & { certUntrusted?: boolean }).certUntrusted = outcome.errorKind === 'cert';
    throw wrapped;
  }

  // 造一个真的 Response 交回去：下面十几处 `response.json()` / `.ok` / `.status`
  // 都不用动，行为与原来完全一致（与 server-sync.ts 同一手法）。
  const response = new Response(outcome.text ?? '', {
    status: outcome.status,
    headers: outcome.contentType === '' ? {} : { 'Content-Type': outcome.contentType },
  });

  let body: Record<string, unknown> | null = null;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }

  if (!response.ok) {
    const err = body && typeof body['error'] === 'object' && body['error'] !== null
      ? (body['error'] as Record<string, unknown>)
      : null;
    const message = typeof err?.['message'] === 'string' ? err['message'] : `无法完成请求（HTTP ${response.status}）`;
    const code: RepoErrorCode =
      response.status === 401
        ? 'UNAUTHORIZED'
        : response.status === 403
          ? 'FORBIDDEN'
          : response.status === 404
            ? 'NOT_FOUND'
            : response.status === 409
              ? 'CONFLICT'
              : response.status >= 400 && response.status < 500
                ? 'BAD_REQUEST'
                : 'SERVER';
    throw new RepoClientError(code, message, response.status);
  }

  return body ?? {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function toRepo(input: unknown): RepoSummary {
  const obj = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  return {
    id: str(obj['id']),
    name: str(obj['name']),
    description: str(obj['description']),
    isDefault: obj['isDefault'] === true,
    cardCount: typeof obj['cardCount'] === 'number' ? obj['cardCount'] : 0,
    createdAt: str(obj['createdAt']),
  };
}

function toToken(input: unknown): RepoTokenSummary {
  const obj = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const scopes = Array.isArray(obj['scopes']) ? obj['scopes'].map((item) => String(item)) : [];
  return {
    id: str(obj['id']),
    name: str(obj['name']),
    repoId: str(obj['repoId']),
    repoName: str(obj['repoName']),
    scopes,
    /*
     * 服务端列表接口的字段名是 `prefix`（签发响应里才叫 `tokenPrefix`）。
     * 读错名字不会报错，只会安静地显示成空 —— 列表上就只剩一个「…」，
     * 用户无法区分两把令牌。这里两个名字都认，且断言不能只看后缀。
     */
    tokenPrefix: str(obj['prefix']) || str(obj['tokenPrefix']),
    createdAt: str(obj['createdAt']),
    expiresAt: typeof obj['expiresAt'] === 'string' ? obj['expiresAt'] : null,
    revokedAt: typeof obj['revokedAt'] === 'string' ? obj['revokedAt'] : null,
    lastUsedAt: typeof obj['lastUsedAt'] === 'string' ? obj['lastUsedAt'] : null,
  };
}

export async function listRepos(
  config: RepoClientConfig,
  options: RepoRequestOptions = {},
): Promise<RepoSummary[]> {
  const body = (await request(config, '/api/repos', { method: 'GET' }, options)) as Record<string, unknown>;
  const items = Array.isArray(body['items']) ? body['items'] : [];
  return items.map(toRepo);
}

/**
 * 当前账户的 uid / username（2026-11-25）。
 *
 * 为什么走这里而不是 `auth-client`：这条要**带 accessToken 发到
 * `/api/auth/me`**，而这个模块已经有"带令牌请求 + 超时 + 原生传输层"
 * 的全套封装（自签证书服务端也能连）。auth-client 那套是登录前的
 * 免鉴权请求，两边的传输选型不同。
 */
export async function fetchAccountIdentity(
  config: RepoClientConfig,
  options: RepoRequestOptions = {},
): Promise<{ uid: string; username: string }> {
  const body = (await request(config, '/api/auth/me', { method: 'GET' }, options)) as Record<string, unknown>;
  const user = body['user'];
  const row = typeof user === 'object' && user !== null ? (user as Record<string, unknown>) : {};
  return {
    uid: typeof row['uid'] === 'string' ? row['uid'] : '',
    username: typeof row['username'] === 'string' ? row['username'] : '',
  };
}

/**
 * 改用户名（2026-11-25）。需要当前密码，uid 不变。
 */
export async function changeAccountUsername(
  config: RepoClientConfig,
  input: { currentPassword: string; newUsername: string },
  options: RepoRequestOptions = {},
): Promise<{ username: string; uid: string }> {
  const body = (await request(
    config,
    '/api/account/username',
    { method: 'POST', body: JSON.stringify(input) },
    options,
  )) as Record<string, unknown>;
  return {
    username: typeof body['username'] === 'string' ? body['username'] : '',
    uid: typeof body['uid'] === 'string' ? body['uid'] : '',
  };
}

/**
 * 改密码（2026-11-25）。成功后该账户**所有设备**（含本机）都要重新登录。
 *
 * `revoked` 是服务端实际吊销的会话数 —— 界面据此说"已让 N 台设备退出"。
 */
export async function changeAccountPassword(
  config: RepoClientConfig,
  input: { currentPassword: string; newPassword: string },
  options: RepoRequestOptions = {},
): Promise<{ revoked: number }> {
  const body = (await request(
    config,
    '/api/account/password',
    { method: 'POST', body: JSON.stringify(input) },
    options,
  )) as Record<string, unknown>;
  return { revoked: typeof body['revoked'] === 'number' ? body['revoked'] : 0 };
}

/**
 * 一条登录会话（2026-11-26，桌面端的「登录设备」）。
 *
 * 字段和 `server/src/http/account-routes.ts` 的 DTO 对得上。`current` 由服务端判定
 * （`row.id === caller.sessionId`），客户端不重算：自己算就得再存一份 sessionId，
 * 两边判定不一致时界面会互相打脸。
 */
export interface AccountSession {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string;
  userAgent: string;
  current: boolean;
}

function toAccountSession(value: unknown): AccountSession | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  const id = typeof row['id'] === 'string' ? row['id'] : '';
  if (id === '') return null;
  const text = (key: string): string => (typeof row[key] === 'string' ? row[key] : '');
  return {
    id,
    createdAt: text('createdAt'),
    lastSeenAt: text('lastSeenAt'),
    expiresAt: text('expiresAt'),
    ip: text('ip'),
    userAgent: text('userAgent'),
    current: row['current'] === true,
  };
}

/**
 * 当前账户仍然有效的登录会话（2026-11-26）。
 *
 * 只返回未吊销、未过期的。已吊销的留给审计事件，不在这里出现。
 */
export async function fetchAccountSessions(
  config: RepoClientConfig,
  options: RepoRequestOptions = {},
): Promise<AccountSession[]> {
  const body = (await request(config, '/api/account/sessions', { method: 'GET' }, options)) as Record<
    string,
    unknown
  >;
  const items = Array.isArray(body['items']) ? body['items'] : [];
  const sessions: AccountSession[] = [];
  for (const item of items) {
    const session = toAccountSession(item);
    if (session !== null) sessions.push(session);
  }
  return sessions;
}

/**
 * 登出一台指定设备（2026-11-26）。只能踢自己的会话。
 *
 * 返回 `self === true` 表示踢的是当前这台，调用方应当回登录页，而不是刷新列表。
 * 服务端对「不存在」和「不是你的」都回 404，这里也不区分：区分了就能拿它枚举别人的会话。
 */
export async function revokeAccountSession(
  config: RepoClientConfig,
  sessionId: string,
  options: RepoRequestOptions = {},
): Promise<{ id: string; revoked: boolean; self: boolean }> {
  const body = (await request(
    config,
    `/api/account/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
    options,
  )) as Record<string, unknown>;
  return {
    id: typeof body['id'] === 'string' ? body['id'] : sessionId,
    revoked: body['revoked'] === true,
    self: body['self'] === true,
  };
}

/**
 * 退出其它设备，当前会话保留（2026-11-26）。
 *
 * 顺手把自己也踢掉的话，用户会以为操作失败，所以服务端明确排除当前会话。
 */
export async function revokeOtherSessions(
  config: RepoClientConfig,
  options: RepoRequestOptions = {},
): Promise<{ revoked: number }> {
  const body = (await request(
    config,
    '/api/account/sessions/revoke-all',
    { method: 'POST' },
    options,
  )) as Record<string, unknown>;
  return { revoked: typeof body['revoked'] === 'number' ? body['revoked'] : 0 };
}

export async function createRepo(
  config: RepoClientConfig,
  input: { name: string; description?: string },
  options: RepoRequestOptions = {},
): Promise<RepoSummary> {
  const body = (await request(
    config,
    '/api/repos',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: input.name, description: input.description ?? '' }),
    },
    options,
  )) as Record<string, unknown>;
  return toRepo(body['repo'] ?? body);
}

/** 改名 / 改描述（F13.5 仓库管理） */
export async function renameRepo(
  config: RepoClientConfig,
  repoId: string,
  input: { name?: string; description?: string },
  options: RepoRequestOptions = {},
): Promise<RepoSummary> {
  const body = (await request(
    config,
    `/api/repos/${encodeURIComponent(repoId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
      }),
    },
    options,
  )) as Record<string, unknown>;
  return toRepo(body['repo'] ?? body);
}

/** 设为默认仓库（默认仓库不能删，只能先转移默认） */
export async function setDefaultRepo(
  config: RepoClientConfig,
  repoId: string,
  options: RepoRequestOptions = {},
): Promise<RepoSummary> {
  const body = (await request(
    config,
    `/api/repos/${encodeURIComponent(repoId)}/default`,
    { method: 'POST' },
    options,
  )) as Record<string, unknown>;
  return toRepo(body['repo'] ?? body);
}

/**
 * 删除仓库（F13.4）。
 *
 * 非空仓库必须给 `transferTo` —— 这里不替调用方猜目标。
 * 响应里的 `movedCards` 要回给用户看：它回答"刚才到底动了多少东西"。
 */
export async function deleteRepo(
  config: RepoClientConfig,
  repoId: string,
  input: { transferTo?: string; reason?: string } = {},
  options: RepoRequestOptions = {},
): Promise<{ movedCards: number; revokedTokens: number }> {
  const body = (await request(
    config,
    `/api/repos/${encodeURIComponent(repoId)}`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(input.transferTo === undefined ? {} : { transferTo: input.transferTo }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      }),
    },
    options,
  )) as Record<string, unknown>;
  return {
    movedCards: typeof body['movedCards'] === 'number' ? body['movedCards'] : 0,
    revokedTokens: typeof body['revokedTokens'] === 'number' ? body['revokedTokens'] : 0,
  };
}

export async function listRepoTokens(
  config: RepoClientConfig,
  repoId: string,
  options: RepoRequestOptions = {},
): Promise<{ items: RepoTokenSummary[]; note: string }> {
  const body = (await request(
    config,
    `/api/repos/${encodeURIComponent(repoId)}/tokens`,
    { method: 'GET' },
    options,
  )) as Record<string, unknown>;
  const items = Array.isArray(body['items']) ? body['items'] : [];
  return { items: items.map(toToken), note: str(body['note']) };
}

/**
 * 签发仓库令牌。
 *
 * 返回的 `token` 是**唯一一次**能看到原文的机会 —— 界面必须当场把它显示出来
 * 并提供复制按钮，不能做成"以后再查"。
 */
export async function issueRepoToken(
  config: RepoClientConfig,
  repoId: string,
  input: { name: string; scopes: string[]; expiresAt?: string | null },
  options: RepoRequestOptions = {},
): Promise<IssuedRepoToken> {
  const payload: Record<string, unknown> = { name: input.name, scopes: input.scopes };
  if (input.expiresAt) payload['expiresAt'] = input.expiresAt;
  const body = (await request(
    config,
    `/api/repos/${encodeURIComponent(repoId)}/tokens`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    options,
  )) as Record<string, unknown>;

  return {
    token: str(body['token']),
    tokenPrefix: str(body['tokenPrefix']),
    name: str(body['name']),
    repoId: str(body['repoId']),
    repoName: str(body['repoName']),
    scopes: Array.isArray(body['scopes']) ? body['scopes'].map((item) => String(item)) : [],
    expiresAt: typeof body['expiresAt'] === 'string' ? body['expiresAt'] : null,
    note: str(body['note']),
  };
}

export async function revokeRepoToken(
  config: RepoClientConfig,
  tokenId: string,
  options: RepoRequestOptions = {},
): Promise<void> {
  await request(config, `/api/tokens/${encodeURIComponent(tokenId)}`, { method: 'DELETE' }, options);
}
