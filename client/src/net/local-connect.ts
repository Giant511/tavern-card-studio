/**
 * 一键连接本机服务端（T9.13 / F6.1）。
 *
 * 这个模块只做**编排**：探测 → 取令牌 → 落配置 → 两步校验 → 给结论。
 * 每一步都可注入依赖，所以能在 Node 里单测（见 test/local-connect.test.mjs），
 * 不需要真起服务端，也不需要壳环境。
 *
 * 为什么固定探 `127.0.0.1:8730` 而不用已配置的 serverUrl：
 * 这个功能的场景就是「服务端装在本机、客户端还没配过」，此时配置里要么是空的，
 * 要么是上一次填错的地址 —— 拿它去探只会一错再错。
 *
 * 为什么不区分「未安装」与「未启动」：
 * 从渲染层看，两者都是"端口没人监听"，浏览器拿不到更细的信息
 * （不能读 ProgramData、不能查服务表）。与其猜一个可能错的结论，
 * 不如在文案里把两种可能都列出来，并给出各自的确认方法 —— 见 `explainLocalFailure`。
 */

import { probeServer, type ProbeResult } from './server-probe.ts';

/** 本机服务端的固定入口（与安装包的默认配置一致） */
export const LOCAL_API_ORIGIN = 'http://127.0.0.1:8730';
export const LOCAL_PANEL_ORIGIN = 'http://127.0.0.1:8731';

const DEFAULT_TIMEOUT_MS = 5000;

/** 本机探测的失败分类 —— UI 按这个分支给不同的处置建议 */
export type LocalFailureKind =
  /** 两个端口都没响应：服务没跑起来（未安装或未启动） */
  | 'not-running'
  /** API 不通但面板通：服务在跑，只是 API 端口被改过 */
  | 'port-changed'
  /** 服务在跑、也能取令牌，但来源不是回环（极少见：说明被代理/转发过） */
  | 'not-local'
  /** 取令牌被服务端拒绝（回环限制之外的其它原因，如未配置令牌） */
  | 'token-denied'
  /** 服务端是旧版本，根本没有 /api/token 接口（需要升级服务端） */
  | 'server-too-old'
  /** 网络层错误（超时、DNS、浏览器拦截） */
  | 'network'
  /** 配置写入失败 */
  | 'save-failed';

export interface LocalConnectSuccess {
  ok: true;
  token: string;
  authRequired: boolean;
  serverVersion: string | null;
  /** 写入后的地址（固定 127.0.0.1:8730） */
  serverUrl: string;
  /** 第二步校验的完整结果，UI 可展示卡片数与延迟 */
  probe: ProbeResult;
}

export interface LocalConnectFailure {
  ok: false;
  kind: LocalFailureKind;
  /** 面向用户的一句话 */
  message: string;
  /** 分步说明：失败在哪一步、下一步做什么 */
  steps: string[];
}

export type LocalConnectResult = LocalConnectSuccess | LocalConnectFailure;

export interface LocalConnectDeps {
  /** 默认全局 fetch；测试注入 */
  fetchImpl?: typeof fetch;
  /** 落配置（C5）。返回是否为壳环境 */
  persist: (patch: { serverUrl: string; token: string }) => Promise<void>;
  timeoutMs?: number;
}

interface HealthProbe {
  reachable: boolean;
  version: string | null;
  latencyMs: number | null;
}

