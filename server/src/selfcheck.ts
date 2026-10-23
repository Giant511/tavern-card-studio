/**
 * 离线自检：`tcs-server selfcheck`（v0.1.2 热修追加）。
 *
 * ## 为什么需要它
 *
 * 2026-10-23 的生产故障：服务端 MSI 装好后启动报 1067，日志是
 * `Cannot find package '@node-rs/argon2'`。源码对、`tsc` 过、单测全绿、
 * MSI 也构建成功 —— 唯独**打包清单漏了这个依赖**。
 *
 * 这类"源码对、构建对、打包漏"的洞，靠人核对清单是拦不住的（事实上就是漏了两次：
 * argon2 和 @peculiar/x509 同时缺）。所以这里做一次**真的把依赖跑起来**的自检：
 *
 *   · `@node-rs/argon2` → 真算一次哈希并验一次密码（证明平台 `.node` 二进制能加载）；
 *   · `@peculiar/x509` → 真生成一张自签证书（证明 TLS 自签链路可用）；
 *   · `better-sqlite3` → 真开一个内存库并执行查询；
 *   · `isomorphic-git` → 真算一次对象哈希。
 *
 * 只做"import 一下"是不够的：包目录存在但 `.node` 缺失时 import 仍可能走到懒加载，
 * 而我们要的是**在打包装机前就红**。全部操作都在内存里，不写磁盘、不绑端口、
 * 不读配置文件 —— 因此可以安全地在构建机上对任意产物目录执行。
 *
 * 用法：`node dist/index.js selfcheck`（在任何目录下都能跑，不依赖 cwd）
 */

import { webcrypto } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SERVER_VERSION } from './context.js';

export interface SelfCheckStep {
  name: string;
  /** 这一项证明了什么（失败时用户要靠它判断是哪个依赖的问题） */
  detail: string;
  ok: boolean;
  error?: string;
  /** 这个包实际从哪个路径解析出来的 */
  resolved?: string;
}

export interface SelfCheckOptions {
  /**
   * 要求所有依赖都解析到**这个目录之内**。
   *
   * 为什么必须有这一项：Node 的模块解析会一路向上找 `node_modules`。
   * 绿色包放在仓库里时，`release/server/app/node_modules` 缺的包会从
   * **仓库根的 `node_modules`** 找到 —— 自检于是"通过"，而装到
   * `C://Program Files\...` 之后立刻崩。2026-10-23 我实测过这个假通过：
   * 手动移走包内的 `@node-rs` 目录，自检依然全绿。
   * 所以验证产物时必须约束"只能从包里解析"。
   */
  requireInside?: string;
}

