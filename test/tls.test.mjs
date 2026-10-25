/**
 * v0.1.2 / T10.5：TLS 三模式。
 *
 * 需求点名的四类测试：
 *   1. 三模式行为（off / selfsigned / custom）；
 *   2. 过期告警时间计算（**边界**：30 天整、29 天、已过期）；
 *   3. ACL 检查（私钥只有白名单主体可读）；
 *   4. custom 证书不匹配时的启动失败路径（且**不退回 off**）。
 *
 * 「过期时间计算」最容易写错的地方是边界：判据是 `daysUntilExpiry < 30`，
 * 那么"正好 30 天"不该告警、"29 天 23 小时"应该告警。用整天向下取整 +
 * 精确构造的 notAfter 来钉住这条线。
 *
 * 运行：node --test test/tls.test.mjs（需先 npm run build:server）
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, webcrypto } from 'node:crypto';

import { X509CertificateGenerator, cryptoProvider, X509Certificate } from '@peculiar/x509';

import {
  EXPIRY_WARNING_DAYS,
  SELF_SIGNED_VALIDITY_DAYS,
  certificatePaths,
  certsBackupDir,
  ensureSelfSigned,
  expiryWarningText,
  inspectCertificate,
  readKeyAclSddl,
  restrictKeyPermissions,
  validateCustomCertificate,
} from '../server/dist/tls/certificate.js';
import {
  DEFAULT_HTTPS_PORT,
  PLAINTEXT_BANNER,
  prepareTlsMaterial,
  runtimeTlsState,
  startHttpsServer,
} from '../server/dist/tls/server.js';
import { assertSafeConfig, normalizeConfig } from '../server/dist/config.js';

cryptoProvider.set(webcrypto);

let workDir;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-tls-'));
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

let seq = 0;
function freshDir() {
  seq += 1;
  const dir = join(workDir, `d${String(seq)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const DAY = 24 * 3600 * 1000;

/** 生成一对"自定义"证书（用独立算法参数，模拟用户自带证书） */
async function makeCustomPair(commonName = 'custom.example.com') {
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: '0102',
    name: `CN=${commonName}`,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + 200 * DAY),
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

// ══════════════════════════════════════════════════════════
// 1. selfsigned：生成 / 复用 / 续期
// ══════════════════════════════════════════════════════════

test('T10.5 selfsigned：首次启动生成证书，且有效期 365 天', async () => {
  const dir = freshDir();
  const now = new Date('2026-10-23T00:00:00.000Z');

  const result = await ensureSelfSigned({ dataDir: dir, now, commonName: 'Test Server' });

  assert.equal(result.generated, true);
  assert.equal(result.backupPath, null, '首次生成不该有备份');
  assert.ok(existsSync(result.paths.cert), '证书文件必须存在');
  assert.ok(existsSync(result.paths.key), '私钥文件必须存在');
  assert.ok(result.info.selfSigned, 'issuer 应与 subject 相同');
  assert.match(result.info.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/, '指纹应为 32 组大写十六进制');

  // 有效期：365 天（允许 1 天误差，issuer 可能按整秒取整）
  const actualDays = Math.round((new Date(result.info.notAfter).getTime() - now.getTime()) / DAY);
  assert.ok(
    Math.abs(actualDays - SELF_SIGNED_VALIDITY_DAYS) <= 1,
    `有效期应为 ${String(SELF_SIGNED_VALIDITY_DAYS)} 天，实际 ${String(actualDays)} 天`,
  );
});

test('T10.5 selfsigned：第二次启动复用同一张证书（指纹不变）', async () => {
  const dir = freshDir();
  const now = new Date('2026-10-23T00:00:00.000Z');

  const first = await ensureSelfSigned({ dataDir: dir, now });
  const second = await ensureSelfSigned({ dataDir: dir, now: new Date(now.getTime() + DAY) });

  assert.equal(second.generated, false, '没过期就应复用');
  assert.equal(second.info.fingerprint, first.info.fingerprint, '复用会改变指纹，说明被重新生成了');
});

