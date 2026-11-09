/**
 * 邀请码存储层（v0.1.7）—— `server/src/storage/invites.ts` 的单测。
 *
 * ## 这组测试守的是什么
 *
 * 需求给了两个硬上限：**一张码最多 3 个账户**、**最长 15 天**。
 * 这两条如果只写在界面上，等于没写（请求可以被直接构造）；
 * 而"最多 3 次"如果写成"先读再写"，并发下必然超发。
 *
 * 所以判据不是"能生成码"，而是：
 *   ① 第 4 次消费必须失败，且 `used_count` 停在 3；
 *   ② 时长上限是**服务端**拒绝的（不是界面挡的）；
 *   ③ 过期/作废/用尽三种状态互不掩盖。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Db } from '../server/dist/storage/db.js';
import {
  INVITE_MAX_USES,
  INVITE_MAX_VALIDITY_MS,
  InviteError,
  InviteStore,
  generateInviteCode,
  inviteState,
  looksLikeInviteCode,
  normalizeInviteCode,
} from '../server/dist/storage/invites.js';

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tcs-invite-'));
  const db = new Db(join(dir, 'state.db'));
  try {
    fn(new InviteStore(db.handle), db);
  } finally {
    db.handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ───────────── 码的形态 ───────────── */

test('生成的码是 8 位、只用去掉易混字符的字母表', () => {
  for (let i = 0; i < 50; i += 1) {
    const code = generateInviteCode();
    assert.equal(code.length, 8);
    assert.match(code, /^[A-Z2-9]+$/);
    // 这三个字符最容易看错，必须不在字母表里
    for (const bad of ['0', 'O', '1', 'I', 'L']) {
      assert.equal(code.includes(bad), false, `码里出现了易混字符 ${bad}: ${code}`);
    }
  }
});

test('规范化：空格/连字符/下划线/小写都能容错', () => {
  /*
   * 用户从聊天窗口复制粘贴时，几乎一定会带格式。
   * 不容错的话表现为"码明明是对的却提示无效"——而用户无从自证。
   */
  const canonical = 'ABCD2345';
  for (const variant of ['abcd2345', 'ABCD 2345', 'ABCD-2345', 'abcd_2345', ' ABCD2345 ']) {
    assert.equal(normalizeInviteCode(variant), canonical, `规范化失败: ${JSON.stringify(variant)}`);
  }
});

test('规范化会去掉零宽字符（从网页复制常见）', () => {
  assert.equal(normalizeInviteCode('ABCD\u200b2345'), 'ABCD2345');
});

test('looksLikeInviteCode 只认 8 位合法字母表', () => {
  assert.equal(looksLikeInviteCode('ABCD2345'), true);
  assert.equal(looksLikeInviteCode('ABCD234'), false, '7 位');
  assert.equal(looksLikeInviteCode('ABCD23456'), false, '9 位');
  assert.equal(looksLikeInviteCode('ABCD0234'), false, '含 0');
});

/* ───────────── ★ 次数上限（核心） ───────────── */

test('★ 一张码最多用 3 次，第 4 次必须失败', () => {
  withStore((store) => {
    const now = new Date('2026-10-30T00:00:00.000Z');
    const invite = store.create({ validityMs: 86400000 }, now);
    assert.equal(invite.remaining, INVITE_MAX_USES);
    assert.equal(INVITE_MAX_USES, 3);

    for (let i = 1; i <= INVITE_MAX_USES; i += 1) {
      assert.equal(store.consume(invite.code, now), true, `第 ${String(i)} 次应当成功`);
    }
    // 第 4 次：必须 false，不能"再给一次"
    assert.equal(store.consume(invite.code, now), false, '第 4 次不该成功');

    const after = store.findByCode(invite.code);
    assert.ok(after !== null);
    // 判据是**计数停在 3**，不是"最后一次返回了 false"——
    // 如果 UPDATE 写成先判断后自增，这里可能变成 4
    assert.equal(after.used_count, 3);
  });
});