/** 把路径统一成可比较的形态（Windows 大小写不敏感、分隔符两种） */
function normalizePath(input: string): string {
  return input.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

/**
 * 逐项检查。任何一项抛错都只记下来并继续 ——
 * 报告里一次列全比"第一个错就退出"有用得多（排查时想知道到底漏了几个）。
 */
export async function runSelfCheck(options: SelfCheckOptions = {}): Promise<{ ok: boolean; steps: SelfCheckStep[] }> {
  const steps: SelfCheckStep[] = [];
  const root = options.requireInside === undefined ? null : normalizePath(options.requireInside);

  /**
   * 解析包的入口路径，并（在给了 requireInside 时）校验它落在包内。
   *
   * 用 `import.meta.resolve`：它按**本模块所在位置**解析，与 `password.js`
   * 里的 `import '@node-rs/argon2'` 走同一套规则 —— 因此能如实反映产物的情况。
   */
  const resolvedPath = (specifier: string): string => {
    // 用 fileURLToPath 而不是自己剥 `file://` 前缀：后者在 Windows 上会留下
    // `/D:/…` 的前导斜杠，与 `path.resolve()` 给出的 `D:/…` 永远比不上一致
    // —— 表现是"守卫生效了，但把所有依赖都判成包外"，比不守更误导。
    const path = fileURLToPath(import.meta.resolve(specifier));
    if (root !== null) {
      const normalized = normalizePath(path);
      // 注意比较的是**目录前缀 + 分隔符**：否则 `release/server/app` 会匹配上
      // `release/server/app2`，等于白验。
      if (normalized !== root && !normalized.startsWith(`${root}/`)) {
        throw new Error(`从包外解析到了 ${path} —— 产物缺这个包，是 Node 向上找到的`);
      }
    }
    return path;
  };

  const probe = async (name: string, detail: string, run: () => Promise<string> | string): Promise<void> => {
    try {
      const note = await run();
      let resolved: string | undefined;
      try {
        resolved = resolvedPath(name);
      } catch (error) {
        steps.push({
          name,
          detail,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      steps.push({ name, detail: note || detail, ok: true, resolved });
    } catch (error) {
      steps.push({
        name,
        detail,
        ok: false,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  };

  await probe('@node-rs/argon2', '密码哈希（登录与账户创建依赖它）', async () => {
    const { hashPassword, verifyPassword } = await import('./auth/password.js');
    const hash = await hashPassword('selfcheck-probe-password');
    const good = await verifyPassword(hash, 'selfcheck-probe-password');
    const bad = await verifyPassword(hash, 'selfcheck-wrong-password');
    if (!good) throw new Error('哈希自校验失败：正确密码未被接受');
    if (bad) throw new Error('哈希自校验失败：错误密码被接受了');
    return `哈希与校验通过（${hash.slice(0, 18)}…）`;
  });

  await probe('@peculiar/x509', '自签证书生成（tls.mode=selfsigned 依赖它）', async () => {
    const { X509CertificateGenerator, cryptoProvider } = await import('@peculiar/x509');
    cryptoProvider.set(webcrypto as never);
    const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
    const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
    const cert = await X509CertificateGenerator.createSelfSigned({
      serialNumber: '01',
      name: 'CN=selfcheck.local',
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 86_400_000),
      signingAlgorithm: alg,
      keys,
    });
    const pem = cert.toString('pem');
    if (!pem.includes('BEGIN CERTIFICATE')) throw new Error('生成的证书不是 PEM');
    return `证书生成通过（${pem.split('\n')[0]}）`;
  });

  await probe('better-sqlite3', 'SQLite 索引库（卡片索引与登录限速依赖它）', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE probe (v TEXT)');
      db.prepare('INSERT INTO probe (v) VALUES (?)').run('ok');
      const row = db.prepare('SELECT v FROM probe').get() as { v: string } | undefined;
      if (row?.v !== 'ok') throw new Error('内存库读写结果不符');
      return `内存库读写通过（${db.prepare('SELECT sqlite_version() AS v').get() ? 'ok' : '?'}）`;
    } finally {
      db.close();
    }
  });

  await probe('isomorphic-git', '版本库（卡片历史与三层 diff 依赖它）', async () => {
    const git = await import('isomorphic-git');
    // hashBlob 返回 { oid, type, object, format }，不是裸字符串 ——
    // 第一版按字符串断言，自检自己先报"对象哈希异常：[object Object]"。
    const result: unknown = await git.hashBlob({ object: new TextEncoder().encode('selfcheck') });
    const oid = (result as { oid?: unknown } | null)?.oid;
    if (typeof oid !== 'string' || !/^[0-9a-f]{40}$/.test(oid)) {
      throw new Error(`对象哈希异常：${JSON.stringify(result).slice(0, 80)}`);
    }
    return `对象哈希通过（${oid.slice(0, 12)}…）`;
  });

  return { ok: steps.every((step) => step.ok), steps };
}

/**
 * CLI 入口：打印报告并返回退出码。
 *
 * `bundleRoot` 由 `cli.ts` 从已解析的 flags 里取（`--bundle-root <路径>`），
 * **这里不再自己解析 argv** —— 第一版自己解析，而 `cli.ts` 调用时忘了把参数传进来，
 * 结果"带约束跑"和"不带约束跑"输出一模一样：守卫看起来在、实际从未生效。
 * 宁可让类型系统逼调用方显式传，也不要留一个可以被静默漏掉的隐式路径。
 */
export async function selfCheckCommand(options: { bundleRoot?: string } = {}): Promise<number> {
  const requireInside = options.bundleRoot === undefined ? undefined : resolve(options.bundleRoot);
  if (requireInside !== undefined) {
    process.stdout.write(`要求依赖只从包内解析：${requireInside}\n`);
  }

  process.stdout.write(
    `Tavern Card Studio Server ${SERVER_VERSION} 自检` +
      `（node ${process.version}，${process.platform}/${process.arch}）\n`,
  );
  process.stdout.write(`执行目录：${process.cwd()}\n`);
  process.stdout.write(`模块根：${new URL('../..', import.meta.url).pathname}\n\n`);

  const { ok, steps } = await runSelfCheck({ requireInside });
  for (const step of steps) {
    const mark = step.ok ? '✔' : '✘';
    process.stdout.write(`${mark} ${step.name} —— ${step.detail}\n`);
    if (step.resolved !== undefined) process.stdout.write(`    解析自 ${step.resolved}\n`);
    if (!step.ok) process.stdout.write(`    ${step.error ?? ''}\n`);
  }

  if (ok) {
    process.stdout.write('\n结论：通过（全部运行时依赖可用）\n');
    return 0;
  }
  process.stdout.write('\n结论：未通过 —— 产物缺少运行时依赖，请检查打包清单\n');
  return 1;
}
