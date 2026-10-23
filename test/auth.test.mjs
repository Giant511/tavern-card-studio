/**
 * v0.1.2 / T10.4：登录与刷新令牌。
 *
 * 这一层是**安全边界**，所以测试的重点不是"功能能用"，而是需求里点名的六条：
 *
 *   1. 时序断言（用户不存在 vs 密码错，耗时同量级）；
 *   2. 锁定流程（5 次失败锁 10 分钟，解锁后可正常登录）；
 *   3. 枚举攻击（存在/不存在账户的响应**逐字节相同**）；
 *   4. 吊销后令牌失效（且吊销状态在**新进程/新连接**下仍然有效）；
 *   5. JWT 2h 过期（过期即拒绝，不是"靠客户端自觉"）；
 *   6. needsRehash 接入登录成功路径（旧参数哈希被自动重算）。
 *
 * 前四条里有两条属于"看起来对、其实不对"的典型：时序必须实测时间差，
 * 逐字节必须比 body 原文（比 JSON 字段会漏掉字段顺序与空白差异）。
 *
 * 运行：node --test test/auth.test.mjs（需先 npm run build:server）
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Db } from '../server/dist/storage/db.js';
import { UserStore, toPublicUser } from '../server/dist/storage/users.js';
import { SessionStore } from '../server/dist/auth/sessions.js';
import { LoginLimiter, DEFAULT_RATE_LIMIT } from '../server/dist/auth/login-limit.js';
import { AuthService, AuthError, ACCESS_TOKEN_TTL_SECONDS } from '../server/dist/auth/service.js';
import { hashPassword, verifyPassword, verifyPasswordDummy, ARGON2_PARAMS } from '../server/dist/auth/password.js';
import { signJwt, verifyJwt } from '../server/dist/auth/jwt.js';
import { TokenGate } from '../server/dist/http/auth.js';

let workDir;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-auth-'));
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

let seq = 0;
function fresh() {
  seq += 1;
  const db = new Db(join(workDir, `auth-${String(seq)}.db`));
  const config = {
    auth: {
      token: 'legacy-global-token',
      require: true,
      publicPaths: ['/api/health'],
      registerMode: 'open',
      jwtSecret: 'unit-test-jwt-secret-aaaaaaaaaaaaaaaaaaaaaaaa',
    },
  };
  const users = new UserStore(db.handle);
  const sessions = new SessionStore(db.handle);
  const limiter = new LoginLimiter(db.handle, DEFAULT_RATE_LIMIT);
  let clock = new Date('2026-10-23T00:00:00.000Z');
  const auth = new AuthService({
    config,
    users,
    sessions,
    limiter,
    now: () => clock,
  });
  return {
    db,
    config,
    users,
    sessions,
    limiter,
    auth,
    setClock: (iso) => {
      clock = new Date(iso);
    },
    advance: (ms) => {
      clock = new Date(clock.getTime() + ms);
    },
    now: () => clock,
  };
}

const IP = '127.0.0.1';
const UA = 'test-agent';

async function makeUser(env, username, password, role = 'user') {
  return env.users.create({ username, passwordHash: await hashPassword(password), role });
}

/** 取出 AuthError 的 code；不是 AuthError 就失败并打印实际类型 */
async function expectAuthError(promise, code) {
  try {
    await promise;
    assert.fail(`期望抛出 ${code}，但成功返回了`);
  } catch (error) {
    assert.ok(error instanceof AuthError, `期望 AuthError，实际 ${String(error)}`);
    assert.equal(error.code, code, `期望 code=${code}，实际 ${error.code}：${error.message}`);
    return error;
  }
}

// ══════════════════════════════════════════════════════════
// 1. 时序
// ══════════════════════════════════════════════════════════

