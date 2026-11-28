/**
 * 功能
 * 连接与账号的相关配置：证书信任询问、仓库令牌上下文、仓库客户端配置、
 * 同步配置、自动探测服务器。从 EditorApp 搬出，5 个函数 148 行。
 *
 * 注意事项
 * 这五个都是**派生视图**（从 authSession / connection 算出调用方要的形状），
 * 除了 `offerCertTrust` 会写 `certAckedOrigins` / `certAsking`。
 *
 * `repoClientConfig` 在仓库令牌模式下**一律返回 null**：
 * 那个模式下 `accessToken` 返回的是令牌原文，而仓库管理接口只认账号令牌。
 * 返回非 null 会让 `/api/repos` 系列拿令牌去调，报 401 而不是"没权限"。
 *
 * 踩过的坑
 * `autoProbe` 失败时**不清空** `connection` —— "问不到"不等于"没配"。
 * 清掉会让顶栏从"未就绪"变成"没配置"，用户以为自己的设置丢了。
 */

import type { AuthSession } from '../auth/session';
import type { ProbeResult } from '../net/server-probe';
import type { SyncConfig } from '../sync/server-sync';
import type { RepoTokenContext } from '../sync/repo-select';

import { askConfirm, configGet, configPatch } from '../contract';
import { hasServerUrl } from '../auth/entry-policy';
import { disabledReason, repoTokenModeLabel } from '../auth/repo-token';
import { isOriginCertAcked, withCertAckedOrigin } from '../net/http-transport';
import { isSyncReady, probeServer } from '../net/server-probe';

/**
 * 功能
 * 本模块能碰的编辑器状态与动作。
 *
 * 注意事项
 * `certAckedOrigins` / `certAsking` 可写（信任询问的现场状态）；
 * `connection` 只在探测成功时换新，失败时保留旧值。
 *
 * 踩过的坑
 * 无。
 */
export interface ConnHost {
  /** 账号认证会话 */
  readonly authSession: AuthSession | null;
  /** 认证服务器地址。探测成功后会被修正 */
  authServerUrl: string;
  /** 连接探测结果。失败时保留旧值 */
  connection: ProbeResult | null;
  /** 已确认信任证书的 origin 列表 */
  certAckedOrigins: string[];
  /** 是否正在询问证书信任（防重入） */
  certAsking: boolean;
  /** 上次选的卡面来源。探测后会记住 */
  lastFaceChoice: string | null;
  /** 设置写入令牌 */
  settingsToken: string;

  setStatus(message: string, kind: 'info' | 'ok' | 'warn' | 'bad'): void;
  /** 把连接配置写进 ST */
  applyConnection(result: unknown): void;
}

export async function offerCertTrust(host: ConnHost, serverUrl: string): Promise<void> {
  if (host.certAsking) return;
  /* 已经确认过的 origin 不再问（autoProbe 会带 allowInvalidCert 直接成功） */
  if (isOriginCertAcked(host.certAckedOrigins, serverUrl)) return;

  host.certAsking = true;
  try {
    const origin = serverUrl.trim();
    const proceed = await askConfirm(
      `这个服务器的证书没通过系统校验（多半是自签证书）。\n\n` +
        `这意味着无法确认对面真的是这台服务器 —— 中间的任何人都有可能冒充它，` +
        `看到你的账号、令牌和卡片内容。\n\n` +
        `目标：${origin}\n\n` +
        `如果这是你自己部署的服务，可以继续；继续后不会再问这个地址。`,
      '这个服务器的证书不受信任',
    );
    if (!proceed) {
      host.setStatus('已取消：证书不受信任，同步保持不可用（本地功能不受影响）', 'warn');
      return;
    }

    host.certAckedOrigins = withCertAckedOrigin(host.certAckedOrigins, serverUrl);
    /*
     * 落盘失败也要继续重试 —— 用户已经点了确认，这一次能连上；
     * 只是下次启动会再问一遍。静默失败而不重试才是更糟的选择
     * （他会觉得"点了确认还是连不上"）。
     */
    try {
      await configPatch({ certAckedOrigins: host.certAckedOrigins });
    } catch {
      host.setStatus('已确认证书风险（本次有效，但没能存进配置，下次启动会再问一次）', 'warn');
    }

    const accountToken = host.authSession?.accessToken ?? '';
    const result = await probeServer({
      serverUrl,
      token: accountToken !== '' ? accountToken : host.settingsToken,
      allowInvalidCert: true,
    });
    host.applyConnection(result);
    host.setStatus(
      result.reachable ? '已连上（证书未经系统校验，已按你的确认继续）' : `仍然连不上：${result.message}`,
      result.reachable ? 'ok' : 'warn',
    );
  } finally {
    host.certAsking = false;
  }
}

