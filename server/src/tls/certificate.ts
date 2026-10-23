/**
 * 自签证书管理（T10.5）。
 *
 * 需求 F1.3：首次启动自动生成自签证书，存 ProgramData，面板显示 SHA-256 指纹；
 * 过期前 30 天启动告警；selfsigned 模式下过期自动重新生成并**保留旧证书备份**。
 *
 * 三条设计要点：
 *
 *   1. **ECDSA P-256 而不是 RSA** —— 生成 ~23ms vs RSA-2048 的 1–3s。
 *      「首次启动自动生成」意味着这段延迟会落在服务启动路径上，而 Windows 服务
 *      有启动超时（SCM 默认 30s）；RSA 在慢机器上叠加起来是有风险的。
 *      P-256 是现代 TLS 的通行选择，浏览器与 Node 都完整支持。
 *
 *   2. **私钥文件权限必须收紧** —— 证书是公开的，私钥不是。默认继承目录 ACL
 *      会让同机其它用户能读走私钥，等于把 HTTPS 降级成"看起来加密"。
 *      用 `icacls` 显式设成仅 SYSTEM / Administrators / 服务账户可读。
 *
 *   3. **过期重新生成前先备份** —— 直接覆盖会让"证书指纹核对过"的用户下次
 *      发现指纹变了却不知道为什么；保留旧文件也是排查"客户端提示证书变化"的唯一线索。
 */

import { execFile } from 'node:child_process';
import { createPrivateKey, createPublicKey, sign, verify, webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { X509Certificate, X509CertificateGenerator, cryptoProvider } from '@peculiar/x509';

// @peculiar/x509 需要一个 WebCrypto 实现；Node 22 自带。
// 类型上两者（node:crypto 的 webcrypto 与 @peculiar 的 Crypto）签名不完全一致，
// 但运行时兼容 —— 断言成 never 绕开，避免为了类型完美而引入一层适配代码。
cryptoProvider.set(webcrypto as never);

/** 自签证书有效期：365 天（需求明确） */
export const SELF_SIGNED_VALIDITY_DAYS = 365;
/** 过期前多少天开始在启动日志里告警（需求明确 30 天） */
export const EXPIRY_WARNING_DAYS = 30;

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

export interface CertificatePaths {
  cert: string;
  key: string;
  dir: string;
}

export function certificatePaths(dataDir: string): CertificatePaths {
  const dir = join(dataDir, 'tls');
  return { dir, cert: join(dir, 'server.crt'), key: join(dir, 'server.key') };
}

export interface CertificateInfo {
  /** SHA-256 指纹，形如 `AB:CD:EF:…`（32 组，大写十六进制） */
  fingerprint: string;
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  /** 距离过期还有多少天（负数表示已过期） */
  daysUntilExpiry: number;
  /** 自签（issuer === subject） */
  selfSigned: boolean;
}

/** 把 DER 摘要转成人们核对的 `AA:BB:…` 形式 */
function formatThumbprint(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(':');
}

/**
 * 读证书信息（不碰私钥）。
 *
 * **异步**：`getThumbprint` 在 @peculiar/x509 里返回 Promise（内部走 WebCrypto 摘要），
 * 所以这里没法做成同步函数 —— 早期尝试同步版会拿到 `Promise <pending>`。
 *
 * `daysUntilExpiry` 用**整天**向下取整：告警判据是"还剩不到 30 天"，
 * 用小时会让「29 天 23 小时」算出 29.99 天，判据边界变得不好解释。
 */
export async function inspectCertificate(certPath: string, now = new Date()): Promise<CertificateInfo> {
  const pem = readFileSync(certPath, 'utf8');
  const cert = new X509Certificate(pem);
  const thumbprint = await cert.getThumbprint('SHA-256');
  const msPerDay = 24 * 3600 * 1000;

  return {
    fingerprint: formatThumbprint(thumbprint),
    subject: cert.subject,
    issuer: cert.issuer,
    notBefore: cert.notBefore.toISOString(),
    notAfter: cert.notAfter.toISOString(),
    daysUntilExpiry: Math.floor((cert.notAfter.getTime() - now.getTime()) / msPerDay),
    selfSigned: cert.subject === cert.issuer,
  };
}

export interface GenerateOptions {
  /** 证书 CN；自签时用服务名即可 */
  commonName?: string;
  /** SAN 里要列的额外主机名/IP（客户端连接的地址） */
  subjectAltNames?: string[];
  now?: Date;
  validityDays?: number;
  /** 供测试注入，默认 1 */
  serialNumber?: string;
}

interface GeneratedPair {
  certPem: string;
  keyPem: string;
}

/** 生成一对自签证书 + 私钥（都是 PEM） */
async function generatePair(options: GenerateOptions = {}): Promise<GeneratedPair> {
  const now = options.now ?? new Date();
  const validityDays = options.validityDays ?? SELF_SIGNED_VALIDITY_DAYS;
  const commonName = options.commonName ?? 'Tavern Card Studio';

  const keys = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);

  // SAN 是给浏览器/客户端校验主机名用的。自签证书通常连 IP 访问，
  // 所以默认把 localhost / 127.0.0.1 都带上 —— 少了它们，Chrome 会额外报
  // ERR_CERT_COMMON_NAME_INVALID，用户会误以为是"证书生成坏了"。
  const altNames = options.subjectAltNames ?? ['localhost', '127.0.0.1'];
  const san = altNames.map((value) => {
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':');
    return isIp ? { type: 'ip' as const, value } : { type: 'dns' as const, value };
  });

  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: options.serialNumber ?? '01',
    name: `CN=${commonName}, O=${commonName}`,
    notBefore: now,
    notAfter: new Date(now.getTime() + validityDays * 24 * 3600 * 1000),
    signingAlgorithm: ALGORITHM,
    keys,
    extensions: [
      new (await import('@peculiar/x509')).SubjectAlternativeNameExtension(san, false),
      new (await import('@peculiar/x509')).BasicConstraintsExtension(true, undefined, true),
      new (await import('@peculiar/x509')).ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1']),
    ],
  });

  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  const keyPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8)
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n')}\n-----END PRIVATE KEY-----\n`;

  return { certPem: certificate.toString('pem'), keyPem };
}