test('T10.4 时序：用户不存在与密码错耗时同量级', async () => {
  const env = fresh();
  try {
    await makeUser(env, 'alice', 'alice-password-1');

    const realTimes = [];
    const dummyTimes = [];
    for (let i = 0; i < 5; i += 1) {
      let t = process.hrtime.bigint();
      await expectAuthError(
        env.auth.login({ username: 'alice', password: `wrong-${String(i)}`, ip: IP, userAgent: UA }),
        'INVALID_CREDENTIALS',
      );
      realTimes.push(Number(process.hrtime.bigint() - t) / 1e6);

      t = process.hrtime.bigint();
      await expectAuthError(
        env.auth.login({ username: `ghost-${String(i)}`, password: 'whatever', ip: IP, userAgent: UA }),
        'INVALID_CREDENTIALS',
      );
      dummyTimes.push(Number(process.hrtime.bigint() - t) / 1e6);
    }

    // 每次失败都会累加限速计数 —— 这里只关心时间，忽略锁定影响（两次都同样被锁）
    const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
    const real = median(realTimes);
    const dummy = median(dummyTimes);
    const ratio = Math.max(real, dummy) / Math.max(0.001, Math.min(real, dummy));

    assert.ok(
      ratio < 3,
      `"用户存在→密码错" 与 "用户不存在" 耗时必须同量级，实测 real=${real.toFixed(1)}ms dummy=${dummy.toFixed(1)}ms（比值 ${ratio.toFixed(2)}）`,
    );
    assert.ok(dummy > 1, `不存在的用户也必须真的跑一次哈希，实测只有 ${dummy.toFixed(2)}ms`);
  } finally {
    env.db.close();
  }
});

// ══════════════════════════════════════════════════════════
// 2. 枚举攻击：逐字节相同
// ══════════════════════════════════════════════════════════

test('T10.4 枚举：存在账户与不存在账户的失败响应逐字节相同', async () => {
  const env = fresh();
  try {
    await makeUser(env, 'bob', 'bob-password-1');

    const collect = async (username) => {
      try {
        await env.auth.login({ username, password: 'definitely-wrong', ip: IP, userAgent: UA });
        return null;
      } catch (error) {
        assert.ok(error instanceof AuthError);
        // 模拟 HTTP 层会序列化的东西：状态码 + 错误体
        return JSON.stringify({
          status: error.status,
          code: error.code,
          message: error.message,
          details: error.details ?? null,
        });
      }
    };

    const exists = await collect('bob');
    const missing = await collect('nobody-here');
    assert.equal(exists, missing, '两条响应必须逐字节相同 —— 任何差异都是账户存在性的信号');
    assert.ok(exists !== null);
  } finally {
    env.db.close();
  }
});

test('T10.4 枚举：注册时"用户名已占用"与"格式不合规"共用同一响应', async () => {
  const env = fresh();
  try {
    await makeUser(env, 'taken-name', 'taken-password-1');

    const collect = async (username) => {
      try {
        await env.auth.register({ username, password: 'valid-password-1', ip: IP, userAgent: UA, callerIsAdmin: false });
        return null;
      } catch (error) {
        assert.ok(error instanceof AuthError);
        return JSON.stringify({ status: error.status, code: error.code, message: error.message });
      }
    };

    const occupied = await collect('taken-name');
    const badShape = await collect('ab'); // 太短
    assert.equal(occupied, badShape, '注册失败的各种原因必须对外无差别，否则可用来探测用户名是否存在');
    assert.ok(occupied !== null);
  } finally {
    env.db.close();
  }
});

// ══════════════════════════════════════════════════════════
// 3. 锁定流程
// ══════════════════════════════════════════════════════════

