/**
 * 服务端配置（T5.4 管理面板读写这份配置）。
 *
 * 设计原则：
 *   · 配置是一个普通 JSON 文件（`dataDir/config.json`），面板改完落盘，重启生效；
 *   · 端口 / 监听地址 / token / 数据目录 / 服务注册方式 都在这里；
 *   · 首次启动自动生成 token（T5.6「至少 token 级别」），绝不使用硬编码默认值；
 *   · 所有路径都基于 dataDir，便于 MSI 安装后迁移与备份。
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const CONFIG_SCHEMA_VERSION = 1 as const;

/** 服务进程管理模式 */
export type ServiceMode = 'process' | 'windows-service';

export interface ServiceConfig {
  /** process：由本进程自己启停；windows-service：通过 sc.exe / WinSW 管理的 Windows 服务 */
  mode: ServiceMode;
  /** Windows 服务名（windows-service 模式使用） */
  name: string;
  /** 服务显示名 */
  displayName: string;
  /** 开机自启（安装时写入服务配置） */
  autoStart: boolean;
}

/**
 * 注册策略（T10.3 / 需求 F1.1）。
 *
 *   · `closed`     —— 默认。谁都不能自助注册，账户只能由管理员通过 CLI/面板创建；
 *   · `open`       —— 任何能访问到 API 的人都能注册（**只在可信网络/内网**开）；
 *   · `admin-only` —— 注册接口只允许已登录的管理员调用（等价于"面板建号"）。
 *
 * 默认 `closed` 是刻意的：v0.1.1 之前服务端只有"一个全局 token"，没有账户概念，
 * 升级后如果默认开放注册，等于把一个原本只有持有 token 才能用的服务
 * 变成"公网任何人可注册"——这是**权限放大**，不能作为默认行为。
 */
export type RegisterMode = 'closed' | 'open' | 'admin-only';

export interface AuthConfig {
  /** 访问令牌；空串表示「未生成」——启动时若 require 为 true 会自动生成 */
  token: string;
  /** 是否强制鉴权。监听非回环地址时强制为 true（见 assertSafeConfig） */
  require: boolean;
  /** 允许免鉴权的路径前缀（默认只有 /api/health） */
  publicPaths: string[];
  /** 自助注册策略，见 {@link RegisterMode}；默认 closed */
  registerMode: RegisterMode;
  /**
   * JWT 签名密钥（HS256）。
   *
   * **必须持久化**：放内存里每次重启都换，所有已签出的令牌会立刻失效 ——
   * 那会让"吊销"失去意义（重启就等于全量吊销），用户也会莫名其妙被踢下线。
   * 首次启动自动生成 32 字节；与 `token` 一样只在 `config.json` 里，
   * 面板与 `configSummary` 只显示掩码。
   */
  jwtSecret: string;
}

export interface ServerConfigFile {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  /** API 服务（数据面 worker）监听端口 */
  port: number;
  /**
   * 管理面板与控制面（supervisor）监听端口。
   * 控制面独立于数据面：worker 被停止/重启时面板仍在线，才能真正做到「启动/停止/重启」。
   */
  controlPort: number;
  /**
   * **API 服务（数据面 worker）监听地址**。默认 `127.0.0.1`。
   *
   * 只影响 8730（API），不影响管理面板 —— 见 `controlHost`。
   */
  host: string;
  /**
   * **管理面板（控制面 supervisor）监听地址**。默认 `127.0.0.1`，且**不跟随 `host`**。
   *
   * 为什么必须与 `host` 分开（2026-10-21 修正）：
   *   既要「API 暴露到局域网给客户端用」，又要「管理面板只在本机开」，
   *   这在没有这个字段时做不到 —— 两者共用 `host`，把 API 开到 `0.0.0.0`
   *   会连带把面板页面（`/`、`/app.js`）也暴露出去。这些静态资源在
   *   `PANEL_PUBLIC_PATHS` 里是免鉴权的，实测从局域网 IP 访问面板返回 200，
   *   只有 `/control/*` 才要 token。虽然 token 挡住了真正的操作，但
   *   「管理界面不该出现在局域网」这件事本身必须成立。
   *
   * 缺省值刻意不用 `host`：已有配置文件（`host` 可能已是 `0.0.0.0`）读进来时，
   * 面板会自动保持回环 —— 升级即修好，不需要用户改配置。
   */
  controlHost: string;
  /** 数据目录（卡片仓库 / 索引库 / 日志） */
  dataDir: string;
  /** 规则目录（平台规则 / 预设 / 高亮），默认随安装分发的 rules/ */
  rulesDir: string;
  /** 默认审计平台规则 id */
  defaultPlatformRule: string;
  /** 默认审计预设 id */
  defaultPreset: string;
  /** 单个上传包体上限（字节） */
  maxUploadBytes: number;
  /** 日志级别 */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  auth: AuthConfig;
  service: ServiceConfig;
  /** 创建时间（ISO 8601） */
  createdAt: string;
  /** 最近更新时间（ISO 8601） */
  updatedAt: string;
}

