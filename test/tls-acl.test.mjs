/**
 * 私钥 ACL：真机事故的回归测试（v0.1.3）。
 *
 * ## 事故
 *
 * 面板点「重新生成证书」→ `icacls ... /grant:r MP2F1GZG$:(F)` → 失败 →
 * 异常冒到接口 → 用户看到 `Command failed: icacls …`（含 ◆ 乱码与内部路径），
 * 而**证书其实完全可以生成**。
 *
 * 根因两条，缺一不成灾：
 *   ① 授权主体取 `process.env.USERNAME`，Windows 服务（LocalSystem）下它是
 *      机器账户 `MACHINE$`，不是可授权主体；且 `SYSTEM`/`Administrators`
 *      写的是本地化名称。
 *   ② ACL 失败被当成致命错误（docs/29 旧 6.2 就是这么写的）。
 *
 * ## 这里钉住什么
 *
 *   · 授权主体必须是 SID 字面量，参数里不许出现任何账户名；
 *   · **ACL 失败时证书仍然生成**（降级为 warn），且原因已脱敏；
 *   · 正常路径的 ACL 用 SDDL 断言（ASCII，与系统语言无关）；
 *   · `currentUserSid()` 真的能取到 SID（第一版 `await execFile(...)`
 *     没等 Promise，静默返回 null —— 这类 bug 不会编译报错，只能靠断言抓）。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, test } from 'node:test';

import {
  KEY_ACL_GRANTS,
  certsBackupDir,
  currentUserSid,
  ensureSelfSigned,
  inspectCertificate,
  readKeyAclSddl,
  restrictKeyPermissions,
} from '../server/dist/tls/certificate.js';
import { prepareTlsMaterial } from '../server/dist/tls/server.js';

let workDir;
let seq = 0;
before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-acl-'));
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

/** 模拟 icacls 失败（真机就是这条路径炸的） */
const failingRunner = async (command, args) => {
  const error = new Error(`Command failed: ${command} ${args.join(' ')}\n拒绝访问。`);
  error.code = 5;
  throw error;
};

// ══════════════════════════════════════════════════════════
// 1. 授权主体必须是 SID
// ══════════════════════════════════════════════════════════

test('F4/ACL 授权主体是众所周知的 SID，且带 * 前缀（按 SID 解析）', () => {
  assert.equal(KEY_ACL_GRANTS.system, '*S-1-5-18');
  assert.equal(KEY_ACL_GRANTS.administrators, '*S-1-5-32-544');
});

test('F4/ACL 传给 icacls 的参数里不含任何账户名', async () => {
  const dir = freshDir();
  const calls = [];
  const acl = await restrictKeyPermissions(join(dir, 'x.key'), {
    run: async (command, args) => {
      calls.push({ command, args });
    },
    userSid: null, // 固定注入，避免依赖运行环境
  });

  assert.equal(acl.ok, true);
  const args = calls.at(-1).args;
  assert.equal(calls.at(-1).command, 'icacls');
  assert.ok(args.includes('/inheritance:r'), '必须同时切断继承');

  const granted = args.filter((arg) => arg.endsWith(':(F)'));
  assert.deepEqual(granted, ['*S-1-5-18:(F)', '*S-1-5-32-544:(F)']);
  // 真机事故的形态：MP2F1GZG$:(F) / alice:(F) —— 非 *S-1- 开头一律不允许
  for (const arg of granted) {
    assert.match(arg, /^\*S-1-\d+(-\d+)+:\(F\)$/, `授权主体不是 SID 字面量：${arg}`);
  }
});

test('F4/ACL currentUserSid 真的取到 SID（防"静默返回 null"回归）', async () => {
  const sid = await currentUserSid();
  if (process.platform !== 'win32') {
    assert.equal(sid, null);
    return;
  }
  /*
   * 第一版写成 `await execFile(...)`：execFile 返回 ChildProcess 而不是 Promise，
   * await 立刻返回，stdout 为 undefined → 正则匹配不到 → **静默返回 null**，
   * 于是"当前用户"永远加不进 ACL，而所有断言都是绿的。
   * 这条断言就是为它准备的。
   */
  assert.match(String(sid), /^S-\d+(-\d+)+$/, `没能从 whoami 取到 SID：${String(sid)}`);
});

// ══════════════════════════════════════════════════════════
// 2. ACL 失败必须降级，不能让证书生成失败
// ══════════════════════════════════════════════════════════

