/**
 * F4 传输安全 UI 化的**端到端**验证（v0.1.3）。
 *
 * 单测（test/tls-hot-reload.test.mjs）已经证明"运行时能热重载"，但有一件事
 * 单测证明不了：**面板保存 → 控制面调 worker → 监听真的换了**这条链路。
 * 这条链跨了三个东西（HTTP 请求、配置文件、两个进程），任何一环退化成
 * "只改配置不重载"，单测都仍然是绿的。
 *
 * 所以这里真起一个 `serve`（supervisor + worker），用 HTTP 走完整流程：
 *
 *   ① off 起步：状态里 http 在听、https 没有、banner 是"明文"；
 *   ② off → selfsigned：保存即热更，**真连一次 https** 才算数；
 *   ③ 重新生成：旧证书进 certs-backup/，指纹变，且热更后连得上；
 *   ④ custom 不匹配：400 拒绝保存（需求"不匹配禁止保存"）；
 *   ⑤ custom 匹配：保存成功 + 真连；
 *   ⑥ 端口占用：409 + 回滚，**原监听仍可连**（这才是回滚的判据）；
 *   ⑦ worker 停掉时保存：配置保留、不谎报"已热更"。
 *
 * 用法：npm run build:server && node scripts/verify-f4-tls.mjs
 *
 * **注意：本脚本故意让 icacls 失败**（子进程环境变量 `TCS_TEST_ACL_FAIL=1`）。
 * v0.1.3 真机上，Windows 服务（LocalSystem）的 `/grant:r MP2F1GZG$:(F)` 必然失败，
 * 而当时的实现把它当致命错误 → 面板「重新生成」500 + 显示原始 stderr（含 ◆ 乱码）。
 * 让整条链路在"ACL 不可用"下跑一遍，才能证明证书生成不受影响、接口只回结构化 warning。
 * 正常路径的 ACL 由 `test/tls-acl.test.mjs` 用 SDDL 断言（真 icacls）。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';

import { X509CertificateGenerator } from '@peculiar/x509';

const REPO = process.cwd();
const STAMP = `${String(Date.now())}-${String(process.pid)}`;
const WORK = join(REPO, '.verify', 'f4', `run-${STAMP}`);
const DATA_DIR = join(WORK, 'data');
const CONFIG_PATH = join(WORK, 'config.json');
const TOKEN = 'f4-legacy-token-bbbbbbbbbbbbbbbbbbbbb';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  OK   ${name}${detail === '' ? '' : `  [${detail}]`}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail === '' ? '' : `  [${detail}]`}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const API = await freePort();
const CONTROL = await freePort();

async function call(path, options = {}) {
  const headers = {};
  if (TOKEN !== '') headers.Authorization = `Bearer ${TOKEN}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${String(CONTROL)}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

function httpsProbe(port, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const request = httpsGet(
      { host: '127.0.0.1', port, path: '/app.js', rejectUnauthorized: false, timeout: timeoutMs },
      (response) => {
        response.resume();
        response.on('end', () => resolve(true));
      },
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

async function makeCustomPair(commonName) {
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: '0f04',
    name: `CN=${commonName}`,
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 180 * 86_400_000),
    signingAlgorithm: alg,
    keys,
  });
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  const keyPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8)
    .toString('base64')
    .match(/.{1,64}/g)
    .join('\n')}\n-----END PRIVATE KEY-----\n`;
  return { certPem: cert.toString('pem'), keyPem };
}

mkdirSync(DATA_DIR, { recursive: true });

const now = new Date().toISOString();
writeFileSync(
  CONFIG_PATH,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      port: API,
      controlPort: CONTROL,
      host: '127.0.0.1',
      controlHost: '127.0.0.1',
      dataDir: DATA_DIR.replace(/\\/g, '/'),
      rulesDir: 'rules',
      defaultPlatformRule: 'sillytavern',
      defaultPreset: 'default',
      maxUploadBytes: 33_554_432,
      logLevel: 'error',
      auth: {
        token: TOKEN,
        require: true,
        publicPaths: ['/api/health'],
        registerMode: 'open',
        jwtSecret: 'f4-verify-secret-bbbbbbbbbbbbbbbbbbbb',
      },
      tls: { mode: 'off', httpsPort: await freePort(), certPath: '', keyPath: '' },
      service: { mode: 'process', name: 'F4', displayName: 'F4', autoStart: false },
      trash: { retentionDays: 30 },
      createdAt: now,
      updatedAt: now,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const logPath = join(WORK, 'server.log');
const child = spawn(process.execPath, ['server/dist/index.js', 'serve', '--config', CONFIG_PATH], {
  cwd: REPO,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    /*
     * **故意让 icacls 失败**（v0.1.3 真机事故的现场）。
     *
     * 真机上服务以 LocalSystem 跑在 session 0，`/grant:r MP2F1GZG$:(F)` 必然失败，
     * 而当时的实现把它当致命错误 → 面板「重新生成证书」直接 500 + 显示
     * `Command failed: icacls …`（含 ◆ 乱码与内部路径）。
     *
     * 让整条链路都在"ACL 不可用"的条件下跑一遍，才能证明：
     *   · 证书照样生成（ACL 是纵深防御，不是门禁）；
     *   · 接口返回 200 + 结构化 warning，而不是 500 + 原始 stderr；
     *   · ACL 坏掉不影响 TLS 热更的其它环节。
     *
     * 正常路径的 ACL 由 test/tls-acl.test.mjs 用 SDDL 断言（本机真 icacls）。
     */
    TCS_TEST_ACL_FAIL: '1',
  },
});
let serverLog = '';
child.stdout.on('data', (chunk) => {
  serverLog += String(chunk);
});
child.stderr.on('data', (chunk) => {
  serverLog += String(chunk);
});
writeFileSync(logPath, '', 'utf8');

