/**
 * 数据面 HTTP 应用（worker）：CRUD / 版本 / 审计。
 *
 * 关于「原始字节」的两条硬性约定，在这里落成代码：
 *   · 上传接口只读 `ctx.body`（Buffer），元数据一律走 query/header；
 *   · 不支持 `multipart/form-data` —— 任何 multipart 解析器都可能在内存里重组字节，
 *     我们要求客户端直接把文件内容当请求体发过来（见 docs/08）。
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { AppError } from '../errors.js';
import { isLoopbackAddress } from '../config.js';
import { API_VERSION, SERVER_VERSION, configSummary, type ServerContext } from '../context.js';
import { readRawBody, parseJsonBody } from './body.js';
import { TokenGate } from './auth.js';
import { scopeFromIdentity } from '../storage/card-scope.js';
import { registerAuthRoutes } from './auth-routes.js';
import { registerRepoRoutes } from './repo-routes.js';
import { AuthService } from '../auth/service.js';
import { LoginLimiter, DEFAULT_RATE_LIMIT } from '../auth/login-limit.js';
import { SessionStore } from '../auth/sessions.js';
import { UserStore } from '../storage/users.js';
import { RepoStore, TokenStore, checkTokenScope, type Operation } from '../storage/repos.js';
import { COMMON_HEADERS, methodNotAllowed, sendError, sendJson, sendRaw } from './responses.js';
import { Router, type RouteContext } from './router.js';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

function queryInt(query: URLSearchParams, key: string, fallback: number, min: number, max: number): number {
  const raw = query.get(key);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new AppError(400, 'BAD_REQUEST', `${key} 必须是整数`);
  return Math.min(max, Math.max(min, value));
}

function queryBool(query: URLSearchParams, key: string): boolean {
  const raw = query.get(key);
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function optional(query: URLSearchParams, key: string): string | undefined {
  const raw = query.get(key);
  return raw === null || raw.trim() === '' ? undefined : raw.trim();
}

/**
 * 解析上传请求里的角色卡 ID（T9.7）。
 *
 * 支持 `?cardId=` 与 `X-TCS-Card-Id` 两种写法：query 便于 curl 随手试，
 * header 便于客户端把 ID 与"纯字节 body"分干净。两处都给了且不一致 → 400，
 * 不去猜哪个是用户的本意。
 *
 * **空串不算"没给"。** `?cardId=` 是一个明确的、错误的输入：用户/客户端
 * 想表达"我要用这个 ID"，只是值忘了填。若把它当成"没给"而退回服务端发号，
 * 就会造出一张 ID 不是用户以为的那张卡 —— 这正是需求里禁止的"静默丢弃 cardId"。
 * 返回 `null` 只有一种含义：请求里确实没有这个参数（旧版客户端）。
 */
function resolveUploadCardId(ctx: RouteContext): string | null {
  const rawQuery = ctx.query.get('cardId');
  const rawHeader = ctx.req.headers['x-tcs-card-id'];
  const fromHeader = typeof rawHeader === 'string' ? rawHeader : Array.isArray(rawHeader) ? rawHeader[0] : undefined;

  // 注意 `URLSearchParams.get()` 缺参数时返回的是 **null**，不是 undefined。
  // 只判 undefined 会把 null 放进 candidates，下一行 `.trim()` 直接抛 500 ——
  // 而这个分支恰恰是"旧版客户端不带 cardId"的**最常见**路径。
  const candidates = [rawQuery, fromHeader].filter(
    (value): value is string => value !== undefined && value !== null,
  );
  if (candidates.length === 0) return null;

  const trimmed = candidates.map((value) => value.trim());
  if (new Set(trimmed).size > 1) {
    throw new AppError(400, 'BAD_CARD_ID', 'cardId 在 query 与 X-TCS-Card-Id 头里不一致', {
      query: rawQuery ?? null,
      header: fromHeader ?? null,
    });
  }
  const value = trimmed[0]!;
  if (value === '') {
    throw new AppError(400, 'BAD_CARD_ID', 'cardId 参数为空：要么给出有效 ID，要么完全不传（不传才会由服务端发号）', {
      hint: '不传 cardId 意味着"新建一张服务端发号的卡"，只在旧版客户端里出现',
    });
  }
  return value;
}

