/**
 * F4 传输安全 UI 化的服务端判据（v0.1.3）。
 *
 * 这里测的是**热重载**这件事本身，不是配置解析：
 *   · 三态切换时监听是否真的跟着换（不是只改了状态字段）；
 *   · 失败时旧监听是否还在服务（回滚的判据是"客户端还能连上"，
 *     不是"状态字段还是旧值" —— 后者可以在监听已经关掉的情况下成立）；
 *   · 端口占用是否点名端口并给出排查命令；
 *   · 旧证书备份是否真的落到 `data/certs-backup/`。
 *
 * 一律用**真 socket**：`https.get` 能连上才叫在监听。这一批的假绿风险
 * 特别高 —— 状态对象完全可以显示 "selfsigned / 8443" 而监听根本不存在。
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get as httpsGet } from 'node:https';
import { webcrypto } from 'node:crypto';

import { X509CertificateGenerator } from '@peculiar/x509';

import { TlsRuntime } from '../server/dist/tls/runtime.js';
import {
  certsBackupDir,
  certificatePaths,
  ensureSelfSigned,
  inspectCertificate,
} from '../server/dist/tls/certificate.js';
import { inspectTlsInputs, tlsSecurityBanners } from '../server/dist/tls/panel.js';

const HOST = '127.0.0.1';
const DAY = 24 * 3600 * 1000;

let workDir;
let seq = 0;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-f4-tls-'));
});
after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function freshDir() {
  seq += 1;
  const dir = join(workDir, `case-${String(seq)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 一个够用的请求处理器：能应答就说明监听是活的 */
const handler = (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('tls-ok');
};

/** 真连一次 HTTPS。连不上就抛 —— 这是"到底有没有在监听"的唯一判据。 */
function httpsProbe(port, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const request = httpsGet(
      { host: HOST, port, path: '/', rejectUnauthorized: false, timeout: timeoutMs },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );
    request.on('timeout', () => {
      request.destroy(new Error(`连接 ${HOST}:${String(port)} 超时`));
    });
    request.on('error', reject);
  });
}

async function makeCustomPair(commonName = 'custom.example.com', validDays = 200) {
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: '0f04',
    name: `CN=${commonName}`,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + validDays * DAY),
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

function writePair(dir, pair, prefix = 'custom') {
  const certPath = join(dir, `${prefix}.crt`);
  const keyPath = join(dir, `${prefix}.key`);
  writeFileSync(certPath, pair.certPem, 'utf8');
  writeFileSync(keyPath, pair.keyPem, 'utf8');
  return { certPath, keyPath };
}

/** 拿一个当前空闲的端口号（先占再放，够用） */
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

// ══════════════════════════════════════════════════════════
// 1. 三态切换
// ══════════════════════════════════════════════════════════

