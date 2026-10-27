/**
 * 服务端同步面板（T6.7）：上传 / 版本历史 / 回滚。
 *
 * 约束：
 *   · 可用性**复用** T6.8 的 `isSyncReady`（不在这里另设判据）；
 *   · 未就绪时入口置灰（由 app.ts 控制，面板内再兜一层）；
 *   · 回滚前必须确认，并提示「当前编辑内容将被覆盖，建议先另存」；
 *   · 上传成功后刷新版本历史，并显示服务端返回的版本号。
 */

import { isSyncReady, type ProbeResult } from '../net/server-probe';
import { syncGateMessage, type SyncGateState } from '../auth/entry-policy';
import type { RepoSummary } from './repo-client';
import { pickRepoId, shouldShowRepoPicker, toRepoOptions, type RepoTokenContext } from './repo-select';
import { describeCapabilities } from '../auth/repo-token';
import { connectLocalService, describeLocalSuccess } from '../net/local-connect';
import { askConfirm } from '../contract';
import {
  SyncError,
  fetchVersionText,
  listCards,
  listVersions,
  pruneVersion,
  rollbackCard,
  uploadCard,
  type CardSummary,
  type SyncConfig,
  type UploadResult,
  type VersionSummary,
} from '../sync/server-sync';

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

export interface SyncDialogCallbacks {
  /** 当前连接状态（来自 probeServer） */
  getConnection: () => ProbeResult | null;
  /** 当前配置（serverUrl / token） */
  getConfig: () => SyncConfig | null;
  /** 当前待上传的 JSON 文本（与导出同一份，保证字节一致） */
  getPayload: () => Promise<string>;
  /**
   * 上传目标 —— 来自**活动会话**，不是下拉选择。
   *
   * `cardId` 是用户创建时指定、之后不可变的那个 ID（F11）。服务端按它归档：
   * 已存在则追加版本、不存在则新建。返回 null 表示当前没有会话（零标签），不能上传。
   *
   * `baseSeq` 是本会话上次与远端对齐的版本号，交给服务端判断是否分叉。
   */
  getUploadTarget: () => { cardId: string; name: string; baseSeq: number | null } | null;
  /** 上传成功后把 cardId 与 seq 一起记回会话（分叉判定要这两个一起才有意义） */
  onUploaded: (cardId: string, seq: number) => void;
  /**
   * 把远端版本内容应用回编辑器。
   *
   * `remoteSeq` 是**应用后远端最新的序号**：回滚会新建一个版本，它不等于目标版本的 seq。
   * 会话基线要记的是前者 —— 记错了下次上传会被误报成分叉。
   *
   * `context` 是 v0.1.3 追加项三新加的：零标签时 App 要**自动建卡**，而建卡需要
   *    · `cardId`：必须用服务端的那个，否则下一次上传会在远端新建一张卡；
   *    · `mode`：决定状态栏说"已创建卡片…"还是"已回滚并载入…"。
   * 面板不持有卡片状态，这两件事只能由 App 做，所以只能把信息交出去。
   */
  onRemoteTextApplied: (
    text: string,
    version: VersionSummary,
    remoteSeq: number,
    context: { cardId: string; mode: 'restore' | 'rollback' },
  ) => void;
  /** 一键连接成功后把探测结果交回 App（顶栏指示与同步开关据此刷新） */
  onConnectionReady?: (result: ProbeResult) => void;
  /**
   * 401 后的统一处置（T10.7）：先试静默续期，续不上才回登录界面。
   *
   * 返回 true 表示令牌已恢复，调用方可以重试；这个回调**不负责**清空编辑器，
   * 本地未保存内容与云端身份无关。
   */
  onUnauthorized?: () => Promise<boolean>;
  /** 打开「我的卡片」列表（T10.7）：按 角色名 · cardId · 仓库 · vN 展示服务端返回的卡 */
  onOpenCards?: () => void;
  /**
   * 可选仓库列表（T10.8）。返回 null / 空数组表示"当前凭证不能选仓库"
   * （未登录、或用的是仓库令牌），此时上传仓库这一行整行隐藏。
   */
  getRepos?: () => Promise<RepoSummary[]>;
  /** 当前选中的仓库 id（预选见 `pickRepoId`） */
  getSelectedRepo?: () => string | null;
  /** 用户改选了仓库（App 记住它，供下一次预选） */
  onSelectRepo?: (repoId: string) => void;
  /** 打开「仓库与令牌」面板（T10.8） */
  onOpenRepos?: () => void;
  /**
   * 仓库令牌模式上下文（v0.1.3 / F5 后半）。
   *
   * 返回 null = 不在该模式（账户登录 / legacy）。非 null 时面板要做三件事：
   *   ① 顶部显示「仓库令牌模式 · <仓库名>」；
   *   ② **隐藏**仓库选择器（令牌绑死一个仓库）；
   *   ③ 按 `caps` 置灰上传/回滚，并用 `reason` 说明缺哪一档。
   */
  getRepoTokenContext?: () => RepoTokenContext | null;
  /**
   * 同步门槛（v0.1.2 追加任务）。
   *
   * 由 App 用 `resolveSyncGate` 算出：**有地址 + 有凭证 = ready**，
   * 不再要求"探测到 token 有效" —— 后者会把未登录呈现成"未连接"。
   * 没接这个回调时回落到旧的 `isSyncReady`（单测里构造 panel 时方便）。
   */
  getGate?: () => SyncGateState;
  /** 未登录时的「登录…」入口 */
  onLogin?: () => void;
  notify: (message: string, kind?: 'ok' | 'warn' | 'bad' | 'info') => void;
}