test('T10.5 selfsigned：临近过期（<30 天）自动重新生成并保留旧证书备份', async () => {
  const dir = freshDir();
  const start = new Date('2026-10-23T00:00:00.000Z');

  const first = await ensureSelfSigned({ dataDir: dir, now: start });

  // 时间推到"还剩 10 天"
  const later = new Date(start.getTime() + (SELF_SIGNED_VALIDITY_DAYS - 10) * DAY);
  const second = await ensureSelfSigned({ dataDir: dir, now: later });

  assert.equal(second.generated, true, '少于 30 天应当续期');
  assert.ok(second.backupPath && existsSync(second.backupPath), '旧证书必须备份');
  assert.notEqual(second.info.fingerprint, first.info.fingerprint, '续期后指纹应改变');

  // 备份目录里应能看到旧文件（cert + key 各一份）。
  //
  // v0.1.3 / F4 起备份位置从"证书旁边的 .bak"改成 `data/certs-backup/`：
  // 面板的「重新生成」会让备份反复产生，散落在 `data/tls/` 里会与真正
  // 生效的 server.crt / server.key 混在一起，排查"客户端说证书变了"时分不清。
  const backups = readdirSync(certsBackupDir(dir));
  assert.ok(backups.length >= 2, `旧证书与旧私钥都要备份，实际只有 ${String(backups.length)} 个`);
  assert.ok(
    backups.some((name) => /-server\.crt$/.test(name)),
    `备份文件名要含时间戳且标明是证书：${JSON.stringify(backups)}`,
  );
});

test('T10.5 selfsigned：已过期也自动重新生成（重启不会带一张过期证书）', async () => {
  const dir = freshDir();
  const start = new Date('2026-10-23T00:00:00.000Z');
  await ensureSelfSigned({ dataDir: dir, now: start });

  const wayLater = new Date(start.getTime() + (SELF_SIGNED_VALIDITY_DAYS + 5) * DAY);
  const renewed = await ensureSelfSigned({ dataDir: dir, now: wayLater });

  assert.equal(renewed.generated, true);
  assert.ok(renewed.info.daysUntilExpiry > EXPIRY_WARNING_DAYS, '续期后应当是完整的一年');
});

// ══════════════════════════════════════════════════════════
// 2. 过期告警时间计算（边界）
// ══════════════════════════════════════════════════════════

test('T10.5 过期计算：daysUntilExpiry 按整天向下取整', async () => {
  const dir = freshDir();
  const now = new Date('2026-10-23T00:00:00.000Z');
  const result = await ensureSelfSigned({ dataDir: dir, now, validityDays: 365 });

  // 精确推进到还剩 29 天 23 小时 → 向下取整 29
  const almost30 = new Date(new Date(result.info.notAfter).getTime() - 29 * DAY - 23 * 3600 * 1000);
  const info = await inspectCertificate(result.paths.cert, almost30);
  assert.equal(info.daysUntilExpiry, 29, '29 天 23 小时应取整为 29（而不是 30）');

  // 还剩 30 天整 → 30
  const exactly30 = new Date(new Date(result.info.notAfter).getTime() - 30 * DAY);
  assert.equal((await inspectCertificate(result.paths.cert, exactly30)).daysUntilExpiry, 30);
});

test('T10.5 过期计算：告警判据边界（30 天整不告警，29 天告警）', async () => {
  const dir = freshDir();
  const now = new Date('2026-10-23T00:00:00.000Z');
  const result = await ensureSelfSigned({ dataDir: dir, now, validityDays: 365 });
  const notAfterMs = new Date(result.info.notAfter).getTime();

  const at30 = await inspectCertificate(result.paths.cert, new Date(notAfterMs - 30 * DAY));
  assert.equal(at30.daysUntilExpiry, 30);
  assert.equal(
    at30.daysUntilExpiry < EXPIRY_WARNING_DAYS,
    false,
    '正好 30 天不该触发告警（判据是 < 30）',
  );

  const at29 = await inspectCertificate(result.paths.cert, new Date(notAfterMs - 29 * DAY));
  assert.equal(at29.daysUntilExpiry, 29);
  assert.equal(at29.daysUntilExpiry < EXPIRY_WARNING_DAYS, true, '29 天必须触发告警');
});

