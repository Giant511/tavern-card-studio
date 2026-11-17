/**
 * HTTP 传输层的统一抽象（2026-11-17，修「自签证书被拒」）。
 *
 * ## 为什么需要一层抽象
 *
 * 同步服务端的请求原来直接调 `fetch`。这在**浏览器**里没问题，
 * 但在桌面壳里有一个死结：webview 的证书校验用系统证书链、
 * **无法配置**。自签证书一律拒绝，且失败被浏览器压成一个 `TypeError` ——
 * 到界面上就是"地址不通、端口未开、或服务端未启动"（memory §105：
 * 实测 8 ms 快速失败，同一地址 `curl -k` 立刻 200）。
 *
 * 于是有两件事同时坏了：
 *
 * ```text
 *   ① 连不上（没有"确认风险后继续"的出口）
 *   ② 归因错（证书问题被说成端口问题，把用户引向错误的方向）
 * ```
 *
 * 两个都要修，而修法只有一条：这类请求必须**能拿到结构化的失败原因**。
 * 浏览器 fetch 给不了（`TypeError` 里没有错误码），所以桌面端走原生命令
 * `server_http_request`；浏览器端仍走 fetch（那里没有这样一个壳可用）。
 *
 * ## 三种失败原因，分别对应三个用户动作
 *
 * ```text
 *   cert    → "证书不受信任"   → 确认风险后可继续（唯一有出口的一类）
 *   connect → "连不上"         → 去查地址 / 端口 / 服务端有没有起
 *   timeout → "超时"           → 网络慢，或地址对但对方不是这个服务
 * ```
 *
 * ## ★ 这一层不许 import 契约层（否则 Node 测试全挂）
 *
 * 契约层（`contract/shell.ts`）依赖 `@tauri-apps/api`，而本项目的一批
 * 单测是**在 Node 里直接跑 .ts** 的（Node 22 类型剥离）。一旦本模块
 * 顶层 import 契约层，`test/client-settings.test.mjs` 这类纯逻辑测试
 * 会立刻报 `ERR_MODULE_NOT_FOUND`（契约层用 `.js` 后缀 import）。
 *
 * 所以用**注册制**：本模块只定义接口与 fetch 实现；原生实现由
 * `http-native.ts` 提供，并在桌面入口 import 一次完成注册。
 * 漏注册不会退化成"悄悄用 fetch"——`defaultTransport()` 在 Tauri 运行时
 * 里会**抛错**（见那里的注释）。
 *
 * ## 为什么 transport 是**函数**而不是 class
 *
 * 调用点要能注入替身（现有 `fetchImpl` 就是这么用的，一堆测试依赖它）。
 * 函数类型最省事，也避免了"继承 + 覆写"那种更重的写法。
 */

import type { ServerHttpErrorKind } from '../contract/types.ts';

export interface HttpRequestSpec {
  url: string;
  method?: string;
  /** 对象形式；transport 内部会拉平成数组交给原生 */
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** 用户已确认风险，允许跳过证书校验（只对 https 有意义） */
  allowInvalidCert?: boolean;
}

/** 一次请求的结果。**成功与失败都返回它**，不抛异常 */
export interface HttpOutcome {
  /** 有响应时有值；连不上/超时/证书失败时为 null */
  status: number | null;
  contentType: string;
  /** 文本响应体；二进制或失败时为 null */
  text: string | null;
  /** 二进制响应体的 base64；文本或失败时为 null */
  base64: string | null;
  elapsedMs: number;
  /** 失败原因分类；成功时为 null */
  errorKind: ServerHttpErrorKind | null;
  /** 面向用户的失败说明；成功时为 null */
  error: string | null;
}

export type HttpTransport = (spec: HttpRequestSpec) => Promise<HttpOutcome>;

/** 成功且有响应 */
export function isOk(outcome: HttpOutcome): boolean {
  return outcome.status !== null && outcome.status >= 200 && outcome.status < 300;
}

/** 把 HeadersInit 之类的对象拉平（只支持对象，够本模块用） */
function flatten(headers: Record<string, string> | undefined): Array<[string, string]> {
  return headers === undefined ? [] : Object.entries(headers);
}

/**
 * 浏览器 fetch 版。
 *
 * ## 它认不出证书错误 —— 这是这一层存在的理由
 *
 * 浏览器对 DNS 失败 / 拒连 / CORS / **证书错误**一律抛 `TypeError`，
 * 没有结构化错误码。所以这里只能给 `connect`，并在文案里说清
 * "也可能是证书问题"。真正的判定由原生通道做（两段探测）。
 *
 * ★ 保留 `fetchImpl` 注入：现有的一批测试靠它模拟 401/404/409/断网。
 */