export function repoClientConfig(host: ConnHost): { serverUrl: string; accessToken: string } | null {
  const connection = host.connection;
  const session = host.authSession;

  /*
   * 仓库令牌模式下**一律返回 null**（v0.1.4 / G1）。
   *
   * `AuthSession.accessToken` 那个 getter 在令牌模式下返回令牌**原文** ——
   * 那是让既有同步链路零改动的关键设计。但仓库管理（`/api/repos` 系列）
   * 只认账户令牌，把它交给这里等于拿 `tcr_` 去调，服务端必回 403。
   *
   * 原来只在两处 `getRepos` 各自挡了一下，**仓库对话框本身没挡**：
   * 于是令牌模式下打开「仓库与令牌」，看到的是"加载仓库列表失败：仓库令牌
   * 不能管理仓库…"这种把用户引向错误方向的提示。
   *
   * 挡在这里是唯一能覆盖全部调用点的位置（本函数只有三个调用点，
   * 都在"管理仓库"这条链上，上传走的是 server-sync 的另一套配置）。
   */
  if (session?.isRepoTokenMode === true) return null;

  const token = session?.accessToken ?? '';
  const serverUrl = connection?.url ?? host.authServerUrl;
  if (token === '' || serverUrl === '' || serverUrl === undefined) return null;
  return { serverUrl, accessToken: token };
}

export function repoTokenContext(host: ConnHost): RepoTokenContext | null {
  const session = host.authSession;
  if (session?.isRepoTokenMode !== true) return null;
  const caps = session.capabilities;
  return {
    repoId: session.repoTokenRepoId,
    repoName: session.repoTokenRepoName,
    label: repoTokenModeLabel(session.repoTokenRepoName),
    caps,
    reason: {
      upload: disabledReason('upload', caps),
      rollback: disabledReason('rollback', caps),
      delete: disabledReason('delete', caps),
      move: disabledReason('move', caps),
    },
  };
}

export function currentSyncConfig(host: ConnHost): SyncConfig | null {
  // v0.1.2 追加任务：**不再要求探测通过**。
  //
  // 上一版这里写着 `if (!isSyncReady(connection)) return null`，而 isSyncReady
  // 要求 tokenValid === true —— 于是"没登录"被表达成"同步配置为空"，
  // 卡片列表与同步面板于是说"未连接"。凭证只决定**能做什么**，
  // 不能决定"能不能开始"：这里只要有地址 + 有凭证就交出配置，
  // 请求失败由各面板自己报（那时才有真实错误可看）。
  const accountToken = host.authSession?.accessToken ?? '';
  const legacyToken = host.settingsToken ?? '';
  const token = accountToken !== '' ? accountToken : legacyToken;
  const serverUrl = host.connection?.url ?? host.authServerUrl;
  if (!hasServerUrl(serverUrl) || token === '') return null;
  /*
   * 用户已确认过这个 origin 的证书风险吗（2026-11-17）。
   *
   * 只有桌面端用得上（webview 的 fetch 无法配置证书校验）。
   * 注意这里是**每次现算**而不是缓存一个布尔：用户在设置里确认完
   * 立刻就要生效，缓存会让"确认了还是传不上去"。
   */
  return {
    serverUrl,
    token,
    ...(isOriginCertAcked(host.certAckedOrigins, serverUrl) ? { allowInvalidCert: true } : {}),
  };
}

export async function autoProbe(host: ConnHost): Promise<void> {
  let serverUrl = host.authServerUrl;
  let legacyToken = host.settingsToken;
  try {
    const config = await configGet();
    host.settingsToken = config.token;
    // 上次导出用的卡面（v0.1.4 / T12.5）：一次性读进来，导出面板换格式时不再打 IPC
    host.lastFaceChoice = config.lastFaceChoice ?? null;
    // 认证请求用的地址与探测用的地址同源：都没配置时一并留空，
    // 这样"点登录"会明确提示去设置里填地址，而不是打向一个默认端口
    host.authServerUrl = config.serverUrl;
    serverUrl = config.serverUrl;
    legacyToken = config.token;
    /* 用户以前确认过的证书风险（2026-11-17）；旧配置没有这个键 → 空表 */
    host.certAckedOrigins = Array.isArray(config.certAckedOrigins) ? config.certAckedOrigins : [];
  } catch {
    // 浏览器模式（无 C5 能力）读不到配置：回落到 ?serverUrl= 调试参数。
    // 这不是给正式用户用的入口 —— 壳里永远能读到配置，走不到这里。
  }

  if (!serverUrl.trim()) return;
  // 账户令牌优先：登录后顶栏的"已连接"依据的是**账户**身份，
  // 不能还拿 v0.1.1 的全局令牌去探（那会掩盖"登录没成功"）
  const accountToken = host.authSession?.accessToken ?? '';
  try {
    const result = await probeServer({
      serverUrl,
      token: accountToken !== '' ? accountToken : legacyToken,
      ...(isOriginCertAcked(host.certAckedOrigins, serverUrl) ? { allowInvalidCert: true } : {}),
    });
    host.applyConnection(result);
    /* 证书不受信任 → 问一次；确认后记住 origin 并重试（见方法注释） */
    if (result.certUntrusted) void offerCertTrust(host, serverUrl);
  } catch {
    // 探测失败：保持"未连接"，不影响本地功能
  }
}