/** 探测某个 origin 的 /api/health，只关心"通不通"和版本 */
async function probeHealth(
  origin: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<HealthProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetchImpl(`${origin}/api/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) {
      return { reachable: false, version: null, latencyMs: null };
    }
    const body = (await response.json()) as { version?: unknown; status?: unknown };
    // 必须校验 status === 'ok'，不能写成 `body.status === 'ok' || true` ——
    // 那样任何 2xx 都算"服务在跑"，而这个函数的返回值专门用来区分
    // 「本服务在跑」与「这个端口上恰好有别的 HTTP 服务」。
    // 2026-10-22 实测踩过：旧服务只监听局域网 IP，回环端口无人监听时，
    // 因为这条 `|| true` 把 404 也判成可达，最终误报成"面板能开、API 端口被改"。
    const isOurServer = body.status === 'ok';
    return {
      reachable: isOurServer,
      version: isOurServer && typeof body.version === 'string' ? body.version : null,
      latencyMs: isOurServer ? Date.now() - started : null,
    };
  } catch {
    return { reachable: false, version: null, latencyMs: null };
  } finally {
    clearTimeout(timer);
  }
}

interface TokenResult {
  ok: boolean;
  token: string;
  authRequired: boolean;
  status: number;
  code: string;
  message: string;
}

/** 取令牌。把服务端的 403/409 翻译成可区分的失败原因 */
async function fetchToken(
  origin: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<TokenResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${origin}/api/token`, {
      method: 'GET',
      signal: controller.signal,
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = {};
    }

    if (!response.ok) {
      const error = (body.error ?? {}) as { code?: unknown; message?: unknown };
      return {
        ok: false,
        token: '',
        authRequired: false,
        status: response.status,
        code: typeof error.code === 'string' ? error.code : `HTTP_${response.status}`,
        message: typeof error.message === 'string' ? error.message : text.slice(0, 200),
      };
    }

    const token = typeof body.token === 'string' ? body.token : '';
    if (token === '') {
      return {
        ok: false,
        token: '',
        authRequired: Boolean(body.authRequired),
        status: response.status,
        code: 'EMPTY_TOKEN',
        message: '服务端返回了空令牌',
      };
    }
    return {
      ok: true,
      token,
      authRequired: Boolean(body.authRequired),
      status: response.status,
      code: '',
      message: '',
    };
  } catch {
    return {
      ok: false,
      token: '',
      authRequired: false,
      status: 0,
      code: 'NETWORK',
      message: '取令牌请求失败（连接中断或超时）',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把一次失败翻译成「哪一步错了 + 怎么办」。
 *
 * 单独抽出来是为了可测：这三类文案是支持成本的大头，
 * 写错一个字就可能让用户跑去重装。
 */
export function explainLocalFailure(kind: LocalFailureKind, detail = ''): LocalConnectFailure {
  switch (kind) {
    case 'not-running':
      return {
        ok: false,
        kind,
        message: `本机 ${LOCAL_API_ORIGIN} 与面板 ${LOCAL_PANEL_ORIGIN} 都没有响应：服务端没有在运行。`,
        steps: [
          '情况 A｜**未安装**：到「控制面板 → 程序和功能」看有没有 Tavern Card Studio Server；没有就装服务端 MSI。',
          '情况 B｜**已安装但未启动**：打开「服务」(services.msc)，找 Tavern Card Studio Server，看状态是不是「已停止」；是就右键启动。',
          '两种情况从浏览器看是一样的（都是端口没人监听），所以上面两步都要看一眼。',
          '如果服务显示「正在启动」却一直起不来，看 C:\\ProgramData\\TavernCardStudio\\logs\\ 下的日志。',
        ],
      };

    case 'port-changed':
      return {
        ok: false,
        kind,
        message: `面板（${LOCAL_PANEL_ORIGIN}）能打开，但 API（${LOCAL_API_ORIGIN}）不通：服务在运行，只是 API 的监听地址被改过。`,
        steps: [
          '打开服务端管理面板，进「参数配置」页，看 **API 监听地址** 与 **API 端口** 这两项的实际值。',
          '常见情况：为了给局域网用，把监听地址改成了本机网卡 IP（如 192.168.1.203）—— 这时 127.0.0.1:8730 自然连不上。',
          '回到这里把「服务端地址」填成面板上显示的那个地址（例：http://192.168.1.203:8730），再点「测试连接」。',
          '若希望一键连接可用，就把监听地址改回 127.0.0.1；面板的「管理面板监听地址」是另一项，不受影响。',
        ],
      };

    case 'not-local':
      return {
        ok: false,
        kind,
        message: '服务端拒绝把令牌交给本机：请求看起来不是从 127.0.0.1 发起的。',
        steps: [
          '检查是否设置了系统代理或全局 VPN：它们会让发往 127.0.0.1 的请求经过外部转发。',
          '临时关闭代理后重试；或改用「手动填令牌」（从服务端日志复制）。',
        ],
      };

    case 'server-too-old':
      return {
        ok: false,
        kind,
        message: '服务端在运行，但它的版本不支持一键取令牌 —— 需要升级服务端。',
        steps: [
          '现在这台机器上的服务端是旧版本（没有 /api/token 接口）。',
          '装新版本的服务端 MSI 覆盖安装即可，配置与卡片数据都会保留。',
          '升级前也可以先用「手动填令牌」：打开服务端管理面板 → 「API 与令牌」页复制令牌，粘到上面。',
        ],
      };

    case 'token-denied':
      return {
        ok: false,
        kind,
        message: `取令牌被拒绝：${detail || '服务端未返回原因'}`,
        steps: [
          '打开服务端管理面板，进「API 与令牌」页确认令牌已生成。',
          '若面板显示「未启用鉴权」，说明服务端不校验令牌，客户端令牌可以留空。',
          '若仍失败，从服务端日志复制令牌，用「手动填令牌」的方式连接。',
        ],
      };

    case 'network':
      return {
        ok: false,
        kind,
        message: `连接本机服务端时网络出错：${detail || '未知原因'}`,
        steps: [
          '确认没有把 127.0.0.1 指向代理（系统代理设置里的「例外」应包含 127.0.0.1;localhost）。',
          '确认本机防火墙没有拦截回环连接（通常不会，但公司策略机可能有）。',
        ],
      };

    case 'save-failed':
      return {
        ok: false,
        kind,
        message: `令牌取到了，但配置没能保存：${detail || '未知原因'}`,
        steps: [
          '浏览器模式下配置不会持久化，请在桌面客户端里操作。',
          '若是桌面客户端，检查配置文件目录是否可写。',
        ],
      };
  }
}

/**
 * 执行「连接本机服务端」。
 *
 * 顺序（对应需求 F6.1 的 a–d）：
 *   a. 探 127.0.0.1:8730/api/health
 *   b. 可达 → 取令牌
 *   c. 写入 serverUrl + token（C5 持久化）
 *   d. 用 probeServer 做两步校验，给出最终结论
 *
 * **c 在 d 之前**是有意的：先落盘再验证，用户即便看到"校验失败"，
 * 地址和令牌也已经填好了，可以直接点「测试连接」重试，不用重新走一遍流程。
 */
export async function connectLocalServer(deps: LocalConnectDeps): Promise<LocalConnectResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // ── a. 探 API ────────────────────────────────────────
  const health = await probeHealth(LOCAL_API_ORIGIN, fetchImpl, timeoutMs);

  if (!health.reachable) {
    // API 不通时再看一眼面板：面板通说明服务在跑，只是端口变了
    const panel = await probeHealth(LOCAL_PANEL_ORIGIN, fetchImpl, timeoutMs);
    if (panel.reachable) {
      return explainLocalFailure('port-changed');
    }
    return explainLocalFailure('not-running');
  }

  // ── b. 取令牌 ────────────────────────────────────────
  const tokenResult = await fetchToken(LOCAL_API_ORIGIN, fetchImpl, timeoutMs);
  if (!tokenResult.ok) {
    if (tokenResult.code === 'TOKEN_LOCAL_ONLY') {
      return explainLocalFailure('not-local');
    }
    if (tokenResult.code === 'NETWORK') {
      return explainLocalFailure('network', tokenResult.message);
    }
    // 旧版服务端没有 /api/token 这个路由：请求会一路走到鉴权门，
    // 然后被当成"访问受保护路径但没带令牌" → 401 UNAUTHORIZED。
    //
    // 这与"令牌错了"必须分开报：401 在旧服务端上根本不代表令牌有问题
    // （我们还没令牌可错）。真机实测过这个分支（装着的服务是旧版 MSI），
    // 如果笼统报成 token-denied，用户会去反复检查令牌，而正确动作是升级。
    if (tokenResult.status === 401 && tokenResult.code === 'UNAUTHORIZED') {
      return explainLocalFailure('server-too-old');
    }
    return explainLocalFailure('token-denied', tokenResult.message);
  }

  // ── c. 落配置 ────────────────────────────────────────
  try {
    await deps.persist({ serverUrl: LOCAL_API_ORIGIN, token: tokenResult.token });
  } catch (error) {
    return explainLocalFailure('save-failed', error instanceof Error ? error.message : String(error));
  }

  // ── d. 两步校验（复用 T6.8 的 probeServer，不另写一套）─────
  const probe = await probeServer(
    { serverUrl: LOCAL_API_ORIGIN, token: tokenResult.token },
    { fetchImpl, timeoutMs },
  );

  if (!probe.reachable) {
    // 刚刚还通，落盘之后不通了 —— 只可能是配置写坏或服务在这几毫秒里挂了
    return explainLocalFailure('network', probe.message);
  }
  if (probe.tokenValid === false) {
    return explainLocalFailure('token-denied', '令牌被服务端判定为无效');
  }

  return {
    ok: true,
    token: tokenResult.token,
    authRequired: tokenResult.authRequired,
    serverVersion: probe.version ?? health.version,
    serverUrl: LOCAL_API_ORIGIN,
    probe,
  };
}

/** 成功时给用户的一句话（区分"必须校验"与"不校验也能连"） */
export function describeLocalSuccess(result: LocalConnectSuccess): string {
  const parts = [`已连接（服务端 ${result.serverVersion ?? '版本未知'}）`];
  if (result.authRequired) {
    parts.push('令牌有效');
  } else {
    parts.push('服务端未启用鉴权，令牌填不填都能连');
  }
  if (result.probe.cardCount !== null) {
    parts.push(`现有 ${result.probe.cardCount} 张卡`);
  }
  if (result.probe.latencyMs !== null) {
    parts.push(`${result.probe.latencyMs} ms`);
  }
  return parts.join(' · ');
}

/**
 * 便捷入口：连接本机服务端并落配置（自动决定是否持久化）。
 *
 * 为什么单独抽一个：设置面板与同步面板**各要一个按钮**（需求 F6.1），
 * 如果两边各写一遍「判断是否壳环境 → configPatch → 处理异常」，
 * 迟早出现一边能存一边存不上的分歧。这里只写一次。
 *
 * 浏览器模式下 persist 是空操作，但返回值里的 `persisted` 会明确告诉 UI
 * 「这次没有真正保存」—— 不假装成功。
 */
export async function connectLocalService(
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<LocalConnectResult & { persisted: boolean }> {
  // 延迟导入：让本模块在 Node 测试环境里也能加载（契约层依赖 @tauri-apps/*）
  const contract = await import('../contract');
  const canPersist = contract.isShellAvailable();

  const result = await connectLocalServer({
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    persist: async (patch) => {
      if (!canPersist) return;
      await contract.configPatch({ serverUrl: patch.serverUrl, token: patch.token });
    },
  });

  return { ...result, persisted: canPersist };
}
