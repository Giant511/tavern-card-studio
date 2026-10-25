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

/**
 * promisify 版本。
 *
 * **必须**用它而不是 `await execFile(...)`：后者返回的是 `ChildProcess`，
 * `await` 一个非 Promise 值会立刻返回（拿不到 stdout，也不报错）——
 * 我第一版就写成那样，于是 `currentUserSid()` 静默返回 null、
 * `readKeyAclSddl()` 在文件还没生成时就去读 → ENOENT。
 * 这类"await 了个不是 Promise 的东西"不会编译报错，只会让功能悄悄降级。
 */
const execFileAsync = promisify(execFile);

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

/**
 * 旧证书的备份目录（v0.1.3 / F4 需求第 1 条）。
 *
 * 为什么从"证书旁边放 `.bak`"改成独立目录：面板的「重新生成」按钮是**用户主动
 * 反复点**的操作，备份文件散落在 `data/tls/` 里会越堆越多，而且和真正生效的
 * `server.crt` / `server.key` 混在一起 —— 排查"客户端说证书变了"时，
 * 分不清哪个是当前用的。独立目录 + 时间戳命名让"哪一份是哪个时刻的"可读，
 * 也方便运维整个目录打包带走。
 */
export function certsBackupDir(dataDir: string): string {
  return join(dataDir, 'certs-backup');
}

/**
 * 把当前生效的证书/私钥移到备份目录，返回备份后的证书路径。
 *
 * 命名 `<ISO 时间戳>-server.crt`（冒号与点被换成 `-`：Windows 文件名不允许冒号）。
 * 同一毫秒内重复备份时追加 `-1` / `-2` 后缀 —— **不能覆盖**：
 * 备份的意义就是"旧的那份还在"，覆盖等于没备份。
 */
