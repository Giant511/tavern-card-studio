/**
 * 服务端同步（T6.7）——上传 / 版本历史 / 回滚。
 *
 * 复用 T6.8 的 `probeServer` / `isSyncReady` 判定可用性（不在这里另设判据）。
 * 全部走 `fetch`（服务端已开 CORS，见 docs/13），不新增原生命令。
 *
 * 关键设计：
 *   · 上传按**原始字节**发送（`Content-Type: application/json`，body 就是文件内容），
 *     不做二次序列化 —— 服务端是"不透明 blob"存储，重排会污染版本 diff；
 *   · 每个调用都可注入 `fetch`，便于离线测试全部错误分支（401/404/409/网络断）。
 */

export interface SyncConfig {
  /** 归一化后的基地址，如 http://127.0.0.1:8730 */
  serverUrl: string;
  token: string;
}

export type SyncErrorCode =
  | 'NOT_READY'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'BAD_REQUEST'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'SERVER';

/**
 * 同步错误。
 *
 * 注意：这里**不用构造函数参数属性**（`constructor(readonly code: ...)`）——
 * Node 的类型剥离（type-stripping）不支持该语法，会让测试无法直接导入本文件。
 * 显式赋值虽然多几行，但换来"模块能在 Node 里跑"。
 */
export class SyncError extends Error {
  readonly code: SyncErrorCode;
  readonly status: number | null;
  readonly detail: string | null;