export interface ConfigOverrides {
  port?: number;
  controlPort?: number;
  /** API（数据面）监听地址 */
  host?: string;
  /** 管理面板（控制面）监听地址 */
  controlHost?: string;
  dataDir?: string;
  rulesDir?: string;
  token?: string;
  logLevel?: ServerConfigFile['logLevel'];
  serviceMode?: ServiceMode;
  serviceName?: string;
}

const DEFAULT_PUBLIC_PATHS = ['/api/health'];

/**
 * 管理面板的默认监听地址。
 *
 * 刻意是回环而不是跟随 `host`：面板是「本机运维界面」，不该出现在局域网上。
 * `normalizeConfig` 也用这个值兜底，所以老配置文件（`host` 可能是 `0.0.0.0`）
 * 升级后会自动把面板收回回环。
 */
export const DEFAULT_CONTROL_HOST = '127.0.0.1';

/** 被视为「本机」的地址集合（用于非回环时必须鉴权的判定） */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** 该地址是否为本机回环 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * 判断一条**连接来源地址**是否来自本机回环（`GET /api/token` 的门禁）。
 *
 * 与 `isLoopbackHost` 的区别很重要，别混用：
 *   · `isLoopbackHost` 判的是**配置里的监听地址**（决定 bind 到哪）；
 *   · 本函数判的是**这次请求的对端地址**（决定要不要给令牌）。
 *
 * `socket.remoteAddress` 的形态不止一种，都得认：
 *   · `127.0.0.1`            —— 普通 IPv4 回环
 *   · `::1`                  —— 普通 IPv6 回环
 *   · `::ffff:127.0.0.1`     —— **IPv4-mapped IPv6**。双栈监听（`::`）时最常见，
 *                               漏判这一种会让本机客户端拿不到令牌，且现象很迷惑：
 *                               看起来"服务在跑、端口通"，偏偏取令牌 403。
 *   · `127.x.y.z`            —— 整个 127.0.0.0/8 都是回环，不只是 127.0.0.1。
 *
 * **绝不看 `X-Forwarded-For` 之类的请求头**：那个由客户端随便写，
 * 拿它做门禁等于没有门禁。只有内核给出的 socket 地址可信。
 */
export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const address = remoteAddress.trim().toLowerCase();

  // IPv4-mapped IPv6：先剥掉前缀再按 IPv4 判
  const mapped = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  if (mapped === '::1' || mapped === '0:0:0:0:0:0:0:1') return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(mapped);
  if (v4) {
    // 127.0.0.0/8 整段都是回环
    return v4[1] === '127';
  }
  return false;
}

/**
 * 把「监听地址」换成「人能在浏览器里打开的地址」。
 *
 * 监听地址和访问地址不是一回事：`0.0.0.0` 表示「监听所有网卡」，但它本身不是一个
 * 可连接的目标 —— 浏览器打不开 `http://0.0.0.0:8731/`（在 Windows 上会绕一圈落到
 * 本机，在 Linux 上常常直接失败）。同理 `::` 也不是可浏览地址。
 *
 * 所以凡是**给人看的 URL**（日志、CLI 输出、面板地址）都要过这个函数；
 * **实际 bind 时必须用原始地址**，不能替换，否则就只监听回环了。
 */
export function reachableHost(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1';
  // IPv6 通配地址要带方括号才能拼进 URL
  if (host === '::' || host === '[::]') return '[::1]';
  return host;
}


/** 生成一个 URL 安全、可打印的随机 token */
export function generateToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

