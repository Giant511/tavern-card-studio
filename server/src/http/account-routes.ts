/**
 * 账户注销的 HTTP 入口（v0.1.3 / F3）。
 *
 * ## 两条路径
 *
 *   POST   /api/account/delete     自助注销（账户登录 + 二次确认）
 *   DELETE /api/accounts/:id       管理员注销（管理员 JWT）
 *   GET    /api/audit/account-purges  注销审计（管理员）
 *
 * ## 为什么自助路径不接收「目标账户」参数
 *
 * 它注销的永远是**调用者自己**（`caller.userId`），没有 `:id` 可传。
 * 这不是图省事，而是需求 7「错误响应不泄露目标账户存在性」的直接落实：
 * 没有目标参数就没有"这个 id 存不存在"的探针面。
 *
 * 管理员路径则不同 —— 它本来就在特权上下文里（能看到全部账户列表），
 * 所以那里回 404 是诚实的，不是泄露。
 *
 * ## 二次确认的两道闸
 *
 * 需求要求"输入用户名（或密码）确认，非单点确定"。这里两道都在服务端：
 *
 *   · **用户名必填**且必须与账户当前用户名一致（大小写不敏感，与唯一性口径一致）；
 *   · **密码可选**，但一旦提供就必须正确 —— 传了错密码却放行，
 *     等于告诉用户"这道闸是假的"，比不设更糟。
 *
 * 客户端的输入框只是体验，服务端这道才是判据。只靠客户端等于没设闸。
 */

import type { IncomingMessage } from 'node:http';

import { AppError } from '../errors.js';
import { sendJson } from './responses.js';
import type { RouteContext } from './router.js';
import type { AuthContext } from './auth.js';
import { verifyPassword } from '../auth/password.js';
import { normalizeUsername, type UserStore } from '../storage/users.js';
import type { SessionStore } from '../auth/sessions.js';
import type { LoginLimiter } from '../auth/login-limit.js';
import type { Db } from '../storage/db.js';
import type { GitStore } from '../storage/git-store.js';
import type { BlobStore } from '../storage/blobs.js';
import { AUDIT_RETENTION_DAYS, PurgeError, purgeAccount, type PurgeAccountResult } from '../account/purge.js';

export interface AccountRouteDeps {
  users: UserStore;
  sessions: SessionStore;
  limiter: LoginLimiter;
  db: Db;
  git: GitStore;
  blobs: BlobStore;
  identify: (ctx: RouteContext) => AuthContext | null;
  clientIp: (ctx: RouteContext) => string;
  logger: { warn: (action: string, detail?: Record<string, unknown>) => void };
  now?: () => Date;
}

type Registrar = {
  get: (path: string, handler: (ctx: RouteContext) => Promise<void> | void) => unknown;
  post: (path: string, handler: (ctx: RouteContext) => Promise<void> | void) => unknown;
  delete: (path: string, handler: (ctx: RouteContext) => Promise<void> | void) => unknown;
};

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
 * 取「账户登录」身份。
 *
 * 注销是账户级的不可逆操作，只认账户 JWT：
 *   · **仓库令牌**不行 —— 它是"某个仓库的受限授权"，不该有删账户的权力；
 *     否则一把泄露的 CI 令牌就能把主人整个账户抹掉。
 *   · **legacy 全局令牌**也不行 —— 它没有账户身份（userId 为 null），
 *     谈不上"注销谁"。运维请用管理员账户。
 */
function requireAccountJwt(ctx: RouteContext, deps: AccountRouteDeps): AuthContext & { userId: string } {
  const caller = deps.identify(ctx);
  if (caller === null) throw new AppError(401, 'UNAUTHORIZED', '需要账户登录');
  if (caller.via === 'repo-token') {
    throw new AppError(403, 'FORBIDDEN', '仓库令牌不能注销账户；请用账户登录后在「设置 → 账户」操作');
  }
  if (caller.via !== 'jwt' || caller.userId === null) {
    throw new AppError(403, 'FORBIDDEN', '全局访问令牌没有账户身份，不能注销账户；请用账户登录');
  }
  return caller as AuthContext & { userId: string };
}

/** 把 PurgeError 翻成 HTTP；其它错误原样抛 */
function rethrowPurge(error: unknown): never {
  if (error instanceof PurgeError) {
    const code = error.code === 'NOT_FOUND' ? 'NOT_FOUND' : error.code === 'LAST_ADMIN' ? 'ADMIN_ONLY' : 'FORBIDDEN';
    throw new AppError(error.status, code, error.message, { purgeCode: error.code });
  }
  throw error;
}

/** 审计事件里的操作者标识：`用户名 (uid)`，uid 缺失时退回内部 id 前 8 位 */
function actorLabel(user: { username: string; uid: string; id: string }): string {
  const uid = user.uid !== '' ? user.uid : user.id.slice(0, 8);
  return `${user.username} (${uid})`;
}

