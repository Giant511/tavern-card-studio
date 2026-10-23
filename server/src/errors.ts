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
  // T10.4 账户与认证的专用码。
  //
  // 为什么登录失败只用一个码：`INVALID_CREDENTIALS` 同时覆盖"用户不存在"、
  // "密码错"、"账户锁定中"三种情况 —— 如果分成三个码，客户端或日志一泄露
  // 就等于把账户存在性/锁定状态广播出去。需求明确要求这三者对外不可区分。
  //
  //   REGISTRATION_CLOSED   —— 服务端关了自助注册（明确拒绝，不伪装成功）
  //   REGISTRATION_REJECTED —— 注册失败（用户名占用/格式不合规/密码不合规，共用）
  //   ACCOUNT_DISABLED      —— 密码正确但账户被禁用（走到这里说明密码已对，不构成枚举面）
  //   INVALID_REFRESH_TOKEN —— refresh 失效（不存在/已吊销/已过期，共用一句）
  | 'INVALID_CREDENTIALS'
  | 'REGISTRATION_CLOSED'
  | 'REGISTRATION_REJECTED'
  | 'ACCOUNT_DISABLED'
  | 'INVALID_REFRESH_TOKEN'
  // T10.18 / F13：删除与移动体系的专用码。
  //
  //   CARD_IN_TRASH           —— 卡片在回收站里（恢复/purge 之外的写操作应拒绝）
  //   VERSION_CONTENT_CLEARED —— 版本内容已被 prune 清除（不是"不存在"）
  //   NOT_EMPTY               —— 目标非空（删仓库却没给 transferTo）
  //   ADMIN_ONLY              —— 该操作仅管理员可用（purge / 跨账户）
  //
  // 为什么 purge 用 ADMIN_ONLY 而不是 FORBIDDEN：客户端要能一眼区分
  // "你没有这个仓库的写权限"（换把令牌就行）与"这件事只有管理员能做"（换令牌也没用）。
  | 'CARD_IN_TRASH'
  | 'VERSION_CONTENT_CLEARED'
  | 'NOT_EMPTY'
  | 'ADMIN_ONLY'
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
