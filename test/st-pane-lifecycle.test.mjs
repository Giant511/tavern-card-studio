/**
 * 代理生命周期（v0.1.6 生产缺陷二）的回归。
 *
 * ## 现场
 *
 * 徽章「已连接 127.0.0.1:8000」+ iframe「127.0.0.1 拒绝连接」。
 * 徽章走 ST 探针，iframe 走本地代理 —— 两条独立链路同时为真，说明
 * "面板以为代理在，其实没了"。
 *
 * ## 这一组测试守什么
 *
 * 1. **四轮开→关→开→重载**，每轮断言"要挂时端口在听"、"关掉后端口已释放"。
 *    这条钉的是"生命周期与面板状态绑定"（用户要求 6a）。
 * 2. **存活检查与 src 赋值之间注入延迟**。这是缺陷真正的修复点：
 *    只探一次的实现在这个窗口里必然误判，`decideReload` 的二次确认才能挡住。
 * 3. **起不来不换 src**（6b）：blocked 分支必须给出可动手的提示，
 *    而不是把死地址交给 iframe。
 * 4. **失败必须留痕**（6c）：每一次 blocked 都要有一条 log。
 *
 * 全部用假依赖（假代理管理器 + 假探针），不需要 Tauri 壳、不需要真端口；
 * 端口是否真的在听由"假管理器"如实记账 —— 判据是**调用序列**，不是时序巧合。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

import {
  COUNTING_BROKEN_MESSAGE,
  decideReload,
  diagnoseReachability,
  isStaleLoad,
  PROXY_DOWN_MESSAGE,
  PROBE_PATH,
  PROXY_RESTARTED_NOTE,
  REACHABILITY_GRACE_MS,
  SHELL_BROKEN_MESSAGE,
  verdictMessage,
  WEBVIEW_BLOCKED_MESSAGE,
} from '../client/src/session/st-pane-lifecycle.ts';

/**
 * 假代理管理器：忠实模拟壳的语义。
 *
 * · `start()` 幂等 —— 已有一个在跑就返回它（这是壳的真实行为，也是
 *   "重复调 start 不会换端口"那条契约）；
 * · `stop(port)` **只停端口对得上的那个**（决策 #234）—— 迟到的停止请求是空操作；
 * · `listening` 直接决定探针结果，所以"端口在听/已释放"是可断言的。
 */
function makeProxyManager(options = {}) {
  const state = {
    /** 当前在跑的代理（null = 没在跑） */
    running: null,
    /** 有史以来分配过的端口，用来验证"不换端口" */
    allocated: [],
    started: 0,
    stopped: [],
    /** 每个端口的"在听"状态 */
    listening: new Map(),
    /** 被忽略的停止请求（端口对不上） */
    skippedStops: [],
  };

  const manager = {
    state,
    start: async () => {
      // 幂等：已有一个**还活着**的代理就返回它（壳的真实语义）
      if (state.running !== null && state.listening.get(state.running.port) === true) {
        return state.running;
      }
      // 记录在、监听器已死 → 壳会摘掉那条记录重新起（决策 #234 的第一半）
      state.running = null;
      if (options.startFails === true) throw new Error('起本地代理失败：拒绝访问');
      const port = 49152 + state.allocated.length;
      const handle = { baseUrl: `http://127.0.0.1:${port}`, port, target: '127.0.0.1:8000' };
      state.allocated.push(port);
      state.listening.set(port, true);
      state.running = handle;
      state.started += 1;
      return handle;
    },
    stop: async (port) => {
      const running = state.running;
      if (running === null) return;
      if (running.port !== port) {
        // 迟到的停止请求：什么都不做（这正是修复）
        state.skippedStops.push({ requested: port, current: running.port });
        return;
      }
      state.listening.set(running.port, false);
      state.stopped.push(running.port);
      state.running = null;
    },
    probe: async (port) => state.listening.get(port) === true,
    /** 模拟"监听器自己死了"（端口释放，但记录还在 —— 现场那种分叉） */
    killListener: () => {
      const running = state.running;
      if (running === null) return;
      state.listening.set(running.port, false);
      // 记录**故意留着**：壳的 ProxyState 也会留着
    },
  };
  return manager;
}

function makeDeps(manager, overrides = {}) {
  const logs = [];
  const deps = {
    current: null,
    isAlive: (port) => manager.probe(port),
    start: () => manager.start(),
    log: (line) => logs.push(line),
    ...overrides,
  };
  return { deps, logs };
}

