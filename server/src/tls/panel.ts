/**
 * 「传输安全」面板要用到的两段纯逻辑（v0.1.3 / F4）。
 *
 * 为什么单独一个模块，而不是写在路由里或前端里：
 *
 *   · **前端算不了**：公私钥是否匹配要用 `crypto.sign/verify`（见
 *     `validateCustomCertificate`），浏览器里没有私钥的处理能力，也不该有 ——
 *     私钥一旦进了浏览器就多了一份可被 XSS 读取的副本。所以匹配校验必须在
 *     服务端做，面板只是调用与展示。
 *
 *   · **必须能单测**：需求第 4 条要求"不匹配证书禁止保存""off 模式警告渲染"
 *     都是判据。把判据写成纯函数，测试才能直接断言"这句话在什么条件下出现"，
 *     而不是靠截图看颜色。
 *
 *   · **一处口径**：警告文案如果前端再写一遍，就会出现"服务端日志说公网暴露、
 *     面板说仅限内网"这种自相矛盾。面板只渲染服务端给的 `banners`。
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { isLoopbackHost } from '../config.js';
import {
  inspectCertificate,
  validateCustomCertificate,
  type CertificateInfo,
} from './certificate.js';
import type { TlsMode } from './server.js';

/** 相对路径按数据目录解析（与 `prepareTlsMaterial` 的口径一致） */
export function resolveTlsPath(dataDir: string, path: string): string {
  const trimmed = path.trim();
  if (trimmed === '') return '';
  return isAbsolute(trimmed) ? trimmed : join(dataDir, trimmed);
}

export type CheckLevel = 'ok' | 'warn' | 'bad';

export interface TlsInputCheck {
  mode: TlsMode;
  /** 解析后的绝对路径（面板回显用，便于用户确认真实位置） */
  certPath: string;
  keyPath: string;
  certExists: boolean;
  keyExists: boolean;
  /** 公私钥是否匹配；文件缺失或解析失败时为 'unknown' */
  match: 'ok' | 'mismatch' | 'unknown';
  info: CertificateInfo | null;
  level: CheckLevel;
  /** 面板直接显示的一句话结论 */
  message: string;
  /** 逐条原因（缺文件、格式错、不匹配…），保存被拒时原样回显 */
  problems: string[];
  /** 是否可以保存这个状态（custom 模式下必须 true） */
  canSave: boolean;
}

export interface InspectOptions {
  mode: TlsMode;
  dataDir: string;
  certPath: string;
  keyPath: string;
  now?: Date;
}

/**
 * 即时检查 custom 的双路径。
 *
 * 与 `validateCustomCertificate` 的分工：那个函数是**启动/热更时**的守门人
 * （抛错即拒绝），这个是**保存前**的前置拦截（返回结构化结果，让面板能
 * 逐条显示原因）。两者共用同一段校验实现，所以"面板说通过、启动却失败"
 * 不会发生 —— 这正是需求里"与拒绝启动语义对齐的前置拦截"的要求。
 */
export async function inspectTlsInputs(options: InspectOptions): Promise<TlsInputCheck> {
  const certPath = resolveTlsPath(options.dataDir, options.certPath);
  const keyPath = resolveTlsPath(options.dataDir, options.keyPath);

  const base: TlsInputCheck = {
    mode: options.mode,
    certPath,
    keyPath,
    certExists: certPath !== '' && existsSync(certPath),
    keyExists: keyPath !== '' && existsSync(keyPath),
    match: 'unknown',
    info: null,
    level: 'warn',
    message: '',
    problems: [],
    canSave: true,
  };

  // off / selfsigned 不依赖用户文件，检查永远"通过"（端口另由配置校验管）
  if (options.mode !== 'custom') {
    if (options.mode === 'selfsigned') {
      const info = await safeInspect(join(options.dataDir, 'tls', 'server.crt'), options.now);
      return {
        ...base,
        certPath: join(options.dataDir, 'tls', 'server.crt'),
        keyPath: join(options.dataDir, 'tls', 'server.key'),
        certExists: info !== null,
        keyExists: existsSync(join(options.dataDir, 'tls', 'server.key')),
        match: info === null ? 'unknown' : 'ok',
        info,
        level: 'ok',
        message:
          info === null
            ? '自签证书尚未生成：首次启用时会自动生成'
            : `自签证书有效，剩余 ${String(info.daysUntilExpiry)} 天`,
        canSave: true,
      };
    }
    return { ...base, level: 'ok', message: '当前为明文模式，不使用证书', canSave: true };
  }

  // ── custom ────────────────────────────────────────────
  const problems: string[] = [];
  if (certPath === '') problems.push('证书路径为空');
  else if (!base.certExists) problems.push(`证书文件不存在：${certPath}`);
  if (keyPath === '') problems.push('私钥路径为空');
  else if (!base.keyExists) problems.push(`私钥文件不存在：${keyPath}`);

  if (problems.length > 0) {
    return {
      ...base,
      level: 'bad',
      message: '路径不完整或文件不存在，无法启用自定义证书',
      problems,
      canSave: false,
    };
  }

  try {
    const info = await validateCustomCertificate(certPath, keyPath);
    const warnings: string[] = [];
    if (info.daysUntilExpiry < 0) warnings.push(`证书已于 ${info.notAfter} 过期`);
    else if (info.daysUntilExpiry < 30) warnings.push(`证书将在 ${String(info.daysUntilExpiry)} 天后过期`);
    if (info.selfSigned) warnings.push('这是自签证书：客户端默认不信任，需要手动导入');

    return {
      ...base,
      match: 'ok',
      info,
      level: warnings.length > 0 ? 'warn' : 'ok',
      message:
        warnings.length > 0
          ? `证书与私钥匹配（${info.fingerprint.slice(0, 23)}…），但需注意：${warnings.join('；')}`
          : `证书与私钥匹配，有效期至 ${info.notAfter}（剩余 ${String(info.daysUntilExpiry)} 天）`,
      problems: warnings,
      /*
       * 已过期的证书**不允许保存**：`prepareTlsMaterial` 对 custom 过期是直接抛错，
       * 允许保存等于让用户点完"保存"再看到一条热更失败 —— 前置拦截的意义就是
       * 在点下去之前就把话说清楚。
       */
      canSave: info.daysUntilExpiry >= 0,
    };
  } catch (error) {
    return {
      ...base,
      match: 'mismatch',
      level: 'bad',
      message: '证书与私钥不匹配，不能保存',
      problems: [error instanceof Error ? error.message : String(error)],
      canSave: false,
    };
  }
}

