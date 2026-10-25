/**
 * TLS 配置与 HTTPS 服务器（T10.5）。
 *
 * 三种模式（需求 F1.3）：
 *
 * | 模式 | 行为 |
 * |---|---|
 * | `off` | 只跑 HTTP。面板与登录页显示常驻红色「明文传输，仅限可信网络」 |
 * | `selfsigned` | 首次启动生成自签证书；临近/已过期自动续期（备份旧的）；HTTPS 与 HTTP 并存 |
 * | `custom` | 用用户提供的证书；**校验证书与私钥匹配，不匹配拒绝启动**（不静默退回 off） |
 *
 * 「HTTPS 与 HTTP 并存」是需求第 3 条明确要求的：客户端平滑切换需要一个
 * 双通窗口 —— 先把服务端开起来、客户端改地址验证通了，再考虑只留一个。
 * 若一开 TLS 就关掉 HTTP，用户会在"改完配置立刻连不上"的时刻失去所有排查手段。
 */

import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import type { RequestListener, Server as HttpServer } from 'node:http';

import {
  ensureSelfSigned,
  expiryWarningText,
  inspectCertificate,
  validateCustomCertificate,
  type CertificateInfo,
} from './certificate.js';

export type TlsMode = 'off' | 'selfsigned' | 'custom';

export interface TlsConfig {
  mode: TlsMode;
  /** HTTPS 端口，默认 8443（与 HTTP 的 8730 分开） */
  httpsPort: number;
  /** custom 模式的证书路径（PEM）。相对路径相对数据目录 */
  certPath: string;
  /** custom 模式的私钥路径（PEM） */
  keyPath: string;
}

export const DEFAULT_HTTPS_PORT = 8443;

export interface PreparedTls {
  /** off 时为 null */
  material: { cert: string; key: string } | null;
  info: CertificateInfo | null;
  /** 是否需要向用户报告的问题（告警在启动日志里打，不阻止启动） */
  warnings: string[];
  /** off 模式下要显示明文警告 */
  plaintext: boolean;
}

export interface PrepareOptions {
  config: TlsConfig;
  dataDir: string;
  now?: Date;
  commonName?: string;
  subjectAltNames?: string[];
}

/**
 * 按模式准备 TLS 材料。
 *
 * 失败策略遵循需求第 4 条：**custom 模式出任何问题都抛错**，不退回 off。
 * selfsigned 模式出问题也抛错 —— 用户明确要了 HTTPS，静默降级成 HTTP
 * 会让"看起来配好了"的服务实际在明文传输。
 */
export async function prepareTlsMaterial(options: PrepareOptions): Promise<PreparedTls> {
  const { config } = options;

  if (config.mode === 'off') {
    return { material: null, info: null, warnings: [], plaintext: true };
  }

  if (config.mode === 'selfsigned') {
    const result = await ensureSelfSigned({
      dataDir: options.dataDir,
      now: options.now,
      commonName: options.commonName,
      subjectAltNames: options.subjectAltNames,
    });

    const warnings: string[] = [];
    if (result.backupPath) {
      warnings.push(
        `自签证书已到期或临近到期（${result.info.notAfter}），已重新生成；旧证书备份在 ${result.backupPath}`,
      );
    }
    if (result.expiringSoon) {
      warnings.push(expiryWarningText(result.info));
    }
    /*
     * ACL 收紧失败也要带出去（v0.1.3 真机事故修复）。
     *
     * 它**不是**启动失败的理由 —— 证书已经生成好、HTTPS 能正常工作；
     * 但"私钥可能对同机其他用户可读"是一个必须被看见的安全事实，
     * 所以进 warnings：启动日志会有 `tls.warning`，面板横幅也会显示。
     */
    warnings.push(...result.aclProblems);

    return {
      material: {
        cert: readFileSync(result.paths.cert, 'utf8'),
        key: readFileSync(result.paths.key, 'utf8'),
      },
      info: result.info,
      warnings,
      plaintext: false,
    };
  }

  // custom
  const info = await validateCustomCertificate(config.certPath, config.keyPath);
  const warnings: string[] = [];
  if (info.daysUntilExpiry < 30) {
    warnings.push(
      `自定义证书将在 ${String(info.daysUntilExpiry)} 天后过期（${info.notAfter}）：请及时更换，服务端不会自动续期 custom 证书`,
    );
  }
  if (info.daysUntilExpiry < 0) {
    // 已过期：这是明确的配置错误，不能"尽力启动" —— 客户端会全部连不上
    throw new Error(`自定义证书已于 ${info.notAfter} 过期，请更换后再启动`);
  }
  if (info.selfSigned) {
    warnings.push('自定义证书是自签的：客户端默认不信任，需要手动导入或加信任例外（见 README）');
  }

  return {
    material: {
      cert: readFileSync(config.certPath, 'utf8'),
      key: readFileSync(config.keyPath, 'utf8'),
    },
    info,
    warnings,
    plaintext: false,
  };
}

