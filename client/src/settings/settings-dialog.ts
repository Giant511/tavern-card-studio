/**
 * 设置面板（T6.8）：服务端 URL / token / 测试连接。
 *
 * 契约约束：配置读写只走 C5（configGet / configSet / configPatch），
 * 落在应用配置目录（plugin-store），不由渲染层直接碰文件。
 *
 * 一个重要设计：**这个面板的任何失败都不阻断编辑**。
 * 它只影响"同步能力是否可用"，编辑 / 审计 / 导出与网络无关。
 */

import {
  configGet,
  configPatch,
  defaultCardsDir,
  isShellAvailable,
  openFolder,
  pickDirectory,
  probeCardsDir,
} from '../contract';
import { decideCardsDir, resolveCardsDir } from '../session/cards-path';
import { effectiveCardsDir } from '../session/cards-dir';
import { faceLibraryDir } from '../export/face-library';
import { isSyncReady, normalizeServerUrl, probeServer, type ProbeResult } from '../net/server-probe';
import { connectLocalService, describeLocalSuccess, LOCAL_API_ORIGIN } from '../net/local-connect';
import type { AuthPhase } from '../auth/session';
import type { AuthUser } from '../auth/auth-client';
import { identityLabel, resolveSyncGate, syncGateMessage } from '../auth/entry-policy';

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

export interface SettingsCallbacks {
  /** 连接状态变化（用于顶栏指示与同步入口的启用/禁用） */
  onConnectionChange: (result: ProbeResult | null) => void;
  /** 保存成功（便于外部提示） */
  onSaved?: () => void;
  /** 当前登录态（决定「账户」那一行显示什么） */
  getIdentity?: () => { phase: AuthPhase; user: AuthUser | null };
  /** 点「登录…」：打开登录框（未登录时） */
  onLogin?: () => void;
  /** 点「退出登录」 */
  onLogout?: () => Promise<void>;
  /**
   * 点「注销账户…」：打开二次确认弹窗（v0.1.3 / F3）。
   *
   * 不在这里实现弹窗，因为注销要联动 AuthSession、清登录态、刷新顶栏与面板 ——
   * 那些都是 App 的职责。设置面板只负责"把入口摆出来"。
   */
  onDeleteAccount?: () => void;
  /**
   * 当前是否处于仓库令牌模式（v0.1.3 / F5 后半）。null = 不是。
   *
   * 设置页需要它把身份行改成"仓库令牌模式 · X"：那个模式下没有账户身份，
   * 显示「已登录：xxx」会让人误以为自己有完整的账户权限。
   */
  getRepoTokenMode?: () => { repoName: string } | null;
  /**
   * 点「导出诊断日志」（T10.26）。由 app 提供：它知道版本、连接状态、会话摘要，
   * 也知道日志文件在哪（契约返回的路径）。
   *
   * 返回一句话给状态栏（成功/失败都要说清）。放回调而不是在这里实现，是因为
   * 「导出」要串起三个契约能力（读日志 → 选保存路径 → 原子写），
   * 而这三个都已经在 app 侧有既有实现，重写一份必然漂移。
   */
  onExportDiagnostics?: () => Promise<string>;
}

export class SettingsDialog {
  private readonly overlay: HTMLDivElement;
  private readonly urlInput: HTMLInputElement;
  private readonly tokenInput: HTMLInputElement;
  /** 账户那一行：已登录 / 未登录 + 动作按钮（登录… / 退出登录） */
  private readonly identityText: HTMLElement;
  private readonly identityButton: HTMLButtonElement;
  /** 「注销账户…」（v0.1.3 / F3）：仅账户登录时可见 */
  private readonly deleteAccountButton: HTMLButtonElement;
  /** 两条凭证路径的说明（v0.1.3 / F5 后半） */
  private readonly identityHint: HTMLElement;
  /** 「导出诊断日志」按钮与它那一行结果（T10.26） */
  private readonly diagnosticsButton: HTMLButtonElement;
  private readonly diagnosticsStatus: HTMLElement;
  /** 「高级 · 兼容模式」折叠区（legacy 全局令牌） */
  private readonly advanced: HTMLDetailsElement;
  private readonly probeStatus: HTMLParagraphElement;
  private readonly syncNote: HTMLParagraphElement;
  private readonly testButton: HTMLButtonElement;
  private readonly connectButton: HTMLButtonElement;
  private readonly localSteps: HTMLDivElement;
  private readonly saveButton: HTMLButtonElement;
  /** 卡片存放目录（T9.8 / F4） */
  private readonly cardsDirInput: HTMLInputElement;
  private readonly cardsDirStatus: HTMLParagraphElement;
  private readonly chooseDirButton: HTMLButtonElement;
  /** 卡面图库路径（只读展示）与"打开目录"按钮（v0.1.4 / T12.5） */
  private readonly faceDirValue: HTMLInputElement;
  private readonly openFaceDirButton: HTMLButtonElement;
  /** 壳给出的默认目录；浏览器模式下为空串（拿不到） */
  private defaultDir = '';
  private lastResult: ProbeResult | null = null;
  private busy = false;

