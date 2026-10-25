/**
 * 登录 / 注册 / 仓库令牌 对话框（T10.7，v0.1.3 加第三入口）。
 *
 * 三条界面规则（对应需求的 1 与 4）：
 *   · 失败提示**只用服务端文案**（`authErrorMessage` 原样转发），
 *     不做"是不是密码错了"这类本地推断 —— 那会把服务端刻意抹平的枚举面重建起来；
 *   · `registerMode = closed` 时**根本不显示**注册入口（不是点了才报错）；
 *   · 登录成功后不关闭本地任何标签 —— 这个对话框没有那个能力，也刻意不给。
 *
 * 第三入口（v0.1.3 / F5 后半）：`使用仓库令牌连接`。
 * 它和"用户名/密码"不是一个东西 —— 一个是身份，一个是受限授权。
 * 所以它是**并列的第三种模式**而不是"登录的另一个字段"：把令牌塞进密码框
 * 会让人以为自己的密码是 tcr_ 开头的一串东西。
 */

import {
  type AuthPolicy,
  type AuthUser,
  AuthClientError,
} from './auth-client.ts';
import { authErrorMessage, isNetworkFailure, registerHint, shouldShowRegister } from './policy.ts';
import {
  checkRepoTokenShape,
  describeCapabilities,
  capabilitiesFor,
} from './repo-token.ts';
import { RepoTokenError, connectWithRepoToken, type RepoTokenGrant } from './repo-token-client.ts';
import type { AuthSession } from './session.ts';

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

export interface LoginDialogDeps {
  session: AuthSession;
  /** 打开时拉一次策略（免鉴权接口） */
  getPolicy: () => Promise<AuthPolicy | null>;
  /**
   * 当前服务端地址（空串 = 还没配置）。
   *
   * v0.1.2 追加任务：登录/注册只需要**地址**，不需要令牌；但地址都没有时
   * 提交必然失败（`session.login` 会抛"尚未配置服务端地址"）。
   * 那种情况在界面里先说清楚并禁用提交，比让用户填完两个框再看一句报错好。
   */
  getServerUrl?: () => string;
  notify: (message: string, kind?: 'ok' | 'warn' | 'bad' | 'info') => void;
  /** 登录成功（或注册后自动登录成功） */
  onAuthenticated?: (user: AuthUser | null) => void;
  /**
   * 仓库令牌连接成功（v0.1.3 / F5 后半）。
   *
   * 会话状态已经由本对话框写进 `AuthSession`，这个回调只负责让 App 重算
   * 顶栏 / 同步面板 / 按钮置灰 —— 与 `onAuthenticated` 同样的分工。
   */
  onRepoTokenConnected?: (grant: RepoTokenGrant) => void;
  /** 连接用的 HTTP 实现（只给测试注入） */
  connectRepoToken?: typeof connectWithRepoToken;
}

type Mode = 'login' | 'register' | 'repo-token';

export class LoginDialog {
  private readonly overlay: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly title: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly usernameInput: HTMLInputElement;
  private readonly passwordInput: HTMLInputElement;
  private readonly usernameField: HTMLElement;
  private readonly passwordField: HTMLElement;
  private readonly repoTokenField: HTMLElement;
  private readonly repoTokenInput: HTMLTextAreaElement;
  private readonly repoTokenNote: HTMLElement;
  private readonly errorBox: HTMLElement;
  private readonly submitButton: HTMLButtonElement;
  private readonly registerButton: HTMLButtonElement;
  private readonly repoTokenButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;

  private mode: Mode = 'login';
  private policy: AuthPolicy | null = null;
  private busy = false;
  /** 非 null = 当前状态下提交没有意义（例如还没配服务端地址） */
  private blockedReason: string | null = null;

