/**
 * 右侧常驻的 SillyTavern 面板（v0.1.6 / T14.3 T14.4）。
 *
 * ## 它和四状态对话框的分工
 *
 * `st-dialog.ts` 回答"这台机器上 ST 在哪、要不要装、要不要启动"——**一次性**的配置流程。
 * 这个面板回答"我一边写卡一边看 ST 里的效果"——**常驻**的工作区。两者共用同一套
 * 判据（`st-install.ts`）与同一条推送链路（`st-push.ts`），不各写一份。
 *
 * ## 为什么是 iframe + 本地代理，不是直接嵌 ST 地址
 *
 * ST 的页面会被系统代理 / 安全软件挡住（这正是 F15 探针事件的现场：ST 在跑，
 * webview 里的请求根本没出浏览器网络层）。代理让请求从**壳**的 TCP 栈发出，
 * 绕开浏览器那条链路。详见 `release/T141-RISK-ASSESSMENT.md`。
 *
 * ## 三条刻意的设计
 *
 * 1. **iframe 地址只有一个来源**：壳返回的 `ProxyInfo.baseUrl`。渲染层不拼地址、
 *    不读配置里的 ST 地址来直连 —— 拼错的后果不是样式错位，而是"这扇窗指向别处"。
 *    `test/st-proxy.test.mjs` 用静态断言守这一条。
 * 2. **关闭即停代理**：面板收起 = 端口关掉。少一个长期监听的回环端口，
 *    也少一个"忘了关"的状态。
 * 3. **宽度是用户的，不是我们的**：拖宽 + 记忆。写卡区与聊天区该各占多少，
 *    只有用户自己知道（他会来回切）。
 */

import {
  clampPaneWidth,
  ST_PANE_COLLAPSED_WIDTH,
  ST_PANE_WIDTH_DEFAULT,
  ST_PANE_WIDTH_MAX,
  ST_PANE_WIDTH_MIN,
} from './st-pane-layout.ts';
import { nextCollapsed, paneWidthFor, toggleGlyph, toggleLabel } from './st-pane-collapse.ts';
import { diagnoseReachability, PROBE_PATH, REACHABILITY_GRACE_MS, verdictMessage } from './st-pane-lifecycle.ts';
import {
  decideReload,
  isStaleLoad,
  PROXY_DOWN_MESSAGE,
  PROXY_RESTARTED_NOTE,
  type ProxyHandle,
} from './st-pane-lifecycle.ts';

/**
 * 把抛出物压成一行可读文本（**给日志用**）。
 *
 * 为什么不用 `crash-log.ts` 里那个：那个会拼完整堆栈（多行），写进一行日志会把
 * 后续字段挤丢。诊断这一行要的是"哪个错误"，`name: message` 就够。
 */
function describeThrown(error: unknown): string {
  if (error instanceof Error) {
    return error.name === '' ? error.message : error.name + ': ' + error.message;
  }
  if (typeof error === 'string') return error;
  return String(error);
}

