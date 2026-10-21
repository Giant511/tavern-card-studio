/**
 * 服务端连接探测（T6.8）。
 *
 * 设计要点：
 *   1. **不依赖壳**：服务端已返回 `Access-Control-Allow-Origin: *`，
 *      渲染层用 `fetch` 直连即可，局域网 IP / 域名都成立，无需新增原生命令；
 *   2. **分两步判定**：`/api/health` 是公开接口（只证可达），
 *      `/api/stats` 需鉴权（才证 token 有效）。只测前者会把"token 错了"误报成"连上了"；
 *   3. **必须有超时**：服务端挂掉时 `fetch` 可能长时间悬挂，用 AbortController 兜住，
 *      否则设置面板会一直转圈；
 *   4. 纯函数 + 可注入 fetch，便于离线单测（见 test/client-settings.test.mjs）。
 */

export interface ServerConfigInput {
  serverUrl: string;
  token: string;
}

export type UrlCheck =
  | { ok: true; url: string }
  | { ok: false; reason: 'empty' | 'bad-scheme' | 'bad-url'; message: string };

/**
 * 归一化用户填写的服务端地址。
 *
 * 接受这些写法（都是用户实际会输入的）：
 *   · `http://127.0.0.1:8730`      → 原样（去掉尾部斜杠）
 *   · `127.0.0.1:8730`             → 补 `http://`
 *   · `192.168.1.20:8730/api`      → 保留路径，去掉尾部斜杠
 *   · `https://card.example.com`   → 保留 https
 *
 * 明确拒绝：非 http/https 协议（`file:`、`javascript:` 等）、无法解析的串。
 * 拒绝而非"猜测修正"，因为静默改协议会让用户以为连的是另一台机器。
 */
export function normalizeServerUrl(raw: string): UrlCheck {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'empty', message: '未填写服务端地址' };
  }

  // 危险/无关协议要显式拦下。不能简单用 /^[a-z]+:/ 判断"有协议"，
  // 因为 `nas.local:8730` 的 `nas.local` 也符合 scheme 的字符集，
  // 那样会把最常见的主机:端口写法误判成协议。
  const DANGEROUS_SCHEME = /^(file|javascript|data|vbscript|blob|about|chrome|chrome-extension):/i;
  if (DANGEROUS_SCHEME.test(trimmed)) {
    return {
      ok: false,
      reason: 'bad-scheme',
      message: '只支持 http/https 地址',
    };
  }

  // 用户常省略协议头：没有 `scheme://` 且不是危险协议时补 http://
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  const candidate = hasScheme ? trimmed : `http://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: 'bad-url', message: `无法解析为地址：${trimmed}` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'bad-scheme',
      message: `只支持 http/https，当前是 ${parsed.protocol.replace(':', '')}`,
    };
  }

  if (parsed.hostname === '') {
    return { ok: false, reason: 'bad-url', message: `缺少主机名：${trimmed}` };
  }

  // 统一去掉尾部斜杠，后面拼 `/api/...` 时不会出现 `//`
  const normalized = candidate.replace(/\/+$/, '');
  return { ok: true, url: normalized };
}

export interface ProbeResult {
  /** 是否连上了 HTTP 服务（health 通过） */
  reachable: boolean;
  /** 服务端版本 */
  version: string | null;
  /** 服务端是否要求鉴权 */
  authRequired: boolean | null;
  /**
   * token 是否有效。
   * null = 无法判定（不可达，或服务端不要求鉴权）
   */
  tokenValid: boolean | null;
  /** 服务端现有卡片数（仅在 token 有效时拿到） */
  cardCount: number | null;
  /** health 往返耗时（毫秒） */
  latencyMs: number | null;
  /** 归一化后的地址（失败时为 null） */
  url: string | null;
  /** 面向用户的一句话结论 */
  message: string;
  /** 细分阶段，便于 UI 决定提示位置 */
  stage: 'url' | 'health' | 'auth' | 'ok';
}

const DEFAULT_TIMEOUT_MS = 6000;

export interface ProbeOptions {
  timeoutMs?: number;
  /** 便于测试注入；默认用全局 fetch */
  fetchImpl?: typeof fetch;
}

function failure(
  stage: ProbeResult['stage'],
  message: string,
  extra: Partial<ProbeResult> = {},
): ProbeResult {
  return {
    reachable: false,
    version: null,
    authRequired: null,
    tokenValid: null,
    cardCount: null,
    latencyMs: null,
    url: null,
    message,
    stage,
    ...extra,
  };
}

