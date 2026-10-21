/** 原始请求体读取（不做任何解析，直接给 Buffer）。 */

import type { IncomingMessage } from 'node:http';

import { AppError } from '../errors.js';

export async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number.parseInt(String(req.headers['content-length'] ?? ''), 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AppError(413, 'PAYLOAD_TOO_LARGE', `请求体超过上限 ${maxBytes} 字节`, {
      declared,
      maxUploadBytes: maxBytes,
    });
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', `请求体超过上限 ${maxBytes} 字节`, {
        received: total,
        maxUploadBytes: maxBytes,
      });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

/** 小体积 JSON 元数据（回滚参数等）；卡片本体永远走 readRawBody */
export function parseJsonBody<T>(body: Buffer, fallback: T): T {
  if (body.byteLength === 0) return fallback;
  try {
    return JSON.parse(body.toString('utf8')) as T;
  } catch (error) {
    throw new AppError(400, 'BAD_REQUEST', '请求体不是合法 JSON', { reason: (error as Error).message });
  }
}
