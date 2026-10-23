/**
 * T10.5 冒烟：真服务端进程下跑三种 TLS 模式。
 *
 * 要证明的是"配置一改，进程行为真的跟着变"，而不只是单元函数正确：
 *   · off         → 只有 HTTP，日志里有 tls.plaintext 警告
 *   · selfsigned  → HTTP + HTTPS 同时可用；HTTPS 用自签证书能握手
 *   · custom 不匹配 → **进程启动失败**（不是退回 off）
 *
 * 用法：node scripts/smoke-t105.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import https from 'node:https';
import { webcrypto } from 'node:crypto';
import { X509CertificateGenerator, cryptoProvider } from '@peculiar/x509';

cryptoProvider.set(webcrypto);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' —— ' + detail : ''}`);
};

const BASE_PORT = 19300 + Math.floor(Math.random() * 300);

function makeConfig(dir, overrides) {
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        port: overrides.port,
        controlPort: overrides.port + 1,
        host: '127.0.0.1',
        controlHost: '127.0.0.1',
        dataDir: join(dir, 'store'),
        rulesDir: 'rules',
        defaultPlatformRule: 'sillytavern',
        defaultPreset: 'default',
        maxUploadBytes: 33554432,
        logLevel: 'info',
        auth: {
          token: 'legacy-token-aaaaaaaaaaaaaaaaaaaaaaaa',
          require: true,
          publicPaths: ['/api/health'],
          registerMode: 'closed',
          jwtSecret: 'unit-test-jwt-secret-aaaaaaaaaaaaaaaaaaaaaaaa',
        },
        tls: overrides.tls,
        service: { mode: 'process', name: 'T105', displayName: 'T105', autoStart: false },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  return configPath;
}

/** 起一个 worker，收集 stderr/stdout，返回 { child, logs, exited } */
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

