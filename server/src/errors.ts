/**
 * 统一错误模型。
 *
 * 所有 HTTP 错误都收敛成 `{ error: { code, message, details? } }`，
 * 客户端（Electron 编辑器）按 code 分支处理，不解析人类可读文案。
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'GONE'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'TOO_MANY_REQUESTS'
  | 'CARD_PARSE_FAILED'
  | 'UNKNOWN_PLATFORM'
  | 'UNKNOWN_PRESET'
  | 'BLOB_CORRUPTED'
  | 'SERVICE_UNAVAILABLE'
  // F6.2 取令牌接口的两个专用码：
  //   TOKEN_LOCAL_ONLY     —— 来源不是回环（令牌不得出本机）
  //   TOKEN_NOT_CONFIGURED —— 服务端根本没配令牌（未启用鉴权）
  // 分开而不是都塞给 FORBIDDEN/CONFLICT，是为了让客户端能给出准确的处置建议：
  // 前者要用户去那台机器上操作，后者要用户去开鉴权（或干脆留空令牌）。
  | 'TOKEN_LOCAL_ONLY'
  | 'TOKEN_NOT_CONFIGURED'
  // T9.7 按 ID 归档的两个专用码：
  //   BAD_CARD_ID  —— 客户端给的 ID 不合法（不是"没找到"，重试也一样，必须改 ID）
  //   CARD_DELETED —— 该 ID 已被一张已软删的卡片占用（复用 ID 会把旧历史一起复活）
  | 'BAD_CARD_ID'
  | 'CARD_DELETED'
  | 'INTERNAL';

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = '缺少或无效的访问令牌'): AppError =>
  new AppError(401, 'UNAUTHORIZED', message);
export const notFound = (message: string, details?: unknown): AppError =>
  new AppError(404, 'NOT_FOUND', message, details);
export const conflict = (message: string, details?: unknown): AppError =>
  new AppError(409, 'CONFLICT', message, details);
export const internal = (message: string, details?: unknown): AppError =>
  new AppError(500, 'INTERNAL', message, details);

/** 未知异常统一转成 AppError（不把堆栈泄露给客户端） */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AppError(500, 'INTERNAL', message);
}

export function errorBody(error: AppError): Record<string, unknown> {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}