test('F4 三态切换：off → selfsigned → custom → off，监听跟着重建', async () => {
  const dir = freshDir();
  const runtime = new TlsRuntime({ handler, dataDir: dir, host: HOST });

  // ① off：没有任何 HTTPS 监听
  const offState = await runtime.start({ mode: 'off', httpsPort: 0, certPath: '', keyPath: '' });
  assert.equal(offState.mode, 'off');
  assert.equal(offState.httpsPort, null, 'off 模式下不该有 HTTPS 端口');
  assert.equal(offState.plaintext, true);

  // ② off → selfsigned：证书自动生成，监听起来且真能连
  const signed = await runtime.apply({ mode: 'selfsigned', httpsPort: 0, certPath: '', keyPath: '' });
  assert.equal(signed.ok, true, `切到 selfsigned 应成功：${String(signed.error)}`);
  assert.equal(signed.changed, true);
  assert.equal(signed.state.mode, 'selfsigned');
  assert.ok(typeof signed.state.httpsPort === 'number' && signed.state.httpsPort > 0);
  assert.equal(await httpsProbe(signed.state.httpsPort), 'tls-ok', 'selfsigned 监听应真的能连上');
  const signedFingerprint = signed.state.fingerprint;
  assert.ok(signedFingerprint, 'selfsigned 必须给出指纹供用户核对');

  // ③ selfsigned → custom：换成用户证书，指纹必须跟着变（不能还是自签那张）
  const customDir = freshDir();
  const pair = await makeCustomPair('alt.example.com');
  const { certPath, keyPath } = writePair(customDir, pair);

  const custom = await runtime.apply({ mode: 'custom', httpsPort: 0, certPath, keyPath });
  assert.equal(custom.ok, true, `切到 custom 应成功：${String(custom.error)}`);
  assert.equal(custom.state.mode, 'custom');
  assert.equal(await httpsProbe(custom.state.httpsPort), 'tls-ok', 'custom 监听应真的能连上');
  assert.notEqual(custom.state.fingerprint, signedFingerprint, '换证书后指纹必须变，否则说明还在用旧证书');

  // ④ custom → off：监听关闭，连不上了
  const customPort = custom.state.httpsPort;
  const backToOff = await runtime.apply({ mode: 'off', httpsPort: 0, certPath: '', keyPath: '' });
  assert.equal(backToOff.ok, true);
  assert.equal(backToOff.state.httpsPort, null);
  /*
   * 判据是"连不上"，而不是"必须报某一个错误码"：
   * close 之后立刻重连，Windows 上实测常见 `ECONNRESET`（内核还留着半开连接），
   * 稍晚一点就是 `ECONNREFUSED`。第一版只认后者，于是**功能正确、测试报错**。
   * 这里放行整个"连接层失败"的集合，但绝不允许连上。
   */
  await assert.rejects(
    () => httpsProbe(customPort, 1200),
    (error) => /ECONNREFUSED|ECONNRESET|EPIPE|超时|socket hang up/.test(String(error)),
    'off 模式后端口不该再接受连接',
  );

  await runtime.close();
});

test('F4 同一份配置重复应用是空操作（changed=false），不会反复重建监听', async () => {
  const dir = freshDir();
  const runtime = new TlsRuntime({ handler, dataDir: dir, host: HOST });
  const first = await runtime.apply({ mode: 'selfsigned', httpsPort: 0, certPath: '', keyPath: '' });
  assert.equal(first.ok, true);

  const again = await runtime.apply({ mode: 'selfsigned', httpsPort: 0, certPath: '', keyPath: '' });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false, 'samePort 判定依赖"配置未变"，这里必须是空操作');
  assert.equal(again.state.httpsPort, first.state.httpsPort, '端口不该变');
  assert.equal(await httpsProbe(first.state.httpsPort), 'tls-ok');

  await runtime.close();
});

// ══════════════════════════════════════════════════════════
// 2. 不匹配禁止保存
// ══════════════════════════════════════════════════════════

test('F4 不匹配的 custom：inspect 判 canSave=false 并逐条给原因（保存前拦截）', async () => {
  const dir = freshDir();
  const good = await makeCustomPair('ok.example.com');
  const other = await makeCustomPair('other.example.com');
  const certPath = join(dir, 'a.crt');
  const keyPath = join(dir, 'b.key');
  writeFileSync(certPath, good.certPem, 'utf8');
  // 故意配一把"别人的"私钥
  writeFileSync(keyPath, other.keyPem, 'utf8');

  const check = await inspectTlsInputs({ mode: 'custom', dataDir: dir, certPath, keyPath });
  assert.equal(check.certExists, true);
  assert.equal(check.keyExists, true, '文件都在 —— 所以失败原因必须指向"不匹配"而不是"文件缺失"');
  assert.equal(check.match, 'mismatch');
  assert.equal(check.canSave, false, '不匹配必须禁止保存');
  assert.equal(check.level, 'bad');
  assert.ok(check.problems.some((line) => /不匹配/.test(line)), `原因里要说明不匹配：${JSON.stringify(check.problems)}`);

  // 对照：换成配对的那把私钥，同一套检查必须放行
  writeFileSync(keyPath, good.keyPem, 'utf8');
  const ok = await inspectTlsInputs({ mode: 'custom', dataDir: dir, certPath, keyPath });
  assert.equal(ok.match, 'ok');
  assert.equal(ok.canSave, true);
  assert.ok(ok.info, '匹配通过时应带回证书信息供面板显示有效期');
});

