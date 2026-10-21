/**
 * 壳能力契约 · 错误模型
 *
 * Rust 侧 `ShellError` 序列化为 `{ code, message, details? }`。
 * 这里既定义 code 的封闭集合，也提供一个可被 UI 直接消费的 Error 子类。
 * 渲染层不解析 message 文案（文案可能变），只按 code 分支。
 */

export type ShellErrorCode =
  /** 空路径 */
  | 'EMPTY_PATH'
  /** 路径不是绝对路径 */
  | 'PATH_NOT_ABSOLUTE'
  /** 目标不是常规文件（是目录 / 是设备文件） */
  | 'NOT_A_FILE'
  /** 文件不存在 */
  | 'PATH_NOT_FOUND'
  /** 超出体积上限 */
  | 'TOO_LARGE'
  /** 不是合法 UTF-8（details.offset 为首个非法字节偏移） */
  | 'NOT_UTF8'
  /** 扩展名不在白名单 */
  | 'EXT_NOT_ALLOWED'
  /** 调用方声明的 sha256 与实际内容不一致（写前/写后校验） */
  | 'DIGEST_MISMATCH'
  /** 找不到内置规则目录 */
  | 'RULES_DIR_MISSING'
  /** 未知的规则类别 */
  | 'UNKNOWN_RULE_KIND'
  /** 路径越界（试图穿越出规则目录） */
  | 'PATH_NOT_ALLOWED'
  /** 其它 IO 失败 */
  | 'IO_ERROR'
  /** 非壳错误（前端参数错误、插件异常等） */
  | 'SHELL_BRIDGE_ERROR';

export interface ShellErrorPayload {
  code: ShellErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class ShellError extends Error {
  readonly code: ShellErrorCode;
  readonly details: Record<string, unknown>;

  constructor(payload: ShellErrorPayload) {
    super(payload.message);
    this.name = 'ShellError';
    this.code = payload.code;
    this.details = payload.details ?? {};
  }
}

/** 把 invoke 的 rejection 归一化成 ShellError（不吞掉原始对象） */
export function toShellError(error: unknown): ShellError {
  if (error instanceof ShellError) return error;

  if (typeof error === 'object' && error !== null) {
    const candidate = error as Partial<ShellErrorPayload> & { message?: unknown };
    if (typeof candidate.code === 'string') {
      return new ShellError({
        code: candidate.code as ShellErrorCode,
        message: typeof candidate.message === 'string' ? candidate.message : String(candidate.code),
        details: candidate.details,
      });
    }
    if (typeof candidate.message === 'string') {
      return new ShellError({ code: 'SHELL_BRIDGE_ERROR', message: candidate.message });
    }
  }

  return new ShellError({ code: 'SHELL_BRIDGE_ERROR', message: String(error) });
}