function defaultDataDir(): string {
  // 优先遵循 XDG 风格环境变量；Windows 下落到安装目录下的 data。
  const fromEnv = process.env['TCS_DATA_DIR'];
  if (fromEnv && fromEnv.trim() !== '') return resolve(fromEnv);
  return resolve(process.cwd(), 'server', 'data');
}

function defaultRulesDir(): string {
  const fromEnv = process.env['TCS_RULES_DIR'];
  if (fromEnv && fromEnv.trim() !== '') return resolve(fromEnv);
  return resolve(process.cwd(), 'rules');
}

export function createDefaultConfig(overrides: ConfigOverrides = {}): ServerConfigFile {
  const now = new Date().toISOString();
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    port: overrides.port ?? 8730,
    controlPort: overrides.controlPort ?? (overrides.port ?? 8730) + 1,
    host: overrides.host ?? '127.0.0.1',
    controlHost: overrides.controlHost ?? DEFAULT_CONTROL_HOST,
    dataDir: overrides.dataDir ?? defaultDataDir(),
    rulesDir: overrides.rulesDir ?? defaultRulesDir(),
    defaultPlatformRule: 'sillytavern',
    defaultPreset: 'default',
    maxUploadBytes: 32 * 1024 * 1024,
    logLevel: overrides.logLevel ?? 'info',
    auth: {
      token: overrides.token ?? generateToken(),
      require: true,
      publicPaths: [...DEFAULT_PUBLIC_PATHS],
      registerMode: 'closed',
      jwtSecret: generateToken(),
    },
    service: {
      mode: overrides.serviceMode ?? 'process',
      name: overrides.serviceName ?? 'TavernCardStudioServer',
      displayName: 'Tavern Card Studio Server',
      autoStart: true,
    },
    createdAt: now,
    updatedAt: now,
  };
}

/** 规范化：补缺省键、纠正类型，保证旧版本配置文件也能读进来 */
export function normalizeConfig(input: unknown, overrides: ConfigOverrides = {}): ServerConfigFile {
  const base = createDefaultConfig(overrides);
  if (!input || typeof input !== 'object') return base;
  const raw = input as Record<string, unknown>;

  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  const str = (value: unknown, fallback: string): string => (typeof value === 'string' && value !== '' ? value : fallback);

  const authRaw = (raw['auth'] ?? {}) as Record<string, unknown>;
  const serviceRaw = (raw['service'] ?? {}) as Record<string, unknown>;

  const config: ServerConfigFile = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    port: num(raw['port'], base.port),
    controlPort: num(raw['controlPort'], (num(raw['port'], base.port) || base.port) + 1),
    host: str(raw['host'], base.host),
    // 老配置里没有这个键 → 落到 DEFAULT_CONTROL_HOST（回环），而不是跟随 host。
    // 这是安全默认：升级后即使 host 早已是 0.0.0.0，管理面板也会自动收回本机。
    controlHost: str(raw['controlHost'], base.controlHost),
    dataDir: str(raw['dataDir'], base.dataDir),
    rulesDir: str(raw['rulesDir'], base.rulesDir),
    defaultPlatformRule: str(raw['defaultPlatformRule'], base.defaultPlatformRule),
    defaultPreset: str(raw['defaultPreset'], base.defaultPreset),
    maxUploadBytes: num(raw['maxUploadBytes'], base.maxUploadBytes),
    logLevel: (['debug', 'info', 'warn', 'error'] as const).includes(raw['logLevel'] as never)
      ? (raw['logLevel'] as ServerConfigFile['logLevel'])
      : base.logLevel,
    auth: {
      token: str(authRaw['token'], base.auth.token),
      require: authRaw['require'] === undefined ? base.auth.require : authRaw['require'] !== false,
      publicPaths: Array.isArray(authRaw['publicPaths'])
        ? authRaw['publicPaths'].filter((item): item is string => typeof item === 'string')
        : [...DEFAULT_PUBLIC_PATHS],
      // 非法值一律回落到 closed：宁可拒绝注册，也不能因为拼错一个词
      // 就把服务变成"谁都能建号"
      registerMode: (['closed', 'open', 'admin-only'] as const).includes(authRaw['registerMode'] as never)
        ? (authRaw['registerMode'] as RegisterMode)
        : 'closed',
      // 老配置里没有这一项 —— 自动补一个并会在下次写盘时落下去。
      // 不能留空：空密钥会让 AuthService 拒绝签发令牌（宁可报错也不用弱密钥）。
      //
      // **弱密钥（< 32 字符）也一并替换掉**：HS256 的安全性完全系于密钥熵，
      // 用户手填一个 "secret" 是最常见的事故。这里静默换成强随机值 ——
      // 代价是填过弱值的人会被登出一次，收益是不会有可离线爆破的签名密钥。
      jwtSecret: (() => {
        const provided = str(authRaw['jwtSecret'], '');
        return provided.length >= 32 ? provided : generateToken(48);
      })(),
    },
    service: {
      mode: serviceRaw['mode'] === 'windows-service' ? 'windows-service' : 'process',
      name: str(serviceRaw['name'], base.service.name),
      displayName: str(serviceRaw['displayName'], base.service.displayName),
      autoStart: serviceRaw['autoStart'] === undefined ? base.service.autoStart : serviceRaw['autoStart'] !== false,
    },
    createdAt: str(raw['createdAt'], base.createdAt),
    updatedAt: str(raw['updatedAt'], base.updatedAt),
  };

  // 命令行覆盖优先于配置文件
  if (overrides.port !== undefined) {
    config.port = overrides.port;
    if (overrides.controlPort === undefined && raw['controlPort'] === undefined) {
      config.controlPort = overrides.port + 1;
    }
  }
  if (overrides.controlPort !== undefined) config.controlPort = overrides.controlPort;
  if (overrides.host !== undefined) config.host = overrides.host;
  if (overrides.controlHost !== undefined) config.controlHost = overrides.controlHost;
  if (overrides.dataDir !== undefined) config.dataDir = resolve(overrides.dataDir);
  if (overrides.rulesDir !== undefined) config.rulesDir = resolve(overrides.rulesDir);
  if (overrides.token !== undefined && overrides.token !== '') config.auth.token = overrides.token;
  if (overrides.logLevel !== undefined) config.logLevel = overrides.logLevel;
  if (overrides.serviceMode !== undefined) config.service.mode = overrides.serviceMode;
  if (overrides.serviceName !== undefined) config.service.name = overrides.serviceName;

  return config;
}