/** 让出一轮事件循环（模拟 IPC 往返） */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── ① 四轮生命周期 ─────────────────────────────────────────

test('四轮 开→关→开→重载：每轮端口在听，关掉后已释放', async () => {
  const manager = makeProxyManager();
  let current = null;

  for (let round = 1; round <= 4; round += 1) {
    const { deps, logs } = makeDeps(manager, { current });

    const opened = await decideReload(deps);
    assert.equal(opened.kind, 'mount', `第 ${String(round)} 轮：打开面板应当挂上页面`);
    if (opened.kind !== 'mount') return;

    // 要挂上去的那个端口必须真的在听（这是"不把死地址交给 iframe"的唯一判据）
    assert.equal(
      await manager.probe(opened.handle.port),
      true,
      `第 ${String(round)} 轮：要挂的端口 ${String(opened.handle.port)} 不在听`,
    );
    current = opened.handle;

    // 关面板：只停自己那个端口
    await manager.stop(current.port);
    assert.equal(
      await manager.probe(current.port),
      false,
      `第 ${String(round)} 轮：关掉面板后端口 ${String(current.port)} 仍在听（泄漏）`,
    );
    current = null;
    assert.deepEqual(logs, [], `第 ${String(round)} 轮不该有错误日志，实际：${logs.join('|')}`);
  }

  // 四轮共起过 4 次代理，且每次换新端口（端口由内核分配，不复用旧值）
  assert.equal(manager.state.started, 4);
  assert.equal(manager.state.stopped.length, 4);
  assert.equal(manager.state.skippedStops.length, 0, '正常顺序下不该有被忽略的停止请求');
});

test('四轮里第 3 轮模拟"监听器自己死了"：重载必须先拉起再换 src', async () => {
  const manager = makeProxyManager();
  const first = await decideReload(makeDeps(manager).deps);
  assert.equal(first.kind, 'mount');
  if (first.kind !== 'mount') return;

  // 记录还在，但端口没人听了 —— 现场那种分叉
  manager.killListener();
  const deadPort = first.handle.port;
  assert.equal(await manager.probe(deadPort), false);

  const { deps, logs } = makeDeps(manager, { current: first.handle });
  const reloaded = await decideReload(deps);

  assert.equal(reloaded.kind, 'mount');
  if (reloaded.kind !== 'mount') return;
  assert.notEqual(reloaded.handle.port, deadPort, '死端口不能原样交回去');
  assert.equal(reloaded.restarted, true, '这种情形必须标记为"重启过"');
  assert.equal(await manager.probe(reloaded.handle.port), true);
  assert.ok(
    logs.some((line) => line.includes(`端口 ${String(deadPort)}`)),
    `死端口必须留痕，实际日志：${logs.join('|')}`,
  );
});

// ── ② 竞态：存活检查与 src 赋值之间注入延迟 ──────────────────

test('竞态：探活通过、但换 src 之前端口没了 → 必须 blocked（不许挂死地址）', async () => {
  const manager = makeProxyManager();
  const opened = await manager.start();

  /*
   * 第一次探活会返回 true（端口确实在听），然后我们**在探活与提交之间**
   * 把监听器杀掉 —— 这正是现场那个窗口。`decideReload` 的第二次探活
   * 必须抓到它；只探一次的实现在这里会返回 mount，然后用户看到
   * 「127.0.0.1 拒绝连接」。
   */
  let probes = 0;
  const { deps, logs } = makeDeps(manager, {
    current: opened,
    isAlive: async (port) => {
      probes += 1;
      const alive = await manager.probe(port);
      if (probes === 1) {
        manager.killListener(); // 探活之后、提交之前的那一下
      }
      return alive;
    },
  });

  const decision = await decideReload(deps);

  assert.equal(decision.kind, 'blocked', '端口在窗口里没了，绝不能再挂上去');
  if (decision.kind !== 'blocked') return;
  assert.equal(decision.message, PROXY_DOWN_MESSAGE);
  assert.match(decision.message, /重新加载/, '提示必须给出下一步动作');
  assert.ok(probes >= 2, `必须探两次（实际 ${String(probes)} 次）—— 只探一次必漏这个窗口`);
  assert.ok(
    logs.some((line) => line.includes('二次探测')),
    `二次探测失败必须留痕，实际日志：${logs.join('|')}`,
  );
});

