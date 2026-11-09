/**
 * 邀请码注册模式（v0.1.7）—— `registerMode === 'invite'` 的端到端（服务层）测试。
 *
 * ## 这组测试守的三件事
 *
 * ### 1. 新增的模式不许改动老模式的行为
 *
 * 需求原话：「可切换，现有的注册模式不变，只是加邀请码注册」。
 * 所以 `closed` / `open` / `admin-only` 三条路径**必须逐个复测**，
 * 判据是它们各自的错误码与成功路径都没变 —— 加一个枚举值却把老分支写坏，
 * 是这类改动最常见的形态。
 *
 * ### 2. 扣码与建账户同生共死
 *
 * 用户名撞车时，邀请码**不能被扣掉**。这条只能靠"先制造一次失败再查 used_count"验证，
 * 光看代码看不出来（事务在 `InviteStore.withTransaction` 里）。
 *
 * ### 3. 三处拒绝要能区分
 *
 * 没填码 / 码无效 / 码过期 / 码用尽 —— 用户要做的动作各不相同。
 * 混成一句"注册失败"会让人反复试同一个过期码。
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Db } from '../server/dist/storage/db.js';
import { UserStore } from '../server/dist/storage/users.js';
import { SessionStore } from '../server/dist/auth/sessions.js';
import { LoginLimiter, DEFAULT_RATE_LIMIT } from '../server/dist/auth/login-limit.js';
import { AuthService, AuthError } from '../server/dist/auth/service.js';
import { InviteStore, INVITE_MAX_USES } from '../server/dist/storage/invites.js';

let workDir;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-invite-reg-'));
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

let seq = 0;

/**
 * 起一套独立的服务层（每个用例一份库）。
 *
 * @param {string} mode 注册模式
 */
function fresh(mode) {
  seq += 1;
  const db = new Db(join(workDir, `reg-${String(seq)}.db`));
  const config = {
    auth: {
      token: 'legacy-global-token',
      require: true,
      publicPaths: ['/api/health'],
      registerMode: mode,
      jwtSecret: 'unit-test-jwt-secret-bbbbbbbbbbbbbbbbbbbbbbbb',
    },
  };
  const users = new UserStore(db.handle);
  const sessions = new SessionStore(db.handle);
  const limiter = new LoginLimiter(db.handle, DEFAULT_RATE_LIMIT);
  const invites = new InviteStore(db.handle);
  let clock = new Date('2026-10-30T00:00:00.000Z');

  const auth = new AuthService({
    config,
    users,
    sessions,
    limiter,
    invites,
    now: () => clock,
  });

  return {
    db,
    users,
    invites,
    auth,
    setClock: (iso) => {
      clock = new Date(iso);
    },
    advance: (ms) => {
      clock = new Date(clock.getTime() + ms);
    },
    now: () => clock,
    close: () => db.handle.close(),
  };
}

/** 注册一次，返回错误码（成功返回 null） */
async function registerWith(env, input) {
  try {
    await env.auth.register({
      username: input.username,
      password: input.password ?? 'correct horse battery staple',
      ip: '127.0.0.1',
      userAgent: 'test',
      callerIsAdmin: input.callerIsAdmin === true,
      ...(input.inviteCode === undefined ? {} : { inviteCode: input.inviteCode }),
    });
    return null;
  } catch (error) {
    if (error instanceof AuthError) return error.code;
    throw error;
  }
}

/* ═════════ 老模式不许回归 ═════════ */

test('★ closed 模式仍然明确拒绝（错误码不变）', async () => {
  const env = fresh('closed');
  try {
    assert.equal(await registerWith(env, { username: 'alice' }), 'REGISTRATION_CLOSED');
  } finally {
    env.close();
  }
});

test('★ open 模式仍可直接注册，且**不需要**邀请码', async () => {
  const env = fresh('open');
  try {
    assert.equal(await registerWith(env, { username: 'alice' }), null);
    // 关键：open 模式下即使传了一个不存在的码，也不该被拦 ——
    // 这个模式根本不看这个字段
    assert.equal(await registerWith(env, { username: 'bob', inviteCode: 'ZZZZZZZZ' }), null);
  } finally {
    env.close();
  }
});

test('★ admin-only 模式：非管理员仍被拒，管理员仍可直接建号', async () => {
  const env = fresh('admin-only');
  try {
    assert.equal(await registerWith(env, { username: 'alice' }), 'FORBIDDEN');
    assert.equal(await registerWith(env, { username: 'alice', callerIsAdmin: true }), null);
  } finally {
    env.close();
  }
});

