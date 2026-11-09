/**
 * 把 Android 原生 HTTP 包成"像 fetch 的东西"（2026-11-04，T15.2 阶段 A）。
 *
 * ## 为什么需要这一层
 *
 * 真机实测：**这个 WebView 里 fetch 不可用**。
 *
 * ```text
 *   fetch('http://127.0.0.1:8000/version')   → TypeError: Failed to fetch
 *   fetch('https://10.9.0.2:8443/version')   → TypeError: Failed to fetch
 *   XMLHttpRequest 同一地址                   → 挂住，5 秒超时
 * ```
 *
 * 连本机回环都失败 —— 说明不是"服务器连不上"，而是 WebView 的网络栈
 * 在这个壳里根本没通（聊天一直是走 `invoke()` 到 Rust 的，从没用过 fetch）。
 *
 * ## 为什么做成"适配器"而不是改协议代码
 *
 * `auth-client` / `repo-client` / `server-sync` 三个模块**都接受注入
 * `fetchImpl`**（`options.fetchImpl ?? fetch`）。所以只要造一个函数
 * 满足 `typeof fetch` 的形状，注入进去即可 —— **协议代码一行不用改**。
 *
 * 这比"把三个模块里的 fetch 全换掉"好得多：那些模块有几十个测试，
 * 改一处就要重新验一遍它们全部的行为。
 */

/** 原生桥返回的形状 */
interface NativeHttpReply {
  ok?: boolean;
  status?: number;
  headers?: Array<[string, string]>;
  body?: string;
  error?: string;
}

/** Android 注入的桥（只有移动端有） */
interface HttpBridge {
  /**
   * 同步版（2026-11-04）。**前端不再用它** —— 它会冻结 JS 线程，
   * 服务端连不上时整个 App 卡满 connectTimeout。留着只为兼容可能的旧调用。
   */
  httpRequest?: (specJson: string) => string;
  /**
   * 异步版（2026-11-05）。立刻返回，结果通过 `window.__TCS_HTTP__` 回传。
   */
  httpRequestAsync?: (specJson: string, requestId: string) => void;
}

function bridge(): HttpBridge | null {
  const raw = (globalThis as { __ST_ENGINE__?: HttpBridge }).__ST_ENGINE__;
  if (raw === undefined) return null;
  return raw;
}

/** 这个运行环境有没有原生 HTTP 通道 */
export function hasNativeHttp(): boolean {
  return bridge() !== null;
}

/**
 * 原生回调的落点：`requestId → resolve`。
 *
 * 并发多个请求时靠 id 对上，不能靠顺序 —— 谁先回来不确定。
 */
const pendingReplies = new Map<string, (raw: string) => void>();
let replySeq = 0;

/**
 * 把 `window.__TCS_HTTP__` 挂上去（幂等）。
 *
 * 原生侧在后台线程完成请求后调它。**只注册一次**：
 * 重复注册会让仍在途的请求失去回调（后注册的覆盖前一个，
 * 而前一个的 Promise 永远悬着）。
 *
 * ## ★★★ 第二个参数可能是对象，不是字符串
 *
 * 原生侧回传的脚本长这样：
 *
 * ```js
 *   window.__TCS_HTTP__ && window.__TCS_HTTP__("r1", {"ok":true,"status":200,…})
 * ```
 *
 * 那个 JSON 字面量在 `evaluateJavascript` 里**会被当成 JS 对象**求值 ——
 * 所以回调收到的是 `Object`，不是我原本以为的字符串。
 *
 * 真机上撞到过：第一版直接 `JSON.parse(raw)`，报 `[object Object]`，
 * 而请求其实成功了。所以这里两种形态都要接。
 */
function ensureReplyHook(): void {
  const host = globalThis as {
    __TCS_HTTP__?: (requestId: string, raw: string | Record<string, unknown>) => void;
  };
  if (host.__TCS_HTTP__ !== undefined) return;
  host.__TCS_HTTP__ = (
    requestId: string,
    raw: string | Record<string, unknown>,
  ): void => {
    const resolve = pendingReplies.get(requestId);
    if (resolve === undefined) return;
    pendingReplies.delete(requestId);
    /* 统一成字符串交给上层（`callBridge` 的契约就是返回原始 JSON 文本） */
    resolve(typeof raw === 'string' ? raw : JSON.stringify(raw));
  };
}

