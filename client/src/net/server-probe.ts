/**
 * 服务端连接探测（T6.8；2026-11-17 改走传输层）。
 *
 * 设计要点：
 *   1. **传输层可换**：桌面壳走原生命令（`server_http_request`），
 *      浏览器走 `fetch`（服务端已返回 `Access-Control-Allow-Origin: *`）。
 *      ★ 原来是"一律用 fetch"—— 那在桌面端有个死结：webview 的证书校验
 *      无法配置，自签证书一律被拒，而失败只剩一个 `TypeError`，
 *      界面上就变成"端口没开"（memory §105 的原始缺陷）。
 *   2. **分两步判定**：`/api/health` 是公开接口（只证可达），
 *      `/api/stats` 需鉴权（才证 token 有效）。只测前者会把"token 错了"误报成"连上了"；
 *   3. **必须有超时**：服务端挂掉时 `fetch` 可能长时间悬挂，用 AbortController 兜住，
 *      否则设置面板会一直转圈；
 *   4. 纯函数 + 可注入 fetch，便于离线单测（见 test/client-settings.test.mjs）。
 */

import {
  createFetchTransport,
  defaultTransport,
  type HttpTransport,
} from './http-transport.ts';

export interface ServerConfigInput {
  serverUrl: string;
  token: string;
  /**
   * 用户已确认这个 origin 的证书风险（2026-11-17）。
   *
   * ★ 只有桌面壳会真的用它（浏览器 fetch 无法配置证书校验）。
   * 语义是"别先失败一次"—— 已经确认过的地址直接带跳过校验去连，
   * 免得界面先闪一下"连不上"再变绿。
   */
  allowInvalidCert?: boolean;
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
  /** 服务端现有卡片数（仅在 token 有效时拿到；T10.8 起是**本凭证可见**的条数） */
  cardCount: number | null;
  /**
   * 服务端是否按凭证强制隔离（T10.8）。
   *
   *  = 服务端已经在服务端侧过滤，客户端不该再显示尚未按账户过滤之类提示
   * —— 那种提示会变成永远为真的免责声明。
   *  /  = 旧版服务端（v0.1.2 之前），确实没有隔离，提示必须留着。
   */
  isolationEnforced: boolean | null;
  /** health 往返耗时（毫秒） */
  latencyMs: number | null;
  /** 归一化后的地址（失败时为 null） */
  url: string | null;
  /**
   * 证书不受信任（2026-11-17）。
   *
   * 只有**桌面壳**能给出确定的 true —— 它走原生命令的两段探测：
   * 正常校验失败、跳过校验成功 ⇒ 证实就是证书问题。浏览器端的 fetch
   * 拿不到这个信号，所以恒为 false（那里也没法给"继续"的出口）。
   *
   * 这一位是"能不能给出继续按钮"的唯一依据。**不要**用文案匹配去猜。
   */
  certUntrusted: boolean;
  /** 面向用户的一句话结论 */
  message: string;
  /** 细分阶段，便于 UI 决定提示位置 */
  stage: 'url' | 'cert' | 'health' | 'auth' | 'ok';
}

const DEFAULT_TIMEOUT_MS = 6000;

