/** HTTP 响应工具：统一 JSON 形状、统一错误形状、原始字节直出。 */

import type { ServerResponse } from 'node:http';

import { AppError, errorBody, toAppError } from '../errors.js';

export const COMMON_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = Buffer.from(`${JSON.stringify(body, null, 2)}\n`, 'utf8');
  res.writeHead(status, {
    ...COMMON_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.byteLength),
    ...headers,
  });
  res.end(payload);
}

export function sendRaw(
  res: ServerResponse,
  status: number,
  payload: Buffer,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...COMMON_HEADERS,
    'Content-Length': String(payload.byteLength),
    ...headers,
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, error: unknown): void {
  const appError = toAppError(error);
  sendJson(res, appError.status, errorBody(appError), errorHeaders(appError));
}

function errorHeaders(error: AppError): Record<string, string> {
  if (error.status === 401) return { 'WWW-Authenticate': 'Bearer realm="tavern-card-studio"' };
  if (error.status === 429) {
    const retry = (error.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
    return retry ? { 'Retry-After': String(retry) } : {};
  }
  return {};
}

export function methodNotAllowed(res: ServerResponse, allowed: string[]): void {
  sendJson(
    res,
    405,
    { error: { code: 'METHOD_NOT_ALLOWED', message: '该路径不支持此方法', details: { allowed } } },
    { Allow: allowed.join(', ') },
  );
}