test('竞态：延迟期间代理被关掉又重开 → 晚到的旧结果不许覆盖新状态', async () => {
  const manager = makeProxyManager();

  /*
   * 模拟面板真实时序：一个 decideReload 在途（被延迟卡住），
   * 期间 close()+open() 把代次推了两次。旧的那次回来时代次已经变了，
   * 调用方据此丢弃结果 —— 这就是 `isStaleLoad`。
   */
  const tokenAtStart = 7;
  let token = tokenAtStart;

  const pending = decideReload({
    ...makeDeps(manager).deps,
    isAlive: async () => {
      await tick();
      return true;
    },
  });

  // 用户在这期间关了面板、又开了一次
  token += 2;

  const decision = await pending;
  assert.equal(decision.kind, 'mount');
  assert.equal(
    isStaleLoad(tokenAtStart, token),
    true,
    '晚到的旧代次必须被判为过期 —— 否则关了的面板会自己弹回来',
  );
  assert.equal(isStaleLoad(token, token), false, '当前代次不该被判过期');
});

// ── ③ 起不来：不换 src，但要给得出原因并留痕 ──────────────────

test('起代理失败：blocked + 留痕 + 提示可动手（不静默）', async () => {
  const manager = makeProxyManager({ startFails: true });
  const { deps, logs } = makeDeps(manager);

  const decision = await decideReload(deps);
  assert.equal(decision.kind, 'blocked');
  if (decision.kind !== 'blocked') return;
  assert.equal(decision.message, PROXY_DOWN_MESSAGE);
  assert.match(decision.detail, /拒绝访问/, '原始错误要带在 detail 里，不能只说"失败"');
  assert.ok(logs.length >= 1, '起代理失败必须落 client-error.log（要求 6c）');
  assert.match(logs[0], /起代理失败/);
});

test('没有记录也能起（首次打开面板）', async () => {
  const manager = makeProxyManager();
  const decision = await decideReload(makeDeps(manager).deps);
  assert.equal(decision.kind, 'mount');
  if (decision.kind !== 'mount') return;
  assert.equal(decision.restarted, true);
  assert.equal(decision.note, PROXY_RESTARTED_NOTE, '首次起代理也要告诉用户"页面为什么刷了"');
});

test('代理还活着就不重启（保住页面里的聊天状态）', async () => {
  const manager = makeProxyManager();
  const opened = await manager.start();
  const startedBefore = manager.state.started;

  const decision = await decideReload(makeDeps(manager, { current: opened }).deps);
  assert.equal(decision.kind, 'mount');
  if (decision.kind !== 'mount') return;
  assert.equal(decision.handle.port, opened.port, '不许换端口 —— 换端口等于整页重载');
  assert.equal(decision.restarted, false);
  assert.equal(decision.note, '', '没重启就不要打扰用户');
  assert.equal(manager.state.started, startedBefore, '不该再起一个');
});

// ── ④ 迟到的停止请求（壳侧语义的 TS 侧镜像）───────────────────

test('迟到的停止请求：端口对不上就空操作，不会杀掉新代理', async () => {
  const manager = makeProxyManager();
  const oldHandle = await manager.start(); // 面板上一轮用的代理
  await manager.stop(oldHandle.port); // 面板关闭，正常停掉
  const newHandle = await manager.start(); // 面板又开，新代理

  // 上一条 stop 的 IPC 迟到，带着旧端口
  await manager.stop(oldHandle.port);

  assert.equal(
    await manager.probe(newHandle.port),
    true,
    '新代理被迟到的停止请求杀掉了 —— 这正是现场那个组合的来源',
  );
  assert.deepEqual(manager.state.skippedStops, [{ requested: oldHandle.port, current: newHandle.port }]);
});

// ── ⑤ 可达性：六态判定（真机缺陷二，2026-10-27 复发后重写）──────

/*
 * 为什么从两态改成六态：真机复发时日志**是空的**，因为旧实现只有
 * `alive && accepted === 0 → blocked` 一条路会落东西，其余分支静默返回。
 * 而"静默"正是这个项目反复吃亏的地方 —— 用户看到问题，日志里什么都没有，
 * 于是只能猜。
 *
 * 新判据两侧都要：
 *   · webview 侧那次自检请求抛没抛异常（请求有没有离开浏览器）
 *   · 壳侧 accept 计数（壳有没有收到）
 * 四种组合各自只有一个解释，再加上"代理死了"就是五态；
 * `unknown` 留给"拿不到信息"。
 */