export interface ProbeOptions {
  timeoutMs?: number;
  /**
   * 便于测试注入；默认用全局 fetch。
   *
   * ★ 只有在**没有**显式给 `transport` 时才生效（保留它是为了不破坏
   * 已有的那批测试 —— 它们全都注入 fetchImpl 来模拟 401/404/断网）。
   */
  fetchImpl?: typeof fetch;
  /**
   * 传输层（2026-11-17）。不给就按环境自动选：
   * 桌面壳走原生命令（能识别证书），浏览器走 fetch。
   *
   * 为什么要能注入：`certUntrusted` 只有原生命令能给，而单测里
   * 不该去起一个 Tauri 壳。注入一个返回 cert 失败的替身即可覆盖那条分支。
   */
  transport?: HttpTransport;
  /**
   * 用户已确认过证书风险的 origin 是否包含当前地址（2026-11-17）。
   *
   * 传 true 时第一次请求就带 `allowInvalidCert`，不会先失败一次
   * （否则每次探测都白跑一次失败请求，界面还会闪一下错误）。
   */
  allowInvalidCert?: boolean;
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
    isolationEnforced: null,
    latencyMs: null,
    url: null,
    message,
    stage,
    /* 默认 false：只有确认过的证书问题才置 true（见字段注释） */
    certUntrusted: extra.certUntrusted === true,
    ...extra,
  };
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
  /*
   * 传输层：显式给了就用给的；否则有 fetchImpl 就用它（兼容老测试）；
   * 都没给就按环境自动选（桌面壳 → 原生命令，浏览器 → fetch）。
   */
  const transport =
    options.transport ??
    (options.fetchImpl === undefined
      ? defaultTransport()
      : createFetchTransport(options.fetchImpl));

  /*
   * ★ 两个来源都要认（2026-11-17）。
   *
   * `input.allowInvalidCert` 是"这个地址我已经确认过"（来自配置）；
   * `options.allowInvalidCert` 是"这一次探测就按跳过校验走"（确认后重试用）。
   * 我第一版只读了 options，于是外壳传在 input 里的确认状态被**静默丢掉** ——
   * 现象是"确认过了下次启动还是要确认"，而这点在单测里才暴露。
   */
  const allowInvalidCert = options.allowInvalidCert === true || input.allowInvalidCert === true;

  const checked = normalizeServerUrl(input.serverUrl);
  if (!checked.ok) {
    return failure('url', checked.message);
  }
  const base = checked.url;

  // ① 可达性：/api/health 是公开路径，不需要 token
  const health = await transport({
    url: `${base}/api/health`,
    method: 'GET',
    headers: { Accept: 'application/json' },
    timeoutMs,
    ...(allowInvalidCert ? { allowInvalidCert: true } : {}),
  });
  if (health.status === null) {
    /*
     * ★ 证书要**单独一个阶段**（memory §105 缺陷 ①）。
     *
     * 原来这里只有一句「地址不通、端口未开、或服务端未启动」，
     * 而证据显示真因是自签证书（8ms 快速失败、`curl -k` 立刻 200）。
     * 把证书问题说成端口问题，用户会去查一件根本没坏的事。
     *
     * `errorKind === 'cert'` 是**证实过**的（原生通道两段探测），
     * 不是猜的 —— 只有它才给"确认后可继续"的出口。
     */
    if (health.errorKind === 'cert') {
      return failure('cert', health.error ?? '证书不受信任', {
        url: base,
        latencyMs: health.elapsedMs,
        certUntrusted: true,
      });
    }
    return failure('health', health.error ?? '连接失败', {
      url: base,
      latencyMs: health.elapsedMs,
    });
  }
  if (health.status < 200 || health.status >= 300) {
    return failure('health', `服务端返回 HTTP ${String(health.status)}（该地址不是本服务？）`, {
      url: base,
      latencyMs: health.elapsedMs,
    });
  }

  let healthBody: Record<string, unknown> = {};
  try {
    healthBody = JSON.parse(health.text ?? '') as Record<string, unknown>;
  } catch {
    return failure('health', '这个地址返回的内容无法识别（可能不是 Tavern Card Studio 服务端）', {
      url: base,
      latencyMs: health.elapsedMs,
    });
  }

  if (healthBody['status'] !== 'ok') {
    return failure('health', '服务端状态异常（health.status 不是 ok）', {
      url: base,
      latencyMs: health.elapsedMs,
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
      isolationEnforced: null,
      latencyMs: health.elapsedMs,
      url: base,
      message: `已连接${version ? `（服务端 ${version}）` : ''}，服务端未启用鉴权`,
      stage: 'ok',
      certUntrusted: false,
    };
  }

  // ③ 要求鉴权但没填 token
  //
  // 措辞注意（v0.1.2 追加任务）：没令牌**不是**失败，也不该读起来像服务端在索要令牌。
  // 0.1.2 起 login / register / refresh / config 都是免鉴权端点，
  // "没登录"只意味着同步用不了，不意味着连不上。
  const token = input.token.trim();
  if (token === '') {
    return {
      reachable: true,
      version,
      authRequired: true,
      tokenValid: null,
      cardCount: null,
      isolationEnforced: null,
      latencyMs: health.elapsedMs,
      url: base,
      message: `已连接${version ? `（服务端 ${version}）` : ''}，未登录：登录后可同步`,
      stage: 'auth',
      certUntrusted: false,
    };
  }

  // ④ 用受保护接口验证 token：/api/stats 轻量且一定需要鉴权
  const stats = await transport({
    url: `${base}/api/stats`,
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    timeoutMs,
    ...(allowInvalidCert ? { allowInvalidCert: true } : {}),
  });
  if (stats.status === null) {
    return failure('auth', `已连接但鉴权检查失败：${stats.error ?? '未知错误'}`, {
      url: base,
      latencyMs: health.elapsedMs,
      version,
      authRequired: true,
    });
  }

  if (stats.status === 401 || stats.status === 403) {
    return {
      reachable: true,
      version,
      authRequired: true,
      tokenValid: false,
      cardCount: null,
      isolationEnforced: null,
      latencyMs: health.elapsedMs,
      url: base,
      message: '已连接，但访问令牌无效 —— 请从服务端配置或管理面板重新获取',
      stage: 'auth',
      certUntrusted: false,
    };
  }

  if (stats.status < 200 || stats.status >= 300) {
    return failure('auth', `鉴权检查返回 HTTP ${String(stats.status)}`, {
      url: base,
      latencyMs: health.elapsedMs,
      version,
      authRequired: true,
    });
  }

  let statsBody: Record<string, unknown> = {};
  try {
    statsBody = JSON.parse(stats.text ?? '') as Record<string, unknown>;
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
    // 只有服务端明确说 true 才算已隔离；缺字段 = 旧版服务端 = 未隔离
    isolationEnforced: statsBody['isolationEnforced'] === true,
    latencyMs: health.elapsedMs,
    url: base,
    message:
      `已连接${version ? `（服务端 ${version}）` : ''}，token 有效` +
      (cardCount === null ? '' : `，现有 ${cardCount} 张卡`),
    stage: 'ok',
    certUntrusted: false,
  };
}

/** 同步能力是否可用：只有"连上且 token 有效（或无需鉴权）"才算可用 */
export function isSyncReady(result: ProbeResult | null): boolean {
  if (!result || !result.reachable) return false;
  if (result.authRequired === false) return true;
  return result.tokenValid === true;
}