/**
 * 调原生异步通道，等它回传。
 *
 * ## 为什么不直接 `port.httpRequestAsync(...)` 然后不管
 *
 * fetch 的契约是返回 Promise。原生那边回来的是 `window.__TCS_HTTP__` 回调，
 * 所以这里得把"回调"翻译成"Promise 落定"。
 *
 * ## 超时兜底
 *
 * 原生侧自己也有 connectTimeout，但**如果原生线程挂了 / 回传脚本抛错**，
 * Promise 会永远悬着，仓库页就一直显示"连接中"。所以这里再加一层
 * JS 侧超时，比原生超时宽 5 秒 —— 正常情况下永远轮不到它。
 *
 * ★ 不用 `AbortSignal`：原生通道没法中途取消（见文件头）。
 *   这里的超时只是"不再等"，请求本身仍在原生侧跑完。
 */
function callBridge(spec: Record<string, unknown>): Promise<string> {
  const port = bridge();
  if (port === null) return Promise.reject(new TypeError(NO_NATIVE_HTTP));

  /*
   * ★★★ 桥方法**必须写在注入对象上**调用，不许先取出来。
   *
   * 这是 2026-11-06 真机撞出来的**全功能故障**：
   *
   * ```text
   *   const asyncCall = port.httpRequestAsync;
   *   asyncCall(spec, id);
   *     ⇒ Error: Java bridge method can't be invoked on a non-injected object
   *
   *   port.httpRequestAsync(spec, id);
   *     ⇒ 正常
   * ```
   *
   * 原因：WebView 的 `@JavascriptInterface` 方法靠 `this` 判断调用者是
   * 不是那个**注入对象**。解引用之后 `this` 是 `undefined`，WebView 直接拒，
   * 抛 `Java bridge method can't be invoked on a non-injected object`。
   *
   * 后果特别隐蔽：**所有请求都失败**，而这个错误被下层包装成
   * 「无法连接服务端」—— 用户看到的是"服务器连不上"，
   * 于是去查网络、查地址、换服务端，**全都白费**
   * （服务器完全正常，是客户端根本发不出去）。
   *
   * 用户就是这么报的：
   *
   * > 现在连正常可通的服务端提示无法连接服务器
   * > 我用内置云的账号也提示无法连接服务器
   *
   * 判据见 `test/repo-nonblocking-and-auth-exclusive.test.mjs`：
   * 源码里不许出现"把 `httpRequest*` 赋值给变量"的写法。
   */
  if (typeof port.httpRequestAsync !== 'function') {
    /*
     * 老版本 APK 没有异步方法。退回同步版 —— 会卡，但至少能用。
     * 这种情况只会在"装了新前端、APK 还是旧的"时出现。
     *
     * ★ 同样是 `port.httpRequest(...)`，带注入对象。
     */
    if (typeof port.httpRequest === 'function') {
      try {
        return Promise.resolve(port.httpRequest(JSON.stringify(spec)));
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new TypeError(String(error)),
        );
      }
    }
    return Promise.reject(new TypeError(NO_NATIVE_HTTP));
  }

  ensureReplyHook();
  replySeq += 1;
  const requestId = `r${String(replySeq)}`;

  return new Promise<string>((resolve, reject) => {
    /*
     * JS 侧兜底：比原生最长路径（连接 8 秒 + 读取 15 秒 = 23 秒）宽 2 秒。
     *
     * 正常情况下永远轮不到它 —— 原生自己会先超时并回传。
     * 它存在只是因为"原生线程挂了 / 回传脚本抛错"时不能让 Promise 永远悬着。
     *
     * ★ 原来是 20 秒，比原生最长路径**短**，于是会出现这种怪事：
     *   服务器慢慢响应（连接 1 秒 + 读取 16 秒）时，JS 先放弃，
     *   报「请求超时」，而原生那边其实快成功了。
     */
    const timer = globalThis.setTimeout(() => {
      pendingReplies.delete(requestId);
      reject(new TypeError('请求超时，检查地址与网络'));
    }, 25_000);

    pendingReplies.set(requestId, (raw) => {
      globalThis.clearTimeout(timer);
      resolve(raw);
    });

    try {
      /*
       * ★ 必须是 `port.方法名(...)` —— 见上面那段注释（解引用会丢 this）。
       *
       * `?.` 与非空断言只为过类型检查：上面已经 `typeof` 判过存在。
       * 但**不能**写成 `const f = port.httpRequestAsync`，那才是真 bug。
       */
      port.httpRequestAsync?.(JSON.stringify(spec), requestId);
    } catch (error) {
      globalThis.clearTimeout(timer);
      pendingReplies.delete(requestId);
      reject(error instanceof Error ? error : new TypeError(String(error)));
    }
  });
}