/* ═════════ invite 模式 ═════════ */

test('★ invite 模式：不带邀请码直接拒绝，且错误码是 INVITE_REQUIRED', async () => {
  const env = fresh('invite');
  try {
    assert.equal(await registerWith(env, { username: 'alice' }), 'INVITE_REQUIRED');
    // 空串与纯空白也算没填
    assert.equal(await registerWith(env, { username: 'alice', inviteCode: '' }), 'INVITE_REQUIRED');
    assert.equal(await registerWith(env, { username: 'alice', inviteCode: '   ' }), 'INVITE_REQUIRED');
    // 一次都不该建出账户
    assert.equal(env.users.count(), 0);
  } finally {
    env.close();
  }
});

test('★ invite 模式：有效邀请码可以注册，且扣减一次', async () => {
  const env = fresh('invite');
  try {
    const invite = env.invites.create({ validityMs: 86400000 }, env.now());
    assert.equal(await registerWith(env, { username: 'alice', inviteCode: invite.code }), null);
    assert.equal(env.users.count(), 1);

    const after = env.invites.findByCode(invite.code);
    assert.ok(after !== null);
    assert.equal(after.used_count, 1, '注册成功应当扣掉一次');
  } finally {
    env.close();
  }
});

test('★ 一张码注册 3 个账户后，第 4 个被拒且错误码仍可读', async () => {
  const env = fresh('invite');
  try {
    const invite = env.invites.create({ validityMs: 86400000 }, env.now());

    for (let i = 1; i <= INVITE_MAX_USES; i += 1) {
      assert.equal(
        await registerWith(env, { username: `user${String(i)}`, inviteCode: invite.code }),
        null,
        `第 ${String(i)} 个账户应当成功`,
      );
    }
    assert.equal(env.users.count(), INVITE_MAX_USES);

    // 第 4 个：必须是 INVITE_INVALID（而不是笼统的 REGISTRATION_REJECTED）
    assert.equal(
      await registerWith(env, { username: 'user4', inviteCode: invite.code }),
      'INVITE_INVALID',
    );
    assert.equal(env.users.count(), INVITE_MAX_USES, '第 4 个账户不该建出来');
  } finally {
    env.close();
  }
});

test('★ 邀请码可以带格式（小写/连字符/空格）—— 用户不该因为粘贴带格式而失败', async () => {
  const env = fresh('invite');
  try {
    const invite = env.invites.create({ validityMs: 86400000 }, env.now());
    const pretty = `${invite.code.slice(0, 4).toLowerCase()}-${invite.code.slice(4).toLowerCase()}`;
    assert.equal(await registerWith(env, { username: 'alice', inviteCode: pretty }), null);
  } finally {
    env.close();
  }
});

test('★ 过期的码被拒，且错误码与"码不存在"相同（都是 INVITE_INVALID）', async () => {
  /*
   * 为什么过期与不存在用同一个码：它们对用户是同一件事——"这个码不能用"。
   * 分开会让客户端写两套文案却做同一个动作。
   * 但**文案要能区分**（见 service.ts 里的 message），这条测的是错误码。
   */
  const env = fresh('invite');
  try {
    const invite = env.invites.create({ validityMs: 3600000 }, env.now()); // 1 小时
    env.advance(2 * 3600000); // 跳到 2 小时后

    assert.equal(await registerWith(env, { username: 'alice', inviteCode: invite.code }), 'INVITE_INVALID');
    assert.equal(env.users.count(), 0);
  } finally {
    env.close();
  }
});

test('作废的码被拒', async () => {
  const env = fresh('invite');
  try {
    const invite = env.invites.create({ validityMs: 86400000 }, env.now());
    env.invites.revoke(invite.id, env.now());
    assert.equal(await registerWith(env, { username: 'alice', inviteCode: invite.code }), 'INVITE_INVALID');
  } finally {
    env.close();
  }
});

test('不存在的码被拒', async () => {
  const env = fresh('invite');
  try {
    assert.equal(await registerWith(env, { username: 'alice', inviteCode: 'ZZZZZZZZ' }), 'INVITE_INVALID');
    // 格式对但库里没有
    assert.equal(await registerWith(env, { username: 'alice', inviteCode: 'ABCD2345' }), 'INVITE_INVALID');
  } finally {
    env.close();
  }
});

/* ═════════ 扣码与建账户同生共死 ═════════ */