export interface StPaneCallbacks {
  /** 起代理，返回 iframe 唯一合法的地址（`port` 给存活探测用） */
  startProxy: () => Promise<{ baseUrl: string; target: string; port: number }>;
  /**
   * 停代理（面板收起 / 应用退出）。
   *
   * 必须带上"我以为我占着哪个端口"：迟到的停止请求不该杀掉后来新起的代理
   * （v0.1.6 生产缺陷二，见 `st-pane-lifecycle.ts` 顶部的时序说明）。
   */
  stopProxy: (port: number) => Promise<void>;
  /**
   * 某个回环端口还有没有人听（复用壳的 `probe_tcp`）。
   *
   * 为什么不用 iframe 的 `onerror`：跨源 iframe 的 load/error 事件在
   * 连不上时不保证触发，也拿不到原因 —— 判据必须落在"端口活没活"这件事上。
   */
  probePort: (port: number) => Promise<boolean>;
  /**
   * 问壳"代理端口进来过几条连接"（决定性诊断，见 `judgeReachability`）。
   *
   * 判据必须在壳侧：渲染层那次 fetch 失败正是"被拦"的表现，拿它判断等于循环论证。
   */
  queryProxyStats: () => Promise<{
    alive: boolean;
    /** 累计连接数（只作日志上下文，**不参与判定** —— 会被任何流量污染） */
    accepted: number;
    /** 自检探测被收到的累计次数；判定用它的**增量** */
    probeHits: number;
  }>;
  /**
   * 落 client-error.log（**不允许静默**）。
   *
   * 代理起不来的现场如果什么都不留，用户报"面板打不开"时我们只能猜。
   * 这条回调走契约 C8（永不抛、限速、轮转）。
   */
  logError: (line: string) => void;
  /** 读记住的宽度（C5 持久化；null = 没记过） */
  loadWidth: () => Promise<number | null>;
  /** 记宽度 */
  saveWidth: (width: number) => Promise<void>;
  /** 推当前卡；返回 null = 被闸门拦下 */
  push: () => Promise<{ fileName: string } | { error: string }>;
  /** 底部状态栏（与编辑器共用一条状态栏） */
  notify: (message: string, kind?: 'info' | 'ok' | 'warn' | 'bad') => void;
  /** 判断当前有没有打开的卡（没卡时推送按钮置灰） */
  hasCard: () => boolean;
  /** 打开四状态向导（安装 / 启动 / 换目录）—— 面板只管用，不管装 */
  openWizard: () => void;
  /**
   * 当前环境有没有壳能力。
   *
   * 面板自身不 import `isShellAvailable`：它要能在 Node 里被单测（那个函数
   * 一碰 `window` 就炸）。这条判断的意义见 `start()` 里的注释 ——
   * 「没有壳」与「代理坏了」必须说成两件事。
   */
  hasShell: () => boolean;
}

const COLLAPSED_CLASS = 'st-pane--collapsed';

/**
 * 面板。**懒构造**：顶栏按钮点一次才建，`start()` 才起代理。
 *
 * 构造时不碰任何壳能力 —— 打开应用就起一个代理是浪费，也违反
 * "不做静默动作"这条约定。
 */
export class StPane {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly frameHost: HTMLElement;
  private readonly badge: HTMLElement;
  private readonly targetText: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly pushButton: HTMLButtonElement;
  private readonly resizer: HTMLElement;
  private readonly toggleButton: HTMLButtonElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;

  /**
   * 代理地址。**iframe 的唯一地址来源** —— 全文件只有一处给它赋值
   * （`mountFrame` 的入参），也只有一处把它写进 `frame.src`。
   */
  private proxyOrigin = '';
  /**
   * 代理端口。`proxyOrigin` 用来设 src，端口用来做**存活探测** ——
   * 两者同源（都来自壳的 `ProxyInfo`），但探测只需要端口。
   */
  private proxyPort = 0;
  private frame: HTMLIFrameElement | null = null;
  private running = false;
  /**
   * 加载代次（epoch）。每次"关 / 开 / 重新加载"都 +1。
   *
   * 在途的 `decideReload` 走完时若代次已变，说明这次操作已被更晚的动作取代
   * （面板关了、或用户又点了一次），**不能再换 src** —— 否则晚到的旧结果会
   * 把新状态盖掉，表现为"关了面板又自己弹回来"或"重载后指向旧端口"。
   */
  private loadToken = 0;
  private busy = false;
  private width = ST_PANE_WIDTH_DEFAULT;
  private collapsed = false;
  private dragStart: { x: number; width: number } | null = null;

  constructor(private readonly callbacks: StPaneCallbacks) {
    this.root = document.createElement('aside');
    this.root.className = 'st-pane';
    this.root.id = 'st-pane';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'SillyTavern');