/** 原生通道用不了时的错误（给用户看的一句话） */
export const NO_NATIVE_HTTP =
  '这台设备上发不出网络请求（原生通道不可用）。';

/**
 * 造一个 `fetch` 兼容函数。
 *
 * ## 支持的范围
 *
 * 三个协议模块实际只用到很小一部分 fetch：
 *
 * ```text
 *   method / headers / body / signal（abort 超时）
 *   读 response.status / .ok / .headers.get(…) / .json() / .text()
 * ```
 *
 * 所以这里实现这些就够了。**故意不实现** FormData、流式 body、
 * `response.body` 流 —— 用不到，实现了也没人验。
 *
 * ## signal 的处理
 *
 * 原生通道是同步的（在 JavaBridge 线程上阻塞），没法中途取消。
 * 所以这里在**开始前**检查一次 `signal.aborted`，开始后就不再响应。
 *
 * 这意味着"超时"由原生侧自己的 connectTimeout/readTimeout 保证 ——
 * 那比 JS 侧 abort 更可靠（JS 的 timer 在页面被挂起时不会跑）。
 *
 * ## `insecure` 怎么传
 *
 * 自定义仓库用到自签证书时，用户已经在配置页确认过风险。
 * 那个确认状态在地址配置里（`ackedPlainOrigin`）。但因为 fetch 签名里
 * 没有地方放它，这里用一个模块级的开关：
 *
 * ```ts
 * setInsecureHosts(['https://10.9.0.2:8443'])
 * ```
 *
 * 只对**列进来的 origin** 生效，不是全局关校验。
 */
let insecureOrigins = new Set<string>();

/** 设置哪些 origin 允许不校验证书（用户确认过风险的那些） */
export function setInsecureOrigins(origins: readonly string[]): void {
  insecureOrigins = new Set(origins.map((one) => one.replace(/\/+$/, '')));
}

/** 从 URL 取 origin，取不到返回空串 */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** 把 HeadersInit 拉平成 `[名, 值][]`（原生侧要数组） */
function flattenHeaders(init: HeadersInit | undefined): Array<[string, string]> {
  if (init === undefined) return [];
  if (Array.isArray(init)) return init.map(([k, v]) => [k, v]);
  if (typeof Headers !== 'undefined' && init instanceof Headers) {
    return [...init.entries()];
  }
  return Object.entries(init as Record<string, string>);
}

/**
 * 这次请求要不要走二进制通道？
 *
 * 判据只有一个：`Accept` 里有 `image/`。详见 `spec.binary` 那段注释。
 */
function wantsBinary(init: HeadersInit | undefined): boolean {
  for (const [name, value] of flattenHeaders(init)) {
    if (name.toLowerCase() === 'accept' && value.toLowerCase().includes('image/')) {
      return true;
    }
  }
  return false;
}

/**
 * 造一个最小可用的 Response。
 *
 * 协议模块用到 `status` / `ok` / `headers.get` / `json` / `text` /
 * `arrayBuffer`，所以手写一个对象比 `new Response()` 更可控
 * （后者在部分 WebView 上有兼容问题）。
 *
 * ## `arrayBuffer()` 与二进制（2026-11-06 加）
 *
 * 取卡面缩略图（`fetchFace`）要走二进制。原生侧的约定是：
 * **只有传了 `binary: true` 才会把字节 base64 编码后放进 `body`**。
 *
 * 所以这里 `arrayBuffer()` 的实现是"把 body 当 base64 解"——
 * 而 `nativeFetch` 会用 `wantsBinary()` 在**发请求时**决定是否传那个开关。
 * 两处必须成对，否则会拿 base64 当 UTF-8 文本去解，字节全坏。
 */