test('★ 用户名撞车时，邀请码**不能被扣掉**（事务回滚）', async () => {
  /*
   * 这是整个功能里最容易写错的一处：
   * 如果先扣码、再建账户，建账户失败（重名）就白丢一次机会 ——
   * 而用户只会看到"注册失败"，根本不知道自己少了一次。
   *
   * 判据：失败后 used_count 必须还是 0。
   */
  const env = fresh('invite');
  try {
    const invite = env.invites.create({ validityMs: 86400000 }, env.now());

    // 第一个用这张码建成功
    assert.equal(await registerWith(env, { username: 'alice', inviteCode: invite.code }), null);
    const before = env.invites.findByCode(invite.code);
    assert.ok(before !== null);
    assert.equal(before.used_count, 1);

    // 第二个用同一个用户名（撞车）⇒ 失败，且不能再扣一次
    assert.equal(await registerWith(env, { username: 'alice', inviteCode: invite.code }), 'REGISTRATION_REJECTED');

    const after = env.invites.findByCode(invite.code);
    assert.ok(after !== null);
    assert.equal(after.used_count, 1, '撞车失败不该消耗邀请码额度');
  } finally {
    env.close();
  }
});

test('★ 密码不合规时也不扣额度', async () => {
  const env = fresh('invite');
  try {
    const invite = env.invites.create({ validityMs: 86400000 }, env.now());
    // 太短的密码会在哈希前被拦
    assert.equal(
      await registerWith(env, { username: 'alice', password: 'x', inviteCode: invite.code }),
      'REGISTRATION_REJECTED',
    );
    const after = env.invites.findByCode(invite.code);
    assert.ok(after !== null);
    assert.equal(after.used_count, 0, '密码不合规不该消耗邀请码额度');
  } finally {
    env.close();
  }
});

/* ═════════ 首个账户 ═════════ */

test('invite 模式下首个账户仍是管理员（与既有规则一致）', async () => {
  /*
   * 这条不改行为，只是钉住"邀请码注册没有偷偷改变首账户的角色规则"。
   * 实践中 invite 模式不可能出现空库：码只能由管理员生成，
   * 而空库时没有管理员。所以这条是防御性的。
   */
  const env = fresh('invite');
  try {
    const invite = env.invites.create({ validityMs: 86400000 }, env.now());
    assert.equal(await registerWith(env, { username: 'first', inviteCode: invite.code }), null);
    const user = env.users.findByUsername('first');
    assert.ok(user !== null);
    assert.equal(user.role, 'admin');
  } finally {
    env.close();
  }
});

test('invite 模式下第二个账户是普通用户', async () => {
  const env = fresh('invite');
  try {
    const invite = env.invites.create({ validityMs: 86400000 }, env.now());
    await registerWith(env, { username: 'first', inviteCode: invite.code });
    await registerWith(env, { username: 'second', inviteCode: invite.code });
    const user = env.users.findByUsername('second');
    assert.ok(user !== null);
    assert.equal(user.role, 'user');
  } finally {
    env.close();
  }
});

/* ═════════ 依赖缺失不许静默放行 ═════════ */

test('★ 没接 InviteStore 时 invite 模式报 SERVICE_UNAVAILABLE，**不许**降级成"不需要码"', async () => {
  /*
   * 这是最坏的一种降级：配置写了"要邀请码"，但依赖没接上，
   * 于是门开着而不说 —— 谁都能注册，而没人知道。
   * 宁可 500。
   */
  seq += 1;
  const db = new Db(join(workDir, `norepo-${String(seq)}.db`));
  try {
    const config = {
      auth: {
        token: 't',
        require: true,
        publicPaths: [],
        registerMode: 'invite',
        jwtSecret: 'unit-test-jwt-secret-cccccccccccccccccccccccc',
      },
    };
    const users = new UserStore(db.handle);
    const sessions = new SessionStore(db.handle);
    const limiter = new LoginLimiter(db.handle, DEFAULT_RATE_LIMIT);
    // 故意不传 invites
    const auth = new AuthService({ config, users, sessions, limiter });

    await assert.rejects(
      () =>
        auth.register({
          username: 'alice',
          password: 'correct horse battery staple',
          ip: '127.0.0.1',
          userAgent: 'test',
          callerIsAdmin: false,
          inviteCode: 'ABCD2345',
        }),
      (error) => error instanceof AuthError && error.code === 'SERVICE_UNAVAILABLE',
    );
    assert.equal(users.count(), 0, '不许建出账户');
  } finally {
    db.handle.close();
  }
});
