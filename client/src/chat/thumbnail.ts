/**
 * 角色缩略图（2026-11-04，卡片列表与仓库用）。
 *
 * ## 为什么不能直接 `<img src="http://127.0.0.1:8000/thumbnail?...">`
 *
 * 真机实测（`.verify/probe-thumb-load.mjs`）：
 *
 * ```text
 *   img.onerror，耗时 2–80ms
 *   performance 里**有**这条 resource 记录（delta=1）  ⇒ 请求发出去了，不是 CSP 拦的
 *   但 transferSize=0、duration=0                      ⇒ 网络层立刻失败
 * ```
 *
 * 这和 `fetch` 在同一个壳里失败是同一个根因（§104）：
 * **这个 WebView 的网络栈对回环地址不可用**。`<img>` 和 `fetch` 走同一套栈，
 * 所以"换 img 试试"没有用，CSP 放行也没有用（都已实测排除）。
 *
 * ## 所以走桥 + base64
 *
 * ```text
 *   StBridge.httpRequest({ binary: true })   → Kotlin 读原始字节后 base64
 *   → data:image/jpeg;base64,…               → <img> 直接能显示（CSP 里 data: 已在白名单）
 * ```
 *
 * 为什么不用 `readAsset` 那种"返回 base64"的新方法：`httpRequest` 已有
 * `binary` 开关，桥方法数不必再涨（白名单判据要求精确相等）。
 *
 * ## 为什么取缩略图而不是原图
 *
 * 引擎的 `/thumbnail?type=avatar` 真机实测 **2055 字节** JPEG；
 * 而原图可能是 788 KB 的 PNG。一屏 20 张卡的差别是 40 KB vs 15 MB ——
 * 后者在手机上足够让列表卡住（`endpoints.ts` 的注释也是这个结论）。
 */

import { thumbnailPath } from '@tcs/shared';

/** 桥里 httpRequest 的最小形状 */
interface HttpBridgeLike {
  httpRequest: (specJson: string) => string;
}

interface EngineLike {
  status: () => string;
}

/** 一次会话内的缩略图缓存：`avatar → data URL`（含失败的 null） */
const cache = new Map<string, string | null>();

/** 并发去重：同一张图同时被请求两次时只发一次 */
const inflight = new Map<string, Promise<string | null>>();

function findEngine(): { bridge: HttpBridgeLike; port: number } | null {
  const raw = (globalThis as { __ST_ENGINE__?: Partial<HttpBridgeLike> & Partial<EngineLike> })
    .__ST_ENGINE__;
  if (typeof raw?.httpRequest !== 'function' || typeof raw?.status !== 'function') return null;
  try {
    const status = JSON.parse(raw.status()) as { port?: unknown };
    const port = typeof status.port === 'number' ? status.port : 0;
    if (port <= 0) return null;
    return { bridge: raw as HttpBridgeLike, port };
  } catch {
    return null;
  }
}

/**
 * 取一张头像缩略图，返回可直接喂给 `<img src>` 的 data URL。
 *
 * **失败返回 null，不抛**：列表里某一张图取不到时应该显示占位符，
 * 而不是让整页报错 —— 一张坏图不该拖垮整个列表。
 */
export async function loadThumbnail(avatar: string): Promise<string | null> {
  const key = avatar.trim();
  if (key === '') return null;

  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const pending = inflight.get(key);
  if (pending !== undefined) return pending;

  const task = (async (): Promise<string | null> => {
    const engine = findEngine();
    if (engine === null) return null;

    const url = `http://127.0.0.1:${String(engine.port)}${thumbnailPath('avatar', key)}`;
    let reply: { ok?: boolean; status?: number; bytes?: number; body?: string; error?: string } = {};
    try {
      reply = JSON.parse(
        engine.bridge.httpRequest(
          JSON.stringify({ url, method: 'GET', timeoutMs: 8000, binary: true }),
        ),
      ) as typeof reply;
    } catch {
      return null;
    }

    /*
     * ★ `binary: true` 时 base64 放在 **`body`** 里，不是单独的 `base64` 字段。
     *
     * 桥的实现是"响应体统一放 `body`"，`binary` 只改变**怎么读**
     * （原始字节 → base64 字符串，而不是按 UTF-8 解成文本）。
     * 我第一版按 `reply.base64` 取，永远拿到 undefined ——
     * 而它被 `try` 之外的 `?? null` 吞掉了，表现为"所有缩略图都不显示"，
     * 没有任何报错。真机排查时是打字段形状才看出来的。
     */
    if (reply.ok !== true || typeof reply.body !== 'string' || reply.body === '') return null;

    /* 404 = 这张卡没有头像图（正常结果，不是错误） */
    if (reply.status !== undefined && reply.status !== 200) return null;

    /* 缩略图是 JPEG；万一引擎换了格式，浏览器也能靠内容嗅探显示 */
    return `data:image/jpeg;base64,${reply.body}`;
  })();

  inflight.set(key, task);
  try {
    const settled = await task;
    /*
     * ★★★ 只缓存**成功**的结果（2026-11-04 真机抓到的缺陷）。
     *
     * 原来 `cache.set(key, settled)` 连 null 一起缓存 —— 而 null 的成因
     * 常常是**临时**的：面板刚挂上时引擎还没就绪、端口还没记住，
     * 那一次返回 null 之后，这张卡的头像就**永久**是首字占位，
     * 哪怕引擎一秒后就绪也不会再试。
     *
     * 真机现象：列表里一张有头像、一张只有首字圆，而那"没有"的那张
     * 用桥单独取是 200 + 2868 字节 —— 数据一直在。
     *
     * 所以 null 不缓存：下次渲染会重试。代价是"真的没封面"的卡
     * 每次多一次请求（那是 404，几毫秒，可以接受）。
     */
    if (settled !== null) cache.set(key, settled);
    return settled;
  } finally {
    inflight.delete(key);
  }
}

/** 清缓存（换角色库、删卡后调） */
export function clearThumbnailCache(): void {
  cache.clear();
}