async function cleanup() {
  try {
    child.kill('SIGTERM');
  } catch {
    /* 已经退了 */
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
  try {
    child.kill('SIGKILL');
  } catch {
    /* 同上 */
  }
  writeFileSync(logPath, serverLog, 'utf8');
}

/**
 * 等到**数据面也起来**为止。
 *
 * 只等控制面应答是不够的：`serve` 会先起 supervisor（面板 + /control/*），
 * 再 spawn worker（/api/*），两者相差一两百毫秒。第一版只等到 /control 有
 * 200 就往下跑，于是拿到一份 `workerRunning:false` 的状态，后面一连串
 * "HTTP 未监听 / 热更没应答"全部是**假失败** —— 服务其实好得很。
 */
async function waitReady() {
  for (let i = 0; i < 160; i += 1) {
    try {
      const result = await call('/control/tls/status');
      if (result.status === 200 && result.json?.workerRunning === true) return result.json;
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`服务未就绪（数据面始终没有应答）：\n${serverLog.slice(-2000)}`);
}

try {
  console.log(`\nF4 传输安全端到端（控制面 127.0.0.1:${String(CONTROL)}，数据面 :${String(API)}）`);
  console.log('  ⚠ 本次故意让 icacls 失败（TCS_TEST_ACL_FAIL=1）：模拟真机 session 0 的 ACL 故障');

  // ── ① off 起步 ────────────────────────────────────────
  let status = await waitReady();
  console.log('\n1. off 起步：警告与监听状态');
  check('config.mode = off', status.config.mode === 'off', status.config.mode);
  check('HTTP 在监听', status.listening.http !== null, JSON.stringify(status.listening.http));
  check('HTTPS 未监听', status.listening.https === null, JSON.stringify(status.listening.https));
  check('有明文警告', status.banners.some((b) => b.code === 'plaintext' && b.level === 'danger'));
  check('警告文案含「仅限可信网络」', status.banners.some((b) => b.title.includes('仅限可信网络')));
  check('带采样时间与数据来源', typeof status.sampledAt === 'string' && status.source === 'GET /api/stats', status.source);

  // ── ② off → selfsigned 热更 ────────────────────────────
  console.log('\n2. off → selfsigned：保存即热更（不重启进程）');
  const httpsPort = await freePort();
  const toSigned = await call('/control/config', {
    method: 'PUT',
    body: { tls: { mode: 'selfsigned', httpsPort } },
  });
  check('保存返回 200', toSigned.status === 200, String(toSigned.status));
  check('tlsReload.attempted = true', toSigned.json?.tlsReload?.attempted === true);
  check('tlsReload.ok = true', toSigned.json?.tlsReload?.ok === true, JSON.stringify(toSigned.json?.tlsReload));
  check('note 说明已热更', /已热更/.test(String(toSigned.json?.note ?? '')), String(toSigned.json?.note));

  status = (await call('/control/tls/status')).json;
  check('状态切到 selfsigned', status.config.mode === 'selfsigned', status.config.mode);
  check('HTTPS 端口在监听', status.listening.https?.port === httpsPort, JSON.stringify(status.listening.https));
  check('运行时有指纹', typeof status.runtime?.fingerprint === 'string' && status.runtime.fingerprint.length > 40);
  check('selfsigned 生效后没有明文警告', !status.banners.some((b) => b.code === 'plaintext'));
  const signedFingerprint = status.runtime.fingerprint;
  // **真连一次**：状态说在监听不等于真的能连
  check('真连 HTTPS 成功', await httpsProbe(httpsPort).then(() => true).catch(() => false));

  // ── ③ 重新生成 ────────────────────────────────────────
  console.log('\n3. 重新生成自签证书：备份 + 热更（本次**故意让 icacls 失败**）');
  const regen = await call('/control/tls/regenerate', { method: 'POST' });
  check('返回 200', regen.status === 200, String(regen.status));
  check(
    '旧证书备份进 certs-backup/',
    typeof regen.json?.backupPath === 'string' && regen.json.backupPath.includes('certs-backup'),
    String(regen.json?.backupPath ?? '（无备份路径）'),
  );
  check(
    '备份文件名含时间戳',
    /\d{4}-\d{2}-\d{2}T/.test(String(regen.json?.backupPath ?? '')),
    String(regen.json?.backupPath ?? ''),
  );
  check('指纹已变', regen.json?.info?.fingerprint !== signedFingerprint);
  check('热更成功', regen.json?.reload?.ok === true, JSON.stringify(regen.json?.reload));
  check('新证书也能连上', await httpsProbe(httpsPort).then(() => true).catch(() => false));

  /*
   * ACL 失败的四条判据（真机事故的回归）：
   *   · 不是 500 —— 证书生成不该因为 ACL 失败而失败；
   *   · 有一条结构化 warning；
   *   · warning 里**没有**原始 stderr / `Command failed` / 绝对路径（脱敏）；
   *   · 指纹确实换了 —— 证明确实"生成成功"，不是"报了个 warning 就什么都没做"。
   */
  const aclWarnings = Array.isArray(regen.json?.warnings) ? regen.json.warnings : [];
  check('ACL 失败被降级为 warning（不是 500）', regen.status === 200 && aclWarnings.length > 0, JSON.stringify(aclWarnings).slice(0, 120));
  const aclText = aclWarnings.join(' ');
  check(
    'warning 已脱敏：无 Command failed / 无绝对路径',
    !/Command failed/i.test(aclText) && !/[A-Za-z]:\\/.test(aclText),
    aclText.slice(0, 120),
  );
  check('ACL 失败但证书确实换了新的', regen.json?.info?.fingerprint !== signedFingerprint);

  // ── ④ custom 不匹配 ───────────────────────────────────
  console.log('\n4. custom 不匹配：禁止保存并回显原因');
  const good = await makeCustomPair('good.example.com');
  const other = await makeCustomPair('other.example.com');
  const certPath = join(WORK, 'good.crt');
  const badKeyPath = join(WORK, 'other.key');
  const goodKeyPath = join(WORK, 'good.key');
  writeFileSync(certPath, good.certPem, 'utf8');
  writeFileSync(goodKeyPath, good.keyPem, 'utf8');
  writeFileSync(badKeyPath, other.keyPem, 'utf8');

  const inspect = await call('/control/tls/inspect', {
    method: 'POST',
    body: { mode: 'custom', certPath, keyPath: badKeyPath },
  });
  check('即时检查返回 canSave=false', inspect.json?.canSave === false, JSON.stringify(inspect.json?.message));
  check('即时检查判为 mismatch', inspect.json?.match === 'mismatch', String(inspect.json?.match));

  const rejected = await call('/control/config', {
    method: 'PUT',
    body: { tls: { mode: 'custom', httpsPort, certPath, keyPath: badKeyPath } },
  });
  check('不匹配保存被拒（400）', rejected.status === 400, String(rejected.status));
  check('错误码 TLS_CERT_INVALID', rejected.json?.error?.code === 'TLS_CERT_INVALID', String(rejected.json?.error?.code));
  check(
    '回显逐条原因',
    Array.isArray(rejected.json?.error?.details?.problems) && rejected.json.error.details.problems.length > 0,
    JSON.stringify(rejected.json?.error?.details?.problems ?? []),
  );
  status = (await call('/control/tls/status')).json;
  check('配置没被改动（仍是 selfsigned）', status.config.mode === 'selfsigned', status.config.mode);
  check('原监听仍然可用', await httpsProbe(httpsPort).then(() => true).catch(() => false));

  // ── ⑤ custom 匹配 ─────────────────────────────────────
  console.log('\n5. custom 匹配：保存成功并热更');
  const customOk = await call('/control/config', {
    method: 'PUT',
    body: { tls: { mode: 'custom', httpsPort, certPath, keyPath: goodKeyPath } },
  });
  check('保存返回 200', customOk.status === 200, `${String(customOk.status)} ${customOk.text.slice(0, 160)}`);
  check('热更成功', customOk.json?.tlsReload?.ok === true, JSON.stringify(customOk.json?.tlsReload));
  status = (await call('/control/tls/status')).json;
  check('状态切到 custom', status.config.mode === 'custom', status.config.mode);
  check('运行时指纹已换成自定义证书的', status.runtime?.fingerprint !== signedFingerprint);
  check('自定义证书也能连上', await httpsProbe(httpsPort).then(() => true).catch(() => false));

  // ── ⑥ 端口占用 → 回滚 ─────────────────────────────────
  console.log('\n6. 目标端口被占用：409 + 回滚');
  const squatter = createNetServer();
  const occupied = await new Promise((resolve, reject) => {
    squatter.once('error', reject);
    squatter.listen(0, '127.0.0.1', () => {
      const address = squatter.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
  const occupiedAttempt = await call('/control/config', {
    method: 'PUT',
    body: { tls: { mode: 'custom', httpsPort: occupied, certPath, keyPath: goodKeyPath } },
  });
  check('返回 409', occupiedAttempt.status === 409, String(occupiedAttempt.status));
  check(
    '错误码 TLS_RELOAD_FAILED',
    occupiedAttempt.json?.error?.code === 'TLS_RELOAD_FAILED',
    String(occupiedAttempt.json?.error?.code),
  );
  check(
    '报错点名端口',
    String(occupiedAttempt.json?.error?.message ?? '').includes(String(occupied)),
    String(occupiedAttempt.json?.error?.message ?? '').slice(0, 120),
  );
  check('回执声明已回滚', occupiedAttempt.json?.error?.details?.rolledBack === true);
  status = (await call('/control/tls/status')).json;
  check('配置已回滚到原端口', status.config.httpsPort === httpsPort, String(status.config.httpsPort));
  check('原监听仍然能连（没有被热更打断）', await httpsProbe(httpsPort).then(() => true).catch(() => false));
  await new Promise((resolve) => squatter.close(resolve));

  // ── ⑦ worker 停掉时保存 ───────────────────────────────
  console.log('\n7. 数据面未运行时保存：配置保留、不谎报已热更');
  // 路径是 /control/service/<action>，不是带 body.action 的单一端点
  const stopped = await call('/control/service/stop', { method: 'POST' });
  check('worker 已停止', stopped.status === 200, String(stopped.status));
  const savedWhileDown = await call('/control/config', {
    method: 'PUT',
    body: { tls: { mode: 'off', httpsPort } },
  });
  check('保存返回 200（配置本身合法）', savedWhileDown.status === 200, String(savedWhileDown.status));
  check('attempted=true 但 ok=false', savedWhileDown.json?.tlsReload?.attempted === true && savedWhileDown.json?.tlsReload?.ok === false);
  check('没有误报"已回滚"', savedWhileDown.json?.tlsReload?.rolledBack === false, JSON.stringify(savedWhileDown.json?.tlsReload));
  check(
    'note 说明下次启动生效',
    /下次启动|未运行/.test(String(savedWhileDown.json?.note ?? '')),
    String(savedWhileDown.json?.note),
  );
  const afterStart = await call('/control/service/start', { method: 'POST' });
  check('worker 重新启动', afterStart.status === 200, String(afterStart.status));
  // 等它起来再读状态：off 模式下 https 应为 null
  let offStatus = null;
  for (let i = 0; i < 40; i += 1) {
    const probe = await call('/control/tls/status').catch(() => null);
    if (probe?.status === 200 && probe.json?.workerRunning === true) {
      offStatus = probe.json;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  check('重启后按新配置生效（off）', offStatus?.config.mode === 'off' && offStatus?.listening.https === null, JSON.stringify(offStatus?.listening ?? null));
} catch (error) {
  failed += 1;
  console.log(`\n运行中抛错：${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await cleanup();
}

console.log(`\n结果：${String(passed)} 项通过，${String(failed)} 项失败`);
if (failed > 0) {
  console.log(`服务端日志：${logPath}`);
  process.exit(1);
}
// 全部通过时也保留日志（排查"上一次为什么失败"时有用），只清数据目录
try {
  rmSync(DATA_DIR, { recursive: true, force: true });
} catch {
  /* 清不掉也无所谓，.verify 本来就不入库 */
}
process.exit(0);
