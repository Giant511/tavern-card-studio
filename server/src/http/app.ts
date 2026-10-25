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
import { ALL_CARDS, scopeFromIdentity, type CardScope } from '../storage/card-scope.js';
import { registerAuthRoutes } from './auth-routes.js';
import { registerRepoRoutes } from './repo-routes.js';
import { registerAccountRoutes } from './account-routes.js';
import { TrustProxyResolver, decideTokenGate } from '../net/trust-proxy.js';
import { AuthService } from '../auth/service.js';
import { LiveRegisterMode } from '../config-live.js';
import { LoginLimiter, DEFAULT_RATE_LIMIT } from '../auth/login-limit.js';
import { SessionStore } from '../auth/sessions.js';
import { UserStore } from '../storage/users.js';
import { RepoStore, TokenStore, checkTokenScope, type Operation } from '../storage/repos.js';
import { COMMON_HEADERS, methodNotAllowed, sendError, sendJson, sendRaw } from './responses.js';
import { Router, type RouteContext } from './router.js';

/*
 * DELETE 也读请求体（T10.19）。
 *
 * `DELETE /api/repos/:id {transferTo}` 需要它。HTTP 规范允许 DELETE 带体，
 * 但**中间代理可能把它丢掉**，所以仓库删除那条路由同时接受
 * `?transferTo=` 作为等价写法（见 repo-routes.ts）。
 * 这里不读体的后果很隐蔽：handler 拿到空对象，于是"非空仓库必须指定目标"
 * 这条规则会把一个**带了 transferTo 的请求**判成没带（测试实测 409）。
 */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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
/**
 * 仅管理员（F13.1）。
 *
 * `legacy` 令牌也算管理员：它在 v0.1.1 时期就是全权运维凭证，
 * 引入账户后如果反而缩权，"升级后运维脚本突然不能用了"。
 * 但它的**可见范围**已被降权为"未归属卡片"（docs/29 §2），
 * 所以它能 purge 的只是那些卡 —— 权限与可见范围是两件事。
 *
 * 没有身份（`auth.require=false` 的回环开发模式）视为管理员：
 * 那种模式本来就没有第二个使用者，拦它只会让人在本地开发时莫名 403。
 */
function requireAdmin(gate: TokenGate, routeCtx: RouteContext, what: string): void {
  const identity = gate.identify(routeCtx.req);
  if (identity === null) return;
  if (identity.role !== 'admin') {
    throw new AppError(403, 'ADMIN_ONLY', `${what}仅管理员可用`, {
      hint: '普通账户请使用「删除」（进回收站，保留期内可恢复）；彻底清除只能由管理员执行',
      yourRole: identity.role,
    });
  }
}

/** 审计用：操作者与来源地址（F13.1 要求"审计日志记录操作者"） */
function auditActor(gate: TokenGate, routeCtx: RouteContext): { actor: string; ip: string | null } {
  const identity = gate.identify(routeCtx.req);
  const actor =
    identity === null
      ? 'local'
      : identity.via === 'legacy'
        ? 'legacy'
        : (identity.username ?? identity.userId ?? 'unknown');
  const ip = routeCtx.req.socket.remoteAddress ?? null;
  return { actor, ip };
}

/**
 * 管理员是否在"治理模式"下（F13.1）。
 *
 * 只认 **jwt**：仓库令牌即使属于管理员账户，权限边界也只是它绑定的那个仓库；
 * legacy 令牌的可见范围已被降权为"未归属卡片"，给它 ALL_CARDS 等于把降权撤销。
 */
function isAdminJwt(gate: TokenGate, routeCtx: RouteContext): boolean {
  const identity = gate.identify(routeCtx.req);
  return identity !== null && identity.via === 'jwt' && identity.role === 'admin';
}

/**
 * **变更**类操作的范围：管理员可以治理所有账户的卡片，所以给 ALL_CARDS。
 * 读接口不用它 —— 见 {@link readScope}。
 */
function mutationScope(gate: TokenGate, routeCtx: RouteContext): CardScope {
  return isAdminJwt(gate, routeCtx) ? ALL_CARDS : scopeFromIdentity(gate.identify(routeCtx.req));
}

/**
 * **读**的范围：默认仍是"自己的"。
 *
 * 为什么管理员的读也要显式加 `?all=true`：管理账户不等于有理由在
 * 「我的卡片」里看到别人的角色卡。治理要看全站时用面板的治理页，
 * 那里带的是这个显式开关，而不是把默认视图悄悄放大。
 */
