/** 服务端运行时上下文：配置 → 数据目录 → 存储 / 规则 / 审计 / 领域服务。 */

import { join } from 'node:path';

import { AuditService } from './audit/service.js';
import { planMigration } from './auth/migrate.js';
import { ensureDataDirs, type LoadedConfig, type ServerConfigFile } from './config.js';
import { createLogger, type Logger } from './log.js';
import { RuleRegistry } from './rules/registry.js';
import { BlobStore } from './storage/blobs.js';
import { CardService } from './storage/cards.js';
import { Db } from './storage/db.js';
import { GitStore } from './storage/git-store.js';

export const SERVER_VERSION = '0.1.2';
export const API_VERSION = 'v1';

export interface ServerContext {
  config: ServerConfigFile;
  configPath: string;
  paths: ReturnType<typeof ensureDataDirs>;
  db: Db;
  blobs: BlobStore;
  git: GitStore;
  registry: RuleRegistry;
  audit: AuditService;
  cards: CardService;
  logger: Logger;
  startedAt: number;
  /**
   * 实际生效的 TLS 状态（T10.5）。
   *
   * 由 worker 在准备完证书后写入：`config.tls` 只说明"用户想用什么"，
   * 而这里记录"实际用的是什么 + 证书指纹"。两者必须分开 —— 用户核对指纹时
   * 看的是**实际加载的那张证书**，不是配置里那个路径。
   */
  tls: RuntimeTlsState;
}

export interface RuntimeTlsState {
  mode: 'off' | 'selfsigned' | 'custom';
  httpsPort: number | null;
  /** 证书指纹（SHA-256，`AA:BB:…`）；off 或尚未准备好时为 null */
  fingerprint: string | null;
  subject: string | null;
  notBefore: string | null;
  notAfter: string | null;
  daysUntilExpiry: number | null;
  selfSigned: boolean;
  /** off 模式恒为 true —— 面板据此常驻红色横幅 */
  plaintext: boolean;
  /** 启动期产生的告警（临近过期、custom 自签提醒等） */
  warnings: string[];
}

export function emptyTlsState(mode: 'off' | 'selfsigned' | 'custom', httpsPort: number): RuntimeTlsState {
  return {
    mode,
    httpsPort: mode === 'off' ? null : httpsPort,
    fingerprint: null,
    subject: null,
    notBefore: null,
    notAfter: null,
    daysUntilExpiry: null,
    selfSigned: false,
    plaintext: mode === 'off',
    warnings: [],
  };
}

export function createContext(loaded: LoadedConfig, options: { logDir?: string; role?: string; sink?: (line: string) => void } = {}): ServerContext {
  const config = loaded.config;
  const paths = ensureDataDirs(config.dataDir);
  const logger = createLogger({
    level: config.logLevel,
    logDir: options.logDir ?? paths.logs,
    role: options.role,
    sink: options.sink,
  });

  const db = new Db(paths.database);
  const blobs = new BlobStore(paths.blobs);
  const git = new GitStore(paths.repos);
  const registry = new RuleRegistry(config.rulesDir);
  const audit = new AuditService(registry, {
    platformId: config.defaultPlatformRule,
    presetId: config.defaultPreset,
  });
  const cards = new CardService(
    db,
    blobs,
    git,
    audit,
    { platformId: config.defaultPlatformRule, presetId: config.defaultPreset },
    logger,
  );

  const errors = registry.loadErrors();
  if (errors.platforms.length > 0) logger.warn('rules.platform.invalid', { errors: errors.platforms });
  if (errors.presets.length > 0) logger.warn('rules.preset.invalid', { errors: errors.presets });

  // 账户迁移的提醒（T10.3）。
  //
  // **不自动迁移**：迁移要设首账户密码，而服务启动时没有交互可用；
  // 自动生成一个随机密码写进日志，等于把"谁都能看的字符串"变成管理员口令。
  // 所以这里是"检测 + 喊话"，实际动作交给 `tcs-server user migrate`。
  try {
    const plan = planMigration(db.handle);
    if (plan.needed) {
      logger.warn('auth.migration.pending', {
        orphanCards: plan.orphanCards,
        hint: '还没有任何账户：运行 `tcs-server user migrate <用户名>` 创建首账户并接管历史卡片（会先自动备份库）',
      });
    } else if (plan.orphanCards > 0) {
      // 已有账户却还有无归属的卡 —— 说明某条写入路径漏了 owner_id，
      // 是代码缺陷的信号，不只是脏数据
      logger.warn('auth.cards.orphan', {
        orphanCards: plan.orphanCards,
        hint: '有卡片没有归属账户：运行 `tcs-server user adopt <用户名>` 划归，并检查上传路径',
      });
    }
  } catch (error) {
    logger.warn('auth.migration.check_failed', { message: error instanceof Error ? error.message : String(error) });
  }

  return {
    config,
    configPath: loaded.path,
    paths,
    db,
    blobs,
    git,
    registry,
    audit,
    cards,
    logger,
    startedAt: Date.now(),
    // 初始是"配置声明的状态"，worker 准备完证书后会覆盖成实际状态
    tls: emptyTlsState(config.tls.mode, config.tls.httpsPort),
  };
}

export function configSummary(config: ServerConfigFile): Record<string, unknown> {
  return {
    schemaVersion: config.schemaVersion,
    port: config.port,
    controlPort: config.controlPort,
    // host 与 controlHost 必须都下发：面板表单要回显两个地址，
    // 少了 controlHost 表单会被填空，用户一保存就把面板地址改掉。
    host: config.host,
    controlHost: config.controlHost,
    dataDir: config.dataDir,
    rulesDir: config.rulesDir,
    defaultPlatformRule: config.defaultPlatformRule,
    defaultPreset: config.defaultPreset,
    maxUploadBytes: config.maxUploadBytes,
    logLevel: config.logLevel,
    auth: {
      require: config.auth.require,
      // 面板里只显示掩码，避免截图/日志泄露；完整 token 用 `tcs-server token show`
      tokenMasked: config.auth.token ? `${config.auth.token.slice(0, 4)}…${config.auth.token.slice(-4)}` : '',
      publicPaths: [...config.auth.publicPaths],
      // 面板要能显示并切换注册策略（需求 F1.1）；不带这个字段，
      // 面板表单每次保存都会把它写成"未设置"→ 回落成 closed，用户以为改了其实没改
      registerMode: config.auth.registerMode,
    },
    service: { ...config.service },
    tls: {
      mode: config.tls.mode,
      httpsPort: config.tls.httpsPort,
      // **不下发 certPath/keyPath 的完整路径**：面板会被远程访问，路径里常带用户名，
      // 而且用户不需要在界面上看到磁盘结构。只给"是否已配置"，够判断状态。
      customConfigured: config.tls.certPath !== '' && config.tls.keyPath !== '',
      // 面板据此显示常驻红色明文横幅（T10.5 / 需求 F1.3）。
      // plaintext 是**持续事实**，不是一次性提示，所以由后端给判据、前端常驻渲染。
      plaintext: config.tls.mode === 'off',
    },
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

export function logFileOf(paths: ReturnType<typeof ensureDataDirs>): string {
  return join(paths.logs, 'server.log');
}