test('★ 消费是原子的：连发 10 次只有 3 次成功', () => {
  /*
   * 这条模拟"同一个码发到群里，多人同时点注册"。
   * 走的是同一条 SQL 的原子性，而不是先读后写。
   */
  withStore((store) => {
    const now = new Date('2026-10-30T00:00:00.000Z');
    const invite = store.create({ validityMs: 86400000 }, now);

    let ok = 0;
    for (let i = 0; i < 10; i += 1) {
      if (store.consume(invite.code, now)) ok += 1;
    }
    assert.equal(ok, INVITE_MAX_USES, `10 次尝试应当恰好成功 3 次，实际 ${String(ok)}`);

    const after = store.findByCode(invite.code);
    assert.ok(after !== null);
    assert.equal(after.used_count, INVITE_MAX_USES, '计数不该超过上限');
  });
});

test('不存在的码消费失败（不抛错）', () => {
  withStore((store) => {
    assert.equal(store.consume('ZZZZZZZZ', new Date()), false);
    assert.equal(store.consume('', new Date()), false);
  });
});

/* ───────────── ★ 时效 ───────────── */

test('★ 过期后不能消费，且状态是 expired', () => {
  withStore((store) => {
    const created = new Date('2026-10-30T00:00:00.000Z');
    const invite = store.create({ validityMs: 3600000 }, created); // 1 小时
    const expiresAt = new Date(invite.expires_at);

    // 到期前 1 秒：可用
    assert.equal(store.consume(invite.code, new Date(expiresAt.getTime() - 1000)), true);
    // 到期那一毫秒：不可用（判据是 <= now，边界归"已过期"）
    assert.equal(store.consume(invite.code, expiresAt), false);
    // 过期后
    assert.equal(store.consume(invite.code, new Date(expiresAt.getTime() + 1000)), false);
  });
});

test('★ 超过 15 天必须被**服务端**拒绝（不能只靠界面限制）', () => {
  withStore((store) => {
    const now = new Date('2026-10-30T00:00:00.000Z');

    // 正好 15 天：允许（"最大15天"包含 15 天本身）
    const ok = store.create({ validityMs: INVITE_MAX_VALIDITY_MS }, now);
    assert.ok(ok.code.length === 8);

    // 15 天 + 1 毫秒：拒绝
    assert.throws(
      () => store.create({ validityMs: INVITE_MAX_VALIDITY_MS + 1 }, now),
      (error) => error instanceof InviteError && error.code === 'INVALID_VALIDITY',
    );
  });
});

test('0 或负数时长被拒绝（否则等于"立刻过期"，会让人以为系统坏了）', () => {
  withStore((store) => {
    const now = new Date();
    for (const bad of [0, -1, -86400000]) {
      assert.throws(
        () => store.create({ validityMs: bad }, now),
        (error) => error instanceof InviteError && error.code === 'INVALID_VALIDITY',
        `时长 ${String(bad)} 应当被拒绝`,
      );
    }
  });
});

test('NaN / Infinity 时长被拒绝', () => {
  withStore((store) => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => store.create({ validityMs: bad }, new Date()),
        (error) => error instanceof InviteError,
      );
    }
  });
});

/* ───────────── 状态判定 ───────────── */

/**
 * 造一个 InviteRow 样本。
 *
 * `.mjs` 不能写 TS 类型标注（`Partial<InviteRow>`），所以这里刻意不带类型——
 * 只有 `over` 的字段会被覆盖，其余走默认值。
 */
function row(over = {}) {
  return {
    id: 'id',
    code: 'ABCD2345',
    code_key: 'ABCD2345',
    max_uses: 3,
    used_count: 0,
    expires_at: '2026-11-01T00:00:00.000Z',
    note: '',
    created_at: '2026-10-30T00:00:00.000Z',
    created_by: '',
    revoked_at: null,
    ...over,
  };
}

test('★ 四种状态互不掩盖：作废 > 过期 > 用尽 > 可用', () => {
  /*
   * 顺序是刻意的：人工作废是**明确意图**，不该被"已过期"盖住 ——
   * 用户看到"作废"才知道去找管理员，看到"过期"只会等一个不会来的续期。
   */
  const now = new Date('2026-10-31T00:00:00.000Z');

  assert.equal(inviteState(row(), now), 'active');
  assert.equal(inviteState(row({ used_count: 3 }), now), 'exhausted');
  assert.equal(inviteState(row({ expires_at: '2026-10-30T00:00:00.000Z' }), now), 'expired');
  assert.equal(inviteState(row({ revoked_at: '2026-10-30T12:00:00.000Z' }), now), 'revoked');

  // 同时过期 + 作废 ⇒ 报作废
  assert.equal(
    inviteState(
      row({ revoked_at: '2026-10-30T12:00:00.000Z', expires_at: '2026-10-30T00:00:00.000Z' }),
      now,
    ),
    'revoked',
  );
  // 同时用尽 + 作废 ⇒ 报作废
  assert.equal(inviteState(row({ used_count: 3, revoked_at: '2026-10-30T12:00:00.000Z' }), now), 'revoked');
});