test('T10.5 过期计算：已过期得到负数，告警文案说明客户端会拒绝连接', async () => {
  const dir = freshDir();
  const now = new Date('2026-10-23T00:00:00.000Z');

  // 注意：不能靠 ensureSelfSigned + 短有效期来造"已过期"，
  // 因为它一旦发现剩余天数 < 30 就会自动续期，永远拿不到已过期的证书。
  // 这里直接落一张明确过期的证书文件，只测 inspectCertificate 的计算。
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const expired = await X509CertificateGenerator.createSelfSigned({
    serialNumber: '09',
    name: 'CN=expired-probe',
    notBefore: new Date(now.getTime() - 30 * DAY),
    notAfter: new Date(now.getTime() - 10 * DAY),
    signingAlgorithm: alg,
    keys,
  });
  const certPath = join(dir, 'expired.crt');
  writeFileSync(certPath, expired.toString('pem'), 'utf8');

  const afterExpiry = await inspectCertificate(certPath, now);
  assert.ok(afterExpiry.daysUntilExpiry < 0, `应得到负数，实际 ${String(afterExpiry.daysUntilExpiry)}`);

  const text = expiryWarningText(afterExpiry);
  assert.match(text, /过期/);
  assert.match(text, /拒绝连接/, '文案要说明后果，否则用户不知道有多严重');
  assert.ok(text.includes(afterExpiry.fingerprint), '文案里带指纹，便于与面板核对');
});

test('T10.5 过期计算：临近过期但未过期的文案区别于已过期', async () => {
  const dir = freshDir();
  const now = new Date('2026-10-23T00:00:00.000Z');
  const result = await ensureSelfSigned({ dataDir: dir, now, validityDays: 365 });
  const soon = await inspectCertificate(result.paths.cert, new Date(new Date(result.info.notAfter).getTime() - 5 * DAY));

  const text = expiryWarningText(soon);
  assert.match(text, /5 天后过期/);
  assert.equal(/已于 .* 过期/.test(text), false, '未过期不该用"已于…过期"的措辞');
  assert.match(text, /自动续期/, '应告知用户重启即可续期');
});

// ══════════════════════════════════════════════════════════
// 3. ACL（v0.1.3 真机事故后改为 SID + SDDL 判据）
// ══════════════════════════════════════════════════════════

/**
 * 为什么不再解析 `icacls <file>` 的主体名：
 *
 * 那是**本地化文本**（`BUILTIN\Administrators`、`NT AUTHORITY\SYSTEM`），随系统语言
 * 变化，而且中文系统上 icacls 的提示行是 GBK —— Node 按 UTF-8 解码就是一堆 ◆。
 * 真机事故里面板上那些乱码正是这样来的。
 *
 * 改成读 SDDL：`icacls <file> /save` 写出 `D:PAI(A;;FA;;;BA)(A;;FA;;;SY)`，
 * 全是 ASCII，`BA`/`SY` 是众所周知主体的固定代码，任何语言下都一样。
 */
test('T10.5 ACL：私钥只授予 SYSTEM / Administrators / 当前用户（用 SID 判据）', async () => {
  const dir = freshDir();
  const result = await ensureSelfSigned({ dataDir: dir, now: new Date('2026-10-23T00:00:00.000Z') });

  if (process.platform !== 'win32') return; // 非 Windows 走 chmod 600，另有判据

  const sddl = await readKeyAclSddl(result.paths.key, join(dir, 'acl-save.txt'));
  assert.ok(sddl.startsWith('D:'), `SDDL 读不到：${sddl}`);

  // 必须有：SYSTEM（SY）与 Administrators（BA）
  assert.match(sddl, /;;;SY\)/, `私钥 ACL 缺少 SYSTEM：${sddl}`);
  assert.match(sddl, /;;;BA\)/, `私钥 ACL 缺少 Administrators：${sddl}`);

  // 必须没有：Everyone（WD）/ Users（BU）/ Authenticated Users（AU）
  // —— 这三个正是"父目录继承来的、对普通用户开放"的主体。
  for (const [code, name] of [
    ['WD', 'Everyone'],
    ['BU', 'Users'],
    ['AU', 'Authenticated Users'],
  ]) {
    assert.equal(
      sddl.includes(`;;;${String(code)})`),
      false,
      `私钥 ACL 里仍有 ${String(name)}（${String(code)}）—— /inheritance:r 没生效：${sddl}`,
    );
  }

  // 继承标记必须消失（PAI = 已去掉继承）
  assert.ok(sddl.includes('D:PAI'), `继承未被切断（期待 D:PAI 前缀）：${sddl}`);
});