/**
 * 解析 `baseSeq`（本次上传所基于的远端版本号）。
 *
 * 只在客户端**确实知道自己上次上传的是哪一版**时才该传。传 0 与不传不同：
 * 0 表示"我知道远端应该是空的"，不传表示"我不知道基线"。二者都不触发分叉警告，
 * 但语义不同，所以这里保留原值、不做归一。
 */
function parseBaseSeq(query: URLSearchParams): number | null {
  const raw = query.get('baseSeq');
  if (raw === null || raw.trim() === '') return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new AppError(400, 'BAD_REQUEST', 'baseSeq 必须是非负整数');
  }
  return value;
}

function requireCardBody(ctx: RouteContext): Buffer {
  const contentType = String(ctx.req.headers['content-type'] ?? '').toLowerCase();
  if (contentType.startsWith('multipart/form-data')) {
    throw new AppError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      '不支持 multipart 上传：请把文件原始字节直接作为请求体',
      { hint: 'Content-Type 用 application/json 或 application/octet-stream，元数据放 query（message/author/platform/preset/filename）' },
    );
  }
  if (ctx.body.byteLength === 0) {
    throw new AppError(400, 'BAD_REQUEST', '请求体为空：需要角色卡文件原始字节');
  }
  return ctx.body;
}

function writeOptionsFrom(query: URLSearchParams, ctx: ServerContext): {
  message?: string;
  author?: string;
  platformId?: string | null;
  presetId?: string | null;
  includeStDefaults?: boolean;
  filename?: string;
} {
  const includeRaw = query.get('includeStDefaults');
  return {
    message: optional(query, 'message'),
    author: optional(query, 'author'),
    platformId: optional(query, 'platform') ?? ctx.config.defaultPlatformRule,
    presetId: optional(query, 'preset') ?? ctx.config.defaultPreset,
    includeStDefaults: includeRaw === null ? true : queryBool(query, 'includeStDefaults'),
    filename: optional(query, 'filename'),
  };
}

function rawHeaders(ctx: RouteContext, sha256: string, size: number, filename: string): Record<string, string> {
  return {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `${queryBool(ctx.query, 'inline') ? 'inline' : 'attachment'}; filename="${filename}"`,
    ETag: `"${sha256}"`,
    'X-TCS-Sha256': sha256,
    'X-TCS-Size': String(size),
    'X-TCS-API-Version': API_VERSION,
  };
}

/**
 * 逐请求的权限校验（T10.6）。
 *
 * **每次请求都调用它**，不缓存判定结果 —— 这是需求"权限校验在服务端逐请求执行
 * （不只在签发时）"的落地。改小令牌范围后，下一个请求就按新范围判。
 *
 * `operation` 的口径由 `requiredScope()` 单一来源决定（delete → write）。
 */
function assertPermission(gate: TokenGate, routeCtx: RouteContext, operation: Operation): void {
  const identity = gate.identify(routeCtx.req);
  // 没有身份时交给 TokenGate.check 已经拦过了（这里只处理"有身份但权限不够"）
  if (!identity) return;
  if (identity.via !== 'repo-token') return; // jwt / legacy 不受 scopes 限制

  const bound = identity.repoToken;
  if (!bound) return;
  // 身份解析时已经验证过吊销与过期，这里只需要判范围
  const result = checkTokenScope({ scopes: bound.scopes.join(',') }, operation);
  if (!result.allowed) {
    throw new AppError(403, 'FORBIDDEN', `${result.reason}：无法执行 ${operation} 操作`, {
      requiredScope: result.missing,
      tokenScopes: bound.scopes,
    });
  }
}