test('T10.4 锁定：同账户 5 次失败后锁 10 分钟，且响应与密码错一致', async () => {
  const env = fresh();
  try {
    const user = await makeUser(env, 'carol', 'carol-password-1');
    assert.equal(DEFAULT_RATE_LIMIT.maxFailures, 5);
    assert.equal(DEFAULT_RATE_LIMIT.lockMs, 10 * 60 * 1000);

    // 前 4 次失败：还没锁
    for (let i = 0; i < 4; i += 1) {
      await expectAuthError(
        env.auth.login({ username: 'carol', password: 'wrong', ip: IP, userAgent: UA }),
        'INVALID_CREDENTIALS',
      );
    }
    assert.equal(env.limiter.check({ ip: IP, account: 'carol' }, env.now()).locked, false);

    // 第 5 次 → 触发锁定
    await expectAuthError(
      env.auth.login({ username: 'carol', password: 'wrong', ip: IP, userAgent: UA }),
      'INVALID_CREDENTIALS',
    );
    const lockedState = env.limiter.check({ ip: IP, account: 'carol' }, env.now());
    assert.equal(lockedState.locked, true, '第 5 次失败后应当锁定');
    assert.ok(lockedState.retryAfterMs > 9 * 60 * 1000, `锁定应接近 10 分钟，实际 ${String(lockedState.retryAfterMs)}ms`);

    // 关键：**用正确密码**再试，也必须被拒，且错误与密码错完全一致
    const correctDuringLock = await expectAuthError(
      env.auth.login({ username: 'carol', password: 'carol-password-1', ip: IP, userAgent: UA }),
      'INVALID_CREDENTIALS',
    );
    assert.equal(correctDuringLock.status, 401);
    assert.equal(correctDuringLock.message, '用户名或密码不正确', '锁定期响应文案必须与密码错一致');
    assert.equal(correctDuringLock.details, undefined, '不能泄露 retryAfter 之类的锁定信息');

    // 用户在锁定期间没拿到会话
    assert.equal(env.sessions.listActive(user.id, env.now()).length, 0);

    // 过了 10 分钟 → 解锁，且正确密码能登录
    env.advance(10 * 60 * 1000 + 1000);
    assert.equal(env.limiter.check({ ip: IP, account: 'carol' }, env.now()).locked, false, '10 分钟后应自动解锁');
    const ok = await env.auth.login({ username: 'carol', password: 'carol-password-1', ip: IP, userAgent: UA });
    assert.ok(ok.tokens.accessToken);
    // 登录成功会清空失败计数
    assert.equal(env.limiter.state('account', 'carol', env.now()).failures, 0);
  } finally {
    env.db.close();
  }
});

test('T10.4 锁定：按 IP 也生效（换账户名照样被拦）', async () => {
  const env = fresh();
  try {
    await makeUser(env, 'dave', 'dave-password-1');
    await makeUser(env, 'erin', 'erin-password-1');

    // 5 次失败分散在不同账户上 —— 账户维度不会锁，但 IP 维度会
    for (let i = 0; i < 5; i += 1) {
      await expectAuthError(
        env.auth.login({ username: `nobody-${String(i)}`, password: 'x', ip: '10.0.0.9', userAgent: UA }),
        'INVALID_CREDENTIALS',
      );
    }
    const ipState = env.limiter.check({ ip: '10.0.0.9', account: 'dave' }, env.now());
    assert.equal(ipState.locked, true, '同 IP 连续 5 次失败应当锁定，哪怕每次用户名都不同');

    // 该 IP 上的任何一个正确账户也被拦
    await expectAuthError(
      env.auth.login({ username: 'dave', password: 'dave-password-1', ip: '10.0.0.9', userAgent: UA }),
      'INVALID_CREDENTIALS',
    );
    // 另一个 IP 不受影响
    const other = await env.auth.login({ username: 'erin', password: 'erin-password-1', ip: '10.0.0.10', userAgent: UA });
    assert.ok(other.tokens.accessToken);
  } finally {
    env.db.close();
  }
});

test('T10.4 锁定：已锁期间的失败不延长锁定（防拒绝服务）', async () => {
  const env = fresh();
  try {
    await makeUser(env, 'frank', 'frank-password-1');
    for (let i = 0; i < 5; i += 1) {
      await expectAuthError(
        env.auth.login({ username: 'frank', password: 'wrong', ip: IP, userAgent: UA }),
        'INVALID_CREDENTIALS',
      );
    }
    const first = env.limiter.check({ ip: IP, account: 'frank' }, env.now());
    assert.ok(first.retryAfterMs > 0);

    // 锁定期间再打 3 次
    for (let i = 0; i < 3; i += 1) {
      env.advance(60 * 1000);
      await expectAuthError(
        env.auth.login({ username: 'frank', password: 'wrong', ip: IP, userAgent: UA }),
        'INVALID_CREDENTIALS',
      );
    }
    const after = env.limiter.check({ ip: IP, account: 'frank' }, env.now());
    // 解锁时刻不变：原锁至今应还剩 10min - 3min
    assert.ok(
      Math.abs(after.retryAfterMs - (10 * 60 * 1000 - 3 * 60 * 1000)) < 5000,
      `锁定不应被持续尝试续期，剩余 ${String(Math.round(after.retryAfterMs / 1000))}s`,
    );
  } finally {
    env.db.close();
  }
});

