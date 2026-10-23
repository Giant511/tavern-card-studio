/**
 * 可信反向代理与有效客户端地址（v0.1.2 追加任务 / 需求 F1.4）。
 *
 * ## 为什么需要这一层
 *
 * 服务端所有"按来源 IP 判定"的逻辑（`/api/token` 的回环门禁、登录失败限速）
 * 都建立在 `socket.remoteAddress` 上。这个假设在**同机反向代理**下会塌掉：
 * 代理与业务都监听 127.0.0.1 时，公网来的请求在业务侧看到的对端是
 * **代理自己**（`127.0.0.1`）。于是：
 *
 *   · `/api/token` 的"只允许本机"对**所有公网请求**成立 → 任何人 curl 一下就拿到全权令牌；
 *   · 登录限速把全世界的失败都记到 `127.0.0.1` 这一格 → 5 次之后**所有人**被锁。
 *
 * 两个问题同源：**把"TCP 对端"错当成了"用户"**。修法不是"检测到代理头就拒"
 * （那是 v0.1.2 的止血方案，会让「反代 + 真实 IP」这条正确路径也一起废掉），
 * 而是引入一个**显式的信任声明**：只有管理员在 `trustProxy` 里登记过的地址，
 * 才允许用 `X-Forwarded-For` 改写"客户端是谁"。
 *
 * ## 判定的三条不变量
 *
 * 1. **默认不信任任何代理头**（`trustProxy` 默认空数组）。空数组时本模块的行为
 *    与"完全忽略 XFF"等价 —— 有效 IP 恒等于 socket 地址。
 *    乐观默认（"同机就是可信"）会让管理员在不知情时以为已经按真实 IP 判定，
 *    那是比不做更糟的状态：出问题时所有证据都指向一个假的来源。
 * 2. **取「最右侧非信任条目」**，而不是最左侧。XFF 是**追加**语义：最左边由客户端
 *    随便写（可以伪造），每经过一跳代理在右边追加一条。从右往左走、跳过已登记的
 *    代理，第一个没登记的地址才是我们唯一能负责的那个。
 * 3. **对端不在 trustProxy 里就整个忽略代理头**。带着伪造的 XFF 直连服务端，
 *    有效 IP 仍然是它自己的 socket 地址 —— 伪造在这一层没有任何收益。
 *
 * ## 一个刻意保留的边界
 *
 * 若多跳代理**全部**登记在 trustProxy 里，链最左侧那段（客户端自己写的部分）
 * 就无法与真实首跳区分 —— 这是信任模型的固有限制，不是实现缺陷。
 * 所以 trustProxy 只该填**你自己的**代理地址，不要填 CDN 之类的第三方大段。
 */

import { BlockList } from 'node:net';
import type { IncomingMessage } from 'node:http';

/** 会被视为"存在代理跳"的请求头。**只用于判断是否带代理头**，不参与取值。 */
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host'] as const;

/** 唯一用来取真实客户端地址的头。其它头一律不解析，避免"两个头各说一套"的差分解析。 */
const ADDRESS_HEADER = 'x-forwarded-for';

export interface TrustProxyParseResult {
  /** 规范化后的条目（如 `127.0.0.0/8`、`::1/128`） */
  entries: string[];
  /** 无法解析的条目（调用方应据此拒绝启动，不能静默忽略） */
  problems: string[];
}

interface ParsedEntry {
  /** 原始文本（规范化前的写法，报错时用） */
  raw: string;
  /** 规范化写法 */
  text: string;
  family: 'ipv4' | 'ipv6';
}

/**
 * 把任意写法归一成「纯 IP 字面量」，便于比对与展示。
 *
 * 处理五种真实出现过的形态：
 *   · `::ffff:127.0.0.1`（IPv4-mapped IPv6，双栈监听时最常见）
 *   · `[::1]:8443`（RFC 7239 的方括号 + 端口写法）
 *   · `1.2.3.4:5678`（带端口的 IPv4）
 *   · `fe80::1%eth0`（带 zone id 的链路本地地址）
 *   · 前后空白与大小写
 *
 * 返回 `null` 表示这不是一个 IP 字面量。
 */
