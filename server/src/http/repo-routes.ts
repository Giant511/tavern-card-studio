/**
 * 仓库与仓库令牌的管理路由（T10.6）。
 *
 * 端点：
 *   GET    /api/repos                    列出自己的仓库
 *   POST   /api/repos                    新建仓库
 *   PATCH  /api/repos/:id                改名 / 改描述
 *   DELETE /api/repos/:id                软删；非空必须带 {transferTo}（T10.19）；管理员可跨账户
 *   POST   /api/repos/:id/default        设为默认
 *
 *   GET    /api/repos/:id/tokens          列出该仓库的令牌（只给前缀）
 *   POST   /api/repos/:id/tokens          签发令牌（**原文只在这里出现一次**）
 *   DELETE /api/tokens/:id                吊销令牌
 *   PATCH  /api/tokens/:id                改权限范围
 *
 * 两条贯穿全文件的规矩：
 *
 *   1. **令牌原文只在签发响应里出现一次**，之后列表只给 `token_prefix`。
 *      服务端也只存 sha256 —— 它自己也还原不出来，这是设计而非疏漏。
 *   2. 所有写操作都要 `ownerId` 匹配。仓库 id 是 uuid，但**不能靠"猜不到"当权限**
 *      （日志、截图、分享链接都会泄露 id），必须在服务端比对归属。
 */

import { AppError } from '../errors.js';
import { sendJson } from './responses.js';
import type { RouteContext } from './router.js';
import type { AuthContext } from './auth.js';
import {
  ALL_SCOPES,
  RepoExistsError,
  type RepoStore,
  type TokenScope,
  type TokenStore,
} from '../storage/repos.js';

export interface RepoRouteDeps {
  repos: RepoStore;
  tokens: TokenStore;
  identify: (ctx: RouteContext) => AuthContext | null;
  now?: () => Date;
  /**
   * 审计回调（T10.19）。仓库层的跨账户操作需要落到 `events` 表，
   * 但仓库路由不持有 Db —— 由装配处注入，和卡片服务共用同一个事件流。
   */
  onAudit?: (event: {
    action: string;
    repoId: string;
    ownerId: string;
    actor: string;
    detail: Record<string, unknown>;
  }) => void;
}