/** 带超时的 fetch：超时后 abort，并把原因翻译成人话 */
async function fetchWithTimeout(
  target: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ response: Response | null; error: string | null; elapsed: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetchImpl(target, { ...init, signal: controller.signal });
    return { response, error: null, elapsed: Date.now() - started };
  } catch (error) {
    const elapsed = Date.now() - started;
    const aborted = error instanceof Error && error.name === 'AbortError';
    if (aborted) {
      return { response: null, error: `请求超时（${timeoutMs} ms）`, elapsed };
    }
    // 浏览器对 CORS / DNS / 拒连都抛 TypeError，只能给一个覆盖这些可能性的提示
    return {
      response: null,
      error: '无法连接（地址不通、端口未开、或服务端未启动）',
      elapsed,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 探测服务端：可达性 → 鉴权 → token 有效性。
 *
 * 注意：**探测失败不影响本地编辑**。调用方只把结果用于「同步功能是否可用」的开关，
 * 编辑/审计/导出完全不经过这里。
 */
export async function probeServer(
  input: ServerConfigInput,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const checked = normalizeServerUrl(input.serverUrl);
  if (!checked.ok) {
    return failure('url', checked.message);
  }
  const base = checked.url;

  // ① 可达性：/api/health 是公开路径，不需要 token
  const health = await fetchWithTimeout(
    `${base}/api/health`,
    { method: 'GET', headers: { Accept: 'application/json' } },
    timeoutMs,
    fetchImpl,
  );
  if (!health.response) {
    return failure('health', health.error ?? '连接失败', { url: base, latencyMs: health.elapsed });
  }
  if (!health.response.ok) {
    return failure('health', `服务端返回 HTTP ${health.response.status}（该地址不是本服务？）`, {
      url: base,
      latencyMs: health.elapsed,
    });
  }

  let healthBody: Record<string, unknown> = {};
  try {
    healthBody = (await health.response.json()) as Record<string, unknown>;
  } catch {
    return failure('health', '响应不是 JSON（该地址可能不是 Tavern Card Studio 服务端）', {
      url: base,
      latencyMs: health.elapsed,
    });
  }

  if (healthBody['status'] !== 'ok') {
    return failure('health', '服务端状态异常（health.status 不是 ok）', {
      url: base,
      latencyMs: health.elapsed,
    });
  }

  const version = typeof healthBody['version'] === 'string' ? healthBody['version'] : null;
  const authRequired = healthBody['authRequired'] === true;

  // ② 不要求鉴权：无需再验 token
  if (!authRequired) {
    return {
      reachable: true,
      version,
      authRequired: false,
      tokenValid: null,
      cardCount: null,
      latencyMs: health.elapsed,
      url: base,
      message: `已连接${version ? `（服务端 ${version}）` : ''}，服务端未启用鉴权`,
      stage: 'ok',
    };
  }

  // ③ 要求鉴权但没填 token
  const token = input.token.trim();
  if (token === '') {
    return {
      reachable: true,
      version,
      authRequired: true,
      tokenValid: null,
      cardCount: null,
      latencyMs: health.elapsed,
      url: base,
      message: `已连接${version ? `（服务端 ${version}）` : ''}，但服务端要求鉴权：未填写 token`,
      stage: 'auth',
    };
  }

  // ④ 用受保护接口验证 token：/api/stats 轻量且一定需要鉴权
  const stats = await fetchWithTimeout(
    `${base}/api/stats`,
    { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } },
    timeoutMs,
    fetchImpl,
  );
  if (!stats.response) {
    return failure('auth', `已连接但鉴权检查失败：${stats.error ?? '未知错误'}`, {
      url: base,
      latencyMs: health.elapsed,
      version,
      authRequired: true,
    });
  }

  if (stats.response.status === 401 || stats.response.status === 403) {
    return {
      reachable: true,
      version,
      authRequired: true,
      tokenValid: false,
      cardCount: null,
      latencyMs: health.elapsed,
      url: base,
      message: '已连接，但 token 无效（401）——请从服务端配置或管理面板重新获取',
      stage: 'auth',
    };
  }

  if (!stats.response.ok) {
    return failure('auth', `鉴权检查返回 HTTP ${stats.response.status}`, {
      url: base,
      latencyMs: health.elapsed,
      version,
      authRequired: true,
    });
  }

  let statsBody: Record<string, unknown> = {};
  try {
    statsBody = (await stats.response.json()) as Record<string, unknown>;
  } catch {
    statsBody = {};
  }
  const cards = statsBody['cards'];
  const cardCount =
    typeof cards === 'object' && cards !== null && typeof (cards as Record<string, unknown>)['total'] === 'number'
      ? ((cards as Record<string, unknown>)['total'] as number)
      : typeof statsBody['total'] === 'number'
        ? (statsBody['total'] as number)
        : null;

  return {
    reachable: true,
    version,
    authRequired: true,
    tokenValid: true,
    cardCount,
    latencyMs: health.elapsed,
    url: base,
    message:
      `已连接${version ? `（服务端 ${version}）` : ''}，token 有效` +
      (cardCount === null ? '' : `，现有 ${cardCount} 张卡`),
    stage: 'ok',
  };
}

/** 同步能力是否可用：只有"连上且 token 有效（或无需鉴权）"才算可用 */
export function isSyncReady(result: ProbeResult | null): boolean {
  if (!result || !result.reachable) return false;
  if (result.authRequired === false) return true;
  return result.tokenValid === true;
}
