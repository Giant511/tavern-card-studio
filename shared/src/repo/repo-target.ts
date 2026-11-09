/**
 * 仓库服务端地址策略（2026-11-04，T15.2 决策④）。
 *
 * ## 用户拍板的规则
 *
 * > ④ 服务端地址策略：内置云仓库 ai.gezblog.xyz:8730，强制 https；
 * > 用户可下拉切换为自定义仓库（自部署实例，同一套服务端软件）。
 *
 * 再加两条细化：
 *
 * ```text
 *   内置云仓库：地址 ai.gezblog.xyz，端口 8730，强制 https **不可降级**
 *   自定义仓库：用户填地址与端口；填 http:// 弹风险提示，
 *               用户确认后才允许保存；https:// 不提示
 * ```
 *
 * ## 为什么这一段要单独成模块、且是纯函数
 *
 * 地址归一化看起来是"字符串处理"，实际上决定了三件事：
 *
 * 1. **请求打到哪台机器**（打错就是"账号不存在"或Token泄露到别人服务器）
 * 2. **明文确认的作用域**（确认过一次 `http://a` 不能顺带放行 `http://b`）
 * 3. **能不能降级**（内置云仓库一旦允许 http，同一个账号的令牌就会明文过网）
 *
 * 三件都不能靠"点保存时临时判一下"——那会散落在多处，改一处漏一处。
 * 所以收在这里，用判据逐条钉。
 */

/** 仓库地址类型 */
export type RepoTargetKind = 'cloud' | 'custom';

/** 内置云仓库的主机名（决策④，不可改） */
export const CLOUD_REPO_HOST = 'ai.gezblog.xyz';

/**
 * 内置云仓库的端口（决策④）。
 *
 * ★ 2026-11-04 用户更正：**是 443，不是 8730**。
 *
 * 8730 是自部署实例的**默认 HTTP 端口**（管理面板里 "HTTP 监听 ...:8730"），
 * 而云仓库走的是标准 HTTPS 端口 —— 前面有反代，用户不需要知道端口。
 *
 * 443 是 https 的默认端口，所以 `CLOUD_REPO_ORIGIN` 里**不写端口**：
 * `https://h:443` 与 `https://h` 是同一个地方，写出来只是噪音。
 */
export const CLOUD_REPO_PORT = 443;

/**
 * 内置云仓库的完整地址。
 *
 * ★ 这里写死 `https`，并且**没有第二个参数能把它换成 http** ——
 * "强制 https 不可降级"在类型层面就成立，不靠调用方自觉。
 *
 * ★ 443 是默认端口，所以 origin 里不带 `:443`。
 */
export const CLOUD_REPO_ORIGIN = `https://${CLOUD_REPO_HOST}`;

/** 内置模式下页面固定显示这句（用户指定文案，不要改写） */
export const CLOUD_INVITE_HINT = '内置云仓库需找开发者拿邀请码才可注册登录';

/** 落盘的仓库配置 */
export interface RepoConfigState {
  kind: RepoTargetKind;
  /**
   * 自定义仓库地址（用户原样输入）。
   *
   * 不在写入时归一化 —— 保留用户输入，让他还能继续编辑。
   * 归一化发生在读取（`resolveRepoOrigin`）时。
   */
  customAddress: string;
  /**
   * 用户已确认过"明文也能用"的那个 origin（归一化后）。
   *
   * ## 为什么只存一个，不存一串
   *
   * 自定义地址只有一个输入框。存一串意味着"以前确认过的地址永远有效"——
   * 用户把地址改成了别的 http 机器，却因为历史上确认过另一台而**静默放行**。
   * 只存一个，改了就要重新确认，才符合"确认的对象是这台机器"。
   *
   * 空串 = 从未确认。
   */
  ackedPlainOrigin: string;
  /**
   * 用户已确认"信任这台服务器的证书"的 origin 列表（2026-11-04）。
   *
   * ## 为什么这个要持久化、而且要存一串
   *
   * **自签证书**的 https 是加密的，但"对端是谁"没人担保 —— 系统会拒绝连接。
   * 用户确认过一次"这是我自己部署的服务"之后，**不该每次重进 App 都问一遍**。
   *
   * 理由不是"省事"，而是：反复问同一个问题会**训练用户无脑点确认**，
   * 那比不问更糟（真出问题时他也照点）。问一次、记住、以后不再问。
   *
   * ## 为什么允许一串（和 `ackedPlainOrigin` 相反）
   *
   * 明文确认的对象是"当前这一个地址"（地址只有一个输入框，改了就该重问）；
   * 而证书信任是**用户对自己服务器的长期判断**，切换回以前用过的
   * 自签服务器不该重问。两者语义不同，所以存储形态不同。
   *
   * ★ 只影响**证书校验**，不影响协议：`http://` 仍然走明文闸门。
   */
  trustedCertOrigins: string[];
}

/** 空配置：默认走内置云仓库（用户装了就能用） */
export function emptyRepoConfig(): RepoConfigState {
  return { kind: 'cloud', customAddress: '', ackedPlainOrigin: '', trustedCertOrigins: [] };
}

