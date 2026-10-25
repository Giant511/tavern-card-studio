/**
 * 仓库令牌连接的 HTTP 客户端（v0.1.3 / F5 后半）。
 *
 * 与 `auth-client.ts` 同一条原则：**不本地化失败原因**。
 * 服务端已经算好了「格式错误 / 已吊销 / 已过期 / 无效」，客户端原样转发它的
 * message；只有在服务端没给 message 时才用中性描述。
 *
 * 为什么这条在这里尤其重要：需求明确要求「令牌不存在」与「无效」不可区分。
 * 如果客户端"贴心"地把 401 翻成「这把令牌不存在」，那只在客户端就重建了
 * 服务端刻意抹掉的那个枚举面 —— 与登录那条完全同构的错。
 *
 * 无 DOM 依赖、可注入 `fetch`，便于在 Node 里跑全部分支。
 */

import { checkRepoTokenShape, type RepoTokenShapeCheck } from './repo-token.ts';

/** 连接成功后拿到的"这把令牌能干什么" */
export interface RepoTokenGrant {
  repoId: string;
  repoName: string;
  scopes: string[];
  username: string;
  /** ISO；null = 永不过期 */
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export type RepoTokenFailureReason =
  /** 本地形态校验没过（不发请求） */
  | 'shape'
  /** 服务端：格式错误 */
  | 'format'
  /** 服务端：已吊销 */
  | 'revoked'
  /** 服务端：已过期 */
  | 'expired'
  /** 服务端：无效（含不存在 —— 刻意合并） */
  | 'invalid'
  | 'network'
  | 'timeout'
  | 'server';

export class RepoTokenError extends Error {
  readonly reason: RepoTokenFailureReason;
  readonly status: number | null;
  /** 唯一允许出现在界面上的文案 */
  readonly displayMessage: string;
  /** 可选的下一步提示（服务端给的 hint，或本地针对形态错误给的） */
  readonly hint: string;

  constructor(
    reason: RepoTokenFailureReason,
    displayMessage: string,
    status: number | null = null,
    hint = '',
  ) {
    super(displayMessage);
    this.name = 'RepoTokenError';
    this.reason = reason;
    this.status = status;
    this.displayMessage = displayMessage;
    this.hint = hint;
  }
}

const DEFAULT_TIMEOUT_MS = 15000;

export interface RepoTokenRequestOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function errorFields(body: Record<string, unknown> | null): { code: string; message: string; hint: string } {
  const err = body && typeof body['error'] === 'object' && body['error'] !== null
    ? (body['error'] as Record<string, unknown>)
    : null;
  // hint 可能在 error 里，也可能在 error.details 里（AppError 的 details 是原样下发的）
  const details = err?.['details'];
  const detailHint = typeof details === 'object' && details !== null
    ? (details as Record<string, unknown>)['hint']
    : undefined;
  return {
    code: typeof err?.['code'] === 'string' ? err['code'] : '',
    message: typeof err?.['message'] === 'string' ? err['message'] : '',
    hint:
      typeof err?.['hint'] === 'string'
        ? err['hint']
        : typeof detailHint === 'string'
          ? detailHint
          : '',
  };
}

/** 把服务端错误码翻成界面原因（只影响本地分类，不影响显示文案） */
function reasonForCode(code: string, status: number): RepoTokenFailureReason {
  if (code === 'TOKEN_FORMAT_INVALID') return 'format';
  if (code === 'TOKEN_REVOKED') return 'revoked';
  if (code === 'TOKEN_EXPIRED') return 'expired';
  // TOKEN_INVALID 与"没有这个码"一律归 invalid —— 不能因为码缺失就换个说法，
  // 那等于从"响应形状"里把存在性漏出去
  if (code === 'TOKEN_INVALID' || status === 401) return 'invalid';
  return 'server';
}

/**
 * 用一把仓库令牌连接。
 *
 * 本地形态先过一遍（`checkRepoTokenShape`），不过就不发请求 —— 这样
 * 「把前缀当完整令牌」这类错误不用等一次往返才提示。
 */
export async function connectWithRepoToken(
  serverUrl: string,
  rawToken: string,
  options: RepoTokenRequestOptions = {},
): Promise<RepoTokenGrant> {
  const shape: RepoTokenShapeCheck = checkRepoTokenShape(rawToken);
  if (!shape.ok) {
    throw new RepoTokenError('shape', shape.message, null, '令牌原文在「仓库与令牌」对话框里签发时只显示一次；若已丢失请重新签发');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(`${serverUrl.replace(/\/+$/, '')}/api/auth/repo-token`, {
      method: 'POST',
      signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: shape.value }),
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new RepoTokenError(
      aborted ? 'timeout' : 'network',
      aborted ? `请求超时（${timeoutMs} ms）` : '无法连接服务端',
      null,
      '确认服务端已启动、地址与端口正确（设置 → 服务端地址）',
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
    const { code, message, hint } = errorFields(body);
    const reason = reasonForCode(code, response.status);
    // 文案优先用服务端原话；没有才中性描述（中性描述不含任何原因猜测）
    const display = message.trim() !== '' ? message : `无法完成连接（HTTP ${response.status}）`;
    throw new RepoTokenError(reason, display, response.status, hint);
  }

  const repo = typeof body?.['repo'] === 'object' && body['repo'] !== null
    ? (body['repo'] as Record<string, unknown>)
    : {};
  const scopes = Array.isArray(body?.['scopes'])
    ? body['scopes'].filter((item): item is string => typeof item === 'string')
    : [];

  const repoId = typeof repo['id'] === 'string' ? repo['id'] : '';
  if (repoId === '') {
    // 形状不对不能当成功：后面所有请求都要按 repoId 寻址，空 id 会让
    // 上传"成功但卡不见了"（repo-select.ts 文件头写过同一类故障）
    throw new RepoTokenError('server', '服务端返回的连接信息不完整（缺少仓库 id）', response.status);
  }

  return {
    repoId,
    repoName: typeof repo['name'] === 'string' ? repo['name'] : '',
    scopes,
    username: typeof body?.['username'] === 'string' ? body['username'] : '',
    expiresAt: typeof body?.['expiresAt'] === 'string' ? body['expiresAt'] : null,
    lastUsedAt: typeof body?.['lastUsedAt'] === 'string' ? body['lastUsedAt'] : null,
  };
}
