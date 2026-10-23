/**
 * 认证客户端（T10.7）—— 登录 / 注册 / 刷新 / 登出 / 策略查询。
 *
 * 设计约束：
 *   · **不本地化任何失败原因**。服务端在 T10.4 里已经把「用户不存在 / 密码错 /
 *     账户被锁」统一成同一句文案，目的就是不给枚举留缝隙。客户端若"贴心"地
 *     把 401 翻成「用户名或密码错误」，等于在客户端重建了那个枚举面：
 *     攻击者只要看客户端提示语就能分辨服务端到底返回了哪种。
 *     所以这里的 `displayMessage` **优先原样使用服务端的 message**，
 *     只有在服务端没给 message 时才用中性的「服务端返回 HTTP 4xx」。
 *   · 无 DOM 依赖、可注入 `fetch`，便于在 Node 里跑全部错误分支。
 *   · 不读配置、不写配置 —— 持久化在 `session.ts`，这里只做 HTTP。
 */

export type RegisterMode = 'closed' | 'open' | 'admin-only';

export interface AuthPolicy {
  registerMode: RegisterMode;
  /** access 有效期（秒），客户端据此决定何时静默续期 */
  accessTtlSeconds: number;
  /** 服务端是否强制鉴权 */
  authRequired: boolean;
}

export interface AuthUser {
  userId: string;
  username: string;
  role: 'admin' | 'user';
}

export interface TokenBundle {
  accessToken: string;
  refreshToken: string;
  /** access 到期时刻（epoch ms）。服务端给 ISO，这里统一成数字便于比较 */
  accessExpiresAt: number;
  refreshExpiresAt: number;
  sessionId: string;
  user: AuthUser;
}

export type AuthFailureCode =
  /** 401：凭证不可用（含锁定中 —— 服务端刻意不区分） */
  | 'BAD_CREDENTIALS'
  /** 400：注册参数不合规或用户名被占用（服务端同一句文案） */
  | 'REGISTER_REJECTED'
  /** 403 REGISTRATION_CLOSED：未开放自助注册 */
  | 'REGISTER_CLOSED'
  /** 403 其它（admin-only、账户禁用） */
  | 'FORBIDDEN'
  /** 429：失败次数过多 */
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'SERVER';

/**
 * 认证错误。
 *
 * 不用构造函数参数属性：Node 的类型剥离不支持，测试会无法直接导入本文件
 * （与 `sync/server-sync.ts` 同一条理由）。
 */
export class AuthClientError extends Error {
  readonly code: AuthFailureCode;
  readonly status: number | null;
  /**
   * 给用户看的文案。
   *
   * **这是唯一允许出现在界面上的认证错误文案**：它要么是服务端原话，
   * 要么是中性的「无法完成请求（HTTP 4xx）」，绝不包含"可能是密码错了"
   * 这类本地推断。
   */
  readonly displayMessage: string;

  constructor(
    code: AuthFailureCode,
    displayMessage: string,
    status: number | null = null,
  ) {
    super(displayMessage);
    this.name = 'AuthClientError';
    this.code = code;
    this.status = status;
    this.displayMessage = displayMessage;
  }
}

const DEFAULT_TIMEOUT_MS = 15000;

export interface AuthRequestOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function base(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, '');
}

interface RawResponse {
  status: number;
  ok: boolean;
  body: Record<string, unknown> | null;
}