/**
 * 收紧私钥文件权限：仅 SYSTEM / Administrators / 当前进程账户可读。
 *
 * 为什么必须做：证书是公开信息，私钥不是。Windows 上新建文件默认继承父目录 ACL，
 * 而 `C:\ProgramData` 对普通用户是可读的 —— 不收紧的话，同机任何用户都能
 * 拷走私钥，HTTPS 就只剩"传输过程看起来是加密的"这一层表象。
 *
 * 失败时**抛错**而不是忽略：权限没收紧的私钥等于没有保护，让服务带着这个状态
 * 跑下去比启动失败更危险。调用方（ensureSelfSigned）会把这个错误暴露出来。
 *
 * **用异步 execFile 而不是 execFileSync**：两个原因 ——
 * ① icacls 每次要 ~50–100ms，同步调用会卡住事件循环（服务此时已经在受理请求）；
 * ② 本机环境的 Node 无法 spawnSync（EBUSY），同步版本连测试都写不了。
 */
export async function restrictKeyPermissions(keyPath: string): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      await execFileAsync('chmod', ['600', keyPath]);
    } catch {
      /* 尽力而为：非 Windows 上由 umask 兜底 */
    }
    return;
  }

  const user = process.env['USERNAME'] ?? '';
  const grants = ['SYSTEM:(F)', 'Administrators:(F)'];
  if (user) grants.push(`${user}:(F)`);

  // /inheritance:r 去掉继承（否则父目录的 Users 读权限会重新生效），
  // 再用 /grant:r 逐个授予白名单主体
  await execFileAsync('icacls', [keyPath, '/inheritance:r']);
  for (const grant of grants) {
    await execFileAsync('icacls', [keyPath, '/grant:r', grant]);
  }
}

