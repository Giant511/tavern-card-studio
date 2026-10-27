/**
 * ST 访问地址的解析与校验（v0.1.6 / T14.0 F0）—— 纯逻辑、无 IO、无 DOM。
 *
 * ## 为什么单独一个模块
 *
 * 这条规则要同时被四个地方用到（F15 探针、推送面板的"运行中"判定、「打开 SillyTavern」
 * 跳转、v0.1.6 的 `/st/*` 代理目标），而它**又是安全边界**：host 必须回环。
 * 复制四份的下场是其中一份会松掉 —— 而松掉的那份就是攻击面。
 * 所以：**字符串里出现 `127.0.0.1:8000` 的地方只允许是默认值定义**，
 * 其余一律走 `resolveStAddress()`。
 *
 * ## 为什么 host 只能是回环（决策 #215）
 *
 * 内嵌代理（T14.1）的目标就是这个地址。如果允许填内网/外网地址，客户端就成了一台
 * **"带 UI 的通用 HTTP 反向代理"** —— 而配置文件是明文 JSON，诱导用户改一行
 * 就能把它指向任意主机。那时候它既是内网探测器（响应状态码/耗时），
 * 也是绕过浏览器同源策略的跳板（同源在 `tauri://` 自己这边）。
 *
 * 这条边界与 Rust 侧 `PROBE_ALLOWED_HOSTS` 是**同一条**：
 * 前端宽一格 → 探针报 `PROBE_HOST_NOT_ALLOWED`，用户看到的是"检测失败"，
 * 而真正的原因是配置被拒。所以两侧白名单必须逐字一致，测试对拍。
 */

// 显式 `.ts` 扩展名：这个文件要能被 Node 直接 `import`（单测加载的是源码，
// 不是编译产物），带 `.js` 在这里解析不到。与 `cards-path.ts` 的写法一致。
import { ST_DEFAULT_ADDRESS } from '../contract/types.ts';

/** 允许的 host（与 Rust `PROBE_ALLOWED_HOSTS` 逐字一致，测试对拍） */
export const ALLOWED_ST_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '::1'];

/** 默认地址的唯一来源（字面量只允许出现在 `contract/types.ts` 的默认值里） */
export { ST_DEFAULT_ADDRESS };

/** 端口下限/上限（1–65535） */
export const MIN_ST_PORT = 1;
export const MAX_ST_PORT = 65535;

export type StAddressFailureReason =
  /** 空串 */
  | 'empty'
  /** 没有 `:port`、或者有多余的路径/查询串 */
  | 'format'
  /** host 不在回环白名单 */
  | 'not-loopback'
  /** 端口不是 1–65535 的整数 */
  | 'bad-port';

export interface StAddressOk {
  ok: true;
  /** 归一后的 host（小写、去掉 IPv6 的方括号） */
  host: string;
  port: number;
  /** 拼好的基址，IPv6 会自动加方括号 */
  baseUrl: string;
  /** 归一后的 `host:port`（写回配置用） */
  text: string;
}

export interface StAddressFail {
  ok: false;
  reason: StAddressFailureReason;
  message: string;
}

export type StAddressParse = StAddressOk | StAddressFail;

/**
 * 解析 `host:port`。
 *
 * 宽容的地方只做"清理"，不做"猜测"：
 *   · 允许首尾空白、允许 `http://` 前缀（用户会从 ST 控制台的
 *     `Go to: http://127.0.0.1:8000/` 直接复制）、允许末尾斜杠；
 *   · **`https://` 明确拒绝**：ST 本机服务就是 http，静默把 https 当 http 处理
 *     等于悄悄改了用户的语义，而他会以为"我配了加密连接"。
 *   · 不做 DNS 解析：`localhost.evil.com` 必须被拒，交给 DNS 判断就等于把
 *     安全边界交给 hosts 文件与 DNS 投毒。
 */
export function parseStAddress(raw: string): StAddressParse {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') {
    return {
      ok: false,
      reason: 'empty',
      message: `请填地址，格式 \`主机:端口\`，例如 ${ST_DEFAULT_ADDRESS}`,
    };
  }

  if (/^https:\/\//i.test(trimmed)) {
    return {
      ok: false,
      reason: 'format',
      message: '这里只填本机 ST 的地址（http），不要带 https:// —— SillyTavern 的本机服务是 http',
    };
  }

  /*
   * 去掉 `http://` 与**末尾**斜杠，再检查还有没有路径。
   *
   * 顺序有讲究：用户从 ST 控制台粘进来的就是 `http://127.0.0.1:8000/`（带尾斜杠），
   * 先判"含不含 /"会把它误判成"带了路径"。第一版就是这么错的 ——
   * 单测里那条"容忍整条 URL"直接红了。
   */
  const withoutScheme = trimmed.replace(/^http:\/\//i, '').replace(/\/+$/, '');
  if (withoutScheme.includes('/')) {
    return {
      ok: false,
      reason: 'format',
      message: `只填 \`主机:端口\`，不要带路径（例如 ${ST_DEFAULT_ADDRESS}，而不是 …/chat）`,
    };
  }

  // 从**最后一个**冒号切：`::1:8000` 里前面的是 IPv6 的一部分
  const colon = withoutScheme.lastIndexOf(':');
  if (colon <= 0) {
    return {
      ok: false,
      reason: 'format',
      message: `缺少端口：请写成 \`主机:端口\`，例如 ${ST_DEFAULT_ADDRESS}`,
    };
  }
  const rawHost = withoutScheme.slice(0, colon);
  const rawPort = withoutScheme.slice(colon + 1);

  const host = rawHost
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '');

  if (!ALLOWED_ST_HOSTS.includes(host)) {
    return {
      ok: false,
      reason: 'not-loopback',
      message:
        `只支持本机地址（${ALLOWED_ST_HOSTS.join(' / ')}）—— 内嵌代理仅支持本机 ST，` +
        '远程 ST 请用「打开 SillyTavern」在浏览器里访问',
    };
  }

  if (!/^\d+$/.test(rawPort.trim())) {
    return { ok: false, reason: 'bad-port', message: `端口必须是数字：收到「${rawPort.trim()}」` };
  }
  const port = Number(rawPort.trim());
  if (!Number.isInteger(port) || port < MIN_ST_PORT || port > MAX_ST_PORT) {
    return {
      ok: false,
      reason: 'bad-port',
      message: `端口必须在 ${String(MIN_ST_PORT)}–${String(MAX_ST_PORT)} 之间：收到 ${String(port)}`,
    };
  }

  return { ok: true, host, port, baseUrl: baseUrlOf(host, port), text: `${host}:${String(port)}` };
}