export function createWorkerHandler(ctx: ServerContext): (req: IncomingMessage, res: ServerResponse) => void {
  // 账户体系（T10.4）。Session/User 仓储与限速器都建在同一份 SQLite 句柄上，
  // 所以吊销状态与失败计数天然跟着库走（重启不丢）。
  const users = new UserStore(ctx.db.handle);
  const sessions = new SessionStore(ctx.db.handle);
  const limiter = new LoginLimiter(ctx.db.handle, DEFAULT_RATE_LIMIT);
  // 仓库与仓库令牌（T10.6）。必须在 authService 之前建好：
  // 注册时要顺手给新账户建默认仓库。
  const repos = new RepoStore(ctx.db.handle);
  const repoTokens = new TokenStore(ctx.db.handle);
  const authService = new AuthService({ config: ctx.config, users, sessions, limiter, repos });

  const gate = new TokenGate(ctx.config.auth.token, ctx.config.auth.publicPaths, ctx.config.auth.require, {
    jwtSecret: ctx.config.auth.jwtSecret,
    sessions,
    users,
    repoTokens,
    repos,
  });

  /** 客户端 IP。只信 socket 地址，不读 X-Forwarded-For（可伪造，会废掉限速） */
  const clientIp = (context: RouteContext): string => context.req.socket.remoteAddress ?? 'unknown';

  const router = new Router();

  registerAuthRoutes(router, {
    auth: authService,
    identify: (context) => gate.identify(context.req),
    clientIp,
  });

  registerRepoRoutes(router, {
    repos,
    tokens: repoTokens,
    identify: (context) => gate.identify(context.req),
  });

  router.get('/api/health', (_ctx) => {
    sendJson(_ctx.res, 200, {
      status: 'ok',
      role: 'worker',
      version: SERVER_VERSION,
      apiVersion: API_VERSION,
      pid: process.pid,
      startedAt: new Date(ctx.startedAt).toISOString(),
      uptimeMs: Date.now() - ctx.startedAt,
      node: process.version,
      authRequired: ctx.config.auth.require,
    });
  });

  /**
   * F6.2 取令牌接口。
   *
   * 定位：这是「客户端首次连接本机服务端」的引导接口 —— 用户装了服务端，
   * 不想去翻日志找令牌，点一下按钮自动填好。
   *
   * **它必须在 TokenGate 之前处理**（见 handle() 里的提前返回），
   * 因为调用方此刻手里还没有令牌 —— 这正是它存在的理由。
   * 取而代之的门禁是**回环来源检查**。
   */
  router.get('/api/token', (_ctx) => {
    // 双重判断：连接来源必须是回环。
    // 这里刻意不读 X-Forwarded-For —— 那个头由客户端随便写，拿它做门禁等于没有门禁。
    const remote = _ctx.req.socket.remoteAddress;
    if (!isLoopbackAddress(remote)) {
      throw new AppError(
        403,
        'TOKEN_LOCAL_ONLY',
        '取令牌接口只接受来自本机的请求（令牌不得出本机）',
        { hint: '请在服务端所在的这台机器上运行客户端；远程使用请手动复制令牌' },
      );
    }
    if (ctx.config.auth.token === '') {
      // 防御性分支：正常配置流程下**走不到这里**。
      // `normalizeConfig` 用 `generateToken()` 兜底，所以服务端永远有令牌；
      // `auth.require=false` 只是「不校验」，不代表「没有令牌」。
      // 保留这个分支是为了挡住一种可能：有人绕过 normalizeConfig 直接构造配置
      // （测试替身、未来新增的入口）。此时返回空串会让客户端把
      // 「无鉴权」误当成「令牌是空字符串」，所以宁可明确报错。
      throw new AppError(
        409,
        'TOKEN_NOT_CONFIGURED',
        '服务端未配置访问令牌（配置被绕过规范化构造），无法取令牌',
        { hint: '删除配置文件让服务端重新生成，或运行 `tcs-server token rotate`' },
      );
    }
    sendJson(_ctx.res, 200, {
      token: ctx.config.auth.token,
      // 让客户端知道服务端是否真的在校验令牌：false 时令牌填不填都能连，
      // 界面上可以据此提示，而不是让用户以为「必须填对」。
      authRequired: ctx.config.auth.require,
      server: { version: SERVER_VERSION, apiVersion: API_VERSION },
    });
  });

  router.get('/api/auth/verify', (_ctx) => {
    sendJson(_ctx.res, 200, {
      ok: true,
      auth: { mode: 'bearer-token', required: ctx.config.auth.require },
      server: { version: SERVER_VERSION, apiVersion: API_VERSION, pid: process.pid },
    });
  });

  /**
   * 统计（T10.8：按可见范围过滤）。
   *
   * 计数必须跟着凭证走：卡片数 / 版本数 / 字节数任何一个漏掉过滤，
   * 都会变成"能推出别人有多少张卡"的侧信道。
   *
   * `isolationEnforced: true` 是给客户端的一个**明确信号**：服务端已经在
   * 服务端侧做了隔离，客户端不该再显示"尚未按账户过滤"这类提示
   * （否则会变成一句永远为真的免责声明）。
   */
  router.get('/api/stats', (_ctx) => {
    const scope = scopeFromIdentity(gate.identify(_ctx.req));
    const stats = ctx.cards.stats(scope);
    sendJson(_ctx.res, 200, {
      ...stats,
      uptimeMs: Date.now() - ctx.startedAt,
      version: SERVER_VERSION,
      config: configSummary(ctx.config),
      // 实际生效的 TLS 状态（含证书指纹）：面板要显示它供用户核对，
      // 客户端也可以用它判断"我连的是不是我以为的那台服务端"
      tls: ctx.tls,
      rules: ctx.registry.loadErrors(),
      /** 服务端是否强制了按凭证隔离（v0.1.2 / T10.8 起恒为 true） */
      isolationEnforced: true,
      /** 本凭证实际可见的范围，供面板与客户端如实展示「你看到的是哪一片」 */
      scope: {
        kind: scope.kind,
        repoId: scope.kind === 'owner' ? scope.repoId : null,
      },
    });
  });

  router.get('/api/events', (_ctx) => {
    const limit = queryInt(_ctx.query, 'limit', 50, 1, 500);
    sendJson(_ctx.res, 200, {
      items: ctx.cards.events(limit, scopeFromIdentity(gate.identify(_ctx.req))),
    });
  });

  // ── 规则资产（只读） ──────────────────────────────────────────

  router.get('/api/platforms', (_ctx) => {
    sendJson(_ctx.res, 200, {
      items: ctx.registry.listPlatforms(),
      default: ctx.config.defaultPlatformRule,
      errors: ctx.registry.loadErrors().platforms,
    });
  });

  router.get('/api/presets', (_ctx) => {
    sendJson(_ctx.res, 200, {
      items: ctx.registry.listPresets(),
      default: ctx.config.defaultPreset,
      errors: ctx.registry.loadErrors().presets,
    });
  });

  // ── T5.1 CRUD ────────────────────────────────────────────────

  router.get('/api/cards', (_ctx) => {
    assertPermission(gate, _ctx, 'read');
    const limit = queryInt(_ctx.query, 'limit', 50, 1, 500);
    const offset = queryInt(_ctx.query, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
    const result = ctx.cards.list({
      q: optional(_ctx.query, 'q'),
      limit,
      offset,
      includeDeleted: queryBool(_ctx.query, 'includeDeleted'),
      scope: scopeFromIdentity(gate.identify(_ctx.req)),
    });
    sendJson(_ctx.res, 200, { total: result.total, limit, offset, items: result.items });
  });

  /**
   * 上传（T9.7 按 ID 归档）。
   *
   *   · 带 `cardId` → **upsert**：存在则追加版本，不存在则按该 ID 新建；
   *   · 不带 `cardId` → 服务端发号（旧版客户端兼容路径，`idSource='auto'`）。
   *
   * 状态码：新建 201、追加 200。旧客户端不看状态码只看 `response.ok`，
   * 所以这个区分不会打断它们。
   *
   * 响应里的 `warnings` 是**不阻断**的提示：目前是分叉（FORK）与
   * "远端没有这张卡"（REMOTE_MISSING）。两者都照常写入 ——
   * 内容不能因为"可能有冲突"就丢掉，但用户必须知道。
   */
  router.post('/api/cards', async (_ctx) => {
    assertPermission(gate, _ctx, 'write');
    const bytes = requireCardBody(_ctx);
    const cardId = resolveUploadCardId(_ctx);

    // 归属解析（T10.6）：
    //   · 仓库令牌 → 固定绑到它自己的仓库，忽略 query（不能越界写到别的仓库）
    //   · 账户登录 → query 里的 repo 或该账户的默认仓库
    //   · legacy 全局 token → 无归属（空串），由运维用 user adopt 处理
    const identity = gate.identify(_ctx.req);
    let ownerId: string | null = identity?.userId ?? null;
    let repoId: string | null = null;
    if (identity?.via === 'repo-token' && identity.repoToken) {
      repoId = identity.repoToken.repoId;
      ownerId = identity.userId;
    } else if (ownerId) {
      const requested = optional(_ctx.query, 'repo');
      const repo = requested
        ? repos.findByOwnerAndName(ownerId, requested)
        : repos.ensureDefault(ownerId);
      if (!repo) {
        throw new AppError(404, 'NOT_FOUND', `仓库「${requested ?? ''}」不存在`);
      }
      repoId = repo.id;
    }

    const result = await ctx.cards.upload(cardId, bytes, {
      ...writeOptionsFrom(_ctx.query, ctx),
      baseSeq: parseBaseSeq(_ctx.query),
      ownerId,
      repoId,
      // 判「这个 ID 是不是别人的卡」要用同一套范围判据，否则 legacy 就能
      // 往账户的卡里追加版本（那是跨账户写入，比读更严重）
      scope: scopeFromIdentity(identity),
    });
    sendJson(_ctx.res, result.created ? 201 : 200, result, {
      Location: `/api/cards/${encodeURIComponent(result.cardId)}`,
      'X-TCS-Card-Id': result.cardId,
      'X-TCS-Card-Seq': String(result.seq),
      'X-TCS-Card-Created': result.created ? '1' : '0',
    });
  });

  router.get('/api/cards/:id', (_ctx) => {
    assertPermission(gate, _ctx, 'read');
    const card = ctx.cards.get(_ctx.params['id']!, {
      includeDeleted: queryBool(_ctx.query, 'includeDeleted'),
      scope: scopeFromIdentity(gate.identify(_ctx.req)),
    });
    sendJson(_ctx.res, 200, card);
  });

  router.delete('/api/cards/:id', async (_ctx) => {
    assertPermission(gate, _ctx, 'delete');
    const result = await ctx.cards.delete(_ctx.params['id']!, {
      hard: queryBool(_ctx.query, 'hard'),
      scope: scopeFromIdentity(gate.identify(_ctx.req)),
    });
    sendJson(_ctx.res, 200, { deleted: true, ...result });
  });

  router.get('/api/cards/:id/raw', (_ctx) => {
    assertPermission(gate, _ctx, 'read');
    const { bytes, version } = ctx.cards.readBytes(
      _ctx.params['id']!,
      optional(_ctx.query, 'version') ?? optional(_ctx.query, 'rev'),
      scopeFromIdentity(gate.identify(_ctx.req)),
    );
    sendRaw(
      _ctx.res,
      200,
      bytes,
      rawHeaders(_ctx, version.blob_sha256, version.byte_size, `${_ctx.params['id']}-v${version.seq}.json`),
    );
  });

  // ── T5.2 版本 ────────────────────────────────────────────────

  router.get('/api/cards/:id/versions', (_ctx) => {
    assertPermission(gate, _ctx, 'read');
    const limit = queryInt(_ctx.query, 'limit', 50, 1, 500);
    const offset = queryInt(_ctx.query, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
    const result = ctx.cards.listVersions(_ctx.params['id']!, {
      limit,
      offset,
      scope: scopeFromIdentity(gate.identify(_ctx.req)),
    });
    sendJson(_ctx.res, 200, { total: result.total, limit, offset, items: result.items });
  });

  router.post('/api/cards/:id/versions', async (_ctx) => {
    assertPermission(gate, _ctx, 'write');
    const bytes = requireCardBody(_ctx);
    const version = await ctx.cards.addVersion(_ctx.params['id']!, bytes, {
      ...writeOptionsFrom(_ctx.query, ctx),
      scope: scopeFromIdentity(gate.identify(_ctx.req)),
    });
    sendJson(_ctx.res, 201, version, {
      Location: `/api/cards/${_ctx.params['id']}/versions/${version.seq}`,
    });
  });

  router.get('/api/cards/:id/versions/:rev', (_ctx) => {
    assertPermission(gate, _ctx, 'read');
    const version = ctx.cards.resolveVersion(
      _ctx.params['id']!,
      _ctx.params['rev'],
      scopeFromIdentity(gate.identify(_ctx.req)),
    );
    sendJson(_ctx.res, 200, ctx.cards.versionDto(version));
  });

  router.get('/api/cards/:id/versions/:rev/raw', (_ctx) => {
    assertPermission(gate, _ctx, 'read');
    const { bytes, version } = ctx.cards.readBytes(
      _ctx.params['id']!,
      _ctx.params['rev'],
      scopeFromIdentity(gate.identify(_ctx.req)),
    );
    sendRaw(
      _ctx.res,
      200,
      bytes,
      rawHeaders(_ctx, version.blob_sha256, version.byte_size, `${_ctx.params['id']}-v${version.seq}.json`),
    );
  });

  router.get('/api/cards/:id/diff', (_ctx) => {
    assertPermission(gate, _ctx, 'read');
    const toRev = optional(_ctx.query, 'to') ?? 'latest';
    const scope = scopeFromIdentity(gate.identify(_ctx.req));
    const to = ctx.cards.resolveVersion(_ctx.params['id']!, toRev, scope);
    const fromRev = optional(_ctx.query, 'from') ?? String(Math.max(1, to.seq - 1));
    const includeRaw = optional(_ctx.query, 'include');
    const include = includeRaw
      ? {
          bytes: includeRaw.split(',').includes('bytes'),
          lines: includeRaw.split(',').includes('lines'),
          json: includeRaw.split(',').includes('json'),
        }
      : undefined;
    const diff = ctx.cards.diff(_ctx.params['id']!, fromRev, String(to.seq), {
      include,
      context: queryInt(_ctx.query, 'context', 3, 0, 20),
      scope,
    });
    sendJson(_ctx.res, 200, diff);
  });

  router.post('/api/cards/:id/rollback', async (_ctx) => {
    assertPermission(gate, _ctx, 'rollback');
    const meta = parseJsonBody<{ to?: string | number; message?: string; author?: string }>(_ctx.body, {});
    const to = String(meta.to ?? optional(_ctx.query, 'to') ?? '');
    if (to === '') throw new AppError(400, 'BAD_REQUEST', '缺少回滚目标：body.to 或 ?to=（版本序号 / 提交 sha）');
    const result = await ctx.cards.rollback(_ctx.params['id']!, to, {
      message: meta.message ?? optional(_ctx.query, 'message'),
      author: meta.author ?? optional(_ctx.query, 'author'),
      scope: scopeFromIdentity(gate.identify(_ctx.req)),
    });
    sendJson(_ctx.res, 201, result);
  });

  // ── T5.3 审计 ────────────────────────────────────────────────

  router.post('/api/audit', (_ctx) => {
    const bytes = requireCardBody(_ctx);
    const result = ctx.cards.auditBytes(bytes, {
      platformId: optional(_ctx.query, 'platform') ?? ctx.config.defaultPlatformRule,
      presetId: optional(_ctx.query, 'preset') ?? ctx.config.defaultPreset,
      includeStDefaults: _ctx.query.get('includeStDefaults') === null ? true : queryBool(_ctx.query, 'includeStDefaults'),
    });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    sendRaw(_ctx.res, 200, result.reportBytes, {
      'Content-Type': 'application/json; charset=utf-8',
      ETag: `"${sha256}"`,
      'X-TCS-Card-Sha256': sha256,
      'X-TCS-Audit-Source': 'ad-hoc',
      'X-TCS-API-Version': API_VERSION,
    });
  });

  router.get('/api/cards/:id/audit', (_ctx) => {
    assertPermission(gate, _ctx, 'read');
    const version = optional(_ctx.query, 'version') ?? optional(_ctx.query, 'rev');
    if (queryBool(_ctx.query, 'refresh')) {
      const result = ctx.cards.recomputeAudit(_ctx.params['id']!, version, {
        platformId: optional(_ctx.query, 'platform') ?? ctx.config.defaultPlatformRule,
        presetId: optional(_ctx.query, 'preset') ?? ctx.config.defaultPreset,
        scope: scopeFromIdentity(gate.identify(_ctx.req)),
      });
      sendRaw(_ctx.res, 200, result.reportBytes, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-TCS-Audit-Source': 'recomputed',
        ...(result.storedAuditSha256 ? { 'X-TCS-Audit-Snapshot': result.storedAuditSha256 } : {}),
        'X-TCS-API-Version': API_VERSION,
      });
      return;
    }
    const { bytes, version: row } = ctx.cards.readAuditBytes(
      _ctx.params['id']!,
      version,
      scopeFromIdentity(gate.identify(_ctx.req)),
    );
    sendRaw(_ctx.res, 200, bytes, {
      'Content-Type': 'application/json; charset=utf-8',
      ETag: `"${row.audit_sha256}"`,
      'X-TCS-Audit-Source': 'snapshot',
      'X-TCS-Audit-Sha256': row.audit_sha256 ?? '',
      'X-TCS-Audit-For-Version': String(row.seq),
      'X-TCS-API-Version': API_VERSION,
    });
  });

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = Date.now();
    const method = (req.method ?? 'GET').toUpperCase();
    let pathname = '/';
    try {
      const host = req.headers.host ?? `${ctx.config.host}:${ctx.config.port}`;
      const url = new URL(req.url ?? '/', `http://${host}`);
      pathname = url.pathname;

      if (method === 'OPTIONS') {
        res.writeHead(204, {
          ...COMMON_HEADERS,
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-API-Token',
          'Access-Control-Expose-Headers': 'ETag, X-TCS-Sha256, X-TCS-Audit-Source, X-TCS-Audit-Sha256, X-TCS-Card-Id',
          'Access-Control-Max-Age': '600',
        });
        res.end();
        return;
      }

      // `/api/token` 是引导接口：调用方此时**必然没有令牌**，所以不能过 TokenGate。
      // 它的门禁是路由内部的回环来源检查（见路由定义）。
      //
      // 为什么不在 auth.publicPaths 里加这一条：publicPaths 是用户可改的配置项，
      // 而这条豁免是安全模型的一部分，不该被误删或误加宽。把它写死在这里，
      // 并让「来源必须是回环」成为唯一条件，审计时一眼能看清。
      //
      // 认证端点同理（T10.4）：登录/注册/刷新时调用方必然还没有令牌。
      // 注意**不含** /api/auth/logout 与 /api/auth/me —— 那两个需要身份。
      const isTokenBootstrap = method === 'GET' && pathname === '/api/token';
      const isAuthEntry =
        method === 'POST' &&
        (pathname === '/api/auth/login' || pathname === '/api/auth/register' || pathname === '/api/auth/refresh');
      // `GET /api/auth/config` 也必须免鉴权（T10.7）：客户端要在**登录框出现之前**
      // 就知道该不该显示「注册」入口。它只回公开的策略（注册模式、版本号），
      // 不含任何账户信息 —— 因此没有信息泄露面。
      const isAuthPolicy = method === 'GET' && pathname === '/api/auth/config';
      if (!isTokenBootstrap && !isAuthEntry && !isAuthPolicy) {
        gate.check(req, pathname);
      }

      const match = router.match(method, pathname);
      if (!match) {
        const allowed = router.allowedMethods(pathname);
        if (allowed.length > 0) {
          methodNotAllowed(res, allowed);
          return;
        }
        throw new AppError(404, 'NOT_FOUND', `没有这个接口：${method} ${pathname}`);
      }

      const body = BODY_METHODS.has(method) ? await readRawBody(req, ctx.config.maxUploadBytes) : Buffer.alloc(0);
      const context: RouteContext = {
        req,
        res,
        url,
        method,
        path: pathname,
        params: match.params,
        query: url.searchParams,
        body,
      };
      await match.handler(context);
    } catch (error) {
      if (!res.headersSent) sendError(res, error);
      else res.end();
    } finally {
      ctx.logger.debug('http.request', {
        method,
        path: pathname,
        status: res.statusCode,
        ms: Date.now() - started,
      });
    }
  };

  return (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'ETag, X-TCS-Sha256, X-TCS-Audit-Source, X-TCS-Card-Id');
    void handler(req, res);
  };
}
