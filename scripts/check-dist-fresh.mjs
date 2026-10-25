#!/usr/bin/env node
/**
 * 构建后写指纹 / 测试前查指纹。
 *
 * 用法：
 *   node scripts/check-dist-fresh.mjs write shared   # 构建脚本里调用（tsc -b 成功后）
 *   node scripts/check-dist-fresh.mjs check          # 测试/提交前调用，失败即退出 1
 *
 * 为什么分成 write / check 两个动作而不各自写一个脚本：
 * 判定逻辑必须只有一份（scripts/lib/dist-stamp.mjs），
 * 否则「写入时算一种口径、校验时算另一种口径」，指纹通过与否都不作数。
 */

import { checkStamp, writeStamp } from './lib/dist-stamp.mjs';

const [, , action, pkg] = process.argv;

if (action === 'write') {
  const target = pkg ?? 'shared';
  if (!['shared', 'server', 'client'].includes(target)) {
    console.error(`未知的包：${target}`);
    process.exit(2);
  }
  const payload = writeStamp(target);
  console.log(`[stamp] ${target}/dist ← ${payload.sourceHash.slice(0, 12)}… (${String(payload.sourceFiles)} 个源文件)`);
  process.exit(0);
}

if (action === 'check') {
  const targets = pkg ? [pkg] : ['shared', 'server'];
  let bad = 0;
  for (const target of targets) {
    const result = checkStamp(target);
    if (result.ok) {
      console.log(`[stamp] ${target}/dist 新鲜 ✔ ${result.current.hash.slice(0, 12)}…`);
      continue;
    }
    bad += 1;
    console.error(`[stamp] ${target}/dist 不是当前源码编译出来的 ✘`);
    for (const reason of result.reasons) console.error(`    ${reason}`);
  }
  if (bad > 0) {
    console.error('');
    console.error('单测跑的是 dist，不是 src。dist 不新鲜时「测试全绿」不成立 ——');
    console.error('先跑 `npm run build:shared && npm run build:server`，或直接用 `npm test`。');
    process.exit(1);
  }
  process.exit(0);
}

console.error('用法：node scripts/check-dist-fresh.mjs write <shared|server|client> | check');
process.exit(2);