test('T10.5 ACL：授权主体用 SID 字面量，不含任何账户名', async () => {
  const dir = freshDir();
  const results = [];
  const run = async (command, args) => {
    results.push(args);
  };
  const acl = await restrictKeyPermissions(join(dir, 'probe.key'), { run, userSid: null });
  assert.equal(acl.ok, true);
  assert.deepEqual(acl.grantees, ['*S-1-5-18', '*S-1-5-32-544'], `默认主体应是两个 SID：${String(acl.grantees)}`);

  const grantArgs = results.at(-1) ?? [];
  assert.ok(grantArgs.includes('/inheritance:r'), '必须同时去掉继承');
  for (const sid of ['*S-1-5-18:(F)', '*S-1-5-32-544:(F)']) {
    assert.ok(grantArgs.includes(sid), `缺少 SID 授权项 ${String(sid)}：${JSON.stringify(grantArgs)}`);
  }
  // 真机事故的根因：把机器账户名 / 用户账户名当主体传进去
  assert.equal(
    grantArgs.some((arg) => /MACHINE\$|MP2F1GZG\$|^[^*(]+:\(F\)$/.test(arg) && !arg.startsWith('*S-1-')),
    false,
    `授权参数里出现了非 SID 主体：${JSON.stringify(grantArgs)}`,
  );
});

test('T10.5 ACL：证书本身保持可读（它不是秘密，客户端要能取指纹）', async () => {
  const dir = freshDir();
  const result = await ensureSelfSigned({ dataDir: dir, now: new Date('2026-10-23T00:00:00.000Z') });
  // 只要"能读出来"就说明没被锁死
  const pem = await import('node:fs').then((fs) => fs.readFileSync(result.paths.cert, 'utf8'));
  assert.match(pem, /-----BEGIN CERTIFICATE-----/);
});

test('T10.5 ACL：restrictKeyPermissions 可重复执行（幂等）', async () => {
  const dir = freshDir();
  const result = await ensureSelfSigned({ dataDir: dir, now: new Date('2026-10-23T00:00:00.000Z') });

  const sddl = (path) => (process.platform === 'win32' ? readKeyAclSddl(path, join(dir, 'acl-idem.txt')) : Promise.resolve(''));
  const first = await sddl(result.paths.key);
  await restrictKeyPermissions(result.paths.key);
  await restrictKeyPermissions(result.paths.key);
  const after = await sddl(result.paths.key);

  if (process.platform === 'win32') {
    assert.equal(after, first, '重复收紧权限不该不断累加 ACE（每次启动都会调用）');
    // 反复执行后 ACE 数量仍应是 3（SY + BA + 当前用户）
    assert.equal((after.match(/\(A;/g) ?? []).length, 3, `ACE 数量应稳定为 3：${after}`);
  }
});

// ══════════════════════════════════════════════════════════
// 4. custom：匹配 / 不匹配
// ══════════════════════════════════════════════════════════

test('T10.5 custom：匹配的证书与私钥通过校验', async () => {
  const dir = freshDir();
  const pair = await makeCustomPair();
  const certPath = join(dir, 'c.pem');
  const keyPath = join(dir, 'k.pem');
  writeFileSync(certPath, pair.certPem, 'utf8');
  writeFileSync(keyPath, pair.keyPem, 'utf8');

  const info = await validateCustomCertificate(certPath, keyPath);
  assert.equal(info.selfSigned, true);
  assert.ok(info.daysUntilExpiry > 100);
  assert.match(info.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
});

test('T10.5 custom：证书与私钥不匹配时抛错，且消息说明不会退回明文', async () => {
  const dir = freshDir();
  const a = await makeCustomPair('a.example.com');
  const b = await makeCustomPair('b.example.com');
  const certPath = join(dir, 'a.crt');
  const wrongKeyPath = join(dir, 'b.key');
  writeFileSync(certPath, a.certPem, 'utf8');
  writeFileSync(wrongKeyPath, b.keyPem, 'utf8');

  await assert.rejects(
    () => validateCustomCertificate(certPath, wrongKeyPath),
    (error) => {
      assert.match(error.message, /不匹配/);
      assert.match(error.message, /不会退回明文模式/, '错误信息要明确"不会静默降级"，否则用户会以为服务仍能跑');
      return true;
    },
  );
});

test('T10.5 custom：证书文件缺失 / 私钥缺失 / 内容损坏都抛错', async () => {
  const dir = freshDir();
  const pair = await makeCustomPair();

  await assert.rejects(
    () => validateCustomCertificate(join(dir, 'nope.crt'), join(dir, 'nope.key')),
    /自定义证书不存在/,
  );

  const certPath = join(dir, 'ok.crt');
  writeFileSync(certPath, pair.certPem, 'utf8');
  await assert.rejects(() => validateCustomCertificate(certPath, join(dir, 'nope.key')), /自定义私钥不存在/);

  const badCert = join(dir, 'bad.crt');
  writeFileSync(badCert, 'not a certificate', 'utf8');
  const keyPath = join(dir, 'k.pem');
  writeFileSync(keyPath, pair.keyPem, 'utf8');
  await assert.rejects(() => validateCustomCertificate(badCert, keyPath), /无法解析/);

  // 私钥不是 PEM
  const badKey = join(dir, 'bad.key');
  writeFileSync(badKey, 'garbage', 'utf8');
  await assert.rejects(() => validateCustomCertificate(certPath, badKey), /不是 PEM 格式/);
});

test('T10.5 custom：RSA 证书也能通过匹配校验（不只支持 ECDSA）', async () => {
  const dir = freshDir();
  // 用 node 原生生成 RSA 私钥 —— 这是"用户自带证书"的常见形态
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  // 用同一把私钥自签一张 RSA 证书（x509 库需要一个 CryptoKey，这里直接用它签名）
  const imported = await webcrypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(keyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['sign'],
  );
  const publicJwk = await webcrypto.subtle.exportKey('jwk', imported);
  // 生成匹配的公钥用于自签
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  void publicJwk;

  const certPath = join(dir, 'rsa.crt');
  const keyPath = join(dir, 'rsa.key');
  // 用 node 直接构造：借助 x509 的 RSA 支持
  const rsaKeys = {
    privateKey: await webcrypto.subtle.importKey(
      'pkcs8',
      pemToArrayBuffer(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      true,
      ['sign'],
    ),
    publicKey: await webcrypto.subtle.importKey(
      'spki',
      pemToArrayBuffer(pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      true,
      ['verify'],
    ),
  };
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: '03',
    name: 'CN=rsa.example.com',
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + 100 * DAY),
    signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    keys: rsaKeys,
  });
  writeFileSync(certPath, cert.toString('pem'), 'utf8');
  writeFileSync(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8');

  const info = await validateCustomCertificate(certPath, keyPath);
  assert.equal(info.selfSigned, true);

  // 交叉验证：换一把 RSA 私钥必须失败
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wrongKey = join(dir, 'other.key');
  writeFileSync(wrongKey, other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8');
  await assert.rejects(() => validateCustomCertificate(certPath, wrongKey), /不匹配/);
});

function pemToArrayBuffer(pem) {
  const base64 = pem.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '');
  const buf = Buffer.from(base64, 'base64');
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// ══════════════════════════════════════════════════════════
// 5. 三模式行为（prepareTlsMaterial）
// ══════════════════════════════════════════════════════════

test('T10.5 off 模式：不准备任何材料，并给出明文横幅', async () => {
  const dir = freshDir();
  const prepared = await prepareTlsMaterial({
    config: { mode: 'off', httpsPort: DEFAULT_HTTPS_PORT, certPath: '', keyPath: '' },
    dataDir: dir,
  });

  assert.equal(prepared.material, null);
  assert.equal(prepared.info, null);
  assert.equal(prepared.plaintext, true);
  assert.equal(prepared.warnings.length, 0, 'off 是合法配置，不该产生告警（横幅由 UI 展示）');
  assert.equal(existsSync(certificatePaths(dir).cert), false, 'off 模式不该生成证书');
});

test('T10.5 selfsigned 模式：返回可用材料与证书信息', async () => {
  const dir = freshDir();
  const prepared = await prepareTlsMaterial({
    config: { mode: 'selfsigned', httpsPort: DEFAULT_HTTPS_PORT, certPath: '', keyPath: '' },
    dataDir: dir,
    now: new Date('2026-10-23T00:00:00.000Z'),
  });

  assert.ok(prepared.material?.cert.includes('BEGIN CERTIFICATE'));
  assert.ok(prepared.material?.key.includes('BEGIN PRIVATE KEY'));
  assert.ok(prepared.info);
  assert.equal(prepared.plaintext, false);
});

test('T10.5 custom 模式：材料来自用户文件，不是自动生成的', async () => {
  const dir = freshDir();
  const pair = await makeCustomPair('mine.example.com');
  const certPath = join(dir, 'mine.crt');
  const keyPath = join(dir, 'mine.key');
  writeFileSync(certPath, pair.certPem, 'utf8');
  writeFileSync(keyPath, pair.keyPem, 'utf8');

  const prepared = await prepareTlsMaterial({
    config: { mode: 'custom', httpsPort: DEFAULT_HTTPS_PORT, certPath, keyPath },
    dataDir: dir,
  });

  assert.equal(prepared.material?.cert, pair.certPem, '必须原样使用用户证书');
  assert.match(prepared.info?.subject ?? '', /mine\.example\.com/);
  assert.equal(existsSync(certificatePaths(dir).cert), false, 'custom 模式不该在数据目录里另生成一份');
});

test('T10.5 custom 模式：已过期证书拒绝启动（不是"尽力启动"）', async () => {
  const dir = freshDir();
  const pair = await makeCustomPair();
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const expired = await X509CertificateGenerator.createSelfSigned({
    serialNumber: '04',
    name: 'CN=expired.example.com',
    notBefore: new Date(Date.now() - 100 * DAY),
    notAfter: new Date(Date.now() - 10 * DAY),
    signingAlgorithm: alg,
    keys,
  });
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  const certPath = join(dir, 'expired.crt');
  const keyPath = join(dir, 'expired.key');
  writeFileSync(certPath, expired.toString('pem'), 'utf8');
  writeFileSync(
    keyPath,
    `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString('base64').match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`,
    'utf8',
  );

  await assert.rejects(
    () => prepareTlsMaterial({ config: { mode: 'custom', httpsPort: 8443, certPath, keyPath }, dataDir: dir }),
    /过期/,
  );
  void pair;
});

// ══════════════════════════════════════════════════════════
// 6. 配置校验
// ══════════════════════════════════════════════════════════

test('T10.5 配置：默认 off、httpsPort 8443', () => {
  const config = normalizeConfig({});
  assert.equal(config.tls.mode, 'off', '默认必须是 off —— 升级不能让已装客户端立刻连不上');
  assert.equal(config.tls.httpsPort, DEFAULT_HTTPS_PORT);
  assert.equal(DEFAULT_HTTPS_PORT, 8443);
});

test('T10.5 配置：非法 mode 回落到 off（不猜）', () => {
  for (const bad of ['TLS', 'selfsigned ', 'on', '', 123, null]) {
    const config = normalizeConfig({ tls: { mode: bad } });
    assert.equal(config.tls.mode, 'off', `mode=${JSON.stringify(bad)} 应回落到 off`);
  }
});

test('T10.5 配置：custom 缺 certPath/keyPath 时 assertSafeConfig 拒绝', () => {
  const config = normalizeConfig({ tls: { mode: 'custom' } });
  assert.throws(
    () => assertSafeConfig(config),
    /必须同时配置 tls\.certPath 与 tls\.keyPath/,
    '缺证书路径必须拒绝启动，不能退回明文',
  );
});

test('T10.5 配置：HTTPS 端口与 HTTP 端口相同要拒绝', () => {
  const config = normalizeConfig({ port: 9443, tls: { mode: 'selfsigned', httpsPort: 9443 } });
  assert.throws(() => assertSafeConfig(config), /HTTPS 端口与 HTTP 端口相同/);
});

test('T10.5 配置：httpsPort 越界拉回默认（避免 listen(0) 变随机端口）', () => {
  assert.equal(normalizeConfig({ tls: { httpsPort: 0 } }).tls.httpsPort, DEFAULT_HTTPS_PORT);
  assert.equal(normalizeConfig({ tls: { httpsPort: 99999 } }).tls.httpsPort, DEFAULT_HTTPS_PORT);
  assert.equal(normalizeConfig({ tls: { httpsPort: 9443 } }).tls.httpsPort, 9443);
});

// ══════════════════════════════════════════════════════════
// 7. 真 HTTPS 连接（自签可握手）
// ══════════════════════════════════════════════════════════

test('T10.5 真连接：自签证书的 HTTPS 服务能被 Node 客户端连上', async () => {
  const dir = freshDir();
  const prepared = await prepareTlsMaterial({
    config: { mode: 'selfsigned', httpsPort: 0, certPath: '', keyPath: '' },
    dataDir: dir,
    now: new Date('2026-10-23T00:00:00.000Z'),
  });

  const started = await startHttpsServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    },
    prepared,
    0,
    '127.0.0.1',
  );

  try {
    assert.ok(started.port > 0, '端口 0 时应回读实际端口');

    const https = await import('node:https');
    const body = await new Promise((resolve, reject) => {
      const request = https.request(
        {
          host: '127.0.0.1',
          port: started.port,
          path: '/',
          method: 'GET',
          // 自签证书不在系统信任库里 —— 这正是要在 README 里解释的那件事
          rejectUnauthorized: false,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += String(chunk)));
          res.on('end', () => resolve(data));
        },
      );
      request.on('error', reject);
      request.end();
    });

    assert.equal(body, '{"ok":true}');

    // 反过来：**严格校验**时必须失败，证明它确实是自签的（而不是碰巧被系统信任）
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const request = https.request(
            { host: '127.0.0.1', port: started.port, path: '/', method: 'GET' },
            () => resolve(),
          );
          request.on('error', reject);
          request.end();
        }),
      (error) => {
        assert.match(
          String(error.code ?? error.message),
          /SELF_SIGNED|DEPTH_ZERO|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/,
          `严格校验应因自签失败，实际错误：${String(error.code ?? error.message)}`,
        );
        return true;
      },
    );
  } finally {
    await started.close();
  }
});

