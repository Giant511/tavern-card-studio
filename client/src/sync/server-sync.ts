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
  /** 内容被清除（prune）后为 null —— 渲染前必须判空，不能直接 slice */
  sha256: string | null;
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
  /** F13.3：内容已被清除（元数据仍在） */
  pruned?: boolean;
  prunedAt?: string | null;
  prunedBy?: string | null;
}

export interface CardSummary {
  /** 卡片 ID（= 寻址键，历史/回滚都用它） */
  cardId: string;
  /** 与 cardId 同值；保留旧字段名以兼容尚未改名的调用点 */
  id: string;
  name: string;
  /**
   * 所属仓库（T10.6 起服务端下发）。
   *
   * 空串 = 尚未归属（v0.1.2 升级前的历史卡）；`repoName` 为 null 时
   * **不要**在显示层猜一个名字，交给 `card-row.ts` 统一成「未归属」。
   */
  repoId: string;
  repoName: string | null;
  /** 最新版本号；没有任何版本时为 0 */
  latestSeq: number;
  latestSha256: string;
  updatedAt: string;
  deleted: boolean;
  /** ID 来源：client = 用户指定；auto = 服务端发号（旧版客户端）；legacy = v0.1.1 之前入库 */
  idSource: 'client' | 'auto' | 'legacy' | null;
  versionCount: number;
}

/** 服务端返回的不阻断警告 */
export interface UploadWarning {
  code: 'FORK' | 'REMOTE_MISSING' | string;
  message: string;
  baseSeq: number | null;
  remoteLatestSeq: number | null;
  remoteLatestSha256: string | null;
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
  /** 分叉等警告：写入已成功，只是需要让用户知道 */
  warnings: UploadWarning[];
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

