/**
 * ST 面板的代理生命周期（纯逻辑，v0.1.6 生产缺陷二）。
 *
 * ## 现场
 *
 * 徽章写着「已连接 127.0.0.1:8000」，iframe 里却是 Chromium 的
 * 「127.0.0.1 拒绝连接」——**探针通、代理端口没人听**。
 * 这两个信号来自两条完全独立的链路：徽章走 `probe_tcp` 探 ST 自己，
 * iframe 走壳起的本地代理。它们同时为真，说明"面板以为代理在，其实没了"。
 *
 * 追下来有两条都能造成这个组合，而且都需要堵：
 *
 * 1. **记录在、监听器已死**。壳的 `ProxyState` 存的是"我们以为在跑的代理"，
 *    监听器活在另一个 task 里；那个 task 退出后端口就释放了，记录还在。
 *    旧 `st_proxy_start` 见到记录就直接返回它的地址 ⇒ 死地址。
 * 2. **迟到的停止杀掉了新代理**。`st_proxy_stop` 原先"take 走当前那条"：
 *    关面板的 stop 还没执行，开面板的 start 已经占位，stop 一执行就把**新**的杀了。
 *
 * ## 这个模块负责什么
 *
 * 只负责一件事：**在换 iframe 地址之前，确定那个端口真的有人听**。
 * 判定顺序（`decideReload`）：
 *
 * ```
 * 有记录 → 探端口 → 活 → 用它（不重启，保住页面里的聊天状态）
 *              → 死 → 记日志 → 重新起 → 再探一次 → 活 → 用新的
 * 无记录 → 起 → 再探一次 → 活 → 用新的
 * 任何一步不通 → blocked（**不换 src**，给一句能动手的话）
 * ```
 *
 * ## 为什么"探两次"
 *
 * 第一次探用来判断"要不要重启"，第二次探紧贴 `frame.src = …` 之前 ——
 * 两者之间有一个真实的窗口（探测要走一趟 IPC；期间代理可能刚好退出，
 * 或者用户刚好关了面板）。**只探一次的版本在窗口内必然误判**，
 * 而误判的后果就是现场那张截图。第二次探是这个缺陷真正的修复点，
 * 所以 `test/st-pane-lifecycle.test.mjs` 专门用"注入延迟"钉它。
 *
 * 调用方还要守一条：`decideReload` 是 async 的，await 期间面板可能被关掉，
 * 所以要配合 epoch 守卫（`loadToken`）—— 见 `StPane` 的实现。
 */

export interface ProxyHandle {
  /** iframe 唯一合法地址（壳给的 `ProxyInfo.baseUrl`） */
  baseUrl: string;
  /** 探测用的端口（与 baseUrl 同源，单列出来是因为探测只需要端口） */
  port: number;
  /** 代理指向的 ST 地址，面板上如实显示 */
  target: string;
}

export type ReloadDecision =
  | {
      kind: 'mount';
      handle: ProxyHandle;
      /** 这次是不是重新起过一个代理（日志与提示要用） */
      restarted: boolean;
      /** 人能看到的一句话（不重启时不打扰用户） */
      note: string;
    }
  | {
      kind: 'blocked';
      /** 面板上显示的那句话 —— 必须能动手（点重新加载） */
      message: string;
      /** 写进 client-error.log 的细节 */
      detail: string;
    };

export interface ReloadDeps {
  /** 面板当前持有的代理（可能为 null，也可能指向一个已经死掉的端口） */
  current: ProxyHandle | null;
  /** 端口还有人听吗（复用壳的 `probe_tcp`：同进程探测，不受系统代理干扰） */
  isAlive: (port: number) => Promise<boolean>;
  /** 起代理（壳内单例；重复调用返回同一端口） */
  start: () => Promise<ProxyHandle>;
  /** 落 client-error.log（**不允许静默**） */
  log: (line: string) => void;
}

/** 面板上那句兜底提示。写成常量是因为验收脚本与测试都要按原文断言。 */
export const PROXY_DOWN_MESSAGE = '本地代理未启动，点「重新加载」重试';

/** 重启之后的那句 info（用户要知道"为什么页面刷了一下"） */
export const PROXY_RESTARTED_NOTE = '本地代理已重启，正在重新加载 SillyTavern 面板';