export function normalizeAddress(input: string): string | null {
  let text = input.trim().toLowerCase();
  if (text === '') return null;

  // 方括号包起来的 IPv6（可能还带端口）
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    if (close === -1) return null;
    text = text.slice(1, close);
  } else if (text.startsWith('::ffff:')) {
    // 交给下面的 mapped 处理
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(text)) {
    // IPv4:port —— 只在确实是"四段点分 + 端口"时剥掉，避免把 IPv6 的冒号误伤
    text = text.slice(0, text.lastIndexOf(':'));
  }

  // zone id：`fe80::1%eth0` → `fe80::1`
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);

  // IPv4-mapped IPv6：Node 的 BlockList 不认这种形式（实测 check 返回 false），
  // 必须先剥成 IPv4 再判，否则"双栈监听 + trustProxy=127.0.0.0/8"会静默失效。
  if (text.startsWith('::ffff:')) {
    const rest = text.slice('::ffff:'.length);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) text = rest;
  }

  if (isIPv4(text)) return text;
  if (isIPv6(text)) return text;
  return null;
}

function isIPv4(text: string): boolean {
  const parts = text.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (part.length > 1 && part.startsWith('0')) return false; // 前导零是歧义写法
    return Number(part) <= 255;
  });
}

function isIPv6(text: string): boolean {
  if (!text.includes(':')) return false;
  // 宽松但足够的形状校验：只允许十六进制、冒号和「单个 ::」缩写
  if (!/^[0-9a-f:]+$/.test(text)) return false;
  const doubleColons = text.split('::').length - 1;
  if (doubleColons > 1) return false;
  const groups = text.split(':').filter((group) => group !== '');
  if (doubleColons === 1) return groups.length <= 7;
  return groups.length === 8;
}

/**
 * 解析并校验 `trustProxy` 配置。
 *
 * 刻意**不容错**：条目写错时抛/收问题，而不是跳过。理由是安全配置的静默忽略
 * 有两个方向的坏处 —— 少一条会让本该可信的代理失效（限速全局化、取令牌被拒），
 * 多一条的错觉更糟（管理员以为已生效）。所以这里把问题交给调用方去拒绝启动。
 */
export function parseTrustProxyEntries(raw: readonly string[]): TrustProxyParseResult {
  const entries: string[] = [];
  const problems: string[] = [];

  for (const item of raw) {
    const text = item.trim();
    if (text === '') continue; // 空行/尾随逗号不算错，面板里很容易多敲一个换行

    const slash = text.indexOf('/');
    const addressPart = slash === -1 ? text : text.slice(0, slash);
    const prefixPart = slash === -1 ? null : text.slice(slash + 1);

    const address = normalizeAddress(addressPart);
    if (address === null) {
      problems.push(`「${text}」不是合法的 IP 或 CIDR（示例：127.0.0.1、10.0.0.0/8、::1）`);
      continue;
    }

    const family = isIPv4(address) ? 'ipv4' : 'ipv6';
    const maxPrefix = family === 'ipv4' ? 32 : 128;
    let prefix = maxPrefix;
    if (prefixPart !== null) {
      if (!/^\d{1,3}$/.test(prefixPart)) {
        problems.push(`「${text}」的掩码长度不是数字（应形如 /8、/32、/128）`);
        continue;
      }
      prefix = Number(prefixPart);
      if (prefix > maxPrefix) {
        problems.push(`「${text}」的掩码长度超出 ${family} 上限 ${String(maxPrefix)}`);
        continue;
      }
      if (prefix === 0) {
        // 0.0.0.0/0 或 ::/0 等于"信任一切来源"，与"显式登记"的初衷相反。
        // 允许它会让人用一个看起来精确的写法关掉整套判定，所以直接拒绝。
        problems.push(`「${text}」等于信任所有来源（/${String(prefix)}）：请填写具体的代理地址或网段`);
        continue;
      }
    }

    const canonical = prefix === maxPrefix ? address : `${address}/${String(prefix)}`;
    if (!entries.includes(canonical)) entries.push(canonical);
  }

  return { entries, problems };
}

/** 单个解析后的条目 → BlockList 规则 */
interface CompiledRule {
  text: string;
  family: 'ipv4' | 'ipv6';
  network: string;
  prefix: number;
}

function compileRules(entries: readonly string[]): CompiledRule[] {
  return entries.map((text) => {
    const [network, prefixText] = text.split('/');
    const address = network ?? text;
    const family = isIPv4(address) ? 'ipv4' : 'ipv6';
    const prefix = prefixText === undefined ? (family === 'ipv4' ? 32 : 128) : Number(prefixText);
    return { text, family, network: address, prefix };
  });
}

