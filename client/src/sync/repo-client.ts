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
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 15000;

async function request(
  config: RepoClientConfig,
  path: string,
  init: RequestInit,
  options: RepoRequestOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(`${config.serverUrl.replace(/\/+$/, '')}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(config.accessToken.trim() === '' ? {} : { Authorization: `Bearer ${config.accessToken.trim()}` }),
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new RepoClientError(
      aborted ? 'TIMEOUT' : 'NETWORK',
      aborted ? `请求超时（${timeoutMs} ms）` : '无法连接服务端',
    );
  } finally {
    clearTimeout(timer);
  }

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