function bodyJson(ctx: RouteContext): Record<string, unknown> {
  if (ctx.body.length === 0) return {};
  try {
    const parsed = JSON.parse(ctx.body.toString('utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new AppError(400, 'BAD_REQUEST', '请求体不是合法 JSON');
  }
}

function str(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

/**
 * 取当前账户。
 *
 * legacy 全局 token 没有账户身份 —— 它不能管理"某个账户的仓库"，
 * 只能通过 CLI 操作。这里明确拒绝而不是"替它挑一个账户"：
 * 挑错了会静默写到别人名下。
 */
function requireAccount(ctx: RouteContext, deps: RepoRouteDeps): AuthContext {
  const caller = deps.identify(ctx);
  if (!caller) throw new AppError(401, 'UNAUTHORIZED', '需要登录');
  if (caller.userId === null) {
    throw new AppError(
      403,
      'FORBIDDEN',
      '全局访问令牌没有账户身份，不能管理仓库。请用账户登录（获取 access token）后操作',
    );
  }
  return caller;
}

/**
 * 仓库令牌不能管理仓库/令牌本身。
 *
 * 理由：仓库令牌是"给某个仓库的受限凭证"，如果能用它再签发令牌，
 * 一次泄露就能自我续期（签一把永不过期的），吊销也变得没有意义。
 * 这是最小权限原则的直接推论。
 */
function rejectRepoToken(caller: AuthContext): void {
  if (caller.via === 'repo-token') {
    throw new AppError(
      403,
      'FORBIDDEN',
      '仓库令牌不能管理仓库或令牌；请用账户登录后的 access token 操作',
    );
  }
}

function parseScopeList(value: unknown): TokenScope[] {
  if (!Array.isArray(value)) return [];
  const out: TokenScope[] = [];
  for (const item of value) {
    if (typeof item === 'string' && (ALL_SCOPES as readonly string[]).includes(item)) {
      out.push(item as TokenScope);
    }
  }
  return [...new Set(out)];
}

/**
 * 只声明本模块用到的路由方法。
 *
 * 不用 `Partial`/可选方法：那样"忘了实现 patch"会变成静默不注册，
 * 接口 404 而代码看起来正常。这里让编译器盯着。
 */
export type Registrar = {
  get: (path: string, handler: (ctx: RouteContext) => Promise<void> | void) => unknown;
  post: (path: string, handler: (ctx: RouteContext) => Promise<void> | void) => unknown;
  patch: (path: string, handler: (ctx: RouteContext) => Promise<void> | void) => unknown;
  delete: (path: string, handler: (ctx: RouteContext) => Promise<void> | void) => unknown;
};

export function registerRepoRoutes(router: Registrar, deps: RepoRouteDeps): void {
  const now = deps.now ?? (() => new Date());

  // ── 仓库 ──────────────────────────────────────────────────

  router.get('/api/repos', (ctx) => {
    const caller = requireAccount(ctx, deps);
    // 仓库令牌**不能**列仓库（T10.10 交叉剧本发现）：
    // 它绑定的那一个仓库之外的东西不该被它看见（同账户的兄弟仓库名/id 也是）。
    // 更现实的问题在客户端：`GET /api/repos` 一旦成功，同步面板就会渲染仓库下拉，
    // 而上传时服务端忽略 query.repo（令牌绑定优先）—— 用户选了个"改了不生效"的下拉。
    // 拒绝后客户端按"拿不到列表"整行隐藏，与决策 #51 的约定一致。
    rejectRepoToken(caller);
    /*
     * 治理页要按账户分组看全部仓库（T10.20），所以支持 `?all=true`。
     * 只认管理员 jwt：仓库令牌与 legacy 都不行 —— 前者边界是单个仓库，
     * 后者的可见范围已被降权为"未归属"，给它全站列表等于把降权撤销。
     */
    const all = ctx.query.get('all') === 'true' || ctx.query.get('all') === '1';
    if (all) {
      if (caller.via !== 'jwt' || caller.role !== 'admin') {
        throw new AppError(403, 'ADMIN_ONLY', '查看全部账户的仓库仅管理员可用');
      }
      const rows = deps.repos.listAll();
      sendJson(ctx.res, 200, {
        items: rows.map((row) => ({ ...deps.repos.toPublic(row), ownerId: row.owner_id })),
      });
      return;
    }
    const rows = deps.repos.list(caller.userId!);
    sendJson(ctx.res, 200, { items: rows.map((row) => deps.repos.toPublic(row)) });
  });

  router.post('/api/repos', (ctx) => {
    const caller = requireAccount(ctx, deps);
    rejectRepoToken(caller);
    const body = bodyJson(ctx);
    try {
      const row = deps.repos.create({
        ownerId: caller.userId!,
        name: str(body, 'name'),
        description: str(body, 'description'),
        now: now().toISOString(),
      });
      sendJson(ctx.res, 201, deps.repos.toPublic(row));
    } catch (error) {
      if (error instanceof RepoExistsError) throw new AppError(409, 'CONFLICT', error.message);
      if (error instanceof Error) throw new AppError(400, 'BAD_REQUEST', error.message);
      throw error;
    }
  });

  router.patch('/api/repos/:id', (ctx) => {
    const caller = requireAccount(ctx, deps);
    rejectRepoToken(caller);
    const repo = deps.repos.findById(ctx.params['id']!);
    // 归属不匹配时返回 404 而不是 403：告诉攻击者"这个 id 存在但不是你的"
    // 等于给了一个枚举仓库 id 的接口
    if (!repo || repo.owner_id !== caller.userId) throw new AppError(404, 'NOT_FOUND', '仓库不存在');
    const body = bodyJson(ctx);
    try {
      if (str(body, 'name') !== '') deps.repos.rename(repo.id, str(body, 'name'), now().toISOString());
      const updated = deps.repos.findById(repo.id);
      sendJson(ctx.res, 200, deps.repos.toPublic(updated ?? repo));
    } catch (error) {
      if (error instanceof RepoExistsError) throw new AppError(409, 'CONFLICT', error.message);
      if (error instanceof Error) throw new AppError(400, 'BAD_REQUEST', error.message);
      throw error;
    }
  });

  /**
   * 删除仓库（F13.4 / T10.19）。
   *
   * - 空仓库：直接删；
   * - 非空：**必须**带 `transferTo`，卡批量转移后删除（一个事务）；
   * - 默认仓库：拒绝，并指向「转移默认」（`POST /api/repos/:id/default`）；
   * - 管理员：可以删**别的账户**的仓库（`owner_id` 不匹配时要求 admin），
   *   这种跨账户操作会写一条带 actor 的审计事件。
   */
  router.delete('/api/repos/:id', (ctx) => {
    const caller = requireAccount(ctx, deps);
    rejectRepoToken(caller);
    const repo = deps.repos.findById(ctx.params['id']!);
    if (!repo) throw new AppError(404, 'NOT_FOUND', '仓库不存在');

    const isCrossAccount = repo.owner_id !== caller.userId;
    if (isCrossAccount && caller.role !== 'admin') {
      // 归属不匹配一律 404（docs/29 §2）：403 会确认"这个 id 确实是个仓库"
      throw new AppError(404, 'NOT_FOUND', '仓库不存在');
    }

    const body = bodyJson(ctx);
    const transferToRaw = body['transferTo'];
    // 体里的优先；没有就看 query —— 有些反向代理会丢掉 DELETE 的请求体，
    // 只认体的话那些部署下"带 transferTo 删除"永远走不通。
    const fromBody = typeof transferToRaw === 'string' && transferToRaw.trim() !== '' ? transferToRaw.trim() : '';
    const fromQuery = (ctx.query.get('transferTo') ?? '').trim();
    const transferTo = fromBody !== '' ? fromBody : fromQuery !== '' ? fromQuery : null;
    const reason = str(body, 'reason') || (ctx.query.get('reason') ?? '');

    try {
      const result = deps.repos.removeWithTransfer(repo.id, transferTo, now().toISOString());
      if (isCrossAccount) {
        // 跨账户删除是管理员的高危动作，必须留痕（谁、对谁的仓库、为什么）
        deps.onAudit?.({
          action: 'repo.delete.cross-account',
          repoId: repo.id,
          ownerId: repo.owner_id,
          actor: caller.username ?? caller.userId ?? 'admin',
          detail: { name: repo.name, movedCards: result.movedCards, reason },
        });
      }
      sendJson(ctx.res, 200, {
        deleted: true,
        id: repo.id,
        movedCards: result.movedCards,
        revokedTokens: result.revokedTokens,
        transferredTo: transferTo,
      });
    } catch (error) {
      if (error instanceof Error) throw new AppError(409, 'CONFLICT', error.message);
      throw error;
    }
  });

  router.post('/api/repos/:id/default', (ctx) => {
    const caller = requireAccount(ctx, deps);
    rejectRepoToken(caller);
    const repo = deps.repos.findById(ctx.params['id']!);
    if (!repo || repo.owner_id !== caller.userId) throw new AppError(404, 'NOT_FOUND', '仓库不存在');
    deps.repos.setDefault(repo.id, now().toISOString());
    const updated = deps.repos.findById(repo.id);
    sendJson(ctx.res, 200, deps.repos.toPublic(updated ?? repo));
  });

  // ── 令牌 ──────────────────────────────────────────────────

  router.get('/api/repos/:id/tokens', (ctx) => {
    const caller = requireAccount(ctx, deps);
    rejectRepoToken(caller);
    const repo = deps.repos.findById(ctx.params['id']!);
    if (!repo || repo.owner_id !== caller.userId) throw new AppError(404, 'NOT_FOUND', '仓库不存在');
    const rows = deps.tokens.listByRepo(repo.id);
    sendJson(ctx.res, 200, {
      items: rows.map((row) => deps.tokens.toPublic(row, repo.name, now())),
      // 明确告诉调用方：列表里**没有**原文，别指望之后再取
      note: '令牌原文只在签发时显示一次；此处只返回前缀。若已丢失，请吊销后重新签发。',
    });
  });

  router.post('/api/repos/:id/tokens', (ctx) => {
    const caller = requireAccount(ctx, deps);
    rejectRepoToken(caller);
    const repo = deps.repos.findById(ctx.params['id']!);
    if (!repo || repo.owner_id !== caller.userId) throw new AppError(404, 'NOT_FOUND', '仓库不存在');

    const body = bodyJson(ctx);
    const scopes = parseScopeList(body['scopes']);
    if (scopes.length === 0) {
      throw new AppError(
        400,
        'BAD_REQUEST',
        `scopes 必须是非空数组，可选值：${ALL_SCOPES.join(' / ')}`,
      );
    }

    // 过期时间：允许 null（永不过期）或 ISO 字符串；**不允许过去的时刻**
    // —— 那会签发一把签完就失效的令牌，用户会以为服务端坏了
    const rawExpires = body['expiresAt'];
    let expiresAt: string | null = null;
    if (typeof rawExpires === 'string' && rawExpires !== '') {
      const parsed = new Date(rawExpires);
      if (Number.isNaN(parsed.getTime())) {
        throw new AppError(400, 'BAD_REQUEST', 'expiresAt 不是合法时间（用 ISO 8601，如 2027-01-01T00:00:00Z）');
      }
      if (parsed.getTime() <= now().getTime()) {
        throw new AppError(400, 'BAD_REQUEST', 'expiresAt 必须是将来时间：签发一把已过期的令牌没有意义');
      }
      expiresAt = parsed.toISOString();
    }

    const { row, raw } = deps.tokens.issue({
      ownerId: caller.userId!,
      repoId: repo.id,
      name: str(body, 'name'),
      scopes,
      expiresAt,
      now: now().toISOString(),
    });

    // 201 + 原文。这是**唯一**一次能拿到 raw 的机会，响应里显式提醒。
    sendJson(ctx.res, 201, {
      token: raw,
      tokenPrefix: row.token_prefix,
      name: row.name,
      repoId: repo.id,
      repoName: repo.name,
      scopes: parseScopeList(scopes),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      note: '请立刻保存：令牌原文只显示这一次，之后无法再查看（服务端只存哈希）。丢失后请吊销并重新签发。',
    });
  });

  router.delete('/api/tokens/:id', (ctx) => {
    const caller = requireAccount(ctx, deps);
    rejectRepoToken(caller);
    const row = deps.tokens.findById(ctx.params['id']!);
    if (!row || row.owner_id !== caller.userId) throw new AppError(404, 'NOT_FOUND', '令牌不存在');
    const changed = deps.tokens.revoke(row.id, 'manual', now().toISOString());
    sendJson(ctx.res, 200, { revoked: changed, id: row.id });
  });

  router.patch('/api/tokens/:id', (ctx) => {
    const caller = requireAccount(ctx, deps);
    rejectRepoToken(caller);
    const row = deps.tokens.findById(ctx.params['id']!);
    if (!row || row.owner_id !== caller.userId) throw new AppError(404, 'NOT_FOUND', '令牌不存在');

    const body = bodyJson(ctx);
    const scopes = parseScopeList(body['scopes']);
    if (scopes.length === 0) throw new AppError(400, 'BAD_REQUEST', 'scopes 必须是非空数组');
    try {
      deps.tokens.setScopes(row.id, scopes);
    } catch (error) {
      if (error instanceof Error) throw new AppError(400, 'BAD_REQUEST', error.message);
      throw error;
    }
    const updated = deps.tokens.findById(row.id)!;
    const repo = deps.repos.findById(updated.repo_id);
    sendJson(ctx.res, 200, deps.tokens.toPublic(updated, repo?.name ?? '', now()));
  });
}