test('webview 请求失败 + 壳 0 条连接 → 环境拦截（请求没离开浏览器）', () => {
  // 真机那个组合：代理 listen 成功，webview 一条连接都发不出来
  assert.equal(
    diagnoseReachability({ webviewOk: false, alive: true, probeDelta: 0 }),
    'webview-blocked',
  );
});

test('webview 请求成功 + 壳有连接 → 可达', () => {
  assert.equal(diagnoseReachability({ webviewOk: true, alive: true, probeDelta: 1 }), 'reachable');
  assert.equal(diagnoseReachability({ webviewOk: true, alive: true, probeDelta: 2 }), 'reachable');
});

test('webview 请求失败 但 壳收到过连接 → 壳内转发问题，不是环境问题', () => {
  /*
   * 这一格是旧两态实现**判不出来的**：它只要 accepted > 0 就说 reachable，
   * 于是"流量到了壳、转发失败"会被报成一切正常，用户继续看着打不开的页面。
   */
  assert.equal(
    diagnoseReachability({ webviewOk: false, alive: true, probeDelta: 1 }),
    'shell-broken',
  );
});

test('webview 请求成功 但 壳 0 条连接 → 是计数坏了，不许说成环境问题', () => {
  /*
   * 这是最该防的误判方向：把自己的 bug 说成用户环境的问题，会让用户去改安全软件、
   * 白折腾一遍，问题还在。宁可承认"我们记错了"。
   */
  assert.equal(
    diagnoseReachability({ webviewOk: true, alive: true, probeDelta: 0 }),
    'counting-broken',
  );
});

test('代理自己没跑 → proxy-down（不判"被拦"，那是另一个问题）', () => {
  assert.equal(diagnoseReachability({ webviewOk: false, alive: false, probeDelta: 0 }), 'proxy-down');
  assert.equal(diagnoseReachability({ webviewOk: false, alive: false, probeDelta: 1 }), 'proxy-down');
  assert.equal(diagnoseReachability({ webviewOk: true, alive: false, probeDelta: 1 }), 'proxy-down');
});

test('shell-broken 的提示不许把用户指向 ST（实测方向是响应头策略）', () => {
  /*
   * 原来那句是「确认 ST 已在运行、设置里的地址填对了」。2026-10-27 实测：ST 一直在跑、
   * 地址也对，真因是 `X-Frame-Options` / `Cross-Origin-Resource-Policy` 这类
   * **响应头策略** —— 不影响连通性。给用户一个错的动作用处不如要一份日志。
   */
  assert.doesNotMatch(SHELL_BROKEN_MESSAGE, /ST 已在运行|地址填对|先启动/);
  assert.match(SHELL_BROKEN_MESSAGE, /client-error\.log/, '要告诉用户给什么');
  assert.match(SHELL_BROKEN_MESSAGE, /响应头|策略/, '要说出"这不是网络问题"');
});

test('三句提示各自对应一种结论，不许混用', () => {
  assert.equal(verdictMessage('webview-blocked'), WEBVIEW_BLOCKED_MESSAGE);
  assert.equal(verdictMessage('shell-broken'), SHELL_BROKEN_MESSAGE);
  assert.equal(verdictMessage('counting-broken'), COUNTING_BROKEN_MESSAGE);
  // 不需要提示的结论返回 null（否则会把"一切正常"也画成错误）
  assert.equal(verdictMessage('reachable'), null);
  assert.equal(verdictMessage('proxy-down'), null);
  assert.equal(verdictMessage('unknown'), null);
  // 三句话必须彼此不同 —— 混用等于把三种不同动作说成一句话
  const all = new Set([WEBVIEW_BLOCKED_MESSAGE, SHELL_BROKEN_MESSAGE, COUNTING_BROKEN_MESSAGE]);
  assert.equal(all.size, 3, '三种结论的提示文案不能重复');
});

