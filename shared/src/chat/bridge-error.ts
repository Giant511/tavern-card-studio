/**
 * 把任何形态的错误翻成**可归因的一句话**（2026-10-31 第五批）。
 *
 * ## 这个模块存在的唯一理由：`[object Object]` 不许再出现
 *
 * 用户报的原话：
 *
 * > 点保存，提示「保存失败: [object Object]」
 * > ……不许出现 [object Object] 这类把错误对象直接字符串化的输出
 * > —— 这本身就是缺陷
 *
 * ## 为什么会出现 `[object Object]`
 *
 * Rust 侧的 `ShellError` 序列化成**普通对象**（`error.rs:198`）：
 *
 * ```json
 * { "code": "ST_UNAVAILABLE", "message": "还没连上 SillyTavern。先点一次「连接」" }
 * ```
 *
 * Tauri 的 `invoke()` 被 reject 时，交给前端的就是这个对象本身。
 * 而两处错误渲染都写的是：
 *
 * ```ts
 * error instanceof Error ? error.message : String(error)   // ← 对象走这条
 * ```
 *
 * `String({code:'…'})` 的结果就是 `"[object Object]"`。
 * **信息全在对象里，一个字符都没漏出来** —— 这不是"错误信息不友好"，
 * 是"错误信息被丢掉了"。
 *
 * ## 为什么放在 `shared` 而不是 `client`
 *
 * 它要能被 Node 单测直接跑（`test/bridge-error.test.mjs`），
 * 而 `client` 侧的模块大多依赖 DOM 类型。放 shared 里也不用引 Tauri。
 *
 * ## 分类的意义
 *
 * 用户要求"失败时必须显示**可归因的明确原因**（分类文案）"。
 * 分类不是装饰：`ST_UNAVAILABLE` 要用户去查引擎，
 * `ST_FORBIDDEN` 要用户重新连接，`ST_HTTP_STATUS` 要用户看上游 ——
 * 三种情况的下一步动作完全不同，混成一句"保存失败"等于没有信息。
 */

/** 错误分类（给文案与后续动作分派用） */
export type BridgeErrorKind =
  | 'engine' // 连不上引擎 / 引擎没起
  | 'auth' // 会话或密钥失效
  | 'upstream' // 上游服务明确报错
  | 'contract' // 响应形状不对（ST 升级了？）
  | 'io' // 本机文件 / 磁盘
  | 'unknown'; // 兜底，但**仍然带原文**

export interface DescribedError {
  kind: BridgeErrorKind;
  /** 给用户看的一句话（不许出现 `[object Object]`） */
  message: string;
  /** 可选的下一步建议。有就显示，没有就不显示 */
  hint?: string;
  /** 原始错误码（排障用，界面上可折叠或忽略） */
  code?: string;
}

/** Rust `ShellError` 序列化后的形状 */
interface SerializedShellError {
  code?: unknown;
  message?: unknown;
  details?: unknown;
}

/** 错误码 → (分类, 人话, 建议) */
function classifyCode(code: string, message: string): DescribedError {
  switch (code) {
    case 'ST_UNAVAILABLE':
      return {
        kind: 'engine',
        code,
        message: message === '' ? '连不上聊天服务' : message,
        hint: '先确认聊天服务在运行（通知栏应有「口袋酒馆 正在运行」），再重试。',
      };
    case 'ST_FORBIDDEN':
      return {
        kind: 'auth',
        code,
        message: message === '' ? '服务拒绝了这次请求' : message,
        hint: '会话可能过期了。回到聊天页重新连接一次。',
      };
    case 'ST_HTTP_STATUS':
      return {
        kind: 'upstream',
        code,
        message: message === '' ? '上游服务返回了错误' : message,
        hint: '这是接口服务端的问题，不是本机配置。检查服务地址与密钥。',
      };
    case 'ST_BAD_RESPONSE':
      return {
        kind: 'contract',
        code,
        message: message === '' ? '服务的回应格式不对' : message,
        hint: '可能是服务版本变了。记录这个提示后反馈。',
      };
    case 'IO_ERROR':
      return { kind: 'io', code, message: message === '' ? '读写本机文件失败' : message };
    case 'PROBE_HOST_NOT_ALLOWED':
      return {
        kind: 'engine',
        code,
        message: message === '' ? '这个地址不被允许连接' : message,
        hint: '只支持本机地址（127.0.0.1 / localhost / ::1）。',
      };
    default:
      return {
        kind: 'unknown',
        code,
        // ★ 兜底也带原文。宁可给一句难看但真实的话，也不给"未知错误"
        message: message === '' ? `操作失败（${code}）` : message,
      };
  }
}

/**
 * 把任意错误翻成 `{kind, message, hint?, code?}`。
 *
 * 处理五种形态，**每一种都不允许产出 `[object Object]`**：
 * 1. `string` —— Rust 侧某些路径直接给字符串
 * 2. `Error` 实例
 * 3. `{code, message}` 对象（Tauri 的常态）
 * 4. 其它对象 —— 用 JSON.stringify 兜住（**不用 String()**）
 * 5. null / undefined
 */
export function describeBridgeError(error: unknown): DescribedError {
  if (error === null || error === undefined) {
    return { kind: 'unknown', message: '操作失败，但没有拿到原因' };
  }

  if (typeof error === 'string') {
    const trimmed = error.trim();
    if (trimmed === '') return { kind: 'unknown', message: '操作失败，但原因是空的' };
    /*
     * 状态码优先：`explainGenerateError` 那套文案（403/401/429/5xx）
     * 比直接显示 "status: 403" 有用得多。
     */
    const status = /status:?\s*(\d{3})/i.exec(trimmed);
    if (status?.[1] !== undefined) {
      const code = Number(status[1]);
      const kind: BridgeErrorKind =
        code === 401 || code === 403 ? 'auth' : code >= 500 ? 'upstream' : 'upstream';
      return { kind, message: trimmed };
    }
    return { kind: 'unknown', message: trimmed };
  }

  if (error instanceof Error) {
    const message = error.message.trim();
    return { kind: 'unknown', message: message === '' ? error.name : message };
  }

  if (typeof error === 'object') {
    const obj = error as SerializedShellError;

    const code = typeof obj.code === 'string' ? obj.code : '';
    const message = typeof obj.message === 'string' ? obj.message.trim() : '';

    if (code !== '') return classifyCode(code, message);

    /*
     * 没有 `code` 的对象 —— 可能是别人抛的自定义错误。
     * 用 JSON 而不是 String()：`JSON.stringify` 至少把字段露出来，
     * `String()` 只会给 `[object Object]`。
     */
    try {
      const json = JSON.stringify(error);
      if (json !== '{}' && json !== undefined) {
        return { kind: 'unknown', message: `操作失败：${json.slice(0, 200)}` };
      }
    } catch {
      // 循环引用之类 —— 连 JSON 都做不了
    }
    return { kind: 'unknown', message: '操作失败，返回的是一个无法识别的对象' };
  }

  // number / boolean / symbol 等
  return { kind: 'unknown', message: `操作失败（${String(error)}）` };
}

/**
 * 拼成界面上要显示的那一行。
 *
 * 独立成一个函数是为了让"文案形状"只有一个来源 ——
 * 两个页面各拼一份，必然一处带前缀一处不带。
 */
export function formatBridgeError(error: unknown, prefix = '保存失败'): string {
  const described = describeBridgeError(error);
  return `${prefix}：${described.message}`;
}