/** 由 host/port 拼基址（IPv6 加方括号，否则 URL 解析会把它当端口分隔符） */
export function baseUrlOf(host: string, port: number): string {
  const bracketed = host.includes(':') ? `[${host}]` : host;
  return `http://${bracketed}:${String(port)}`;
}

/**
 * 从配置值解析出地址；**空串/未设置回落默认值**（不报错）。
 *
 * 为什么空串不算错误：`null` 表示"用户没改过"，那是正常状态 ——
 * 把它当错误会让首次启动的面板直接红一片。真正非法的值（比如用户手改配置文件
 * 填了 `192.168.1.5:8000`）仍然返回失败，由调用方明确告知。
 */
export function resolveStAddress(configured: string | null | undefined): StAddressOk {
  const value = typeof configured === 'string' ? configured.trim() : '';
  if (value === '') {
    const parsed = parseStAddress(ST_DEFAULT_ADDRESS);
    if (!parsed.ok) {
      // 默认值自己不合法属于代码 bug：让它在开发期就炸，而不是静默返回一个坏地址
      throw new Error(`默认 ST 地址不合法：${parsed.message}`);
    }
    return parsed;
  }
  const parsed = parseStAddress(value);
  if (parsed.ok) return parsed;
  // 配置里存了非法值（手改配置文件、或旧版本遗留）→ **回落默认值**并保持可用，
  // 而不是让整块功能瘫掉。设置面板会在打开时把这个坏值标出来让用户改。
  const fallback = parseStAddress(ST_DEFAULT_ADDRESS);
  if (!fallback.ok) throw new Error(`默认 ST 地址不合法：${fallback.message}`);
  return { ...fallback, text: value };
}

/** 这个配置值本身是否合法（设置面板用它决定要不要标红） */
export function isStAddressValid(configured: string | null | undefined): boolean {
  const value = typeof configured === 'string' ? configured.trim() : '';
  if (value === '') return true; // 未设置 = 用默认，合法
  return parseStAddress(value).ok;
}

// ── 探测失败的三态（需求 T14.0 第 2 条）────────────────────

/**
 * 连接失败的三类。**必须分开**，因为用户能做的事完全不同：
 *
 *   · `refused` —— 端口上没有服务。→ 去启动 ST，或者端口填错了；
 *   · `timeout` —— SYN 发出去没回应。→ 大概率被系统代理 / 防火墙 /
 *     安全软件拦住（本机回环被拦是常见的企业环境策略）；
 *   · `other`   —— 其它（地址解析不出、权限、协议栈异常）。→ 把原文给用户。
 *
 * 把三者合成一句"连接失败"，用户就只能瞎试 —— 而这三件事的下一步动作
 * 一个是"开 ST"、一个是"改代理设置"、一个是"看原文"。
 */
export type TcpFailureKind = 'refused' | 'timeout' | 'other';

export function classifyTcpFailure(errorKind: string | null | undefined): TcpFailureKind {
  const kind = (errorKind ?? '').toLowerCase();
  if (kind.includes('refused')) return 'refused';
  if (kind.includes('timedout') || kind.includes('timeout')) return 'timeout';
  return 'other';
}

/**
 * 把一次失败的探测翻译成"一句话 + 原始错误"。
 *
 * 原始错误**必须原样带上**：`TimedOut` 在代理环境和在防火墙环境下长得一样，
 * 但 `error_message` 里的 OS 原话（`os error 10060` / `actively refused`）能
 * 区分它们。用户把这句话发给维护者，才有得查。
 */
export function describeTcpFailure(probe: {
  host: string;
  port: number;
  errorKind: string | null;
  errorMessage: string | null;
  elapsedMs: number;
}): { kind: TcpFailureKind; summary: string; detail: string } {
  const kind = classifyTcpFailure(probe.errorKind);
  const target = `${probe.host}:${String(probe.port)}`;
  const detail =
    `${target} · ${probe.errorKind ?? '未知'} · ${String(probe.elapsedMs)}ms` +
    (probe.errorMessage === null ? '' : ` · ${probe.errorMessage}`);

  switch (kind) {
    case 'refused':
      return {
        kind,
        summary: `${target} 上没有服务在监听（连接被拒）—— SillyTavern 没启动，或者端口填错了`,
        detail,
      };
    case 'timeout':
      return {
        kind,
        summary:
          `${target} 连接超时（${String(probe.elapsedMs)}ms 内没有回应）—— ` +
          '通常是被系统代理 / 防火墙 / 安全软件拦住了本机回环连接',
        detail,
      };
    case 'other':
      return {
        kind,
        summary: `${target} 连接失败：${probe.errorMessage ?? probe.errorKind ?? '未知原因'}`,
        detail,
      };
  }
}