  /*
   * `pruned` / `sha256: null` 必须**照原样**映射过来。
   *
   * 这里原本写 `sha256: String(input['sha256'] ?? '')` —— 服务端在 prune 后
   * 明确给 `null`（表示"内容没了"），被转成空串后：
   *   · 界面拿去 `.slice(0,12)` 显示一个空白的 sha 格子；
   *   · 而 `pruned` 根本没被映射，于是"已清除"的判断永远是 false ——
   *     实测表现为：服务端已 pruned、DOM 里也显示 0 字节，但「清除内容」
   *     按钮还挂着（能被再点一次），版本行也没有"已清除"标记。
   * 类型上 `sha256: string | null` 就是为了让这个区别活到渲染层。
   */
  const pruned = input['pruned'] === true;
  return {
    seq: Number(input['seq'] ?? 0),
    commit: String(input['commit'] ?? ''),
    sha256: pruned ? null : String(input['sha256'] ?? ''),
    pruned,
    prunedAt: typeof input['prunedAt'] === 'string' ? input['prunedAt'] : null,
    prunedBy: typeof input['prunedBy'] === 'string' ? input['prunedBy'] : null,
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

function toUploadWarning(input: unknown): UploadWarning | null {
  if (typeof input !== 'object' || input === null) return null;
  const obj = input as Record<string, unknown>;
  const code = typeof obj['code'] === 'string' ? obj['code'] : '';
  if (code === '') return null;
  const numberOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    code,
    message: typeof obj['message'] === 'string' ? obj['message'] : '',
    baseSeq: numberOrNull(obj['baseSeq']),
    remoteLatestSeq: numberOrNull(obj['remoteLatestSeq']),
    remoteLatestSha256: typeof obj['remoteLatestSha256'] === 'string' ? obj['remoteLatestSha256'] : null,
  };
}

/**
 * 上传角色卡（T9.7：**按 ID 归档**）。
 *
 * 只有一次请求：`POST /api/cards?cardId=<id>&baseSeq=<n>`，服务端 upsert——
 * 存在则追加版本、不存在则按该 ID 新建。之前是"有没有 cardId 决定调哪个端点"，
 * 那是个竞态：查存在性与写入之间别人可能刚建了同一张卡。
 *
 * `baseSeq` = 本会话上次上传拿到的 seq（没有就不传）。服务端据此判断是不是分叉。
 *
 * **旧版服务端会被识别出来并拒绝**：v0.1.0 的服务端不认识 `cardId`，
 * 会忽略它、自己发一个号，然后在响应里返回那个新号。若不比对，
 * 客户端会以为"上传成功，但 ID 变了"，接着把会话的 ID 改成服务端发号的那个 ——
 * 用户的稳定标识就这样被悄悄换掉了。所以这里比对，不一致直接报错。
 */
export async function uploadCard(
  config: SyncConfig,
  input: {
    text: string;
    cardId?: string | null;
    baseSeq?: number | null;
    message?: string;
    author?: string;
    /**
     * 目标仓库名（T10.8）。只对账户登录生效：服务端按 `owner + 名字` 解析仓库 id；
     * 仓库令牌的仓库由令牌绑定，传了也会被忽略；legacy 传了也没有账户可挂。
     */
    repo?: string | null;
  },
  options: RequestOptions = {},
): Promise<UploadResult> {
  const query = new URLSearchParams();
  if (input.message) query.set('message', input.message);
  if (input.author) query.set('author', input.author);
  if (input.repo) query.set('repo', input.repo);
  const requestedId = input.cardId?.trim() ? input.cardId.trim() : null;
  if (requestedId !== null) query.set('cardId', requestedId);
  if (typeof input.baseSeq === 'number' && input.baseSeq > 0) query.set('baseSeq', String(input.baseSeq));

  const suffix = query.toString() === '' ? '' : `?${query.toString()}`;

  const response = await request(
    config,
    `/api/cards${suffix}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: input.text,
    },
    options,
  );

  const body = (await response.json()) as Record<string, unknown>;

  // 新服务端：顶层直接给 cardId / seq / created / warnings
  // 旧服务端：只有 { card: {id}, version: {seq} }，且 cardId 用的是它自己发的号
  const card = (body['card'] ?? {}) as Record<string, unknown>;
  const version = (body['version'] ?? {}) as Record<string, unknown>;

  const returnedId = String(body['cardId'] ?? card['id'] ?? '');
  const seq = Number(body['seq'] ?? version['seq'] ?? 0);

  if (requestedId !== null && returnedId !== requestedId) {
    throw new SyncError(
      'CONFLICT',
      `服务端没有按 ID「${requestedId}」归档（返回的是「${returnedId}」）：服务端版本过旧，请升级服务端 MSI 后重试`,
      response.status,
      'v0.1.0 的服务端会忽略 cardId 并自行发号；v0.1.1 起才支持按 ID 归档',
    );
  }

  const warningsRaw = body['warnings'];
  const warnings = Array.isArray(warningsRaw)
    ? warningsRaw.map(toUploadWarning).filter((item): item is UploadWarning => item !== null)
    : [];

  return {
    cardId: returnedId,
    seq,
    commit: String(body['commit'] ?? version['commit'] ?? ''),
    sha256: String(body['sha256'] ?? version['sha256'] ?? ''),
    size: Number(body['size'] ?? version['size'] ?? 0),
    created: body['created'] === true || (body['created'] === undefined && input.cardId == null),
    warnings,
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

  return items.map((item) => {
    const id = String(item['cardId'] ?? item['id'] ?? '');
    const latest = (item['latest'] ?? {}) as Record<string, unknown>;
    return {
      cardId: id,
      id,
      name: String(item['name'] ?? ''),
      repoId: String(item['repoId'] ?? ''),
      repoName: typeof item['repoName'] === 'string' ? item['repoName'] : null,
      // 顶层 latestSeq 优先；退回 latest.seq（旧服务端只给嵌套那个）
      latestSeq: Number(item['latestSeq'] ?? latest['seq'] ?? 0),
      latestSha256: String(latest['sha256'] ?? ''),
      updatedAt: String(item['updatedAt'] ?? ''),
      deleted: item['deletedAt'] !== null && item['deletedAt'] !== undefined,
      idSource:
        item['idSource'] === 'client' || item['idSource'] === 'auto' || item['idSource'] === 'legacy'
          ? (item['idSource'] as 'client' | 'auto' | 'legacy')
          : null,
      versionCount: Number(item['versionCount'] ?? 0),
    };
  });
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
 * 删除卡片（F13.2）：**软删除**，进回收站，保留期内可恢复。
 *
 * 为什么不在这里提供"彻底清除"：那是不可逆操作、仅管理员可用，客户端不做入口
 * （面板的治理页才给）。误点一次删除还能恢复，误点一次彻底清除就只能认了。
 */
export async function deleteCard(
  config: SyncConfig,
  cardId: string,
  options: RequestOptions = {},
): Promise<{ id: string; alreadyDeleted: boolean }> {
  const response = await request(
    config,
    `/api/cards/${encodeURIComponent(cardId)}`,
    { method: 'DELETE' },
    options,
  );
  const body = (await response.json()) as Record<string, unknown>;
  return {
    id: typeof body['id'] === 'string' ? body['id'] : cardId,
    alreadyDeleted: body['alreadyDeleted'] === true,
  };
}

/** 从回收站恢复（F13.2） */
export async function restoreCard(
  config: SyncConfig,
  cardId: string,
  options: RequestOptions = {},
): Promise<{ id: string; restored: boolean }> {
  const response = await request(
    config,
    `/api/cards/${encodeURIComponent(cardId)}/restore`,
    { method: 'POST' },
    options,
  );
  const body = (await response.json()) as Record<string, unknown>;
  return { id: typeof body['id'] === 'string' ? body['id'] : cardId, restored: body['restored'] === true };
}

/**
 * 清除某版本的内容（F13.3）。
 *
 * 最新版本服务端会拒绝（409）—— 客户端也把入口置灰，两层都拦：
 * 只靠服务端的话，用户会点出一个"不知道为什么不行"的报错。
 */
export async function pruneVersion(
  config: SyncConfig,
  cardId: string,
  seq: number,
  options: RequestOptions = {},
): Promise<{ seq: number; pruned: boolean; alreadyPruned: boolean }> {
  const response = await request(
    config,
    `/api/cards/${encodeURIComponent(cardId)}/versions/${String(seq)}/prune`,
    { method: 'POST' },
    options,
  );
  const body = (await response.json()) as Record<string, unknown>;
  return {
    seq: typeof body['seq'] === 'number' ? body['seq'] : seq,
    pruned: body['pruned'] === true,
    alreadyPruned: body['alreadyPruned'] === true,
  };
}

/** 把卡片移到另一个仓库（F13.4）：改归属，不动内容与 updated_at */
export async function moveCard(
  config: SyncConfig,
  cardId: string,
  repoId: string,
  options: RequestOptions & { reason?: string } = {},
): Promise<{ repoId: string; fromRepoId: string; moved: boolean }> {
  const response = await request(
    config,
    `/api/cards/${encodeURIComponent(cardId)}/move`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repoId, reason: options.reason }),
    },
    options,
  );
  const body = (await response.json()) as Record<string, unknown>;
  return {
    repoId: typeof body['repoId'] === 'string' ? body['repoId'] : repoId,
    fromRepoId: typeof body['fromRepoId'] === 'string' ? body['fromRepoId'] : '',
    moved: body['moved'] === true,
  };
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
    // 回滚不做分叉判定：它本身就是"以旧版新建一个提交"，没有基线概念
    warnings: [],
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
