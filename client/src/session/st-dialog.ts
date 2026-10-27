/**
 * 「在 SillyTavern 中测试」面板（v0.1.5 / F15 · T13.3–T13.6）。
 *
 * 一个面板装四个状态（需求 T13.6 要求"状态栏文案按状态机走，不共享同一句模糊提示"）：
 *
 *   missing        没检测到 ST      → 安装指引 + 一键安装（显式点击）
 *   installed-idle 装了但没运行      → 问「帮你启动 SillyTavern？」
 *   running        正在运行          → 可推送
 *   pushed         推完了           → 打开 ST 看看
 *
 * 几条刻意的设计：
 *   · **不静默下载、不静默启动**：下载与启动都只由按钮触发，且按钮上的字
 *     直接说明会发生什么（"一键安装 1.13.2"、"启动 SillyTavern"）；
 *   · **失败不吞**：启动失败时把 `st-launch.log` 的尾部（ST 自己的报错）贴出来，
 *     再给常见原因清单；下载失败给 HTTP 原文，不自动重试；
 *   · **状态是算出来的，不是记下来的**：`currentState()` 每次从
 *     `verdict / running / pushedFile` 推导，避免"界面说运行中、其实早退出了"；
 *   · **推的是 PNG 不是 JSON**（v0.1.5 / G8）：ST 的角色目录扫描只认 PNG，
 *     JSON 只有走界面「导入角色卡」才生效 —— 详见 `st-install.ts` 的
 *     `ST_PUSH_EXTENSION` 与决策 #212。
 *
 * 与编辑器的耦合只有三个回调（角色名、PNG 推送产物、记忆路径），
 * 所以这个类可以在 Node 里被间接测到（纯逻辑都在 `st-install.ts`）。
 */

import {
  appendClientErrorLog,
  configGet,
  configPatch,
  extractZipTo,
  findStCandidates,
  isShellAvailable,
  openExternal,
  openFolder,
  pickDirectory,
  probeCardsDir,
  probePaths,
  probeTcp,
  readTextExact,
  scanCardsDir,
  spawnDetached,
  writeBinaryFileAtomic,
  type ShellError,
} from '../contract';
import { fileNameOf, joinPath } from './cards-path.ts';
import { resolveStAddress, type StAddressOk } from './st-address.ts';
import {
  chooseLaunchTarget,
  describeLaunchFailure,
  describeProbe,
  judgeStInstall,
  locateSt,
  nodeInstallCandidates,
  probeStState,
  stCharactersDir,
  stDownloadUrl,
  stInstallTargetDir,
  stStatusText,
  ST_LAUNCH_FAILURE_HINTS,
  ST_RELEASE,
  tailOfLog,
  toBase64Chunked,
  waitForStReady,
  type StInstallVerdict,
  type StProbeResult,
  type StState,
} from './st-install.ts';
import { pushCardToSt } from './st-push.ts';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 下载体积上限：ST release zip 约 40~80 MB，超过这个数说明地址不对（或撞上了镜像页） */
const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;

export interface StDialogCallbacks {
  /** 状态栏 / 提示（文案由调用方的状态机决定，这里只转发） */
  notify: (message: string, kind?: 'ok' | 'warn' | 'bad' | 'info') => void;
  /** 当前卡的角色名（决定推送文件名） */
  getCardName: () => string;
  /**
   * 生成要推过去的**PNG 角色卡** + 摘要 + 卡面来源。
   *
   * **复用导出管线**（需求 T13.5："复用，不新写序列化"）：返回 null 表示被闸门拦下
   * （世界书会丢内容那种硬阻断），此时不该推送。
   *
   * 为什么是 PNG 而不是 JSON —— 见 `st-install.ts` 的 `ST_PUSH_EXTENSION` 注释
   * （G8：ST 1.18 的文件夹扫描只认 PNG；JSON 只能靠 UI 手动导入）。
   */
  buildStPush: () => Promise<{
    bytes: Uint8Array;
    sha256: string;
    fileName: string;
    face: { from: 'source' | 'library' | 'default'; fileName: string | null; note: string };
  } | null>;
  /** 记住用户选过的 ST 目录（C5 持久化） */
  rememberPath: (path: string) => Promise<void>;
  /** 下载地址覆盖（仅截图/端到端用） */
  downloadUrlOverride?: string | null;
}

export class StDialog {
  private overlay: HTMLDivElement | null = null;
  private stateBadge: HTMLElement | null = null;
  private stateText: HTMLElement | null = null;
  private locationText: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private footerNote: HTMLElement | null = null;