function makeResponse(reply: NativeHttpReply): Response {
  const status = typeof reply.status === 'number' ? reply.status : 0;
  const headerPairs = Array.isArray(reply.headers) ? reply.headers : [];
  const bodyText = typeof reply.body === 'string' ? reply.body : '';

  const headerMap = new Map<string, string>();
  for (const [name, value] of headerPairs) {
    /* HTTP 头名大小写不敏感；统一小写后查 */
    headerMap.set(name.toLowerCase(), value);
  }

  const response = {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string): string | null => headerMap.get(name.toLowerCase()) ?? null,
      has: (name: string): boolean => headerMap.has(name.toLowerCase()),
    },
    text: async (): Promise<string> => bodyText,
    json: async (): Promise<unknown> => {
      if (bodyText === '') return null;
      return JSON.parse(bodyText);
    },
    /*
     * 二进制：body 里是 base64（见上面那段注释）。
     *
     * 逐字符转 `charCodeAt` 而不是 `TextEncoder`：`atob` 出来的就是
     * 每字符一个字节的二进制串，用 TextEncoder 会按 UTF-8 重新编码，
     * 0x80 以上全变两字节 —— 图片必然坏。
     */
    arrayBuffer: async (): Promise<ArrayBuffer> => {
      if (bodyText === '') return new ArrayBuffer(0);
      const binary = globalThis.atob(bodyText);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    },
    /*
     * 几个协议模块可能碰的属性。给个安全默认，
     * 而不是留 undefined —— 那会在 `response.statusText.trim()` 之类的地方炸。
     */
    statusText: '',
    type: 'basic' as ResponseType,
    url: '',
    redirected: false,
  };

  return response as unknown as Response;
}

/**
 * 原生 HTTP 的 fetch 实现。
 *
 * 用法：把它传给三个客户端模块的 `fetchImpl` 选项。
 */