const execFileAsync = promisify(execFile);

/**
 * 读回私钥文件的 ACL，返回可读主体列表（测试与面板展示用）。
 *
 * 只解析 `icacls` 输出里形如 `BUILTIN\Administrators:(F)` 的片段。
 * 这是"尽力"的解析：icacls 的输出格式随本地语言变化，所以判定
 * 「是否只有白名单主体」时以**主体名**为准，不以权限串为准。
 */
export async function readKeyPermissions(keyPath: string): Promise<string[]> {
  if (process.platform !== 'win32') {
    const mode = statSync(keyPath).mode & 0o777;
    return [`chmod:${mode.toString(8)}`];
  }
  const { stdout } = await execFileAsync('icacls', [keyPath], { encoding: 'utf8' });
  const subjects: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    // 形如：  NT AUTHORITY\SYSTEM:(F)  或  BUILTIN\Administrators:(OI)(CI)(F)
    const match = /^(.+?):\(([^)]*)\)/.exec(line.trim());
    if (match) {
      const subject = match[1]!.trim();
      // 跳过 "Successfully processed 1 files" 这类尾部信息
      if (/^(Successfully|已成功|处理)/i.test(subject)) continue;
      subjects.push(subject);
    }
  }
  return subjects;
}

export interface EnsureOptions {
  dataDir: string;
  /** 检查是否临近过期；仅 selfsigned 模式下自动续期 */
  now?: Date;
  commonName?: string;
  subjectAltNames?: string[];
  /** 强制重新生成（测试/运维用） */
  force?: boolean;
}

export interface EnsureResult {
  paths: CertificatePaths;
  info: CertificateInfo;
  /** 本次是否新生成（或续期）了证书 */
  generated: boolean;
  /** 续期时旧证书的备份路径（首次生成为 null） */
  backupPath: string | null;
  /** 是否临近过期（< 30 天） */
  expiringSoon: boolean;
}

/**
 * 确保自签证书存在且可用；过期或临近过期时重新生成。
 *
 * 行为矩阵：
 *
 * | 现状 | 动作 |
 * |---|---|
 * | 文件缺失 | 生成 |
 * | 已过期 | 备份旧的 → 生成新的 |
 * | 剩余 < 30 天 | 备份旧的 → 生成新的（**不让重启即断链**） |
 * | 剩余 ≥ 30 天 | 直接复用 |
 *
 * 「临近过期就续期」是刻意的：等服务真的过期了再处理，客户端会在那一刻
 * 集体报证书错误，而用户看到的是"服务端挂了"。提前 30 天续期把这件事
 * 变成一次静默的、有备份的滚动更新。
 */
export async function ensureSelfSigned(options: EnsureOptions): Promise<EnsureResult> {
  const now = options.now ?? new Date();
  const paths = certificatePaths(options.dataDir);
  mkdirSync(paths.dir, { recursive: true });

  const exists = existsSync(paths.cert) && existsSync(paths.key);
  let generate = options.force === true || !exists;
  let backupPath: string | null = null;

  if (exists && !generate) {
    const info = await inspectCertificate(paths.cert, now);
    if (info.daysUntilExpiry < EXPIRY_WARNING_DAYS) {
      // 过期或临近过期 → 备份后重新生成
      const stamp = now.toISOString().replace(/[:.]/g, '-');
      const backupCert = `${paths.cert}.${stamp}.bak`;
      const backupKey = `${paths.key}.${stamp}.bak`;
      renameSync(paths.cert, backupCert);
      renameSync(paths.key, backupKey);
      backupPath = backupCert;
      generate = true;
    }
  }

  if (generate) {
    const pair = await generatePair({
      commonName: options.commonName,
      subjectAltNames: options.subjectAltNames,
      now,
    });
    writeFileSync(paths.cert, pair.certPem, { encoding: 'utf8', mode: 0o644 });
    writeFileSync(paths.key, pair.keyPem, { encoding: 'utf8', mode: 0o600 });
    // 写完立刻收紧 ACL：哪怕后面的步骤出错，私钥也不能留在"默认可读"状态
    await restrictKeyPermissions(paths.key);
  } else {
    // 复用已有证书时也再收紧一次：可能是旧版本生成的、或用户手工拷进来的
    await restrictKeyPermissions(paths.key);
  }

  const info = await inspectCertificate(paths.cert, now);
  return {
    paths,
    info,
    generated: generate,
    backupPath,
    expiringSoon: info.daysUntilExpiry < EXPIRY_WARNING_DAYS,
  };
}