  /** 当前认定（null = 没装） */
  private verdict: StInstallVerdict | null = null;
  /** 端口 8000 是否可达（以及为什么不通） */
  private running = false;
  /** 最近一次探测的完整结论（诊断与文案都用它） */
  private probe: StProbeResult | null = null;
  /**
   * 当前使用的 ST 地址（v0.1.6 / T14.0）。
   *
   * 从配置读一次、缓存在这里：面板打开期间地址不该变（设置面板关闭时会
   * 重新检测），而每次动作前都 `configGet()` 会让"点推送"多一次 IPC 往返。
   * `refresh()` 是唯一的写入点 —— 保证"面板看到的地址"与"探测用的地址"同源。
   */
  private address: StAddressOk = resolveStAddress(null);
  /** 最近一次推送的文件名（非 null 即"推送完成"状态） */
  private pushedFile: string | null = null;
  /** 最近一次推送用的卡面来源（"推送完成"面板里如实显示） */
  private pushedFaceNote = '';
  /** 目录里遗留的旧版 JSON 推送（只做一行灰字提示，不弹错误框） */
  private staleJsonNote = '';
  /** 正在执行动作（按钮全禁用，避免连点两次启动两个 ST） */
  private busy = false;
  /** 检测出来的主目录（一键安装的落点在它下面） */
  private home: string | null = null;
  /** 最近一次失败的原因展示区 */
  private errorBox: HTMLElement | null = null;
  /** 最近一次启动的日志落点（"打开日志文件夹"用） */
  private lastLogPath: string | null = null;
  /**
   * 一键安装卡在"没找到 Node"这一步。
   *
   * 必须记成状态而不是当场往 body 里塞一块 DOM：`install()` 的 finally 会调
   * `render()`，而 render 是按状态整块重建 body 的 —— 直接塞进去的那块
   * 会在同一帧里被清掉（症状是"点了按钮什么都没发生"，且控制台无报错）。
   */
  private nodeMissing = false;

  constructor(private readonly callbacks: StDialogCallbacks) {}

  get isOpen(): boolean {
    return this.overlay !== null;
  }