async function send(
  serverUrl: string,
  path: string,
  init: RequestInit,
  options: AuthRequestOptions,
): Promise<RawResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(`${base(serverUrl)}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new AuthClientError(
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
  return { status: response.status, ok: response.ok, body };
}

function errorFields(body: Record<string, unknown> | null): { code: string; message: string } {
  const err = body && typeof body['error'] === 'object' && body['error'] !== null
    ? (body['error'] as Record<string, unknown>)
    : null;
  return {
    code: typeof err?.['code'] === 'string' ? err['code'] : '',
    message: typeof err?.['message'] === 'string' ? err['message'] : '',
  };
}

/**
 * 把失败响应翻成 AuthClientError。
 *
 * 关键：`displayMessage` 优先取服务端 message。只有服务端没给时才用中性描述 ——
 * 中性描述里不含任何"原因猜测"。
 */
function failure(status: number, body: Record<string, unknown> | null): AuthClientError {
  const { code, message } = errorFields(body);
  const neutral = `无法完成请求（HTTP ${status}）`;
  const display = message.trim() !== '' ? message : neutral;

  if (status === 401) return new AuthClientError('BAD_CREDENTIALS', display, status);
  if (status === 429) return new AuthClientError('RATE_LIMITED', display, status);
  if (status === 403) {
    return code === 'REGISTRATION_CLOSED'
      ? new AuthClientError('REGISTER_CLOSED', display, status)
      : new AuthClientError('FORBIDDEN', display, status);
  }
  if (status === 400) return new AuthClientError('REGISTER_REJECTED', display, status);
  return new AuthClientError('SERVER', display, status);
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function time(value: unknown): number {
  if (typeof value !== 'string' || value === '') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toUser(input: unknown): AuthUser {
  const obj = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const role = obj['role'] === 'admin' ? 'admin' : 'user';
  return {
    userId: String(obj['id'] ?? obj['userId'] ?? ''),
    username: String(obj['username'] ?? ''),
    role,
  };
}

/** `T10.7 读策略（免鉴权）` */
export async function fetchPolicy(
  serverUrl: string,
  options: AuthRequestOptions = {},
): Promise<AuthPolicy> {
  const response = await send(serverUrl, '/api/auth/config', { method: 'GET' }, options);
  if (!response.ok) throw failure(response.status, response.body);

  const mode = response.body?.['registerMode'];
  return {
    // 不认识的值一律当 closed：宁可少显示一个入口，也不要让用户点了才发现不能用
    registerMode: mode === 'open' || mode === 'admin-only' ? mode : 'closed',
    accessTtlSeconds: num(response.body?.['accessTtlSeconds'], 7200),
    authRequired: response.body?.['authRequired'] !== false,
  };
}

function toBundle(body: Record<string, unknown>): TokenBundle {
  // 顶层与嵌套都兼容：服务端当前是顶层，但历史响应曾经嵌在 tokens 里
  const nested = typeof body['tokens'] === 'object' && body['tokens'] !== null
    ? (body['tokens'] as Record<string, unknown>)
    : {};
  const pick = (key: string): unknown => body[key] ?? nested[key];

  return {
    accessToken: String(pick('accessToken') ?? ''),
    refreshToken: String(pick('refreshToken') ?? ''),
    accessExpiresAt: time(pick('accessExpiresAt')),
    refreshExpiresAt: time(pick('refreshExpiresAt')),
    sessionId: String(pick('sessionId') ?? ''),
    user: toUser(body['user']),
  };
}

async function tokenRequest(
  serverUrl: string,
  path: string,
  body: Record<string, unknown>,
  options: AuthRequestOptions,
): Promise<TokenBundle> {
  const response = await send(
    serverUrl,
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    options,
  );
  if (!response.ok) throw failure(response.status, response.body);
  const bundle = toBundle(response.body ?? {});
  if (bundle.accessToken === '' || bundle.refreshToken === '') {
    // 形状不对时不能"当成功处理"：半套令牌会让后续每个请求都 401，
    // 而用户看到的是"登录成功了却什么都点不动"
    throw new AuthClientError('SERVER', '服务端返回的令牌不完整（缺少 access 或 refresh）', response.status);
  }
  return bundle;
}

export async function login(
  serverUrl: string,
  input: { username: string; password: string },
  options: AuthRequestOptions = {},
): Promise<TokenBundle> {
  return tokenRequest(serverUrl, '/api/auth/login', { ...input }, options);
}

export interface RegisterOutcome {
  /** 是否建号成功 */
  created: boolean;
  /**
   * 令牌。`admin-only` 模式下管理员替人建号**不返回令牌**（拿到别人的会话是越权），
   * 此时为 null —— 界面要显示"账户已创建，请让对方自己登录"，而不是假装登录成功。
   */
  tokens: TokenBundle | null;
  user: AuthUser;
}

export async function register(
  serverUrl: string,
  input: { username: string; password: string },
  options: AuthRequestOptions = {},
): Promise<RegisterOutcome> {
  const response = await send(
    serverUrl,
    '/api/auth/register',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    options,
  );
  if (!response.ok) throw failure(response.status, response.body);

  const body = response.body ?? {};
  if (typeof body['accessToken'] !== 'string' || body['accessToken'] === '') {
    return { created: true, tokens: null, user: toUser(body['user']) };
  }
  return { created: true, tokens: toBundle(body), user: toUser(body['user']) };
}

export async function refresh(
  serverUrl: string,
  refreshToken: string,
  options: AuthRequestOptions = {},
): Promise<TokenBundle> {
  return tokenRequest(serverUrl, '/api/auth/refresh', { refreshToken }, options);
}

/**
 * 登出（吊销当前会话）。
 *
 * 401 视为已达成目的：本地本来就要清掉令牌，服务端说"这个令牌已经不认了"
 * 与"刚吊销"对用户是同一个结果。其它错误照常抛，让调用方决定是否提示 ——
 * 但**本地状态一律清空**（见 session.ts），不能因为网络问题把用户困在"登出失败"。
 */
export async function logout(
  serverUrl: string,
  accessToken: string,
  options: AuthRequestOptions = {},
): Promise<void> {
  const response = await send(
    serverUrl,
    '/api/auth/logout',
    { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } },
    options,
  );
  if (response.ok || response.status === 401) return;
  throw failure(response.status, response.body);
}

/** 当前身份（用于启动时确认令牌与服务端是否一致） */
export async function me(
  serverUrl: string,
  accessToken: string,
  options: AuthRequestOptions = {},
): Promise<{ via: string; user: AuthUser | null; role: 'admin' | 'user' }> {
  const response = await send(
    serverUrl,
    '/api/auth/me',
    { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
    options,
  );
  if (!response.ok) throw failure(response.status, response.body);
  const body = response.body ?? {};
  return {
    via: String(body['via'] ?? ''),
    user: body['user'] === null || body['user'] === undefined ? null : toUser(body['user']),
    role: body['role'] === 'admin' ? 'admin' : 'user',
  };
}