    // 拖宽的手柄：宽 5px 的一条竖线，视觉上藏在左边框里
    this.resizer = document.createElement('div');
    this.resizer.className = 'st-pane-resizer';
    this.resizer.setAttribute('role', 'separator');
    this.resizer.setAttribute('aria-orientation', 'vertical');
    this.resizer.title = '拖动调整宽度，双击复位';

    const header = document.createElement('div');
    header.className = 'st-pane-head';

    const title = document.createElement('div');
    title.className = 'st-pane-title';
    this.badge = document.createElement('span');
    this.badge.className = 'st-badge';
    this.badge.dataset['state'] = 'idle';
    this.badge.textContent = '未启动';
    this.targetText = document.createElement('span');
    this.targetText.className = 'st-pane-target';
    this.targetText.textContent = '—';
    title.append(this.badge, this.targetText);

    const actions = document.createElement('div');
    actions.className = 'st-pane-actions';
    /*
     * ↓ **不要**写成 `() => this.setCollapsed(true)`。
     *
     * 那样"收起/展开"共用一个按钮就必然坏：同一个按钮在两种状态下要做相反的事，
     * 而写死 true 等于告诉它"永远是收起"。真机就是这样 —— 收起后点「⟨」没反应
     * （它又收起了一次，界面当然没变化）。状态转换只允许走 `toggleCollapsed()`。
     */
    this.toggleButton = this.iconButton('收起', 'st-pane-toggle', () => this.toggleCollapsed());
    this.toggleButton.title = '收起 SillyTavern 面板（不影响代理）';
    this.refreshButton = this.iconButton('重新加载', 'st-pane-reload', () => void this.reload());
    this.closeButton = this.iconButton('×', 'st-pane-close', () => void this.close());
    this.closeButton.title = '关闭面板并停止本地代理';
    this.closeButton.setAttribute('aria-label', '关闭面板并停止本地代理');
    actions.append(this.refreshButton, this.toggleButton, this.closeButton);

    header.append(title, actions);

    this.hint = document.createElement('p');
    this.hint.className = 'st-pane-hint';
    this.hint.hidden = true;

    this.frameHost = document.createElement('div');
    this.frameHost.className = 'st-pane-frame';

    const footer = document.createElement('div');
    footer.className = 'st-pane-foot';
    this.pushButton = document.createElement('button');
    this.pushButton.type = 'button';
    this.pushButton.className = 'btn small';
    this.pushButton.textContent = '推送当前卡';
    this.pushButton.title = '把当前卡写成 PNG 角色卡放进 ST 的角色目录，然后刷新这个窗口';
    this.pushButton.addEventListener('click', () => void this.push());
    /*
     * 向导入口（v0.1.6 / T14.3）：面板自己**不做**安装与启动。
     *
     * 那两件事是"我这台机器上 ST 在哪、要不要下一份"的一次性决策，
     * 塞进这个常驻面板会把它的头部撑成一排按钮，而这排按钮 99% 的时间用不到。
     */
    const wizardButton = document.createElement('button');
    wizardButton.type = 'button';
    wizardButton.className = 'btn small ghost';
    wizardButton.dataset['role'] = 'st-pane-wizard';
    wizardButton.textContent = '安装 / 启动向导';
    wizardButton.title = '找不到 SillyTavern、或者它没在运行时用这里';
    wizardButton.addEventListener('click', () => this.callbacks.openWizard());
    footer.append(this.pushButton, wizardButton);

    this.body = document.createElement('div');
    this.body.className = 'st-pane-body';
    this.body.append(this.frameHost, footer);

    this.root.append(this.resizer, header, this.hint, this.body);

