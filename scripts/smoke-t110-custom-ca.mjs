/**
 * T10.10 ② 自定义证书（custom）真进程验证：不是"自签也能连"，而是**信任链成立**。
 *
 * T10.5 的冒烟已经证明 custom 模式能起、证书私钥不匹配会拒绝启动。
 * 但那是"自签且自己信自己"的路径 —— 真部署里 custom 用的几乎都是
 * **某个 CA 签发的叶子证书**（mkcert / 企业 CA / Let's Encrypt 导出）。
 * 这条链上有一类比"自签"更隐蔽的错误：证书本身没问题，**信任链或主机名不对**，
 * 客户端在自己机器上关掉校验测通了，换台机器全员报错。
 *
 * 所以这里造一套完整的 PKI（CA + 三张叶子），逐条验证：
 *
 *   ① 叶子由 CA 签发 → 客户端**带 CA**、严格校验能连通（链真的成立）；
 *   ② 同一张叶子，客户端**不带 CA** → 严格校验被拒（不是因为我们关掉了校验）；
 *   ③ 换一张"链对但主机名不对"的叶子 → 报 ALTNAME，不是静默通过；
 *   ④ 指纹与 /api/stats 下发的一致（用户核对的是同一个东西）；
 *   ⑤ 30 天内过期 → 启动日志告警；已过期 → **拒绝启动**（不退回明文）。
 *
 * 用法：node scripts/smoke-t110-custom-ca.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import https from 'node:https';
import { X509Certificate, webcrypto } from 'node:crypto';
import {
  BasicConstraintsExtension,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
  cryptoProvider,
} from '@peculiar/x509';

cryptoProvider.set(webcrypto);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' —— ' + detail : ''}`);
};

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
const DAY = 86400000;
const BASE_PORT = 22100 + Math.floor(Math.random() * 200);
const LEGACY = 't110-ca-legacy-token-aaaaaaaaaaaaaaaaaaaaaaaa';

const dirs = [];

function keyToPem(pkcs8) {
  const body = Buffer.from(pkcs8).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

/**
 * 造一个 CA。
 *
 * 返回的 `issue()` 用 CA 的私钥签叶子 —— 与 mkcert 的做法一致（本地根 CA + 叶子）。
 * 注意 `BasicConstraints(ca:true)` 与 `keyCertSign` 必须都给：缺任一项时
 * Node/OpenSSL 会拒绝把它当签发者，链就建不起来（这也是自建 CA 最常见的坑）。
 */
async function makeCa(name) {
  const keys = await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + 3650 * DAY),
    signingAlgorithm: ALG,
    keys,
    extensions: [
      new BasicConstraintsExtension(true, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
    ],
  });

  return {
    certPem: cert.toString('pem'),
    cert,
    keys,
    async issue({ subject, sans, days = 100, serial = '02', notAfter }) {
      const leafKeys = await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
      const extensions = [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1']),
      ];
      if (sans.length > 0) extensions.push(new SubjectAlternativeNameExtension(sans));
      const leaf = await X509CertificateGenerator.create({
        serialNumber: serial,
        subject,
        issuer: cert.subject,
        notBefore: new Date(Date.now() - 30 * DAY),
        notAfter: notAfter ?? new Date(Date.now() + days * DAY),
        signingAlgorithm: ALG,
        publicKey: leafKeys.publicKey,
        signingKey: keys.privateKey,
        extensions,
      });
      const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', leafKeys.privateKey);
      return { certPem: leaf.toString('pem'), keyPem: keyToPem(pkcs8) };
    },
  };
}