/** 一次请求的地址判定结果 */
export interface ResolvedClientAddress {
  /** 有效客户端地址（限速键、门禁判定都用它）。已归一化。 */
  address: string;
  /** TCP 对端地址（代理时为代理自己）。已归一化。 */
  socketAddress: string;
  /** 对端是否登记在 trustProxy 里 */
  fromTrustedProxy: boolean;
  /** 请求是否带了任一代理头（不论是否信任） */
  proxied: boolean;
  /** 是否解析过 XFF 链（对端可信且有该头） */
  usedForwardedChain: boolean;
  /** XFF 链（只保留能解析成 IP 的条目，从左到右） */
  chain: string[];
  /** 链里存在无法解析的条目 —— 门禁必须据此 fail-closed */
  malformed: boolean;
  /** 从右往左跳过了几个已登记代理（诊断用） */
  skippedTrusted: number;
}

export interface ProxyStats {
  /** 配置的条目数 */
  entries: number;
  /** 规范化后的条目 */
  rules: string[];
  /**
   * 实际生效过的代理地址（对端地址 → 命中次数）。
   *
   * 这个值回答的是"我的 trustProxy 到底匹配上没有"—— 面板上的
   * "已生效代理数"就是它的长度。键只可能来自 trustProxy 里的地址
   * （未登记的对端不会进这里），所以不会因公网扫描而无界增长。
   */
  trustedProxies: { address: string; hits: number }[];
}

/**
 * 地址解析器：把一次请求还原成"到底是谁在访问"。
 *
 * 实例是**有状态**的（记录命中计数），每个 worker 进程一个，随进程生命周期重置。
 */
export class TrustProxyResolver {
  private readonly entries: readonly string[];
  private readonly rules: readonly CompiledRule[];
  private readonly blockList: BlockList;
  private readonly hits = new Map<string, number>();

  /**
   * @throws 条目非法时抛错 —— 调用方（`assertSafeConfig`）会把它转成启动失败，
   *         而不是让服务带着一份"看起来配了但没生效"的信任表跑起来。
   */
  constructor(raw: readonly string[]) {
    const parsed = parseTrustProxyEntries(raw);
    if (parsed.problems.length > 0) {
      throw new Error(`trustProxy 配置有误：${parsed.problems.join('；')}`);
    }
    this.entries = parsed.entries;
    this.rules = compileRules(parsed.entries);

    this.blockList = new BlockList();
    for (const rule of this.rules) {
      this.blockList.addSubnet(rule.network, rule.prefix, rule.family);
    }
  }

  /** 配置是否为空（= 不信任任何代理，等价于完全忽略代理头） */
  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /** 某个地址是否登记为可信代理 */
  isTrusted(address: string | undefined): boolean {
    if (address === undefined || this.rules.length === 0) return false;
    const normalized = normalizeAddress(address);
    if (normalized === null) return false;
    const family = isIPv4(normalized) ? 'ipv4' : 'ipv6';
    try {
      return this.blockList.check(normalized, family);
    } catch {
      // BlockList 在地址/族不匹配时会抛，等价于"不匹配"
      return false;
    }
  }

  resolve(req: IncomingMessage): ResolvedClientAddress {
    const rawSocket = req.socket.remoteAddress;
    const socketAddress = normalizeAddress(rawSocket ?? '') ?? rawSocket ?? 'unknown';
    const fromTrustedProxy = this.isTrusted(rawSocket === undefined ? undefined : socketAddress);

    const proxied = PROXY_HEADERS.some((name) => req.headers[name] !== undefined);
    const headerRaw = readHeader(req, ADDRESS_HEADER);

    if (!fromTrustedProxy) {
      // 未登记的对端：完全忽略代理头。伪造 XFF 在这一层没有任何收益，
      // 有效 IP 就是它自己的 socket 地址。
      return {
        address: socketAddress,
        socketAddress,
        fromTrustedProxy: false,
        proxied,
        usedForwardedChain: false,
        chain: [],
        malformed: false,
        skippedTrusted: 0,
      };
    }

    // 登记过的代理：解析 XFF，从右往左找第一个"没登记"的地址。
    const { chain, malformed } = parseForwardedChain(headerRaw);

    if (chain.length === 0) {
      // 可信代理但没给 XFF：把代理自己当客户端。这是最保守的解释 ——
      // 限速与门禁都按代理 IP 计，宁可过严也不要凭空造一个身份。
      return {
        address: socketAddress,
        socketAddress,
        fromTrustedProxy: true,
        proxied,
        usedForwardedChain: false,
        chain: [],
        malformed,
        skippedTrusted: 0,
      };
    }

    let skippedTrusted = 0;
    let address = chain[0] as string;
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const candidate = chain[index] as string;
      if (this.isTrusted(candidate)) {
        skippedTrusted += 1;
        continue;
      }
      address = candidate;
      break;
    }

