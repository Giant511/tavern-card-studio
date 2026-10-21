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
import { API_VERSION, SERVER_VERSION, configSummary, type ServerContext } from '../context.js';
import { readRawBody, parseJsonBody } from './body.js';
import { TokenGate } from './auth.js';
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

export function createWorkerHandler(ctx: ServerContext): (req: IncomingMessage, res: ServerResponse) => void {
  const gate = new TokenGate(ctx.config.auth.token, ctx.config.auth.publicPaths, ctx.config.auth.require);
  const router = new Router();

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

  router.get('/api/auth/verify', (_ctx) => {
    sendJson(_ctx.res, 200, {
      ok: true,
      auth: { mode: 'bearer-token', required: ctx.config.auth.require },
      server: { version: SERVER_VERSION, apiVersion: API_VERSION, pid: process.pid },
    });
  });

  router.get('/api/stats', (_ctx) => {
    const stats = ctx.cards.stats();
    sendJson(_ctx.res, 200, {
      ...stats,
      uptimeMs: Date.now() - ctx.startedAt,
      version: SERVER_VERSION,
      config: configSummary(ctx.config),
      rules: ctx.registry.loadErrors(),
    });
  });

  router.get('/api/events', (_ctx) => {
    const limit = queryInt(_ctx.query, 'limit', 50, 1, 500);
    sendJson(_ctx.res, 200, { items: ctx.cards.events(limit) });
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
    const limit = queryInt(_ctx.query, 'limit', 50, 1, 500);
    const offset = queryInt(_ctx.query, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
    const result = ctx.cards.list({
      q: optional(_ctx.query, 'q'),
      limit,
      offset,
      includeDeleted: queryBool(_ctx.query, 'includeDeleted'),
    });
    sendJson(_ctx.res, 200, { total: result.total, limit, offset, items: result.items });
  });

  router.post('/api/cards', async (_ctx) => {
    const bytes = requireCardBody(_ctx);
    const result = await ctx.cards.create(bytes, writeOptionsFrom(_ctx.query, ctx));
    sendJson(_ctx.res, 201, result, {
      Location: `/api/cards/${result.card.id}`,
      'X-TCS-Card-Id': result.card.id,
    });
  });

  router.get('/api/cards/:id', (_ctx) => {
    const card = ctx.cards.get(_ctx.params['id']!, { includeDeleted: queryBool(_ctx.query, 'includeDeleted') });
    sendJson(_ctx.res, 200, card);
  });

  router.delete('/api/cards/:id', async (_ctx) => {
    const result = await ctx.cards.delete(_ctx.params['id']!, { hard: queryBool(_ctx.query, 'hard') });
    sendJson(_ctx.res, 200, { deleted: true, ...result });
  });

  router.get('/api/cards/:id/raw', (_ctx) => {
    const { bytes, version } = ctx.cards.readBytes(_ctx.params['id']!, optional(_ctx.query, 'version') ?? optional(_ctx.query, 'rev'));
    sendRaw(
      _ctx.res,
      200,
      bytes,
      rawHeaders(_ctx, version.blob_sha256, version.byte_size, `${_ctx.params['id']}-v${version.seq}.json`),
    );
  });

  // ── T5.2 版本 ────────────────────────────────────────────────

  router.get('/api/cards/:id/versions', (_ctx) => {
    const limit = queryInt(_ctx.query, 'limit', 50, 1, 500);
    const offset = queryInt(_ctx.query, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
    const result = ctx.cards.listVersions(_ctx.params['id']!, { limit, offset });
    sendJson(_ctx.res, 200, { total: result.total, limit, offset, items: result.items });
  });

  router.post('/api/cards/:id/versions', async (_ctx) => {
    const bytes = requireCardBody(_ctx);
    const version = await ctx.cards.addVersion(_ctx.params['id']!, bytes, writeOptionsFrom(_ctx.query, ctx));
    sendJson(_ctx.res, 201, version, {
      Location: `/api/cards/${_ctx.params['id']}/versions/${version.seq}`,
    });
  });

  router.get('/api/cards/:id/versions/:rev', (_ctx) => {
    const version = ctx.cards.resolveVersion(_ctx.params['id']!, _ctx.params['rev']);
    sendJson(_ctx.res, 200, ctx.cards.versionDto(version));
  });

  router.get('/api/cards/:id/versions/:rev/raw', (_ctx) => {
    const { bytes, version } = ctx.cards.readBytes(_ctx.params['id']!, _ctx.params['rev']);
    sendRaw(
      _ctx.res,
      200,
      bytes,
      rawHeaders(_ctx, version.blob_sha256, version.byte_size, `${_ctx.params['id']}-v${version.seq}.json`),
    );
  });

  router.get('/api/cards/:id/diff', (_ctx) => {
    const toRev = optional(_ctx.query, 'to') ?? 'latest';
    const to = ctx.cards.resolveVersion(_ctx.params['id']!, toRev);
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
    });
    sendJson(_ctx.res, 200, diff);
  });

  router.post('/api/cards/:id/rollback', async (_ctx) => {
    const meta = parseJsonBody<{ to?: string | number; message?: string; author?: string }>(_ctx.body, {});
    const to = String(meta.to ?? optional(_ctx.query, 'to') ?? '');
    if (to === '') throw new AppError(400, 'BAD_REQUEST', '缺少回滚目标：body.to 或 ?to=（版本序号 / 提交 sha）');
    const result = await ctx.cards.rollback(_ctx.params['id']!, to, {
      message: meta.message ?? optional(_ctx.query, 'message'),
      author: meta.author ?? optional(_ctx.query, 'author'),
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
    const version = optional(_ctx.query, 'version') ?? optional(_ctx.query, 'rev');
    if (queryBool(_ctx.query, 'refresh')) {
      const result = ctx.cards.recomputeAudit(_ctx.params['id']!, version, {
        platformId: optional(_ctx.query, 'platform') ?? ctx.config.defaultPlatformRule,
        presetId: optional(_ctx.query, 'preset') ?? ctx.config.defaultPreset,
      });
      sendRaw(_ctx.res, 200, result.reportBytes, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-TCS-Audit-Source': 'recomputed',
        ...(result.storedAuditSha256 ? { 'X-TCS-Audit-Snapshot': result.storedAuditSha256 } : {}),
        'X-TCS-API-Version': API_VERSION,
      });
      return;
    }
    const { bytes, version: row } = ctx.cards.readAuditBytes(_ctx.params['id']!, version);
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

      gate.check(req, pathname);

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
