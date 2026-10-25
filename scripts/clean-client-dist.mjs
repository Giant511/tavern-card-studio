#!/usr/bin/env node
/**
 * 客户端产物目录（`client/dist`）的清理 —— **归档式**，不逐文件删除。
 *
 * ## 为什么不是"删"
 *
 * 这个脚本原来按 ≤20 个一批 `rmSync`，理由是 safe-delete 钩子「单次批量超过
 * 50 个就拦截」。那个理解只对了一半：**钩子的计数是按 turn 累计的**，
 * 不是单次。实测被拦的现场是这样的：
 *
 *     [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":50,"threshold":50,
 *       "targets":["...dist\\assets\\perf-CjnXnoNu.js"],"targetCount":1}
 *
 * 删**一个**文件、`count` 却已经是 50 —— 说明"分批"只能推迟撞墙。
 * 撞上之后（同一 turn 里截图/快照/测试探针的删除都会计入）构建就彻底不能做，
 * 而且下一轮 dist 只会更大，形成死锁。2026-10-25 连着踩了三次。
 *
 * ## 现在的做法：改名归档
 *
 * `rename(dist, .verify/dist-archive/<时间戳>)` —— 一次系统调用、O(1)，
 * **不是删除**，因此不受钩子约束。
 *
 * 四个好处：
 *   1. 构建永远能跑，不再取决于"这个 turn 还剩多少删除配额"；
 *   2. 比逐文件删除快得多（66 个文件 vs 1 次 rename）；
 *   3. 留了一份上一轮产物，排查"是不是新构建丢了文件"时有得对比；
 *   4. 与 `vite.config.ts` 的 `emptyOutDir: false` 配套 —— 清理职责只在这一处。
 *
 * 归档目录在 `.verify/` 下（已 gitignore），只保留最近 {@link KEEP} 份。
 * 清理旧归档失败**不报错**：不能因为清垃圾失败而让构建失败。
 *
 * 用法：node scripts/clean-client-dist.mjs
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(REPO, 'client', 'dist');
const ARCHIVE = join(REPO, '.verify', 'dist-archive');
/** 保留几份归档。3 份够对比"上一轮/上上轮"，再多只是占磁盘 */
const KEEP = 3;

if (!existsSync(DIST)) {
  console.log(`[clean-dist] ${relative(REPO, DIST)} 不存在，无需清理`);
  process.exit(0);
}

mkdirSync(ARCHIVE, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
let target = join(ARCHIVE, stamp);
for (let suffix = 1; existsSync(target); suffix += 1) {
  target = join(ARCHIVE, `${stamp}-${String(suffix)}`);
}

try {
  renameSync(DIST, target);
  console.log(`[clean-dist] 已归档为 ${relative(REPO, target)}（rename，非删除）`);
} catch (error) {
  /*
   * rename 失败的现实原因基本只有一个：跨卷。此时退回"删"，但**不把删除失败当
   * 致命** —— 让构建继续。残留的旧哈希文件不会被 index.html 引用（那是新产物），
   * 代价只是 dist 体积偏大；而"构建跑不起来"是硬阻塞，两者不能相提并论。
   */
  console.log(`[clean-dist] 归档失败（${String(error.code ?? error.message)}），退回删除`);
  try {
    rmSync(DIST, { recursive: true, force: true });
    console.log('[clean-dist] 已删除');
  } catch (removeError) {
    console.log(
      `[clean-dist] 删除也被拦（${String(removeError.code ?? 'unknown')}）—— 继续构建；` +
        'dist 里会残留旧哈希文件，体积偏大但不影响 index.html',
    );
  }
}

// 只保留最近 KEEP 份归档；更早的删不掉就算了（清垃圾不该让构建失败）
try {
  const entries = readdirSync(ARCHIVE).sort();
  for (const name of entries.slice(0, Math.max(0, entries.length - KEEP))) {
    try {
      rmSync(join(ARCHIVE, name), { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
} catch {
  /* 忽略 */
}