test('作废后不能消费，且重复作废保留最早的作废时间', () => {
  withStore((store) => {
    const now = new Date('2026-10-30T00:00:00.000Z');
    const invite = store.create({ validityMs: 86400000 }, now);

    const first = store.revoke(invite.id, now);
    assert.ok(first !== null);
    assert.equal(first.state, 'revoked');
    assert.equal(store.consume(invite.code, now), false, '作废后不该能消费');

    // 第二次作废（换一个更晚的时间）：existing revoked_at 不能被覆盖
    const later = new Date(now.getTime() + 3600000);
    const second = store.revoke(invite.id, later);
    assert.ok(second !== null);
    assert.equal(second.revoked_at, first.revoked_at, '重复作废不该改时间');
  });
});

test('作废不存在的 id 返回 null（不抛错）', () => {
  withStore((store) => {
    assert.equal(store.revoke('no-such-id', new Date()), null);
  });
});

/* ───────────── 列表与备注 ───────────── */

test('list 按创建时间倒序，且带上剩余次数与状态', () => {
  withStore((store) => {
    const t0 = new Date('2026-10-30T00:00:00.000Z');
    const a = store.create({ validityMs: 86400000, note: '给张三' }, t0);
    const b = store.create({ validityMs: 86400000, note: '给李四' }, new Date(t0.getTime() + 1000));
    store.consume(a.code, t0);

    const list = store.list(t0);
    assert.equal(list.length, 2);
    assert.equal(list[0].id, b.id, '最新的排在最前');
    assert.equal(list[1].id, a.id);
    assert.equal(list[1].remaining, 2, 'a 用掉一次后剩 2');
    assert.equal(list[1].state, 'active');
    assert.equal(list[0].note, '给李四');
  });
});

test('note 会被 trim；不传时是空串而不是 undefined', () => {
  withStore((store) => {
    const now = new Date();
    assert.equal(store.create({ validityMs: 3600000, note: '  张三  ' }, now).note, '张三');
    assert.equal(store.create({ validityMs: 3600000 }, now).note, '');
  });
});

test('创建者 uid 落库（审计线索）', () => {
  withStore((store) => {
    const now = new Date();
    const inv = store.create({ validityMs: 3600000, createdBy: 'user-abc' }, now);
    assert.equal(inv.created_by, 'user-abc');
  });
});

test('码大小写不同也能查到（走规范化键）', () => {
  withStore((store) => {
    const now = new Date();
    const inv = store.create({ validityMs: 3600000 }, now);
    assert.ok(store.findByCode(inv.code.toLowerCase()) !== null);
    assert.ok(store.findByCode(`${inv.code.slice(0, 4)}-${inv.code.slice(4)}`) !== null);
  });
});

test('★ 事务回滚：fn 抛错时扣减不生效', () => {
  /*
   * 这条守的是 `withTransaction` 的语义 —— 注册流程里"扣码 + 建账户"同事务，
   * 建账户失败必须让扣减一起回滚，否则用户白丢一次机会。
   */
  withStore((store) => {
    const now = new Date('2026-10-30T00:00:00.000Z');
    const invite = store.create({ validityMs: 86400000 }, now);

    assert.throws(() =>
      store.withTransaction(() => {
        assert.equal(store.consume(invite.code, now), true);
        throw new Error('模拟建账户失败');
      }),
    );

    const after = store.findByCode(invite.code);
    assert.ok(after !== null);
    assert.equal(after.used_count, 0, '事务回滚后 used_count 必须回到 0');
    // remaining 只有 InviteView 才有（列表/生成时算出来的派生值），
    // 所以这里走 list() 而不是直接读 row —— 顺带验证了列表里的派生值也是对的
    const view = store.list(now).find((item) => item.id === invite.id);
    assert.ok(view !== undefined);
    assert.equal(view.remaining, INVITE_MAX_USES);
  });
});