  constructor(
    code: SyncErrorCode,
    message: string,
    status: number | null = null,
    detail: string | null = null,
  ) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export interface VersionSummary {
  seq: number;
  commit: string;
  sha256: string;
  size: number;
  message: string;
  author: string;
  kind: string;
  createdAt: string;
  audit: {
    error: number;
    warning: number;
    info: number;
    exportable: boolean;
  } | null;
}

export interface CardSummary {
  id: string;
  name: string;
  latestSeq: number;
  latestSha256: string;
  updatedAt: string;
  deleted: boolean;
}

export interface UploadResult {
  cardId: string;
  /** 新建时 seq = 1；追加版本时递增 */
  seq: number;
  commit: string;
  sha256: string;
  size: number;
  /** 是否新建了卡（而非追加版本） */
  created: boolean;
}

const DEFAULT_TIMEOUT_MS = 15000;

interface RequestOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

async function request(
  config: SyncConfig,
  path: string,
  init: RequestInit,
  options: RequestOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(`${config.serverUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(config.token.trim() === '' ? {} : { Authorization: `Bearer ${config.token.trim()}` }),
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new SyncError(
      aborted ? 'TIMEOUT' : 'NETWORK',
      aborted ? `请求超时（${timeoutMs} ms）` : '无法连接服务端',
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.ok) return response;

  // 错误体：服务端统一 { error: { code, message, detail? } }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  const errObj =
    body && typeof body['error'] === 'object' && body['error'] !== null
      ? (body['error'] as Record<string, unknown>)
      : null;
  const serverMessage = typeof errObj?.['message'] === 'string' ? errObj['message'] : null;
  const detail = typeof errObj?.['detail'] === 'string' ? errObj['detail'] : null;

  let code: SyncErrorCode = 'SERVER';
  if (response.status === 401 || response.status === 403) code = 'UNAUTHORIZED';
  else if (response.status === 404) code = 'NOT_FOUND';
  else if (response.status === 409) code = 'CONFLICT';
  else if (response.status >= 400 && response.status < 500) code = 'BAD_REQUEST';

  throw new SyncError(
    code,
    serverMessage ?? `服务端返回 HTTP ${response.status}`,
    response.status,
    detail,
  );
}

function toVersionSummary(input: Record<string, unknown>): VersionSummary {
  const audit = input['audit'];
  const auditObj =
    typeof audit === 'object' && audit !== null ? (audit as Record<string, unknown>) : null;

  return {
    seq: Number(input['seq'] ?? 0),
    commit: String(input['commit'] ?? ''),
    sha256: String(input['sha256'] ?? ''),
    size: Number(input['size'] ?? 0),
    message: String(input['message'] ?? ''),
    author: String(input['author'] ?? ''),
    kind: String(input['kind'] ?? ''),
    createdAt: String(input['createdAt'] ?? ''),
    audit:
      auditObj === null
        ? null
        : {
            error: Number(auditObj['error'] ?? 0),
            warning: Number(auditObj['warning'] ?? 0),
            info: Number(auditObj['info'] ?? 0),
            exportable: auditObj['exportable'] === true,
          },
  };
}

/**
 * 上传角色卡。
 *
 * 语义：
 *   · `cardId` 为空 → 新建（POST /api/cards，seq 恒为 1）
 *   · `cardId` 有值 → 追加版本（POST /api/cards/:id/versions，seq 递增）
 *
 * body 是**文本原文本身**（不包 JSON 信封），与服务端的"原始字节入库"约定一致。
 */
export async function uploadCard(
  config: SyncConfig,
  input: { text: string; cardId?: string | null; message?: string; author?: string },
  options: RequestOptions = {},
): Promise<UploadResult> {
  const query = new URLSearchParams();
  if (input.message) query.set('message', input.message);
  if (input.author) query.set('author', input.author);
  const suffix = query.toString() === '' ? '' : `?${query.toString()}`;

  const isNew = !input.cardId;
  const path = isNew ? `/api/cards${suffix}` : `/api/cards/${encodeURIComponent(input.cardId!)}/versions${suffix}`;

  const response = await request(
    config,
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: input.text,
    },
    options,
  );

  const body = (await response.json()) as Record<string, unknown>;

  // 新建返回 { card, version }，追加返回 version 本体
  if (isNew) {
    const card = (body['card'] ?? {}) as Record<string, unknown>;
    const version = (body['version'] ?? {}) as Record<string, unknown>;
    return {
      cardId: String(card['id'] ?? ''),
      seq: Number(version['seq'] ?? 1),
      commit: String(version['commit'] ?? ''),
      sha256: String(version['sha256'] ?? ''),
      size: Number(version['size'] ?? 0),
      created: true,
    };
  }

  return {
    cardId: input.cardId!,
    seq: Number(body['seq'] ?? 0),
    commit: String(body['commit'] ?? ''),
    sha256: String(body['sha256'] ?? ''),
    size: Number(body['size'] ?? 0),
    created: false,
  };
}

/** 列出角色卡（用于让用户选"要同步到哪张卡"） */
export async function listCards(
  config: SyncConfig,
  options: RequestOptions & { limit?: number; query?: string } = {},
): Promise<CardSummary[]> {
  const params = new URLSearchParams();
  params.set('limit', String(options.limit ?? 50));
  if (options.query) params.set('q', options.query);

  const response = await request(config, `/api/cards?${params.toString()}`, { method: 'GET' }, options);
  const body = (await response.json()) as Record<string, unknown>;
  const items = Array.isArray(body['items']) ? (body['items'] as Record<string, unknown>[]) : [];

  return items.map((item) => ({
    id: String(item['id'] ?? ''),
    name: String(item['name'] ?? ''),
    latestSeq: Number(item['latestSeq'] ?? item['latest_seq'] ?? 0),
    latestSha256: String(item['latestSha256'] ?? item['latest_sha256'] ?? ''),
    updatedAt: String(item['updatedAt'] ?? item['updated_at'] ?? ''),
    deleted: item['deleted'] === true,
  }));
}

/** 拉取版本历史（按 seq 倒序，服务端已排好） */
export async function listVersions(
  config: SyncConfig,
  cardId: string,
  options: RequestOptions & { limit?: number } = {},
): Promise<VersionSummary[]> {
  const params = new URLSearchParams();
  params.set('limit', String(options.limit ?? 50));

  const response = await request(
    config,
    `/api/cards/${encodeURIComponent(cardId)}/versions?${params.toString()}`,
    { method: 'GET' },
    options,
  );
  const body = (await response.json()) as Record<string, unknown>;
  const items = Array.isArray(body['items']) ? (body['items'] as Record<string, unknown>[]) : [];
  return items.map(toVersionSummary);
}

/**
 * 回滚到指定版本。
 *
 * `to` 可以是版本序号或 commit sha（服务端两者都认）。
 * 回滚在服务端是**新建一个提交**（历史只增不改），不会删除后续版本。
 */
export async function rollbackCard(
  config: SyncConfig,
  cardId: string,
  to: number | string,
  options: RequestOptions & { message?: string; author?: string } = {},
): Promise<UploadResult> {
  const response = await request(
    config,
    `/api/cards/${encodeURIComponent(cardId)}/rollback`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, message: options.message, author: options.author }),
    },
    options,
  );

  const body = (await response.json()) as Record<string, unknown>;
  const version = (body['version'] ?? body) as Record<string, unknown>;

  return {
    cardId,
    seq: Number(version['seq'] ?? 0),
    commit: String(version['commit'] ?? ''),
    sha256: String(version['sha256'] ?? ''),
    size: Number(version['size'] ?? 0),
    created: false,
  };
}

/** 拉取某版本的原始文本（用于"回滚预览"或"取回旧版本继续编辑"） */
export async function fetchVersionText(
  config: SyncConfig,
  cardId: string,
  rev: number | string,
  options: RequestOptions = {},
): Promise<string> {
  const response = await request(
    config,
    `/api/cards/${encodeURIComponent(cardId)}/versions/${encodeURIComponent(String(rev))}/raw`,
    { method: 'GET', headers: { Accept: 'application/json' } },
    options,
  );
  return response.text();
}