    this.wireResize();
    this.applyWidth(this.width);
  }

  /** 挂到布局里（`app.ts` 的 `start()` 里调一次） */
  mount(host: HTMLElement): void {
    host.append(this.root);
  }

  /**
   * 打开面板：显示 → **确认代理活着**（必要时拉起）→ 挂 iframe。
   *
   * 代理起不来时**不显示 iframe**（空白 iframe 会让人以为是 ST 的问题），
   * 而是把原因写进 `hint` 行 —— 那通常是"配置里的地址连不上"。
   *
   * 「已经开着」这一支也要验：`running` 只是渲染层的记忆，代理可能在别处
   * 已经没了。直接 return 就是现场那个"徽章绿、页面拒绝连接"的组合。
   */
  async open(): Promise<void> {
    this.root.hidden = false;
    if (this.collapsed) this.setCollapsed(false);
    if (this.running) {
      /*
       * 已经开着：**不重建 iframe**（重建会丢掉聊天状态），但必须确认代理
       * 还活着。活了就什么都不做；死了就交给 applyProxy 去拉起并换 src。
       */
      const alive = await this.callbacks.probePort(this.proxyPort).catch(() => false);
      if (alive) {
        this.syncPushState();
        return;
      }
      this.callbacks.logError(
        `[st-pane] 打开面板时代理端口 ${String(this.proxyPort)} 已不在监听，重新拉起`,
      );
    }
    await this.applyProxy('open');
  }

  /** 关掉面板并停代理（顶栏按钮切回来 / 关闭按钮） */
  async close(): Promise<void> {
    // 先作废在途的加载：否则它回来时还会去挂 iframe，表现为"关了又自己弹出来"
    this.loadToken += 1;
    this.root.hidden = true;
    await this.stop();
  }

  /** 顶栏按钮的行为：开着就收起，收起/关着就打开 */
  async toggle(): Promise<void> {
    if (!this.root.hidden && !this.collapsed) {
      this.setCollapsed(true);
      return;
    }
    await this.open();
  }

  /**
   * 重新加载面板（推送成功后自动调；也是「重新加载」按钮与所有兜底提示的出口）。
   *
   * **不再直接换 src**：旧实现 `if (proxyOrigin === '') return; mountFrame(...)`
   * 假定"地址在手 ⇒ 代理在跑"。现场证明这个假定会破 —— 用户看到的是
   * 「127.0.0.1 拒绝连接」+ 徽章「已连接」。现在一律先验代理存活
   * （见 `decideReload`）：死了先拉起，拉不起来就**不换 src**并给出提示。
   */
  async reload(): Promise<void> {
    const mounted = await this.applyProxy('reload');
    if (!mounted) return;
    this.callbacks.notify('已重新加载 SillyTavern 面板', 'info');
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** 收起后的条宽（给样式与截图验收读，避免 CSS 与 TS 各写一份） */
  static get collapsedWidth(): number {
    return ST_PANE_COLLAPSED_WIDTH;
  }

  /** 收起（顶栏按钮 / 截图调试入口用；不影响代理） */
  collapse(): void {
    this.setCollapsed(true);
  }

  /**
   * **收起态那个按钮的唯一入口**：点一下就是"反过来"。
   *
   * 面板内那个按钮在两种状态下显示不同的符号（收起/⟨），但动作必须是同一个
   * 转换函数 —— 谁也别在按钮回调里自己判断该往哪个方向走（真机缺陷四就是这么来的）。
   */
  toggleCollapsed(): void {
    this.setCollapsed(nextCollapsed(this.collapsed));
  }

  /** 当前是不是收起态（验收与调试入口读它，避免各自从 DOM 猜） */
  get isCollapsed(): boolean {
    return this.collapsed;
  }

  /** 当前生效的面板宽度（像素）—— 折叠时是条宽，展开时是记忆值 */
  get currentWidth(): number {
    return paneWidthFor(this.collapsed, this.width);
  }

  // ── 内部：起停 ────────────────────────────────────────────

  /**
   * 起/验代理，然后把地址交给 iframe。
   *
   * 「面板开着」这件事的唯一实现：`open()`、`reload()`、推送后的自动刷新
   * 全部走这里。**不要再有第二条"给 iframe 换地址"的路** —— 现场那个缺陷
   * 就是因为换地址的路不检查代理是否还活着。
   *
   * 返回 `true` = 页面已经（重新）挂上；`false` = 没换成，`hint` 已给出原因。
   */
  private async applyProxy(reason: 'open' | 'reload'): Promise<boolean> {
    const token = ++this.loadToken;
    this.setBadge('starting', '正在启动代理…');
    this.hint.hidden = true;
    try {
      const decision = await decideReload({
        current: this.currentHandle(),
        isAlive: (port) => this.callbacks.probePort(port),
        start: async () => {
          const info = await this.callbacks.startProxy();
          return { baseUrl: info.baseUrl, port: info.port, target: info.target };
        },
        log: (line) => this.callbacks.logError(line),
      });

      /*
       * 代次校验：await 期间面板可能被关掉、或用户又点了一次。
       * 晚到的结果一律丢弃 —— 否则会出现"关了又自己弹出来"、
       * 或"新代理起好了，界面却被旧结果指回死端口"。
       */
      if (isStaleLoad(token, this.loadToken)) return false;

      if (decision.kind === 'blocked') {
        this.showProxyDown(decision.message, decision.detail);
        return false;
      }

      this.proxyOrigin = decision.handle.baseUrl;
      this.proxyPort = decision.handle.port;
      this.targetText.textContent = decision.handle.target;
      this.mountFrame(this.proxyOrigin);
      this.running = true;
      this.hint.hidden = decision.note === '';
      if (decision.note !== '') this.hint.textContent = decision.note;
      this.setBadge('running', '已连接');
      /*
       * 挂上之后**再确认一次流量真的进来了**（v0.1.6 真机缺陷二）。
       *
       * 端口在听 ≠ 浏览器能连上：环境层（代理工具/安全软件/防火墙）拦掉回环时，
       * 端口照样 listen，而 webview 一条连接都发不出来 —— 用户看到的就是
       * Chromium 的「127.0.0.1 拒绝连接」，与本面板"已连接"徽章同时为真。
       * 判据只能是壳侧的 accept 计数，不能是渲染层那次 fetch。
       */
      void this.verifyReachability(token);
      return true;
    } catch (error) {
      if (isStaleLoad(token, this.loadToken)) return false;
      this.showProxyDown(PROXY_DOWN_MESSAGE, describe(error));
      return false;
    } finally {
      this.syncPushState();
    }
  }

  /**
   * 挂上 iframe 之后，回头问一次"流量到没到壳"。
   *
   * 0 条连接 ⇒ 请求从未离开浏览器网络层 ⇒ 这是**环境问题**，壳内怎么改都没用。
   * 这时候把"裸的拒绝连接"换成一句能照做的话，并落一条带 `webview-blocked`
   * 标记的日志（验收标准就是按这个标记判"环境性通过"）。
   */
  private async verifyReachability(token: number): Promise<void> {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, REACHABILITY_GRACE_MS);
    });
    if (isStaleLoad(token, this.loadToken)) return;

    /*
     * ── 先取基线，再探测，再看增量 ──
     *
     * 这一步的顺序是**判据本身**，不是实现细节：
     *
     *   1. 读一次 `probeHits`（基线）。不先读就没有"这一次"的概念；
     *   2. webview 对 `/__tcs_probe__` 发一次请求（`no-cors`，不要状态码 ——
     *      探测被代理直接应答，与 ST 好不好无关，所以失败只可能是"没到达壳"）；
     *   3. 再读一次，**增量**才是"webview 的请求有没有到达壳"。
     *
     * 为什么不能用累计的 accept 数：那个值任何流量都会把它顶上去，一次成功过就
     * 永远不为 0，判据立刻失真。2026-10-27 真机查证时我从壳外 `curl` 了两次
     * （都 200，为确认代理本身没问题），如果按累计值判定，用户的环境拦截就会被
     * 误报成"壳内转发故障"—— 方向全错。专用路径 + 增量把这个坑堵死。
     */
    const baseline = await this.callbacks.queryProxyStats().catch((): null => null);

    let webviewError = '';
    try {
      await fetch(this.proxyOrigin + PROBE_PATH, { mode: 'no-cors', cache: 'no-store' });
    } catch (error) {
      webviewError = describeThrown(error);
    }

    const after = await this.callbacks.queryProxyStats().catch((): null => null);
    if (isStaleLoad(token, this.loadToken)) return;

    const alive = after === null ? false : after.alive;
    const before = baseline === null ? 0 : baseline.probeHits;
    const now = after === null ? 0 : after.probeHits;
    const probeDelta = now - before;
    const accepted = after === null ? 0 : after.accepted;

    const verdict = diagnoseReachability({ webviewOk: webviewError === '', alive, probeDelta });

    /*
     * 一条日志写全现场的六个量：结论、探测增量、累计连接、存活、端口、webview 侧错误。
     *
     * 上一次真机复发时日志是**空的** —— 因为诊断自己静默失败了（`queryProxyStats`
     * 抛错被 catch 吞掉、`alive === false` 被判成 unknown 直接 return，两条路都不写）。
     * 所以现在除了 `reachable`（每次开面板都落会刷屏）之外，**每个分支都落**。
     */
    if (verdict !== 'reachable') {
      const parts = [
        '[st] reachability verdict=' + verdict,
        'probeDelta=' + String(probeDelta),
        'probeHits=' + String(now),
        'accepted=' + String(accepted),
        'alive=' + String(alive),
        'port=' + String(this.proxyPort),
        'baseUrl=' + this.proxyOrigin,
        'webviewError=' + (webviewError === '' ? '(none)' : webviewError),
      ];
      if (baseline === null || after === null) parts.push('statsReadFailed=true');
      this.callbacks.logError(parts.join(' '));
    }

    const message = verdictMessage(verdict);
    if (message !== null) {
      this.setBadge('failed', verdict === 'webview-blocked' ? '被环境拦截' : '代理异常');
      this.hint.hidden = false;
      this.hint.textContent = message;
    }
  }

  /**
   * 代理没起来时的面板状态。
   *
   * 「没有壳」和「代理坏了」必须说成两句不同的话：浏览器里调 `stProxyStart`
   * 会抛 `Cannot read properties of undefined (reading 'invoke')`，直接把这句
   * 抛给用户，他会去查网络、查权限、查 ST 是不是没开，全都白费力气
   * （F15 时期踩过同一个坑）。真正的原因是"你在浏览器里，这条能力不存在"。
   *
   * **不换 src**：把死地址交给 iframe 只会得到一个 Chromium 错误页，
   * 那比空白更误导 —— 用户会以为是 ST 挂了。
   */
  private showProxyDown(message: string, detail: string): void {
    this.running = false;
    this.hint.hidden = false;
    if (!this.callbacks.hasShell()) {
      this.setBadge('failed', '仅桌面客户端');
      this.hint.textContent =
        '浏览器里没有本地代理能力：请用桌面客户端打开这个面板。' +
        '（浏览器里仍可以用「导出…」生成 PNG 卡，再手动放进 ST 的角色目录。）';
      this.callbacks.notify('ST 面板需要桌面客户端', 'warn');
      return;
    }
    this.setBadge('failed', '启动失败');
    this.hint.textContent = `${message}（${detail}）`;
    this.callbacks.notify(`ST 面板：${message}`, 'bad');
  }

  /** 面板当前认为自己在用的代理（可能指向一个已经没人听的端口） */
  private currentHandle(): ProxyHandle | null {
    if (this.proxyPort === 0 || this.proxyOrigin === '') return null;
    return {
      baseUrl: this.proxyOrigin,
      port: this.proxyPort,
      target: this.targetText.textContent ?? '',
    };
  }

  private async stop(): Promise<void> {
    const port = this.proxyPort;
    this.running = false;
    this.proxyOrigin = '';
    this.proxyPort = 0;
    this.frame = null;
    this.frameHost.replaceChildren();
    this.setBadge('idle', '未启动');
    this.hint.hidden = true;
    // 没起过代理就别发停止请求：0 号端口不是通配，发出去也只是空转
    if (port === 0) return;
    try {
      await this.callbacks.stopProxy(port);
    } catch (error) {
      // 停不掉不影响用户（进程退出时也会收），但要知道发生过 ——
      // "停止失败"是排查端口泄漏时唯一的第一手线索
      this.callbacks.logError(`[st-pane] 停止代理失败（端口 ${String(port)}）：${describe(error)}`);
    }
  }
  /**
   * 挂一个 iframe。
   *
   * **换元素而不是改 src**：同一个 URL 重新赋值在部分浏览器里不会重新导航，
   * 那样"推送完了界面没变"会让人以为推送失败。换元素是确定性的。
   */
  private mountFrame(proxyOrigin: string): void {
    const frame = document.createElement('iframe');
    frame.className = 'st-frame';
    // 允许 ST 用剪贴板按钮（它的"复制"按钮要这个权限），但不要它弹新窗口
    frame.setAttribute('allow', 'clipboard-write');
    frame.title = 'SillyTavern';
    /*
     * ↓ 全文件唯一的 iframe 地址赋值。地址只能来自壳（`ProxyInfo.baseUrl`）：
     * 渲染层拼地址的后果不是"打不开"，而是"这扇窗指向了别处"。
     */
    frame.src = proxyOrigin;
    this.frameHost.replaceChildren(frame);
    this.frame = frame;
  }

  private async push(): Promise<void> {
    if (this.busy || !this.callbacks.hasCard()) return;
    this.busy = true;
    this.pushButton.disabled = true;
    this.pushButton.textContent = '正在推送…';
    try {
      const result = await this.callbacks.push();
      if ('error' in result) {
        this.callbacks.notify(result.error, 'bad');
        return;
      }
      this.callbacks.notify('已推送为 PNG · 在 ST 中 F5 刷新可见', 'ok');
      // 刷新信号（T14.4）：推完立刻重载，用户在同一个窗口里就能看到新卡
      // fire-and-forget：推送本身已经成功，刷新失败不该把成功改判成失败
      void this.reload();
    } finally {
      this.busy = false;
      this.syncPushState();
    }
  }

  private syncPushState(): void {
    const enabled = !this.busy && this.callbacks.hasCard() && this.running;
    this.pushButton.disabled = !enabled;
    if (!this.busy) this.pushButton.textContent = '推送当前卡';
    this.pushButton.title = enabled
      ? '把当前卡写成 PNG 角色卡放进 ST 的角色目录，然后刷新这个窗口'
      : this.running
        ? '先打开一张卡'
        : '等代理起来再推送';
  }

  // ── 内部：宽度 / 折叠 ────────────────────────────────────

  /** 读记住的宽度并应用（`app.start()` 里调一次，不阻塞界面） */
  async restoreWidth(): Promise<void> {
    try {
      const saved = await this.callbacks.loadWidth();
      if (saved !== null && Number.isFinite(saved)) {
        this.applyWidth(saved);
      }
    } catch {
      // 读不到就用默认宽度：宽度记忆是舒适度，不是功能
    }
  }

  /**
   * **`--st-pane-width` 的唯一写入点。**
   *
   * 折叠与拖拽都会改变"面板该多宽"，但派生逻辑只许有一份：折叠时是条宽、
   * 展开时是记忆值。两处各写一遍的下场是"折叠态被拖宽撑回展开宽度"这类
   * 只在特定顺序下出现的问题。
   */
  private writeWidth(): void {
    const width = paneWidthFor(this.collapsed, this.width);
    this.root.style.setProperty('--st-pane-width', `${String(width)}px`);
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.root.classList.toggle(COLLAPSED_CLASS, collapsed);
    /*
     * 宽度变量是**唯一来源**：`.st-pane` 的 `width` 读它，grid 的第三列是 `auto`。
     *
     * 折叠就是把它换成条宽 —— 不在 CSS 里再写一条 grid 规则（两处各写一份宽度
     * 必然分叉，而分叉的表现只是"右边多留一片空白"）。
     */
    this.writeWidth();

    /*
     * 折叠后只剩一条竖边，中文按钮放不下 —— 换成符号。
     * `title` / `aria-label` 保留完整说法：符号只是视觉压缩，不是信息丢失。
     *
     * 这一段**只能有一处**：第一版下面还留着一对旧赋值（`'展开' : '收起'`），
     * 把符号覆盖回去了 —— 截图上是"折叠条里竖排着『展开』两个字"，
     * 而代码读起来完全正常（后写的赢）。
     */
    this.toggleButton.textContent = toggleGlyph(collapsed);
    // title 与 aria-label 取自同一个函数：两处各写一份，改文案时必有一处漏掉
    const label = toggleLabel(collapsed);
    this.toggleButton.title = collapsed ? label : `${label}（不影响代理）`;
    this.toggleButton.setAttribute('aria-label', label);
    this.refreshButton.textContent = collapsed ? '↻' : '重新加载';
    this.refreshButton.title = collapsed
      ? '重新加载 SillyTavern 面板'
      : '重新加载（推送后无需手动点，这里用于卡住时）';
    this.closeButton.textContent = '×';
  }

  private applyWidth(width: number): void {
    // 折叠时别覆盖成展开宽度：否则拖一下就把 44px 的条撑回 460，
    // 而用户以为自己拖的是"展开后有多宽"
    if (this.collapsed) {
      this.width = clampPaneWidth(width);
      return;
    }
    // 钳制只有一处实现（`st-pane-layout.ts`）：拖拽、键盘、记忆回填都走它，
    // 免得"拖出来 200px、下次打开变 320"这种前后不一致
    this.width = clampPaneWidth(width);
    this.writeWidth();
    this.resizer.setAttribute('aria-valuenow', String(this.width));
  }

  private wireResize(): void {
    const onMove = (event: PointerEvent): void => {
      const start = this.dragStart;
      if (start === null) return;
      // 面板贴右边：往左拖 = 变宽
      this.applyWidth(start.width + (start.x - event.clientX));
    };
    const onUp = (): void => {
      if (this.dragStart === null) return;
      this.dragStart = null;
      document.body.classList.remove('st-pane-resizing');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      void this.callbacks.saveWidth(this.width).catch(() => {
        // 存不下就存不下，下次用默认宽度；不该因此弹错
      });
    };

    this.resizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      this.dragStart = { x: event.clientX, width: this.width };
      document.body.classList.add('st-pane-resizing');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });

    // 双击复位：拖歪了总得有条退路
    this.resizer.addEventListener('dblclick', () => {
      this.applyWidth(ST_PANE_WIDTH_DEFAULT);
      void this.callbacks.saveWidth(this.width).catch(() => undefined);
    });

    // 键盘可调：只靠鼠标的拖拽条对键盘用户等于不存在
    this.resizer.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 40 : 10;
      if (event.key === 'ArrowLeft') {
        this.applyWidth(this.width + step);
      } else if (event.key === 'ArrowRight') {
        this.applyWidth(this.width - step);
      } else {
        return;
      }
      event.preventDefault();
      void this.callbacks.saveWidth(this.width).catch(() => undefined);
    });
    this.resizer.tabIndex = 0;
    this.resizer.setAttribute('aria-valuemin', String(ST_PANE_WIDTH_MIN));
    this.resizer.setAttribute('aria-valuemax', String(ST_PANE_WIDTH_MAX));
    this.resizer.setAttribute('aria-valuenow', String(this.width));
  }

  private setBadge(state: string, text: string): void {
    this.badge.dataset['state'] = state;
    this.badge.textContent = text;
  }

  private iconButton(label: string, role: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn small ghost st-pane-icon';
    button.dataset['role'] = role;
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '未知错误';
}