export class ConfigError extends Error {}

/**
 * 安全约束：监听非回环地址时必须鉴权。
 * 本地工具，默认只听 127.0.0.1；一旦有人把 host 改成 0.0.0.0 又不带 token，等于裸奔。
 */
export function assertSafeConfig(config: ServerConfigFile): void {
  if (!isLoopbackHost(config.host) && !config.auth.require) {
    throw new ConfigError(`API 监听地址 ${config.host} 非回环，必须开启鉴权（auth.require=false 不允许）`);
  }
  // 管理面板的约束更严：面板页面（/、/app.js）在 PANEL_PUBLIC_PATHS 里是免鉴权的，
  // token 只保护 /control/*。所以把面板开到非回环等于把管理界面暴露出去，
  // 即使操作仍需 token，也不该允许 —— 除非用户显式承担这个风险。
  // 这里不硬拦（有人确实需要远程运维），但要求必须开鉴权，避免"裸面板"。
  if (!isLoopbackHost(config.controlHost) && !config.auth.require) {
    throw new ConfigError(
      `管理面板监听地址 ${config.controlHost} 非回环，必须开启鉴权（面板静态资源本身免鉴权，关闭 token 等于公开管理界面）`,
    );
  }
  if (config.auth.require && config.auth.token === '') {
    throw new ConfigError('已开启鉴权但 token 为空；请用 --token 指定或删除配置文件重新生成');
  }
  // 开放注册 + 监听非回环 = 暴露在网络上任何人都能建号（T10.3）。
  //
  // 这里**不拒绝**（需求 F1 明确要"可部署云服务器面向公网"，合法场景存在），
  // 但必须让它在启动时被看见：配置面板会把这一项标红，日志也会有 warning。
  // 拒绝启动会让"我就想做成公开社区服务"的用户彻底没路可走，
  // 而我们真正要防的是"随手把 host 改成 0.0.0.0 调试，忘了 registerMode 是 open"。
  if (config.auth.registerMode === 'open' && !isLoopbackHost(config.host)) {
    // 只记录，不抛错。调用方（CLI / supervisor）会把这条打出来
    process.emitWarning
      ? process.emitWarning(
          `已开启自助注册（auth.registerMode=open）且 API 监听 ${config.host}（非回环）：` +
            '任何能访问该地址的人都可以创建账户。若非有意，请改为 closed 或 admin-only。',
          'SecurityWarning',
        )
      : undefined;
  }
  if (config.port < 1 || config.port > 65535) {
    throw new ConfigError(`端口非法：${config.port}`);
  }
  if (config.controlPort < 1 || config.controlPort > 65535) {
    throw new ConfigError(`控制面端口非法：${config.controlPort}`);
  }
  if (config.controlPort === config.port) {
    throw new ConfigError(`控制面端口不能与 API 端口相同（${config.port}）`);
  }
  if (config.maxUploadBytes < 1024) {
    throw new ConfigError(`上传上限过小：${config.maxUploadBytes}`);
  }
}