/** 回执：只带"删了什么"，不带内部 id 之外的敏感信息 */
function purgeReceipt(result: PurgeAccountResult) {
  return {
    purged: true,
    uid: result.uid,
    username: result.username,
    path: result.path,
    counts: result.counts,
    // 文件系统删不掉的东西要如实回执：说"彻底删除了"但磁盘上还有仓库目录，
    // 是最危险的一种谎（用户会以为自己已经把敏感内容清掉了）
    warnings: result.warnings,
  };
}

/**
 * 「这个账户名下有多少东西」—— 注销确认弹窗要显示的实际数量。
 *
 * 抽成函数而不是两处各写一遍：客户端看**自己**的（`/api/account/summary`）、
 * 管理员看**别人**的（`/api/accounts/:id/summary`），两者必须与
 * `purgeAccount` 删的是同一批东西；分开写必然漂移，而漂移的后果是
 * 用户看到的"将删除 3 张卡"与实际删掉的 5 张不符。
 */
function summarizeAccount(deps: AccountRouteDeps, userId: string) {
  const countOf = (table: string, where: string): number =>
    (deps.db.handle.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(userId) as { n: number }).n;

  return {
    cards: countOf('cards', 'owner_id = ?'),
    versions: (
      deps.db.handle
        .prepare('SELECT COUNT(*) AS n FROM versions WHERE card_id IN (SELECT id FROM cards WHERE owner_id = ?)')
        .get(userId) as { n: number }
    ).n,
    repos: countOf('repos', 'owner_id = ?'),
    repoTokens: countOf('repo_tokens', 'owner_id = ?'),
    sessions: countOf('sessions', 'user_id = ?'),
  };
}

