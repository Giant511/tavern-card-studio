/**
 * 开屏等待（v0.1.7 / 第九批）。
 *
 * ## 用户的原话
 *
 * > 如果是冷启动，那为什么不在启动的时候放一个开屏跑进度条的动画
 * > （符合APP的UI风格），配字就写正在加载世界中，等ST服务稳定
 * > 然后再尝试读取配置（依然有重试机制）进入聊天页
 *
 * ## 这组测试守什么
 *
 * 1. **阶段判定顺序**：先判成功再判进度（否则就绪时 `unpacked=true`
 *    会被判成"还在解包"，永远进不去）
 * 2. **进度只进不退**（阶段是离散采样，引擎写标记有延迟，来回跳会抖）
 * 3. **三个出口都要通**：就绪 / 超时 / 引擎明确失败 —— 尤其
 *    **超时不能把用户关在开屏里**
 * 4. **没有引擎桥的平台直接放行**（浏览器预览 / 桌面端）
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { describeBootPhase, phaseOf, phasePercent, waitForEngine } from '@tcs/shared';

const ROOT = join(import.meta.dirname, '..');

/* ═══════════════════════════════════════════════════════════
   ① 阶段判定
   ═══════════════════════════════════════════════════════════ */

test('★★★ 先判"就绪"再判"解包"（否则永远进不去）', () => {
  /*
   * 就绪状态下 `unpacked` 也是 true。若先判 `!unpacked`，
   * 一个**已经就绪**的引擎会被判成"还在解包" ⇒ 开屏永远不结束。
   *
   * 这是判定顺序 bug 的典型形态：每个条件单看都对，顺序错了就死循环。
   */
  const ready = phaseOf({ running: true, ready: true, unpacked: true, error: null });
  assert.equal(ready, 'ready');

  /*
   * ★ 边界：`ready: true` 但 `unpacked: false`。
   *
   * 现实里这两个标记由不同路径写入（`ready` 来自探活缓存、
   * `unpacked` 来自解包完成标记），**写入有时序差**。
   * 已经能应答了却还报"没解包"是可能的。
   *
   * 判据：能应答就是能进 —— 不许因为一个辅助标记的延迟把人卡在开屏。
   *
   * 这条用例是变异验证逼出来的：只有加它之后，
   * "把 `ready` 判断挪到 `unpacked` 之后"这个变异才会被捕获。
   * 没有它的时候那条变异**全绿通过**（两个条件在常见输入下等价）。
   */
  const edge = phaseOf({ running: true, ready: true, unpacked: false, error: null });
  assert.equal(edge, 'ready', 'ready 优先于 unpacked（标记写入有时序差）');
});

test('★ 没解包 → unpacking', () => {
  assert.equal(
    phaseOf({ running: false, ready: false, unpacked: false, error: null }),
    'unpacking',
  );
});

test('★ 已解包、进程在跑、但端口未应答 → connecting', () => {
  assert.equal(
    phaseOf({ running: true, ready: false, unpacked: true, error: null }),
    'connecting',
  );
});

test('★ 已解包、进程还没起 → starting', () => {
  assert.equal(
    phaseOf({ running: false, ready: false, unpacked: true, error: null }),
    'starting',
  );
});

test('★★ 拿不到引擎桥（非 Android）→ 直接 ready', () => {
  /*
   * 浏览器预览 / 桌面端没有 `__ST_ENGINE__`。那些环境里 ST 是用户
   * 自己在外面起的 —— 卡在开屏等于把功能锁死。
   */
  assert.equal(phaseOf(null), 'ready');
});

/* ═══════════════════════════════════════════════════════════
   ② 进度与文案
   ═══════════════════════════════════════════════════════════ */

test('★ 进度单调递增（除了失败归零）', () => {
  const order = ['unpacking', 'starting', 'connecting', 'ready'];
  const values = order.map((p) => phasePercent(p));
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(
      values[i] > values[i - 1],
      `进度必须递增：${order[i - 1]}=${String(values[i - 1])} 应小于 ${order[i]}=${String(values[i])}`,
    );
  }
  assert.equal(phasePercent('ready'), 100);
  /*
   * 失败不给 100：进度条满了会让"失败"看起来像"完成了"。
   */
  assert.notEqual(phasePercent('failed'), 100);
});

test('★ 每个阶段都有文案，且不含开发术语', () => {
  const phases = ['unpacking', 'starting', 'connecting', 'ready', 'failed'];
  for (const phase of phases) {
    const text = describeBootPhase(phase);
    assert.ok(text.length > 0, `${phase} 要有文案`);
    /*
     * 文案红线：不能出现实现词汇。
     * 这条与 `scripts/verify-ui-copy.mjs` 是同一套标准，这里只守
     * 最容易漏的几个词（那支脚本扫全库，但开屏是新文件）。
     */
    for (const banned of ['ST', '引擎', 'SillyTavern', 'API', '进程', '端口']) {
      assert.equal(
        text.includes(banned),
        false,
        `${phase} 的文案不该出现「${banned}」：${text}`,
      );
    }
  }
});

/* ═══════════════════════════════════════════════════════════
   ③ 等待的三个出口
   ═══════════════════════════════════════════════════════════ */