  constructor(private readonly deps: LoginDialogDeps) {
    this.overlay = el('div', 'modal-overlay modal-overlay-top');
    this.overlay.hidden = true;
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.dataset['role'] = 'auth-dialog';

    this.panel = el('div', 'modal auth-modal');

    const head = el('div', 'modal-head');
    this.title = el('h2', 'modal-title', '登录');
    const closeBtn = el('button', 'icon-btn', '×');
    closeBtn.type = 'button';
    closeBtn.title = '关闭（不退出登录）';
    closeBtn.addEventListener('click', () => this.close());
    head.append(this.title, closeBtn);

    const body = el('div', 'modal-body');

    this.hint = el('p', 'field-hint auth-hint');
    this.hint.dataset['role'] = 'auth-hint';

    const userField = el('label', 'field');
    userField.append(el('span', 'field-label', '用户名'));
    this.usernameInput = el('input', 'input');
    this.usernameInput.type = 'text';
    this.usernameInput.autocomplete = 'username';
    this.usernameInput.spellcheck = false;
    this.usernameInput.dataset['role'] = 'auth-username';
    userField.append(this.usernameInput);
    this.usernameField = userField;

    const passField = el('label', 'field');
    passField.append(el('span', 'field-label', '密码'));
    this.passwordInput = el('input', 'input');
    this.passwordInput.type = 'password';
    this.passwordInput.autocomplete = 'current-password';
    this.passwordInput.dataset['role'] = 'auth-password';
    passField.append(this.passwordInput);
    this.passwordField = passField;

    /*
     * 仓库令牌输入（v0.1.3 / F5 后半）。
     *
     * 用 textarea 而不是 input：令牌 47 个字符，窄输入框里看不全，
     * 而"看不全就无法确认自己粘对了"是这类粘贴失败的第一大原因。
     * 明文显示（不遮挡）：它不是密码，是一个要交给别人使用的授权凭证 ——
     * 遮挡反而让人无法发现自己粘进了多余空格。
     */
    const tokenField = el('label', 'field');
    tokenField.append(el('span', 'field-label', '仓库令牌'));
    this.repoTokenInput = el('textarea', 'input auth-token-input');
    this.repoTokenInput.rows = 3;
    this.repoTokenInput.spellcheck = false;
    this.repoTokenInput.autocomplete = 'off';
    this.repoTokenInput.placeholder = 'tcr_…（在另一台设备的「仓库与令牌」里签发后复制过来）';
    this.repoTokenInput.dataset['role'] = 'auth-repo-token';
    tokenField.append(this.repoTokenInput);
    this.repoTokenNote = el('p', 'field-hint auth-token-note');
    this.repoTokenNote.dataset['role'] = 'auth-repo-token-note';
    tokenField.append(this.repoTokenNote);
    this.repoTokenField = tokenField;
    this.repoTokenField.hidden = true;

    // 错误区常驻（不用 alert）：服务端文案可能较长，也可能包含可执行的下一步，
    // 用户需要能反复读，而不是一关就没了。
    this.errorBox = el('p', 'auth-error');
    this.errorBox.hidden = true;
    this.errorBox.dataset['role'] = 'auth-error';
    this.errorBox.setAttribute('role', 'alert');

    body.append(this.hint, userField, passField, tokenField, this.errorBox);

    const foot = el('div', 'modal-foot');
    this.cancelButton = el('button', 'btn', '取消');
    this.cancelButton.type = 'button';
    this.cancelButton.addEventListener('click', () => this.close());

    this.registerButton = el('button', 'btn ghost', '注册新账户');
    this.registerButton.type = 'button';
    this.registerButton.dataset['role'] = 'auth-register';
    /*
     * **默认隐藏**（fail-closed）。
     *
     * 打开对话框时 `open()` 会先让遮罩可见、再去拉 `/api/auth/config`。
     * 若这里默认可见，closed 的服务端上会先闪一下「注册新账户」再消失 ——
     * 手快的人点得到，然后收到一句"未开放注册"。这与"closed 时界面根本不显示"
     * 是两回事，而 `shouldShowRegister(null)` 早就把"策略未知"判成"不显示"，
     * 默认值跟着它走才一致。
     */
    this.registerButton.hidden = true;
    this.registerButton.addEventListener('click', () => this.switchMode());

    /*
     * 第三入口：使用仓库令牌连接（v0.1.3 / F5 后半）。
     *
     * 与「注册新账户」**并列**，不是它的子项：两者是不同性质的动作
     * （注册 = 造一个新身份；令牌 = 用别人给的受限授权访问一个仓库）。
     * 默认可见、不依赖策略 —— 它跟 registerMode 无关，也不该被 closed 连坐。
     */
    this.repoTokenButton = el('button', 'btn ghost', '使用仓库令牌连接');
    this.repoTokenButton.type = 'button';
    this.repoTokenButton.dataset['role'] = 'auth-repo-token-entry';
    this.repoTokenButton.addEventListener('click', () => this.toggleRepoTokenMode());

    this.submitButton = el('button', 'btn primary', '登录');
    this.submitButton.type = 'button';
    this.submitButton.dataset['role'] = 'auth-submit';
    this.submitButton.addEventListener('click', () => void this.submit());

    foot.append(
      this.repoTokenButton,
      this.registerButton,
      el('span', 'foot-note', ''),
      this.cancelButton,
      this.submitButton,
    );

    this.panel.append(head, body, foot);

    this.overlay.append(this.panel);
    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.close();
    });
    // 回车提交：用户名/密码框里回车是最自然的动作。
    // 令牌框是 textarea（要能换行显示/粘贴），回车交给它自己 —— 不劫持。
    for (const input of [this.usernameInput, this.passwordInput]) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void this.submit();
        }
      });
    }
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.overlay.hidden) this.close();
    });

    document.body.append(this.overlay);
  }

  get isOpen(): boolean {
    return !this.overlay.hidden;
  }

  /**
   * 打开对话框。
   *
   * `reason` 用于"登录已过期"这类被动回到登录界面的场景：把原因写在错误区，
   * 而不是弹一个 toast 就消失 —— 用户回来时得知道为什么又要登录。
   */
  async open(reason?: string): Promise<void> {
    this.overlay.hidden = false;
    /*
     * 必须提到最上层。
     *
     * 登录框会在"令牌过期"时被**被动**打开，而那一刻用户很可能正开着另一个
     * 对话框（我的卡片 / 同步面板）。所有 `.modal-overlay` 都是 z-index 50，
     * 后插入 DOM 的在上面 —— 登录框若被压在下面，用户看到的是"对话框里的
     * 数据突然空了"，而登录框只在后面露出一角（端到端截图抓到过这一幕）。
     * 用类名抬一层而不是改全局 z-index：其余对话框的叠放关系不该受影响。
     */
    this.overlay.classList.add('modal-overlay-top');
    this.setMode('login');
    this.clearError();
    if (reason) this.showError(reason);
    this.usernameInput.value = this.deps.session.user?.username ?? '';
    this.passwordInput.value = '';
    // 令牌不留在框里：它是一次性粘贴的凭证，下次打开应当自己重贴，
    // 而不是让上次的原文留在界面上被别人看见
    this.repoTokenInput.value = '';
    this.repoTokenNote.textContent = '';

    // 地址是唯一的硬前提（令牌不是）。没有地址时把话说清楚并禁用提交 ——
    // 注意这里**不关掉对话框**：用户可能只是刚装完服务端，先看到这句话
    // 再去设置里填地址，回来还是这个框。
    const serverUrl = this.deps.getServerUrl?.() ?? '';
    this.blockedReason =
      serverUrl.trim() === ''
        ? '还没有配置服务端地址：先在「设置」里填写（同机可直接点「连接本机服务端」），再回来登录。'
        : null;
    this.submitButton.disabled = this.blockedReason !== null;

    const policy = await this.deps.getPolicy();
    this.policy = policy;
    this.hint.textContent =
      this.blockedReason ?? registerHint(policy?.registerMode ?? null);
    this.registerButton.hidden = !shouldShowRegister(policy, this.deps.session.user);

    // 焦点给"该填的那个"：已记住用户名时直接进密码框
    (this.usernameInput.value === '' ? this.usernameInput : this.passwordInput).focus();
  }

  /**
   * 直接以「仓库令牌」模式打开（v0.1.3 / F5 后半）。
   *
   * 给截图脚本用的公开入口：先按正常流程 `open()`（拉策略、算门槛），
   * 再切到令牌模式。刻意不另写一套打开逻辑 —— 那样截图里的界面
   * 与用户真点出来的就不是同一个状态了（截图验收的意义正在于此）。
   *
   * `prefill` 只在调试入口里用；正常用户路径不会带值进来。
   */
  async openRepoTokenMode(prefill?: string): Promise<void> {
    await this.open();
    this.setMode('repo-token');
    if (prefill !== undefined && prefill !== '') {
      this.repoTokenInput.value = prefill;
      /*
       * `defaultValue` 单独设一份。
       *
       * textarea 的 `.value` 是**运行时状态**，不参与 DOM 序列化 ——
       * 所以 `--dump-dom` 抓出来的快照里那个框是空的，断言与截图都看不出
       * "令牌已粘贴"。`defaultValue` 走的是 textContent，会进快照。
       * 只在这一条调试入口设置，正常用户路径不受影响。
       */
      this.repoTokenInput.defaultValue = prefill;
      this.repoTokenInput.focus();
    }
  }

  close(): void {
    this.overlay.hidden = true;
    this.passwordInput.value = '';
    this.setBusy(false);
  }

  private switchMode(): void {
    this.setMode(this.mode === 'login' ? 'register' : 'login');
    this.clearError();
  }

  /** 第三入口的开关：进入/离开仓库令牌模式 */
  private toggleRepoTokenMode(): void {
    this.setMode(this.mode === 'repo-token' ? 'login' : 'repo-token');
    this.clearError();
    if (this.mode === 'repo-token') this.repoTokenInput.focus();
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    const isRepoToken = mode === 'repo-token';
    this.title.textContent = mode === 'login' ? '登录' : mode === 'register' ? '注册新账户' : '使用仓库令牌连接';
    this.submitButton.textContent = mode === 'login' ? '登录' : mode === 'register' ? '创建账户' : '连接';
    this.passwordInput.autocomplete = mode === 'register' ? 'new-password' : 'current-password';

    // 三入口的按钮文案随模式变：当前模式的那个变成"返回登录"
    this.registerButton.textContent = mode === 'register' ? '返回登录' : '注册新账户';
    this.repoTokenButton.textContent = isRepoToken ? '返回账户登录' : '使用仓库令牌连接';
    this.repoTokenButton.dataset['active'] = isRepoToken ? '1' : '0';

    // 用户名/密码与令牌互斥显示：混在一起会让人以为"令牌也是一种密码"
    this.usernameField.hidden = isRepoToken;
    this.passwordField.hidden = isRepoToken;
    this.repoTokenField.hidden = !isRepoToken;

    this.registerButton.hidden = isRepoToken ? true : !shouldShowRegister(this.policy, this.deps.session.user);

    if (isRepoToken) {
      this.hint.textContent =
        '仓库令牌只能访问它绑定的那一个仓库，权限由签发人决定（读 / 写 / 回滚）。' +
        '账户密码不会被使用，也不会保存在这台设备上。';
      this.repoTokenNote.textContent = this.describeExistingMode();
    }
    this.overlay.dataset['mode'] = mode;
  }

  /**
   * 令牌模式下多一句说明：当前是否已有别的凭证。
   *
   * 必须提前说清「进入令牌模式会退出账户登录」—— 这是个会改变状态的副作用，
   * 让用户在点"连接"之前就知道，而不是连上之后发现账户被登出了。
   */
  private describeExistingMode(): string {
    const mode = this.deps.session.mode;
    if (mode === 'account') {
      return '⚠ 当前已有账户登录：连接令牌模式会退出该账户登录（两条凭证路径不能同时生效）。';
    }
    if (mode === 'repo-token') {
      return `当前已在令牌模式（${this.deps.session.repoTokenRepoName}）—— 粘贴新令牌会替换它。`;
    }
    return '连接成功后，仓库选择器会隐藏，上传/历史/回滚都按这把令牌绑定的仓库寻址。';
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.submitButton.disabled = busy || this.blockedReason !== null;
    this.registerButton.disabled = busy;
    this.repoTokenButton.disabled = busy;
    this.cancelButton.disabled = busy;
    this.repoTokenInput.disabled = busy;
  }

  private showError(message: string): void {
    this.errorBox.hidden = false;
    this.errorBox.classList.remove('ok');
    this.errorBox.textContent = message;
  }

  private clearError(): void {
    this.errorBox.hidden = true;
    this.errorBox.textContent = '';
    this.errorBox.classList.remove('ok');
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    if (this.blockedReason !== null) {
      this.showError(this.blockedReason);
      return;
    }
    if (this.mode === 'repo-token') {
      await this.submitRepoToken();
      return;
    }
    const username = this.usernameInput.value.trim();
    const password = this.passwordInput.value;
    if (username === '' || password === '') {
      // 这一条是本地校验，但它**不涉及账户是否存在**，不构成枚举面
      this.showError('请填写用户名和密码。');
      return;
    }

    this.setBusy(true);
    this.clearError();
    try {
      if (this.mode === 'login') {
        const bundle = await this.deps.session.login(username, password);
        this.deps.notify(`已登录：${bundle.user.username}`, 'ok');
        this.deps.onAuthenticated?.(bundle.user);
        this.close();
        return;
      }

      const outcome = await this.deps.session.register(username, password);
      if (outcome.tokens) {
        this.deps.notify(`已创建并登录：${outcome.user.username}`, 'ok');
        this.deps.onAuthenticated?.(outcome.user);
      } else {
        // admin-only：服务端刻意不返回令牌（拿到别人的会话是越权）
        this.deps.notify(`已创建账户「${outcome.user.username}」，请让对方自己登录`, 'ok');
        this.deps.onAuthenticated?.(null);
      }
      this.close();
    } catch (error) {
      this.showError(authErrorMessage(error));
      if (isNetworkFailure(error)) {
        // 网络问题值得额外指路；凭证问题**不能**加这类暗示（会被当成分支信息）
        this.hint.textContent = '连不上服务端：请确认服务端已启动、地址与端口正确（设置 → 服务端地址）。';
      }
      if (error instanceof AuthClientError && error.code === 'REGISTER_CLOSED') {
        // 策略可能刚被管理员改过：重新拉一次，把注册入口收起来
        this.policy = await this.deps.getPolicy();
        this.hint.textContent = registerHint(this.policy?.registerMode ?? null);
        this.registerButton.hidden = !shouldShowRegister(this.policy, this.deps.session.user);
      }
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * 仓库令牌连接（第三入口的提交）。
   *
   * 与账户登录分开写而不是塞进上面那个 try：两者的失败语义完全不同 ——
   * 账户登录失败只换一句文案，而令牌连接成功后要**切换凭证路径**
   * （清账户令牌、写入仓库绑定），这是一件有副作用的事，值得单独一段。
   */
  private async submitRepoToken(): Promise<void> {
    const serverUrl = this.deps.getServerUrl?.() ?? '';
    const raw = this.repoTokenInput.value;

    // 本地形态校验：明显残缺的输入不发请求。
    // 注意它**只判形态**，不判有效性与存在性 —— 后者必须问服务端。
    const shape = checkRepoTokenShape(raw);
    if (!shape.ok) {
      this.showError(shape.message);
      return;
    }

    this.setBusy(true);
    this.clearError();
    try {
      const connect = this.deps.connectRepoToken ?? connectWithRepoToken;
      const grant = await connect(serverUrl, shape.value);
      await this.deps.session.enterRepoTokenMode(grant, shape.value);

      const caps = capabilitiesFor(grant.scopes);
      this.deps.notify(
        `已连接仓库「${grant.repoName === '' ? '(未命名)' : grant.repoName}」· ${describeCapabilities(caps)}`,
        'ok',
      );
      this.deps.onRepoTokenConnected?.(grant);
      this.repoTokenInput.value = '';
      this.close();
    } catch (error) {
      if (error instanceof RepoTokenError) {
        // 文案一律用服务端原话（或本地形态校验给出的那一句），
        // 这里**不**再做任何"可能是…"的推断 —— 那会重建服务端抹掉的枚举面。
        // 用单行拼接而不是换行：错误区是 <p>，\n 不会渲染（曾经这么写过，看起来像被截断）。
        this.showError(error.hint === '' ? error.displayMessage : `${error.displayMessage} —— ${error.hint}`);
        if (error.reason === 'network' || error.reason === 'timeout') {
          this.hint.textContent = '连不上服务端：请确认服务端已启动、地址与端口正确（设置 → 服务端地址）。';
        }
      } else {
        this.showError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      this.setBusy(false);
    }
  }
}