/**
 * custom 模式：校验用户提供的证书与私钥是否匹配。
 *
 * 需求特别强调「不匹配则拒绝启动并报错，不静默退回 off」——
 * 与「缺宿主即报错」同一条原则：安全配置失效时最坏的做法是悄悄降级，
 * 因为用户会以为自己在用 HTTPS。
 *
 * 匹配性的判定方式：用私钥对固定挑战签名，再用**证书里的公钥**验签。
 * 这里用 Node 原生 `crypto`（`createPublicKey` 能直接读 X.509 PEM，
 * `sign`/`verify` 会按密钥类型自动选 ECDSA/RSA 参数），
 * 比走 WebCrypto 省掉一堆算法名与导出格式的适配 —— 也正是那层适配最容易写错。
 */
export async function validateCustomCertificate(certPath: string, keyPath: string): Promise<CertificateInfo> {
  if (!existsSync(certPath)) {
    throw new Error(`自定义证书不存在：${certPath}`);
  }
  if (!existsSync(keyPath)) {
    throw new Error(`自定义私钥不存在：${keyPath}`);
  }

  const certPem = readFileSync(certPath, 'utf8');
  try {
    new X509Certificate(certPem);
  } catch (error) {
    throw new Error(`自定义证书无法解析：${(error as Error).message}`);
  }

  const keyPem = readFileSync(keyPath, 'utf8');
  if (!/-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY)-----/.test(keyPem)) {
    throw new Error('自定义私钥不是 PEM 格式（需 BEGIN PRIVATE KEY / RSA PRIVATE KEY / EC PRIVATE KEY）');
  }

  try {
    const publicKey = createPublicKey(certPem);
    const privateKey = createPrivateKey(keyPem);
    const challenge = Buffer.from('tavern-card-studio:key-match-probe', 'utf8');
    // 算法由密钥类型决定：ECDSA 用 sha256 即 P-256，RSA 用 sha256 + PKCS#1 v1.5
    const signature = sign('sha256', challenge, privateKey);
    if (!verify('sha256', challenge, publicKey, signature)) {
      throw new Error('签名校验未通过');
    }
  } catch (error) {
    throw new Error(
      `自定义证书与私钥不匹配（${(error as Error).message}）：请确认 cert 与 key 是同一对，` +
        '服务端不会退回明文模式',
    );
  }

  return inspectCertificate(certPath);
}

/** 临近过期的告警文案（启动日志与面板共用同一句话，避免两处口径不一） */
export function expiryWarningText(info: CertificateInfo): string {
  if (info.daysUntilExpiry < 0) {
    return `自签证书已于 ${info.notAfter} 过期（指纹 ${info.fingerprint}）：客户端会拒绝连接，请重启服务以自动续期，或改用 custom 证书`;
  }
  return `自签证书将在 ${String(info.daysUntilExpiry)} 天后过期（${info.notAfter}，指纹 ${info.fingerprint}）：届时客户端会拒绝连接，服务重启时会自动续期`;
}