export function createFetchTransport(fetchImpl: typeof fetch = fetch): HttpTransport {
  return async (spec) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), spec.timeoutMs);
    const started = Date.now();
    try {
      const response = await fetchImpl(spec.url, {
        method: spec.method ?? 'GET',
        ...(spec.headers === undefined ? {} : { headers: spec.headers }),
        ...(spec.body === undefined ? {} : { body: spec.body }),
        signal: controller.signal,
      });
      const elapsedMs = Date.now() - started;
      /*
       * ★ 对注入的 fetch 桩要容忍（2026-11-17）。
       *
       * `fetchImpl` 是给测试注入的（本项目有一批测试用它模拟
       * 401/404/409/断网）。那些桩往往是**手搓的最小对象**，只有
       * `status` / `ok` / `text()` / `json()`，没有 `headers` 和
       * `arrayBuffer()`。
       *
       * 直接写 `response.headers.get(...)` 会在桩上抛 TypeError，
       * 而外层的 catch 会把它归类成 `connect` —— 于是测试报
       * "无法连接"，而真正的原因是"桩少了个字段"。我第一版就是这样，
       * 三条原本好的测试一起红了。
       *
       * 所以按能力探测，不假设。
       */
      const contentType =
        typeof response.headers?.get === 'function' ? (response.headers.get('content-type') ?? '') : '';
      /*
       * 文本还是二进制：与 Rust 侧同一套判据（`server_http.rs` 里那段）。
       * 两处必须一致，否则会出现"桌面端拿到 text、浏览器拿到 base64"的
       * 诡异差异 —— 而那种差异只在某个端上炸。
       */
      const looksText =
        contentType.startsWith('text/') ||
        contentType.includes('json') ||
        contentType.includes('xml') ||
        contentType.includes('javascript');

      if (looksText) {
        const text = await response.text();
        return {
          status: response.status,
          contentType,
          text,
          base64: null,
          elapsedMs,
          errorKind: null,
          error: null,
        };
      }
      /*
       * 二进制读取同样要探测：桩没有 `arrayBuffer()` 就退回 `text()`。
       * 真实 `Response` 永远有它，所以这条只对注入的桩生效。
       */
      if (typeof response.arrayBuffer !== 'function') {
        const text = await response.text();
        return {
          status: response.status,
          contentType,
          text,
          base64: null,
          elapsedMs,
          errorKind: null,
          error: null,
        };
      }
      const buffer = await response.arrayBuffer();
      return {
        status: response.status,
        contentType,
        text: null,
        base64: bytesToBase64(new Uint8Array(buffer)),
        elapsedMs,
        errorKind: null,
        error: null,
      };
    } catch (error) {
      const elapsedMs = Date.now() - started;
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        status: null,
        contentType: '',
        text: null,
        base64: null,
        elapsedMs,
        errorKind: aborted ? 'timeout' : 'connect',
        error: aborted
          ? `请求超时（${String(spec.timeoutMs)} ms）`
          : '无法连接（地址不通、端口未开、或服务端未启动）',
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * 注册原生 transport（由 `http-native.ts` 调）。
 *
 * 为什么要有这一步而不是 import：见文件头「不许 import 契约层」。
 */
let nativeFactory: (() => HttpTransport) | null = null;

export function registerNativeTransport(factory: () => HttpTransport): void {
  nativeFactory = factory;
}

/** 测试用：清掉注册（避免一条测试的注册漏到下一条） */
export function resetTransportRegistry(): void {
  nativeFactory = null;
}

/** 当前是否跑在 Tauri 壳里（**不 import 契约层**，就地判断） */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 选一个 transport。
 *
 * ```text
 *   桌面壳（Tauri）  → 已注册的原生通道（能识别证书，能给出口）
 *   浏览器            → fetch（端到端测试与开发时用）
 * ```
 *
 * ## ★ 壳里没注册就**抛错**，绝不悄悄退回 fetch
 *
 * 退回 fetch 的后果正是这个 bug 的原状：自签证书连不上，而界面说
 * "端口没开"。那种"少做一步就静默降级"的设计比直接报错危险得多 ——
 * 报错至少当场看得见，降级要到用户报障才发现。
 *
 * 注册只有一处（`http-native.ts` 模块加载时），桌面入口 import 一次即可。
 */
export function defaultTransport(): HttpTransport {
  if (nativeFactory !== null) return nativeFactory();
  if (isTauriRuntime()) {
    throw new Error(
      '桌面端没有注册原生 HTTP 通道：请在入口处 import "net/http-native.ts"。' +
        '（不能退回 fetch —— 那样自签证书会连不上，而且失败原因会被报成"端口未开"）',
    );
  }
  return createFetchTransport();
}

/** 字节 → base64（浏览器端用；分块避免超出调用栈） */
function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** base64 → 字节（解码二进制响应） */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * origin 归一化（证书白名单按它匹配）。
 *
 * 与 `native-fetch.ts` 的 `originOf` 同一套：去掉末尾斜杠、小写 scheme/host。
 * ★ 取不到（非法 URL）返回空串 —— 空串**永远不匹配**白名单，
 * 这样"地址写错了"不会被当成"这个 origin 已确认过"。
 */
export function normalizeOrigin(url: string): string {
  try {
    return new URL(url.trim()).origin;
  } catch {
    return '';
  }
}

/** 这个 origin 是否已在"确认过证书风险"的白名单里 */
export function isOriginCertAcked(acked: readonly string[], url: string): boolean {
  const origin = normalizeOrigin(url);
  if (origin === '') return false;
  return acked.some((one) => normalizeOrigin(one) === origin);
}

/** 把 origin 加进白名单（去重、过滤空串、保持已有顺序） */
export function withCertAckedOrigin(acked: readonly string[], url: string): string[] {
  const origin = normalizeOrigin(url);
  if (origin === '') return [...acked];
  if (isOriginCertAcked(acked, url)) return [...acked];
  return [...acked, origin];
}