async function backupCurrentPair(
  dataDir: string,
  paths: CertificatePaths,
  now: Date,
  aclProblems: string[],
  aclOptions: RestrictOptions,
): Promise<string> {
  const dir = certsBackupDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');

  let certTarget = join(dir, `${stamp}-server.crt`);
  let keyTarget = join(dir, `${stamp}-server.key`);
  for (let suffix = 1; existsSync(certTarget) || existsSync(keyTarget); suffix += 1) {
    certTarget = join(dir, `${stamp}-${String(suffix)}-server.crt`);
    keyTarget = join(dir, `${stamp}-${String(suffix)}-server.key`);
  }

  renameSync(paths.cert, certTarget);
  renameSync(paths.key, keyTarget);
  /*
   * 备份的私钥同样是秘密：不收紧权限等于把旧私钥留在默认可读的位置。
   *
   * 但**失败不能中断备份**：文件已经改名完成，此时抛错会让"备份成功、调用方
   * 以为失败"，反过来还会让证书生成整体失败 —— 事故里就是这个链条。
   * 失败只记进 aclProblems，由调用方降级成 warn。
   */
  const acl = await restrictKeyPermissions(keyTarget, aclOptions);
  if (!acl.ok) {
    /*
     * **不写路径**：这条文案会一路到面板的错误框。
     * 需求明确要求"不再直接显示含内部路径的内容"，而备份目录名里还带着
     * `C:\Users\…` / `C:\ProgramData\…` 这种与用户无关的信息。
     * 具体文件位置进日志（日志里有完整的 backupPath 字段）。
     */
    aclProblems.push(...acl.problems.map((problem) => `备份私钥的权限未能收紧（${problem}）`));
  }
  return certTarget;
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
 * ## v0.1.3 真机事故：这里曾经把服务器搞挂（`icacls ... /grant:r MP2F1GZG$:(F)`）
 *
 * 两个叠加的错误，任一单独存在都不会出事：
 *
 *   1. **用账户名而不是 SID**。原实现取 `process.env.USERNAME` 拼成授权主体。
 *      但 Windows 服务（session 0）以 LocalSystem 运行时，`USERNAME` 是
 *      **机器账户** `MP2F1GZG$` —— 它不是一个可以 `/grant` 的主体名，
 *      icacls 直接失败。同时 `SYSTEM` / `Administrators` 写的是**本地化名称**，
 *      在非英文系统上本来就不可靠。
 *   2. **把 icacls 的失败当成致命错误**。ACL 是纵深防御，不是门禁；
 *      它失败却导致"证书生成不出来"，把一个可选加固变成了功能不可用。
 *
 * 现在的做法：
 *   · 授权主体一律用**众所周知的 SID 字面量** + `*` 前缀（按 SID 解析，不查名字）：
 *     `*S-1-5-18`（SYSTEM）、`*S-1-5-32-544`（Administrators）。区域无关、
 *     代码页无关、不可能被翻译成乱码。
 *   · 额外补上**当前进程令牌**的用户 SID（通过 `whoami /user` 读，不做名字解析），
 *     否则非管理员用绿色包跑时会把自己锁在私钥外面。
 *   · **永不抛错**：失败返回 `{ ok:false, problems:[脱敏后的原因] }`，由调用方降级成
 *     warn 并继续生成证书。
 *   · **脱敏**：不再把 stderr 原文（含内部路径与乱码）往外抛。
 *
 * 这条规范已写进 `docs/29-security-review-checklist.md`（Windows ACL 操作）。
 *
 * **用异步 execFile 而不是 execFileSync**：icacls 每次要 ~50–100ms，
 * 同步调用会卡住事件循环（服务此时已经在受理请求）。
 */

/** 众所周知的 SID（区域/代码页无关）；`*` 前缀让 icacls 按 SID 解析而不是查账户名 */
export const KEY_ACL_GRANTS = Object.freeze({
  system: '*S-1-5-18',
  administrators: '*S-1-5-32-544',
});

/** 跑一条系统命令（默认真执行；测试可注入以模拟失败） */
export type AclRunner = (command: string, args: string[]) => Promise<void>;

export interface AclResult {
  ok: boolean;
  /** 实际授予的主体（SID 字面量，含 `*` 前缀，便于日志与测试断言） */
  grantees: string[];
  /** 失败原因（**已脱敏**：不含 stderr 原文、不含内部路径） */
  problems: string[];
}

const runProcess: AclRunner = async (command, args) => {
  /*
   * 故障注入（**仅测试用**）：`TCS_TEST_ACL_FAIL=1` 时让所有 ACL 命令失败。
   *
   * 为什么需要它：真机事故发生在 **session 0 的 Windows 服务**里，
   * 单测可以注入 runner，但"进程内直调"证明不了 `POST /control/tls/regenerate`
   * 这条跨进程链路在 ACL 坏掉时不会 500。端到端脚本
   * （scripts/verify-f4-tls.mjs）用它起一个"icacls 不可用"的服务端。
   *
   * 不设这个变量时行为完全不变；名字带 TCS_TEST_ 前缀，避免与真实环境变量混淆。
   */
  if (process.env['TCS_TEST_ACL_FAIL'] === '1') {
    const injected = new Error(`模拟 ${command} 失败（TCS_TEST_ACL_FAIL=1）`);
    (injected as { code?: number }).code = 5;
    throw injected;
  }
  // `encoding: 'buffer'` + 不解析输出：本函数只关心退出码。
  // 顺带绕开"icacls 按控制台代码页输出、Node 按 UTF-8 解码"造成的乱码 ——
  // 那正是事故里面板上那些 ◆ 字符的来源。
  await execFileAsync(command, args, { encoding: 'buffer', windowsHide: true });
};

/**
 * 当前进程令牌的用户 SID。
 *
 * **不是账户名解析**：`whoami /user` 直接把令牌里的 SID 打出来，我们只取那串
 * `S-1-…`（纯 ASCII，任何代码页下字节都相同）。拿不到就返回 null —— 调用方
 * 只用 SYSTEM + Administrators 两个 SID 继续，不影响功能。
 *
 * 为什么需要它：绿色包由普通用户前台运行时，该用户既不是 SYSTEM 也不在
 * Administrators 里；只授那两个 SID 会把他自己锁在私钥外面。
 */
export async function currentUserSid(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  try {
    const whoami = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'whoami.exe');
    const result = await execFileAsync(whoami, ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'buffer',
      windowsHide: true,
    });
    const stdout: Buffer = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout));
    // latin1：SID 是 ASCII，用 latin1 逐字节映射即可稳定取出。
    // 用 utf8 解码 GBK 输出会得到替换字符，用 GBK 解码又依赖系统语言。
    const match = /(S-\d+(?:-\d+)+)/.exec(stdout.toString('latin1'));
    return match === null ? null : match[1]!;
  } catch {
    // whoami 不可用（精简镜像 / 策略禁用）：只授众所周知的 SID，照常工作
    return null;
  }
}