/** 地址解析结果 */
export interface ParsedRepoAddress {
  /** 归一化后的 origin，如 `https://ai.gezblog.xyz:8730` */
  origin: string;
  scheme: 'http' | 'https';
  host: string;
  /** 显式端口；未写时为 null（用协议默认端口） */
  port: number | null;
}

export type ParseAddressResult =
  | { ok: true; address: ParsedRepoAddress }
  | { ok: false; reason: string };

/**
 * 解析用户输入的仓库地址。
 *
 * ## 接受哪些写法
 *
 * ```text
 *   ai.gezblog.xyz            → https://ai.gezblog.xyz
 *   ai.gezblog.xyz:8730       → https://ai.gezblog.xyz:8730
 *   http://1.2.3.4:8730       → http://1.2.3.4:8730
 *   https://h:8730/           → https://h:8730        （去掉尾斜线）
 *   HTTPS://Host:8730         → https://host:8730     （协议小写、主机小写）
 * ```
 *
 * ## 为什么"没写协议"默认 https 而不是 http
 *
 * 没写协议的用户多半只想填个域名。默认 https 是**安全的一侧**：
 * 万一对方不支持，报的是明确的连接失败；默认 http 则是"默默用了明文"，
 * 事后无从察觉。宁可让用户多改一次。
 *
 * @param input 用户输入
 * @param defaultScheme 未写协议时用哪个（默认 https）
 */
export function parseRepoAddress(
  input: string,
  defaultScheme: 'http' | 'https' = 'https',
): ParseAddressResult {
  const raw = input.trim();
  if (raw === '') return { ok: false, reason: '请填写仓库地址' };

  /* 抓协议前缀。`//host` 这种省略协议的写法也当"没写协议" */
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(raw);
  let scheme: 'http' | 'https';
  let rest: string;

  if (schemeMatch === null) {
    scheme = defaultScheme;
    rest = raw;
  } else {
    const got = schemeMatch[1]?.toLowerCase() ?? '';
    if (got !== 'http' && got !== 'https') {
      return { ok: false, reason: `不支持 ${got}:// 这种协议，只能填 http 或 https` };
    }
    scheme = got;
    rest = raw.slice(schemeMatch[0].length);
  }

  /* 去掉路径/查询/hash —— 只留 host[:port] */
  const cut = rest.search(/[/?#]/);
  if (cut >= 0) rest = rest.slice(0, cut);
  if (rest === '') return { ok: false, reason: '地址里没有主机名' };

  /*
   * 拆主机与端口。
   *
   * 用"最后一个冒号"而不是 split(':')：IPv6 字面量形如 `[::1]:8730`，
   * 里面本来就有冒号。这里先处理方括号形式，再处理普通 host:port。
   */
  let host: string;
  let portText: string | null = null;

  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close < 0) return { ok: false, reason: 'IPv6 地址缺少右方括号' };
    host = rest.slice(0, close + 1);
    const after = rest.slice(close + 1);
    if (after.startsWith(':')) portText = after.slice(1);
    else if (after !== '') return { ok: false, reason: 'IPv6 地址后面只能跟端口' };
  } else {
    const idx = rest.lastIndexOf(':');
    if (idx >= 0) {
      host = rest.slice(0, idx);
      portText = rest.slice(idx + 1);
    } else {
      host = rest;
    }
  }

  host = host.trim().toLowerCase();
  if (host === '') return { ok: false, reason: '地址里没有主机名' };

  /* 主机名合法性：只允许字母数字、点、连字符、方括号（IPv6） */
  if (!/^\[[0-9a-f:.]+\]$/.test(host) && !/^[a-z0-9.-]+$/.test(host)) {
    return { ok: false, reason: '地址里有不认识的字符，只填域名或 IP 即可' };
  }
  if (host === '.' || host.startsWith('.') || host.endsWith('.')) {
    return { ok: false, reason: '域名的点号位置不对' };
  }

  let port: number | null = null;
  if (portText !== null && portText !== '') {
    if (!/^\d+$/.test(portText)) return { ok: false, reason: '端口必须是数字' };
    const n = Number(portText);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return { ok: false, reason: '端口要在 1–65535 之间' };
    }
    port = n;
  }

  /*
   * 默认端口不写进 origin —— `https://h:443` 与 `https://h` 是同一个地方，
   * 两种写法算成两个 origin 的话，"确认过明文"和"登录态"都会对不上。
   */
  const isDefaultPort = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80);
  const portPart = port === null || isDefaultPort ? '' : `:${String(port)}`;

  return {
    ok: true,
    address: { origin: `${scheme}://${host}${portPart}`, scheme, host, port: isDefaultPort ? null : port },
  };
}

/**
 * 当前生效的仓库 origin。
 *
 * - `cloud` 模式**永远**返回 `CLOUD_REPO_ORIGIN`，用户输入一概不看 ——
 *   这就是"不可降级"的落点：即使 localStorage 被手改成 http，这里仍然给 https。
 * - `custom` 模式解析用户输入。
 */