// ══════════════════════════════════════════════════════════
// 4. JWT 与吊销
// ══════════════════════════════════════════════════════════

test('T10.4 JWT：签名/校验往返、篡改与算法混淆都被拒', () => {
  const secret = 'unit-test-secret-bbbbbbbbbbbbbbbbbbbbbb';
  const token = signJwt({ sub: 'u1', sid: 's1', role: 'admin' }, secret, 7200, 1_700_000_000);

  const ok = verifyJwt(token, secret, 1_700_000_100);
  assert.equal(ok.ok, true);
  assert.equal(ok.payload?.sub, 'u1');
  assert.equal(ok.payload?.role, 'admin');
  assert.equal(ok.payload?.exp, 1_700_000_000 + 7200);

  assert.equal(verifyJwt(token, 'another-test-secret-cccccccccccccccccccc', 1_700_000_100).reason, 'bad_signature');

  // 篡改 payload（把 role 改成 admin）
  const [h, , s] = token.split('.');
  const forgedBody = Buffer.from(JSON.stringify({ sub: 'u1', sid: 's1', role: 'admin', iat: 1_700_000_000, exp: 9_999_999_999 }))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  assert.equal(verifyJwt(`${h}.${forgedBody}.${s}`, secret, 1_700_000_100).reason, 'bad_signature');

  // alg: none
  const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  assert.equal(verifyJwt(`${noneHeader}.${forgedBody}.`, secret, 1_700_000_100).reason, 'unsupported_algorithm');
});

test('T10.4 JWT：2 小时过期后拒绝（不是靠客户端自觉）', async () => {
  const env = fresh();
  try {
    const user = await makeUser(env, 'grace', 'grace-password-1');
    const { tokens } = await env.auth.login({ username: 'grace', password: 'grace-password-1', ip: IP, userAgent: UA });

    const gate = new TokenGate(env.config.auth.token, ['/api/health'], true, {
      jwtSecret: env.config.auth.jwtSecret,
      sessions: env.sessions,
      users: env.users,
      now: env.now,
    });

    const fakeReq = { headers: { authorization: `Bearer ${tokens.accessToken}` }, socket: { remoteAddress: IP } };
    assert.ok(gate.identify(fakeReq), '刚签发的令牌应当可用');

    // 1 小时 59 分：仍有效
    env.advance((ACCESS_TOKEN_TTL_SECONDS - 60) * 1000);
    assert.ok(gate.identify(fakeReq), '未到期的令牌应当仍可用');

    // 2 小时零 1 分：过期
    env.advance(120 * 1000);
    assert.equal(gate.identify(fakeReq), null, '超过 2 小时必须拒绝');

    void user;
  } finally {
    env.db.close();
  }
});

test('T10.4 吊销：登出后 access token 立刻失效（不等自然过期）', async () => {
  const env = fresh();
  try {
    const user = await makeUser(env, 'heidi', 'heidi-password-1');
    const { tokens } = await env.auth.login({ username: 'heidi', password: 'heidi-password-1', ip: IP, userAgent: UA });

    const gate = new TokenGate(env.config.auth.token, ['/api/health'], true, {
      jwtSecret: env.config.auth.jwtSecret,
      sessions: env.sessions,
      users: env.users,
      now: env.now,
    });
    const fakeReq = { headers: { authorization: `Bearer ${tokens.accessToken}` }, socket: { remoteAddress: IP } };
    assert.equal(gate.identify(fakeReq)?.userId, user.id);

    env.auth.logout(tokens.sessionId);
    assert.equal(gate.identify(fakeReq), null, '吊销必须立即生效 —— 这正是"查库而不是纯无状态"的理由');

    // refresh 也一起失效
    assert.throws(() => env.auth.refresh({ refreshToken: tokens.refreshToken, ip: IP, userAgent: UA }), AuthError);
  } finally {
    env.db.close();
  }
});