test('T10.5 真连接：off 模式不允许启动 HTTPS（没有材料就别假装有）', async () => {
  const prepared = await prepareTlsMaterial({
    config: { mode: 'off', httpsPort: 8443, certPath: '', keyPath: '' },
    dataDir: freshDir(),
  });
  await assert.rejects(() => startHttpsServer(() => {}, prepared, 0, '127.0.0.1'), /没有 TLS 材料/);
});

// ══════════════════════════════════════════════════════════
// 8. 实际生效的 TLS 状态（/api/stats 下发的 tls 字段）
// ══════════════════════════════════════════════════════════
//
// T10.5 时期这里测的是一个从未被调用的 `tlsSummary()`，它输出**嵌套**的
// `tls.certificate.*`；而线上 `/api/stats` 用的是**扁平**的 `RuntimeTlsState`。
// 两套形状并存导致写验证脚本时按嵌套去读、拿到 undefined。T10.10 删掉了死代码，
// 装配抽成 `runtimeTlsState()`，worker 与这里的断言对象是同一份。

test('T10.5/T10.10 状态摘要：off 模式 plaintext=true 且没有证书信息', async () => {
  const dir = freshDir();
  const prepared = await prepareTlsMaterial({
    config: { mode: 'off', httpsPort: 8443, certPath: '', keyPath: '' },
    dataDir: dir,
  });
  const state = runtimeTlsState('off', null, prepared);
  assert.equal(state.plaintext, true);
  assert.equal(state.httpsPort, null, 'off 模式不许报一个"正在监听的 HTTPS 端口"');
  assert.equal(state.fingerprint, null);
  assert.equal(state.selfSigned, false);
  // 横幅文案与常量同源，避免两处漂移（面板直接引用这个常量渲染）
  assert.match(PLAINTEXT_BANNER.body, /明文/);
  assert.match(PLAINTEXT_BANNER.body, /selfsigned/, '要告诉用户怎么修');
});

test('T10.5/T10.10 状态摘要：selfsigned 模式带指纹与剩余天数（供用户核对）', async () => {
  const dir = freshDir();
  const now = new Date('2026-10-23T00:00:00.000Z');
  const prepared = await prepareTlsMaterial({
    config: { mode: 'selfsigned', httpsPort: 8443, certPath: '', keyPath: '' },
    dataDir: dir,
    now,
  });

  const state = runtimeTlsState('selfsigned', 8443, prepared);
  assert.equal(state.plaintext, false);
  assert.equal(state.httpsPort, 8443);
  assert.ok(state.fingerprint, 'selfsigned 模式必须下发证书指纹');
  assert.match(state.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.equal(state.selfSigned, true);
  assert.ok(state.daysUntilExpiry > 300);
  // 扁平结构：一旦有人改回嵌套，这条会立刻失败
  assert.equal(state['certificate'], undefined, '线上形状是扁平的，不要再套一层 certificate');
});