function writeConfig(dir, port, tls) {
  const path = join(dir, 'config.json');
  writeFileSync(
    path,
    JSON.stringify(
      {
        schemaVersion: 1,
        port,
        controlPort: port + 1,
        host: '127.0.0.1',
        controlHost: '127.0.0.1',
        dataDir: join(dir, 'store'),
        rulesDir: 'rules',
        defaultPlatformRule: 'sillytavern',
        defaultPreset: 'default',
        maxUploadBytes: 33554432,
        logLevel: 'info',
        auth: {
          token: LEGACY,
          require: true,
          publicPaths: ['/api/health'],
          registerMode: 'closed',
          jwtSecret: 't110-ca-jwt-secret-aaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        tls,
        service: { mode: 'process', name: 'T110CA', displayName: 'T110CA', autoStart: false },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  return path;
}

function startWorker(configPath) {
  const child = spawn(process.execPath, ['server/dist/index.js', 'worker', '--config', configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = { out: '', err: '' };
  let exitCode = null;
  child.stdout.on('data', (d) => (logs.out += String(d)));
  child.stderr.on('data', (d) => (logs.err += String(d)));
  child.on('exit', (code) => (exitCode = code));
  return {
    child,
    logs,
    get exitCode() {
      return exitCode;
    },
  };
}

/**
 * HTTPS 请求，**始终严格校验**。
 *
 * `ca` 传 PEM 表示"这台客户端信任这个 CA"（真实客户端导入根证书的等价物）；
 * 不传则用系统信任库 —— 于是失败来自链本身，而不是我们主动关掉了检查。
 */
function httpsGet(port, ca) {
  return new Promise((resolve, reject) => {
    const options = {
      host: '127.0.0.1',
      port,
      path: '/api/stats',
      method: 'GET',
      timeout: 5000,
      rejectUnauthorized: true,
      headers: { Authorization: `Bearer ${LEGACY}` },
    };
    if (ca !== undefined) options.ca = ca;
    const request = https.request(options, (res) => {
      let body = '';
      res.on('data', (c) => (body += String(c)));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.end();
  });
}

/**
 * 等 HTTPS 端口 accept。
 *
 * 用 TCP 探活而不是 TLS 握手：证书不可信时握手必然失败，
 * 那与"还没起来"无法区分 —— 而这里要等的只是"listen 了"。
 */
async function waitTcp(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = await new Promise((resolve) => {
      const socket = new Socket();
      socket.setTimeout(600);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, '127.0.0.1');
    });
    if (alive) return true;
    await delay(150);
  }
  return false;
}

const errCode = (error) => String(error?.code ?? error?.message ?? error);

try {
  const ca = await makeCa('TCS Test CA');
  const goodLeaf = await ca.issue({
    subject: 'CN=localhost',
    sans: [
      { type: 'dns', value: 'localhost' },
      { type: 'ip', value: '127.0.0.1' },
    ],
  });

  // ── ① ② ④：链对 → 带 CA 通过；不带 CA 被拒；指纹一致 ────────
  {
    const dir = mkdtempSync(join(tmpdir(), 'tcs-t110-ca-'));
    dirs.push(dir);
    const port = BASE_PORT;
    const httpsPort = port + 1000;
    const certPath = join(dir, 'leaf.crt');
    const keyPath = join(dir, 'leaf.key');
    writeFileSync(certPath, goodLeaf.certPem, 'utf8');
    writeFileSync(keyPath, goodLeaf.keyPem, 'utf8');

    const worker = startWorker(writeConfig(dir, port, { mode: 'custom', httpsPort, certPath, keyPath }));
    try {
      check('custom + CA 签发叶子：HTTPS 端口起来了', await waitTcp(httpsPort), `port=${String(httpsPort)}`);

      let trusted = null;
      let trustedError = null;
      try {
        trusted = await httpsGet(httpsPort, ca.certPem);
      } catch (error) {
        trustedError = errCode(error);
      }
      check(
        '① 客户端信任该 CA 后严格校验通过（链路 / 主机名 / 有效期都对）',
        trusted !== null && trusted.status >= 200 && trusted.status < 500,
        trusted !== null ? `status=${String(trusted.status)}` : trustedError,
      );

      let untrustedError = null;
      try {
        await httpsGet(httpsPort, undefined);
      } catch (error) {
        untrustedError = errCode(error);
      }
      check(
        '② 不信任该 CA 时严格校验被拒（UNABLE_TO_VERIFY / SELF_SIGNED_IN_CHAIN）',
        untrustedError !== null &&
          /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT|DEPTH_ZERO/.test(
            untrustedError,
          ),
        untrustedError ?? '（竟然通过了）',
      );

      const fromFile = new X509Certificate(readFileSync(certPath, 'utf8')).fingerprint256;
      let stats = null;
      try {
        stats = trusted === null ? null : JSON.parse(trusted.body);
      } catch {
        stats = null;
      }
      // 线上格式是 **扁平** 的 `tls`（`RuntimeTlsState`），不是 `tls.certificate.*`：
      // T10.5 里那层嵌套的 `tlsSummary()` 从未被调用，T10.10 已删掉（留着会让契约二义）。
      check(
        '④ /api/stats 的证书指纹 == 证书文件指纹（用户核对的是同一个东西）',
        stats?.tls?.fingerprint === fromFile,
        `${String(stats?.tls?.fingerprint)} vs ${fromFile}`,
      );
      check(
        '④ stats 标明 tls.mode=custom 且 selfSigned=false',
        stats?.tls?.mode === 'custom' && stats?.tls?.selfSigned === false,
        `mode=${String(stats?.tls?.mode)} selfSigned=${String(stats?.tls?.selfSigned)}`,
      );
      check(
        '④ custom 证书不会拉起"自签"告警（tls.warning 里没有自签字样）',
        !/自定义证书是自签的/.test(worker.logs.out + worker.logs.err),
        '',
      );
    } finally {
      worker.child.kill();
      await delay(300);
    }
  }

  // ── ③ 链对但主机名不对 → ALTNAME ───────────────────────────
  {
    const dir = mkdtempSync(join(tmpdir(), 'tcs-t110-ca-wronghost-'));
    dirs.push(dir);
    const port = BASE_PORT + 10;
    const httpsPort = port + 1000;
    const wrongHost = await ca.issue({
      subject: 'CN=other.example.com',
      sans: [{ type: 'dns', value: 'other.example.com' }],
      serial: '03',
    });
    const certPath = join(dir, 'other.crt');
    const keyPath = join(dir, 'other.key');
    writeFileSync(certPath, wrongHost.certPem, 'utf8');
    writeFileSync(keyPath, wrongHost.keyPem, 'utf8');

    const worker = startWorker(writeConfig(dir, port, { mode: 'custom', httpsPort, certPath, keyPath }));
    try {
      check('③ 主机名不符的叶子照样起服务（服务端不做主机名校验）', await waitTcp(httpsPort), `port=${String(httpsPort)}`);

      let altError = null;
      try {
        await httpsGet(httpsPort, ca.certPem);
      } catch (error) {
        altError = errCode(error);
      }
      check(
        '③ 链可信但主机名不匹配 → 严格校验报 ALTNAME（不会因为链对就放行）',
        altError !== null && /ALTNAME|altnames/i.test(altError),
        altError ?? '（竟然通过了）',
      );
    } finally {
      worker.child.kill();
      await delay(300);
    }
  }

  // ── ⑤ 临期告警 ────────────────────────────────────────────
  {
    const dir = mkdtempSync(join(tmpdir(), 'tcs-t110-ca-expiry-'));
    dirs.push(dir);
    const port = BASE_PORT + 20;
    const httpsPort = port + 1000;
    const expiring = await ca.issue({
      subject: 'CN=localhost',
      sans: [{ type: 'dns', value: 'localhost' }],
      days: 10,
      serial: '04',
    });
    const certPath = join(dir, 'expiring.crt');
    const keyPath = join(dir, 'expiring.key');
    writeFileSync(certPath, expiring.certPem, 'utf8');
    writeFileSync(keyPath, expiring.keyPem, 'utf8');

    const worker = startWorker(writeConfig(dir, port, { mode: 'custom', httpsPort, certPath, keyPath }));
    try {
      const up = await waitTcp(httpsPort);
      // 日志可能有一点点延迟，给 300ms 再读
      await delay(300);
      const all = worker.logs.out + worker.logs.err;
      check('⑤ 10 天有效期：仍然启动（告警不是拦截）', up, `port=${String(httpsPort)}`);
      check(
        '⑤ 启动日志给出"将在 N 天后过期"告警',
        /天后过期/.test(all) && /custom/.test(all),
        all.split('\n').find((line) => /过期/.test(line))?.slice(0, 140) ?? '(无相关日志)',
      );
    } finally {
      worker.child.kill();
      await delay(300);
    }
  }

  // ── ⑤ 已过期 → 拒绝启动 ───────────────────────────────────
  {
    const dir = mkdtempSync(join(tmpdir(), 'tcs-t110-ca-expired-'));
    dirs.push(dir);
    const port = BASE_PORT + 30;
    const expired = await ca.issue({
      subject: 'CN=localhost',
      sans: [{ type: 'dns', value: 'localhost' }],
      serial: '05',
      notAfter: new Date(Date.now() - 2 * DAY),
    });
    const certPath = join(dir, 'expired.crt');
    const keyPath = join(dir, 'expired.key');
    writeFileSync(certPath, expired.certPem, 'utf8');
    writeFileSync(keyPath, expired.keyPem, 'utf8');

    const worker = startWorker(writeConfig(dir, port, { mode: 'custom', httpsPort: port + 1000, certPath, keyPath }));
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && worker.exitCode === null) await delay(150);
    check(
      '⑤ 已过期的 custom 证书 → 进程非 0 退出（不退回明文）',
      worker.exitCode !== null && worker.exitCode !== 0,
      `exit=${String(worker.exitCode)}`,
    );
    const all = worker.logs.out + worker.logs.err;
    check(
      '⑤ 报错同时说明"过期"与"请更换"',
      /过期/.test(all) && /更换/.test(all),
      all.split('\n').find((line) => /过期/.test(line))?.slice(0, 140) ?? '(无相关日志)',
    );
    if (worker.exitCode === null) worker.child.kill();
  }
} finally {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 偶发占用 */
    }
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n合计 ${String(results.length)} 项，失败 ${String(failed.length)} 项`);
  if (failed.length > 0) process.exitCode = 1;
}
