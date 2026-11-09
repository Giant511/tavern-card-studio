/**
 * 端口段不重叠（2026-10-30）—— 守的是"并行测试互相踩端口"这类噪音。
 *
 * ## 这条测试治什么
 *
 * `node --test test/*.test.mjs` 是**按文件并行**的。每个起真服务的测试文件
 * 都自己挑一段随机端口，而控制端口是 `port + 1`。只要两个文件的范围相交，
 * 并行跑就有概率撞上 `EADDRINUSE`。
 *
 * 实测到的重叠（加这条测试之前）：
 *
 *   account-purge   27400–27700（控制端口到 27701）
 *   repo-transfer   27500–27800（控制端口到 27801）  ← 与上一条相交
 *   trash-prune     27100–27400（控制端口到 27401）  ← 压到 account-purge 的起点
 *
 * 症状是「这次全绿、下次红」，跑单文件又永远绿 —— 最难查的一类。
 *
 * ## 为什么用断言而不是"记得分配"
 *
 * 靠人记住"别撞端口"必然会忘（这张表本身就会越来越长）。
 * 把规则写成断言之后，**新增一个测试文件时如果不小心用了重叠范围，
 * 这条测试当场红**，而不是等到某次并行跑出现随机失败。
 *
 * 同一件事只写一遍：范围从源码里**扫描**，不维护第二份清单。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const TEST_DIR = import.meta.dirname;

/**
 * 从源码里扫出每个文件声明的端口段。
 *
 * 匹配两种写法（仓库里就是这两种）：
 *   `port = 27400 + Math.floor(Math.random() * 300)`
 *   `const PORT = 19100 + Math.floor(Math.random() * 300)`
 *
 * 只认 `Math.random() * N` 这种随机段；写死单端口的（如固定 18000）跳过，
 * 因为写死的端口冲突会在第一次运行时就暴露、不会伪装成随机噪音。
 */
function collectRanges() {
  const ranges = [];
  for (const file of readdirSync(TEST_DIR)) {
    if (!file.endsWith('.test.mjs')) continue;
    if (file === 'port-ranges.test.mjs') continue; // 自己不算
    const text = readFileSync(join(TEST_DIR, file), 'utf8');
    const re = /(?:const\s+)?\w*[Pp][Oo][Rr][Tt]\w*\s*=\s*(\d+)\s*\+\s*Math\.floor\(\s*Math\.random\(\)\s*\*\s*(\d+)\s*\)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const base = Number(m[1]);
      const span = Number(m[2]);
      // 控制端口是 port + 1，所以实际占用的上界要 +1
      ranges.push({ file, base, end: base + span + 1 });
    }
  }
  return ranges.sort((a, b) => a.base - b.base);
}

test('★ 各测试文件的随机端口段互不重叠（含 port+1 的控制端口）', () => {
  const ranges = collectRanges();

  // 先自证扫描是有效的：一个都没扫到说明正则失效了，
  // 那时"没有重叠"是假绿 —— 必须当成失败。
  assert.ok(
    ranges.length >= 5,
    `只扫到 ${String(ranges.length)} 个端口段，正则可能失效了（不应静默通过）`,
  );

  const overlaps = [];
  for (let i = 1; i < ranges.length; i += 1) {
    const prev = ranges[i - 1];
    const cur = ranges[i];
    if (cur.base <= prev.end) {
      overlaps.push(
        `${prev.file} [${String(prev.base)}–${String(prev.end)}] 与 ` +
          `${cur.file} [${String(cur.base)}–${String(cur.end)}] 重叠`,
      );
    }
  }

  assert.deepEqual(
    overlaps,
    [],
    `端口段重叠会在并行跑时偶发 EADDRINUSE（且单文件跑永远绿）：\n  ${overlaps.join('\n  ')}`,
  );
});

test('端口段整体落在测试专用区间（不与常见服务端口挤在一起）', () => {
  /*
   * 下限保护：随手写个 8000 / 3000 之类的段，会与本机可能真在跑的服务撞。
   * 19000 以上是常见做法（IANA 动态端口从 49152 起，19000–29000 区间基本没人用）。
   */
  for (const r of collectRanges()) {
    assert.ok(
      r.base >= 19000,
      `${r.file} 的端口段起点 ${String(r.base)} 太低，容易碰到本机真实服务`,
    );
    assert.ok(
      r.end <= 32000,
      `${r.file} 的端口段上界 ${String(r.end)} 太高，可能落进系统动态端口区间`,
    );
  }
});