export interface LoadedConfig {
  config: ServerConfigFile;
  /** 配置文件路径 */
  path: string;
  /** 是否为本次新建 */
  created: boolean;
}

/**
 * 读取（必要时创建）配置文件。
 *
 * 注意「必要时创建」的默认 dataDir：不能沿用 cwd。
 * Windows 服务以 LocalSystem 启动时 cwd 是 C:\Windows\System32，
 * 若用默认值，卡片 blob 和 Git 仓库会被写进 System32\server\data，
 * 卸载后既找不到也删不干净。所以配置文件是新建的时候，
 * 默认数据目录取「配置文件同级的 store 子目录」——
 * MSI 安装后即 C:\ProgramData\TavernCardStudio\store，可预期、可备份。
 * （CLI 在 parseArgs 里也有同样的推导，这里是给直接调用 loadConfig
 *   的 supervisor / worker 兜底，两处必须保持一致。）
 */
export function loadConfig(configPath: string, overrides: ConfigOverrides = {}): LoadedConfig {
  const absolute = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath);
  if (!existsSync(absolute)) {
    const effective: ConfigOverrides = { ...overrides };
    if (effective.dataDir === undefined) {
      effective.dataDir = join(dirname(absolute), 'store');
    }
    const config = normalizeConfig(null, { ...effective, token: overrides.token ?? generateToken() });
    assertSafeConfig(config);
    mkdirSync(dirnameOf(absolute), { recursive: true });
    writeConfig(absolute, config);
    return { config, path: absolute, created: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
  } catch (error) {
    throw new ConfigError(`配置文件不是合法 JSON：${absolute}（${(error as Error).message}）`);
  }
  const config = normalizeConfig(parsed, overrides);
  assertSafeConfig(config);
  // 老配置缺 `auth.jwtSecret` 时必须**立刻回写**：
  // 不回写的话，每次进程启动都会生成新密钥，所有已签出的令牌随即失效
  // （等于每次重启把所有人踢下线，而且让 refresh 机制形同虚设）。
  // 这是一次性迁移，只在字段缺失/过短时触发。
  const rawAuth = (parsed as { auth?: { jwtSecret?: unknown } }).auth;
  const providedSecret = typeof rawAuth?.jwtSecret === 'string' ? rawAuth.jwtSecret : '';
  if (providedSecret !== config.auth.jwtSecret) {
    writeConfig(absolute, config);
  }
  return { config, path: absolute, created: false };
}

/** 原子写配置（先写临时文件再 rename） */
export function writeConfig(configPath: string, config: ServerConfigFile): void {
  mkdirSync(dirnameOf(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  renameSync(tmp, configPath);
}

function dirnameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx <= 0 ? '.' : path.slice(0, idx);
}

/** 数据目录下的固定子路径 */
export function dataPaths(dataDir: string): {
  root: string;
  repos: string;
  blobs: string;
  logs: string;
  tmp: string;
  database: string;
  config: string;
} {
  const root = isAbsolute(dataDir) ? dataDir : resolve(process.cwd(), dataDir);
  return {
    root,
    repos: join(root, 'repos'),
    blobs: join(root, 'blobs'),
    logs: join(root, 'logs'),
    tmp: join(root, 'tmp'),
    database: join(root, 'state.db'),
    config: join(root, 'config.json'),
  };
}

export function ensureDataDirs(dataDir: string): ReturnType<typeof dataPaths> {
  const paths = dataPaths(dataDir);
  mkdirSync(paths.repos, { recursive: true });
  mkdirSync(paths.blobs, { recursive: true });
  mkdirSync(paths.logs, { recursive: true });
  mkdirSync(paths.tmp, { recursive: true });
  return paths;
}