test('环境指引：要能指出改哪个程序，而不只是"把 127.0.0.1 加白名单"', () => {
  /*
   * 上一版写的是「在代理工具里把 127.0.0.1 加入直连白名单」。真机查证后要改：
   * 现场系统代理是关的（`ProxyEnable = 0`），拦的是安全软件的 WFP 驱动；
   * 而且按进程放行的规则里"填 127.0.0.1"无处可填 —— 用户得在列表里找进程名。
   */
  assert.match(WEBVIEW_BLOCKED_MESSAGE, /127\.0\.0\.1/);
  assert.match(WEBVIEW_BLOCKED_MESSAGE, /msedgewebview2/, '必须点名要放行的进程');
  assert.match(WEBVIEW_BLOCKED_MESSAGE, /白名单|直连/, '必须给出可照做的动作');
  assert.match(WEBVIEW_BLOCKED_MESSAGE, /安全软件|防火墙|代理/, '不能只说"代理工具"');
  assert.match(WEBVIEW_BLOCKED_MESSAGE, /重新加载/, '改完之后要告诉用户点哪里');
  assert.ok(WEBVIEW_BLOCKED_MESSAGE.length <= 90, '面板只有一条提示行，别写成长文');
});

test('宽限期是正数且足够首屏资源加载（太早会误判成被拦）', () => {
  assert.ok(REACHABILITY_GRACE_MS >= 1000, `宽限期 ${String(REACHABILITY_GRACE_MS)}ms 太短`);
  assert.ok(REACHABILITY_GRACE_MS <= 10000, '太长会让用户等不到结论');
});

// ── ⑥ 探测路径两边必须逐字一致（TS 与 Rust 各写一份字面量）──────

test('面板探测路径与壳里的 PROBE_PATH 逐字相同', () => {
  /*
   * 两边各写一份字面量是刻意的：TS 渲染层与 Rust 壳属两个编译单元，没有共享常量
   * 的机制。但"记得同步"不可靠 —— 一旦不一致，探测会打到 ST 的真实路径上，
   * 表现为"计数永远不涨"，于是环境拦截会被误报成"壳内故障"。
   * 所以拿源码对拍，而不是靠人记。
   */
  const rust = readFileSync(join(ROOT, 'client', 'src-tauri', 'src', 'proxy.rs'), 'utf8');
  const m = /pub const PROBE_PATH: &str = "([^"]+)";/.exec(rust);
  assert.notEqual(m, null, 'Rust 里找不到 PROBE_PATH');
  assert.equal(PROBE_PATH, m[1], 'TS 与 Rust 的探测路径必须逐字相同');
  assert.match(PROBE_PATH, /^\/__[a-z_]+__$/, '探测路径要在 ST 不可能用到的命名空间里');
});

test('代理对探测路径直答、不转发（否则 ST 挂了会污染"能不能到达壳"）', () => {
  const rust = readFileSync(join(ROOT, 'client', 'src-tauri', 'src', 'proxy.rs'), 'utf8');
  const fnStart = rust.indexOf('async fn forward(');
  const fnBody = rust.slice(fnStart, fnStart + 2000);
  assert.match(fnBody, /req\.uri\(\)\.path\(\) == PROBE_PATH/, 'forward 必须先判探测路径');
  assert.match(fnBody, /record_probe\(\)/, '探测要单独计数');
  // 探测分支必须在 connect_upstream 之前 return，否则还是会去连 ST
  const probeAt = fnBody.indexOf('PROBE_PATH');
  const connectAt = fnBody.indexOf('connect_upstream');
  assert.ok(probeAt !== -1 && connectAt !== -1 && probeAt < connectAt, '探测必须在连上游之前返回');
});

test('判据用增量而不是累计值（累计会被任何流量污染）', () => {
  /*
   * 这一条是 2026-10-27 真机现场直接换来的：为了确认代理本身正常，我从壳外
   * `curl` 了两次（都 200）。如果判据看累计 accept 数，用户的"环境拦截"
   * 就会被误判成"壳内转发故障"——方向全错，而且看起来还很有道理。
   */
  const pane = stripComments(readFileSync(join(ROOT, 'client', 'src', 'session', 'st-pane.ts'), 'utf8'));
  const body = pane.slice(pane.indexOf('private async verifyReachability'));
  const fn = body.slice(0, body.indexOf('\n  }\n'));
  assert.match(fn, /const baseline = await this\.callbacks\.queryProxyStats\(\)/, '必须先取基线');
  assert.match(fn, /const probeDelta = now - before/, '必须用增量');
  assert.match(
    fn,
    /diagnoseReachability\(\{ webviewOk: [^}]*probeDelta/,
    '判定必须吃 probeDelta，不能吃 accepted',
  );
  const judgeCall = /diagnoseReachability\(\{([^}]*)\}\)/.exec(fn);
  assert.notEqual(judgeCall, null);
  assert.doesNotMatch(judgeCall[1], /accepted/, 'accepted 只能进日志，不能进判据');
});