function readScope(gate: TokenGate, routeCtx: RouteContext): CardScope {
  if (!queryBool(routeCtx.query, 'all')) return scopeFromIdentity(gate.identify(routeCtx.req));
  if (!isAdminJwt(gate, routeCtx)) {
    throw new AppError(403, 'ADMIN_ONLY', '查看全部账户的卡片仅管理员可用');
  }
  return ALL_CARDS;
}

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
  /**
   * 注册策略的实时读取（F12）。
   *
   * 面板与 worker 是两个进程，配置只在启动时读进内存；面板改了 `auth.registerMode`
   * 之后必须让 worker 自己发现（见 config-live.ts）。`/api/auth/config` 与
   * `POST /api/auth/register` 都走这个 getter，于是客户端看到的入口与实际
   * 能否注册**永远同源** —— 不会出现"界面显示可注册、提交被拒"的错位。
   */
  const liveRegisterMode = new LiveRegisterMode(ctx.configPath, ctx.config.auth.registerMode);
  const authService = new AuthService({
    config: ctx.config,
    users,
    sessions,
    limiter,
    repos,
    liveRegisterMode: () => liveRegisterMode.current(),
  });

  /**
   * 可信反向代理与有效客户端地址（v0.1.2 追加任务 / 需求 F1.4）。
   *
   * 这个 resolver 是**所有**"按来源 IP 判定"的唯一入口：`/api/token` 的门禁、
   * 登录失败限速、TokenGate 的失败计数都走它的结果。之前各处各读
   * `req.socket.remoteAddress`，同机反代下会一起看错人（详情见
   * `server/src/net/trust-proxy.ts` 文件头）。
   */
  const proxyResolver = new TrustProxyResolver(ctx.config.trustProxy);

  /** 有效客户端 IP：登记过的代理会按 X-Forwarded-For 还原真实来源 */
  const clientIp = (context: RouteContext): string => proxyResolver.resolve(context.req).address;

  const gate = new TokenGate(ctx.config.auth.token, ctx.config.auth.publicPaths, ctx.config.auth.require, {
    jwtSecret: ctx.config.auth.jwtSecret,
    sessions,
    users,
    repoTokens,
    repos,
    // 失败计数也要按有效地址：否则反代后所有人的失败都记在代理 IP 上
    clientIp: (req) => proxyResolver.resolve(req).address,
  });

  const router = new Router();

  registerAuthRoutes(router, {
    auth: authService,
    identify: (context) => gate.identify(context.req),
    clientIp,
    // 仓库令牌入口（v0.1.3 / F5 后半）：登录界面第三个入口调的校验端点
    repoTokens,
    repos,
    users,
  });

  registerRepoRoutes(router, {
    repos,
    tokens: repoTokens,
    identify: (context) => gate.identify(context.req),
    // 治理页的归属列要显示「用户名（uid）」（v0.1.3 / F2）。
    // 这里只给只读查询：账户被删之后历史仓库仍可能存在，查不到就回 null。
    describeOwner: (ownerId) => {
      if (ownerId === '') return null;
      const owner = users.findById(ownerId);
      return owner === null ? null : { username: owner.username, uid: owner.uid };
    },
    // 跨账户仓库删除要留痕。事件写进同一张 events 表，
    // 于是它和卡片级操作在面板的治理视图里是同一条时间线。
    onAudit: (event) => {
      ctx.db.appendEvent({
        at: new Date().toISOString(),
        level: 'warn',
        action: event.action,
        cardId: null,
        detail: { repoId: event.repoId, ...event.detail },
        actor: event.actor,
        ownerId: event.ownerId,
      });
    },
  });

  /*
   * 账户注销（v0.1.3 / F3）。
   *
   * 放在 worker 而不是 supervisor 控制端口：注销要删卡片、版本、blob 与 git 仓库，
   * 这些只有数据面才有（supervisor 只打开 users 表读写）。
   * 治理页也是直连 worker 的（与 `/api/repos?all=true` 同一条路）。
   */
  registerAccountRoutes(router, {
    users,
    sessions,
    limiter,
    db: ctx.db,
    git: ctx.git,
    blobs: ctx.blobs,
    identify: (context) => gate.identify(context.req),
    clientIp,
    logger: ctx.logger,
  });

  /**
   * TLS 热重载（v0.1.3 / F4 需求第 2 条）。
   *
   * 为什么热重载要**经过 HTTP 端点**而不是 supervisor 直接改内存：
   * 监听器属于 worker 进程，控制面（supervisor）与它不共享内存。
   * 控制面保存配置后调这里，拿到同步结果 —— 只有这样面板才能
   * 如实回一句"已热更"或"已回滚，原因是…"，而不是含糊的"配置已保存"。
   *
   * 权限：管理员（legacy 全局令牌也算）。**仓库令牌一律拒绝** ——
   * 它是"某个仓库的受限授权"，改全站传输安全显然超出授权范围。
   */
  router.post('/api/tls/reload', async (_ctx) => {
    const identity = gate.identify(_ctx.req);
    if (identity !== null && identity.via === 'repo-token') {
      throw new AppError(403, 'ADMIN_ONLY', '仓库令牌不能修改传输安全设置');
    }
    if (identity !== null && identity.role !== 'admin') {
      throw new AppError(403, 'ADMIN_ONLY', '修改传输安全设置仅管理员可用');
    }
    if (ctx.tlsReload === undefined) {
      // 手工构造的 ctx（单测）没有监听器可重载：如实说，不要假装成功
      throw new AppError(503, 'INTERNAL', '当前进程没有可热重载的 TLS 运行时');
    }
    const result = await ctx.tlsReload();
    // 失败返回 409 而不是 500：这不是程序错误，是"配置与现状冲突"，
    // 调用方（supervisor）要根据这个状态码决定回滚配置文件。
    sendJson(_ctx.res, result.ok ? 200 : 409, {
      ok: result.ok,
      error: result.error,
      tls: result.state,
    });
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
    // 门禁分两层，缺一不可：
    //
    //   1. **有效 IP 必须是回环** —— 令牌不得出本机。
    //   2. **代理跳必须已登记** —— 只有 `trustProxy` 里明确写过的地址，
    //      才允许用 X-Forwarded-For 说明"真实客户端是谁"。
    //
    // 第 2 条是这一版的核心（需求 F1.4）。此前两版都错过：
    //   · v0.1.2 之前只看 `socket.remoteAddress` —— 同机反代下它对所有公网请求
    //     都是 127.0.0.1，于是任何人 curl 一下公网域名就拿到全权令牌；
    //   · 止血版"见到代理头就拒"—— 洞堵上了，但把"反代 + 真实 IP"这条正确路径
    //     也一起废掉：连本机经代理访问都取不到令牌，且没法按真实 IP 限速。
    //
    // 现在改由信任声明裁决：没登记的同机反代不再天然穿透，登记过的才放行。
    const resolved = proxyResolver.resolve(_ctx.req);
    const verdict = decideTokenGate(resolved);
    if (!verdict.allowed) {
      throw new AppError(403, 'TOKEN_LOCAL_ONLY', verdict.reason, {
        hint: verdict.hint,
        // 诊断字段：排查"到底是谁被当成了来源"时不必再猜
        effectiveAddress: resolved.address,
        socketAddress: resolved.socketAddress,
        trustProxy: proxyResolver.isEmpty ? [] : proxyResolver.stats().rules,
      });
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
      /**
       * 可信反向代理的实际生效情况（需求 F1.4 第 5 条）。
       *
       * `entries` 是配置条目数，`trustedProxies` 是**真正匹配上并改写过身份**的
       * 对端地址。后者才是"我的配置到底生效没有"的答案 —— 只看 entries 会在
       * "写了但地址写错"时给出虚假的安心。
       *
       * 不含任何凭证信息，可以给任何已鉴权的调用方看。
       */
      proxy: proxyResolver.stats(),
    });
  });

  router.get('/api/events', (_ctx) => {
    const limit = queryInt(_ctx.query, 'limit', 50, 1, 500);
    sendJson(_ctx.res, 200, {
      // 治理页要能看全站时间线（含跨账户删除），所以这条读也走 readScope
      items: ctx.cards.events(limit, readScope(gate, _ctx)),
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
      scope: readScope(gate, _ctx),
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
      scope: readScope(gate, _ctx),
    });
    sendJson(_ctx.res, 200, card);
  });

  /**
   * 软删除（F13.2）。`?hard=true` 保留为**兼容写法**，但语义已改为 purge
   * 且仅管理员可用 —— 以前任何有写权限的凭证都能物理删除，那是保留期的漏洞。
   */
  router.delete('/api/cards/:id', async (_ctx) => {
    assertPermission(gate, _ctx, 'delete');
    // 变更类操作走 mutationScope：管理员治理时是 ALL_CARDS（F13.1）。
    // 第一版这里写的是 scopeFromIdentity —— 于是管理员删别人的卡得到 404，
    // 而权限矩阵回归正是靠这一格抓到的（补丁式替换只改了 `scope: ...` 字面量，
    // 漏掉了这种先存进局部变量的写法）。
    const scope = mutationScope(gate, _ctx);
    const audit = auditActor(gate, _ctx);
    if (queryBool(_ctx.query, 'hard')) {
      requireAdmin(gate, _ctx, '彻底清除');
      const purged = await ctx.cards.purge(_ctx.params['id']!, { scope, ...audit });
      sendJson(_ctx.res, 200, { deleted: true, hard: true, ...purged });
      return;
    }
    const result = await ctx.cards.delete(_ctx.params['id']!, { scope, ...audit });
    sendJson(_ctx.res, 200, { deleted: true, ...result });
  });

  /** 从回收站恢复（F13.2） */
  router.post('/api/cards/:id/restore', async (_ctx) => {
    assertPermission(gate, _ctx, 'delete');
    const result = await ctx.cards.restore(_ctx.params['id']!, {
      scope: mutationScope(gate, _ctx),
      ...auditActor(gate, _ctx),
    });
    sendJson(_ctx.res, 200, result);
  });

  /** 彻底清除（F13.2）：仅管理员，绕过保留期 */
  router.post('/api/cards/:id/purge', async (_ctx) => {
    assertPermission(gate, _ctx, 'delete');
    requireAdmin(gate, _ctx, '彻底清除');
    const result = await ctx.cards.purge(_ctx.params['id']!, {
      scope: mutationScope(gate, _ctx),
      ...auditActor(gate, _ctx),
    });
    sendJson(_ctx.res, 200, result);
  });

  /** 清除某版本内容（F13.3）：元数据保留，正文与 sha256 置空 */
  router.post('/api/cards/:id/versions/:seq/prune', async (_ctx) => {
    assertPermission(gate, _ctx, 'write');
    const seq = Number(_ctx.params['seq']);
    if (!Number.isInteger(seq) || seq < 1) {
      throw new AppError(400, 'BAD_REQUEST', 'seq 必须是正整数版本序号');
    }
    const result = await ctx.cards.prune(_ctx.params['id']!, seq, {
      scope: mutationScope(gate, _ctx),
      ...auditActor(gate, _ctx),
    });
    sendJson(_ctx.res, 200, result);
  });

  /** 移动卡片到另一个仓库（F13.4）：改归属，不动 updated_at */
  router.post('/api/cards/:id/move', async (_ctx) => {
    assertPermission(gate, _ctx, 'write');
    const body = parseJsonBody<Record<string, unknown>>(_ctx.body, {});
    const repoId = typeof body['repo'] === 'string' ? body['repo'].trim() : '';
    const result = await ctx.cards.move(_ctx.params['id']!, repoId, {
      scope: mutationScope(gate, _ctx),
      reason: typeof body['reason'] === 'string' ? body['reason'] : undefined,
      // 跨账户移动只允许管理员的 jwt：仓库令牌的边界就是它绑定的仓库，
      // legacy 的可见范围已被降权，两者都不该借这一步扩大范围。
      allowCrossOwner: isAdminJwt(gate, _ctx),
      ...auditActor(gate, _ctx),
    });
    sendJson(_ctx.res, 200, result);
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
      scope: readScope(gate, _ctx),
    });
    sendJson(_ctx.res, 200, { total: result.total, limit, offset, items: result.items });
  });

  router.post('/api/cards/:id/versions', async (_ctx) => {
    assertPermission(gate, _ctx, 'write');
    const bytes = requireCardBody(_ctx);
    const version = await ctx.cards.addVersion(_ctx.params['id']!, bytes, {
      ...writeOptionsFrom(_ctx.query, ctx),
      scope: readScope(gate, _ctx),
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
      scope: readScope(gate, _ctx),
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
        scope: readScope(gate, _ctx),
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
        (pathname === '/api/auth/login' ||
          pathname === '/api/auth/register' ||
          pathname === '/api/auth/refresh' ||
          // v0.1.3 / F5 后半：仓库令牌校验。调用方此时正拿着一把尚未被认可的
          // 令牌、没有别的凭证 —— 它本身就是鉴权入口，不能过 TokenGate。
          pathname === '/api/auth/repo-token');
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