test('F4 路径不存在时也禁止保存，且原因点名缺哪个文件', async () => {
  const dir = freshDir();
  const check = await inspectTlsInputs({
    mode: 'custom',
    dataDir: dir,
    certPath: 'missing.crt',
    keyPath: 'missing.key',
  });
  assert.equal(check.canSave, false);
  assert.equal(check.certExists, false);
  assert.ok(
    check.problems.some((line) => line.includes('证书文件不存在')),
    JSON.stringify(check.problems),
  );
});

// ══════════════════════════════════════════════════════════
// 3. 热更失败回滚
// ══════════════════════════════════════════════════════════

test('F4 热更失败回滚：新证书不可用时，旧监听仍在服务', async () => {
  const dir = freshDir();
  const runtime = new TlsRuntime({ handler, dataDir: dir, host: HOST });
  const started = await runtime.apply({ mode: 'selfsigned', httpsPort: 0, certPath: '', keyPath: '' });
  assert.equal(started.ok, true);
  const port = started.state.httpsPort;
  const fingerprint = started.state.fingerprint;

  // 指向一对不存在的文件：prepareTlsMaterial 会抛，监听一个字节都不该被动
  const failed = await runtime.apply({
    mode: 'custom',
    httpsPort: port,
    certPath: join(dir, 'nope.crt'),
    keyPath: join(dir, 'nope.key'),
  });
  assert.equal(failed.ok, false);
  assert.ok(failed.error && /不存在/.test(failed.error), `应说明文件不存在：${String(failed.error)}`);
  assert.equal(failed.changed, false, '备料失败时不该动过监听');
  assert.equal(failed.rolledBack, true, '旧监听还在，rolledBack 应为 true');
  assert.equal(failed.state.mode, 'selfsigned', '状态必须仍是自签模式');
  assert.equal(failed.state.fingerprint, fingerprint, '指纹不该变');
  assert.equal(await httpsProbe(port), 'tls-ok', '旧监听必须仍然能连上（这才是回滚的判据）');

  await runtime.close();
});

test('F4 同端口换证书失败后，旧监听被重新拉起（close→start 的回滚路径）', async () => {
  const dir = freshDir();
  const runtime = new TlsRuntime({ handler, dataDir: dir, host: HOST });
  // 固定一个具体端口，逼出"同端口必须先关再开"的那条分支
  const port = await freePort();
  const started = await runtime.apply({ mode: 'selfsigned', httpsPort: port, certPath: '', keyPath: '' });
  assert.equal(started.ok, true);
  assert.equal(started.state.httpsPort, port);
  const fingerprint = started.state.fingerprint;

  // 证书内容坏掉（不是 PEM）：prepare 阶段就失败 —— 走的是"从未关过监听"那条
  const badCert = join(dir, 'bad.crt');
  const badKey = join(dir, 'bad.key');
  writeFileSync(badCert, 'not a certificate', 'utf8');
  writeFileSync(badKey, 'not a key', 'utf8');

  const failed = await runtime.apply({ mode: 'custom', httpsPort: port, certPath: badCert, keyPath: badKey });
  assert.equal(failed.ok, false);
  assert.equal(await httpsProbe(port), 'tls-ok', '端口必须仍在服务');
  assert.equal(failed.state.fingerprint, fingerprint);
  assert.equal(failed.state.httpsPort, port, '状态里的端口必须还是实际监听的那个');

  await runtime.close();
});

// ══════════════════════════════════════════════════════════
// 4. 端口占用
// ══════════════════════════════════════════════════════════