test('T10.4 吊销：状态落库，重开数据库（模拟服务重启）后仍然有效', async () => {
  const env = fresh();
  const file = join(workDir, `auth-${String(seq)}.db`);
  const user = await makeUser(env, 'ivan', 'ivan-password-1');
  const { tokens } = await env.auth.login({ username: 'ivan', password: 'ivan-password-1', ip: IP, userAgent: UA });
  env.auth.logout(tokens.sessionId);
  env.db.close();

  // 重新打开同一个库文件 —— 等价于服务重启
  const reopened = new Db(file);
  try {
    const sessions = new SessionStore(reopened.handle);
    const users = new UserStore(reopened.handle);
    const session = sessions.findById(tokens.sessionId);
    assert.ok(session, '会话行必须还在（吊销是标记不是删除）');
    assert.equal(session.revoked_at !== null, true, '吊销状态必须落库');
    assert.equal(sessions.isActive(session, env.now()), false, '重开库后会话仍应判定为失效');

    const gate = new TokenGate('legacy-global-token', ['/api/health'], true, {
      jwtSecret: env.config.auth.jwtSecret,
      sessions,
      users,
      now: env.now,
    });
    const fakeReq = { headers: { authorization: `Bearer ${tokens.accessToken}` }, socket: { remoteAddress: IP } };
    assert.equal(gate.identify(fakeReq), null, '重启后旧令牌不能复活');
    void user;
  } finally {
    reopened.close();
  }
});

test('T10.4 吊销：禁用账户会让它的令牌立刻失效', async () => {
  const env = fresh();
  try {
    const admin = await makeUser(env, 'admin1', 'admin1-password-1', 'admin');
    const target = await makeUser(env, 'judy', 'judy-password-1');
    const { tokens } = await env.auth.login({ username: 'judy', password: 'judy-password-1', ip: IP, userAgent: UA });

    const gate = new TokenGate(env.config.auth.token, ['/api/health'], true, {
      jwtSecret: env.config.auth.jwtSecret,
      sessions: env.sessions,
      users: env.users,
      now: env.now,
    });
    const fakeReq = { headers: { authorization: `Bearer ${tokens.accessToken}` }, socket: { remoteAddress: IP } };
    assert.ok(gate.identify(fakeReq));

    env.users.setStatus(target.id, 'disabled');
    assert.equal(gate.identify(fakeReq), null, '禁用账户后已签出的令牌必须立刻失效，否则"禁用"只是摆设');

    // 登录也进不去
    await expectAuthError(
      env.auth.login({ username: 'judy', password: 'judy-password-1', ip: IP, userAgent: UA }),
      'ACCOUNT_DISABLED',
    );
    void admin;
  } finally {
    env.db.close();
  }
});

test('T10.4 吊销：refresh token 每次使用后轮换，旧值立即失效', async () => {
  const env = fresh();
  try {
    await makeUser(env, 'karl', 'karl-password-1');
    const first = await env.auth.login({ username: 'karl', password: 'karl-password-1', ip: IP, userAgent: UA });

    const second = env.auth.refresh({ refreshToken: first.tokens.refreshToken, ip: IP, userAgent: UA });
    assert.notEqual(second.tokens.refreshToken, first.tokens.refreshToken, 'refresh 必须轮换');

    assert.throws(
      () => env.auth.refresh({ refreshToken: first.tokens.refreshToken, ip: IP, userAgent: UA }),
      (error) => {
        assert.ok(error instanceof AuthError);
        assert.equal(error.code, 'INVALID_REFRESH_TOKEN');
        return true;
      },
      '旧 refresh token 不能二次使用（重放检测）',
    );

    // 新的可以继续用
    const third = env.auth.refresh({ refreshToken: second.tokens.refreshToken, ip: IP, userAgent: UA });
    assert.ok(third.tokens.accessToken);
  } finally {
    env.db.close();
  }
});