function describeThrown(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * 决定这一次"重新加载 / 打开面板"能不能把地址交给 iframe。
 *
 * 纯逻辑：所有 IO 都从 `deps` 注入，没有 DOM、没有计时器。
 */
export async function decideReload(deps: ReloadDeps): Promise<ReloadDecision> {
  const tried: string[] = [];
  let handle = deps.current;
  let restarted = false;

  // ① 有记录先验一次：活着就别动它（重启会丢掉页面里的聊天状态）
  if (handle !== null) {
    const alive = await deps.isAlive(handle.port).catch((error: unknown) => {
      tried.push(`探测端口 ${String(handle?.port)} 失败：${describeThrown(error)}`);
      return false;
    });
    if (!alive) {
      tried.push(`端口 ${handle.port} 没人听（记录还在，监听器已退出）`);
      deps.log(
        `[st-pane] 代理端口 ${String(handle.port)} 已不在监听（baseUrl=${handle.baseUrl}），重新起一个`,
      );
      handle = null;
    }
  }

  // ② 没有可用记录就起一个
  if (handle === null) {
    try {
      handle = await deps.start();
      restarted = true;
    } catch (error) {
      const detail = describeThrown(error);
      tried.push(`起代理失败：${detail}`);
      deps.log(`[st-pane] 起代理失败：${detail}`);
      return {
        kind: 'blocked',
        message: PROXY_DOWN_MESSAGE,
        detail: tried.join('；'),
      };
    }
  }

  /*
   * ③ **紧贴换 src 之前的二次确认**。
   *
   * 这一趟不是"多此一举"：从 ② 到调用方真的赋值 `frame.src` 之间隔着一次
   * await 返回与事件循环，期间代理可能刚好退出。少这一趟，缺陷会以
   * "偶发、复现不了"的形态长期存在。
   */
  const finalAlive = await deps.isAlive(handle.port).catch((error: unknown) => {
    tried.push(`二次探测端口 ${String(handle?.port)} 失败：${describeThrown(error)}`);
    return false;
  });
  if (!finalAlive) {
    tried.push(`刚起的端口 ${handle.port} 又没了（或从未监听上）`);
    deps.log(
      `[st-pane] 代理端口 ${String(handle.port)} 二次探测仍未监听，放弃换 src（不把死地址交给 iframe）`,
    );
    return {
      kind: 'blocked',
      message: PROXY_DOWN_MESSAGE,
      detail: tried.join('；'),
    };
  }

  return {
    kind: 'mount',
    handle,
    restarted,
    note: restarted ? PROXY_RESTARTED_NOTE : '',
  };
}

/**
 * epoch 守卫：async 走完回来时，这次操作还算不算数。
 *
 * 面板被关掉 / 又开了一次 / 用户又点了重新加载 —— 这三种情况都该让在途的
 * 那次"换 src"作废。否则晚到的结果会覆盖新的界面状态（典型的生命周期竞态）。
 *
 * 抽成纯函数是为了能直接测"晚到的旧 token 必须被拒"这条，而不必驱动 DOM。
 */
export function isStaleLoad(token: number, current: number): boolean {
  return token !== current;
}


// ── 可达性判定（v0.1.6 真机缺陷二：环境拦截 vs 壳内故障）────────

/**
 * 判定结论。**六种，互斥且完备**，因为下一步动作各不相同：
 *
 * | 结论 | 含义 | 该做什么 |
 * |---|---|---|
 * | `reachable` | 两侧都通 | 什么都不做 |
 * | `webview-blocked` | webview 请求失败 + 壳 0 条连接 | 请求没离开浏览器 ⇒ 环境（安全软件/代理工具） |
 * | `shell-broken` | webview 请求失败 但 壳收到过连接 | 流量到了壳、转发失败 ⇒ 查壳内 |
 * | `counting-broken` | webview 请求成功 但 壳 0 条连接 | **计数或对应关系坏了**，不是环境问题 |
 * | `proxy-down` | 代理监听器已经不在 | 生命周期问题（另有一条提示） |
 * | `unknown` | 拿不到信息 | 不断言 |
 *
 * 最后那个 `counting-broken` 是刻意的：**它防的是"把自己的 bug 说成用户环境的问题"**。
 * 一旦自检请求真的成功了、壳却说自己没收到连接，那就是我们记错了，而不是用户该去改安全软件。
 */
export type ReachabilityVerdict =
  | 'reachable'
  | 'webview-blocked'
  | 'shell-broken'
  | 'counting-broken'
  | 'proxy-down'
  | 'unknown';

/**
 * 面板上那句环境指引（真机缺陷二 / 2026-10-27 复发）。
 *
 * 上一版写的是「你的网络代理拦截了本机回环地址…请在代理工具里把 127.0.0.1 加入直连白名单」。
 * 真机查证后要修正两处，否则用户照做也解决不了：
 *
 * 1. **不一定是"代理工具"**：现场系统代理是关的（`ProxyEnable = 0`），真正在拦的是
 *    安全软件的 WFP 驱动（火绒 `hrwfpdrv`）。只提"代理工具"会让人去改错的软件。
 * 2. **要给出程序名**：这类拦截绝大多数是**按进程**放行/阻止，只说"把 127.0.0.1 加入白名单"
 *    在按进程的规则里无处可填 —— 用户得在列表里找到 `msedgewebview2.exe`。
 */
export const WEBVIEW_BLOCKED_MESSAGE =
  '本机回环被拦截：把 msedgewebview2.exe 与 127.0.0.1 加入安全软件/代理工具的直连白名单，' +
  '再点「重新加载」';

/**
 * 「请求到了壳、但 webview 仍然读不到」的提示。
 *
 * 与上面那句**必须分开**：这一条说明请求已经到达本地代理，用户网络没问题。
 * 原来这里写的是「确认 ST 已在运行、地址填对了」—— 2026-10-27 的实测证明那个
 * 方向是错的：ST 一直在跑、地址也对，真正的原因是**响应头策略**
 * （`X-Frame-Options` 让 iframe 不显示、`Cross-Origin-Resource-Policy` 让
 * 跨源 `no-cors` 读取失败）。两者都不影响连通性，所以"去查 ST"是白费力气。
 *
 * 这一格落在"我们需要日志"上，而不是给用户一个错误的动作。
 */
export const SHELL_BROKEN_MESSAGE =
  '请求已到达本地代理，但页面仍没能读出来：请把 client-error.log 发给维护者（多半是响应头策略）';

/**
 * 「计数对不上」的提示。
 *
 * 自检请求成功、壳却报 0 条连接 ⇒ 是我们的诊断记错了。**不要**把这个说成环境问题
 * （那会让用户白改一通安全软件），也不要静默 —— 明说，并把两侧数字带上。
 */
export const COUNTING_BROKEN_MESSAGE =
  '面板自检与代理计数不一致（自检请求成功，代理却记 0 条连接）：这是诊断计数的问题，' +
  '请把这个现象反馈给维护者';

/**
 * 面板自检的探测路径。**必须与 Rust 侧 `proxy::PROBE_PATH` 逐字相同**
 * （`test/st-pane-lifecycle.test.mjs` 里有一条拿源码对拍的断言）。
 *
 * 两边各写一份字面量是刻意的：它们分属两个编译单元（TS 渲染层 / Rust 壳），
 * 没有共享常量的机制；靠测试对拍比靠"记得同步"可靠。
 */
export const PROBE_PATH = '/__tcs_probe__';

/** 挂上 iframe 之后等多久再判定（首屏资源要时间；太早会误判） */
export const REACHABILITY_GRACE_MS = 2500;

/**
 * 综合两侧证据给出结论。
 *
 * **为什么两侧都要**：单看任何一侧都定不了性。
 *   · 只看壳侧计数（`accepted === 0`）——分不清"请求没发出"和"我们计数坏了"；
 *   · 只看 webview 的 fetch 结果——那次失败恰恰是被拦的表现，用它下结论是循环论证。
 * 两侧一夹，四种组合各自只有一个解释。
 *
 * `webviewOk` 的语义是"**那次自检请求没有抛异常**"（`mode: 'no-cors'` 下拿不到状态码，
 * 也不该拿 —— 上游 503 时代理仍然正常应答过，说明链路是通的）。
 */
export function diagnoseReachability(input: {
  /** webview 侧对探测路径发过一次请求，有没有抛异常 */
  webviewOk: boolean;
  /** 代理监听器是否还活着 */
  alive: boolean;
  /**
   * 探测计数的**增量**（探测后 - 探测前），不是累计值。
   *
   * 用增量的原因见 `PROBE_PATH` 那边：累计的 `accepted` 会被任何流量污染，
   * 一次成功过就永远不为 0，判据会在第二次打开面板时失效。
   * 增量只可能由**这一次**探测产生，因果关系是一对一。
   */
  probeDelta: number;
}): ReachabilityVerdict {
  if (!input.alive) return 'proxy-down';
  if (input.webviewOk) return input.probeDelta > 0 ? 'reachable' : 'counting-broken';
  return input.probeDelta > 0 ? 'shell-broken' : 'webview-blocked';
}

/** 结论 → 面板提示。`reachable` / `unknown` / `proxy-down` 由调用点另作处理，返回 null。 */
export function verdictMessage(verdict: ReachabilityVerdict): string | null {
  switch (verdict) {
    case 'webview-blocked':
      return WEBVIEW_BLOCKED_MESSAGE;
    case 'shell-broken':
      return SHELL_BROKEN_MESSAGE;
    case 'counting-broken':
      return COUNTING_BROKEN_MESSAGE;
    default:
      return null;
  }
}
