/**
 * dist 新鲜度守卫（测试纪律的落地实现）。
 *
 * 这个文件存在的唯一理由：**「测试全绿」必须建立在「跑的是当前源码」之上**。
 *
 * 2026-10-25 的事故：往 `users.ts` 注入一个类型不合法的字段做负向验证，
 * `tsc -b server` 拒绝编译，输出被重定向掉了，接着直接 `node --test` —— 测试
 * 加载的是上一次成功编译的 dist，于是「注入后仍然全绿」。差一点被读成
 * 「这条断言抓不住缺陷」，实际是断言根本没见到新代码。
 *
 * 纪律（写进 docs/41-testing-discipline.md，这里是它的机器判据）：
 *   1. 判定用**内容哈希**，不用 mtime（`tsc -b` 增量构建下 mtime 会骗人）；
 *   2. 构建失败不写指纹 → 下一次校验必然红，坏构建不会静默退化成「旧产物也算过」；
 *   3. 换分支 / 换 worktree 后 dist 可能来自别的提交，同样被这条判据拦住。
 *
 * 注意：`node --test test/xxx.test.mjs` 这种**单文件直跑**不经过本判据
 * （它是 `npm test` 链上的一步）。要跑单个文件，先 `npm run build:server`。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkStamp, computeSourceHash, stampPath } from '../scripts/lib/dist-stamp.mjs';
import { existsSync } from 'node:fs';

test('shared/dist 与当前 shared/src 一致', () => {
  const result = checkStamp('shared');
  assert.ok(result.ok, `shared/dist 不是当前源码编译出来的：\n  ${result.reasons.join('\n  ')}`);
});

test('server/dist 与当前 server/src + shared/src 一致', () => {
  const result = checkStamp('server');
  assert.ok(result.ok, `server/dist 不是当前源码编译出来的：\n  ${result.reasons.join('\n  ')}`);
});

test('指纹覆盖到了源文件（不是空目录也能算出同一个哈希）', () => {
  const shared = computeSourceHash('shared');
  const server = computeSourceHash('server');
  assert.ok(shared.files > 20, `shared/src 只数到 ${String(shared.files)} 个 .ts，扫描逻辑可能坏了`);
  // server 的指纹包含 shared/src：只改 shared 也要让 server 的 dist 失效
  assert.ok(server.files > shared.files, 'server 的指纹必须含 shared/src（server 依赖 @tcs/shared 的产物）');
});

test('指纹文件本身存在（缺了说明构建没走 npm run build:*）', () => {
  assert.ok(existsSync(stampPath('shared')), '缺少 shared/dist/.build-stamp.json');
  assert.ok(existsSync(stampPath('server')), '缺少 server/dist/.build-stamp.json');
});
