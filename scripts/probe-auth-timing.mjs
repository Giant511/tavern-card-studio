/**
 * 探测：登录/注册各失败路径的耗时分布，判断"响应耗时"是否构成枚举面。
 *
 * 这不是要出一个"通过/失败"的结论，而是拿数据回答一个具体质疑：
 * 错误体已经逐字节相同了，**耗时**上还剩下哪些可观测差异？
 *
 * 用法：node scripts/probe-auth-timing.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Db } from '../server/dist/storage/db.js';
import { UserStore } from '../server/dist/storage/users.js';
import { SessionStore } from '../server/dist/auth/sessions.js';
import { LoginLimiter } from '../server/dist/auth/login-limit.js';
import { AuthService } from '../server/dist/auth/service.js';
import { hashPassword } from '../server/dist/auth/password.js';

const work = mkdtempSync(join(tmpdir(), 'tcs-timing-'));
const db = new Db(join(work, 'timing.db'));

const config = {
  auth: {
    token: 'legacy',
    require: true,
    publicPaths: ['/api/health'],
    registerMode: 'open',
    jwtSecret: 'unit-test-jwt-secret-aaaaaaaaaaaaaaaaaaaaaaaa',
  },
};
const users = new UserStore(db.handle);
const sessions = new SessionStore(db.handle);

/** 每轮换一个新库，避免限速把后续样本全拦成"锁定" */
async function measure(label, setup, call, rounds = 7) {
  const times = [];
  for (let i = 0; i < rounds; i += 1) {
    const freshDb = new Db(join(work, `t-${label}-${String(i)}.db`));
    const u = new UserStore(freshDb.handle);
    const s = new SessionStore(freshDb.handle);
    const limiter = new LoginLimiter(freshDb.handle);
    const auth = new AuthService({ config, users: u, sessions: s, limiter });
    await setup(u, auth);
    const t = process.hrtime.bigint();
    try {
      await call(auth);
    } catch {
      /* 预期失败 */
    }
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
    freshDb.close();
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const min = times[0];
  const max = times[times.length - 1];
  return { label, median, min, max };
}

const IP = '127.0.0.1';
const UA = 'timing-probe';

try {
  const rows = [];

  rows.push(
    await measure(
      '登录·用户存在+密码错',
      async (u) => u.create({ username: 'alice', passwordHash: await hashPassword('alice-password-1') }),
      (auth) => auth.login({ username: 'alice', password: 'wrong-password', ip: IP, userAgent: UA }),
    ),
  );

  rows.push(
    await measure(
      '登录·用户不存在',
      async () => {},
      (auth) => auth.login({ username: 'ghost', password: 'wrong-password', ip: IP, userAgent: UA }),
    ),
  );

  rows.push(
    await measure(
      '登录·成功（无重哈希）',
      async (u) => u.create({ username: 'bob', passwordHash: await hashPassword('bob-password-1') }),
      (auth) => auth.login({ username: 'bob', password: 'bob-password-1', ip: IP, userAgent: UA }),
    ),
  );

  rows.push(
    await measure(
      '注册·用户名已占用',
      async (u) => u.create({ username: 'taken', passwordHash: await hashPassword('taken-password-1') }),
      (auth) => auth.register({ username: 'taken', password: 'valid-password-1', ip: IP, userAgent: UA, callerIsAdmin: false }),
    ),
  );

  rows.push(
    await measure(
      '注册·用户名格式不合规',
      async () => {},
      (auth) => auth.register({ username: 'ab', password: 'valid-password-1', ip: IP, userAgent: UA, callerIsAdmin: false }),
    ),
  );

  rows.push(
    await measure(
      '注册·密码不合规',
      async () => {},
      (auth) => auth.register({ username: 'newname', password: 'short', ip: IP, userAgent: UA, callerIsAdmin: false }),
    ),
  );

  rows.push(
    await measure(
      '注册·成功',
      async () => {},
      (auth) => auth.register({ username: 'brandnew', password: 'valid-password-1', ip: IP, userAgent: UA, callerIsAdmin: false }),
    ),
  );

  console.log('路径'.padEnd(26) + '中位(ms)'.padStart(10) + '最小'.padStart(9) + '最大'.padStart(9));
  for (const r of rows) {
    console.log(
      r.label.padEnd(26) + r.median.toFixed(1).padStart(10) + r.min.toFixed(1).padStart(9) + r.max.toFixed(1).padStart(9),
    );
  }

  const pairs = [
    ['登录·用户存在+密码错', '登录·用户不存在'],
    ['注册·用户名已占用', '注册·用户名格式不合规'],
    ['注册·用户名已占用', '注册·密码不合规'],
  ];
  console.log('\n同码路径的耗时比值（接近 1 才不构成侧信道）：');
  for (const [a, b] of pairs) {
    const ra = rows.find((r) => r.label === a);
    const rb = rows.find((r) => r.label === b);
    const ratio = Math.max(ra.median, rb.median) / Math.min(ra.median, rb.median);
    console.log(
      `  ${a} vs ${b}: ${ratio.toFixed(2)}×  (${ra.median.toFixed(1)}ms / ${rb.median.toFixed(1)}ms)`,
    );
  }

  console.log('\n成功路径 vs 失败路径（成功需要正确凭据，不构成枚举面）：');
  const fail = rows.find((r) => r.label === '登录·用户存在+密码错').median;
  const ok = rows.find((r) => r.label === '登录·成功（无重哈希）').median;
  console.log(`  ${ok.toFixed(1)}ms / ${fail.toFixed(1)}ms = ${(ok / fail).toFixed(2)}×`);
  const regOk = rows.find((r) => r.label === '注册·成功').median;
  const regFail = rows.find((r) => r.label === '注册·用户名已占用').median;
  console.log(`  注册成功/注册失败 = ${(regOk / regFail).toFixed(2)}×`);
} finally {
  db.close();
  rmSync(work, { recursive: true, force: true });
}