export function resolveRepoOrigin(state: RepoConfigState): ParseAddressResult {
  if (state.kind === 'cloud') {
    return {
      ok: true,
      address: {
        origin: CLOUD_REPO_ORIGIN,
        scheme: 'https',
        host: CLOUD_REPO_HOST,
        /*
         * 443 是默认端口 ⇒ `port` 给 null，与 `parseRepoAddress` 的语义一致
         * （那个字段的含义是"**显式**非默认端口"，未写时 null）。
         *
         * 两处语义一致很重要：调用方若拿 `port` 拼地址，443 会让
         * origin 变成 `https://h:443`，与 `CLOUD_REPO_ORIGIN` 不相等，
         * 于是"是否同一台机器"的判断会错。
         */
        port: null,
      },
    };
  }
  return parseRepoAddress(state.customAddress);
}

/** 这个 origin 是否需要"明文传输"风险确认 */
export function isPlainHttpOrigin(origin: string): boolean {
  return origin.startsWith('http://');
}

/**
 * 保存前是否必须先弹风险提示。
 *
 * ## 判定规则
 *
 * ```text
 *   https://…                     → 不需要
 *   http://…  且 已确认过这同一个 → 不需要（同一台机器不重复打扰）
 *   http://…  且 没确认过 / 换了  → 需要
 *   cloud 模式                    → 永远不需要（它是 https）
 * ```
 *
 * ★ 比较的是**归一化后的 origin**。用户把 `http://a:8730` 改成 `http://A:8730/`，
 * 归一化后相同 ⇒ 不重复问；改成 `http://b:8730` ⇒ 必须重问。
 */
export function needsPlainHttpAck(state: RepoConfigState, origin: string): boolean {
  if (state.kind === 'cloud') return false;
  if (!isPlainHttpOrigin(origin)) return false;
  return state.ackedPlainOrigin !== origin;
}

/** 风险提示文案（用户要求说清明文传输的后果） */
export const PLAIN_HTTP_RISK_TITLE = '这个地址是明文传输';

export const PLAIN_HTTP_RISK_BODY =
  'http:// 不加密。你的账号、令牌和卡片内容会以明文经过网络，' +
  '可能被同一网络里的其他人窃听或篡改。只在你确定这个地址可信时继续。';

/**
 * 从磁盘读回来的配置。
 *
 * ## 校验纪律
 *
 * 与 `parsePersonaState` 同一条：坏值丢掉、好值保留、**不整批作废**。
 * 特别地：
 *
 * - `kind` 只认 `cloud` / `custom`，其他值一律回落到 `cloud`
 *   （回落方向选 cloud 而不是 custom：cloud 是"能用"的那个，custom 空地址是"不能用"）
 * - `ackedPlainOrigin` 必须是**合法的 http origin**，否则清空 ——
 *   留着一条脏值会让"确认过明文"这个闸门失效
 */
export function parseRepoConfig(raw: unknown): RepoConfigState {
  const base = emptyRepoConfig();
  if (raw === null || typeof raw !== 'object') return base;
  const obj = raw as Record<string, unknown>;

  const kind = obj['kind'] === 'custom' ? 'custom' : 'cloud';
  const customAddress = typeof obj['customAddress'] === 'string' ? obj['customAddress'] : '';

  let ackedPlainOrigin = '';
  const acked = typeof obj['ackedPlainOrigin'] === 'string' ? obj['ackedPlainOrigin'].trim() : '';
  if (acked !== '') {
    /*
     * ★ 只解析一次，用解析结果判 scheme —— 不要先 `startsWith('http://')` 再解析。
     *
     * 这是本模块第一版的真 bug：前置判断用了大小写敏感的
     * `isPlainHttpOrigin(acked)`，于是存成 `HTTP://A.com:8730/` 的合法值
     * 被判成"不是 http"清空了 —— 而下面 `parseRepoAddress` 明明能正确解析它。
     *
     * 「两处各判一次」必然分叉。判一次，用结果。
     */
    const parsed = parseRepoAddress(acked);
    if (parsed.ok && parsed.address.scheme === 'http') ackedPlainOrigin = parsed.address.origin;
  }

  /*
   * 证书信任列表：逐项校验 —— 只收能解析成 https 或 http origin 的值。
   *
   * `http` 也收：明文闸门与证书是两件事，一个地址完全可能既确认过明文
   * 又确认过证书（虽然实际不会用到证书校验）。
   */
  const trustedRaw = Array.isArray(obj['trustedCertOrigins']) ? obj['trustedCertOrigins'] : [];
  const trustedCertOrigins: string[] = [];
  for (const item of trustedRaw) {
    if (typeof item !== 'string' || item.trim() === '') continue;
    const parsed = parseRepoAddress(item);
    if (!parsed.ok) continue;
    if (!trustedCertOrigins.includes(parsed.address.origin)) {
      trustedCertOrigins.push(parsed.address.origin);
    }
  }

  return { kind, customAddress, ackedPlainOrigin, trustedCertOrigins };
}

/** 内置模式是否显示邀请码字段（只有内置云仓库要） */
export function needsInviteCode(state: RepoConfigState): boolean {
  return state.kind === 'cloud';
}