/** 把 exec 的失败翻成一句脱敏的话（退出码可留，stderr 不留） */
function describeAclFailure(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'number') return `系统命令 icacls 失败（退出码 ${String(code)}）`;
  if (typeof code === 'string' && code !== '') return `系统命令 icacls 失败（${code}）`;
  return '系统命令 icacls 失败（原因见服务端日志）';
}

export interface RestrictOptions {
  /** 注入用的命令执行器（测试模拟失败） */
  run?: AclRunner;
  /** 注入当前用户 SID；`undefined` = 自动探测，`null` = 不追加 */
  userSid?: string | null;
}

/**
 * 收紧私钥权限。**永不抛错。**
 *
 * 顺序：一次 icacls 调用同时做「去掉继承」与「按 SID 授予」——
 * `/inheritance:r` 之后父目录的 `Users` 读权限不会重新生效，
 * 而 `/grant:r` 保证白名单主体仍然可读。
 */
export async function restrictKeyPermissions(
  keyPath: string,
  options: RestrictOptions = {},
): Promise<AclResult> {
  const run = options.run ?? runProcess;

  if (process.platform !== 'win32') {
    try {
      await run('chmod', ['600', keyPath]);
      return { ok: true, grantees: [], problems: [] };
    } catch (error) {
      return { ok: false, grantees: [], problems: [`chmod 600 失败：${describeAclFailure(error)}`] };
    }
  }

  const userSid = options.userSid === undefined ? await currentUserSid() : options.userSid;
  // 显式标注 string[]：`Object.freeze` 会把字面量类型收窄成两个字面量的联合，
  // 后面 push 用户 SID 就通不过类型检查
  const grantees: string[] = [KEY_ACL_GRANTS.system, KEY_ACL_GRANTS.administrators];
  if (userSid !== null && typeof userSid === 'string' && /^S-\d+(?:-\d+)+$/.test(userSid)) {
    const asGrant = `*${userSid}`;
    if (!grantees.includes(asGrant)) grantees.push(asGrant);
  }

  try {
    await run('icacls', [keyPath, '/inheritance:r', '/grant:r', ...grantees.map((sid) => `${sid}:(F)`)]);
    return { ok: true, grantees, problems: [] };
  } catch (error) {
    return { ok: false, grantees, problems: [describeAclFailure(error)] };
  }
}

/**
 * 读回私钥文件的 ACL 的 **SDDL**（测试与诊断用）。
 *
 * 为什么读 SDDL 而不是 `icacls <file>` 的普通输出：普通输出是**主体名**
 * （`BUILTIN\Administrators`），随系统语言变化；SDDL 用 `;;;BA)` / `;;;SY)`
 * 这类众所周知代码，是纯 ASCII，任何区域/代码页下都一样 —— 才能拿来做断言。
 *
 * `icacls /save` 写出的是 UTF-16LE 文件，所以按 UTF-16LE 解码。
 */
export async function readKeyAclSddl(keyPath: string, savePath: string): Promise<string> {
  if (process.platform !== 'win32') {
    const mode = statSync(keyPath).mode & 0o777;
    return `chmod:${mode.toString(8)}`;
  }
  await execFileAsync('icacls', [keyPath, '/save', savePath], { encoding: 'buffer', windowsHide: true });
  const raw = readFileSync(savePath);
  // 文件是 UTF-16LE：去掉 BOM 后按 utf16le 解码，得到 `D:PAI(A;;FA;;;BA)(A;;FA;;;SY)`
  return raw.toString('utf16le').replace(/^\uFEFF/, '').trim().split(/\r?\n/).pop() ?? '';
}