// ══════════════════════════════════════════════════════════
// 5. needsRehash 接入登录路径
// ══════════════════════════════════════════════════════════

test('T10.4 参数升级：登录成功时旧参数哈希被自动重算', async () => {
  const env = fresh();
  try {
    // 造一个"用更弱参数算出来的"旧哈希（m=8192,t=1），模拟参数升级前注册的用户
    const { hash: argonHash, Algorithm } = await import('@node-rs/argon2');
    const oldHash = await argonHash('legacy-password-1', {
      algorithm: Algorithm.Argon2id,
      memoryCost: 8192,
      timeCost: 1,
      parallelism: 1,
    });
    assert.match(oldHash, /m=8192,t=1,p=1/, '前置条件：旧哈希参数必须更低');

    const user = env.users.create({ username: 'legacy-user', passwordHash: oldHash });
    assert.equal(env.users.findById(user.id)?.password_hash, oldHash);

    // 用同一个密码登录，应当成功，并且哈希被换成当前基线
    const result = await env.auth.login({ username: 'legacy-user', password: 'legacy-password-1', ip: IP, userAgent: UA });
    assert.ok(result.tokens.accessToken);

    const updated = env.users.findById(user.id);
    assert.notEqual(updated?.password_hash, oldHash, '登录成功后应重算哈希');
    assert.match(
      updated?.password_hash ?? '',
      new RegExp(`m=${String(ARGON2_PARAMS.memoryCost)},t=${String(ARGON2_PARAMS.timeCost)},p=${String(ARGON2_PARAMS.parallelism)}`),
      '重算后的哈希应当使用当前基线参数',
    );
    // 新旧密码一致性：重算后旧密码仍然能验过
    assert.equal(await verifyPassword(updated?.password_hash ?? '', 'legacy-password-1'), true);
  } finally {
    env.db.close();
  }
});

test('T10.4 参数升级：登录失败时不动哈希（不能因为一次错密码就改写）', async () => {
  const env = fresh();
  try {
    const { hash: argonHash, Algorithm } = await import('@node-rs/argon2');
    const oldHash = await argonHash('legacy-password-2', {
      algorithm: Algorithm.Argon2id,
      memoryCost: 8192,
      timeCost: 1,
      parallelism: 1,
    });
    const user = env.users.create({ username: 'legacy-user2', passwordHash: oldHash });

    await expectAuthError(
      env.auth.login({ username: 'legacy-user2', password: 'wrong-password', ip: IP, userAgent: UA }),
      'INVALID_CREDENTIALS',
    );
    assert.equal(env.users.findById(user.id)?.password_hash, oldHash, '登录失败不该改哈希');
  } finally {
    env.db.close();
  }
});

// ══════════════════════════════════════════════════════════
// 6. 注册策略
// ══════════════════════════════════════════════════════════

test('T10.4 注册：closed 明确拒绝（不伪装成功）', async () => {
  const env = fresh();
  try {
    env.config.auth.registerMode = 'closed';
    const error = await expectAuthError(
      env.auth.register({ username: 'newbie', password: 'newbie-password-1', ip: IP, userAgent: UA, callerIsAdmin: false }),
      'REGISTRATION_CLOSED',
    );
    assert.equal(error.status, 403);
    assert.match(error.message, /未开放自助注册/);
    assert.equal(env.users.count(), 0, '拒绝注册不能留下账户');
  } finally {
    env.db.close();
  }
});