export function registerAccountRoutes(router: Registrar, deps: AccountRouteDeps): void {
  /**
   * 注销前的"将要删除什么"（需求 1 的二次确认要显示实际数量）。
   *
   * 为什么服务端算而不是前端拼：
   *   · 前端要拼 5 个请求（卡片 total / stats / repos / 每仓库 tokens / 会话），
   *     而**任何一个失败就会让数字变小** —— 显示"将删除 0 张卡"是最危险的谎；
   *   · 更要紧的是口径：这里算的必须与 `purgeAccount` 删的是同一批东西，
   *     否则用户看到的和实际发生的不一致。所以两者共用 `summarizeAccount`。
   */
  router.get('/api/account/summary', (ctx) => {
    const caller = requireAccountJwt(ctx, deps);
    const target = deps.users.findById(caller.userId);
    if (target === null) throw new AppError(401, 'UNAUTHORIZED', '账户不存在或已删除');
    sendJson(ctx.res, 200, {
      username: target.username,
      uid: target.uid,
      ...summarizeAccount(deps, target.id),
    });
  });

  /**
   * 管理员版：看**别人**的统计（治理页二次确认用）。
   *
   * 与上面那段是同一个 `summarizeAccount`，只是目标不同。
   * 这也解释了为什么不给 `/api/account/summary` 加一个 `?userId=` 参数：
   * 那样一个端点会同时有两种权限语义（"只能看自己" / "管理员能看别人"），
   * 而权限判断散在参数里最容易漏 —— 分开两个端点，各自的守卫一眼可查。
   */
  router.get('/api/accounts/:id/summary', (ctx) => {
    const caller = requireAccountJwt(ctx, deps);
    if (caller.role !== 'admin') {
      throw new AppError(403, 'ADMIN_ONLY', '查看他人账户的数据统计仅管理员可用');
    }
    const target = deps.users.findById(ctx.params['id'] ?? '');
    // 管理员路径已是特权上下文（能看到全部账户列表），404 在此不构成泄露
    if (target === null) throw new AppError(404, 'NOT_FOUND', '账户不存在');
    sendJson(ctx.res, 200, {
      username: target.username,
      uid: target.uid,
      ...summarizeAccount(deps, target.id),
    });
  });

  /**
   * 自助注销（需求 1）。
   *
   * 校验顺序刻意是「身份 → 目标 → 确认 → 密码」：
   * 先确认是账户登录（否则后面全是空谈），再取自己那一行，
   * 再比用户名，最后才跑 Argon2id。密码校验最贵，放最后。
   */
  router.post('/api/account/delete', async (ctx) => {
    const caller = requireAccountJwt(ctx, deps);
    const target = deps.users.findById(caller.userId);
    if (target === null) {
      // 能通过 TokenGate 却查不到用户：库被别人改过。如实说，不装成"成功"。
      throw new AppError(401, 'UNAUTHORIZED', '账户不存在或已删除');
    }

    const body = bodyJson(ctx);
    const confirmUsername = str(body, 'confirmUsername').trim();
    if (confirmUsername === '') {
      throw new AppError(400, 'BAD_REQUEST', '需要输入用户名确认：这是不可恢复的操作');
    }
    // 大小写不敏感（与 users.username_key 的唯一性口径一致）：
    // 若这里改成精确匹配，用户手打时大小写差一个字母就被拒，
    // 而账户唯一性本来就不区分大小写 —— 两道口径不一致会让人反复试。
    if (normalizeUsername(confirmUsername) !== normalizeUsername(target.username)) {
      throw new AppError(400, 'BAD_REQUEST', '输入的用户名与当前账户不一致', {
        hint: '这一步是为了防止误操作：请输入完整的账户用户名',
      });
    }

    /*
     * 密码是**可选加强**，但给了就必须对。
     *
     * 为什么不做成必填：需求写的是「输入用户名（或密码）确认」，
     * 用户名已经满足"非单点确定"这条硬要求；强制再输密码会让
     * "我只想删掉这个账户"变成两道口令，收益不抵摩擦。
     * 但一旦传了密码却不能放松 —— 错误就拒，否则这道闸是装饰品。
     */
    const password = str(body, 'password');
    if (password !== '') {
      const ok = await verifyPassword(target.password_hash, password);
      if (!ok) {
        throw new AppError(400, 'BAD_REQUEST', '密码不正确');
      }
    }

    try {
      const result = purgeAccount(
        {
          targetUserId: target.id,
          actorUserId: caller.userId,
          actorLabel: actorLabel(target),
          path: 'self',
          ip: deps.clientIp(ctx),
          now: deps.now,
        },
        {
          db: deps.db,
          users: deps.users,
          sessions: deps.sessions,
          limiter: deps.limiter,
          git: deps.git,
          blobs: deps.blobs,
          logger: deps.logger,
        },
      );
      deps.logger.warn('account.purge.self', { userId: result.userId, uid: result.uid });
      sendJson(ctx.res, 200, purgeReceipt(result));
    } catch (error) {
      rethrowPurge(error);
    }
  });

  /**
   * 管理员注销（需求 2）。
   *
   * 「管理员不能注销自己」只在这条路径上生效（`purgeAccount` 里判）。
   * 自助路径本来就要求二次确认，管理员想注销自己走那边即可。
   */
  router.delete('/api/accounts/:id', async (ctx) => {
    const caller = requireAccountJwt(ctx, deps);
    if (caller.role !== 'admin') {
      throw new AppError(403, 'ADMIN_ONLY', '注销他人账户仅管理员可用');
    }

    const targetId = ctx.params['id'] ?? '';
    const actor = deps.users.findById(caller.userId);
    if (actor === null) throw new AppError(401, 'UNAUTHORIZED', '操作者账户不存在');

    try {
      const result = purgeAccount(
        {
          targetUserId: targetId,
          actorUserId: caller.userId,
          actorLabel: actorLabel(actor),
          path: 'admin',
          ip: deps.clientIp(ctx),
          now: deps.now,
        },
        {
          db: deps.db,
          users: deps.users,
          sessions: deps.sessions,
          limiter: deps.limiter,
          git: deps.git,
          blobs: deps.blobs,
          logger: deps.logger,
        },
      );
      deps.logger.warn('account.purge.admin', {
        targetUserId: result.userId,
        targetUid: result.uid,
        actor: actorLabel(actor),
      });
      sendJson(ctx.res, 200, purgeReceipt(result));
    } catch (error) {
      rethrowPurge(error);
    }
  });

  /**
   * 注销审计（需求 3：治理页可见）。
   *
   * 为什么单独开一个端点，而不是让治理页拉 `/api/events?all=true` 再在前端筛：
   * 分页 + 前端过滤会漏 —— 最近 50 条里可能一条注销事件都没有，
   * 于是"查过了，没有"这种结论是假的。这里在 SQL 里筛，分页边界才对。
   */
  router.get('/api/audit/account-purges', (ctx) => {
    const caller = requireAccountJwt(ctx, deps);
    if (caller.role !== 'admin') {
      throw new AppError(403, 'ADMIN_ONLY', '注销审计仅管理员可见');
    }
    const raw = Number(ctx.query.get('limit') ?? 50);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 200) : 50;

    const rows = deps.db.handle
      .prepare(
        `SELECT id, at, action, actor, ip, owner_id, detail FROM events
         WHERE action LIKE 'account.purge.%'
         ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number;
      at: string;
      action: string;
      actor: string | null;
      ip: string | null;
      owner_id: string | null;
      detail: string;
    }>;

    sendJson(ctx.res, 200, {
      items: rows.map((row) => {
        let detail: Record<string, unknown> = {};
        try {
          detail = JSON.parse(row.detail) as Record<string, unknown>;
        } catch {
          detail = {};
        }
        return {
          id: row.id,
          at: row.at,
          action: row.action,
          // 操作者（谁执行了注销）与目标（被注销的账户）分列：
          // 需求要求审计含「操作者、目标 uid、动作、时间、IP」，五样缺一不可
          actor: row.actor,
          targetUid: typeof detail['targetUid'] === 'string' ? detail['targetUid'] : '',
          targetUsername: typeof detail['targetUsername'] === 'string' ? detail['targetUsername'] : '',
          path: typeof detail['path'] === 'string' ? detail['path'] : '',
          counts: detail['counts'] ?? null,
          ip: row.ip,
        };
      }),
      /** 保留期（天）—— 治理页拿它显示"多久后清理"，避免文档与代码两套口径 */
      retentionDays: AUDIT_RETENTION_DAYS,
    });
  });
}