export interface EnsureOptions {
  dataDir: string;
  /** 检查是否临近过期；仅 selfsigned 模式下自动续期 */
  now?: Date;
  commonName?: string;
  subjectAltNames?: string[];
  /** 强制重新生成（测试/运维用） */
  force?: boolean;
  /** 注入 ACL 命令执行器（测试模拟 icacls 失败） */
  aclRun?: AclRunner;
  /** 注入当前用户 SID（测试用；`undefined` = 自动探测） */
  aclUserSid?: string | null;
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
  /**
   * ACL 收紧过程中没能完成的部分（**已脱敏**）。
   *
   * 非空不影响证书可用：ACL 是纵深防御，不是门禁。调用方负责把它降级成
   * warn（日志 + 事件日志），并如实告诉使用者"私钥可能对同机其他用户可读"。
   */
  aclProblems: string[];
}

/**
 * 确保自签证书存在且可用；过期或临近过期时重新生成。
 *
 * 行为矩阵：
 *
 * | 现状 | 动作 |
 * |---|---|
 * | 文件缺失 | 生成（无备份，本来就没有旧的） |
 * | 已过期 | 备份到 `certs-backup/` → 生成新的 |
 * | 剩余 < 30 天 | 备份到 `certs-backup/` → 生成新的（**不让重启即断链**） |
 * | 剩余 ≥ 30 天 | 直接复用 |
 * | `force: true` 且已有 | 备份到 `certs-backup/` → 生成新的（面板的「重新生成」） |
 *
 * 「临近过期就续期」是刻意的：等服务真的过期了再处理，客户端会在那一刻
 * 集体报证书错误，而用户看到的是"服务端挂了"。提前 30 天续期把这件事
 * 变成一次静默的、有备份的滚动更新。
 *
 * `force` 也必须备份：面板的「重新生成」是**用户主动点**的操作，指纹会立刻变，
 * 所有客户端下次连接都会看到"证书变了"。旧那份必须留得下来，否则
 * "我只是想换一张，能换回去吗"没有答案。
 */
export async function ensureSelfSigned(options: EnsureOptions): Promise<EnsureResult> {
  const now = options.now ?? new Date();
  const paths = certificatePaths(options.dataDir);
  mkdirSync(paths.dir, { recursive: true });

  const aclOptions: RestrictOptions = { run: options.aclRun, userSid: options.aclUserSid };
  /** ACL 失败一律进这里，**绝不**影响证书生成本身 */
  const aclProblems: string[] = [];

  const exists = existsSync(paths.cert) && existsSync(paths.key);
  let generate = false;
  let backupPath: string | null = null;

  if (!exists) {
    generate = true;
  } else if (options.force === true) {
    backupPath = await backupCurrentPair(options.dataDir, paths, now, aclProblems, aclOptions);
    generate = true;
  } else {
    const info = await inspectCertificate(paths.cert, now);
    if (info.daysUntilExpiry < EXPIRY_WARNING_DAYS) {
      // 过期或临近过期 → 备份后重新生成
      backupPath = await backupCurrentPair(options.dataDir, paths, now, aclProblems, aclOptions);
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
  }

  /*
   * 收紧 ACL（生成后 / 复用旧证书都要做）。
   *
   * **无论成败都不抛错**：私钥已经写到磁盘上了，此时抛错会让"证书生成失败"
   * 这个结论变成假话（文件其实好好的），而真机事故就是这条链把整个
   * 「重新生成」按钮打成 500。
   */
  const acl = await restrictKeyPermissions(paths.key, aclOptions);
  if (!acl.ok) {
    aclProblems.push(
      ...acl.problems.map(
        (problem) =>
          `私钥文件权限未能收紧（${problem}）：该私钥可能对同机其他用户可读。` +
          'HTTPS 可正常使用，但建议检查 `icacls` 是否可用（见 docs/29 Windows ACL 操作）。',
      ),
    );
  }

  const info = await inspectCertificate(paths.cert, now);
  return {
    paths,
    info,
    generated: generate,
    backupPath,
    expiringSoon: info.daysUntilExpiry < EXPIRY_WARNING_DAYS,
    aclProblems,
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