/**
 * 字节数组 → base64。
 *
 * 不用 `btoa(String.fromCharCode(...bytes))`：那种写法在字节数大时
 * 会超参数上限（语音几十 KB 直接抛 `Maximum call stack size exceeded`）。
 * 这里分块拼字符串，几十 KB 与几 MB 都稳。
 */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function nativeFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

  /* 开始前检查一次 abort —— 开始之后就没法中断了（见文件头注释） */
  if (init.signal?.aborted === true) {
    throw new DOMException('已取消', 'AbortError');
  }

  const port = bridge();
  /*
   * 快速失败：两条通道都没有就直接报错，不要等到 `callBridge` 里再兜。
   * 异步是首选（不冻 JS 线程），同步只作为"新前端 + 旧 APK"的退路。
   */
  if (port?.httpRequestAsync === undefined && port?.httpRequest === undefined) {
    throw new TypeError(NO_NATIVE_HTTP);
  }

  const headers = flattenHeaders(init.headers);

  /*
   * body 只支持字符串。
   *
   * 三个模块传的都是 `JSON.stringify(...)` 的结果或卡片原文，
   * 没有 FormData / Blob。真遇到就明确报错，不要悄悄发个空 body ——
   * 那会让服务端返回 400，而错误信息指向"参数缺失"，完全查不到真因。
   */
  /*
   * 请求体：三种形态
   *
   * ```text
   *   string     → body（UTF-8）
   *   FormData   → bodyBase64（multipart 字节流）
   *   其它        → 明确报错
   * ```
   *
   * ## 为什么必须支持 FormData（2026-11-07）
   *
   * 语音转写的 multipart 路线（Groq / OpenAI / 本地 whisper.cpp / 中转站）
   * 全靠它。整条桥原来只收字符串 ⇒ 这些厂商在真机上**全部不可用**，
   * 而且报的是"网络请求失败"（看起来像网络问题，实际是通道能力不足）。
   *
   * 真机实测：加之前 9 种语音方式只有 2 种能用，加之后 multipart 那几条
   * 才真正有机会接通。
   *
   * ★ `new Response(formData)` 会自动生成 **带 boundary 的 Content-Type**
   *   并序列化好整段字节流。我们自己拼 boundary 也行，但那样就要
   *   手工处理转义与换行，而浏览器已经做过这件事了。
   *   boundary 必须与 body 里的分隔符一致，所以 Content-Type 只能从这里取，
   *   **不能**让调用方自己写。
   */
  let body: string | null = null;
  let bodyBase64: string | null = null;
  let contentTypeOverride: string | null = null;

  if (init.body !== undefined && init.body !== null) {
    if (typeof init.body === 'string') {
      body = init.body;
    } else if (typeof FormData !== 'undefined' && init.body instanceof FormData) {
      const encoded = new Response(init.body);
      contentTypeOverride = encoded.headers.get('content-type');
      const bytes = new Uint8Array(await encoded.arrayBuffer());
      bodyBase64 = bytesToBase64(bytes);
    } else {
      throw new TypeError('原生通道只支持字符串或 FormData 请求体');
    }
  }

  /*
   * multipart 的 Content-Type 必须用 `Response` 生成的那一个（含 boundary）。
   * 调用方传的 `multipart/form-data`（没有 boundary）会让服务端解析失败 ——
   * 表现为 400 且错误信息只说"缺少字段"，完全查不到真因。
   */
  if (contentTypeOverride !== null) {
    const idx = headers.findIndex((one) => one[0].toLowerCase() === 'content-type');
    if (idx >= 0) headers[idx] = ['Content-Type', contentTypeOverride];
    else headers.push(['Content-Type', contentTypeOverride]);
  }

  const spec = {
    method: (init.method ?? 'GET').toUpperCase(),
    url,
    headers,
    body,
    /* 二进制请求体（multipart）走这条；与 `body` 互斥，原生侧 bodyBase64 优先 */
    bodyBase64,
    timeoutMs: 15_000,
    /*
     * ★ 连接超时单独给一个更短的值（2026-11-06）。
     *
     * 与 `timeoutMs` 分开的理由见 StBridge.kt 里 `connectTimeout` 那段注释：
     * 建连正常是毫秒到 2 秒，8 秒连不上基本就是地址/端口不通，
     * 没必要让用户等满 15 秒。
     */
    connectTimeoutMs: 8_000,
    insecure: insecureOrigins.has(originOf(url)),
    /*
     * ★★★ 二进制响应（2026-11-06）。
     *
     * 原生侧只有收到 `binary: true` 才会把响应体按**字节**读出来、
     * base64 编码后放进 body；否则按 UTF-8 解码成文本。
     *
     * 为什么必须分两条路（memory 里记过这个真缺陷）：JPEG/PNG 里的
     * 0x80–0xFF 在 UTF-8 解码时会被替换成 U+FFFD，**信息已经丢了**，
     * 前端再 `btoa` 会抛 `contains characters outside of the Latin1 range`。
     *
     * ## 判断依据为什么是 Accept
     *
     * fetch 的签名里没有地方放"我要二进制"。而 `Accept` 头**本来就是**
     * 调用方在表达"我要什么类型"，`fetchFace` 已经显式传了 `image/*`。
     * 所以用它当开关是顺着协议语义，不是猜：
     *
     * ```text
     *   Accept: image/*   ⇒ 二进制（图片经文本通道必然损坏）
     *   其它              ⇒ 文本（JSON 接口）
     * ```
     *
     * ★ 两处必须成对：`makeResponse().arrayBuffer()` 会把 body 当 base64 解。
     *   只改一边会把 base64 文本当字节用（或反之），图片全坏。
     */
    binary: wantsBinary(init.headers),
  };

  let raw: string;
  try {
    raw = await callBridge(spec);
  } catch (error) {
    /*
     * 跨 JS 边界调用抛错（原生抛了未捕获异常）。
     * 包成 TypeError 与 fetch 的网络错误同形，让上层统一处理。
     */
    throw new TypeError(
      `网络请求失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let reply: NativeHttpReply;
  try {
    reply = JSON.parse(raw) as NativeHttpReply;
  } catch {
    throw new TypeError('原生 HTTP 通道返回了无法解析的内容');
  }

  if (reply.ok !== true) {
    /*
     * 原生侧报的"连不上 / 证书不对 / 超时"。
     *
     * ★ 这里必须抛，不能造一个 status=0 的 Response ——
     * 上层会把它当成"服务端返回 0"去查状态码，而真因是请求没发出去。
     */
    throw new TypeError(reply.error ?? '网络请求失败');
  }

  return makeResponse(reply);
}

/**
 * 挑一个可用的 fetch：有原生通道就用它，否则用浏览器自带的。
 *
 * 桌面端 / 浏览器预览走后者；Android 走前者。
 */
export function pickFetch(): typeof fetch {
  return hasNativeHttp() ? (nativeFetch as typeof fetch) : fetch;
}