export class SyncDialog {
  private readonly overlay: HTMLDivElement;
  private readonly statusLine: HTMLElement;
  /** 上传目标（只读展示：角色名 + cardId） */
  private readonly targetLine: HTMLElement;
  /** 历史面板正在看哪张卡（默认 = 会话自己的 cardId） */
  private readonly historySelect: HTMLSelectElement;
  private readonly versionList: HTMLElement;
  private readonly uploadButton: HTMLButtonElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly busyBox: HTMLElement;
  /** 分叉等不阻断警告的展示位（F11：黄色警告条） */
  private readonly warningBar: HTMLElement;
  /** F6.1：同步面板的「连接本机服务端」入口（设置面板为主入口，这里给个快捷方式） */
  private readonly connectButton: HTMLButtonElement;
  /** 未登录时的「登录…」——未登录不是错误，给一个就地解决的动作 */
  private readonly loginButton: HTMLButtonElement;
  /** T10.8：上传仓库选择（未登录时整行隐藏） */
  private readonly repoRow: HTMLElement;
  private readonly repoSelect: HTMLSelectElement;
  private readonly repoHint: HTMLElement;
  /** v0.1.3 / F5 后半：仓库令牌模式的说明条（与上面那行互斥） */
  private readonly repoTokenRow: HTMLElement;
  private readonly repoTokenLabel: HTMLElement;
  private readonly repoTokenHint: HTMLElement;
  private versions: VersionSummary[] = [];
  /** 防止「连接本机服务端」被连点（重入会让两次探测结果互相覆盖） */
  private busy = false;
  /** 当前历史面板展示的卡片 ID；null 时回落到会话自己的 cardId */
  private historyCardId: string | null = null;
  /**
   * 仓库令牌模式上下文（v0.1.3 / F5 后半）。
   *
   * 存成字段而不是每次回调现取：`renderStatus` 与 `renderVersions` 都要用它
   * 判按钮，而它们刷新频率远高于仓库列表。每次现取会让"置灰"与"可用"
   * 在两次渲染之间跳变。
   */
  private tokenContext: RepoTokenContext | null = null;
  /**
   * 上一次 `renderStatus` 算出的门槛。
   *
   * `setBusy` / `canUploadNow` 在 renderStatus 之外被调用，需要一个可读的
   * 上一次结论 —— 重新调 `getGate()` 在那两个时机语义不同（正在上传时
   * 回调可能还没变，也可能已经变了），会算错。
   */
  private lastGate: SyncGateState = 'no-server';