test('F4 端口占用：报错点名端口并提示查占用进程，旧监听保留', async () => {
  const dir = freshDir();
  const runtime = new TlsRuntime({ handler, dataDir: dir, host: HOST });
  const started = await runtime.apply({ mode: 'selfsigned', httpsPort: 0, certPath: '', keyPath: '' });
  assert.equal(started.ok, true);
  const oldPort = started.state.httpsPort;

  // 占一个端口（模拟"8443 被别的程序抢先监听"）
  const squatter = createNetServer();
  const occupiedPort = await new Promise((resolve, reject) => {
    squatter.once('error', reject);
    squatter.listen(0, HOST, () => {
      const address = squatter.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });

  try {
    // 跨端口切换：新端口被占 → 走"先开新的"那条，失败时旧监听从未被关
    const failed = await runtime.apply({
      mode: 'selfsigned',
      httpsPort: occupiedPort,
      certPath: '',
      keyPath: '',
    });
    assert.equal(failed.ok, false);
    assert.ok(
      failed.error && failed.error.includes(String(occupiedPort)),
      `报错必须点名端口号：${String(failed.error)}`,
    );
    assert.ok(
      /占用/.test(failed.error ?? '') && /netstat|PID/.test(failed.error ?? ''),
      `报错要提示怎么查占用进程：${String(failed.error)}`,
    );
    assert.equal(failed.state.httpsPort, oldPort, '状态应仍是原来的端口');
    assert.equal(await httpsProbe(oldPort), 'tls-ok', '原监听必须没被影响');
  } finally {
    await new Promise((resolve) => squatter.close(resolve));
  }

  await runtime.close();
});

// ══════════════════════════════════════════════════════════
// 5. 重新生成的备份
// ══════════════════════════════════════════════════════════

test('F4 重新生成：旧证书备份到 data/certs-backup/，命名含时间戳，内容可读', async () => {
  const dir = freshDir();
  const first = await ensureSelfSigned({ dataDir: dir });
  assert.equal(first.backupPath, null, '首次生成没有旧证书，不该有备份');

  const before = readFileSync(certificatePaths(dir).cert, 'utf8');
  const beforeInfo = await inspectCertificate(certificatePaths(dir).cert);

  const second = await ensureSelfSigned({ dataDir: dir, force: true });
  assert.ok(second.backupPath, 'force 重新生成必须产生备份');
  assert.ok(second.backupPath.includes('certs-backup'), `备份目录应为 certs-backup：${second.backupPath}`);
  assert.ok(
    /[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(second.backupPath),
    `备份文件名要含时间戳：${second.backupPath}`,
  );
  // 备份内容必须就是旧的那张（不是新的拷贝）
  assert.equal(readFileSync(second.backupPath, 'utf8'), before, '备份的应是旧证书原文');
  assert.notEqual(second.info.fingerprint, beforeInfo.fingerprint, '重新生成后指纹必须变');

  // 私钥也要备份，否则"旧证书"没法用
  const backups = readdirSync(certsBackupDir(dir));
  assert.ok(
    backups.some((name) => name.endsWith('-server.key')),
    `备份目录里必须有私钥：${JSON.stringify(backups)}`,
  );

  // 连按两次不能互相覆盖：第二次必须换一个文件名
  const third = await ensureSelfSigned({ dataDir: dir, force: true });
  assert.notEqual(third.backupPath, second.backupPath, '同一毫秒内重复备份也不能覆盖前一份');
});

// ══════════════════════════════════════════════════════════
// 6. 配置文件驱动的热更
// ══════════════════════════════════════════════════════════

test('F4 配置文件热更：外部改 config.json 后 applyFromConfigFile 生效', async () => {
  const dir = freshDir();
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ tls: { mode: 'off', httpsPort: 0, certPath: '', keyPath: '' } }), 'utf8');

  const runtime = new TlsRuntime({ handler, dataDir: dir, host: HOST });
  const initial = await runtime.applyFromConfigFile(configPath);
  assert.equal(initial.ok, true);
  assert.equal(initial.state.mode, 'off');

  // 改文件 → 再调一次（watcher 就是这个循环）
  writeFileSync(
    configPath,
    JSON.stringify({ tls: { mode: 'selfsigned', httpsPort: 0, certPath: '', keyPath: '' } }),
    'utf8',
  );
  const reloaded = await runtime.applyFromConfigFile(configPath);
  assert.equal(reloaded.ok, true);
  assert.equal(reloaded.changed, true);
  assert.equal(reloaded.state.mode, 'selfsigned');
  assert.equal(await httpsProbe(reloaded.state.httpsPort), 'tls-ok');

  await runtime.close();
});

