/**
 * T10.7 结构守卫：登录态变化**不得触碰本地卡片会话**。
 *
 * 需求原文：「401 且 refresh 失败 → 回登录界面（不清空已打开的本地卡片编辑会话）」。
 *
 * 这条要求没法用"跑一遍看有没有清空"来验 —— 清空是多条路径的共同结果，
 * 跑通的用例只能证明"这次没清"，证不了"以后也不会清"。
 * 所以这里改成读源码：把 `handleUnauthorized` / `wireAccount` 两个方法体切出来，
 * 断言里面**没有**任何操作会话的调用。谁哪天顺手加一句 `this.closeSession()`，
 * 这个测试立刻红。
 *
 * 与 `test/audit-panel-mount.test.mjs`（F6 那次）是同一手法：
 * 单测环境没有完整 DOM，就退到"结构不变量"这一层来守。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const APP = readFileSync(new URL('../client/src/editor/app.ts', import.meta.url), 'utf8');
const SESSION = readFileSync(new URL('../client/src/auth/session.ts', import.meta.url), 'utf8');

/** 切出某个方法的源码（从标记处到下一个 2 空格缩进的 private/async 成员） */
function methodBody(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `没找到方法：${marker}`);
  const rest = source.slice(start + marker.length);
  const nextMembers = ['\n  private ', '\n  public ', '\n  // ──'].map((token) => rest.indexOf(token));
  const candidates = nextMembers.filter((index) => index > 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : rest.length;
  return rest.slice(0, end);
}

/** 这些调用都属于"动本地会话"，登录态处理里一个都不该出现 */
const FORBIDDEN = [
  'this.sessions',
  'closeSession',
  'markSaved',
  'replaceCard',
  'this.tabs',
  'this.blocks',
  'reloadBlocksFromCard',
];

test('T10.7 结构守卫：401 处理不触碰任何本地会话', () => {
  const body = methodBody(APP, 'private async handleUnauthorized()');
  for (const token of FORBIDDEN) {
    assert.equal(body.includes(token), false, `handleUnauthorized 里出现了 ${token}：登录过期不该动本地编辑内容`);
  }
  // 它必须做的两件事：回登录界面 + 只说一句原因
  assert.ok(body.includes('loginDialog'), '应把用户带回登录界面');
  assert.ok(body.includes('本地未保存的编辑不会丢失'), '应明确告知本地内容没丢');
});

test('T10.7 结构守卫：账户装配不触碰任何本地会话', () => {
  const body = methodBody(APP, 'private wireAccount()');
  for (const token of FORBIDDEN) {
    assert.equal(body.includes(token), false, `wireAccount 里出现了 ${token}`);
  }
});

test('T10.7 结构守卫：登录态模块无法接触会话/标签（结构上做不到）', () => {
  for (const token of ['sessions', 'closeSession', 'tabBar', 'beforeunload']) {
    assert.equal(
      SESSION.includes(token),
      false,
      `auth/session.ts 里出现 ${token}：登录态不该知道本地会话的存在`,
    );
  }
});

test('T10.7 结构守卫：401 只在"先续期、再回登录"的路径上弹框', () => {
  const body = methodBody(APP, 'private async handleUnauthorized()');
  const refreshAt = body.indexOf('recoverAfterUnauthorized');
  const dialogAt = body.indexOf('loginDialog');
  assert.ok(refreshAt >= 0, '必须先尝试续期');
  assert.ok(dialogAt >= 0, '续不上要回登录界面');
  assert.ok(refreshAt < dialogAt, '顺序错了：先续期成功就直接返回，不该再弹登录框');
});