test('T10.4 注册：admin-only 需要管理员，且管理员建号不返回对方令牌', async () => {
  const env = fresh();
  try {
    env.config.auth.registerMode = 'admin-only';

    await expectAuthError(
      env.auth.register({ username: 'newbie', password: 'newbie-password-1', ip: IP, userAgent: UA, callerIsAdmin: false }),
      'FORBIDDEN',
    );

    const created = await env.auth.register({
      username: 'newbie',
      password: 'newbie-password-1',
      ip: IP,
      userAgent: UA,
      callerIsAdmin: true,
    });
    assert.equal(created.user.username, 'newbie');
    assert.equal(created.tokens.accessToken, '', '管理员替别人建号不能拿到对方的会话（越权）');
    assert.equal(env.sessions.listActive(created.user.id, env.now()).length, 0);
  } finally {
    env.db.close();
  }
});

test('T10.4 注册：open 模式下第一个账户自动成为管理员', async () => {
  const env = fresh();
  try {
    const first = await env.auth.register({ username: 'first', password: 'first-password-1', ip: IP, userAgent: UA, callerIsAdmin: false });
    assert.equal(first.user.role, 'admin', '第一个账户必须是管理员，否则没人能管理服务端');
    const second = await env.auth.register({ username: 'second', password: 'second-password-1', ip: IP, userAgent: UA, callerIsAdmin: false });
    assert.equal(second.user.role, 'user');
  } finally {
    env.db.close();
  }
});

test('T10.4 注册：响应里不含 password_hash', async () => {
  const env = fresh();
  try {
    const created = await env.auth.register({ username: 'leakcheck', password: 'leakcheck-password-1', ip: IP, userAgent: UA, callerIsAdmin: false });
    const payload = JSON.stringify({ user: toPublicUser(created.user), tokens: created.tokens });
    assert.equal(/argon2id|password_hash/.test(payload), false, `响应里出现了哈希痕迹：${payload.slice(0, 200)}`);
  } finally {
    env.db.close();
  }
});

// ══════════════════════════════════════════════════════════
// 7. 兼容层
// ══════════════════════════════════════════════════════════

test('T10.4 兼容：legacy 全局 token 仍然可用且视为管理员', async () => {
  const env = fresh();
  try {
    const gate = new TokenGate(env.config.auth.token, ['/api/health'], true, {
      jwtSecret: env.config.auth.jwtSecret,
      sessions: env.sessions,
      users: env.users,
      now: env.now,
    });
    const fakeReq = { headers: { authorization: `Bearer ${env.config.auth.token}` }, socket: { remoteAddress: IP } };
    const identity = gate.identify(fakeReq);
    assert.equal(identity?.via, 'legacy');
    assert.equal(identity?.role, 'admin');
    assert.equal(identity?.userId, null, 'legacy 没有账户身份，不能编一个假用户');

    // 伪造的 token 既不是 legacy 也不是合法 JWT
    const bogus = { headers: { authorization: 'Bearer not-a-real-token' }, socket: { remoteAddress: IP } };
    assert.equal(gate.identify(bogus), null);
  } finally {
    env.db.close();
  }
});

test('T10.4 身份：角色以库为准，降级后旧令牌不能继续当管理员', async () => {
  const env = fresh();
  try {
    const admin = await makeUser(env, 'boss', 'boss-password-1', 'admin');
    await makeUser(env, 'boss2', 'boss2-password-1', 'admin');
    const { tokens } = await env.auth.login({ username: 'boss', password: 'boss-password-1', ip: IP, userAgent: UA });

    const gate = new TokenGate(env.config.auth.token, ['/api/health'], true, {
      jwtSecret: env.config.auth.jwtSecret,
      sessions: env.sessions,
      users: env.users,
      now: env.now,
    });
    const fakeReq = { headers: { authorization: `Bearer ${tokens.accessToken}` }, socket: { remoteAddress: IP } };
    assert.equal(gate.identify(fakeReq)?.role, 'admin');

    env.users.setRole(admin.id, 'user');
    assert.equal(gate.identify(fakeReq)?.role, 'user', '令牌里的 role 只是快照，权限必须以库为准');
  } finally {
    env.db.close();
  }
});

test('T10.4 假校验本身不抛异常（哈希串坏了也不能崩）', async () => {
  const value = await verifyPasswordDummy();
  assert.equal(value, false);
});