test('★★ 引擎立刻就绪 → 马上返回 ok', async () => {
  const result = await waitForEngine({
    intervalMs: 1,
    timeoutMs: 1000,
    probe: () => ({ running: true, ready: true, unpacked: true, error: null }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.phase, 'ready');
});

test('★★ 先没就绪、第三次就绪 → 会等到就绪', async () => {
  let calls = 0;
  const seen = [];
  const result = await waitForEngine({
    intervalMs: 1,
    timeoutMs: 2000,
    probe: () => {
      calls += 1;
      return {
        running: calls < 3,
        ready: calls >= 3,
        unpacked: true,
        error: null,
      };
    },
    onPhase: (phase) => seen.push(phase),
  });
  assert.equal(result.ok, true);
  assert.ok(calls >= 3, `应该轮询到第 3 次，实际 ${String(calls)}`);
  assert.ok(seen.includes('starting') || seen.includes('connecting'), '阶段应该有变化');
});

test('★★★ 超时必须返回（不能把用户关在开屏里）', async () => {
  /*
   * 引擎一直不就绪时，`waitForEngine` 必须**在时限内返回**。
   * 不返回 = 开屏永远转圈 = 用户只能杀进程。
   */
  const started = Date.now();
  const result = await waitForEngine({
    intervalMs: 5,
    timeoutMs: 60,
    probe: () => ({ running: true, ready: false, unpacked: true, error: null }),
  });
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  assert.equal(result.reason, '等待超时');
  assert.ok(elapsed < 2000, `必须在 2 秒内返回，实际 ${String(elapsed)}ms`);
});

test('★★ 引擎明确失败（进程没了 + 有错）→ 提前收工，不空等', async () => {
  /*
   * 实测过场景：引擎起不来（MuMu 上那个 houdini 缺陷）。
   * 那种情况等满 90 秒纯属浪费 —— 用户盯着不动的进度条更焦虑。
   */
  const started = Date.now();
  const result = await waitForEngine({
    intervalMs: 5,
    timeoutMs: 60_000,
    probe: () => ({
      running: false,
      ready: false,
      unpacked: true,
      error: '引擎启动后立即退出（退出码 1）',
    }),
  });
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  assert.equal(result.phase, 'failed');
  assert.match(result.reason ?? '', /退出码/);
  assert.ok(elapsed < 2000, `应该立刻返回，实际等了 ${String(elapsed)}ms`);
});

test('★ 进程没起但**还没报错**时不许判失败（启动最初一瞬间就是这状态）', async () => {
  /*
   * `running === false` 单独不足以判失败：引擎刚 spawn 出来的头几十毫秒
   * 也是 false。必须有 `error` 才算"明确失败"。
   * 这里用超时收尾，验证它**没有**提前跳 failed。
   */
  const result = await waitForEngine({
    intervalMs: 5,
    timeoutMs: 40,
    probe: () => ({ running: false, ready: false, unpacked: true, error: null }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, '等待超时', '没有 error 就不该判成引擎失败');
});

/* ═══════════════════════════════════════════════════════════
   ④ 接线：函数对了但没接上，等于没做
   ═══════════════════════════════════════════════════════════ */

test('★★★ `boot()` 必须先开屏等引擎，再挂 shell', () => {
  /*
   * 顺序反了（先挂 shell 再等）的后果：用户先看到空聊天页
   * （「未选择聊天 / 还没有对话」），几秒后内容才冒出来 ——
   * 正是用户报"记录丢了"的那个画面。
   */
  const main = readFileSync(join(ROOT, 'client/src/mobile/main.ts'), 'utf8');
  const boot = main.slice(main.indexOf('async function boot()'));

  const splashAt = boot.indexOf('new BootSplash');
  const waitAt = boot.indexOf('waitForEngine(');
  const mountAt = boot.indexOf('shell.mount(');

  assert.ok(splashAt > 0, 'boot 里要建开屏');
  assert.ok(waitAt > splashAt, '建完开屏才等引擎');
  assert.ok(mountAt > waitAt, '等完引擎才挂 shell（顺序反了用户会先看到空聊天页）');
});

test('★★ 开屏失败也要放行（三种结局都往下走）', () => {
  const main = readFileSync(join(ROOT, 'client/src/mobile/main.ts'), 'utf8');
  const boot = main.slice(main.indexOf('async function boot()'), main.indexOf('shell.mount('));

  /* 失败分支要有提示，且提示里要有"先进去"这类可操作指引 */
  assert.match(boot, /if \(!waited\.ok\)/, '要处理失败');
  assert.match(boot, /setHint\(/, '失败要给提示');
  assert.match(boot, /先进去/, '提示要告诉用户可以先进去（而不是卡在开屏）');
});

test('★ 开屏文案含"正在加载世界"（用户点名的配字）', () => {
  const splash = readFileSync(join(ROOT, 'client/src/mobile/boot-splash.ts'), 'utf8');
  assert.match(splash, /正在加载世界/, '用户明确要求这句话');
});

test('★★ 开屏样式一个裸色值都没有（全部走 --nb-* 变量）', () => {
  /*
   * 写死色值换主题时会变成一块突兀的色块。
   * 这条与 `chat.css` 文件头的纪律同源（"本文件一个裸色值都没有"）。
   */
  const css = readFileSync(join(ROOT, 'client/src/chat/chat.css'), 'utf8');
  const block = css.slice(css.indexOf('.nb-splash {'), css.indexOf('.nb-splash-hint'));

  const hardcoded = block.match(
    /(?:color|background|border-color)\s*:\s*(?:#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/g,
  );
  assert.equal(
    hardcoded,
    null,
    `开屏样式里不许有裸色值：${JSON.stringify(hardcoded)}`,
  );
});