async function safeInspect(certPath: string, now: Date | undefined): Promise<CertificateInfo | null> {
  if (!existsSync(certPath)) return null;
  try {
    return await inspectCertificate(certPath, now);
  } catch {
    return null;
  }
}

export interface BannerInput {
  mode: TlsMode;
  /** API 监听地址（HTTPS 与它共用） */
  host: string;
  httpsPort: number | null;
  /**
   * 证书到期信息。刻意只要这两个字段，**不要完整的 `CertificateInfo`**：
   * 横幅只需要"还剩几天 / 何时到期"，而运行时的 TLS 状态
   * （`/api/stats` 的 tls 段）本来就不带 issuer 等字段。
   * 要求完整结构会逼调用方编一个 issuer 出来。
   */
  expiry?: { daysUntilExpiry: number; notAfter: string } | null;
  /** 热更失败等需要一并显示的原因 */
  extra?: string[];
}

export interface TlsBanner {
  code: 'plaintext' | 'public-exposure' | 'custom-not-configured' | 'https-down' | 'expiring' | 'error';
  level: 'danger' | 'warn';
  title: string;
  body: string;
}

/**
 * 常驻安全横幅（需求第 3 条）。
 *
 * 升级规则沿用 F7 的判据（非回环监听 + 明文 = 公网暴露）：
 * 同一条 `isLoopbackHost`，和服务端启动日志、`assertSafeConfig` 的告警
 * 完全一致。**两处各写一份判据**是这类功能最常见的退化方式 ——
 * 面板说"仅限可信网络"而日志说"暴露在公网"，用户只能信自己愿意信的那个。
 *
 * 返回顺序即显示顺序：最严重的在最上面。
 */
export function tlsSecurityBanners(input: BannerInput): TlsBanner[] {
  const banners: TlsBanner[] = [];
  const loopback = isLoopbackHost(input.host);

  if (input.mode === 'off') {
    if (loopback) {
      banners.push({
        code: 'plaintext',
        level: 'danger',
        title: '明文传输，仅限可信网络',
        body:
          `当前 tls.mode=off，所有请求（含登录密码与访问令牌）以明文经过网络。` +
          `API 监听 ${input.host}（回环地址），只有本机能连上，风险可控。` +
          '若要给局域网或公网使用，请切换到 selfsigned 或 custom。',
      });
    } else {
      banners.push({
        code: 'public-exposure',
        level: 'danger',
        title: '公网暴露风险：明文传输 + 非回环监听',
        body:
          `当前 tls.mode=off 且 API 监听 ${input.host}（非回环地址）—— ` +
          '这意味着**同一网络内任何人都能嗅探到登录密码、访问令牌与全部卡片内容**，' +
          '不只是"看得到端口开着"。请立刻启用 selfsigned（自签即可）或 custom 证书；' +
          '临时保留明文时，至少确认这台机器处在可信内网并有防火墙限制。',
      });
    }
  }

  if (input.mode === 'custom' && (input.expiry ?? null) === null) {
    banners.push({
      code: 'custom-not-configured',
      level: 'warn',
      title: '自定义证书尚未生效',
      body: '已选择 custom 模式，但证书与私钥未就绪；保存时会被拒绝，服务端不会退回明文。',
    });
  }

  if (input.mode !== 'off' && input.httpsPort === null) {
    banners.push({
      code: 'https-down',
      level: 'danger',
      title: 'HTTPS 监听未启动',
      body:
        `配置要求 ${input.mode} 模式，但当前没有 HTTPS 监听。` +
        '常见原因是端口被占用或证书不可用，请查看下方错误与运行日志。',
    });
  }

  // 注意 `expiry` 是可选属性：`!== null` 收窄不了 `undefined`，
  // 必须取局部变量再判 —— 直接写 `input.expiry.x` 在 strict 下是编译错误。
  const expiry = input.expiry ?? null;
  if (expiry !== null && expiry.daysUntilExpiry < 30) {
    banners.push({
      code: 'expiring',
      level: 'warn',
      title:
        expiry.daysUntilExpiry < 0
          ? `证书已过期（${expiry.notAfter}）`
          : `证书将在 ${String(expiry.daysUntilExpiry)} 天后过期`,
      body:
        input.mode === 'selfsigned'
          ? '自签证书临近过期时会在服务重启时自动续期；也可以点「重新生成」立刻换一张（旧证书会备份）。'
          : 'custom 证书不会自动续期，请在到期前替换 cert 与 key 文件。',
    });
  }

  for (const message of input.extra ?? []) {
    banners.push({ code: 'error', level: 'danger', title: '最近一次热更失败', body: message });
  }

  return banners;
}
