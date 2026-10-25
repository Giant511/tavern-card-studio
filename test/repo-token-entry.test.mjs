/**
 * 仓库令牌连接入口（v0.1.3 / F5 后半）。
 *
 * 这一层是**安全边界**，所以重点不是"能不能连上"，而是需求点名的两类要求：
 *
 *   ① 四类失败原因各自成立：格式错误 / 已吊销 / 已过期 / 无效；
 *   ② **「令牌不存在」与「无效」必须逐字节相同** —— 包括 hint。
 *      比 JSON 字段而不是比"文案相似"：字段顺序与空白也是可利用的差异。
 *
 * 另外钉住一条容易漂移的东西：`looksLikeRepoToken` 的形态必须与
 * `generateRepoToken()` 的真实产物一致。两处若分开写，签发出来的令牌
 * 可能在本入口被判"格式不对"—— 那是"签了却用不了"的最隐蔽形态。
 *
 * 运行：node --test test/repo-token-entry.test.mjs（需先 npm run build:server）
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Db } from '../server/dist/storage/db.js';
import { UserStore } from '../server/dist/storage/users.js';
import { RepoStore, TokenStore, generateRepoToken } from '../server/dist/storage/repos.js';
import { hashPassword } from '../server/dist/auth/password.js';
import { looksLikeRepoToken, verifyRepoTokenEntry } from '../server/dist/auth/repo-token-entry.js';

let workDir;
/**
 * 本文件开过的库句柄。
 *
 * 不关的话 `after` 里的 `rmSync` 在 Windows 上会 EBUSY（文件被进程占着）——
 * 表现为最后多出一条与断言无关的失败，看起来像"测试坏了"。
 * 十来个库文件也就几十毫秒，关掉比 sleep 等它释放可靠。
 */
const opened = [];
before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-repo-token-'));
});
after(() => {
  for (const db of opened) {
    try {
      db.close();
    } catch {
      /* 已关闭的再关会抛，忽略 */
    }
  }
  rmSync(workDir, { recursive: true, force: true });
});

let seq = 0;
const NOW = new Date('2026-10-25T00:00:00.000Z');

/**
 * 起一套干净的库 + 一个账户 + 一个仓库。
 *
 * 注意 `hashPassword` 是**异步**的（argon2 走 worker）。第一版漏了 await，
 * 传进去的是 Promise，better-sqlite3 抛的是
 * "can only bind numbers, strings, bigints, buffers, and null" ——
 * 那条报错完全没提"你少了 await"，看起来像 schema 有问题。
 */
async function fixture({ status = 'active' } = {}) {
  seq += 1;
  const db = new Db(join(workDir, `repo-token-${String(seq)}.db`));
  opened.push(db);
  const users = new UserStore(db.handle);
  const repos = new RepoStore(db.handle);
  const tokens = new TokenStore(db.handle);

  const passwordHash = await hashPassword('Passw0rd!-placeholder-1234');
  const user = users.create({ username: 'alice', passwordHash, status });
  const repo = repos.create({ ownerId: user.id, name: '写作素材', isDefault: true });

  const deps = { tokens, repos, users, now: () => NOW };
  return { db, users, repos, tokens, user, repo, deps };
}

test('形态校验与签发产物一致（签发出来的令牌不会被本入口判成格式错）', async () => {
  // 连出 20 把，覆盖随机字节落在各种首字符上的情况
  for (let i = 0; i < 20; i += 1) {
    const { raw } = generateRepoToken();
    assert.equal(looksLikeRepoToken(raw), true, `签发产物被判为格式非法：${raw}`);
    assert.equal(raw.length, 47, `长度不再是 47：${raw.length}`);
  }
  assert.equal(looksLikeRepoToken('tcr_'), false);
  assert.equal(looksLikeRepoToken('tcr_abc'), false);
  assert.equal(looksLikeRepoToken(`tcr_${'A'.repeat(42)}`), false, '少一位必须挡住');
  assert.equal(looksLikeRepoToken(`tcr_${'A'.repeat(44)}`), false, '多一位必须挡住');
  assert.equal(looksLikeRepoToken(`tcr_${'#'.repeat(43)}`), false, '非法字符必须挡住');
});

test('格式错误返回 400 + TOKEN_FORMAT_INVALID，且不查库', async () => {
  const { deps } = await fixture();
  const result = verifyRepoTokenEntry('not-a-token', deps);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'format');
  assert.equal(result.status, 400);
  assert.equal(result.code, 'TOKEN_FORMAT_INVALID');
});

test('有效令牌：返回仓库、范围、账户名', async () => {
  const { deps, user, repo, tokens } = await fixture();
  const { raw } = tokens.issue({ ownerId: user.id, repoId: repo.id, name: 'CI', scopes: ['read', 'write'] });
  const result = verifyRepoTokenEntry(raw, deps);
  assert.equal(result.ok, true);
  assert.equal(result.repoId, repo.id);
  assert.equal(result.repoName, '写作素材');
  assert.deepEqual(result.scopes, ['read', 'write']);
  assert.equal(result.username, 'alice');
  assert.equal(result.expiresAt, null);
});