  constructor(private readonly callbacks: SyncDialogCallbacks) {
    this.overlay = el('div', 'modal-overlay');
    this.overlay.hidden = true;
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');

    const panel = el('div', 'modal wide');

    const head = el('div', 'modal-head');
    const title = el('h2', 'modal-title', '服务端同步');
    title.id = 'sync-title';
    const close = el('button', 'icon-btn', '×');
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    head.append(title, close);

    // 状态
    this.statusLine = el('p', 'sync-status', '检查连接…');
    // 未就绪时把「连接本机服务端」直接放在状态行旁边 ——
    // 用户在这里发现连不上，就地解决，不用先记住"去设置页"再找回来。
    this.connectButton = el('button', 'btn small', '连接本机服务端');
    this.connectButton.type = 'button';
    this.connectButton.addEventListener('click', () => void this.connectLocal());
    this.loginButton = el('button', 'btn small primary', '登录…');
    this.loginButton.type = 'button';
    this.loginButton.dataset['role'] = 'sync-login';
    this.loginButton.hidden = true;
    this.loginButton.addEventListener('click', () => this.callbacks.onLogin?.());
    const statusRow = el('div', 'sync-status-row');
    statusRow.append(this.statusLine, this.connectButton, this.loginButton);

    // 上传目标（只读）+ 上传
    const uploadSection = el('section', 'form-section');
    uploadSection.append(el('h3', 'form-title', '上传'));

    // 这里**不再是下拉选择**：目标由活动会话决定。
    // 让别人选"上传到哪张卡"等于给了个把 A 卡内容写进 B 卡 ID 的开关，
    // 而 ID 一旦是稳定身份，写错就是污染别人的历史。
    this.targetLine = el('div', 'sync-target');
    this.targetLine.dataset['role'] = 'sync-target';

    this.uploadButton = el('button', 'btn primary', '上传当前内容') as HTMLButtonElement;
    this.uploadButton.type = 'button';
    this.uploadButton.addEventListener('click', () => void this.upload());

    this.refreshButton = el('button', 'btn', '刷新') as HTMLButtonElement;
    this.refreshButton.type = 'button';
    this.refreshButton.addEventListener('click', () => void this.reload());

    const targetRow = el('div', 'field-row');
    targetRow.append(this.targetLine, this.uploadButton, this.refreshButton);
    uploadSection.append(targetRow);

    /*
     * 上传仓库（T10.8）。
     *
     * 与上面"不让人选卡"是两件事：**卡 ID 是身份，仓库是存放位置**。
     * 选错仓库只是把卡放进别的抽屉（可以移），选错卡 ID 会污染另一张卡的历史。
     * 所以这里给下拉，但默认预选服务端标记的默认仓库。
     *
     * 未登录（legacy 令牌或仓库令牌）时不显示：仓库由凭证本身决定，
     * 给一个改了也不生效的下拉比如实说"由令牌绑定"更糟。
     */
    this.repoRow = el('div', 'field-row sync-repo-row');
    this.repoRow.hidden = true;
    const repoLabel = el('span', 'field-hint sync-repo-label', '上传到仓库');
    this.repoSelect = el('select', 'select small') as HTMLSelectElement;
    this.repoSelect.dataset['role'] = 'upload-repo';
    this.repoSelect.title = '上传目标仓库（默认仓库已预选）';
    this.repoSelect.addEventListener('change', () => {
      this.callbacks.onSelectRepo?.(this.repoSelect.value);
      this.renderTarget();
    });
    this.repoHint = el('span', 'field-hint sync-repo-hint');
    // 仓库令牌申请入口：放在"选仓库"旁边 —— 用户想给 CI/脚本开权限的时机，
    // 正是他在选"传到哪个仓库"的时候。
    const reposButton = el('button', 'btn small ghost', '仓库与令牌…');
    reposButton.type = 'button';
    reposButton.dataset['role'] = 'open-repos';
    reposButton.addEventListener('click', () => this.callbacks.onOpenRepos?.());
    this.repoRow.append(repoLabel, this.repoSelect, this.repoHint, reposButton);
    uploadSection.append(this.repoRow);

    /*
     * 仓库令牌模式的说明条（v0.1.3 / F5 后半）。
     *
     * 与仓库下拉**互斥**：下拉隐藏时这一行出现，把"为什么只有一个仓库"
     * 讲清楚。只隐藏下拉而不给替代说明，用户会以为仓库列表加载失败了。
     */
    this.repoTokenRow = el('div', 'field-row sync-repo-token-row');
    this.repoTokenRow.hidden = true;
    this.repoTokenRow.dataset['role'] = 'repo-token-mode-row';
    this.repoTokenLabel = el('span', 'sync-repo-token-label');
    this.repoTokenLabel.dataset['role'] = 'repo-token-mode-label';
    this.repoTokenHint = el('span', 'field-hint sync-repo-token-hint');
    this.repoTokenRow.append(this.repoTokenLabel, this.repoTokenHint);
    uploadSection.append(this.repoTokenRow);

    uploadSection.append(
      el(
        'p',
        'field-hint',
        '服务端按「角色卡 ID」归档：已存在则追加新版本，不存在则新建。上传的内容与你导出的角色卡一致。',
      ),
    );

    // 分叉警告条：默认隐藏，仅在服务端返回 warnings 时出现。
    // 用**常驻条**而不是一次性 toast —— 分叉是持续存在的事实（两条历史已经分开），
    // 一次性的提示划过去就没了，用户下次再改还是不知道自己站在哪个分支上。
    this.warningBar = el('div', 'sync-warning');
    this.warningBar.hidden = true;
    this.warningBar.setAttribute('role', 'alert');
    uploadSection.append(this.warningBar);

    // 版本历史
    const historySection = el('section', 'form-section');
    const historyHead = el('div', 'form-title-row');
    historyHead.append(el('h3', 'form-title', '版本历史'));
    this.historySelect = el('select', 'select small') as HTMLSelectElement;
    this.historySelect.dataset['role'] = 'sync-card';
    this.historySelect.title = '查看其他卡片的历史（只读）';
    this.historySelect.addEventListener('change', () => {
      this.historyCardId = this.historySelect.value === '__session__' ? null : this.historySelect.value;
      const target = this.effectiveHistoryCardId();
      if (target) void this.loadVersions(target);
    });
    historyHead.append(this.historySelect);
    // T10.7：账户卡片列表入口。放在这里而不是顶栏：用户想"看我的卡"
    // 的时机几乎都是在这个面板里（刚上传完、想找另一张卡的历史）。
    const cardsButton = el('button', 'btn small ghost', '账户卡片…');
    cardsButton.type = 'button';
    cardsButton.dataset['role'] = 'open-cards';
    cardsButton.addEventListener('click', () => this.callbacks.onOpenCards?.());
    historyHead.append(cardsButton);
    this.versionList = el('div', 'version-list');
    historySection.append(historyHead, this.versionList);

    // 忙碌提示
    this.busyBox = el('p', 'sync-busy');
    this.busyBox.hidden = true;

    const foot = el('div', 'modal-foot');
    const done = el('button', 'btn', '关闭');
    done.type = 'button';
    done.addEventListener('click', () => this.close());
    foot.append(el('span', 'foot-note', ''), done);

    panel.append(head, statusRow, uploadSection, historySection, this.busyBox, foot);
    this.overlay.append(panel);

    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.overlay.hidden) this.close();
    });

    document.body.append(this.overlay);
  }

  open(): void {
    this.overlay.hidden = false;
    // 每次打开都把"看哪张卡的历史"复位到会话自己的卡 ——
    // 上次留下的选择属于上一次的任务，留着会让用户对着别人的历史回滚。
    this.historyCardId = null;
    this.clearWarning();
    this.renderTarget();
    void this.reload();
  }

  close(): void {
    this.overlay.hidden = true;
  }

  /** 外部指定要查看的历史卡片（截图/联调；不影响上传目标） */
  selectCard(cardId: string): void {
    this.historyCardId = cardId;
    if (![...this.historySelect.options].some((option) => option.value === cardId)) {
      const option = el('option');
      option.value = cardId;
      option.textContent = cardId;
      this.historySelect.append(option);
    }
    this.historySelect.value = cardId;
    void this.loadVersions(cardId);
  }

  /** 会话自己的 cardId；没有会话时 null */
  private sessionCardId(): string | null {
    return this.callbacks.getUploadTarget()?.cardId ?? null;
  }

  /** 历史面板实际展示的卡片：用户选的，没选就是会话自己的 */
  private effectiveHistoryCardId(): string | null {
    return this.historyCardId ?? this.sessionCardId();
  }

  /**
   * 同步面板里的「连接本机服务端」。
   *
   * 与设置面板走**同一个** `connectLocalService`，不另写一套 ——
   * 两个入口如果各有一套判断，迟早出现"设置页能连、同步页连不上"的分歧。
   *
   * 连接成功后要通知外部刷新连接状态（顶栏指示、同步入口的启用开关都依赖它），
   * 因此走 `callbacks.notify` 让 App 重新探测一次，而不是在这里自说自话地标记成功。
   */
  private async connectLocal(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.connectButton.disabled = true;
    this.statusLine.textContent = '正在探测本机服务端…';
    this.statusLine.className = 'sync-status';
    try {
      const result = await connectLocalService();
      if (!result.ok) {
        // 失败原因 + 第一条处置建议放在状态行（面板空间有限，完整步骤在设置页）
        this.statusLine.textContent = result.message;
        this.statusLine.className = 'sync-status bad';
        this.callbacks.notify(result.steps[0] ?? result.message, 'warn');
        return;
      }
      this.statusLine.textContent = describeLocalSuccess(result);
      this.statusLine.className = 'sync-status ok';
      // 让 App 重新探测并广播，其它面板据此启用/禁用
      this.callbacks.notify(
        result.persisted ? '已连接本机服务端' : '已连接（浏览器模式不持久化）',
        'ok',
      );
      this.callbacks.onConnectionReady?.(result.probe);
      this.renderStatus();
      await this.reload();
    } finally {
      this.busy = false;
      this.connectButton.disabled = false;
    }
  }

  private setBusy(text: string | null): void {
    this.busyBox.hidden = text === null;
    if (text !== null) this.busyBox.textContent = text;
    /*
     * 这里**必须**也看 scope（v0.1.3 / F5 后半）。
     *
     * 第一版只写 `disabled = text !== null`，于是出现了下面这条时间线：
     *   renderStatus 按 scope 把「上传当前内容」置灰 → 用户点上传（按钮其实是灰的，
     *   但**上传流程结束后 setBusy(null) 会把它解锁**）→ 按钮亮回来。
     * 实测 dump 抓到了这一幕：read 令牌下该按钮 title 写着"没有写权限"、
     * disabled 却是 false。截图看不出差别（灰蓝两种态很像），只有读 DOM 才发现。
     *
     * 所以现在按钮可用性只有两个判据来源：`renderStatus` 与 `setBusy`，
     * 两处都走同一个 `canUploadNow()` / `canRefreshNow()`，不再各写一套。
     */
    this.uploadButton.disabled = text !== null || !this.canUploadNow();
    this.refreshButton.disabled = text !== null || !this.canRefreshNow();
  }

  /** 「上传当前内容」此刻该不该可点（不含 busy 判定 —— busy 由调用方叠加） */
  private canUploadNow(): boolean {
    if (this.tokenContext !== null) return this.tokenContext.caps.canUpload;
    return this.callbacks.getGate?.() === 'ready' || this.lastGate === 'ready';
  }

  /** 「刷新」此刻该不该可点（只需要 read） */
  private canRefreshNow(): boolean {
    if (this.tokenContext !== null) return this.tokenContext.caps.canRead;
    return this.callbacks.getGate?.() === 'ready' || this.lastGate === 'ready';
  }

  /**
   * 渲染状态；未就绪时禁用全部操作（不只靠入口置灰）。
   *
   * 三态而不是两态（v0.1.2 追加任务）：
   *   · `no-server` → 「还没配置服务端地址」+ 一键连接按钮；
   *   · `need-login` → **「登录后可同步。」** + 登录按钮。这一格是本轮的核心修正：
   *     上一版把"没凭证"和"连不上"合并成了一句「同步未就绪」，
   *     用户看到的是"未连接"，而其实只是还没登录。
   *   · `ready` → 显示连接消息。
   */
  private renderStatus(): boolean {
    const connection = this.callbacks.getConnection();
    const gate: SyncGateState =
      this.callbacks.getGate?.() ?? (isSyncReady(connection) ? 'ready' : 'need-login');
    const ready = gate === 'ready';
    // 记住上一次的门槛判定：`setBusy` 与 `canUploadNow` 在 renderStatus 之外
    // 被调用时，不能只靠回调现算（那时可能正在上传，回调语义不同）
    this.lastGate = gate;

    this.statusLine.replaceChildren();
    // 未登录是"待办"不是"故障"，用中性色；只有按凭证发出的请求失败才用 bad
    this.statusLine.className = `sync-status ${ready ? 'ok' : 'warn'}`;
    if (ready) {
      this.statusLine.textContent = connection?.reachable ? (connection.message ?? '已连接') : '已就绪';
    } else {
      this.statusLine.textContent = syncGateMessage(gate);
    }

    /*
     * 可用性 = 门槛通过 **且** scope 允许（v0.1.3 / F5 后半）。
     *
     * 两个条件必须同时成立：门槛只看"有没有地址和凭证"，
     * 而令牌可能有效却只有 read —— 只判门槛会让上传按钮亮着、
     * 点了拿到 403，用户以为是程序坏了。
     *
     * 注意 `canUploadNow()` 内部已经含 `lastGate === 'ready'`，
     * 所以这里不再重复写 `!ready` —— 但 `historySelect` 没有 busy 概念，
     * 它的判据仍要显式带上 ready。
     */
    const caps = this.tokenContext?.caps ?? null;
    const reason = this.tokenContext?.reason ?? null;
    this.uploadButton.disabled = !ready || (caps !== null && !caps.canUpload);
    this.refreshButton.disabled = !ready || (caps !== null && !caps.canRead);
    this.historySelect.disabled = !ready || (caps !== null && !caps.canRead);

    // 置灰时必须说清缺哪一档：这把令牌通常是别人签的
    if (caps !== null && !caps.canUpload && reason !== null) this.uploadButton.title = reason.upload;
    else this.uploadButton.removeAttribute('title');
    if (caps !== null && !caps.canRead) this.refreshButton.title = '此令牌没有「读」权限';
    else this.refreshButton.removeAttribute('title');
    this.loginButton.hidden = gate !== 'need-login' || this.callbacks.onLogin === undefined;
    // 一键连接只在"连地址都没有/连不通"时才有意义；登录阶段摆着它只会分散注意力
    this.connectButton.hidden = gate !== 'no-server';
    this.renderTarget();
    return ready;
  }

  /**
   * 渲染上传目标：当前会话的「角色名 + 角色卡 ID」。
   *
   * 这两项必须同时显示：ID 是服务端认卡的依据，名字只是给人看的。
   * 只显示名字的话，用户没法确认"我这次真的传到那张卡上了吗"。
   */
  private renderTarget(): void {
    const target = this.callbacks.getUploadTarget();
    this.targetLine.replaceChildren();

    if (!target) {
      this.targetLine.className = 'sync-target empty';
      this.targetLine.textContent = '没有打开的角色卡：先新建或打开一张卡再上传。';
      this.uploadButton.disabled = true;
      return;
    }

    this.targetLine.className = 'sync-target';
    this.targetLine.append(
      el('span', 'sync-target-name', target.name || '(未命名)'),
      el('code', 'sync-target-id', target.cardId),
    );
    // T10.8：把「传到哪个仓库」显示在上传目标里。
    // 只有仓库下拉可见时才显示 —— 那时它的值就是**这次上传真正会用到的**仓库。
    // 下拉不可见（legacy 令牌 / 仓库令牌）时干脆不显示，而不是猜一个：
    // 前者只看未归属卡、后者的仓库由令牌绑定，显示错的名字比不显示更糟。
    if (!this.repoRow.hidden) {
      const selectedLabel = this.repoSelect.selectedOptions[0]?.textContent ?? '';
      if (selectedLabel !== '') this.targetLine.append(el('span', 'sync-target-repo', selectedLabel));
    }
    if (target.baseSeq !== null) {
      this.targetLine.append(el('span', 'sync-target-base', `基线 v${target.baseSeq}`));
    } else {
      // 没有基线时明确说出来：此时服务端无法判断分叉，用户得知道这个前提。
      this.targetLine.append(el('span', 'sync-target-base', '尚未与远端对齐'));
    }
    // 端到端断言用：不靠读文案判断目标
    document.body.dataset['syncTargetCardId'] = target.cardId;
    document.body.dataset['syncTargetBase'] = target.baseSeq === null ? '' : String(target.baseSeq);
  }

  /**
   * 显示分叉等警告（常驻条，不是 toast）。
   *
   * `note` 用来解释"警告里的基线"和"目标行现在显示的基线"为什么不是一个数：
   * 上传成功后会话基线会前进，而警告说的是**这次上传出发时**的基线。
   * 不解释的话，同一屏里两个不同的 v 号会让人以为哪边算错了。
   */
  private showWarning(messages: string[], code: string, note?: string): void {
    this.warningBar.replaceChildren();
    if (messages.length === 0) {
      this.warningBar.hidden = true;
      delete document.body.dataset['syncWarning'];
      return;
    }
    this.warningBar.append(el('strong', 'sync-warning-title', '⚠ 注意'));
    const list = el('ul', 'sync-warning-list');
    for (const message of messages) list.append(el('li', '', message));
    this.warningBar.append(list);
    if (note) this.warningBar.append(el('p', 'sync-warning-note', note));
    this.warningBar.hidden = false;
    this.warningBar.dataset['code'] = code;
    document.body.dataset['syncWarning'] = code;
  }

  private clearWarning(): void {
    this.showWarning([], '');
  }

  /**
   * 加载上传仓库下拉（T10.8）。
   *
   * 失败时**整行隐藏**而不是显示空下拉：空下拉会让用户以为"我没有仓库"，
   * 而真实原因可能是"当前凭证是仓库令牌，不能选仓库"或"没登录"。
   * 选中的仓库用 `pickRepoId` 决定（默认仓库优先，记忆值仍存在时优先）。
   */
  private async reloadRepos(): Promise<void> {
    /*
     * 先处理仓库令牌模式（v0.1.3 / F5 后半）。
     *
     * 这一段必须在"取仓库列表"之前：该模式下 `getRepos()` 会返回空数组
     * （令牌绑死一个仓库，没有可选项），若先走下面的空数组分支，
     * 面板会同时隐藏下拉**和**说明条 —— 用户看到的是"这一块什么都没有"，
     * 完全不知道自己在令牌模式下、也不知道在哪个仓库。
     */
    const tokenContext = this.callbacks.getRepoTokenContext?.() ?? null;
    this.tokenContext = tokenContext;
    if (tokenContext !== null) {
      this.repoTokenRow.hidden = false;
      this.repoTokenLabel.textContent = tokenContext.label;
      this.repoTokenLabel.dataset['repoName'] = tokenContext.repoName;
      // 权限说明：把"这个模式能做什么"直接写在仓库名旁边，
      // 而不是只体现在灰掉的按钮上（后者要用户去试才知道）
      this.repoTokenHint.textContent = describeCapabilities(tokenContext.caps);
      // 下拉隐藏 —— 需求「仓库选择器隐藏（只有一个仓库）」
      this.repoRow.hidden = true;
      this.renderStatus();
      return;
    }

    this.repoTokenRow.hidden = true;
    this.repoTokenLabel.textContent = '';
    delete this.repoTokenLabel.dataset['repoName'];
    this.repoTokenHint.textContent = '';
    this.repoRow.removeAttribute('title');
    this.uploadButton.removeAttribute('title');
    this.refreshButton.removeAttribute('title');

    if (!this.callbacks.getRepos) {
      this.repoRow.hidden = true;
      return;
    }
    try {
      const repos = await this.callbacks.getRepos();
      if (!shouldShowRepoPicker(repos, tokenContext)) {
        this.repoRow.hidden = true;
        return;
      }
      const selected = pickRepoId(repos, this.callbacks.getSelectedRepo?.() ?? null);
      this.repoSelect.replaceChildren();
      for (const option of toRepoOptions(repos)) {
        const node = document.createElement('option');
        node.value = option.id;
        node.textContent = option.label;
        // 存**原始仓库名**：label 带「（默认）」后缀，直接回传会把后缀当进名字里
        node.dataset['repoName'] = option.name;
        this.repoSelect.append(node);
      }
      if (selected !== null) {
        this.repoSelect.value = selected;
        this.callbacks.onSelectRepo?.(selected);
      }
      this.repoRow.hidden = false;
      const current = repos.find((repo) => repo.id === selected);
      this.repoHint.textContent =
        current === undefined ? '' : `${String(current.cardCount)} 张卡`;
      // 目标行里要显示"传到哪个仓库"，而下拉刚刚才出现 —— 重画一次，
      // 否则用户看到的目标行缺一段（`renderStatus` 那次执行时下拉还是隐藏的）
      this.renderTarget();
    } catch {
      // 拿不到仓库列表（未登录 / 仓库令牌 / 网络）→ 隐藏，不去猜
      this.repoRow.hidden = true;
    }
  }

  private async reload(): Promise<void> {
    const ready = this.renderStatus();
    if (!ready) {
      this.versionList.replaceChildren(
        el(
          'p',
          'issue-empty',
          this.callbacks.getGate?.() === 'no-server'
            ? '填好服务端地址后即可查看版本历史'
            : '登录后可查看版本历史',
        ),
      );
      return;
    }

    const config = this.callbacks.getConfig();
    if (!config) return;

    await this.reloadRepos();

    this.setBusy('加载卡片列表…');
    try {
      const cards = await listCards(config, { limit: 50 });
      this.renderHistoryOptions(cards);

      /*
       * 零标签（v0.1.3 追加项三）：自动选中列表里的第一张卡。
       *
       * 需求要的是「零标签 → 点取回/回滚 → 自动建卡」。若停在"本次会话（未打开
       * 卡片）"，版本列表是空的，用户根本点不到任何版本 —— 那条路等于不存在。
       * 自动选第一张只是省一次点击，选择权仍在（下拉照常可改）。
       */
      let historyId = this.effectiveHistoryCardId();
      if (historyId === null && this.sessionCardId() === null && cards.length > 0) {
        historyId = cards[0]!.cardId;
        this.historyCardId = historyId;
        this.historySelect.value = historyId;
      }
      if (historyId) await this.loadVersions(historyId);
      else this.versionList.replaceChildren(el('p', 'issue-empty', '选择一张卡片后显示版本历史'));
    } catch (error) {
      this.reportError('加载失败', error);
    } finally {
      this.setBusy(null);
    }
  }

  /**
   * 渲染历史选择器（服务端卡片列表）。
   *
   * 文案是「角色名 · cardId」—— 这是需求要求的列表形态，也是唯一能让用户
   * 对上"列表里的这张"和"我手里这张"的写法：只给名字时重名卡分不开，
   * 只给 ID 时看不出是哪张。
   *
   * 第一项固定是「本次会话」，因为绝大多数时候用户只关心手上这张卡的历史。
   */
  private renderHistoryOptions(cards: CardSummary[]): void {
    const keep = this.historySelect.value;
    this.historySelect.replaceChildren();

    const sessionId = this.sessionCardId();
    const sessionOption = el('option');
    sessionOption.value = '__session__';
    sessionOption.textContent = sessionId
      ? `本次会话 · ${sessionId}`
      : '本次会话（未打开卡片）';
    this.historySelect.append(sessionOption);

    for (const card of cards) {
      // 会话自己的卡已经在第一项里了，不重复列
      if (card.cardId === sessionId) continue;
      const option = el('option');
      option.value = card.cardId;
      // 遗留卡标注出来：它们的 ID 是服务端当年自动发的，不是用户选的
      const legacyTag = card.idSource === 'legacy' || card.idSource === 'auto' ? '（遗留 ID）' : '';
      option.textContent = `${card.name || '(未命名)'} · ${card.cardId}${legacyTag} · v${card.latestSeq}`;
      this.historySelect.append(option);
    }

    const desired = this.historyCardId ?? '__session__';
    this.historySelect.value = [...this.historySelect.options].some((o) => o.value === desired)
      ? desired
      : keep !== '' && [...this.historySelect.options].some((o) => o.value === keep)
        ? keep
        : '__session__';
    this.historyCardId = this.historySelect.value === '__session__' ? null : this.historySelect.value;
  }

  private async loadVersions(cardId: string): Promise<void> {
    const config = this.callbacks.getConfig();
    if (!config) return;

    this.setBusy('加载版本历史…');
    try {
      this.versions = await listVersions(config, cardId, { limit: 50 });
      this.renderVersions();
    } catch (error) {
      // 404 不是失败：这张卡还没上传过，是新建卡打开同步面板的**正常**状态。
      // 早先这里直接报「角色卡不存在」，用户会以为同步坏了 —— 而实际上
      // 他要做的只是点一下「上传当前内容」。
      if (error instanceof SyncError && error.code === 'NOT_FOUND') {
        this.versions = [];
        this.versionList.replaceChildren(
          el('p', 'issue-empty', '该角色卡 ID 在服务端还没有记录：点「上传当前内容」会新建 v1。'),
        );
        return;
      }
      this.reportError('版本历史加载失败', error);
    } finally {
      this.setBusy(null);
    }
  }

  private renderVersions(): void {
    this.versionList.replaceChildren();

    if (this.versions.length === 0) {
      this.versionList.append(el('p', 'issue-empty', '还没有版本'));
      return;
    }

    for (const version of this.versions) {
      const row = el('div', 'version-row');

      const main = el('div', 'version-main');
      const titleLine = el('div', 'version-title');
      titleLine.append(el('span', 'version-seq', `v${version.seq}`));
      titleLine.append(el('span', 'version-kind', version.kind));
      if (version.audit) {
        const badge = el(
          'span',
          `version-audit ${version.audit.exportable ? 'ok' : 'bad'}`,
          version.audit.exportable
            ? `可导出 · 错${version.audit.error} 警${version.audit.warning}`
            : `不可导出 · 错${version.audit.error}`,
        );
        titleLine.append(badge);
      }
      main.append(titleLine);

      const meta = el('div', 'version-meta');
      meta.append(
        // 内容被清除的版本 sha256 为 null（服务端 prune 后）——
        // 直接 .slice() 会在这种版本上抛 TypeError，把整个列表渲染打断。
        version.pruned
          ? el('code', 'version-sha version-pruned', '内容已清除')
          : el('code', 'version-sha', (version.sha256 ?? '').slice(0, 12)),
        el('span', '', version.pruned ? '—' : `${version.size} 字节`),
        el('span', '', version.createdAt.replace('T', ' ').slice(0, 19)),
      );
      if (version.message) meta.append(el('span', 'version-msg', version.message));
      main.append(meta);

      const actions = el('div', 'version-actions');

      const loadButton = el('button', 'btn small', '取回');
      loadButton.type = 'button';
      // 内容已被清除的版本取不回来（服务端 409）。按钮置灰并说明原因，
      // 而不是让用户点一下换一个"内容已被清除"的报错。
      loadButton.disabled = version.pruned === true;
      loadButton.title = version.pruned
        ? '这一版的内容已被清除，无法取回'
        : '把该版本内容载入编辑器（不改变服务端）';
      loadButton.addEventListener('click', () => void this.loadVersionIntoEditor(version));
      actions.append(loadButton);

      // 最新版本没有"回滚到它自己"的意义
      const isLatest = version.seq === this.versions[0]?.seq;
      // 只读查看别的卡片时也不给回滚：在别人的卡上回滚等于往人家的历史里塞版本，
      // 而用户的本意可能只是"看看"。按钮直接置灰比点了再报错诚实。
      /*
       * 零标签（v0.1.3 追加项三）：没有"自己的卡"可比，选中的那张就是目标。
       *
       * 这时回滚按钮必须**可点** —— 否则需求里"零标签回滚"这条路在界面上
       * 根本走不到（按钮恒灰，用户只能看到一句"只能回滚当前会话所属的卡片"）。
       */
      const sessionCardId = this.sessionCardId();
      const isOwnCard =
        sessionCardId === null || this.effectiveHistoryCardId() === sessionCardId;
      const rollbackButton = el('button', 'btn small', '回滚到此版本');
      rollbackButton.type = 'button';
      // 令牌没有 rollback 范围时也置灰（v0.1.3 / F5 后半）：
      // 与"最新版本"「别人的卡」同样是**已知不可能成立**的动作，
      // 让它亮着只会换来一次 403
      const noRollbackScope = this.tokenContext !== null && !this.tokenContext.caps.canRollback;
      rollbackButton.disabled = isLatest || !isOwnCard || version.pruned === true || noRollbackScope;
      if (version.pruned === true) rollbackButton.title = '这一版的内容已被清除，无法回滚到它';
      else if (noRollbackScope) rollbackButton.title = this.tokenContext?.reason.rollback ?? '此令牌没有「回滚」权限';
      else if (isLatest) rollbackButton.title = '这已是最新版本';
      else if (!isOwnCard) rollbackButton.title = '只能回滚当前会话所属的卡片；其他卡片的历史是只读的';
      rollbackButton.addEventListener('click', () => void this.rollback(version));
      actions.append(rollbackButton);

      /*
       * 「清除内容」（F13.3 / F13.5）。
       *
       * 最新版置灰并给出**为什么** —— 服务端也会拒（409），两层都拦：
       * 只靠服务端的话，用户会点出一个"不知道为什么不行"的报错。
       * 已清除的版本不再显示这个按钮（重复点没有意义，留着只会让人以为还能再清一次）。
       */
      if (!version.pruned) {
        const pruneButton = el('button', 'btn small danger', '清除内容');
        pruneButton.type = 'button';
        pruneButton.dataset['role'] = 'version-prune';
        /*
         * 只拦最新版，**不**沿用回滚那条"必须是当前会话的卡"的限制。
         *
         * 理由：回滚会往服务端写一个新版本，和当前编辑中的卡混在一起容易误操作；
         * 而 prune 只是清掉某一版的正文，不改内容、不产生版本。F13.3 的要求是
         * 「用户可 prune 自己的卡」—— 而这里列出的卡本来就都是自己账户下的
         * （范围由服务端按账户过滤），再加一层"必须是正在编辑的那张"会让
         * 「从我的卡片 → 看历史 → 清除」这条最自然的路径走不通（实测：
         * 版本行有按钮但永远是灰的）。
         */
        pruneButton.disabled = isLatest;
        pruneButton.title = isLatest
          ? '最新版本是对外可见的正文，不能清除（要清整张卡请用删除）'
          : '清除这一版的正文与摘要，保留版本记录（不可恢复）';
        pruneButton.addEventListener('click', () => void this.prune(version));
        actions.append(pruneButton);
      }

      row.append(main, actions);
      this.versionList.append(row);
    }
  }

  /**
   * 清除某版本内容。
   *
   * 确认框里写清"不可恢复、只保留元数据"：这个按钮就在「取回」「回滚」旁边，
   * 手滑的成本太高，笼统一句"确定吗"不足以让人停下来。
   */
  private async prune(version: VersionSummary): Promise<void> {
    const config = this.callbacks.getConfig();
    const cardId = this.effectiveHistoryCardId();
    if (!config || !cardId) {
      this.callbacks.notify('请先登录并选择一张卡片', 'warn');
      return;
    }
    const ok = await askConfirm(
      `清除 v${String(version.seq)} 的内容？\n\n` +
        '正文与摘要会被清空，版本记录（时间/作者/说明）保留，\n' +
        '从此不能再取回或回滚到这一版。这个操作不可恢复。',
      '清除版本内容',
    );
    if (!ok) return;

    this.setBusy('清除版本内容…');
    try {
      const result = await pruneVersion(config, cardId, version.seq);
      this.callbacks.notify(
        result.alreadyPruned ? `v${String(version.seq)} 的内容之前已清除` : `已清除 v${String(version.seq)} 的内容`,
        result.alreadyPruned ? 'info' : 'ok',
      );
      await this.loadVersions(cardId);
    } catch (error) {
      this.callbacks.notify(`清除失败：${error instanceof Error ? error.message : String(error)}`, 'bad');
    } finally {
      this.setBusy(null);
    }
  }

  private async upload(): Promise<void> {
    const config = this.callbacks.getConfig();
    if (!config) {
      this.callbacks.notify(
        this.callbacks.getGate?.() === 'need-login' ? '请先登录账户再上传' : '请先在设置里填写服务端地址',
        'warn',
      );
      return;
    }

    const target = this.callbacks.getUploadTarget();
    if (!target) {
      this.callbacks.notify('没有打开的角色卡，无法上传', 'warn');
      return;
    }

    this.setBusy('生成内容并上传…');
    this.clearWarning();
    try {
      const text = await this.callbacks.getPayload();

      const result: UploadResult = await uploadCard(config, {
        text,
        // 目标就是会话自己的 cardId：服务端按它 upsert
        cardId: target.cardId,
        // 基线一起送过去，服务端据此判断是否分叉
        baseSeq: target.baseSeq,
        // T10.8：仓库名（服务端按 owner + 仓库名解析 id）。
        // 未显示下拉（legacy / 仓库令牌）时不传 —— 后者的仓库由令牌绑定，
        // 传了也会被服务端忽略，不如不传（避免出现"我选了却没生效"的错觉）。
        ...(this.repoRow.hidden ? {} : { repo: this.repoSelect.selectedOptions[0]?.dataset['repoName'] ?? null }),
        message: `在客户端上传（${new Date().toLocaleString('zh-CN')}）`,
        author: 'tavern-card-studio',
      });

      // cardId 与 seq 一起记回会话（分叉判定要这两个一起才有意义）
      this.callbacks.onUploaded(result.cardId, result.seq);
      this.renderTarget();

      // 上传成功后刷新列表与版本历史
      await this.reload();

      if (result.warnings.length > 0) {
        const codes = [...new Set(result.warnings.map((item) => item.code))];
        this.showWarning(
          result.warnings.map((item) => item.message),
          codes.join(','),
          codes.includes('FORK')
            ? `本次内容已写入 v${result.seq}，会话基线随之更新为 v${result.seq}；上一条里的基线指的是这次上传出发时的版本。`
            : undefined,
        );
        // 警告不等于失败：内容已经写进去了，所以状态用 warn 而不是 bad
        this.callbacks.notify(`已上传 v${result.seq}，但有 ${result.warnings.length} 条警告`, 'warn');
        return;
      }

      this.callbacks.notify(
        result.created
          ? `已在服务端新建「${target.cardId}」· 版本 v${result.seq}`
          : `已上传新版本：v${String(result.seq)}`,
        'ok',
      );
    } catch (error) {
      this.reportError('上传失败', error);
    } finally {
      this.setBusy(null);
    }
  }

  /**
   * 回滚：必须确认，且明确告知会覆盖当前编辑内容。
   *
   * 只允许在**会话自己的卡**上回滚。查看别人的历史是只读的 ——
   * 在别人的卡上回滚等于给别人的历史塞一个版本，而用户的本意可能只是"看看"。
   */
  private async rollback(version: VersionSummary): Promise<void> {
    const config = this.callbacks.getConfig();
    const cardId = this.effectiveHistoryCardId();
    if (!config || !cardId) {
      this.callbacks.notify('请先选择目标卡片', 'warn');
      return;
    }
    /*
     * 「必须是当前会话的卡」这条限制**只在有标签时成立**（v0.1.3 追加项三）。
     *
     * 原来的判据是 `cardId !== this.sessionCardId()`，零标签时左边是选中的卡、
     * 右边是 null，恒不相等 → 直接拒绝。而零标签下用户能点到这里，说明他
     * 是先在下拉里选了某张卡的历史（面板允许，只读查看）。此时"回滚到这一版"
     * 是一个完整而合理的要求：把他看到的内容变成手上的一张卡。
     *
     * 所以现在分两种：
     *   · 有标签 → 沿用原判据（在别人的卡上回滚仍然要拦，那是往人家历史里塞版本）；
     *   · 零标签 → 放行，App 会按服务端 cardId 新建一张卡来承接内容。
     */
    const sessionCardId = this.sessionCardId();
    if (sessionCardId !== null && cardId !== sessionCardId) {
      this.callbacks.notify('只能回滚当前会话所属的卡片；查看其他卡片的历史是只读的', 'warn');
      return;
    }

    const confirmed = await askConfirm(
      `回滚到 v${version.seq}？\n\n` +
        `· 服务端会新建一个提交（历史只增不改，可再回滚回去）\n` +
        (sessionCardId === null
          ? '· 当前没有打开的卡片，会为这张卡新建一个标签并载入内容\n'
          : '· 当前编辑内容将被覆盖，建议先另存\n') +
        `\n要同时把 v${version.seq} 的内容载入编辑器吗？点「确定」将载入。`,
      '回滚版本',
    );
    if (!confirmed) {
      this.callbacks.notify('已取消回滚', 'info');
      return;
    }

    this.setBusy(`回滚到 v${version.seq}…`);
    try {
      const result = await rollbackCard(config, cardId, version.seq, {
        message: `回滚到 v${version.seq}`,
        author: 'tavern-card-studio',
      });

      // 取回回滚后的内容并载入编辑器（用户已在上一步确认）
      const text = await fetchVersionText(config, cardId, version.seq);
      // 基线记 result.seq（回滚新建的那个版本），不是目标版本的 seq ——
      // 记错了下一次上传会被服务端误判成分叉
      this.callbacks.onRemoteTextApplied(text, version, result.seq, {
        cardId,
        mode: 'rollback',
      });

      await this.loadVersions(cardId);
      this.callbacks.notify(
        `已回滚并新建版本 v${result.seq}（目标 v${version.seq}）；编辑器已载入该版本内容`,
        'ok',
      );
    } catch (error) {
      this.reportError('回滚失败', error);
    } finally {
      this.setBusy(null);
    }
  }

  /** 只取回、不改服务端 */
  private async loadVersionIntoEditor(version: VersionSummary): Promise<void> {
    const config = this.callbacks.getConfig();
    const cardId = this.effectiveHistoryCardId();
    if (!config || !cardId) return;

    this.setBusy(`取回 v${version.seq}…`);
    try {
      const text = await fetchVersionText(config, cardId, version.seq);
      // 内容与远端 v{seq} 一致，于是基线就是它
      this.callbacks.onRemoteTextApplied(text, version, version.seq, {
        cardId,
        mode: 'restore',
      });
      this.callbacks.notify(`已载入 v${version.seq} 的内容（未改动服务端）`, 'ok');
    } catch (error) {
      this.reportError('取回失败', error);
    } finally {
      this.setBusy(null);
    }
  }

  private reportError(prefix: string, error: unknown): void {
    if (error instanceof SyncError) {
      const suffix =
        error.code === 'UNAUTHORIZED'
          ? '（登录已过期或令牌无效：请重新登录，或到「设置」更新令牌）'
          : error.code === 'NETWORK' || error.code === 'TIMEOUT'
            ? '（服务端不可达）'
            : '';
      // 401 交给账户层试一次续期：续得上就不用打扰用户（access 只有 2 小时，
      // 每两小时弹一次登录框是不可接受的）。fire-and-forget 是刻意的 ——
      // 这里已经没法重试当前操作了，续期成功后下一次操作自然会成功。
      if (error.code === 'UNAUTHORIZED') void this.callbacks.onUnauthorized?.();
      this.callbacks.notify(`${prefix}：${error.message}${suffix}`, 'bad');
      return;
    }
    this.callbacks.notify(`${prefix}：${error instanceof Error ? error.message : String(error)}`, 'bad');
  }
}