export interface StartedHttps {
  server: HttpsServer;
  port: number;
  info: CertificateInfo | null;
  close(): Promise<void>;
}

/**
 * 启动 HTTPS 监听。
 *
 * `port` 传 0 时由系统分配（测试用）；实际端口通过 `server.address()` 回读，
 * 不要假设就是配置里那个 —— 端口 0 或端口被占用后重试时都会不同。
 */
export async function startHttpsServer(
  handler: RequestListener,
  prepared: PreparedTls,
  port: number,
  host: string,
): Promise<StartedHttps> {
  if (!prepared.material) {
    throw new Error('没有 TLS 材料，不能启动 HTTPS（mode=off 时应走 HTTP）');
  }

  const server = createHttpsServer(
    { cert: prepared.material.cert, key: prepared.material.key, minVersion: 'TLSv1.2' },
    handler,
  );

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        new Error(
          error.code === 'EADDRINUSE'
            ? `HTTPS 端口 ${host}:${String(port)} 已被占用`
            : `HTTPS 服务启动失败：${error.message}`,
        ),
      );
    });
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;

  return {
    server,
    port: actualPort,
    info: prepared.info,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/**
 * off 模式的常驻警告文案（面板、登录页、启动日志共用一句）
 */
export const PLAINTEXT_BANNER = {
  level: 'danger' as const,
  title: '明文传输（HTTP）',
  body:
    '当前 tls.mode=off，所有请求（含登录密码与访问令牌）以明文经过网络，仅限可信的本机或内网使用。' +
    '对外提供服务请开启 tls.mode=selfsigned（或 custom）。',
};

/**
 * 「实际生效的 TLS 状态」——`/api/stats` 下发的 `tls` 就是它（T10.10 抽出来的）。
 *
 * 为什么要单独一个函数：这段装配原先写在 worker 里，于是「面板看到的指纹」与
 * 「用户日志里核对的指纹」是**两段独立代码**算出来的，而单测只能覆盖其中一段。
 * 更糟的是 T10.5 还留了一个从未被调用的 `tlsSummary()`，输出的是**另一套嵌套形状**
 * （`tls.certificate.fingerprint`）—— 写验证脚本时按它去读，得到 undefined，
 * 断言失败而服务端其实完全正常。现在只有这一个函数，线上格式与测试对象是同一份。
 *
 * `httpsPort` 传 `null` 表示"HTTPS 没起来"（off 模式，或 selfsigned/custom 的
 * 端口被占用后 worker 启动失败前的中间态），不能拿配置里的值冒充实际监听。
 */
export function runtimeTlsState(
  mode: TlsMode,
  httpsPort: number | null,
  prepared: PreparedTls,
): RuntimeTlsStateShape {
  return {
    mode,
    httpsPort,
    fingerprint: prepared.info?.fingerprint ?? null,
    subject: prepared.info?.subject ?? null,
    notBefore: prepared.info?.notBefore ?? null,
    notAfter: prepared.info?.notAfter ?? null,
    daysUntilExpiry: prepared.info?.daysUntilExpiry ?? null,
    selfSigned: prepared.info?.selfSigned ?? false,
    plaintext: prepared.plaintext,
    warnings: [...prepared.warnings],
  };
}

/** 与 `context.ts` 的 `RuntimeTlsState` 同形（那边依赖本模块的类型，不能反向 import） */
export interface RuntimeTlsStateShape {
  mode: TlsMode;
  httpsPort: number | null;
  fingerprint: string | null;
  subject: string | null;
  notBefore: string | null;
  notAfter: string | null;
  daysUntilExpiry: number | null;
  selfSigned: boolean;
  plaintext: boolean;
  warnings: string[];
}

/**
 * 已删除：`tlsSummary()`（T10.5 遗留）。
 *
 * 它号称是"下发给 Web UI 的 TLS 状态"，但**没有任何调用方** —— 真正的线上格式是
 * `ServerContext.tls`（`context.ts` 的 `RuntimeTlsState`，字段是**扁平**的
 * `fingerprint / selfSigned / …`，由 `/api/stats` 直接下发）。
 *
 * 两套同义结构并列存在是纯粹的陷阱：T10.10 写"核对指纹"的验证脚本时，
 * 按这个函数的形状去读 `stats.tls.certificate.fingerprint`，得到 undefined，
 * 而服务端其实一切正常 —— 断言失败，但错的是契约。留着它，下一次还会有别人踩。
 * 单一事实来源是 `RuntimeTlsState`。
 */

/** 供测试与 supervisor 复用的 HTTP server 类型别名 */
export type { HttpServer };