async function waitHttp(port, path = '/api/health', timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}${path}`);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await delay(150);
  }
  return false;
}

function httpsGet(port, { rejectUnauthorized }) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      { host: '127.0.0.1', port, path: '/api/health', method: 'GET', rejectUnauthorized, timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += String(c)));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.end();
  });
}

async function waitHttps(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpsGet(port, { rejectUnauthorized: false });
      if (res.status === 200) return true;
    } catch {
      /* 还没起来 */
    }
    await delay(150);
  }
  return false;
}

const dirs = [];

try {
  // ── ① off ────────────────────────────────────────────────
  {
    const dir = mkdtempSync(join(tmpdir(), 'tcs-t105-off-'));
    dirs.push(dir);
    const port = BASE_PORT;
    const configPath = makeConfig(dir, { port, tls: { mode: 'off', httpsPort: port + 1000, certPath: '', keyPath: '' } });
    const worker = startWorker(configPath);
    try {
      const up = await waitHttp(port);
      check('off：HTTP 正常起来', up, `port=${String(port)}`);
      check('off：日志里有 tls.plaintext 警告', worker.logs.out.includes('tls.plaintext'), '');
      // HTTPS 端口不该被监听
      let httpsFailed = false;
      try {
        await httpsGet(port + 1000, { rejectUnauthorized: false });
      } catch {
        httpsFailed = true;
      }
      check('off：HTTPS 端口没有被监听', httpsFailed, '');
    } finally {
      worker.child.kill();
      await delay(300);
    }
    // 证书文件不该存在 —— 单独判断，别塞在 try/catch 里靠抛错来"通过"
    check('off：没有生成证书文件', !existsSync(join(dir, 'store', 'tls', 'server.crt')), '');
  }

  // ── ② selfsigned ─────────────────────────────────────────
  {
    const dir = mkdtempSync(join(tmpdir(), 'tcs-t105-ss-'));
    dirs.push(dir);
    const port = BASE_PORT + 10;
    const httpsPort = port + 1000;
    const configPath = makeConfig(dir, {
      port,
      tls: { mode: 'selfsigned', httpsPort, certPath: '', keyPath: '' },
    });
    const worker = startWorker(configPath);
    try {
      const httpUp = await waitHttp(port);
      check('selfsigned：HTTP 仍然可用（双通窗口）', httpUp, `port=${String(port)}`);

      const httpsUp = await waitHttps(httpsPort);
      check('selfsigned：HTTPS 可用（自签能握手）', httpsUp, `port=${String(httpsPort)}`);

      // 严格校验必须失败 —— 证明它确实是自签的
      let strictFailed = null;
      try {
        await httpsGet(httpsPort, { rejectUnauthorized: true });
      } catch (error) {
        strictFailed = String(error.code ?? error.message);
      }
      check(
        'selfsigned：严格校验时被拒（确实未被系统信任）',
        strictFailed !== null && /SELF_SIGNED|DEPTH_ZERO|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(strictFailed),
        strictFailed ?? '（竟然通过了）',
      );

      check(
        'selfsigned：日志里打印了证书指纹',
        /tls\.certificate/.test(worker.logs.out) && /fingerprint/.test(worker.logs.out),
        '',
      );

      // 证书文件 + 私钥都在
      const certPem = readFileSync(join(dir, 'store', 'tls', 'server.crt'), 'utf8');
      const keyPem = readFileSync(join(dir, 'store', 'tls', 'server.key'), 'utf8');
      check('selfsigned：证书与私钥已落盘', certPem.includes('BEGIN CERTIFICATE') && keyPem.includes('BEGIN PRIVATE KEY'));
    } finally {
      worker.child.kill();
      await delay(300);
    }
  }

  // ── ③ custom 不匹配 → 启动失败 ───────────────────────────
  {
    const dir = mkdtempSync(join(tmpdir(), 'tcs-t105-bad-'));
    dirs.push(dir);
    const port = BASE_PORT + 20;

    const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
    const keysA = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
    const keysB = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
    const certA = await X509CertificateGenerator.createSelfSigned({
      serialNumber: '11',
      name: 'CN=a.example.com',
      notBefore: new Date(Date.now() - 60000),
      notAfter: new Date(Date.now() + 100 * 86400000),
      signingAlgorithm: alg,
      keys: keysA,
    });
    const pkcs8B = await webcrypto.subtle.exportKey('pkcs8', keysB.privateKey);
    const certPath = join(dir, 'a.crt');
    const keyPath = join(dir, 'b.key');
    writeFileSync(certPath, certA.toString('pem'), 'utf8');
    writeFileSync(
      keyPath,
      `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8B).toString('base64').match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`,
      'utf8',
    );

    const configPath = makeConfig(dir, {
      port,
      tls: { mode: 'custom', httpsPort: port + 1000, certPath, keyPath },
    });
    const worker = startWorker(configPath);

    // 等它退出（应当失败退出，而不是继续跑）
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && worker.exitCode === null) await delay(150);

    check('custom 不匹配：进程以非 0 退出', worker.exitCode !== null && worker.exitCode !== 0, `exit=${String(worker.exitCode)}`);
    const allLogs = worker.logs.out + worker.logs.err;
    check('custom 不匹配：报错说明"不会退回明文"', /不匹配/.test(allLogs) && /不会退回明文/.test(allLogs), '');
    if (worker.exitCode === null) worker.child.kill();
  }

  // ── ④ custom 匹配 → 正常启动 ─────────────────────────────
  {
    const dir = mkdtempSync(join(tmpdir(), 'tcs-t105-good-'));
    dirs.push(dir);
    const port = BASE_PORT + 30;
    const httpsPort = port + 1000;

    const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
    const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
    const cert = await X509CertificateGenerator.createSelfSigned({
      serialNumber: '12',
      name: 'CN=good.example.com',
      notBefore: new Date(Date.now() - 60000),
      notAfter: new Date(Date.now() + 100 * 86400000),
      signingAlgorithm: alg,
      keys,
    });
    const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
    const certPath = join(dir, 'good.crt');
    const keyPath = join(dir, 'good.key');
    writeFileSync(certPath, cert.toString('pem'), 'utf8');
    writeFileSync(
      keyPath,
      `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString('base64').match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`,
      'utf8',
    );

    const configPath = makeConfig(dir, { port, tls: { mode: 'custom', httpsPort, certPath, keyPath } });
    const worker = startWorker(configPath);
    try {
      const httpsUp = await waitHttps(httpsPort);
      check('custom 匹配：HTTPS 正常起来', httpsUp, `port=${String(httpsPort)}`);
      check(
        'custom：日志注明证书是自签（提示客户端需信任）',
        /tls\.warning/.test(worker.logs.out),
        '（用户自带的自签证书要提醒）',
      );
    } finally {
      worker.child.kill();
      await delay(300);
    }
  }
} finally {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 进程可能还占着 */
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`);
process.exit(failed.length === 0 ? 0 : 1);