    // 命中计数只在"确实按代理头改写了身份"时累加，用于面板确认配置是否匹配上
    const key = socketAddress;
    this.hits.set(key, (this.hits.get(key) ?? 0) + 1);

    return {
      address,
      socketAddress,
      fromTrustedProxy: true,
      proxied,
      usedForwardedChain: true,
      chain,
      malformed,
      skippedTrusted,
    };
  }

  stats(): ProxyStats {
    return {
      entries: this.entries.length,
      rules: [...this.entries],
      trustedProxies: [...this.hits.entries()]
        .map(([address, hits]) => ({ address, hits }))
        .sort((left, right) => right.hits - left.hits),
    };
  }
}

/** 取请求头（兼容重复头被 Node 合成数组的情况） */
function readHeader(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  if (value === undefined) return '';
  if (Array.isArray(value)) return value.join(',');
  return value;
}

/**
 * 解析 `X-Forwarded-For` 链。
 *
 * 只保留能归一成 IP 的条目；同时把"存在垃圾条目"这个事实单独报出来 ——
 * 门禁据此 fail-closed（宁可拒绝，也不要在一条可疑的链上做信任跳转）。
 */
export function parseForwardedChain(raw: string): { chain: string[]; malformed: boolean } {
  if (raw.trim() === '') return { chain: [], malformed: false };
  const chain: string[] = [];
  let malformed = false;

  for (const piece of raw.split(',')) {
    const text = piece.trim();
    if (text === '') continue;
    const normalized = normalizeAddress(text);
    if (normalized === null) {
      malformed = true;
      continue;
    }
    chain.push(normalized);
  }

  return { chain, malformed };
}

/**
 * `/api/token` 的门禁判定（需求 F1.4 第 3 条）。
 *
 * 有效 IP 必须是回环，**且**满足以下任一：
 *   · 没带代理头（本机直连，客户端一键连接的正常形态）；
 *   · 对端登记在 trustProxy 里（这一跳可信，有效 IP 才有意义）。
 *
 * 少了第二个条件，"未登记的同机反代"会天然穿透 —— 那正是 v0.1.2 修掉的洞。
 *
 * 单独抽成纯函数是为了让单测能穷举组合，不必起进程。
 */
export function decideTokenGate(resolved: ResolvedClientAddress): {
  allowed: boolean;
  reason: string;
  hint: string;
} {
  if (resolved.malformed) {
    return {
      allowed: false,
      reason: '取令牌接口拒绝：X-Forwarded-For 链中存在无法解析的条目',
      hint: '代理配置异常或请求头被污染；请检查反向代理是否正确覆盖（而不是追加）了 X-Forwarded-For。',
    };
  }

  if (resolved.proxied && !resolved.fromTrustedProxy) {
    return {
      allowed: false,
      reason: `取令牌接口不接受来自未登记反向代理的请求（对端 ${resolved.socketAddress} 未登记在 trustProxy）`,
      hint:
        '若这确实是你自己的反向代理，把它的地址加入 config.json 的 trustProxy' +
        '（示例：["127.0.0.1"]）；否则请在本机直接访问服务端端口，或在服务器上运行 `tcs-server token show`。',
    };
  }

  if (!isLoopbackAddress(resolved.address)) {
    return {
      allowed: false,
      reason: `取令牌接口只接受来自本机的请求（有效来源 ${resolved.address} 不是回环地址）`,
      hint: '请在服务端所在的这台机器上运行客户端；远程使用请手动复制令牌。',
    };
  }

  return { allowed: true, reason: '', hint: '' };
}

/**
 * 回环判定（与 `config.ts` 的 `isLoopbackAddress` 同口径，但作用在**有效地址**上）。
 *
 * 不复用 `config.ts` 的那个是为了避免 `config → net` 的反向依赖：
 * `config.ts` 需要调用本模块做 trustProxy 校验，若本模块又 import 它，就是循环。
 */
export function isLoopbackAddress(address: string): boolean {
  const normalized = normalizeAddress(address);
  if (normalized === null) return false;
  if (normalized === '::1') return true;
  if (normalized === '0:0:0:0:0:0:0:1') return true;
  if (!isIPv4(normalized)) return false;
  // 127.0.0.0/8 整段都是回环（不只是 127.0.0.1）
  return normalized.startsWith('127.');
}
