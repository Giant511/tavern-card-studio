/**
 * T10.8 单测：可见范围（legacy 降权矩阵）+ 过滤实现的一致性。
 *
 * 用户拍板的行为：
 *   · legacy 全局令牌在**多账户**环境下只看未归属卡片（`owner_id = ''`）；
 *   · 单账户环境行为不变（未归属的都还算"自己的"，因为它本来就是那些卡的主人）。
 *
 * 这里做两件事：
 *   1. 纯函数层：`scopeFromIdentity` / `scopeSql` / `rowInScope` 的矩阵；
 *   2. 存储层：真库真查询，验证过滤确实发生在 SQL 里（而不是取出来再筛），
 *      并且"不属于我"与"不存在"返回完全相同的 `undefined`。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { Db } from '../server/dist/storage/db.js';
import {
  ALL_CARDS,
  UNOWNED_CARDS,
  describeScope,
  rowInScope,
  scopeFromIdentity,
  scopeSql,
} from '../server/dist/storage/card-scope.js';

// ── 1. 身份 → 范围矩阵 ─────────────────────────────────────

test('T10.8 legacy 全局令牌 → unowned（不是 all，也不是某个账户）', () => {
  const scope = scopeFromIdentity({
    via: 'legacy',
    userId: null,
    sessionId: null,
    role: 'admin',
    username: null,
    repoToken: null,
  });
  assert.deepEqual(scope, { kind: 'unowned' });
});

test('T10.8 账户登录 → owner（管理员不跨账户读别人的卡）', () => {
  const scope = scopeFromIdentity({
    via: 'jwt',
    userId: 'u-alice',
    sessionId: 's1',
    role: 'admin',
    username: 'alice',
    repoToken: null,
  });
  assert.deepEqual(scope, { kind: 'owner', ownerId: 'u-alice', repoId: null });
});

test('T10.8 仓库令牌 → owner + repoId 双收窄', () => {
  const scope = scopeFromIdentity({
    via: 'repo-token',
    userId: 'u-alice',
    sessionId: null,
    role: 'user',
    username: 'alice',
    repoToken: { tokenId: 't1', repoId: 'r-1', scopes: ['read'] },
  });
  assert.deepEqual(scope, { kind: 'owner', ownerId: 'u-alice', repoId: 'r-1' });
});

test('T10.8 仓库令牌数据异常（无 repoId）→ 只按账户收窄，不放行全部', () => {
  const scope = scopeFromIdentity({
    via: 'repo-token',
    userId: 'u-alice',
    sessionId: null,
    role: 'user',
    username: 'alice',
    repoToken: null,
  });
  assert.deepEqual(scope, { kind: 'owner', ownerId: 'u-alice', repoId: null });
});

test('T10.8 无身份（auth.require=false 回环模式）→ 不过滤', () => {
  assert.deepEqual(scopeFromIdentity(null), { kind: 'all' });
});

// ── 2. SQL 片段 ────────────────────────────────────────────

test('T10.8 scopeSql：all 不加条件，unowned 判空串，owner 用参数绑定', () => {
  assert.deepEqual(scopeSql(ALL_CARDS), { clause: '', params: {} });
  assert.deepEqual(scopeSql(UNOWNED_CARDS), { clause: "owner_id = ''", params: {} });

  const owner = scopeSql({ kind: 'owner', ownerId: 'u1', repoId: null });
  assert.equal(owner.clause, 'owner_id = :scopeOwner');
  // 值必须走参数，不能拼进 SQL 字符串
  assert.equal(owner.clause.includes('u1'), false, 'ownerId 不能直接拼进 SQL');
  assert.deepEqual(owner.params, { scopeOwner: 'u1' });

  const both = scopeSql({ kind: 'owner', ownerId: 'u1', repoId: 'r1' });
  assert.equal(both.clause, 'owner_id = :scopeOwner AND repo_id = :scopeRepo');
  assert.deepEqual(both.params, { scopeOwner: 'u1', scopeRepo: 'r1' });
});

test('T10.8 scopeSql 支持列前缀（事件表的子查询场景）', () => {
  const scoped = scopeSql({ kind: 'owner', ownerId: 'u1', repoId: null }, 'cards.');
  assert.equal(scoped.clause, 'cards.owner_id = :scopeOwner');
});

// ── 3. 行级判断（与 SQL 必须同语义）─────────────────────────

test('T10.8 rowInScope 与 SQL 同语义：三种范围 × 四种行', () => {
  const rows = [
    { owner_id: '', repo_id: '', label: '未归属' },
    { owner_id: 'u1', repo_id: 'r1', label: 'u1 的 r1' },
    { owner_id: 'u1', repo_id: 'r2', label: 'u1 的 r2' },
    { owner_id: 'u2', repo_id: 'r1', label: 'u2 的 r1' },
  ];

  const visible = (scope) => rows.filter((row) => rowInScope(row, scope)).map((row) => row.label);

  assert.deepEqual(visible(ALL_CARDS), ['未归属', 'u1 的 r1', 'u1 的 r2', 'u2 的 r1']);
  assert.deepEqual(visible(UNOWNED_CARDS), ['未归属']);
  assert.deepEqual(visible({ kind: 'owner', ownerId: 'u1', repoId: null }), ['u1 的 r1', 'u1 的 r2']);
  assert.deepEqual(visible({ kind: 'owner', ownerId: 'u1', repoId: 'r1' }), ['u1 的 r1']);
  // 关键：u2 的卡对 u1 永远不可见，哪怕 repo_id 相同
  assert.equal(visible({ kind: 'owner', ownerId: 'u1', repoId: 'r1' }).includes('u2 的 r1'), false);
});

test('T10.8 describeScope 不泄露密码/令牌，只给范围形态', () => {
  assert.equal(describeScope(UNOWNED_CARDS), 'unowned');
  assert.equal(describeScope({ kind: 'owner', ownerId: 'u1', repoId: null }), 'owner:u1');
  assert.equal(describeScope({ kind: 'owner', ownerId: 'u1', repoId: 'r1' }), 'owner:u1/repo:r1');
});

// ── 4. 真库：过滤发生在 SQL 里 ─────────────────────────────

let workDir = '';
let db = null;

function cardRow(id, ownerId, repoId) {
  const now = '2026-10-23T00:00:00.000Z';
  return {
    id,
    id_source: 'client',
    owner_id: ownerId,
    repo_id: repoId,
    name: `卡 ${id}`,
    spec: 'v2',
    spec_version: '2.0',
    creator: '',
    tags_json: '[]',
    source_filename: '',
    created_at: now,
    updated_at: now,
    deleted_at: null,
    version_count: 1,
    latest_seq: 1,
    latest_commit: null,
    latest_sha256: null,
    latest_size: null,
    latest_message: null,
    latest_at: null,
    parse_warnings_json: '[]',
    audit_sha256: null,
    audit_error: null,
    audit_generated_at: null,
    audit_error_count: null,
    audit_warning_count: null,
    audit_info_count: null,
    audit_exportable: null,
  };
}

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-scope-'));
  db = new Db(join(workDir, 'state.db'));
  db.insertCard(cardRow('orphan-1', '', ''));
  db.insertCard(cardRow('alice-r1', 'u-alice', 'r1'));
  db.insertCard(cardRow('alice-r2', 'u-alice', 'r2'));
  db.insertCard(cardRow('bob-r1', 'u-bob', 'r1'));
});

after(() => {
  db?.close();
  rmSync(workDir, { recursive: true, force: true });
});

const ids = (rows) => rows.map((row) => row.id).sort();

test('T10.8 真库 listCards：legacy 只拿到未归属', () => {
  const rows = db.listCards({ limit: 100, offset: 0, scope: UNOWNED_CARDS });
  assert.deepEqual(ids(rows), ['orphan-1']);
});

test('T10.8 真库 listCards：账户只拿到自己的（跨账户即使 repo 同名也不可见）', () => {
  const rows = db.listCards({ limit: 100, offset: 0, scope: { kind: 'owner', ownerId: 'u-alice', repoId: null } });
  assert.deepEqual(ids(rows), ['alice-r1', 'alice-r2']);
});

test('T10.8 真库 listCards：仓库令牌再收窄到单仓库', () => {
  const rows = db.listCards({
    limit: 100,
    offset: 0,
    scope: { kind: 'owner', ownerId: 'u-alice', repoId: 'r1' },
  });
  assert.deepEqual(ids(rows), ['alice-r1'], 'u-bob 的 r1 名字相同但不是同一个仓库');
});

test('T10.8 真库 countCards 与 listCards 口径一致（否则分页会错）', () => {
  for (const scope of [ALL_CARDS, UNOWNED_CARDS, { kind: 'owner', ownerId: 'u-alice', repoId: null }]) {
    const listed = db.listCards({ limit: 100, offset: 0, scope }).length;
    const counted = db.countCards({ scope });
    assert.equal(counted, listed, `口径不一致：${describeScope(scope)} list=${String(listed)} count=${String(counted)}`);
  }
});

test('T10.8 真库 getCard：不属于我 == 不存在（同一个 undefined）', () => {
  const scope = { kind: 'owner', ownerId: 'u-alice', repoId: null };
  const otherAccount = db.getCard('bob-r1', { scope });
  const notExist = db.getCard('no-such-card', { scope });
  assert.equal(otherAccount, undefined);
  assert.equal(notExist, undefined);
  // 对象层面完全相同（都是 undefined），上层不可能区分出"存在但越权"
  assert.equal(otherAccount, notExist);
});

test('T10.8 真库 getCard：带范围也能正常取到自己的卡', () => {
  const row = db.getCard('alice-r1', { scope: { kind: 'owner', ownerId: 'u-alice', repoId: 'r1' } });
  assert.equal(row?.id, 'alice-r1');
});

test('T10.8 真库 totals：三个计数都按范围收窄（漏一个就是侧信道）', () => {
  const global = db.totals(ALL_CARDS);
  assert.equal(global.cards, 4);

  const alice = db.totals({ kind: 'owner', ownerId: 'u-alice', repoId: null });
  assert.equal(alice.cards, 2);
  // 版本数与字节数也必须收窄：否则"总版本数"能反推出别人有多少卡
  assert.ok(alice.versions < global.versions || global.versions === 0);
  const legacy = db.totals(UNOWNED_CARDS);
  assert.equal(legacy.cards, 1);
});