  constructor(private readonly callbacks: SettingsCallbacks) {
    this.overlay = el('div', 'modal-overlay');
    this.overlay.hidden = true;
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-labelledby', 'settings-title');
    this.overlay.dataset['role'] = 'settings-dialog';

    const panel = el('div', 'modal');

    const head = el('div', 'modal-head');
    const title = el('h2', 'modal-title', '设置');
    title.id = 'settings-title';
    const close = el('button', 'icon-btn', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭');
    close.addEventListener('click', () => this.close());
    head.append(title, close);

    // ── 服务端 ──────────────────────────────────────────
    const serverSection = el('section', 'form-section');
    serverSection.append(el('h3', 'form-title', '服务端连接'));

    const urlField = el('label', 'field');
    urlField.append(el('span', 'field-label', '服务端地址'));
    this.urlInput = el('input', 'input');
    this.urlInput.type = 'text';
    this.urlInput.placeholder = 'http://127.0.0.1:8730';
    this.urlInput.spellcheck = false;
    this.urlInput.autocomplete = 'off';
    urlField.append(this.urlInput);
    urlField.append(
      el(
        'span',
        'field-hint',
        '支持本机、局域网 IP（如 192.168.1.20:8730）与域名；省略 http:// 会自动补全。',
      ),
    );

    /*
     * 账户身份行（v0.1.2 追加任务）。
     *
     * 这里**原本是一个必填的「访问令牌」输入框**，那是本次要修的偏差：
     * 令牌被当成了连接的前置条件，用户得先从 config.json / 面板里抄一个全局令牌
     * 才能"连上"，然后登录界面才可用 —— 顺序整反了。
     *
     * 现在这一行只描述"我是谁"，不再要求"先证明你能连"：
     *   · 未登录 → 「未登录」+「登录…」
     *   · 已登录 → 「已登录：alice（账户令牌）」+「退出登录」
     * 身份来自账户会话（`AuthSession`），令牌由它自己管，用户不需要看见。
     */
    const identityField = el('div', 'field');
    identityField.dataset['role'] = 'settings-account';
    identityField.append(el('span', 'field-label', '账户'));
    const identityRow = el('div', 'field-row settings-identity-row');
    this.identityText = el('span', 'settings-identity', '未登录');
    this.identityText.dataset['role'] = 'settings-identity';
    this.identityButton = el('button', 'btn small', '登录…');
    this.identityButton.type = 'button';
    this.identityButton.dataset['role'] = 'settings-identity-action';
    this.identityButton.addEventListener('click', () => void this.actOnIdentity());
    identityRow.append(this.identityText, this.identityButton);
    /*
     * 「注销账户」（v0.1.3 / F3）。
     *
     * 放在身份行**同一行的末尾**，但用 danger 样式且默认隐藏（仅账户登录时出现）：
     *   · 放在这里是因为"账户"这一行就是用户找账户操作的地方；
     *   · 用 danger 而不是普通按钮，是因为它旁边就是「退出登录」——
     *     两者视觉上必须能一眼分开，否则手滑点错的代价是"账户没了"。
     *   · 仓库令牌模式下**不显示**：那个模式没有账户可言（令牌代表别人），
     *     摆一个注定 403 的按钮比不摆更糟。
     */
    this.deleteAccountButton = el('button', 'btn small danger', '注销账户…');
    this.deleteAccountButton.type = 'button';
    this.deleteAccountButton.dataset['role'] = 'settings-delete-account';
    this.deleteAccountButton.hidden = true;
    this.deleteAccountButton.addEventListener('click', () => this.callbacks.onDeleteAccount?.());
    identityRow.append(this.deleteAccountButton);
    identityField.append(identityRow);
    /*
     * 两条凭证路径的适用场景（v0.1.3 / F5 后半重写）。
     *
     * 上一版只写「令牌由客户端自动管理，不需要手工填写」—— 那句话回答了
     * "要不要手填令牌"，但没回答用户真正困惑的问题：
     *   「仓库与令牌里签出来的那些令牌，到底该在哪里用？」
     * 实测反馈里就有人签了一把 tcr_ 令牌，然后找不到任何入口能粘它。
     *
     * 所以这里必须把两条路径**并列写清**（账户 = 身份 / 仓库令牌 = 受限授权），
     * 并给出各自的适用场景 —— 判决标准是"你是在自己常用的机器上，
     * 还是要把这个仓库交给别人/别的工具"。
     */
    this.identityHint = el('p', 'field-hint settings-path-hint');
    this.identityHint.dataset['role'] = 'settings-credential-paths';
    this.identityHint.append(
      el('strong', '', '两条凭证路径（按场景选）：'),
      el(
        'span',
        'settings-path-line',
        '· 账户登录 = 身份。本机常用，用自己的用户名密码登录，全权管理自己名下的全部仓库与卡片。',
      ),
      el(
        'span',
        'settings-path-line',
        '· 仓库令牌 = 受限授权。把令牌交给其他设备、脚本或他人，让它们只能访问这一个仓库、' +
          '且只到令牌范围允许的程度（读 / 写 / 回滚）；不暴露账户密码，也不能管理仓库与令牌。',
      ),
      el(
        'span',
        'settings-path-line',
        '令牌在「同步 → 仓库与令牌…」里签发，拿到后到登录界面的「使用仓库令牌连接」粘贴。',
      ),
    );
    identityField.append(this.identityHint);

    /*
     * 兼容模式（≤v0.1.1 的服务端）收进「高级」折叠区，默认收起。
     *
     * 为什么默认收起而不是保留在主要位置：v0.1.1 的全局令牌在 0.1.2 里**已被降权**
     * （只看未归属账户的卡片），把它摆在显眼处只会让新用户以为"这才是正常用法"。
     * 但它不能删 —— 没升级的服务端只有这一种凭证。
     */
    this.advanced = document.createElement('details');
    this.advanced.className = 'settings-advanced';
    this.advanced.dataset['role'] = 'settings-advanced';
    const summary = document.createElement('summary');
    summary.textContent = '高级 · 兼容模式（旧版服务端 ≤v0.1.1）';
    this.advanced.append(summary);

    const tokenField = el('label', 'field');
    tokenField.append(el('span', 'field-label', '全局令牌（legacy）'));
    const tokenRow = el('div', 'field-row');
    this.tokenInput = el('input', 'input');
    this.tokenInput.type = 'password';
    this.tokenInput.placeholder = '仅用于未升级账户体系的服务端';
    this.tokenInput.spellcheck = false;
    this.tokenInput.autocomplete = 'off';
    this.tokenInput.dataset['role'] = 'legacy-token';
    const toggleToken = el('button', 'btn ghost small', '显示');
    toggleToken.type = 'button';
    toggleToken.addEventListener('click', () => {
      const hidden = this.tokenInput.type === 'password';
      this.tokenInput.type = hidden ? 'text' : 'password';
      toggleToken.textContent = hidden ? '隐藏' : '显示';
    });
    tokenRow.append(this.tokenInput, toggleToken);
    tokenField.append(tokenRow);
    tokenField.append(
      el(
        'span',
        'field-hint',
        '仅用于未升级账户体系的服务端（≤v0.1.1）。0.1.2 及以后请用上面的账户登录；' +
          '全局令牌在 0.1.2 里只能看到"尚未归属账户"的卡片。',
      ),
    );
    this.advanced.append(tokenField);

    serverSection.append(urlField, identityField, this.advanced);

    // ── 一键连接 + 打开后台（F6.1 / F6.3）───────────────
    //
    // 放在「测试连接」之前：这是首次配置的主入口，
    // 用户装完服务端最想做的是"点一下就好"，而不是先找令牌再测。
    const quickRow = el('div', 'probe-row');
    this.connectButton = el('button', 'btn primary', '连接本机服务端');
    this.connectButton.type = 'button';
    this.connectButton.title = `自动探测 ${LOCAL_API_ORIGIN} 并取回访问令牌`;
    this.connectButton.addEventListener('click', () => void this.connectLocal());

    quickRow.append(this.connectButton);
    serverSection.append(quickRow);

    // 分步反馈区：失败时逐条列出"哪一步错了 + 怎么办"
    this.localSteps = el('div', 'local-steps');
    this.localSteps.hidden = true;
    serverSection.append(this.localSteps);

    // ── 测试连接 ────────────────────────────────────────
    const probeRow = el('div', 'probe-row');
    this.testButton = el('button', 'btn', '测试连接');
    this.testButton.type = 'button';
    this.testButton.addEventListener('click', () => void this.test());
    this.probeStatus = el('p', 'probe-status info', '尚未测试');
    probeRow.append(this.testButton);
    serverSection.append(probeRow, this.probeStatus);

    // ── 同步说明（明确降级边界）──────────────────────────
    this.syncNote = el('p', 'sync-note');
    serverSection.append(this.syncNote);

    // ── 角色卡目录（T9.8 / F4）──────────────────────────
    //
    // 没有这一段的后果很具体：用户保存了卡，但下次打开不知道去哪找；
    // 或者两次保存同一个卡把上一次覆盖掉。
    const dirSection = el('section', 'form-section');
    dirSection.append(el('h3', 'form-title', '角色卡目录'));

    const dirField = el('label', 'field');
    dirField.append(el('span', 'field-label', '卡片存放位置'));
    const dirRow = el('div', 'field-row');
    this.cardsDirInput = el('input', 'input mono');
    this.cardsDirInput.type = 'text';
    this.cardsDirInput.spellcheck = false;
    this.cardsDirInput.autocomplete = 'off';
    this.cardsDirInput.addEventListener('input', () => {
      // 手改之后不再显示上一次探测的结论 —— 那是对旧路径说的
      this.setDirStatus('', 'info');
      // 图库路径是派生的（<cardsDir>/card-faces），跟着一起变
      void this.refreshFaceDir();
    });
    this.chooseDirButton = el('button', 'btn', '选择…');
    this.chooseDirButton.type = 'button';
    this.chooseDirButton.addEventListener('click', () => void this.chooseCardsDir());
    dirRow.append(this.cardsDirInput, this.chooseDirButton);
    dirField.append(dirRow);
    dirField.append(
      el(
        'span',
        'field-hint',
        '打开/保存角色卡时默认落在这里；保存时若同名文件已存在，会自动改成「名字 (2)」，不会覆盖。',
      ),
    );
    this.cardsDirStatus = el('p', 'probe-status info', '');
    this.cardsDirStatus.hidden = true;

    dirSection.append(dirField, this.cardsDirStatus);

    /*
     * 卡面图库（v0.1.4 / T12.5，需求 F5）。
     *
     * 只显示路径 + 一个"打开目录"按钮，**不做管理 UI**（需求明确写在范围控制里）：
     * 删图/改名用户自己进目录操作，多一套增删界面就是多一套出错的地方。
     * 路径是派生的（`<cardsDir>/card-faces`），不给用户改 —— 改它等于让
     * "图库"这个概念有两个定义。
     */
    const faceField = el('label', 'field');
    faceField.append(el('span', 'field-label', '卡面图库（导出 PNG 卡时可选）'));
    const faceRow = el('div', 'field-row');
    this.faceDirValue = el('input', 'input mono');
    this.faceDirValue.type = 'text';
    this.faceDirValue.readOnly = true;
    this.faceDirValue.dataset['role'] = 'face-dir-value';
    this.openFaceDirButton = el('button', 'btn', '打开图库目录');
    this.openFaceDirButton.type = 'button';
    this.openFaceDirButton.dataset['role'] = 'open-face-dir';
    this.openFaceDirButton.addEventListener('click', () => void this.openFaceDir());
    faceRow.append(this.faceDirValue, this.openFaceDirButton);
    faceField.append(faceRow);
    faceField.append(
      el(
        'span',
        'field-hint',
        '把 png / jpg / webp 放进这个目录，导出 PNG 卡时就能在缩略图里选。' +
          '目录跟着上面的卡片存放位置走，首次使用会自动创建。',
      ),
    );
    dirSection.append(faceField);
    void this.refreshFaceDir();

    // ── 诊断（T10.26）────────────────────────────────────
    //
    // 放在设置里而不是顶栏：它是"出问题时才用"的功能，顶栏每多一个按钮，
    // 常用按钮就被稀释一次。位置紧邻「角色卡目录」—— 两者都是"文件去哪了"类问题。
    const diagSection = el('section', 'form-section');
    diagSection.append(el('h3', 'form-title', '诊断'));
    const diagRow = el('div', 'field-row');
    this.diagnosticsButton = el('button', 'btn', '导出诊断日志…');
    this.diagnosticsButton.type = 'button';
    this.diagnosticsButton.dataset['role'] = 'export-diagnostics';
    this.diagnosticsButton.title = '把渲染层错误日志、版本号与连接状态打包成一个 txt';
    this.diagnosticsButton.addEventListener('click', () => void this.exportDiagnostics());
    diagRow.append(this.diagnosticsButton);
    diagSection.append(
      diagRow,
      el(
        'span',
        'field-hint',
        '渲染层的报错会自动记到应用配置目录的 logs/client-error.log。导出后可以直接发给维护者；' +
          '文件里只有版本、连接状态与错误堆栈，不含角色卡正文。',
      ),
    );
    this.diagnosticsStatus = el('p', 'probe-status info', '');
    this.diagnosticsStatus.hidden = true;
    diagSection.append(this.diagnosticsStatus);

    // ── 底部按钮 ────────────────────────────────────────
    const foot = el('div', 'modal-foot');
    const browserWarn = el(
      'span',
      'foot-note',
      isShellAvailable() ? '' : '浏览器模式：配置不会持久化（请在桌面客户端内使用）',
    );
    this.saveButton = el('button', 'btn primary', '保存');
    this.saveButton.type = 'button';
    this.saveButton.addEventListener('click', () => void this.save());
    const cancel = el('button', 'btn', '关闭');
    cancel.type = 'button';
    cancel.addEventListener('click', () => this.close());
    foot.append(browserWarn, cancel, this.saveButton);

    panel.append(head, serverSection, dirSection, diagSection, foot);
    this.overlay.append(panel);

    // 点遮罩关闭
    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.close();
    });
    // Esc 关闭
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.overlay.hidden) this.close();
    });

    document.body.append(this.overlay);
    this.updateSyncNote();
  }

  /** 打开并载入已保存的配置 */
  async open(prefill?: { serverUrl?: string; token?: string }): Promise<void> {
    this.overlay.hidden = false;
    this.probeStatus.textContent = '尚未测试';
    this.probeStatus.className = 'probe-status info';

    if (prefill?.serverUrl !== undefined) this.urlInput.value = prefill.serverUrl;
    if (prefill?.token !== undefined) {
      this.tokenInput.value = prefill.token;
      // 只有真的带了令牌（调试参数 / 旧配置迁移）才把兼容模式展开 ——
      // 否则折叠区一打开就是展开的，等于把 legacy 令牌又摆回显眼位置
      if (prefill.token !== '') this.advanced.open = true;
    }

    if (!isShellAvailable()) {
      // 浏览器模式：契约的 configGet 会失败，保留预填值（若有）让用户仍能测连接
      if (!this.urlInput.value) this.urlInput.value = 'http://127.0.0.1:8730';
      // 目录字段在这里既不读也不写：明确置灰 + 说明，而不是留一个空框让人以为能填
      this.cardsDirInput.value = '';
      this.cardsDirInput.placeholder = '（仅桌面客户端可用；默认 文档\\TavernCardStudio\\cards）';
      this.cardsDirInput.disabled = true;
      this.chooseDirButton.disabled = true;
      this.setDirStatus('浏览器模式无法读写本地目录，此设置仅在桌面客户端生效。', 'info');
      this.refreshIdentity();
      this.urlInput.focus();
      return;
    }

    try {
      // 默认目录由壳解析（可能被重定向到 OneDrive，TS 侧拼不出来）
      try {
        this.defaultDir = await defaultCardsDir();
      } catch {
        this.defaultDir = '';
      }

      const config = await configGet();
      if (prefill?.serverUrl === undefined) this.urlInput.value = config.serverUrl;
      if (prefill?.token === undefined) this.tokenInput.value = config.token;
      this.cardsDirInput.value = resolveCardsDir(config.cardsDir, this.defaultDir);

      // 只探测现状、**不创建**：打开设置面板不该在磁盘上留下任何东西
      if (this.cardsDirInput.value) {
        const probe = await probeCardsDir(this.cardsDirInput.value);
        const decision = decideCardsDir(probe, 'open');
        // open 模式不会有 blocked（不创建任何东西），这里收窄一次类型
        this.setDirStatus(decision.message, decision.state === 'blocked' ? 'bad' : decision.state);
      }
    } catch (error) {
      this.setProbeStatus(`读取配置失败：${errorText(error)}`, 'bad');
    }
    this.refreshIdentity();
    this.urlInput.focus();
  }

  close(): void {
    this.overlay.hidden = true;
  }

  /**
   * 重画身份行。登录态在任何地方变化（登录成功、登出、静默过期、401 恢复）
   * 都要调它 —— app.ts 的 `onPhaseChange` 里已经接上了。
   */
  refreshIdentity(): void {
    const identity = this.callbacks.getIdentity?.() ?? { phase: 'anonymous' as AuthPhase, user: null };
    this.identityText.textContent = identityLabel(identity.phase, identity.user);
    this.identityText.dataset['phase'] = identity.phase;

    /*
     * 仓库令牌模式（v0.1.3 / F5 后半）：身份行改说"当前用的是哪种凭证"。
     *
     * 不能沿用"已登录：xxx" —— 令牌模式下没有账户身份（令牌代表签发人，
     * 用令牌的未必是同一个人）。这里必须说清"你正在用一把受限授权"，
     * 否则用户会以为自己在账户身份里，然后奇怪为什么别的仓库不见了。
     */
    const tokenMode = this.callbacks.getRepoTokenMode?.() ?? null;
    if (tokenMode !== null) {
      this.identityText.textContent = `仓库令牌模式 · ${tokenMode.repoName === '' ? '未知仓库' : tokenMode.repoName}`;
      this.identityText.dataset['phase'] = 'repo-token';
      this.identityButton.textContent = '退出令牌模式';
      this.identityButton.dataset['action'] = 'logout';
      this.identityButton.hidden = this.callbacks.onLogout === undefined;
      // 仓库令牌模式没有账户可注销：那时点了也是 403，不如不显示
      this.deleteAccountButton.hidden = true;
      this.updateSyncNote();
      return;
    }

    const loggedIn = identity.phase === 'authenticated';
    this.identityButton.textContent = loggedIn ? '退出登录' : '登录…';
    this.identityButton.dataset['action'] = loggedIn ? 'logout' : 'login';
    // 没有接回调时把按钮藏起来，而不是留一个点了没反应的按钮
    this.identityButton.hidden =
      loggedIn ? this.callbacks.onLogout === undefined : this.callbacks.onLogin === undefined;
    /*
     * 注销入口只在**账户登录**时出现。
     *
     * `loggedIn` 用的是 phase === 'authenticated'，而 legacy 全局令牌不会把 phase
     * 置成 authenticated（它没有账户身份）—— 所以这里不会给"运维令牌"用户
     * 摆一个注定 403 的按钮。
     */
    this.deleteAccountButton.hidden = !loggedIn;
    this.updateSyncNote();
  }

  /** 身份行按钮：登录 → 打开登录框；已登录/令牌模式 → 退出 */
  private async actOnIdentity(): Promise<void> {
    const identity = this.callbacks.getIdentity?.() ?? { phase: 'anonymous' as AuthPhase, user: null };
    const tokenMode = this.callbacks.getRepoTokenMode?.() ?? null;
    if (identity.phase === 'authenticated' || tokenMode !== null) {
      if (this.callbacks.onLogout === undefined) return;
      this.identityButton.disabled = true;
      try {
        await this.callbacks.onLogout();
      } finally {
        this.identityButton.disabled = false;
        // 登出后回到"未登录"，地址保留 —— 用户很可能马上换个账户登进来
        this.refreshIdentity();
      }
      return;
    }
    this.callbacks.onLogin?.();
  }

  /**
   * 触发一次真实探测（供调试/截图使用）。
   * 注意：这**不是**伪造状态——它执行与点「测试连接」完全相同的网络请求。
   */
  async runProbe(): Promise<ProbeResult | null> {
    await this.test();
    return this.lastResult;
  }

  /** 最近一次探测结果（可能为 null） */
  getLastResult(): ProbeResult | null {
    return this.lastResult;
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.testButton.disabled = busy;
    this.identityButton.disabled = busy;
    this.saveButton.disabled = busy;
    this.chooseDirButton.disabled = busy;
    this.cardsDirInput.disabled = busy;
    this.testButton.textContent = busy ? '测试中…' : '测试连接';
  }

  private setProbeStatus(text: string, kind: 'ok' | 'warn' | 'bad' | 'info'): void {
    this.probeStatus.textContent = text;
    this.probeStatus.className = `probe-status ${kind}`;
  }

  // ── 一键连接本机服务端（F6.1）────────────────────────────

  /** 把分步说明渲染成列表；成功后隐藏 */
  private renderSteps(title: string, steps: string[], kind: 'ok' | 'warn' | 'bad'): void {
    this.localSteps.replaceChildren();
    this.localSteps.hidden = false;
    this.localSteps.className = `local-steps ${kind}`;

    const heading = el('p', 'local-steps-title', title);
    const list = el('ol', 'local-steps-list');
    for (const step of steps) {
      const item = el('li');
      // 只把 `**粗体**` 渲染成 <strong>，其余一律 textContent —— 不碰 innerHTML
      const segments = step.split(/(\*\*[^*]+\*\*)/g);
      for (const segment of segments) {
        if (segment.startsWith('**') && segment.endsWith('**')) {
          item.append(el('strong', '', segment.slice(2, -2)));
        } else if (segment !== '') {
          item.append(document.createTextNode(segment));
        }
      }
      list.append(item);
    }
    this.localSteps.append(heading, list);
  }

  private clearSteps(): void {
    this.localSteps.hidden = true;
    this.localSteps.replaceChildren();
  }

  /**
   * 「连接本机服务端」：探测 → 取令牌 → 写配置 → 两步校验。
   *
   * 编排逻辑全在 `connectLocalServer` 里（可单测），这里只负责：
   *   · 选恰当的 persist 实现（壳里走 C5，浏览器里明确告知不持久化）；
   *   · 把结果映射到输入框、状态行、分步说明；
   *   · 让「测试连接」和同步入口拿到同一份结论，避免两处状态不一致。
   */
  private async connectLocal(): Promise<void> {
    if (this.busy) return;
    this.setBusy(true);
    this.clearSteps();
    this.setProbeStatus('正在探测本机服务端…', 'info');

    try {
      // 用共享入口：persist 的壳/浏览器判断只有一处实现（见 connectLocalService）
      const result = await connectLocalService();

      if (!result.ok) {
        // 端到端断言用：把分类与分步数落进 dataset（不靠读文案判断）
        document.body.dataset['localConnect'] = `fail:${result.kind}`;
        document.body.dataset['localSteps'] = String(result.steps.length);
        this.setProbeStatus(result.message, 'bad');
        this.renderSteps('没能连上，按下面顺序排查：', result.steps, 'warn');
        // 失败时也让用户看到"到底探的是哪个地址"，省得反复猜
        this.lastResult = null;
        this.callbacks.onConnectionChange(null);
        this.updateSyncNote();
        return;
      }

      // 成功：回填输入框 + 复用测试连接的结论
      this.urlInput.value = result.serverUrl;
      this.tokenInput.value = result.token;
      this.lastResult = result.probe;
      this.callbacks.onConnectionChange(result.probe);

      document.body.dataset['localConnect'] = 'ok';
      document.body.dataset['localTokenLength'] = String(result.token.length);
      document.body.dataset['localAuthRequired'] = String(result.authRequired);
      document.body.dataset['localPersisted'] = String(result.persisted);
      document.body.dataset['localServerVersion'] = result.serverVersion ?? '';

      const describe = describeLocalSuccess(result);
      const suffix = result.persisted ? '' : '（浏览器模式：未持久化，刷新后失效）';
      this.setProbeStatus(`${describe}${suffix}`, 'ok');

      const steps = [
        `已自动填入服务端地址 ${result.serverUrl} 与访问令牌。`,
        result.authRequired
          ? '令牌已通过校验（服务端要求鉴权）。'
          : '服务端未启用鉴权，令牌填不填都能连。',
        result.persisted
          ? '配置已保存，可直接使用「上传 / 历史版本 / 回滚」。'
          : '浏览器模式不会持久化，请在桌面客户端里重新执行一次。',
      ];
      this.renderSteps('连接成功', steps, 'ok');
      this.callbacks.onSaved?.();
      this.updateSyncNote();
    } catch (error) {
      // 编排层自己会兜住预期失败；走到这里说明是意料之外的异常
      this.setProbeStatus(`连接失败：${errorText(error)}`, 'bad');
      this.renderSteps(
        '出现未预期的错误：',
        [
          '先确认服务在运行：打开“服务”(services.msc)，看 Tavern Card Studio Server 是否为“正在运行”。',
          '也可以直接在浏览器打开 http://127.0.0.1:8731/ 看管理面板能否显示。',
          `错误详情：${errorText(error)}`,
        ],
        'bad',
      );
    } finally {
      this.setBusy(false);
    }
  }

  /** 供端到端测试/截图入口调用：等价于用户点一次「连接本机服务端」 */
  async clickConnectLocal(): Promise<void> {
    await this.connectLocal();
  }

  private async test(): Promise<void> {
    if (this.busy) return;

    // 先在本地校验地址格式，省一次注定失败的请求
    const checked = normalizeServerUrl(this.urlInput.value);
    if (!checked.ok) {
      this.lastResult = null;
      this.setProbeStatus(checked.message, 'bad');
      this.callbacks.onConnectionChange(null);
      this.updateSyncNote();
      return;
    }

    this.setBusy(true);
    this.setProbeStatus('正在连接…', 'info');
    try {
      const result = await probeServer({
        serverUrl: this.urlInput.value,
        token: this.tokenInput.value,
      });
      this.lastResult = result;

      const ready = isSyncReady(result);
      const kind: 'ok' | 'warn' | 'bad' = ready ? 'ok' : result.reachable ? 'warn' : 'bad';
      const latency = result.latencyMs === null ? '' : `（${result.latencyMs} ms）`;
      this.setProbeStatus(`${result.message}${latency}`, kind);

      this.callbacks.onConnectionChange(result);
    } catch (error) {
      this.lastResult = null;
      this.setProbeStatus(`测试异常：${errorText(error)}`, 'bad');
      this.callbacks.onConnectionChange(null);
    } finally {
      this.setBusy(false);
      this.updateSyncNote();
    }
  }

  // ── 角色卡目录（T9.8 / F4）──────────────────────────────

  private setDirStatus(text: string, kind: 'ok' | 'warn' | 'bad' | 'info'): void {
    this.cardsDirStatus.textContent = text;
    this.cardsDirStatus.className = `probe-status ${kind}`;
    this.cardsDirStatus.hidden = text === '';
  }

  /**
   * 「选择…」：原生目录对话框 → 立刻探测。
   *
   * 探测失败（建不出来）就**不写进输入框** —— 让用户看到"这个路径不行"，
   * 而不是改完输入框再在保存时报错。这是"先验证再记录"的顺序。
   */
  /**
   * 「导出诊断日志」（T10.26）。
   *
   * 为什么这里只调回调、自己不做：导出要串三个契约能力（读日志、选路径、原子写），
   * app 侧已经有这些实现与错误文案。这里再写一遍，两份迟早不一致 ——
   * 而不一致的表现是"从设置里导出坏了，从别处导出好的"，最难查。
   *
   * 结果**同时**显示在面板内与状态栏（回调返回的一句话由调用方自己 setStatus）：
   * 用户点完按钮眼睛还在面板上，只写状态栏等于没反馈。
   */
  private async exportDiagnostics(): Promise<void> {
    if (this.busy) return;
    if (!this.callbacks.onExportDiagnostics) {
      this.setDiagnosticsStatus('导出诊断日志不可用（当前环境没有壳）', 'warn');
      return;
    }
    this.setBusy(true);
    this.setDiagnosticsStatus('正在收集…', 'info');
    try {
      const message = await this.callbacks.onExportDiagnostics();
      // 以"已导出/已取消/失败"判断色调：回调返回的是人话，这里只按关键字上色
      const tone = /失败|不可用/.test(message) ? 'bad' : /取消/.test(message) ? 'warn' : 'ok';
      this.setDiagnosticsStatus(message, tone);
    } catch (error) {
      this.setDiagnosticsStatus(`导出失败：${errorText(error)}`, 'bad');
    } finally {
      this.setBusy(false);
    }
  }

  private setDiagnosticsStatus(text: string, kind: 'ok' | 'warn' | 'bad' | 'info'): void {
    this.diagnosticsStatus.textContent = text;
    this.diagnosticsStatus.className = `probe-status ${kind}`;
    this.diagnosticsStatus.hidden = text === '';
  }

  /**
   * 刷新图库路径的显示（v0.1.4 / T12.5）。
   *
   * 路径是**派生**的（`<cardsDir>/card-faces`），所以跟着上面那一行输入框变；
   * 用户手改目录时这里要立刻跟上，否则会显示一个即将失效的路径。
   */
  private async refreshFaceDir(): Promise<void> {
    const typed = this.cardsDirInput.value.trim();
    if (typed !== '') {
      this.faceDirValue.value = faceLibraryDir(typed);
      this.openFaceDirButton.disabled = false;
      return;
    }
    try {
      const fallback = await effectiveCardsDir();
      this.faceDirValue.value = fallback === '' ? '（尚未确定卡片目录）' : faceLibraryDir(fallback);
      this.openFaceDirButton.disabled = fallback === '';
    } catch {
      this.faceDirValue.value = '（尚未确定卡片目录）';
      this.openFaceDirButton.disabled = true;
    }
  }

  /**
   * 打开图库目录（需求 F5）。
   *
   * 先 `probeCardsDir(create: true)` 再打开：需求要求"首次使用时自动创建"，
   * 而"打开一个不存在的目录"在资源管理器里会退到父目录，用户会以为图库坏了。
   */
  private async openFaceDir(): Promise<void> {
    const target = this.faceDirValue.value.trim();
    if (target === '' || target.startsWith('（')) {
      this.setDirStatus('还没有可用的卡片目录：先在上面设置一个', 'warn');
      return;
    }
    try {
      const probe = await probeCardsDir(target, { create: true });
      if (!probe.writable) {
        this.setDirStatus(`图库目录不可用：${probe.reason ?? '不可写'}`, 'bad');
        return;
      }
      await openFolder(probe.pathDisplay ?? target);
    } catch (error) {
      this.setDirStatus(`打开图库目录失败：${errorText(error)}`, 'bad');
    }
  }

  private async chooseCardsDir(): Promise<void> {
    if (this.busy) return;
    try {
      const picked = await pickDirectory(this.cardsDirInput.value || this.defaultDir || undefined);
      if (!picked) return;

      this.setBusy(true);
      const probe = await probeCardsDir(picked, { create: true });
      const decision = decideCardsDir(probe, 'pick');
      // 建不出来就不写进输入框：先验证再记录，别让用户改完再在保存时报错
      if (decision.state === 'blocked') {
        this.setDirStatus(decision.message, 'bad');
        return;
      }
      this.cardsDirInput.value = probe.pathDisplay ?? picked;
      this.setDirStatus(decision.message, decision.state === 'warn' ? 'warn' : 'ok');
    } catch (error) {
      this.setDirStatus(`选择目录失败：${errorText(error)}`, 'bad');
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * 保存前的目录校验。
   *
   * 返回 `'blocked'` 时**不要保存**（目录建不出来，存了也没用）；
   * 返回 `'warn'` 时**照常保存**，只提示不可写 ——
   * 不可写可能是临时的（权限正在申请、网络盘掉线），拦下来会让用户
   * 连"先把配置记下来"都做不到。
   */
  private async validateCardsDir(raw: string): Promise<{ state: 'ok' | 'warn' | 'blocked'; value: string }> {
    const value = resolveCardsDir(raw, this.defaultDir);
    if (value === '') {
      // 浏览器模式拿不到默认目录，也没法探测：不阻断（此时也不会真落盘）
      return { state: 'warn', value: '' };
    }
    const probe = await probeCardsDir(value, { create: true });
    const decision = decideCardsDir(probe, 'save');
    this.setDirStatus(decision.message, decision.state === 'blocked' ? 'bad' : decision.state);
    if (decision.state === 'blocked') return { state: 'blocked', value };
    if (decision.state === 'warn') return { state: 'warn', value };
    return { state: 'ok', value };
  }

  private async save(): Promise<void> {
    if (this.busy) return;

    const checked = normalizeServerUrl(this.urlInput.value);
    if (!checked.ok) {
      this.setProbeStatus(`无法保存：${checked.message}`, 'bad');
      return;
    }

    if (!isShellAvailable()) {
      this.setProbeStatus('浏览器模式：配置未持久化（请在桌面客户端内保存）', 'warn');
      return;
    }

    this.setBusy(true);
    try {
      // 目录校验放在写配置之前：建不出来就不该落盘（存了也用不了）
      const dirResult = await this.validateCardsDir(this.cardsDirInput.value);
      if (dirResult.state === 'blocked') {
        this.setBusy(false);
        return;
      }

      const saved = await configPatch({
        serverUrl: checked.url,
        token: this.tokenInput.value.trim(),
        // 解析后的绝对路径；浏览器模式拿不到默认目录时保持 null
        cardsDir: dirResult.value === '' ? null : dirResult.value,
      });
      // 回写归一化后的地址，让用户看到最终存储值
      this.urlInput.value = saved.serverUrl;
      this.cardsDirInput.value = resolveCardsDir(saved.cardsDir, this.defaultDir);
      this.setProbeStatus(
        dirResult.state === 'warn' ? '已保存（卡片目录不可写，见下方提示）' : '已保存到应用配置目录',
        dirResult.state === 'warn' ? 'warn' : 'ok',
      );
      this.callbacks.onSaved?.();
    } catch (error) {
      this.setProbeStatus(`保存失败：${errorText(error)}`, 'bad');
    } finally {
      this.setBusy(false);
      this.updateSyncNote();
    }
  }

  /**
   * 动态说明"同步可用性"。
   *
   * 判据从「探测是否通过」换成「有没有地址 + 有没有凭证」：
   * 上一版用 `isSyncReady(result).tokenValid === true`，于是**没填令牌时这里写「鉴权未通过」**，
   * 而那正是用户还没登录的时候 —— 把顺序说反了（不是"鉴权失败"，是"还没开始"）。
   */
  private updateSyncNote(): void {
    const hasAccount = (this.callbacks.getIdentity?.() ?? { phase: 'anonymous' as AuthPhase }).phase === 'authenticated';
    // legacy 兼容模式也算凭证：≤v0.1.1 的服务端只有它
    const hasCredentials = hasAccount || this.tokenInput.value.trim() !== '';
    const gate = resolveSyncGate(this.urlInput.value, hasCredentials);

    if (gate === 'ready') {
      this.syncNote.textContent = '同步已就绪：可使用上传 / 历史版本 / 回滚。';
      this.syncNote.className = 'sync-note ok';
      return;
    }
    if (gate === 'no-server') {
      this.syncNote.textContent = '还没配置服务端地址：填好地址后即可登录并同步。编辑、审计、导出不受影响。';
      this.syncNote.className = 'sync-note muted';
      return;
    }
    this.syncNote.textContent = `${syncGateMessage(gate)}编辑、审计、导出不受影响。`;
    this.syncNote.className = 'sync-note warn';
  }
}

function errorText(error: unknown): string {
  const maybe = error as { code?: string; message?: string };
  if (typeof maybe?.code === 'string') {
    return `[${maybe.code}] ${maybe.message ?? ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}