test('F4/ACL icacls 失败时证书仍然生成，失败原因进 aclProblems', async () => {
  const dir = freshDir();
  const result = await ensureSelfSigned({ dataDir: dir, aclRun: failingRunner });

  // ① 证书与私钥都在，且可用
  assert.equal(existsSync(result.paths.cert), true, '证书必须存在');
  assert.equal(existsSync(result.paths.key), true, '私钥必须存在');
  assert.match(readFileSync(result.paths.key, 'utf8'), /BEGIN PRIVATE KEY/);
  const info = await inspectCertificate(result.paths.cert);
  assert.equal(info.fingerprint, result.info.fingerprint, '返回的指纹必须就是这张证书的');

  // ② 失败被记录（而不是抛出）
  assert.equal(result.aclProblems.length, 1, `应有一条 ACL 警告：${JSON.stringify(result.aclProblems)}`);
  const problem = result.aclProblems[0];
  assert.match(problem, /权限未能收紧/);
  assert.match(problem, /退出码 5/, '带上退出码便于排查');
});

test('F4/ACL 失败原因已脱敏：不含 Command failed 原文、不含绝对路径、不含 stderr', async () => {
  const dir = freshDir();
  const result = await ensureSelfSigned({ dataDir: dir, aclRun: failingRunner });
  const text = result.aclProblems.join('\n');

  assert.equal(/Command failed/i.test(text), false, `不该把 exec 包装前缀带给用户：${text}`);
  assert.equal(/[A-Za-z]:\\/.test(text), false, `不该出现绝对路径：${text}`);
  assert.equal(/拒绝访问/.test(text), false, `不该把 stderr 原文带出去：${text}`);
});

test('F4/ACL force 重新生成时，备份私钥的 ACL 失败也不中断（旧证书仍被保住）', async () => {
  const dir = freshDir();
  const first = await ensureSelfSigned({ dataDir: dir });
  const oldFingerprint = first.info.fingerprint;

  const second = await ensureSelfSigned({ dataDir: dir, force: true, aclRun: failingRunner });

  assert.ok(second.backupPath, '旧证书必须被备份（即使 ACL 失败）');
  assert.equal(existsSync(second.backupPath), true, `备份文件应存在：${String(second.backupPath)}`);
  assert.notEqual(second.info.fingerprint, oldFingerprint, '应已换新证书');
  // 备份私钥 + 新私钥，两处都失败 → 两条警告
  assert.equal(second.aclProblems.length, 2, `备份与新私钥各一条：${JSON.stringify(second.aclProblems)}`);
  assert.ok(existsSync(join(certsBackupDir(dir), basename(String(second.backupPath)))));
});

test('F4/ACL 正常路径：SDDL 只有 SYSTEM / Administrators / 当前用户，没有 Everyone/Users', async () => {
  if (process.platform !== 'win32') return;
  const dir = freshDir();
  const result = await ensureSelfSigned({ dataDir: dir });
  assert.deepEqual(result.aclProblems, [], '本机 icacls 应能成功');

  const sddl = await readKeyAclSddl(result.paths.key, join(dir, 'acl.txt'));
  assert.ok(sddl.startsWith('D:PAI'), `继承应已切断：${sddl}`);
  assert.match(sddl, /;;;SY\)/, `缺 SYSTEM：${sddl}`);
  assert.match(sddl, /;;;BA\)/, `缺 Administrators：${sddl}`);
  for (const code of ['WD', 'BU', 'AU']) {
    assert.equal(sddl.includes(`;;;${code})`), false, `不该出现 ${code}：${sddl}`);
  }
});

// ══════════════════════════════════════════════════════════
// 3. 启动路径要把 ACL 警告带出去（日志 / 面板能看见）
// ══════════════════════════════════════════════════════════

test('F4/ACL 启动准备阶段：ACL 警告并入 warnings，但服务照常起来', async () => {
  const dir = freshDir();
  /*
   * 这里不注入 runner（prepareTlsMaterial 内部没有注入口），
   * 所以只断言"结构上会带出去"：正常机器上 aclProblems 为空时 warnings 里
   * 就不该出现权限相关的噪声 —— 反过来，真实失败时 certificate.ts 会 push。
   * 真正的失败注入已在上面两条覆盖。
   */
  const prepared = await prepareTlsMaterial({
    config: { mode: 'selfsigned', httpsPort: 8443, certPath: '', keyPath: '' },
    dataDir: dir,
  });
  assert.ok(prepared.material, 'selfsigned 必须产出材料');
  assert.equal(
    prepared.warnings.some((line) => line.includes('权限未能收紧')),
    false,
    '本机 icacls 正常时不该有 ACL 警告',
  );
});