test('已吊销返回 401 + TOKEN_REVOKED', async () => {
  const { deps, user, repo, tokens } = await fixture();
  const { row, raw } = tokens.issue({ ownerId: user.id, repoId: repo.id, name: 'CI', scopes: ['read'] });
  tokens.revoke(row.id);
  const result = verifyRepoTokenEntry(raw, deps);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'revoked');
  assert.equal(result.status, 401);
  assert.equal(result.code, 'TOKEN_REVOKED');
});

test('已过期返回 401 + TOKEN_EXPIRED', async () => {
  const { deps, user, repo, tokens } = await fixture();
  const { raw } = tokens.issue({
    ownerId: user.id,
    repoId: repo.id,
    name: 'CI',
    scopes: ['read'],
    expiresAt: new Date(NOW.getTime() - 1000).toISOString(),
  });
  const result = verifyRepoTokenEntry(raw, deps);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expired');
  assert.equal(result.status, 401);
  assert.equal(result.code, 'TOKEN_EXPIRED');
});

test('不枚举：「不存在」与「无效」的响应体逐字节相同（含 hint）', async () => {
  const { deps } = await fixture();

  // ① 一把从未签发过的、形态合法的令牌
  const neverIssued = generateRepoToken().raw;
  const missing = verifyRepoTokenEntry(neverIssued, deps);

  /*
   * ② 令牌有效但仓库已被软删 —— "无效"里另一条真实路径。
   *
   * 注意默认仓库不能删（`remove` 会拒绝），所以这里另建一个非默认仓库。
   * 第一版用默认仓库直接删，结果抛出的是"默认仓库不能删除"，
   * 测试红得莫名其妙 —— 而那种红看起来很像判据本身有问题。
   */
  const second = await fixture();
  const other = second.repos.create({ ownerId: second.user.id, name: '临时仓库', isDefault: false });
  const issued = second.tokens.issue({
    ownerId: second.user.id,
    repoId: other.id,
    name: 'CI',
    scopes: ['read'],
  });
  second.repos.remove(other.id);
  const repoGone = verifyRepoTokenEntry(issued.raw, second.deps);

  assert.equal(missing.ok, false);
  assert.equal(repoGone.ok, false);
  assert.equal(missing.reason, 'invalid');
  assert.equal(repoGone.reason, 'invalid');

  // **逐字节**比：字段顺序、空白、hint 全都算
  assert.equal(
    JSON.stringify(missing),
    JSON.stringify(repoGone),
    '「令牌不存在」与「令牌无效」的响应必须完全一致，否则等于给了攻击者一个存在性探针',
  );
  // 顺带钉住 code 与文案，防止有人把它们改成"更友好"的分支
  assert.equal(missing.code, 'TOKEN_INVALID');
  assert.equal(missing.message, '令牌无效');
  assert.ok(!/不存在|没有找到|not found/i.test(missing.message), '文案里不能出现"不存在"这类字样');
});

test('账户被禁用 → 归 invalid（不单独说"账户已禁用"，那也是存在性泄露）', async () => {
  const { tokens, user, repo, deps, users } = await fixture();
  const { raw } = tokens.issue({ ownerId: user.id, repoId: repo.id, name: 'CI', scopes: ['read'] });
  users.setStatus(user.id, 'disabled');
  const result = verifyRepoTokenEntry(raw, deps);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid');
  assert.equal(result.code, 'TOKEN_INVALID');
});

test('令牌范围被收到空 → 归 invalid（"什么都做不了"与"无效"对用户是同一处置）', async () => {
  const { deps, user, repo, tokens } = await fixture();
  const { row, raw } = tokens.issue({ ownerId: user.id, repoId: repo.id, name: 'CI', scopes: ['read'] });
  // 直接改库模拟"范围被清空"（正常 API 会拒绝空范围，这里是防御性判据）
  tokens.handle.prepare('UPDATE repo_tokens SET scopes = ? WHERE id = ?').run('', row.id);
  const result = verifyRepoTokenEntry(raw, deps);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid');
});
test('令牌归属与仓库归属不一致 → 归 invalid（不能按令牌算越权）', async () => {
  const first = await fixture();
  const second = await fixture();
  // 拿 first 的账户签一把令牌，但把它的 repo_id 改成 second 的仓库
  const { row, raw } = first.tokens.issue({
    ownerId: first.user.id,
    repoId: first.repo.id,
    name: 'CI',
    scopes: ['read'],
  });
  first.tokens.handle.prepare('UPDATE repo_tokens SET repo_id = ? WHERE id = ?').run(second.repo.id, row.id);
  const result = verifyRepoTokenEntry(raw, first.deps);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid');
});

test('永不过期的令牌（expiresAt = null）可以一直用，且 lastUsedAt 初始为 null', async () => {
  const { deps, user, repo, tokens } = await fixture();
  const { raw } = tokens.issue({ ownerId: user.id, repoId: repo.id, name: 'CI', scopes: ['rollback'] });
  const result = verifyRepoTokenEntry(raw, deps);
  assert.equal(result.ok, true);
  assert.equal(result.expiresAt, null);
  assert.equal(result.lastUsedAt, null);
  assert.deepEqual(result.scopes, ['rollback']);
});