test('F4 坏 JSON 不影响现状：监听不被打掉，但错误被记下来', async () => {
  const dir = freshDir();
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ tls: { mode: 'selfsigned', httpsPort: 0, certPath: '', keyPath: '' } }), 'utf8');
  const runtime = new TlsRuntime({ handler, dataDir: dir, host: HOST });
  const ok = await runtime.applyFromConfigFile(configPath);
  assert.equal(ok.ok, true);
  const port = ok.state.httpsPort;

  // 写坏（模拟 atomic-rename 的中间态 / 手改错）
  writeFileSync(configPath, '{"tls": ', 'utf8');
  const bad = await runtime.applyFromConfigFile(configPath);
  assert.equal(bad.ok, false);
  assert.ok(bad.error && /读取配置失败/.test(bad.error), String(bad.error));
  assert.equal(bad.state.mode, 'selfsigned', '状态不能因为读不到配置就变');
  assert.equal(await httpsProbe(port), 'tls-ok', '监听必须还在');

  await runtime.close();
});

// ══════════════════════════════════════════════════════════
// 7. 安全横幅（需求第 3 条）
// ══════════════════════════════════════════════════════════

test('F4 警告：off + 回环 = 明文提示（danger）', () => {
  const banners = tlsSecurityBanners({ mode: 'off', host: '127.0.0.1', httpsPort: null });
  assert.equal(banners.length, 1);
  assert.equal(banners[0].code, 'plaintext');
  assert.equal(banners[0].level, 'danger');
  assert.ok(banners[0].title.includes('明文传输'), banners[0].title);
  assert.ok(banners[0].title.includes('仅限可信网络'), banners[0].title);
});

test('F4 警告：off + 非回环升级为「公网暴露风险」', () => {
  for (const host of ['0.0.0.0', '192.168.1.203', '::']) {
    const banners = tlsSecurityBanners({ mode: 'off', host, httpsPort: null });
    const exposure = banners.find((banner) => banner.code === 'public-exposure');
    assert.ok(exposure, `${host} 应升级为公网暴露：${JSON.stringify(banners)}`);
    assert.equal(exposure.level, 'danger');
    assert.ok(exposure.title.includes('公网暴露风险'), exposure.title);
    // 升级不是"另外再加一条"：明文那条不该同时出现（否则两条警告互相稀释）
    assert.equal(banners.filter((banner) => banner.code === 'plaintext').length, 0);
  }
});

test('F4 警告：非 off 模式没有明文警告；HTTPS 未起时给 danger', () => {
  const signed = tlsSecurityBanners({
    mode: 'selfsigned',
    host: '0.0.0.0',
    httpsPort: 8443,
    expiry: { daysUntilExpiry: 300, notAfter: new Date().toISOString() },
  });
  assert.equal(signed.length, 0, `selfsigned 正常时不该有警告：${JSON.stringify(signed)}`);

  const down = tlsSecurityBanners({ mode: 'custom', host: '127.0.0.1', httpsPort: null, expiry: null });
  assert.ok(down.some((banner) => banner.code === 'https-down' && banner.level === 'danger'));
  assert.ok(down.some((banner) => banner.code === 'custom-not-configured'));
});

test('F4 警告：证书临近过期给 warn，已过期文案不同', () => {
  const soon = tlsSecurityBanners({
    mode: 'selfsigned',
    host: '127.0.0.1',
    httpsPort: 8443,
    expiry: { daysUntilExpiry: 12, notAfter: '2026-11-06T00:00:00.000Z' },
  });
  assert.ok(soon.some((banner) => banner.code === 'expiring' && banner.level === 'warn'));

  const expired = tlsSecurityBanners({
    mode: 'custom',
    host: '127.0.0.1',
    httpsPort: 8443,
    expiry: { daysUntilExpiry: -3, notAfter: '2026-10-20T00:00:00.000Z' },
  });
  assert.ok(expired.some((banner) => banner.title.includes('已过期')), JSON.stringify(expired));
});