  /** 打开面板并开始检测 */
  async open(): Promise<void> {
    if (this.overlay !== null) {
      await this.refresh();
      return;
    }

    const overlay = el('div', 'modal-overlay');
    const panel = el('div', 'modal st-panel');
    panel.dataset['role'] = 'st-panel';

    const head = el('div', 'modal-head');
    head.append(el('h2', 'modal-title', '在 SillyTavern 中测试'));
    const closeButton = el('button', 'btn ghost small', '关闭');
    closeButton.type = 'button';
    closeButton.addEventListener('click', () => this.close());
    head.append(closeButton);

    const body = el('div', 'modal-body st-body');

    const stateRow = el('div', 'st-state');
    const badge = el('span', 'st-badge', '检测中');
    const stateText = el('span', 'st-state-text', '正在检测本地 SillyTavern…');
    stateRow.append(badge, stateText);

    const locationRow = el('div', 'st-location');
    const locationLabel = el('span', 'st-location-label', '安装位置');
    const locationText = el('span', 'st-location-path', '自动检测中…');
    const pickButton = el('button', 'btn small', '换一个…');
    pickButton.type = 'button';
    pickButton.dataset['role'] = 'st-pick-dir';
    pickButton.addEventListener('click', () => void this.pickDir());
    const rescanButton = el('button', 'btn small ghost', '重新检测');
    rescanButton.type = 'button';
    rescanButton.dataset['role'] = 'st-rescan';
    rescanButton.addEventListener('click', () => void this.refresh());
    locationRow.append(locationLabel, locationText, pickButton, rescanButton);

    const stateBody = el('div', 'st-state-body');
    const errorBox = el('div', 'st-error');
    errorBox.hidden = true;
    const note = el('p', 'st-note');

    body.append(stateRow, locationRow, stateBody, errorBox, note);
    panel.append(head, body);
    overlay.append(panel);
    document.body.append(overlay);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) this.close();
    });
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape' && this.overlay !== null) this.close();
      },
      { once: true },
    );

    this.overlay = overlay;
    this.stateBadge = badge;
    this.stateText = stateText;
    this.locationText = locationText;
    this.body = stateBody;
    this.footerNote = note;
    this.errorBox = errorBox;

    await this.refresh();
  }

  close(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.errorBox = null;
  }

  /** 观测：供截图脚本读取当前状态（不改布局） */
  get currentStateName(): StState {
    if (this.pushedFile !== null) return 'pushed';
    if (this.verdict === null) return 'missing';
    return this.running ? 'running' : 'installed-idle';
  }

  // ── 检测 ─────────────────────────────────────────────────

  /** 重新检测：候选目录 → 判据 → 是否在运行 */
  async refresh(): Promise<void> {
    /*
     * 浏览器模式：这条功能的每一项能力（扫主目录、启动进程、写 ST 目录）
     * 都由壳提供。不做这个判断的话，用户看到的是"检测失败：SHELL_BRIDGE_ERROR",
     * 而真正的原因是"你在浏览器里" —— 这种提示会让人去查网络与权限。
     */
    if (!isShellAvailable()) {
      this.renderBrowserOnly();
      return;
    }

    this.setBusy(true, '正在检测本地 SillyTavern…');
    this.nodeMissing = false;
    try {
      /*
       * 检测只有一份实现（`locateSt`，v0.1.6 抽出）。
       *
       * 之所以抽出去：右侧常驻面板与这个对话框都要回答同一个问题，而检测规则
       * 写两份的下场是"对话框说装了、面板说没装"，两边单测却都绿 ——
       * F15 期间（审计传了预设、编辑器没传）已经付过一次学费。
       */
      const located = await locateSt({
        findCandidates: () => findStCandidates(),
        readConfig: async () => {
          const config = await configGet();
          return { stPath: config.stPath, stAddress: config.stAddress };
        },
        probePaths: (paths: string[]) => probePaths(paths),
        readText: (path: string, maxBytes?: number) => readTextExact(path, maxBytes),
      });
      this.home = located.home;
      this.address = located.address;
      const chosen = located.chosen;
      this.verdict = chosen;
      this.pushedFile = null;
      this.hideError();

      /*
       * 探测：壳侧 TCP 说了算，浏览器 fetch 只做诊断（决策 #207）。
       *
       * 线上那次误报就是在这里发生的：ST 在 0.0.0.0:8000 上跑得好好的，
       * webview 的 fetch 却 reject（请求根本没出浏览器网络层，ST 的访问日志里
       * 没有任何来自 webview 的连接），于是 UI 说"没有应答"。
       */
      this.probe = chosen === null
        ? null
        : await probeStState({
            address: this.address,
            tcpProbe: (host, port) => probeTcp(host, port),
          });
      this.running = this.probe?.outcome === 'running';

      // 非"运行中"的探测结论一律进诊断日志，并把原始错误类型带出来
      if (this.probe !== null && this.probe.outcome !== 'running') {
        void this.logDiagnostic(`probe_st ${this.probe.outcome} root=${chosen?.root ?? ''} ${describeProbe(this.probe)}`);
      }
      if (this.probe?.browserBlocked === true) {
        /*
         * 标签从 `webview-blocked` 改成 `webview-fetch-failed`。
         *
         * 旧名字断言了"被挡"，而实测证明它只意味着"webview 内读不到"——
         * 主因是 ST 自己发的 `Cross-Origin-Resource-Policy: same-origin`
         * （跨源 no-cors 读取一律失败），网络是通的。我上一次就是拿这个标签
         * 断定"webview 到任何回环端口都被环境拦截"，方向全错、白查一轮。
         *
         * 日志的用词会直接决定下一个读它的人往哪儿查，所以这里不许含糊。
         */
        void this.logDiagnostic(
          `probe_st webview-fetch-failed root=${chosen?.root ?? ''} ` +
            `browser=${this.probe.browserErrorName ?? ''}: ${this.probe.browserErrorMessage ?? ''} ` +
            '（注意：这通常是 SillyTavern 的响应头策略所致，不代表网络不通；以进程内直连探测为准）',
        );
      }

      this.render();
      this.callbacks.notify(
        stStatusText(this.currentStateName, { root: chosen?.root, address: this.address.text }),
        chosen === null ? 'warn' : 'info',
      );
    } catch (error) {
      this.showError(`检测失败：${describe(error)}`);
      void this.logDiagnostic(`probe_st failed: ${describe(error)}`);
      this.verdict = null;
      this.render();
    } finally {
      this.setBusy(false);
      this.render();
    }
  }

  /** 手动选一个 ST 目录（记忆路径，C5） */
  private async pickDir(): Promise<void> {
    const picked = await pickDirectory(this.verdict?.root ?? this.home ?? undefined);
    if (picked === null) return;

    try {
      const probes = await probePaths([joinPath(picked, 'package.json'), joinPath(picked, 'server.js')]);
      const hasPackageJson = probes[0]?.exists === 'file';
      const hasServerJs = probes[1]?.exists === 'file';
      let packageJsonText: string | null = null;
      if (hasPackageJson) {
        try {
          packageJsonText = (await readTextExact(joinPath(picked, 'package.json'), 1024 * 1024)).text;
        } catch {
          packageJsonText = null;
        }
      }
      const verdict = judgeStInstall({ root: picked, hasPackageJson, packageJsonText, hasServerJs });
      if (!verdict.installed) {
        // 用户主动选的目录不合格必须**当场说清楚缺哪一半**，不能"记住但用不了"
        this.showError(
          verdict.reason === 'no-package-json'
            ? `${picked} 里没有 package.json —— 这里不是 SillyTavern 的根目录（要到含 server.js 的那一层）`
            : `${picked} 里既没有 scripts.start 也没有 server.js —— 不像 SillyTavern`,
        );
        return;
      }
      await this.callbacks.rememberPath(picked);
      this.hideError();
      await this.refresh();
    } catch (error) {
      this.showError(`读取该目录失败：${describe(error)}`);
    }
  }

  // ── 启动（T13.4）─────────────────────────────────────────

  private async launch(): Promise<void> {
    const verdict = this.verdict;
    if (verdict === null || this.busy) return;

    // 已经跑着就不该再拉一个（重复启动会撞端口，用户看到的是"启动失败"）
    if (this.probe?.outcome === 'running') {
      this.callbacks.notify('SillyTavern 已经在运行（8000 端口在应答），不需要再启动', 'info');
      await this.refresh();
      return;
    }

    this.setBusy(true, `正在启动 ${verdict.root} …`);
    this.hideError();
    let launched: 'start.bat' | 'server.js' | null = null;
    try {
      const facts = await this.probeLaunchFacts(verdict.root);
      const target = chooseLaunchTarget(facts);
      if (target === null) {
        this.showError(
          '这个目录里既没有 start.bat 也没有 server.js —— 无法启动。' +
            '如果这不是你正在用的那份 SillyTavern，点「换一个…」指定它的根目录。',
        );
        return;
      }
      launched = target;
      const receipt = await spawnDetached(target, verdict.root);
      this.lastLogPath = receipt.logPath;
      this.callbacks.notify(`已启动 SillyTavern（pid ${receipt.pid}，用的是 ${target}），等待 8000 端口…`, 'info');

      const ready = await waitForStReady(async () => {
        const state = await probeStState({
          address: this.address,
          tcpProbe: (host, port) => probeTcp(host, port),
        });
        return state.outcome === 'running';
      });
      if (!ready) {
        // 失败路径：把 ST 自己的输出贴出来（需求：不吞错），再给常见原因
        const tail = receipt.logPath === null ? '' : await this.readLogTail(receipt.logPath);
        const probe = await probeStState({
          address: this.address,
          tcpProbe: (host, port) => probeTcp(host, port),
        });
        this.probe = probe;
        this.running = false;
        this.showError(
          `10 秒内 8000 端口没有应答（${describeProbe(probe)}）。` +
            `SillyTavern 的输出（末尾若干行）：\n${tail === '' ? '（日志为空：进程可能刚启动就退出了）' : tail}`,
          ST_LAUNCH_FAILURE_HINTS,
        );
        void this.logDiagnostic(
          `launch timeout target=${target} root=${verdict.root} probe=${describeProbe(probe)} log=${receipt.logPath ?? ''}`,
        );
        return;
      }

      /*
       * 启动成功后**重走整条检测**（v0.1.5 生产反馈第 3 条）。
       *
       * 之前是把手里的 `running` 直接置 true —— 那样"检测通过"和"界面进入运行中"
       * 是两个独立的事实来源，一旦后续 probe 与它不一致（比如 ST 起来后又崩了），
       * 界面就停在"运行中"骗人。现在统一让 `refresh()` 出结论。
       */
      this.callbacks.notify('SillyTavern 已就绪，正在重新检测…', 'ok');
      await this.refresh();
    } catch (error) {
      const raw = describe(error);
      void this.logDiagnostic(`launch failed target=${launched ?? '?'} root=${verdict.root} error=${raw}`);
      this.showError(
        launched === null ? `启动失败：${raw}` : describeLaunchFailure(launched, raw),
        ST_LAUNCH_FAILURE_HINTS,
      );
    } finally {
      this.setBusy(false);
      this.render();
    }
  }

  /**
   * 写一条诊断日志（走契约 C8，永不抛）。
   *
   * 为什么每次探测失败都要落盘：线上那次只有一句"没有应答"，`client-error.log`
   * 里一个字都没有，谁也没法判断是缺 node、被拦还是端口不对。日志是唯一能
   * 事后对上号的东西。
   */
  private async logDiagnostic(entry: string): Promise<void> {
    try {
      await appendClientErrorLog(`[st] ${new Date().toISOString()} ${entry}`);
    } catch {
      /* 日志写不进去不能反过来影响功能（契约 C8 的约定） */
    }
  }

  private async probeLaunchFacts(root: string): Promise<{ hasStartBat: boolean; hasServerJs: boolean }> {
    const probes = await probePaths([joinPath(root, 'start.bat'), joinPath(root, 'server.js')]);
    // `Start.bat` 在 Windows 上与 `start.bat` 是同一个文件，探测器已经能吃下大小写
    return {
      hasStartBat: probes[0]?.exists === 'file',
      hasServerJs: probes[1]?.exists === 'file',
    };
  }

  private async readLogTail(logPath: string): Promise<string> {
    try {
      const file = await readTextExact(logPath, 2 * 1024 * 1024);
      return tailOfLog(file.text);
    } catch (error) {
      return `（读日志失败：${describe(error)}）`;
    }
  }

  // ── 推送（T13.5）─────────────────────────────────────────

  private async push(): Promise<void> {
    const verdict = this.verdict;
    if (verdict === null || this.busy) return;

    this.setBusy(true, '正在推送当前卡…');
    this.hideError();
    try {
      /*
       * 推送链路只有一份实现（`st-push.ts`）。右侧常驻面板调的也是它 ——
       * 两处各写一份的代价是"某天只在一个入口修了同名覆盖"，而缺陷只在
       * 另一个入口出现，用户报上来还极难复现。
       */
      const outcome = await pushCardToSt({
        charactersDir: verdict.charactersDir,
        cardName: this.callbacks.getCardName(),
        build: () => this.callbacks.buildStPush(),
        deps: {
          probeDir: (dir, options) => probeCardsDir(dir, options),
          scanDir: (dir, limit, extensions) => scanCardsDir(dir, limit, extensions),
          writeBinary: (path, base64, sha256) => writeBinaryFileAtomic(path, base64, sha256),
        },
      });

      if (!outcome.ok) {
        this.showError(outcome.reason);
        return;
      }

      this.pushedFile = outcome.fileName;
      this.pushedFaceNote = outcome.faceNote;
      this.staleJsonNote = outcome.staleNote;
      this.callbacks.notify(stStatusText('pushed', { fileName: outcome.fileName }), 'ok');

      // 打开 ST 让用户直接看角色列表；打不开不影响"已经推好了"这个事实
      try {
        await openExternal(this.address.baseUrl);
      } catch (error) {
        this.showError(`卡已推送，但没能打开浏览器：${describe(error)}`);
      }
    } catch (error) {
      this.showError(`推送失败：${describe(error)}`);
    } finally {
      this.setBusy(false);
      this.render();
    }
  }

  // ── 一键安装（T13.3）─────────────────────────────────────

  private async install(): Promise<void> {
    if (this.busy) return;
    this.setBusy(true, '检查 Node…');
    this.hideError();
    try {
      const home = this.home ?? (await findStCandidates()).home;
      if (home === null) {
        this.showError('拿不到用户主目录，无法确定安装位置。请改用「换一个…」手动指定。');
        return;
      }

      // a. Node 检测：只探测常见安装位，**不代装**（安装需要管理员，不伪装能绕过去）
      const nodeProbes = await probePaths(nodeInstallCandidates(home));
      const hasNode = nodeProbes.some((item) => item.exists === 'file' || item.exists === 'dir');
      if (!hasNode) {
        // 记成状态，让 render() 把它画出来（见 nodeMissing 字段的说明）
        this.nodeMissing = true;
        this.callbacks.notify('没在常见位置找到 Node.js：请先安装 Node LTS 再回来继续', 'warn');
        return;
      }
      this.nodeMissing = false;

      // c 的目标目录先算出来（已存在则 -2，绝不覆盖）
      const existing = await probePaths([
        joinPath(home, 'SillyTavern'),
        joinPath(home, 'SillyTavern-2'),
        joinPath(home, 'SillyTavern-3'),
        joinPath(home, 'SillyTavern-4'),
      ]);
      const existingNames = existing
        .filter((item) => item.exists !== 'none')
        .map((item) => fileNameOf(item.path));
      const destDir = stInstallTargetDir(home, existingNames);

      // b. 下载（带进度；失败给原始错误，不自动重试）
      const url = this.callbacks.downloadUrlOverride ?? stDownloadUrl((await configGet()).stMirrorPrefix);
      const zipDir = joinPath(joinPath(joinPath(home, 'AppData'), 'Local'), joinPath('Temp', 'tcs-st-install'));
      const zipProbe = await probeCardsDir(zipDir, { create: true });
      if (!zipProbe.exists) {
        this.showError(`无法创建下载目录：${zipProbe.reason ?? zipDir}`);
        return;
      }
      const zipPath = joinPath(zipDir, `${ST_RELEASE.assetName(ST_RELEASE.version)}`);

      this.setBusy(true, `正在下载 ${url} …`);
      const bytes = await this.download(url, (ratio) => {
        this.setBusy(true, `正在下载 SillyTavern ${ST_RELEASE.version}…${Math.round(ratio * 100)}%`);
      });
      await writeBinaryFileAtomic(zipPath, toBase64Chunked(bytes));

      // c. 解压（壳侧调系统 tar.exe，边界：只能解到用户主目录下）
      this.setBusy(true, `正在解压到 ${destDir} …`);
      const extracted = await extractZipTo(zipPath, destDir);
      if (!extracted.hasStStructure) {
        this.showError(
          `解压完成但目录里没有找到 SillyTavern 结构（package.json + server.js）。请检查下载到的 zip 是否是官方 release 包：${extracted.destPath ?? destDir}`,
        );
        return;
      }

      // d. 记住路径并走 T13.4（检测 → 询问启动）
      await this.callbacks.rememberPath(destDir);
      this.callbacks.notify(`已安装到 ${destDir}`, 'ok');
      await this.refresh();
    } catch (error) {
      this.showError(`一键安装失败：${describe(error)}`);
    } finally {
      this.setBusy(false);
      this.render();
    }
  }

  /**
   * 下载到内存（带进度回调）。
   *
   * 为什么先落内存再一次写盘：`writeBinaryFileAtomic` 是原子的，
   * 分块追加没有对应的能力（也不该有 —— 半截 zip 比没有更糟）。
   * 40~80 MB 的 zip 放内存是安全的，超过 300 MB 直接拒（那多半是地址错了，
   * 比如把 release 页面当成 zip 下载）。
   */
  private async download(url: string, onProgress: (ratio: number) => void): Promise<Uint8Array> {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}（${url}）`);
    }
    const total = Number(response.headers.get('content-length') ?? '0');
    if (total > MAX_DOWNLOAD_BYTES) {
      throw new Error(`文件太大（${Math.round(total / 1024 / 1024)} MB），地址可能不是 SillyTavern 的 release 包`);
    }

    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = response.body?.getReader();
    if (reader === undefined) {
      // 没有流（极老的引擎）：退化成一次性读取，进度只有 0 与 100
      const buffer = new Uint8Array(await response.arrayBuffer());
      onProgress(1);
      return buffer;
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        chunks.push(value);
        received += value.byteLength;
        if (total > 0) onProgress(Math.min(1, received / total));
      }
    }

    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    onProgress(1);
    return merged;
  }

  // ── 渲染 ─────────────────────────────────────────────────

  private render(): void {
    if (this.body === null || this.stateBadge === null || this.stateText === null) return;

    const state = this.currentStateName;
    const labels: Record<StState, string> = {
      missing: '未安装',
      'installed-idle': '已安装 · 未运行',
      running: '运行中',
      pushed: '推送完成',
    };
    this.stateBadge.textContent = labels[state];
    this.stateBadge.dataset['state'] = state;
    this.stateText.textContent = stStatusText(state, {
      root: this.verdict?.root,
      fileName: this.pushedFile ?? undefined,
    });
    if (this.locationText !== null) {
      const root = this.verdict?.root ?? (this.busy ? '自动检测中…' : '没找到（可手动指定）');
      // 位置行同时交代"这个目录是不是正在跑的那个"——记忆路径记错时的第一直觉线索
      const suffix =
        this.probe === null
          ? ''
          : this.probe.outcome === 'running'
            ? ' · 8000 在应答'
            : ` · 8000 无应答（${this.probe.tcp.errorKind ?? '未知'}）`;
      this.locationText.textContent = `${root}${suffix}`;
    }
    if (this.footerNote !== null) {
      this.footerNote.textContent = `Verdict 依据：package.json 存在，且 scripts.start 非空或 server.js 存在。本功能只读写 ST 的 characters 目录与启动进程，不碰其它配置。`;
    }

    this.body.replaceChildren();
    switch (state) {
      case 'missing':
        // 一键安装卡在 Node 那一步时，把"为什么不能代装 + 出路"放在最上面
        if (this.nodeMissing) this.body.append(this.buildNodeMissing());
        this.body.append(this.buildInstallGuide());
        break;
      case 'installed-idle':
        this.body.append(this.buildLaunchPrompt());
        break;
      case 'running':
        this.body.append(this.buildPushPanel());
        break;
      case 'pushed':
        this.body.append(this.buildPushedPanel());
        break;
    }
    document.body.dataset['stState'] = state;
  }

  /** 状态 1：未安装 → 安装指引 + 一键安装 */
  private buildInstallGuide(): HTMLElement {
    const wrap = el('div', 'st-guide');
    wrap.append(el('h3', 'st-h3', '没检测到本地 SillyTavern'));

    const steps = el('ol', 'st-steps');
    steps.append(
      el('li', 'st-step', '装 Node.js 20 LTS（官网 nodejs.org，选 LTS 版本，全程下一步）。'),
      el('li', 'st-step', `下载 SillyTavern 压缩包（当前客户端内置版本 ${ST_RELEASE.version}）。`),
      el('li', 'st-step', '解压到任意目录（建议 %USERPROFILE%\\SillyTavern），双击 Start.bat 跑起来。'),
    );
    wrap.append(steps);

    const links = el('div', 'st-links');
    const github = el('button', 'btn small ghost', '打开官方 GitHub 发布页');
    github.type = 'button';
    github.dataset['role'] = 'st-open-github';
    github.addEventListener('click', () => {
      void openExternal(`https://github.com/${ST_RELEASE.repo}/releases`);
    });
    const nodeLink = el('button', 'btn small ghost', '下载 Node.js LTS');
    nodeLink.type = 'button';
    nodeLink.dataset['role'] = 'st-open-node';
    nodeLink.addEventListener('click', () => {
      void openExternal('https://nodejs.org/zh-cn/download');
    });
    links.append(github, nodeLink, el('span', 'st-hint', '国内网络打不开 GitHub 时，可在一键安装里填镜像前缀。'));
    wrap.append(links);

    const actions = el('div', 'st-actions');
    const install = el('button', 'btn primary', `一键安装 SillyTavern ${ST_RELEASE.version}`);
    install.type = 'button';
    install.dataset['role'] = 'st-install';
    install.addEventListener('click', () => void this.install());
    const picked = el('button', 'btn', '我已装好，重新检测');
    picked.type = 'button';
    picked.dataset['role'] = 'st-rescan-2';
    picked.addEventListener('click', () => void this.refresh());
    actions.append(install, picked);
    wrap.append(actions);

    const mirrorRow = el('div', 'st-mirror');
    const mirrorInput = el('input', 'input mono') as HTMLInputElement;
    mirrorInput.type = 'text';
    mirrorInput.placeholder = '镜像前缀（可留空），例如 https://ghfast.top/';
    mirrorInput.dataset['role'] = 'st-mirror';
    void configGet().then((config) => {
      mirrorInput.value = config.stMirrorPrefix ?? '';
    });
    const saveMirror = el('button', 'btn small ghost', '保存前缀');
    saveMirror.type = 'button';
    saveMirror.dataset['role'] = 'st-mirror-save';
    saveMirror.addEventListener('click', () => {
      const value = mirrorInput.value.trim();
      void configPatch({ stMirrorPrefix: value === '' ? null : value }).then(() => {
        this.callbacks.notify(value === '' ? '已清空镜像前缀，走官方地址' : `镜像前缀已保存：${value}`, 'ok');
      });
    });
    mirrorRow.append(mirrorInput, saveMirror);
    wrap.append(mirrorRow);

    const caution = el('p', 'st-caution');
    caution.textContent =
      '一键安装会下载官方 release 包并解压到 %USERPROFILE%\\SillyTavern（已存在则用 SillyTavern-2，不覆盖）。' +
      '它不会替你安装 Node.js —— Node 安装需要管理员权限，这一步必须你自己点。';
    wrap.append(caution);
    return wrap;
  }

  /** a 步失败：没找到 Node —— 明确"不代装"，并给出出路 */
  private buildNodeMissing(): HTMLElement {
    const box = el('div', 'st-node-missing');
    box.dataset['role'] = 'st-node-missing';
    box.append(
      el('h3', 'st-h3', '没在常见位置找到 Node.js'),
      el(
        'p',
        'st-caution',
        'SillyTavern 跑在 Node.js 上。安装 Node 需要管理员权限（会写系统目录），客户端不代装 —— 这一点没法绕过。',
      ),
    );
    const actions = el('div', 'st-actions');
    const download = el('button', 'btn primary', '打开 Node.js 下载页');
    download.type = 'button';
    download.dataset['role'] = 'st-open-node-2';
    download.addEventListener('click', () => void openExternal('https://nodejs.org/zh-cn/download'));
    const retry = el('button', 'btn', '我已装好，继续安装');
    retry.type = 'button';
    retry.dataset['role'] = 'st-install-retry';
    retry.addEventListener('click', () => {
      this.nodeMissing = false;
      void this.install();
    });
    actions.append(download, retry);
    box.append(actions);
    return box;
  }

  /** 状态 2：装了但没运行 → 询问是否帮忙启动 */
  private buildLaunchPrompt(): HTMLElement {
    const wrap = el('div', 'st-launch');
    wrap.append(el('h3', 'st-h3', '帮你启动 SillyTavern？'));
    wrap.append(
      el(
        'p',
        'st-text',
        `SillyTavern 在 ${this.verdict?.root ?? ''}，但端口探测的结论是「没有应答」` +
          `${this.probe === null ? '' : `：${describeProbe(this.probe)}`}。` +
          '点下面的按钮会在后台启动它（不弹控制台窗口，输出写到日志），起来之后就能推送了。',
      ),
    );
    if (this.probe?.browserBlocked === true) {
      // TCP 通但 webview 不通：这不是"ST 没运行"，必须说清楚，否则用户会一直重启 ST
      wrap.append(
        el(
          'p',
          'st-caution',
          '注意：SillyTavern 正在运行，但内嵌面板读不到它。' +
            '这不影响推送卡片，也不影响在浏览器中打开。',
        ),
      );
    }
    const actions = el('div', 'st-actions');
    const launch = el('button', 'btn primary', '启动 SillyTavern');
    launch.type = 'button';
    launch.dataset['role'] = 'st-launch';
    launch.addEventListener('click', () => void this.launch());
    const openAnyway = el('button', 'btn ghost', '我自己启动好了，重新检测');
    openAnyway.type = 'button';
    openAnyway.dataset['role'] = 'st-rescan-3';
    openAnyway.addEventListener('click', () => void this.refresh());
    actions.append(launch, openAnyway);
    wrap.append(actions);
    return wrap;
  }

  /** 状态 3：运行中 → 推送 */
  private buildPushPanel(): HTMLElement {
    const wrap = el('div', 'st-push');
    const charactersDir = this.verdict === null ? '' : stCharactersDir(this.verdict.root);
    wrap.append(
      el('h3', 'st-h3', 'SillyTavern 正在运行'),
      el(
        'p',
        'st-text',
        `推送会把当前卡写成 PNG 角色卡（卡数据在图片里），落到 ${charactersDir}。` +
          '同名文件不覆盖，自动加序号。',
      ),
      el('p', 'st-text', '封面用这张卡自己的图（原图 → 记住的图库封面 → 内置默认），不在这里再弹选择。'),
      el('p', 'st-text', '世界书会随角色卡一起写入，不需要单独准备文件。'),
    );
    const actions = el('div', 'st-actions');
    const push = el('button', 'btn primary', '推送当前卡');
    push.type = 'button';
    push.dataset['role'] = 'st-push';
    push.addEventListener('click', () => void this.push());
    const openSt = el('button', 'btn ghost', '打开 SillyTavern');
    openSt.type = 'button';
    openSt.addEventListener('click', () => void openExternal(this.address.baseUrl));
    actions.append(push, openSt);
    wrap.append(actions);
    return wrap;
  }

  /** 状态 4：推送完成 */
  private buildPushedPanel(): HTMLElement {
    const wrap = el('div', 'st-pushed');
    const charactersDir = this.verdict === null ? '' : stCharactersDir(this.verdict.root);
    wrap.append(
      el('h3', 'st-h3', '推送完成'),
      el('p', 'st-text', `已写入 ${joinPath(charactersDir, this.pushedFile ?? '')}`),
      el('p', 'st-text', this.pushedFaceNote),
      /*
       * 验收口径写在界面上（决策 #212）：**以"文件夹扫描可见"为准**。
       * 之前那句"刷新角色列表就能看到"其实不准确 —— 那时推的是 JSON，
       * 而 ST 的文件夹扫描根本不读 .json；用户按 F5 也只会一无所获。
       */
      el('p', 'st-text', 'SillyTavern 的角色列表会直接扫到这个文件 —— 刷新一次（F5）即可看到，不需要「导入」。'),
    );
    if (this.staleJsonNote !== '') {
      wrap.append(el('p', 'st-note', this.staleJsonNote));
    }
    const actions = el('div', 'st-actions');
    const openSt = el('button', 'btn primary', '打开 SillyTavern');
    openSt.type = 'button';
    openSt.dataset['role'] = 'st-open-st';
    openSt.addEventListener('click', () => void openExternal(this.address.baseUrl));
    const again = el('button', 'btn', '再推一次（加序号）');
    again.type = 'button';
    again.addEventListener('click', () => {
      this.pushedFile = null;
      this.render();
    });
    actions.append(openSt, again);
    wrap.append(actions);
    return wrap;
  }

  /** 浏览器模式下的说明（不是错误，是"这里没有这个能力"） */
  private renderBrowserOnly(): void {
    if (this.body === null || this.stateBadge === null || this.stateText === null) return;
    this.stateBadge.textContent = '不可用';
    this.stateBadge.dataset['state'] = 'browser';
    this.stateText.textContent = '浏览器模式：本地 SillyTavern 的检测与推送需要桌面客户端';
    if (this.locationText !== null) this.locationText.textContent = '—';
    this.body.replaceChildren();
    const box = el('div', 'st-guide');
    box.dataset['role'] = 'st-browser-only';
    box.append(
      el('h3', 'st-h3', '请在桌面客户端里使用'),
      el(
        'p',
        'st-caution',
        '这个功能要读本机的目录、启动本地进程、往 SillyTavern 的角色卡目录写文件 —— 这几项能力只在装好的客户端里有。浏览器里打开的是编辑器预览，不碰本机文件。',
      ),
    );
    this.body.append(box);
    document.body.dataset['stState'] = 'browser';
  }

  // ── 小工具 ───────────────────────────────────────────────

  private setBusy(busy: boolean, hint?: string): void {
    this.busy = busy;
    if (this.overlay === null) return;
    for (const button of this.overlay.querySelectorAll<HTMLButtonElement>('button')) {
      // 「关闭」「换一个…」「重新检测」始终可用：忙的时候更要能退出
      const keep = ['st-pick-dir', 'st-rescan', 'st-rescan-2'].includes(button.dataset['role'] ?? '');
      button.disabled = busy && !keep;
    }
    if (busy && hint !== undefined && this.stateText !== null) this.stateText.textContent = hint;
  }

  private showError(message: string, hints: readonly string[] = []): void {
    if (this.errorBox === null) return;
    this.errorBox.replaceChildren();
    this.errorBox.hidden = false;
    this.errorBox.append(el('p', 'st-error-title', message));
    if (hints.length > 0) {
      const list = el('ul', 'st-error-hints');
      for (const hint of hints) list.append(el('li', '', hint));
      this.errorBox.append(el('p', 'st-error-sub', '常见原因：'), list);
    }
    // 日志目录用按钮打开（路径从契约回执里来，渲染层不自己拼配置目录）
    const openLogs = el('button', 'btn small ghost', '打开日志文件夹');
    openLogs.type = 'button';
    openLogs.addEventListener('click', () => {
      const logPath = this.lastLogPath;
      if (logPath === null) return;
      const dir = logPath.replace(/[\\/][^\\/]+$/, '');
      void openFolder(dir);
    });
    if (this.lastLogPath !== null) this.errorBox.append(openLogs);
  }

  private hideError(): void {
    if (this.errorBox === null) return;
    this.errorBox.hidden = true;
    this.errorBox.replaceChildren();
  }
}

/** 把 ShellError / Error 统一成一句人话（不吞原始信息） */
function describe(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as Partial<ShellError> & { message?: unknown };
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
      return `${candidate.message}（${candidate.code}）`;
    }
    if (typeof candidate.message === 'string') return candidate.message;
  }
  return String(error);
}
